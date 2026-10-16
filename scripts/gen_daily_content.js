// FC27 每日内容弹窗静态 JSON 生成器（2026-10-14）。
//
// 目的：为小程序「每日内容」弹窗（仿 fodder.gg 每日更新卡片）预生成一份聚合 JSON，
//   端上 wx.cloud.downloadFile 直读（零云函数，硬规则 92），每日更新后首次登录弹一次。
//
// 范围（与用户确认）：
//   · 做 SBC + EVO + 每日新增球员
//   · 不做 OBJ（fodder 的 OBJ 数据源未接入生产）
//
// 「新增」判定（**统一自然日口径** ＝ 记录 createdAt 的北京日期 == 弹窗日期）：
//   · SBC / EVO / 球员三类**一律**用 createdAt 判「今日新增」——弹窗顶部那个日期就是「自然日」，
//     内容与该日期严格一致（用户口径：更新的所有信息都是自然日内更新的内容）。
//   · 球员在此之上再加 gen_home_payload#passNewFeed（overall>=80 或 特殊稀有度）＝与首页「新增球员」
//     同口径，并按 createdAt desc 取最新 10 展示（与首页 tab 同序同源）；newPlayersTotal = 今日通过数，
//     >10 时才给「还有 N 名新球员 · 查看首页-新增球员」提示，≤10 时端上不显示该提示且数字即真实值。
//   ⚠️ 2026-10-14 两次修正（都是「弹窗内容与『今日』不匹配」）：
//     ① 旧实现按 overall desc「总评前 10」→ 展示批次里总评最高的**老卡**（10-06/07 的 TOTW 周黑），
//        与首页列表对不上（用户反馈「球员列表不对」）→ 改 createdAt desc。
//     ② 旧实现对球员只做 newFeed、**不看日期** → 把 10-03~10-13 的老卡也算成「今日新增」：
//        弹窗里混进昨天的球员，且 newPlayersTotal=65 让底部提示成「还有 55 名新球员」
//        （实际今日仅 2 名）（用户反馈）→ 三类统一加 createdAt 自然日过滤。
//   ⚠️ 原 SBC/EVO 的 id 基线差（daily_baseline）**已废弃**：它判的是「相对上一批 id 集合的新增」，
//      会跨自然日（今天上线、昨天建的单据仍算新增），且丢一次基线就漏报；现统一由 createdAt 判定，
//      本脚本不再读/写 daily_baseline（云上遗留的 meta_fc{ver}/daily_baseline 文档与对象已无引用，无害）。
//
// 「即将结束」判定：
//   · SBC / EVO 的 endTime 在 72h 内（>0 且 <=72）。
//   · 球员无到期概念，不进「即将结束」tab。
//
// 摘要口径（2026-10-14 用户改版）：
//   · SBC —— **只给奖励**，不再显示「成本 xx」（用户：SBC 信息不需要成本信息）；无奖励则为空串，端上不渲染副行。
//   · EVO —— 不再显示「金币 免费」这类成本信息，改由左侧**来源标签**表达花费
//     （免费进化 / 付费进化 / 训练营 …，标签文案在端上由 SOURCE_LABEL 映射，本文件只给 key）。
//     摘要保留「N 个阶段 · 最高 xx · 位置」这类非成本信息。
//
// 数据来源：
//   · 本地 cloud-data/fc27/sbcs.json      （sets 数组，已落盘于 gen_static_lists 之前步）
//   · 本地 cloud-data/fc27/evolutions.json （all 数组）
//   · 云库 players_fc{ver} 按 createdAt desc 取候选 → createdAt 为今日 且 passNewFeed 过滤（newFeed 口径）
//   · 云库 meta_fc{ver}/dict_basic + dicts/names（装饰中文化，复用 gen_home_payload#loadDicts）
//
// 输出（云存储，复用 gen_static_lists#publishObject）：
//   · fc{ver}/data/daily_content/daily_content.<hash8>.json  （弹窗聚合数据）
//   · 元文档 meta_fc{ver}/daily_content = {fetchedAt,fileID,hash,ts,forceVersion(date)}
//
// ⚠️ 本步是「纯派生」：只读本地落盘 + 云库、只写 daily_content 对象及其元文档，
//   不抓任何新数据、不写任何录入集合。接 fetch-fc27.yml 末步、continue-on-error:true，
//   即使失败也只少一个弹窗，前面 SBC/EVO/球员抓取与录入不受影响（用户要求）。
//
// 用法：node scripts/gen_daily_content.js [ver]      （ver 默认 27；--no-upload 仅本地校验不写云）
'use strict';

