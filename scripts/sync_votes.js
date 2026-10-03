// 社区投票 + 化学推荐同步脚本（FC27）。
//
// 职责：
//   ① 过 Cloudflare 拉 fut.gg 全量球员列表（/api/fut/players/v2/{ver}/?page=N），
//      建 eaId → fut.gg id 映射（投票/化学接口都用 fut.gg 内部 id，不是 eaId 也不是 basePlayerEaId）。
//   ② 化学推荐：逐 fut.gg id 拉 /api/fut/players/{ver}/{id}/chemistry-style/ 取 top3 风格 + 总票数。
//   ③ 社区投票：逐 fut.gg id 拉 /api/voting/{ver}/{id}/ 取 fut.gg 原生 up/down/total/score；
//      读云库 votes_user_fc{ver} 聚合小程序用户票；合并（futgg.total>miniapp.total 则刷新，否则不变）。
//
// 调度（北京时间）：每天由 cron-job.org 触发一次，mode 决定抓什么：
//   - mode=auto（默认）：周日 → full（化学+投票）；其余 → 仅化学（chem）。
//   - mode=chem：仅化学；mode=full：化学+投票。
// 映射缓存（省时长）：非 full 运行复用已发布的 chem_meta.json 里的 map（跳过 ① 的 2 万次翻页），
//   只在 full（周日）重建映射并重新发布。化学抓取本身仍需过 CF 的浏览器会话，无法跳过。
//
// 上传云存储（公有读，零云函数配额）：
//   化学： fc{ver}/data/chem_meta/chem_meta.json   { updatedAt, map, baseMap, count }
//         fc{ver}/data/chem/<bucket>.json          { updatedAt, byId:{futggId:{total, top3:[[apiId,pct],...]}} }
//   投票： fc{ver}/data/vote_meta/vote_meta.json   { updatedAt, map, baseMap }
//         fc{ver}/data/votes/<bucket>.json         { updatedAt, byId:{futggId:{up,down,total,score}} }
//   bucket = floor(futggId/1000)。
//
// 端上：utils/chemRecommend.js 只读 chem 静态 JSON（不投票）；utils/vote.js 读 votes 静态 JSON + 直写云库投票。
//
// 用法：node scripts/sync_votes.js [ver] [--chem|--full|--no-upload]   （ver 默认 27）
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const cloudbase = require('@cloudbase/node-sdk');
const { cn } = require('./cn_time');   // 北京时间直读字段（控制台用）

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'probe', 'votes');
fs.mkdirSync(OUT_DIR, { recursive: true });

const UA = process.env.CF_UA || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36';
const VER = Number(process.argv[2] || process.env.FC_VER || 27);
const NO_UPLOAD = process.argv.indexOf('--no-upload') >= 0;
const BASE = 'https://www.fut.gg/api/fut';
const VOTE_BASE = 'https://www.fut.gg/api';   // 投票 API 路径不带 /fut：/api/voting/{ver}/{id}/
const SITE = 'https://www.fut.gg';
const CLOUD_DIR = 'fc' + VER + '/data/';
const META_COL = 'meta_fc' + VER;
const VOTE_USER_COL = 'votes_user_fc' + VER;
const HARD_TIMEOUT_MS = Number(process.env.VOTE_TIMEOUT_MS || 220 * 60 * 1000);
const VOTE_BATCH = Number(process.env.VOTE_BATCH || 32);           // 每批并发 fetch 的 fut.gg id 数
const CHEM_META_URL = 'https://636c-cloud1-d5gq6q3np8708aeef-1475854307.tcb.qcloud.la/fc' + VER + '/data/chem_meta/chem_meta.json';

function jget(t) { try { return JSON.parse(t); } catch (e) { return null; } }
function sleep(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }

