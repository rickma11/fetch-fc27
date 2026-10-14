// FC27 每日内容弹窗静态 JSON 生成器（2026-10-14）。
//
// 目的：为小程序「每日内容」弹窗（仿 fodder.gg 每日更新卡片）预生成一份聚合 JSON，
//   端上 wx.cloud.downloadFile 直读（零云函数，硬规则 92），每日更新后首次登录弹一次。
//
// 范围（与用户确认）：
//   · 做 SBC + EVO + 每日新增球员
//   · 不做 OBJ（fodder 的 OBJ 数据源未接入生产）
//
// 「新增」判定（与端上 SBC/EVO 页 NEW 标签同源）：
//   · 复刻 utils/newSince.js#markNew 的 id 基线差逻辑 —— 当前批次 id 集合 − 上一轮基线 id 集合，
//     且按批次发布日期闸控（不同日期才比对；首次/同日不误标），次日失效。
//   · 球员「新增」用 gen_home_payload#passNewFeed 口径（overall>=80 或 特殊稀有度），
//     与首页「新增球员」一致；**按 createdAt desc 取最新 10 展示**（与首页 tab 同序同源），
//     >10 时给「还有 N 名新球员 · 查看首页-新增球员」提示。
//     ⚠️ 2026-10-14 修正：旧实现按 overall desc「总评前 10」，展示的是批次里总评最高的**老卡**
//     （10-06/07 的 TOTW 周黑），不是最新新增的卡，与首页列表对不上（用户反馈「球员列表不对」）。
//
// 「即将结束」判定：
//   · SBC / EVO 的 endTime 在 72h 内（>0 且 <=72）。
//   · 球员无到期概念，不进「即将结束」tab。
//
// 数据来源：
//   · 本地 cloud-data/fc27/sbcs.json      （sets 数组，已落盘于 gen_static_lists 之前步）
//   · 本地 cloud-data/fc27/evolutions.json （all 数组）
//   · 云库 players_fc{ver} 按 createdAt desc 取候选 → passNewFeed 过滤（newFeed 口径）
//   · 云库 meta_fc{ver}/dict_basic + dicts/names（装饰中文化，复用 gen_home_payload#loadDicts）
//
// 输出（云存储，复用 gen_static_lists#publishObject）：
//   · fc{ver}/data/daily_content/daily_content.<hash8>.json  （弹窗聚合数据）
//   · 元文档 meta_fc{ver}/daily_content = {fetchedAt,fileID,hash,ts,forceVersion(date)}
//   · fc{ver}/data/daily_baseline/daily_baseline.<hash8>.json （id 基线状态，供次日比对）
//
// ⚠️ 本步是「纯派生」：只读本地落盘 + 云库、只写 daily_content/daily_baseline/daily_baseline 元文档，
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
const META_COLLECTION = 'meta_fc' + VER;
const PLAYERS_COLLECTION = 'players_fc' + VER;
const NEW_CANDIDATE = 120;     // 取最新 120 再用 newFeed 过滤（与 gen_home_payload 同口径）
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

// ── 成本格式化（与端上展示统一）：1227050 → 1.2M，34000 → 34k，0 → 免费 ──
function fmtCost(n) {
  n = Number(n) || 0;
  if (n <= 0) return '免费';
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1e3) return Math.round(n / 1e3) + 'k';
  return String(n);
}

// node-sdk doc().get() 返回 data 可能是数组或对象，统一解包（复用 gen_home_payload#docData 思路）
function docData(r) {
  if (!r) return null;
  const d = r.data;
  if (Array.isArray(d)) return d[0] || null;
  return d || null;
}

// 复刻 utils/newSince.js#markNew 的 id 基线差（服务端版）：
//   curIds: 本批完整 id；prior: {fetchedDate, ids} 上一轮基线；
//   仅当 prior.fetchedDate 存在 且 != 本批日期 且 prior.ids 非空 → 差集为新增；否则无新增。
function diffNew(curIds, prior, fd) {
  if (!prior || !prior.fetchedDate || prior.fetchedDate === fd) return [];
  const priorIds = Array.isArray(prior.ids) ? prior.ids : [];
  if (!priorIds.length) return [];
  const m = {};
  priorIds.forEach(function (id) { m[String(id)] = 1; });
  return curIds.filter(function (id) { return !m[String(id)]; });
}

// ── 读上一轮基线（daily_baseline 对象，落云存储）──
async function readPrevBaseline(app) {
  try {
    const meta = docData(await app.database().collection(META_COLLECTION).doc('daily_baseline').get());
    if (meta && meta.fileID) {
      const dl = await app.downloadFile({ fileID: meta.fileID });
      const buf = dl && dl.fileContent;
      if (buf && buf.length) {
        const o = JSON.parse(buf.toString('utf8'));
        if (o && typeof o === 'object') return o;
      }
    }
  } catch (e) { /* 首轮无基线 */ }
  return null;
}

function nameOf(x) { return (x && (x.nameZh || x.name)) || ''; }

