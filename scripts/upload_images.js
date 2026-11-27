// 把 images_out/ 里的球员图片上传到云存储 fc27/images/，并维护增量清单。
//
// 为什么用云存储而不是 GitHub / 图床：
//   小程序 <image> 加载网络图走的是 wx.downloadFile 的「downloadFile 合法域名」白名单，
//   而微信硬性要求这些域名必须经过 ICP 备案 —— GitHub / Gitee / jsDelivr 的域名都做不到
//   （Gitee 另有反盗链与禁用图床条款）。云存储的 cloud:// fileID 不走域名校验，
//   微信客户端原生支持，因此是小程序放图片的唯一省事通道。
//
// 增量与断点续传：
//   文件名只由 eaId + 类型决定；URL 里的内容 hash 变了 → 签名变 → 重新下载并覆盖上传。
//   清单 cloud-data/fc27/images.json 记录「每个 eaId 已完整上传到哪个签名」。
//   清单**边传边写**（每 FLUSH_EVERY 张落一次盘），所以哪怕任务超时被杀，
//   已完成的部分也已记账，下次运行只补剩下的，不会从头再来。
//
// 用法：node scripts/upload_images.js --ver 27
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const cloudbase = require('@cloudbase/node-sdk');
const { resolve } = require('./tcb_env');
const imgLib = require('./images');

const cred = resolve();
if (cred.missing.length) {
  console.error(cred.hint);
  process.exit(1);
}

function argVer() {
  const a = process.argv.find(x => x.startsWith('--ver='));
  if (a) return Number(a.slice(6));
  const i = process.argv.indexOf('--ver');
  return i >= 0 ? Number(process.argv[i + 1]) : 27;
}
const VER = argVer() || 27;
const ROOT = path.resolve(__dirname, '..');
const IMG_DIR = path.join(ROOT, 'images_out');
const TASK_FILE = path.join(IMG_DIR, '_tasks.json');
const CONC = Number(process.env.FC_IMG_UP_CONC || 10);
const FLUSH_EVERY = Number(process.env.FC_IMG_FLUSH || 200);
const MAX_TRY = 3;

const app = cloudbase.init({
  env: cred.ENV_ID,
  secretId: cred.SECRET_ID,
  secretKey: cred.SECRET_KEY,
  timeout: 120000
});

