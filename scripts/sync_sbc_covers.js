// SBC set 封面图上云管线（决策 B：接 fut.gg 图到云存储，用户 2026-09-18 拍板「完整」方案）。
// 仅处理 set 封面图（challenge 图后续补，符合「只做 set 封面图」分期）。
//
// 机制与 download_rarity_images.js + upload_rarity_images.js 完全对齐：
//   ① 真实 Chromium 过 Cloudflare（game-assets 被 CF 挡，Node 直连 403）；
//   ② 借浏览器上下文把 set.imagePath 对应的 fut.gg CDN 图下载到本地；
//   ③ 用 @cloudbase/node-sdk 上传到云存储 fc{ver}/images/sbc_<id>.webp；
//   ④ 产出映射 sbc_faces.json（imagePath -> 文件名），并同步生成小程序 data/sbcFaces.js。
//
// 命名：确定性命名 sbc_<set.eaId>.webp（从 imagePath 文件名提取数字 id，与球员卡 _card.webp 同原则），
//       小程序端 format.cloudFile('fc{ver}/images/sbc_<id>.webp') 可直接拼出 fileID，无需查表。
//
// 用法：
//   node scripts/sync_sbc_covers.js --ver 27
//   node scripts/sync_sbc_covers.js --ver 27 --no-upload   # 只下载不传云（调试用）
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const dl = require('./imgdl');
const { resolve } = require('./tcb_env');

function argVer() {
  const a = process.argv.find(x => x.startsWith('--ver='));
  if (a) return Number(a.slice(6));
  const i = process.argv.indexOf('--ver');
  return i >= 0 ? Number(process.argv[i + 1]) : 27;
}
function hasFlag(name) { return process.argv.indexOf(name) >= 0; }

const VER = argVer() || 27;
const NO_UPLOAD = hasFlag('--no-upload');
const ROOT = path.resolve(__dirname, '..');
const SBC_JSON = path.join(ROOT, 'cloud-data', `fc${VER}`, 'sbcs.json');
const COVER_DIR = path.join(ROOT, 'sbc_covers_out');
const FACES_JSON = path.join(ROOT, 'cloud-data', `fc${VER}`, 'sbc_faces.json');
// 小程序静态映射文件（跨目录生成，便于端上直接 require；与 data/rarityFaces.js 同定位）
const MINI_FACES = path.resolve(ROOT, '..', 'eafc-miniapp', 'data', 'sbcFaces.js');

const CDN = 'https://game-assets.fut.gg/';
// 2026-09-19：改用原始图路径。此前拼 cdn-cgi/image/...background=151a23 转换路由，当天起该路由
// 对本站返回 400（实锤：同会话 raw 200 / transform 400）→ 三通道全挂。透明底改由端上深色卡面
// 背景色兜住（.sb-cover/.hd-cover 均有深色 background，视觉一致），不再依赖 CDN 合成底色。
const TRANSFORM = '';
const UA = process.env.CF_UA || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36';

// 从 imagePath（如 2026/sbcs/1434.png 或 2027/sbcs/1234.png）提取 set 数字 id
function setIdOf(imagePath) {
  const base = String(imagePath || '').split('/').pop();
  const m = /(\d+)\.png$/i.exec(base);
  return m ? m[1] : '';
}

