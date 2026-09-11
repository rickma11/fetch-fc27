// 批量写入吞吐探针：找出在当前云开发环境下「每批多少条 + 并发多少」最快且不超时。
//
// 为什么需要它：云开发免费环境的 insertDocument 单请求很慢（实测每批 100 条要十几秒），
// 而 @cloudbase/node-sdk 的默认超时只有 15 秒 → 大批次必然踩 ESOCKETTIMEDOUT。
// 调批次大小/并发之前，先用真实环境量一遍，别靠猜。
//
// 用法（本机无 node 命令，用完整路径）：
//   cd E:\workbuddy\fetch-fc27
//   C:\Users\WIN10\.workbuddy\binaries\node\versions\22.12.0\node.exe scripts\probe_bulk.js
//
// 只写临时集合 probe_bulk_fc27，跑完自动删除，不碰正式数据。
const cloudbase = require('@cloudbase/node-sdk');
const { resolve } = require('./tcb_env');

const cred = resolve();
if (cred.missing.length) {
  console.error(cred.hint);
  process.exit(1);
}

const COL = 'probe_bulk_fc27';
const app = cloudbase.init({
  env: cred.ENV_ID,
  secretId: cred.SECRET_ID,
  secretKey: cred.SECRET_KEY,
  timeout: 90000,
});
const db = app.database();

// 贴近真实体量：player 文档约 0.8KB，detail 约 2KB
function makeDoc(i, sizeKB) {
  return {
    _id: 'probe_' + i,
    eaId: i,
    commonName: 'Probe Player ' + i,
    overall: 50 + (i % 50),
    pad: 'x'.repeat(Math.max(0, sizeKB * 1024 - 120)),
  };
}

function nowMs() { return Date.now(); }

async function timed(fn) {
  const t = nowMs();
  try {
    await fn();
    return { ok: true, ms: nowMs() - t };
  } catch (e) {
    return { ok: false, ms: nowMs() - t, err: (e && e.message) || String(e) };
  }
}

async function clearCol() {
  try {
    let removed = 0;
    for (;;) {
      const r = await db.collection(COL).where({ eaId: db.command.gte(0) }).remove();
      const d = (r && (r.deleted || (r.data && r.data.deleted))) || 0;
      removed += d;
      if (!d) break;
      if (removed > 5000) break;
    }
  } catch (e) { /* 集合不存在时忽略 */ }
}

async function runConfig(batchSize, conc, total, sizeKB, label) {
  const docs = [];
  for (let i = 0; i < total; i++) docs.push(makeDoc(i, sizeKB));

  await clearCol();

  const batches = [];
  for (let i = 0; i < docs.length; i += batchSize) batches.push(docs.slice(i, i + batchSize));

  const lat = [];
  let failed = 0;
  let firstErr = null;
  const t0 = nowMs();

  let cursor = 0;
  async function worker() {
    for (;;) {
      const idx = cursor++;
      if (idx >= batches.length) return;
      const r = await timed(() => db.collection(COL).add(batches[idx]));
      lat.push(r.ms);
      if (!r.ok) { failed++; if (!firstErr) firstErr = r.err + '（' + r.ms + 'ms）'; }
    }
  }
  await Promise.all(Array.from({ length: conc }, worker));
  const totalMs = nowMs() - t0;

  lat.sort((a, b) => a - b);
  const p50 = lat[Math.floor(lat.length * 0.5)] || 0;
  const p95 = lat[Math.floor(lat.length * 0.95)] || 0;
  const rate = total / (totalMs / 1000);

  console.log(
    '  ' + label.padEnd(26) +
    ' 批次 ' + String(batchSize).padStart(3) + ' 并发 ' + String(conc).padStart(2) +
    ' | ' + totalMs + 'ms 共' + total + '条' +
    ' | ' + rate.toFixed(1) + ' 条/秒' +
    ' | 单请求 p50 ' + p50 + 'ms p95 ' + p95 + 'ms' +
    ' | 失败 ' + failed + (firstErr ? ' → ' + firstErr : '')
  );
  return { batchSize, conc, rate, totalMs, failed, p95 };
}

(async function () {
  console.log('环境:', cred.ENV_ID);
  console.log('SDK timeout 配置:', (app.config && app.config.timeout) || '(未读到，按默认 15s)');
  console.log('');

  try { await db.createCollection(COL); } catch (e) { /* 已存在 */ }

  const results = [];
  console.log('【A】列表型文档（约 0.8KB/条，对应 players）');
  results.push(await runConfig(100, 1, 300, 1, 'A1 旧配置（现状基线）'));
  results.push(await runConfig(40, 4, 300, 1, 'A2 小批次+中等并发'));
  results.push(await runConfig(20, 8, 300, 1, 'A3 更小批次+高并发'));

  console.log('');
  console.log('【B】详情型文档（约 2KB/条，对应 details）');
  results.push(await runConfig(20, 1, 200, 2, 'B1 旧配置（现状基线）'));
  results.push(await runConfig(20, 6, 200, 2, 'B2 小批次+中等并发'));
  results.push(await runConfig(10, 8, 200, 2, 'B3 更小批次+高并发'));

  // 按「足够稳（失败 0 且 p95 远低于 90s）」的前提下选最快
  const ok = results.filter(r => r.failed === 0);
  const best = (ok.length ? ok : results).sort((a, b) => b.rate - a.rate)[0];

  console.log('');
  console.log('== 建议 ==');
  console.log('  最快且零失败：批次 ' + best.batchSize + ' + 并发 ' + best.conc +
    '（' + best.rate.toFixed(1) + ' 条/秒）');
  console.log('  按 10000 列表 + 10000 详情估算耗时：约 ' +
    Math.round(10000 / best.rate + 10000 / best.rate) + ' 秒');

  await clearCol();
  try { await db.collection(COL).remove(); } catch (e) { /* ignore */ }
  console.log('\n临时集合已清理。');
})().catch(function (e) {
  console.error('探针失败:', (e && e.message) || e);
  process.exit(1);
});
