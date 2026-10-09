// positionsFutgg.js —— fut.gg 位置 ID ↔ 缩写 桥。
//
// 真源：eafc-miniapp/tools/tactics-re/capture/futgg_ref.json#positionData
// （fut.gg 28 个位置，每个元素 {uniqueId, typeId, uniqueName, typeName}）。
//
// 为什么需要它：进化 requirements.positions / excludedPositions 用的是 fut.gg 位置
// **uniqueId**（如 CM=14 / CDM=10 / ST=25）；而云库 players_fc27 里：
//   - position 是字符串缩写（"ST" / "CM" …）
//   - alternativePositionIds 是 uniqueId 数组（如 ST 球员 = [16,18,27] = LM/CAM/LW）
// 两处必须归一到同一空间（uniqueId）才能比对。本文件就是那个桥。
//
// 注意（2026-10-09）：chemEngine.js 的 POS_NAME_TO_ID 只覆盖 12 个通用位置且 GK 误标 1；
// format.js#POS_ID 同样不全。这里的 28 位置表是完整真源，GK=0 为准（已与真实
// 云库数据交叉验证：position="ST" 的 alternativePositionIds=[16,18,27] 与 uniqueId 体系吻合）。

// uniqueId → 缩写（28 全量）
const POS_UNIQUE_TO_NAME = {
  0: 'GK', 1: 'SW', 2: 'RWB', 3: 'RB', 4: 'RCB', 5: 'CB', 6: 'LCB', 7: 'LB', 8: 'LWB',
  9: 'RDM', 10: 'CDM', 11: 'LDM', 12: 'RM', 13: 'RCM', 14: 'CM', 15: 'LCM', 16: 'LM',
  17: 'RAM', 18: 'CAM', 19: 'LAM', 20: 'RF', 21: 'CF', 22: 'LF', 23: 'RW', 24: 'RS',
  25: 'ST', 26: 'LS', 27: 'LW'
};

// 缩写 → uniqueId（与上面严格互逆）
const POS_NAME_TO_UNIQUE = {};
Object.keys(POS_UNIQUE_TO_NAME).forEach(function (k) { POS_NAME_TO_UNIQUE[POS_UNIQUE_TO_NAME[k]] = Number(k); });

// typeId → 同类型所有 uniqueId（fut.gg 把 CF/RS/LS 等细分位置归到同一 type 下；
// 名册里这些球员的主位置码统一是 ST/RW/LW/CAM/CM/CDM/CB/RB/LB/RWB/LWB 的「主码」，
// 故主位置码要按 type 展开，才能正确命中限定细分位置的进化）。
// 数据来自 futgg_ref.json#positionData 的 (uniqueId, typeId) 聚类。
const TYPE_TO_UNIQUE = {
  0: [0], 1: [1], 2: [2], 3: [3],
  5: [4, 5, 6],            // CB / RCB / LCB
  7: [7], 8: [8],
  10: [9, 10, 11],         // CDM / RDM / LDM
  12: [12],                // RM
  14: [13, 14, 15],        // CM / RCM / LCM
  16: [16],                // LM
  18: [17, 18, 19],        // CAM / RAM / LAM
  21: [20, 21, 22],        // CF / RF / LF
  23: [23],                // RW
  25: [24, 25, 26],        // ST / RS / LS
  27: [27]                 // LW
};

// 玩家主位置缩写 → 同 type 的所有 uniqueId（用于位置匹配展开）
function mainPosToUniqueIds(code) {
  if (code == null || code === '') return [];
  const uid = (typeof code === 'number') ? code : POS_NAME_TO_UNIQUE[String(code).toUpperCase()];
  if (uid == null) return [];
  // 找该 uid 所属的 typeId → 展开
  for (const t in TYPE_TO_UNIQUE) {
    if (TYPE_TO_UNIQUE[t].indexOf(uid) >= 0) return TYPE_TO_UNIQUE[t].slice();
  }
  return [uid];
}

// 玩家「能踢的位置」集合（uniqueId 数组）：主位置（按 type 展开） + 备选位置 ID。
// 备选位置 ID 已是精确 uniqueId，不再展开（它们是球员确切能踢的位置）。
function playerPositionIds(player) {
  const ids = [];
  const mainIds = mainPosToUniqueIds(player && player.position);
  for (let i = 0; i < mainIds.length; i++) ids.push(mainIds[i]);
  const alts = (player && Array.isArray(player.alternativePositionIds)) ? player.alternativePositionIds : [];
  for (let i = 0; i < alts.length; i++) {
    const a = alts[i];
    if (typeof a === 'number') ids.push(a);
  }
  return ids;
}

// uniqueId → 缩写（未知 → 原样字符串，便于告警/展示）
function posName(id) {
  return POS_UNIQUE_TO_NAME[id] != null ? POS_UNIQUE_TO_NAME[id] : String(id);
}

module.exports = {
  POS_UNIQUE_TO_NAME: POS_UNIQUE_TO_NAME,
  POS_NAME_TO_UNIQUE: POS_NAME_TO_UNIQUE,
  TYPE_TO_UNIQUE: TYPE_TO_UNIQUE,
  mainPosToUniqueIds: mainPosToUniqueIds,
  playerPositionIds: playerPositionIds,
  posName: posName
};
