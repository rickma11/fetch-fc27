// 本地/CI 成型脚本：把抓取到的原始 JSON 雕成小程序需要的格式并写出。
// 用法：
//   node scripts/fetch_futgg.js [页数] [--ver 27]            # 联网直接抓（需过 Cloudflare，一般不使用）
//   node scripts/fetch_futgg.js --from-dump fc27_dump.json --ver 27   # 离线成型（CI 主路径）
// 输出：
//   cloud-data/fc{N}/players.json          （上传云存储 fc{N}/players.json）
//   cloud-data/fc{N}/details.json          （上传云存储 fc{N}/details.json）
//   data/players_fc{N}.js  data/details_fc{N}.js  （本地兜底 / git 版本历史）
const https = require('https');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// ---- 参数解析 ----
const argv = process.argv.slice(2);
let LIST_PAGES = 1;
let VER = '26';
let DUMP_FILE = '';
for (let i = 0; i < argv.length; i++) {
  if ((argv[i] === '--ver' || argv[i] === '-v') && argv[i + 1]) { VER = String(argv[++i]).replace(/[^0-9]/g, '') || '26'; }
  else if (argv[i] === '--from-dump' && argv[i + 1]) { DUMP_FILE = argv[++i]; }
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
  const f = item.faceStats || {};
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
    rarity: item.rarity || null,
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

async function main() {
  const players = [];
  const eaIdSet = new Set();
  const details = {};

  if (DUMP_FILE) {
    console.log(`离线模式：从 ${DUMP_FILE} 读取 FC${VER} 数据`);
    const dump = JSON.parse(fs.readFileSync(DUMP_FILE, 'utf8'));
    (dump.players || []).forEach(item => {
      if (!eaIdSet.has(item.eaId)) { eaIdSet.add(item.eaId); players.push(pickPlayer(item)); }
    });
    console.log('列表去重后球员数:', players.length);
    for (let i = 0; i < players.length; i++) {
      const p = players[i];
      const raw = (dump.details && dump.details[p.eaId]) || {};
      details[p.eaId] = buildDetail(p, raw);
      if (i % 50 === 0) console.log(`  成型详情 ${i + 1}/${players.length}`);
    }
  } else {
    console.log(`开始抓取 fut.gg FC${VER}，列表页数:`, LIST_PAGES);
    for (let page = 1; page <= LIST_PAGES; page++) {
      const url = `https://www.fut.gg/api/fut/players/v2/${VER}/?page=${page}`;
      console.log('  列表 page', page);
      const list = await getJson(url);
      if (!list.data || !Array.isArray(list.data)) throw new Error('列表结构异常');
      if (list.data.length === 0) { console.log('  第', page, '页为空，列表已到末页，停止翻页'); break; }
      list.data.forEach(item => {
        if (!eaIdSet.has(item.eaId)) { eaIdSet.add(item.eaId); players.push(pickPlayer(item)); }
      });
      if (page < LIST_PAGES) await sleep(DELAY_MS);
    }
    console.log('列表去重后球员数:', players.length);
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

  const playersJs = 'module.exports = ' + JSON.stringify(players, null, 2) + ';\n';
  const detailsJs = 'module.exports = ' + JSON.stringify(details, null, 2) + ';\n';
  fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'data', `players_fc${VER}.js`), playersJs);
  fs.writeFileSync(path.join(ROOT, 'data', `details_fc${VER}.js`), detailsJs);

  const cloudDir = path.join(ROOT, 'cloud-data', `fc${VER}`);
  fs.mkdirSync(cloudDir, { recursive: true });
  fs.writeFileSync(path.join(cloudDir, 'players.json'), JSON.stringify(players, null, 2));
  fs.writeFileSync(path.join(cloudDir, 'details.json'), JSON.stringify(details, null, 2));

  console.log('完成。FC' + VER);
  console.log(`  data/players_fc${VER}.js  （版本化本地兜底 / git 版本历史）`);
  console.log(`  data/details_fc${VER}.js  （版本化本地兜底 / git 版本历史）`);
  console.log(`  cloud-data/fc${VER}/players.json  （上传云存储 fc${VER}/）`);
  console.log(`  cloud-data/fc${VER}/details.json  （上传云存储 fc${VER}/）`);
  console.log('共写入', players.length, '名球员');
}

main().catch(e => { console.error('抓取失败:', e); process.exit(1); });
