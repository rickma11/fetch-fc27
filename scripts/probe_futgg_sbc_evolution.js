// 探查 fut.gg 真实的 SBC / Evolutions API 端点 + 响应体结构。
// 复用 fetch_ci.js 的「Playwright 真实 Chromium 过 Cloudflare」逻辑。
//
// 关键修正：fut.gg 对同源 fetch 有请求头校验，直接 page.evaluate fetch 会 404。
//   改为监听页面「自己的」XHR 响应，直接抓取真实响应体（status + 字段 + 截断样本）。
//
// 输出：probe/probe_sbc_evolution.json（落盘）+ 控制台打印。
//
// 运行：
//   本机（需装 Playwright）：npm i playwright && npx playwright install chromium
//                           FC_VER=26 node scripts/probe_futgg_sbc_evolution.js
//   CI：推到仓库后，Actions 手动 dispatch（见 .github/workflows/probe-futgg.yml）
//
// 注：纯探查脚本，不写数据库、不动快照，安全可反复跑。
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const VER = Number(process.env.FC_VER || 27);
const UA = process.env.CF_UA || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36';

// 想抓的真实端点关键词（fut.gg 页面自己会请求这些）
const WANT = [
  /fut\.gg\/api\/fut\/evolution-list/i,
  /fut\.gg\/api\/fut\/evolutions/i,
  /fut\.gg\/api\/fut\/challenges/i,
  /fut\.gg\/api\/fut\/sbc/i,
  /fut\.gg\/api\/fut\/squad-building-challenges/i
];

function topKeys(obj, n = 20) {
  if (!obj || typeof obj !== 'object') return [];
  if (Array.isArray(obj)) return `array(${obj.length})` + (obj[0] && typeof obj[0] === 'object' ? ' itemKeys=' + Object.keys(obj[0]).join(',') : '');
  // 顶层或嵌套：优先 data.items / data.results / items / results
  for (const k of ['data', 'items', 'results', 'list', 'evolutions', 'challenges', 'sbc']) {
    if (obj[k] && Array.isArray(obj[k])) {
      const sample = obj[k][0];
      return `root.${k}[] (${obj[k].length}) itemKeys=` + (sample && typeof sample === 'object' ? Object.keys(sample).slice(0, 30).join(',') : String(sample));
    }
  }
  return Object.keys(obj).slice(0, n).join(',');
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
  page.on('console', m => console.log('[browser]', m.text()));

  // 收集所有 fut.gg/api 真实请求（导航前注册）
  const apiHits = new Set();
  page.on('request', req => {
    const u = req.url();
    if (/fut\.gg\/api/i.test(u)) apiHits.add(u);
  });

  // 拦截响应体：只抓 SBC / Evolutions 相关
  const captured = [];
  const seenUrl = new Set();
  page.on('response', async (resp) => {
    const u = resp.url();
    const m = WANT.some(re => re.test(u));
    if (!m) return;
    if (seenUrl.has(u)) return;
    seenUrl.add(u);
    try {
      const ct = resp.headers()['content-type'] || '';
      const status = resp.status();
      let info = { url: u, status, len: 0, structure: '' };
      if (ct.includes('json') || status === 200) {
        const t = await resp.text();
        info.len = t.length;
        try {
          const j = JSON.parse(t);
          info.structure = topKeys(j);
          // 若顶层有数组/嵌套数组，附一个样本对象（截断到合理长度）
          const sample = extractSample(j);
          if (sample) info.sample = sample;
        } catch (e) { info.structure = '(非 JSON) ' + t.slice(0, 200); }
      }
      captured.push(info);
      console.log('[capture]', status, u, '|', info.structure);
    } catch (e) { /* 响应体已不可读，忽略 */ }
  });

  function extractSample(j) {
    // 尽量找到一个对象样本
    let arr = null;
    if (Array.isArray(j)) arr = j;
    else for (const k of ['data', 'items', 'results', 'list', 'evolutions', 'challenges', 'sbc']) {
      if (j && j[k] && Array.isArray(j[k])) { arr = j[k]; break; }
    }
    if (!arr || !arr.length) return null;
    const sample = arr[0];
    if (!sample || typeof sample !== 'object') return null;
    // 截断长字符串字段，便于阅读
    const out = {};
    for (const k of Object.keys(sample).slice(0, 40)) {
      let v = sample[k];
      if (typeof v === 'string' && v.length > 120) v = v.slice(0, 120) + '…';
      if (typeof v === 'object' && v !== null) v = '[obj]';
      out[k] = v;
    }
    return out;
  }

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

  // 访问 evolutions / sbc 页，让页面自己触发真实 XHR
  for (const p of ['/evolutions', '/evolutions/27', '/sbc', '/squad-building-challenges', '/sbc-challenges']) {
    try {
      await page.goto('https://www.fut.gg' + p, { waitUntil: 'networkidle', timeout: 60000 });
      await page.waitForTimeout(4000);
      console.log('已访问页面:', p, '| 累计 api 请求', apiHits.size, '| 已抓响应', captured.length);
    } catch (e) { console.log('访问', p, '失败:', e.message); }
  }

  const result = {
    observedApiRequests: [...apiHits].filter(u => WANT.some(re => re.test(u))).sort(),
    captured
  };
  const outDir = path.resolve(__dirname, '..', 'probe');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, 'probe_sbc_evolution.json');
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
  console.log('\n===== 抓到的真实端点响应 =====');
  console.log(JSON.stringify(result.captured, null, 2));
  console.log('\n已写出', outPath);
  await browser.close();
})().catch(e => { console.error('探查失败:', e); process.exit(1); });
