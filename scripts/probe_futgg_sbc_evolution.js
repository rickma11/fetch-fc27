// 探查 fut.gg 真实的 SBC / Evolutions API 端点 + 响应体结构（第二轮修正版）。
// 复用 fetch_ci.js 的「Playwright 真实 Chromium 过 Cloudflare」逻辑。
//
// 第一轮教训：① 用 window.fetch 重抓被 fut.gg 请求头校验挡成 404；
//             ② 仅靠「页面自发 XHR 的 response listener」不稳定（本轮 0 命中）。
// 本版改法：过 CF 后，用 Playwright 的 page.request.fetch（共享浏览器上下文 cookie，
//           天然带 CF 通关凭证 + 浏览器式请求头）主动抓取已确认真实存在的端点，直接拿响应体。
//
// 输出：probe/probe_sbc_evolution.json（落盘）+ 控制台打印。
//
// 运行：
//   本机（需装 Playwright）：npm i playwright && npx playwright install chromium
//           FC_VER=26 node scripts/probe_futgg_sbc_evolution.js
//   CI：推到仓库后，Actions 手动 dispatch（见 .github/workflows/probe-futgg.yml）
//
// 注：纯探查脚本，不写数据库、不动快照，安全可反复跑。
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const VER = Number(process.env.FC_VER || 27);
const UA = process.env.CF_UA || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36';

const KNOWN = [
  `https://www.fut.gg/api/fut/evolution-list/v2/${VER}/`,
  `https://www.fut.gg/api/fut/evolutions/${VER}/`,
  `https://www.fut.gg/api/fut/evolutions/v2/${VER}/`,
  `https://www.fut.gg/api/fut/evolutions/list/${VER}/`,
  `https://www.fut.gg/api/fut/challenges/v2/${VER}/`,
  `https://www.fut.gg/api/fut/sbc-challenges/${VER}/`,
  `https://www.fut.gg/api/fut/sbc/v2/${VER}/`,
  `https://www.fut.gg/api/fut/squad-building-challenges/v2/${VER}/`
];

function topKeys(obj, n = 24) {
  if (!obj || typeof obj !== 'object') return String(obj);
  if (Array.isArray(obj)) {
    const item = obj[0];
    return `array(${obj.length})` + (item && typeof item === 'object' ? ' itemKeys=' + Object.keys(item).slice(0, 30).join(',') : ' first=' + JSON.stringify(item).slice(0, 100));
  }
  for (const k of ['data', 'items', 'results', 'list', 'evolutions', 'challenges', 'sbc']) {
    if (obj[k] && Array.isArray(obj[k])) {
      const sample = obj[k][0];
      return `root.${k}[] (${obj[k].length}) itemKeys=` + (sample && typeof sample === 'object' ? Object.keys(sample).slice(0, 30).join(',') : String(sample));
    }
  }
  return Object.keys(obj).slice(0, n).join(',');
}

function sampleItem(j) {
  let arr = null;
  if (Array.isArray(j)) arr = j;
  else for (const k of ['data', 'items', 'results', 'list', 'evolutions', 'challenges', 'sbc']) {
    if (j && j[k] && Array.isArray(j[k])) { arr = j[k]; break; }
  }
  if (!arr || !arr.length) return null;
  const s = arr[0];
  if (!s || typeof s !== 'object') return null;
  const out = {};
  for (const k of Object.keys(s).slice(0, 50)) {
    let v = s[k];
    if (typeof v === 'string' && v.length > 160) v = v.slice(0, 160) + '…';
    else if (typeof v === 'object' && v !== null) {
      // 嵌套对象只展开一层
      if (Array.isArray(v)) v = `[arr(${v.length})]`;
      else v = '[obj:' + Object.keys(v).slice(0, 12).join(',') + ']';
    }
    out[k] = v;
  }
  return out;
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

  // 先访问一下页面，确保上下文里有了 CF 凭证 / 必要的 cookie
  await page.goto('https://www.fut.gg/evolutions', { waitUntil: 'networkidle', timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(2000);

  // 用 Playwright APIRequest（共享上下文 cookie）主动抓取已知端点
  const api = ctx.request;
  const captured = [];
  for (const u of KNOWN) {
    try {
      const r = await api.fetch(u, {
        headers: {
          'Accept': 'application/json, text/plain, */*',
          'Accept-Language': 'en-US,en;q=0.9',
          'Referer': 'https://www.fut.gg/evolutions',
          'sec-fetch-site': 'same-origin',
          'sec-fetch-mode': 'cors',
          'sec-fetch-dest': 'empty',
          'x-requested-with': 'XMLHttpRequest'
        }
      });
      const t = await r.text();
      let structure = '', sample = null;
      try { const j = JSON.parse(t); structure = topKeys(j); sample = sampleItem(j); }
      catch (e) { structure = '(非 JSON) ' + t.slice(0, 200); }
      captured.push({ url: u, status: r.status(), len: t.length, structure, sample });
      console.log('[fetch]', r.status(), u, '|', structure);
    } catch (e) {
      captured.push({ url: u, error: String(e).slice(0, 200) });
      console.log('[fetch-err]', u, String(e).slice(0, 160));
    }
  }

  const result = { ver: VER, captured };
  const outDir = path.resolve(__dirname, '..', 'probe');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, 'probe_sbc_evolution.json');
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
  console.log('\n===== 抓到的端点响应 =====');
  console.log(JSON.stringify(result.captured, null, 2));
  console.log('\n已写出', outPath);
  await browser.close();
})().catch(e => { console.error('探查失败:', e); process.exit(1); });
