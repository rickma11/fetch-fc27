// 社区投票同步脚本：独立每周跑一次（不进 fetch-fc27 主管线、不碰 players_fc27 集合）。
//
// 职责（与 sync_live_hub.js 同源思路，但数据不同）：
//   ① 过 Cloudflare 拉 fut.gg 全量球员列表（/api/fut/players/v2/{ver}/?page=N，334 页），
//      建 eaId → basePlayerEaId 映射（投票接口用 basePlayerEaId，不是 item eaId）。
//   ② 逐唯一 basePlayerEaId 拉 /api/voting/{ver}/{baseId}/ 取 fut.gg 原生 up/down/total/score。
//   ③ 读云库 votes_user_fc{ver}（端上直写的用户投票，doc._id = baseId:anonId，data.action=up/down/null）
//      按 baseId 聚合成 miniapp 累计。
//   ④ 合并规则：futgg.total > miniapp.total → 展示 = futgg（"刷新"）；否则展示 = miniapp（"不变"）。
//      miniapp 原始票保留在云库，允许日后反超；展示值写进静态 JSON，端上只读。
//   ⑤ 上传云存储（公有读，零云函数配额）：
//        fc{ver}/data/vote_meta/vote_meta.json        { updatedAt, map:{eaId:baseId} }
//        fc{ver}/data/votes/<bucket>.json             { updatedAt, byBase:{baseId:{up,down,total,score}} }
//        bucket = floor(baseId/1000)，每片仅几十~几百球员，端上按需取一片。
//
// 端上（eafc-miniapp/utils/vote.js）读这些静态 JSON；用户点赞点踩直写 votes_user_fc{ver}（非云函数）。
// ⚠️ 云库 votes_user_fc{ver} 安全规则需放「所有用户可读、所有用户可写」（端上匿名直写）。
//
// 用法：node scripts/sync_votes.js [ver]            （ver 默认 27；可加 --no-upload 仅本地验证不写云）
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const cloudbase = require('@cloudbase/node-sdk');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'probe', 'votes');
fs.mkdirSync(OUT_DIR, { recursive: true });

const UA = process.env.CF_UA || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36';
const VER = Number(process.argv[2] || process.env.FC_VER || 27);
const NO_UPLOAD = process.argv.indexOf('--no-upload') >= 0;
const BASE = 'https://www.fut.gg/api/fut';
const SITE = 'https://www.fut.gg';
const CLOUD_DIR = 'fc' + VER + '/data/';
const META_COL = 'meta_fc' + VER;
const VOTE_USER_COL = 'votes_user_fc' + VER;
const HARD_TIMEOUT_MS = Number(process.env.VOTE_TIMEOUT_MS || 110 * 60 * 1000);

function jget(t) { try { return JSON.parse(t); } catch (e) { return null; } }

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

