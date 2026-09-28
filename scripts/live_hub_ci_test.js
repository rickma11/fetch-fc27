// sync_live_hub.js#buildPayload 单元测试（CI / 本地均可跑；不启动 Chromium、不碰云）。
// 直接用真实探查快照 probe/live_hub/fc27_progress.json 验证「按基础 eaId 建索引 + 进度字段提炼」。
// 运行：node scripts/live_hub_ci_test.js   （cwd = fetch-fc27）
'use strict';
const path = require('path');
const fs = require('fs');

const { buildPayload, buildFullPayload, stripLabelProgress } = require('./sync_live_hub.js');

let pass = 0, fail = 0;
function eq(a, b, msg) {
  const ok = JSON.stringify(a) === JSON.stringify(b);
  if (ok) { pass++; } else { fail++; console.error('  ✗ ' + msg + '  期望=' + JSON.stringify(b) + ' 实际=' + JSON.stringify(a)); }
}
function ok(cond, msg) { if (cond) { pass++; } else { fail++; console.error('  ✗ ' + msg); } }

// —— 载入真实探查快照（FC27，6 名被追踪球员；快照无 card 嵌套，靠 playerItemEaId 兜底建索引）——
const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'probe', 'live_hub', 'fc27_progress.json'), 'utf8'));
const rawPlayers = fixture.players;

const built = buildPayload(rawPlayers);
console.log('buildPayload → keyed=' + built.keyed + ' unkeyed=' + built.unkeyed);

// 1) 全部 6 名都被对回基础 eaId（兜底 playerItemEaId）
eq(built.keyed, 6, 'keyed=6（全部对回）');
eq(built.unkeyed, 0, 'unkeyed=0（无丢失）');

// 2) 索引键 = 各球员的 playerItemEaId（快照无 card，兜底路径）
const expectedKeys = rawPlayers.map(p => String(p.playerItemEaId)).sort();
eq(Object.keys(built.byEaId).sort(), expectedKeys, 'byEaId 主键=playerItemEaId 全集');

// 3) 每个记录字段齐全 + objectives 提炼正确
rawPlayers.forEach((rp, i) => {
  const rec = built.byEaId[String(rp.playerItemEaId)];
  ok(rec, '记录存在 #' + i + ' ' + rp.name);
  if (!rec) return;
  eq(rec.eaId, rp.playerItemEaId, rec.eaId + ' eaId 一致');
  eq(rec.campaignName, rp.campaignName, rec.eaId + ' campaignName');
  eq(rec.trackerId, rp.trackerId, rec.eaId + ' trackerId');
  eq((rec.objectives || []).length, (rp.objectives || []).length, rec.eaId + ' objectives 数量');
  // objectives 字段映射
  (rp.objectives || []).forEach((o, j) => {
    const t = rec.objectives[j];
    eq(t.requirement, o.req, rec.eaId + ' obj#' + j + ' requirement');
    eq(t.label, o.label, rec.eaId + ' obj#' + j + ' label');
    eq(t.value, o.value, rec.eaId + ' obj#' + j + ' value（含 null 阈值）');
    eq(t.playerValue, o.playerValue, rec.eaId + ' obj#' + j + ' playerValue');
    eq(t.isCompleted, o.isCompleted, rec.eaId + ' obj#' + j + ' isCompleted');
    eq(t.isNotPossible, o.isNotPossible, rec.eaId + ' obj#' + j + ' isNotPossible');
    eq(Array.isArray(t.upgrades) && t.upgrades.length, (o.upgrades || []).length, rec.eaId + ' obj#' + j + ' upgrades 数量');
    if ((o.upgrades || []).length) eq(t.upgrades[0].label, o.upgrades[0].label, rec.eaId + ' obj#' + j + ' upgrade label');
  });
});

// 4) 进度真源验证：OTW 的 Nicole Anyomi / Elisa Senß 的 WIN_OUT_OF_NEXT_6_DOMESTIC.playerValue=2
const anyomi = built.byEaId['50596595'];
const senß = built.byEaId['50596683'];
ok(anyomi && senß, 'Anyomi / Senß 记录存在');
function findObj(rec, reqFragment) {
  return (rec.objectives || []).find(o => String(o.requirement).indexOf(reqFragment) >= 0);
}
ok(findObj(anyomi, 'WIN_OUT_OF_NEXT_6') && findObj(anyomi, 'WIN_OUT_OF_NEXT_6').playerValue === 2, 'Anyomi WIN playerValue=2（进度真源，非 label 插值）');
ok(findObj(senß, 'WIN_OUT_OF_NEXT_6') && findObj(senß, 'WIN_OUT_OF_NEXT_6').playerValue === 2, 'Senß WIN playerValue=2');
// 无阈值目标（TOTW/STAR/POTM）value=null 必须保留
ok(findObj(anyomi, 'TOTW_INCLUSION') && findObj(anyomi, 'TOTW_INCLUSION').value === null, 'Anyomi TOTW value=null（无阈值）');

