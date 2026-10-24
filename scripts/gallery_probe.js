// scripts/gallery_probe.js —— 诊断 fut.gg 联赛图标来源（本机 IP 被拦，仅 CI 直连可达，规则 111）。
// v2：API 主机是 www.fut.gg（v1 误用 api.fut.gg 致 DNS 失败）；徽标探测带 Referer 防盗链；
//     另抓联赛页 HTML 抠真实 <img> 徽标 URL 模式。
const https = require('https');

function get(url, maxBytes, referer) {
  maxBytes = maxBytes || 300000;
  return new Promise(function (res) {
    const headers = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Accept': 'application/json,text/html,*/*' };
    if (referer) headers['Referer'] = referer;
    const req = https.request(url, { method: 'GET', headers: headers, timeout: 20000 }, function (r) {
      const chunks = [];
      let total = 0;
      r.on('data', function (c) { total += c.length; if (total <= maxBytes) chunks.push(c); });
      r.on('end', function () {
        res({ status: r.statusCode, headers: r.headers, body: Buffer.concat(chunks).toString('utf8').slice(0, maxBytes) });
      });
    });
    req.on('error', function (e) { res({ status: 0, error: e.message }); });
    req.on('timeout', function () { req.destroy(); res({ status: 0, error: 'timeout' }); });
    req.end();
  });
}

(async function main() {
  // ① leagues API 候选端点（www.fut.gg）
  const cands = [
    'https://www.fut.gg/api/fut/leagues/fc27/',
    'https://www.fut.gg/api/fut/leagues/',
    'https://www.fut.gg/api/fut/leagues/fc27/list/'
  ];
  let leagueId = 13;
  for (const u of cands) {
    const r = await get(u);
    console.log('\n== GET ' + u + ' -> ' + r.status + (r.error ? ' err=' + r.error : ''));
    if (r.status !== 200) continue;
    try {
      const j = JSON.parse(r.body);
      const d = j.data || j;
      const arr = Array.isArray(d) ? d : (d.leagues || d.results || []);
      console.log('  count=' + arr.length);
      const keys = new Set();
      arr.slice(0, 80).forEach(function (x) { Object.keys(x).forEach(function (k) { keys.add(k); }); });
      console.log('  keys union=' + JSON.stringify(Array.from(keys)));
      console.log('  sample=' + JSON.stringify(arr.slice(0, 3)).slice(0, 1500));
      const pl = arr.filter(function (x) { return /premier league/i.test(x.name || ''); })[0];
      if (pl && (pl.id || pl.leagueId)) leagueId = pl.id || pl.leagueId;
    } catch (e) {
      console.log('  non-json head=' + r.body.slice(0, 300));
    }
  }

  // ② 联赛页 HTML：抠 game-assets 徽标 URL（最可靠来源）
  const page = await get('https://www.fut.gg/leagues/premier-league/', 500000, 'https://www.fut.gg/');
  console.log('\n== league page -> ' + page.status + ' bytes=' + page.body.length);
  if (page.status === 200) {
    const urls = page.body.match(/https?:\/\/[^"'\s\\)]+game-assets[^"'\s\\)]+/g) || [];
    const uniq = [];
    urls.forEach(function (u) { if (uniq.indexOf(u) < 0 && uniq.length < 12) uniq.push(u); });
    console.log('  game-assets urls (' + urls.length + ' total):');
    uniq.forEach(function (u) { console.log('    ' + u); });
    const lg = page.body.match(/https?:\/\/[^"'\s\\)]*(?:league|crest|logo)[^"'\s\\)]*\.(?:png|webp|svg)/gi) || [];
    console.log('  league/crest/logo urls: ' + JSON.stringify(lg.slice(0, 8)));
  }

  // ③ 徽标 URL 模式探测（带 Referer）
  const imgPatterns = [
    function (id) { return 'https://game-assets.fut.gg/2027/leagues/' + id + '.png'; },
    function (id) { return 'https://game-assets.fut.gg/2027/leagues/' + id + '.webp'; }
  ];
  for (const mk of imgPatterns) {
    const u = mk(leagueId);
    const r = await get(u, 64, 'https://www.fut.gg/');
    console.log('IMG ' + u + ' -> ' + r.status + ' ' + ((r.headers && r.headers['content-type']) || '') + ' len=' + ((r.headers && r.headers['content-length']) || '?'));
  }
  console.log('\nPROBE DONE leagueId=' + leagueId);
})();
