'use strict';
// translate_objectives.js — FC27 任务「条件标题 + 条件正文」中译（生成层，2026-10-31 方案①+②双链）
//
// 背景：任务详情页的条件正文（objective.description）与条件标题（objective.name）为英文自由短句
//   （fut.gg 实拍 47 组 / 180 条，模板化程度高）。端上 descZh 只做整句词典命中 ⇒ 大量回落英文。
// 方案（用户 2026-10-31 确认）：①+②双链 —— LLM（DeepSeek 主 + Qwen 备）→ 全挂落免费机翻
//   （Google gtx → MyMemory）→ 仍失败保留英文（与现状零回归）。术语双层校正保证 OAO 官方译名。
// 落点：gen_objectives.js 写盘前调用 translateGroups()，译文**直接替换** name/description
//   （nameEn/descriptionEn 留原文备份）⇒ 端上零改动、零发版。组介绍 group.description 不翻（用户要求保持英文）。
//
// 缓存：cloud-data/fc27/objectives_translations.json（{ sha1(en): {en,zh,src,ts} }）。
//   命中缓存绝不再翻 ⇒ 译文永不漂移；跨 run 持久化靠 git（fetch-fc27.yml 主链 commit 本文件）。
//   CI 无 git commit 的 workflow（gen-static-lists）用 checkout 里的昨日缓存，当日内只增量。
//
// 术语层（数据与逻辑分离，对齐 yt-zh-subtitle/polish.py 的两层设计，数据源 OAO-evotrans）：
//   · 译前 pre 替换：英文 FC 术语 → OAO 官方中文译名（防 LLM/机翻自创术语，硬规则：术语不得意译）
//   · 译后 post 校正：机翻错译 → 圈内习惯说法 + 标点规整
//   · fc_terms.json 缺口（任务模式词，字幕场景没有）由下方 OBJ_TERMS 补：
//     EA 官方简中客户端 UI 口径，如与你的口径不符只改这一处。
//
// 用法：
//   模块：require('./translate_objectives.js').translateGroups(groups, { ver })
//   CLI ：node scripts/translate_objectives.js [ver]   （对现成 objectives.json 补翻/重翻并回写）
//
// env：LLM_API_KEY（必需，DeepSeek）/ LLM_BASE_URL（默认 https://api.deepseek.com）/
//      LLM_MODEL（默认 deepseek-flash）/ LLM2_API_KEY（可选，Qwen 备链）/

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const TERMS_FILE = path.join(__dirname, 'fc_terms.json');

// 补充词表：任务/挑战特有词（fc_terms.json 未覆盖）。译名口径：EA 官方简中客户端 UI。
const OBJ_TERMS = {
  'Squad Battles matches': '组内对抗比赛',
  'Squad Battles games': '组内对抗比赛',
  'Rivals matches': '对手赛比赛',
  'Rivals games': '对手赛比赛',
  'Rush matches': '快攻比赛',
  'Squad Battles': '组内对抗',
  'Division Rivals': '对手赛',
  'Rivals': '对手赛',
  'Rush': '快攻',
  'Live Event': '现场活动',
  'Live Events': '现场活动',
  'starting XI': '首发十一人',
  'starting 11': '首发十一人',
  'Buy Now': '立即购买',
  'Semi-Pro': '半职业',
  'Professional': '职业',
  'World Class': '世界级',
  'Legendary': '传奇',
  'Ultimate': '终极',
  'kit': '球衣',
  'Away kit': '客场球衣',
  'Home kit': '主场球衣',
  'National team': '国家队',
  'FUT game mode': 'FUT 比赛模式',
  'any FUT game mode': '任意 FUT 比赛模式',
  'Player Item': '球员卡',
  'Group Stage': '小组赛',
  'Knockout': '淘汰赛',
  'Qualification': '资格赛',
  'Play-Offs': '附加赛',
  'Playoffs': '附加赛',
  'Finals': '决赛',
  'objectives': '任务',
  'milestone': '里程碑'
};

// --------------------------- 术语层 ---------------------------

