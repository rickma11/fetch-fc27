// 详情分层静态化回归测试（docs/35，2026-10-16）。
//
// 守护三件事：
//   R1 分片解析契约：端上 utils/cloudJson.js#_shardRecordsToMap 必须能解析生成器产出的分片，
//       无论是包裹对象 {schemaVersion,key,records:[...]}（当前格式）还是裸数组（兼容）。
//       ⚠️ 这是本项目关键回归点：生成器早期曾产出包裹对象而端上按裸数组解析 → 抛 shard-not-array
//       → 全部分片静默回落云函数（优化整体失效）。此测试锁死该契约。
//   R2 manifest 结构：shards[]/big5Leagues(5)/hotNations/schemaVersion/ver 齐全。
//   R3 端云键一致：对抽样分片记录，用端上 detailShardKey.shardKeyOf（manifest 的 big5/hot 同源）
//       重算的分片键必须与 manifest.shards[].key 完全一致 —— 否则端上算的 key 在 manifest 找不到 → 全落云函数。
//   R4 体量 sanity：静态总覆盖 >= 8000（确认分层达 ~40%+ 覆盖，未退化成全长尾）。
//
// 数据源：云端优先（读 meta_fc{ver}/detail_static 真实产物），无 TCB 凭证时回退本地
//        probe/static_details/（先 `node scripts/gen_static_details.js 27 --no-upload` 生成）。
// ⚠️ key 一致性（R3）依赖 eafc-miniapp 仓库（CI 仅 checkout fetch-fc27 时无该仓库 → R3 跳过并告警，
//    开发机双仓库共存时全量覆盖）。
//
// 用法：node scripts/gen_static_details_test.js [ver]     （默认 27）

'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const VER = Number(process.argv[2] || process.env.FC_VER || 27);

let failures = 0;
function check(cond, label) {
  if (cond) { console.log('  ✅ ' + label); return true; }
  console.error('  ❌ ' + label);
  failures++;
  return false;
}

// R1：纯函数单测（不依赖云、不依赖 eafc-miniapp checkout）
function testShardRecordsToMap() {
  let cloudJson = null;
  try { cloudJson = require(path.resolve(ROOT, '..', 'eafc-miniapp', 'utils', 'cloudJson.js')); }
  catch (e) { console.warn('  ⚠️ 端上 cloudJson.js 未找到（CI 仅 fetch-fc27 checkout），跳过 shardRecordsToMap 单测'); return; }
  const fn = cloudJson._shardRecordsToMap;
  if (typeof fn !== 'function') { check(false, 'cloudJson 导出 _shardRecordsToMap'); return; }

  // 包裹对象格式（生成器当前格式）
  const wrapped = { schemaVersion: 1, key: 'r85', records: [ { eaId: 1, _id: 1, overall: 90 }, { eaId: 2, _id: 2, overall: 88 } ] };
  const m1 = fn(wrapped);
  check(m1[1] && m1[1].overall === 90 && m1[2] && m1[2].overall === 88, '包裹对象格式解析正确（按 eaId 索引）');

  // 裸数组格式（兼容/未来）
  const arr = [ { eaId: 10, overall: 85 }, { _id: 11, overall: 84 } ];
  const m2 = fn(arr);
  check(m2[10] && m2[11], '裸数组格式解析正确');

  // 垃圾输入 → {} 不抛
  let threw = false, empty = null;
  try { empty = fn({ foo: 'bar' }); } catch (e) { threw = true; }
  check(!threw && empty && Object.keys(empty).length === 0, '非预期对象输入返回 {} 且不抛');
  threw = false; empty = null;
  try { empty = fn(null); } catch (e) { threw = true; }
  check(!threw && empty && Object.keys(empty).length === 0, 'null 输入返回 {} 且不抛');

  // 缺 eaId/_id 的记录被忽略，其余保留
  const partial = { records: [ { overall: 90 }, { eaId: 5, overall: 80 } ] };
  const m3 = fn(partial);
  check(!m3[0] && m3[5], '缺 eaId/_id 记录被忽略，其余保留');
}

