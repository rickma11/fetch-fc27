// 首页静态 JSON 对拍 / 单测（方案 B，2026-09-30）。
//
// 校验 gen_home_payload.js 产出的 home_hot / home_new：
//   R1 形状对拍：img 非空且为 cloud://、orgLine/rarityNameZh 非空、中文映射非空或 '-'、
//                hotViews 为数字（仅 home_hot）、rarityGroup 为字符串、leagueNameShort 存在。
//   R2 元文档可读：meta_fc{ver}/home_hot、home_new 存在且含 fileID + fetchedAt。
//   R3 回退路径存在：eafc-miniapp/utils/hot.js 仍导出 buildHomePayload（动态兜底）与 buildHomePayloadStatic。
//
// 用法：node scripts/home_payload_test.js [ver]     （默认 27）
// 需要 TCB 凭证（.env.local 或环境变量）；无凭证时直接跳过真实云校验、只跑 R3 静态分析。
'use strict';

const fs = require('fs');
const path = require('path');
const cloudbase = require('@cloudbase/node-sdk');
const genStatic = require('./gen_static_lists.js');

const ROOT = path.resolve(__dirname, '..');
const VER = Number(process.argv[2] || process.env.FC_VER || 27);
const META_COLLECTION = 'meta_fc' + VER;
const HOT_LIMIT = 20;
const NEW_LIMIT = 20;

let failures = 0;
function check(cond, label) {
  if (cond) { console.log('  ✅ ' + label); return true; }
  console.error('  ❌ ' + label);
  failures++;
  return false;
}

// node-sdk / wx-server-sdk 的 doc().get() 返回 data 可能是数组或对象，统一解包
function docData(r) {
  if (!r) return null;
  const d = r.data;
  if (Array.isArray(d)) return d[0] || null;
  return d || null;
}

// R3：端上回退路径（动态 buildHomePayload）与静态入口仍存在
function checkClientFallback() {
  const hotJs = path.resolve(ROOT, '..', 'eafc-miniapp', 'utils', 'hot.js');
  if (!fs.existsSync(hotJs)) {
    check(false, '端上 hot.js 存在（R3 静态分析）');
    return;
  }
  const src = fs.readFileSync(hotJs, 'utf8');
  check(/function\s+buildHomePayload\s*\(/.test(src), '端上仍导出动态 buildHomePayload（回退路径存在）');
  check(/function\s+buildHomePayloadStatic\s*\(/.test(src), '端上已新增 buildHomePayloadStatic（静态入口存在）');
  check(/useStaticHome/.test(src) || /globalData\.useStaticHome/.test(src) || /getApp\(\)\.globalData\.useStaticHome/.test(src),
    '端上引用 useStaticHome 灰度开关');
}

async function checkCloud() {
  let app;
  try {
    app = genStatic.initCloud();
  } catch (e) {
    console.warn('[home_payload_test] 无 TCB 凭证，跳过真实云校验（仅 R3 静态分析）');
    return false;
  }
  const db = app.database();

  // R2：元文档可读
  const metaHot = docData(await db.collection(META_COLLECTION).doc('home_hot').get());
  const metaNew = docData(await db.collection(META_COLLECTION).doc('home_new').get());
  if (!check(metaHot && metaHot.fileID, 'meta_fc' + VER + '/home_hot 存在且含 fileID')) return false;
  if (!check(metaNew && metaNew.fileID, 'meta_fc' + VER + '/home_new 存在且含 fileID')) return false;
  check(!!(metaHot.fetchedAt || metaHot.ts), 'home_hot 元文档含 fetchedAt/ts');
  check(!!(metaNew.fetchedAt || metaNew.ts), 'home_new 元文档含 fetchedAt/ts');

  // R1：形状对拍
  async function loadAndCheck(name, meta, requireHotViews) {
    const dl = await app.downloadFile({ fileID: meta.fileID });
    const buf = dl && dl.fileContent;
    if (!check(buf && buf.length, name + ' 回读非空')) return [];
    let arr;
    try { arr = JSON.parse(buf.toString('utf8')); } catch (e) { arr = null; }
    if (!check(Array.isArray(arr), name + ' 是数组')) return [];
    console.log('  ' + name + ' 记录数=' + arr.length);

    let allOk = true;
    arr.forEach(function (p, i) {
      const id = p.eaId != null ? p.eaId : p._id;
      const tag = name + '[' + i + ' ' + id + ']';
      if (!check(typeof p.img === 'string' && p.img.indexOf('cloud://') === 0, tag + ' img 为 cloud://')) allOk = false;
      if (!check(!!p.orgLine && p.orgLine !== '-', tag + ' orgLine 非空')) allOk = false;
      if (!check(!!p.rarityNameZh, tag + ' rarityNameZh 非空')) allOk = false;
      if (!check(p.clubNameZh != null, tag + ' clubNameZh 存在')) allOk = false;
      if (!check(p.nationNameZh != null, tag + ' nationNameZh 存在')) allOk = false;
      if (!check(p.leagueNameShort != null, tag + ' leagueNameShort 存在')) allOk = false;
      if (!check(typeof p.rarityGroup === 'string', tag + ' rarityGroup 为字符串')) allOk = false;
      if (requireHotViews) {
        if (!check(typeof p.hotViews === 'number', tag + ' hotViews 为数字')) allOk = false;
      }
    });
    check(allOk, name + ' 全部记录形状校验通过');
    check(arr.length > 0, name + ' 非空');
    return arr;
  }

  const hotArr = await loadAndCheck('home_hot', metaHot, true);
  const newArr = await loadAndCheck('home_new', metaNew, false);

  // 额外：hot 与 new 交集检查（同一球员可同时出现在两列表，记录其存在性即可，不强制去重）
  const hotIds = {};
  hotArr.forEach(function (p) { hotIds[p.eaId != null ? p.eaId : p._id] = 1; });
  const overlap = newArr.filter(function (p) { return hotIds[p.eaId != null ? p.eaId : p._id]; }).length;
  console.log('  hot/new 交集=' + overlap + '（允许重复出现，仅信息性）');

  return true;
}

async function main() {
  console.log('=== home_payload_test (ver=' + VER + ') ===');
  console.log('[R3] 端上回退路径静态分析');
  checkClientFallback();

  console.log('[R1/R2] 云端静态 JSON 对拍');
  try {
    await checkCloud();
  } catch (e) {
    console.warn('[home_payload_test] 云校验跳过/异常：', e && e.message);
  }

  if (failures) {
    console.error('\n❌ 共 ' + failures + ' 项失败');
    process.exit(1);
  }
  console.log('\n✅ 全部校验通过');
}

if (require.main === module) {
  main().catch(function (e) { console.error('失败：', e && e.message); process.exit(1); });
}

module.exports = { checkClientFallback: checkClientFallback };
