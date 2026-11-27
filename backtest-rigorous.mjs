import fs from 'node:fs';
import {
  detectDivergences,
  rsi,
  macd,
  balancedDivergenceOptions,
  normalizeCandles
} from './src/lib/indicators.ts';

const candles = normalizeCandles(JSON.parse(fs.readFileSync('src/services/demo/data/BTCUSD_4h.json', 'utf-8')));

const rsiPoints = rsi(candles, 14);
const macdRes = macd(candles, 12, 26, 9);

const optsRsi = balancedDivergenceOptions('4h', 'rsi', 'rsi');
const optsMacd = balancedDivergenceOptions('4h', 'macd', 'histogram');

const rsiDivs = detectDivergences(candles, rsiPoints, optsRsi);
const macdDivs = detectDivergences(candles, macdRes.histogram, optsMacd);

// Merge all signals sorted by confirmedTime
const allSignals = [...rsiDivs, ...macdDivs].sort((a, b) => a.confirmedTime - b.confirmedTime);

// Map candle by timestamp for instant lookup
const candleIndexMap = new Map();
for (let i = 0; i < candles.length; i++) {
  candleIndexMap.set(candles[i].time, i);
}

function simulateStrategy(config) {
  const {
    targetTrades = 100,
    riskReward = 2.0,
    riskPct = 0.015, // 1.5%
    initialBalance = 1000,
    feeRate = 0.0005,
    slippageRate = 0.0002,
    partialTakeProfit = false, // if true, take 50% at 1R and move SL to BE
    requireTrendAlignment = true,
    volumeFilter = 0.7,
    startIndex = 0
  } = config;

  let balance = initialBalance;
  let peakBalance = initialBalance;
  let maxDrawdown = 0;
  let maxDrawdownPct = 0;

  const trades = [];
  let inPosition = false;
  let activeTrade = null;

  for (let sIdx = startIndex; sIdx < allSignals.length; sIdx++) {
    const sig = allSignals[sIdx];
    const confIdx = candleIndexMap.get(sig.confirmedTime);
    if (confIdx === undefined || confIdx >= candles.length - 1) continue;

    const confCandle = candles[confIdx];

    // Filter rules based on user table & paper
    const isBull = sig.kind === 'bull' || sig.kind === 'hidden-bull';
    const isHidden = sig.kind.startsWith('hidden');

    // Rule 1: Trend Alignment
    if (requireTrendAlignment) {
      if (isHidden) {
        // Hidden divergences must be aligned with EMA50 trend
        if (!sig.context?.ema50TrendAligned) continue;
      } else {
        // Regular divergences: must have true exhaustion
        if (sig.kind === 'bull' && sig.startOsc > 40) continue;
        if (sig.kind === 'bear' && sig.startOsc < 60) continue;
      }
    }

    // Rule 2: Volume check (confirmation candle volume ratio)
    if (volumeFilter > 0 && sig.context?.confirmationVolumeSma20Ratio !== null) {
      if (sig.context.confirmationVolumeSma20Ratio < volumeFilter) continue;
    }

    // Determine entry, stop loss, take profit
    const side = isBull ? 'LONG' : 'SHORT';
    const entryPrice = confCandle.close * (side === 'LONG' ? (1 + slippageRate) : (1 - slippageRate));
    
    // Stop Loss at pivot extreme + buffer
    let stopLoss = 0;
    if (side === 'LONG') {
      stopLoss = sig.endPrice * 0.997; // 0.3% below pivot low
    } else {
      stopLoss = sig.endPrice * 1.003; // 0.3% above pivot high
    }

    const riskDistance = Math.abs(entryPrice - stopLoss);
    const riskPctOfPrice = riskDistance / entryPrice;

    // Reject unreasonable stop loss distances (< 0.4% or > 4.5%)
    if (riskPctOfPrice < 0.004 || riskPctOfPrice > 0.045) continue;

    // Check if we are currently holding a position that needs resolving before this signal
    // In our sequential backtest, let's step through candles from entry forward
    const riskDollars = balance * riskPct;
    const quantity = riskDollars / riskDistance;
    const tpPrice = side === 'LONG'
      ? entryPrice + riskDistance * riskReward
      : entryPrice - riskDistance * riskReward;

    // Simulate forward until exit
    let exitBar = -1;
    let exitPrice = 0;
    let exitReason = '';
    let reached1R = false;
    let effectiveSL = stopLoss;

    for (let c = confIdx + 1; c < Math.min(candles.length, confIdx + 50); c++) {
      const cur = candles[c];

      if (side === 'LONG') {
        // Check partial TP at 1R
        if (partialTakeProfit && !reached1R && cur.high >= entryPrice + riskDistance) {
          reached1R = true;
          effectiveSL = entryPrice; // Break-even
        }

        if (cur.low <= effectiveSL) {
          exitBar = c;
          exitPrice = effectiveSL * (1 - slippageRate);
          exitReason = reached1R ? 'break-even' : 'stop-loss';
          break;
        }
        if (cur.high >= tpPrice) {
          exitBar = c;
          exitPrice = tpPrice * (1 - slippageRate);
          exitReason = 'take-profit';
          break;
        }
      } else {
        // SHORT
        if (partialTakeProfit && !reached1R && cur.low <= entryPrice - riskDistance) {
          reached1R = true;
          effectiveSL = entryPrice; // Break-even
        }

        if (cur.high >= effectiveSL) {
          exitBar = c;
          exitPrice = effectiveSL * (1 + slippageRate);
          exitReason = reached1R ? 'break-even' : 'stop-loss';
          break;
        }
        if (cur.low <= tpPrice) {
          exitBar = c;
          exitPrice = tpPrice * (1 + slippageRate);
          exitReason = 'take-profit';
          break;
        }
      }
    }

    // Time-stop if 50 candles elapsed without hitting TP or SL
    if (exitBar === -1) {
      exitBar = Math.min(candles.length - 1, confIdx + 50);
      exitPrice = candles[exitBar].close;
      exitReason = 'time-stop';
    }

    // Calculate PnL
    let netPnl = 0;
    if (partialTakeProfit && reached1R) {
      if (exitReason === 'take-profit') {
        const p1 = (riskDistance) * (quantity * 0.5);
        const p2 = (riskDistance * riskReward) * (quantity * 0.5);
        const fees = (entryPrice + exitPrice) * quantity * feeRate;
        netPnl = (p1 + p2) - fees;
      } else {
        // Exited at BE for second half
        const p1 = (riskDistance) * (quantity * 0.5);
        const fees = (entryPrice + exitPrice) * quantity * feeRate;
        netPnl = p1 - fees;
      }
    } else {
      const priceDiff = side === 'LONG' ? (exitPrice - entryPrice) : (entryPrice - exitPrice);
      const gross = priceDiff * quantity;
      const fees = (entryPrice + exitPrice) * quantity * feeRate;
      netPnl = gross - fees;
    }

    balance += netPnl;
    if (balance > peakBalance) peakBalance = balance;
    const dd = peakBalance - balance;
    const ddPct = (dd / peakBalance) * 100;
    if (dd > maxDrawdown) maxDrawdown = dd;
    if (ddPct > maxDrawdownPct) maxDrawdownPct = ddPct;

    const rMultiple = netPnl / riskDollars;

    trades.push({
      num: trades.length + 1,
      date: new Date(confCandle.time * 1000).toISOString().slice(0, 10),
      side,
      kind: sig.kind,
      source: sig.oscillatorSource || 'rsi',
      entryPrice: Math.round(entryPrice * 100) / 100,
      exitPrice: Math.round(exitPrice * 100) / 100,
      stopLoss: Math.round(stopLoss * 100) / 100,
      takeProfit: Math.round(tpPrice * 100) / 100,
      netPnl: Math.round(netPnl * 100) / 100,
      rMultiple: Math.round(rMultiple * 100) / 100,
      balance: Math.round(balance * 100) / 100,
      exitReason,
      barsHeld: exitBar - confIdx
    });

    if (trades.length >= targetTrades) break;
  }

  const wins = trades.filter(t => t.netPnl > 0);
  const losses = trades.filter(t => t.netPnl <= 0);
  const winRate = (wins.length / trades.length) * 100;
  const grossProfit = wins.reduce((acc, t) => acc + t.netPnl, 0);
  const grossLoss = Math.abs(losses.reduce((acc, t) => acc + t.netPnl, 0));
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : 999;
  const netProfit = balance - initialBalance;
  const netProfitPct = (netProfit / initialBalance) * 100;
  const avgR = trades.reduce((acc, t) => acc + t.rMultiple, 0) / trades.length;

  let maxConsecLosses = 0;
  let curL = 0;
  for (const t of trades) {
    if (t.netPnl <= 0) {
      curL++;
      if (curL > maxConsecLosses) maxConsecLosses = curL;
    } else curL = 0;
  }

  return {
    tradesCount: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: Number(winRate.toFixed(2)),
    initialBalance,
    finalBalance: Number(balance.toFixed(2)),
    netProfit: Number(netProfit.toFixed(2)),
    netProfitPct: Number(netProfitPct.toFixed(2)),
    profitFactor: Number(profitFactor.toFixed(2)),
    avgR: Number(avgR.toFixed(2)),
    maxDrawdownDollars: Number(maxDrawdown.toFixed(2)),
    maxDrawdownPct: Number(maxDrawdownPct.toFixed(2)),
    maxConsecLosses,
    longs: trades.filter(t => t.side === 'LONG').length,
    longWins: trades.filter(t => t.side === 'LONG' && t.netPnl > 0).length,
    shorts: trades.filter(t => t.side === 'SHORT').length,
    shortWins: trades.filter(t => t.side === 'SHORT' && t.netPnl > 0).length,
    sampleTrades: trades.slice(0, 15),
    allTrades: trades
  };
}

