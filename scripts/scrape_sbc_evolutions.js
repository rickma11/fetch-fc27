// 正式抓取：fut.gg 的 SBC 与 Evolutions 数据。
// 机制与 fetch_ci.js 完全一致：真实 Chromium 过 Cloudflare → 页面内 fetch 探端点。
// 数据源（r11/r12/r13 探查已坐实）：
//   Evolutions = r2.fut.gg/{ver}/manifest.json 的 active-evolutions / all-evolutions 静态 CDN（hash 空 = 无数据）
//   SBC 列表   = https://www.fut.gg/api/fut/sbc/{ver}?page=N （分页；详情已内嵌在列表的 challenges/awards 里）
// 输出：
//   cloud-data/fc{ver}/sbcs.json        { ver, totalCount, fetchedAt, sets:[...] }
//   cloud-data/fc{ver}/evolutions.json   { ver, fetchedAt, active:[...], all:[...] }
// 用法：
//   node scripts/scrape_sbc_evolutions.js --ver 27
//   node scripts/scrape_sbc_evolutions.js --ver 26 --out cloud-data/fc26
// 失败语义：单个数据源抓取失败不致命（记录 errors[]），只把成功的部分写出；CF 完全没过才 exit 1。

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const UA = process.env.CF_UA || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36';

// ---- 参数 ----
function parseArgs(argv) {
  const o = { ver: parseInt(process.env.FC_VER, 10) || 27 };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--ver') { o.ver = parseInt(argv[++i], 10) || 27; }
    else if (a === '--out') { o.out = argv[++i]; }
    else if (a === '--no-evo') { o.noEvo = true; }
    else if (a === '--no-sbc') { o.noSbc = true; }
  }
  if (!o.out) o.out = path.resolve(__dirname, '..', 'cloud-data', 'fc' + o.ver);
  return o;
}
const ARGS = parseArgs(process.argv);
const VER = ARGS.ver;

const sleep = ms => new Promise(r => setTimeout(r, ms));

// 验证模式：PROBE_OUT=1 时把输出额外写进 probe/ 目录，便于从 CI artifact 读回核验
// （正式接入每日管线时不需要此开关，数据落 cloud-data/fc{ver}/ 即可）。
const PROBE_OUT = process.env.PROBE_OUT === '1' || process.env.PROBE_OUT === 'true';
const PROBE_DIR = path.resolve(__dirname, '..', 'probe');
function maybeProbe(name, obj) {
  if (PROBE_OUT && obj) {
    if (!fs.existsSync(PROBE_DIR)) fs.mkdirSync(PROBE_DIR, { recursive: true });
    fs.writeFileSync(path.join(PROBE_DIR, name), JSON.stringify(obj, null, 2));
    console.log('  [probe] 已额外写出 probe/' + name);
  }
}

// 空字符串的 MD5（r2.fut.gg 用此表示「该数据集为空」）
const EMPTY_HASH = 'd7517139';

