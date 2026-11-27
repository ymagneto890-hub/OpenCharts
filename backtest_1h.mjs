import fs from 'node:fs';
import {
  detectDivergences,
  rsi,
  macd,
  balancedDivergenceOptions,
  normalizeCandles
} from './src/lib/indicators.ts';

const candles = normalizeCandles(JSON.parse(fs.readFileSync('c:/Users/useru/.gemini/antigravity/brain/2bfd0a7f-bdae-4fb3-ad83-c9a65780fd06/scratch/BTCUSD_1h_extended.json', 'utf-8')));
const candleIndexMap = new Map(candles.map((c, i) => [c.time, i]));

console.log(`Loaded ${candles.length} 1H candles.`);
console.log(`From ${new Date(candles[0].time * 1000).toISOString()} to ${new Date(candles[candles.length - 1].time * 1000).toISOString()}`);

const rsiPoints = rsi(candles, 14);
const macdRes = macd(candles, 12, 26, 9);

// 1H Options: lbL = 5, lbR = 2 or 3
const optsRsi = balancedDivergenceOptions('1h', 'rsi', 'rsi');
optsRsi.oscLeftBars = 5;
optsRsi.oscRightBars = 3;
optsRsi.minRsiDelta = 2.5;

const optsMacd = balancedDivergenceOptions('1h', 'macd', 'histogram');
optsMacd.oscLeftBars = 5;
optsMacd.oscRightBars = 2;
optsMacd.requireMacdZeroCrossForRegular = true;

const rsiDivs = detectDivergences(candles, rsiPoints, optsRsi);
const macdDivs = detectDivergences(candles, macdRes.histogram, optsMacd);

// Filter: Hidden Divergences aligned with EMA 50 (Trend following)
const signals = [...rsiDivs, ...macdDivs]
  .filter(s => s.kind.startsWith('hidden') && s.context?.ema50TrendAligned === true)
  .sort((a, b) => a.confirmedTime - b.confirmedTime);

console.log(`Total 1H trend-following signals: ${signals.length}`);

