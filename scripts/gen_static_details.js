// 详情分层静态化生成脚本（取代 gen_hot_details.js，方案 docs/35，2026-10-16）。
//
// 目标：把「高分 + 热门」球员的详情文档（details_fc{ver}）按 **评分段 + 联赛/国家队** 烤成云存储静态 JSON，
//       端上经 utils/cloudJson.js#getStaticShardRecord 直读、零云函数调用（详见 docs/35）。
//
// 与旧 gen_hot_details 的关键区别：
//   - 不依赖 player_hot 浏览埋点（旧方案因此与 P4 冲突），改为纯按 overall/league/nation 分层。
//   - 覆盖从 ~434（旧 Top-N）扩到 ~12393 人（85+ / 80-84 五大热门 / 75-79 / ≤74 五大+热门）。
//   - ≤74 按「联赛或国家队 × rating 三段(70-74/65-69/≤64)」切，点击触发时只下该段（下载更小）。
//
// 分类函数 classifyKey(p, big5, hot) 必须与端上 utils/cloudJson.js#shardKeyOf 逐字一致（同一份口径）。
//
// 原子发布：所有分片先上传到云存储，最后才写 meta 元文档（detail_static）指向 manifest。
//   任何上传失败 → 不写 meta → 线上仍是「上一次成功的全量」→ 端上自动读昨天，无感回退。
//
// 复用 gen_hot_details.js 已验证的上传稳态：cloudbase.init({timeout:180000}) + 单文件 3 次重试 / race=200s + 4 并发 + 回读校验。
//
// 用法：node scripts/gen_static_details.js [ver] [--no-upload]
//   环境变量：FC_VER（默认 27）、DETAILS_TIMEOUT_MS（默认 20min）
//   --no-upload：只本地计算 + 落盘到 probe/static_details/，打印分层体积与解析到的 大五/热门 名单，不上传。

'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cloudbase = require('@cloudbase/node-sdk');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'probe', 'static_details');
fs.mkdirSync(OUT_DIR, { recursive: true });

const VER = Number(process.argv[2] || process.env.FC_VER || 27);
const NO_UPLOAD = process.argv.indexOf('--no-upload') >= 0;
const SCHEMA_VERSION = 1;
const DET_COL = 'details_fc' + VER;
const META_COL = 'meta_fc' + VER;
const CLOUD_DIR = 'fc' + VER + '/data/details_static/';
const META_DOC = 'detail_static';
const HARD_TIMEOUT_MS = Number(process.env.DETAILS_TIMEOUT_MS || 20 * 60 * 1000);

// —— 五大联赛（按名解析 eaId，避免硬编码数字）——
const BIG5_NAMES = ['Premier League', 'LALIGA EA SPORTS', 'Serie A Enilive', 'Bundesliga', 'Ligue 1 McDonald\'s'];
// —— 热门国家（含中国，可增删；按名解析 eaId）——
const HOT_NAMES = ['England', 'Germany', 'Spain', 'France', 'Italy', 'Portugal', 'Brazil', 'Argentina',
  'Netherlands', 'United States', 'China PR', 'Korea Republic', 'Mexico', 'Japan'];

function norm(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }

// —— 与端上 cloudJson.shardKeyOf 完全一致的纯分类函数 ——
function band74(r) { r = Number(r) || 0; return r >= 70 ? '70' : (r >= 65 ? '65' : '64'); }
function classifyKey(p, big5, hot) {
  const r = Number(p.overall) || 0;
  const lg = Number(p.leagueEaId) || 0;
  const nt = Number(p.nationEaId) || 0;
  if (r >= 85) return 'r85';
  if (r >= 80) {
    if (big5.indexOf(lg) >= 0 || hot.indexOf(nt) >= 0) return 'r80_84_scope';
    return 'r' + r;                       // 80-84 非五大 → 并入 75-79 按 rating 切片
  }
  if (r >= 75) return 'r' + r;            // 75-79
  if (big5.indexOf(lg) >= 0) return 'lg_' + lg + '_r74_' + band74(r);
  if (hot.indexOf(nt) >= 0) return 'nat_' + nt + '_r74_' + band74(r);
  return null;                            // 长尾 → 云函数
}

function loadEnv() {
  const f = path.join(ROOT, '.env.local');
  const out = {};
  if (fs.existsSync(f)) {
    fs.readFileSync(f, 'utf8').split(/\r?\n/).forEach(function (ln) {
      const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/.exec(ln);
      if (m) out[m[1]] = m[2].trim();
    });
  }
  return out;
}
function initCloud() {
  const env = loadEnv();
  const envId = process.env.TCB_ENV_ID || env.TCB_ENV_ID;
  const sid = process.env.TCB_SECRET_ID || env.TCB_SECRET_ID;
  const skey = process.env.TCB_SECRET_KEY || env.TCB_SECRET_KEY;
  if (!envId || !sid || !skey) throw new Error('缺 TCB_ENV_ID / TCB_SECRET_ID / TCB_SECRET_KEY（来自 env 或 .env.local）');
  return cloudbase.init({ env: envId, secretId: sid, secretKey: skey, timeout: 180000 });
}
function sleep(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }

