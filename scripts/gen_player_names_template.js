// 生成球员中文名翻译模板 Excel（供用户用其他软件翻译后回填）
// 用法: node scripts/gen_player_names_template.js
const fs = require('fs');
const xlsx = require('xlsx');

const UNIV = 'data/player_universe.json';
const ZH = 'data/player_names_zh.json';
const OUT = 'data/player_names_template.xlsx';

const univ = JSON.parse(fs.readFileSync(UNIV, 'utf8'));
const zh = JSON.parse(fs.readFileSync(ZH, 'utf8'));

const rows = univ.map(p => {
  const e = zh[p.commonName];
  return {
    'eaId(备用键)': p.eaId,
    'commonName(关联键-勿改)': p.commonName,
    '俱乐部': p.club || '',
    '联赛': p.league || '',
    '国家队': p.nation || '',
    '总评': p.overall || '',
    '稀有度': p.rarity || '',
    'zh(中文名-请填写/校对)': (e && e.zh) || '',
    'alias(别名异译-选填,逗号分隔)': (e && e.alias && e.alias.length) ? e.alias.join('，') : ''
  };
});

const ws = xlsx.utils.json_to_sheet(rows);
// 列宽友好
ws['!cols'] = [
  { wch: 10 },  // eaId
  { wch: 28 },  // commonName
  { wch: 22 },  // 俱乐部
  { wch: 24 },  // 联赛
  { wch: 18 },  // 国家队
  { wch: 6 },   // 总评
  { wch: 10 },  // 稀有度
  { wch: 22 },  // zh
  { wch: 24 }   // alias
];

// 说明页
const help = [
  ['球员中文名翻译模板 · 使用说明'],
  [''],
  ['1. 本表共 ' + rows.length + ' 行，为 FC27 真实名册去重后的唯一真人球员。'],
  ['2. 请只填写 / 校对以下两列，其余列请勿改动：'],
  ['   - zh(中文名-请填写/校对)：球员的中文译名。维基已翻译的已预填草稿，请校对或覆盖。'],
  ['   - alias(别名异译-选填,逗号分隔)：音译多写法，如 赖斯 的别名填 "莱斯,德克兰·赖斯"。'],
  ['3. 绝对不要改 "commonName(关联键-勿改)" 列——它是程序回写中文名的唯一关联键。'],
  ['4. 不要增删行、不要改 eaId。'],
  ['5. 翻译完把文件发回，我会跑合并脚本重建 player_names_zh.json。'],
  [''],
  ['【格式示例】'],
  ['commonName(关联键-勿改) | zh(中文名) | alias(别名异译)'],
  ['Declan Rice               | 德克兰·赖斯  | 莱斯,赖斯'],
  ['Lionel Messi              | 利昂内尔·梅西 | 梅西'],
  ['Erling Haaland            | 埃尔林·哈兰德 | 哈兰德'],
  [''],
  ['【为什么需要 alias】'],
  ['"莱斯""赖斯" 是 Declan Rice 的不同音译写法，用户搜任一个都应命中。'],
  ['把多个写法放进 alias（逗号分隔，可用中文逗号或英文逗号），即可全覆盖。'],
  ['【单名匹配问题】'],
  ['多人同名（如多个 Adam）已在名册里各自独立成行，搜索时按中文名子串匹配，'],
  ['输入 "亚当" 会一次捞出所有 "亚当·X"，无需额外处理。']
];
const wsHelp = xlsx.utils.aoa_to_sheet(help);
wsHelp['!cols'] = [{ wch: 70 }];

const wb = xlsx.utils.book_new();
xlsx.utils.book_append_sheet(wb, ws, '球员名单');
xlsx.utils.book_append_sheet(wb, wsHelp, '说明');
xlsx.writeFile(wb, OUT);

const filled = rows.filter(r => r['zh(中文名-请填写/校对)']).length;
console.log('已生成:', OUT);
console.log('总行数:', rows.length, '| 已预填中文草稿:', filled, '| 待你翻译:', rows.length - filled);
