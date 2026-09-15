// 探查 fut.gg 真实 SBC 数据集端点（r12）。
//
// r10/r11 已坐实：Evolutions = r2.fut.gg/{ver}/{active|all}-evolutions.v1.{hash}.json 静态 CDN；
// 但 manifest 中**没有任何 sbc key**（FC26/FC27 均 0 个），且 r10 抓到的 /sbc/ 页面加载
// 只产生 Rubicon 广告请求、无 fut.gg 数据请求 → SBC 数据要么是 SSR 内嵌、要么走另一条 live API。
//
// 本脚本在过 CF 的浏览器会话里：
//   A) 取首页 HTML，抽出所有 /ts/assets/*.js 主 bundle 入口；
//   B) 逐个 fetch bundle 文本，定向 grep SBC 端点构造（sbcSets / getSbcSets / Qh.sbc / getClientUrl / r2.fut.gg / /api/fut/sbc / discovery/ssr / objectives / challenges），带上下文；
//   C) 监听 /sbc/ 页面真实网络响应，收集含 sbc / fut.gg/api / r2.fut.gg 的请求；
//   D) 直接试候选 live API 端点，记录 status / content-type / 前 400 字；
//   E) 取 /sbc/ HTML，搜 SSR 内嵌 SBC JSON 标记。
//
// 输出：probe/r12_sbc_endpoint.json
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const UA = process.env.CF_UA || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36';
const VER = parseInt(process.env.FC_VER || '27', 10);

const SBC_PATTERNS = [
  'sbcSets', 'getSbcSets', 'useGetSbcSets', 'getSbcSetList', 'sbcSetList',
  'Qh.sbc', 'Qh.Sbc', 'Qh.SBC', 'sbcSet', 'SbcSet', 'sbc-set', 'sbc-sets',
  'getClientUrl', 'r2.fut.gg', '/api/fut/sbc', 'fut.gg/api/sbc',
  'discovery/ssr', 'objectives', 'Objectives', 'challenges', 'Challenges',
  'IS_OBJECTIVE', 'IS_ACTIVE_OBJECTIVE'
];

