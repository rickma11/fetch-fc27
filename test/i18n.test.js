// 「译名对账」单测：`npm test` 会一并执行
//
// 新模型（2026-09-19）：
//   ① 包内表（i18n-bundle.json，由 miniapp utils/i18n.js 生成）是主要来源；
//   ② i18n-names.json 增长层覆盖包内；
//   ③ Gitee basic（OAO-evotrans/miniapp-dictionaries.json）补齐「包内表未收录」的未翻译项；
//   ④ 包内表未收录且无 Gitee basic 条目的 → 直接展示英文（进 pending），不再机器翻译。
const assert = require('assert');
const S = require('../scripts/sync_i18n.js');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log('  PASS', name); pass++; }
  catch (e) { console.log('  FAIL', name, '->', e.message); fail++; }
}

console.log('译名对账 (sync_i18n)');

// ---------- 包内表命中 ----------
t('国家：包内表命中（China PR）', function () {
  assert.strictEqual(S.resolve('nation', { 'China PR': 1 }).done['China PR'], '中国');
});
t('国家：包内表合规（中国台湾 / 中国香港 / 中国澳门）', function () {
  const d = S.resolve('nation', { 'Chinese Taipei': 1, 'Hong Kong': 1, 'Macao': 1 }).done;
  assert.strictEqual(d['Chinese Taipei'], '中国台湾');
  assert.strictEqual(d['Hong Kong'], '中国香港');
  assert.strictEqual(d['Macao'], '中国澳门');
});
t('联赛：包内表命中（Premier League）', function () {
  assert.strictEqual(S.bundle.LEAGUE_ZH['Premier League'], '英格兰超级联赛');
});
t('俱乐部：包内表命中（Hyderabad FC）', function () {
  assert.strictEqual(S.resolve('club', { 'Hyderabad FC': 25 }).done['Hyderabad FC'], '海得拉巴FC');
  assert.strictEqual(S.resolve('club', { 'Hyderabad FC': 25 }).pending.length, 0);
});

// ---------- 不再机器翻译：未收录且无 basic → 进 pending 显示英文 ----------
t('国家：未收录且无 basic → 进 pending 不造译名', function () {
  const r = S.resolve('nation', { 'Neverland': 3 });
  assert.strictEqual(r.pending.length, 1);
  assert.strictEqual(r.pending[0].en, 'Neverland');
  assert.ok(!r.done['Neverland']);
});
t('俱乐部：未知俱乐部进 pending 且不造译名', function () {
  const r = S.resolve('club', { 'Somewhere United': 3 });
  assert.strictEqual(r.pending.length, 1);
  assert.strictEqual(r.pending[0].en, 'Somewhere United');
  assert.ok(!r.done['Somewhere United']);
});
t('联赛：<国家> League 型不再自动推导（Korean League 不在包内且无 basic → 进 pending）', function () {
  // Thailand League 在包内表 → 命中
  assert.strictEqual(S.resolve('league', { 'Thailand League': 1 }).done['Thailand League'], '泰国联赛');
  // Korean League 不在包内表（测试态 basic 为空）→ 进 pending，不推导出「韩国联赛」
  const r = S.resolve('league', { 'Korean League': 1 });
  assert.ok(!r.done['Korean League']);
  assert.strictEqual(r.pending.length, 1);
  assert.strictEqual(r.pending[0].en, 'Korean League');
});

// ---------- Gitee basic 集成 ----------
t('parseGiteeBasic：basic 段 {name:{webpagedata}} 提取全称', function () {
  const m = S.parseGiteeBasic({ basic: { 'China': { webpagedata: '中国' }, 'Hengda FC': { webpagedata: '恒大' } } });
  assert.strictEqual(m.zh['China'], '中国');
  assert.strictEqual(m.zh['Hengda FC'], '恒大');
});
t('parseGiteeBasic：兼容值为纯字符串（仅全称）', function () {
  const m = S.parseGiteeBasic({ basic: { 'USA': '美国' } });
  assert.strictEqual(m.zh['USA'], '美国');
  assert.strictEqual(Object.keys(m.short).length, 0);
});
t('parseGiteeBasic：basic 段 {name:{webpagedata, short}} 提取简称', function () {
  const m = S.parseGiteeBasic({ basic: { 'League 2273': { webpagedata: '冰女超', short: '冰女超' }, 'Icelandic Super Cup': { webpagedata: '冰超杯', short: '冰超杯' } } });
  assert.strictEqual(m.zh['League 2273'], '冰女超');
  assert.strictEqual(m.short['League 2273'], '冰女超');
  assert.strictEqual(m.short['Icelandic Super Cup'], '冰超杯');
});
t('buildMaps：Gitee basic 仅填未翻译（不覆盖包内）', function () {
  const maps = S.buildMaps({ 'Korean League': '韩国联赛', 'China PR': '错误' });
  assert.strictEqual(maps.leagueZh['Korean League'], '韩国联赛'); // 未翻译被补齐
  assert.strictEqual(maps.nationZh['China PR'], '中国');          // 包内优先，不覆盖
});
t('buildMaps：Gitee basic short 仅填 leagueShort 缺口', function () {
  const maps = S.buildMaps({ zh: {}, short: { 'League 2273': '冰女超' } });
  assert.strictEqual(maps.leagueShort['League 2273'], '冰女超');
});
t('buildMaps：Gitee basic short 不覆盖增长层/包内 leagueShort', function () {
  // Premier League 在包内表 LEAGUE_SHORT_ZH 已有简称「英超」，Gitee short 不能覆盖
  const maps = S.buildMaps({ zh: {}, short: { 'Premier League': '英超XX' } });
  assert.notStrictEqual(maps.leagueShort['Premier League'], '英超XX');
  assert.ok(maps.leagueShort['Premier League']);
});
t('resolve：Gitee basic 命中即出中文（Korean League）', function () {
  const maps = S.buildMaps({ 'Korean League': '韩国联赛' });
  const r = S.resolve('league', { 'Korean League': 1 }, maps);
  assert.strictEqual(r.done['Korean League'], '韩国联赛');
  assert.strictEqual(r.pending.length, 0);
});
t('resolve：Gitee basic 无条目 → 进 pending', function () {
  const maps = S.buildMaps({});
  const r = S.resolve('league', { 'Uzbekistan Super League': 1 }, maps);
  assert.ok(!r.done['Uzbekistan Super League']);
  assert.strictEqual(r.pending.length, 1);
});

console.log('\nsync_i18n: pass=' + pass + ' fail=' + fail);
if (fail) process.exit(1);
