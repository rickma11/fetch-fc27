#!/usr/bin/env node
// FC27 卡面「同 URL 换图」内容审计（独立于每日管线，单独 workflow 派发）。
//
// 为什么需要它：管线签名 imgSigOf = 下载 URL 的 SHA1（images.js），URL 含 EA 内容 hash，
//   EA 换图路径 → 签名变 → 每日管线自动重传（这条天然覆盖绝大多数换头像，如 2026-10-27 的 12/13 批）。
//   但 fut.gg 偶尔**同 URL 原地换内容**（hash 不变）→ 签名永远不变 → 永不重传。
//   实锤：Alexia Putellas 云端 _card.webp 停在 09-23 旧头像（2026-11-04 图像比对确认），
//   与 50545314 Showdown「同 URL 重渲染评分」同属一类盲区。
//
// 机制：用「fut.gg（Cloudflare）ETag 内容指纹基线」检测同 URL 内容漂移：
//   · 基线缺失（首跑 seed）：抓全量列表 → 逐张下载 → 内容 MD5 与云端 ETag（TCB ETag=MD5）比对，
//     有差异才上传覆盖（顺手修掉历史漏网），并记录每张 URL 的 ETag 作基线。
//   · 基线存在（周跑）：对基线里的 URL 逐个 HEAD 探测（不下载图体，几百字节/张），
//     仅 ETag 变了的才下载 → 比对云端 → 有差异才上传。周跑 ≈ 20~30 分钟、流量几 MB。
//   · HEAD 404 = URL 已被 EA 换代（每日管线按签名自然覆盖）→ 移出基线。
// 基线存云存储 fc{ver}/images/img_audit_base.json（单文件覆盖；仓库零增长，图片从不进 git）。
//
// 覆盖范围与已知边界（刻意保持最小）：
//   · 只审计 card 类型（小程序主卡面）；portrait/simple 未接（需要时再加）。
//   · 上传目标只有固定名 {eaId}_card.webp。升级卡（Showdown 等）的版本化文件
//     {eaId}_card_{ovr}.webp 由每日管线负责，本脚本不碰。
//   · 新增球员的新 URL 由每日管线签名机制覆盖；本脚本只盯基线里已有的 URL。
//     URL 换代（404）被移出基线后，需要重跑 seed 才能重新纳管（建议低频 seed 周期性重建）。
//
// 用法（CI）：node scripts/audit_images.js --ver 27
//   环境变量：FC_AUDIT_MODE=auto|force-seed（默认 auto：基线缺失自动 seed）
//            FC_AUDIT_MAX=本次最多下载比对多少张（0=不限，测试可设小值）
//            FC_AUDIT_HEAD_CONC / FC_AUDIT_DL_CONC（默认 12 / 10）
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { chromium } = require('playwright');
const cloudbase = require('@cloudbase/node-sdk');
const { resolve } = require('./tcb_env');
const imgLib = require('./images');
const imgdl = require('./imgdl');

const VER = (() => {
  const a = process.argv.find(x => x.startsWith('--ver='));
  if (a) return Number(a.slice(6));
  const i = process.argv.indexOf('--ver');
  return i >= 0 ? Number(process.argv[i + 1]) : 27;
})();
const ROOT = path.resolve(__dirname, '..');
const TMP_DIR = path.join(ROOT, 'images_audit');
const BASE_LIST = `https://www.fut.gg/api/fut/players/v2/${VER}/`;
// 跟随用户真实浏览器，提升过 Cloudflare 的成功率（同 fetch_ci.js）
const UA = process.env.CF_UA || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36';
const LIST_CONC = Number(process.env.FC_LIST_CONC || 5);
const OVR_MIN = Number(process.env.FC_OVR_MIN || 1);
const HEAD_CONC = Number(process.env.FC_AUDIT_HEAD_CONC || 12);
const DL_CONC = Number(process.env.FC_AUDIT_DL_CONC || 10);
const AUDIT_MAX = Number(process.env.FC_AUDIT_MAX || 0);   // 0 = 不限
const FORCE_SEED = String(process.env.FC_AUDIT_MODE || 'auto') === 'force-seed';

