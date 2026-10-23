// 80↓ 读旧链决策逻辑测试（2026-10-23 新架构：本地状态文件 → 云 backup_latest → 首跑）
// 复刻 price_sync_cloud.js#runUnder80Sync 读旧段的分支判断，三种输入各自落到正确 src。
const fs = require('fs');
const path = require('path');
const os = require('os');

const STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'u80state-'));
const STATE_FILE = path.join(STATE_DIR, 'series_24h_under80.json');

// 与脚本内联逻辑一致：读本地状态 → 解析校验 buckets → 无效/不存在返回 null（走云 backup）
function readLocalSeriesState(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (j && Array.isArray(j.buckets) && j.buckets.length) return j;
  } catch (e) { /* 不存在/损坏 ⇒ null */ }
  return null;
}

const GOOD = { v: 1, buckets: ['202610230100', '202610230200'], players: {} };
const A = [];
let pass = 0;
function check(name, ok) { A.push([name, ok]); console.log((ok ? '  PASS ' : '  FAIL ') + name); if (ok) pass++; }

// ① 状态文件存在且合法 ⇒ 命中 cache，不读云
fs.writeFileSync(STATE_FILE, JSON.stringify(GOOD));
check('状态文件合法 ⇒ src=cache', (readLocalSeriesState(STATE_FILE) || {}).buckets !== undefined
  && readLocalSeriesState(STATE_FILE).buckets.length === 2);

// ② 状态文件损坏（半截 JSON）⇒ null，走云 backup
fs.writeFileSync(STATE_FILE, '{"v":1,"buckets":["202610');
check('状态文件损坏 ⇒ null（走云 backup）', readLocalSeriesState(STATE_FILE) === null);

// ③ 状态文件存在但 buckets 为空数组 ⇒ null（不拿空序列续写）
fs.writeFileSync(STATE_FILE, JSON.stringify({ v: 1, buckets: [], players: {} }));
check('状态文件 buckets 空 ⇒ null', readLocalSeriesState(STATE_FILE) === null);

// ④ 状态文件缺失（cache 未命中/首轮）⇒ null
check('状态文件缺失 ⇒ null', readLocalSeriesState(path.join(STATE_DIR, 'nope.json')) === null);

// ⑤ 合法序列的 buildSeries 续写不回归（桶数只增不减或持平）
const core = require('./market_core.js');
const s2 = core.buildSeries(GOOD, { view: { tier: [{ eaId: 1, pc: 100, ps: 90 }] } }, '202610230300');
check('buildSeries 续写后桶数=3', s2.buckets.length === 3 && s2.buckets[2] === '202610230300');

fs.rmSync(STATE_DIR, { recursive: true, force: true });
console.log('\n读旧链结果: ' + pass + '/' + A.length + ' 通过');
process.exit(pass === A.length ? 0 : 1);
