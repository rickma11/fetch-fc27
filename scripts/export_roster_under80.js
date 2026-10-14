// export_roster_under80.js —— 从「最新球员全量」导出供「80↓ 价格异动监控」用的 sub-80 子集。
//
// 与 export_roster_83plus.js 对称：83plus 导出 overall>=80（≈1118），本脚本导出 overall<=79（≈18681）。
// sub-80 数量级约为 80+ 的 16.7 倍，故数据源优先级：
//   ① 本地全量 players.json（--from-players-json 或自动探测，0 云库读，DRY/本机用）
//   ② scan_cache（--from-cache，CI 中 sync_i18n 刚落盘的全量扫描缓存，0 云库读）
//   ③ 退化：直扫云库 players_fc27 where overall lte 79（≈18700 读，仅本地源都不可用时）
//
// 产品背景（2026-10-14）：新增「80↓ 异动榜」——只展示「当前价 > 该总评均值×MARGIN」
//   或「近 6h 累计涨跌幅 ≥ 阈值」的 sub-80 球员。本脚本只负责产出名册
//   （被 price_under80 / computeUnder80Alerts 消费），不做异动计算。
//
// 产物（本地）：cloud-data/fc27/roster_under80.json
//   { ver, ts, updatedAt, count, source, players:[{eaId, name, overall, pos, imagePath, rarity}] }
// 生产上传（--upload）：云存储公有读 fc27/data/roster_under80.json（与 roster_83plus.json 同前缀）。
//
// 用法：node scripts/export_roster_under80.js [--from-players-json <path>] [--from-cache] [--upload] [--ver 27]
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const VER = 27;
// sub-80 上限（含 79）；与 export_roster_83plus.js#MIN_RATING=80 互补、无重叠无遗漏。
const MAX_RATING = 79;

const argv = process.argv.slice(2);
let FROM_PLAYERS_JSON = null;
let FROM_CACHE = false;
let DO_UPLOAD = false;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--from-players-json') FROM_PLAYERS_JSON = argv[++i] || null;
  else if (argv[i] === '--from-cache') FROM_CACHE = true;
  else if (argv[i] === '--upload') DO_UPLOAD = true;
  else if ((argv[i] === '--ver' || argv[i] === '-v') && argv[i + 1]) VER = parseInt(argv[++i], 10) || 27;
}

const OUT_FILE = path.join(ROOT, 'cloud-data', 'fc' + VER, 'roster_under80.json');
const DEFAULT_PLAYERS_JSON = path.join(ROOT, 'cloud-data', 'fc' + VER, 'players.json');

// 端上需要的字段（与 export_roster_83plus.js#project 完全一致，消费方口径统一）
function project(p) {
  return {
    eaId: p.eaId,
    name: p.commonName || p.name || '',
    overall: p.overall || 0,
    pos: p.position || '',
    imagePath: p.imagePath || '',
    rarity: (p.rarity && p.rarity.name) || ''
  };
}

// 纯函数：过滤 overall<=79 + 投影 + 按 overall 降序（供单测，DRY 不依赖 IO）
function filterUnder80(rows) {
  return rows
    .filter(p => (p.overall || 0) <= MAX_RATING)
    .map(project)
    .sort((a, b) => b.overall - a.overall);
}

function writeOut(players, sourceLabel) {
  const body = {
    ver: String(VER),
    ts: Date.now(),
    updatedAt: new Date().toISOString(),
    count: players.length,
    source: sourceLabel,
    players: players
  };
  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(body, null, 1) + '\n', 'utf8');
  console.log('[export_roster_under80] 已写 ' + players.length + ' 条 → ' +
    path.relative(ROOT, OUT_FILE) + '（' + (fs.statSync(OUT_FILE).size / 1024).toFixed(1) + ' KB，来源：' + sourceLabel + '）');
  return body;
}

// 读本地全量 players.json（兼容数组或 {players:[...]}）
function readLocalPlayersJson(pjPath) {
  const raw = JSON.parse(fs.readFileSync(pjPath, 'utf8'));
  const rows = Array.isArray(raw) ? raw : (raw.players || []);
  console.log('[export_roster_under80] 读本地全量 ' + path.basename(pjPath) + '：' + rows.length + ' 条');
  return rows;
}

