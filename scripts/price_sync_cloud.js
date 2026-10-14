// FC27 市场价同步 —— GitHub Actions 版（云函数 market_sync 的 port）。
//
// 来源：eafc-miniapp/cloudfunctions/market_sync/index.js（云函数副本）。
// 本脚本在 fetch-fc27 的 GitHub Actions 里跑，逻辑与端上契约**完全对齐**：
//   - 桶算法 = 北京时间纯小时（分钟固定 00），与端上 utils/priceStore.js#bucketOf 一致；
//   - 产出 price_view_<YYYYMMDDHH00>.json（端上只读这个）；
//   - 2026-10-03：异动榜（moves）下线 —— 不再读/写 prev 快照、不再算 moves，每小时只更新分档价。
//
// 唯一与云函数的差异：上传从 wx-server-sdk 的 cloud.uploadFile 换成 @cloudbase/node-sdk
// （同 export-roster-83plus.yml 已验证的 TCB_* Secrets 链）。
//
// 触发：仅 workflow_dispatch（cron-job.org 或手动 POST）。无自动定时器，未配第三方触发前不会自跑。
//
// 用法：
//   node scripts/price_sync_cloud.js            # 空跑：抓价+算榜+落日志，不上传（验证用）
//   node scripts/price_sync_cloud.js --upload   # 真跑：抓价+算榜+上传云存储

'use strict';

const https = require('https');
const fs = require('fs');
const core = require('./market_core.js');

// ⚠️ 与云函数 market_sync 常量保持一致（勿改，否则端上契约漂移）。
const VER = 27;
const PRICE_VIEW_PREFIX = 'fc27/market/price_view_';
const SERIES_FILE = 'series_24h.json';
const SERIES_CLOUD_PATH = 'fc27/market/' + SERIES_FILE;
// 覆盖前先把「覆盖前云上旧文件」存一份备份，供极端情况下（主文件被部分写坏）恢复。
const SERIES_CLOUD_PATH_BACKUP = 'fc27/market/series_24h_backup_latest.json';
const SERIES_DOMAIN = 'https://636c-cloud1-d5gq6q3np8708aeef-1475854307.tcb.qcloud.la';
const SERIES_READ_URL = SERIES_DOMAIN + '/' + SERIES_CLOUD_PATH;
const ROSTER_URL = 'https://636c-cloud1-d5gq6q3np8708aeef-1475854307.tcb.qcloud.la/fc27/data/roster_83plus.json';
const ROSTER_UNDER80_URL = 'https://636c-cloud1-d5gq6q3np8708aeef-1475854307.tcb.qcloud.la/fc27/data/roster_under80.json';
const SERIES_UNDER80_FILE = 'series_24h_under80.json';
const SERIES_UNDER80_CLOUD_PATH = 'fc27/market/' + SERIES_UNDER80_FILE;
const SERIES_UNDER80_READ_URL = SERIES_DOMAIN + '/' + SERIES_UNDER80_CLOUD_PATH;
const ALERTS_FILE = 'under80_alerts.json';
const ALERTS_CLOUD_PATH = 'fc27/market/' + ALERTS_FILE;
// 80↓ 异动阈值（单点可调，经真实抽样校准，详见 market_core.js#computeUnder80Alerts 注释）。
//   MARGIN: 当前价 > 该总评均值×MARGIN 即「明显偏高」；MOVE_PCT: 近 6h 累计涨跌≥该值即「异动」。
const UNDER80_CFG = { MARGIN: 1.5, MOVE_PCT: 30, WINDOW: 6, RECENT: 12 };
const FETCH_TIMEOUT = 30000;

