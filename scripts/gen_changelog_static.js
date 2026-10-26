// changelog 静态 JSON 发布器（替代云函数 cloudfunctions/get_changelog 的 republish 职责，2026-10-26）。
//
// 背景：原 get_changelog 云函数每小时定时触发，读云库 dicts/changelog → republish 静态 JSON。
//   2026-10-26 起退役：数据真源改为**仓库内源文件**，本脚本由 CI（changelog.yml，cron-job.org 每小时触发）执行。
//   端上 utils/changelog.js 只走 cloudJson.fetchList('changelog',{fresh:true}) 静态直读（B 线已删，零云函数）。
//
// 数据流：
//   源   = cloud-data/fc{ver}/changelog.json = { version, date: 'YYYY-MM-DD', items: ['...'], enabled: 0|1 }
//   产物 = fc{ver}/data/changelog/changelog_<ts>.json（数组 [{version,date,items,enabled}]，与原云函数 payload 完全同构）
//        ＋ 元文档 meta_fc{ver}/changelog = {version,enabled,fetchedAt,count,fileID,hash,ts}
//          （字段与原云函数写入一致，端上 cloudJson.fetchList 无需任何改动）
//
// 幂等/防呆：
//   ① 源无 version ⇒ 跳过发布（防空内容覆盖线上好文件）；
//   ② version + enabled 均未变（比对旧元文档）⇒ 跳过上传（与原云函数 republish 条件一致）；
//   ③ 回读校验走 CDN＋随机 query 破边缘缓存（rule 137：SDK downloadFile 在 CI/本机报 STORAGE_FILE_NONEXIST）；
//   ④ 发布成功后清理旧 fileID（与 gen_dict_static 同口径）。
//
// 用法：
//   node scripts/gen_changelog_static.js [ver]     （ver 默认 27；CI 注入 TCB_ENV_ID/SECRET_ID/SECRET_KEY）
//   node scripts/gen_changelog_static.js 27 --dry  （只读源+打印将发布的内容，不写云）

'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const cloudbase = require('@cloudbase/node-sdk');
const { cn } = require('./cn_time');

const ROOT = path.resolve(__dirname, '..');
const VER = Number(process.argv[2] || process.env.FC_VER || 27);
const DRY = process.argv.indexOf('--dry') >= 0;
const SRC = path.join(ROOT, 'cloud-data', 'fc' + VER, 'changelog.json');
const CLOUD_DIR = 'fc' + VER + '/data/changelog/';
const META_COLLECTION = 'meta_fc' + VER;
const META_DOC = 'changelog';

// CDN 域（rule 137：读云存储统一走 CDN＋随机 query；与 price_sync_cloud/daily_column_audit 同源）
const CDN_HOST = '636c-cloud1-d5gq6q3np8708aeef-1475854307.tcb.qcloud.la';

function loadEnv() {
  const f = path.join(ROOT, '.env.local');
  const out = {};
  if (fs.existsSync(f)) {
    fs.readFileSync(f, 'utf8').split(/\r?\n/).forEach(function (ln) {
      const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/.exec(ln);
      if (m) out[m[1]] = m[2].trim();
    });
  }
  return out;
}

function initCloud() {
  const env = loadEnv();
  const envId = process.env.TCB_ENV_ID || env.TCB_ENV_ID;
  const sid = process.env.TCB_SECRET_ID || env.TCB_SECRET_ID;
  const skey = process.env.TCB_SECRET_KEY || env.TCB_SECRET_KEY;
  if (!envId || !sid || !skey) throw new Error('缺 TCB_ENV_ID / TCB_SECRET_ID / TCB_SECRET_KEY');
  // rule 116：SDK 层加 180s 硬上限，避免 upload 偶发卡死无限挂。
  return cloudbase.init({ env: envId, secretId: sid, secretKey: skey, timeout: 180000 });
}

// rule 137：SDK downloadFile 在 CI/本机报 STORAGE_FILE_NONEXIST ⇒ 回读走 CDN＋随机 query 破边缘缓存
function cdnReadback(cloudPath, expectVersion) {
  return new Promise(function (resolve, reject) {
    const url = '/' + cloudPath + '?r=rb-' + Date.now() + '-' + Math.floor(Math.random() * 1e6);
    const req = https.get({ host: CDN_HOST, path: url, headers: { 'User-Agent': 'OAO-changelog-static' }, timeout: 20000 }, function (res) {
      if (res.statusCode !== 200) { res.resume(); reject(new Error('CDN 回读 HTTP ' + res.statusCode)); return; }
      const chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () {
        try {
          const arr = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (!Array.isArray(arr) || !arr.length || arr[0].version !== expectVersion) {
            reject(new Error('回读结构/version 不符')); return;
          }
          resolve();
        } catch (e) { reject(e); }
      });
    });
    req.on('timeout', function () { req.destroy(new Error('CDN 回读超时 20s')); });
    req.on('error', reject);
  });
}

