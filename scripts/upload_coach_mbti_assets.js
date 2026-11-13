// 教练MBTI 插画/封面 → 云存储（一次性或按需重跑，2026-11-13）。
//
// 与球员图片同一通道：cloud:// fileID，<image> 原生直连、零云函数（见 eafc-miniapp/utils/format.js）。
// 同名覆盖上传（确定性命名），端上 coaches.json / meta.json 按固定 fileID 拼，无需查表。
// ⚠️ 前缀 fc27/coach_mbti/ 与 gen_coach_mbti_assets.py 的 CLOUD_DIR 必须逐字一致。
//
// 规则 116：SDK timeout 180s + 3 次重试 + race；规则 137：回读走 CDN＋随机 query 破边缘缓存。
// 用法：node scripts/upload_coach_mbti_assets.js [--dry]
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const cloudbase = require('@cloudbase/node-sdk');

const ROOT = path.resolve(__dirname, '..');
const ASSETS = path.join(ROOT, '..', '产出', 'coach-mbti-assets');
const CLOUD_DIR = 'fc27/coach_mbti/';
const CDN_HOST = '636c-cloud1-d5gq6q3np8708aeef-1475854307.tcb.qcloud.la';
const DRY = process.argv.indexOf('--dry') >= 0;
const RACE_MS = 200000;
const ATTEMPTS = 3;

function loadEnv() {
  const out = {};
  const f = path.join(ROOT, '.env.local');
  if (fs.existsSync(f)) {
    fs.readFileSync(f, 'utf8').split(/\r?\n/).forEach(function (ln) {
      const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/.exec(ln);
      if (m) out[m[1]] = m[2].trim();
    });
  }
  return out;
}
function initCloud() {
  const env = loadEnv();
  const envId = process.env.TCB_ENV_ID || env.TCB_ENV_ID;
  const sid = process.env.TCB_SECRET_ID || env.TCB_SECRET_ID;
  const skey = process.env.TCB_SECRET_KEY || env.TCB_SECRET_KEY;
  if (!envId || !sid || !skey) throw new Error('缺 TCB_ENV_ID / TCB_SECRET_ID / TCB_SECRET_KEY（.env.local）');
  return cloudbase.init({ env: envId, secretId: sid, secretKey: skey, timeout: 180000 });
}

// CDN 匿名 GET 校验：200 且字节数一致 ⇒ 公有读生效 + 内容完整（端上 <image> 能直连）
function cdnReadback(cloudPath, expectBytes) {
  return new Promise(function (resolve, reject) {
    const url = '/' + cloudPath + '?r=rb-' + Date.now() + '-' + Math.floor(Math.random() * 1e6);
    const req = https.get({
      host: CDN_HOST, path: url, headers: { 'User-Agent': 'OAO-coach-mbti-assets' }, timeout: 20000
    }, function (res) {
      if (res.statusCode !== 200) { res.resume(); reject(new Error('CDN HTTP ' + res.statusCode)); return; }
      const chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () {
        const b = Buffer.concat(chunks);
        if (b.length !== expectBytes) { reject(new Error('CDN 字节数不符 ' + b.length + '≠' + expectBytes)); return; }
        if (b.slice(0, 8).toString('hex') !== '89504e470d0a1a0a') { reject(new Error('CDN 非 PNG')); return; }
        resolve();
      });
    });
    req.on('timeout', function () { req.destroy(new Error('CDN 回读超时 20s')); });
    req.on('error', reject);
  });
}

async function uploadOne(app, file) {
  const buf = fs.readFileSync(path.join(ASSETS, file));
  const cloudPath = CLOUD_DIR + file;
  let lastErr;
  for (let i = 0; i < ATTEMPTS; i++) {
    try {
      const up = await Promise.race([
        app.uploadFile({ cloudPath: cloudPath, fileContent: buf }),
        new Promise(function (_, rej) {
          setTimeout(function () { rej(new Error('uploadFile 超时 ' + RACE_MS + 'ms')); }, RACE_MS);
        })
      ]);
      if (!up || !up.fileID) throw new Error('上传未拿到 fileID');
      await cdnReadback(cloudPath, buf.length);   // 公有读 + 内容校验
      return { file: file, bytes: buf.length, fileID: up.fileID };
    } catch (e) {
      lastErr = e;
      console.error('  ⚠️ ' + file + ' 尝试 ' + (i + 1) + '/' + ATTEMPTS + ' 失败: ' + e.message);
    }
  }
  throw lastErr || new Error(file + ' 上传失败');
}

async function run() {
  if (!fs.existsSync(ASSETS)) { console.error('找不到素材目录: ' + ASSETS + '（先跑 gen_coach_mbti_assets.py）'); process.exit(2); }
  const files = fs.readdirSync(ASSETS).filter(function (f) { return f.toLowerCase().endsWith('.png'); }).sort();
  if (files.length !== 20) { console.error('素材数量异常 ' + files.length + ' ≠ 20（19 教练 + 1 封面），拒绝上传'); process.exit(3); }
  console.log('[coach-mbti assets] ' + files.length + ' 张 → ' + CLOUD_DIR + (DRY ? '（--dry 只校验不写云）' : ''));
  if (DRY) { files.forEach(function (f) { console.log('  ' + f + '  ' + (fs.statSync(path.join(ASSETS, f)).size / 1024).toFixed(1) + ' KB'); }); return; }

  const app = initCloud();
  let ok = 0;
  for (const f of files) {
    const r = await uploadOne(app, f);
    ok++;
    console.log('  ✅ [' + ok + '/' + files.length + '] ' + r.file + '  ' + (r.bytes / 1024).toFixed(1) + ' KB  → ' + r.fileID.slice(0, 72) + '…');
  }
  console.log('✅ 20 张全部上传并通过 CDN 公有读校验。端上 cloud:// 直连生效（零云函数）。');
}

run()
  .then(function () { process.exit(0); })
  .catch(function (e) { console.error('❌ 图片上传失败: ' + (e && e.message)); process.exit(1); });
