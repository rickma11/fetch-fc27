// 全息卡（holographic）采集模型 —— 唯一真源。
//
// ── 这个模块解决什么问题 ──────────────────────────────────────────────────────
// fut.gg 的「全息卡」在**页面上**表现为一个 `Item version` 切换器：Standard ↔ Pristine
// Holographic。点一下会跳到**另一个 item 的 URL**（Yamal 标准 67386507 → 全息 50609291），
// 那张卡的球员名是金色手写签名体、卡框带镭射环 —— 它是一条**独立的 item**。
//
// 但「关联关系」藏在哪，经历过两次踩坑才摸清：
//   ❌ 列表接口（players/v2/{ver}/）的 holographicType / standardItemEaId → 标准 item 上恒 null，
//      且全息变体**完全不在列表里**（列表只有 19799 条标准条目）。
//   ❌ 详情接口（player-item-definitions/{ver}/{eaId}/）的 itemVariants → **恒返回 []**。
//   ❌ all-versions/{baseEaId}/ → 只有 FC25/26 历史代，没有 27-{变体}。
//   ❌ 球员页 HTML 的 RSC 流里有值，但那是页面渲染产物，不适合批量抓。
//   ✅ definition-data/?game={ver}&slugs=27-{eaId},… —— **支持批量（上限 50）**，
//      返回的条目自带 itemVariants: [{eaId, holographicType}] —— 这才是真源。
//
// ── 只采集 pristine（用户决策 2026-09-22）────────────────────────────────────
// 全量实测（19797 人）：带全息形态的共 **264 人**，按变体类型分两类 ——
//   · pristine    164 人 ——「Pristine Holographic 版本」（金色签名体 + 镭射环），**本次采集目标**
//   · holographic 100 人 —— 另一种全息形态，**按需求不采集**（要放开只需往 HOLO_KINDS 加值）
// 变体条目形态：itemVariants = [{eaId: 标准卡, holographicType: null},
//                              {eaId: 变体卡, holographicType: "pristine"}]
//   例：Yamal 67386507 → 变体 50609291、Raya 67329765 → 变体 50552549
//   变体**不在列表里**（列表只有 19799 条标准条目）⇒ 列表驱动的管线天然看不到，必须单独查。
// ⚠️ 另有「条目自身就是那张全息卡」（itemVariants 里变体 eaId == 自身）的情形：pristine 下实测 0 例，
//    语义上也不成立（自己和自己不构成「版本」）⇒ pickHoloVariant 直接跳过，不做兜底。
//
//   落库字段（都挂在**基础球员**身上，端上 UI 不区分形态）：
//     · holographicType     —— 全息形态类型（当前恒为 "pristine"）
//     · holoVariantEaId     —— 承载全息卡面的那个变体 item 的 eaId
//     · holoCardImagePath   —— 该变体条目的 cardImagePath（EA 官方卡面，2027/player-item-card/…）
//
//   ⚠️ 卡面必须取**变体条目**的 cardImagePath：标准条目的那张是同名但无光效的平版。
//      实测 Yamal：标准 67386507 → …27-67386507.4efe2d…；变体 50609291 → …27-50609291.4b6ed9…
//
// ── 为什么不需要「跨模式签名兜底」的复杂逻辑 ──────────────────────────────────
// 本模块的采集是**每次 run 全量查**（396 批 × 50，并发下约 1 分钟），与「详情只抓变化球员」
// 的增量策略**无关** ⇒ 每轮都能得到完整答案，签名在 full / incremental 之间天然一致。
// 但清单仍要落盘（cloud-data/fc{ver}/holo.json）并随仓库提交，原因是：
//   ① 图片阶段要读它（images.js#imgSigOf 吃 holoCardImagePath）；
//   ② 某轮采集抖动时用旧值兜底，避免签名缺段 → 全库图片重下（见 mergeMap 的 complete 语义）。
const fs = require('fs');
const path = require('path');

// fut.gg 的 definition-data 端点。⚠️ 必须**浏览器同源**（裸 HTTP 被 Cloudflare 挡 403）。
const DD = 'https://www.fut.gg/api/fut/players/v2/definition-data/';

// slugs 批量上限：实测 50 稳定；100 报 HTTP 400。保守取 50，并在 fetch_ci 侧按批降半兜底。
const BATCH = Number(process.env.FC_DD_BATCH || 50) || 50;

