'use strict';
// 探针失败自愈决策单测（纯函数 decideDispatch，无需网络）。
// 运行：node test/probe_retry.test.js
const assert = require('assert');
const { decideDispatch } = require('../scripts/probe_futgg');

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
function runAt(msAgo) { return { status: 'completed', conclusion: 'success', created_at: new Date(Date.now() - msAgo).toISOString() }; }

let pass = 0, fail = 0;
function check(name, actual, expect) {
  try { assert.strictEqual(actual, expect, name); console.log('  ✓', name); pass++; }
  catch (e) { console.log('  ✗', name, '->', e.message); fail++; }
}

console.log('== decideDispatch 单测 ==');

// 1. 真实变化 + 无 run → change
check('变化无run=change', decideDispatch({ changed: true, runs: [], now: Date.now(), retryWindowMs: 6 * HOUR }).action, 'change');

// 2. 无变化无 run → skip
check('无变化无run=skip', decideDispatch({ changed: false, runs: [], now: Date.now(), retryWindowMs: 6 * HOUR }).action, 'skip');

// 3. 无变化 + 最近失败(窗口内) → retry
check('失败窗口内=retry', decideDispatch({ changed: false, runs: [{ status: 'completed', conclusion: 'failure', created_at: new Date(Date.now() - 1 * HOUR).toISOString() }], now: Date.now(), retryWindowMs: 6 * HOUR }).action, 'retry');

// 4. 无变化 + 失败但超窗口 → skip
check('失败超窗口=skip', decideDispatch({ changed: false, runs: [{ status: 'completed', conclusion: 'failure', created_at: new Date(Date.now() - 7 * HOUR).toISOString() }], now: Date.now(), retryWindowMs: 6 * HOUR }).action, 'skip');

// 5. 无变化 + 1h 内成功 → skip (blocking)
check('1h内成功=skip', decideDispatch({ changed: false, runs: [runAt(30 * 60 * 1000)], now: Date.now(), retryWindowMs: 6 * HOUR }).action, 'skip');

// 6. 无变化 + 在途(run in_progress) → skip (blocking)
check('在途=skip', decideDispatch({ changed: false, runs: [{ status: 'in_progress', conclusion: null, created_at: new Date(Date.now() - 5 * 60 * 1000).toISOString() }], now: Date.now(), retryWindowMs: 6 * HOUR }).action, 'skip');

// 7. 变化 + 最近失败(窗口内) → 仍 change（变化优先，避免被自愈抢占语义）
check('变化+失败=change', decideDispatch({ changed: true, runs: [{ status: 'completed', conclusion: 'failure', created_at: new Date(Date.now() - 1 * HOUR).toISOString() }, runAt(2 * HOUR)], now: Date.now(), retryWindowMs: 6 * HOUR }).action, 'change');

// 8. 无变化 + 失败(窗口内) 但存在在途 run → skip（自愈被去重护栏挡掉，避免重复触发）
check('失败+在途=skip', decideDispatch({ changed: false, runs: [{ status: 'completed', conclusion: 'failure', created_at: new Date(Date.now() - 1 * HOUR).toISOString() }, { status: 'in_progress', conclusion: null, created_at: new Date(Date.now() - 5 * 60 * 1000).toISOString() }], now: Date.now(), retryWindowMs: 6 * HOUR }).action, 'skip');

// 9. blocking 计数正确（在途 1 个）
check('blocking计数', decideDispatch({ changed: false, runs: [{ status: 'queued', conclusion: null, created_at: new Date(Date.now() - 5 * 60 * 1000).toISOString() }], now: Date.now(), retryWindowMs: 6 * HOUR }).blocking, 1);

// 10. 失败 run 不算 blocking（retry 不应被失败的自己挡掉）
check('失败不算blocking', decideDispatch({ changed: false, runs: [{ status: 'completed', conclusion: 'failure', created_at: new Date(Date.now() - 1 * HOUR).toISOString() }], now: Date.now(), retryWindowMs: 6 * HOUR }).blocking, 0);

console.log('\n结果: ' + pass + ' 过 / ' + fail + ' 败');
process.exit(fail > 0 ? 1 : 0);
