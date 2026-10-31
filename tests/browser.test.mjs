/* Browser integration with synthetic fixtures. It verifies UI wiring, not live Binance availability or alpha. */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { join, extname } from 'node:path';
const dir=new URL('../',import.meta.url);
const port=8767;
const server=createServer(async(req,res)=>{
  try{const rel=req.url==='/'?'index.html':decodeURIComponent(req.url.slice(1));
    if(!['index.html','styles.css','app.mjs','engine.mjs'].includes(rel)){res.writeHead(404);res.end('Not found');return;}
    const bytes=await readFile(new URL(rel,dir));
    res.writeHead(200,{'Content-Type':extname(rel)==='.css'?'text/css':extname(rel)==='.html'?'text/html':'text/javascript'});res.end(bytes);
  }catch(e){res.writeHead(500);res.end(String(e));}
});
await new Promise(resolve=>server.listen(port,'127.0.0.1',resolve));
const now=Date.now(),h=3600000;
const symbols=['BTCUSDT','MOMUSDT','NEARUSDT',...Array.from({length:270},(_,i)=>`ALT${String(i).padStart(3,'0')}USDT`)];
const info={symbols:symbols.map(symbol=>({symbol,quoteAsset:'USDT',status:'TRADING',isSpotTradingAllowed:true}))};
const tickers=symbols.map((symbol,i)=>({symbol,lastPrice:symbol==='MOMUSDT'?'103.5':'100',priceChangePercent:symbol==='MOMUSDT'?'35':String(i%10-4),quoteVolume:symbol==='MOMUSDT'?'40000000':String(2000000+i*100000)}));
const bars=(symbol,interval)=>{
  const step={'1m':60000,'3m':180000,'5m':300000,'1h':3600000,'1d':86400000,'1w':604800000,'1M':2592000000}[interval];
  if(!step)throw new Error('Unexpected interval: '+interval);
  return Array.from({length:95},(_,i)=>{
    const t=now-(95-i)*step-180000;
    let p=symbol==='NEARUSDT'?96+i*.04:100+(i%2)*.2,vol=100,open=p-.1,hi=p+.7,lo=p-.8;
    if(i===94&&symbol==='MOMUSDT'){p=103.5;open=101;hi=104;lo=100.4;vol=500;}
    return [t,String(open),String(hi),String(lo),String(p),String(vol),t+step-1];
  });
};
let browser;
try{
  browser=await chromium.launch({headless:true});
  const page=await browser.newPage({viewport:{width:1440,height:900}});
  const pageErrors=[];page.on('pageerror',err=>pageErrors.push(String(err)));
  await page.addInitScript(()=>{
    const original=window.setInterval.bind(window);
    window.__scheduledIntervals=[];
    window.setInterval=(callback,delay,...args)=>{
      window.__scheduledIntervals.push({source:String(callback),delay});
      return original(callback,delay,...args);
    };
  });
  const seenIntervals=new Set(),intervalRequests=new Map();
  let tickerCalls=0,exchangeCalls=0,hourlyCalls=0;
  await page.route('https://data-api.binance.vision/api/v3/**',async route=>{
    const u=new URL(route.request().url()),p=u.pathname;
    let body;
    if(p.endsWith('exchangeInfo')){exchangeCalls++;body=info;}
    else if(p.endsWith('ticker/24hr')){tickerCalls++;body=tickers;}
    else if(p.endsWith('bookTicker'))body={symbol:u.searchParams.get('symbol'),askPrice:'104',bidPrice:'103.9'};
    else if(p.endsWith('klines')){const interval=u.searchParams.get('interval');seenIntervals.add(interval);intervalRequests.set(interval,(intervalRequests.get(interval)||0)+1);if(interval==='1h')hourlyCalls++;body=bars(u.searchParams.get('symbol'),interval);}
    else throw new Error('Unexpected Binance route '+p);
    await route.fulfill({status:200,contentType:'application/json',headers:{'access-control-allow-origin':'*'},body:JSON.stringify(body)});
  });
  await page.goto(`http://127.0.0.1:${port}/`,{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>/^\d+$/.test(document.getElementById('metric-scanned').textContent),{timeout:60000});
  const pairs=+(await page.locator('#metric-pairs').innerText());
  const analysed=+(await page.locator('#metric-scanned').innerText());
  const signals=+(await page.locator('#metric-signals').innerText());
  assert.ok(pairs>=200,`Expected hundreds of real-shaped pairs; got ${pairs}`);
  assert.ok(analysed>=50,`Expected research sample; got ${analysed}`);
  assert.ok(signals>=1,'Expected fixture breakout signal');
  assert.ok((await page.locator('.coin-card').count())>=200,'Expected cards');
  assert.ok(+(await page.locator('#metric-near').innerText())>=1,'Expected pre-breakout candidates');
  assert.equal(await page.locator('.coin-card').first().getAttribute('data-symbol'),'NEARUSDT','Approaching resistance must sort before already confirmed breakouts');
  assert.equal(await page.locator('.coin-card[data-symbol="NEARUSDT"] .card-stage').innerText(),'APPROACHING');
  assert.ok((await page.locator('#approaching .signal-tile').count())>=1);
  assert.ok((await page.locator('.coin-card[data-symbol="NEARUSDT"] .indicator-meter').count())===3);
  assert.equal(pageErrors.length,0,'No runtime exceptions: '+pageErrors.join(' | '));
  await page.locator('#paper-toggle').click();
  await page.waitForFunction(()=>JSON.parse(localStorage.getItem('breakout-paper-v1')||'null')?.portfolios?.breakout?.positions?.length>0,{timeout:10000});
  let state=await page.evaluate(()=>JSON.parse(localStorage.getItem('breakout-paper-v1')));
  assert.equal(state.portfolios.breakout.positions[0].symbol,'MOMUSDT');
  assert.ok(state.portfolios.breakout.positions[0].entryFee>0);
  const card=page.locator('.coin-card[data-symbol="MOMUSDT"]');
  await card.click();assert.equal(await page.locator('#detail-symbol').innerText(),'MOMUSDT');
  await page.waitForFunction(()=>document.querySelectorAll('#detail-indicators .detail-indicator').length>=8,{timeout:20000});
  assert.match(await page.locator('#detail-indicators').innerText(),/RSI \(14\)/);
  assert.match(await page.locator('#detail-indicators').innerText(),/MACD HIST/);
  // The detailed chart can switch intervals without changing the hourly model.
  for(const interval of ['1M','1w','1d','1h','5m','3m','1m']){
    await page.locator(`#detail-timeframes button[data-interval="${interval}"]`).click();
    await page.waitForFunction(interval=>document.querySelector('#detail-chart')?.dataset.interval===interval,interval,{timeout:20000});
    assert.equal(await page.locator('#detail-timeframes button.active').getAttribute('data-interval'),interval);
  }
  await page.locator('#close-detail').click();
  // The global selector switches all visible cards and persists the user's selection.
  await page.locator('#chart-timeframes button[data-interval="3m"]').click();
  await page.waitForFunction(()=>document.querySelector('.coin-card canvas[data-interval="3m"]'),{timeout:20000});
  assert.equal(await page.evaluate(()=>localStorage.getItem('breakout-chart-interval')),'3m');
  await page.locator('#chart-timeframes button[data-interval="1m"]').click();
  await page.waitForFunction(()=>document.querySelector('.coin-card canvas[data-interval="1m"]'),{timeout:20000});
  assert.ok(['1h','1m','3m','5m','1M','1w','1d'].every(x=>seenIntervals.has(x)),'Expected requests for each supported interval');
  assert.equal(pageErrors.length,0,'No runtime errors while switching chart intervals: '+pageErrors.join(' | '));
  const before=intervalRequests.get('1m')||0;
  await page.locator('#refresh-charts').click();
  await page.waitForFunction(()=>document.querySelector('#chart-refresh-state')?.textContent.includes('refreshed'),{timeout:20000});
  assert.ok((intervalRequests.get('1m')||0)>before,'Manual short-candle refresh should request new Binance data');
  await page.locator('#filter').fill('MOM');assert.equal(await page.locator('.coin-card').count(),1);
  await page.locator('#filter').fill('');
  // Recheck the entire universe from fresh ticker data without redownloading
  // unchanged hourly history; this is the work a minute tick performs.
  const scheduledScan=await page.evaluate(()=>window.__scheduledIntervals.find(i=>i.source.includes('scan()')));
  assert.equal(scheduledScan?.delay,60000,'Full market scan must run every minute while tab is active');
  const beforeTickers=tickerCalls,beforeHourly=hourlyCalls;
  tickers.find(t=>t.symbol==='NEARUSDT').lastPrice='90';
  await page.locator('#refresh').click();
  await page.waitForFunction(()=>document.querySelector('.coin-card[data-symbol="NEARUSDT"] .card-stage')?.textContent.trim()==='OTHER',{timeout:30000});
  assert.equal(tickerCalls,beforeTickers+1,'Refresh must request a new ticker snapshot');
  assert.equal(exchangeCalls,1,'Static exchange metadata should be reused within one hour');
  assert.equal(hourlyCalls,beforeHourly,'Unchanged 1h candle histories should remain cached');
  await page.waitForFunction(()=>document.querySelector('#scan-status')?.textContent.includes('live rankings ~1 min'),{timeout:30000});
  assert.match(await page.locator('#scan-status').innerText(),/live rankings ~1 min/);
  await page.screenshot({path:'dashboard-smoke.png'});
  console.log(`UI INTEGRATION PASSED: ${pairs} pairs, ${analysed} analysed, ${signals} signal(s), all seven chart intervals, approaching-resistance rank and technical indicators, paper entry, filter/detail operational.`);
}finally{if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));}