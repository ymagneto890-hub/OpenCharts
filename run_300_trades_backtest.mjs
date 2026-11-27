import fs from 'node:fs';
import {
  detectDivergences,
  rsi,
  macd,
  balancedDivergenceOptions,
  normalizeCandles
} from './src/lib/indicators.ts';

function loadAsset(filePath, symbol) {
  const candles = normalizeCandles(JSON.parse(fs.readFileSync(filePath, 'utf-8')));
  const rsiPoints = rsi(candles, 14);
  const macdRes = macd(candles, 12, 26, 9);

  const optsRsi = balancedDivergenceOptions('4h', 'rsi', 'rsi');
  optsRsi.oscLeftBars = 5;
  optsRsi.oscRightBars = 3;

  const optsMacd = balancedDivergenceOptions('4h', 'macd', 'histogram');
  optsMacd.oscLeftBars = 5;
  optsMacd.oscRightBars = 2;

  const rsiDivs = detectDivergences(candles, rsiPoints, optsRsi);
  const macdDivs = detectDivergences(candles, macdRes.histogram, optsMacd);

  const signals = [...rsiDivs, ...macdDivs]
    .filter(s => s.kind.startsWith('hidden') && s.context?.ema50TrendAligned === true)
    .map(s => ({ ...s, symbol, candles }));

  return { candles, signals };
}

console.log('Loading BTC, ETH, SOL historical data...');
const btc = loadAsset('src/services/demo/data/BTCUSD_4h.json', 'BTC');
const eth = loadAsset('src/services/demo/data/ETHUSD_4h.json', 'ETH');
const sol = loadAsset('src/services/demo/data/SOLUSD_4h.json', 'SOL');

console.log(`BTC signals: ${btc.signals.length}, ETH signals: ${eth.signals.length}, SOL signals: ${sol.signals.length}`);

// 1. Backtest 300 trades on BTC alone
function runSingleAsset300(signals, candles, targetTrades = 300, rr = 2.0, buffer = 0.005) {
  const candleIndexMap = new Map(candles.map((c, i) => [c.time, i]));
  let balance = 1000, peak = 1000, maxDD = 0;
  const trades = [];

  for (const sig of signals) {
    if (trades.length >= targetTrades) break;

    const cIdx = candleIndexMap.get(sig.confirmedTime);
    if (!cIdx || cIdx >= candles.length - 1) continue;

    const confCandle = candles[cIdx];
    const side = sig.kind === 'hidden-bull' ? 'LONG' : 'SHORT';
    const entryPrice = confCandle.close;

    let stopLoss = side === 'LONG'
      ? sig.endPrice * (1 - buffer)
      : sig.endPrice * (1 + buffer);

    const riskDistance = Math.abs(entryPrice - stopLoss);
    if (riskDistance / entryPrice < 0.005 || riskDistance / entryPrice > 0.045) continue;

    const riskDollars = balance * 0.015; // 1.5% fixed risk
    const qty = riskDollars / riskDistance;
    const tp = side === 'LONG'
      ? entryPrice + riskDistance * rr
      : entryPrice - riskDistance * rr;

    let exitPrice = null;
    let reason = '';
    let exitIdx = -1;

    for (let c = cIdx + 1; c < Math.min(candles.length, cIdx + 48); c++) {
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
      exitIdx = Math.min(candles.length - 1, cIdx + 48);
      exitPrice = candles[exitIdx].close;
      reason = 'TIME';
    }

    const priceDiff = side === 'LONG' ? (exitPrice - entryPrice) : (entryPrice - exitPrice);
    const gross = priceDiff * qty;
    const fees = (entryPrice + exitPrice) * qty * 0.0005;
    const net = gross - fees;

    balance += net;
    if (balance > peak) peak = balance;
    const dd = ((peak - balance) / peak) * 100;
    if (dd > maxDD) maxDD = dd;

    trades.push({
      num: trades.length + 1,
      date: new Date(confCandle.time * 1000).toISOString().slice(0, 10),
      exitDate: new Date(candles[exitIdx].time * 1000).toISOString().slice(0, 10),
      side,
      kind: sig.kind,
      source: sig.oscillatorSource || 'rsi',
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
    netProfit: Number((balance - 1000).toFixed(2)),
    netProfitPct: Number(((balance - 1000) / 10).toFixed(2)),
    profitFactor: Number(pf.toFixed(2)),
    avgR: Number(avgR.toFixed(2)),
    maxDrawdownPct: Number(maxDD.toFixed(2)),
    longs: trades.filter(t => t.side === 'LONG').length,
    shorts: trades.filter(t => t.side === 'SHORT').length,
    trades
  };
}

const btcAllTrades = runSingleAsset300(btc.signals, btc.candles, 300, 2.0, 0.005);
console.log('\n=== BTC ONLY (ALL AVAILABLE TRADES) ===');
console.log('Total Trades in BTC History: ' + btcAllTrades.tradesCount);
console.log('Period: ' + btcAllTrades.startDate + ' to ' + btcAllTrades.endDate);
console.log('Win Rate: ' + btcAllTrades.winRate + '% (' + btcAllTrades.wins + ' Wins / ' + btcAllTrades.losses + ' Losses)');
console.log('Profit Factor: ' + btcAllTrades.profitFactor);
console.log('Expectancy (Avg R): +' + btcAllTrades.avgR + 'R per trade');
console.log('Initial Balance: $' + btcAllTrades.initialBalance + ' -> Final Balance: $' + btcAllTrades.finalBalance);
console.log('Net Profit: +$' + btcAllTrades.netProfit + ' (+' + btcAllTrades.netProfitPct + '%)');
console.log('Max Drawdown: ' + btcAllTrades.maxDrawdownPct + '%');

fs.writeFileSync('c:/Users/useru/.gemini/antigravity/brain/2bfd0a7f-bdae-4fb3-ad83-c9a65780fd06/scratch/btc_all_trades_backtest.json', JSON.stringify(btcAllTrades, null, 2));
