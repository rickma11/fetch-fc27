#!/usr/bin/env node
'use strict';
// 轻量探针：监控 fut.gg 球员数据 / 进化 / SBC 是否有更新，有则 dispatch fetch-fc27.yml
// 运行点：GitHub Actions（由 cron-job.org 每小时 workflow_dispatch 触发）
//
// 球员变更判据（修订版，对齐 fetch-fc27 content_sig 的 total 思路）：
//   不再只信 manifest 里 fc-core-data 的 hash（间接、且未证实是全量），
//   而是真正下载 fc-core-data（r2 直连 GitHub 200）数条目数 playerCount + 算内容 sha1，
//   与基线比对。count 变=球员增删；sha1 变=球员属性被改（count 不变也能兜住）。
//   体积代价：~1.74MB/次（fut.gg 公开 CDN，不是我们的带宽/配额）。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

const VER = process.env.PROBE_VER || '27';
const R2_BASE = process.env.R2_BASE || `https://r2.fut.gg/${VER}`;
const SBC_URL = process.env.SBC_URL || `https://www.fut.gg/api/fut/sbc/${VER}?page=1`;
const BASELINE_PATH = process.env.BASELINE_PATH || path.join(__dirname, '..', 'probe', 'baseline.json');
const MODE = process.env.PROBE_MODE || 'probe'; // 'probe' | 'observe'
// 仅进化走 manifest hash（避免每小时下载十几 MB 的进化文件）；球员单独数条目
const WHITELIST = (process.env.PROBE_KEYS || 'active-evolutions,all-evolutions')
  .split(',').map(s => s.trim()).filter(Boolean);
const EXCLUDE = new Set((process.env.PROBE_EXCLUDE || '').split(',').map(s => s.trim()).filter(Boolean));
const DISPATCH_REPO = process.env.DISPATCH_REPO || 'rickma11/fetch-fc27';
const DISPATCH_WF = process.env.DISPATCH_WF || 'fetch-fc27.yml';
const HC_URL = process.env.HEALTHCHECK_URL || '';
const GH_TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '';

function log(...a) { console.log('[probe]', ...a); }

async function getJson(url, timeoutMs = 20000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; OAO-probe/1.0)', Accept: 'application/json' }
    });
    if (!res.ok) return { ok: false, status: res.status, url };
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch (e) { return { ok: false, status: -1, url, err: 'json-parse' }; }
    return { ok: true, status: res.status, url, data, text };
  } catch (e) {
    return { ok: false, status: -2, url, err: e.name === 'AbortError' ? 'timeout' : e.message };
  } finally { clearTimeout(t); }
}

// 下载 fc-core-data 整包，数球员条目数 + 算内容 sha1（轻量：r2 直连 GitHub 200）
async function getCoreData(r2Base, manifest) {
  if (!manifest || !('fc-core-data' in manifest)) return { ok: false, reason: 'no-manifest-key' };
  const hash = manifest['fc-core-data'];
  const url = `${r2Base}/fc-core-data.v1.${hash}.json`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 60000);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; OAO-probe/1.0)', Accept: 'application/json' }
    });
    if (!res.ok) return { ok: false, status: res.status, url, hash };
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch (e) { return { ok: false, status: -1, url, hash, err: 'json-parse' }; }
    const count = Array.isArray(data) ? data.length
      : (data && Array.isArray(data.data)) ? data.data.length
      : (data && typeof data === 'object') ? Object.keys(data).length
      : null;
    const sha1 = crypto.createHash('sha1').update(text).digest('hex');
    const sampleKeys = Array.isArray(data)
      ? (data[0] && typeof data[0] === 'object' ? Object.keys(data[0]).slice(0, 20) : null)
      : (data && typeof data === 'object' ? Object.keys(data).slice(0, 20) : null);
    return { ok: true, status: res.status, url, hash, count, sha1, sampleKeys };
  } catch (e) {
    return { ok: false, status: -2, url, hash, err: e.name === 'AbortError' ? 'timeout' : e.message };
  } finally { clearTimeout(t); }
}

