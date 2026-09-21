'use strict';
// SBC 数据上云：把烘焙好中文（*Zh 字段）的 cloud-data/fc{ver}/sbcs.json#sets
// 全量 upsert 到云数据库集合 sbcs_fc{ver}（主键 _id = String(set.id)）。
//
// ⚠️ 口径对齐 upload_db.js：只 upsert（doc(id).set 整体覆盖）、绝不 clear+reinsert；
//    重复执行幂等安全。SBC 数据量小（当前 10 条 / 约 44KB），无瘦身必要，
//    challenges[] 随整条入库（云函数 get_sbcs list 直接全量返回）。
//
// 用法：node scripts/upload_sbcs.js --ver 27
const fs = require('fs');
const path = require('path');
const { resolve } = require('./tcb_env');

function argVer() {
  const a = process.argv.find(x => x.startsWith('--ver='));
  if (a) return Number(a.slice(6));
  const i = process.argv.indexOf('--ver');
  return i >= 0 ? Number(process.argv[i + 1]) : 27;
}

const VER = argVer() || 27;
const SRC = path.resolve(__dirname, '..', 'cloud-data', 'fc' + VER, 'sbcs.json');

const d = JSON.parse(fs.readFileSync(SRC, 'utf8'));
const sets = d.sets || [];
if (!sets.length) { console.error('sbcs.json 无 sets，终止'); process.exit(1); }

const fetchedAt = d.fetchedAt || new Date().toISOString();
const docs = sets.map(s => Object.assign({}, s, { _id: String(s.id), _fetchedAt: fetchedAt }));

(async () => {
  const cred = resolve();
  if (cred.missing.length) {
    console.error('缺少云开发凭证，无法上传：\n' + cred.hint);
    process.exit(1);
  }
  const cloudbase = require('@cloudbase/node-sdk');
  const app = cloudbase.init({ env: cred.ENV_ID, secretId: cred.SECRET_ID, secretKey: cred.SECRET_KEY, timeout: 120000 });
  const db = app.database();
  const col = 'sbcs_fc' + VER;

  // 集合不存在则自动创建（已存在时报错忽略）
  try { await db.createCollection(col); console.log('已创建集合', col); }
  catch (e) { console.log('集合', col, '已存在（或创建失败忽略）:', (e && e.message || '').slice(0, 80)); }

  let ok = 0, fail = 0;
  for (const doc of docs) {
    const body = Object.assign({}, doc);
    const id = body._id;
    delete body._id; // doc(id) 已指定主键，body 不能再带 _id
    let done = false, lastErr = null;
    for (let k = 1; k <= 3 && !done; k++) {
      try { await db.collection(col).doc(id).set(body); done = true; }
      catch (e) { lastErr = e; await new Promise(r => setTimeout(r, 1000 * k)); }
    }
    if (done) { ok++; console.log('  UP', col, id, doc.nameZh || doc.name); }
    else { fail++; console.error('  FAIL', col, id, (lastErr && lastErr.message) || lastErr); }
  }
  console.log('SBC 上云完成: ' + col + ' 成功 ' + ok + ' | 失败 ' + fail + ' | fetchedAt=' + fetchedAt);

  // ── SBC 积分兑换回写（2026-09-20）──────────────────────────────────────────
  // 从 sbcs.json 反查「奖励球员 → 该 SBC 的 scoreRequirement」：只有 streamlined SBC 有 scoreRequirement
  // （如 Bouaddi 20000 / Gold Re-Roll 1250 / Bronze+Silver 500），包兑换类恒为 null → 不回写。
  // 回写到 players_fc27 + details_fc27 两集合（与 sbcPoints 同口径），局部 update 不抹其他字段。
  // 管线每天顺序是 upload_db（doc.set 全量替换，抹平此字段）→ upload_sbcs（本段重补），天然自愈。
  const _ = db.command;
  const costMap = {};  // eaId(number) -> scoreRequirement(number)
  const dup = [];
  sets.forEach(function (s) {
    if (!s.scoreRequirement) return;               // 仅 streamlined SBC
    const ea = (s.awards || []).map(function (a) { return a && a.playerEaId != null ? Number(a.playerEaId) : null; })
      .filter(function (x) { return x != null; })[0];
    if (!ea) return;                                // 包 / 金币类奖励无球员 → 跳过
    if (costMap[ea] != null && costMap[ea] !== Number(s.scoreRequirement)) dup.push(ea);
    costMap[ea] = Number(s.scoreRequirement);
  });
  const eaIds = Object.keys(costMap).map(Number);
  console.log('[sbcCost] 命中球员 ' + eaIds.length + ' 人，冲突 ' + (dup.length ? dup.join(',') : '无'));
  if (eaIds.length) {
    for (const ea of eaIds) {
      const val = costMap[ea];
      for (const c of ['players_fc' + VER, 'details_fc' + VER]) {
        let done = false, lastErr = null;
        for (let k = 1; k <= 3 && !done; k++) {
          try { await db.collection(c).where({ eaId: ea }).update({ sbcCost: val }); done = true; }
          catch (e) { lastErr = e; await new Promise(r => setTimeout(r, 800 * k)); }
        }
        if (done) console.log('  UP', c, 'eaId=' + ea, 'sbcCost=' + val);
        else console.error('  FAIL', c, 'eaId=' + ea, (lastErr && lastErr.message) || lastErr);
      }
    }
    // 清理失效：曾有过 sbcCost 但当前映射已不含该球员（SBC 过期/改名）→ 置空，避免残留旧价。
    for (const c of ['players_fc' + VER, 'details_fc' + VER]) {
      try {
        const stale = await db.collection(c).where({ sbcCost: _.gt(0) }).get();
        const rm = (stale.data || []).filter(function (d) { return eaIds.indexOf(Number(d.eaId)) < 0; });
        for (const d of rm) {
          await db.collection(c).doc(d._id).update({ sbcCost: null });
        }
        if (rm.length) console.log('  CLR', c, '清掉失效 sbcCost ' + rm.length + ' 人');
      } catch (e) { console.error('  CLR-FAIL', c, (e && e.message) || e); }
    }
  }

  process.exit(fail ? 1 : 0);
})();
