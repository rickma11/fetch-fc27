// 稀有度档位一次性回填：把「Rare」改成 金 / 银 / 铜。
//
// ── 为什么需要 ───────────────────────────────────────────────────────────
// fut.gg 的 FC27 列表接口把**普通卡**的 rarityName 一律写成 "Rare"（rarityId 718 / rarityEaId 0），
// 真实档位在顶层 quality 字段（GOLD / SILVER / BRONZE）。pickPlayer 已在生成期接上
// sig.js 的 normalizeRarity（见 sig.js 顶部说明），但抓取是**增量**模式：
// 只有「新增 / 变化」的卡会重新成型，历史约 1 万条不会被改写 → 必须一次性回填。
//
// ⚠️ 只改「占位名」——Rare / Non-Rare / Common。特殊活动卡（Hall of FUT，以及后续
//    TOTW / POTM / 节日活动…）的名字**原样保留**（它们的 quality 也常是 GOLD，
//    按 quality 一刀切会被误改成金卡）。
// ⚠️ 档位从**已落库文档**反推（文档里没有 quality）：优先 rarity.imagePath 的
//    rarities-level-{1,2,3}（1=铜 2=银 3=金），解析不到再回落 overall
//    （EA 规则 铜 ≤64 / 银 65~74 / 金 75+）。实测两者对全部 10000 条完全等价。
// ⚠️ 与生成期共用 sig.js 的 tierFromStoredRarity / isGenericRarityName，口径不会分叉。
//
// ── 用法 ────────────────────────────────────────────────────────────────
//   node scripts/backfill_rarity.js                    # 生成补丁（读本地 players.json，不联网）
//   node scripts/backfill_rarity.js --limit 200        # 只取前 200 条（试跑）
//   node scripts/backfill_rarity.js --apply            # 补丁合并进本地数据文件（先备份）
//   node scripts/backfill_rarity.js --upload           # 补丁写云库 + 刷新 meta facets.rarities
//   node scripts/backfill_rarity.js --apply --upload
//   （--apply / --upload 不重新生成补丁，只消费已有补丁文件）
//
// 凭证：--upload 需要云开发凭证，走 scripts/tcb_env.js（环境变量或 .env.local）。
const fs = require('fs');
const path = require('path');
const { tierFromStoredRarity, isGenericRarityName } = require('./sig');

const VER = String(process.env.FC_VER || '27').replace(/[^0-9]/g, '') || '27';
const ROOT = path.resolve(__dirname, '..');
const MINIAPP = path.join(ROOT, '..', 'eafc-miniapp');
const DIR = path.join(ROOT, 'cloud-data', `fc${VER}`);
const PLAYERS = path.join(DIR, 'players.json');
const PATCH = path.join(DIR, 'rarity_patch.json');

const argv = process.argv.slice(2);
const hasFlag = (f) => argv.indexOf(f) >= 0;
const DO_APPLY = hasFlag('--apply');
const DO_UPLOAD = hasFlag('--upload');
let LIMIT = 0;
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith('--limit=')) LIMIT = Number(argv[i].slice(8)) || 0;
  else if (argv[i] === '--limit' && argv[i + 1]) LIMIT = Number(argv[++i]) || 0;
}

// 本地数据文件清单：kind 决定解析/回写方式
//   json-array   → [ {...}, ... ]           （列表全量）
//   json-object  → { "<eaId>": {...} }      （详情按 eaId 索引）
//   module       → module.exports = <json>; （小程序本地兜底文件）
//   preview      → { players:[], details:{}, hot:[] }（预览快照）
const LOCAL_TARGETS = [
  { rel: 'cloud-data/fc27/players.json', root: ROOT, kind: 'json-array' },
  { rel: 'cloud-data/fc27/details.json', root: ROOT, kind: 'json-object' },
  { rel: 'data/players_fc27.js', root: MINIAPP, kind: 'module' },
  { rel: 'data/details_fc27.js', root: MINIAPP, kind: 'module' },
  { rel: 'cloud-data/fc27/players.json', root: MINIAPP, kind: 'json-array' },
  { rel: 'cloud-data/fc27/details.json', root: MINIAPP, kind: 'json-object' },
  { rel: 'cloud-preview-data/fc27_cloud.json', root: MINIAPP, kind: 'preview' }
];

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; }
}

