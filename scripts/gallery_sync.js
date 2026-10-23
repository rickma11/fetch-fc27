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
//   由 gallery_cards.js 增量转传）。库内判定用 players.json（本机）/ lib_eaids.json 快照（CI）。
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
const { publishObject, initCloud, hash8 } = require('./gen_static_lists.js');
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
const PLAYERS_FILE = path.join(ROOT, 'cloud-data', 'fc' + VER, 'players.json');       // 本机才有（.gitignore）
const LIB_SNAPSHOT_FILE = path.join(ROOT, 'cloud-data', 'fc' + VER, 'lib_eaids.json'); // 随仓提交，CI 消费

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

// solution/costTiers 的 items → 补 pool 字段 + 卡面来源判定（用户 2026-10-23 拍板：
// 库内已有的卡面绝不重复搬运，只补我们球员库里没有的 promo 卡）。
// 端上按 cardSrc/face 拼 fc27/images/ 路径（零外域依赖，与列表/详情页同一套卡面）：
//   · cardSrc='lib'   eaId 在我们球员库 → {eaId}_card.webp；imagePath 为空的 44 人
//                     face='np' → {eaId}_np.webp（与 format.js#displayImg 同规则）
//   · cardSrc='gcard' 库外 promo 卡（Future Stars/DFG/POTM…）→ {eaId}_gcard.webp，
//                     由 gallery_cards.js 从 fut.gg 增量转传（小程序不能直载外域图）
// libMap 来源：本机 players.json（本地跑自动刷新快照）；CI 上 players.json 不在 checkout，
//   读随仓提交的 lib_eaids.json 快照。
function itemsBrief(items, poolById, libMap) {
  return (items || []).map(function (it) {
    const p = poolById[String(it.eaId)] || null;
    const face = libMap[String(it.eaId)] || '';
    const o = {
      eaId: it.eaId, playerEaId: it.playerEaId,
      name: (p && (p.commonName || p.cardName)) || '',
      overall: it.overall, rarityName: (p && p.rarityName) || '',
      positions: p && Array.isArray(p.positions) ? p.positions : [],
      score: it.score, price: it.price,
      cardSrc: face ? 'lib' : 'gcard',
      face: face
    };
    if (!face) o.cardUrl = (p && p.cardImageUrl) || '';   // 仅 gcard 需要（转传源+占位）
    return o;
  });
}

