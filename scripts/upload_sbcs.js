'use strict';
// SBC 数据上云：把烘焙好中文（*Zh 字段）的 cloud-data/fc{ver}/sbcs.json#sets
// 全量 upsert 到云数据库集合 sbcs_fc{ver}（主键 _id = String(set.id)）。
//
// ⚠️ 口径对齐 upload_db.js：只 upsert（doc(id).set 整体覆盖）、绝不 clear+reinsert；
//    重复执行幂等安全。SBC 数据量小（当前 10 条 / 约 44KB），无瘦身必要，
//    challenges[] 随整条入库（云函数 get_sbcs list 直接全量返回）。
//
// 用法：node scripts/upload_sbcs.js --ver 27
const fs = require('fs');
const path = require('path');
const { resolve } = require('./tcb_env');

function argVer() {
  const a = process.argv.find(x => x.startsWith('--ver='));
  if (a) return Number(a.slice(6));
  const i = process.argv.indexOf('--ver');
  return i >= 0 ? Number(process.argv[i + 1]) : 27;
}

const VER = argVer() || 27;
const SRC = path.resolve(__dirname, '..', 'cloud-data', 'fc' + VER, 'sbcs.json');

const d = JSON.parse(fs.readFileSync(SRC, 'utf8'));
const sets = d.sets || [];
if (!sets.length) { console.error('sbcs.json 无 sets，终止'); process.exit(1); }

const fetchedAt = d.fetchedAt || new Date().toISOString();
const docs = sets.map(s => Object.assign({}, s, { _id: String(s.id), _fetchedAt: fetchedAt }));

(async () => {
  const cred = resolve();
  if (cred.missing.length) {
    console.error('缺少云开发凭证，无法上传：\n' + cred.hint);
    process.exit(1);
  }
  const cloudbase = require('@cloudbase/node-sdk');
  const app = cloudbase.init({ env: cred.ENV_ID, secretId: cred.SECRET_ID, secretKey: cred.SECRET_KEY, timeout: 120000 });
  const db = app.database();
  const col = 'sbcs_fc' + VER;

  // 集合不存在则自动创建（已存在时报错忽略）
  try { await db.createCollection(col); console.log('已创建集合', col); }
  catch (e) { console.log('集合', col, '已存在（或创建失败忽略）:', (e && e.message || '').slice(0, 80)); }

  let ok = 0, fail = 0;
  for (const doc of docs) {
    const body = Object.assign({}, doc);
    const id = body._id;
    delete body._id; // doc(id) 已指定主键，body 不能再带 _id
    let done = false, lastErr = null;
    for (let k = 1; k <= 3 && !done; k++) {
      try { await db.collection(col).doc(id).set(body); done = true; }
      catch (e) { lastErr = e; await new Promise(r => setTimeout(r, 1000 * k)); }
    }
    if (done) { ok++; console.log('  UP', col, id, doc.nameZh || doc.name); }
    else { fail++; console.error('  FAIL', col, id, (lastErr && lastErr.message) || lastErr); }
  }
  console.log('SBC 上云完成: ' + col + ' 成功 ' + ok + ' | 失败 ' + fail + ' | fetchedAt=' + fetchedAt);
  process.exit(fail ? 1 : 0);
})();
