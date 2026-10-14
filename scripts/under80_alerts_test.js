// 80↓ 异动榜 · 离线单测（node 跑，无云依赖）
// 覆盖：
//   - market_core.js#build 的 minRating 参数（默认 80+ / minRating=0 含 sub-80）
//   - market_core.js#computeUnder80Alerts（分组均值 / above / move 双筛选 / recent 内联 / 空序列 / 排序）
//
// 用法：node scripts/under80_alerts_test.js
'use strict';

const core = require('./market_core.js');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}
function eq(name, a, b) { ok(name, a === b, 'got ' + JSON.stringify(a) + ' want ' + JSON.stringify(b)); }
function approx(name, a, b, eps) { eps = eps || 1e-6; ok(name, Math.abs(a - b) <= eps, 'got ' + a + ' ~ ' + b); }
function has(name, arr, val) { ok(name, arr.indexOf(val) >= 0, 'arr=' + JSON.stringify(arr)); }

console.log('\n=== build(minRating) ===');
(function () {
  const roster = [
    { eaId: 1, name: 'P79', overall: 79, pos: 'ST', imagePath: 'a', rarity: 'r' },
    { eaId: 2, name: 'P80', overall: 80, pos: 'ST', imagePath: 'b', rarity: 'r' },
    { eaId: 3, name: 'P85', overall: 85, pos: 'MF', imagePath: 'c', rarity: 'r' }
  ];
  const cur = { '1': [100, 90], '2': [200, 180], '3': [300, 280] };

  // 默认（不传 minRating）→ 仅 80+（overall>=80）
  const bDef = core.build(roster, cur, {}, 't');
  eq('默认: tier 仅含 80+', bDef.view.tier.length, 2);
  eq('默认: tier 不含 79', bDef.view.tier.filter(t => t.eaId === 1).length, 0);
  eq('默认: 含 80 与 85', bDef.view.tier.filter(t => t.eaId === 2 || t.eaId === 3).length, 2);

  // minRating=0 → 整批 sub-80 + 80+ 全进 tier
  const bAll = core.build(roster, cur, {}, 't', undefined, 0);
  eq('minRating=0: tier 含全部 3 人', bAll.view.tier.length, 3);
  eq('minRating=0: 含 79', bAll.view.tier.filter(t => t.eaId === 1).length, 1);

  // minRating=80 显式 == 默认行为
  const b80 = core.build(roster, cur, {}, 't', undefined, 80);
  eq('minRating=80: 同默认', b80.view.tier.length, 2);
})();

console.log('\n=== computeUnder80Alerts: 分组均值 + above 筛选 ===');
(function () {
  // 8 小时桶
  const buckets = [];
  for (let h = 1; h <= 8; h++) { const hh = (h < 10 ? '0' + h : '' + h); buckets.push('20261012' + hh + '00'); }
  // overall 70 组：'1' 末价 300（明显偏高），'2''3' 末价 100（正常）
  // overall 60 组：'4' 末价 200 且有 100% 近 6h 涨幅，'5' 末价 200 恒定
  const players = {
    '1': { pc: [100, 100, 100, 100, 100, 100, 100, 300], ps: [100, 100, 100, 100, 100, 100, 100, 100] },
    '2': { pc: [100, 100, 100, 100, 100, 100, 100, 100], ps: [100, 100, 100, 100, 100, 100, 100, 100] },
    '3': { pc: [100, 100, 100, 100, 100, 100, 100, 100], ps: [100, 100, 100, 100, 100, 100, 100, 100] },
    '4': { pc: [100, 100, 100, 100, 100, 100, 100, 200], ps: [100, 100, 100, 100, 100, 100, 100, 100] },
    '5': { pc: [200, 200, 200, 200, 200, 200, 200, 200], ps: [200, 200, 200, 200, 200, 200, 200, 200] }
  };
  const rosterMap = {
    '1': { name: 'A', overall: 70, pos: 'ST', imagePath: 'a', rarity: 'g' },
    '2': { name: 'B', overall: 70, pos: 'ST', imagePath: '', rarity: '' },
    '3': { name: 'C', overall: 70, pos: 'ST', imagePath: '', rarity: '' },
    '4': { name: 'D', overall: 60, pos: 'MF', imagePath: '', rarity: '' },
    '5': { name: 'E', overall: 60, pos: 'MF', imagePath: '', rarity: '' }
  };
  const series = { v: 1, ts: Date.now(), buckets: buckets, players: players };
  const out = core.computeUnder80Alerts(series, rosterMap, { MARGIN: 1.5, MOVE_PCT: 30, WINDOW: 6, RECENT: 12 });

  // 组 70：mean = (300+100+100)/3 = 166.67；组 60：mean = (200+200)/2 = 200
  eq('组70均值', out.alerts.find(a => a.eaId === '1').meanPc, 167); // Math.round(166.67)
  eq('组60均值', out.alerts.find(a => a.eaId === '4') && out.alerts.find(a => a.eaId === '4').meanPc, 200);

  const a1 = out.alerts.find(a => a.eaId === '1');
  ok('A(300): 因 above 入选', a1 && a1.flags.indexOf('abovePc') >= 0, JSON.stringify(a1 && a1.flags));
  const a2 = out.alerts.find(a => a.eaId === '2');
  ok('B(100): 未入选（无 above 无 move）', !a2);
  const a4 = out.alerts.find(a => a.eaId === '4');
  ok('D: 因 6h 涨幅100% 入选 movePc', a4 && a4.flags.indexOf('movePc') >= 0, JSON.stringify(a4 && a4.flags));
  ok('D: 非 above（200/200=1.0<1.5）', a4 && a4.flags.indexOf('abovePc') < 0);
  const a5 = out.alerts.find(a => a.eaId === '5');
  ok('E(200恒定): 未入选', !a5);

  // recent 内联长度（L=8 < RECENT=12 ⇒ 取全部 8）
  ok('A recent.pc 长度=8（与 buckets 对齐）', a1 && a1.recent.pc.length === 8 && a1.recent.buckets.length === 8);
  eq('A recent.pc 末位=300', a1 && a1.recent.pc[7], 300);
})();

