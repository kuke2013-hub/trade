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
const symbols=['BTCUSDT','MOMUSDT',...Array.from({length:270},(_,i)=>`ALT${String(i).padStart(3,'0')}USDT`)];
const info={symbols:symbols.map(symbol=>({symbol,quoteAsset:'USDT',status:'TRADING',isSpotTradingAllowed:true}))};
const tickers=symbols.map((symbol,i)=>({symbol,lastPrice:symbol==='MOMUSDT'?'103.5':'100',priceChangePercent:symbol==='MOMUSDT'?'35':String(i%10-4),quoteVolume:symbol==='MOMUSDT'?'40000000':String(2000000+i*100000)}));
const bars=(symbol,interval)=>{
  if(interval==='1m')return [[now-120000,'102','102.5','101.5','102','80',now-60001]];
  return Array.from({length:95},(_,i)=>{
    const t=now-(95-i)*h-180000;
    let p=100+(i%2)*.2,vol=100,open=p-.1,hi=p+.7,lo=p-.8;
    if(i===94&&symbol==='MOMUSDT'){p=103.5;open=101;hi=104;lo=100.4;vol=500;}
    return [t,String(open),String(hi),String(lo),String(p),String(vol),t+h-1];
  });
};
let browser;
try{
  browser=await chromium.launch({headless:true});
  const page=await browser.newPage({viewport:{width:1440,height:900}});
  const pageErrors=[];page.on('pageerror',err=>pageErrors.push(String(err)));
  await page.route('https://data-api.binance.vision/api/v3/**',async route=>{
    const u=new URL(route.request().url()),p=u.pathname;
    let body;
    if(p.endsWith('exchangeInfo'))body=info;
    else if(p.endsWith('ticker/24hr'))body=tickers;
    else if(p.endsWith('bookTicker'))body={symbol:u.searchParams.get('symbol'),askPrice:'104',bidPrice:'103.9'};
    else if(p.endsWith('klines'))body=bars(u.searchParams.get('symbol'),u.searchParams.get('interval'));
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
  assert.equal(pageErrors.length,0,'No runtime exceptions: '+pageErrors.join(' | '));
  await page.locator('#paper-toggle').click();
  await page.waitForFunction(()=>JSON.parse(localStorage.getItem('breakout-paper-v1')||'null')?.portfolios?.breakout?.positions?.length>0,{timeout:10000});
  let state=await page.evaluate(()=>JSON.parse(localStorage.getItem('breakout-paper-v1')));
  assert.equal(state.portfolios.breakout.positions[0].symbol,'MOMUSDT');
  assert.ok(state.portfolios.breakout.positions[0].entryFee>0);
  const card=page.locator('.coin-card[data-symbol="MOMUSDT"]');
  await card.click();assert.equal(await page.locator('#detail-symbol').innerText(),'MOMUSDT');
  await page.locator('#close-detail').click();
  await page.locator('#filter').fill('MOM');assert.equal(await page.locator('.coin-card').count(),1);
  await page.locator('#filter').fill('');
  await page.screenshot({path:'dashboard-smoke.png'});
  console.log(`UI INTEGRATION PASSED: ${pairs} pairs, ${analysed} analysed, ${signals} signal(s), paper entry recorded, filter/detail operational.`);
}finally{if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));}