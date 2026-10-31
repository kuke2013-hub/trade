/* Breakout Laboratory research engine: pure, deterministic, no network or orders. */
export const STRATEGIES = [
  { id: 'breakout', name: 'Resistance breakout', description: 'Close clears the preceding 24-hour high.' },
  { id: 'volume', name: 'Volume confirmation', description: 'Breakout with unusually strong volume.' },
  { id: 'compression', name: 'Compression release', description: 'Quiet range expands into a confirmed breakout.' },
  { id: 'strength', name: 'Relative strength', description: 'Breakout with strong performance relative to BTC.' }
];
export const DEFAULT_CONFIG = Object.freeze({startingCash:10000, allocation:200, maxPositions:3, targetPct:2, stopPct:1.5, feePct:0.1, slippagePct:0.05, maxHoldHours:24});
const finite = x => Number.isFinite(x);
export function parseKlines(raw, now = Date.now()) {
  if (!Array.isArray(raw)) return [];
  return raw.map(r=>({time:+r[0],open:+r[1],high:+r[2],low:+r[3],close:+r[4],volume:+r[5],closeTime:+r[6]}))
    .filter(c=>[c.time,c.open,c.high,c.low,c.close,c.volume,c.closeTime].every(finite)&&c.open>0&&c.close>0&&c.low>0&&c.high>=Math.max(c.open,c.close,c.low)&&c.low<=Math.min(c.open,c.close)&&c.volume>=0&&c.closeTime<now)
    .sort((a,b)=>a.time-b.time).filter((c,i,arr)=>i===0||c.time!==arr[i-1].time);
}
export function sma(xs) { return xs.length ? xs.reduce((a,b)=>a+b,0)/xs.length : NaN; }
export function ema(values,period){if(values.length<period)return NaN;let v=sma(values.slice(0,period));let alpha=2/(period+1);for(let i=period;i<values.length;i++)v=values[i]*alpha+v*(1-alpha);return v;}
export function atr(cs,period=14){if(cs.length<period+1)return NaN;const a=[];for(let i=cs.length-period;i<cs.length;i++){const x=cs[i],p=cs[i-1].close;a.push(Math.max(x.high-x.low,Math.abs(x.high-p),Math.abs(x.low-p)));}return sma(a);}
export function analyse(candles,btcReturn24h=0){
  const c=candles, n=c.length;
  if(n<55)return null;
  const last=c[n-1], prior=c.slice(n-25,n-1), prev20=c.slice(n-21,n-1);
  const resistance=Math.max(...prior.map(x=>x.high));
  const avgVol=sma(prev20.map(x=>x.volume));
  const volumeRatio=avgVol>0?last.volume/avgVol:0;
  const closeLocation=last.high>last.low?(last.close-last.low)/(last.high-last.low):0.5;
  const closes=c.map(x=>x.close);
  const trend=ema(closes,9)>ema(closes,21)&&ema(closes,21)>ema(closes,50);
  const breakout=last.close>resistance*1.001&&closeLocation>=0.60;
  const coin24h=c[n-25].close>0?(last.close/c[n-25].close-1)*100:0;
  const relative=coin24h-btcReturn24h;
  const recentRanges=c.slice(n-9,n-1).map(x=>(x.high-x.low)/x.close);
  const oldRanges=c.slice(n-33,n-9).map(x=>(x.high-x.low)/x.close);
  const compression=sma(recentRanges)<sma(oldRanges)*0.8;
  const trigger={breakout,volume:breakout&&volumeRatio>=1.5,compression:breakout&&compression&&volumeRatio>=1.2,strength:breakout&&relative>=3&&trend};
  // Heuristic ranking score, NOT a probability of return or calibrated confidence.
  const setup=Math.round(Math.min(100,Math.max(0, (breakout?34:0)+(trend?18:0)+Math.min(20,volumeRatio*7)+(compression?12:0)+Math.min(16,Math.max(0,relative)*2))));
  return {resistance,volumeRatio,closeLocation,trend,breakout,compression,relative,coin24h,atr:atr(c),score:setup,trigger,lastBarTime:last.closeTime,close:last.close, volume:last.volume};
}
export function createState(config=DEFAULT_CONFIG){return {version:1,config:{...DEFAULT_CONFIG,...config},portfolios:Object.fromEntries(STRATEGIES.map(s=>[s.id,{cash:config.startingCash??DEFAULT_CONFIG.startingCash,positions:[],trades:[],seenSignals:{}}])),createdAt:Date.now(),updatedAt:Date.now()};}
export function fillBuy(quote,config){const execution=quote*(1+config.slippagePct/100);const feeRate=config.feePct/100;return {execution,quantity:(config.allocation/(1+feeRate))/execution,entryFee:config.allocation*feeRate/(1+feeRate)};}
export function sellProceeds(quantity,marketPrice,config){const execution=marketPrice*(1-config.slippagePct/100);const gross=quantity*execution;return {execution,gross,fee:gross*config.feePct/100,net:gross*(1-config.feePct/100)};}
export function openPaper(state,strategyId,symbol,price,signalBar,at=Date.now()){
  const p=state.portfolios[strategyId],cfg=state.config;
  if(!p||!finite(price)||price<=0||!finite(at)||!finite(signalBar))return false;
  if(p.positions.length>=cfg.maxPositions||p.positions.some(x=>x.symbol===symbol)||p.cash<cfg.allocation)return false;
  const key=symbol+':'+signalBar;
  if(p.seenSignals[key])return false;
  const buy=fillBuy(price,cfg);
  p.cash-=cfg.allocation;p.seenSignals[key]=1;
  p.positions.push({symbol,strategyId,entryTime:at,entryMarket:price,entryPrice:buy.execution,quantity:buy.quantity,entryFee:buy.entryFee,cost:cfg.allocation,signalBar,lastChecked:at,status:'open'});
  state.updatedAt=at;return true;
}
export function evaluateExit(position,minuteCandles,now,config){
  const tp=position.entryPrice*(1+config.targetPct/100)/(1-config.slippagePct/100);
  const sl=position.entryPrice*(1-config.stopPct/100)/(1-config.slippagePct/100);
  const bars=minuteCandles.filter(c=>c.time>=position.entryTime&&c.closeTime<=now).sort((a,b)=>a.time-b.time);
  for(const bar of bars){
    // Conservative: if both extremes occurred in one minute, assume STOP first.
    if(bar.low<=sl)return {reason:'stop',market:sl,at:bar.closeTime};
    if(bar.high>=tp)return {reason:'target',market:tp,at:bar.closeTime};
  }
  if(now-position.entryTime>=config.maxHoldHours*3600000&&bars.length){const last=bars[bars.length-1];if(last.closeTime>=position.entryTime+config.maxHoldHours*3600000-60000)return {reason:'time',market:last.close,at:last.closeTime};}
  return null;
}
export function closePaper(state,strategyId,symbol,market,reason,at=Date.now()){
  const p=state.portfolios[strategyId],i=p?.positions.findIndex(x=>x.symbol===symbol)??-1;
  if(i<0||!finite(market)||market<=0||!finite(at))return null;
  const position=p.positions.splice(i,1)[0],sale=sellProceeds(position.quantity,market,state.config);
  p.cash+=sale.net;
  const trade={...position,exitMarket:market,exitPrice:sale.execution,exitFee:sale.fee,exitTime:at,reason,proceeds:sale.net,pnl:sale.net-position.cost,returnPct:100*(sale.net/position.cost-1)};
  p.trades.push(trade);state.updatedAt=at;return trade;
}
export function portfolioStats(portfolio,marks={},config=DEFAULT_CONFIG){
  const completed=portfolio.trades;
  const realised=completed.reduce((a,x)=>a+x.pnl,0);
  const wins=completed.filter(x=>x.pnl>0).length;
  const openValue=portfolio.positions.reduce((a,x)=>a+(finite(marks[x.symbol])?sellProceeds(x.quantity,marks[x.symbol],config).net:x.cost),0);
  const grossProfit=completed.filter(t=>t.pnl>0).reduce((a,t)=>a+t.pnl,0);
  const grossLoss=-completed.filter(t=>t.pnl<0).reduce((a,t)=>a+t.pnl,0);
  return {realised,trades:completed.length,wins,winRate:completed.length?100*wins/completed.length:null,profitFactor:grossLoss?grossProfit/grossLoss:null,estimatedEquity:portfolio.cash+openValue,openCount:portfolio.positions.length};
}