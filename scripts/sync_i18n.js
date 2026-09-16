// 每日抓取后的「译名自动对账」：把云库里新出现的联赛 / 俱乐部 / 国家补齐中文，并下发到云端。
//
// 为什么需要它（2026-09-16 用户需求）：
//   小程序上线后不能再靠「人工发现没翻译 → 改代码 → 重新发版」这条路。EA 每次数据更新
//   都可能冒出新的联赛/俱乐部/国家（例：FC27 增量里出现了 Icons、Thailand League）。
//   本脚本在每天抓取落库之后跑一遍：扫全量真实取值 → 与包内词典比对 → 能自动翻译的自动补 →
//   合并成一份「名字词典」写进云库 dicts/names → 端上 utils/dictSync.js 拉取后立即生效。
//
// 三级来源（后面的覆盖前面的）：
//   ① data/i18n-bundle.json                包内词典的**快照**（由 eafc-miniapp/scripts/gen_cloud_i18n.js
//                                          从 miniapp utils/i18n.js 生成；人工维护，覆盖最全）
//   ② fetch-fc27/data/i18n-names.json       增长层：自动补的 + 人工补的（本脚本会回写）
//   ③ 规则自动推导
//        · 国家：data/country-zh.json 的「英文 → 中文」全量表（含形容词形式）
//        · 联赛："<国家/地区> League|Liga|Ligue|…" → "<国家中文>联赛"
//        · 俱乐部：**不做机器翻译**（EA 对未授权球队用化名，硬翻必错）→ 进 pending 报告等人工补
//
// ⚠️ 为什么 ① 用快照而不是直接 require miniapp 源码（2026-09-16 踩坑）：
//    本仓库的 CI 只 checkout fetch-fc27，工作区里没有 ../eafc-miniapp。
//    原先 `require('../eafc-miniapp/utils/i18n.js')` 在 CI 里直接 MODULE_NOT_FOUND，
//    test/i18n.test.js 挂在 require 上 → npm test 失败 → run #26/#27 全红
//    （本地因为有同级目录，永远复现不出来）。
//
// 产物：
//   ① 云库 dicts/names 单文档 { map, counts, pending, pendingCount, updateTime, updateISO }
//   ② cloud-data/fc{ver}/i18n_pending.json  待人工处理的清单（CI 会提交进仓库）
//   ③ 回写 fetch-fc27/data/i18n-names.json  新增的自动条目（便于版本化复查）
//
// 用法：cd fetch-fc27 && node scripts/sync_i18n.js [--ver 27] [--from-local] [--dry]
//   --from-local  不连云库，改用 cloud-data/fc{ver}/players.json
//   --dry         只审计 + 打印，不写云库、不回写文件（本地排查用）
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MINI = path.resolve(ROOT, '..', 'eafc-miniapp');   // 仅本地开发存在，用来提醒「快照过期」；CI 里没有
const BUNDLE_FILE = path.join(ROOT, 'data', 'i18n-bundle.json');
const SUPP_FILE = path.join(ROOT, 'data', 'i18n-names.json');
const COUNTRY_FILE = path.join(ROOT, 'data', 'country-zh.json');

const argv = process.argv.slice(2);
let VER = '27';
let DRY = false;
let FROM_LOCAL = false;
for (let i = 0; i < argv.length; i++) {
  if ((argv[i] === '--ver' || argv[i] === '-v') && argv[i + 1]) VER = String(argv[++i]).replace(/[^0-9]/g, '') || '27';
  else if (argv[i] === '--from-local') FROM_LOCAL = true;
  else if (argv[i] === '--dry') DRY = true;
}

const REPORT_FILE = path.join(ROOT, 'cloud-data', 'fc' + VER, 'i18n_pending.json');
const MIN_MAP_ENTRIES = 20;   // 联赛/国家任一类少于这么多条 → 拒绝写库（防把词典写坏）

// ---------- 1. 收集云库真实取值 ----------

function bump(map, name) {
  if (!name) return;
  const k = String(name).trim();
  if (!k) return;
  map[k] = (map[k] || 0) + 1;
}

function collectFromLocal() {
  const f = path.join(ROOT, 'cloud-data', 'fc' + VER, 'players.json');
  if (!fs.existsSync(f)) throw new Error('找不到 ' + f + '（--from-local 需要全量产物）');
  const j = JSON.parse(fs.readFileSync(f, 'utf8'));
  const arr = Array.isArray(j) ? j : (j.data || j.list || []);
  return arr;
}

