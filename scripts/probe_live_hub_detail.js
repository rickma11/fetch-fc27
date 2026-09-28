// 只读诊断探针（第 7 轮）：**campaign 子页（players/ / upgrades/）** —— 找逐球员升级条件 + 真实进度。
//
// 前 6 轮结论：
//   R1-R4: 球员详情页无 #tracker。
//   R5: campaign 页 /live-hub/campaigns/<slug>/ 有真内容（条件文案 12 条命中、绿条 3）。
//   R6: ★ campaign 页有子页签 **OVERVIEW | PLAYERS | FIXTURES | UPGRADES**：
//        · campaigns = destined-for-glory / ones-to-watch（27- 前缀＝FC27）/ fantasy-fc / thunderstruck /
//          primetime / fc-pro / path-to-glory / road-to-the-final（多为 26- 前缀＝FC26 历史）
//        · overview 页上的球员卡**只是图片链接**（无文本、无进度条）⇒ 数据在子页
//        · playerValueHits=0 ⇒ 页面 HTML 没有 SSR 直出 JSON，只能解析渲染后 DOM
//
// 本轮：对 FC27 相关 campaign 逐个访问 <camp>/players/ 与 <camp>/upgrades/，
//       统计 27- 前缀球员链接数、绿条段数，并 dump 页面可见文本（人眼可读，判断展示口径）。
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
const out = { generatedAt: new Date().toISOString(), VER, round: 7, note: '', sections: {} };
function dump() {
  try {
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, 'detail_probe.json'), JSON.stringify(out, null, 2));
  } catch (e) { console.log('dump err', e.message); }
}
const watchdog = setTimeout(() => { out.note = 'WATCHDOG TIMEOUT（部分结果）'; dump(); console.error('WATCHDOG TIMEOUT'); process.exit(5); }, HARD_TIMEOUT_MS);

async function readPage(page, url) {
  const rec = { url, err: '' };
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 40000 });
    await page.waitForTimeout(2500);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(3000);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(800);
    const info = await page.evaluate(VERJS => {
      const html = document.documentElement.outerHTML;
      const txt = (document.body.innerText || '').replace(/\n{2,}/g, '\n');
      const all = [...document.querySelectorAll('a[href*="/players/"]')].map(a => a.getAttribute('href') || '');
      const itemLinks = all.filter(h => /\/players\/[^/]+\/\d+-\d+\//.test(h));
      const verLinks = itemLinks.filter(h => h.indexOf('/' + VERJS + '-') >= 0);
      // 球员卡：向上走到「有文本」的容器
      const cards = [];
      const seen = new Set();
      for (const href of itemLinks) {
        if (seen.has(href)) continue;
        seen.add(href);
        const a = document.querySelector(`a[href="${href.replace(/"/g, '\\"')}"]`);
        if (!a) continue;
        let el = a;
        for (let i = 0; i < 8 && el; i++) {
          el = el.parentElement;
          if (!el) break;
          if ((el.innerText || '').trim().length > 15) break;
        }
        if (!el) continue;
        cards.push({
          href,
          text: (el.innerText || '').trim().replace(/\s*\n+\s*/g, ' | ').slice(0, 400),
          greens: el.querySelectorAll('[class*="bg-green-500"]').length,
          grays: el.querySelectorAll('[class*="bg-gray-900"]').length
        });
      }
      return {
        finalUrl: location.href, title: (document.title || '').slice(0, 120),
        itemLinkCount: itemLinks.length, verLinkCount: verLinks.length,
        links27: verLinks.slice(0, 30),
        greensTotal: document.querySelectorAll('[class*="bg-green-500"]').length,
        cards: cards.slice(0, 12),
        text: txt.slice(0, 4000), htmlBytes: html.length
      };
    }, VER);
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

  const CAMPS = ['ones-to-watch', 'destined-for-glory', 'fantasy-fc', 'thunderstruck', 'primetime', 'fc-pro', 'path-to-glory', 'road-to-the-final'];
  out.sections.campaigns = CAMPS;
  out.sections.pages = [];
  for (const c of CAMPS) {
    for (const sub of ['players', 'upgrades']) {
      const url = `${SITE}/live-hub/campaigns/${c}/${sub}/`;
      const rec = await readPage(page, url);
      rec.campaign = c; rec.sub = sub;
      out.sections.pages.push(rec);
      console.log(`  ${c}/${sub} → items=${rec.itemLinkCount} 27x=${rec.verLinkCount} greens=${rec.greensTotal} cards=${(rec.cards || []).length} ${rec.err || ''}`);
      for (const card of (rec.cards || []).slice(0, 2)) console.log(`      · ${card.href} g=${card.greens}/${card.greens + card.grays} :: ${card.text.slice(0, 160)}`);
    }
  }

  const hit = out.sections.pages.filter(p => (p.verLinkCount || 0) > 0 && (p.greensTotal || 0) > 0);
  out.note = hit.length ? `HIT: ${hit.length} 个子页同时含 FC27 球员链接与绿条（如 ${hit[0].campaign}/${hit[0].sub}）` : 'MISS: 子页未见 FC27 球员+绿条组合';
  clearTimeout(watchdog);
  await browser.close();
  dump();
  console.log('\n===== ' + out.note + ' =====');
  process.exit(0);
})().catch(e => { console.error('ERR', e); out.note = 'ERR ' + e.message; dump(); process.exit(1); });