// 过 Cloudflare（同 probe_live_hub_players.js）：首页导航 + 轮询列表 API 直到 200
async function passCF(page) {
  await page.goto(SITE + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  for (let i = 0; i < 40; i++) {
    try {
      const r = await page.request.get(`${BASE}/players/v2/${VER}/?page=1`, { headers: { Accept: 'application/json' }, timeout: 20000 });
      if (r.status() === 200) { console.log('CF 通过', i + 1); return true; }
    } catch (e) {}
    await page.waitForTimeout(3000);
  }
  return false;
}

// ① 建 eaId → basePlayerEaId 映射（拉全量列表）
async function buildMapping(page) {
  const map = {};        // eaId -> baseId
  let pageNo = 1;
  while (true) {
    const body = await apiGet(page, `${BASE}/players/v2/${VER}/?page=${pageNo}`);
    if (!body) { console.log('  列表中断于 page', pageNo); break; }
    const j = jget(body);
    const arr = (j && Array.isArray(j.data)) ? j.data : [];
    if (!arr.length) break;
    for (const pl of arr) {
      const ea = pl.eaId != null ? Number(pl.eaId) : null;
      if (!ea) continue;
      const base = pl.basePlayerEaId != null ? Number(pl.basePlayerEaId) : ea;
      map[ea] = base;
    }
    if (arr.length < 30) break;   // 末页
    pageNo++;
    if (pageNo > 400) break;
    if (pageNo % 50 === 0) console.log('  映射进度 page', pageNo, '已收录', Object.keys(map).length);
  }
  console.log('  映射完成：', Object.keys(map).length, '名球员');
  return map;
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

// ② 逐唯一 baseId 拉投票（去重，同 baseId 只拉一次）
async function fetchVoting(page, baseIds) {
  const futgg = {};   // baseId -> {up, down, total, score}
  let done = 0;
  for (const baseId of baseIds) {
    const body = await apiGet(page, `${BASE}/voting/${VER}/${baseId}/`);
    if (body) {
      const j = jget(body);
      const d = j && j.data;
      if (d) {
        const up = Number(d.upvotes) || 0;
        const down = Number(d.downvotes) || 0;
        const total = Number(d.totalVotes) || 0;
        const score = Number(d.score) || 0;
        futgg[baseId] = { up: up, down: down, total: total, score: score };
      }
    }
    done++;
    if (done % 200 === 0) console.log('  投票进度', done, '/', baseIds.length);
  }
  console.log('  投票抓取：', Object.keys(futgg).length, '个 baseId 有响应');
  return futgg;
}

// ④ 合并 + ⑤ 分桶组装
function buildBuckets(map, futgg, mini) {
  const buckets = {};   // bucket -> {byBase:{baseId:{up,down,total,score}}}
  for (const eaIdStr of Object.keys(map)) {
    const eaId = Number(eaIdStr);
    const baseId = map[eaId];
    const f = futgg[baseId] || { up: 0, down: 0, total: 0, score: 0 };
    const m = mini[baseId] || { up: 0, down: 0, total: 0 };
    // 合并规则：futgg.total > miniapp.total → 展示 futgg；否则展示 miniapp
    let disp;
    if (f.total > m.total) disp = { up: f.up, down: f.down, total: f.total };
    else disp = { up: m.up, down: m.down, total: m.total };
    const bucket = Math.floor(baseId / 1000);
    if (!buckets[bucket]) buckets[bucket] = { byBase: {} };
    buckets[bucket].byBase[String(baseId)] = { up: disp.up, down: disp.down, total: disp.total, score: f.score };
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
  const ctx = await browser.newContext({ userAgent: UA, locale: 'en-US', viewport: { width: 1280, height: 900 }, timezoneId: 'America/New_York' });
  const page = await ctx.newPage();

  const passed = await passCF(page);
  if (!passed) { await browser.close(); console.error('CF 未通过'); process.exit(2); }

  console.log('\n① 建映射...');
  const map = await buildMapping(page);
  const baseIds = [...new Set(Object.values(map))];
  console.log('  唯一 baseId：', baseIds.length);

  console.log('\n② 拉 fut.gg 投票...');
  const futgg = await fetchVoting(page, baseIds);

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
  const buckets = buildBuckets(map, futgg, mini);
  const meta = { updatedAt: new Date().toISOString(), ver: VER, count: Object.keys(map).length, buckets: Object.keys(buckets).length };
  const metaJson = { updatedAt: meta.updatedAt, map: map };

  // 本地落盘（调试/审计）
  fs.writeFileSync(path.join(OUT_DIR, 'vote_meta.json'), JSON.stringify(metaJson));
  for (const b of Object.keys(buckets)) {
    fs.writeFileSync(path.join(OUT_DIR, b + '.json'), JSON.stringify({ updatedAt: meta.updatedAt, byBase: buckets[b].byBase }));
  }

  if (NO_UPLOAD) {
    console.log('\n[--no-upload] 完成（未上传）。meta:', JSON.stringify(meta));
    clearTimeout(watchdog); process.exit(0);
  }

  console.log('\n⑤ 上传云存储...');
  await uploadJson(app, CLOUD_DIR + 'vote_meta/vote_meta.json', metaJson);
  for (const b of Object.keys(buckets)) {
    await uploadJson(app, CLOUD_DIR + 'votes/' + b + '.json', { updatedAt: meta.updatedAt, byBase: buckets[b].byBase });
  }
  // 写元文档（端上可选读；当前端上直接读 vote_meta.json 分片，元文档仅作版本标记）
  try {
    const db = app.database();
    await db.collection(META_COL).doc('votes').set({ data: { updatedAt: meta.updatedAt, count: meta.count, buckets: meta.buckets, ts: Date.now() } });
  } catch (e) { console.log('  元文档写入跳过：', e.message); }

  console.log('\n===== 完成 =====');
  console.log('  映射球员', meta.count, '| 分桶', meta.buckets, '| updatedAt', meta.updatedAt);
  clearTimeout(watchdog);
  process.exit(0);
})().catch(function (e) { console.error('ERR', e); process.exit(1); });