let PRE_TERMS = {}, PRE_CS = {}, POST_TERMS = {}, SKIP = [];
try {
  const T = JSON.parse(fs.readFileSync(TERMS_FILE, 'utf8'));
  PRE_TERMS = T.pre || {}; PRE_CS = T.pre_cs || {}; POST_TERMS = T.post || {}; SKIP = T.skip_context || [];
} catch (e) { /* 术语文件缺失不拖垮翻译链，只剩 OBJ_TERMS */ }

function esc(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// 译前匹配式：通用术语按长度降序（长词先命中）、词边界、大小写不敏感
const PRE_COMPILED = Object.keys(PRE_TERMS)
  .sort(function (a, b) { return b.length - a.length; })
  .map(function (en) {
    return { en: en, zh: PRE_TERMS[en], rx: new RegExp('(?<![A-Za-z])' + esc(en) + '(?![A-Za-z])', 'gi') };
  });
// 位置缩写等：词边界 + 区分大小写（防 cm/lb 普通缩写误伤）
const PRE_CS_COMPILED = Object.keys(PRE_CS).map(function (en) {
  return { en: en, zh: PRE_CS[en], rx: new RegExp('(?<![A-Za-z])' + esc(en) + '(?![A-Za-z])') };
});
// OBJ_TERMS：按长度降序、词边界、大小写不敏感（在 PRE 之后跑，作为缺口补充）
const OBJ_COMPILED = Object.keys(OBJ_TERMS)
  .sort(function (a, b) { return b.length - a.length; })
  .map(function (en) {
    return { en: en, zh: OBJ_TERMS[en], rx: new RegExp('(?<![A-Za-z])' + esc(en) + '(?![A-Za-z])', 'gi') };
  });
// 译后校正：长 key 先命中
const POST_SORTED = Object.keys(POST_TERMS).sort(function (a, b) { return b.length - a.length; });
const SKIP_COMPILED = SKIP.map(function (p) {
  try { return new RegExp(p, 'i'); } catch (e) { return null; }
}).filter(Boolean);

// 译前：英文 FC 术语 → OAO 标准译名（含 skip_context 上下文排除，对齐 polish.py）
function preprocess(text) {
  if (!text) return text;
  PRE_CS_COMPILED.forEach(function (x) { if (x.rx.test(text)) text = text.replace(x.rx, x.zh); });
  const all = PRE_COMPILED.concat(OBJ_COMPILED);
  for (let i = 0; i < all.length; i++) {
    const x = all[i];
    x.rx.lastIndex = 0;
    const m = x.rx.exec(text);
    if (!m) continue;
    const tail = text.slice(m.index + m[0].length, m.index + m[0].length + 30);
    if (SKIP_COMPILED.some(function (rx) { return rx.test(tail); })) continue;
    text = text.replace(x.rx, x.zh);
  }
  return text;
}

// 译后：机翻错译校正 + 标点规整 + **安全网**：输出中残留的英文术语兜底替换
//   （实锤 2026-10-31：LLM 输入曾误用原文致 57 条译文残留 Rivals/Squad Battles 等 ⇒ 任何引擎产出统一过此关）
function postprocess(text) {
  if (!text) return text;
  for (let i = 0; i < POST_SORTED.length; i++) {
    if (text.indexOf(POST_SORTED[i]) >= 0) text = text.split(POST_SORTED[i]).join(POST_TERMS[POST_SORTED[i]]);
  }
  // 安全网：已含中文 ⇒ 说明是译文，把漏网的英文术语（OBJ 补充表 + 主术语表）强制替换
  if (isZh(text)) {
    const fix = function (list) {
      list.forEach(function (x) {
        x.rx.lastIndex = 0;
        if (x.rx.test(text)) text = text.replace(x.rx, x.zh);
      });
    };
    fix(OBJ_COMPILED); fix(PRE_COMPILED);
  }
  // 量词规整：术语替换后 LLM 易产出「50组内对抗场比赛」⇒ 调成「50场组内对抗比赛」
  text = text.replace(/(\d+)\s*(组内对抗|对手赛|快攻|现场活动|周赛|冠军赛)场比赛/g, '$1场$2比赛');
  text = text.replace(/(\d+)\s*场(组内对抗|对手赛|快攻|现场活动|周赛|冠军赛)比赛/g, '$1场$2');
  text = text.replace(/(漂亮|美丽|精彩|伟大|绝妙|惊人)的目标/g, '$1的进球');
  text = text.replace(/,/g, '，').replace(/;/g, '；').replace(/(?<!\d):(?!\d)/g, '：');
  return text;
}

// --------------------------- 引擎 ---------------------------

const HAN = /[\u3400-\u4dbf\u4e00-\u9fff]/;
function isZh(s) { return HAN.test(s); }

const LLM1 = {
  name: 'deepseek',
  key: process.env.LLM_API_KEY || '',
  base: (process.env.LLM_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, ''),
  model: process.env.LLM_MODEL || 'deepseek-flash',
  thinkingOff: true
};
const LLM2 = {
  name: 'qwen',
  key: process.env.LLM2_API_KEY || '',
  base: (process.env.LLM2_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1').replace(/\/+$/, ''),
  model: process.env.LLM2_MODEL || 'qwen-flash',
  thinkingOff: false
};

const SYS_PROMPT = [
  '你是 FC27/EAFC（FIFA Ultimate Team）游戏任务条件的翻译器。输入是多行「编号|英文」格式，',
  '把每条英文翻译成简体中文，按「编号|中文」逐行输出，一行一条，绝不输出编号之外任何内容（无解释/无空行/无原文）。',
  '规则：',
  '1. 数字、评分、规格保持原样：86+、2x、min. 1、30 goals 里的数字原样保留。',
  '2. 输入为中英混合：其中已有的中文词（如 柱式中锋、组内对抗、对手赛）是官方译名，原样保留，不要改写、删除或换说法；只翻译英文部分。',
  '3. 严禁编造：原文没说的内容一个字不加，语气平实，不口语化不省略。',
  '4. 只输出译文，不输出任何给译者的话。'
].join('\n');

// node fetch 直连（不读环境代理）：DeepSeek/百炼国内端点本机与 CI 均直连可达
async function llmCall(cfg, userMsg, withThinking) {
  const body = {
    model: cfg.model,
    messages: [{ role: 'system', content: SYS_PROMPT }, { role: 'user', content: userMsg }],
    temperature: 0,
    max_tokens: 4096,
    stream: false
  };
  if (withThinking && cfg.thinkingOff) body.thinking = { type: 'disabled' };
  const ctrl = new AbortController();
  const timer = setTimeout(function () { ctrl.abort(); }, 120000);
  try {
    const r = await fetch(cfg.base + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.key },
      body: JSON.stringify(body),
      signal: ctrl.signal
    });
    if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + (await r.text()).slice(0, 160));
    const j = await r.json();
    return String((j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '').trim();
  } finally { clearTimeout(timer); }
}

