// dict_basic 静态 JSON 生成器（替代云函数 cloudfunctions/dict_basic，2026-10-04）。
//
// 背景：原 dict_basic 云函数每小时从 Gitee 拉词典写云数据库 dicts，端上 utils/dictSync.js 用
//   wx.cloud.callFunction 读取 —— 每次打开/下拉都消耗云函数+DB 配额。翻译词典属于「读多写少、可缓存」，
//   与 home_hot / get_sbcs 同构，应改为「CI 预生成静态 JSON 落云存储，端上 downloadFile 直读」。
//
// 产物（与 gen_static_lists.js 同机制，meta 存放跟 home_hot 一致）：
//   - fc27/data/dict_basic/dict_basic.<hash8>.json   （哈希命名，内容变=换名，绕开覆写缓存坑）
//   - 写元文档 meta_fc27/dict_basic = {fetchedAt,count,fileID,hash,ts,contentSig,forceVersion}
//   - 端上 utils/cloudJson.js#fetchObject 直读，零云函数调用（失败回退包内词典）
//
// 数据来源（与 cloudfunctions/dict_basic/index.js 同口径，逐项照搬抽取逻辑）：
//   · basic（稀有度/卡类型 + SBC 短语 + EVO 进化条件中文化）＝ built-in-dictionaries.json#basic
//     ＋ miniapp-dictionaries.json#{sbc,EVO}
//   · names（联赛/俱乐部/国家）＝ sync_i18n.js 的 buildMaps（包内快照 BUNDLE ＋ 增长层 SUPP ＋ Gitee basic gap-fill），
//     与线上 dicts/names 同源同口径（不再依赖云函数覆盖写）；再叠加 built-in-dictionaries.json#names 段做二次 gap-fill
//   · evolutions（进化名中文）＝ evolutions1.json（数组）
//   · tac（阵型战术推荐文章链接）/ player_review（球员公众号评测）/ tlib（战术库开关）
//     ＝ miniapp-dictionaries.json#{TAC,PLAYER_REVIEW,TLIB}，沿用云函数里的白名单/开关解析
//
// 校验闸门（与云函数一致，防把词典写坏）：basic<10 / evolutions<10 / names 四类合计<50 ⇒ 本次拒绝发布（保留上次好文件）。
// 幂等：内容哈希未变 ⇒ 跳过上传（不浪费存储操作、不 bump forceVersion）。
// 回读校验：uploadFile 可能假成功，必须 downloadFile 读回断言解析。
//
// 用法：
//   node scripts/gen_dict_static.js [ver]            （ver 默认 27；发布到 meta_fc{ver}）
//   node scripts/gen_dict_static.js 27 --no-upload   （仅本地抽取+组装校验，不写云）
//   node scripts/gen_dict_static.js 27 --from-local <dir>  （从本地目录读三份 JSON 文件做抽取校验，不写云）
//     <dir> 下需有：built-in-dictionaries.json / miniapp-dictionaries.json / evolutions1.json

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const zlib = require('zlib');
const cloudbase = require('@cloudbase/node-sdk');
const { cn } = require('./cn_time');

const ROOT = path.resolve(__dirname, '..');
const VER = Number(process.argv[2] || process.env.FC_VER || 27);
const NO_UPLOAD = process.argv.indexOf('--no-upload') >= 0;
let LOCAL_DIR = null;
for (let i = 0; i < process.argv.length; i++) {
  if (process.argv[i] === '--from-local' && process.argv[i + 1]) LOCAL_DIR = path.resolve(process.argv[i + 1]);
}
const CLOUD_DIR = 'fc' + VER + '/data/dict_basic/';
const META_COLLECTION = 'meta_fc' + VER;
const META_DOC = 'dict_basic';

// ── Gitee 源（与 cloudfunctions/dict_basic 一致）──
const SRC_URL = process.env.DICT_SRC_URL || 'https://gitee.com/rickma11/OAO-evotrans/raw/master/built-in-dictionaries.json';
const MINIAPP_SBC_URL = process.env.DICT_MINIAPP_URL || 'https://gitee.com/rickma11/OAO-evotrans/raw/master/miniapp-dictionaries.json';
const EVOLUTIONS_URL = process.env.DICT_EVO_URL || 'https://gitee.com/rickma11/OAO-evotrans/raw/master/evolutions1.json';

