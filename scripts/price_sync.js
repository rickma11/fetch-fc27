// FC27 市场价同步（生产端，方案 C v4）
//
// 定位：本脚本**不跑在腾讯云上**。它在 WorkBuddy 自动化 / GitHub Actions 里跑，
// 只负责「抓价 → 算异动榜 → 生成两个 JSON → 上传云存储」，小程序端只读展示。
// ⇒ 云开发的「调用次数」只会被端上取签名的几次 GET 消耗，**云函数 GBs = 0**。
//
// 契约（来自 2026-09-26 实测，勿改）：
//   GET https://enhancer-api.futnext.com/players/prices?ids=<下划线分隔>&platform=<pc|ps>
//   响应是**顶层数组** [{definitionId, prices:[n], updatedAt}]
//     ⚠️ 按 {data:{…}} 解析恒得空集（已踩过）
//   - 批量上限 50；platform 必填；仅 GET
//   - **只返有价卡**（19,799 抽 → ~19,716 有价）⇒ 本次未返回的 eaId 必须保留上轮值，**绝不写 0**
//     （写 0 会让页面冒出一堆「免费球员」）
//   - ⚠️ 仅支持 pc / ps；xbox 试 9 种写法全 400 ⇒ Xbox 列靠 HF 预言机补，本脚本不碰
//   - ⚠️ prices[] 语义未定（大罗返 15,000,000）。本脚本口径：
//     有 >=2 个值 ⇒ 按 platform 取位；只有 1 个值 ⇒ 两平台同价（取该值）。
//
// 用法：
//   node scripts/price_sync.js --dry-run             抓价 + 算榜 + 落本地文件，**不上传**
//   node scripts/price_sync.js --limit=200           只问前 200 个 eaId（快速验证接口）
//   node scripts/price_sync.js --upload              抓价 + 算榜 + 上传到云存储
//   node scripts/price_sync.js --force-upload-all    强制上传，忽略「产物与线上同名」的早退
//
// 产物（上传路径前缀：fc27/market/）：
//   price_all_<ts>.json   ~499KB  {v,ts,cur:{eaId:[pc,ps,xbox]},prev:{},src}
//   price_view_<ts>.json  ~28KB   {v,ts,tier:[…83+ 分档…],moves:[{eaId,name,prev,cur,dPct,pos}]}
//   文件名带 ts ⇒ 绕开云存储 CDN 缓存（规则 31），每轮须删上一代。
//
// ⚠️ 端上红线（改这里就要同步改断言）：
//   1. moves 每条必须自带 prev / cur / dPct，端上才能直接画红涨绿跌；
//      砍掉 dPct ⇒ 端上得回查 price_all（499KB）⇒ 首开变慢。scripts/market_assert_test.js 里
//      有「删掉 dPct 必须变红」的反例。
//   2. ts 必须单调递增；本轮抓价失败时必须**早退且不写新 ts**，端上靠 ts 判 stale。
const fs = require('fs');
// 核心逻辑（抓价 / 分档 / 异动榜）已迁至 market_core.js，此处单一真源引用。
const core = require('./market_core.js');
const key = core.key, pct = core.pct, sleep = core.sleep;
const fetchBatch = core.fetchBatch, pullPlatforms = core.pullPlatforms, build = core.build;
const PRICE_API = core.PRICE_API, BATCH = core.BATCH, CONCURRENCY = core.CONCURRENCY;
const TIER_MIN = core.TIER_MIN, MOVE_MIN_PCT = core.MOVE_MIN_PCT, MOVE_TOP = core.MOVE_TOP;

const argv = process.argv.slice(2);
const has = function (f) { return argv.indexOf(f) >= 0; };
const opt = function (k, d) {
  const hit = argv.filter(function (a) { return a.indexOf('--' + k + '=') === 0; })[0];
  return hit ? hit.split('=')[1] : d;
};
// --min-base=0 可关闭占位价过滤
let MIN_BASE = parseInt(opt('min-base', String(core.getMinBase())), 10);

const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'cloud-data', 'fc27', 'market');
const ROSTER = path.join(ROOT, 'cloud-data', 'fc27', 'players.json');


// ── 1) 拉 roster 拿 id / 名字 / 总评 / 位置 ──
function loadRoster() {
  const raw = JSON.parse(fs.readFileSync(ROSTER, 'utf8'));
  const list = Array.isArray(raw) ? raw : (raw.list || raw.items || []);
  return list.filter(function (x) { return x && x.eaId != null; }).map(function (x) {
    return {
      eaId: x.eaId,
      name: x.commonName || x.name || '',
      overall: x.overall,
      pos: x.position || '',
      imagePath: x.imagePath || ''   // 供 build 拼卡面 cloud://（有无半身像 → _card / _np）
    };
  });
}

