// FC27 升级追踪（Live Hub）同步脚本：CI 真实 Chromium 过 Cloudflare，抓 live-hub/27 全量，
// 用球员「基础 eaId」(card.eaId) 建索引组装精简 JSON，上传云存储 fc27/livehub/ 并写 meta_fc27/livehub 元文档。
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
// 把云端 fileID 转成可读文件名（用于日志）
function shortFid(fid) { return fid ? String(fid).slice(0, 64) + (fid.length > 64 ? '…' : '') : ''; }

// 由 live-hub 原始球员数组 → 精简 JSON（按基础 eaId 建索引）
function buildPayload(players) {
  const byEaId = {};
  let keyed = 0, unkeyed = 0;
  for (const p of players) {
    const card = p.card || {};
    // 主键：card.eaId（与 players/v2 同 schema，即小程序 roster 主键）。
    // 兜底：个别记录可能未带 card 嵌套（如某些探查快照只平铺了 playerItemEaId），此时用 playerItemEaId（同为该 item 的 eaId）。
    let eaId = card.eaId != null ? Number(card.eaId) : null;
    if (eaId == null && p.playerItemEaId != null) eaId = Number(p.playerItemEaId);
    if (!eaId) { unkeyed++; continue; }   // 无任何可解析 eaId 则跳过（无法对回 roster）
    const tracker = p.tracker || {};
    // 升级条件来源：优先 tracker.objectives（真实 live-hub 全量 JSON 结构）；
    // 兜底 p.objectives（部分探查快照把 objectives 平铺到球员对象顶层，便于离线校验）。
    const rawObjectives = (tracker && Array.isArray(tracker.objectives)) ? tracker.objectives
      : (Array.isArray(p.objectives) ? p.objectives : []);
    const objectives = rawObjectives.map(function (o) {
      const req = o.requirement || o.req || '';   // 真实 API 用 requirement；部分快照用 req
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
      itemEaId: p.playerItemEaId != null ? Number(p.playerItemEaId) : null,  // 仅调试用
      trackerId: (p.trackerId != null) ? p.trackerId : null,
      campaignName: p.campaignName || '',
      competitionName: p.competitionName || '',
      clubName: p.clubName || '',
      nationName: p.nationName || '',
      startDate: (p.data && p.data.startDate) || '',
      objectives: objectives
    };
    keyed++;
  }
  return { byEaId: byEaId, keyed: keyed, unkeyed: unkeyed };
}

async function runSync() {
  console.log('启动 Chromium (headless) ...');
  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox', '--disable-dev-shm-usage']
  });
  const ctx = await browser.newContext({
    userAgent: UA, locale: 'en-US', viewport: { width: 1280, height: 800 }, timezoneId: 'America/New_York'
  });
  const page = await ctx.newPage();
  page.on('console', function (m) { const t = m.text(); if (/error|fail|denied|challenge|redirect/i.test(t)) console.log('[browser]', t); });

  console.log('打开 fut.gg 过 Cloudflare ...');
  await page.goto('https://www.fut.gg/', { waitUntil: 'domcontentloaded', timeout: 60000 });

  // 轻量 API 探 CF（与 probe 同口径）
  const LIGHT = `https://www.fut.gg/api/fut/players/v2/${VER}/?page=1`;
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

  const url = `https://www.fut.gg/api/fut/live-hub/${VER}/`;
  console.log(`\n抓取 live-hub/${VER} 全量（page.request，Node 侧解析）...`);
  let text = null, status = 0;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const r = await page.request.get(url, { headers: { Accept: 'application/json' }, timeout: 60000 });
      status = r.status();
      const ct = r.headers()['content-type'] || '';
      text = await r.text();
      if (status === 200 && (text.trim().startsWith('{') || text.trim().startsWith('['))) {
        console.log(`  第 ${attempt} 次成功：status=${status} ct=${ct} bytes=${text.length}`);
        break;
      }
      console.log(`  第 ${attempt} 次非预期：status=${status} ct=${ct} preview=${text.slice(0, 300)}`);
    } catch (e) { console.log(`  第 ${attempt} 次异常: ${e.message}`); }
    if (attempt < 4) await page.waitForTimeout(5000);
  }
  await browser.close();
  if (!text || status !== 200) { console.error('live-hub 抓取最终失败'); process.exit(3); }

  let j;
  try { j = JSON.parse(text); } catch (e) { console.error('JSON 解析失败:', e.message); process.exit(4); }
  const players = (j && j.data && Array.isArray(j.data.players)) ? j.data.players : [];
  if (!players.length) { console.error('live-hub 无 players'); process.exit(5); }
  console.log(`live-hub 解析：players=${players.length}`);

  const built = buildPayload(players);
  const ts = Date.now();
  const payload = {
    ts: ts,
    version: VER,
    generatedAt: new Date().toISOString(),
    count: built.keyed,
    unkeyed: built.unkeyed,
    byEaId: built.byEaId
  };
  const jsonStr = JSON.stringify(payload);
  console.log(`组装完成：keyed=${built.keyed} unkeyed=${built.unkeyed} json=${(jsonStr.length / 1024).toFixed(1)} KB`);

  // 本地落盘（仅调试/校验用，不进库）
  const localFile = path.join(OUT_DIR, `live_hub_${ts}.json`);
  fs.writeFileSync(localFile, jsonStr);
  console.log('本地调试文件:', localFile);

  if (NO_UPLOAD) {
    console.log('（--no-upload，仅本地验证，未写云存储 / 未写元文档）');
    process.exit(0);
  }

  // —— 上传云存储 + 写元文档 + 清理旧文件 ——
  const app = initCloud();
  const cloudPath = CLOUD_DIR + 'live_hub_' + ts + '.json';
  const up = await app.uploadFile({ cloudPath: cloudPath, fileContent: Buffer.from(jsonStr) });
  const fileID = (up && up.fileID) || '';
  console.log('已上传:', cloudPath, '→', shortFid(fileID));
  if (!fileID) { console.error('上传未拿到 fileID'); process.exit(6); }

  // 读旧元文档（拿 prevFileId 用于清理）
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
  console.log('被追踪球员数（已对回基础 eaId）:', built.keyed);
}

if (require.main === module) {
  runSync().catch(function (e) { console.error('同步失败:', e); process.exit(1); });
}

module.exports = { buildPayload: buildPayload };
