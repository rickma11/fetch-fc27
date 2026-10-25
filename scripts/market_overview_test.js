// buildOverview 离线覆盖（node scripts/market_overview_test.js，纯函数无 IO）
// 场景：分类映射 / 切法 B 边界（85 归中档、90 归 90+）/ 中位价指数 / 简单平均涨跌+持平阈值 /
//       vol5 / 14 日窗口振幅 / 高价两档 / 空分类隐藏 / 未归类 rarity / dayKey 对不上（积累中）
// 方案：docs/37-market-overview-design.md（用户 10-25 拍板：切法 B / 14 日 / 高价两档）。
'use strict';
const core = require('./market_core.js');

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.error('  ✗ FAIL: ' + msg); }
}
function eq(a, b, msg) { ok(JSON.stringify(a) === JSON.stringify(b), msg + ' | 期望 ' + JSON.stringify(b) + ' 实得 ' + JSON.stringify(a)); }

// ── 测试数据：3 天 × 16 张卡（覆盖 9 分类全部分支 + 1 张未归类）──
// daily 契约：days 按下标对齐；players[eaId][pf][day] = [avg,min,max] | null
const DAYS = ['20261023', '20261024', '20261025'];
function cell(avg, min, max) { return [avg, min, max]; }
function seriesOf(v0, v1, v2) { return [v0, v1, v2]; }   // 三个总评…（占位不用）
function mkDaily(spec) {
  // spec: { eaId: { pc:[[avg,min,max]×3|null], ps:[...] } }
  const players = {};
  Object.keys(spec).forEach(function (eaId) {
    players[eaId] = {
      pc: spec[eaId].pc || [null, null, null],
      ps: spec[eaId].ps || [null, null, null]
    };
  });
  return { v: 1, ts: 1750000000000, days: DAYS.slice(), players: players };
}
// 每卡：(eaId, rarity, overall, tier.pc, tier.ps, daily.pc, daily.ps)
const CARDS = [
  // [eaId, rarity, overall, pc, ps, dailyPc, dailyPs]
  ['101', 'Gold', 82, 300, null, seriesOf(cell(100, 90, 110), cell(200, 190, 210), cell(300, 290, 310))],            // 金80-84 +50%
  ['102', 'Gold', 85, 1003, null, seriesOf(cell(1000, 900, 1100), cell(1000, 900, 1100), cell(1003, 900, 1100))],   // 金85-92 +0.3% 持平
  ['103', 'Gold', 85, 940, null, seriesOf(cell(1000, 900, 1100), cell(1000, 900, 1100), cell(940, 900, 1100))],     // 金85-92 -6% 跌+波动
  ['104', 'Gold', 84, 100, null, seriesOf(cell(100, 90, 110), null, cell(100, 90, 110))],                           // 金80-84 昨日 null → 无对比
  ['105', 'Base Icon', 90, 700, null, seriesOf(cell(500, 400, 600), cell(600, 500, 700), cell(700, 600, 800))],    // 传奇 +16.7%
  ['106', 'Base Hero', 88, 200, 550000, seriesOf(cell(200, 100, 300), cell(200, 100, 300), cell(200, 100, 300)),
    seriesOf(cell(550000, 500000, 600000), cell(550000, 500000, 600000), cell(550000, 500000, 600000))],             // 英雄 0%（唯一有 ps 日聚合的卡）
  ['107', 'Team of the week', 85, 330, null, seriesOf(cell(300, 200, 400), cell(300, 200, 400), cell(330, 200, 400))], // 周黑 85 → 切法 B 归 85+
  ['108', 'Team of the week', 84, 100, null, seriesOf(cell(100, 50, 150), cell(100, 50, 150), cell(100, 50, 150))],     // 周黑 80-84 0%
  ['109', 'Future Stars', 85, 60, null, seriesOf(cell(50, 40, 60), cell(50, 40, 60), cell(60, 50, 70))],            // 活动卡 85 → 切法 B 归 85-89（不是 80-84）
  ['110', 'Star Performer', 90, 9, null, seriesOf(cell(10, 5, 15), cell(10, 5, 15), cell(9, 5, 15))],              // 活动卡 90 → 切法 B 归 90+（不是 85-89）
  ['111', 'Ultimate Scream', 91, 20, null, seriesOf(cell(20, 10, 30), cell(20, 10, 30), cell(20, 10, 30))],        // 活动卡 91 → 90+
  ['112', 'Gold', 93, 30, null, seriesOf(cell(30, 20, 40), cell(30, 20, 40), cell(30, 20, 40))],              // 金 93 超出 85-92 → 未归类（漂移监测）
  ['113', 'Gold', 91, 40, null, seriesOf(cell(40, 30, 50), cell(40, 30, 50), cell(40, 30, 50))],                    // 金 91（85-92 区间内）
  ['114', 'Future Stars', 89, 70, null, seriesOf(cell(70, 60, 80), cell(70, 60, 80), cell(70, 60, 80))],            // 活动卡 89 → 85-89 上边界
  ['115', 'Gold', 90, 600000, 400000, seriesOf(cell(600000, 500000, 700000), cell(600000, 500000, 700000), cell(600000, 500000, 700000))], // ≥50万 档
  ['116', 'Gold', 92, 1200000, 900000, seriesOf(cell(1200000, 1000000, 1400000), cell(1200000, 1000000, 1400000), cell(1200000, 1000000, 1400000))] // ≥50万+≥100万 档
];
const spec = {};
const tier = CARDS.map(function (c) {
  spec[c[0]] = { pc: c[5], ps: c[6] };
  return { eaId: Number(c[0]), name: 'P' + c[0], overall: c[2], pos: 'ST', pc: c[3], ps: c[4], img: '', rarity: c[1] };
});
const daily = mkDaily(spec);
const built = { view: { tier: tier } };

