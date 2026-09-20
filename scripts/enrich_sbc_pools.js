// Player Pick 类 SBC 的「选择球员」富集：抓每个 pool 的选择球员，回填进 sbcs.json 的 set.choicePlayers。
// 机制与 scrape_sbc_evolutions.js 完全一致：真实 Chromium 过 Cloudflare → 页面内 fetch。
//
// 数据流（不碰已稳定的 SBC 列表抓取）：
//   scrape_sbc_evolutions.js 写 sbcs.json（含 set.pool.id/slug，但无 choicePlayers）
//        ↓ 本脚本（独立步骤，continue-on-error）
//   遍历带 pool.id 的 set → 调 fut.gg 真实 API 取选择球员 → 回填 choicePlayers
//        ↓ upload_sbcs.js 原样上云（整文档 upsert 自动带 choicePlayers）
//   端上 utils/sbcs.js#playerAwardsOf 读 choicePlayers 自动消费
//
// 真实 API（2026-09-20 经 probe-futgg.yml 在 CI 实测确认）：
//   GET https://www.fut.gg/api/fut/players/v2/{ver}/?pool_id={poolId}
//   返回 {"data":[{ eaId, basePlayerEaId, overall, commonName, cardName, rarityName, position, isIcon, isHero, ... }]}
//   —— 标准 fut.gg 球员 item，字段齐全，无需再查云端补。
//
// 用法：
//   node scripts/enrich_sbc_pools.js --ver 27
//   node scripts/enrich_sbc_pools.js --ver 27 --out cloud-data/fc27
//
// 失败语义：单个 pool 抓取失败不致命（记 errors，继续下一个）；CF 没过才 exit 1。
// 幂等：重复跑会覆盖已有 choicePlayers，无害。

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const UA = process.env.CF_UA || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36';

function parseArgs(argv) {
  const o = { ver: parseInt(process.env.FC_VER, 10) || 27 };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--ver') { o.ver = parseInt(argv[++i], 10) || 27; }
    else if (a === '--out') { o.out = argv[++i]; }
  }
  if (!o.out) o.out = path.resolve(__dirname, '..', 'cloud-data', 'fc' + o.ver);
  return o;
}
const ARGS = parseArgs(process.argv);
const VER = ARGS.ver;

const sleep = ms => new Promise(r => setTimeout(r, ms));

// 经 CF 上下文抓 pool 的选择球员（真实 API：api/fut/players/v2/{ver}/?pool_id={id}）
async function fetchPoolPlayers(page, poolId) {
  const j = await page.evaluate(async ({ ver, id }) => {
    try {
      const r = await fetch(`https://www.fut.gg/api/fut/players/v2/${ver}/?pool_id=${id}`, { headers: { Accept: 'application/json' } });
      if (!r.ok) return { status: r.status, data: [] };
      const t = await r.text();
      let parsed; try { parsed = JSON.parse(t); } catch (e) { return { status: r.status, data: [] }; }
      return { status: r.status, data: (parsed && Array.isArray(parsed.data)) ? parsed.data : [] };
    } catch (e) { return { status: -1, data: [] }; }
  }, { ver: VER, id: poolId });
  return j;
}

function toChoicePlayer(p) {
  if (!p) return null;
  const eaId = p.eaId != null ? Number(p.eaId) : null;
  if (!eaId) return null;
  const name = String(p.commonName || p.cardName || p.name || '').trim();
  if (!name) return null;
  const rarity = String(p.rarityName || p.rarity && p.rarity.name || '').trim();
  return {
    eaId: eaId,
    baseEaId: p.basePlayerEaId != null ? Number(p.basePlayerEaId) : null,
    overall: Number(p.overall) || 0,
    name: name,
    rarity: rarity,
    // 胶囊配色随品质：传奇=白蓝、英雄=紫、其余（OTW/金卡等）=金
    rarityCls: p.isIcon ? 'icon' : (p.isHero ? 'hero' : 'gold'),
    position: String(p.position || '')
  };
}

