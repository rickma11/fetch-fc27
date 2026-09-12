// 为 fut.gg 没有 portrait（imagePath 为空）的球员生成「兜底卡面」：
//   取该球员【自己的】_card.webp 作底图（这样 OVR/位置/姓名/六维/国旗/队徽 全是本人数据），
//   在空白的照片区叠加一个灰色通用人物剪影，输出 {eaId}.webp 上传云存储。
//
// 为什么需要：
//   fut.gg 上约 3.2%（~320 名）球员只有卡面大图、没有半身像（imagePath 为空），
//   且这些球员的卡面图里【照片区本来就是空的】—— 小程序卡片会显得很空且列表小头像灰框。
//   补齐后：所有球员的 {eaId}.webp 都存在（有真实半身像的用真实图，没有的用本脚本生成的卡面图）。
//
// 注意：
//   - 不要用「某个球员的卡面」当所有人的模板（会出现"人人都是 Fekir"的错误数据）。
//   - 剪影素材已固化为仓库资源 assets/fallback_silhouette.png（灰填充 + alpha），
//     来源：用户提供的白底人像剪影，经 scripts/make_silhouette_asset.js 提取 bbox 得到。
//
// 用法：node scripts/gen_fallback_portraits.js --ver 27 [--conc 6] [--dry] [--force]
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
const FORCE = process.argv.includes('--force');

const SIG = 'fb-fallback-v2';   // 设计版本：本人卡面 + 灰色通用剪影

// 版式参数（以 500px 宽卡面为基准，实际按卡面宽度等比缩放）
const FB_WIDTH = 215;   // 剪影宽度
const FB_TOP = 165;     // 剪影顶部 y（避开卡面顶部的小名字标签，也不碰姓名/六维）
const FB_FADE = 0.14;   // 底部渐隐比例

const ROOT = path.resolve(__dirname, '..');
const SIL_ASSET = path.join(ROOT, 'assets', 'fallback_silhouette.png');
const TMP_DIR = path.join(ROOT, '_fb_portraits_tmp');
fs.mkdirSync(TMP_DIR, { recursive: true });

const app = cloudbase.init({ env: cred.ENV_ID, secretId: cred.SECRET_ID, secretKey: cred.SECRET_KEY, timeout: 60000 });

// 把剪影素材缩放 + 底部渐隐，合成到卡面，返回 WebP Buffer
async function composeFallback(cardBuf) {
  const cardMeta = await sharp(cardBuf).metadata();
  const W = cardMeta.width || 500;
  const scale = W / 500;
  const silMeta = await sharp(SIL_ASSET).metadata();
  const targetW = Math.round(FB_WIDTH * scale);
  const targetH = Math.round(targetW * silMeta.height / silMeta.width);

  const { data, info } = await sharp(SIL_ASSET)
    .resize(targetW, targetH, { fit: 'fill' })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const fadeStart = Math.round(info.height * (1 - FB_FADE));
  for (let y = fadeStart; y < info.height; y++) {
    const k = 1 - (y - fadeStart) / Math.max(1, info.height - fadeStart);
    for (let x = 0; x < info.width; x++) {
      const o = (y * info.width + x) * 4 + 3;
      data[o] = Math.round(data[o] * k);
    }
  }

  const silPng = await sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer();

  return sharp(cardBuf)
    .composite([{
      input: silPng,
      left: Math.round((W - targetW) / 2),
      top: Math.round(FB_TOP * scale),
      blend: 'over'
    }])
    .webp({ quality: 85 })
    .toBuffer();
}

(async () => {
  console.log(`[fallback-portraits] ver=FC${VER} conc=${CONC} dry=${DRY} force=${FORCE} sig=${SIG}`);
  if (!fs.existsSync(SIL_ASSET)) { console.error('缺少剪影素材：' + SIL_ASSET); process.exit(1); }

  // 1) 找出「有卡面、没半身像」的球员
  const players = JSON.parse(fs.readFileSync(path.join(ROOT, 'cloud-data', `fc${VER}`, 'players.json'), 'utf8'));
  const manifest = imgLib.readManifest(VER);
  const targets = players.filter(p => p.cardImagePath && !p.imagePath);
  const todo = FORCE ? targets : targets.filter(p => manifest[String(p.eaId)] !== SIG);
  console.log(`  候选 ${targets.length} 名（有卡面无半身像）| 需处理 ${todo.length} 名`);

  // 2) 探测拿 PREFIX（与 upload_images.js / gen_preview_cloud.js 一致的做法）
  const probe = await app.uploadFile({
    cloudPath: `fc${VER}/images/_fb_probe_${Date.now()}.png`,
    fileContent: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')
  });
  const PREFIX = probe.fileID.slice(0, probe.fileID.indexOf(`fc${VER}/images/`));
  await app.deleteFile({ fileList: [probe.fileID] });

  // 3) 并发生成 + 上传
  const newSigs = {};
  let ok = 0, fail = 0, skipped = targets.length - todo.length;
  let cursor = 0, done = 0;

  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= todo.length) return;
      const p = todo[i];
      const eaId = String(p.eaId);
      try {
        const dl = await app.downloadFile({ fileID: `${PREFIX}fc${VER}/images/${eaId}_card.webp` });
        const cardBuf = Buffer.from(dl.fileContent);
        if (!cardBuf.length) throw new Error('卡面文件为空');

        const out = await composeFallback(cardBuf);
        if (!DRY) {
          await app.uploadFile({ cloudPath: `fc${VER}/images/${eaId}.webp`, fileContent: out });
        }
        newSigs[eaId] = SIG;
        ok++;
      } catch (e) {
        fail++;
        if (fail <= 8) console.log(`  ✗ ${eaId} ${p.commonName || ''}: ${(e && e.message) || e}`);
      }
      done++;
      if (done % 50 === 0 || done === todo.length) {
        console.log(`  进度 ${done}/${todo.length} | 成功 ${ok} | 失败 ${fail}`);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONC, Math.max(1, todo.length)) }, worker));

  // 4) 合并写回 images.json
  if (!DRY && Object.keys(newSigs).length) {
    Object.assign(manifest, newSigs);
    imgLib.writeManifest(VER, manifest);
    console.log(`  ✓ images.json 已合并 ${Object.keys(newSigs).length} 条兜底签名`);
  }

  // 5) 清理临时目录
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (e) {}

  console.log(`\n✔ 完成 | 生成 ${ok} 个兜底卡面 | 跳过 ${skipped} | 失败 ${fail} | dry=${DRY}`);
})().catch(e => { console.error('脚本异常:', e); process.exit(1); });
