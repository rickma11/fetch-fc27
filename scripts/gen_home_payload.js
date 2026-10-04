// FC27 首页整页静态 JSON 生成器（方案 B，2026-09-30）。
//
// 目的：把「首页热门 + 新增」从「端上每次走 buildHomePayload（roster 预载 1 云函数 + 1 DB 读 +
// player_hot#list 云函数 + byIds 补详情）」改为「CI 预生成静态 JSON 落云存储，端上 wx.cloud.downloadFile
// 直读」，让首页主链路**零云函数调用**（与 gen_static_lists 同构，复用其 publishOne）。
//
// 数据来源（真源＝云数据库，消除「本地名册新鲜度滞后」风险）：
//   · meta_fc{ver}/hotboard.fileID → downloadFile 直读 top20 热门榜 [{eaId, v}]（与端上 viewedIds24h 同源）
//   · players_fc{ver} 按 _id(_in) 取 ≤20 条完整记录（热门球员）
//   · players_fc{ver} 按 createdAt desc 取 120 条 → newFeed 过滤 → 取最新 20 条（新增球员）
//   · 中文映射：
//     － basic（稀有度/卡类型/SBC/EVO 中文化）＝ gen_dict_static 生成的静态 JSON，
//       从 meta_fc{ver}/dict_basic 元文档 → downloadFile 直读（2026-10-04 起；原 dicts/basic 由已删云函数写入，已孤儿化）
//     － names（{league,leagueShort,club,nation}）仍由 sync_i18n 每日写 dicts/names（与静态 JSON names 段同源）
//     （BUNDLE 包内快照兜底 names 类，最后回落英文 —— 与端上 i18n 优先级一致）
//
// 输出（云存储，复用 gen_static_lists#publishOne）：
//   · fc{ver}/data/home_hot/home_hot.<hash8>.json  （装饰后的热门球员数组，带 hotViews）
//   · fc{ver}/data/home_new/home_new.<hash8>.json  （装饰后的新增球员数组）
//   · 写元文档 meta_fc{ver}/home_hot、home_new ＝ {fetchedAt,count,fileID,hash,ts,forceVersion}
//
// ⚠️ 装饰逻辑（displayImg / 中文映射 / orgLine / rarityGroup）必须**逐字段**与端上
//   eafc-miniapp/utils/dataLoader.js#decorate 保持同口径；任何改动须双处同步（CI 单测会兜底对拍）。
// ⚠️ newFeed 口径（overall>=80 或 特殊稀有度）必须**逐字符**与端上 utils/dataLoader.js#applyLocalFilters 一致。
//
// 用法：node scripts/gen_home_payload.js [ver]      （ver 默认 27；--no-upload 仅本地校验不写云）
'use strict';

const fs = require('fs');
const path = require('path');
const cloudbase = require('@cloudbase/node-sdk');
const genStatic = require('./gen_static_lists.js');

const ROOT = path.resolve(__dirname, '..');
const VER = Number(process.argv[2] || process.env.FC_VER || 27);
const NO_UPLOAD = process.argv.indexOf('--no-upload') >= 0;
const META_COLLECTION = 'meta_fc' + VER;
const PLAYERS_COLLECTION = 'players_fc' + VER;
const HOT_LIMIT = 20;
const NEW_LIMIT = 20;
const NEW_CANDIDATE = 120;   // 取最新 120 再用 newFeed 过滤，避免过滤后不足 20 条

// ── 镜像 utils/format.js 的云存储常量与 displayImg 逻辑（端上 decorate 用的同一个，必须一致）──
const CLOUD_ENV = 'cloud1-d5gq6q3np8708aeef';
const CLOUD_BUCKET = '636c-cloud1-d5gq6q3np8708aeef-1475854307';
function cloudImg(eaId, suffix) {
  if (!eaId) return '';
  return 'cloud://' + CLOUD_ENV + '.' + CLOUD_BUCKET + '/fc' + VER + '/images/' + eaId + suffix;
}
// 与 utils/format.js#displayImg 同口径：有 imagePath → 真实卡面 _card.webp；无 → 本人原卡面 _np.webp
function displayImg(p) {
  const ea = p && (p.eaId != null ? p.eaId : p._id);
  if (ea == null) return '';
  if (p.imagePath) return cloudImg(ea, '_card.webp');
  return cloudImg(ea, '_np.webp');
}

