// 把 images_out/ 里的球员图片上传到云存储 fc27/images/，并维护增量清单。
//
// 为什么用云存储而不是 GitHub / 图床：
//   小程序 <image> 加载网络图走的是 wx.downloadFile 的「downloadFile 合法域名」白名单，
//   而微信硬性要求这些域名必须经过 ICP 备案 —— GitHub / Gitee / jsDelivr 的域名都做不到
//   （Gitee 另有反盗链与禁用图床条款）。云存储的 cloud:// fileID 不走域名校验，
//   微信客户端原生支持，因此是小程序放图片的唯一省事通道。
//
// 增量与断点续传：
//   文件名只由 eaId + 类型决定；URL 里的内容 hash 变了 → 签名变 → 重新下载并覆盖上传。
//   清单 cloud-data/fc27/images.json 记录「每个 eaId 已完整上传到哪个签名」。
//   清单**边传边写**（每 FLUSH_EVERY 张落一次盘），所以哪怕任务超时被杀，
//   已完成的部分也已记账，下次运行只补剩下的，不会从头再来。
//
// 用法：node scripts/upload_images.js --ver 27
const fs = require('fs');
const path = require('path');
const cloudbase = require('@cloudbase/node-sdk');
const { resolve } = require('./tcb_env');
const imgLib = require('./images');

const cred = resolve();
if (cred.missing.length) {
  console.error(cred.hint);
  process.exit(1);
}

function argVer() {
  const a = process.argv.find(x => x.startsWith('--ver='));
  if (a) return Number(a.slice(6));
  const i = process.argv.indexOf('--ver');
  return i >= 0 ? Number(process.argv[i + 1]) : 27;
}
const VER = argVer() || 27;
const ROOT = path.resolve(__dirname, '..');
const IMG_DIR = path.join(ROOT, 'images_out');
const TASK_FILE = path.join(IMG_DIR, '_tasks.json');
const CONC = Number(process.env.FC_IMG_UP_CONC || 10);
const FLUSH_EVERY = Number(process.env.FC_IMG_FLUSH || 200);
const MAX_TRY = 3;

const app = cloudbase.init({
  env: cred.ENV_ID,
  secretId: cred.SECRET_ID,
  secretKey: cred.SECRET_KEY,
  timeout: 120000
});

const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  if (!fs.existsSync(TASK_FILE)) {
    console.log('没有 images_out/_tasks.json（本次未下载图片），跳过');
    return;
  }
  const index = JSON.parse(fs.readFileSync(TASK_FILE, 'utf8'));
  const eaIds = Object.keys(index);
  const files = [];
  const owner = {};      // 文件名 -> eaId
  const remain = {};     // eaId -> 还没传成功的张数
  eaIds.forEach(id => {
    const names = Object.values(index[id].files);
    files.push.apply(files, names);
    remain[id] = names.length;
    names.forEach(n => { owner[n] = id; });
  });

  const bytesTotal = files.reduce((s, f) => {
    try { return s + fs.statSync(path.join(IMG_DIR, f)).size; } catch (e) { return s; }
  }, 0);
  console.log(`待上传 ${files.length} 个文件 / ${eaIds.length} 名球员 / ${Math.round(bytesTotal / 1048576)} MB`);
  if (!files.length) return;

  const manifest = imgLib.readManifest(VER);
  const doneEa = {};
  const doneFiles = new Set();
  let failed = 0, bytes = 0, sinceFlush = 0;

  // 边传边记账：清单只在「某球员所有图都成功」时才收录，避免记下残缺状态
  function flush() {
    const merged = Object.assign({}, manifest, doneEa);
    const written = imgLib.writeManifest(VER, merged);
    doneFiles.forEach(f => { try { fs.unlinkSync(path.join(IMG_DIR, f)); } catch (e) { } });
    console.log(`  [记账] 清单已更新 ${Object.keys(written).length} 人 | 本次完整 ${Object.keys(doneEa).length} 人 | 已传 ${Math.round(bytes / 1048576)} MB`);
    return written;
  }

  async function uploadOne(fileName) {
    const buf = fs.readFileSync(path.join(IMG_DIR, fileName));
    const cloudPath = imgLib.cloudPathOf(fileName, VER);
    let lastErr = null;
    for (let i = 0; i < MAX_TRY; i++) {
      try {
        await app.uploadFile({ cloudPath, fileContent: buf });
        return buf.length;
      } catch (e) {
        lastErr = e;
        await sleep(1000 * (i + 1));
      }
    }
    throw lastErr;
  }

  let cursor = 0, finished = 0;
  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= files.length) return;
      const f = files[i];
      try {
        bytes += await uploadOne(f);
        doneFiles.add(f);
        const id = owner[f];
        remain[id]--;
        if (remain[id] === 0) doneEa[id] = index[id].sig;
      } catch (e) {
        failed++;
        if (failed <= 5) console.log('  上传失败', f, (e && e.message) || e);
      }
      finished++;
      sinceFlush++;
      if (sinceFlush >= FLUSH_EVERY) { sinceFlush = 0; flush(); }
      if (finished % 500 === 0) {
        console.log('上传进度', finished, '/', files.length, '| 失败', failed, '| 已传', Math.round(bytes / 1048576), 'MB');
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONC, files.length) }, worker));

  flush();
  const complete = Object.keys(doneEa).length;
  console.log(`上传完成: 文件成功 ${doneFiles.size}/${files.length} | 失败 ${failed} | 本次完整球员 ${complete}/${eaIds.length}`);

  if (failed) {
    console.error(`⚠️ 有 ${failed} 个文件上传失败，这些球员未计入清单，下次运行会自动重试`);
    process.exit(1);
  }
})().catch(e => {
  console.error('图片上传失败:', (e && e.message) || e);
  process.exit(1);
});
