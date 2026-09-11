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

// 可用 FC_IMG_TYPES=portrait,card 缩小范围（simple 简约卡目前小程序未展示）
function activeTypes() {
  const raw = String(process.env.FC_IMG_TYPES || '').trim();
  if (!raw) return ALL_TYPES.slice();
  const want = raw.split(',').map(s => s.trim()).filter(Boolean);
  const picked = ALL_TYPES.filter(t => want.indexOf(t.key) >= 0);
  return picked.length ? picked : ALL_TYPES.slice();
}

function typeByKey(key) {
  return ALL_TYPES.find(t => t.key === key) || null;
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
function imgSigOf(item) {
  const parts = activeTypes().map(t => srcUrlOf(item, t, false) || '');
  if (!parts.some(Boolean)) return '';
  return crypto.createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 16);
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
  CDN, TRANSFORM, ALL_TYPES,
  activeTypes, typeByKey, relPathOf, srcUrlOf, fileNameOf, cloudPathOf,
  imgSigOf, readManifest, writeManifest
};
