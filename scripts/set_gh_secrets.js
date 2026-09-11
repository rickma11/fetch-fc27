// 把 .env.local 里的云开发凭证同步到 GitHub Actions Secrets。
//
// 为什么需要它：CI 走的是 GitHub Secrets 注入的环境变量，不读 .env.local。
// 换了密钥（比如换账号后重新签发）时，两边必须一起改，否则 CI 仍用旧密钥失败。
// 手抄三个值容易出错，这里直接读本地文件加密上传（GitHub 要求 libsodium sealed box）。
//
// 用法（本机无 node 命令，用完整路径；tweetsodium 装在托管 node 工作区）：
//   PowerShell:
//     $env:GH_TOKEN="ghp_xxx"
//     cd E:\workbuddy\fetch-fc27
//     $env:NODE_PATH="C:\Users\WIN10\.workbuddy\binaries\node\workspace\node_modules"
//     C:\Users\WIN10\.workbuddy\binaries\node\versions\22.12.0\node.exe scripts\set_gh_secrets.js
//
// 首次需先装依赖（一次性）：
//   cd C:\Users\WIN10\.workbuddy\binaries\node\workspace
//   npm install tweetsodium
//
// 令牌只需 repo + workflow 权限；用完记得在 GitHub 设置里撤销。
const https = require('https');
const sodium = require('tweetsodium');
const { resolve } = require('./tcb_env');

const OWNER = process.env.GH_OWNER || 'rickma11';
const REPO = process.env.GH_REPO || 'fetch-fc27';
const TOKEN = process.env.GH_TOKEN;

if (!TOKEN) {
  console.error('缺少 GH_TOKEN（GitHub 个人访问令牌，需 repo + workflow 权限）');
  process.exit(1);
}

const cred = resolve();
if (cred.missing.length) {
  console.error(cred.hint);
  process.exit(1);
}

function api(method, path, body) {
  return new Promise(function (res, rej) {
    const data = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: 'api.github.com',
      path: path,
      method: method,
      headers: Object.assign({
        'User-Agent': 'fetch-fc27-secrets',
        'Accept': 'application/vnd.github+json',
        'Authorization': 'Bearer ' + TOKEN,
      }, data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
    }, function (r) {
      let d = '';
      r.on('data', function (c) { d += c; });
      r.on('end', function () {
        if (r.statusCode >= 200 && r.statusCode < 300) {
          res(d ? JSON.parse(d) : {});
        } else {
          rej(new Error('HTTP ' + r.statusCode + ' ' + method + ' ' + path + ' → ' + d.slice(0, 300)));
        }
      });
    });
    req.on('error', rej);
    if (data) req.write(data);
    req.end();
  });
}

(async function () {
  console.log('仓库: ' + OWNER + '/' + REPO);
  console.log('凭证来源: ' + cred.source);

  const pk = await api('GET', '/repos/' + OWNER + '/' + REPO + '/actions/secrets/public-key');
  const keyId = pk.key_id;
  const pubKey = Buffer.from(pk.key, 'base64');

  const items = [
    ['TCB_ENV_ID', cred.ENV_ID],
    ['TCB_SECRET_ID', cred.SECRET_ID],
    ['TCB_SECRET_KEY', cred.SECRET_KEY],
  ];

  for (const pair of items) {
    const name = pair[0];
    const value = pair[1];
    const sealed = Buffer.from(sodium.seal(Buffer.from(value, 'utf8'), pubKey)).toString('base64');
    await api('PUT', '/repos/' + OWNER + '/' + REPO + '/actions/secrets/' + name, {
      encrypted_value: sealed,
      key_id: keyId,
    });
    console.log('  ✔ ' + name + ' 已更新（' + value.length + ' 字符）');
  }

  console.log('\n✔ 三个 Secrets 已同步。建议在 GitHub 网页上再核对一次更新时间。');
})().catch(function (e) {
  console.error('同步失败:', (e && e.message) || e);
  console.error('\n若是 403/404：令牌缺 repo 权限，或你不是该仓库的管理员。');
  process.exit(1);
});
