// 只读诊断探针（第 7 轮）：挖透「按活动 ID」的 JSON 端点 /api/fut/live-hub/{ver}/campaigns/{id}/
//
// R6 关键发现：
//   · /api/fut/live-hub/27/campaigns/        → 200，2 个活动（21 Ones to Watch / 22 Destined for Glory）
//   · /api/fut/live-hub/27/campaigns/21/     → 200，**10.6MB**（很可能内嵌该活动全量球员+进度）
//   · /api/fut/live-hub/27/campaigns/21/players/ → 404（没有 per-players 子端点）
//   · slug 形式 /campaigns/ones-to-watch/ → 404（只认数字 id）
//   · 活动内页 HTML 抓不到球员卡（href 形态不是 /players/27-xxx/）⇒ HTML 路线放弃，走 API
//
// 本轮要回答：
//   1. 这个 10MB 端点里，球员的**路径/字段名**是什么？是否含逐球员真实进度（playerValue/isCompleted）
//   2. 21/22 两个活动的球员集合，能否覆盖「被追踪全集」（tid32=21 人 / tid33=11 人 / tid34=6 人）
//   3. tid34 那 6 人（此前因无模板被跳过）落在哪个活动 ⇒ 能否复活
//   4. 升级条件（objectives）是不是逐球员的，还是共享模板
//
// ⚠️ 只落**精简摘要**，绝不把 10MB 原始 JSON 提交回仓库。
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'probe', 'live_hub');
const VER = Number(process.argv[2] || process.env.FC_VER || 27);
const BASE = 'https://www.fut.gg/api/fut';
const SITE = 'https://www.fut.gg';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36';

const HARD_TIMEOUT_MS = Number(process.env.PROBE_TIMEOUT_MS || 15 * 60 * 1000);
const out = { generatedAt: new Date().toISOString(), VER, round: 7, note: '', campaigns: [], coverage: {} };
function dump() {
  try {
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, 'campaign_probe2.json'), JSON.stringify(out, null, 2));
  } catch (e) { console.log('dump err', e.message); }
}
const watchdog = setTimeout(() => { out.note = 'WATCHDOG TIMEOUT（部分结果）'; dump(); console.error('WATCHDOG TIMEOUT'); process.exit(5); }, HARD_TIMEOUT_MS);

