// 探查 fut.gg 真实的 SBC / Evolutions API 端点（第三轮：确定性捕获页面真实响应）。
//
// 前两轮教训：
//   ① 猜的端点 URL 全 404（连页面「自己请求过」的也 404）→ 路径不对。
//   ② 仅靠 window.fetch / page.request.fetch 重抓也被 404（fut.gg 对这些端点有校验）。
//   ③ round-1 的 observedApiRequests 只是「页面发起过请求」，不代表成功。
//
// 本版做法（确定性）：过 CF 后，注册 response 监听器，捕获导航 /evolutions、/sbc 等页面时
//   页面**真实发出并返回**的每一个 fut.gg/api 响应（状态码 + 是否 JSON + 字段结构 + 样本），
//   不限关键词。这样能直接看到哪些端点返回 200+JSON、数据结构长什么样。
//
// 输出：probe/probe_sbc_evolution.json（落盘）+ 控制台打印。
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const VER = Number(process.env.FC_VER || 27);
const UA = process.env.CF_UA || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36';

function topKeys(obj, n = 24) {
  if (!obj || typeof obj !== 'object') return String(obj);
  if (Array.isArray(obj)) {
    const item = obj[0];
    return `array(${obj.length})` + (item && typeof item === 'object' ? ' itemKeys=' + Object.keys(item).slice(0, 30).join(',') : ' first=' + JSON.stringify(item).slice(0, 100));
  }
  for (const k of ['data', 'items', 'results', 'list', 'evolutions', 'challenges', 'sbc', 'items']) {
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
    else if (typeof v === 'object' && v !== null) v = Array.isArray(v) ? `[arr(${v.length})]` : '[obj:' + Object.keys(v).slice(0, 12).join(',') + ']';
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

  // 捕获所有 fut.gg/api 响应
  const captured = [];
  const seen = new Set();
  page.on('response', async (resp) => {
    const u = resp.url();
    if (!/fut\.gg\/api/i.test(u)) return;
    if (seen.has(u)) return; seen.add(u);
    const status = resp.status();
    const ct = resp.headers()['content-type'] || '';
    let entry = { url: u, status, len: 0, json: false, structure: '', sample: null };
    try {
      const t = await resp.text();
      entry.len = t.length;
      if (ct.includes('json') || (t.trim().startsWith('{') || t.trim().startsWith('['))) {
        try { const j = JSON.parse(t); entry.json = true; entry.structure = topKeys(j); entry.sample = sampleItem(j); }
        catch (e) { entry.structure = '(非 JSON) ' + t.slice(0, 120); }
      }
    } catch (e) { entry.structure = '(body unreadable)'; }
    captured.push(entry);
    if (entry.json) console.log('[200-JSON]', status, u, '|', entry.structure);
    else console.log('[resp]', status, u, '| len', entry.len);
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

  // 访问真实页面，让页面自己发 XHR，监听器捕获所有 api 响应
  const pages = ['/evolutions', '/sbc', '/squad-building-challenges', '/sbc-challenges', '/evolutions/27'];
  for (const p of pages) {
    try {
      await page.goto('https://www.fut.gg' + p, { waitUntil: 'networkidle', timeout: 60000 });
      await page.waitForTimeout(5000);
      console.log('已访问', p, '| 累计捕获', captured.length);
    } catch (e) { console.log('访问', p, '失败:', e.message); }
  }
  // 再滚一下 /evolutions 看是否有分页加载
  try {
    await page.goto('https://www.fut.gg/evolutions', { waitUntil: 'networkidle', timeout: 60000 });
    await page.mouse.wheel(0, 3000); await page.waitForTimeout(2500);
    await page.mouse.wheel(0, 3000); await page.waitForTimeout(2500);
    console.log('滚动态累计捕获', captured.length);
  } catch (e) {}

  // 只保留与 SBC/Evolutions 相关的，便于阅读；但全部落盘
  const relevant = captured.filter(c => /evolution|sbc|challenge/i.test(c.url));
  const result = {
    ver: VER,
    totalApiResponses: captured.length,
    relevantResponses: relevant,
    allApiResponses: captured.map(c => ({ url: c.url, status: c.status, json: c.json, structure: c.structure }))
  };
  const outDir = path.resolve(__dirname, '..', 'probe');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, 'probe_sbc_evolution.json');
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
  console.log('\n===== 与 SBC/Evolutions 相关的真实响应 =====');
  console.log(JSON.stringify(result.relevantResponses, null, 2));
  console.log('\n已写出', outPath);
  await browser.close();
})().catch(e => { console.error('探查失败:', e); process.exit(1); });
