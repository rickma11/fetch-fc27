// gen_evo_eligible.js —— 进化「符合球员名单」生成器（独立旁路，零侵入原抓取流水线）。
//
// 思路（对齐市场价格监控范式）：
//   读 表A evolutions_fc27(requirements) × 表B players_fc27(球员匹配字段)
//   → 两表按「requirements 谓词」逐进化 × 全球员匹配
//   → 产出公有读静态 JSON 缓存到次日刷新（端上按需 live 拉，0 云函数配额）。
//
// 设计要点：
//   · 只读云库、只写新文件（fc27/data/evo_eligible/{evoId}.json + index.json），不改原数据。
//   · 只给端上「会展示」的进化产名单：isStale!==true && isExpired!==true（与 get_evolutions 列表同口径）。
//   · 位置桥：requirements.positions 用 fut.gg uniqueId，玩家侧 position(码)+alternativePositionIds(ID)
//     归一到 uniqueId 空间比对（见 positionsFutgg.js，28 位置完整真源，GK=0 为准）。
//   · 属性阈值（attributeX/min/max）只在 details_fc27 有，按需懒读：先过非属性约束得候选集，
//     合并所有含属性约束进化的候选 → 批量读 details.attributes → 应用属性约束（一次查询，多进化复用）。
//   · 高频约束全实现；罕见/无数据约束（价格、workrate、bodyTypes…）保守放行 + 告警计数，绝不静默丢人。
//   · 交叉校验（方向+幅度感知）：算出 count 与 fut.gg 顶层 numberOfPlayers 比；因 fut 口径不可比（实测最宽进化 19807 < 本名册 20212，恒定 ~2% 差），故「count<fut」正常、「count>fut 且≤10%」亦为口径差不告警，仅「count>fut 超 10%」打告警（真·多放人）。漏匹配由 unimplemented/missingAttr 兜底。
//
// 用法：
//   node scripts/gen_evo_eligible.js                 # 本地模拟（写 cloud-data，不上传）
//   node scripts/gen_evo_eligible.js --upload        # 真写云存储公有读
//   node scripts/gen_evo_eligible.js --checkonly     # 只打印匹配器自测 + 抽样校验，不产出
//
// 触发：由 .github/workflows/gen-evo-eligible.yml 经 cron-job.org 每日 02:00 触发，含新鲜度护栏。

'use strict';

const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const VER = 27;

const { POS_UNIQUE_TO_NAME, mainPosToUniqueIds, playerPositionIds, posName } = require('./positionsFutgg');

// ── 正则：属性约束键 ──
const RE_EXACT_ATTR = /^attribute([A-Z][a-z]+)$/;           // attributeAcceleration（精确，罕见）
const RE_MIN_ATTR = /^minAttribute([A-Z][a-z]+)$/;          // minAttributeAcceleration
const RE_MAX_ATTR = /^maxAttribute([A-Z][a-z]+)$/;          // maxAttributeAcceleration
const RE_ATTR_ANY = /^((min|max)?Attribute[A-Z][a-z]+)$/;

// ── 已实现（精确处理）的 requirements 键 ──
const IMPLEMENTED_KEYS = new Set([
  // 位置
  'positions', 'excludedPositions', 'positionsSearchMode', 'onlySearchMainPosition',
  'minNumberOfPositions', 'maxNumberOfPositions', 'totalNumberOfPositions',
  // 总评
  'minOverall', 'maxOverall',
  // 稀有度
  'rarities', 'excludedRarities',
  // 国籍
  'nations', 'excludedNations',
  // 联赛
  'leagues', 'excludedLeagues', 'leagueNationForcedIds', 'leagueNationSearchMode',
  // 俱乐部
  'clubs', 'excludedClubs',
  // 花式 / 逆足
  'skillMoves', 'excludedSkillMoves', 'minSkillMoves', 'maxSkillMoves',
  'weakFoot', 'excludedWeakFoot', 'minWeakFoot', 'maxWeakFoot',
  // 性别 / 真实脸
  'genders', 'isRealFace',
  // 比赛风格
  'playstyles', 'excludedPlaystyles', 'playstylesPlus', 'excludedPlaystylesPlus',
  'playstylesSearchMode', 'onlySearchPlaystylesPlus', 'minPlaystyles', 'maxPlaystyles',
  'minPlaystylesPlus', 'maxPlaystylesPlus',
  // 角色
  'rolesPlus', 'rolesPlusPlus', 'excludedRolesPlus', 'excludedRolesPlusPlus',
  'minRolesPlus', 'maxRolesPlus', 'minRolesPlusPlus', 'maxRolesPlusPlus',
  // SBC 积分
  'minGradingScore', 'maxGradingScore',
  // 明确球员集
  'basePlayerEaIds', 'excludedBasePlayerEaIds', 'eaIds', 'excludedEaIds', 'forcedEaIds',
  // 卡片来源
  'isSbc', 'isObjective', 'isSeasonPass',
  // 身高 / 体重
  'minHeight', 'maxHeight', 'minWeight', 'maxWeight',
  // 年龄 / 生日
  'minAge', 'maxAge', 'minBirthDate', 'maxBirthDate',
  // 卡面 PACE（fut.gg 字段，名册无直接字段；用 (Acceleration+SprintSpeed)/2 近似，见 matchAttrOnly）
  'minFacePace', 'maxFacePace',
  // 加速类型 / 强脚 / 全息
  'accelerateTypes', 'excludedAccelerateTypes', 'strongFoot',
  'showHolographics', 'onlyHolographics', 'holographicTypes',
  // 属性阈值（按需懒读 details）
  'attributes'
]);

