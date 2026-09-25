// SBC set 封面「任务表」构建（纯函数，零副作用，可单测）。
// 从 sync_sbc_covers.js 抽出来（2026-09-26）：那份是 IIFE、require 即跑浏览器，没法喂数据做回放；
// 封面任务表是最容易「悄悄漏一组 set ⇒ 端上永久黑块」的地方，必须能被真实数据回放。
//
// 两条来源：
//   ① 正常：set.imagePath（如 2027/sbcs/5265.png）→ 文件名 sbc_<imagePath 里的 id>.webp
//   ② 兜底（2026-09-26）：set.imagePath **缺失**时补来源
//        α. 球员类（如 "Antonio Nusa"）：imageUrl 是 fut.gg 外域球员卡面 URL
//        β. 升级类（如 "TOTW Upgrade"）：两者皆空，只有 challenges[].imagePath 可用
//      此前这两类完全不进任务表 ⇒ 端上按 sbc_<id>.webp 拼 fileID 必 404 ⇒ 真机永久黑块。
//
// 命名口径必须与端上同源：eafc-miniapp/utils/sbcs.js#buildCard 用 **set.id**（不是 _id）拼
// sbc_<setId>.webp ⇒ 这里 fileName 也一律 'sbc_' + id + '.webp'，id 取 set.id（兜底路径用 s.id）。
// CDN 常量与 imgdl 一致：2026-09-19 起用原始图路径（cdn-cgi/image/... 转换路由对该站返回 400）。

const CDN = 'https://game-assets.fut.gg/';
// 2026-09-19：改用原始图路径。此前拼 cdn-cgi/image/...background=151a23 转换路由，当天起该路由
// 对本站返回 400（实锤：同会话 raw 200 / transform 400）→ 三通道全挂。透明底改由端上深色卡面
// 背景色兜住（.sb-cover/.hd-cover 均有深色 background），不再依赖 CDN 合成底色。
const TRANSFORM = '';

// 从 imagePath（如 2027/sbcs/1434.png）提取 set 数字 id
function setIdOf(imagePath) {
  const base = String(imagePath || '').split('/').pop();
  const m = /(\d+)\.png$/i.exec(base);
  return m ? m[1] : '';
}

// sets（sbcs.json#sets 或 sbcs_fc27 文档数组）→ 去重后的封面任务列表
//   每项：{ id, imagePath(指纹 key), fileName, srcUrl, fallback }
//   fallback=true 表示这条来自「imagePath 缺失」的兜底路径（日志可区分）。
// ⚠️ 去重口径＝id（同一 set 不会传两次）；无任何来源的 set 直接跳过并记 WARN 日志。
function buildCoverTasks(sets) {
  const list = Array.isArray(sets) ? sets : [];
  const seen = {};
  const tasks = [];
  const pushTask = function (t) {
    if (!t || !t.id || seen[t.id]) return;
    seen[t.id] = 1;
    tasks.push(t);
  };
  const rel = function (p) { return String(p).replace(/^\/+/, ''); };

  list.forEach(function (s) {
    const ip = s && s.imagePath;
    if (!ip) return;
    const id = setIdOf(ip);
    if (!id) return;
    pushTask({
      id: id,
      imagePath: String(ip),
      fileName: 'sbc_' + id + '.webp',
      srcUrl: CDN + TRANSFORM + rel(ip),
      fallback: false
    });
  });

  list.forEach(function (s) {
    if (!s || s.imagePath) return;   // 只补 imagePath 缺失的
    const id = String((s.id != null ? s.id : '') || '').trim();
    if (!id) return;
    const ch = (Array.isArray(s.challenges) ? s.challenges : []).filter(function (c) { return c && c.imagePath; })[0];
    const srcUrl = s.imageUrl ? String(s.imageUrl)
      : (ch ? CDN + TRANSFORM + rel(ch.imagePath) : '');
    if (!srcUrl) return;             // 无来源：宁可不传，也不要传一个空 URL 把指纹表污染
    pushTask({
      id: id,
      imagePath: String(s.imageUrl || (ch && ch.imagePath) || ''),  // 指纹 key，只要不撞已有条目即可
      fileName: 'sbc_' + id + '.webp',
      srcUrl: srcUrl,
      fallback: true
    });
  });
  return tasks;
}

module.exports = { CDN: CDN, TRANSFORM: TRANSFORM, setIdOf: setIdOf, buildCoverTasks: buildCoverTasks };
