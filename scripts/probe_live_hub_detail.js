// 只读诊断探针：验证能否用 CI 真实浏览器（过 CF 后 page.request.get）抓取「被追踪球员详情页」的
// #tracker 区块，从而拿到**逐球员的真实升级规则 + 真实进度**（而非 live-hub 聚合那 6 个精选人的进度）。
//
// 关键待验证点：
//   1. 详情页 URL 格式到底是 /player/<slug>/ 还是 /players/<slug>/？（两种都试，取首个返回 200 且含 #tracker 的）
//   2. 原始 HTML 里是否服务端直出 id="tracker"（能拿到 ⇒ 无需等 JS 渲染）。
//   3. 逐球员进度真源＝绿条段数（bg-green-500 个数）；label 里的 (N/M) 可能是「窗口/场次」指示（两人可比），
//      故此探针会同时抓 2 名以上同活动球员，比对绿条段数是否不同（不同 ⇒ 确为逐球员进度）。
//   4. tid34（Veiga 等）的详情页是否也有 #tracker？（有 ⇒ 可复活此前「跳过」的 6 张卡）
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

// 看门狗：今晚 CI Chromium 有 ~20min 挂死前科，超时强制写出已有结果并退出（避免卡满 workflow timeout）
const HARD_TIMEOUT_MS = Number(process.env.PROBE_TIMEOUT_MS || 12 * 60 * 1000);
const out = { generatedAt: new Date().toISOString(), VER, note: '', urlPattern: null, samples: [] };
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

// 解析详情页 HTML 的 #tracker 区块
function parseTracker(html) {
  const idx = html.indexOf('id="tracker"');
  if (idx < 0) return null;
  const chunk = html.slice(idx, idx + 25000);
  const res = { campaign: '', club: '', objectives: [] };
  let m = /href="\/live-hub\/campaigns\/[^"]*"[^>]*>\s*([^<]*)</.exec(chunk);
  if (m) res.campaign = m[1].trim();
  m = /<span class="text-xs font-bold text-white">([^<]*)</.exec(chunk);
  if (m) res.club = m[1].trim();

  // 每张升级条件卡片
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
      labelProgress: nm ? nm[0] : null,      // 形如 (1/6)，仅参考（疑为窗口/场次指示）
      repeatable,
      greenSegments: green,                  // 真实进度（已完成段）
      totalSegments: green + gray,           // 目标段数
      progress: (green + gray) > 0 ? green : null,
      target: (green + gray) > 0 ? (green + gray) : null,
      rewards
    });
    // 卡片结束保护：遇到 "View Fixtures" 按钮即停
    if (/View Fixtures/.test(card)) break;
  }
  return res;
}

