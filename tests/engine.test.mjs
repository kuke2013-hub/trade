import test from 'node:test';
import assert from 'node:assert/strict';
import {analyse,parseKlines,createState,openPaper,closePaper,evaluateExit,portfolioStats,fillBuy,sellProceeds,ema,atr} from '../engine.mjs';
const HOUR=3600000;
function series({breakout=true,volume=200,compression=false}={}) {
  let t=Date.UTC(2026,8,1);
  const cs=Array.from({length:60},(_,i)=>{
    const c=100+(i%2===0?0.2:-0.2)+i*0.01;
    let width=compression&&i>27&&i<59?0.05:0.7;
    return {time:t+i*HOUR,closeTime:t+(i+1)*HOUR-1,open:c-0.1,close:c,high:c+width,low:c-width,volume:100};
  });
  if(breakout){cs[59]={...cs[59],open:101,high:104,low:100.9,close:103.5,volume};}
  return cs;
}
test('parseKlines excludes still-open candle, invalid and duplicate rows',()=>{
  const now=500000;
  const row=(t,ct)=>[t,'100','102','99','101','8',ct];
  assert.equal(parseKlines([row(1,100),row(1,100),row(2,600000),['bad','1','2','3','4','5',10]],now).length,1);
});
test('EMA and ATR are numerical only when sufficiently sampled',()=>{
  assert.ok(Number.isNaN(ema([1,2],4)));
  assert.ok(Number.isFinite(ema([1,2,3,4,5],3)));
  assert.ok(atr(series())>0);
});
test('breakout signal requires actual close above preceding resistance',()=>{
  assert.equal(analyse(series()).trigger.breakout,true);
  assert.equal(analyse(series({breakout:false})).trigger.breakout,false);
});
test('missing hourly bars suppress stale predictive signals',()=>{const c=series();c[40].time+=3600000;assert.equal(analyse(c),null);});
test('volume signal responds to volume ratio, never future bars',()=>{
  const a=analyse(series({volume:250}));
  assert.equal(a.trigger.volume,true);
  const b=analyse(series({volume:80}));
  assert.equal(b.trigger.volume,false);
  assert.equal(analyse(series().slice(0,-1)).trigger.breakout,false);
});
test('relative strength requires BTC outperformance and a breakout',()=>{
  const strong=analyse(series({volume:250}),-5);
  assert.equal(strong.trigger.strength,true);
  const weak=analyse(series({volume:250}),20);
  assert.equal(weak.trigger.strength,false);
});
test('compression uses preceding candles only',()=>{
  assert.equal(analyse(series({compression:true,volume:200})).trigger.compression,true);
  assert.equal(analyse(series({compression:false,volume:200})).trigger.compression,false);
});
test('paper trade charges two-sided fees/slippage and prevents duplicates',()=>{
  const s=createState();
  const t=Date.UTC(2026,8,3);
  assert.equal(openPaper(s,'breakout','FOOUSDT',100,t-1,t),true);
  assert.equal(openPaper(s,'breakout','FOOUSDT',100,t-1,t),false);
  const open=s.portfolios.breakout.positions[0];
  assert.ok(open.quantity>0);
  const result=closePaper(s,'breakout','FOOUSDT',102,'target',t+HOUR);
  assert.ok(result.pnl>0&&result.pnl<4);
  assert.ok(result.entryFee>0&&result.exitFee>0);
  assert.equal(s.portfolios.breakout.positions.length,0);
  assert.ok(portfolioStats(s.portfolios.breakout,{},s.config).realised===result.pnl);
});
test('stop wins ties inside OHLC candle (no lookahead profit bias)',()=>{
  const state=createState();
  const now=Date.UTC(2026,8,4);
  openPaper(state,'breakout','FOOUSDT',100,now-1,now);
  const p=state.portfolios.breakout.positions[0];
  const c={time:now+60000,closeTime:now+119999,open:100,high:104,low:97,close:101};
  assert.equal(evaluateExit(p,[c],now+120000,state.config).reason,'stop');
});
test('target, timeout and empty data handled explicitly',()=>{
  const s=createState(),t=Date.UTC(2026,8,4);
  openPaper(s,'volume','BARUSDT',100,t-1,t);
  const p=s.portfolios.volume.positions[0];
  assert.equal(evaluateExit(p,[],t+25*HOUR,s.config),null);
  const c={time:t+HOUR,closeTime:t+HOUR+59999,open:100,high:104,low:100,close:103};
  assert.equal(evaluateExit(p,[c],t+2*HOUR,s.config).reason,'target');
  const flat={...c,time:t+24*HOUR,closeTime:t+24*HOUR+59999,high:101,low:99,close:100};
  assert.equal(evaluateExit(p,[flat],t+25*HOUR,s.config).reason,'time');
});
test('sell proceeds and fee formulas are mathematically consistent',()=>{
  const c=createState().config,b=fillBuy(100,c),s=sellProceeds(b.quantity,100,c);
  assert.ok(s.net<c.allocation);
  assert.ok(Math.abs(s.net-b.quantity*100*(1-c.slippagePct/100)*(1-c.feePct/100))<1e-8);
});