// 通用辅助
function isArr(v) { return Array.isArray(v) && v.length > 0; }
function num(v) { return (typeof v === 'number' && isFinite(v)) ? v : null; }
function arrHas(have, want, mode) {
  if (!want || !want.length) return true;
  if (!have || !have.length) return false;
  if (mode === 'AND') return want.every(function (x) { return have.indexOf(x) >= 0; });
  return want.some(function (x) { return have.indexOf(x) >= 0; }); // 默认 OR
}

function ageAt(birthMs, nowMs) {
  const d = new Date(birthMs), n = new Date(nowMs);
  let a = n.getFullYear() - d.getFullYear();
  const m = n.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && n.getDate() < d.getDate())) a--;
  return a;
}

// 计算玩家「能踢的位置」uniqueId 集合（主位置码 + 备选 ID），已去重
function playerPosSet(p) {
  const ids = playerPositionIds(p); // 含主 + 备选
  const set = {};
  for (let i = 0; i < ids.length; i++) set[ids[i]] = true;
  return set;
}

// ── 非属性约束匹配（attrs 不参与）──
// 返回 true 表示该球员「满足除属性外的所有已实现约束」。
// evo 有属性约束时，本函数用于筛候选（放行属性约束，交由 pass2 处理）。
function matchNonAttr(req, p, ctx) {
  // 位置
  if (isArr(req.positions)) {
    const pids = req.onlySearchMainPosition
      ? mainPosOnly(p)
      : playerPosSet(p);
    if (req.positionsSearchMode === 'AND') {
      if (!req.positions.every(function (id) { return pids[id]; })) return false;
    } else {
      if (!req.positions.some(function (id) { return pids[id]; })) return false; // OR 默认
    }
  }
  if (isArr(req.excludedPositions)) {
    const pids = playerPosSet(p);
    if (req.excludedPositions.some(function (id) { return pids[id]; })) return false;
  }
  if (req.minNumberOfPositions != null || req.maxNumberOfPositions != null) {
    const n = Object.keys(playerPosSet(p)).length;
    if (req.minNumberOfPositions != null && n < req.minNumberOfPositions) return false;
    if (req.maxNumberOfPositions != null && n > req.maxNumberOfPositions) return false;
  }
  if (req.totalNumberOfPositions != null) {
    const n = Object.keys(playerPosSet(p)).length;
    if (n > req.totalNumberOfPositions) return false;
  }

  // 总评
  const ov = num(p.overall);
  if (req.minOverall != null && (ov == null || ov < req.minOverall)) return false;
  if (req.maxOverall != null && (ov == null || ov > req.maxOverall)) return false;

  // 稀有度
  const rid = (p.rarity && typeof p.rarity.eaId === 'number') ? p.rarity.eaId : null;
  if (isArr(req.rarities)) { if (rid == null || req.rarities.indexOf(rid) < 0) return false; }
  if (isArr(req.excludedRarities)) { if (rid != null && req.excludedRarities.indexOf(rid) >= 0) return false; }

  // 国籍
  const nid = (p.nation && typeof p.nation.id === 'number') ? p.nation.id : null;
  if (isArr(req.nations)) { if (nid == null || req.nations.indexOf(nid) < 0) return false; }
  if (isArr(req.excludedNations)) { if (nid != null && req.excludedNations.indexOf(nid) >= 0) return false; }

  // 联赛
  const lid = (p.league && typeof p.league.id === 'number') ? p.league.id : null;
  if (isArr(req.leagues)) { if (lid == null || req.leagues.indexOf(lid) < 0) return false; }
  if (isArr(req.excludedLeagues)) { if (lid != null && req.excludedLeagues.indexOf(lid) >= 0) return false; }
  if (isArr(req.leagueNationForcedIds)) {
    let hit = false;
    for (let i = 0; i < req.leagueNationForcedIds.length; i++) {
      const pair = req.leagueNationForcedIds[i];
      const fl = (pair && (pair.leagueId != null ? pair.leagueId : pair[0]));
      const fn = (pair && (pair.nationId != null ? pair.nationId : pair[1]));
      if (lid === fl && nid === fn) { hit = true; break; }
    }
    if (!hit) return false;
  }

  // 俱乐部
  const cid = (p.club && typeof p.club.id === 'number') ? p.club.id : null;
  if (isArr(req.clubs)) { if (cid == null || req.clubs.indexOf(cid) < 0) return false; }
  if (isArr(req.excludedClubs)) { if (cid != null && req.excludedClubs.indexOf(cid) >= 0) return false; }

  // 花式 / 逆足
  const sm = num(p.skillMoves), wf = num(p.weakFoot);
  if (req.skillMoves != null && sm !== req.skillMoves) return false;
  if (isArr(req.excludedSkillMoves) && sm != null && req.excludedSkillMoves.indexOf(sm) >= 0) return false;
  if (req.minSkillMoves != null && (sm == null || sm < req.minSkillMoves)) return false;
  if (req.maxSkillMoves != null && (sm == null || sm > req.maxSkillMoves)) return false;
  if (req.weakFoot != null && wf !== req.weakFoot) return false;
  if (isArr(req.excludedWeakFoot) && wf != null && req.excludedWeakFoot.indexOf(wf) >= 0) return false;
  if (req.minWeakFoot != null && (wf == null || wf < req.minWeakFoot)) return false;
  if (req.maxWeakFoot != null && (wf == null || wf > req.maxWeakFoot)) return false;

  // 性别
  if (isArr(req.genders) && (p.gender == null || req.genders.indexOf(p.gender) < 0)) return false;

  // 真实脸
  if (req.isRealFace != null && (!!p.isRealFace) !== (!!req.isRealFace)) return false;

  // 比赛风格
  const modeP = req.playstylesSearchMode === 'AND' ? 'AND' : 'OR';
  if (isArr(req.playstyles) && !arrHas(p.playstyles, req.playstyles, modeP)) return false;
  if (isArr(req.excludedPlaystyles) && arrHas(p.playstyles, req.excludedPlaystyles, 'OR')) return false;
  if (isArr(req.playstylesPlus) && !arrHas(p.playstylesPlus, req.playstylesPlus, modeP)) return false;
  if (isArr(req.excludedPlaystylesPlus) && arrHas(p.playstylesPlus, req.excludedPlaystylesPlus, 'OR')) return false;
  if (req.minPlaystyles != null && (p.playstyles || []).length < req.minPlaystyles) return false;
  if (req.maxPlaystyles != null && (p.playstyles || []).length > req.maxPlaystyles) return false;
  if (req.minPlaystylesPlus != null && (p.playstylesPlus || []).length < req.minPlaystylesPlus) return false;
  if (req.maxPlaystylesPlus != null && (p.playstylesPlus || []).length > req.maxPlaystylesPlus) return false;

  // 角色
  if (isArr(req.rolesPlus) && !arrHas(p.rolesPlus, req.rolesPlus, modeP)) return false;
  if (isArr(req.rolesPlusPlus) && !arrHas(p.rolesPlusPlus, req.rolesPlusPlus, modeP)) return false;
  if (isArr(req.excludedRolesPlus) && arrHas(p.rolesPlus, req.excludedRolesPlus, 'OR')) return false;
  if (isArr(req.excludedRolesPlusPlus) && arrHas(p.rolesPlusPlus, req.excludedRolesPlusPlus, 'OR')) return false;
  if (req.minRolesPlus != null && (p.rolesPlus || []).length < req.minRolesPlus) return false;
  if (req.maxRolesPlus != null && (p.rolesPlus || []).length > req.maxRolesPlus) return false;
  if (req.minRolesPlusPlus != null && (p.rolesPlusPlus || []).length < req.minRolesPlusPlus) return false;
  if (req.maxRolesPlusPlus != null && (p.rolesPlusPlus || []).length > req.maxRolesPlusPlus) return false;

  // SBC 积分（gradingScore = sbcPoints）
  const gp = num(p.sbcPoints);
  if (req.minGradingScore != null && (gp == null || gp < req.minGradingScore)) return false;
  if (req.maxGradingScore != null && (gp == null || gp > req.maxGradingScore)) return false;

  // 明确球员集
  const ea = p.eaId;
  if (isArr(req.eaIds) && req.eaIds.indexOf(ea) < 0) return false;
  if (isArr(req.excludedEaIds) && req.excludedEaIds.indexOf(ea) >= 0) return false;
  if (isArr(req.basePlayerEaIds) && req.basePlayerEaIds.indexOf(ea) < 0) return false;
  if (isArr(req.excludedBasePlayerEaIds) && req.excludedBasePlayerEaIds.indexOf(ea) >= 0) return false;

  // 卡片来源
  const isSbc = (p.cardSource === 'SBC' || p.isSbc === true);
  const isObj = (p.cardSource === 'OBJECTIVE' || p.isObjective === true);
  const isSp = (p.cardSource === 'SEASON_PASS' || p.isSeasonPass === true);
  if (req.isSbc != null && (!!isSbc) !== (!!req.isSbc)) return false;
  if (req.isObjective != null && (!!isObj) !== (!!req.isObjective)) return false;
  if (req.isSeasonPass != null && (!!isSp) !== (!!req.isSeasonPass)) return false;

  // 身高 / 体重（weight 列表接口通常为空 → 约束保守放行：见 ctx 告警）
  const ht = num(p.height);
  if (req.minHeight != null && (ht == null || ht < req.minHeight)) return false;
  if (req.maxHeight != null && (ht == null || ht > req.maxHeight)) return false;
  if (req.minWeight != null) { ctx.missingFields.weight = (ctx.missingFields.weight || 0) + 1; } // 名册无 weight → 放行
  if (req.maxWeight != null) { ctx.missingFields.weight = (ctx.missingFields.weight || 0) + 1; }

  // 年龄 / 生日（需 dateOfBirth）
  if (req.minAge != null || req.maxAge != null || req.minBirthDate != null || req.maxBirthDate != null) {
    const bd = (typeof p.dateOfBirth === 'string' && p.dateOfBirth) ? Date.parse(p.dateOfBirth) : NaN;
    if (!isNaN(bd)) {
      const age = ageAt(bd, ctx.now);
      if (req.minAge != null && age < req.minAge) return false;
      if (req.maxAge != null && age > req.maxAge) return false;
      if (req.minBirthDate != null) { const lo = Date.parse(req.minBirthDate); if (!isNaN(lo) && bd < lo) return false; }
      if (req.maxBirthDate != null) { const hi = Date.parse(req.maxBirthDate); if (!isNaN(hi) && bd > hi) return false; }
    } else {
      ctx.missingFields.dateOfBirth = (ctx.missingFields.dateOfBirth || 0) + 1; // 无生日 → 放行
    }
  }

  // 加速类型 / 强脚 / 全息
  if (isArr(req.accelerateTypes)) {
    const a = (typeof p.accelerateType === 'string') ? p.accelerateType.toLowerCase() : null;
    const want = req.accelerateTypes.map(function (x) { return String(x).toLowerCase(); });
    if (!a || want.indexOf(a) < 0) return false;
  }
  if (isArr(req.excludedAccelerateTypes)) {
    const a = (typeof p.accelerateType === 'string') ? p.accelerateType.toLowerCase() : null;
    if (a) {
      const ex = req.excludedAccelerateTypes.map(function (x) { return String(x).toLowerCase(); });
      if (ex.indexOf(a) >= 0) return false;
    }
  }
  if (isArr(req.strongFoot)) {
    const f = (typeof p.foot === 'string') ? p.foot.toLowerCase() : null;
    const want = req.strongFoot.map(function (x) { return String(x).toLowerCase(); });
    if (!f || want.indexOf(f) < 0) return false;
  }
  if (req.onlyHolographics === true && !p.holographicType) return false;
  if (isArr(req.holographicTypes)) {
    if (p.holographicType) {
      if (req.holographicTypes.indexOf(p.holographicType) < 0) return false;
    }
    // 无 holographicType 时保守放行（不强制排除）
  }

  return true;
}

