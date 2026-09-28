// 只读诊断探针（第 9 轮）：挖透 /api/fut/live-hub/{ver}/players/?campaign_id={id}
//
// R8（网络拦截）关键发现 —— 这才是真接口：
//   /api/fut/live-hub/27/players/?campaign_id=21 → 200，834KB，含 "eaId" + "playerValue"
//   /api/fut/live-hub/27/players/?campaign_id=22 → 200，674KB，同上
//   ⚠️ 参数名必须是 **campaign_id**（R6 试的 ?campaign=21 只返 {"data":[]}，11 字节的空结果）
//   ⚠️ 球员页 URL 形态是 /players/<name-slug>/27-<eaId>/（不是 /players/27-<eaId>/）
//      ⇒ R5/R6 的 HTML 卡片正则（/\/players\/(\d+)-(\d+)\//）匹配不到，属**探针口径错误**，不是页面没数据
//
// 本轮要定死（直接决定生产实现）：
//   1. 响应结构：data 是不是直数组？球员对象在几层？eaId/playerValue/isCompleted/objectives 在哪个键路径
//   2. 数量与覆盖：21/22 两个活动各多少人；能否覆盖「被追踪全集」（tid32=21 / tid33=11 / tid34=6）
//   3. tid34 那 6 人（此前因无升级条件模板被跳过）落哪个活动 ⇒ 能否复活
//   4. 升级条件是不是逐球员的（有没有 playerValue 真实进度），还是共享模板
//   5. 有没有分页（?page=2）
//
// ⚠️ 只落精简摘要，不落 800KB 原始响应。
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
const out = { generatedAt: new Date().toISOString(), VER, round: 9, note: '', campaigns: [], coverage: {} };
function dump() {
  try {
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, 'players_probe.json'), JSON.stringify(out, null, 2));
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
// 递归找「含指定键」的对象路径（返回第一个命中的路径 + 值）
function findPath(node, keyRe, path, depth) {
  if (depth > 7 || !node || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (let i = 0; i < Math.min(node.length, 3); i++) {
      const r = findPath(node[i], keyRe, path + '[' + i + ']', depth + 1);
      if (r) return r;
    }
    return null;
  }
  for (const k of Object.keys(node)) {
    if (keyRe.test(k)) return { path: path + '.' + k, value: node[k] };
  }
  for (const k of Object.keys(node)) {
    const r = findPath(node[k], keyRe, path + '.' + k, depth + 1);
    if (r) return r;
  }
  return null;
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

  // ① 被追踪全集（覆盖率核对基线）
  console.log('\n① 被追踪全集 ...');
  const dyn = {};
  for (let pg = 1; pg <= 8; pg++) {
    const r = await apiGet(page, `${BASE}/players/v2/${VER}/?has_dynamic=true&page=${pg}`);
    if (!r || r.status !== 200) break;
    const jj = jget(r.body);
    const arr = (jj && Array.isArray(jj.data)) ? jj.data : [];
    for (const pl of arr) { const ea = pl.eaId != null ? Number(pl.eaId) : null; if (ea) dyn[ea] = pl.slug || ''; }
    if (!arr.length) break;
  }
  const defMap = {};
  const slugs = Object.values(dyn).filter(Boolean);
  for (let i = 0; i < slugs.length; i += 50) {
    const r = await apiGet(page, `${BASE}/players/v2/definition-data/?game=${VER}&slugs=${encodeURIComponent(slugs.slice(i, i + 50).join(','))}`);
    if (!r || r.status !== 200) continue;
    const jj = jget(r.body);
    const list = Array.isArray(jj) ? jj : (jj && Array.isArray(jj.data) ? jj.data : []);
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
  console.log('  ', JSON.stringify(out.tracked));

  // ② 逐活动抓 players?campaign_id=
  console.log('\n② 活动球员 ...');
  const rc = await apiGet(page, `${BASE}/live-hub/${VER}/campaigns/`);
  const jc = rc ? jget(rc.body) : null;
  const camps = (jc && Array.isArray(jc.data)) ? jc.data : [{ id: 21, slug: 'ones-to-watch' }, { id: 22, slug: 'destined-for-glory' }];
  for (const c of camps) {
    const id = c.id;
    console.log(`\n  === #${id} ${c.slug} ===`);
    const r = await apiGet(page, `${BASE}/live-hub/${VER}/players/?campaign_id=${id}`);
    const rec = { id, slug: c.slug, trackerIds: c.trackerIds || [], status: r ? r.status : 'ERR', bytes: r ? r.body.length : 0 };
    if (r && r.status === 200) {
      const j = jget(r.body);
      const data = (j && j.data != null) ? j.data : j;
      rec.isArray = Array.isArray(data);
      rec.len = Array.isArray(data) ? data.length : (data && typeof data === 'object' ? Object.keys(data).length : 0);
      rec.topKeys = data && typeof data === 'object' && !Array.isArray(data) ? Object.keys(data).slice(0, 20) : null;
      // 结构定位
      const pEa = findPath(data, /^(eaId|playerEaId)$/, '', 0);
      const pPv = findPath(data, /^playerValue$/, '', 0);
      const pObj = findPath(data, /^objectives$/, '', 0);
      rec.paths = { eaId: pEa && pEa.path, playerValue: pPv && pPv.path, objectives: pObj && pObj.path };
      console.log('    len', rec.len, '| 路径', JSON.stringify(rec.paths));
      if (Array.isArray(data) && data.length) {
        rec.itemKeys = Object.keys(data[0]);
        rec.itemSample = JSON.stringify(data[0]).slice(0, 2000);
        console.log('    itemKeys:', rec.itemKeys.join(','));
        console.log('    sample:', rec.itemSample.slice(0, 500));
      }
      // 收集 eaId 集合（沿路径）
      const eas = new Set();
      const collect = (node, seg) => {
        if (!node) return;
        if (Array.isArray(node)) { for (const x of node) collect(x, seg); return; }
        if (typeof node !== 'object') return;
        if (node.eaId != null) eas.add(String(node.eaId));
        for (const k of Object.keys(node)) if (typeof node[k] === 'object') collect(node[k], seg);
      };
      collect(data, '');
      rec.eaCount = eas.size;
      rec.eaList = [...eas].slice(0, 60);
      const cov = {};
      for (const tid of Object.keys(byTid)) {
        const set = new Set(byTid[tid]);
        cov[tid] = [...eas].filter(e => set.has(e)).length;
      }
      rec.coverageByTid = cov;
      console.log('    eaCount', rec.eaCount, '| 覆盖', JSON.stringify(cov), '（全集', JSON.stringify(out.tracked), '）');
      // 分页探测
      const r2 = await apiGet(page, `${BASE}/live-hub/${VER}/players/?campaign_id=${id}&page=2`);
      if (r2 && r2.status === 200) {
        const j2 = jget(r2.body);
        const d2 = (j2 && j2.data != null) ? j2.data : j2;
        rec.page2Len = Array.isArray(d2) ? d2.length : (d2 && typeof d2 === 'object' ? Object.keys(d2).length : 0);
        console.log('    page2 len', rec.page2Len);
      }
    } else {
      console.log('    status', rec.status);
    }
    out.campaigns.push(rec);
  }

  const agg = {};
  for (const tid of Object.keys(byTid)) {
    agg[tid] = { total: byTid[tid].length, byCampaign: {} };
    for (const c of out.campaigns) agg[tid].byCampaign[c.slug] = (c.coverageByTid || {})[tid] || 0;
  }
  out.coverage = agg;
  out.note = out.campaigns.some(c => c.eaCount > 0) ? 'HIT: campaign_id 端点含全量球员' : 'MISS';
  clearTimeout(watchdog);
  await browser.close();
  dump();
  console.log('\n===== ' + out.note + ' =====');
  for (const tid of Object.keys(agg)) console.log(` tid${tid}: 全集 ${agg[tid].total} → ${JSON.stringify(agg[tid].byCampaign)}`);
  process.exit(0);
})().catch(e => { console.error('ERR', e); out.note = 'ERR ' + e.message; dump(); process.exit(1); });