// 5) 同一 trackerId 条件一致（DFG 三人均 4 级 GOALS_AND_ASSISTS 阶梯）
const dfgKeys = Object.keys(built.byEaId).filter(k => built.byEaId[k].trackerId === 33);
eq(dfgKeys.length, 3, 'DFG 3 人');
const sig = dfgKeys.map(k => (built.byEaId[k].objectives || []).map(o => o.requirement + ':' + o.value).join('|'));
ok(sig.every(s => s === sig[0]), 'DFG 三人 objectives 模板逐字一致');

// 6) buildFullPayload：综合性被追踪集建模（has_dynamic + definition-data.liveHubTrackerId）
//    复刻真实场景：live-hub 聚合只含精选 1 人（含真实进度，label 带 "(2/6)" 插值），
//    defMap 标记 Adeyemi(32，有模板)+Veiga(34，无模板)。
const lhPlayers = [
  { card: { eaId: 111 }, playerItemEaId: 111, trackerId: 32, campaignName: 'Ones to Watch',
    tracker: { objectives: [
      { key: 'a', label: 'Win 3 of next 6 matches (2/6)', requirement: 'WIN_OUT_OF_NEXT_6', value: 3, playerValue: 1, isCompleted: false, isNotPossible: false, upgrades: [{ upgrade: 'x', label: '+1 OVR' }] }
    ] } }
];
const defMap = { '111': 32, '50583500': 32, '50605554': 34 };
const dynMeta = {
  50583500: { rarityName: 'Ones to Watch', clubName: 'Dortmund' },
  50605554: { rarityName: 'Destined for Glory', clubName: 'Villarreal' }
};
const full = buildFullPayload(lhPlayers, defMap, dynMeta);

// 6.0 stripLabelProgress：剥离 fut.gg 插值的进度（防「人人 2/6」统计错误）
eq(stripLabelProgress('Win 3 of next 6 matches (2/6)'), 'Win 3 of next 6 matches', 'stripLabelProgress 剥尾部 (2/6)');
eq(stripLabelProgress('Win 3 of next 6 matches'), 'Win 3 of next 6 matches', 'stripLabelProgress 无插值原样');
eq(stripLabelProgress('3 goals or assists (1/3)'), '3 goals or assists', 'stripLabelProgress 剥 (1/3)');
eq(stripLabelProgress(''), '', 'stripLabelProgress 空串');

// 6.1 精选人保留真实进度
const f111 = full.byEaId['111'];
ok(f111 && f111.hasProgress === true, 'buildFullPayload 精选人 hasProgress=true');
ok(f111.objectives[0].playerValue === 1, '精选人真实 playerValue 保留');
ok(f111.objectives[0].value === 3, '精选人 value 保留');

// 6.2 同 trackerId 模板抽取得，且 label 已剥离进度插值
ok(full.templateByTrackerId[32] && full.templateByTrackerId[32].length === 1, 'trackerId 32 模板抽出');
eq(full.templateByTrackerId[32][0].label, 'Win 3 of next 6 matches', '模板 label 已剥离 (2/6)');

// 6.3 defMap 中未在 live-hub 的人补进（Adeyemi），进度模板化、label 不带进度插值
const adeyemi = full.byEaId['50583500'];
ok(adeyemi && adeyemi.trackerId === 32 && adeyemi.hasProgress === false, 'Adeyemi 经 defMap 补进，trackerId=32，hasProgress=false');
eq(adeyemi.campaignName, 'Ones to Watch', 'Adeyemi campaignName 来自 dynMeta.rarityName');
ok(adeyemi.objectives.length === 1 && adeyemi.objectives[0].playerValue === null, 'Adeyemi 用模板、playerValue=null（不臆造 0/X）');
eq(adeyemi.objectives[0].label, 'Win 3 of next 6 matches', 'Adeyemi 模板 label 无锁死进度（不再人人 2/6）');

// 6.4 Veiga(tid=34) 无模板 → 跳过（不展示空「升级规则」页签）
ok(!full.byEaId['50605554'], 'Veiga(trackerId=34 无模板) 被跳过');
eq(full.skippedNoTemplate, 1, 'skippedNoTemplate=1');

// 6.5 计数 = 精选(1) + defMap 补进(1 Adeyemi) = 2
eq(Object.keys(full.byEaId).length, 2, 'buildFullPayload 总计数=2（精选1+新增1；Veiga 无模板跳过）');

// 6.6 defMap 中 trackerId=null 的人被忽略（仅 has_dynamic 不足以判定，须 liveHubTrackerId!=null）
const full2 = buildFullPayload(lhPlayers, { '999': null, '111': 32 }, {});
ok(!full2.byEaId['999'], 'defMap trackerId=null 的人被忽略');

console.log('\n=== live_hub_ci_test === ' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
