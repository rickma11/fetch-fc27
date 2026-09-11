// 签名与差异归类单测：`npm test`
// 这两块逻辑决定了增量抓取「哪些卡需要重抓」，一旦判断错，要么漏更新、要么退化成全量。
const assert = require('assert');
const { sigOfRaw, diffSigs, normFaceStats, rarityNameOf, normRarity } = require('../scripts/sig');

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

// FC27 列表接口实测样本（2026-09-11 抓包确认）：
//   ① faceStats 由 FC26 的 {pace:..} 变成「对象数组」[{defKey:'facePace', rating:88}, ...]
//   ② 新增扁平对象 faceStatsV2 = { facePace:88, faceShooting:42, ... }
//   ③ rarity 由嵌套对象变成扁平 rarityName 字符串
// 早期只认 ① 的 FC26 形态 → FC27 全量 10000 条六维写成 0、rarity 写成 null，
// 且签名里这两项恒为空 → 变化检测彻底失效。下面三条守住这个回归。
const FC27_ITEM = {
  eaId: 146631, overall: 79, position: 'LB',
  faceStats: [
    { identifier: 'face_pace', name: 'PAC', defKey: 'facePace', rating: 88 },
    { identifier: 'face_shooting', name: 'SHO', defKey: 'faceShooting', rating: 42 },
    { identifier: 'face_passing', name: 'PAS', defKey: 'facePassing', rating: 64 },
    { identifier: 'face_dribbling', name: 'DRI', defKey: 'faceDribbling', rating: 72 },
    { identifier: 'face_defending', name: 'DEF', defKey: 'faceDefending', rating: 75 },
    { identifier: 'face_physicality', name: 'PHY', defKey: 'facePhysicality', rating: 81 }
  ],
  faceStatsV2: {
    facePace: 88, faceShooting: 42, facePassing: 64,
    faceDribbling: 72, faceDefending: 75, facePhysicality: 81,
    gkFaceDiving: 0, gkFaceHandling: 0, gkFaceKicking: 0,
    gkFaceReflexes: 0, gkFaceSpeed: 0, gkFacePositioning: 0
  },
  rarityName: 'Rare', rarityId: 718, rarityEaId: 0,
  club: { name: 'Fenerbahçe' }, league: { name: 'Süper Lig' }, nation: { name: 'Netherlands' },
  playStyleEaIds: [2], playStylePlusEaIds: [], chemistryRolesPlusEaIds: [],
  chemistryRolesPlusPlusEaIds: [], alternativePositionIds: [],
  cardImagePath: 'b_card.webp', createdAt: '2026-09-01T00:00:00Z'
};

console.log('六维/稀有度形态归一化（FC27 回归）:');
t('faceStats 对象数组形态 → 六维正确解出', function () {
  const f = normFaceStats(FC27_ITEM);
  assert.deepStrictEqual(f, { pace: 88, shooting: 42, passing: 64, dribbling: 72, defending: 75, physicality: 81 });
});
t('faceStatsV2 扁平形态 → 六维正确解出', function () {
  const f = normFaceStats({ faceStatsV2: FC27_ITEM.faceStatsV2 });
  assert.deepStrictEqual(f, { pace: 88, shooting: 42, passing: 64, dribbling: 72, defending: 75, physicality: 81 });
});
t('FC26 老形态（对象）仍兼容', function () {
  const f = normFaceStats({ faceStats: { pace: 90, shooting: 88, passing: 80, dribbling: 85, defending: 40, physicality: 70 } });
  assert.strictEqual(f.pace, 90);
  assert.strictEqual(f.physicality, 70);
});
t('六维全缺失 → 返回全 0 而不是抛错', function () {
  assert.deepStrictEqual(normFaceStats({}), { pace: 0, shooting: 0, passing: 0, dribbling: 0, defending: 0, physicality: 0 });
  assert.deepStrictEqual(normFaceStats(null), { pace: 0, shooting: 0, passing: 0, dribbling: 0, defending: 0, physicality: 0 });
});
t('FC27 扁平 rarityName → 归一成对象', function () {
  assert.strictEqual(rarityNameOf(FC27_ITEM), 'Rare');
  const r = normRarity(FC27_ITEM);
  assert.strictEqual(r.name, 'Rare');
  assert.strictEqual(r.id, 718);
});
t('FC26 嵌套 rarity 不被覆盖', function () {
  assert.strictEqual(rarityNameOf({ rarity: { name: 'Icon' } }), 'Icon');
  assert.deepStrictEqual(normRarity({ rarity: { name: 'Icon' } }), { name: 'Icon' });
});
t('FC27 形态下 faceStats 变化 → 签名变化（旧版会漏检）', function () {
  const a = Object.assign({}, FC27_ITEM);
  const b = Object.assign({}, FC27_ITEM, {
    faceStatsV2: Object.assign({}, FC27_ITEM.faceStatsV2, { facePace: 99 })
  });
  assert.notStrictEqual(sigOfRaw(a), sigOfRaw(b));
});
t('FC27 形态下 rarityName 变化 → 签名变化（旧版会漏检）', function () {
  assert.notStrictEqual(sigOfRaw(FC27_ITEM), sigOfRaw(Object.assign({}, FC27_ITEM, { rarityName: 'Special' })));
});
t('FC27 形态下唯一性：同一对象重复签名一致', function () {
  assert.strictEqual(sigOfRaw(FC27_ITEM), sigOfRaw(JSON.parse(JSON.stringify(FC27_ITEM))));
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