console.log('\n=== computeUnder80Alerts: 排序（overall 降序 → 异动强度降序）===');
(function () {
  const buckets = [];
  for (let h = 1; h <= 8; h++) { const hh = (h < 10 ? '0' + h : '' + h); buckets.push('20261012' + hh + '00'); }
  // 70 组一个明显偏高（ratio 2.0）；60 组一个明显偏高（ratio 2.0）→ 70 应排前面
  const players = {
    '1': { pc: [100, 100, 100, 100, 100, 100, 100, 200], ps: [100, 100, 100, 100, 100, 100, 100, 100] }, // 70 组
    '2': { pc: [50, 50, 50, 50, 50, 50, 50, 100], ps: [50, 50, 50, 50, 50, 50, 50, 50] }                 // 60 组
  };
  const rosterMap = {
    '1': { name: 'A', overall: 70, pos: 'ST', imagePath: '', rarity: '' },
    '2': { name: 'B', overall: 60, pos: 'MF', imagePath: '', rarity: '' }
  };
  const series = { v: 1, ts: Date.now(), buckets: buckets, players: players };
  const out = core.computeUnder80Alerts(series, rosterMap, { MARGIN: 1.5, MOVE_PCT: 90, WINDOW: 6, RECENT: 12 });
  eq('入选数', out.alerts.length, 2);
  eq('首位 overall=70', out.alerts[0].overall, 70);
  eq('末位 overall=60', out.alerts[1].overall, 60);
})();

console.log('\n=== computeUnder80Alerts: 空序列 / 当前无价 / rosterMap 缺失 ===');
(function () {
  // 空 buckets
  const out0 = core.computeUnder80Alerts({ v: 1, ts: Date.now(), buckets: [], players: {} }, {}, {});
  eq('空序列 count=0', out0.count, 0);

  const buckets = ['202610120100', '202610120200'];
  // 球员当前价全 null（无价）→ 跳过
  const players = { '1': { pc: [null, null], ps: [null, null] } };
  const out1 = core.computeUnder80Alerts({ v: 1, ts: Date.now(), buckets: buckets, players: players },
    { '1': { name: 'X', overall: 70, pos: '', imagePath: '', rarity: '' } }, {});
  eq('当前无价 → count=0', out1.count, 0);

  // rosterMap 缺失该 eaId → overall 归 0，仍能被处理（均值按 overall=0 分组）
  const players2 = { '9': { pc: [100, 200], ps: [100, 200] } };
  const out2 = core.computeUnder80Alerts({ v: 1, ts: Date.now(), buckets: buckets, players: players2 }, {}, { MARGIN: 1.5, MOVE_PCT: 30, WINDOW: 6, RECENT: 12 });
  // overall=0 组只有自己，mean=200 → ratio=1.0 <1.5；6h change (200 vs 100)=100% → movePc 入选
  ok('rosterMap 缺失 → 仍能按 overall=0 处理并判 move', out2.count === 1 && out2.alerts[0].flags.indexOf('movePc') >= 0);
})();

console.log('\n=== computeUnder80Alerts: recent 滑窗截断（L>RECENT）===');
(function () {
  const n = 20;
  const buckets = [];
  for (let h = 1; h <= n; h++) { const hh = (h < 10 ? '0' + h : '' + h); buckets.push('20261012' + hh + '00'); }
  const pc = []; for (let h = 1; h <= n; h++) pc.push(h * 10);
  const players = { '1': { pc: pc, ps: pc } };
  const rosterMap = { '1': { name: 'A', overall: 70, pos: '', imagePath: '', rarity: '' } };
  const series = { v: 1, ts: Date.now(), buckets: buckets, players: players };
  const out = core.computeUnder80Alerts(series, rosterMap, { MARGIN: 1.5, MOVE_PCT: 30, WINDOW: 6, RECENT: 12 });
  eq('L=20 > RECENT=12 → recent 取末 12', out.alerts[0].recent.pc.length, 12);
  eq('recent 末位=200', out.alerts[0].recent.pc[11], 200);
})();

console.log('\n=== 结果 ===');
console.log('  PASS=' + pass + '  FAIL=' + fail);
process.exit(fail ? 1 : 0);
