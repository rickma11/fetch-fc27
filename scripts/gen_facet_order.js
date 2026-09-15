// 生成小程序筛选面板的「排序 + 归属」数据文件
//
// 为什么需要它（2026-09-14 需求）：
//   筛选面板的取值来自云库 meta_fc{ver}/facets（CI 每天由 fetch_futgg.js 重算、upload_db.js 写入），
//   但那个文档有两个先天不足：
//     · positions / leagues / clubs 一律是**英文字母序**（生成时用的 uniqSorted 就是 .sort()）；
//     · clubs 只是一个去重数组，**不含「俱乐部属于哪个联赛」的信息**，做不了「选了联赛只列该联赛球队」。
//   产品要求的顺序：
//     · 位置：前场 → 中场 → 后场 → 门将
//     · 联赛：五大联赛置顶，其余按**中文显示名的拼音**
//     · 俱乐部：五大联赛热门球队置顶，其余按拼音
//
// 为什么拼音在这里算而不是在小程序端算：
//   iOS 微信的 JavaScriptCore 不保证 Intl.Collator 带 pinyin collation，端上算不可靠；
//   Node 环境实测 `zh-Hans-u-co-pinyin` 可用（安徽<北京<成都<广州<上海<浙江），故在生成期定序。
//   排序名取 i18n 的**中文显示名**，做到「显示什么就按什么排」；无中文映射的回落英文原名。
//
// 产物：eafc-miniapp/data/facetOrder.js
//   LEAGUE_ORDER      联赛英文名有序数组（五大置顶 → 其余拼音）
//   CLUB_ORDER        俱乐部英文名有序数组（五大热门球队置顶 → 其余拼音）
//   CLUBS_BY_LEAGUE   { 联赛英文名: [俱乐部英文名...] }，联赛内已按 CLUB_ORDER 排好
//   POSITION_ORDER    位置顺序（前场→中场→后场→门将）
//   meta              { version, updatedAt, counts }
//
// ⚠️ 这是**生成产物**（规矩同 gen_maps.js → data/playstyles.js）：
//   改「热门球队清单」或数据大更新后必须重跑本脚本，否则新俱乐部会因不在表内排到最后。
//
// 用法：cd fetch-fc27 && node scripts/gen_facet_order.js --ver 27
//   --from-local   不连云库，改用 cloud-data/fc{ver}/players.json（full 模式产物）
const fs = require('fs');
const path = require('path');
const i18n = require('../../eafc-miniapp/utils/i18n.js');

const ROOT = path.resolve(__dirname, '..');
const OUT_FILE = path.resolve(__dirname, '../../eafc-miniapp/data/facetOrder.js');

const argv = process.argv.slice(2);
let VER = '27';
let FROM_LOCAL = false;
for (let i = 0; i < argv.length; i++) {
  if ((argv[i] === '--ver' || argv[i] === '-v') && argv[i + 1]) VER = String(argv[++i]).replace(/[^0-9]/g, '') || '27';
  else if (argv[i] === '--from-local') FROM_LOCAL = true;
}

// ---------- 口径（产品清单，改这里就够了）----------

// 五大联赛：必须与 facets 里的**实际英文名**完全一致（大小写敏感，见 2026-09-14 全库扫描）
const BIG5 = [
  'Premier League',
  'LALIGA EA SPORTS',
  'Serie A Enilive',
  'Bundesliga',
  "Ligue 1 McDonald's"
];

