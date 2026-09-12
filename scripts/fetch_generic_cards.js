// 通用卡面：给「fut.gg 没有半身像」的球员（FC27 约 320 名，3.2%）准备一张干净底卡。
//
// 为什么需要：fut.gg 上这些球员 imagePath（半身像）为空，他们的 _card.webp 照片区本来就是
// 空白的，直接展示会出现空白/破图占位。早期做法是逐人合成「本人卡面 + 灰剪影」，已被废弃。
// 现在的做法：小程序端识别到「没有半身像」就整张换成这里产出的通用卡面（按稀有度选金/银/铜
// 底色，纯净、无任何姓名/数据）。fut.gg 后续补上半身像后会自动走回真实卡面，无需额外处理。
//
// 素材来源：fut.gg 自己的「稀有度底图」rarities-level-*-large，直接走它的 Cloudflare Images
// 变换拿 500px webp。注意 game-assets.fut.gg 有 Cloudflare 保护，Node 直连会 403，
// 必须在浏览器会话里下载 —— 所以本脚本设计成在 GitHub Actions 里跑（本地网络环境过不了校验）。
//
// 落云存储：common/generic/g{1,2,3}.webp（与版本无关，FC26/FC27 共用一套）
// 清单：cloud-data/generic/generic_cards.json 记每个等级底图的内容签名，未变化则跳过抓取与上传。
//
// 用法：node scripts/fetch_generic_cards.js [--ver 27] [--force] [--dry]
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { chromium } = require('playwright');
const dl = require('./imgdl');

const ROOT = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
function argVal(name, dflt) {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt;
}
const VER = String(argVal('ver', '27'));
const FORCE = argv.includes('--force');
const DRY = argv.includes('--dry');

const OUT_DIR = path.join(ROOT, 'assets', 'generic_cards');
const MANIFEST = path.join(ROOT, 'cloud-data', 'generic', 'generic_cards.json');
const CLOUD_DIR = 'common/generic';                 // 云存储目录（无版本前缀）
const LEVELS = [1, 2, 3];                           // 1=铜 2=银 3=金
const UA = process.env.CF_UA || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36';

// ---- 1) 每个稀有度等级取一张代表性底图（该等级下出现次数最多的那个键）----
function rarityKeysOf(ver) {
  const p = JSON.parse(fs.readFileSync(path.join(ROOT, 'cloud-data', `fc${ver}`, 'players.json'), 'utf8'));
  const counter = {};
  p.forEach(x => {
    const rel = x.rarity && x.rarity.imagePath;
    const m = rel ? String(rel).match(/rarities-level-(\d)-large/) : null;
    if (!m) return;
    const lvl = Number(m[1]);
    counter[lvl] = counter[lvl] || {};
    counter[lvl][rel] = (counter[lvl][rel] || 0) + 1;
  });
  const out = {};
  LEVELS.forEach(l => {
    const c = counter[l];
    if (!c) return;
    out[l] = Object.keys(c).sort((a, b) => c[b] - c[a])[0];
  });
  return out;
}
function sigOf(rel) {
  return crypto.createHash('sha1').update(rel).digest('hex').slice(0, 12);
}
function readManifest() {
  try { return JSON.parse(fs.readFileSync(MANIFEST, 'utf8')); } catch (e) { return {}; }
}

