#!/usr/bin/env node
// R29k-P1「自举重放」：用**真实数据**在本地把一次完整的 D1→D2 闭环跑通，证明
// 「首建基线」修复之后 P1 能真正自举——而不是看起来在跑、实际永远建不起签名表。
//
// 背景（2026-09-27 实锤的致命坑）：
//   upload_db 的签名比对分支只在 sigMap 非空时给文档写 `_sig`；首建基线时 sigMap===null，
//   走的是全量写。修复前那一支不给文档加 `_sig` ⇒ 云库永远存不下签名 ⇒ sync_i18n 投影出的
//   签名表恒为空 ⇒ 下次落库读到的还是空表 ⇒ **P1 从未生效过**。
//   本脚本就是把这个「自举」过程完整重放一遍，任何一环断了都会红。
//
// 只做本地推演，**不写云库、不碰真实签名表**（签名表一律走 R29K_SIG_CACHE 指向临时文件）。
// 用法：cd fetch-fc27 && node scripts/r29k_bootstrap_replay.js [--ver 27]

const fs = require('fs');
const path = require('path');
const os = require('os');

// 把签名表重定向到临时目录：绝不覆盖/删除 cloud-data/fc27/_sig_cache.json 这份真基线。
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'r29k-replay-'));
process.env.R29K_SIG_CACHE = path.join(tmpDir, '_sig_cache.json');

const ROOT = path.resolve(__dirname, '..');
const contentSig = require('./content_sig.js');
const VER = (function () {
  const i = process.argv.indexOf('--ver');
  return (i >= 0 && process.argv[i + 1]) ? process.argv[i + 1] : '27';
})();

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  PASS ' + name + (extra ? '  [' + extra + ']' : '')); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  [' + extra + ']' : '')); }
}
function section(t) { console.log('\n[' + t + ']'); }

