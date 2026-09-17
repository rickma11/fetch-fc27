#!/usr/bin/env node
/**
 * 一次性清理「幽灵孪生卡」：fut.gg 自 2026-09-15 起对一批转会/更新球员同时返回
 * 新旧两个 id（列表 API 两条都在），fetch_ci 按 eaId 去重失效 → 两条都入库；
 * 详情只 enrichment 到新 id → 出现「同名同总评同稀有度两张卡，一张有角色/SBC 一张没有」。
 *
 * 本脚本做什么（对每组命中「恰好一方有角色/sbcPoints、另一方全无」且位置兼容的组）：
 *   1. 老记录有 details 文档而保留方没有 → 把详情文档迁移到保留方 eaId（SBC 积分不丢）；
 *      双方都有 → 保留方的为准，删老详情。
 *   2. hot_fc27 浏览记录合并到保留方（h 小时桶求和、views 求和、lastViewAt 取新）。
 *   3. 删除老记录（players + 残留 details）。
 *   4. 产出黑名单 cloud-data/fc27/dup_ghost_ids.json —— fetch_ci.js 会把它从每次
 *      抓取列表中剔除（进 removedIds 删除链路），防止每日抓取把老 id 再写回来。
 *
 * 同名但「双方都有角色」的组是真人不同卡（enriched 计数=2，保留双方）；
 * 「位置冲突」组再用身份信号终裁——DOB 相同或（DOB 缺失时）身高+惯用脚+国籍 3 项全同
 * 判定为同一人（EA 仅改位置，如 RW→RM）放行合并，否则判定不同人跳过。已人工核对：
 * 10 组场位置变体（Rebeca Bernal 等）为幽灵放行；João Costa（Cruzeiro RM vs FC Porto GK）为不同人拦截。
 *
 * 用法：
 *   node scripts/cleanup_ghost_dups.js --ver 27            # dry-run，只打印报告
 *   node scripts/cleanup_ghost_dups.js --ver 27 --apply    # 真删
 * 凭证见 scripts/tcb_env.js。
 */
const tcb = require('@cloudbase/node-sdk');
const path = require('path');
const fs = require('fs');
const { resolve } = require('./tcb_env.js');

const argv = process.argv.slice(2);
let VER = '27';
let APPLY = false;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--ver') VER = argv[i + 1];
  else if (argv[i].startsWith('--ver=')) VER = argv[i].slice(6);
  else if (argv[i] === '--apply') APPLY = true;
}

const cred = resolve();
if (cred.missing && cred.missing.length) { console.error('凭证缺失：' + cred.missing.join(', ')); process.exit(1); }
const app = tcb.init({ env: cred.ENV_ID, secretId: cred.SECRET_ID, secretKey: cred.SECRET_KEY });
const db = app.database();
const _ = db.command;
const P_COL = 'players_fc' + VER;
const D_COL = 'details_fc' + VER;
const H_COL = 'hot_fc' + VER;

function isEnriched(p) {
  return ((p.rolesPlus || []).length + (p.rolesPlusPlus || []).length) > 0 || p.sbcPoints !== undefined;
}
function posOf(p) { return p.position || ''; }