// 五大联赛的「热门球队」：置顶顺序＝本数组顺序（先英超、再西甲、意甲、德甲、法甲）。
// ⚠️ 用 EA 游戏内名（未授权队是化名），中文显示由 i18n.clubZh 负责：
//    Milano FC=AC米兰、Lombardia FC=国际米兰、Latium=拉齐奥、OL=里昂、OM=马赛、Spurs=热刺
const HOT_CLUBS = [
  // 英超
  'Manchester City', 'Liverpool', 'Arsenal', 'Man Utd', 'Chelsea', 'Spurs', 'Newcastle Utd', 'Aston Villa',
  // 西甲
  'Real Madrid', 'FC Barcelona', 'Atlético de Madrid', 'Athletic Club', 'Sevilla FC', 'Real Betis', 'Villarreal CF',
  // 意甲
  'Juventus', 'Milano FC', 'Lombardia FC', 'SSC Napoli', 'AS Roma', 'Bergamo Calcio', 'Latium', 'Fiorentina',
  // 德甲
  'FC Bayern München', 'Borussia Dortmund', 'Leverkusen', 'RB Leipzig', 'VfB Stuttgart', 'Frankfurt',
  // 法甲
  'Paris SG', 'OL', 'OM', 'AS Monaco', 'LOSC Lille', 'Stade Rennais FC'
];

// 位置顺序：前场 → 中场 → 后场 → 门将（库内实际 12 个位置；未列出的排最后，按字母序）
const POSITION_ORDER = ['ST', 'LW', 'RW', 'CAM', 'CM', 'LM', 'RM', 'CDM', 'LB', 'CB', 'RB', 'GK'];

// 欧洲国家男子联赛（不含五大联赛）：联赛置顶段第二项。
// 成员＝ utils/i18n.js LEAGUE_ZH 中「欧洲男足」条目（含各级别，如英冠/德乙/西乙/法乙等），
// 用 i18n 权威英文名，确保与 facets 完全一致。土耳其/阿塞拜疆/塞浦路斯等 UEFA 成员联赛一并纳入。
const EUROPEAN_LEAGUES = [
  'EFL Championship', 'EFL League One', 'EFL League Two',
  'LALIGA HYPERMOTION', 'Serie BKT',
  'Bundesliga 2', '3. Liga',
  'Ligue 2 BKT',
  'Eredivisie', 'Liga Portugal', '1A Pro League',
  'Trendyol Süper Lig', 'Hellas Liga', 'Scottish Premiership',
  'Credit Suisse Super League', 'Österreichische Fußball-Bundesliga',
  'Eliteserien', 'Allsvenskan', '3F Superliga', 'SUPERLIGA',
  'PKO Bank Polski Ekstraklasa', 'Česká Liga', 'Liga Hrvatska',
  'Ukrayina Liha', 'Magyar Liga', 'Finnliiga', 'Liga Cyprus',
  'Liga Azerbaijan', 'SSE Airtricity Men\'s Premier Division'
];

// 联赛置顶段＝五大联赛 + 欧洲国家联赛 + 沙特 + 中超（其余按中文拼音排在后面）
const LEAGUE_PIN_EXTRA = EUROPEAN_LEAGUES.concat([
  'ROSHN Saudi League',                          // 沙特职业联赛
  'Chinese Football Association Super League'    // 中超
]);

// 世界杯传统强国（国家置顶段第一项）：按历史战绩大致分档，仅用于排序、不含任何评价
const WORLDCUP_POWERS = [
  'Brazil', 'Germany', 'Italy', 'Argentina', 'France',
  'Spain', 'England', 'Netherlands',
  'Portugal', 'Belgium', 'Croatia', 'Uruguay'
];
// 国家置顶段＝世界杯传统强国 + 中国（其余按拼音）
const NATION_PIN = WORLDCUP_POWERS.concat(['China PR']);

// ---------- 排序工具 ----------

const pinyinColl = new Intl.Collator('zh-Hans-u-co-pinyin', { usage: 'sort', sensitivity: 'base' });
const latinColl = new Intl.Collator('en', { usage: 'sort', sensitivity: 'base' });

function zhOf(kind, en) {
  if (kind === 'league') return i18n.leagueZh(en);
  if (kind === 'nation') return i18n.nationZh(en);
  return i18n.clubZh(en);
}

