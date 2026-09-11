// 用 Playwright 的真实 Chromium（TLS 指纹正确）绕过 Cloudflare Managed Challenge，
// 在 fut.gg 页面同源内用浏览器原生 fetch 抓 FC{VER} 数据，落盘为 fc27_dump.json。
// 之后由 scripts/fetch_futgg.js --from-dump 做离线成型（不发任何网络请求）。
//
// 两种模式：
//   full        —— 抓全量列表 + 每一条的详情（每周兜底 / 首次建立基线）
//   incremental —— 抓全量列表（便宜），用内容签名与上次快照对比，
//                  只对「新增 / 变化」的卡重抓详情，大幅减少请求量
//
// 签名计算放在 Node 侧（共用 scripts/sig.js），浏览器只负责发请求，
// 这样既能保证签名算法全局唯一，也不受页面 CSP 对动态求值的限制。
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { sigOfRaw, diffSigs } = require('./sig');
const imgLib = require('./images');
const dl = require('./imgdl');

const VER = 27;
const BASE = `https://www.fut.gg/api/fut/players/v2/${VER}/`;
const DET = `https://www.fut.gg/api/fut/player-item-definitions/${VER}/`;
const OUT = path.resolve(__dirname, '..', 'fc27_dump.json');
const SNAP = path.resolve(__dirname, '..', 'cloud-data', `fc${VER}`, 'snapshot.json');
const IMG_DIR = path.resolve(__dirname, '..', 'images_out');
const IMG_CONC = Number(process.env.FC_IMG_CONC || 10);
const FORCE_IMG = String(process.env.FC_IMG_FORCE || '') === '1';
// 单次运行最多下多少张图。0 = 不限。
// 日常跑设个上限，避免某天突然新增大量球员时把任务拖成几小时；
// 首次全量背图用 0（不限）一次性铺完。
const IMG_MAX = Number(process.env.FC_IMG_MAX || 0);

// 模式：环境变量 FC_MODE 优先，其次命令行 --mode=xxx
function argMode() {
  const a = process.argv.find(x => x.startsWith('--mode='));
  return a ? a.slice(7) : '';
}
const MODE_IN = String(process.env.FC_MODE || argMode() || 'auto').toLowerCase();
const LIST_CONC = Number(process.env.FC_LIST_CONC || 5);
const DET_CONC = Number(process.env.FC_DET_CONC || 5);

// 跟随用户真实浏览器（Chrome/147），提升过 Cloudflare 的成功率
const UA = process.env.CF_UA || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36';

function readSnapshot() {
  try {
    const j = JSON.parse(fs.readFileSync(SNAP, 'utf8'));
    return (j && j.sigs && typeof j.sigs === 'object') ? j.sigs : null;
  } catch (e) { return null; }
}

