#!/usr/bin/env node
'use strict';
// 轻量探针（count-only 球员判据版）：每小时监控 fut.gg 球员数量 / 进化 / SBC 是否有更新，
// 有则 dispatch fetch-fc27.yml（真正的抓取落库由 fetch-fc27 完成，本脚本只做"看门狗"）。
//
// 运行点：GitHub Actions（由 cron-job.org 每小时 workflow_dispatch 触发）。
//
// 三条信号（任一变化即判定有更新）：
//   ① 球员数量 playerCount —— 用 Playwright 真实浏览器过 Cloudflare，抓 players/v2 第一页读 total。
//      count-only：只读总数（1 个请求），不抓全量，极轻；漏"改了属性但人数没变"的情况（FC 极少）。
//   ② SBC 总数 sbcTotal     —— 直连 www.fut.gg/api/fut/sbc/{ver}（GitHub 直连 200），读 totalCount。
//   ③ 进化 hash             —— 直连 r2.fut.gg/{ver}/manifest.json（GitHub 直连 200），读白名单键的 hash。
//
// 关键：探针**不扫云库**。球员数量来自浏览器内存态 vs 本地 baseline（提交在仓库），
//       SBC/进化来自两次轻量 HTTP。全程 0 云库读 / 0 云库写。只有"变了"才 dispatch fetch-fc27
//       （fetch-fc27 才会扫云库 19,860 条 + 落库）。这把"每小时扫云库"降成"每次变化才扫"。
//
// 模式：
//   PROBE_MODE=observe  → 照常抓全部信号、写 baseline，但**永不 dispatch**（用于先观察几天/验证流程）。
//   PROBE_MODE=probe    → 变化则 dispatch。
//   PROBE_MODE=reseed   → 与 observe 同样只写 baseline 不 dispatch，但带保护：球员数未取到成功则不覆盖旧基线。
//                          专供 fetch-fc27.yml(job1) 每日同步后锚定探针基线，避免 job1 已同步的数据被探针误判为"变化"而重复触发。
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { chromium } = require('playwright');

const VER = process.env.PROBE_VER || '27';
const R2_BASE = process.env.R2_BASE || `https://r2.fut.gg/${VER}`;
const SBC_URL = process.env.SBC_URL || `https://www.fut.gg/api/fut/sbc/${VER}?page=1`;
const PLAYERS_URL = process.env.PLAYERS_URL || `https://www.fut.gg/api/fut/players/v2/${VER}/`;
const BASELINE_PATH = process.env.BASELINE_PATH || path.join(__dirname, '..', 'probe', 'baseline.json');
const MODE = process.env.PROBE_MODE || 'probe'; // 'probe' | 'observe'
const WHITELIST = (process.env.PROBE_KEYS || 'active-evolutions,all-evolutions')
  .split(',').map(s => s.trim()).filter(Boolean);
const DISPATCH_REPO = process.env.DISPATCH_REPO || 'rickma11/fetch-fc27';
const DISPATCH_WF = process.env.DISPATCH_WF || 'fetch-fc27.yml';
const HC_URL = process.env.HEALTHCHECK_URL || '';
const GH_TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '';
const CF_UA = process.env.CF_UA || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36';

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

// 用 Playwright 真实浏览器过 Cloudflare，按 overall 分桶抓 players/v2 真实 total 求和（count-only）。
// 为什么分桶：API 有 max_result_window=10000，单页 total 被卡在 10000（实际 ~19860 人），
// 必须按 overall 分桶（overall__gte/lte）把每桶真实 total 加起来才准。
// 命中 10000 上限的桶自动拆成单 OVR 再求，避免被窗口截断。
function chunk(arr, n) { const r = []; for (let i = 0; i < arr.length; i += n) r.push(arr.slice(i, i + n)); return r; }