// 主位置唯一 ID 集合（仅主位，但按 type 展开，用于 onlySearchMainPosition）。
// 名册把 RS/LS/CF 等细分位置卡的主位置码统一存成父码（ST/RW/LW/CAM…），
// 故主位置码要按 typeId 展开，才能正确命中限定细分主位置的进化
// （与 playerPositionIds 的普通展开口径一致）。
function mainPosOnly(p) {
  const set = {};
  const ids = mainPosToUniqueIds(p && p.position);
  for (let i = 0; i < ids.length; i++) set[ids[i]] = true;
  return set;
}

// ── 属性约束匹配（仅当 detail 提供时，detail = {attributes, facePace}）──
function matchAttrOnly(req, detail, ctx) {
  if (!detail || !detail.attributes) { ctx.missingAttr++; return false; }
  const attrs = detail.attributes;
  const keys = Object.keys(req);
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    let m;
    if ((m = RE_EXACT_ATTR.exec(k))) {
      const attrKey = k;                                // attributeAcceleration（精确）
      const val = num(req[k]);
      if (val != null && num(attrs[attrKey]) !== val) return false;
    } else if ((m = RE_MIN_ATTR.exec(k))) {
      const attrKey = 'attribute' + m[1];               // 去 min 前缀 → attributeAcceleration
      const val = num(req[k]);
      if (val != null && (num(attrs[attrKey]) == null || attrs[attrKey] < val)) return false;
    } else if ((m = RE_MAX_ATTR.exec(k))) {
      const attrKey = 'attribute' + m[1];               // 去 max 前缀 → attributeAcceleration
      const val = num(req[k]);
      if (val != null && (num(attrs[attrKey]) == null || attrs[attrKey] > val)) return false;
    }
  }
  // 卡面 PACE（details 顶层 facePace 字段，直接使用，无需近似）
  if (req.minFacePace != null || req.maxFacePace != null) {
    const fp = (typeof detail.facePace === 'number') ? detail.facePace : null;
    if (fp == null) { ctx.missingAttr++; return false; }
    if (req.minFacePace != null && fp < req.minFacePace) return false;
    if (req.maxFacePace != null && fp > req.maxFacePace) return false;
  }
  return true;
}