// ── 中文映射：云库 dicts 优先，fetch-fc27 包内快照（i18n-bundle.json）兜底，最后回落英文（与端上一致）──
function loadBundle() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'data/i18n-bundle.json'), 'utf8'));
  } catch (e) {
    console.warn('[gen_home_payload] 读 i18n-bundle.json 失败（中文将只剩云库/英文）', e.message);
    return {};
  }
}
const BUNDLE = loadBundle();

// node-sdk / wx-server-sdk 的 doc().get() 返回 data 可能是数组或对象，统一解包
function docData(r) {
  if (!r) return null;
  const d = r.data;
  if (Array.isArray(d)) return d[0] || null;
  return d || null;
}

// basic（稀有度/卡类型/SBC/EVO 中文化）现由 gen_dict_static 生成静态 JSON 落云存储，
// 从 meta_fc{ver}/dict_basic 元文档 → downloadFile 直读（不再读已删云函数写的 dicts/basic，避免孤儿读）。
async function loadBasicStatic(app) {
  try {
    const meta = docData(await app.database().collection(META_COLLECTION).doc('dict_basic').get());
    const fileID = meta && meta.fileID;
    if (!fileID) {
      console.warn('[gen_home_payload] 无 dict_basic 元文档（dict-static.yml 还没跑过？）回落英文');
      return {};
    }
    const dl = await app.downloadFile({ fileID: fileID });
    const buf = dl && dl.fileContent;
    if (!buf || !buf.length) throw new Error('dict_basic 回读空');
    const obj = JSON.parse(buf.toString('utf8'));
    if (obj && obj.basic && obj.basic.map && typeof obj.basic.map === 'object') return obj.basic.map;
    throw new Error('dict_basic 结构不符（缺 basic.map）');
  } catch (e) {
    console.warn('[gen_home_payload] 读 dict_basic 静态 JSON 失败，回落英文', e.message);
    return {};
  }
}

async function loadDicts(app) {
  const db = app.database();
  let basicMap = {};
  let namesMap = { league: {}, leagueShort: {}, club: {}, nation: {} };
  // basic：改读 gen_dict_static 静态 JSON（落云存储 + meta_fc{ver}/dict_basic）；不再读已删云函数写的 dicts/basic
  basicMap = await loadBasicStatic(app);
  // names：仍由 sync_i18n 每日写 dicts/names（与静态 JSON names 段同源），保留 DB 直读
  try {
    const n = docData(await db.collection('dicts').doc('names').get());
    if (n && n.map && typeof n.map === 'object') {
      ['league', 'leagueShort', 'club', 'nation'].forEach(function (k) {
        if (n.map[k] && typeof n.map[k] === 'object') namesMap[k] = n.map[k];
      });
    }
  } catch (e) {
    console.warn('[gen_home_payload] 读 dicts/names 失败，回落包内/英文', e.message);
  }
  return { basicMap: basicMap, namesMap: namesMap };
}

