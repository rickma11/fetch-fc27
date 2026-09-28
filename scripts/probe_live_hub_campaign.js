// 只读诊断探针（第 5 轮）：验证 fut.gg **Live Hub 活动内页**能否拿到「全量被追踪球员 + 真实进度」。
//
// 背景（R1-R4 结论）：
//   · /api/fut/live-hub/{ver}/ 只返「精选 6 人」，是子集不是全量
//   · 球员详情页 /players/<slug>/ 渲染后**没有** #tracker（R3/R4 实锤）；此前看到的 /live-hub/
//     链接其实只是站点导航菜单 ⇒ 详情页路线彻底证伪
//   · /live-hub/ 落地页有 14 个球员链接；/live-hub/campaigns/ 是活动索引页（0 球员链接）
//
// 用户提供的关键线索：活动内页按活动分类，且 URL 是活动英文拼接：
//   https://www.fut.gg/live-hub/campaigns/destined-for-glory/players/
//   https://www.fut.gg/live-hub/campaigns/ones-to-watch/players/
// ⇒ 本轮目标：
//   A. 从 /live-hub/campaigns/ 索引页抓**全部活动 slug**（含 tid34 那个未知活动）
//   B. 对每个活动内页 /live-hub/campaigns/<slug>/players/ 渲染后统计球员数、判断有无进度条
//   C. 试同路径的 JSON API 变体（拿到 ⇒ 不必渲染 HTML，CI 成本大幅下降）
//   D. 落一张卡片 HTML 片段，供本地设计解析器
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
const out = { generatedAt: new Date().toISOString(), VER, round: 5, note: '', campaigns: [], apiTries: [] };
function dump() {
  try {
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, 'campaign_probe.json'), JSON.stringify(out, null, 2));
  } catch (e) { console.log('dump err', e.message); }
}
const watchdog = setTimeout(() => { out.note = 'WATCHDOG TIMEOUT（部分结果）'; dump(); console.error('WATCHDOG TIMEOUT'); process.exit(5); }, HARD_TIMEOUT_MS);

function jget(t) { try { return JSON.parse(t); } catch (e) { return null; } }
async function apiGet(page, url, accept) {
  for (let a = 1; a <= 3; a++) {
    try {
      const r = await page.request.get(url, { headers: { Accept: accept || 'application/json' }, timeout: 60000 });
      const t = await r.text();
      return { status: r.status(), body: t };
    } catch (e) { console.log('  api err', e.message); }
    if (a < 3) await page.waitForTimeout(3000);
  }
  return null;
}

