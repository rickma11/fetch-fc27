// 收藏室（Token Store）代币兑换价同步：抓 fut.gg token-store 数据集 → 回填 players/details 云库。
//
// ── 背景（2026-09-21）───────────────────────────────────────────────────
// FC27 新增「收藏室」功能：用收藏室代币兑换球员（如 Theo Walcott Base Hall of FUT 85 = 500 代币）。
// 该数值**不在**球员详情接口 player-item-definitions 里（probe/r15 实测无 token 键），
// 权威来源是 r2 静态数据集（manifest 引 hash，与 SBC/进化数据集同机制）：
//   GET https://r2.fut.gg/{ver}/manifest.json          → keys 含 token-store / event-tokens
//   GET https://r2.fut.gg/{ver}/token-store.v1.{hash}.json
//       → { items: [{ itemType, tokenCost, player:{eaId}, playerItemEaId, purchaseLimit, endTime, ... }] }
// 球员类条目 itemType==='player'，join 键 = player.eaId（实测与小程序/云库 eaId 一致，Walcott 164859 ✓）。
// 商店会轮换（整店 storeExpiresAt + 条目各有 startTime/endTime）→ 每次跑都要经 manifest 取最新 hash。
//
// 数据流（对齐 sbcCost 的 upload_sbcs 自愈模式）：
//   本脚本（独立 CI 步骤，continue-on-error）
//     阶段1 浏览器抓数据集 → cloud-data/fc{ver}/token_store.json（小文件，随 git 提交）
//     阶段2 TCB 局部 update 回写 players_fc{ver} + details_fc{ver} 的 tokenStoreCost
//   管线顺序：Upload to CloudBase（doc.set 抹平非 pickPlayer 字段）→ 本步重补 → Warm up roster
//   ＝ 天然自愈：每天落库抹平后本步立刻补回，roster payload 当天就带上。
//
// 用法：
//   node scripts/sync_token_store.js --ver 27             # 抓取 + 回填（CI 与本地同款）
//   node scripts/sync_token_store.js --ver 27 --no-fetch  # 不联网，用已有 token_store.json 回填
//   node scripts/sync_token_store.js --ver 27 --dry       # 只抓取写文件，不写云库
//
// 失败语义：CF 没过 / manifest 拉不到 → exit 1（CI continue-on-error 兜底）；
// 单个球员回写失败重试 3 次后记 FAIL 继续，不中断。
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

function parseArgs(argv) {
  const o = { ver: parseInt(process.env.FC_VER, 10) || 27, noFetch: false, dry: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--ver') { o.ver = parseInt(argv[++i], 10) || 27; }
    else if (a === '--no-fetch') { o.noFetch = true; }
    else if (a === '--dry') { o.dry = true; }
  }
  return o;
}
const ARGS = parseArgs(process.argv);
const VER = ARGS.ver;
const OUT_DIR = path.resolve(__dirname, '..', 'cloud-data', 'fc' + VER);
const OUT_FILE = path.join(OUT_DIR, 'token_store.json');