// 解析 LLM 行输出「N|译文」→ {key: zh}；行缺失/重复编号容忍（缺失条目由调用方落机翻）
function parseLlmLines(out, items) {
  const map = {};
  String(out).split(/\r?\n/).forEach(function (line) {
    const m = line.match(/^\s*(\d+)\s*\|\s*(.+)$/);
    if (!m) return;
    const idx = Number(m[1]);
    const it = items[idx];
    if (it && isZh(m[2].trim())) map[it.key] = postprocess(m[2].trim());
  });
  return map;
}

// curl 子进程机翻（走代理逻辑与 gen_objectives.js 相同：FUTGG_PROXY/HTTPS_PROXY > CI 直连）
function proxyArgs() {
  const p = process.env.FUTGG_PROXY || process.env.HTTPS_PROXY || process.env.HTTP_PROXY || '';
  return p ? ['-x', p] : [];
}
function curlText(url, tries) {
  tries = tries || 2;
  return new Promise(function (resolve, reject) {
    function attempt(n) {
      execFile('curl', ['-sL', '--compressed', '--max-time', '20', '-A', 'Mozilla/5.0'].concat(proxyArgs(), [url]),
        { maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' }, function (err, stdout) {
          if (err) {
            if (n < tries) return setTimeout(function () { attempt(n + 1); }, 1500 * n);
            return reject(new Error('curl 退出 ' + err.code));
          }
          resolve(stdout);
        });
    }
    attempt(1);
  });
}
async function mtGoogle(text) {
  const url = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=zh-CN&dt=t&q=' + encodeURIComponent(text);
  const raw = await curlText(url);
  const data = JSON.parse(raw);
  const out = (data[0] || []).map(function (p) { return p[0]; }).join('');
  if (!out || !isZh(out)) throw new Error('google 空/未译');
  return out.trim();
}
async function mtMyMemory(text) {
  const url = 'https://api.mymemory.translated.net/get?q=' + encodeURIComponent(text) +
    '&langpair=en|zh-CN&email=ytzhbot%40users.noreply.github.com';
  const d = JSON.parse(await curlText(url));
  const out = (d.responseData || {}).translatedText || '';
  if (!out || !isZh(out) || out.trim() === text.trim()) throw new Error('mymemory 空/未译');
  return out.trim();
}

