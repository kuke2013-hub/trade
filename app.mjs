import {STRATEGIES,DEFAULT_CONFIG,parseKlines,analyse,createState,openPaper,closePaper,evaluateExit,portfolioStats} from './engine.mjs';
const API='https://data-api.binance.vision/api/v3/';
const $=id=>document.getElementById(id);
const quote=s=>String(s).replace(/USDT$/,'');
const num=(n,d=2)=>Number.isFinite(+n)?Number(n).toLocaleString('en-US',{minimumFractionDigits:d,maximumFractionDigits:d}):'—';
const pct=n=>Number.isFinite(+n)?`${+n>=0?'+':''}${num(n,2)}%`:'—';
const cash=n=>Number.isFinite(n)?`${n<0?'-':''}$${num(Math.abs(n),2)}`:'—';
const escape=s=>String(s).replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
let markets=[],bySymbol=new Map(),candles=new Map(),scores=new Map(),busy=false,observer=null,runToken=0,scannedAt=0,ready=false;
let armed=localStorage.getItem('breakout-armed')==='yes';
let paper;
try{const v=JSON.parse(localStorage.getItem('breakout-paper-v1'));paper=v?.version===1&&v.portfolios&&v.config? v:createState();}catch{paper=createState();}
function save(){try{localStorage.setItem('breakout-paper-v1',JSON.stringify(paper));}catch(err){showError('Browser storage is unavailable. Paper trades may disappear after reloading. '+err.message);}}
function showError(message){$('error-banner').hidden=false;$('error-banner').textContent='DATA / EXECUTION WARNING — '+message;$('connection').classList.remove('live');$('connection').innerHTML='<span class="status-dot"></span>DEGRADED';}
function clearError(){$('error-banner').hidden=true;}
function status(text){$('scan-status').textContent=text;}
function setLive(){$('connection').classList.add('live');$('connection').innerHTML='<span class="status-dot"></span>CONNECTED · SPOT';}
async function json(path,timeout=18000){const ctl=new AbortController(),timer=setTimeout(()=>ctl.abort(),timeout);try{const r=await fetch(API+path,{signal:ctl.signal,cache:'no-store'});if(!r.ok)throw new Error(`Binance HTTP ${r.status} for ${path.split('?')[0]}`);return await r.json();}finally{clearTimeout(timer);}}
async function universe(){
  const [info,tickers]=await Promise.all([json('exchangeInfo'),json('ticker/24hr')]);
  if(!info?.symbols||!Array.isArray(tickers))throw new Error('Unexpected Binance exchangeInfo/ticker response');
  const valid=new Set(info.symbols.filter(s=>s.quoteAsset==='USDT'&&s.status==='TRADING'&&s.isSpotTradingAllowed!==false).map(s=>s.symbol));
  const bad=/((UP|DOWN|BULL|BEAR)USDT)$/;const stable=/^(USDC|FDUSD|TUSD|DAI|USDP|USDE|EUR|EURI|BRL|TRY|AEUR|USD1)USDT$/;
  markets=tickers.filter(t=>valid.has(t.symbol)&&!bad.test(t.symbol)&&!stable.test(t.symbol)&&Number(t.quoteVolume)>=500000&&Number(t.lastPrice)>0).map(t=>({symbol:t.symbol,price:+t.lastPrice,change:+t.priceChangePercent,volume:+t.quoteVolume}));
  markets.sort((a,b)=>b.volume-a.volume);markets=markets.slice(0,360);bySymbol=new Map(markets.map(m=>[m.symbol,m]));
  if(!markets.length)throw new Error('No liquid tradable USDT pairs were returned');
  $('metric-pairs').textContent=markets.length;$('pair-count').textContent=markets.length;
}
function selection(){
  const topVolume=[...markets].sort((a,b)=>b.volume-a.volume).slice(0,48);
  const momentum=[...markets].filter(x=>x.change>0).sort((a,b)=>b.change-a.change).slice(0,50);
  const activity=[...markets].sort((a,b)=>Math.abs(b.change)*Math.log10(b.volume)-Math.abs(a.change)*Math.log10(a.volume)).slice(0,30);
  return [...new Set([...topVolume,...momentum,...activity].map(x=>x.symbol))].slice(0,110);
}
async function loadBars(symbol,force=false){
  const cached=candles.get(symbol);if(cached&&!force&&Date.now()-cached.when<5*60000)return cached.data;
  const raw=await json(`klines?symbol=${encodeURIComponent(symbol)}&interval=1h&limit=95`);
  const bars=parseKlines(raw);
  if(bars.length<55)throw new Error('Insufficient closed hourly candles for '+symbol);
  candles.set(symbol,{when:Date.now(),data:bars});
  const btc=candles.get('BTCUSDT')?.data;
  const btcRet=btc?.length>=25?(btc.at(-1).close/btc.at(-25).close-1)*100:0;
  const a=analyse(bars,btcRet);if(a)scores.set(symbol,a);
  return bars;
}
async function pool(items,n,handler){let index=0,errors=0;async function work(){while(index<items.length){const i=index++;try{await handler(items[i],i);}catch(e){errors++;if(errors<5)console.warn('Market series unavailable',items[i],e.message);}}}await Promise.all(Array.from({length:n},work));return errors;}
function triggers(a){return a?STRATEGIES.filter(s=>a.trigger[s.id]):[];}
function orderPairs(){const sort=$('sort').value,find=$('filter').value.trim().toUpperCase();let arr=markets.filter(m=>m.symbol.includes(find));arr.sort((a,b)=>{if(sort==='gain')return b.change-a.change;if(sort==='volume')return b.volume-a.volume;if(sort==='alphabetical')return a.symbol.localeCompare(b.symbol);return (scores.get(b.symbol)?.score??-1)-(scores.get(a.symbol)?.score??-1)||b.volume-a.volume;});return arr;}
function cardHTML(m){const a=scores.get(m.symbol),sc=a?String(a.score):'—';return `<article class="coin-card" data-symbol="${escape(m.symbol)}" tabindex="0" role="button" aria-label="Open ${escape(m.symbol)} analysis"><div class="card-top"><div><div class="symbol">${escape(quote(m.symbol))}<span class="pair-quote">/USDT</span></div><div class="small-muted">24H ${pct(m.change)}</div></div><div><div class="score">${sc}</div><span class="score-label">SETUP /100</span></div></div><canvas width="560" height="210" aria-label="Hourly price chart for ${escape(m.symbol)}"></canvas><div class="card-bottom"><span>${a?triggers(a).length+' triggered models':'UNSCANNED'}</span><span class="${m.change>=0?'up':'down'}">VOL ${m.volume>=1e6?num(m.volume/1e6,1)+'M':num(m.volume/1e3,0)+'K'} USDT</span></div></article>`;}
function renderCards(){
  if(observer)observer.disconnect();
  const cards=$('cards'),arr=orderPairs();cards.innerHTML=arr.length?arr.map(cardHTML).join(''):'<div class="empty">No matching trading pairs.</div>';
  observer=new IntersectionObserver(entries=>{for(const e of entries){if(!e.isIntersecting)continue;observer.unobserve(e.target);const symbol=e.target.dataset.symbol;if(candles.has(symbol))drawCard(e.target,symbol);else loadBars(symbol).then(()=>drawCard(e.target,symbol)).catch(()=>{const ctx=e.target.querySelector('canvas').getContext('2d');ctx.fillStyle='#8291a8';ctx.font='20px sans-serif';ctx.fillText('Chart unavailable',20,95);});}},{rootMargin:'200px'});
  cards.querySelectorAll('.coin-card').forEach(node=>{observer.observe(node);node.addEventListener('click',()=>detail(node.dataset.symbol));node.addEventListener('keydown',e=>{if(e.key==='Enter')detail(node.dataset.symbol);});});
}
function drawCandles(canvas,bars,resistance=null){
  const context=canvas.getContext('2d');if(!context||!bars?.length)return;
  const W=canvas.width,H=canvas.height;context.clearRect(0,0,W,H);
  const data=bars.slice(-48);const low=Math.min(...data.map(c=>c.low)),high=Math.max(...data.map(c=>c.high)),span=Math.max(high-low,low*0.00001);
  const top=H*.07,bottom=H*.77,left=10,right=W-10;
  const yy=p=>bottom-(p-low)/span*(bottom-top),step=(right-left)/data.length;
  context.strokeStyle='#293645';context.lineWidth=1;for(let i=0;i<4;i++){const y=top+(bottom-top)*i/3;context.beginPath();context.moveTo(left,y);context.lineTo(right,y);context.stroke();}
  if(Number.isFinite(resistance)&&resistance>=low&&resistance<=high){context.setLineDash([9,7]);context.strokeStyle='#b49b72';context.beginPath();context.moveTo(left,yy(resistance));context.lineTo(right,yy(resistance));context.stroke();context.setLineDash([]);}
  const vm=Math.max(1,...data.map(c=>c.volume));
  data.forEach((c,i)=>{const x=left+step*(i+.5),up=c.close>=c.open,color=up?'#3ee1a2':'#fa7180';context.strokeStyle=color;context.fillStyle=color;context.lineWidth=Math.max(1.5,step*.17);context.beginPath();context.moveTo(x,yy(c.high));context.lineTo(x,yy(c.low));context.stroke();const ya=yy(Math.max(c.open,c.close)),yb=yy(Math.min(c.open,c.close));context.fillRect(x-step*.27,ya,Math.max(2,step*.54),Math.max(2,yb-ya));context.globalAlpha=.3;context.fillRect(x-step*.27,H*.98-(c.volume/vm)*H*.15,Math.max(2,step*.54),(c.volume/vm)*H*.15);context.globalAlpha=1;});
}
function drawCard(node,symbol){if(!node.isConnected)return;const bar=candles.get(symbol)?.data;drawCandles(node.querySelector('canvas'),bar,scores.get(symbol)?.resistance);const score=scores.get(symbol);if(score){node.querySelector('.score').textContent=score.score;node.querySelector('.card-bottom span').textContent=triggers(score).length+' triggered models';}}
function renderSignals(){const matches=markets.filter(x=>triggers(scores.get(x.symbol)).length).sort((a,b)=>(scores.get(b.symbol).score-scores.get(a.symbol).score));$('metric-signals').textContent=matches.length;
  $('signals').innerHTML=matches.length?matches.slice(0,8).map(m=>{const a=scores.get(m.symbol);return `<div class="signal-tile" data-symbol="${escape(m.symbol)}" tabindex="0" role="button"><div class="tile-top"><div><div class="symbol">${escape(quote(m.symbol))}<span class="pair-quote">/USDT</span></div><div class="small-muted">24H ${pct(m.change)}</div></div><div><div class="score">${a.score}</div><div class="score-label">SETUP /100</div></div></div><div class="tile-details">Relative strength vs BTC: ${pct(a.relative)}<br>Volume / 20h avg: ${num(a.volumeRatio,1)}×</div><span class="tile-label">${escape(triggers(a).map(s=>s.name).join(' · '))}</span></div>`;}).join(''):'<div class="empty">No confirmed breakout triggers among analysed pairs. This is a valid no-trade result.</div>';
  $('signals').querySelectorAll('[data-symbol]').forEach(n=>{n.addEventListener('click',()=>detail(n.dataset.symbol));n.addEventListener('keydown',e=>{if(e.key==='Enter')detail(n.dataset.symbol)});});
}
async function detail(symbol){$('detail').hidden=false;$('detail-symbol').textContent=symbol;$('detail-stats').textContent='Loading confirmed hourly candles…';$('detail-explanation').textContent='';const canvas=$('detail-chart');canvas.getContext('2d').clearRect(0,0,canvas.width,canvas.height);
  try{const bars=await loadBars(symbol),a=scores.get(symbol),m=bySymbol.get(symbol);drawCandles(canvas,bars,a?.resistance);$('detail-stats').innerHTML=`<span>LAST <b>${num(m?.price,6)}</b> USDT</span><span>24H <b>${pct(m?.change)}</b></span><span>RESISTANCE <b>${num(a?.resistance,6)}</b></span><span>VOLUME RATIO <b>${num(a?.volumeRatio,2)}×</b></span><span>SETUP <b>${a?.score??'—'}/100</b></span>`;$('detail-explanation').innerHTML=a?`<strong>Strategy triggers:</strong> ${triggers(a).length?triggers(a).map(s=>escape(s.name)).join(', '):'None'}<br><strong>Relative strength versus BTC:</strong> ${pct(a.relative)}. <strong>Trend filter:</strong> ${a.trend?'positive':'not confirmed'}. <strong>Pre-breakout compression:</strong> ${a.compression?'detected':'not detected'}.<br>These are deterministic screening rules, not calibrated forecasts of future returns.`:'Insufficient data for a calculation.';}
  catch(e){$('detail-stats').textContent='Market candles unavailable: '+e.message;}
}
function paperUI(){const n=$('paper-notice');n.classList.toggle('active',armed);n.textContent=armed?'ARMED · Virtual long trades may open after a fresh, confirmed hourly signal. Scanning and exits only work while this browser tab is running.':'PAUSED · No new positions will open. The simulator runs only while this page is open. Existing paper positions are checked when market data are available.';$('paper-toggle').textContent=armed?'Pause new trades':'Start paper engine';
  $('portfolios').innerHTML=STRATEGIES.map(s=>{const p=paper.portfolios[s.id],st=portfolioStats(p,Object.fromEntries(markets.map(m=>[m.symbol,m.price])),paper.config);return `<div class="portfolio"><h3>${escape(s.name)}</h3><div class="fine">STARTED $${num(paper.config.startingCash,0)} · ${st.openCount} OPEN</div><div class="net ${st.realised>0?'pos':st.realised<0?'neg':''}">${cash(st.realised)}</div><div class="fine">REALIZED NET P&amp;L<br>${st.trades} CLOSED TRADES · WIN RATE ${st.winRate===null?'—':num(st.winRate,1)+'%'}<br>EST. EQUITY ${cash(st.estimatedEquity)}</div></div>`;}).join('');
  const trades=STRATEGIES.flatMap(s=>{const p=paper.portfolios[s.id];return [...p.trades.map(t=>({...t,status:t.reason,ts:t.exitTime})),...p.positions.map(t=>({...t,status:'OPEN'+(t.dataGap?' / DATA GAP':''),ts:t.entryTime,pnl:null}))];}).sort((a,b)=>b.ts-a.ts).slice(0,100);
  $('ledger').innerHTML=trades.length?trades.map(t=>`<tr><td>${new Date(t.entryTime).toISOString().slice(0,16).replace('T',' ')}</td><td>${escape(STRATEGIES.find(x=>x.id===t.strategyId)?.name||'')}</td><td>${escape(t.symbol)}</td><td>${num(t.entryPrice,6)}</td><td>${t.exitPrice?num(t.exitPrice,6):'—'}</td><td class="${t.pnl===null?'':t.pnl>=0?'profit':'loss'}">${t.pnl===null?'—':cash(t.pnl)}</td><td>${escape(t.status)}</td></tr>`).join(''):'<tr><td colspan="7">No trades yet. A blank ledger is not a profitable result.</td></tr>';
}
async function bookAsk(symbol){const d=await json(`ticker/bookTicker?symbol=${encodeURIComponent(symbol)}`);const ask=+d.askPrice,bid=+d.bidPrice;return Number.isFinite(ask)&&Number.isFinite(bid)&&ask>0&&bid>0&&ask>=bid?ask:null;}
async function managePositions(){const positions=STRATEGIES.flatMap(s=>paper.portfolios[s.id].positions);if(!positions.length)return;
  const grouped=new Map();for(const p of positions){if(!grouped.has(p.symbol))grouped.set(p.symbol,[]);grouped.get(p.symbol).push(p);}
  for(const [symbol,items] of grouped){try{const oldest=Math.min(...items.map(p=>p.lastChecked)),now=Date.now();if(now-oldest>950*60000){items.forEach(p=>p.dataGap=true);continue;}
    const raw=await json(`klines?symbol=${encodeURIComponent(symbol)}&interval=1m&startTime=${Math.max(0,oldest-60000)}&limit=1000`);
    const bars=parseKlines(raw,now);if(!bars.length)continue;
    for(const p of items){const eligible=bars.filter(c=>c.time>=Math.max(p.entryTime,p.lastChecked));const exit=evaluateExit(p,eligible,now,paper.config);if(exit)closePaper(paper,p.strategyId,symbol,exit.market,exit.reason,exit.at);else p.lastChecked=bars.at(-1).closeTime+1;}
  }catch(e){console.warn('Paper exit data unavailable',symbol,e.message);showError('Could not verify open paper positions for '+symbol+'. No exit has been invented.');}}
  save();paperUI();
}
async function enterSignals(){if(!armed)return;const now=Date.now();const active=markets.filter(m=>{const a=scores.get(m.symbol);return a&&now-a.lastBarTime>=0&&now-a.lastBarTime<15*60000&&triggers(a).length;});
  const picked=active.sort((a,b)=>scores.get(b.symbol).score-scores.get(a.symbol).score).slice(0,16);
  for(const m of picked){const a=scores.get(m.symbol);let ask;try{ask=await bookAsk(m.symbol);}catch(e){console.warn('No executable ask quote',m.symbol,e.message);continue;}if(!ask)continue;
    for(const s of triggers(a))openPaper(paper,s.id,m.symbol,ask,a.lastBarTime,Date.now());
  }save();paperUI();
}
async function scan(){if(busy)return;busy=true;clearError();$('refresh').disabled=true;
  try{status('Refreshing Binance spot market universe…');await universe();ready=true;setLive();
    // BTC is explicitly refreshed first to avoid an undefined relative-strength benchmark.
    try{await loadBars('BTCUSDT',true);}catch(e){throw new Error('BTC benchmark unavailable: '+e.message);}
    renderCards();status('Analysing closed 1h candles for liquid/moving pairs…');const selected=selection();let done=0;
    const errors=await pool(selected,5,async sym=>{try{await loadBars(sym,true);}finally{done++;if(done%10===0||done===selected.length)status(`Processed ${done}/${selected.length} pairs`);}});
    scannedAt=Date.now();$('metric-scanned').textContent=scores.size;$('metric-time').textContent=new Date(scannedAt).toISOString().slice(11,19);renderCards();renderSignals();await managePositions();await enterSignals();paperUI();status(`Scan complete · ${scores.size} evaluated · ${errors} failed market series · auto-refresh ~5 min`);
    if(errors)showError(`${errors} symbols could not be analysed. Missing series were excluded, not estimated.`);
  }catch(e){status('Scan failed · no invented data');showError(e.message);}finally{busy=false;$('refresh').disabled=false;}
}
function downloadCSV(){const all=STRATEGIES.flatMap(s=>paper.portfolios[s.id].trades);const header=['strategy','symbol','entry_time_utc','exit_time_utc','entry_fill','exit_fill','cost_usdt','proceeds_usdt','entry_fee_usdt','exit_fee_usdt','net_pnl_usdt','return_pct','reason'];const lines=all.map(t=>[t.strategyId,t.symbol,new Date(t.entryTime).toISOString(),new Date(t.exitTime).toISOString(),t.entryPrice,t.exitPrice,t.cost,t.proceeds,t.entryFee,t.exitFee,t.pnl,t.returnPct,t.reason].join(','));const b=new Blob([[header.join(','),...lines].join('\n')],{type:'text/csv'});const url=URL.createObjectURL(b);const a=document.createElement('a');a.href=url;a.download='breakout-lab-paper-trades.csv';a.click();URL.revokeObjectURL(url);}
function init(){
  $('methods').innerHTML=STRATEGIES.map((s,i)=>`<div class="method-card"><div class="ordinal">MODEL 0${i+1}</div><h3>${escape(s.name)}</h3><p>${escape(s.description)} Requires a closed hourly breakout candle; the additional filters vary by model. Every model begins with its own $10,000 simulated cash balance.</p></div>`).join('');
  $('refresh').addEventListener('click',scan);$('filter').addEventListener('input',renderCards);$('sort').addEventListener('change',renderCards);
  $('paper-toggle').addEventListener('click',()=>{armed=!armed;localStorage.setItem('breakout-armed',armed?'yes':'no');paperUI();if(armed&&ready)enterSignals();});
  $('export').addEventListener('click',downloadCSV);$('reset').addEventListener('click',()=>{if(confirm('Erase all four local virtual portfolios and their trade history? This cannot be undone.')){paper=createState();save();paperUI();}});
  $('close-detail').addEventListener('click',()=>{$('detail').hidden=true;});$('detail').querySelector('[data-close]').addEventListener('click',()=>{$('detail').hidden=true;});document.addEventListener('keydown',e=>{if(e.key==='Escape')$('detail').hidden=true;});
  const clock=()=>{$('clock').textContent=new Date().toISOString().slice(11,19)+' UTC';};clock();setInterval(clock,1000);
  paperUI();scan();setInterval(()=>{if(!document.hidden)scan();},5*60000);setInterval(()=>{if(!document.hidden&&!busy)managePositions();},60000);
}
init();