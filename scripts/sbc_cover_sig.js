// SBC set 封面「内容指纹 → 是否需要上传」判定（2026-09-22 方案 A｜最小）。
//
// 为什么单独成模块：sync_sbc_covers.js 是个 IIFE 脚本（require 即整条流水线开跑、还会 process.exit），
// 里面的逻辑没法被单测直接调用。而这套判定一旦写错，形态是「**静默漏传**」——
// 某张封面永远不再上传、端上长期缺图，且失败时没有任何日志。所以必须抽出来真测。
//
// 判据：把「本地下载到的字节」算一个 sha1 指纹，与上轮清单里的指纹比。
//   一致 → 云上已是最新的同一份内容 → 跳过上传（省掉每天 5~6 分钟的重复 PUT）。
//   不一致 / 清单里没有 → 上传；**上传成功后**才把指纹记进新清单。
//
// ⚠️ 两个不可犯的错：
//   ① 上传失败绝不能记指纹（会被下轮误判为「已同步」而永久漏传）；
//   ② 指纹算的是**内容**，不是文件名/时间戳：imgdl 直接 writeFileSync 原始响应体、不转码，
//      所以同一 imagePath 的指纹稳定；将来若换 CDN 转换路由，内容变 → 指纹变 → 自动重传。
'use strict';

const fs = require('fs');
const crypto = require('crypto');

// 与 images.js#imgSigOf 同族：sha1 取前 16 位十六进制（够用且短）
function sigOf(buf) {
  if (!buf || !buf.length) return '';
  return crypto.createHash('sha1').update(buf).digest('hex').slice(0, 16);
}

// 归一化清单：丢掉非字符串/空串的值（防手改坏数据把「未变」判断弄脏）
function normSigs(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  Object.keys(raw).forEach(function (k) {
    if (typeof raw[k] === 'string' && raw[k]) out[k] = raw[k];
  });
  return out;
}

// 读指纹清单。缺失 / 损坏 / 格式不对 → 一律返回空表（退回「全量上传」的老行为，绝不抛错）。
// 空表 = 全部 need=true，正好是首次上线想要的效果。
function readSigs(file) {
  try { return normSigs(JSON.parse(fs.readFileSync(file, 'utf8'))); }
  catch (e) { return {}; }
}

// 判定单张封面要不要上传。
// 返回 { need, sig, reason }：reason ∈ empty | unchanged | changed | new
//   need=false 时调用方应把 sig 记进新表（云上已是最新）；
//   need=true  时**只有上传成功**才把 sig 记进新表。
function decideUpload(imagePath, buf, oldSig) {
  const sig = sigOf(buf);
  if (!sig) return { need: false, sig: '', reason: 'empty' };
  const prev = (oldSig || {})[String(imagePath)];
  if (prev && prev === sig) return { need: false, sig: sig, reason: 'unchanged' };
  return { need: true, sig: sig, reason: prev ? 'changed' : 'new' };
}

module.exports = { sigOf: sigOf, normSigs: normSigs, readSigs: readSigs, decideUpload: decideUpload };
