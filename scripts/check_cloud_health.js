// 云端「体检」脚本：小程序报错时先用它分清「是云出问题还是客户端出问题」。
//
// 为什么需要它：小程序端出现「搜索为空 / 热门丢失 / Failed to fetch」时，肉眼无法区分
//   ① 云数据库或云函数坏了；② 只是客户端连不上云（网络/代理/登录态）。
// 本脚本用服务端密钥直连，绕过小程序链路，逐项打印真实状态 —— 只要这里全绿，
// 问题就在客户端（开发者工具的网络/代理/登录态），不要再去动数据库。
//
// 用法：node scripts/check_cloud_health.js [--ver 27]
// 凭证来源见 scripts/tcb_env.js（.env.local / 环境变量）。
const tcb = require('@cloudbase/node-sdk');
const { resolve } = require('./tcb_env.js');

const argv = process.argv.slice(2);
let VER = '27';
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--ver') VER = argv[i + 1];
  else if (argv[i].startsWith('--ver=')) VER = argv[i].slice(6);
}

const cred = resolve();
if (cred.missing && cred.missing.length) {
  console.error('凭证缺失：' + cred.missing.join(', '));
  console.error(cred.hint || '');
  process.exit(1);
}

const app = tcb.init({ env: cred.ENV_ID, secretId: cred.SECRET_ID, secretKey: cred.SECRET_KEY });
const db = app.database();
const P_COL = 'players_fc' + VER;
const D_COL = 'details_fc' + VER;
const M_COL = 'meta_fc' + VER;

let problems = 0;
function bad(msg) { problems++; console.log('  ❌ ' + msg); }

(async () => {
  console.log('环境 envId = ' + cred.ENV_ID + '   版本 = FC' + VER + '\n');

  // ---- 1. 数据库集合 ----
  console.log('[1/5] 集合与数据量');
  for (const c of [P_COL, D_COL, M_COL]) {
    try {
      const r = await db.collection(c).count();
      console.log('  ' + c.padEnd(14) + ' count = ' + r.total);
      if ((c === P_COL || c === D_COL) && r.total === 0) bad(c + ' 是空的（数据未入库）');
    } catch (e) {
      bad(c + ' 读取失败：' + (e.code || '') + ' ' + e.message.slice(0, 120));
    }
  }

  // ---- 2. meta 文档（facets / roster）----
  console.log('\n[2/5] meta 文档（' + M_COL + '）');
  let facetsDoc = null;
  try {
    const r = await db.collection(M_COL).doc('facets').get();
    facetsDoc = r.data || null;
    console.log('  facets : ' + (facetsDoc ? '存在，total=' + facetsDoc.total : '不存在'));
    if (!facetsDoc) bad('facets 缺失 → 筛选面板会没有取值');
  } catch (e) { bad('facets 读取失败：' + (e.code || '')); }

  try {
    const r = await db.collection(M_COL).doc('roster').get();
    const d = r.data;
    const ok = d && d.fileID;
    console.log('  roster : ' + (ok ? ('存在，count=' + d.count + ' schemaVersion=' + d.schemaVersion) : '不存在'));
    if (!ok) {
      console.log('     ⚠️ 影响：小程序「方案A」本地 roster 失效（日志里 localReady=false），');
      console.log('        搜索/筛选/排序全部退化为云请求；云不可用时就只剩 9 人本地样本。');
      console.log('        修复：需重新预热 roster（全表扫描 + 写云存储 + 回写本 meta 文档）。');
      console.log('        注意：小程序端 get_players action=roster 在数据量 >1000 时会拒绝现场生成。');
    }
  } catch (e) {
    console.log('  roster : 不存在（' + (e.code || '') + '）');
    console.log('     ⚠️ 同上的方案A 失效影响，见上。');
  }

  // ---- 3. 云函数 ----
  console.log('\n[3/5] 云函数（小程序真正调用的三个）');
  const calls = [
    ['get_players', { version: VER, action: 'facets' }, (x) => 'code=' + x.code],
    ['get_players', { version: VER, sort: 'overall', page: 1, pageSize: 3 }, (x) => 'code=' + x.code + ' total=' + x.total + ' 首条=' + ((x.data && x.data[0] && x.data[0].commonName) || '-')],
    ['get_players', { version: VER, keyword: 'mbapp', page: 1, pageSize: 3 }, (x) => 'code=' + x.code + ' 命中=' + x.total],
    ['get_player_detail', { version: VER, eaId: '231747' }, (x) => 'code=' + x.code + ' 有文档=' + !!x.data],
    ['player_hot', { action: 'list', version: VER, limit: 20 }, (x) => 'code=' + x.code + ' 榜单条数=' + ((x.data || []).length)]
  ];
  for (const [name, data, fmt] of calls) {
    const t = Date.now();
    try {
      const r = await app.callFunction({ name: name, data: data });
      const x = r.result || {};
      const line = name + '(' + JSON.stringify(data).slice(0, 60) + ') → ' + fmt(x);
      if (x.code !== 0) bad(line); else console.log('  ✅ ' + line + '  [' + (Date.now() - t) + 'ms]');
    } catch (e) {
      bad(name + ' 调用失败：' + e.message.slice(0, 140));
    }
  }

  // ---- 4. 详情字段抽查（accelerateTypes 是否还在）----
  console.log('\n[4/5] 详情字段抽查');
  try {
    const r = await db.collection(D_COL).where({ accelerateTypes: db.command.exists(true) }).limit(1).get();
    console.log('  accelerateTypes 存在条数（抽样）= ' + r.data.length + (r.data.length ? '' : '  ⚠️ 可能被清空'));
    if (!r.data.length) bad('details 里 accelerateTypes 字段疑似丢失');
  } catch (e) { bad('字段抽查失败：' + e.message.slice(0, 120)); }

  // ---- 5. 结论 ----
  console.log('\n[5/5] 结论');
  if (problems === 0) {
    console.log('  ✅ 云端一切正常。若小程序仍报 Failed to fetch / 搜索为空，问题在【客户端】：');
    console.log('     - 系统代理 / 代理软件（Clash 类）拦截了开发者工具的云调用 → 关掉代理再试');
    console.log('     - 开发者工具登录态失效 → 重新扫码登录');
    console.log('     - 工具缓存异常 → 清除缓存并重启');
    console.log('     隔离测试（在开发者工具 Console 执行）：');
    console.log('       wx.cloud.callFunction({name:"get_players",data:{version:"' + VER + '",action:"facets"}}).then(console.log).catch(console.error)');
  } else {
    console.log('  ⚠️ 发现 ' + problems + ' 个云端问题，见上面 ❌ 行，这才是小程序异常的原因。');
  }
})();
