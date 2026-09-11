// 本地/CI 成型脚本：把抓取到的原始 JSON 雕成小程序/数据库需要的格式并写出。
// 用法：
//   node scripts/fetch_futgg.js [页数] [--ver 27]            # 联网直接抓（需过 Cloudflare，一般不使用）
//   node scripts/fetch_futgg.js --from-dump fc27_dump.json --ver 27   # 离线成型（CI 主路径）
//
// 支持两种模式（由 dump 的 mode 字段决定，dump 由 scripts/fetch_ci.js 产出）：
//   full        —— 成型全量并写出 players.json / details.json（每周兜底 & 首次基线）
//   incremental —— 只成型「新增 / 变化」的卡，写出 incremental.json 供落库脚本增量写入
//
// 输出（cloud-data/fc{N}/）：
//   snapshot.json    eaId → 内容签名（下次增量对比的基线，每日提交 git）
//   changes.json     本次变更摘要（每日提交 git）
//   facets.json      筛选取值（每日从完整列表重算，每日提交 git）
//   players.json / details.json   全量数据，仅 full 模式产出（体积大，不提交 git）
//   incremental.json             增量落库包，仅 incremental 模式产出（不提交 git）
const https = require('https');
const fs = require('fs');
const path = require('path');
const { sigOfRaw } = require('./sig');

const ROOT = path.resolve(__dirname, '..');

// ---- 参数解析 ----
const argv = process.argv.slice(2);
let LIST_PAGES = 1;
let VER = '26';
let DUMP_FILE = '';
let NO_LOCAL = process.env.FC_NO_LOCAL === '1';
for (let i = 0; i < argv.length; i++) {
  if ((argv[i] === '--ver' || argv[i] === '-v') && argv[i + 1]) { VER = String(argv[++i]).replace(/[^0-9]/g, '') || '26'; }
  else if (argv[i] === '--from-dump' && argv[i + 1]) { DUMP_FILE = argv[++i]; }
  else if (argv[i] === '--no-local') { NO_LOCAL = true; }
  else if (/^\d+$/.test(argv[i])) { LIST_PAGES = Number(argv[i]); }
}
const DELAY_MS = 600; // 礼貌延迟，避免被限流