(async () => {
  // 1. 全量拉 players（只要判定字段）
  const all = [];
  let offset = 0;
  while (true) {
    const r = await db.collection(P_COL)
      .field({ commonName: true, overall: true, rarity: true, position: true, club: true, nation: true, eaId: true, rolesPlus: true, rolesPlusPlus: true, sbcPoints: true, createdAt: true, dateOfBirth: true, height: true, foot: true })
      .skip(offset).limit(1000).get();
    all.push(...r.data);
    if (r.data.length < 1000) break;
    offset += 1000;
  }
  console.log('players_fc' + VER + ' 总数:', all.length, APPLY ? '（APPLY 模式）' : '（dry-run）');

  // 2. 分组
  const groups = new Map();
  for (const p of all) {
    const rarity = p.rarity && p.rarity.name;
    if (!p.commonName || !rarity) continue;
    const key = p.commonName + '|' + p.overall + '|' + rarity;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  }

  // 3. 判定 ghost 组
  const plans = [];   // { key, winner, losers[] }
  const skipped = [];
  for (const [key, list] of groups) {
    const ids = new Set(list.map(p => p.eaId));
    if (ids.size < 2) continue;
    const enr = list.filter(isEnriched);
    const plain = list.filter(p => !isEnriched(p));
    if (enr.length !== 1 || plain.length < 1) { skipped.push({ key, why: 'enriched 计数 ' + enr.length, ids: list.map(p => p.eaId) }); continue; }
    // 位置兼容：相同，或任一方缺 position。位置冲突时用「出生日期 → 身高+惯用脚+国籍」终裁：
    // 真幽灵（同一张卡被 fut.gg 换 id，EA 仅改了位置如 RW→RM）这些身体信号必全相同 → 放行合并；
    // 同名不同人（如 João Costa：Cruzeiro RM 178/Left  vs  FC Porto GK 185/Right）必命中差异 → 拦截。
    // 注意：俱乐部/联赛不参与判定——id 迁移的老记录常带过期俱乐部，反而造成误判。
    const w = enr[0];
    const badPos = plain.filter(p => posOf(p) && posOf(w) && posOf(p) !== posOf(w));
    if (badPos.length) {
      // 放行条件：位置冲突的每一对，DOB 都存在且相同，或（DOB 缺失时）身高+惯用脚+国籍 3 项全同。
      const samePlayer = (loser) => {
        if (loser.dateOfBirth && w.dateOfBirth && loser.dateOfBirth === w.dateOfBirth) return true;
        const s = (p) => [p.height, p.foot, p.nation && p.nation.name];
        const a = s(loser), b = s(w);
        return a.every((v, i) => v != null && b[i] != null && v === b[i]);
      };
      const allSame = badPos.every(samePlayer);
      if (!allSame) {
        skipped.push({ key: key, why: '位置冲突 ' + posOf(w) + ' vs ' + badPos.map(posOf).join('/') + '（身份信号不符=不同人）', ids: list.map(p => p.eaId) });
        continue;
      }
    }
    plans.push({ key, winner: w, losers: plain });
  }
  console.log('命中待清理组:', plans.length, ' 跳过组:', skipped.length);
  skipped.forEach(s => console.log('  SKIP', s.key, '|', s.why, '|', s.ids.join(',')));

  const ghostIds = plans.flatMap(p => p.losers.map(l => l.eaId));
  const winnerIds = [...new Set(plans.map(p => p.winner.eaId))];
  console.log('将删除老记录:', ghostIds.length, '条; 保留方:', winnerIds.length, '条');

  // 4. details / hot 现状
  async function fetchBy(field, ids) {
    const out = new Map();
    for (let i = 0; i < ids.length; i += 500) {
      const r = await db.collection(field === 'det' ? D_COL : H_COL)
        .where(field === 'det' ? { eaId: _.in(ids.slice(i, i + 500)) } : { _id: _.in(ids.slice(i, i + 500).map(String)) })
        .get();
      (r.data || []).forEach(d => out.set(field === 'det' ? d.eaId : Number(d._id), d));
    }
    return out;
  }
  const detMap = await fetchBy('det', [...ghostIds, ...winnerIds]);
  const hotMap = await fetchBy('hot', [...ghostIds, ...winnerIds]);
  console.log('details 命中:', detMap.size, ' hot 命中:', hotMap.size);

  // 5. 执行计划
  let migDet = 0, delDet = 0, mergeHot = 0, copyHot = 0, delPlayer = 0;
  for (const plan of plans) {
    const w = plan.winner;
    for (const loser of plan.losers) {
      const wDet = detMap.get(w.eaId), lDet = detMap.get(loser.eaId);
      if (lDet) {
        const body = Object.assign({}, lDet);
        delete body._id;
        body.eaId = w.eaId;
        if (!wDet) {
          if (APPLY) await db.collection(D_COL).doc(String(w.eaId)).set(body);
          migDet++;
        } else if (APPLY) {
          await db.collection(D_COL).doc(String(loser.eaId)).remove();
        }
        if (wDet) delDet++; else if (!APPLY) { /* dry-run 计入 migDet 即可 */ }
      }
      const wHot = hotMap.get(w.eaId), lHot = hotMap.get(loser.eaId);
      if (lHot) {
        if (!wHot) {
          const body = Object.assign({}, lHot);
          delete body._id;
          if (APPLY) await db.collection(H_COL).doc(String(w.eaId)).set(body);
          copyHot++;
        } else {
          const h = Object.assign({}, (wHot.h || {}));
          for (const [k, v] of Object.entries(lHot.h || {})) h[k] = (h[k] || 0) + v;
          const body = { h: h, views: (wHot.views || 0) + (lHot.views || 0), lastViewAt: (wHot.lastViewAt || '') > (lHot.lastViewAt || '') ? wHot.lastViewAt : lHot.lastViewAt };
          if (APPLY) await db.collection(H_COL).doc(String(w.eaId)).update(body);
          mergeHot++;
        }
        if (APPLY) await db.collection(H_COL).doc(String(loser.eaId)).remove();
      }
      if (APPLY) await db.collection(P_COL).doc(String(loser.eaId)).remove();
      delPlayer++;
    }
  }
  console.log('计划统计: 详情迁移', migDet, ' 详情删除', delDet, ' hot复制', copyHot, ' hot合并', mergeHot, ' 球员删除', delPlayer);

  // 6. 黑名单落盘
  const ghostPath = path.resolve(__dirname, '..', 'cloud-data', 'fc' + VER, 'dup_ghost_ids.json');
  fs.writeFileSync(ghostPath, JSON.stringify(ghostIds.sort((a, b) => a - b)));
  console.log('黑名单已写', path.relative(process.cwd(), ghostPath), '(', ghostIds.length, '个 id )');

  // 7. 报告留档
  const report = {
    generatedAt: new Date().toISOString(), ver: VER, apply: APPLY,
    groups: plans.length, skippedGroups: skipped, ghostIds: ghostIds,
    pairs: plans.map(p => ({ keep: p.winner.eaId, name: p.winner.commonName, overall: p.winner.overall, rarity: p.winner.rarity && p.winner.rarity.name, removed: p.losers.map(l => l.eaId) }))
  };
  fs.writeFileSync(path.resolve(__dirname, '..', 'cloud-data', 'fc' + VER, 'dup_ghost_report.json'), JSON.stringify(report, null, 1));
  console.log(APPLY ? '✅ 已执行清理' : '（dry-run 结束，加 --apply 真删）');
})().catch(e => { console.error('ERR', e.code || '', e.message); process.exit(1); });