(async () => {
  if (!fs.existsSync(ARGS.out)) fs.mkdirSync(ARGS.out, { recursive: true });

  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox', '--disable-dev-shm-usage']
  });
  const ctx = await browser.newContext({
    userAgent: UA,
    locale: 'en-US',
    viewport: { width: 1280, height: 800 },
    timezoneId: 'America/New_York'
  });
  const page = await ctx.newPage();
  page.on('console', m => { const t = m.text(); if (/error|fail/i.test(t)) console.log('[browser]', t); });

  console.log('打开 fut.gg 过 Cloudflare ...');
  await page.goto('https://www.fut.gg/sbc/', { waitUntil: 'domcontentloaded', timeout: 60000 });

  // 轮询 SBC 列表第 1 页，直到 200 —— 既验证 CF 通关、又确认 SBC 端点可达
  let passed = false;
  const probeUrl = `https://www.fut.gg/api/fut/sbc/${VER}?page=1`;
  for (let i = 0; i < 30; i++) {
    let status = -1;
    try {
      status = await page.evaluate(async (u) => {
        try { const r = await fetch(u, { headers: { Accept: 'application/json' } }); return r.status; }
        catch (e) { return -1; }
      }, probeUrl);
    } catch (e) { status = -2; }
    if (status === 200) { passed = true; console.log(`Cloudflare 已通过（第 ${i + 1} 次尝试），SBC 端点可达`); break; }
    if (status === 404) { console.log('SBC 端点 404（该版本可能尚未上线 SBC）——继续等 CF，但视为未过'); break; }
    console.log(`等待 Cloudflare 挑战解除... status=${status} (${i + 1}/30)`);
    await page.waitForTimeout(3000);
  }
  if (!passed) {
    // 404 不算「没过 CF」——可能是该版本无 SBC；但若连 200 都没拿到，视为 CF 没过
    console.error('未能确认 Cloudflare 通过（SBC 端点未返回 200）。退出。');
    await browser.close();
    process.exit(1);
  }

  const errors = [];
  const fetchedAt = new Date().toISOString();

  // ---------- SBC 列表（分页）----------
  let sbcs = null;
  if (!ARGS.noSbc) {
    try {
      sbcs = await page.evaluate(async (ver) => {
        const BASE = `https://www.fut.gg/api/fut/sbc/${ver}`;
        const sleep = ms => new Promise(r => setTimeout(r, ms));
        const sets = [];
        let page = 1, totalPages = 1, totalCount = 0;
        while (page <= totalPages) {
          const r = await fetch(`${BASE}?page=${page}`, { headers: { Accept: 'application/json' } });
          if (!r.ok) throw new Error(`SBC page ${page} status=${r.status}`);
          const j = await r.json();
          const arr = Array.isArray(j.data) ? j.data : [];
          sets.push(...arr);
          if (typeof j.totalPages === 'number') totalPages = j.totalPages;
          if (typeof j.totalCount === 'number') totalCount = j.totalCount;
          console.log(`  SBC page ${page}/${totalPages} +${arr.length} (累计 ${sets.length}/${totalCount || '?'})`);
          page++;
          if (page <= totalPages) await sleep(400); // 轻微限速，避免触发风控
        }
        return { ver: String(ver), totalCount, totalPages, count: sets.length, sets };
      }, VER);
      sbcs.fetchedAt = fetchedAt;
      console.log(`SBC 完成：totalCount=${sbcs.totalCount} 实抓 ${sbcs.count} 组`);
      fs.writeFileSync(path.join(ARGS.out, 'sbcs.json'), JSON.stringify(sbcs, null, 2));
      maybeProbe('sbcs.json', sbcs);
    } catch (e) {
      errors.push({ source: 'sbc', message: e.message });
      console.error('SBC 抓取失败：', e.message);
    }
  }

  // ---------- Evolutions（r2.fut.gg 静态 CDN）----------
  let evo = null;
  if (!ARGS.noEvo) {
    try {
      evo = await page.evaluate(async (ver) => {
        const sleep = ms => new Promise(r => setTimeout(r, ms));
        const manUrl = `https://r2.fut.gg/${ver}/manifest.json`;
        const mr = await fetch(manUrl, { headers: { Accept: 'application/json' } });
        if (!mr.ok) throw new Error(`manifest status=${mr.status}`);
        const manifest = await mr.json();
        const out = { ver: String(ver), manifestKeys: Object.keys(manifest), active: [], all: [] };
        for (const key of ['active-evolutions', 'all-evolutions']) {
          const hash = manifest[key];
          if (!hash || hash === 'd7517139') {
            console.log(`  ${key}: 无数据（hash=${hash || '空'}）`);
            out[key.replace('-evolutions', '') + 'Hash'] = hash || '';
            continue;
          }
          out[key.replace('-evolutions', '') + 'Hash'] = hash;
          const url = `https://r2.fut.gg/${ver}/${key}.v1.${hash}.json`;
          const r = await fetch(url, { headers: { Accept: 'application/json' } });
          if (!r.ok) throw new Error(`${key} status=${r.status}`);
          const arr = await r.json();
          const list = Array.isArray(arr) ? arr : (arr.data || []);
          out[key.replace('-evolutions', '')] = list;
          console.log(`  ${key}: ${list.length} 条`);
          await sleep(300);
        }
        return out;
      }, VER);
      evo.fetchedAt = fetchedAt;
      console.log(`Evolutions 完成：active=${evo.active.length} all=${evo.all.length}`);
      fs.writeFileSync(path.join(ARGS.out, 'evolutions.json'), JSON.stringify(evo, null, 2));
      maybeProbe('evolutions.json', evo);
    } catch (e) {
      errors.push({ source: 'evolutions', message: e.message });
      console.error('Evolutions 抓取失败：', e.message);
    }
  }

  await browser.close();

  const summary = {
    ver: VER,
    fetchedAt,
    sbc: sbcs ? { totalCount: sbcs.totalCount, count: sbcs.count } : (ARGS.noSbc ? 'skipped' : 'failed'),
    evolutions: evo ? { active: evo.active.length, all: evo.all.length } : (ARGS.noEvo ? 'skipped' : 'failed'),
    errors
  };
  fs.writeFileSync(path.join(ARGS.out, 'sbc_evo_summary.json'), JSON.stringify(summary, null, 2));
  maybeProbe('sbc_evo_summary.json', summary);
  console.log('===== 抓取摘要 =====');
  console.log(JSON.stringify(summary, null, 2));
  if (errors.length) { console.error('存在抓取错误，但已写出成功部分'); }
})().catch(e => { console.error('FATAL', e); process.exit(1); });
