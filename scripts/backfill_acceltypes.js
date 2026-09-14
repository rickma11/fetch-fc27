// 历史球员 AcceleRATE 分类（accelerateTypes）一次性回填。
//
// ── 为什么需要 ───────────────────────────────────────────────────────────
// fetch_futgg.js 的详情映射新增了 accelerateTypes 字段（7 个桶，元素是化学风格英文名），
// 用于小程序化学风格选择器标注每个风格对应的加速类型（L 长距离 / C 可控 / E 爆发）。
// 但抓取是增量模式：只有「新增 / 变化」的球员会重抓详情，历史约 1 万条要等
// 每周日 full run 才会带上该字段。本脚本用 fut.gg 的**批量详情接口**一次补齐。
//
// ── 接口 ────────────────────────────────────────────────────────────────
//   GET https://www.fut.gg/api/fut/players/v2/{ver}/definition-data/?game={ver}&slugs=27-{eaId},...
//   返回 { data: [ { eaId, accelerateType, accelerateTypes: {...}, ... }, ... ] }
//   ⚠️ 必须走真实浏览器（Cloudflare）；slug 数量一次给 200 会 400，本脚本用 100 并在
//      失败时自动二分降级（100 → 50 → 25 → 10 → 5 → 单人）。
//   ⚠️ 单个 definition 约 10KB，本脚本只留 accelerateTypes，其余丢弃。
//
// ── 用法 ────────────────────────────────────────────────────────────────
//   node scripts/backfill_acceltypes.js                 # 抓取 → 补丁文件（可断点续跑）
//   node scripts/backfill_acceltypes.js --limit 300     # 只抓前 300 个（试跑）
//   node scripts/backfill_acceltypes.js --apply         # 把补丁合并进 cloud-data/fc27/details.json
//   node scripts/backfill_acceltypes.js --upload        # 把补丁写入云库 details_fc{ver}
//   node scripts/backfill_acceltypes.js --apply --upload
//   （--apply / --upload 不联网抓取，只消费已有补丁文件）
//
// 凭证：--upload 需要云开发凭证，走 scripts/tcb_env.js（环境变量或 .env.local）。
const fs = require('fs');
const path = require('path');

const VER = String(process.env.FC_VER || '27').replace(/[^0-9]/g, '') || '27';
const ROOT = path.resolve(__dirname, '..');
const DIR = path.join(ROOT, 'cloud-data', `fc${VER}`);
const DETAILS = path.join(DIR, 'details.json');
const PATCH = path.join(DIR, 'acceltypes.json');

// ⚠️ 注意路径里**没有**版本段（不是 players/v2/27/definition-data），版本走 ?game= 查询参数；
//    写错会一律 404（每条都失败，二分到单人也不通）。
const BASE_BATCH = `https://www.fut.gg/api/fut/players/v2/definition-data/`;
const UA = process.env.CF_UA || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36';

const argv = process.argv.slice(2);
const hasFlag = (f) => argv.indexOf(f) >= 0;
const DO_APPLY = hasFlag('--apply');
const DO_UPLOAD = hasFlag('--upload');
let LIMIT = 0;
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith('--limit=')) LIMIT = Number(argv[i].slice(8)) || 0;
  else if (argv[i] === '--limit' && argv[i + 1]) LIMIT = Number(argv[++i]) || 0;
}
// fut.gg 对 slugs 数量有上限：实测一次 100 个会 400，50 个稳定通过（2026-09-14）。
// 留 --limit 之外的 FC_ACC_BATCH 可调；失败时脚本仍会自动二分降级。
let BATCH = Number(process.env.FC_ACC_BATCH || 50) || 50;

// 只保留 7 个分类桶，元素是化学风格英文名；空桶也保留（便于下游判断完整性）
const BUCKETS = ['lengthy', 'explosive', 'controlled', 'mostlyLengthy', 'mostlyExplosive', 'controlledLengthy', 'controlledExplosive'];

