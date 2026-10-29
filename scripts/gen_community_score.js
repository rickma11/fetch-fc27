// gen_community_score.js — 方案B（2026-10-30）：聚合小程序端上信号 → 好评融合用的「热度分位 h」
//
// 用途：社区好评率原本 100% 取 fut.gg，样本极稀疏（常见「67% / 共 3 名参与」）。方案B＝
//   基底仍是 FUTGG，另按 α（上限 0.3、随 FUTGG 票数衰减）混入小程序自有信号。
//   本脚本负责把端上信号加工成**档位内分位 h(0~1)**，供端上 utils/communityScore.js 融合。
//
// 信号来源（云库）：
//   · 打开次数：hot_fc{ver}.views（累计总浏览，utils/hot.js#recordView 已有，零新增埋点）
//      ⚠️ 只取近 7 天活跃（lastViewAt 过滤）以控制 DB 读量；views 本身是累计值。
//   · 分享次数：eng_fc{ver}.shares（2026-10-30 新增，云函数 player_hot#shareBatch 写入；
//      口径②＝分享面板被触发即 +1，含取消）
//
// 归一化（关键，防「热门≠好评」）：
//   · 球员按 overall 分档（<80 / 80-84 / 85-89 / 90+），**档位内**做位置分位，
//     避免高 overall 卡天然高浏览被误读成好评。
//   · SBC 无分档依据，做全局分位（且目前只有分享信号，见下）。
//   · h = 0.6·pct(打开) + 0.4·pct(分享)；缺任一信号则只用有的那个；都没有则不产出该条
//     （端上取不到 h ⇒ 完全沿用原 FUTGG 数值，安全降级）。
//
// ⚠️ SBC 侧目前**没有**详情页打开次数统计（hot_fc 只记球员 eaId），故 SBC 的 h 暂时只来自分享。
//    如需补 SBC 浏览信号，要另加端上埋点 + 云函数分支（本次未做，Ponytail：先跑通主链路）。
//
// 用法：node scripts/gen_community_score.js [ver] [--no-upload]
const { initCloud, publishObject } = require('./gen_static_lists.js');

const VER = (process.argv[2] && /^\d+$/.test(process.argv[2])) ? process.argv[2] : '27';
const WINDOW_DAYS = 7;
const PAGE = 500;

// 球员档位：按 overall 分档（档位内分位，消除「能力值高=被看得多」的偏差）
function bucketOf(overall) {
  const o = Number(overall) || 0;
  if (o >= 90) return '90+';
  if (o >= 85) return '85-89';
  if (o >= 80) return '80-84';
  return '<80';
}

// 位置分位：最小 0 / 最大 1；单样本给 0.5（避免「唯一样本=满分」）
function percentileRanks(rows) {
  const map = {};
  const sorted = rows.slice().sort(function (a, b) { return a.v - b.v; });
  const n = sorted.length;
  if (!n) return map;
  if (n === 1) { map[sorted[0].id] = 0.5; return map; }
  sorted.forEach(function (x, i) { map[x.id] = i / (n - 1); });
  return map;
}

async function fetchAllDocs(db, col, filter) {
  const out = [];
  let skip = 0;
  for (;;) {
    let q = db.collection(col);
    if (filter) q = q.where(filter);
    let arr = [];
    try {
      const r = await q.skip(skip).limit(PAGE).get();
      arr = r.data || [];
    } catch (e) {
      // 集合不存在（如 eng_fc 尚未创建）不算失败，当作空
      return out;
    }
    out.push.apply(out, arr);
    if (arr.length < PAGE) break;
    skip += PAGE;
    if (skip > 200000) break;      // 硬保险
  }
  return out;
}

async function main() {
  const app = initCloud();
  const db = app.database();
  const _ = db.command;
  const since = Date.now() - WINDOW_DAYS * 24 * 3600 * 1000;

  // ① 打开次数（球员）
  const hotRows = await fetchAllDocs(db, 'hot_fc' + VER, { lastViewAt: _.gte(since) });
  const views = {};
  hotRows.forEach(function (d) {
    const v = Number(d.views) || 0;
    if (v > 0) views[String(d._id)] = v;
  });

  // ② 分享次数（球员 + SBC）
  const engRows = await fetchAllDocs(db, 'eng_fc' + VER, null);
  const sharesP = {}, sharesS = {};
  engRows.forEach(function (d) {
    const n = Number(d.shares) || 0;
    if (n <= 0) return;
    const ref = String(d.refId != null ? d.refId : String(d._id).slice(2));
    if (d.kind === 'sbc') sharesS[ref] = n;
    else sharesP[ref] = n;
  });

  // ③ 球员档位需要 overall：按需批查（_.in 20/批），只查有信号的 id，控制 DB 读量
  const pIds = Array.from(new Set(Object.keys(views).concat(Object.keys(sharesP))));
  const overall = {};
  for (let i = 0; i < pIds.length; i += 20) {
    const batch = pIds.slice(i, i + 20);
    try {
      const r = await db.collection('players_fc' + VER).where({ _id: _.in(batch) }).limit(20).get();
      (r.data || []).forEach(function (p) { overall[String(p._id)] = Number(p.overall) || 0; });
    } catch (e) { /* 查不到就按 <80 档兜底 */ }
  }

  // ④ 球员：档位内分位 → 合成 h
  const buckets = {};
  pIds.forEach(function (id) {
    const b = bucketOf(overall[id]);
    (buckets[b] = buckets[b] || []).push(id);
  });
  const pctV = {}, pctS = {};
  Object.keys(buckets).forEach(function (b) {
    const list = buckets[b];
    const vr = list.filter(function (id) { return views[id] > 0; })
      .map(function (id) { return { id: id, v: views[id] }; });
    const sr = list.filter(function (id) { return sharesP[id] > 0; })
      .map(function (id) { return { id: id, v: sharesP[id] }; });
    Object.assign(pctV, percentileRanks(vr));
    Object.assign(pctS, percentileRanks(sr));
  });
  const players = {};
  pIds.forEach(function (id) {
    const pv = pctV[id], ps = pctS[id];
    let h = null;
    if (pv != null && ps != null) h = 0.6 * pv + 0.4 * ps;
    else if (pv != null) h = pv;
    else if (ps != null) h = ps;
    if (h != null) players[id] = Math.round(h * 1000) / 1000;
  });

  // ⑤ SBC：全局分位（目前只有分享信号）
  const sIds = Array.from(new Set(Object.keys(sharesS)));
  const sPct = percentileRanks(sIds.map(function (id) { return { id: id, v: sharesS[id] }; }));
  const sbcs = {};
  sIds.forEach(function (id) {
    if (sPct[id] != null) sbcs[id] = Math.round(sPct[id] * 1000) / 1000;
  });

  const obj = { v: 1, ts: Date.now(), players: players, sbcs: sbcs };
  console.log('[community_score] 活跃球员=' + hotRows.length +
    ' 有分享文档=' + engRows.length +
    ' → players=' + Object.keys(players).length + ' sbcs=' + Object.keys(sbcs).length);
  await publishObject(app, 'community_score', obj);
  console.log('[community_score] 完成');
}

main().catch(function (e) {
  console.error('[community_score] 失败:', e && e.message);
  process.exit(1);
});
