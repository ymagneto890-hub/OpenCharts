import React from "react";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { Time } from "lightweight-charts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { updateChartPreferences } from "../hooks/useChartPreferences.ts";
import { filterExtendedHoursCandles } from "../lib/chart-plugins/extended-hours-primitive.ts";
import {
  assessEmaWarmup,
  assessVwapSessionCoverage,
  computeFineGrainedSessionVwap,
  computeMinEmaWarmupBars,
  computeReplayEmaWithWarmup,
  ema,
  getNyTradingDayKey,
  isVwapSessionCoverageComplete,
  type VwapPriceSource,
  vwapBands,
} from "../lib/indicators.ts";
import {
  aggregateCandles,
  aggregateCandlesWithIntegrity,
  computeRequiredWarmupBars,
} from "../lib/timeframes.ts";
import { resolveMainChartCandles } from "../pages/TradingPage.tsx";
import { MultiChartPane } from "../pages/trading/MultiChartPane.tsx";
import { ReplayHUD } from "../pages/trading/ReplayHUD.tsx";
import { calculateReplayVolumeMa, calculateVolumeMa } from "../pages/trading/utils.ts";
import {
  computeVwapSessionSeedsFromBars,
  parseIbkrBarTimeSec,
} from "../server/ibkrEngine.ts";
import {
  applyIbkrBar1s,
  buildPartialCandleOrNullUpTo,
  buildPartialCandleRange,
  computeCausalReplayVwapSeed,
  ensureReplayHistoricalDataLoaded,
  fetchHistoryAsync,
  getCandleSeriesOrigin,
  getHistory,
  getReplayHistory,
  getReplaySeriesWithProvenance,
  invalidateStockSeries,
  resolvePartialCandleWindow,
  setRealStockSeries,
  validateSubIntervalCoverage,
} from "../services/demo/candles.ts";
import * as engine from "../services/demo/engine.ts";
import { registerDynamicSymbol } from "../services/demo/instruments.ts";
import {
  getReplaySliceForTimeframe,
  useReplayStore,
} from "../services/demo/replay.ts";
import type { Candle } from "../services/schemas.ts";
import { useTradingStore } from "../services/store.tsx";

function installCanvasMock(): () => void {
  const noop = () => {};
  const fakeCtx = {
    save: noop,
    restore: noop,
    scale: noop,
    translate: noop,
    setTransform: noop,
    clearRect: noop,
    fillRect: noop,
    strokeRect: noop,
    beginPath: noop,
    closePath: noop,
    moveTo: noop,
    lineTo: noop,
    arc: noop,
    arcTo: noop,
    quadraticCurveTo: noop,
    bezierCurveTo: noop,
    rect: noop,
    clip: noop,
    fill: noop,
    stroke: noop,
    fillText: noop,
    strokeText: noop,
    setLineDash: noop,
    getLineDash: () => [],
    measureText: (t: string) => ({ width: t.length * 7 }),
    createLinearGradient: () => ({ addColorStop: noop }),
    drawImage: noop,
    canvas: { width: 640, height: 420 },
  };
  const origMatchMedia = window.matchMedia;
  const origResizeObserver = globalThis.ResizeObserver;
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: noop,
      removeListener: noop,
      addEventListener: noop,
      removeEventListener: noop,
      dispatchEvent: () => false,
    }),
  });
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  const getCtxSpy = vi
    .spyOn(HTMLCanvasElement.prototype, "getContext")
    .mockImplementation(() => fakeCtx as unknown as RenderingContext);

  return () => {
    getCtxSpy.mockRestore();
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      configurable: true,
      value: origMatchMedia,
    });
    globalThis.ResizeObserver = origResizeObserver;
  };
}

/** Independent mathematical reference for EMA(N) seeded by exact N-period SMA. */
function independentEma(
  candles: ReadonlyArray<{ time: number; close: number }>,
  period: number,
): Array<{ time: number; value: number }> {
  if (candles.length < period || period <= 0) return [];
  let sum = 0;
  for (let i = 0; i < period; i++) {
    sum += candles[i]!.close;
  }
  let prev = sum / period;
  const k = 2 / (period + 1);
  const out: Array<{ time: number; value: number }> = [{ time: candles[period - 1]!.time, value: prev }];
  for (let i = period; i < candles.length; i++) {
    prev = prev + k * (candles[i]!.close - prev);
    out.push({ time: candles[i]!.time, value: prev });
  }
  return out;
}

/** Independent mathematical reference for NY Session VWAP + population standard deviation. */
function independentNySessionVwap(
  bars: ReadonlyArray<Candle>,
  opts: { source: VwapPriceSource; rthOnly: boolean },
): Array<{ time: number; vwap: number; stdDev: number }> {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const nyInfo = (sec: number) => {
    const parts = fmt.formatToParts(new Date(sec * 1000));
    let y = 0;
    let m = 0;
    let d = 0;
    let hh = 0;
    let mm = 0;
    for (const p of parts) {
      if (p.type === "year") y = Number(p.value);
      else if (p.type === "month") m = Number(p.value);
      else if (p.type === "day") d = Number(p.value);
      else if (p.type === "hour") hh = Number(p.value) % 24;
      else if (p.type === "minute") mm = Number(p.value);
    }
    return { dayKey: y * 10_000 + m * 100 + d, minutes: hh * 60 + mm };
  };

  let currentDay = -1;
  let sumPV = 0;
  let sumP2V = 0;
  let sumV = 0;
  const out: Array<{ time: number; vwap: number; stdDev: number }> = [];

  for (const b of bars) {
    const info = nyInfo(b.time);
    if (opts.rthOnly && (info.minutes < 570 || info.minutes >= 960)) continue;
    if (info.dayKey !== currentDay) {
      currentDay = info.dayKey;
      sumPV = 0;
      sumP2V = 0;
      sumV = 0;
    }
    const price =
      opts.source === "close"
        ? b.close
        : opts.source === "hl2"
          ? (b.high + b.low) / 2
          : opts.source === "ohlc4"
            ? (b.open + b.high + b.low + b.close) / 4
            : (b.high + b.low + b.close) / 3;
    if (b.volume > 0) {
      sumPV += price * b.volume;
      sumP2V += price * price * b.volume;
      sumV += b.volume;
    }
    const vwap = sumPV / sumV;
    const variance = Math.max(0, sumP2V / sumV - vwap * vwap);
    out.push({ time: b.time, vwap, stdDev: Math.sqrt(variance) });
  }
  return out;
}

/** Independent mathematical reference for Volume MA(20). */
function independentVolumeMa20(
  bars: ReadonlyArray<{ time: number; volume: number }>,
): Array<{ time: number; value: number }> {
  const out: Array<{ time: number; value: number }> = [];
  for (let i = 19; i < bars.length; i++) {
    let s = 0;
    for (let j = i - 19; j <= i; j++) {
      s += bars[j]!.volume;
    }
    out.push({ time: bars[i]!.time, value: Number((s / 20).toFixed(2)) });
  }
  return out;
}

