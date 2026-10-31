import {STRATEGIES,DEFAULT_CONFIG,parseKlines,analyse,createState,openPaper,closePaper,evaluateExit,portfolioStats,indicators,emaSeries} from './engine.mjs';
const API='https://data-api.binance.vision/api/v3/';
// Display-only candle intervals. Strategy signals and trade entries continue to use completed 1h bars.
const CHART_LABELS=Object.freeze({'1M':'1 month','1w':'1 week','1d':'1 day','1h':'1 hour','5m':'5 minutes','3m':'3 minutes','1m':'1 minute'});
const savedInterval=localStorage.getItem('breakout-chart-interval');
let chartInterval=Object.hasOwn(CHART_LABELS,savedInterval)?savedInterval:'1h';
let detailInterval=chartInterval,detailSymbol=null,detailRequest=0;
const displayCandles=new Map(),displayInFlight=new Map();
// Intervals are whitelisted above. Cache keys include symbol + interval to prevent cross-timeframe corruption.
function displayKey(symbol,interval){return `${symbol}|${interval}`;}
function displayCacheMs(interval){return ['1m','3m','5m'].includes(interval)?40000:180000;}
async function loadDisplayBars(symbol,interval,force=false){
  if(!Object.hasOwn(CHART_LABELS,interval))throw new Error('Unsupported candle interval');
  const key=displayKey(symbol,interval),cached=displayCandles.get(key);
  if(cached&&!force&&Date.now()-cached.when<displayCacheMs(interval))return cached.bars;
  if(displayInFlight.has(key))return displayInFlight.get(key);
  const request=(async()=>{
    const raw=await json(`klines?symbol=${encodeURIComponent(symbol)}&interval=${interval}&limit=95`);
    // An in-progress candle is appropriate for a display, but NEVER passed to analyse()/trade signals.
    const bars=parseKlines(raw,Infinity);
    if(bars.length<2)throw new Error(`Insufficient ${CHART_LABELS[interval]} candles for ${symbol}`);
    displayCandles.set(key,{when:Date.now(),bars});
    return bars;
  })();
  displayInFlight.set(key,request);
  try{return await request;}finally{displayInFlight.delete(key);}
}
function selectInterval(container,interval){
  document.querySelectorAll(`#${container} [data-interval]`).forEach(b=>{
    const active=b.dataset.interval===interval;
    b.classList.toggle('active',active);b.setAttribute('aria-pressed',String(active));
  });
}
function drawChartError(canvas,message){const ctx=canvas.getContext('2d');ctx.clearRect(0,0,canvas.width,canvas.height);ctx.fillStyle='#98a4b7';ctx.font='18px sans-serif';ctx.fillText(message,18,Math.round(canvas.height*.5));}

