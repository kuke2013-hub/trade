/* Read-only paper-trade chart helpers. No fabricated trades or market prices. */
const minute = 60000;
const isNumber = n => Number.isFinite(n);

export function tradeKey(t) {
  return `${String(t.strategyId)}|${String(t.symbol)}|${Number(t.entryTime)}`;
}

export function recordedTrades(state, symbol) {
  if (!state?.portfolios || !symbol) return [];
  const found=[];
  for (const [strategyId, portfolio] of Object.entries(state.portfolios)) {
    for (const trade of [...(portfolio.positions ?? []), ...(portfolio.trades ?? [])]) {
      if (trade?.symbol!==symbol || !isNumber(trade.entryTime) || !isNumber(trade.entryPrice) || trade.entryPrice<=0) continue;
      found.push({...trade, strategyId});
    }
  }
  return found.sort((a,b)=>b.entryTime-a.entryTime || a.strategyId.localeCompare(b.strategyId));
}

// Trigger quotes are the prices compared against minute-candle highs/lows by evaluateExit().
// Execution/fill prices already incorporate the simulator's configured slippage.
export function tradeLevels(trade, config) {
  if (!trade || !isNumber(trade.entryPrice) || trade.entryPrice<=0 || !config) return null;
  const slippage = Number(config.slippagePct)/100;
  if (!isNumber(slippage) || slippage>=1 || slippage<0) return null;
  const stop = Number(config.stopPct)/100, target = Number(config.targetPct)/100;
  if (!isNumber(stop) || !isNumber(target) || stop<0 || stop>=1 || target<0) return null;
  return {
    entry:trade.entryPrice,
    stopTrigger:trade.entryPrice*(1-stop)/(1-slippage),
    targetTrigger:trade.entryPrice*(1+target)/(1-slippage),
    exit:isNumber(trade.exitPrice)&&trade.exitPrice>0?trade.exitPrice:null,
    entryTime:trade.entryTime,
    exitTime:isNumber(trade.exitTime)?trade.exitTime:null,
  };
}

export function tradeMinuteWindow(trade, mode='entry', now=Date.now()) {
  if (!isNumber(trade?.entryTime)) throw new Error('No recorded trade entry timestamp');
  if (mode==='exit' && !isNumber(trade.exitTime)) throw new Error('Trade has not exited');
  if (!['entry','exit'].includes(mode)) throw new Error('Unknown trade chart window');
  // 30 minutes before entry / 150 after; 120 before exit / 60 after.
  const anchor=mode==='exit'?trade.exitTime:trade.entryTime;
  const startTime=Math.max(0,anchor-(mode==='exit'?120:30)*minute);
  const endTime=Math.max(startTime+minute,Math.min(now,anchor+(mode==='exit'?60:150)*minute));
  return {startTime,endTime,anchor};
}

export function minuteMarkerPosition(candles, timestamp, left=10, right=1090) {
  if (!isNumber(timestamp) || !candles?.length) return null;
  const index=candles.findIndex(c=>isNumber(c.time)&&isNumber(c.closeTime)&&timestamp>=c.time&&timestamp<=c.closeTime+1);
  if (index<0) return null;
  const candle=candles[index];
  const fraction=Math.max(0,Math.min(1,(timestamp-candle.time)/(candle.closeTime+1-candle.time)));
  return left+(index+fraction)*(right-left)/candles.length;
}