// FC27 升级追踪（Live Hub）同步脚本：CI 真实 Chromium 过 Cloudflare，按活动抓全部被追踪卡的真实进度，
// 按基础 eaId 建索引组装精简 JSON，上传云存储 fc27/livehub/ 并写 meta_fc27/livehub 元文档。
//
// 真接口（R8-R10 探针实锤，已写入 utweb/参考/futgg/live_hub_api.md §十）：
//   GET /api/fut/live-hub/{ver}/campaigns/                    → 活动列表（FC27：21=OnesToWatch，22=DestinedForGlory）
//   GET /api/fut/live-hub/{ver}/players/?campaign_id={id}     → 该活动**全量**被追踪卡（含逐球员真实进度）
//   ⚠️ 参数名必须是 campaign_id（写 campaign 静默返 {"data":[]}）；slug 形式 404；无分页。
//   每条 item：playerItemEaId（顶层）/ card.eaId（card 内，二者等值）作主键；tracker.objectives[] 含
//   requirement(枚举) / value(阈值) / playerValue(已赢·逐球员真实进度) / maxGames / gamesPlayed(已赛·窗口内)
//   / isCompleted / isNotPossible / isRepeatable / upgrades[]。
//   FC27 实测：campaign 21→21 张，campaign 22→17 张（tid33 11 + tid34 6）⇒ **38 张 100% 覆盖**，tid34 复活。
//
// 设计要点：
//   - 过 CF 沿用 probe_live_hub.js 的 page.request 方案（Node 侧 fetch，共享 cf_clearance cookie）。
//   - 主键用 card.eaId（基础球员 eaId，与小程序 roster 主键同套），兜底 playerItemEaId（R11 验证二者等值）。
//   - 只产出「被追踪球员 + 各自真实进度」，不写球员主表、不碰 players_fc27 文档、不跑 warm_roster —— 与 fetch-fc27 管线隔离。
//   - 端上只读本脚本产出的静态 JSON（wx.cloud.downloadFile），不调 get_players 云函数，降低云函数/DB 调用。
//   - 每日由 GitHub Actions 调度一次（sync-live-hub.yml）；端上日级缓存，自然日内不二次刷新。
//
// 用法：node scripts/sync_live_hub.js [ver]            （ver 默认 27；可加 --no-upload 仅本地验证不写云）
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const cloudbase = require('@cloudbase/node-sdk');
const { cn } = require('./cn_time');   // 北京时间直读字段（控制台用）

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'probe', 'live_hub');
fs.mkdirSync(OUT_DIR, { recursive: true });

const UA = process.env.CF_UA || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36';
const VER = Number(process.argv[2] || process.env.FC_VER || 27);
const NO_UPLOAD = process.argv.indexOf('--no-upload') >= 0;
const CLOUD_DIR = 'fc27/livehub/';
const META_COLLECTION = 'meta_fc27';
const META_DOC = 'livehub';
const BASE = 'https://www.fut.gg/api/fut';

// —— 云存储 / 数据库 初始化（仅上传时）——
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
function shortFid(fid) { return fid ? String(fid).slice(0, 64) + (fid.length > 64 ? '…' : '') : ''; }

