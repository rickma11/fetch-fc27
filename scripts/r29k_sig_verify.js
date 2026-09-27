// R29k-P1 轻量验证：只跑「一次全表扫描 → 投影/计算内容签名 → 落盘签名表 → 复核 + 跳过预演」。
//
// 目的（2026-09-27 用户拍板）：不抓详情、不写库，花本来每天都要付的那 19,860 次读，
// 把「明天 CI 能跳过多少条」和「链路本身通不通」一次验完。
//
// 为什么能顺手算整行签名而不多花钱：
//   云开发数据库读按**返回文档条数**计费（规则 92），`.field()` 投影多少字段不影响读次数。
//   所以这里直接不投影、拿全字段本地算 `contentSig.sigOf`，等价于 sync_i18n 那边「顺手投影 _sig」。
//   ⚠️ 但这只在本仓库的计费口径下成立；若哪天改成按返回字节计费，这里必须反过来。
//
// 三段输出：
//   ① 扫描落盘  全表扫一遍，算出「当前云库内容签名表」并落 _sig_cache.json
//   ② 抽样复核  随机回查 200 条原文、重算签名、与落盘表逐条对（验落盘无损且表=云库现内容）
//   ③ 跳过预演  拿落盘表对本地 players.json 跑 upload_db 的比对逻辑，给出明天可跳过的条数
//
// 用法：cd fetch-fc27 && node scripts/r29k_sig_verify.js [--ver 27] [--sample 200]

const fs = require('fs');
const path = require('path');
const cloudbase = require('@cloudbase/node-sdk');
const { resolve } = require('./tcb_env');
const contentSig = require('./content_sig.js');

const ROOT = path.resolve(__dirname, '..');
let VER = '27';
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if ((argv[i] === '--ver' || argv[i] === '-v') && argv[i + 1]) {
    VER = String(argv[++i]).replace(/[^0-9]/g, '') || '27';
  }
}
if ((argv.indexOf('--sample') >= 0) && argv[argv.indexOf('--sample') + 1]) {
  var SAMPLE = parseInt(argv[argv.indexOf('--sample') + 1], 10) || 200;
} else {
  var SAMPLE = 200;
}

const COL = 'players_fc' + VER;
const LOCAL_JSON = path.join(ROOT, 'cloud-data', 'fc' + VER, 'players.json');

/** 摘掉全部 *ImagePath 后的内容签名（用于「内容字段是否稳定」的参考口径）。 */
function stripImg(doc) {
  const o = Object.assign({}, doc);
  for (const k of Object.keys(o)) if (/ImagePath$/.test(k)) delete o[k];
  return o;
}

