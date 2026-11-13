// 教练MBTI 活动开关发布器（远程 kill-switch，2026-11-13）。
//
// 真源 = cloud-data/fc27/coach_mbti.json  { enabled: 0|1, entryEnabled: 0|1 }
//   · enabled       活动总开关。0 = 整体下架：弹脸/FAB 隐藏，且三页 onLoad 全部拒绝进入。
//   · entryEnabled  入口开关。0 = 只关弹脸/FAB（已通过分享/收藏进入的用户仍可玩完）。
//   端上 utils/coachMbti.js 走 cloudJson.fetchObject('coach_mbti',{fresh:true}) 读，fail-closed。
//
// 产物 = fc27/data/coach_mbti/coach_mbti_<ts>.json（对象型 JSON）
//      ＋ 元文档 meta_fc27/coach_mbti = { enabled, entryEnabled, fileID, ts, ... }
//
// ⚠️ 为什么用本地脚本即时发布而不是等 CI：用户诉求是「不发版本、快速关闭」。
//    本脚本一条命令直传云存储 + 写元文档，**秒级生效**（端上 fresh 直读按 ts 印记比对），
//    不依赖 cron-job.org / GitHub Actions 的小时级调度。改完 JSON 跑一次即可关停全量用户。
//    如需定时巡检可自行挂 cron，本脚本不引入任何 CI 改动。
//
// 幂等：enabled/entryEnabled 均未变 → 跳过上传（不动线上，避免无谓抖动）。
// 规则 116：SDK timeout 180s + 3 次重试 + race；规则 137：回读走 CDN＋随机 query。
//
// 用法：
//   node scripts/gen_coach_mbti_config.js          发布当前源（下架：先把 enabled 改 0）
//   node scripts/gen_coach_mbti_config.js --dry    只打印将发布内容，不写云
//   node scripts/gen_coach_mbti_config.js --force  忽略幂等，强制重传
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const cloudbase = require('@cloudbase/node-sdk');
const { cn } = require('./cn_time');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'cloud-data', 'fc27', 'coach_mbti.json');
const CLOUD_DIR = 'fc27/data/coach_mbti/';
const META_COLLECTION = 'meta_fc27';
const META_DOC = 'coach_mbti';
const CDN_HOST = '636c-cloud1-d5gq6q3np8708aeef-1475854307.tcb.qcloud.la';
const NAME = 'coach_mbti';
const DRY = process.argv.indexOf('--dry') >= 0;
const FORCE = process.argv.indexOf('--force') >= 0;
const RACE_MS = 200000;
const ATTEMPTS = 3;

function loadEnv() {
  const out = {};
  const f = path.join(ROOT, '.env.local');
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
  if (!envId || !sid || !skey) throw new Error('缺 TCB_ENV_ID / TCB_SECRET_ID / TCB_SECRET_KEY（.env.local）');
  return cloudbase.init({ env: envId, secretId: sid, secretKey: skey, timeout: 180000 });
}

function cdnReadback(cloudPath, expect) {
  return new Promise(function (resolve, reject) {
    const url = '/' + cloudPath + '?r=rb-' + Date.now() + '-' + Math.floor(Math.random() * 1e6);
    const req = https.get({
      host: CDN_HOST, path: url, headers: { 'User-Agent': 'OAO-coach-mbti-config' }, timeout: 20000
    }, function (res) {
      if (res.statusCode !== 200) { res.resume(); reject(new Error('CDN HTTP ' + res.statusCode)); return; }
      const chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () {
        try {
          const o = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (o.enabled !== expect.enabled || o.entryEnabled !== expect.entryEnabled) {
            reject(new Error('CDN 回读开关值不符')); return;
          }
          resolve();
        } catch (e) { reject(e); }
      });
    });
    req.on('timeout', function () { req.destroy(new Error('CDN 回读超时 20s')); });
    req.on('error', reject);
  });
}

