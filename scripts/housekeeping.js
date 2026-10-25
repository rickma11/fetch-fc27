// 云存储历史文件清理（housekeeping）。
//
// 背景：fc{ver}/data/<name>/ 下由 CI / 云函数定时生成的静态 JSON 会按 hash / 时间戳不断堆积：
//   · hotboard   —— player_hot 定时器每 30 分钟上传一个 hotboard_<ts>.json，且**从不清理**（最紧急）；
//   · changelog  —— 仅版本变化时写，但也会堆积；
//   · home_hot / home_new / get_sbcs / get_evolutions —— publishOne 写后删 prevFileId，但失败/并发会留孤儿；
//   · dict_basic —— 每小时生成，hash 命名，内容变则换名；
//   · fc{ver}/market/ —— price_view_<桶>.json 每小时生成，且历史 _chain_*.json / price_all_*.json 已成孤儿。
// 端上只读 meta_fc{ver}/<name>.fileID 指向的当前文件，其余都是死数据，白占云存储配额。
//
// 本脚本（独立每日 workflow 调用）：
//   1. 对 7 类可堆积目录，读 meta 当前 fileID（＋ prevFileId）作为 keep 集合；
//   2. walkCloudDir 枚举该目录全部文件（@cloudbase/node-sdk 无 list，必须用 manager-node）；
//   3. 额外保留「最大 Key」（最新写入）防竞态；
//   4. 删掉 keep 集合之外的所有文件。
//   5. 对 market 目录特殊处理（2026-10-18 重写，事故见规则 130）：
//      活文件白名单永不删（series_24h* / *_backup_latest / under80_alerts / daily_7d* / market_overview / under80_view_* 族）
//      ＋ 只删已知垃圾（_chain_* / price_all_* / 超出最新 12 个的 price_view）
//      ＋ 不明文件默认保留并 ::error 告警。
//      ⚠️ 旧逻辑「只留 12 个 price_view、其余全删」把活文件当孤儿每天删一次，导致 24h 序列
//      每天被重置（10/13-10/18 连续 5 天），且 CI 全绿无告警。
//
// 安全护栏：
//   · 若某类 keep 为空（meta 缺失 / fileID 为空），**跳过该类**——宁可不删，绝不误删当前文件；
//   · 共享桶环境（basePath 非空）映射不确定，直接中止删除；
//   · --dry-run 只列不删，首次验证用。
//
// 依赖：@cloudbase/node-sdk（读 meta 数据库）＋ @cloudbase/manager-node（列/删存储，node-sdk 无 list）。
// 凭证：TCB_ENV_ID / TCB_SECRET_ID / TCB_SECRET_KEY（与 fetch-fc27.yml 同套）。
//
// 用法：node scripts/housekeeping.js [ver] [--dry-run]
'use strict';

const manager = require('@cloudbase/manager-node');
const cloudbase = require('@cloudbase/node-sdk');

const VER = Number(process.argv[2] || process.env.FC_VER || 27);
const DRY = process.argv.indexOf('--dry-run') >= 0 || process.env.DRY_RUN === '1';
const META_COLLECTION = 'meta_fc' + VER;
const DATA_PREFIX = 'fc' + VER + '/data/';

// 6 类可堆积目录（name 同时是 meta 文档 _id 与存储子目录名，与 gen_static_lists / gen_home_payload /
// player_hot#publishHotboard / get_changelog#publishStatic 完全一致）。
const CATEGORIES = [
  'hotboard',
  'home_hot',
  'home_new',
  'get_sbcs',
  'get_evolutions',
  'changelog',
  'dict_basic'
];

// node-sdk / wx-server-sdk 的 doc().get() 返回 data 可能是数组或对象，统一解包
function docData(r) {
  if (!r) return null;
  const d = r.data;
  if (Array.isArray(d)) return d[0] || null;
  return d || null;
}

