// 一次性修复 daily_7d.json「同日重跑列错位」（2026-10-25，配合 market_core.js#updateDaily bug 修复）。
//
// 背景（bug 详情见 market_core.js#updateDaily 头注）：
//   旧 updateDaily 在同日重跑（days≥2）时把「上一小时算出的今日残留值」当成历史列保留，
//   导致 daily_7d.json 的列与 days 标签整体错位一位：标称「昨日」列实际是今日上午旧值、
//   真实历史每日小时被提前挤掉。线上实证：昨日列与今日真值更近的卡 1064/1128 张。
//   影响：① market_overview「vs 昨日」恒为 0%；② 端上 Price24hSheet 按天视图自 10-24 起显示错位点。
//
// 修复方式（一次性）：
//   用线上 series_24h.json 重新算一份「干净首跑」daily（days=[今日]，今日值=序列今日桶聚合），
//   覆盖写入 daily_7d.json 主路径 + daily_7d_backup_latest.json（备份路径同步覆盖，
//   防止 CI 的「主文件读不到→回退 backup」双保险把错位旧文件恢复回来）。
//   此后每小时 CI 用修好的 updateDaily 续写，历史列逐日正确累积。
//   ⚠️ 真实的全日历史（10-23 / 10-24 00:00-11:00）已不在 24h 序列内，不可恢复；
//      按契约「当日=已采集小时点均值」从头累积（端上按天视图与概览指数从今日起每日 +1）。
//
// 用法：
//   node scripts/repair_daily_once.js            # dry-run：算 + 落本地副本 + 打印摘要，不上传
//   node scripts/repair_daily_once.js --upload   # 真跑：上传主路径 + 备份路径（需 TCB_* 凭证）
'use strict';

const https = require('https');
const fs = require('fs');
const core = require('./market_core.js');

const SERIES_DOMAIN = 'https://636c-cloud1-d5gq6q3np8708aeef-1475854307.tcb.qcloud.la';
const SERIES_READ_URL = SERIES_DOMAIN + '/fc27/market/series_24h.json';
const DAILY_CLOUD_PATH = 'fc27/market/daily_7d.json';
const DAILY_CLOUD_PATH_BACKUP = 'fc27/market/daily_7d_backup_latest.json';
const OUT_LOCAL = __dirname + '/daily_7d.repair.json';

function pad2(n) { return n < 10 ? '0' + n : '' + n; }
function bucketOf(d) {
  d = d || new Date();
  const ms = d.getTime() + 8 * 60 * 60 * 1000;
  const z = new Date(ms);
  return '' + z.getUTCFullYear() + pad2(z.getUTCMonth() + 1) + pad2(z.getUTCDate()) + pad2(z.getUTCHours()) + '00';
}
function httpGetJson(url, timeoutMs) {
  timeoutMs = timeoutMs || 90000;
  return new Promise(function (resolve, reject) {
    const timer = setTimeout(function () { req.destroy(); reject(new Error('timeout')); }, timeoutMs);
    const req = https.get(url, function (res) {
      let data = '';
      res.on('data', function (c) { data += c; });
      res.on('end', function () {
        clearTimeout(timer);
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('json parse: ' + e.message)); }
        } else reject(new Error('http ' + res.statusCode));
      });
    });
    req.on('error', function (e) { clearTimeout(timer); reject(e); });
  });
}
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

(async function main() {
  const doUpload = process.argv.indexOf('--upload') >= 0;
  const dayKey = bucketOf(new Date()).slice(0, 8);   // 北京日期 YYYYMMDD
  console.log('[repair_daily] dayKey=' + dayKey + ' upload=' + doUpload);

  // 1) 读线上 series（3 次重试，与 price_sync_cloud 同口径）
  let series = null;
  for (let attempt = 1; attempt <= 3 && !series; attempt++) {
    try { series = await httpGetJson(SERIES_READ_URL + '?v=' + bucketOf(new Date()) + '-' + Math.random().toString(36).slice(2, 8)); }
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

  // 2) 干净首跑 daily：days=[today]，今日值由序列今日桶算出（updateDaily(null, ...) 即首跑路径）
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
  async function uploadSafe(cloudPath) {
    const buf = Buffer.from(JSON.stringify(clean));
    const p = app.uploadFile({ cloudPath: cloudPath, fileContent: buf });
    const race = new Promise(function (_, rej) { setTimeout(function () { rej(new Error('race timeout')); }, 480000); });
    await Promise.race([p, race]);
    console.log('[repair_daily] 上传 ' + cloudPath + ' ✓ (' + (buf.length / 1024).toFixed(0) + 'KB)');
  }
  await uploadSafe(DAILY_CLOUD_PATH_BACKUP);   // 先备份路径，再主路径（与 CI「先备后写」同序）
  await uploadSafe(DAILY_CLOUD_PATH);
  console.log('[repair_daily] 修复完成：daily_7d.json 已重置为干净首跑状态（days=[' + dayKey + ']）');
})().catch(function (e) {
  console.error('[repair_daily] FAIL: ' + (e && e.message || e));
  process.exit(1);
});