async function loadFromCloud() {
  let gen;
  try { gen = require('./gen_static_details.js'); } catch (e) { return null; }
  let app;
  try { app = gen.initCloud(); } catch (e) { console.warn('  ⚠️ 无 TCB 凭证，跳过云端校验'); return null; }
  const META_COL = 'meta_fc' + VER;
  const db = app.database();
  const r = await db.collection(META_COL).doc('detail_static').get();
  const d = (r && r.data) || null;
  const meta = Array.isArray(d) ? (d[0] || null) : d;
  if (!meta || !meta.fileID) { console.warn('  ⚠️ meta_fc' + VER + '/detail_static 不存在'); return null; }
  const dl = await app.downloadFile({ fileID: meta.fileID });
  const buf = dl && dl.fileContent;
  if (!buf || !buf.length) { console.warn('  ⚠️ manifest 回读为空'); return null; }
  let manifest;
  try { manifest = JSON.parse(buf.toString('utf8')); } catch (e) { console.warn('  ⚠️ manifest 解析失败', e.message); return null; }
  return { app: app, manifest: manifest, localDir: null };
}

async function loadFromLocalProbe() {
  const dir = path.join(ROOT, 'probe', 'static_details');
  const mf = path.join(dir, 'manifest.json');
  if (!fs.existsSync(mf)) {
    console.warn('  ⚠️ 本地 probe/static_details/manifest.json 不存在（先跑 `node scripts/gen_static_details.js ' + VER + ' --no-upload`）');
    return null;
  }
  const manifest = JSON.parse(fs.readFileSync(mf, 'utf8'));
  return { app: null, manifest: manifest, localDir: dir };
}

