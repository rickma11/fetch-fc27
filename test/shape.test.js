// 列表成型单测：`npm test` 会一并执行
// 背景：FC27 列表接口把六维与稀有度换了形态，pickPlayer 却仍按 FC26 取值，
// 导致全量 10000 条落库后 facePace..facePhysicality 全为 0、rarity 全为 null。
// 更糟的是同一处错误也存在于 sig.js 的签名里 → 即使 EA 改了卡，增量也判「无变化」。
// 所以这里必须直接断言 pickPlayer 的产物，不能只测 sig.js。
const assert = require('assert');
const { pickPlayer } = require('../scripts/fetch_futgg');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log('  PASS', name); pass++; }
  catch (e) { console.log('  FAIL', name, '->', e.message); fail++; }
}

const FACE = { pace: 88, shooting: 84, passing: 79, dribbling: 86, defending: 45, physicality: 71 };

// ① FC26 形态：faceStats 为扁平对象，rarity 为嵌套对象
const itemFc26 = {
  eaId: 1001, commonName: 'FC26 Guy', overall: 90, position: 'ST',
  faceStats: FACE, rarity: { name: 'Rare Gold' },
  club: { name: 'A' }, league: { name: 'B' }, nation: { name: 'C' }
};

// ② FC27 形态：faceStats 为对象数组（defKey + rating），rarity 为扁平 rarityName
const itemFc27Array = {
  eaId: 1002, commonName: 'FC27 Array Guy', overall: 88, position: 'CAM',
  faceStats: [
    { identifier: 'face_pace', defKey: 'facePace', rating: 92 },
    { identifier: 'face_shooting', defKey: 'faceShooting', rating: 85 },
    { identifier: 'face_passing', defKey: 'facePassing', rating: 88 },
    { identifier: 'face_dribbling', defKey: 'faceDribbling', rating: 90 },
    { identifier: 'face_defending', defKey: 'faceDefending', rating: 38 },
    { identifier: 'face_physicality', defKey: 'facePhysicality', rating: 64 }
  ],
  rarityName: 'Team of the Week',
  club: { name: 'A' }, league: { name: 'B' }, nation: { name: 'C' }
};

// ③ FC27 形态：faceStats 数组缺失，只有扁平 faceStatsV2
const itemFc27V2 = {
  eaId: 1003, commonName: 'FC27 V2 Guy', overall: 86, position: 'CB',
  faceStatsV2: {
    facePace: 75, faceShooting: 40, facePassing: 62,
    faceDribbling: 60, faceDefending: 87, facePhysicality: 84
  },
  rarityName: 'Gold',
  club: { name: 'A' }, league: { name: 'B' }, nation: { name: 'C' }
};

const p26 = pickPlayer(itemFc26);
const pArr = pickPlayer(itemFc27Array);
const pV2 = pickPlayer(itemFc27V2);

console.log('六维成型（FC26 对象形态）:');
t('faceStats 对象 → 六维正确', function () {
  assert.strictEqual(p26.facePace, FACE.pace);
  assert.strictEqual(p26.faceShooting, FACE.shooting);
  assert.strictEqual(p26.facePhysicality, FACE.physicality);
});

console.log('六维成型（FC27 对象数组形态）:');
t('faceStats 数组 → 六维不再为 0', function () {
  assert.strictEqual(pArr.facePace, 92);
  assert.strictEqual(pArr.faceShooting, 85);
  assert.strictEqual(pArr.facePassing, 88);
  assert.strictEqual(pArr.faceDribbling, 90);
  assert.strictEqual(pArr.faceDefending, 38);
  assert.strictEqual(pArr.facePhysicality, 64);
});
t('faceStats 数组 → 六项均非零（旧版此处全为 0）', function () {
  ['facePace', 'faceShooting', 'facePassing', 'faceDribbling', 'faceDefending', 'facePhysicality']
    .forEach(function (k) { assert.ok(pArr[k] > 0, k + ' 应 > 0，实际 ' + pArr[k]); });
});

console.log('六维成型（FC27 扁平 faceStatsV2 形态）:');
t('仅 faceStatsV2 → 六维正确', function () {
  assert.strictEqual(pV2.facePace, 75);
  assert.strictEqual(pV2.faceDefending, 87);
  assert.strictEqual(pV2.facePhysicality, 84);
});

console.log('稀有度成型:');
t('FC26 嵌套 rarity → name 正确', function () {
  assert.ok(p26.rarity && p26.rarity.name === 'Rare Gold');
});
t('FC27 扁平 rarityName → rarity.name 正确', function () {
  assert.ok(pArr.rarity && pArr.rarity.name === 'Team of the Week',
    '实际 ' + JSON.stringify(pArr.rarity));
  assert.ok(pV2.rarity && pV2.rarity.name === 'Gold');
});
t('稀有度缺失 → 不抛错且为 null', function () {
  assert.strictEqual(pickPlayer({ eaId: 9 }).rarity, null);
});

console.log('基本字段:');
t('eaId / overall / 名称透传', function () {
  assert.strictEqual(pArr.eaId, 1002);
  assert.strictEqual(pArr.overall, 88);
  assert.strictEqual(pArr.commonName, 'FC27 Array Guy');
});

console.log('图片命名与签名（必须与小程序 utils/format.js 的 IMG_SUFFIX 一致）:');
const img = require('../scripts/images');
t('云存储文件名约定不变', function () {
  assert.strictEqual(img.fileNameOf(192563, 'portrait'), '192563.webp');
  assert.strictEqual(img.fileNameOf(192563, 'card'), '192563_card.webp');
  assert.strictEqual(img.fileNameOf(192563, 'simple'), '192563_simple.webp');
});
t('云路径为 fc{ver}/images/<文件名>', function () {
  assert.strictEqual(img.cloudPathOf('192563_card.webp', 27), 'fc27/images/192563_card.webp');
});
t('图片签名随内容 hash 变化（换图能触发重传）', function () {
  const a = { eaId: 1, cardImagePath: 'p/1.aaa.webp', imagePath: 'p/1.bbb.webp' };
  const b = { eaId: 1, cardImagePath: 'p/1.zzz.webp', imagePath: 'p/1.bbb.webp' };
  assert.notStrictEqual(img.imgSigOf(a), img.imgSigOf(b));
});
t('无图片字段 → 签名为空（不会产生空任务）', function () {
  assert.strictEqual(img.imgSigOf({ eaId: 1 }), '');
});

console.log('\n结果: 通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail ? 1 : 0);