// ── 场景 1：分类映射 + 切法 B 边界 ──
console.log('\n[1] 分类映射：9 档计数、切法 B 边界、未归类');
{
  const ov = core.buildOverview(daily, built, '20261025');
  eq(ov.cats.map(function (c) { return c.key + ':' + c.cards; }), [
    'gold_80_84:2', 'gold_85_92:5', 'icon:1', 'hero:1',
    'promo_80_84:0', 'promo_85_89:2', 'promo_90p:2', 'totw_80_84:1', 'totw_85p:1'
  ], '9 档卡数（promo_80_84 空；107 周黑85→85+、109 活动85→85-89、110 活动90→90+）');
  ok(ov.unCat === 1, '未归类卡数=1（金 93 超出 85-92 区间）');
  ok(ov.today.pc.all.cards === 16, '全市场卡数=16（含未归类）');
  eq(ov.days, DAYS, 'days 原样透传');
  ok(ov.v === 1 && typeof ov.ts === 'number', 'v=1 且 ts 为数字');
  // 空分类：指数与 today.cats 都不出（端上隐藏）
  ok(ov.index.pc.promo_80_84 === undefined, '空分类 promo_80_84 无指数');
  ok(ov.today.pc.cats.promo_80_84 === undefined, '空分类 promo_80_84 无当日统计');
  ok(Object.keys(ov.today.pc.cats).length === 8, 'today.pc.cats 仅 8 个非空分类');
}

