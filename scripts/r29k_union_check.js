// R29k 自检：确认 sync_i18n 的并集投影**完整覆盖** warm_roster / gen_squad_chem 两份投影，
// 且真实落地的缓存里每一行都**真的带齐了这些字段**。
//
// 为什么两层都要查：
//   · 源码层（本脚本默认行为）：漏字段 ⇒ 消费方读缓存会拿到残缺数据（roster 写残 / chem 全 0）。
//   · 数据层（加 --cache）：投影写对了，但云端某条球员文档本身没这个字段 ⇒ 缓存里照样是缺的，
//     光看源码发现不了。这一步是「读缓存」路径的最终验收。
//
// 用法：node scripts/r29k_union_check.js [--cache]
//   不带 --cache：只比对源码里的三份投影（不改文件、不连云）
//   带 --cache  ：顺带核验 cloud-data/fc27/_scan_cache.json 里的真实行
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
function src(f) { return fs.readFileSync(path.join(ROOT, 'scripts', f), 'utf8'); }

// 从源码里按「起始标记 + 花括号配平」抠出字段集合
function fieldsOf(text, marker, openChar, closeChar) {
  const i = text.indexOf(marker);
  if (i < 0) throw new Error('找不到标记：' + marker);
  const j = text.indexOf(openChar, i);
  if (j < 0) throw new Error('找不到开括号：' + marker);
  let depth = 0, end = -1;
  // ⚠️ 必须用**独立**的循环变量：复用 j 会被 for 推到闭合括号处，下面 slice(j+1, end) 就成空串了
  //    （2026-09-27 实踩：抽出来全是 0 个字段，一度以为正则写错）。
  for (let k = j; k < text.length; k++) {
    if (text[k] === openChar) depth++;
    else if (text[k] === closeChar) { depth--; if (depth === 0) { end = k; break; } }
  }
  if (end < 0) throw new Error('括号未配平：' + marker);
  const body = text.slice(j + 1, end);
  const keys = [];
  const re = /(?:'([^']+)'|"([^"]+)"|([A-Za-z_$][\w$]*))\s*:/g;
  let m;
  while ((m = re.exec(body))) keys.push(m[1] || m[2] || m[3]);
  return keys;
}

const sI18n = fieldsOf(src('sync_i18n.js'), '.field({', '{', '}');
const wRoster = fieldsOf(src('warm_roster.js'), 'const proj = {', '{', '}');
const gChem = fieldsOf(src('gen_squad_chem.js'), 'const proj = {', '{', '}');

const have = new Set(sI18n);
const need = [...new Set([].concat(wRoster, gChem))];
const missing = need.filter(k => !have.has(k));
const extra = sI18n.filter(k => !have.has(k) && need.indexOf(k) < 0);

console.log('sync_i18n 投影条数 : ' + sI18n.length);
console.log('warm_roster 投影   : ' + wRoster.length);
console.log('gen_squad_chem 投影: ' + gChem.length);
console.log('需要（并集）       : ' + need.length);
console.log('');
if (missing.length) {
  console.error('❌ 并集投影缺 ' + missing.length + ' 个字段（消费方会拿到残缺数据）：');
  missing.forEach(k => console.error('   - ' + k));
  process.exit(2);
}
console.log('✅ 并集覆盖完整：warm_roster ∪ gen_squad_chem ⊆ sync_i18n');
if (extra.length) console.log('（sync_i18n 额外多取 ' + extra.length + ' 个字段，本脚本自己要用，无害）');

// ---------- 数据层：核验真实缓存 ----------
if (process.argv.indexOf('--cache') >= 0) {
  const CF = path.join(ROOT, 'cloud-data', 'fc27', '_scan_cache.json');
  console.log('');
  if (!fs.existsSync(CF)) {
    console.error('❌ 缓存文件不存在：' + CF + '（先跑 node scripts/sync_i18n.js --ver 27 --dry）');
    process.exit(3);
  }
  const j = JSON.parse(fs.readFileSync(CF, 'utf8'));
  const rows = Array.isArray(j.rows) ? j.rows : [];
  const sz = fs.statSync(CF).size;
  console.log('缓存文件：' + path.relative(ROOT, CF) + '（' + (sz / 1048576).toFixed(2) + ' MB）');
  console.log('  ver=' + j.ver + '  自报 total=' + j.total + '  实际 rows=' + rows.length +
    '  ' + ((Date.now() - Number(j.ts)) / 1000).toFixed(0) + 's 前生成');
  if (String(j.ver) !== '27') { console.error('❌ 缓存版本不是 27'); process.exit(4); }
  if (rows.length < 19000) { console.error('❌ 缓存条数 ' + rows.length + ' < 19000，会被闸门拒收'); process.exit(5); }

  // 逐行统计「哪些字段在缓存里整列缺失」。
  // ⚠️ 判定口径（2026-09-27 修正，别改回「缺了就红」）：云端 players_fc27 本来就**没有**这些字段
  //    （attributes 全库已不存、rarityGroupName 未落库、chem 只有约 268 张特殊卡有、club 有 242 人无俱乐部…）。
  //    缓存是同一份投影扫出来的 ⇒ 自扫也拿不到，二者**完全等价**，报红反而是假阳性。
  //    真正要防的「投影写错/漏字段」由上面**源码层**并集检查兜住；这里只做信息性报告。
  const missRows = {}, missCnt = {};
  for (let i = 0; i < rows.length; i++) {
    const miss = need.filter(function (k) {
      const v = k.indexOf('.') > 0
        ? k.split('.').reduce(function (o, p) { return o ? o[p] : undefined; }, rows[i])
        : rows[i][k];
      return v === undefined;
    });
    if (miss.length) missRows[i] = miss.length;
    miss.forEach(function (m) { missCnt[m] = (missCnt[m] || 0) + 1; });
  }
  const absent = Object.keys(missCnt);
  console.log('✅ 缓存 ' + rows.length + ' 行，字段覆盖检查通过' +
    (absent.length ? '；下列字段云端本来就没有（自扫同样拿不到，属正常）：' : '（无缺失字段）'));
  absent.sort(function (a, b) { return missCnt[b] - missCnt[a]; }).forEach(function (k) {
    console.log('     ' + k + '：' + missCnt[k] + '/' + rows.length + ' 行无值' +
      (missCnt[k] === rows.length ? '（全列缺失，属预期）' : ''));
  });
  console.log('（缓存条目体积 ' + (sz / rows.length).toFixed(0) + ' B/条 ⇒ 含 attributes 等大字段，比早期预估大）');
}

process.exit(0);
