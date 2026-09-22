// warm_roster.js —— 服务端预热 roster（绕过 get_players 云函数「>1000 条拒绝现场生成」的 3s 限制）
// 背景：meta_fc27/roster 元数据缺失 → 小程序 preloadRoster 每次拿 code=1 → 本地永远无 roster 缓存
//       → 列表页「数据更新于」永远不显示（2026-09-19 诊断实锤）。
// ⚠️ 本脚本的投影/映射逻辑必须与 eafc-miniapp/cloudfunctions/get_players/index.js 的 roster 分支保持一致
//    （投影字段 + computeKeyAttrs + rarityFileKeyOf + ROSTER_SCHEMA_VERSION）。云函数改动时同步改这里。
// 用法：node scripts/warm_roster.js  （每日 CI 在 upload_db 之后跑，保证 ts = 数据更新时间）
const path = require('path');
process.chdir(path.resolve(__dirname));
const { resolve } = require('./tcb_env');
const ziplite = require('./ziplite');   // 极简 zip 写入器（roster 压缩分片上传用，见第 3 步）

const VER = 27;
// 与 get_players/index.js 保持一致（v15：全息卡官方卡面 holographicType + holoCardImagePath，
// 并**移除**错误的 holoVariants/standardItemEaId 模型 —— 见 fetch_futgg.js#buildDetail 说明）
const ROSTER_SCHEMA_VERSION = 15;
const COL = 'players_fc' + VER;
const M_COL = 'meta_fc' + VER;

// —— 与 get_players/computeKeyAttrs 同源 ——
function computeKeyAttrs(p) {
  const a = p.attributes || {};
  if (!a || !Object.keys(a).length) {
    return [['PAC', p.facePace || 0], ['SHO', p.faceShooting || 0], ['PAS', p.facePassing || 0], ['DRI', p.faceDribbling || 0], ['DEF', p.faceDefending || 0], ['PHY', p.facePhysicality || 0]];
  }
  const pos = p.position;
  let pairs;
  if (pos === 'GK') pairs = [['扑救', a.attributeGkDiving], ['手抛', a.attributeGkHandling], ['开球', a.attributeGkKicking], ['反应', a.attributeGkReflexes], ['站位', a.attributeGkPositioning]];
  else if (pos === 'ST' || pos === 'CF') pairs = [['射门', a.attributeFinishing], ['头球', a.attributeHeadingAccuracy], ['加速', a.attributeAcceleration], ['力量', a.attributeStrength], ['盘带', a.attributeDribbling], ['反应', a.attributeReactions]];
  else if (pos === 'CB' || pos === 'LB' || pos === 'RB') pairs = [['防守意识', a.attributeDefensiveAwareness], ['正面抢断', a.attributeStandingTackle], ['铲断', a.attributeSlidingTackle], ['头球', a.attributeHeadingAccuracy], ['加速', a.attributeAcceleration], ['力量', a.attributeStrength]];
  else pairs = [['视野', a.attributeVision], ['传球', a.attributeShortPassing], ['盘带', a.attributeDribbling], ['射门', a.attributeFinishing], ['防守意识', a.attributeDefensiveAwareness], ['体能', a.attributeStamina]];
  return pairs.filter(function (x) { return x[1] != null; });
}

// —— 与 get_players/rarityFileKeyOf 同源 ——
function rarityFileKeyOf(imagePath) {
  const base = String(imagePath || '').split('/').pop();
  const m = /\.([0-9a-f]{16,})\./i.exec(base);
  return (m ? m[1] : '').slice(0, 16);
}

