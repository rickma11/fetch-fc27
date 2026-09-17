// 把成型后的数据写入云开发「数据库」（按版本分集合），供小程序云函数按需查询。
// 为什么不写云存储 JSON：10000+ 张卡的详情约 110MB，云函数整读会 OOM，
// 且小程序链路响应上限仅 1MB、云函数 6MB，整包返回必然失败。数据库按需查询才是正解。
//
// 两种模式：
//   full        —— 按 eaId 逐条「增量覆盖」全量（upsert，绝不删除任何文档，每周兜底 & 首次基线）
//   incremental —— 只 upsert「新增 / 变化」的文档 + 删除已下架的卡（每日默认）
//
// ⚠️ 关于「为什么不再清空再全插」：旧实现 full 模式是 clearDocs 清空集合 + 全量重插，
//   这在「抓取不完整」（取消 / Cloudflare 限流 / 网络抖动）时会清空云库里完好的数据、
//   再用残缺数据回填，造成不可逆丢失。改为 upsert（doc(eaId).set 整体覆盖）后：
//   - 新字段（如 sbcPoints）随覆盖自然落到全部文档，无需先清空；
//   - 缺失的球员（本次没抓到）保留在云库，只漏写、不会丢；
//   - 真正需要破坏性重建（改 schema / 清脏数据）时，显式设 FORCE_WIPE=1 才清空。
//
// 凭证来自环境变量（CI 由 GitHub Secrets 注入）：TCB_ENV_ID / TCB_SECRET_ID / TCB_SECRET_KEY
// 用法：node scripts/upload_db.js --ver 27 [--mode full|incremental|auto]
// 集合：
//   players_fc{ver}     列表字段（_id = eaId，供搜索/排序/分页）
//   details_fc{ver}     完整详情（_id = eaId，供主键直查）
//   meta_fc{ver}        筛选取值（单文档 _id = facets）
//   evolutions_fc{ver}  进化（_id = 进化 id，来源 evolutions.json；full/incremental 都会写）
const fs = require('fs');
const path = require('path');
const cloudbase = require('@cloudbase/node-sdk');
const { resolve } = require('./tcb_env');

// 凭证来源见 scripts/tcb_env.js（CI 走环境变量，本地可写 .env.local）
const cred = resolve();
if (cred.missing.length) {
  console.error('缺少云开发凭证：' + cred.missing.join(' / ') + '，无法写入数据库');
  console.error(cred.hint);
  process.exit(1);
}
const ENV_ID = cred.ENV_ID;
const SECRET_ID = cred.SECRET_ID;
const SECRET_KEY = cred.SECRET_KEY;
// timeout: SDK 默认只有 15s（tcbapirequester 的 defaultTimeout=15000）。
// GitHub runner 在国内端点跨境访问时单请求常超 3s，偶发尖峰必然击穿 15s →
// ESOCKETTIMEDOUT（2026-09-11 run #7 实际踩到）。这里放宽到 90s。
const app = cloudbase.init({ env: ENV_ID, secretId: SECRET_ID, secretKey: SECRET_KEY, timeout: 90000 });
const db = app.database();
const _ = db.command;

const argv = process.argv.slice(2);
let VER = '27';
let MODE = String(process.env.FC_MODE || 'auto').toLowerCase();
// 只写进化数据（不动球员/详情/facets）—— 用于端上开发期单独补数据，也避免本地整跑覆盖线上球员数据。
// 用法：node scripts/upload_db.js --ver 27 --evolutions-only
let EVO_ONLY = false;
for (let i = 0; i < argv.length; i++) {
  if ((argv[i] === '--ver' || argv[i] === '-v') && argv[i + 1]) VER = String(argv[++i]).replace(/[^0-9]/g, '') || '27';
  else if (argv[i].startsWith('--mode=')) MODE = argv[i].slice(7).toLowerCase();
  else if (argv[i] === '--evolutions-only') EVO_ONLY = true;
}

