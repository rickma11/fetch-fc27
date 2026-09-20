// 探测 Player Pick pool 页「选择球员」数据的真实来源（discovery run）。
// 上一轮发现：pool 页是客户端渲染 SPA，静态 HTML 不含球员名/eaId，
// 所以不能直接抓 DOM。本轮改为：过 CF 后加载 pool 页，监听所有网络响应，
// 找出真正返回球员 JSON 的 API 端点。
// 通过 probe-futgg.yml 的 workflow_dispatch 在 CI 跑（fc_ver=27 script=probe_pool_r14.js）。
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const UA = process.env.CF_UA || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36';
const VER = parseInt(process.env.FC_VER, 10) || 27;
const PROBE_DIR = path.resolve(__dirname, '..', 'probe');
const SAMPLE = { id: 342, slug: '342-ones-to-watch-duo-pick-1-pool' };

function dump(name, obj) {
  if (!fs.existsSync(PROBE_DIR)) fs.mkdirSync(PROBE_DIR, { recursive: true });
  fs.writeFileSync(path.join(PROBE_DIR, name), typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2));
  console.log('  [probe] 写出 ' + name);
}

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--disable-blink-features=AutomationControlled', '--no-sandbox', '--disable-dev-shm-usage'] });
  const ctx = await browser.newContext({ userAgent: UA, locale: 'en-US', viewport: { width: 1280, height: 800 }, timezoneId: 'America/New_York' });
  const page = await ctx.newPage();

  const apiHits = [];
  page.on('response', async (resp) => {
    const u = resp.url();
    const ct = resp.headers()['content-type'] || '';
    if (!/api|pool|player|sbc/i.test(u) && !/json/i.test(ct)) return;
    let body = '';
    try { body = (await resp.text()).slice(0, 600); } catch (e) {}
    const found = /Pedro|Rodrigo|Mora|Gonçalves|Goncalves|ea_id|"eaId"| player/i.test(body);
    apiHits.push({ url: u, status: resp.status(), ct: ct.slice(0, 30), hasPlayerData: found, head: body.replace(/\s+/g, ' ').slice(0, 200) });
  });

  console.log('打开 fut.gg 过 Cloudflare ...');
  await page.goto('https://www.fut.gg/sbc/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  let passed = false;
  for (let i = 0; i < 30; i++) {
    let status = -1;
    try { status = await page.evaluate(async (u) => { try { const r = await fetch(u, { headers: { Accept: 'application/json' } }); return r.status; } catch (e) { return -1; } }, `https://www.fut.gg/api/fut/sbc/${VER}?page=1`); } catch (e) { status = -2; }
    if (status === 200) { passed = true; console.log(`Cloudflare 已通过（第 ${i + 1} 次）`); break; }
    if (status === 404) break;
    await page.waitForTimeout(3000);
  }
  if (!passed) { console.error('CF 未通过'); await browser.close(); process.exit(1); }

  console.log(`加载 pool 页 ${SAMPLE.slug} ...`);
  try { await page.goto(`https://www.fut.gg/pools/${SAMPLE.slug}/`, { waitUntil: 'load', timeout: 60000 }); } catch (e) { console.log('goto 异常: ' + e.message); }
  // 给 JS 充分时间拉数据
  await page.waitForTimeout(20000);

  // 落盘所有可疑响应
  dump(`pool_r14_responses_${SAMPLE.id}.json`, apiHits);
  const playerApi = apiHits.filter(h => h.hasPlayerData);
  console.log(`\n捕获响应 ${apiHits.length} 条，其中含球员数据的 ${playerApi.length} 条：`);
  playerApi.forEach(h => console.log('  ★ ' + h.url + '  status=' + h.status + '  ' + h.head));

  // 尝试直接从已捕获的含球员数据响应里取一份完整样本（再发一次请求拿全量）
  if (playerApi.length) {
    for (const h of playerApi.slice(0, 3)) {
      try {
        const full = await page.evaluate(async (url) => {
          const r = await fetch(url, { headers: { Accept: 'application/json' } });
          const t = await r.text();
          return { status: r.status, len: t.length, head: t.slice(0, 1500) };
        }, h.url);
        dump(`pool_r14_sample_${SAMPLE.id}_${playerApi.indexOf(h)}.json`, full);
        console.log('  采样 ' + h.url + ' -> status=' + full.status + ' len=' + full.len);
      } catch (e) { console.log('  采样失败 ' + h.url + ' : ' + e.message); }
    }
  } else {
    console.log('  未发现含球员数据的 API 响应（可能走 GraphQL 或加密路径，需进一步分析）');
  }

  await browser.close();
  console.log('\ndiscovery 完成。');
})().catch(e => { console.error('FATAL', e); process.exit(1); });