// 把 roster 切成若干「压缩后 ≤ MAX_PART_ZIP」的分片，每片是一个只含 roster_p{i}.json 的标准 zip。
// 候选分片数从小到大试，取第一个满足体积上限的（片越小单请求越安全，但片数越多元数据越碎）。
// 每片 JSON 自带 part/parts ⟶ 端上可并行下载后按 part 顺序拼接（无需额外索引文件）。
// ⚠️ 每片必须是**独立合法 JSON**（把 players 数组切段，而不是切字节流）——
//    按字节切会把 UTF-8 多字节字符劈开，端上 JSON.parse 直接失败。
function buildPacks(all, rarityImgs, ts) {
  const head = { version: String(VER), ts: ts, count: all.length, schemaVersion: ROSTER_SCHEMA_VERSION, rarityImgs: rarityImgs };
  const MAX_PART_ZIP = 2 * 1024 * 1024;
  const CANDIDATES = [1, 2, 4, 8];
  let last = null;
  for (let ci = 0; ci < CANDIDATES.length; ci++) {
    const n = CANDIDATES[ci];
    const size = Math.ceil(all.length / n);
    const slices = [];
    for (let i = 0; i < n; i++) {
      const s = all.slice(i * size, (i + 1) * size);
      if (s.length) slices.push(s);
    }
    const parts = slices.length;
    const packs = [];
    let rawTotal = 0, zipTotal = 0, maxZip = 0;
    slices.forEach(function (s, i) {
      const raw = Buffer.from(JSON.stringify(Object.assign({}, head, { part: i, parts: parts, players: s })), 'utf8');
      const zip = ziplite.zipOne('roster_p' + i + '.json', raw);
      rawTotal += raw.length; zipTotal += zip.length;
      if (zip.length > maxZip) maxZip = zip.length;
      packs.push({ i: i, players: s.length, raw: raw.length, zip: zip });
    });
    last = { packs: packs, parts: parts, rawTotal: rawTotal, zipTotal: zipTotal, maxZip: maxZip };
    if (maxZip <= MAX_PART_ZIP) return last;
  }
  return last;   // 8 片仍超限（理论上不可能）→ 用最大分片数硬上，体积仍远小于单发 16MB
}

