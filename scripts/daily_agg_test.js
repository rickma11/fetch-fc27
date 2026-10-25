// updateDaily 离线覆盖（node scripts/daily_agg_test.js，纯函数无 IO）
// 场景：首跑 / 同日重跑幂等 / 新球员对齐 / 跨日滚动 / 离场球员补 null / 14 日封顶 / avg-min-max 口径
// ⚠️ 2026-10-25：DAILY_KEEP_DAYS 7→14（市场概览 14 日窗口，用户拍板；docs/37 §5），场景 7 同步改 14。
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

// ── 场景 7：14 日封顶滚动（2026-10-25 起 DAILY_KEEP_DAYS=14）──
console.log('\n[7] 14 日封顶：超 14 天丢最旧');
{
  let d = null;
  for (let day = 10; day <= 33; day++) {
    const key = '202610' + (day < 10 ? '0' + day : day);
    d = core.updateDaily(d, mkSeries([key + '0900'], { '100': { pc: [day * 10], ps: [] } }), key);
  }
  ok(d.days.length === 14, 'days 长度=14');
  ok(d.days[0] === '20261020' && d.days[13] === '20261033', '滚动后=[20..33]');
  ok(JSON.stringify(d.players['100'].pc[0]) === JSON.stringify([200, 200, 200]), '最旧格=20 日（10-10..19 已丢）');
  ok(JSON.stringify(d.players['100'].pc[13]) === JSON.stringify([330, 330, 330]), '最新格=33 日');
}

// ── 场景 9：同日重跑（days≥2）不得把上一小时今日残留当昨日列（2026-10-25 bug 修复回归）──
console.log('\n[9] 同日重跑（多日历史）：剥掉今日残留，历史列不错位');
{
  const d1 = core.updateDaily(null, mkSeries(['202610240900', '202610241000'], { '100': { pc: [100, 110], ps: [] } }), '20261024');
  ok(JSON.stringify(d1.players['100'].pc[0]) === JSON.stringify([105, 100, 110]), '24 日首行 avg=105');
  const d2 = core.updateDaily(d1, mkSeries(['202610240900', '202610241000', '202610241100'], { '100': { pc: [100, 110, 130], ps: [] } }), '20261024');
  ok(d2.days.length === 1 && JSON.stringify(d2.players['100'].pc[0]) === JSON.stringify([113, 100, 130]), '同日重跑(days=1)：值重算 113、不膨胀');
  // 跨到 25 日首跑：days=[24,25]，昨日(24)冻结保留
  const d3 = core.updateDaily(d2, mkSeries(['202610250000', '202610250100'], { '100': { pc: [200, 210], ps: [] } }), '20261025');
  ok(d3.days.length === 2 && JSON.stringify(d3.players['100'].pc[0]) === JSON.stringify([113, 100, 130]), '跨日：days=[24,25]，昨日列=24 日冻结值');
  // 25 日同日第二次跑（历史 2 天）：上一小时今日残留必须剥掉，不得占「昨日」格
  const d4 = core.updateDaily(d3, mkSeries(['202610250000', '202610250100', '202610250200'], { '100': { pc: [200, 210, 240], ps: [] } }), '20261025');
  ok(d4.days.length === 2, 'days 仍为 [24,25]（不膨胀）');
  ok(JSON.stringify(d4.players['100'].pc[0]) === JSON.stringify([113, 100, 130]), '回归：昨日列仍是 24 日冻结值（不是 25 日残留 205）');
  ok(JSON.stringify(d4.players['100'].pc[1]) === JSON.stringify([217, 200, 240]), '今日列=avg(200,210,240)=217');
  ok(d4.players['100'].pc.length === 2, '数组长度=2（未膨胀）');
  // 连续多轮同日重跑：历史列始终稳定
  const d5 = core.updateDaily(d4, mkSeries(['202610250000', '202610250100', '202610250200', '202610250300'], { '100': { pc: [200, 210, 240, 300], ps: [] } }), '20261025');
  ok(JSON.stringify(d5.players['100'].pc[0]) === JSON.stringify([113, 100, 130]), '再跑一轮：昨日列仍稳定');
  ok(JSON.stringify(d5.players['100'].pc[1]) === JSON.stringify([238, 200, 300]), '今日列更新为 avg(200,210,240,300)=238');
}

console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
