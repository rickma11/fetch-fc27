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
const { cn } = require('./cn_time');   // 北京时间直读字段（控制台用）

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
  // 2026-10-16：装饰进化升级项分两种 —— rarity_id（只换稀有度/卡面，如 Ones to Watch Retro）
  // 与 cosmetic（纯视觉，如 Golden Stars / Pink Fire / 各类 Badge）。两者均不升级球员属性，均判装饰。
  // 判据：① doesNotUpgradePlayer=true（EA 明确「不升级球员」）→ 装饰；
  //       ② 兜底：所有等级 upgrades 全为 rarity_id 或 cosmetic。
  o.rarityOnly = lv.length > 0 && lv.every(function (L) {
    const ups = (L && Array.isArray(L.upgrades)) ? L.upgrades : [];
    return ups.length > 0 && ups.every(function (u) { return u && (u.upgrade === 'rarity_id' || u.upgrade === 'cosmetic'); });
  }) || (e.doesNotUpgradePlayer === true);
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
  // 规则 116（2026-10-03 实测）：SDK 层硬超时，避免 uploadFile 偶发卡死无告警拖垮整条 CI。
  return cloudbase.init({ env: envId, secretId: sid, secretKey: skey, timeout: 180000 });
}
function shortFid(fid) { return fid ? String(fid).slice(0, 64) + (fid.length > 64 ? '…' : '') : ''; }

// ── 云库直读（规则 142：真源＝云端，禁止以本机工作区快照为源）──
// 背景：2026-10-29 事故 —— 本机仓库落后 main 27 天，`cloud-data/fc27/evolutions.json`
// 仍是 10-01 的 45 条，却被本脚本当作源上传，覆盖了云端正确的 151 条，端上退回「31 个 / 10-01」。
// 故改为直读云库：本机有没有本地文件都不影响，从根上杜绝「陈旧本地数据污染云端」。
async function fetchAll(app, coll) {
  const db = app.database();
  const out = [];
  for (;;) {
    const r = await db.collection(coll).skip(out.length).limit(100).get();
    const d = (r && r.data) || [];
    if (!d.length) break;
    for (let i = 0; i < d.length; i++) out.push(d[i]);
    if (d.length < 100) break;
  }
  return out;
}

// 未过期判定：无 endTime（长期有效/永不过期）视为有效；解析失败保守保留。
// ⚠️ 云库 sbcs_fc27 是**历史累积**（实测 79 条中 50 条已过期），不做这层过滤会把过期 SBC 全量放上线。
function notEnded(s) {
  if (!s || !s.endTime) return true;
  const t = Date.parse(s.endTime);
  return isNaN(t) ? true : t > Date.now();
}
function hash8(buf) { return crypto.createHash('md5').update(buf).digest('hex').slice(0, 8); }

// 规则 116（2026-10-03 实测）：@cloudbase/node-sdk 的 uploadFile 从 CI runner→腾讯 COS 偶发卡死无告警，
// 单文件 stall 会让 CI 无限挂（WATCHDOG 220min 才杀）。统一封装：SDK 层硬超时(180s，见 initCloud)＋
// 本函数 3 次重试 ＋ race=200s（须 > SDK timeout 让其先自我中止）＋ 回读校验。publishOne/publishObject 共用。
async function uploadWithRetry(app, cloudPath, buf) {
  const ATTEMPTS = 3;
  const RACE_MS = 200000; // > initCloud timeout(180s)，确保 SDK 先自我中止再重试
  let lastErr;
  for (let i = 0; i < ATTEMPTS; i++) {
    try {
      const up = await Promise.race([
        app.uploadFile({ cloudPath: cloudPath, fileContent: buf }),
        new Promise(function (_, rej) {
          setTimeout(function () { rej(new Error('uploadFile 超时 ' + RACE_MS + 'ms（已 abort）')); }, RACE_MS);
        })
      ]);
      const fileID = (up && up.fileID) || '';
      if (!fileID) throw new Error('上传未拿到 fileID');
      const rb = await app.downloadFile({ fileID: fileID });
      const rbBuf = rb && rb.fileContent;
      if (!rbBuf || !rbBuf.length) throw new Error('回读空');
      return { fileID: fileID, rbBuf: rbBuf };
    } catch (e) {
      lastErr = e;
      console.error('  ⚠️ 上传/回读尝试 ' + (i + 1) + '/' + ATTEMPTS + ' 失败: ' + e.message);
    }
  }
  throw lastErr || new Error('uploadWithRetry 全部 ' + ATTEMPTS + ' 次失败');
}

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

  const up = await uploadWithRetry(app, cloudPath, buf);
  const fileID = up.fileID;
  console.log('  已上传:', cloudPath, '→', shortFid(fileID));

  // 回读校验（规则 100）：uploadFile 假成功，必须 downloadFile 读回断言
  try {
    const rbArr = JSON.parse(up.rbBuf.toString('utf8'));
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

  const nowIso = new Date().toISOString();
  await app.database().collection(META_COLLECTION).doc(name).set({
    fetchedAt: fetchedAt || '', count: stampedArr.length, fileID: fileID, hash: h, ts: ts,
    prevFileId: prevFileId || '', updatedAt: nowIso,
    forceVersion: forceVersion,
    // 北京时间直读字段（控制台用；纯展示，不参与任何逻辑，勿依赖）
    fetchedAtCn: cn(fetchedAt || ''), updatedAtCn: cn(nowIso), tsCn: cn(ts)
  });
  console.log('  已写元文档', META_COLLECTION + '/' + name, 'forceVersion=' + forceVersion);

  if (prevFileId && prevFileId !== fileID) {
    try { await app.deleteFile({ fileList: [prevFileId] }); console.log('  已清理旧文件:', shortFid(prevFileId)); }
    catch (e) { console.log('  ⚠️ 清理旧文件失败（不影响本次）:', e.message); }
  }
  return { hash: h, ts: ts, fileID: fileID };
}

