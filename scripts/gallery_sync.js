#!/usr/bin/env node
// FUT Gallery（收藏馆）数据同步器（2026-10-23，用户需求：小程序「收藏馆」功能数据层）。
//
// 目的：把 fut.gg 的 FC27 FUT Gallery 公开数据抓取 → 瘦身切片 → 上云存储，
//   支撑小程序 pages/fut-gallery（分类+set 列表）与 pages/fut-gallery-set（set 详情）。
//
// 数据源（全部实测无鉴权，curl 直连 200；API base 规则从其前端 bundle 破译：
//   `/api/` + (isNotFutEndpoint ? '' : 'fut/') + path + '/'，见 2026-10-23 调研记录）：
//   1) GET /api/fut/gallery/fc27/                  catalogue：10 分类 / 195 set / 21 规则标签（含 First Owner  tiers）
//   2) GET /api/fut/gallery/fc27/hub/               195 set 汇总：最佳可达 grade / totalScore / tokens / 各档成本
//   3) GET /api/fut/gallery/fc27/sets/{cat}/{slug}/ 单 set 详情：grades / solution(items+costTiers 五档最省阵容) / tags
//   4) GET /api/fut/gallery/fc27/sets/{setId}/pool/ 球员池（~177 人/set）——只为给解法卡补 cardImageUrl
//      （卡面 URL 编号 = eaId，但必须带内容 hash 段，短 URL 403，故必须拉 pool）
//   5) /api/gg-club/gallery/...owned —— 需 EA 授权登录，公开层不可得，本脚本不抓（小程序也做不了）
//
// 产物（本地 cloud-data/fc27/gallery/ + 云存储）：
//   - gallery_index.json         分类/set 元信息 + 21 标签全量定义 + 各 set 最佳可达档位/S 档成本（~400KB）
//   - gallery_set_{setId}.json ×195  单 set：五档阈值+奖励 / 默认 solution 10 人 / 五档 costTiers 完整最省阵容 /
//                                 激活标签 / First Owner 三档加成（~20KB/个）
//   - needed_gcards.json         需要转传云存储的卡面清单（eaId→game-assets URL），供卡面转传模式消费
//   - 云路径：fc27/data/gallery_index/ 与 fc27/data/gallery_set_{id}/（哈希命名，规则 99）
//   - 元文档：meta_fc27/gallery_index 与 meta_fc27/gallery_set_{id}（端上 utils/cloudJson#fetchObject 直读）
//
// 端上零云函数：JSON 全静态直读；卡面三来源——库内卡 {eaId}_card.webp/_np.webp（cardSrc='lib'，
//   与列表/详情页同一套图，不重复搬运）；库外 promo 卡 {eaId}_gcard.webp（cardSrc='gcard'，
//   由 gallery_cards.js 增量转传）。库内判定走**线上云库最新数据**（v2，规则 133：禁用本地 players.json
//   / lib_eaids 快照）；全息卡（pool.holographic=true）不转存，改用「普通卡面 + 全息标签」。
//
// 用法：
//   node scripts/gallery_sync.js 27 --no-upload          干跑：拉数据+生成本地产物，不写云
//   node scripts/gallery_sync.js 27                       完整：拉取+生成+上传 196 个 JSON + 元文档
//   node scripts/gallery_sync.js 27 --only=index          只生成+上传 gallery_index（调试用）
//   node scripts/gallery_sync.js 27 --set-ids=127,128     只处理指定 set（调试用）
//
// ⚠️ 失败语义：任一 set detail 抓取失败 → 该 set 降级为「catalogue+hub 最小数据」（列表可见、详情缺），
//   全部结束后 exit 1 让 CI 告警；绝不上传半残数据而不告知。
// ⚠️ 上传沿用 gen_static_lists.js#publishObject（SDK 180s 超时 + 3 次重试 + 回读校验 + 元文档 + 清旧，规则 116/100）。
'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { publishObject, initCloud, hash8, CLOUD_DIR, META_COLLECTION } = require('./gen_static_lists.js');
const { cn } = require('./cn_time');

const ROOT = path.resolve(__dirname, '..');
const VER = Number((process.argv[2] && !process.argv[2].startsWith('-')) ? process.argv[2] : (process.env.FC_VER || 27));
const NO_UPLOAD = process.argv.indexOf('--no-upload') >= 0;
const ONLY = ((process.argv.find(function (a) { return a.indexOf('--only=') === 0; }) || '').split('=')[1]) || '';
const SET_IDS_ARG = ((process.argv.find(function (a) { return a.indexOf('--set-ids=') === 0; }) || '').split('=')[1]) || '';
const SET_IDS = SET_IDS_ARG ? new Set(SET_IDS_ARG.split(',').map(function (s) { return Number(s.trim()); })) : null;
const CONC = 4;                       // 抓取/上传并发（规则 129：并发可叠加，单大文件更快；这里是大量小请求）
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const BASE = 'https://www.fut.gg/api/fut/gallery/fc' + VER;
const OUT_DIR = path.join(ROOT, 'cloud-data', 'fc' + VER, 'gallery');
const COL = 'players_fc' + VER;                       // 线上球员库集合（v2：唯一权威数据源）

