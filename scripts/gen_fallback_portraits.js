// 为 fut.gg 没有 portrait（imagePath 为空）的球员生成「兜底卡面」：
//   取该球员【自己的】_card.webp 作底图（这样 OVR/位置/姓名/六维/国旗/队徽 全是本人数据），
//   1) 抹掉 fut.gg 渲染时留下的「破图占位符」（本该画小徽标的位置，源图里是个破损图图标）；
//   2) 在空白的照片区叠加一个灰色通用人物剪影；
//   输出 {eaId}.webp 上传云存储，与真实半身像同名，小程序按 eaId 拼路径即可。
//
// 为什么需要：
//   fut.gg 上约 3.2%（~320 名）球员只有卡面大图、没有半身像（imagePath 为空），
//   且这些球员的卡面图里【照片区本来就是空的】，并且左上角带一个渲染失败的破图图标。
//
// 抹除破图图标的做法（关键）：
//   这些卡的底图（rarity.imagePath 决定）是同一张素材，同一底图的「有 portrait 卡」在
//   该区域是干净的。所以按 rarity.imagePath 分组，找一张同底图且有 portrait 的卡当「纹理源」，
//   把破图区域连同周围一小块直接克隆过来 —— 底图逐像素一致（实测 MAD≈0.7），斜纹无缝。
//   若找不到合适纹理源，退化为「左右边缘色水平插值填充」（会有轻微平斑，但不会露破图）。
//
// 注意：不要用「某个球员的卡面」当所有人的模板（会出现"人人都是 Fekir"的错误数据）。
// 剪影素材已固化为仓库资源 assets/fallback_silhouette.png（灰填充 + alpha）。
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

const SIG = 'fb-fallback-v3';   // 本人卡面 + 抹除破图 + 灰色通用剪影

// 版式参数（以 500px 宽卡面为基准，实际按卡面宽度等比缩放）
const FB_WIDTH = 237;   // 剪影宽度（较 v2 的 215 放大 110%）
const FB_TOP = 185;     // 剪影顶部 y（较 v2 下移 20px）
const FB_FADE = 0.14;   // 底部渐隐比例

// 破图图标区域（500 坐标；字符图实测图标 x[120,139] y[122,142]，四周留几 px 余量，
// 右边界 143 保证不碰到姓名首字母——姓名左边缘约在 x=143）
const ICON_BOX = { x0: 113, y0: 115, x1: 143, y1: 150 };
// 图标本体 bbox（用于算「环带」：ERASE 区里除图标以外的背景像素）
const ICON_INNER = { x0: 118, y0: 120, x1: 142, y1: 144 };
// 背景带（图标正下方，x 上限 140 避开姓名），同底图卡应逐像素一致 —— 用于识别纹理源是否同底图
const BAND_BOX = { x0: 112, y0: 145, x1: 140, y1: 158 };

const ROOT = path.resolve(__dirname, '..');
const SIL_ASSET = path.join(ROOT, 'assets', 'fallback_silhouette.png');
const TMP_DIR = path.join(ROOT, '_fb_portraits_tmp');
fs.mkdirSync(TMP_DIR, { recursive: true });

const app = cloudbase.init({ env: cred.ENV_ID, secretId: cred.SECRET_ID, secretKey: cred.SECRET_KEY, timeout: 60000 });

const sc = (v, s) => Math.round(v * s);
const boxOf = (box, s) => ({
  left: sc(box.x0, s), top: sc(box.y0, s),
  width: sc(box.x1, s) - sc(box.x0, s), height: sc(box.y1, s) - sc(box.y0, s)
});

const inBox = (b, x, y) => x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1;

// 取某个框内的像素（可排除内部子框），坐标用 500 基准
async function boxPixels(buf, s, box, exclude) {
  const r = boxOf(box, s);
  const { data, info } = await sharp(buf).extract(r).raw().toBuffer({ resolveWithObject: true });
  const ch = info.channels, px = [];
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      const bx = box.x0 + x / s, by = box.y0 + y / s;
      if (exclude && inBox(exclude, bx, by)) continue;
      const o = (y * info.width + x) * ch;
      px.push([data[o], data[o + 1], data[o + 2]]);
    }
  }
  return px;
}

