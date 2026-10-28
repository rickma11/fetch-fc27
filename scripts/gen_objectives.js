// FC27 任务（Objectives）抓取 + 精简 → 本地静态产物 cloud-data/fc27/objectives.json
//
// 数据源：fut.gg 公开 API /api/fut/objectives/{ver}/groups?page=N（无需登录、无鉴权）。
//   信封：{ currentPage, next, totalPages, data:[group] }；page 从 1 起，totalPages 已知。
// 抓取走 curl 子进程（node fetch 不读代理，fut.gg 按出口 IP 拦机房；CI 直连、本机走 FUTGG_PROXY）。
//
// 产出供 gen_static_lists.js 作为 objectives 本地源，与其余列表（sbc/evo）统一发布到云存储。
// 排序：默认按 group.startTime 倒序（从新到旧）；无 startTime 的排末尾。端上可切换正序。
//
// 用法：
//   node scripts/gen_objectives.js [ver]            ver 默认 27（本期仅 FC27）
//   FUTGG_PROXY=http://127.0.0.1:7890 node scripts/gen_objectives.js   （本机走代理）

'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const VER = Number(process.argv[2] || process.env.FC_VER || 27);
const OUT = path.join(ROOT, 'cloud-data', 'fc' + VER, 'objectives.json');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const BASE = 'https://www.fut.gg/api/fut/objectives/' + VER + '/groups';
// 索引页：fut.gg /groups 分页存在重叠（同 id 跨页重复，把部分 group 挤出结果集），
//   故用索引页拿全量 slug 名录，缺失的走单条详情接口 BASE/{slug} 补齐。
const INDEX_URL = 'https://www.fut.gg/objectives/';

// 代理：显式 FUTGG_PROXY > 环境 HTTPS_PROXY/HTTP_PROXY；CI 不设则直连
function proxyArgs() {
  const p = process.env.FUTGG_PROXY || process.env.HTTPS_PROXY || process.env.HTTP_PROXY || '';
  return p ? ['-x', p] : [];
}

// curl 子进程抓 JSON，带退避重试（fut.gg 偶发抖动）
function curlJSON(url, tries) {
  tries = tries || 4;
  return new Promise(function (resolve, reject) {
    function attempt(n) {
      const args = ['-sL', '--compressed', '--max-time', '60', '-A', UA].concat(proxyArgs(), [url]);
      execFile('curl', args, { maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' }, function (err, stdout) {
        if (err) {
          if (n < tries) return setTimeout(function () { attempt(n + 1); }, 1000 * n);
          return reject(new Error('curl 退出 ' + err.code));
        }
        try { resolve(JSON.parse(stdout)); }
        catch (e) {
          if (n < tries) return setTimeout(function () { attempt(n + 1); }, 1000 * n);
          reject(new Error('JSON 解析失败: ' + String(stdout).slice(0, 120)));
        }
      });
    }
    attempt(1);
  });
}

// 抓纯文本（索引页 HTML）
function curlText(url, tries) {
  tries = tries || 3;
  return new Promise(function (resolve, reject) {
    function attempt(n) {
      const args = ['-sL', '--compressed', '--max-time', '60', '-A', UA].concat(proxyArgs(), [url]);
      execFile('curl', args, { maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' }, function (err, stdout) {
        if (err || !stdout) {
          if (n < tries) return setTimeout(function () { attempt(n + 1); }, 1000 * n);
          return reject(new Error('curl 取文本失败'));
        }
        resolve(stdout);
      });
    }
    attempt(1);
  });
}

// 从索引页 HTML 解析全量 slug（链接形如 /objectives/{cat}/{slug}/）
function parseIndexSlugs(html) {
  const re = /\/objectives\/([a-z-]+)\/([0-9]+-[a-z0-9-]+)\//g;
  const seen = {};
  const out = [];
  let m;
  while ((m = re.exec(html))) {
    if (!seen[m[2]]) { seen[m[2]] = 1; out.push({ cat: m[1], slug: m[2] }); }
  }
  return out;
}

async function fetchAll() {
  const first = await curlJSON(BASE + '?page=1');
  const pages = Number(first.totalPages) || 1;
  let all = Array.isArray(first.data) ? first.data : [];
  for (let p = 2; p <= pages; p++) {
    const r = await curlJSON(BASE + '?page=' + p);
    all = all.concat(Array.isArray(r.data) ? r.data : []);
  }
  return all;
}

// 单条奖励精简：只保留端上展示所需；结构化字段便于端上渲染图标
function slimAward(a) {
  if (!a || !a.type) return null;
  const o = { type: a.type, name: a.name || '', count: a.count || 1 };
  if (a.coins != null) o.coins = a.coins;
  if (a.eventToken != null) o.eventToken = a.eventToken;
  if (a.xp != null) o.xp = a.xp;
  if (a.isTokenStore) o.isTokenStore = true;
  if (a.imageUrl) o.imageUrl = a.imageUrl;
  if (a.pack) o.pack = { name: a.pack.name, description: a.pack.description || '' };
  if (a.playerItem) {
    o.playerItem = {
      name: a.playerItem.commonName || a.playerItem.name || '',
      eaId: a.playerItem.eaId,
      rating: a.playerItem.rating || 0,
      imageUrl: a.playerItem.imageUrl || ''
    };
  }
  return o;
}

