// FC27 升级追踪（Live Hub）同步脚本：CI 真实 Chromium 过 Cloudflare，抓 live-hub/27 全量，
// 再用 has_dynamic 列表 + definition-data 反查 liveHubTrackerId 拿到**综合性被追踪全集**（fut.gg 网站
// 实际用于给每张卡打「追踪 widget」的信号），按基础 eaId 建索引组装精简 JSON，上传云存储 fc27/livehub/
// 并写 meta_fc27/livehub 元文档。
//
// 关键修正（2026-09-28 复盘）：
//   · live-hub 聚合 API（data.players）只返回「当前精选/活跃窗口」的 6 名球员（DFG 3 + OTW 3），
//     并非全部被追踪卡。fut.gg 网站每张卡的追踪 widget 由 `definition-data.liveHubTrackerId` 驱动，
//     覆盖所有促销卡（含 Adeyemi/Veiga/OPTA 等），远多于 6。故「谁被追踪」的真源改为
//     has_dynamic 列表 + definition-data 反查（综合性），live-hub 仅用于「这 6 人的真实进度 + 同 trackerId 模板」。
//   · per-player 进度（playerValue）只有 live-hub 聚合里那 6 人有；其余被追踪卡（Adeyemi/Veiga/OPTA…）
//     经反复探查无可达的逐球员进度端点（live-hub 变体均被忽略、objective-campaign 端点 404）。
//     对这类卡：沿用同 trackerId 的 objectives 模板展示条件，进度标「追踪中」（playerValue=null，端上不臆造 0/X）。
//
// 设计要点：
//   - 过 CF 沿用 probe_live_hub.js 的 page.request 方案（Node 侧 fetch，共享 cf_clearance cookie）。
//   - 主键用 card.eaId（基础球员 eaId，与小程序 roster 主键同套），不碰 playerItemEaId（item 段，另套 id）。
//   - 只产出「被追踪球员 + 各自进度」，不写球员主表、不碰 players_fc27 文档、不跑 warm_roster —— 与 fetch-fc27 管线隔离。
//   - 端上只读本脚本产出的静态 JSON（wx.cloud.downloadFile），不调 get_players 云函数，降低云函数/DB 调用。
//   - 每日由 GitHub Actions 调度一次（sync-live-hub.yml）；端上日级缓存，自然日内不二次刷新。
//
// 用法：node scripts/sync_live_hub.js [ver]            （ver 默认 27；可加 --no-upload 仅本地验证不写云）
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const cloudbase = require('@cloudbase/node-sdk');

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

