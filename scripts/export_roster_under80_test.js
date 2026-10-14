// export_roster_under80_test.js —— 纯函数 filterUnder80 / project 的单元测试。
// 不依赖任何 IO（不读云库、不读本地文件），只验证过滤口径与投影。
'use strict';

const assert = require('assert');
const { filterUnder80, project, MAX_RATING } = require('./export_roster_under80.js');

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log('  ✓ ' + name);
}

// 构造样本：含 80+（应排除）、79/75/45（应入选）、缺字段、边界值
const SAMPLE = [
  { eaId: 1, commonName: 'Top80', overall: 80, position: 'ST', imagePath: 'a', rarity: { name: 'Gold' } },     // 边界：80 排除
  { eaId: 2, commonName: 'Edge79', overall: 79, position: 'CM', imagePath: 'b', rarity: { name: 'Gold' } },     // 边界：79 入选
  { eaId: 3, commonName: 'Mid75', overall: 75, position: 'CB', imagePath: 'c', rarity: { name: 'Silver' } },
  { eaId: 4, commonName: 'Bronze45', overall: 45, position: 'GK', imagePath: 'd', rarity: { name: 'Bronze' } }, // 青铜档也应入选（探针实测全员有价）
  { eaId: 5, commonName: 'NoOverall', overall: undefined, position: 'LM', imagePath: 'e' },                      // overall 缺失：按 0 处理 ⇒ 入选
  { eaId: 6, commonName: 'NameFallback', overall: 70, position: 'RW', imagePath: '', rarity: null },             // 无 rarity、无 commonName 仅 name
  { eaId: 7, name: 'PureName', overall: 60, position: 'CDM' }                                                  // 无 commonName，退 name
];

check('MAX_RATING === 79（与 83plus 的 80 互补、无重叠）', () => {
  assert.strictEqual(MAX_RATING, 79);
});

check('过滤：仅 overall<=79 入选，80 被排除', () => {
  const out = filterUnder80(SAMPLE);
  const ids = out.map(p => p.eaId).sort((a, b) => a - b);
  assert.deepStrictEqual(ids, [2, 3, 4, 5, 6, 7]); // 不含 1（overall=80）
  assert.ok(!out.some(p => p.eaId === 1), '80+ 不应入选');
});

check('边界：79 入选、80 排除', () => {
  const out = filterUnder80([{ eaId: 9, overall: 79 }, { eaId: 10, overall: 80 }]);
  assert.deepStrictEqual(out.map(p => p.eaId), [9]);
});

check('排序：按 overall 降序（不丢人）', () => {
  const out = filterUnder80(SAMPLE);
  for (let i = 1; i < out.length; i++) {
    assert.ok(out[i - 1].overall >= out[i].overall, '降序破坏于 ' + i + ': ' + out[i - 1].overall + ' -> ' + out[i].overall);
  }
  // 第一条应为 79（Edge79）
  assert.strictEqual(out[0].eaId, 2);
});

check('投影字段完整：6 字段齐全', () => {
  const out = filterUnder80(SAMPLE);
  out.forEach(p => {
    assert.ok('eaId' in p && 'name' in p && 'overall' in p && 'pos' in p && 'imagePath' in p && 'rarity' in p,
      '字段缺失: ' + JSON.stringify(p));
  });
});

check('name 回退：commonName 优先，无则退 name', () => {
  const out = filterUnder80(SAMPLE);
  // 样本 6 有 commonName ⇒ 优先
  const p6 = out.find(p => p.eaId === 6);
  assert.strictEqual(p6.name, 'NameFallback');
  assert.strictEqual(p6.rarity, '');   // rarity:null ⇒ 空串
  assert.strictEqual(p6.imagePath, ''); // 空串保留
  // 样本 7 无 commonName ⇒ 退 name
  const p7 = out.find(p => p.eaId === 7);
  assert.strictEqual(p7.name, 'PureName');
});

check('overall 缺失按 0 ⇒ 入选（0<=79）', () => {
  const out = filterUnder80(SAMPLE);
  assert.ok(out.some(p => p.eaId === 5), 'overall 缺失应入选');
  assert.strictEqual(out.find(p => p.eaId === 5).overall, 0);
});

check('空输入 ⇒ 空数组（纯函数不抛）', () => {
  assert.deepStrictEqual(filterUnder80([]), []);
});

check('大数量级不溢出：注入 2 万条过滤后量级正确', () => {
  const big = [];
  for (let i = 0; i < 20000; i++) {
    big.push({ eaId: 100000 + i, overall: (i % 100) < 50 ? 78 : 82, position: 'ST' });
  }
  const out = filterUnder80(big);
  // 约半数（overall<80 的 50 组 = 10000）入选
  assert.ok(out.length >= 9000 && out.length <= 11000, '期望≈10000，实际 ' + out.length);
  assert.ok(out.every(p => p.overall <= 79), '仍有 80+ 混入');
});

check('project 独立验证（与 filterUnder80 投影一致）', () => {
  const p = project({ eaId: 11, commonName: 'X', overall: 65, position: 'LB', imagePath: 'z', rarity: { name: 'Silver' } });
  assert.deepStrictEqual(p, { eaId: 11, name: 'X', overall: 65, pos: 'LB', imagePath: 'z', rarity: 'Silver' });
});

console.log('\n[export_roster_under80_test] 全部 ' + passed + ' 断言通过 ✅');