const fs = require('fs');
const path = require('path');
const genStatic = require('./gen_static_lists.js');
const home = require('./gen_home_payload.js');

const ROOT = path.resolve(__dirname, '..');
const VER = Number(process.argv[2] || process.env.FC_VER || 27);
const NO_UPLOAD = process.argv.indexOf('--no-upload') >= 0;
const PLAYERS_COLLECTION = 'players_fc' + VER;
const NEW_CANDIDATE = 120;     // 取最新 120 再按「createdAt 今日 + newFeed」过滤（与 gen_home_payload 同口径）
const PLAYER_TOP = 10;          // 弹窗只展示最新 10 名（createdAt desc，与首页「新增球员」同序）
const ENDING_WINDOW_H = 72;     // 即将结束窗口（小时）

// ── 北京日期串 'YYYY-MM-DD'（与端上 utils/daykey.js#dayOf 同口径：固定 +8，无夏令时）──
function dateStr(iso) {
  if (!iso) return '';
  const d = new Date(typeof iso === 'number' ? iso : String(iso));
  if (isNaN(d.getTime())) return '';
  const t = new Date(d.getTime() + 8 * 3600 * 1000);
  const p = function (n) { return (n < 10 ? '0' : '') + n; };
  return t.getUTCFullYear() + '-' + p(t.getUTCMonth() + 1) + '-' + p(t.getUTCDate());
}

// ── 成本格式化：34k / 1.2M / 免费 ──
// ⚠️ 2026-10-14 起弹窗摘要**不再使用**成本文案（SBC 只给奖励、EVO 花费用来源标签表达），
//    此函数保留仅作外部脚本/调试可用，勿再挂回 sbcSummary / evoSummary。
function fmtCost(n) {
  n = Number(n) || 0;
  if (n <= 0) return '免费';
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1e3) return Math.round(n / 1e3) + 'k';
  return String(n);
}

// 「今日新增」统一判据：记录 createdAt 的北京日期 == 今天。
//   缺 createdAt / 无法解析 → 一律不算今日（宁可少报也不混入往日内容，且症状可见易排查）。
function isTodayCn(rec, today) {
  const d = dateStr(rec && rec.createdAt);
  return !!d && d === today;
}

function nameOf(x) { return (x && (x.nameZh || x.name)) || ''; }

// SBC 单个奖励条目 → 文本（四类兼容，与端上 utils/sbcs.js#finalAwardOf/rewardsOf 同口径）：
//   球员 / 卡包 / 特殊奖励(other) / 金币；count>1 追加 ×n。
// ⚠️ 2026-10-14 修正：fut.gg **列表 API 的 a.pack 是字符串**（详情 API 才给 {name}），
//    旧实现只读 a.pack.name → 包类奖励恒为空（「83+ Upgrade」「TOTW Upgrade」等行整行没奖励）。
//    故这里两种形状都兼容（String(a.pack.name || a.pack)）。
function sbcRewardText(a) {
  if (!a) return '';
  const n = Number(a.count) > 1 ? (' ×' + a.count) : '';
  if (a.player && a.player.commonName) return String(a.player.commonName) + n;
  if (a.pack) return String(a.pack.name || a.pack) + n;
  if (a.other) return String(a.other.name || a.other) + n;
  if (Number(a.coins) > 0) return Number(a.coins).toLocaleString('en-US') + ' 金币';
  if (a.playerEaId) return '球员奖励' + n;
  return '';
}

// SBC 单条摘要：**只有奖励**（首个有内容的奖励条目；球员优先，其次卡包/other/金币）。
// ⚠️ 2026-10-14 用户口径：SBC 信息不需要成本信息 → 不再输出「成本 41k」，只留「奖励 Xxx」；
//    所有条目都取不到奖励时返回空串（端上 .dm-row-sub 以 wx:if 判断，空串不渲染该行）。
function sbcSummary(s) {
  const aw = Array.isArray(s && s.awards) ? s.awards
    : (Array.isArray(s && s.allAwards) ? s.allAwards : []);
  for (let i = 0; i < aw.length; i++) {
    const t = sbcRewardText(aw[i]);
    if (t) return '奖励 ' + t;
  }
  return '';
}

// 位置 id → 缩写（与端上 eafc-miniapp/data/roles.js#POS_ABBR 严格同源；改一边必须同步另一边）
const POS_ABBR = { 0: 'GK', 3: 'RB', 5: 'CB', 7: 'LB', 10: 'CDM', 12: 'RM', 14: 'CM', 16: 'LM', 18: 'CAM', 23: 'RW', 25: 'ST', 27: 'LW' };