// 该进化是否含属性/卡面 PACE 约束（需懒读 details）
function hasAttrConstraint(req) {
  const keys = Object.keys(req);
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    if (req[k] == null) continue;
    if (RE_ATTR_ANY.test(k)) return true;
    if (/^(min|max)FacePace$/.test(k)) return true; // 需 details 的 facePace 字段
  }
  return false;
}

// 扫描 requirements 中「未实现且非 null」的键，记入 ctx.unimplemented（保守放行）
function scanUnimplemented(req, ctx) {
  const keys = Object.keys(req);
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    if (req[k] == null) continue;
    // 属性约束的 min/max/exact 一并视为「已实现（按需）」
    if (RE_ATTR_ANY.test(k)) continue;
    if (!IMPLEMENTED_KEYS.has(k)) {
      ctx.unimplemented[k] = (ctx.unimplemented[k] || 0) + 1;
    }
  }
}

// ── 云库分页读取助手 ──
async function readAll(db, col, proj, whereFn) {
  const out = [];
  let skip = 0;
  while (true) {
    let q = db.collection(col).field(proj);
    if (whereFn) q = q.where(whereFn);
    const r = await q.skip(skip).limit(1000).get();
    const d = r.data || [];
    if (!d.length) break;
    for (let i = 0; i < d.length; i++) out.push(d[i]);
    if (d.length < 1000) break;
    skip += 1000;
  }
  return out;
}