async function enrichOne(page, set) {
  const pool = set.pool || {};
  const poolId = pool.id;
  if (!poolId) return null;
  const j = await fetchPoolPlayers(page, poolId);
  if (!j.data || !j.data.length) {
    console.log(`    API status=${j.status} 无球员数据`);
    return null;
  }
  const choicePlayers = [];
  for (const p of j.data) {
    const cp = toChoicePlayer(p);
    if (cp) choicePlayers.push(cp);
  }
  return choicePlayers.length ? choicePlayers : null;
}

(async () => {
  const sbcsPath = path.join(ARGS.out, 'sbcs.json');
  if (!fs.existsSync(sbcsPath)) { console.error('找不到 ' + sbcsPath); process.exit(1); }
  const sbcs = JSON.parse(fs.readFileSync(sbcsPath, 'utf8'));
  const sets = Array.isArray(sbcs.sets) ? sbcs.sets : [];
  const targets = sets.filter(s => s && s.pool && s.pool.id);
  console.log(`sbcs.json 共 ${sets.length} 组，其中带 pool.id 的 Player Pick 类 SBC = ${targets.length} 组`);
  if (!targets.length) { console.log('无 Player Pick 类 SBC，跳过。'); process.exit(0); }

  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox', '--disable-dev-shm-usage']
  });
  const ctx = await browser.newContext({ userAgent: UA, locale: 'en-US', viewport: { width: 1280, height: 800 }, timezoneId: 'America/New_York' });
  const page = await ctx.newPage();
  page.on('console', m => { const t = m.text(); if (/error|fail/i.test(t)) console.log('[browser]', t); });

  console.log('打开 fut.gg 过 Cloudflare ...');
  await page.goto('https://www.fut.gg/sbc/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  let passed = false;
  const probeUrl = `https://www.fut.gg/api/fut/sbc/${VER}?page=1`;
  for (let i = 0; i < 30; i++) {
    let status = -1;
    try {
      status = await page.evaluate(async (u) => {
        try { const r = await fetch(u, { headers: { Accept: 'application/json' } }); return r.status; } catch (e) { return -1; }
      }, probeUrl);
    } catch (e) { status = -2; }
    if (status === 200) { passed = true; console.log(`Cloudflare 已通过（第 ${i + 1} 次）`); break; }
    if (status === 404) break;
    console.log(`等待 CF... status=${status} (${i + 1}/30)`);
    await page.waitForTimeout(3000);
  }
  if (!passed) { console.error('CF 未通过，退出。'); await browser.close(); process.exit(1); }

  const errors = [];
  let okCount = 0;
  for (const set of targets) {
    const id = set._id || set.id;
    try {
      const choicePlayers = await enrichOne(page, set);
      if (choicePlayers && choicePlayers.length) {
        set.choicePlayers = choicePlayers;
        okCount++;
        console.log(`  [${id}] ${set.name} → 选择球员 ${choicePlayers.length} 人: ` + choicePlayers.map(p => `${p.name}(${p.eaId})`).join(', '));
      } else {
        console.log(`  [${id}] ${set.name} → 未取到选择球员`);
      }
      await sleep(400); // 轻微限速
    } catch (e) {
      errors.push({ id, message: e.message });
      console.error(`  [${id}] 富集异常: ${e.message}`);
    }
  }

  await browser.close();

  fs.writeFileSync(sbcsPath, JSON.stringify(sbcs, null, 2));
  const summary = { ver: VER, targets: targets.length, enriched: okCount, errors };
  console.log('\n===== 富集摘要 =====');
  console.log(JSON.stringify(summary, null, 2));
  console.log(`已写回 ${sbcsPath}`);
  if (errors.length) console.error('存在错误，但已写出成功部分');
})().catch(e => { console.error('FATAL', e); process.exit(1); });