// fileID（cloud://env.bucket/path） → 逻辑云路径（path），用于与 walkCloudDir 返回的 Key 对齐
function fidToPath(fid) {
  if (!fid) return '';
  return String(fid).replace(/^cloud:\/\/[^\/]+\//, '');
}

async function run() {
  const envId = process.env.TCB_ENV_ID;
  const sid = process.env.TCB_SECRET_ID;
  const skey = process.env.TCB_SECRET_KEY;
  if (!envId || !sid || !skey) throw new Error('缺 TCB_ENV_ID / TCB_SECRET_ID / TCB_SECRET_KEY');

  const tcb = manager.init({ secretId: sid, secretKey: skey, envId: envId });
  const storage = tcb.storage;
  const app = cloudbase.init({ env: envId, secretId: sid, secretKey: skey });
  const db = app.database();

  // 触发 lazyInit 后读取存储配置，校验 basePath（共享桶环境不删）
  let cfg = null;
  try {
    await storage.walkCloudDir(DATA_PREFIX);   // 触发 env 信息懒加载
    cfg = storage.getStorageConfig();
  } catch (e) {
    cfg = null;
  }
  const basePath = (cfg && cfg.basePath) || '';
  console.log('存储配置: env=' + (cfg && cfg.env) + ' bucket=' + (cfg && cfg.bucket) +
    ' region=' + (cfg && cfg.region) + ' basePath=' + JSON.stringify(basePath));
  if (basePath) {
    console.error('⚠️ 检测到共享桶环境（basePath 非空），删除映射不确定，为安全起见本脚本中止删除。');
    process.exit(2);
  }

  let totalDeleted = 0;
  let totalWouldDelete = 0;

  for (let ci = 0; ci < CATEGORIES.length; ci++) {
    const name = CATEGORIES[ci];
    const prefix = DATA_PREFIX + name + '/';

    // 1) 枚举该目录全部文件
    let files = [];
    try {
      files = await storage.walkCloudDir(prefix);
    } catch (e) {
      console.error('[' + name + '] 列举失败，跳过该类: ' + e.message);
      continue;
    }
    const keys = (files || []).map(function (f) { return f.Key; }).filter(Boolean);

    // 2) keep 集合：meta 当前 fileID ＋ prevFileId
    const keep = new Set();
    try {
      const m = docData(await db.collection(META_COLLECTION).doc(name).get());
      if (m) {
        if (m.fileID) keep.add(fidToPath(m.fileID));
        if (m.prevFileId) keep.add(fidToPath(m.prevFileId));
      }
    } catch (e) { /* 集合/文档缺失：keep 留空，下面会安全跳过 */ }

    // 3) 防竞态：额外保留「真实最新写入」的文件（按 LastModified 时间排序，而非文件名字符串比较）。
    //    ⚠️ 不能用文件名字符串比较：哈希命名目录（home_hot/home_new/get_sbcs/get_evolutions）
    //    文件名与时间无关，字符串最大会误留老文件（如误留 9-30 那份），必须按真实写入时间取最新。
    if (keys.length) {
      let newestKey = keys[0];
      let newestMs = Date.parse((files[0] && files[0].LastModified) || 0) || 0;
      for (let k = 1; k < keys.length; k++) {
        const ms = Date.parse((files[k] && files[k].LastModified) || 0) || 0;
        if (ms > newestMs) { newestMs = ms; newestKey = keys[k]; }
      }
      keep.add(newestKey);
    }

    // 4) 候选删除：列出但不在 keep 中
    const toDelete = keys.filter(function (k) { return !keep.has(k); });
    const flag = keep.size === 0 ? ' ⚠️ keep 为空' : '';
    console.log('[' + name + '] 文件数=' + keys.length + ' 保留=' + keep.size +
      ' 待删=' + toDelete.length + flag);

    if (!toDelete.length) continue;

    // keep 为空 ⇒ 无法确认当前文件，宁可不动（防误删）
    if (keep.size === 0) {
      console.error('[' + name + '] 跳过删除：keep 为空（meta 缺失），为防误删当前文件不执行删除');
      continue;
    }

    if (DRY) {
      toDelete.forEach(function (k) { console.log('  (dry) 将删: ' + k); });
      totalWouldDelete += toDelete.length;
      continue;
    }

    // 分批删除（每批 20，node-sdk/manager 批量删除上限内留余量）
    for (let i = 0; i < toDelete.length; i += 20) {
      const batch = toDelete.slice(i, i + 20);
      try {
        await storage.deleteFile(batch);
        console.log('  已删 ' + batch.length + ' 个: ' + batch.map(function (k) { return k.split('/').pop(); }).join(', '));
      } catch (e) {
        console.error('  删除批次失败（继续下一批）: ' + e.message);
      }
    }
    totalDeleted += toDelete.length;
  }

  // ── 特殊目录：fc{ver}/market/ ──
  // 保留规则（2026-10-18 重写；旧逻辑每天误删活文件致 24h 序列重置，见规则 130）：
  //   ① 活文件白名单——每小时 market sync 读写的固定名文件，永不删：
  //      series_24h.json / series_24h_backup_latest.json /
  //      series_24h_under80.json / series_24h_under80_backup_latest.json /
  //      under80_alerts.json /
  //      daily_7d.json / daily_7d_backup_latest.json（2026-10-23 按天聚合）/
  //      market_overview.json（2026-10-25 市场整体波动，docs/37）
  //      外加 under80_view_*.json 整族（寿命由 sync 的 pruneOldUnder80Views 管，这里不碰）；
  //   ② 已知垃圾才删：_chain_*.json、price_all_*.json、超出最新 12 个的 price_view_*.json；
  //   ③ 不明文件（不在白名单、不匹配任何已知家族）→ 默认不删 + ::error 告警。
  const marketPrefix = 'fc' + VER + '/market/';
  const MARKET_LIVE_FILES = [
    'series_24h.json',
    'series_24h_backup_latest.json',
    'series_24h_under80.json',
    'series_24h_under80_backup_latest.json',
    'under80_alerts.json',
    'daily_7d.json',
    'daily_7d_backup_latest.json',
    'market_overview.json'
  ];
  const MARKET_DEAD_PATTERNS = [/^_chain_.*\.json$/, /^price_all_.*\.json$/];
  const MARKET_LIVE_NAME_RE = /^(series_24h.*\.json|under80_alerts\.json|under80_view_\d{12}\.json|daily_7d.*\.json|market_overview\.json)$/;
  try {
    const marketFiles = await storage.walkCloudDir(marketPrefix);
    const marketKeys = (marketFiles || []).map(function (f) { return f.Key; }).filter(Boolean);
    const baseOf = function (k) { return k.split('/').pop() || ''; };
    const isPriceView = function (k) { return /^price_view_\d{12}\.json$/.test(baseOf(k)); };
    const isLiveView = function (k) { return /^under80_view_\d{12}\.json$/.test(baseOf(k)); };
    const priceViewKeys = marketKeys.filter(isPriceView).sort();
    if (priceViewKeys.length === 0) {
      console.error('[market] 跳过删除：未找到 price_view_*.json，为防误删不执行');
    } else {
      const keepMarket = new Set(priceViewKeys.slice(-12));
      MARKET_LIVE_FILES.forEach(function (n) { keepMarket.add(marketPrefix + n); });
      const toDeleteMarket = [];
      const unknownKeep = [];
      marketKeys.forEach(function (k) {
        if (keepMarket.has(k) || isLiveView(k)) return;
        if (isPriceView(k) || MARKET_DEAD_PATTERNS.some(function (re) { return re.test(baseOf(k)); })) {
          toDeleteMarket.push(k);
        } else {
          unknownKeep.push(k);
        }
      });
      const liveViewN = marketKeys.filter(isLiveView).length;
      console.log('[market] 文件数=' + marketKeys.length + ' 保留=' + (keepMarket.size + liveViewN) +
        '（白名单 ' + keepMarket.size + ' ＋ view 快照 ' + liveViewN + '）待删=' + toDeleteMarket.length +
        (unknownKeep.length ? (' 不明文件保留=' + unknownKeep.length) : ''));
      if (unknownKeep.length) {
        console.error('::error::[market] 不明文件（不匹配任何已知家族），按防误删原则保留，请人工确认: ' +
          unknownKeep.map(baseOf).join(', '));
      }
      // 防误删护栏：正常不可达（活文件名已在上面排除），防未来改码 reintroduce 老 bug
      const liveHit = toDeleteMarket.filter(function (k) { return MARKET_LIVE_NAME_RE.test(baseOf(k)); });
      if (liveHit.length) {
        console.error('::error::[market] 防误删护栏触发：待删清单命中活文件名模式，终止本次 market 删除: ' +
          liveHit.map(baseOf).join(', '));
      } else if (toDeleteMarket.length) {
        if (DRY) {
          toDeleteMarket.forEach(function (k) { console.log('  (dry) 将删: ' + k); });
          totalWouldDelete += toDeleteMarket.length;
        } else {
          for (let i = 0; i < toDeleteMarket.length; i += 20) {
            const batch = toDeleteMarket.slice(i, i + 20);
            try {
              await storage.deleteFile(batch);
              console.log('  已删 ' + batch.length + ' 个: ' + batch.map(baseOf).join(', '));
            } catch (e) {
              console.error('  删除批次失败（继续下一批）: ' + e.message);
            }
          }
          totalDeleted += toDeleteMarket.length;
        }
      }
    }
  } catch (e) {
    console.error('[market] 列举失败，跳过: ' + e.message);
  }

  console.log('\n=== housekeeping 完成 === ' +
    (DRY ? ('(dry-run) 预计删除 ' + totalWouldDelete + ' 个') : ('实际删除 ' + totalDeleted + ' 个')));
}

if (require.main === module) {
  run().catch(function (e) {
    console.error('失败:', e && e.message);
    process.exit(1);
  });
}

module.exports = { fidToPath: fidToPath, docData: docData, CATEGORIES: CATEGORIES, META_COLLECTION: META_COLLECTION };
