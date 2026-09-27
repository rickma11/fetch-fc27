// R29k-P1「写前内容签名比对」守卫测试。
//
// 为什么必须守住这几条：签名一旦不稳定，upload_db 就会把「没变的卡」误判成变了 ⇒
// 周日全量重写照旧，P1 等于白做；一旦把 `_id` / `_sig` 算进去，所有卡每次写都变 ⇒
// 同样全量重写。所以下面每条都 **带反例自检**：故意改坏，必须变红。

const path = require('path');
const fs = require('fs');
const ROOT = path.resolve(__dirname, '..');
const cs = require(path.join(ROOT, 'scripts', 'content_sig.js'));

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name); }
}
function section(t) { console.log('\n[' + t + ']'); }

const base = {
  eaId: 231443, commonName: 'Dembélé', overall: 90, position: 'ST',
  club: { eaId: 73, name: 'Paris SG' }, playstyles: ['speed', 'dribble']
};

// ---------------------------------------------------------------- 稳定性
section('① 相同内容必须产出相同签名（否则每次写都变 = 签名失效）');
{
  const a = cs.sigOf(base);
  const b = cs.sigOf(JSON.parse(JSON.stringify(base)));   // 深拷贝后顺序/引用都不同
  ok(a === b && !!a, '深拷贝重排后签名一致');
}

section('② 反例自检：把 _id 算进签名 ⇒ 必须被拒绝');
{
  const a = cs.sigOf(Object.assign({}, base, { _id: '1' }));
  const b = cs.sigOf(Object.assign({}, base, { _id: '2' }));
  ok(a === b, '改 _id 不影响签名（_id 是主键，不该参与内容比较）');
  const a2 = cs.sigOf(Object.assign({}, base, { _sig: 'deadbeef' }));
  const b2 = cs.sigOf(Object.assign({}, base, { _sig: 'cafe c0de' }));
  ok(a2 === b2, '改 _sig 不影响签名（否则写一次签名就变，永远跳不过）');
}

// ---------------------------------------------------------------- 敏感性
section('③ 内容变了签名必须变（否则未变的卡会被漏写 = 数据丢失）');
{
  const a = cs.sigOf(base);
  const cases = [
    ['改 overall', Object.assign({}, base, { overall: 89 })],
    ['改字符串', Object.assign({}, base, { commonName: 'Dembele' })],
    ['改嵌套对象值', Object.assign({}, base, { club: { eaId: 74, name: 'Real' } })],
    ['加字段', Object.assign({}, base, { brandNew: 1 })],
    ['删字段', (function () { const c = Object.assign({}, base); delete c.position; return c; })()],
    ['改数组元素', Object.assign({}, base, { playstyles: ['speed', 'power'] })],
    ['数组顺序（顺序本身是内容）', Object.assign({}, base, { playstyles: ['dribble', 'speed'] })]
  ];
  let allDiff = true;
  for (const [label, mutated] of cases) {
    if (cs.sigOf(mutated) === a) { allDiff = false; console.log('    ✗ ' + label + ' 竟然同签'); }
  }
  ok(allDiff, '7 种改动全部产生不同签名（含嵌套/数组/增删字段）');
}

section('④ 反例自检：key 顺序不影响签名（JS 遍历顺序抖动会造成大面积假变更）');
{
  const a = { x: 1, y: 2, z: 3 };
  const b = { z: 3, y: 2, x: 1 };
  ok(cs.sigOf(a) === cs.sigOf(b), '对象 key 乱序签名一致');
}

// ---------------------------------------------------------------- 与文档字段的关系
section('⑤ 签名随文档一起写：不带签名时算出的是「内容签名」');
{
  const doc = Object.assign({}, base);
  delete doc._sig;
  const withSigField = Object.assign({}, base, { _sig: cs.sigOf(base) });
  ok(cs.sigOf(withSigField) === cs.sigOf(doc), '带 _sig 的文档算出的签名与不带时相同');
}

// ---------------------------------------------------------------- 落盘往返
section('⑥ 签名表落盘 / 读取往返');
{
  const map = { '231443': 'aaa', '166676': 'bbb' };
  cs.saveSigMap('27', map);
  let back = null;
  try { back = cs.loadSigMap(); } catch (e) { back = null; }
  ok(back && back['231443'] === 'aaa' && back['166676'] === 'bbb', '落盘后能原样读回');

  // 反例自检：文件损坏必须返回 null（调用方退化全量写），不能抛出去拖垮落库
  try {
    fs.writeFileSync(cs.CACHE_FILE, '{ this is not json');
    let r = null;
    try { r = cs.loadSigMap(); } catch (e) { r = undefined; }
    ok(r === null, '签名表损坏 ⇒ 返回 null ⇒ 退化全量写');
  } catch (e) {
    ok(false, '签名表损坏测试异常：' + e.message);
  }

  // 还原成一份正常表，免得污染后续手动验证
  cs.saveSigMap('27', map);
}

// ---------------------------------------------------------------- ⑦ 首建基线（2026-09-27 命坑回归）
// 背景：签名表缺失 ⇒ upload_db 走全量写分支。若这条路径不把 `_sig` 种进文档，
//       云库永远不会有 `_sig` ⇒ sync_i18n 投影恒空 ⇒ 下次落库读到的还是空表 ⇒ 机制**永久失效**。
section('⑦ 首建基线：stampSigs 把签名种进文档');
{
  const docs = [
    { _id: '1', eaId: 1, name: 'A', nested: { b: 2, a: [3, 4] } },
    { _id: '2', eaId: 2, name: 'B' }
  ];
  const before = docs.map(function (d) { return Object.assign({}, d); });

  cs.stampSigs(docs);
  ok(docs[0]._sig && docs[1]._sig, '两条都补上了 _sig');
  ok(docs[0]._sig === cs.sigOf(before[0]), '补上的 _sig 等于「原文」的签名');
  ok(docs[0]._id === '1' && docs[0].eaId === 1 && docs[0].name === 'A', '就地补签不破坏原有字段');

  // 幂等：再种一次不能改变已有签名，否则「内容没变」也会被判成变过 ⇒ 每次都重写
  const first = docs[0]._sig;
  cs.stampSigs(docs);
  ok(docs[0]._sig === first, '二次 stamp 不改变已有签名（sigOf 排除 _sig 自身）');

  // 反例自检：内容变了必须换签名（否则基线一但错，写库会永久漏更）
  const mutated = Object.assign({}, docs[0]);
  delete mutated._sig;
  mutated.name = 'A2';
  ok(cs.sigOf(mutated) !== first, '内容变了 ⇒ 签名必须不同');

  // 反例自检：脏输入不能把落库拖挂
  let threw = false;
  try { cs.stampSigs([]); cs.stampSigs(null); cs.stampSigs([null, undefined, 'x']); }
  catch (e) { threw = true; }
  ok(!threw, '空/脏输入不抛异常');
}

// ---------------------------------------------------------------- 清理
try {
  if (fs.existsSync(cs.CACHE_FILE)) fs.unlinkSync(cs.CACHE_FILE);
  console.log('\n[清理] 已删除测试产生的签名表 ' + path.relative(ROOT, cs.CACHE_FILE));
} catch (e) { /* 清理失败不影响结论 */ }

console.log('\n' + (fail ? '✗' : '✓') + '：' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