(async () => {
  console.log('启动 Chromium ...');
  const browser = await chromium.launch({ headless: true, args: ['--disable-blink-features=AutomatedControlled', '--no-sandbox', '--disable-dev-shm-usage'] });
  const ctx = await browser.newContext({ userAgent: UA, locale: 'en-US', viewport: { width: 1280, height: 800 }, timezoneId: 'America/New_York' });
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
      if (r.status() === 200 && (t.trim().startsWith('{') || t.trim().startsWith('['))) { passed = true; console.log('CF 通过', i + 1); break; }
    } catch (e) { }
    await page.waitForTimeout(3000);
  }
  if (!passed) { out.note = 'CF 未通过'; dump(); await browser.close(); process.exit(2); }

  // ① 枚举 has_dynamic（只取前几页，够取样即可）→ 拿 slug
  console.log('\n① 枚举 has_dynamic ...');
  const dyn = {};
  for (let pg = 1; pg <= 6; pg++) {
    const r = await apiGet(page, `${BASE}/players/v2/${VER}/?has_dynamic=true&page=${pg}`);
    if (!r || r.status !== 200) break;
    const arr = (jget(r.body) && Array.isArray(jget(r.body).data)) ? jget(r.body).data : [];
    for (const pl of arr) {
      const ea = pl.eaId != null ? Number(pl.eaId) : null;
      if (!ea) continue;
      dyn[ea] = { slug: pl.slug || '', rarityName: pl.rarityName || '', clubName: pl.clubName || '', nationName: pl.nationName || '' };
    }
    console.log(`  page ${pg} +${arr.length} 累计 ${Object.keys(dyn).length}`);
    if (!arr.length) break;
  }
  const eaIds = Object.keys(dyn);
  console.log(`  has_dynamic 共 ${eaIds.length} 张`);
  out.dynCount = eaIds.length;
  out.sampleSlugs = eaIds.slice(0, 5).map(e => ({ eaId: e, slug: dyn[e].slug }));

  // ② definition-data 反查 trackerId
  console.log('\n② 反查 liveHubTrackerId ...');
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
  out.trackerIdDist = Object.keys(byTid).reduce((a, k) => (a[k] = byTid[k].length, a), {});
  console.log('  trackerId 分布', JSON.stringify(out.trackerIdDist));

  // ③ 取样：优先每个 trackerId 各取 2 张（重点含 34）
  const picks = [];
  for (const tid of Object.keys(byTid).sort()) {
    for (const e of byTid[tid].slice(0, 2)) picks.push({ eaId: Number(e), tid: Number(tid), slug: dyn[e].slug });
  }
  console.log('  取样', picks.map(p => `${p.eaId}/tid${p.tid}/${p.slug}`).join(' | '));
  out.picks = picks.map(p => ({ eaId: p.eaId, tid: p.tid, slug: p.slug }));

  // ④ 详情页 URL 格式已知（上一轮探针结论）：
  //    /player/<slug>/  → 404
  //    /players/<slug>/ → 200（正确）
  //    ⚠️ 但 200 的原始 HTML 里**没有** id="tracker" ⇒ #tracker 是**客户端 JS 渲染**，
  //       故必须 page.goto 渲染后等 #tracker 出现，再取 page.content() 解析（不能只 request.get）。
  const usePattern = s => `${SITE}/players/${s}/`;
  out.urlPattern = `${SITE}/players/<slug>/`;

  // 抓一张卡：先拿原始 HTML（判断 SSR 直出），再渲染（page.goto + 等 #tracker）
  async function fetchAndParse(url) {
    const rec = { url, rawStatus: null, rawHasTracker: false, renderedHasTracker: false, err: '' };
    const raw = await apiGet(page, url, 'text/html,application/xhtml+xml');
    if (raw && raw.status === 200) {
      rec.rawStatus = 200;
      rec.rawBytes = raw.body.length;
      rec.rawHasTracker = raw.body.indexOf('id="tracker"') >= 0;
    } else if (raw) {
      rec.rawStatus = raw.status;
    }
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 40000 });
      try {
        await page.waitForSelector('#tracker', { timeout: 15000 });
        rec.renderedHasTracker = true;
      } catch (e) { rec.err = 'wait #tracker: ' + e.message; }
      const html = await page.content();
      rec.renderedBytes = html.length;
      rec.tracker = rec.renderedHasTracker ? parseTracker(html) : null;
      if (!rec.renderedHasTracker && !rec.err) rec.err = 'no selector but content ok';
      // 诊断：渲染后是否出现 live-hub 相关线索（说明 JS 跑起来了但没 tracker）
      rec.hasLiveHubLink = /\/live-hub\//.test(html);
    } catch (e) { rec.err = 'goto: ' + e.message; }
    return rec;
  }

  // ⑤ 对每张取样卡抓详情页（渲染后）并解析 #tracker
  for (const p of picks) {
    const url = usePattern(p.slug);
    const rec = await fetchAndParse(url);
    const tr = rec.tracker;
    out.samples.push({
      eaId: p.eaId, tid: p.tid, slug: p.slug,
      url: rec.url,
      rawStatus: rec.rawStatus, rawHasTracker: rec.rawHasTracker,
      renderedHasTracker: rec.renderedHasTracker,
      hasLiveHubLink: !!rec.hasLiveHubLink,
      err: rec.err,
      renderedBytes: rec.renderedBytes || 0,
      campaign: tr ? tr.campaign : '',
      club: tr ? tr.club : (dyn[p.eaId] ? dyn[p.eaId].clubName : ''),
      objectives: tr ? tr.objectives : []
    });
    console.log(`  ${p.eaId} tid${p.tid} → raw#tracker=${rec.rawHasTracker} 渲染后#tracker=${rec.renderedHasTracker} objs=${tr ? tr.objectives.length : 0} ${rec.err || ''}`);
  }

  clearTimeout(watchdog);
  await browser.close();
  dump();
  console.log('\n===== 探针结果 =====');
  console.log(JSON.stringify(out, null, 2).slice(0, 4000));
  process.exit(0);
})().catch(e => { console.error('ERR', e); out.note = 'ERR ' + e.message; dump(); process.exit(1); });
