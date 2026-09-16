#!/usr/bin/env node
/**
 * 云库 FC27 数据体检 —— 核对落库完整性，用于每次 data-only / full run 后回归。
 *
 * 用法：
 *   node scripts/check_cloud_fc27.js [--ver 27] [--sample 500]
 *
 * 输出（同时打印到 stdout 与 _gh_diag/_cloud_check_fc<ver>.txt）：
 *   - players_fc27 / details_fc27 真实总数（skip 分页交叉 count()，count 有时不准）
 *   - OVR 分段人数：<=47 / 48-89 / >=90   ← 用于发现「分桶漏抓」
 *   - sbcPoints 非空人数                 ← 用于确认 SBC 积分是否已回填
 *   - rolesPlus / rolesPlusPlus 非空人数（抽样统计）
 *   - 若干带 sbcPoints 的样本
 *
 * 判据（正常基线）：总数 ≈ 21000、48-89 段 > 0、<=47 段 > 0、sbcPoints > 0。
 */
const fs = require('fs');
const path = require('path');
const cloudbase = require('@cloudbase/node-sdk');
const { resolve } = require('./tcb_env');

const argv = process.argv.slice(2);
function opt(name, def) {
  const i = argv.indexOf('--' + name);
  return i >= 0 ? argv[i + 1] : def;
}
const VER = String(opt('ver', '27'));
const SAMPLE = parseInt(opt('sample', '500'), 10);

const OUT_DIR = path.join(__dirname, '..', '..', '_gh_diag');
const lines = [];
function log(s) { lines.push(s); console.log(s); }

(async () => {
  const cred = resolve();
  const app = cloudbase.init({ env: cred.ENV_ID, secretId: cred.SECRET_ID, secretKey: cred.SECRET_KEY });
  const db = app.database();
  const _ = db.command;
  const pCol = db.collection('players_fc' + VER);
  const dCol = db.collection('details_fc' + VER);

  // count() 在部分环境下返回不准，用 skip 分页交叉验证
  async function realTotal(col) {
    let total = 0;
    for (let i = 0; i < 60; i++) {
      const r = await col.skip(i * 1000).limit(1000).get();
      total += r.data.length;
      if (r.data.length < 1000) break;
    }
    return total;
  }

  log('=== 云库 FC' + VER + ' 数据体检 ' + new Date().toLocaleString('zh-CN') + ' ===');

  const pTotal = await realTotal(pCol);
  const dTotal = await realTotal(dCol);
  log('players_fc' + VER + ' 总数: ' + pTotal);
  log('details_fc' + VER + ' 总数: ' + dTotal);

  // OVR 分段
  const segLow = await pCol.where({ overall: _.lte(47) }).count();
  const segMid = await pCol.where({ overall: _.and(_.gte(48), _.lte(89)) }).count();
  const segHigh = await pCol.where({ overall: _.gte(90) }).count();
  log('OVR 分布: <=47 = ' + segLow.total + ' | 48-89 = ' + segMid.total + ' | >=90 = ' + segHigh.total);

  // sbcPoints
  const sbcCnt = await pCol.where({ sbcPoints: _.gt(0) }).count();
  log('sbcPoints > 0 人数: ' + sbcCnt.total);

  // rolesPlus / rolesPlusPlus（抽样）
  const sample = await pCol.limit(SAMPLE).get();
  // 图片路径新旧格式统计：旧格式 `27/players/prelaunch-photos-v2/…`（fut.gg 早期半身像路径）、
  // 新格式 `2027/player-item/…`。**两者都是真实头像，不是占位图**；旧格式占多说明数据快照偏旧，
  // 需重跑抓取。真正「无半身像」只认 imagePath 为空。
  let rp = 0, rpp = 0, legacyImg = 0, emptyImg = 0;
  const sbcSamples = [];
  for (const d of sample.data) {
    if (Array.isArray(d.rolesPlus) && d.rolesPlus.length) rp++;
    if (Array.isArray(d.rolesPlusPlus) && d.rolesPlusPlus.length) rpp++;
    if (typeof d.imagePath === 'string' && /prelaunch-photos/i.test(d.imagePath)) legacyImg++;
    if (!d.imagePath) emptyImg++;
    if (d.sbcPoints > 0 && sbcSamples.length < 5) {
      sbcSamples.push({ eaId: d.eaId, name: d.commonName || d.lastName, overall: d.overall, sbcPoints: d.sbcPoints });
    }
  }
  log('抽样 ' + sample.data.length + ' 人: rolesPlus 非空 ' + rp + ' | rolesPlusPlus 非空 ' + rpp +
    ' | imagePath 空 ' + emptyImg + ' | imagePath 旧格式(prelaunch) ' + legacyImg);
  if (sbcSamples.length) {
    log('sbcPoints 样本:');
    sbcSamples.forEach(s => log('  ' + JSON.stringify(s)));
  } else {
    log('sbcPoints 样本: 无（尚未回填）');
  }

  // 哨兵核查：指定 eaId 逐个打印关键字段（用于确认个案是否修复，如 --ids 216594）
  const idsArg = opt('ids', '');
  if (idsArg) {
    log('--- 哨兵核查 ---');
    for (const id of idsArg.split(',').map(s => s.trim()).filter(Boolean)) {
      try {
        const r = await pCol.doc(id).get();
        const arr = Array.isArray(r.data) ? r.data : [r.data];
        const d = arr[0];
        if (!d) { log('  ' + id + ': 文档不存在'); continue; }
        const isPh = typeof d.imagePath === 'string' && d.imagePath && PH_RE.test(d.imagePath);
        log('  ' + id + ' ' + (d.commonName || d.lastName || '') + ' OVR' + d.overall +
          ' | imagePath=' + JSON.stringify(d.imagePath) + (isPh ? ' ← ⚠️占位图' : (d.imagePath ? ' ← 真图' : ' ← 空(走 _np)')) +
          ' | 端上显示 ' + (d.imagePath ? '{id}_card.webp' : '{id}_np.webp') +
          ' | sbcPoints=' + JSON.stringify(d.sbcPoints));
      } catch (e) { log('  ' + id + ': 查询失败 ' + e.message); }
    }
  }

  // 健康判据
  const okTotal = pTotal >= 19000;
  const okMid = segMid.total > 0;
  const okLow = segLow.total > 0;
  const okSbc = sbcCnt.total > 0;
  const verdict = [];
  if (!okTotal) verdict.push('总数异常(<' + 19000 + ')');
  if (!okMid) verdict.push('中段 OVR 48-89 缺失');
  if (!okLow) verdict.push('低段 OVR <=47 缺失');
  if (!okSbc) verdict.push('sbcPoints 未回填');
  log('判定: ' + (verdict.length ? '异常 —— ' + verdict.join('，') : '正常（总数/各段齐全/sbcPoints 已回填）'));

  try {
    if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(path.join(OUT_DIR, '_cloud_check_fc' + VER + '.txt'), lines.join('\n'), 'utf8');
  } catch (e) { /* 写盘失败不影响主流程 */ }

  process.exit(0);
})().catch(e => {
  log('ERR ' + e.message);
  try {
    if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(path.join(OUT_DIR, '_cloud_check_fc' + VER + '.txt'), lines.join('\n'), 'utf8');
  } catch (e2) { }
  process.exit(1);
});