function runBacktest1H(rr = 2.0, buffer = 0.0035, riskPct = 0.015, maxHoldBars = 36) {
  let balance = 1000, peak = 1000, maxDD = 0;
  const trades = [];

  for (const sig of signals) {
    if (trades.length >= 100) break;

    const cIdx = candleIndexMap.get(sig.confirmedTime);
    if (!cIdx || cIdx >= candles.length - 1) continue;

    const confCandle = candles[cIdx];
    const side = sig.kind === 'hidden-bull' ? 'LONG' : 'SHORT';
    const entryPrice = confCandle.close;

    // Buffer 0.35% for 1H noise
    let stopLoss = side === 'LONG'
      ? sig.endPrice * (1 - buffer)
      : sig.endPrice * (1 + buffer);

    const riskDistance = Math.abs(entryPrice - stopLoss);
    const riskPctOfPrice = riskDistance / entryPrice;

    // Reject unreasonable stop loss distances (< 0.3% or > 3.0% in 1H)
    if (riskPctOfPrice < 0.003 || riskPctOfPrice > 0.03) continue;

    const riskDollars = balance * riskPct;
    const qty = riskDollars / riskDistance;
    const tp = side === 'LONG'
      ? entryPrice + riskDistance * rr
      : entryPrice - riskDistance * rr;

    let exitPrice = null;
    let reason = '';
    let exitIdx = -1;

    for (let c = cIdx + 1; c < Math.min(candles.length, cIdx + maxHoldBars); c++) {
      const cur = candles[c];
      if (side === 'LONG') {
        if (cur.low <= stopLoss) { exitPrice = stopLoss; reason = 'SL'; exitIdx = c; break; }
        if (cur.high >= tp) { exitPrice = tp; reason = 'TP'; exitIdx = c; break; }
      } else {
        if (cur.high >= stopLoss) { exitPrice = stopLoss; reason = 'SL'; exitIdx = c; break; }
        if (cur.low <= tp) { exitPrice = tp; reason = 'TP'; exitIdx = c; break; }
      }
    }

    if (!exitPrice) {
      exitIdx = Math.min(candles.length - 1, cIdx + maxHoldBars);
      exitPrice = candles[exitIdx].close;
      reason = 'TIME';
    }

    const priceDiff = side === 'LONG' ? (exitPrice - entryPrice) : (entryPrice - exitPrice);
    const gross = priceDiff * qty;
    const fees = (entryPrice + exitPrice) * qty * 0.0005; // 0.05% fee
    const net = gross - fees;

    balance += net;
    if (balance > peak) peak = balance;
    const dd = ((peak - balance) / peak) * 100;
    if (dd > maxDD) maxDD = dd;

    trades.push({
      num: trades.length + 1,
      entryDate: new Date(confCandle.time * 1000).toISOString(),
      exitDate: new Date(candles[exitIdx].time * 1000).toISOString(),
      side,
      kind: sig.kind,
      source: sig.oscillatorSource || 'rsi',
      entryPrice: Math.round(entryPrice * 100) / 100,
      exitPrice: Math.round(exitPrice * 100) / 100,
      stopLoss: Math.round(stopLoss * 100) / 100,
      takeProfit: Math.round(tp * 100) / 100,
      netPnl: Math.round(net * 100) / 100,
      rMultiple: Math.round((net / riskDollars) * 100) / 100,
      balance: Math.round(balance * 100) / 100,
      barsHeld: exitIdx - cIdx,
      reason
    });
  }

  const wins = trades.filter(t => t.netPnl > 0);
  const losses = trades.filter(t => t.netPnl <= 0);
  const winRate = (wins.length / trades.length) * 100;
  const grossWins = wins.reduce((acc, t) => acc + t.netPnl, 0);
  const grossLosses = Math.abs(losses.reduce((acc, t) => acc + t.netPnl, 0));
  const pf = grossLosses > 0 ? (grossWins / grossLosses) : 999;
  const avgR = trades.reduce((acc, t) => acc + t.rMultiple, 0) / trades.length;

  const d1 = new Date(trades[0]?.entryDate);
  const d2 = new Date(trades[trades.length - 1]?.exitDate);
  const daysTotal = Math.round((d2 - d1) / (1000 * 60 * 60 * 24));
  const avgHours = trades.reduce((a, b) => a + b.barsHeld, 0) / trades.length;

  return {
    rr,
    tradesCount: trades.length,
    startDate: trades[0]?.entryDate.slice(0, 10),
    endDate: trades[trades.length - 1]?.exitDate.slice(0, 10),
    daysTotal,
    avgHoursHeld: Math.round(avgHours),
    tradesPerMonth: Number((trades.length / (daysTotal / 30.4)).toFixed(1)),
    wins: wins.length,
    losses: losses.length,
    winRate: Number(winRate.toFixed(2)),
    initialBalance: 1000,
    finalBalance: Number(balance.toFixed(2)),
    netProfit: Number((balance - 1000).toFixed(2)),
    netProfitPct: Number(((balance - 1000) / 10).toFixed(2)),
    profitFactor: Number(pf.toFixed(2)),
    avgRMultiple: Number(avgR.toFixed(2)),
    maxDrawdownPct: Number(maxDD.toFixed(2)),
    longs: trades.filter(t => t.side === 'LONG').length,
    longWins: trades.filter(t => t.side === 'LONG' && t.netPnl > 0).length,
    shorts: trades.filter(t => t.side === 'SHORT').length,
    shortWins: trades.filter(t => t.side === 'SHORT' && t.netPnl > 0).length,
    trades
  };
}

// Sweep R:R on 1H
[1.5, 1.8, 2.0, 2.2].forEach(rr => {
  const res = runBacktest1H(rr, 0.0035, 0.015, 36);
  console.log(`\n=== 1H BACKTEST (R:R 1:${rr}) ===`);
  console.log(`Trades: ${res.tradesCount} in ${res.daysTotal} DAYS (~${(res.daysTotal/30.4).toFixed(1)} months!)`);
  console.log(`Frequency: ~${res.tradesPerMonth} trades/month | Avg Trade Duration: ${res.avgHoursHeld} hours`);
  console.log(`Win Rate: ${res.winRate}% (Wins: ${res.wins}, Losses: ${res.losses})`);
  console.log(`Profit Factor: ${res.profitFactor}`);
  console.log(`Starting Balance: $${res.initialBalance} -> Final Balance: $${res.finalBalance}`);
  console.log(`Net Profit: +$${res.netProfit} (+${res.netProfitPct}%)`);
  console.log(`Max Drawdown: ${res.maxDrawdownPct}% | Expectancy: +${res.avgRMultiple}R`);
});

const best1H = runBacktest1H(2.0, 0.0035, 0.015, 36);
fs.writeFileSync('c:/Users/useru/.gemini/antigravity/brain/2bfd0a7f-bdae-4fb3-ad83-c9a65780fd06/scratch/backtest_1h_results.json', JSON.stringify(best1H, null, 2));
