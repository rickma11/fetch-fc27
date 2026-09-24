#!/usr/bin/env node
/**
 * 把云库的 FC 数据「倒灌」回本地 `cloud-data/fc{ver}/*.json`，让本地 = 云端。
 *
 * 为什么需要它（2026-09-21 用户反馈「本地 players.json 只有 10000 条，不要每次都是旧的」）：
 *   fut.gg 的列表接口有 `max_result_window = 10000` —— 朴素 `?page=N` 翻页到第 334 页就
 *   被服务端悄悄截断。**本地这份 players.json 是「按 OVR 分桶绕开 10000 窗口」这个修法之前
 *   的历史遗留**，所以只有 10000 条；而云库是 CI 用分桶法抓的全量（19797）。
 *   后果很隐蔽：`gen_facet_order.js --from-local` / `sync_i18n.js --from-local` /
 *   `gen_noportrait_cards.js` / `backfill_rarity.js` **都读这个文件**，喂给它们半截数据不会报错，
 *   只会静默产出半截结果（少掉的恰好是低 OVR 那一档）。
 *
 * 用法：
 *   node scripts/pull_local_snapshot.js                  # 只倒灌 players.json（默认，快）
 *   node scripts/pull_local_snapshot.js --with-details   # 连 details.json 一起（慢，~100MB）
 *   node scripts/pull_local_snapshot.js --only details   # 只倒灌 details.json
 *   node scripts/pull_local_snapshot.js --dry            # 只对账、不写文件
 *
 * 形态兼容性（已核对）：`upload_db.js` 写库时是 `Object.assign({}, p, {_id: String(p.eaId)})`
 *   的**纯透传**，所以拉回来的文档 = 原来的列表条目 + 一个 `_id`。本脚本会**剥掉 `_id`**，
 *   保证落盘形态与 CI 的 full 产物一致（下游 `--from-local` 消费者读 `club.name` 等字段，不受影响）。
 *
 * 安全闸：云库条数 < 19000 一律**拒绝覆盖**并 exit(1) —— 云库半残时宁可保持本地旧数据，
 *   也不要拿残缺快照盖掉还能用的文件（与 `gen_squad_chem.js` / `fetch_ci.js` 同口径）。
 *
 * ⚠️ 只倒灌「读多写少」的两张大表。`facets.json` / `sbcs.json` / `evolutions.json` 等
 *    由 CI 每日生成且已提交进仓库（走 git 同步即可），不在这里重复拉。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const cloudbase = require('@cloudbase/node-sdk');
const { resolve: resolveCred } = require('./tcb_env');

const argv = process.argv.slice(2);
function flag(name) { return argv.indexOf('--' + name) >= 0; }
function opt(name, def) {
  const i = argv.indexOf('--' + name);
  return i >= 0 ? argv[i + 1] : def;
}

const VER = String(opt('ver', '27'));
const DRY = flag('dry');
const WITH_DETAILS = flag('with-details');
const ONLY = opt('only', null);                     // players | details | null(=按 with-details 决定)
const PAGE = 1000;                                  // 服务端 SDK 单次上限 1000
const MIN_OK = 19000;                               // 安全闸（与 CI 同口径）

const DIR = path.resolve(__dirname, '..', 'cloud-data', 'fc' + VER);

function human(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
function mb(n) { return (n / 1048576).toFixed(1) + 'MB'; }

// 分页拉全表。⚠️ 不信任 count()（check_cloud_fc27.js 已记：count 有时不准），
// 一律以「实际拿到多少条」为准，碰到空页即止。
async function fetchAll(db, colName) {
  const col = db.collection(colName);
  const out = [];
  for (let skip = 0; ; skip += PAGE) {
    const r = await col.skip(skip).limit(PAGE).get();
    const batch = (r && r.data) || [];
    if (!batch.length) break;
    for (const d of batch) out.push(d);
    process.stdout.write('\r  ' + colName + ' 已拉 ' + human(out.length) + ' 条…');
    if (batch.length < PAGE) break;
  }
  process.stdout.write('\r' + ' '.repeat(48) + '\r');
  return out;
}

// 落盘前剥掉 _id（保持与 CI full 产物同形态）。返回新对象，不改原数组元素。
function stripId(d) {
  const o = Object.assign({}, d);
  delete o._id;
  return o;
}

// 原子写：先写 .tmp 再 rename —— 避免下游工具恰好读到一个写了一半的文件。
function writeJsonAtomic(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data), 'utf8');
  if (fs.existsSync(file)) fs.unlinkSync(file);
  fs.renameSync(tmp, file);
}

function statLocal(file) {
  if (!fs.existsSync(file)) return { exists: false, count: 0, size: 0, mtime: null };
  const st = fs.statSync(file);
  let count = 0;
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    count = Array.isArray(j) ? j.length : Object.keys(j).length;
  } catch (e) { count = -1; }
  return { exists: true, count: count, size: st.size, mtime: st.mtime.toISOString() };
}

function report(label, before, after) {
  const grew = after.count - before.count;
  console.log('  ' + label.padEnd(14) + ' 本地 ' + human(before.count) + ' 条 → ' + human(after.count) + ' 条' +
    (grew ? '  (Δ ' + (grew > 0 ? '+' : '') + human(grew) + ')' : '') +
    '   ' + mb(after.size));
}

(async function main() {
  console.log('== 云库 → 本地 快照倒灌（FC' + VER + '）==');

  const cred = resolveCred();
  if (cred.missing.length) {
    console.error('缺少云开发凭证：' + cred.missing.join(' / ') + '\n' + cred.hint);
    process.exit(1);
  }
  console.log('环境：' + cred.ENV_ID + '（凭证来源：' + cred.source + '）');

  const app = cloudbase.init({
    env: cred.ENV_ID, secretId: cred.SECRET_ID, secretKey: cred.SECRET_KEY, timeout: 120000
  });
  const db = app.database();

  // ---- 要处理的表：本地文件名 → 云集合名 ----
  const wantPlayers = ONLY ? ONLY === 'players' : true;
  const wantDetails = ONLY ? ONLY === 'details' : WITH_DETAILS;
  const jobs = [];
  if (wantPlayers) jobs.push({ file: 'players.json', col: 'players_fc' + VER, arr: true, label: 'players' });
  if (wantDetails) jobs.push({ file: 'details.json', col: 'details_fc' + VER, arr: false, label: 'details' });

  if (!jobs.length) {
    console.log('没有要拉的表（--only 传了 players/details 之外的值？）');
    process.exit(0);
  }

  const before = {};
  for (const j of jobs) before[j.label] = statLocal(path.join(DIR, j.file));
  for (const j of jobs) {
    if (before[j.label].exists) {
      console.log('  本地现值 ' + j.label.padEnd(8) + human(before[j.label].count) + ' 条  ' +
        mb(before[j.label].size) + '  改于 ' + before[j.label].mtime);
    } else {
      console.log('  本地现值 ' + j.label.padEnd(8) + '（文件不存在）');
    }
  }

  for (const j of jobs) {
    console.log('\n-- 拉取 ' + j.col + ' --');
    const t0 = Date.now();
    const rows = await fetchAll(db, j.col);
    console.log('  实际拉到 ' + human(rows.length) + ' 条，耗时 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');

    if (rows.length < MIN_OK) {
      console.error('  ✖ 云库只返回 ' + human(rows.length) + ' 条（< ' + human(MIN_OK) + ' 安全闸）→ ' +
        '拒绝覆盖本地文件。可能原因：云库正在重建 / 凭证指向了错误的环境。');
      process.exit(1);
    }

    if (DRY) { console.log('  （--dry：不写文件）'); continue; }

    if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true });
    const file = path.join(DIR, j.file);
    if (j.arr) {
      writeJsonAtomic(file, rows.map(stripId));
    } else {
      // details.json 是「以 eaId 为键的对象」（见 upload_db.js 读法），不是数组。
      const obj = {};
      for (const d of rows) obj[String(d._id || d.eaId)] = stripId(d);
      writeJsonAtomic(file, obj);
    }
    const after = statLocal(file);
    report(j.label, before[j.label], after);
  }

  if (DRY) console.log('\n== 对账完成（未写任何文件）==');
  else console.log('\n== 倒灌完成：本地已与云库对齐 ==');
})().catch(function (e) {
  console.error('ERR', (e && e.message) || e);
  process.exit(1);
});
