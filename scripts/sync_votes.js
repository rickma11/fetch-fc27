// 社区投票同步脚本：独立每周跑一次（不进 fetch-fc27 主管线、不碰 players_fc27 集合）。
//
// 职责（与 sync_live_hub.js 同源思路，但数据不同）：
//   ① 过 Cloudflare 拉 fut.gg 全量球员列表（/api/fut/players/v2/{ver}/?page=N），
//      建 eaId → fut.gg id 映射（⚠️ 投票接口用 fut.gg 内部 id，不是 eaId 也不是 basePlayerEaId）。
//   ② 逐唯一 fut.gg id 拉 /api/voting/{ver}/{id}/ 取 fut.gg 原生 up/down/total/score。
//   ③ 读云库 votes_user_fc{ver}（端上直写的用户投票，doc._id = baseId:anonId，data.action=up/down/null）
//      按 basePlayerEaId 聚合成 miniapp 累计。
//   ④ 合并规则：futgg.total > miniapp.total → 展示 = futgg（"刷新"）；否则展示 = miniapp（"不变"）。
//      miniapp 原始票保留在云库，允许日后反超；展示值写进静态 JSON，端上只读。
//   ⑤ 上传云存储（公有读，零云函数配额）：
//        fc{ver}/data/vote_meta/vote_meta.json        { updatedAt, map:{eaId:futggId}, baseMap:{eaId:basePlayerEaId} }
//        fc{ver}/data/votes/<bucket>.json             { updatedAt, byId:{futggId:{up,down,total,score}} }
//        bucket = floor(futggId/1000)，每片仅几十~几百球员，端上按需取一片。
//
// 端上（eafc-miniapp/utils/vote.js）读这些静态 JSON；用户点赞点踩直写 votes_user_fc{ver}（非云函数）。
// ⚠️ 云库 votes_user_fc{ver} 安全规则需放「所有用户可读、所有用户可写」（端上匿名直写）。
//
// 用法：node scripts/sync_votes.js [ver]            （ver 默认 27；可加 --no-upload 仅本地验证不写云）
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
const HARD_TIMEOUT_MS = Number(process.env.VOTE_TIMEOUT_MS || 170 * 60 * 1000);
const VOTE_BATCH = Number(process.env.VOTE_BATCH || 32);           // 每批并发 fetch 的 fut.gg id 数

function jget(t) { try { return JSON.parse(t); } catch (e) { return null; } }
function sleep(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }

// —— 云初始化（仅上传/读库时）——
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