async function uploadWithRetry(app, cloudPath, buf, expect) {
  let lastErr;
  for (let i = 0; i < ATTEMPTS; i++) {
    try {
      const up = await Promise.race([
        app.uploadFile({ cloudPath: cloudPath, fileContent: buf }),
        new Promise(function (_, rej) {
          setTimeout(function () { rej(new Error('uploadFile 超时 ' + RACE_MS + 'ms')); }, RACE_MS);
        })
      ]);
      if (!up || !up.fileID) throw new Error('上传未拿到 fileID');
      await cdnReadback(cloudPath, expect);
      return up.fileID;
    } catch (e) {
      lastErr = e;
      console.error('  ⚠️ 上传/回读尝试 ' + (i + 1) + '/' + ATTEMPTS + ' 失败: ' + e.message);
    }
  }
  throw lastErr || new Error('uploadWithRetry 全部失败');
}

async function run() {
  if (!fs.existsSync(SRC)) { console.error('[coach_mbti] 源不存在: ' + SRC); process.exit(2); }
  let raw;
  try { raw = JSON.parse(fs.readFileSync(SRC, 'utf8')); }
  catch (e) { console.error('[coach_mbti] 源 JSON 解析失败: ' + e.message); process.exit(3); }

  // 安全默认：字段缺失/非法一律视为 0（关闭），绝不因手误把活动放出来
  const enabled = (raw.enabled === 1) ? 1 : 0;
  const entryEnabled = (raw.entryEnabled === 1) ? 1 : 0;
  const payload = {
    enabled: enabled,
    entryEnabled: entryEnabled,
    ver: 1,
    note: String(raw.note || '')
  };
  console.log('[coach_mbti] enabled=' + enabled + ' entryEnabled=' + entryEnabled +
    (DRY ? '（--dry 只打印不写云）' : ''));
  if (DRY) { console.log('payload = ' + JSON.stringify(payload)); return; }

  const app = initCloud();

  let prevEnabled = -1, prevEntry = -1, prevFileId = '';
  try {
    const old = await app.database().collection(META_COLLECTION).doc(META_DOC).get();
    const od = (old && old.data) || {};
    const d = Array.isArray(od) ? (od[0] || {}) : od;
    prevEnabled = (d.enabled === 1) ? 1 : 0;
    prevEntry = (d.entryEnabled === 1) ? 1 : 0;
    prevFileId = d.fileID || '';
  } catch (e) { /* 首轮无元文档 */ }
  if (!FORCE && prevEnabled === enabled && prevEntry === entryEnabled) {
    console.log('[coach_mbti] 开关未变 → 跳过（如需强制重传加 --force）。当前线上：enabled=' + prevEnabled);
    return;
  }

  const ts = Date.now();
  payload.ts = ts;
  payload.updatedAt = new Date(ts).toISOString();
  payload.updatedAtCn = cn(payload.updatedAt);
  const buf = Buffer.from(JSON.stringify(payload), 'utf8');
  const cloudPath = CLOUD_DIR + NAME + '_' + ts + '.json';
  const fileID = await uploadWithRetry(app, cloudPath, buf, payload);
  console.log('  已上传: ' + cloudPath + ' (' + buf.length + ' bytes)');

  await app.database().collection(META_COLLECTION).doc(META_DOC).set({
    enabled: enabled, entryEnabled: entryEnabled,
    fetchedAt: payload.updatedAt, count: 1, fileID: fileID,
    hash: String(ts), ts: ts, forceVersion: ts,
    updatedAt: payload.updatedAt, updatedAtCn: payload.updatedAtCn
  });
  console.log('  已写元文档 ' + META_COLLECTION + '/' + META_DOC + ' ts=' + ts);

  if (prevFileId && prevFileId !== fileID && prevFileId.indexOf('cloud://') === 0) {
    try { await app.deleteFile({ fileList: [prevFileId] }); console.log('  已清理旧文件'); }
    catch (e) { console.log('  ⚠️ 清理旧文件失败（不影响本次）: ' + e.message); }
  }
  console.log('=== ✅ 开关已发布，端上即时生效：' +
    (enabled ? '活动开启' : '🔴 活动已下架（弹脸/FAB 隐藏 + 三页拒绝进入）') + ' ===');
}

run()
  .then(function () { process.exit(0); })
  .catch(function (e) { console.error('❌ 发布失败: ' + (e && e.message)); process.exit(1); });
