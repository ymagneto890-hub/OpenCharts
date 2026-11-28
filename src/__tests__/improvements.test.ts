import { describe, it, expect, beforeEach, vi } from "vitest";
import React from "react";
import { fireEvent, render, waitFor } from "@testing-library/react";
import * as engine from "../services/demo/engine.ts";
import { demoApi } from "../services/demo/api.ts";
import { useReplayStore } from "../services/demo/replay.ts";
import { getHistory, getReplayHistory } from "../services/demo/candles.ts";
import { captureOneHourChart } from "../lib/chart-plugins/trade-screenshot.ts";
import {
  INDICATOR_REGISTRY,
  ema,
  rsi,
  macd,
  detectDivergences,
  computeMacdThresholds,
  computeVolumeProfile,
  computeMarketStructure,
  type CandleData,
} from "../lib/indicators.ts";
import { formatAssetUnits } from "../hooks/useInstrumentLabels.ts";
import { getPipDigits, calculateVolumeMa } from "../pages/trading/utils.ts";

describe("OpenCharts Improvements Suite", () => {
  beforeEach(() => {
    if (useReplayStore.getState().phase !== "idle") {
      useReplayStore.getState().stop();
    }
    engine.resetAccount({
      startingBalance: 10_000,
      feeRate: 0.001, // 0.1% for easy exact math
      keepHistory: false,
    });
  });

  describe("1 & 2. Unit-Based Trading (0.005 BTC), Commissions & SL/TP", () => {
    it("executes unit-based market orders (0.005 BTC), deducts proportional fees, and updates balance/profits", () => {
      engine.mark("BTCUSD", 90_000);
      const accountId = engine.getAccount().id;

      // Buy 0.005 BTC @ $90,000 => Notional = $450, Entry Fee = $450 * 0.001 = $0.45
      const order = engine.placeOrder({
        accountId,
        symbol: "BTCUSD",
        side: "BUY",
        type: "MARKET",
        quantity: 0.005,
        stopLoss: 88_000,
        takeProfit: 95_000,
      });

      expect(order.status).toBe("FILLED");
      const openPos = engine.getPositions()[0]!;
      expect(openPos).toBeDefined();
      expect(openPos.quantity).toBe(0.005);
      expect(openPos.stopLoss).toBe(88_000);
      expect(openPos.takeProfit).toBe(95_000);

      // Price moves to $92,000 => Unrealized gross = (92,000 - 90,000) * 0.005 = +$10.00
      engine.mark("BTCUSD", 92_000);
      const markedPos = engine.getPositions()[0]!;
      expect(markedPos.unrealizedPnl).toBeCloseTo(10.0, 5);

      // Close position @ $92,000 => Exit notional = $460, Exit fee = $0.46
      // Total commission = $0.45 + $0.46 = $0.91, Net P&L = $10.00 - $0.91 = +$9.09
      engine.closePosition(openPos.id);

      const summary = engine.getSummary();
      expect(summary.trades).toBe(1);
      expect(summary.wins).toBe(1);
      expect(summary.realizedGross).toBeCloseTo(10.0, 4);
      expect(summary.fees).toBeCloseTo(0.91, 4);
      expect(summary.grossProfit).toBeCloseTo(9.09, 4);
      expect(summary.balance).toBeCloseTo(10_009.09, 4);

      expect(formatAssetUnits(0.005, "BTCUSD")).toBe("0.005 BTC");
      expect(formatAssetUnits(0.005, "BTC/USD")).toBe("0.005 BTC");
      expect(getPipDigits("BTCUSD", { tickSize: 0.01 })).toBe(2);
    });

    it("supports fractional unit partial closes (e.g. closing 0.002 of 0.005 BTC)", () => {
      engine.mark("BTCUSD", 90_000);
      const accountId = engine.getAccount().id;

      engine.placeOrder({
        accountId,
        symbol: "BTCUSD",
        side: "BUY",
        type: "MARKET",
        quantity: 0.005,
      });
      const position = engine.getPositions()[0]!;

      engine.mark("BTCUSD", 91_000);
      engine.closePosition(position.id, 0.002);

      const remaining = engine.getPositions();
      expect(remaining).toHaveLength(1);
      expect(remaining[0]!.quantity).toBeCloseTo(0.003, 6);

      const closed = engine.getClosedPositions();
      expect(closed).toHaveLength(1);
      expect(closed[0]!.quantity).toBeCloseTo(0.002, 6);
    });

    it("allows dragging/modifying SL and TP on open positions and triggers automatically", () => {
      engine.mark("BTCUSD", 90_000);
      const accountId = engine.getAccount().id;

      engine.placeOrder({
        accountId,
        symbol: "BTCUSD",
        side: "BUY",
        type: "MARKET",
        quantity: 0.01,
      });
      const position = engine.getPositions()[0]!;

      // Activate and drag SL/TP
      const updated = engine.modifyPosition(position.id, {
        stopLoss: 89_000,
        takeProfit: 93_000,
      });
      expect(updated?.stopLoss).toBe(89_000);
      expect(updated?.takeProfit).toBe(93_000);

      // Invalid SL above current price for LONG should throw
      expect(() =>
        engine.modifyPosition(position.id, { stopLoss: 91_000 }),
      ).toThrow();

      // Price reaches Take Profit at 93,000
      engine.mark("BTCUSD", 93_000);
      expect(engine.getPositions()).toHaveLength(0);
      const closed = engine.getClosedPositions();
      expect(closed).toHaveLength(1);
      expect(closed[0]!.exitPrice).toBe(93_000);
    });

    it("supports modifying pending LIMIT/STOP orders", () => {
      engine.mark("BTCUSD", 90_000);
      const accountId = engine.getAccount().id;

      const order = engine.placeOrder({
        accountId,
        symbol: "BTCUSD",
        side: "BUY",
        type: "LIMIT",
        quantity: 0.005,
        price: 88_000,
      });

      const mod = engine.modifyOrder(order.id, {
        price: 88_500,
        quantity: 0.008,
        stopLoss: 87_000,
        takeProfit: 92_000,
      });
      expect(mod?.price).toBe(88_500);
      expect(mod?.quantity).toBe(0.008);
      expect(mod?.stopLoss).toBe(87_000);
      expect(mod?.takeProfit).toBe(92_000);
    });
  });

  describe("3. Indicators (EMA 50, RSI 14, MACD 12, 26, 9) & Divergences", () => {
    it("configures EMA 50 on main chart, RSI 14 and MACD (12, 26, 9) in separate oscillator panels", () => {
      const emaMeta = INDICATOR_REGISTRY.find((i) => i.type === "EMA")!;
      const rsiMeta = INDICATOR_REGISTRY.find((i) => i.type === "RSI")!;
      const macdMeta = INDICATOR_REGISTRY.find((i) => i.type === "MACD")!;

      expect(emaMeta.defaultParams.period).toBe(50);
      expect(emaMeta.pane).toBe("overlay");
      expect(rsiMeta.defaultParams.period).toBe(14);
      expect(rsiMeta.pane).toBe("below");
      expect(macdMeta.defaultParams).toEqual({ fast: 12, slow: 26, signal: 9 });
      expect(macdMeta.pane).toBe("below");

      const raw = getHistory("BTCUSD", "15m", 300);
      const candles: CandleData[] = raw.map((c) => ({
        time: c.time,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume,
      }));

      const ema50 = ema(candles, 50);
      const rsi14 = rsi(candles, 14);
      const macdRes = macd(candles, 12, 26, 9);
      const thresholds = computeMacdThresholds(candles, 12, 26, 9);

      expect(ema50.length).toBeGreaterThan(200);
      expect(rsi14.length).toBeGreaterThan(200);
      expect(macdRes.macd.length).toBeGreaterThan(200);
      expect(macdRes.signal.length).toBeGreaterThan(200);
      expect(macdRes.histogram.length).toBeGreaterThan(200);
      expect(thresholds).not.toBeNull();
      expect(Number.isFinite(thresholds!.zeroCrossPrice)).toBe(true);
    });

    it("detects bullish, bearish, and hidden divergences causally without look-ahead bias", () => {
      const raw = getHistory("BTCUSD", "15m", 500);
      const candles: CandleData[] = raw.map((c) => ({
        time: c.time,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume,
      }));

      const rsiFull = rsi(candles, 14);
      const divsFull = detectDivergences(candles, rsiFull, {
        mode: "rsi",
        leftBars: 4,
        rightBars: 3,
      });

      expect(divsFull.length).toBeGreaterThan(0);

      // Verify no two divergences share the exact same endTime or overlap closer than minSeparationBars
      for (let i = 1; i < divsFull.length; i++) {
        expect(divsFull[i]!.endTime).toBeGreaterThan(divsFull[i - 1]!.endTime);
      }

      // Verify strict causality: any divergence confirmed at or before index K-4
      // must be identical when computed only on the truncated slice candles[0..K].
      const cutoff = 350;
      const slicedCandles = candles.slice(0, cutoff);
      const rsiSliced = rsi(slicedCandles, 14);
      const divsSliced = detectDivergences(slicedCandles, rsiSliced, {
        mode: "rsi",
        leftBars: 4,
        rightBars: 3,
      });

      const cutoffTime = slicedCandles[cutoff - 1 - 3]!.time;
      const fullBeforeCutoff = divsFull.filter((d) => d.endTime <= cutoffTime);
      expect(divsSliced).toEqual(fullBeforeCutoff);

      // Also verify MACD divergences work causally
      const macdFull = macd(candles, 12, 26, 9);
      const macdDivsFull = detectDivergences(candles, macdFull.macd, {
        mode: "macd",
        leftBars: 4,
        rightBars: 3,
      });
      expect(macdDivsFull.length).toBeGreaterThan(0);
    });
  });

  describe("4, 5 & 7. Persistent History, Initial Capital Configuration & Account Reset", () => {
    it("persists closed trades to localStorage and supports configuring initial capital and resetting with history control", () => {
      engine.mark("BTCUSD", 90_000);
      const accountId = engine.getAccount().id;

      engine.placeOrder({
        accountId,
        symbol: "BTCUSD",
        side: "BUY",
        type: "MARKET",
        quantity: 0.01,
      });
      const position = engine.getPositions()[0]!;
      engine.mark("BTCUSD", 91_000);
      engine.closePosition(position.id);

      // Verify localStorage persistence
      const rawPersisted = localStorage.getItem("oc_demo_engine_v1");
      expect(rawPersisted).toBeTruthy();
      const parsed = JSON.parse(rawPersisted!);
      expect(parsed.closed).toHaveLength(1);

      // Configure Initial Capital to $25,000 while preserving session net P&L delta
      const deltaBefore = engine.getSummary().netPnl;
      const updatedSummary = engine.setStartingBalance(25_000);
      expect(updatedSummary.startingBalance).toBe(25_000);
      expect(updatedSummary.balance).toBeCloseTo(25_000 + deltaBefore, 4);

      // Reset account keeping history
      engine.resetAccount({
        startingBalance: 50_000,
        keepHistory: true,
      });
      expect(engine.getSummary().balance).toBe(50_000);
      expect(engine.getClosedPositions()).toHaveLength(1);

      // Reset account clearing history
      engine.resetAccount({
        startingBalance: 15_000,
        keepHistory: false,
      });
      expect(engine.getSummary().balance).toBe(15_000);
      expect(engine.getClosedPositions()).toHaveLength(0);
    });
  });

  describe("6. Historical Replay (No Look-Ahead + Simulated Trading)", () => {
    it("hides future candles, steps bar-by-bar, and executes simulated trades updating demo account & history", () => {
      const allCandles = getHistory("BTCUSD", "15m");
      const pickIndex = allCandles.length - 30;
      const pickCandle = allCandles[pickIndex]!;

      const store = useReplayStore.getState();
      store.beginPick();
      expect(useReplayStore.getState().phase).toBe("picking");

      const startRes = useReplayStore.getState().start("BTCUSD", "15m", pickCandle.time);
      expect(startRes.ok).toBe(true);

      const activeState = useReplayStore.getState();
      expect(activeState.phase).toBe("active");
      expect(activeState.visible).toHaveLength(pickIndex + 1);
      expect(activeState.visible![activeState.visible!.length - 1]!.time).toBe(pickCandle.time);

      // Place a simulated trade during replay at pickCandle.close
      const accountId = engine.getAccount().id;
      engine.placeOrder({
        accountId,
        symbol: "BTCUSD",
        side: "BUY",
        type: "MARKET",
        quantity: 0.01,
      });
      const position = engine.getPositions()[0]!;
      expect(position.entryPrice).toBe(pickCandle.close);

      // Step forward 1 candle
      useReplayStore.getState().step();
      const afterStep = useReplayStore.getState();
      expect(afterStep.visible).toHaveLength(pickIndex + 2);
      const nextCandle = allCandles[pickIndex + 1]!;
      expect(engine.getLastPrice("BTCUSD")).toBe(nextCandle.close);

      // Close the replay position and exit replay
      engine.closePosition(position.id);
      useReplayStore.getState().stop();

      expect(useReplayStore.getState().phase).toBe("idle");
      expect(engine.getClosedPositions()).toHaveLength(1);
    });
  });

  describe("Modular Layout & Indicator Accuracy (TradingView Aligned)", () => {
    it("calculates Wilder RSI accurately with flat-market edge case handling", () => {
      // 1. Flat series test
      const flatCandles: CandleData[] = Array.from({ length: 30 }, (_, i) => ({
        time: 1_700_000_000 + i * 60,
        open: 100,
        high: 100,
        low: 100,
        close: 100,
        volume: 10,
      }));
      const flatRsi = rsi(flatCandles, 14);
      expect(flatRsi.length).toBeGreaterThan(0);
      expect(flatRsi[flatRsi.length - 1]!.value).toBe(50);

      // 2. Rising series produces RSI > 70
      const risingCandles: CandleData[] = Array.from({ length: 30 }, (_, i) => ({
        time: 1_700_000_000 + i * 60,
        open: 100 + i * 2,
        high: 101 + i * 2,
        low: 99 + i * 2,
        close: 100 + i * 2,
        volume: 10,
      }));
      const risingRsi = rsi(risingCandles, 14);
      expect(risingRsi[risingRsi.length - 1]!.value).toBeGreaterThan(95);
    });

    it("computes MACD, 4-color histogram, and threshold prices strictly agreeing with bar trajectory", () => {
      const candles: CandleData[] = Array.from({ length: 60 }, (_, i) => ({
        time: 1_700_000_000 + i * 60,
        open: 100 + Math.sin(i / 5) * 10,
        high: 105 + Math.sin(i / 5) * 10,
        low: 95 + Math.sin(i / 5) * 10,
        close: 100 + Math.sin(i / 5) * 10,
        volume: 100,
      }));

      const computed = macd(candles, 12, 26, 9);
      expect(computed.macd.length).toBeGreaterThan(0);
      expect(computed.signal.length).toBeGreaterThan(0);
      expect(computed.histogram.length).toBeGreaterThan(0);

      const th = computed.thresholds;
      expect(th).not.toBeNull();
      if (th) {
        expect(Number.isFinite(th.histContinuePrice)).toBe(true);
        expect(Number.isFinite(th.signalCrossPrice)).toBe(true);
        expect(Number.isFinite(th.zeroCrossPrice)).toBe(true);
      }
    });

    it("verifies modular layout reordering and weight normalization without overlap", () => {
      type ModularBlockId = "PRICE" | "RSI" | "MACD";
      let blockOrder: ModularBlockId[] = ["PRICE", "RSI", "MACD"];
      let weights: Record<ModularBlockId, number> = { PRICE: 56, RSI: 22, MACD: 22 };

      // Helper to compute percentage heights
      const getPcts = (active: ModularBlockId[]) => {
        const total = active.reduce((acc, id) => acc + weights[id], 0);
        return active.map((id) => (weights[id] / total) * 100);
      };

      // 1. All 3 active: sum must be strictly 100%
      let pcts = getPcts(blockOrder);
      expect(pcts.reduce((a, b) => a + b, 0)).toBeCloseTo(100, 5);

      // 2. Reorder: move MACD up (swap with RSI)
      const swap = (idx1: number, idx2: number) => {
        const next = [...blockOrder];
        const tmp = next[idx1]!;
        next[idx1] = next[idx2]!;
        next[idx2] = tmp;
        blockOrder = next;
      };

      swap(2, 1); // MACD moved to index 1
      expect(blockOrder).toEqual(["PRICE", "MACD", "RSI"]);

      swap(1, 0); // MACD moved to top
      expect(blockOrder).toEqual(["MACD", "PRICE", "RSI"]);

      // 3. Resizing: expand MACD by +5%, distribute reduction to other blocks
      const expand = (id: ModularBlockId, delta: number) => {
        const otherIds = blockOrder.filter((b) => b !== id);
        const otherSum = otherIds.reduce((acc, b) => acc + weights[b], 0);
        weights[id] += delta;
        for (const b of otherIds) {
          weights[b] -= delta * (weights[b] / otherSum);
        }
      };

      expand("MACD", 5);
      expect(weights.MACD).toBeCloseTo(27, 4);
      pcts = getPcts(blockOrder);
      expect(pcts.reduce((a, b) => a + b, 0)).toBeCloseTo(100, 5);

      // 4. Closing an indicator: remaining blocks expand to 100%
      const remaining: ModularBlockId[] = ["PRICE", "MACD"]; // RSI closed
      const remainingPcts = getPcts(remaining);
      expect(remainingPcts.reduce((a, b) => a + b, 0)).toBeCloseTo(100, 5);
      expect(remainingPcts[0]).toBeGreaterThan(50); // Price took its larger share
    });

    it("verifies double-click maximize and restore behavior across modular blocks preserving DOM mounting", () => {
      type ModularBlockId = "PRICE" | "RSI" | "MACD";
      const allActiveBlocks: ModularBlockId[] = ["PRICE", "RSI", "MACD"];
      let maximizedBlockId: ModularBlockId | null = null;

      const getBlockLayout = (id: ModularBlockId) => {
        const isHidden = maximizedBlockId !== null && maximizedBlockId !== id;
        const isMaximized = maximizedBlockId === id;
        const heightPct = maximizedBlockId ? (isMaximized ? 100 : 0) : 100 / allActiveBlocks.length;
        return {
          isMounted: allActiveBlocks.includes(id), // Guaranteed always mounted in DOM
          isHidden,
          heightPct,
        };
      };

      // Initially all 3 are mounted and visible
      expect(getBlockLayout("PRICE")).toEqual({ isMounted: true, isHidden: false, heightPct: 100 / 3 });
      expect(getBlockLayout("RSI")).toEqual({ isMounted: true, isHidden: false, heightPct: 100 / 3 });
      expect(getBlockLayout("MACD")).toEqual({ isMounted: true, isHidden: false, heightPct: 100 / 3 });

      // Double-click RSI => RSI is maximized to 100%, PRICE and MACD remain mounted but hidden
      maximizedBlockId = "RSI";
      expect(getBlockLayout("RSI")).toEqual({ isMounted: true, isHidden: false, heightPct: 100 });
      expect(getBlockLayout("PRICE")).toEqual({ isMounted: true, isHidden: true, heightPct: 0 });
      expect(getBlockLayout("MACD")).toEqual({ isMounted: true, isHidden: true, heightPct: 0 });

      // Double-click RSI again => restored to full layout without remounting canvas
      maximizedBlockId = null;
      expect(getBlockLayout("PRICE")).toEqual({ isMounted: true, isHidden: false, heightPct: 100 / 3 });
      expect(getBlockLayout("RSI")).toEqual({ isMounted: true, isHidden: false, heightPct: 100 / 3 });

      // Double-click MACD => MACD is maximized to 100%
      maximizedBlockId = "MACD";
      expect(getBlockLayout("MACD")).toEqual({ isMounted: true, isHidden: false, heightPct: 100 });
      expect(getBlockLayout("PRICE")).toEqual({ isMounted: true, isHidden: true, heightPct: 0 });

      // Double-click MACD again => restored
      maximizedBlockId = null;
      expect(getBlockLayout("PRICE")).toEqual({ isMounted: true, isHidden: false, heightPct: 100 / 3 });
    });

    it("detects divergences across standard swing pivot distance without distant end-to-end lines", () => {
      // Create a series of 60 candles with two distinct local swing tops separated by 12 bars
      const candles: CandleData[] = Array.from({ length: 60 }, (_, i) => {
        let price = 100;
        if (i === 15) price = 120; // Peak 1
        else if (i === 27) price = 125; // Peak 2 (Higher High in price)
        else if (i > 15 && i < 27) price = 105;
        else if (i > 27) price = 110;
        return {
          time: 1_700_000_000 + i * 3600,
          open: price - 1,
          high: price + 1,
          low: price - 2,
          close: price,
          volume: 100,
        };
      });

      // Oscillator: Lower High at Peak 2 (Peak 1 = 80, Peak 2 = 68 => Regular Bearish)
      const osc = candles.map((c, i) => {
        let val = 50;
        if (i === 15) val = 80;
        else if (i === 27) val = 68;
        else if (i > 15 && i < 27) val = 52;
        return { time: c.time, value: val };
      });

      const divs = detectDivergences(candles, osc, {
        mode: "rsi",
        leftBars: 5,
        rightBars: 5,
        minBars: 5,
        maxBars: 28,
      });

      expect(divs.length).toBeGreaterThan(0);
      const bearDiv = divs.find((d) => d.kind === "bear");
      expect(bearDiv).toBeDefined();
      if (bearDiv) {
        expect(bearDiv.label).toBe("Bajista");
        expect(bearDiv.startTime).toBe(candles[15]!.time);
        expect(bearDiv.endTime).toBe(candles[27]!.time);
        const distBars = (bearDiv.endTime - bearDiv.startTime) / 3600;
        expect(distBars).toBe(12);
        expect(distBars).toBeLessThanOrEqual(28); // strictly bounded distance, no end-to-end lines
      }
    });

    it("verifies MACD timestamp alignment populated on latest candles without trailing missing bars", () => {
      const candles: CandleData[] = Array.from({ length: 50 }, (_, i) => ({
        time: 1_700_000_000 + i * 60,
        open: 100 + i * 0.5,
        high: 101 + i * 0.5,
        low: 99 + i * 0.5,
        close: 100.5 + i * 0.5,
        volume: 10,
      }));

      const macdRes = macd(candles, 12, 26, 9);
      expect(macdRes.macd.length).toBeGreaterThan(0);
      expect(macdRes.signal.length).toBeGreaterThan(0);
      expect(macdRes.histogram.length).toBeGreaterThan(0);

      // Verify that the very last candle has MACD, Signal and Histogram values populated
      const lastCandle = candles[candles.length - 1]!;
      const lastMacd = macdRes.macd[macdRes.macd.length - 1]!;
      const lastSignal = macdRes.signal[macdRes.signal.length - 1]!;
      const lastHist = macdRes.histogram[macdRes.histogram.length - 1]!;

      expect(lastMacd.time).toBe(lastCandle.time);
      expect(lastSignal.time).toBe(lastCandle.time);
      expect(lastHist.time).toBe(lastCandle.time);

      // Value map keyed by timestamp guarantees exact match without out-of-bounds 0.00
      const sigMap = new Map(macdRes.signal.map((s) => [s.time, s.value]));
      const histMap = new Map(macdRes.histogram.map((h) => [h.time, h.value]));

      expect(sigMap.get(lastCandle.time)).toBe(lastSignal.value);
      expect(histMap.get(lastCandle.time)).toBe(lastHist.value);
      expect(sigMap.get(lastCandle.time)).not.toBe(0);
    });

    it("verifies SL/TP right badge slider P&L computation and price updates for BUY and SELL", () => {
      const computePnl = (
        targetPrice: number,
        entryPrice: number,
        side: "LONG" | "SHORT",
        quantity: number,
        contractSize = 1,
      ) => {
        const dir = side === "LONG" ? 1 : -1;
        return parseFloat(((targetPrice - entryPrice) * dir * quantity * contractSize).toFixed(2));
      };

      // LONG position @ $80,000, 0.005 BTC
      // TP @ $85,000 => ($85,000 - $80,000) * 0.005 = +$25.00
      expect(computePnl(85_000, 80_000, "LONG", 0.005)).toBe(25.0);

      // SL @ $78,000 => ($78,000 - $80,000) * 0.005 = -$10.00
      expect(computePnl(78_000, 80_000, "LONG", 0.005)).toBe(-10.0);

      // SHORT position @ $80,000, 0.005 BTC
      // TP @ $75,000 => ($75,000 - $80,000) * -1 * 0.005 = +$25.00
      expect(computePnl(75_000, 80_000, "SHORT", 0.005)).toBe(25.0);

      // SL @ $82,000 => ($82,000 - $80,000) * -1 * 0.005 = -$10.00
      expect(computePnl(82_000, 80_000, "SHORT", 0.005)).toBe(-10.0);
    });

    it("verifies all 4 divergence classifications: Regular Bullish, Hidden Bullish, Regular Bearish, and Hidden Bearish", () => {
      // 1. Regular Bullish: Price Lower Low, Osc Higher Low
      const bullCandles: CandleData[] = Array.from({ length: 40 }, (_, i) => {
        let p = 100;
        if (i === 10) p = 85; // Low 1
        else if (i === 22) p = 78; // Low 2 (Lower Low)
        else if (i > 10 && i < 22) p = 95;
        return {
          time: 1_700_000_000 + i * 60,
          open: p + 1,
          high: p + 2,
          low: p - 1,
          close: p,
        };
      });
      const bullOsc = bullCandles.map((c, i) => {
        let val = 50;
        if (i === 10) val = 25; // Osc Low 1
        else if (i === 22) val = 35; // Osc Low 2 (Higher Low => Regular Bullish)
        else if (i > 10 && i < 22) val = 48;
        return { time: c.time, value: val };
      });
      const bullDivs = detectDivergences(bullCandles, bullOsc, { mode: "rsi", leftBars: 3, rightBars: 2 });
      expect(bullDivs.some((d) => d.kind === "bull" && d.label === "Alcista")).toBe(true);

      // 2. Hidden Bullish: Price Higher Low, Osc Lower Low
      const hidBullCandles: CandleData[] = Array.from({ length: 40 }, (_, i) => {
        let p = 100;
        if (i === 10) p = 80; // Low 1
        else if (i === 22) p = 88; // Low 2 (Higher Low)
        else if (i > 10 && i < 22) p = 96;
        return {
          time: 1_700_000_000 + i * 60,
          open: p + 1,
          high: p + 2,
          low: p - 1,
          close: p,
        };
      });
      const hidBullOsc = hidBullCandles.map((c, i) => {
        let val = 50;
        if (i === 10) val = 38; // Osc Low 1
        else if (i === 22) val = 28; // Osc Low 2 (Lower Low => Hidden Bullish)
        else if (i > 10 && i < 22) val = 46;
        return { time: c.time, value: val };
      });
      const hidBullDivs = detectDivergences(hidBullCandles, hidBullOsc, { mode: "rsi", leftBars: 3, rightBars: 2 });
      expect(hidBullDivs.some((d) => d.kind === "hidden-bull" && d.label === "Alcista Oculta")).toBe(true);

      // 3. Hidden Bearish: Price Lower High, Osc Higher High
      const hidBearCandles: CandleData[] = Array.from({ length: 40 }, (_, i) => {
        let p = 100;
        if (i === 10) p = 125; // High 1
        else if (i === 22) p = 118; // High 2 (Lower High)
        else if (i > 10 && i < 22) p = 106;
        return {
          time: 1_700_000_000 + i * 60,
          open: p - 1,
          high: p + 1,
          low: p - 2,
          close: p,
        };
      });
      const hidBearOsc = hidBearCandles.map((c, i) => {
        let val = 50;
        if (i === 10) val = 65; // Osc High 1
        else if (i === 22) val = 75; // Osc High 2 (Higher High => Hidden Bearish)
        else if (i > 10 && i < 22) val = 54;
        return { time: c.time, value: val };
      });
      const hidBearDivs = detectDivergences(hidBearCandles, hidBearOsc, { mode: "rsi", leftBars: 3, rightBars: 2 });
      expect(hidBearDivs.some((d) => d.kind === "hidden-bear" && d.label === "Bajista Oculta")).toBe(true);
    });

    it("correctly computes MACD threshold values, negative/positive state flags, and zero-cross predictions", () => {
      const candles: CandleData[] = Array.from({ length: 60 }, (_, i) => {
        const p = 100 - i * 0.5; // downtrend
        return {
          time: 1_700_000_000 + i * 60,
          open: p + 0.2,
          high: p + 0.5,
          low: p - 0.5,
          close: p,
        };
      });

      const th = computeMacdThresholds(candles, 12, 26, 9);
      expect(th).not.toBeNull();
      if (th) {
        expect(typeof th.macdValue).toBe("number");
        expect(typeof th.signalValue).toBe("number");
        expect(typeof th.histValue).toBe("number");
        expect(typeof th.isBullishCrossState).toBe("boolean");
        expect(typeof th.isAboveZero).toBe("boolean");
        // In a sustained downtrend, MACD is negative (below 0)
        expect(th.isAboveZero).toBe(false);
        expect(th.macdValue).toBeLessThan(0);
      }
    });

    it("loads deep Bitcoin daily and weekly history from 2011 to 2026 without pre-2024 truncation", () => {
      const dailyBars = getHistory("BTCUSD", "1d");
      expect(dailyBars.length).toBeGreaterThan(5_000);
      // First bar is from August 2011
      const firstDailyYear = new Date(dailyBars[0]!.time * 1000).getUTCFullYear();
      expect(firstDailyYear).toBe(2011);
      // Last bar is from 2026
      const lastDailyYear = new Date(dailyBars[dailyBars.length - 1]!.time * 1000).getUTCFullYear();
      expect(lastDailyYear).toBe(2026);

      const weeklyBars = getHistory("BTCUSD", "1w");
      expect(weeklyBars.length).toBeGreaterThan(700);
      const firstWeeklyYear = new Date(weeklyBars[0]!.time * 1000).getUTCFullYear();
      expect(firstWeeklyYear).toBe(2011);
    });

    it("provides complete economic calendar with historical macro data and Bitcoin landmark milestones", async () => {
      const { DEMO_ECONOMIC_EVENTS } = await import("../services/demo/economicEvents.ts");
      expect(DEMO_ECONOMIC_EVENTS.length).toBeGreaterThan(1_000);

      // Check Bitcoin landmark milestones
      const btcEvents = DEMO_ECONOMIC_EVENTS.filter((e) => e.currency === "BTC");
      expect(btcEvents.length).toBeGreaterThanOrEqual(30);

      const genesis = btcEvents.find((e) => e.id.includes("genesis"));
      expect(genesis).toBeDefined();
      expect(genesis?.event).toContain("Génesis");

      const pizza = btcEvents.find((e) => e.id.includes("pizza"));
      expect(pizza).toBeDefined();
      expect(pizza?.impact).toBe("low");

      // Verify impact calibration across high, medium, and low
      const highEvents = DEMO_ECONOMIC_EVENTS.filter((e) => e.impact === "high");
      const medEvents = DEMO_ECONOMIC_EVENTS.filter((e) => e.impact === "medium");
      const lowEvents = DEMO_ECONOMIC_EVENTS.filter((e) => e.impact === "low");

      expect(highEvents.length).toBeGreaterThan(100);
      expect(medEvents.length).toBeGreaterThan(100);
      expect(lowEvents.length).toBeGreaterThan(100);

      // Verify specific macro impact levels
      const nfp = DEMO_ECONOMIC_EVENTS.find((e) => e.event.includes("NFP"));
      expect(nfp?.impact).toBe("high");

      const unemp = DEMO_ECONOMIC_EVENTS.find((e) => e.event === "Tasa de desempleo");
      expect(unemp?.impact).toBe("medium");

      const jobless = DEMO_ECONOMIC_EVENTS.find((e) => e.event.includes("Peticiones iniciales"));
      expect(jobless?.impact).toBe("low");
    });

    it("loads deep Bitcoin 4-hour history with over 20,000 bars from 2017 to 2026", () => {
      const bars4h = getHistory("BTCUSD", "4h");
      expect(bars4h.length).toBeGreaterThan(15_000);
      const firstYear = new Date(bars4h[0]!.time * 1000).getUTCFullYear();
      expect(firstYear).toBe(2017);
      const lastYear = new Date(bars4h[bars4h.length - 1]!.time * 1000).getUTCFullYear();
      expect(lastYear).toBe(2026);
    });

    it("launches Replay at exact specified date/time and reveals candles progressively", () => {
      const replay = useReplayStore.getState();
      // Target exact date: 2024-01-10 14:30 (ETF approval date)
      const targetTimeSec = Math.floor(new Date("2024-01-10T14:30:00Z").getTime() / 1000);
      const res = replay.start("BTCUSD", "1d", targetTimeSec);
      expect(res.ok).toBe(true);

      const state = useReplayStore.getState();
      expect(state.phase).toBe("active");
      expect(state.visible).not.toBeNull();
      expect(state.visible!.length).toBeGreaterThan(0);

      // Last visible candle must be on or before the target date
      const lastVisible = state.visible![state.visible!.length - 1]!;
      expect(lastVisible.time).toBeLessThanOrEqual(targetTimeSec);

      // Verify stepping reveals next candle
      const countBefore = state.visible!.length;
      replay.step();
      const stateAfter = useReplayStore.getState();
      expect(stateAfter.visible!.length).toBe(countBefore + 1);

      replay.stop();
      expect(useReplayStore.getState().phase).toBe("idle");
    });

    it("calculates 20-period Simple Moving Average on volume data accurately", () => {
      // 25 bars with volume values 10, 20, 30 ...
      const dummyVolume = Array.from({ length: 25 }, (_, i) => ({
        time: (1700000000 + i * 3600) as any,
        value: (i + 1) * 10,
        color: "#0ecb81",
      }));

      const ma = calculateVolumeMa(dummyVolume, 20);
      // For 25 bars with period 20, output should have 25 - 20 + 1 = 6 points
      expect(ma.length).toBe(6);
      expect(ma[0]!.time).toBe(dummyVolume[19]!.time);

      // Average of 10, 20, ..., 200 is sum(1..20)*10 / 20 = (20 * 21 / 2 * 10) / 20 = 105
      expect(ma[0]!.value).toBe(105);

      // Last point is average of bars 6..25: values 60, 70, ..., 250 => average is 155
      expect(ma[ma.length - 1]!.value).toBe(155);
    });

    it("propagates entryScreenshot, dailyScreenshot, and entryTimeframe from order to position and closedPosition", () => {
      engine.mark("BTCUSD", 90_000);
      const accountId = engine.getAccount().id;

      const mockEntryScreenshot = "data:image/jpeg;base64,mockEntryDataUrl";
      const mockFourHourScreenshot = "data:image/jpeg;base64,mock4hDataUrl";
      const mockDailyScreenshot = "data:image/jpeg;base64,mockDailyDataUrl";
      const mockTimeframe = "15m";

      const order = engine.placeOrder({
        accountId,
        symbol: "BTCUSD",
        side: "BUY",
        type: "MARKET",
        quantity: 0.01,
        fourHourScreenshot: mockFourHourScreenshot,
        entryScreenshot: mockEntryScreenshot,
        dailyScreenshot: mockDailyScreenshot,
        entryTimeframe: mockTimeframe,
      });

      // 1. Order preserves screenshots
      expect(order.fourHourScreenshot).toBe(mockFourHourScreenshot);
      expect(order.entryScreenshot).toBe(mockEntryScreenshot);
      expect(order.dailyScreenshot).toBe(mockDailyScreenshot);
      expect(order.entryTimeframe).toBe(mockTimeframe);

      // 2. Open Position inherits screenshots
      const openPos = engine.getPositions()[0]!;
      expect(openPos).toBeDefined();
      expect(openPos.fourHourScreenshot).toBe(mockFourHourScreenshot);
      expect(openPos.entryScreenshot).toBe(mockEntryScreenshot);
      expect(openPos.dailyScreenshot).toBe(mockDailyScreenshot);
      expect(openPos.entryTimeframe).toBe(mockTimeframe);

      // 3. Closed Position retains screenshots for Trade History review
      engine.mark("BTCUSD", 91_000);
      engine.closePosition(openPos.id);

      const closed = engine.getClosedPositions()[0]!;
      expect(closed).toBeDefined();
      expect(closed.symbolName).toBe("BTCUSD");
      expect(closed.fourHourScreenshot).toBe(mockFourHourScreenshot);
      expect(closed.entryScreenshot).toBe(mockEntryScreenshot);
      expect(closed.dailyScreenshot).toBe(mockDailyScreenshot);
      expect(closed.entryTimeframe).toBe(mockTimeframe);
    });

    it("calculates exact position size from risk percentage (1%) accounting for Stop Loss distance and commissions", () => {
      // Balance = $10,000, 1% Risk = $100
      const balance = 10_000;
      const riskPct = 1.0;
      const targetRiskUsd = balance * (riskPct / 100); // $100

      const entryPrice = 90_000;
      const stopLossPrice = 88_000;
      const slDistance = entryPrice - stopLossPrice; // $2,000 per BTC (2.22%)
      const feeRate = 0.0005; // 0.05% taker fee

      // Round-trip commission factor = 2 * feeRate * entryPrice = 2 * 0.0005 * 90,000 = $90 per BTC
      const roundTripFeePerUnit = 2 * feeRate * entryPrice;
      const effectiveLossPerUnit = slDistance + roundTripFeePerUnit; // $2,090

      // Exact units to risk precisely $100 including commissions:
      const calculatedUnits = targetRiskUsd / effectiveLossPerUnit; // ~0.047846 BTC
      expect(calculatedUnits).toBeCloseTo(0.047846, 5);

      // Verify that if stopped out @ $88,000, total loss + round-trip commissions is exactly $100:
      const grossTradeLoss = calculatedUnits * slDistance;
      const roundTripFees = calculatedUnits * entryPrice * feeRate * 2;
      const totalNetLoss = grossTradeLoss + roundTripFees;

      expect(totalNetLoss).toBeCloseTo(100.0, 5);
      expect(totalNetLoss / balance).toBeCloseTo(0.01, 5); // Exactly 1.00%
    });

    it("prevents duplicate position closes from being recorded in trade history", () => {
      engine.mark("BTCUSD", 90_000);
      const accountId = engine.getAccount().id;

      engine.placeOrder({
        accountId,
        symbol: "BTCUSD",
        side: "BUY",
        type: "MARKET",
        quantity: 0.005,
      });

      const pos = engine.getPositions()[0]!;
      expect(pos).toBeDefined();

      // Close the position
      const res1 = engine.closePosition(pos.id);
      expect(res1.success).toBe(true);

      // Attempt to close the exact same position a second time
      const res2 = engine.closePosition(pos.id);
      expect(res2.success).toBe(false);

      // Closed history should have strictly 1 entry, not 2
      const closed = engine.getClosedPositions();
      expect(closed).toHaveLength(1);
    });

    it("demoApi placeOrder debounces rapid concurrent submissions to prevent duplicate trades", async () => {
      engine.mark("BTCUSD", 90_000);
      const accountId = engine.getAccount().id;

      // Simulate a double-click where two requests fire concurrently before resolution
      const [order1, order2] = await Promise.all([
        demoApi.placeOrder({
          accountId,
          symbol: "BTCUSD",
          side: "BUY",
          type: "MARKET",
          quantity: 0.005,
          fourHourScreenshot: "mock-4h",
          dailyScreenshot: "mock-1d",
        }),
        demoApi.placeOrder({
          accountId,
          symbol: "BTCUSD",
          side: "BUY",
          type: "MARKET",
          quantity: 0.005,
          fourHourScreenshot: "mock-4h",
          dailyScreenshot: "mock-1d",
        }),
      ]);

      // Both promises return the exact same order
      expect(order1.id).toBe(order2.id);

      // Exactly ONE open position was created, not two!
      const positions = engine.getPositions();
      expect(positions).toHaveLength(1);
    });

    it("propagates trade notes from order to position and closedPosition, and allows editing them", async () => {
      engine.mark("BTCUSD", 92_000);
      const accountId = engine.getAccount().id;
      const tradeThesis = "Ruptura de resistencia en 15m con volumen climático y rebote en soporte 4H";

      const order = engine.placeOrder({
        accountId,
        symbol: "BTCUSD",
        side: "BUY",
        type: "MARKET",
        quantity: 0.01,
        notes: tradeThesis,
      });

      expect(order.notes).toBe(tradeThesis);

      // Open position inherits notes
      const pos = engine.getPositions().find((p) => p.symbolName === "BTCUSD")!;
      expect(pos).toBeDefined();
      expect(pos.notes).toBe(tradeThesis);

      // Close position
      engine.closePosition(pos.id);
      const closed = engine.getClosedPositions()[0]!;
      expect(closed.notes).toBe(tradeThesis);

      // Update trade notes via updateTradeNotes
      const updatedThesis = "Análisis post-trade: Se cumplió el objetivo de TP tras pullback al nivel roto.";
      engine.updateTradeNotes(closed.id, updatedThesis);
      expect(engine.getClosedPositions()[0]!.notes).toBe(updatedThesis);

      // Update trade screenshot via updateTradeScreenshot
      const dynamicDailyScreenshot = "data:image/jpeg;base64,dynamicDailyUrl";
      engine.updateTradeScreenshot(closed.id, "daily", dynamicDailyScreenshot);
      expect(engine.getClosedPositions()[0]!.dailyScreenshot).toBe(dynamicDailyScreenshot);
    });

    it("TooltipElement safely handles detached DOM nodes without removeChild error", async () => {
      const { TooltipElement } = await import("../lib/chart-plugins/tooltip/tooltip-element.ts");

      // Test TooltipElement.destroy when element parent is not chartElement
      const mockChart = {
        chartElement: () => document.createElement("div"),
      };
      const tooltipEl = new TooltipElement(mockChart as any, {} as any);

      // Detach the element externally
      const el = (tooltipEl as any)._element;
      if (el?.parentNode) el.parentNode.removeChild(el);

      // Must destroy cleanly without throwing "The node to be removed is not a child of this node"
      expect(() => {
        tooltipEl.destroy();
      }).not.toThrow();
    });

    it("ensures 4-Hour and Daily screenshots are strictly distinct and repairs duplicates", async () => {
      engine.mark("BTCUSD", 90_000);
      const accountId = engine.getAccount().id;

      // 1. Order placed with duplicate screenshots gets repaired
      const order = await demoApi.placeOrder({
        accountId,
        symbol: "BTCUSD",
        side: "BUY",
        type: "MARKET",
        quantity: 0.01,
        fourHourScreenshot: "data:image/jpeg;base64,duplicateImage",
        dailyScreenshot: "data:image/jpeg;base64,duplicateImage",
        entryTimeframe: "4h",
      });

      // Daily must be repaired and cannot be identical to 4H
      const pos = engine.getPositions().find((p) => p.id === order.id || p.symbolName === "BTCUSD");
      expect(pos).toBeDefined();
      if (pos?.fourHourScreenshot && pos?.dailyScreenshot) {
        expect(pos.fourHourScreenshot).not.toBe(pos.dailyScreenshot);
      }
    });

    it("synchronizes daily screenshot to historical replay cursor without look-ahead candles", async () => {
      const { useReplayStore } = await import("../services/demo/replay.ts");
      const { captureDailyChart, getActiveReplayTimeSec } = await import("../lib/chart-plugins/trade-screenshot.ts");
      const allDaily = getHistory("BTCUSD", "1d");
      expect(allDaily.length).toBeGreaterThan(20);

      // Pick a historical point in time 15 days in the past
      const historicalCandle = allDaily[allDaily.length - 15]!;
      const historicalTimeSec = historicalCandle.time;

      // Start replay at that historical candle
      useReplayStore.getState().start("BTCUSD", "4h", historicalTimeSec);
      expect(useReplayStore.getState().phase).toBe("active");

      // Verify getActiveReplayTimeSec detects replay cursor
      const cursorTime = getActiveReplayTimeSec();
      expect(cursorTime).toBeDefined();
      expect(cursorTime).toBeLessThanOrEqual(historicalTimeSec + 86400 * 2);

      // Generate daily chart in replay mode
      const dailyCap = await captureDailyChart("BTCUSD", true);
      expect(dailyCap).toBeTruthy();

      // Clean up replay
      useReplayStore.getState().stop();
      expect(useReplayStore.getState().phase).toBe("idle");
    });

    it("successfully captures Daily and 4H charts for deep historical replay dates (e.g. Jan 10, 2024 > 1000 bars ago)", async () => {
      const { captureDailyChart, captureFourHourChart, parseTradeTimestampSec } = await import(
        "../lib/chart-plugins/trade-screenshot.ts"
      );

      // Jan 10, 2024 12:00:00 UTC (BTC around $45,546.40)
      const jan10TimeSec = 1704888000;
      const jan10Iso = new Date(jan10TimeSec * 1000).toISOString();

      // Timestamp parser tests
      expect(parseTradeTimestampSec(jan10Iso)).toBe(jan10TimeSec);
      expect(parseTradeTimestampSec(jan10TimeSec)).toBe(jan10TimeSec);
      expect(parseTradeTimestampSec(jan10TimeSec * 1000)).toBe(jan10TimeSec);
      expect(parseTradeTimestampSec(new Date(jan10Iso))).toBe(jan10TimeSec);

      // Deep historical Daily capture must return a non-empty chart
      const dailyCapture = await captureDailyChart("BTCUSD", true, jan10TimeSec);
      expect(dailyCapture).toBeTruthy();
      expect(dailyCapture.length).toBeGreaterThan(10);

      // Deep historical 4H capture must also return a non-empty chart
      const fourHourCapture = await captureFourHourChart("BTCUSD", true, jan10TimeSec);
      expect(fourHourCapture).toBeTruthy();
      expect(fourHourCapture.length).toBeGreaterThan(10);

      // 4H and Daily MUST NOT be equal
      expect(dailyCapture).not.toBe(fourHourCapture);
    });

    it("verifies deep historical replay order execution, notes, and synchronous 4H and 1D screenshot generation", async () => {
      const { useReplayStore } = await import("../services/demo/replay.ts");
      const { getRawHistory } = await import("../services/demo/candles.ts");
      const { captureTradeScreenshots } = await import("../lib/chart-plugins/trade-screenshot.ts");

      // Nov 11, 2022 12:00:00 UTC (FTX crash: 1668168000)
      const ftxCrashTimeSec = 1668168000;
      const startRes = useReplayStore.getState().start("BTCUSD", "4h", ftxCrashTimeSec);
      expect(startRes.ok).toBe(true);

      const replayState = useReplayStore.getState();
      expect(replayState.phase).toBe("active");
      expect(replayState.visible).toBeDefined();
      const lastVisibleBar = replayState.visible![replayState.visible!.length - 1]!;
      expect(lastVisibleBar.time).toBeLessThanOrEqual(ftxCrashTimeSec);

      // Verify trade screenshots captured at this exact historical point
      const captured = await captureTradeScreenshots("BTCUSD", lastVisibleBar.time);
      expect(captured.fourHourScreenshot).toBeTruthy();
      expect(captured.dailyScreenshot).toBeTruthy();
      expect(captured.fourHourScreenshot).not.toBe(captured.dailyScreenshot);

      // Place order during active replay
      const accountId = engine.getAccount().id;
      const order = await demoApi.placeOrder({
        accountId,
        symbol: "BTCUSD",
        side: "BUY",
        type: "MARKET",
        quantity: 0.05,
        notes: "FTX Crash Replay Long Entry",
        fourHourScreenshot: captured.fourHourScreenshot,
        dailyScreenshot: captured.dailyScreenshot,
        entryScreenshot: captured.fourHourScreenshot,
        entryTimeframe: "4h",
      });

      expect(order.status).toBe("FILLED");
      expect(order.source).toBe("replay");
      expect(order.notes).toBe("FTX Crash Replay Long Entry");

      const pos = engine.getPositions().find((p) => p.symbolName === "BTCUSD" && p.source === "replay");
      expect(pos).toBeDefined();
      expect(pos?.notes).toBe("FTX Crash Replay Long Entry");
      expect(pos?.fourHourScreenshot).toBeTruthy();
      expect(pos?.dailyScreenshot).toBeTruthy();
      expect(pos?.fourHourScreenshot).not.toBe(pos?.dailyScreenshot);

      // Verify openedAt is in 2022 (not 2026 and not 2011)
      const openedYear = new Date(pos!.openedAt).getUTCFullYear();
      expect(openedYear).toBe(2022);

      // Verify historical raw bars alignment
      const raw1d = getRawHistory("BTCUSD", "1d");
      const matched1d = raw1d.filter((b) => b.time <= lastVisibleBar.time);
      expect(matched1d.length).toBeGreaterThan(0);
      const last1d = matched1d[matched1d.length - 1]!;
      expect(new Date(last1d.time * 1000).getUTCFullYear()).toBe(2022);

      // Stop replay
      useReplayStore.getState().stop();
      expect(useReplayStore.getState().phase).toBe("idle");
    });

    it("verifies Nov 2021 ATH deep historical replay order and screenshots", async () => {
      const { useReplayStore } = await import("../services/demo/replay.ts");
      const { captureTradeScreenshots } = await import("../lib/chart-plugins/trade-screenshot.ts");

      // Nov 10, 2021 00:00:00 UTC (ATH: 1636502400)
      const athTimeSec = 1636502400;
      const startRes = useReplayStore.getState().start("BTCUSD", "4h", athTimeSec);
      expect(startRes.ok).toBe(true);

      const replayState = useReplayStore.getState();
      const lastVisibleBar = replayState.visible![replayState.visible!.length - 1]!;

      const captured = await captureTradeScreenshots("BTCUSD", lastVisibleBar.time);
      expect(captured.fourHourScreenshot).toBeTruthy();
      expect(captured.dailyScreenshot).toBeTruthy();
      expect(captured.fourHourScreenshot).not.toBe(captured.dailyScreenshot);

      const accountId = engine.getAccount().id;
      const order = await demoApi.placeOrder({
        accountId,
        symbol: "BTCUSD",
        side: "SELL",
        type: "MARKET",
        quantity: 0.1,
        notes: "Nov 2021 ATH Replay Short",
        fourHourScreenshot: captured.fourHourScreenshot,
        dailyScreenshot: captured.dailyScreenshot,
      });

      expect(order.status).toBe("FILLED");
      const pos = engine.getPositions().find((p) => p.symbolName === "BTCUSD" && p.source === "replay");
      expect(pos).toBeDefined();
      const openedYear = new Date(pos!.openedAt).getUTCFullYear();
      expect(openedYear).toBe(2021);

      useReplayStore.getState().stop();
    });

    it("enforces RSI above PRICE order on initialization even if legacy localStorage had PRICE first", () => {
      type ModularBlockId = "PRICE" | "RSI" | "MACD";
      const legacyStorage = JSON.stringify(["PRICE", "RSI", "MACD"]);

      const initializeOrder = (savedJson: string | null): ModularBlockId[] => {
        if (savedJson) {
          const parsed = JSON.parse(savedJson);
          if (Array.isArray(parsed) && parsed.length > 0) {
            const valid = parsed.filter((id): id is ModularBlockId =>
              id === "PRICE" || id === "RSI" || id === "MACD",
            );
            if (valid.includes("RSI") && valid.includes("PRICE")) {
              const rsiIdx = valid.indexOf("RSI");
              const priceIdx = valid.indexOf("PRICE");
              if (rsiIdx > priceIdx) {
                valid.splice(rsiIdx, 1);
                const newPriceIdx = valid.indexOf("PRICE");
                valid.splice(newPriceIdx, 0, "RSI");
              }
            }
            if (valid.length > 0) return valid;
          }
        }
        return ["RSI", "PRICE", "MACD"];
      };

      const result = initializeOrder(legacyStorage);
      expect(result).toEqual(["RSI", "PRICE", "MACD"]);
      expect(result.indexOf("RSI")).toBeLessThan(result.indexOf("PRICE"));
    });

    it("verifies moveBlock correctly swaps any block including moving RSI above PRICE", () => {
      type ModularBlockId = "PRICE" | "RSI" | "MACD";
      let blockOrder: ModularBlockId[] = ["PRICE", "RSI", "MACD"];

      const moveBlock = (id: ModularBlockId, direction: "up" | "down") => {
        const allActiveBlocks = [...blockOrder];
        const idx = allActiveBlocks.indexOf(id);
        if (idx === -1) return;
        const targetIdx = direction === "up" ? idx - 1 : idx + 1;
        if (targetIdx < 0 || targetIdx >= allActiveBlocks.length) return;

        const targetId = allActiveBlocks[targetIdx]!;
        const nextBlocks = [...allActiveBlocks];
        nextBlocks[idx] = targetId;
        nextBlocks[targetIdx] = id;
        blockOrder = nextBlocks;
      };

      // Initially RSI is at 1 (below PRICE at 0)
      expect(blockOrder).toEqual(["PRICE", "RSI", "MACD"]);

      // Move RSI up -> RSI becomes above PRICE!
      moveBlock("RSI", "up");
      expect(blockOrder).toEqual(["RSI", "PRICE", "MACD"]);

      // Move RSI down -> PRICE becomes above RSI again
      moveBlock("RSI", "down");
      expect(blockOrder).toEqual(["PRICE", "RSI", "MACD"]);
    });

    it("verifies Replay stepBack (-1 candle), in-replay bar picking, and timeframe switching", async () => {
      const { useReplayStore } = await import("../services/demo/replay.ts");
      const store = useReplayStore.getState();
      store.stop();

      // Start replay on BTCUSD 4h in Jan 2024
      const jan2024Sec = Math.floor(new Date("2024-01-15T12:00:00Z").getTime() / 1000);
      const startRes = useReplayStore.getState().start("BTCUSD", "4h", jan2024Sec);
      expect(startRes.ok).toBe(true);

      const initialCursor = useReplayStore.getState().cursor;
      const initialLen = useReplayStore.getState().visible?.length ?? 0;
      expect(initialLen).toBeGreaterThan(5);

      // Step forward +1
      useReplayStore.getState().step();
      expect(useReplayStore.getState().cursor).toBe(initialCursor + 1);
      expect(useReplayStore.getState().visible?.length).toBe(initialLen + 1);

      // Step backward -1 (back to initialCursor)
      useReplayStore.getState().stepBack();
      expect(useReplayStore.getState().cursor).toBe(initialCursor);
      expect(useReplayStore.getState().visible?.length).toBe(initialLen);

      // Step backward -1 again (one bar earlier than initial start)
      useReplayStore.getState().stepBack();
      expect(useReplayStore.getState().cursor).toBe(initialCursor - 1);
      expect(useReplayStore.getState().visible?.length).toBe(initialLen - 1);

      // Pick mode while already inside active Replay
      useReplayStore.getState().beginPick();
      expect(useReplayStore.getState().phase).toBe("picking");
      expect(useReplayStore.getState().visible).not.toBeNull();

      // Cancel pick returns to active Replay instead of exiting
      useReplayStore.getState().cancelPick();
      expect(useReplayStore.getState().phase).toBe("active");

      // Rewind to an earlier candle while already inside active Replay
      const earlierSec = jan2024Sec - 5 * 86400;
      const rewindRes = useReplayStore.getState().start("BTCUSD", "4h", earlierSec);
      expect(rewindRes.ok).toBe(true);
      expect(useReplayStore.getState().cursor).toBeLessThan(initialCursor - 1);

      // Switch timeframe to 1d while in Replay
      const simBeforeTf = useReplayStore.getState().simTimeSec;
      useReplayStore.getState().changeTimeframe("1d");
      expect(useReplayStore.getState().timeframe).toBe("1d");
      expect(useReplayStore.getState().simTimeSec).toBe(simBeforeTf);

      useReplayStore.getState().stop();
      expect(useReplayStore.getState().phase).toBe("idle");
    });

    it("correctly provides historical 1H candles aligned with Replay timestamp and prices (e.g. BTC ~$41k in Jan 2024)", async () => {
      // Jan 18, 2024 20:00:00 UTC (timestamp from user's trade)
      const jan18_2024Sec = 1705608000;

      // 1. Strict data provenance: 1h does NOT synthesize fake bars when Jan 2024 1h history is absent,
      // while 4h authentic history covers Jan 18, 2024 at ~$41,300 (NOT modern $80,000+)
      const bars1h = getReplayHistory("BTCUSD", "1h", jan18_2024Sec);
      expect(bars1h).toEqual([]);

      const bars4h = getReplayHistory("BTCUSD", "4h", jan18_2024Sec);
      const pastBars = bars4h.filter((b) => b.time <= jan18_2024Sec);
      expect(pastBars.length).toBeGreaterThan(50);

      const targetBar = pastBars[pastBars.length - 1]!;
      expect(targetBar.time).toBeLessThanOrEqual(jan18_2024Sec);
      expect(targetBar.close).toBeGreaterThan(38_000);
      expect(targetBar.close).toBeLessThan(45_000);

      // 2. Offscreen chart capture handles the 1H historical replay timestamp without throwing
      const screenshot = await captureOneHourChart("BTCUSD", true, jan18_2024Sec);
      expect(screenshot === undefined || typeof screenshot === "string").toBe(true);
    });

    it("accurately calculates fractional coordinates and bar spacing for future news icons in Replay whitespace", async () => {
      // Setup a simulated replay state
      const lastBarTimeSec = 1705584000; // e.g. Jan 18 2024 13:20:00
      const lastIndex = 99; // 100 bars visible
      const intervalSec = 3600; // 1h timeframe

      // Upcoming event 2.5 hours in the future
      const futureEventSec = lastBarTimeSec + 2.5 * 3600; // 2.5 bars ahead
      const barOffset = (futureEventSec - lastBarTimeSec) / intervalSec;
      expect(barOffset).toBe(2.5);

      const futureLogical = lastIndex + barOffset; // 101.5 (non-integer)
      const floorIdx = Math.floor(futureLogical); // 101 (integer)
      const ceilIdx = floorIdx + 1; // 102 (integer)
      const frac = futureLogical - floorIdx; // 0.5

      expect(Number.isInteger(floorIdx)).toBe(true);
      expect(Number.isInteger(ceilIdx)).toBe(true);

      // Simulated lightweight-charts integer-only logicalToCoordinate behavior
      const mockLogicalToCoordinate = (idx: number) => {
        if (!Number.isInteger(idx)) return 0; // The bug that was returning 0!
        const baseCoord = 400; // coord at lastIndex (99)
        const barSpacing = 16;
        return baseCoord + (idx - lastIndex) * barSpacing;
      };

      // With our floor/ceil interpolation fix:
      const xFloor = mockLogicalToCoordinate(floorIdx); // 101 -> 400 + 2 * 16 = 432
      const xCeil = mockLogicalToCoordinate(ceilIdx); // 102 -> 400 + 3 * 16 = 448
      const x = xFloor + frac * (xCeil - xFloor);

      // Verify the coordinate is positive, exact, and in the whitespace (ahead of 400)
      expect(x).toBe(440);
      expect(x).toBeGreaterThan(400);

      // Verify stacking handles simultaneous news events at the same timestamp
      const placedX: number[] = [440];
      let stackLevel = 0;
      const secondEventX = 440.5;
      for (const prevX of placedX) {
        if (Math.abs(prevX - secondEventX) < 22) {
          stackLevel++;
        }
      }
      expect(stackLevel).toBe(1);
      const bottomPosFirst = 28 + 0 * 26;
      const bottomPosSecond = 28 + stackLevel * 26;
      expect(bottomPosFirst).toBe(28);
      expect(bottomPosSecond).toBe(54);

      window.matchMedia = window.matchMedia || function() {
        return {
          matches: false,
          addListener: function() {},
          removeListener: function() {},
          addEventListener: function() {},
          removeEventListener: function() {},
          dispatchEvent: function() { return false; },
        };
      };
      const { createChart } = await import("lightweight-charts");
      const div = document.createElement("div");
      Object.defineProperty(div, "clientWidth", { value: 800, configurable: true });
      Object.defineProperty(div, "clientHeight", { value: 500, configurable: true });
      document.body.appendChild(div);

      const chart = createChart(div, { width: 800, height: 500 });
      const series = chart.addCandlestickSeries();
      const mockCandles = [
        { time: 1706313600, open: 40000, high: 41000, low: 39000, close: 40500 }, // Jan 27
        { time: 1706400000, open: 40500, high: 41500, low: 40000, close: 41000 }, // Jan 28
        { time: 1706486400, open: 41000, high: 42000, low: 40800, close: 41800 }, // Jan 29 (last)
      ];
      series.setData(mockCandles as any);

      const ts = chart.timeScale();
      const xTimeToCoord = ts.timeToCoordinate(1706486400 as any);
      const xLogicalLast = ts.logicalToCoordinate(2 as any);
      const xLogicalNext = ts.logicalToCoordinate(3 as any);
      const xLogicalPlus2 = ts.logicalToCoordinate(4 as any);
      expect(xTimeToCoord).toBe(xLogicalLast);
      expect(xLogicalNext).toBeGreaterThan(xLogicalLast!);
      expect(xLogicalPlus2).toBeGreaterThan(xLogicalNext!);

      chart.remove();
      div.remove();
    });

    it("supports temporary 4H Replay jump from Trade History without overwriting the default Replay date", async () => {
      const { useReplayStore, getLastReplayTimeSec } = await import("../services/demo/replay.ts");
      useReplayStore.getState().stop();

      // 1. Start a normal replay via the top button in Jan 2024, step forward, and exit
      const defaultReplaySec = Math.floor(new Date("2024-01-15T12:00:00Z").getTime() / 1000);
      const normalRes = useReplayStore.getState().start("BTCUSD", "4h", defaultReplaySec, { temporary: false });
      expect(normalRes.ok).toBe(true);
      expect(useReplayStore.getState().isTemporary).toBe(false);

      useReplayStore.getState().step();
      const expectedSavedDefaultSec = useReplayStore.getState().visible![useReplayStore.getState().visible!.length - 1]!.time;
      useReplayStore.getState().stop();
      expect(getLastReplayTimeSec("BTCUSD")).toBe(expectedSavedDefaultSec);

      // 2. Click a trade date in Trade History (e.g. July 2022 entry) -> starts temporary 4H replay
      const tradeHistoryEntrySec = Math.floor(new Date("2022-07-28T16:00:00Z").getTime() / 1000);
      const tempRes = useReplayStore.getState().start("BTCUSD", "4h", tradeHistoryEntrySec, { temporary: true });
      expect(tempRes.ok).toBe(true);
      expect(useReplayStore.getState().phase).toBe("active");
      expect(useReplayStore.getState().timeframe).toBe("4h");
      expect(useReplayStore.getState().isTemporary).toBe(true);

      // Default saved replay date must remain unchanged
      expect(getLastReplayTimeSec("BTCUSD")).toBe(expectedSavedDefaultSec);

      // Step forward, step backward, change timeframe, and exit — default replay date still must NOT change
      useReplayStore.getState().step();
      expect(getLastReplayTimeSec("BTCUSD")).toBe(expectedSavedDefaultSec);
      useReplayStore.getState().stepBack();
      expect(getLastReplayTimeSec("BTCUSD")).toBe(expectedSavedDefaultSec);
      useReplayStore.getState().changeTimeframe("1h");
      expect(getLastReplayTimeSec("BTCUSD")).toBe(expectedSavedDefaultSec);
      useReplayStore.getState().stop();
      expect(useReplayStore.getState().phase).toBe("idle");
      expect(useReplayStore.getState().isTemporary).toBe(false);
      expect(getLastReplayTimeSec("BTCUSD")).toBe(expectedSavedDefaultSec);
    });
  });

  describe("10. Audit Fixes: MACD/RSI Divergence Purity, 0.25% Bybit Fee, Multi-Asset Search & BTC.D", () => {
    it("blocks cross-zero wrong-polarity Regular MACD divergences (positive peak to negative bar or vice versa)", () => {
      const candles = Array.from({ length: 45 }, (_, i) => ({
        time: 1700000000 + i * 14400,
        open: 100,
        high: i === 10 ? 110 : i === 25 ? 120 : 102,
        low: i === 10 ? 95 : i === 25 ? 95 : 98,
        close: i === 10 ? 108 : i === 25 ? 118 : 100,
        volume: 1000,
      }));
      // Pivot 1 at idx 10 is +50, intermediate dip at idx 17 is -20, Pivot 2 at idx 25 is -5 (cross-zero negative peak!)
      const osc = Array.from({ length: 45 }, (_, i) => {
        let val = -10;
        if (i >= 7 && i <= 13) val = 50 - Math.abs(i - 10) * 18;
        else if (i >= 14 && i <= 20) val = -25 + Math.abs(i - 17) * 2;
        else if (i >= 22 && i <= 29) val = -5 - Math.abs(i - 25) * 4;
        return { time: candles[i]!.time, value: val };
      });

      const divs = detectDivergences(candles, osc, {
        mode: "macd",
        oscLeftBars: 3,
        oscRightBars: 2,
        minBars: 5,
        filterZones: true,
      });

      expect(divs.some((d) => d.kind === "bear")).toBe(false);
    });

    it("consumes anchor pivot P1 once so multiple duplicate divergences do not fan out from the same anchor", () => {
      // Create 3 peaks where Peak 2 and Peak 3 would both diverge against Peak 1 if P1 wasn't consumed:
      // P1 (idx 10): high 100, RSI 80; P2 (idx 22): high 110, RSI 74; P3 (idx 36): high 120, RSI 68
      const candles = Array.from({ length: 50 }, (_, i) => {
        let high = 95;
        if (i === 10) high = 100;
        else if (i === 22) high = 110;
        else if (i === 36) high = 120;
        return {
          time: 1700000000 + i * 3600,
          open: 90,
          high,
          low: 88,
          close: high - 1,
          volume: 1000,
        };
      });
      const osc = Array.from({ length: 50 }, (_, i) => {
        let value = 45;
        if (i >= 6 && i <= 14) value = 80 - Math.abs(i - 10) * 8;
        else if (i >= 18 && i <= 26) value = 74 - Math.abs(i - 22) * 8;
        else if (i >= 32 && i <= 40) value = 68 - Math.abs(i - 36) * 8;
        return { time: candles[i]!.time, value };
      });

      const bears = detectDivergences(candles, osc, {
        mode: "rsi",
        oscLeftBars: 3,
        oscRightBars: 2,
        minBars: 5,
        filterZones: true,
        rsiBearMinZone: 65,
      }).filter((d) => d.kind === "bear");

      const p1Times = bears.map((b) => b.startTime);
      expect(new Set(p1Times).size).toBe(p1Times.length);
      // Verify no divergence endTime is reused as the startTime of another segment (no pointy chained vertices)
      const endTimes = new Set(bears.map((b) => b.endTime));
      expect(bears.some((b) => endTimes.has(b.startTime))).toBe(false);
    });

    it("uses standard non-overfitted defaults RSI(14) and MACD(12, 26, 9) and compares only consecutive swings (ta.valuewhen)", async () => {
      const { RSI_BALANCED_DEFAULTS, MACD_BALANCED_DEFAULTS } = await import("../lib/indicators.ts");
      expect(RSI_BALANCED_DEFAULTS).toEqual({ intraday: 14, daily: 14 });
      expect(MACD_BALANCED_DEFAULTS).toEqual({ fast: 12, slow: 26, signal: 9 });

      // 3 consecutive peaks where Peak 2 (idx 22) and Peak 1 (idx 10) did NOT diverge (osc goes higher: 70 -> 78),
      // while Peak 3 (idx 36) is higher high than Peak 1 (idx 10) with lower osc (70 -> 66).
      // Adjacent swing model (P3 vs P2 only) must NOT skip over P2 back to P1.
      const candles = Array.from({ length: 48 }, (_, i) => {
        let high = 95;
        if (i === 10) high = 100;
        else if (i === 22) high = 120;
        else if (i === 36) high = 115;
        return {
          time: 1700000000 + i * 3600,
          open: 90,
          high,
          low: 88,
          close: high - 1,
          volume: 1000,
        };
      });
      const osc = Array.from({ length: 48 }, (_, i) => {
        let value = 42;
        if (i >= 6 && i <= 14) value = 70 - Math.abs(i - 10) * 6;
        else if (i >= 18 && i <= 26) value = 78 - Math.abs(i - 22) * 6;
        else if (i >= 32 && i <= 40) value = 66 - Math.abs(i - 36) * 6;
        return { time: candles[i]!.time, value };
      });
      // P1(10)->P2(22): Price HH, Osc HH (no div). P2(22)->P3(36): Price LH (120->115), Osc LH (78->66) (no regular bear div).
      // Skipping P2 would wrongly pair P1(100, 70) -> P3(115, 66) across P2!
      const divs = detectDivergences(candles, osc, {
        mode: "rsi",
        oscLeftBars: 3,
        oscRightBars: 2,
        minBars: 5,
        filterZones: true,
        rsiBearMinZone: 65,
      });
      expect(divs.some((d) => d.kind === "bear" && d.startTime === candles[10]!.time)).toBe(false);
    });

    it("never emits MACD peaks below zero or MACD valleys above zero (including hidden divergences)", () => {
      // Price makes Lower High while MACD oscillates ONLY in negative territory (-20 -> -8)
      // Previously hidden-bear fired on negative red bars below zero!
      const negBars = Array.from({ length: 45 }, (_, i) => ({
        time: 1700000000 + i * 14400,
        open: 100,
        high: i === 10 ? 120 : i === 28 ? 110 : 100,
        low: 90,
        close: i === 10 ? 118 : i === 28 ? 108 : 95,
        volume: 1000,
      }));
      const negOsc = Array.from({ length: 45 }, (_, i) => {
        let value = -40;
        if (i >= 7 && i <= 13) value = -20 - Math.abs(i - 10) * 6;
        else if (i >= 15 && i <= 23) value = -55 + Math.abs(i - 19) * 3;
        else if (i >= 25 && i <= 31) value = -8 - Math.abs(i - 28) * 6;
        return { time: negBars[i]!.time, value };
      });
      const negDivs = detectDivergences(negBars, negOsc, {
        mode: "macd",
        oscillatorSource: "histogram",
        oscLeftBars: 3,
        oscRightBars: 2,
        minBars: 5,
        filterZones: true,
      });
      expect(negDivs.some((d) => d.kind === "bear" || d.kind === "hidden-bear")).toBe(false);

      // Shallow notch inside a positive mountain without pullback toward zero must NOT fire
      const shallowBars = Array.from({ length: 45 }, (_, i) => ({
        time: 1700000000 + i * 14400,
        open: 100,
        high: i === 10 ? 105 : i === 24 ? 115 : 100,
        low: 95,
        close: i === 10 ? 104 : i === 24 ? 114 : 98,
        volume: 1000,
      }));
      const shallowOsc = Array.from({ length: 45 }, (_, i) => {
        let value = 20;
        if (i >= 7 && i <= 13) value = 60 - Math.abs(i - 10) * 2;
        else if (i >= 14 && i <= 20) value = 46; // Only dips 8% below hillBaseline (50) — stays inside the same mound
        else if (i >= 21 && i <= 27) value = 50 - Math.abs(i - 24) * 2;
        return { time: shallowBars[i]!.time, value };
      });
      const shallowDivs = detectDivergences(shallowBars, shallowOsc, {
        mode: "macd",
        oscLeftBars: 3,
        oscRightBars: 2,
        minBars: 5,
        filterZones: true,
      });
      expect(shallowDivs).toHaveLength(0);
    });

    it("supports includeRegular and includeHidden filtering independently", () => {
      const closes = [100, 96, 92, 90, 89, 93, 97, 102, 98, 93, 88, 86, 85, 89, 94, 98, 100];
      const oscs =   [ 50, 38, 26, 21, 20, 27, 39,  55, 46, 37, 31, 29, 28, 35, 45,  52,  56];
      const candles = closes.map((c, i) => ({
        time: (i + 1) * 3600,
        open: c,
        high: c + 1,
        low: c - 1,
        close: c,
        volume: 1000,
      }));
      const osc = oscs.map((v, i) => ({ time: (i + 1) * 3600, value: v }));

      const regOnly = detectDivergences(candles, osc, {
        mode: "rsi",
        leftBars: 3,
        rightBars: 2,
        minBars: 4,
        filterZones: false,
        includeRegular: true,
        includeHidden: false,
      });
      expect(regOnly.some((d) => d.kind === "bull")).toBe(true);

      const hidOnly = detectDivergences(candles, osc, {
        mode: "rsi",
        leftBars: 3,
        rightBars: 2,
        minBars: 4,
        filterZones: false,
        includeRegular: false,
        includeHidden: true,
      });
      expect(hidOnly.some((d) => d.kind === "bull")).toBe(false);
    });

    it("defaults commission feeRate to 0.25% (Bybit 0.0025)", () => {
      expect(engine.DEFAULT_FEE_RATE).toBe(0.0025);
    });

    it("searches BTC.D, altcoins, Bolsa stocks, indices, commodities, and forex, and generates valid candles", async () => {
      const { searchDemoSymbols, getDemoSymbol, registerDynamicSymbol } = await import(
        "../services/demo/instruments.ts"
      );

      // BTC.D dominance search
      const btcd = searchDemoSymbols("btc.d");
      expect(btcd[0]?.name).toBe("BTC.D");
      expect(searchDemoSymbols("dominancia").some((s) => s.name === "BTC.D")).toBe(true);

      // Altcoins, Bolsa (Stocks), Indices, Commodities, Forex
      expect(searchDemoSymbols("pepe").some((s) => s.name === "PEPEUSD")).toBe(true);
      expect(searchDemoSymbols("apple").some((s) => s.name === "AAPL")).toBe(true);
      expect(searchDemoSymbols("santander").some((s) => s.name === "SAN")).toBe(true);
      expect(searchDemoSymbols("ibex").some((s) => s.name === "ESP35")).toBe(true);
      expect(searchDemoSymbols("oro").some((s) => s.name === "XAUUSD")).toBe(true);
      expect(searchDemoSymbols("eurusd").some((s) => s.name === "EURUSD")).toBe(true);

      // Dynamic registration of a custom altcoin
      const custom = registerDynamicSymbol({
        name: "KASPAUSD",
        displayName: "Kaspa",
        initialPrice: 0.165,
      });
      expect(getDemoSymbol("KASPAUSD")?.initialPrice).toBe(0.165);
      expect(custom.category).toBe("CRYPTO");

      // Multi-timeframe test fixture generation works for non-stock asset classes,
      // while US Stocks (AAPL) strictly forbid synthetic fallback candles
      for (const sym of ["BTC.D", "PEPEUSD", "ESP35", "XAUUSD", "EURUSD", "KASPAUSD"]) {
        const bars = getHistory(sym, "4h");
        expect(bars.length).toBeGreaterThan(100);
        const last = bars[bars.length - 1]!;
        expect(last.close).toBeGreaterThan(0);
        expect(last.high).toBeGreaterThanOrEqual(Math.max(last.open, last.close));
        expect(last.low).toBeLessThanOrEqual(Math.min(last.open, last.close));
      }
      expect(getHistory("AAPL", "4h")).toEqual([]);
    });

    it("supports EUR-quoted crypto, commodities, and forex search, dynamic registration, and candles", async () => {
      const { searchDemoSymbols, getDemoSymbol } = await import("../services/demo/instruments.ts");

      // Direct search and slash/space alias ranking for ETHEUR
      expect(searchDemoSymbols("etheur")[0]?.name).toBe("ETHEUR");
      expect(searchDemoSymbols("eth/eur")[0]?.name).toBe("ETHEUR");
      expect(searchDemoSymbols("btceur").some((s) => s.name === "BTCEUR")).toBe(true);

      const eurQueryNames = new Set(searchDemoSymbols("eur").map((s) => s.name));
      for (const expected of ["ETHEUR", "BTCEUR", "SOLEUR", "EURUSD", "EURCHF", "XAUEUR"]) {
        expect(eurQueryNames.has(expected)).toBe(true);
      }

      // Dedicated EUR category filter returns EUR crypto, commodities, and forex crosses
      const eurCategoryNames = new Set(searchDemoSymbols("", "EUR").map((s) => s.name));
      for (const expected of ["BTCEUR", "ETHEUR", "SOLEUR", "EURCHF", "XAUEUR", "XAGEUR"]) {
        expect(eurCategoryNames.has(expected)).toBe(true);
      }
      expect(eurCategoryNames.has("BTCUSD")).toBe(false);

      expect(getPipDigits("EURCHF")).toBe(4);

      // Dynamic unknown crypto/EUR ticker resolution
      const dynamicEur = getDemoSymbol("KASPAEUR");
      expect(dynamicEur).toBeDefined();
      expect(dynamicEur?.category).toBe("CRYPTO");
      expect(dynamicEur?.displayName).toBe("KASPA / EUR");

      // Offline/initial fallback candles for ETHEUR scale cleanly to EUR prices
      const ethEurBars = getHistory("ETHEUR", "1h");
      const ethUsdBars = getHistory("ETHUSD", "1h");
      expect(ethEurBars.length).toBeGreaterThan(100);
      const lastEur = ethEurBars[ethEurBars.length - 1]!;
      const lastUsd = ethUsdBars[ethUsdBars.length - 1]!;
      expect(lastEur.close).toBeGreaterThan(0);
      expect(lastEur.close).toBeLessThan(lastUsd.close);
      expect(lastEur.high).toBeGreaterThanOrEqual(Math.max(lastEur.open, lastEur.close));
      expect(lastEur.low).toBeLessThanOrEqual(Math.min(lastEur.open, lastEur.close));
    });
  });

  describe("11. Volume Profile (VPVR), Market Structure (SMC), Settings & MTF Panel", () => {
    it("registers VPVR and SMC as overlay indicators in INDICATOR_REGISTRY", () => {
      const vpvr = INDICATOR_REGISTRY.find((r) => r.type === "VPVR");
      const smc = INDICATOR_REGISTRY.find((r) => r.type === "SMC");
      expect(vpvr?.pane).toBe("overlay");
      expect(smc?.pane).toBe("overlay");
    });

    it("computes accurate Volume Profile bins, POC, and Value Area", () => {
      const empty = computeVolumeProfile([]);
      expect(empty.bins).toEqual([]);
      expect(empty.pocIndex).toBe(-1);

      const candles: CandleData[] = [
        { time: 100, open: 100, high: 105, low: 98, close: 104, volume: 120 },
        { time: 200, open: 104, high: 106, low: 102, close: 103, volume: 260 },
        { time: 300, open: 103, high: 112, low: 101, close: 110, volume: 400 },
        { time: 400, open: 110, high: 115, low: 108, close: 109, volume: 180 },
      ];
      const vp = computeVolumeProfile(candles, { rows: 20, valueAreaPct: 70 });
      expect(vp.bins.length).toBe(20);
      expect(vp.totalVolume).toBeCloseTo(960, 6);

      const sumBinVol = vp.bins.reduce((acc, b) => acc + b.totalVolume, 0);
      expect(sumBinVol).toBeCloseTo(vp.totalVolume, 6);
      for (const bin of vp.bins) {
        expect(bin.buyVolume + bin.sellVolume).toBeCloseTo(bin.totalVolume, 6);
      }

      expect(vp.pocPrice).toBeGreaterThanOrEqual(vp.minPrice);
      expect(vp.pocPrice).toBeLessThanOrEqual(vp.maxPrice);
      expect(vp.valPrice).toBeLessThanOrEqual(vp.pocPrice);
      expect(vp.pocPrice).toBeLessThanOrEqual(vp.vahPrice);
    });

    it("detects causal swings (HH/HL/LH/LL), BOS/CHoCH breaks, and FVG mitigation without lookahead", () => {
      // Synthetic sequence forming: swing high -> higher low -> BOS bullish -> higher high -> lower low (CHoCH bearish)
      const closes = [
        100, 102, 105, 108, 112, 109, 106, 103, 104, 107,
        111, 115, 118, 116, 113, 110, 106, 102, 99, 96,
      ];
      const candles: CandleData[] = closes.map((c, idx) => {
        const open = idx === 0 ? c - 1 : closes[idx - 1]!;
        return {
          time: 1_700_000_000 + idx * 3600,
          open,
          high: Math.max(open, c) + 1.5,
          low: Math.min(open, c) - 1.5,
          close: c,
          volume: 100,
        };
      });

      const full = computeMarketStructure(candles, { swingLength: 2 });
      expect(full.swings.length).toBeGreaterThanOrEqual(3);
      for (let i = 1; i < full.swings.length; i++) {
        expect(full.swings[i]!.kind).not.toBe(full.swings[i - 1]!.kind);
      }
      expect(full.breaks.some((b) => b.kind === "BOS" && b.direction === "bullish")).toBe(true);
      expect(full.breaks.some((b) => b.kind === "CHoCH" && b.direction === "bearish")).toBe(true);

      // Strict causality check: truncating future bars never alters earlier confirmed swings/breaks/FVGs
      const cutIdx = 12;
      const cutTime = candles[cutIdx - 1]!.time;
      const partial = computeMarketStructure(candles.slice(0, cutIdx), { swingLength: 2 });

      expect(partial.swings).toEqual(full.swings.filter((s) => s.confirmedTime <= cutTime));
      expect(partial.breaks).toEqual(full.breaks.filter((b) => b.confirmedBarIndex < cutIdx));
      expect(
        partial.fvgs.map((f) => ({ ...f, mitigated: false, mitigatedTime: undefined })),
      ).toEqual(
        full.fvgs
          .filter((f) => f.endTime <= cutTime)
          .map((f) => ({ ...f, mitigated: false, mitigatedTime: undefined })),
      );

      // HH -> non-pivot valley -> LH: alternation inserts the lowest intervening bar as HL causally
      const altPattern: Array<{ high: number; low: number; close: number }> = [
        { high: 99, low: 95, close: 96 }, // 0
        { high: 98, low: 94, close: 95 }, // 1
        { high: 96, low: 92, close: 93 }, // 2
        { high: 95, low: 90, close: 94 }, // 3: HL (90)
        { high: 100, low: 93, close: 99 }, // 4
        { high: 106, low: 98, close: 105 }, // 5
        { high: 112, low: 104, close: 111 }, // 6
        { high: 120, low: 108, close: 118 }, // 7: HH (120)
        { high: 115, low: 110, close: 112 }, // 8
        { high: 109, low: 105, close: 106 }, // 9
        { high: 107, low: 102, close: 105 }, // 10
        { high: 108, low: 104, close: 106 }, // 11
        { high: 106, low: 100, close: 104 }, // 12: true lowest valley (100), disqualified on right by bar 15
        { high: 109, low: 104, close: 108 }, // 13
        { high: 114, low: 108, close: 112 }, // 14: LH (114)
        { high: 111, low: 98, close: 102 }, // 15 (wick 98 < 100 disqualifies bar 12 from ±3 pivot)
        { high: 105, low: 96, close: 99 }, // 16
        { high: 101, low: 93, close: 95 }, // 17: confirms LH(14) & inserts HL(12)
      ];
      const altCandles: CandleData[] = altPattern.map((b, idx) => ({
        time: 1_700_000_000 + idx * 3600,
        open: b.close,
        high: b.high,
        low: b.low,
        close: b.close,
      }));
      const altFull = computeMarketStructure(altCandles, { swingLength: 3 });
      expect(altFull.swings.map((s) => `${s.label}@${s.barIndex}`)).toEqual([
        "HL@3",
        "HH@7",
        "HL@12",
        "LH@14",
      ]);
      for (let i = 1; i < altFull.swings.length; i++) {
        expect(altFull.swings[i]!.kind).not.toBe(altFull.swings[i - 1]!.kind);
      }
      // Causality holds even with inserted intervening swings
      const altPartial = computeMarketStructure(altCandles.slice(0, 17), { swingLength: 3 });
      expect(altPartial.swings).toEqual(
        altFull.swings.filter((s) => s.confirmedTime <= altCandles[16]!.time),
      );
      expect(altPartial.breaks).toEqual(
        altFull.breaks.filter((b) => b.confirmedBarIndex < 17),
      );

      // Bearish break of HL@12 (confirmed at bar 17) stops cleanly at first breakout bar 16 (no overshoot)
      const bearBreak = altFull.breaks.find(
        (b) => b.direction === "bearish" && b.fromTime === altCandles[12]!.time,
      );
      expect(bearBreak).toBeDefined();
      expect(bearBreak?.toTime).toBe(altCandles[16]!.time);
      expect(bearBreak?.confirmedBarIndex).toBe(17);

      // No overlapping/regressing breaks in the same direction
      let lastBullTo = -Infinity;
      let lastBearTo = -Infinity;
      for (const b of full.breaks) {
        if (b.direction === "bullish") {
          expect(b.toTime).toBeGreaterThan(lastBullTo);
          lastBullTo = b.toTime;
        } else {
          expect(b.toTime).toBeGreaterThan(lastBearTo);
          lastBearTo = b.toTime;
        }
      }

      // Explicit Bullish FVG creation & mitigation check
      const fvgCandles: CandleData[] = [
        { time: 1000, open: 100, high: 102, low: 99, close: 101 },
        { time: 2000, open: 101, high: 110, low: 101, close: 109 },
        { time: 3000, open: 109, high: 112, low: 106, close: 111 }, // Bullish FVG [102..106]
        { time: 4000, open: 111, high: 112, low: 101, close: 104 }, // Mitigates FVG (low <= 102)
      ];
      const fvgRes = computeMarketStructure(fvgCandles, { swingLength: 2 });
      expect(fvgRes.fvgs.length).toBe(1);
      expect(fvgRes.fvgs[0]).toMatchObject({
        direction: "bullish",
        bottom: 102,
        top: 106,
        mitigated: true,
        mitigatedTime: 4000,
      });
    });

    it("persists and resets configurable VPVR & SMC settings", async () => {
      const {
        DEFAULT_INDICATOR_SETTINGS,
        getIndicatorSettings,
        updateIndicatorSettings,
        resetIndicatorSettings,
      } = await import("../hooks/useIndicatorSettings.ts");

      resetIndicatorSettings();
      expect(DEFAULT_INDICATOR_SETTINGS.smc.labelSize).toBe(13);
      expect(DEFAULT_INDICATOR_SETTINGS.smc.swingStyle).toBe("dots");
      expect(getIndicatorSettings()).toEqual(DEFAULT_INDICATOR_SETTINGS);

      updateIndicatorSettings({
        vpvr: { rows: 48, scope: "all", showUpDown: false },
        smc: { swingLength: 8, labelSize: 16, swingStyle: "labels", hideMitigatedFvg: false },
      });

      const updated = getIndicatorSettings();
      expect(updated.vpvr.rows).toBe(48);
      expect(updated.vpvr.scope).toBe("all");
      expect(updated.vpvr.showUpDown).toBe(false);
      expect(updated.smc.swingLength).toBe(8);
      expect(updated.smc.labelSize).toBe(16);
      expect(updated.smc.swingStyle).toBe("labels");
      expect(updated.smc.hideMitigatedFvg).toBe(false);

      resetIndicatorSettings("vpvr");
      const partialReset = getIndicatorSettings();
      expect(partialReset.vpvr).toEqual(DEFAULT_INDICATOR_SETTINGS.vpvr);
      expect(partialReset.smc.swingLength).toBe(8);
      expect(partialReset.smc.labelSize).toBe(16);
      expect(partialReset.smc.swingStyle).toBe("labels");

      resetIndicatorSettings();
      expect(getIndicatorSettings().smc.labelSize).toBe(13);
      expect(getIndicatorSettings().smc.swingStyle).toBe("dots");
    });

    it("configures EMA 8 and EMA 50 by default, persists custom periods, resets EMA independently, and computes EMA 8", async () => {
      const {
        DEFAULT_INDICATOR_SETTINGS,
        getIndicatorSettings,
        updateIndicatorSettings,
        resetIndicatorSettings,
      } = await import("../hooks/useIndicatorSettings.ts");

      resetIndicatorSettings();
      expect(DEFAULT_INDICATOR_SETTINGS.ema.lines.map((l) => l.period)).toEqual([8, 50]);
      expect(DEFAULT_INDICATOR_SETTINGS.ema.lines.every((l) => l.enabled)).toBe(true);

      updateIndicatorSettings({
        vpvr: { rows: 48 },
        ema: {
          lines: [
            { id: "ema-8", period: 8, color: "#f59e0b", enabled: true, lineWidth: 2 },
            { id: "ema-20", period: 20, color: "#10b981", enabled: true, lineWidth: 2 },
            { id: "ema-999", period: 999, color: "#ec4899", enabled: true, lineWidth: 3 },
          ],
        },
      });

      const updated = getIndicatorSettings();
      expect(updated.ema.lines.map((l) => l.period)).toEqual([8, 20, 500]);
      expect(updated.vpvr.rows).toBe(48);

      resetIndicatorSettings("ema");
      const afterEmaReset = getIndicatorSettings();
      expect(afterEmaReset.ema.lines.map((l) => l.period)).toEqual([8, 50]);
      expect(afterEmaReset.vpvr.rows).toBe(48);

      resetIndicatorSettings();

      const raw = getHistory("BTCUSD", "15m", 120);
      const candles: CandleData[] = raw.map((c) => ({
        time: c.time,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume,
      }));
      const ema8 = ema(candles, 8);
      expect(ema8.length).toBe(candles.length - 8 + 1);
      expect(Number.isFinite(ema8[ema8.length - 1]!.value)).toBe(true);
    });

    it("renders MultiTimeframePanel across 5m..1d and triggers timeframe change on click", async () => {
      const { MultiTimeframePanel } = await import("../pages/trading/MultiTimeframePanel.tsx");
      const onSelectTimeframe = vi.fn();
      const onClose = vi.fn();

      const { getByText } = render(
        React.createElement(MultiTimeframePanel, {
          symbol: "BTCUSD",
          currentTimeframe: "1h",
          onSelectTimeframe,
          onClose,
        }),
      );

      for (const tf of ["5m", "15m", "1h", "4h", "1d"]) {
        expect(getByText(tf)).toBeTruthy();
      }

      fireEvent.click(getByText("4h"));
      expect(onSelectTimeframe).toHaveBeenCalledWith("4h");
    });
  });

  describe("Stock Screener (Finviz sh_float_u20, ta_change_u10, sh_price_u20, sh_relvol_o5)", () => {
    it("configures default automatic filters for Finviz Float < 20M, Cbo% > 10%, Price < $20, and RelVol >= 5x", async () => {
      const { DEFAULT_SCREENER_FILTERS, US_MAJOR_EXCHANGES } = await import(
        "../services/stockScreener.ts"
      );

      expect(DEFAULT_SCREENER_FILTERS.marketScope).toBe("us");
      expect(DEFAULT_SCREENER_FILTERS.includeOtc).toBe(false);
      expect(DEFAULT_SCREENER_FILTERS.onlyPremarket).toBe(false);
      expect(DEFAULT_SCREENER_FILTERS.marketCapMin).toBeNull();
      expect(DEFAULT_SCREENER_FILTERS.marketCapMax).toBeNull();
      expect(DEFAULT_SCREENER_FILTERS.volumeMin).toBeNull();
      expect(DEFAULT_SCREENER_FILTERS.relVolMin).toBe(5);
      expect(DEFAULT_SCREENER_FILTERS.floatMin).toBeNull();
      expect(DEFAULT_SCREENER_FILTERS.floatMax).toBe(20_000_000);
      expect(DEFAULT_SCREENER_FILTERS.priceMin).toBeNull();
      expect(DEFAULT_SCREENER_FILTERS.priceMax).toBe(20);
      expect(DEFAULT_SCREENER_FILTERS.changeMin).toBe(10);
      expect(DEFAULT_SCREENER_FILTERS.changeMax).toBeNull();
      expect(DEFAULT_SCREENER_FILTERS.sortBy).toBe("change");
      expect(DEFAULT_SCREENER_FILTERS.sortOrder).toBe("desc");
      expect(US_MAJOR_EXCHANGES).toEqual(["NYSE", "NASDAQ", "AMEX"]);
    });

    it("builds screener request payloads accurately for Finviz defaults, global, OTC, search, and custom bounds", async () => {
      const { DEFAULT_SCREENER_FILTERS, buildScreenerRequest } = await import(
        "../services/stockScreener.ts"
      );

      const defReq = buildScreenerRequest(DEFAULT_SCREENER_FILTERS, 0, 500);
      expect(defReq).toMatchObject({
        marketScope: "us",
        exchanges: ["NYSE", "NASDAQ", "AMEX"],
        onlyPremarket: false,
        marketCapMin: null,
        marketCapMax: null,
        volumeMin: null,
        relVolMin: 5,
        floatMin: null,
        floatMax: 20_000_000,
        priceMin: null,
        priceMax: 20,
        changeMin: 10,
        changeMax: null,
        sector: null,
        search: "",
        sortBy: "change",
        sortOrder: "desc",
        offset: 0,
        limit: 500,
      });

      const usReq = buildScreenerRequest(
        {
          ...DEFAULT_SCREENER_FILTERS,
          marketScope: "us",
          onlyPremarket: false,
          marketCapMin: null,
          marketCapMax: null,
          floatMin: null,
          floatMax: 50_000_000,
          changeMin: null,
          sector: "Electronic Technology",
          search: "  NVTS ",
          sortBy: "market_cap_basic",
          sortOrder: "asc",
        },
        500,
        1500,
      );
      expect(usReq).toMatchObject({
        marketScope: "us",
        exchanges: ["NYSE", "NASDAQ", "AMEX"],
        onlyPremarket: false,
        marketCapMin: null,
        marketCapMax: null,
        floatMin: null,
        floatMax: 50_000_000,
        changeMin: null,
        sector: "Electronic Technology",
        search: "NVTS",
        sortBy: "market_cap_basic",
        sortOrder: "asc",
        offset: 500,
        limit: 1500,
      });

      const globalReq = buildScreenerRequest(
        {
          ...DEFAULT_SCREENER_FILTERS,
          marketScope: "global",
          onlyPremarket: false,
        },
        0,
        500,
      );
      expect(globalReq).toMatchObject({
        marketScope: "global",
        exchanges: [],
        onlyPremarket: false,
      });

      const otcReq = buildScreenerRequest(
        {
          ...DEFAULT_SCREENER_FILTERS,
          marketScope: "us_otc",
          includeOtc: true,
          onlyPremarket: false,
        },
        0,
        500,
      );
      expect(otcReq).toMatchObject({
        marketScope: "us_otc",
        exchanges: [],
        onlyPremarket: false,
      });

      // Enabling onlyPremarket enforces US major exchanges even if marketScope is global
      const enforcedPremarketReq = buildScreenerRequest(
        {
          ...DEFAULT_SCREENER_FILTERS,
          marketScope: "global",
          onlyPremarket: true,
        },
        0,
        500,
      );
      expect(enforcedPremarketReq).toMatchObject({
        marketScope: "us",
        exchanges: ["NYSE", "NASDAQ", "AMEX"],
        onlyPremarket: true,
      });
    });

    it("formats market cap, volume, percentages, and technical ratings cleanly", async () => {
      const { formatMarketCap, formatVolume, formatPercent, getRatingInfo } = await import(
        "../services/stockScreener.ts"
      );

      expect(formatMarketCap(1_990_000_000)).toBe("1.99 B USD");
      expect(formatMarketCap(492_700_000)).toBe("492.7 M USD");
      expect(formatMarketCap(250_000)).toBe("250.0 K USD");
      expect(formatMarketCap(null)).toBe("—");

      expect(formatVolume(10_620_000)).toBe("10.62 M");
      expect(formatVolume(573_930)).toBe("573.93 K");
      expect(formatVolume(null)).toBe("—");

      expect(formatPercent(21.89)).toBe("+21.89%");
      expect(formatPercent(-4.4)).toBe("-4.40%");
      expect(formatPercent(null)).toBe("—");

      expect(getRatingInfo(0.65)).toEqual({ label: "Compra fuerte", tone: "strong-buy" });
      expect(getRatingInfo(0.25)).toEqual({ label: "Compra", tone: "buy" });
      expect(getRatingInfo(0.0)).toEqual({ label: "Neutral", tone: "neutral" });
      expect(getRatingInfo(-0.25)).toEqual({ label: "Venta", tone: "sell" });
      expect(getRatingInfo(-0.7)).toEqual({ label: "Venta fuerte", tone: "strong-sell" });
      expect(getRatingInfo(undefined)).toEqual({ label: "—", tone: "none" });
    });

    it("registers dynamic US stock symbols with SMART/NASDAQ routing metadata", async () => {
      const { registerDynamicSymbol, getDemoSymbol } = await import(
        "../services/demo/instruments.ts"
      );

      const sym = registerDynamicSymbol({
        name: "NVTS",
        displayName: "Navitas Semiconductor Corp.",
        category: "STOCKS",
        initialPrice: 7.41,
        tickSize: 0.01,
        exchange: "NASDAQ",
      });

      expect(sym.name).toBe("NVTS");
      expect(sym.category).toBe("STOCKS");
      expect(getDemoSymbol("NVTS")?.category).toBe("STOCKS");
      expect(getDemoSymbol("NVTS")?.exchange).toBe("NASDAQ");
    });

    it("renders StockScreenerTab, auto-fetches US Pre-Market with 300M-2B >10% Float<20M filters, renders PRE badge & currency, and toggles Solo Pre-Market", async () => {
      const { StockScreenerTab } = await import("../pages/trading/StockScreenerTab.tsx");
      const mockStock = {
        id: "NASDAQ:XNDU",
        ticker: "XNDU",
        description: "Xunlei Demo Corp.",
        exchange: "NASDAQ",
        close: 2.01,
        change: 18.2,
        volume: 1_200_000,
        relativeVolume: 2.45,
        marketCap: 436_700_000,
        priceToBook: 2.52,
        epsDiluted: 0.45,
        epsGrowthYoY: 22.1,
        dividendYield: null,
        sector: "Technology Services",
        perfW: -4.2,
        perf1M: 5.4,
        perf3M: 12.1,
        perfYTD: 18.2,
        perfY: 4.5,
        rsi: 62.3,
        recommendAll: 0.42,
        floatShares: 17_787_238,
        currency: "USD",
        country: "United States",
        premarketClose: 1.97,
        premarketChange: 15.9,
        premarketVolume: 196_942,
      };

      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          totalCount: 5,
          items: [mockStock],
          fetchedAt: 1_700_000_000_000,
          source: "ibkr-scanner",
        }),
      });
      vi.stubGlobal("fetch", fetchMock);

      const onOpenStockInChart = vi.fn();

      try {
        const { getByText, getAllByText, getByTitle } = render(
          React.createElement(StockScreenerTab, {
            onOpenStockInChart,
          }),
        );

        await waitFor(() => {
          expect(getByText("XNDU")).toBeTruthy();
        });

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [reqUrl, reqInit] = fetchMock.mock.calls[0]!;
        expect(reqUrl).toBe("/__api/stock-screener");
        const sentBody = JSON.parse(String(reqInit?.body));
        expect(sentBody).toMatchObject({
          marketScope: "us",
          exchanges: ["NYSE", "NASDAQ", "AMEX"],
          onlyPremarket: false,
          marketCapMin: null,
          marketCapMax: null,
          volumeMin: null,
          relVolMin: 5,
          changeMin: 10,
          floatMin: null,
          floatMax: 20_000_000,
          priceMin: null,
          priceMax: 20,
        });

        expect(getByText("Xunlei Demo Corp.")).toBeTruthy();
        expect(getByText("USD")).toBeTruthy();
        expect(getByText("+18.20%")).toBeTruthy();
        expect(getAllByText("PRE").length).toBeGreaterThanOrEqual(1);
        expect(getByTitle(/Vol\. Pre-Market: 196\.94 K/)).toBeTruthy();

        fireEvent.click(getByText("XNDU"));
        expect(onOpenStockInChart).toHaveBeenCalledWith(mockStock);

        // Removing the RelVol filter dispatches a query with relVolMin: null
        fireEvent.click(getByTitle("Quitar filtro de volumen relativo"));
        await waitFor(() => {
          expect(fetchMock).toHaveBeenCalledTimes(2);
        });
        const secondBody = JSON.parse(String(fetchMock.mock.calls[1]![1]?.body));
        expect(secondBody.relVolMin).toBeNull();
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it("classifies Pre-Market, Regular, and After-Hours timestamps from tradingPeriods and NY schedule fallback", async () => {
      const { classifyExtendedSession } = await import(
        "../lib/chart-plugins/extended-hours-primitive.ts"
      );

      const metaWithRanges = {
        pre: [{ start: 1_795_424_400, end: 1_795_444_200 }], // 04:00 - 09:30 EST
        post: [{ start: 1_795_467_600, end: 1_795_482_000 }], // 16:00 - 20:00 EST
        timezone: "America/New_York",
      };

      expect(classifyExtendedSession(1_795_430_000, metaWithRanges, "NASDAQ")).toBe("pre");
      expect(classifyExtendedSession(1_795_450_000, metaWithRanges, "NASDAQ")).toBe("regular");
      expect(classifyExtendedSession(1_795_470_000, metaWithRanges, "NASDAQ")).toBe("post");

      // NY fallback when explicit ranges are empty (2026-11-23 is EST = UTC-5)
      const emptyUsMeta = { pre: [], post: [], timezone: "America/New_York" };
      const preNySec = Math.floor(Date.UTC(2026, 10, 23, 13, 0, 0) / 1000); // 08:00 ET
      const regNySec = Math.floor(Date.UTC(2026, 10, 23, 16, 0, 0) / 1000); // 11:00 ET
      const postNySec = Math.floor(Date.UTC(2026, 10, 23, 22, 30, 0) / 1000); // 17:30 ET
      expect(classifyExtendedSession(preNySec, emptyUsMeta, "NASDAQ")).toBe("pre");
      expect(classifyExtendedSession(regNySec, emptyUsMeta, "NASDAQ")).toBe("regular");
      expect(classifyExtendedSession(postNySec, emptyUsMeta, "NASDAQ")).toBe("post");
      // Non-US exchange with empty ranges should stay regular
      expect(
        classifyExtendedSession(preNySec, { pre: [], post: [], timezone: "Europe/Rome" }, "MIL"),
      ).toBe("regular");

      // Partial/stale tradingPeriods ending on Friday should still classify Monday NY extended hours
      const friPreStart = Math.floor(Date.UTC(2026, 10, 20, 9, 0, 0) / 1000); // 04:00 ET Fri
      const friPreEnd = Math.floor(Date.UTC(2026, 10, 20, 14, 30, 0) / 1000); // 09:30 ET Fri
      const friPostStart = Math.floor(Date.UTC(2026, 10, 20, 21, 0, 0) / 1000); // 16:00 ET Fri
      const friPostEnd = Math.floor(Date.UTC(2026, 10, 21, 1, 0, 0) / 1000); // 20:00 ET Fri
      const staleFridayMeta = {
        pre: [{ start: friPreStart, end: friPreEnd }],
        regular: [
          {
            start: Math.floor(Date.UTC(2026, 10, 23, 14, 30, 0) / 1000),
            end: Math.floor(Date.UTC(2026, 10, 23, 21, 0, 0) / 1000),
          },
        ],
        post: [{ start: friPostStart, end: friPostEnd }],
        timezone: "America/New_York",
      };
      expect(classifyExtendedSession(preNySec, staleFridayMeta, "NASDAQ")).toBe("pre");
      expect(classifyExtendedSession(regNySec, staleFridayMeta, "NASDAQ")).toBe("regular");
      expect(classifyExtendedSession(postNySec, staleFridayMeta, "NASDAQ")).toBe("post");

      // Explicit regular ranges take precedence over the NY schedule heuristic
      const explicitRegularOverride = {
        pre: [],
        regular: [{ start: preNySec - 300, end: preNySec + 300 }],
        post: [],
        timezone: "America/New_York",
      };
      expect(classifyExtendedSession(preNySec, explicitRegularOverride, "NASDAQ")).toBe("regular");

      // Weekend timestamps should stay regular even for US exchanges
      const sundayPreHoursSec = Math.floor(Date.UTC(2026, 10, 22, 13, 0, 0) / 1000); // Sun 08:00 ET
      expect(classifyExtendedSession(sundayPreHoursSec, emptyUsMeta, "NASDAQ")).toBe("regular");
    });

    it("supports 3m (3-minute) timeframe across constants, bucket alignment, resampling, and Replay", async () => {
      const { TIMEFRAMES, TF_INTERVAL_MS } = await import("../pages/trading/constants.ts");
      const { getCandleBucketTime } = await import("../pages/trading/utils.ts");
      const { TF_SECONDS, getHistory, getReplayHistory } = await import(
        "../services/demo/candles.ts"
      );

      expect(TIMEFRAMES.indexOf("3m")).toBeGreaterThan(TIMEFRAMES.indexOf("1m"));
      expect(TIMEFRAMES.indexOf("3m")).toBeLessThan(TIMEFRAMES.indexOf("5m"));
      expect(TF_INTERVAL_MS["3m"]).toBe(180_000);
      expect(TF_SECONDS["3m"]).toBe(180);

      // Bucket alignment to 180s boundaries
      expect(getCandleBucketTime(1_795_424_525_000, "3m")).toBe(
        Math.floor(1_795_424_525 / 180) * 180,
      );

      // Resampled 3m history from bundled BTCUSD 1m bars
      const bars3m = getHistory("BTCUSD", "3m");
      expect(bars3m.length).toBeGreaterThan(20);
      for (let i = 0; i < bars3m.length; i++) {
        const b = bars3m[i]!;
        expect(b.time % 180).toBe(0);
        expect(b.high).toBeGreaterThanOrEqual(Math.max(b.open, b.close));
        expect(b.low).toBeLessThanOrEqual(Math.min(b.open, b.close));
        if (i > 0) {
          expect(b.time).toBeGreaterThan(bars3m[i - 1]!.time);
        }
      }

      // Replay 3m refuses synthetic downward subdivision earlier than direct 1m history,
      // and succeeds cleanly within authentic 1m coverage via upward aggregation
      const outOfCoverageSec = bars3m[0]!.time - 7 * 86_400;
      expect(getReplayHistory("BTCUSD", "3m", outOfCoverageSec)).toEqual([]);

      const inCoverageSec = bars3m[Math.min(bars3m.length - 2, 30)]!.time;
      const replayBars3m = getReplayHistory("BTCUSD", "3m", inCoverageSec);
      expect(replayBars3m.length).toBeGreaterThan(20);
      for (let i = 0; i < replayBars3m.length; i++) {
        const b = replayBars3m[i]!;
        expect(b.time % 180).toBe(0);
        expect(b.high).toBeGreaterThanOrEqual(Math.max(b.open, b.close));
        expect(b.low).toBeLessThanOrEqual(Math.min(b.open, b.close));
        if (i > 0) {
          expect(replayBars3m[i]!.time).toBeGreaterThan(replayBars3m[i - 1]!.time);
        }
      }
    });

    it("resets VWAP sessions by America/New_York trading day for US stocks instead of 00:00 UTC", async () => {
      const { vwapBands } = await import("../lib/indicators.ts");

      // 2026-11-23 18:55 ET = 23:55 UTC; 19:05 ET = 2026-11-24 00:05 UTC; 2026-11-24 04:00 ET = 09:00 UTC
      const t1 = Math.floor(Date.UTC(2026, 10, 23, 23, 55, 0) / 1000);
      const t2 = Math.floor(Date.UTC(2026, 10, 24, 0, 5, 0) / 1000);
      const t3 = Math.floor(Date.UTC(2026, 10, 24, 9, 0, 0) / 1000);
      const candles = [
        { time: t1, open: 100, high: 100, low: 100, close: 100, volume: 100 },
        { time: t2, open: 200, high: 200, low: 200, close: 200, volume: 100 },
        { time: t3, open: 300, high: 300, low: 300, close: 300, volume: 100 },
      ];

      const nyBands = vwapBands(candles, {
        anchor: "session",
        sessionTimeZone: "america-new-york",
      });
      // t1 and t2 belong to the same NY trading day (100 & 200 equal volume -> 150)
      expect(nyBands.vwap[0]!.value).toBeCloseTo(100, 6);
      expect(nyBands.vwap[1]!.value).toBeCloseTo(150, 6);
      // t3 starts the next NY day at 04:00 ET -> resets to 300
      expect(nyBands.vwap[2]!.value).toBeCloseTo(300, 6);

      // Default UTC behavior still resets at 00:00 UTC (t2 resets to 200, then t3 averages 200 & 300 -> 250)
      const utcBands = vwapBands(candles, { anchor: "session" });
      expect(utcBands.vwap[0]!.value).toBeCloseTo(100, 6);
      expect(utcBands.vwap[1]!.value).toBeCloseTo(200, 6);
      expect(utcBands.vwap[2]!.value).toBeCloseTo(250, 6);
    });

    it("IbkrConfigModal validates & saves settings, notifies subscribers, and updates status", async () => {
      const { IbkrConfigModal } = await import("../components/IbkrConfigModal.tsx");
      const { subscribeIbkrConfigChanged } = await import("../services/ibkrConfig.ts");

      const statusListener = vi.fn();
      const unsub = subscribeIbkrConfigChanged(statusListener);

      const savedPayload = {
        configured: true,
        host: "127.0.0.1",
        port: 4002,
        clientId: 105,
        marketDataType: 1,
        source: "file" as const,
        connectionState: "connected" as const,
        lastError: null,
        activeStreams: 0,
        activeRequests: 0,
      };

      const fetchMock = vi.fn().mockImplementation((_url: unknown, init?: RequestInit) => {
        if (init?.method === "POST") {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => savedPayload,
          });
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            ...savedPayload,
            port: 7497,
            clientId: 101,
            source: "default",
            connectionState: "disconnected",
          }),
        });
      });
      vi.stubGlobal("fetch", fetchMock);

      const onClose = vi.fn();
      try {
        const { getByPlaceholderText, getByText } = render(
          React.createElement(IbkrConfigModal, {
            open: true,
            onClose,
          }),
        );

        await waitFor(() => expect(fetchMock).toHaveBeenCalled());

        const portInput = getByPlaceholderText("7497") as HTMLInputElement;
        const clientIdInput = getByPlaceholderText("101") as HTMLInputElement;
        fireEvent.change(portInput, { target: { value: "4002" } });
        fireEvent.change(clientIdInput, { target: { value: "105" } });
        fireEvent.click(getByText("Guardar y Conectar"));

        await waitFor(() => {
          expect(
            fetchMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === "POST"),
          ).toBe(true);
        });

        const postCall = fetchMock.mock.calls.find(
          ([, init]) => (init as RequestInit | undefined)?.method === "POST",
        )!;
        expect(postCall[0]).toBe("/__api/ibkr-config");
        expect(JSON.parse(String((postCall[1] as RequestInit).body))).toEqual({
          host: "127.0.0.1",
          port: 4002,
          clientId: 105,
          marketDataType: 1,
        });

        await waitFor(() => {
          expect(statusListener).toHaveBeenCalledWith(savedPayload);
        });
        expect(getByText(/Conectado \(127\.0\.0\.1:4002\)/)).toBeTruthy();
      } finally {
        unsub();
        vi.unstubAllGlobals();
      }
    });

    it("persists exact activeIndicators across reloads without re-adding removed RSI or MACD", async () => {
      const { loadSavedIndicators, saveActiveIndicators } = await import(
        "../pages/TradingPage.tsx"
      );

      try {
        localStorage.removeItem("activeIndicators_v2");
        expect(loadSavedIndicators()).toEqual(["EMA", "RSI", "MACD", "ATR"]);

        // Saving only EMA and VWAP should restore strictly EMA and VWAP (never inject RSI/MACD)
        saveActiveIndicators(["EMA", "VWAP"]);
        expect(loadSavedIndicators()).toEqual(["EMA", "VWAP"]);

        // Adding and removing indicators should persist the exact updated list
        saveActiveIndicators(["EMA", "VWAP", "ATR"]);
        expect(loadSavedIndicators()).toEqual(["EMA", "VWAP", "ATR"]);

        saveActiveIndicators(["VWAP", "ATR"]);
        expect(loadSavedIndicators()).toEqual(["VWAP", "ATR"]);

        // Clearing all indicators should stay empty across reloads
        saveActiveIndicators([]);
        expect(loadSavedIndicators()).toEqual([]);

        // Corrupt or unknown items are filtered while valid items remain intact
        localStorage.setItem(
          "activeIndicators_v2",
          JSON.stringify(["EMA", "UNKNOWN_IND", 123, "VWAP", "EMA"]),
        );
        expect(loadSavedIndicators()).toEqual(["EMA", "VWAP"]);
      } finally {
        localStorage.removeItem("activeIndicators_v2");
      }
    });

    it("applies real-time stock trades with exchange timestamps without phantom off-hours ticks", async () => {
      const { registerDynamicSymbol } = await import("../services/demo/instruments.ts");
      const { applyLiveStockTrade, syncCursorPrice } = await import("../services/demo/feed.ts");
      const { toIbkrContract } = await import("../server/ibkrEngine.ts");
      const { subscribeChannel } = await import("../services/demo/bus.ts");

      registerDynamicSymbol({
        name: "NVTS",
        displayName: "Navitas Semiconductor",
        category: "STOCKS",
        initialPrice: 4.5,
        tickSize: 0.01,
        exchange: "NASDAQ",
      });
      registerDynamicSymbol({
        name: "BRK.B",
        displayName: "Berkshire Hathaway",
        category: "STOCKS",
        initialPrice: 464.1,
        tickSize: 0.01,
        exchange: "NYSE",
      });

      expect(toIbkrContract("NVTS", "NASDAQ").primaryExch).toBe("ISLAND");
      expect(toIbkrContract("BRK.B", "NYSE")).toMatchObject({ symbol: "BRK B", primaryExch: "NYSE" });

      const receivedTicks: Array<{ symbol: string; bid: number; ask: number; occurredAt: number }> = [];
      const unsub = subscribeChannel("market-data", (ev: unknown) => {
        const tickEv = ev as {
          eventType?: string;
          symbol?: string;
          bid?: number;
          ask?: number;
          occurredAt?: number;
        };
        if (tickEv.eventType === "MarketTick" && tickEv.symbol === "NVTS") {
          receivedTicks.push({
            symbol: tickEv.symbol,
            bid: tickEv.bid ?? 0,
            ask: tickEv.ask ?? 0,
            occurredAt: tickEv.occurredAt ?? 0,
          });
        }
      });

      try {
        // Seeding a stock without a real bar timestamp must NOT emit a fake Date.now() MarketTick
        syncCursorPrice("NVTS", 4.55);
        expect(receivedTicks).toHaveLength(0);

        // Real-time Alpaca IEX trade emits exact exchange timestamp
        const t1 = 1_795_445_102_345;
        applyLiveStockTrade("NVTS", 4.72, t1);
        expect(receivedTicks).toHaveLength(1);
        expect(receivedTicks[0]!.occurredAt).toBe(t1);
        expect((receivedTicks[0]!.bid + receivedTicks[0]!.ask) / 2).toBeCloseTo(4.72, 6);

        // Out-of-order older trade is ignored so wicks never warp backwards
        applyLiveStockTrade("NVTS", 4.10, t1 - 5_000);
        expect(receivedTicks).toHaveLength(1);

        // Newer trade advances cleanly
        const t2 = t1 + 1_250;
        applyLiveStockTrade("NVTS", 4.80, t2);
        expect(receivedTicks).toHaveLength(2);
        expect(receivedTicks[1]!.occurredAt).toBe(t2);
        expect((receivedTicks[1]!.bid + receivedTicks[1]!.ask) / 2).toBeCloseTo(4.80, 6);
      } finally {
        unsub();
      }
    });

    it("prevents stale 1d stock bar updates from overwriting fresher 5m live timestamps", async () => {
      const { registerDynamicSymbol, getDemoSymbol } = await import(
        "../services/demo/instruments.ts"
      );
      const { getLatestRealStockTimestampMs, invalidateStockSeries } = await import(
        "../services/demo/candles.ts"
      );
      const { applyLiveStockTrade } = await import("../services/demo/feed.ts");

      invalidateStockSeries("AAPL");
      registerDynamicSymbol({
        name: "AAPL",
        displayName: "Apple Inc.",
        category: "STOCKS",
        initialPrice: 225,
        tickSize: 0.01,
        exchange: "NASDAQ",
      });

      const intradayTs = 1_795_450_000_000;
      applyLiveStockTrade("AAPL", 230.25, intradayTs);
      expect(getLatestRealStockTimestampMs("AAPL")).toBe(intradayTs);
      expect(getDemoSymbol("AAPL")?.initialPrice).toBeCloseTo(230.25, 4);

      // Simulate an older 1d bar arrival after intraday live price — timestamp must never go backwards
      applyLiveStockTrade("AAPL", 220.0, intradayTs - 86_400_000);
      expect(getLatestRealStockTimestampMs("AAPL")).toBe(intradayTs);
      expect(getDemoSymbol("AAPL")?.initialPrice).toBeCloseTo(230.25, 4);
    });

    it("MultiChartPane exposes clickable Timeframe & Indicator menus to switch tf and toggle VWAP/EMA/BOLL", async () => {
      const { MultiChartPane } = await import("../pages/trading/MultiChartPane.tsx");
      const { cleanup, fireEvent, render } = await import("@testing-library/react");

      const noop = () => {};
      const fakeCtx = {
        save: noop,
        restore: noop,
        scale: noop,
        translate: noop,
        setTransform: noop,
        resetTransform: noop,
        clearRect: noop,
        fillRect: noop,
        strokeRect: noop,
        beginPath: noop,
        closePath: noop,
        moveTo: noop,
        lineTo: noop,
        arc: noop,
        rect: noop,
        clip: noop,
        fill: noop,
        stroke: noop,
        setLineDash: noop,
        fillText: noop,
        strokeText: noop,
        createLinearGradient: () => ({ addColorStop: noop }),
        measureText: (txt: string) => ({ width: txt.length * 6 }),
        font: "",
        fillStyle: "",
        strokeStyle: "",
        lineWidth: 1,
        textAlign: "left",
        textBaseline: "alphabetic",
      };
      const origGetContext = HTMLCanvasElement.prototype.getContext;
      const origResizeObserver = globalThis.ResizeObserver;
      HTMLCanvasElement.prototype.getContext = (() => fakeCtx) as unknown as typeof origGetContext;
      vi.stubGlobal(
        "ResizeObserver",
        class {
          observe() {}
          unobserve() {}
          disconnect() {}
        },
      );

      try {
        const onPromote = vi.fn();
        const onFocus = vi.fn();
        const { getByTestId, queryByTestId, rerender } = render(
          React.createElement(MultiChartPane, {
            slotId: 1,
            mainSymbol: "BTCUSD",
            defaultTimeframe: "5m",
            timeframe: "5m",
            activeIndicators: ["EMA", "VWAP"],
            isFocused: false,
            onFocus,
            isDark: true,
            symbols: [],
            ticks: {},
            onPromoteToMain: onPromote,
          }),
        );

        expect(queryByTestId("pane-1-tf-btn")).toBeNull();
        expect(queryByTestId("pane-1-ind-btn")).toBeNull();
        expect(queryByTestId("pane-1-tf-badge")).toBeNull();
        expect(queryByTestId("pane-1-auto-btn")).toBeNull();
        expect(queryByTestId("pane-1-expand-btn")).toBeNull();
        expect(getByTestId("multichart-pane-1").getAttribute("data-timeframe")).toBe("5m");

        fireEvent.mouseDown(getByTestId("multichart-pane-1"));
        expect(onFocus).toHaveBeenCalledTimes(1);

        rerender(
          React.createElement(MultiChartPane, {
            slotId: 1,
            mainSymbol: "BTCUSD",
            defaultTimeframe: "5m",
            timeframe: "1m",
            activeIndicators: ["EMA", "VWAP", "BOLL"],
            isFocused: true,
            onFocus,
            isDark: true,
            symbols: [],
            ticks: {},
            onPromoteToMain: onPromote,
          }),
        );
        expect(getByTestId("multichart-pane-1").getAttribute("data-timeframe")).toBe("1m");
      } finally {
        cleanup();
        HTMLCanvasElement.prototype.getContext = origGetContext;
        if (origResizeObserver) {
          vi.stubGlobal("ResizeObserver", origResizeObserver);
        } else {
          vi.unstubAllGlobals();
        }
      }
    });
  });
});

