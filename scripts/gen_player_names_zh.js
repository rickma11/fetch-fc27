// gen_player_names_zh.js —— 对球员底表里的唯一 commonName，批量向 Wikipedia 取 zh 标签，生成 player_names_zh.json。
// 设计要点：
//   · 批量 50/次（API 上限），走本机代理 127.0.0.1:7890（与 yt-dlp 同套路，显式 -x）。
//   · 结果落 data/wiki_cache.json（commonName → zh 或 null），断点续跑：重跑只补缺失，不重复抓。
//   · 人工覆盖 data/player_names_override.json 优先于 Wikipedia（热门异译/纠错）。
//   · 旧 player_names_zh.json 作为「兜底」：Wikipedia 没命中且旧表有该 commonName 的，保留旧值。
// 用法：
//   node scripts/gen_player_names_zh.js                # 全量（缺啥补啥）
//   node scripts/gen_player_names_zh.js --search-fallback   # 对 Wikipedia 未命中的五大联赛/中国球员再走 search 兜底
const path = require('path');
process.chdir(path.resolve(__dirname));
const fs = require('fs');
const { execFile } = require('child_process');

const DATA = path.resolve(__dirname, '..', 'data');
const UNIV = path.join(DATA, 'player_universe.json');
const CACHE = path.join(DATA, 'wiki_cache.json');
const OVERRIDE = path.join(DATA, 'player_names_override.json');
const OLD = path.join(DATA, 'player_names_zh.json');
const OUT = path.join(DATA, 'player_names_zh.json');
const PROXY = 'http://127.0.0.1:7890';
const BATCH = 50;
const DELAY = 1500;
const CACHE_EVERY = 5; // 每 N 批落地一次缓存，防止中断丢进度

const useSearchFallback = process.argv.includes('--search-fallback');

function norm(s) { return String(s || '').trim().toLowerCase().replace(/\s+/g, '_'); }

function readJson(p, def) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return def; } }

function curlJson(url) {
  return new Promise((resolve, reject) => {
    const args = ['-s', '--max-time', '15', '-A', 'OAO-player-zh/1.0 (contact: oao@example.com)', '-x', PROXY, url];
    execFile('curl', args, { maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err) return reject(err);
      try { resolve(JSON.parse(stdout)); } catch (e) { reject(new Error('JSON 解析失败: ' + stdout.slice(0, 120))); }
    });
  });
}

async function wikiLanglinks(titles) {
  // titles: string[]；返回 Map(norm(commonName) -> zh 或 null)
  const q = 'https://en.wikipedia.org/w/api.php?action=query&format=json&prop=langlinks&lllang=zh&lllimit=max&redirects=1&titles=' +
    encodeURIComponent(titles.join('|'));
  const res = await curlJson(q);
  const map = new Map();
  titles.forEach(t => map.set(norm(t), null)); // 默认 null
  const pages = (res && res.query && res.query.pages) || {};
  Object.values(pages).forEach(pg => {
    const t = pg && pg.title;
    if (!t) return;
    const zh = (pg.langlinks && pg.langlinks[0] && pg.langlinks[0]['*']) || null;
    // 用响应 title 回映射到原始 commonName（处理重定向/规范化）
    map.set(norm(t), zh);
    // 若响应 title 与某个原始输入不同（重定向），也要把原始输入映射到同一 zh
    // （上面已用 norm 对齐；若 Wikipedia 重定向到不同规范名，norm 仍能匹配其中一个，未匹配的原始项保持 null 也可接受）
  });
  return map;
}

