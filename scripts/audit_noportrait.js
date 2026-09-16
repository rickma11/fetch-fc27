#!/usr/bin/env node
/**
 * 无像卡面覆盖审计（FC27）
 *
 * 回答一个具体问题：**端上会不会出现空白 / 破图**。
 * 端上 utils/format.js#displayImg 只按 `imagePath` 是否非空二选一：
 *   imagePath 非空 → 取 `{eaId}_card.webp`（fut.gg 卡面）
 *   imagePath 为空 → 取 `{eaId}_np.webp`（我们生成的通用剪影卡）
 * 它**不校验文件是否存在**，所以「字段说没问题、存储里却没文件」= 端上空白/破图。
 * 故本脚本对云库 `imagePath` 为空的球员逐个查云存储，实锤兜底卡面是否齐备。
 *
 * 用法（在 fetch-fc27 目录下执行）：
 *   node scripts/audit_noportrait.js [--ver 27]
 *
 * 输出（stdout + `../_gh_diag/_noportrait_audit.txt`）：
 *   - 本地 / 远端 `cloud-data/fc{ver}/noportrait.json` 条目数（不一致＝本地清单已过期，
 *     本地跑非 dry 前必须先对齐，否则签名判定会失真）
 *   - 云库 `imagePath` 为空的人数、其中有 `cardImagePath`（生成 _np 的前提）的人数
 *   - 这些人 `_np.webp` / `_card.webp` 的存在数，并列出缺失样例
 *   - 判定：缺 `_np.webp` > 0 → 需跑 `no-portrait-only`（它默认带 `--all` 取自云库）
 */
const fs = require('fs');
const path = require('path');
const cloudbase = require('@cloudbase/node-sdk');
const { resolve } = require('./tcb_env');

const VER = (() => { const i = process.argv.indexOf('--ver'); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : '27'; })();
const ROOT = path.resolve(__dirname, '..');
const DIAG = path.resolve(ROOT, '..', '_gh_diag');
const CONC = 8;

const out = [];
const log = s => { out.push(s); console.log(s); };

(async () => {
  const cred = resolve();
  const app = cloudbase.init({ env: cred.ENV_ID, secretId: cred.SECRET_ID, secretKey: cred.SECRET_KEY });
  const db = app.database();
  // 云存储前缀真源同 gen_noportrait_cards.js（桶名由环境派生，勿手写）
  const PREFIX = 'cloud://' + cred.ENV_ID + '.' + (cred.BUCKET || ('636c-' + cred.ENV_ID + '-1475854307')) + `/fc${VER}/images/`;

  log('=== 无像卡面覆盖审计 FC' + VER + '  ' + new Date().toLocaleString('zh-CN') + ' ===');

  // 1) 清单一致性：本地 vs 远端（本地清单若过期，签名判定会失真）
  const localP = path.join(ROOT, 'cloud-data', 'fc' + VER, 'noportrait.json');
  let localN = -1;
  try { localN = Object.keys(JSON.parse(fs.readFileSync(localP, 'utf8'))).length; } catch (e) { }
  let remoteN = -1;
  try {
    const r = await fetch('https://raw.githubusercontent.com/rickma11/fetch-fc27/main/cloud-data/fc' + VER + '/noportrait.json?t=' + Date.now());
    if (r.ok) remoteN = Object.keys(JSON.parse(await r.text())).length;
  } catch (e) { }
  log(`noportrait.json 条目数  本地=${localN} | 远端=${remoteN}` + (localN === remoteN ? '  （一致）' : '  ⚠️ 不一致 —— 本地清单已过期，勿用本地跑非 dry'));

  // 2) 云库里所有 imagePath 为空的球员（= 端上走 _np.webp 的那批）
  const col = db.collection('players_fc' + VER);
  const rows = [];
  for (let i = 0; i < 40; i++) {
    const r = await col.skip(i * 1000).limit(1000).get();
    if (!r.data.length) break;
    for (const d of r.data) {
      const img = typeof d.imagePath === 'string' ? d.imagePath : '';
      if (!img) rows.push({ id: String(d._id), name: d.commonName || d.lastName || '', ovr: d.overall, card: !!d.cardImagePath });
    }
    if (r.data.length < 1000) break;
  }
  log('');
  log('云库 imagePath 为空（端上走 _np.webp）: ' + rows.length + ' 人');
  log('  其中有 cardImagePath（生成 _np 的前提）: ' + rows.filter(r => r.card).length);

  // 3) 逐个查云存储（并发 CONC）
  let okNp = 0; const missNp = [];
  let okCard = 0; const missCard = [];
  const exists = async fileID => {
    try { const r = await app.downloadFile({ fileID }); return !!(r && r.fileContent && r.fileContent.length); } catch (e) { return false; }
  };
  for (let i = 0; i < rows.length; i += CONC) {
    await Promise.all(rows.slice(i, i + CONC).map(async d => {
      const np = await exists(PREFIX + d.id + '_np.webp');
      const cd = await exists(PREFIX + d.id + '_card.webp');
      if (np) okNp++; else missNp.push(d.id + ':' + d.name + '(OVR' + d.ovr + ')');
      if (cd) okCard++; else missCard.push(d.id + ':' + d.name + '(OVR' + d.ovr + ')');
    }));
  }
  log('  有 _np.webp: ' + okNp + ' | ❌ 缺 _np.webp: ' + missNp.length + (missNp.length ? '  → ' + missNp.slice(0, 12).join(' | ') : ''));
  log('  有 _card.webp: ' + okCard + ' | ❌ 缺 _card.webp: ' + missCard.length + (missCard.length ? '  → ' + missCard.slice(0, 12).join(' | ') : ''));
  log('');
  log('判定: ' + (missNp.length === 0
    ? '✅ 无像球员的通用卡面齐备，端上不会出现空白'
    : '⚠️ 有 ' + missNp.length + ' 人会显示空白 → 跑 no-portrait-only（默认带 --all，取自云库）'));

  try {
    if (!fs.existsSync(DIAG)) fs.mkdirSync(DIAG, { recursive: true });
    fs.writeFileSync(path.join(DIAG, '_noportrait_audit.txt'), out.join('\n'));
    console.log('\n（已写入 ' + path.join(DIAG, '_noportrait_audit.txt') + '）');
  } catch (e) { }
  process.exit(0);
})().catch(e => { console.log('ERR', e.message); process.exit(1); });
