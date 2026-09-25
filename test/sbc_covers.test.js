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

t('兜底：脚本真的接线到 sbc_cover_tasks（任务表构建不许留在 IIFE 里无法测）', function () {
  assert.ok(/require\(['"]\.\/sbc_cover_tasks['"]\)/.test(SRC), '缺少 require sbc_cover_tasks');
  assert.ok(/coverTasks\.buildCoverTasks\(sets\)/.test(SRC), '脚本未用抽出的任务表构建');
});

console.log('封面任务表 buildCoverTasks（2026-09-26 兜底：imagePath 缺失的 set）:');
const CT = require('../scripts/sbc_cover_tasks');
// 真实形状（云端 sbcs_fc27 实测 21 组里 2 组缺 imagePath，与 2026-09-26 截图里的黑块同源）
const nusa = { id: 5266, name: 'Antonio Nusa', challenges: [{ imagePath: '2027/sbcs/challenges/55.png' }] };
const totw = { id: 5265, name: 'TOTW Upgrade', challenges: [{ imagePath: '2027/sbcs/challenges/59.png' }] };
const sample = [
  { id: 1111, name: '正常 SBC', imagePath: '/2027/sbcs/1111.png', challenges: [] },
  { id: 5265, name: 'TOTW Upgrade', challenges: [{ imagePath: '2027/sbcs/challenges/59.png' }] },
  { id: 5266, name: 'Antonio Nusa', imageUrl: 'https://game-assets.fut.gg/cdn-cgi/image/width=300/2027/futgg-player-item-card/27-50594511.webp', challenges: [{ imagePath: '2027/sbcs/challenges/55.png' }] },
  { id: 5267, name: '无任何来源', challenges: [] },   // 两者皆空且无挑战图 → 宁可跳过
  { id: 0, name: '无 id', imagePath: '2027/sbcs/0.png' }
];
const tasks = CT.buildCoverTasks(sample);
const byId = {};
tasks.forEach(t => { byId[t.id] = t; });
t('正常 set 走 imagePath（fileName = sbc_<id>.webp）', function () {
  assert.strictEqual(byId['1111'] && byId['1111'].fileName, 'sbc_1111.webp');
  assert.strictEqual(byId['1111'].fallback, false);
});
t('兜底①：球员类（imageUrl 为外域卡面）→ 文件名同源 + 标记为 fallback', function () {
  assert.strictEqual(byId['5266'].fileName, 'sbc_5266.webp');
  assert.strictEqual(byId['5266'].srcUrl.indexOf('https://game-assets.fut.gg/'), 0);
  assert.strictEqual(byId['5266'].fallback, true);
});
t('兜底②：升级类（两者皆空）→ 用首个 challenge 图作来源', function () {
  assert.strictEqual(byId['5265'].fileName, 'sbc_5265.webp');
  assert.strictEqual(byId['5265'].srcUrl, 'https://game-assets.fut.gg/2027/sbcs/challenges/59.png');
  assert.ok(byId['5265'].imagePath.indexOf('challenges/59.png') >= 0, '指纹 key 应指向挑战图');
});
t('无来源（无 imageUrl/无挑战图）→ 不进任务表（不污染指纹、不裸传空 URL）', function () {
  assert.strictEqual(byId['5267'], undefined);
});
t('id 为 "0" 的极端 set 仍产出合法文件名（不出现空名 sbc_.webp）', function () {
  assert.ok(byId['0'], '该 set 不该被丢掉（真实数据里 imagePath=0.png 这种仍可能）');
  assert.ok(/^sbc_\d+\.webp$/.test(byId['0'].fileName), '实际 ' + byId['0'].fileName);
});
t('按 id 去重（同一 set 只传一次）', function () {
  assert.strictEqual(CT.buildCoverTasks([
    { id: 1, imagePath: '2027/sbcs/1.png' }, { id: 1, imagePath: '2027/sbcs/1.png' }
  ]).length, 1);
});
t('入参不是数组 / 空集 → 空任务表，不抛错', function () {
  assert.deepStrictEqual(CT.buildCoverTasks(null), []);
  assert.deepStrictEqual(CT.buildCoverTasks(undefined), []);
  assert.deepStrictEqual(CT.buildCoverTasks([]), []);
});
t('setIdOf 兼容带斜杠/无斜杠与大小写后缀', function () {
  assert.strictEqual(CT.setIdOf('2027/sbcs/5265.png'), '5265');
  assert.strictEqual(CT.setIdOf('/2026/SBCS/1434.PNG'), '1434');
  assert.strictEqual(CT.setIdOf(null), '');
  // ⚠️ 已知边界：challenge 图路径（sbcs/challenges/59.png）同样会被提取出 '59'。
  //    安全原因是它只作为**兜底来源的 srcUrl**，指纹 key 用原路径；端上 utils/sbcs.js#imgUrl
  //    的正则只认 `\d{4}/sbcs/\d+\.png`，challenge 路径不匹配 ⇒ 不会误拼成 set 封面 fileID。
  assert.strictEqual(CT.setIdOf('2027/sbcs/challenges/59.png'), '59');
});
t('真实 sbcs.json 回放：任务数 = 有 imagePath 的 set 数 + 兜底集，且文件名全满足 sbc_<数字>.webp', function () {
  const real = JSON.parse(fs.readFileSync(path.join(ROOT, 'cloud-data', 'fc27', 'sbcs.json'), 'utf8'));
  const rt = CT.buildCoverTasks(real.sets || []);
  const withIp = (real.sets || []).filter(s => s && s.imagePath).length;
  assert.ok(rt.length >= withIp, '任务数不该少于有 imagePath 的 set');
  rt.forEach(t => assert.ok(/^sbc_\d+\.webp$/.test(t.fileName), '非法文件名 ' + t.fileName));
  assert.strictEqual(new Set(rt.map(t => t.id)).size, rt.length, '任务表出现重复 id ⇒ 会漏传');
});
t('⚠️ 故意改坏：只喂有 imagePath 的 set（＝删掉兜底分支），5265/5266 必须消失', function () {
  // 本断言就是防「兜底被注释掉但测试仍绿」：只走老口径时，缺 imagePath 的两组根本不进任务表
  const broken = CT.buildCoverTasks(sample.filter(s => s.imagePath));
  assert.ok(!broken.some(t => t.id === '5265' || t.id === '5266'),
    '老口径下这两组本就不该进表 ⇒ 说明被测分支是真实的兜底路径而非文档字符串');
  assert.ok(!broken.some(t => t.fallback), '老口径不该有 fallback 任务');
});

console.log('\n结果: 通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail ? 1 : 0);
