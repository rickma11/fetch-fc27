// FC27 列表数据（SBC / 进化）静态 JSON 生成器（Phase 1，2026-09-28）。
//
// 目的：把「SBC / 进化列表」从「端上每次走云函数 get_sbcs / get_evolutions（云函数+DB 全量读）」
// 改为「CI 预生成静态 JSON 落云存储，端上 wx.cloud.downloadFile 直读」，让 list/meta 主链路零云函数调用。
//
// 数据来源（均为 fetch-fc27 现有管线已产出的本地产物，本脚本只读不写、不碰现有抓取/同步逻辑）：
//   - cloud-data/fc27/sbcs.json        → 顶层 {ver,count,sets:[...]}（sets 即端上 list 要的完整数组）
//   - cloud-data/fc27/evolutions.json  → 顶层 {ver,active,all,fetchedAt,...}（all 需经 slimRecord 投影）
//
// 输出（云存储，参考 sync_live_hub.js 同构）：
//   - fc{ver}/data/<name>/<name>.<hash8>.json   （哈希命名，规则 99：内容变=换名=绕开覆写缓存坑）
//   - 写元文档 meta_fc{ver}/<name> = {fetchedAt,count,fileID,hash,ts}（端上读它拿 fileID + 做闸门比对）
//   - 上传后 downloadFile 回读校验（规则 100：uploadFile 会假成功，必须读回断言）
//   - 清理上一代文件
//
// ⚠️ 默认不接 fetch-fc27.yml（手动跑）：验证端上机制 OK 后再决定是否接每日自动。
// 用法：node scripts/gen_static_lists.js [ver]        （ver 默认 27；--no-upload 仅本地验证不写云）
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cloudbase = require('@cloudbase/node-sdk');

const ROOT = path.resolve(__dirname, '..');
const VER = Number(process.argv[2] || process.env.FC_VER || 27);
const NO_UPLOAD = process.argv.indexOf('--no-upload') >= 0;
const CLOUD_DIR = 'fc' + VER + '/data/';
const META_COLLECTION = 'meta_fc' + VER;

// ── 与云函数 get_evolutions#slimRecord 同款纯函数（端上 buildCard 依赖投影后的派生字段）──
// 任何改动须与云函数保持一致；若云函数 slimRecord 升级，本函数必须同步（CI 断言会兜底校验字段集）。
const HEAVY_FIELDS = ['levels', 'eligiblePlayerItemIds', 'trendingPlayersIds', 'eligiblePathHashes', 'requirements'];
function slimRecord(e) {
  const o = {};
  Object.keys(e).forEach(function (k) { if (HEAVY_FIELDS.indexOf(k) < 0) o[k] = e[k]; });
  const lv = Array.isArray(e.levels) ? e.levels : [];
  o.levelCount = lv.length;
  o.levelOptionCounts = lv.map(function (L) {
    return (L && Array.isArray(L.upgradeOptions)) ? L.upgradeOptions.length : 0;
  });
  o.hasBranch = o.levelOptionCounts.some(function (n) { return n > 1; });
  if (o.hasBranch) {
    const commonTexts = [];
    const routeTexts = [];
    lv.forEach(function (L) {
      const opts = (L && Array.isArray(L.upgradeOptions)) ? L.upgradeOptions : [];
      const hasChoice = !!(L && L.hasUpgradeChoices) && opts.length > 1;
      if (!hasChoice) {
        const t = (L && Array.isArray(L.totalUpgradesText)) ? L.totalUpgradesText : [];
        for (let i = 0; i < t.length; i++) commonTexts.push(t[i]);
        return;
      }
      opts.forEach(function (op, i) {
        routeTexts.push({
          idx: (op && op.idx != null) ? op.idx : i + 1,
          totalUpgradesText: (op && Array.isArray(op.totalUpgradesText)) ? op.totalUpgradesText : []
        });
      });
    });
    o.commonTexts = commonTexts;
    o.routeTexts = routeTexts;
  }
  o.rarityOnly = lv.length > 0 && lv.every(function (L) {
    const ups = (L && Array.isArray(L.upgrades)) ? L.upgrades : [];
    return ups.length > 0 && ups.every(function (u) { return u && u.upgrade === 'rarity_id'; });
  });
  if (typeof e.roleOnly === 'boolean') {
    o.roleOnly = e.roleOnly;
  } else {
    o.roleOnly = lv.length > 0 && lv.every(function (L) {
      const ups = (L && Array.isArray(L.upgrades)) ? L.upgrades : [];
      return ups.length > 0 && ups.every(function (u) { return u && String(u.upgrade).startsWith('role_plus'); });
    });
  }
  return o;
}

// 整批最新抓取时间＝所有记录 _fetchedAt 最大值（与云函数 maxFetchedAt 同逻辑）
function maxFetchedAt(all) {
  let max = 0, iso = null;
  for (let i = 0; i < all.length; i++) {
    const v = all[i] && (all[i]._fetchedAt || all[i].fetchedAt);
    if (!v) continue;
    const t = Date.parse(v);
    if (!isNaN(t) && t > max) { max = t; iso = v; }
  }
  return iso;
}

// ── 云初始化（仅上传时）──
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
function shortFid(fid) { return fid ? String(fid).slice(0, 64) + (fid.length > 64 ? '…' : '') : ''; }
function hash8(buf) { return crypto.createHash('md5').update(buf).digest('hex').slice(0, 8); }

