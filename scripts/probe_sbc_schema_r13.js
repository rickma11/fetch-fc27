// r13：捕获 fut.gg SBC 列表 JSON 的完整字段 + 确认详情端点路径（写正式抓取脚本的前置 research）。
// 机制同 r12：过 CF 的真实浏览器内 page.evaluate(fetch)。
// 输出：probe/r13_sbc_list.json（FC26 全部 SBC sets 全量） + probe/r13_sbc_schema.json（字段摘要 + 详情候选探测）。
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const UA = process.env.CF_UA || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36';
const VER = parseInt(process.env.FC_VER || '26', 10);

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--disable-blink-features=AutomatedControlled', '--no-sandbox', '--disable-dev-shm-usage'] });
  const ctxPage = await browser.newContext({ userAgent: UA, locale: 'en-US', viewport: { width: 1280, height: 800 }, timezoneId: 'America/New_York' });
  const page = await ctxPage.newPage();

  console.log('过 Cloudflare ...');
  await page.goto('https://www.fut.gg/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  let passed = false;
  for (let i = 0; i < 30; i++) {
    let status = -1;
    try { status = await page.evaluate(async () => { try { const r = await fetch('https://www.fut.gg/api/fut/players/v2/27/?page=1', { headers: { Accept: 'application/json' } }); return r.status; } catch (e) { return -1; } }); } catch (e) {}
    if (status === 200) { passed = true; break; }
    await page.waitForTimeout(3000);
  }
  if (!passed) { await browser.close(); console.error('CF 未过'); process.exit(1); }

  const out = { ver: VER, listPages: [], detailCandidates: [], fc27: {} };

  // ---- 全量翻页抓列表 ----
  let p = 1, totalPages = 1, all = [];
  while (p <= totalPages && p <= 12) {
    const url = `https://www.fut.gg/api/fut/sbc/${VER}?page=${p}`;
    const j = await page.evaluate(async u => {
      try { const r = await fetch(u, { headers: { Accept: 'application/json' } }); const json = await r.json(); return { status: r.status, ct: r.headers.get('content-type'), json }; }
      catch (e) { return { error: e.message }; }
    }, url);
    if (j.error || j.status !== 200) { out.listPages.push({ url, error: j.error || j.status }); break; }
    const data = j.json.data || [];
    out.listPages.push({ url, status: j.status, count: data.length, totalPages: j.json.totalPages, totalCount: j.json.totalCount, keys: data[0] ? Object.keys(data[0]) : [] });
    all.push(...data);
    totalPages = j.json.totalPages || 1;
    if (j.json.next == null) break;
    p++;
  }
  out.allSetsCount = all.length;
  out.firstSetKeys = all[0] ? Object.keys(all[0]) : [];
  out.firstSetSample = all[0];
  out.firstSetDefKeys = (all[0] && all[0].def) ? Object.keys(all[0].def) : (all[0] ? null : null);
  if (all[0] && all[0].def) out.firstSetDefSample = all[0].def;

  // ---- 详情端点候选探测（用第一个 set 的 slug / eaId） ----
  const s = all[0];
  if (s) {
    const slug = s.slug, eaId = s.eaId;
    const cands = [
      `https://www.fut.gg/api/fut/sbc/${VER}/${slug}`,
      `https://www.fut.gg/api/fut/sbc/${VER}/${eaId}`,
      `https://www.fut.gg/api/fut/sbc/set/${VER}/${slug}`,
      `https://www.fut.gg/api/fut/sbc/${VER}/set/${slug}`
    ];
    for (const c of cands) {
      const d = await page.evaluate(async u => {
        try { const r = await fetch(u, { headers: { Accept: 'application/json' } }); const t = await r.text(); return { status: r.status, ct: r.headers.get('content-type'), head: t.slice(0, 320) }; }
        catch (e) { return { error: e.message }; }
      }, c);
      out.detailCandidates.push({ url: c, ...d });
    }
  }

  // ---- FC27 是否已有 SBC ----
  out.fc27 = await page.evaluate(async u => {
    try { const r = await fetch(u, { headers: { Accept: 'application/json' } }); const t = await r.text(); return { status: r.status, head: t.slice(0, 200) }; }
    catch (e) { return { error: e.message }; }
  }, `https://www.fut.gg/api/fut/sbc/27`);

  const dir = path.resolve(__dirname, '..', 'probe');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'r13_sbc_list.json'), JSON.stringify({ ver: VER, total: all.length, sets: all }, null, 2));
  fs.writeFileSync(path.join(dir, 'r13_sbc_schema.json'), JSON.stringify(out, null, 2));
  console.log('\n已写出 probe/r13_sbc_list.json + probe/r13_sbc_schema.json | sets=', all.length);
  await browser.close();
})().catch(e => { console.error('失败:', e); process.exit(1); });
