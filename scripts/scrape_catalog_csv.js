// 抓取 fut.gg 的 SBC / Objectives(目标) / Evolutions(进化) 目录，
// 按 createdAt/startTime 过滤「最近 N 天」，输出中英对照所需的【英文】目录 CSV。
//
// 设计（复用 OAO 现有管线机制）：
//   - 真实 Chromium 过 Cloudflare（与 scrape_sbc_evolutions.js 同套）。
//   - SBC    = https://www.fut.gg/api/fut/sbc/{ver}?page=N        （分页）
//   - OBJ    = https://www.fut.gg/api/fut/objectives/{ver}?page=N （分页，端点待 CF 放行后确认）
//   - EVO    = https://r2.fut.gg/{ver}/manifest.json -> {active,all}-evolutions.v1.{hash}.json
//
// 输出（与 _fodder_rev/merge_catalog_csv.js 同格式，可直接合并）：
//   ea_catalog_en_<YYYY-MM-DD>.csv   列：type,id,name,startTime,endTime,extra
//   ea_catalog_en_<YYYY-MM-DD>.json  原始抓取（便于排错/补抓）
//
// 用法：
//   node scripts/scrape_catalog_csv.js --ver 27 --days 3
// 失败语义：单个数据源抓取失败不致命（记录 errors[]），只写出成功部分；CF 完全没过才 exit 1。

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const UA = process.env.CF_UA || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36';

// ---- 参数 ----
function parseArgs(argv) {
  const o = { ver: parseInt(process.env.FC_VER, 10) || 27, days: 3 };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--ver') o.ver = parseInt(argv[++i], 10) || 27;
    else if (a === '--days') o.days = parseInt(argv[++i], 10) || 3;
    else if (a === '--out') o.out = argv[++i];
    else if (a === '--no-obj') o.noObj = true;
    else if (a === '--no-sbc') o.noSbc = true;
    else if (a === '--no-evo') o.noEvo = true;
  }
  if (!o.out) o.out = path.resolve(__dirname, '..', 'catalog');
  return o;
}
const ARGS = parseArgs(process.argv);
const VER = ARGS.ver;
const DAYS = ARGS.days;
const NOW = Date.now();
const CUTOFF = NOW - DAYS * 24 * 3600 * 1000;

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---- CSV 转义 ----
function csvCell(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}
function csvLine(arr) { return arr.map(csvCell).join(','); }

// ---- 从一条记录里抽「日期」字段 ----
function pickDate(item) {
  for (const k of ['createdAt', 'startTime', 'startDate', 'releaseDate', 'start']) {
    if (item[k]) { const t = Date.parse(item[k]); if (!isNaN(t)) return t; }
  }
  return null;
}
function pickEnd(item) {
  for (const k of ['endTime', 'endDate', 'end', 'endSubmissionTime']) {
    if (item[k]) return item[k];
  }
  return '';
}