function ctx(str, idx, re, before = 90, after = 160) {
  const s = Math.max(0, idx - before);
  const e = Math.min(str.length, idx + re[0].length + after);
  return str.slice(s, e).replace(/\s+/g, ' ');
}

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--disable-blink-features=AutomationControlled', '--no-sandbox', '--disable-dev-shm-usage'] });
  const ctxPage = await browser.newContext({ userAgent: UA, locale: 'en-US', viewport: { width: 1280, height: 800 }, timezoneId: 'America/New_York' });
  const page = await ctxPage.newPage();

  console.log('过 Cloudflare ...');
  await page.goto('https://www.fut.gg/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  let passed = false;
  for (let i = 0; i < 30; i++) {
    let status = 0;
    try { status = await page.evaluate(async () => { try { const r = await fetch('https://www.fut.gg/api/fut/players/v2/27/?page=1', { headers: { Accept: 'application/json' } }); return r.status; } catch (e) { return -1; } }); } catch (e) { status = -2; }
    if (status === 200) { passed = true; break; }
    await page.waitForTimeout(3000);
  }
  if (!passed) { await browser.close(); console.error('CF 未过'); process.exit(1); }

  const out = { ver: VER, bundles: [], liveNetwork: [], candidateApi: [], ssrHtml: {} };

  // ---- A) 抽主 bundle 入口 ----
  console.log('A) 抽首页 script src ...');
  const htmlHome = await page.content();
  const srcRe = /src="([^"]*\/ts\/assets\/[^"]+\.js)"/g;
  const bundleSet = new Set();
  let m;
  while ((m = srcRe.exec(htmlHome)) !== null) bundleSet.add(m[1].startsWith('http') ? m[1] : 'https://www.fut.gg' + m[1]);
  // 也抓带 integrity 的 modulepreload
  const hrefRe = /href="([^"]*\/ts\/assets\/[^"]+\.js)"/g;
  while ((m = hrefRe.exec(htmlHome)) !== null) bundleSet.add(m[1].startsWith('http') ? m[1] : 'https://www.fut.gg' + m[1]);
  const bundles = [...bundleSet];
  console.log('  发现 bundle 入口:', bundles.length, bundles.join(' | '));

  // ---- C) 监听 /sbc/ 真实网络响应（先导航，加载 /sbc/ 路由 chunk） ----
  console.log('C) 监听 /sbc/ 网络 ...');
  const seen = [];
  const onResp = async (resp) => {
    const u = resp.url();
    if (/sbc/i.test(u) || /fut\.gg\/api/i.test(u) || /r2\.fut\.gg/i.test(u)) {
      let bodyHead = '';
      try { const buf = await resp.body(); bodyHead = buf.slice(0, 400).toString('utf8'); } catch (e) {}
      seen.push({ url: u, status: resp.status(), ct: resp.headers()['content-type'] || '', head: bodyHead.replace(/\s+/g, ' ') });
    }
  };
  page.on('response', onResp);
  try {
    await page.goto('https://www.fut.gg/sbc/', { waitUntil: 'networkidle', timeout: 45000 });
  } catch (e) { console.log('  /sbc/ networkidle 超时，继续'); }
  await page.waitForTimeout(8000); // 给 React Query 钩子时间发请求
  page.off('response', onResp);
  out.liveNetwork = seen;
  console.log('  捕获相关响应', seen.length, '条');

  // /sbc/ 页面 HTML 可能引用首页没有的路由专属 chunk → 补抽并合并
  const htmlSbcNow = await page.content();
  const srcRe2 = /src="([^"]*\/ts\/assets\/[^"]+\.js)"/g;
  while ((m = srcRe2.exec(htmlSbcNow)) !== null) bundleSet.add(m[1].startsWith('http') ? m[1] : 'https://www.fut.gg' + m[1]);
  const hrefRe2 = /href="([^"]*\/ts\/assets\/[^"]+\.js)"/g;
  while ((m = hrefRe2.exec(htmlSbcNow)) !== null) bundleSet.add(m[1].startsWith('http') ? m[1] : 'https://www.fut.gg' + m[1]);
  const bundlesAll = [...bundleSet];
  console.log('  合并 bundle 入口:', bundlesAll.length, '->', bundlesAll.join(' | '));

  // ---- B) 逐个 bundle grep SBC 端点 ----
  for (const url of bundlesAll) {
    console.log('B) bundle:', url);
    const txt = await page.evaluate(async u => { try { const r = await fetch(u); return await r.text(); } catch (e) { return 'ERR:' + e.message; } }, url);
    if (txt.startsWith('ERR:') || txt.length < 1000) { out.bundles.push({ url, error: txt.slice(0, 120), len: txt.length }); continue; }
    const hits = [];
    for (const p of SBC_PATTERNS) {
      let idx = txt.indexOf(p);
      let cnt = 0;
      while (idx !== -1 && cnt < 6) {
        hits.push({ pattern: p, snippet: ctx(txt, idx, p) });
        idx = txt.indexOf(p, idx + p.length);
        cnt++;
      }
    }
    // 统计 getClientUrl 全部出现（看 host 构造）
    const gc = [];
    let gi = txt.indexOf('getClientUrl');
    while (gi !== -1 && gc.length < 20) { gc.push(ctx(txt, gi, 'getClientUrl')); gi = txt.indexOf('getClientUrl', gi + 10); }
    out.bundles.push({ url, len: txt.length, sbcHits: hits, getClientUrlSamples: gc });
  }

  // ---- D) 直接试候选 live API ----
  console.log('D) 试候选 API ...');
  const candidates = [
    `https://www.fut.gg/api/fut/sbc-sets/${VER}`,
    `https://www.fut.gg/api/fut/sbc/${VER}`,
    `https://www.fut.gg/api/fut/sbc-sets/v2/${VER}`,
    `https://www.fut.gg/api/fut/sbc/v2/${VER}`,
    `https://www.fut.gg/api/fut/sbc-sets?game=${VER}`,
    `https://www.fut.gg/api/fut/sbc?game=${VER}`,
    `https://www.fut.gg/api/fut/objectives/${VER}`,
    `https://www.fut.gg/api/fut/challenges/${VER}`
  ];
  for (const c of candidates) {
    const res = await page.evaluate(async u => {
      try {
        const r = await fetch(u, { headers: { Accept: 'application/json' } });
        const t = await r.text();
        return { status: r.status, ct: r.headers.get('content-type'), head: t.slice(0, 400) };
      } catch (e) { return { error: e.message }; }
    }, c);
    out.candidateApi.push({ url: c, ...res });
    console.log('  ', c, '->', res.status || res.error, (res.ct || '').slice(0, 30));
  }

  // ---- E) /sbc/ HTML SSR 内嵌标记 ----
  console.log('E) 搜 /sbc/ HTML SSR ...');
  const htmlSbc = await page.content();
  const markers = ['sbcSets', 'self.__next_f', '__NEXT_DATA__', '"objectives"', '"challenges"', 'IS_OBJECTIVE', 'useGetSbcSets'];
  const found = {};
  for (const mk of markers) found[mk] = htmlSbc.includes(mk);
  // 抽取含 sbcSets 的 next_f 片段
  let sbcFrag = '';
  const fi = htmlSbc.indexOf('sbcSets');
  if (fi !== -1) sbcFrag = htmlSbc.slice(fi - 60, fi + 300).replace(/\s+/g, ' ');
  out.ssrHtml = { len: htmlSbc.length, markers: found, sbcSetsFragment: sbcFrag };

  const outDir = path.resolve(__dirname, '..', 'probe');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'r12_sbc_endpoint.json'), JSON.stringify(out, null, 2));
  console.log('\n已写出 probe/r12_sbc_endpoint.json');
  await browser.close();
})().catch(e => { console.error('失败:', e); process.exit(1); });