// 过 Cloudflare：先进 /fc/players/?page=1 等网络稳定，再在 page.evaluate 内 fetch 列表 API 直到 200。
// 关键：Playwright Node 侧 page.request.get 携带的 cookie 与浏览器内 fetch 不同；
// #12 之前用 request.get 在本环境被 CF 403，而 page.evaluate 内 fetch 能 200。
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
//   同时保留 baseMap: eaId → basePlayerEaId（端上云库存储/聚合用）。
//   移植自 fetch_ci.js 阶段1（2026-09-17 实测修法）：朴素 ?page=N 翻页到第 ~334 页被服务端截断只拿 ~1万，
//   分桶后全量 ≈19797~21000（云库 players_fc27 实证）。fut.gg 对超出末页的 page 不返回空数组而是重复末页，
//   故「空页即桶末」不成立，改判「连续 2 页都没有新增」才结束；并加 count<19000 安全闸阻断残缺落库。
async function buildMapping(page) {
  const result = await page.evaluate(async ({ BASE, VER, OVR_MIN }) => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const r1 = await fetch(`${BASE}/players/v2/${VER}/?page=1`, { headers: { Accept: 'application/json' } });
    if (!r1.ok) throw new Error('列表第 1 页失败 status=' + r1.status);
    const j1 = await r1.json();
    const first = Array.isArray(j1.data) ? j1.data : [];

    const map = {};            // eaId -> fut.gg id（投票真源 key）
    const baseMap = {};        // eaId -> basePlayerEaId（端上云库聚合 key）
    const seen = new Set();    // 已见 eaId（跨桶去重）
    const push = arr => {
      let added = 0;
      for (const pl of arr) {
        const ea = pl.eaId != null ? Number(pl.eaId) : null;
        if (!ea || seen.has(ea)) continue;
        seen.add(ea);
        const fgId = pl.id != null ? Number(pl.id) : ea;   // 投票接口用 fut.gg 内部 id
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
    // 单桶翻页：overall__gte/lte 同值。每桶命中远小于 10000，桶内翻页不触窗口。
    async function fetchBucket(ovr) {
      let dup = 0;
      for (let pg = 1; pg <= 2000; pg++) {
        let added = -1;        // -1 = 本页请求未成功
        for (let attempt = 0; attempt < 3 && added < 0; attempt++) {
          try {
            const r = await fetch(`${BASE}/players/v2/${VER}/?overall__gte=${ovr}&overall__lte=${ovr}&page=${pg}`, { headers: { Accept: 'application/json' } });
            if (r.ok) {
              const j = await r.json();
              if (Array.isArray(j.data) && j.data.length) added = push(j.data);
              else return;     // 真空页 = 桶末
            } else if (r.status === 404) { return; }
            else { await sleep(400 * Math.pow(2, attempt)); }   // 指数退避 400/800/1600ms
          } catch (e) { await sleep(400 * Math.pow(2, attempt)); }
        }
        if (added < 0) { if (pg === 1) failedOvr.push(ovr); return; }
        if (added === 0) { if (++dup >= 2) return; } else dup = 0;  // 连续 2 页全为已见 → 桶末（越界页重复末页）
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
    // 限流兜底：首页失败的桶（多为中段 OVR）用更长退避整体重试一次，尽量不丢球员
    if (failedOvr.length) {
      console.log('⚠️ 首页失败桶 ' + failedOvr.length + ' 个（OVR: ' + failedOvr.join(',') + '），退避 3s 后重试…');
      for (const ovr of failedOvr) { await sleep(3000); await fetchBucket(ovr); }
    }
    console.log('  分桶翻页完成：OVR ' + OVR_MAX + '→' + OVR_MIN + ' 共 ' + bucketCount + ' 桶' + (failedOvr.length ? '（已重试 ' + failedOvr.length + ' 个失败桶）' : ''));
    return { map: map, baseMap: baseMap, count: seen.size };
  }, { BASE: 'https://www.fut.gg/api/fut', VER: VER, OVR_MIN: 1 });

  console.log('  映射完成：', result.count, '名球员（eaId → fut.gg id）');
  // 安全闸：全量约 19797~21000，若中段 OVR 桶被限流/遗漏导致偏少，阻断避免 vote_meta 残缺落库。
  if (result.count < 19000) {
    throw new Error('列表抓取异常偏少（' + result.count + ' 人，预期 ~20000）——疑似中段 OVR 桶被限流/遗漏，已阻断以免 vote_meta 残缺');
  }
  return { map: result.map, baseMap: result.baseMap };
}

// ③ 读云库 votes_user_fc{ver} → 按 baseId 聚合 miniapp 票数
async function loadMiniapp(app) {
  const mini = {};   // baseId -> {up, down, total}
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
// 关键：必须用已通过 Cloudflare 的同一个主 page，才能保证浏览器侧 fetch 携带有效 CF cookie。
// #9 的教训：worker 新 page 未过 CF → page.evaluate 内 fetch 投票 API 100% 失败。
// 修法：不再开 worker page，直接在主 page 的 evaluate 里分 BATCH 并发 fetch，
// 既避免 Playwright Node 侧 page.request.get 的往返开销，又继承 CF 会话。
async function fetchVoting(page, ids) {
  const futgg = {};   // fut.gg id -> {up, down, total, score}
  let cursor = 0;
  let done = 0;
  let failed = 0;
  const total = ids.length;
  const BATCH = VOTE_BATCH;

  while (cursor < total) {
    const batch = [];
    while (batch.length < BATCH && cursor < total) batch.push(ids[cursor++]);
    if (!batch.length) break;

    let results = null;
    let attempts = 0;
    let lastErr = '';
    while (!results && attempts < 3) {
      try {
        results = await page.evaluate(async ({ batch, VOTE_BASE, VER }) => {
          const sleep = ms => new Promise(r => setTimeout(r, ms));
          const fetchOne = async (id, attempt) => {
            const url = `${VOTE_BASE}/voting/${VER}/${id}/`;
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 20000);
            try {
              const r = await fetch(url, {
                headers: { Accept: 'application/json' },
                signal: controller.signal
              });
              clearTimeout(timer);
              if (r.ok) {
                const text = await r.text();
                return { id, ok: true, text };
              }
              return { id, ok: false, status: r.status };
            } catch (e) {
              clearTimeout(timer);
              if (attempt < 2) {
                await sleep(400 * (attempt + 1));
                return fetchOne(id, attempt + 1);
              }
              return { id, ok: false, err: String(e && e.message || e) };
            }
          };
          return await Promise.all(batch.map(id => fetchOne(id, 0)));
        }, { batch, VOTE_BASE, VER });
      } catch (e) {
        attempts++;
        lastErr = e && e.message ? e.message : String(e);
        if (attempts >= 3) {
          console.log('  投票批次失败（整批', batch.length, '个）', lastErr);
          break;
        }
        await sleep(500 * attempts);
      }
    }

    if (!results) {
      failed += batch.length;
      done += batch.length;
    } else {
      for (const r of results) {
        done++;
        if (r.ok && r.text) {
          const j = jget(r.text);
          const d = j && j.data;
          if (d) {
            futgg[r.id] = {
              up: Number(d.upvotes) || 0,
              down: Number(d.downvotes) || 0,
              total: Number(d.totalVotes) || 0,
              score: Number(d.score) || 0
            };
          } else {
            failed++;
          }
        } else {
          if (r.status === 404) {
            // fut.gg 对该球员无投票记录：视为 0/0，不算失败
            futgg[r.id] = { up: 0, down: 0, total: 0, score: 0 };
          } else {
            failed++;
            if (done <= 10 || done % 1000 === 0) {
              console.log('  投票失败 id', r.id, r.status || r.err || '');
            }
          }
        }
      }
    }
    if (done % 500 === 0 || done === total) console.log('  投票进度', done, '/', total, '失败', failed);
    // 批次间短暂呼吸，避免触发 rate limit
    if (cursor < total) await sleep(120);
  }

  console.log('  投票抓取：', Object.keys(futgg).length, '个 fut.gg id 有响应（批大小', BATCH, '失败', failed, '）');
  return futgg;
}

// ④ 合并 + ⑤ 分桶组装
function buildBuckets(map, baseMap, futgg, mini) {
  const buckets = {};   // bucket -> {byId:{futggId:{up,down,total,score}}}
  for (const eaIdStr of Object.keys(map)) {
    const eaId = Number(eaIdStr);
    const fgId = map[eaId];
    const baseId = baseMap[eaId] != null ? baseMap[eaId] : eaId;
    const f = futgg[fgId] || { up: 0, down: 0, total: 0, score: 0 };
    const m = mini[baseId] || { up: 0, down: 0, total: 0 };
    // 合并规则：futgg.total > miniapp.total → 展示 futgg；否则展示 miniapp
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

  const passed = await passCF(page);
  if (!passed) { await browser.close(); console.error('CF 未通过'); process.exit(2); }

  console.log('\n① 建映射...');
  const { map, baseMap } = await buildMapping(page);
  const ids = [...new Set(Object.values(map))];
  console.log('  唯一 fut.gg id：', ids.length);

  console.log('\n② 拉 fut.gg 投票（主 page 批量并发，批大小', VOTE_BATCH, '）...');
  const futgg = await fetchVoting(page, ids);

  await browser.close();

  let mini = {};
  let app = null;
  if (!NO_UPLOAD) {
    try { app = initCloud(); } catch (e) { console.error('云初始化失败：', e.message); process.exit(3); }
    console.log('\n③ 读 miniapp 投票...');
    mini = await loadMiniapp(app);
  } else {
    console.log('\n③ --no-upload：跳过云库读取与上传');
  }

  console.log('\n④ 合并 + 分桶...');
  const buckets = buildBuckets(map, baseMap, futgg, mini);
  const meta = { updatedAt: new Date().toISOString(), ver: VER, count: Object.keys(map).length, buckets: Object.keys(buckets).length };
  const metaJson = { updatedAt: meta.updatedAt, map: map, baseMap: baseMap };

  // 本地落盘（调试/审计）
  fs.writeFileSync(path.join(OUT_DIR, 'vote_meta.json'), JSON.stringify(metaJson));
  for (const b of Object.keys(buckets)) {
    fs.writeFileSync(path.join(OUT_DIR, b + '.json'), JSON.stringify({ updatedAt: meta.updatedAt, byId: buckets[b].byId }));
  }

  if (NO_UPLOAD) {
    console.log('\n[--no-upload] 完成（未上传）。meta:', JSON.stringify(meta));
    clearTimeout(watchdog); process.exit(0);
  }

  console.log('\n⑤ 上传云存储...');
  await uploadJson(app, CLOUD_DIR + 'vote_meta/vote_meta.json', metaJson);
  for (const b of Object.keys(buckets)) {
    await uploadJson(app, CLOUD_DIR + 'votes/' + b + '.json', { updatedAt: meta.updatedAt, byId: buckets[b].byId });
  }
  // 写元文档（端上可选读；当前端上直接读 vote_meta.json 分片，元文档仅作版本标记）
  try {
    const db = app.database();
    // 顶层另加北京时间直读字段（控制台用）。注：body 的 `data` 包裹是历史遗留结构（端的只读
    // vote_meta.json，不读本元文档），此处不改结构，只在顶层补可读时间。
    const vTs = Date.now();
    await db.collection(META_COL).doc('votes').set({
      data: { updatedAt: meta.updatedAt, count: meta.count, buckets: meta.buckets, ts: vTs },
      updatedAtCn: cn(meta.updatedAt), tsCn: cn(vTs)
    });
  } catch (e) { console.log('  元文档写入跳过：', e.message); }

  console.log('\n===== 完成 =====');
  console.log('  映射球员', meta.count, '| 分桶', meta.buckets, '| updatedAt', meta.updatedAt);
  clearTimeout(watchdog);
  process.exit(0);
})().catch(function (e) { console.error('ERR', e); process.exit(1); });