// 对象型静态 JSON 发布（内容更新告知 feed_meta 用）：与 publishOne 同构，但载荷是 JSON 对象（不注入 _fetchedAt）。
// 端上 utils/cloudJson#fetchObject 读 meta_fc{ver}/<name> 拿 fileID → downloadFile 直读对象。
async function publishObject(app, name, obj) {
  const ts = Date.now();
  const jsonStr = JSON.stringify(obj);
  const buf = Buffer.from(jsonStr);
  const h = hash8(buf);
  const cloudPath = CLOUD_DIR + name + '/' + name + '.' + h + '.json';
  console.log('[' + name + '] 对象 json=' + (jsonStr.length / 1024).toFixed(1) + 'KB hash=' + h);
  if (NO_UPLOAD) { console.log('  （--no-upload，跳过上传）'); return; }

  const up = await uploadWithRetry(app, cloudPath, buf);
  const fileID = up.fileID;
  console.log('  已上传:', cloudPath, '→', shortFid(fileID));

  // 回读校验（规则 100）：uploadFile 假成功，必须 downloadFile 读回断言
  try {
    const rbObj = JSON.parse(up.rbBuf.toString('utf8'));
    if (!rbObj || typeof rbObj !== 'object' || Array.isArray(rbObj)) throw new Error('回读非对象');
    console.log('  ✅ 回读校验通过');
  } catch (e) { console.error('  ❌ 回读校验失败:', e.message); process.exit(7); }

  // 读旧元文档（拿 prevFileId 清旧文件）
  let prevFileId = '';
  try {
    const old = await app.database().collection(META_COLLECTION).doc(name).get();
    const od = (old && old.data) || null;
    if (od) prevFileId = od.fileID || '';
  } catch (e) { /* 首轮无元文档 */ }

  const nowIso = new Date().toISOString();
  await app.database().collection(META_COLLECTION).doc(name).set({
    fetchedAt: '', count: 0, fileID: fileID, hash: h, ts: ts,
    prevFileId: prevFileId || '', updatedAt: nowIso,
    forceVersion: ts,
    fetchedAtCn: '', updatedAtCn: cn(nowIso), tsCn: cn(ts)
  });
  console.log('  已写元文档', META_COLLECTION + '/' + name);
  if (prevFileId && prevFileId !== fileID) {
    try { await app.deleteFile({ fileList: [prevFileId] }); console.log('  已清理旧文件:', shortFid(prevFileId)); }
    catch (e) { console.log('  ⚠️ 清理旧文件失败（不影响本次）:', e.message); }
  }
}