// ── 基础工具 ──────────────────────────────────────────────────────────────
function log() { console.log.apply(console, arguments); }
function pad(n, w) { n = String(n); while (n.length < (w || 2)) n = '0' + n; return n; }
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

// ── 抓取：统一走 curl 子进程 ──
// 为什么不用 node fetch：node 内置 fetch(undici) 不读 HTTP_PROXY 环境变量，而 fut.gg 按出口 IP
// 拦截数据中心（403），本机/部分网络必须走代理（用户本机代理 127.0.0.1:7890）。curl 自动吃
// HTTPS_PROXY/HTTP_PROXY 环境变量，CI（GitHub Actions）不设代理即直连（同域 sync_votes 有 200 先例）。
function curlJSON(url, tries) {
  tries = tries || 3;
  return new Promise(function (resolve, reject) {
    const args = ['-s', '--compressed', '--max-time', '60', '-A', UA, url];
    execFile('curl', args, { maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' }, function (err, stdout, stderr) {
      if (err) { reject(new Error('curl 退出 ' + err.code + ' ' + (stderr || '').slice(0, 120))); return; }
      try { resolve(JSON.parse(stdout)); }
      catch (e) { reject(new Error('JSON 解析失败: ' + String(stdout).slice(0, 120))); }
    });
  });
}

async function fetchJSON(url, tries) {
  tries = tries || 3;
  let lastErr = null;
  for (let i = 0; i < tries; i++) {
    try { return await curlJSON(url); }
    catch (e) {
      lastErr = e;
      if (i < tries - 1) await sleep(1000 * Math.pow(2, i));   // 1s/2s 退避
    }
  }
  throw new Error('fetchJSON 失败(' + tries + '次) ' + url + ' → ' + (lastErr && lastErr.message));
}

// 并发有界映射（失败不中断整体，收集到 errs）
async function poolMap(items, conc, fn) {
  const out = new Array(items.length);
  const errs = [];
  let idx = 0;
  async function worker() {
    while (true) {
      const i = idx++;
      if (i >= items.length) return;
      try { out[i] = await fn(items[i], i); }
      catch (e) { errs.push({ item: items[i], err: e }); out[i] = null; }
    }
  }
  const ws = [];
  for (let k = 0; k < Math.min(conc, items.length); k++) ws.push(worker());
  await Promise.all(ws);
  return { out: out, errs: errs };
}

// ── 数据投影 ──────────────────────────────────────────────────────────────
// 21 个全局标签瘦身（列表/详情都需要：一手规则 tiers 就在这里面）
function tagBrief(t) {
  return {
    id: t.id, name: t.name, color: t.color || '',
    tiers: Array.isArray(t.tiers) ? t.tiers.map(function (x) { return { minItems: x.minItems, bonus: x.bonus }; }) : [],
    bonusType: t.bonusType || '', thresholdType: t.thresholdType || '',
    desc: t.description || ''
  };
}

// grades → 瘦成 {name, level, threshold, tokens}（tokens 取该档 rewards 里 event_token_1 的 value 合计）
function gradeBrief(grades) {
  return (grades || []).map(function (g) {
    let tokens = 0;
    const rewards = [];
    (g.rewards || []).forEach(function (r) {
      if (r && r.type === 'event_token_1' && typeof r.value === 'number') tokens += r.value;
      if (r && r.label) rewards.push(r.label);
    });
    return { name: g.name, level: g.level, threshold: g.threshold, tokens: tokens, rewards: rewards };
  });
}

// pool item → 卡面/展示所需最小字段
function cardBrief(x) {
  if (!x) return null;
  return {
    eaId: x.eaId, playerEaId: x.playerEaId,
    name: x.commonName || x.cardName || '',
    overall: x.overall, rarityName: x.rarityName || '',
    positions: Array.isArray(x.positions) ? x.positions : [],
    score: x.score,
    cardUrl: x.cardImageUrl || ''
  };
}

