// 只读诊断探针（第 6 轮）：把「活动内页」这条路彻底问清楚。
//
// R5 已知：
//   · /api/fut/live-hub/27/campaigns/ → 200，58KB JSON（活动列表，含 id/slug/name/secondaryName）
//   · /live-hub/campaigns/<slug>/players/ → 渲染后有 green/gray 进度段（真实进度很可能就在这里）
//   · ⚠️ R5 的 eaCount=0 是**统计口径错误**：a[href*="/players/"] 把导航「Players」菜单也算进去了，
//     而 eaId 正则 /\/players\/(\d+)-(\d+)\// 对导航链接不匹配 ⇒ 0。本轮改成只数真正的球员链接。
//
// 本轮四问：
//   A. campaigns JSON 的**完整结构**是什么？是否已内嵌球员/升级条件（内嵌 ⇒ 一次请求全搞定，最快）
//   B. 有没有「按活动」的 JSON 端点（用 id 或 slug 各种变体都试一遍）
//   C. 活动内页 HTML 里，真正的**球员卡**长什么样（eaId/名字/俱乐部/绿条段数），能否稳定解析
//   D. 页面内嵌的 Next.js RSC 载荷（self.__next_f）里有没有干净的 playerValue/objectives 数据
//
// 结果落盘 probe/live_hub/campaign_probe.json，由 workflow 提交回 main 供本地读回。
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
const out = { generatedAt: new Date().toISOString(), VER, round: 6, note: '', A: {}, B: [], C: [], D: {} };
function dump() {
  try {
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, 'campaign_probe.json'), JSON.stringify(out, null, 2));
  } catch (e) { console.log('dump err', e.message); }
}
const watchdog = setTimeout(() => { out.note = 'WATCHDOG TIMEOUT（部分结果）'; dump(); console.error('WATCHDOG TIMEOUT'); process.exit(5); }, HARD_TIMEOUT_MS);

function jget(t) { try { return JSON.parse(t); } catch (e) { return null; } }
async function apiGet(page, url) {
  for (let a = 1; a <= 2; a++) {
    try {
      const r = await page.request.get(url, { headers: { Accept: 'application/json' }, timeout: 60000 });
      return { status: r.status(), body: await r.text() };
    } catch (e) { console.log('  api err', e.message); }
    if (a < 2) await page.waitForTimeout(3000);
  }
  return null;
}
// 只保留「数字-数字」形态的真球员链接（排除导航 /players/ 菜单）
const EA_RE = /\/players\/(\d+)-(\d+)\/?/;

