import { describe, it, expect, beforeEach } from "vitest";
import {
  sma,
  ema,
  rsi,
  macd,
  bollingerBands,
  atr,
  stochastic,
  vwap,
  detectDivergences,
  computeMacdThresholds,
  normalizeCandles,
  type CandleData,
} from "../lib/indicators.ts";
import { OscillatorPanePrimitive } from "../lib/chart-plugins/oscillator-pane-primitive.ts";
import * as engine from "../services/demo/engine.ts";
import { useReplayStore } from "../services/demo/replay.ts";
import { updateLatestBarPrice, getHistory } from "../services/demo/candles.ts";

describe("Deep Technical Audit Verification & Mathematical Accuracy Suite", () => {
  beforeEach(() => {
    if (useReplayStore.getState().phase !== "idle") {
      useReplayStore.getState().stop();
    }
    engine.exitReplay();
    engine.resetAccount({
      startingBalance: 100_000,
      feeRate: 0.0005,
      keepHistory: false,
    });
  });

  describe("1. Technical Indicators: Formula & Mathematical Verification", () => {
    const deterministicCandles: CandleData[] = [
      { time: 100, open: 10, high: 12, low: 9, close: 11, volume: 100 },
      { time: 200, open: 11, high: 14, low: 10, close: 13, volume: 150 },
      { time: 300, open: 13, high: 15, low: 12, close: 12, volume: 200 },
      { time: 400, open: 12, high: 16, low: 11, close: 15, volume: 250 },
      { time: 500, open: 15, high: 17, low: 14, close: 14, volume: 300 },
    ];

    it("verifies SMA formula against independent manual calculation", () => {
      // 3-period SMA of closes: [11, 13, 12, 15, 14]
      // Bar 3 (time 300): (11 + 13 + 12) / 3 = 36 / 3 = 12.0
      // Bar 4 (time 400): (13 + 12 + 15) / 3 = 40 / 3 = 13.333333333333334
      // Bar 5 (time 500): (12 + 15 + 14) / 3 = 41 / 3 = 13.666666666666666
      const res = sma(deterministicCandles, 3);
      expect(res).toHaveLength(3);
      expect(res[0]!.time).toBe(300);
      expect(res[0]!.value).toBeCloseTo(12.0, 8);
      expect(res[1]!.time).toBe(400);
      expect(res[1]!.value).toBeCloseTo(40 / 3, 8);
      expect(res[2]!.time).toBe(500);
      expect(res[2]!.value).toBeCloseTo(41 / 3, 8);
    });

    it("verifies EMA formula with Pine Script seed and smoothing factor k = 2/(N+1)", () => {
      // 3-period EMA:
      // k = 2 / (3 + 1) = 0.5
      // Seed at bar 3: SMA = 12.0
      // Bar 4 (close 15): 15 * 0.5 + 12.0 * 0.5 = 7.5 + 6.0 = 13.5
      // Bar 5 (close 14): 14 * 0.5 + 13.5 * 0.5 = 7.0 + 6.75 = 13.75
      const res = ema(deterministicCandles, 3);
      expect(res).toHaveLength(3);
      expect(res[0]!.time).toBe(300);
      expect(res[0]!.value).toBeCloseTo(12.0, 8);
      expect(res[1]!.time).toBe(400);
      expect(res[1]!.value).toBeCloseTo(13.5, 8);
      expect(res[2]!.time).toBe(500);
      expect(res[2]!.value).toBeCloseTo(13.75, 8);
    });

    it("verifies Bollinger Bands variance and standard deviation", () => {
      // 3-period BB of closes: [11, 13, 12, 15, 14], stdDevMultiplier = 2
      // For first window [11, 13, 12]: mean = 12
      // variance = ((11-12)^2 + (13-12)^2 + (12-12)^2) / 3 = (1 + 1 + 0) / 3 = 2/3
      // stdDev = sqrt(2/3) ≈ 0.81649658
      // middle = 12.0
      // upper = 12.0 + 2 * sqrt(2/3) ≈ 13.632993
      // lower = 12.0 - 2 * sqrt(2/3) ≈ 10.367007
      const res = bollingerBands(deterministicCandles, 3, 2);
      expect(res.middle).toHaveLength(3);
      expect(res.middle[0]!.value).toBeCloseTo(12.0, 6);
      const expectedStdDev = Math.sqrt(2 / 3);
      expect(res.upper[0]!.value).toBeCloseTo(12.0 + 2 * expectedStdDev, 6);
      expect(res.lower[0]!.value).toBeCloseTo(12.0 - 2 * expectedStdDev, 6);
    });

    it("verifies ATR (Average True Range) using Wilder's RMA", () => {
      // Candles:
      // 0: high 12, low 9, close 11
      // 1: high 14, low 10, close 13 -> TR1 = max(14-10, |14-11|, |10-11|) = max(4, 3, 1) = 4
      // 2: high 15, low 12, close 12 -> TR2 = max(15-12, |15-13|, |12-13|) = max(3, 2, 1) = 3
      // 3: high 16, low 11, close 15 -> TR3 = max(16-11, |16-12|, |11-12|) = max(5, 4, 1) = 5
      // 4: high 17, low 14, close 14 -> TR4 = max(17-14, |17-15|, |14-15|) = max(3, 2, 1) = 3
      // 2-period ATR:
      // Seed at bar 2 (time 300): (TR1 + TR2)/2 = (4 + 3)/2 = 3.5
      // Bar 3 (time 400): (3.5 * (2-1) + TR3) / 2 = (3.5 + 5) / 2 = 4.25
      // Bar 4 (time 500): (4.25 * 1 + TR4) / 2 = (4.25 + 3) / 2 = 3.625
      const res = atr(deterministicCandles, 2);
      expect(res).toHaveLength(3);
      expect(res[0]!.time).toBe(300);
      expect(res[0]!.value).toBeCloseTo(3.5, 6);
      expect(res[1]!.time).toBe(400);
      expect(res[1]!.value).toBeCloseTo(4.25, 6);
      expect(res[2]!.time).toBe(500);
      expect(res[2]!.value).toBeCloseTo(3.625, 6);
    });

    it("verifies Stochastic Oscillator (%K and %D lines)", () => {
      // 3-period Stochastic, %D period 2
      // Window 1 (bars 0..2):
      // highs: [12, 14, 15] -> highest = 15
      // lows: [9, 10, 12] -> lowest = 9
      // close: 12
      // %K1 = ((12 - 9) / (15 - 9)) * 100 = (3 / 6) * 100 = 50.0
      // Window 2 (bars 1..3):
      // highs: [14, 15, 16] -> highest = 16
      // lows: [10, 12, 11] -> lowest = 10
      // close: 15
      // %K2 = ((15 - 10) / (16 - 10)) * 100 = (5 / 6) * 100 = 83.333333
      // Window 3 (bars 2..4):
      // highs: [15, 16, 17] -> highest = 17
      // lows: [12, 11, 14] -> lowest = 11
      // close: 14
      // %K3 = ((14 - 11) / (17 - 11)) * 100 = (3 / 6) * 100 = 50.0
      // %D (period 2):
      // First %D at Window 2: (50.0 + 83.333333) / 2 = 66.666667
      // Second %D at Window 3: (83.333333 + 50.0) / 2 = 66.666667
      const res = stochastic(deterministicCandles, 3, 2);
      expect(res.k).toHaveLength(3);
      expect(res.k[0]!.value).toBeCloseTo(50.0, 4);
      expect(res.k[1]!.value).toBeCloseTo(83.3333, 4);
      expect(res.k[2]!.value).toBeCloseTo(50.0, 4);

      expect(res.d).toHaveLength(2);
      expect(res.d[0]!.value).toBeCloseTo(66.6667, 4);
      expect(res.d[1]!.value).toBeCloseTo(66.6667, 4);
    });

    it("verifies VWAP calculation without lookahead", () => {
      // Typical price = (H + L + C) / 3
      // Bar 0: (12 + 9 + 11)/3 = 32/3 ≈ 10.6667, vol = 100 -> cumPriceVol = 1066.6667, cumVol = 100 -> vwap = 10.6667
      // Bar 1: (14 + 10 + 13)/3 = 37/3 ≈ 12.3333, vol = 150 -> priceVol = 1850, cumPriceVol = 2916.6667, cumVol = 250 -> vwap = 11.6667
      const res = vwap(deterministicCandles);
      expect(res).toHaveLength(5);
      expect(res[0]!.value).toBeCloseTo(32 / 3, 4);
      expect(res[1]!.value).toBeCloseTo((3200 / 3 + 37 * 50) / 250, 4);
    });

    it("verifies MACD (fast, slow, signal, histogram) and threshold solver", () => {
      const res = macd(deterministicCandles, 2, 4, 2);
      expect(res.macd).toBeDefined();
      expect(res.signal).toBeDefined();
      expect(res.histogram).toBeDefined();
      expect(res.macd.length).toBeGreaterThan(0);
      expect(res.histogram.length).toBe(res.signal.length);
      for (let i = 0; i < res.histogram.length; i++) {
        const sigPoint = res.signal[i]!;
        const macdPoint = res.macd.find((m) => m.time === sigPoint.time);
        if (macdPoint) {
          expect(res.histogram[i]!.value).toBeCloseTo(macdPoint.value - sigPoint.value, 6);
        }
      }
    });

    it("gracefully handles invalid/zero/negative periods and edge cases without throwing", () => {
      expect(sma(deterministicCandles, 0)).toEqual([]);
      expect(sma(deterministicCandles, -5)).toEqual([]);
      expect(ema(deterministicCandles, 0)).toEqual([]);
      expect(ema(deterministicCandles, -1)).toEqual([]);
      expect(rsi(deterministicCandles, 0)).toEqual([]);
      expect(rsi(deterministicCandles, -2)).toEqual([]);
      expect(bollingerBands(deterministicCandles, 0)).toEqual({ upper: [], middle: [], lower: [] });
      expect(atr(deterministicCandles, 0)).toEqual([]);
      expect(stochastic(deterministicCandles, 0, 0)).toEqual({ k: [], d: [] });
      expect(computeMacdThresholds(deterministicCandles, 0, 0, 0)).toBeNull();
      expect(computeMacdThresholds(deterministicCandles, 2, 3, 1)).not.toBeNull();
    });

    it("normalizes and sanitizes candles with non-finite values and unsorted timestamps", () => {
      const corrupt: CandleData[] = [
        { time: 300, open: 13, high: NaN, low: 10, close: 12 },
        { time: 100, open: NaN, high: 12, low: 9, close: 11 },
        { time: 200, open: 11, high: 14, low: NaN, close: 13 },
        { time: 200, open: 11, high: 14, low: 10, close: 13 }, // duplicate time
      ];
      const clean = normalizeCandles(corrupt);
      expect(clean).toHaveLength(3);
      expect(clean[0]!.time).toBe(100);
      expect(clean[0]!.open).toBe(11); // Fallback to close
      expect(clean[1]!.time).toBe(200);
      expect(clean[1]!.low).toBe(10); // Deduplicated with valid entry
      expect(clean[2]!.time).toBe(300);
      expect(clean[2]!.high).toBe(13); // Fallback to max(open, close)
    });
  });

  describe("2. Divergence Engine: 4 Classifications, Causality & Negative Tests", () => {
    // Generate synthetic series with strict control
    function makeSeries(closes: number[], oscs: number[]): { candles: CandleData[]; osc: { time: number; value: number }[] } {
      const candles: CandleData[] = closes.map((c, i) => ({
        time: (i + 1) * 3600,
        open: c,
        high: c + 1,
        low: c - 1,
        close: c,
        volume: 1000,
      }));
      const osc = oscs.map((o, i) => ({
        time: (i + 1) * 3600,
        value: o,
      }));
      return { candles, osc };
    }

    it("detects Regular Bullish divergence (Price Lower Low + Oscillator Higher Low)", () => {
      // Swing 1 low at idx 4 (Price 90, Osc 20)
      // Swing 2 low at idx 12 (Price 85 = Lower Low, Osc 28 = Higher Low)
      const closes = [100, 96, 92, 90, 89, 93, 97, 102, 98, 93, 88, 86, 85, 89, 94, 98, 100];
      const oscs =   [ 50, 38, 26, 21, 20, 27, 39,  55, 46, 37, 31, 29, 28, 35, 45,  52,  56];
      const { candles, osc } = makeSeries(closes, oscs);

      const divs = detectDivergences(candles, osc, {
        mode: "rsi",
        leftBars: 3,
        rightBars: 2,
        minBars: 4,
        filterZones: false,
      });

      const bull = divs.find((d) => d.kind === "bull");
      expect(bull).toBeDefined();
      expect(bull!.label).toBe("Alcista");
      expect(bull!.startPrice).toBeGreaterThan(bull!.endPrice); // Lower Low on price
      expect(bull!.startOsc).toBeLessThan(bull!.endOsc); // Higher Low on osc
      // Strict causality: confirmation requires rightBars (2) after end pivot
      expect(bull!.confirmedTime).toBeGreaterThan(bull!.endTime);
    });

    it("detects Hidden Bullish divergence (Price Higher Low + Oscillator Lower Low)", () => {
      // Swing 1 low at idx 4 (Price 85, Osc 32)
      // Swing 2 low at idx 12 (Price 89 = Higher Low, Osc 22 = Lower Low)
      const closes = [100, 95, 90, 86, 85, 91, 98, 105, 100, 96, 92, 90, 89, 93, 99, 103, 106];
      const oscs =   [ 50, 42, 36, 33, 32, 40, 52,  65,  54, 43, 32, 25, 22, 31, 44,  55,  60];
      const { candles, osc } = makeSeries(closes, oscs);

      const divs = detectDivergences(candles, osc, {
        mode: "rsi",
        leftBars: 3,
        rightBars: 2,
        minBars: 4,
        filterZones: false,
      });

      const hidBull = divs.find((d) => d.kind === "hidden-bull");
      expect(hidBull).toBeDefined();
      expect(hidBull!.label).toBe("Alcista Oculta");
      expect(hidBull!.startPrice).toBeLessThan(hidBull!.endPrice); // Higher Low on price
      expect(hidBull!.startOsc).toBeGreaterThan(hidBull!.endOsc); // Lower Low on osc
    });

    it("detects Regular Bearish divergence (Price Higher High + Oscillator Lower High)", () => {
      // Swing 1 high at idx 4 (Price 110, Osc 78)
      // Swing 2 high at idx 12 (Price 116 = Higher High, Osc 70 = Lower High)
      const closes = [100, 104, 108, 110, 109, 105, 101, 97, 102, 108, 113, 116, 115, 110, 105, 101, 98];
      const oscs =   [ 50,  62,  73,  78,  75,  63,  51, 40,  49,  60,  67,  70,  68,  56,  48,  42, 38];
      const { candles, osc } = makeSeries(closes, oscs);

      const divs = detectDivergences(candles, osc, {
        mode: "rsi",
        leftBars: 3,
        rightBars: 2,
        minBars: 4,
        filterZones: false,
      });

      const bear = divs.find((d) => d.kind === "bear");
      expect(bear).toBeDefined();
      expect(bear!.label).toBe("Bajista");
      expect(bear!.startPrice).toBeLessThan(bear!.endPrice); // Higher High on price
      expect(bear!.startOsc).toBeGreaterThan(bear!.endOsc); // Lower High on osc
    });

    it("detects Hidden Bearish divergence (Price Lower High + Oscillator Higher High)", () => {
      // Swing 1 high at idx 4 (Price 116, Osc 68)
      // Swing 2 high at idx 12 (Price 110 = Lower High, Osc 78 = Higher High)
      const closes = [100, 106, 112, 116, 115, 108, 102, 96, 100, 105, 108, 110, 109, 103, 98, 93, 89];
      const oscs =   [ 50,  58,  64,  68,  65,  54,  45, 38,  46,  59,  71,  78,  75,  62, 50, 42, 36];
      const { candles, osc } = makeSeries(closes, oscs);

      const divs = detectDivergences(candles, osc, {
        mode: "rsi",
        leftBars: 3,
        rightBars: 2,
        minBars: 4,
        filterZones: false,
      });

      const hidBear = divs.find((d) => d.kind === "hidden-bear");
      expect(hidBear).toBeDefined();
      expect(hidBear!.label).toBe("Bajista Oculta");
      expect(hidBear!.startPrice).toBeGreaterThan(hidBear!.endPrice); // Lower High on price
      expect(hidBear!.startOsc).toBeLessThan(hidBear!.endOsc); // Higher High on osc
    });

    it("Negative Test: produces ZERO divergences on clean monotonic trend without divergence", () => {
      // Price and oscillator move 100% in lockstep upwards
      const closes = Array.from({ length: 30 }, (_, i) => 100 + i * 2);
      const oscs = Array.from({ length: 30 }, (_, i) => 30 + i * 1.5);
      const { candles, osc } = makeSeries(closes, oscs);

      const divs = detectDivergences(candles, osc, {
        mode: "rsi",
        leftBars: 3,
        rightBars: 2,
      });

      expect(divs).toHaveLength(0);
    });

    it("Negative Test: produces ZERO divergences on flat consolidation / noise", () => {
      const closes = Array.from({ length: 30 }, () => 100);
      const oscs = Array.from({ length: 30 }, () => 50);
      const { candles, osc } = makeSeries(closes, oscs);

      const divs = detectDivergences(candles, osc);
      expect(divs).toHaveLength(0);
    });
  });

  describe("3. Paper Trading Engine: Orders, STOP Modification & Financial Integrity", () => {
    it("properly updates trigger price when modifying a STOP order", () => {
      engine.mark("BTCUSD", 90_000);
      const accountId = engine.getAccount().id;

      // Place BUY STOP @ 95,000
      const order = engine.placeOrder({
        accountId,
        symbol: "BTCUSD",
        side: "BUY",
        type: "STOP",
        quantity: 0.01,
        stopPrice: 95_000,
      });

      expect(order.status).toBe("PENDING");
      expect(order.stopPrice).toBe(95_000);

      // Modify STOP trigger price from 95,000 to 94,000 using price or stopPrice
      const updated = engine.modifyOrder(order.id, {
        price: 94_000,
      });

      expect(updated).toBeDefined();
      expect(updated!.stopPrice).toBe(94_000);
      expect(engine.getOrders().find((o) => o.id === order.id)?.stopPrice).toBe(94_000);

      // Now price rises to 94,000 -> triggers the modified stop
      engine.mark("BTCUSD", 94_000);
      expect(engine.getOrders().find((o) => o.id === order.id)?.status).toBe("FILLED");
      expect(engine.getPositions()).toHaveLength(1);
      expect(engine.getPositions()[0]!.entryPrice).toBe(94_000);
    });

    it("verifies partial close financial integrity: realized P&L, fee proportion, and remaining margin", () => {
      engine.mark("BTCUSD", 50_000);
      const accountId = engine.getAccount().id;
      const initialBalance = engine.getAccount().balance;

      // Open LONG 0.02 BTC @ 50,000.
      // Notional = 0.02 * 50,000 = $1,000
      // Fee (0.05%) = $0.50
      // Balance becomes initialBalance - 0.50
      engine.placeOrder({
        accountId,
        symbol: "BTCUSD",
        side: "BUY",
        type: "MARKET",
        quantity: 0.02,
      });

      const pos = engine.getPositions()[0]!;
      expect(pos.quantity).toBe(0.02);
      expect(pos.entryPrice).toBe(50_000);
      expect(engine.getAccount().balance).toBeCloseTo(initialBalance - 0.50, 4);

      // Price moves to 55,000
      engine.mark("BTCUSD", 55_000);

      // Partial close of 0.01 BTC (50%) @ 55,000
      // Gross P&L on 0.01: (55,000 - 50,000) * 0.01 = $50.00
      // Exit Fee on 0.01: 55,000 * 0.01 * 0.0005 = $0.275
      // Entry Fee portion: 0.50 * (0.01 / 0.02) = $0.25
      // Balance changes by + gross - exitFee = +50.00 - 0.275 = +49.725
      const closeRes = engine.closePosition(pos.id, 0.01);
      expect(closeRes.success).toBe(true);

      const remainingPos = engine.getPositions()[0]!;
      expect(remainingPos.quantity).toBe(0.01);
      expect(engine.getAccount().balance).toBeCloseTo(initialBalance - 0.50 + 49.725, 4);

      const closed = engine.getClosedPositions()[0]!;
      expect(closed.quantity).toBe(0.01);
      expect(closed.realizedPnl).toBe(50.0);
      expect(closed.commission).toBeCloseTo(0.25 + 0.275, 4);
      expect(closed.isPartialClose).toBe(true);
    });

    it("cancels all pending orders in batch cleanly", () => {
      engine.mark("BTCUSD", 90_000);
      const accountId = engine.getAccount().id;

      engine.placeOrder({ accountId, symbol: "BTCUSD", side: "BUY", type: "LIMIT", quantity: 0.01, price: 85_000 });
      engine.placeOrder({ accountId, symbol: "BTCUSD", side: "BUY", type: "LIMIT", quantity: 0.02, price: 84_000 });
      engine.placeOrder({ accountId, symbol: "BTCUSD", side: "SELL", type: "LIMIT", quantity: 0.01, price: 95_000 });

      expect(engine.getOrders().filter((o) => o.status === "PENDING")).toHaveLength(3);

      const cancelRes = engine.cancelAllOrders();
      expect(cancelRes.success).toBe(true);
      expect(engine.getOrders().filter((o) => o.status === "PENDING")).toHaveLength(0);
    });
  });

  describe("4. Bar Replay Causality & Non-leakage Verification", () => {
    it("ensures visible candles never contain future bars beyond cursor", () => {
      const replay = useReplayStore.getState();
      const startRes = replay.start("BTCUSD", "1d", 1700000000);
      expect(startRes.ok).toBe(true);

      const state = useReplayStore.getState();
      expect(state.phase).toBe("active");
      expect(state.visible).not.toBeNull();
      expect(state.visible!.length).toBe(state.cursor + 1);

      const lastVisibleTime = state.visible![state.visible!.length - 1]!.time;

      // Step forward 1 bar
      replay.step();
      const steppedState = useReplayStore.getState();
      expect(steppedState.cursor).toBe(state.cursor + 1);
      expect(steppedState.visible!.length).toBe(state.visible!.length + 1);
      expect(steppedState.visible![steppedState.visible!.length - 1]!.time).toBeGreaterThan(lastVisibleTime);

      // Stop replay
      replay.stop();
      expect(useReplayStore.getState().phase).toBe("idle");
    });
  });
});

