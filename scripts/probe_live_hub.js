// 只读探针：用 CI 真实 Chromium 过 Cloudflare，抓 live-hub 全量 JSON，提取「被追踪球员的升级进度」。
//
// 设计要点：
//   - 完全沿用 fetch-fc27.yml / probe-futgg.yml 的过 CF 机制（headless chromium + 首页导航 + 轮询）。
//   - 取数与「提炼」都在浏览器内完成（page.evaluate 里 fetch + 解析 + 抽取），只把**精简后的进度**
//     回传 Node 落盘 —— 避免把 ~30MB 原始 JSON 走 CDP 回传导致协议包过大。
//   - 纯探查：输出到 probe/live_hub/，不碰 cloud-data/fc27、不落库、不改 fetch-fc27 管线。
//
// 用法：node scripts/probe_live_hub.js [ver]   （ver 默认 27；会额外抓 26）
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'probe', 'live_hub');
fs.mkdirSync(OUT_DIR, { recursive: true });

const UA = process.env.CF_UA || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36';
const VER = Number(process.argv[2] || process.env.FC_VER || 27);

(async () => {
  console.log('启动 Chromium (headless) ...');
  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox', '--disable-dev-shm-usage']
  });
  const ctx = await browser.newContext({
    userAgent: UA, locale: 'en-US', viewport: { width: 1280, height: 800 }, timezoneId: 'America/New_York'
  });
  const page = await ctx.newPage();
  page.on('console', m => { const t = m.text(); if (/error|fail|denied|challenge/i.test(t)) console.log('[browser]', t); });

  console.log('打开 fut.gg 过 Cloudflare ...');
  await page.goto('https://www.fut.gg/', { waitUntil: 'domcontentloaded', timeout: 60000 });

  // 用轻量 players API 探 CF 是否放行（与 fetch_ci.js 同口径）
  const LIGHT = `https://www.fut.gg/api/fut/players/v2/${VER}/?page=1`;
  let passed = false;
  for (let i = 0; i < 40; i++) {
    let status = 0;
    try {
      status = await page.evaluate(async (u) => {
        try { const r = await fetch(u, { headers: { Accept: 'application/json' } }); return r.status; } catch (e) { return -1; }
      }, LIGHT);
    } catch (e) { status = -2; }
    if (status === 200) { passed = true; console.log(`Cloudflare 已通过（第 ${i + 1} 次）`); break; }
    console.log(`等待 CF 解除... status=${status} (${i + 1}/40)`);
    await page.waitForTimeout(3000);
  }
  if (!passed) { await browser.close(); console.error('未能过 Cloudflare'); process.exit(2); }

  const report = { generatedAt: new Date().toISOString(), versions: {} };
  const versions = [VER, 26].filter((v, i, a) => a.indexOf(v) === i);

  for (const ver of versions) {
    const url = `https://www.fut.gg/api/fut/live-hub/${ver}/`;
    console.log(`\n抓取 live-hub/${ver} 全量并在浏览器内提炼 ...`);
    // 浏览器内 fetch + 解析 + 抽取（只回传精简进度，避免 ~30MB 原始 JSON 走 CDP）
    let compact;
    try {
      compact = await page.evaluate(async (u) => {
        const r = await fetch(u, { headers: { Accept: 'application/json' } });
        if (!r.ok) return { error: 'HTTP ' + r.status };
        const j = await r.json();
        const players = (j && j.data && Array.isArray(j.data.players)) ? j.data.players : [];
        const camps = {};
        const out = [];
        for (const p of players) {
          const tid = (p.trackerId != null) ? p.trackerId : null;
          const camp = p.campaignName || '?';
          const key = `${camp}#${tid}`;
          if (!camps[key]) camps[key] = { campaignName: camp, trackerId: tid, count: 0, sample: [] };
          camps[key].count++;
          if (camps[key].sample.length < 8) camps[key].sample.push(p.playerItemEaId);
          const card = p.card || {};
          const tracker = p.tracker || {};
          const objectives = Array.isArray(tracker.objectives)
            ? tracker.objectives.map(o => ({
                req: o.requirement, label: o.label, value: o.value,
                playerValue: o.playerValue, isCompleted: o.isCompleted, isNotPossible: o.isNotPossible,
                upgrades: Array.isArray(o.upgrades) ? o.upgrades.map(u2 => ({ upgrade: u2.upgrade, label: u2.label })) : []
              }))
            : [];
          out.push({
            campaignName: camp, trackerId: tid, playerItemEaId: p.playerItemEaId,
            name: card.commonName || null, overall: card.overall || null,
            objectives, data: p.data || {}
          });
        }
        return {
          version: ver, totalPlayers: players.length,
          campaigns: Object.values(camps).sort((a, b) => b.count - a.count),
          players: out
        };
      }, url);
    } catch (e) { console.log('  取数/提炼失败:', e.message); continue; }

    if (compact.error) { console.log('  端点返回', compact.error); continue; }

    const progFile = path.join(OUT_DIR, `fc${ver}_progress.json`);
    fs.writeFileSync(progFile, JSON.stringify(compact, null, 2));
    console.log('  写出进度', progFile, '(', compact.totalPlayers, '名被追踪球员 )');
    for (const c of compact.campaigns)
      console.log(`    • ${c.campaignName} (trackerId=${c.trackerId}) x${c.count}  样本: ${c.sample.join(',')}`);
    report.versions[ver] = { totalPlayers: compact.totalPlayers, campaigns: compact.campaigns };
  }

  fs.writeFileSync(path.join(OUT_DIR, 'report.json'), JSON.stringify(report, null, 2));
  console.log('\n=== 汇总 ===');
  console.log(JSON.stringify(report, null, 2));
  await browser.close();
})().catch(e => { console.error('探针失败:', e); process.exit(1); });
