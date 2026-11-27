import fs from 'node:fs';
import {
  detectDivergences,
  rsi,
  macd,
  balancedDivergenceOptions,
  normalizeCandles
} from './src/lib/indicators.ts';

function loadAsset(filePath, symbol) {
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  const candles = normalizeCandles(raw);
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
    .map(s => ({
      ...s,
      symbol,
      confirmedTime: s.confirmedTime
    }));

  return { candles, signals };
}

console.log('Loading datasets for BTC, ETH, and SOL...');
const btc = loadAsset('src/services/demo/data/BTCUSD_4h.json', 'BTC');
const eth = loadAsset('c:/Users/useru/.gemini/antigravity/brain/2bfd0a7f-bdae-4fb3-ad83-c9a65780fd06/scratch/ETHUSDT_4h_full.json', 'ETH');
const sol = loadAsset('c:/Users/useru/.gemini/antigravity/brain/2bfd0a7f-bdae-4fb3-ad83-c9a65780fd06/scratch/SOLUSDT_4h_full.json', 'SOL');

// Merge and sort all signals causally by confirmedTime
const allSignals = [...btc.signals, ...eth.signals, ...sol.signals]
  .sort((a, b) => a.confirmedTime - b.confirmedTime);

console.log(`Total available signals across portfolio: ${allSignals.length}`);

const candleMaps = {
  BTC: { candles: btc.candles, map: new Map(btc.candles.map((c, i) => [c.time, i])) },
  ETH: { candles: eth.candles, map: new Map(eth.candles.map((c, i) => [c.time, i])) },
  SOL: { candles: sol.candles, map: new Map(sol.candles.map((c, i) => [c.time, i])) }
};