// 调试用：扫描某个 manifest 键，报告 status / 体积 / 条目数 / 样本键（不写 baseline）
async function scanKey(r2Base, manifest, key) {
  if (!manifest || !(key in manifest)) { log('SCAN %s: not in manifest', key); return; }
  const hash = manifest[key];
  const url = `${r2Base}/${key}.v1.${hash}.json`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 60000);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; OAO-probe/1.0)', Accept: 'application/json' } });
    if (!res.ok) { log('SCAN %s: http %s', key, res.status); return; }
    const text = await res.text();
    let data; try { data = JSON.parse(text); } catch (e) { log('SCAN %s: json-parse-fail', key); return; }
    const count = Array.isArray(data) ? data.length
      : (data && Array.isArray(data.data)) ? data.data.length
      : (data && typeof data === 'object') ? Object.keys(data).length : null;
    const sampleKeys = Array.isArray(data)
      ? (data[0] && typeof data[0] === 'object' ? Object.keys(data[0]).slice(0, 25) : null)
      : (data && typeof data === 'object' ? Object.keys(data).slice(0, 25) : null);
    const sample0 = Array.isArray(data) && data[0] ? JSON.stringify(data[0]).slice(0, 300) : null;
    log('SCAN %s: http=%s bytes=%d count=%s sampleKeys=%s', key, res.status, Buffer.byteLength(text), count, JSON.stringify(sampleKeys));
    if (sample0) log('SCAN %s sample0=%s', key, sample0);
  } catch (e) {
    log('SCAN %s err %s', key, e.name === 'AbortError' ? 'timeout' : e.message);
  } finally { clearTimeout(t); }
}

function pingHC(success) {
  if (!HC_URL) return;
  const url = success ? HC_URL : HC_URL + '/fail';
  try { fetch(url).catch(() => {}); } catch (e) { /* ignore */ }
}

