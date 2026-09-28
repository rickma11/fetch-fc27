// 只读诊断探针（第 5 轮）：直取 /live-hub/ 系页面的**可见文本与结构**，定位升级规则/进度到底在哪。
//
// 前 4 轮结论：
//   R1-R3: 球员页 /players/<slug>/ 200，渲染后**无** #tracker；HTML 里的 /live-hub/ 只是导航栏链接（R4 证伪）。
//   R4: ① live-hub 网页 /live-hub/ 标题正确、含 14 个 /players/ 链接、正文含 "tracker" 字样 3 次，**但无 id="tracker"**
//       ② /live-hub/27/ 与 /live-hub/campaigns/ 也都存在（title 正确）
//       ③ 精选 6 人解析为空（live-hub API 形状没猜对，需 dump 原始响应）
//
// 本轮目标（不再猜 DOM id，直接读「页面上显示给人看的东西」）：
//   A) dump live-hub API 原始响应前 1500 字符 → 修正确形状（为什么 featured 为空）
//   B) /live-hub/ 与 /live-hub/campaigns/：innerText 前 6000 字符 + 球员链接 + 绿条/条件文案统计
//   C) 进 campaign 详情页（从 B 提取的链接）看是否列出该活动**全部**被追踪球员 + 进度
//   D) 球员页：枚举 tab 按钮并逐个点击，检查是否点出 #tracker（排除「需手动切 tab」这一可能）
//
// 结果落盘 probe/live_hub/detail_probe.json，由 workflow 提交回 main 供本地读回。
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'probe', 'live_hub');
const VER = Number(process.argv[2] || process.env.FC_VER || 27);
const BASE = 'https://www.fut.gg/api/fut';
const SITE = 'https://www.fut.gg';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36';

const HARD_TIMEOUT_MS = Number(process.env.PROBE_TIMEOUT_MS || 12 * 60 * 1000);
const out = { generatedAt: new Date().toISOString(), VER, round: 5, note: '', sections: {} };
function dump() {
  try {
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, 'detail_probe.json'), JSON.stringify(out, null, 2));
  } catch (e) { console.log('dump err', e.message); }
}
const watchdog = setTimeout(() => {
  out.note = 'WATCHDOG TIMEOUT（部分结果）';
  dump();
  console.error('WATCHDOG TIMEOUT — 已写出部分结果');
  process.exit(5);
}, HARD_TIMEOUT_MS);

function jget(t) { try { return JSON.parse(t); } catch (e) { return null; } }
async function apiGet(page, url, accept) {
  for (let a = 1; a <= 3; a++) {
    try {
      const r = await page.request.get(url, { headers: { Accept: accept || 'application/json' }, timeout: 60000 });
      const t = await r.text();
      if (r.status() === 200) return { status: 200, body: t };
      console.log('  api', url.slice(0, 90), 'status', r.status(), t.slice(0, 100));
      return { status: r.status(), body: t };
    } catch (e) { console.log('  api err', e.message); }
    if (a < 3) await page.waitForTimeout(3000);
  }
  return null;
}

// 读「页面上显示给人看的东西」：可见文本 + 结构统计（不依赖任何 id/class 猜测）
async function readPage(page, url, opts) {
  const o = opts || {};
  const rec = { url, err: '' };
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 40000 });
    await page.waitForTimeout(2500);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(2500);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(800);
    const info = await page.evaluate(() => {
      const html = document.documentElement.outerHTML;
      const txt = (document.body.innerText || '').replace(/\n{2,}/g, '\n');
      const greens = document.querySelectorAll('[class*="bg-green-500"]').length;
      const grays = document.querySelectorAll('[class*="bg-gray-900"]').length;
      const playerLinks = [...new Set([...document.querySelectorAll('a[href*="/players/"]')].map(a => a.getAttribute('href')))];
      const hubLinks = [...new Set([...document.querySelectorAll('a[href*="/live-hub"]')].map(a => a.getAttribute('href')))];
      const tabs = [...document.querySelectorAll('[role="tab"], button')].map(b => (b.textContent || '').trim().slice(0, 24)).filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).slice(0, 25);
      const condHits = (txt.match(/goals or assists|clean sheet|of next \d|Win \d|Player of the Month|Team of the Week|Star Performer/gi) || []).slice(0, 12);
      return {
        finalUrl: location.href, title: (document.title || '').slice(0, 120),
        trackerIdCount: document.querySelectorAll('#tracker').length,
        greens, grays, playerLinks: playerLinks.slice(0, 30), playerLinkCount: playerLinks.length,
        hubLinks: hubLinks.slice(0, 20), tabs, condHits,
        text: txt.slice(0, 6000), htmlBytes: html.length
      };
    });
    Object.assign(rec, info);
  } catch (e) { rec.err = 'goto: ' + e.message; }
  if (o.textLen) rec.text = (rec.text || '').slice(0, o.textLen);
  return rec;
}