// ── 场景 2：中位价指数（含偶数取均值、null 跳过、四舍五入）──
console.log('\n[2] 指数：分类当日中位价序列');
{
  const ov = core.buildOverview(daily, built, '20261025');
  eq(ov.index.pc.all, [100, 200, 150], '全市场中位价（day1 仅 15 值取中位 200）');
  eq(ov.index.pc.gold_80_84, [100, 200, 200], '金80-84：day1 仅 101 有值=200，day2 偶数均值');
  eq(ov.index.pc.gold_85_92, [1000, 1000, 1003], '金85-92 中位（高价不扭曲）');
  eq(ov.index.pc.icon, [500, 600, 700], '传奇中位');
  eq(ov.index.pc.promo_85_89, [60, 60, 65], '活动85-89 中位');
  eq(ov.index.pc.promo_90p, [15, 15, 15], '活动90+ 中位（14.5 → round 15）');
  eq(ov.index.pc.totw_85p, [300, 300, 330], '周黑85+ 中位');
  eq(ov.index.ps.all, [550000, 550000, 550000], 'ps 全市场（仅英雄卡有 ps 日聚合）');
  eq(ov.index.ps.hero, [550000, 550000, 550000], 'ps 英雄中位');
  eq(ov.index.ps.gold_85_92, [null, null, null], 'ps 无数据分类 → 全 null 数组（长度对齐）');
  ok(ov.index.ps.all.length === 3, '指数长度与 days 对齐');
}

// ── 场景 3：当日涨跌统计（简单平均 / 持平 0.5% / vol5 / cmp 语义）──
console.log('\n[3] 当日统计：涨跌分布、平均涨跌、波动卡数');
{
  const ov = core.buildOverview(daily, built, '20261025');
  const a = ov.today.pc.all;
  ok(a.cards === 16 && a.cmp === 15, 'cards=16，可比=15（104 昨日 null 排除）');
  eq([a.up, a.hold, a.down], [4, 9, 2], '涨4/持9/跌2（三项和=cmp）');
  ok(a.up + a.hold + a.down === a.cmp, '涨持跌之和 = cmp');
  ok(a.avgChg === 5.4, '全市场平均涨跌 +5.4%（简单平均）');
  ok(a.vol5 === 6, '波动≥5% 卡数=6（50/6/16.7/10/20/10）');
  eq([ov.today.pc.cats.gold_80_84.cmp, ov.today.pc.cats.gold_80_84.avgChg], [1, 50], '金80-84：仅 101 可比 +50%');
  ok(ov.today.pc.cats.gold_85_92.avgChg === -1.1, '金85-92 平均涨跌 -1.1%（0.3 与 -6 平均）');
  ok(ov.today.pc.cats.icon.avgChg === 16.7, '传奇 +16.7%');
  ok(ov.today.pc.cats.promo_85_89.avgChg === 10, '活动85-89 +10%');
  ok(ov.today.pc.cats.promo_90p.avgChg === -5, '活动90+ -5%');
  ok(ov.today.pc.cats.totw_85p.avgChg === 10, '周黑85+ +10%');
  // ps 视图：仅英雄卡有 ps 日聚合
  ok(ov.today.ps.all.cmp === 1 && ov.today.ps.all.avgChg === 0, 'ps 全市场：仅 106 可比 0%');
}

// ── 场景 4：振幅（窗口内 (max-min)/均值 的均值；需 ≥2 有效日）──
console.log('\n[4] 振幅：14 日窗口口径');
{
  const ov = core.buildOverview(daily, built, '20261025');
  ok(ov.today.pc.all.ampN === 16, '振幅参与卡数=16（全部有 ≥2 有效日）');
  ok(ov.today.pc.all.amp === 11.2, '全市场平均振幅 11.2%');
  ok(ov.today.pc.cats.gold_80_84.amp === 50, '金80-84 振幅 50%（100 与 0 平均）');
  ok(ov.today.pc.cats.icon.amp === 33.3, '传奇振幅 33.3%');
  ok(ov.today.pc.cats.promo_90p.amp === 5.2, '活动90+ 振幅 5.2%');
}

