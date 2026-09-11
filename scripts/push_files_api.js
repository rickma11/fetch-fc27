// 用 GitHub REST API 把工作区的若干文件提交到远端 main（单次提交，不经过 git push）。
//
// 为什么需要它：
//   CI 每个工作日都会往 main 提交一次数据（snapshot/changes/facets，每周全量还会带上
//   players.json + details.json ≈76MB）。本机仓库因此经常与远端分叉 —— 此时 `git push`
//   会被拒（非快进），而 `git fetch` 又要拉下那几十 MB 数据。走 API 只提交「我改的这几个
//   代码文件」，既不拉数据也不产生分叉，几秒完成。
//
// 用法：
//   GH_TOKEN=xxx node scripts/push_files_api.js "<提交信息标题>" <文件1> [文件2 ...]
//
// 注意：提交信息标题建议写成 `标题 || 正文`，会把 || 之后的内容放在正文首行。
// 仓库名默认从 git remote origin 推断，可用 GH_REPO=owner/name 覆盖。

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const API = 'https://api.github.com';
const ROOT = path.resolve(__dirname, '..');

function token() {
  const t = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (!t) {
    console.error('缺少 GH_TOKEN（需 repo 权限的 PAT）');
    process.exit(1);
  }
  return t;
}

function repoSlug() {
  if (process.env.GH_REPO) return process.env.GH_REPO;
  const url = execSync('git remote get-url origin', { cwd: ROOT }).toString().trim();
  const m = url.match(/github\.com[:/]([^/]+\/[^/.]+)(\.git)?$/);
  if (!m) throw new Error('无法从 origin 推断仓库名，请用 GH_REPO=owner/name 指定：' + url);
  return m[1];
}

async function api(method, url, body, tok) {
  const res = await fetch(API + url, {
    method: method,
    headers: {
      'Authorization': 'Bearer ' + tok,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'fetch-fc27-push-api',
      ...(body ? { 'Content-Type': 'application/json' } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = { raw: text }; }
  if (!res.ok) {
    const msg = (data && (data.message || data.raw)) || res.statusText;
    throw new Error(method + ' ' + url + ' -> HTTP ' + res.status + ' : ' + msg);
  }
  return data;
}

(async () => {
  const argv = process.argv.slice(2);
  const message = argv[0];
  const files = argv.slice(1);
  if (!message || !files.length) {
    console.error('用法: node scripts/push_files_api.js "<提交标题>" <文件1> [文件2 ...]');
    process.exit(1);
  }

  const tok = token();
  const repo = repoSlug();
  // 注意：读引用用 /git/ref/，更新引用必须用复数 /git/refs/（写成单数会 404）
  const refRead = '/repos/' + repo + '/git/ref/heads/main';
  const refWrite = '/repos/' + repo + '/git/refs/heads/main';

  const ref = await api('GET', refRead, null, tok);
  const parentSha = ref.object.sha;
  const parent = await api('GET', '/repos/' + repo + '/git/commits/' + parentSha, null, tok);
  const baseTree = parent.tree.sha;
  console.log('远端 main =', parentSha.slice(0, 7), '|', parent.message.split('\n')[0].slice(0, 60));

  // 1) 上传每个文件的 blob（逐字节，UTF-8 中文注释不会损坏）
  const tree = [];
  for (const rel of files) {
    const abs = path.resolve(ROOT, rel);
    if (!fs.existsSync(abs)) throw new Error('文件不存在: ' + rel);
    const buf = fs.readFileSync(abs);
    const blob = await api('POST', '/repos/' + repo + '/git/blobs', {
      content: buf.toString('base64'),
      encoding: 'base64'
    }, tok);
    tree.push({ path: rel.replace(/\\/g, '/'), mode: '100644', type: 'blob', sha: blob.sha });
    console.log('  blob', rel.padEnd(28), blob.sha.slice(0, 8), Buffer.byteLength(buf) + ' bytes');
  }

  // 2) 基于远端现有 tree 建新 tree（只覆盖这几个文件，其余文件原样保留）
  const newTree = await api('POST', '/repos/' + repo + '/git/trees', {
    base_tree: baseTree,
    tree: tree
  }, tok);

  // 3) 建提交并推进 main
  const head = message.split('||');
  const commit = await api('POST', '/repos/' + repo + '/git/commits', {
    message: head[0].trim() + (head[1] ? '\n\n' + head[1].trim() : ''),
    tree: newTree.sha,
    parents: [parentSha]
  }, tok);
  await api('PATCH', refWrite, { sha: commit.sha, force: false }, tok);

  console.log('\n✔ 已提交', commit.sha.slice(0, 7), '->', repo + ' main');
  console.log('  ' + message.split('||')[0].trim());
})().catch(function (e) {
  console.error('\n✘ 失败:', e.message);
  process.exit(1);
});
