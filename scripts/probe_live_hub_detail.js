// 只读诊断探针（第 8 轮）：**找 campaign 级「球员+进度」端点**（API 优先，HTML 兜底）。
//
// 前 7 轮结论（关键）：
//   R6: `/api/fut/live-hub/27/campaigns/` → 200 / 58KB，data = campaign 列表（id/name/slug/description）
//   R7: ★ `/live-hub/campaigns/<slug>/players/` 子页有 **FC27 全部被追踪球员**：
//        · ones-to-watch/players      → 21 张 27- 前缀（＝tid32 的 21 人）
//        · destined-for-glory/players → 17 张 27- 前缀（tid33 11 + tid34 6 = 17 ✅ 完美对上）
//        · 卡片文本样例（fc-pro）：「FC Pro | Al Hilal | Get 3 FC Pro Points | +1 SM or WF | … | 15/16 | +1 OVR | …」
//          ⇒ 卡片内**含真实进度数字（15/16）与绿条段数**，且同活动不同球员进度不同（Nunez 15/16 vs Garnacho 0/16）
//   R7 提取缺陷：卡片容器停得太浅（走到「有文本」就停）→ OTW/DFG 卡只拿到 "Ones to Watch | Man Utd"
//
// 本轮：
//   ① dump campaigns API 全量结构（含每项键名、是否有 players/trackerId 字段）
//   ② 试 campaign 级球员端点（按 id / slug × 带不带 players/）
//   ③ API 不通则 HTML 兜底：用「一路向上直到父级含多张卡」的算法取**完整单卡容器**，
//      输出 每张卡的 eaId + 完整文本 + 绿/灰段数
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'probe', 'live_hub');
const VER = Number(process.argv[2] || process.env.FC_VER || 27);
const BASE = 'https://www.fut.gg/api/fut';
const SITE = 'https://www.fut.gg';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36';

const HARD_TIMEOUT_MS = Number(process.env.PROBE_TIMEOUT_MS || 12 * 60 * 1000);
const out = { generatedAt: new Date().toISOString(), VER, round: 8, note: '', sections: {} };
function dump() {
  try { fs.mkdirSync(OUT, { recursive: true }); fs.writeFileSync(path.join(OUT, 'detail_probe.json'), JSON.stringify(out, null, 2)); } catch (e) { console.log('dump err', e.message); }
}
const watchdog = setTimeout(() => { out.note = 'WATCHDOG TIMEOUT（部分结果）'; dump(); console.error('WATCHDOG TIMEOUT'); process.exit(5); }, HARD_TIMEOUT_MS);

function jget(t) { try { return JSON.parse(t); } catch (e) { return null; } }
async function apiGet(page, url, accept) {
  for (let a = 1; a <= 3; a++) {
    try {
      const r = await page.request.get(url, { headers: { Accept: accept || 'application/json' }, timeout: 60000 });
      const t = await r.text();
      if (r.status() === 200) return { status: 200, body: t };
      return { status: r.status(), body: t.slice(0, 200) };
    } catch (e) { console.log('  api err', e.message); }
    if (a < 3) await page.waitForTimeout(3000);
  }
  return null;
}

// HTML 兜底：取「完整单卡容器」（一路向上直到父级含 ≥2 张球员卡）
async function extractPlayers(page, url) {
  const rec = { url, err: '', cards: [] };
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 40000 });
    await page.waitForTimeout(2500);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(3000);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(800);
    const info = await page.evaluate(VERJS => {
      const PSEL = 'a[href*="/players/"]';
      const cards = [];
      const seen = new Set();
      for (const a of [...document.querySelectorAll(PSEL)]) {
        const href = a.getAttribute('href') || '';
        if (!/\/\d+-\d+\//.test(href)) continue;      // 只要具体球员 item 链接
        if (seen.has(href)) continue;
        seen.add(href);
        // 一路向上：直到父级含 ≥2 张卡（说明当前层就是「单卡根」）
        let el = a;
        for (let i = 0; i < 12 && el.parentElement; i++) {
          const p = el.parentElement;
          if (p.querySelectorAll(PSEL).length > 1) break;
          el = p;
        }
        const mm = /\/(\d+)-(\d+)\//.exec(href);
        cards.push({
          baseId: mm ? mm[1] : null, eaId: mm ? Number(mm[2]) : null, ver: mm ? Number(mm[1]) : null,
          is27: mm ? Number(mm[1]) === Number(VERJS) : false,
          text: (el.innerText || '').trim().replace(/\s*\n+\s*/g, ' | ').slice(0, 900),
          greens: el.querySelectorAll('[class*="bg-green-500"]').length,
          grays: el.querySelectorAll('[class*="bg-gray-900"]').length
        });
      }
      return { finalUrl: location.href, title: (document.title || '').slice(0, 120), cards, htmlBytes: document.documentElement.outerHTML.length };
    }, VER);
    Object.assign(rec, info);
  } catch (e) { rec.err = 'goto: ' + e.message; }
  return rec;
}