async function fetchBucketTotal(page, lo, hi) {
  const url = `${PLAYERS_URL}?page=1&overall__gte=${lo}&overall__lte=${hi}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await page.request.get(url, { headers: { Accept: 'application/json' }, timeout: 20000 });
      if (r.status() === 200) {
        const j = await r.json();
        const t = (j && typeof j.total === 'number') ? j.total : 0;
        return { ok: true, total: t, capped: t >= 10000 };
      }
    } catch (e) { /* retry */ }
    await new Promise(res => setTimeout(res, 1000));
  }
  return { ok: false, total: 0 };
}

async function getPlayerCount() {
  log('player: launching chromium (bypass Cloudflare)...');
  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox', '--disable-dev-shm-usage']
  });
  try {
    const ctx = await browser.newContext({
      userAgent: CF_UA, locale: 'en-US', viewport: { width: 1280, height: 800 }, timezoneId: 'America/New_York'
    });
    const page = await ctx.newPage();
    await page.goto('https://www.fut.gg/', { waitUntil: 'domcontentloaded', timeout: 60000 });

    let passed = false, status = null;
    for (let i = 0; i < 30; i++) {
      try {
        const r = await page.request.get(`${PLAYERS_URL}?page=1`, { headers: { Accept: 'application/json' }, timeout: 20000 });
        status = r.status();
        if (status === 200) { passed = true; break; }
      } catch (e) { /* keep polling */ }
      await new Promise(res => setTimeout(res, 3000));
    }
    if (!passed) {
      log('player: Cloudflare 未通过（status=%s），本次无法获取球员数量', status);
      return { ok: false, reason: 'cf-not-passed', status };
    }

    // 5-OVR 分桶；命中 10000 上限的桶拆成单 OVR 再求
    const buckets = [];
    for (let lo = 1; lo <= 99; lo += 5) { const hi = Math.min(lo + 4, 99); buckets.push([lo, hi]); }
    let total = 0, failed = 0; const bucketTotals = [];
    for (const group of chunk(buckets, 5)) {
      const res = await Promise.all(group.map(([lo, hi]) => fetchBucketTotal(page, lo, hi)));
      for (let i = 0; i < res.length; i++) {
        const r = res[i]; const [lo, hi] = group[i];
        if (!r.ok) { failed++; continue; }
        if (r.capped) {
          const sub = await Promise.all(Array.from({ length: hi - lo + 1 }, (_, k) => fetchBucketTotal(page, lo + k, lo + k)));
          for (const s of sub) { if (!s.ok) { failed++; continue; } total += s.total; bucketTotals.push(s.total); }
        } else { total += r.total; bucketTotals.push(r.total); }
      }
      await new Promise(res => setTimeout(res, 200));
    }
    if (failed >= 5) {
      log('player: %d 个桶失败，判定球员数量不可用', failed);
      return { ok: false, reason: 'too-many-failures', failed };
    }
    log('player: 真实球员总数=%s（%d 桶，失败 %d）', total, bucketTotals.length, failed);
    return { ok: true, status: 200, playerCount: total };
  } finally {
    await browser.close();
  }
}

function pingHC(success) {
  if (!HC_URL) return;
  const url = success ? HC_URL : HC_URL + '/fail';
  try { fetch(url).catch(() => {}); } catch (e) { /* ignore */ }
}

async function main() {
  log('mode=%s ver=%s evoWhitelist=%s', MODE, VER, WHITELIST.join(','));

  // ① 球员数量（浏览器）
  const player = await getPlayerCount();
  let playerCount = null;
  if (player.ok) playerCount = player.playerCount;

  // ② SBC 总数（轻量 HTTP，GitHub 直连 200）
  const s = await getJson(SBC_URL);
  let sbcTotal = null;
  if (s.ok && s.data) {
    if (s.data.data && typeof s.data.data.totalCount === 'number') sbcTotal = s.data.data.totalCount;
    else if (typeof s.data.totalCount === 'number') sbcTotal = s.data.totalCount;
  }
  log('sbc status=%s totalCount=%s', s.status, sbcTotal);

  // ③ 进化 hash（轻量 HTTP，manifest）
  const m = await getJson(`${R2_BASE}/manifest.json`);
  let manifest = null;
  if (m.ok && m.data && typeof m.data === 'object') manifest = m.data;
  log('manifest status=%s keys=%s', m.status, manifest ? Object.keys(manifest).length : '-');
  const manifestHashes = {};
  if (manifest) {
    for (const k of WHITELIST) {
      if (k in manifest) manifestHashes[k] = manifest[k];
    }
  }

  const current = {
    ts: Date.now(),
    playerStatus: player.ok ? player.status : (player.status || -1),
    sbcStatus: s.status,
    manifestStatus: m.status,
    playerCount,
    sbcTotal,
    manifestHashes
  };

  let baseline = {};
  try { baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8')); } catch (e) { baseline = {}; }
  const firstRun = Object.keys(baseline).length === 0;

  if (firstRun) {
    log('FIRST_RUN: seeding baseline, no dispatch');
    fs.writeFileSync(BASELINE_PATH, JSON.stringify(current, null, 2));
    log('seeded: playerCount=%s sbcTotal=%s evoHashes=%s', playerCount, sbcTotal, JSON.stringify(manifestHashes));
    pingHC(true);
    return;
  }

  // 变化检测
  let changed = false; const reasons = [];
  if (!player.ok && sbcTotal == null && Object.keys(manifestHashes).length === 0) {
    log('NO_SOURCE_AVAILABLE: 三条信号全失败，fail-open 不触发');
    pingHC(false);
    return;
  }
  if (player.ok && baseline.playerCount != null && playerCount !== baseline.playerCount) {
    changed = true; reasons.push(`player:count ${baseline.playerCount}->${playerCount}`);
  }
  if (sbcTotal != null && baseline.sbcTotal != null && sbcTotal !== baseline.sbcTotal) {
    changed = true; reasons.push(`sbc:${baseline.sbcTotal}->${sbcTotal}`);
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
  // 有球员信号但基线里没有（罕见）：视为需触发
  if (player.ok && !('playerCount' in baseline) && baseline.playerCount == null) {
    reasons.push('no-player-baseline'); changed = true;
  }
  log('changed=%s reasons=%s', changed, reasons.join(' | ') || '(none)');

  // observe / reseed：都只写 baseline、永不 dispatch。
  // 保护：若球员数量没抓到成功(playerCount=null)，绝不拿 null 覆盖旧基线，否则下次探针会误触发。
  //   reseed 由 job1 每日同步后调用，目的就是"锚定基线"，更不能被一次 CF 抖动污染。
  if (MODE === 'observe' || MODE === 'reseed') {
    const tag = MODE.toUpperCase();
    if (player.ok && playerCount != null) {
      log('%s: 写 baseline，不 dispatch', tag);
      fs.writeFileSync(BASELINE_PATH, JSON.stringify(current, null, 2));
      log('baseline: playerCount=%s sbcTotal=%s evoHashes=%s', playerCount, sbcTotal, JSON.stringify(manifestHashes));
    } else {
      log('%s: 球员数量未取到(playerCount=%s)，跳过写 baseline，保留旧值防误触发', tag, playerCount);
    }
    pingHC(true);
    return;
  }

  if (changed) {
    // 60min in-flight / 近期去重：避免一小时内重复 dispatch
    if (GH_TOKEN) {
      try {
        const api = `https://api.github.com/repos/${DISPATCH_REPO}/actions/workflows/${DISPATCH_WF}/runs?per_page=5`;
        const r = await fetch(api, { headers: { Authorization: `Bearer ${GH_TOKEN}`, Accept: 'application/vnd.github+json' } });
        if (r.ok) {
          const j = await r.json();
          const now = Date.now();
          const recent = (j.workflow_runs || []).filter(run => {
            const st = run.status;
            const created = new Date(run.created_at).getTime();
            if (st === 'queued' || st === 'in_progress') return true;
            if (st === 'completed' && now - created < 60 * 60 * 1000) return true;
            return false;
          });
          if (recent.length > 0) {
            log('IN_FLIGHT/RECENT fetch run 存在 (%d)，跳过 dispatch 防重复', recent.length);
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

  // 持久化 baseline，避免重复误报
  fs.writeFileSync(BASELINE_PATH, JSON.stringify(current, null, 2));
  pingHC(true);
}

main().catch(e => { console.error(e); process.exit(1); });