// —— 以下 zh 函数优先级：names 类＝云库 dicts/names 覆盖 → BUNDLE 包内快照 → 英文；
//    rarity 类＝dict_basic 静态 JSON（basicMap）覆盖 → 英文（与端上 i18n.js 一致）——
function zhLeague(cloud, name) {
  const k = String(name == null ? '' : name).trim();
  if (!k || k === '-') return '-';
  return cloud.league[k] || (BUNDLE.LEAGUE_ZH && BUNDLE.LEAGUE_ZH[k]) || k;
}
function zhLeagueShort(cloud, name) {
  const k = String(name == null ? '' : name).trim();
  if (!k || k === '-') return '-';
  if (cloud.leagueShort[k]) return cloud.leagueShort[k];
  if (BUNDLE.LEAGUE_SHORT_ZH && BUNDLE.LEAGUE_SHORT_ZH[k]) return BUNDLE.LEAGUE_SHORT_ZH[k];
  return zhLeague(cloud, name);   // 回落 league 全称
}
function zhClub(cloud, name) {
  const k = String(name == null ? '' : name).trim();
  if (!k || k === '-') return '-';
  return cloud.club[k] || (BUNDLE.CLUB_ZH && BUNDLE.CLUB_ZH[k]) || k;
}
function zhNation(cloud, name) {
  const k = String(name == null ? '' : name).trim();
  if (!k || k === '-') return '-';
  return cloud.nation[k] || (BUNDLE.NATION_ZH && BUNDLE.NATION_ZH[k]) || k;
}
function zhRarity(basicMap, name) {
  const k = String(name == null ? '' : name).trim();
  if (!k || k === '-') return '-';
  return basicMap[k] || k;
}
// 联赛 · 俱乐部 展示行：两者都有 = 两者；缺一 = 只展示有的；全缺 = 暂无信息（与 dataLoader#orgLineOf 一致）
function orgLineOf(lgZh, cbZh) {
  const lg = (lgZh && lgZh !== '-') ? lgZh : '';
  const cb = (cbZh && cbZh !== '-') ? cbZh : '';
  return (lg && cb) ? (lg + ' · ' + cb) : (lg || cb || '暂无信息');
}

// 复刻 dataLoader.decorate（纯展示字段，不含 roster 缓存副作用）
function decorate(list, dicts) {
  (list || []).forEach(function (p) {
    p.img = displayImg(p);
    p.clubName = p.club ? (p.club.name || '-') : '-';
    p.leagueName = p.league ? (p.league.name || '-') : '-';
    p.nationName = p.nation ? (p.nation.name || '-') : '-';
    p.clubNameZh = zhClub(dicts.namesMap, p.clubName);
    p.leagueNameZh = zhLeague(dicts.namesMap, p.leagueName);
    p.leagueNameShort = zhLeagueShort(dicts.namesMap, p.leagueName);
    p.nationNameZh = zhNation(dicts.namesMap, p.nationName);
    p.orgLine = orgLineOf(p.leagueNameZh, p.clubNameZh);
    p.rarityName = p.rarity ? (p.rarity.name || '-') : '-';
    p.rarityNameZh = zhRarity(dicts.basicMap, p.rarityName);
    p.rarityGroup = (p.rarity && p.rarity.rarityGroupName) || '';
  });
  return list || [];
}

function idOf(p) {
  return String(p.eaId != null ? p.eaId : p._id);
}

// 读热门榜静态 JSON（与端上 viewedIds24h 同源）：meta_fc{ver}/hotboard.fileID → downloadFile → parse
async function loadHotboard(app) {
  const db = app.database();
  const meta = docData(await db.collection(META_COLLECTION).doc('hotboard').get());
  const fileID = meta && meta.fileID;
  if (!fileID) {
    console.warn('[gen_home_payload] 无 hotboard 元文档（微信定时器 trigger_hotboard 还没跑过？）');
    return [];
  }
  const dl = await app.downloadFile({ fileID: fileID });
  const buf = dl && dl.fileContent;
  if (!buf || !buf.length) throw new Error('hotboard 回读空');
  const arr = JSON.parse(buf.toString('utf8'));
  if (!Array.isArray(arr)) throw new Error('hotboard 非数组');
  return arr;   // [{eaId, v}]
}

// newFeed 过滤（与 dataLoader#applyLocalFilters 同口径，逐字符一致）
function passNewFeed(p) {
  if ((p.overall || 0) >= 80) return true;
  const rn = (p.rarity && p.rarity.name) || '';
  return ['Gold', 'Silver', 'Bronze', 'Rare', 'Non-Rare', 'Common'].indexOf(rn) < 0;
}