(async () => {
  const cred = resolve();
  const cloudbase = require('@cloudbase/node-sdk');
  const app = cloudbase.init({ env: cred.ENV_ID, secretId: cred.SECRET_ID, secretKey: cred.SECRET_KEY, timeout: 120000 });
  const db = app.database();

  // 1) 全量拉取（与云函数相同投影）
  const proj = {
    eaId: true, commonName: true, overall: true, position: true, imagePath: true,
    facePace: true, faceShooting: true, facePassing: true, faceDribbling: true,
    faceDefending: true, facePhysicality: true,
    height: true, createdAt: true, accelerateType: true,
    foot: true, skillMoves: true, weakFoot: true, dateOfBirth: true,
    playstyles: true, playstylesPlus: true,
    alternativePositionIds: true,
    cardSource: true,
    rolesPlus: true, rolesPlusPlus: true,
    seasonPassLevel: true, seasonPassTier: true,
    gender: true,                      // v10：性别筛选（1=男 / 2=女）+ 详情页首屏信息行
    bodytypeCode: true,                // v11：详情页 hero「身高 · 惯用脚 · 模型」的「模型」
    // v12：SBC 积分（gradingScore）+ SBC 积分兑换（scoreRequirement 回写）进投影，详情页首屏直显
    sbcPoints: true,
    sbcCost: true,
    // v13：收藏室代币兑换价（sync_token_store.js 从 r2 token-store 数据集回写），详情页「收藏室兑换」条首屏直显
    tokenStoreCost: true,
    // v15：全息卡（官方卡面）。holographicType 非空 ⇒ 端上显示「全息卡」pill；
    //      holoCardImagePath ⇒ 详情页「版本」区2 的 {eaId}_holo.webp（EA 官方全息卡面）。
    // ⚠️ 旧的 standardItemEaId / holoVariants 是**错误模型**，已移除（全库恒 null/空，见 fetch_futgg.js）。
    holographicType: true,
    holoCardImagePath: true,
    attributes: true,
    'rarity.imagePath': true,
    'rarity.name': true, 'rarity.rarityGroupName': true,
    'club.name': true, 'league.name': true, 'nation.name': true
  };
  let all = [];
  let skip = 0;
  const t0 = Date.now();
  while (true) {
    const r = await db.collection(COL).field(proj).skip(skip).limit(100).get();
    const d = r.data || [];
    if (!d.length) break;
    all = all.concat(d);
    if (d.length < 100) break;
    skip += 100;
  }
  console.log('fetched', all.length, 'players in', ((Date.now() - t0) / 1000).toFixed(1) + 's');
  if (all.length < 19000) { console.error('安全闸：球员数 <19000，疑似拉取不完整，拒绝写库'); process.exit(1); }

  // 2) 预计算 keyAttrs + rarityImgs（与云函数同逻辑）
  const rarityImgs = {};
  all = all.map(function (p) {
    const k = computeKeyAttrs(p);
    const out = Object.assign({}, p);
    delete out.attributes;
    out.keyAttrs = k;
    if (out.rarity) {
      const rn = out.rarity.name;
      if (rn && out.rarity.imagePath) {
        const fk = rarityFileKeyOf(out.rarity.imagePath);
        if (fk && !rarityImgs[rn]) rarityImgs[rn] = 'rarity_' + fk + '.webp';
      }
      delete out.rarity.imagePath;
    }
    return out;
  });
  console.log('rarityImgs entries:', Object.keys(rarityImgs).length);

  // 3) 压缩 + 分片 + 并发上传云存储 + 写 meta 文档
  //
  // ⚠️ 为什么不是「一次 PUT 一个大 JSON」（2026-09-21 run#52 / 09-22 run#35700532360 连续两次实锤）：
  //    @cloudbase/node-sdk 的 uploadFile 对 Buffer 是**单次 PUT 全量**
  //    （node_modules/@cloudbase/node-sdk/dist/storage/index.js:68-82 把整个 Buffer pipe 进一个 PUT），
  //    16MB 单请求从 GitHub runner 传 COS 会撞上 COS 的慢网保护 → UserNetworkTooSlow，
  //    三次重试各 ~16 分钟全失败（第 18 步是 continue-on-error ⇒ 日志里「绿」，实际 roster 没更新）。
  //    官方口径的修法就是「压缩 + 分块 + 并发」，且压缩对端上同样是净收益（下载体积降到 1/8）。
  // 落库：roster/roster_v1_27.<ts>.p{i}.zip（**带 ts 后缀**，规避 COS 按路径的 CDN 缓存脏读 —— 规则 31），
  //       每片是一个只含 roster_p{i}.json 的标准 deflate zip，端上用 FileSystemManager.unzip 原生解开。
  const ts = Date.now();
  const packs = buildPacks(all, rarityImgs, ts);
  console.log('roster 分片: ' + packs.parts + ' 片 | 原始 ' + (packs.rawTotal / 1048576).toFixed(2) +
    'MB → 压缩 ' + (packs.zipTotal / 1048576).toFixed(2) + 'MB（最大单片 ' + Math.round(packs.maxZip / 1024) + 'KB）');

  // 上一代文件（上传成功后清理，避免云存储堆积）
  let oldIDs = [];
  try {
    const o = await db.collection(M_COL).doc('roster').get();
    const od = o && o.data;
    if (od) {
      if (Array.isArray(od.fileIDs)) oldIDs = oldIDs.concat(od.fileIDs);
      if (od.fileID) oldIDs.push(od.fileID);
    }
  } catch (e) { /* 首次运行无 meta */ }

  const upOne = async function (p) {
    const cloudPath = 'roster/roster_v1_' + VER + '.' + ts + '.p' + p.i + '.zip';
    let lastErr = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try { return await app.uploadFile({ cloudPath: cloudPath, fileContent: p.zip }); }
      catch (e) {
        lastErr = e;
        console.log('  分片 ' + p.i + ' 第' + attempt + '/3 次失败: ' + String(e && e.message || e));
        if (attempt < 3) await new Promise(r => setTimeout(r, 3000 * attempt));
      }
    }
    throw lastErr;
  };

  // 并发上传（这是提速的关键：单连接受跨境 RTT 限制，并发能把总时延压到「最慢一片」量级）
  const ups = await Promise.all(packs.packs.map(upOne));
  console.log('上传完成:', ups.map(u => u.fileID.split('/').pop()).join(', '));

  await db.collection(M_COL).doc('roster').set({
    fileIDs: ups.map(u => u.fileID),
    parts: packs.parts,
    zip: true,
    ts: ts,
    count: all.length,
    schemaVersion: ROSTER_SCHEMA_VERSION,
    rawSize: packs.rawTotal,
    zipSize: packs.zipTotal
  });
  console.log('meta doc written:', M_COL + '/roster', 'parts=' + packs.parts, 'ts=' + ts, '(' + new Date(ts).toISOString() + ')');

  // 上传后读回断言（规则 31）：① meta 字段一致 ② 第一片确实是 zip（前 4 字节 PK\x03\x04）
  const rb = await db.collection(M_COL).doc('roster').get();
  const rm = (rb && rb.data) || {};
  if (!Array.isArray(rm.fileIDs) || rm.fileIDs.length !== packs.parts || rm.ts !== ts) {
    throw new Error('meta 回读断言失败: parts=' + (rm.fileIDs && rm.fileIDs.length) + ' ts=' + rm.ts + '（期望 parts=' + packs.parts + ' ts=' + ts + '）');
  }
  console.log('meta 回读断言 OK: parts=' + rm.fileIDs.length + ' ts=' + rm.ts);
  try {
    const dl = await app.downloadFile({ fileID: ups[0].fileID });
    const buf = dl && dl.fileContent;
    const hex = buf ? Buffer.from(buf).slice(0, 4).toString('hex') : '';
    if (hex === '504b0304') console.log('分片回读断言 OK: 第 1 片是合法 zip');
    else console.log('⚠️ 分片回读异常: 前 4 字节=' + (hex || '(空)') + '（期望 504b0304）');
  } catch (e) {
    console.log('分片回读跳过: ' + String(e && e.message || e).slice(0, 120));
  }

  // 清理上一代（新版 meta 已写成功才删，避免删早了没有可用数据）
  if (oldIDs.length) {
    try { await app.deleteFile({ fileList: oldIDs }); console.log('已清理上一代 roster 文件', oldIDs.length, '个'); }
    catch (e) { console.log('清理上一代跳过:', String(e && e.message || e).slice(0, 120)); }
  }

  // 4) 端到端验证：调用线上 get_players roster 分支，确认命中缓存
  try {
    const rf = await app.callFunction({ name: 'get_players', data: { version: String(VER), action: 'roster' } });
    const res = (rf && (rf.result || rf.data)) || null;
    if (res && res.code === 0 && (res.fileIDs || res.fileID)) {
      console.log('VERIFY OK: get_players roster hit, schemaVersion=' + res.schemaVersion + ', ts=' + res.ts + ' (' + (res.ts ? new Date(res.ts).toISOString() : 'N/A') + '), count=' + res.count + ', parts=' + (res.parts || 1));
    } else {
      console.log('VERIFY WARN: get_players roster 未命中 →', JSON.stringify(res).slice(0, 200));
      console.log('  （若 code=1 / 无 fileIDs：线上云函数是旧版（只认 fileID）或 count/schema 不匹配，需重传 get_players 云函数）');
    }
  } catch (e) {
    console.log('VERIFY SKIP: callFunction 不可用（' + String(e && e.message || e).slice(0, 100) + '）——已写 meta，客户端预载仍应生效');
  }
})().catch(e => { console.error('FATAL', String(e && e.message || e)); process.exit(1); });
