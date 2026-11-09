// player_zh_index（球员中文名搜索索引）上云脚本 —— 手动按需执行（2026-11-09）。
//
// 用途：用户改完 data/player_names_zh.json 后，先跑 gen_player_names_index.js 压索引，
//       再跑本脚本把索引发布到云存储 + 写元文档。端上 utils/playerZhIndex.js 与
//       云函数 get_players 按元文档印记热刷新，无需发版。
//
// ⚠️ 不接 CI（用户拍板：名单很少更新），与 upload_season_map.js 同构：
//    规则 99 哈希命名 / 规则 100 回读校验 / 规则 116 SDK 硬超时+3次重试 / 规则 129 deleteFile 只认 cloud://。
// 用法：node scripts/upload_player_names_index.js [ver]   （ver 默认 27）
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cloudbase = require('@cloudbase/node-sdk');

const ROOT = path.resolve(__dirname, '..');
const VER = Number(process.argv[2] || process.env.FC_VER || 27);
const SRC = path.join(ROOT, 'data', 'player_zh_index.json');
const CLOUD_DIR = 'fc' + VER + '/data/';
const META_COLLECTION = 'meta_fc' + VER;
const NAME = 'player_zh_index';

function loadEnv() {
  const env = {};
  const f = path.join(ROOT, '.env.local');
  if (fs.existsSync(f)) {
    fs.readFileSync(f, 'utf8').split(/\r?\n/).forEach(function (ln) {
      const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/.exec(ln);
      if (m) env[m[1]] = m[2].trim();
    });
  }
  return env;
}
function initCloud() {
  const env = loadEnv();
  const envId = process.env.TCB_ENV_ID || env.TCB_ENV_ID;
  const sid = process.env.TCB_SECRET_ID || env.TCB_SECRET_ID;
  const skey = process.env.TCB_SECRET_KEY || env.TCB_SECRET_KEY;
  if (!envId || !sid || !skey) throw new Error('缺 TCB_ENV_ID / TCB_SECRET_ID / TCB_SECRET_KEY（.env.local）');
  return cloudbase.init({ env: envId, secretId: sid, secretKey: skey, timeout: 180000 });
}
function hash8(buf) { return crypto.createHash('md5').update(buf).digest('hex').slice(0, 8); }
function shortFid(fid) { return fid ? String(fid).slice(0, 64) + (fid.length > 64 ? '…' : '') : ''; }
function cn(ts) {
  const d = new Date(ts);
  const p = function (n) { return n < 10 ? '0' + n : '' + n; };
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

// 规则 116：SDK 层硬超时(180s) + 本函数 3 次重试 + race=200s + 回读校验
async function uploadWithRetry(app, cloudPath, buf) {
  const ATTEMPTS = 3;
  const RACE_MS = 200000;
  let lastErr;
  for (let i = 0; i < ATTEMPTS; i++) {
    try {
      const up = await Promise.race([
        app.uploadFile({ cloudPath: cloudPath, fileContent: buf }),
        new Promise(function (_, rej) {
          setTimeout(function () { rej(new Error('uploadFile 超时 ' + RACE_MS + 'ms')); }, RACE_MS);
        })
      ]);
      const fileID = (up && up.fileID) || '';
      if (!fileID) throw new Error('上传未拿到 fileID');
      const rb = await app.downloadFile({ fileID: fileID });
      const rbBuf = rb && rb.fileContent;
      if (!rbBuf || !rbBuf.length) throw new Error('回读空');
      return fileID;
    } catch (e) {
      lastErr = e;
      console.error('  ⚠️ 上传/回读尝试 ' + (i + 1) + '/' + ATTEMPTS + ' 失败: ' + e.message);
    }
  }
  throw lastErr || new Error('uploadWithRetry 全部失败');
}

async function run() {
  if (!fs.existsSync(SRC)) { console.error('找不到索引文件: ' + SRC + '（先跑 gen_player_names_index.js）'); process.exit(1); }
  const buf = fs.readFileSync(SRC);
  const obj = JSON.parse(buf.toString('utf8'));
  const count = (obj && Array.isArray(obj.n)) ? obj.n.length : 0;
  if (count < 1000) { console.error('索引条目异常（' + count + ' < 1000），拒绝发布'); process.exit(1); }
  const h = hash8(buf);
  const cloudPath = CLOUD_DIR + NAME + '/' + NAME + '.' + h + '.json';
  console.log('[' + NAME + '] 条目=' + count + ' 体积=' + (buf.length / 1024).toFixed(1) + 'KB hash=' + h);

  const app = initCloud();
  const fileID = await uploadWithRetry(app, cloudPath, buf);
  console.log('  已上传:', cloudPath, '→', shortFid(fileID));

  // 读旧元文档（拿 prevFileId 清旧文件）
  let prevFileId = '';
  try {
    const old = await app.database().collection(META_COLLECTION).doc(NAME).get();
    const od = (old && old.data) || null;
    if (od && !Array.isArray(od)) prevFileId = od.fileID || '';
    else if (Array.isArray(od) && od[0]) prevFileId = od[0].fileID || '';
  } catch (e) { /* 首轮无元文档 */ }

  const ts = Date.now();
  const nowIso = new Date().toISOString();
  await app.database().collection(META_COLLECTION).doc(NAME).set({
    fetchedAt: nowIso, count: count, fileID: fileID, hash: h, ts: ts,
    prevFileId: prevFileId || '', updatedAt: nowIso,
    forceVersion: ts,
    fetchedAtCn: cn(ts), updatedAtCn: cn(ts), tsCn: cn(ts)
  });
  console.log('  已写元文档', META_COLLECTION + '/' + NAME, 'ts=' + ts);

  // 清旧（规则 129：fileID 必须是 cloud:// 完整 ID；失败不阻断）
  if (prevFileId && prevFileId !== fileID && prevFileId.indexOf('cloud://') === 0) {
    try { await app.deleteFile({ fileList: [prevFileId] }); console.log('  已清理旧文件:', shortFid(prevFileId)); }
    catch (e) { console.log('  ⚠️ 清理旧文件失败（不影响本次）:', e.message); }
  }
  console.log('✅ player_zh_index 发布完成。端上/云函数按元文档印记热刷新。');
}

run()
  .then(function () { process.exit(0); })   // 发布成功：显式退出，避免 TCB SDK 连接保活导致进程挂起
  .catch(function (e) {
    console.error('❌ 发布失败:', (e && e.message) || e);
    process.exit(1);
  });
