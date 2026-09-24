// gen_squad_chem.js —— 生成阵型战术的「化学数据链」小文件（docs/18 §3.6.5）
//
// 产出：云存储 `squad/chem_v1_{VER}.{ts}.json` + meta 文档 `meta_fc{VER}/squad_chem`
//
// ⚠️⚠️ 为什么文件名必须带 ts（2026-09-21 实测发现，务必别改回固定名）：
//   云存储**按路径做了 CDN 缓存** —— 往**同一个** cloudPath 覆盖写入后，读回来的仍是旧内容。
//   实测（`scripts/_probe_m.js`，多进程 + 不同时间点复现）：
//     put v1 → get = v1 → put v2（同路径）→ 独立进程再 get **仍是 v1**；换一个新的路径 → 立刻拿到新内容。
//   本机复现细节：chem 文件 21:21 写入 → 22:14 用新内容覆盖 → 22:14/22:15/22:17 三次独立读取
//     拿到的都还是 21:21 的旧内容（`chem` 列 0 条、内嵌 ts 未变），而 meta 文档里的 ts 已是新的。
//   ⇒ 后果：端上 `wx.cloud.downloadFile` 走同一个存储域，**也会拿到旧文件**（且是静默的）。
//   ⇒ 解法：每次写入换一个新路径（ts 后缀），meta 文档指过去；旧路径再删掉（见文件末尾清理段）。
//     代价 = 每天多一个 ~370KB 文件（由一个 `meta_fc27` 保留 2 代的策略兜住，不会无限涨）。
//
// 形态（列式，四条数组等长，缺值一律 0）：
//   { ver, ts, count, eaIds:[...], club:[...], league:[...], nation:[...], chem:{ "<eaId>":[7元] } }
//   · 每人只要 **3 个数字**：`league.eaId` 在云库 19798/19798 全覆盖 ⇒ 不需要 club.leagueEaId；
//     `league.nationEaId` 也进全局表（data/managerOptions.js），不 per-player 存。
//   · 键名短、列式而非对象数组 —— 省的是 19798 次重复键名。
//   · `chem` = **稀疏对象**（只有约 500 张特殊卡有档案，约 20KB）：键 eaId，值 =
//     [full, exClub, exLeague, exNation, sqClub, sqLeague, sqNation]（见 chemEngine.js 顶部 ⚠️③）。
//     来源：优先 roster 的球员级 `chem` 字段；缺失时用 `facets.json#rarityChem[rarity.eaId]` 兜底
//     （roster 的 chem 要靠一次 full 全量跑才回填，facets 每次 run 都从完整列表重算 ⇒ 立刻可用）。
//
// ⚠️ 为什么独立成文件而不并进 roster：见 docs/18 §3.6.1。一句话 —— roster 15.81MB 刚被判过
//    UserNetworkTooSlow，不该让不下阵型战术的人也白吃 +1.1MB，且化学字段当前云库 0/19798 还没成形。
//
// ⚠️ 写库用 `doc(...).set()`（单文档元数据，整文档替换是对的）；**绝不能用**
//    `.update({data:{...}})` —— 那是把 `data` 当字段名的假成功写法（硬规则 32）。
//
// 用法：node scripts/gen_squad_chem.js   （每日 CI 在 Warm up roster 之后跑；continue-on-error）
const path = require('path');
process.chdir(path.resolve(__dirname));
const { resolve } = require('./tcb_env');

const VER = 27;
const COL = 'players_fc' + VER;
const M_COL = 'meta_fc' + VER;
const M_DOC = 'squad_chem';
// ⚠️ 只有「前缀」是固定的；真正的 cloudPath 每次带 ts（见文件头 ⚠️⚠️：云存储按路径缓存，同路径覆盖读不到新内容）
const CLOUD_PATH_BASE = 'squad/chem_v1_' + VER;
const MIN_COUNT = 19000;   // 安全闸：疑似拉取不完整就拒绝写库（对齐 warm_roster.js）

