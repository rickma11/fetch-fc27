// 北京时间（UTC+8，固定无夏令时）时间渲染工具 —— meta_fc{ver} 元文档「控制台可直读」用。
//
// 背景：`meta_fc{ver}` 的时间字段（fetchedAt / updatedAt / ts）一律以 **UTC** 写入
//   （`toISOString()` 带 Z，或 epoch 毫秒），而**微信云开发控制台不做时区换算**，
//   原样显示存量字符串 ⇒ 看控制台时要自己 +8 小时（且常跨天），极易误判。
//
// 本模块把任意时间值渲染成 `YYYY-MM-DD HH:mm:ss (北京)` 字符串，供各写入脚本在元文档里
//   额外写一个 `*Cn` 字段（fetchedAtCn / updatedAtCn / tsCn），控制台一眼可读。
//
// ⚠️ 纯展示字段：不替换、不影响原有字段，无任何消费方依赖（端上/CI 只读 fetchedAt/ts/fileID…）。
// ⚠️ 用固定 +8 偏移计算，不依赖运行环境的本地时区（CI runner 默认 UTC，端上/本机各不同）。
//
// 入参：Date | epoch 毫秒(number) | ISO 或任意可被 Date 解析的字符串。
// 返回：`YYYY-MM-DD HH:mm:ss (北京)`；入参为空/非法时返回 ''。

function cn(v) {
  if (v == null || v === '') return '';
  const d = (v instanceof Date) ? v : new Date(typeof v === 'number' ? v : String(v));
  if (isNaN(d.getTime())) return '';
  const t = new Date(d.getTime() + 8 * 3600 * 1000);   // 移到北京墙上时间，再用 getUTC* 读取
  const p = function (n) { return (n < 10 ? '0' : '') + n; };
  return t.getUTCFullYear() + '-' + p(t.getUTCMonth() + 1) + '-' + p(t.getUTCDate()) + ' ' +
    p(t.getUTCHours()) + ':' + p(t.getUTCMinutes()) + ':' + p(t.getUTCSeconds()) + ' (北京)';
}

module.exports = { cn: cn };