// 批量读 details 属性 + 卡面 PACE（eaIds 去重分批；TCB get 默认只回 ~100 条，必须 .limit(1000)）
async function readDetailsAttrs(db, eaIds) {
  const map = {};
  const cmd = db.command;
  const ids = Array.from(new Set(eaIds));
  for (let i = 0; i < ids.length; i += 500) {
    const batch = ids.slice(i, i + 500);
    const r = await db.collection('details_fc' + VER).where({ eaId: cmd.in(batch) })
      .field({ eaId: true, attributes: true, facePace: true }).limit(1000).get();
    const d = r.data || [];
    for (let j = 0; j < d.length; j++) {
      const rec = d[j];
      if (rec.attributes && typeof rec.attributes === 'object') {
        map[rec.eaId] = {
          attributes: rec.attributes,
          facePace: (typeof rec.facePace === 'number') ? rec.facePace : null
        };
      }
    }
  }
  return map;
}

// ── 上传（超时 + 重试 + 有限并发，对齐 memory #116）──
async function uploadJson(app, cloudPath, obj, retries) {
  const buf = Buffer.from(JSON.stringify(obj));
  retries = retries || 3;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const race = new Promise(function (_, rej) { setTimeout(function () { rej(new Error('upload timeout 200s')); }, 200000); });
      const up = await Promise.race([
        app.uploadFile({ cloudPath: cloudPath, fileContent: buf }),
        race
      ]);
      return up.fileID;
    } catch (e) {
      if (attempt === retries - 1) throw e;
      await new Promise(function (r) { setTimeout(r, 2000); });
    }
  }
}