// 递归把「有 eaId 且有 rarity」的对象按补丁改名。
// 一套逻辑同时覆盖 players 数组 / details 映射 / preview 复合结构。
function patchTree(node, patch) {
  let n = 0;
  if (!node) return n;
  if (Array.isArray(node)) {
    node.forEach((x) => { n += patchTree(x, patch); });
    return n;
  }
  if (typeof node !== 'object') return n;
  if (node.rarity && node.eaId != null) {
    const hit = patch[String(node.eaId)];
    if (hit && node.rarity.name !== hit.name) { node.rarity.name = hit.name; n++; }
  }
  Object.keys(node).forEach((k) => {
    const v = node[k];
    if (v && typeof v === 'object') n += patchTree(v, patch);
  });
  return n;
}

// ---- 1) 生成补丁 ----
function buildPatch() {
  const list = readJson(PLAYERS, null);
  if (!Array.isArray(list)) {
    console.error('缺少或格式不对：' + path.relative(ROOT, PLAYERS));
    console.error('（该文件由 fetch_futgg.js full 模式产出；也可临时用 cloud-preview-data/fc27_cloud.json）');
    process.exit(1);
  }
  const src = LIMIT ? list.slice(0, LIMIT) : list;
  const patch = {};
  const byTier = { Gold: 0, Silver: 0, Bronze: 0 };
  const keptSpecial = {};
  let noTier = 0;
  src.forEach((p) => {
    const r = p.rarity;
    if (!r || !r.name) return;
    if (!isGenericRarityName(r.name)) {           // 特殊活动名：不动
      keptSpecial[r.name] = (keptSpecial[r.name] || 0) + 1;
      return;
    }
    const tier = tierFromStoredRarity(r, p.overall);
    if (!tier) { noTier++; return; }
    patch[String(p.eaId)] = { name: tier, from: r.name };
    byTier[tier]++;
  });
  fs.writeFileSync(PATCH, JSON.stringify(patch, null, 2));
  console.log(`FC${VER} 列表 ${src.length} 条 → 补丁 ${Object.keys(patch).length} 条`);
  console.log(`  金 Gold ${byTier.Gold} | 银 Silver ${byTier.Silver} | 铜 Bronze ${byTier.Bronze} | 无法判定 ${noTier}`);
  console.log('  原样保留的特殊活动 name：' + (Object.keys(keptSpecial).length ? JSON.stringify(keptSpecial) : '（无）'));
  console.log('  补丁文件：' + path.relative(ROOT, PATCH));
}

// ---- 2) 合并进本地文件 ----
function applyLocal() {
  const patch = readJson(PATCH, null);
  if (!patch) { console.error('补丁文件不存在：' + path.relative(ROOT, PATCH)); process.exit(1); }
  console.log('补丁 ' + Object.keys(patch).length + ' 条，开始合并本地文件：');
  LOCAL_TARGETS.forEach((t) => {
    const file = path.join(t.root, t.rel);
    if (!fs.existsSync(file)) { console.log('  · 跳过（不存在）' + t.rel); return; }
    const raw = fs.readFileSync(file, 'utf8');
    let data;
    if (t.kind === 'module') {
      const m = /^module\.exports\s*=\s*([\s\S]*);\s*$/.exec(raw);
      if (!m) { console.log('  ⚠️ 解析失败（不是 module.exports = <json>;）' + t.rel); return; }
      data = JSON.parse(m[1]);
    } else {
      try { data = JSON.parse(raw); } catch (e) { console.log('  ⚠️ JSON 解析失败 ' + t.rel); return; }
    }
    const n = patchTree(data, patch);
    if (!n) { console.log('  · 无需改动 ' + t.rel); return; }
    const bak = file + '.bak.rarity';
    if (!fs.existsSync(bak)) fs.copyFileSync(file, bak);
    // 保持原文件的换行风格（快照类文件是压缩成单行的，别给它撑大）
    const pretty = raw.indexOf('\n') !== -1;
    const out = t.kind === 'module'
      ? 'module.exports = ' + JSON.stringify(data, null, pretty ? 2 : 0) + ';\n'
      : JSON.stringify(data, null, pretty ? 2 : 0);
    fs.writeFileSync(file, out);
    console.log(`  ✓ ${t.rel} 改了 ${n} 处（备份 ${path.basename(bak)}）`);
  });

  // facets.json 的 rarities 也要跟着改（筛选面板下拉值）；CI 每天会从完整列表重算并覆盖，
  // 这里同步是为了让本地仓库镜像与云端 meta_fc{ver}/facets 保持一致，不留「Rare」误导排查。
  const facetsFile = path.join(DIR, 'facets.json');
  const facets = readJson(facetsFile, null);
  if (facets && Array.isArray(facets.rarities)) {
    const merged = Array.from(new Set(
      facets.rarities.filter((x) => !isGenericRarityName(x))
        .concat(Object.keys(patch).map((k) => patch[k].name))
    )).sort();
    if (JSON.stringify(merged) !== JSON.stringify(facets.rarities)) {
      console.log(`  facets.json rarities: ${JSON.stringify(facets.rarities)} → ${JSON.stringify(merged)}`);
      facets.rarities = merged;
      facets.updatedAt = new Date().toISOString();
      fs.writeFileSync(facetsFile, JSON.stringify(facets, null, 2));
      console.log('  ✓ cloud-data/fc' + VER + '/facets.json 已更新');
    }
  }
}

