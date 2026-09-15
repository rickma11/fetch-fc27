// 探查 fut.gg 的 SBC / Evolutions 数据来源（第七轮：客户端路由 + 抓真实数据请求）。
//
// 背景 / 教训：
//   - fut.gg 是 Next.js SPA。/evolutions、/sbc 的数据由 React Query 钩子在客户端拉取，
//     不在服务端 HTML 内嵌（page.goto 后 HTML 只是空壳）。
//   - 必须真正导航到路由（page.goto），让 React 组件挂载、React Query 发起真实请求，
//     再用 response 监听器捕获那个请求 + 抓该路由专属 chunk 源码 grep endpoint。
//   - CF cookie 在 context 内持久化，子路由不再二次挑战（前几轮已验证 fetch('/evolutions') 返回 200）。
//
// 输出：probe/probe_sbc_evolution.json
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const VER = Number(process.env.FC_VER || 27);
const UA = process.env.CF_UA || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36';

(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox', '--disable-dev-shm-usage']
  });
  const ctx = await browser.newContext({
    userAgent: UA, locale: 'en-US', viewport: { width: 1280, height: 800 }, timezoneId: 'America/New_York'
  });
  const page = await ctx.newPage();
  page.on('console', m => { const t = m.text(); if (/error|404|fail|redirect/i.test(t)) console.log('[browser]', t.slice(0, 160)); });

  // 捕获所有响应（不限 host），用于发现真实数据接口（可能不在 fut.gg/api 下）
  const allResponses = [];      // {url, status, host, len}
  const seenResp = new Set();
  // 捕获所有 .js bundle 源码，grep endpoint
  const bundleSources = [];     // {url, len, apiPaths:[], evoCtx:[]}
  const seenBundle = new Set();

  const isJs = (u, ct) => (u.toLowerCase().endsWith('.js') || (ct || '').includes('javascript'));

  page.on('response', async (resp) => {
    const u = resp.url();
    // 记录所有响应（去重），尤其留意含 evolution/sbc/challenge 的 URL 或大 JSON
    if (!seenResp.has(u)) {
      seenResp.add(u);
      const status = resp.status();
      try { allResponses.push({ url: u, status, host: new URL(u).host, len: Number(resp.headers()['content-length'] || 0) }); } catch (e) {}
    }
    // 抓 JS bundle 源码
    if (isJs(u, resp.headers()['content-type'])) {
      if (seenBundle.has(u)) return; seenBundle.add(u);
      try {
        const t = await resp.text();
        const apiPaths = [...new Set((t.match(/\/api\/[A-Za-z0-9_./{}$-]+/g) || []))];
        // 找 useGetTrendingEvolutions / useGetSbcSetList 等钩子附近的 fetch 路径
        const evoCtx = [];
        for (const kw of ['useGetTrendingEvolutions', 'useGetSbcSet', 'getSbcSetList', 'evolution-list', 'EvolutionList', 'sbc-challenges', 'SbcChallenge', 'useGetEvolutions']) {
          const idx = t.indexOf(kw);
          if (idx >= 0) {
            const slice = t.slice(idx - 200, idx + 300).replace(/\s+/g, ' ');
            evoCtx.push({ kw, ctx: slice.slice(0, 400) });
          }
        }
        if (apiPaths.length || evoCtx.length) {
          bundleSources.push({ url: u, len: t.length, apiPaths: apiPaths.slice(0, 80), evoCtx });
          console.log('[bundle]', u.split('/').pop(), '| apiPaths:', apiPaths.slice(0, 30).join(' '));
          for (const e of evoCtx) console.log('   ctx', e.kw, '=>', e.ctx.slice(0, 300));
        }
      } catch (e) {}
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

  // 真正导航到客户端路由，等 React Query 发起真实数据请求
  for (const route of ['/evolutions', '/sbc']) {
    try {
      console.log(`\n=== 导航 ${route} ===`);
      await page.goto(`https://www.fut.gg${route}`, { waitUntil: 'networkidle', timeout: 60000 });
      await page.waitForTimeout(9000); // 等 React Query 真正发起请求
      const title = await page.title();
      console.log(`  已加载 title="${title}"`);
    } catch (e) { console.log('  导航失败:', e.message); }
  }

  // 汇总
  const futApiResponses = allResponses.filter(r => /fut\.gg\/api/i.test(r.url));
  const evoSbcResponses = allResponses.filter(r => /evolution|sbc|challenge/i.test(r.url));
  const allApiPaths = [...new Set(bundleSources.flatMap(b => b.apiPaths))].sort();

  const result = {
    ver: VER,
    futApiResponses,
    evoSbcResponseUrls: evoSbcResponses.map(r => ({ url: r.url, status: r.status, len: r.len })),
    bundleApiPaths: allApiPaths,
    bundleHooks: bundleSources.flatMap(b => b.evoCtx),
    allResponseCount: allResponses.length
  };
  const outDir = path.resolve(__dirname, '..', 'probe');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, 'probe_sbc_evolution.json');
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2));

  console.log('\n===== fut.gg/api 真实响应 =====');
  console.log(JSON.stringify(futApiResponses, null, 2));
  console.log('\n===== 含 evolution/sbc/challenge 的响应 URL =====');
  console.log(JSON.stringify(evoSbcResponses.map(r => r.url), null, 2));
  console.log('\n===== bundle 内 /api/ 路径 =====');
  console.log(JSON.stringify(allApiPaths, null, 2));
  console.log('\n已写出', outPath);
  await browser.close();
})().catch(e => { console.error('探查失败:', e); process.exit(1); });
