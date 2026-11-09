// 球员中文名「搜索索引」生成脚本（2026-11-09，手动按需执行）。
//
// 用途：把全量中文名表 data/player_names_zh.json（~2MB，含显示用冗余）压成只服务「搜索」的
//       紧凑索引 data/player_zh_index.json（~680KB），供：
//       ① scripts/upload_player_names_index.js 上云（meta_fc27/player_zh_index + 公有读文件）；
//       ② 端上 utils/playerZhIndex.js 经 cloudJson#fetchObject 直读；
//       ③ 云函数 get_players 中文关键词反查 commonName。
//
// 结构：{ v, genAt, n: [[zh, "alias1|alias2", commonName], ...] }
//       （对象型 JSON——cloudJson#fetchObject 只收对象；数组体积一样，但对象便于带版本字段）
//
// ⚠️ 不接 CI（用户 2026-11-09 拍板：名单很少更新）。更新流程：改 player_names_zh.json →
//    跑本脚本 → 跑 upload_player_names_index.js，两步各几秒。
// 用法：node scripts/gen_player_names_index.js
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'data', 'player_names_zh.json');
const OUT = path.join(ROOT, 'data', 'player_zh_index.json');

const obj = JSON.parse(fs.readFileSync(SRC, 'utf8'));
const keys = Object.keys(obj).filter(function (k) { return k.charAt(0) !== '_'; });

const n = [];
keys.forEach(function (k) {
  const e = obj[k];
  if (!e || !e.zh) return;                       // 空 zh 不进索引（不该出现，防御）
  const alias = (Array.isArray(e.alias) ? e.alias : []).filter(Boolean).join('|');
  n.push([e.zh, alias, k]);
});

if (n.length < 1000) {                           // 防呆：真源被清空时拒绝生成，避免坏索引覆盖云端
  console.error('player_names_zh.json 条目异常（' + n.length + ' < 1000），拒绝生成');
  process.exit(1);
}

const out = { v: 1, genAt: new Date().toISOString(), n: n };
fs.writeFileSync(OUT, JSON.stringify(out));
const kb = (fs.statSync(OUT).size / 1024).toFixed(1);
console.log('✅ 生成完成:', OUT);
console.log('   条目=' + n.length + ' 体积=' + kb + 'KB');