(async () => {
  const keys = rarityKeysOf(VER);
  const want = {};
  LEVELS.forEach(l => { if (keys[l]) want[l] = sigOf(keys[l]); });
  if (!Object.keys(want).length) { console.error('未从 players.json 找到任何稀有度底图键'); process.exit(1); }
  console.log('稀有度底图：' + LEVELS.filter(l => keys[l]).map(l => `l${l}=${keys[l].split('/')[2]}`).join('  '));

  const old = readManifest();
  const stale = !FORCE && LEVELS.filter(l => keys[l] && old[String(l)] === want[l] && fs.existsSync(path.join(OUT_DIR, `g${l}.webp`)));
  const todo = LEVELS.filter(l => keys[l] && stale.indexOf(l) < 0);
  if (!todo.length) {
    console.log('通用卡面全部为最新（签名一致），跳过抓取与上传。加 --force 可强制重抓。');
    return;
  }
  console.log('待更新等级：' + todo.map(l => 'l' + l).join(', '));

  fs.mkdirSync(OUT_DIR, { recursive: true });

  // ---- 2) 浏览器里过 Cloudflare 并下载（走 fut.gg 的 cdn-cgi 变换直接拿 500px webp）----
  const launchArgs = ['--disable-blink-features=AutomationControlled', '--no-sandbox', '--disable-dev-shm-usage'];
  const browser = await chromium.launch({ headless: true, args: launchArgs });
  const ctx = await browser.newContext({
    userAgent: UA, locale: 'en-US',
    viewport: { width: 1280, height: 800 }, timezoneId: 'America/New_York'
  });
  const page = await ctx.newPage();
  console.log('打开 fut.gg 过 Cloudflare ...');
  await page.goto('https://www.fut.gg/', { waitUntil: 'domcontentloaded', timeout: 60000 });

  let passed = false;
  for (let i = 0; i < 30; i++) {
    try {
      const r = await page.evaluate(async () => {
        const res = await fetch('/api/fc-27/players/?page=1', { credentials: 'include' });
        return res.status;
      });
      if (r === 200) { passed = true; break; }
    } catch (e) { /* 继续等 */ }
    await page.waitForTimeout(2000);
  }
  console.log(passed ? 'Cloudflare 已放行' : '警告：Cloudflare 探测未确认放行，仍尝试取图');
  await dl.disableCache(ctx, page);

  const TRANSFORM = 'cdn-cgi/image/quality=82,format=webp,width=500/';
  const done = {};
  for (const l of todo) {
    const rel = keys[l];
    const file = path.join(OUT_DIR, `g${l}.webp`);
    const urls = ['https://game-assets.fut.gg/' + TRANSFORM + rel, 'https://game-assets.fut.gg/' + rel];
    let ok = false;
    for (const url of urls) {
      for (const fn of [() => dl.methodA(ctx, url, file, UA), () => dl.methodB(page, url, file)]) {
        try {
          const n = await fn();
          console.log(`  l${l} 下载成功 ${n} 字节 ← ${url.includes('/cdn-cgi/') ? '缩放 webp' : '原图'}`);
          ok = true; break;
        } catch (e) { /* 换通道/换原图 */ }
      }
      if (ok) break;
    }
    if (!ok) { console.log(`  l${l} 下载失败：${rel}`); continue; }
    done[l] = want[l];
  }
  await browser.close();

  if (!Object.keys(done).length) { console.error('没有任何底图下载成功'); process.exit(1); }

  // ---- 3) 上传云存储 ----
  if (DRY) {
    console.log('--dry：跳过上传。本地文件 → ' + Object.keys(done).map(l => `assets/generic_cards/g${l}.webp`).join(', '));
    return;
  }
  const { resolve } = require('./tcb_env');
  const cred = resolve();
  if (cred.missing && cred.missing.length) { console.error(cred.hint); process.exit(1); }
  const cloudbase = require('@cloudbase/node-sdk');
  const app = cloudbase.init({ env: cred.ENV_ID, secretId: cred.SECRET_ID, secretKey: cred.SECRET_KEY, timeout: 120000 });

  const manifest = Object.assign({}, old);
  for (const l of Object.keys(done)) {
    const buf = fs.readFileSync(path.join(OUT_DIR, `g${l}.webp`));
    const r = await app.uploadFile({ cloudPath: `${CLOUD_DIR}/g${l}.webp`, fileContent: buf });
    console.log(`  上传 l${l} → ${r.fileID}（${(buf.length / 1024).toFixed(0)} KB）`);
    manifest[String(l)] = done[l];
  }
  manifest.updatedAt = new Date().toISOString().slice(0, 19).replace('T', ' ');
  fs.mkdirSync(path.dirname(MANIFEST), { recursive: true });
  fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 1) + '\n');
  console.log('清单已更新 → ' + path.relative(ROOT, MANIFEST));
})().catch(e => { console.error(e); process.exit(1); });
