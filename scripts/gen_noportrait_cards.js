/**
 * 给「没有半身像」的球员生成展示卡面 = 该球员本人的原卡面 + 通用灰色半身剪影
 *
 * 背景（2026-09-16 更新）：fut.gg 上约 6% 的球员 imagePath 为空（没有半身像）。
 *   ① 老版式卡面：照片区空白，但 fut.gg 多画了两处残留 —— 左上角一个「破图占位图标」、
 *      OVR 右边一行多余的球员姓名；② 新版式卡面（fut.gg 2026-09 起逐步替换，实测约占
 *      抽样 20%）：残留没了，取而代之的是**把「通用人像」烘焙进照片区**，实测 bbox
 *      x[144,415] y[156,442]（多张卡完全一致），底边正好被照片区底边裁掉。
 *   两种版式都要出「干净卡面 + 通用剪影」，所以剪影必须**完全盖住**那块通用人像
 *   （见下方 SIL_* 版式参数，底部必须到 442 不能只到 438）。
 *
 *   残留抹除仍按老算法做（新版式卡面上它只是空转，不会留痕）。
 *
 * 用法（在仓库根目录）：
 *   node scripts/gen_noportrait_cards.js --ver 27                 # 增量（只处理还没生成过的）
 *   node scripts/gen_noportrait_cards.js --ver 27 --all           # 目标集合改为「云库全量无半身像球员」
 *   node scripts/gen_noportrait_cards.js --ver 27 --force         # 全量重生成
 *   node scripts/gen_noportrait_cards.js --ver 27 --dry --only 229153,246070
 *   node scripts/gen_noportrait_cards.js --ver 27 --no-upload     # 只出图不上传（本地检查用）
 * 选项：
 *   --ver 26|27   版本（默认 27）
 *   --all         目标集合取自云库（imagePath 为空且有卡面），而不是本地 players.json
 *   --conc N      并发上传数（默认 4）
 *   --sil-width N 剪影宽度（默认 340）
 *   --sil-cx N    剪影中心 x（默认 275；右肩缺口靠它让开右侧逆足标签列）
 *   --dry         不写云存储、不写清单
 *   --keep        保留中间产物（_np_out/）
 *
 * 数据来源：**云存储里已有的 {eaId}_card.webp**（不需要访问 fut.gg，本机可跑）。
 * 清单：cloud-data/fc{ver}/noportrait.json —— 独立文件，绝不能并进 images.json
 *       （images.json 的签名驱动图片增量，混入新类型会让所有球员签名失效 → 触发全量重传）。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const cloudbase = require('@cloudbase/node-sdk');
const sharp = require('sharp');
const { resolve } = require('./tcb_env');

const ROOT = path.resolve(__dirname, '..');
const VER = (() => { const i = process.argv.indexOf('--ver'); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : '27'; })();
const CONC = Number((() => { const i = process.argv.indexOf('--conc'); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : '4'; })());
const SIL_WIDTH = Number((() => { const i = process.argv.indexOf('--sil-width'); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : '340'; })());
const FORCE = process.argv.includes('--force');
const DRY = process.argv.includes('--dry');
const ALL = process.argv.includes('--all');
const NO_UPLOAD = process.argv.includes('--no-upload');
const ONLY = (() => { const i = process.argv.indexOf('--only'); return i >= 0 && process.argv[i + 1] ? new Set(process.argv[i + 1].split(',')) : null; })();

// ---- 版式参数（500x698 卡面基准）----
const REG = { x0: 96, y0: 96, x1: 434, y1: 180 };          // 建底板用的观察区
const ICON = { x0: 112, x1: 150, y0: 114, y1: 150 };        // 破图图标（整块抹掉）
const NAME = { x0: 141, x1: 430, y0: 100, y1: 178 };        // 顶部多余姓名行
// 剪影版式：以「fut.gg 通用人像」为基准 —— 实测人像 x[144,415]、y[156,442]，底边 442 就是
// 照片区底边（443 起是姓名带）。剪影取 宽 340 / 底边 442，**中心 267**：
//   ① 底边与人像裁剪线重合、横向比人像宽，能把它完全盖住；
//   ② 素材（assets/noportrait/silhouette.png）的**右肩已裁掉一块缺口**（用户手工裁的），
//      缺口正好让开卡面右侧的逆足标签列 —— 标签左边界实测 ≈410（脚 R/L、星级 1★2 等）。
//      中心 267 时剪影右边界 436、缺口右缘落在 ≈406，标签整体完整；
//      中心 279 时右肩会压住标签左下角（Fekir 的 L 标签实测被压 5~8px）。
//   ③ 左右都不越出卡面轮廓（卡面实体 x47~453；剪影实绘 x97~436）。
// 中心可调：--sil-cx N
const SIL_CX = Number((() => { const i = process.argv.indexOf('--sil-cx'); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : '275'; })());
const SIL_BOT = 442;
const INK_REL = 35;          // 「比该像素背景中位暗 35 以上」判为字迹
const DILATE_SAMPLE = 3;     // 建底板时，把字迹及其 3px 邻域从样本里剔除（躲开 WebP 的过冲亮环）
const DILATE_FILL = 2;       // 抹除时，把字迹膨胀 2px 一起填（连抗锯齿边一起去掉）
const W = 500, H = 698;
const RW = REG.x1 - REG.x0, RH = REG.y1 - REG.y0;
const NP_PARAMS = 'np-v5|icon:' + [ICON.x0, ICON.x1, ICON.y0, ICON.y1].join(',') + '|name:' + [NAME.x0, NAME.x1, NAME.y0, NAME.y1].join(',') +
  '|sil:' + [SIL_WIDTH, SIL_CX, SIL_BOT].join(',');

const CACHE = path.join(os.tmpdir(), 'fc_np_cache');
const PLATE_DIR = path.join(CACHE, 'plates');
const OUT_DIR = path.join(ROOT, '_np_out');

const lvlOf = p => (String((p.rarity && p.rarity.imagePath) || '').match(/rarities-level-(\d)-large/) || [])[1] || '?';
const lum = (d, i) => (d[i * 4] + d[i * 4 + 1] + d[i * 4 + 2]) / 3;
const mid = arr => { arr.sort((a, b) => a - b); return arr[Math.floor(arr.length / 2)]; };

(async () => {
  const players = JSON.parse(fs.readFileSync(path.join(ROOT, 'cloud-data', 'fc' + VER, 'players.json'), 'utf8'));
  // 当前 fut.gg 真实 imagePath（来自本次抓取的 dump，权威）：eaId -> 相对路径。
  // 用来识别「原本无半身像、现已补上」的球员，使其在下方 target 中被排除（不再生成 _np.webp），
  // 否则在 players.json 两次 full 之间过期时，会回弹重生成 _np 并把它们加回清单。
  const curImg = {};
  const _dumpP = path.join(ROOT, 'fc27_dump.json');
  if (fs.existsSync(_dumpP)) {
    try {
      const _dump = JSON.parse(fs.readFileSync(_dumpP, 'utf8'));
      const _list = Array.isArray(_dump.list) ? _dump.list : (Array.isArray(_dump.players) ? _dump.players : []);
      // ⚠️ 必须排除占位图：fut.gg 对照片未就绪的球员返回 `prelaunch-photos-v2/…`（非空但非真图）。
      // 早期版本没过滤，于是 Phase 0 把这些球员误判成「已获半身像」→ 写库 + 删掉 _np.webp，
      // 结果端上切到 _card.webp（照片区是 fut.gg 通用人像）＝用户看到的「未处理头像」。
      // 正则与 fetch_futgg.js#PLACEHOLDER_IMG_RE 同源，**改一处必须同改另一处**。
      const _PH = /prelaunch-photos|placeholder|\/no-player\//i;
      for (const _it of _list) {
        if (_it && _it.eaId != null && _it.imagePath && !_PH.test(String(_it.imagePath))) {
          curImg[String(_it.eaId)] = String(_it.imagePath);
        }
      }
    } catch (e) { /* dump 读取失败不致命，仅失去对账能力 */ }
  }
  const cred = resolve();
  const app = cloudbase.init({ env: cred.ENV_ID, secretId: cred.SECRET_ID, secretKey: cred.SECRET_KEY, timeout: 60000 });
  const BUCKET = '636c-' + cred.ENV_ID + '-1475854307';
  const PREFIX = 'cloud://' + cred.ENV_ID + '.' + BUCKET + '/fc' + VER + '/images/';
  const db = app.database();

  // 目标集合：
  //   默认 —— players.json 里「有卡面、无 imagePath」的人。⚠️ 本机这份 players.json 常是上一轮
  //            全量快照（历史上受 10000 条上限影响），新入库 / 不在里面的无像球员会被漏掉；
  //            要「把端上在用的无像卡面全量重做」时必须用 --all。
  //   --all —— 直接问云库（imagePath 为空且有卡面）。端上 displayImg() 对这类球员一律拼
  //            {eaId}_np.webp，所以这才是「真正需要存在 _np.webp」的全集。
  let target;
  if (ALL) {
    const rows = [];
    let skip = 0;
    for (;;) {
      const r = await db.collection('players_fc' + VER).where({ imagePath: '' }).limit(1000).skip(skip).get();
      const got = (r && r.data) || [];
      rows.push(...got);
      if (got.length < 1000) break;
      skip += 1000;
    }
    const hasCard = rows.filter(d => d.cardImagePath);
    target = hasCard
      .filter(d => !curImg[String(d._id)])
      .map(d => ({ eaId: d._id, commonName: d.commonName, imagePath: d.imagePath, cardImagePath: d.cardImagePath, rarity: d.rarity }));
    console.log('--all：云库 imagePath 为空且有卡面 ' + hasCard.length + ' 人，扣掉已获半身像后剩 ' + target.length + ' 人');
  } else {
    target = players.filter(p => p.cardImagePath && !p.imagePath && !curImg[String(p.eaId)]);
  }
  if (ONLY) target = target.filter(p => ONLY.has(String(p.eaId)));
  // 注：此处不再提前 return —— 下方 Phase 0 对账必须在生成前执行，
  // 否则当「所有无半身像球员都已获图」(target 为空) 时，对账会被跳过、清单得不到清理。
  // 建底板的样本池：本地 players.json 的无像球员 ∪ 本次目标（--all 时后者才是全量）
  const platePool = (() => {
    const m = new Map();
    for (const p of players) if (!p.imagePath && p.cardImagePath) m.set(String(p.eaId), p);
    for (const p of target) m.set(String(p.eaId), p);
    return [...m.values()];
  })();

  const silPath = path.join(ROOT, 'assets', 'noportrait', 'silhouette.png');
  if (!fs.existsSync(silPath)) {
    console.error('缺少剪影素材 assets/noportrait/silhouette.png，先跑：node scripts/make_noportrait_silhouette.js --plain --src <剪影图>');
    process.exit(1);
  }
  const silMeta = await sharp(silPath).metadata();
  const silBufFull = fs.readFileSync(silPath);
  // 剪影文件内容也进签名：换了剪影形状/灰阶后，所有已生成的卡会自动判为过期并重做
  const PARAMS = NP_PARAMS + '|silfile:' +
    crypto.createHash('sha1').update(silBufFull).digest('hex').slice(0, 8);

  // ---- Phase 0：对账「已获半身像」的球员（fut.gg 补图后自动切回真实卡面）----
  // 列表签名(sig.js)刻意不含 imagePath，故补半身像不会改变签名 → 不会进入增量落库包 →
  // 云数据库里的 imagePath 始终是空 → 小程序端 displayImg() 继续判定「无像」、沿用 _np.webp。
  // 这里用「本次抓取的 dump 列表」(权威、含最新 imagePath) 检出这些球员，主动：
  //   ① 把 imagePath 写进云数据库(players/details) —— 客户端随即切回真实卡面(_card.webp 已是带脸版)；
  //   ② 从 noportrait.json 清单移除 —— 不再为其生成 _np.webp；
  //   ③ 删除云存储里已无引用的孤儿 _np.webp(节省约数 MB 云存储)。
  // 该步骤每天随 CI 触发，即「定期检查并重新启用半身像」的机制；portrait/card 图片本身已由
  // fetch_ci 阶段4(签名变化即下载) + upload_images 负责下载并上传，这里只补上 DB 标记与清单清理。
  const manifestPath = path.join(ROOT, 'cloud-data', 'fc' + VER, 'noportrait.json');
  const manifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : {};
  const gained = Object.keys(manifest).filter(function (id) { return curImg[id]; });
  // ② 漏网之鱼：云库 imagePath 为空、但本次 dump 已有真实头像的球员。
  //    np 生成曾失败 / 从未进清单者，补头像后 upload_db 增量（签名刻意不含 imagePath）不会写云库，
  //    若只靠清单对账会永久停在空头像 —— 这里直接查云库空头像集合兜底，去掉对清单与单一步骤的依赖。
  let missed = [];
  if (!DRY) {
    try {
      let skip = 0;
      for (;;) {
        const r = await db.collection('players_fc' + VER).where({ imagePath: '' }).limit(1000).skip(skip).get();
        const rows = (r && r.data) || [];
        for (const d of rows) { const id = String(d._id); if (curImg[id] && !manifest[id]) missed.push(id); }
        if (rows.length < 1000) break;
        skip += 1000;
      }
    } catch (e) { console.warn('  [reconcile] 查询空头像球员失败: ' + ((e && e.message) || e)); }
  }
  if (gained.length || missed.length) {
    if (DRY) {
      console.log('对账[dry]：清单内 ' + gained.length + ' + 云库空头像漏网 ' + missed.length + ' 名球员已获 fut.gg 半身像，将切回真实卡面（dry 模式不写库/不删孤儿/不改清单）');
    } else {
      console.log('对账：清单内 ' + gained.length + ' + 云库空头像漏网 ' + missed.length + ' 名球员已获 fut.gg 半身像，切回真实卡面…');
      let okDb = 0, okDel = 0;
      const flip = async function (id, inManifest) {
        const imgPath = curImg[id];
        try {
          await db.collection('players_fc' + VER).doc(id).update({ data: { imagePath: imgPath } });
          await db.collection('details_fc' + VER).doc(id).update({ data: { imagePath: imgPath } });
          okDb++;
        } catch (e) { console.warn('  [reconcile] 更新 DB ' + id + ' 失败: ' + ((e && e.message) || e)); }
        try { await app.deleteFile({ fileList: [PREFIX + id + '_np.webp'] }); okDel++; }
        catch (e) { /* 孤儿删除失败不致命 */ }
        if (inManifest) delete manifest[id];
      };
      for (const id of gained) await flip(id, true);
      for (const id of missed) await flip(id, false);
      console.log('  → DB 更新 ' + okDb + ' 人 | 孤儿 _np.webp 删除 ' + okDel + ' 张 | 清单移除 ' + gained.length + ' 人（漏网 ' + missed.length + ' 人不占清单）');
    }
  } else {
    console.log('对账：noportrait 清单中暂无球员已获半身像');
  }
  // 没有任何需要生成的卡面时，仍写出已对账清理的清单并结束（避免无谓的底板/剪影计算）
  if (!target.length) {
    if (!DRY) fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 1));
    console.log('无新无半身像卡面需生成（noportrait 清单已对账' + (DRY ? '，dry 未落盘' : '') + '）');
    return;
  }

  fs.mkdirSync(CACHE, { recursive: true });
  fs.mkdirSync(PLATE_DIR, { recursive: true });
  if (!DRY) fs.mkdirSync(OUT_DIR, { recursive: true });

  const dlCard = async id => {
    const f = path.join(CACHE, VER + '_' + id + '_card.webp');
    if (fs.existsSync(f)) return fs.readFileSync(f);
    const r = await app.downloadFile({ fileID: PREFIX + id + '_card.webp' });
    const b = Buffer.from(r.fileContent);
    fs.writeFileSync(f, b);
    return b;
  };

  // ---------- 1) 每个稀有度建一块「背景底板」 ----------
  // 同稀有度卡的背景逐像素完全一致（实测 98~100/120 张同值），而字迹是暗色 → 可以精确还原背景。
  // 关键：先把「字迹及其 3px 邻域」的样本剔除，否则 WebP 在深色笔画边缘的 +12 级过冲亮环会被当成背景，留下亮残影。
  // 破图图标整块剔除（图标内部有浅色像素），空出的像素用同行左右最近有效值线性插值。
  const buildPlate = async lv => {
    const pf = path.join(PLATE_DIR, 'fc' + VER + '_l' + lv + '.raw');
    if (fs.existsSync(pf) && !FORCE) return fs.readFileSync(pf);
    const pool = platePool.filter(p => lvlOf(p) === lv);
    const M = Math.min(120, pool.length), S = [];
    for (let i = 0; i < M; i++) {
      const c = pool[Math.floor(pool.length * i / M)];
      try {
        const b = await dlCard(c.eaId);
        const { data } = await sharp(b).ensureAlpha().extract({ left: REG.x0, top: REG.y0, width: RW, height: RH }).raw().toBuffer({ resolveWithObject: true });
        S.push(data);
      } catch (e) { }
    }
    const N = S.length, NP = RW * RH;
    if (!N) return null;
    // pass1 逐像素中位（粗略背景，仅供判字迹用）
    const med = new Float32Array(NP);
    for (let i = 0; i < NP; i++) {
      const v = [];
      for (const d of S) { if (d[i * 4 + 3] < 200) continue; v.push(lum(d, i)); }
      med[i] = v.length ? mid(v) : -1;
    }
    // 样本级剔除
    const usable = S.map(d => { const m = new Uint8Array(NP); for (let i = 0; i < NP; i++) m[i] = d[i * 4 + 3] < 200 ? 0 : 1; return m; });
    for (let k = 0; k < N; k++) {
      const ink = new Uint8Array(NP);
      for (let y = 0; y < RH; y++) for (let x = 0; x < RW; x++) {
        const i = y * RW + x, cx = REG.x0 + x, cy = REG.y0 + y;
        if (cx >= ICON.x0 && cx <= ICON.x1 && cy >= ICON.y0 && cy <= ICON.y1) { ink[i] = 1; continue; }
        if (med[i] >= 0 && usable[k][i] && lum(S[k], i) < med[i] - INK_REL) ink[i] = 1;
      }
      const ex = new Uint8Array(NP);
      for (let y = 0; y < RH; y++) for (let x = 0; x < RW; x++) {
        if (!ink[y * RW + x]) continue;
        for (let dy = -DILATE_SAMPLE; dy <= DILATE_SAMPLE; dy++) for (let dx = -DILATE_SAMPLE; dx <= DILATE_SAMPLE; dx++) {
          const xx = x + dx, yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= RW || yy >= RH) continue;
          ex[yy * RW + xx] = 1;
        }
      }
      for (let i = 0; i < NP; i++) if (ex[i]) usable[k][i] = 0;
    }
    // pass2 用剩余样本的中位作背景
    const plate = Buffer.alloc(NP * 4), valid = new Uint8Array(NP);
    let usableSum = 0;
    for (let i = 0; i < NP; i++) {
      const r = [], g = [], b = [];
      for (let k = 0; k < N; k++) { if (!usable[k][i]) continue; const d = S[k]; r.push(d[i * 4]); g.push(d[i * 4 + 1]); b.push(d[i * 4 + 2]); }
      if (!r.length) { plate[i * 4 + 3] = 0; continue; }
      plate[i * 4] = mid(r); plate[i * 4 + 1] = mid(g); plate[i * 4 + 2] = mid(b); plate[i * 4 + 3] = 255;
      valid[i] = 1; usableSum += r.length;
    }
    for (let y = 0; y < RH; y++) for (let x = 0; x < RW; x++) {
      const i = y * RW + x;
      if (valid[i]) continue;
      let xl = x - 1; while (xl >= 0 && !valid[y * RW + xl]) xl--;
      let xr = x + 1; while (xr < RW && !valid[y * RW + xr]) xr++;
      if (xl < 0 && xr >= RW) continue;
      if (xl < 0 || xr >= RW) { const s = (xl < 0 ? y * RW + xr : y * RW + xl) * 4; for (let c = 0; c < 3; c++) plate[i * 4 + c] = plate[s + c]; }
      else { const t = (x - xl) / (xr - xl); for (let c = 0; c < 3; c++) plate[i * 4 + c] = Math.round(plate[(y * RW + xl) * 4 + c] * (1 - t) + plate[(y * RW + xr) * 4 + c] * t); }
      plate[i * 4 + 3] = 255;
    }
    // ---- 底板行内去污 ----
    // 命名行在所有卡上都是「左对齐 + 基线对齐」，于是有些像素（典型是首字母左侧竖笔画，
    // x≈142-145、y≈150-165）在**所有**样本里都是墨迹 —— 中位学到的就不是背景而是墨迹色，
    // 「比中位暗 35」的判据自然失效，填完等于没填（实测残留一段 4px 宽的黑竖线）。
    // 修法：逐行取该行背景参考亮度（P60，墨迹占比仅 1~13%，稳落在背景），把显著暗于它的
    // 像素判为污染，用同行左右最近的干净像素线性插值重建。
    // 只在姓名行范围内做，且此时 `valid` 里的背景像素都已是干净样本。
    for (let y = NAME.y0; y <= NAME.y1; y++) {
      const ry = y - REG.y0;
      if (ry < 0 || ry >= RH) continue;
      const x1 = Math.min(NAME.x1, REG.x1);
      const ok = [];
      for (let x = NAME.x0; x <= x1; x++) { const po = (ry * RW + (x - REG.x0)) * 4; if (plate[po + 3] >= 200) ok.push(x); }
      if (ok.length < 8) continue;
      const lums = ok.map(x => { const po = (ry * RW + (x - REG.x0)) * 4; return (plate[po] + plate[po + 1] + plate[po + 2]) / 3; }).sort((a, b) => a - b);
      const bg = lums[Math.floor(lums.length * 0.6)];
      const clean = ok.filter(x => { const po = (ry * RW + (x - REG.x0)) * 4; return (plate[po] + plate[po + 1] + plate[po + 2]) / 3 >= bg - 40; });
      if (!clean.length || clean.length === ok.length) continue;
      for (let x = NAME.x0; x <= x1; x++) {
        const po = (ry * RW + (x - REG.x0)) * 4;
        if (plate[po + 3] < 200) continue;
        if ((plate[po] + plate[po + 1] + plate[po + 2]) / 3 >= bg - 40) continue;
        let l = -1, r = -1;
        for (const c of clean) { if (c < x) l = c; else if (r < 0) { r = c; break; } }
        if (l < 0) l = r; else if (r < 0) r = l;
        if (l < 0) continue;
        const lp = (ry * RW + (l - REG.x0)) * 4, rp = (ry * RW + (r - REG.x0)) * 4;
        const t = r === l ? 0 : (x - l) / (r - l);
        for (let c = 0; c < 3; c++) plate[po + c] = Math.round(plate[lp + c] * (1 - t) + plate[rp + c] * t);
      }
    }
    fs.writeFileSync(pf, plate);
    console.log('  底板[level' + lv + '] 样本 ' + N + '，平均每像素可用样本 ' + (usableSum / NP).toFixed(0));
    return plate;
  };

  const levels = ['1', '2', '3', '?'];
  const plates = {};
  console.log('建立背景底板（每个稀有度一块）…');
  for (const lv of levels) if (platePool.some(p => lvlOf(p) === lv)) plates[lv] = await buildPlate(lv);

  // ---------- 2) 剪影 ----------
  // 素材已裁到人形包围盒 → 只定「宽」，高按素材比例走（不做非等比拉伸）；
  // 底边贴住 SIL_BOT（= fut.gg 通用人像的裁剪线 = 照片区底边 442），中心对齐 SIL_CX。
  const silH = Math.round(SIL_WIDTH * silMeta.height / silMeta.width);
  const silTop = SIL_BOT - silH;
  const silScaled = await sharp(silBufFull).resize({ width: SIL_WIDTH, height: silH, kernel: 'lanczos3' }).png().toBuffer();
  const silLeft = Math.round(SIL_CX - SIL_WIDTH / 2);
  console.log('剪影 ' + SIL_WIDTH + 'x' + silH + ' @ (' + silLeft + ',' + silTop + ')，底边 ' + SIL_BOT + '，素材 ' + silMeta.width + 'x' + silMeta.height);

  // ---------- 3) 逐人生成 ----------
  // manifest / manifestPath 已在上方 Phase 0 对账阶段声明并加载（已移除已获半身像的球员）
  const inIcon = (x, y) => x >= ICON.x0 && x <= ICON.x1 && y >= ICON.y0 && y <= ICON.y1;
  const inName = (x, y) => x >= NAME.x0 && x <= NAME.x1 && y >= NAME.y0 && y <= NAME.y1;
  const ink = new Uint8Array(W * H), dil = new Uint8Array(W * H);

  async function build(p) {
    const id = String(p.eaId);
    const src = await dlCard(id);
    const sig = crypto.createHash('sha1').update(PARAMS).update(src).digest('hex').slice(0, 16);
    if (!FORCE && manifest[id] === sig) return { id, skipped: true };
    const plate = plates[lvlOf(p)];
    if (!plate) return { id, error: '无对应稀有度的底板' };
    const { data: card } = await sharp(src).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const PL = (x, y) => { const po = ((y - REG.y0) * RW + (x - REG.x0)) * 4; return (plate[po] + plate[po + 1] + plate[po + 2]) / 3; };
    ink.fill(0); dil.fill(0);
    for (let y = NAME.y0; y <= NAME.y1; y++) for (let x = NAME.x0; x <= NAME.x1; x++) {
      if (inIcon(x, y)) continue;
      const o = (y * W + x) * 4;
      // ⚠️ 轮廓外的全透明像素（RGBA 0,0,0,0）亮度算 0，会被误判成「字迹」，膨胀填色后
      // 在卡片右上角外侧留下一块底板色矩形（实测每张 786~807 px，9 张抽验一致）。
      // 照片区/图标区在卡面轮廓内，一定不透明，所以这道门槛不影响清残留。
      if (card[o + 3] < 200) continue;
      if ((card[o] + card[o + 1] + card[o + 2]) / 3 < PL(x, y) - INK_REL) ink[y * W + x] = 1;
    }
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      if (!ink[y * W + x]) continue;
      for (let dy = -DILATE_FILL; dy <= DILATE_FILL; dy++) for (let dx = -DILATE_FILL; dx <= DILATE_FILL; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
        if (inName(xx, yy) || inIcon(xx, yy)) dil[yy * W + xx] = 1;
      }
    }
    let filled = 0;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      // NAME 区**无条件整块填**（不靠亮度判定）：所有卡的姓名都是左对齐、首字母竖笔画位置
      // 完全重合，底板在那几个像素上学到的是「笔画」而不是背景 → 按亮度判定必然漏填，
      // 实测漏掉「Dixon」的 D 左侧竖笔画下半段。该区域已验证只有姓名+纯背景（有半身像的卡
      // 在同一区域没有任何暗像素），整块覆盖是安全的。
      // 左边界 141 是刻意的：OVR 两位数右边界 ≤139，140 为空隙，避免把 OVR 数字削掉一角。
      if (!inIcon(x, y) && !inName(x, y) && !dil[y * W + x]) continue;
      const o = (y * W + x) * 4, po = ((y - REG.y0) * RW + (x - REG.x0)) * 4;
      if (plate[po + 3] < 200) continue;
      if (card[o + 3] < 200) continue;   // 原图此处本就透明 → 保持透明，别把底板色渗到卡面轮廓外
      card[o] = plate[po]; card[o + 1] = plate[po + 1]; card[o + 2] = plate[po + 2]; card[o + 3] = 255; filled++;
    }
    const base = await sharp(card, { raw: { width: W, height: H, channels: 4 } }).png().toBuffer();
    const webp = await sharp(base)
      .composite([{ input: silScaled, left: silLeft, top: silTop }])
      .webp({ quality: 82, effort: 4 })
      .toBuffer();
    // 回归自检（每张跑一次，几十毫秒）：**卡面轮廓外绝不能被填成不透明**。
    // 这是最容易复发的一类缺陷 —— 历史 bug：轮廓外是 RGBA(0,0,0,0)，亮度算 0 → 被当成字迹 →
    // 膨胀填色后在卡片右上角外侧留下一块矩形底板色（每张 786~807 px，抽验 9 张全中）。
    // 注意 `card` 的 alpha 通道仍保留原图值：填充只发生在原图 alpha>=200 的像素上，
    // 所以「card alpha<50 但输出 alpha>200」= 底板色渗到轮廓外。
    let leak = 0;
    {
      const { data: out, info: oi } = await sharp(webp).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      if (oi.width === W && oi.height === H) {
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
          const i = (y * W + x) * 4;
          if (card[i + 3] < 50 && out[i + 3] > 200) leak++;
        }
      }
    }
    return { id, sig, filled, webp, leak };
  }

  console.log('开始处理 ' + target.length + ' 名无半身像球员…');
  let done = 0, skip = 0, fail = 0, bytes = 0;
  const updated = {};
  const queue = [];
  let leaks = 0, leakIds = [];
  const runOne = async p => {
    try {
      const r = await build(p);
      if (r.skipped) { skip++; return; }
      if (r.error) { fail++; console.log('  ✘ ' + r.id + ' ' + r.error); return; }
      if (r.leak) { leaks += r.leak; if (leakIds.length < 8) leakIds.push(r.id + '=' + r.leak); }
      if (!DRY) {
        fs.writeFileSync(path.join(OUT_DIR, r.id + '.webp'), r.webp);
        if (!NO_UPLOAD) await app.uploadFile({ cloudPath: 'fc' + VER + '/images/' + r.id + '_np.webp', fileContent: r.webp });
      }
      // 只在真的传上云之后才记签名 —— 否则 --no-upload 会把没上传的卡标成「已完成」，
      // 下次跑直接跳过，云上永远停在旧版本。
      if (!NO_UPLOAD) updated[r.id] = r.sig;
      done++; bytes += r.webp.length;
      if (done % 25 === 0) console.log('  已处理 ' + done + ' 张…');
    } catch (e) {
      fail++; console.log('  ✘ ' + p.eaId + ' ' + p.commonName + ' → ' + e.message);
    }
  };
  for (const p of target) {
    queue.push(runOne(p));
    if (queue.length >= CONC) await Promise.all(queue.splice(0, queue.length));
  }
  await Promise.all(queue);

  if (!DRY) {
    Object.assign(manifest, updated);
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 1));
  }
  console.log('完成：生成 ' + done + ' 张、跳过（内容未变）' + skip + ' 张、失败 ' + fail + ' 张，共 ' + (bytes / 1048576).toFixed(1) + ' MB');
  console.log('清单 → ' + path.relative(ROOT, manifestPath) + '（共 ' + Object.keys(manifest).length + ' 条）');
  if (!NO_UPLOAD && !DRY) console.log('云存储 → cloud://…/fc' + VER + '/images/{eaId}_np.webp');
  if (DRY) console.log('（--dry：没有上传、没有写清单）');
  // 回归自检汇总：必须为 0。非 0 = 底板色渗到卡面轮廓外（见 build() 里的说明）。
  if (leaks) {
    console.error('\n⚠️ 透明穿透自检未通过：' + leaks + ' 个像素（' + leakIds.join(', ') + '）');
    console.error('   说明底板色渗到了卡面轮廓外 —— 检查 build() 里两处 `alpha < 200` 门槛是否被改动，');
    console.error('   确认后必须重跑一次（加 --force）并再次确认本行显示 0，否则不要上传/提交清单。');
    process.exit(2);
  } else if (done) {
    console.log('自检：透明穿透 0 个像素 ✔');
  }
})().catch(e => { console.error(e); process.exit(1); });
