// 一次性清理：删除云存储里已废弃的异动榜基线快照 price_all_market_latest.json。
//
// 背景：2026-10-03 异动榜（moves）产品下线，云函数 market_sync 与 GitHub 备用链路
//       均不再读/写此文件，它已成孤儿文件（端上也不再请求）。按用户要求「去掉相关跑数据」删除。
//
// 安全性：先确认文件存在（getTempFileURL），不存在则直接退出；存在才删除。
// 用法：node scripts/delete_prev_snapshot.js
const cloudbase = require('@cloudbase/node-sdk');
const { resolve } = require('./tcb_env');

const VER = 27;
const TARGET_PATH = `fc${VER}/market/price_all_market_latest.json`;

const cred = resolve();
if (cred.missing.length) { console.error(cred.hint); process.exit(1); }

const app = cloudbase.init({
  env: cred.ENV_ID, secretId: cred.SECRET_ID, secretKey: cred.SECRET_KEY, timeout: 60000
});

(async () => {
  console.log('环境:', cred.ENV_ID);
  console.log('目标文件:', TARGET_PATH);

  // 1) 探针取 fileID 前缀（cloud://<env>.<bucket>/）
  const probePath = `fc${VER}/market/_del_probe.txt`;
  const buf = Buffer.from('x');
  const up = await app.uploadFile({ cloudPath: probePath, fileContent: buf });
  const m = /^(cloud:\/\/[^\/]+)\//.exec(up.fileID || '');
  if (!m) throw new Error('无法从 fileID 解析前缀: ' + up.fileID);
  const prefix = m[1];
  console.log('fileID 前缀:', prefix);
  await app.deleteFile({ fileList: [up.fileID] }); // 清掉探针

  const targetFileId = `${prefix}/${TARGET_PATH}`;

  // 2) 先确认目标存在
  try {
    const info = await app.getTempFileURL({ fileList: [targetFileId] });
    const item = (info.fileList || [])[0];
    if (!item || !item.tempFileURL) {
      console.log('✔ 目标文件不存在（可能已删），无需操作。');
      return;
    }
    console.log('目标文件存在，临时 URL 已确认。准备删除…');
  } catch (e) {
    console.log('⚠️ 确认存在性失败（' + e.message + '），仍尝试直接删除。');
  }

  // 3) 删除
  const r = await app.deleteFile({ fileList: [targetFileId] });
  const f = (r.fileList || [])[0] || {};
  console.log('deleteFile 返回:', JSON.stringify(f));
  if (f.code === 0 || f.code === 'SUCCESS' || f.status === 0) {
    console.log('✔ 已删除 ' + TARGET_PATH);
  } else {
    console.error('✘ 删除未成功（code=' + f.code + '），请到云控制台手动删除。');
    process.exit(1);
  }
})().catch(e => { console.error('\n✘ 失败:', e.message); process.exit(1); });
