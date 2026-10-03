// 探针 v2：定位化学端点用的 card id（50596510 来源）。
// 已知 Akliouche eaId=264862，化学卡级 id=50596510（total 503），玩家级 eaId→total 19。
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

  // A) 玩家详情 API（按 eaId）看结构与卡列表
  const detail = await page.evaluate(({ VER }) => {
    return fetch(`https://www.fut.gg/api/fut/players/${VER}/264862/`)
      .then(r => r.ok ? r.json() : { _err: r.status })
      .then(j => {
        const d = j.data || j;
        const keys = Object.keys(d);
        // 找含 id 的数组（卡列表）
        const arrays = {};
        for (const k of keys) if (Array.isArray(d[k])) arrays[k] = d[k].length;
        return { keys, arrays, sample: Object.fromEntries(keys.slice(0, 20).map(k => [k, typeof d[k] === 'object' ? (Array.isArray(d[k]) ? '[arr '+d[k].length+']' : '[obj]') : d[k]])) };
      });
  }, { VER });
  console.log('DETAIL', JSON.stringify(detail).slice(0, 1500));

  // B) 重新测试 v2 列表按 eaId 过滤是否真生效：取前几页每页检查 eaId 分布，并收集 Akliouche 的条目
  //    先验证过滤参数名：用 ?eaId=264862 看返回的 eaId 是否=264862
  const filterTest = await page.evaluate(({ VER }) => {
    return fetch(`https://www.fut.gg/api/fut/players/v2/${VER}/?eaId=264862&page=1`)
      .then(r => r.ok ? r.json() : { _err: r.status })
      .then(j => {
        const arr = j.data || [];
        return { count: arr.length, eaIds: arr.map(p => p.eaId), ids: arr.map(p => p.id) };
      });
  }, { VER });
  console.log('FILTER', JSON.stringify(filterTest));

  // C) 如果过滤生效拿到 Akliouche 多个卡，逐个测化学，找 total 最大（≈503）的那个 id
  if (filterTest.ids && filterTest.ids.length) {
    for (const id of filterTest.ids.slice(0, 8)) {
      const c = await page.evaluate(({ VER, id }) => {
        return fetch(`https://www.fut.gg/api/fut/players/${VER}/${id}/chemistry-style/`)
          .then(r => r.ok ? r.json().then(j => ({ status: r.status, total: Object.values(j.data?.chemistryVotes||{}).reduce((s,x)=>s+(x||0),0), top3: j.data?.top3ChemistryStyles })) : { status: r.status });
      }, { VER, id });
      console.log('CHEMID', id, JSON.stringify(c));
    }
  } else {
    // 过滤没生效：尝试直接查 50596510 出现在哪个接口——查 players/v2 全字段看有无该数字
    const byId = await page.evaluate(({ VER, id }) => {
      return fetch(`https://www.fut.gg/api/fut/players/v2/${VER}/?id=50596510`)
        .then(r => r.ok ? r.json() : { _err: r.status })
        .then(j => { const arr = j.data || []; return { count: arr.length, first: arr[0] ? { id: arr[0].id, eaId: arr[0].eaId, commonName: arr[0].commonName } : null }; });
    }, { VER, id: 50596510 });
    console.log('BYID50596510', JSON.stringify(byId));
  }
  await browser.close();
})().catch(e => { console.error('ERR', e); process.exit(1); });