function slimGroup(g, fetchedAt) {
  return {
    id: g.id,
    slug: g.slug,
    name: g.name,
    category: g.category ? { slug: g.category.slug, name: g.category.name } : { slug: '', name: '' },
    _fetchedAt: fetchedAt || '',
    description: g.description || '',
    startTime: g.startTime || '',
    endTime: g.endTime || '',
    tasksCount: g.tasksCount || 0,
    isNew: !!g.isNew,
    isExpired: !!g.isExpired,
    isPermanent: !!g.isPermanent,
    isLocked: !!g.isLocked,
    awards: (g.awards || []).map(slimAward).filter(Boolean),
    objectives: (g.objectives || []).map(function (o) {
      return {
        id: o.id,
        name: o.name,
        description: o.description || '',
        awards: (o.awards || []).map(slimAward).filter(Boolean)
      };
    })
  };
}

async function run() {
  console.log('[gen_objectives] 抓取 FC' + VER + ' objectives groups ...');
  const raw = await fetchAll();
  console.log('  原始 group 数:', raw.length);
  if (!raw.length) { console.error('未抓到任何 group，终止'); process.exit(4); }

  // ① 去重：fut.gg 分页重叠（同 id 会出现在相邻两页）→ 按 id 保留首次，避免重复计数/重复卡片
  const seenId = {};
  const uniq = [];
  raw.forEach(function (g) {
    const k = String(g && g.id);
    if (!k || seenId[k]) return;
    seenId[k] = 1;
    uniq.push(g);
  });
  if (uniq.length !== raw.length) {
    console.log('  ⚠️ 分页重叠：去重 ' + raw.length + ' → ' + uniq.length + '（按 id 保留首次）');
  }

  // ② 补全：被重叠挤出结果集的 group，用索引页 slug 名录 + 单条详情接口补回
  let filled = 0;
  try {
    const html = await curlText(INDEX_URL);
    const idx = parseIndexSlugs(html);
    const have = {};
    uniq.forEach(function (g) { if (g && g.slug) have[g.slug] = 1; });
    const missing = idx.filter(function (x) { return !have[x.slug]; });
    console.log('  索引页 slug 名录: ' + idx.length + '，本地缺失: ' + missing.length);
    for (let i = 0; i < missing.length; i++) {
      const s = missing[i].slug;
      try {
        const r = await curlJSON(BASE + '/' + s, 3);
        const g = r && (r.data || r);
        if (g && g.id && g.name) {
          uniq.push(g);
          filled++;
          console.log('    补齐: ' + g.id + ' | ' + g.name + ' (' + ((g.category && g.category.slug) || '?') + ')');
        } else {
          console.log('    跳过（空响应）: ' + s);
        }
      } catch (e) {
        console.log('    补齐失败: ' + s + ' → ' + e.message);
      }
    }
  } catch (e) {
    // 降级：索引页不可用时仅去重，不阻断（数据仍可用，只是可能缺条）
    console.warn('  ⚠️ 索引页抓取失败，跳过补全（仅去重）: ' + e.message);
  }
  console.log('  最终 group 数: ' + uniq.length + '（其中补全 ' + filled + ' 条）');

  const fetchedAt = new Date().toISOString();   // 批次抓取时间：注入每条 group._fetchedAt（供端上「数据更新于」取 max）
  const groups = uniq.map(function (g) { return slimGroup(g, fetchedAt); }).filter(Boolean);
  // 默认按 startTime 倒序（从新到旧）；无 startTime 的排末尾
  groups.sort(function (a, b) {
    const ta = a.startTime ? Date.parse(a.startTime) : 0;
    const tb = b.startTime ? Date.parse(b.startTime) : 0;
    return tb - ta;
  });

  const out = { ver: VER, count: groups.length, fetchedAt: fetchedAt, groups: groups };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  const kb = (Buffer.byteLength(JSON.stringify(out)) / 1024).toFixed(1);
  console.log('  已写本地', OUT, '(' + kb + 'KB, ' + groups.length + ' 个 group, 默认 startTime 倒序)');

  const cat = {};
  groups.forEach(function (g) { const s = (g.category && g.category.slug) || 'unknown'; cat[s] = (cat[s] || 0) + 1; });
  console.log('  分类分布:', JSON.stringify(cat));
  const nw = groups.filter(function (g) { return g.isNew; }).length;
  const expired = groups.filter(function (g) { return g.isExpired; }).length;
  const perm = groups.filter(function (g) { return g.isPermanent; }).length;
  console.log('  isNew=' + nw + ' isExpired=' + expired + ' isPermanent=' + perm);
  const awardTypes = {};
  groups.forEach(function (g) {
    g.awards.concat(g.objectives.reduce(function (acc, o) { return acc.concat(o.awards); }, [])).forEach(function (a) { awardTypes[a.type] = (awardTypes[a.type] || 0) + 1; });
  });
  console.log('  奖励类型分布:', JSON.stringify(awardTypes));
}

if (require.main === module) {
  run().catch(function (e) { console.error('失败:', e); process.exit(1); });
}

module.exports = { slimGroup: slimGroup, slimAward: slimAward, fetchAll: fetchAll, BASE: BASE };
