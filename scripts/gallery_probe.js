// scripts/gallery_probe.js —— 诊断 fut.gg 联赛图标来源（本机 IP 被拦，仅 CI 直连可达，规则 111）。
// v3：验证「抓联赛详情页 → 抠徽标 URL → 改 cdn-cgi 参数(format=png,width=120) → 下载 → 校验 PNG」整链路。
//     列表页 /leagues/ 是客户端渲染无徽标，徽标只在 /leagues/{slug}/ 详情页原始 HTML 里。
const { execFileSync } = require('child_process');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36';

function curlRaw(url, referer, asBuffer) {
  const args = ['-s', '--compressed', '--max-time', '60', '-A', UA];
  if (referer) args.push('-e', referer);
  args.push(url);
  return execFileSync('curl', args, { maxBuffer: 64 * 1024 * 1024, encoding: asBuffer ? 'buffer' : 'utf8' });
}

// 深色版徽标（排除 league-light 浅色变体）
function extractCrest(html) {
  const re = /https:\/\/game-assets\.fut\.gg\/cdn-cgi\/image\/[^"'\s\\]+\/2027\/league\/[0-9]+\.[0-9a-f]+\.png/g;
  const all = String(html).match(re) || [];
  const dark = all.filter(function (u) { return u.indexOf('/league-light/') < 0; });
  return dark[0] || all[0] || '';
}

const targets = [
  ['premier-league', 'premier-league'],
  ['laliga', 'laliga-ea-sports'],
  ['bundesliga', 'bundesliga'],
  ['ligue-1', 'ligue-1-mcdonalds'],
  ['serie-a', 'serie-a-enilive'],
  ['roshn-saudi-league', 'roshn-saudi-league'],
  ['mls', 'major-league-soccer'],
  ['national-women-s-soccer-league', 'national-womens-soccer-league']
];

targets.forEach(function (t) {
  const cat = t[0], page = t[1];
  try {
    const html = curlRaw('https://www.fut.gg/leagues/' + page + '/', 'https://www.fut.gg/', false);
    const crest = extractCrest(html);
    if (!crest) { console.log('✗ ' + cat + ' 未抠到徽标 (page len=' + html.length + ')'); return; }
    const url = crest.replace('format=auto', 'format=png').replace('width=80', 'width=120');
    const buf = curlRaw(url, 'https://www.fut.gg/', true);
    console.log('✅ ' + cat + ' → ' + page + '  ' + buf.length + 'B magic=' + buf.slice(0, 8).toString('hex') + '  ' + url.slice(0, 130));
  } catch (e) {
    console.log('✗ ' + cat + ' 失败: ' + e.message);
  }
});
console.log('PROBE DONE');