// 由 live-hub 原始球员数组 → 精简 JSON（按基础 eaId 建索引）。保留给单测 / 旧口径。
function buildPayload(players) {
  const byEaId = {};
  let keyed = 0, unkeyed = 0;
  for (const p of players) {
    const card = p.card || {};
    let eaId = card.eaId != null ? Number(card.eaId) : null;
    if (eaId == null && p.playerItemEaId != null) eaId = Number(p.playerItemEaId);
    if (!eaId) { unkeyed++; continue; }
    const tracker = p.tracker || {};
    const rawObjectives = (tracker && Array.isArray(tracker.objectives)) ? tracker.objectives
      : (Array.isArray(p.objectives) ? p.objectives : []);
    const objectives = rawObjectives.map(function (o) {
      const req = o.requirement || o.req || '';
      return {
        key: o.key || (req + ':' + (o.value == null ? '' : o.value)),
        label: o.label || '',
        requirement: req,
        value: (o.value == null ? null : Number(o.value)),
        playerValue: (o.playerValue == null ? 0 : Number(o.playerValue)),
        isCompleted: !!o.isCompleted,
        isNotPossible: !!o.isNotPossible,
        upgrades: Array.isArray(o.upgrades)
          ? o.upgrades.map(function (u2) { return { upgrade: u2.upgrade, label: u2.label || (u2.customUpgrade || '') }; })
          : []
      };
    });
    byEaId[String(eaId)] = {
      eaId: eaId,
      itemEaId: p.playerItemEaId != null ? Number(p.playerItemEaId) : null,
      trackerId: (p.trackerId != null) ? p.trackerId : null,
      campaignName: p.campaignName || '',
      competitionName: p.competitionName || '',
      clubName: p.clubName || '',
      nationName: p.nationName || '',
      startDate: (p.data && p.data.startDate) || '',
      objectives: objectives,
      hasProgress: true
    };
    keyed++;
  }
  return { byEaId: byEaId, keyed: keyed, unkeyed: unkeyed };
}

