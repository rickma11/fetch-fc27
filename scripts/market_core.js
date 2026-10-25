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
// minRating: 分档下限（默认 TIER_MIN=80，即 80+；sub-80 监控传 0 关闭过滤）。
//   ⚠️ 向后兼容：80+ 管线不传该参数 ⇒ 行为完全不变。
function build(roster, cur, prev, src, tsOverride, minRating) {
  const ts = tsOverride || Date.now();
  const MIN = (minRating != null) ? minRating : TIER_MIN;
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

  // 分档 >= MIN（默认 80+；sub-80 监控传 minRating=0 ⇒ 整批 sub-80 进 tier）
  const tier = roster.filter(function (r) {
    const m = merged[key(r.eaId)];
    return r.overall >= MIN && m && (m[0] != null || m[1] != null);
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

// ── 24h 序列聚合（供 price_sync_cloud.js 每小时增量生成 series_24h.json） ──
// 契约（端上 utils/priceSeries.js 只读）：
//   series = { v, ts, buckets:[≤24 个 YYYYMMDDHH00], players:{ eaId:{ pc:[≤24], ps:[≤24] } } }
//   - 数组与 buckets 按下标对齐；缺失小时为 null。
//   - 前 24 小时逐小时累积（buckets 增长 1→24）；满 24 后滑动窗口（去最旧、补最新）。
//   - 同小时重跑（cron 双触发）：替换最后一点而非位移，保证幂等。
// ⚠️ 粒度必须为「每小时」：端上 priceStore.bucketOf 与 price_sync_cloud.bucketOf 一致；
//    绝不能接 price_sync.js 的 20 分钟粒度（会让端上 statsOf 取错窗口）。
// 纯函数（无 IO、无 bucket 依赖），scripts/price_series_test.js 离线覆盖。
function buildSeries(old, built, curBucket) {
  old = old || {};
  var oldBuckets = Array.isArray(old.buckets) ? old.buckets : [];
  var oldPlayers = old.players || {};
  var B = oldBuckets.length;

  var newBuckets, shifted;
  if (B && oldBuckets[B - 1] === curBucket) {
    newBuckets = oldBuckets.slice();                      // 同小时重跑：不位移
    shifted = false;
  } else if (B < 24) {
    newBuckets = oldBuckets.concat([curBucket]);          // 累积阶段（1→24）
    shifted = true;
  } else {
    newBuckets = oldBuckets.slice(1).concat([curBucket]); // 满 24：滑动窗口
    shifted = true;
  }
  var L = newBuckets.length; // 1..24

  var tier = (built && built.view && (built.view.tier || built.tier)) || [];
  var curMap = {};
  tier.forEach(function (t) { curMap[String(t.eaId)] = t; });

  function shiftAppend(oldArr, newVal) {
    var arr = Array.isArray(oldArr) ? oldArr.slice() : [];
    if (shifted) {
      if (B >= 24 && arr.length >= 24) arr = arr.slice(1); // 已满：去最旧一点
      arr.push(newVal);
    } else {
      // 同小时重跑：替换最后一点
      if (arr.length) arr[arr.length - 1] = newVal;
      else { var pad = new Array(L - 1); for (var i = 0; i < L - 1; i++) pad[i] = null; pad.push(newVal); arr = pad; }
    }
    while (arr.length < L) arr.unshift(null); // 新加入球员补齐前导 null，与 buckets 对齐
    return arr;
  }

  var players = {};
  Object.keys(curMap).forEach(function (eaId) {
    var t = curMap[eaId];
    var oldRec = oldPlayers[eaId] || {};
    players[eaId] = { pc: shiftAppend(oldRec.pc, t.pc), ps: shiftAppend(oldRec.ps, t.ps) };
  });
  Object.keys(oldPlayers).forEach(function (eaId) { // 本次快照缺失的球员：补 null 保留连续性
    if (curMap[eaId]) return;
    var oldRec = oldPlayers[eaId];
    players[eaId] = { pc: shiftAppend(oldRec.pc, null), ps: shiftAppend(oldRec.ps, null) };
  });
  Object.keys(players).forEach(function (eaId) { // 清理连续 24h 全 null（已离场）
    var r = players[eaId];
    var allNull = r.pc.every(function (x) { return x == null; }) && r.ps.every(function (x) { return x == null; });
    if (allNull) delete players[eaId];
  });
  return { v: 1, ts: Date.now(), buckets: newBuckets, players: players };
}

// ── 80↓ 每小时 slim 快照（方案 C；2026-10-17）──
// 动机：series_24h_under80.json 若被重置/损坏，历史上无原料可回填（10-17 07:00 事故丢了 19 小时）。
//   每小时存一份「当小时全员价格表」，回填命令即可重放重建（与 80+ 的 price_view 同机制）。
// 体积：只投影 buildSeries 重放所需的三个字段（eaId/pc/ps），实测 18680 人 ≈0.52MB/小时；
//   完整 view（含 name/img/rarity）≈2.7MB/小时，是原代码不上传 hourly view 的原因，slim 是它的 1/5。
// ⚠️ 必须含全员：computeUnder80Alerts 的「同总评均价」从序列全量球员按 overall 分组计算，
//   只存入选球员会把均值算歪、above 判定失效。
// 格式与 80+ price_view_<bucket>.json 同构 { v, ts, tier:[{eaId,pc,ps}] }，可直接喂 buildSeries。
function slimSnapshot(built) {
  var tier = (built && built.view && built.view.tier) || [];
  var out = [];
  for (var i = 0; i < tier.length; i++) {
    var t = tier[i];
    if (t && t.eaId != null) {
      out.push({ eaId: t.eaId, pc: t.pc == null ? null : t.pc, ps: t.ps == null ? null : t.ps });
    }
  }
  return { v: 1, ts: (built && built.ts) || Date.now(), tier: out };
}

// ── 80↓ 价格异动榜计算（纯函数，无 IO；供 price_sync_cloud.js#runUnder80Sync 调用） ──
// series: buildSeries 产物 { v, ts, buckets:[≤24 个 YYYYMMDDHH00], players:{ eaId:{ pc:[≤24], ps:[≤24] } } }
// rosterMap: { eaId: { name, overall, pos, imagePath, rarity } }（来自 roster_under80.json#players，按 eaId 索引）
// cfg: { MARGIN, MOVE_PCT, WINDOW, RECENT }（阈值，默认值见下）
//
// 入选规则（并集）：
//   (a) 当前价 > 该总评均值 × MARGIN —— 同 overall 分组，pc/ps 各自算均值，任一平台超即命中 'abovePc'/'abovePs'
//   (b) 近 WINDOW 小时累计涨跌幅绝对值 ≥ MOVE_PCT% —— pc/ps 任一命中 'movePc'/'movePs'
//
// 输出 under80_alerts.json 结构：仅含被选中球员，内联近 RECENT 小时价（recent.pc/recent.ps）供端上弹层画折线，
//   不再依赖那个大序列文件（series_24h_under80.json 仅 CI 读写、端上不下载）。
// ⚠️ 2026-10-17 瘦身（alerts 3.59MB 上传连续被 SDK 强杀，UserNetworkTooSlow）：小时桶标签 buckets
//   所有球员完全相同，提到文档级 recentBuckets 共享一份，每条 alert 只留 recent.pc/ps ——
//   实测 -29%（3.59MB→~2.5MB）。v=2；端上 priceStore/market 已做新旧结构双兼容读法。
//
// ⚠️ 阈值经真实抽样校准（2026-10-14）：sub-80 各 overall 档价格分布集中，MARGIN=1.5 全量预计 ≈981 人、
//   MARGIN=1.3≈1625 / 1.8≈719；MOVE_PCT=30 在 6h 内属真实大异动。两者并集即异动榜，集中在千级、可滚动。
function computeUnder80Alerts(series, rosterMap, cfg) {
  cfg = cfg || {};
  const MARGIN = (cfg.MARGIN != null) ? cfg.MARGIN : 1.5;
  const MOVE_PCT = (cfg.MOVE_PCT != null) ? cfg.MOVE_PCT : 30;
  const WINDOW = (cfg.WINDOW != null) ? cfg.WINDOW : 6;
  const RECENT = (cfg.RECENT != null) ? cfg.RECENT : 12;

  const buckets = Array.isArray(series.buckets) ? series.buckets : [];
  const players = series.players || {};
  const L = buckets.length;
  if (!L) {
    return { v: 2, ts: series.ts || Date.now(), generatedAt: Date.now(), cfg: { MARGIN: MARGIN, MOVE_PCT: MOVE_PCT, WINDOW: WINDOW, RECENT: RECENT }, recentBuckets: [], count: 0, alerts: [] };
  }

  // 1) 取每个球员「末位非空」当前价，按 overall 分组算 pc/ps 均值
  const groups = {};      // overall -> { pc:[], ps:[] }
  const curByEa = {};     // eaId -> { pc, ps, ovr, meta }
  Object.keys(players).forEach(function (eaId) {
    const rec = players[eaId];
    const pcArr = rec.pc || [];
    const psArr = rec.ps || [];
    let pc = null, ps = null;
    for (let i = L - 1; i >= 0; i--) { if (pcArr[i] != null) { pc = pcArr[i]; break; } }
    for (let i = L - 1; i >= 0; i--) { if (psArr[i] != null) { ps = psArr[i]; break; } }
    if (pc == null && ps == null) return; // 当前无价，跳过
    const meta = rosterMap[eaId] || {};
    const ovr = meta.overall || 0;
    if (!groups[ovr]) groups[ovr] = { pc: [], ps: [] };
    if (pc != null) groups[ovr].pc.push(pc);
    if (ps != null) groups[ovr].ps.push(ps);
    curByEa[eaId] = { pc: pc, ps: ps, ovr: ovr, meta: meta };
  });

  const meanOf = function (arr) { if (!arr.length) return null; let s = 0; arr.forEach(function (x) { s += x; }); return s / arr.length; };
  const meanPcByOvr = {}, meanPsByOvr = {};
  Object.keys(groups).forEach(function (ovr) {
    meanPcByOvr[ovr] = meanOf(groups[ovr].pc);
    meanPsByOvr[ovr] = meanOf(groups[ovr].ps);
  });

  // 2) 逐球员判定（above / move 并集）
  const alerts = [];
  // 近 RECENT 小时窗口起点：所有球员共用（buckets 已提文档级 recentBuckets，见返回处）
  const start = Math.max(0, L - RECENT);
  Object.keys(curByEa).forEach(function (eaId) {
    const c = curByEa[eaId];
    const mPc = meanPcByOvr[c.ovr];
    const mPs = meanPsByOvr[c.ovr];
    const ratioPc = (mPc && mPc > 0 && c.pc != null) ? c.pc / mPc : null;
    const ratioPs = (mPs && mPs > 0 && c.ps != null) ? c.ps / mPs : null;

    const flags = [];
    if (ratioPc != null && ratioPc >= MARGIN) flags.push('abovePc');
    if (ratioPs != null && ratioPs >= MARGIN) flags.push('abovePs');

    // 近 WINDOW 小时累计涨跌（相对 WINDOW 步前的末位非空值）
    const chg = function (arr) {
      if (!arr || !arr.length) return null;
      let cur = null; for (let i = L - 1; i >= 0; i--) { if (arr[i] != null) { cur = arr[i]; break; } }
      if (cur == null) return null;
      const idx = Math.max(0, L - 1 - WINDOW);
      let base = null; for (let i = idx; i >= 0; i--) { if (arr[i] != null) { base = arr[i]; break; } }
      if (base == null || base === 0) return null;
      return (cur - base) / base * 100;
    };
    const chgPc = chg(players[eaId].pc);
    const chgPs = chg(players[eaId].ps);
    if (chgPc != null && Math.abs(chgPc) >= MOVE_PCT) flags.push('movePc');
    if (chgPs != null && Math.abs(chgPs) >= MOVE_PCT) flags.push('movePs');

    if (!flags.length) return;

    // 内联近 RECENT 小时价格（与文档级 recentBuckets 按下标对齐），供端上弹层画折线。
    // 不再内联 buckets（每条重复 12 个标签 ≈170B，6572 条 ≈1.1MB，是 alerts 超大的元凶）。
    alerts.push({
      eaId: eaId,
      name: c.meta.name || '',
      overall: c.ovr,
      pos: c.meta.pos || '',
      img: cardCloudId(eaId, !!(c.meta.imagePath)),  // 与 build()#tier.img 同口径（有像_card / 无像_np）
      rarity: c.meta.rarity || '',
      pc: c.pc, ps: c.ps,
      meanPc: mPc != null ? Math.round(mPc) : null,
      meanPs: mPs != null ? Math.round(mPs) : null,
      ratioPc: ratioPc != null ? +ratioPc.toFixed(3) : null,
      ratioPs: ratioPs != null ? +ratioPs.toFixed(3) : null,
      chg6hPc: chgPc != null ? +chgPc.toFixed(1) : null,
      chg6hPs: chgPs != null ? +chgPs.toFixed(1) : null,
      flags: flags,
      recent: { pc: (players[eaId].pc || []).slice(start), ps: (players[eaId].ps || []).slice(start) }
    });
  });

  // 排序：先 overall 降序（高总评优先），同分按「异动强度」降序（最明显排最前）
  const score = function (x) {
    return Math.max(x.ratioPc || 0, x.ratioPs || 0, Math.abs(x.chg6hPc || 0) / 10, Math.abs(x.chg6hPs || 0) / 10);
  };
  alerts.sort(function (a, b) {
    if (b.overall !== a.overall) return b.overall - a.overall;
    return score(b) - score(a);
  });

  return {
    v: 2, ts: series.ts || Date.now(), generatedAt: Date.now(),
    cfg: { MARGIN: MARGIN, MOVE_PCT: MOVE_PCT, WINDOW: WINDOW, RECENT: RECENT },
    recentBuckets: buckets.slice(start),
    count: alerts.length, alerts: alerts
  };
}

// ── 按天聚合（2026-10-23 新增，供 price_sync_cloud.js 每小时生成 daily_7d.json）──
// 契约（端上 utils/priceSeries.js#getDaily 只读）：
//   daily = { v, ts, days:['YYYYMMDD' ×N(≤DAILY_KEEP_DAYS)], players:{ eaId:{ pc:[[avg,min,max]|null ×N], ps:[...] } } }
//   - 数组与 days 按下标对齐；当日无数据为 null。
//   - 「当日」口径：当日已采集小时点的算术平均（avg=round(mean)）与 min/max。
//   - **无累积状态**：每小时从新 series 里截取「今日桶」重算当日值；过去日保持冻结值
//     （昨日最后一次写入=23:00 那一刻=全日 24 点精确值），避免 sum/count 状态漂移。
//   - 跨日（北京）自动滚动：push 新日、丢最旧（>DAILY_KEEP_DAYS）。
//   - 同小时重跑幂等：今日值整体重算替换，历史不动。
//   - ⚠️ 同日重跑（days≥2）必须先剥掉旧数组末格的「上一小时今日残留值」再拼历史列——
//     2026-10-25 修复的列错位 bug：旧代码把残留值当成历史保留，导致「昨日」列显示的
//     是今日上午的旧值（线上实证：昨日列与今日真值更近的卡 1064/1128 张），
//     market_overview「vs 昨日」因此恒为 0%，端上按天视图同期起显示错位点。
// 纯函数（无 IO），scripts/daily_agg_test.js 离线覆盖（场景 9 专测同日重跑不错位）。
// ⚠️ 2026-10-25：7→14（市场概览 14 日指数/振幅窗口，用户拍板；docs/37 §5）。
//   存量云上文件 ≤7 天不受影响：alignHist 只保留末尾 keep 格，days 逐日增长至 14 封顶。
var DAILY_KEEP_DAYS = 14;
function updateDaily(oldDaily, series, dayKey) {
  oldDaily = oldDaily || {};
  var oldDays = Array.isArray(oldDaily.days) ? oldDaily.days.slice() : [];
  // 同日重跑判定（必须在 push 新日之前取旧 days 末位）
  var sameDayRerun = oldDays.length > 0 && oldDays[oldDays.length - 1] === dayKey;
  var days = oldDays.slice();
  var oldPlayers = oldDaily.players || {};
  if (days[days.length - 1] !== dayKey) {
    days.push(dayKey);
    while (days.length > DAILY_KEEP_DAYS) days.shift();
  }
  var keep = days.length - 1;                       // 历史格数（去掉今日）
  var buckets = (series && series.buckets) || [];
  var sPlayers = (series && series.players) || {};
  // 今日桶在 series 里的下标（桶标签前 8 位=北京日期 YYYYMMDD）
  var todayIdx = [];
  for (var i = 0; i < buckets.length; i++) {
    if (String(buckets[i]).slice(0, 8) === dayKey) todayIdx.push(i);
  }
  function dayAgg(arr) {
    var vals = [];
    for (var k = 0; k < todayIdx.length; k++) { var v = arr[todayIdx[k]]; if (v != null) vals.push(v); }
    if (!vals.length) return null;
    var s = 0, mn = vals[0], mx = vals[0];
    for (var j = 0; j < vals.length; j++) { s += vals[j]; if (vals[j] < mn) mn = vals[j]; if (vals[j] > mx) mx = vals[j]; }
    return [Math.round(s / vals.length), mn, mx];
  }
  function alignHist(arr) {                        // 历史列对齐：保留末尾 keep 格，不足前导补 null
    var a = Array.isArray(arr) ? arr.slice() : [];
    // 同日重跑：旧数组末格是「上一小时算出的今日残留值」而非历史，先剥掉（2026-10-25 bug 修复）
    if (sameDayRerun && a.length) a = a.slice(0, a.length - 1);
    if (a.length > keep) a = a.slice(a.length - keep);
    while (a.length < keep) a.unshift(null);
    return a;
  }
  var players = {};
  Object.keys(oldPlayers).forEach(function (eaId) { // 旧球员：历史列保留（滚掉最旧日）
    var r = oldPlayers[eaId] || {};
    players[eaId] = { pc: alignHist(r.pc), ps: alignHist(r.ps) };
  });
  Object.keys(sPlayers).forEach(function (eaId) {   // 今日值：来自 series 今日桶
    var r = sPlayers[eaId] || {};
    var aPc = dayAgg(r.pc || []), aPs = dayAgg(r.ps || []);
    if (!aPc && !aPs) return;                       // 今日两平台都无数据
    if (!players[eaId]) players[eaId] = { pc: new Array(keep).fill(null), ps: new Array(keep).fill(null) };
    players[eaId].pc.push(aPc);                     // 新球员历史列补 null 对齐
    players[eaId].ps.push(aPs);
  });
  Object.keys(players).forEach(function (eaId) {    // 今日缺席的旧球员补 null，保对齐
    var r = players[eaId];
    while (r.pc.length < days.length) r.pc.push(null);
    while (r.ps.length < days.length) r.ps.push(null);
    if (r.pc.length > days.length) r.pc = r.pc.slice(-days.length);
    if (r.ps.length > days.length) r.ps = r.ps.slice(-days.length);
  });
  return { v: 1, ts: Date.now(), days: days, players: players };
}

// ── 市场整体波动聚合（2026-10-25 新增，供 price_sync_cloud.js 每小时生成 market_overview.json）──
// 方案：docs/37-market-overview-design.md（用户 10-25 拍板：切法 B / 14 日 / 高价两档）。
// 输入：
//   daily: core.updateDaily 产物 { v, ts, days:['YYYYMMDD' ≤14], players:{ eaId:{ pc:[[avg,min,max]|null ×N], ps:[...] } } }
//   built: core.build 产物（built.view.tier 已带 rarity/overall/pc/ps，line 134）
//   dayKey: 北京日期 YYYYMMDD（今日格；找不到 ⇒ 无当日对比，统计按「积累中」输出）
// 输出契约（端上 pages/market-overview 只读）：
//   { v, ts, days, cats:[{key,label,cards}×9], unCat,
//     index:{ pc:{ all:[median|null ×N], <catKey>:[...] }, ps:{...} },
//     today:{ pc:{ all:{cards,cmp,avgChg,up,hold,down,vol5,amp,ampN}, cats:{...}, tiers:{'500k':{cards,chg},'1m':{...}} }, ps:{...} } }
//   - index/today.cats 只输出 cards>0 的分类（端上空分类隐藏）；cats 始终给全 9 档（cards 可为 0）
//   - unCat：未命中任何分类的卡数（rarity 漂移监测；>0 时 CI 打警告，卡仍计入「全市场」）
// 口径（docs/37 §3，用户已确认）：
//   · 分类成员 = 当前有报价卡（built.view.tier），历史值按 eaId 取 daily 对应列；
//   · 指数 = 分类「当日中位价」序列（中位抗极值，Icon 高价不扭曲金卡档）；
//   · 平均涨跌 = 每卡 (今日avg−昨日avg)/昨日avg 的简单平均；|Δ|<0.5% 记持平、≥5% 记波动；
//   · 振幅 = 每卡 (窗口内 max−min)/窗口均值 的均值（需 ≥2 个有效日，ampN=参与卡数）；
//   · 高价档 = 当前价 ≥50万 / ≥100万 两组的简单平均涨跌 + 卡数（按平台各自取价）。
// 纯函数（无 IO），scripts/market_overview_test.js 离线覆盖。
var OVERVIEW_CATS = [
  { key: 'gold_80_84', label: '金卡 80-84', rarity: 'Gold', min: 80, max: 84 },
  { key: 'gold_85_92', label: '金卡 85-92', rarity: 'Gold', min: 85, max: 92 },
  { key: 'icon', label: '基础传奇', rarity: 'Base Icon', min: 0, max: 999 },
  { key: 'hero', label: '基础英雄', rarity: 'Base Hero', min: 0, max: 999 },
  { key: 'promo_80_84', label: '活动卡 80-84', promo: true, min: 80, max: 84 },
  { key: 'promo_85_89', label: '活动卡 85-89', promo: true, min: 85, max: 89 },
  { key: 'promo_90p', label: '活动卡 90+', promo: true, min: 90, max: 999 },
  { key: 'totw_80_84', label: '周黑 80-84', rarity: 'Team of the week', min: 80, max: 84 },
  { key: 'totw_85p', label: '周黑 85+', rarity: 'Team of the week', min: 85, max: 999 }
];
// 活动卡口径＝非金/非基础传奇/非基础英雄/非周黑的全部 promo 稀有度（含活动英雄，如 Ultimate Scream Hero）
var OVERVIEW_BASE_RARITIES = ['Gold', 'Base Icon', 'Base Hero', 'Team of the week'];
var OVERVIEW_TIERS = [
  { key: '500k', min: 500000 },
  { key: '1m', min: 1000000 }
];
var OVERVIEW_HOLD_PCT = 0.5;   // |Δ|<0.5% 记持平
var OVERVIEW_VOL_PCT = 5;      // |Δ|≥5% 记波动

// 单卡分类（切法 B：区间下限含、上限不含——85 归中档、90 归 90+，9 档无缝分区）
function overviewCatOf(item) {
  var r = item.rarity || '';
  var ov = item.overall || 0;
  for (var i = 0; i < OVERVIEW_CATS.length; i++) {
    var c = OVERVIEW_CATS[i];
    if (ov < c.min || ov > c.max) continue;
    if (c.promo) {
      if (!r || OVERVIEW_BASE_RARITIES.indexOf(r) >= 0) continue;   // 基础稀有度不落活动卡
      return c.key;
    }
    if (r === c.rarity) return c.key;
  }
  return '';
}

function overviewMedian(arr) {
  if (!arr.length) return null;
  var s = arr.slice().sort(function (a, b) { return a - b; });
  var m = s.length >> 1;
  var v = (s.length % 2) ? s[m] : (s[m - 1] + s[m]) / 2;
  return Math.round(v);
}

function buildOverview(daily, built, dayKey) {
  var tier = (built && built.view && built.view.tier) || [];
  var days = (daily && Array.isArray(daily.days)) ? daily.days.slice() : [];
  var dPlayers = (daily && daily.players) || {};
  var N = days.length;
  // 今日格：优先按 dayKey 定位（updateDaily 保证其为末位）；定位不到 ⇒ 无当日对比数据
  var todayIdx = dayKey ? days.lastIndexOf(dayKey) : N - 1;
  var yestIdx = todayIdx - 1;

  // 1) 分类成员（当前有报价卡；卡数平台无关，pc/ps 视图共用）
  var members = {};
  var unCat = 0;
  tier.forEach(function (it) {
    var k = overviewCatOf(it);
    if (!k) { unCat++; return; }
    if (!members[k]) members[k] = [];
    members[k].push(it);
  });

  // 2) 指数：每平台每分类「当日中位价」序列（与 days 按下标对齐，当日无值为 null）
  function indexOf(catItems, pf) {
    var out = [];
    for (var d = 0; d < N; d++) {
      var vals = [];
      catItems.forEach(function (it) {
        var rec = dPlayers[String(it.eaId)];
        var cell = rec && rec[pf] && rec[pf][d];
        if (cell && cell[0] != null) vals.push(cell[0]);
      });
      out.push(overviewMedian(vals));
    }
    return out;
  }
  var index = { pc: {}, ps: {} };
  index.pc.all = indexOf(tier, 'pc');
  index.ps.all = indexOf(tier, 'ps');
  OVERVIEW_CATS.forEach(function (c) {
    if (!members[c.key] || !members[c.key].length) return;   // 空分类不出指数（端上隐藏）
    index.pc[c.key] = indexOf(members[c.key], 'pc');
    index.ps[c.key] = indexOf(members[c.key], 'ps');
  });

  // 3) 当日统计（按平台）：涨跌需今日+昨日都有效且昨日>0；振幅需 ≥2 个有效日
  function statOf(catItems, pf) {
    var st = { cards: catItems.length, cmp: 0, up: 0, hold: 0, down: 0, vol5: 0, avgChg: null, amp: null, ampN: 0 };
    if (!N || todayIdx < 0) return st;
    var chgSum = 0, ampSum = 0;
    catItems.forEach(function (it) {
      var rec = dPlayers[String(it.eaId)];
      var arr = rec && rec[pf] ? rec[pf] : null;
      if (arr && yestIdx >= 0) {
        var y = arr[yestIdx], t = arr[todayIdx];
        if (y && t && y[0] > 0 && t[0] != null) {
          var pct = (t[0] - y[0]) / y[0] * 100;
          st.cmp++; chgSum += pct;
          if (pct >= OVERVIEW_HOLD_PCT) st.up++;
          else if (pct <= -OVERVIEW_HOLD_PCT) st.down++;
          else st.hold++;
          if (Math.abs(pct) >= OVERVIEW_VOL_PCT) st.vol5++;
        }
      }
      if (arr) {
        var vs = [];
        for (var d = 0; d < N; d++) { var cell = arr[d]; if (cell && cell[0] != null) vs.push(cell[0]); }
        if (vs.length >= 2) {
          var mn = vs[0], mx = vs[0], s = 0;
          for (var j = 0; j < vs.length; j++) { if (vs[j] < mn) mn = vs[j]; if (vs[j] > mx) mx = vs[j]; s += vs[j]; }
          var mean = s / vs.length;
          if (mean > 0) { ampSum += (mx - mn) / mean * 100; st.ampN++; }
        }
      }
    });
    if (st.cmp) st.avgChg = +(chgSum / st.cmp).toFixed(1);
    if (st.ampN) st.amp = +(ampSum / st.ampN).toFixed(1);
    return st;
  }

  // 4) 高价档：按平台当前价过滤后复用 statOf（只取 cards/chg）
  function tierStat(catItems, pf, minPrice) {
    var sel = catItems.filter(function (it) {
      var v = (pf === 'ps') ? it.ps : it.pc;
      return v != null && v >= minPrice;
    });
    var st = statOf(sel, pf);
    return { cards: st.cards, chg: st.avgChg };
  }

  var out = {
    v: 1, ts: Date.now(), days: days, unCat: unCat,
    cats: OVERVIEW_CATS.map(function (c) { return { key: c.key, label: c.label, cards: (members[c.key] || []).length }; }),
    index: index,
    today: {
      pc: { all: statOf(tier, 'pc'), cats: {}, tiers: {} },
      ps: { all: statOf(tier, 'ps'), cats: {}, tiers: {} }
    }
  };
  ['pc', 'ps'].forEach(function (pf) {
    OVERVIEW_CATS.forEach(function (c) {
      if (members[c.key] && members[c.key].length) out.today[pf].cats[c.key] = statOf(members[c.key], pf);
    });
    OVERVIEW_TIERS.forEach(function (t) {
      out.today[pf].tiers[t.key] = tierStat(tier, pf, t.min);
    });
  });
  return out;
}

module.exports = {
  PRICE_API: PRICE_API, BATCH: BATCH, TIER_MIN: TIER_MIN, DAILY_KEEP_DAYS: DAILY_KEEP_DAYS,
  key: key, sleep: sleep, cardCloudId: cardCloudId,
  fetchBatch: fetchBatch, pullPlatforms: pullPlatforms,   build: build,
  buildSeries: buildSeries, slimSnapshot: slimSnapshot,
  computeUnder80Alerts: computeUnder80Alerts, updateDaily: updateDaily,
  buildOverview: buildOverview, OVERVIEW_CATS: OVERVIEW_CATS, OVERVIEW_TIERS: OVERVIEW_TIERS
};