// 按「中文显示名的拼音」排序；显示名相同时用英文原名兜底，保证结果稳定
function pinyinSort(list, kind) {
  return list.slice().sort(function (a, b) {
    return pinyinColl.compare(zhOf(kind, a), zhOf(kind, b)) || latinColl.compare(a, b);
  });
}

function uniq(arr) {
  const s = new Set();
  arr.forEach(function (x) { if (x) s.add(x); });
  return Array.from(s);
}

// ---------- 取数 ----------

async function loadFromCloud() {
  const cloudbase = require('@cloudbase/node-sdk');
  const { resolve } = require('./tcb_env.js');
  const cred = resolve();
  if (cred.missing.length) {
    console.error('缺少云开发凭证：' + cred.missing.join(' / ') + '，改用 --from-local 或补 .env.local');
    process.exit(1);
  }
  const db = cloudbase.init({
    env: cred.ENV_ID, secretId: cred.SECRET_ID, secretKey: cred.SECRET_KEY, timeout: 90000
  }).database();

  const col = 'players_fc' + VER;
  const leagues = [];
  const clubs = [];
  const positions = [];
  const nations = [];
  const byLeague = {};   // league -> Set(club)
  let total = 0;
  for (let skip = 0; skip < 20000; skip += 500) {
    const r = await db.collection(col)
      .field({ 'club.name': true, 'league.name': true, 'nation.name': true, position: true })
      .skip(skip).limit(500).get();
    const rows = r.data || [];
    if (!rows.length) break;
    total += rows.length;
    rows.forEach(function (p) {
      const c = p.club && p.club.name;
      const l = p.league && p.league.name;
      const n = p.nation && p.nation.name;
      if (l) leagues.push(l);
      if (c) clubs.push(c);
      if (p.position) positions.push(p.position);
      if (n) nations.push(n);
      if (c && l) (byLeague[l] = byLeague[l] || new Set()).add(c);
    });
    if (rows.length < 500) break;
  }
  const byLeagueArr = {};
  Object.keys(byLeague).forEach(function (l) { byLeagueArr[l] = Array.from(byLeague[l]); });
  return { leagues: leagues, clubs: clubs, positions: positions, nations: nations, byLeague: byLeagueArr, total: total, source: 'cloud:' + col };
}

function loadFromLocal() {
  const f = path.join(ROOT, 'cloud-data', 'fc' + VER, 'players.json');
  if (!fs.existsSync(f)) {
    console.error('本地文件不存在：' + f + '（full 模式产物，未提交 git）→ 请去掉 --from-local 直连云库');
    process.exit(1);
  }
  const players = JSON.parse(fs.readFileSync(f, 'utf8'));
  const leagues = [];
  const clubs = [];
  const positions = [];
  const nations = [];
  const byLeague = {};
  players.forEach(function (p) {
    const c = p.club && p.club.name;
    const l = p.league && p.league.name;
    const n = p.nation && p.nation.name;
    if (l) leagues.push(l);
    if (c) clubs.push(c);
    if (p.position) positions.push(p.position);
    if (n) nations.push(n);
    if (c && l) (byLeague[l] = byLeague[l] || new Set()).add(c);
  });
  const byLeagueArr = {};
  Object.keys(byLeague).forEach(function (l) { byLeagueArr[l] = Array.from(byLeague[l]); });
  return { leagues: leagues, clubs: clubs, positions: positions, nations: nations, byLeague: byLeagueArr, total: players.length, source: 'local:players.json' };
}

// ---------- 主流程 ----------