// solution/costTiers 的 items → 补 pool 字段 + 卡面来源判定
//
// ── v2（2026-10-24 拍板，实测依据见 eafc-miniapp/docs/33 §0）────────────────
// ① 库内判定一律走**线上云库最新数据**（禁本地 players.json / lib_eaids 快照）。
// ② **全息卡不转存卡面**：pool 的 `holographic:true` 是唯一可靠判据（全息 id 无前缀规律，
//    禁止按 id 段猜）；全息卡 = 普通卡面 + 端上「全息」角标，积分自带 1.5×（item.score）。
// ③ pristine 卡池里标 holographic=false 且主流程已抓 → 天然走普通卡分支，无需特殊处理。
//
// 端上按 cardSrc/faceEaId/face 拼 fc27/images/ 路径（零外域依赖，与列表/详情页同一套卡面）：
//   · cardSrc='lib'   → {faceEaId}_{face}.webp（face='card'；imagePath 为空的少数人 face='np'）
//   · cardSrc='gcard' → {eaId}_gcard.webp（由 gallery_cards.js 从 fut.gg 增量转传）
// 判定链（命中即停）：
//   非全息：libMap[eaId] → libMap[playerEaId] → 名字+总评查库 → gcard
//   全息  ：池内普通孪生(playerEaId+overall+rarityName,非全息)在库 → libMap[playerEaId]
//           → 名字+总评查库 → gcard
const FACE_STATS = { libExact: 0, libPlayerId: 0, libTwin: 0, libByName: 0, gcard: 0 };
const FACE_CACHE = {};   // eaId → { cardSrc, faceEaId, face, isHolo }（跨 set 复用，同一张卡只判一次）

function twinKey(x) { return String(x.playerEaId) + '|' + x.overall + '|' + (x.rarityName || ''); }

// 池内「普通孪生索引」：全息卡 → 同一球员同一总评同一稀有度的非全息版 eaId
function buildTwinIndex(poolById) {
  const idx = {};
  for (const k in poolById) {
    const x = poolById[k];
    if (!x || x.holographic) continue;
    const key = twinKey(x);
    if (!idx[key]) idx[key] = String(x.eaId);
  }
  return idx;
}

function itemsBrief(items, poolById, ctx) {
  return (items || []).map(function (it) {
    const p = poolById[String(it.eaId)] || null;
    const r = resolveFace(it, p, ctx);
    const o = {
      eaId: it.eaId, playerEaId: it.playerEaId,
      name: (p && (p.commonName || p.cardName)) || '',
      overall: it.overall, rarityName: (p && p.rarityName) || '',
      positions: p && Array.isArray(p.positions) ? p.positions : [],
      score: it.score, price: it.price,
      isHolo: !!r.isHolo,                       // 端上据此叠「全息」角标
      cardSrc: r.cardSrc, faceEaId: r.faceEaId, face: r.face
    };
    if (r.cardSrc === 'gcard') o.cardUrl = (p && p.cardImageUrl) || '';   // 仅 gcard 需要（转传源+占位）
    return o;
  });
}

// ── 卡面判定（单次判定 + 缓存）──────────────────────────────────────────────
function resolveFace(it, p, ctx) {
  const key = String(it.eaId);
  if (FACE_CACHE[key]) return FACE_CACHE[key];
  const isHolo = !!(p && p.holographic);
  const libMap = ctx.libMap, twinIndex = ctx.twinIndex;
  let faceEaId = ''; let how = '';

  if (isHolo) {
    // 全息：优先用「普通孪生」的库内卡面，其次 playerEaId（多为 Base Icon/Hero）
    const twinId = twinIndex[twinKey(p)];
    if (twinId && libMap[twinId]) { faceEaId = twinId; how = 'libTwin'; }
    else if (it.playerEaId != null && libMap[String(it.playerEaId)]) { faceEaId = String(it.playerEaId); how = 'libPlayerId'; }
  } else {
    if (libMap[key]) { faceEaId = key; how = 'libExact'; }
    else if (it.playerEaId != null && libMap[String(it.playerEaId)]) { faceEaId = String(it.playerEaId); how = 'libPlayerId'; }
  }

  let cardSrc = 'lib', face = faceEaId ? (libMap[faceEaId] || 'card') : '';
  if (!faceEaId) {
    // 名字+总评兜底（ctx.nameIndex 由 run() 预查询填充；键 = overall|小写的 pool 全名）
    // ⚠️ 必须用 pool 的全名：set detail 的原始 item 没有 name 字段，直接取 it.name 会永远空、兜底永不命中。
    const fullName = (p && (p.commonName || p.cardName)) || it.name || '';
    const nm = ctx.nameIndex[String(it.overall) + '|' + String(fullName).toLowerCase()];
    if (nm) { faceEaId = nm.eaId; face = nm.face; how = 'libByName'; }
    else { cardSrc = 'gcard'; face = ''; how = 'gcard'; }
  }
  FACE_STATS[how] = (FACE_STATS[how] || 0) + 1;
  const r = { isHolo: isHolo, cardSrc: cardSrc, faceEaId: faceEaId, face: face };
  FACE_CACHE[key] = r;
  return r;
}

