// 探查 fut.gg 的 SBC / Evolutions 数据来源（第九轮：提取 RSC 服务端渲染数据流）。
//
// 关键假设：前八轮发现 React Query 钩子（useGetEvolutions / useGetSbcSets / getSbcSetListDerived）
// 首屏 enabled 依赖 tab/SSR，且 r8 的 368 个响应里没有 evolution/sbc 的客户端 API 调用
// => 数据大概率是 Next.js App Router 的 RSC 数据流（self.__next_f.push 脚本）服务端渲染进 HTML 的。
// 之前 r5 只查了 __NEXT_DATA__（false），漏了 RSC 分块。本轮专门抽取 RSC 文本，grep 数据标记。
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

  const rscChunks = [];   // 收集 self.__next_f.push 文本
  page.on('script', async (script) => {
    const src = script.src();
    if (src) return; // 只抓内联脚本
    try {
      const txt = await script.textContent();
      if (txt && txt.includes('__next_f')) rscChunks.push(txt);
    } catch (e) {}
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

  const result = { ver: VER, pages: {} };
  for (const route of ['/evolutions', '/sbc']) {
    console.log(`\n=== 导航 ${route} 抽取 RSC ===`);
    try {
      await page.goto(`https://www.fut.gg${route}`, { waitUntil: 'networkidle', timeout: 60000 });
      await page.waitForTimeout(6000);
    } catch (e) { console.log('  导航失败:', e.message); }
    // 直接读 DOM 里的所有 script（含 RSC），用 evaluate 抓全文
    const html = await page.content();
    const scripts = await page.evaluate(() => {
      const out = [];
      document.querySelectorAll('script').forEach(s => { if (s.textContent) out.push(s.textContent); });
      return out;
    });
    const all = scripts.join('\n');
    // 数据标记
    const markers = {
      endtime: (all.match(/"endtime"/g) || []).length,
      claim_endtime: (all.match(/"claim_endtime"/g) || []).length,
      sbcScoreRequirement: (all.match(/sbcScoreRequirement/g) || []).length,
      evolutionsArr: (all.match(/"evolutions"/g) || []).length,
      sbcsArr: (all.match(/"sbcs"/g) || []).length,
      isSbc: (all.match(/isSbc/g) || []).length,
      next_f_push: (all.match(/__next_f/g) || []).length,
      nextData: (all.match(/__NEXT_DATA__/g) || []).length,
    };
    // 抽取含 evolution/sbc 的 RSC 片段样本
    const samples = [];
    const re = /(?:sbc|evolution|evolutions|challenge)["'\s:]+/gi;
    let m; let n = 0;
    while ((m = re.exec(all)) && n < 8) {
      samples.push(all.slice(m.index - 80, m.index + 160).replace(/\s+/g, ' '));
      n++;
    }
    result.pages[route] = {
      htmlLen: html.length,
      totalScriptLen: all.length,
      markers,
      samples
    };
    console.log(`  markers:`, JSON.stringify(markers));
    for (const s of samples) console.log('   sample:', s.slice(0, 200));
  }

  const outDir = path.resolve(__dirname, '..', 'probe');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, 'probe_sbc_evolution.json');
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
  console.log('\n已写出', outPath);
  await browser.close();
})().catch(e => { console.error('探查失败:', e); process.exit(1); });
