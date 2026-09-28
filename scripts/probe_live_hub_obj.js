// 只读诊断探针（第 10 轮）：把 tracker.objectives 的完整字段抓下来，供生产解析器写死字段。
//
// R9 已定位：/api/fut/live-hub/{ver}/players/?campaign_id={id} → 直数组，每条：
//   playerItemEaId / trackerId / campaignId / competitionName / clubName / nationName
//   data  = 逐球员原始计数（numberOfWins、goalsInDifferentMatches…）
//   card  = 卡面（含 eaId）
//   tracker.objectives[] = 升级条件，**含 playerValue（逐球员真实进度）**
// 覆盖：campaign21 → tid32 全部 21；campaign22 → tid33(11) + tid34(6) = 17 ⇒ 被追踪全集 38 张全覆盖
//
// 本轮只做一件事：dump 几个 objectives 对象的**完整 JSON**（含 tid34 那条），确认
//   · 字段名（requirement/label/value/upgrades/playerValue/isCompleted/isNotPossible…）
//   · 标签里有没有 (N/M) 插值（有 ⇒ 必须剥离，否则人人 2/6 的统计错误会重现）
//   · 同 trackerId 不同球员的 playerValue 是否不同（确认真是逐球员进度，而非共享模板）
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
const out = { generatedAt: new Date().toISOString(), VER, round: 10, note: '', samples: [], agg: {} };
function dump() {
  try {
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, 'obj_probe.json'), JSON.stringify(out, null, 2));
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
  if (!passed) { out.note = 'CF 未通过'; dump(); await browser.close(); process.exit(2); }

  const all = [];
  for (const id of [21, 22]) {
    const r = await apiGet(page, `${BASE}/live-hub/${VER}/players/?campaign_id=${id}`);
    if (!r || r.status !== 200) continue;
    const j = jget(r.body);
    const arr = (j && Array.isArray(j.data)) ? j.data : (Array.isArray(j) ? j : []);
    for (const it of arr) all.push(it);
    console.log(`campaign ${id} → ${arr.length} 条`);
  }
  out.total = all.length;

  // ① objectives 字段名 + 标签插值检查（全量统计）
  const keySet = new Set();
  let withProgressInLabel = 0, totalObj = 0;
  const pvByTracker = {};
  for (const it of all) {
    const objs = (it.tracker && it.tracker.objectives) || [];
    const tid = it.trackerId;
    for (const o of objs) {
      totalObj++;
      for (const k of Object.keys(o)) keySet.add(k);
      const lbl = String(o.label || o.requirement || '');
      if (/\(\s*\d+\s*\/\s*\d+\s*\)/.test(lbl)) withProgressInLabel++;
    }
    pvByTracker[tid] = pvByTracker[tid] || [];
    pvByTracker[tid].push({
      eaId: it.playerItemEaId,
      name: (it.card && (it.card.commonName || it.card.cardName)) || '',
      club: it.clubName || '',
      objectives: objs.map(o => ({ label: o.label || o.requirement || '', playerValue: o.playerValue, value: o.value, isCompleted: o.isCompleted }))
    });
  }
  out.agg = { objectKeys: [...keySet], totalObjectives: totalObj, labelsWithProgressInterp: withProgressInLabel };
  console.log('objectives 字段:', [...keySet].join(','));
  console.log('objectives 总数:', totalObj, '| 标签含 (N/M) 插值:', withProgressInLabel);

  // ② 每个 trackerId 各取 2 人（含 tid34）→ 完整 objectives JSON
  const byTid = {};
  for (const it of all) { (byTid[it.trackerId] = byTid[it.trackerId] || []).push(it); }
  for (const tid of Object.keys(byTid).sort()) {
    const list = byTid[tid];
    for (const it of list.slice(0, 2)) {
      const rec = {
        trackerId: Number(tid),
        campaignId: it.campaignId,
        playerItemEaId: it.playerItemEaId,
        cardEaId: it.card ? it.card.eaId : null,
        name: (it.card && (it.card.commonName || it.card.cardName)) || '',
        club: it.clubName || '',
        nation: it.nationName || '',
        competition: it.competitionName || '',
        dataKeys: it.data ? Object.keys(it.data) : [],
        data: it.data || null,
        objectivesJson: ((it.tracker && it.tracker.objectives) || []).slice(0, 4)
      };
      out.samples.push(rec);
      console.log(`\n--- tid${tid} ${rec.name} (${it.playerItemEaId}) club=${rec.club} ---`);
      console.log('   data:', JSON.stringify(rec.data).slice(0, 300));
      for (const o of rec.objectivesJson) console.log('   obj:', JSON.stringify(o).slice(0, 260));
    }
    // 同 trackerId 的 playerValue 差异（证明是逐球员进度）
    const vals = list.map(it => ((it.tracker && it.tracker.objectives) || []).map(o => o.playerValue).join('/')).slice(0, 6);
    console.log(`   tid${tid} 前 6 人 playerValue: ${vals.join('  |  ')}`);
  }

  out.note = 'OK';
  clearTimeout(watchdog);
  await browser.close();
  dump();
  console.log('\n===== R10 done, samples=' + out.samples.length + ' =====');
  process.exit(0);
})().catch(e => { console.error('ERR', e); out.note = 'ERR ' + e.message; dump(); process.exit(1); });