(async () => {
  console.log('启动 Chromium ...');
  const browser = await chromium.launch({ headless: true, args: ['--disable-blink-features=AutomatedControlled', '--no-sandbox', '--disable-dev-shm-usage'] });
  const ctx = await browser.newContext({ userAgent: UA, locale: 'en-US', viewport: { width: 1280, height: 900 }, timezoneId: 'America/New_York' });
  const page = await ctx.newPage();

  console.log('过 Cloudflare ...');
  await page.goto(SITE + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  let passed = false;
  for (let i = 0; i < 40; i++) {
    try {
      const r = await page.request.get(`${BASE}/players/v2/${VER}/?page=1`, { headers: { Accept: 'application/json' }, timeout: 20000 });
      if (r.status() === 200) { passed = true; console.log('CF 通过', i + 1); break; }
    } catch (e) { }
    await page.waitForTimeout(3000);
  }
  if (!passed) { out.note = 'CF 未通过'; dump(); await browser.close(); process.exit(2); }

  // ===== A. campaigns JSON 结构 =====
  console.log('\nA. campaigns JSON ...');
  const rc = await apiGet(page, `${BASE}/live-hub/${VER}/campaigns/`);
  let camps = [];
  if (rc && rc.status === 200) {
    const j = jget(rc.body);
    const arr = (j && Array.isArray(j.data)) ? j.data : [];
    camps = arr;
    out.A = {
      bytes: rc.body.length,
      topKeys: j ? Object.keys(j) : null,
      count: arr.length,
      itemKeys: arr[0] ? Object.keys(arr[0]) : [],
      list: arr.map(c => ({
        id: c.id, game: c.game, slug: c.slug, name: c.name, secondaryName: c.secondaryName,
        arrayKeys: Object.keys(c).filter(k => Array.isArray(c[k])).map(k => k + ':' + c[k].length),
        boolKeys: Object.keys(c).filter(k => typeof c[k] === 'boolean').map(k => k + '=' + c[k])
      }))
    };
    out.A.firstItemTrimmed = arr[0] ? JSON.stringify(arr[0]).slice(0, 3000) : '';
    console.log('  count', arr.length, 'keys', (out.A.itemKeys || []).join(','));
    for (const c of out.A.list) console.log(`   #${c.id} ${c.slug} (${c.name}) arrays=[${c.arrayKeys.join(' ')}]`);
  } else {
    out.A = { err: rc ? rc.status : 'null' };
  }

  // ===== B. 按活动的 JSON 端点变体 =====
  console.log('\nB. 按活动端点变体 ...');
  const c0 = camps[0];
  const c1 = camps.find(c => /ones-to-watch/i.test(c.slug || '')) || c0;
  const tries = [];
  if (c1) {
    const slug = c1.slug, id = c1.id;
    tries.push(
      `${BASE}/live-hub/${VER}/campaigns/${id}/`,
      `${BASE}/live-hub/${VER}/campaigns/${slug}/`,
      `${BASE}/live-hub/${VER}/campaigns/${id}/players/`,
      `${BASE}/live-hub/${VER}/players/?campaign=${id}`,
      `${BASE}/live-hub/${VER}/players/?campaign=${slug}`,
      `${BASE}/live-hub/${VER}/tracker/?campaign=${id}`,
      `${BASE}/live-hub/${VER}/?campaign=${id}`,
      `${BASE}/live-hub/${VER}/?tracker_id=${id}`
    );
  }
  for (const u of tries) {
    const r = await apiGet(page, u);
    const rec = { url: u.replace(SITE, ''), status: r ? r.status : 'ERR', bytes: r ? r.body.length : 0, head: r ? r.body.replace(/\s+/g, ' ').slice(0, 120) : '' };
    out.B.push(rec);
    console.log(`  ${rec.status} ${rec.bytes}B ${rec.url}`);
  }

  // ===== C. 活动内页 HTML 球员卡 =====
  console.log('\nC. 活动内页球员卡 ...');
  const targets = [c1, camps[0]].filter(Boolean).map(c => c.slug).filter((v, i, a) => a.indexOf(v) === i);
  for (const slug of targets) {
    const url = `${SITE}/live-hub/campaigns/${slug}/players/`;
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForTimeout(3000);
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(2500);
      const info = await page.evaluate(() => {
        const links = [...document.querySelectorAll('a[href]')].filter(a => /\/players\/\d+-\d+\/?/.test(a.getAttribute('href') || ''));
        const seen = new Set();
        const cards = [];
        for (const a of links) {
          const href = a.getAttribute('href');
          const m = /\/players\/(\d+)-(\d+)\/?/.exec(href);
          if (!m || seen.has(m[2])) continue;
          seen.add(m[2]);
          // 往上找「卡片」容器：含 rounded 或 border 的最近祖先
          let node = a;
          for (let i = 0; i < 6 && node.parentElement; i++) {
            node = node.parentElement;
            const cls = node.className || '';
            if (typeof cls === 'string' && /rounded/.test(cls) && node.querySelectorAll('a[href*="/players/"]').length <= 2) break;
          }
          const h = node.outerHTML || '';
          cards.push({
            eaId: m[2],
            href,
            text: (node.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120),
            green: (h.match(/bg-green-500/g) || []).length,
            gray: (h.match(/bg-gray-900/g) || []).length
          });
        }
        return { title: (document.title || '').slice(0, 100), count: cards.length, cards: cards.slice(0, 6), firstCardHtml: cards.length ? (document.querySelector('a[href*="/players/27-"]') ? document.querySelector('a[href*="/players/27-"]').closest('div[class*="rounded"]') ? document.querySelector('a[href*="/players/27-"]').closest('div[class*="rounded"]').outerHTML.slice(0, 3000) : '' : '') : '' };
      });
      const rec = { slug, url, title: info.title, playerCount: info.count, cards: info.cards, firstCardHtml: info.firstCardHtml };
      out.C.push(rec);
      console.log(`  ${slug} → 球员 ${info.count} 张`);
      for (const c of info.cards.slice(0, 4)) console.log(`     ${c.eaId} green=${c.green} gray=${c.gray} | ${c.text.slice(0, 70)}`);
    } catch (e) {
      out.C.push({ slug, url, err: 'goto: ' + e.message });
      console.log(`  ${slug} ERR ${e.message}`);
    }
  }

  // ===== D. Next.js RSC 载荷里有没有干净数据 =====
  console.log('\nD. RSC 载荷 ...');
  if (targets.length) {
    try {
      const d = await page.evaluate(() => {
        let s = '';
        const f = window.__next_f || [];
        for (const it of f) { if (typeof it === 'string') s += it; else if (Array.isArray(it)) s += it.join(''); }
        const hits = {};
        for (const k of ['playerValue', 'isCompleted', 'liveHubTrackerId', 'objectives', 'campaignId', 'trackerId', 'requirement']) {
          hits[k] = (s.match(new RegExp(k, 'g')) || []).length;
        }
        let snip = '';
        const i = s.indexOf('playerValue');
        if (i >= 0) snip = s.slice(Math.max(0, i - 600), i + 900);
        return { len: s.length, hits, snip };
      });
      out.D = d;
      console.log('  RSC len', d.len, JSON.stringify(d.hits));
    } catch (e) { out.D = { err: e.message }; }
  }

  out.note = (out.C || []).some(c => c.playerCount > 0) ? 'HIT: 活动内页解析出球员卡' : 'MISS';
  clearTimeout(watchdog);
  await browser.close();
  dump();
  console.log('\n===== ' + out.note + ' =====');
  process.exit(0);
})().catch(e => { console.error('ERR', e); out.note = 'ERR ' + e.message; dump(); process.exit(1); });
