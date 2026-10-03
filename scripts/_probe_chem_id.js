// 一次性探针：弄清 fut.gg 化学投票用的 id 是哪个字段。
// Akliouche: eaId=264862, 列表 id=145529, 已知化学数据在资源 id=50596510 下。
const { chromium } = require('playwright');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36';
const VER = 27;

function summarize(obj, max = 200) {
  // 打印每个字段名 + 类型 + 值（数字截断到便于阅读）
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    const t = typeof v;
    let val;
    if (t === 'object' && v !== null) val = '[obj ' + Object.keys(v).length + ' keys]';
    else if (t === 'string') val = v.length > 80 ? v.slice(0, 80) + '…' : v;
    else val = v;
    out[k] = t + ':' + val;
  }
  return JSON.stringify(out, null, 0).slice(0, max);
}

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--disable-blink-features=AutomatedControlled', '--no-sandbox', '--disable-dev-shm-usage'] });
  const ctx = await browser.newContext({ userAgent: UA });
  const page = await ctx.newPage();
  // passCF
  try { await page.goto('https://www.fut.gg/fc/players/?page=1', { waitUntil: 'networkidle', timeout: 60000 }); } catch (e) {}
  let ok = false;
  for (let i = 0; i < 40; i++) {
    try { ok = await page.evaluate(async () => { const r = await fetch('https://www.fut.gg/api/fut/players/v2/27/?page=1'); return r.ok; }); } catch (e) {}
    if (ok) break;
    await page.waitForTimeout(3000);
  }
  console.log('CF ok', ok);
  if (!ok) { await browser.close(); process.exit(2); }

  // 1) 详情接口（用 eaId 与 列表id 两种试）
  for (const defId of [264862, 145529]) {
    const item = await page.evaluate(async (VER, defId) => {
      const r = await fetch(`https://www.fut.gg/api/fut/player-item-definitions/${VER}/${defId}/`);
      if (!r.ok) return { err: r.status };
      const j = await r.json(); const d = j.data || j;
      return { id: d.id, eaId: d.eaId, basePlayerEaId: d.basePlayerEaId, slug: d.slug, all: Object.fromEntries(Object.entries(d).map(([k, v]) => [k, typeof v === 'object' ? '[obj]' : v])) };
    }, VER, defId);
    console.log('ITEM', defId, JSON.stringify(item).slice(0, 1200));
  }

  // 2) 列表接口里 Akliouche 的 item 全字段
  const listItem = await page.evaluate(async (VER) => {
    const r = await fetch(`https://www.fut.gg/api/fut/players/v2/${VER}/?eaId=264862`);
    if (!r.ok) return { err: r.status };
    const j = await r.json(); const arr = j.data || [];
    return arr.map(p => ({ id: p.id, eaId: p.eaId, fields: Object.fromEntries(Object.entries(p).map(([k, v]) => [k, typeof v === 'object' ? '[obj]' : v])) }));
  }, VER);
  console.log('LIST', JSON.stringify(listItem).slice(0, 1600));

  // 3) 化学端点对若干候选 id
  const candidates = [145529, 264862, 50596510];
  for (const id of candidates) {
    const c = await page.evaluate(async (VER, id) => {
      const r = await fetch(`https://www.fut.gg/api/fut/players/${VER}/${id}/chemistry-style/`);
      if (!r.ok) return { status: r.status };
      const j = await r.json(); const d = j.data || {};
      const cv = d.chemistryVotes || {};
      const total = Object.values(cv).reduce((s, x) => s + (x || 0), 0);
      return { status: r.status, total, top3: d.top3ChemistryStyles, rawKeys: Object.keys(d) };
    }, VER, id);
    console.log('CHEM', id, JSON.stringify(c));
  }
  await browser.close();
})().catch(e => { console.error('ERR', e); process.exit(1); });
