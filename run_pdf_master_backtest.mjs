import fs from 'node:fs';
import {
  detectDivergences,
  rsi,
  macd,
  balancedDivergenceOptions,
  normalizeCandles
} from './src/lib/indicators.ts';

const candles = normalizeCandles(JSON.parse(fs.readFileSync('src/services/demo/data/BTCUSD_4h.json', 'utf-8')));
const candleIndexMap = new Map(candles.map((c, i) => [c.time, i]));

const rsiPoints = rsi(candles, 14);
const macdRes = macd(candles, 12, 26, 9);

// Configuration from Master Table (Page 22-23)
const optsRsi = balancedDivergenceOptions('4h', 'rsi', 'rsi');
optsRsi.oscLeftBars = 5;
optsRsi.oscRightBars = 3;
optsRsi.minRsiDelta = 3.0;
optsRsi.rsiBullMaxZone = 35;
optsRsi.rsiBearMinZone = 65;

const optsMacd = balancedDivergenceOptions('4h', 'macd', 'histogram');
optsMacd.oscLeftBars = 5;
optsMacd.oscRightBars = 2;
optsMacd.requireMacdZeroCrossForRegular = true;
optsMacd.macdMinContractionPct = 0.15;

const rsiDivs = detectDivergences(candles, rsiPoints, optsRsi);
const macdDivs = detectDivergences(candles, macdRes.histogram, optsMacd);

// Filter signals according to Section 5:
// - Hidden divergences MUST be aligned with EMA 50 (Price > EMA 50 for Bull, Price < EMA 50 for Bear)
// - Regular divergences: Elder zero cross or RSI extreme
const signals = [...rsiDivs, ...macdDivs]
  .filter(s => {
    if (s.kind.startsWith('hidden')) {
      return s.context?.ema50TrendAligned === true;
    } else {
      // Regular: require true exhaustion
      if (s.kind === 'bull' && s.startOsc <= 35) return true;
      if (s.kind === 'bear' && s.startOsc >= 65) return true;
      return false;
    }
  })
  .sort((a, b) => a.confirmedTime - b.confirmedTime);

console.log(`Master PDF configuration generated ${signals.length} high-conviction signals.`);

function simulate(targetTrades = 100, rr = 1.6, bufferPct = 0.005, trailing = false) {
  let balance = 1000, peak = 1000, maxDD = 0;
  const trades = [];

  for (const sig of signals) {
    if (trades.length >= targetTrades) break;

    const cIdx = candleIndexMap.get(sig.confirmedTime);
    if (!cIdx || cIdx >= candles.length - 1) continue;

    const confCandle = candles[cIdx];
    const side = (sig.kind === 'bull' || sig.kind === 'hidden-bull') ? 'LONG' : 'SHORT';
    const entryPrice = confCandle.close;

    // Buffer of 0.5% as recommended on page 20
    let stopLoss = side === 'LONG'
      ? sig.endPrice * (1 - bufferPct)
      : sig.endPrice * (1 + bufferPct);

    const riskDistance = Math.abs(entryPrice - stopLoss);
    const riskPct = riskDistance / entryPrice;

    // Skip if risk is too wide (> 4%) or invalid
    if (riskPct < 0.005 || riskPct > 0.045) continue;

    const riskDollars = balance * 0.015; // 1.5% fixed risk
    const qty = riskDollars / riskDistance;
    let tp = side === 'LONG' ? entryPrice + riskDistance * rr : entryPrice - riskDistance * rr;

    let exitPrice = null;
    let reason = '';
    let currentSL = stopLoss;

    for (let c = cIdx + 1; c < Math.min(candles.length, cIdx + 48); c++) {
      const cur = candles[c];

      // Trailing rule: if price reaches +1R, move SL to entry (Break-Even)
      if (trailing) {
        if (side === 'LONG' && cur.high >= entryPrice + riskDistance) {
          currentSL = Math.max(currentSL, entryPrice);
        } else if (side === 'SHORT' && cur.low <= entryPrice - riskDistance) {
          currentSL = Math.min(currentSL, entryPrice);
        }
      }

      if (side === 'LONG') {
        if (cur.low <= currentSL) { exitPrice = currentSL; reason = currentSL === entryPrice ? 'BE' : 'SL'; break; }
        if (cur.high >= tp) { exitPrice = tp; reason = 'TP'; break; }
      } else {
        if (cur.high >= currentSL) { exitPrice = currentSL; reason = currentSL === entryPrice ? 'BE' : 'SL'; break; }
        if (cur.low <= tp) { exitPrice = tp; reason = 'TP'; break; }
      }
    }

    if (!exitPrice) {
      exitPrice = candles[Math.min(candles.length - 1, cIdx + 48)].close;
      reason = 'TIME';
    }

    const priceDiff = side === 'LONG' ? (exitPrice - entryPrice) : (entryPrice - exitPrice);
    const gross = priceDiff * qty;
    const fees = (entryPrice + exitPrice) * qty * 0.0005; // 0.05% exchange fee
    const net = gross - fees;

    balance += net;
    if (balance > peak) peak = balance;
    const dd = ((peak - balance) / peak) * 100;
    if (dd > maxDD) maxDD = dd;

    trades.push({
      num: trades.length + 1,
      date: new Date(confCandle.time * 1000).toISOString().slice(0, 10),
      side,
      kind: sig.kind,
      source: sig.oscillatorSource,
      entryPrice: Math.round(entryPrice * 100) / 100,
      exitPrice: Math.round(exitPrice * 100) / 100,
      stopLoss: Math.round(stopLoss * 100) / 100,
      takeProfit: Math.round(tp * 100) / 100,
      netPnl: Math.round(net * 100) / 100,
      rMultiple: Math.round((net / riskDollars) * 100) / 100,
      balance: Math.round(balance * 100) / 100,
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
    shorts: trades.filter(t => t.side === 'SHORT').length,
    trades
  };
}

const resFixed15 = simulate(100, 1.5, 0.005, false);
const resFixed20 = simulate(100, 2.0, 0.005, false);
const resTrailing = simulate(100, 2.0, 0.005, true);

console.log('Fixed 1.5R:', { winRate: resFixed15.winRate + '%', pf: resFixed15.profitFactor, profit: resFixed15.profitPct + '%', balance: '$' + resFixed15.finalBalance, maxDD: resFixed15.maxDrawdownPct + '%' });
console.log('Fixed 2.0R:', { winRate: resFixed20.winRate + '%', pf: resFixed20.profitFactor, profit: resFixed20.profitPct + '%', balance: '$' + resFixed20.finalBalance, maxDD: resFixed20.maxDrawdownPct + '%' });
console.log('Trailing BE at 1R -> 2.0R:', { winRate: resTrailing.winRate + '%', pf: resTrailing.profitFactor, profit: resTrailing.profitPct + '%', balance: '$' + resTrailing.finalBalance, maxDD: resTrailing.maxDrawdownPct + '%' });

fs.writeFileSync('c:/Users/useru/.gemini/antigravity/brain/2bfd0a7f-bdae-4fb3-ad83-c9a65780fd06/scratch/master_pdf_sim.json', JSON.stringify({ resFixed15, resFixed20, resTrailing }, null, 2));
