// 从 FC26 真实数据里精准抽取两条样本，写成小文件，供本地适配成 FC27 模拟数据。
// 只取 Marquee Matchups (SBC) 与 Intro to Evolutions (Evolution)，避免拉全量 16MB。
// 跑在真实浏览器过 CF 的环境（probe-futgg workflow），输出 probe/fc26_mock_seed.json。
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const UA = process.env.CF_UA || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36';
const VER = 26; // 始终从 FC26 抽样本
const sleep = ms => new Promise(r => setTimeout(r, ms));
const OUT = path.resolve(__dirname, '..', 'probe', 'fc26_mock_seed.json');

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--disable-blink-features=AutomationControlled', '--no-sandbox', '--disable-dev-shm-usage'] });
  const ctx = await browser.newContext({ userAgent: UA, locale: 'en-US', viewport: { width: 1280, height: 800 }, timezoneId: 'America/New_York' });
  const page = await ctx.newPage();
  page.on('console', m => { const t = m.text(); if (/error|fail/i.test(t)) console.log('[browser]', t); });

  console.log('打开 fut.gg 过 Cloudflare ...');
  await page.goto('https://www.fut.gg/sbc/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  let passed = false;
  const probeUrl = `https://www.fut.gg/api/fut/sbc/${VER}?page=1`;
  for (let i = 0; i < 30; i++) {
    let status = -1;
    try { status = await page.evaluate(async u => { try { const r = await fetch(u, { headers: { Accept: 'application/json' } }); return r.status; } catch (e) { return -1; } }, probeUrl); } catch (e) { status = -2; }
    if (status === 200) { passed = true; console.log(`Cloudflare 已通过（第 ${i + 1} 次）`); break; }
    console.log(`等待 CF... status=${status} (${i + 1}/30)`);
    await page.waitForTimeout(3000);
  }
  if (!passed) { console.error('CF 未过'); await browser.close(); process.exit(1); }

  // ---- 抽 Marquee Matchups (SBC) ----
  const sbc = await page.evaluate(async (ver) => {
    const BASE = `https://www.fut.gg/api/fut/sbc/${ver}`;
    const s = [];
    let page = 1, totalPages = 1;
    while (page <= totalPages) {
      const r = await fetch(`${BASE}?page=${page}`, { headers: { Accept: 'application/json' } });
      if (!r.ok) throw new Error(`SBC page ${page} ${r.status}`);
      const j = await r.json();
      const arr = Array.isArray(j.data) ? j.data : [];
      s.push(...arr);
      if (typeof j.totalPages === 'number') totalPages = j.totalPages;
      page++;
      if (page <= totalPages) await new Promise(r => setTimeout(r, 400));
    }
    return s;
  }, VER);
  const sbcHit = sbc.filter(x => /marquee matchups/i.test(x.name || ''));
  console.log(`SBC 全量 ${sbc.length} 组，命中 Marquee Matchups ${sbcHit.length} 条`);
  const marquee = sbcHit[0] || null;

  // ---- 抽 Intro to Evolutions (Evolution) ----
  const evoHit = await page.evaluate(async (ver) => {
    const man = await (await fetch(`https://r2.fut.gg/${ver}/manifest.json`, { headers: { Accept: 'application/json' } })).json();
    const list = [];
    for (const key of ['active-evolutions', 'all-evolutions']) {
      const h = man[key];
      if (!h || h === 'd7517139') continue;
      const arr = await (await fetch(`https://r2.fut.gg/${ver}/${key}.v1.${h}.json`, { headers: { Accept: 'application/json' } })).json();
      const a = Array.isArray(arr) ? arr : (arr.data || []);
      list.push(...a);
    }
    const hit = list.filter(e => /intro to evolutions/i.test(e.name || ''));
    console.log(`Evo 全量 ${list.length} 条，命中 Intro to Evolutions ${hit.length} 条`);
    return hit[0] || null;
  }, VER);

  await browser.close();

  const seed = {
    sourceVer: VER,
    extractedAt: new Date().toISOString(),
    sbc: marquee,
    evolution: evoHit,
    notes: 'FC26 真实样本，供适配成 FC27 模拟数据。'
  };
  if (!seed.sbc) console.error('!! 未找到 Marquee Matchups');
  if (!seed.evolution) console.error('!! 未找到 Intro to Evolutions');
  fs.writeFileSync(OUT, JSON.stringify(seed, null, 2));
  console.log('写出', OUT, '字节', fs.statSync(OUT).size);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
