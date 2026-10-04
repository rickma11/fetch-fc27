// FC27 市场价「核心逻辑单一真源」。
// 本机入口 scripts/price_sync.js 与云端入口 scripts/price_sync_cloud.js **都必须** require 本文件，
// 谁都不许再抄第二份 —— 否则分档口径会随文件各自漂移（规则 93「行处理逻辑只能一份」）。
//
// 本文件**不碰任何本地文件系统**，IO 由两个入口各自负责。

const https = require('https');
const PRICE_API = 'https://enhancer-api.futnext.com/players/prices';
const BATCH = 50;          // 接口上限
// 并发实测（2026-09-27，792 批 / 19,716 条，本机）：并发 5 = 42.8s，并发 20 = 12.4s。
const CONCURRENCY = 20;
const CLOUD_ENV = 'cloud1-d5gq6q3np8708aeef';
const CLOUD_BUCKET = '636c-cloud1-d5gq6q3np8708aeef-1475854307';
// 卡面 cloud:// fileID（按有无半身像选真实卡面 _card.webp / 剪影 _np.webp）
// 2026-10-01 修正：云端卡面统一在 fc27/images/ 前缀下，与 format.js#cloudImg 口径一致。
function cardCloudId(eaId, hasPortrait) {
  return 'cloud://' + CLOUD_ENV + '.' + CLOUD_BUCKET + '/fc27/images/' + eaId + (hasPortrait ? '_card.webp' : '_np.webp');
}
const TIER_MIN = 80;       // 2026-10-03 拍板：83 → 80（市场页 81+ 分档 + 搜索 80+；原 85+/83+ 历史见 docs）
// ⚠️ 2026-10-03：异动榜（moves）已从产品下线 —— pct / moves 计算删除，
//   prev 快照与 price_all_market_latest.json 不再写也不再读（用户要求「去掉相关代码和跑数据，不浪费」）。

const key = function (v) { return typeof v === 'number' ? String(v) : String(v); };
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

// ── 问价（单批）──
// 微信云函数 runtime 是 Node 16，没有全局 fetch；本地/云端两份 market_core.js 统一用内置 https，
// 避免在云函数里触发 ReferenceError: fetch is not defined。
function fetchBatch(ids, platform) {
  const url = PRICE_API + '?ids=' + ids.map(key).join('_') + '&platform=' + platform;
  return new Promise(function (resolve, reject) {
    const req = https.get(url, function (res) {
      let data = '';
      res.on('data', function (chunk) { data += chunk; });
      res.on('end', function () {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(data)); }
          catch (e) { reject(new Error('json parse error on platform=' + platform + ': ' + e.message)); }
        } else {
          reject(new Error('HTTP ' + res.statusCode + ' on platform=' + platform));
        }
      });
    });
    req.on('error', function (err) { reject(err); });
    req.setTimeout(20000, function () {
      req.destroy();
      reject(new Error('timeout on platform=' + platform));
    });
  });
}

// pc 与 ps 必须**并行**拉（串行两段 = 43s，并行压到 ~25s）。
async function pullPlatforms(roster, limit, concurrency) {
  const conc = concurrency || CONCURRENCY;
  const ids = roster.map(function (x) { return x.eaId; });
  const take = limit && limit > 0 ? Math.min(ids.length, limit) : ids.length;

  const batches = [];
  ['pc', 'ps'].forEach(function (pf) {
    for (let i = 0; i < take; i += BATCH) batches.push({ ids: ids.slice(i, i + BATCH), pf: pf });
  });

  const out = {};          // eaId -> [pc, ps, xbox]
  let done = 0, failed = 0;
  let cursor = 0;
  const worker = async function () {
    while (cursor < batches.length) {
      const job = batches[cursor++];
      let retry = 0, ok = false;
      while (retry < 3 && !ok) {
        try {
          const arr = await fetchBatch(job.ids, job.pf);
          // ⚠️ 顶层数组，不是 {data:{…}}
          if (Array.isArray(arr)) {
            arr.forEach(function (row) {
              const did = row && row.definitionId != null ? key(row.definitionId) : null;
              if (!did) return;
              const p = Array.isArray(row.prices) ? row.prices.slice() : [];
              if (!out[did]) out[did] = [null, null, null];
              if (job.pf === 'pc') out[did][0] = p.length ? p[0] : null;
              else out[did][1] = p.length >= 2 ? p[1] : (p.length ? p[0] : null);
            });
            ok = true;
          } else {
            throw new Error('响应不是顶层数组：' + JSON.stringify(arr).slice(0, 80));
          }
        } catch (e) {
          retry++;
          if (retry >= 3) { failed++; }
          await sleep(600 * retry);
        }
      }
      done++;
      if (done % 80 === 0) {
        process.stdout.write('  … ' + done + '/' + batches.length +
          '（已收 ' + Object.keys(out).length + ' 条）\n');
      }
    }
  };
  await Promise.all(new Array(conc).fill(0).map(worker));
  return { rows: out, batches: batches.length, failed: failed };
}

// ── 组装两个信封 ──
// roster: [{eaId,name,overall,pos}]，来自精简表（云端）或 players.json（本机）
// cur/prev: {eaId: [pc, ps, xbox]}
function build(roster, cur, prev, src, tsOverride) {
  const ts = tsOverride || Date.now();
  const nameOf = {};
  roster.forEach(function (r) { nameOf[key(r.eaId)] = r; });

  // cur 里没本次返回值的 ⇒ 保留 prev（绝不写 0）
  const merged = {};
  Object.keys(cur).forEach(function (k) {
    const arr = cur[k];
    const has = arr && (arr[0] != null || arr[1] != null);
    if (!has && prev[k]) merged[k] = prev[k].slice();
    else merged[k] = arr;
  });

  // 分档 >= TIER_MIN（2026-10-03：80+）
  const tier = roster.filter(function (r) {
    const m = merged[key(r.eaId)];
    return r.overall >= TIER_MIN && m && (m[0] != null || m[1] != null);
  }).map(function (r) {
    const m = merged[key(r.eaId)] || [];
    return {
      eaId: r.eaId, name: r.name, overall: r.overall, pos: r.pos,
      pc: m[0] == null ? null : m[0], ps: m[1] == null ? null : m[1],
      img: cardCloudId(r.eaId, !!(r.imagePath)),
      rarity: r.rarity || ''
    };
  });

  // 异动榜已于 2026-10-03 下线：不再算 moves、view 不再带 moves 字段。

  const all = { v: 1, ts: ts, cur: merged, prev: prev, src: src };
  const view = { v: 1, ts: ts, tier: tier };
  return { ts: ts, all: all, view: view, tierN: tier.length, mergedN: Object.keys(merged).length };
}

module.exports = {
  PRICE_API: PRICE_API, BATCH: BATCH, TIER_MIN: TIER_MIN,
  key: key, sleep: sleep,
  fetchBatch: fetchBatch, pullPlatforms: pullPlatforms, build: build
};
