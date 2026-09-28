// 只读诊断探针（第 9 轮）：摸清 **campaign 详情 API**（10.6MB）的结构 —— 决定落地走 JSON 还是 HTML。
//
// R8 成果（两条真源都已实证）：
//   ① API：`/api/fut/live-hub/27/campaigns/<id>/` → 200 / **10.6MB**；`data.campaign.trackerIds=[33,34]`
//      （坐实 DFG campaign 同时覆盖 trackerId 33 与 34 —— 即此前「跳过」的 6 张 tid34 卡属于 DFG）
//      campaigns 列表只有 2 条：id22 Destined for Glory / id21 Ones to Watch（FC27 当前活动）
//   ② HTML：`/live-hub/campaigns/<slug>/players/` 逐卡含「条件 + 奖励 + 进度」：
//      · OTW 21 张：`Win 3 of next 6 matches (1/6)` + 绿条 g=0/6、g=1/6、g=2/6 各不相同
//        ⇒ 绿条＝真实达成数（赢了几场），(N/M)＝窗口场次（已打 N / 共 M），两者都要
//      · DFG 17 张（tid33 11 + tid34 6 ✅）：`3 goals or assists | +1 Shooting & Passing | … | 20 goals or assists | 0/20 | +1 OVR`
//
// 本轮：只做结构分析（不 dump 大 JSON），自动在 data 树里找「最长的数组」定位球员列表，
//       并报告球员对象 / 升级条件对象的键名，判断能否直接 JSON 消费。
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
const out = { generatedAt: new Date().toISOString(), VER, round: 9, note: '', sections: {} };
function dump() { try { fs.mkdirSync(OUT, { recursive: true }); fs.writeFileSync(path.join(OUT, 'detail_probe.json'), JSON.stringify(out, null, 2)); } catch (e) { console.log('dump err', e.message); } }
const watchdog = setTimeout(() => { out.note = 'WATCHDOG TIMEOUT（部分结果）'; dump(); console.error('WATCHDOG TIMEOUT'); process.exit(5); }, HARD_TIMEOUT_MS);

function jget(t) { try { return JSON.parse(t); } catch (e) { return null; } }
async function apiGet(page, url) {
  for (let a = 1; a <= 3; a++) {
    try {
      const r = await page.request.get(url, { headers: { Accept: 'application/json' }, timeout: 120000 });
      const t = await r.text();
      if (r.status() === 200) return { status: 200, body: t };
      return { status: r.status(), body: t.slice(0, 200) };
    } catch (e) { console.log('  api err', e.message); }
    if (a < 3) await page.waitForTimeout(3000);
  }
  return null;
}

// 在对象树里找所有数组（深度 ≤4），返回路径/长度/首元素键名
function findArrays(node, prefix, depth, acc) {
  if (depth > 4 || node == null || typeof node !== 'object') return acc;
  if (Array.isArray(node)) {
    if (node.length > 3) {
      const first = node[0];
      acc.push({ path: prefix, len: node.length, itemKeys: (first && typeof first === 'object') ? Object.keys(first).slice(0, 25) : typeof first });
    }
    if (node.length && typeof node[0] === 'object') findArrays(node[0], prefix + '[0]', depth + 1, acc);
    return acc;
  }
  for (const k of Object.keys(node)) findArrays(node[k], prefix ? prefix + '.' + k : k, depth + 1, acc);
  return acc;
}