const ROOT = path.resolve(__dirname, '..');
const DIR = path.join(ROOT, 'cloud-data', `fc${VER}`);
// 批次与并发：本机实测（scripts/probe_bulk.js）到 TCB 端点约 700~1100 条/秒，
// 但 CI runner 跨境访问慢一到两个数量级，故批次不宜过大、改用适度并发叠加网络等待。
// 全量 10000 列表 + 10000 详情 ≈ 600 个请求，并发 6 下预计 5~10 分钟。
const PLAYER_BATCH = 50;    // 列表文档小（约 0.8KB），批次可大些
const DETAIL_BATCH = 25;    // 详情约 2KB，批次小些避免请求体过大、单请求超时
const INSERT_CONC = 6;      // 全量批量插入并发
const UPSERT_CONC = 8;      // 增量 upsert 并发
const FULL_CONC = 10;       // 逐条 upsert 并发（add() 不可用 / 批次兜底时用）
const FULL_UPSERT_CONC = 12; // 全量增量覆盖并发（doc(id).set 整体覆盖，按 eaId 幂等）

async function ensureCollection(name) {
  try {
    await db.createCollection(name);
    console.log('  已创建集合', name);
    return true;
  } catch (e) {
    const msg = String((e && e.message) || e);
    // 「已存在」是正常情况；其他错误（环境不存在 / 无权限）必须显式暴露 ——
    // 否则会被误读成「集合已存在」，把真实故障掩盖到后面几步（2026-09-11 实际踩过）。
    if (/exist|已存在|EXIST/i.test(msg)) {
      console.log('  集合已存在', name);
      return true;
    }
    console.warn('  ⚠ 建集合失败（后续写入很可能同样失败）:', msg);
    return false;
  }
}

// 清空集合内全部文档（保留集合本身与已建索引）；服务端单次最多删 1000 条，循环删净
async function clearDocs(name) {
  let total = 0;
  for (let i = 0; i < 300; i++) {
    let r;
    try {
      r = await db.collection(name).where({ _id: _.neq('') }).remove();
    } catch (e) {
      console.log('  清空异常（首次可能集合为空）:', e.message);
      break;
    }
    const n = (r && (r.deleted !== undefined ? r.deleted : (r.stats && r.stats.removed))) || 0;
    total += n;
    if (n === 0) break;
  }
  console.log('  清空', name, total, '条旧数据');
  return total;
}

// 探测 collection.add() 能否带显式 _id。服务端 SDK 各版本行为不一致，
// 不支持时全量模式退回逐条 doc(id).set()：慢一些，但保证主键 = eaId 且天然幂等。
async function addAcceptsExplicitId(name) {
  const probeId = '__probe_add_with_id__';
  try {
    await db.collection(name).add([{ _id: probeId, probe: 1 }]);
    try { await db.collection(name).doc(probeId).remove(); } catch (e) { /* 清理失败不影响主流程 */ }
    return true;
  } catch (e) {
    const msg = String((e && e.message) || e);
    if (/exist|已存在/i.test(msg)) return true;   // 上次探测残留 → 说明能带 _id 写入
    console.log('  · collection.add() 不接受显式 _id（' + msg.slice(0, 90) + '），改逐条 doc(id).set()');
    return false;
  }
}

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

