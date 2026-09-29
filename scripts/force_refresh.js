// 一键强制刷新 SBC / 进化列表的静态 JSON 缓存。
//
// 用法：node scripts/force_refresh.js [ver]
//   ver 默认 27； bumps meta_fc{ver}/get_sbcs 和 meta_fc{ver}/get_evolutions 的 forceVersion 字段。
//   端上 dailyWindowGate 的非窗口旁路会检测到 forceVersion 变大，立即清缓存重拉。
//
// 安全：只改元文档的一个数字字段，不改数据内容、不删文件。

'use strict';

const fs = require('fs');
const path = require('path');
const cloudbase = require('@cloudbase/node-sdk');

const ROOT = path.resolve(__dirname, '..');
const VER = Number(process.argv[2] || process.env.FC_VER || 27);
const META_COLLECTION = 'meta_fc' + VER;
const NAMES = ['get_sbcs', 'get_evolutions'];

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
  return cloudbase.init({ env: envId, secretId: sid, secretKey: skey });
}

async function bumpOne(app, name) {
  const ts = Date.now();
  let prev = {};
  try {
    const r = await app.database().collection(META_COLLECTION).doc(name).get();
    const d = (r && r.data) || null;
    if (d) {
      // node-sdk 可能返回 {data:{...}} 或 {...}，都兼容
      prev = (d && d.data) || d || {};
    }
  } catch (e) {
    console.log('[' + name + '] 读旧元文档失败（可能不存在）:', e.message);
  }
  const next = Object.assign({}, prev, {
    forceVersion: ts,
    updatedAt: new Date().toISOString()
  });
  await app.database().collection(META_COLLECTION).doc(name).set(next);
  console.log('[' + name + '] forceVersion bumped → ' + ts + ' (was ' + (prev.forceVersion || 0) + ')');
}

(async function () {
  const app = initCloud();
  for (let i = 0; i < NAMES.length; i++) {
    await bumpOne(app, NAMES[i]);
  }
  console.log('\n=== force_refresh 完成 ===');
})().catch(function (e) {
  console.error('失败:', e.message);
  process.exit(1);
});
