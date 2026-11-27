// 一次性补签：给「已换脸但库里没有 cardSig」的球员生成签名图 + 写 cardSig 回库。
// 背景（2026-11-27）：增量签名图机制上线前，Champion International Icon 18 人已换脸并上传，
//   但 CI 签名已记进 manifest ⇒ 后续 run 会跳过 ⇒ 签名图永远不会生成 ⇒ 端上缓存锁死旧脸。
//   本脚本从云库真源读这批人，走代理下载 fut.gg 卡面 → 上传 {eaId}_card_{sig}.webp → 写 cardSig。
//
// 用法：node scripts/backfill_card_sig.js --rarities "Champion International Icon"
//                                        [--dry-run] [--no-upload] [--no-db]
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const cloudbase = require('@cloudbase/node-sdk');
const { resolve } = require('./tcb_env');

const cred = resolve();
if (cred.missing.length) { console.error(cred.hint); process.exit(1); }
const app = cloudbase.init({ env: cred.ENV_ID, secretId: cred.SECRET_ID, secretKey: cred.SECRET_KEY, timeout: 180000 });
const db = app.database();

const A = process.argv;
const arg = (k, d) => { const i = A.indexOf(k); return i >= 0 ? A[i + 1] : d; };
const has = k => A.indexOf(k) >= 0;
const RARITIES = String(arg('--rarities', 'Champion International Icon')).split(',').map(s => s.trim()).filter(Boolean);
const DRY = has('--dry-run');
const NO_UPLOAD = has('--no-upload');
const NO_DB = has('--no-db');
const LIMIT = Number(arg('--limit', '0')) || 0;   // 0=全部；>0 只处理前 N 人（冒烟测试用）
const CDN = 'https://game-assets.fut.gg/';
const TRANSFORM = 'cdn-cgi/image/quality=82,format=webp,width=500/';
const PROXY = 'http://127.0.0.1:7890';
const BUCKET = '636c-cloud1-d5gq6q3np8708aeef-1475854307';
const ENV = cred.ENV_ID;
// ⚠️ 系统 temp（纯 ASCII 路径）：Windows curl.exe 对 -o 的中文路径会编码失败（实测）
const TMP = path.join(require('os').tmpdir(), 'oao_card_backfill');

function sigOf(p) {
  const base = String(p || '').split('/').pop();
  const m = /\.([0-9a-f]{16,})\./i.exec(base);
  return (m ? m[1] : '').slice(0, 16);
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

(async () => {
  fs.mkdirSync(TMP, { recursive: true });
  const all = [];
  for (const name of RARITIES) {
    // 云库 where 对象查询（rarity 是嵌套对象），安全用 name 精确匹配
    let skip = 0;
    while (true) {
      const r = await db.collection('players_fc27')
        .where({ 'rarity.name': name })
        .skip(skip).limit(100).get().catch(e => { console.error('查询失败', name, e.message); return { data: [] }; });
      const d = r.data || [];
      all.push.apply(all, d);
      if (d.length < 100) break;
      skip += 100;
    }
  }
  // 只处理「没有 cardSig」的人（有值的说明已经签过，跳过）
  let todo = all.filter(p => p && p.eaId != null && !p.cardSig && p.cardImagePath);
  if (LIMIT > 0) todo = todo.slice(0, LIMIT);
  console.log(`稀有度 [${RARITIES.join(', ')}] 共 ${all.length} 人 | 待补签 ${todo.length} 人${LIMIT ? ' (limit ' + LIMIT + ')' : ''}`);
  if (!todo.length) { console.log('无需补签'); return; }

  let okUpload = 0, okDb = 0, fail = 0;
  for (let i = 0; i < todo.length; i++) {
    const p = todo[i];
    const sig = sigOf(p.cardImagePath);
    if (!sig) { console.log('  跳过(无签名)', p.eaId, p.commonName); continue; }
    const fileName = p.eaId + '_card_' + sig + '.webp';
    const cloudPath = 'fc' + 27 + '/images/' + fileName;
    const local = path.join(TMP, fileName);
    const url = CDN + TRANSFORM + p.cardImagePath;
    console.log(`[${i + 1}/${todo.length}] ${p.eaId} ${p.commonName} sig=${sig}`);
    if (DRY) continue;

    // 下载（走代理，fut.gg 直连 403）
    let dlOk = false;
    if (!fs.existsSync(local)) {
      for (let a = 1; a <= 3; a++) {
        try {
          cp.execFileSync('curl', ['-s', '-x', PROXY, '--max-time', '90', '-o', local, url],
            { encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe'] });
          const sz = fs.existsSync(local) ? fs.statSync(local).size : 0;
          if (sz > 5000) { dlOk = true; break; }
          console.log(`  下载第${a}次体积异常 ${sz}B，重试`);
        } catch (e) { console.log(`  下载第${a}次失败: ${String(e.message).slice(0, 80)}`); }
        await sleep(2000 * a);
      }
    } else dlOk = true;
    if (!dlOk) { fail++; console.log('  下载失败，跳过', p.eaId); continue; }

    // 上传签名图
    if (!NO_UPLOAD) {
      try {
        const buf = fs.readFileSync(local);
        await app.uploadFile({ cloudPath, fileContent: buf });
        okUpload++;
      } catch (e) { fail++; console.log('  上传失败', p.eaId, String(e.message).slice(0, 100)); continue; }
    }
    // 写 cardSig 回库
    if (!NO_DB) {
      try {
        await db.collection('players_fc27').doc(p._id).update({ cardSig: sig });
        okDb++;
      } catch (e) { fail++; console.log('  写库失败', p.eaId, String(e.message).slice(0, 100)); }
    }
    await sleep(120);
  }
  console.log(`\n完成: 上传签名图 ${okUpload} | 写库 ${okDb} | 失败 ${fail}`);
  console.log('临时文件目录:', TMP, '（确认无误后可删）');
})().catch(e => { console.error('FATAL', e); process.exit(1); });
