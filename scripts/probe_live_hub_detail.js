// 只读诊断探针（第 6 轮）：**campaign 页结构化提取** —— 目标就是拿到「逐球员的升级条件 + 真实进度」。
//
// 前 5 轮结论：
//   R1-R4: 球员详情页 /players/<slug>/ 渲染后**没有** #tracker（页面里的 Live Hub 只是导航栏链接）。
//   R5: ★突破★ `/live-hub/campaigns/<slug>/` 页面有真内容：
//       · /live-hub/campaigns/ 列出 campaigns：destined-for-glory / ones-to-watch / fantasy-fc …
//       · /live-hub/campaigns/ones-to-watch/   → 9 个 /players/ 链接、绿条 3 个、条件文案命中 12 条
//       · /live-hub/campaigns/destined-for-glory/ → 同上
//       ⇒ 升级条件/进度真源在 **campaign 页**，不是球员页。
//
// 本轮：把 campaign 页里「每张球员卡」结构化抽出来（球员链接 + 卡片文本 + 绿条/灰条段数），
//       同时探测是否有 SSR 直出的 JSON（playerValue / objectives），为落地解析选路。
// 结果落盘 probe/live_hub/detail_probe.json（同时由 workflow 上传 artifact）。
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
const out = { generatedAt: new Date().toISOString(), VER, round: 6, note: '', sections: {} };
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

// 结构化提取 campaign 页里每张球员卡
async function extractCampaign(page, url) {
  const rec = { url, err: '', cards: [] };
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 40000 });
    await page.waitForTimeout(2500);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(3000);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(1000);
    const info = await page.evaluate(() => {
      const seen = new Set();
      const cards = [];
      const links = [...document.querySelectorAll('a[href*="/players/"]')];
      for (const a of links) {
        const href = a.getAttribute('href') || '';
        if (seen.has(href)) continue;
        // 向上找「只包含这一张球员卡」的最小容器
        let el = a;
        for (let i = 0; i < 8 && el; i++) {
          el = el.parentElement;
          if (!el) break;
          if (el.querySelectorAll('a[href*="/players/"]').length <= 1) break;
        }
        if (!el) continue;
        seen.add(href);
        const txt = (el.innerText || '').trim().replace(/\s*\n+\s*/g, ' | ').slice(0, 500);
        cards.push({
          href,
          text: txt,
          greens: el.querySelectorAll('[class*="bg-green-500"]').length,
          grays: el.querySelectorAll('[class*="bg-gray-900"]').length
        });
      }
      const html = document.documentElement.outerHTML;
      const txtPage = (document.body.innerText || '').replace(/\n{2,}/g, '\n');
      return {
        finalUrl: location.href, title: (document.title || '').slice(0, 120),
        cards,
        playerValueHits: (html.match(/playerValue/g) || []).length,
        objectivesHits: (html.match(/objectives/g) || []).length,
        htmlBytes: html.length,
        text: txtPage.slice(0, 5000)
      };
    });
    Object.assign(rec, info);
  } catch (e) { rec.err = 'goto: ' + e.message; }
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

  // ① 列出所有 campaign
  console.log('\n① /live-hub/campaigns/ ...');
  const idx = await extractCampaign(page, SITE + '/live-hub/campaigns/');
  const slugs = [...new Set((idx.text.match(/(?:\/live-hub\/campaigns\/)([a-z0-9-]+)/g) || []).map(s => s.split('/').filter(Boolean).pop()))];
  const hubLinks = (idx.cards || []).length ? [] : [];
  out.sections.index = { url: idx.url, title: idx.title, text: (idx.text || '').slice(0, 1500) };
  // 从 DOM 直接取 campaign 链接更可靠
  await page.goto(SITE + '/live-hub/campaigns/', { waitUntil: 'domcontentloaded', timeout: 40000 });
  await page.waitForTimeout(2000);
  const campLinks = await page.evaluate(() => [...new Set([...document.querySelectorAll('a[href*="/live-hub/campaigns/"]')].map(a => a.getAttribute('href')))]);
  const camps = [...new Set(campLinks.map(h => (h.split('/').filter(Boolean).pop() || '')))] .filter(Boolean);
  out.sections.campaigns = camps;
  console.log('  campaigns:', camps.join(' | '));

  // ② 逐个 campaign 页结构化提取
  console.log('\n② campaign 页结构化提取 ...');
  out.sections.pages = [];
  for (const c of camps.slice(0, 6)) {
    const url = `${SITE}/live-hub/campaigns/${c}/`;
    const rec = await extractCampaign(page, url);
    rec.campaign = c;
    out.sections.pages.push(rec);
    console.log(`  ${c} → cards=${rec.cards.length} greens=${rec.cards.reduce((a, x) => a + x.greens, 0)} playerValueHits=${rec.playerValueHits} ${rec.err || ''}`);
    for (const card of (rec.cards || []).slice(0, 3)) console.log(`      · ${card.href} g=${card.greens}/${card.greens + card.grays} :: ${card.text.slice(0, 150)}`);
  }

  // ③ 顺带看看有没有 campaign 级 API（比解析 HTML 稳）
  console.log('\n③ campaign API 候选 ...');
  out.sections.apiTries = [];
  const c0 = camps[0] || 'ones-to-watch';
  const tries = [
    `${BASE}/live-hub/${VER}/campaigns/${c0}/`,
    `${BASE}/live-hub/campaigns/${c0}/?game=${VER}`,
    `${BASE}/live-hub/${VER}/?campaign=${c0}`,
    `${BASE}/live-hub/${VER}/${c0}/`
  ];
  for (const u of tries) {
    const r = await apiGet(page, u);
    const ok = r && r.status === 200 && r.body.length > 100;
    out.sections.apiTries.push({ url: u, status: r ? r.status : null, bytes: r ? r.body.length : 0, head: ok ? r.body.slice(0, 300) : '' });
    console.log(`  ${u} → ${r ? r.status : 'null'} ${r ? r.body.length : 0}B`);
  }

  const totalCards = out.sections.pages.reduce((a, p) => a + (p.cards || []).length, 0);
  out.note = totalCards > 0 ? `HIT: campaign 页共提取 ${totalCards} 张球员卡` : 'MISS: campaign 页未提取到球员卡';
  clearTimeout(watchdog);
  await browser.close();
  dump();
  console.log('\n===== ' + out.note + ' =====');
  process.exit(0);
})().catch(e => { console.error('ERR', e); out.note = 'ERR ' + e.message; dump(); process.exit(1); });
