// 一次性脚本：从白底剪影源图提取「人物 alpha 蒙版」，裁到 bbox，灰填充，存为仓库资源
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const SIL_SRC = 'C:/Users/WIN10/.workbuddy/clipboard-images/clipboard-2026-09-12T05-17-05-633Z-34a16e15.jpg';
const OUT = path.resolve(__dirname, '..', 'assets', 'fallback_silhouette.png');
const GRAY = [0x9a, 0xa0, 0xa8];

(async () => {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });

  const N = 900;
  const { data, info } = await sharp(SIL_SRC).resize(N, N, { fit: 'fill' }).grayscale().raw()
    .toBuffer({ resolveWithObject: true });
  const W = info.width, H = info.height;

  let minX = W, maxX = -1, minY = H, maxY = -1;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (data[y * W + x] < 190) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  const bw = maxX - minX + 1, bh = maxY - minY + 1;
  console.log(`人物 bbox ${bw}x${bh} @ (${minX},${minY})  宽高比(高/宽) ${(bh / bw).toFixed(3)}`);

  const rgba = Buffer.alloc(bw * bh * 4);
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      const lum = data[(y + minY) * W + (x + minX)];
      let a;
      if (lum <= 150) a = 255;
      else if (lum >= 205) a = 0;
      else a = Math.round(255 * (205 - lum) / 55);
      const o = (y * bw + x) * 4;
      rgba[o] = GRAY[0]; rgba[o + 1] = GRAY[1]; rgba[o + 2] = GRAY[2]; rgba[o + 3] = a;
    }
  }

  await sharp(rgba, { raw: { width: bw, height: bh, channels: 4 } }).png({ compressionLevel: 9 }).toFile(OUT);
  console.log(`已写入 ${OUT} (${(fs.statSync(OUT).size / 1024).toFixed(1)}KB)`);
})().catch(e => { console.error(e); process.exit(1); });
