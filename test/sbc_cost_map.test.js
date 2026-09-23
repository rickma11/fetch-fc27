// SBC 积分兑换(sbcCost)反查映射单测：`npm test` 会一并执行（2026-09-23）。
// 背景：upload_sbcs.js 的回写反查只认 awards[].playerEaId —— 单人 SBC（Bouaddi 类）能命中，
// 但 Player Pick 类（Duo Pick：awards 只有 other 文案、playerEaId=null，候选在 choicePlayers）
// 反查不到人 → 20000 从未回写 → 候选球员详情页「SBC兑换」整行不渲染（SBC积分行/pill 不受影响）。
// 与 sbc_covers 同一铁律：既要测纯函数，也要测「接线」——主脚本真的用了这个模块。
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { buildSbcCostMap } = require('../scripts/sbc_cost_map');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log('  PASS', name); pass++; }
  catch (e) { console.log('  FAIL', name, '->', e.message); fail++; }
}

const ROOT = path.resolve(__dirname, '..');

// ── fixture（真实形状） ─────────────────────────────────────────────────────
// 单人 SBC（Bouaddi 5257：awards[0].playerEaId 命中）
const singleSbc = {
  id: 5257, name: 'Ayyoub Bouaddi', scoreRequirement: 20000,
  awards: [{ other: null, playerEaId: 50610549, player: { eaId: 50610549 } }]
};
// Player Pick（Duo Pick 5258：awards 只有 other 文案、playerEaId=null，候选在 choicePlayers）
const duoPick = {
  id: 5258, name: 'Ones to Watch Duo Pick 1', scoreRequirement: 20000,
  awards: [{ other: '1 of 2 Ones to Watch Duo Player Pick', playerEaId: null, player: null }],
  choicePlayers: [
    { eaId: 50572598, baseEaId: 240950, overall: 83, name: 'Pedro Gonçalves' },
    { eaId: 50404645, baseEaId: 72997, overall: 83, name: 'Rodrigo Mora' }
  ]
};
// 包类 / 无积分 SBC（Gold Upgrade 形状）
const packSbc = { id: 5254, name: 'Gold Upgrade', scoreRequirement: null, awards: [{ other: 'Gold Pack', playerEaId: null }] };

console.log('纯函数 buildSbcCostMap:');
t('[awards] playerEaId 命中 50610549 → 20000', function () {
  const { map, dup } = buildSbcCostMap([singleSbc]);
  assert.strictEqual(map[50610549], 20000);
  assert.strictEqual(dup.length, 0);
  assert.strictEqual(Object.keys(map).length, 1);
});
t('[choicePlayers] 只特殊卡 eaId 入 map，baseEaId 不入', function () {
  const { map, dup } = buildSbcCostMap([duoPick]);
  assert.strictEqual(map[50572598], 20000);
  assert.strictEqual(map[50404645], 20000);
  assert.strictEqual(map[240950], undefined, '基础卡 240950 不应入 map');
  assert.strictEqual(map[72997], undefined, '基础卡 72997 不应入 map');
  assert.strictEqual(Object.keys(map).length, 2);
  assert.strictEqual(dup.length, 0);
});
t('[choicePlayers] baseEaId 完全忽略（无论是否等于 eaId）', function () {
  const { map } = buildSbcCostMap([{ id: 1, scoreRequirement: 500, awards: [{ playerEaId: null }], choicePlayers: [{ eaId: 123, baseEaId: 123 }, { eaId: 456, baseEaId: 789 }] }]);
  assert.strictEqual(Object.keys(map).length, 2);
  assert.strictEqual(map[123], 500);
  assert.strictEqual(map[456], 500);
  assert.strictEqual(map[789], undefined, 'baseEaId 789 不应入 map');
});
t('[跳过] 无 scoreRequirement / scoreRequirement=0', function () {
  const { map } = buildSbcCostMap([
    { id: 2, scoreRequirement: null, awards: [{ playerEaId: 111 }] },
    { id: 3, scoreRequirement: 0, choicePlayers: [{ eaId: 222 }] }
  ]);
  assert.strictEqual(Object.keys(map).length, 0);
});
t('[跳过] 包类奖励（playerEaId=null 且无 choicePlayers）', function () {
  const { map } = buildSbcCostMap([packSbc]);
  assert.strictEqual(Object.keys(map).length, 0);
});
t('[冲突] 同球员两个不同价 → dup 记录 + 后写覆盖', function () {
  const { map, dup } = buildSbcCostMap([
    { id: 10, scoreRequirement: 1250, awards: [{ playerEaId: 999 }] },
    { id: 11, scoreRequirement: 20000, awards: [{ playerEaId: 999 }] }
  ]);
  assert.strictEqual(map[999], 20000);
  assert.deepStrictEqual(dup, [999]);
});
t('[防御] 无效 eaId（null/0）与 null 候选不炸不入', function () {
  const { map } = buildSbcCostMap([{ id: 12, scoreRequirement: 1000, awards: [{ playerEaId: null }], choicePlayers: [{ eaId: null, baseEaId: 0 }, null] }]);
  assert.strictEqual(Object.keys(map).length, 0);
});
t('[防御] sets 缺失/空 → 空 map 不抛错', function () {
  assert.deepStrictEqual(buildSbcCostMap(null).map, {});
  assert.deepStrictEqual(buildSbcCostMap([]).map, {});
});

