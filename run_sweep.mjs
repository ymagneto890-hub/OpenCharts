import fs from 'node:fs';
import {
  ema,
  normalizeCandles
} from './src/lib/indicators.ts';

const candles = normalizeCandles(JSON.parse(fs.readFileSync('src/services/demo/data/BTCUSD_4h.json', 'utf-8')));
const ema50 = ema(candles, 50);

function testSweeps(lookback = 20, rr = 2.0, riskPct = 0.015, withTrend = false) {
  let balance = 1000, peak = 1000, maxDD = 0;
  const trades = [];

  for (let i = Math.max(50, lookback); i < candles.length - 1; i++) {
    const c = candles[i];
    const e50 = ema50[i]?.value;
    const prevE50 = ema50[i - 1]?.value;
    if (!e50 || !prevE50) continue;

    let highestHigh = -Infinity;
    let lowestLow = Infinity;
    for (let j = i - lookback; j < i; j++) {
      if (candles[j].high > highestHigh) highestHigh = candles[j].high;
      if (candles[j].low < lowestLow) lowestLow = candles[j].low;
    }

    let signal = null;

    // Bullish Sweep: Price swept lowest low of the last N bars, but closed back above it
    if (c.low < lowestLow && c.close > lowestLow && c.close > c.open) {
      if (!withTrend || (c.close > e50 && e50 > prevE50)) {
        const range = c.high - c.low;
        const lowerWick = Math.min(c.open, c.close) - c.low;
        if (range > 0 && lowerWick / range >= 0.30) {
          signal = { side: 'LONG', sl: c.low * 0.996 };
        }
      }
    }
    // Bearish Sweep: Price swept highest high of the last N bars, but closed back below it
    else if (c.high > highestHigh && c.close < highestHigh && c.close < c.open) {
      if (!withTrend || (c.close < e50 && e50 < prevE50)) {
        const range = c.high - c.low;
        const upperWick = c.high - Math.max(c.open, c.close);
        if (range > 0 && upperWick / range >= 0.30) {
          signal = { side: 'SHORT', sl: c.high * 1.004 };
        }
      }
    }

    if (signal) {
      const entryPrice = c.close;
      const riskDistance = Math.abs(entryPrice - signal.sl);
      const riskPctOfPrice = riskDistance / entryPrice;

      if (riskPctOfPrice >= 0.005 && riskPctOfPrice <= 0.04) {
        const riskDollars = balance * riskPct;
        const qty = riskDollars / riskDistance;
        const tp = signal.side === 'LONG'
          ? entryPrice + riskDistance * rr
          : entryPrice - riskDistance * rr;

        let exitPrice = null;
        let exitBar = -1;

        for (let j = i + 1; j < Math.min(candles.length, i + 36); j++) {
          const cur = candles[j];
          if (signal.side === 'LONG') {
            if (cur.low <= signal.sl) { exitPrice = signal.sl; exitBar = j; break; }
            if (cur.high >= tp) { exitPrice = tp; exitBar = j; break; }
          } else {
            if (cur.high >= signal.sl) { exitPrice = signal.sl; exitBar = j; break; }
            if (cur.low <= tp) { exitPrice = tp; exitBar = j; break; }
          }
        }

        if (!exitPrice) {
          exitBar = Math.min(candles.length - 1, i + 36);
          exitPrice = candles[exitBar].close;
        }

        const priceDiff = signal.side === 'LONG' ? (exitPrice - entryPrice) : (entryPrice - exitPrice);
        const net = (priceDiff * qty) - ((entryPrice + exitPrice) * qty * 0.0005);

        balance += net;
        if (balance > peak) peak = balance;
        const dd = ((peak - balance) / peak) * 100;
        if (dd > maxDD) maxDD = dd;

        trades.push({
          date: new Date(c.time * 1000).toISOString().slice(0, 10),
          side: signal.side,
          net
        });

        i = exitBar;
      }
    }
  }

  const wins = trades.filter(t => t.net > 0);
  const winRate = (wins.length / trades.length) * 100;
  const grossWins = wins.reduce((acc, t) => acc + t.net, 0);
  const grossLosses = Math.abs(trades.filter(t => t.net <= 0).reduce((acc, t) => acc + t.net, 0));
  const pf = grossLosses > 0 ? (grossWins / grossLosses) : 999;
  const d1 = new Date(trades[0]?.date);
  const d2 = new Date(trades[trades.length - 1]?.date);
  const days = Math.round((d2 - d1) / (1000 * 60 * 60 * 24));
  const tradesPerMonth = (trades.length / (days / 30.4)).toFixed(1);

  return {
    lookback,
    rr,
    withTrend,
    trades: trades.length,
    days,
    tradesPerMonth,
    winRate: winRate.toFixed(1) + '%',
    pf: pf.toFixed(2),
    balance: '$' + balance.toFixed(2),
    profit: ((balance - 1000) / 10).toFixed(1) + '%',
    maxDD: maxDD.toFixed(1) + '%'
  };
}

console.log('Testing Liquidity Sweep Strategy (Full 9 Years History):');
[20, 30].forEach(lb => {
  [1.5, 2.0].forEach(rr => {
    [false, true].forEach(wt => {
      const r = testSweeps(lb, rr, 0.015, wt);
      console.log('LB ' + lb + ' | RR ' + rr + ' | TrendOnly: ' + wt + ' -> Trades: ' + r.trades + ' (' + r.tradesPerMonth + '/mo) | WR: ' + r.winRate + ' | PF: ' + r.pf + ' | Profit: ' + r.profit + ' | MaxDD: ' + r.maxDD);
    });
  });
});