async function wikiSearchFallback(title) {
  const q = 'https://en.wikipedia.org/w/api.php?action=query&format=json&list=search&srsearch=' +
    encodeURIComponent(title + ' footballer') + '&srlimit=1';
  const res = await curlJson(q);
  const hit = res && res.query && res.query.search && res.query.search[0];
  if (!hit) return null;
  // 护栏：命中页标题须包含原 commonName 的「姓氏」（最后一个词，忽略大小写/重音），否则丢弃，避免搜错人。
  const lastName = String(title).trim().split(/\s+/).pop().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const hitNorm = (hit.title || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  if (lastName.length >= 3 && !hitNorm.includes(lastName)) return null;
  // 取搜索命中页的 zh 标签
  const ll = await wikiLanglinks([hit.title]);
  return ll.get(norm(hit.title)) || null;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// 繁体(港台)→简体 转换，统一为大陆简体，避免“凱恩/麥巴比”类写法破坏简体搜索匹配。
let toCN = null;
try { const OpenCC = require('opencc-js'); toCN = OpenCC.Converter({ from: 'tw', to: 'cn' }); }
catch (e) { console.log('⚠️ 未装 opencc-js，跳过繁→简转换（需 npm i opencc-js）'); }
function s2t(s) { return toCN && s ? toCN(s) : s; }
// 清洗中文名：繁→简 + 去除维基消歧括号（如「巴顿 (足球运动员)」「丁海峰 (足球員)」）。
function cleanZh(s) {
  if (!s) return s;
  s = s2t(s);
  s = s.replace(/\s*[(（][^)）]*[)）]\s*$/g, ''); // 去尾部括号消歧
  return s.trim();
}

(async () => {
  if (!fs.existsSync(UNIV)) { console.error('缺少', UNIV, '请先跑 dump_universe.js'); process.exit(1); }
  const univ = readJson(UNIV, []);
  console.log('底表唯一球员:', univ.length);

  let cache = readJson(CACHE, {}); // commonName(原始) -> zh 或 null
  const todo = univ.filter(p => !(p.commonName in cache));
  console.log('缓存已有:', Object.keys(cache).length, '| 待抓:', todo.length);

  // 分批抓
  let done = 0;
  for (let i = 0; i < todo.length; i += BATCH) {
    const slice = todo.slice(i, i + BATCH).map(p => p.commonName);
    let m = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try { m = await wikiLanglinks(slice); break; }
      catch (e) {
        const msg = String(e.message || e);
        const isRate = /too many requests/i.test(msg);
        console.log('  批次', i, '第', attempt, '次失败:', msg.slice(0, 60), isRate ? '(限流, 退避)' : '');
        if (attempt < 3) await sleep(isRate ? 8000 * attempt : 1500 * attempt);
      }
    }
    if (m) {
      // 成功：逐条写入。Wikipedia 正常返回但无 zh 页 → zh=null（合法，可缓存）。
      slice.forEach(t => { cache[t] = (m.get(norm(t)) !== undefined ? m.get(norm(t)) : null); });
    } else {
      // 整批失败（限流/网络）→ 不写入缓存，留待下次重跑重试（不污染为永久 null）。
      console.log('  批次', i, '整批失败，跳过不缓存');
    }
    done += slice.length;
    const pct = (100 * done / todo.length).toFixed(1);
    console.log('  进度', done, '/', todo.length, '(' + pct + '%) | 已得中文', Object.values(cache).filter(Boolean).length);
    if ((i / BATCH) % CACHE_EVERY === 0) fs.writeFileSync(CACHE, JSON.stringify(cache, null, 2));
    await sleep(DELAY);
  }
  fs.writeFileSync(CACHE, JSON.stringify(cache, null, 2));
  console.log('缓存写入完成, 总条目', Object.keys(cache).length);

  // search 兜底（仅五大联赛/中国 且 Wikipedia 仍 null 的）
  if (useSearchFallback) {
    const need = univ.filter(p => (cache[p.commonName] == null) && (isFiveLeague(p.league) || isChina(p.nation)));
    console.log('search 兜底目标(五联赛/中国):', need.length);
    let k = 0;
    for (const p of need) {
      try { const zh = await wikiSearchFallback(p.commonName); if (zh) cache[p.commonName] = zh; }
      catch (e) { /* 忽略单条失败 */ }
      k++; if (k % 20 === 0) console.log('  兜底进度', k, '/', need.length);
      await sleep(DELAY);
    }
    fs.writeFileSync(CACHE, JSON.stringify(cache, null, 2));
  }

  // 合并：Wikipedia 结果 + 旧表兜底 + 人工覆盖
  const override = readJson(OVERRIDE, {});
  const old = readJson(OLD, {});
  const out = {};
  univ.forEach(p => {
    const cn = p.commonName;
    const zh = cache[cn];
    if (zh) { out[cn] = { zh: cleanZh(zh), alias: (override[cn] && override[cn].alias || []).map(cleanZh) }; return; }
    // Wikipedia 未命中 → 旧表兜底
    if (old[cn] && old[cn].zh) { out[cn] = { zh: cleanZh(old[cn].zh), alias: (old[cn].alias || []).map(cleanZh) }; return; }
  });
  // 人工覆盖优先（含纠错、异译、Wikipedia 漏的）
  Object.keys(override).forEach(cn => {
    if (cn.charAt(0) === '_') return;
    const o = override[cn];
    out[cn] = { zh: cleanZh(o.zh), alias: (o.alias || (out[cn] && out[cn].alias) || []).map(cleanZh) };
  });

  // 写回（保留 _meta 元信息）
  const meta = (old._meta) || { note: '由 gen_player_names_zh.js 生成：Wikipedia zh 标签 + 人工覆盖 + 旧表兜底' };
  const finalOut = Object.assign({ _meta: meta }, out);
  fs.writeFileSync(OUT, JSON.stringify(finalOut, null, 2));

  const withZh = Object.keys(out).length;
  const remain = univ.filter(p => !(p.commonName in cache));
  console.log('生成完成:', OUT);
  console.log('  Wikipedia 命中:', univ.filter(p => cache[p.commonName]).length);
  console.log('  旧表兜底:', univ.filter(p => !cache[p.commonName] && old[p.commonName] && old[p.commonName].zh).length);
  console.log('  人工覆盖:', Object.keys(override).filter(k => k.charAt(0) !== '_').length);
  console.log('  最终有中文名:', withZh, '/', univ.length, '(' + (100 * withZh / univ.length).toFixed(1) + '%)');
  console.log('  本轮遗留未抓(可重跑补):', remain.length);
})().catch(e => { console.error('FATAL', String(e && e.message || e)); process.exit(1); });

function isFiveLeague(league) {
  if (!league) return false;
  return /premier league|la liga|bundesliga|serie a|ligue 1/i.test(league);
}
function isChina(nation) {
  if (!nation) return false;
  return /china|chinese/i.test(nation);
}