async function collectFromCloud() {
  const cloudbase = require('@cloudbase/node-sdk');
  const { resolve: resolveCred } = require('./tcb_env');
  const cred = resolveCred();
  if (cred.missing.length) throw new Error('缺少云开发凭证：' + cred.missing.join(' / ') + '\n' + cred.hint);
  const app = cloudbase.init({ env: cred.ENV_ID, secretId: cred.SECRET_ID, secretKey: cred.SECRET_KEY, timeout: 120000 });
  return { db: app.database(), cloudbase: cloudbase, cred: cred };
}

async function scan(db) {
  const leagues = {}, clubs = {}, nations = {};
  let total = 0;
  for (let skip = 0; ; skip += 1000) {
    const r = await db.collection('players_fc' + VER)
      .field({ 'club.name': true, 'league.name': true, 'nation.name': true })
      .skip(skip).limit(1000).get();
    const rows = r.data || [];
    for (const p of rows) {
      bump(leagues, p.league && p.league.name);
      bump(clubs, p.club && p.club.name);
      bump(nations, p.nation && p.nation.name);
      total++;
    }
    if (rows.length < 1000) break;
  }
  return { leagues, clubs, nations, total };
}

// ---------- 2. 载入三级词典 ----------

// ① 包内词典快照 —— 仓库内的 data/i18n-bundle.json，本地与 CI 都读得到（不再 require miniapp 源码）。
const bundle = JSON.parse(fs.readFileSync(BUNDLE_FILE, 'utf8'));
const BUNDLE_MIN = { LEAGUE_ZH: 20, LEAGUE_SHORT_ZH: 20, CLUB_ZH: 100, NATION_ZH: 50 };
Object.keys(BUNDLE_MIN).forEach(function (k) {
  const n = Object.keys(bundle[k] || {}).length;
  if (n < BUNDLE_MIN[k]) {
    throw new Error('词典快照 ' + path.relative(ROOT, BUNDLE_FILE) + ' 的 ' + k + ' 只有 ' + n +
      ' 条（应 >= ' + BUNDLE_MIN[k] + '）。疑似未生成或被清空 —— 拒绝继续，否则会把云端 dicts/names 写残。' +
      '\n生成命令：cd eafc-miniapp && node scripts/gen_cloud_i18n.js');
  }
});

// 本地开发时 miniapp 源码就在同级目录：数量对不上说明快照该重新生成了（CI 里没有这个目录，自动跳过）。
(function warnIfBundleStale() {
  const live = path.join(MINI, 'utils', 'i18n.js');
  if (!fs.existsSync(live)) return;
  try {
    const l = require(live);
    const stale = ['LEAGUE_ZH', 'LEAGUE_SHORT_ZH', 'CLUB_ZH', 'NATION_ZH'].filter(function (k) {
      return Object.keys(l[k] || {}).length !== Object.keys(bundle[k] || {}).length;
    });
    if (stale.length) {
      console.warn('[sync_i18n] ⚠️ 快照 data/i18n-bundle.json 与 miniapp 源码不一致（' + stale.join(' / ') +
        '）→ 请在 eafc-miniapp 重跑 node scripts/gen_cloud_i18n.js');
    }
  } catch (e) { /* 源码语法问题不该拖垮对账 */ }
})();

const country = JSON.parse(fs.readFileSync(COUNTRY_FILE, 'utf8'));
const supp = JSON.parse(fs.readFileSync(SUPP_FILE, 'utf8'));

const leagueZh = Object.assign({}, bundle.LEAGUE_ZH);
const leagueShort = Object.assign({}, bundle.LEAGUE_SHORT_ZH);
const clubZh = Object.assign({}, bundle.CLUB_ZH);
const nationZh = Object.assign({}, bundle.NATION_ZH);

// 增长层（覆盖包内）
Object.keys(supp.league || {}).forEach(function (en) {
  const v = supp.league[en];
  if (typeof v === 'string') { if (v) leagueZh[en] = v; }
  else if (v && typeof v === 'object') {
    if (v.zh) leagueZh[en] = v.zh;
    if (v.short) leagueShort[en] = v.short;
  }
});
Object.keys(supp.club || {}).forEach(function (en) { if (supp.club[en]) clubZh[en] = supp.club[en]; });
Object.keys(supp.nation || {}).forEach(function (en) { if (supp.nation[en]) nationZh[en] = supp.nation[en]; });

// ---------- 3. 规则自动推导 ----------

// 国家：包内表 → 全量对照表 → 形容词还原
function autoNation(en) {
  const k = String(en).trim();
  return nationZh[k] || (country.map && country.map[k]) || '';
}