(async () => {
  if (!fs.existsSync(ARGS.out)) fs.mkdirSync(ARGS.out, { recursive: true });

  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox', '--disable-dev-shm-usage']
  });
  const ctx = await browser.newContext({
    userAgent: UA, locale: 'en-US', viewport: { width: 1280, height: 800 }, timezoneId: 'America/New_York'
  });
  const page = await ctx.newPage();
  page.on('console', m => { const t = m.text(); if (/error|fail/i.test(t)) console.log('[browser]', t); });

  console.log('打开 fut.gg 过 Cloudflare ...');
  await page.goto('https://www.fut.gg/sbc/', { waitUntil: 'domcontentloaded', timeout: 60000 });

  // 轮询 SBC 第 1 页确认 CF 通关
  let passed = false;
  const probeUrl = `https://www.fut.gg/api/fut/sbc/${VER}?page=1`;
  for (let i = 0; i < 30; i++) {
    let status = -1;
    try {
      status = await page.evaluate(async (u) => {
        try { const r = await fetch(u, { headers: { Accept: 'application/json' } }); return r.status; }
        catch (e) { return -1; }
      }, probeUrl);
    } catch (e) { status = -2; }
    if (status === 200) { passed = true; console.log(`Cloudflare 已通过（第 ${i + 1} 次），SBC 端点可达`); break; }
    if (status === 404) { console.log('SBC 端点 404（该版本可能尚未上线 SBC）'); break; }
    console.log(`等待 Cloudflare 挑战解除... status=${status} (${i + 1}/30)`);
    await page.waitForTimeout(3000);
  }
  if (!passed) {
    console.error('未能确认 Cloudflare 通过（SBC 端点未返回 200）。退出。');
    await browser.close();
    process.exit(1);
  }

  const errors = [];
  const fetchedAt = new Date().toISOString();
  const rows = [];   // {type,id,name,startTime,endTime,extra}

  // ---------- SBC ----------
  if (!ARGS.noSbc) {
    try {
      const res = await page.evaluate(async (ver) => {
        const BASE = `https://www.fut.gg/api/fut/sbc/${ver}`;
        const sleep = ms => new Promise(r => setTimeout(r, ms));
        const sets = [];
        let page = 1, totalPages = 1, totalCount = 0;
        while (page <= totalPages) {
          const r = await fetch(`${BASE}?page=${page}`, { headers: { Accept: 'application/json' } });
          if (!r.ok) throw new Error(`SBC page ${page} status=${r.status}`);
          const j = await r.json();
          const arr = Array.isArray(j.data) ? j.data : [];
          sets.push(...arr);
          if (typeof j.totalPages === 'number') totalPages = j.totalPages;
          if (typeof j.totalCount === 'number') totalCount = j.totalCount;
          page++;
          if (page <= totalPages) await sleep(400);
        }
        return { totalCount, count: sets.length, sets };
      }, VER);
      console.log(`SBC 实抓 ${res.count}/${res.totalCount || '?'}`);
      for (const s of res.sets) {
        const d = pickDate(s);
        if (d === null || d < CUTOFF) continue;
        rows.push({
          type: 'SBC', id: s.eaId ?? s.id, name: s.name || '',
          startTime: s.createdAt || '', endTime: s.endTime || '',
          extra: `挑战${s.challengesCount ?? '?'} ${s.isRepeatable ? '可重复' : '单次'}`
        });
      }
      console.log(`  -> 最近 ${DAYS} 天 SBC: ${rows.filter(r => r.type === 'SBC').length} 条`);
    } catch (e) { errors.push({ source: 'sbc', message: e.message }); console.error('SBC 抓取失败：', e.message); }
  }

  // ---------- Objectives(目标) ----------
  if (!ARGS.noObj) {
    try {
      const res = await page.evaluate(async (ver) => {
        const BASE = `https://www.fut.gg/api/fut/objectives/${ver}`;
        const sleep = ms => new Promise(r => setTimeout(r, ms));
        const items = [];
        let page = 1, totalPages = 1, totalCount = 0;
        while (page <= totalPages) {
          const r = await fetch(`${BASE}?page=${page}`, { headers: { Accept: 'application/json' } });
          if (!r.ok) throw new Error(`OBJ page ${page} status=${r.status}`);
          const j = await r.json();
          const arr = Array.isArray(j.data) ? j.data : (Array.isArray(j) ? j : []);
          items.push(...arr);
          if (typeof j.totalPages === 'number') totalPages = j.totalPages;
          if (typeof j.totalCount === 'number') totalCount = j.totalCount;
          if (totalPages <= 1) break;       // 单页或无分页信息则停止
          page++;
          if (page <= totalPages) await sleep(400);
        }
        return { totalCount, count: items.length, items };
      }, VER);
      console.log(`OBJ 实抓 ${res.count}/${res.totalCount || '?'}`);
      for (const o of res.items) {
        const d = pickDate(o);
        if (d === null || d < CUTOFF) continue;
        rows.push({
          type: 'OBJ', id: o.eaId ?? o.id, name: o.name || o.title || '',
          startTime: (o.createdAt || o.startTime || ''), endTime: pickEnd(o),
          extra: (o.categoryName || o.groupName || '')
        });
      }
      console.log(`  -> 最近 ${DAYS} 天 OBJ: ${rows.filter(r => r.type === 'OBJ').length} 条`);
    } catch (e) { errors.push({ source: 'objectives', message: e.message }); console.error('OBJ 抓取失败：', e.message); }
  }

  // ---------- Evolutions(进化) ----------
  if (!ARGS.noEvo) {
    try {
      const res = await page.evaluate(async (ver) => {
        const sleep = ms => new Promise(r => setTimeout(r, ms));
        const manUrl = `https://r2.fut.gg/${ver}/manifest.json`;
        const mr = await fetch(manUrl, { headers: { Accept: 'application/json' } });
        if (!mr.ok) throw new Error(`manifest status=${mr.status}`);
        const manifest = await mr.json();
        const all = [];
        for (const key of ['active-evolutions', 'all-evolutions']) {
          const hash = manifest[key];
          if (!hash || hash === 'd7517139') continue;
          const url = `https://r2.fut.gg/${ver}/${key}.v1.${hash}.json`;
          const r = await fetch(url, { headers: { Accept: 'application/json' } });
          if (!r.ok) throw new Error(`${key} status=${r.status}`);
          const arr = await r.json();
          const list = Array.isArray(arr) ? arr : (arr.data || []);
          all.push(...list);
          await sleep(300);
        }
        return { count: all.length, all };
      }, VER);
      console.log(`EVO 实抓 ${res.count}`);
      for (const e of res.all) {
        const d = pickDate(e);
        if (d === null || d < CUTOFF) continue;
        rows.push({
          type: 'EVO', id: e.eaId ?? e.id, name: e.name || '',
          startTime: e.createdAt || '', endTime: e.endTime || e.endSubmissionTime || '',
          extra: `币${e.coinsCost ?? 0}${e.isTimed ? ' 限时' : ''}`
        });
      }
      console.log(`  -> 最近 ${DAYS} 天 EVO: ${rows.filter(r => r.type === 'EVO').length} 条`);
    } catch (e) { errors.push({ source: 'evolutions', message: e.message }); console.error('EVO 抓取失败：', e.message); }
  }

  await browser.close();

  // 去重：进化同时出现在 active + all 里会重复；同一 (type,id) 只保留一条
  const seen = new Set();
  const dedup = [];
  for (const r of rows) {
    const k = `${r.type}|${r.id}`;
    if (seen.has(k)) continue;
    seen.add(k);
    dedup.push(r);
  }
  rows = dedup;

  // 排序：startTime 倒序（新->旧）
  rows.sort((a, b) => (Date.parse(b.startTime) || 0) - (Date.parse(a.startTime) || 0));

  const date = new Date().toISOString().slice(0, 10);
  const csvName = `ea_catalog_en_${date}.csv`;
  const jsonName = `ea_catalog_en_${date}.json`;
  const csvPath = path.join(ARGS.out, csvName);
  const jsonPath = path.join(ARGS.out, jsonName);

  const header = ['type', 'id', 'name', 'startTime', 'endTime', 'extra'];
  const csv = [csvLine(header), ...rows.map(r => csvLine([r.type, r.id, r.name, r.startTime, r.endTime, r.extra]))].join('\n');
  fs.writeFileSync(csvPath, '﻿' + csv);   // BOM 便于 Excel 中文
  fs.writeFileSync(jsonPath, JSON.stringify({ ver: VER, fetchedAt, days: DAYS, cutoff: new Date(CUTOFF).toISOString(), rows, errors }, null, 2));

  console.log('===== 抓取摘要 =====');
  console.log(`总条数(最近 ${DAYS} 天): ${rows.length} (SBC ${rows.filter(r => r.type === 'SBC').length} / OBJ ${rows.filter(r => r.type === 'OBJ').length} / EVO ${rows.filter(r => r.type === 'EVO').length})`);
  console.log('CSV  ->', csvPath);
  console.log('JSON ->', jsonPath);
  if (errors.length) console.error('存在抓取错误（已写出成功部分）：', JSON.stringify(errors));
})().catch(e => { console.error('FATAL', e); process.exit(1); });