function jget(t) { try { return JSON.parse(t); } catch (e) { return null; } }
async function apiGet(page, url) {
  for (let a = 1; a <= 2; a++) {
    try {
      const r = await page.request.get(url, { headers: { Accept: 'application/json' }, timeout: 180000 });
      return { status: r.status(), body: await r.text() };
    } catch (e) { console.log('  api err', e.message); }
    if (a < 2) await page.waitForTimeout(3000);
  }
  return null;
}
// 递归找一个数组：元素里有 eaId（或 playerSlug）字段，长度最大者
function findPlayerArray(node, depth) {
  if (depth > 6) return null;
  if (Array.isArray(node)) {
    if (node.length && node[0] && typeof node[0] === 'object') {
      const k = Object.keys(node[0]);
      if (k.some(x => /^(eaId|playerEaId|playerId)$/i.test(x)) || (k.includes('slug') && k.some(x => /player|value|objectiv/i.test(x)))) {
        return node;
      }
    }
    return null;
  }
  if (!node || typeof node !== 'object') return null;
  let best = null;
  for (const key of Object.keys(node)) {
    const r = findPlayerArray(node[key], depth + 1);
    if (r && (!best || r.length > best.length)) best = r;
  }
  return best;
}
function shapeOf(node, depth) {
  if (depth > 3) return '…';
  if (Array.isArray(node)) return `[${node.length}]` + (node[0] && typeof node[0] === 'object' ? ' of {' + Object.keys(node[0]).join(',') + '}' : '');
  if (node && typeof node === 'object') return '{' + Object.keys(node).map(k => k + ':' + shapeOf(node[k], depth + 1)).join(', ') + '}';
  return typeof node;
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
    try {
      const r = await page.request.get(`${BASE}/players/v2/${VER}/?page=1`, { headers: { Accept: 'application/json' }, timeout: 20000 });
      if (r.status() === 200) { passed = true; console.log('CF 通过', i + 1); break; }
    } catch (e) { }
    await page.waitForTimeout(3000);
  }
  if (!passed) { out.note = 'CF 未通过'; dump(); await browser.close(); process.exit(2); }

  // ① 被追踪全集（has_dynamic + definition-data 反查）— 用于覆盖率核对
  console.log('\n① 被追踪全集 ...');
  const dyn = {};
  for (let pg = 1; pg <= 8; pg++) {
    const r = await apiGet(page, `${BASE}/players/v2/${VER}/?has_dynamic=true&page=${pg}`);
    if (!r || r.status !== 200) break;
    const arr = (jget(r.body) && Array.isArray(jget(r.body).data)) ? jget(r.body).data : [];
    for (const pl of arr) { const ea = pl.eaId != null ? Number(pl.eaId) : null; if (ea) dyn[ea] = pl.slug || ''; }
    if (!arr.length) break;
  }
  const defMap = {};
  const slugs = Object.values(dyn).filter(Boolean);
  for (let i = 0; i < slugs.length; i += 50) {
    const r = await apiGet(page, `${BASE}/players/v2/definition-data/?game=${VER}&slugs=${encodeURIComponent(slugs.slice(i, i + 50).join(','))}`);
    if (!r || r.status !== 200) continue;
    const list = jget(r.body) || [];
    for (const d of list) {
      let ea = d.eaId != null ? Number(d.eaId) : null;
      if (ea == null && d.slug) { const mm = /(\d+)$/.exec(d.slug); if (mm) ea = Number(mm[1]); }
      if (ea == null) continue;
      defMap[String(ea)] = (d.liveHubTrackerId != null) ? d.liveHubTrackerId : null;
    }
  }
  const byTid = {};
  for (const e of Object.keys(dyn)) { const t = defMap[e]; if (t != null) (byTid[t] = byTid[t] || []).push(String(e)); }
  out.tracked = Object.keys(byTid).reduce((a, k) => (a[k] = byTid[k].length, a), {});
  console.log('  被追踪', JSON.stringify(out.tracked));

  // ② 活动列表 → 逐活动拉 10MB 端点
  console.log('\n② 活动端点 ...');
  const rc = await apiGet(page, `${BASE}/live-hub/${VER}/campaigns/`);
  const camps = (rc && rc.status === 200 && jget(rc.body) && Array.isArray(jget(rc.body).data)) ? jget(rc.body).data : [];
  for (const c of camps) {
    const id = c.id, slug = c.slug;
    console.log(`\n  === #${id} ${slug} ===`);
    const r = await apiGet(page, `${BASE}/live-hub/${VER}/campaigns/${id}/`);
    const rec = { id, slug, name: c.name, trackerIds: c.trackerIds || [], status: r ? r.status : 'ERR', bytes: r ? r.body.length : 0 };
    if (r && r.status === 200) {
      const j = jget(r.body);
      const data = j && j.data ? j.data : j;
      rec.dataKeys = data && typeof data === 'object' ? Object.keys(data) : [];
      rec.shape = shapeOf(data, 0).slice(0, 1200);
      const players = findPlayerArray(data, 0);
      rec.playerArrayLen = players ? players.length : 0;
      if (players && players.length) {
        const p0 = players[0];
        rec.playerKeys = Object.keys(p0);
        rec.playerSampleTrimmed = JSON.stringify(p0).slice(0, 1500);
        const eaKey = Object.keys(p0).find(k => /^(eaId|playerEaId|playerId)$/i.test(k)) || null;
        rec.eaKey = eaKey;
        const eas = new Set();
        let withValue = 0, withObj = 0;
        for (const p of players) {
          const ea = eaKey ? p[eaKey] : null;
          if (ea != null) eas.add(String(ea));
          if (p.playerValue != null) withValue++;
          if (p.objectives != null) withObj++;
        }
        rec.eaCount = eas.size;
        rec.withPlayerValue = withValue;
        rec.withObjectives = withObj;
        rec.eaList = [...eas].slice(0, 40);
        // 覆盖率：该活动覆盖哪些 trackerId
        const cov = {};
        for (const tid of Object.keys(byTid)) {
          const set = new Set(byTid[tid]);
          cov[tid] = [...eas].filter(e => set.has(e)).length;
        }
        rec.coverageByTid = cov;
        console.log(`    players=${players.length} eaCount=${rec.eaCount} playerValue=${withValue} objectives=${withObj}`);
        console.log(`    playerKeys: ${rec.playerKeys.join(',')}`);
        console.log(`    覆盖 tid: ${JSON.stringify(cov)}（全集 ${JSON.stringify(out.tracked)}）`);
      } else {
        console.log('    未找到球员数组；dataKeys=' + (rec.dataKeys || []).join(','));
      }
    } else {
      console.log('    status', rec.status);
    }
    out.campaigns.push(rec);
  }

  // ③ 全活动合并后，被追踪全集里还有谁没被覆盖
  const covered = new Set();
  for (const c of out.campaigns) for (const e of (c.eaList || [])) covered.add(e);
  // eaList 只截了 40，覆盖率用 coverageByTid 汇总更准
  const agg = {};
  for (const tid of Object.keys(byTid)) {
    agg[tid] = { total: byTid[tid].length, byCampaign: {} };
    for (const c of out.campaigns) agg[tid].byCampaign[c.slug] = (c.coverageByTid || {})[tid] || 0;
  }
  out.coverage = agg;
  out.note = out.campaigns.some(c => c.eaCount > 0) ? 'HIT: 活动端点含球员数据' : 'MISS';
  clearTimeout(watchdog);
  await browser.close();
  dump();
  console.log('\n===== ' + out.note + ' =====');
  for (const tid of Object.keys(agg)) console.log(` tid${tid}: 全集 ${agg[tid].total} → ${JSON.stringify(agg[tid].byCampaign)}`);
  process.exit(0);
})().catch(e => { console.error('ERR', e); out.note = 'ERR ' + e.message; dump(); process.exit(1); });