async function uploadMany(app, jobs) {
  const CONC = 4;
  let idx = 0;
  async function worker() {
    while (idx < jobs.length) {
      const j = jobs[idx++];
      try { await uploadJson(app, j.cloudPath, j.obj); console.log('  ✔ 上传 ' + j.cloudPath); }
      catch (e) { console.error('  ✘ 上传失败 ' + j.cloudPath + '：' + e.message); throw e; }
    }
  }
  const ws = [];
  for (let i = 0; i < CONC; i++) ws.push(worker());
  await Promise.all(ws);
}

// 新鲜度护栏：取 evolutions_fc27 最新 _fetchedAt，确认当天刷新过才生成。
// 仅在 --upload（CI 触发）时生效；本地模拟 / --checkonly 不走护栏。
async function checkFresh(db, maxAgeHours) {
  try {
    const r = await db.collection('evolutions_fc27').field({ _fetchedAt: true }).orderBy('_fetchedAt', 'desc').limit(1).get();
    const maxFetched = r.data && r.data[0] && r.data[0]._fetchedAt;
    if (!maxFetched) {
      return { ok: true, reason: 'evolutions_fc27 无 _fetchedAt 标记，无法判定，保守放行生成', maxFetched: null };
    }
    const ageMs = Date.now() - Date.parse(maxFetched);
    return { ok: ageMs <= maxAgeHours * 3600 * 1000, maxFetched: maxFetched, ageMs: ageMs };
  } catch (e) {
    return { ok: true, reason: '新鲜度查询异常，保守放行：' + e.message };
  }
}

