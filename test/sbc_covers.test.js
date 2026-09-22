// SBC set 封面「内容指纹 → 是否需上传」单测：`npm test` 会一并执行（2026-09-22 方案 A｜最小）。
// 背景：此前上传循环**没有任何跳过分支** → 每天把十几张封面无脑重传（随网络 0.8~7.7min）。
// 加了指纹后，新逻辑的失败形态是**静默漏传**（某张图永远不再上传、端上长期缺图且无日志），
// 所以这里既要测判定函数本身，也要测「接线」——即脚本真的用了这个模块、且清单真的被 CI 提交。
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cs = require('../scripts/sbc_cover_sig');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log('  PASS', name); pass++; }
  catch (e) { console.log('  FAIL', name, '->', e.message); fail++; }
}

const ROOT = path.resolve(__dirname, '..');
const readSrc = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const A = Buffer.from('fake-png-bytes-aaaa');
const B = Buffer.from('fake-png-bytes-bbbb');

console.log('指纹 sigOf:');
t('同内容 → 同指纹（跨调用稳定）', function () {
  assert.strictEqual(cs.sigOf(A), cs.sigOf(Buffer.from('fake-png-bytes-aaaa')));
});
t('内容变 → 指纹变（换图能触发重传）', function () {
  assert.notStrictEqual(cs.sigOf(A), cs.sigOf(B));
});
t('指纹是 16 位十六进制（与 images.js#imgSigOf 同族形态）', function () {
  assert.ok(/^[0-9a-f]{16}$/.test(cs.sigOf(A)), '实际 ' + cs.sigOf(A));
});
t('空 / 缺失 → 空串（调用方据此不记指纹）', function () {
  assert.strictEqual(cs.sigOf(Buffer.alloc(0)), '');
  assert.strictEqual(cs.sigOf(null), '');
  assert.strictEqual(cs.sigOf(undefined), '');
});

console.log('清单归一化 normSigs:');
t('丢掉非字符串 / 空串值（防手改坏数据弄脏判定）', function () {
  const out = cs.normSigs({ a: 'x', b: 123, c: '', d: null, e: ['z'] });
  assert.deepStrictEqual(Object.keys(out), ['a']);
});
t('非对象（数组 / null / 字符串）→ 空表', function () {
  assert.deepStrictEqual(cs.normSigs(['a']), {});
  assert.deepStrictEqual(cs.normSigs(null), {});
  assert.deepStrictEqual(cs.normSigs('x'), {});
});

console.log('清单读盘 readSigs（缺失 / 损坏都退回「全量上传」老行为）:');
const TMP = path.join(os.tmpdir(), 'sbc_sig_test_' + process.pid + '.json');
t('真实文件读回（写盘 → 读盘链路）', function () {
  fs.writeFileSync(TMP, JSON.stringify({ '2027/sbcs/1.png': 'abc123' }));
  assert.deepStrictEqual(cs.readSigs(TMP), { '2027/sbcs/1.png': 'abc123' });
});
t('文件不存在 → 空表（不抛错）', function () {
  assert.deepStrictEqual(cs.readSigs(path.join(os.tmpdir(), 'no_such_file_' + process.pid + '.json')), {});
});
t('内容不是 JSON → 空表（不抛错）', function () {
  fs.writeFileSync(TMP, '{ broken json');
  assert.deepStrictEqual(cs.readSigs(TMP), {});
});
t('内容是数组 → 空表（防把 sbc_faces 那种映射误当指纹表）', function () {
  fs.writeFileSync(TMP, '["a","b"]');
  assert.deepStrictEqual(cs.readSigs(TMP), {});
});
try { fs.unlinkSync(TMP); } catch (e) {}

