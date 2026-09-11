// 把成型后的数据写入云开发「数据库」（按版本分集合），供小程序云函数按需查询。
// 为什么不写云存储 JSON：10000+ 张卡的详情约 110MB，云函数整读会 OOM，
// 且小程序链路响应上限仅 1MB、云函数 6MB，整包返回必然失败。数据库按需查询才是正解。
//
// 两种模式：
//   full        —— 建集合 → 清空 → 分批插入全量（每周兜底 & 首次基线）
//   incremental —— 只 upsert「新增 / 变化」的文档 + 删除已下架的卡（每日默认）
//
// 凭证来自环境变量（CI 由 GitHub Secrets 注入）：TCB_ENV_ID / TCB_SECRET_ID / TCB_SECRET_KEY
// 用法：node scripts/upload_db.js --ver 27 [--mode full|incremental|auto]
// 集合：
//   players_fc{ver}  列表字段（_id = eaId，供搜索/排序/分页）
//   details_fc{ver}  完整详情（_id = eaId，供主键直查）
//   meta_fc{ver}     筛选取值（单文档 _id = facets）
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
const app = cloudbase.init({ env: ENV_ID, secretId: SECRET_ID, secretKey: SECRET_KEY });
const db = app.database();
const _ = db.command;

const argv = process.argv.slice(2);
let VER = '27';
let MODE = String(process.env.FC_MODE || 'auto').toLowerCase();
for (let i = 0; i < argv.length; i++) {
  if ((argv[i] === '--ver' || argv[i] === '-v') && argv[i + 1]) VER = String(argv[++i]).replace(/[^0-9]/g, '') || '27';
  else if (argv[i].startsWith('--mode=')) MODE = argv[i].slice(7).toLowerCase();
}

const ROOT = path.resolve(__dirname, '..');
const DIR = path.join(ROOT, 'cloud-data', `fc${VER}`);
const PLAYER_BATCH = 100;   // 列表文档小，批量大些
const DETAIL_BATCH = 20;    // 详情节约 2KB（成型后），批次小些避免请求体过大
const UPSERT_CONC = 8;      // 增量 upsert 并发
const FULL_CONC = 10;       // 全量逐条 upsert 并发（add() 不可用时的兜底路径）

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

async function insertAll(name, docs, batchSize, canAddWithId) {
  if (!canAddWithId) {
    const r = await runConc(docs, FULL_CONC, function (d) {
      return db.collection(name).doc(String(d._id)).set(bodyOf(d));
    }, name + ' 逐条写');
    console.log('  写入', name, r.done, '条' + (r.failed ? '（失败 ' + r.failed + '）' : ''));
    return r.done;
  }
  let ok = 0;
  for (let i = 0; i < docs.length; i += batchSize) {
    const slice = docs.slice(i, i + batchSize);
    await db.collection(name).add(slice);   // 服务端 SDK：直接传数组，不套 data 层
    ok += slice.length;
    if (i % (batchSize * 10) === 0 || i + batchSize >= docs.length) {
      console.log(`  ${name}: ${Math.min(ok, docs.length)}/${docs.length}`);
    }
  }
  console.log('  写入', name, ok, '条');
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

(async () => {
  const pCol = `players_fc${VER}`;
  const dCol = `details_fc${VER}`;
  const mCol = `meta_fc${VER}`;
  const incFile = path.join(DIR, 'incremental.json');
  const fFile = path.join(DIR, 'facets.json');

  if (MODE === 'auto') MODE = fs.existsSync(incFile) ? 'incremental' : 'full';
  console.log(`落库模式: ${MODE} | 版本 FC${VER}`);

  if (MODE === 'incremental') {
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

    console.log('== 全量重建', pCol, '==');
    await ensureCollection(pCol);
    await clearDocs(pCol);
    const canAddWithId = await addAcceptsExplicitId(pCol);
    await insertAll(pCol, pDocs, PLAYER_BATCH, canAddWithId);

    console.log('== 全量重建', dCol, '==');
    await ensureCollection(dCol);
    await clearDocs(dCol);
    await insertAll(dCol, dDocs, DETAIL_BATCH, canAddWithId);

    // 筛选取值（联赛/俱乐部/稀有度…），单文档，供前端筛选面板使用
    if (fs.existsSync(fFile)) {
      console.log('== 写入', mCol, '==');
      await writeFacets(JSON.parse(fs.readFileSync(fFile, 'utf8')), mCol);
    } else {
      console.log('未找到 facets.json，跳过（可重跑 fetch_futgg.js 生成）');
    }
  }

  console.log('数据库写入完成');
})().catch(function (e) { console.error('写入失败:', e); process.exit(1); });
