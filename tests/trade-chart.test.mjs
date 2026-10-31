import test from 'node:test';
import assert from 'node:assert/strict';
import {tradeKey,recordedTrades,tradeLevels,tradeMinuteWindow,minuteMarkerPosition} from '../trade-chart.mjs';
import {DEFAULT_CONFIG} from '../engine.mjs';

test('only actual paper trade records are available for chart markers',()=>{
  const open={symbol:'MOMUSDT',strategyId:'breakout',entryTime:1700000000000,entryPrice:100};
  const closed={symbol:'MOMUSDT',strategyId:'volume',entryTime:1699990000000,entryPrice:101,exitTime:1700000040000,exitPrice:104};
  const s={portfolios:{breakout:{positions:[open],trades:[]},volume:{positions:[],trades:[closed]},strength:{positions:[],trades:[{symbol:'OTHERUSDT',entryTime:1700000000000,entryPrice:102}]}}};
  const trades=recordedTrades(s,'MOMUSDT');
  assert.equal(trades.length,2);
  assert.equal(trades[0].strategyId,'breakout');
  assert.equal(trades[1].exitPrice,104);
  assert.equal(recordedTrades(s,'OTHERUSDT').length,1);
  assert.equal(recordedTrades({portfolios:{}},'NOUSDT').length,0);
  assert.equal(tradeKey(open),'breakout|MOMUSDT|1700000000000');
});

test('stop and target lines reflect exact trigger quote including simulated slippage',()=>{
  const trade={entryPrice:100,entryTime:1700000000000,exitPrice:101.85,exitTime:1700000060000};
  const levels=tradeLevels(trade,DEFAULT_CONFIG);
  assert.ok(Math.abs(levels.stopTrigger*(1-DEFAULT_CONFIG.slippagePct/100)-98.5)<1e-10);
  assert.ok(Math.abs(levels.targetTrigger*(1-DEFAULT_CONFIG.slippagePct/100)-102)<1e-10);
  assert.equal(levels.entry,100);
  assert.equal(levels.exit,101.85);
  assert.equal(tradeLevels({...trade,entryPrice:-1},DEFAULT_CONFIG),null);
});

test('minute windows are anchored to the real entry or exit timestamp and never look into future',()=>{
  const t={entryTime:1700000000000,exitTime:1700006000000};
  const now=1700010000000;
  const entry=tradeMinuteWindow(t,'entry',now);
  assert.equal(entry.startTime,t.entryTime-30*60000);
  assert.equal(entry.endTime,t.entryTime+150*60000);
  const exit=tradeMinuteWindow(t,'exit',now);
  assert.equal(exit.startTime,t.exitTime-120*60000);
  assert.equal(exit.endTime,t.exitTime+60*60000);
  assert.throws(()=>tradeMinuteWindow({entryTime:t.entryTime},'exit'),/has not exited/);
});

test('event markers map to the actual one-minute candle and remain absent across missing minutes',()=>{
  const base=1700000000000;
  const bars=[0,1,3].map(i=>({time:base+i*60000,closeTime:base+(i+1)*60000-1}));
  const x=minuteMarkerPosition(bars,base+30000,10,310);
  assert.ok(Math.abs(x-60)<1e-6);
  assert.equal(minuteMarkerPosition(bars,base+2*60000+1000),null);
  assert.equal(minuteMarkerPosition(bars,base-1),null);
  assert.equal(minuteMarkerPosition(bars,base+3*60000+1000,10,310)>200,true);
});