// 联赛："<国家/地区> League" 型。头部词可能是国家名（Thailand）或形容词（Korean）。
const ADJ = (country._adjectives || {});
const LEAGUE_TAIL = /^(.+?)[\s-]+(league|liga|ligue|ligi|liha|superliga|super\s*liga|super\s*league|division|divisie|championship|cup)$/i;
function countryOfHead(head) {
  const h = String(head || '').trim();
  if (!h) return '';
  const direct = nationZh[h] || (country.map && country.map[h]);
  if (direct) return direct;
  const base = ADJ[h];
  if (base) return nationZh[base] || (country.map && country.map[base]) || '';
  // 去掉形容词词尾再试一次（Dutch 之类已在 ADJ 里，这里兜底 Kuwaiti→Kuwait、Korean→Korea 等）
  const SUF = ['ian', 'ean', 'ish', 'ese', 'ic', 'an', 'i', 'n'];
  const keys = Object.keys(country.map || {});
  const low = h.toLowerCase();
  for (let s = 0; s < SUF.length; s++) {
    if (low.length - SUF[s].length < 4) continue;
    if (low.slice(-SUF[s].length) !== SUF[s]) continue;
    const stem = low.slice(0, low.length - SUF[s].length);
    for (let i = 0; i < keys.length; i++) {
      if (keys[i].toLowerCase().indexOf(stem) === 0) return country.map[keys[i]];
    }
  }
  return '';
}

function autoLeague(en) {
  const m = String(en).trim().match(LEAGUE_TAIL);
  if (!m) return '';
  const cn = countryOfHead(m[1]);
  if (!cn) return '';
  return cn + (m[2].toLowerCase().indexOf('cup') >= 0 ? '杯赛' : '联赛');
}

// ---------- 4. 逐个取值解析 ----------

function resolve(kind, counts) {
  const done = {}, pending = [], autoAdded = {};
  Object.keys(counts).forEach(function (en) {
    const cur = kind === 'league' ? leagueZh[en] : (kind === 'club' ? clubZh[en] : nationZh[en]);
    if (cur && cur !== en) { done[en] = cur; return; }     // 已有译名（包内或增长层）
    let zh = '';
    if (kind === 'league') zh = autoLeague(en);
    else if (kind === 'nation') zh = autoNation(en);
    // club：不做机器翻译
    if (zh) {
      done[en] = zh;
      autoAdded[en] = zh;
      if (kind === 'league') { leagueZh[en] = zh; }
      else if (kind === 'nation') { nationZh[en] = zh; }
    } else {
      pending.push({ en: en, players: counts[en] });
    }
  });
  pending.sort(function (a, b) { return b.players - a.players; });
  return { done: done, pending: pending, autoAdded: autoAdded };
}

// ---------- 5. 产出 ----------

function writeSupplement(autoLeagueAdd, autoNationAdd) {
  // 只把「自动补出来的」写回增长层（人工条目原样保留）。排序保证 diff 稳定。
  const out = JSON.parse(JSON.stringify(supp));
  out.league = out.league || {};
  out.nation = out.nation || {};
  let added = 0;
  Object.keys(autoLeagueAdd).forEach(function (en) {
    if (!out.league[en]) { out.league[en] = autoLeagueAdd[en]; added++; }
  });
  Object.keys(autoNationAdd).forEach(function (en) {
    if (!out.nation[en]) { out.nation[en] = autoNationAdd[en]; added++; }
  });
  const sortObj = function (o) {
    const r = {};
    Object.keys(o).sort().forEach(function (k) { r[k] = o[k]; });
    return r;
  };
  out.league = sortObj(out.league);
  out.nation = sortObj(out.nation);
  out.club = sortObj(out.club || {});
  if (!added) return { added: 0, file: SUPP_FILE };
  if (DRY) return { added: added, file: SUPP_FILE, skipped: true };
  fs.writeFileSync(SUPP_FILE, JSON.stringify(out, null, 2) + '\n', 'utf8');
  return { added: added, file: SUPP_FILE };
}

async function pushCloud(db, doc) {
  try { await db.createCollection('dicts'); } catch (e) { /* 已存在 */ }
  // ⚠️ @cloudbase/node-sdk 的 doc(id).set() 收**裸文档**，没有 { data: ... } 包装。
  //    写成 set({data: doc}) 会真的存成 { _id, data: {...} } —— 云函数那边读到的 map 就是 undefined
  //    （2026-09-16 实际踩到；云函数用的 wx-server-sdk 才是 set({data}) 包装，两套 SDK 不一样）。
  await db.collection('dicts').doc('names').set(doc);
}

// ---------- main ----------