(async () => {
  console.log('启动 Chromium ...');
  const browser = await chromium.launch({ headless: true, args: ['--disable-blink-features=AutomatedControlled', '--no-sandbox', '--disable-dev-shm-usage'] });
  const ctx = await browser.newContext({ userAgent: UA, locale: 'en-US', viewport: { width: 1280, height: 900 }, timezoneId: 'America/New_York' });
  const page = await ctx.newPage();

  console.log('过 Cloudflare ...');
  await page.goto(SITE + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  let passed = false;
  for (let i = 0; i < 40; i++) {
    try { const r = await page.request.get(`${BASE}/players/v2/${VER}/?page=1`, { headers: { Accept: 'application/json' }, timeout: 20000 }); if (r.status() === 200) { passed = true; console.log('CF 通过', i + 1); break; } } catch (e) { }
    await page.waitForTimeout(3000);
  }
  if (!passed) { out.note = 'CF 未通过'; dump(); await browser.close(); process.exit(2); }

  // ① campaigns 全量结构
  console.log('\n① campaigns API 结构 ...');
  const r0 = await apiGet(page, `${BASE}/live-hub/${VER}/campaigns/`);
  const A = { status: r0 ? r0.status : null, bytes: r0 ? r0.body.length : 0, keys: [], list: [], hasPlayersField: false, head: '' };
  if (r0 && r0.status === 200) {
    A.head = r0.body.slice(0, 800);
    const j = jget(r0.body);
    const arr = (j && Array.isArray(j.data)) ? j.data : [];
    A.count = arr.length;
    A.keys = arr[0] ? Object.keys(arr[0]) : [];
    A.hasPlayersField = arr.some(c => Array.isArray(c.players));
    A.list = arr.map(c => ({ id: c.id, name: c.name, slug: c.slug, trackerId: c.trackerId != null ? c.trackerId : null, playerCount: Array.isArray(c.players) ? c.players.length : null }));
  }
  out.sections.campaignsApi = A;
  console.log('  count', A.count, 'keys', JSON.stringify(A.keys), 'hasPlayers', A.hasPlayersField);
  console.log('  list:', JSON.stringify(A.list));

  // ② campaign 级球员端点候选（拿第一个 FC27 campaign 试）
  console.log('\n② campaign 球员端点 ...');
  const fc27 = (A.list || []).filter(c => c.slug && /ones-to-watch|destined/.test(c.slug));
  const target = fc27[0] || (A.list || [])[0] || { id: 22, slug: 'destined-for-glory' };
  const cands = [];
  if (target.id) cands.push(`${BASE}/live-hub/${VER}/campaigns/${target.id}/`, `${BASE}/live-hub/${VER}/campaigns/${target.id}/players/`);
  if (target.slug) cands.push(`${BASE}/live-hub/${VER}/campaigns/${target.slug}/`, `${BASE}/live-hub/${VER}/campaigns/${target.slug}/players/`);
  cands.push(`${BASE}/live-hub/${VER}/?campaign_id=${target.id}`);
  out.sections.apiTries = [];
  let apiHit = null;
  for (const u of cands) {
    const r = await apiGet(page, u);
    const ok = r && r.status === 200 && r.body.length > 500;
    out.sections.apiTries.push({ url: u, status: r ? r.status : null, bytes: r ? r.body.length : 0, head: ok ? r.body.slice(0, 600) : '' });
    console.log(`  ${u} → ${r ? r.status : 'null'} ${r ? r.body.length : 0}B`);
    if (ok && !apiHit) apiHit = { url: u, body: r.body };
  }
  out.sections.apiHit = apiHit ? { url: apiHit.url, bytes: apiHit.body.length, head: apiHit.body.slice(0, 2000), playerValueHits: (apiHit.body.match(/playerValue/g) || []).length } : null;

  // ③ HTML 兜底：OTW / DFG 的 players 子页完整卡片
  console.log('\n③ HTML 兜底 ...');
  out.sections.pages = [];
  for (const slug of ['ones-to-watch', 'destined-for-glory']) {
    const rec = await extractPlayers(page, `${SITE}/live-hub/campaigns/${slug}/players/`);
    rec.campaign = slug;
    const c27 = (rec.cards || []).filter(c => c.is27);
    out.sections.pages.push(rec);
    console.log(`  ${slug} → cards=${(rec.cards || []).length} 27x=${c27.length} ${rec.err || ''}`);
    for (const c of c27.slice(0, 4)) console.log(`      · ${c.eaId} g=${c.greens}/${c.greens + c.grays} :: ${c.text.slice(0, 260)}`);
  }

  out.note = out.sections.apiHit ? 'HIT: 找到 campaign 级球员端点（见 sections.apiHit）' : 'API 未命中，走 HTML 兜底（见 sections.pages）';
  clearTimeout(watchdog);
  await browser.close();
  dump();
  console.log('\n===== ' + out.note + ' =====');
  process.exit(0);
})().catch(e => { console.error('ERR', e); out.note = 'ERR ' + e.message; dump(); process.exit(1); });