// 剥离 fut.gg label 末尾/中间的插值进度，如 "Win 3 of next 6 matches (2/6)" → "Win 3 of next 6 matches"。
// 模板复用场景专用：非精选球员不能继承精选球员的进度插值（否则人人显示 2/6，用户 2026-09-28 截图反馈）。
function stripLabelProgress(label) {
  return String(label == null ? '' : label)
    .replace(/\s*\(\s*\d+\s*\/\s*\d+\s*\)\s*$/, '')   // 尾部 "(2/6)"
    .replace(/\s*\(\s*\d+\s*\/\s*\d+\s*\)/g, '')      // 任意位置 "(2/6)"
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// 由「按活动抓回的全量被追踪卡」数组 → 精简 JSON（按基础 eaId 建索引，主键 card.eaId || playerItemEaId）。
// 真接口（R8-R10）：每条 item 已自带 tracker.objectives[] 真实进度（playerValue/maxGames/gamesPlayed），
// 无需再走 has_dynamic 枚举 + definition-data 反查、也无需同 trackerId 抽模板 —— 38 张 100% 覆盖、tid34 复活。
// 返回 { byEaId, keyed, unkeyed, skippedNoTemplate:0 }。
function buildFullPayload(allPlayers) {
  const byEaId = {};
  let keyed = 0, unkeyed = 0;
  for (const p of (allPlayers || [])) {
    const card = p.card || {};
    let ea = card.eaId != null ? Number(card.eaId) : null;
    if (ea == null && p.playerItemEaId != null) ea = Number(p.playerItemEaId); // R11 验证 card.eaId===playerItemEaId
    if (!ea) { unkeyed++; continue; }
    const tracker = p.tracker || {};
    const objectives = Array.isArray(tracker.objectives)
      ? tracker.objectives.map(function (o) {
          const req = o.requirement || o.req || '';
          const ups = Array.isArray(o.upgrades) ? o.upgrades : [];
          return {
            key: o.key || (req + ':' + (o.value == null ? '' : o.value)),
            label: o.label || '',
            requirement: req,
            value: (o.value == null ? null : Number(o.value)),
            playerValue: (o.playerValue == null ? null : Number(o.playerValue)), // null = 无逐球员真实进度（端上标「追踪中」）
            maxGames: (o.maxGames == null ? null : Number(o.maxGames)),          // 窗口总场次（如 6）
            gamesPlayed: (o.gamesPlayed == null ? null : Number(o.gamesPlayed)),// 窗口内已赛场次
            isCompleted: !!o.isCompleted,
            isNotPossible: !!o.isNotPossible,
            isRepeatable: !!o.isRepeatable,
            upgrades: ups.map(function (u2) { return { upgrade: u2.upgrade, label: u2.label || (u2.customUpgrade || '') }; })
          };
        })
      : [];
    const hasProgress = objectives.some(function (o) { return o.playerValue != null; });
    byEaId[String(ea)] = {
      eaId: ea,
      itemEaId: p.playerItemEaId != null ? Number(p.playerItemEaId) : null,
      trackerId: (p.trackerId != null) ? p.trackerId : null,
      campaignName: p.campaignName || '',
      competitionName: p.competitionName || '',
      clubName: p.clubName || '',
      nationName: p.nationName || '',
      startDate: (p.data && p.data.startDate) || '',
      objectives: objectives,
      hasProgress: hasProgress
    };
    keyed++;
  }
  return { byEaId: byEaId, keyed: keyed, unkeyed: unkeyed, skippedNoTemplate: 0 };
}

// —— 通用 API fetch（Node 侧，共享 cf_clearance）——
async function apiGet(page, url) {
  for (let a = 1; a <= 4; a++) {
    try {
      const r = await page.request.get(url, { headers: { Accept: 'application/json' }, timeout: 60000 });
      const t = await r.text();
      if (r.status() === 200 && (t.trim().startsWith('{') || t.trim().startsWith('['))) return t;
      console.log('  api 非预期', url.slice(0, 95), 'status', r.status(), 'preview', t.slice(0, 160));
    } catch (e) { console.log('  api err', e.message); }
    if (a < 4) await page.waitForTimeout(3000);
  }
  return null;
}
function jget(t) { try { return JSON.parse(t); } catch (e) { return null; } }

async function runSync() {
  console.log('启动 Chromium (headless) ...');
  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-blink-features=AutomatedControlled', '--no-sandbox', '--disable-dev-shm-usage']
  });
  const ctx = await browser.newContext({
    userAgent: UA, locale: 'en-US', viewport: { width: 1280, height: 800 }, timezoneId: 'America/New_York'
  });
  const page = await ctx.newPage();
  page.on('console', function (m) { const t = m.text(); if (/error|fail|denied|challenge|redirect/i.test(t)) console.log('[browser]', t); });

  console.log('打开 fut.gg 过 Cloudflare ...');
  await page.goto('https://www.fut.gg/', { waitUntil: 'domcontentloaded', timeout: 60000 });

  const LIGHT = `${BASE}/players/v2/${VER}/?page=1`;
  let passed = false;
  for (let i = 0; i < 40; i++) {
    let status = 0, ok = false;
    try {
      const r = await page.request.get(LIGHT, { headers: { Accept: 'application/json' }, timeout: 20000 });
      status = r.status();
      const t = await r.text();
      ok = t.trim().startsWith('{') || t.trim().startsWith('[');
    } catch (e) { status = -1; console.log(`  LIGHT 异常: ${e.message}`); }
    if (status === 200 && ok) { passed = true; console.log(`Cloudflare 已通过（第 ${i + 1} 次）`); break; }
    console.log(`等待 CF 解除... status=${status} ok=${ok} (${i + 1}/40)`);
    await page.waitForTimeout(3000);
  }
  if (!passed) { await browser.close(); console.error('未能过 Cloudflare'); process.exit(2); }

  // ① 活动清单（精简 JSON，无分页）
  console.log(`\n① 抓取 live-hub/${VER}/campaigns/ ...`);
  const rc = await apiGet(page, `${BASE}/live-hub/${VER}/campaigns/`);
  const jc = rc ? jget(rc) : null;
  const camps = (jc && Array.isArray(jc.data)) ? jc.data : [];
  console.log(`  活动 ${camps.length} 个: ` + camps.map(function (c) { return '#' + c.id + ' ' + (c.slug || ''); }).join(' | '));
  if (!camps.length) { await browser.close(); console.error('未拿到活动清单'); process.exit(3); }

  // ② 逐活动抓 players?campaign_id= 全量（含逐球员真实进度），合并为单一数组
  console.log('\n② 逐活动抓 players?campaign_id= ...');
  const allPlayers = [];
  for (const c of camps) {
    let t = null;
    for (let attempt = 1; attempt <= 4; attempt++) {
      const r = await apiGet(page, `${BASE}/live-hub/${VER}/players/?campaign_id=${c.id}`);
      if (r) { t = r; console.log(`  #${c.id} ${c.slug || ''} 第 ${attempt} 次成功 bytes=${r.length}`); break; }
      if (attempt < 4) await page.waitForTimeout(5000);
    }
    if (!t) { console.log(`  #${c.id} 失败，跳过`); continue; }
    const j = jget(t);
    const arr = (j && Array.isArray(j.data)) ? j.data : (Array.isArray(j) ? j : []);
    console.log(`  #${c.id} ${c.slug || ''} → ${arr.length} 条`);
    for (const it of arr) allPlayers.push(it);
  }
  if (!allPlayers.length) { await browser.close(); console.error('未抓到任何被追踪球员'); process.exit(3); }
  console.log(`  合计 ${allPlayers.length} 张被追踪卡（全量，100% 覆盖）`);

  // ③ 组装精简 JSON（按基础 eaId 建索引，主键 card.eaId || playerItemEaId）
  const built = buildFullPayload(allPlayers);
  const ts = Date.now();
  const payload = {
    ts: ts,
    version: VER,
    generatedAt: new Date().toISOString(),
    count: built.keyed,
    unkeyed: built.unkeyed,
    skippedNoTemplate: built.skippedNoTemplate,
    byEaId: built.byEaId
  };
  const jsonStr = JSON.stringify(payload);
  console.log(`组装完成：keyed=${built.keyed} unkeyed=${built.unkeyed} json=${(jsonStr.length / 1024).toFixed(1)} KB`);

  // 诊断输出（本地落盘，不进库）
  const localFile = path.join(OUT_DIR, `live_hub_${ts}.json`);
  fs.writeFileSync(localFile, jsonStr);
  console.log('本地调试文件:', localFile);

  // 统计被追踪但无逐球员真实进度的（playerValue=null，端上标「追踪中」）
  const noProgress = Object.keys(built.byEaId).filter(function (k) { return !built.byEaId[k].hasProgress; });
  console.log(`  其中「无逐球员真实进度（标追踪中）」${noProgress.length} 人`);
  console.log(`  跳过「无升级条件模板」的被追踪卡 ${built.skippedNoTemplate} 张（全量端点已覆盖，恒为 0）`);

  if (NO_UPLOAD) {
    console.log('（--no-upload，仅本地验证，未写云存储 / 未写元文档）');
    await browser.close();
    process.exit(0);
  }

  // —— 上传云存储 + 写元文档 + 清理旧文件 ——
  const app = initCloud();
  const cloudPath = CLOUD_DIR + 'live_hub_' + ts + '.json';
  const up = await app.uploadFile({ cloudPath: cloudPath, fileContent: Buffer.from(jsonStr) });
  const fileID = (up && up.fileID) || '';
  console.log('已上传:', cloudPath, '→', shortFid(fileID));
  if (!fileID) { console.error('上传未拿到 fileID'); process.exit(6); }

  let prevFileId = '';
  try {
    const old = await app.database().collection(META_COLLECTION).doc(META_DOC).get();
    prevFileId = (old && old.data && old.data.fileID) || '';
  } catch (e) { console.log('  （无旧元文档，首轮）'); }

  const liveNowIso = new Date().toISOString();
  await app.database().collection(META_COLLECTION).doc(META_DOC).set({
    ts: ts, fileID: fileID, prevFileId: prevFileId || '', updatedAt: liveNowIso,
    forceVersion: ts,   // 升级追踪自身元文档也带 forceVersion，供端上 liveHub.js 后续尊重该字段做即时强刷
    updatedAtCn: cn(liveNowIso), tsCn: cn(ts)   // 北京时间直读（控制台用；纯展示）
  });
  console.log('已写元文档', META_COLLECTION + '/' + META_DOC, 'ts=' + ts);

  if (prevFileId && prevFileId !== fileID) {
    try { await app.deleteFile({ fileList: [prevFileId] }); console.log('已清理旧文件:', shortFid(prevFileId)); }
    catch (e) { console.log('⚠️ 清理旧文件失败（不影响本次）:', e.message); }
  }

  // 引用 meta_fc27/get_evolutions 的 forceVersion：本次升级追踪同步成功即 bump 该字段，
  // 让端上 dailyWindowGate 的非窗口旁路检测到变大 → SBC/进化页立即清缓存强刷（统一数据刷新信号）。
  // ⚠️ 必须 read-merge-set（沿用 force_refresh.js 范式），绝不能裸 .set() 覆盖整篇，
  //    否则清空 SBC/进化列表元信息（fetchedAt/count/fileID/prevFileId…）。
  try {
    let evoPrev = {};
    try {
      const er = await app.database().collection(META_COLLECTION).doc('get_evolutions').get();
      // ⚠️ 修复：node-sdk 的 doc().get() 返回的 data 可能是数组 [{...}]（硬规则 29 同款坑），
      //    必须解包取首元素，否则 Object.assign({}, evoPrev, ...) 会把数组下标当键、丢光 fileID/count/fetchedAt。
      const ed = (er && er.data) || null;
      if (Array.isArray(ed)) evoPrev = ed[0] || {};
      else if (ed && typeof ed === 'object') evoPrev = ed;
    } catch (e) { console.log('  （get_evolutions 元文档可能不存在，将仅写 forceVersion）'); }
    const evoNowIso = new Date().toISOString();
    const evoNext = Object.assign({}, evoPrev, { forceVersion: ts, updatedAt: evoNowIso, updatedAtCn: cn(evoNowIso) });
    await app.database().collection(META_COLLECTION).doc('get_evolutions').set(evoNext);
    console.log('已 bump meta_fc27/get_evolutions forceVersion → ' + ts + ' (was ' + (evoPrev.forceVersion || 0) + ')');
  } catch (e) { console.log('⚠️ bump get_evolutions forceVersion 失败（不影响本次 livehub 同步）:', e.message); }

  console.log('\n=== 同步完成 ===');
  console.log('综合性被追踪球员数（已对回基础 eaId）:', built.keyed);

  // ⚠️ 2026-09-29 干净退出修复（CI run 被误标 cancelled 的根因）：
  //   此前同步完成后脚本**不关浏览器、不退出**——fut.gg 页面里的后台反爬脚本
  //   (cadmus2.script.ac) 持续抛 EvalError/403，进程吊着不放，一直挂到工作流
  //   的 timeout-minutes:30 才被取消 ⇒ 数据虽已上传成功，run 却显示 cancelled，
  //   每次都白耗 30 分钟且极易被误判为「同步失败」。
  //   修复：数据落地后立刻 close 浏览器并显式 exit(0)（上传/元文档都已完成，退出安全）。
  await browser.close();
  console.log('已关闭浏览器，干净退出。');
  process.exit(0);
}

if (require.main === module) {
  // ⚠️ 2026-09-29 兜底硬退出：即使将来再出现「浏览器关不掉 / 页面脚本吊住事件循环」
  //   这类问题，也不该让 CI 白等满 30 分钟并被标 cancelled。
  //   成功路径在第 309 行附近已 process.exit(0)，这里只是保险丝 —— 正常不会触发。
  const HARD_EXIT_MS = 8 * 60 * 1000;
  setTimeout(function () {
    console.error('⚠️ 超过 ' + (HARD_EXIT_MS / 60000) + ' 分钟仍未退出，强制终止（数据若已上传则不受影响）');
    process.exit(0);
  }, HARD_EXIT_MS).unref();
  runSync().catch(function (e) { console.error('同步失败:', e); process.exit(1); });
}

module.exports = { buildPayload: buildPayload, buildFullPayload: buildFullPayload, stripLabelProgress: stripLabelProgress };