(async () => {
  if (!fs.existsSync(SBC_JSON)) {
    console.error('找不到', SBC_JSON, '（先跑 scrape_sbc_evolutions.js 生成 sbcs.json）');
    process.exit(1);
  }
  const sbc = JSON.parse(fs.readFileSync(SBC_JSON, 'utf8'));
  const sets = Array.isArray(sbc.sets) ? sbc.sets : [];

  // 仅 set 封面（challenge 图后续）：去重 imagePath -> fileName
  const seen = {};
  const tasks = [];
  sets.forEach(s => {
    const ip = s && s.imagePath;
    if (!ip) return;
    const id = setIdOf(ip);
    if (!id || seen[id]) return;
    seen[id] = 1;
    tasks.push({ id, imagePath: String(ip), fileName: 'sbc_' + id + '.webp', srcUrl: CDN + TRANSFORM + String(ip).replace(/^\/+/, '') });
  });
  console.log(`SBC set 封面去重后 ${tasks.length} 张（仅 set，不含 challenge）`);
  if (!tasks.length) { console.log('无 set 封面可处理，退出'); process.exit(0); }

  // ---- 下载：真实 Chromium 过 Cloudflare ----
  fs.mkdirSync(COVER_DIR, { recursive: true });
  // 全部封面已在本地（如外部抓好放进 COVER_DIR）→ 跳过浏览器探测，直接走上传 + 映射
  const allLocal = tasks.every(t => {
    const f = path.join(COVER_DIR, t.fileName);
    return fs.existsSync(f) && fs.statSync(f).size > 0;
  });
  if (allLocal) {
    console.log(`全部 ${tasks.length} 张封面已在本地，跳过下载，直接上传`);
  } else {
  // 浏览器选择：本机用 Edge（channel: msedge，过 CF 更稳）；CI 只有 Playwright Chromium → 自动回退。
  // SBC_COVERS_HEADED=1：本地有头模式跑（headless 过不了 CF 时的手动兜底；CI 不设此变量不受影响）
  const HEADLESS = !(process.env.SBC_COVERS_HEADED === '1');
  async function launchBrowser() {
    try {
      return await chromium.launch({
        channel: 'msedge',
        headless: HEADLESS,
        args: ['--disable-blink-features=AutomationControlled', '--no-sandbox', '--disable-dev-shm-usage']
      });
    } catch (e) {
      console.log('msedge 不可用（CI 环境？），回退 Playwright Chromium:', (e && e.message) || e);
      return chromium.launch({
        headless: HEADLESS,
        args: ['--disable-blink-features=AutomationControlled', '--no-sandbox', '--disable-dev-shm-usage']
      });
    }
  }
  console.log('启动浏览器（msedge → chromium 回退）...');
  const browser = await launchBrowser();
  const ctx = await browser.newContext({
    userAgent: UA, locale: 'en-US', viewport: { width: 1280, height: 800 }, timezoneId: 'America/New_York'
  });
  const page = await ctx.newPage();
  page.on('console', m => { const t = m.text(); if (t.indexOf('[img]') === 0 || t.indexOf('[browser]') === 0) console.log(t); });

  console.log('打开 fut.gg 过 Cloudflare ...');
  await page.goto('https://www.fut.gg/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  let passed = false;
  for (let i = 0; i < 30; i++) {
    let status = -1;
    try { status = await page.evaluate(async (u) => { try { const r = await fetch(u, { headers: { Accept: 'application/json' } }); return r.status; } catch (e) { return -1; } }, `https://www.fut.gg/api/fut/sbc/${VER}?page=1`); }
    catch (e) { status = -2; }
    if (status === 200) { passed = true; console.log(`Cloudflare 已通过（第 ${i + 1} 次尝试）`); break; }
    console.log(`等待 Cloudflare 挑战解除... status=${status} (${i + 1}/30)`);
    await page.waitForTimeout(3000);
  }
  if (!passed) { await browser.close(); console.error('未能通过 Cloudflare，退出'); process.exit(1); }

  // 预热 game-assets 子域：cf_clearance 按域隔离，只过 www.fut.gg 不代表过了 game-assets。
  // 直接导航到 CDN 让 Managed Challenge 自解并种下该域的 cookie，否则三通道全部 403/挂起（2026-09-19 实锤）。
  console.log('预热 game-assets.fut.gg（过该子域的 Cloudflare）...');
  for (let i = 0; i < 10; i++) {
    let ok = false;
    try {
      await page.goto(CDN + TRANSFORM + String(tasks[0].imagePath).replace(/^\/+/, ''), { waitUntil: 'domcontentloaded', timeout: 30000 });
      // 挑战页不是图片：导航后若拿到的是图片响应，title 不会是 Just a moment
      const title = await page.title().catch(() => '');
      ok = /just a moment|attention required/i.test(title) === false;
      if (!ok) await page.waitForTimeout(4000);   // 停在挑战页等自解，再刷新
    } catch (e) { await page.waitForTimeout(3000); }
    if (ok) { console.log(`game-assets 已通过（第 ${i + 1} 次尝试）`); break; }
    if (i === 9) { await browser.close(); console.error('game-assets 子域未通过 Cloudflare，退出'); process.exit(1); }
  }
  // 导航走了页面，回到 fut.gg 上下文（C 通道的 <img> 与 B 通道的 fetch 都从页面发起）
  await page.goto('https://www.fut.gg/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});

  const sink = new dl.ImgSink(page);
  const probeFile = path.join(COVER_DIR, '_probe_sbc.bin');
  let channel = await dl.probe(ctx, page, sink, tasks[0].srcUrl, probeFile, UA);
  try { fs.unlinkSync(probeFile); } catch (e) {}
  if (!channel) { await browser.close(); console.error('SBC 封面下载通道不可用，跳过（不影响后续）'); process.exit(1); }
  console.log('选定下载通道：', channel);
  const order = channel === 'A' ? ['A', 'B', 'C'] : channel === 'B' ? ['B', 'C', 'A'] : ['C', 'B', 'A'];
  const pick = (ch, url, file, tmo) =>
    ch === 'A' ? dl.methodA(ctx, url, file, UA)
      : ch === 'B' ? dl.methodB(page, url, file)
        : sink.fetch(url, file, tmo);

  let dlDone = 0, dlFail = 0;
  for (const t of tasks) {
    const file = path.join(COVER_DIR, t.fileName);
    // 已下载且非空则跳过（幂等，便于断点续跑）
    if (fs.existsSync(file) && fs.statSync(file).size > 0) { dlDone++; continue; }
    let ok = false, lastErr = null;
    for (const ch of order) {
      try { await pick(ch, t.srcUrl, file, 60000); ok = true; break; }
      catch (e) { lastErr = e; }
    }
    if (ok) { dlDone++; console.log('  OK', t.fileName); }
    else { dlFail++; console.error('  FAIL', t.imagePath, (lastErr && lastErr.message) || lastErr); }
  }
  await browser.close();
  console.log(`SBC 封面下载完成: 成功 ${dlDone} | 失败 ${dlFail}`);
  } // end: 非全本地时的下载分支

  // ---- 上传到云存储 ----
  if (NO_UPLOAD) {
    console.log('--no-upload：跳过云上传，仅本地已下载');
  } else {
    const cred = resolve();
    if (cred.missing.length) {
      console.error('缺少云开发凭证，无法上传：\n' + cred.hint);
      process.exit(1);
    }
    const cloudbase = require('@cloudbase/node-sdk');
    const app = cloudbase.init({ env: cred.ENV_ID, secretId: cred.SECRET_ID, secretKey: cred.SECRET_KEY, timeout: 120000 });
    let upDone = 0, upFail = 0;
    for (const t of tasks) {
      const local = path.join(COVER_DIR, t.fileName);
      if (!fs.existsSync(local) || fs.statSync(local).size === 0) { upFail++; console.error('  SKIP(无本地文件)', t.fileName); continue; }
      const cloudPath = `fc${VER}/images/${t.fileName}`;
      let ok = false, lastErr = null;
      for (let k = 1; k <= 3 && !ok; k++) {
        try { await app.uploadFile({ cloudPath, fileContent: fs.readFileSync(local) }); ok = true; }
        catch (e) { lastErr = e; await new Promise(r => setTimeout(r, 1000 * k)); }
      }
      if (ok) { upDone++; console.log('  UP', cloudPath); }
      else { upFail++; console.error('  UP-FAIL', t.fileName, (lastErr && lastErr.message) || lastErr); }
    }
    console.log(`SBC 封面上传完成: 成功 ${upDone} | 失败 ${upFail}`);
  }

  // ---- 映射：imagePath -> 文件名 ----
  const map = {};
  tasks.forEach(t => { map[t.imagePath] = t.fileName; });
  fs.mkdirSync(path.dirname(FACES_JSON), { recursive: true });
  fs.writeFileSync(FACES_JSON, JSON.stringify(map, null, 2));
  console.log('已写出映射', FACES_JSON, '（', Object.keys(map).length, '条 ）');

  // 同步生成小程序静态映射 data/sbcFaces.js（imagePath -> 云存储文件名）。
  // ⚠️ CI 环境没有同级 eafc-miniapp（仓库隔离不变式），跳过写入避免在 runner 工作区生成垃圾目录；
  //    端上 2026-09-19 起已改为确定性命名直拼 fileID，不再依赖该映射，缺它不影响真机显示。
  if (fs.existsSync(path.resolve(ROOT, '..', 'eafc-miniapp'))) {
    const lines = ['// 自动生成（fetch-fc27/scripts/sync_sbc_covers.js）：SBC set 封面图映射。',
      '// imagePath(相对) -> 云存储文件名（fc27/images/ 下，由管线下载转存）。',
      '// 仅 set 封面；challenge 图后续补（见 2026-09-18 决策）。',
      '// 端上 utils/sbcs.js#imgUrl 主路径为确定性命名 sbc_<id>.webp 直拼 fileID，此处仅作兜底。',
      'module.exports = {'];
    Object.keys(map).forEach(k => { lines.push('  ' + JSON.stringify(k) + ': ' + JSON.stringify(map[k]) + ','); });
    lines.push('};');
    fs.writeFileSync(MINI_FACES, lines.join('\n') + '\n');
    console.log('已生成小程序映射', MINI_FACES);
  } else {
    console.log('未检测到同级 eafc-miniapp（CI），跳过小程序映射生成');
  }
})().catch(e => { console.error('SBC 封面上云失败:', (e && e.message) || e); process.exit(1); });