console.log('判定 decideUpload:');
t('清单里没有该图 → need（新图必须上传）', function () {
  const d = cs.decideUpload('p/1.png', A, {});
  assert.strictEqual(d.need, true);
  assert.strictEqual(d.reason, 'new');
  assert.strictEqual(d.sig, cs.sigOf(A));
});
t('指纹一致 → 不 need（跳过上传，省掉重复 PUT）', function () {
  const d = cs.decideUpload('p/1.png', A, { 'p/1.png': cs.sigOf(A) });
  assert.strictEqual(d.need, false);
  assert.strictEqual(d.reason, 'unchanged');
});
t('指纹不一致 → need（内容变必须重传）', function () {
  const d = cs.decideUpload('p/1.png', B, { 'p/1.png': cs.sigOf(A) });
  assert.strictEqual(d.need, true);
  assert.strictEqual(d.reason, 'changed');
});
t('按 imagePath 逐张判，不串味（不同图同内容互不影响）', function () {
  const old = { 'p/1.png': cs.sigOf(A) };
  assert.strictEqual(cs.decideUpload('p/1.png', A, old).need, false);
  assert.strictEqual(cs.decideUpload('p/2.png', A, old).need, true, '清单里没有 2.png ⇒ 必须上传');
});
t('空内容 → 不 need 但指纹为空（调用方不得把它记进清单）', function () {
  const d = cs.decideUpload('p/1.png', Buffer.alloc(0), {});
  assert.strictEqual(d.need, false);
  assert.strictEqual(d.sig, '');
  assert.strictEqual(d.reason, 'empty');
});
t('oldSig 传 undefined / null 不抛错', function () {
  assert.strictEqual(cs.decideUpload('p/1.png', A, undefined).need, true);
  assert.strictEqual(cs.decideUpload('p/1.png', A, null).need, true);
});

console.log('接线（改脚本没接线 = 静默保持全量重传）:');
const SRC = readSrc('scripts/sync_sbc_covers.js');
t('脚本真的 require 了这个模块', function () {
  assert.ok(/require\(['"]\.\/sbc_cover_sig['"]\)/.test(SRC), '缺少 require');
});
t('脚本调 decideUpload 判跳，且调 readSigs 读清单', function () {
  assert.ok(/coverSig\.decideUpload\(/.test(SRC), '缺少 decideUpload 调用');
  assert.ok(/coverSig\.readSigs\(SIG_JSON\)/.test(SRC), '缺少 readSigs(SIG_JSON) 调用');
});
t('清单路径是 cloud-data/fc{ver}/sbc_covers_sig.json', function () {
  assert.ok(/sbc_covers_sig\.json/.test(SRC), '缺少清单文件名');
  assert.ok(/path\.join\(ROOT,\s*'cloud-data',\s*`fc\$\{VER\}`,\s*'sbc_covers_sig\.json'\)/.test(SRC),
    '清单路径拼接被改过，请同步本断言');
});
t('⚠️ 指纹只在上传成功 / 确认未变两处分记（上传失败绝不记）', function () {
  const lines = SRC.split(/\r?\n/).filter(function (l) { return /newSig\[[^\]]+\]\s*=/.test(l); });
  assert.strictEqual(lines.length, 2, 'newSig 赋值应恰好 2 处，实际 ' + lines.length + ' 处：' +
    '「上传失败也记指纹」⇒ 该图会被永久漏传且无任何日志');
  assert.ok(lines.every(function (l) { return /if \(!d\.need\)/.test(l) || /if \(ok\)/.test(l); }),
    'newSig 赋值行必须落在「未变跳过」或「上传成功」分支内，实际：\n' + lines.join('\n'));
});
t('上传循环里没有留下裸的 sigOf（已全部走 module）', function () {
  assert.ok(!/\bsigOf\(/.test(SRC), '脚本里不该再出现 sigOf( 直接调用');
});
t('workflow 的 git add 白名单含 sbc_covers_sig.json（否则每 run 从零上传）', function () {
  const yml = readSrc('.github/workflows/fetch-fc27.yml');
  assert.ok(/git add cloud-data\/fc27\/sbc_covers_sig\.json/.test(yml),
    'workflow 未提交该清单 ⇒ runner 工作区恒空 ⇒ 指纹为空 ⇒ 每天仍全量重传');
});
t('workflow 仍提交 sbc_faces.json（原有行为不许回退）', function () {
  const yml = readSrc('.github/workflows/fetch-fc27.yml');
  assert.ok(/git add cloud-data\/fc27\/sbc_faces\.json/.test(yml));
});

console.log('\n结果: 通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail ? 1 : 0);