// 北京时间（UTC+8）分桶：YYYYMMDDHHMM（纯小时粒度，分钟固定 00）。⚠️ 必须与端上 utils/priceStore.js#bucketOf 一致。
function pad2(n) { return n < 10 ? '0' + n : '' + n; }
function bucketOf(d) {
  d = d || new Date();
  const ms = d.getTime() + 8 * 60 * 60 * 1000;
  const z = new Date(ms);
  return '' + z.getUTCFullYear() + pad2(z.getUTCMonth() + 1) + pad2(z.getUTCDate()) + pad2(z.getUTCHours()) + '00';
}

function httpGetJson(url, timeoutMs) {
  timeoutMs = timeoutMs || FETCH_TIMEOUT;
  return new Promise(function (resolve, reject) {
    const timer = setTimeout(function () {
      req.destroy();
      reject(new Error('timeout'));
    }, timeoutMs);
    const req = https.get(url, function (res) {
      let data = '';
      res.on('data', function (chunk) { data += chunk; });
      res.on('end', function () {
        clearTimeout(timer);
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(data)); }
          catch (e) { reject(new Error('json parse error: ' + e.message)); }
        } else {
          reject(new Error('http ' + res.statusCode));
        }
      });
    });
    req.on('error', function (err) {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

// 名册拉取：裸 8s 超时在跨太平洋（GitHub runner → 腾讯云 COS）偶发超时报错，
// 与价格拉取（market_core.js#pullPlatforms）保持同口径 —— 3 次重试 + 退避。
async function loadRoster() {
  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const j = await httpGetJson(ROSTER_URL);
      const list = Array.isArray(j) ? j : (j.players || []);
      return list
        .filter(function (p) { return p && p.eaId != null; })
        .map(function (p) {
          return { eaId: p.eaId, name: p.name || '', overall: p.overall || 0, pos: p.pos || '', imagePath: p.imagePath || '', rarity: p.rarity || '' };
        });
    } catch (e) {
      lastErr = e;
      logStep('loadRoster attempt ' + attempt + ' failed: ' + (e && e.message || e));
      if (attempt < 3) await sleep(800 * attempt);
    }
  }
  throw new Error('loadRoster 重试 3 次仍失败: ' + (lastErr && lastErr.message || lastErr));
}

// ── 上传（@cloudbase/node-sdk，与 export-roster-83plus.yml 同链） ──
let __tcbApp = null;
function tcbApp() {
  if (__tcbApp) return __tcbApp;
  const envId = process.env.TCB_ENV_ID;
  const sid = process.env.TCB_SECRET_ID;
  const skey = process.env.TCB_SECRET_KEY;
  if (!envId || !sid || !skey) throw new Error('缺 TCB_ENV_ID / TCB_SECRET_ID / TCB_SECRET_KEY');
  const cloudbase = require('@cloudbase/node-sdk');
  __tcbApp = cloudbase.init({ env: envId, secretId: sid, secretKey: skey, timeout: 180000 });
  return __tcbApp;
}
async function uploadText(cloudPath, obj) {
  const buf = Buffer.from(JSON.stringify(obj));
  const res = await tcbApp().uploadFile({ cloudPath: cloudPath, fileContent: buf });
  console.log('  -> 上传 ' + cloudPath + ' → ' + JSON.stringify(res).slice(0, 160));
  return res;
}

// 读旧 series（公有读直链，读用 60s 超时 —— 上传已按 #116 加固，读也要对齐）。
// ⚠️ 关键：严格区分「文件不存在（404=首次运行，合法）」与「瞬断（超时/连接错误/5xx）」。
//   瞬断连续 3 次 ⇒ 抛错（而非返回 null），让上层「跳过本次 series 上传、保留云上旧文件」。
//   这是 10/13 10:00 数据被重置的根因修复点：绝不再把瞬断当成「没历史」去覆盖真实文件。
// url 可传（默认 80+ 的 SERIES_READ_URL）；sub-80 传 SERIES_UNDER80_READ_URL 复用同一套加固语义。
async function readOldSeries(url) {
  url = url || SERIES_READ_URL;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const j = await httpGetJson(url, 60000);
      if (j && j.players) return j;
      return null; // 拿到了但结构不符（空/无 players）→ 视同首跑
    } catch (e) {
      const msg = (e && e.message) || '';
      if (msg.indexOf('404') >= 0) return null; // 真·首次运行：文件不存在，合法
      logStep('readOldSeries attempt ' + attempt + ' 失败(' + url.split('/').pop() + '): ' + msg);
      if (attempt < 3) await sleep(800 * attempt);
      if (attempt === 3) {
        // 连续瞬断 ⇒ 抛错，上层据此跳过本次 series 写，云上旧文件原样保留
        throw new Error('readOldSeries 连续 3 次瞬断（非 404），放弃本次 series 更新以保留云上旧文件: ' + msg);
      }
    }
  }
  throw new Error('readOldSeries 意外退出');
}