// ── 线上库内卡面映射（eaId → 'card' | 'np'）────────────────────────────────
// 规则 133：数据判断必须用线上最新。按需 `where eaId in 批次` 查询（每批 ≤500），
// 绝不全表扫（全表 = 2 万条/天 ≈ 61 万条/月，远超 20 万/月配额，规则 92/103）。
// ⚠️ 失败必须 throw：禁止静默返回空 map（否则全量降级 gcard，会重演 4419 张误传）。
async function queryLibMap(app, ids) {
  const uniq = Array.from(new Set(ids.map(String).filter(Boolean)));
  const map = {}; let reads = 0;
  const BATCH = 500;
  for (let i = 0; i < uniq.length; i += BATCH) {
    const batch = uniq.slice(i, i + BATCH);
    const r = await app.database().collection(COL)
      .field({ eaId: true, imagePath: true })
      .where({ eaId: app.database().command.in(batch.map(Number).filter(function (n) { return !isNaN(n); })) })
      .limit(1000).get();
    const d = (r && r.data) || [];
    d.forEach(function (x) { if (x && x.eaId != null) map[String(x.eaId)] = x.imagePath ? 'card' : 'np'; });
    reads += d.length;
  }
  log('[库内] 按需查库 ' + uniq.length + ' 个 eaId → 命中 ' + Object.keys(map).length + ' 张（DB 读 ' + reads + ' 条）');
  return map;
}

// 名字+总评兜底索引（只查上一轮没命中的少量卡，避免全表扫）
async function buildNameIndex(app, missList) {
  const idx = {};
  if (!missList.length) return idx;
  const db = app.database();
  for (const m of missList) {
    try {
      const r = await db.collection(COL).field({ eaId: true, commonName: true, overall: true, imagePath: true })
        .where({ commonName: m.name, overall: Number(m.overall) }).limit(5).get();
      const d = (r && r.data) || [];
      if (d.length) idx[String(m.overall) + '|' + String(m.name || '').toLowerCase()] = { eaId: String(d[0].eaId), face: d[0].imagePath ? 'card' : 'np' };
    } catch (e) { /* 单次失败不阻塞，落 gcard */ }
  }
  log('[库内] 名字+总评兜底命中 ' + Object.keys(idx).length + ' / ' + missList.length);
  return idx;
}

// ── gallery_index ─────────────────────────────────────────────────────────
function buildIndex(catalogue, hub) {
  const hubById = {};
  (hub.sets || []).forEach(function (s) { hubById[String(s.setId)] = s; });

  const categories = (catalogue.categories || []).map(function (c) {
    return { id: c.id, name: c.name, slug: c.slug, priority: c.priority || 0 };
  });

  const sets = [];
  (catalogue.categories || []).forEach(function (c) {
    (c.sets || []).forEach(function (s) {
      const h = hubById[String(s.id)] || null;
      // 各档最省成本（hub.costTiers 与 set detail.solution.costTiers 同构；S 档成本列表页要展示）
      const costs = {};
      if (h && Array.isArray(h.costTiers)) {
        h.costTiers.forEach(function (t) { costs[t.grade] = { cost: t.cost, tokens: t.tokens, peakPrice: t.peakPrice }; });
      }
      sets.push({
        id: s.id, name: s.name, slug: s.slug, catSlug: c.slug, catName: c.name,
        desc: s.description || '', requiredCards: s.requiredCards || 0,
        grades: gradeBrief(s.grades),
        best: h ? { grade: h.grade || '', totalScore: h.totalScore || 0, tokens: h.tokens || 0, maxTokens: h.maxTokens || 0 } : null,
        costs: costs
      });
    });
  });

  return {
    v: 1, game: catalogue.game || ('fc' + VER),
    capturedAt: catalogue.capturedAt || '', computedAt: hub.computedAt || '',
    updatedAt: new Date().toISOString(),
    categories: categories,
    sets: sets,
    tags: (catalogue.tags || []).map(tagBrief)   // 含 First Owner tiers（[5:+150% / 10:+300% / 20:+500%]）
  };
}