// —— 运行模式判定 ——
// auto：周日 full（化学+投票），其余仅化学；--chem / --full / SYNC_MODE 可强制。
function resolveMode() {
  if (process.argv.indexOf('--full') >= 0) return 'full';
  if (process.argv.indexOf('--chem') >= 0) return 'chem';
  const m = (process.env.SYNC_MODE || 'auto').toLowerCase();
  if (m === 'full' || m === 'chem') return m;
  return 'auto';
}
function isSundayBJ() {
  // 北京时间星期几：UTC 时间 +8h 后取 getUTCDay()（0=周日）
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  return d.getUTCDay() === 0;
}
const MODE = resolveMode();
const RUN_CHEM = true;                                   // 化学推荐每天抓
const RUN_VOTES = (MODE === 'full') || (MODE === 'auto' && isSundayBJ());
const REBUILD_MAP = (MODE === 'full') || (MODE === 'auto' && isSundayBJ()); // 仅 full（周日）重建映射
console.log('[mode] MODE=' + MODE + ' RUN_CHEM=' + RUN_CHEM + ' RUN_VOTES=' + RUN_VOTES + ' REBUILD_MAP=' + REBUILD_MAP + ' (周日BJ=' + isSundayBJ() + ')');

// —— 云初始化（仅上传时）——
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
  return cloudbase.init({ env: envId, secretId: sid, secretKey: skey });
}

async function apiGet(page, url, tries) {
  tries = tries || 3;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await page.request.get(url, { headers: { Accept: 'application/json' }, timeout: 20000 });
      if (r.status() === 200) return await r.text();
    } catch (e) { console.log('  api err', e.message); }
    await page.waitForTimeout(1500);
  }
  return null;
}

// 复用已发布的 chem_meta.json 里的 map（跨天缓存，跳过 2 万次翻页）。仅 full 运行才忽略缓存重建。
async function getCachedMap() {
  if (REBUILD_MAP) return null;
  try {
    const r = await fetch(CHEM_META_URL + '?_rcb=' + Date.now(), { headers: { Accept: 'application/json' } });
    if (r.ok) {
      const j = await r.json();
      if (j && j.map && Object.keys(j.map).length > 19000) {
        console.log('  复用已发布 chem_meta 映射：', Object.keys(j.map).length, '名球员（跳过浏览器翻页）');
        return { map: j.map, baseMap: j.baseMap || {} };
      }
    }
  } catch (e) { console.log('  读缓存映射失败（将重建）：', e.message); }
  return null;
}

// 过 Cloudflare：先进 /fc/players/?page=1 等网络稳定，再在 page.evaluate 内 fetch 列表 API 直到 200。
async function passCF(page) {
  try {
    console.log('  passCF goto /fc/players/?page=1 ...');
    await page.goto(SITE + '/fc/players/?page=1', { waitUntil: 'networkidle', timeout: 60000 });
    console.log('  passCF goto ok');
  } catch (e) {
    console.log('  passCF goto networkidle 超时，回退首页：', e.message);
    try { await page.goto(SITE + '/', { waitUntil: 'domcontentloaded', timeout: 60000 }); } catch (e2) {}
  }
  for (let i = 0; i < 40; i++) {
    try {
      const ok = await page.evaluate(async (url) => {
        try {
          const r = await fetch(url, { headers: { Accept: 'application/json' } });
          return r.status === 200;
        } catch (e) { return false; }
      }, `${BASE}/players/v2/${VER}/?page=1`);
      console.log('  passCF req', i + 1, 'ok', ok);
      if (ok) { console.log('CF 通过', i + 1); return true; }
    } catch (e) { console.log('  passCF req err', e.message); }
    await page.waitForTimeout(3000);
  }
  return false;
}