const UA = process.env.CF_UA || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36';
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── 阶段 1：经真实浏览器抓 token-store 数据集 ─────────────────────────────
// 本机 CF 对 headless 拦得死（非持久化 headless 连续 403），故默认 headed + 持久化 profile
// （与 backfill_seasonpass.js 同款）；CI 无桌面，设 CF_HEADLESS=true 走 headless 持久化。
async function fetchTokenStore() {
  const os = require('os');
  const PROFILE = process.env.CF_PROFILE || path.join(os.tmpdir(), 'oao-futgg-profile');
  const headless = process.env.CF_HEADLESS === 'true';
  const args = ['--disable-blink-features=AutomationControlled', '--no-sandbox', '--disable-dev-shm-usage'];
  const opts = { headless, channel: process.env.CF_CHANNEL || 'msedge', userAgent: UA, locale: 'en-US', viewport: { width: 1280, height: 800 }, args };
  let ctx;
  try { ctx = await chromium.launchPersistentContext(PROFILE, opts); }
  catch (e) {
    console.log('（msedge 持久化启动失败，改用 playwright chromium：' + String(e.message).slice(0, 80) + '）');
    delete opts.channel;
    ctx = await chromium.launchPersistentContext(PROFILE + '-cr', opts);
  }
  const page = ctx.pages()[0] || await ctx.newPage();

  console.log('过 Cloudflare ...');
  await page.goto('https://www.fut.gg/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  let passed = false;
  for (let i = 0; i < 30; i++) {
    let status = -1;
    try {
      status = await page.evaluate(async () => {
        try { const r = await fetch('https://www.fut.gg/api/fut/players/v2/27/?page=1', { headers: { Accept: 'application/json' } }); return r.status; }
        catch (e) { return -1; }
      });
    } catch (e) { status = -2; }
    if (status === 200) { passed = true; break; }
    await sleep(3000);
  }
  if (!passed) { try { await ctx.close(); } catch (e) {} throw new Error('CF 未通过'); }
  console.log('CF 已通过');

  // manifest → token-store hash（每次都取最新，商店轮换 hash 会变）
  const manTxt = await page.evaluate(async u => {
    try { const r = await fetch(u); return await r.text(); } catch (e) { return 'ERR:' + e.message; }
  }, `https://r2.fut.gg/${VER}/manifest.json`);
  let man;
  try { man = JSON.parse(manTxt); } catch (e) { try { await ctx.close(); } catch (e2) {} throw new Error('manifest 解析失败: ' + manTxt.slice(0, 120)); }
  const hash = man['token-store'];
  if (!hash) { try { await ctx.close(); } catch (e) {} throw new Error('manifest 无 token-store 键'); }
  // 商店未变短路：hash 与上次提交一致 → 不抓全量、不解析、不回写
  let prevHash = null;
  try { prevHash = JSON.parse(fs.readFileSync(OUT_FILE, 'utf8')).hash; } catch (e) {}
  if (prevHash && prevHash === hash) {
    console.log('token-store hash 未变（' + hash + '）→ 商店未轮换，跳过抓取与回写');
    try { await ctx.close(); } catch (e) {}
    return { unchanged: true, hash: hash };
  }
  const url = `https://r2.fut.gg/${VER}/token-store.v1.${hash}.json`;
  console.log('token-store url:', url);

  const txt = await page.evaluate(async u => {
    try { const r = await fetch(u); return await r.text(); } catch (e) { return 'ERR:' + e.message; }
  }, url);
  try { await ctx.close(); } catch (e) {}

  let j;
  try { j = JSON.parse(txt); } catch (e) { throw new Error('token-store 数据集解析失败: ' + txt.slice(0, 120)); }
  const items = Array.isArray(j.items) ? j.items : [];
  // 只留球员类条目：join 键 = player.eaId（playerItemEaId 兜底），值 = tokenCost
  const players = {};
  let dup = 0;
  for (const it of items) {
    if (it.itemType !== 'player') continue;
    const eaId = Number((it.player && it.player.eaId) || it.playerItemEaId) || null;
    const cost = Number(it.tokenCost);
    if (!eaId || !cost || cost <= 0) continue;
    if (players[eaId] && players[eaId].tokenCost !== cost) { dup++; console.log('  ⚠️ eaId ' + eaId + ' 冲突价 ' + players[eaId].tokenCost + ' vs ' + cost + '，保留先者'); continue; }
    players[eaId] = {
      tokenCost: cost,
      name: String(it.name || '').trim(),
      purchaseLimit: Number(it.purchaseLimit) || 0,
      endTime: it.endTime || null,
      eventTokenId: it.eventTokenId != null ? Number(it.eventTokenId) : null,
    };
  }
  const out = {
    ver: VER,
    hash: hash,
    sourceUrl: url,
    storeExpiresAt: j.storeExpiresAt || null,
    fetchedAt: new Date().toISOString(),
    itemCount: items.length,
    playerCount: Object.keys(players).length,
    dupCount: dup,
    players: players,
  };
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(out, null, 2));
  console.log(`token-store：共 ${items.length} 条，球员类 ${Object.keys(players).length} 人${dup ? '（冲突 ' + dup + '）' : ''}，已写 ${OUT_FILE}`);
  return out;
}