function pickTypes(d) {
  const at = d && d.accelerateTypes;
  if (!at || typeof at !== 'object') return null;
  const out = {};
  let total = 0;
  for (const k of BUCKETS) {
    const v = Array.isArray(at[k]) ? at[k].filter((x) => typeof x === 'string' && x) : [];
    out[k] = v;
    total += v.length;
  }
  return total ? out : null; // 全空视为无效（EA 未下发）
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function launchBrowser() {
  const { chromium } = require('playwright');
  // 本机通常没装 playwright 自带浏览器，优先用本机 Edge；CI 上有自带浏览器，回落到默认
  try {
    return await chromium.launch({ headless: true, channel: process.env.CF_CHANNEL || 'msedge', args: ['--disable-blink-features=AutomationControlled', '--no-sandbox', '--disable-dev-shm-usage'] });
  } catch (e) {
    console.log('（msedge 启动失败，改用 playwright 自带 chromium：' + String(e.message).slice(0, 80) + '）');
    return await chromium.launch({ headless: true, args: ['--disable-blink-features=AutomationControlled', '--no-sandbox', '--disable-dev-shm-usage'] });
  }
}

// 在页面上下文里批量取一次；失败按 2 分降级重试（返回 [] 表示这批彻底拿不到）
async function fetchChunk(page, ids) {
  if (!ids.length) return [];
  const slugs = ids.map((id) => `${VER}-${id}`).join(',');
  const url = `${BASE_BATCH}?game=${VER}&slugs=${slugs}`;
  const status = await page.evaluate(async (u) => {
    try {
      const r = await fetch(u, { headers: { Accept: 'application/json' } });
      if (!r.ok) return { status: r.status };
      const j = await r.json();
      return { status: 200, data: Array.isArray(j.data) ? j.data : [] };
    } catch (e) { return { status: -1, err: String(e && e.message) }; }
  }, url);
  if (status.status === 200) return status.data;
  if (ids.length === 1) {
    console.warn('    ⚠️ 单条也失败 status=' + status.status + ' eaId=' + ids[0]);
    return [];
  }
  // 可能是 slug 太多导致 400/414/413 → 二分再试
  const half = Math.ceil(ids.length / 2);
  console.log('    status=' + status.status + '，二分重试 ' + ids.length + ' → ' + half);
  await sleep(300);
  const a = await fetchChunk(page, ids.slice(0, half));
  await sleep(300);
  const b = await fetchChunk(page, ids.slice(half));
  return a.concat(b);
}

async function crawl() {
  const details = readJson(DETAILS, null);
  if (!details) { console.error('缺少 ' + path.relative(ROOT, DETAILS) + '，无法确定球员清单'); process.exit(1); }
  let all = Object.keys(details);
  console.log(`FC${VER} 详情本地共 ${all.length} 条`);

  const patch = readJson(PATCH, {}) || {};
  const done = new Set(Object.keys(patch));
  let todo = all.filter((id) => !done.has(id));
  if (LIMIT) todo = todo.slice(0, LIMIT);
  console.log(`补丁已有 ${done.size} 条，本次待抓 ${todo.length} 条（批大小 ${BATCH}）`);
  if (!todo.length) { console.log('无需抓取，直接进入 --apply/--upload'); return; }

  const browser = await launchBrowser();
  const ctx = await browser.newContext({ userAgent: UA, locale: 'en-US', viewport: { width: 1280, height: 800 }, timezoneId: 'America/New_York' });
  const page = await ctx.newPage();
  page.on('console', (m) => { const t = m.text(); if (t.indexOf('[browser]') < 0) console.log('[browser]', t); });

  console.log('打开 fut.gg 过 Cloudflare ...');
  await page.goto('https://www.fut.gg/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  let passed = false;
  for (let i = 0; i < 30; i++) {
    const st = await page.evaluate(async (u) => {
      try { const r = await fetch(u, { headers: { Accept: 'application/json' } }); return r.status; } catch (e) { return -1; }
    }, `https://www.fut.gg/api/fut/players/v2/${VER}/?page=1`);
    if (st === 200) { passed = true; console.log(`Cloudflare 已通过（第 ${i + 1} 次尝试）`); break; }
    console.log(`等待 Cloudflare 挑战解除... status=${st} (${i + 1}/30)`);
    await page.waitForTimeout(3000);
  }
  if (!passed) { await browser.close(); console.error('未能通过 Cloudflare，退出'); process.exit(1); }

  let hit = 0, miss = 0, reqs = 0;
  const t0 = Date.now();
  for (let i = 0; i < todo.length; i += BATCH) {
    const ids = todo.slice(i, i + BATCH);
    const data = await fetchChunk(page, ids);
    reqs++;
    const got = new Set();
    for (const d of data) {
      const eaId = d && d.eaId != null ? String(d.eaId) : null;
      if (!eaId) continue;
      const t = pickTypes(d);
      if (t) { patch[eaId] = t; hit++; got.add(eaId); } else { miss++; }
    }
    for (const id of ids) if (!got.has(String(id)) && !patch[id]) miss++;
    // 每批落盘，支持断点续跑（Ctrl+C 也不丢进度）
    fs.writeFileSync(PATCH, JSON.stringify(patch));
    const secs = ((Date.now() - t0) / 1000).toFixed(0);
    console.log(`进度 ${Math.min(i + BATCH, todo.length)}/${todo.length} | 有效 ${hit} | 无数据 ${miss} | 补丁共 ${Object.keys(patch).length} 条 | ${secs}s`);
    await sleep(120);
  }
  await browser.close();
  console.log(`\n抓取完成：新增有效 ${hit} 条，无数据 ${miss} 条，补丁累计 ${Object.keys(patch).length} 条`);
  console.log('补丁文件：' + path.relative(ROOT, PATCH));
}

// 把补丁合并进 details.json（会先备份）
function apply() {
  const patch = readJson(PATCH, null);
  if (!patch) { console.error('补丁文件不存在：' + path.relative(ROOT, PATCH)); process.exit(1); }
  const details = readJson(DETAILS, null);
  if (!details) { console.error('缺少 ' + path.relative(ROOT, DETAILS)); process.exit(1); }
  const bak = DETAILS + '.bak.acceltypes';
  if (!fs.existsSync(bak)) fs.copyFileSync(DETAILS, bak);
  let n = 0, skip = 0;
  for (const id of Object.keys(patch)) {
    if (!details[id]) { skip++; continue; }
    details[id].accelerateTypes = patch[id];
    n++;
  }
  fs.writeFileSync(DETAILS, JSON.stringify(details));
  console.log(`已合并 ${n} 条进 details.json（清单里没有的 ${skip} 条已跳过）；原文件备份 ${path.basename(bak)}`);
  console.log('⚠️ 本地 details.json 与远端 CI 的数据文件会有差异，下次 CI full run 会自然覆盖为同口径内容。');
}

// 把补丁写进云库 details_fc{ver}（只 update 一个字段，不整文档覆盖）
async function upload() {
  const patch = readJson(PATCH, null);
  if (!patch) { console.error('补丁文件不存在：' + path.relative(ROOT, PATCH)); process.exit(1); }
  const cloudbase = require('@cloudbase/node-sdk');
  const tcb = require('./tcb_env');
  const cred = tcb.resolve();
  if (cred.missing.length) { console.error('缺少云开发凭证：' + cred.missing.join(' / ')); console.error(cred.hint); process.exit(1); }
  const app = cloudbase.init({ env: cred.ENV_ID, secretId: cred.SECRET_ID, secretKey: cred.SECRET_KEY, timeout: 90000 });
  const db = app.database();
  const col = `details_fc${VER}`;
  const ids = Object.keys(patch);
  console.log(`写入云库 ${col}：${ids.length} 条（凭证来源 ${cred.source}）`);
  const CONC = Number(process.env.FC_ACC_CONC || 8) || 8;
  let cursor = 0, ok = 0, fail = 0;
  async function w() {
    while (true) {
      const i = cursor++;
      if (i >= ids.length) return;
      const id = ids[i];
      try {
        await db.collection(col).doc(String(id)).update({ accelerateTypes: patch[id] });
        ok++;
      } catch (e) {
        fail++;
        if (fail <= 5) console.warn('  ⚠️ ' + id + ' 写入失败：' + String(e && e.message).slice(0, 120));
      }
      if ((ok + fail) % 200 === 0) console.log(`  已写 ${ok + fail}/${ids.length}（成功 ${ok} 失败 ${fail}）`);
    }
  }
  await Promise.all(Array.from({ length: CONC }, w));
  console.log(`写入完成：成功 ${ok}，失败 ${fail}`);
  if (fail) console.log('提示：失败项多为文档不存在（该球员已下架/换版本），可忽略。');
}

(async () => {
  if (!DO_APPLY && !DO_UPLOAD) {
    await crawl();
    console.log('下一步可选：node scripts/backfill_acceltypes.js --apply --upload');
    return;
  }
  if (DO_APPLY) apply();
  if (DO_UPLOAD) await upload();
})().catch((e) => { console.error('异常：', e); process.exit(1); });
