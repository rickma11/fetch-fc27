'use strict';
// SBC 积分兑换(sbcCost)反查映射：纯函数，供 upload_sbcs.js 回写段与单测共用（2026-09-23 抽出）。
//
// 两条来源路径：
//   ① set.awards[].playerEaId（单人 SBC，如 Bouaddi 5257，awards 内嵌完整球员）——原逻辑；
//   ② set.choicePlayers（Player Pick 类，awards 只有 other 文案、playerEaId=null，
//      候选球员由 enrich_sbc_pools.js 抓 fut.gg pool 页回填，如 Duo Pick 5258）——2026-09-23 补。
//      缺此路径时 pick 候选球员（如 Pedro Gonçalves 50572598 / Rodrigo Mora 50404645）永远
//      拿不到 sbcCost → 详情页「SBC兑换」整行不渲染（SBC积分/SBC兑换胶囊不受影响）。
//
// 同一球员命中多个 SBC：后写覆盖 + 冲突记录（与 2026-09-20 原逻辑一致）。
// 注意：choicePlayers 只取候选球员的特殊卡 eaId 回写，baseEaId（同名基础卡）不回写——
//   Player Pick 奖励的是 choicePlayers 里的特殊卡本身，基础卡不是被该 SBC 奖励的卡，
//   在基础卡详情挂 sbcCost 会误导（玩家以为用积分换的是基础卡）。

function addCost(map, dup, eaId, val) {
  const id = Number(eaId);
  if (!id || !isFinite(id)) return;
  if (map[id] != null && map[id] !== val) dup.push(id);
  map[id] = val;
}

function buildSbcCostMap(sets) {
  const map = {};   // eaId(number) -> scoreRequirement(number)
  const dup = [];
  (sets || []).forEach(function (s) {
    const req = Number(s && s.scoreRequirement) || 0;
    if (!req) return;                       // 仅 streamlined SBC 有积分兑换
    const ea = ((s.awards || []).map(function (a) {
      return a && a.playerEaId != null ? Number(a.playerEaId) : null;
    }).filter(function (x) { return x != null; }))[0];
    if (ea != null) { addCost(map, dup, ea, req); return; }
    // Player Pick 类：awards 无 playerEaId → 仅候选特殊卡 eaId 回写（不含 baseEaId 基础卡）
    if (Array.isArray(s.choicePlayers)) {
      s.choicePlayers.forEach(function (c) {
        if (c && c.eaId != null) addCost(map, dup, c.eaId, req);
      });
    }
  });
  return { map: map, dup: dup };
}

module.exports = { buildSbcCostMap: buildSbcCostMap };
