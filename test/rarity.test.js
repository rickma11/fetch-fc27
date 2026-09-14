// 稀有度档位归一化单测：`npm test` 会一并执行
//
// 背景：fut.gg 的 FC27 列表接口把**普通卡**的 rarityName 一律写成 "Rare"（rarityId 718 /
// rarityEaId 0），于是小程序里金卡/银卡/铜卡全显示「Rare」。真实档位在顶层 quality 字段
// （GOLD / SILVER / BRONZE）。本测试守住三件事：
//   ① 占位名 → 金/银/铜映射正确（quality 优先、OVR 兜底）
//   ② **特殊活动卡原样保留**（Hall of FUT 及后续所有活动）—— 它的 quality 同样是 GOLD，
//      一旦按 quality 一刀切就会被误改成「金卡」
//   ③ 归一化必须返回副本、不改 raw item，否则签名 sigSource（读原始 rarityName）会变 →
//      触发 1 万条全量重抓详情
const assert = require('assert');
const {
  normalizeRarity, rarityTierOf, tierFromStoredRarity, isGenericRarityName, sigOfRaw
} = require('../scripts/sig');
const { pickPlayer } = require('../scripts/fetch_futgg');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log('  PASS', name); pass++; }
  catch (e) { console.log('  FAIL', name, '->', e.message); fail++; }
}

// FC27 普通卡的真实形状（2026-09-14 抓包复核）
function plainCard(quality, overall, level) {
  return {
    eaId: 231443, commonName: 'Ousmane Dembélé', overall: overall, position: 'RW',
    quality: quality,
    rarityName: 'Rare', rarityId: 718, rarityEaId: 0,
    rarityImagePath: '2027/rarities-level-' + level + '-large/x.png',
    club: { name: 'Paris Saint-Germain' }, league: { name: 'Ligue 1' }, nation: { name: 'France' }
  };
}

console.log('占位名 → 档位映射：');
t('quality=GOLD → Gold', function () {
  assert.strictEqual(normalizeRarity(plainCard('GOLD', 90, 3)).name, 'Gold');
});
t('quality=SILVER → Silver', function () {
  assert.strictEqual(normalizeRarity(plainCard('SILVER', 70, 2)).name, 'Silver');
});
t('quality=BRONZE → Bronze', function () {
  assert.strictEqual(normalizeRarity(plainCard('BRONZE', 60, 1)).name, 'Bronze');
});
t('quality 大小写/空格不敏感', function () {
  assert.strictEqual(normalizeRarity(plainCard(' gold ', 90, 3)).name, 'Gold');
});
t('映射后保留 id / eaId / imagePath', function () {
  const r = normalizeRarity(plainCard('GOLD', 90, 3));
  assert.strictEqual(r.id, 718);
  assert.strictEqual(r.eaId, 0);
  assert.ok(/rarities-level-3-large/.test(r.imagePath));
});
t('无 quality → 按 OVR 兜底（75+ 金 / 65~74 银 / ≤64 铜）', function () {
  const noQ = (ovr) => { const c = plainCard('', ovr, 0); delete c.quality; c.rarityImagePath = ''; return c; };
  assert.strictEqual(normalizeRarity(noQ(91)).name, 'Gold');
  assert.strictEqual(normalizeRarity(noQ(75)).name, 'Gold');
  assert.strictEqual(normalizeRarity(noQ(74)).name, 'Silver');
  assert.strictEqual(normalizeRarity(noQ(65)).name, 'Silver');
  assert.strictEqual(normalizeRarity(noQ(64)).name, 'Bronze');
  assert.strictEqual(normalizeRarity(noQ(56)).name, 'Bronze');
});

console.log('\n特殊活动卡必须原样保留：');
t('Hall of FUT 保持原名（它的 quality 也是 GOLD，不能被改成金卡）', function () {
  const hof = {
    eaId: 210257, commonName: 'Micah Richards', overall: 85, quality: 'GOLD',
    rarityName: 'Hall of FUT', rarityId: 756, rarityEaId: 9,
    rarityImagePath: '2027/rarities-level-0-large/y.png'
  };
  assert.strictEqual(normalizeRarity(hof).name, 'Hall of FUT');
});
t('未来活动卡（Team of the Week）保持原名', function () {
  const totw = plainCard('GOLD', 88, 3);
  totw.rarityName = 'Team of the Week';
  assert.strictEqual(normalizeRarity(totw).name, 'Team of the Week');
});
t('FC26 嵌套卡（Winter Wildcards）保持原名且带回原对象的其它字段', function () {
  const fc26 = { eaId: 1, overall: 90, rarity: { name: 'Winter Wildcards', rarityGroupName: 'Winter Wildcards' } };
  const r = normalizeRarity(fc26);
  assert.strictEqual(r.name, 'Winter Wildcards');
  assert.strictEqual(r.rarityGroupName, 'Winter Wildcards');
});
t('占位名判定：只认 rare / non-rare / nonrare / common', function () {
  assert.strictEqual(isGenericRarityName('Rare'), true);
  assert.strictEqual(isGenericRarityName(' rare '), true);
  assert.strictEqual(isGenericRarityName('Non-Rare'), true);
  assert.strictEqual(isGenericRarityName('Hall of FUT'), false);
  assert.strictEqual(isGenericRarityName('Gold'), false);
  assert.strictEqual(isGenericRarityName(''), false);
  assert.strictEqual(isGenericRarityName(null), false);
});