async function insertAll(name, docs, batchSize, canAddWithId) {
  if (!canAddWithId) {
    const r = await runConc(docs, FULL_CONC, function (d) {
      return db.collection(name).doc(String(d._id)).set(bodyOf(d));
    }, name + ' 逐条写');
    console.log('  写入', name, r.done, '条' + (r.failed ? '（失败 ' + r.failed + '）' : ''));
    return r.done;
  }

  const batches = [];
  for (let i = 0; i < docs.length; i += batchSize) batches.push(docs.slice(i, i + batchSize));

  const t0 = Date.now();
  let ok = 0, failedDocs = 0, cursor = 0, doneBatches = 0;

  async function worker() {
    for (;;) {
      const idx = cursor++;
      if (idx >= batches.length) return;
      const slice = batches[idx];
      try {
        await db.collection(name).add(slice);   // 服务端 SDK：直接传数组，不套 data 层
        ok += slice.length;
      } catch (e) {
        const msg = String((e && e.message) || e);
        // 单次超时不代表整批失败：先等 2s 原样重试一次（add 不幂等，
        // 若上一批其实已落库，重试会撞 _id 重复 → 直接落到逐条 upsert 兜底）
        try {
          await sleep(2000);
          await db.collection(name).add(slice);
          ok += slice.length;
        } catch (e2) {
          console.warn('    ' + name + ' 批次 ' + idx + ' 两次失败（' + msg.slice(0, 70) + '）→ 逐条 upsert 兜底');
          const r = await runConc(slice, FULL_CONC, function (d) {
            return db.collection(name).doc(String(d._id)).set(bodyOf(d));   // 幂等，安全重试
          }, name + ' 兜底');
          ok += (r.done - r.failed);
          failedDocs += r.failed;
        }
      }
      doneBatches++;
      if (doneBatches % 20 === 0 || doneBatches === batches.length) {
        console.log(`  ${name}: ${ok}/${docs.length}（批次 ${doneBatches}/${batches.length}，${Math.round((Date.now() - t0) / 1000)}s）`);
      }
    }
  }

  await Promise.all(Array.from({ length: INSERT_CONC }, worker));
  console.log('  写入', name, ok, '条' + (failedDocs ? '（失败 ' + failedDocs + '）' : '') +
    `，耗时 ${Math.round((Date.now() - t0) / 1000)}s`);
  if (failedDocs) throw new Error(name + ' 有 ' + failedDocs + ' 条写入失败');
  return ok;
}

// 并发执行（用于增量 upsert）：逐条按 _id 覆盖写，天然幂等
async function runConc(items, conc, fn, label) {
  let cursor = 0, done = 0, failed = 0;
  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      let ok = false;
      for (let attempt = 0; attempt < 3 && !ok; attempt++) {
        try { await fn(items[i]); ok = true; }
        catch (e) { if (attempt === 2) { failed++; console.warn('    ' + label + ' 失败:', items[i]._id, e.message); } }
      }
      done++;
      if (done % 200 === 0 || done === items.length) console.log(`  ${label}: ${done}/${items.length}${failed ? '（失败 ' + failed + '）' : ''}`);
    }
  }
  await Promise.all(Array.from({ length: conc }, worker));
  return { done, failed };
}

// 去掉 _id 后再交给 doc(id).set()：doc(id) 已指定主键，
// data 里再带 _id 会被服务端拒绝并报「不能更新_id的值」（2026-09-11 实测）。
function bodyOf(doc) {
  const body = Object.assign({}, doc);
  delete body._id;
  return body;
}

async function upsertAll(name, docs, conc, label) {
  if (!docs.length) { console.log('  ' + label + ': 无变化，跳过'); return; }
  await runConc(docs, conc, function (d) {
    return db.collection(name).doc(String(d._id)).set(bodyOf(d));
  }, label);
}

// 删除已下架的卡（分批 in 查询）
async function removeByIds(name, ids) {
  if (!ids || !ids.length) { console.log('  无下架数据'); return 0; }
  let removed = 0;
  for (let i = 0; i < ids.length; i += 100) {
    const slice = ids.slice(i, i + 100).map(String);
    try {
      const r = await db.collection(name).where({ _id: _.in(slice) }).remove();
      removed += (r && (r.deleted !== undefined ? r.deleted : (r.stats && r.stats.removed))) || 0;
    } catch (e) { console.warn('  删除异常:', e.message); }
  }
  console.log('  删除', name, removed, '条下架数据');
  return removed;
}

async function writeFacets(facets, mCol) {
  await ensureCollection(mCol);
  // set() 本身就是「不存在则创建」，无需再清空；_id 由 doc('facets') 指定，不能放进 body
  await db.collection(mCol).doc('facets').set(bodyOf(facets));
  console.log('  facets 写入完成（联赛', (facets.leagues || []).length, '俱乐部', (facets.clubs || []).length, '）');
}

