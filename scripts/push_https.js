// 纯 HTTPS（https 模块 + 重试）把文件提交到远端 main —— push_files_api.js 走 execSync/git，
// 在沙箱里会 spawnSync cmd.exe EBUSY；本脚本零子进程，只调 GitHub REST API。
// 用法：GH_TOKEN=xxx node scripts/push_https.js "提交信息" <文件1> [文件2 ...]
const https = require('https');
const fs = require('fs');
const TOKEN = process.env.GH_TOKEN;
const REPO = process.env.GH_REPO || 'rickma11/fetch-fc27';
const BRANCH = process.env.GH_BRANCH || 'main';
const msg = process.argv[2] || 'chore: update files';
const files = process.argv.slice(3);
if (!TOKEN) { console.error('缺 GH_TOKEN'); process.exit(1); }
if (!files.length) { console.error('缺文件列表'); process.exit(1); }

function req(method, p, body) {
  return new Promise((res, rej) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const r = https.request({
      hostname: 'api.github.com', path: p, method,
      headers: Object.assign({
        Authorization: `Bearer ${TOKEN}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'push-https'
      }, data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {})
    }, resp => {
      let d = ''; resp.on('data', c => d += c);
      resp.on('end', () => {
        if (resp.statusCode >= 300) return rej(new Error(`${method} ${p} → ${resp.statusCode} ${d.slice(0, 200)}`));
        try { res(d ? JSON.parse(d) : {}); } catch (e) { res({}); }
      });
    });
    r.on('error', rej);
    if (data) r.write(data);
    r.end();
  });
}
async function R(method, p, body, tries) {
  let last;
  for (let i = 0; i < (tries || 5); i++) {
    try { return await req(method, p, body); } catch (e) { last = e; await new Promise(r => setTimeout(r, 3000)); }
  }
  throw last;
}
(async () => {
  const ref = await R('GET', `/repos/${REPO}/git/ref/heads/${BRANCH}`);
  const baseSha = ref.object.sha;
  console.log(`远端 ${BRANCH} = ${baseSha.slice(0, 7)}`);
  const commit = await R('GET', `/repos/${REPO}/git/commits/${baseSha}`);
  const baseTree = commit.tree.sha;
  const tree = [];
  for (const f of files) {
    const content = fs.readFileSync(f, 'utf8');
    const blob = await R('POST', `/repos/${REPO}/git/blobs`, { content, encoding: 'utf-8' });
    tree.push({ path: f.replace(/\\/g, '/'), mode: '100644', type: 'blob', sha: blob.sha });
    console.log('  blob', f, blob.sha.slice(0, 7), content.length, 'bytes');
  }
  const nt = await R('POST', `/repos/${REPO}/git/trees`, { base_tree: baseTree, tree });
  const nc = await R('POST', `/repos/${REPO}/git/commits`, { message: msg, tree: nt.sha, parents: [baseSha] });
  await R('PATCH', `/repos/${REPO}/git/refs/heads/${BRANCH}`, { sha: nc.sha });
  console.log(`✔ 已提交 ${nc.sha.slice(0, 7)} -> ${REPO} ${BRANCH}\n  ${msg}`);
})().catch(e => { console.error('✘', e.message); process.exit(1); });
