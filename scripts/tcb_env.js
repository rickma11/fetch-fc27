// 统一解析云开发凭证（CI 与本地共用）。
//
// 优先级：
//   1. 环境变量 TCB_ENV_ID / TCB_SECRET_ID / TCB_SECRET_KEY   （CI 由 GitHub Secrets 注入）
//   2. 仓库根目录 .env.local        （本机用，KEY=VALUE 一行一个，已 gitignore）
//   3. 仓库根目录 .tcb.local.json   （本机用，{"envId","secretId","secretKey"}，已 gitignore）
//
// 为什么要有 2/3：本地手打三条 $env: 只在当前 PowerShell 窗口有效，关窗即失效，
// 且容易进命令历史。改成写一次本地文件，之后直接 node scripts/xxx.js 即可。
//
// 注意：这两个本地文件绝不能提交进仓库（.gitignore 已覆盖），也不要贴进聊天记录。
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

function loadDotEnv(file) {
  if (!fs.existsSync(file)) return {};
  const out = {};
  fs.readFileSync(file, 'utf8').split(/\r?\n/).forEach(function (line) {
    const s = line.trim();
    if (!s || s.charAt(0) === '#') return;
    const i = s.indexOf('=');
    if (i < 0) return;
    const k = s.slice(0, i).trim();
    let v = s.slice(i + 1).trim();
    if ((v.charAt(0) === '"' && v.slice(-1) === '"') || (v.charAt(0) === "'" && v.slice(-1) === "'")) {
      v = v.slice(1, -1);
    }
    if (k) out[k] = v;
  });
  return out;
}

function loadJson(file) {
  if (!fs.existsSync(file)) return {};
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return {
      TCB_ENV_ID: j.TCB_ENV_ID || j.envId,
      TCB_SECRET_ID: j.TCB_SECRET_ID || j.secretId,
      TCB_SECRET_KEY: j.TCB_SECRET_KEY || j.secretKey,
    };
  } catch (e) {
    return {};
  }
}

function resolve() {
  const sources = [
    ['环境变量', process.env],
    ['.env.local', loadDotEnv(path.join(ROOT, '.env.local'))],
    ['.tcb.local.json', loadJson(path.join(ROOT, '.tcb.local.json'))],
  ];
  const pick = function (key) {
    for (const pair of sources) {
      const src = pair[1];
      if (src && src[key]) return { value: src[key], from: pair[0] };
    }
    return { value: undefined, from: null };
  };
  const env = pick('TCB_ENV_ID');
  const sid = pick('TCB_SECRET_ID');
  const skey = pick('TCB_SECRET_KEY');
  const missing = [];
  if (!env.value) missing.push('TCB_ENV_ID');
  if (!sid.value) missing.push('TCB_SECRET_ID');
  if (!skey.value) missing.push('TCB_SECRET_KEY');
  return {
    ENV_ID: env.value,
    SECRET_ID: sid.value,
    SECRET_KEY: skey.value,
    missing: missing,
    source: missing.length ? null : env.from,
    hint: [
      '未找到云开发凭证：' + missing.join(' / '),
      '',
      '两种填法（选一种即可）：',
      '  ① 本地文件（推荐，只填一次）：在仓库根目录新建 .env.local，内容三行 ——',
      '       TCB_ENV_ID=你的环境ID',
      '       TCB_SECRET_ID=你的SecretId',
      '       TCB_SECRET_KEY=你的SecretKey',
      '  ② PowerShell 当前窗口临时设置：',
      '       $env:TCB_ENV_ID="你的环境ID"; $env:TCB_SECRET_ID="xx"; $env:TCB_SECRET_KEY="yy"',
      '',
      '注意：.env.local 与 .tcb.local.json 已被 .gitignore 覆盖，不会进仓库；也请不要贴进聊天或截图。',
    ].join('\n'),
  };
}

module.exports = { resolve };