// 渲染页面 → 滚动触发懒加载 → 统计球员链接 / 进度条 / 抓卡片片段
async function scanPage(page, url, opts) {
  const o = opts || {};
  const rec = { url, err: '' };
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(2500);
    const snap = async () => page.evaluate(() => {
      const html = document.documentElement.outerHTML;
      const plinks = [...document.querySelectorAll('a[href*="/players/"]')].map(a => a.getAttribute('href') || '');
      const eaSet = new Set();
      for (const h of plinks) { const m = /\/players\/(\d+)-(\d+)\/?/.exec(h); if (m) eaSet.add(m[2]); }
      return {
        finalUrl: location.href,
        title: (document.title || '').slice(0, 120),
        playerHrefs: plinks.length,
        eaCount: eaSet.size,
        eaSample: [...eaSet].slice(0, 8),
        greenSeg: (html.match(/bg-green-500/g) || []).length,
        graySeg: (html.match(/bg-gray-900/g) || []).length,
        hasTracker: html.indexOf('id="tracker"') >= 0,
        trackerWord: (html.toLowerCase().match(/tracker/g) || []).length,
        htmlBytes: html.length
      };
    });
    rec.first = await snap();
    // 滚动到底（懒加载/无限滚动）
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(2500);
    await page.evaluate(() => window.scrollTo(0, Math.floor(document.body.scrollHeight / 2)));
    await page.waitForTimeout(2000);
    rec.afterScroll = await snap();
    if (o.needSnippet) {
      rec.snippet = await page.evaluate(() => {
        const a = [...document.querySelectorAll('a[href*="/players/"]')][0];
        if (!a) return '';
        let node = a;
        for (let i = 0; i < 5 && node.parentElement; i++) node = node.parentElement;
        return (node.outerHTML || '').slice(0, 4000);
      });
    }
    const best = rec.afterScroll.eaCount >= rec.first.eaCount ? rec.afterScroll : rec.first;
    rec.summary = best;
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
  const LIGHT = `${BASE}/players/v2/${VER}/?page=1`;
  let passed = false;
  for (let i = 0; i < 40; i++) {
    try {
      const r = await page.request.get(LIGHT, { headers: { Accept: 'application/json' }, timeout: 20000 });
      if (r.status() === 200) { passed = true; console.log('CF 通过', i + 1); break; }
    } catch (e) { }
    await page.waitForTimeout(3000);
  }
  if (!passed) { out.note = 'CF 未通过'; dump(); await browser.close(); process.exit(2); }

  // ① 活动索引页：抓全部活动 slug
  console.log('\n① 活动索引 ...');
  const idx = await scanPage(page, `${SITE}/live-hub/campaigns/`);
  out.index = { url: idx.url, err: idx.err, summary: idx.summary };
  console.log('  索引页', JSON.stringify(idx.summary));
  let camps = await page.evaluate(() => {
    const set = new Map();
    for (const a of document.querySelectorAll('a[href*="/live-hub/campaigns/"]')) {
      const h = a.getAttribute('href') || '';
      const m = /\/live-hub\/campaigns\/([^/]+)\//.exec(h);
      if (m && m[1] !== 'players') set.set(m[1], (a.textContent || '').trim().slice(0, 40));
    }
    return [...set.entries()].map(([slug, text]) => ({ slug, text }));
  });
  out.campaignLinks = camps;
  console.log('  活动链接', camps.map(c => c.slug).join(', '));

  // 兜底：索引页若解析不到，用已知活动（用户给的）+ 落地页链接兜底
  const KNOWN = ['ones-to-watch', 'destined-for-glory'];
  for (const k of KNOWN) if (!camps.some(c => c.slug === k)) camps.push({ slug: k, text: '(known)' });
  if (!camps.length) camps = KNOWN.map(s => ({ slug: s, text: '(fallback)' }));

  // ② 试 JSON API 变体（拿到就不用渲染 HTML）
  console.log('\n② API 变体 ...');
  const variants = [
    `${BASE}/live-hub/${VER}/campaigns/`,
    `${BASE}/live-hub/campaigns/`,
    `${BASE}/live-hub/${VER}/campaigns/${KNOWN[0]}/players/`,
    `${BASE}/live-hub/campaigns/${KNOWN[0]}/players/`
  ];
  for (const v of variants) {
    const r = await apiGet(page, v);
    const rec = { url: v, status: r ? r.status : 'ERR', bytes: r ? r.body.length : 0, head: r ? r.body.slice(0, 160) : '' };
    out.apiTries.push(rec);
    console.log(`  ${v.slice(SITE.length)} → ${rec.status} ${rec.bytes}B ${rec.head.replace(/\s+/g, ' ').slice(0, 80)}`);
  }

  // ③ 逐个活动内页渲染扫描
  console.log('\n③ 活动内页 ...');
  for (const c of camps.slice(0, 8)) {
    const url = `${SITE}/live-hub/campaigns/${c.slug}/players/`;
    const rec = await scanPage(page, url, { needSnippet: true });
    rec.slug = c.slug; rec.text = c.text;
    out.campaigns.push(rec);
    const s = rec.summary || {};
    console.log(`  ${c.slug} → eaCount=${s.eaCount} playerHrefs=${s.playerHrefs} green=${s.greenSeg} gray=${s.graySeg} #tracker=${s.hasTracker} ${rec.err || ''}`);
  }

  out.note = (out.campaigns || []).some(c => (c.summary || {}).eaCount > 0) ? 'HIT: 活动内页拿到球员列表' : 'MISS: 活动内页无球员链接';
  clearTimeout(watchdog);
  await browser.close();
  dump();
  console.log('\n===== ' + out.note + ' =====');
  process.exit(0);
})().catch(e => { console.error('ERR', e); out.note = 'ERR ' + e.message; dump(); process.exit(1); });