const UA = process.env.CF_UA || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36';
const HEADERS = {
  'User-Agent': UA,
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  'Referer': 'https://www.fut.gg/',
  'Origin': 'https://www.fut.gg'
};

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function getJson(url) {
  return new Promise(function (resolve, reject) {
    const req = https.get(url, { headers: HEADERS }, function (res) {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', function () {
        if (res.statusCode >= 300) return reject(new Error('HTTP ' + res.statusCode + ' for ' + url));
        try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('JSON parse fail: ' + e.message + ' | ' + data.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.setTimeout(20000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function pickPlayer(item) {
  // 六维的形态差异（FC26 对象 / FC27 扁平对象 / FC27 对象数组）统一在 sig.js 里归一化，
  // 保证「列表文档里的六维」与「签名里参与比对的六维」永远取自同一处，不会再分叉。
  const f = normFaceStats(item);
  return {
    id: item.id,
    eaId: item.eaId,
    commonName: item.commonName,
    overall: item.overall,
    position: item.position,
    dateOfBirth: item.dateOfBirth || '',
    height: item.height,
    weight: item.weight,
    foot: item.foot,
    skillMoves: item.skillMoves,
    weakFoot: item.weakFoot,
    bodytypeCode: item.bodytypeCode,
    isRealFace: item.isRealFace,
    shirtNumber: item.shirtNumber,
    accelerateType: item.accelerateType,
    club: item.club || null,
    league: item.league || null,
    nation: item.nation || null,
    rarity: normRarity(item),
    imagePath: item.imagePath || '',
    cardImagePath: item.cardImagePath || '',
    simpleCardImagePath: item.simpleCardImagePath || '',
    socialImagePath: item.socialImagePath || '',
    createdAt: item.createdAt || '',
    playstyles: item.playStyleEaIds || [],
    playstylesPlus: item.playStylePlusEaIds || [],
    rolesPlus: item.chemistryRolesPlusEaIds || [],
    rolesPlusPlus: item.chemistryRolesPlusPlusEaIds || [],
    alternativePositionIds: item.alternativePositionIds || [],
    facePace: f.pace || 0,
    faceShooting: f.shooting || 0,
    facePassing: f.passing || 0,
    faceDribbling: f.dribbling || 0,
    faceDefending: f.defending || 0,
    facePhysicality: f.physicality || 0
  };
}

// 由列表项 + 详情原始响应（detRaw，形如 {data:{...}}）合成最终详情对象。
function buildDetail(p, detRaw) {
  const det = (detRaw && detRaw.data) ? detRaw.data : (detRaw || {});
  const d = det;
  const f = d.faceStats || {};
  const facePace = (d.facePace != null) ? d.facePace : f.pace;
  const faceShooting = (d.faceShooting != null) ? d.faceShooting : f.shooting;
  const facePassing = (d.facePassing != null) ? d.facePassing : f.passing;
  const faceDribbling = (d.faceDribbling != null) ? d.faceDribbling : f.dribbling;
  const faceDefending = (d.faceDefending != null) ? d.faceDefending : f.defending;
  const facePhysicality = (d.facePhysicality != null) ? d.facePhysicality : f.physicality;
  let attributes = d.attributes;
  if (!attributes) {
    attributes = {};
    Object.keys(d).forEach(function (k) { if (k.indexOf('attribute') === 0 && typeof d[k] === 'number') attributes[k] = d[k]; });
  }
  const position = (typeof d.position === 'string' && d.position) ? d.position : p.position;
  return {
    ...p,
    position: position,
    weight: d.weight != null ? d.weight : p.weight,
    bodytypeCode: d.bodytypeCode != null ? d.bodytypeCode : p.bodytypeCode,
    isRealFace: d.isRealFace != null ? d.isRealFace : p.isRealFace,
    dateOfBirth: d.dateOfBirth || p.dateOfBirth,
    attributes: attributes,
    playstyles: d.playStyleEaIds || d.playstyles || p.playstyles,
    playstylesPlus: d.playStylePlusEaIds || d.playstylesPlus || p.playstylesPlus,
    rolesPlus: d.chemistryRolesPlusEaIds || d.rolesPlus || p.rolesPlus,
    rolesPlusPlus: d.chemistryRolesPlusPlusEaIds || d.rolesPlusPlus || p.rolesPlusPlus,
    alternativePositionIds: d.alternativePositionIds || p.alternativePositionIds,
    facePace: facePace != null ? facePace : p.facePace,
    faceShooting: faceShooting != null ? faceShooting : p.faceShooting,
    facePassing: facePassing != null ? facePassing : p.facePassing,
    faceDribbling: faceDribbling != null ? faceDribbling : p.faceDribbling,
    faceDefending: faceDefending != null ? faceDefending : p.faceDefending,
    facePhysicality: facePhysicality != null ? facePhysicality : p.facePhysicality
  };
}

// 一次运行的产物容器
let DUMP_MODE = 'full';        // full | incremental
let REMOVED_IDS = [];          // 本次从接口消失的 eaId
let NEW_IDS = [];              // 新增的 eaId
let CHANGED_IDS = [];          // 内容发生变化的 eaId
let DUMP_META = {};
let DETAIL_FAILED = 0;

async function main() {
  const rawItems = [];      // 去重后的原始列表项（用于算签名 / 快照）
  const listPlayers = [];   // 全量列表成型结果（用于 facets / players.json）
  const players = [];       // 需要写库的球员（full=全部；incremental=仅新增+变化）
  const details = {};       // 需要写库的详情
  const listIdSet = new Set();
  const eaIdSet = new Set();

  if (DUMP_FILE) {
    console.log(`离线模式：从 ${DUMP_FILE} 读取 FC${VER} 数据`);
    const dump = JSON.parse(fs.readFileSync(DUMP_FILE, 'utf8'));
    DUMP_MODE = dump.mode === 'full' ? 'full' : 'incremental';
    REMOVED_IDS = Array.isArray(dump.removedIds) ? dump.removedIds : [];
    NEW_IDS = Array.isArray(dump.newIds) ? dump.newIds : [];
    CHANGED_IDS = Array.isArray(dump.changedIds) ? dump.changedIds : [];
    DUMP_META = dump.meta || {};
    DETAIL_FAILED = dump.detailFailed || 0;
    if (dump.count != null) DUMP_META.count = dump.count;

    const rawList = Array.isArray(dump.list) ? dump.list
                  : (Array.isArray(dump.players) ? dump.players : []);
    rawList.forEach(item => {
      if (item && item.eaId != null && !listIdSet.has(item.eaId)) {
        listIdSet.add(item.eaId);
        rawItems.push(item);
        listPlayers.push(pickPlayer(item));
      }
    });
    console.log('列表去重后球员数:', listPlayers.length, '| 模式:', DUMP_MODE);
    if (dump.totalPages) console.log('接口总页数:', dump.totalPages);

    // 增量模式只成型「新增 + 变化」，其余保持数据库中已有的内容
    let needSet = null;
    if (DUMP_MODE !== 'full') {
      needSet = new Set(NEW_IDS.concat(CHANGED_IDS));
      console.log('本次需要成型：新增', NEW_IDS.length, '| 变化', CHANGED_IDS.length, '| 下架', REMOVED_IDS.length);
    }
    for (let i = 0; i < listPlayers.length; i++) {
      const p = listPlayers[i];
      if (needSet && !needSet.has(p.eaId)) continue;
      if (eaIdSet.has(p.eaId)) continue;
      eaIdSet.add(p.eaId);
      players.push(p);
      details[p.eaId] = buildDetail(p, (dump.details && dump.details[p.eaId]) || {});
      if (players.length % 500 === 0) console.log('  成型', players.length, '/', needSet ? needSet.size : listPlayers.length);
    }
    if (needSet) {
      let missing = 0;
      needSet.forEach(function (id) { if (!eaIdSet.has(id)) missing++; });
      if (missing) console.warn('  ⚠️', missing, '个目标 eaId 未出现在列表中，已跳过');
    }
    console.log('本次成型球员数:', players.length);
  } else {
    console.log(`开始抓取 fut.gg FC${VER}，列表页数:`, LIST_PAGES);
    for (let page = 1; page <= LIST_PAGES; page++) {
      const url = `https://www.fut.gg/api/fut/players/v2/${VER}/?page=${page}`;
      console.log('  列表 page', page);
      const list = await getJson(url);
      if (!list.data || !Array.isArray(list.data)) throw new Error('列表结构异常');
      if (list.data.length === 0) { console.log('  第', page, '页为空，列表已到末页，停止翻页'); break; }
      list.data.forEach(item => {
        if (item && item.eaId != null && !listIdSet.has(item.eaId)) {
          listIdSet.add(item.eaId);
          rawItems.push(item);
          listPlayers.push(pickPlayer(item));
        }
      });
      if (page < LIST_PAGES) await sleep(DELAY_MS);
    }
    console.log('列表去重后球员数:', listPlayers.length);
    // 联网分支等价于 full 模式：全部写库
    listPlayers.forEach(function (p) { if (!eaIdSet.has(p.eaId)) { eaIdSet.add(p.eaId); players.push(p); } });
    for (let i = 0; i < players.length; i++) {
      const p = players[i];
      const url = `https://www.fut.gg/api/fut/player-item-definitions/${VER}/${p.eaId}/`;
      console.log(`  详情 ${i + 1}/${players.length}: ${p.commonName} (${p.eaId})`);
      try {
        const det = await getJson(url);
        details[p.eaId] = buildDetail(p, det);
      } catch (e) {
        console.warn('    详情失败，使用列表数据兜底:', e.message);
        details[p.eaId] = p;
      }
      if (i < players.length - 1) await sleep(DELAY_MS);
    }
  }

  const cloudDir = path.join(ROOT, 'cloud-data', `fc${VER}`);
  fs.mkdirSync(cloudDir, { recursive: true });

  // ---- 筛选面板取值范围：每天从「完整列表」重算，与增量无关 ----
  function uniqSorted(arr) {
    const s = new Set();
    arr.forEach(function (x) { if (x) s.add(x); });
    return Array.from(s).sort();
  }
  const facets = {
    version: VER,
    total: listPlayers.length,
    positions: uniqSorted(listPlayers.map(function (p) { return p.position; })),
    leagues: uniqSorted(listPlayers.map(function (p) { return p.league && p.league.name; })),
    clubs: uniqSorted(listPlayers.map(function (p) { return p.club && p.club.name; })),
    nations: uniqSorted(listPlayers.map(function (p) { return p.nation && p.nation.name; })),
    rarities: uniqSorted(listPlayers.map(function (p) { return p.rarity && p.rarity.name; })),
    accs: uniqSorted(listPlayers.map(function (p) { return p.accelerateType; })),
    updatedAt: new Date().toISOString()
  };
  fs.writeFileSync(path.join(cloudDir, 'facets.json'), JSON.stringify(facets, null, 2));
  console.log('  筛选取值: 联赛', facets.leagues.length, '| 俱乐部', facets.clubs.length, '| 稀有度', facets.rarities.length, '| 位置', facets.positions.length);

  // ---- 快照：eaId → 内容签名。这是下次增量对比的基线，必须与 fetch_ci.js 用同一算法 ----
  const sigs = {};
  rawItems.forEach(function (it) { sigs[it.eaId] = sigOfRaw(it); });
  const snapshot = {
    version: VER,
    updatedAt: new Date().toISOString(),
    mode: DUMP_MODE,
    count: Object.keys(sigs).length,
    sigs: sigs
  };
  fs.writeFileSync(path.join(cloudDir, 'snapshot.json'), JSON.stringify(snapshot));
  console.log('  快照写入', snapshot.count, '条签名');

  // ---- 变更摘要（体积很小，每天提交 git 作为版本历史）----
  const changes = {
    date: new Date().toISOString(),
    ver: Number(VER),
    mode: DUMP_MODE,
    listTotal: listPlayers.length,
    upserted: players.length,
    added: DUMP_MODE === 'full' ? listPlayers.length : NEW_IDS.length,
    changed: DUMP_MODE === 'full' ? 0 : CHANGED_IDS.length,
    removed: REMOVED_IDS.length,
    detailFailed: DETAIL_FAILED,
    apiCount: DUMP_META.count != null ? DUMP_META.count : null
  };
  fs.writeFileSync(path.join(cloudDir, 'changes.json'), JSON.stringify(changes, null, 2));

  if (DUMP_MODE === 'full') {
    // 全量数据文件（体积大，已加入 .gitignore，不提交 git；供落库脚本使用）
    fs.writeFileSync(path.join(cloudDir, 'players.json'), JSON.stringify(listPlayers, null, 2));
    fs.writeFileSync(path.join(cloudDir, 'details.json'), JSON.stringify(details, null, 2));
  } else {
    // 增量落库包：只含需要写入数据库的部分
    const inc = {
      mode: 'incremental',
      ver: Number(VER),
      total: listPlayers.length,
      players: players,
      details: details,
      removedIds: REMOVED_IDS,
      facets: facets
    };
    fs.writeFileSync(path.join(cloudDir, 'incremental.json'), JSON.stringify(inc));
  }

  // ---- 小程序本地兜底文件：仅 full 模式产出，且 CI 里用 --no-local 跳过 ----
  if (DUMP_MODE === 'full' && !NO_LOCAL) {
    fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true });
    fs.writeFileSync(path.join(ROOT, 'data', `players_fc${VER}.js`), 'module.exports = ' + JSON.stringify(listPlayers, null, 2) + ';\n');
    fs.writeFileSync(path.join(ROOT, 'data', `details_fc${VER}.js`), 'module.exports = ' + JSON.stringify(details, null, 2) + ';\n');
  }

  console.log('完成。FC' + VER, '| 模式:', DUMP_MODE);
  console.log('  列表总数:', listPlayers.length, '| 本次写库:', players.length, '| 下架:', REMOVED_IDS.length);
  console.log(`  cloud-data/fc${VER}/snapshot.json   （增量基线，提交 git）`);
  console.log(`  cloud-data/fc${VER}/changes.json    （变更摘要，提交 git）`);
  console.log(`  cloud-data/fc${VER}/facets.json     （筛选取值，提交 git）`);
}

main().catch(e => { console.error('抓取失败:', e); process.exit(1); });