async function main() {
  // 用真实快照做输入：它同时扮演「明天 CI 抓回来的新数据」和「本地 players.json 旧快照」两种角色。
  const PLAYERS = path.join(ROOT, 'cloud-data', 'fc27', 'players.json');
  // ⚠️ 必须深拷贝一层：stampSigs 会给文档对象加 _sig，若与 raw 共享引用，
  //    后面拿 raw 当「明天抓取结果」去比时基线已经是它自己算出来的 ⇒ 全程自证（2026-09-27 踩过）。
  const raw = JSON.parse(fs.readFileSync(PLAYERS, 'utf8'));
  const docs = raw.map(function (d) { return Object.assign({}, d); });
  for (const d of docs) { if (d._id === undefined || d._id === null) d._id = String(d.eaId); }
  console.log('输入：' + PLAYERS + '（' + docs.length + ' 条）');

  // ---------------------------------------------------------------- A. D1 自举
  section('A. D1 首建基线：sigMap === null ⇒ upload_db 必须把 _sig 种进文档');
  const sigMapBefore = contentSig.loadSigMap();
  ok(sigMapBefore === null, '前置条件：本地无签名表（首次上线的真实状态）');

  // 忠实复刻 upload_db 的这一支：
  //     } else if (sigMap === null) { contentSig.stampSigs(docs); }
  contentSig.stampSigs(docs);
  const stamped = docs.filter(function (d) { return typeof d._sig === 'string' && d._sig.length; });
  ok(stamped.length === docs.length,
    '全部文档都被种上 _sig（少了这几行 P1 就永远建不起基线）',
    stamped.length + '/' + docs.length);
  ok(contentSig.sigOf(docs[0]) === docs[0]._sig, '种上的 _sig 与该内容自洽（等于 sigOf）');
  // 反例自检：假如此处把 _sig 也算进签名，换一个 _sig 值签名就会跟着变 ⇒ 永远跳不过。
  const sigWithA = contentSig.sigOf(Object.assign({}, docs[0], { _sig: 'aaaa' }));
  const sigWithB = contentSig.sigOf(Object.assign({}, docs[0], { _sig: 'bbbb' }));
  ok(sigWithA === sigWithB, '反例自检：改 _sig 不影响签名（否则写一次签名就变，永远跳不过）');

  // ---------------------------------------------------------------- B. 扫描投影
  section('B. sync_i18n 扫描投影：从文档取 _sig 组成签名表（零额外云库读）');
  const sigMap = {};
  let emptySig = 0;
  for (const d of docs) {
    const k = String(d._id);
    if (d._sig) sigMap[k] = d._sig; else emptySig++;
  }
  ok(Object.keys(sigMap).length === docs.length, '签名表条数 = 文档条数', Object.keys(sigMap).length);
  ok(emptySig === 0, '没有空签名', 'empty=' + emptySig);
  // 反例自检：如果签名算得不稳定，这里的条数会因为「同内容不同签名」而无意义——
  // 用一次重复计算确认同一内容两次必得同一签名（不稳定 ⇒ 下面 D2 会 0 跳过，机制失效）。
  const twice = {};
  let unstable = 0;
  for (const d of docs) {
    const k = String(d._id);
    if (twice[k] !== undefined && twice[k] !== contentSig.sigOf(d)) unstable++;
    twice[k] = contentSig.sigOf(d);
  }
  ok(unstable === 0, '反例自检：重算同一内容签名恒定（不稳定会让 D2 永远写满）', 'unstable=' + unstable);

  // ---------------------------------------------------------------- C. cache 往返
  section('C. Actions Cache 往返：save → restore（模拟 CI 跨 run 传递）');
  contentSig.saveSigMap(VER, sigMap);
  const back = contentSig.loadSigMap();
  ok(!!back, 'restore 读回了签名表');
  const backKeys = back ? Object.keys(back) : [];
  ok(backKeys.length === Object.keys(sigMap).length, '往返后条数一致', backKeys.length);
  let hit = 0;
  for (let i = 0; i < 200 && i < backKeys.length; i++) {
    const k = backKeys[(i * 97) % backKeys.length];   // 抽样散开
    if (back[k] === sigMap[k]) hit++;
  }
  ok(hit === 200, '抽样 200 条签名逐条一致（cache 无截断/无损坏）', hit + '/200');
  // 损坏/半截的表必须被loadSigMap 判为 null（退化全量写），绝不能拿半个基线去做比对
  // ——否则「比一半」会静默漏写一批卡，比全量写还危险。
  const goodRaw = fs.readFileSync(process.env.R29K_SIG_CACHE, 'utf8');
  let rejected = 0;
  for (const junk of ['{}', '{ this is not json']) {
    fs.writeFileSync(process.env.R29K_SIG_CACHE, junk);
    if (contentSig.loadSigMap() === null) rejected++;
  }
  ok(rejected === 2, '缺 map / 非 JSON 两种损坏都被判为 null（退化全量写）', rejected + '/2');
  fs.writeFileSync(process.env.R29K_SIG_CACHE, goodRaw);   // 还原，后续步骤用完整表

  // ---------------------------------------------------------------- D. D2 幂等
  section('D. D2 落库预演：内容未变 ⇒ 必须一条都不写');
  const baseline = contentSig.loadSigMap() || {};
  const repl = function (docsIn, baselineIn) {
    const need = []; let same = 0;
    for (const d of docsIn) {
      const s = contentSig.sigOf(d);
      const old = baselineIn[String(d._id)];
      if (old && old === s) { same++; continue; }
      need.push(d);
    }
    return { same: same, need: need };
  };
  let r = repl(docs, baseline);
  ok(r.need.length === 0, '同一批内容二次落库 ⇒ 0 写入（幂等）',
    '写 ' + r.need.length + ' / 跳过 ' + r.same);

  section('E. 变化识别：真变了必须写得出来（防止「永远跳过 = 永远不更新」）');
  const mutated = docs.slice();
  const K = 37;
  for (let i = 0; i < K && i < mutated.length; i++) {
    mutated[i].overall = (mutated[i].overall || 80) + 1;   // 只改一个字段
  }
  r = repl(mutated, baseline);
  ok(r.need.length === K, '改了 ' + K + ' 条 ⇒ 只写 ' + r.need.length + ' 条',
    '写 ' + r.need.length + ' / 跳过 ' + r.same);
  const stillSame = repl(mutated, (function () {
    const b = Object.assign({}, baseline);
    for (const d of r.need) b[String(d._id)] = contentSig.sigOf(d);
    return b;
  })());
  ok(stillSame.need.length === 0, '写完刷新签名后再次落库 ⇒ 又回到 0 写入',
    '写 ' + stillSame.need.length);

  // ---------------------------------------------------------------- F. 真实量级
  section('F. 量级估算：基线必须取自**真实云库**，不能拿本脚本刚算的表（拿自己比自己 = 自证）');
  const stripImg = function (o) {
    const c = Object.assign({}, o);
    for (const k of Object.keys(c)) if (/ImagePath$/.test(k)) delete c[k];
    return c;
  };
  const REAL = path.join(ROOT, 'cloud-data', 'fc27', '_sig_cache.json');
  if (!fs.existsSync(REAL)) {
    console.log('  SKIP：本机没有真实云库基线。先跑 `node scripts/r29k_sig_verify.js`（约 19,900 次读）落一份。');
    console.log('        （本段衡量的是「快照时距」，不是明天跳过率；明天跳过率只能由 CI 日志读出。）');
  } else {
    const realBase = JSON.parse(fs.readFileSync(REAL, 'utf8')).map || {};
    const real = repl(raw, realBase);
    console.log('  基线 = 云库现内容 ' + Object.keys(realBase).length + ' 条；比对对象 = 本地快照 ' + raw.length + ' 条');
    console.log('  真实口径可跳过 ' + real.same + ' 条 / 必写 ' + real.need.length + ' 条');
    console.log('  ⇒ 两者差 5 天（快照 9-22 vs 云库今天），所以这个数衡量**快照时距**，');
    console.log('     它会低估明天的跳过率。明天的真实数 = 明天抓取结果 vs 云库现内容，只能由 CI 日志读出。');
    // ⚠️ 本段刻意**不**报「摘图后一致率」：这里只有签名表、没有云库原文档，摘图必须两边同摘才对等；
    //    拿「摘图后的本地签名」去比「未摘图的云库签名」是口径不对等，必然假红（2026-09-27 已踩过两次）。
    //    稳定性口径由 r29k_sig_verify.js ③ 承担（它在扫描时手里有云库原文档，两边同摘才成立）。
  }

  // ---------------------------------------------------------------- 清理
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch (e) { /* 清理失败不影响结论 */ }

  console.log('\n' + (fail ? '✗' : '✓') + '：' + pass + ' 通过 / ' + fail + ' 失败');
  console.log('结论：' + (fail
    ? '自举链路断了，明天的全量写会退化成「写了但不建基线」——必须先修。'
    : '自举链路完整，首建基线会真的把 _sig 种进云库，后天起写入量随真实变化量。'));
  process.exit(fail ? 1 : 0);
}

main().catch(function (e) { console.error(e && e.stack || e); process.exit(1); });
