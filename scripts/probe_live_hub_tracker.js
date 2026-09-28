// 诊断探针（只读）：试探 live-hub/{ver}/?tracker_id=N 是否能按 tracker 过滤出该类卡的真实 objectives 模板。
// 若可行：Veiga(tid 34) 等非精选被追踪卡就能显示具体升级条件（如 clean sheets 2/4/6/10），而非仅「追踪中」。
// 结果落盘 probe/live_hub/tracker_probe.json，由 workflow 提交回 main 供本地读回。
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'probe', 'live_hub');
const VER = Number(process.argv[2] || 27);
const BASE = 'https://www.fut.gg/api/fut';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36';

function jget(t){try{return JSON.parse(t);}catch(e){return null;}}
async function apiGet(page, url){
  for(let a=1;a<=4;a++){
    try{
      const r = await page.request.get(url,{headers:{Accept:'application/json'},timeout:60000});
      const t = await r.text();
      if(r.status()===200 && (t.trim().startsWith('{')||t.trim().startsWith('['))) return t;
      console.log('  api', url.slice(0,90), 'status', r.status(), t.slice(0,120));
    }catch(e){console.log('  err', e.message);}
    if(a<4) await page.waitForTimeout(3000);
  }
  return null;
}

(async()=>{
  const browser = await chromium.launch({headless:true,args:['--disable-blink-features=AutomatedControlled','--no-sandbox','--disable-dev-shm-usage']});
  const ctx = await browser.newContext({userAgent:UA,locale:'en-US',viewport:{width:1280,height:800},timezoneId:'America/New_York'});
  const page = await ctx.newPage();
  await page.goto('https://www.fut.gg/',{waitUntil:'domcontentloaded',timeout:60000});
  const LIGHT = `${BASE}/players/v2/${VER}/?page=1`;
  let passed=false;
  for(let i=0;i<40;i++){
    try{const r=await page.request.get(LIGHT,{headers:{Accept:'application/json'},timeout:20000});const t=await r.text();if(r.status()===200&&(t.trim().startsWith('{')||t.trim().startsWith('['))){passed=true;console.log('CF 通过',i+1);break;}}
    catch(e){}
    await page.waitForTimeout(3000);
  }
  if(!passed){await browser.close();console.error('CF 失败');process.exit(2);}

  const out = { generatedAt: new Date().toISOString(), VER };
  for(const tid of [32,33,34]){
    const t = await apiGet(page, `${BASE}/live-hub/${VER}/?tracker_id=${tid}`);
    if(!t){ out['tid_'+tid]={status:'fail'}; continue; }
    const j = jget(t);
    const players = (j&&j.data&&Array.isArray(j.data.players))?j.data.players:[];
    out['tid_'+tid] = {
      status:'200',
      count: players.length,
      sampleEaIds: players.slice(0,6).map(p=>p.playerItemEaId||(p.card&&p.card.eaId)),
      sampleObjectives: players[0] ? (players[0].tracker&&players[0].tracker.objectives||players[0].objectives||[]).map(o=>({req:o.requirement,value:o.value,label:o.label})) : []
    };
  }
  await browser.close();
  const f = path.join(OUT,'tracker_probe.json');
  fs.writeFileSync(f, JSON.stringify(out,null,2));
  console.log('dumped', f);
  console.log(JSON.stringify(out,null,2).slice(0,2500));
})().catch(e=>{console.error('ERR',e);process.exit(1);});
