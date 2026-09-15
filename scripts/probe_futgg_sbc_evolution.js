// 探查 fut.gg 的 SBC / Evolutions 数据来源（第四轮：抓 HTML 内嵌的 Next.js 数据）。
//
// 前三轮教训：
//   ① 猜的 /api/ 端点全 404（连页面「自己请求过」的也 404）→ 路径不对。
//   ② 监听 XHR response 也抓不到：/evolutions、/sbc 页面在加载期间根本不发起 fut.gg/api 请求
//      （只有球员列表页会调 /api/fut/players/v2/26/）。说明 SBC/进化数据是**服务端渲染进 HTML** 的。
//
// 本版做法（确定性）：过 CF 后，对 /evolutions、/sbc、/squad-building-challenges 各页：
//   1. 取 page.content() 完整 HTML
//   2. 抽取 __NEXT_DATA__（JSON）与 self.__next_f.push(...) 分块（Next.js RSC 数据流，含真实数据）
//   3. 在其中检索 evolution / sbc / challenge 相关字段，打印结构 + 样本
//   4. 同时记录导航期间所有（不限 host）响应 URL，看清真实请求了哪些地址
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
  page.on('console', m => { const t = m.text(); if (/error|404|fail/i.test(t)) console.log('[browser]', t.slice(0, 200)); });

  // 记录所有响应 URL（不限 host），看清真实请求了哪些地址
  const allResponses = [];
  const seenResp = new Set();
  page.on('response', async (resp) => {
    const u = resp.url();
    if (seenResp.has(u)) return; seenResp.add(u);
    allResponses.push({ url: u, status: resp.status() });
  });

  console.log('打开 fut.gg 过 Cloudflare ...');
  await page.goto('https://www.fut.gg/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  const BASE = `https://www.fut.gg/api/fut/players/v2/${VER}/`;
  let passed = false;
  for (let i = 0; i < 30; i++) {
    let status = 0;
    try {
      status = await page.evaluate(async (u) => {
        try { const r = await fetch(u, { headers: { Accept: 'application/json' } }); return r.status; }
        catch (e) { return -1; }
      }, `${BASE}?page=1`);
    } catch (e) { status = -2; }
    if (status === 200) { passed = true; console.log(`Cloudflare 已通过（第 ${i + 1} 次）`); break; }
    console.log(`等待 CF 解除... status=${status} (${i + 1}/30)`);
    await page.waitForTimeout(3000);
  }
  if (!passed) { await browser.close(); console.error('未能过 Cloudflare'); process.exit(1); }

  // 抽取 HTML 内嵌数据
  function extractFromHtml(html) {
    const res = { hasNextData: false, nextDataKeys: [], rscChunks: 0, evolutionHits: [], sbcHits: [], sample: null };
    // __NEXT_DATA__
    const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (m) {
      try {
        const j = JSON.parse(m[1]);
        res.hasNextData = true;
        res.nextDataKeys = Object.keys(j).slice(0, 20);
        // 递归收集含 evolution/sbc/challenge 的字段路径与样本
        const walk = (o, path0, depth) => {
          if (depth > 8 || res.evolutionHits.length + res.sbcHits.length > 60) return;
          if (o && typeof o === 'object') {
            for (const k of Object.keys(o)) {
              const p = path0 ? path0 + '.' + k : k;
              const lk = k.toLowerCase();
              if (/evolution/i.test(lk)) res.evolutionHits.push(p);
              else if (/sbc|challenge/i.test(lk)) res.sbcHits.push(p);
              try { walk(o[k], p, depth + 1); } catch (e) {}
            }
          }
        };
        walk(j, '', 0);
        // 取第一个 evolution 数组项样本
        const findFirstArr = (o, depth) => {
          if (depth > 8 || !o || typeof o !== 'object') return null;
          for (const k of Object.keys(o)) {
            const lk = k.toLowerCase();
            if ((/evolution/i.test(lk) || /sbc|challenge/i.test(lk)) && Array.isArray(o[k]) && o[k][0]) return { key: k, len: o[k].length, item: o[k][0] };
            const r = findFirstArr(o[k], depth + 1); if (r) return r;
          }
          return null;
        };
        res.sample = findFirstArr(j, 0);
      } catch (e) { res.nextDataKeys = ['(解析失败) ' + e.message]; }
    }
    // RSC 分块 self.__next_f.push(...)
    const rsc = html.match(/self\.__next_f\.push\([^)]*\)/g) || [];
    res.rscChunks = rsc.length;
    // 在 RSC 分块里做一次关键词命中计数
    let evoCount = 0, sbcCount = 0;
    for (const c of rsc) {
      if (/evolution/i.test(c)) evoCount++;
      if (/sbc|challenge/i.test(c)) sbcCount++;
    }
    res.rscEvolutionChunks = evoCount;
    res.rscSbcChunks = sbcCount;
    return res;
  }

  const pages = ['/evolutions', '/sbc', '/squad-building-challenges'];
  const perPage = [];
  for (const p of pages) {
    try {
      await page.goto('https://www.fut.gg' + p, { waitUntil: 'domcontentloaded', timeout: 60000 });
      // 等水合 + 可能的客户端 fetch
      await page.waitForTimeout(7000);
      const html = await page.content();
      const info = extractFromHtml(html);
      info.page = p;
      info.htmlLen = html.length;
      perPage.push(info);
      console.log(`已访问 ${p} | htmlLen=${html.length} nextData=${info.hasNextData} rscChunks=${info.rscChunks} evoHits=${info.evolutionHits.length} sbcHits=${info.sbcHits.length}`);
      if (info.sample) console.log('  sample key=', info.sample.key, 'len=', info.sample.len, 'itemKeys=', Object.keys(info.sample.item).slice(0, 40).join(','));
    } catch (e) { console.log('访问', p, '失败:', e.message); }
  }

  // 过滤出与 SBC/Evo 相关的响应 URL（任意 host）
  const relevantUrls = allResponses.filter(r => /evolution|sbc|challenge|\/api\//i.test(r.url)).slice(0, 60);

  const result = {
    ver: VER,
    pages: perPage,
    relevantResponseUrls: relevantUrls,
    allResponseCount: allResponses.length
  };
  const outDir = path.resolve(__dirname, '..', 'probe');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, 'probe_sbc_evolution.json');
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2));

  console.log('\n===== 各页面内嵌数据摘要 =====');
  for (const pg of perPage) {
    console.log(`\n[${pg.page}] nextData=${pg.hasNextData} rscChunks=${pg.rscChunks} (evo=${pg.rscEvolutionChunks} sbc=${pg.rscSbcChunks})`);
    if (pg.evolutionHits.length) console.log('  evolution 字段路径(前10):', pg.evolutionHits.slice(0, 10).join(' | '));
    if (pg.sbcHits.length) console.log('  sbc/challenge 字段路径(前10):', pg.sbcHits.slice(0, 10).join(' | '));
  }
  console.log('\n===== 与 SBC/Evo 相关的响应 URL =====');
  console.log(JSON.stringify(relevantUrls, null, 2));
  console.log('\n已写出', outPath);
  await browser.close();
})().catch(e => { console.error('探查失败:', e); process.exit(1); });
