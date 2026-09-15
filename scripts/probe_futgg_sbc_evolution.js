// 探查 fut.gg 的 SBC / Evolutions 数据来源（第八轮：主动抓取路由 chunk 源码 grep 真实端点）。
//
// 前七轮教训：
//   - /evolutions、/sbc 是 SPA 客户端渲染：数据由 React Query 在客户端拉，不在服务端 HTML。
//   - bundle 里只有 React Query 钩子名（useGetTrendingEvolutions、getSbcSetListDerived），
//     真实 /api/ 路径藏在路由专属 chunk（assets/evolutions-*.js、SbcSet-*.js 等）里，
//     但 response 监听器漏抓了这些 chunk（缓存/异步 text 被吞）。
// 本轮：CF 通关后主动 page.request.fetch 抓 chunk 源码（同源带 cookie，不会被 CF 二次挑战），
//       直接 grep 出真实 /api/ 端点与带版本的 URL 模板。
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

  const apiHits = new Map();   // url -> {apiPaths:[], futCtx:[]}
  const fetchChunk = async (url) => {
    if (apiHits.has(url)) return;
    try {
      const r = await page.request.fetch(url, { headers: { Accept: '*/*' } });
      if (r.status() !== 200) { apiHits.set(url, { skipped: r.status() }); return; }
      const t = await r.text();
      const apiPaths = [...new Set((t.match(/\/api\/[A-Za-z0-9_./{}$-]+/g) || []))];
      // 找 fut/ 开头的 URL 模板（含版本占位）
      const futPaths = [...new Set((t.match(/fut\/[A-Za-z0-9_./{}$-]+/g) || []))];
      // 钩子/fetch 附近上下文
      const futCtx = [];
      for (const kw of ['useGetTrendingEvolutions', 'useGetSbc', 'getSbcSetList', 'evolution-list', 'EvolutionList', 'sbc-challenges', 'SbcChallenge', 'useGetEvolutions', 'fetchEvolution', 'fetchSbc']) {
        let idx = t.indexOf(kw);
        if (idx >= 0) futCtx.push({ kw, ctx: t.slice(idx - 120, idx + 200).replace(/\s+/g, ' ') });
      }
      apiHits.set(url, { len: t.length, apiPaths: apiPaths.slice(0, 60), futPaths: futPaths.slice(0, 40), futCtx });
      console.log('[chunk]', url.split('/').pop(), '| status 200 | apiPaths:', apiPaths.slice(0, 20).join(' '));
      for (const c of futCtx) console.log('   ctx', c.kw, '=>', c.ctx.slice(0, 260));
    } catch (e) { apiHits.set(url, { err: String(e).slice(0, 120) }); }
  };

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

  // 导航到两个路由，让所有相关 chunk 加载
  for (const route of ['/evolutions', '/sbc']) {
    try {
      console.log(`\n=== 导航 ${route} 收集 chunk ===`);
      await page.goto(`https://www.fut.gg${route}`, { waitUntil: 'networkidle', timeout: 60000 });
      await page.waitForTimeout(4000);
    } catch (e) { console.log('  导航失败:', e.message); }
  }

  // 收集页面加载过的所有 JS chunk URL（去重）
  const scriptSrcs = await page.evaluate(() => {
    const s = new Set();
    document.querySelectorAll('script[src]').forEach(el => s.add(el.src));
    return [...s];
  });
  // 也加首页加载时抓到的（通过临时监听整页脚本——此处用 evaluate 兜底：再回首页收集）
  console.log(`\n=== 共收集 ${scriptSrcs.length} 个 script src，开始 grep 进化/SBC 相关 chunk ===`);

  // 优先抓含 evolution/sbc 关键字的 chunk
  const priority = scriptSrcs.filter(u => /evolution|sbc|Evolution|Sbc/i.test(u));
  const rest = scriptSrcs.filter(u => !/evolution|sbc|Evolution|Sbc/i.test(u));
  for (const u of [...priority, ...rest]) {
    if (apiHits.has(u)) continue;
    await fetchChunk(u);
  }

  // 汇总：只保留含 fut/ 或 api/ 路径的 chunk
  const useful = {};
  for (const [url, v] of apiHits) {
    if (v.apiPaths && v.apiPaths.length) useful[url.split('/').pop()] = v;
  }
  const allApiPaths = [...new Set(Object.values(useful).flatMap(v => v.apiPaths || []))].sort();
  const allFutPaths = [...new Set(Object.values(useful).flatMap(v => v.futPaths || []))].sort();

  const result = {
    ver: VER,
    chunkCount: scriptSrcs.length,
    usefulChunks: Object.keys(useful),
    allApiPaths,
    allFutPaths,
    hookContext: Object.values(useful).flatMap(v => v.futCtx || [])
  };
  const outDir = path.resolve(__dirname, '..', 'probe');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, 'probe_sbc_evolution.json');
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2));

  console.log('\n===== 全部 /api/ 路径（去重）=====');
  console.log(JSON.stringify(allApiPaths, null, 2));
  console.log('\n===== 全部 fut/ 路径模板（去重）=====');
  console.log(JSON.stringify(allFutPaths, null, 2));
  console.log('\n已写出', outPath);
  await browser.close();
})().catch(e => { console.error('探查失败:', e); process.exit(1); });