(async () => {
  const t0 = Date.now();
  const raw = FROM_LOCAL ? loadFromLocal() : await loadFromCloud();
  console.log('取数来源:', raw.source, '| 球员', raw.total);

  const leagueAll = uniq(raw.leagues);
  const clubAll = uniq(raw.clubs);
  const nationAll = uniq(raw.nations || []);
  console.log('联赛', leagueAll.length, '| 俱乐部', clubAll.length, '| 国家', nationAll.length);

  // 联赛：五大 + 欧洲国家联赛 + 沙特 + 中超 置顶（按声明顺序）→ 其余按中文拼音
  const pinnedLeagues = BIG5.concat(LEAGUE_PIN_EXTRA);
  const pinnedLeagueSet = new Set(pinnedLeagues);
  const big5 = BIG5.filter(function (l) { return leagueAll.indexOf(l) >= 0; });
  const big5Missing = BIG5.filter(function (l) { return leagueAll.indexOf(l) < 0; });
  const leaguePinned = pinnedLeagues.filter(function (l) { return leagueAll.indexOf(l) >= 0; });
  const leaguePinnedMissing = pinnedLeagues.filter(function (l) { return leagueAll.indexOf(l) < 0; });
  const leagueRest = pinyinSort(leagueAll.filter(function (l) { return !pinnedLeagueSet.has(l); }), 'league');
  const LEAGUE_ORDER = leaguePinned.concat(leagueRest);

  // 国家：世界杯传统强国 + 中国 置顶（按声明顺序）→ 其余按中文拼音
  const nationPinned = NATION_PIN.filter(function (n) { return nationAll.indexOf(n) >= 0; });
  const nationPinnedMissing = NATION_PIN.filter(function (n) { return nationAll.indexOf(n) < 0; });
  const NATION_ORDER = nationPinned.concat(pinyinSort(nationAll.filter(function (n) { return NATION_PIN.indexOf(n) < 0; }), 'nation'));
  const nationNoZh = nationAll.filter(function (n) { return i18n.nationZh(n) === n; });

  // 俱乐部：热门置顶（按 HOT_CLUBS 声明顺序）→ 其余按拼音
  const hot = HOT_CLUBS.filter(function (c) { return clubAll.indexOf(c) >= 0; });
  const hotMissing = HOT_CLUBS.filter(function (c) { return clubAll.indexOf(c) < 0; });
  const clubRest = pinyinSort(clubAll.filter(function (c) { return HOT_CLUBS.indexOf(c) < 0; }), 'club');
  const CLUB_ORDER = hot.concat(clubRest);

  // 位置：按 POSITION_ORDER 定序，声明里没有的排最后（按字母序，防止 EA 新增位置时丢项）
  const posAll = uniq(raw.positions);
  const POSITIONS = POSITION_ORDER.filter(function (p) { return posAll.indexOf(p) >= 0; })
    .concat(posAll.filter(function (p) { return POSITION_ORDER.indexOf(p) < 0; }).sort());

  // 俱乐部按联赛分组，联赛内用全局 CLUB_ORDER 的顺序
  const clubRank = {};
  CLUB_ORDER.forEach(function (c, i) { clubRank[c] = i; });
  const CLUBS_BY_LEAGUE = {};
  Object.keys(raw.byLeague).forEach(function (l) {
    CLUBS_BY_LEAGUE[l] = raw.byLeague[l].slice().sort(function (a, b) {
      return (clubRank[a] === undefined ? 1e9 : clubRank[a]) - (clubRank[b] === undefined ? 1e9 : clubRank[b]);
    });
  });

  const out = {
    LEAGUE_ORDER: LEAGUE_ORDER,
    CLUB_ORDER: CLUB_ORDER,
    CLUBS_BY_LEAGUE: CLUBS_BY_LEAGUE,
    POSITION_ORDER: POSITIONS,
    NATION_ORDER: NATION_ORDER,
    meta: {
      version: VER,
      updatedAt: new Date().toISOString(),
      source: raw.source,
      players: raw.total,
      leagues: LEAGUE_ORDER.length,
      clubs: CLUB_ORDER.length,
      nations: NATION_ORDER.length,
      hotClubs: hot.length
    }
  };

  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE,
    '// ⚠️ 生成产物，请勿手改 —— 由 fetch-fc27/scripts/gen_facet_order.js 生成\n'
    + '// 重跑：cd fetch-fc27 && node scripts/gen_facet_order.js --ver ' + VER + '\n'
    + '// 口径（五大联赛 / 热门球队 / 位置顺序）在生成脚本顶部的常量里\n'
    + 'module.exports = ' + JSON.stringify(out, null, 2) + ';\n');

  // ---- 自检：把口径问题打出来，避免"悄悄排错" ----
  console.log('\n== 产出 ==');
  console.log('文件:', OUT_FILE, '|', (fs.statSync(OUT_FILE).size / 1024).toFixed(1) + ' KB', '| 耗时', (Date.now() - t0) + 'ms');
  console.log('联赛', LEAGUE_ORDER.length, '| 俱乐部', CLUB_ORDER.length, '| 位置', POSITIONS.length, '| 国家', NATION_ORDER.length, '| 热门球队命中', hot.length + '/' + HOT_CLUBS.length);
  if (big5Missing.length) console.log('⚠ 五大联赛没在数据里找到:', big5Missing.join(', '));
  if (leaguePinnedMissing.length) console.log('⚠ 置顶联赛没在数据里找到（不影响其余）:', leaguePinnedMissing.join(', '));
  if (nationPinnedMissing.length) console.log('⚠ 置顶国家没在数据里找到（不影响其余）:', nationPinnedMissing.join(', '));
  if (hotMissing.length) console.log('⚠ 热门球队没在数据里找到:', hotMissing.join(', '));
  if (nationNoZh.length) console.log('⚠ 国家缺中文映射（回落英文名）:', nationNoZh.join(', '));

  const zh = function (l) { return i18n.leagueZh(l); };
  console.log('\n联赛前 12（应为五大 + 欧洲联赛开头）:');
  LEAGUE_ORDER.slice(0, 12).forEach(function (l, i) { console.log('  ' + String(i + 1).padStart(2) + '. ' + zh(l) + '  (' + l + ')'); });
  console.log('联赛第 13~24（欧洲联赛继续）:');
  LEAGUE_ORDER.slice(12, 24).forEach(function (l, i) { console.log('  ' + String(i + 13).padStart(2) + '. ' + zh(l) + '  (' + l + ')'); });
  console.log('联赛第 25~34（沙特 / 中超 / 其余按拼音）:');
  LEAGUE_ORDER.slice(24, 34).forEach(function (l, i) { console.log('  ' + String(i + 25).padStart(2) + '. ' + zh(l) + '  (' + l + ')'); });
  console.log('\n位置顺序:', POSITIONS.join(' → '));
  console.log('\n国家前 15（世界杯强国 + 中国 置顶，其余拼音）:');
  NATION_ORDER.slice(0, 15).forEach(function (n, i) { console.log('  ' + String(i + 1).padStart(2) + '. ' + i18n.nationZh(n) + '  (' + n + ')'); });
  console.log('\n俱乐部前 12（热门置顶）:');
  CLUB_ORDER.slice(0, 12).forEach(function (c, i) { console.log('  ' + String(i + 1).padStart(2) + '. ' + i18n.clubZh(c) + '  (' + c + ')'); });
  console.log('俱乐部第 36~48（其余按拼音）:');
  CLUB_ORDER.slice(35, 48).forEach(function (c, i) { console.log('  ' + String(i + 36).padStart(2) + '. ' + i18n.clubZh(c)); });
  const lg = 'LALIGA EA SPORTS';
  console.log('\n[' + zh(lg) + '] 下的俱乐部（按 rank 排）:');
  console.log('  ' + (CLUBS_BY_LEAGUE[lg] || []).map(function (c) { return i18n.clubZh(c); }).join(', '));
})().catch(function (e) { console.error('生成失败:', e); process.exit(1); });