const cred = resolve();
if (cred.missing.length) { console.error(cred.hint); process.exit(1); }
// 云存储前缀（桶名由环境派生，勿手写；同 gen_noportrait_cards.js）
const PREFIX = 'cloud://' + cred.ENV_ID + '.' + (cred.BUCKET || ('636c-' + cred.ENV_ID + '-1475854307')) + `/fc${VER}/images/`;
// 基线 gzip 存储（2026-11-04 冒烟实锤：20k 条明文 JSON ≈4MB，Actions→TCB 20-45KB/s 下 480s 竞速超时
// 两次全挂；gzip 后 ~400KB 秒传）。改名 .json.gz，读取端先解压。
const BASELINE_FILEID = PREFIX + 'img_audit_base.json.gz';

const app = cloudbase.init({ env: cred.ENV_ID, secretId: cred.SECRET_ID, secretKey: cred.SECRET_KEY, timeout: 480000 });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const md5hex = buf => crypto.createHash('md5').update(buf).digest('hex');

// ---- 基线读写（云存储单文件覆盖；按 125B 口径：RACE=480s + 3 次重试 + 慢速重试锁）----
async function readBaseline() {
  try {
    const res = await app.getTempFileURL({ fileList: [BASELINE_FILEID] });
    const f = res.fileList && res.fileList[0];
    if (!f || (f.code && f.code !== 'SUCCESS') || !f.tempFileURL) return null;
    const r = await fetch(f.tempFileURL + '?cb=' + Date.now());
    if (!r.ok) return null;
    const j = JSON.parse(zlib.gunzipSync(Buffer.from(await r.arrayBuffer())).toString('utf8'));
    if (j && typeof j === 'object' && j.ver === VER && j.items && typeof j.items === 'object') return j;
    return null;
  } catch (e) { return null; }
}

async function writeBaseline(items) {
  const obj = { ver: VER, updatedAt: new Date().toISOString(), items };
  const buf = zlib.gzipSync(Buffer.from(JSON.stringify(obj)));
  const RACE = 480000, MAX_ATTEMPT = 3, FAST_FAIL_MS = 90000;
  let lastErr = null, slowRetried = false;
  for (let attempt = 1; attempt <= MAX_ATTEMPT; attempt++) {
    const t0 = Date.now();
    try {
      const p = app.uploadFile({ cloudPath: `fc${VER}/images/img_audit_base.json.gz`, fileContent: buf });
      const race = new Promise((_, rej) => setTimeout(() => rej(new Error('upload race timeout')), RACE));
      await Promise.race([p, race]);
      console.log(`基线已上传 fc${VER}/images/img_audit_base.json.gz（${(buf.length / 1048576).toFixed(1)}MB gzip，${Math.round((Date.now() - t0) / 1000)}s，${Object.keys(items).length} 人）`);
      return;
    } catch (e) {
      lastErr = e;
      const elapsed = Date.now() - t0;
      console.log(`基线上传 attempt ${attempt} 失败(${Math.round(elapsed / 1000)}s): ${(e && e.message) || e}`);
      if (elapsed > FAST_FAIL_MS && (slowRetried || attempt >= MAX_ATTEMPT)) break;
      if (elapsed > FAST_FAIL_MS) slowRetried = true;
      if (attempt < MAX_ATTEMPT) await sleep(1000 * attempt);
    }
  }
  throw new Error('基线上传失败（重试后仍失败）: ' + ((lastErr && lastErr.message) || lastErr));
}

// ---- 云端 ETag（TCB ETag = 内容 MD5；批量 getTempFileURL + HEAD 临时 URL）----
async function cloudEtagMap(eaIds) {
  const out = {};               // eaId -> 归一化 etag（小写无引号）| null（文件不存在/无 etag）
  const ids = eaIds.slice();
  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50);
    let res;
    try { res = await app.getTempFileURL({ fileList: batch.map(id => PREFIX + id + '_card.webp') }); }
    catch (e) { batch.forEach(id => { out[id] = null; }); continue; }
    await Promise.all((res.fileList || []).map(async f => {
      const id = String(f.fileID).split('/').pop().replace('_card.webp', '');
      if (f.code && f.code !== 'SUCCESS') { out[id] = null; return; }   // 文件不存在等真错误 → null（按需上传）
      try {
        const r = await fetch(f.tempFileURL + '?cb=' + Date.now(), { method: 'HEAD' });
        let et = r.ok ? (r.headers.get('etag') || '') : '';
        if (!et) {  // 少数 CDN 不支持 HEAD → GET 一次（内容丢弃，只取头）
          const g = await fetch(f.tempFileURL + '?cb=' + Date.now());
          et = g.headers.get('etag') || '';
          try { if (g.body) await g.body.cancel(); } catch (e) { }
        }
        out[id] = et ? et.replace(/"/g, '').toLowerCase() : null;
      } catch (e) { out[id] = null; }
    }));
    if ((i + 50) % 2000 === 0 || i + 50 >= ids.length) console.log(`云端 ETag 进度 ${Math.min(i + 50, ids.length)}/${ids.length}`);
  }
  return out;
}

