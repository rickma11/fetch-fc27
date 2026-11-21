#!/usr/bin/env node
'use strict';
// 回归测试：探针「保留变化信号」+ 进化写库「价格守卫」两个纯函数。
// 跑法：cd fetch-fc27 && node scripts/evo_price_guard_test.js
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log('  PASS', name); }
  else { fail++; console.error('  FAIL', name); }
}

// ── 1. shouldKeepBaseline（probe_futgg.js 有 require.main 保护，可安全 require）──
const probe = require('./probe_futgg.js');
const keep = probe.shouldKeepBaseline;
ok(typeof keep === 'function', 'shouldKeepBaseline 已导出');
if (typeof keep === 'function') {
  ok(keep({ action: 'skip', blocking: 1 }, true) === true, 'skip+blocking+changed → 保留旧baseline');
  ok(keep({ action: 'skip', blocking: 2 }, true) === true, 'skip+blocking>1+changed → 保留');
  ok(keep({ action: 'skip', blocking: 1 }, false) === false, 'skip+blocking但无变化 → 写baseline');
  ok(keep({ action: 'skip', blocking: 0 }, true) === false, 'skip无blocking → 写baseline');
  ok(keep({ action: 'change', blocking: 0 }, true) === false, 'change → 写baseline');
  ok(keep({ action: 'retry', blocking: 0 }, true) === false, 'retry → 写baseline');
  ok(keep(null, true) === false, 'decision为空 → 写baseline');
}

// ── 2. guardEvoPrice（upload_db.js 是 IIFE，不能 require；从源码提取纯函数求值）──
const upSrc = fs.readFileSync(path.join(__dirname, 'upload_db.js'), 'utf8');
const s = upSrc.indexOf('const EVO_COST_FIELDS');
const e = upSrc.indexOf('async function uploadEvolutions');
ok(s >= 0 && e > s, 'upload_db.js 中定位到 guardEvoPrice 定义');
if (s >= 0 && e > s) {
  const guard = new Function(upSrc.slice(s, e) + '\nreturn guardEvoPrice;')();
  ok(typeof guard === 'function', 'guardEvoPrice 提取成功');
  const n = (v) => { const x = Number(v); return isFinite(x) && x > 0 ? x : 0; };

  let d = { coinsCost: 0, pointsCost: 0, tokenCost: 0 };
  guard(d, { tokenCost: 300, eventTokenId: 4 });
  ok(n(d.tokenCost) === 300 && d.eventTokenId === 4, '占位0+旧价300 → 沿用300并补事件币id');

  d = { coinsCost: 0, pointsCost: 0, tokenCost: 600 };
  guard(d, { tokenCost: 300 });
  ok(n(d.tokenCost) === 600, '新价600+旧价300 → 保留新价600（不降级）');

  d = { coinsCost: 0, pointsCost: 0, tokenCost: 0 };
  guard(d, null);
  ok(n(d.tokenCost) === 0, '云库无旧记录 → 保持原样');

  d = { coinsCost: 0, pointsCost: 0, tokenCost: 0, isRewardEvolution: false };
  guard(d, { coinsCost: 50, pointsCost: 20, isRewardEvolution: true });
  ok(n(d.coinsCost) === 50 && n(d.pointsCost) === 20 && d.isRewardEvolution === true,
    '金币/绿点/奖励标记回填');

  d = { coinsCost: 10, pointsCost: 0, tokenCost: 0 };
  const before = JSON.stringify(d);
  guard(d, { coinsCost: 50, pointsCost: 20 });
  ok(n(d.coinsCost) === 10 && n(d.pointsCost) === 20 && JSON.stringify(d) !== before,
    '逐字段：新>0的不动、新=0的沿用旧');
}

console.log('\n结果:', pass, 'PASS /', fail, 'FAIL');
process.exit(fail ? 1 : 0);
