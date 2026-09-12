// run 进度探针：CI 的图片上传步骤没有可读的实时日志（in_progress 时 logs API 返回 404），
// 所以改为「直接问云存储」—— 抽查一批 eaId 的卡面是否存在，反推上传完成比例。
// 用法：node scripts/probe_progress.js [样本数，默认200]
const cloudbase = require('@cloudbase/node-sdk');
const { resolve } = require('./tcb_env');

const SAMPLE = Number(process.argv[2] || 200);
const cred = resolve();
if (cred.missing.length) {
  console.error(cred.hint);
  process.exit(1);
}

const app = cloudbase.init({
  env: cred.ENV_ID,
  secretId: cred.SECRET_ID,
  secretKey: cred.SECRET_KEY,
  timeout: 120000
});

const idx = app.database();
const VER = '27';

(async () => {
  console.log('环境:', cred.ENV_ID, '| 凭证来源:', cred.source);
  console.log();

  // 1) 数据库落库结果（run 的第 11 步）独立复核
  for (const col of ['players_fc' + VER, 'details_fc' + VER, 'meta_fc' + VER]) {
    try {
      const c = await idx.collection(col).count();
      console.log(`DB ${col}: ${c.total} 条`);
    } catch (e) {
      console.log(`DB ${col}: 查询失败 -> ${(e && e.message) || e}`);
    }
  }
  console.log();

  // 2) 取 fileID 前缀（上传一个探针文件，读出真实 fileID 形状，再删掉）
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64'
  );
  const up = await app.uploadFile({ cloudPath: `fc27/images/_probe_${Date.now()}.png`, fileContent: png });
  const PREFIX = up.fileID.slice(0, up.fileID.indexOf('fc27/images/'));
  console.log('fileID 前缀 =', PREFIX);
  await app.deleteFile({ fileList: [up.fileID] });

  // 3) 拉 eaId 列表（分页 1000），等距抽样
  const ids = [];
  for (let skip = 0; ; skip += 1000) {
    const r = await idx.collection('players_fc' + VER).skip(skip).limit(1000).field({ _id: true }).get();
    if (!r.data.length) break;
    for (const d of r.data) ids.push(d._id);
    if (r.data.length < 1000) break;
  }
  console.log(`DB 取到 eaId ${ids.length} 个`);
  if (!ids.length) {
    console.log('（players 集合为空，说明落库步骤未成功）');
    return;
  }

  const step = Math.max(1, Math.floor(ids.length / SAMPLE));
  const sample = [];
  for (let i = 0; i < ids.length && sample.length < SAMPLE; i += step) sample.push(ids[i]);

  // 4) 批量问云存储：按类型统计命中/缺失
  //    card  : 全样本抽查，用来估算整体完成百分比
  //    portrait: 全样本抽查，确认两图都在
  //    simple : 只查前 30 个，**应当全部缺失** —— 这是 FC_IMG_TYPES 配置真的生效的证据
  async function checkType(ids2, suffix) {
    const hit = [];
    const miss = [];
    for (let i = 0; i < ids2.length; i += 50) {
      const part = ids2.slice(i, i + 50);
      const fileList = part.map((id) => `${PREFIX}fc27/images/${id}${suffix}`);
      let r;
      try {
        r = await app.getTempFileURL({ fileList });
      } catch (e) {
        console.log('  getTempFileURL 失败:', (e && e.message) || e);
        continue;
      }
      const list = r.fileList || [];
      list.forEach((item, k) => {
        // status 0 = 成功；非 0（含 code）表示文件不存在/无权限
        if (item.status === 0 || item.tempFileURL) hit.push(part[k]);
        else miss.push({ id: part[k], code: item.code, status: item.status });
      });
    }
    return { hit, miss };
  }

  const card = await checkType(sample, '_card.webp');
  const port = await checkType(sample, '.webp');
  const simple = await checkType(sample.slice(0, 30), '_simple.webp');

  const pctOf = (r) => {
    const t = r.hit.length + r.miss.length;
    return t ? ((r.hit.length / t) * 100).toFixed(1) : 'n/a';
  };
  console.log();
  console.log(`card 图  : 命中 ${card.hit.length} / 缺失 ${card.miss.length} → ${pctOf(card)}%  （≈上传完成百分比）`);
  console.log(`portrait : 命中 ${port.hit.length} / 缺失 ${port.miss.length} → ${pctOf(port)}%`);
  console.log(`simple   : 命中 ${simple.hit.length} / 缺失 ${simple.miss.length}` +
    (simple.hit.length === 0 ? '  ✔ 一张都没传（FC_IMG_TYPES 生效，未下载）' : '  ✘ 仍有 simple 残留'));
  if (card.miss.length) {
    console.log('card 缺失样例:', card.miss.slice(0, 5).map((m) => `${m.id}(code=${m.code})`).join(' '));
  }
  if (port.miss.length) {
    console.log('portrait 缺失全部:', port.miss.slice(0, 20).map((m) => m.id).join(' '));
  }
  console.log('（上传按球员顺序推进，越靠后的球员越晚出现）');
})();