// ---------------------------------------------------------------- 进化（Evolutions）
// 来源：cloud-data/fc{ver}/evolutions.json（scrape_sbc_evolutions.js 从 r2.fut.gg 抓的静态 CDN）
// 形状：{ ver, manifestKeys, activeHash, allHash, active[], all[], fetchedAt }
//   - all[]  全量（含已结束的历史）；active[] 当前进行中 → 端上用 active 判定「进行中」
//   - 单条记录自带 id（如 2488），故 _id = String(id)，端上按主键直查
// ⚠️ 与球员一样「只 upsert 不删除」；但进化有「已下架」语义（fut.gg 移除该进化），
//    故对「云库有、本次数据没有」的文档只打标记 isStale=true + isActive=false，绝不 remove。
// 注意：dataset 可能为空（hash = 空串 MD5 d7517139）→ 此时不写库、也不打 stale，
//      避免「抓取失败写出空数据集」把云库整批标脏。判据＝本次 all 长度为 0 直接跳过。
async function uploadEvolutions(ver, dir) {
  const f = path.join(dir, 'evolutions.json');
  const col = `evolutions_fc${ver}`;
  if (!fs.existsSync(f)) { console.log('未找到 evolutions.json，跳过进化数据'); return; }
  let j;
  try { j = JSON.parse(fs.readFileSync(f, 'utf8')); }
  catch (e) { console.warn('  ⚠ evolutions.json 解析失败，跳过:', e.message); return; }

  const all = Array.isArray(j.all) ? j.all : [];
  if (!all.length) {
    console.log('  evolutions.json 为空数据集（activeHash=' + (j.activeHash || '-') + '），跳过进化写入');
    return;
  }
  const activeIds = new Set((Array.isArray(j.active) ? j.active : []).map(function (e) { return String(e && e.id); }));
  const fetchedAt = j.fetchedAt || null;
  const docs = all.map(function (e) {
    return Object.assign({}, e, {
      _id: String(e.id),
      isActive: activeIds.has(String(e.id)),
      isStale: false,
      _fetchedAt: fetchedAt,
    });
  });

  console.log('== 写入', col, '==');
  await ensureCollection(col);
  await upsertAll(col, docs, UPSERT_CONC, 'evolutions');

  // 本次数据里没有的进化 → 标记为已下架（非破坏性；端上按 isStale 过滤）
  try {
    const existing = [];
    for (let skip = 0; ; skip += 1000) {
      const r = await db.collection(col).field({ _id: true }).skip(skip).limit(1000).get();
      if (!r || !r.data || !r.data.length) break;
      for (const d of r.data) existing.push(String(d._id));
      if (r.data.length < 1000) break;
    }
    const stale = existing.filter(function (id) { return !docs.some(function (d) { return d._id === id; }); });
    if (stale.length) {
      console.log('  标记', stale.length, '条已下架进化（isStale=true，不删除）');
      await runConc(stale, UPSERT_CONC, function (id) {
        return db.collection(col).doc(String(id)).update({ isStale: true, isActive: false });
      }, 'evolutions 下架标记');
    }
  } catch (e) {
    // 标记失败不影响主流程（端上仍有 isActive 判定），但要显式暴露
    console.warn('  ⚠ 下架标记步骤失败（不影响已写入数据）:', e.message);
  }
}

