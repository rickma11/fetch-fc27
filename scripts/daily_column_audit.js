// 线上 daily_7d.json 列语义审计（2026-10-25，一次性诊断；只读，不上传、不改动任何文件）
// ---------------------------------------------------------------------------
// 背景：旧 updateDaily 的 alignHist 用 `a.slice(a.length - keep)` 保留末尾 keep 格，
//   同日重跑时 days 不增长 ⇒ 每小时整列左移一位、最旧列被挤掉（持续右移污染）。
//   修复（sameDayRerun 剥残留格）只保证「今后不再移」，但线上存量列的真实语义
//   需要用真值反推，才能定「只剥脏列」还是「干净重建」。
// 方法：以 series_24h.json 为真值，对每个候选截止小时 H（今日桶 0000..HH00 累计）
//   重算 per-player [avg,min,max]（与 updateDaily#dayAgg 同公式），与线上每一列
//   精确比对 ⇒ 每列的最佳匹配截止点即其真实语义。
// 另与本地备份 daily_7d.json.pre-corrupt 做逐列相等矩阵（验证左移推断）。
'use strict';

const fs = require('fs');
const path = require('path');

const DAILY_PATH = 'fc27/market/daily_7d.json';
const SERIES_PATH = 'fc27/market/series_24h.json';
const BACKUP_LOCAL = path.join(__dirname, '..', 'backups', '20261025', 'market-overview', 'daily_7d.json.pre-corrupt');

function pad2(n) { return n < 10 ? '0' + n : '' + n; }
function todayKey() {
  const z = new Date(Date.now() + 8 * 60 * 60 * 1000);
  return '' + z.getUTCFullYear() + pad2(z.getUTCMonth() + 1) + pad2(z.getUTCDate());
}
function loadCreds() {
  const need = ['TCB_ENV_ID', 'TCB_SECRET_ID', 'TCB_SECRET_KEY'];
  const miss = need.filter(function (k) { return !process.env[k]; });
  if (miss.length) {
    try {
      const env = fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8');
      env.split(/\r?\n/).forEach(function (line) {
        const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
        if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
      });
    } catch (e) { /* 无 .env.local 也无妨 */ }
  }
  const stillMiss = need.filter(function (k) { return !process.env[k]; });
  if (stillMiss.length) { console.error('[audit] FAIL: 缺凭证 ' + stillMiss.join('/')); process.exit(1); }
}