// 上传带超时+重试（#116 模式：SDK 层硬上限 180s，外层 race 200s > SDK timeout，3 次重试）。
// 单文件偶发卡死无告警 ⇒ 必须 race 让其先自我中止再重试。
async function uploadJsonSafe(cloudPath, obj) {
  const RACE = 200000;
  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const buf = Buffer.from(JSON.stringify(obj));
      const p = tcbApp().uploadFile({ cloudPath: cloudPath, fileContent: buf });
      const race = new Promise(function (_, rej) { setTimeout(function () { rej(new Error('upload race timeout')); }, RACE); });
      await Promise.race([p, race]);
      console.log('  -> 上传 ' + cloudPath + ' ✓ (attempt ' + attempt + ')');
      return;
    } catch (e) {
      lastErr = e;
      console.warn('[market_sync_gh] uploadJsonSafe attempt ' + attempt + ' 失败: ' + (e && e.message || e));
      if (attempt < 3) await sleep(1000 * attempt);
    }
  }
  throw new Error('uploadJsonSafe 重试 3 次仍失败: ' + (lastErr && lastErr.message || lastErr));
}

// 打日志带相对启动耗时，便于在 Actions 日志里定位是哪一步超时
const __startMs = Date.now();
function logStep(label) {
  console.log('[market_sync_gh] ' + label + ' @' + (Date.now() - __startMs) + 'ms');
}

// ── 正常每小时同步 ──
async function runHourlySync(doUpload) {
  const runStart = Date.now();
  logStep('runHourlySync start (upload=' + !!doUpload + ')');

  const roster = await loadRoster();
  logStep('loadRoster done, n=' + roster.length);
  if (!roster.length) throw new Error('roster 为空，疑似 roster_83plus.json 未发布或 URL 不可达');

  // 拉 83+ 价（pc+ps 并行，并发 6，561 人 ≈ 12 批，预期 ≤~8s）
  const pull = await core.pullPlatforms(roster, 0, 6);
  logStep('pullPlatforms done, failed=' + pull.failed + '/' + pull.batches + ', keys=' + Object.keys(pull.rows).length);
  if (pull.failed >= pull.batches) {
    // ⚠️ 抓价全部失败 ⇒ 早退，不写新文件（端上靠 ts 判 stale，不许静默）
    throw new Error('抓价全部失败（' + pull.failed + '/' + pull.batches + ' 批），早退');
  }

  const now = Date.now();
  const built = core.build(roster, pull.rows, {}, 'futnext');
  logStep('build done, tierN=' + built.tierN);

  const bucket = bucketOf();
  if (doUpload) {
    await uploadJsonSafe(PRICE_VIEW_PREFIX + bucket + '.json', built.view);
    logStep('upload view done, bucket=' + bucket);
    // 24h 序列：读旧 → 位移追加 → 写回。
    // ⚠️ 读旧瞬断 ⇒ catch 跳过本次 series 更新，云上旧文件原样保留，绝不覆盖历史。
    try {
      const oldSeries = await readOldSeries();   // 404→null(首跑)；瞬断→throw(被下方 catch 兜住)
      const series = core.buildSeries(oldSeries, built, bucket);
      // 内存不变量：非首跑时新桶数不得少于旧桶数（防御 buildSeries 回归）
      if (oldSeries && series.buckets.length < oldSeries.buckets.length) {
        console.warn('[market_sync_gh] ⚠️ 新序列桶数(' + series.buckets.length + ') < 旧(' + oldSeries.buckets.length + ')，疑似 buildSeries 回归');
      }
      // 先备后覆盖：把「覆盖前云上旧文件」存一份 backup，再写主文件
      if (oldSeries) {
        try { await uploadJsonSafe(SERIES_CLOUD_PATH_BACKUP, oldSeries); }
        catch (be) { console.warn('[market_sync_gh] backup 上传失败(非致命): ' + (be && be.message || be)); }
      }
      await uploadJsonSafe(SERIES_CLOUD_PATH, series);
      logStep('upload series done, players=' + Object.keys(series.players).length + ', buckets=' + series.buckets.length);
    } catch (se) {
      // 瞬断读旧失败 ⇒ 放弃本次 series 写，历史完好保留（最坏只漏这一小时的一个点）
      console.warn('[market_sync_gh] series 更新跳过（读旧瞬断，云上旧文件已保留）: ' + (se && se.message || se));
    }
  } else {
    logStep('DRY-RUN: 跳过上传（加 --upload 才写云存储），bucket=' + bucket);
  }

  return {
    ok: true,
    ts: now,
    bucket: bucket,
    tierN: built.tierN,
    costMs: now - runStart,
    pullFailed: pull.failed,
    pullBatches: pull.batches
  };
}

