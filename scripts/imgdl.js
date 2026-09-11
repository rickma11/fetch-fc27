// 在 Playwright 浏览器会话里下载球员图片。
//
// 为什么必须借浏览器：game-assets.fut.gg 被 Cloudflare Managed Challenge 保护，
// Node 侧（含 ctx.request，它用的是 Node 的 TLS 指纹而不是 Chromium 的）会 403。
// 所以这里准备三种通道，启动时各探一次，按「快 → 稳」取第一个可用的：
//
//   A. ctx.request.get           —— Node 侧直取。最快（流式、无 base64 开销），但可能被拦。
//   B. 页面内 fetch → base64      —— 走浏览器网络栈与 cookie；需要 CDN 返回 CORS 头。
//   C. <img> 触发加载 + 监听 response.body() —— 走浏览器网络栈，不需要 CORS，最稳但最慢。
//
// 探测只在 1 个 URL 上各跑一次，成本可忽略；选定后整批用它，
// 单张失败再按 C→B→A 反向兜底一次。
const fs = require('fs');
const path = require('path');

async function methodA(ctx, url, file, ua) {
  const r = await ctx.request.get(url, {
    headers: {
      'User-Agent': ua,
      Referer: 'https://www.fut.gg/',
      Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8'
    },
    timeout: 60000
  });
  if (!r.ok()) throw new Error('status ' + r.status());
  const buf = await r.body();
  if (!buf || !buf.length) throw new Error('empty body');
  fs.writeFileSync(file, buf);
  return buf.length;
}

async function methodB(page, url, file) {
  const b64 = await page.evaluate(async (u) => {
    const r = await fetch(u, { credentials: 'include' });
    if (!r.ok) throw new Error('status ' + r.status());
    const buf = await r.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let bin = '';
    const CH = 0x8000;
    for (let i = 0; i < bytes.length; i += CH) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
    }
    return btoa(bin);
  }, url);
  const buf = Buffer.from(b64, 'base64');
  if (!buf.length) throw new Error('empty body');
  fs.writeFileSync(file, buf);
  return buf.length;
}

// C 通道：常驻一个 response 监听器，用 url 作为配对键
class ImgSink {
  constructor(page) {
    this.page = page;
    this.waiting = new Map();
    page.on('response', (res) => { this._on(res); });
  }

  async _on(res) {
    const url = res.url();
    const w = this.waiting.get(url);
    if (!w) return;
    this.waiting.delete(url);
    try {
      if (res.status() !== 200) throw new Error('status ' + res.status());
      const body = await res.body();
      if (!body || !body.length) throw new Error('empty body');
      fs.writeFileSync(w.file, body);
      w.resolve(body.length);
    } catch (e) {
      w.reject(e);
    }
  }

  fetch(url, file, timeoutMs) {
    const page = this.page;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(url);
        reject(new Error('timeout ' + timeoutMs + 'ms'));
      }, timeoutMs || 60000);
      this.waiting.set(url, {
        file,
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); }
      });
      // 不挂到 DOM 上也会真正发起请求
      page.evaluate((u) => { const im = new Image(); im.decoding = 'async'; im.src = u; }, url)
        .catch(() => { });
    });
  }
}

// 在浏览器里关掉 HTTP 缓存，否则重复 URL 会命中内存缓存、不产生 response 事件
async function disableCache(ctx, page) {
  try {
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
    return cdp;
  } catch (e) {
    console.log('[img] 关闭浏览器缓存失败（不影响继续）:', e.message);
    return null;
  }
}

// 探测可用通道，返回 'A' | 'B' | 'C' | null
async function probe(ctx, page, sink, url, tmpFile, ua) {
  const tries = [
    ['A', () => methodA(ctx, url, tmpFile, ua)],
    ['B', () => methodB(page, url, tmpFile)],
    ['C', () => sink.fetch(url, tmpFile, 45000)]
  ];
  for (const [name, fn] of tries) {
    try {
      const n = await fn();
      console.log(`[img] 通道 ${name} 可用（探测样本 ${n} 字节）`);
      return name;
    } catch (e) {
      console.log(`[img] 通道 ${name} 不可用: ${e.message}`);
    }
  }
  return null;
}

module.exports = { methodA, methodB, ImgSink, disableCache, probe };
