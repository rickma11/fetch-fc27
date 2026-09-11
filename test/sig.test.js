// 签名与差异归类单测：`npm test`
// 这两块逻辑决定了增量抓取「哪些卡需要重抓」，一旦判断错，要么漏更新、要么退化成全量。
const assert = require('assert');
const { sigOfRaw, diffSigs } = require('../scripts/sig');

function item(eaId, extra) {
  return Object.assign({
    eaId: eaId, overall: 90, position: 'ST', skillMoves: 4, weakFoot: 4,
    accelerateType: 'Explosive', height: 180, weight: 75, foot: 'Right',
    bodytypeCode: 'Lean', isRealFace: true, shirtNumber: 9,
    rarity: { name: 'Icon' }, club: { name: 'Man Utd' }, league: { name: 'PL' }, nation: { name: 'Portugal' },
    cardImagePath: 'a_card.png', createdAt: '2026-09-01T00:00:00Z',
    playStyleEaIds: [2, 1], playStylePlusEaIds: [3],
    chemistryRolesPlusEaIds: [10], chemistryRolesPlusPlusEaIds: [11], alternativePositionIds: [25],
    faceStats: { pace: 90, shooting: 88, passing: 80, dribbling: 85, defending: 40, physicality: 70 }
  }, extra || {});
}

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log('  PASS', name); pass++; }
  catch (e) { console.log('  FAIL', name, '->', e.message); fail++; }
}

console.log('签名稳定性:');
t('同一对象重复计算签名一致', function () {
  assert.strictEqual(sigOfRaw(item(1)), sigOfRaw(item(1)));
});
t('faceStats 变化 → 签名变化', function () {
  const b = item(1, { faceStats: { pace: 91, shooting: 88, passing: 80, dribbling: 85, defending: 40, physicality: 70 } });
  assert.notStrictEqual(sigOfRaw(item(1)), sigOfRaw(b));
});
t('联赛变化 → 签名变化', function () {
  assert.notStrictEqual(sigOfRaw(item(1)), sigOfRaw(item(1, { league: { name: 'LaLiga' } })));
});
t('化学角色数组顺序不同 → 签名一致（内部已排序）', function () {
  assert.strictEqual(sigOfRaw(item(1, { chemistryRolesPlusEaIds: [11, 10] })), sigOfRaw(item(1, { chemistryRolesPlusEaIds: [10, 11] })));
});
t('化学角色内容变化 → 签名变化', function () {
  assert.notStrictEqual(sigOfRaw(item(1, { chemistryRolesPlusEaIds: [10, 12] })), sigOfRaw(item(1, { chemistryRolesPlusEaIds: [10, 11] })));
});
t('无关字段（社交图）变化 → 签名不变', function () {
  assert.strictEqual(sigOfRaw(item(1, { socialImagePath: 'x.png' })), sigOfRaw(item(1)));
});
t('签名格式为 16 位十六进制', function () {
  assert.ok(/^[0-9a-f]{16}$/.test(sigOfRaw(item(1))));
});

console.log('差异归类:');
t('新增/变化/未变/下架 全部识别正确', function () {
  const a = item(1), b = item(2), c = item(3);
  const snap = { 1: sigOfRaw(a), 2: sigOfRaw(b), 3: sigOfRaw(c) };
  const sigs = {
    1: sigOfRaw(a),                        // 未变
    2: sigOfRaw(item(2, { overall: 99 })), // 变化
    4: sigOfRaw(item(4))                   // 新增（3 消失）
  };
  const d = diffSigs(snap, sigs);
  assert.deepStrictEqual(d.newIds, ['4']);
  assert.deepStrictEqual(d.changedIds, ['2']);
  assert.deepStrictEqual(d.removedIds, ['3']);
  assert.strictEqual(d.fullFallback, false);
});
t('全部未变 → 无任何变更', function () {
  const a = item(1);
  const d = diffSigs({ 1: sigOfRaw(a) }, { 1: sigOfRaw(a) });
  assert.deepStrictEqual([d.newIds, d.changedIds, d.removedIds], [[], [], []]);
});
t('快照为空 → fullFallback=true 且全量输出', function () {
  const d = diffSigs(null, { 1: 'aa', 2: 'bb' });
  assert.strictEqual(d.fullFallback, true);
  assert.deepStrictEqual(d.newIds.sort(), ['1', '2']);
  assert.strictEqual(diffSigs({}, { 1: 'aa' }).fullFallback, true);
});
t('列表为空 → 全部判为下架', function () {
  const d = diffSigs({ 1: 'aa', 2: 'bb' }, {});
  assert.deepStrictEqual(d.removedIds.sort(), ['1', '2']);
  assert.strictEqual(d.newIds.length, 0);
});

console.log('\n结果: 通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail ? 1 : 0);
