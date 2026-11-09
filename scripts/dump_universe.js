// dump_universe.js —— 从云库 players_fc27 导出「球员底表」，按 commonName 去重后落 data/player_universe.json。
// 用途：作为中文名批量配（gen_player_names_zh.js）的输入——知道 FC27 里到底有哪些真实球员、属于哪个联赛/国家队。
// 注意：这是「构建期一次性输入」，不是小程序运行数据源；最终产物 player_names_zh.json 仍是翻译对照表。
// 用法：node scripts/dump_universe.js   （需 .env.local 云库凭证 + 出网）
const path = require('path');
process.chdir(path.resolve(__dirname));
const fs = require('fs');
const { resolve } = require('./tcb_env');
const cloudbase = require('@cloudbase/node-sdk');

const VER = 27;
const COL = 'players_fc' + VER;
const OUT = path.resolve(__dirname, '..', 'data', 'player_universe.json');

(async () => {
  const cred = resolve();
  if (cred.missing && cred.missing.length) {
    console.error('缺少云库凭证：', cred.missing.join(' / '));
    process.exit(1);
  }
  const app = cloudbase.init({ env: cred.ENV_ID, secretId: cred.SECRET_ID, secretKey: cred.SECRET_KEY, timeout: 120000 });
  const db = app.database();

  // 与 warm_roster 同投影思路：只取翻译/过滤需要的字段，缩小传输
  const proj = {
    eaId: true, commonName: true,
    'club.name': true, 'league.name': true, 'nation.name': true,
    overall: true, rarity: true
  };

  let all = [];
  let skip = 0;
  const t0 = Date.now();
  while (true) {
    const r = await db.collection(COL).field(proj).skip(skip).limit(100).get();
    const d = r.data || [];
    if (!d.length) break;
    all = all.concat(d);
    if (d.length < 100) break;
    skip += 100;
  }
  console.log('拉取', all.length, '张卡 in', ((Date.now() - t0) / 1000).toFixed(1) + 's');

  // 按 commonName 去重（同名多版本卡合并，记 cardCount）
  const map = new Map();
  for (const p of all) {
    const cn = String(p.commonName || p.name || '').trim();
    if (!cn) continue;
    if (!map.has(cn)) {
      map.set(cn, {
        commonName: cn,
        eaId: p.eaId,
        club: (p.club && p.club.name) || '',
        league: (p.league && p.league.name) || '',
        nation: (p.nation && p.nation.name) || '',
        overall: p.overall || 0,
        rarity: (p.rarity && p.rarity.name) || '',
        cardCount: 1
      });
    } else {
      map.get(cn).cardCount++;
    }
  }
  const out = Array.from(map.values()).sort((a, b) => a.commonName.localeCompare(b.commonName));
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.log('唯一 commonName:', out.length, '→', OUT);

  // 粗统计（帮助确认覆盖目标）
  const byLeague = {};
  const nations = new Set();
  out.forEach(p => { if (p.league) byLeague[p.league] = (byLeague[p.league] || 0) + 1; if (p.nation) nations.add(p.nation); });
  console.log('涉及联赛数:', Object.keys(byLeague).length, '| 国家队数:', nations.size);
  console.log('Top 联赛:', Object.entries(byLeague).sort((a, b) => b[1] - a[1]).slice(0, 12).map(x => x[0] + '=' + x[1]).join(', '));
})().catch(e => { console.error('FATAL', String(e && e.message || e)); process.exit(1); });
