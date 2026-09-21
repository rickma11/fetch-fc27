// 列表成型单测：`npm test` 会一并执行
// 背景：FC27 列表接口把六维与稀有度换了形态，pickPlayer 却仍按 FC26 取值，
// 导致全量 10000 条落库后 facePace..facePhysicality 全为 0、rarity 全为 null。
// 更糟的是同一处错误也存在于 sig.js 的签名里 → 即使 EA 改了卡，增量也判「无变化」。
// 所以这里必须直接断言 pickPlayer 的产物，不能只测 sig.js。
const assert = require('assert');
const { pickPlayer, buildDetail, pickArr, chemArrayOf } = require('../scripts/fetch_futgg');

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

// 男女足（2026-09-20）：fut.gg 列表接口带 gender（1=男足 / 2=女足），端上详情页+对比页展示。
// 当初漏抓 → 端上没法显示；这里钉住「列表侧必须透传 gender」。
console.log('男女足字段:');
t('gender 透传（1 / 2 都保住）', function () {
  assert.strictEqual(pickPlayer({ eaId: 1, gender: 1 }).gender, 1);
  assert.strictEqual(pickPlayer({ eaId: 2, gender: 2 }).gender, 2);
});
t('gender 缺失 → null（不写成 undefined，端上 genderText 返回 "-"）', function () {
  assert.strictEqual(pickPlayer({ eaId: 3 }).gender, null);
});
t('buildDetail 带上 gender（详情覆盖列表）', function () {
  const p = pickPlayer({ eaId: 4, gender: 1 });
  assert.strictEqual(buildDetail(p, { data: { gender: 2 } }).gender, 2);
  assert.strictEqual(buildDetail(p, { data: {} }).gender, 1);
});

