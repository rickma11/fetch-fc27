// 只读诊断探针（第 4 轮）：定位「#tracker 到底出现在哪个页面」。
//
// 前 3 轮结论：
//   R1: /players/<slug>/ 200；/player/<slug>/ 404；原始 HTML 无 #tracker（CSR，非 SSR 直出）
//   R2: 渲染后 page.content() 恒有 /live-hub/ 链接，但 #tracker 等待超时（empty:hidden 陷阱）
//   R3: 改 state:'attached' + 沉降 3s + 无条件解析后 → **6 张样本卡渲染后均无 #tracker**，
//       但有 /live-hub/ 链接 ⇒ 说明 tracker 区块不在「普通被追踪球员页」，或需要额外触发。
//
// 本轮三个新假设（一次 run 内全部验证）：
//   H1: #tracker 在 **live-hub 网页**（/live-hub/、/live-hub/27/）上，而不在球员页
//   H2: #tracker 只在 **live-hub 精选 6 人** 的球员页出现（普通被追踪卡没有）
//   H3: #tracker 是 **滚动懒加载**（需滚到视口内才渲染）
//
// 结果落盘 probe/live_hub/detail_probe.json，由 workflow 提交回 main 供本地读回。
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'probe', 'live_hub');
const VER = Number(process.argv[2] || process.env.FC_VER || 27);
const BASE = 'https://www.fut.gg/api/fut';
const SITE = 'https://www.fut.gg';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36';

// 看门狗：CI Chromium 有 ~20min 挂死前科，超时强制写出已有结果并退出
const HARD_TIMEOUT_MS = Number(process.env.PROBE_TIMEOUT_MS || 12 * 60 * 1000);
const out = { generatedAt: new Date().toISOString(), VER, round: 4, note: '', sections: {} };
function dump() {
  try {
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, 'detail_probe.json'), JSON.stringify(out, null, 2));
  } catch (e) { console.log('dump err', e.message); }
}
const watchdog = setTimeout(() => {
  out.note = 'WATCHDOG TIMEOUT（部分结果）';
  dump();
  console.error('WATCHDOG TIMEOUT — 已写出部分结果');
  process.exit(5);
}, HARD_TIMEOUT_MS);

function jget(t) { try { return JSON.parse(t); } catch (e) { return null; } }
async function apiGet(page, url, accept) {
  for (let a = 1; a <= 3; a++) {
    try {
      const r = await page.request.get(url, { headers: { Accept: accept || 'application/json' }, timeout: 60000 });
      const t = await r.text();
      if (r.status() === 200) return { status: 200, body: t };
      console.log('  api', url.slice(0, 90), 'status', r.status(), t.slice(0, 100));
      return { status: r.status(), body: t };
    } catch (e) { console.log('  api err', e.message); }
    if (a < 3) await page.waitForTimeout(3000);
  }
  return null;
}

// 解析 #tracker 区块（沿用 R1-R3 解析器，命中即直接用）
function parseTracker(html) {
  const idx = html.indexOf('id="tracker"');
  if (idx < 0) return null;
  const chunk = html.slice(idx, idx + 25000);
  const res = { campaign: '', club: '', objectives: [] };
  let m = /href="\/live-hub\/campaigns\/[^"]*"[^>]*>\s*([^<]*)</.exec(chunk);
  if (m) res.campaign = m[1].trim();
  m = /<span class="text-xs font-bold text-white">([^<]*)</.exec(chunk);
  if (m) res.club = m[1].trim();

  const CARD = /<div class="flex flex-col gap-2 rounded border p-3 bg-gray-900\/30/;
  const cards = chunk.split(CARD).slice(1);
  for (const card of cards) {
    const t = /<span class="text-sm font-medium leading-tight">([^<]*)<\/span>/.exec(card);
    if (!t) continue;
    const title = t[1].trim();
    const repeatable = /lucide-repeat|Repeatable/.test(card);
    const green = (card.match(/h-1\.5 flex-1 rounded-sm bg-green-500/g) || []).length;
    const gray = (card.match(/h-1\.5 flex-1 rounded-sm bg-gray-900/g) || []).length;
    const rewards = [...card.matchAll(/<span class="text-\[11px\] text-gray-200 bg-gray-800 rounded px-1\.5 py-0\.5">([^<]*)<\/span>/g)].map(x => x[1].trim());
    const nm = /\(\s*(\d+)\s*\/\s*(\d+)\s*\)/.exec(title);
    res.objectives.push({
      title,
      labelProgress: nm ? nm[0] : null,
      repeatable,
      greenSegments: green,
      totalSegments: green + gray,
      rewards
    });
    if (/View Fixtures/.test(card)) break;
  }
  return res;
}

