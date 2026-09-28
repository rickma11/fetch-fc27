// 只读探针：用 CI 真实 Chromium 过 Cloudflare，抓 live-hub 全量 JSON，提取「被追踪球员的升级进度」。
//
// 设计要点：
//   - 完全沿用 fetch-fc27.yml / probe-futgg.yml 的过 CF 机制（headless chromium + 首页导航 + 轮询）。
//   - 取数改用 Playwright 的 page.request（Node 侧 fetch，自动共享浏览器上下文的 cf_clearance cookie），
//     比 page.evaluate 内 fetch 更可靠：能拿到真实 HTTP status 与错误文案，且不在 CDP 里回传 ~30MB 原始 JSON。
//   - 提炼在 Node 本地完成（解析 + 抽取精简进度），只落盘精简文件。
//   - 纯探查：输出到 probe/live_hub/，不碰 cloud-data/fc27、不落库、不改 fetch-fc27 管线。
//
// 用法：node scripts/probe_live_hub.js [ver]   （ver 默认 27；只抓指定版本，目前仅 FC27）
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
  page.on('console', m => { const t = m.text(); if (/error|fail|denied|challenge|redirect/i.test(t)) console.log('[browser]', t); });

  console.log('打开 fut.gg 过 Cloudflare ...');
  await page.goto('https://www.fut.gg/', { waitUntil: 'domcontentloaded', timeout: 60000 });

  // 用轻量 players API 探 CF 是否放行（与 fetch_ci.js 同口径）；page.request 共享 cookie
  const LIGHT = `https://www.fut.gg/api/fut/players/v2/${VER}/?page=1`;
  let passed = false;
  for (let i = 0; i < 40; i++) {
    let status = 0, ok = false;
    try {
      const r = await page.request.get(LIGHT, { headers: { Accept: 'application/json' }, timeout: 20000 });
      status = r.status();
      const t = await r.text();
      ok = t.trim().startsWith('{') || t.trim().startsWith('[');
    } catch (e) { status = -1; console.log(`  LIGHT 异常: ${e.message}`); }
    if (status === 200 && ok) { passed = true; console.log(`Cloudflare 已通过（第 ${i + 1} 次）`); break; }
    console.log(`等待 CF 解除... status=${status} ok=${ok} (${i + 1}/40)`);
    await page.waitForTimeout(3000);
  }
  if (!passed) { await browser.close(); console.error('未能过 Cloudflare（轻量 API 持续非 200 / 非 JSON）'); process.exit(2); }

  const report = { generatedAt: new Date().toISOString(), versions: {} };
  // 用户最新要求：只抓 FC27，验证数据情况，不考虑 FC26
  const versions = [VER];

  for (const ver of versions) {
    const url = `https://www.fut.gg/api/fut/live-hub/${ver}/`;
    console.log(`\n抓取 live-hub/${ver} 全量（page.request，Node 侧解析）...`);
    let text = null, status = 0;
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        const r = await page.request.get(url, { headers: { Accept: 'application/json' }, timeout: 60000 });
        status = r.status();
        const ct = r.headers()['content-type'] || '';
        text = await r.text();
        if (status === 200 && (text.trim().startsWith('{') || text.trim().startsWith('['))) {
          console.log(`  第 ${attempt} 次成功：status=${status} content-type=${ct} bytes=${text.length}`);
          break;
        } else {
          console.log(`  第 ${attempt} 次非预期：status=${status} ct=${ct} preview=${text.slice(0, 300)}`);
        }
      } catch (e) {
        console.log(`  第 ${attempt} 次异常: ${e.message}`);
      }
      if (attempt < 4) await page.waitForTimeout(5000);
    }

    if (!text || status !== 200) { console.log('  live-hub 抓取最终失败，跳过 FC' + ver); continue; }

    // Node 本地解析 + 提炼（无需走 CDP）
    let j;
    try { j = JSON.parse(text); } catch (e) { console.log('  JSON 解析失败:', e.message); continue; }
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
    const compact = {
      version: ver, totalPlayers: players.length,
      campaigns: Object.values(camps).sort((a, b) => b.count - a.count),
      players: out
    };

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
