// meta_fc{ver} 元文档「北京时间可直读」标注器。
//
// 作用：给元文档补上纯展示的北京时间字段（fetchedAtCn / updatedAtCn / tsCn，格式
//   `YYYY-MM-DD HH:mm:ss (北京)`），让**微信云开发控制台**一眼可读（控制台不做时区换算，
//   原样显示存量字符串，看 UTC 要自己 +8 小时且常跨天）。
//
// 两种用途：
//   ① 一次性回填 / 翻新 —— 现有文档立即生效，不必等各 CI 脚本下次运行；
//   ② 兜底修复 —— 若某个 writer 用整篇 .set() 覆写把 *Cn 冲掉了（如云函数写的
//      squad_chem / hotboard / changelog），跑一次即可补齐。
//
// 用法：
//   node scripts/annotate_meta_time.js            # 默认只标注 CI 管道那 8 个
//                                                 # （home_hot/home_new/get_sbcs/get_evolutions/roster/votes/livehub/facets）
//   node scripts/annotate_meta_time.js --all      # 标注 meta_fc{ver} 全部文档
//   node scripts/annotate_meta_time.js --dry      # 只打印将要写的内容，不写库
//
// ⚠️ 纯展示字段：不改动、不删除任何原有字段（read-merge-set，写入前剔除 _id），
//    无任何消费方依赖，端上/CI 只读 fetchedAt / ts / fileID / forceVersion 等。
'use strict';

const cloudbase = require('@cloudbase/node-sdk');
const { resolve } = require('./tcb_env');
const { cn } = require('./cn_time');

const VER = Number(process.env.FC_VER || 27);
const META_COLLECTION = 'meta_fc' + VER;
const DRY = process.argv.indexOf('--dry') >= 0;
const ALL = process.argv.indexOf('--all') >= 0;

// 默认范围：CI 管道会写的元文档（对应 gen_static_lists / warm_roster / sync_votes / sync_live_hub / upload_db）
const CI_BATCH = ['home_hot', 'home_new', 'get_sbcs', 'get_evolutions', 'roster', 'votes', 'livehub', 'facets'];

// 从文档（含历史遗留的 data 包裹结构）里找时间源，返回要补写的 *Cn 字段
function cnFieldsOf(body) {
  const out = {};
  const src = (body && body.data && typeof body.data === 'object') ? body.data : {};
  const pick = function (k) {
    if (body && body[k] != null && body[k] !== '') return body[k];
    if (src[k] != null && src[k] !== '') return src[k];
    return null;
  };
  const fa = pick('fetchedAt');
  const ua = pick('updatedAt');
  const ts = pick('ts');
  if (fa != null) out.fetchedAtCn = cn(fa);
  if (ua != null) out.updatedAtCn = cn(ua);
  if (ts != null) out.tsCn = cn(ts);
  return out;
}

(async function () {
  const c = resolve();
  if (c.missing && c.missing.length) { console.error('缺凭证:', c.missing.join(' / ')); process.exit(1); }
  const app = cloudbase.init({ env: c.ENV_ID, secretId: c.SECRET_ID, secretKey: c.SECRET_KEY });
  const db = app.database();

  let ids = CI_BATCH;
  if (ALL) {
    const r = await db.collection(META_COLLECTION).limit(100).get();
    ids = (r.data || []).map(function (d) { return d._id; });
  }
  console.log('目标集合:', META_COLLECTION, '| 文档数:', ids.length, ALL ? '(--all)' : '(CI 批)', DRY ? '[dry]' : '');
  console.log('');

  let written = 0, skipped = 0, failed = 0;
  for (const id of ids) {
    try {
      const r = await db.collection(META_COLLECTION).doc(id).get();
      const raw = r && r.data;
      const body = Array.isArray(raw) ? raw[0] : raw;
      if (!body) { console.log('── ' + id + ': (文档不存在，跳过)'); skipped++; continue; }

      const add = cnFieldsOf(body);
      const keys = Object.keys(add);
      if (!keys.length) { console.log('── ' + id + ': (无时间字段，跳过)'); skipped++; continue; }

      // 是否已是最新（值未变则跳过写库，避免空跑）
      const changed = keys.some(function (k) { return body[k] !== add[k]; });
      const show = keys.map(function (k) { return k + '=' + add[k]; }).join('  ');
      if (!changed) { console.log('── ' + id + ': 已是北京时间，无需改  | ' + show); skipped++; continue; }

      console.log('── ' + id + ': ' + show);
      if (!DRY) {
        const next = Object.assign({}, body);
        delete next._id;                     // node-sdk: body 里不能带 _id
        Object.assign(next, add);
        await db.collection(META_COLLECTION).doc(id).set(next);
        written++;
      }
    } catch (e) {
      console.error('── ' + id + ': 失败 ' + (e && e.message));
      failed++;
    }
  }
  console.log('');
  console.log('完成：写入', written, '| 跳过', skipped, '| 失败', failed, DRY ? '（dry，未写库）' : '');
  process.exit(failed ? 1 : 0);
})().catch(function (e) { console.error('ERR', e); process.exit(1); });