// ── gallery_set_{id} ──────────────────────────────────────────────────────
function buildSetDetail(sd, poolById, ctx) {
  const sol = sd.solution || {};
  const tagById = {};
  (sd.tags || []).forEach(function (t) { tagById[String(t.tagId != null ? t.tagId : t.id)] = t; });

  // 激活标签：solution.tags 里 counted=true 的（本解法实际吃到的加成）+ 未激活也带上 matchedCount 供端上展示潜力
  const tags = (sol.tags || []).map(function (t) {
    const def = tagById[String(t.tagId)] || {};
    return {
      id: t.tagId, name: t.name, counted: !!t.counted,
      tier: t.tier, minItems: t.minItems, bonusPercent: t.bonusPercent,
      matchedCount: t.matchedCount, matchedScore: t.matchedScore, bonus: t.bonus
    };
  });

  // First Owner 一手加成（tagId=1）：从全局标签定义取 tiers，端上据此展示「全一手理论加成」
  const foDef = (sd.tags || []).filter(function (t) { return t.id === 1 || /first owner/i.test(t.name || ''); })[0] || null;

  return {
    v: 1, setId: sd.set.id, catSlug: (sd.category || {}).slug || '', setSlug: sd.set.slug || '',
    name: sd.set.name || '', desc: sd.set.description || '',
    requiredCards: sd.set.requiredCards || 0,
    updatedAt: new Date().toISOString(),
    // v2.1：数据源时间戳（端上判定"要不要刷新"的依据；写盘时间见 publishedAt，由发布环节写进元文档）
    dataUpdatedAt: sol.computedAt || '',
    grades: gradeBrief(sd.set.grades),
    solution: {
      status: sol.status || '', computedAt: sol.computedAt || '',
      grade: sol.grade || '', totalScore: sol.totalScore || 0,
      baseGrade: sol.baseGrade || 0, bonusGrade: sol.bonusGrade || 0,
      tokens: sol.tokens || 0, maxTokens: sol.maxTokens || 0,
      items: itemsBrief(sol.items, poolById, ctx)
    },
    costTiers: (sol.costTiers || []).map(function (t) {
      return {
        grade: t.grade, threshold: t.threshold, tokens: t.tokens,
        cost: t.cost, peakPrice: t.peakPrice, status: t.status || '',
        items: itemsBrief(t.items, poolById, ctx)
      };
    }),
    tags: tags,
    fo: foDef ? { tiers: tagBrief(foDef).tiers, desc: foDef.description || '' } : null,
    // 关联 set（端上一期不用，预留）
    relatedSets: (sd.relatedSets || []).map(function (r) { return { id: r.id, name: r.name, slug: r.slug }; }).slice(0, 6)
  };
}

// ── 上传 + 增量发布（v2.1）─────────────────────────────────────────────────
// 规则 116/100/125B：SDK 180s 超时 + 3 次重试 + race 480s + 回读校验；不清空旧文件直到新 meta 写成功。
const RACE_MS = 480000;   // 规则 125B：>1MB 产物必须 RACE≥480s，否则慢速档被 SDK 240s 强杀

async function uploadJsonSafe(app, cloudPath, buf) {
  let lastErr = null;
  for (let i = 1; i <= 3; i++) {
    try {
      const up = await Promise.race([
        app.uploadFile({ cloudPath: cloudPath, fileContent: buf }),
        new Promise(function (_, rej) { setTimeout(function () { rej(new Error('uploadFile 超时 ' + RACE_MS + 'ms')); }, RACE_MS); })
      ]);
      const fileID = (up && up.fileID) || '';
      if (!fileID) throw new Error('上传未拿到 fileID');
      const rb = await app.downloadFile({ fileID: fileID });
      const rbBuf = rb && rb.fileContent;
      if (!rbBuf || !rbBuf.length) throw new Error('回读空');
      return { fileID: fileID, rbBuf: rbBuf };
    } catch (e) {
      lastErr = e;
      console.error('  ⚠️ 上传尝试 ' + i + '/3 失败: ' + e.message);
    }
  }
  throw lastErr || new Error('上传 3 次全失败');
}

// 对比增量发布：内容 hash 与云端元文档一致 → 整段跳过（不上传、不动 meta，端上不会误判"有更新"）。
// 双层时间戳：dataUpdatedAt=数据源时间（端上刷新依据），publishedAt=本次写盘时间（排障用）。
// forceVersion 只在内容真变时 bump（旧逻辑每次 bump → 端上白下载）。
async function publishIncremental(app, name, obj, dataUpdatedAt) {
  const jsonStr = JSON.stringify(obj);
  const buf = Buffer.from(jsonStr);
  const h = hash8(buf);
  const cloudPath = CLOUD_DIR + name + '/' + name + '.' + h + '.json';

  let old = null;
  try {
    const r = await app.database().collection(META_COLLECTION).doc(name).get();
    const d = (r && r.data) || null;
    old = Array.isArray(d) ? (d[0] || null) : d;   // 规则 29：node-sdk .doc().get() 可能返回数组
  } catch (e) { old = null; }

  if (old && old.hash === h) {
    log('  ⏭ 跳过（内容未变 hash=' + h + '，现有数据不动）：' + name);
    return { changed: false, hash: h };
  }

  const up = await uploadJsonSafe(app, cloudPath, buf);
  try {
    const o = JSON.parse(up.rbBuf.toString('utf8'));
    if (!o || typeof o !== 'object' || Array.isArray(o)) throw new Error('回读非对象');
  } catch (e) { console.error('  ❌ 回读校验失败: ' + e.message); throw e; }

  const nowIso = new Date().toISOString();
  const ts = Date.now();
  await app.database().collection(META_COLLECTION).doc(name).set({
    fetchedAt: '', count: 0, fileID: up.fileID, hash: h, ts: ts,
    dataUpdatedAt: dataUpdatedAt || nowIso, dataUpdatedAtCn: cn(dataUpdatedAt || nowIso),
    publishedAt: nowIso, publishedAtCn: cn(nowIso),
    prevFileId: (old && old.fileID) || '', updatedAt: nowIso, forceVersion: ts,
    updatedAtCn: cn(nowIso), tsCn: cn(ts)
  });
  if (old && old.fileID && old.fileID !== up.fileID) {
    try { await app.deleteFile({ fileList: [old.fileID] }); log('  已清理旧文件: ' + name); }
    catch (e) { log('  ⚠️ 清理旧文件失败（不影响本次）: ' + e.message); }
  }
  log('  ✅ 已发布 ' + name + '  hash=' + h + '  (' + (jsonStr.length / 1024).toFixed(1) + 'KB)');
  return { changed: true, hash: h };
}