// ---- 浏览器会话（过 Cloudflare；同 fetch_ci 流程）----
async function openBrowser() {
  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox', '--disable-dev-shm-usage']
  });
  const ctx = await browser.newContext({ userAgent: UA, locale: 'en-US', viewport: { width: 1280, height: 800 }, timezoneId: 'America/New_York' });
  const page = await ctx.newPage();
  page.on('console', m => console.log('[browser]', m.text()));
  console.log('打开 fut.gg 过 Cloudflare ...');
  await page.goto('https://www.fut.gg/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  return { browser, ctx, page };
}

// seed：全量列表（按 overall 分桶翻页，复刻 fetch_ci 阶段 1 的全部已知坑：
//   越界页重复末页内容 → 连续 2 页零新增判桶末；首页失败桶退避重试一次）
async function seedFetchList(page) {
  const res = await page.evaluate(async ({ BASE, LIST_CONC, OVR_MIN }) => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const OVR_MAX = 99;
    const items = [], seen = new Set(), failedOvr = [];
    const push = arr => { let added = 0; for (const it of arr) if (it && !seen.has(it.eaId)) { seen.add(it.eaId); items.push(it); added++; } return added; };
    async function fetchBucket(ovr) {
      let dup = 0;
      for (let pg = 1; pg <= 2000; pg++) {
        let added = -1;
        for (let attempt = 0; attempt < 3 && added < 0; attempt++) {
          try {
            const r = await fetch(`${BASE}?overall__gte=${ovr}&overall__lte=${ovr}&page=${pg}`, { headers: { Accept: 'application/json' } });
            if (r.ok) {
              const j = await r.json();
              if (Array.isArray(j.data) && j.data.length) added = push(j.data);
              else return;                                   // 真空页 = 桶末
            } else if (r.status === 404) return;
            else await sleep(400 * Math.pow(2, attempt));
          } catch (e) { await sleep(400 * Math.pow(2, attempt)); }
        }
        if (added < 0) { if (pg === 1) failedOvr.push(ovr); return; }
        if (added === 0) { if (++dup >= 2) return; }         // 越界页重复末页 → 连续 2 页零新增即桶末
        await sleep(60);
      }
    }
    let ovrCursor = OVR_MAX;
    async function w() { while (true) { const o = ovrCursor--; if (o < OVR_MIN) return; await fetchBucket(o); } }
    const bucketCount = OVR_MAX - OVR_MIN + 1;
    await Promise.all(Array.from({ length: Math.min(LIST_CONC, bucketCount) }, w));
    if (failedOvr.length) {
      console.log('⚠️ 首页失败桶 ' + failedOvr.length + ' 个，退避 3s 后重试…');
      for (const ovr of failedOvr) { await sleep(3000); await fetchBucket(ovr); }
    }
    console.log('列表抓取完成，去重后', items.length, '人');
    return items;
  }, { BASE: BASE_LIST, LIST_CONC, OVR_MIN });
  if (res.length < 19000) {
    console.error('::error::列表抓取异常偏少（' + res.length + ' 人，预期 ~21000）——疑似中段 OVR 桶被限流，中止（不建残缺基线）');
    throw new Error('列表抓取异常偏少');
  }
  return res;
}

