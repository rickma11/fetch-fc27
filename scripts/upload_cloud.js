// 把成型后的 JSON 推送到 WeChat 云开发云存储 fc27/ 目录，供小程序云函数读取。
// 凭证来自环境变量（CI 中由 GitHub Secrets 注入，切勿硬编码）：
//   TCB_ENV_ID / TCB_SECRET_ID / TCB_SECRET_KEY
// 使用 tcb-admin-node SDK（云开发服务端 Node SDK）。
const fs = require('fs');
const path = require('path');
const tcb = require('tcb-admin-node');

const ENV_ID = process.env.TCB_ENV_ID;
const SECRET_ID = process.env.TCB_SECRET_ID;
const SECRET_KEY = process.env.TCB_SECRET_KEY;
if (!ENV_ID || !SECRET_ID || !SECRET_KEY) {
  console.error('缺少环境变量 TCB_ENV_ID / TCB_SECRET_ID / TCB_SECRET_KEY，无法上传云存储');
  process.exit(1);
}
const app = tcb.init({ env: ENV_ID, secretId: SECRET_ID, secretKey: SECRET_KEY });

const ROOT = path.resolve(__dirname, '..');
const files = [
  { local: path.join(ROOT, 'cloud-data', 'fc27', 'players.json'), cloud: 'fc27/players.json' },
  { local: path.join(ROOT, 'cloud-data', 'fc27', 'details.json'), cloud: 'fc27/details.json' }
];

(async () => {
  for (const f of files) {
    if (!fs.existsSync(f.local)) { console.error('本地文件缺失:', f.local); process.exit(1); }
    const buf = fs.readFileSync(f.local);
    console.log('上传', f.cloud, (buf.length / 1024).toFixed(1), 'KB');
    try {
      const res = await app.storage.uploadFile({ cloudPath: f.cloud, fileContent: buf });
      console.log('  ->', JSON.stringify(res));
    } catch (e) {
      console.error('  上传失败:', e.message);
      throw e;
    }
  }
  console.log('云存储上传完成');
})().catch(e => { console.error('上传失败:', e); process.exit(1); });
