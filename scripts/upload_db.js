// 把成型后的数据写入云开发「数据库」（按版本分集合），供小程序云函数按需查询。
// 为什么不写云存储 JSON：10000+ 张卡的详情约 110MB，云函数整读会 OOM，
// 且小程序链路响应上限仅 1MB、云函数 6MB，整包返回必然失败。数据库按需查询才是正解。
// 凭证来自环境变量（CI 由 GitHub Secrets 注入）：TCB_ENV_ID / TCB_SECRET_ID / TCB_SECRET_KEY
// 用法：node scripts/upload_db.js --ver 27
// 集合：
//   players_fc{ver}  列表字段（_id = eaId，供搜索/排序/分页）
//   details_fc{ver}  完整详情（_id = eaId，供主键直查）
const fs = require('fs');
const path = require('path');
const cloudbase = require('@cloudbase/node-sdk');

const ENV_ID = process.env.TCB_ENV_ID;
const SECRET_ID = process.env.TCB_SECRET_ID;
const SECRET_KEY = process.env.TCB_SECRET_KEY;
if (!ENV_ID || !SECRET_ID || !SECRET_KEY) {
  console.error('缺少环境变量 TCB_ENV_ID / TCB_SECRET_ID / TCB_SECRET_KEY，无法写入数据库');
  process.exit(1);
}
const app = cloudbase.init({ env: ENV_ID, secretId: SECRET_ID, secretKey: SECRET_KEY });
const db = app.database();

const argv = process.argv.slice(2);
let VER = '27';
for (let i = 0; i < argv.length; i++) {
  if ((argv[i] === '--ver' || argv[i] === '-v') && argv[i + 1]) VER = String(argv[++i]).replace(/[^0-9]/g, '') || '27';
}

const ROOT = path.resolve(__dirname, '..');
const PLAYER_BATCH = 100;   // 列表文档小，批量大些
const DETAIL_BATCH = 20;    // 详情节 ~11KB，批次小些避免请求体过大

async function ensureCollection(name) {
  try { await db.createCollection(name); console.log('  已创建集合', name); }
  catch (e) { console.log('  集合已存在', name); }
}

// 清空集合内全部文档（保留集合本身与已建索引）；服务端单次最多删 1000 条，循环删净
async function clearDocs(name) {
  let total = 0;
  for (let i = 0; i < 300; i++) {
    let r;
    try {
      r = await db.collection(name).where({ _id: db.command.neq('') }).remove();
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

async function insertAll(name, docs, batchSize) {
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

(async () => {
  const pFile = path.join(ROOT, 'cloud-data', `fc${VER}`, 'players.json');
  const dFile = path.join(ROOT, 'cloud-data', `fc${VER}`, 'details.json');
  if (!fs.existsSync(pFile) || !fs.existsSync(dFile)) {
    console.error('缺少成型文件，请先跑 fetch_futgg.js：', pFile, dFile);
    process.exit(1);
  }
  const players = JSON.parse(fs.readFileSync(pFile, 'utf8'));
  const detailsObj = JSON.parse(fs.readFileSync(dFile, 'utf8'));
  const details = Object.keys(detailsObj).map(function (k) { return detailsObj[k]; });
  console.log(`FC${VER}：列表 ${players.length} 条，详情 ${details.length} 条`);

  // _id 固定为 eaId：详情可按主键直查，且避免每日重复累积
  const pDocs = players.map(function (p) { return Object.assign({}, p, { _id: String(p.eaId) }); });
  const dDocs = details.map(function (d) { return Object.assign({}, d, { _id: String(d.eaId) }); });

  const pCol = `players_fc${VER}`;
  const dCol = `details_fc${VER}`;

  console.log('== 写入', pCol, '==');
  await ensureCollection(pCol);
  await clearDocs(pCol);
  await insertAll(pCol, pDocs, PLAYER_BATCH);

  console.log('== 写入', dCol, '==');
  await ensureCollection(dCol);
  await clearDocs(dCol);
  await insertAll(dCol, dDocs, DETAIL_BATCH);

  console.log('数据库写入完成');
})().catch(function (e) { console.error('写入失败:', e); process.exit(1); });
