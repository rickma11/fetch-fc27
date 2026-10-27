// player_blacklist.js —— 球员黑名单（CI 生成层共享）
// 单一真源 = 微信云开发「云存储」suppress/suppress.json 的 players 段（与端上 utils/suppress.js 同一份配置）。
// 接入方（生成层，旧版客户端也由此被屏蔽、无需发版）：
//   - warm_roster.js        roster 全量过滤（列表/搜索/筛选/图鉴计数）
//   - gen_static_details.js 静态详情分片过滤（详情页 404）
//   - price_sync.js / price_sync_cloud.js  roster 过滤（价格视图/序列/告警全链）
//   - 云函数 get_players / get_player_detail 各自内联同规则副本（wx 云函数无法 require 本仓）
// 配置语义（players 段）：
//   "Kylian Mbappé"   字符串 → 按 commonName 屏蔽全部卡（重音 NFD + 大小写归一）
//   {"eaId":231747}   屏蔽该卡，并由传入 rows 展开屏蔽同名全部卡
//   {"name":"..."}    同字符串
// 失败语义：拉取失败 → 复用上次成功缓存（TTL 外也用）；从未成功 → 空名单（fail-open，
//           绝不因配置拉不到而把整库过滤光——那会清空 roster/分片，比「少屏蔽一人」严重得多）。
const https = require('https');

const URL = 'https://636c-cloud1-d5gq6q3np8708aeef-1475854307.tcb.qcloud.la/suppress/suppress.json';
const TTL = 5 * 60 * 1000;

function normName(s) {
  return String(s == null ? '' : s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}

function fetchText(url) {
  return new Promise(function (resolve, reject) {
    const req = https.get(url, function (res) {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      let s = '';
      res.on('data', function (d) { s += d; });
      res.on('end', function () { resolve(s); });
    });
    req.on('error', reject);
    req.setTimeout(8000, function () { req.destroy(new Error('timeout')); });
  });
}

function parsePlayers(raw) {
  const bl = { names: new Set(), eaIds: new Set() };
  try {
    const obj = (typeof raw === 'string') ? JSON.parse(raw) : raw;
    const arr = (obj && Array.isArray(obj.players)) ? obj.players : [];
    arr.forEach(function (it) {
      if (typeof it === 'string') { if (it.trim()) bl.names.add(normName(it)); }
      else if (it && typeof it === 'object') {
        if (it.eaId != null && String(it.eaId).trim() !== '') bl.eaIds.add(String(it.eaId));
        if (it.name && String(it.name).trim()) bl.names.add(normName(it.name));
      }
    });
  } catch (e) { /* 解析失败按空名单（fail-open） */ }
  return bl;
}

let _cache = null;
let _at = 0;
let _pending = null;

function loadBlacklist() {
  if (_cache && (Date.now() - _at) < TTL) return Promise.resolve(_cache);
  if (_pending) return _pending;
  // 随机 query 破 CDN 边缘缓存（规则 137：固定 URL 可能读到旧内容）
  const url = URL + '?bl=' + Date.now() + Math.floor(Math.random() * 1000000);
  _pending = fetchText(url).then(function (text) {
    _cache = parsePlayers(text);
    _at = Date.now();
    return _cache;
  }).catch(function () {
    // 拉取失败：有旧缓存用旧的（不刷新时间戳，下次仍会重试），没有则空名单
    _at = Date.now();
    return _cache || { names: new Set(), eaIds: new Set() };
  }).then(function (bl) {
    _pending = null;
    return bl;
  });
  return _pending;
}

// rows: [{eaId, commonName}]（roster 投影 / details 文档都带这两字段）
// 返回 { kept, blockedEaIds }：kept=过滤后数组（不改原对象），blockedEaIds=被屏 eaId 字符串数组。
// eaId 展开：命中名单 eaId 的行，把其 commonName 并入屏蔽名集 ⇒ 同名全部卡一起屏蔽。
function applyBlacklist(rows, bl) {
  const names = new Set(bl.names);
  const list = Array.isArray(rows) ? rows : [];
  list.forEach(function (p) {
    if (p && p.eaId != null && bl.eaIds.has(String(p.eaId)) && p.commonName) names.add(normName(p.commonName));
  });
  const blockedEaIds = [];
  const kept = list.filter(function (p) {
    if (!p) return false;
    const idHit = p.eaId != null && bl.eaIds.has(String(p.eaId));
    const nameHit = p.commonName != null && names.has(normName(p.commonName));
    if (idHit || nameHit) { if (p.eaId != null) blockedEaIds.push(String(p.eaId)); return false; }
    return true;
  });
  return { kept: kept, blockedEaIds: blockedEaIds };
}

module.exports = { loadBlacklist: loadBlacklist, applyBlacklist: applyBlacklist, parsePlayers: parsePlayers, normName: normName };
