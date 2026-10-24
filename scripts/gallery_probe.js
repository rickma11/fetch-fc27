// scripts/gallery_probe.js —— 诊断 fut.gg 联赛图标来源（本机 IP 被拦，仅 CI 直连可达，规则 111）。
// 目标：① 确认 leagues API 是否存在及其字段（有无 logo/image 路径）；
//       ② 探测 game-assets.fut.gg 联赛徽标 URL 模式（为 gallery 分类真实图标转存定源）。
const https = require('https');

function get(url, maxBytes) {
  maxBytes = maxBytes || 300000;
  return new Promise(function (res) {
    const req = https.request(url, {
      method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Accept': 'application/json,text/html,*/*' },
      timeout: 20000
    }, function (r) {
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
  // ① leagues API 候选端点
  const cands = [
    'https://api.fut.gg/api/fut/leagues/fc27/',
    'https://api.fut.gg/api/fut/leagues/',
    'https://api.fut.gg/api/fut/leagues/fc27/list/'
  ];
  let leaguesSample = null;
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
      console.log('  keys union=' + JSON.stringify([].concat.apply([], [Array.from(keys)])));
      console.log('  sample=' + JSON.stringify(arr.slice(0, 3)).slice(0, 1500));
      if (!leaguesSample && arr.length) leaguesSample = arr;
    } catch (e) {
      console.log('  non-json head=' + r.body.slice(0, 300));
    }
  }

  // ② 徽标 URL 模式探测：用 leagues API 里的真实 id（若有），否则用常见 id 兜底
  let ids = [];
  if (leaguesSample) {
    ids = leaguesSample.slice(0, 3).map(function (x) { return x.id || x.leagueId || x.league_id; }).filter(Boolean);
  }
  if (!ids.length) ids = [13, 31];
  const imgPatterns = [
    function (id) { return 'https://game-assets.fut.gg/2027/leagues/' + id + '.png'; },
    function (id) { return 'https://game-assets.fut.gg/2027/leagues/' + id + '.webp'; },
    function (id) { return 'https://cdn.soccersapi.com/images/leagues/' + id + '.png'; }
  ];
  for (const mk of imgPatterns) {
    for (const id of ids.slice(0, 2)) {
      const u = mk(id);
      const r = await get(u, 64);
      console.log('IMG ' + u + ' -> ' + r.status + ' ' + ((r.headers && r.headers['content-type']) || '') + ' len=' + ((r.headers && r.headers['content-length']) || '?'));
    }
  }
  console.log('\nPROBE DONE');
})();
