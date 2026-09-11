// 用 Playwright 的真实 Chromium（TLS 指纹正确）绕过 Cloudflare Managed Challenge，
// 在 fut.gg 页面同源内用浏览器原生 fetch 抓全量 FC27 数据，落盘为 fc27_dump.json。
// 之后由 scripts/fetch_futgg.js --from-dump 做离线成型（不发任何网络请求）。
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const VER = 27;
const BASE = `https://www.fut.gg/api/fut/players/v2/${VER}/`;
const DET = `https://www.fut.gg/api/fut/player-item-definitions/${VER}/`;
const OUT = path.resolve(__dirname, '..', 'fc27_dump.json');

// 跟随用户真实浏览器（Chrome/147），提升过 Cloudflare 的成功率
const UA = process.env.CF_UA || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36';

(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox', '--disable-dev-shm-usage']
  });
  const ctx = await browser.newContext({
    userAgent: UA,
    locale: 'en-US',
    viewport: { width: 1280, height: 800 },
    timezoneId: 'America/New_York'
  });
  const page = await ctx.newPage();
  // 把浏览器内 console 转发出来，便于观察进度
  page.on('console', m => console.log('[browser]', m.text()));

  console.log('打开 fut.gg 过 Cloudflare ...');
  await page.goto('https://www.fut.gg/', { waitUntil: 'domcontentloaded', timeout: 60000 });

  // 等待 Cloudflare 放行：轮询同源 API 直到返回 200。
  // 注意 cf_clearance 是 HttpOnly cookie，document.cookie 读不到，只能靠实际请求探测。
  let passed = false;
  for (let i = 0; i < 30; i++) {
    let status = 0;
    try {
      status = await page.evaluate(async (u) => {
        try { const r = await fetch(u, { headers: { Accept: 'application/json' } }); return r.status; }
        catch (e) { return -1; }
      }, `${BASE}?page=1`);
    } catch (e) { status = -2; }
    if (status === 200) { passed = true; console.log(`Cloudflare 已通过（第 ${i + 1} 次尝试）`); break; }
    console.log(`等待 Cloudflare 挑战解除... status=${status} (${i + 1}/30)`);
    await page.waitForTimeout(3000);
  }
  if (!passed) {
    await browser.close();
    console.error('未能通过 Cloudflare（可能弹了交互式验证），退出');
    process.exit(1);
  }

  const result = await page.evaluate(async ({ BASE, DET }) => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const players = [], seen = new Set();
    for (let pg = 1; pg <= 999; pg++) {
      const res = await fetch(`${BASE}?page=${pg}`, { headers: { 'Accept': 'application/json' } });
      if (!res.ok) { console.log('列表第', pg, '页失败 status=', res.status); break; }
      const j = await res.json();
      if (!j.data || !Array.isArray(j.data) || j.data.length === 0) { console.log('列表第', pg, '页为空，到达末页'); break; }
      for (const it of j.data) if (!seen.has(it.eaId)) { seen.add(it.eaId); players.push(it); }
      console.log('列表 page', pg, '累计', players.length, '人');
      await sleep(300);
    }
    const details = {};
    for (let i = 0; i < players.length; i++) {
      const p = players[i];
      try {
        const r = await fetch(`${DET}${p.eaId}/`, { headers: { 'Accept': 'application/json' } });
        details[p.eaId] = r.ok ? await r.json() : { data: p };
      } catch (e) { details[p.eaId] = { data: p }; }
      if (i % 25 === 0 || i === players.length - 1) console.log('详情', i + 1, '/', players.length);
      await sleep(250);
    }
    return { players, details };
  }, { BASE, DET });

  fs.writeFileSync(OUT, JSON.stringify(result));
  console.log('写入', OUT, '共', result.players.length, '名球员');
  await browser.close();
})().catch(e => { console.error('抓取失败:', e); process.exit(1); });
