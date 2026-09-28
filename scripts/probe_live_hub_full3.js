// 诊断探针 3（只读）：① 确认 has_dynamic 结构（data 为直数组）与分页；② 试探 live-hub 是否能取全量（含 Adeyemi/Veiga）
//   ③ 试探逐球员/逐 campaign 进度来源（objectiveCampaignLevelId=2249 对应 Adeyemi）。
// 结果落盘 probe/live_hub/full_report3.json，由 workflow 提交回 main 供本地读回。
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'probe', 'live_hub');
fs.mkdirSync(OUT, { recursive: true });
const UA = process.env.CF_UA || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36';
const VER = Number(process.env.FC_VER || 27);
const BASE = 'https://www.fut.gg/api/fut';
const result = { generatedAt: new Date().toISOString() };
const J = (t) => { try { return JSON.parse(t); } catch (e) { return null; } };

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--disable-blink-features=AutomatedControlled', '--no-sandbox', '--disable-dev-shm-usage'] });
  const ctx = await browser.newContext({ userAgent: UA, locale: 'en-US', viewport: { width: 1280, height: 800 }, timezoneId: 'America/New_York' });
  const page = await ctx.newPage();
  await page.goto('https://www.fut.gg/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  const LIGHT = `${BASE}/players/v2/${VER}/?page=1`;
  let passed = false;
  for (let i = 0; i < 40; i++) { try { const r = await page.request.get(LIGHT, { headers: { Accept: 'application/json' }, timeout: 20000 }); const t = await r.text(); if (r.status() === 200 && (t.trim().startsWith('{') || t.trim().startsWith('['))) { passed = true; console.log('CF ok', i + 1); break; } console.log('wait CF', r.status()); } catch (e) { console.log('LIGHT err', e.message); } await page.waitForTimeout(3000); }
  if (!passed) { await browser.close(); console.error('CF fail'); process.exit(2); }

  const api = async (u) => { for (let a = 1; a <= 4; a++) { try { const r = await page.request.get(u, { headers: { Accept: 'application/json' }, timeout: 60000 }); const t = await r.text(); if (r.status() === 200 && (t.trim().startsWith('{') || t.trim().startsWith('['))) return t; console.log('  api non-200', u.slice(0, 95), r.status(), t.slice(0, 160)); } catch (e) { console.log('  api err', e.message); } if (a < 4) await page.waitForTimeout(3000); } return null; };

  const tryUrl = async (label, u) => {
    const t = await api(u);
    const j = J(t);
    let info;
    if (j) {
      const players = (j.data && Array.isArray(j.data.players)) ? j.data.players : (Array.isArray(j.data) ? j.data : null);
      if (Array.isArray(players)) info = { kind: 'array', count: players.length, sampleEaIds: players.slice(0, 5).map(p => p.card && p.card.eaId || p.eaId || p.playerItemEaId) };
      else if (j.data && Array.isArray(j.data.players)) info = { kind: 'players', count: j.data.players.length };
      else info = { kind: 'obj', keys: Object.keys(j).slice(0, 20) };
    } else info = { null: true };
    result[label] = { url: u, status: t ? '200' : 'fail', info, first300: t ? t.slice(0, 300) : null };
    console.log(label, '=>', JSON.stringify(info));
  };

  await tryUrl('lh_baseline', `${BASE}/live-hub/${VER}/`);
  await tryUrl('lh_all', `${BASE}/live-hub/${VER}/?all=1`);
  await tryUrl('lh_limit', `${BASE}/live-hub/${VER}/?limit=9999`);
  await tryUrl('lh_detailed', `${BASE}/live-hub/${VER}/?detailed=1`);
  await tryUrl('lh_player', `${BASE}/live-hub/${VER}/?player_ea_id=50583500`);
  await tryUrl('lh_path', `${BASE}/live-hub/${VER}/50583500`);
  await tryUrl('obj_campaign', `${BASE}/objective-campaign-levels/2249`);
  await tryUrl('obj_campaign2', `${BASE}/objective-campaigns/2249`);

  fs.writeFileSync(path.join(OUT, 'full_report3.json'), JSON.stringify(result, null, 2));
  console.log('WROTE full_report3.json');
  await browser.close();
})().catch(e => { console.error('fail', e); process.exit(1); });
