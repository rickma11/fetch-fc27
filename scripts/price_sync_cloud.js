// FC27 市场价同步 —— GitHub Actions 版（云函数 market_sync 的 port）。
//
// 来源：eafc-miniapp/cloudfunctions/market_sync/index.js（云函数副本）。
// 本脚本在 fetch-fc27 的 GitHub Actions 里跑，逻辑与端上契约**完全对齐**：
//   - 桶算法 = 北京时间纯小时（分钟固定 00），与端上 utils/priceStore.js#bucketOf 一致；
//   - 产出 price_view_<YYYYMMDDHH00>.json（端上只读这个）；
//   - prev 文件 = fc27/market/price_all_market_latest.json（{ts, prices}），与云函数同结构；
//   - 24h 异动门控：非门控日 moves=[]（端上「暂无可显异动」非 bug）。
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
const core = require('./market_core.js');

// ⚠️ 与云函数 market_sync 常量保持一致（勿改，否则端上契约漂移）。
const VER = 27;
const MOVES_INTERVAL_MS = 24 * 3600 * 1000;          // 异动榜每日一次
const PRICE_VIEW_PREFIX = 'fc27/market/price_view_';
const PREV_CLOUD_PATH = 'fc27/market/price_all_market_latest.json';
const ROSTER_URL = 'https://636c-cloud1-d5gq6q3np8708aeef-1475854307.tcb.qcloud.la/fc27/data/roster_83plus.json';
const PREV_URL = 'https://636c-cloud1-d5gq6q3np8708aeef-1475854307.tcb.qcloud.la/fc27/market/price_all_market_latest.json';
const FETCH_TIMEOUT = 8000;

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

async function loadRoster() {
  const j = await httpGetJson(ROSTER_URL);
  const list = Array.isArray(j) ? j : (j.players || []);
  return list
    .filter(function (p) { return p && p.eaId != null; })
    .map(function (p) {
      return { eaId: p.eaId, name: p.name || '', overall: p.overall || 0, pos: p.pos || '', imagePath: p.imagePath || '', rarity: p.rarity || '' };
    });
}

// prev 读：fetch 公有读 URL（0 腾讯配额）。失败返回 {}（非门控日 moves 自然为 []）
async function readPrev() {
  try {
    const j = await httpGetJson(PREV_URL);
    return { prices: (j && j.prices) || {}, ts: (j && j.ts) || 0 };
  } catch (e) {
    return { prices: {}, ts: 0 };
  }
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
  __tcbApp = cloudbase.init({ env: envId, secretId: sid, secretKey: skey, timeout: 120000 });
  return __tcbApp;
}
async function uploadText(cloudPath, obj) {
  const buf = Buffer.from(JSON.stringify(obj));
  const res = await tcbApp().uploadFile({ cloudPath: cloudPath, fileContent: buf });
  console.log('  -> 上传 ' + cloudPath + ' → ' + JSON.stringify(res).slice(0, 160));
  return res;
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
  const prevState = await readPrev();
  const lastRun = Math.max(prevState.ts || 0, 0);
  logStep('readPrev done, lastRun=' + lastRun);

  let built;
  let moved = false;
  if (now - lastRun >= MOVES_INTERVAL_MS) {
    // 门控日：用上轮全量价算异动榜，并回写当前价为新 prev
    logStep('moves gate open (now-lastRun=' + (now - lastRun) + 'ms)');
    built = core.build(roster, pull.rows, prevState.prices, 'futnext');
    if (doUpload) await uploadText(PREV_CLOUD_PATH, { ts: now, prices: pull.rows });
    moved = true;
    logStep('upload prev done');
  } else {
    // 非门控日：prev={} ⇒ build 内 moves=[]（端上「暂无可显异动」非 bug）
    logStep('moves gate skip (now-lastRun=' + (now - lastRun) + 'ms)');
    built = core.build(roster, pull.rows, {}, 'futnext');
  }
  logStep('build done, tierN=' + built.tierN + ', mvN=' + built.mvN);

  const bucket = bucketOf();
  if (doUpload) {
    await uploadText(PRICE_VIEW_PREFIX + bucket + '.json', built.view);
    logStep('upload view done, bucket=' + bucket);
  } else {
    logStep('DRY-RUN: 跳过上传（加 --upload 才写云存储），bucket=' + bucket);
  }

  return {
    ok: true,
    ts: now,
    bucket: bucket,
    tierN: built.tierN,
    mvN: built.mvN,
    moved: moved,
    costMs: now - runStart,
    pullFailed: pull.failed,
    pullBatches: pull.batches
  };
}

// ── main ──
(async function main() {
  const argv = process.argv.slice(2);
  const doUpload = argv.indexOf('--upload') >= 0;
  try {
    const r = await runHourlySync(doUpload);
    console.log('[market_sync_gh] OK ' + JSON.stringify(r));
  } catch (e) {
    console.error('[market_sync_gh] FAIL: ' + (e && e.message || e));
    process.exitCode = 1;
  }
})();