async function run() {
  const app = initCloud();

  // 真源＝云库（规则 142）。进化取全量；SBC 取全量后过滤过期项（对齐 scrape 的「当前有效集合」）。
  const evoRaw = await fetchAll(app, 'evolutions_fc' + VER);
  const sbcAll = await fetchAll(app, 'sbcs_fc' + VER);
  const sbcArr = sbcAll.filter(notEnded);
  console.log('[源] 云库 evolutions_fc' + VER + ' = ' + evoRaw.length + ' 条');
  console.log('[源] 云库 sbcs_fc' + VER + ' = ' + sbcAll.length + ' 条 → 过滤过期后 ' + sbcArr.length + ' 条');
  const evoArr = evoRaw.map(slimRecord);  // 必须与云函数 list 返回形状一致

  // objectives（FC27 任务）本地源：由 scripts/gen_objectives.js 抓取精简产出；缺失则跳过，不阻断 sbc/evo。
  // ⚠️ 规则 142 的唯一例外：云库**没有** objectives_fc27 集合（实测 Db or Table not exist），
  //    且 CI 里 gen-static-lists.yml 会先跑 gen_objectives.js 实时重抓再调本脚本，故源是「本次刚抓的新产物」
  //    而非陈旧快照，不构成污染风险。若本机缺该文件则跳过发布（云端保留上一版，不会被清空）。
  let objArr = [];
  let objFetchedAt = '';
  const objPath = path.join(ROOT, 'cloud-data/fc27/objectives.json');
  if (fs.existsSync(objPath)) {
    const objSrc = JSON.parse(fs.readFileSync(objPath, 'utf8'));
    objArr = Array.isArray(objSrc.groups) ? objSrc.groups : [];
    objFetchedAt = objSrc.fetchedAt || maxFetchedAt(objArr) || new Date().toISOString();
    console.log('[objectives] 本地源 ' + objArr.length + ' 个 group');
  } else {
    console.log('[objectives] 本地源不存在（' + objPath + '），跳过 objectives 发布');
  }

  if (!sbcArr.length) { console.error('云库 sbcs_fc' + VER + ' 无有效记录'); process.exit(8); }
  if (!evoArr.length) { console.error('云库 evolutions_fc' + VER + ' 无记录'); process.exit(8); }

  // fetchedAt：取整批记录 _fetchedAt 的最大值（云库是唯一真源，不再有本地顶层字段可依赖）
  const evoFetchedAt = maxFetchedAt(evoRaw) || new Date().toISOString();
  const sbcFetchedAt = maxFetchedAt(sbcArr) || new Date().toISOString();

  if (NO_UPLOAD) {
    console.log('本地校验：SBC=' + sbcArr.length + ' 条, 进化=' + evoArr.length + ' 条（--no-upload，未写云）');
    console.log('SBC sample keys:', Object.keys(sbcArr[0]).slice(0, 10).join(', '));
    console.log('EVO sample keys:', Object.keys(evoArr[0]).slice(0, 14).join(', '));
    process.exit(0);
  }

  const sbcMeta = await publishOne(app, 'get_sbcs', sbcArr, sbcFetchedAt);
  const evoMeta = await publishOne(app, 'get_evolutions', evoArr, evoFetchedAt);
  let objMeta = null;
  if (objArr.length) {
    objMeta = await publishOne(app, 'objectives', objArr, objFetchedAt);
  } else {
    console.log('[objectives] 无数据，跳过发布');
  }

  // 内容更新告知：feed_meta（evo/sbc 指纹；players 指纹端上直读 roster meta，不在此写）。
  // rev = 列表内容 hash（内容不变则不变 → 端上据此判断「有无新内容」）；updatedAt = 本次 CI ts（ISO），
  // 用于「下次更新无新内容则自动过期」的周期判定。端上 utils/updateFeed.js#compute 消费。
  const feedMeta = {
    sections: {
      evolutions: {
        rev: (evoMeta && evoMeta.hash) || '',
        updatedAt: (evoMeta && evoMeta.ts) ? new Date(evoMeta.ts).toISOString() : ''
      },
      sbc: {
        rev: (sbcMeta && sbcMeta.hash) || '',
        updatedAt: (sbcMeta && sbcMeta.ts) ? new Date(sbcMeta.ts).toISOString() : ''
      },
      objectives: {
        rev: (objMeta && objMeta.hash) || '',
        updatedAt: (objMeta && objMeta.ts) ? new Date(objMeta.ts).toISOString() : ''
      }
    }
  };
  await publishObject(app, 'feed_meta', feedMeta);
  console.log('\n=== gen_static_lists 完成 ===');
}

if (require.main === module) {
  run().catch(function (e) { console.error('失败:', e); process.exit(1); });
}

module.exports = {
  slimRecord: slimRecord, maxFetchedAt: maxFetchedAt,
  publishOne: publishOne, publishObject: publishObject, initCloud: initCloud, hash8: hash8, CLOUD_DIR: CLOUD_DIR,
  META_COLLECTION: META_COLLECTION
};