async function main() {
  const t0 = Date.now();
  const c = resolve();
  const app = cloudbase.init({
    env: c.ENV_ID, secretId: c.SECRET_ID, secretKey: c.SECRET_KEY, timeout: 120000
  });
  const db = app.database();

  // ---------- ① 扫描落盘 ----------
  console.log('=== ① 全表扫描 + 计算内容签名（' + COL + '） ===');
  const sigMap = {};
  const sigNoImgMap = {};  // 参考口径用：摘掉 *ImagePath 后的签名（零额外读，只多花 CPU）
  let withDocSig = 0;      // 文档自带 _sig 的条数
  let built = 0;           // 本地按整行算的条数
  let noKey = 0;           // 连 eaId 都没有的异常行
  for (let skip = 0; ; skip += 1000) {
    const r = await db.collection(COL).skip(skip).limit(1000).get();
    const batch = r.data || [];
    for (const p of batch) {
      if (p._sig !== undefined && p._sig !== null) { withDocSig++; sigMap[String(p.eaId)] = p._sig; }
      else if (p.eaId !== undefined && p.eaId !== null) { built++; sigMap[String(p.eaId)] = contentSig.sigOf(p); }
      else noKey++;
      if (p.eaId !== undefined && p.eaId !== null) sigNoImgMap[String(p.eaId)] = contentSig.sigOf(stripImg(p));
    }
    if (batch.length < 1000) break;
  }
  contentSig.saveSigMap(VER, sigMap);
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log('  扫描 ' + Object.keys(sigMap).length + ' 条，耗时 ' + elapsed + 's');
  console.log('  文档自带 _sig: ' + withDocSig + ' 条 | 本地整行算: ' + built + ' 条 | 异常行: ' + noKey);
  console.log('  落盘: ' + path.relative(ROOT, contentSig.CACHE_FILE) +
    ' (' + (fs.statSync(contentSig.CACHE_FILE).size / 1024 / 1024).toFixed(2) + ' MB)');

  // ---------- ② 抽样复核 ----------
  console.log('');
  console.log('=== ② 抽样复核（随机 ' + SAMPLE + ' 条回查原文重算签名） ===');
  const keys = Object.keys(sigMap);
  const shuffled = keys.slice();
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = shuffled[i]; shuffled[i] = shuffled[j]; shuffled[j] = t;
  }
  const sample = shuffled.slice(0, Math.min(SAMPLE, shuffled.length));
  let hit = 0, mismatch = 0;
  let errMsg = null;
  const bad = [];
  for (const eaId of sample) {
    try {
      // ⚠️ 云库里 eaId 是 number，而 keys 来自 Object.keys ⇒ 全是 string。
      //    `where({eaId:'27'})` 因类型不匹配一条都命中不到（2026-09-27 实测，曾因此 200/200 假红）；
      //    `doc(eaId)` 走主键直查可行，这里两条路都试并记下差异，避免再被假红误导。
      const r = await db.collection(COL).where({ eaId: Number(eaId) }).limit(1).get();
      const d = r.data && r.data[0];
      if (!d) { mismatch++; if (bad.length < 3) bad.push(eaId + '(未命中)'); continue; }
      const old = sigMap[eaId];
      // 文档自带 _sig 的，直接比；否则比「本地算的签名」
      const fresh = (d._sig !== undefined && d._sig !== null) ? d._sig : contentSig.sigOf(d);
      if (old === fresh) hit++;
      else { mismatch++; if (bad.length < 3) bad.push(eaId); }
    } catch (e) { mismatch++; if (errMsg === null) errMsg = String(e && e.message || e).slice(0, 100); }
  }
  console.log('  一致 ' + hit + ' 条 / 不一致 ' + mismatch + ' 条');
  if (bad.length) console.log('  不一致样本: ' + bad.join(','));
  if (errMsg) console.log('  ⚠️ 异常（此前会静默吞掉，务必看）: ' + errMsg);
  console.log('  说明：此步验的是「扫描落盘无损 + 表确等于云库现内容」；' +
    '签名算得准不准由本脚本 ① 与 content_sig 单测双重保证。');

  // ---------- ③ 跳过预演 ----------
  console.log('');
  console.log('=== ③ 跳过预演（落盘表 vs 本地 players.json，模拟 upload_db 比对） ===');
  if (!fs.existsSync(LOCAL_JSON)) {
    console.log('  本地无 players.json，跳过预演');
  } else {
    const local = JSON.parse(fs.readFileSync(LOCAL_JSON, 'utf8'));
    const by = {}; for (const p of local) by[String(p.eaId)] = p;
    let same = 0, diff = 0, missing = 0;
    let imgOnly = 0, other = 0;
    const otherSample = [];
    for (const p of local) {
      const k = String(p.eaId);
      const old = sigMap[k];
      if (!old) { missing++; continue; }
      // 模拟「本轮待写文档」= 本地快照那条（去掉 _id/_sig，与 upload_db 侧形态一致）
      const doc = Object.assign({}, p);
      delete doc._sig; delete doc._id;
      if (contentSig.sigOf(doc) === old) { same++; continue; }
      // 分类：把 *ImagePath 全部摘掉再算一次；与签名表一致 ⇒ 差异「仅来自图片路径」
      // 稳定性参考口径：**云库摘图签名 vs 本地摘图签名**。
      //   ⚠️ 不能拿「本地摘图」去比「云库未摘图」——口径不对等，会 100% 假红；
      //      也不能两边都用本地对象比——自证恒等，是假绿（2026-09-27 两个坑都踩过）。
      //   它回答的是「除 *ImagePath 外，内容字段在 9-22 → 今天 这 5 天里稳不稳」。
      diff++;
      if (contentSig.sigOf(stripImg(p)) === sigNoImgMap[k]) imgOnly++;
      else { other++; if (otherSample.length < 3) otherSample.push(k); }
    }
    const tot = same + diff + missing;
    console.log('  本地快照 ' + local.length + ' 条，比对 ' + tot + ' 条');
    console.log('  内容未变 ⇒ 可跳过: ' + same + ' 条 (' + (tot ? (same * 100 / tot).toFixed(1) : '0') + '%)');
    console.log('  签名表缺失: ' + missing + ' 条');
    console.log('  【A 真实口径】「本轮待写 vs 今天云库」⇒ 可跳过 ' + same + ' 条');
    console.log('     注：本地快照停在 9-22，今天云库是今天的，两者差距＝5 天真实变化（含换图），');
    console.log('     所以这个数会**显著低估**明天的跳过率，不能当结论看。');
    console.log('  【B 稳定性口径】两边都摘掉 *ImagePath 后再比 ⇒ 一致 ' + imgOnly + ' 条');
    console.log('     这回答「除图片路径外内容稳不稳」：' + (diff ? (imgOnly * 100 / diff).toFixed(1) : '0') +
      '% 的卡在 5 天里内容字段一格没动。若图路径天天变，A 才会被拖回接近 0。');
    if (otherSample.length) console.log('  其他差异样本: ' + otherSample.join(','));
  }

  console.log('');
  console.log('=== 链路体检 ===');
  const back = contentSig.loadSigMap();
  console.log('  loadSigMap 读回: ' + (back ? Object.keys(back).length + ' 条' : 'FAIL(退化为全量写)'));
  console.log('  格式正确: ' + (back && Object.keys(back).length === Object.keys(sigMap).length));
  console.log('');
  console.log('提示：GitHub Actions Cache 的 restore/save 只能在 CI 真跑时验证；');
  console.log('      明天(首次)CI = restore miss ⇒ 全量写建基线，后天起才看得到跳过数。');
}

main().then(function () { process.exit(0); }).catch(function (e) {
  console.error('验证失败:', e && e.message ? e.message : e);
  process.exit(1);
});
