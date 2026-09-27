// 共享扫描缓存单测（`npm test`）
//
// 为什么值得单独测：warm_roster / gen_squad_chem 一旦**误用了半截或过期的缓存**，不会报错，
// 只会静默写出一份残缺的 roster / 全 0 的化学表 —— 端上要等用户看到异常才发现。
// 所以「拒绝条件」必须每一条都被单独钉死；每条守卫后面都跟一条**反例自检**（故意构造
// 「守卫若失效就会变红」的样本），避免哪天守卫被顺手删掉、测试却还是绿的假象。
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SC = require(path.join(ROOT, 'scripts', 'scan_cache.js'));
const FILE = SC.CACHE_FILE;

// scan_cache 的 read() 按 process.argv 决定要不要用缓存 ⇒ 测试期间常驻打开
process.argv = ['node', 'scan_cache.test.js', '--from-cache'];

const MIN_TOTAL = 19000;      // 与 scan_cache.js 保持一致（改那边要同步改这里）
const MAX_AGE_MS = 30 * 60 * 1000;

function clean() { try { fs.unlinkSync(FILE); } catch (e) { /* 本来就没有 */ } }
function put(j) { fs.writeFileSync(FILE, JSON.stringify(j)); }
function good(over) {
  return Object.assign({ ver: '27', ts: Date.now(), total: MIN_TOTAL, rows: [{ eaId: 1 }] }, over || {});
}
function rows(n) {
  const a = [];
  for (let i = 0; i < n; i++) a.push({ eaId: i + 1, commonName: 'P' + i, overall: 80, position: 'ST', chem: [1, 0, 0, 0, 0, 0, 0] });
  return a;
}

let pass = 0, fail = 0;
function t(name, fn) {
  clean();
  try { fn(); console.log('  PASS', name); pass++; }
  catch (e) { console.log('  FAIL', name, '->', e.message); fail++; }
}

console.log('scan_cache 守卫（每条的「拒绝」都必须真的返回 null，并附反例自检）：');

// ---------- 守卫① 必须显式 --from-cache ----------
t('① 缓存完美但没传开关 ⇒ 拒绝（本地手动跑不会误吃 CI 缓存）', function () {
  put(good({ total: MIN_TOTAL, rows: rows(MIN_TOTAL) }));
  process.argv = ['node', 'scan_cache.test.js'];
  assert.strictEqual(SC.read('27'), null);
});
t('① 反例自检：同一份缓存，只把开关打开 ⇒ 必须放行（证明变红是「开关」造成的，不是缓存内容）', function () {
  put(good({ total: MIN_TOTAL, rows: rows(MIN_TOTAL) }));
  process.argv = ['node', 'scan_cache.test.js', '--from-cache'];
  assert.ok(SC.read('27'), '开关打开却读不到 ⇒ 说明前面那条 PASS 可能是空转');
});

// ---------- 守卫③ 版本 / 条数 ----------
t('③ 文件不存在 ⇒ null', function () {
  assert.strictEqual(SC.read('27'), null);
});
t('③ 版本不符（缓存 26，要读 27）⇒ null', function () {
  put(good({ ver: '26' }));
  assert.strictEqual(SC.read('27'), null);
});
t('③ 条数不足（rows 只有 18999 条）⇒ null', function () {
  put(good({ total: MIN_TOTAL, rows: rows(MIN_TOTAL - 1) }));
  assert.strictEqual(SC.read('27'), null);
});
t('③ 反例自检：只按文件里的 total 判断就会漏掉「total 虚高、rows 短一截」⇒ 本条钉死「闸看 rows 实长」', function () {
  // 2026-09-27 单测实锤过：旧版只看 j.total，这条会变成「放行」⇒ 半截缓存静默流进消费方。
  put(good({ total: MIN_TOTAL, rows: rows(MIN_TOTAL - 1) }));
  assert.strictEqual(SC.read('27'), null);
});
t('③ 边界：正好 19000 条 ⇒ 放行（闸是 >= ）', function () {
  put(good({ total: MIN_TOTAL, rows: rows(MIN_TOTAL) }));
  assert.ok(SC.read('27'));
});
t('③ 内容为空数组 ⇒ null', function () {
  put(good({ rows: [], total: 0 }));
  assert.strictEqual(SC.read('27'), null);
});
t('③ 文件内容损坏（非法 JSON）⇒ null，不抛异常', function () {
  fs.writeFileSync(FILE, '{ 这不是 json');
  assert.strictEqual(SC.read('27'), null);
});

// ---------- 守卫② 新鲜度 ----------
t('② 已过期（31 分钟前）⇒ null', function () {
  put(good({ ts: Date.now() - MAX_AGE_MS - 60000, total: MIN_TOTAL, rows: rows(MIN_TOTAL) }));
  assert.strictEqual(SC.read('27'), null);
});
t('② 反例自检：把 ts 改成 0（脏数据）⇒ 必须拒绝，不能因为「有文件」就放行', function () {
  put(good({ ts: 0, total: MIN_TOTAL, rows: rows(MIN_TOTAL) }));
  assert.strictEqual(SC.read('27'), null);
});
t('② 边界：29 分 59 秒 ⇒ 放行', function () {
  put(good({ ts: Date.now() - MAX_AGE_MS + 1000, total: MIN_TOTAL, rows: rows(MIN_TOTAL) }));
  assert.ok(SC.read('27'));
});

// ---------- 往返 ----------
t('write → read 往返一致（落盘/读回不错位）', function () {
  assert.strictEqual(SC.write('27', rows(19001)), true);
  const r = SC.read('27');
  assert.ok(r, '刚写的缓存读不到');
  assert.strictEqual(r.total, 19001);
  assert.strictEqual(r.rows.length, 19001);
  assert.strictEqual(r.rows[0].eaId, 1);
  assert.strictEqual(r.rows[19000].eaId, 19001);
});
t('反例自检：rows 只给 1 条却把 total 写成 19000 ⇒ 必须拒绝（防「假总数」骗过闸门）', function () {
  put(good({ total: MIN_TOTAL, rows: [{ eaId: 1 }] }));
  assert.strictEqual(SC.read('27'), null);
});
t('③ total 虚低但 rows 是满的 ⇒ 以 rows 为准，放行（rows 才是真源）', function () {
  put(good({ total: MIN_TOTAL - 1, rows: rows(MIN_TOTAL) }));
  assert.ok(SC.read('27'));
});

clean();   // 别把测试用缓存留在仓库（已 .gitignore，还是清干净）

console.log('\n' + (fail ? 'FAIL' : 'OK') + '：' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
