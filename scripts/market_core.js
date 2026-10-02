// FC27 市场价「核心逻辑单一真源」。
// 本机入口 scripts/price_sync.js 与云端入口 scripts/price_sync_cloud.js **都必须** require 本文件，
// 谁都不许再抄第二份 —— 否则分档/异动榜口径会随文件各自漂移（规则 93「行处理逻辑只能一份」）。
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
const TIER_MIN = 83;       // 2026-09-27 拍板：从 85+ 扩到 83+（85+ 只有 424 张）
const MOVE_MIN_PCT = 20;   // 异动榜门槛
const MOVE_TOP = 200;
// ⚠️ 基准价下限（2026-09-27 实测发现）：
//   futnext 对「当时几乎无人挂单」的卡会回一个很低的占位价（200 / 750 / 850…），
//   一旦真实挂单出现就是 +2400% / +1233% 这种假异动，把异动榜整页刷满垃圾。
//   实测样例：Kevin Angulo 200→5000 (+2400%)、Patrik Hrošovský 750→10000 (+1233%)。
//   首轮 1000 档仍漏：云端实跑异动前 5 条全是占位价（Gorosabel 1900→9400、
//   Ali Gholizadeh 1000→4700、Reena Wichmann 1700→7400、Luca Bazzoli 2300→10000）⇒ 提到 2500。
//   故：**上一轮价格低于此值的卡不进异动榜**（它的旧价不可信）。
let MIN_BASE = 2500;

function setMinBase(v) { MIN_BASE = v; }
function getMinBase() { return MIN_BASE; }

const key = function (v) { return typeof v === 'number' ? String(v) : String(v); };
const pct = function (prev, cur) {
  if (!prev || prev <= 0) return null;             // 无基准 ⇒ 不敢算
  return (cur - prev) / prev * 100;
};
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

  // 分档 >= 83
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

  // 异动榜：|dPct| >= 门槛，按 dPct 降序取前 N
  const moves = [];
  Object.keys(merged).forEach(function (k) {
    const m = merged[k];
    if (!m) return;
    const curP = m[0] != null ? m[0] : m[1];
    const pv = prev[k];
    if (!pv) return;
    const prevP = pv[0] != null ? pv[0] : pv[1];
    const d = pct(prevP, curP);
    if (d == null) return;
    if (Math.abs(d) < MOVE_MIN_PCT) return;
    if (prevP < MIN_BASE) return;   // 占位价卡，旧值不可信
    const meta = nameOf[k] || {};
    moves.push({
      eaId: k, name: meta.name || '', pos: meta.pos || '',
      overall: meta.overall || 0,
      prev: prevP, cur: curP, dPct: Math.round(d * 100) / 100,
      img: cardCloudId(k, !!(meta && meta.imagePath)),
      rarity: (meta && meta.rarity) || ''
    });
  });
  moves.sort(function (a, b) { return b.dPct - a.dPct; });
  const mv = moves.slice(0, MOVE_TOP);

  const all = { v: 1, ts: ts, cur: merged, prev: prev, src: src };
  const view = { v: 1, ts: ts, tier: tier, moves: mv };
  return { ts: ts, all: all, view: view, tierN: tier.length, mvN: mv.length, mergedN: Object.keys(merged).length };
}

module.exports = {
  PRICE_API: PRICE_API, BATCH: BATCH, TIER_MIN: TIER_MIN,
  MOVE_MIN_PCT: MOVE_MIN_PCT, MOVE_TOP: MOVE_TOP,
  key: key, pct: pct, sleep: sleep,
  fetchBatch: fetchBatch, pullPlatforms: pullPlatforms, build: build,
  setMinBase: setMinBase, getMinBase: getMinBase
};