// ① 建 eaId → fut.gg id 映射（按 overall 分桶翻页，绕过 max_result_window=10000）
async function buildMapping(page) {
  const result = await page.evaluate(async ({ BASE, VER, OVR_MIN }) => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const r1 = await fetch(`${BASE}/players/v2/${VER}/?page=1`, { headers: { Accept: 'application/json' } });
    if (!r1.ok) throw new Error('列表第 1 页失败 status=' + r1.status);
    const j1 = await r1.json();
    const first = Array.isArray(j1.data) ? j1.data : [];

    const map = {};
    const baseMap = {};
    const seen = new Set();
    const push = arr => {
      let added = 0;
      for (const pl of arr) {
        const ea = pl.eaId != null ? Number(pl.eaId) : null;
        if (!ea || seen.has(ea)) continue;
        seen.add(ea);
        const fgId = pl.id != null ? Number(pl.id) : ea;
        const base = pl.basePlayerEaId != null ? Number(pl.basePlayerEaId) : ea;
        map[ea] = fgId;
        baseMap[ea] = base;
        added++;
      }
      return added;
    };
    push(first);

    const OVR_MAX = 99;
    const failedOvr = [];
    async function fetchBucket(ovr) {
      let dup = 0;
      for (let pg = 1; pg <= 2000; pg++) {
        let added = -1;
        for (let attempt = 0; attempt < 3 && added < 0; attempt++) {
          try {
            const r = await fetch(`${BASE}/players/v2/${VER}/?overall__gte=${ovr}&overall__lte=${ovr}&page=${pg}`, { headers: { Accept: 'application/json' } });
            if (r.ok) {
              const j = await r.json();
              if (Array.isArray(j.data) && j.data.length) added = push(j.data);
              else return;
            } else if (r.status === 404) { return; }
            else { await sleep(400 * Math.pow(2, attempt)); }
          } catch (e) { await sleep(400 * Math.pow(2, attempt)); }
        }
        if (added < 0) { if (pg === 1) failedOvr.push(ovr); return; }
        if (added === 0) { if (++dup >= 2) return; } else dup = 0;
        await sleep(60);
      }
    }
    let ovrCursor = OVR_MAX;
    async function w() {
      while (true) {
        const o = ovrCursor--;
        if (o < OVR_MIN) return;
        await fetchBucket(o);
      }
    }
    const LIST_CONC = 8;
    const bucketCount = OVR_MAX - OVR_MIN + 1;
    await Promise.all(Array.from({ length: Math.min(LIST_CONC, bucketCount) }, w));
    if (failedOvr.length) {
      console.log('⚠️ 首页失败桶 ' + failedOvr.length + ' 个（OVR: ' + failedOvr.join(',') + '），退避 3s 后重试…');
      for (const ovr of failedOvr) { await sleep(3000); await fetchBucket(ovr); }
    }
    console.log('  分桶翻页完成：OVR ' + OVR_MAX + '→' + OVR_MIN + ' 共 ' + bucketCount + ' 桶' + (failedOvr.length ? '（已重试 ' + failedOvr.length + ' 个失败桶）' : ''));
    return { map: map, baseMap: baseMap, count: seen.size };
  }, { BASE: 'https://www.fut.gg/api/fut', VER: VER, OVR_MIN: 1 });

  console.log('  映射完成：', result.count, '名球员（eaId → fut.gg id）');
  if (result.count < 19000) {
    throw new Error('列表抓取异常偏少（' + result.count + ' 人，预期 ~20000）——疑似中段 OVR 桶被限流/遗漏，已阻断以免 meta 残缺');
  }
  return { map: result.map, baseMap: result.baseMap };
}

// ③ 读云库 votes_user_fc{ver} → 按 baseId 聚合 miniapp 票数（仅投票用）
async function loadMiniapp(app) {
  const mini = {};
  try {
    const db = app.database();
    const col = db.collection(VOTE_USER_COL);
    let skip = 0;
    const PAGE = 100;
    while (true) {
      const res = await col.limit(PAGE).skip(skip).get();
      const docs = (res && res.data) || [];
      for (const d of docs) {
        const id = d._id || '';
        const baseId = Number(String(id).split(':')[0]);
        if (!baseId) continue;
        const act = d.action;
        if (act === 'up' || act === 'down') {
          if (!mini[baseId]) mini[baseId] = { up: 0, down: 0, total: 0 };
          mini[baseId][act]++; mini[baseId].total++;
        }
      }
      if (docs.length < PAGE) break;
      skip += PAGE;
    }
    console.log('  miniapp 票统计：', Object.keys(mini).length, '个球员有票');
  } catch (e) {
    console.log('  miniapp 读取失败（视为空）：', e.message);
  }
  return mini;
}

