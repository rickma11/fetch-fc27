/**
 * 生成通用半身剪影素材 assets/noportrait/silhouette.png（供 gen_noportrait_cards.js 使用）。
 * 仅在需要更换剪影形状时跑一次。两种输入模式：
 *
 *   ① 已经是干净剪影（透明底 PNG，如用户直接给的 tytx.png）：
 *      node scripts/make_noportrait_silhouette.js --plain --src <剪影图>
 *      → 只做「裁到自己的人形包围盒」，去掉四周留白，让 gen 脚本能用「宽/中心/底边」三个
 *        数就把人像摆到位（留白会让目标尺寸算不准）。
 *
 *   ② 「球员卡 + 灰色人形剪影」的截图（fut.gg 换人像后想从卡面上抠回来时用）：
 *      node scripts/make_noportrait_silhouette.js --src <参考图> [--grey 167]
 *      → 提取原理：剪影是「去饱和的中灰」色块，周围是饱和的金/银/铜卡面 → 按
 *        （通道极差 < 22 且 亮度 128~205）取掩膜，再做 7x7 形态学闭运算（>55% 实心 / >25% 半透明）
 *        得到带 1px 羽化的 alpha。
 *
 * 当前素材来源（2026-09-16）：用户提供的 tytx.png，用模式①生成，输出 541x477。
 */
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'assets', 'noportrait');
const OUT = path.join(OUT_DIR, 'silhouette.png');

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

(async () => {
  const src = arg('--src');
  const grey = Number(arg('--grey', '167'));
  const plain = process.argv.includes('--plain');
  if (!src || !fs.existsSync(src)) {
    console.error('用法：node scripts/make_noportrait_silhouette.js [--plain] --src <图路径>');
    console.error('  --plain：输入已是透明底剪影 → 只裁到人形包围盒；不带则按「卡面 + 灰剪影」截图抠图。');
    process.exit(1);
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });

  // ---- 模式①：已经是干净剪影 → 裁到人形包围盒 ----
  if (plain) {
    const { data, info } = await sharp(src).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const W = info.width, H = info.height;
    let x0 = 1e9, x1 = -1, y0 = 1e9, y1 = -1, n = 0;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 4;
      if (data[o + 3] <= 128) continue;                       // 半透明/透明一律不算人形
      if ((data[o] + data[o + 1] + data[o + 2]) / 3 > 240) continue; // 顺带兼容不透明白底
      n++;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    if (n < 100) {
      console.error('图里没找到成规模的人形（命中像素 ' + n + '），请确认是「透明底剪影」图。');
      process.exit(1);
    }
    const sw = x1 - x0 + 1, sh = y1 - y0 + 1;
    await sharp(src).ensureAlpha().extract({ left: x0, top: y0, width: sw, height: sh }).png().toFile(OUT);
    console.log('剪影素材已生成（模式①裁切）：' + path.relative(ROOT, OUT) + '  ' + sw + 'x' + sh +
      '（宽高比 ' + (sw / sh).toFixed(3) + '）');
    return;
  }

  const { data, info } = await sharp(src).raw().toBuffer({ resolveWithObject: true });
  const W = info.width, H = info.height, ch = info.channels;
  // 只在画面中部搜索，避开顶部文字与底部水印
  const BX0 = Math.round(W * 0.15), BX1 = Math.round(W * 0.85);
  const BY0 = Math.round(H * 0.05), BY1 = Math.round(H * 0.72);
  const bw = BX1 - BX0, bh = BY1 - BY0;
  const M = new Uint8Array(bw * bh);
  let x0 = 1e9, x1 = -1, y0 = 1e9, y1 = -1, n = 0;
  for (let y = BY0; y < BY1; y++) for (let x = BX0; x < BX1; x++) {
    const o = (y * W + x) * ch, r = data[o], g = data[o + 1], b = data[o + 2];
    if (Math.max(r, g, b) - Math.min(r, g, b) < 22 && r > 128 && r < 205) {
      M[(y - BY0) * bw + (x - BX0)] = 1; n++;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
  }
  if (n < bw * bh * 0.03) {
    console.error('在参考图里没找到成规模的灰色剪影（命中像素 ' + n + '），请确认图里是「卡面 + 灰色人形剪影」。');
    process.exit(1);
  }
  const sw = x1 - x0 + 1, sh = y1 - y0 + 1;
  const out = Buffer.alloc(sw * sh * 4);
  for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
    let cnt = 0, tot = 0;
    for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= sw || yy >= sh) continue;
      tot++; cnt += M[(y0 - BY0 + yy) * bw + (x0 - BX0 + xx)];
    }
    const f = cnt / tot, a = f > 0.55 ? 255 : (f > 0.25 ? 120 : 0);
    const o = (y * sw + x) * 4;
    out[o] = grey; out[o + 1] = grey; out[o + 2] = grey; out[o + 3] = a;
  }
  await sharp(out, { raw: { width: sw, height: sh, channels: 4 } }).png().toFile(OUT);
  console.log('剪影素材已生成：' + path.relative(ROOT, OUT) + '  ' + sw + 'x' + sh + '（宽高比 ' + (sw / sh).toFixed(3) + '）');
})().catch(e => { console.error(e); process.exit(1); });
