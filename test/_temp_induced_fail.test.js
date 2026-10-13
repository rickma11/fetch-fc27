// 临时文件：受控验证 Plan A（continue-on-error 放行发布）
// 本文件会被 CI 跑出失败，目的是实测「单测失败不阻断下游 scrape/上云/落库」。
// 验证完成后由脚本删除并回滚 package.json。
const assert = require('assert');
assert.fail('INDUCED FAILURE for Plan A verification: unit-test failure must NOT block downstream publish');
