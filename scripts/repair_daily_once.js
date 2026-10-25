// 一次性修复 daily_7d.json「同日重跑列错位」（2026-10-25，配合 market_core.js#updateDaily bug 修复）。
//
// 背景（bug 机制见 market_core.js#updateDaily 头注）：
//   旧 alignHist 用 `a.slice(a.length - keep)` 保留末尾 keep 格，同日重跑时 days 不增长
//   ⇒ 每个整点 run 都把列整体左移一位、最旧列被挤掉。污染从 10-24 第二个 run 起持续发生。
//
// 2026-10-25 15:07 线上审计实证（scripts/daily_column_audit.js，CI 只读跑批，commit ae8ed04）：
//   线上 days=["20261023","20261024","20261025"]，但三列 100%（1242/1242 张）分别等于
//   「今日 00-10 时 / 00-11 时 / 00-15 时的 partial」——存量历史列已全部被左移污染，
//   标签 10-23/10-24 均为虚标；真实全日值已不在 series 24h 滚动窗口内，不可恢复。
//   ⇒ 「只剥脏列」方案不成立（没有正确的历史列可保留），唯一正确修法＝干净重建。
//   影响佐证：market_overview「vs 昨日」avgChg≈+0.2% 且过半卡片 |Δ|<0.5%（同日 partial 互比特征）。
//
// 修复方式（一次性，干净重建）：
//   以线上 series_24h.json 为真值，core.updateDaily(null, series, dayKey) 走「首跑」路径
//   生成 days=[今日] 的干净 daily（今日值=序列今日桶聚合；端上按天视图/概览指数从今日起每日 +1，
//   14 天长满——与规则 131「首日 1 根」同机制）。上传前先把线上现状快照到本地 backups/。
//   上传顺序：先备份路径（daily_7d_backup_latest.json）再主路径，两者同写干净内容
//   （堵住 CI「主文件读不到→回退 backup」把错位旧文件恢复回来的路径）。
//   此后每小时 CI 用修好的 updateDaily 续写，历史列逐日正确累积。
//
// 用法：
//   node scripts/repair_daily_once.js            # dry-run：算 + 落本地副本 + 打印摘要，不上传
//   node scripts/repair_daily_once.js --upload   # 真跑：先快照线上现状，再上传主+备份路径（需 TCB_* 凭证）
'use strict';

const https = require('https');
const fs = require('fs');
const path = require('path');
const core = require('./market_core.js');

const SERIES_DOMAIN = 'https://636c-cloud1-d5gq6q3np8708aeef-1475854307.tcb.qcloud.la';
const SERIES_READ_URL = SERIES_DOMAIN + '/fc27/market/series_24h.json';
const DAILY_READ_URL = SERIES_DOMAIN + '/fc27/market/daily_7d.json';
const DAILY_CLOUD_PATH = 'fc27/market/daily_7d.json';
const DAILY_CLOUD_PATH_BACKUP = 'fc27/market/daily_7d_backup_latest.json';
const OUT_LOCAL = __dirname + '/daily_7d.repair.json';
const SNAP_DIR = path.join(__dirname, '..', 'backups', '20261025', 'market-overview');

function pad2(n) { return n < 10 ? '0' + n : '' + n; }
function bucketOf(d) {
  d = d || new Date();
  const ms = d.getTime() + 8 * 60 * 60 * 1000;
  const z = new Date(ms);
  return '' + z.getUTCFullYear() + pad2(z.getUTCMonth() + 1) + pad2(z.getUTCDate()) + pad2(z.getUTCHours()) + '00';
}
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
// CDN 读（3 次重试；随机 query 破边缘缓存，确保 origin 最新）
function httpGetJson(url, timeoutMs, tries) {
  timeoutMs = timeoutMs || 90000;
  tries = tries || 3;
  const bust = (url.indexOf('?') >= 0 ? '&' : '?') + 'repair=' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  return new Promise(function (resolve, reject) {
    (function attempt(k) {
      const timer = setTimeout(function () { req.destroy(); reject(new Error('timeout')); }, timeoutMs);
      const req = https.get(url + bust, function (res) {
        let data = '';
        res.on('data', function (c) { data += c; });
        res.on('end', function () {
          clearTimeout(timer);
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('json parse: ' + e.message)); }
          } else if (k < tries) { setTimeout(function () { attempt(k + 1); }, 800 * k); }
          else { reject(new Error('http ' + res.statusCode)); }
        });
      });
      req.on('error', function (e) {
        clearTimeout(timer);
        if (k < tries) setTimeout(function () { attempt(k + 1); }, 800 * k);
        else reject(e);
      });
    })(1);
  });
}

