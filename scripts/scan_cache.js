// scan_cache.js —— R29k：CI 三个脚本「共享同一次全表扫描」的中转层。
//
// 背景（09-27 定案）：套餐的「调用次数」＝数据库读+写+存储读+写+云函数调用**合并计数**，
//   其中**数据库读按「查询返回的文档条数」计**（一次 get() 返回 N 条 = N 次读）。
//   `sync_i18n.js` / `warm_roster.js` / `gen_squad_chem.js` 三个脚本**各自把 players_fc27
//   全表扫一遍**（实测 19,860 条 ⇒ 19,860 读 × 3 = **59,580 读/天**，占 04:00 尖峰的大头）。
//
// 设计取舍（关键）：**不把三个脚本物理合并**——`sync_i18n` 是三者中唯一没有
//   `continue-on-error` 的，合并后任何一步抛错都会让 CI job 红 ⇒ 当日 FC27 数据不更新，
//   且 roster/chem/names 三个产物同时丢失。改为「只共享扫描结果」，三个脚本的容错、
//   安全闸、产物逻辑一行不动。
//
// 契约：
//   · `write(ver, rows)` —— 由 scan 方（sync_i18n）在扫完库后调用，落盘本工作区文件。
//   · `read(ver)` —— 由消费方（warm_roster / gen_squad_chem）调用，带**三重守卫**；
//     任一守卫不过 ⇒ 返回 null ⇒ 消费方**退化为自己扫**（保持原行为，绝不写出半截数据）。
//
// 守卫（缺一不可）：
//   ① 参数 `--from-cache` 显式要求（CI step 里加，本地手动跑不带 ⇒ 走老路）
//   ② 文件新鲜：`Date.now() - ts <= MAX_AGE_MS`（默认 30 分钟；同一次 CI job 内必然新鲜，
//      跨 job 的陈旧缓存一律拒绝）
//   ③ 完整性与版本：`total >= MIN_TOTAL` 且 `ver` 匹配 ⇒ 沿用 warm_roster 的安全闸口径
//
// 用法：node 侧 require('./scan_cache.js')
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// ⚠️ 缓存文件体积 ≈ 19,860 条 × 469 B ≈ 8.9 MB，**必须进 .gitignore**，
//    否则会被 git 跟踪 ⇒ 仓库爆炸（本文件专用，别改路径）。
const CACHE_FILE = path.join(ROOT, 'cloud-data', 'fc27', '_scan_cache.json');

const MAX_AGE_MS = 30 * 60 * 1000;   // 守卫②：缓存新鲜度上限
const MIN_TOTAL = 19000;             // 守卫③：沿用 warm_roster.js 的安全闸口径

function wantCache() {
  return process.argv && process.argv.indexOf('--from-cache') >= 0;
}

// 写缓存（由 scan 方调用，失败只告警不阻断主流程）
function write(ver, rows) {
  try {
    const dir = path.dirname(CACHE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const body = {
      ver: String(ver),
      ts: Date.now(),
      total: Array.isArray(rows) ? rows.length : 0,
      rows: rows || []
    };
    fs.writeFileSync(CACHE_FILE, JSON.stringify(body));
    console.log('[scan_cache] 已写扫描缓存：' + body.total + ' 条 → ' +
      path.relative(ROOT, CACHE_FILE) + '（' + (fs.statSync(CACHE_FILE).size / 1048576).toFixed(1) + ' MB，0 云库读）');
    return true;
  } catch (e) {
    console.warn('[scan_cache] 写缓存失败（不影响主流程，消费方会各自扫）：' + String((e && e.message) || e));
    return false;
  }
}

// 读缓存（由消费方调用）→ { rows, total, ts } | null
function read(ver) {
  if (!wantCache()) return null;                 // 守卫①（未显式要求 ⇒ 不读）
  try {
    if (!fs.existsSync(CACHE_FILE)) { console.log('[scan_cache] 无缓存文件 ⇒ 走原路径自己扫'); return null; }
    const j = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    const ts = Number(j && j.ts) || 0;
    const rows = Array.isArray(j && j.rows) ? j.rows : null;
    if (!rows || !rows.length) { console.warn('[scan_cache] 缓存内容为空 ⇒ 拒绝使用'); return null; }
    if (String(j && j.ver) !== String(ver)) { console.warn('[scan_cache] 缓存版本不符（' + j.ver + '≠' + ver + '）⇒ 拒绝使用'); return null; }
    if (!ts || (Date.now() - ts) > MAX_AGE_MS) { console.warn('[scan_cache] 缓存已过期 ⇒ 拒绝使用'); return null; }
    // ⚠️ 闸门**只看 rows 的实际长度，不看文件里写的 total**（2026-09-27 单测实锤的洞）：
    //    只看 total ⇒ 一个「total: 19000、rows 只有 1 条」的畸形缓存会被放行，
    //    消费方拿到的就是一份半截数据，且**不报任何错** —— 正是本方案最危险的失效模式。
    //    rows 是唯一真源；文件里的 total 只作对账用的提示。
    const total = rows.length;
    if (Number(j && j.total) !== total) {
      console.warn('[scan_cache] ⚠️ 缓存自报 total=' + j.total + ' 与实际 rows.length=' + total + ' 不符 ⇒ 以实际长度为准');
    }
    if (total < MIN_TOTAL) { console.warn('[scan_cache] 缓存实际条数 ' + total + ' < ' + MIN_TOTAL + '（疑似半截）⇒ 拒绝使用'); return null; }
    console.log('[scan_cache] 命中缓存：' + total + ' 条（' + Math.round((Date.now() - ts) / 1000) + 's 前生成）⇒ 本次 **0 云库读**');
    return { rows: rows, total: total, ts: ts };
  } catch (e) {
    console.warn('[scan_cache] 读缓存异常 ⇒ 走原路径自己扫：' + String((e && e.message) || e));
    return null;
  }
}

// 按行遍历缓存（返回实际条数）。
// ⚠️ 存在的理由：消费方（gen_squad_chem）的「缓存分支」与「自扫分支」必须**逐行同语义**。
//    早期版本是在两个分支里各内联了一份循环 —— 典型的「改了这头忘那头」隐患
//    （本项目硬规则 52 就禁止这种内联第二份）。统一走这里，构图上就不可能漂移。
function forEachRow(rows, fn) {
  if (!rows || !rows.length) return 0;
  for (let i = 0; i < rows.length; i++) fn(rows[i]);
  return rows.length;
}

module.exports = {
  write: write, read: read, forEachRow: forEachRow,
  wantCache: wantCache, CACHE_FILE: CACHE_FILE
};
