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

// 把参与签名的字段拼成规范化字符串（顺序固定、缺失值统一为空）
function sigSource(it) {
  var f = (it && it.faceStats) || {};
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
    it.rarity && it.rarity.name,
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

module.exports = { sigOfRaw: sigOfRaw, sigSource: sigSource, diffSigs: diffSigs };