// 进化允许的位置：**优先取 requirements.readableSchemas 里的 Position**（值已是缩写，如 LW / ST / CAM，
//   与进化详情页展示的「位置」同源，口径天然一致）；缺失时才用 requirements.positions 的数字 id 映射兜底。
// ⚠️ 2026-10-14 修正：旧实现直接 join(requirements.positions) → 弹窗摘要显示成「· 27 / · 25」（裸 id）。
function evoPositions(e) {
  const req = (e && e.requirements) || {};
  const rs = Array.isArray(req.readableSchemas) ? req.readableSchemas : [];
  for (let i = 0; i < rs.length; i++) {
    const s = rs[i];
    if (s && String(s.label) === 'Position' && s.value) return String(s.value);
  }
  const ids = Array.isArray(req.positions) ? req.positions : [];
  return ids.map(function (id) { return POS_ABBR[id] || String(id); }).filter(Boolean).join('/');
}

// ── 进化来源档（8 档判别，与端上 eafc-miniapp/utils/evolutions.js#sourceOf **严格同源**）──
// 只输出 **key**（不输出中文）：中文标签的真源在端上 data/evolutionText.js#SOURCE_LABEL，
// 端上按 key 查表得「免费进化 / 付费进化 / 训练营 / 路线进化 / 赛季通行证 / 任务奖励 / 角色 / 装饰」，
// 这样弹窗标签与进化页 `item.source.label` **同一真源**，不产生中文双份。
// ⚠️ 判别顺序不可调整（与端上注释同因）：通行证后缀 → 训练营 → pathway → 任务奖励 → 角色 → 装饰
//    → 路线结构兜底 → 免费/付费；「装饰/角色」必须排在免费付费兜底之前，否则会被错标成付费进化。
//    改这里必须同步改端上 sourceOf（同 POS_ABBR 的双边同步约定）。
function isPaidOf(rec) {
  const n = function (v) { const x = Number(v); return isFinite(x) && x > 0 ? x : 0; };
  return (n(rec && rec.coinsCost) + n(rec && rec.pointsCost) + n(rec && rec.tokenCost)) > 0;
}

// 角色进化：slim 记录消费 rec.roleOnly（gen_static_lists#slimRecord 已算好）；原始记录用 levels 现场推导
function isRoleOnlyOf(rec) {
  if (!rec) return false;
  if (typeof rec.roleOnly === 'boolean') return rec.roleOnly;
  const lv = Array.isArray(rec.levels) ? rec.levels : [];
  if (!lv.length) return false;
  return lv.every(function (L) {
    const ups = (L && Array.isArray(L.upgrades)) ? L.upgrades : [];
    return ups.length > 0 && ups.every(function (u) { return u && String(u.upgrade).startsWith('role_plus'); });
  });
}

// 装饰（纯卡面）：slim 记录消费 rec.rarityOnly；原始记录用 levels 现场推导
// 2026-10-16 强化：装饰进化升级项分 rarity_id（换卡面）与 cosmetic（纯视觉，如 Golden Stars / Pink Fire），
// 两者均不升级球员属性；EA 亦以 doesNotUpgradePlayer=true 显式标识纯外观进化。
function isRarityOnlyOf(rec) {
  if (!rec) return false;
  if (typeof rec.rarityOnly === 'boolean') return rec.rarityOnly;
  const lv = Array.isArray(rec.levels) ? rec.levels : [];
  if (rec.doesNotUpgradePlayer === true) return true;
  if (!lv.length) return false;
  return lv.every(function (L) {
    const ups = (L && Array.isArray(L.upgrades)) ? L.upgrades : [];
    return ups.length > 0 && ups.every(function (u) { return u && (u.upgrade === 'rarity_id' || u.upgrade === 'cosmetic'); });
  });
}

