// warm_roster.js —— 服务端预热 roster（绕过 get_players 云函数「>1000 条拒绝现场生成」的 3s 限制）
// 背景：meta_fc27/roster 元数据缺失 → 小程序 preloadRoster 每次拿 code=1 → 本地永远无 roster 缓存
//       → 列表页「数据更新于」永远不显示（2026-09-19 诊断实锤）。
// ⚠️ 本脚本的投影/映射逻辑必须与 eafc-miniapp/cloudfunctions/get_players/index.js 的 roster 分支保持一致
//    （投影字段 + computeKeyAttrs + rarityFileKeyOf + ROSTER_SCHEMA_VERSION）。云函数改动时同步改这里。
// 用法：node scripts/warm_roster.js  （每日 CI 在 upload_db 之后跑，保证 ts = 数据更新时间）
const path = require('path');
process.chdir(path.resolve(__dirname));
const { resolve } = require('./tcb_env');

const VER = 27;
const ROSTER_SCHEMA_VERSION = 9;   // 与 get_players/index.js 保持一致（当前 v9）
const COL = 'players_fc' + VER;
const M_COL = 'meta_fc' + VER;

// —— 与 get_players/computeKeyAttrs 同源 ——
function computeKeyAttrs(p) {
  const a = p.attributes || {};
  if (!a || !Object.keys(a).length) {
    return [['PAC', p.facePace || 0], ['SHO', p.faceShooting || 0], ['PAS', p.facePassing || 0], ['DRI', p.faceDribbling || 0], ['DEF', p.faceDefending || 0], ['PHY', p.facePhysicality || 0]];
  }
  const pos = p.position;
  let pairs;
  if (pos === 'GK') pairs = [['扑救', a.attributeGkDiving], ['手抛', a.attributeGkHandling], ['开球', a.attributeGkKicking], ['反应', a.attributeGkReflexes], ['站位', a.attributeGkPositioning]];
  else if (pos === 'ST' || pos === 'CF') pairs = [['射门', a.attributeFinishing], ['头球', a.attributeHeadingAccuracy], ['加速', a.attributeAcceleration], ['力量', a.attributeStrength], ['盘带', a.attributeDribbling], ['反应', a.attributeReactions]];
  else if (pos === 'CB' || pos === 'LB' || pos === 'RB') pairs = [['防守意识', a.attributeDefensiveAwareness], ['正面抢断', a.attributeStandingTackle], ['铲断', a.attributeSlidingTackle], ['头球', a.attributeHeadingAccuracy], ['加速', a.attributeAcceleration], ['力量', a.attributeStrength]];
  else pairs = [['视野', a.attributeVision], ['传球', a.attributeShortPassing], ['盘带', a.attributeDribbling], ['射门', a.attributeFinishing], ['防守意识', a.attributeDefensiveAwareness], ['体能', a.attributeStamina]];
  return pairs.filter(function (x) { return x[1] != null; });
}

// —— 与 get_players/rarityFileKeyOf 同源 ——
function rarityFileKeyOf(imagePath) {
  const base = String(imagePath || '').split('/').pop();
  const m = /\.([0-9a-f]{16,})\./i.exec(base);
  return (m ? m[1] : '').slice(0, 16);
}

(async () => {
  const cred = resolve();
  const cloudbase = require('@cloudbase/node-sdk');
  const app = cloudbase.init({ env: cred.ENV_ID, secretId: cred.SECRET_ID, secretKey: cred.SECRET_KEY, timeout: 120000 });
  const db = app.database();

  // 1) 全量拉取（与云函数相同投影）
  const proj = {
    eaId: true, commonName: true, overall: true, position: true, imagePath: true,
    facePace: true, faceShooting: true, facePassing: true, faceDribbling: true,
    faceDefending: true, facePhysicality: true,
    height: true, createdAt: true, accelerateType: true,
    foot: true, skillMoves: true, weakFoot: true, dateOfBirth: true,
    playstyles: true, playstylesPlus: true,
    alternativePositionIds: true,
    cardSource: true,
    rolesPlus: true, rolesPlusPlus: true,
    seasonPassLevel: true, seasonPassTier: true,
    attributes: true,
    'rarity.imagePath': true,
    'rarity.name': true, 'rarity.rarityGroupName': true,
    'club.name': true, 'league.name': true, 'nation.name': true
  };
  let all = [];
  let skip = 0;
  const t0 = Date.now();
  while (true) {
    const r = await db.collection(COL).field(proj).skip(skip).limit(100).get();
    const d = r.data || [];
    if (!d.length) break;
    all = all.concat(d);
    if (d.length < 100) break;
    skip += 100;
  }
  console.log('fetched', all.length, 'players in', ((Date.now() - t0) / 1000).toFixed(1) + 's');
  if (all.length < 19000) { console.error('安全闸：球员数 <19000，疑似拉取不完整，拒绝写库'); process.exit(1); }

  // 2) 预计算 keyAttrs + rarityImgs（与云函数同逻辑）
  const rarityImgs = {};
  all = all.map(function (p) {
    const k = computeKeyAttrs(p);
    const out = Object.assign({}, p);
    delete out.attributes;
    out.keyAttrs = k;
    if (out.rarity) {
      const rn = out.rarity.name;
      if (rn && out.rarity.imagePath) {
        const fk = rarityFileKeyOf(out.rarity.imagePath);
        if (fk && !rarityImgs[rn]) rarityImgs[rn] = 'rarity_' + fk + '.webp';
      }
      delete out.rarity.imagePath;
    }
    return out;
  });
  console.log('rarityImgs entries:', Object.keys(rarityImgs).length);

  // 3) 上传云存储 + 写 meta 文档
  const ts = Date.now();
  const payload = { version: String(VER), ts: ts, count: all.length, schemaVersion: ROSTER_SCHEMA_VERSION, rarityImgs: rarityImgs, players: all };
  const buf = Buffer.from(JSON.stringify(payload));
  console.log('payload size:', (buf.length / 1024 / 1024).toFixed(2) + 'MB');
  const cloudPath = 'roster/roster_v1_' + VER + '.json';
  const up = await app.uploadFile({ cloudPath: cloudPath, fileContent: buf });
  console.log('uploaded fileID =', up.fileID);
  await db.collection(M_COL).doc('roster').set({ fileID: up.fileID, ts: ts, count: all.length, schemaVersion: ROSTER_SCHEMA_VERSION });
  console.log('meta doc written:', M_COL + '/roster', 'ts=' + ts, '(' + new Date(ts).toISOString() + ')');

  // 4) 端到端验证：调用线上 get_players roster 分支，确认命中缓存
  try {
    const rf = await app.callFunction({ name: 'get_players', data: { version: String(VER), action: 'roster' } });
    const res = (rf && (rf.result || rf.data)) || null;
    if (res && res.code === 0 && res.fileID) {
      console.log('VERIFY OK: get_players roster hit, schemaVersion=' + res.schemaVersion + ', ts=' + res.ts + ' (' + (res.ts ? new Date(res.ts).toISOString() : 'N/A') + '), count=' + res.count);
    } else {
      console.log('VERIFY WARN: get_players roster 未命中 →', JSON.stringify(res).slice(0, 200));
      console.log('  （若 code=1：线上云函数版本过旧或 count/schema 不匹配，需重传 get_players 云函数）');
    }
  } catch (e) {
    console.log('VERIFY SKIP: callFunction 不可用（' + String(e && e.message || e).slice(0, 100) + '）——已写 meta，客户端预载仍应生效');
  }
})().catch(e => { console.error('FATAL', String(e && e.message || e)); process.exit(1); });
