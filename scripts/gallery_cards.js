#!/usr/bin/env node
// FUT Gallery 卡面转传器（2026-10-23）：把解法/promo 卡的卡面从 game-assets.fut.gg 搬到我们云存储。
//
// 背景：小程序端不配置任何外域图片域名（app.json 无 downloadFile domain），卡面必须走云存储 fileID
//   （端上 utils/imgCache#resolve 下载本地缓存后 <image> 渲染）。gallery 解法里约一半是当季 promo 卡
//   （Future Stars / Destined for Glory 等），我们球员库没有这些 eaId 的卡面，需按 eaId 搬运。
//
// 命名：fc27/images/{eaId}_gcard.webp（gcard=gallery card，与库内 {eaId}_card.webp/_np.webp 区分，
//   语义不冲突；库内卡 cardSrc='lib' 端上走既有 displayImg 链路，不搬）。
//
// 输入（gallery_sync.js 产物）：
//   - cloud-data/fc27/gallery/needed_gcards.json   {eaId: cardUrl}（解法+costTiers 去重后的需求清单）
//   - cloud-data/fc27/gallery/sent_gcards.json     {eaId: {fileID, at}}（已传清单，增量续跑）
//
// 用法：
//   node scripts/gallery_cards.js 27             下载缺的卡面并上传（本机跑记得带代理环境变量）
//   node scripts/gallery_cards.js 27 --limit=100 只传前 N 张（分批控速）
//   node scripts/gallery_cards.js 27 --dry       只列缺哪些，不动网络
//
// 上传沿用 gen_static_lists.js 同款 uploadWithRetry 逻辑（SDK 180s 超时 + 3 次重试 + 回读校验，规则 116/100）。
'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const cloudbase = require('@cloudbase/node-sdk');

const ROOT = path.resolve(__dirname, '..');
const VER = Number((process.argv[2] && !process.argv[2].startsWith('-')) ? process.argv[2] : (process.env.FC_VER || 27));
const DRY = process.argv.indexOf('--dry') >= 0;
const LIMIT = Number(((process.argv.find(function (a) { return a.indexOf('--limit=') === 0; }) || '').split('=')[1]) || 0) || 0;
const CONC = 4;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const GAL_DIR = path.join(ROOT, 'cloud-data', 'fc' + VER, 'gallery');
const NEED_FILE = path.join(GAL_DIR, 'needed_gcards.json');
const SENT_FILE = path.join(GAL_DIR, 'sent_gcards.json');
const IMG_PREFIX = 'fc' + VER + '/images/';   // 与库内卡面同目录，_gcard.webp 后缀区分

function log() { console.log.apply(console, arguments); }
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

function loadEnv() {
  const f = path.join(ROOT, '.env.local');
  const out = {};
  if (fs.existsSync(f)) {
    fs.readFileSync(f, 'utf8').split(/\r?\n/).forEach(function (ln) {
      const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/.exec(ln);
      if (m) out[m[1]] = m[2].trim();
    });
  }
  return out;
}

// curl 下载二进制（走 HTTP(S)_PROXY 环境变量；CI 无代理直连）
function curlBinary(url, tries) {
  tries = tries || 3;
  return new Promise(function (resolve, reject) {
    execFile('curl', ['-s', '--compressed', '--max-time', '60', '-A', UA, url], { maxBuffer: 32 * 1024 * 1024, encoding: 'buffer' }, function (err, stdout) {
      if (err) { reject(new Error('curl 退出 ' + err.code)); return; }
      if (!stdout || stdout.length < 200) { reject(new Error('下载内容过小 ' + (stdout ? stdout.length : 0) + 'B（可能 403/错误页）')); return; }
      resolve(stdout);
    });
  }).catch(async function (e) { throw e; });
}

async function fetchWithRetry(url, tries) {
  tries = tries || 3;
  let lastErr = null;
  for (let i = 0; i < tries; i++) {
    try { return await curlBinary(url); }
    catch (e) { lastErr = e; if (i < tries - 1) await sleep(1000 * Math.pow(2, i)); }
  }
  throw new Error('下载失败(' + tries + ') ' + url + ' → ' + (lastErr && lastErr.message));
}

function initCloud() {
  const env = loadEnv();
  const envId = process.env.TCB_ENV_ID || env.TCB_ENV_ID;
  const sid = process.env.TCB_SECRET_ID || env.TCB_SECRET_ID;
  const skey = process.env.TCB_SECRET_KEY || env.TCB_SECRET_KEY;
  if (!envId || !sid || !skey) throw new Error('缺 TCB_ENV_ID / TCB_SECRET_ID / TCB_SECRET_KEY');
  return cloudbase.init({ env: envId, secretId: sid, secretKey: skey, timeout: 180000 });
}