async function loadRows() {
  // ① 显式 --from-players-json
  if (FROM_PLAYERS_JSON) {
    if (!fs.existsSync(FROM_PLAYERS_JSON)) throw new Error('指定的 --from-players-json 不存在：' + FROM_PLAYERS_JSON);
    return { rows: readLocalPlayersJson(FROM_PLAYERS_JSON), label: 'local_players_json(' + path.basename(FROM_PLAYERS_JSON) + ', 0 云库读)' };
  }
  // ①' 自动探测默认 players.json（本机 DRY 首选）
  if (fs.existsSync(DEFAULT_PLAYERS_JSON)) {
    return { rows: readLocalPlayersJson(DEFAULT_PLAYERS_JSON), label: 'local_players_json(默认, 0 云库读)' };
  }
  // ② scan_cache（CI：sync_i18n 刚落盘的全量扫描缓存）
  if (FROM_CACHE) {
    const scanCache = require('./scan_cache.js');
    const hit = scanCache.read(VER);
    if (hit && hit.rows && hit.rows.length) {
      console.log('[export_roster_under80] 命中扫描缓存：' + hit.total + ' 条');
      return { rows: hit.rows, label: 'scan_cache(本地缓存, 0 云库读)' };
    }
    throw new Error('指定 --from-cache 但缓存不可用（缺失/过期/条数不足），且无 players.json ⇒ 无法生成');
  }
  // ③ 退化：直扫云库 players_fc27 where overall lte 79
  const { resolve } = require('./tcb_env');
  const cred = resolve();
  if (cred.missing && cred.missing.length) {
    throw new Error('无本地源且无云开发凭证：' + cred.missing.join(' / ') +
      '\n先跑 `node scripts/sync_i18n.js --dry` 或提供 players.json / .env.local 凭证。');
  }
  const cloudbase = require('@cloudbase/node-sdk');
  const app = cloudbase.init({ env: cred.ENV_ID, secretId: cred.SECRET_ID, secretKey: cred.SECRET_KEY, timeout: 180000 });
  const db = app.database();
  const cmd = db.command;
  const COL = 'players_fc' + VER;
  const proj = { eaId: true, commonName: true, overall: true, position: true, imagePath: true, 'rarity.name': true };
  const all = [];
  let skip = 0;
  while (true) {
    const r = await db.collection(COL).field(proj).where({ overall: cmd.lte(MAX_RATING) }).skip(skip).limit(1000).get();
    const d = r.data || [];
    if (!d.length) break;
    all.push(...d);
    if (d.length < 1000) break;
    skip += 1000;
  }
  console.log('[export_roster_under80] 直扫云库 ' + all.length + ' 条(<=79)');
  return { rows: all, label: 'cloud_db(直扫 <=79)' };
}

// 上传到云存储公有读（带 #116 超时+重试，避免偶发卡死；本机 DRY 不跑）
async function uploadRoster(buf) {
  const { resolve } = require('./tcb_env');
  const cred = resolve();
  if (cred.missing && cred.missing.length) {
    throw new Error('缺少云开发凭证，无法上传：' + cred.missing.join(' / ') +
      '\n在 CI 注入 TCB_ENV_ID / TCB_SECRET_ID / TCB_SECRET_KEY，或本地 .env.local 配置。');
  }
  const cloudbase = require('@cloudbase/node-sdk');
  const app = cloudbase.init({ env: cred.ENV_ID, secretId: cred.SECRET_ID, secretKey: cred.SECRET_KEY, timeout: 180000 });
  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const up = await Promise.race([
        app.uploadFile({ cloudPath: 'fc27/data/roster_under80.json', fileContent: buf }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('upload timeout 200s')), 200000))
      ]);
      console.log('[export_roster_under80] 已上传云存储公有读 fc27/data/roster_under80.json →', up.fileID);
      return up.fileID;
    } catch (e) {
      lastErr = e;
      console.warn('[export_roster_under80] 上传尝试 ' + attempt + '/3 失败: ' + String(e && e.message || e));
      if (attempt < 3) await new Promise(r => setTimeout(r, 1500 * attempt));
    }
  }
  throw new Error('上传云存储失败（3 次重试后仍失败）: ' + String(lastErr && lastErr.message || lastErr));
}

async function main() {
  const { rows, label } = await loadRows();
  const out = filterUnder80(rows);
  if (!out.length) {
    throw new Error('筛出 0 条 <=79，疑似数据源异常，拒绝写出空文件');
  }
  const body = writeOut(out, label);
  console.log('[export_roster_under80] 总评分布（TOP）：' +
    out.slice(0, 5).map(p => p.overall + ' ' + p.name).join(' | '));

  if (DO_UPLOAD) {
    const buf = fs.readFileSync(OUT_FILE);
    await uploadRoster(buf);
  } else {
    console.log('[export_roster_under80] 模拟模式：仅写本地，未上传云存储（生产加 --upload 或手动传）');
  }
}

if (require.main === module) {
  main().catch(e => { console.error('[export_roster_under80] 失败：' + String(e && e.message || e)); process.exit(1); });
}

module.exports = { project: project, filterUnder80: filterUnder80, MAX_RATING: MAX_RATING };