async function run() {
  const app = genStatic.initCloud();
  const db = app.database();
  const cmd = db.command;
  const dicts = await loadDicts(app);

  // 1) 热门榜 top20
  const board = await loadHotboard(app);
  const hotIds = board.slice(0, HOT_LIMIT).map(function (x) { return String(x.eaId); });
  const hotV = {};
  board.slice(0, HOT_LIMIT).forEach(function (x) { hotV[String(x.eaId)] = x.v; });
  console.log('[gen_home_payload] hotboard top=', hotIds.length);

  // 2) 热门球员：云库 by _id in，按 hotIds 顺序对齐（where in 不保序）
  let hotRecords = [];
  if (hotIds.length) {
    const hr = await db.collection(PLAYERS_COLLECTION).where({ _id: cmd.in(hotIds) }).get();
    const byId = {};
    (hr.data || []).forEach(function (p) { byId[idOf(p)] = p; });
    hotRecords = hotIds.map(function (id) { return byId[id]; }).filter(Boolean);
  }
  decorate(hotRecords, dicts);
  hotRecords.forEach(function (p) { p.hotViews = Number(hotV[idOf(p)]) || 0; });

  // 3) 新增球员：createdAt desc 取 NEW_CANDIDATE → newFeed 过滤 → 取最新 20
  const nr = await db.collection(PLAYERS_COLLECTION).orderBy('createdAt', 'desc').limit(NEW_CANDIDATE).get();
  let newCandidates = (nr.data || []).filter(passNewFeed);
  let newRecords = newCandidates.slice(0, NEW_LIMIT);
  decorate(newRecords, dicts);

  const fetchedAt = new Date().toISOString();

  if (NO_UPLOAD) {
    console.log('\n本地校验（--no-upload，未写云）');
    console.log('  hot=' + hotRecords.length + ' new=' + newRecords.length);
    if (hotRecords[0]) {
      const h = hotRecords[0];
      console.log('  hot[0]:', h.commonName, '| orgLine=' + h.orgLine, '| rarityNameZh=' + h.rarityNameZh,
        '| clubNameZh=' + h.clubNameZh, '| nationNameZh=' + h.nationNameZh,
        '| hotViews=' + h.hotViews, '| img=' + String(h.img).slice(0, 46));
    }
    if (newRecords[0]) {
      const n = newRecords[0];
      console.log('  new[0]:', n.commonName, '| orgLine=' + n.orgLine, '| rarityNameZh=' + n.rarityNameZh);
    }
    // 形状断言（不写云也校验装饰字段完整性）
    const ok = hotRecords.length > 0 && newRecords.length > 0 &&
      hotRecords.every(function (p) {
        return p.img && String(p.img).indexOf('cloud://') === 0 &&
          p.orgLine && p.rarityNameZh && p.clubNameZh && p.nationNameZh && typeof p.hotViews === 'number';
      }) &&
      newRecords.every(function (p) {
        return p.img && String(p.img).indexOf('cloud://') === 0 && p.orgLine && p.rarityNameZh;
      });
    console.log(ok ? '  ✅ 形状校验通过' : '  ❌ 形状校验失败');
    process.exit(ok ? 0 : 9);
  }

  await genStatic.publishOne(app, 'home_hot', hotRecords, fetchedAt);
  await genStatic.publishOne(app, 'home_new', newRecords, fetchedAt);
  console.log('\n=== gen_home_payload 完成 ===');
}

if (require.main === module) {
  run().catch(function (e) {
    console.error('[gen_home_payload] 失败：', e && e.message);
    process.exit(1);
  });
}

module.exports = {
  decorate: decorate,
  displayImg: displayImg,
  orgLineOf: orgLineOf,
  zhLeague: zhLeague, zhLeagueShort: zhLeagueShort, zhClub: zhClub, zhNation: zhNation, zhRarity: zhRarity,
  passNewFeed: passNewFeed, idOf: idOf, loadDicts: loadDicts, loadHotboard: loadHotboard, VER: VER
};