// 机翻链：单条 Google → MyMemory（带预处理与译后校正）
async function mtOne(text) {
  const pre = preprocess(text);
  const chains = [mtGoogle, mtMyMemory];
  for (let i = 0; i < chains.length; i++) {
    try { return postprocess(await chains[i](pre)); } catch (e) { /* 下一个 */ }
  }
  return '';
}

// LLM 批量：items 拆 80 条/批（防输出超 max_tokens 截断，实锤：341 条一次请求 4096 token 截尾漏 23 条）
async function llmBatch(cfg, items) {
  const out = {};
  const CH = 80;
  for (let i = 0; i < items.length; i += CH) {
    const part = items.slice(i, i + CH);
    const lines = part.map(function (it, j) { return j + '|' + (it.pre || it.en); });
    const res = await llmCall(cfg, lines.join('\n'), true).catch(function () {
      return llmCall(cfg, lines.join('\n'), false);   // thinking 参数不被接受时去掉重试
    });
    Object.assign(out, parseLlmLines(res, part));
  }
  return out;
}

// --------------------------- 主流程 ---------------------------

function sha1(s) { return crypto.createHash('sha1').update(String(s), 'utf8').digest('hex'); }

// 从 groups 收集待翻条目（去重）：objective.name + objective.description（组介绍不翻）
function collectItems(groups) {
  const map = {};
  groups.forEach(function (g) {
    (g.objectives || []).forEach(function (o) {
      ['name', 'description'].forEach(function (f) {
        const en = String(o[f] || '').trim();
        if (!en || isZh(en)) return;                 // 已是中文/为空
        const k = sha1(en);
        if (!map[k]) map[k] = { key: k, en: en, pre: preprocess(en) };
      });
    });
  });
  return Object.keys(map).map(function (k) { return map[k]; });
}

// 应用译文（命中缓存 + 新翻）：直接替换，原文存 nameEn/descriptionEn
function applyTranslations(groups, zhMap) {
  let n = 0;
  groups.forEach(function (g) {
    (g.objectives || []).forEach(function (o) {
      ['name', 'description'].forEach(function (f) {
        const en = String(o[f] || '').trim();
        if (!en || isZh(en)) return;
        const zh = zhMap[sha1(en)];
        if (zh) { o[f + 'En'] = en; o[f] = zh; n++; }
      });
    });
  });
  return n;
}

/**
 * 翻译 groups（就地修改）。返回统计 {fresh, cached, applied, engine}。
 * 任何异常由调用方兜底（回落英文）；本函数内部各引擎失败自动降级，不抛出。
 */
