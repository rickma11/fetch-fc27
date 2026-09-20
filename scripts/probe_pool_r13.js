// 探测 Player Pick 类 SBC 的 pool 页「选择球员」数据真实形态（写富集脚本的前置）。
// 机制与 scrape_sbc_evolutions.js 完全一致：真实 Chromium 过 Cloudflare → 页面内 fetch / goto。
// 只 dump、不写库、不动快照。结果写 probe/（CI 用 upload-artifact 回传）。
//
// 用法（通过 probe-futgg.yml 的 workflow_dispatch 在 CI 跑，不要本机跑——本机 IP 被 CF 挡）：
//   fc_ver=27  script=probe_pool_r13.js
//
// 它会同时试两条路径，便于确认最终用哪条：
//   A. JSON API 猜测： https://www.fut.gg/api/fut/pools/{ver}/{poolId}
//   B. HTML 页：      https://www.fut.gg/pools/{slug}-pool/  （WebFetch 已验证能拿到球员名+eaId）

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const UA = process.env.CF_UA || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36';
const VER = parseInt(process.env.FC_VER, 10) || 27;
const PROBE_DIR = path.resolve(__dirname, '..', 'probe');

// 已知 sample：set 5258「焦点球员双人挑选1」的 pool（本地 sbcs.json 里读不到，这里写死用于探测）
const SAMPLE_POOLS = [
  { id: 342, slug: '342-ones-to-watch-duo-pick-1-pool' }
];

function dump(name, obj) {
  if (!fs.existsSync(PROBE_DIR)) fs.mkdirSync(PROBE_DIR, { recursive: true });
  const file = path.join(PROBE_DIR, name);
  fs.writeFileSync(file, typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2));
  console.log('  [probe] 写出 ' + name);
}

(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox', '--disable-dev-shm-usage']
  });
  const ctx = await browser.newContext({ userAgent: UA, locale: 'en-US', viewport: { width: 1280, height: 800 }, timezoneId: 'America/New_York' });
  const page = await ctx.newPage();
  page.on('console', m => { const t = m.text(); if (/error|fail/i.test(t)) console.log('[browser]', t); });

  console.log('打开 fut.gg 过 Cloudflare ...');
  await page.goto('https://www.fut.gg/sbc/', { waitUntil: 'domcontentloaded', timeout: 60000 });

  let passed = false;
  const probeUrl = `https://www.fut.gg/api/fut/sbc/${VER}?page=1`;
  for (let i = 0; i < 30; i++) {
    let status = -1;
    try {
      status = await page.evaluate(async (u) => {
        try { const r = await fetch(u, { headers: { Accept: 'application/json' } }); return r.status; } catch (e) { return -1; }
      }, probeUrl);
    } catch (e) { status = -2; }
    if (status === 200) { passed = true; console.log(`Cloudflare 已通过（第 ${i + 1} 次）`); break; }
    if (status === 404) break;
    console.log(`等待 CF... status=${status} (${i + 1}/30)`);
    await page.waitForTimeout(3000);
  }
  if (!passed) { console.error('CF 未通过'); await browser.close(); process.exit(1); }

  for (const pool of SAMPLE_POOLS) {
    console.log(`\n===== 探测 pool id=${pool.id} slug=${pool.slug} =====`);

    // 路径 A：JSON API 猜测（evaluation 多参在旧版 Playwright 会报 Too many arguments，统一用对象传参）
    try {
      const api = await page.evaluate(async ({ ver, id }) => {
        const r = await fetch(`https://www.fut.gg/api/fut/pools/${ver}/${id}`, { headers: { Accept: 'application/json' } });
        const text = await r.text();
        let json = null; try { json = JSON.parse(text); } catch (e) {}
        return { status: r.status, head: text.slice(0, 2000), json: json };
      }, { ver: VER, id: pool.id });
      dump(`pool_r13_api_${pool.id}.json`, api);
      console.log(`  [A] API status=${api.status} json?=${!!api.json} head=${api.head.replace(/\n/g, ' ').slice(0, 120)}`);
    } catch (e) {
      console.log(`  [A] API 探测异常: ${e.message}`);
    }

    // 路径 B：HTML 页（fut.gg 永不 networkidle，改用 domcontentloaded + 等待球员链接出现）
    const htmlUrl = `https://www.fut.gg/pools/${pool.slug}/`;
    try {
      await page.goto(htmlUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      try { await page.waitForSelector('a[href*="/players/"]', { timeout: 30000 }); } catch (e) { /* 超时也继续，下面仍读 HTML */ }
      const html = await page.content();
      dump(`pool_r13_html_${pool.id}.html`, html);
      // 内嵌 JSON（SSR/RSC payload）
      const nd = await page.evaluate(() => {
        const el = document.getElementById('__NEXT_DATA__');
        if (!el) return null;
        try { return JSON.parse(el.textContent); } catch (e) { return null; }
      });
      if (nd) dump(`pool_r13_nextdata_${pool.id}.json`, nd);
      // 球员链接（a[href*="/players/<eaId>"]）
      const anchors = await page.evaluate(() => {
        const out = [];
        document.querySelectorAll('a[href*="/players/"]').forEach(a => {
          const m = (a.getAttribute('href') || '').match(/\/players\/(\d+)/);
          if (m) out.push({ eaId: m[1], name: (a.textContent || '').trim() });
        });
        return out.slice(0, 50);
      });
      dump(`pool_r13_anchors_${pool.id}.json`, anchors);
      console.log(`  [B] HTML 抓取: 长度=${html.length} nextData?=${!!nd} 球员链接数=${anchors.length}`);
      anchors.slice(0, 6).forEach(a => console.log(`      玩家: eaId=${a.eaId} name=${a.name}`));
    } catch (e) {
      console.log(`  [B] HTML 探测异常: ${e.message}`);
    }
  }

  await browser.close();
  console.log('\n探测完成，结果在 probe/ 目录。');
})().catch(e => { console.error('FATAL', e); process.exit(1); });
