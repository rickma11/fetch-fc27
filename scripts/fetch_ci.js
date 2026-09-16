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
// 分桶翻页的下限 OVR（上限固定 99）。默认 1 覆盖任何铜卡长尾；如确认最低 OVR 较高可调大以省请求。
const OVR_MIN = Number(process.env.FC_OVR_MIN || 1);

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

  // ---------- 阶段 1：抓全量列表（按 overall 分桶翻页，绕过 max_result_window=10000）----------
  //   普通 ?page=N 翻页到第 ~334 页（10000/30）起越窗被截断，低 OVR 卡（如 81426=57 OVR）漏抓。
  //   改法：按 overall 单值分桶（overall__gte=X&overall__lte=X，参数名见 utweb/参考/futgg/filter_taxonomy.md），
  //   每桶命中数远小于 10000，桶内翻页不触窗口；OVR 99→OVR_MIN 全桶并集即完整名单。
  const listRes = await page.evaluate(async ({ BASE, LIST_CONC, OVR_MIN }) => {
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

    // 按 overall 分桶翻页，绕过 max_result_window=10000 的全局窗口（详见脚本头部说明）。
    // OVR 上限固定 99（FC 最高总评），下限取传入的 OVR_MIN（默认 1，覆盖任何铜卡长尾）。
    // 每个 OVR 桶命中数远小于 10000，桶内翻页不会越窗；全部桶并集即完整名单（含低 OVR 的 81426 等）。
    const OVR_MAX = 99;

    const items = [], seen = new Set();
    const push = arr => { for (const it of arr) if (it && !seen.has(it.eaId)) { seen.add(it.eaId); items.push(it); } };
    push(first);  // 第 1 页（无过滤）的卡也并入，下方分桶会去重

    // 单桶翻页：overall__gte/lte 同值，逐页抓到空页 / 404 或连续失败为止
    async function fetchBucket(ovr) {
      for (let pg = 1; pg <= 2000; pg++) {
        let ok = false;
        for (let attempt = 0; attempt < 3 && !ok; attempt++) {
          try {
            const r = await fetch(`${BASE}?overall__gte=${ovr}&overall__lte=${ovr}&page=${pg}`, { headers: { Accept: 'application/json' } });
            if (r.ok) {
              const j = await r.json();
              if (Array.isArray(j.data) && j.data.length) { push(j.data); ok = true; }
              else return;                       // 空页 = 桶末页
            } else if (r.status === 404) { return; }
            else { await sleep(400 * (attempt + 1)); }
          } catch (e) { await sleep(400 * (attempt + 1)); }
        }
        if (!ok) return;                         // 连续失败放弃该桶剩余页
        if (pg % 50 === 0) console.log(`  OVR ${ovr} 进度 page ${pg} 累计 ${seen.size}`);
        await sleep(60);
      }
    }

    // 并发桶：多个 worker 同时翻不同 OVR 桶（桶间互不依赖，仅共享 seen 去重）
    let ovrCursor = OVR_MAX;
    async function w() {
      while (true) {
        const o = ovrCursor--;
        if (o < OVR_MIN) return;
        await fetchBucket(o);
      }
    }
    const bucketCount = OVR_MAX - OVR_MIN + 1;
    await Promise.all(Array.from({ length: Math.min(LIST_CONC, bucketCount) }, w));
    console.log('分桶翻页完成: OVR ' + OVR_MAX + '→' + OVR_MIN + ' 共 ' + bucketCount + ' 桶');
    console.log('列表抓取完成，去重后', items.length, '人');

    // 「卡片来源」字段自检：确认列表接口真的回传了 isSbc / isObjective / isSeasonPass。
    // fut.gg 前端筛选支持这三个参数，但 item 上是否回传需实证 —— 全为 0 说明标记没被回传，
    // 「卡片来源」筛选会把所有卡静默归入「卡池」，那时需改用 ?is_sbc=1 等筛选参数分别抓取打标。
    const srcProbe = { isSbc: 0, isObjective: 0, isSeasonPass: 0, isSpecial: 0, sampled: items.length };
    for (const it of items) {
      if (typeof it.isSbc === 'boolean') srcProbe.isSbc++;
      if (typeof it.isObjective === 'boolean') srcProbe.isObjective++;
      if (typeof it.isSeasonPass === 'boolean') srcProbe.isSeasonPass++;
      if (typeof it.isSpecial === 'boolean') srcProbe.isSpecial++;
    }
    console.log('卡片来源字段自检:', JSON.stringify(srcProbe));
    if (srcProbe.isSbc === 0 && srcProbe.isObjective === 0) {
      console.log('⚠️ 列表接口未回传来源标记（isSbc/isObjective 全缺失）→ 卡片来源筛选将全部落「卡池」');
    }

    return { items, meta, pageSize, totalPages: null, count: items.length };
  }, { BASE, LIST_CONC, OVR_MIN });

  // ---------- FC_IMG_ONLY：只下图片、不抓详情/不落库（images-only 模式）----------
  // 图片下载只需要列表里的 imagePath（阶段 1 已拿到），不依赖详情（阶段 3）。
  // 因此 images-only 在阶段 1 抓列表后直接跑图片并退出，省掉最慢的详情抓取与数据落库。
  if (String(process.env.FC_IMG_ONLY || '') === '1') {
    if (String(process.env.FC_IMG || '1') !== '0') {
      console.log('[images-only] 仅下载球员图片（跳过详情抓取与数据落库）');
      const imgOnlyStats = await runImageStage();
      console.log('[images-only] 图片下载完成，_tasks.json 已写出，结束（不落库）| 成功', imgOnlyStats.done, '失败', imgOnlyStats.failed);
    } else {
      console.log('[images-only] FC_IMG=0，无图片可下，直接结束');
    }
    await browser.close();
    process.exit(0);
  }

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
  // 抽成 runImageStage()：images-only 模式（FC_IMG_ONLY=1）在阶段 1 抓列表后直接调用并退出，
  //           正常 / data-only 模式在此原位调用。函数体内只看列表的 imagePath，不依赖详情。
  async function runImageStage() {
  const imgStats = { planned: 0, done: 0, failed: 0, skipped: 0, bytes: 0, channel: '' };
  if (String(process.env.FC_IMG || '1') !== '0') {
    const manifest = imgLib.readManifest(VER);
    const types = imgLib.activeTypes();
    // 无头像 / 已在 noportrait 清单的球员 → 图片任务置顶，避免被 FC_IMG_MAX 上限 + 总评降序排序饿死：
    // 否则低总评无头像球员出 _np.webp 会滞后数天（gen_noportrait_cards 必须先从云存储取 _card.webp 建底板），
    // 且他们后来补的真实头像也会因同一上限 + 排序而滞后下载。
    const npManifestPath = path.join(path.resolve(__dirname, '..'), 'cloud-data', `fc${VER}`, 'noportrait.json');
    let npManifest = new Set();
    try {
      const nj = JSON.parse(fs.readFileSync(npManifestPath, 'utf8'));
      npManifest = new Set(Object.keys(nj).map(String));
    } catch (e) { /* 清单缺失不致命，仅失去置顶能力 */ }
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
          ovr: Number(it.overall) || 0,
          // 置顶标记：当前无头像（!imagePath && cardImagePath）或已在 noportrait 清单内（可能刚补头像）的球员
          pri: ((!it.imagePath && it.cardImagePath) || npManifest.has(String(it.eaId))) ? 1 : 0,
          // 置顶组内顺序：card 先于 portrait（_np 建底板只需 card；补头像时两者都抓）
          typePri: t.key === 'card' ? 0 : (t.key === 'portrait' ? 1 : 2)
        });
      }
      if (Object.keys(files).length) taskMeta[eaId] = { sig, files };
    }
    // 置顶组优先（pri 降序），组内高总评在前、card 先于 portrait；非置顶组再按总评降序
    tasks.sort((a, b) => (b.pri - a.pri) || (b.ovr - a.ovr) || (a.typePri - b.typePri) || (Number(a.eaId) - Number(b.eaId)));
    const priCount = tasks.filter(t => t.pri).length;
    if (IMG_MAX > 0 && tasks.length > IMG_MAX) {
      console.log(`图片任务 ${tasks.length} 张（其中无头像/清单置顶 ${priCount} 张全部保留），本次上限 ${IMG_MAX} 张（余下下次继续）`);
      tasks.length = IMG_MAX;
    } else if (priCount) {
      console.log(`图片任务 ${tasks.length} 张，无头像/清单置顶 ${priCount} 张`);
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
  return imgStats;
  }
  const imgStats = await runImageStage();

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
