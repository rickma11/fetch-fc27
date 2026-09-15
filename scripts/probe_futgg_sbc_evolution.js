// 探查 fut.gg 真实的 SBC / Evolutions API 端点（供后续写抓取脚本定位 URL 用）。
// 复用 fetch_ci.js 的「Playwright 真实 Chromium 过 Cloudflare」逻辑：
//   过 CF 后，① 监听页面 Network 请求收集所有 fut.gg/api 真实调用；
//            ② 直接 page.evaluate 同源 fetch 试探一组候选端点，打印状态码+字段样本。
// 输出：probe/probe_sbc_evolution.json（落盘）+ 控制台打印。
//
// 运行：
//   本机（需装 Playwright）：npm i playwright && npx playwright install chromium
//                           node scripts/probe_futgg_sbc_evolution.js
//   CI：推到仓库后，Actions 手动 dispatch（见 .github/workflows/probe-futgg.yml）
//
// 注：纯探查脚本，不写数据库、不动快照，安全可反复跑。
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
  page.on('console', m => console.log('[browser]', m.text()));

  // 收集所有 fut.gg/api 真实请求（在导航前注册）
  const apiHits = new Set();
  page.on('request', req => {
    const u = req.url();
    if (/fut\.gg\/api/i.test(u)) apiHits.add(u);
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

  // ① 监听真实页面触发：访问 evolutions / sbc 页，捕获其 XHR
  for (const p of ['/evolutions', '/evolutions/27', '/sbc', '/squad-building-challenges', '/sbc-challenges']) {
    try {
      await page.goto('https://www.fut.gg' + p, { waitUntil: 'networkidle', timeout: 60000 });
      await page.waitForTimeout(3500);
      console.log('已访问页面:', p, '| 累计 api 请求', apiHits.size);
    } catch (e) { console.log('访问', p, '失败:', e.message); }
  }

  // ② 直接同源 fetch 试探候选端点
  const candidates = [
    `https://www.fut.gg/api/fut/evolutions/v2/${VER}/`,
    `https://www.fut.gg/api/fut/evolutions/${VER}/`,
    `https://www.fut.gg/api/fut/evolution-list/v2/${VER}/`,
    `https://www.fut.gg/api/fut/sbc-challenges/v2/${VER}/`,
    `https://www.fut.gg/api/fut/sbc-challenges/${VER}/`,
    `https://www.fut.gg/api/fut/sbc/v2/${VER}/`,
    `https://www.fut.gg/api/fut/squad-building-challenges/v2/${VER}/`,
    `https://www.fut.gg/api/fut/challenges/v2/${VER}/`,
    `https://www.fut.gg/api/fut/evolutions/list/${VER}/`,
    `https://www.fut.gg/api/fut/sbc/list/${VER}/`
  ];
  const probed = await page.evaluate(async (cands) => {
    const out = [];
    for (const u of cands) {
      try {
        const r = await fetch(u, { headers: { Accept: 'application/json' } });
        const t = await r.text();
        let keys = [];
        try { const j = JSON.parse(t); keys = (j && j.data) ? Object.keys(j.data).slice(0, 12) : Object.keys(j).slice(0, 12); } catch (e) {}
        out.push({ url: u, status: r.status, len: t.length, sampleKeys: keys });
      } catch (e) { out.push({ url: u, error: String(e) }); }
    }
    return out;
  }, candidates);

  const result = {
    observedApiRequests: [...apiHits].sort(),
    probed
  };
  const outDir = path.resolve(__dirname, '..', 'probe');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, 'probe_sbc_evolution.json');
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
  console.log('\n===== 观察到的真实 fut.gg/api 请求 =====');
  console.log(result.observedApiRequests.join('\n') || '(无)');
  console.log('\n===== 候选端点试探结果 =====');
  console.log(JSON.stringify(result.probed, null, 2));
  console.log('\n已写出', outPath);
  await browser.close();
})().catch(e => { console.error('探查失败:', e); process.exit(1); });