async function run() {
  console.log('=== gen_static_details_test (ver=' + VER + ') ===');

  console.log('[R1] shardRecordsToMap 纯函数单测');
  testShardRecordsToMap();

  console.log('[R2/R3/R4] 加载 manifest（云优先，回退本地 probe）');
  let ctx = await loadFromCloud();
  const useCloud = !!ctx;
  if (!ctx) ctx = await loadFromLocalProbe();
  if (!ctx) { console.error('\n❌ 无 manifest 来源（既无 TCB 凭证也无本地 probe），无法继续'); process.exit(1); }
  const manifest = ctx.manifest;
  console.log('  manifest 来源：' + (useCloud ? '云端（真实产物）' : '本地 probe') + '，ver=' + manifest.ver);

  if (!check(Array.isArray(manifest.shards) && manifest.shards.length > 0, 'manifest.shards 非空（分片数=' + (manifest.shards || []).length + '）')) return finish();
  check(Array.isArray(manifest.big5Leagues) && manifest.big5Leagues.length === 5, 'manifest.big5Leagues 含 5 个联赛 eaId');
  check(Array.isArray(manifest.hotNations) && manifest.hotNations.length > 0, 'manifest.hotNations 非空（' + (manifest.hotNations || []).length + ' 国）');
  check(typeof manifest.schemaVersion === 'number' && manifest.ver, 'manifest 含 schemaVersion/ver');

  let cloudJson = null;
  try { cloudJson = require(path.resolve(ROOT, '..', 'eafc-miniapp', 'utils', 'cloudJson.js')); } catch (e) {}
  let detailShardKey = null;
  try { detailShardKey = require(path.resolve(ROOT, '..', 'eafc-miniapp', 'utils', 'detailShardKey.js')); }
  catch (e) { console.warn('  ⚠️ detailShardKey 不可用（CI 无 eafc-miniapp 仓库）→ R3 端云键一致性跳过'); }

  // 抽样分片：前 12 个 + 强制含 r85 / r80_84_scope（若存在）
  const shards = manifest.shards;
  const SAMPLE = shards.slice(0, 12);
  ['r85', 'r80_84_scope'].forEach(function (k) {
    const hit = shards.filter(function (s) { return s.key === k; })[0];
    if (hit && SAMPLE.indexOf(hit) < 0) SAMPLE.push(hit);
  });
  const seen = {};
  for (const s of SAMPLE) {
    if (seen[s.key]) continue; seen[s.key] = 1;
    if (!check(typeof s.key === 'string' && s.key.length, '分片 ' + s.key + ' 有 key')) continue;
    // fileID 在云模式为 cloud://、在本地 probe 模式为 local:，两种 locator 都合法
    const okLocator = typeof s.fileID === 'string' && (s.fileID.indexOf('cloud://') === 0 || s.fileID.indexOf('local:') === 0);
    if (!check(okLocator, '分片 ' + s.key + ' fileID 合法(cloud:// 或 local:)')) continue;

    let parsed = null;
    let sz = 0;
    if (useCloud && ctx.app) {
      const d = await ctx.app.downloadFile({ fileID: s.fileID });
      const buf = d && d.fileContent;
      if (!check(buf && buf.length, '分片 ' + s.key + ' 回读非空')) continue;
      sz = buf.length;
      try { parsed = JSON.parse(buf.toString('utf8')); } catch (e) { check(false, '分片 ' + s.key + ' JSON 解析'); continue; }
    } else {
      const fname = (s.fileID.indexOf('local:') === 0) ? s.fileID.slice(6) : (s.key + '.json');
      const fp = path.join(ctx.localDir, fname);
      if (!fs.existsSync(fp)) { console.warn('  ⚠️ 本地分片文件缺失 ' + fp); continue; }
      sz = fs.statSync(fp).size;
      parsed = JSON.parse(fs.readFileSync(fp, 'utf8'));
    }
    // R5：单 part 体积 ≤1.3MB（生成器 SPLIT_LIMIT=1.2MB + 小余量）——>2MB 单文件会被 TCB SDK
    // UserNetworkTooSlow 自我中止（CI 实测三连挂），此检查防止拆分逻辑被改动后悄悄失效。
    check(sz <= 1.3 * 1024 * 1024, '分片 ' + s.key + ' 单 part 体积 ≤1.3MB（实际 ' + (sz / 1024).toFixed(0) + 'KB）');

    const recs = cloudJson
      ? Object.keys(cloudJson._shardRecordsToMap(parsed)).map(function (k) { return cloudJson._shardRecordsToMap(parsed)[k]; })
      : (Array.isArray(parsed) ? parsed : (parsed.records || []));
    if (!check(recs.length > 0, '分片 ' + s.key + ' 解析出记录（' + recs.length + ' 条）')) continue;

    // 每条记录含顶层 eaId（端上按此建索引）
    const allHaveEaId = recs.every(function (r) { return Number(r.eaId) > 0; });
    check(allHaveEaId, '分片 ' + s.key + ' 每条记录含顶层 eaId');

    // R3：端云键一致（仅开发机双仓库可覆盖）
    if (detailShardKey) {
      let mismatch = 0;
      recs.slice(0, 30).forEach(function (r) {
        const p = {
          overall: Number(r.overall) || 0,
          leagueEaId: (r.league && Number(r.league.eaId)) || 0,
          nationEaId: (r.nation && Number(r.nation.eaId)) || 0
        };
        const k = detailShardKey.shardKeyOf(p, manifest.big5Leagues, manifest.hotNations);
        if (k !== s.key) mismatch++;
      });
      check(mismatch === 0, '分片 ' + s.key + ' 抽样记录重算 shardKey 与 manifest.key 完全一致（' + mismatch + ' 不符）');
    }
  }

  // R4：体量 sanity
  const totalCount = shards.reduce(function (a, s) { return a + (Number(s.count) || 0); }, 0);
  check(totalCount >= 8000, '静态总覆盖 >= 8000（实际 ' + totalCount + '，占全量 ~40%+，达标）');

  // R6：全量分片 fileID 唯一（同 key 多 part 靠 fileID 区分，重复会导致端上缓存互踩）
  const fids = shards.map(function (s) { return s.fileID; });
  const dup = fids.filter(function (f, i) { return fids.indexOf(f) !== i; });
  check(dup.length === 0, 'manifest 全量分片 fileID 无重复（' + fids.length + ' 条）' + (dup.length ? '（重复: ' + dup.slice(0, 3).join(' , ') + '）' : ''));

  finish();
}

function finish() {
  if (failures) { console.error('\n❌ 共 ' + failures + ' 项失败'); process.exit(1); }
  console.log('\n✅ 全部校验通过');
}

run().catch(function (e) { console.error('失败：', e && e.message); process.exit(1); });