// DOM 实况诊断：不看解析结果，直接问浏览器「页面上到底有什么」
async function domProbe(page) {
  return await page.evaluate(() => {
    const html = document.documentElement.outerHTML;
    const anchors = [...document.querySelectorAll('a[href*="/live-hub"]')].slice(0, 8).map(a => ({ href: a.getAttribute('href'), text: (a.textContent || '').trim().slice(0, 60) }));
    const playerLinks = new Set([...document.querySelectorAll('a[href^="/players/"]')].map(a => a.getAttribute('href')));
    let snippet = '';
    const i = html.toLowerCase().indexOf('tracker');
    if (i >= 0) snippet = html.slice(Math.max(0, i - 400), i + 1200);
    else {
      const j = html.indexOf('/live-hub/');
      if (j >= 0) snippet = html.slice(Math.max(0, j - 400), j + 1200);
    }
    return {
      finalUrl: location.href,
      title: (document.title || '').slice(0, 120),
      trackerIdCount: document.querySelectorAll('#tracker').length,
      trackerWordHits: (html.toLowerCase().match(/tracker/g) || []).length,
      liveHubAnchors: anchors,
      playerLinkCount: playerLinks.size,
      htmlBytes: html.length,
      snippet
    };
  });
}

// 访问一个页面：goto → 等首屏 → (可选)滚到底触发懒加载 → DOM 诊断
async function visit(page, url, opts) {
  const o = opts || {};
  const rec = { url, err: '', phases: {} };
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 40000 });
    await page.waitForTimeout(2500);
    rec.phases.first = await domProbe(page);
    if (o.scroll !== false) {
      // H3：滚到底 + 回到中部，触发 IntersectionObserver 懒加载
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(2500);
      await page.evaluate(() => window.scrollTo(0, Math.floor(document.body.scrollHeight / 2)));
      await page.waitForTimeout(2000);
      rec.phases.afterScroll = await domProbe(page);
    }
    const html = await page.content();
    rec.htmlBytes = html.length;
    rec.tracker = parseTracker(html);
  } catch (e) { rec.err = 'goto: ' + e.message; }
  const best = rec.phases.afterScroll || rec.phases.first || {};
  rec.summary = {
    finalUrl: best.finalUrl || '',
    status: rec.err ? 'ERR' : ((best.trackerIdCount || 0) > 0 ? 'HAS_TRACKER' : (rec.tracker ? 'PARSED' : 'NO_TRACKER')),
    trackerIdCount: best.trackerIdCount || 0,
    trackerWordHits: best.trackerWordHits || 0,
    playerLinkCount: best.playerLinkCount || 0,
    liveHubAnchors: (best.liveHubAnchors || []).slice(0, 4),
    objectives: rec.tracker ? rec.tracker.objectives.length : 0,
    title: best.title || ''
  };
  rec.snippet = (best.snippet || '').slice(0, 1600);
  return rec;
}

