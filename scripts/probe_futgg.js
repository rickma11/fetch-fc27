#!/usr/bin/env node
'use strict';
// 轻量探针：监控 fut.gg 球员数据 / 进化 / SBC 是否有更新，有则 dispatch fetch-fc27.yml
// 运行点：GitHub Actions（由 cron-job.org 每小时 workflow_dispatch 触发）
// 设计：先试 GitHub 直连 r2.fut.gg；若 403 再改用 R2_BASE 指向的 relay（Cloudflare Worker 等干净 IP）
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const VER = process.env.PROBE_VER || '27';
const R2_BASE = process.env.R2_BASE || `https://r2.fut.gg/${VER}`;
const SBC_URL = process.env.SBC_URL || `https://www.fut.gg/api/fut/sbc/${VER}?page=1`;
const BASELINE_PATH = process.env.BASELINE_PATH || path.join(__dirname, '..', 'probe', 'baseline.json');
const MODE = process.env.PROBE_MODE || 'probe'; // 'probe' | 'observe'
const WHITELIST = (process.env.PROBE_KEYS || 'fc-core-data,active-evolutions,all-evolutions')
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
    return { ok: true, status: res.status, url, data };
  } catch (e) {
    return { ok: false, status: -2, url, err: e.name === 'AbortError' ? 'timeout' : e.message };
  } finally { clearTimeout(t); }
}

function pingHC(success) {
  if (!HC_URL) return;
  const url = success ? HC_URL : HC_URL + '/fail';
  try { fetch(url).catch(() => {}); } catch (e) { /* ignore */ }
}

async function main() {
  log('mode=%s ver=%s whitelist=%s', MODE, VER, WHITELIST.join(','));
  log('r2_base=%s', R2_BASE);

  const m = await getJson(`${R2_BASE}/manifest.json`);
  let manifest = null;
  if (m.ok && m.data && typeof m.data === 'object') manifest = m.data;
  log('manifest status=%s keys=%s', m.status, manifest ? Object.keys(manifest).length : '-');

  const s = await getJson(SBC_URL);
  let sbcTotal = null;
  if (s.ok && s.data) {
    if (s.data.data && typeof s.data.data.totalCount === 'number') sbcTotal = s.data.data.totalCount;
    else if (typeof s.data.totalCount === 'number') sbcTotal = s.data.totalCount;
  }
  log('sbc status=%s totalCount=%s', s.status, sbcTotal);

  const manifestHashes = {};
  if (manifest) {
    for (const k of WHITELIST) {
      if (EXCLUDE.has(k)) continue;
      if (k in manifest) manifestHashes[k] = manifest[k];
    }
  }
  const current = { ts: Date.now(), manifestStatus: m.status, sbcStatus: s.status, manifestHashes, sbcTotal };

  let baseline = {};
  try { baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8')); } catch (e) { baseline = {}; }
  const firstRun = !baseline || Object.keys(baseline).length === 0;

  if (firstRun) {
    log('FIRST_RUN: seeding baseline, no dispatch');
    fs.writeFileSync(BASELINE_PATH, JSON.stringify(current, null, 2));
    log('all manifest keys: ' + (manifest ? Object.keys(manifest).join(', ') : '(unavailable)'));
    log('whitelisted hashes: ' + JSON.stringify(manifestHashes));
    pingHC(true);
    return;
  }

  // detect change
  let changed = false; const reasons = [];
  if (!manifest && sbcTotal == null) {
    log('NO_SOURCE_AVAILABLE: cannot determine; failing safe (no dispatch)');
    pingHC(false);
    return;
  }
  if (manifest) {
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
  if (manifest && !baseline.manifestHashes) { reasons.push('no-manifest-baseline'); changed = true; }
  log('changed=%s reasons=%s', changed, reasons.join(' | '));

  if (MODE === 'observe') {
    log('OBSERVE: writing baseline, no dispatch');
    fs.writeFileSync(BASELINE_PATH, JSON.stringify(current, null, 2));
    log('all manifest keys: ' + (manifest ? Object.keys(manifest).join(', ') : '(unavailable)'));
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