// ── 2) 问价 ──

// ⚠️ pc 与 ps 必须**并行**拉（2026-09-27 实测）：串行两段 = 43s，并行压到 ~25s。
// 单轮时长直接决定自动化/Action 会不会超时，也决定 GBs 与分钟额度。

// ── 3) 取上一轮 cur 当 prev ──
function loadPrev() {
  if (!fs.existsSync(OUT_DIR)) return {};
  const files = fs.readdirSync(OUT_DIR)
    .filter(function (f) { return /^price_all_\d+\.json$/.test(f); })
    .sort();
  if (!files.length) return {};
  const latest = files[files.length - 1];
  try {
    const j = JSON.parse(fs.readFileSync(path.join(OUT_DIR, latest), 'utf8'));
    return j && j.cur ? j.cur : {};
  } catch (e) {
    return {};
  }
}

// ── 4) 组装两个信封 ──

// ── 5) 上传（走 upload_cloud.js 的凭证链） ──
function loadEnvLocal() {
  const f = path.join(ROOT, '.env.local');
  if (!fs.existsSync(f)) return {};
  const txt = fs.readFileSync(f, 'utf8');
  const out = {};
  txt.split(/\r?\n/).forEach(function (ln) {
    const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/.exec(ln);
    if (m) out[m[1]] = m[2].trim();
  });
  return out;
}

// 上传走 @cloudbase/node-sdk（与 scripts/upload_cloud.js 同一条链，已验证可用）。
// cloudPath 带目录前缀 fc27/market/，文件名自带 ts ⇒ 绕开云存储 CDN 缓存（规则 31）。
async function uploadToCloud(file) {
  const env = loadEnvLocal();
  const envId = process.env.TCB_ENV_ID || env.TCB_ENV_ID;
  const sid = process.env.TCB_SECRET_ID || env.TCB_SECRET_ID;
  const skey = process.env.TCB_SECRET_KEY || env.TCB_SECRET_KEY;
  if (!envId || !sid || !skey) throw new Error('缺 TCB_ENV_ID / TCB_SECRET_ID / TCB_SECRET_KEY');

  const cloudbase = require('@cloudbase/node-sdk');
  if (!global.__tcbApp) {
    global.__tcbApp = cloudbase.init({ env: envId, secretId: sid, secretKey: skey });
  }
  const buf = fs.readFileSync(file);
  const cloudPath = 'fc27/market/' + path.basename(file);
  console.log('  上传 ' + cloudPath + '（' + (buf.length / 1024).toFixed(0) + ' KB）…');
  const res = await global.__tcbApp.uploadFile({ cloudPath: cloudPath, fileContent: buf });
  console.log('  -> ' + JSON.stringify(res).slice(0, 160));
  return cloudPath;
}

// 删掉上一代 price_all / price_view（每轮只留最新一份，否则 20 分钟一轮会攒出上千个文件）
// keepBuckets：桶名副本保留最近几个（端上退桶上限 6）
function pruneOld(keepTs, keepBuckets) {
  let n = 0;
  const files = fs.readdirSync(OUT_DIR);
  // ts 版：删所有 price_(all|view)_<ts>.json 中 ts != keepTs 的
  files.forEach(function (f) {
    if (/^price_(?:all|view)_\d+\.json$/.test(f) && f.indexOf(String(keepTs)) < 0) {
      fs.unlinkSync(path.join(OUT_DIR, f));
      n++;
    }
  });
  // 桶名版：price_view_<12位桶>.json，按桶名降序保留最近 keepBuckets 个
  const bucketFiles = files.filter(function (f) { return /^price_view_\d{12,}\.json$/.test(f); })
    .sort().reverse();
  bucketFiles.slice(keepBuckets || 6).forEach(function (f) {
    fs.unlinkSync(path.join(OUT_DIR, f));
    n++;
  });
  return n;
}

// 本机时间分桶：YYYYMMDDHHMM（20 分钟粒度）。⚠️ 必须与端上 utils/priceStore.js#bucketOf 一致。
function pad2(n) { return n < 10 ? '0' + n : '' + n; }
function bucketOf(d) {
  const m = Math.floor(d.getMinutes() / 20) * 20;          // 0/20/40（时内分钟，非「自午夜分钟」）
  return '' + d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) + pad2(d.getHours()) + pad2(m);
}

