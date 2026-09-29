// 纯函数回归测试：warm_roster.js 的 O3/O4 分档打包（buildTieredPacks / chooseSlices）。
// 因 warm_roster.js 有 require.main === module 守卫，这里 require 不会触发云端调用，可安全在 node 下单测。
// 用法：node scripts/test_tiered_roster.js
const assert = require('assert');
const WR = require('./warm_roster.js');

const MAX_PART_ZIP = 2 * 1024 * 1024;

// 造 20000 个假球员，overall 覆盖三档，且制造一些「同总评」以保证排序稳定
function fakePlayers(n) {
  const arr = [];
  for (let i = 0; i < n; i++) {
    // 分布：~22% 85+，~35% 75-84，~43% <75
    let o;
    const r = (i * 9301 + 49297) % 233280 / 233280; // 确定性的伪随机
    if (r < 0.22) o = 85 + (i % 11);          // 85..95
    else if (r < 0.57) o = 75 + (i % 10);     // 75..84
    else o = 50 + (i % 25);                    // 50..74
    arr.push({ eaId: 'p' + i, commonName: 'P' + i, overall: o, rarity: { name: 'Gold' } });
  }
  return arr;
}

console.log('== chooseSlices ==');
{
  // 小数据集：应落在候选 [1,2,4,8] 中第一个满足体积上限的
  const small = fakePlayers(500);
  const sl = WR.chooseSlices(small);
  assert.ok(sl.length >= 1 && sl.length <= 8, 'slice 数应在 [1,8]');
  let total = 0; sl.forEach(function (s) { total += s.length; });
  assert.strictEqual(total, small.length, 'chooseSlices 切片应覆盖全部球员');
  // 每片压缩后 ≤ MAX_PART_ZIP
  const ziplite = require('./ziplite');
  let maxZip = 0;
  sl.forEach(function (s, i) {
    const z = ziplite.zipOne('x' + i + '.json', Buffer.from(JSON.stringify({ players: s }), 'utf8')).length;
    if (z > maxZip) maxZip = z;
  });
  assert.ok(maxZip <= MAX_PART_ZIP, 'chooseSlices 最大子片应 ≤ MAX_PART_ZIP，实际 ' + maxZip);
  console.log('  chooseSlices OK: ' + sl.length + ' 片, maxZip=' + Math.round(maxZip / 1024) + 'KB');

  // 大数据集：每片塞「不可压缩」填充字段把原始体积顶过 2MB，验证会拆成多片且「按 tierIndex 拼接」保序
  const big = [];
  for (let i = 0; i < 6000; i++) {
    // pad 用真随机字符（每球员、每字符独立）→ deflate 跨球员无法找到匹配，才能真实把单片顶过 2MB
    let pad = '';
    for (let k = 0; k < 1200; k++) pad += String.fromCharCode(97 + Math.floor(Math.random() * 26));
    big.push({ eaId: 'b' + i, commonName: 'B' + i, overall: 99 - (i % 50), pad: pad });
  }
  big.sort(function (a, b) { return b.overall - a.overall; }); // 输入已是 overall 降序
  const sl2 = WR.chooseSlices(big);
  assert.ok(sl2.length > 1, '大数据集应拆成多片，实际 ' + sl2.length);
  let maxZip2 = 0;
  sl2.forEach(function (s, i) {
    const z = ziplite.zipOne('x' + i + '.json', Buffer.from(JSON.stringify({ players: s }), 'utf8')).length;
    if (z > maxZip2) maxZip2 = z;
  });
  assert.ok(maxZip2 <= MAX_PART_ZIP, '多片时最大子片仍应 ≤ MAX_PART_ZIP，实际 ' + maxZip2);
  // 拼接各片（按返回顺序即 tierIndex 顺序）应与原 big 完全一致（保序断言）
  const merged = [].concat.apply([], sl2);
  assert.strictEqual(merged.length, big.length, '多片拼接人数应一致');
  let orderOk = true;
  for (let i = 0; i < merged.length; i++) {
    if (merged[i].eaId !== big[i].eaId) { orderOk = false; break; }
  }
  assert.ok(orderOk, '按 tierIndex 拼接应保持 overall 降序（与输入顺序一致）');
  console.log('  chooseSlices 多片 OK: ' + sl2.length + ' 片, maxZip=' + Math.round(maxZip2 / 1024) + 'KB, 拼接保序通过');
}

console.log('== buildTieredPacks ==');
let res;
{
  const all = fakePlayers(20000);
  const ts = 1700000000000;
  res = WR.buildTieredPacks(all, { Gold: 'rarity_gold.webp' }, ts);

  // 1) parts = 三档子片数之和
  assert.strictEqual(res.parts, res.tierParts.reduce(function (a, b) { return a + b; }, 0), 'parts 应等于三档子片数之和');

  // 2) 每片 head 带 tier/tierIndex/tierParts，且 tier 与全局 part 区间一致
  const tp = res.tierParts;
  assert.strictEqual(res.packs.length, res.parts, 'packs 数组长度应等于 parts');
  res.packs.forEach(function (p, gi) {
    assert.strictEqual(p.tier, gi < tp[0] ? 0 : (gi < tp[0] + tp[1] ? 1 : 2), 'part ' + gi + ' 的 tier 标签应正确');
    assert.ok(p.tierIndex >= 0 && p.tierIndex < tp[p.tier], 'tierIndex 应在档内范围');
    assert.strictEqual(p.tierParts, tp[p.tier], 'tierParts 应等于该档子片总数');
  });

  // 3) 体积：最大单片 ≤ MAX_PART_ZIP；总压缩远小于原始
  assert.ok(res.maxZip <= MAX_PART_ZIP, '最大单片应 ≤ MAX_PART_ZIP，实际 ' + res.maxZip);
  assert.ok(res.zipTotal < res.rawTotal, '压缩后应变小');

  // 4) 三档计数与过滤口径一致
  let c0 = 0, c1 = 0, c2 = 0;
  all.forEach(function (p) {
    const o = p.overall || 0;
    if (o >= 85) c0++; else if (o >= 75 && o <= 84) c1++; else c2++;
  });
  // 每个 pack 的 players 字段是「该子片人数」，按 tier 累加应等于 c0/c1/c2
  let s0 = 0, s1 = 0, s2 = 0;
  res.packs.forEach(function (p) {
    if (p.tier === 0) s0 += p.players; else if (p.tier === 1) s1 += p.players; else s2 += p.players;
  });
  assert.strictEqual(s0, c0, 'tier0 人数应等于 85+ 过滤数');
  assert.strictEqual(s1, c1, 'tier1 人数应等于 75-84 过滤数');
  assert.strictEqual(s2, c2, 'tier2 人数应等于 <75 过滤数');

  console.log('  buildTieredPacks OK: parts=' + res.parts +
    ' tiers=' + JSON.stringify(res.tierParts) +
    ' maxZip=' + Math.round(res.maxZip / 1024) + 'KB' +
    ' zipTotal=' + Math.round(res.zipTotal / 1024) + 'KB' +
    ' rawTotal=' + Math.round(res.rawTotal / 1048576) + 'MB' +
    ' | 档计数 [85+=' + s0 + ', 75-84=' + s1 + ', <75=' + s2 + ']');
}

console.log('\nALL TIERED ROSTER TESTS PASSED');
