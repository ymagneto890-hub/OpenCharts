import fs from 'node:fs';
import {
  ema,
  sma,
  rsi,
  macd,
  normalizeCandles
} from './src/lib/indicators.ts';

const candles = normalizeCandles(JSON.parse(fs.readFileSync('src/services/demo/data/BTCUSD_4h.json', 'utf-8')));

console.log(`Total candles: ${candles.length}`);
console.log(`From ${new Date(candles[0].time * 1000).toISOString().slice(0, 10)} to ${new Date(candles[candles.length - 1].time * 1000).toISOString().slice(0, 10)}`);

// Calculate basic ATR
function calculateATR(candles, period = 14) {
  const tr = [candles[0].high - candles[0].low];
  for (let i = 1; i < candles.length; i++) {
    const h = candles[i].high;
    const l = candles[i].low;
    const pc = candles[i - 1].close;
    tr.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  // RMA smoothing
  const atr = new Array(candles.length).fill(null);
  let sum = 0;
  for (let i = 0; i < period; i++) sum += tr[i];
  atr[period - 1] = sum / period;
  for (let i = period; i < candles.length; i++) {
    atr[i] = (atr[i - 1] * (period - 1) + tr[i]) / period;
  }
  return atr;
}

const ema20 = ema(candles, 20);
const ema50 = ema(candles, 50);
const ema200 = ema(candles, 200);
const rsi14 = rsi(candles, 14);
const macdData = macd(candles, 12, 26, 9);
const atr14 = calculateATR(candles, 14);

// In-Sample: before 2023-01-01 (2018-2022)
// Out-of-Sample: 2023-01-01 to 2026 (completely unseen)
const splitIdx = candles.findIndex(c => new Date(c.time * 1000).toISOString() >= '2023-01-01');

console.log(`In-Sample bars (2017-2022): ${splitIdx}`);
console.log(`Out-of-Sample bars (2023-2026): ${candles.length - splitIdx}`);

// Simulator helper
function simulateStrategy(name, signals, options = {}) {
  const {
    startBar = 200,
    endBar = candles.length - 1,
    riskReward = 2.0,
    riskPct = 0.015,
    initialBalance = 1000,
    atrMultiplierSL = 1.5,
    feeRate = 0.0005,
    slippageRate = 0.0002
  } = options;

  let balance = initialBalance;
  let peak = initialBalance;
  let maxDD = 0;
  const trades = [];

  for (let i = startBar; i < endBar; i++) {
    const sig = signals[i];
    if (!sig) continue;

    const c = candles[i];
    const side = sig.side;
    const entryPrice = c.close * (side === 'LONG' ? (1 + slippageRate) : (1 - slippageRate));
    
    // Stop loss based on ATR or swing
    const stopDistance = sig.customSLDistance || (atr14[i] * atrMultiplierSL);
    let stopLoss = side === 'LONG' ? entryPrice - stopDistance : entryPrice + stopDistance;
    const tp = side === 'LONG' ? entryPrice + stopDistance * riskReward : entryPrice - stopDistance * riskReward;

    const riskDollars = balance * riskPct;
    const qty = riskDollars / stopDistance;

    let exitPrice = null;
    let reason = '';
    let exitBar = -1;

    for (let j = i + 1; j < Math.min(candles.length, i + 50); j++) {
      const cur = candles[j];
      if (side === 'LONG') {
        if (cur.low <= stopLoss) { exitPrice = stopLoss * (1 - slippageRate); reason = 'SL'; exitBar = j; break; }
        if (cur.high >= tp) { exitPrice = tp * (1 - slippageRate); reason = 'TP'; exitBar = j; break; }
      } else {
        if (cur.high >= stopLoss) { exitPrice = stopLoss * (1 + slippageRate); reason = 'SL'; exitBar = j; break; }
        if (cur.low <= tp) { exitPrice = tp * (1 + slippageRate); reason = 'TP'; exitBar = j; break; }
      }
    }

    if (!exitPrice) {
      exitBar = Math.min(candles.length - 1, i + 50);
      exitPrice = candles[exitBar].close;
      reason = 'TIME';
    }

    const priceDiff = side === 'LONG' ? (exitPrice - entryPrice) : (entryPrice - exitPrice);
    const gross = priceDiff * qty;
    const fees = (entryPrice + exitPrice) * qty * feeRate;
    const net = gross - fees;

    balance += net;
    if (balance > peak) peak = balance;
    const dd = ((peak - balance) / peak) * 100;
    if (dd > maxDD) maxDD = dd;

    trades.push({
      date: new Date(c.time * 1000).toISOString().slice(0, 10),
      exitDate: new Date(candles[exitBar].time * 1000).toISOString().slice(0, 10),
      side,
      net,
      reason,
      rMultiple: net / riskDollars
    });

    i = exitBar; // advance past trade exit
  }

  const wins = trades.filter(t => t.net > 0);
  const winRate = trades.length > 0 ? (wins.length / trades.length) * 100 : 0;
  const grossWins = wins.reduce((acc, t) => acc + t.net, 0);
  const grossLosses = Math.abs(trades.filter(t => t.net <= 0).reduce((acc, t) => acc + t.net, 0));
  const pf = grossLosses > 0 ? (grossWins / grossLosses) : 999;
  const d1 = new Date(trades[0]?.date);
  const d2 = new Date(trades[trades.length - 1]?.exitDate);
  const days = Math.round((d2 - d1) / (1000 * 60 * 60 * 24));
  const tradesPerMonth = days > 0 ? (trades.length / (days / 30.4)) : 0;

  return {
    name,
    tradesCount: trades.length,
    days,
    tradesPerMonth: Number(tradesPerMonth.toFixed(1)),
    winRate: Number(winRate.toFixed(1)),
    profitFactor: Number(pf.toFixed(2)),
    balance: Number(balance.toFixed(2)),
    profitPct: Number(((balance - initialBalance) / (initialBalance / 100)).toFixed(1)),
    maxDrawdownPct: Number(maxDD.toFixed(1))
  };
}

// ---------------- STRATEGY 1: RSI MOMENTUM RECLAIM IN TREND ----------------
// If Price > EMA50: Wait for RSI to dip < 45 (pullback) and then cross BACK ABOVE 48 with MACD hist > 0
// If Price < EMA50: Wait for RSI to rise > 55 (pullback) and then cross BACK BELOW 52 with MACD hist < 0
const signalsS1 = new Array(candles.length).fill(null);
for (let i = 2; i < candles.length; i++) {
  const c = candles[i];
  const e50 = ema50[i]?.value;
  const prevE50 = ema50[i - 1]?.value;
  const r = rsi14[i]?.value;
  const prevR = rsi14[i - 1]?.value;
  const prevR2 = rsi14[i - 2]?.value;
  const hist = macdData.histogram[i]?.value;

  if (!e50 || !r || !hist) continue;

  // Bull: Trend is UP, RSI dipped below 44 recently and crossed back above 48
  if (c.close > e50 && e50 > prevE50) {
    if (prevR < 46 && r >= 48 && c.close > c.open && hist > macdData.histogram[i - 1]?.value) {
      signalsS1[i] = { side: 'LONG' };
    }
  }
  // Bear: Trend is DOWN, RSI rallied above 54 recently and crossed back below 52
  else if (c.close < e50 && e50 < prevE50) {
    if (prevR > 54 && r <= 52 && c.close < c.open && hist < macdData.histogram[i - 1]?.value) {
      signalsS1[i] = { side: 'SHORT' };
    }
  }
}

// ---------------- STRATEGY 2: DONCHIAN VOLATILITY BREAKOUT (20-bar) with EMA200 ----------------
// Buy when price breaks 20-bar High and price > EMA200
// Short when price breaks 20-bar Low and price < EMA200
const signalsS2 = new Array(candles.length).fill(null);
for (let i = 20; i < candles.length; i++) {
  const c = candles[i];
  const e200 = ema200[i]?.value;
  if (!e200) continue;

  let max20 = -Infinity;
  let min20 = Infinity;
  for (let j = i - 20; j < i; j++) {
    if (candles[j].high > max20) max20 = candles[j].high;
    if (candles[j].low < min20) min20 = candles[j].low;
  }

  if (c.close > max20 && c.close > e200) {
    signalsS2[i] = { side: 'LONG' };
  } else if (c.close < min20 && c.close < e200) {
    signalsS2[i] = { side: 'SHORT' };
  }
}

// ---------------- STRATEGY 3: EMA 20/50 GOLDEN CROSS PULLBACK + ATR ----------------
// When EMA20 > EMA50, enter LONG on bullish candle after touch of EMA20
// When EMA20 < EMA50, enter SHORT on bearish candle after touch of EMA20
const signalsS3 = new Array(candles.length).fill(null);
for (let i = 2; i < candles.length; i++) {
  const c = candles[i];
  const prev = candles[i - 1];
  const e20 = ema20[i]?.value;
  const e50 = ema50[i]?.value;
  const r = rsi14[i]?.value;
  if (!e20 || !e50 || !r) continue;

  if (e20 > e50 && prev.low <= e20 && c.close > e20 && c.close > c.open && r > 50 && r < 68) {
    signalsS3[i] = { side: 'LONG' };
  } else if (e20 < e50 && prev.high >= e20 && c.close < e20 && c.close < c.open && r < 50 && r > 32) {
    signalsS3[i] = { side: 'SHORT' };
  }
}

console.log('\n=== IN-SAMPLE (2018 - 2022) ===');
console.log('S1 (RSI Momentum Reclaim in Trend):', simulateStrategy('S1', signalsS1, { startBar: 200, endBar: splitIdx, riskReward: 1.8, atrMultiplierSL: 1.8 }));
console.log('S2 (Donchian 20 Breakout + EMA200):', simulateStrategy('S2', signalsS2, { startBar: 200, endBar: splitIdx, riskReward: 2.0, atrMultiplierSL: 1.5 }));
console.log('S3 (EMA 20/50 Pullback + ATR):', simulateStrategy('S3', signalsS3, { startBar: 200, endBar: splitIdx, riskReward: 1.8, atrMultiplierSL: 1.8 }));

console.log('\n=== OUT-OF-SAMPLE VALIDATION (2023 - 2026 UNSEEN DATA) ===');
console.log('S1 (RSI Momentum Reclaim in Trend):', simulateStrategy('S1', signalsS1, { startBar: splitIdx, endBar: candles.length - 1, riskReward: 1.8, atrMultiplierSL: 1.8 }));
console.log('S2 (Donchian 20 Breakout + EMA200):', simulateStrategy('S2', signalsS2, { startBar: splitIdx, endBar: candles.length - 1, riskReward: 2.0, atrMultiplierSL: 1.5 }));
console.log('S3 (EMA 20/50 Pullback + ATR):', simulateStrategy('S3', signalsS3, { startBar: splitIdx, endBar: candles.length - 1, riskReward: 1.8, atrMultiplierSL: 1.8 }));
