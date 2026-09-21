// 每日抓取后的「译名对账」：把云库里新出现的联赛 / 俱乐部 / 国家补齐中文，并下发到云端。
//
// 为什么需要它（2026-09-16 用户需求）：
//   小程序上线后不能再靠「人工发现没翻译 → 改代码 → 重新发版」这条路。EA 每次数据更新
//   都可能冒出新的联赛/俱乐部/国家（例：FC27 增量里出现了 Icons、Thailand League）。
//   本脚本在每天抓取落库之后跑一遍：扫全量真实取值 → 与包内词典比对 → 把能找到中文的
//   补齐 → 合并成一份「名字词典」写进云库 dicts/names → 端上 utils/dictSync.js 拉取后立即生效。
//
// 三级来源（后面的覆盖前面的）：
//   ① data/i18n-bundle.json                包内词典快照（由 eafc-miniapp/scripts/gen_cloud_i18n.js
//                                          从 miniapp utils/i18n.js 生成；随包发布，覆盖最全）
//   ② fetch-fc27/data/i18n-names.json       增长层：人工补的（本脚本不再自动回写，仅供人工维护）
//   ③ Gitee OAO-evotrans 仓库 miniapp-dictionaries.json 的 basic 段
//        https://gitee.com/rickma11/OAO-evotrans/raw/master/miniapp-dictionaries.json
//        —— 用户集中维护的新源。包内表未收录的取值，优先从这里抓中文。
//
// ⚠️ 自动翻译已移除（2026-09-19 用户决策）：
//   旧版的「规则自动推导」（国家对照表 country-zh.json / 联赛 "<国家> League" 推导）不再使用。
//   包内表 + 增长层 + Gitee basic 都查不到的取值 → 直接展示英文（进 pending），
//   不再机器翻译；等下次抓取时 Gitee basic 更新了，本脚本自动补齐下发即可。
//   （合规条目 Chinese Taipei→中国台湾 / Hong Kong→中国香港 / Macao→中国澳门 已固化进包内表 ①，
//    不依赖外部源，始终生效。）
//
// 产物：
//   ① 云库 dicts/names 单文档 { map, counts, pending, pendingCount, updateTime, updateISO }
//   ② cloud-data/fc{ver}/i18n_pending.json  待人工处理的清单（CI 会提交进仓库）
//
// 用法：cd fetch-fc27 && node scripts/sync_i18n.js [--ver 27] [--from-local] [--dry]
//   --from-local  不连云库，改用 cloud-data/fc{ver}/players.json
//   --dry         只审计 + 打印，不写云库（本地排查用）
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');

const ROOT = path.resolve(__dirname, '..');
const MINI = path.resolve(ROOT, '..', 'eafc-miniapp');   // 仅本地开发存在，用来提醒「快照过期」；CI 里没有
const BUNDLE_FILE = path.join(ROOT, 'data', 'i18n-bundle.json');
const SUPP_FILE = path.join(ROOT, 'data', 'i18n-names.json');

// 新维护源：Gitee OAO-evotrans 仓库的 miniapp-dictionaries.json 的 basic 段。
// 用户把所有「联赛/俱乐部/国家」的中文名集中维护在这里，sync_i18n 每天抓取后用它补齐
// 包内表未收录的取值。注意 Gitee raw 会 302 跳转到带签名的 raw.giteeusercontent.com，
// 脚本内跟随重定向（签名有时效，不能写死跳转后的地址）。
const GITEE_BASIC_URL = 'https://gitee.com/rickma11/OAO-evotrans/raw/master/miniapp-dictionaries.json';

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

// ---------- 1. 包内快照 + 增长层（同步载入，CI / 本地都读得到） ----------

// ① 包内词典快照 —— 仓库内的 data/i18n-bundle.json。CI 里没有 ../eafc-miniapp，所以不 require 源码。
const BUNDLE = JSON.parse(fs.readFileSync(BUNDLE_FILE, 'utf8'));
const SUPP = JSON.parse(fs.readFileSync(SUPP_FILE, 'utf8'));

