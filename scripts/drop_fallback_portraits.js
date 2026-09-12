// 清理「逐人合成兜底卡面」的历史产物。
//
// 背景：早期为了让没有半身像（fut.gg imagePath 为空）的球员也有图，曾用
// scripts/gen_fallback_portraits.js 逐人合成「本人卡面 + 灰剪影」并写成 {eaId}.webp。
// 该方案已废弃 —— 现在小程序端识别到「无 portrait」直接换用通用卡面（云存储
// common/generic/g{1,2,3}.webp），不再需要任何逐人合成产物。
//
// 本脚本做的事：
//   1) 从 cloud-data/fc{ver}/images.json 删除这些球员的签名条目（让清单回归自然状态）
//   2) 从云存储删除他们遗留的 {eaId}.webp（只删「无 imagePath」球员的，绝不会碰到真实半身像）
//
// 用法：node scripts/drop_fallback_portraits.js [--ver 27] [--dry]
const fs = require('fs');
const path = require('path');
const cloudbase = require('@cloudbase/node-sdk');
const { resolve } = require('./tcb_env');

const argv = process.argv.slice(2);
const VER = (() => {
  const i = argv.indexOf('--ver');
  return String(i >= 0 && argv[i + 1] ? argv[i + 1] : 27);
})();
const DRY = argv.includes('--dry');

const ROOT = path.resolve(__dirname, '..');
const PLAYERS = path.join(ROOT, 'cloud-data', `fc${VER}`, 'players.json');
const MANIFEST = path.join(ROOT, 'cloud-data', `fc${VER}`, 'images.json');

const players = JSON.parse(fs.readFileSync(PLAYERS, 'utf8'));
const targets = players.filter(p => p.cardImagePath && !p.imagePath).map(p => String(p.eaId));
console.log(`FC${VER}：无 portrait 球员 ${targets.length} 名${DRY ? '（dry-run）' : ''}`);
if (!targets.length) process.exit(0);

// 1) 清单条目
const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
let removed = 0;
targets.forEach(id => { if (manifest[id] !== undefined) { delete manifest[id]; removed++; } });
const sorted = {};
Object.keys(manifest).map(Number).filter(n => !isNaN(n)).sort((a, b) => a - b)
  .forEach(n => { sorted[n] = manifest[n]; });
if (!DRY) fs.writeFileSync(MANIFEST, JSON.stringify(sorted));
console.log(`  清单：删除 ${removed} 条签名，剩余 ${Object.keys(sorted).length} 条`);

// 2) 云存储文件
if (DRY) process.exit(0);
const cred = resolve();
if (cred.missing && cred.missing.length) { console.error(cred.hint); process.exit(1); }
const app = cloudbase.init({ env: cred.ENV_ID, secretId: cred.SECRET_ID, secretKey: cred.SECRET_KEY, timeout: 120000 });

(async () => {
  const up = await app.uploadFile({
    cloudPath: `fc${VER}/images/_probe_${Date.now()}.png`,
    fileContent: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')
  });
  const PREFIX = up.fileID.slice(0, up.fileID.indexOf('fc' + VER + '/images/'));
  await app.deleteFile({ fileList: [up.fileID] });

  let ok = 0, fail = 0;
  for (let i = 0; i < targets.length; i += 50) {
    const batch = targets.slice(i, i + 50).map(id => `${PREFIX}fc${VER}/images/${id}.webp`);
    try {
      const r = await app.deleteFile({ fileList: batch });
      const list = (r && (r.fileList || r.fileIdList)) || [];
      ok += list.length || batch.length;
    } catch (e) { fail += batch.length; console.log(`  批次 ${i / 50 + 1} 失败: ${e.message}`); }
    if ((i / 50) % 2 === 0) process.stdout.write(`  …${Math.min(i + 50, targets.length)}/${targets.length}\n`);
  }
  console.log(`  云存储：删除 ${ok} 个遗留 {eaId}.webp${fail ? '，失败 ' + fail : ''}`);
})().catch(e => { console.error(e); process.exit(1); });
