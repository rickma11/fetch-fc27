// 「译名自动对账」单测：`npm test` 会一并执行
//
// 背景（2026-09-16 用户需求）：小程序上线后不能再靠「发现没翻译 → 改代码 → 重新发版」。
// scripts/sync_i18n.js 每天抓取后扫全量数据、自动补译名并下发云端。本测试守住它的**判定口径**：
//   ① 国家：包内表 + 全量对照表都能命中；
//   ② 联赛："<国家/地区> League|Liga|…" 型能推导成 "<国家中文>联赛"，形容词形式（Korean）也能还原；
//   ③ 俱乐部：**绝不做机器翻译**（EA 化名硬翻必错）——未知俱乐部必须进 pending 等人工；
//   ④ 未知项一律进 pending，不能凭猜测造译名。
const assert = require('assert');
const S = require('../scripts/sync_i18n.js');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log('  PASS', name); pass++; }
  catch (e) { console.log('  FAIL', name, '->', e.message); fail++; }
}

console.log('译名自动对账 (sync_i18n)');

// ---------- 国家 ----------
t('国家：包内表命中（China PR）', function () {
  assert.strictEqual(S.autoNation('China PR'), '中国');
});
t('国家：对照表命中（Kuwait）', function () {
  assert.strictEqual(S.autoNation('Kuwait'), '科威特');
});
t('国家：对照表命中（Palestinian Authority）', function () {
  assert.strictEqual(S.autoNation('Palestinian Authority'), '巴勒斯坦');
});
t('国家：对照表命中（Vanuatu）', function () {
  assert.strictEqual(S.autoNation('Vanuatu'), '瓦努阿图');
});
t('国家：未知国家不猜（Neverland → 空）', function () {
  assert.strictEqual(S.autoNation('Neverland'), '');
});
t('国家：中国地区表述合规（Chinese Taipei / Hong Kong）', function () {
  // 对照表里的官方表述，防止后人改成「台湾/香港」
  const m = require('../data/country-zh.json').map;
  assert.strictEqual(m['Chinese Taipei'], '中国台湾');
  assert.strictEqual(m['Hong Kong'], '中国香港');
  assert.strictEqual(m['Macao'], '中国澳门');
});

// ---------- 联赛 ----------
t('联赛：<国家> League 推导（Thailand League）', function () {
  assert.strictEqual(S.autoLeague('Thailand League'), '泰国联赛');
});
t('联赛：形容词头部还原（Korean League）', function () {
  assert.strictEqual(S.autoLeague('Korean League'), '韩国联赛');
});
t('联赛：Super League 变体（Uzbekistan Super League）', function () {
  assert.strictEqual(S.autoLeague('Uzbekistan Super League'), '乌兹别克斯坦联赛');
});
t('联赛：-i 词尾还原（Kuwaiti League）', function () {
  assert.strictEqual(S.autoLeague('Kuwaiti League'), '科威特联赛');
});
t('联赛：非国家头部不猜（Icons → 空）', function () {
  assert.strictEqual(S.autoLeague('Icons'), '');
});
t('联赛：非国家头部不猜（Fake League → 空）', function () {
  assert.strictEqual(S.autoLeague('Fake League'), '');
});
t('联赛：已是中文/无尾部词的不动（Premier League 交给包内表）', function () {
  // 规则本身会推出「英格兰联赛」，但实盘用包内表（英格兰超级联赛）——
  // 这里只验证「包内表存在时不走规则」这一优先级由 resolve() 保证（见下方用例）
  assert.strictEqual(S.bundle.LEAGUE_ZH['Premier League'], '英格兰超级联赛');
});

// ---------- 俱乐部（不许机器翻译）----------
t('俱乐部：包内表命中（Hyderabad FC）', function () {
  const r = S.resolve('club', { 'Hyderabad FC': 25 });
  assert.strictEqual(r.done['Hyderabad FC'], '海得拉巴FC');
  assert.strictEqual(r.pending.length, 0);
});
t('俱乐部：未知俱乐部进 pending 且不造译名', function () {
  const r = S.resolve('club', { 'Somewhere United': 3 });
  assert.strictEqual(r.pending.length, 1);
  assert.strictEqual(r.pending[0].en, 'Somewhere United');
  assert.ok(!r.done['Somewhere United']);
});

// ---------- 端到端（resolve）----------
t('resolve：已收录的不进 pending，未收录的按 players 倒序进 pending', function () {
  const r = S.resolve('nation', { 'China PR': 10, 'Kuwait': 2, 'Nowhereland': 5, 'Unknownia': 9 });
  assert.strictEqual(r.done['China PR'], '中国');
  assert.strictEqual(r.done['Kuwait'], '科威特');
  assert.strictEqual(r.pending.length, 2);
  assert.deepStrictEqual(r.pending.map(function (x) { return x.en; }), ['Unknownia', 'Nowhereland']);
});
t('resolve：自动补出来的条目要记录在 autoAdded（好回写增长层）', function () {
  const r = S.resolve('league', { 'Thailand League': 1 });
  // 包内表已有 → 走包内，不算 autoAdded
  assert.strictEqual(r.done['Thailand League'], '泰国联赛');
  assert.strictEqual(Object.keys(r.autoAdded).length, 0);
});

console.log('\nsync_i18n: pass=' + pass + ' fail=' + fail);
if (fail) process.exit(1);