// 由三部分建模「综合性被追踪全集」：
//   liveHubPlayers：live-hub 聚合球员（含真实 objectives + 进度）
//   defMap：{ eaId: liveHubTrackerId }（definition-data 反查，综合性被追踪信号）
//   dynMeta：{ eaId: { rarityName, slug, clubName, nationName } }（has_dynamic 枚举，提供 campaignName 等）
// 返回 { byEaId, keyed, unkeyed, templateByTrackerId }。
//   · live-hub 里的人：保留真实进度。
//   · 同 trackerId 由 live-hub 抽「模板」（requirement/value/upgrades，去进度），供其余被追踪卡复用（§七：同 trackerId 条件一致）。
//   · defMap 中 liveHubTrackerId != null 但不在 live-hub 的人：补进 byEaId，objectives 用模板（playerValue=null → 端上标「追踪中」）。
function buildFullPayload(liveHubPlayers, defMap, dynMeta) {
  defMap = defMap || {};
  dynMeta = dynMeta || {};
  const byEaId = {};

  // 1) live-hub 的 6（真实进度）
  for (const p of (liveHubPlayers || [])) {
    const card = p.card || {};
    let ea = card.eaId != null ? Number(card.eaId) : null;
    if (ea == null && p.playerItemEaId != null) ea = Number(p.playerItemEaId);
    if (!ea) continue;
    const tracker = p.tracker || {};
    const objectives = Array.isArray(tracker.objectives)
      ? tracker.objectives.map(function (o) {
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
        })
      : [];
    byEaId[String(ea)] = {
      eaId: ea,
      itemEaId: p.playerItemEaId != null ? Number(p.playerItemEaId) : null,
      trackerId: (p.trackerId != null) ? p.trackerId : null,
      campaignName: p.campaignName || (dynMeta[ea] && dynMeta[ea].rarityName) || '',
      competitionName: p.competitionName || '',
      clubName: p.clubName || (dynMeta[ea] && dynMeta[ea].clubName) || '',
      nationName: p.nationName || (dynMeta[ea] && dynMeta[ea].nationName) || '',
      startDate: (p.data && p.data.startDate) || '',
      objectives: objectives,
      hasProgress: true
    };
  }

  // 2) 由 live-hub 同 trackerId 抽「模板」（去进度 + 剥离 label 里的插值进度）
  //    ⚠️ 关键坑（2026-09-28 用户截图实证）：fut.gg 会把精选球员的进度插值进 label，
  //    如 "Win 3 of next 6 matches (2/6)" 里的 "(2/6)" 是该精选人的进度。若原样当模板，
  //    所有非精选球员都会顶着 "(2/6)" —— 看起来人人都是 2/6（统计错误）。故模板 label 必须剥离 " (N/M)"。
  const templateByTrackerId = {};
  for (const k of Object.keys(byEaId)) {
    const r = byEaId[k];
    if (r.trackerId != null && !templateByTrackerId[r.trackerId] && r.objectives.length) {
      templateByTrackerId[r.trackerId] = r.objectives.map(function (o) {
        return { key: o.key, label: stripLabelProgress(o.label), requirement: o.requirement, value: o.value, upgrades: o.upgrades };
      });
    }
  }

  // 3) 综合集：defMap 中 liveHubTrackerId != null 的，全部补进 byEaId（live-hub 已有则保留真实进度）
  //    ⚠️ 无模板（该 trackerId 在 live-hub 里没有任何精选样本 → 拿不到升级条件）的卡**不补进**，
  //    避免端上出现「动态」标签 + 空「升级规则」页签（2026-09-28：trackerId 34 的 6 张即此类，
  //    fut.gg live-hub 当前无 34 号活动样本；等其出现精选样本后自动纳入）。
  let keyed = Object.keys(byEaId).length, unkeyed = 0, skippedNoTemplate = 0;
  for (const eaStr of Object.keys(defMap)) {
    const tid = defMap[eaStr];
    if (tid == null) continue;
    const ea = Number(eaStr);
    if (byEaId[String(ea)]) continue; // 已有真实进度
    const meta = dynMeta[ea] || {};
    const tpl = templateByTrackerId[tid] || [];
    if (!tpl.length) { skippedNoTemplate++; continue; } // 无升级条件模板 → 不展示（避免空页签）
    byEaId[String(ea)] = {
      eaId: ea,
      itemEaId: null,
      trackerId: tid,
      campaignName: meta.rarityName || '',
      competitionName: '',
      clubName: meta.clubName || '',
      nationName: meta.nationName || '',
      startDate: '',
      // 模板复用：playerValue=null（无逐球员进度；端上「升级规则」页只列条件，不显进度/次数）
      objectives: tpl.map(function (o) {
        return { key: o.key, label: o.label, requirement: o.requirement, value: o.value, playerValue: null, isCompleted: false, isNotPossible: false, upgrades: o.upgrades };
      }),
      hasProgress: false
    };
    keyed++;
  }

  return { byEaId: byEaId, keyed: keyed, unkeyed: unkeyed, skippedNoTemplate: skippedNoTemplate, templateByTrackerId: templateByTrackerId };
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

  // ① live-hub 聚合（6 人，含真实进度 + 同 trackerId 模板源）
  console.log(`\n① 抓取 live-hub/${VER} 全量...`);
  let lhText = null, lhStatus = 0;
  for (let attempt = 1; attempt <= 4; attempt++) {
    const t = await apiGet(page, `${BASE}/live-hub/${VER}/`);
    if (t) { lhText = t; lhStatus = 200; console.log(`  live-hub 第 ${attempt} 次成功 bytes=${t.length}`); break; }
    if (attempt < 4) await page.waitForTimeout(5000);
  }
  if (!lhText) { await browser.close(); console.error('live-hub 抓取最终失败'); process.exit(3); }
  const lhJson = jget(lhText);
  const lhPlayers = (lhJson && lhJson.data && Array.isArray(lhJson.data.players)) ? lhJson.data.players : [];
  console.log(`  live-hub players=${lhPlayers.length}`);

  // ② has_dynamic 枚举（data 为直数组，非 data.players）→ 收集 eaId/rarityName 等
  console.log('\n② 枚举 has_dynamic 列表...');
  const dynMeta = {};
  let pg = 1;
  while (pg <= 100) {
    const t = await apiGet(page, `${BASE}/players/v2/${VER}/?has_dynamic=true&page=${pg}`);
    if (!t) break;
    const j = jget(t);
    const arr = (j && Array.isArray(j.data)) ? j.data : [];
    for (const pl of arr) {
      const ea = pl.eaId != null ? Number(pl.eaId) : null;
      if (!ea) continue;
      dynMeta[ea] = { rarityName: pl.rarityName || '', slug: pl.slug || '', clubName: pl.clubName || '', nationName: pl.nationName || '' };
    }
    console.log(`  has_dynamic page ${pg} count ${arr.length} 累计 ${Object.keys(dynMeta).length}`);
    if (!arr.length) break;
    const pag = (j && j.pagination) || {};
    if (pag.totalPages && pg >= pag.totalPages) break;
    pg++;
  }
  const dynSlugs = Object.values(dynMeta).map(function (m) { return m.slug; }).filter(Boolean);
  console.log(`  has_dynamic 动态卡总数 = ${Object.keys(dynMeta).length}`);

  // ③ definition-data 批量反查 liveHubTrackerId（综合性被追踪信号）
  console.log('\n③ definition-data 反查 liveHubTrackerId...');
  const defMap = {};
  for (let i = 0; i < dynSlugs.length; i += 50) {
    const batch = dynSlugs.slice(i, i + 50);
    const t = await apiGet(page, `${BASE}/players/v2/definition-data/?game=${VER}&slugs=${encodeURIComponent(batch.join(','))}`);
    if (!t) continue;
    const arr = jget(t);
    const list = Array.isArray(arr) ? arr : (arr && arr.data ? arr.data : []);
    for (const d of list) {
      let ea = d.eaId != null ? Number(d.eaId) : null;
      if (ea == null && d.slug) { const m = /(\d+)$/.exec(d.slug); if (m) ea = Number(m[1]); }
      if (ea == null) continue;
      defMap[String(ea)] = (d.liveHubTrackerId != null) ? d.liveHubTrackerId : null;
    }
    console.log(`  def batch ${i} -> ${list.length} items`);
  }
  const trackedCount = Object.values(defMap).filter(function (v) { return v != null; }).length;
  console.log(`  definition-data 被追踪（liveHubTrackerId!=null）总数 = ${trackedCount}`);

  // ④ 建模综合性被追踪全集
  const built = buildFullPayload(lhPlayers, defMap, dynMeta);
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

  // 统计被追踪但无逐球员进度的（模板复用）
  const noProgress = Object.keys(built.byEaId).filter(function (k) { return !built.byEaId[k].hasProgress; });
  console.log(`  其中「无逐球员进度（模板复用/仅升级条件）」${noProgress.length} 人`);
  console.log(`  跳过「无升级条件模板」的被追踪卡 ${built.skippedNoTemplate} 张（如 trackerId 34 当前无 live-hub 精选样本）`);

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

  await app.database().collection(META_COLLECTION).doc(META_DOC).set({
    ts: ts, fileID: fileID, prevFileId: prevFileId || '', updatedAt: new Date().toISOString()
  });
  console.log('已写元文档', META_COLLECTION + '/' + META_DOC, 'ts=' + ts);

  if (prevFileId && prevFileId !== fileID) {
    try { await app.deleteFile({ fileList: [prevFileId] }); console.log('已清理旧文件:', shortFid(prevFileId)); }
    catch (e) { console.log('⚠️ 清理旧文件失败（不影响本次）:', e.message); }
  }

  console.log('\n=== 同步完成 ===');
  console.log('综合性被追踪球员数（已对回基础 eaId）:', built.keyed);
}

if (require.main === module) {
  runSync().catch(function (e) { console.error('同步失败:', e); process.exit(1); });
}

module.exports = { buildPayload: buildPayload, buildFullPayload: buildFullPayload, stripLabelProgress: stripLabelProgress };