const BUNDLE_MIN = { LEAGUE_ZH: 20, LEAGUE_SHORT_ZH: 20, CLUB_ZH: 100, NATION_ZH: 50 };
Object.keys(BUNDLE_MIN).forEach(function (k) {
  const n = Object.keys(BUNDLE[k] || {}).length;
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
      return Object.keys(l[k] || {}).length !== Object.keys(BUNDLE[k] || {}).length;
    });
    if (stale.length) {
      console.warn('[sync_i18n] ⚠️ 快照 data/i18n-bundle.json 与 miniapp 源码不一致（' + stale.join(' / ') +
        '）→ 请在 eafc-miniapp 重跑 node scripts/gen_cloud_i18n.js');
    }
  } catch (e) { /* 源码语法问题不该拖垮对账 */ }
})();

// 合并三级来源 → 三类中文映射。giteeBasic 仅做 gap-fill（不覆盖 ① / ② 已有条目）。
function buildMaps(giteeBasic) {
  const leagueZh = Object.assign({}, BUNDLE.LEAGUE_ZH);
  const leagueShort = Object.assign({}, BUNDLE.LEAGUE_SHORT_ZH);
  const clubZh = Object.assign({}, BUNDLE.CLUB_ZH);
  const nationZh = Object.assign({}, BUNDLE.NATION_ZH);

  // ② 增长层（覆盖包内）
  Object.keys(SUPP.league || {}).forEach(function (en) {
    const v = SUPP.league[en];
    if (typeof v === 'string') { if (v) leagueZh[en] = v; }
    else if (v && typeof v === 'object') {
      if (v.zh) leagueZh[en] = v.zh;
      if (v.short) leagueShort[en] = v.short;
    }
  });
  Object.keys(SUPP.club || {}).forEach(function (en) { if (SUPP.club[en]) clubZh[en] = SUPP.club[en]; });
  Object.keys(SUPP.nation || {}).forEach(function (en) { if (SUPP.nation[en]) nationZh[en] = SUPP.nation[en]; });

  // ③ Gitee basic：只补「包内表 + 增长层」都查不到的取值（gap-fill，不覆盖已有）
  //    兼容旧调用（传扁平全称 map）与新结构（{ zh, short }）。
  let gZh = giteeBasic, gShort = {};
  if (giteeBasic && typeof giteeBasic === 'object' && !Array.isArray(giteeBasic) && ('zh' in giteeBasic || 'short' in giteeBasic)) {
    gZh = giteeBasic.zh || {};
    gShort = giteeBasic.short || {};
  }
  Object.keys(gZh || {}).forEach(function (en) {
    if (!leagueZh[en]) leagueZh[en] = gZh[en];
    if (!clubZh[en]) clubZh[en] = gZh[en];
    if (!nationZh[en]) nationZh[en] = gZh[en];
  });
  // 联赛简称：同样只做 gap-fill（不覆盖包内表 / 增长层已有简称）
  Object.keys(gShort || {}).forEach(function (en) {
    if (!leagueShort[en]) leagueShort[en] = gShort[en];
  });

  return { leagueZh: leagueZh, leagueShort: leagueShort, clubZh: clubZh, nationZh: nationZh };
}

// 模块载入即按「空 giteeBasic」建一份（够测试用）；main 里抓到 Gitee basic 后再重建。
let MAPS = buildMaps({});

// ---------- 2. 收集云库真实取值 ----------

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

// ---------- 3. 抓取 Gitee basic ----------

// 跟随 301/302 重定向下载（Gitee raw 会跳到带签名的 raw.giteeusercontent.com）。
function httpsGet(url, redirectsLeft) {
  return new Promise(function (resolve, reject) {
    const req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 sync_i18n' } }, function (res) {
      const code = res.statusCode;
      if (code >= 300 && code < 400 && res.headers.location && redirectsLeft > 0) {
        res.resume();
        const next = res.headers.location.indexOf('http') === 0
          ? res.headers.location
          : (new (require('url').URL)(res.headers.location, url).href);
        resolve(httpsGet(next, redirectsLeft - 1));
        return;
      }
      if (code !== 200) { res.resume(); reject(new Error('HTTP ' + code + ' 拉取 ' + url)); return; }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', function (c) { body += c; });
      res.on('end', function () { resolve(body); });
    });
    req.on('error', reject);
  });
}