// ── 主流程 ────────────────────────────────────────────────────────────────
async function run() {
  log('=== FUT Gallery 同步 FC' + VER + '  ' + new Date().toLocaleString('zh-CN') + ' ===');
  log('模式: ' + (NO_UPLOAD ? '干跑(--no-upload)' : '完整(上传)') + (ONLY ? ' only=' + ONLY : '') + (SET_IDS ? ' setIds=' + Array.from(SET_IDS).join(',') : ''));

  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

  // 云初始化（v2：即使 --no-upload 干跑也要读线上库做卡面判定；无凭证直接 exit 1，禁止静默降级）
  let app = null;
  try { app = initCloud(); }
  catch (e) {
    console.error('❌ 云初始化失败（缺 TCB_* 凭证？）：' + e.message +
      '\n规则 126：CI 必须在会 initCloud 的步骤注入 TCB_ENV_ID/SECRET_ID/SECRET_KEY；本机用 .env.local。' +
      '\n禁止降级为「按 gcard 兜底」——那会重演 4419 张误传。');
    process.exit(3);
  }

  // 1) catalogue
  log('\n[1/4] 拉 catalogue ...');
  const catalogue = await fetchJSON(BASE + '/');
  const catCount = (catalogue.data && catalogue.data.categories || []).length;
  const setCount = (catalogue.data && catalogue.data.categories || []).reduce(function (n, c) { return n + (c.sets || []).length; }, 0);
  const cd = catalogue.data || catalogue;
  log('  ✅ ' + catCount + ' 分类 / ' + setCount + ' set / ' + ((cd.tags || []).length) + ' 标签  capturedAt=' + (cd.capturedAt || ''));

  // 2) hub
  log('\n[2/4] 拉 hub ...');
  const hubRaw = await fetchJSON(BASE + '/hub/');
  const hub = hubRaw.data || hubRaw;
  log('  ✅ ' + (hub.sets || []).length + ' set 汇总  computedAt=' + (hub.computedAt || ''));

  // 3) set detail × N（并发 4 + 重试 3）
  const allSets = [];
  (cd.categories || []).forEach(function (c) {
    (c.sets || []).forEach(function (s) { allSets.push({ cat: c.slug, slug: s.slug, id: s.id }); });
  });
  let targets = allSets;
  if (SET_IDS) targets = allSets.filter(function (s) { return SET_IDS.has(s.id); });
  log('\n[3/4] 拉 set detail × ' + targets.length + '（并发 ' + CONC + '）...');
  let done = 0;
  const sdRes = await poolMap(targets, CONC, async function (t) {
    const u = BASE + '/sets/' + t.cat + '/' + t.slug + '/';
    const raw = await fetchJSON(u, 3);
    done++;
    if (done % 20 === 0 || done === targets.length) log('  进度 ' + done + '/' + targets.length);
    return (raw.data || raw);
  });
  const sdOk = sdRes.out.filter(Boolean);
  log('  ✅ 成功 ' + sdOk.length + ' / ' + targets.length + (sdRes.errs.length ? '  ❌ 失败 ' + sdRes.errs.length + '（将降级）' : ''));
  sdRes.errs.slice(0, 10).forEach(function (e) { log('    ❌ set ' + e.item.cat + '/' + e.item.slug + ': ' + e.err.message); });

  // 4) pool × N（只取卡面映射）
  log('\n[4/4] 拉 pool × ' + sdOk.length + '（并发 ' + CONC + '，为解法卡补 cardImageUrl）...');
  done = 0;
  const poolRes = await poolMap(sdOk, CONC, async function (sd) {
    const raw = await fetchJSON(BASE + '/sets/' + sd.set.id + '/pool/', 3);
    done++;
    if (done % 20 === 0 || done === sdOk.length) log('  进度 ' + done + '/' + sdOk.length);
    const d = raw.data || raw;
    const map = {};
    (d.items || []).forEach(function (x) { map[String(x.eaId)] = x; });
    return map;
  });
  log('  ✅ pool 成功 ' + poolRes.out.filter(Boolean).length + ' / ' + sdOk.length);

  // 合并 pool 映射（同一 eaId 以任一 set 的为准——字段一致）
  const poolById = {};
  poolRes.out.forEach(function (m) { if (m) for (const k in m) if (!poolById[k]) poolById[k] = m[k]; });
  log('  pool 唯一球员: ' + Object.keys(poolById).length);

  // ── 4-预) 线上库内卡面映射（v2 核心，规则 133：一律线上最新）────────────
  // 候选 id = 池子全部 eaId（供全息卡找「普通孪生」）+ 解法卡的 playerEaId（供 Base Icon/Hero 兜底）
  const candIds = Object.keys(poolById).slice();
  sdOk.forEach(function (sd) {
    const sol = sd.solution || {};
    [sol].concat(sol.costTiers || []).forEach(function (blk) {
      (blk.items || []).forEach(function (it) { if (it.playerEaId != null) candIds.push(String(it.playerEaId)); });
    });
  });
  const libMap = await queryLibMap(app, candIds);
  const twinIndex = buildTwinIndex(poolById);

  // 第一遍扫描：找出「需要名字+总评兜底」的卡（很少，避免对它们逐个查库以外的开销）
  const missList = [];
  const missSeen = {};
  sdOk.forEach(function (sd) {
    const sol = sd.solution || {};
    [sol].concat(sol.costTiers || []).forEach(function (blk) {
      (blk.items || []).forEach(function (it) {
        const p = poolById[String(it.eaId)] || null;
        const isHolo = !!(p && p.holographic);
        let hit = false;
        if (isHolo) {
          const t = twinIndex[twinKey(p)];
          hit = !!(t && libMap[t]) || !!(it.playerEaId != null && libMap[String(it.playerEaId)]);
        } else {
          hit = !!libMap[String(it.eaId)] || !!(it.playerEaId != null && libMap[String(it.playerEaId)]);
        }
        if (!hit) {
          const k = String(it.overall) + '|' + String((p && (p.commonName || p.cardName)) || '').toLowerCase();
          if (!missSeen[k] && (p && (p.commonName || p.cardName))) { missSeen[k] = 1; missList.push({ overall: it.overall, name: (p.commonName || p.cardName) }); }
        }
      });
    });
  });
  const nameIndex = await buildNameIndex(app, missList);

  // 清空统计/缓存后进入正式生成（第一遍的判定不带 nameIndex，不能复用）
  Object.keys(FACE_CACHE).forEach(function (k) { delete FACE_CACHE[k]; });
  Object.keys(FACE_STATS).forEach(function (k) { FACE_STATS[k] = 0; });
  const ctx = { libMap: libMap, twinIndex: twinIndex, nameIndex: nameIndex };

  // ── 生成本地产物 ──
  const degraded = [];   // set detail 失败的 set（用 catalogue+hub 最小数据）
  const sdById = {};
  sdOk.forEach(function (sd) { sdById[String(sd.set.id)] = sd; });

  // 4a) gallery_index
  if (ONLY !== 'set') {
    const index = buildIndex(cd, hub);
    // 降级 set 也要进 index（列表可见），degraded 标记供端上显示「详情暂缺」
    const idxIds = new Set(index.sets.map(function (s) { return String(s.id); }));
    (cd.categories || []).forEach(function (c) {
      (c.sets || []).forEach(function (s) {
        if (idxIds.has(String(s.id))) return;
        const h = (hub.sets || []).filter(function (x) { return String(x.setId) === String(s.id); })[0] || null;
        const costs = {};
        if (h && Array.isArray(h.costTiers)) h.costTiers.forEach(function (t) { costs[t.grade] = { cost: t.cost, tokens: t.tokens, peakPrice: t.peakPrice }; });
        index.sets.push({
          id: s.id, name: s.name, slug: s.slug, catSlug: c.slug, catName: c.name,
          desc: s.description || '', requiredCards: s.requiredCards || 0,
          grades: gradeBrief(s.grades),
          best: h ? { grade: h.grade || '', totalScore: h.totalScore || 0, tokens: h.tokens || 0, maxTokens: h.maxTokens || 0 } : null,
          costs: costs, degraded: true
        });
      });
    });
    index.degradedCount = index.sets.filter(function (s) { return s.degraded; }).length;
    const idxStr = JSON.stringify(index);
    fs.writeFileSync(path.join(OUT_DIR, 'gallery_index.json'), idxStr);
    log('\n[生成] gallery_index.json  ' + (idxStr.length / 1024).toFixed(1) + 'KB  sets=' + index.sets.length +
      '  degraded=' + index.degradedCount + '  tags=' + index.tags.length);
  }

  // 4b) gallery_set_{id} × N + 卡面需求清单
  if (ONLY !== 'index') {
    const needGcards = {};   // eaId -> cardUrl（lib 之外的卡才需要）
    let n = 0;
    for (const sd of sdOk) {
      const detail = buildSetDetail(sd, poolById, ctx);
      const str = JSON.stringify(detail);
      fs.writeFileSync(path.join(OUT_DIR, 'gallery_set_' + sd.set.id + '.json'), str);
      n++;
      [detail.solution].concat(detail.costTiers || []).forEach(function (blk) {
        (blk.items || []).forEach(function (it) {
          if (it.cardSrc === 'gcard' && it.cardUrl && !needGcards[String(it.eaId)]) needGcards[String(it.eaId)] = it.cardUrl;
        });
      });
    }
    const needStr = JSON.stringify(needGcards);
    fs.writeFileSync(path.join(OUT_DIR, 'needed_gcards.json'), needStr);
    log('[生成] gallery_set_*.json × ' + n + '  需转传卡面 ' + Object.keys(needGcards).length + ' 张');
    log('[卡面判定] 库内精确 ' + FACE_STATS.libExact + ' / 库内 playerEaId ' + FACE_STATS.libPlayerId +
      ' / 全息→普通孪生 ' + FACE_STATS.libTwin + ' / 名字兜底 ' + FACE_STATS.libByName +
      ' / 需转存 gcard ' + FACE_STATS.gcard + '   （全息卡共 ' + (FACE_STATS.libTwin + FACE_STATS.libPlayerId) + ' 张走普通卡面+标签口径）');
    // 顺手落一份本地已传清单的初始化（卡面转传模式消费/回写）
    const sentFile = path.join(OUT_DIR, 'sent_gcards.json');
    if (!fs.existsSync(sentFile)) fs.writeFileSync(sentFile, '{}');

    // 卡面缺口检查（不阻塞：缺口等 gallery_cards.js 转传，但必须显式告警，不能静默）
    try {
      const sent = JSON.parse(fs.readFileSync(sentFile, 'utf8')) || {};
      const missing = Object.keys(needGcards).filter(function (k) { return !sent[k]; });
      if (missing.length) {
        log('⚠️ 卡面缺口 ' + missing.length + ' 张（需跑 gallery_cards.js 转传）：' +
          missing.slice(0, 20).join(',') + (missing.length > 20 ? ' …' : ''));
      } else {
        log('卡面覆盖完整（' + Object.keys(needGcards).length + ' 张全部已传）');
      }
    } catch (e) { log('⚠️ sent_gcards.json 读取失败: ' + e.message); }
  }

  if (NO_UPLOAD) {
    log('\n=== 干跑完成（未写云）。产物目录: ' + OUT_DIR + ' ===');
    if (sdRes.errs.length) process.exit(1);
    return;
  }

  // ── 上传（v2.1：对比增量 —— hash 未变整段跳过，现有数据零影响）──
  const PUB = { changed: 0, skipped: 0, failed: 0 };

  // 4c) gallery_index
  if (ONLY !== 'set') {
    const index = JSON.parse(fs.readFileSync(path.join(OUT_DIR, 'gallery_index.json'), 'utf8'));
    const r = await publishIncremental(app, 'gallery_index', index, index.computedAt || index.capturedAt || '');
    PUB[r.changed ? 'changed' : 'skipped']++;
  }

  // 4d) gallery_set_{id} × N（并发 4）
  if (ONLY !== 'index') {
    const files = fs.readdirSync(OUT_DIR).filter(function (f) { return /^gallery_set_\d+\.json$/.test(f); });
    log('[上传] gallery_set × ' + files.length + '（并发 ' + CONC + '，增量：仅内容变化才写云）...');
    const upRes = await poolMap(files, CONC, async function (f) {
      const obj = JSON.parse(fs.readFileSync(path.join(OUT_DIR, f), 'utf8'));
      const r = await publishIncremental(app, 'gallery_set_' + obj.setId, obj, obj.dataUpdatedAt || obj.updatedAt || '');
      return r;
    });
    upRes.out.forEach(function (r) { if (!r) return; PUB[r.changed ? 'changed' : 'skipped']++; });
    PUB.failed = upRes.errs.length;
    upRes.errs.slice(0, 10).forEach(function (e) { log('    ❌ ' + e.item + ': ' + e.err.message); });
  }

  log('\n[发布汇总] 变更 ' + PUB.changed + ' / 跳过 ' + PUB.skipped + ' / 失败 ' + PUB.failed);
  if (PUB.failed > 0) { console.error('有产物发布失败'); process.exit(2); }

  log('\n=== gallery_sync 完成 ===');
  if (sdRes.errs.length) {
    console.error('⚠️ ' + sdRes.errs.length + ' 个 set detail 抓取失败（已降级进 index），需人工复查');
    process.exit(1);
  }
}

if (require.main === module) {
  run().catch(function (e) { console.error('失败:', e); process.exit(1); });
}

module.exports = { fetchJSON: fetchJSON, buildIndex: buildIndex, buildSetDetail: buildSetDetail, tagBrief: tagBrief, gradeBrief: gradeBrief, itemsBrief: itemsBrief };