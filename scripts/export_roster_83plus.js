// export_roster_83plus.js —— 从「最新球员全量」导出供市场价监控用的 83+ 子集。
//
// 数据来源（两种，按可用性与配额择优）：
//   ① 优先：sync_i18n 刚落盘的共享扫描缓存 cloud-data/fc27/_scan_cache.json
//           （带 --from-cache ⇒ 0 云库读；缓存缺失/过期/条数不足 ⇒ 退化到 ②）
//   ② 退化：直接扫云库 players_fc27，仅投影 5 字段 + 仅 overall>=83
//           （≈624 条 = ≈624 读，比全表 19,860 读轻得多；仅缓存不可用时才走）
//
// 产物（本地模拟）：cloud-data/fc27/roster_83plus.json
//   { ver, ts, updatedAt, count, players:[{eaId, name, overall, pos, imagePath}] }
// 生产环境额外步骤（本脚本仅打印提示，不自动上传）：把该文件 uploadFile 到
//   云存储公有读 fc27/data/roster_83plus.json（与 vote_meta.json 同前缀）。
//
// 用法：node scripts/export_roster_83plus.js [--from-cache] [--upload] [--ver 27]
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const VER = 27;

const argv = process.argv.slice(2);
let FROM_CACHE = false;
let DO_UPLOAD = false;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--from-cache') FROM_CACHE = true;
  else if (argv[i] === '--upload') DO_UPLOAD = true;
  else if ((argv[i] === '--ver' || argv[i] === '-v') && argv[i + 1]) VER = parseInt(argv[++i], 10) || 27;
}

const OUT_FILE = path.join(ROOT, 'cloud-data', 'fc' + VER, 'roster_83plus.json');

// 端上需要的字段：eaId / name(=commonName) / overall / pos(=position) / imagePath / rarity(稀有度名称)
function project(p) {
  return {
    eaId: p.eaId,
    name: p.commonName || p.name || '',
    overall: p.overall || 0,
    pos: p.position || '',
    imagePath: p.imagePath || '',
    rarity: (p.rarity && p.rarity.name) || ''
  };
}

function writeOut(players, sourceLabel) {
  const body = {
    ver: String(VER),
    ts: Date.now(),
    updatedAt: new Date().toISOString(),
    count: players.length,
    source: sourceLabel,
    players: players
  };
  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(body, null, 1) + '\n', 'utf8');
  console.log('[export_roster_83plus] 已写 ' + players.length + ' 条 → ' +
    path.relative(ROOT, OUT_FILE) + '（' + (fs.statSync(OUT_FILE).size / 1024).toFixed(1) + ' KB，来源：' + sourceLabel + '）');
  return body;
}

async function main() {
  let rows = null;
  let sourceLabel = '';

  // ① 优先读缓存（要求 --from-cache；scan_cache 自带三重守卫）
  if (FROM_CACHE) {
    try {
      const scanCache = require('./scan_cache.js');
      const hit = scanCache.read(VER);
      if (hit && hit.rows && hit.rows.length) {
        rows = hit.rows;
        sourceLabel = 'scan_cache(本地缓存, 0 云库读)';
        console.log('[export_roster_83plus] 命中扫描缓存：' + hit.total + ' 条');
      } else {
        console.warn('[export_roster_83plus] 缓存不可用（缺失/过期/条数不足）⇒ 退化为直扫云库');
      }
    } catch (e) {
      console.warn('[export_roster_83plus] 加载 scan_cache 失败 ⇒ 退化直扫：' + String(e && e.message || e).slice(0, 100));
    }
  } else {
    console.log('[export_roster_83plus] 未指定 --from-cache，直接走云库扫描（轻量，仅 83+）');
  }

  // ② 退化：直扫云库 players_fc27，仅投影 5 字段 + 仅 overall>=83
  if (!rows) {
    const { resolve } = require('./tcb_env');
    const cred = resolve();
    if (cred.missing && cred.missing.length) {
      throw new Error('缓存不可用且无云开发凭证：' + cred.missing.join(' / ') +
        '\n先跑 `node scripts/sync_i18n.js --dry` 生成缓存，或提供 .env.local 凭证。');
    }
    const cloudbase = require('@cloudbase/node-sdk');
    const app = cloudbase.init({ env: cred.ENV_ID, secretId: cred.SECRET_ID, secretKey: cred.SECRET_KEY, timeout: 120000 });
    const db = app.database();
    const cmd = db.command;
    const COL = 'players_fc' + VER;
    const proj = { eaId: true, commonName: true, overall: true, position: true, imagePath: true, 'rarity.name': true };
    const all = [];
    let skip = 0;
    while (true) {
      const r = await db.collection(COL).field(proj).where({ overall: cmd.gte(83) }).skip(skip).limit(1000).get();
      const d = r.data || [];
      if (!d.length) break;
      all.push(...d);
      if (d.length < 1000) break;
      skip += 1000;
    }
    rows = all;
    sourceLabel = 'cloud_db(直扫 83+, 轻量)';
    console.log('[export_roster_83plus] 直扫云库 ' + all.length + ' 条(83+)');
  }

  // 筛 83+ + 投影 + 按 overall 降序
  const out = rows
    .filter(p => (p.overall || 0) >= 83)
    .map(project)
    .sort((a, b) => b.overall - a.overall);

  if (!out.length) {
    throw new Error('筛出 0 条 83+，疑似数据源异常，拒绝写出空文件');
  }

  const body = writeOut(out, sourceLabel);
  console.log('[export_roster_83plus] 总评分布（TOP）：' +
    out.slice(0, 5).map(p => p.overall + ' ' + p.name).join(' | '));

  // 生产上传步骤（--upload）：真实 uploadFile 到云存储公有读（与 vote_meta.json 同前缀）
  if (DO_UPLOAD) {
    const { resolve } = require('./tcb_env');
    const cred = resolve();
    if (cred.missing && cred.missing.length) {
      throw new Error('缺少云开发凭证，无法上传：' + cred.missing.join(' / ') +
        '\n在 CI 注入 TCB_ENV_ID / TCB_SECRET_ID / TCB_SECRET_KEY（环境变量），或本地 .env.local 配置。');
    }
    const cloudbase = require('@cloudbase/node-sdk');
    const app = cloudbase.init({ env: cred.ENV_ID, secretId: cred.SECRET_ID, secretKey: cred.SECRET_KEY, timeout: 120000 });
    const buf = fs.readFileSync(OUT_FILE);
    const up = await app.uploadFile({ cloudPath: 'fc27/data/roster_83plus.json', fileContent: buf });
    console.log('[export_roster_83plus] 已上传云存储公有读 fc27/data/roster_83plus.json →', up.fileID);
  } else {
    console.log('[export_roster_83plus] 模拟模式：仅写本地文件，未上传云存储（生产加 --upload 或手动传）');
  }
}

if (require.main === module) {
  main().catch(e => { console.error('[export_roster_83plus] 失败：' + String(e && e.message || e)); process.exit(1); });
}

module.exports = { project: project };
