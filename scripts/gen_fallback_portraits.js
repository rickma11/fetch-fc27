// 为 fut.gg 没有 portrait（imagePath 空）的球员生成「兜底半身像」：
// 取该球员的 _card.webp 作底图，叠加一层半透明青色蒙版（与小程序主题色 #22d3ee 一致），
// 输出 {eaId}.webp 上传云存储。生成后 images.json 也同步补签名（让 fetch-fc27 知道这张已"上传"）。
//
// 为什么需要：
//   fut.gg 上有约 320 名球员（约 3.2%）只有卡面大图、没有半身像。
//   小程序列表页会因此灰框展示。本脚本补齐后所有球员都有头像。
//
// 用法：node scripts/gen_fallback_portraits.js --ver 27 [--conc 8] [--dry]
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const cloudbase = require('@cloudbase/node-sdk');
const { resolve } = require('./tcb_env');
const imgLib = require('./images');

const cred = resolve();
if (cred.missing.length) { console.error('缺少凭证：' + cred.missing.join('/')); process.exit(1); }

const VER = (function () {
  const a = process.argv.find(x => x.startsWith('--ver='));
  if (a) return Number(a.slice(6));
  const i = process.argv.indexOf('--ver');
  return i >= 0 ? Number(process.argv[i + 1]) : 27;
})();
const CONC = (function () {
  const a = process.argv.find(x => x.startsWith('--conc='));
  return a ? Number(a.slice(7)) : (Number(process.env.FC_FB_CONC) || 6);
})();
const DRY = process.argv.includes('--dry');

const ROOT = path.resolve(__dirname, '..');
const TMP_DIR = path.join(ROOT, '_fb_portraits_tmp');
fs.mkdirSync(TMP_DIR, { recursive: true });

const app = cloudbase.init({ env: cred.ENV_ID, secretId: cred.SECRET_ID, secretKey: cred.SECRET_KEY, timeout: 60000 });
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  console.log(`[fallback-portraits] ver=FC${VER} conc=${CONC} dry=${DRY}`);

  // 1) 找出「有卡面、没半身像」的球员
  const players = JSON.parse(fs.readFileSync(path.join(ROOT, 'cloud-data', `fc${VER}`, 'players.json'), 'utf8'));
  const targets = players.filter(p => p.cardImagePath && !p.imagePath);
  console.log(`  候选 ${targets.length} 名球员（有卡面无半身像）`);

  // 2) 探测拿 PREFIX（与 upload_images.js / gen_preview_cloud.js 一致的做法）
  const probe = await app.uploadFile({
    cloudPath: `fc${VER}/images/_fb_probe_${Date.now()}.png`,
    fileContent: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')
  });
  const PREFIX = probe.fileID.slice(0, probe.fileID.indexOf(`fc${VER}/images/`));
  await app.deleteFile({ fileList: [probe.fileID] });

  // 3) 并发生成 + 上传
  const newSigs = {};   // eaId -> new sig (与原签名不同，触发后续变更检测；这里用固定前缀方便人工识别)
  let ok = 0, skip = 0, fail = 0;
  let cursor = 0, done = 0;

  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= targets.length) return;
      const p = targets[i];
      const eaId = String(p.eaId);
      const cardFile = `${eaId}_card.webp`;
      const portraitFile = `${eaId}.webp`;
      const localCard = path.join(TMP_DIR, cardFile);
      const localPortrait = path.join(TMP_DIR, portraitFile);

      try {
        // 已存在则跳过（支持断点续传）
        if (fs.existsSync(localPortrait) && !DRY) { ok++; done++; continue; }

        // 下载 _card.webp
        const dl = await app.downloadFile({ fileID: `${PREFIX}fc${VER}/images/${cardFile}` });
        const cardBuf = Buffer.from(dl.fileContent);
        if (!cardBuf.length) throw new Error('card 文件为空');

        // 生成 tinted portrait：原图 + 40% 透明度青色蒙版
        //   选用 #22d3ee 是小程序首页选中色 / tab 主题色，视觉上一眼能识别"这是兜底图"
        const cardMeta = await sharp(cardBuf).metadata();
        const tintedBuf = await sharp(cardBuf)
          .composite([{
            input: Buffer.from(
              `<svg width="${cardMeta.width}" height="${cardMeta.height}">` +
              `<rect width="100%" height="100%" fill="#22d3ee" fill-opacity="0.4"/>` +
              `</svg>`
            ),
            top: 0, left: 0
          }])
          .webp({ quality: 82 })
          .toBuffer();

        fs.writeFileSync(localPortrait, tintedBuf);

        if (!DRY) {
          await app.uploadFile({
            cloudPath: `fc${VER}/images/${portraitFile}`,
            fileContent: tintedBuf
          });
        }
        // 用「fb-」前缀的固定签名，避免与真实 portrait 冲突，标识这是兜底图
        newSigs[eaId] = 'fb-fallback-v1';
        ok++;
      } catch (e) {
        fail++;
        if (fail <= 5) console.log(`  ✗ ${eaId}: ${(e && e.message) || e}`);
      }
      done++;
      if (done % 50 === 0 || done === targets.length) {
        console.log(`  进度 ${done}/${targets.length} | 成功 ${ok} | 失败 ${fail}`);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONC, targets.length) }, worker));

  // 4) 合并写回 images.json
  if (!DRY && Object.keys(newSigs).length) {
    const manifest = imgLib.readManifest(VER);
    Object.assign(manifest, newSigs);
    imgLib.writeManifest(VER, manifest);
    console.log(`  ✓ images.json 已合并 ${Object.keys(newSigs).length} 条兜底签名`);
  }

  // 5) 清理临时目录
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (e) {}

  console.log(`\n✔ 完成 | 生成 ${ok} 个兜底头像 | 失败 ${fail} | dry=${DRY}`);
})().catch(e => { console.error('脚本异常:', e); process.exit(1); });