async function main() {
  log('mode=%s ver=%s evoWhitelist=%s', MODE, VER, WHITELIST.join(','));
  log('r2_base=%s', R2_BASE);

  const m = await getJson(`${R2_BASE}/manifest.json`);
  let manifest = null;
  if (m.ok && m.data && typeof m.data === 'object') manifest = m.data;
  log('manifest status=%s keys=%s', m.status, manifest ? Object.keys(manifest).length : '-');

  // 调试：扫描候选键（PROBE_SCAN_KEYS 逗号分隔），仅打印不写 baseline
  const SCAN_KEYS = (process.env.PROBE_SCAN_KEYS || '').split(',').map(s => s.trim()).filter(Boolean);
  for (const k of SCAN_KEYS) await scanKey(R2_BASE, manifest, k);

  const s = await getJson(SBC_URL);
  let sbcTotal = null;
  if (s.ok && s.data) {
    if (s.data.data && typeof s.data.data.totalCount === 'number') sbcTotal = s.data.data.totalCount;
    else if (typeof s.data.totalCount === 'number') sbcTotal = s.data.totalCount;
  }
  log('sbc status=%s totalCount=%s', s.status, sbcTotal);

  // 球员：下载 fc-core-data 数条目
  const core = await getCoreData(R2_BASE, manifest);
  let playerCount = null, playerHash = null;
  if (core.ok) {
    playerCount = core.count; playerHash = core.sha1;
    log('core-data status=%s count=%s sha1=%s sampleKeys=%s', core.status, core.count, core.sha1, JSON.stringify(core.sampleKeys));
  } else {
    log('core-data FETCH_FAIL status=%s reason=%s', core.status, core.reason || core.err || '-');
  }

  // 进化：manifest hash 白名单
  const manifestHashes = {};
  if (manifest) {
    for (const k of WHITELIST) {
      if (EXCLUDE.has(k)) continue;
      if (k in manifest) manifestHashes[k] = manifest[k];
    }
  }
  const current = {
    ts: Date.now(),
    manifestStatus: m.status,
    sbcStatus: s.status,
    coreDataStatus: core.ok ? core.status : (core.status || -1),
    playerCount, playerHash,
    manifestHashes, sbcTotal
  };

  let baseline = {};
  try { baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8')); } catch (e) { baseline = {}; }
  const firstRun = !baseline || Object.keys(baseline).length === 0;

  if (firstRun) {
    log('FIRST_RUN: seeding baseline, no dispatch');
    fs.writeFileSync(BASELINE_PATH, JSON.stringify(current, null, 2));
    log('playerCount=%s (expect ~19860 if fc-core-data is full set)', playerCount);
    log('all manifest keys: ' + (manifest ? Object.keys(manifest).join(', ') : '(unavailable)'));
    pingHC(true);
    return;
  }

  // detect change
  let changed = false; const reasons = [];
  if (!core.ok && sbcTotal == null && Object.keys(manifestHashes).length === 0) {
    log('NO_SOURCE_AVAILABLE: cannot determine; failing safe (no dispatch)');
    pingHC(false);
    return;
  }
  if (core.ok) {
    if (baseline.playerCount != null && playerCount !== baseline.playerCount) {
      changed = true; reasons.push(`player:count ${baseline.playerCount}->${playerCount}`);
    }
    if (baseline.playerHash != null && playerHash !== baseline.playerHash) {
      changed = true; reasons.push(`player:hash ${String(baseline.playerHash).slice(0, 8)}->${String(playerHash).slice(0, 8)}`);
    }
  }
  if (Object.keys(manifestHashes).length) {
    const bH = baseline.manifestHashes || {};
    for (const k of Object.keys(manifestHashes)) {
      if (bH[k] !== manifestHashes[k]) {
        changed = true;
        reasons.push(`manifest:${k} ${(bH[k] || 'none')}->${(manifestHashes[k] || 'none')}`);
      }
    }
  }
  if (sbcTotal != null && baseline.sbcTotal != null && sbcTotal !== baseline.sbcTotal) {
    changed = true; reasons.push(`sbc:${baseline.sbcTotal}->${sbcTotal}`);
  }
  if (core.ok && !('playerCount' in baseline)) { reasons.push('no-player-baseline'); changed = true; }
  log('changed=%s reasons=%s', changed, reasons.join(' | '));

  if (MODE === 'observe') {
    log('OBSERVE: writing baseline, no dispatch');
    fs.writeFileSync(BASELINE_PATH, JSON.stringify(current, null, 2));
    log('playerCount=%s (baseline seeded)', playerCount);
    pingHC(true);
    return;
  }

  if (changed) {
    // in-flight / recent dedup: avoid duplicate dispatch
    if (GH_TOKEN) {
      try {
        const api = `https://api.github.com/repos/${DISPATCH_REPO}/actions/workflows/${DISPATCH_WF}/runs?per_page=5`;
        const r = await fetch(api, { headers: { Authorization: `Bearer ${GH_TOKEN}`, Accept: 'application/vnd.github+json' } });
        if (r.ok) {
          const j = await r.json();
          const now = Date.now();
          const recent = (j.workflow_runs || []).filter(run => {
            const st = run.status; const created = new Date(run.created_at).getTime();
            if (st === 'queued' || st === 'in_progress') return true;
            if (st === 'completed' && now - created < 60 * 60 * 1000) return true;
            return false;
          });
          if (recent.length > 0) {
            log('IN_FLIGHT/RECENT fetch run detected (%d), skip dispatch to avoid duplicate', recent.length);
            changed = false;
          }
        }
      } catch (e) { log('dedup check err %s', e.message); }
    }
    if (changed) {
      log('CHANGE DETECTED -> dispatch %s/%s', DISPATCH_REPO, DISPATCH_WF);
      try {
        const out = execSync(`gh api -X POST /repos/${DISPATCH_REPO}/actions/workflows/${DISPATCH_WF}/dispatches -f ref=main`, { stdio: 'pipe' }).toString();
        log('DISPATCH_OK %s', out.trim());
      } catch (e) { log('DISPATCH_FAIL %s', e.message); process.exitCode = 1; }
    }
  } else {
    log('no change, nothing to do');
  }

  // persist baseline so same state won't re-dispatch
  fs.writeFileSync(BASELINE_PATH, JSON.stringify(current, null, 2));
  pingHC(true);
}

main().catch(e => { console.error(e); process.exit(1); });