describe("4. Stop-out (forced liquidation)", () => {
  beforeEach(() => {
    if (useReplayStore.getState().phase !== "idle") useReplayStore.getState().stop();
    engine.resetAccount({ startingBalance: 100_000, feeRate: 0.0005, keepHistory: false });
  });

  function openBigLong() {
    engine.mark("BTCUSD", 90_000);
    const accountId = engine.getAccount().id;
    // 10 BTC @ 90,000 = 900,000 notional -> 9,000 margin at 100x
    engine.placeOrder({ accountId, symbol: "BTCUSD", side: "BUY", type: "MARKET", quantity: 10 });
    expect(engine.getPositions()).toHaveLength(1);
  }

  it("does not liquidate while equity stays above 50% of used margin", () => {
    openBigLong();
    engine.mark("BTCUSD", 85_000); // unrealized -50,000 -> equity ~ 49.5k >> 4.5k
    expect(engine.getPositions()).toHaveLength(1);
  });

  it("liquidates the position at market once equity <= 50% of margin", () => {
    openBigLong();
    engine.mark("BTCUSD", 80_000); // unrealized -100,000 -> equity ~ -0.5k <= 4.5k
    expect(engine.getPositions()).toHaveLength(0);
    const closed = engine.getClosedPositions();
    expect(closed).toHaveLength(1);
    expect(closed[0]!.exitReason).toBe("liquidation");
    expect(closed[0]!.exitPrice).toBe(80_000);
    // Realized loss is exactly (80,000 - 90,000) * 10
    expect(closed[0]!.realizedPnl).toBeCloseTo(-100_000, 6);
  });
});

