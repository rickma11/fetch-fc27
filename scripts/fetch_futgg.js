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
const { sigOfRaw, normFaceStats, normalizeRarity } = require('./sig');
const imgLib = require('./images'); // rarityImgs 块需要 rarityFileKeyOf（commit de68f5a 漏引，run#43 崩溃根因）

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

// 卡片来源（fut.gg item 上的标记字段）归一成单值，供小程序「卡片来源」筛选使用。
// 优先级 SBC > 赛季通行证(Season Pass) > 任务奖励(Objective) > 卡池 —— 三者几乎互斥，
// 万一将来出现同时命中的卡，取最"专属"的那个。isSpecial（活动特殊卡）与来源正交，不参与归一。
// ⚠️ 2026-09-18：SEASON_PASS 提到 OBJECTIVE 之前。fut.gg 目前把 OTW 这类通行证卡标成
//    isObjective=true、且列表接口**根本不回传 isSeasonPass**（实测全库 isSeasonPass 恒为 null），
//    真正的通行证归属只能从**详情**接口的 premiumSeasonPassLevel / standardSeasonPassLevel 判定
//    —— 见 buildDetail 的 seasonPass* 字段与 main() 里的回写。这里提前只是为了让将来列表若
//    补上 isSeasonPass 时不再被 OBJECTIVE 抢先命中，本身不改变当前行为（列表值恒 null）。
function cardSourceOf(item) {
  if (item.isSbc === true) return 'SBC';
  if (item.isSeasonPass === true) return 'SEASON_PASS';
  if (item.isObjective === true) return 'OBJECTIVE';
  return 'POOL';
}

// 半身像路径归一：fut.gg 对「真实照片尚未就绪」的球员会返回**占位图**路径
// （实测 `27/players/prelaunch-photos-v2/{eaId}.webp`）—— 它非空，但根本不是真实半身像。
// 若当成真图写库会连坏两处：
//   ① 端上 displayImg() 判定「有半身像」→ 显示 _card.webp，而那是 fut.gg 原始卡面，
//      照片区是它自己烘焙的通用人像/破图残留 —— 看上去就是「未处理的头像」；
//   ② gen_noportrait_cards 的 Phase 0 对账会误判该球员「已获半身像」→ 写库并
//      **删掉**我们辛苦生成的通用剪影卡 _np.webp，处理好的卡面被破坏。
// 故在采集层就把占位图归一成空串，与「真正无半身像」同口径。
// ⚠️ sig.js 的签名不含 imagePath，此改动不会触发全量重抓（增量安全）。
const PLACEHOLDER_IMG_RE = /prelaunch-photos|placeholder|\/no-player\//i;
function realImagePath(v) {
  return (typeof v === 'string' && v && !PLACEHOLDER_IMG_RE.test(v)) ? v : '';
}