// ② 在主 page 上批量并发拉 fut.gg 投票（按 fut.gg 内部 id）
async function fetchVoting(page, ids) {
  const futgg = {};
  let cursor = 0, done = 0, failed = 0;
  const total = ids.length;
  const BATCH = VOTE_BATCH;

  while (cursor < total) {
    const batch = [];
    while (batch.length < BATCH && cursor < total) batch.push(ids[cursor++]);
    if (!batch.length) break;

    let results = null, attempts = 0, lastErr = '';
    while (!results && attempts < 3) {
      try {
        results = await page.evaluate(async ({ batch, VOTE_BASE, VER }) => {
          const sleep = ms => new Promise(r => setTimeout(r, ms));
          const fetchOne = async (id, attempt) => {
            const url = `${VOTE_BASE}/voting/${VER}/${id}/`;
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 20000);
            try {
              const r = await fetch(url, { headers: { Accept: 'application/json' }, signal: controller.signal });
              clearTimeout(timer);
              if (r.ok) { const text = await r.text(); return { id, ok: true, text }; }
              return { id, ok: false, status: r.status };
            } catch (e) {
              clearTimeout(timer);
              if (attempt < 2) { await sleep(400 * (attempt + 1)); return fetchOne(id, attempt + 1); }
              return { id, ok: false, err: String(e && e.message || e) };
            }
          };
          return await Promise.all(batch.map(id => fetchOne(id, 0)));
        }, { batch, VOTE_BASE, VER });
      } catch (e) {
        attempts++;
        lastErr = e && e.message ? e.message : String(e);
        if (attempts >= 3) { console.log('  投票批次失败（整批', batch.length, '个）', lastErr); break; }
        await sleep(500 * attempts);
      }
    }

    if (!results) { failed += batch.length; done += batch.length; }
    else {
      for (const r of results) {
        done++;
        if (r.ok && r.text) {
          const j = jget(r.text);
          const d = j && j.data;
          if (d) {
            futgg[r.id] = { up: Number(d.upvotes) || 0, down: Number(d.downvotes) || 0, total: Number(d.totalVotes) || 0, score: Number(d.score) || 0 };
          } else { failed++; }
        } else {
          if (r.status === 404) futgg[r.id] = { up: 0, down: 0, total: 0, score: 0 };
          else {
            failed++;
            if (done <= 10 || done % 1000 === 0) console.log('  投票失败 id', r.id, r.status || r.err || '');
          }
        }
      }
    }
    if (done % 500 === 0 || done === total) console.log('  投票进度', done, '/', total, '失败', failed);
    if (cursor < total) await sleep(120);
  }
  console.log('  投票抓取：', Object.keys(futgg).length, '个 fut.gg id 有响应（批大小', BATCH, '失败', failed, '）');
  return futgg;
}

// ②' 批量并发拉 fut.gg 化学推荐（按 fut.gg 内部 id）
// 端点：/api/fut/players/{ver}/{id}/chemistry-style/  →  data.chemistryVotes{apiId:count}, data.top3ChemistryStyles[[apiId,pct],...]
// 返回：futggId → { total, top3:[[apiId,pct],...] }（apiId 为 1-based，端上用 CHEM_STYLES[apiId-1] 取风格）
async function fetchChem(page, ids) {
  const chem = {};
  let cursor = 0, done = 0, failed = 0;
  const total = ids.length;
  const BATCH = VOTE_BATCH;

  while (cursor < total) {
    const batch = [];
    while (batch.length < BATCH && cursor < total) batch.push(ids[cursor++]);
    if (!batch.length) break;

    let results = null, attempts = 0, lastErr = '';
    while (!results && attempts < 3) {
      try {
        results = await page.evaluate(async ({ batch, BASE, VER }) => {
          const sleep = ms => new Promise(r => setTimeout(r, ms));
          const fetchOne = async (id, attempt) => {
            const url = `${BASE}/players/${VER}/${id}/chemistry-style/`;
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 20000);
            try {
              const r = await fetch(url, { headers: { Accept: 'application/json' }, signal: controller.signal });
              clearTimeout(timer);
              if (r.ok) { const text = await r.text(); return { id, ok: true, text }; }
              return { id, ok: false, status: r.status };
            } catch (e) {
              clearTimeout(timer);
              if (attempt < 2) { await sleep(400 * (attempt + 1)); return fetchOne(id, attempt + 1); }
              return { id, ok: false, err: String(e && e.message || e) };
            }
          };
          return await Promise.all(batch.map(id => fetchOne(id, 0)));
        }, { batch, BASE, VER });
      } catch (e) {
        attempts++;
        lastErr = e && e.message ? e.message : String(e);
        if (attempts >= 3) { console.log('  化学批次失败（整批', batch.length, '个）', lastErr); break; }
        await sleep(500 * attempts);
      }
    }

    if (!results) { failed += batch.length; done += batch.length; }
    else {
      for (const r of results) {
        done++;
        if (r.ok && r.text) {
          const j = jget(r.text);
          const d = j && j.data;
          if (d && d.chemistryVotes) {
            const cv = d.chemistryVotes;
            const entries = Object.keys(cv).map(k => [Number(k), Number(cv[k]) || 0]).filter(x => x[1] > 0);
            const totalVotes = entries.reduce((s, x) => s + x[1], 0);
            const top3 = entries.sort((a, b) => b[1] - a[1]).slice(0, 3)
              .map(([id, c]) => [id, totalVotes ? Math.round(c / totalVotes * 100) : 0]);
            chem[r.id] = { total: totalVotes, top3: top3 };
          } else { chem[r.id] = { total: 0, top3: [] }; }
        } else {
          if (r.status === 404) chem[r.id] = { total: 0, top3: [] };
          else {
            failed++;
            if (done <= 10 || done % 1000 === 0) console.log('  化学失败 id', r.id, r.status || r.err || '');
          }
        }
      }
    }
    if (done % 500 === 0 || done === total) console.log('  化学进度', done, '/', total, '失败', failed);
    if (cursor < total) await sleep(120);
  }
  console.log('  化学抓取：', Object.keys(chem).length, '个 fut.gg id 有响应（批大小', BATCH, '失败', failed, '）');
  return chem;
}