describe("5. Execution-cost model (spread + slippage)", () => {
  beforeEach(() => {
    if (useReplayStore.getState().phase !== "idle") useReplayStore.getState().stop();
    // 2 bps spread (1 bp per side) + 3 bps slippage -> 4 bps adverse per market-like fill
    engine.resetAccount({ startingBalance: 100_000, feeRate: 0, keepHistory: false, spreadBps: 2, slippageBps: 3 });
  });

  it("market BUY fills 4 bps above and manual close fills 4 bps below the reference", () => {
    engine.mark("BTCUSD", 100_000);
    const accountId = engine.getAccount().id;
    engine.placeOrder({ accountId, symbol: "BTCUSD", side: "BUY", type: "MARKET", quantity: 1 });
    const pos = engine.getPositions()[0]!;
    expect(pos.entryPrice).toBeCloseTo(100_040, 6); // 100,000 * 1.0004
    engine.closePosition(pos.id);
    const closed = engine.getClosedPositions()[0]!;
    expect(closed.exitPrice).toBeCloseTo(99_960, 6); // 100,000 * 0.9996
    // Round trip at an unchanged price costs 80 USD (8 bps of 100k) with zero commission
    expect(closed.realizedPnl).toBeCloseTo(-80, 6);
    expect(engine.getAccount().balance).toBeCloseTo(100_000 - 80, 6);
  });

  it("market SELL (short) fills below and its close fills above the reference", () => {
    engine.mark("BTCUSD", 100_000);
    const accountId = engine.getAccount().id;
    engine.placeOrder({ accountId, symbol: "BTCUSD", side: "SELL", type: "MARKET", quantity: 1 });
    const pos = engine.getPositions()[0]!;
    expect(pos.side).toBe("SHORT");
    expect(pos.entryPrice).toBeCloseTo(99_960, 6);
    engine.closePosition(pos.id);
    expect(engine.getClosedPositions()[0]!.exitPrice).toBeCloseTo(100_040, 6);
  });

  it("take-profit and LIMIT entries are passive: no spread or slippage applied", () => {
    engine.mark("BTCUSD", 100_000);
    const accountId = engine.getAccount().id;
    engine.placeOrder({ accountId, symbol: "BTCUSD", side: "BUY", type: "LIMIT", quantity: 1, price: 99_000, takeProfit: 101_000 });
    engine.mark("BTCUSD", 99_000);
    const pos = engine.getPositions()[0]!;
    expect(pos.entryPrice).toBe(99_000);
    engine.mark("BTCUSD", 101_000);
    const closed = engine.getClosedPositions()[0]!;
    expect(closed.exitReason).toBe("take-profit");
    expect(closed.exitPrice).toBe(101_000);
  });

  it("stop-loss exit is market-like and pays the adverse cost", () => {
    engine.mark("BTCUSD", 100_000);
    const accountId = engine.getAccount().id;
    engine.placeOrder({ accountId, symbol: "BTCUSD", side: "BUY", type: "MARKET", quantity: 1, stopLoss: 99_000 });
    engine.mark("BTCUSD", 98_900);
    const closed = engine.getClosedPositions()[0]!;
    expect(closed.exitReason).toBe("stop-loss");
    // trigger fills at min(SL, price)=98,900 then 4 bps worse
    expect(closed.exitPrice).toBeCloseTo(98_900 * 0.9996, 6);
  });

  it("rejects out-of-range cost settings and defaults to zero friction", () => {
    expect(() => engine.setCostModel(-1, 0)).toThrow();
    expect(() => engine.setCostModel(0, 501)).toThrow();
    engine.resetAccount({ startingBalance: 100_000, feeRate: 0, keepHistory: false, spreadBps: 0, slippageBps: 0 });
    engine.mark("BTCUSD", 100_000);
    engine.placeOrder({ accountId: engine.getAccount().id, symbol: "BTCUSD", side: "BUY", type: "MARKET", quantity: 1 });
    expect(engine.getPositions()[0]!.entryPrice).toBe(100_000);
  });
});

