// 「写前内容签名比对」的签名计算 + 签名表落盘。
//
// 为什么需要它（R29k-P1，治「周日全量重写」）：
//   upload_db 在 full 模式会对 players_fc27 / details_fc27 各 19,860 条**逐条 doc(id).set 整体覆盖**，
//   不管内容有没有变 —— 周日一次就是 ~39,720 次写。绝大多数卡 EA 根本没改。
//
// 机制：
//   ① 每次写库，把本条内容的签名 `_sig` **一起写进文档**（随文档走）。
//   ② 下次写库前，先扫一遍全表、只投影 `eaId + _sig`（1 次全表扫描，与落库共用一次读），
//      和本次要写的内容签名逐条比对。
//   ③ 一致 ⇒ 0 读 0 写，直接跳过；不一致或缺失 ⇒ 才写，并把新的 `_sig` 落进文档。
//   ④ 首次上线时文档里没有 `_sig` ⇒ 全部当作「需要写」，走一遍建立基线；之后开销即随变化量。
//
// ⚠️ 红线（`_sig` 必须随文档一起写）：
//   · 签名必须排除 `_sig` 自身，否则每次写都变 = 签名永远失效。
//   · 必须「写成功才 eventual-consistent」，签名随文档落盘，不存在「写失败却刷新了签名」的窗口
//     （失败重试时旧签名还在，下次会再写一次 —— 安全方向退化，不会漏写）。
//   · 序列化必须 key 排序稳定，否则 JS 对象遍历顺序变化会造成大面积假变更。
//
// 与 snapshot 的 `sig.js#sigOfRaw` 不是一回事，二者并存、各管一段：
//   · `sigOfRaw` 覆盖「列表 26 个字段」→ 决定**要不要重抓详情**（抓取侧增量）
//   · `contentSig` 覆盖**整条文档内容**   → 决定**要不要重写入库**（落库侧增量）
//   两者都进 `_sig` 字段吗？不 —— 文档里只存整篇内容的签名一个，抓取侧另有 `snapshot.json` 管。

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
// ⚠️ 单测必须能把它指到临时目录，否则测试跑完会把**真实基线**删掉（2026-09-27 实锤：
//    验证脚本刚落盘的 19,860 条签名表，被随后的「跑全量测试确认」unlink 掉了，白跑一次 19,900 读）。
//    生产路径不受影响；CI 不跑单测，但本地一旦两者交替就会静默丢基线。
const CACHE_FILE = process.env.R29K_SIG_CACHE
  ? path.resolve(process.env.R29K_SIG_CACHE)
  : path.join(ROOT, 'cloud-data', 'fc27', '_sig_cache.json');

// 这些字段不参与内容签名：`_id` 是主键、`_sig` 是签名本身、其余是云开发自增/托管字段。
const SKIP_KEYS = new Set(['_id', '_sig', '_openid', '_createTime', '_updateTime']);

/** 稳定序列化：对象按 key 排序，数组保持顺序（数组顺序本身就是内容的一部分）。 */
function stable(v) {
  if (v === null || v === undefined) return '';
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
  if (typeof v === 'object') {
    const keys = Object.keys(v).sort();
    return '{' + keys.map(function (k) { return k + ':' + stable(v[k]); }).join(',') + '}';
  }
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NaN';
  if (typeof v === 'boolean') return v ? '1' : '0';
  return String(v);
}

/** 整条文档的内容签名（hex）。 */
function sigOf(doc) {
  const parts = [];
  const keys = Object.keys(doc || {}).sort();
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    if (SKIP_KEYS.has(k)) continue;
    parts.push(k + '=' + stable(doc[k]));
  }
  return crypto.createHash('sha1').update(parts.join('')).digest('hex');
}

/** 给一条待写文档补上 `_sig` 字段（就地修改后返回），供 doc(id).set 一起写入。 */
function withSig(doc) {
  if (!doc || typeof doc !== 'object') return doc;
  // 签名必须排除 _sig 自身 ⇒ 先删掉再算
  const had = Object.prototype.hasOwnProperty.call(doc, '_sig');
  const old = doc._sig;
  if (had) delete doc._sig;
  const s = sigOf(doc);
  doc._sig = s;
  if (!had && old !== undefined) {
    // 调用方原本没带 _sig，这里算完原样不改回去，避免调错顺序；仅在极端情况谨慎。
  }
  return doc;
}

/**
 * 给整批待写文档**就地**补上内容签名（供后续随文档一起写入云库）。
 *
 * ⚠️ 只应该在「首建基线」时调用，也就是**签名表缺失、本次必然全量写**的那条路径。
 *    它是整套机制的种子：文档一旦有了 `_sig`，下次全表扫描投影才能投影出内容，
 *    落进签名表给下一次落库比对。少了这一步 ⇒ 云库永远不会有 `_sig` ⇒ 签名表恒空 ⇒ 机制永久失效
 *    （2026-09-27 实测推演出的致命坑，已加 `test/content_sig.test.js` 回归）。
 */
function stampSigs(docs) {
  for (let i = 0; i < (docs || []).length; i++) {
    const d = docs[i];
    if (!d || typeof d !== 'object') continue;
    d._sig = sigOf(d);
  }
  return docs;
}

/** 读签名表 { "eaId": "sig..." }；文件不在/损坏 ⇒ 返回 null（调用方退化成全量写）。 */
function loadSigMap() {
  try {
    if (!fs.existsSync(CACHE_FILE)) return null;
    const j = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    if (!j || typeof j.map !== 'object' || !j.map) return null;
    return j.map;
  } catch (e) {
    console.warn('[content_sig] 签名表读取失败，退化全量写：' + e.message);
    return null;
  }
}

/** 落盘签名表 {ver, ts, total, map}。失败只告警，绝不因此中断落库。 */
function saveSigMap(ver, map) {
  try {
    const payload = {
      ver: ver,
      ts: new Date().toISOString(),
      total: Object.keys(map || {}).length,
      map: map || {}
    };
    fs.writeFileSync(CACHE_FILE, JSON.stringify(payload));
    console.log('[content_sig] 签名表已落盘：' + payload.total + ' 条 → ' +
      path.relative(ROOT, CACHE_FILE));
  } catch (e) {
    console.warn('[content_sig] 签名表落盘失败（不影响本次落库）：' + e.message);
  }
}

module.exports = {
  sigOf: sigOf,
  withSig: withSig,
  stable: stable,
  loadSigMap: loadSigMap,
  saveSigMap: saveSigMap,
  stampSigs: stampSigs,
  CACHE_FILE: CACHE_FILE
};
