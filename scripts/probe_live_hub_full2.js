// 诊断探针（只读）：定位「综合性被追踪全集」的枚举方式 + 逐球员进度来源。
// 把关键原始响应落盘到 probe/live_hub/full_report2.json，由 workflow 提交回 main 供本地读回。
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'probe', 'live_hub');
fs.mkdirSync(OUT, { recursive: true });
const UA = process.env.CF_UA || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36';
const VER = Number(process.env.FC_VER || 27);
const BASE = 'https://www.fut.gg/api/fut';
const result = { generatedAt: new Date().toISOString() };

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--disable-blink-features=AutomatedControlled', '--no-sandbox', '--disable-dev-shm-usage'] });
  const ctx = await browser.newContext({ userAgent: UA, locale: 'en-US', viewport: { width: 1280, height: 800 }, timezoneId: 'America/New_York' });
  const page = await ctx.newPage();
  await page.goto('https://www.fut.gg/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  const LIGHT = `${BASE}/players/v2/${VER}/?page=1`;
  let passed = false;
  for (let i = 0; i < 40; i++) {
    try {
      const r = await page.request.get(LIGHT, { headers: { Accept: 'application/json' }, timeout: 20000 });
      const t = await r.text();
      if (r.status() === 200 && (t.trim().startsWith('{') || t.trim().startsWith('['))) { passed = true; console.log('CF ok', i + 1); break; }
      console.log('wait CF', r.status());
    } catch (e) { console.log('LIGHT err', e.message); }
    await page.waitForTimeout(3000);
  }
  if (!passed) { await browser.close(); console.error('CF fail'); process.exit(2); }

  const api = async (u) => {
    for (let a = 1; a <= 4; a++) {
      try {
        const r = await page.request.get(u, { headers: { Accept: 'application/json' }, timeout: 60000 });
        const t = await r.text();
        if (r.status() === 200 && (t.trim().startsWith('{') || t.trim().startsWith('['))) return t;
        console.log('  api non-200', u.slice(0, 95), r.status(), t.slice(0, 160));
      } catch (e) { console.log('  api err', e.message); }
      if (a < 4) await page.waitForTimeout(3000);
    }
    return null;
  };
  const jget = (t) => { try { return JSON.parse(t); } catch (e) { return null; } };

  // (A) has_dynamic 枚举是否可用
  const hd = await api(`${BASE}/players/v2/${VER}/?has_dynamic=true&page=1`);
  result.has_dynamic = { rawLen: hd ? hd.length : 0, first800: hd ? hd.slice(0, 800) : null };
  if (hd) { const j = jget(hd); result.has_dynamic.playersLen = (j && j.data && j.data.players || []).length; if (j && j.data && j.data.players && j.data.players[0]) result.has_dynamic.hubKeys = Object.keys(j.data.players[0]).filter(k => /track|dynamic|hub|live/i.test(k)); }

  // (B) 普通 list 首球员是否含 liveHubTrackerId
  const nl = await api(`${BASE}/players/v2/${VER}/?page=1`);
  result.list_keys = null;
  if (nl) { const j = jget(nl); const p0 = (j && j.data && j.data.players || [])[0]; if (p0) result.list_keys = { hubKeys: Object.keys(p0).filter(k => /track|dynamic|hub|live/i.test(k)), totalResults: (j.data && j.data.pagination && j.data.pagination.totalResults) }; }

  // (C) 完整 definition-data（Adeyemi 50583500 OTW / Veiga 50605554 DFG/34）— 看 objectiveGroup* 与是否含 playerValue/进度
  result.def = {};
  for (const ea of [50583500, 50605554]) {
    const dt = await api(`${BASE}/players/v2/definition-data/?game=${VER}&slugs=${VER}-${ea}`);
    if (dt) {
      const a = jget(dt);
      const item = Array.isArray(a) ? a[0] : (a && a.data ? a.data[0] : null);
      if (item) {
        // 剥出所有含 hub/track/objective/upgrade/progress 的键 + 其值（截断）
        const picked = {};
        for (const k of Object.keys(item)) { if (/track|objective|hub|live|upgrade|progress|playerValue|campaign/i.test(k)) picked[k] = (typeof item[k] === 'object') ? JSON.stringify(item[k]).slice(0, 400) : item[k]; }
        result.def[ea] = { liveHubTrackerId: item.liveHubTrackerId, picked };
      } else result.def[ea] = { parseNoItem: true };
    } else result.def[ea] = { null: true };
  }

  fs.writeFileSync(path.join(OUT, 'full_report2.json'), JSON.stringify(result, null, 2));
  console.log('WROTE full_report2.json');
  await browser.close();
})().catch(e => { console.error('fail', e); process.exit(1); });
