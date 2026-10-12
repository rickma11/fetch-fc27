// 24h 价格波动 · 离线单测（node 跑，无 wx / 无云依赖）
// 覆盖：
//   - 端上 utils/priceSeries.js#statsOf / buildRows（纯函数）
//   - 数据层 market_core.js#buildSeries（累积 / 滑动 / 同小时幂等 / 新球员 / 离场清理）
//
// 用法：node scripts/price_series_test.js
'use strict';

// 端上模块 require priceStore/format，二者模块加载不触碰 wx（仅函数内用，且有 typeof 守卫）；
// 这里给个最小 stub 以防万一。
global.wx = {
  getStorageSync: function () { return {}; },
  setStorageSync: function () {},
  request: function () {},
  getSystemInfoSync: function () { return { pixelRatio: 2 }; }
};

const priceSeries = require('../../eafc-miniapp/utils/priceSeries.js');
const core = require('./market_core.js');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}
function eq(name, a, b) { ok(name, a === b, 'got ' + JSON.stringify(a) + ' want ' + JSON.stringify(b)); }
function approx(name, a, b, eps) { eps = eps || 1e-6; ok(name, Math.abs(a - b) <= eps, 'got ' + a + ' ~ ' + b); }

console.log('\n=== statsOf ===');
(function () {
  const arr = [];
  for (let i = 100; i <= 123; i++) arr.push(i); // 24 点，单调 +1
  const st = priceSeries.statsOf({ pc: arr, ps: [], buckets: [] }, 'pc');
  eq('has', st.has, true);
  eq('current', st.current, 123);
  eq('prev(满24取首点)', st.prev, 100);
  eq('change', st.change, 23);
  approx('changePct', st.changePct, 23);
  eq('high', st.high, 123);
  eq('low', st.low, 100);
  eq('avg', st.avg, 111.5);
  approx('ampPct', st.ampPct, 20.6271, 1e-3);
  eq('validN', st.validN, 24);
  eq('full', st.full, true);
})();

(function () {
  const st = priceSeries.statsOf({ pc: [200, 210, 190], ps: [], buckets: [] }, 'pc');
  eq('未满: has', st.has, true);
  eq('未满: current', st.current, 190);
  eq('未满: prev=有效首点', st.prev, 200); // 非满不取 arr[0] 作 24h 前
  eq('未满: change', st.change, -10);
  eq('未满: full', st.full, false);
  eq('未满: validN', st.validN, 3);
})();

(function () {
  const st = priceSeries.statsOf({ pc: [null, null], ps: [], buckets: [] }, 'pc');
  eq('全 null → has=false', st.has, false);
})();

(function () {
  const st = priceSeries.statsOf({ pc: [10, 20], ps: [5, 8] }, 'ps');
  eq('ps 平台取 ps 数组', st.current, 8);
  eq('ps 平台 prev', st.prev, 5);
})();

console.log('\n=== buildRows ===');
(function () {
  const rec = { pc: [100, 110, 95, null], ps: [90, 92, 88, 85], buckets: ['202610120100', '202610120200', '202610120300', '202610120400'] };
  const rows = priceSeries.buildRows(rec, 'pc', rec.buckets);
  eq('行数', rows.length, 4);
  eq('首行 dCls=flat', rows[0].dCls, 'flat');
  eq('行标签=小时:00', rows[0].label, '01:00');
  eq('行标签2', rows[1].label, '02:00');
  eq('相对涨: 110 vs 100 → up', rows[1].dCls, 'up');
  approx('行2 dPct', parseFloat(rows[1].dPct), 10.0, 1e-6);
  eq('相对跌: 95 vs 110 → down', rows[2].dCls, 'down');
  eq('null 值 hasVal=false', rows[3].hasVal, false);
  eq('pc 列已格式化(非空串)', typeof rows[0].pc === 'string' && rows[0].pc.length > 0, true);
  eq('ps 列存在', typeof rows[0].ps, 'string');
})();

