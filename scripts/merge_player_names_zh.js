// 由用户翻译返还的 Excel 重建 player_names_zh.json
// 用法: node scripts/merge_player_names_zh.js [xlsx路径]
// 优先级: 返还 Excel 的 zh/alias > 人工 override 的 alias(昵称补录) > 无
const fs = require('fs');
const xlsx = require('xlsx');
const OpenCC = require('opencc-js');
const toCN = OpenCC.Converter({ from: 'tw', to: 'cn' });

const XLSX = process.argv[2] || 'E:/Administrator/Downloads/player_names_template.xlsx';
const UNIV = 'data/player_universe.json';
const OVERRIDE = 'data/player_names_override.json';
const OUT = 'data/player_names_zh.json';

function clean(s) {
  if (s === undefined || s === null) return '';
  let v = toCN(String(s));
  v = v.replace(/\s*[(（][^)）]*[)）]\s*$/, ''); // 去尾部维基消歧括号
  return v.trim();
}
function splitAlias(s) {
  if (!s) return [];
  return String(s).split(/[,，、;；]+/).map(clean).filter(Boolean);
}

const wb = xlsx.readFile(XLSX);
const sheetName = wb.SheetNames.find(s => /球员名单/.test(s)) || wb.SheetNames[0];
const grid = xlsx.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, defval: '' });
const H = grid[0].map(h => String(h));
const col = pre => H.findIndex(h => h.startsWith(pre));
const iCn = col('commonName'), iZh = col('zh'), iAlias = col('alias');
if (iCn < 0 || iZh < 0 || iAlias < 0) {
  console.error('FATAL: 表头定位失败', H);
  process.exit(1);
}

const univ = JSON.parse(fs.readFileSync(UNIV, 'utf8'));
const override = JSON.parse(fs.readFileSync(OVERRIDE, 'utf8'));
const ucn = new Set(univ.map(p => p.commonName));

const out = {};
const stat = {
  excelRows: grid.length - 1,
  skippedBadKey: 0,
  emptyZh: 0,
  tradFixed: 0,
  overrideAliasMerged: 0,
  overrideZhConflict: [],
  aliasAscii: []
};
const cover = new Set();

for (let i = 1; i < grid.length; i++) {
  const r = grid[i];
  const cn = String(r[iCn] === undefined ? '' : r[iCn]).trim();
  if (!cn || !ucn.has(cn)) { stat.skippedBadKey++; continue; }
  if (cover.has(cn)) continue; // 防重复行
  const rawZh = String(r[iZh] === undefined ? '' : r[iZh]).trim();
  const zh = clean(rawZh);
  if (!zh) { stat.emptyZh++; continue; }
  if (zh !== rawZh) stat.tradFixed++;

  const alias = new Set(splitAlias(r[iAlias]));
  const ov = override[cn];
  if (ov) {
    if (ov.zh && clean(ov.zh) !== zh) stat.overrideZhConflict.push(cn + ': 覆盖层=' + ov.zh + ' / 采用返还表=' + zh);
    (ov.alias || []).forEach(a => { const c = clean(a); if (c) { alias.add(c); stat.overrideAliasMerged++; } });
  }
  alias.delete(zh); // 与主译名重复则去掉
  const list = [...alias];
  if (list.some(a => /[A-Za-z]/.test(a))) stat.aliasAscii.push(cn + ' -> ' + list.filter(a => /[A-Za-z]/.test(a)).join(','));
  out[cn] = { zh, alias: list };
  cover.add(cn);
}

const finalOut = Object.assign({
  _meta: {
    note: '球员中文名主表：由用户翻译返还的 Excel 重建（scripts/merge_player_names_zh.js）',
    source: XLSX,
    generatedAt: new Date().toISOString(),
    total: Object.keys(out).length,
    key: 'commonName',
    priority: '用户返还表 zh/alias > player_names_override.json 昵称别名'
  }
}, out);
fs.writeFileSync(OUT, JSON.stringify(finalOut, null, 2));

console.log('=== 重建完成 ===');
console.log('输出:', OUT);
console.log('Excel 数据行:', stat.excelRows, '| 最终条目:', Object.keys(out).length);
console.log('名册对齐:', cover.size, '/', univ.length, '(' + (100 * cover.size / univ.length).toFixed(1) + '%)');
console.log('缺中文(空zh):', stat.emptyZh, '| 坏/无关 key:', stat.skippedBadKey);
console.log('繁简清洗条数:', stat.tradFixed);
console.log('合并 override 昵称别名:', stat.overrideAliasMerged, '条');
console.log('alias 总数:', Object.values(out).reduce((n, o) => n + o.alias.length, 0));
if (stat.overrideZhConflict.length) {
  console.log('--- override 与主表 zh 不一致(以返还表为准) ---');
  stat.overrideZhConflict.slice(0, 10).forEach(s => console.log('   ' + s));
  if (stat.overrideZhConflict.length > 10) console.log('   ...共', stat.overrideZhConflict.length, '条');
}
if (stat.aliasAscii.length) {
  console.log('--- alias 含拉丁字母(正常, 如 C罗) ---');
  stat.aliasAscii.slice(0, 10).forEach(s => console.log('   ' + s));
}
console.log('=== 关键校验 ===');
console.log('Declan Rice =>', JSON.stringify(out['Declan Rice']));