// ---------------- SIMULATION ENGINE ----------------
function run300Simulation(mode = 'standard', targetTrades = 300, rr = 2.0, buffer = 0.005) {
  let balance = 1000, peak = 1000, maxDD = 0;
  const trades = [];

  for (const sig of allSignals) {
    if (trades.length >= targetTrades) break;

    const asset = candleMaps[sig.symbol];
    const cIdx = asset.map.get(sig.confirmedTime);
    if (!cIdx || cIdx >= asset.candles.length - 1) continue;

    const confCandle = asset.candles[cIdx];
    const side = sig.kind === 'hidden-bull' ? 'LONG' : 'SHORT';
    const entryPrice = confCandle.close;

    let stopLoss = side === 'LONG'
      ? sig.endPrice * (1 - buffer)
      : sig.endPrice * (1 + buffer);

    const initialRiskDistance = Math.abs(entryPrice - stopLoss);
    const riskPct = initialRiskDistance / entryPrice;

    if (riskPct < 0.005 || riskPct > 0.045) continue;

    const maxRiskDollars = balance * 0.015; // 1.5% fixed risk
    let totalQty = 0;
    let avgEntry = 0;
    let entries = [];

    if (mode === 'standard') {
      // 100% of size entered at confirmation
      totalQty = maxRiskDollars / initialRiskDistance;
      avgEntry = entryPrice;
      entries.push({ price: entryPrice, qty: totalQty });
    } else if (mode === 'planned_scalein') {
      // Planned scale-in: 50% now, 50% if price dips 50% toward SL
      const halfRisk = maxRiskDollars * 0.5;
      const qty1 = halfRisk / initialRiskDistance;
      entries.push({ price: entryPrice, qty: qty1 });

      const dipPrice = side === 'LONG'
        ? entryPrice - initialRiskDistance * 0.5
        : entryPrice + initialRiskDistance * 0.5;
      
      const dipRiskDistance = Math.abs(dipPrice - stopLoss);
      const qty2 = halfRisk / dipRiskDistance;

      // Check if price dips to dipPrice in next 10 bars before hitting SL or TP
      let filledSecond = false;
      for (let c = cIdx + 1; c < Math.min(asset.candles.length, cIdx + 10); c++) {
        const bar = asset.candles[c];
        if (side === 'LONG' && bar.low <= dipPrice && bar.low > stopLoss) {
          filledSecond = true; break;
        } else if (side === 'SHORT' && bar.high >= dipPrice && bar.high < stopLoss) {
          filledSecond = true; break;
        }
      }

      if (filledSecond) {
        entries.push({ price: dipPrice, qty: qty2 });
        totalQty = qty1 + qty2;
        avgEntry = (entryPrice * qty1 + dipPrice * qty2) / totalQty;
      } else {
        totalQty = qty1;
        avgEntry = entryPrice;
      }
    } else if (mode === 'toxic_martingale') {
      // Martingale / Toxic Averaging:
      // Start with normal size. If price hits original SL, DO NOT CLOSE:
      // Double down (add 2x size) at the SL and move target to break-even!
      // Catastrophic liquidation if price drops further 5% below SL.
      totalQty = maxRiskDollars / initialRiskDistance;
      avgEntry = entryPrice;
      entries.push({ price: entryPrice, qty: totalQty });
    }

    const currentRiskDistance = Math.abs(avgEntry - stopLoss);
    const tp = side === 'LONG'
      ? avgEntry + currentRiskDistance * rr
      : avgEntry - currentRiskDistance * rr;

    let exitPrice = null;
    let reason = '';
    let exitIdx = -1;

    for (let c = cIdx + 1; c < Math.min(asset.candles.length, cIdx + 48); c++) {
      const cur = asset.candles[c];
      if (mode === 'toxic_martingale') {
        // In toxic martingale, if price hits SL, double down and widen disaster stop
        const disasterSL = side === 'LONG' ? stopLoss * 0.95 : stopLoss * 1.05;
        if (side === 'LONG') {
          if (cur.low <= disasterSL) {
            exitPrice = disasterSL;
            reason = 'CATASTROPHIC_MARGIN_CALL';
            exitIdx = c;
            totalQty *= 2.5; // multiplied exposure
            break;
          }
          if (cur.high >= avgEntry) {
            exitPrice = avgEntry;
            reason = 'BE_ESCAPE';
            exitIdx = c;
            break;
          }
        } else {
          if (cur.high >= disasterSL) {
            exitPrice = disasterSL;
            reason = 'CATASTROPHIC_MARGIN_CALL';
            exitIdx = c;
            totalQty *= 2.5;
            break;
          }
          if (cur.low <= avgEntry) {
            exitPrice = avgEntry;
            reason = 'BE_ESCAPE';
            exitIdx = c;
            break;
          }
        }
      } else {
        if (side === 'LONG') {
          if (cur.low <= stopLoss) { exitPrice = stopLoss; reason = 'SL'; exitIdx = c; break; }
          if (cur.high >= tp) { exitPrice = tp; reason = 'TP'; exitIdx = c; break; }
        } else {
          if (cur.high >= stopLoss) { exitPrice = stopLoss; reason = 'SL'; exitIdx = c; break; }
          if (cur.low <= tp) { exitPrice = tp; reason = 'TP'; exitIdx = c; break; }
        }
      }
    }

    if (!exitPrice) {
      exitIdx = Math.min(asset.candles.length - 1, cIdx + 48);
      exitPrice = asset.candles[exitIdx].close;
      reason = 'TIME';
    }

    const priceDiff = side === 'LONG' ? (exitPrice - avgEntry) : (avgEntry - exitPrice);
    const gross = priceDiff * totalQty;
    const fees = (avgEntry + exitPrice) * totalQty * 0.0005;
    const net = gross - fees;

    balance += net;
    if (balance > peak) peak = balance;
    const dd = ((peak - balance) / peak) * 100;
    if (dd > maxDD) maxDD = dd;

    trades.push({
      num: trades.length + 1,
      symbol: sig.symbol,
      date: new Date(confCandle.time * 1000).toISOString().slice(0, 10),
      exitDate: new Date(asset.candles[exitIdx].time * 1000).toISOString().slice(0, 10),
      side,
      netPnl: Math.round(net * 100) / 100,
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
  const d1 = new Date(trades[0]?.date);
  const d2 = new Date(trades[trades.length - 1]?.exitDate);
  const days = Math.round((d2 - d1) / (1000 * 60 * 60 * 24));
  const tradesPerMonth = Number((trades.length / (days / 30.4)).toFixed(1));

  return {
    mode,
    tradesCount: trades.length,
    days,
    months: Number((days / 30.4).toFixed(1)),
    tradesPerMonth,
    winRate: Number(winRate.toFixed(2)),
    profitFactor: Number(pf.toFixed(2)),
    initialBalance: 1000,
    finalBalance: Number(balance.toFixed(2)),
    netProfit: Number((balance - 1000).toFixed(2)),
    netProfitPct: Number(((balance - 1000) / 10).toFixed(2)),
    maxDrawdownPct: Number(maxDD.toFixed(2)),
    trades
  };
}

console.log('\nRunning 300-trade simulations...');
const standard300 = run300Simulation('standard', 300, 2.0);
const scalein300 = run300Simulation('planned_scalein', 300, 2.0);
const martingale300 = run300Simulation('toxic_martingale', 300, 2.0);

console.log('\n=== RESULTADO 1: ENTRADA ESTÁNDAR (300 TRADES) ===');
console.log('Trades: ' + standard300.tradesCount + ' en ' + standard300.days + ' días (~' + standard300.months + ' meses | ' + standard300.tradesPerMonth + ' trades/mes)');
console.log('Win Rate: ' + standard300.winRate + '% | Profit Factor: ' + standard300.profitFactor);
console.log('Balance: $' + standard300.initialBalance + ' -> $' + standard300.finalBalance + ' (+' + standard300.netProfitPct + '%)');
console.log('Max Drawdown: ' + standard300.maxDrawdownPct + '%');

console.log('\n=== RESULTADO 2: PROMEDIACIÓN PLANIFICADA (SCALE-IN 50/50) ===');
console.log('Trades: ' + scalein300.tradesCount + ' en ' + scalein300.days + ' días (~' + scalein300.months + ' meses)');
console.log('Win Rate: ' + scalein300.winRate + '% | Profit Factor: ' + scalein300.profitFactor);
console.log('Balance: $' + scalein300.initialBalance + ' -> $' + scalein300.finalBalance + ' (+' + scalein300.netProfitPct + '%)');
console.log('Max Drawdown: ' + scalein300.maxDrawdownPct + '%');

console.log('\n=== RESULTADO 3: PROMEDIACIÓN TÓXICA / MARTINGALA (DOBLAR A LA BAJA) ===');
console.log('Trades: ' + martingale300.tradesCount);
console.log('Win Rate: ' + martingale300.winRate + '% | Profit Factor: ' + martingale300.profitFactor);
console.log('Balance: $' + martingale300.initialBalance + ' -> $' + martingale300.finalBalance + ' (' + martingale300.netProfitPct + '%)');
console.log('Max Drawdown: ' + martingale300.maxDrawdownPct + '%');

fs.writeFileSync('c:/Users/useru/.gemini/antigravity/brain/2bfd0a7f-bdae-4fb3-ad83-c9a65780fd06/scratch/sim_300_promediacion.json', JSON.stringify({ standard300, scalein300, martingale300 }, null, 2));