// Test Configuration 1: Fixed 2.0R Target (Classic Trend + Divergence)
const res2R = simulateStrategy({
  targetTrades: 100,
  riskReward: 2.0,
  riskPct: 0.015,
  partialTakeProfit: false,
  requireTrendAlignment: true,
  volumeFilter: 0.7
});

// Test Configuration 2: Dynamic 1R Partial (50% at 1R, BE stop, 50% at 2R)
const resPartial = simulateStrategy({
  targetTrades: 100,
  riskReward: 2.0,
  riskPct: 0.015,
  partialTakeProfit: true,
  requireTrendAlignment: true,
  volumeFilter: 0.7
});

// Test Configuration 3: 1.5R Target (High Winrate conservative)
const res1_5R = simulateStrategy({
  targetTrades: 100,
  riskReward: 1.5,
  riskPct: 0.015,
  partialTakeProfit: false,
  requireTrendAlignment: true,
  volumeFilter: 0.7
});

console.log('=== RESULTS SUMMARY ===');
console.log('1. Fixed 2.0R Target:');
console.log(`   Trades: ${res2R.tradesCount} | WinRate: ${res2R.winRate}% | ProfitFactor: ${res2R.profitFactor}`);
console.log(`   Net Profit: $${res2R.netProfit} (+${res2R.netProfitPct}%) | Max DD: ${res2R.maxDrawdownPct}% | Avg R: +${res2R.avgR}R`);

console.log('2. Partial TP (50% at 1R + BE, 50% at 2R):');
console.log(`   Trades: ${resPartial.tradesCount} | WinRate: ${resPartial.winRate}% | ProfitFactor: ${resPartial.profitFactor}`);
console.log(`   Net Profit: $${resPartial.netProfit} (+${resPartial.netProfitPct}%) | Max DD: ${resPartial.maxDrawdownPct}% | Avg R: +${resPartial.avgR}R`);

console.log('3. Fixed 1.5R Target:');
console.log(`   Trades: ${res1_5R.tradesCount} | WinRate: ${res1_5R.winRate}% | ProfitFactor: ${res1_5R.profitFactor}`);
console.log(`   Net Profit: $${res1_5R.netProfit} (+${res1_5R.netProfitPct}%) | Max DD: ${res1_5R.maxDrawdownPct}% | Avg R: +${res1_5R.avgR}R`);

fs.writeFileSync('c:/Users/useru/.gemini/antigravity/brain/2bfd0a7f-bdae-4fb3-ad83-c9a65780fd06/scratch/sim_results.json', JSON.stringify({ res2R, resPartial, res1_5R }, null, 2));