(async () => {
  const pCol = `players_fc${VER}`;
  const dCol = `details_fc${VER}`;
  const mCol = `meta_fc${VER}`;
  const incFile = path.join(DIR, 'incremental.json');
  const fFile = path.join(DIR, 'facets.json');

  if (MODE === 'auto') MODE = fs.existsSync(incFile) ? 'incremental' : 'full';
  console.log(`落库模式: ${MODE} | 版本 FC${VER}${EVO_ONLY ? ' | 仅进化（--evolutions-only）' : ''}`);

  if (EVO_ONLY) {
    console.log('--evolutions-only：跳过球员 / 详情 / facets，只写进化集合');
  } else if (MODE === 'incremental') {
    if (!fs.existsSync(incFile)) {
      console.error('缺少增量包，请先跑 fetch_futgg.js 生成：', incFile);
      process.exit(1);
    }
    const inc = JSON.parse(fs.readFileSync(incFile, 'utf8'));
    const players = (inc.players || []).map(function (p) { return Object.assign({}, p, { _id: String(p.eaId) }); });
    const details = Object.keys(inc.details || {}).map(function (k) { return Object.assign({}, inc.details[k], { _id: String(k) }); });
    console.log(`增量包：需写库 ${players.length} 条，详情 ${details.length} 条，下架 ${(inc.removedIds || []).length} 条，列表总数 ${inc.total}`);

    console.log('== 增量写入', pCol, '==');
    await ensureCollection(pCol);
    await upsertAll(pCol, players, UPSERT_CONC, 'players');

    console.log('== 增量写入', dCol, '==');
    await ensureCollection(dCol);
    await upsertAll(dCol, details, UPSERT_CONC, 'details');

    console.log('== 删除下架 ==');
    await removeByIds(pCol, inc.removedIds);
    await removeByIds(dCol, inc.removedIds);

    if (inc.facets) {
      console.log('== 更新', mCol, '==');
      await writeFacets(inc.facets, mCol);
    }
  } else {
    const pFile = path.join(DIR, 'players.json');
    const dFile = path.join(DIR, 'details.json');
    if (!fs.existsSync(pFile) || !fs.existsSync(dFile)) {
      console.error('缺少全量成型文件，请先跑 fetch_futgg.js（full 模式）：', pFile, dFile);
      process.exit(1);
    }
    const players = JSON.parse(fs.readFileSync(pFile, 'utf8'));
    const detailsObj = JSON.parse(fs.readFileSync(dFile, 'utf8'));
    const details = Object.keys(detailsObj).map(function (k) { return detailsObj[k]; });
    console.log(`FC${VER}：列表 ${players.length} 条，详情 ${details.length} 条`);

    // _id 固定为 eaId：详情可按主键直查，且避免每日重复累积
    const pDocs = players.map(function (p) { return Object.assign({}, p, { _id: String(p.eaId) }); });
    const dDocs = details.map(function (d) { return Object.assign({}, d, { _id: String(d.eaId) }); });

    // 全量「增量覆盖（不删除）」：按 eaId 逐条 set 覆盖，缺失的球员保留、新字段自然带入。
    // 仅在显式 FORCE_WIPE=1 时才走破坏性「清空+全插」（改 schema / 清脏数据等场景）。
    const FORCE_WIPE = process.env.FORCE_WIPE === '1';
    if (FORCE_WIPE) {
      console.log('⚠️ FORCE_WIPE=1：先清空再全量插入（破坏性，仅在改 schema / 清脏数据时使用）');
      await ensureCollection(pCol);
      await clearDocs(pCol);
      const canAddWithId = await addAcceptsExplicitId(pCol);
      await insertAll(pCol, pDocs, PLAYER_BATCH, canAddWithId);
      await ensureCollection(dCol);
      await clearDocs(dCol);
      await insertAll(dCol, dDocs, DETAIL_BATCH, canAddWithId);
    } else {
      console.log('== 全量增量覆盖（不删除）', pCol, '==');
      await ensureCollection(pCol);
      await upsertAll(pCol, pDocs, FULL_UPSERT_CONC, 'players');

      console.log('== 全量增量覆盖（不删除）', dCol, '==');
      await ensureCollection(dCol);
      await upsertAll(dCol, dDocs, FULL_UPSERT_CONC, 'details');
    }

    // 筛选取值（联赛/俱乐部/稀有度…），单文档，供前端筛选面板使用
    if (fs.existsSync(fFile)) {
      console.log('== 写入', mCol, '==');
      await writeFacets(JSON.parse(fs.readFileSync(fFile, 'utf8')), mCol);
    } else {
      console.log('未找到 facets.json，跳过（可重跑 fetch_futgg.js 生成）');
    }
  }

  // 进化数据：与 mode 无关（scrape 步骤每天都会刷新 evolutions.json），两种模式都写。
  // 放在最后 —— 它失败不该影响球员主数据的落库结果。
  try { await uploadEvolutions(VER, DIR); }
  catch (e) { console.warn('⚠ 进化数据写入失败（不影响球员数据）:', e.message); }

  console.log('数据库写入完成');
})().catch(function (e) { console.error('写入失败:', e); process.exit(1); });