// 带超时和重试的云存储上传（与 gen_hot_details#uploadJson 同款）
async function uploadJson(app, cloudPath, obj, timeoutMs) {
  timeoutMs = timeoutMs || 200000;
  const jsonStr = JSON.stringify(obj);
  const buf = Buffer.from(jsonStr);
  let lastErr = '';
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const up = await Promise.race([
        app.uploadFile({ cloudPath: cloudPath, fileContent: buf }),
        new Promise(function (_, reject) { setTimeout(function () { reject(new Error('upload timeout after ' + timeoutMs + 'ms')); }, timeoutMs); })
      ]);
      return up.fileID || up;
    } catch (e) {
      lastErr = e && e.message ? e.message : String(e);
      console.log('  上传失败（attempt', attempt, '/3）', cloudPath, lastErr);
      if (attempt < 3) await sleep(2000 * attempt);
    }
  }
  throw new Error('上传 ' + cloudPath + ' 最终失败: ' + lastErr);
}

// 回读校验：下载刚传的文件，比对大小是否一致（防「上传返回成功但内容残缺」）
async function verifyUpload(app, fileID, expectBytes) {
  try {
    const dl = await app.downloadFile({ fileID: fileID });
    const info = fs.statSync(dl.tempFilePath);
    if (info.size !== expectBytes) throw new Error('size mismatch ' + info.size + ' != ' + expectBytes);
    fs.unlinkSync(dl.tempFilePath);
    return true;
  } catch (e) {
    throw new Error('回读校验失败 ' + fileID + ': ' + (e && e.message || e));
  }
}

function shortHash(str) { return crypto.createHash('sha256').update(str).digest('hex').slice(0, 8); }