// ⚠️ 回归（2026-09-20 C 类隐患）：`d.playstyles || p.playstyles` 里 `[]` 是真值，
//    一旦详情返回空数组而列表有值，列表值会被空数组短路丢光。改成 pickArr 后必须忠于「非空优先」。
console.log('详情空数组不得覆盖列表值（pickArr）:');
t('pickArr 取第一个非空数组', function () {
  assert.deepStrictEqual(pickArr([], [7], [9]), [7]);
  assert.deepStrictEqual(pickArr([], [], [9]), [9]);
  assert.deepStrictEqual(pickArr([1], [7]), [1]);
});
t('pickArr 全空 → 保留最靠前那个（详情优先，维持原语义）', function () {
  assert.deepStrictEqual(pickArr([], [], []), []);
  assert.deepStrictEqual(pickArr([], undefined, undefined), []);
  assert.deepStrictEqual(pickArr(undefined, undefined), []);
});
t('buildDetail：详情 playstyles=[] 时不得丢列表已有花式', function () {
  const p = pickPlayer({ eaId: 5, playStyleEaIds: [11, 12], rolesPlus: [42] });
  const d = buildDetail(p, { data: { playstyles: [], playStyleEaIds: [], rolesPlus: [] } });
  assert.deepStrictEqual(d.playstyles, [11, 12], '实际 ' + JSON.stringify(d.playstyles));
  assert.deepStrictEqual(d.rolesPlus, [42], '实际 ' + JSON.stringify(d.rolesPlus));
});
t('buildDetail：详情有值时仍以详情为准', function () {
  const p = pickPlayer({ eaId: 6, playStyleEaIds: [11] });
  const d = buildDetail(p, { data: { playStyleEaIds: [99, 98] } });
  assert.deepStrictEqual(d.playstyles, [99, 98]);
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


console.log('增量 needSet 类型归一（2026-09-18 run#41/#42 回归）:')
t('diffSigs 字符串 id 必须能匹配到数字 eaId 的列表项（String 归一化）', function () {
  const { diffSigs } = require('../scripts/sig');
  const snap = { '1001': 'a', '1002': 'b' };
  const sigs = { 1001: 'a', 1002: 'c', 1003: 'd' };   // 模拟 fetch_ci: 对象键 → 字符串, 列表 eaId → 数字
  const d = diffSigs(snap, sigs);
  assert.ok(d.newIds.every(function (x) { return typeof x === 'string'; }));
  const needSet = new Set(d.newIds.concat(d.changedIds).map(String));
  assert.ok(needSet.has(String(1003)), '新增 id 必须命中');
  assert.ok(needSet.has(String(1002)), '变化 id 必须命中');
  assert.strictEqual(!needSet.has(String(1001)), true, '未变 id 不应重抓');
});
// 化学档案（2026-09-21）：阵型战术模块的化学靠这几个 fut.gg 列表层字段，**不抓详情**。
// 实测（每个稀有度抽 3~5 张，见 docs/18 §3.6.4）：
//   Base Icon / Debut International Icon → full + extraSquadLeague
//   Base Hero → 只 full
//   Partnerships（既非 Icon/Hero/名宿）→ 只 extraSquadLeague  ← 写死稀有度名单必漏
//   Base Hall of FUT → 两条皆 false（fut.gg 数据缺口，EA 公告说等同英雄）
//   Gold/Silver/Bronze/Rare/TOTW/OTW/Squad Foundations → 皆 false
// ⚠️ 这些字段**没有**进 sig.js 的签名（避免全库重抓）；首次上线靠一次 full 跑回填，
//    兜底走 facets.json#rarityChem（每次 run 都从完整列表重算）。
console.log('化学档案（阵型战术）:');
t('7 元压缩 [full, exC, exL, exN, sqC, sqL, sqN] 顺序正确', function () {
  assert.deepStrictEqual(chemArrayOf({ isFullChemistry: true, extraSquadLeagueChemistry: true }), [1, 0, 0, 0, 0, 1, 0]);
  assert.deepStrictEqual(chemArrayOf({ isFullChemistry: true }), [1, 0, 0, 0, 0, 0, 0]);
  assert.deepStrictEqual(chemArrayOf({ extraSquadLeagueChemistry: true }), [0, 0, 0, 0, 0, 1, 0]);
  assert.deepStrictEqual(chemArrayOf({ extraClubChemistry: 2 }), [0, 2, 0, 0, 0, 0, 0]);
});
t('全 0 / 空对象 → null（不写字段，省库容）', function () {
  assert.strictEqual(chemArrayOf({ isFullChemistry: false, extraSquadLeagueChemistry: false }), null);
  assert.strictEqual(chemArrayOf({}), null);
  assert.strictEqual(chemArrayOf({ isFullChemistry: 0, extraNationChemistry: 0 }), null);
});
t('布尔 true 归成 1（列表层 extraSquad* 是布尔，不是数字）', function () {
  assert.deepStrictEqual(chemArrayOf({ extraSquadNationChemistry: true }), [0, 0, 0, 0, 0, 0, 1]);
});
t('pickPlayer 带出 chem；普通卡**不带**这个键', function () {
  const icon = pickPlayer({ eaId: 101, commonName: 'Icon Guy', rarity: { name: 'Base Icon', eaId: 12 }, isFullChemistry: true, extraSquadLeagueChemistry: true });
  assert.deepStrictEqual(icon.chem, [1, 0, 0, 0, 0, 1, 0]);
  const gold = pickPlayer({ eaId: 102, commonName: 'Gold Guy', rarity: { name: 'Gold', eaId: 1 }, isFullChemistry: false });
  assert.strictEqual('chem' in JSON.parse(JSON.stringify(gold)), false, 'JSON 里不该出现 chem 键');
});
t('Partnerships 型：不满化学但有 extraSquadLeague', function () {
  const p = pickPlayer({ eaId: 103, commonName: 'Partner Guy', isFullChemistry: false, extraSquadLeagueChemistry: true });
  assert.deepStrictEqual(p.chem, [0, 0, 0, 0, 0, 1, 0]);
});

console.log('\n结果: 通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail ? 1 : 0);
