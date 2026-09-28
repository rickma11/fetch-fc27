// 只读诊断探针（第 8 轮）：**拦截网络请求**，找出「活动内页」真正的数据接口。
//
// 前 7 轮结论：
//   · /api/fut/live-hub/{ver}/                → 只有精选 6 人
//   · /api/fut/live-hub/{ver}/campaigns/      → 2 个活动（21 OTW / 22 DFG），带 trackerIds
//   · /api/fut/live-hub/{ver}/campaigns/21/   → 200 但 10MB 全是 fixtures（赛程），**没有球员**
//   · /live-hub/campaigns/<slug>/players/ HTML 里抓不到 /players/27-xxx/ 链接（卡片不是这个形态）
//
// ⇒ 别再猜了：直接监听页面加载时发出的 XHR/Fetch，看它到底请求了什么、响应多大、里面有没有球员数据。
//   命中后立刻对该 URL 再发一次请求并做结构分析（球员数组在哪、多少个、字段是什么、有无真实进度）。
//
// ⚠️ 只落精简摘要，不落大响应体。
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'probe', 'live_hub');
const VER = Number(process.argv[2] || process.env.FC_VER || 27);
const BASE = 'https://www.fut.gg/api/fut';
const SITE = 'https://www.fut.gg';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36';

const HARD_TIMEOUT_MS = Number(process.env.PROBE_TIMEOUT_MS || 15 * 60 * 1000);
const out = { generatedAt: new Date().toISOString(), VER, round: 8, note: '', requests: [], hits: [] };
function dump() {
  try {
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, 'net_probe.json'), JSON.stringify(out, null, 2));
  } catch (e) { console.log('dump err', e.message); }
}
const watchdog = setTimeout(() => { out.note = 'WATCHDOG TIMEOUT（部分结果）'; dump(); console.error('WATCHDOG TIMEOUT'); process.exit(5); }, HARD_TIMEOUT_MS);

function jget(t) { try { return JSON.parse(t); } catch (e) { return null; } }
async function apiGet(page, url) {
  try {
    const r = await page.request.get(url, { headers: { Accept: 'application/json' }, timeout: 180000 });
    return { status: r.status(), body: await r.text() };
  } catch (e) { console.log('  api err', e.message); return null; }
}
function findPlayerArray(node, depth) {
  if (depth > 6) return null;
  if (Array.isArray(node)) {
    if (node.length && node[0] && typeof node[0] === 'object') {
      const k = Object.keys(node[0]);
      if (k.some(x => /^(eaId|playerEaId|playerId)$/i.test(x))) return node;
    }
    return null;
  }
  if (!node || typeof node !== 'object') return null;
  let best = null;
  for (const key of Object.keys(node)) {
    const r = findPlayerArray(node[key], depth + 1);
    if (r && (!best || r.length > best.length)) best = r;
  }
  return best;
}

(async () => {
  console.log('启动 Chromium ...');
  const browser = await chromium.launch({ headless: true, args: ['--disable-blink-features=AutomatedControlled', '--no-sandbox', '--disable-dev-shm-usage'] });
  const ctx = await browser.newContext({ userAgent: UA, locale: 'en-US', viewport: { width: 1280, height: 900 }, timezoneId: 'America/New_York' });
  const page = await ctx.newPage();

  // 网络监听：只记 XHR/Fetch（含 /api/ 的也记）
  const seen = new Set();
  page.on('response', async resp => {
    try {
      const req = resp.request();
      const rt = req.resourceType();
      const u = resp.url();
      if (!(rt === 'xhr' || rt === 'fetch' || u.includes('/api/'))) return;
      if (seen.has(u)) return;
      seen.add(u);
      let size = 0, body = null;
      try { const b = await resp.body(); size = b.length; body = b.toString('utf8'); } catch (e) { }
      const rec = {
        url: u.replace(SITE, ''),
        status: resp.status(),
        size,
        hasEaId: body ? body.indexOf('"eaId"') >= 0 : false,
        hasPlayerValue: body ? body.indexOf('playerValue') >= 0 : false,
        hasObjective: body ? /objectives|requirement/.test(body) : false
      };
      out.requests.push(rec);
      // 命中「球员数据」的：就地做一次结构分析
      if (body && (rec.hasEaId || rec.hasPlayerValue) && out.hits.length < 6) {
        const j = jget(body);
        const data = j && j.data ? j.data : j;
        const arr = findPlayerArray(data, 0);
        const hit = { url: rec.url, size, topKeys: data && typeof data === 'object' ? Object.keys(data) : [], playerArrayLen: arr ? arr.length : 0 };
        if (arr && arr.length) {
          hit.playerKeys = Object.keys(arr[0]);
          hit.sample = JSON.stringify(arr[0]).slice(0, 1200);
          hit.withPlayerValue = arr.filter(p => p.playerValue != null).length;
          hit.withObjectives = arr.filter(p => p.objectives != null).length;
        }
        out.hits.push(hit);
        console.log(`  HIT ${rec.url.slice(0, 110)} → players=${hit.playerArrayLen}`);
      }
    } catch (e) { }
  });

  console.log('过 Cloudflare ...');
  await page.goto(SITE + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  let passed = false;
  for (let i = 0; i < 40; i++) {
    try {
      const r = await page.request.get(`${BASE}/players/v2/${VER}/?page=1`, { headers: { Accept: 'application/json' }, timeout: 20000 });
      if (r.status() === 200) { passed = true; console.log('CF 通过', i + 1); break; }
    } catch (e) { }
    await page.waitForTimeout(3000);
  }
  if (!passed) { out.note = 'CF 未通过'; dump(); await browser.close(); process.exit(2); }

  // 逐页访问：活动内页（OTW / DFG）+ live-hub 落地页
  const pages = [
    `${SITE}/live-hub/campaigns/ones-to-watch/players/`,
    `${SITE}/live-hub/campaigns/destined-for-glory/players/`,
    `${SITE}/live-hub/`
  ];
  for (const u of pages) {
    console.log('\n访问 ' + u.replace(SITE, ''));
    try {
      await page.goto(u, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForTimeout(3500);
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(3000);
      await page.evaluate(() => window.scrollTo(0, Math.floor(document.body.scrollHeight / 2)));
      await page.waitForTimeout(2500);
    } catch (e) { console.log('  goto err', e.message); }
  }

  console.log('\n=== 抓到的 XHR（按大小）===');
  out.requests.sort((a, b) => b.size - a.size);
  for (const r of out.requests.slice(0, 25)) {
    console.log(`  ${String(r.size).padStart(9)}B ${r.status} ${r.url.slice(0, 120)} eaId=${r.hasEaId ? 'Y' : '-'} pv=${r.hasPlayerValue ? 'Y' : '-'}`);
  }
  console.log('\n=== HIT 结构 ===');
  for (const h of out.hits) {
    console.log(`  ${h.url.slice(0, 110)}`);
    console.log(`     topKeys=${(h.topKeys || []).join(',')} players=${h.playerArrayLen}`);
    if (h.playerKeys) console.log(`     playerKeys=${h.playerKeys.join(',')} playerValue=${h.withPlayerValue} objectives=${h.withObjectives}`);
    if (h.sample) console.log('     sample=' + h.sample.slice(0, 600));
  }
  out.note = out.hits.length ? 'HIT: 抓到含球员数据的 XHR' : 'MISS: 未见含球员的 XHR';
  clearTimeout(watchdog);
  await browser.close();
  dump();
  console.log('\n===== ' + out.note + ' =====');
  process.exit(0);
})().catch(e => { console.error('ERR', e); out.note = 'ERR ' + e.message; dump(); process.exit(1); });
