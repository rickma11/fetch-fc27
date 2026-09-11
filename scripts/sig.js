// 列表项「内容签名」——增量抓取的核心。
//
// 原理：fut.gg 列表接口每一条已经包含约 30 个字段（overall / 六维 faceStats /
// 化学角色 / playstyles / 联赛·俱乐部·国家·稀有度 / 图片路径 / createdAt 等），
// 详情接口唯一不可替代的产出只有 34 项 attributes。而 34 项 attributes 一旦变化，
// 必然反映到 faceStats 上（faceStats 就是 attributes 的聚合结果）。
// 因此：只要下面的字段有任何变化，就判定「这张卡变了」，需要重抓详情。
//
// 本模块被 fetch_ci.js（浏览器内）与 fetch_futgg.js（Node 成型）共同使用，
// 保证两侧算出的签名逐字节一致。

function h32(str, seed) {
  var h = seed >>> 0;
  for (var i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0; // FNV-1a
  }
  return h >>> 0;
}

function pad8(n) {
  var s = (n >>> 0).toString(16);
  while (s.length < 8) s = '0' + s;
  return s;
}

function joinIds(arr) {
  if (!arr || !arr.length) return '';
  return arr.slice().sort().join('.');
}

var FACE_KEYS = ['pace', 'shooting', 'passing', 'dribbling', 'defending', 'physicality'];

// 六维字段在不同版本/不同接口里出现过三种形态，这里统一归一化成
// { pace, shooting, passing, dribbling, defending, physicality }：
//   ① FC26 列表：faceStats = { pace, shooting, passing, dribbling, defending, physicality }
//   ② FC27 列表：faceStatsV2 = { facePace, faceShooting, ... }（扁平，最省事）
//   ③ FC27 列表：faceStats = [{ defKey: 'facePace', rating: 88 }, ...]（对象数组）
// 早期只认 ①，导致 FC27 全量 10000 条六维被写成 0（且签名里也全是空，变化检测失效）。
function normFaceStats(it) {
  var zero = { pace: 0, shooting: 0, passing: 0, dribbling: 0, defending: 0, physicality: 0 };
  if (!it) return zero;
  var i, k;

  var v2 = it.faceStatsV2;
  if (v2 && typeof v2 === 'object' && !Array.isArray(v2)) {
    var out = {};
    for (i = 0; i < FACE_KEYS.length; i++) {
      k = FACE_KEYS[i];
      out[k] = Number(v2['face' + k.charAt(0).toUpperCase() + k.slice(1)]) || 0;
    }
    if (FACE_KEYS.some(function (x) { return out[x]; })) return out;
  }

  var f = it.faceStats;
  if (Array.isArray(f)) {
    var arr = { pace: 0, shooting: 0, passing: 0, dribbling: 0, defending: 0, physicality: 0 };
    for (i = 0; i < f.length; i++) {
      var row = f[i];
      if (!row) continue;
      var key = row.defKey || String(row.identifier || '').replace(/^face_/, '');
      key = String(key).replace(/^face/, '');
      key = key.charAt(0).toLowerCase() + key.slice(1);
      if (arr[key] === undefined) continue;
      arr[key] = Number(row.rating != null ? row.rating : row.value) || 0;
    }
    if (FACE_KEYS.some(function (x) { return arr[x]; })) return arr;
  }

  if (f && typeof f === 'object' && !Array.isArray(f)) {
    var obj = {};
    for (i = 0; i < FACE_KEYS.length; i++) {
      k = FACE_KEYS[i];
      obj[k] = Number(f[k]) || 0;
    }
    if (FACE_KEYS.some(function (x) { return obj[x]; })) return obj;
  }
  return zero;
}

// 稀有度同样是两种形态：FC26 为嵌套对象 item.rarity.{name}，FC27 为扁平 item.rarityName。
function rarityNameOf(it) {
  if (!it) return '';
  if (it.rarity && it.rarity.name) return String(it.rarity.name);
  if (it.rarityName) return String(it.rarityName);
  return '';
}

function normRarity(it) {
  if (!it) return null;
  if (it.rarity && typeof it.rarity === 'object' && !Array.isArray(it.rarity)) return it.rarity;
  if (it.rarityName) {
    return {
      name: it.rarityName,
      id: it.rarityId != null ? it.rarityId : null,
      eaId: it.rarityEaId != null ? it.rarityEaId : null,
      imagePath: it.rarityImagePath || ''
    };
  }
  return null;
}

// 把参与签名的字段拼成规范化字符串（顺序固定、缺失值统一为空）
function sigSource(it) {
  var f = normFaceStats(it);
  return [
    it.overall,
    it.position,
    it.skillMoves,
    it.weakFoot,
    it.accelerateType,
    it.height,
    it.weight,
    it.foot,
    it.bodytypeCode,
    it.isRealFace,
    it.shirtNumber,
    rarityNameOf(it),
    it.club && it.club.name,
    it.league && it.league.name,
    it.nation && it.nation.name,
    f.pace, f.shooting, f.passing, f.dribbling, f.defending, f.physicality,
    joinIds(it.playStyleEaIds),
    joinIds(it.playStylePlusEaIds),
    joinIds(it.chemistryRolesPlusEaIds),
    joinIds(it.chemistryRolesPlusPlusEaIds),
    joinIds(it.alternativePositionIds),
    it.cardImagePath,
    it.createdAt
  ].map(function (x) { return x === undefined || x === null ? '' : String(x); }).join('|');
}

// 64 位（双 32 位拼接）→ 16 个十六进制字符。10000 条量级下碰撞概率可忽略。
function sigOfRaw(it) {
  var s = sigSource(it);
  return pad8(h32(s, 2166136261)) + pad8(h32(s, 2246822507));
}

// 对比「上次快照」与「本次签名」，归类出需要处理的对象。
// snap 为空（首次运行 / 快照丢失）时返回全量，交由调用方降级为 full。
function diffSigs(snap, sigs) {
  const newIds = [], changedIds = [], removedIds = [];
  const cur = Object.keys(sigs);
  if (!snap || !Object.keys(snap).length) {
    return { newIds: cur, changedIds: changedIds, removedIds: removedIds, fullFallback: true };
  }
  for (let i = 0; i < cur.length; i++) {
    const id = cur[i];
    if (!(id in snap)) newIds.push(id);
    else if (snap[id] !== sigs[id]) changedIds.push(id);
  }
  const curSet = new Set(cur);
  const oldIds = Object.keys(snap);
  for (let i = 0; i < oldIds.length; i++) {
    if (!curSet.has(oldIds[i])) removedIds.push(oldIds[i]);
  }
  return { newIds: newIds, changedIds: changedIds, removedIds: removedIds, fullFallback: false };
}

module.exports = {
  sigOfRaw: sigOfRaw,
  sigSource: sigSource,
  diffSigs: diffSigs,
  normFaceStats: normFaceStats,
  rarityNameOf: rarityNameOf,
  normRarity: normRarity
};