(async () => {
  let mode = MODE_IN === 'full' ? 'full' : 'incremental';
  const snap = (mode === 'incremental') ? readSnapshot() : null;
  if (mode === 'incremental' && !snap) {
    console.log('未找到快照 cloud-data/fc' + VER + '/snapshot.json，自动降级为 full 全量抓取');
    mode = 'full';
  }
  console.log(`抓取模式: ${mode}${snap ? `（快照基准 ${Object.keys(snap).length} 条）` : ''}`);

  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox', '--disable-dev-shm-usage']
  });
  const ctx = await browser.newContext({
    userAgent: UA,
    locale: 'en-US',
    viewport: { width: 1280, height: 800 },
    timezoneId: 'America/New_York'
  });
  const page = await ctx.newPage();
  page.on('console', m => console.log('[browser]', m.text()));

  console.log('打开 fut.gg 过 Cloudflare ...');
  await page.goto('https://www.fut.gg/', { waitUntil: 'domcontentloaded', timeout: 60000 });

  // 等待 Cloudflare 放行：轮询同源 API 直到返回 200。
  // 注意 cf_clearance 是 HttpOnly cookie，document.cookie 读不到，只能靠实际请求探测。
  let passed = false;
  for (let i = 0; i < 30; i++) {
    let status = 0;
    try {
      status = await page.evaluate(async (u) => {
        try { const r = await fetch(u, { headers: { Accept: 'application/json' } }); return r.status; }
        catch (e) { return -1; }
      }, `${BASE}?page=1`);
    } catch (e) { status = -2; }
    if (status === 200) { passed = true; console.log(`Cloudflare 已通过（第 ${i + 1} 次尝试）`); break; }
    console.log(`等待 Cloudflare 挑战解除... status=${status} (${i + 1}/30)`);
    await page.waitForTimeout(3000);
  }
  if (!passed) {
    await browser.close();
    console.error('未能通过 Cloudflare（可能弹了交互式验证），退出');
    process.exit(1);
  }

  // ---------- 阶段 1：抓全量列表（先探总数，再并发翻页）----------
  const listRes = await page.evaluate(async ({ BASE, LIST_CONC }) => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const r1 = await fetch(`${BASE}?page=1`, { headers: { Accept: 'application/json' } });
    if (!r1.ok) throw new Error('列表第 1 页失败 status=' + r1.status);
    const j1 = await r1.json();
    const meta = {};
    Object.keys(j1).forEach(k => { if (k !== 'data') meta[k] = j1[k]; });
    console.log('列表响应根级字段:', Object.keys(j1).join(','));
    Object.keys(meta).forEach(k => console.log('  元信息 ' + k + ' =', JSON.stringify(meta[k])));

    const first = Array.isArray(j1.data) ? j1.data : [];
    const pageSize = first.length || 30;

    let cnt = null;
    ['count', 'total', 'totalCount'].forEach(k => { if (typeof j1[k] === 'number') cnt = j1[k]; });
    let totalPages = null;
    ['numPages', 'totalPages'].forEach(k => { if (typeof j1[k] === 'number') totalPages = j1[k]; });
    if (totalPages === null && cnt !== null) totalPages = Math.ceil(cnt / pageSize);
    console.log('分页推断: count=' + cnt + ' pageSize=' + pageSize + ' totalPages=' + totalPages);
    if (cnt !== null && cnt > 10000) {
      console.log('⚠️ 接口 count=' + cnt + ' 超过 10000，疑似被 max_result_window 截断，实际可见条目会少于该值');
    }

    const items = [], seen = new Set();
    const push = arr => { for (const it of arr) if (it && !seen.has(it.eaId)) { seen.add(it.eaId); items.push(it); } };
    push(first);

    if (totalPages && totalPages > 1) {
      // 已知道总页数 → 并发翻页（对 fut.gg 压力可控：每请求间隔 60ms）
      const cap = Math.min(totalPages, 2000);
      let cursor = 2, okPages = 1, errPages = 0;
      async function w() {
        while (true) {
          const pg = cursor++;
          if (pg > cap) return;
          try {
            const r = await fetch(`${BASE}?page=${pg}`, { headers: { Accept: 'application/json' } });
            if (r.ok) {
              const j = await r.json();
              if (Array.isArray(j.data)) push(j.data);
              okPages++;
            } else { errPages++; }
          } catch (e) { errPages++; }
          if ((cursor - 2) % 100 === 0) console.log('列表进度 page', cursor - 1, '/', cap, '累计', seen.size, '人');
          await sleep(60);
        }
      }
      await Promise.all(Array.from({ length: LIST_CONC }, w));
      console.log('并发翻页完成: 成功页', okPages, '失败页', errPages);
    } else {
      // 无分页元信息 → 顺序翻页到末页（404/空页即终止）
      for (let pg = 2; pg <= 999; pg++) {
        try {
          const r = await fetch(`${BASE}?page=${pg}`, { headers: { Accept: 'application/json' } });
          if (!r.ok) { console.log('列表第', pg, '页结束 status=', r.status, '（404=已翻到末页，属正常终止）'); break; }
          const j = await r.json();
          if (!Array.isArray(j.data) || j.data.length === 0) { console.log('列表第', pg, '页为空，到达末页'); break; }
          push(j.data);
        } catch (e) { console.log('列表第', pg, '页异常，停止:', e.message); break; }
        if (pg % 25 === 0) console.log('列表进度: page', pg, '累计', seen.size, '人');
        await sleep(100);
      }
    }
    console.log('列表抓取完成，去重后', items.length, '人');
    return { items, meta, pageSize, totalPages, count: cnt };
  }, { BASE, LIST_CONC });

  // ---------- 阶段 2：Node 侧算签名 + 差异比对 ----------
  const sigs = {};
  for (const it of listRes.items) sigs[it.eaId] = sigOfRaw(it);

  const curIds = Object.keys(sigs);
  const diff = (mode === 'full') ? diffSigs(null, sigs) : diffSigs(snap, sigs);
  const newIds = diff.newIds, changedIds = diff.changedIds, removedIds = diff.removedIds;
  // 增量模式但快照被判定不可用 → 已在上方降级为 full，这里再兜一层
  if (mode !== 'full' && diff.fullFallback) {
    console.log('快照不可用，本次按全量处理');
    newIds.length = 0; newIds.push.apply(newIds, curIds);
    changedIds.length = 0; removedIds.length = 0;
  }
  const targets = (mode === 'full') ? curIds : newIds.concat(changedIds);

  console.log('--- 差异统计 ---');
  console.log('列表总数:', curIds.length);
  if (mode === 'full') console.log('全量模式: 需抓详情', targets.length, '条');
  else console.log('新增:', newIds.length, '| 变化:', changedIds.length, '| 未变(跳过详情):', curIds.length - targets.length, '| 下架:', removedIds.length);

  // ---------- 阶段 3：抓详情（只抓需要的）----------
  const detRes = await page.evaluate(async ({ DET, ids, DET_CONC }) => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const out = {};
    let cursor = 0, done = 0, failed = 0;
    async function one(id) {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const r = await fetch(`${DET}${id}/`, { headers: { Accept: 'application/json' } });
          if (r.ok) return await r.json();
          if (r.status === 404) return { data: null };
          await sleep(500 * (attempt + 1));
        } catch (e) { await sleep(500 * (attempt + 1)); }
      }
      return null;
    }
    async function w() {
      while (true) {
        const i = cursor++;
        if (i >= ids.length) return;
        const id = ids[i];
        const raw = await one(id);
        if (raw) out[id] = raw; else failed++;
        done++;
        if (done % 200 === 0 || done === ids.length) {
          console.log('详情进度', done, '/', ids.length, failed ? ('| 失败 ' + failed) : '');
        }
        await sleep(60);
      }
    }
    if (ids.length) await Promise.all(Array.from({ length: DET_CONC }, w));
    return { details: out, failed };
  }, { DET, ids: targets, DET_CONC });

  console.log('详情抓取完成:', Object.keys(detRes.details).length, '条，失败', detRes.failed, '条');

  // ---------- 阶段 4：下载球员图片（按签名增量，全量模式也跳过未变的）----------
  const imgStats = { planned: 0, done: 0, failed: 0, skipped: 0, bytes: 0, channel: '' };
  if (String(process.env.FC_IMG || '1') !== '0') {
    const manifest = imgLib.readManifest(VER);
    const types = imgLib.activeTypes();
    const tasks = [];
    const taskMeta = {};
    const typeOrder = {};
    types.forEach((t, i) => { typeOrder[t.key] = i; });
    for (const it of listRes.items) {
      const eaId = it.eaId;
      const sig = imgLib.imgSigOf(it);
      if (!sig) continue;                                   // 该球员没有图片字段
      if (!FORCE_IMG && manifest[eaId] === sig) { imgStats.skipped++; continue; }
      const files = {};
      for (const t of types) {
        const url = imgLib.srcUrlOf(it, t, false);
        if (!url) continue;
        const name = imgLib.fileNameOf(eaId, t);
        files[t.key] = name;
        tasks.push({
          eaId, type: t.key, url,
          rawUrl: imgLib.srcUrlOf(it, t, true),
          file: path.join(IMG_DIR, name),
          ovr: Number(it.overall) || 0
        });
      }
      if (Object.keys(files).length) taskMeta[eaId] = { sig, files };
    }
    // 高总评优先：这样即使单次有上限，也是先把最常被浏览的卡补齐
    tasks.sort((a, b) => (b.ovr - a.ovr) || (Number(a.eaId) - Number(b.eaId)) || (typeOrder[a.type] - typeOrder[b.type]));
    if (IMG_MAX > 0 && tasks.length > IMG_MAX) {
      console.log(`图片任务 ${tasks.length} 张，本次上限 ${IMG_MAX} 张（余下下次继续）`);
      tasks.length = IMG_MAX;
    }
    imgStats.planned = tasks.length;
    console.log(`图片下载: 待下载 ${tasks.length} 张（球员 ${Object.keys(taskMeta).length} 人 / 已有签名跳过 ${imgStats.skipped} 人 / 类型 ${types.map(t => t.key).join(',')}）`);

    if (tasks.length) {
      fs.mkdirSync(IMG_DIR, { recursive: true });
      const sink = new dl.ImgSink(page);

      // 探测可用通道：A=Node 侧请求，B=页面内 fetch，C=img + response body
      fs.mkdirSync(IMG_DIR, { recursive: true });
      const probeFile = path.join(IMG_DIR, '_probe.bin');
      let channel = await dl.probe(ctx, page, sink, tasks[0].url, probeFile, UA);
      try { fs.unlinkSync(probeFile); } catch (e) { }
      if (channel === 'C') await dl.disableCache(ctx, page);
      if (!channel) {
        console.error('三种图片下载通道全部不可用，跳过图片下载（数据同步不受影响）');
      } else {
        imgStats.channel = channel;
        const order = channel === 'A' ? ['A', 'B', 'C'] : channel === 'B' ? ['B', 'C', 'A'] : ['C', 'B', 'A'];
        const pick = (ch, url, file, tmo) =>
          ch === 'A' ? dl.methodA(ctx, url, file, UA)
            : ch === 'B' ? dl.methodB(page, url, file)
              : sink.fetch(url, file, tmo);

        let cursor = 0;
        async function worker() {
          while (true) {
            const i = cursor++;
            if (i >= tasks.length) return;
            const t = tasks[i];
            let lastErr = null, ok = false;
            for (const ch of order) {
              try { imgStats.bytes += await pick(ch, t.url, t.file, 60000); ok = true; break; }
              catch (e) { lastErr = e; }
            }
            if (!ok && t.rawUrl && t.rawUrl !== t.url) {
              // 缩放地址不通 → 退回原图
              for (const ch of order) {
                try { imgStats.bytes += await pick(ch, t.rawUrl, t.file, 90000); ok = true; break; }
                catch (e) { lastErr = e; }
              }
            }
            if (ok) imgStats.done++;
            else {
              imgStats.failed++;
              if (imgStats.failed <= 5) console.log('[img] 失败', t.eaId, t.type, (lastErr && lastErr.message) || lastErr);
            }
            if ((imgStats.done + imgStats.failed) % 500 === 0) {
              console.log('图片进度', imgStats.done + imgStats.failed, '/', tasks.length,
                '| 失败', imgStats.failed, '| 已下', Math.round(imgStats.bytes / 1048576), 'MB');
            }
          }
        }
        await Promise.all(Array.from({ length: Math.min(IMG_CONC, tasks.length) }, worker));
        console.log('图片下载完成: 成功', imgStats.done, '| 失败', imgStats.failed,
          '| 共', Math.round(imgStats.bytes / 1048576), 'MB | 通道', channel);
      }

      // 交给 upload_images.js：只记录「真的下载成功」的文件
      const index = {};
      for (const t of tasks) {
        if (!fs.existsSync(t.file)) continue;
        const m = index[t.eaId] || (index[t.eaId] = { sig: taskMeta[t.eaId].sig, files: {} });
        m.files[t.type] = path.basename(t.file);
      }
      fs.writeFileSync(path.join(IMG_DIR, '_tasks.json'), JSON.stringify(index));
      console.log('待上传球员:', Object.keys(index).length, '人 →images_out/_tasks.json');
    }
  } else {
    console.log('图片下载已关闭（FC_IMG=0）');
  }

  const dump = {
    mode: mode,
    ver: Number(VER),
    generatedAt: new Date().toISOString(),
    list: listRes.items,
    details: detRes.details,
    sigs: sigs,
    newIds: newIds,
    changedIds: changedIds,
    removedIds: removedIds,
    meta: listRes.meta,
    pageSize: listRes.pageSize,
    totalPages: listRes.totalPages,
    count: listRes.count,
    detailFailed: detRes.failed,
    images: imgStats
  };
  fs.writeFileSync(OUT, JSON.stringify(dump));
  console.log('写入', OUT, '| 列表', dump.list.length, '| 详情', Object.keys(dump.details).length);
  await browser.close();
})().catch(e => { console.error('抓取失败:', e); process.exit(1); });