// HEAD 探测（浏览器内 fetch，credentials omit 同 imgdl methodB 口径）。
// 返回 { url: fp }；fp ∈ etag字符串 | '404' | 'ERR' | 'E<status>'
async function headProbe(page, urls) {
  return page.evaluate(async ({ urls, conc }) => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const out = {};
    let cursor = 0, done = 0;
    async function one(u) {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const r = await fetch(u, { method: 'HEAD', credentials: 'omit' });
          if (r.ok) {
            const e = r.headers.get('etag');
            if (e) return e;
            const lm = r.headers.get('last-modified') || '';
            const cl = r.headers.get('content-length') || '';
            return (lm || cl) ? (lm + '|' + cl) : '';        // 无任何指纹头 → 空串（每周都会当候选下载比对）
          }
          if (r.status === 404) return '404';
          if (r.status === 405 || r.status === 501) {        // CDN 不支持 HEAD → GET 只取头
            const g = await fetch(u, { method: 'GET', credentials: 'omit' });
            const e = g.headers.get('etag');
            const lm = g.headers.get('last-modified') || '';
            const cl = g.headers.get('content-length') || '';
            try { if (g.body) await g.body.cancel(); } catch (e2) { }
            return g.ok ? (e || ((lm || cl) ? (lm + '|' + cl) : '')) : ('E' + g.status);
          }
          return 'E' + r.status;
        } catch (e) { await sleep(300); }
      }
      return 'ERR';
    }
    async function w() {
      while (true) {
        const i = cursor++;
        if (i >= urls.length) return;
        out[urls[i]] = await one(urls[i]);
        done++;
        if (done % 2000 === 0 || done === urls.length) console.log('HEAD 探测进度', done, '/', urls.length);
        await sleep(30);
      }
    }
    await Promise.all(Array.from({ length: Math.min(conc, urls.length) }, w));
    return out;
  }, { urls, conc: HEAD_CONC });
}