// 校验闸门阈值（与云函数一致）
const MIN_ENTRIES = 10;
const MIN_EVO_ENTRIES = 10;
const MIN_NAME_ENTRIES = 50;
const TAC_KEY = '阵型战术推荐';
const TAC_ALLOW_HOST = 'https://mp.weixin.qq.com/';
const NAME_KINDS = ['league', 'leagueShort', 'club', 'nation'];

// ---------- HTTP（跟随 301/302 ＋ gzip/deflate）----------
function httpGetText(url, depth) {
  depth = depth || 0;
  return new Promise(function (resolve, reject) {
    let req;
    try {
      req = https.get(url, {
        headers: {
          'User-Agent': 'OAO-miniapp-dict-static',
          'Accept': 'application/json,text/plain,*/*',
          'Accept-Encoding': 'gzip, deflate'
        },
        timeout: 20000
      }, function (res) {
        const code = res.statusCode;
        if (code >= 300 && code < 400 && res.headers.location && depth < 3) {
          res.resume();
          const loc = res.headers.location;
          const next = loc.indexOf('http') === 0 ? loc : new (require('url').URL)(loc, url).href;
          resolve(httpGetText(next, depth + 1));
          return;
        }
        if (code !== 200) { res.resume(); reject(new Error('HTTP ' + code + ' 拉取 ' + url)); return; }
        const enc = String(res.headers['content-encoding'] || '');
        let stream = res;
        if (enc.indexOf('gzip') >= 0) stream = res.pipe(zlib.createGunzip());
        else if (enc.indexOf('deflate') >= 0) stream = res.pipe(zlib.createInflate());
        const chunks = [];
        stream.on('data', function (c) { chunks.push(c); });
        stream.on('end', function () { resolve(Buffer.concat(chunks).toString('utf8')); });
        stream.on('error', reject);
      });
    } catch (e) { reject(e); return; }
    req.on('timeout', function () { req.destroy(new Error('timeout（Gitee 不可达？）')); });
    req.on('error', reject);
  });
}

// ---------- HTTP 重试包装（Gitee 偶发超时/抖动：单次失败不应让整轮 dict-static 挂掉）----------
// 2026-10-04 run#8 实锤：GitHub Actions runner 拉 Gitee raw 偶发 20s socket 超时，
// 原 httpGetText 无重试 ⇒ 整轮失败（幸而下一小时 run#9 重跑成功，数据未过期）。
// 此处加 5 次指数退避重试（与 sync_votes.js / memory 规则 116 同口径；
// 2026-10-07 #78 曾因 Gitee 抖动连吃 ECONNRESET+timeout 3 次全败，故由 3 提至 5 以扛过更长抖动窗口）。
async function httpGetTextRetry(url, maxAttempts) {
  maxAttempts = maxAttempts || 5;
  let lastErr;
  for (let i = 0; i < maxAttempts; i++) {
    try {
      return await httpGetText(url, 0);
    } catch (e) {
      lastErr = e;
      if (i < maxAttempts - 1) {
        const wait = 1200 * (i + 1) + Math.random() * 400;
        console.warn('[gen_dict_static] 拉取 ' + url + ' 第 ' + (i + 1) + ' 次失败（' + e.message + '），' + Math.round(wait) + 'ms 后重试');
        await new Promise(function (r) { setTimeout(r, wait); });
      }
    }
  }
  throw lastErr;
}