// ④ 化学分桶组装
function buildChemBuckets(map, chem) {
  const buckets = {};
  for (const eaIdStr of Object.keys(map)) {
    const fgId = map[eaIdStr];
    const c = chem[fgId];
    if (!c) continue;                       // 无数据不落库（端上隐藏）
    const bucket = Math.floor(fgId / 1000);
    if (!buckets[bucket]) buckets[bucket] = { byId: {} };
    buckets[bucket].byId[String(fgId)] = { total: c.total, top3: c.top3 };
  }
  return buckets;
}

// ④ 投票分桶组装（含 miniapp 合并）
function buildVoteBuckets(map, baseMap, futgg, mini) {
  const buckets = {};
  for (const eaIdStr of Object.keys(map)) {
    const eaId = Number(eaIdStr);
    const fgId = map[eaId];
    const baseId = baseMap[eaId] != null ? baseMap[eaId] : eaId;
    const f = futgg[fgId] || { up: 0, down: 0, total: 0, score: 0 };
    const m = mini[baseId] || { up: 0, down: 0, total: 0 };
    let disp;
    if (f.total > m.total) disp = { up: f.up, down: f.down, total: f.total };
    else disp = { up: m.up, down: m.down, total: m.total };
    const bucket = Math.floor(fgId / 1000);
    if (!buckets[bucket]) buckets[bucket] = { byId: {} };
    buckets[bucket].byId[String(fgId)] = { up: disp.up, down: disp.down, total: disp.total, score: f.score };
  }
  return buckets;
}

async function uploadJson(app, cloudPath, obj) {
  const jsonStr = JSON.stringify(obj);
  const up = await app.uploadFile({ cloudPath: cloudPath, fileContent: Buffer.from(jsonStr) });
  return up.fileID || up;
}