// ---- 下载比对上传（候选集）----
async function auditCandidates(ctx, page, cands) {
  // cands: [{ eaId, url, rawUrl, fp }]
  fs.mkdirSync(TMP_DIR, { recursive: true });
  const sink = new imgdl.ImgSink(page);
  const probeFile = path.join(TMP_DIR, '_probe.webp');
  const CH = await imgdl.probe(ctx, page, sink, cands[0].url, probeFile, UA);
  if (!CH) throw new Error('图片下载三通道均不可用（Cloudflare 未放行 game-assets）');
  console.log('下载通道:', CH);
  const order = [CH].concat(['A', 'B', 'C'].filter(x => x !== CH));

  const cloudEt = await cloudEtagMap(cands.map(c => c.eaId));
  console.log('云端 ETag 取得:', Object.keys(cloudEt).length, '条');

  let cursor = 0, done = 0, changed = 0, sameContent = 0, failed = 0, uploaded = 0, bytes = 0;
  const okSet = new Set();
  const uploadedIds = [];
  async function dlOne(c) {
    const file = path.join(TMP_DIR, c.eaId + '_card.webp');
    let lastErr = null;
    for (const ch of order) {
      try {
        if (ch === 'A') await imgdl.methodA(ctx, c.url, file, UA);
        else if (ch === 'B') await imgdl.methodB(page, c.url, file);
        else await sink.fetch(c.url, file, 60000);
        return fs.readFileSync(file);
      } catch (e) { lastErr = e; }
    }
    // CDN 变换失败 → 退回原图（同 fetch_ci 兜底口径）
    for (const ch of order) {
      try {
        if (ch === 'A') await imgdl.methodA(ctx, c.rawUrl, file, UA);
        else if (ch === 'B') await imgdl.methodB(page, c.rawUrl, file);
        else await sink.fetch(c.rawUrl, file, 90000);
        return fs.readFileSync(file);
      } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error('download failed');
  }
  async function w() {
    while (true) {
      const i = cursor++;
      if (i >= cands.length) return;
      const c = cands[i];
      try {
        const buf = await dlOne(c);
        bytes += buf.length;
        const md5 = md5hex(buf);
        const cet = cloudEt[c.eaId];
        if (cet && cet === md5) {
          sameContent++;       // 源变了但云端已同步（管线刚传过）→ 只需刷新基线指纹
          okSet.add(c.eaId);
        } else {
          if (changed + uploaded < 3) {
            console.log(`[样例] ${c.eaId} 源ETag=${c.fp} | 云端ETag=${cet || '(无)'} | 下载MD5=${md5}`);
          }
          let okU = false, lastErr = null;
          for (let t = 0; t < 3 && !okU; t++) {
            try { await app.uploadFile({ cloudPath: imgLib.cloudPathOf(c.eaId + '_card.webp', VER), fileContent: buf }); okU = true; }
            catch (e) { lastErr = e; await sleep(1000 * (t + 1)); }
          }
          if (okU) { uploaded++; changed++; okSet.add(c.eaId); uploadedIds.push(c.eaId); }
          else { failed++; if (failed <= 5) console.log('上传失败', c.eaId, (lastErr && lastErr.message) || lastErr); }
        }
      } catch (e) {
        failed++;
        if (failed <= 5) console.log('下载失败', c.eaId, (e && e.message) || e);
      }
      try { fs.unlinkSync(path.join(TMP_DIR, c.eaId + '_card.webp')); } catch (e) { }
      done++;
      if (done % 500 === 0 || done === cands.length) {
        console.log(`比对进度 ${done}/${cands.length} | 变更上传 ${uploaded} | 内容一致 ${sameContent} | 失败 ${failed} | 已下 ${Math.round(bytes / 1048576)}MB`);
      }
      await sleep(30);
    }
  }
  await Promise.all(Array.from({ length: Math.min(DL_CONC, cands.length) }, w));
  try { fs.unlinkSync(probeFile); } catch (e) { }
  // ok = 处理完整（下载成功 且 [内容一致 | 上传成功]）的候选 —— 只有这些才允许刷新基线指纹；
  // 失败的保留下周重试（指纹仍不同 → 仍进候选）。
  if (uploadedIds.length) {
    console.log('本轮上传变更的球员 eaId（前 50）:', uploadedIds.slice(0, 50).join(','));
  }
  return { changed, sameContent, failed, uploaded, bytes, okSet: okSet };
}

(async () => {
  const t0 = Date.now();
  console.log(`=== FC${VER} 卡面内容审计 mode=${FORCE_SEED ? 'force-seed' : 'auto'} ${new Date().toLocaleString('zh-CN')} ===`);
  const stored = FORCE_SEED ? null : await readBaseline();
  const baseline = (stored && stored.items) || {};
  const seed = FORCE_SEED || !stored;
  console.log(stored ? `基线存在：${Object.keys(baseline).length} 人（更新于 ${stored.updatedAt}）→ 周跑 HEAD 探测` : '基线缺失 → seed 模式（全量下载比对 + 建基线）');

  const { browser, ctx, page } = await openBrowser();
  let urlOf = {};             // eaId -> transform URL
  try {
    if (seed) {
      const items = await seedFetchList(page);
      for (const it of items) {
        const url = imgLib.srcUrlOf(it, 'card', false);
        if (url) urlOf[String(it.eaId)] = url;
      }
      console.log('有卡面 URL 的球员:', Object.keys(urlOf).length);
    } else {
      for (const id of Object.keys(baseline)) urlOf[id] = baseline[id].u;
    }

    // CF 放行探测：seed 等列表 API（goto 已过）、周跑等 game-assets 首个 URL 放行
    const firstUrl = Object.keys(urlOf).length ? urlOf[Object.keys(urlOf)[0]] : null;
    let passed = false;
    for (let i = 0; i < 30; i++) {
      let st = -1;
      try {
        st = await page.evaluate(async (u) => {
          try { const r = await fetch(u, { credentials: 'omit' }); return r.status; } catch (e) { return -1; }
        }, firstUrl || (BASE_LIST + '?page=1'));
      } catch (e) { st = -2; }
      if (st === 200) { passed = true; console.log(`CF 已放行（第 ${i + 1} 次探测）`); break; }
      console.log(`等待 Cloudflare 放行... status=${st} (${i + 1}/30)`);
      await page.waitForTimeout(3000);
    }
    if (!passed) throw new Error('未能通过 Cloudflare（可能弹了交互式验证）');

    // HEAD 探测（seed 也先建指纹，供下周快速比对）
    const urls = Object.keys(urlOf).map(id => urlOf[id]);
    const fps = await headProbe(page, urls);
    const fpByEa = {};
    for (const id of Object.keys(urlOf)) fpByEa[id] = fps[urlOf[id]];

    // 指纹健康闸：大量 403 说明 HEAD 通道被 CF 拦（换指纹/换通道方案，不能硬下）
    const errN = urls.filter(u => fps[u] === 'ERR' || /^E\d/.test(fps[u])).length;
    if (urls.length && errN / urls.length > 0.3) {
      throw new Error(`HEAD 探测异常失败率 ${(errN / urls.length * 100).toFixed(1)}%（CF 拦截 HEAD 通道），中止避免误判`);
    }

    // 候选 = 指纹变化（seed=全部）；404 → 移出基线交给每日管线；ERR/E* → 保留旧基线下周重试
    let candidates = [];
    let dropped404 = 0, probeErr = 0;
    for (const id of Object.keys(fpByEa)) {
      const fp = fpByEa[id];
      if (fp === '404') { delete baseline[id]; dropped404++; continue; }
      if (fp === 'ERR' || /^E\d/.test(fp)) { probeErr++; continue; }
      if (seed) { candidates.push(id); continue; }
      if (!baseline[id] || baseline[id].f !== fp) candidates.push(id);
    }
    console.log(`HEAD 完成：探测 ${urls.length} | 指纹变化候选 ${candidates.length} | 404 移出 ${dropped404} | 探测错误 ${probeErr}`);

    if (AUDIT_MAX > 0 && candidates.length > AUDIT_MAX) {
      console.log(`FC_AUDIT_MAX=${AUDIT_MAX}：候选截断 ${candidates.length} → ${AUDIT_MAX}（其余下周自然重探）`);
      candidates = candidates.slice(0, AUDIT_MAX);
    }

    let stats = { changed: 0, sameContent: 0, failed: 0, uploaded: 0, bytes: 0 };
    let okSet = new Set();
    if (candidates.length) {
      const cands = candidates.map(id => {
        const u = urlOf[id];
        const rel = u.replace(imgLib.CDN + imgLib.TRANSFORM, '');
        return { eaId: id, url: u, rawUrl: imgLib.CDN + rel, fp: fpByEa[id] };
      });
      stats = await auditCandidates(ctx, page, cands);
      okSet = stats.okSet;
      // 只有处理完整的候选才刷新基线指纹；失败者保留下周重试（指纹仍不同 → 仍进候选）
      for (const id of candidates) {
        if (!okSet.has(id)) continue;
        baseline[id] = { u: urlOf[id], f: fpByEa[id] };
      }
    } else {
      // 无候选：仅把周跑探测到的新指纹回写基线（避免下周重复当候选）
      if (!seed) {
        for (const id of Object.keys(fpByEa)) {
          const fp = fpByEa[id];
          if (fp != null && fp !== 'ERR' && !/^E\d/.test(fp) && baseline[id] && baseline[id].f !== fp) baseline[id].f = fp;
        }
      }
    }

    // seed 模式：给所有还没进基线的球员建档（探测 ERR/E* → '?' 作哨兵，下周真实指纹 ≠ '?' 自然进候选重试）
    if (seed) {
      for (const id of Object.keys(urlOf)) {
        const fp = fpByEa[id];
        if (fp === '404') continue;
        if (baseline[id] && okSet.has(id)) continue;
        if (baseline[id] && baseline[id].f && baseline[id].f !== '?') continue;
        const good = fp != null && fp !== 'ERR' && !/^E\d/.test(fp);
        baseline[id] = { u: urlOf[id], f: good ? fp : '?' };
      }
    }

    await writeBaseline(baseline);

    const mins = Math.round((Date.now() - t0) / 60000);
    console.log('=== 审计完成 ===');
    console.log(`模式: ${seed ? 'seed(全量比对+建基线)' : '周跑(HEAD探测)'} | 探测 ${urls.length} | 候选 ${candidates.length} | 变更上传 ${stats.uploaded} | 内容一致(仅刷基线) ${stats.sameContent} | 404移出 ${dropped404} | 失败 ${stats.failed} | 耗时 ${mins}min`);
    if (stats.failed > 0) {
      console.error(`::error::审计有 ${stats.failed} 个候选处理失败（下载或上传），已保留下周重试。run: ${process.env.GITHUB_SERVER_URL || ''}/${process.env.GITHUB_REPOSITORY || ''}/actions/runs/${process.env.GITHUB_RUN_ID || ''}`);
      process.exitCode = 1;
    }
  } finally {
    await browser.close().catch(() => { });
  }
})().catch(e => {
  console.error('::error::' + ((e && e.message) || e));
  console.error('卡面审计失败:', (e && e.stack) || e);
  process.exit(1);
});