const $=id=>document.getElementById(id);
const quote=s=>String(s).replace(/USDT$/,'');
const num=(n,d=2)=>Number.isFinite(+n)?Number(n).toLocaleString('en-US',{minimumFractionDigits:d,maximumFractionDigits:d}):'—';
const pct=n=>Number.isFinite(+n)?`${+n>=0?'+':''}${num(n,2)}%`:'—';
const cash=n=>Number.isFinite(n)?`${n<0?'-':''}$${num(Math.abs(n),2)}`:'—';
const escape=s=>String(s).replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
let markets=[],bySymbol=new Map(),candles=new Map(),scores=new Map(),busy=false,observer=null,scannedAt=0,ready=false;
const visibleSymbols=new Set();let chartRefreshBusy=false,shortRefreshAt=0;
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
  return [...new Set([...topVolume,...momentum,...activity,...markets].map(x=>x.symbol))]; // Analyse every monitored pair, not merely the early momentum sample.
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
const stageLabel=a=>a?.stage==='approaching'?'APPROACHING':a?.stage==='confirmed'?'BREAKOUT':a?.stage==='watch'?'ON RADAR':a?'OTHER':'UNSCANNED';
function stageWeight(a){return a?.stage==='approaching'?0:a?.stage==='confirmed'?1:a?.stage==='watch'?2:a?3:4;}
const meter=(label,value,valueText)=>`<div class="indicator-meter"><div class="meter-header"><span>${escape(label)}</span><b>${escape(valueText)}</b></div><div class="meter-track"><div class="meter-fill" style="width:${Math.max(0,Math.min(100,Number(value)||0)).toFixed(1)}%"></div></div></div>`;
function compactMeters(a){if(!a)return `<div class="unscanned-note">Hourly indicators pending — not ranked yet</div>`;
  return `<div class="card-indicators">${meter('TO RESISTANCE',a.proximity,a.distancePct<=0?'Above':num(a.distancePct,2)+'% below')}${meter('RSI 14',a.rsiMeter??0,Number.isFinite(a.technical.rsi14)?num(a.technical.rsi14,1):'—')}${meter('VOLUME / AVG',a.volumeMeter,num(a.volumeRatio,2)+'×')}</div>`;
}
function orderPairs(){const sort=$('sort').value,find=$('filter').value.trim().toUpperCase();let arr=markets.filter(m=>m.symbol.includes(find));arr.sort((a,b)=>{
  if(sort==='gain')return b.change-a.change;
  if(sort==='volume')return b.volume-a.volume;
  if(sort==='alphabetical')return a.symbol.localeCompare(b.symbol);
  const x=scores.get(a.symbol),y=scores.get(b.symbol);
  if(sort==='distance'){const xd=x?.distancePct>0?x.distancePct:Infinity,yd=y?.distancePct>0?y.distancePct:Infinity;return xd-yd||b.volume-a.volume;}
  return stageWeight(x)-stageWeight(y)||((y?.stage==='confirmed'?y?.score:y?.readinessScore)??-1)-((x?.stage==='confirmed'?x?.score:x?.readinessScore)??-1)||b.volume-a.volume;
});return arr;}
function cardHTML(m){const a=scores.get(m.symbol),sc=a?String(a.stage==='confirmed'?a.score:a.readinessScore):'—';return `<article class="coin-card" data-symbol="${escape(m.symbol)}" tabindex="0" role="button" aria-label="Open ${escape(m.symbol)} analysis"><div class="card-top"><div><div class="symbol">${escape(quote(m.symbol))}<span class="pair-quote">/USDT</span></div><div class="small-muted">24H ${pct(m.change)}</div></div><div><div class="score">${sc}</div><span class="score-label">${a?.stage==='confirmed'?'BREAKOUT':'READINESS'} /100</span></div></div><div class="card-stage ${a?.stage||'unscanned'}">${stageLabel(a)}</div><canvas width="560" height="210" aria-label="${escape(CHART_LABELS[chartInterval])} candle chart for ${escape(m.symbol)}"></canvas>${compactMeters(a)}<div class="card-bottom"><span>${a?triggers(a).length+' triggered models':'UNSCANNED'}</span><span class="${m.change>=0?'up':'down'}">VOL ${m.volume>=1e6?num(m.volume/1e6,1)+'M':num(m.volume/1e3,0)+'K'} USDT</span></div></article>`;}
function renderCards(){
  if(observer)observer.disconnect();visibleSymbols.clear();
  const cards=$('cards'),arr=orderPairs();cards.innerHTML=arr.length?arr.map(cardHTML).join(''):'<div class="empty">No matching trading pairs.</div>';
  const requestedInterval=chartInterval;
  observer=new IntersectionObserver(entries=>{for(const e of entries){
    const node=e.target,symbol=node.dataset.symbol;
    if(!e.isIntersecting){visibleSymbols.delete(symbol);continue;}
    visibleSymbols.add(symbol);
    if(node.querySelector('canvas').dataset.interval===requestedInterval)continue;
    loadDisplayBars(symbol,requestedInterval).then(bars=>drawCard(node,symbol,requestedInterval,bars)).catch(()=>{
      if(node.isConnected&&chartInterval===requestedInterval)drawChartError(node.querySelector('canvas'),'Chart unavailable');
    });
  }},{rootMargin:'120px'});
  cards.querySelectorAll('.coin-card').forEach(node=>{observer.observe(node);node.addEventListener('click',()=>detail(node.dataset.symbol));node.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();detail(node.dataset.symbol);}});});
}
const shortInterval=interval=>['1m','3m','5m'].includes(interval);
async function refreshVisibleCharts(force=false){
  if(chartRefreshBusy||document.hidden||!shortInterval(chartInterval)&&($('detail').hidden||!shortInterval(detailInterval)))return;
  chartRefreshBusy=true;const interval=chartInterval,targets=(force||shortInterval(interval))?[...visibleSymbols].slice(0,24):[];
  let updated=0,errors=0;
  try{
    await pool(targets,4,async symbol=>{try{const bars=await loadDisplayBars(symbol,interval,true);const node=[...$('cards').querySelectorAll('.coin-card')].find(el=>el.dataset.symbol===symbol);if(node&&node.isConnected&&chartInterval===interval){drawCard(node,symbol,interval,bars);updated++;}}catch(err){errors++;console.warn('Chart refresh failed',symbol,err.message);}});
    if(!$('detail').hidden&&detailSymbol&&shortInterval(detailInterval))await updateDetail(true);
    if(shortInterval(interval)||force){
      if(updated)shortRefreshAt=Date.now();
      $('chart-refresh-state').textContent=`${updated} visible ${CHART_LABELS[interval]} charts refreshed ${new Date().toISOString().slice(11,19)} UTC${errors?' · '+errors+' unavailable':''}.`;
    }
  }finally{chartRefreshBusy=false;}
}
function drawCandles(canvas,bars,resistance=null,overlays=false){
  const context=canvas.getContext('2d');if(!context||!bars?.length)return;
  const W=canvas.width,H=canvas.height;context.clearRect(0,0,W,H);
  const data=bars.slice(-48);const low=Math.min(...data.map(c=>c.low)),high=Math.max(...data.map(c=>c.high)),span=Math.max(high-low,low*0.00001);
  const top=H*.07,bottom=H*.77,left=10,right=W-10;
  const yy=p=>bottom-(p-low)/span*(bottom-top),step=(right-left)/data.length;
  context.strokeStyle='#293645';context.lineWidth=1;for(let i=0;i<4;i++){const y=top+(bottom-top)*i/3;context.beginPath();context.moveTo(left,y);context.lineTo(right,y);context.stroke();}
  if(Number.isFinite(resistance)&&resistance>=low&&resistance<=high){context.setLineDash([9,7]);context.strokeStyle='#b49b72';context.beginPath();context.moveTo(left,yy(resistance));context.lineTo(right,yy(resistance));context.stroke();context.setLineDash([]);}
  const vm=Math.max(1,...data.map(c=>c.volume));
  data.forEach((c,i)=>{const x=left+step*(i+.5),up=c.close>=c.open,color=up?'#3ee1a2':'#fa7180';context.strokeStyle=color;context.fillStyle=color;context.lineWidth=Math.max(1.5,step*.17);context.beginPath();context.moveTo(x,yy(c.high));context.lineTo(x,yy(c.low));context.stroke();const ya=yy(Math.max(c.open,c.close)),yb=yy(Math.min(c.open,c.close));context.fillRect(x-step*.27,ya,Math.max(2,step*.54),Math.max(2,yb-ya));context.globalAlpha=.3;context.fillRect(x-step*.27,H*.98-(c.volume/vm)*H*.15,Math.max(2,step*.54),(c.volume/vm)*H*.15);context.globalAlpha=1;});
  // EMA overlays on the expanded chart; values computed from full series to avoid warm-up bias.
  if(overlays){const series=[{values:emaSeries(bars.map(c=>c.close),9),color:'#6fe8df'},{values:emaSeries(bars.map(c=>c.close),21),color:'#f6ba72'}];
    for(const line of series){context.strokeStyle=line.color;context.lineWidth=2;context.beginPath();let started=false;const offset=bars.length-data.length;
      for(let i=0;i<data.length;i++){const v=line.values[offset+i];if(!Number.isFinite(v)){started=false;continue;}const x=left+step*(i+.5);if(!started){context.moveTo(x,yy(v));started=true;}else context.lineTo(x,yy(v));}context.stroke();}
  }
}
function drawCard(node,symbol,interval,bars){if(!node.isConnected||chartInterval!==interval)return;const canvas=node.querySelector('canvas');drawCandles(canvas,bars,interval==='1h'?scores.get(symbol)?.resistance:null);canvas.dataset.interval=interval;
  const score=scores.get(symbol);if(score){node.querySelector('.score').textContent=score.stage==='confirmed'?score.score:score.readinessScore;node.querySelector('.card-bottom span').textContent=triggers(score).length+' triggered models';}}
