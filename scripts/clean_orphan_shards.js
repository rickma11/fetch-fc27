// 清理详情分层静态分片的「历史孤儿文件」。
//
// 背景（docs/35 §13-F）：分片文件名 = det_{key}[_p{idx}]_{contentHash}.json。
//   早期把 generatedAt 写进了分片内容 ⇒ hash 每次运行都变 ⇒ 每次运行产出一套新文件，
//   旧文件无人引用成为孤儿（约 54MB/轮，共约 4 轮）。F-1（去掉 generatedAt）上线后文件名才稳定。
//   本脚本把「云存储里有、但当前 manifest 不引用」的文件清掉，并先落盘备份清单（可核对）。
//
// 注意：@cloudbase/node-sdk 没有列举目录的接口，故直接用底层 COS（cos-nodejs-sdk-v5）列举。
//   桶名/region 从 meta 里的 fileID 解析 + region 自动探测。
//
// 安全策略：
//   1) 全量枚举（marker 分页），与「当前 manifest 的分片 fileID + 当前 manifest 自身」求差集；
//      （manifest 文件自身不在 manifest.shards 里，但 meta 正引用它，必须显式保护，否则误删成死链）
//   2) 差集清单写入 probe/orphan_shards_<ts>.json 备份后再删；
//   3) 默认 dry-run（不删），加 --apply 才真删；--keep=N 保留最近 N 轮（默认 0=全清孤儿）。
//
// 用法：node scripts/clean_orphan_shards.js [ver] [--apply]

'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

const argv = process.argv.slice(2);
const VER = Number(argv.filter(function (a) { return !/^--/.test(a); })[0] || process.env.FC_VER || 27);
const APPLY = argv.indexOf('--apply') >= 0;

// 复用根目录 .env.local
function loadEnv() {
  const f = path.join(ROOT, '.env.local');
  const o = {};
  if (fs.existsSync(f)) {
    fs.readFileSync(f, 'utf8').split(/\r?\n/).forEach(function (ln) {
      const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/.exec(ln);
      if (m) o[m[1]] = m[2].trim();
    });
  }
  return o;
}

const CLOUD_DIR = 'fc' + VER + '/data/details_static/';
const META_COL = 'meta_fc' + VER;
const META_DOC = 'detail_static';

function getBucket() {
  const env = loadEnv();
  const COS = require('cos-nodejs-sdk-v5');
  return {
    cos: new COS({ SecretId: env.TCB_SECRET_ID, SecretKey: env.TCB_SECRET_KEY }),
    bucket: process.env.DETAILS_BUCKET || ''
  };
}