(async function main() {
  const doUpload = process.argv.indexOf('--upload') >= 0;
  const dayKey = bucketOf(new Date()).slice(0, 8);   // 北京日期 YYYYMMDD
  console.log('[repair_daily] dayKey=' + dayKey + ' upload=' + doUpload);

  // 0) 上传前快照线上现状（本地留底；读不到只警告不阻塞——审计已证实其内容可由 series 复推）
  try {
    const cur = await httpGetJson(DAILY_READ_URL);
    const days = cur && cur.days;
    const nP = cur && cur.players ? Object.keys(cur.players).length : 0;
    if (Array.isArray(days) && nP) {
      try { fs.mkdirSync(SNAP_DIR, { recursive: true }); } catch (e) { /* 已存在 */ }
      const snap = path.join(SNAP_DIR, 'daily_7d.pre-repair-' + dayKey + '.json');
      fs.writeFileSync(snap, JSON.stringify(cur));
      console.log('[repair_daily] 线上现状快照已留底 ' + snap + '（days=' + JSON.stringify(days) + ' players=' + nP + '）');
    } else {
      console.warn('[repair_daily] ⚠️ 线上文件结构异常（days=' + JSON.stringify(days) + ' players=' + nP + '），跳过快照');
    }
  } catch (e) {
    console.warn('[repair_daily] ⚠️ 线上现状快照失败（不阻塞修复）: ' + (e && e.message || e));
  }

  // 1) 读线上 series（3 次重试 + 随机 query 破缓存）
  let series = null;
  for (let attempt = 1; attempt <= 3 && !series; attempt++) {
    try { series = await httpGetJson(SERIES_READ_URL); }
    catch (e) { console.warn('[repair_daily] series 读取失败(第' + attempt + '次): ' + (e && e.message || e)); if (attempt < 3) await sleep(800 * attempt); }
  }
  if (!series || !series.players || !(series.buckets || []).length) {
    console.error('[repair_daily] FAIL: series 不可用，放弃修复（不动线上文件）');
    process.exit(1);
  }
  const todayBuckets = series.buckets.filter(function (b) { return String(b).slice(0, 8) === dayKey; });
  console.log('[repair_daily] series buckets=' + series.buckets.length + '（' + series.buckets[0] + '→' + series.buckets[series.buckets.length - 1] + '），今日桶=' + todayBuckets.length);
  if (!todayBuckets.length) {
    console.error('[repair_daily] FAIL: series 内无今日桶，放弃修复');
    process.exit(1);
  }

  // 2) 干净重建：updateDaily(null, ...) 即首跑路径 ⇒ days=[today]，历史列全 null 起步
  const clean = core.updateDaily(null, series, dayKey);

  // 3) 结构自检（脏数据绝不外传）
  const problems = [];
  if (JSON.stringify(clean.days) !== JSON.stringify([dayKey])) problems.push('days != [' + dayKey + ']: ' + JSON.stringify(clean.days));
  const pKeys = Object.keys(clean.players);
  if (!pKeys.length) problems.push('players 为空');
  let misaligned = 0, nullCells = 0;
  pKeys.forEach(function (id) {
    const r = clean.players[id];
    if ((r.pc || []).length !== 1 || (r.ps || []).length !== 1) misaligned++;
    if (!r.pc[0] && !r.ps[0]) nullCells++;
  });
  if (misaligned) problems.push('数组未对齐 days 的球员数=' + misaligned);
  if (nullCells) problems.push('今日双平台皆空的球员数=' + nullCells + '（不应出现）');
  if (problems.length) {
    console.error('[repair_daily] FAIL: 自检未过，放弃修复:\n  - ' + problems.join('\n  - '));
    process.exit(1);
  }
  console.log('[repair_daily] 自检 OK: players=' + pKeys.length + ' days=' + JSON.stringify(clean.days));
  fs.writeFileSync(OUT_LOCAL, JSON.stringify(clean));
  console.log('[repair_daily] 本地副本已落 ' + OUT_LOCAL + ' (' + (fs.statSync(OUT_LOCAL).size / 1024).toFixed(0) + 'KB)');

  // 4) 上传（主 + 备份同内容，堵住 CI 的 backup 回退路径）
  if (!doUpload) {
    console.log('[repair_daily] DRY-RUN: 未上传（加 --upload 才写云存储）');
    return;
  }
  const envId = process.env.TCB_ENV_ID, sid = process.env.TCB_SECRET_ID, skey = process.env.TCB_SECRET_KEY;
  if (!envId || !sid || !skey) {
    // 与本仓库既有约定一致：凭证可放 .env.local（CI 用 secrets）
    try {
      const env = fs.readFileSync(__dirname + '/../.env.local', 'utf8');
      env.split(/\r?\n/).forEach(function (line) {
        const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
        if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
      });
    } catch (e) { /* 无 .env.local 也无妨，走环境变量 */ }
  }
  if (!process.env.TCB_ENV_ID || !process.env.TCB_SECRET_ID || !process.env.TCB_SECRET_KEY) {
    console.error('[repair_daily] FAIL: 缺 TCB_ENV_ID / TCB_SECRET_ID / TCB_SECRET_KEY（环境变量或 .env.local）');
    process.exit(1);
  }
  const cloudbase = require('@cloudbase/node-sdk');
  const app = cloudbase.init({ env: process.env.TCB_ENV_ID, secretId: process.env.TCB_SECRET_ID, secretKey: process.env.TCB_SECRET_KEY, timeout: 180000 });
  const buf = Buffer.from(JSON.stringify(clean));
  // 规则 116：超时 + 最多 3 次重试（单文件 ~75KB，慢速档也远低于 480s 竞赛上限）
  async function uploadSafe(cloudPath) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const p = app.uploadFile({ cloudPath: cloudPath, fileContent: buf });
        const race = new Promise(function (_, rej) { setTimeout(function () { rej(new Error('race timeout')); }, 480000); });
        await Promise.race([p, race]);
        console.log('[repair_daily] 上传 ' + cloudPath + ' ✓ (attempt ' + attempt + ', ' + (buf.length / 1024).toFixed(0) + 'KB)');
        return;
      } catch (e) {
        console.warn('[repair_daily] 上传 ' + cloudPath + ' 第 ' + attempt + ' 次失败: ' + (e && e.message || e));
        if (attempt >= 3) throw e;
        await sleep(2000 * attempt);
      }
    }
  }
  await uploadSafe(DAILY_CLOUD_PATH_BACKUP);   // 先备份路径，再主路径（与 CI「先备后写」同序）
  await uploadSafe(DAILY_CLOUD_PATH);
  console.log('[repair_daily] 修复完成：daily_7d.json 已干净重建（days=[' + dayKey + ']），备份路径同步');
})().catch(function (e) {
  console.error('[repair_daily] FAIL: ' + (e && e.message || e));
  process.exit(1);
});
