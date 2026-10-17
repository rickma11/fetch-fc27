// slim 快照（方案 C）单测：投影字段 / 重放 roundtrip / 缺员补 null / 体积上界 / 全 null 清理
// 运行：node scripts/under80_slim_test.js
const core = require('./market_core.js');

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? ' | ' + extra : '')); }
}

// ── 1) slimSnapshot 只投影 eaId/pc/ps ──
const built = {
  ts: 111,
  view: {
    v: 1, ts: 111,
    tier: [
      { eaId: 1001, name: 'A', overall: 79, pos: 'ST', pc: 1200, ps: 1100, img: 'cloud://x', rarity: 'gold' },
      { eaId: 1002, name: 'B', overall: 78, pos: 'CM', pc: null, ps: 900, img: 'cloud://y', rarity: 'silver' },
      { eaId: 1003, name: 'C', overall: 77, pos: 'CB', pc: 500, ps: null, img: 'cloud://z', rarity: 'bronze' }
    ]
  }
};
const snap = core.slimSnapshot(built);
ok(snap.v === 1 && snap.ts === 111, '快照带 v/ts');
ok(snap.tier.length === 3, 'tier 条数=3', 'got ' + snap.tier.length);
ok(Object.keys(snap.tier[0]).sort().join(',') === 'eaId,pc,ps', '条目只含 eaId/pc/ps 三字段', 'got ' + Object.keys(snap.tier[0]).sort().join(','));
ok(snap.tier[1].pc === null && snap.tier[1].ps === 900, 'null 价如实保留（不写 0）');
ok(snap.tier[2].pc === 500 && snap.tier[2].ps === null, '单平台价如实保留');

// ── 2) roundtrip：快照可直接喂 buildSeries，值与原始一致 ──
const s1 = core.buildSeries(null, { view: { tier: snap.tier } }, '202610171400');
ok(s1.buckets.length === 1 && s1.buckets[0] === '202610171400', '首帧桶正确');
ok(Object.keys(s1.players).length === 3, '重放球员数=3');
ok(s1.players['1001'].pc[0] === 1200 && s1.players['1001'].ps[0] === 1100, '1001 价格 roundtrip 一致');
ok(s1.players['1002'].pc[0] === null && s1.players['1002'].ps[0] === 900, '1002 null/单平台 roundtrip 一致');
ok(s1.players['1003'].pc.length === 1 && s1.players['1003'].ps.length === 1, '数组与桶数对齐');

// ── 3) 多小时重放 + 缺员补 null（保持连续性）──
const snap2 = core.slimSnapshot({
  ts: 222, view: { tier: [
    { eaId: 1001, pc: 1250, ps: 1150 },
    { eaId: 1004, pc: 300, ps: null }   // 1002/1003 本小时缺席
  ] }
});
const s2 = core.buildSeries(s1, { view: { tier: snap2.tier } }, '202610171500');
ok(s2.buckets.length === 2, '第二帧后桶数=2');
ok(s2.players['1001'].pc.join(',') === '1200,1250', '1001 追加新点');
ok(s2.players['1002'].pc.join(',') === ',', '1002 缺席补 null（pc 全 null）', JSON.stringify(s2.players['1002'].pc));
ok(s2.players['1003'].ps[1] === null, '1003 缺席补 null（ps 末位 null）');
ok(s2.players['1004'].pc.length === 2 && s2.players['1004'].pc[0] === null && s2.players['1004'].pc[1] === 300, '新球员前导 null 对齐', JSON.stringify(s2.players['1004'].pc));

// ── 4) 同小时重跑替换最后一点（不位移）──
const snap2b = core.slimSnapshot({ ts: 222, view: { tier: [{ eaId: 1001, pc: 1260, ps: 1160 }] } });
const s2b = core.buildSeries(s1, { view: { tier: snap2b.tier } }, '202610171500');
ok(s2b.buckets.length === 2, '同小时追加后桶数=2');
const s2c = core.buildSeries(s2b, { view: { tier: snap2b.tier } }, '202610171500');
ok(s2c.buckets.length === 2 && s2c.players['1001'].pc.join(',') === '1200,1260', '同小时重跑替换末点不位移', JSON.stringify(s2c.players['1001'].pc));

// ── 5) 全 null 24h 清理（离场球员：首帧即无价，之后 23h 持续缺席 ⇒ 24 点全 null）──
let s5 = core.buildSeries(null, { view: { tier: [{ eaId: 2001, pc: null, ps: null }] } }, '202610170000');
for (let h = 1; h < 24; h++) {
  const b = '20261017' + String(h).padStart(2, '0') + '00';
  s5 = core.buildSeries(s5, { view: { tier: [] } }, b); // 之后每小时都缺席 ⇒ 补 null
}
ok(s5.buckets.length === 24, '满 24 桶');
ok(!s5.players['2001'], '连续 24h 全 null 的球员被清理', JSON.stringify(s5.players['2001']));

// ── 5b) 有真实成交过的球员不会被误清理（pc 全 null 但 ps 有值）──
let s5b = core.buildSeries(null, { view: { tier: [{ eaId: 2002, pc: null, ps: 900 }] } }, '202610170000');
for (let h = 1; h < 24; h++) {
  const b = '20261017' + String(h).padStart(2, '0') + '00';
  s5b = core.buildSeries(s5b, { view: { tier: [] } }, b);
}
ok(!!s5b.players['2002'], 'ps 有成交的球员保留（pc 全 null 不清洗）');

// ── 6) 体积上界：18680 人 slim < 700KB（实测 0.52MB，留 35% 余量）──
const big = [];
for (let i = 0; i < 18680; i++) big.push({ eaId: 200000 + i, pc: 300 + (i % 900), ps: 250 + (i % 700) });
const bigSnap = core.slimSnapshot({ ts: 1, view: { tier: big } });
const kb = Buffer.byteLength(JSON.stringify(bigSnap)) / 1024;
ok(kb < 700, '18680 人 slim 快照 < 700KB', kb.toFixed(0) + 'KB');

console.log('\n结果: ' + pass + ' 过 / ' + fail + ' 挂');
process.exit(fail ? 1 : 0);
