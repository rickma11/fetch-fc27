#!/usr/bin/env node
/**
 * 经 GitHub Contents API 推送本地文件到 main（单文件 PUT，自带 sha 更新）。
 *
 * 为什么不用 git / scripts/push_files_api.js：
 *   - 本地 git 常年落后 origin，推不动；
 *   - PowerShell → node argv 传中文会乱码，故**提交信息从文件读**（UTF-8）。
 *
 * 用法（在仓库根目录）：
 *   node scripts/git_push_files.js <消息文件> <相对路径1> [相对路径2 ...]
 *
 * 示例：
 *   echo "修复 xxx" > /tmp/msg.txt
 *   node scripts/git_push_files.js /tmp/msg.txt scripts/fetch_ci.js scripts/upload_db.js
 *
 * token 从 <repo>/.gh_token.txt 读取（40 字符 classic PAT，不回显）。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
if (argv.length < 2) {
  console.error('用法: node scripts/git_push_files.js <消息文件> <相对路径1> [相对路径2 ...]');
  process.exit(1);
}
const msgFile = path.resolve(argv[0]);
const files = argv.slice(1);

if (!fs.existsSync(msgFile)) { console.error('消息文件不存在: ' + msgFile); process.exit(1); }
const msg = fs.readFileSync(msgFile, 'utf8').trim();
const tk = fs.readFileSync(path.join(ROOT, '.gh_token.txt'), 'utf8').trim();

const API = 'https://api.github.com/repos/rickma11/fetch-fc27/contents/';
const H = {
  'Authorization': 'Bearer ' + tk,
  'Accept': 'application/vnd.github+json',
  'User-Agent': 'workbuddy-node',
  'X-GitHub-Api-Version': '2022-11-28',
  'Content-Type': 'application/json'
};

(async () => {
  let fail = 0;
  for (const rel of files) {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) { console.log('SKIP ' + rel + '（本地不存在）'); fail++; continue; }
    const content = fs.readFileSync(abs, 'utf8');
    const b64 = Buffer.from(content, 'utf8').toString('base64');
    let sha = null;
    try {
      const g = await fetch(API + rel + '?ref=main', { headers: H });
      if (g.ok) { const j = await g.json(); sha = j.sha; }
    } catch (e) { /* 取不到 sha 视为新文件 */ }
    const body = { message: msg, content: b64, branch: 'main' };
    if (sha) body.sha = sha;
    try {
      const r = await fetch(API + rel, { method: 'PUT', headers: H, body: JSON.stringify(body) });
      const j = await r.json();
      if (r.ok) console.log('OK   ' + rel + '  sha=' + (j.content && j.content.sha));
      else { console.log('FAIL ' + rel + '  HTTP ' + r.status + ' ' + (j.message || '')); fail++; }
    } catch (e) { console.log('FAIL ' + rel + '  ' + e.message); fail++; }
  }
  process.exit(fail ? 1 : 0);
})();
