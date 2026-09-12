// 生成「原卡面 → 处理后」对比图，供人工确认无半身像卡面的效果。
//
// 场景：改完 gen_noportrait_cards.js 的算法后跑这个脚本，一眼就能看出
// 破图图标 / 多余姓名有没有清干净、OVR 数字有没有被削、卡面轮廓外有没有被填色。
//
// 前置：先跑过 gen_noportrait_cards.js（本地需要有 _np_out/{eaId}.webp 与
// %TEMP%/fc_np_cache/27_{eaId}_card.webp 两个缓存）。
//
// 用法：node scripts/preview_noportrait.js [--ids 74634,254831,75086] [--out <路径>]
const fs = require('fs');
const os = require('os');
const path = require('path');
const sharp = require('sharp');

const ROOT = path.resolve(__dirname, '..');
const CACHE = path.join(os.tmpdir(), 'fc_np_cache');

const argv = process.argv.slice(2);
const argOf = (name, def) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const IDS = argOf('--ids', '74634,254831,75086').split(',').map(s => s.trim()).filter(Boolean);
const OUT = argOf('--out', path.join(ROOT, '_np_out', 'compare.png'));

const SCALE = 0.5;
const CW = Math.round(500 * SCALE), CH = Math.round(698 * SCALE);
const GAP = 16, PAD = 20, TITLE = 48;

(async () => {
  const rows = IDS.length;
  const W = PAD * 2 + CW * 2 + GAP;
  const H = TITLE + PAD + rows * CH + (rows - 1) * GAP + PAD;

  const comps = [];
  for (let r = 0; r < rows; r++) {
    const id = IDS[r];
    const src = path.join(CACHE, '27_' + id + '_card.webp');
    const np = path.join(ROOT, '_np_out', id + '.webp');
    if (!fs.existsSync(src)) throw new Error('缺缓存 ' + src + '（先跑一次 gen_noportrait_cards.js --no-upload 下载）');
    if (!fs.existsSync(np)) throw new Error('缺产物 ' + np + '（先跑 gen_noportrait_cards.js --no-upload 生成）');
    const top = TITLE + PAD + r * (CH + GAP);
    for (const [f, left] of [[src, PAD], [np, PAD + CW + GAP]]) {
      comps.push({
        input: await sharp(f).resize({ width: CW, height: CH, kernel: 'lanczos3' }).png().toBuffer(),
        left, top
      });
    }
    const label = Buffer.from(
      `<svg width="${W}" height="20"><text x="${PAD}" y="14" font-family="sans-serif" font-size="13" fill="#5a6472">${id}</text></svg>`
    );
    comps.push({ input: label, left: 0, top: top + CH + 2 });
  }

  const head = Buffer.from(
    `<svg width="${W}" height="${TITLE}">
      <text x="${PAD}" y="30" font-family="sans-serif" font-size="19" font-weight="600" fill="#1f2734">无半身像球员：原卡面 → 抹残留 + 通用剪影</text>
      <text x="${PAD + CW + GAP}" y="30" font-family="sans-serif" font-size="13" fill="#8a93a3">（左：fut.gg 原始  /  右：处理后）</text>
    </svg>`
  );
  comps.push({ input: head, left: 0, top: 0 });

  await sharp({
    create: { width: W, height: H, channels: 4, background: { r: 242, g: 244, b: 247, alpha: 1 } }
  }).composite(comps).png().toFile(OUT);

  const st = fs.statSync(OUT);
  console.log('✔ 对比图 → ' + OUT + ' (' + W + 'x' + H + ', ' + Math.round(st.size / 1024) + ' KB)');
})().catch(e => { console.error('✘', e.message); process.exit(1); });
