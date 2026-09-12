// 删除云存储里所有已上传的「简约卡」(_simple.webp)，回收 1/3 的存储与流量。
//
// 触发场景：当某次 CI 带着三图（portrait+card+simple）跑完、已把 simple 卡传上云存储后，
// 把 workflow 改成 FC_IMG_TYPES=portrait,card 再重跑，新跑只传两种图，
// 但**旧 run 传上去的 _simple.webp 不会自动消失**（upload_images.js 只增不删）。
// 本脚本按清单把这批孤儿文件清掉。
//
// fileID 构成：cloud://<envId>.<bucket后缀>/<cloudPath>。bucket 后缀没法凭空拼，
// 所以先用一个 1 字节探针上传、读回它的 fileID、截出 `cloud://.../` 前缀，
// 再据此拼出每个 eaId 的 simple 文件 fileID。探针最后会删掉。
//
// 用法：node scripts/delete_simple_images.js
const fs = require('fs');
const path = require('path');
const https = require('https');
const cloudbase = require('@cloudbase/node-sdk');
const { resolve } = require('./tcb_env');

const VER = 27;
const PREFIX_PATH = `fc${VER}/images/`;
const REPO_RAW = `https://raw.githubusercontent.com/rickma11/fetch-fc27/main/cloud-data/fc${VER}/images.json`;

const cred = resolve();
if (cred.missing.length) { console.error(cred.hint); process.exit(1); }

const app = cloudbase.init({
  env: cred.ENV_ID, secretId: cred.SECRET_ID, secretKey: cred.SECRET_KEY, timeout: 60000
});

function fetchText(url) {
  return new Promise((res, rej) => {
    https.get(url, r => {
      if (r.statusCode !== 200) return rej(new Error('HTTP ' + r.statusCode + ' ' + url));
      let d = ''; r.on('data', c => d += c); r.on('end', () => res(d));
    }).on('error', rej);
  });
}

async function loadManifest() {
  const local = path.resolve(__dirname, '..', 'cloud-data', `fc${VER}`, 'images.json');
  if (fs.existsSync(local)) {
    try { return JSON.parse(fs.readFileSync(local, 'utf8')); } catch (e) {}
  }
  console.log('本地无清单，尝试公开 raw 链接:', REPO_RAW);
  const txt = await fetchText(REPO_RAW);
  return JSON.parse(txt);
}

(async () => {
  console.log('环境:', cred.ENV_ID);
  const manifest = await loadManifest();
  const eaIds = Object.keys(manifest).map(Number).filter(n => !isNaN(n));
  console.log('清单人数:', eaIds.length);

  // 1) 探针取 fileID 前缀
  const probePath = PREFIX_PATH + '_del_probe.txt';
  const buf = Buffer.from('x');
  const up = await app.uploadFile({ cloudPath: probePath, fileContent: buf });
  const m = /^(cloud:\/\/[^\/]+)\//.exec(up.fileID || '');
  if (!m) throw new Error('无法从 fileID 解析前缀: ' + up.fileID);
  const prefix = m[1];
  console.log('fileID 前缀:', prefix);
  await app.deleteFile({ fileList: [up.fileID] });

  // 2) 批量删 _simple.webp
  const targets = eaIds.map(id => `${prefix}/${PREFIX_PATH}${id}_simple.webp`);
  let done = 0, skipped = 0, failed = 0;
  const BATCH = 50;
  for (let i = 0; i < targets.length; i += BATCH) {
    const slice = targets.slice(i, i + BATCH);
    try {
      const r = await app.deleteFile({ fileList: slice });
      (r.fileList || []).forEach(f => {
        if (f.code === 0 || f.code === 'SUCCESS') done++;
        else if (String(f.code).includes('404') || f.code === -13015) skipped++; // 不存在
        else failed++;
      });
    } catch (e) {
      failed += slice.length;
      if (i === 0) console.error('首批删除失败:', e.message);
    }
    if (i % 1000 === 0) console.log(`进度 ${Math.min(i + BATCH, targets.length)}/${targets.length} | 已删 ${done} | 跳过 ${skipped} | 失败 ${failed}`);
  }
  console.log(`\n✔ 完成：删除 ${done} 个 simple 卡 | 本就不存在(跳过) ${skipped} | 失败 ${failed}`);
  if (failed) process.exit(1);
})().catch(e => { console.error('\n✘ 失败:', e.message); process.exit(1); });
