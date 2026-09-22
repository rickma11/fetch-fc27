// 球员图片的字段与命名约定（唯一来源）。
// 抓取（fetch_ci）、上传（upload_images）、小程序（utils/format.js）三处必须保持一致，
// 否则就会出现「传上去的文件名」和「小程序拼出来的路径」对不上的一类问题。
//
// 源：FC27 列表/详情接口给的是相对路径，如
//     2027/futgg-player-item-card/27-192563.<sha>.webp
//   全部挂在 game-assets.fut.gg 下（该 CDN 被 Cloudflare 挡，Node 直连 403，
//   必须在浏览器会话里下载）。
//
// 落云存储：fc27/images/<文件名>，文件名只由 eaId + 类型决定（确定性命名），
//   这样小程序端可以直接拼出 fileID，不需要查表。
const crypto = require('crypto');

const CDN = 'https://game-assets.fut.gg/';

// 图片体积控制：卡面原图是高清大图，直接下 10000 张会远超云存储免费额度。
// 走 fut.gg 自己的 Cloudflare Images 变换（站点本身就用它），压到展示需要的尺寸。
const TRANSFORM = 'cdn-cgi/image/quality=82,format=webp,width=500/';

// key      —— 内部类型名
// field    —— 接口返回的相对路径字段
// suffix   —— 云存储文件名后缀
const ALL_TYPES = [
  { key: 'portrait', field: 'imagePath', suffix: '.webp' },
  { key: 'card', field: 'cardImagePath', suffix: '_card.webp' },
  { key: 'simple', field: 'simpleCardImagePath', suffix: '_simple.webp' }
];

// ---- 全息卡官方卡面（2026-09-22 实锤）----------------------------------------
// fut.gg 同一个 eaId 有两套卡面，而且**按端点分叉**：
//   · 列表接口 cardImagePath = 2027/futgg-player-item-card/…  fut.gg 自绘「平版」（我们一直存的）
//   · 详情接口 cardImagePath = 2027/player-item-card/…        EA 官方卡面
// 只有 holographicType 非空的球员，其**官方面**才带全息光效（同一 eaId 两图渲染对照确认）。
// ⚠️ 列表接口**不给**官方面路径 → 只能从详情取，故 fetch_ci.js 在图片阶段把详情里的
//    cardImagePath 叠进临时字段 holoCardImagePath，再由本表把它下载成 {eaId}_holo.webp。
// ⚠️ 刻意**不进 ALL_TYPES**：进了会让 activeTypes()（进而 imgSigOf）对所有球员多算一段，
//    全库签名集体变化 → 触发上万张图片重下。全息路径只在真有值时追加进签名（见 imgSigOf）。
const HOLO_TYPE = { key: 'holo', field: 'holoCardImagePath', suffix: '_holo.webp' };

// ---- 稀有度小卡面（筛选弹层用）----------------------------------------
// 每档稀有度自带一张官方小卡面（rarityImagePath，如 2027/rarities-level-3-large/0.<hash>.png），
// 每档一张、全库去重后只有几~几十张。走同样的 CDN 变换压成小图（展示宽度 ≤120rpx，240 足够 2x）。
// 云存储命名：fc{ver}/images/rarity_{内容hash前16位}.webp —— ⚠️ 键必须取 imagePath 文件名里
// EA 的内容 hash（EA 换图 = 换 hash = 换文件名，旧文件成孤儿可忽略）。**绝不能用 rarityId**：
// 金/银/铜共用同一个占位「Rare」rarity 对象（id 718），按 id 命名三档会挤进同一个文件。
// 同一 hash 键函数在 云函数 get_players/index.js#rarityFileKeyOf（建 roster 映射用）与
// utils/dataLoader.js（本地样本兜底）各有一份镜像，改动必须三处同步。
const RARITY_TRANSFORM = 'cdn-cgi/image/quality=85,format=webp,width=240/';
const RARITY_SUFFIX = '.webp';

// 基础三档（铜/银/金）在筛选弹层**不展示**小卡面（用户 2026-09-18 拍板：这三档不要图，
// 其余活动稀有度才有专属小卡面）。⚠️ 同步三处：本文件 + get_players/index.js + utils/dataLoader.js。
const RARITY_BASE_TIERS = []; // 现在所有档位（含铜/银/金）都出图；置空＝不排除任何档（2026-09-18 用户要求纳入基础三档）

