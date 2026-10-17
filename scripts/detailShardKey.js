// 详情分层静态分片键计算（P1 分层方案，docs/35，2026-10-16）。
//
// ⚠️ 单一真源：端上 utils/cloudJson.js 与 fetch-fc27/scripts/gen_static_details.js 都 require 本文件，
//    保证「端上 shardKey」与「生成器分桶键」逐字一致——一旦不一致，端上算出的 key 在 manifest 里找不到分片，
//    会全部落回云函数（功能不丢，但优化失效）。改这里必须同步验证两端。
//
// 纯函数，无任何 wx / 云依赖，可被 node 直接 require 做单测。
//
// 入参：
//   p      = { overall, leagueEaId, nationEaId }（端上从 roster 解析；生成器从 details_fc 文档读）
//   big5   = 五大联赛 eaId 数组（端与生成器都用 manifest.big5Leagues 或解析出的名单，必须同源）
//   hot    = 热门国家 eaId 数组
// 返回：分片键字符串（2026-10-17 起全覆盖，不再有长尾——见 §14）

function band74(r) { r = Number(r) || 0; return r >= 70 ? '70' : (r >= 65 ? '65' : '64'); }

function shardKeyOf(p, big5, hot) {
  const r = Number(p.overall) || 0;
  const lg = Number(p.leagueEaId) || 0;
  const nt = Number(p.nationEaId) || 0;
  const b5 = big5 || [];
  const ht = hot || [];
  if (r >= 85) return 'r85';
  if (r >= 80) {
    if (b5.indexOf(lg) >= 0 || ht.indexOf(nt) >= 0) return 'r80_84_scope';
    return 'r' + r;                       // 80-84 非五大 → 并入 75-79 按 rating 切片
  }
  if (r >= 75) return 'r' + r;           // 75-79
  if (b5.indexOf(lg) >= 0) return 'lg_' + lg + '_r74_' + band74(r);
  if (ht.indexOf(nt) >= 0) return 'nat_' + nt + '_r74_' + band74(r);
  // 2026-10-17 全覆盖（docs/35 §14）：≤74 非五大/非热门按 rating 单分桶 tail_r{r}。
  // 实测长尾 8212 人 × ~4.4KB ≈ 36MB，每 rating 桶 0.9-2.8MB → SPLIT_LIMIT 自动拆 1-3 part，
  // 端上「按 key 取 entries 逐 part 查」直接复用，云函数只剩「当日新入库球员」兜底。
  return 'tail_r' + r;
}

module.exports = { band74: band74, shardKeyOf: shardKeyOf };
