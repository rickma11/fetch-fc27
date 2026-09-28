// 只读探针（第 11 轮 / 收口）：把 38 张被追踪卡的**完整条件 + 真实进度**导成一份紧凑清单，供人工过目。
//
// 依据 R8-R10：真接口 = /api/fut/live-hub/{ver}/players/?campaign_id={id}
//   campaign 21 → 21 条（tid32 Ones to Watch）；campaign 22 → 17 条（tid33 11 + tid34 6，Destined for Glory）
//   item：playerItemEaId / trackerId / clubName / nationName / competitionName / card{} / data{}
//        / tracker.objectives[]{ requirement, value, playerValue, isCompleted, isNotPossible,
//                                maxGames, gamesPlayed, isRepeatable, upgrades[] }
//
// 本轮不做分析，只做「全量导出」：每张卡的每条升级条件都保留（条件枚举 + 阈值 + 当前值 + 奖励），
// 外加 data{} 里的原始计数（便于和 playerValue 互相印证）。
// 输出 probe/live_hub/full_cards.json（紧凑，约几十 KB）。
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
const out = { generatedAt: null, VER, round: 11, campaigns: [], cards: [] };
function dump() {
  try {
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, 'full_cards.json'), JSON.stringify(out));
  } catch (e) { console.log('dump err', e.message); }
}
const watchdog = setTimeout(() => { out.note = 'WATCHDOG TIMEOUT（部分结果）'; dump(); console.error('WATCHDOG TIMEOUT'); process.exit(5); }, HARD_TIMEOUT_MS);

function jget(t) { try { return JSON.parse(t); } catch (e) { return null; } }
async function apiGet(page, url) {
  try {
    const r = await page.request.get(url, { headers: { Accept: 'application/json' }, timeout: 180000 });
    return { status: r.status(), body: await r.text() };
  } catch (e) { console.log('  api err', e.message); return null; }
}

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--disable-blink-features=AutomatedControlled', '--no-sandbox', '--disable-dev-shm-usage'] });
  const ctx = await browser.newContext({ userAgent: UA, locale: 'en-US', viewport: { width: 1280, height: 900 }, timezoneId: 'America/New_York' });
  const page = await ctx.newPage();

  await page.goto(SITE + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  let passed = false;
  for (let i = 0; i < 40; i++) {
    try {
      const r = await page.request.get(`${BASE}/players/v2/${VER}/?page=1`, { headers: { Accept: 'application/json' }, timeout: 20000 });
      if (r.status() === 200) { passed = true; break; }
    } catch (e) { }
    await page.waitForTimeout(3000);
  }
  if (!passed) { console.error('CF 未通过'); dump(); await browser.close(); process.exit(2); }

  // ① 活动清单
  const rc = await apiGet(page, `${BASE}/live-hub/${VER}/campaigns/`);
  const jc = rc ? jget(rc.body) : null;
  const camps = (jc && Array.isArray(jc.data)) ? jc.data : [];
  out.campaigns = camps.map(c => ({ id: c.id, name: c.name, slug: c.slug, trackerIds: c.trackerIds || [] }));
  console.log('活动:', out.campaigns.map(c => `#${c.id} ${c.slug} [${c.trackerIds}]`).join(' | '));

  // ② 逐活动导出全量卡
  for (const c of out.campaigns) {
    const r = await apiGet(page, `${BASE}/live-hub/${VER}/players/?campaign_id=${c.id}`);
    if (!r || r.status !== 200) { console.log(`  #${c.id} 失败`, r && r.status); continue; }
    const j = jget(r.body);
    const arr = (j && Array.isArray(j.data)) ? j.data : (Array.isArray(j) ? j : []);
    console.log(`  #${c.id} ${c.slug} → ${arr.length} 条`);
    for (const it of arr) {
      const card = it.card || {};
      const objs = (it.tracker && it.tracker.objectives) || [];
      out.cards.push({
        eaId: it.playerItemEaId,
        name: card.commonName || card.cardName || card.name || '',
        club: it.clubName || (card.club && (card.club.name || card.clubName)) || '',
        nation: it.nationName || (card.nation && (card.nation.name || card.nationName)) || '',
        league: it.competitionName || '',
        overall: card.overall != null ? card.overall : null,
        position: card.position || '',
        rarity: card.rarityName || '',
        campaignId: it.campaignId,
        campaignName: it.campaignName || c.name,
        trackerId: it.trackerId,
        imageUrl: card.cardImageUrl || '',
        data: it.data || null,
        objectives: objs.map(o => ({
          req: o.requirement,
          value: o.value,
          pv: o.playerValue,
          done: !!o.isCompleted,
          impossible: !!o.isNotPossible,
          maxGames: o.maxGames != null ? o.maxGames : null,
          gamesPlayed: o.gamesPlayed != null ? o.gamesPlayed : null,
          repeat: !!o.isRepeatable,
          reward: (o.upgrades || []).map(u => u.label || u.customUpgrade || u.upgrade).join(' + ')
        }))
      });
    }
  }
  out.generatedAt = new Date().toISOString();
  out.count = out.cards.length;
  console.log('导出卡片', out.count, '张');
  clearTimeout(watchdog);
  await browser.close();
  dump();
  process.exit(0);
})().catch(e => { console.error('ERR', e); dump(); process.exit(1); });