// ── 主流程 ──
async function main() {
  const argv = process.argv.slice(2);
  const DO_UPLOAD = argv.indexOf('--upload') >= 0;
  const CHECK_ONLY = argv.indexOf('--checkonly') >= 0;

  const { resolve } = require('./tcb_env');
  const cred = resolve();
  if (cred.missing && cred.missing.length) {
    throw new Error('缺少云开发凭证：' + cred.missing.join(' / ') + '\n在 CI 注入 TCB_* 或本地 .env.local 配置。');
  }
  const cloudbase = require('@cloudbase/node-sdk');
  const app = cloudbase.init({ env: cred.ENV_ID, secretId: cred.SECRET_ID, secretKey: cred.SECRET_KEY, timeout: 180000 });
  const db = app.database();

  console.log('[gen_evo_eligible] 读 evolutions_fc' + VER + '（仅非 stale/非 expired）…');
  const evosRaw = await readAll(db, 'evolutions_fc' + VER, null, null);
  const evos = evosRaw
    .filter(function (e) { return e.isStale !== true && e.isExpired !== true; })
    .map(function (e) {
      const req = (e.requirements && typeof e.requirements === 'object') ? e.requirements : {};
      return { id: e.id, req: req, numberOfPlayers: (typeof e.numberOfPlayers === 'number') ? e.numberOfPlayers : null };
    });
  console.log('[gen_evo_eligible] 参与匹配的进化：' + evos.length + ' / 全量 ' + evosRaw.length);

  console.log('[gen_eligible] 读 players_fc' + VER + ' 全量…');
  const proj = {
    eaId: true, overall: true, position: true, alternativePositionIds: true,
    'nation.id': true, 'league.id': true, 'club.id': true,
    'rarity.eaId': true, 'rarity.name': true,
    playstyles: true, playstylesPlus: true, rolesPlus: true, rolesPlusPlus: true,
    skillMoves: true, weakFoot: true, gender: true, isRealFace: true, sbcPoints: true,
    cardSource: true, isSbc: true, isObjective: true, isSeasonPass: true,
    accelerateType: true, height: true, dateOfBirth: true, foot: true, holographicType: true
  };
  const players = await readAll(db, 'players_fc' + VER, proj, null);
  console.log('[gen_evo_eligible] 球员总数：' + players.length);
  if (players.length < 15000) {
    throw new Error('球员总数 ' + players.length + ' < 15000，疑似云库未就绪/异常，拒绝产出过期名单');
  }

  // 匹配
  const ctx = { now: Date.now(), unimplemented: {}, missingFields: {}, missingAttr: 0 };
  const eligibleByEvo = {};
  const candidatesByEvo = {};
  const needAttrEvos = evos.filter(function (e) { return hasAttrConstraint(e.req); });
  evos.forEach(function (e) {
    eligibleByEvo[e.id] = [];
    if (needAttrEvos.indexOf(e) >= 0) candidatesByEvo[e.id] = [];
    scanUnimplemented(e.req, ctx);
  });

  console.log('[gen_evo_eligible] 逐进化 × 球员匹配（' + evos.length + ' × ' + players.length + '）…');
  for (let pi = 0; pi < players.length; pi++) {
    const p = players[pi];
    for (let ei = 0; ei < evos.length; ei++) {
      const e = evos[ei];
      if (matchNonAttr(e.req, p, ctx)) {
        if (needAttrEvos.indexOf(e) >= 0) candidatesByEvo[e.id].push(p.eaId);
        else eligibleByEvo[e.id].push(p.eaId);
      }
    }
  }

  // 属性约束 pass2
  if (needAttrEvos.length) {
    const allCand = [];
    const seen = {};
    needAttrEvos.forEach(function (e) {
      (candidatesByEvo[e.id] || []).forEach(function (ea) { if (!seen[ea]) { seen[ea] = true; allCand.push(ea); } });
    });
    console.log('[gen_evo_eligible] 含属性约束进化 ' + needAttrEvos.length + ' 个，需读 details 属性候选 ' + allCand.length + ' 人…');
    const attrMap = await readDetailsAttrs(db, allCand);
    console.log('[gen_evo_eligible] 拿到属性 ' + Object.keys(attrMap).length + ' 人');
    needAttrEvos.forEach(function (e) {
      (candidatesByEvo[e.id] || []).forEach(function (ea) {
        const detail = attrMap[ea];
        if (!detail || !detail.attributes) { ctx.missingAttr++; return; }
        if (matchAttrOnly(e.req, detail, ctx)) eligibleByEvo[e.id].push(ea);
      });
    });
  }

  const updatedAt = new Date().toISOString();
  const index = { updatedAt: updatedAt, version: String(VER), perId: {} };
  const jobs = [];
  const report = [];

  evos.forEach(function (e) {
    let eaIds = eligibleByEvo[e.id];
    // 去重 + 排序（数值升序，便于端上稳定渲染）
    eaIds = Array.from(new Set(eaIds)).sort(function (a, b) { return a - b; });
    eligibleByEvo[e.id] = eaIds;
    index.perId[e.id] = eaIds.length;
    const obj = { id: e.id, count: eaIds.length, eaIds: eaIds, updatedAt: updatedAt, numberOfPlayers: e.numberOfPlayers };
    report.push({ id: e.id, count: eaIds.length, fut: e.numberOfPlayers });
    if (!CHECK_ONLY) {
      jobs.push({ cloudPath: 'fc27/data/evo_eligible/' + e.id + '.json', obj: obj });
    }
  });
  if (!CHECK_ONLY) jobs.push({ cloudPath: 'fc27/data/evo_eligible/index.json', obj: index });

  // 交叉校验（方向+幅度感知）：fut.gg 的 numberOfPlayers 口径与本名册不可比——
  // 实测 fut 最宽进化=19807 < 本名册总量 20212，存在约 2% 的系统性口径差（恒定 +405）。
  // 故「count<fut」是正常版本膨胀，「count>fut 但≤10%」也只是口径差，二者都不告警；
  // 仅当「count>fut 且超 10%」才视为真异常（我方严重多放人）打 ⚠️。
  // 漏匹配/属性读不到由下方 unimplemented / missingAttr 告警兜底，不依赖此口径。
  console.log('\n[gen_evo_eligible] ── 交叉校验（count vs fut.gg numberOfPlayers，方向+幅度感知：仅 count>fut 超 10% 告警）──');
  const ROSTER_TOTAL = players.length;
  const GROSS_PCT = 0.10; // 仅当 count 超 fut 10% 以上才算真异常（过滤系统性 ~2% 口径差）
  let warnCount = 0, okCount = 0, overTotalCount = 0;
  report.forEach(function (r) {
    if (r.fut == null) return;
    const diff = r.count - r.fut;
    if (diff > 0 && (r.fut ? diff / r.fut : 1) > GROSS_PCT) {
      const pct = r.fut ? (diff / r.fut * 100) : 100;
      warnCount++;
      console.log('  ⚠️ evo ' + r.id + '：算出 ' + r.count + ' / fut ' + r.fut + '（多 ' + diff + ' 人，+' + pct.toFixed(1) + '%）');
      return;
    }
    okCount++;
    let note = '';
    if (r.fut > ROSTER_TOTAL) { overTotalCount++; note = '（fut 超本名册总量 ' + ROSTER_TOTAL + '，含全版本计数）'; }
    else if (diff > 0) { note = '（count>fut 但 ≤' + (GROSS_PCT * 100) + '%，口径差，不告警）'; }
    console.log('  ✔ evo ' + r.id + '：算出 ' + r.count + ' / fut ' + r.fut + note);
  });
  console.log('[gen_evo_eligible] 告警进化数：' + warnCount + ' / ' + report.length + '（正常 ' + okCount + '，其中 fut 超名册总量 ' + overTotalCount + '）');

  // 未实现约束告警
  const unimplKeys = Object.keys(ctx.unimplemented);
  if (unimplKeys.length) {
    console.log('\n[gen_evo_eligible] ── 保守放行（未实现约束，名单可能偏全/偏少，需人工核对）──');
    unimplKeys.sort().forEach(function (k) { console.log('  · ' + k + '（命中 ' + ctx.unimplemented[k] + ' 个进化）'); });
  } else {
    console.log('\n[gen_evo_eligible] 未实现约束：无');
  }
  if (ctx.missingFields.weight) console.log('  · weight 约束：名册无 weight 字段，已保守放行 ' + ctx.missingFields.weight + ' 次');
  if (ctx.missingFields.dateOfBirth) console.log('  · dateOfBirth 缺失：已保守放行 ' + ctx.missingFields.dateOfBirth + ' 次');
  if (ctx.missingAttr) console.log('  · attributes 缺失（含属性约束但无详情）：已排除 ' + ctx.missingAttr + ' 人次');

  if (CHECK_ONLY) {
    console.log('\n[gen_evo_eligible] --checkonly 完成，未产出文件。');
    return;
  }

  // 新鲜度护栏：仅 --upload 生效。当天进化数据未刷新则保留昨日缓存，跳过本次生成。
  if (DO_UPLOAD) {
    const fr = await checkFresh(db, 30);
    if (!fr.ok) {
      console.log('[gen_evo_eligible] ⚠️ 新鲜度护栏触发：进化数据未刷新（最新 _fetchedAt=' + fr.maxFetched +
        '，已 ' + (fr.ageMs != null ? Math.round(fr.ageMs / 3600000) : '?') + 'h）。保留昨日缓存，跳过本次生成。');
      console.log('[gen_evo_eligible] （如需强制生成，请先确认当日抓取已完成，或临时调大窗口。）');
      return;
    } else {
      console.log('[gen_evo_eligible] 新鲜度 OK：进化数据最新 _fetchedAt=' + fr.maxFetched + (fr.reason ? '（' + fr.reason + '）' : ''));
    }
  }

  // 本地落盘（模拟 + 便于调试）
  const outDir = path.join(ROOT, 'cloud-data', 'fc' + VER, 'evo_eligible');
  fs.mkdirSync(outDir, { recursive: true });
  jobs.forEach(function (j) {
    const local = path.join(ROOT, 'cloud-data', 'fc' + VER, j.cloudPath.replace('fc27/data/', ''));
    fs.mkdirSync(path.dirname(local), { recursive: true });
    fs.writeFileSync(local, JSON.stringify(j.obj) + '\n', 'utf8');
  });
  console.log('\n[gen_evo_eligible] 本地落盘 ' + jobs.length + ' 个文件 → ' + path.relative(ROOT, outDir));

  if (DO_UPLOAD) {
    console.log('[gen_evo_eligible] 上传云存储公有读…');
    await uploadMany(app, jobs);
    console.log('[gen_evo_eligible] 上传完成：' + (require('os').hostname()) );
  } else {
    console.log('[gen_evo_eligible] 模拟模式：未上传（加 --upload 或 CI 触发）');
  }
  console.log('[gen_evo_eligible] 完成。updatedAt=' + updatedAt);
}

if (require.main === module) {
  main().catch(function (e) {
    console.error('[gen_evo_eligible] 失败：' + (e && e.message || e));
    process.exit(1);
  });
}

module.exports = {
  matchNonAttr: matchNonAttr,
  matchAttrOnly: matchAttrOnly,
  hasAttrConstraint: hasAttrConstraint,
  scanUnimplemented: scanUnimplemented,
  mainPosOnly: mainPosOnly,
  playerPosSet: playerPosSet,
  ageAt: ageAt,
  IMPLEMENTED_KEYS: IMPLEMENTED_KEYS,
  RE_ATTR_ANY: RE_ATTR_ANY,
  posName: posName
};
