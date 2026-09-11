// 云开发「数据库写权限」自检脚本。
//
// 为什么需要它：写入云数据库需要 CAM 子用户具备 tcb:InsertDocument / tcb:DeleteDocument
// 等操作权限；只给 COS 读写策略时，云存储能传、数据库会报
//   SIGN_PARAM_INVALID: you are not authorized to perform operation (tcb:InsertDocument)
// 而完整 CI 一轮要 6 分钟，用它可以在本地 3 秒内确认权限到底修好没有。
//
// 用法（PowerShell，在仓库根目录 E:\workbuddy\fetch-fc27 下执行）：
//   node scripts/check_db_perm.js
// 凭证来源见 scripts/tcb_env.js：优先环境变量，其次根目录 .env.local / .tcb.local.json。
//
// 成功输出「✔ 数据库读写权限正常」即可重新触发 CI。
const cloudbase = require('@cloudbase/node-sdk');
const { resolve } = require('./tcb_env');

const cred = resolve();
if (cred.missing.length) {
  console.error(cred.hint);
  process.exit(1);
}
const ENV_ID = cred.ENV_ID;
const SECRET_ID = cred.SECRET_ID;
const SECRET_KEY = cred.SECRET_KEY;

const app = cloudbase.init({ env: ENV_ID, secretId: SECRET_ID, secretKey: SECRET_KEY });
const db = app.database();
const COL = 'perm_probe_fc27';
const PROBE_ID = 'perm_probe';
let step = 'init';

(async () => {
  console.log('环境:', ENV_ID, '（凭证来源:', cred.source + '）');

  step = 'createCollection';
  try { await db.createCollection(COL); console.log('  ✔ 建集合（首次）'); }
  catch (e) { console.log('  · 集合已存在，跳过'); }

  step = 'InsertDocument';
  // 注意：doc(id) 已指定主键，data 里绝不能再带 _id，否则报「不能更新_id的值」
  await db.collection(COL).doc(PROBE_ID).set({ t: Date.now() });
  console.log('  ✔ tcb:InsertDocument 通过（doc().set() 覆盖写 —— 增量模式用）');

  step = 'AddDocument';
  await db.collection(COL).add([{ _id: PROBE_ID + '_add', t: Date.now() }]);
  console.log('  ✔ collection.add() 带显式 _id 通过（全量模式用）');

  step = 'QueryDocument';
  const r = await db.collection(COL).doc(PROBE_ID).get();
  if (!r || !r.data || !r.data.length) throw new Error('写入后查询不到，数据未落库');
  console.log('  ✔ tcb:QueryDocument 通过');

  step = 'UpdateDocument';
  await db.collection(COL).doc(PROBE_ID).update({ t: Date.now() });
  console.log('  ✔ tcb:UpdateDocument 通过');

  step = 'DeleteDocument';
  await db.collection(COL).doc(PROBE_ID).remove();
  await db.collection(COL).doc(PROBE_ID + '_add').remove();
  console.log('  ✔ tcb:DeleteDocument 通过');

  step = 'BatchRemove';
  const br = await db.collection(COL).where({ _id: db.command.neq('') }).remove();
  console.log('  ✔ 条件批量删除通过（全量模式清空用）:', JSON.stringify(br));

  console.log('\n✔ 数据库读写权限正常，可以重新触发 CI（mode=full 建基线）');
})().catch(function (e) {
  const msg = String((e && e.message) || e);
  console.error('\n✘ 权限自检失败于', step, '：', msg);
  if (msg.indexOf('SIGN_PARAM_INVALID') >= 0 || msg.indexOf('not authorized') >= 0) {
    console.error('\n原因：该 CAM 子用户没有云开发数据库操作权限。');
    console.error('解决：腾讯云控制台 → 访问管理 → 策略 → 新建自定义策略（按策略语法）→ 粘贴：');
    console.error(JSON.stringify({
      version: '2.0',
      statement: [{ effect: 'allow', action: ['tcb:*'], resource: [
        `qcs::tcb:::env/${ENV_ID}`,
        `qcs::tcb:ap-shanghai::env/${ENV_ID}`
      ] }]
    }, null, 2));
    console.error('然后把该策略关联到对应子用户，重跑本脚本（永久密钥改策略即时生效，一般无需重发密钥）。');
  }
  process.exit(1);
});