// ── 场景 5：高价两档（≥50万 / ≥100万，按平台各自取价）──
console.log('\n[5] 高价档：≥50万 / ≥100万');
{
  const ov = core.buildOverview(daily, built, '20261025');
  eq(ov.today.pc.tiers['500k'], { cards: 2, chg: 0 }, 'pc ≥50万：115+116 两张，平均涨跌 0');
  eq(ov.today.pc.tiers['1m'], { cards: 1, chg: 0 }, 'pc ≥100万：仅 116');
  eq(ov.today.ps.tiers['500k'], { cards: 2, chg: 0 }, 'ps ≥50万：106(55万)+116(90万)');
  eq(ov.today.ps.tiers['1m'], { cards: 0, chg: null }, 'ps ≥100万：无卡（chg=null）');
  // 115 ps=40万 → 不进 ps 50万 档（平台各自取价）
  ok(ov.today.ps.tiers['500k'].cards === 2, '115 的 ps 价 40 万不计入 ps 50万 档');
}

// ── 场景 6：dayKey 对不上（daily 未含今日）⇒ 统计按「积累中」──
console.log('\n[6] dayKey 对不上：指数仍在、当日统计空');
{
  const ov = core.buildOverview(daily, built, '20261026');
  eq(ov.index.pc.all, [100, 200, 150], '指数仍按历史输出');
  ok(ov.today.pc.all.cards === 16, '卡数仍统计');
  ok(ov.today.pc.all.cmp === 0 && ov.today.pc.all.avgChg === null, '无可比卡、avgChg=null');
  eq([ov.today.pc.all.up, ov.today.pc.all.hold, ov.today.pc.all.down, ov.today.pc.all.vol5], [0, 0, 0, 0], '涨持跌/波动全 0');
  ok(ov.today.pc.all.amp === null && ov.today.pc.all.ampN === 0, '振幅不输出（无今日格）');
}

// ── 场景 7：空 daily / 空 tier 防御 ──
console.log('\n[7] 防御：daily 为空 / tier 为空');
{
  const ov1 = core.buildOverview(null, built, '20261025');
  ok(ov1.days.length === 0 && ov1.index.pc.all.length === 0, 'daily 空：days/指数为空数组');
  ok(ov1.today.pc.all.cards === 16 && ov1.today.pc.all.cmp === 0, 'tier 仍在、统计空（积累中）');
  const ov2 = core.buildOverview(daily, { view: { tier: [] } }, '20261025');
  ok(ov2.today.pc.all.cards === 0 && ov2.unCat === 0, 'tier 空：卡数 0');
  eq(ov2.index.pc.all, [null, null, null], 'tier 空：指数全 null（长度对齐）');
  const ov3 = core.buildOverview(null, {}, '20261025');
  ok(ov3.today.pc.all.cards === 0 && ov3.days.length === 0, '全空不炸');
}

// ── 场景 8：导出常量与分类键稳定（端上依赖）──
console.log('\n[8] 导出：分类键/高价档键');
{
  eq(core.OVERVIEW_CATS.map(function (c) { return c.key; }),
    ['gold_80_84', 'gold_85_92', 'icon', 'hero', 'promo_80_84', 'promo_85_89', 'promo_90p', 'totw_80_84', 'totw_85p'],
    '9 个分类键（顺序固定，端上网格按此渲染）');
  eq(core.OVERVIEW_TIERS.map(function (t) { return t.key; }), ['500k', '1m'], '高价两档键');
  ok(core.OVERVIEW_CATS.every(function (c) { return c.label; }), '每个分类都有中文标签');
}