(async () => {
  console.log('启动 Chromium ...');
  const browser = await chromium.launch({ headless: true, args: ['--disable-blink-features=AutomatedControlled', '--no-sandbox', '--disable-dev-shm-usage'] });
  const ctx = await browser.newContext({ userAgent: UA, locale: 'en-US', viewport: { width: 1280, height: 900 }, timezoneId: 'America/New_York' });
  const page = await ctx.newPage();
  page.on('console', m => { const t = m.text(); if (/error|fail|denied|challenge|redirect/i.test(t)) console.log('[browser]', t); });

  console.log('过 Cloudflare ...');
  await page.goto(SITE + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  const LIGHT = `${BASE}/players/v2/${VER}/?page=1`;
  let passed = false;
  for (let i = 0; i < 40; i++) {
    try {
      const r = await page.request.get(LIGHT, { headers: { Accept: 'application/json' }, timeout: 20000 });
      const t = await r.text();
      if (r.status() === 200) { passed = true; console.log('CF 通过', i + 1); break; }
    } catch (e) { }
    await page.waitForTimeout(3000);
  }
  if (!passed) { out.note = 'CF 未通过'; dump(); await browser.close(); process.exit(2); }

  // ① live-hub API：拿精选 6 人（H2 的对照组）
  console.log('\n① live-hub API 精选 ...');
  const lh = await apiGet(page, `${BASE}/live-hub/${VER}/`);
  const featured = [];
  if (lh && lh.status === 200) {
    const j = jget(lh.body);
    const rows = Array.isArray(j) ? j : (j && (j.data || j.players) ? (j.data || j.players) : []);
    for (const p of rows) {
      const ea = p.eaId != null ? Number(p.eaId) : null;
      if (ea) featured.push({ eaId: ea, slug: p.slug || `27-${ea}`, name: p.name || p.commonName || '' });
    }
  }
  out.sections.featured = featured;
  console.log('  精选', featured.length, featured.map(f => f.eaId).join(','));

  // ② 枚举 has_dynamic → 每个 trackerId 取 1 张（H2 的实验组：非精选的普通被追踪卡）
  console.log('\n② 枚举 has_dynamic ...');
  const dyn = {};
  for (let pg = 1; pg <= 6; pg++) {
    const r = await apiGet(page, `${BASE}/players/v2/${VER}/?has_dynamic=true&page=${pg}`);
    if (!r || r.status !== 200) break;
    const arr = (jget(r.body) && Array.isArray(jget(r.body).data)) ? jget(r.body).data : [];
    for (const pl of arr) {
      const ea = pl.eaId != null ? Number(pl.eaId) : null;
      if (!ea) continue;
      dyn[ea] = { slug: pl.slug || '', clubName: pl.clubName || '' };
    }
    if (!arr.length) break;
  }
  const eaIds = Object.keys(dyn);
  out.sections.dynCount = eaIds.length;

  const defMap = {};
  const slugs = eaIds.map(e => dyn[e].slug).filter(Boolean);
  for (let i = 0; i < slugs.length; i += 50) {
    const batch = slugs.slice(i, i + 50);
    const r = await apiGet(page, `${BASE}/players/v2/definition-data/?game=${VER}&slugs=${encodeURIComponent(batch.join(','))}`);
    if (!r || r.status !== 200) continue;
    const j = jget(r.body);
    const list = Array.isArray(j) ? j : (j && j.data ? j.data : []);
    for (const d of list) {
      let ea = d.eaId != null ? Number(d.eaId) : null;
      if (ea == null && d.slug) { const mm = /(\d+)$/.exec(d.slug); if (mm) ea = Number(mm[1]); }
      if (ea == null) continue;
      defMap[String(ea)] = (d.liveHubTrackerId != null) ? d.liveHubTrackerId : null;
    }
  }
  const byTid = {};
  for (const e of eaIds) {
    const tid = defMap[e];
    if (tid == null) continue;
    (byTid[tid] = byTid[tid] || []).push(e);
  }
  out.sections.trackerIdDist = Object.keys(byTid).reduce((a, k) => (a[k] = byTid[k].length, a), {});
  console.log('  trackerId 分布', JSON.stringify(out.sections.trackerIdDist));

  // ③ H1：live-hub 网页本体
  console.log('\n③ H1 live-hub 网页 ...');
  const featuredSet = new Set(featured.map(f => String(f.eaId)));
  const lhPages = ['/live-hub/', `/live-hub/${VER}/`, '/live-hub/campaigns/'];
  out.sections.liveHubPages = [];
  for (const p of lhPages) {
    const rec = await visit(page, SITE + p);
    rec.page = p;
    out.sections.liveHubPages.push(rec);
    console.log(`  ${p} → ${rec.summary.status} #tracker=${rec.summary.trackerIdCount} wordHits=${rec.summary.trackerWordHits} playerLinks=${rec.summary.playerLinkCount} ${rec.err || ''}`);
  }

  // ④ H2：精选 2 人 vs 普通被追踪卡（每 tid 1 张）
  console.log('\n④ H2 球员页 ...');
  const picks = [];
  for (const f of featured.slice(0, 2)) picks.push({ eaId: f.eaId, slug: f.slug, tag: 'featured' });
  for (const tid of Object.keys(byTid).sort()) {
    const cand = byTid[tid].filter(e => !featuredSet.has(e));
    if (cand.length) picks.push({ eaId: Number(cand[0]), slug: dyn[cand[0]].slug, tag: 'tid' + tid });
  }
  out.sections.picks = picks;
  out.sections.playerPages = [];
  for (const p of picks) {
    const rec = await visit(page, `${SITE}/players/${p.slug}/`);
    rec.eaId = p.eaId; rec.tag = p.tag;
    out.sections.playerPages.push(rec);
    console.log(`  ${p.tag} ${p.eaId} → ${rec.summary.status} #tracker=${rec.summary.trackerIdCount} objs=${rec.summary.objectives} ${rec.err || ''}`);
  }

  // ⑤ 兜底：若上面全无 #tracker，对第一张普通卡再试 URL 变体（排除「路径写错」这个最朴素的可能）
  const anyHit = out.sections.playerPages.some(r => r.summary.trackerIdCount > 0) || out.sections.liveHubPages.some(r => r.summary.trackerIdCount > 0);
  if (!anyHit && picks.length) {
    console.log('\n⑤ 兜底 URL 变体 ...');
    const p = picks[0];
    const variants = [`${SITE}/players/${p.slug}/${VER}/`, `${SITE}/players/${p.slug}/?game=${VER}`, `${SITE}/players/${p.slug}/tracking/`];
    out.sections.urlVariants = [];
    for (const v of variants) {
      const rec = await visit(page, v, { scroll: false });
      rec.url = v;
      out.sections.urlVariants.push({ url: v, summary: rec.summary, err: rec.err });
      console.log(`  ${v} → ${rec.summary.status} finalUrl=${rec.summary.finalUrl} ${rec.err || ''}`);
    }
  }

  out.note = anyHit ? 'HIT: 至少一处页面渲染出 #tracker' : 'MISS: 本轮所有页面渲染后均无 #tracker';
  clearTimeout(watchdog);
  await browser.close();
  dump();
  console.log('\n===== 探针结果 =====');
  console.log(out.note);
  console.log(JSON.stringify(out.sections.trackerIdDist), 'dyn', out.sections.dynCount);
  process.exit(0);
})().catch(e => { console.error('ERR', e); out.note = 'ERR ' + e.message; dump(); process.exit(1); });
