import fs from 'node:fs';
import {
  ema,
  sma,
  rsi,
  macd,
  normalizeCandles
} from './src/lib/indicators.ts';

const candles = normalizeCandles(JSON.parse(fs.readFileSync('src/services/demo/data/BTCUSD_4h.json', 'utf-8')));
const ema50 = ema(candles, 50);
const ema200 = ema(candles, 200);
const rsi14 = rsi(candles, 14);
const macdData = macd(candles, 12, 26, 9);
const volSma = sma(candles.map(c => ({ time: c.time, close: c.volume || 0, open: 0, high: 0, low: 0 })), 20);

function backtestConfluence(startYear = 2020, targetTrades = 100, rr = 1.8) {
  let balance = 1000, peak = 1000, maxDD = 0;
  const trades = [];

  const startIdx = candles.findIndex(c => new Date(c.time * 1000).getFullYear() >= startYear);

  for (let i = Math.max(200, startIdx); i < candles.length - 1; i++) {
    if (trades.length >= targetTrades) break;

    const c = candles[i];
    const prev = candles[i - 1];
    const prev2 = candles[i - 2];
    const e50 = ema50[i]?.value;
    const prevE50 = ema50[i - 1]?.value;
    const e200 = ema200[i]?.value;
    const r = rsi14[i]?.value;
    const prevR = rsi14[i - 1]?.value;
    const hist = macdData.histogram[i]?.value;
    const prevHist = macdData.histogram[i - 1]?.value;

    if (!e50 || !e200 || !r || !hist) continue;

    let signal = null;

    // LONG Setup (Trend-following Pullback + Rejection):
    // EMA 50 > EMA 200 and EMA 50 sloping up
    // Price dips into EMA 50 and prints a strong bullish rejection candle
    const isBullTrend = e50 > e200 && e50 > prevE50;
    if (isBullTrend && prev.low <= e50 * 1.008 && c.close > e50 && c.close > c.open) {
      const body = c.close - c.open;
      const range = c.high - c.low;
      if (range > 0 && body / range >= 0.45 && r >= 42 && r <= 62 && r > prevR && hist > prevHist) {
        signal = { side: 'LONG', sl: Math.min(c.low, prev.low, prev2.low) * 0.998 };
      }
    }

    // SHORT Setup (Trend-following Pullback + Rejection):
    // EMA 50 < EMA 200 and EMA 50 sloping down
    // Price bounces into EMA 50 and prints a strong bearish rejection candle
    const isBearTrend = e50 < e200 && e50 < prevE50;
    if (isBearTrend && prev.high >= e50 * 0.992 && c.close < e50 && c.close < c.open) {
      const body = c.open - c.close;
      const range = c.high - c.low;
      if (range > 0 && body / range >= 0.45 && r <= 58 && r >= 38 && r < prevR && hist < prevHist) {
        signal = { side: 'SHORT', sl: Math.max(c.high, prev.high, prev2.high) * 1.002 };
      }
    }

    if (signal) {
      const entryPrice = c.close;
      const riskDistance = Math.abs(entryPrice - signal.sl);
      const riskPct = riskDistance / entryPrice;

      if (riskPct >= 0.006 && riskPct <= 0.035) {
        const riskDollars = balance * 0.015; // 1.5% risk
        const qty = riskDollars / riskDistance;
        const tp = signal.side === 'LONG' ? entryPrice + riskDistance * rr : entryPrice - riskDistance * rr;

        let exitPrice = null;
        let reason = '';
        let exitBar = -1;

        for (let j = i + 1; j < Math.min(candles.length, i + 36); j++) {
          const cur = candles[j];
          if (signal.side === 'LONG') {
            if (cur.low <= signal.sl) { exitPrice = signal.sl; reason = 'SL'; exitBar = j; break; }
            if (cur.high >= tp) { exitPrice = tp; reason = 'TP'; exitBar = j; break; }
          } else {
            if (cur.high >= signal.sl) { exitPrice = signal.sl; reason = 'SL'; exitBar = j; break; }
            if (cur.low <= tp) { exitPrice = tp; reason = 'TP'; exitBar = j; break; }
          }
        }

        if (!exitPrice) {
          exitBar = Math.min(candles.length - 1, i + 36);
          exitPrice = candles[exitBar].close;
          reason = 'TIME';
        }

        const priceDiff = signal.side === 'LONG' ? (exitPrice - entryPrice) : (entryPrice - exitPrice);
        const gross = priceDiff * qty;
        const fees = (entryPrice + exitPrice) * qty * 0.0005;
        const net = gross - fees;

        balance += net;
        if (balance > peak) peak = balance;
        const dd = ((peak - balance) / peak) * 100;
        if (dd > maxDD) maxDD = dd;

        trades.push({
          num: trades.length + 1,
          date: new Date(c.time * 1000).toISOString().slice(0, 10),
          side: signal.side,
          entryPrice: Math.round(entryPrice * 100) / 100,
          exitPrice: Math.round(exitPrice * 100) / 100,
          stopLoss: Math.round(signal.sl * 100) / 100,
          takeProfit: Math.round(tp * 100) / 100,
          netPnl: Math.round(net * 100) / 100,
          rMultiple: Math.round((net / riskDollars) * 100) / 100,
          balance: Math.round(balance * 100) / 100,
          reason
        });

        i = exitBar; // advance past trade exit
      }
    }
  }

  const wins = trades.filter(t => t.netPnl > 0);
  const losses = trades.filter(t => t.netPnl <= 0);
  const winRate = (wins.length / trades.length) * 100;
  const grossWins = wins.reduce((acc, t) => acc + t.netPnl, 0);
  const grossLosses = Math.abs(losses.reduce((acc, t) => acc + t.netPnl, 0));
  const pf = grossLosses > 0 ? (grossWins / grossLosses) : 999;
  const avgR = trades.reduce((acc, t) => acc + t.rMultiple, 0) / trades.length;

  return {
    tradesCount: trades.length,
    startDate: trades[0]?.date,
    endDate: trades[trades.length - 1]?.date,
    wins: wins.length,
    losses: losses.length,
    winRate: Number(winRate.toFixed(2)),
    initialBalance: 1000,
    finalBalance: Number(balance.toFixed(2)),
    profitDollars: Number((balance - 1000).toFixed(2)),
    profitPct: Number(((balance - 1000) / 10).toFixed(2)),
    profitFactor: Number(pf.toFixed(2)),
    avgR: Number(avgR.toFixed(2)),
    maxDrawdownPct: Number(maxDD.toFixed(2)),
    longs: trades.filter(t => t.side === 'LONG').length,
    longWins: trades.filter(t => t.side === 'LONG' && t.netPnl > 0).length,
    shorts: trades.filter(t => t.side === 'SHORT').length,
    shortWins: trades.filter(t => t.side === 'SHORT' && t.netPnl > 0).length,
    trades
  };
}

const res = backtestConfluence(2020, 100, 1.8);
console.log('=== CONFLUENCE STRATEGY (100 TRADES) ===');
console.log('Period: ' + res.startDate + ' to ' + res.endDate);
console.log('Total Trades: ' + res.tradesCount + ' (Longs: ' + res.longs + ' [' + res.longWins + 'W], Shorts: ' + res.shorts + ' [' + res.shortWins + 'W])');
console.log('Win Rate: ' + res.winRate + '% (Wins: ' + res.wins + ', Losses: ' + res.losses + ')');
console.log('Profit Factor: ' + res.profitFactor);
console.log('Expectancy: +' + res.avgR + 'R per trade');
console.log('Starting Balance: $' + res.initialBalance + ' -> Final Balance: $' + res.finalBalance);
console.log('Net Profit: +$' + res.profitDollars + ' (+' + res.profitPct + '%)');
console.log('Max Drawdown: ' + res.maxDrawdownPct + '%');

fs.writeFileSync('c:/Users/useru/.gemini/antigravity/brain/2bfd0a7f-bdae-4fb3-ad83-c9a65780fd06/scratch/confluence_100_trades.json', JSON.stringify(res, null, 2));