describe("Auditoría Exhaustiva de Replay, VWAP, EMA, Volumen e IBKR (Escenarios A–J)", () => {
  beforeEach(() => {
    useReplayStore.getState().stop();
    for (const p of engine.getPositions()) {
      engine.closePosition(p.id);
    }
    for (const o of engine.getOrders()) {
      engine.cancelOrder(o.id);
    }
    updateChartPreferences({ showExtendedHours: true });
  });

  afterEach(() => {
    useReplayStore.getState().stop();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    cleanup();
  });

  it("A. Ausencia de datos sintéticos: nunca subdivide 5m en 1m artificiales pero sí permite agregación ascendente real", () => {
    registerDynamicSymbol({
      name: "SYNTHGUARD",
      displayName: "Synth Guard Corp",
      category: "STOCKS",
      initialPrice: 12.0,
      tickSize: 0.01,
      exchange: "NASDAQ",
    });

    // 2026-11-24 09:30 ET = 14:30 UTC (EST)
    const t0930 = Math.floor(Date.UTC(2026, 10, 24, 14, 30, 0) / 1000);
    const bars5m: Candle[] = Array.from({ length: 24 }, (_, i) => ({
      time: t0930 + i * 300,
      open: 12 + i * 0.1,
      high: 12.4 + i * 0.1,
      low: 11.8 + i * 0.1,
      close: 12.2 + i * 0.1,
      volume: 25_000 + i * 1_000,
    }));
    setRealStockSeries("SYNTHGUARD", "5m", bars5m);

    const targetSec = t0930 + 10 * 300; // 10:20 ET
    expect(getCandleSeriesOrigin("SYNTHGUARD", "5m", targetSec)).toBe("real");
    expect(getCandleSeriesOrigin("SYNTHGUARD", "1m", targetSec)).toBe("unavailable");

    // 1. Direct history & Replay history for 1m must be strictly empty (zero synthetic bars)
    expect(getHistory("SYNTHGUARD", "1m")).toEqual([]);
    expect(getReplayHistory("SYNTHGUARD", "1m", targetSec)).toEqual([]);

    // 2. Starting Replay directly on 1m when only 5m exists must fail cleanly without inventing bars
    const start1m = useReplayStore.getState().start("SYNTHGUARD", "1m", targetSec);
    expect(start1m.ok).toBe(false);
    expect(useReplayStore.getState().phase).toBe("idle");
    expect(useReplayStore.getState().visible).toBeNull();

    // 3. Starting Replay on 5m succeeds, and switching to 1m refuses synthetic subdivision & preserves 5m
    const start5m = useReplayStore.getState().start("SYNTHGUARD", "5m", targetSec);
    expect(start5m.ok).toBe(true);
    const visibleBefore = useReplayStore.getState().visible!;
    const switchedTo1m = useReplayStore.getState().changeTimeframe("1m");
    expect(switchedTo1m).toBe(false);
    expect(useReplayStore.getState().timeframe).toBe("5m");
    expect(useReplayStore.getState().dataWarning).toBeTruthy();
    expect(useReplayStore.getState().visible).toEqual(visibleBefore);
    expect(getReplaySliceForTimeframe("SYNTHGUARD", "1m", useReplayStore.getState().simTimeSec)).toEqual([]);

    // 4. Upward aggregation (5m -> 15m) from authentic 5m bars IS valid and marked as "aggregated"
    const res15m = getReplaySeriesWithProvenance("SYNTHGUARD", "15m", targetSec);
    expect(res15m.origin).toBe("aggregated");
    expect(res15m.sourceTimeframe).toBe("5m");
    expect(res15m.candles[0]!.volume).toBe(bars5m[0]!.volume + bars5m[1]!.volume + bars5m[2]!.volume);

    invalidateStockSeries("SYNTHGUARD");
  });

  it("B. VWAP real: coincidencia exacta entre 1m, 3m, 5m y 15m, reinicio de sesión, DST verano/invierno, RTH 09:30 vs Extended 04:00 y semilla causal", () => {
    registerDynamicSymbol({
      name: "VWAPREAL",
      displayName: "VWAP Precision Inc",
      category: "STOCKS",
      initialPrice: 18.0,
      tickSize: 0.01,
      exchange: "NASDAQ",
    });

    // Day 1 (Summer EDT, UTC-4): 2026-07-15 04:00 ET = 08:00 UTC
    // Day 2 (Winter EST, UTC-5): 2026-11-24 04:00 ET = 09:00 UTC, 09:30 ET = 14:30 UTC
    const edt0400 = parseIbkrBarTimeSec("20260715 04:00:00 US/Eastern");
    const est0400 = parseIbkrBarTimeSec("20261124 04:00:00 US/Eastern");
    const est0930 = parseIbkrBarTimeSec("20261124 09:30:00 US/Eastern");
    expect(edt0400).toBe(Math.floor(Date.UTC(2026, 6, 15, 8, 0, 0) / 1000));
    expect(est0400).toBe(Math.floor(Date.UTC(2026, 10, 24, 9, 0, 0) / 1000));
    expect(est0930).toBe(Math.floor(Date.UTC(2026, 10, 24, 14, 30, 0) / 1000));

    const bars1m: Candle[] = [];
    // Populate 60 bars on Summer Day 1 (04:00..04:59 ET) at high prices ($40) to prove Day 2 resets cleanly
    for (let i = 0; i < 60; i++) {
      bars1m.push({
        time: edt0400 + i * 60,
        open: 40,
        high: 41,
        low: 39,
        close: 40.5,
        volume: 50_000,
      });
    }
    // Populate Winter Day 2 from 04:00 ET through 11:30 ET (450 minutes = 7.5h)
    for (let i = 0; i < 450; i++) {
      const base = i < 330 ? 14 + Math.sin(i / 19) * 0.8 : 18 + Math.cos(i / 11) * 1.4 + (i - 330) * 0.03;
      const open = Number(base.toFixed(4));
      const close = Number((base + ((i % 5) - 2) * 0.07).toFixed(4));
      const high = Number((Math.max(open, close) + 0.18).toFixed(4));
      const low = Number((Math.min(open, close) - 0.14).toFixed(4));
      const volume = i < 330 ? 2_500 + (i % 9) * 300 : 14_000 + (i % 13) * 1_100;
      bars1m.push({ time: est0400 + i * 60, open, high, low, close, volume });
    }

    const bars3m = aggregateCandles(bars1m, 180) as Candle[];
    const bars5m = aggregateCandles(bars1m, 300) as Candle[];
    const bars15m = aggregateCandles(bars1m, 900) as Candle[];

    setRealStockSeries("VWAPREAL", "1m", bars1m);
    setRealStockSeries("VWAPREAL", "3m", bars3m);
    setRealStockSeries("VWAPREAL", "5m", bars5m);
    setRealStockSeries("VWAPREAL", "15m", bars15m);

    // Check at BOTH an exact 15m boundary (10:15 ET) AND a mid-bar Replay instant (10:38 ET)
    for (const simTimeSec of [est0930 + 45 * 60, est0930 + 68 * 60]) {
      const s1m = getReplaySliceForTimeframe("VWAPREAL", "1m", simTimeSec);
      const s3m = getReplaySliceForTimeframe("VWAPREAL", "3m", simTimeSec);
      const s5m = getReplaySliceForTimeframe("VWAPREAL", "5m", simTimeSec);
      const s15m = getReplaySliceForTimeframe("VWAPREAL", "15m", simTimeSec);

      for (const source of ["hlc3", "close"] as const) {
        // 1. Extended Hours VWAP (anchored at 04:00 ET)
        const optsExt = {
          anchor: "session" as const,
          sessionTimeZone: "america-new-york" as const,
          source,
          requireCompleteSession: true,
        };
        const refExt = independentNySessionVwap(s1m, { source, rthOnly: false }).at(-1)!;
        const v1 = vwapBands(s1m, optsExt);
        const v3 = computeFineGrainedSessionVwap(s3m, s1m, 180, optsExt);
        const v5 = computeFineGrainedSessionVwap(s5m, s1m, 300, optsExt);
        const v15 = computeFineGrainedSessionVwap(s15m, s1m, 900, optsExt);

        expect(v1.vwap.at(-1)!.value).toBeCloseTo(refExt.vwap, 8);
        expect(v3.vwap.at(-1)!.value).toBeCloseTo(refExt.vwap, 8);
        expect(v5.vwap.at(-1)!.value).toBeCloseTo(refExt.vwap, 8);
        expect(v15.vwap.at(-1)!.value).toBeCloseTo(refExt.vwap, 8);
        expect(v15.upper2.at(-1)!.value).toBeCloseTo(refExt.vwap + 2 * refExt.stdDev, 8);
        expect(v15.lower2.at(-1)!.value).toBeCloseTo(refExt.vwap - 2 * refExt.stdDev, 8);

        // 2. Regular Session VWAP (anchored strictly at 09:30 ET; premarket 04:00..09:29 excluded)
        const rth1m = filterExtendedHoursCandles(s1m, false, null, "NASDAQ");
        const rth3m = filterExtendedHoursCandles(s3m, false, null, "NASDAQ");
        const rth5m = filterExtendedHoursCandles(s5m, false, null, "NASDAQ");
        const rth15m = filterExtendedHoursCandles(s15m, false, null, "NASDAQ");
        const optsRth = {
          anchor: "session" as const,
          sessionTimeZone: "america-new-york" as const,
          source,
          anchorAtRegularOpen: true,
          rawCoverageStartSec: s1m[0]!.time,
          fineRawCoverageStartSec: s1m[0]!.time,
          requireCompleteSession: true,
        };
        const refRth = independentNySessionVwap(s1m, { source, rthOnly: true }).at(-1)!;
        expect(Math.abs(refRth.vwap - refExt.vwap)).toBeGreaterThan(0.25);

        const rv1 = vwapBands(rth1m, optsRth);
        const rv3 = computeFineGrainedSessionVwap(rth3m, rth1m, 180, optsRth);
        const rv5 = computeFineGrainedSessionVwap(rth5m, rth1m, 300, optsRth);
        const rv15 = computeFineGrainedSessionVwap(rth15m, rth1m, 900, optsRth);

        expect(rv1.vwap.at(-1)!.value).toBeCloseTo(refRth.vwap, 8);
        expect(rv3.vwap.at(-1)!.value).toBeCloseTo(refRth.vwap, 8);
        expect(rv5.vwap.at(-1)!.value).toBeCloseTo(refRth.vwap, 8);
        expect(rv15.vwap.at(-1)!.value).toBeCloseTo(refRth.vwap, 8);
      }
    }

    // 3. Causal Replay VWAP seed when visible window begins mid-session (10:15 ET) up to simTimeSec (10:38 ET)
    const simAt1038 = est0930 + 68 * 60;
    const visibleStart1015 = est0930 + 45 * 60;
    const causalSeed = computeCausalReplayVwapSeed("VWAPREAL", visibleStart1015, simAt1038, {
      sessionTimeZone: "america-new-york",
      anchorAtRegularOpen: true,
      source: "hlc3",
    });
    expect(causalSeed).not.toBeNull();
    expect(causalSeed!.anchorBucket).toBe(getNyTradingDayKey(visibleStart1015));

    const lateVisible1m = getReplaySliceForTimeframe("VWAPREAL", "1m", simAt1038).filter(
      (b) => b.time >= visibleStart1015,
    );
    const seededVwap = vwapBands(lateVisible1m, {
      anchor: "session",
      sessionTimeZone: "america-new-york",
      anchorAtRegularOpen: true,
      source: "hlc3",
      priorSessionSeed: causalSeed,
    });
    const fullRefAt1038 = independentNySessionVwap(
      getReplaySliceForTimeframe("VWAPREAL", "1m", simAt1038),
      { source: "hlc3", rthOnly: true },
    ).at(-1)!;
    expect(seededVwap.vwap.at(-1)!.value).toBeCloseTo(fullRefAt1038.vwap, 8);

    invalidateStockSeries("VWAPREAL");
  });

  it("C. Ausencia de look-ahead: explosión de precio y volumen a las 09:43 ET es invisible en toda temporalidad e indicador antes de las 09:43", () => {
    registerDynamicSymbol({
      name: "NOLOOKAHEAD",
      displayName: "Zero LookAhead Corp",
      category: "STOCKS",
      initialPrice: 10.0,
      tickSize: 0.01,
      exchange: "NASDAQ",
    });

    // 2026-11-24 09:00 ET = 14:00 UTC -> 10:30 ET (90 bars of 1m)
    const t0900 = Math.floor(Date.UTC(2026, 10, 24, 14, 0, 0) / 1000);
    const t0943 = t0900 + 43 * 60;
    const bars1m: Candle[] = Array.from({ length: 90 }, (_, i) => {
      const t = t0900 + i * 60;
      if (t === t0943) {
        return {
          time: t,
          open: 10.12,
          high: 29.8,
          low: 10.1,
          close: 27.5,
          volume: 6_000_000,
        };
      }
      return {
        time: t,
        open: 10.05,
        high: 10.2,
        low: 9.95,
        close: 10.1,
        volume: 1_000,
      };
    });

    const bars3m = aggregateCandles(bars1m, 180) as Candle[];
    const bars5m = aggregateCandles(bars1m, 300) as Candle[];
    const bars15m = aggregateCandles(bars1m, 900) as Candle[];
    const bars1h = aggregateCandles(bars1m, 3600) as Candle[];

    setRealStockSeries("NOLOOKAHEAD", "1m", bars1m);
    setRealStockSeries("NOLOOKAHEAD", "3m", bars3m);
    setRealStockSeries("NOLOOKAHEAD", "5m", bars5m);
    setRealStockSeries("NOLOOKAHEAD", "15m", bars15m);
    setRealStockSeries("NOLOOKAHEAD", "1h", bars1h);

    // Start Replay on 1m at 09:40:00 (simTimeSec = 09:41:00) and check 09:41, 09:42, 09:43 (right before 09:43 bar opens/closes)
    const startRes = useReplayStore.getState().start("NOLOOKAHEAD", "1m", t0900 + 40 * 60);
    expect(startRes.ok).toBe(true);

    for (let stepIdx = 0; stepIdx < 3; stepIdx++) {
      const simTimeSec = useReplayStore.getState().simTimeSec;
      expect(simTimeSec).toBeLessThanOrEqual(t0943);

      for (const tf of ["1m", "3m", "5m", "15m", "1h"] as const) {
        const slice = getReplaySliceForTimeframe("NOLOOKAHEAD", tf, simTimeSec);
        expect(slice.length).toBeGreaterThan(0);
        for (const c of slice) {
          expect(c.high).toBeLessThanOrEqual(10.2);
          expect(c.close).toBeLessThanOrEqual(10.2);
          expect(c.volume).toBeLessThan(100_000);
        }
      }

      const s1m = getReplaySliceForTimeframe("NOLOOKAHEAD", "1m", simTimeSec);
      const s5m = getReplaySliceForTimeframe("NOLOOKAHEAD", "5m", simTimeSec);
      const vwap5m = computeFineGrainedSessionVwap(s5m, s1m, 300, {
        anchor: "session",
        sessionTimeZone: "america-new-york",
      });
      expect(vwap5m.vwap.at(-1)!.value).toBeLessThanOrEqual(10.2);

      const ema9 = ema(s5m, 5);
      expect(ema9.at(-1)!.value).toBeLessThanOrEqual(10.2);

      const volMa20 = calculateVolumeMa(
        s1m.map((c) => ({ time: c.time as Time, value: c.volume })),
        20,
      );
      expect(volMa20.at(-1)!.value).toBe(1_000);

      if (stepIdx < 2) {
        useReplayStore.getState().step();
      }
    }

    // At simTimeSec === t0943 (09:42 bar closed, 09:43 bar NOT yet occurred), partial 5m bar [09:40..09:43) has exact 3,000 volume
    expect(useReplayStore.getState().simTimeSec).toBe(t0943);
    const partial5mAt0943 = getReplaySliceForTimeframe("NOLOOKAHEAD", "5m", t0943).at(-1)!;
    expect(partial5mAt0943.volume).toBe(3_000);
    expect(partial5mAt0943.high).toBe(10.2);

    // Step +1 minute -> simTimeSec = 09:44:00 (09:43 spike is now revealed!)
    useReplayStore.getState().step();
    const simAfter0943 = useReplayStore.getState().simTimeSec;
    expect(simAfter0943).toBe(t0943 + 60);

    for (const tf of ["1m", "3m", "5m", "15m", "1h"] as const) {
      const last = getReplaySliceForTimeframe("NOLOOKAHEAD", tf, simAfter0943).at(-1)!;
      expect(last.high).toBe(29.8);
      expect(last.close).toBe(27.5);
      expect(last.volume).toBeGreaterThanOrEqual(6_000_000);
    }

    invalidateStockSeries("NOLOOKAHEAD");
  });

  it("D. EMA: coincide con cálculo independiente en avances, retrocesos, velas parciales, calentamiento y cambios de temporalidad", () => {
    registerDynamicSymbol({
      name: "EMAAUDIT",
      displayName: "EMA Precision Corp",
      category: "STOCKS",
      initialPrice: 25.0,
      tickSize: 0.01,
      exchange: "NYSE",
    });

    const warmupNeeded = computeRequiredWarmupBars([9, 20, 50, 200]);
    expect(warmupNeeded).toBeGreaterThanOrEqual(1500);

    const tStart = Math.floor(Date.UTC(2026, 10, 23, 14, 30, 0) / 1000);
    const bars1m: Candle[] = Array.from({ length: warmupNeeded + 60 }, (_, i) => {
      const p = 25 + Math.sin(i / 23) * 2.2 + Math.cos(i / 7) * 0.45 + i * 0.005;
      const open = Number((p - 0.04).toFixed(4));
      const close = Number(p.toFixed(4));
      return {
        time: tStart + i * 60,
        open,
        high: Number((Math.max(open, close) + 0.12).toFixed(4)),
        low: Number((Math.min(open, close) - 0.12).toFixed(4)),
        close,
        volume: 3_000 + (i % 11) * 150,
      };
    });
    const bars5m = aggregateCandles(bars1m, 300) as Candle[];
    const bars15m = aggregateCandles(bars1m, 900) as Candle[];

    setRealStockSeries("EMAAUDIT", "1m", bars1m);
    setRealStockSeries("EMAAUDIT", "5m", bars5m);
    setRealStockSeries("EMAAUDIT", "15m", bars15m);

    const cutIdx = warmupNeeded + 11; // ends at +12m (mid-5m and mid-15m candle!)
    const startRes = useReplayStore.getState().start("EMAAUDIT", "1m", bars1m[cutIdx]!.time);
    expect(startRes.ok).toBe(true);

    const checkAllEmasMatchIndependent = (candlesSlice: Candle[]) => {
      for (const period of [9, 20, 50, 200]) {
        const actual = ema(candlesSlice, period);
        const expected = independentEma(candlesSlice, period);
        expect(actual).toHaveLength(expected.length);
        expect(actual.at(-1)!.time).toBe(expected.at(-1)!.time);
        expect(actual.at(-1)!.value).toBeCloseTo(expected.at(-1)!.value, 9);
      }
    };

    const initial1mSlice = useReplayStore.getState().visible!;
    checkAllEmasMatchIndependent(initial1mSlice);
    const snapshotEma9AtStart = ema(initial1mSlice, 9).at(-1)!.value;
    const snapshotEma200AtStart = ema(initial1mSlice, 200).at(-1)!.value;

    // Advance 4 steps on 1m -> verify every step matches independent EMA
    for (let s = 0; s < 4; s++) {
      useReplayStore.getState().step();
      checkAllEmasMatchIndependent(useReplayStore.getState().visible!);
    }

    // Rewind 4 steps via stepBack -> must reproduce exact bit-for-bit initial EMA values
    for (let s = 0; s < 4; s++) {
      useReplayStore.getState().stepBack();
    }
    const rewoundSlice = useReplayStore.getState().visible!;
    expect(ema(rewoundSlice, 9).at(-1)!.value).toBe(snapshotEma9AtStart);
    expect(ema(rewoundSlice, 200).at(-1)!.value).toBe(snapshotEma200AtStart);

    // Switch to 5m mid-candle: partial 5m candle must use ONLY its known close at simTimeSec
    expect(useReplayStore.getState().changeTimeframe("5m")).toBe(true);
    const slice5m = useReplayStore.getState().visible!;
    expect(slice5m.at(-1)!.close).toBe(initial1mSlice.at(-1)!.close);
    for (const period of [9, 20, 50]) {
      const actual5m = ema(slice5m, period);
      const expected5m = independentEma(slice5m, period);
      expect(actual5m.at(-1)!.value).toBeCloseTo(expected5m.at(-1)!.value, 9);
    }

    invalidateStockSeries("EMAAUDIT");
  });

  it("E. Volumen y Volume MA 20: suma exacta 5x1m, deduplicación, deltas 1s de IBKR sin duplicar ni perder volumen, y recálculo al retroceder", () => {
    registerDynamicSymbol({
      name: "VOLAUDIT",
      displayName: "Volume Integrity Corp",
      category: "STOCKS",
      initialPrice: 8.0,
      tickSize: 0.01,
      exchange: "NASDAQ",
    });

    const t0930 = Math.floor(Date.UTC(2026, 10, 24, 14, 30, 0) / 1000);
    const bars1m: Candle[] = Array.from({ length: 130 }, (_, i) => ({
      time: t0930 + i * 60,
      open: 8 + (i % 7) * 0.05,
      high: 8.3 + (i % 7) * 0.05,
      low: 7.9 + (i % 7) * 0.05,
      close: 8.1 + (i % 7) * 0.05,
      volume: 1_100 + i * 73,
    }));

    // 1. Duplicate input bars in aggregateCandles must NOT double-sum volume
    const withDuplicates = [...bars1m, { ...bars1m[0]! }, { ...bars1m[4]! }];
    const bars5m = aggregateCandles(withDuplicates, 300) as Candle[];
    expect(bars5m).toHaveLength(26);
    for (let b = 0; b < bars5m.length; b++) {
      const expectedSum = bars1m
        .slice(b * 5, b * 5 + 5)
        .reduce((acc, item) => acc + item.volume, 0);
      expect(bars5m[b]!.volume).toBe(expectedSum);
    }

    setRealStockSeries("VOLAUDIT", "1m", bars1m);
    setRealStockSeries("VOLAUDIT", "5m", bars5m);

    // 2. Partial 5m candle volume during Replay equals ONLY revealed 1m bars, and Volume MA(20) recalculates on stepBack()
    const startRes = useReplayStore.getState().start("VOLAUDIT", "5m", bars5m[21]!.time);
    expect(startRes.ok).toBe(true);
    const visAt21 = useReplayStore.getState().visible!;
    const expectedMaAt21 = independentVolumeMa20(visAt21);
    const actualMaAt21 = calculateVolumeMa(
      visAt21.map((c) => ({ time: c.time as Time, value: c.volume })),
      20,
    );
    expect(actualMaAt21).toHaveLength(expectedMaAt21.length);
    expect(actualMaAt21.at(-1)!.value).toBe(expectedMaAt21.at(-1)!.value);

    useReplayStore.getState().step();
    const visAt22 = useReplayStore.getState().visible!;
    const actualMaAt22 = calculateVolumeMa(
      visAt22.map((c) => ({ time: c.time as Time, value: c.volume })),
      20,
    );
    expect(actualMaAt22.at(-1)!.value).toBe(independentVolumeMa20(visAt22).at(-1)!.value);
    expect(actualMaAt22.at(-1)!.value).not.toBe(actualMaAt21.at(-1)!.value);

    useReplayStore.getState().stepBack();
    const visRewound = useReplayStore.getState().visible!;
    const actualMaRewound = calculateVolumeMa(
      visRewound.map((c) => ({ time: c.time as Time, value: c.volume })),
      20,
    );
    expect(actualMaRewound.at(-1)!.value).toBe(actualMaAt21.at(-1)!.value);
    useReplayStore.getState().stop();

    // 3. Live IBKR 1-second updates on top of historical series neither duplicate nor lose intra-second volume
    const last5mBefore = getHistory("VOLAUDIT", "5m").at(-1)!;
    const base5mVol = last5mBefore.volume;
    const last1mBefore = getHistory("VOLAUDIT", "1m").at(-1)!;
    const base1mVol = last1mBefore.volume;
    const liveSec = last1mBefore.time + 15; // inside the active 1m and 5m bucket

    // First print in `liveSec`: cumulative 1s volume = 120
    applyIbkrBar1s("VOLAUDIT", {
      time: liveSec,
      open: 8.2,
      high: 8.35,
      low: 8.2,
      close: 8.35,
      volume: 120,
    });
    // Second update in the SAME second `liveSec`: cumulative 1s volume grows from 120 -> 350 (+230 delta)
    applyIbkrBar1s("VOLAUDIT", {
      time: liveSec,
      open: 8.2,
      high: 8.5,
      low: 8.2,
      close: 8.48,
      volume: 350,
    });
    // Next second `liveSec + 1`: new 1s bar with volume = 200 (+200 delta)
    applyIbkrBar1s("VOLAUDIT", {
      time: liveSec + 1,
      open: 8.48,
      high: 8.55,
      low: 8.45,
      close: 8.52,
      volume: 200,
    });

    expect(getHistory("VOLAUDIT", "1m").at(-1)!.volume).toBe(base1mVol + 350 + 200);
    expect(getHistory("VOLAUDIT", "5m").at(-1)!.volume).toBe(base5mVol + 350 + 200);

    invalidateStockSeries("VOLAUDIT");
  });

  it("F. Cobertura de VWAP: histórico de 1m que empieza a las 09:35 ET (o en 09:34 dentro de la primera vela de 5m) no se trata como sesión completa", () => {
    const t0930 = Math.floor(Date.UTC(2026, 10, 24, 14, 30, 0) / 1000);
    const t0935 = t0930 + 5 * 60;

    // 1. 1-minute history starts at 09:35 ET instead of 09:30 ET with no prior bars and no seed
    const truncated1mFrom0935: Candle[] = Array.from({ length: 30 }, (_, i) => ({
      time: t0935 + i * 60,
      open: 15 + i * 0.05,
      high: 15.2 + i * 0.05,
      low: 14.9 + i * 0.05,
      close: 15.1 + i * 0.05,
      volume: 10_000,
    }));

    const coverage = assessVwapSessionCoverage(truncated1mFrom0935, {
      anchor: "session",
      sessionTimeZone: "america-new-york",
      anchorAtRegularOpen: true,
    });
    expect(coverage.isComplete).toBe(false);
    expect(
      isVwapSessionCoverageComplete(truncated1mFrom0935, {
        anchor: "session",
        sessionTimeZone: "america-new-york",
        anchorAtRegularOpen: true,
      }),
    ).toBe(false);

    // vwapBands & computeFineGrainedSessionVwap must NOT emit a fake Regular Session VWAP anchored at 09:35 ET
    const rthVwapIncomplete = vwapBands(truncated1mFrom0935, {
      anchor: "session",
      sessionTimeZone: "america-new-york",
      anchorAtRegularOpen: true,
    });
    expect(rthVwapIncomplete.vwap).toEqual([]);

    const bars5mFrom0935 = aggregateCandles(truncated1mFrom0935, 300) as Candle[];
    const fineVwapIncomplete = computeFineGrainedSessionVwap(
      bars5mFrom0935,
      truncated1mFrom0935,
      300,
      {
        anchor: "session",
        sessionTimeZone: "america-new-york",
        anchorAtRegularOpen: true,
      },
    );
    expect(fineVwapIncomplete.vwap).toEqual([]);

    // 2. Single 1m bar at 09:34 inside [09:30..09:35) 5m candle (missing 09:30..09:33) must NOT mark day covered
    const full5mFrom0930: Candle[] = [
      { time: t0930, open: 10, high: 12, low: 10, close: 11, volume: 500_000 },
      { time: t0935, open: 11, high: 15, low: 11, close: 14.5, volume: 50_000 },
    ];
    const truncated1mAt0934: Candle[] = [
      { time: t0930 + 4 * 60, open: 14, high: 14.2, low: 13.9, close: 14.1, volume: 1_000 },
      ...Array.from({ length: 5 }, (_, i) => ({
        time: t0935 + i * 60,
        open: 14.2,
        high: 15,
        low: 14.1,
        close: 14.5,
        volume: 10_000,
      })),
    ];
    const notCoveredRes = computeFineGrainedSessionVwap(
      full5mFrom0930,
      truncated1mAt0934,
      300,
      {
        anchor: "session",
        sessionTimeZone: "america-new-york",
      },
    );
    // Because 09:30..09:33 are missing from `truncated1mAt0934`, it must NEVER fall back silently to coarse 5m VWAP
    expect(notCoveredRes.vwap).toEqual([]);

    // 3. Conversely, if `priorSessionSeed` supplies the [09:30..09:35) opening volume, coverage IS complete
    const full1mFrom0930: Candle[] = [
      ...Array.from({ length: 5 }, (_, i) => ({
        time: t0930 + i * 60,
        open: 12,
        high: 12.6,
        low: 11.7,
        close: 12.3,
        volume: 40_000,
      })),
      ...truncated1mFrom0935,
    ];
    const seeds = computeVwapSessionSeedsFromBars(full1mFrom0930, t0935);
    expect(seeds.regular).not.toBeNull();
    expect(
      isVwapSessionCoverageComplete(truncated1mFrom0935, {
        anchor: "session",
        sessionTimeZone: "america-new-york",
        anchorAtRegularOpen: true,
        priorSessionSeed: seeds.regular,
      }),
    ).toBe(true);
  });

  it("G. Cambio de temporalidad: transiciones 1m -> 5m -> 15m -> 1h preservan simTimeSec exacto sin filtración futura", () => {
    registerDynamicSymbol({
      name: "TFSWITCH",
      displayName: "Multi-TF Sync Corp",
      category: "STOCKS",
      initialPrice: 30.0,
      tickSize: 0.01,
      exchange: "NASDAQ",
    });

    // 4 hours of 1m bars: 09:00 ET -> 13:00 ET (240 bars)
    const t0900 = Math.floor(Date.UTC(2026, 10, 24, 14, 0, 0) / 1000);
    const bars1m: Candle[] = Array.from({ length: 240 }, (_, i) => {
      // Inject extreme values later in each hour so any look-ahead would jump out immediately
      const inFutureSpikeZone = i % 60 >= 45;
      const base = inFutureSpikeZone ? 95 + (i % 10) : 30 + (i % 20) * 0.25;
      return {
        time: t0900 + i * 60,
        open: base,
        high: base + (inFutureSpikeZone ? 25 : 0.3),
        low: base - 0.2,
        close: base + 0.1,
        volume: inFutureSpikeZone ? 500_000 : 2_000 + i * 10,
      };
    });
    const bars5m = aggregateCandles(bars1m, 300) as Candle[];
    const bars15m = aggregateCandles(bars1m, 900) as Candle[];
    const bars1h = aggregateCandles(bars1m, 3600) as Candle[];

    setRealStockSeries("TFSWITCH", "1m", bars1m);
    setRealStockSeries("TFSWITCH", "5m", bars5m);
    setRealStockSeries("TFSWITCH", "15m", bars15m);
    setRealStockSeries("TFSWITCH", "1h", bars1h);

    // Start on 1m at 10:06 ET -> simTimeSec = 10:07 ET (7 minutes into 10:00..11:00 1h bar, 2m into 10:05..10:10 5m bar, 7m into 10:00..10:15 15m bar)
    const startRes = useReplayStore.getState().start("TFSWITCH", "1m", t0900 + 66 * 60);
    expect(startRes.ok).toBe(true);
    const expectedSim = t0900 + 67 * 60;
    expect(useReplayStore.getState().simTimeSec).toBe(expectedSim);
    const closeAt1006 = bars1m[66]!.close;

    // 1m -> 5m at 10:07 ET
    expect(useReplayStore.getState().changeTimeframe("5m")).toBe(true);
    expect(useReplayStore.getState().simTimeSec).toBe(expectedSim);
    const last5m = useReplayStore.getState().visible!.at(-1)!;
    expect(last5m.time).toBe(t0900 + 65 * 60);
    expect(last5m.close).toBe(closeAt1006);
    expect(last5m.volume).toBe(bars1m[65]!.volume + bars1m[66]!.volume);
    expect(last5m.high).toBe(Math.max(bars1m[65]!.high, bars1m[66]!.high));

    // 5m -> 15m at 10:07 ET
    expect(useReplayStore.getState().changeTimeframe("15m")).toBe(true);
    expect(useReplayStore.getState().simTimeSec).toBe(expectedSim);
    const last15m = useReplayStore.getState().visible!.at(-1)!;
    expect(last15m.time).toBe(t0900 + 60 * 60);
    expect(last15m.close).toBe(closeAt1006);
    expect(last15m.volume).toBe(
      bars1m.slice(60, 67).reduce((acc, b) => acc + b.volume, 0),
    );

    // 15m -> 1h at 10:07 ET (note full 10:00..11:00 1h bar has high = 129 in 10:45..10:59!)
    expect(useReplayStore.getState().changeTimeframe("1h")).toBe(true);
    expect(useReplayStore.getState().simTimeSec).toBe(expectedSim);
    const last1h = useReplayStore.getState().visible!.at(-1)!;
    expect(last1h.time).toBe(t0900 + 60 * 60);
    expect(last1h.close).toBe(closeAt1006);
    expect(last1h.high).toBeLessThan(40); // Future 10:45 spike (129) is completely hidden!
    expect(last1h.volume).toBe(
      bars1m.slice(60, 67).reduce((acc, b) => acc + b.volume, 0),
    );

    invalidateStockSeries("TFSWITCH");
  });

  it("H. Datos históricos faltantes: descarga fallida, serie vacía y panel sin velas jamás muestran velas actuales como fallback, y ReplayHUD descarga 1m aunque 5m ya exista", async () => {
    const restoreCanvas = installCanvasMock();
    try {
      registerDynamicSymbol({
        name: "MISSDATA",
        displayName: "Missing History Corp",
        category: "STOCKS",
        initialPrice: 88.88,
        tickSize: 0.01,
        exchange: "NASDAQ",
      });

      // Load modern "today" live candles ($88.88) into memory
      const today0930 = Math.floor(Date.UTC(2026, 10, 27, 14, 30, 0) / 1000);
      const modernLiveBars5m: Candle[] = Array.from({ length: 30 }, (_, i) => ({
        time: today0930 + i * 300,
        open: 88.88,
        high: 89.5,
        low: 88.1,
        close: 88.88,
        volume: 77_000,
      }));
      const modernLiveBars1m: Candle[] = Array.from({ length: 30 }, (_, i) => ({
        time: today0930 + i * 60,
        open: 88.88,
        high: 89.1,
        low: 88.5,
        close: 88.88,
        volume: 15_000,
      }));
      setRealStockSeries("MISSDATA", "5m", modernLiveBars5m);
      setRealStockSeries("MISSDATA", "1m", modernLiveBars1m);

      const oct15_1000 = Math.floor(Date.UTC(2026, 9, 15, 14, 0, 0) / 1000); // 2026-10-15 10:00 ET

      // 1. Failed HTTP 502 download for targetDate must return [] (NEVER modern $88.88 live bars!)
      const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("targetDate=2026-10-15")) {
          return new Response(JSON.stringify({ error: "IBKR Gateway timeout" }), { status: 502 });
        }
        if (url.includes("targetDate=2026-10-16")) {
          return new Response(JSON.stringify({ symbol: "MISSDATA", candles: [] }), { status: 200 });
        }
        if (url.includes("targetDate=2026-10-19")) {
          // Return WRONG symbol on purpose to test symbol verification
          return new Response(
            JSON.stringify({
              symbol: "WRONG_SYM",
              candles: [{ time: oct15_1000, open: 10, high: 11, low: 9, close: 10.5, volume: 1000 }],
            }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify({ candles: [] }), { status: 200 });
      });
      vi.stubGlobal("fetch", fetchMock);

      const failedBars = await fetchHistoryAsync("MISSDATA", "5m", 1500, {
        targetDate: "2026-10-15",
      });
      expect(failedBars).toEqual([]);

      const emptyBars = await fetchHistoryAsync("MISSDATA", "5m", 1500, {
        targetDate: "2026-10-16",
      });
      expect(emptyBars).toEqual([]);

      const wrongSymBars = await fetchHistoryAsync("MISSDATA", "5m", 1500, {
        targetDate: "2026-10-19",
      });
      expect(wrongSymBars).toEqual([]);

      const loadFailed = await ensureReplayHistoricalDataLoaded({
        symbol: "MISSDATA",
        primaryTimeframe: "5m",
        targetDate: "2026-10-15",
        targetTimeSec: oct15_1000,
      });
      expect(loadFailed.ok).toBe(false);

      // 2. Secondary pane without historical candles for the replay date (e.g. 1m unavailable while 5m exists)
      // must NEVER fall back to `liveCandles` ($88.88)!
      const oct20_0930 = Math.floor(Date.UTC(2026, 9, 20, 13, 30, 0) / 1000); // 2026-10-20 09:30 EDT
      const oct20Bars5m: Candle[] = Array.from({ length: 20 }, (_, i) => ({
        time: oct20_0930 + i * 300,
        open: 14.2,
        high: 14.5,
        low: 14.0,
        close: 14.35,
        volume: 9_000,
      }));
      const requestedUrls: string[] = [];
      fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
        const url = String(input);
        requestedUrls.push(url);
        if (url.includes("timeframe=5m") && url.includes("targetDate=2026-10-20")) {
          return new Response(JSON.stringify({ symbol: "MISSDATA", candles: oct20Bars5m }), {
            status: 200,
          });
        }
        // 1m fails for 2026-10-20 while modern 1m ($88.88) is still in memory!
        return new Response(JSON.stringify({ error: "No 1m data" }), { status: 502 });
      });

      const loadOct20 = await ensureReplayHistoricalDataLoaded({
        symbol: "MISSDATA",
        primaryTimeframe: "5m",
        additionalTimeframes: ["1m"],
        targetDate: "2026-10-20",
        targetTimeSec: oct20_0930 + 5 * 300,
      });
      expect(loadOct20.ok).toBe(true);
      expect(loadOct20.warnings.length).toBeGreaterThan(0);

      // Even if 5m for 2026-10-20 is ALREADY cached, launching again on 5m STILL requests missing 1m!
      requestedUrls.length = 0;
      await ensureReplayHistoricalDataLoaded({
        symbol: "MISSDATA",
        primaryTimeframe: "5m",
        targetDate: "2026-10-20",
        targetTimeSec: oct20_0930 + 5 * 300,
      });
      expect(requestedUrls.some((u) => u.includes("timeframe=1m") && u.includes("targetDate=2026-10-20"))).toBe(true);

      const startOct20 = useReplayStore.getState().start("MISSDATA", "5m", oct20_0930 + 5 * 300);
      expect(startOct20.ok).toBe(true);
      const simOct20 = useReplayStore.getState().simTimeSec;

      // 1m slice on 2026-10-20 must be [] (NOT modern $88.88 1m bars!)
      expect(getReplaySliceForTimeframe("MISSDATA", "1m", simOct20)).toEqual([]);

      const { getByTestId, container, unmount } = render(
        React.createElement(MultiChartPane, {
          slotId: 1,
          mainSymbol: "MISSDATA",
          defaultTimeframe: "1m",
          timeframe: "1m",
          isDark: true,
          symbols: [{ name: "MISSDATA", displayName: "Missing History Corp", category: "STOCKS" }],
          ticks: { MISSDATA: { bid: 88.88, ask: 88.88, timestamp: Date.now() } },
          isReplaying: true,
          replaySimTimeSec: simOct20,
        }),
      );

      expect(getByTestId("pane-1-replay-empty")).toBeTruthy();
      expect(container.innerHTML).not.toContain("88.88");
      unmount();
      invalidateStockSeries("MISSDATA");
    } finally {
      restoreCanvas();
    }
  });

  it("I. Paneles múltiples (2x1 y 2x2) y ReplayHUD: sincronización exacta en simTimeSec, bloqueo de descargas y ticks actuales, y recuperación al salir", async () => {
    const restoreCanvas = installCanvasMock();
    try {
      registerDynamicSymbol({
        name: "MULTISYNC",
        displayName: "MultiPane Sync Corp",
        category: "STOCKS",
        initialPrice: 16.0,
        tickSize: 0.01,
        exchange: "NASDAQ",
      });

      const oct21_0930 = Math.floor(Date.UTC(2026, 9, 21, 13, 30, 0) / 1000); // 2026-10-21 09:30 EDT
      const bars1m: Candle[] = Array.from({ length: 120 }, (_, i) => ({
        time: oct21_0930 + i * 60,
        open: 16 + i * 0.02,
        high: 16.15 + i * 0.02,
        low: 15.9 + i * 0.02,
        close: Number((16.05 + i * 0.02).toFixed(4)),
        volume: 5_000 + i * 50,
      }));
      const bars3m = aggregateCandles(bars1m, 180) as Candle[];
      const bars5m = aggregateCandles(bars1m, 300) as Candle[];
      const bars15m = aggregateCandles(bars1m, 900) as Candle[];

      const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("targetDate=2026-10-21")) {
          const tfMatch = /timeframe=([^&]+)/.exec(url)?.[1] ?? "1m";
          const map: Record<string, Candle[]> = {
            "1m": bars1m,
            "3m": bars3m,
            "5m": bars5m,
            "15m": bars15m,
          };
          return new Response(
            JSON.stringify({ symbol: "MULTISYNC", candles: map[tfMatch] ?? bars1m }),
            { status: 200 },
          );
        }
        // Live endpoint returns $999.99 modern bars so any accidental live fetch during Replay would be caught
        return new Response(
          JSON.stringify({
            symbol: "MULTISYNC",
            candles: [{ time: oct21_0930 + 86_400 * 30, open: 999.99, high: 999.99, low: 999.99, close: 999.99, volume: 1 }],
          }),
          { status: 200 },
        );
      });
      vi.stubGlobal("fetch", fetchSpy);

      // Launch Replay via ReplayHUD UI on 5m with 2x2 additional timeframes (3m, 15m) -> must also fetch 1m automatically!
      const hud = render(
        React.createElement(ReplayHUD, {
          symbol: "MULTISYNC",
          timeframe: "5m",
          additionalTimeframes: ["3m", "15m"],
        }),
      );
      fireEvent.click(hud.getByText("Replay"));
      const dtInput = hud.container.querySelector("input[type='datetime-local']") as HTMLInputElement;
      expect(dtInput).not.toBeNull();
      const targetLocalDate = new Date((oct21_0930 + 32 * 60) * 1000);
      const pad = (n: number) => String(n).padStart(2, "0");
      const localIso = `${targetLocalDate.getFullYear()}-${pad(targetLocalDate.getMonth() + 1)}-${pad(targetLocalDate.getDate())}T${pad(targetLocalDate.getHours())}:${pad(targetLocalDate.getMinutes())}`;
      fireEvent.change(dtInput, { target: { value: localIso } });
      await act(async () => {
        fireEvent.click(hud.getByText("Iniciar Aquí"));
      });
      await waitFor(() => {
        expect(useReplayStore.getState().phase).toBe("active");
      });

      // Verify ReplayHUD downloaded 5m, 1m (for VWAP), 3m, and 15m WITH targetDate=2026-10-21 and ZERO live fetches
      const hudUrls = fetchSpy.mock.calls.map((c) => String(c[0]));
      expect(hudUrls.some((u) => u.includes("timeframe=5m") && u.includes("targetDate=2026-10-21"))).toBe(true);
      expect(hudUrls.some((u) => u.includes("timeframe=1m") && u.includes("targetDate=2026-10-21"))).toBe(true);
      expect(hudUrls.some((u) => u.includes("timeframe=3m") && u.includes("targetDate=2026-10-21"))).toBe(true);
      expect(hudUrls.some((u) => u.includes("timeframe=15m") && u.includes("targetDate=2026-10-21"))).toBe(true);
      expect(hudUrls.every((u) => u.includes("targetDate=2026-10-21"))).toBe(true);
      hud.unmount();

      // Switch Replay step engine to 1m at 10:02 EDT (simTimeSec = 10:03 EDT) to test 2x1 and 2x2 sync
      useReplayStore.getState().start("MULTISYNC", "1m", oct21_0930 + 32 * 60);
      const simAt1003 = useReplayStore.getState().simTimeSec;
      expect(simAt1003).toBe(oct21_0930 + 33 * 60);

      fetchSpy.mockClear();

      // Inject a fake modern live CandleUpdate ($999.99) and live ticks ($999.99)
      useTradingStore.getState().updateCandleFromWs("MULTISYNC", "5m", {
        open: 999.99,
        high: 999.99,
        low: 999.99,
        close: 999.99,
        volume: 999_999,
        timestamp: Date.now(),
      });
      const fakeTicks = {
        MULTISYNC: { bid: 999.99, ask: 999.99, timestamp: Date.now() },
      };

      // Render 2x2 panes (slots 1, 2, 3 -> 3m, 5m, 15m) during Replay
      const grid = render(
        React.createElement(
          "div",
          null,
          React.createElement(MultiChartPane, {
            slotId: 1,
            mainSymbol: "MULTISYNC",
            defaultTimeframe: "3m",
            timeframe: "3m",
            activeIndicators: ["EMA", "VWAP"],
            isDark: true,
            symbols: [{ name: "MULTISYNC", category: "STOCKS" }],
            ticks: fakeTicks,
            isReplaying: true,
            replaySimTimeSec: simAt1003,
          }),
          React.createElement(MultiChartPane, {
            slotId: 2,
            mainSymbol: "MULTISYNC",
            defaultTimeframe: "5m",
            timeframe: "5m",
            activeIndicators: ["EMA", "VWAP"],
            isDark: true,
            symbols: [{ name: "MULTISYNC", category: "STOCKS" }],
            ticks: fakeTicks,
            isReplaying: true,
            replaySimTimeSec: simAt1003,
          }),
          React.createElement(MultiChartPane, {
            slotId: 3,
            mainSymbol: "MULTISYNC",
            defaultTimeframe: "15m",
            timeframe: "15m",
            activeIndicators: ["EMA", "VWAP"],
            isDark: true,
            symbols: [{ name: "MULTISYNC", category: "STOCKS" }],
            ticks: fakeTicks,
            isReplaying: true,
            replaySimTimeSec: simAt1003,
          }),
        ),
      );

      // 1. Zero live `fetchHistoryAsync` calls without targetDate while Replay is active!
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(grid.getByTestId("pane-1-replay-badge").textContent).toBe("Replay");
      expect(grid.getByTestId("pane-2-replay-badge").textContent).toBe("Replay");
      expect(grid.getByTestId("pane-3-replay-badge").textContent).toBe("Replay");
      expect(grid.container.innerHTML).not.toContain("999.99");

      // 2. All 4 timeframes (1m, 3m, 5m, 15m) reflect the exact close of 10:02 EDT (`bars1m[32].close`)
      const expectedCloseAt1003 = bars1m[32]!.close;
      for (const tf of ["1m", "3m", "5m", "15m"] as const) {
        const s = getReplaySliceForTimeframe("MULTISYNC", tf, simAt1003);
        expect(s.at(-1)!.close).toBe(expectedCloseAt1003);
      }

      // 3. Stop Replay -> panes immediately recover normal live operation and trigger live refresh
      useReplayStore.getState().stop();
      grid.rerender(
        React.createElement(
          "div",
          null,
          React.createElement(MultiChartPane, {
            slotId: 1,
            mainSymbol: "MULTISYNC",
            defaultTimeframe: "3m",
            timeframe: "3m",
            activeIndicators: ["EMA", "VWAP"],
            isDark: true,
            symbols: [{ name: "MULTISYNC", category: "STOCKS" }],
            ticks: fakeTicks,
            isReplaying: false,
            replaySimTimeSec: 0,
          }),
        ),
      );
      await waitFor(() => {
        expect(grid.queryByTestId("pane-1-replay-badge")).toBeNull();
        expect(fetchSpy).toHaveBeenCalled();
      });

      grid.unmount();
      invalidateStockSeries("MULTISYNC");
    } finally {
      restoreCanvas();
    }
  });

  it("J. Reconstrucción parcial: cambio de temporalidad a mitad de vela sin datos inferiores bloquea el avance y jamás envía el OHLCV completo futuro al motor", () => {
    registerDynamicSymbol({
      name: "PARTIALBLK",
      displayName: "Partial Guard Corp",
      category: "STOCKS",
      initialPrice: 10.0,
      tickSize: 0.01,
      exchange: "NASDAQ",
    });

    // 2026-11-24: 09:00..10:00, 10:00..11:00, 11:00..12:00 ET (1h bars)
    const t0900 = Math.floor(Date.UTC(2026, 10, 24, 14, 0, 0) / 1000);
    const t1000 = t0900 + 3600;
    const t1015 = t1000 + 900;
    const t1100 = t1000 + 3600;

    const bars1h: Candle[] = [
      { time: t0900, open: 10.0, high: 10.3, low: 9.8, close: 10.05, volume: 50_000 },
      // 10:00..11:00 1h bar has huge unrevealed future extremes (high $55, low $4) after 10:15!
      { time: t1000, open: 10.05, high: 55.0, low: 4.0, close: 52.0, volume: 900_000 },
      { time: t1100, open: 52.0, high: 54.0, low: 50.0, close: 53.0, volume: 200_000 },
    ];

    // 15m bars exist ONLY up to 10:15 (09:00..10:15); [10:15..11:00) has NO finer bars!
    const bars15mTruncated: Candle[] = [
      { time: t0900, open: 10.0, high: 10.15, low: 9.9, close: 10.05, volume: 12_000 },
      { time: t0900 + 900, open: 10.05, high: 10.2, low: 9.85, close: 10.1, volume: 12_000 },
      { time: t0900 + 1800, open: 10.1, high: 10.3, low: 9.8, close: 10.0, volume: 13_000 },
      { time: t0900 + 2700, open: 10.0, high: 10.15, low: 9.95, close: 10.05, volume: 13_000 },
      { time: t1000, open: 10.05, high: 10.25, low: 9.95, close: 10.12, volume: 15_000 },
    ];

    setRealStockSeries("PARTIALBLK", "1h", bars1h);
    setRealStockSeries("PARTIALBLK", "15m", bars15mTruncated);

    // 1. Direct verification: buildPartialCandleRange MUST return null (never the full future 1h bar!)
    expect(buildPartialCandleRange("PARTIALBLK", bars1h[1]!, "1h", t1015, t1100)).toBeNull();
    expect(buildPartialCandleOrNullUpTo("PARTIALBLK", bars1h[1]!, "1h", t1015 + 900)).toBeNull();

    // 2. Start Replay on 15m at 10:00..10:15 (simTimeSec = t1015, close = $10.12)
    // Add one extra dummy 15m bar first ONLY if start requires idx < length - 1, or start on 09:45 and step once to 10:15!
    const startRes = useReplayStore.getState().start("PARTIALBLK", "15m", t0900 + 2700);
    expect(startRes.ok).toBe(true);
    useReplayStore.getState().step(); // Reveals 10:00..10:15 -> simTimeSec = t1015
    expect(useReplayStore.getState().simTimeSec).toBe(t1015);

    // Open a LONG position @ $10.12 with SL @ $6.00 and TP @ $45.00, plus a BUY STOP @ $35.00.
    // If the engine ever received `bars1h[1]` (high: 55, low: 4), SL/TP and BUY STOP would trigger!
    const accountId = engine.getAccount().id;
    engine.placeOrder({
      accountId,
      symbol: "PARTIALBLK",
      side: "BUY",
      type: "MARKET",
      quantity: 10,
      stopLoss: 6.0,
      takeProfit: 45.0,
    });
    engine.placeOrder({
      accountId,
      symbol: "PARTIALBLK",
      side: "BUY",
      type: "STOP",
      quantity: 5,
      stopPrice: 35.0,
    });
    expect(engine.getPositions()).toHaveLength(1);
    const pendingOrdersBefore = engine.getOrders().filter((o) => o.status !== "FILLED" && o.status !== "CANCELED");
    expect(pendingOrdersBefore).toHaveLength(1);

    // Switch to 1h at 10:15 (mid-1h candle): partial [10:00..10:15) is valid, [10:15..11:00) is missing!
    expect(useReplayStore.getState().changeTimeframe("1h")).toBe(true);
    expect(useReplayStore.getState().simTimeSec).toBe(t1015);
    const partial1h = useReplayStore.getState().visible!.at(-1)!;
    expect(partial1h.high).toBe(10.25);
    expect(partial1h.low).toBe(9.95);
    expect(partial1h.close).toBe(10.12);
    expect(partial1h.volume).toBe(15_000);

    // Attempt `step()` on 1h when [10:15..11:00) sub-candles are missing:
    // Engine must NOT receive `bars1h[1]` and advancement must pause/block with `dataWarning`!
    const advanceSpy = vi.spyOn(engine, "replayAdvance");
    useReplayStore.getState().step();

    expect(advanceSpy).not.toHaveBeenCalled();
    expect(useReplayStore.getState().simTimeSec).toBe(t1015);
    expect(useReplayStore.getState().playing).toBe(false);
    expect(useReplayStore.getState().dataWarning).toBeTruthy();
    expect(engine.getPositions()).toHaveLength(1);
    const pendingOrdersAfter = engine.getOrders().filter((o) => o.status !== "FILLED" && o.status !== "CANCELED");
    expect(pendingOrdersAfter).toHaveLength(1);

    invalidateStockSeries("PARTIALBLK");
  });

  it("K. VWAP estricto: histórico 1m inexistente, multi-día con sesión anterior completa y actual incompleta, semilla válida vs inválida y anclajes week/month intactos", () => {
    const day1_0930 = Math.floor(Date.UTC(2026, 10, 23, 14, 30, 0) / 1000); // Mon 2026-11-23 09:30 ET
    const day2_0930 = Math.floor(Date.UTC(2026, 10, 24, 14, 30, 0) / 1000); // Tue 2026-11-24 09:30 ET

    const day1Bars1m: Candle[] = Array.from({ length: 30 }, (_, i) => ({
      time: day1_0930 + i * 60,
      open: 10 + i * 0.05,
      high: 10.2 + i * 0.05,
      low: 9.9 + i * 0.05,
      close: 10.1 + i * 0.05,
      volume: 10_000 + i * 100,
    }));
    // Day 2 starts late at 09:45 ET (missing 09:30..09:44!)
    const day2LateBars1m: Candle[] = Array.from({ length: 15 }, (_, i) => ({
      time: day2_0930 + (15 + i) * 60,
      open: 22 + i * 0.1,
      high: 22.3 + i * 0.1,
      low: 21.8 + i * 0.1,
      close: 22.2 + i * 0.1,
      volume: 15_000,
    }));

    const multiDay1m = [...day1Bars1m, ...day2LateBars1m];
    const day1Bars5m = aggregateCandles(day1Bars1m, 300) as Candle[];
    const day2LateBars5m = aggregateCandles(day2LateBars1m, 300) as Candle[];
    const multiDay5m = [...day1Bars5m, ...day2LateBars5m];
    const multiDay15m = aggregateCandles(multiDay1m, 900) as Candle[];

    // 1. Missing 1m on 3m/5m/15m/1h session VWAP -> NEVER falls back to coarse bars!
    for (const tfSec of [180, 300, 900, 3600]) {
      const no1m = computeFineGrainedSessionVwap(multiDay5m, null, tfSec, {
        anchor: "session",
        sessionTimeZone: "america-new-york",
        source: "hlc3",
      });
      expect(no1m.vwap).toEqual([]);
      expect(
        computeFineGrainedSessionVwap(multiDay5m, [], tfSec, {
          anchor: "session",
          sessionTimeZone: "america-new-york",
          source: "hlc3",
        }).vwap,
      ).toEqual([]);
    }

    // 2. Weekly / Monthly / Yearly anchors MUST continue working normally
    const weeklyVwap = computeFineGrainedSessionVwap(multiDay5m, null, 300, {
      anchor: "week",
      sessionTimeZone: "america-new-york",
    });
    expect(weeklyVwap.vwap.length).toBe(multiDay5m.length);
    const monthlyVwap = computeFineGrainedSessionVwap(multiDay15m, null, 900, {
      anchor: "month",
      sessionTimeZone: "america-new-york",
    });
    expect(monthlyVwap.vwap.length).toBe(multiDay15m.length);

    // 3. Multi-day check: Day 1 (09:30 ET) IS complete, Day 2 (09:45 ET) is INCOMPLETE.
    // Day 1 MUST NOT prove Day 2 is covered!
    const cov = assessVwapSessionCoverage(multiDay1m, {
      anchor: "session",
      sessionTimeZone: "america-new-york",
      anchorAtRegularOpen: true,
    });
    const d1Key = getNyTradingDayKey(day1_0930);
    const d2Key = getNyTradingDayKey(day2_0930);
    expect(cov.days?.[d1Key]?.isComplete).toBe(true);
    expect(cov.days?.[d2Key]?.isComplete).toBe(false);
    expect(cov.isComplete).toBe(false);

    const fineMixed = computeFineGrainedSessionVwap(multiDay5m, multiDay1m, 300, {
      anchor: "session",
      sessionTimeZone: "america-new-york",
      anchorAtRegularOpen: true,
    });
    // Day 1 emits exact 6 bars, Day 2 (incomplete) emits 0 bars!
    expect(fineMixed.vwap.every((pt) => getNyTradingDayKey(pt.time) === d1Key)).toBe(true);
    expect(fineMixed.vwap).toHaveLength(6);

    // 4. Valid vs Invalid priorSessionSeed checks
    const fullDay2_0930To1000: Candle[] = [
      ...Array.from({ length: 15 }, (_, i) => ({
        time: day2_0930 + i * 60,
        open: 20 + i * 0.05,
        high: 20.2 + i * 0.05,
        low: 19.8 + i * 0.05,
        close: 20.1 + i * 0.05,
        volume: 12_000,
      })),
      ...day2LateBars1m,
    ];
    const validSeed = computeVwapSessionSeedsFromBars(
      fullDay2_0930To1000,
      day2_0930 + 15 * 60,
      "hlc3",
    ).regular!;
    expect(validSeed).not.toBeNull();
    const seededFull = computeFineGrainedSessionVwap(day2LateBars5m, day2LateBars1m, 300, {
      anchor: "session",
      sessionTimeZone: "america-new-york",
      anchorAtRegularOpen: true,
      source: "hlc3",
      priorSessionSeed: { ...validSeed, source: "hlc3", coveredUntilSec: day2_0930 + 15 * 60 },
    });
    const unwindowedFull = vwapBands(fullDay2_0930To1000, {
      anchor: "session",
      sessionTimeZone: "america-new-york",
      anchorAtRegularOpen: true,
      source: "hlc3",
    });
    expect(seededFull.vwap.at(-1)!.value).toBeCloseTo(unwindowedFull.vwap.at(-1)!.value, 8);

    // Invalid seeds MUST be rejected (mismatching source, future coveredUntilSec, wrong bucket, cumVol<=0)
    for (const badSeed of [
      { ...validSeed, cumVol: 0 },
      { ...validSeed, anchorBucket: d1Key },
      { ...validSeed, source: "close" as const },
      { ...validSeed, coveredUntilSec: day2_0930 + 20 * 60 },
    ]) {
      const resBad = computeFineGrainedSessionVwap(day2LateBars5m, day2LateBars1m, 300, {
        anchor: "session",
        sessionTimeZone: "america-new-york",
        anchorAtRegularOpen: true,
        source: "hlc3",
        priorSessionSeed: badSeed,
      });
      expect(resBad.vwap).toEqual([]);
    }
  });

  it("L. Volumen e integridad de subintervalos: detecta huecos intermedios, deduplica/ordena, diferencia periodos sin operaciones y excluye volumen parcial en Volume MA20", () => {
    registerDynamicSymbol({
      name: "VOLCOV",
      displayName: "Volume Coverage Corp",
      category: "STOCKS",
      initialPrice: 12.0,
      tickSize: 0.01,
      exchange: "NASDAQ",
    });

    const t0930 = Math.floor(Date.UTC(2026, 10, 24, 14, 30, 0) / 1000);
    const parent5m: Candle = {
      time: t0930,
      open: 12.0,
      high: 13.5,
      low: 11.8,
      close: 12.9,
      volume: 50_000,
    };

    // 1. Sub-candles have 09:30 and 09:34, missing 09:31..09:33 AND missing 30,000 volume!
    // Must NEVER be accepted just because first & last bar span [09:30, 09:35)!
    const gappedWithDuplicate: Candle[] = [
      { time: t0930 + 4 * 60, open: 12.4, high: 12.95, low: 12.3, close: 12.9, volume: 10_000 }, // out of order
      { time: t0930, open: 12.0, high: 12.2, low: 11.8, close: 12.1, volume: 10_000 },
      { time: t0930, open: 12.0, high: 12.2, low: 11.8, close: 12.1, volume: 10_000 }, // duplicate!
    ];
    expect(
      validateSubIntervalCoverage(gappedWithDuplicate, 60, parent5m, 300, t0930, t0930 + 300),
    ).toBe(false);

    // aggregateCandlesWithIntegrity excludes incomplete bucket when requireCompleteBuckets=true
    const aggCheck = aggregateCandlesWithIntegrity(gappedWithDuplicate, 300, {
      sourceStepSec: 60,
      requireCompleteBuckets: true,
    });
    expect(aggCheck.duplicateInputCount).toBe(1);
    expect(aggCheck.outOfOrderInputCount).toBe(2);
    expect(aggCheck.incompleteBucketTimes).toEqual([t0930]);
    expect(aggCheck.candles).toEqual([]);

    // In Replay partial window with missing 1m bars -> returns missing-data (NOT ok / NOT parent!)
    setRealStockSeries("VOLCOV", "5m", [
      parent5m,
      { time: t0930 + 300, open: 12.9, high: 13.1, low: 12.7, close: 13.0, volume: 20_000 },
    ]);
    setRealStockSeries("VOLCOV", "1m", gappedWithDuplicate);
    expect(resolvePartialCandleWindow("VOLCOV", parent5m, "5m", t0930, t0930 + 300)).toEqual({
      status: "missing-data",
    });
    expect(buildPartialCandleRange("VOLCOV", parent5m, "5m", t0930, t0930 + 300)).toBeNull();

    // 2. Provider omits quiet zero-trade minutes inside sparse session, where 100% of parent OHLCV is accounted for:
    const sparseZeroTrade1m: Candle[] = [
      { time: t0930, open: 12.0, high: 12.5, low: 11.8, close: 12.3, volume: 20_000 },
      { time: t0930 + 4 * 60, open: 12.3, high: 13.5, low: 12.2, close: 12.9, volume: 30_000 },
    ];
    expect(
      validateSubIntervalCoverage(sparseZeroTrade1m, 60, parent5m, 300, t0930, t0930 + 300),
    ).toBe(true);

    // 3. Volume MA20 excludes incomplete partial bar volume and recalculates cleanly on step/stepBack
    const contBars1m: Candle[] = Array.from({ length: 130 }, (_, i) => ({
      time: t0930 + i * 60,
      open: 10,
      high: 10.5,
      low: 9.8,
      close: 10.2,
      volume: 1_000, // every 1m = 1,000 -> every full 5m = 5,000
    }));
    const fullBars5m = aggregateCandles(contBars1m, 300) as Candle[];
    expect(fullBars5m[0]!.volume).toBe(5_000);
    const fullBars15m = aggregateCandles(contBars1m, 900) as Candle[];
    expect(fullBars15m[0]!.volume).toBe(15_000);

    // Suppose we have 21 complete 5m bars (5,000 each) + 1 partial 5m bar at index 21 (2 minutes = 2,000 vol)
    const simAtMidBar = t0930 + 21 * 300 + 120; // 2m into bar #21
    const visWithPartial = [
      ...fullBars5m.slice(0, 21),
      { ...fullBars5m[21]!, volume: 2_000 },
    ];
    const maReplay = calculateReplayVolumeMa(
      visWithPartial.map((c) => ({ time: c.time as Time, value: c.volume })),
      300,
      simAtMidBar,
      20,
    );
    // Only bars 0..20 (21 complete bars of 5,000) are included -> 2 MA points, both strictly 5,000 (NOT dragged down to 4,850 by incomplete 2,000!)
    expect(maReplay).toHaveLength(2);
    expect(maReplay.at(-1)!.value).toBe(5_000);

    invalidateStockSeries("VOLCOV");
  });

  it("M. EMA calentamiento, cambios 1m->5m->15m->1h->4h con retroceso y bloqueo sin fallback en TradingPage.resolveMainChartCandles", async () => {
    registerDynamicSymbol({
      name: "WARMUPCHK",
      displayName: "Warmup & Replay Integrity",
      category: "STOCKS",
      initialPrice: 20.0,
      tickSize: 0.01,
      exchange: "NASDAQ",
    });

    // 1. TradingPage resolveMainChartCandles MUST NEVER return live candles when Replay phase === "active", even if replayVisible is null/empty
    const liveToday: Candle[] = [
      { time: 1_800_000_000, open: 999, high: 999, low: 999, close: 999, volume: 123_456 },
    ];
    expect(
      resolveMainChartCandles({
        phase: "active",
        replayVisible: null,
        replayTimeframe: "5m",
        replaySimTimeSec: 0,
        selectedSymbol: "WARMUPCHK",
        timeframe: "5m",
        liveCandles: liveToday,
      }),
    ).toEqual([]);
    expect(
      resolveMainChartCandles({
        phase: "active",
        replayVisible: [],
        replayTimeframe: "5m",
        replaySimTimeSec: 1_795_000_000,
        selectedSymbol: "WARMUPCHK",
        timeframe: "5m",
        liveCandles: liveToday,
      }),
    ).toEqual([]);

    // 2. EMA warm-up validation: 10 bars is insufficient for EMA(20) (`min = 60`), returns points=[] with isWarmedUp=false
    const t0400 = Math.floor(Date.UTC(2026, 10, 24, 9, 0, 0) / 1000);
    const short1m: Candle[] = Array.from({ length: 10 }, (_, i) => ({
      time: t0400 + i * 60,
      open: 20,
      high: 20.2,
      low: 19.8,
      close: 20 + i * 0.1,
      volume: 1_000,
    }));
    const replayShortEma = computeReplayEmaWithWarmup(short1m, 20);
    expect(replayShortEma.isWarmedUp).toBe(false);
    expect(replayShortEma.points).toEqual([]);
    expect(assessEmaWarmup(10, [8, 20]).isSufficient).toBe(false);
    expect(computeMinEmaWarmupBars(20)).toBe(60);

    // Even if 1 bar exists in cache on targetDate, ensureReplayHistoricalDataLoaded forces fetch for deeper EMA warm-up
    const deep1m: Candle[] = Array.from({ length: 280 }, (_, i) => ({
      time: t0400 + i * 60,
      open: 20 + i * 0.01,
      high: 20.2 + i * 0.01,
      low: 19.9 + i * 0.01,
      close: 20.05 + i * 0.01,
      volume: 2_000 + i * 5,
    }));
    const deep1mEarlyOnly = deep1m.slice(-10); // insufficient warmup initially cached!
    setRealStockSeries("WARMUPCHK", "1m", deep1mEarlyOnly);

    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ symbol: "WARMUPCHK", candles: deep1m }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const targetTime = deep1m.at(-20)!.time;
    const ensureRes = await ensureReplayHistoricalDataLoaded({
      symbol: "WARMUPCHK",
      primaryTimeframe: "1m",
      targetDate: "2026-11-24",
      targetTimeSec: targetTime,
      emaPeriods: [8, 50],
    });
    expect(fetchMock).toHaveBeenCalled();
    expect(ensureRes.ok).toBe(true);
    expect(ensureRes.emaWarmup?.isSufficient).toBe(true);

    // 3. Test mid-candle switch 15m -> 4h (2026-11-24 09:00 UTC + 16*15m = 13:00 UTC -> mid 4h candle [12:00..16:00)) and stepBack()
    const bars1h = aggregateCandles(deep1m, 3600) as Candle[];
    const bars4h = aggregateCandles(deep1m, 14_400) as Candle[];
    setRealStockSeries("WARMUPCHK", "1h", bars1h);
    setRealStockSeries("WARMUPCHK", "4h", bars4h);

    const t1200Utc = Math.floor(Date.UTC(2026, 10, 24, 12, 0, 0) / 1000);
    const barAt1215 = deep1m.find((b) => b.time === t1200Utc + 15 * 60)!;
    expect(barAt1215).toBeDefined();

    // Start at 12:15 UTC on 1m -> simTimeSec = 12:16 UTC
    expect(useReplayStore.getState().start("WARMUPCHK", "1m", barAt1215.time).ok).toBe(true);
    const simBeforeSwitch = useReplayStore.getState().simTimeSec;
    expect(useReplayStore.getState().changeTimeframe("1h")).toBe(true);
    expect(useReplayStore.getState().simTimeSec).toBe(simBeforeSwitch);
    expect(useReplayStore.getState().visible!.at(-1)!.close).toBe(barAt1215.close);

    // Rewind after switching to 1h -> moves cleanly to the closed 11:00..12:00 UTC candle (`simTimeSec = 12:00 UTC`)
    useReplayStore.getState().stepBack();
    expect(useReplayStore.getState().simTimeSec).toBe(t1200Utc);
    expect(useReplayStore.getState().visible!.at(-1)!.time).toBe(t1200Utc - 3600);

    useReplayStore.getState().stop();
    invalidateStockSeries("WARMUPCHK");
  });
});
