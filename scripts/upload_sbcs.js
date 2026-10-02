'use strict';
// SBC 数据上云：把烘焙好中文（*Zh 字段）的 cloud-data/fc{ver}/sbcs.json#sets
// 全量 upsert 到云数据库集合 sbcs_fc{ver}（主键 _id = String(set.id)）。
//
// ⚠️ 口径对齐 upload_db.js：只 upsert（doc(id).set 整体覆盖）、绝不 clear+reinsert；
//    重复执行幂等安全。SBC 数据量小（当前 10 条 / 约 44KB），无瘦身必要，
//    challenges[] 随整条入库（云函数 get_sbcs list 直接全量返回）。
//
// 用法：
//   node scripts/upload_sbcs.js --ver 27                       # 完整流程：上传 SBC 列表 + 回写 sbcCost
//   node scripts/upload_sbcs.js --ver 27 --skip-sbc-cost       # 只上传 SBC 列表（跳过 sbcCost 回写）
//   node scripts/upload_sbcs.js --ver 27 --sbc-cost-only       # 只回写 sbcCost（不碰 sbcs_fc 集合）
//
// 为什么拆分：fetch-fc27.yml 把 SBC 抓取链提到球员主链之前，SBC 列表可 15 秒内入库；
// 但 sbcCost 回写必须等 upload_db 把球员文档写完后才执行，否则会被 upload_db 的 doc.set 抹掉。
// 故 workflow 里 early 阶段用 --skip-sbc-cost，upload_db 后用 --sbc-cost-only。
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
const SKIP_SBC_COST = process.argv.includes('--skip-sbc-cost');
const SBC_COST_ONLY = process.argv.includes('--sbc-cost-only');

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

  let ok = 0, fail = 0;

  if (!SBC_COST_ONLY) {
    // 集合不存在则自动创建（已存在时报错忽略）
    try { await db.createCollection(col); console.log('已创建集合', col); }
    catch (e) { console.log('集合', col, '已存在（或创建失败忽略）:', (e && e.message || '').slice(0, 80)); }

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
  }

  if (SKIP_SBC_COST) {
    console.log('[sbcCost] --skip-sbc-cost：本阶段不回写 sbcCost，留到 upload_db 之后用 --sbc-cost-only 执行');
    process.exit(0);
  }

  // ── SBC 积分兑换回写（2026-09-20；2026-09-23 扩 Player Pick）────────────────
  // 从 sbcs.json 反查「奖励球员 → 该 SBC 的 scoreRequirement」：只有 streamlined SBC 有 scoreRequirement
  // （如 Bouaddi 20000 / Gold Re-Roll 1250 / Bronze+Silver 500），包兑换类恒为 null → 不回写。
  // 反查两路（buildSbcCostMap，见 sbc_cost_map.js）：
  //   ① awards[].playerEaId（单人 SBC，Bouaddi 类）；
  //   ② choicePlayers 全量（Player Pick 类如 Duo Pick 5258：awards 只有 other 文案、
  //      playerEaId=null —— 旧逻辑反查不到人，导致候选球员详情页「SBC兑换」整行不渲染）。
  // 回写到 players_fc27 + details_fc27 两集合（与 sbcPoints 同口径），局部 update 不抹其他字段。
  // 管线每天顺序是 upload_db（doc.set 全量替换，抹平此字段）→ upload_sbcs（本段重补），天然自愈。
  const _ = db.command;
  const built = require('./sbc_cost_map').buildSbcCostMap(sets);
  const costMap = built.map;   // eaId(number) -> scoreRequirement(number)
  const dup = built.dup;
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