(async function main() {
  loadCreds();
  const cloudbase = require('@cloudbase/node-sdk');
  const app = cloudbase.init({
    env: process.env.TCB_ENV_ID, secretId: process.env.TCB_SECRET_ID, secretKey: process.env.TCB_SECRET_KEY, timeout: 180000
  });
  async function dl(p) {
    const r = await app.downloadFile({ fileID: p });
    if (!r || !r.fileContent) throw new Error('空内容: ' + p);
    return JSON.parse(r.fileContent.toString('utf8'));
  }

  console.log('[audit] 下载线上 daily_7d.json + series_24h.json（SDK 直读，绕开 CDN）…');
  const daily = await dl(DAILY_PATH);
  const series = await dl(SERIES_PATH);
  const dayKey = todayKey();
  const days = daily.days || [];
  const players = daily.players || {};
  const ids = Object.keys(players);
  console.log('[audit] dayKey=' + dayKey + ' | 线上 days=' + JSON.stringify(days) + ' | players=' + ids.length +
    ' | series buckets=' + (series.buckets || []).length + '（' + series.buckets[0] + '→' + series.buckets[series.buckets.length - 1] + '）');

  // ── 1) 候选真值：今日各截止小时的累计聚合（同 updateDaily#dayAgg 公式）──
  const buckets = series.buckets || [];
  const sPlayers = series.players || {};
  const todayHours = [];
  buckets.forEach(function (b) {
    const s = String(b);
    if (s.slice(0, 8) === dayKey) { const h = s.slice(8, 10); if (todayHours.indexOf(h) < 0) todayHours.push(h); }
  });
  todayHours.sort();
  function aggAt(uptoHour) {
    const idx = [];
    buckets.forEach(function (b, i) {
      const s = String(b);
      if (s.slice(0, 8) === dayKey && s.slice(8, 10) <= uptoHour) idx.push(i);
    });
    const out = {};
    Object.keys(sPlayers).forEach(function (id) {
      const r = sPlayers[id] || {};
      function dayAgg(arr) {
        const vals = [];
        for (let k = 0; k < idx.length; k++) { const v = arr[idx[k]]; if (v != null) vals.push(v); }
        if (!vals.length) return null;
        let s = 0, mn = vals[0], mx = vals[0];
        for (let j = 0; j < vals.length; j++) { s += vals[j]; if (vals[j] < mn) mn = vals[j]; if (vals[j] > mx) mx = vals[j]; }
        return [Math.round(s / vals.length), mn, mx];
      }
      const pc = dayAgg(r.pc || []), ps = dayAgg(r.ps || []);
      if (pc || ps) out[id] = { pc: pc, ps: ps };
    });
    return out;
  }
  const candidates = todayHours.map(function (h) { return { label: '今日≤' + h + '时（' + (todayHours.indexOf(h) + 1) + '桶）', agg: aggAt(h) }; });
  if (!candidates.length) { console.error('[audit] FAIL: series 内无今日桶，无法审计'); process.exit(1); }

  // ── 2) 每列 vs 每个候选：精确匹配数（avg/min/max 全等）──
  console.log('\n[audit] ── 每列真实语义（最佳匹配截止点）──');
  const verdict = [];
  for (let j = 0; j < days.length; j++) {
    const rows = [];
    candidates.forEach(function (c) {
      let match = 0, both = 0;
      ids.forEach(function (id) {
        const col = players[id].pc && players[id].pc[j];
        const ref = c.agg[id] && c.agg[id].pc;
        if (col == null || ref == null) return;
        both++;
        if (col[0] === ref[0] && col[1] === ref[1] && col[2] === ref[2]) match++;
      });
      if (both > 0) rows.push({ label: c.label, match: match, both: both });
    });
    rows.sort(function (a, b) { return b.match - a.match; });
    const top = rows.slice(0, 3).map(function (r) { return r.label + ' ' + r.match + '/' + r.both; }).join('  |  ');
    console.log('  列' + j + '（标签 ' + days[j] + '）: ' + (top || '（无可比球员）'));
    if (rows.length && rows[0].both >= 20) {
      const ratio = rows[0].match / rows[0].both;
      verdict.push({ col: j, label: days[j], best: rows[0].label, ratio: ratio, n: rows[0].both });
    }
  }

  // ── 3) 与本地备份逐列相等矩阵（验证「每小时左移一位」）──
  let backup = null;
  try { backup = JSON.parse(fs.readFileSync(BACKUP_LOCAL, 'utf8')); } catch (e) { /* 无备份则跳过 */ }
  if (backup && backup.days) {
    console.log('\n[audit] ── 线上 vs 本地备份（' + JSON.stringify(backup.days) + '）逐列精确相等数 ──');
    const bIds = Object.keys(backup.players || {});
    for (let j = 0; j < days.length; j++) {
      const cells = [];
      for (let k = 0; k < backup.days.length; k++) {
        let eq = 0, both = 0;
        ids.forEach(function (id) {
          const a = players[id].pc && players[id].pc[j];
          const b = bIds.indexOf(id) >= 0 ? (backup.players[id].pc && backup.players[id].pc[k]) : null;
          if (a == null || b == null) return;
          both++;
          if (a[0] === b[0] && a[1] === b[1] && a[2] === b[2]) eq++;
        });
        cells.push('备' + k + '(' + backup.days[k] + '):' + eq + '/' + both);
      }
      console.log('  线' + j + '(' + days[j] + ') ← ' + cells.join('  '));
    }
  } else {
    console.log('\n[audit] （无本地备份，跳过左移矩阵）');
  }

  // ── 4) 样例球员三列肉眼核对 ──
  console.log('\n[audit] ── 样例（前 3 个三列齐全的球员）──');
  let shown = 0;
  for (const id of ids) {
    const r = players[id];
    if (!r.pc || r.pc.length < days.length) continue;
    if (r.pc.some(function (c) { return c == null; })) continue;
    console.log('  eaId ' + id + ': ' + r.pc.map(function (c, j) { return days[j] + '=' + c[0] + '[' + c[1] + ',' + c[2] + ']'; }).join('  '));
    if (++shown >= 3) break;
  }

  // ── 5) 结论 ──
  console.log('\n[audit] ── 结论 ──');
  const allToday = verdict.length === days.length && verdict.every(function (v) { return v.ratio > 0.9 && /今日≤/.test(v.best); });
  if (allToday) {
    console.log('  ⚠️ 全部 ' + days.length + ' 列都是「今日不同截止小时的 partial」⇒ 存量历史列已全部被左移污染，');
    console.log('     真实的 10-23/10-24 全日值早已被挤掉（不在 series 24h 窗口内，不可恢复）。');
    console.log('     ⇒ 「只剥脏列」不成立（没有正确的历史列可保留），正确修法＝以 series 干净重建（days=[今日]）。');
  } else {
    console.log('  存在无法用今日 partial 解释的列 ⇒ 按各列最佳匹配逐一核对后再定方案。明细：');
    verdict.forEach(function (v) { console.log('    列' + v.col + '(' + v.label + ') → ' + v.best + ' 匹配率 ' + (v.ratio * 100).toFixed(1) + '% (n=' + v.n + ')'); });
  }
})().catch(function (e) {
  console.error('[audit] FAIL: ' + (e && e.message || e));
  process.exit(1);
});