// 数组字段「详情 + 列表」合并：取**第一个非空数组**。
// ⚠️ 旧写法 `d.playstyles || p.playstyles` 有致命隐患：JS 里 `[]` 是真值 —— 一旦「详情返回空数组、
//    列表却有值」，列表那侧的花式/角色会被详情空数组短路丢光（实测 2026-09-19 全库 0 例，
//    列表↔详情同空或同有值，但写法脆弱；规则 15「字段空洞体检」就是为这类问题准备的）。
//    全为空数组时保留最靠前那个（详情优先），维持原有语义、不改变当前落库结果。
function pickArr() {
  for (let i = 0; i < arguments.length; i++) {
    if (Array.isArray(arguments[i]) && arguments[i].length) return arguments[i];
  }
  for (let i = 0; i < arguments.length; i++) {
    if (Array.isArray(arguments[i])) return arguments[i];
  }
  return [];
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
    // 男女足：fut.gg 的 **列表**接口就带 gender（数值 1=男足 / 2=女足），无需抓详情。
    //   端上详情页信息行「性别」+ 对比页「性别」格都用它（见 utils/format.js#genderText）。
    gender: (item.gender != null) ? item.gender : null,
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
    // 稀有度：fut.gg 把普通卡的 rarityName 一律写成 "Rare"，真实档位在顶层 quality
    // （GOLD/SILVER/BRONZE）。normalizeRarity 只把「占位名」换成 金/银/铜，
    // 特殊活动卡（Hall of FUT 及后续所有活动）原样保留 —— 见 sig.js 顶部说明。
    // ⚠️ 它返回副本、不改 raw item，所以签名（sigSource 读原始 rarityName）不受影响，
    //    不会因为这次改动触发全量重抓详情。
    rarity: normalizeRarity(item),
    imagePath: item.imagePath || '',
    cardImagePath: item.cardImagePath || '',
    simpleCardImagePath: item.simpleCardImagePath || '',
    socialImagePath: item.socialImagePath || '',
    createdAt: item.createdAt || '',
    playstyles: item.playStyleEaIds || [],
    playstylesPlus: item.playStylePlusEaIds || [],
    // ⚠️ 角色字段：列表接口字段名就是 rolesPlus / rolesPlusPlus（实测 Ronaldo=[42]/[141]）。
    //    早期误写成 chemistryRolesPlusEaIds（那是**详情**接口的字段名），导致列表侧恒为空数组。
    //    这里两个名字都兜底，防止 fut.gg 再改名。
    rolesPlus: item.rolesPlus || item.chemistryRolesPlusEaIds || [],
    rolesPlusPlus: item.rolesPlusPlus || item.chemistryRolesPlusPlusEaIds || [],
    alternativePositionIds: item.alternativePositionIds || [],
    // 卡片来源：fut.gg item 上的 isSbc / isObjective / isSeasonPass 标记 → 单值 cardSource。
    // ⚠️ 用 typeof 判定：字段在接口上缺失时记 null，以区分「确定不是 SBC」与「接口没给这个字段」——
    //    fetch_ci.js 抓完会打印各字段的存在率，CI 日志里能直接看出接口是否真的提供了这些标记
    //    （若全为 0，说明列表接口不返回来源，需改用 ?is_sbc=1 等筛选参数分桶抓取来补）。
    isSbc: (typeof item.isSbc === 'boolean') ? item.isSbc : null,
    isObjective: (typeof item.isObjective === 'boolean') ? item.isObjective : null,
    isSeasonPass: (typeof item.isSeasonPass === 'boolean') ? item.isSeasonPass : null,
    isSpecial: (typeof item.isSpecial === 'boolean') ? item.isSpecial : null,
    cardSource: cardSourceOf(item),
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
  // ── 赛季通行证等级（只有详情接口有，列表接口完全不带）────────────────────────────
  // fut.gg 用两个字段区分两档通行证，页面上表现为卡面挂的 SP 徽标：
  //   premiumSeasonPassLevel  → 「Premium Season Pass: Level N」，金色 SP 徽标
  //   standardSeasonPassLevel → 「Season Pass: Level N」，普通（紫）SP 徽标
  // 实测（2026-09-18）：OTW 通行证卡两者必有其一（Anderson premium=3 / Tielemans standard=26），
  //   而同批被 fut.gg 同样标成 isObjective 的 Squad Foundations 真·任务卡两者**皆为 null**
  //   —— 这就是「赛季通行证 vs 任务奖励」唯一可靠的判别信号。
  const spPremium = (typeof d.premiumSeasonPassLevel === 'number') ? d.premiumSeasonPassLevel : null;
  const spStandard = (typeof d.standardSeasonPassLevel === 'number') ? d.standardSeasonPassLevel : null;
  const spLevel = (spPremium != null) ? spPremium : spStandard;
  const spTier = (spPremium != null) ? 'premium' : (spStandard != null ? 'standard' : null);
  return {
    ...p,
    position: position,
    // 男女足：列表已带（pickPlayer）；详情若也返回则以详情为准（两处实测一致）
    gender: d.gender != null ? d.gender : p.gender,
    weight: d.weight != null ? d.weight : p.weight,
    bodytypeCode: d.bodytypeCode != null ? d.bodytypeCode : p.bodytypeCode,
    isRealFace: d.isRealFace != null ? d.isRealFace : p.isRealFace,
    dateOfBirth: d.dateOfBirth || p.dateOfBirth,
    attributes: attributes,
    // ⚠️ 下面 5 个数组字段一律走 pickArr（空数组不算「有值」）—— 见 pickArr 注释
    playstyles: pickArr(d.playStyleEaIds, d.playstyles, p.playstyles),
    playstylesPlus: pickArr(d.playStylePlusEaIds, d.playstylesPlus, p.playstylesPlus),
    rolesPlus: pickArr(d.rolesPlus, d.chemistryRolesPlusEaIds, p.rolesPlus),
    rolesPlusPlus: pickArr(d.rolesPlusPlus, d.chemistryRolesPlusPlusEaIds, p.rolesPlusPlus),
    alternativePositionIds: pickArr(d.alternativePositionIds, p.alternativePositionIds),
    // SBC 积分（fut.gg 页面那个绿钻数值）＝详情接口的 gradingScore。
    //   实测 Mbappé(231747) gradingScore=19000，与页面「SBC 19,000」完全吻合。
    // ⚠️ 早期误把 gradingScore 当成 GG 评分排除掉了 —— GG 评分是 ggRating / ggr（不采集），
    //    gradingScore 是 SBC 积分，两者同名不同义，别再搞混。
    // ⚠️ price / currentDbPrice / coinCost / pointCost 实测恒为 null/0，拿不到值，仅作兜底。
    sbcPoints: (d.gradingScore != null) ? d.gradingScore
             : (d.currentDbPrice != null ? d.currentDbPrice
             : (d.price != null ? d.price : (p.sbcPoints != null ? p.sbcPoints : null))),
    // AcceleRATE 分类：7 个桶（lengthy / explosive / controlled / mostlyLengthy /
    // mostlyExplosive / controlledLengthy / controlledExplosive），元素是**化学风格英文名**
    // （如 "Sniper"），表示「用该化学风格后加速类型会变成什么」。
    // 与列表接口的 accelerateType（基础类型，无化学时）配套，供小程序化学选择器标注 L/C/E。
    // 实测（2026-09-14，抽样 60 人）只有 lengthy/explosive/controlled 三桶有值，
    // 其余四桶恒为空 —— 但这里按原样整存，EA 后续若启用不必再改数据结构。
    accelerateTypes: d.accelerateTypes || null,
    // 赛季通行证（两档原始等级各存一份保真 + 归一后的 level/tier 供端上直接用）。
    // tier: 'premium' | 'standard' | null —— 端上据此选图标（sp-gold / sp）与配色。
    premiumSeasonPassLevel: spPremium,
    standardSeasonPassLevel: spStandard,
    seasonPassLevel: spLevel,
    seasonPassTier: spTier,
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
    // ⚠️ NEW_IDS/CHANGED_IDS 来自 diffSigs() 的 Object.keys()，是**字符串**；
    //    而 p.eaId 是 fut.gg JSON 里的**数字** —— Set.has 不做类型转换，
    //    不归一化的话增量模式一条都匹配不上（2026-09-18 run#41/#42 实锤：118 目标全 miss）。
    let needSet = null;
    if (DUMP_MODE !== 'full') {
      needSet = new Set(NEW_IDS.concat(CHANGED_IDS).map(String));
      console.log('本次需要成型：新增', NEW_IDS.length, '| 变化', CHANGED_IDS.length, '| 下架', REMOVED_IDS.length);
    }
    for (let i = 0; i < listPlayers.length; i++) {
      const p = listPlayers[i];
      if (needSet && !needSet.has(String(p.eaId))) continue;
      if (eaIdSet.has(p.eaId)) continue;
      eaIdSet.add(p.eaId);
      players.push(p);
      const _det = buildDetail(p, (dump.details && dump.details[p.eaId]) || {});
      details[p.eaId] = _det;
      // SBC 积分只有详情接口有（gradingScore），回写到列表文档，
      // 否则 players_fc27 里没有该字段、端上列表/详情页读不到。
      if (_det.sbcPoints != null) p.sbcPoints = _det.sbcPoints;
      // 赛季通行证同理：归属与等级都只有详情接口有 → 回写列表文档。
      // 端上「卡片来源」筛选读的是单值 cardSource，详情页读 seasonPassLevel/Tier。
      // SBC 优先级最高（SBC 卡不该被通行证覆盖），其余情况只要拿到等级就归通行证。
      if (_det.seasonPassLevel != null && p.cardSource !== 'SBC') {
        p.cardSource = 'SEASON_PASS';
        p.isSeasonPass = true;
        p.seasonPassLevel = _det.seasonPassLevel;
        p.seasonPassTier = _det.seasonPassTier;
      }
      // 体型码（bodytypeCode）与出生日期同理：**列表接口都不返回**，只有详情接口有 → 回写列表文档。
      //   ⚠️ 必须在这里回写：players_fc27 是 upload_db 用 doc(id).set()「整文档替换」写入的，
      //   凡是 pickPlayer 产不出来的字段，只要靠 off-line 回填补进去，就会被
      //   每日增量（签名变化的那批）与每周 full（全量重写）**连根抹掉**。2026-09-20 实锤：
      //   players_fc27.dateOfBirth 键存在但 19797/19797 全是空串（backfill_dob.js 的回填已被抹平），
      //   而「年龄」筛选正是比 dateOfBirth（birthFrom/birthTo）→ 该筛选恒返回空列表。
      //     · bodytypeCode 空 → 端上 hero /「球员信息」的「模型」无值
      if (_det.bodytypeCode != null) p.bodytypeCode = _det.bodytypeCode;
      if (_det.dateOfBirth) p.dateOfBirth = _det.dateOfBirth;
      if (players.length % 500 === 0) console.log('  成型', players.length, '/', needSet ? needSet.size : listPlayers.length);
    }
    if (needSet) {
      let missing = 0;
      needSet.forEach(function (id) { if (!eaIdSet.has(Number(id))) missing++; });
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
        const _bd = buildDetail(p, det);
        details[p.eaId] = _bd;
        if (_bd.sbcPoints != null) p.sbcPoints = _bd.sbcPoints;   // 同 full 分支：回写列表文档
        if (_bd.seasonPassLevel != null && p.cardSource !== 'SBC') {   // 同 full 分支：通行证回写
          p.cardSource = 'SEASON_PASS';
          p.isSeasonPass = true;
          p.seasonPassLevel = _bd.seasonPassLevel;
          p.seasonPassTier = _bd.seasonPassTier;
        }
        // 同 full 分支：体型码 / 出生日期只有详情接口有 → 必须回写列表文档，
        // 否则被 upload_db 的 doc(id).set() 整文档替换抹掉（见上面 DUMP 分支的详细说明）。
        if (_bd.bodytypeCode != null) p.bodytypeCode = _bd.bodytypeCode;
        if (_bd.dateOfBirth) p.dateOfBirth = _bd.dateOfBirth;
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
    // 稀有度英文名 → 小卡面文件名（rarity_<内容hash>.webp，键与 images.js#rarityFileKeyOf 同口径）。
    // 端上筛选弹层小卡面用；原 id 方案已废弃（金/银/铜共用占位 id 718，按 id 命名会张冠李戴）。
    rarityImgs: (function () {
      const m = {};
      listPlayers.forEach(function (p) {
        const r = p.rarity;
        if (r && r.name && r.imagePath) {
          const fk = imgLib.rarityFileKeyOf(r.imagePath);
          if (fk && !m[r.name]) m[r.name] = 'rarity_' + fk + '.webp';
        }
      });
      return m;
    })(),
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

// 作为脚本运行时才执行抓取/成型；被 require 时只导出函数（供单测直接调用 pickPlayer）
if (require.main === module) {
  main().catch(e => { console.error('抓取失败:', e); process.exit(1); });
}

// 单测入口：pickPlayer 是「列表文档字段」的唯一来源，
// 之前它缺了 sig.js 的归一化函数导入，CI 全量跑完才发现六维全 0 —— 必须有单测兜住。
// buildDetail / pickArr 也一并导出，供「详情空数组不得覆盖列表值」的回归断言直接调用。
module.exports = { pickPlayer, buildDetail, pickArr };