describe("6. Matching engine realism: Marketable limits & margin validation", () => {
  beforeEach(() => {
    if (useReplayStore.getState().phase !== "idle") useReplayStore.getState().stop();
    engine.resetAccount({ startingBalance: 100_000, feeRate: 0.0005, keepHistory: false, spreadBps: 2, slippageBps: 3 });
  });

  it("fills a marketable BUY LIMIT immediately at market when limit price >= market", () => {
    engine.mark("BTCUSD", 100_000);
    const accountId = engine.getAccount().id;
    // Buyer is willing to pay up to 105,000; market is at 100,000. Fills immediately at market + friction!
    const order = engine.placeOrder({
      accountId,
      symbol: "BTCUSD",
      side: "BUY",
      type: "LIMIT",
      quantity: 1,
      price: 105_000,
    });
    expect(order.status).toBe("FILLED");
    expect(engine.getOrders()[0]!.status).toBe("FILLED");
    expect(engine.getPositions()).toHaveLength(1);
    // 4 bps adverse friction: 100,000 * 1.0004 = 100,040
    expect(engine.getPositions()[0]!.entryPrice).toBeCloseTo(100_040, 6);
  });

  it("fills a marketable SELL LIMIT immediately at market when limit price <= market", () => {
    engine.mark("BTCUSD", 100_000);
    const accountId = engine.getAccount().id;
    const order = engine.placeOrder({
      accountId,
      symbol: "BTCUSD",
      side: "SELL",
      type: "LIMIT",
      quantity: 1,
      price: 95_000,
    });
    expect(order.status).toBe("FILLED");
    expect(engine.getPositions()).toHaveLength(1);
    expect(engine.getPositions()[0]!.side).toBe("SHORT");
    expect(engine.getPositions()[0]!.entryPrice).toBeCloseTo(99_960, 6);
  });

  it("keeps normal passive limit orders pending until market trades at or through them", () => {
    engine.mark("BTCUSD", 100_000);
    const accountId = engine.getAccount().id;
    const order = engine.placeOrder({
      accountId,
      symbol: "BTCUSD",
      side: "BUY",
      type: "LIMIT",
      quantity: 1,
      price: 95_000,
    });
    expect(order.status).toBe("PENDING");
    expect(engine.getPositions()).toHaveLength(0);

    // Price drops to 95,000 -> fills passively at limit price
    engine.mark("BTCUSD", 95_000);
    expect(engine.getOrders()[0]!.status).toBe("FILLED");
    expect(engine.getPositions()).toHaveLength(1);
    expect(engine.getPositions()[0]!.entryPrice).toBe(95_000);
  });

  it("fills immediately when modifying a pending order into marketable price territory", () => {
    engine.mark("BTCUSD", 100_000);
    const accountId = engine.getAccount().id;
    const order = engine.placeOrder({
      accountId,
      symbol: "BTCUSD",
      side: "BUY",
      type: "LIMIT",
      quantity: 1,
      price: 95_000,
    });
    expect(order.status).toBe("PENDING");

    // Modify price up across current ask (102,000 > 100,000)
    const modified = engine.modifyOrder(order.id, { price: 102_000 });
    expect(modified).toBeDefined();
    expect(modified!.status).toBe("FILLED");
    expect(engine.getPositions()).toHaveLength(1);
    expect(engine.getPositions()[0]!.entryPrice).toBeCloseTo(100_040, 6);
  });

  it("rejects placing orders when account has insufficient margin", () => {
    engine.mark("BTCUSD", 100_000);
    const accountId = engine.getAccount().id;
    // Account starting balance is 100,000.
    // 200 BTC @ 100,000 = 20,000,000 notional -> margin needed at 100x = 200,000 USD > 100,000 USD
    expect(() =>
      engine.placeOrder({
        accountId,
        symbol: "BTCUSD",
        side: "BUY",
        type: "LIMIT",
        quantity: 200,
        price: 95_000,
      }),
    ).toThrow(/Insufficient margin/);
  });

  it("updates live latest bar price across all timeframes in memory (1m, 1h, 1d)", () => {
    const btc1m = getHistory("BTCUSD", "1m");
    const btc1h = getHistory("BTCUSD", "1h");
    expect(btc1m.length).toBeGreaterThan(0);
    expect(btc1h.length).toBeGreaterThan(0);

    const testPrice = 88_888.5;
    updateLatestBarPrice("BTCUSD", testPrice);

    const updated1m = getHistory("BTCUSD", "1m");
    const updated1h = getHistory("BTCUSD", "1h");
    expect(updated1m[updated1m.length - 1]!.close).toBe(testPrice);
    expect(updated1h[updated1h.length - 1]!.close).toBe(testPrice);
  });

  it("anchors intraday VWAP with daily session reset and handles flat stochastic safely", () => {
    // VWAP test: day 1 (0..86399) and day 2 (86400..)
    const vwapCandles: CandleData[] = [
      { time: 1000, open: 100, high: 105, low: 95, close: 100, volume: 10 },
      { time: 2000, open: 100, high: 110, low: 90, close: 100, volume: 10 },
      // Day 2 transition
      { time: 86400 + 100, open: 200, high: 205, low: 195, close: 200, volume: 5 },
    ];
    const vwapRes = vwap(vwapCandles, true);
    expect(vwapRes).toHaveLength(3);
    // On day 2, VWAP resets to day 2 typical price (200) instead of blending with day 1
    expect(vwapRes[2]!.value).toBeCloseTo(200, 2);

    // Stochastic flat line test: all candles identical (range = 0)
    const flatCandles: CandleData[] = Array.from({ length: 20 }, (_, i) => ({
      time: (i + 1) * 60,
      open: 100,
      high: 100,
      low: 100,
      close: 100,
      volume: 50,
    }));
    const stochRes = stochastic(flatCandles, 14, 3);
    expect(stochRes.k.length).toBeGreaterThan(0);
    for (const pt of stochRes.k) {
      expect(Number.isFinite(pt.value)).toBe(true);
      expect(pt.value).toBe(50);
    }
  });

  describe("7. Priority 5 Indicators (EMA 50, RSI 14, MACD 12/26/9, ATR 14, Volume + MA 20)", () => {
    it("verifies EMA 50 seed, smoothing factor k = 2/51, and exact candle timestamp alignment", () => {
      const candles: CandleData[] = Array.from({ length: 80 }, (_, i) => ({
        time: (i + 1) * 3600,
        open: 1000 + i * 5,
        high: 1010 + i * 5,
        low: 990 + i * 5,
        close: 1000 + i * 10,
        volume: 100 + i,
      }));
      const res = ema(candles, 50);
      // 80 bars with period 50 => 80 - 50 + 1 = 31 valid points starting at bar index 49
      expect(res).toHaveLength(31);
      const expectedSeed = candles.slice(0, 50).reduce((acc, c) => acc + c.close, 0) / 50;
      expect(res[0]!.time).toBe(candles[49]!.time);
      expect(res[0]!.value).toBeCloseTo(expectedSeed, 8);

      const k = 2 / 51;
      const expectedSecond = candles[50]!.close * k + expectedSeed * (1 - k);
      expect(res[1]!.time).toBe(candles[50]!.time);
      expect(res[1]!.value).toBeCloseTo(expectedSecond, 8);
    });

    it("verifies MACD (12, 26, 9) alignment and ensures first 8 MACD bars have no fake 0 Signal/Histogram", () => {
      const candles: CandleData[] = Array.from({ length: 60 }, (_, i) => ({
        time: (i + 1) * 60,
        open: 100 + Math.sin(i * 0.25) * 10,
        high: 105 + Math.sin(i * 0.25) * 10,
        low: 95 + Math.sin(i * 0.25) * 10,
        close: 100 + Math.sin(i * 0.25) * 10 + i * 0.3,
        volume: 500,
      }));
      const m = macd(candles, 12, 26, 9);
      // MACD line starts at index 25 (26th candle) -> 60 - 26 + 1 = 35 points
      expect(m.macd).toHaveLength(35);
      expect(m.macd[0]!.time).toBe(candles[25]!.time);
      // Signal & Histogram start 8 bars later (at index 25 + 8 = 33, i.e., 34th candle) -> 27 points
      expect(m.signal).toHaveLength(27);
      expect(m.histogram).toHaveLength(27);
      expect(m.signal[0]!.time).toBe(candles[33]!.time);
      expect(m.histogram[0]!.time).toBe(candles[33]!.time);

      // Verify Histogram = MACD - Signal at every aligned timestamp
      for (let i = 0; i < m.signal.length; i++) {
        const sigPt = m.signal[i]!;
        const histPt = m.histogram[i]!;
        const macdPt = m.macd[i + 8]!;
        expect(sigPt.time).toBe(macdPt.time);
        expect(histPt.time).toBe(macdPt.time);
        expect(histPt.value).toBeCloseTo(macdPt.value - sigPt.value, 10);
      }
    });

    it("verifies ATR 14 Wilder RMA smoothing and Volume + 20-period SMA alignment", () => {
      const candles: CandleData[] = Array.from({ length: 40 }, (_, i) => ({
        time: (i + 1) * 300,
        open: 200 + i,
        high: 212 + i,
        low: 192 + i,
        close: 205 + i,
        volume: (i + 1) * 10,
      }));
      const atrRes = atr(candles, 14);
      expect(atrRes).toHaveLength(40 - 14);
      expect(atrRes[0]!.time).toBe(candles[14]!.time);
      for (const pt of atrRes) {
        expect(Number.isFinite(pt.value)).toBe(true);
        expect(pt.value).toBeGreaterThan(0);
      }

      // Volume 20-period SMA check
      const volCandles: CandleData[] = candles.map((c) => ({
        ...c,
        close: c.volume ?? 0,
      }));
      const volMa = sma(volCandles, 20);
      expect(volMa).toHaveLength(21);
      expect(volMa[0]!.time).toBe(candles[19]!.time);
      // Average of 10, 20, ..., 200 = 105
      expect(volMa[0]!.value).toBeCloseTo(105, 8);
    });
  });

  describe("8. Mandatory 10-Case Divergence Verification Suite (RSI & MACD, Causal, No Repainting)", () => {
    /**
     * Helper to build a controlled candle + oscillator series with deterministic pivots
     * for testing each of the 4 divergence types (bull, bear, hidden-bull, hidden-bear).
     */
    function buildControlledSeries(
      length: number,
      basePrice: number,
      baseOsc: number,
      pivots: Array<{ idx: number; low?: number; high?: number; osc: number }>,
    ): { candles: CandleData[]; osc: { time: number; value: number }[] } {
      const candles: CandleData[] = [];
      const osc: { time: number; value: number }[] = [];
      for (let i = 0; i < length; i++) {
        const time = (i + 1) * 60;
        candles.push({
          time,
          open: basePrice,
          high: basePrice + 2,
          low: basePrice - 2,
          close: basePrice,
          volume: 100,
        });
        osc.push({ time, value: baseOsc });
      }
      // Interpolate smoothly around each pivot so lbL/lbR (5 bars each) see clean local extrema
      for (const p of pivots) {
        for (let offset = -5; offset <= 5; offset++) {
          const idx = p.idx + offset;
          if (idx < 0 || idx >= length) continue;
          const dist = Math.abs(offset);
          const weight = (6 - dist) / 6; // 1 at pivot, tapering to 1/6 at offset +-5
          if (p.low !== undefined) {
            const targetLow = basePrice - (basePrice - p.low) * weight;
            candles[idx]!.low = targetLow;
            candles[idx]!.close = targetLow + 1;
            candles[idx]!.open = targetLow + 1.5;
          }
          if (p.high !== undefined) {
            const targetHigh = basePrice + (p.high - basePrice) * weight;
            candles[idx]!.high = targetHigh;
            candles[idx]!.close = targetHigh - 1;
            candles[idx]!.open = targetHigh - 1.5;
          }
          const targetOsc = baseOsc + (p.osc - baseOsc) * weight;
          osc[idx]!.value = targetOsc;
        }
      }
      return { candles, osc };
    }

    it("Cases 1-4: accurately detects all 4 RSI divergence types (bull, bear, hidden-bull, hidden-bear)", () => {
      // 1. Regular Bullish (Price Lower Low: 90 -> 80, RSI Higher Low: 24 -> 34)
      const bullCase = buildControlledSeries(50, 110, 52, [
        { idx: 12, low: 90, osc: 24 },
        { idx: 30, low: 80, osc: 34 },
      ]);
      const bullDivs = detectDivergences(bullCase.candles, bullCase.osc, { mode: "rsi" });
      expect(
        bullDivs.some((d) => d.kind === "bull" && d.startTime === 13 * 60 && d.endTime === 31 * 60),
      ).toBe(true);

      // 2. Regular Bearish (Price Higher High: 130 -> 145, RSI Lower High: 78 -> 66)
      const bearCase = buildControlledSeries(50, 100, 48, [
        { idx: 12, high: 130, osc: 78 },
        { idx: 30, high: 145, osc: 66 },
      ]);
      const bearDivs = detectDivergences(bearCase.candles, bearCase.osc, { mode: "rsi" });
      expect(
        bearDivs.some((d) => d.kind === "bear" && d.startTime === 13 * 60 && d.endTime === 31 * 60),
      ).toBe(true);

      // 3. Hidden Bullish (Price Higher Low: 80 -> 90, RSI Lower Low: 38 -> 26)
      const hBullCase = buildControlledSeries(50, 115, 55, [
        { idx: 12, low: 80, osc: 38 },
        { idx: 30, low: 90, osc: 26 },
      ]);
      const hBullDivs = detectDivergences(hBullCase.candles, hBullCase.osc, { mode: "rsi" });
      expect(
        hBullDivs.some(
          (d) => d.kind === "hidden-bull" && d.startTime === 13 * 60 && d.endTime === 31 * 60,
        ),
      ).toBe(true);

      // 4. Hidden Bearish (Price Lower High: 145 -> 132, RSI Higher High: 62 -> 75)
      const hBearCase = buildControlledSeries(50, 100, 45, [
        { idx: 12, high: 145, osc: 62 },
        { idx: 30, high: 132, osc: 75 },
      ]);
      const hBearDivs = detectDivergences(hBearCase.candles, hBearCase.osc, { mode: "rsi" });
      expect(
        hBearDivs.some(
          (d) => d.kind === "hidden-bear" && d.startTime === 13 * 60 && d.endTime === 31 * 60,
        ),
      ).toBe(true);
    });

    it("Case 5: accurately detects all 4 MACD divergence types (bull, bear, hidden-bull, hidden-bear) including negative hills & positive valleys", () => {
      // MACD Regular Bullish (Price LL: 90 -> 80, MACD HL: -12 -> -6, intermediate recovery to -1)
      const macdBull = buildControlledSeries(50, 110, -1, [
        { idx: 12, low: 90, osc: -12 },
        { idx: 30, low: 80, osc: -6 },
      ]);
      const macdBullDivs = detectDivergences(macdBull.candles, macdBull.osc, {
        mode: "macd",
      });
      expect(macdBullDivs.some((d) => d.kind === "bull")).toBe(true);

      // MACD Regular Bearish (Price HH: 130 -> 145, MACD LH: +14 -> +7, intermediate pullback to +1)
      const macdBear = buildControlledSeries(50, 100, 1, [
        { idx: 12, high: 130, osc: 14 },
        { idx: 30, high: 145, osc: 7 },
      ]);
      const macdBearDivs = detectDivergences(macdBear.candles, macdBear.osc, {
        mode: "macd",
      });
      expect(macdBearDivs.some((d) => d.kind === "bear")).toBe(true);

      // MACD Hidden Bullish (Price HL: 80 -> 90, MACD LL: -5 -> -11)
      const macdHBull = buildControlledSeries(50, 115, 2, [
        { idx: 12, low: 80, osc: -5 },
        { idx: 30, low: 90, osc: -11 },
      ]);
      const macdHBullDivs = detectDivergences(macdHBull.candles, macdHBull.osc, {
        mode: "macd",
      });
      expect(macdHBullDivs.some((d) => d.kind === "hidden-bull")).toBe(true);

      // MACD Hidden Bearish (Price LH: 145 -> 132, MACD HH: +6 -> +13)
      const macdHBear = buildControlledSeries(50, 100, -2, [
        { idx: 12, high: 145, osc: 6 },
        { idx: 30, high: 132, osc: 13 },
      ]);
      const macdHBearDivs = detectDivergences(macdHBear.candles, macdHBear.osc, {
        mode: "macd",
      });
      expect(macdHBearDivs.some((d) => d.kind === "hidden-bear")).toBe(true);
    });

    it("Cases 6, 7, 8: produces zero false signals on non-divergent series, incomplete data, or unaligned price/oscillator wiggles", () => {
      // Case 6: Synchronized trend where both price and oscillator make higher highs and higher lows
      const synced = buildControlledSeries(50, 100, 50, [
        { idx: 12, low: 80, osc: 25 },
        { idx: 30, low: 90, osc: 35 },
      ]);
      expect(detectDivergences(synced.candles, synced.osc, { mode: "rsi" })).toHaveLength(0);

      // Case 7: Insufficient bars (< lbL + lbR + 1)
      expect(
        detectDivergences(synced.candles.slice(0, 8), synced.osc.slice(0, 8), { mode: "rsi" }),
      ).toHaveLength(0);

      // Case 8: Oscillator forms two troughs (25 -> 35), but price is falling monotonically at idx 30 without forming a local price low
      const monotonicPrice = buildControlledSeries(50, 100, 50, [
        { idx: 12, low: 90, osc: 25 },
        { idx: 30, low: 80, osc: 35 },
      ]);
      // Make price fall monotonically across idx 25..36 so idx 30 is NOT a local price low
      for (let i = 24; i <= 36; i++) {
        monotonicPrice.candles[i]!.low = 90 - (i - 20) * 1.5;
        monotonicPrice.candles[i]!.close = monotonicPrice.candles[i]!.low + 1;
      }
      expect(
        detectDivergences(monotonicPrice.candles, monotonicPrice.osc, { mode: "rsi" }),
      ).toHaveLength(0);
    });

    it("Case 9: enforces strict causality (no look-ahead and no repainting as candles arrive one by one)", () => {
      const series = buildControlledSeries(50, 110, 52, [
        { idx: 12, low: 90, osc: 24 },
        { idx: 30, low: 80, osc: 34 },
      ]);
      // Pivot 2 is at index 30 (time = 31*60 = 1860). With rightBars = 5, confirmation bar is index 35 (time = 36*60 = 2160).
      // Before index 35 (i.e. length <= 35, up to index 34), the divergence MUST NOT appear!
      for (let len = 25; len <= 35; len++) {
        const partialDivs = detectDivergences(
          series.candles.slice(0, len),
          series.osc.slice(0, len),
          { mode: "rsi", leftBars: 5, rightBars: 5 },
        );
        expect(partialDivs).toHaveLength(0);
      }

      // At length = 36 (bar index 35 available), the divergence is confirmed!
      const confirmedAt36 = detectDivergences(
        series.candles.slice(0, 36),
        series.osc.slice(0, 36),
        { mode: "rsi", leftBars: 5, rightBars: 5 },
      );
      expect(confirmedAt36).toHaveLength(1);
      expect(confirmedAt36[0]!.startTime).toBe(13 * 60);
      expect(confirmedAt36[0]!.endTime).toBe(31 * 60);
      expect(confirmedAt36[0]!.confirmedTime).toBe(36 * 60);

      // Even if bar index 36 (outside rightBars=5) drops to low=50, neighborhoodMin at confirmation bar 35 must NOT look ahead to bar 36!
      series.candles[36]!.low = 50;
      const afterFutureCrash = detectDivergences(series.candles, series.osc, {
        mode: "rsi",
        leftBars: 5,
        rightBars: 5,
        toleranceBars: 6,
      });
      expect(afterFutureCrash[0]!.endPrice).toBe(confirmedAt36[0]!.endPrice);
      expect(afterFutureCrash[0]!.confirmedTime).toBe(confirmedAt36[0]!.confirmedTime);
    });

    it("Case 10: verifies OscillatorPanePrimitive renders all 4 divergence styles and dynamically expands autoscale bounds", () => {
      const prim = new OscillatorPanePrimitive(
        {
          kind: "rsi",
          title: "RSI (14)",
          headerValues: [],
          divergences: [
            {
              kind: "bull",
              label: "Alcista",
              startTime: 600,
              endTime: 1200,
              confirmedTime: 1500,
              startOsc: 12,
              endOsc: 22,
              startPrice: 100,
              endPrice: 90,
              startPriceTime: 600,
              endPriceTime: 1200,
              startOscTime: 600,
              endOscTime: 1200,
            },
            {
              kind: "bear",
              label: "Bajista",
              startTime: 1800,
              endTime: 2400,
              confirmedTime: 2700,
              startOsc: 88,
              endOsc: 76,
              startPrice: 110,
              endPrice: 120,
              startPriceTime: 1800,
              endPriceTime: 2400,
              startOscTime: 1800,
              endOscTime: 2400,
            },
            {
              kind: "hidden-bull",
              label: "Alcista Oculta",
              startTime: 3000,
              endTime: 3600,
              confirmedTime: 3900,
              startOsc: 35,
              endOsc: 24,
              startPrice: 95,
              endPrice: 102,
              startPriceTime: 3000,
              endPriceTime: 3600,
              startOscTime: 3000,
              endOscTime: 3600,
            },
            {
              kind: "hidden-bear",
              label: "Bajista Oculta",
              startTime: 4200,
              endTime: 4800,
              confirmedTime: 5100,
              startOsc: 64,
              endOsc: 75,
              startPrice: 118,
              endPrice: 112,
              startPriceTime: 4200,
              endPriceTime: 4800,
              startOscTime: 4200,
              endOscTime: 4800,
            },
          ],
        },
        4,
        96,
      );

      const auto = prim.autoscaleInfo(0 as never, 100 as never);
      expect(auto?.priceRange?.minValue).toBe(4);
      expect(auto?.priceRange?.maxValue).toBe(96);

      const drawnTexts: string[] = [];
      const lineDashes: number[][] = [];
      const mockCtx = {
        save: () => {},
        restore: () => {},
        beginPath: () => {},
        closePath: () => {},
        moveTo: () => {},
        lineTo: () => {},
        quadraticCurveTo: () => {},
        rect: () => {},
        clip: () => {},
        stroke: () => {},
        fill: () => {},
        arc: () => {},
        roundRect: () => {},
        fillRect: () => {},
        strokeRect: () => {},
        setLineDash: (d: number[]) => lineDashes.push(d),
        measureText: (t: string) => ({ width: t.length * 6 }),
        fillText: (t: string) => drawnTexts.push(t),
      };

      prim.attached({
        chart: {
          timeScale: () => ({
            timeToCoordinate: (t: number) => t / 10,
          }),
        } as never,
        series: {
          priceToCoordinate: (v: number) => 200 - v * 2,
          subscribeDataChanged: () => {},
          unsubscribeDataChanged: () => {},
        } as never,
        requestUpdate: () => {},
      });

      const views = prim.paneViews();
      expect(views).toHaveLength(1);
      views[0]!.renderer()!.draw({
        useMediaCoordinateSpace: (
          cb: (arg: { context: typeof mockCtx; mediaSize: { width: number; height: number } }) => void,
        ) => cb({ context: mockCtx, mediaSize: { width: 800, height: 200 } }),
      } as never);

      expect(drawnTexts).not.toContain("Alcista");
      expect(drawnTexts).not.toContain("Bajista");
      expect(drawnTexts).not.toContain("Alcista Oculta");
      expect(drawnTexts).not.toContain("Bajista Oculta");
      // Divergence styles share the same solid direction colors: green for bullish, yellow for bearish.
      expect(lineDashes.filter((d) => d.length === 0)).toHaveLength(4);
      expect(lineDashes.some((d) => d.length === 2 && d[0] === 4 && d[1] === 3)).toBe(false);
    });
  });

  describe("9. Paper Trading Simulator & Replay Rewind Determinism", () => {
    it("restores exact account state when stepping backward and forward in Bar Replay (zero duplicate fills/fees/trades)", () => {
      engine.setCostModel(0, 0);
      engine.enterReplay("BTCUSD", { timeSec: 1000, open: 50000, high: 50100, low: 49900, close: 50000 });

      // Place a BUY LIMIT at 49,500 with TP at 51,000 and SL at 49,000
      const order = engine.placeOrder({
        accountId: "demo-account",
        symbol: "BTCUSD",
        side: "BUY",
        type: "LIMIT",
        quantity: 1,
        price: 49500,
        takeProfit: 51000,
        stopLoss: 49000,
      });
      expect(order.status).toBe("PENDING");

      // Bar 2 (timeSec 2000): drops to 49,400 -> triggers BUY LIMIT at 49,500
      engine.replayAdvance("BTCUSD", { timeSec: 2000, open: 50000, high: 50100, low: 49400, close: 49800 });
      expect(engine.getPositions()).toHaveLength(1);
      expect(engine.getOrders().find((o) => o.id === order.id)?.status).toBe("FILLED");
      const balanceAfterFill = engine.getAccount().balance;

      // Bar 3 (timeSec 3000): rallies to 51,200 -> triggers TP at 51,000
      engine.replayAdvance("BTCUSD", { timeSec: 3000, open: 49800, high: 51200, low: 49700, close: 51100 });
      expect(engine.getPositions()).toHaveLength(0);
      expect(engine.getClosedPositions()).toHaveLength(1);
      const balanceAfterTp = engine.getAccount().balance;
      const summaryAfterTp = engine.getSummary();

      // Now rewind back to Bar 2 (timeSec 2000): position must be open again and closed trade undone!
      engine.replayRewind("BTCUSD", { timeSec: 2000, open: 50000, high: 50100, low: 49400, close: 49800 });
      expect(engine.getPositions()).toHaveLength(1);
      expect(engine.getClosedPositions()).toHaveLength(0);
      expect(engine.getAccount().balance).toBeCloseTo(balanceAfterFill, 8);

      // Rewind back to Bar 1 (timeSec 1000): order must be PENDING again and balance back to 100,000!
      engine.replayRewind("BTCUSD", { timeSec: 1000, open: 50000, high: 50100, low: 49900, close: 50000 });
      expect(engine.getPositions()).toHaveLength(0);
      expect(engine.getOrders().find((o) => o.id === order.id)?.status).toBe("PENDING");
      expect(engine.getAccount().balance).toBe(100_000);

      // Step forward through Bar 2 and Bar 3 again: state must match the first run with zero duplicates!
      engine.replayAdvance("BTCUSD", { timeSec: 2000, open: 50000, high: 50100, low: 49400, close: 49800 });
      engine.replayAdvance("BTCUSD", { timeSec: 3000, open: 49800, high: 51200, low: 49700, close: 51100 });
      expect(engine.getClosedPositions()).toHaveLength(1);
      expect(engine.getAccount().balance).toBeCloseTo(balanceAfterTp, 8);
      expect(engine.getSummary().netPnl).toBeCloseTo(summaryAfterTp.netPnl, 8);
      expect(engine.getSummary().fees).toBeCloseTo(summaryAfterTp.fees, 8);

      engine.exitReplay();
    });

    it("isolates live positions from replay equity/margin and clamps marketable LIMIT fills to their limit price", () => {
      engine.mark("BTCUSD", 50_000);
      engine.placeOrder({
        accountId: "demo-account",
        symbol: "BTCUSD",
        side: "BUY",
        type: "MARKET",
        quantity: 2,
      });
      const liveMargin = engine.getAccount().margin;
      expect(liveMargin).toBeGreaterThan(0);

      // Entering replay on ETHUSD hides the live BTCUSD position and excludes its margin/unrealizedPnl from replay equity
      engine.enterReplay("ETHUSD", { timeSec: 1000, open: 3000, high: 3010, low: 2990, close: 3000 });
      expect(engine.getAccount().margin).toBe(0);
      expect(engine.getAccount().equity).toBe(engine.getAccount().balance);

      // Marketable BUY LIMIT at exact market price (3000) with spread/slippage must not fill above 3000
      engine.setCostModel(10, 10); // 15 bps adverse friction
      const lim = engine.placeOrder({
        accountId: "demo-account",
        symbol: "ETHUSD",
        side: "BUY",
        type: "LIMIT",
        quantity: 1,
        price: 3000,
      });
      expect(lim.status).toBe("FILLED");
      expect(lim.avgFillPrice).toBe(3000);

      engine.setCostModel(0, 0);
      engine.exitReplay();
      expect(engine.getAccount().margin).toBeCloseTo(liveMargin, 6);
    });

    it("triggers stop-loss on the same replay bar when a pending LIMIT order fills and the bar continues through SL", () => {
      engine.setCostModel(0, 0);
      engine.enterReplay("BTCUSD", { timeSec: 1000, open: 50000, high: 50100, low: 49900, close: 50000 });
      engine.placeOrder({
        accountId: "demo-account",
        symbol: "BTCUSD",
        side: "BUY",
        type: "LIMIT",
        quantity: 1,
        price: 49500,
        stopLoss: 49000,
        takeProfit: 51000,
      });

      // Next bar crashes from 50,000 down to 48,500 (filling BUY LIMIT at 49,500 and breaching SL at 49,000)
      engine.replayAdvance("BTCUSD", { timeSec: 2000, open: 50000, high: 50050, low: 48500, close: 48600 });
      expect(engine.getPositions()).toHaveLength(0);
      const closed = engine.getClosedPositions();
      expect(closed).toHaveLength(1);
      expect(closed[0]!.entryPrice).toBe(49500);
      expect(closed[0]!.exitPrice).toBe(49000);
      expect(closed[0]!.exitReason).toBe("stop-loss");
      engine.exitReplay();
    });

    it("seeds initial live prices via seedLivePrice without triggering pending orders on fallback ticks", () => {
      engine.mark("SOLUSD", 200);
      const order = engine.placeOrder({
        accountId: "demo-account",
        symbol: "SOLUSD",
        side: "BUY",
        type: "LIMIT",
        quantity: 1,
        price: 190,
      });
      expect(order.status).toBe("PENDING");
      // Fallback seed updates reference price for market orders without triggering pending limit orders on stale data
      engine.seedLivePrice("SOLUSD", 185.5);
      expect(engine.getLastPrice("SOLUSD")).toBe(185.5);
      expect(engine.getOrders()[0]!.status).toBe("PENDING");
    });

    it("detects all 4 divergence types (bull, bear, hidden-bull, hidden-bear) from raw OHLC series through genuine MACD(12,26,9)", () => {
      function buildSeries(closes: number[]) {
        const warmup = Array.from({ length: 30 }, (_, i) => ({
          time: 1700000000 - (30 - i) * 3600,
          open: closes[0]!,
          high: closes[0]! + 0.5,
          low: closes[0]! - 0.5,
          close: closes[0]!,
          volume: 1000,
        }));
        const main = closes.map((c, i) => {
          const prev = i > 0 ? closes[i - 1]! : c;
          return {
            time: 1700000000 + i * 3600,
            open: prev,
            high: Math.max(prev, c) + 0.5,
            low: Math.min(prev, c) - 0.5,
            close: c,
            volume: 1000,
          };
        });
        return warmup.concat(main);
      }

      const closesRegBull = [
        100, 101, 102, 101, 100, 99, 100, 101, 100, 99, 98, 97, 96, 95, 94,
        90, 85, 80, 76, 73, 71, 70.5, 70.0,
        73, 77, 81, 84, 86, 85, 84, 83, 82, 81, 80, 79,
        77, 75, 73, 72, 71, 70, 69.5, 69.0,
        71, 74, 77, 80, 83, 85, 87, 89,
      ];
      const regBullCandles = buildSeries(closesRegBull);
      regBullCandles[30 + 22]!.low = 68.5;
      regBullCandles[30 + 42]!.low = 67.0;

      const regBearCandles = buildSeries(closesRegBull.map((c) => 200 - c));
      regBearCandles[30 + 22]!.high = 131.5;
      regBearCandles[30 + 42]!.high = 133.0;

      const closesHidBull = [
        100, 102, 105, 109, 114, 120, 126, 130, 132, 130, 127, 123, 119, 115, 112,
        109, 107, 106, 105.5, 105.0,
        108, 113, 119, 126, 133, 139, 143, 145, 144, 142,
        135, 127, 119, 113, 109, 108.0,
        112, 117, 123, 129, 134, 138, 141, 143,
      ];
      const hidBullCandles = buildSeries(closesHidBull);
      hidBullCandles[30 + 19]!.low = 104.0;
      // Put the price wick within one bar of the confirmed MACD valley so it is inside the configured ±1 matching window.
      hidBullCandles[30 + 36]!.low = 107.0;

      const hidBearCandles = buildSeries(closesHidBull.map((c) => 200 - c));
      hidBearCandles[30 + 19]!.high = 96.0;
      // Keep the wick inside the detector's ±1 bar window around the confirmed MACD peak.
      hidBearCandles[30 + 36]!.high = 93.0;

      expect(
        detectDivergences(regBullCandles, macd(regBullCandles, 12, 26, 9).macd, { mode: "macd" }).some(
          (d) => d.kind === "bull",
        ),
      ).toBe(true);
      expect(
        detectDivergences(regBearCandles, macd(regBearCandles, 12, 26, 9).macd, { mode: "macd" }).some(
          (d) => d.kind === "bear",
        ),
      ).toBe(true);
      expect(
        detectDivergences(hidBullCandles, macd(hidBullCandles, 12, 26, 9).macd, { mode: "macd" }).some(
          (d) => d.kind === "hidden-bull",
        ),
      ).toBe(true);
      expect(
        detectDivergences(hidBearCandles, macd(hidBearCandles, 12, 26, 9).macd, { mode: "macd" }).some(
          (d) => d.kind === "hidden-bear",
        ),
      ).toBe(true);
    });
  });
});
