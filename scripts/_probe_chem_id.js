// 一次性探针：弄清 fut.gg 化学投票用的 id 是哪个字段。
// Akliouche: eaId=264862, 列表 id=145529, 已知化学数据在资源 id=50596510 下。
const { chromium } = require('playwright');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36';
const VER = 27;

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--disable-blink-features=AutomatedControlled', '--no-sandbox', '--disable-dev-shm-usage'] });
  const ctx = await browser.newContext({ userAgent: UA });
  const page = await ctx.newPage();
  try { await page.goto('https://www.fut.gg/fc/players/?page=1', { waitUntil: 'networkidle', timeout: 60000 }); } catch (e) {}
  let ok = false;
  for (let i = 0; i < 40; i++) {
    try { ok = await page.evaluate(async () => { const r = await fetch('https://www.fut.gg/api/fut/players/v2/27/?page=1'); return r.ok; }); } catch (e) {}
    if (ok) break;
    await page.waitForTimeout(3000);
  }
  console.log('CF ok', ok);
  if (!ok) { await browser.close(); process.exit(2); }

  // 1) 详情接口：用 eaId 与 列表id 两种试，打印所有 >100000 的数字字段
  for (const defId of [264862, 145529]) {
    const item = await page.evaluate(({ VER, defId }) => {
      return fetch(`https://www.fut.gg/api/fut/player-item-definitions/${VER}/${defId}/`)
        .then(r => r.ok ? r.json() : { _err: r.status })
        .then(j => {
          const d = j.data || j;
          const big = {};
          for (const [k, v] of Object.entries(d)) if (typeof v === 'number' && v > 100000) big[k] = v;
          return { id: d.id, eaId: d.eaId, basePlayerEaId: d.basePlayerEaId, slug: d.slug, big };
        });
    }, { VER, defId });
    console.log('ITEM', defId, JSON.stringify(item));
  }

  // 2) 列表接口里 Akliouche 的 item 全字段 + 大数字字段
  const listItem = await page.evaluate(({ VER }) => {
    return fetch(`https://www.fut.gg/api/fut/players/v2/${VER}/?eaId=264862`)
      .then(r => r.ok ? r.json() : { _err: r.status })
      .then(j => {
        const arr = j.data || [];
        return arr.map(p => {
          const big = {};
          for (const [k, v] of Object.entries(p)) if (typeof v === 'number' && v > 100000) big[k] = v;
          return { id: p.id, eaId: p.eaId, basePlayerEaId: p.basePlayerEaId, slug: p.slug, big, all: Object.fromEntries(Object.entries(p).map(([k, v]) => [k, typeof v === 'object' ? '[obj]' : v])) };
        });
      });
  }, { VER });
  console.log('LIST', JSON.stringify(listItem).slice(0, 2000));

  // 3) 化学端点对若干候选 id
  for (const id of [145529, 264862, 50596510]) {
    const c = await page.evaluate(({ VER, id }) => {
      return fetch(`https://www.fut.gg/api/fut/players/${VER}/${id}/chemistry-style/`)
        .then(r => {
          if (!r.ok) return { status: r.status };
          return r.json().then(j => {
            const d = j.data || {};
            const cv = d.chemistryVotes || {};
            const total = Object.values(cv).reduce((s, x) => s + (x || 0), 0);
            return { status: r.status, total, top3: d.top3ChemistryStyles, rawKeys: Object.keys(d) };
          });
        });
    }, { VER, id });
    console.log('CHEM', id, JSON.stringify(c));
  }
  await browser.close();
})().catch(e => { console.error('ERR', e); process.exit(1); });