console.log('接线（upload_sbcs.js 真的用了新模块）:');
t('upload_sbcs.js require 了 ./sbc_cost_map', function () {
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'upload_sbcs.js'), 'utf8');
  assert.ok(src.includes("require('./sbc_cost_map')"), '缺 require');
});
t('upload_sbcs.js 调用 buildSbcCostMap(sets)', function () {
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'upload_sbcs.js'), 'utf8');
  assert.ok(src.includes('buildSbcCostMap(sets)'), '缺调用');
});
t('旧的内联反查 forEach 已移除（防止双路径漂移）', function () {
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'upload_sbcs.js'), 'utf8');
  assert.ok(!src.includes('costMap[ea] = Number(s.scoreRequirement)'), '旧内联反查还在');
});

console.log('真实 sbcs.json 回归（不写死 SBC id——集合每日变）:');
t('所有带积分的 SBC：奖励/候选球员全部入 map 且值正确', function () {
  const sbcsPath = path.join(ROOT, 'cloud-data', 'fc27', 'sbcs.json');
  if (!fs.existsSync(sbcsPath)) { console.log('  skip 找不到 ' + sbcsPath); return; }
  const sets = JSON.parse(fs.readFileSync(sbcsPath, 'utf8')).sets || [];
  const { map } = buildSbcCostMap(sets);
  let pickSets = 0, awardSets = 0;
  sets.forEach(function (s) {
    const req = Number(s && s.scoreRequirement) || 0;
    if (!req) return;
    if (Array.isArray(s.choicePlayers) && s.choicePlayers.length) {
      pickSets++;
      s.choicePlayers.forEach(function (c) {
        if (!c) return;
        if (c.eaId != null) assert.strictEqual(map[Number(c.eaId)], req, 'pick 候选 ' + c.eaId);
      });
    }
    const ea = (s.awards || []).map(function (a) { return a && a.playerEaId != null ? Number(a.playerEaId) : null; }).filter(function (x) { return x != null; })[0];
    if (ea != null) { awardSets++; assert.strictEqual(map[ea], req, '单人奖励 ' + ea); }
  });
  Object.keys(map).forEach(function (k) { assert.ok(map[k] > 0, 'map 值应 > 0: ' + k); });
  console.log('  统计: pick 组 ' + pickSets + ' / 单人奖励组 ' + awardSets + ' / map 共 ' + Object.keys(map).length + ' 人' + (pickSets === 0 ? '（WARN: 当前无 pick 组，若预期有请检查 enrich_sbc_pools）' : ''));
});

console.log('');
console.log('sbc_cost_map.test: ' + pass + ' 过 / ' + fail + ' 败');
process.exit(fail ? 1 : 0);