// 单个数据集：造数组 → 哈希命名 → 上传 → 写元文档 → 清旧 → 回读校验
async function publishOne(app, name, arr, fetchedAt) {
  const ts = Date.now();
  // 给每条记录注入整批 _fetchedAt，保证端上「数据更新于」始终能显示（无论单条有没自己的时间戳）
  const stamp = fetchedAt || new Date(ts).toISOString();
  const stampedArr = arr.map(function (r) {
    if (r && (r._fetchedAt || r.fetchedAt)) return r;
    const o = {};
    for (const k in r) if (Object.prototype.hasOwnProperty.call(r, k)) o[k] = r[k];
    o._fetchedAt = stamp;
    return o;
  });

  const jsonStr = JSON.stringify(stampedArr);
  const buf = Buffer.from(jsonStr);
  const h = hash8(buf);
  const cloudPath = CLOUD_DIR + name + '/' + name + '.' + h + '.json';
  console.log('[' + name + '] 记录数=' + stampedArr.length + ' json=' + (jsonStr.length / 1024).toFixed(1) +
    'KB hash=' + h + ' fetchedAt=' + (fetchedAt || '(空)'));

  if (NO_UPLOAD) { console.log('  （--no-upload，跳过上传）'); return; }

  const up = await app.uploadFile({ cloudPath: cloudPath, fileContent: buf });
  const fileID = (up && up.fileID) || '';
  if (!fileID) { console.error('  ❌ 上传未拿到 fileID'); process.exit(6); }
  console.log('  已上传:', cloudPath, '→', shortFid(fileID));

  // 回读校验（规则 100）：uploadFile 假成功，必须 downloadFile 读回断言
  try {
    const rb = await app.downloadFile({ fileID: fileID });
    const rbBuf = rb && rb.fileContent;
    if (!rbBuf || !rbBuf.length) throw new Error('回读空');
    const rbArr = JSON.parse(rbBuf.toString('utf8'));
    if (!Array.isArray(rbArr) || rbArr.length !== stampedArr.length) throw new Error('回读条数不符 ' + (rbArr && rbArr.length));
    console.log('  ✅ 回读校验通过：条数=' + rbArr.length);
  } catch (e) { console.error('  ❌ 回读校验失败:', e.message); process.exit(7); }

  // 读旧元文档（拿 prevFileId 清旧文件 + prev forceVersion）
  let prevFileId = '';
  let prevHash = '';
  let prevFV = 0;
  try {
    const old = await app.database().collection(META_COLLECTION).doc(name).get();
    const od = (old && old.data) || null;
    if (od) {
      prevFileId = od.fileID || '';
      prevHash = od.hash || '';
      prevFV = od.forceVersion || 0;
    }
  } catch (e) { /* 首轮无元文档 */ }

  // 内容没变时保持原 forceVersion；内容变了才 bump，避免空跑刷所有人
  const forceVersion = (prevHash && prevHash === h) ? prevFV : ts;

  await app.database().collection(META_COLLECTION).doc(name).set({
    fetchedAt: fetchedAt || '', count: stampedArr.length, fileID: fileID, hash: h, ts: ts,
    prevFileId: prevFileId || '', updatedAt: new Date().toISOString(),
    forceVersion: forceVersion
  });
  console.log('  已写元文档', META_COLLECTION + '/' + name, 'forceVersion=' + forceVersion);

  if (prevFileId && prevFileId !== fileID) {
    try { await app.deleteFile({ fileList: [prevFileId] }); console.log('  已清理旧文件:', shortFid(prevFileId)); }
    catch (e) { console.log('  ⚠️ 清理旧文件失败（不影响本次）:', e.message); }
  }
}

async function run() {
  // 读取现有本地产物（只读，不碰现有 CI 逻辑）
  const sbcsSrc = JSON.parse(fs.readFileSync(path.join(ROOT, 'cloud-data/fc27/sbcs.json'), 'utf8'));
  const evoSrc = JSON.parse(fs.readFileSync(path.join(ROOT, 'cloud-data/fc27/evolutions.json'), 'utf8'));

  const sbcArr = Array.isArray(sbcsSrc.sets) ? sbcsSrc.sets : [];
  const evoRaw = Array.isArray(evoSrc.all) ? evoSrc.all : [];
  const evoArr = evoRaw.map(slimRecord);  // 必须与云函数 list 返回形状一致

  if (!sbcArr.length) { console.error('sbcs.json 无 sets'); process.exit(8); }
  if (!evoArr.length) { console.error('evolutions.json 无 all'); process.exit(8); }

  // fetchedAt：进化用源顶层已有字段；SBC 用数组 max 或回退到本次 ts
  const evoFetchedAt = evoSrc.fetchedAt || maxFetchedAt(evoRaw) || new Date().toISOString();
  const sbcFetchedAt = maxFetchedAt(sbcArr) || new Date().toISOString();

  if (NO_UPLOAD) {
    console.log('本地校验：SBC=' + sbcArr.length + ' 条, 进化=' + evoArr.length + ' 条（--no-upload，未写云）');
    console.log('SBC sample keys:', Object.keys(sbcArr[0]).slice(0, 10).join(', '));
    console.log('EVO sample keys:', Object.keys(evoArr[0]).slice(0, 14).join(', '));
    process.exit(0);
  }

  const app = initCloud();
  await publishOne(app, 'get_sbcs', sbcArr, sbcFetchedAt);
  await publishOne(app, 'get_evolutions', evoArr, evoFetchedAt);
  console.log('\n=== gen_static_lists 完成 ===');
}

if (require.main === module) {
  run().catch(function (e) { console.error('失败:', e); process.exit(1); });
}

module.exports = {
  slimRecord: slimRecord, maxFetchedAt: maxFetchedAt,
  publishOne: publishOne, initCloud: initCloud, hash8: hash8, CLOUD_DIR: CLOUD_DIR,
  META_COLLECTION: META_COLLECTION
};
