// 探查 fut.gg 的 SBC / Evolutions 数据端点（第十轮：拦截真实 XHR + 反查 bundle 路径常量）。
//
// 前九轮结论：fut.gg /evolutions 与 /sbc 是纯客户端渲染，HTML 里完全不内嵌数据（RSC / __NEXT_DATA__ 标记全 0）。
// 数据由 React Query 在浏览器里向埋在 bundle 中的端点实时请求。本轮用「请求/响应拦截 + bundle 反查」坐实端点 URL。
//
// 输出：probe/probe_sbc_evolution.json
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const https = require('https');

const VER = Number(process.env.FC_VER || 27);
const UA = process.env.CF_UA || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36';

function httpsGet(url, headers = {}, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': UA, ...headers } }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8'), ct: res.headers['content-type'] || '' }));
    });
    req.on('error', reject);
    req.setTimeout(timeout, () => req.destroy(new Error('timeout')));
  });
}

(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox', '--disable-dev-shm-usage']
  });
  const ctx = await browser.newContext({
    userAgent: UA, locale: 'en-US', viewport: { width: 1280, height: 800 }, timezoneId: 'America/New_York'
  });
  const page = await ctx.newPage();

  const apiRequests = [];   // 所有发往 fut.gg 且像 API 的请求 URL
  const apiResponses = [];  // 所有 JSON /api 响应（含样本）

  page.on('request', req => {
    const u = req.url();
    if (u.includes('fut.gg') && (u.includes('/api/') || u.includes('/api'))) {
      apiRequests.push({ method: req.method(), url: u, type: req.resourceType() });
    }
  });
  page.on('response', async resp => {
    const u = resp.url();
    if (!u.includes('fut.gg')) return;
    const ct = resp.headers()['content-type'] || '';
    if (ct.includes('json') || u.includes('/api')) {
      const rec = { url: u, status: resp.status(), ct, len: 0, hit: false, sample: '' };
      try {
        const buf = await resp.body();
        rec.len = buf.length;
        const txt = buf.toString('utf8');
        if (/evolution|sbc|challenge|sbcs/i.test(txt) && txt.length > 100) {
          rec.hit = true;
          rec.sample = txt.slice(0, 600);
        }
      } catch (e) {}
      apiResponses.push(rec);
    }
  });

  console.log('打开 fut.gg 过 Cloudflare ...');
  await page.goto('https://www.fut.gg/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  const BASE = `https://www.fut.gg/api/fut/players/v2/${VER}/`;
  let passed = false;
  for (let i = 0; i < 30; i++) {
    let status = 0;
    try {
      status = await page.evaluate(async (u) => {
        try { const r = await fetch(u, { headers: { Accept: 'application/json' } }); return r.status; } catch (e) { return -1; }
      }, `${BASE}?page=1`);
    } catch (e) { status = -2; }
    if (status === 200) { passed = true; console.log(`Cloudflare 已通过（第 ${i + 1} 次）`); break; }
    console.log(`等待 CF 解除... status=${status} (${i + 1}/30)`);
    await page.waitForTimeout(3000);
  }
  if (!passed) { await browser.close(); console.error('未能过 Cloudflare'); process.exit(1); }

  const result = { ver: VER, routes: {}, bundleGrep: { scriptSrcs: [], hits: [] } };

  for (const route of ['/evolutions', '/sbc']) {
    const before = apiResponses.length;
    console.log(`\n=== 导航 ${route} ===`);
    try {
      await page.goto(`https://www.fut.gg${route}`, { waitUntil: 'networkidle', timeout: 60000 });
      await page.waitForTimeout(8000);
    } catch (e) { console.log('  导航失败:', e.message); }
    // 再触发一次滚动/点击，防某些 hook 依赖交互才 enabled
    try { await page.mouse.wheel(0, 600); await page.waitForTimeout(3000); } catch (e) {}
    const newResp = apiResponses.slice(before);
    result.routes[route] = {
      capturedResponses: newResp.map(r => ({ url: r.url, status: r.status, len: r.len, hit: r.hit })),
      hitSamples: newResp.filter(r => r.hit).map(r => r.sample)
    };
    console.log(`  ${route} 捕获 ${newResp.length} 个 API 响应，命中 ${newResp.filter(r => r.hit).length} 个`);
  }

  // 全量 API 请求汇总（去重）
  const reqSet = new Set();
  result.allApiRequests = apiRequests.filter(r => { if (reqSet.has(r.url)) return false; reqSet.add(r.url); return true; }).map(r => r.url);

  // bundle 反查：抓首页 HTML 里的 script src，下载后 grep 路径常量
  console.log('\n=== 反查主 bundle ===');
  try {
    const html = await page.content();
    const srcs = [...html.matchAll(/src="([^"]+\.js[^"]*)"/g)].map(m => m[1]);
    const abs = srcs.map(s => s.startsWith('http') ? s : (s.startsWith('//') ? 'https:' + s : 'https://www.fut.gg' + s));
    result.bundleGrep.scriptSrcs = abs.slice(0, 40);
    for (const s of abs) {
      if (result.bundleGrep.hits.length > 30) break;
      try {
        const r = await httpsGet(s, {}, 20000);
        if (r.status !== 200 || r.body.length < 1000) continue;
        // 找 /api/fut/ 形式的路径片段
        const m = r.body.match(/["'`](\/api\/fut\/[^"'`]+)["'`]/g);
        if (m) {
          const uniq = [...new Set(m.map(x => x.slice(1, -1)))];
          for (const p of uniq) result.bundleGrep.hits.push({ src: s, path: p });
        }
        // 也找含 evolutions/sbc 的 fetch 模板
        const m2 = r.body.match(/(?:evolutions|sbc|sbcs|challenges)["'`\s:]*["'`]([^"'`]+)["'`]/gi);
        if (m2) for (const x of [...new Set(m2)].slice(0, 10)) result.bundleGrep.hits.push({ src: s, snippet: x });
      } catch (e) { /* ignore */ }
    }
  } catch (e) { console.log('  bundle 反查失败:', e.message); }

  const outDir = path.resolve(__dirname, '..', 'probe');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, 'probe_sbc_evolution.json');
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
  console.log('\n已写出', outPath);
  await browser.close();
})().catch(e => { console.error('探查失败:', e); process.exit(1); });