// 把 Gitee 文件的 basic 段抽成 { zh: {name:全称中文}, short: {name:简称中文} }。
// basic 形如 { "League 2273": {"webpagedata":"冰女超", "short":"冰女超"} }，兼容值为纯字符串（仅全称）。
function parseGiteeBasic(obj) {
  const basic = (obj && obj.basic) || {};
  const zh = {};
  const shortMap = {};
  Object.keys(basic).forEach(function (k) {
    const v = basic[k];
    if (v && typeof v === 'object') {
      if (v.webpagedata) zh[k] = v.webpagedata;
      if (v.short) shortMap[k] = v.short;   // 简称：只展示在窄位（如联赛简称），无则回落全称
    } else if (typeof v === 'string') {
      if (v) zh[k] = v;
    }
  });
  return { zh: zh, short: shortMap };
}

async function fetchGiteeBasic() {
  try {
    const body = await httpsGet(GITEE_BASIC_URL, 5);
    const map = parseGiteeBasic(JSON.parse(body));
    console.log('[sync_i18n] 已从 Gitee basic 拉取 ' + Object.keys(map.zh).length + ' 条全称译名（含简称 ' + Object.keys(map.short).length + ' 条）');
    return map;
  } catch (e) {
    console.warn('[sync_i18n] ⚠️ 拉取 Gitee basic 失败（' + e.message + '），本次不补齐；未翻译项仍走英文/pending');
    return {};
  }
}

// ---------- 4. 逐个取值解析（不再机器翻译） ----------

// kind: 'league' | 'club' | 'nation'。maps 不传则使用模块级 MAPS（已含 Gitee basic）。
function resolve(kind, counts, maps) {
  const m = maps || MAPS;
  const zh = kind === 'league' ? m.leagueZh : (kind === 'club' ? m.clubZh : m.nationZh);
  const done = {}, pending = [];
  Object.keys(counts).forEach(function (en) {
    const cur = zh[en];
    if (cur && cur !== en) { done[en] = cur; }     // 已有中文（包内 / 增长层 / Gitee basic）
    else { pending.push({ en: en, players: counts[en] }); }  // 未翻译 → 展示英文，等 Gitee basic 更新
  });
  pending.sort(function (a, b) { return b.players - a.players; });
  return { done: done, pending: pending, autoAdded: {} };
}

// ---------- 5. 产出 ----------

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

  // 抓取 Gitee basic 并重建映射（含未翻译项补齐）
  const giteeBasic = await fetchGiteeBasic();
  MAPS = buildMaps(giteeBasic);

  const lg = resolve('league', counts.leagues);
  const cb = resolve('club', counts.clubs);
  const nt = resolve('nation', counts.nations);

  const nLeagues = Object.keys(lg.done).length;
  const nNations = Object.keys(nt.done).length;
  if (nLeagues < MIN_MAP_ENTRIES || nNations < MIN_MAP_ENTRIES) {
    throw new Error('解析结果异常（联赛 ' + nLeagues + ' / 国家 ' + nNations + '），拒绝写库');
  }

  function line(label, r) {
    console.log('  ' + label + '：已译 ' + Object.keys(r.done).length + ' | 待人工(英文) ' + r.pending.length);
  }
  console.log('[sync_i18n] 审计结果');
  line('联赛  ', lg);
  line('俱乐部', cb);
  line('国家  ', nt);
  if (cb.pending.length) {
    console.log('  待人工补的俱乐部（TOP20，去 Gitee basic 加条目即可）:');
    console.log('    ' + cb.pending.slice(0, 20).map(function (x) { return x.en + '(' + x.players + ')'; }).join('  '));
  }

  const doc = {
    map: {
      league: lg.done,
      leagueShort: (function () {
        const s = {};
        Object.keys(lg.done).forEach(function (en) { if (MAPS.leagueShort[en]) s[en] = MAPS.leagueShort[en]; });
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
  resolve: resolve,
  buildMaps: buildMaps,
  parseGiteeBasic: parseGiteeBasic,
  bundle: BUNDLE
};