// SBC 单条摘要：成本 + 奖励（首个球员奖励或包名）
function sbcSummary(s) {
  const cost = fmtCost(s.cost);
  let reward = '';
  const aw = Array.isArray(s.awards) ? s.awards : [];
  for (let i = 0; i < aw.length; i++) {
    const a = aw[i];
    if (a && a.player && a.player.commonName) { reward = a.player.commonName; break; }
    if (a && a.pack && a.pack.name) { reward = a.pack.name; break; }
    if (a && a.name) { reward = a.name; break; }
  }
  let s1 = cost === '免费' ? '' : ('成本 ' + cost);
  if (reward) s1 = (s1 ? s1 + ' · ' : '') + ('奖励 ' + reward);
  return s1 || '无奖励信息';
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

// EVO 单条摘要：金币 + 最高总评 + 位置
function evoSummary(e) {
  const coin = fmtCost(e.coinsCost);
  const maxO = e.requirements && e.requirements.maxOverall;
  const pos = evoPositions(e);
  let s1 = '金币 ' + coin;
  if (maxO) s1 += ' · 最高 ' + maxO;
  if (pos) s1 += ' · ' + pos;
  return s1;
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

  const sbcFetchedISO = genStatic.maxFetchedAt(sbcArr) || new Date().toISOString();
  const evoFetchedISO = evoSrc.fetchedAt || genStatic.maxFetchedAt(evoRaw) || new Date().toISOString();
  const sbcFd = dateStr(sbcFetchedISO);
  const evoEvo = dateStr(evoFetchedISO);

  // 2) 上一轮基线（仅上传路径需要；本地校验可跳过）
  let prior = null;
  let app = null;
  if (!NO_UPLOAD) {
    app = genStatic.initCloud();
    prior = await readPrevBaseline(app);
  }

  // 3) 算新增挑战（id 基线差）
  const sbcCurIds = sbcArr.map(function (s) { return String(s.id); });
  const evoCurIds = evoRaw.map(function (e) { return String(e.id); });
  const sbcNewIds = diffNew(sbcCurIds, prior && prior.sbcs, sbcFd);
  const evoNewIds = diffNew(evoCurIds, prior && prior.evolutions, evoEvo);
  const sbcNewSet = {};
  sbcNewIds.forEach(function (id) { sbcNewSet[id] = 1; });
  const evoNewSet = {};
  evoNewIds.forEach(function (id) { evoNewSet[id] = 1; });

  const newChallenges = [];
  sbcArr.forEach(function (s) {
    if (!sbcNewSet[String(s.id)]) return;
    newChallenges.push({ id: String(s.id), type: 'sbc', name: nameOf(s), summary: sbcSummary(s), endTime: s.endTime || '' });
  });
  evoRaw.forEach(function (e) {
    if (!evoNewSet[String(e.id)]) return;
    newChallenges.push({ id: String(e.id), type: 'evo', name: nameOf(e), summary: evoSummary(e), endTime: e.endTime || '' });
  });

  // 4) 算即将结束（endTime 在 72h 内）
  const ending = [];
  sbcArr.concat(evoRaw).forEach(function (x) {
    const rh = remainHours(x.endTime);
    if (rh != null && rh > 0 && rh <= ENDING_WINDOW_H) {
      const type = ('cost' in x) ? 'sbc' : 'evo';   // SBC 有 cost 字段、EVO 没有
      ending.push({
        id: String(x.id), type: type, name: nameOf(x),
        summary: type === 'sbc' ? sbcSummary(x) : evoSummary(x),
        endTime: x.endTime || '', remainHours: Math.round(rh * 10) / 10
      });
    }
  });

  // 5) 每日新增球员（newFeed 口径；createdAt desc 取最新 10，与首页「新增球员」tab 同序同源）
  let newPlayers = [];
  let newPlayersTotal = 0;
  if (!NO_UPLOAD && app) {
    const dicts = await home.loadDicts(app);
    const db = app.database();
    const nr = await db.collection(PLAYERS_COLLECTION).orderBy('createdAt', 'desc').limit(NEW_CANDIDATE).get();
    const cands = (nr.data || []).filter(home.passNewFeed);
    newPlayersTotal = cands.length;
    // ⚠️ 不要重排：cands 已是 createdAt desc（云库返回序），与首页 home_new 完全同序；
    //   若改按 overall desc 重排，弹窗会变成「总评最高的老卡」，与首页列表不一致（2026-10-14 已修正）。
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
        img: p.img || ''
      };
    });
  } else {
    console.log('（--no-upload：球员需云库，跳过；前端将显示空）');
  }

  // 6) 组装 daily_content 对象
  const date = dateStr(Date.now());
  const daily = {
    date: date,
    newPlayers: newPlayers,
    newPlayersTotal: newPlayersTotal,
    newChallenges: newChallenges,
    ending: ending
  };

  // 7) 写基线（不论上传与否先在内存记录；上传时落云）
  const baseline = {
    sbcs: { fetchedDate: sbcFd, ids: sbcCurIds },
    evolutions: { fetchedDate: evoEvo, ids: evoCurIds }
  };

  console.log('[gen_daily_content] date=' + date);
  console.log('[gen_daily_content] SBC: 总数 ' + sbcArr.length + ' / 新增 ' + sbcNewIds.length);
  console.log('[gen_daily_content] EVO: 总数 ' + evoRaw.length + ' / 新增 ' + evoNewIds.length);
  console.log('[gen_daily_content] 新挑战合计 ' + newChallenges.length + ' / 即将结束 ' + ending.length);
  console.log('[gen_daily_content] 新增球员 展示 ' + newPlayers.length + ' / 总数 ' + newPlayersTotal +
    (newPlayersTotal > PLAYER_TOP ? '（超 10，提示引导首页）' : ''));

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
  await genStatic.publishObject(app, 'daily_baseline', baseline);
  console.log('\n=== gen_daily_content 完成 ===');
}

if (require.main === module) {
  run().catch(function (e) {
    console.error('[gen_daily_content] 失败：', e && e.message);
    process.exit(1);
  });
}

module.exports = { dateStr: dateStr, fmtCost: fmtCost, diffNew: diffNew, sbcSummary: sbcSummary, evoSummary: evoSummary };
