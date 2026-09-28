// 增强探针（只读）：过 CF 后，对比两条「被追踪球员」信号，并定位逐球员进度的真实来源。
//   ① live-hub 聚合 API：data.players[]（当前实测 6 人，被追踪 + 含进度）
//   ② players/v2 has_dynamic 列表 + definition-data 批量反查 liveHubTrackerId（综合性的「哪些卡被追踪」信号）
//   ③ 对「在 ② 中被追踪、但不在 ① 里」的球员，试探逐球员进度来源：
//        - definition-data 单 slug 是否含 tracker/objectives/playerValue
//        - live-hub 是否支持 ?player_ea_id= 单球员查询
// 输出 probe/live_hub/full_report.json + 控制台汇总。不落库、不改每日管线。
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'probe', 'live_hub');
fs.mkdirSync(OUT, { recursive: true });

const UA = process.env.CF_UA || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36';
const VER = Number(process.env.FC_VER || 27);
const BASE = 'https://www.fut.gg/api/fut';

(async () => {
  console.log('启动 Chromium (headless) ...');
  const browser = await chromium.launch({ headless: true, args: ['--disable-blink-features=AutomatedControlled', '--no-sandbox', '--disable-dev-shm-usage'] });
  const ctx = await browser.newContext({ userAgent: UA, locale: 'en-US', viewport: { width: 1280, height: 800 }, timezoneId: 'America/New_York' });
  const page = await ctx.newPage();
  page.on('console', m => { const t = m.text(); if (/error|fail|denied|challenge|redirect/i.test(t)) console.log('[browser]', t); });

  console.log('打开 fut.gg 过 Cloudflare ...');
  await page.goto('https://www.fut.gg/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  const LIGHT = `${BASE}/players/v2/${VER}/?page=1`;
  let passed = false;
  for (let i = 0; i < 40; i++) {
    try {
      const r = await page.request.get(LIGHT, { headers: { Accept: 'application/json' }, timeout: 20000 });
      const t = await r.text();
      if (r.status() === 200 && (t.trim().startsWith('{') || t.trim().startsWith('['))) { passed = true; console.log(`Cloudflare 已通过（第 ${i + 1} 次）`); break; }
      console.log(`等待 CF... status=${r.status()} (${i + 1}/40)`);
    } catch (e) { console.log(` LIGHT 异常 ${e.message}`); }
    await page.waitForTimeout(3000);
  }
  if (!passed) { await browser.close(); console.error('未能过 Cloudflare'); process.exit(2); }

  const api = async (u) => {
    for (let a = 1; a <= 4; a++) {
      try {
        const r = await page.request.get(u, { headers: { Accept: 'application/json' }, timeout: 60000 });
        const t = await r.text();
        if (r.status() === 200 && (t.trim().startsWith('{') || t.trim().startsWith('['))) return t;
        console.log('  api 非预期', u.slice(0, 90), 'status', r.status(), 'preview', t.slice(0, 120));
      } catch (e) { console.log('  api err', e.message); }
      if (a < 4) await page.waitForTimeout(3000);
    }
    return null;
  };

  // ① live-hub 聚合
  const lhText = await api(`${BASE}/live-hub/${VER}/`);
  let lh = null;
  try { lh = JSON.parse(lhText); } catch (e) { console.log('live-hub 解析失败', e.message); }
  const lhPlayers = (lh && lh.data && Array.isArray(lh.data.players)) ? lh.data.players : [];
  const lhByBase = {};
  for (const p of lhPlayers) {
    const c = p.card || {};
    let ea = c.eaId != null ? Number(c.eaId) : null;
    if (ea == null && p.playerItemEaId != null) ea = Number(p.playerItemEaId);
    if (ea != null) lhByBase[ea] = p.trackerId;
  }
  console.log('① LIVE-HUB players =', lhPlayers.length, 'baseEaIds =', Object.keys(lhByBase).join(','));

  // ② has_dynamic 列表 + definition-data 批量
  const slugs = [];
  let pg = 1;
  while (pg <= 15) {
    const t = await api(`${BASE}/players/v2/${VER}/?has_dynamic=true&page=${pg}`);
    if (!t) break;
    let j; try { j = JSON.parse(t); } catch (e) { console.log('has_dynamic 解析失败', e.message); break; }
    const arr = (j.data && j.data.players) || [];
    for (const pl of arr) {
      const ea = pl.eaId != null ? Number(pl.eaId) : null;
      const slug = pl.slug || (ea != null ? `${VER}-${ea}` : null);
      if (slug) slugs.push(slug);
    }
    console.log('  has_dynamic page', pg, 'count', arr.length, '累计', slugs.length);
    const pag = (j.data && j.data.pagination) || {};
    if (!arr.length) break;
    if (pag.totalPages && pag.currentPages && pag.currentPage >= pag.totalPages) break;
    if (pag.totalPages && pg >= pag.totalPages) break;
    pg++;
  }
  console.log('② has_dynamic 动态卡总数 =', slugs.length);

  const defMap = {}; // eaId -> liveHubTrackerId
  for (let i = 0; i < slugs.length; i += 50) {
    const batch = slugs.slice(i, i + 50);
    const t = await api(`${BASE}/players/v2/definition-data/?game=${VER}&slugs=${encodeURIComponent(batch.join(','))}`);
    if (!t) continue;
    let arr; try { arr = JSON.parse(t); } catch (e) { console.log('def 解析失败', e.message); continue; }
    if (!Array.isArray(arr)) arr = (arr.data) ? arr.data : [];
    for (const d of arr) {
      let ea = d.eaId != null ? Number(d.eaId) : null;
      if (ea == null && d.slug) { const m = /(\d+)$/.exec(d.slug); if (m) ea = Number(m[1]); }
      if (ea != null) defMap[ea] = (d.liveHubTrackerId != null) ? d.liveHubTrackerId : null;
    }
    console.log('  def batch', i, '->', arr.length, 'items');
  }
  const tracked = Object.entries(defMap).filter(([, v]) => v != null);
  const dist = {};
  for (const [, v] of tracked) dist[v] = (dist[v] || 0) + 1;
  console.log('② TRACKED (liveHubTrackerId!=null) 总数 =', tracked.length, '分布 =', JSON.stringify(dist));

  const missing = tracked.filter(([ea]) => !lhByBase[ea]);
  console.log('②→① 被追踪但不在 live-hub 的人数 =', missing.length);
  console.log('   缺失 eaIds(前 30) =', missing.slice(0, 30).map(x => x[0]).join(','));

  // ③ 对缺失样本试探逐球员进度来源
  const probeEaIds = [50583500, 50605554]; // Adeyemi OTW, Veiga DFG（来自文档）
  const tid34 = missing.find(([, tid]) => String(tid) === '34');
  if (tid34) probeEaIds.push(Number(tid34[0]));
  const perPlayer = {};
  for (const ea of probeEaIds) {
    const slug = `${VER}-${ea}`;
    const dt = await api(`${BASE}/players/v2/definition-data/?game=${VER}&slugs=${slug}`);
    let dInfo = null;
    if (dt) { try { const a = JSON.parse(dt); const item = Array.isArray(a) ? a[0] : (a.data ? a.data[0] : null); if (item) { dInfo = { liveHubTrackerId: item.liveHubTrackerId, trackerKeys: Object.keys(item).filter(k => /track|objective|liveHub|upgrade|playerValue|progress/i.test(k)) }; } } catch (e) {} }
    const lt = await api(`${BASE}/live-hub/${VER}/?player_ea_id=${ea}`);
    let lInfo = null;
    if (lt) { try { const a = JSON.parse(lt); const pls = (a.data && a.data.players) || []; lInfo = { count: pls.length, sample: pls.slice(0, 2).map(p => ({ ea: p.card && p.card.eaId, tid: p.trackerId, objs: (p.tracker && p.tracker.objectives || []).length })) }; } catch (e) { lInfo = { parseFail: true }; } }
    perPlayer[ea] = { def: dInfo, liveHubQuery: lInfo };
    console.log('   探针 ea', ea, 'def=', JSON.stringify(dInfo), 'liveHubQuery=', JSON.stringify(lInfo));
  }

  const result = {
    liveHubCount: lhPlayers.length,
    liveHubBaseEaIds: Object.keys(lhByBase),
    dynamicCount: slugs.length,
    trackedCount: tracked.length,
    trackerDist: dist,
    missingFromLiveHub: missing.map(x => x[0]),
    perPlayer
  };
  fs.writeFileSync(path.join(OUT, 'full_report.json'), JSON.stringify(result, null, 2));
  console.log('\n=== RESULT ===');
  console.log(JSON.stringify(result, null, 2));
  await browser.close();
})().catch(e => { console.error('探针失败:', e); process.exit(1); });