// ---------- 抽取（与云函数逐字同口径）----------
function zhOf(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'object') return String(v.webpagedata || v.shorten || '').trim();
  return '';
}
function extractBasic(json) {
  const basic = json && json.basic;
  if (!basic || typeof basic !== 'object') throw new Error('词典里找不到 basic 段（结构可能变了）');
  const map = {};
  Object.keys(basic).forEach(function (k) {
    const zh = zhOf(basic[k]);
    if (zh) map[k] = zh;
  });
  return map;
}
function extractCategory(json, name) {
  const sec = json && json[name];
  if (!sec || typeof sec !== 'object') return {};
  const map = {};
  Object.keys(sec).forEach(function (k) {
    const zh = zhOf(sec[k]);
    if (zh) map[k] = zh;
  });
  return map;
}
function extractNames(json) {
  const n = json && json.names;
  if (!n || typeof n !== 'object') return null;
  const buckets = {};
  let total = 0;
  NAME_KINDS.forEach(function (kind) {
    const src = n[kind];
    const m = {};
    if (src && typeof src === 'object') {
      Object.keys(src).forEach(function (k) {
        const v = src[k];
        const kk = String(k || '').trim();
        if (kk && typeof v === 'string' && v) { m[kk] = v; total++; }
      });
    }
    buckets[kind] = m;
  });
  if (!total) return null;
  return buckets;
}
function extractEvolutions(text) {
  let arr;
  try { arr = JSON.parse(text); } catch (e) { throw new Error('进化词典不是合法 JSON：' + e.message); }
  if (!Array.isArray(arr)) throw new Error('进化词典顶级结构不是数组');
  const map = {};
  arr.forEach(function (it) {
    const en = it && (it.name || '').toString().trim();
    const zh = it && (it.CN || '').toString().trim();
    if (en && zh) map[en] = zh;
  });
  return map;
}
function extractEvoSourceMap(text) {
  let arr;
  try { arr = JSON.parse(text); } catch (e) { throw new Error('进化词典不是合法 JSON：' + e.message); }
  if (!Array.isArray(arr)) throw new Error('进化词典顶级结构不是数组');
  const map = {};
  arr.forEach(function (it) {
    const en = it && (it.name || '').toString().trim();
    const src = it && (it.source || '').toString().trim();
    if (en && src) map[en] = src;
  });
  return map;
}
// 白名单：mp.weixin.qq.com 单篇文章（支持 /s/ 短链 和 /s?__biz= 长链；允许 http/https；拒绝合集/非 mp 域名）
function isMpWeixinUrl(u) {
  const s = String(u == null ? '' : u).trim();
  if (!s) return '';
  if (!/^https?:\/\/mp\.weixin\.qq\.com\/s([/?#]|$)/i.test(s)) return '';
  return s.replace(/^http:\/\//i, 'https://');
}

// ---------- 云初始化（仅上传时）----------
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
  // rule 116：SDK 层加 180s 硬上限，避免 upload/download 偶发卡死无限挂。
  return cloudbase.init({ env: envId, secretId: sid, secretKey: skey, timeout: 180000 });
}
function shortFid(fid) { return fid ? String(fid).slice(0, 64) + (fid.length > 64 ? '…' : '') : ''; }
function hash8(buf) { return crypto.createHash('md5').update(buf).digest('hex').slice(0, 8); }

// rule 116：downloadFile 回读偶发 ECONNRESET/卡死，须 3 次重试 + race=200s（>SDK timeout 180s，让 SDK 先自我中止）。
async function downloadFileSafe(app, fileID) {
  const RACE_MS = 200000;
  async function once() {
    return Promise.race([
      app.downloadFile({ fileID: fileID }),
      new Promise(function (_, rej) {
        setTimeout(function () { rej(new Error('race-timeout-200s')); }, RACE_MS);
      })
    ]);
  }
  let lastErr = null;
  for (let i = 0; i < 3; i++) {
    try {
      const rb = await once();
      return rb;
    } catch (e) {
      lastErr = e;
      console.warn('[gen_dict_static] 回读第 ' + (i + 1) + ' 次失败（' + ((e && e.message) || e) + '），' + (i < 2 ? '1.5s 后重试' : '放弃'));
      if (i < 2) await new Promise(function (r) { setTimeout(r, 1500); });
    }
  }
  throw lastErr || new Error('回读全部重试失败');
}

// ---------- 组装词典（返回合并对象，含六段）----------
async function buildDict() {
  let srcText, miniappText, evoText;
  if (LOCAL_DIR) {
    srcText = fs.readFileSync(path.join(LOCAL_DIR, 'built-in-dictionaries.json'), 'utf8');
    miniappText = fs.readFileSync(path.join(LOCAL_DIR, 'miniapp-dictionaries.json'), 'utf8');
    evoText = fs.readFileSync(path.join(LOCAL_DIR, 'evolutions1.json'), 'utf8');
  } else {
    srcText = await httpGetTextRetry(SRC_URL);
    miniappText = await httpGetTextRetry(MINIAPP_SBC_URL);
    evoText = await httpGetTextRetry(EVOLUTIONS_URL);
  }
  const srcJson = JSON.parse(srcText);
  const miniappJson = JSON.parse(miniappText);

  // ① basic（稀有度/卡类型）＋ SBC 短语 ＋ EVO 进化条件中文化
  const basic = extractBasic(srcJson);
  const sbcMap = extractCategory(miniappJson, 'sbc');
  Object.keys(sbcMap).forEach(function (k) { if (!(k in basic)) basic[k] = sbcMap[k]; });
  const evoMapCat = extractCategory(miniappJson, 'EVO');
  Object.keys(evoMapCat).forEach(function (k) { if (!(k in basic)) basic[k] = evoMapCat[k]; });

  // ② names：优先 sync_i18n 同源（包内快照 BUNDLE ＋ 增长层 SUPP ＋ Gitee basic gap-fill），
  //    再叠加 built-in-dictionaries.json#names 段做二次 gap-fill（保留云函数旧口径，最大化覆盖）
  let leagueZh = {}, leagueShort = {}, clubZh = {}, nationZh = {};
  try {
    const i18n = require('./sync_i18n.js');
    const giteeBasic = i18n.parseGiteeBasic(miniappJson);
    const maps = i18n.buildMaps(giteeBasic);
    leagueZh = maps.leagueZh || {}; leagueShort = maps.leagueShort || {};
    clubZh = maps.clubZh || {}; nationZh = maps.nationZh || {};
  } catch (e) {
    console.warn('[gen_dict_static] 复用 sync_i18n 失败（' + e.message + '），仅用 built-in-dictionaries#names 兜底');
  }
  const giteeNames = extractNames(srcJson);
  if (giteeNames) {
    NAME_KINDS.forEach(function (kind) {
      const target = kind === 'league' ? leagueZh : (kind === 'leagueShort' ? leagueShort : (kind === 'club' ? clubZh : nationZh));
      const src = giteeNames[kind] || {};
      Object.keys(src).forEach(function (k) { if (!target[k]) target[k] = src[k]; });
    });
  }
  const names = {
    map: { league: leagueZh, leagueShort: leagueShort, club: clubZh, nation: nationZh },
    counts: {
      league: Object.keys(leagueZh).length,
      leagueShort: Object.keys(leagueShort).length,
      club: Object.keys(clubZh).length,
      nation: Object.keys(nationZh).length
    }
  };

  // ③ evolutions（进化名中文）＋ 来源映射
  const evoMap = extractEvolutions(evoText);
  const evoSource = extractEvoSourceMap(evoText);
  const evolutions = { map: evoMap, sourceMap: evoSource, count: Object.keys(evoMap).length };

  // ④ tac（阵型战术推荐文章链接，白名单校验）
  const tacRaw = String((extractCategory(miniappJson, 'TAC')[TAC_KEY]) || '').trim();
  const okTac = isMpWeixinUrl(tacRaw);
  const tac = { enabled: !!okTac, map: okTac ? (function () { var o = {}; o[TAC_KEY] = okTac; return o; })() : {}, count: okTac ? 1 : 0 };

  // ⑤ player_review（球员公众号评测文章链接，白名单校验；键＝球员 eaId）
  // 值兼容两种格式：纯 URL 字符串 / 对象 {webpagedata, shorten, timestamp}（与 FCUT 同口径）
  const prSec = (miniappJson && miniappJson.PLAYER_REVIEW) || null;
  const prMap = {};
  if (prSec && typeof prSec === 'object') {
    Object.keys(prSec).forEach(function (k) {
      const v = prSec[k];
      let url = '';
      if (typeof v === 'string') url = isMpWeixinUrl(v);
      else if (v && typeof v === 'object') url = isMpWeixinUrl(v.webpagedata);
      if (url) prMap[String(k)] = url;
    });
  }
  const player_review = { enabled: true, map: prMap, count: Object.keys(prMap).length };

  // ⑥ fcut（FCUT常识文章列表：运营在 Gitee 词典以对象 map 录入，"标题": {"webpagedata":"url","shorten":"n"}；
  //   白名单校验；shorten 越小越靠前；全版本通用，不按版本过滤）
  const fcutRaw = (miniappJson && miniappJson.FCUT) || {};
  const fcutMap = {};
  Object.keys(fcutRaw).forEach(function (k) {
    const v = fcutRaw[k];
    let url = '';
    let shorten = '';
    if (typeof v === 'string') {
      url = isMpWeixinUrl(v);
    } else if (v && typeof v === 'object') {
      url = isMpWeixinUrl(v.webpagedata);
      shorten = String(v.shorten || '').trim();
    }
    if (url) {
      fcutMap[k] = { url: url, shorten: shorten };
    } else {
      console.warn('[gen_dict_static] FCUT 跳过非法条目 title=' + k + ' raw=' + String(v || ''));
    }
  });
  const fcut = { enabled: true, map: fcutMap, count: Object.keys(fcutMap).length };

  // ⑦ tlib（战术库开关；on 必须显式 boolean，否则写 null 让端上回落包内默认开）
  const tlibSec = (miniappJson && miniappJson.TLIB) || null;
  let on = null;
  if (tlibSec) {
    const onRaw = tlibSec.on;
    if (onRaw === 1 || onRaw === '1' || onRaw === true || onRaw === 'true') on = true;
    else if (onRaw === 0 || onRaw === '0' || onRaw === false || onRaw === 'false') on = false;
  }
  const tlib = {
    on: on,
    maxRows: (tlibSec && Number(tlibSec.maxRows)) || 500000,
    retentionDays: (tlibSec && Number(tlibSec.retentionDays)) || 90
  };

  // 校验闸门（与云函数一致）
  if (Object.keys(basic).length < MIN_ENTRIES) throw new Error('basic 段仅 ' + Object.keys(basic).length + ' 条（<' + MIN_ENTRIES + '），拒绝发布');
  if (evolutions.count < MIN_EVO_ENTRIES) throw new Error('进化段仅 ' + evolutions.count + ' 条（<' + MIN_EVO_ENTRIES + '），拒绝发布');
  let nameTotal = 0;
  NAME_KINDS.forEach(function (k) { nameTotal += names.counts[k]; });
  if (nameTotal < MIN_NAME_ENTRIES) throw new Error('names 段合计仅 ' + nameTotal + ' 条（<' + MIN_NAME_ENTRIES + '），拒绝发布');

  const dict = {
    fetchedAt: new Date().toISOString(),
    basic: { map: basic },
    names: names,
    evolutions: evolutions,
    tac: tac,
    player_review: player_review,
    fcut: fcut,
    tlib: tlib
  };
  return dict;
}

// 内容 sig（仅取内容本质字段，忽略时间戳），用于幂等判断
function contentSig(dict) {
  const pick = {
    basic: dict.basic, names: dict.names, evolutions: dict.evolutions,
    tac: dict.tac, player_review: dict.player_review, fcut: dict.fcut, tlib: dict.tlib
  };
  return crypto.createHash('md5').update(JSON.stringify(pick)).digest('hex');
}

// 发布单版本：哈希命名上传 ＋ 写元文档 ＋ 回读校验 ＋ 清理旧文件 ＋ 内容未变跳过
async function publishDict(app, dict) {
  const ts = Date.now();
  const jsonStr = JSON.stringify(dict);
  const buf = Buffer.from(jsonStr);
  const h = hash8(buf);
  const cloudPath = CLOUD_DIR + META_DOC + '.' + h + '.json';

  // 读旧元文档（拿 prevFileId / prevHash / prevFV / prevSig）
  let prevFileId = '', prevHash = '', prevFV = 0, prevSig = '';
  try {
    const old = await app.database().collection(META_COLLECTION).doc(META_DOC).get();
    const od = (old && old.data) || null;
    if (od) {
      prevFileId = od.fileID || ''; prevHash = od.hash || '';
      prevFV = od.forceVersion || 0; prevSig = od.contentSig || '';
    }
  } catch (e) { /* 首轮无元文档 */ }

  const sig = contentSig(dict);
  const nowIso = new Date().toISOString();

  // 内容未变 ⇒ 跳过上传（保留上次 fileID / forceVersion），仅快速返回
  if (prevSig && prevSig === sig) {
    console.log('[gen_dict_static] 内容未变（sig=' + sig.slice(0, 10) + '），跳过上传 meta_fc' + VER + '/' + META_DOC);
    return { skipped: true, sig: sig };
  }

  if (NO_UPLOAD) {
    console.log('[gen_dict_static] --no-upload：已组装 dict（' + (jsonStr.length / 1024).toFixed(1) + 'KB），未写云');
    console.log('  basic=' + Object.keys(dict.basic.map).length +
      ' names(league/club/nation)=' + dict.names.counts.league + '/' + dict.names.counts.club + '/' + dict.names.counts.nation +
      ' evo=' + dict.evolutions.count +
      ' tac.enabled=' + dict.tac.enabled + ' player_review=' + dict.player_review.count + ' fcut=' + dict.fcut.count + ' tlib.on=' + dict.tlib.on);
    return { skipped: true, sig: sig };
  }

  const up = await app.uploadFile({ cloudPath: cloudPath, fileContent: buf });
  const fileID = (up && up.fileID) || '';
  if (!fileID) { console.error('  ❌ 上传未拿到 fileID'); process.exit(6); }
  console.log('  已上传:', cloudPath, '→', shortFid(fileID));

  // 回读校验（rule 116：downloadFile 偶发 ECONNRESET/卡死，走重试包装）
  try {
    const rb = await downloadFileSafe(app, fileID);
    const rbBuf = rb && rb.fileContent;
    if (!rbBuf || !rbBuf.length) throw new Error('回读空');
    const rbObj = JSON.parse(rbBuf.toString('utf8'));
    if (!rbObj || typeof rbObj !== 'object' || !rbObj.basic || !rbObj.basic.map) throw new Error('回读结构不符');
    console.log('  ✅ 回读校验通过');
  } catch (e) { console.error('  ❌ 回读校验失败:', e.message); process.exit(7); }

  const forceVersion = (prevHash && prevHash === h) ? prevFV : ts;
  await app.database().collection(META_COLLECTION).doc(META_DOC).set({
    fetchedAt: nowIso, count: Object.keys(dict.basic.map).length, fileID: fileID, hash: h, ts: ts,
    contentSig: sig, forceVersion: forceVersion, updatedAt: nowIso,
    fetchedAtCn: cn(nowIso), updatedAtCn: cn(nowIso), tsCn: cn(ts)
  });
  console.log('  已写元文档 meta_fc' + VER + '/' + META_DOC + ' forceVersion=' + forceVersion);

  if (prevFileId && prevFileId !== fileID) {
    try { await app.deleteFile({ fileList: [prevFileId] }); console.log('  已清理旧文件:', shortFid(prevFileId)); }
    catch (e) { console.log('  ⚠️ 清理旧文件失败（不影响本次）:', e.message); }
  }
  return { skipped: false, sig: sig, fileID: fileID, forceVersion: forceVersion };
}

async function run() {
  const dict = await buildDict();
  if (NO_UPLOAD) { await publishDict(null, dict); return; }
  const app = initCloud();
  const r = await publishDict(app, dict);
  console.log('\n=== gen_dict_static 完成（ver=' + VER + '）===' + (r.skipped ? ' [内容未变，跳过]' : ''));
}

if (require.main === module) {
  run().catch(function (e) { console.error('失败:', e); process.exit(1); });
}

module.exports = { buildDict: buildDict, contentSig: contentSig, publishDict: publishDict, hash8: hash8, CLOUD_DIR: CLOUD_DIR, META_COLLECTION: META_COLLECTION, META_DOC: META_DOC };