// ── 回填：用历史 price_view_<bucket>.json 重放 buildSeries，重建 series_24h.json ──
// 用途：10/13 10:00 瞬断把真实序列覆盖成 1 桶后，用历史每小时快照把丢失的小时补回来。
// 仅 workflow_dispatch（--backfill --upload，CI 带 TCB 密钥跑）；本地空跑只重建并落本地副本校验。
async function runBackfill(doUpload) {
  logStep('runBackfill start (upload=' + !!doUpload + ')');
  const now = new Date();
  let series = null;
  let included = 0, skipped = 0, total = 0;
  for (let off = -24; off <= 0; off++) {
    // 直接用 now 的 UTC 瞬时；bucketOf 内部已做 UTC→北京偏移，切勿在外层再 +8h
    // （否则窗口整体后移 8h，漏掉最早 8 小时历史 —— 这是回填初版隐藏 bug，已修正）
    const d = new Date(now.getTime() + off * 3600 * 1000);
    const b = bucketOf(d);
    if (b > bucketOf(now)) { logStep('backfill ' + b + ' 超出当前，break'); break; }
    total++;
    try {
      const j = await httpGetJson(SERIES_DOMAIN + '/fc27/market/price_view_' + b + '.json', 60000);
      if (j && Array.isArray(j.tier) && j.tier.length) {
        series = core.buildSeries(series, { view: { tier: j.tier } }, b);
        included++;
      } else { skipped++; logStep('backfill ' + b + ' 跳过(无 tier/空)'); }
    } catch (e) {
      skipped++; // 该小时无快照（404）或瞬断 ⇒ 跳过，不阻断回填
      logStep('backfill ' + b + ' 跳过: ' + ((e && e.message) || e));
    }
  }
  logStep('backfill 汇总: total迭代=' + total + ' included=' + included + ' skipped=' + skipped);
  if (!series) { console.warn('[market_sync_gh] backfill 无可用快照，未生成序列'); return null; }
  // 本地校验：每个球员 pc/ps 数组长度必须与 buckets 长度对齐
  const L = series.buckets.length;
  let bad = 0;
  Object.keys(series.players).forEach(function (k) {
    const r = series.players[k];
    if ((r.pc || []).length !== L || (r.ps || []).length !== L) bad++;
  });
  logStep('backfill 校验: buckets=' + L + ' players=' + Object.keys(series.players).length + ' 对齐异常=' + bad + ' (应为 0)');
  fs.writeFileSync(__dirname + '/series_24h.backfill.json', JSON.stringify(series));
  logStep('backfill 本地副本已落 series_24h.backfill.json');
  if (doUpload) {
    await uploadJsonSafe(SERIES_CLOUD_PATH_BACKUP, series);
    await uploadJsonSafe(SERIES_CLOUD_PATH, series);
    logStep('backfill 上传完成（主文件 + backup 均已更新）');
  } else {
    logStep('DRY-RUN: 未上传（加 --upload 才写云存储）');
  }
  return series;
}