async function run() {
  // ① 读源（仓库内文件，缺失/坏 JSON 直接失败，绝不带病发布）
  if (!fs.existsSync(SRC)) { console.error('[gen_changelog_static] 源文件不存在: ' + SRC); process.exit(2); }
  let raw;
  try { raw = JSON.parse(fs.readFileSync(SRC, 'utf8')); }
  catch (e) { console.error('[gen_changelog_static] 源 JSON 解析失败: ' + e.message); process.exit(3); }

  const version = String(raw.version || '').trim();
  const enabled = (raw.enabled === 1) ? 1 : 0;
  const items = Array.isArray(raw.items) ? raw.items.map(String) : [];
  const date = String(raw.date || '');

  // ② 防呆：无 version ⇒ 跳过（绝不用空内容覆盖线上）
  if (!version) {
    console.log('[gen_changelog_static] 源无 version → 跳过发布（不动线上）。填 version+items 并置 enabled=1 后，下一次 cron 自动发布。');
    return;
  }

  console.log('[gen_changelog_static] ver=' + version + ' enabled=' + enabled + ' items=' + items.length +
    (DRY ? '（--dry 只打印不写云）' : ''));
  if (DRY) {
    console.log('payload = ' + JSON.stringify([{ version: version, date: date, items: items, enabled: enabled }]).slice(0, 500));
    return;
  }

  const app = initCloud();

  // ③ 读旧元文档 → 幂等判定（与原云函数 republish 条件一致：version+enabled 均未变 ⇒ 跳过）
  let prevVersion = '', prevEnabled = 0, prevFileId = '';
  try {
    const old = await app.database().collection(META_COLLECTION).doc(META_DOC).get();
    const od = (old && old.data) || {};
    prevVersion = od.version || '';
    prevEnabled = (od.enabled === 1) ? 1 : 0;
    prevFileId = od.fileID || '';
  } catch (e) { /* 首轮无元文档 */ }
  if (prevVersion === version && prevEnabled === enabled) {
    console.log('[gen_changelog_static] version/enabled 未变 → 跳过上传（meta_fc' + VER + '/' + META_DOC + '）');
    return;
  }

  // ④ 上传静态 JSON（数组同构原云函数 payload）
  const ts = Date.now();
  const payload = [{ version: version, date: date, items: items, enabled: enabled }];
  const buf = Buffer.from(JSON.stringify(payload), 'utf8');
  const cloudPath = CLOUD_DIR + 'changelog_' + ts + '.json';
  const up = await app.uploadFile({ cloudPath: cloudPath, fileContent: buf });
  const fileID = (up && up.fileID) || '';
  if (!fileID) { console.error('  ❌ 上传未拿到 fileID'); process.exit(6); }
  console.log('  已上传:', cloudPath, '(', buf.length, 'bytes )');

  // ⑤ CDN 回读校验（rule 137）
  try {
    await cdnReadback(cloudPath, version);
    console.log('  ✅ CDN 回读校验通过');
  } catch (e) { console.error('  ❌ 回读校验失败:', e.message); process.exit(7); }

  // ⑥ 写元文档（字段与原云函数写入一致）
  const nowIso = new Date(ts).toISOString();
  await app.database().collection(META_COLLECTION).doc(META_DOC).set({
    version: version, enabled: enabled, fetchedAt: nowIso, count: 1,
    fileID: fileID, hash: String(ts), ts: ts
  });
  console.log('  已写元文档 meta_fc' + VER + '/' + META_DOC + ' v' + version + (enabled ? '' : '（enabled=0，端上不弹）'));

  // ⑦ 清理旧文件
  if (prevFileId && prevFileId !== fileID) {
    try { await app.deleteFile({ fileList: [prevFileId] }); console.log('  已清理旧文件:', prevFileId.slice(0, 60) + '…'); }
    catch (e) { console.log('  ⚠️ 清理旧文件失败（不影响本次）:', e.message); }
  }
  console.log('=== gen_changelog_static 完成 ver=' + VER + ' fetchedAtCn=' + cn(nowIso) + ' ===');
}

if (require.main === module) {
  run().catch(function (e) { console.error('失败:', e); process.exit(1); });
}

module.exports = { run: run, cdnReadback: cdnReadback, CLOUD_DIR: CLOUD_DIR, META_COLLECTION: META_COLLECTION, META_DOC: META_DOC };