function summarize(id, r) {
  const s = { id, status: r ? r.status : null, bytes: r ? r.body.length : 0, note: '' };
  if (!r || r.status !== 200) { s.note = 'non-200'; return s; }
  const j = jget(r.body);
  if (!j) { s.note = 'JSON 解析失败'; return s; }
  const data = j.data || j;
  s.dataKeys = Object.keys(data).slice(0, 30);
  s.campaign = data.campaign ? { id: data.campaign.id, name: data.campaign.name, slug: data.campaign.slug, trackerIds: data.campaign.trackerIds || [] } : null;
  const arrs = findArrays(data, '', 0, []).sort((a, b) => b.len - a.len).slice(0, 12);
  s.arrays = arrs;
  // 找「球员列表」：路径含 player 且长度 >5 的最长数组
  const playersArr = arrs.filter(a => /player/i.test(a.path)).sort((a, b) => b.len - a.len)[0];
  s.playersArrayPath = playersArr ? playersArr.path : null;
  s.playersLen = playersArr ? playersArr.len : 0;
  s.playerKeys = playersArr ? playersArr.itemKeys : [];
  // 抽样：取第一个球员（按路径取不到就跳过）
  try {
    let node = data;
    const parts = (playersArr ? playersArr.path : '').split('.');
    for (const p of parts) { if (p === '') continue; node = node[p]; }
    if (Array.isArray(node) && node.length) {
      const p0 = node[0];
      s.sample = {
        eaId: p0.eaId || (p0.card && p0.card.eaId) || null,
        name: p0.name || p0.commonName || (p0.card && (p0.card.name || p0.card.commonName)) || null,
        keys: Object.keys(p0).slice(0, 30)
      };
      // objectives 抽样
      const objKey = Object.keys(p0).find(k => /objective|upgrade|tracker/i.test(k));
      if (objKey && Array.isArray(p0[objKey]) && p0[objKey].length) {
        const o0 = p0[objKey][0];
        s.objectiveKey = objKey;
        s.objectiveKeys = Object.keys(o0).slice(0, 30);
        s.objectiveSample = { label: o0.label || o0.name || null, value: o0.value != null ? o0.value : null, playerValue: o0.playerValue != null ? o0.playerValue : null, isCompleted: o0.isCompleted != null ? o0.isCompleted : null, target: o0.target != null ? o0.target : null, requirement: o0.requirement || null, upgrades: o0.upgrades || null };
      }
    }
  } catch (e) { s.sampleErr = e.message; }
  s.playerValueHits = (r.body.match(/playerValue/g) || []).length;
  s.objectiveHits = (r.body.match(/objectives/g) || []).length;
  return s;
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

  out.sections.campaigns = [];
  for (const id of [21, 22]) {
    console.log(`\n=== campaign ${id} ===`);
    const r = await apiGet(page, `${BASE}/live-hub/${VER}/campaigns/${id}/`);
    const s = summarize(id, r);
    out.sections.campaigns.push(s);
    console.log(`  status=${s.status} bytes=${s.bytes} dataKeys=${JSON.stringify(s.dataKeys)}`);
    console.log(`  campaign=${JSON.stringify(s.campaign)}`);
    console.log(`  arrays(前6): ${JSON.stringify((s.arrays || []).slice(0, 6))}`);
    console.log(`  playersArray=${s.playersArrayPath} len=${s.playersLen}`);
    console.log(`  playerKeys=${JSON.stringify(s.playerKeys)}`);
    console.log(`  sample=${JSON.stringify(s.sample)}`);
    console.log(`  objectiveKey=${s.objectiveKey} objectiveKeys=${JSON.stringify(s.objectiveKeys)}`);
    console.log(`  objectiveSample=${JSON.stringify(s.objectiveSample)}`);
    console.log(`  playerValueHits=${s.playerValueHits} objectiveHits=${s.objectiveHits}`);
  }

  const usable = out.sections.campaigns.filter(s => s.playersLen > 5 && s.playerKeys.length > 0);
  out.note = usable.length ? `HIT: campaign API 可直接消费（players 数组 ${usable.map(u => u.id + ':' + u.playersLen).join(', ')}）` : 'MISS: campaign API 未找到可用球员数组';
  clearTimeout(watchdog);
  await browser.close();
  dump();
  console.log('\n===== ' + out.note + ' =====');
  process.exit(0);
})().catch(e => { console.error('ERR', e); out.note = 'ERR ' + e.message; dump(); process.exit(1); });