// ── 80↓ 异动监控（与 80+ 管线物理隔离：独立名册 / 独立序列文件 / 独立 try-catch） ──
// 失败绝不影响现有 80+ 同步。sub-80 全量 ≈18681 人（80+ 的 ~16.7 倍），但探针实测
// 零 429、墙钟 ~39s，可行；数量级过大时由 market-sync-under80.yml 降频为 2h 一次。
async function loadRosterUnder80() {
  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const j = await httpGetJson(ROSTER_UNDER80_URL);
      const list = Array.isArray(j) ? j : (j.players || []);
      return list
        .filter(function (p) { return p && p.eaId != null; })
        .map(function (p) {
          return { eaId: p.eaId, name: p.name || '', overall: p.overall || 0, pos: p.pos || '', imagePath: p.imagePath || '', rarity: p.rarity || '' };
        });
    } catch (e) {
      lastErr = e;
      logStep('loadRosterUnder80 attempt ' + attempt + ' failed: ' + (e && e.message || e));
      if (attempt < 3) await sleep(800 * attempt);
    }
  }
  throw new Error('loadRosterUnder80 重试 3 次仍失败: ' + (lastErr && lastErr.message || lastErr));
}

async function runUnder80Sync(doUpload) {
  const runStart = Date.now();
  logStep('runUnder80Sync start (upload=' + !!doUpload + ')');

  const roster = await loadRosterUnder80();
  logStep('loadRosterUnder80 done, n=' + roster.length);
  if (!roster.length) throw new Error('roster_under80 为空，疑似 roster_under80.json 未发布或 URL 不可达');

  // DRY 验证用：限制拉价人数（避免本地空跑也 hammer 全量 18k 请求），CI 全量不限制。
  const dryLimit = parseInt(process.env.UNDER80_DRY_LIMIT || '0', 10) || 0;
  const pullRoster = dryLimit > 0 ? roster.slice(0, dryLimit) : roster;

  const pull = await core.pullPlatforms(pullRoster, 0, 20);
  logStep('pullPlatforms(under80) done, failed=' + pull.failed + '/' + pull.batches + ', keys=' + Object.keys(pull.rows).length);
  if (pull.failed >= pull.batches) throw new Error('sub-80 抓价全部失败（' + pull.failed + '/' + pull.batches + ' 批），早退');

  const now = Date.now();
  // minRating=0 ⇒ 不过滤 overall，整批 sub-80 进 view（与 80+ 的 TIER_MIN=80 隔离）
  const built = core.build(pullRoster, pull.rows, {}, 'futnext', undefined, 0);
  logStep('build(under80) done, tierN=' + built.tierN);

  const bucket = bucketOf();
  if (doUpload) {
    // ⚠️ sub-80 不持久化每小时 view（≈18k 人/小时 storage 压力大）；仅维护滑窗序列 + 异动榜。
    // 序列若被重置，24h 滑窗会自愈（每小时追加）。
    try {
      const oldSeries = await readOldSeries(SERIES_UNDER80_READ_URL); // 404→null(首跑)；瞬断→throw(被下方 catch 兜住)
      const series = core.buildSeries(oldSeries, built, bucket);
      if (oldSeries && series.buckets.length < oldSeries.buckets.length) {
        console.warn('[market_sync_gh] ⚠️ under80 新序列桶数(' + series.buckets.length + ') < 旧(' + oldSeries.buckets.length + ')，疑似 buildSeries 回归');
      }
      if (oldSeries) {
        try { await uploadJsonSafe(SERIES_UNDER80_CLOUD_PATH + '.backup', oldSeries); }
        catch (be) { console.warn('[market_sync_gh] under80 backup 上传失败(非致命): ' + (be && be.message || be)); }
      }
      await uploadJsonSafe(SERIES_UNDER80_CLOUD_PATH, series);
      logStep('upload series_under80 done, players=' + Object.keys(series.players).length + ', buckets=' + series.buckets.length);

      // 异动榜：用全量序列 + 名册算，输出仅入选球员（端上只读这个，不下载大序列）
      const rosterMap = {};
      pullRoster.forEach(function (p) { rosterMap[String(p.eaId)] = p; });
      const alerts = core.computeUnder80Alerts(series, rosterMap, UNDER80_CFG);
      logStep('computeUnder80Alerts done, 入选=' + alerts.count);
      await uploadJsonSafe(ALERTS_CLOUD_PATH, alerts);
      logStep('upload under80_alerts done');
    } catch (se) {
      // 瞬断读旧失败 ⇒ 放弃本次 series/alerts 写，历史完好保留
      console.warn('[market_sync_gh] under80 series/alerts 更新跳过（读旧瞬断，云上旧文件已保留）: ' + (se && se.message || se));
    }
  } else {
    // DRY：落本地副本校验结构与对齐
    const oldSeries = (function () {
      try { return JSON.parse(fs.readFileSync(__dirname + '/series_24h_under80.dry.json', 'utf8')); } catch (e) { return null; }
    })();
    const series = core.buildSeries(oldSeries, built, bucket);
    fs.writeFileSync(__dirname + '/series_24h_under80.dry.json', JSON.stringify(series));
    const rosterMap = {};
    pullRoster.forEach(function (p) { rosterMap[String(p.eaId)] = p; });
    const alerts = core.computeUnder80Alerts(series, rosterMap, UNDER80_CFG);
    fs.writeFileSync(__dirname + '/under80_alerts.dry.json', JSON.stringify(alerts));
    // 本地校验对齐
    const L = series.buckets.length;
    let bad = 0;
    Object.keys(series.players).forEach(function (k) {
      const r = series.players[k];
      if ((r.pc || []).length !== L || (r.ps || []).length !== L) bad++;
    });
    logStep('DRY: 落 series_24h_under80.dry.json + under80_alerts.dry.json（bucket=' + bucket +
      ', seriesPlayers=' + Object.keys(series.players).length + ', 对齐异常=' + bad + ', 入选=' + alerts.count + '）');
  }

  return {
    ok: true, ts: now, bucket: bucket, tierN: built.tierN, costMs: now - runStart,
    pullFailed: pull.failed, pullBatches: pull.batches, dryLimit: dryLimit
  };
}

// ── main ──
(async function main() {
  const argv = process.argv.slice(2);
  const doUpload = argv.indexOf('--upload') >= 0;
  const doBackfill = argv.indexOf('--backfill') >= 0;
  const doUnder80 = argv.indexOf('--under80') >= 0;
  try {
    if (doUnder80) {
      const r = await runUnder80Sync(doUpload);
      console.log('[market_sync_gh] UNDER80 OK ' + JSON.stringify(r));
    } else if (doBackfill) {
      const s = await runBackfill(doUpload);
      console.log('[market_sync_gh] BACKFILL OK buckets=' + (s ? s.buckets.length : 0));
    } else {
      const r = await runHourlySync(doUpload);
      console.log('[market_sync_gh] OK ' + JSON.stringify(r));
    }
  } catch (e) {
    console.error('[market_sync_gh] FAIL: ' + (e && e.message || e));
    process.exitCode = 1;
  }
})();