async function main() {
  const watchdog = setTimeout(function () { console.error('WATCHDOG TIMEOUT'); process.exit(5); }, HARD_TIMEOUT_MS);
  let app = null;
  try { app = initCloud(); } catch (e) { console.error('云初始化失败：', e.message); process.exit(3); }
  if (NO_UPLOAD) console.log('\n[precheck] --no-upload：仅本地计算 + 落盘，跳过云存储上传与元文档写入');

  console.log('===== gen_static_details ver=' + VER + ' =====');

  // 1) 扫描全表，收集 {overall, league.eaId, nation.eaId} + 名称→eaId 映射 + 分类入桶
  const buckets = {};                 // key -> [records]
  const leagueNameToId = {};          // norm(name) -> eaId
  const nationNameToId = {};
  const leagueRawName = {};           // eaId -> 原始 name（用于日志）
  const nationRawName = {};
  let scanned = 0, kept = 0, skipped = 0, missingFields = 0;
  let skip = 0;
  const PAGE = 1000;
  while (true) {
    const r = await app.database().collection(DET_COL).skip(skip).limit(PAGE).get();
    const docs = (r && r.data) || [];
    if (!docs.length) break;
    for (const d of docs) {
      scanned++;
      const league = (d.league && typeof d.league === 'object') ? d.league : null;
      const nation = (d.nation && typeof d.nation === 'object') ? d.nation : null;
      const overall = Number(d.overall) || 0;
      const lgId = league ? Number(league.eaId) || 0 : 0;
      const ntId = nation ? Number(nation.eaId) || 0 : 0;
      if (league && league.name) { leagueNameToId[norm(league.name)] = lgId; leagueRawName[lgId] = league.name; }
      if (nation && nation.name) { nationNameToId[norm(nation.name)] = ntId; nationRawName[ntId] = nation.name; }
      if (!overall) { missingFields++; skipped++; continue; }
      // big5/hot 在分类时才知道，先不分类；等解析出名单再统一分类
      const rec = {};
      for (const k of Object.keys(d)) rec[k] = d[k];   // 保留 _id：与 get_player_detail 返回的 r.data 逐字段等价（零回归）
      (buckets.__raw = buckets.__raw || []).push({ overall: overall, lgId: lgId, ntId: ntId, rec: rec });
    }
    skip += docs.length;
    if (docs.length < PAGE) break;
  }
  console.log('  扫描详情文档', scanned, '，缺 overall 跳过', missingFields);

  // 2) 解析 大五/热门 的 eaId 集合
  const big5 = BIG5_NAMES.map(function (n) { return leagueNameToId[norm(n)] || 0; }).filter(Boolean);
  const hot = HOT_NAMES.map(function (n) { return nationNameToId[norm(n)] || 0; }).filter(Boolean);
  console.log('  五大联赛 eaId =', big5.map(function (id) { return id + '(' + (leagueRawName[id] || '?') + ')'; }).join(', '));
  console.log('  热门国家 eaId =', hot.map(function (id) { return id + '(' + (nationRawName[id] || '?') + ')'; }).join(', '));
  // 未解析到的告警（帮助修正名单拼写）
  BIG5_NAMES.forEach(function (n) { if (!leagueNameToId[norm(n)]) console.warn('  ⚠️ 五大联赛未匹配:', n); });
  HOT_NAMES.forEach(function (n) { if (!nationNameToId[norm(n)]) console.warn('  ⚠️ 热门国家未匹配:', n); });

  // 3) 统一分类入桶（__raw -> 各 key 桶）
  const raw = buckets.__raw || [];
  delete buckets.__raw;
  for (const item of raw) {
    const p = { overall: item.overall, leagueEaId: item.lgId, nationEaId: item.ntId };
    const key = classifyKey(p, big5, hot);
    if (!key) { skipped++; continue; }     // 长尾 → 云函数
    (buckets[key] = buckets[key] || []).push(item.rec);
    kept++;
  }
  console.log('  静态覆盖', kept, '，长尾走云函数', skipped);

  // 4) 体积预检 + 写盘/上传
  const nowIso = new Date().toISOString();
  const nowTs = Date.now();
  const manifestShards = [];
  let totalBytes = 0;
  const keys = Object.keys(buckets).sort();
  for (const key of keys) {
    const records = buckets[key];
    const content = JSON.stringify({ schemaVersion: SCHEMA_VERSION, generatedAt: nowIso, key: key, records: records });
    const bytes = Buffer.byteLength(content, 'utf8');
    totalBytes += bytes;
    const hash = shortHash(content);
    const fileName = 'det_' + key + '_' + hash + '.json';
    console.log('    分片 ' + key + ' 玩家=' + records.length + ' 体积=' + (bytes / 1024).toFixed(1) + 'KB');
    if (NO_UPLOAD) {
      fs.writeFileSync(path.join(OUT_DIR, fileName), content);
      manifestShards.push({ key: key, fileID: 'local:' + fileName, count: records.length });
    } else {
      const fileID = await uploadJson(app, CLOUD_DIR + fileName, JSON.parse(content));
      await verifyUpload(app, fileID, bytes);
      manifestShards.push({ key: key, fileID: fileID, count: records.length });
    }
  }
  console.log('  ★ 总静态 JSON 体积(估算)=' + (totalBytes / 1024).toFixed(1) + 'KB (' + (totalBytes / 1024 / 1024).toFixed(2) + 'MB)；分片数=' + keys.length);

  // 5) manifest（含 big5/hot 名单，保证端云一致）
  const manifest = {
    schemaVersion: SCHEMA_VERSION,
    ver: VER,
    generatedAt: nowIso,
    big5Leagues: big5,
    hotNations: hot,
    shards: manifestShards
  };
  if (NO_UPLOAD) {
    fs.writeFileSync(path.join(OUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2));
    console.log('  [precheck] manifest 已落盘 probe/static_details/manifest.json');
  } else {
    const mFileName = 'manifest_' + shortHash(JSON.stringify(manifestShards)) + '.json';
    const mBytes = Buffer.byteLength(JSON.stringify(manifest), 'utf8');
    const mFileID = await uploadJson(app, CLOUD_DIR + mFileName, manifest);
    await verifyUpload(app, mFileID, mBytes);
    // ★ 最后才写 meta 元文档（原子发布）：指向 manifest fileID
    try {
      await app.database().collection(META_COL).doc(META_DOC).set({ data: { fileID: mFileID, generatedAt: nowTs, schemaVersion: SCHEMA_VERSION, ver: VER, count: kept } });
      console.log('  元文档 meta_fc' + VER + '/' + META_DOC + ' 已写（count=' + kept + '）');
    } catch (e) {
      await app.database().createCollection(META_COL).catch(function () {});
      await app.database().collection(META_COL).doc(META_DOC).set({ data: { fileID: mFileID, generatedAt: nowTs, schemaVersion: SCHEMA_VERSION, ver: VER, count: kept } }).catch(function (e2) { console.error('  元文档写入失败：', e2.message); });
    }
  }

  console.log('\n===== 完成 =====');
  clearTimeout(watchdog);
  process.exit(0);
}

if (require.main === module) {
  main().catch(function (e) { console.error('ERR', e); process.exit(1); });
}

module.exports = { initCloud: initCloud, main: main };