// 只采集这些全息形态（用户决策 2026-09-22：只要 pristine）。
// 要放开别的形态（如 "holographic"）只需往数组里加值 —— 其余逻辑（补查变体卡面、清单落盘、
// 落库回写、端上展示）全是形态无关的，无需改动。
const HOLO_KINDS = ['pristine'];

// ---- 纯函数（可单测，无 IO）--------------------------------------------------

// 从 definition-data 的一个条目解出「要采集的全息变体」。
// 返回 { type, variantEaId } 或 null（该球员没有要采集的全息版本）。
// ⚠️ 只认 itemVariants 里 holographicType ∈ HOLO_KINDS 的**其他**条目，三重过滤：
//    · holographicType 为空的是标准条目自己（跳过）；
//    · 类型不在 HOLO_KINDS 里的（如 "holographic"）按决策不采集（跳过）；
//    · 变体 eaId == 条目自身 ⇒ 自己就是那张全息卡，不构成「版本」（跳过）。
//    刻意**不做**「条目自身带 holographicType 就取自己」的兜底 —— 那正是被排除的那类。
function pickHoloVariant(item) {
  if (!item || item.eaId == null) return null;
  const vs = Array.isArray(item.itemVariants) ? item.itemVariants : [];
  for (const v of vs) {
    if (!v || v.eaId == null) continue;
    if (typeof v.holographicType !== 'string' || !v.holographicType) continue;
    if (HOLO_KINDS.indexOf(v.holographicType) < 0) continue;
    if (Number(v.eaId) === Number(item.eaId)) continue;
    return { type: v.holographicType, variantEaId: Number(v.eaId) };
  }
  return null;
}

// 把某条目的卡面路径取出来。⚠️ 调用方必须传入**变体条目**（pickHoloVariant 给的 variantEaId
// 对应的那条）—— 基础条目那张是同名但**无全息光效**的平版，传错就等于没做这个功能。
function cardPathOf(item) {
  return (item && item.cardImagePath) ? String(item.cardImagePath) : '';
}

// 按 eaId 索引 definition-data 的响应体 → { eaId: item }
// ⚠️ 返回数组**顺序不保证**与请求顺序一致（实测 batch2 里 Corona 排第一、Yamal 第二），
//    所以一律按 eaId 建索引，绝不允许靠位置取值。
function indexByEaId(json) {
  const out = {};
  const arr = (json && Array.isArray(json.data)) ? json.data : [];
  for (const it of arr) {
    if (it && it.eaId != null) out[String(it.eaId)] = it;
  }
  return out;
}

function chunks(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

// 合并新旧清单：
//   complete=true  → 以新结果为准（允许清掉「已被 EA 摘掉全息」的幽灵条目）
//   complete=false → 只增不减（本轮有批次失败，不能据残缺结果删别人的图）
function mergeMap(oldMap, newMap, complete) {
  if (complete) return Object.assign({}, newMap);
  const out = {};
  Object.keys(oldMap || {}).forEach(k => { out[k] = oldMap[k]; });
  Object.keys(newMap || {}).forEach(k => { out[k] = newMap[k]; });
  return out;
}

// ---- 清单落盘（cloud-data/fc{ver}/holo.json）--------------------------------
// 结构：{ "67386507": "2027/player-item-card/27-50609291.<sha>.webp" }  ← 基础球员 eaId → 变体卡面
// ⚠️ 这份清单**必须随仓库提交**（.github/workflows/fetch-fc27.yml 的 Commit version history
//    步骤里的 git add），否则每次 run 从零开始 → 退化成「每天把全息面重下一遍」。
function manifestPath(ver) {
  return path.resolve(__dirname, '..', 'cloud-data', `fc${ver || 27}`, 'holo.json');
}

function readMap(ver) {
  try {
    const j = JSON.parse(fs.readFileSync(manifestPath(ver), 'utf8'));
    return (j && typeof j === 'object' && !Array.isArray(j)) ? j : {};
  } catch (e) { return {}; }
}

function writeMap(ver, obj) {
  const p = manifestPath(ver);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const out = {};
  Object.keys(obj || {}).map(Number).filter(n => !isNaN(n)).sort((a, b) => a - b)
    .forEach(n => { out[n] = obj[n]; });
  fs.writeFileSync(p, JSON.stringify(out));
  return out;
}

module.exports = {
  DD, BATCH, HOLO_KINDS,
  pickHoloVariant, cardPathOf, indexByEaId, chunks, mergeMap,
  manifestPath, readMap, writeMap
};