(async () => {
  const watchdog = setTimeout(function () { console.error('WATCHDOG TIMEOUT'); process.exit(5); }, HARD_TIMEOUT_MS);
  console.log('启动 Chromium（过 CF）...');
  const browser = await chromium.launch({ headless: true, args: ['--disable-blink-features=AutomatedControlled', '--no-sandbox', '--disable-dev-shm-usage'] });
  const ctx = await browser.newContext({ userAgent: UA });
  const page = await ctx.newPage();

  // 映射：full（周日）重建；其余复用已发布的 chem_meta.map
  let map, baseMap;
  const cached = REBUILD_MAP ? null : await getCachedMap();
  if (cached) {
    map = cached.map; baseMap = cached.baseMap;
  } else {
    const passed = await passCF(page);
    if (!passed) { await browser.close(); console.error('CF 未通过'); process.exit(2); }
    console.log('\n① 建映射...');
    const m = await buildMapping(page);
    map = m.map; baseMap = m.baseMap;
  }
  const ids = [...new Set(Object.values(map))];
  console.log('  唯一 fut.gg id：', ids.length);

  // 浏览器内抓取（化学 + 投票都依赖已通过 CF 的 page，必须在 close 前完成）
  let chem = {};
  if (RUN_CHEM) {
    // 化学需要过 CF 的会话：若走了缓存映射分支，这里补一次 passCF
    if (cached) {
      const passed = await passCF(page);
      if (!passed) { await browser.close(); console.error('CF 未通过（化学抓取）'); process.exit(2); }
    }
    console.log('\n② 拉 fut.gg 化学推荐（主 page 批量并发，批大小', VOTE_BATCH, '）...');
    chem = await fetchChem(page, ids);
  }
  let futgg = {};
  if (RUN_VOTES) {
    console.log('\n② 拉 fut.gg 投票（主 page 批量并发，批大小', VOTE_BATCH, '）...');
    futgg = await fetchVoting(page, ids);
  }

  await browser.close();

  let mini = {};
  let app = null;
  if (!NO_UPLOAD) {
    try { app = initCloud(); } catch (e) { console.error('云初始化失败：', e.message); process.exit(3); }
    if (RUN_VOTES) {
      console.log('\n③ 读 miniapp 投票...');
      mini = await loadMiniapp(app);
    } else {
      console.log('\n③ --no-votes（非周日）：跳过云库投票读取');
    }
  } else {
    console.log('\n③ --no-upload：跳过云库读取与上传');
  }

  const nowIso = new Date().toISOString();

  // —— 化学推荐：组装 + 上传 ——
  if (RUN_CHEM) {
    console.log('\n④ 化学：分桶 + 上传...');
    const chemBuckets = buildChemBuckets(map, chem);
    const chemMeta = { updatedAt: nowIso, ver: VER, count: Object.keys(map).length, buckets: Object.keys(chemBuckets).length, map: map, baseMap: baseMap };
    fs.writeFileSync(path.join(OUT_DIR, 'chem_meta.json'), JSON.stringify(chemMeta));
    for (const b of Object.keys(chemBuckets)) {
      fs.writeFileSync(path.join(OUT_DIR, 'chem_' + b + '.json'), JSON.stringify({ updatedAt: nowIso, byId: chemBuckets[b].byId }));
    }
    if (!NO_UPLOAD) {
      await uploadJson(app, CLOUD_DIR + 'chem_meta/chem_meta.json', chemMeta);
      for (const b of Object.keys(chemBuckets)) {
        await uploadJson(app, CLOUD_DIR + 'chem/' + b + '.json', { updatedAt: nowIso, byId: chemBuckets[b].byId });
      }
    }
    console.log('  化学：', Object.keys(chemBuckets).length, '桶，映射球员', chemMeta.count);
  }

  // —— 社区投票：组装 + 上传（仅 full/周日）——
  if (RUN_VOTES) {
    console.log('\n④ 投票：合并 + 分桶 + 上传...');
    const buckets = buildVoteBuckets(map, baseMap, futgg, mini);
    const meta = { updatedAt: nowIso, ver: VER, count: Object.keys(map).length, buckets: Object.keys(buckets).length };
    const metaJson = { updatedAt: meta.updatedAt, map: map, baseMap: baseMap };
    fs.writeFileSync(path.join(OUT_DIR, 'vote_meta.json'), JSON.stringify(metaJson));
    for (const b of Object.keys(buckets)) {
      fs.writeFileSync(path.join(OUT_DIR, b + '.json'), JSON.stringify({ updatedAt: meta.updatedAt, byId: buckets[b].byId }));
    }
    if (!NO_UPLOAD) {
      await uploadJson(app, CLOUD_DIR + 'vote_meta/vote_meta.json', metaJson);
      for (const b of Object.keys(buckets)) {
        await uploadJson(app, CLOUD_DIR + 'votes/' + b + '.json', { updatedAt: meta.updatedAt, byId: buckets[b].byId });
      }
      try {
        const db = app.database();
        const vTs = Date.now();
        await db.collection(META_COL).doc('votes').set({
          data: { updatedAt: meta.updatedAt, count: meta.count, buckets: meta.buckets, ts: vTs },
          updatedAtCn: cn(meta.updatedAt), tsCn: cn(vTs)
        });
      } catch (e) { console.log('  元文档写入跳过：', e.message); }
    }
    console.log('  投票：映射球员', meta.count, '| 分桶', meta.buckets);
  }

  console.log('\n===== 完成 =====');
  console.log('  MODE=' + MODE + ' RUN_CHEM=' + RUN_CHEM + ' RUN_VOTES=' + RUN_VOTES + ' updatedAt=' + nowIso);
  clearTimeout(watchdog);
  process.exit(0);
})().catch(function (e) { console.error('ERR', e); process.exit(1); });