function rarityFileKeyOf(imagePath) {
  const base = String(imagePath || '').split('/').pop();
  const m = /\.([0-9a-f]{16,})\./i.exec(base);
  return (m ? m[1] : '').slice(0, 16);
}
function rarityFileNameOf(imagePath) { return 'rarity_' + rarityFileKeyOf(imagePath) + RARITY_SUFFIX; }
function raritySrcUrlOf(imagePath) { return CDN + RARITY_TRANSFORM + String(imagePath || ''); }
function rarityManifestPath(ver) {
  return require('path').resolve(__dirname, '..', 'cloud-data', `fc${ver || 27}`, 'rarity_images.json');
}

// 可用 FC_IMG_TYPES=portrait,card 缩小范围（simple 简约卡目前小程序未展示）
function activeTypes() {
  const raw = String(process.env.FC_IMG_TYPES || '').trim();
  if (!raw) return ALL_TYPES.slice();
  const want = raw.split(',').map(s => s.trim()).filter(Boolean);
  const picked = ALL_TYPES.filter(t => want.indexOf(t.key) >= 0);
  return picked.length ? picked : ALL_TYPES.slice();
}

function typeByKey(key) {
  return ALL_TYPES.concat([HOLO_TYPE]).find(t => t.key === key) || null;
}

// 相对路径（接口原样返回），空表示该球员没有这种图
function relPathOf(item, type) {
  const t = typeof type === 'string' ? typeByKey(type) : type;
  if (!item || !t) return '';
  const v = item[t.field];
  return v ? String(v) : '';
}

// 实际下载地址：优先走 CDN 缩放，失败时可退回原图（raw: true）
function srcUrlOf(item, type, raw) {
  const rel = relPathOf(item, type);
  if (!rel) return '';
  return raw ? (CDN + rel) : (CDN + TRANSFORM + rel);
}

function fileNameOf(eaId, type) {
  const t = typeof type === 'string' ? typeByKey(type) : type;
  return String(eaId) + (t ? t.suffix : '');
}

function cloudPathOf(fileName, ver) {
  return `fc${ver || 27}/images/${fileName}`;
}

// 图片签名：由「实际下载地址」算出。地址里含内容 hash，
// 所以 EA 换了卡面/换了尺寸参数都能被识别出来并触发重传。
// ⚠️ 全息官方面（holo）**只在真有值时**追加：否则给全库每个球员都多拼一段空值，
//    签名集体变化 → 触发上万张图片重下（完全没有必要）。非全息球员的签名逐字节不变。
function imgSigOf(item) {
  const parts = activeTypes().map(t => srcUrlOf(item, t, false) || '');
  const holo = srcUrlOf(item, HOLO_TYPE, false) || '';
  if (!parts.some(Boolean) && !holo) return '';
  const s = parts.join('|') + (holo ? '|H|' + holo : '');
  return crypto.createHash('sha1').update(s).digest('hex').slice(0, 16);
}

const MANIFEST = (ver) => require('path').resolve(__dirname, '..', 'cloud-data', `fc${ver || 27}`, 'images.json');

function readManifest(ver) {
  try {
    const j = JSON.parse(require('fs').readFileSync(MANIFEST(ver), 'utf8'));
    return (j && typeof j === 'object' && !Array.isArray(j)) ? j : {};
  } catch (e) { return {}; }
}

function writeManifest(ver, obj) {
  const p = MANIFEST(ver);
  require('fs').mkdirSync(require('path').dirname(p), { recursive: true });
  // 按 eaId 数值排序，保证 diff 稳定、不因抓取顺序产生噪音
  const out = {};
  Object.keys(obj).map(Number).filter(n => !isNaN(n)).sort((a, b) => a - b)
    .forEach(n => { out[n] = obj[n]; });
  require('fs').writeFileSync(p, JSON.stringify(out));
  return out;
}

module.exports = {
  CDN, TRANSFORM, ALL_TYPES, HOLO_TYPE,
  RARITY_TRANSFORM, RARITY_BASE_TIERS, rarityFileKeyOf, rarityFileNameOf, raritySrcUrlOf, rarityManifestPath,
  activeTypes, typeByKey, relPathOf, srcUrlOf, fileNameOf, cloudPathOf,
  imgSigOf, readManifest, writeManifest
};