(async () => {
  console.log('启动 Chromium ...');
  const browser = await chromium.launch({ headless: true, args: ['--disable-blink-features=AutomatedControlled', '--no-sandbox', '--disable-dev-shm-usage'] });
  const ctx = await browser.newContext({ userAgent: UA, locale: 'en-US', viewport: { width: 1280, height: 900 }, timezoneId: 'America/New_York' });
  const page = await ctx.newPage();

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

  // A) dump live-hub API 原始响应（定位 R4 里 featured 为空的原因）
  console.log('\nA) live-hub API 原始响应 ...');
  const lh = await apiGet(page, `${BASE}/live-hub/${VER}/`);
  const A = { status: lh ? lh.status : null, bytes: lh ? lh.body.length : 0, head: '', shape: null, players: [] };
  if (lh && lh.status === 200) {
    A.head = lh.body.slice(0, 1500);
    const j = jget(lh.body);
    A.shape = j ? Object.keys(j).slice(0, 10) : null;
    const rows = (j && j.data && Array.isArray(j.data.players)) ? j.data.players
      : (Array.isArray(j) ? j : (j && Array.isArray(j.players) ? j.players : (j && Array.isArray(j.results) ? j.results : [])));
    A.rowCount = rows.length;
    A.players = rows.slice(0, 8).map(p => ({ eaId: p.eaId != null ? Number(p.eaId) : null, slug: p.slug || '', name: p.name || p.commonName || '' }));
  }
  out.sections.api = A;
  console.log('  status', A.status, 'shape', JSON.stringify(A.shape), 'rows', A.rowCount);
  console.log('  head:', A.head.slice(0, 400));

  // B) live-hub 系页面
  console.log('\nB) live-hub 页面 ...');
  out.sections.pages = [];
  const targets = ['/live-hub/', '/live-hub/campaigns/'];
  for (const t of targets) {
    const rec = await readPage(page, SITE + t);
    rec.path = t;
    out.sections.pages.push(rec);
    console.log(`  ${t} → #t=${rec.trackerIdCount} greens=${rec.greens} pLinks=${rec.playerLinkCount} cond=${(rec.condHits || []).length} ${rec.err || ''}`);
  }

  // C) 进第一个 campaign 页（若 B 里提取到）
  const hubLinks = [];
  for (const p of out.sections.pages) for (const h of (p.hubLinks || [])) if (/\/live-hub\/(campaigns|tracker)/.test(h) && hubLinks.indexOf(h) < 0) hubLinks.push(h);
  out.sections.campaignLinks = hubLinks.slice(0, 10);
  console.log('\nC) campaign 页 ...', hubLinks.slice(0, 5).join(' | '));
  out.sections.campaignPages = [];
  for (const h of hubLinks.slice(0, 3)) {
    const url = h.startsWith('http') ? h : SITE + h;
    const rec = await readPage(page, url);
    rec.path = h;
    out.sections.campaignPages.push(rec);
    console.log(`  ${h} → #t=${rec.trackerIdCount} greens=${rec.greens} pLinks=${rec.playerLinkCount} cond=${(rec.condHits || []).length}`);
  }

  // D) 球员页切 tab：排除「tracker 藏在某个 tab 后面」
  console.log('\nD) 球员页切 tab ...');
  const sample = (A.players && A.players[0] && A.players[0].slug) ? A.players[0].slug : null;
  let slug = sample;
  if (!slug) {
    const r = await apiGet(page, `${BASE}/players/v2/${VER}/?has_dynamic=true&page=1`);
    const arr = (r && r.status === 200 && jget(r.body) && Array.isArray(jget(r.body).data)) ? jget(r.body).data : [];
    if (arr.length) slug = arr[0].slug;
  }
  const D = { slug, url: null, tabs: [], hits: [] };
  if (slug) {
    D.url = `${SITE}/players/${slug}/`;
    try {
      await page.goto(D.url, { waitUntil: 'domcontentloaded', timeout: 40000 });
      await page.waitForTimeout(2500);
      const tabs = await page.evaluate(() => [...document.querySelectorAll('[role="tab"], a[href^="#"], button')].map(b => (b.textContent || '').trim().slice(0, 24)).filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).slice(0, 20));
      D.tabs = tabs;
      for (const t of tabs.slice(0, 12)) {
        try {
          const loc = page.locator(`text=${JSON.stringify(t)}`).first();
          if (await loc.count() === 0) continue;
          await loc.click({ timeout: 4000 });
          await page.waitForTimeout(1200);
          const c = await page.evaluate(() => ({ n: document.querySelectorAll('#tracker').length, greens: document.querySelectorAll('[class*="bg-green-500"]').length }));
          D.hits.push({ tab: t, tracker: c.n, greens: c.greens });
          console.log(`  tab "${t}" → #tracker=${c.n} greens=${c.greens}`);
        } catch (e) { D.hits.push({ tab: t, err: e.message.slice(0, 60) }); }
      }
    } catch (e) { D.err = e.message; }
  }
  out.sections.playerTabs = D;

  const anyHit = out.sections.pages.some(p => p.trackerIdCount > 0) || out.sections.campaignPages.some(p => p.trackerIdCount > 0) || (D.hits || []).some(h => h.tracker > 0);
  out.note = anyHit ? 'HIT: 至少一处渲染出 #tracker' : 'MISS: 仍未渲染出 #tracker（见 sections.pages[].text 判断页面到底展示了什么）';
  clearTimeout(watchdog);
  await browser.close();
  dump();
  console.log('\n===== ' + out.note + ' =====');
  process.exit(0);
})().catch(e => { console.error('ERR', e); out.note = 'ERR ' + e.message; dump(); process.exit(1); });