// ── main ──
(async function main() {
  const limit = parseInt(opt('limit', '0'), 10);
  const doUpload = has('--upload');
  fs.mkdirSync(OUT_DIR, { recursive: true });

  console.log('=== FC27 市场价同步（生产端，方案 C v4）===');
  console.log('分档口径 overall >= ' + TIER_MIN + '（2026-09-27 拍板）；异动榜 |Δ| ≥ ' +
    MOVE_MIN_PCT + '%，取前 ' + MOVE_TOP);

  let roster = [];
  try {
    roster = loadRoster();
  } catch (e) {
    console.error('✗ 读 roster 失败：' + e.message);
    process.exitCode = 1;
    return;
  }
  console.log('roster 条数 =', roster.length);

  const prev = loadPrev();
  console.log('上一轮基准 prev =', Object.keys(prev).length, '条',
    prev && Object.keys(prev).length ? ('（来自 ' + fs.readdirSync(OUT_DIR).filter(function (f) { return /^price_all/.test(f); }).pop() + '）') : '');

  const t0 = Date.now();
  console.log('\n--- 抓价 futnext players/prices（pc + ps，并发 ' + CONCURRENCY + '）---');
  let rows = {};
  try {
    const r1 = await pullPlatforms(roster, limit);
    rows = r1.rows;
    let pcN = 0, psN = 0;
    Object.keys(rows).forEach(function (k) {
      if (rows[k][0] != null) pcN++;
      if (rows[k][1] != null) psN++;
    });
    console.log('  pc/ps 并行：' + r1.batches + ' 批，收 ' + Object.keys(rows).length + ' 条' +
      '（pc 有价 ' + pcN + '，ps 有价 ' + psN + '），失败批次 ' + r1.failed);
  } catch (e) {
    // ⚠️ 抓价整体失败 ⇒ 早退，**不写新 ts**（端上靠 ts 判 stale）
    console.error('✗ 抓价失败，早退且不生成产物：' + e.message);
    process.exitCode = 2;
    return;
  }
  const cost = ((Date.now() - t0) / 1000).toFixed(1);

  const built = build(roster, rows, prev, 'futnext');
  const allJson = JSON.stringify(built.all);
  const viewJson = JSON.stringify(built.view);

  console.log('\n=== 产物 ===');
  console.log('  抓价耗时 = ' + cost + 's');
  console.log('  price_all  = ' + (allJson.length / 1024).toFixed(0) + ' KB（' +
    built.mergedN + ' 个 eaId）');
  console.log('  price_view = ' + (viewJson.length / 1024).toFixed(1) + ' KB（分档 ' +
    built.tierN + ' 张，异动 ' + built.mvN + ' 条）');
  if (built.mvN) {
    const top = built.view.moves.slice(0, 5).map(function (m) {
      return m.name + ' ' + m.prev + '→' + m.cur + ' (' + (m.dPct > 0 ? '+' : '') + m.dPct + '%)';
    });
    console.log('  异动榜样例：' + top.join('；'));
  } else if (!Object.keys(prev).length) {
    console.log('  ⚠️ 异动榜为空 = 没有上一轮基准（首次运行），第二轮起才有');
  } else {
    console.log('  ⚠️ 异动榜为空 = 本轮满足 |Δ|≥' + MOVE_MIN_PCT + '% 且基准价 ≥' +
      MIN_BASE + ' 的卡为 0（多为「20 分钟内行情没动」）');
  }

  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  const allFile = path.join(OUT_DIR, 'price_all_' + built.ts + '.json');
  const viewFile = path.join(OUT_DIR, 'price_view_' + built.ts + '.json');
  fs.writeFileSync(allFile, allJson);
  fs.writeFileSync(viewFile, viewJson);
  console.log('\n已落本地：');
  console.log('  ' + path.relative(ROOT, allFile));
  console.log('  ' + path.relative(ROOT, viewFile));

  if (doUpload) {
    console.log('\n--- 上传云存储（fc27/market/）---');
    try {
      await uploadToCloud(allFile);
      await uploadToCloud(viewFile);
      // 桶名副本：端上按本机时间分桶找最新，每桶只写一次绕开 CDN 缓存坑
      const bucket = bucketOf(new Date());
      const viewBucketFile = path.join(OUT_DIR, 'price_view_' + bucket + '.json');
      fs.writeFileSync(viewBucketFile, viewJson);
      await uploadToCloud(viewBucketFile);
      const n = pruneOld(built.ts, 6);
      console.log('  已清理上一代 ' + n + ' 个文件（当前只留 ts=' + built.ts + '，桶名副本保留最近 6 个）');
    } catch (e) {
      // ⚠️ 上传失败 ⇒ 明确退出码，自动化据此判定本轮失败，**不要静默吞掉**（规则：不许静默）
      console.error('✗ 上传失败：' + e.message);
      process.exitCode = 3;
      return;
    }
  } else {
    console.log('\n（--dry-run：未上传。加 --upload 才会推到云存储）');
  }
})();
