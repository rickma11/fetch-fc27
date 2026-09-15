// 探查 fut.gg 的 SBC / Evolutions 数据来源（第五轮修正版）。
//
// 关键背景 / 教训：
//   - round-5 直接 page.goto('/evolutions') 会触发 Cloudflare 二次挑战（redirect loop），
//     拿到的是 CF 拦截页（htmlLen=82KB、nextData=false），不是真内容。
//   - 但页面加载了 SBC 组件 bundle：assets.fut.gg/ts/assets/StreamlinedSbcBadge-*.js、
//     StreamlinedSbcArtwork-*.js（200）。真实数据 API 路径就藏在这些前端 bundle 里。
//   - 正确做法：① 用 response 监听器读取这些 bundle 源码、grep "/api/fut/..." 等真实端点；
//               ② 用页内 fetch('/evolutions') 取子页 HTML（同源、带 CF cookie，不会二次挑战）。
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

  // 收集：① 所有 assets.fut.gg 的 JS bundle 源码（grep API 路径）；② 所有 /api/ 响应
  const bundleSources = [];   // {url, len, apiPaths:[]}
  const apiResponses = [];    // {url, status, len}
  const seen = new Set();
  page.on('response', async (resp) => {
    const u = resp.url();
    if (seen.has(u)) return; seen.add(u);
    const ct = resp.headers()['content-type'] || '';
    const lower = u.toLowerCase();
    if (lower.includes('assets.fut.gg') && (lower.endsWith('.js') || ct.includes('javascript'))) {
      try {
        const t = await resp.text();
        // 找所有 /api/... 路径片段 + 含 evolution/sbc/challenge 的字符串
        const paths = [...new Set((t.match(/\/api\/[A-Za-z0-9_./-]+/g) || []))];
        const evo = [...new Set((t.match(/[A-Za-z0-9_./-]*(?:evolution|sbc|challenge)[A-Za-z0-9_./-]*/gi) || []))].slice(0, 40);
        bundleSources.push({ url: u, len: t.length, apiPaths: paths.slice(0, 60), evoStrings: evo });
        if (paths.length) console.log('[bundle]', u.split('/').pop(), 'apiPaths:', paths.slice(0, 20).join(' '));
        if (evo.length) console.log('[bundle]', u.split('/').pop(), 'evoStrings:', evo.slice(0, 15).join(' '));
      } catch (e) {}
    }
    if (/fut\.gg\/api/i.test(u)) {
      try { const t = await resp.text(); apiResponses.push({ url: u, status: resp.status(), len: t.length }); }
      catch (e) { apiResponses.push({ url: u, status: resp.status(), len: -1 }); }
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
        try { const r = await fetch(u, { headers: { Accept: 'application/json' } }); return r.status; }
        catch (e) { return -1; }
      }, `${BASE}?page=1`);
    } catch (e) { status = -2; }
    if (status === 200) { passed = true; console.log(`Cloudflare 已通过（第 ${i + 1} 次）`); break; }
    console.log(`等待 CF 解除... status=${status} (${i + 1}/30)`);
    await page.waitForTimeout(3000);
  }
  if (!passed) { await browser.close(); console.error('未能过 Cloudflare'); process.exit(1); }

  // 页内 fetch 子页 HTML（同源、带 CF cookie，不会二次挑战）
  const subPages = ['/evolutions', '/sbc', '/squad-building-challenges'];
  const pageHtml = {};
  for (const p of subPages) {
    try {
      const info = await page.evaluate(async (path) => {
        const r = await fetch(path, { headers: { Accept: 'text/html' }, credentials: 'same-origin' });
        const html = await r.text();
        const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
        let keys = [], evoHits = [], sbcHits = [], sample = null;
        if (m) {
          try {
            const j = JSON.parse(m[1]);
            keys = Object.keys(j).slice(0, 20);
            const walk = (o, pp, d) => {
              if (d > 8 || evoHits.length + sbcHits.length > 50) return;
              if (o && typeof o === 'object') for (const k of Object.keys(o)) {
                const lk = k.toLowerCase();
                if (/evolution/i.test(lk)) evoHits.push(pp ? pp + '.' + k : k);
                else if (/sbc|challenge/i.test(lk)) sbcHits.push(pp ? pp + '.' + k : k);
                try { walk(o[k], pp ? pp + '.' + k : k, d + 1); } catch (e) {}
              }
            };
            walk(j, '', 0);
            const findArr = (o, d) => {
              if (d > 8 || !o || typeof o !== 'object') return null;
              for (const k of Object.keys(o)) {
                const lk = k.toLowerCase();
                if ((/evolution/i.test(lk) || /sbc|challenge/i.test(lk)) && Array.isArray(o[k]) && o[k][0]) return { key: k, len: o[k].length, itemKeys: Object.keys(o[k][0]).slice(0, 40) };
                const r2 = findArr(o[k], d + 1); if (r2) return r2;
              }
              return null;
            };
            sample = findArr(j, 0);
          } catch (e) {}
        }
        // 在 HTML 里找内嵌的 api 路径
        const apis = [...new Set((html.match(/\/api\/[A-Za-z0-9_./-]+/g) || []))];
        return { status: r.status, htmlLen: html.length, nextData: !!m, keys, evoHits: evoHits.slice(0, 20), sbcHits: sbcHits.slice(0, 20), sample, htmlApis: apis.slice(0, 30) };
      }, p);
      pageHtml[p] = info;
      console.log(`页内fetch ${p} | status=${info.status} htmlLen=${info.htmlLen} nextData=${info.nextData} evoHits=${info.evoHits.length} sbcHits=${info.sbcHits.length}`);
      if (info.sample) console.log('  sample:', JSON.stringify(info.sample).slice(0, 300));
      if (info.htmlApis.length) console.log('  htmlApis:', info.htmlApis.join(' '));
    } catch (e) { console.log('页内fetch', p, '失败:', e.message); }
  }

  // 汇总所有 bundle 里发现的 api 路径（去重）
  const allApiPaths = [...new Set(bundleSources.flatMap(b => b.apiPaths))].sort();
  const allEvoStrings = [...new Set(bundleSources.flatMap(b => b.evoStrings))].sort();

  const result = {
    ver: VER,
    subPageInHtml: pageHtml,
    bundleApiPaths: allApiPaths,
    bundleEvoStrings: allEvoStrings,
    apiResponses
  };
  const outDir = path.resolve(__dirname, '..', 'probe');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, 'probe_sbc_evolution.json');
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
  console.log('\n===== bundle 内发现的 /api/ 路径 =====');
  console.log(JSON.stringify(allApiPaths, null, 2));
  console.log('\n===== bundle 内 evolution/sbc/challenge 字符串 =====');
  console.log(JSON.stringify(allEvoStrings.slice(0, 60), null, 2));
  console.log('\n已写出', outPath);
  await browser.close();
})().catch(e => { console.error('探查失败:', e); process.exit(1); });
