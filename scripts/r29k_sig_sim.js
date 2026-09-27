// R29k-P1 写前签名比对的**离线模拟**：不连云库，只用真实 players.json 验证比对逻辑。
//
// 用法：node scripts/r29k_sig_sim.js [抽样条数]
// 回答三个问题：
//   ① 同内容二次比对 ⇒ 应该 100% 跳过（证明「周日全量重写」能被治掉）
//   ② 改 1 条内容 ⇒ 应该只写 1 条（证明不会漏写数据）
//   ③ 删 1 条字段 ⇒ 也应该被识别（证明「删字段」这种改动不会静默丢失）

const path = require('path');
const fs = require('fs');
const ROOT = path.resolve(__dirname, '..');
const cs = require('./content_sig.js');

const N = Number(process.argv[2] || 1000);
const FILE = path.join(ROOT, 'cloud-data', 'fc27', 'players.json');

let all = [];
try { all = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) {
  console.error('读 players.json 失败：' + e.message);
  process.exit(2);
}
const docs = all.slice(0, N).map(function (p) {
  return Object.assign({}, p, { _id: String(p.eaId) });   // 与 upload_db full 分支一致
});
console.log('样本：真实 players.json 前 ' + docs.length + ' 条（云库主键 _id = String(eaId)）');

// —— 复刻 upload_db#upsertAll 的比对内核（保持单一实现思路，不另抄一份逻辑） ——
function filterBySig(docs, sigMap) {
  const need = [];
  let same = 0;
  for (const d of docs) {
    const s = cs.sigOf(d);
    const old = sigMap ? sigMap[String(d._id)] : null;
    if (old && old === s) { same++; continue; }
    d._sig = s;
    need.push(d);
  }
  return { need: need, same: same };
}

let bad = 0;
function check(cond, label) {
  console.log((cond ? '  ✅ ' : '  ❌ ') + label);
  if (!cond) bad++;
}

// ① 同内容二次比对 ⇒ 应全部跳过
const first = filterBySig(docs, null);          // 首次上线：无签名表 ⇒ 全写建基线
const second = filterBySig(docs, (function () {
  const m = {};
  for (const d of docs) m[String(d._id)] = cs.sigOf(d);
  return m;
})());
console.log('\n① 首次上线（无签名表）⇒ ' + first.need.length + ' 条写入 / ' + first.same + ' 条跳过');
console.log('② 同内容二次比对      ⇒ ' + second.need.length + ' 条写入 / ' + second.same + ' 条跳过');
check(first.need.length === docs.length, '首次上线全量建立基线（无签名表时不能静默漏写）');
check(second.same === docs.length, '同内容二次比对 100% 跳过（治「周日全量重写」的关键）');

// ② 改 1 条
const mut = JSON.parse(JSON.stringify(docs));
mut[7].overall = (mut[7].overall || 0) + 1;
const r2 = filterBySig(mut, (function () {
  const m = {};
  for (const d of docs) m[String(d._id)] = cs.sigOf(d);
  return m;
})());
console.log('\n③ 改 1 条内容          ⇒ 写 ' + r2.need.length + ' 条 / 跳过 ' + r2.same + ' 条');
check(r2.need.length === 1, '改 1 条只写 1 条（其余不该被误判）');
check(r2.same === docs.length - 1, '其余 ' + (docs.length - 1) + ' 条正确跳过');

// ③ 删 1 个字段 ⇒ 必须被识别（防「删字段静默丢失」）
const dele = JSON.parse(JSON.stringify(docs));
delete dele[3].position;
const r3 = filterBySig(dele, (function () {
  const m = {};
  for (const d of docs) m[String(d._id)] = cs.sigOf(d);
  return m;
})());
console.log('④ 删 1 个字段          ⇒ 写 ' + r3.need.length + ' 条 / 跳过 ' + r3.same + ' 条');
check(r3.need.length === 1, '删字段也能识别（不会被当成「未变」而漏写）');

// ④ 数组/嵌套变化
const nest = JSON.parse(JSON.stringify(docs));
nest[5].club = { eaId: 1, name: 'X' };
const r4 = filterBySig(nest, (function () {
  const m = {};
  for (const d of docs) m[String(d._id)] = cs.sigOf(d);
  return m;
})());
console.log('⑤ 改 1 个嵌套字段      ⇒ 写 ' + r4.need.length + ' 条');
check(r4.need.length === 1, '嵌套对象变化也能识别');

console.log('\n' + (bad ? '✗ 模拟发现 ' + bad + ' 处问题' : '✓ 模拟全部通过'));
process.exit(bad ? 1 : 0);
