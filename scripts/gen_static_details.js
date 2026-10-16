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
const HARD_TIMEOUT_MS = Number(process.env.DETAILS_TIMEOUT_MS || 60 * 60 * 1000);

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

// 规则 116/100：@cloudbase/node-sdk 从 CI runner→COS 偶发卡死 + uploadFile 假成功（返回成功但内容残缺）。
// 统一封装：SDK 硬超时(180s,见 initCloud) + 3 次重试 + race=200s(>SDK timeout 让其先自我中止) + 回读校验。
// ⚠️ 关键：node-sdk 的 downloadFile 返回 { fileContent: Buffer }（不是 wx 端的 tempFilePath），
//    回读必须用 rb.fileContent；旧实现误用 dl.tempFilePath → 真实上传时 verifyUpload 抛「path 为 undefined」。
async function uploadWithRetry(app, cloudPath, buf, expectBytes) {
  expectBytes = expectBytes || (buf && buf.length) || 0;
  // 大分片（>2MB）自适应放宽：4 并发共享带宽时 3.4MB 单流可能 >200s（R116 实测 CI→COS 单流 ~10-30KB/s）
  const RACE_MS = expectBytes > 2 * 1024 * 1024 ? 600000 : 200000;
  let lastErr;
  for (let i = 0; i < 3; i++) {
    try {
      const up = await Promise.race([
        app.uploadFile({ cloudPath: cloudPath, fileContent: buf }),
        new Promise(function (_, rej) { setTimeout(function () { rej(new Error('uploadFile 超时 ' + RACE_MS + 'ms')); }, RACE_MS); })
      ]);
      const fileID = (up && up.fileID) || '';
      if (!fileID) throw new Error('上传未拿到 fileID');
      const rb = await app.downloadFile({ fileID: fileID });
      const rbBuf = rb && rb.fileContent;
      if (!rbBuf || !rbBuf.length) throw new Error('回读空');
      if (expectBytes && rbBuf.length !== expectBytes) throw new Error('回读字节数不符 ' + rbBuf.length + ' != ' + expectBytes);
      return fileID;
    } catch (e) {
      lastErr = e;
      console.error('  ⚠️ 上传/回读尝试 ' + (i + 1) + '/3 失败: ' + (e && e.message || e));
    }
  }
  throw lastErr || new Error('uploadWithRetry 全部 3 次失败');
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
  // 超大分片拆 part（R116 补充）：CI→COS 单流 ~10-30KB/s，TCB SDK 对慢速上传有 UserNetworkTooSlow
  // 自我中止保护，>2MB 的单文件实测必挂（nat_14_r74_64 3.4MB 三连挂）。限制单文件 ≤1.2MB；
  // manifest 允许同一 key 多个条目（part），端上按 key 找全部条目合并查找。
  const SPLIT_LIMIT = 1.2 * 1024 * 1024;
  function buildShardTask(key, records, partIdx, partCount) {
    const content = JSON.stringify({ schemaVersion: SCHEMA_VERSION, generatedAt: nowIso, key: key, part: partIdx, parts: partCount, records: records });
    const bytes = Buffer.byteLength(content, 'utf8');
    const hash = shortHash(content);
    const fileName = 'det_' + key + (partCount > 1 ? '_p' + partIdx : '') + '_' + hash + '.json';
    return { key: key, records: records, content: content, bytes: bytes, fileName: fileName, partIdx: partIdx, partCount: partCount };
  }
  const tasks = [];
  keys.forEach(function (key) {
    const records = buckets[key];
    const whole = buildShardTask(key, records, 0, 1);
    if (whole.bytes <= SPLIT_LIMIT) { tasks.push(whole); totalBytes += whole.bytes; return; }
    // 按记录序列化体积贪心切块
    const recStrs = records.map(function (r) { return JSON.stringify(r); });
    const overhead = JSON.stringify({ schemaVersion: SCHEMA_VERSION, generatedAt: nowIso, key: key, part: 0, parts: 0, records: [] }).length + 4;
    const parts = [];
    let cur = [], curLen = 0;
    for (let i = 0; i < recStrs.length; i++) {
      if (cur.length && curLen + recStrs[i].length + 1 + overhead > SPLIT_LIMIT) { parts.push(cur); cur = []; curLen = 0; }
      cur.push(recStrs[i]); curLen += recStrs[i].length + 1;
    }
    if (cur.length) parts.push(cur);
    console.log('    ⚠️ 分片 ' + key + ' 超限(' + (whole.bytes / 1024).toFixed(0) + 'KB > ' + (SPLIT_LIMIT / 1024).toFixed(0) + 'KB) 拆为 ' + parts.length + ' 个 part');
    parts.forEach(function (prs, idx) {
      const t = buildShardTask(key, prs.map(function (s) { return JSON.parse(s); }), idx, parts.length);
      tasks.push(t); totalBytes += t.bytes;
    });
  });
  tasks.forEach(function (t) {
    console.log('    分片 ' + t.key + ' 玩家=' + t.records.length + ' 体积=' + (t.bytes / 1024).toFixed(1) + 'KB');
  });
  if (NO_UPLOAD) {
    for (const t of tasks) {
      fs.writeFileSync(path.join(OUT_DIR, t.fileName), t.content);
      manifestShards.push({ key: t.key, fileID: 'local:' + t.fileName, count: t.records.length, part: t.partIdx, parts: t.partCount });
    }
  } else {
    // 桶 4 并发上传（R116：CI runner→云存储实测单流仅 ~10-80KB/s，串行 69 分片会撞 job 超时）
    let cursor = 0; let done = 0;
    async function worker() {
      while (cursor < tasks.length) {
        const t = tasks[cursor++];
        const fileID = await uploadWithRetry(app, CLOUD_DIR + t.fileName, Buffer.from(t.content), t.bytes);
        manifestShards.push({ key: t.key, fileID: fileID, count: t.records.length, part: t.partIdx, parts: t.partCount });
        done++;
        console.log('    [上传 ' + done + '/' + tasks.length + '] ' + t.key + ' OK');
      }
    }
    await Promise.all([worker(), worker(), worker(), worker()]);
  }
  manifestShards.sort(function (a, b) { return a.key < b.key ? -1 : (a.key > b.key ? 1 : 0); });
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
    const mFileID = await uploadWithRetry(app, CLOUD_DIR + mFileName, Buffer.from(JSON.stringify(manifest)), mBytes);
    // ★ 最后才写 meta 元文档（原子发布）：指向 manifest fileID
    // ⚠️ 字段直接平铺（与 gen_static_lists 同款）；node-sdk doc.set 不吃 {data:{...}} 包裹——
    //    包了会把载荷嵌进名为 data 的字段，端上 readMeta 读 meta.fileID 永远空（CI verify 步骤实测抓到）。
    try {
      await app.database().collection(META_COL).doc(META_DOC).set({ fileID: mFileID, generatedAt: nowTs, schemaVersion: SCHEMA_VERSION, ver: VER, count: kept });
      console.log('  元文档 meta_fc' + VER + '/' + META_DOC + ' 已写（count=' + kept + '）');
    } catch (e) {
      await app.database().createCollection(META_COL).catch(function () {});
      await app.database().collection(META_COL).doc(META_DOC).set({ fileID: mFileID, generatedAt: nowTs, schemaVersion: SCHEMA_VERSION, ver: VER, count: kept }).catch(function (e2) { console.error('  元文档写入失败：', e2.message); });
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