const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  if (!fs.existsSync(TASK_FILE)) {
    console.log('没有 images_out/_tasks.json（本次未下载图片），跳过');
    return;
  }
  const index = JSON.parse(fs.readFileSync(TASK_FILE, 'utf8'));
  const eaIds = Object.keys(index);
  const files = [];
  const owner = {};      // 文件名 -> eaId
  const remain = {};     // eaId -> 还没传成功的张数
  eaIds.forEach(id => {
    const names = Object.values(index[id].files);
    files.push.apply(files, names);
    remain[id] = names.length;
    names.forEach(n => { owner[n] = id; });
  });

  const bytesTotal = files.reduce((s, f) => {
    try { return s + fs.statSync(path.join(IMG_DIR, f)).size; } catch (e) { return s; }
  }, 0);
  console.log(`待上传 ${files.length} 个文件 / ${eaIds.length} 名球员 / ${Math.round(bytesTotal / 1048576)} MB`);
  if (!files.length) return;

  const manifest = imgLib.readManifest(VER);
  const doneEa = {};
  const doneFiles = new Set();
  let failed = 0, bytes = 0, sinceFlush = 0;

  // 卡面签名写回 DB（2026-11-27）：本次新换脸的人，签名图上传成功 ⇒ 立刻把 cardSig 写进
  //   players_fc27 文档 ⇒ 当天 roster 重建就能带上 ⇒ 端上当天拿到新图（不必等次日 CI）。
  //   ⚠️ 只在「该球员的签名图确实上传成功」时才写（doneEa 收录 = 该球员所有图都传完），
  //      否则库里会有签名但云端没图 ⇒ 端上破图。
  //   为什么需要这一步：落库用 doc(id).set() 整文档覆盖，真源 card_sigs.json 只能保证「不丢」，
  //   但「本次刚换脸」的真源要等上传成功才并入 ⇒ 若不直接写库，本次换脸要次日才生效。
  const pendingSigs = imgLib.readCardSigsPending(VER);
  const db = app.database();
  let dbSigWritten = 0;
  async function writeCardSigToDb(eaId) {
    const sig = pendingSigs[String(eaId)];
    if (!sig) return;
    try {
      await db.collection('players_fc' + VER).doc(String(eaId)).update({ cardSig: sig });
      dbSigWritten++;
    } catch (e) {
      // 写库失败不拖累上传主流程：真源里已有签名，下次 CI 的 fetch_futgg 会补上
      console.warn('  [签名] 写库失败 eaId=' + eaId, (e && e.message) || e);
    }
  }

  // 续传兜底：上传过程中把 images.json 清单实时推回 git，
  // 这样即便 job 在 timeout-minutes(300) 硬超时下被强杀（连 if:always() 步骤都不会执行），
  // 已上传的部分也已记账并入库，下次 run 只补剩下的，不会从头重来。
  // 仅在 GitHub Actions 环境生效；本地手动跑不触发 push（避免污染本地仓库）。
  const MANIFEST_REL = path.join('cloud-data', `fc${VER || 27}`, 'images.json');
  // 卡面签名真源（2026-11-27）：与 images.json 一起提交，保证「换过脸的人」这一信息不丢。
  const CARD_SIGS_REL = path.join('cloud-data', `fc${VER || 27}`, 'card_sigs.json');
  function gitCheckpoint() {
    if (process.env.GITHUB_ACTIONS !== 'true') return;
    try {
      cp.execSync('git config user.email "github-actions[bot]@users.noreply.github.com"', { cwd: ROOT, stdio: 'ignore' });
      cp.execSync('git config user.name "github-actions[bot]"', { cwd: ROOT, stdio: 'ignore' });
      cp.execSync(`git add ${MANIFEST_REL} ${CARD_SIGS_REL}`, { cwd: ROOT, stdio: 'ignore' });
      try {
        cp.execSync(`git commit -m "checkpoint: images.json auto-sync (ver ${VER})"`, { cwd: ROOT, stdio: 'ignore' });
      } catch (e) {
        return;   // 无变化可提交 → 无需 push
      }
      // ⚠️ 工作区还残留其它步骤刚写好的文件（snapshot.json / changes.json / sbcs.json /
      //    evolutions.json / facets.json…，最终 Commit version history 步骤要提交它们）。
      //    2026-09-18 踩坑：这里曾用 `git reset --hard HEAD`「清场」，把同一次 run 里
      //    scrape 出的 12 组 SBC、成型的 111 新球员快照全部丢弃 → 当天数据静默回退到前一天。
      //    改用 stash 暂存 → push → pop 归位：既保 rebase/push 干净，又不丢别人的改动。
      try { cp.execSync('git stash push -u -m "wip-img-checkpoint"', { cwd: ROOT, stdio: 'ignore' }); } catch (e) { }
      try {
        cp.execSync('git push origin HEAD:main', { cwd: ROOT, stdio: 'ignore' });
      } catch (e) {
        // 可能被 probe-futgg 并发推进 origin/main 导致 non-fast-forward，拉回再推一次
        try { cp.execSync('git pull --rebase origin main', { cwd: ROOT, stdio: 'ignore' }); } catch (e2) { }
        try { cp.execSync('git push origin HEAD:main', { cwd: ROOT, stdio: 'ignore' }); } catch (e3) { }
      }
      try { cp.execSync('git stash pop', { cwd: ROOT, stdio: 'ignore' }); } catch (e) { }
    } catch (e) {
      // 兜底失败绝不拖累上传主流程
    }
  }

  // 边传边记账：清单只在「某球员所有图都成功」时才收录，避免记下残缺状态
  function flush() {
    const merged = Object.assign({}, manifest, doneEa);
    const written = imgLib.writeManifest(VER, merged);
    // 卡面签名真源（2026-11-27）：某球员的**签名图确实上传成功**时，才把他的签名并入
    // card_sigs.json（git 跟踪的持久真源）。这样 fetch_futgg 无论增量还是 full 覆盖，
    // 都能从真源取到 cardSig ⇒ 不会因 doc(id).set() 整文档覆盖而丢失。
    // pending 里没被本次收录的（下载/上传失败）不并入 ⇒ 端上仍用旧图，绝不破图。
    const pending = imgLib.readCardSigsPending(VER);
    if (pending && Object.keys(pending).length) {
      const sigs = imgLib.readCardSigs(VER);
      let added = 0;
      for (const id of Object.keys(pending)) {
        // 该球员本次完整上传（doneEa 收录）⇒ 其签名图已在云端
        if (doneEa[id] !== undefined && sigs[id] !== pending[id]) { sigs[id] = pending[id]; added++; }
      }
      if (added) {
        imgLib.writeCardSigs(VER, sigs);
        console.log(`  [签名] 并入 card_sigs.json ${added} 人（真源共 ${Object.keys(sigs).length} 人）`);
      }
    }
    doneFiles.forEach(f => { try { fs.unlinkSync(path.join(IMG_DIR, f)); } catch (e) { } });
    console.log(`  [记账] 清单已更新 ${Object.keys(written).length} 人 | 本次完整 ${Object.keys(doneEa).length} 人 | 已传 ${Math.round(bytes / 1048576)} MB`);
    gitCheckpoint();
    return written;
  }

  async function uploadOne(fileName) {
    const buf = fs.readFileSync(path.join(IMG_DIR, fileName));
    const cloudPath = imgLib.cloudPathOf(fileName, VER);
    let lastErr = null;
    for (let i = 0; i < MAX_TRY; i++) {
      try {
        await app.uploadFile({ cloudPath, fileContent: buf });
        return buf.length;
      } catch (e) {
        lastErr = e;
        await sleep(1000 * (i + 1));
      }
    }
    throw lastErr;
  }

  let cursor = 0, finished = 0;
  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= files.length) return;
      const f = files[i];
      try {
        bytes += await uploadOne(f);
        doneFiles.add(f);
        const id = owner[f];
        remain[id]--;
        if (remain[id] === 0) {
          doneEa[id] = index[id].sig;
          // 该球员本轮全部文件上传成功（含签名图）⇒ 签名可写库，当天生效
          if (pendingSigs[String(id)]) await writeCardSigToDb(id);
        }
      } catch (e) {
        failed++;
        if (failed <= 5) console.log('  上传失败', f, (e && e.message) || e);
      }
      finished++;
      sinceFlush++;
      if (sinceFlush >= FLUSH_EVERY) { sinceFlush = 0; flush(); }
      if (finished % 500 === 0) {
        console.log('上传进度', finished, '/', files.length, '| 失败', failed, '| 已传', Math.round(bytes / 1048576), 'MB');
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONC, files.length) }, worker));

  flush();
  const complete = Object.keys(doneEa).length;
  console.log(`上传完成: 文件成功 ${doneFiles.size}/${files.length} | 失败 ${failed} | 本次完整球员 ${complete}/${eaIds.length}`);
  if (dbSigWritten) console.log(`  [签名] 已写库 cardSig ${dbSigWritten} 人（当天生效）`);

  if (failed) {
    console.error(`⚠️ 有 ${failed} 个文件上传失败，这些球员未计入清单，下次运行会自动重试`);
    process.exit(1);
  }
})().catch(e => {
  console.error('图片上传失败:', (e && e.message) || e);
  process.exit(1);
});
