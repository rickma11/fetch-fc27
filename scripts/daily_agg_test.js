// updateDaily 离线覆盖（node scripts/daily_agg_test.js，纯函数无 IO）
// 场景：首跑 / 同日重跑幂等 / 新球员对齐 / 跨日滚动 / 离场球员补 null / 7 日封顶 / avg-min-max 口径
'use strict';
const core = require('./market_core.js');

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.error('  ✗ FAIL: ' + msg); }
}

// 辅助：造一个 series（buckets 覆盖指定北京小时，players 给 pc/ps 数组）
function mkSeries(buckets, players) {
  return { v: 1, ts: Date.now(), buckets: buckets, players: players };
}

// ── 场景 1：首跑（oldDaily=null，series 只有今日 3 个小时）──
console.log('\n[1] 首跑：days=[today]，当日 agg 由今日桶算出');
{
  const buckets = ['202610230900', '202610231000', '202610231100'];
  const series = mkSeries(buckets, { '100': { pc: [100, 200, 300], ps: [null, null, null] } });
  const d = core.updateDaily(null, series, '20261023');
  ok(d.days.length === 1 && d.days[0] === '20261023', 'days=[20261023]');
  ok(JSON.stringify(d.players['100'].pc[0]) === JSON.stringify([200, 100, 300]), 'avg=round(mean)=200,min=100,max=300');
  ok(d.players['100'].ps[0] === null, 'ps 全空 → null');
}

// ── 场景 2：同日重跑幂等（同小时替换最后一点，agg 整体重算）──
console.log('\n[2] 同日重跑：值整体替换、历史不动');
{
  const d1 = core.updateDaily(null, mkSeries(['202610230900', '202610231000', '202610231100'], { '100': { pc: [100, 200, 300], ps: [] } }), '20261023');
  const d2 = core.updateDaily(d1, mkSeries(['202610230900', '202610231000', '202610231100'], { '100': { pc: [100, 200, 999], ps: [] } }), '20261023');
  ok(d2.days.length === 1, 'days 仍为 1');
  ok(JSON.stringify(d2.players['100'].pc[0]) === JSON.stringify([433, 100, 999]), 'agg 重算 avg=round(1299/3)=433');
  ok(d2.players['100'].pc.length === 1, '数组长度=1（未膨胀）');
}

// ── 场景 3：今日桶只取当日，昨日桶不混入 ──
console.log('\n[3] 跨日窗口：昨日桶不计入今日 agg');
{
  const buckets = ['202610222200', '202610222300', '202610230000', '202610230100'];
  const series = mkSeries(buckets, { '100': { pc: [10, 20, 300, 500], ps: [] } });
  const d = core.updateDaily(null, series, '20261023');
  ok(JSON.stringify(d.players['100'].pc[0]) === JSON.stringify([400, 300, 500]), '今日桶 300/500 → avg400,min300,max500（昨日 10/20 不混入）');
}

// ── 场景 4：跨日滚动 + 昨日冻结值保留 ──
console.log('\n[4] 跨日滚动：push 新日、昨日值冻结保留');
{
  const d1 = core.updateDaily(null, mkSeries(['202610230900', '202610231000', '202610231100'], { '100': { pc: [100, 200, 300], ps: [] } }), '20261023');
  const d2 = core.updateDaily(d1, mkSeries(['202610231000', '202610231100', '202610231200', '202610240000', '202610240100'], { '100': { pc: [200, 300, 999, 800, 1000], ps: [] } }), '20261024');
  ok(d2.days.length === 2 && d2.days[1] === '20261024', 'days=[23,24]');
  ok(JSON.stringify(d2.players['100'].pc[0]) === JSON.stringify([200, 100, 300]), '昨日(23)冻结值原样保留');
  ok(JSON.stringify(d2.players['100'].pc[1]) === JSON.stringify([900, 800, 1000]), '今日(24)由 800/1000 两点算出 avg900');
  ok(d2.players['100'].pc.length === 2, '数组长度=2 对齐');
}

// ── 场景 5：新球员对齐（历史列补 null）──
console.log('\n[5] 新球员：历史列前导补 null');
{
  const d1 = core.updateDaily(null, mkSeries(['202610230900'], { '100': { pc: [100], ps: [] } }), '20261023');
  const d2 = core.updateDaily(d1, mkSeries(['202610230900', '202610231000', '202610240000', '202610240100'], { '100': { pc: [100, 100, 200, 200], ps: [] }, '200': { pc: [null, null, 50, 70], ps: [] } }), '20261024');
  ok(d2.players['200'].pc[0] === null, '新球员 200 的 23 日历史格为 null');
  ok(JSON.stringify(d2.players['200'].pc[1]) === JSON.stringify([60, 50, 70]), '新球员 200 今日 avg60');
  ok(d2.players['200'].pc.length === 2, '新球员数组长度=2 对齐');
}

// ── 场景 6：离场球员补 null 保对齐 ──
console.log('\n[6] 离场球员：今日补 null，历史保留');
{
  const d1 = core.updateDaily(null, mkSeries(['202610230900'], { '100': { pc: [100], ps: [] }, '200': { pc: [500], ps: [] } }), '20261023');
  const d2 = core.updateDaily(d1, mkSeries(['202610230900', '202610231000', '202610240000'], { '100': { pc: [100, 100, 200], ps: [] } }), '20261024');
  ok(JSON.stringify(d2.players['200'].pc) === JSON.stringify([[500, 500, 500], null]), '离场球员：昨日保留、今日 null');
}

// ── 场景 7：7 日封顶滚动 ──
console.log('\n[7] 7 日封顶：超 7 天丢最旧');
{
  let d = null;
  for (let day = 20; day <= 28; day++) {
    const key = '202610' + (day < 10 ? '0' + day : day);
    d = core.updateDaily(d, mkSeries([key + '0900'], { '100': { pc: [day * 10], ps: [] } }), key);
  }
  ok(d.days.length === 7, 'days 长度=7');
  ok(d.days[0] === '20261022' && d.days[6] === '20261028', '滚动后=[22..28]');
  ok(JSON.stringify(d.players['100'].pc[0]) === JSON.stringify([220, 220, 220]), '最旧格=22 日（10-20/21 已丢）');
  ok(JSON.stringify(d.players['100'].pc[6]) === JSON.stringify([280, 280, 280]), '最新格=28 日');
}

console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
