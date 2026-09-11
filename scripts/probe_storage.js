// 云存储通道自检：确认「上传 -> 取 fileID -> 下载 -> 删除」整条链路可用。
// 背景：本项目此前用云存储传 JSON 从来没真正跑通过（跨账号凭证问题），
// 现在换成环境归属账号的主账号密钥后，需要实测确认图片方案的地基是否成立。
//
// 用法：node scripts/probe_storage.js
const cloudbase = require('@cloudbase/node-sdk');
const { resolve } = require('./tcb_env');

const cred = resolve();
if (cred.missing.length) {
  console.error(cred.hint);
  process.exit(1);
}

const app = cloudbase.init({
  env: cred.ENV_ID,
  secretId: cred.SECRET_ID,
  secretKey: cred.SECRET_KEY,
  timeout: 60000
});

const PROBE_PATH = 'fc27/images/_probe.txt';

(async () => {
  console.log('环境:', cred.ENV_ID, '| 凭证来源:', cred.source);
  console.log();

  // 用 1×1 透明 PNG 作为探针，顺带验证二进制内容不会损坏
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64'
  );

  let step = 'uploadFile';
  try {
    const up = await app.uploadFile({ cloudPath: PROBE_PATH, fileContent: png });
    console.log('✔ 上传成功');
    console.log('  fileID =', up.fileID);
    console.log('  （小程序 <image src="' + up.fileID + '"> 可直接渲染，无需配置任何域名）');

    step = 'getTempFileURL';
    const urlRes = await app.getTempFileURL({ fileList: [up.fileID] });
    const item = (urlRes.fileList || [])[0] || {};
    console.log('✔ 临时链接获取成功');
    console.log('  tempURL status =', item.status, '| code =', item.code);
    if (item.tempFileURL) console.log('  tempURL =', item.tempFileURL.slice(0, 110) + '...');

    step = 'downloadFile';
    const dl = await app.downloadFile({ fileID: up.fileID });
    const buf = Buffer.from(dl.fileContent);
    console.log('✔ 下载成功 | 字节数 =', buf.length, '| 与上传一致 =', buf.equals(png));

    step = 'deleteFile';
    const del = await app.deleteFile({ fileList: [up.fileID] });
    const code = (del.fileList || [])[0] && (del.fileList || [])[0].code;
    console.log('✔ 删除成功 | code =', code);

    console.log('\n✔ 云存储通道完全可用（上传/取链/下载/删除）。图片方案的地基成立。');
  } catch (e) {
    console.error('\n✘ 失败于', step, '->', (e && e.message) || e);
    console.error('  云存储用的是 COS 权限（与数据库的 tcb:* 不同）。');
    console.error('  若是权限错误，给该子用户补一条 COS 数据读写策略；主账号密钥则默认有权限。');
    process.exit(1);
  }
})();
