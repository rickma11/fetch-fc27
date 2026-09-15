// 探查 fut.gg 真实进化/SBC 数据集（r11）：r2.fut.gg 静态 CDN + manifest hash 引用机制。
//
// r10 已证实：fut.gg 进化/SBC 数据 = 预构建静态 JSON 放 r2.fut.gg/{ver}/，由 manifest.json 的 hash 引用。
// 数据集文件命名：{key}.v1.{hash}.json；FC27 当前进化 hash=d7517139（空串 MD5，即暂无数据）。
// 本脚本在 CF 清除的浏览器会话里直接用 fetch 取 manifest + 各数据集，看真实结构（FC27 空、FC26 有数据）。
//
// 输出：probe/r11_datasets.json
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const UA = process.env.CF_UA || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36';

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--disable-blink-features=AutomationControlled', '--no-sandbox', '--disable-dev-shm-usage'] });
  const ctx = await browser.newContext({ userAgent: UA, locale: 'en-US', viewport: { width: 1280, height: 800 }, timezoneId: 'America/New_York' });
  const page = await ctx.newPage();

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

  const out = { versions: {} };
  for (const ver of [27, 26]) {
    console.log(`\n=== FC ${ver} ===`);
    const manUrl = `https://r2.fut.gg/${ver}/manifest.json`;
    const manTxt = await page.evaluate(async u => { try { const r = await fetch(u); return await r.text(); } catch (e) { return 'ERR:' + e.message; } }, manUrl);
    let man;
    try { man = JSON.parse(manTxt); } catch (e) { console.log('  manifest 解析失败:', manTxt.slice(0, 100)); out.versions[ver] = { manifestError: manTxt.slice(0, 200) }; continue; }
    const keys = Object.keys(man);
    const evo = keys.filter(k => /evol/i.test(k));
    const sbc = keys.filter(k => /sbc/i.test(k));
    console.log('  manifest keys (' + keys.length + '):', keys.join(', '));
    console.log('  evolution keys:', evo.join(', ') || '(无)');
    console.log('  sbc keys:', sbc.join(', ') || '(无)');
    const info = { manifestKeys: keys, evo: {}, sbc: {} };
    for (const k of [...evo, ...sbc]) {
      const hash = man[k];
      const url = `https://r2.fut.gg/${ver}/${k}.v1.${hash}.json`;
      const txt = await page.evaluate(async u => { try { const r = await fetch(u); return await r.text(); } catch (e) { return 'ERR:' + e.message; } }, url);
      let meta = { url, hash, status: 'ok', len: txt.length };
      try {
        const j = JSON.parse(txt);
        const topKeys = Object.keys(j);
        let arr = null, n = '?';
        if (Array.isArray(j)) { arr = j; n = j.length; }
        else if (j.data && Array.isArray(j.data)) { arr = j.data; n = j.data.length; }
        else if (j.evolutions) { arr = j.evolutions; n = j.evolutions.length; }
        else if (j.sbcs) { arr = j.sbcs; n = j.sbcs.length; }
        meta.topKeys = topKeys.slice(0, 15);
        meta.count = n;
        if (arr && arr[0]) meta.sampleKeys = Object.keys(arr[0]).slice(0, 25);
        if (arr && arr[0]) meta.sample = JSON.stringify(arr[0]).slice(0, 600);
      } catch (e) { meta.parseError = txt.slice(0, 120); }
      console.log(`  ${k}: hash=${hash} len=${txt.length}`, meta.count !== undefined ? 'count=' + meta.count : '', meta.sampleKeys ? 'fields=' + meta.sampleKeys.join(',') : '');
      if (/evol/i.test(k)) info.evo[k] = meta; else info.sbc[k] = meta;
    }
    out.versions[ver] = info;
  }
  const outDir = path.resolve(__dirname, '..', 'probe');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'r11_datasets.json'), JSON.stringify(out, null, 2));
  console.log('\n已写出 probe/r11_datasets.json');
  await browser.close();
})().catch(e => { console.error('失败:', e); process.exit(1); });