// 返回来源 key；'' = 记录缺失/无法判定（端上回落显示「EVO」）
function evoSourceKey(rec) {
  if (!rec) return '';
  const name = String(rec.name || '');
  const desc = String(rec.description || '');
  const slug = String(rec.slug || rec.url || '');
  if (/\[SP\+\s*(\d+)?\s*\]/i.test(name)) return 'seasonPassPremium';
  if (/\[SP\s*(\d+)?\s*\]/i.test(name)) return 'seasonPass';
  if (Number(rec.totalTrainingTime || 0) > 0 || /training camp/i.test(name)) return 'trainingCamp';
  if (/pathway/i.test(name + ' ' + desc + ' ' + slug)) return 'pathway';
  if (rec.objectiveGroupName) return 'objective';
  if (rec.isRewardEvolution === true) return 'objective';
  if (isRoleOnlyOf(rec)) return 'role';
  if (isRarityOnlyOf(rec)) return 'cosmetic';
  if (rec.hasUpgradeChoices === true && rec.isRewardEvolution !== true) return 'pathway';
  return isPaidOf(rec) ? 'evolutionPaid' : 'evolutionFree';
}

// EVO 单条摘要：**不含任何成本/花费信息**（花费用左侧来源标签表达）——
//   「N 个阶段 · 最高 xx · 位置」，逐项有则加、全无则空串（端上不渲染副行）。
// ⚠️ 「N 个阶段」取 levelCount（slim 记录有；原始记录用 levels.length 兜底），
//    CI 路径（读原始 all）与手工重建路径（读云端 slim）都能取到，避免两路口径漂移；
//    requirements 是 heavy 字段（云端 slim 已剔除）→ 最高总评/位置在重建路径下可能为空，
//    属数据可得性差异，不是 bug。
function evoSummary(e) {
  const parts = [];
  const n = Number(e.levelCount != null ? e.levelCount : (Array.isArray(e.levels) ? e.levels.length : 0)) || 0;
  if (n > 0) parts.push(n + ' 个阶段');
  const maxO = e.requirements && e.requirements.maxOverall;
  if (maxO) parts.push('最高 ' + maxO);
  const pos = evoPositions(e);
  if (pos) parts.push(pos);
  return parts.join(' · ');
}

function remainHours(iso) {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (isNaN(t)) return null;
  return (t - Date.now()) / 3600000;
}