// ---- 3) 写云库 ----
async function upload() {
  const patch = readJson(PATCH, null);
  if (!patch) { console.error('补丁文件不存在：' + path.relative(ROOT, PATCH)); process.exit(1); }
  const cloudbase = require('@cloudbase/node-sdk');
  const tcb = require('./tcb_env');
  const cred = tcb.resolve();
  if (cred.missing.length) {
    console.error('缺少云开发凭证：' + cred.missing.join(' / '));
    console.error(cred.hint);
    process.exit(1);
  }
  const app = cloudbase.init({ env: cred.ENV_ID, secretId: cred.SECRET_ID, secretKey: cred.SECRET_KEY, timeout: 90000 });
  const db = app.database();
  const ids = Object.keys(patch);
  const CONC = Number(process.env.FC_RARITY_CONC || 10) || 10;
  console.log(`云端回填：凭证来源 ${cred.source}，共 ${ids.length} 条 × 2 集合（并发 ${CONC}）`);

  for (const col of [`players_fc${VER}`, `details_fc${VER}`]) {
    let cursor = 0, ok = 0, fail = 0, missing = 0;
    async function w() {
      while (true) {
        const i = cursor++;
        if (i >= ids.length) return;
        const id = ids[i];
        try {
          // 点号路径只改嵌套字段，不覆盖 rarity 的 id/eaId/imagePath
          const r = await db.collection(col).doc(String(id)).update({ 'rarity.name': patch[id].name });
          const n = r && r.updated != null ? Number(r.updated) : null;
          if (n === 0) missing++; else ok++;
        } catch (e) {
          fail++;
          if (fail <= 5) console.warn('  ⚠️ ' + id + ' 写入失败：' + String(e && e.message).slice(0, 120));
        }
        if ((ok + fail + missing) % 1000 === 0) console.log(`  [${col}] 已处理 ${ok + fail + missing}/${ids.length}（成功 ${ok} 未命中 ${missing} 失败 ${fail}）`);
      }
    }
    await Promise.all(Array.from({ length: CONC }, w));
    console.log(`  ✓ [${col}] 成功 ${ok} / 未命中 ${missing} / 失败 ${fail}`);
    if (fail) console.log('    提示：失败项多为文档不存在（已下架/换版本），可忽略。');
  }

  // 刷新 meta facets 的 rarities（筛选面板下拉值）—— 与云端既有值取并集，避免误删
  const mCol = `meta_fc${VER}`;
  const newNames = Array.from(new Set(Object.keys(patch).map((k) => patch[k].name)));
  let old = [];
  try {
    const cur = await db.collection(mCol).doc('facets').get();
    const doc = cur && cur.data && cur.data[0];
    old = (doc && Array.isArray(doc.rarities)) ? doc.rarities : [];
  } catch (e) {
    console.warn('  ⚠️ 读取 meta facets 失败（将直接覆盖 rarities）：' + String(e && e.message).slice(0, 120));
  }
  // 旧值里已经没有 'Rare' 语义了 → 若补丁覆盖了全部占位卡，就把占位名剔除
  const stillGeneric = old.filter((x) => isGenericRarityName(x));
  const merged = Array.from(new Set(old.filter((x) => !isGenericRarityName(x)).concat(newNames))).sort();
  console.log(`  facets.rarities: ${JSON.stringify(old)} → ${JSON.stringify(merged)}`);
  await db.collection(mCol).doc('facets').update({ rarities: merged, updatedAt: new Date().toISOString() });
  console.log('  ✓ meta facets 已更新');
}

(async () => {
  if (!DO_APPLY && !DO_UPLOAD) {
    buildPatch();
    console.log('下一步可选：node scripts/backfill_rarity.js --apply --upload');
    return;
  }
  if (DO_APPLY) applyLocal();
  if (DO_UPLOAD) await upload();
})().catch((e) => { console.error('异常：', e); process.exit(1); });