// 与 gen_static_lists.js#uploadWithRetry 同构（该函数未导出，此处保持同款参数）
async function uploadWithRetry(app, cloudPath, buf) {
  const ATTEMPTS = 3;
  const RACE_MS = 200000;
  let lastErr;
  for (let i = 0; i < ATTEMPTS; i++) {
    try {
      const up = await Promise.race([
        app.uploadFile({ cloudPath: cloudPath, fileContent: buf }),
        new Promise(function (_, rej) { setTimeout(function () { rej(new Error('uploadFile 超时 ' + RACE_MS + 'ms')); }, RACE_MS); })
      ]);
      const fileID = (up && up.fileID) || '';
      if (!fileID) throw new Error('上传未拿到 fileID');
      const rb = await app.downloadFile({ fileID: fileID });
      const rbBuf = rb && rb.fileContent;
      if (!rbBuf || !rbBuf.length) throw new Error('回读空');
      return fileID;
    } catch (e) {
      lastErr = e;
      log('  ⚠️ 上传尝试 ' + (i + 1) + '/' + ATTEMPTS + ' 失败: ' + e.message);
    }
  }
  throw lastErr || new Error('uploadWithRetry 全部失败');
}

async function poolMap(items, conc, fn) {
  const out = new Array(items.length);
  const errs = [];
  let idx = 0;
  async function worker() {
    while (true) {
      const i = idx++;
      if (i >= items.length) return;
      try { out[i] = await fn(items[i], i); }
      catch (e) { errs.push({ item: items[i], err: e }); out[i] = null; }
    }
  }
  const ws = [];
  for (let k = 0; k < Math.min(conc, items.length); k++) ws.push(worker());
  await Promise.all(ws);
  return { out: out, errs: errs };
}

async function run() {
  log('=== FUT Gallery 卡面转传 FC' + VER + '  ' + new Date().toLocaleString('zh-CN') + ' ===');
  if (!fs.existsSync(NEED_FILE)) { console.error('缺 needed_gcards.json，先跑 gallery_sync.js'); process.exit(1); }
  const need = JSON.parse(fs.readFileSync(NEED_FILE, 'utf8'));
  let sent = {};
  try { sent = JSON.parse(fs.readFileSync(SENT_FILE, 'utf8')) || {}; } catch (e) {}

  const todo = Object.keys(need).filter(function (k) { return !sent[k]; });
  const list = LIMIT ? todo.slice(0, LIMIT) : todo;
  log('需求 ' + Object.keys(need).length + ' 张 | 已传 ' + Object.keys(sent).length + ' 张 | 本次待传 ' + list.length + (LIMIT ? '（limit=' + LIMIT + '）' : ''));
  if (!list.length) { log('无待传卡面，退出'); return; }
  if (DRY) { log('--dry：待传 eaId = ' + list.slice(0, 50).join(', ') + (list.length > 50 ? ' …' : '')); return; }

  const app = initCloud();
  let done = 0;
  const res = await poolMap(list, CONC, async function (eaId) {
    const buf = await fetchWithRetry(need[eaId], 3);
    const cloudPath = IMG_PREFIX + eaId + '_gcard.webp';
    const fileID = await uploadWithRetry(app, cloudPath, buf);
    done++;
    if (done % 20 === 0 || done === list.length) log('  进度 ' + done + '/' + list.length);
    return { eaId: eaId, fileID: fileID, bytes: buf.length };
  });

  // 回写已传清单（增量续跑的关键）
  let okCount = 0;
  res.out.forEach(function (r) {
    if (!r) return;
    sent[r.eaId] = { fileID: r.fileID, at: new Date().toISOString(), bytes: r.bytes };
    okCount++;
  });
  fs.writeFileSync(SENT_FILE, JSON.stringify(sent));
  log('\n✅ 本次成功 ' + okCount + ' / ' + list.length + '，累计已传 ' + Object.keys(sent).length + ' / ' + Object.keys(need).length);
  if (res.errs.length) {
    log('❌ 失败 ' + res.errs.length + ' 张：');
    res.errs.slice(0, 15).forEach(function (e) { log('   ' + e.item + ': ' + e.err.message); });
    log('（清单已回写，重跑即续传）');
    process.exit(1);
  }
}

if (require.main === module) {
  run().catch(function (e) { console.error('失败:', e); process.exit(1); });
}