// ── 场景 9：归一化指数 idx100 / 基期 base / indexN（docs/37 §12，2026-10-25）──
console.log('\n[9] 归一化指数：基期自动初始化 / 显式携带 / 跨窗口 / null 传播 / indexN');
{
  // 9a 自动初始化：days 末日=今日 ⇒ 只取已冻结日（day0）首个有效中位价
  const ov = core.buildOverview(daily, built, '20261025');
  eq(ov.base.pc, { day: '20261023', v: 100 }, 'base.pc 自动初始化=最早冻结日(10-23)中位价 100');
  eq(ov.base.ps, { day: '20261023', v: 550000 }, 'base.ps 双平台各自初始化');
  eq(ov.idx100.pc.all, [100, 200, 150], 'idx100.pc.all=中位价÷100×100（基期日恰 100）');
  eq(ov.idx100.ps.all, [100, 100, 100], 'idx100.ps.all');
  eq(Object.keys(ov.idx100.pc).sort(), Object.keys(ov.index.pc).sort(), 'idx100 与 index 同构（全市场+非空分类）');
  ok(ov.idx100.pc.all.length === ov.index.pc.all.length, 'idx100 长度与 days 对齐');

  // 9b 显式携带 + 数值换算（基期=10-24 的 200）
  const ov2 = core.buildOverview(daily, built, '20261025', { pc: { day: '20261024', v: 200 }, ps: { day: '20261024', v: 550000 } });
  eq(ov2.idx100.pc.all, [50, 100, 75], 'idx100=中位价÷200×100（50/100/75）');
  eq(ov2.base.pc, { day: '20261024', v: 200 }, '显式基期原样回写（不重新初始化）');

  // 9c 跨窗口携带：基期日已滚出 14 日窗口也不断裂、不重新起算
  const ov3 = core.buildOverview(daily, built, '20261025', { pc: { day: '20260101', v: 250 } });
  eq(ov3.idx100.pc.all, [40, 80, 60], '基期日不在窗口内：指数仍按旧基期算（40/80/60）');
  eq(ov3.base.pc, { day: '20260101', v: 250 }, '跨窗口不重算基期');

  // 9d null 传播：中位价为 null 的格 idx100 同步为 null（不除零、不错位）
  eq(ov2.idx100.ps.gold_85_92, [null, null, null], 'ps 无数据分类 idx100 全 null');
  ok(ov2.idx100.pc.all.every(function (v) { return v != null; }), 'pc 全市场无 null 格');

  // 9e 基期值非法（v<=0 / 缺 day）⇒ 忽略并按自动初始化
  const ov4 = core.buildOverview(daily, built, '20261025', { pc: { day: '20261024', v: 0 } });
  eq(ov4.base.pc, { day: '20261023', v: 100 }, 'v=0 的基期被忽略，回退自动初始化');

  // 9f indexN：每日有效卡数（端上读数行「有效 N 张」；104 昨日 null ⇒ 15）
  eq(ov.indexN.pc, [16, 15, 16], 'indexN.pc 每日有效卡数（104 day1 null → 15）');
  eq(ov.indexN.ps, [1, 1, 1], 'indexN.ps 仅英雄卡有 ps 日聚合');

  // 9g 当日 partial 绝不作基期：单日文件 + 今日 dayKey ⇒ 不初始化（等 00:00 跨日轮）
  const dailySingle = { v: 1, ts: 1750000000000, days: ['20261025'], players: spec };
  const ov5 = core.buildOverview(dailySingle, built, '20261025');
  eq(ov5.base.pc, null, '仅今日（partial）：不初始化基期');
  ok(ov5.idx100.pc.all === undefined, '无基期 ⇒ idx100 缺该平台键（端上回退绝对线）');
  eq(ov5.indexN.pc, [16], '单日 indexN 仍输出');
  eq(ov5.index.pc.all, [100], '单日绝对中位价仍在');
  // 同一文件但 dayKey 对不上（测试态）⇒ 全部视为已冻结，允许初始化
  const ov6 = core.buildOverview(dailySingle, built, '20261024');
  eq(ov6.base.pc, { day: '20261025', v: 100 }, 'dayKey 对不上：全部日子视为已冻结，取首日初始化');
  eq(ov6.idx100.pc.all, [100], 'idx100 单日=100');
}

// ── 场景 10：idx100 四舍五入（1 位小数）──
console.log('\n[10] idx100 数值精度：1 位小数');
{
  const ov = core.buildOverview(daily, built, '20261025', { pc: { day: '20261023', v: 3 } });
  eq(ov.idx100.pc.all, [3333.3, 6666.7, 5000], '100/3×100=3333.3（1 位小数四舍五入）');
}

console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
