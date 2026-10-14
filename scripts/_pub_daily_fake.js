// 一次性：本地发布「每日内容」演示数据，用于端上弹窗 UI 验证。
//
//   · 新增球员：真实数据（云库 players_fc27 最新 120 → newFeed 口径 → 总评前 10）
//   · 新挑战：取自**真实源数据**（cloud-data/fc27/sbcs.json / evolutions.json 里的真实记录），
//             名称 + 成本 + 奖励一律用 gen_daily_content.js 的 sbcSummary / evoSummary 计算
//             —— 与生产管线、SBC 详情页 / 进化详情页完全同口径（⚠️ 2026-10-14 修正：
//             旧版这里手写死摘要，把「德甲九月最佳球员」的奖励写成了 Kai Havertz，
//             真实奖励是 Michael Olise —— 用户反馈「奖励和 SBC 详情页不一致」，故改为一律从源数据派生，
//             本脚本自此不再出现任何手写的奖励/成本文案）。
//   · 即将结束：同样的真实记录 + 真实摘要；仅 remainHours 是**演示值**（真实 endTime 已过期/超窗口，
//             这里给一个 72h 内的值只为看版式）。
//
// ⚠️ 仅演示用，不要接进 CI；正式数据由 gen_daily_content.js 生成。
// 用法：node scripts/_pub_daily_fake.js
'use strict';

const fs = require('fs');
const path = require('path');
const genStatic = require('./gen_static_lists.js');
const home = require('./gen_home_payload.js');
const genDaily = require('./gen_daily_content.js');   // sbcSummary / evoSummary / fmtCost（生产同款）

const ROOT = path.resolve(__dirname, '..');
const VER = 27;
const PLAYERS_COLLECTION = 'players_fc' + VER;
const NEW_CANDIDATE = 120;
const PLAYER_TOP = 10;

// 演示选用id（全部是源数据里真实存在的记录）
const NEW_SBC_IDS = ['5274', '5273'];   // Bundesliga / Serie A POTM September（源数据 isNew=true）
const NEW_EVO_IDS = ['2497', '2500'];   // Winger Glow Up [SP+ 26] / Believe
const END_SBC_ID = '5272';              // Davide Frattesi
const END_EVO_ID = '2506';              // Creative Crossroads

function dateStr(ts) {
  const t = new Date(ts + 8 * 3600 * 1000);
  const p = function (n) { return (n < 10 ? '0' : '') + n; };
  return t.getUTCFullYear() + '-' + p(t.getUTCMonth() + 1) + '-' + p(t.getUTCDate());
}

function byId(arr, id) {
  return (arr || []).filter(function (x) { return String(x && x.id) === String(id); })[0] || null;
}

async function run() {
  const app = genStatic.initCloud();

  // 1) 真实源数据（SBC / 进化）
  const sbcSrc = JSON.parse(fs.readFileSync(path.join(ROOT, 'cloud-data/fc27/sbcs.json'), 'utf8'));
  const evoSrc = JSON.parse(fs.readFileSync(path.join(ROOT, 'cloud-data/fc27/evolutions.json'), 'utf8'));
  const sbcArr = Array.isArray(sbcSrc.sets) ? sbcSrc.sets : [];
  const evoArr = Array.isArray(evoSrc.all) ? evoSrc.all : [];

  // 2) 真实新增球员（云库）
  const dicts = await home.loadDicts(app);
  const db = app.database();
  const nr = await db.collection(PLAYERS_COLLECTION).orderBy('createdAt', 'desc').limit(NEW_CANDIDATE).get();
  const cands = (nr.data || []).filter(home.passNewFeed);
  cands.sort(function (a, b) { return (Number(b.overall) || 0) - (Number(a.overall) || 0); });
  const top = cands.slice(0, PLAYER_TOP);
  home.decorate(top, dicts);
  const newPlayers = top.map(function (p) {
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

  // 3) 新挑战：名称 + 成本 + 奖励**全部由真实记录派生**（与 SBC/进化详情页同口径）
  const newChallenges = [];
  NEW_SBC_IDS.forEach(function (id) {
    const r = byId(sbcArr, id);
    if (!r) { console.warn('⚠️ sbcs.json 里找不到 id=' + id + '，跳过'); return; }
    newChallenges.push({ id: id, type: 'sbc', name: r.name, summary: genDaily.sbcSummary(r), endTime: r.endTime || '' });
  });
  NEW_EVO_IDS.forEach(function (id) {
    const r = byId(evoArr, id);
    if (!r) { console.warn('⚠️ evolutions.json 里找不到 id=' + id + '，跳过'); return; }
    newChallenges.push({ id: id, type: 'evo', name: r.name, summary: genDaily.evoSummary(r), endTime: r.endTime || '' });
  });

  // 4) 即将结束：真实记录 + 真实摘要，只有 remainHours 是演示值
  const ending = [];
  const endSbc = byId(sbcArr, END_SBC_ID);
  if (endSbc) ending.push({ id: END_SBC_ID, type: 'sbc', name: endSbc.name, summary: genDaily.sbcSummary(endSbc), endTime: endSbc.endTime || '', remainHours: 6.2 });
  const endEvo = byId(evoArr, END_EVO_ID);
  if (endEvo) ending.push({ id: END_EVO_ID, type: 'evo', name: endEvo.name, summary: genDaily.evoSummary(endEvo), endTime: endEvo.endTime || '', remainHours: 30.4 });

  const daily = {
    date: dateStr(Date.now()),
    newPlayers: newPlayers,
    newPlayersTotal: cands.length || newPlayers.length,
    newChallenges: newChallenges,
    ending: ending
  };

  console.log('date =', daily.date);
  console.log('newPlayers 展示', newPlayers.length, '/ 总数', daily.newPlayersTotal);
  console.log('newChallenges', newChallenges.length, '| ending', ending.length);
  console.log('--- 新挑战（摘要均取自真实源数据，可与 SBC/进化详情页核对）---');
  newChallenges.forEach(function (x) { console.log('  [' + x.type + '] id=' + x.id + ' ' + x.name + '  =>  ' + x.summary); });
  console.log('--- 即将结束 ---');
  ending.forEach(function (x) { console.log('  [' + x.type + '] id=' + x.id + ' ' + x.name + '  =>  ' + x.summary + '  剩 ' + x.remainHours + 'h(演示值)'); });

  await genStatic.publishObject(app, 'daily_content', daily);
  console.log('=== 已发布 daily_content（演示数据）===');
}

run().catch(function (e) { console.error('失败：', e && e.message); process.exit(1); });