async function run() {
  // 1) 读本地落盘（gen_static_lists 已落 sbcs.json / evolutions.json）
  const sbcSrc = JSON.parse(fs.readFileSync(path.join(ROOT, 'cloud-data/fc27/sbcs.json'), 'utf8'));
  const evoSrc = JSON.parse(fs.readFileSync(path.join(ROOT, 'cloud-data/fc27/evolutions.json'), 'utf8'));

  const sbcArr = Array.isArray(sbcSrc.sets) ? sbcSrc.sets : [];
  const evoRaw = Array.isArray(evoSrc.all) ? evoSrc.all : [];
  if (!sbcArr.length) { console.error('sbcs.json 无 sets'); process.exit(8); }
  if (!evoRaw.length) { console.error('evolutions.json 无 all'); process.exit(8); }

  // 2) 今天（北京自然日）—— SBC / EVO / 球员 三类「新增」判据共用同一个今天
  const today = dateStr(Date.now());

  // （仅上传路径需要云；本地校验不连云）
  let app = null;
  if (!NO_UPLOAD) app = genStatic.initCloud();

  // 3) 算「今日新增」挑战（SBC / EVO：createdAt 北京日期 == 今天）
  const newChallenges = [];
  sbcArr.forEach(function (s) {
    if (!isTodayCn(s, today)) return;
    newChallenges.push({ id: String(s.id), type: 'sbc', name: nameOf(s), summary: sbcSummary(s), endTime: s.endTime || '' });
  });
  evoRaw.forEach(function (e) {
    if (!isTodayCn(e, today)) return;
    // srcKey = 进化来源档（免费进化/付费进化/训练营/…），端上标签文案由 SOURCE_LABEL 映射
    newChallenges.push({ id: String(e.id), type: 'evo', name: nameOf(e), summary: evoSummary(e), srcKey: evoSourceKey(e), endTime: e.endTime || '' });
  });
  const sbcNewCnt = newChallenges.filter(function (x) { return x.type === 'sbc'; }).length;
  const evoNewCnt = newChallenges.length - sbcNewCnt;

  // 4) 算即将结束（endTime 在 72h 内）
  const ending = [];
  sbcArr.concat(evoRaw).forEach(function (x) {
    const rh = remainHours(x.endTime);
    if (rh != null && rh > 0 && rh <= ENDING_WINDOW_H) {
      const type = ('cost' in x) ? 'sbc' : 'evo';   // SBC 有 cost 字段、EVO 没有
      ending.push({
        id: String(x.id), type: type, name: nameOf(x),
        summary: type === 'sbc' ? sbcSummary(x) : evoSummary(x),
        srcKey: type === 'evo' ? evoSourceKey(x) : '',
        endTime: x.endTime || '', remainHours: Math.round(rh * 10) / 10
      });
    }
  });

  // 5) 今日新增球员（**createdAt 北京日期 == 今天** 且 newFeed 口径；
  //    createdAt desc 取最新 10，与首页「新增球员」tab 同序同源）
  let newPlayers = [];
  let newPlayersTotal = 0;
  if (!NO_UPLOAD && app) {
    const dicts = await home.loadDicts(app);
    const db = app.database();
    const nr = await db.collection(PLAYERS_COLLECTION).orderBy('createdAt', 'desc').limit(NEW_CANDIDATE).get();
    // ⚠️ 两个条件缺一不可：createdAt 为今日（自然日）+ passNewFeed（与首页「新增球员」同口径）。
    //    只看 newFeed 不看日期 → 会把 10-03~10-13 的老卡算成「今日新增」（2026-10-14 用户反馈）。
    const cands = (nr.data || []).filter(function (p) {
      return isTodayCn(p, today) && home.passNewFeed(p);
    });
    // ⚠️ 不要重排：cands 已是 createdAt desc（云库返回序），与首页 home_new 完全同序；
    //   若改按 overall desc 重排，弹窗会变成「总评最高的老卡」，与首页列表不一致（2026-10-14 已修正）。
    newPlayersTotal = cands.length;
    const top = cands.slice(0, PLAYER_TOP);
    home.decorate(top, dicts);
    newPlayers = top.map(function (p) {
      return {
        eaId: home.idOf(p),
        commonName: p.commonName || '',
        overall: p.overall || 0,
        rarityNameZh: p.rarityNameZh || '',
        rarityGroup: p.rarityGroup || '',
        clubNameZh: p.clubNameZh || '',
        leagueNameZh: p.leagueNameZh || '',
        nationNameZh: p.nationNameZh || '',
        orgLine: p.orgLine || '',
        img: p.img || '',
        // 该球员的**北京自然日**（与 dateStr 同口径，服务端算好）。
        // 端上只用 `day === daily.date` 做字符串比对再校验一次「自然日」，不引入端上日期换算
        // （端上 utils/daykey.js#dayOf 是设备本地日，跨时区会与北京日错位）。
        day: dateStr(p.createdAt) || ''
      };
    });
  } else {
    console.log('（--no-upload：球员需云库，跳过；前端将显示空）');
  }

  // 6) 组装 daily_content 对象
  const daily = {
    date: today,
    newPlayers: newPlayers,
    newPlayersTotal: newPlayersTotal,
    newChallenges: newChallenges,
    ending: ending
  };

  console.log('[gen_daily_content] date=' + today);
  console.log('[gen_daily_content] SBC: 总数 ' + sbcArr.length + ' / 今日新增 ' + sbcNewCnt);
  console.log('[gen_daily_content] EVO: 总数 ' + evoRaw.length + ' / 今日新增 ' + evoNewCnt);
  console.log('[gen_daily_content] 新挑战合计 ' + newChallenges.length + ' / 即将结束 ' + ending.length);
  console.log('[gen_daily_content] 新增球员 展示 ' + newPlayers.length + ' / 今日总数 ' + newPlayersTotal +
    (newPlayersTotal > PLAYER_TOP ? '（超 10，提示引导首页）' : '（≤10，端上不显示「还有 N 名」提示）'));

  if (NO_UPLOAD) {
    console.log('\n本地校验（--no-upload，未写云）');
    console.log('daily_content sample =', JSON.stringify({
      date: daily.date,
      newPlayers: daily.newPlayers.slice(0, 2),
      newChallenges: daily.newChallenges.slice(0, 2),
      ending: daily.ending.slice(0, 2)
    }, null, 1).slice(0, 1200));
    process.exit(0);
  }

  await genStatic.publishObject(app, 'daily_content', daily);
  console.log('\n=== gen_daily_content 完成 ===');
}

if (require.main === module) {
  run().catch(function (e) {
    console.error('[gen_daily_content] 失败：', e && e.message);
    process.exit(1);
  });
}

module.exports = {
  dateStr: dateStr, fmtCost: fmtCost, isTodayCn: isTodayCn,
  sbcSummary: sbcSummary, evoSummary: evoSummary,
  // 来源档判别（供手工重建脚本 / 调试；与端上 utils/evolutions.js#sourceOf 同源）
  evoSourceKey: evoSourceKey, isPaidOf: isPaidOf, isRoleOnlyOf: isRoleOnlyOf, isRarityOnlyOf: isRarityOnlyOf
};