console.log('\n不改 raw item / 不改签名：');
t('归一化返回副本，raw item 的 rarityName 不变', function () {
  const raw = plainCard('GOLD', 90, 3);
  const r = normalizeRarity(raw);
  assert.notStrictEqual(r, raw);
  assert.strictEqual(raw.rarityName, 'Rare', 'raw 被就地改写了！');
  assert.strictEqual(r.name, 'Gold');
});
t('FC26 嵌套形态也不得就地改写 raw 的 rarity 对象', function () {
  const raw = { eaId: 1, overall: 60, rarity: { name: 'Rare' } };
  const r = normalizeRarity(raw);
  assert.strictEqual(r.name, 'Bronze');
  assert.strictEqual(raw.rarity.name, 'Rare', 'raw.rarity 被就地改写了！');
});
t('签名不受归一化影响（sigSource 读的是原始 rarityName）', function () {
  const raw = plainCard('GOLD', 90, 3);
  const before = sigOfRaw(raw);
  normalizeRarity(raw);
  assert.strictEqual(sigOfRaw(raw), before);
});
t('normalizeRarity(null / 无 rarity) → null（与 normRarity 同口径）', function () {
  assert.strictEqual(normalizeRarity(null), null);
  assert.strictEqual(normalizeRarity({ eaId: 9 }), null);
});

console.log('\n回填口径（从已落库文档反推）：');
t('tierFromStoredRarity 用 imagePath 的 level：1=铜 2=银 3=金', function () {
  assert.strictEqual(tierFromStoredRarity({ imagePath: 'x/rarities-level-1-large/a.png' }, 99), 'Bronze');
  assert.strictEqual(tierFromStoredRarity({ imagePath: 'x/rarities-level-2-large/a.png' }, 99), 'Silver');
  assert.strictEqual(tierFromStoredRarity({ imagePath: 'x/rarities-level-3-large/a.png' }, 50), 'Gold');
});
t('imagePath 解析不到 → 回落 OVR（含 level-0 特殊卡）', function () {
  assert.strictEqual(tierFromStoredRarity({ imagePath: 'x/rarities-level-0-large/a.png' }, 85), 'Gold');
  assert.strictEqual(tierFromStoredRarity({ imagePath: '' }, 64), 'Bronze');
  assert.strictEqual(tierFromStoredRarity(null, 70), 'Silver');
  assert.strictEqual(tierFromStoredRarity({}, 0), null);
});
t('rarityTierOf 优先 quality，其次 OVR', function () {
  assert.strictEqual(rarityTierOf({ quality: 'SILVER', overall: 90 }), 'Silver');
  assert.strictEqual(rarityTierOf({ quality: null, overall: 90 }), 'Gold');
});

console.log('\npickPlayer 端到端（落库取值）：');
t('FC27 金卡 → p.rarity.name = Gold（facets 也因此变正确）', function () {
  const p = pickPlayer(plainCard('GOLD', 90, 3));
  assert.strictEqual(p.rarity.name, 'Gold');
});
t('FC27 银卡 / 铜卡 → Silver / Bronze', function () {
  assert.strictEqual(pickPlayer(plainCard('SILVER', 70, 2)).rarity.name, 'Silver');
  assert.strictEqual(pickPlayer(plainCard('BRONZE', 60, 1)).rarity.name, 'Bronze');
});
t('Hall of FUT → 仍为 Hall of FUT（不会被写成 Gold）', function () {
  const hof = plainCard('GOLD', 85, 0);
  hof.rarityName = 'Hall of FUT'; hof.rarityEaId = 9;
  assert.strictEqual(pickPlayer(hof).rarity.name, 'Hall of FUT');
});

console.log('\n结果: 通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail ? 1 : 0);