// ── 库内卡面映射（eaId → 'card' | 'np'）────────────────────────────────────
// 本机：读 players.json（imagePath 非空→'card'，空→'np'，与 format.js#displayImg 同规则），
//   并刷新随仓快照 lib_eaids.json 供 CI 用；CI：players.json 不在 checkout，直接读快照。
// 快照过期只影响「新入库的卡被当成 promo 卡多传一张 _gcard」，展示不误导，可接受；
// 本地每次跑 gallery_sync 都会自动刷新快照， push 后 CI 即同步。
function loadLibMap() {
  let map = null;
  try {
    const pl = JSON.parse(fs.readFileSync(PLAYERS_FILE, 'utf8'));
    const items = Array.isArray(pl) ? pl : (pl.data || pl.players || pl.items || []);
    map = {};
    items.forEach(function (it) {
      const e = it && (it.eaId != null ? it.eaId : it.id);
      if (e != null) map[String(e)] = it.imagePath ? 'card' : 'np';
    });
  } catch (e) { map = null; }
  if (map) {
    try {
      let oldMap = {};
      try { oldMap = JSON.parse(fs.readFileSync(LIB_SNAPSHOT_FILE, 'utf8')).map || {}; } catch (e2) {}
      if (JSON.stringify(oldMap) !== JSON.stringify(map)) {
        fs.writeFileSync(LIB_SNAPSHOT_FILE, JSON.stringify({
          v: 1, updatedAt: new Date().toISOString(), count: Object.keys(map).length, map: map
        }));
        log('[快照] lib_eaids.json 已刷新（' + Object.keys(map).length + ' 张库内卡面映射）');
      }
    } catch (e) { log('⚠️ lib_eaids.json 快照刷新失败: ' + e.message); }
    return map;
  }
  try {
    const snap = JSON.parse(fs.readFileSync(LIB_SNAPSHOT_FILE, 'utf8'));
    if (snap && snap.map) { log('[快照] 用 lib_eaids.json（' + Object.keys(snap.map).length + ' 条，更新于 ' + (snap.updatedAt || '?') + '）'); return snap.map; }
  } catch (e) {}
  log('⚠️ 既无 players.json 也无 lib_eaids.json 快照——所有卡按 gcard 处理（会多传卡面，展示不误导）');
  return {};
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
function buildSetDetail(sd, poolById, libMap) {
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
    grades: gradeBrief(sd.set.grades),
    solution: {
      status: sol.status || '', computedAt: sol.computedAt || '',
      grade: sol.grade || '', totalScore: sol.totalScore || 0,
      baseGrade: sol.baseGrade || 0, bonusGrade: sol.bonusGrade || 0,
      tokens: sol.tokens || 0, maxTokens: sol.maxTokens || 0,
      items: itemsBrief(sol.items, poolById, libMap)
    },
    costTiers: (sol.costTiers || []).map(function (t) {
      return {
        grade: t.grade, threshold: t.threshold, tokens: t.tokens,
        cost: t.cost, peakPrice: t.peakPrice, status: t.status || '',
        items: itemsBrief(t.items, poolById, libMap)
      };
    }),
    tags: tags,
    fo: foDef ? { tiers: tagBrief(foDef).tiers, desc: foDef.description || '' } : null,
    // 关联 set（端上一期不用，预留）
    relatedSets: (sd.relatedSets || []).map(function (r) { return { id: r.id, name: r.name, slug: r.slug }; }).slice(0, 6)
  };
}

// ── 主流程 ────────────────────────────────────────────────────────────────
async function run() {
  log('=== FUT Gallery 同步 FC' + VER + '  ' + new Date().toLocaleString('zh-CN') + ' ===');
  log('模式: ' + (NO_UPLOAD ? '干跑(--no-upload)' : '完整(上传)') + (ONLY ? ' only=' + ONLY : '') + (SET_IDS ? ' setIds=' + Array.from(SET_IDS).join(',') : ''));

  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

  // 库内卡面映射（决定 items 的 cardSrc/face，见 loadLibMap 说明）
  const libMap = loadLibMap();

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
      const detail = buildSetDetail(sd, poolById, libMap);
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

  // ── 上传 ──
  log('\n[上传] 初始化云 ...');
  const app = initCloud();

  // 4c) gallery_index
  if (ONLY !== 'set') {
    const index = JSON.parse(fs.readFileSync(path.join(OUT_DIR, 'gallery_index.json'), 'utf8'));
    await publishObject(app, 'gallery_index', index);
    log('  ✅ gallery_index 已发布（元文档 meta_fc' + VER + '/gallery_index）');
  }

  // 4d) gallery_set_{id} × N（并发 4）
  if (ONLY !== 'index') {
    const files = fs.readdirSync(OUT_DIR).filter(function (f) { return /^gallery_set_\d+\.json$/.test(f); });
    log('[上传] gallery_set × ' + files.length + '（并发 ' + CONC + '）...');
    let ok = 0, fail = 0;
    const upRes = await poolMap(files, CONC, async function (f) {
      const obj = JSON.parse(fs.readFileSync(path.join(OUT_DIR, f), 'utf8'));
      await publishObject(app, 'gallery_set_' + obj.setId, obj);
      return true;
    });
    upRes.out.forEach(function (r) { if (r) ok++; });
    fail = upRes.errs.length;
    log('  ✅ 上传成功 ' + ok + ' / ' + files.length + (fail ? '  ❌ 失败 ' + fail : ''));
    upRes.errs.slice(0, 10).forEach(function (e) { log('    ❌ ' + e.item + ': ' + e.err.message); });
    if (fail > 0) { console.error('有 set 上传失败'); process.exit(2); }
  }

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