async function main() {
  let counts;
  let db = null;
  if (FROM_LOCAL) {
    const arr = collectFromLocal();
    counts = { leagues: {}, clubs: {}, nations: {}, total: arr.length };
    arr.forEach(function (p) {
      bump(counts.leagues, p.league && p.league.name);
      bump(counts.clubs, p.club && p.club.name);
      bump(counts.nations, p.nation && p.nation.name);
    });
    console.log('[sync_i18n] 本地样本 ' + arr.length + ' 条（--from-local）');
  } else {
    const c = await collectFromCloud();
    db = c.db;
    counts = await scan(db);
    console.log('[sync_i18n] 云库 players_fc' + VER + ' 共 ' + counts.total + ' 条');
  }

  const lg = resolve('league', counts.leagues);
  const cb = resolve('club', counts.clubs);
  const nt = resolve('nation', counts.nations);

  const nLeagues = Object.keys(lg.done).length;
  const nNations = Object.keys(nt.done).length;
  if (nLeagues < MIN_MAP_ENTRIES || nNations < MIN_MAP_ENTRIES) {
    throw new Error('解析结果异常（联赛 ' + nLeagues + ' / 国家 ' + nNations + '），拒绝写库');
  }

  function line(label, r) {
    console.log('  ' + label + '：已译 ' + Object.keys(r.done).length + ' | 自动补 ' + Object.keys(r.autoAdded).length + ' | 待人工 ' + r.pending.length);
  }
  console.log('[sync_i18n] 审计结果');
  line('联赛  ', lg);
  line('俱乐部', cb);
  line('国家  ', nt);
  if (Object.keys(lg.autoAdded).length) console.log('  自动补的联赛: ' + Object.keys(lg.autoAdded).map(function (k) { return k + '→' + lg.autoAdded[k]; }).join(', '));
  if (Object.keys(nt.autoAdded).length) console.log('  自动补的国家: ' + Object.keys(nt.autoAdded).map(function (k) { return k + '→' + nt.autoAdded[k]; }).join(', '));
  if (cb.pending.length) {
    console.log('  待人工补的俱乐部（TOP20，写进 ' + path.relative(ROOT, SUPP_FILE) + ' 的 club 段即可）:');
    console.log('    ' + cb.pending.slice(0, 20).map(function (x) { return x.en + '(' + x.players + ')'; }).join('  '));
  }

  const doc = {
    map: {
      league: lg.done,
      leagueShort: (function () {
        const s = {};
        Object.keys(lg.done).forEach(function (en) { if (leagueShort[en]) s[en] = leagueShort[en]; });
        return s;
      })(),
      club: cb.done,
      nation: nt.done
    },
    counts: { league: Object.keys(lg.done).length, club: Object.keys(cb.done).length, nation: Object.keys(nt.done).length },
    pending: { league: lg.pending.slice(0, 50), club: cb.pending.slice(0, 200), nation: nt.pending.slice(0, 50) },
    pendingCount: lg.pending.length + cb.pending.length + nt.pending.length,
    updateTime: Date.now(),
    updateISO: new Date().toISOString(),
    source: 'sync_i18n.js',
    version: VER
  };

  const rep = writeSupplement(lg.autoAdded, nt.autoAdded);
  console.log('[sync_i18n] 增长层回写: 新增 ' + rep.added + ' 条 → ' + path.relative(ROOT, rep.file) + (rep.skipped ? '（--dry 未落盘）' : ''));

  fs.mkdirSync(path.dirname(REPORT_FILE), { recursive: true });
  fs.writeFileSync(REPORT_FILE, JSON.stringify({
    version: VER, total: counts.total, updateISO: doc.updateISO,
    counts: doc.counts, pendingCount: doc.pendingCount,
    pending: doc.pending
  }, null, 1) + '\n', 'utf8');
  console.log('[sync_i18n] 待办报告 → ' + path.relative(ROOT, REPORT_FILE));

  if (DRY) { console.log('[sync_i18n] --dry：未写云库 dicts/names'); return; }
  await pushCloud(db, doc);
  console.log('[sync_i18n] 已写入云库 dicts/names（联赛 ' + doc.counts.league + ' / 俱乐部 ' + doc.counts.club + ' / 国家 ' + doc.counts.nation + '，待人工 ' + doc.pendingCount + '）');
}

// 作为脚本直接跑才执行 main；被 test 里 require 时只取纯函数（不连云库、不写文件）
if (require.main === module) {
  main().catch(function (e) {
    console.error('[sync_i18n] 失败：' + ((e && e.message) || e));
    process.exit(1);
  });
}

module.exports = {
  autoNation: autoNation,
  autoLeague: autoLeague,
  countryOfHead: countryOfHead,
  resolve: resolve,
  bundle: bundle
};