function mad(a, b) {
  const n = Math.min(a.length, b.length);
  let d = 0;
  for (let i = 0; i < n; i++) d += (Math.abs(a[i][0] - b[i][0]) + Math.abs(a[i][1] - b[i][1]) + Math.abs(a[i][2] - b[i][2])) / 3;
  return n ? d / n : 999;
}

function std(px) {
  const v = px.map(p => (p[0] + p[1] + p[2]) / 3);
  const m = v.reduce((a, b) => a + b, 0) / v.length;
  return Math.sqrt(v.reduce((a, b) => a + Math.pow(b - m, 2), 0) / v.length);
}

// 找同底图的干净纹理源（同底图 + 有 portrait 的卡），返回该区域的 PNG 补丁
async function findCleanPatch(players, groupKey, refBuf, refS, dlCard) {
  const s = refS.s;
  const refBand = await boxPixels(refBuf, s, BAND_BOX);            // 背景带（判同底图）
  const refRing = await boxPixels(refBuf, s, ICON_BOX, ICON_INNER); // 环带（判克隆区一致）

  const cands = players.filter(p =>
    p.imagePath && p.cardImagePath && p.rarity && p.rarity.imagePath === groupKey);
  let best = null;
  const probeN = Math.min(cands.length, 40);
  for (let i = 0; i < probeN; i++) {
    const c = cands[i];
    try {
      const buf = await dlCard(String(c.eaId));
      const meta = await sharp(buf).metadata();
      if (meta.width !== refS.w || meta.height !== refS.h) continue;

      const band = await boxPixels(buf, s, BAND_BOX);
      const dBand = mad(refBand, band);
      if (dBand > 4) continue;                       // 不同底图（异设计/异稀有度）直接排除
      if (std(band) > 14) continue;                  // 该候选此处不平滑（半身像/文字侵入）

      const ring = await boxPixels(buf, s, ICON_BOX, ICON_INNER);
      const dRing = mad(refRing, ring);              // 克隆区背景是否逐像素一致

      const score = dRing + dBand;
      if (!best || score < best.score) {
        const patch = await sharp(buf).extract(boxOf(ICON_BOX, s)).png().toBuffer();
        best = { id: String(c.eaId), name: c.commonName, dRing, dBand, score, patch };
      }
      if (dRing < 2 && dBand < 1.5) break;
    } catch (e) { /* 跳过异常候选 */ }
  }

  if (best) {
    console.log(`  纹理源 [${groupKey.slice(-12)}] → ${best.id} ${best.name || ''}（环带MAD=${best.dRing.toFixed(2)} 背景带MAD=${best.dBand.toFixed(2)}）`);
    return best;
  }
  console.log(`  ! 未找到同底图纹理源 [${groupKey.slice(-12)}]，该组退化为插值填充`);
  return null;
}