// ── 阶段 2：TCB 局部 update 回写云库（对齐 upload_sbcs.js sbcCost 段）────────
async function enrichCloud(data) {
  const { resolve } = require('./tcb_env');
  const cred = resolve();
  if (cred.missing && cred.missing.length) { throw new Error('缺少 TCB 凭证：' + cred.missing.join('/')); }
  const tcb = require('@cloudbase/node-sdk');
  const app = tcb.init({ env: cred.ENV_ID, secretId: cred.SECRET_ID, secretKey: cred.SECRET_KEY });
  const db = app.database();
  const _ = db.command;
  const COLS = ['players_fc' + VER, 'details_fc' + VER];
  const map = data.players || {};
  const eaIds = Object.keys(map).map(Number);
  console.log(`[tokenStoreCost] 回填 ${eaIds.length} 人 → ${COLS.join(' + ')}`);

  let ok = 0, fail = 0;
  for (const ea of eaIds) {
    const val = map[ea].tokenCost;
    for (const c of COLS) {
      let done = false, lastErr = null;
      for (let k = 1; k <= 3 && !done; k++) {
        try { await db.collection(c).where({ eaId: ea }).update({ tokenStoreCost: val }); done = true; }
        catch (e) { lastErr = e; await sleep(800 * k); }
      }
      if (done) { ok++; console.log('  UP', c, 'eaId=' + ea, 'tokenStoreCost=' + val, map[ea].name || ''); }
      else { fail++; console.error('  FAIL', c, 'eaId=' + ea, (lastErr && lastErr.message) || lastErr); }
    }
  }
  // 清理失效：曾有过 tokenStoreCost 但当前商店已不含该球员（兑换下架）→ 置 null，避免残留旧价。
  let cleared = 0;
  for (const c of COLS) {
    try {
      const stale = await db.collection(c).where({ tokenStoreCost: _.gt(0) }).get();
      const rm = (stale.data || []).filter(d => eaIds.indexOf(Number(d.eaId)) < 0);
      for (const d of rm) {
        await db.collection(c).doc(d._id).update({ tokenStoreCost: null });
        cleared++;
      }
      if (rm.length) console.log('  CLR', c, '清掉失效 tokenStoreCost ' + rm.length + ' 人');
    } catch (e) { console.error('  CLR-FAIL', c, (e && e.message) || e); }
  }
  console.log(`[tokenStoreCost] 回写完成：UP ${ok} | FAIL ${fail} | CLR ${cleared}`);
  return { ok, fail, cleared };
}

(async () => {
  let data;
  if (ARGS.noFetch) {
    if (!fs.existsSync(OUT_FILE)) { console.error('找不到 ' + OUT_FILE + '（--no-fetch 需要已有文件）'); process.exit(1); }
    data = JSON.parse(fs.readFileSync(OUT_FILE, 'utf8'));
    console.log('--no-fetch：使用已有 ' + OUT_FILE + '（球员 ' + Object.keys(data.players || {}).length + ' 人）');
  } else {
    data = await fetchTokenStore();
  }
  if (data && data.unchanged) { console.log('token-store 未变化，跳过云库回写'); process.exit(0); }
  if (ARGS.dry) { console.log('--dry：跳过云库回写'); process.exit(0); }
  await enrichCloud(data);
  process.exit(0);
})().catch(e => { console.error('FATAL', e && e.message); process.exit(1); });