function renderApproaching(){
  const near=markets.filter(m=>scores.get(m.symbol)?.stage==='approaching').sort((a,b)=>scores.get(b.symbol).readinessScore-scores.get(a.symbol).readinessScore);
  $('metric-near').textContent=near.length;$('near-count').textContent=near.length;
  $('approaching').innerHTML=near.length?near.slice(0,8).map(m=>{const a=scores.get(m.symbol);return `<div class="signal-tile near-tile" data-symbol="${escape(m.symbol)}" tabindex="0" role="button"><div class="tile-top"><div><div class="symbol">${escape(quote(m.symbol))}<span class="pair-quote">/USDT</span></div><div class="small-muted">${num(a.distancePct,2)}% below 24h resistance</div></div><div><div class="score">${a.readinessScore}</div><div class="score-label">READINESS /100</div></div></div><div class="tile-details">RSI(14): ${num(a.technical.rsi14,1)} · Volume: ${num(a.volumeRatio,2)}×<br>Relative to BTC: ${pct(a.relative)} · Trend: ${a.trend?'bullish':'unconfirmed'}</div><div class="mini-progress"><span style="width:${a.proximity.toFixed(1)}%"></span></div><span class="tile-label">APPROACHING · NO ENTRY SIGNAL</span></div>`;}).join(''):'<div class="empty">No liquid analysed pairs currently meet the approaching-resistance criteria. No prediction is implied.</div>';
  $('approaching').querySelectorAll('[data-symbol]').forEach(n=>{n.addEventListener('click',()=>detail(n.dataset.symbol));n.addEventListener('keydown',e=>{if(e.key==='Enter')detail(n.dataset.symbol);});});
}
function renderSignals(){const matches=markets.filter(x=>triggers(scores.get(x.symbol)).length).sort((a,b)=>(scores.get(b.symbol).score-scores.get(a.symbol).score));$('metric-signals').textContent=matches.length;
  $('signals').innerHTML=matches.length?matches.slice(0,8).map(m=>{const a=scores.get(m.symbol);return `<div class="signal-tile" data-symbol="${escape(m.symbol)}" tabindex="0" role="button"><div class="tile-top"><div><div class="symbol">${escape(quote(m.symbol))}<span class="pair-quote">/USDT</span></div><div class="small-muted">24H ${pct(m.change)}</div></div><div><div class="score">${a.score}</div><div class="score-label">SETUP /100</div></div></div><div class="tile-details">Relative strength vs BTC: ${pct(a.relative)}<br>Volume / 20h avg: ${num(a.volumeRatio,1)}×</div><span class="tile-label">${escape(triggers(a).map(s=>s.name).join(' · '))}</span></div>`;}).join(''):'<div class="empty">No confirmed breakout triggers among analysed pairs. This is a valid no-trade result.</div>';
  $('signals').querySelectorAll('[data-symbol]').forEach(n=>{n.addEventListener('click',()=>detail(n.dataset.symbol));n.addEventListener('keydown',e=>{if(e.key==='Enter')detail(n.dataset.symbol)});});
}
async function detail(symbol){
  detailSymbol=symbol;
  $('detail').hidden=false;$('detail-symbol').textContent=symbol;
  detailInterval=chartInterval;selectInterval('detail-timeframes',detailInterval);
  await updateDetail();
}
async function updateDetail(force=false){
  if(!detailSymbol||$('detail').hidden)return;
  const symbol=detailSymbol,interval=detailInterval,requestId=++detailRequest,canvas=$('detail-chart');
  $('detail-timeframe-label').textContent=`PAIR DETAIL / ${interval==='1M'?'1M':interval.toUpperCase()} CHART`;
  $('detail-stats').textContent=`Loading ${CHART_LABELS[interval]} candles…`;
  $('detail-indicators').textContent='Loading indicator calculations…';
  $('detail-explanation').textContent='';canvas.getContext('2d').clearRect(0,0,canvas.width,canvas.height);
  try{
    const bars=await loadDisplayBars(symbol,interval,force);
    if(requestId!==detailRequest||$('detail').hidden)return;
    const a=scores.get(symbol),m=bySymbol.get(symbol),tech=indicators(bars),bb=tech.bollinger;
    drawCandles(canvas,bars,interval==='1h'?a?.resistance:null,true);canvas.dataset.interval=interval;
    canvas.dataset.lastUpdate=String(Date.now());
    $('detail-stats').innerHTML=`<span>CHART <b>${escape(CHART_LABELS[interval])} candles</b></span><span>AVAILABLE <b>${bars.length} bars</b></span><span>LAST CHART CLOSE <b>${num(bars.at(-1)?.close,6)}</b> USDT</span><span>24H MARKET <b>${pct(m?.change)}</b></span><span>1H RESISTANCE <b>${num(a?.resistance,6)}</b></span><span>RESISTANCE DISTANCE <b>${a?num(a.distancePct,2)+'%':'—'}</b></span>`;
    const items=[['RSI (14)',num(tech.rsi14,1)],['MACD HIST',num(tech.macd.histogram,6)],['EMA (9)',num(tech.ema9,6)],['EMA (21)',num(tech.ema21,6)],['EMA (50)',num(tech.ema50,6)],['BB WIDTH (20,2)',num(bb.widthPct,2)+'%'],['ATR (14)',num(tech.atrPct,2)+'%'],['1H VOLUME / AVG',a?num(a.volumeRatio,2)+'×':'—'],['1H VS BTC',a?pct(a.relative):'—'],['1H READINESS',a?String(a.readinessScore)+'/100':'—']];
    $('detail-indicators').innerHTML=items.map(([label,value])=>`<div class="detail-indicator"><span>${escape(label)}</span><strong>${escape(value)}</strong></div>`).join('');
    $('detail-explanation').innerHTML=a?`<strong>Hourly classification:</strong> ${escape(stageLabel(a))} · ${num(a.distancePct,2)}% below resistance (negative means above). <strong>Readiness:</strong> ${a.readinessScore}/100 (heuristic, not a probability).<br><strong>Hourly paper-entry triggers:</strong> ${triggers(a).length?triggers(a).map(s=>escape(s.name)).join(', '):'None'} · <strong>Trend:</strong> ${a.trend?'bullish':'not confirmed'}. <strong>Compression:</strong> ${a.compression?'detected':'not detected'}.<br><strong>Overlay:</strong> <span class="ema9-legend">EMA 9</span> and <span class="ema21-legend">EMA 21</span>. RSI, MACD, EMA, Bollinger Bands and ATR are calculated from the selected chart interval, which may include a forming candle; screening and all paper trades still use closed 1H candles.`:'This pair has no completed hourly assessment. The chart indicators are informational, and may include the forming candle.';
  }catch(e){if(requestId===detailRequest&&!$('detail').hidden){$('detail-stats').textContent='Market candles unavailable: '+e.message;$('detail-indicators').textContent='No valid indicator data';drawChartError(canvas,'Chart unavailable');}}
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
    scannedAt=Date.now();$('metric-scanned').textContent=scores.size;$('metric-time').textContent=new Date(scannedAt).toISOString().slice(11,19);renderCards();renderApproaching();renderSignals();await managePositions();await enterSignals();paperUI();status(`Scan complete · ${scores.size}/${markets.length} analysed · ${errors} unavailable · hourly screening ~5 min`);
    if(errors)showError(`${errors} symbols could not be analysed. Missing series were excluded, not estimated.`);
  }catch(e){status('Scan failed · no invented data');showError(e.message);}finally{busy=false;$('refresh').disabled=false;}
}
function downloadCSV(){const all=STRATEGIES.flatMap(s=>paper.portfolios[s.id].trades);const header=['strategy','symbol','entry_time_utc','exit_time_utc','entry_fill','exit_fill','cost_usdt','proceeds_usdt','entry_fee_usdt','exit_fee_usdt','net_pnl_usdt','return_pct','reason'];const lines=all.map(t=>[t.strategyId,t.symbol,new Date(t.entryTime).toISOString(),new Date(t.exitTime).toISOString(),t.entryPrice,t.exitPrice,t.cost,t.proceeds,t.entryFee,t.exitFee,t.pnl,t.returnPct,t.reason].join(','));const b=new Blob([[header.join(','),...lines].join('\n')],{type:'text/csv'});const url=URL.createObjectURL(b);const a=document.createElement('a');a.href=url;a.download='breakout-lab-paper-trades.csv';a.click();URL.revokeObjectURL(url);}
function init(){
  $('methods').innerHTML=STRATEGIES.map((s,i)=>`<div class="method-card"><div class="ordinal">MODEL 0${i+1}</div><h3>${escape(s.name)}</h3><p>${escape(s.description)} Requires a closed hourly breakout candle; the additional filters vary by model. Every model begins with its own $10,000 simulated cash balance.</p></div>`).join('');
  $('refresh').addEventListener('click',scan);$('refresh-charts').addEventListener('click',()=>refreshVisibleCharts(true));$('filter').addEventListener('input',renderCards);$('sort').addEventListener('change',renderCards);
  selectInterval('chart-timeframes',chartInterval);selectInterval('detail-timeframes',chartInterval);
  $('chart-timeframes').addEventListener('click',e=>{const button=e.target.closest('button[data-interval]');if(!button||!Object.hasOwn(CHART_LABELS,button.dataset.interval))return;
    const chosen=button.dataset.interval;if(chosen===chartInterval)return;chartInterval=chosen;
    try{localStorage.setItem('breakout-chart-interval',chosen);}catch{}
    selectInterval('chart-timeframes',chosen);renderCards();$('chart-refresh-state').textContent=shortInterval(chosen)?'Auto-refresh every ~60 seconds for visible charts while open.':'Hourly model scan continues every ~5 minutes.';
    if(!$('detail').hidden){detailInterval=chosen;selectInterval('detail-timeframes',chosen);updateDetail();}
  });
  $('detail-timeframes').addEventListener('click',e=>{const button=e.target.closest('button[data-interval]');if(!button||!Object.hasOwn(CHART_LABELS,button.dataset.interval))return;
    detailInterval=button.dataset.interval;selectInterval('detail-timeframes',detailInterval);updateDetail();
  });
  $('paper-toggle').addEventListener('click',()=>{armed=!armed;localStorage.setItem('breakout-armed',armed?'yes':'no');paperUI();if(armed&&ready)enterSignals();});
  $('export').addEventListener('click',downloadCSV);$('reset').addEventListener('click',()=>{if(confirm('Erase all four local virtual portfolios and their trade history? This cannot be undone.')){paper=createState();save();paperUI();}});
  $('close-detail').addEventListener('click',()=>{$('detail').hidden=true;detailRequest++;});$('detail').querySelector('[data-close]').addEventListener('click',()=>{$('detail').hidden=true;detailRequest++;});document.addEventListener('keydown',e=>{if(e.key==='Escape'){$('detail').hidden=true;detailRequest++;}});
  const clock=()=>{$('clock').textContent=new Date().toISOString().slice(11,19)+' UTC';};clock();setInterval(clock,1000);
  paperUI();scan();setInterval(()=>{if(!document.hidden)scan();},5*60000);setInterval(()=>{if(!document.hidden&&!busy)managePositions();},60000);
  setInterval(()=>{if(!document.hidden)refreshVisibleCharts();},60000);
  document.addEventListener('visibilitychange',()=>{if(!document.hidden&&shortInterval(chartInterval))refreshVisibleCharts();});
  $('chart-refresh-state').textContent=shortInterval(chartInterval)?'Visible charts auto-refresh every ~60 seconds while open.':'Hourly model scan continues every ~5 minutes.';
}
init();