async function main() {
  const env = loadEnv();
  const COS = require('cos-nodejs-sdk-v5');
  const cos = new COS({ SecretId: env.TCB_SECRET_ID, SecretKey: env.TCB_SECRET_KEY });
  const gen = require('./gen_static_details.js');
  const app = gen.initCloud();
  const db = app.database();

  const r = await db.collection(META_COL).doc(META_DOC).get();
  const meta = Array.isArray(r.data) ? (r.data[0] || null) : r.data;
  if (!meta || !meta.fileID) { console.error('meta 缺失，拒绝清理'); process.exit(2); }

  // 桶名从 fileID 解析：cloud://<env>.<bucket>/<path>
  const m = /^cloud:\/\/[^/]+?\.([^/.]+)\//.exec(meta.fileID);
  const bucket = process.env.DETAILS_BUCKET || (m ? m[1] : '');
  if (!bucket) { console.error('无法解析桶名: ' + meta.fileID); process.exit(2); }

  const dl = await app.downloadFile({ fileID: meta.fileID });
  const manifest = JSON.parse(dl.fileContent.toString('utf8'));
  // ⚠️ 比对一律用「对象路径 Key」而非 fileID：fileID 形如 cloud://<env>.<bucket>/<key>，
  //    与 COS 列举返回的 Key 不同，直接比 fileID 会把在用文件全判成孤儿（dry-run 实测踩到）。
  function keyOf(fid) { return String(fid || '').replace(/^cloud:\/\/[^/]+\//, ''); }
  const used = {};
  (manifest.shards || []).forEach(function (s) { if (s && s.fileID) used[keyOf(s.fileID)] = 1; });
  // 🔴 保护当前 manifest 自身：meta 元文档的 fileID 指向它，而 manifest.shards 里只有分片、
  //    不含 manifest 文件自己 → 不求这层保护就会把「meta 正引用的 manifest」当孤儿删掉（死链，
  //    端上静态全失效）。2026-10-17 dry-run 实测踩到（143 孤儿里有 manifest_7e5dc675.json=当前版）。
  //    旧 manifest 无回滚价值（发布原子性保证 meta 只可能指向最后一次成功运行的 manifest），一并清。
  used[keyOf(meta.fileID)] = 1;
  console.log('当前 manifest 引用 = ' + Object.keys(used).length + ' 个文件, generatedAt=' + manifest.generatedAt);

  const regions = ['ap-shanghai', 'ap-guangzhou', 'ap-beijing', 'ap-nanjing', 'ap-chengdu', 'ap-hongkong'];
  let list = null, usedRegion = '';
  for (const region of regions) {
    try {
      const out = [];
      let marker = '';
      for (let page = 0; page < 100; page++) {
        const opt = { Bucket: bucket, Region: region, Prefix: CLOUD_DIR, MaxKeys: '1000' };
        if (marker) opt.Marker = marker;
        const res = await new Promise(function (resolve, reject) {
          cos.getBucket(opt, function (e, d) { e ? reject(e) : resolve(d); });
        });
        (res.Contents || []).forEach(function (c) { out.push({ fileID: 'cloud://' + bucket + '/' + c.Key, key: c.Key, size: Number(c.Size) || 0 }); });
        if (!res.IsTruncated) break;
        marker = res.NextMarker || '';
        if (!marker) break;
      }
      list = out; usedRegion = region;
      break;
    } catch (e) { /* 试下一个 region */ }
  }
  if (!list) { console.error('所有候选 region 列举均失败'); process.exit(3); }
  console.log('region=' + usedRegion + '，目录对象数=' + list.length);

  const orphans = list.filter(function (f) { return !used[keyOf(f.fileID)]; });
  const mb = orphans.reduce(function (a, f) { return a + f.size; }, 0) / 1024 / 1024;
  console.log('孤儿对象数 = ' + orphans.length + '，可释放 ≈ ' + mb.toFixed(2) + 'MB');

  if (!orphans.length) { console.log('无需清理'); return; }
  const backup = path.join(ROOT, 'probe', 'orphan_shards_' + Date.now() + '.json');
  fs.writeFileSync(backup, JSON.stringify({ ver: VER, kept: Object.keys(used), orphans: orphans }, null, 2));
  console.log('备份清单: ' + backup);

  if (!APPLY) {
    console.log('\n[dry-run] 未删除。确认后加 --apply 执行。');
    orphans.slice(0, 8).forEach(function (f) { console.log('  将删除: ' + f.fileID.split('/').pop()); });
    if (orphans.length > 8) console.log('  … 其余 ' + (orphans.length - 8) + ' 个');
    return;
  }

  let ok = 0, fail = 0;
  for (let i = 0; i < orphans.length; i += 1000) {
    const batch = orphans.slice(i, i + 1000);
    try {
      const res = await new Promise(function (resolve, reject) {
        cos.deleteMultipleObject({
          Bucket: bucket, Region: usedRegion,
          Objects: batch.map(function (f) { return { Key: f.fileID.replace('cloud://' + bucket + '/', '') }; })
        }, function (e, d) { e ? reject(e) : resolve(d); });
      });
      ok += batch.length;
    } catch (e) { fail += batch.length; console.error('  批次删除失败: ' + e.message); }
  }
  console.log('\n删除完成：成功 ' + ok + '，失败 ' + fail);
}

module.exports = { main: main };

if (require.main === module) {
  main().then(function () { process.exit(0); })
  .catch(function (e) { console.error('ERR', (e && e.message) || e); process.exit(1); });
}
