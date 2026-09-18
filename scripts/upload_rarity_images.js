// 把 images_out/ 里的稀有度小卡面（rarity_{rarityId}.webp，由 fetch_ci.js 阶段 4b 下载）
// 上传到云存储 fc{ver}/images/，供小程序筛选弹层的稀有度格子展示。
//
// 与 upload_images.js 的区别：稀有度卡面全库只有几~几十张，不需要签名增量清单驱动 ——
// 下载侧（fetch_ci 阶段 4b）已按 rarity_images.json 做了「imagePath 未变即跳过」，
// 这里只负责把**本次真的下载出来的文件**原样上传（确定性命名，覆盖上传幂等）。
//
// 用法：node scripts/upload_rarity_images.js --ver 27
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
const MAX_TRY = 3;

const app = cloudbase.init({
  env: cred.ENV_ID,
  secretId: cred.SECRET_ID,
  secretKey: cred.SECRET_KEY,
  timeout: 120000
});

const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  // 只挑 rarity_<内容hash>.webp（球员图片是纯数字/带后缀命名，不会误伤）
  const files = (fs.existsSync(IMG_DIR) ? fs.readdirSync(IMG_DIR) : [])
    .filter(f => /^rarity_[0-9a-f]+\.webp$/.test(f));
  if (!files.length) {
    console.log('没有 images_out/rarity_*.webp（本次未下载稀有度卡面），跳过');
    return;
  }
  console.log(`待上传稀有度卡面 ${files.length} 张 → fc${VER}/images/`);

  let done = 0, failed = 0;
  for (const name of files) {
    const local = path.join(IMG_DIR, name);
    const cloudPath = `fc${VER}/images/${name}`;
    let ok = false, lastErr = null;
    for (let t = 1; t <= MAX_TRY && !ok; t++) {
      try {
        await app.uploadFile({ cloudPath, fileContent: fs.readFileSync(local) });
        ok = true;
      } catch (e) {
        lastErr = e;
        await sleep(1000 * t);
      }
    }
    if (ok) done++;
    else { failed++; console.error('[rarity-up] 上传失败', name, (lastErr && lastErr.message) || lastErr); }
  }
  console.log(`稀有度卡面上传完成: 成功 ${done} | 失败 ${failed}`);
  // 失败不 exit 非零：与球员图片上传同语义（continue-on-error），下次运行按清单增量补
})();