// 插值填充兜底（无纹理源时用）
async function eraseByInterp(cardBuf, s) {
  const { data, info } = await sharp(cardBuf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const ch = info.channels, W = info.width, H = info.height;
  const r = boxOf(ICON_BOX, s);
  const bx0 = r.left, by0 = r.top, bx1 = r.left + r.width - 1, by1 = r.top + r.height - 1;
  const pw = bx1 - bx0 + 1, ph = by1 - by0 + 1;
  const patch = Buffer.alloc(pw * ph * 4);
  const sample = 4;
  for (let y = by0; y <= by1; y++) {
    const lo = (y * W + Math.max(0, bx0 - sample)) * ch, ro = (y * W + Math.min(W - 1, bx1 + sample)) * ch;
    for (let k = 0; k < 3; k++) {
      const lv = data[lo + k], rv = data[ro + k];
      for (let x = bx0; x <= bx1; x++) {
        const t = (x - bx0) / Math.max(1, bx1 - bx0);
        patch[((y - by0) * pw + (x - bx0)) * 4 + k] = Math.round(lv + (rv - lv) * t);
      }
    }
  }
  for (let yy = 0; yy < ph; yy++) {
    for (let xx = 0; xx < pw; xx++) {
      const d = Math.min(yy, ph - 1 - yy, Math.round((xx + 1) / 2));
      patch[(yy * pw + xx) * 4 + 3] = d >= 3 ? 255 : Math.round(255 * (d + 1) / 4);
    }
  }
  const png = await sharp(patch, { raw: { width: pw, height: ph, channels: 4 } }).blur(0.6).png().toBuffer();
  return sharp(cardBuf).composite([{ input: png, left: bx0, top: by0 }]).webp({ quality: 95 }).toBuffer();
}

// 卡面 + 剪影（+ 可选纹理补丁）
async function composeFallback(cardBuf, s, patch) {
  let base = cardBuf;
  if (patch) {
    const r = boxOf(ICON_BOX, s);
    base = await sharp(cardBuf).composite([{ input: patch, left: r.left, top: r.top }]).webp({ quality: 95 }).toBuffer();
  }
  const cardMeta = await sharp(base).metadata();
  const W = cardMeta.width || 500;
  const k = W / 500;
  const silMeta = await sharp(SIL_ASSET).metadata();
  const targetW = Math.round(FB_WIDTH * k);
  const targetH = Math.round(targetW * silMeta.height / silMeta.width);

  const { data, info } = await sharp(SIL_ASSET)
    .resize(targetW, targetH, { fit: 'fill' })
    .ensureAlpha().raw().toBuffer({ resolveWithObject: true });

  const fadeStart = Math.round(info.height * (1 - FB_FADE));
  for (let y = fadeStart; y < info.height; y++) {
    const a = 1 - (y - fadeStart) / Math.max(1, info.height - fadeStart);
    for (let x = 0; x < info.width; x++) {
      const o = (y * info.width + x) * 4 + 3;
      data[o] = Math.round(data[o] * a);
    }
  }

  const silPng = await sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer();
  return sharp(base)
    .composite([{ input: silPng, left: Math.round((W - targetW) / 2), top: Math.round(FB_TOP * k), blend: 'over' }])
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

  const dlCard = async (eaId) => {
    const r = await app.downloadFile({ fileID: `${PREFIX}fc${VER}/images/${eaId}_card.webp` });
    return Buffer.from(r.fileContent);
  };

  // 3) 按底图（rarity.imagePath）分组，为每组准备纹理补丁
  const groups = {};
  todo.forEach(p => {
    const key = (p.rarity && p.rarity.imagePath) || '_none';
    (groups[key] = groups[key] || []).push(p);
  });
  const patches = {};
  for (const key of Object.keys(groups)) {
    const list = groups[key];
    let refBuf = null, refS = null;
    try {
      refBuf = await dlCard(String(list[0].eaId));
      const m = await sharp(refBuf).metadata();
      refS = { w: m.width, h: m.height, s: m.width / 500 };
    } catch (e) {
      console.log(`  ! 参照卡下载失败（${list[0].eaId}）：${e.message}`);
    }
    patches[key] = refBuf
      ? await findCleanPatch(players, key, refBuf, refS, dlCard)
      : null;
    patches[key + '__s'] = refS;
  }

  // 4) 并发生成 + 上传
  const newSigs = {};
  let ok = 0, fail = 0, skipped = targets.length - todo.length;
  let cursor = 0, done = 0, interpFallback = 0;

  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= todo.length) return;
      const p = todo[i];
      const eaId = String(p.eaId);
      try {
        const key = (p.rarity && p.rarity.imagePath) || '_none';
        const cardBuf = await dlCard(eaId);
        if (!cardBuf.length) throw new Error('卡面文件为空');
        const meta = await sharp(cardBuf).metadata();
        const s = meta.width / 500;

        let patch = patches[key];
        if (!patch) { interpFallback++; patch = null; }
        const out = patch
          ? await composeFallback(cardBuf, s, patch.patch)
          : await composeFallback(await eraseByInterp(cardBuf, s), s, null);

        if (!DRY) await app.uploadFile({ cloudPath: `fc${VER}/images/${eaId}.webp`, fileContent: out });
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

  // 5) 合并写回 images.json
  if (!DRY && Object.keys(newSigs).length) {
    Object.assign(manifest, newSigs);
    imgLib.writeManifest(VER, manifest);
    console.log(`  ✓ images.json 已合并 ${Object.keys(newSigs).length} 条兜底签名`);
  }

  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (e) {}

  console.log(`\n✔ 完成 | 生成 ${ok} 个兜底卡面 | 跳过 ${skipped} | 失败 ${fail} | 插值兜底 ${interpFallback} | dry=${DRY}`);
})().catch(e => { console.error('脚本异常:', e); process.exit(1); });