(async () => {
  const cred = resolve();
  if (cred.missing && cred.missing.length) {
    console.error(cred.hint);
    process.exit(1);
  }
  const cloudbase = require('@cloudbase/node-sdk');
  const app = cloudbase.init({ env: cred.ENV_ID, secretId: cred.SECRET_ID, secretKey: cred.SECRET_KEY, timeout: 120000 });
  const db = app.database();

  // 1) 只读需要的字段（eaId + 三个 eaId + rarity.eaId + chem），分页与 warm_roster.js 同法同坑（100/页）
  const proj = { eaId: true, 'club.eaId': true, 'league.eaId': true, 'nation.eaId': true, 'rarity.eaId': true, chem: true };
  const eaIds = [], club = [], league = [], nation = [], chem = {};
  let skip = 0, nClub = 0, nLeague = 0, nNation = 0, nChem = 0, nChemFallback = 0;
  const t0 = Date.now();
  // 兜底表：facets.json 每次 run 都从**完整列表**重算并提交 git（CI 与本脚本同一工作区）。
  // 缺它时（老快照 / 本地手动跑且没生成过 facets）降级为「不做稀有度兜底」，不影响主数据。
  let rarityChem = {};
  try {
    const fp = path.join(__dirname, '..', 'cloud-data', 'fc' + VER, 'facets.json');
    const fx = JSON.parse(require('fs').readFileSync(fp, 'utf8'));
    if (fx && fx.rarityChem && typeof fx.rarityChem === 'object') rarityChem = fx.rarityChem;
    console.log('rarity 化学兜底表：facets.json 命中', Object.keys(rarityChem).length, '个稀有度');
  } catch (e) {
    console.log('rarity 化学兜底表：facets.json 不可用（' + String((e && e.message) || e).slice(0, 60) + '）→ 仅用 roster 球员级 chem');
  }
  while (true) {
    const r = await db.collection(COL).field(proj).skip(skip).limit(100).get();
    const d = (r && r.data) || [];
    if (!d.length) break;
    for (let i = 0; i < d.length; i++) {
      const p = d[i];
      const id = Number(p.eaId) || 0;
      if (!id) continue;                       // 无主键的脏数据直接丢（不进表）
      const c = (p.club && Number(p.club.eaId)) || 0;
      const l = (p.league && Number(p.league.eaId)) || 0;
      const nt = (p.nation && Number(p.nation.eaId)) || 0;
      eaIds.push(id); club.push(c); league.push(l); nation.push(nt);
      if (c) nClub++;
      if (l) nLeague++;
      if (nt) nNation++;
      // 化学档案：球员级优先，缺则按 rarity.eaId 查兜底表
      let prof = Array.isArray(p.chem) ? p.chem : null;
      if (!prof) {
        const rid = p.rarity && p.rarity.eaId;
        if (rid != null && rarityChem[rid]) { prof = rarityChem[rid]; nChemFallback++; }
      }
      if (prof) {
        let any = false;
        const v = [];
        for (let k = 0; k < 7; k++) { const x = Number(prof[k]) || 0; v.push(x); if (x) any = true; }
        if (any) { chem[id] = v; nChem++; }
      }
    }
    if (d.length < 100) break;
    skip += 100;
  }
  const count = eaIds.length;
  console.log('fetched', count, 'players in', ((Date.now() - t0) / 1000).toFixed(1) + 's');
  console.log('  有 club.eaId  :', nClub, '（无 = 无俱乐部；Icon/Hero 列表层不带 club ⇒ 恒 0）');
  console.log('  有 league.eaId:', nLeague);
  console.log('  有 nation.eaId:', nNation);
  console.log('  有化学档案    :', nChem, '（其中来自 facets 兜底 ' + nChemFallback + '）');
  if (count < MIN_COUNT) {
    console.error('安全闸：球员数 ' + count + ' < ' + MIN_COUNT + '，疑似拉取不完整，拒绝写库（避免半截数据覆盖好数据）');
    process.exit(1);
  }
  if (!nLeague) {
    console.error('安全闸：league.eaId 一条都没有 —— 说明上游字段没落库，写出去等于全队 0 化学，拒绝写库');
    process.exit(1);
  }

  // 2) 拼列式 → 上传云存储（3 次重试；文件仅 ~380KB，不会踩 UserNetworkTooSlow）
  //    化学档案软闸：今日应有约 500 张特殊卡有档案（Icon 272 + Hero 174 + HoF 21 + Partnerships 5 …）。
  //    为 0 说明上游 chem 采集/落库断了 —— 不 abort（chem 只是附加信息，文件本身仍可用），但必须吼出来。
  if (!nChem) console.warn('⚠️ 化学档案条数为 0 —— 上游 pickPlayer#chem / facets#rarityChem 可能断了（端上会全部走稀有度兜底表）');

  // 1.5) 先读旧 meta，记下上一代的 fileID —— 新版写完后删它（保持「最多 2 代」）
  let prevFileID = null;
  try {
    const old = await db.collection(M_COL).doc(M_DOC).get();
    const od = Array.isArray(old && old.data) ? old.data[0] : (old && old.data);
    if (od && od.fileID) prevFileID = od.fileID;
  } catch (e) { /* 首次运行没有旧文档，正常 */ }

  const ts = Date.now();
  const payload = { ver: String(VER), ts: ts, count: count, eaIds: eaIds, club: club, league: league, nation: nation, chem: chem };
  const buf = Buffer.from(JSON.stringify(payload));
  // ⚠️ 路径必须带 ts：云存储按路径缓存，同路径覆盖读不到新内容（见文件头 ⚠️⚠️）
  const cloudPath = CLOUD_PATH_BASE + '.' + ts + '.json';
  console.log('payload size:', (buf.length / 1024).toFixed(1) + 'KB', '(uncompressed)', '| chem', nChem, '条');
  console.log('cloudPath =', cloudPath, prevFileID ? '(将替换上一代)' : '(首次)');

  let up = null, lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      up = await app.uploadFile({ cloudPath: cloudPath, fileContent: buf });
      break;
    } catch (e) {
      lastErr = e;
      console.log('uploadFile 第' + attempt + '/3 次失败:', String((e && e.message) || e));
      if (attempt < 3) await new Promise(r => setTimeout(r, 5000 * attempt));
    }
  }
  if (!up) throw lastErr;
  console.log('uploaded fileID =', up.fileID);

  // 3) 写元文档（单文档整替换 → set 是对的；update({data:...}) 才是假成功写法）
  await db.collection(M_COL).doc(M_DOC).set({ fileID: up.fileID, ts: ts, count: count, ver: String(VER), prevFileID: prevFileID });
  console.log('meta doc written:', M_COL + '/' + M_DOC, 'ts=' + ts, '(' + new Date(ts).toISOString() + ')');

  // 3.5) 删掉上一代文件（meta 已切到新路径 ⇒ 端上不会再取它）。
  //      留「当前 + 上一代」两代：万一刚切完就有客户端拿着旧 meta 下载，也还有一份在。
  //      注意必须在 meta 写成功之后删，顺序反了会留下指向已删文件的 meta。
  if (prevFileID && prevFileID !== up.fileID) {
    try {
      await app.deleteFile({ fileList: [prevFileID] });
      console.log('已清理上一代文件:', prevFileID.split('/').slice(-1)[0]);
    } catch (e) {
      console.log('清理上一代失败（不致命，最多多留一个文件）:', String((e && e.message) || e).slice(0, 120));
    }
  }

  // 4) 端到端验证：读回 meta 文档 + 调线上 squad_meta，确认端上能拿到同一个 fileID
  try {
    const back = await db.collection(M_COL).doc(M_DOC).get();
    const doc = Array.isArray(back && back.data) ? back.data[0] : (back && back.data);
    if (doc && doc.fileID === up.fileID && doc.count === count) {
      console.log('READ-BACK OK: meta_fc' + VER + '/' + M_DOC + ' fileID/count 一致');
    } else {
      console.error('READ-BACK FAIL: 回读不一致 →', JSON.stringify(doc).slice(0, 200));
      process.exit(1);
    }
  } catch (e) {
    console.error('READ-BACK FAIL:', String((e && e.message) || e));
    process.exit(1);
  }
  // 4.5) 内容级校验：真把刚上传的文件下回来，核对 ts 与 chem 条数。
  //      ⚠️ 这一条专治「写进去但读出来还是旧的」（云存储按路径缓存；即便改了 ts 路径，也要有断言兜底）。
  try {
    const dl = await app.downloadFile({ fileID: up.fileID });
    const got = JSON.parse(dl.fileContent.toString('utf8'));
    const gotChem = got.chem ? Object.keys(got.chem).length : 0;
    if (got.ts !== ts || got.count !== count || gotChem !== nChem) {
      console.error('CONTENT FAIL: 回读内容与新写不符 → 内嵌 ts=' + got.ts + '(期望 ' + ts + ') count=' + got.count +
        '(期望 ' + count + ') chem=' + gotChem + '(期望 ' + nChem + ')。多半是路径缓存问题。');
      process.exit(1);
    }
    console.log('CONTENT OK: 回读 ' + (dl.fileContent.length / 1024).toFixed(1) + 'KB，ts/count/chem(' + gotChem + ') 全一致');
  } catch (e) {
    console.error('CONTENT FAIL:', String((e && e.message) || e).slice(0, 160));
    process.exit(1);
  }

  try {
    const rf = await app.callFunction({ name: 'squad_meta', data: { version: String(VER) } });
    const res = (rf && (rf.result || rf.data)) || null;
    if (res && res.code === 0 && res.fileID) {
      console.log('VERIFY OK: squad_meta 命中, count=' + res.count + ', ts=' + res.ts);
    } else {
      console.log('VERIFY WARN: squad_meta 未命中 →', JSON.stringify(res).slice(0, 200));
      console.log('  （若是 code=1/-1 或函数不存在：需先把 cloudfunctions/squad_meta 整目录上传部署）');
    }
  } catch (e) {
    console.log('VERIFY SKIP: callFunction 不可用（' + String((e && e.message) || e).slice(0, 100) + '）——meta 已写，部署后即可用');
  }
})().catch(e => { console.error('FATAL', String((e && e.message) || e)); process.exit(1); });
