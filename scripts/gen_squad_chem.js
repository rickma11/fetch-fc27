// gen_squad_chem.js —— 生成阵型战术的「化学数据链」小文件（docs/18 §3.6.5）
//
// 产出：云存储 `squad/chem_v1_{VER}.json` + meta 文档 `meta_fc{VER}/squad_chem`
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
const CLOUD_PATH = 'squad/chem_v1_' + VER + '.json';
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
  const ts = Date.now();
  const payload = { ver: String(VER), ts: ts, count: count, eaIds: eaIds, club: club, league: league, nation: nation, chem: chem };
  const buf = Buffer.from(JSON.stringify(payload));
  console.log('payload size:', (buf.length / 1024).toFixed(1) + 'KB', '(uncompressed)', '| chem', nChem, '条');

  let up = null, lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      up = await app.uploadFile({ cloudPath: CLOUD_PATH, fileContent: buf });
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
  await db.collection(M_COL).doc(M_DOC).set({ fileID: up.fileID, ts: ts, count: count, ver: String(VER) });
  console.log('meta doc written:', M_COL + '/' + M_DOC, 'ts=' + ts, '(' + new Date(ts).toISOString() + ')');

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
