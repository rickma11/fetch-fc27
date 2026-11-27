// test/cardsig.test.js —— 卡面内容签名（cardSig）机制的专项单测
//
// 覆盖 4 件事：
//   ① cardSigOf 从 cardImagePath 的 EA 内容 hash 取前 16 位（换脸 ⇒ 签名变）
//   ② card_sigs.json 真源读写（排序稳定、坏文件不崩）
//   ③ fetch_futgg 的注入语义：本次新算的签名优先于真源旧值；真源兜底补齐
//   ④ market_core.cardCloudId：有 cardSig ⇒ 签名名；无 ⇒ 旧名（不回归）
//
// 用法：node test/cardsig.test.js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  PASS ' + label); }
  else { fail++; console.log('  FAIL ' + label + (extra ? ' | ' + extra : '')); }
}

// ── 准备隔离的临时工作区（避免污染仓库真实 cloud-data）──
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'oao_cardsig_'));

// images.js 用 __dirname 定位 cloud-data ⇒ 直接测它的纯函数 + 用临时文件测读写
const imgLib = require('../scripts/images.js');
console.log('== ① cardSigOf（从 EA 内容 hash 取签名）==');
{
  const p1 = '2027/futgg-player-item-card/27-67322964.7410fea473f9b31b75fabb8bc38b45d4f5d52b4afe726b1596fb7b50acc217eb.webp';
  const p2 = '2027/futgg-player-item-card/27-67322964.deadbeefdeadbeef75fabb8bc38b45d4f5d52b4afe726b1596fb7b50acc217eb.webp';
  const s1 = imgLib.cardSigOf({ cardImagePath: p1 });
  const s2 = imgLib.cardSigOf({ cardImagePath: p2 });
  ok(s1 === '7410fea473f9b31b', '签名取 hash 前 16 位', 'got=' + s1);
  ok(s1 !== s2, '换脸（hash 变）⇒ 签名变');
  ok(s1.length === 16, '签名固定 16 位', 'len=' + s1.length);
  ok(imgLib.cardSigOf({}) === '', '无路径 ⇒ 空签名（端上回落旧图）');
  ok(imgLib.cardSigOf({ imagePath: p1 }) === s1, '无 cardImagePath 时回落 imagePath');
  ok(imgLib.cardSigFileNameOf(67322964, s1) === '67322964_card_7410fea473f9b31b.webp',
    '签名文件名格式 = {eaId}_card_{sig}.webp');
  ok(imgLib.cardSigFileNameOf(67322964, '') === '', '空签名 ⇒ 不产出文件名');
}

console.log('== ② card_sigs.json 真源读写 ==');
{
  const p = imgLib.CARD_SIGS(27);
  const backup = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
  try {
    fs.writeFileSync(p, JSON.stringify({ 100: 'aaa', 50: 'bbb' }));
    const read = imgLib.readCardSigs(27);
    ok(read['100'] === 'aaa' && read['50'] === 'bbb', '读回真源');
    const written = imgLib.writeCardSigs(27, { 100: 'aaa', 50: 'bbb' });
    const keys = Object.keys(written);
    ok(keys[0] === '50' && keys[1] === '100', '写盘按 eaId 数值排序（diff 稳定）', keys.join(','));
    fs.writeFileSync(p, '这不是 JSON {{{');
    ok(JSON.stringify(imgLib.readCardSigs(27)) === '{}', '坏文件 ⇒ 返回空对象（不崩）');
  } finally {
    if (backup !== null) fs.writeFileSync(p, backup); else { try { fs.unlinkSync(p); } catch (e) { } }
  }
}

console.log('== ③ fetch_futgg 注入语义 ==');
{
  // 复刻 fetch_futgg 的注入逻辑（真源兜底 + 本次新算优先）
  function inject(item, source) {
    const sig = source[String(item.eaId)];
    if (sig && !item.cardSig) item.cardSig = sig;
    return item;
  }
  const src = { 111: 'oldsig11111111', 222: 'truesig2222222' };
  const a = inject({ eaId: 111 }, src);
  ok(a.cardSig === 'oldsig11111111', '真源兜底：本次没算签名 ⇒ 从真源补齐');
  const b = inject({ eaId: 222, cardSig: 'freshsig222222' }, src);
  ok(b.cardSig === 'freshsig222222', '本次新算的签名优先于真源旧值（连续换脸不被旧值覆盖）');
  const c = inject({ eaId: 333 }, src);
  ok(!c.cardSig, '真源里没有 ⇒ 不写 cardSig（端上用旧名）');
}

console.log('== ④ market_core.cardCloudId（市场页）==');
{
  const mc = require('../scripts/market_core.js');
  const sigId = mc.cardCloudId(67322964, true, 'Rare', 88, '7410fea473f9b31b');
  ok(sigId.indexOf('/67322964_card_7410fea473f9b31b.webp') > 0, '有 cardSig ⇒ 签名名', sigId);
  const oldId = mc.cardCloudId(67322964, true, 'Rare', 88, '');
  ok(oldId.indexOf('/67322964_card.webp') > 0, '无 cardSig ⇒ 旧名（不回归）', oldId);
  const npId = mc.cardCloudId(67322964, false, 'Rare', 88, '');
  ok(npId.indexOf('/67322964_np.webp') > 0, '无半身像 ⇒ 剪影名');
  const sigNp = mc.cardCloudId(67322964, false, 'Rare', 88, '7410fea473f9b31b');
  ok(sigNp.indexOf('_card_7410fea473f9b31b.webp') > 0, '有 cardSig ⇒ 优先签名名（不论半身像）');
}

console.log('== ⑤ 云函数副本与 CI 副本口径一致 ==');
{
  // 云函数副本在兄弟仓库 eafc-miniapp（不在本仓库时跳过，不让单测因缺仓库而红）
  const cloudFnPath = path.resolve(__dirname, '..', '..', 'eafc-miniapp', 'cloudfunctions', 'market_sync', 'market_core.js');
  if (!fs.existsSync(cloudFnPath)) {
    console.log('  SKIP 云函数副本不在本工作区（eafc-miniapp），跳过一致性比对');
  } else {
    const a = require('../scripts/market_core.js').cardCloudId(1, true, 'Rare', 88, 'abc');
    const b = require(cloudFnPath).cardCloudId(1, true, 'Rare', 88, 'abc');
    ok(a === b, '两份 market_core 拼名完全一致（规则 93）', a + ' vs ' + b);
  }
}

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { }

console.log('\n结果: 通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail ? 1 : 0);