console.log('\n=== buildSeries ===');
(function () {
  // A: 首跑
  const builtA = { view: { tier: [{ eaId: 1, pc: 100, ps: 90 }] } };
  const sA = core.buildSeries(null, builtA, '202610120100');
  eq('A buckets 长度', sA.buckets.length, 1);
  eq('A buckets[0]', sA.buckets[0], '202610120100');
  eq('A p1.pc', JSON.stringify(sA.players['1'].pc), JSON.stringify([100]));
  eq('A p1.ps', JSON.stringify(sA.players['1'].ps), JSON.stringify([90]));

  // B: 累积（第 2 小时）
  const builtB = { view: { tier: [{ eaId: 1, pc: 110, ps: 95 }] } };
  const sB = core.buildSeries(sA, builtB, '202610120200');
  eq('B buckets 长度', sB.buckets.length, 2);
  eq('B p1.pc 增长', JSON.stringify(sB.players['1'].pc), JSON.stringify([100, 110]));
  eq('B 不位移(未满)', sB.players['1'].pc[0], 100);

  // C: 累积到 24 后滑动窗口（跑满 30 小时）
  let s = null;
  for (let h = 1; h <= 30; h++) {
    const hh = (h < 10 ? '0' + h : '' + h);
    const built = { view: { tier: [{ eaId: 1, pc: h * 10, ps: h * 9 }] } };
    s = core.buildSeries(s, built, '20261012' + hh + '00');
  }
  eq('C buckets 长度固定 24', s.buckets.length, 24);
  eq('C p1.pc 长度 24', s.players['1'].pc.length, 24);
  eq('C 首点=第7小时(70)', s.players['1'].pc[0], 70);
  eq('C 末点=第30小时(300)', s.players['1'].pc[23], 300);

  // D: 同小时重跑幂等（不位移、替换末点）
  const sBefore = JSON.parse(JSON.stringify(s));
  const rebuilt = core.buildSeries(s, { view: { tier: [{ eaId: 1, pc: 999, ps: 888 }] } }, s.buckets[23]);
  eq('D buckets 不变', rebuilt.buckets.length, 24);
  eq('D 末点被替换(非追加)', rebuilt.players['1'].pc[23], 999);
  eq('D 首点不受影响', rebuilt.players['1'].pc[0], sBefore.players['1'].pc[0]);

  // E: 新球员中途加入（满 24 窗口）
  const sFull = core.buildSeries(null, { view: { tier: [{ eaId: 1, pc: 100, ps: 90 }] } }, '202610120100');
  let sE = sFull;
  for (let h = 2; h <= 24; h++) { const hh = (h < 10 ? '0' + h : '' + h); sE = core.buildSeries(sE, { view: { tier: [{ eaId: 1, pc: 100, ps: 90 }] } }, '20261012' + hh + '00'); }
  const sE2 = core.buildSeries(sE, { view: { tier: [{ eaId: 1, pc: 100, ps: 90 }, { eaId: 2, pc: 555, ps: 444 }] } }, '202610122500');
  eq('E 老球员仍 24', sE2.players['1'].pc.length, 24);
  eq('E 新球员长度对齐 24', sE2.players['2'].pc.length, 24);
  eq('E 新球员末点=555', sE2.players['2'].pc[23], 555);
  eq('E 新球员前导 null(23 个)', sE2.players['2'].pc.slice(0, 23).every(function (x) { return x == null; }), true);

  // F: 球员离场 → 补 null；连续 24h 全 null 自动清理
  let sF = core.buildSeries(null, { view: { tier: [{ eaId: 1, pc: 100, ps: 90 }] } }, '202610120100');
  for (let h = 2; h <= 24; h++) { const hh = (h < 10 ? '0' + h : '' + h); sF = core.buildSeries(sF, { view: { tier: [{ eaId: 1, pc: 100, ps: 90 }] } }, '20261012' + hh + '00'); }
  // 之后该球员再不出现，跑 24 次空快照
  let sF2 = sF;
  for (let h = 25; h <= 48; h++) { const hh = (h < 10 ? '0' + h : '' + h); sF2 = core.buildSeries(sF2, { view: { tier: [] } }, '20261012' + hh + '00'); }
  eq('F 离场 24h 后被清理', sF2.players['1'], undefined);
  // 中途未到 24h 时仍保留且末点为 null
  let sF3 = sF;
  sF3 = core.buildSeries(sF3, { view: { tier: [] } }, '202610122500');
  eq('F 仅离场 1h 仍保留', typeof sF3.players['1'], 'object');
  eq('F 末点为 null', sF3.players['1'].pc[23], null);
})();

console.log('\n=== 结果 ===');
console.log('  PASS=' + pass + '  FAIL=' + fail);
process.exit(fail ? 1 : 0);