async function translateGroups(groups, opts) {
  opts = opts || {};
  const cacheFile = opts.cacheFile || path.join(ROOT, 'cloud-data', 'fc' + (opts.ver || 27), 'objectives_translations.json');

  // ① 读缓存
  let cache = {};
  try { cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8')) || {}; } catch (e) { cache = {}; }

  const items = collectItems(groups);
  const fresh = items.filter(function (it) { return !(cache[it.key] && isZh(cache[it.key].zh)); });
  const cachedCount = items.length - fresh.length;
  const engineTag = [];

  // ② 缓存命中部分直接入 zhMap（绝不再翻 ⇒ 译文永不漂移）
  const zhMap = {};
  items.forEach(function (it) {
    if (cache[it.key] && isZh(cache[it.key].zh)) zhMap[it.key] = cache[it.key].zh;
  });

  // ③ 新条目翻译链：LLM1 → LLM2 → 逐条机翻
  let remain = fresh.slice();
  if (remain.length && LLM1.key) {
    try {
      const got = await llmBatch(LLM1, remain);
      Object.keys(got).forEach(function (k) { zhMap[k] = got[k]; });
      remain = remain.filter(function (it) { return !zhMap[it.key]; });
      if (Object.keys(got).length) engineTag.push('llm:' + LLM1.name);
    } catch (e) { console.warn('[translate] LLM(' + LLM1.name + ') 失败:', e.message); }
  }
  if (remain.length && LLM2.key) {
    try {
      const got = await llmBatch(LLM2, remain);
      Object.keys(got).forEach(function (k) { zhMap[k] = got[k]; });
      remain = remain.filter(function (it) { return !zhMap[it.key]; });
      if (Object.keys(got).length) engineTag.push('llm:' + LLM2.name);
    } catch (e) { console.warn('[translate] LLM(' + LLM2.name + ') 失败:', e.message); }
  }
  if (remain.length) {
    let ok = 0;
    for (let i = 0; i < remain.length; i++) {
      const it = remain[i];
      try {
        const zh = await mtOne(it.en);
        if (zh) { zhMap[it.key] = zh; ok++; }
      } catch (e) { /* 单条失败保留英文 */ }
    }
    if (ok) engineTag.push('mt');
    remain = remain.filter(function (it) { return !zhMap[it.key]; });
    console.log('[translate] 机翻兜底: ' + ok + '/' + (ok + remain.length) + ' 条');
  }
  if (remain.length) console.log('[translate] 未译出(保留英文): ' + remain.length + ' 条');

  // ④ 应用 + 写缓存（新译出的才追加，缓存只增不改）
  const applied = applyTranslations(groups, zhMap);
  let added = 0;
  items.forEach(function (it) {
    if (zhMap[it.key] && !(cache[it.key] && isZh(cache[it.key].zh))) {
      cache[it.key] = { en: it.en, zh: zhMap[it.key], src: engineTag.join('+') || 'mt', ts: Date.now() };
      added++;
    }
  });
  try {
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify(cache, null, 1));
  } catch (e) { console.warn('[translate] 缓存写盘失败(不影响本次译文):', e.message); }

  return { fresh: added, cached: cachedCount, applied: applied, engine: engineTag.join('+') || 'none', cacheFile: cacheFile };
}

// CLI：对现成 objectives.json 补翻并回写（本地维护用；CI 走 gen_objectives.js 集成）
async function main() {
  const ver = process.argv[2] && /^\d+$/.test(process.argv[2]) ? process.argv[2] : '27';
  const file = path.join(ROOT, 'cloud-data', 'fc' + ver, 'objectives.json');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  console.log('[translate] 读', file, '(' + data.groups.length + ' 组)');
  const r = await translateGroups(data.groups, { ver: ver });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  console.log('[translate] 完成: 新翻 ' + r.fresh + ' | 缓存命中 ' + r.cached + ' | 应用 ' + r.applied + ' 条 | 引擎 ' + r.engine);
  console.log('[translate] 缓存:', r.cacheFile);
}

if (require.main === module) {
  main().catch(function (e) { console.error('[translate] 失败:', e.message); process.exit(1); });
}

module.exports = { translateGroups: translateGroups, preprocess: preprocess, postprocess: postprocess, collectItems: collectItems };
