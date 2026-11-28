import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { IChartApi, ISeriesApi } from "lightweight-charts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useChartDrawings } from "../hooks/useChartDrawings.ts";
import { FAVORITES_META_STORAGE_KEY, FAVORITES_STORAGE_KEY } from "../hooks/useFavoriteSymbols.ts";
import { DrawingToolsManager } from "../lib/chart-plugins/drawing-tools/manager.ts";
import {
  filterExtendedHoursCandles,
  findPreMarketSessionRuns,
  isUsEquityExchange,
} from "../lib/chart-plugins/extended-hours-primitive.ts";
import { ema, vwapBands } from "../lib/indicators.ts";
import {
  computePreMarketRelativeVolume,
  computeRegularRelativeVolume,
  filterScreenerRows,
  getUsPreMarketSessionState,
  getUsRegularSessionState,
  isSameNyTradingDay,
} from "../lib/premarketScreener.ts";
import { ChartToolbar } from "../pages/trading/ChartToolbar.tsx";
import type { DrawingLine } from "../pages/trading/constants.ts";
import { MultiChartPane } from "../pages/trading/MultiChartPane.tsx";
import { StockScreenerTab } from "../pages/trading/StockScreenerTab.tsx";
import { WatchlistPanel } from "../pages/trading/WatchlistPanel.tsx";
import { calculateVolumeMa } from "../pages/trading/utils.ts";
import { api } from "../services/api.ts";
import { toIbkrContract } from "../server/ibkrEngine.ts";
import { subscribeChannel } from "../services/demo/bus.ts";
import {
  getHistory,
  invalidateStockSeries,
  setRealStockSeries,
} from "../services/demo/candles.ts";
import { applyLiveStockTrade } from "../services/demo/feed.ts";
import { getDemoSymbol, registerDynamicSymbol } from "../services/demo/instruments.ts";
import {
  getReplaySliceForTimeframe,
  pickFinestTimeframe,
  useReplayStore,
} from "../services/demo/replay.ts";
import type { Candle } from "../services/schemas.ts";

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
    canvas: { width: 600, height: 400 },
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
  const spy = vi
    .spyOn(HTMLCanvasElement.prototype, "getContext")
    // @ts-expect-error minimal 2D context mock for jsdom
    .mockImplementation(() => fakeCtx);
  return () => {
    spy.mockRestore();
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      configurable: true,
      value: origMatchMedia,
    });
    globalThis.ResizeObserver = origResizeObserver;
  };
}

function aggregateTo5m(bars1m: Candle[]): Candle[] {
  const buckets = new Map<number, Candle>();
  for (const b of bars1m) {
    const t5 = Math.floor(b.time / 300) * 300;
    const ex = buckets.get(t5);
    if (!ex) {
      buckets.set(t5, { ...b, time: t5 });
    } else {
      ex.high = Math.max(ex.high, b.high);
      ex.low = Math.min(ex.low, b.low);
      ex.close = b.close;
      ex.volume += b.volume;
    }
  }
  return Array.from(buckets.values()).sort((a, b) => a.time - b.time);
}

describe("Dual-Chart Synchronized Bar Replay & Deep Price/Volume/VWAP/EMA Audit", () => {
  beforeEach(() => {
    localStorage.clear();
    useReplayStore.getState().stop();
  });

  afterEach(() => {
    cleanup();
    useReplayStore.getState().stop();
    invalidateStockSeries("CUETEST");
    invalidateStockSeries("GAPTEST");
  });

  it("picks the finest active timeframe across split-chart panes", () => {
    expect(pickFinestTimeframe(["5m", "1m"])).toBe("1m");
    expect(pickFinestTimeframe(["1m", "5m"])).toBe("1m");
    expect(pickFinestTimeframe(["4h", "15m", "1h"])).toBe("15m");
    expect(pickFinestTimeframe(["1d", "4h"])).toBe("4h");
    expect(pickFinestTimeframe(["5m"])).toBe("5m");
  });

  it("steps 5m and 1m charts in 100% lockstep with zero look-ahead on OHLC, Volume, EMA, and VWAP", () => {
    registerDynamicSymbol({
      name: "CUETEST",
      displayName: "Cue Biopharma Test",
      category: "STOCKS",
      initialPrice: 4.5,
      tickSize: 0.01,
      exchange: "NASDAQ",
    });

    // Build 45 minutes of realistic 1m bars starting 2026-11-24 09:30 ET (14:30 UTC)
    const startSec = Math.floor(Date.UTC(2026, 10, 24, 14, 30, 0) / 1000);
    const bars1m: Candle[] = [];
    for (let i = 0; i < 45; i++) {
      const base = 3.0 + i * 0.02;
      // Inject a big spike ONLY at minute i = 13 (09:43 ET, inside the 09:40..09:45 5m bar!)
      const isSpikeMinute = i === 13;
      const open = Number(base.toFixed(2));
      const close = isSpikeMinute ? 6.5 : Number((base + 0.03).toFixed(2));
      const high = isSpikeMinute ? 7.25 : Number((close + 0.04).toFixed(2));
      const low = Number((open - 0.02).toFixed(2));
      const volume = isSpikeMinute ? 250_000 : 10_000 + i * 500;
      bars1m.push({
        time: startSec + i * 60,
        open,
        high,
        low,
        close,
        volume,
      });
    }
    const bars5m = aggregateTo5m(bars1m);
    setRealStockSeries("CUETEST", "1m", bars1m);
    setRealStockSeries("CUETEST", "5m", bars5m);

    // Cut Replay at 09:40 ET (minute index 10 -> first minute of the 09:40..09:45 5m candle)
    const t0940 = startSec + 10 * 60;
    const startRes = useReplayStore.getState().start("CUETEST", "1m", t0940);
    expect(startRes.ok).toBe(true);

    const s0 = useReplayStore.getState();
    expect(s0.simTimeSec).toBe(t0940 + 60); // 09:41:00 exclusive

    const slice1mAt0940 = getReplaySliceForTimeframe("CUETEST", "1m", s0.simTimeSec);
    const slice5mAt0940 = getReplaySliceForTimeframe("CUETEST", "5m", s0.simTimeSec);

    // 1m has 11 bars (09:30..09:40); 5m has 3 bars (09:30, 09:35, and partial 09:40)
    expect(slice1mAt0940).toHaveLength(11);
    expect(slice5mAt0940).toHaveLength(3);

    // CRITICAL ZERO LOOK-AHEAD CHECK:
    // At 09:40 (before the 09:43 spike to $7.25 / 250k vol), the 09:40 5m bar MUST match ONLY the 09:40 1m bar!
    const partial5m0 = slice5mAt0940[slice5mAt0940.length - 1]!;
    const bar1m0940 = bars1m[10]!;
    expect(partial5m0.time).toBe(t0940);
    expect(partial5m0.open).toBeCloseTo(bar1m0940.open, 6);
    expect(partial5m0.high).toBeCloseTo(bar1m0940.high, 6);
    expect(partial5m0.high).toBeLessThan(4.0); // Spike ($7.25) is strictly hidden!
    expect(partial5m0.low).toBeCloseTo(bar1m0940.low, 6);
    expect(partial5m0.close).toBeCloseTo(bar1m0940.close, 6);
    expect(partial5m0.volume).toBe(bar1m0940.volume);

    // Step minute-by-minute through 09:41, 09:42, 09:43, 09:44
    for (let offset = 1; offset <= 4; offset++) {
      useReplayStore.getState().step();
      const st = useReplayStore.getState();
      const s1m = getReplaySliceForTimeframe("CUETEST", "1m", st.simTimeSec);
      const s5m = getReplaySliceForTimeframe("CUETEST", "5m", st.simTimeSec);

      expect(s1m).toHaveLength(11 + offset);
      expect(s5m).toHaveLength(3); // Still inside the same 09:40..09:45 5m bucket!

      const revealedInBucket = bars1m.slice(10, 10 + offset + 1);
      const expectedHigh = Math.max(...revealedInBucket.map((b) => b.high));
      const expectedLow = Math.min(...revealedInBucket.map((b) => b.low));
      const expectedClose = revealedInBucket[revealedInBucket.length - 1]!.close;
      const expectedVol = revealedInBucket.reduce((acc, b) => acc + b.volume, 0);

      const active5m = s5m[s5m.length - 1]!;
      const active1m = s1m[s1m.length - 1]!;
      expect(active5m.close).toBeCloseTo(active1m.close, 6);
      expect(active5m.close).toBeCloseTo(expectedClose, 6);
      expect(active5m.high).toBeCloseTo(expectedHigh, 6);
      expect(active5m.low).toBeCloseTo(expectedLow, 6);
      expect(active5m.volume).toBe(expectedVol);
    }

    // Next step (09:45) opens the brand-new 09:45 5m candle on the 5m chart too!
    useReplayStore.getState().step();
    const st0945 = useReplayStore.getState();
    const s1m0945 = getReplaySliceForTimeframe("CUETEST", "1m", st0945.simTimeSec);
    const s5m0945 = getReplaySliceForTimeframe("CUETEST", "5m", st0945.simTimeSec);
    expect(s1m0945).toHaveLength(16);
    expect(s5m0945).toHaveLength(4);
    expect(s5m0945[3]!.time).toBe(startSec + 15 * 60);
    expect(s5m0945[3]!.close).toBeCloseTo(s1m0945[15]!.close, 6);

    // Step backward (-1) rewinds BOTH 1m and 5m back to 09:44 cleanly!
    useReplayStore.getState().stepBack();
    const stRewound = useReplayStore.getState();
    const s1mRew = getReplaySliceForTimeframe("CUETEST", "1m", stRewound.simTimeSec);
    const s5mRew = getReplaySliceForTimeframe("CUETEST", "5m", stRewound.simTimeSec);
    expect(s1mRew).toHaveLength(15);
    expect(s5mRew).toHaveLength(3);
    expect(s5mRew[2]!.close).toBeCloseTo(s1mRew[14]!.close, 6);
  });

  it("never leaks future gap-up open prices on sparse pre-market 5m bars before the trade minute prints", () => {
    registerDynamicSymbol({
      name: "GAPTEST",
      displayName: "Gap Biotech",
      category: "STOCKS",
      initialPrice: 2.0,
      tickSize: 0.01,
      exchange: "NASDAQ",
    });

    // 2026-11-24 07:20 ET = 12:20 UTC
    const t0720 = Math.floor(Date.UTC(2026, 10, 24, 12, 20, 0) / 1000);
    // Trades at 07:20..07:29 around $2.00; NO trades at 07:30, 07:31, 07:32; breaking news jump at 07:33 ($4.20)!
    const sparse1m: Candle[] = [];
    for (let m = 0; m < 10; m++) {
      sparse1m.push({
        time: t0720 + m * 60,
        open: 2.0,
        high: 2.05,
        low: 1.98,
        close: 2.0,
        volume: 5_000,
      });
    }
    // Jump at 07:33 ET (m = 13) and 07:34 ET (m = 14) and 07:35 ET (m = 15)
    sparse1m.push(
      { time: t0720 + 13 * 60, open: 4.2, high: 4.6, low: 4.1, close: 4.5, volume: 180_000 },
      { time: t0720 + 14 * 60, open: 4.5, high: 4.8, low: 4.4, close: 4.7, volume: 120_000 },
      { time: t0720 + 15 * 60, open: 4.7, high: 4.9, low: 4.6, close: 4.8, volume: 90_000 },
    );
    const sparse5m = aggregateTo5m(sparse1m);
    // Note: sparse5m has a bar at 07:30 (t0720 + 600) whose open is $4.20 (from the 07:33 trade!)
    expect(sparse5m.find((b) => b.time === t0720 + 600)?.open).toBe(4.2);

    setRealStockSeries("GAPTEST", "1m", sparse1m);
    setRealStockSeries("GAPTEST", "5m", sparse5m);

    // At simTimeSec = 07:31 ET (t0720 + 11 * 60), the 07:33 news trade has NOT happened yet!
    const sliceAt0731 = getReplaySliceForTimeframe("GAPTEST", "5m", t0720 + 11 * 60);
    expect(sliceAt0731[sliceAt0731.length - 1]!.time).toBe(t0720 + 300); // 07:25 bar ($2.00)
    expect(sliceAt0731[sliceAt0731.length - 1]!.close).toBe(2.0);

    // Once simTimeSec reaches 07:34 ET (t0720 + 14 * 60, after 07:33 trade), 07:30 5m bar appears with $4.50 close!
    const sliceAt0734 = getReplaySliceForTimeframe("GAPTEST", "5m", t0720 + 14 * 60);
    expect(sliceAt0734[sliceAt0734.length - 1]!.time).toBe(t0720 + 600);
    expect(sliceAt0734[sliceAt0734.length - 1]!.close).toBe(4.5);
  });

  it("renders MultiChartPane synchronized to Replay price and badge while ignoring live ticks", () => {
    const restoreCanvas = installCanvasMock();
    try {
      const real15m = getHistory("BTCUSD", "15m");
      const real1h = getHistory("BTCUSD", "1h");
      const target1hBar = real1h.find(
        (b, idx) => idx < real1h.length - 5 && b.time >= real15m[25]!.time,
      )!;
      expect(target1hBar).toBeDefined();
      const startRes = useReplayStore.getState().start("BTCUSD", "1h", target1hBar.time);
      expect(startRes.ok).toBe(true);
      const simTimeSec = useReplayStore.getState().simTimeSec;
      const expectedReplayBars = getReplaySliceForTimeframe("BTCUSD", "15m", simTimeSec);
      expect(expectedReplayBars.length).toBeGreaterThan(20);
      const expectedReplayClose = expectedReplayBars[expectedReplayBars.length - 1]!.close;

      const { getByTestId, container, rerender, unmount } = render(
        React.createElement(MultiChartPane, {
          slotId: 1,
          mainSymbol: "BTCUSD",
          defaultTimeframe: "15m",
          timeframe: "15m",
          isDark: true,
          symbols: [{ name: "BTCUSD", displayName: "Bitcoin / USD", category: "CRYPTO" }],
          // Pass a fake modern $999,999 live tick — MultiChartPane MUST ignore it during Replay!
          ticks: { BTCUSD: { bid: 999_999, ask: 999_999, timestamp: Date.now() } },
          onPromoteToMain: () => {},
          isReplaying: true,
          replaySimTimeSec: simTimeSec,
          replayPicking: true,
          onPickReplayBar: () => {},
        }),
      );

      expect(getByTestId("pane-1-replay-badge").textContent).toBe("Replay");
      expect(container.innerHTML).not.toContain("999,999");
      expect(expectedReplayClose).toBeLessThan(500_000);
      expect(container.querySelector(".cursor-crosshair")).not.toBeNull();

      // Stepping forward advances simTimeSec and updates MultiChartPane smoothly without crashing
      useReplayStore.getState().step();
      const nextSimTimeSec = useReplayStore.getState().simTimeSec;
      expect(nextSimTimeSec).toBeGreaterThan(simTimeSec);
      rerender(
        React.createElement(MultiChartPane, {
          slotId: 1,
          mainSymbol: "BTCUSD",
          defaultTimeframe: "15m",
          timeframe: "15m",
          isDark: true,
          symbols: [{ name: "BTCUSD", displayName: "Bitcoin / USD", category: "CRYPTO" }],
          ticks: { BTCUSD: { bid: 99_999, ask: 99_999, timestamp: Date.now() } },
          onPromoteToMain: () => {},
          isReplaying: true,
          replaySimTimeSec: nextSimTimeSec,
          replayPicking: false,
          onPickReplayBar: () => {},
        }),
      );
      expect(getByTestId("pane-1-replay-badge").textContent).toBe("Replay");
      expect(container.querySelector(".cursor-crosshair")).toBeNull();
      unmount();
    } finally {
      restoreCanvas();
    }
  });

  it("recognizes all US equity exchanges for NY VWAP, IEX stream eligibility, Volume MA(20), and RTH vs Extended VWAP", () => {
    // 1. Exchange classification
    expect(isUsEquityExchange("NASDAQ")).toBe(true);
    expect(isUsEquityExchange("NASDAQ CM")).toBe(true);
    expect(isUsEquityExchange("NYSE American")).toBe(true);
    expect(isUsEquityExchange("NYSEArca")).toBe(true);
    expect(isUsEquityExchange("Cboe BZX")).toBe(true);
    expect(isUsEquityExchange("Other OTC")).toBe(true);
    expect(isUsEquityExchange("BME")).toBe(false);

    registerDynamicSymbol({
      name: "AMEXTEST",
      displayName: "AMEX Runner",
      category: "STOCKS",
      initialPrice: 0.65,
      exchange: "NYSE American",
    });
    expect(getDemoSymbol("AMEXTEST")?.tickSize).toBe(0.0001);
    expect(toIbkrContract("AMEXTEST", "AMEX").primaryExch).toBe("AMEX");

    // Updating price above $1 updates tickSize cleanly to 0.01
    registerDynamicSymbol({
      name: "AMEXTEST",
      category: "STOCKS",
      initialPrice: 1.85,
      exchange: "NYSE American",
    });
    expect(getDemoSymbol("AMEXTEST")?.tickSize).toBe(0.01);

    // 2. Volume MA(20) exact rolling mean
    const volHist = Array.from({ length: 25 }, (_, idx) => ({
      time: (1_700_000_000 + idx * 60) as unknown as import("lightweight-charts").Time,
      value: (idx + 1) * 100,
    }));
    const volMa = calculateVolumeMa(volHist, 20);
    expect(volMa).toHaveLength(6);
    // First 20 bars: 100..2000 -> mean = 1050
    expect(volMa[0]!.value).toBeCloseTo(1050, 6);
    // Bars 6..25: 600..2500 -> mean = 1550
    expect(volMa[5]!.value).toBeCloseTo(1550, 6);

    // 3. Extended Hours vs Regular Session (RTH) VWAP & EMA consistency
    const tPre0800 = Math.floor(Date.UTC(2026, 10, 24, 13, 0, 0) / 1000); // 08:00 ET
    const tRth0930 = Math.floor(Date.UTC(2026, 10, 24, 14, 30, 0) / 1000); // 09:30 ET
    const tRth0935 = Math.floor(Date.UTC(2026, 10, 24, 14, 35, 0) / 1000); // 09:35 ET
    const sessionBars: Candle[] = [
      { time: tPre0800, open: 4, high: 4, low: 4, close: 4, volume: 100_000 },
      { time: tRth0930, open: 6, high: 6, low: 6, close: 6, volume: 100_000 },
      { time: tRth0935, open: 8, high: 8, low: 8, close: 8, volume: 200_000 },
    ];

    // Extended session VWAP includes 08:00 ET pre-market: (4*100k + 6*100k + 8*200k)/400k = 6.5
    const extVwap = vwapBands(sessionBars, {
      anchor: "session",
      sessionTimeZone: "america-new-york",
      source: "hlc3",
    });
    expect(extVwap.vwap[2]!.value).toBeCloseTo(6.5, 6);

    // Regular session (Sesión normal) filters out 08:00 ET -> RTH VWAP = (6*100k + 8*200k)/300k = 7.333333
    const rthOnly = filterExtendedHoursCandles(sessionBars, false, null, "NASDAQ");
    expect(rthOnly).toHaveLength(2);
    const rthVwap = vwapBands(rthOnly, {
      anchor: "session",
      sessionTimeZone: "america-new-york",
      source: "hlc3",
    });
    expect(rthVwap.vwap[1]!.value).toBeCloseTo(22 / 3, 6);

    // EMA(2) check: seed = (6+8)/2 = 7
    const ema2 = ema(rthOnly, 2);
    expect(ema2).toHaveLength(1);
    expect(ema2[0]!.value).toBeCloseTo(7, 6);
  });

  it("hot-swaps active Replay to real 1m stock candles when async 1m history arrives after starting on 5m", () => {
    registerDynamicSymbol({
      name: "HOTSWAP",
      displayName: "HotSwap Stock",
      category: "STOCKS",
      initialPrice: 5.0,
      tickSize: 0.01,
      exchange: "NASDAQ",
    });

    const t0930 = Math.floor(Date.UTC(2026, 10, 24, 14, 30, 0) / 1000);
    const bars1m: Candle[] = Array.from({ length: 20 }, (_, i) => ({
      time: t0930 + i * 60,
      open: 5 + i * 0.05,
      high: 5.1 + i * 0.05,
      low: 4.95 + i * 0.05,
      close: 5.04 + i * 0.05,
      volume: 12_345 + i * 100,
    }));
    const bars5m = aggregateTo5m(bars1m);

    // Initially ONLY 5m is loaded: switching to 1m before real 1m bars arrive MUST NOT subdivide 5m artificially
    setRealStockSeries("HOTSWAP", "5m", bars5m);
    const res = useReplayStore.getState().start("HOTSWAP", "5m", t0930 + 5 * 60);
    expect(res.ok).toBe(true);
    const rejected1m = useReplayStore.getState().changeTimeframe("1m");
    expect(rejected1m).toBe(false);
    expect(useReplayStore.getState().timeframe).toBe("5m");
    const simBefore = useReplayStore.getState().simTimeSec;

    // Once real 1m stock bars arrive from IBKR, switching to 1m succeeds with 100% authentic 1m OHLCV!
    setRealStockSeries("HOTSWAP", "1m", bars1m);
    const accepted1m = useReplayStore.getState().changeTimeframe("1m");
    expect(accepted1m).toBe(true);
    const afterSwap = useReplayStore.getState();
    expect(afterSwap.simTimeSec).toBe(simBefore);
    const lastVisible = afterSwap.visible![afterSwap.visible!.length - 1]!;
    // Must match exact real 1m bar volume (12_345 + 9 * 100 = 13_245) rather than randomized subdivision weight!
    expect(lastVisible.volume).toBe(12_345 + 9 * 100);
    expect(lastVisible.close).toBeCloseTo(5.04 + 9 * 0.05, 6);
    invalidateStockSeries("HOTSWAP");
  });

  it("keeps Long/Short position box width constant when dragged horizontally across overnight gaps and right whitespace", () => {
    const spacing = 10;
    const fri1550 = Math.floor(Date.UTC(2026, 10, 20, 20, 50, 0) / 1000);
    const mon0400 = fri1550 + 11 * 3600 + 20 * 60; // overnight gap
    const bars: Candle[] = [
      ...Array.from({ length: 15 }, (_, i) => ({
        time: fri1550 + i * 60,
        open: 10,
        high: 11,
        low: 9,
        close: 10.5,
        volume: 1000,
      })),
      ...Array.from({ length: 20 }, (_, i) => ({
        time: mon0400 + i * 60,
        open: 10.5,
        high: 11.5,
        low: 9.5,
        close: 11,
        volume: 1000,
      })),
    ];

    const timeToIdx = new Map(bars.map((b, idx) => [b.time, idx]));
    const container = document.createElement("div");
    Object.defineProperty(container, "clientWidth", { value: 600, configurable: true });
    Object.defineProperty(container, "clientHeight", { value: 400, configurable: true });
    container.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 600, height: 400, right: 600, bottom: 400, x: 0, y: 0, toJSON: () => {} }) as DOMRect;
    document.body.appendChild(container);

    const mockTimeScale = {
      width: () => 560,
      height: () => 28,
      options: () => ({ barSpacing: spacing }),
      timeToCoordinate: (t: number) => {
        const idx = timeToIdx.get(t);
        return idx != null ? idx * spacing : null;
      },
      coordinateToTime: (x: number) => {
        const idx = Math.round(x / spacing);
        return idx >= 0 && idx < bars.length ? bars[idx]!.time : null;
      },
      coordinateToLogical: (x: number) => x / spacing,
      logicalToCoordinate: (idx: number) => idx * spacing,
    };
    const mockChart = {
      timeScale: () => mockTimeScale,
      priceScale: () => ({ width: () => 40 }),
      applyOptions: () => {},
    } as unknown as IChartApi;
    const mockSeries = {
      data: () => bars,
      coordinateToPrice: (y: number) => 20 - (y / 400) * 20,
      priceToCoordinate: (p: number) => ((20 - p) / 20) * 400,
      attachPrimitive: () => {},
      detachPrimitive: () => {},
      priceFormatter: () => ({ format: (p: number) => p.toFixed(2) }),
    } as unknown as ISeriesApi<"Candlestick">;

    const updates: DrawingLine[] = [];
    const manager = new DrawingToolsManager({
      chart: mockChart,
      series: mockSeries,
      container,
      intervalSec: 60,
      timeframe: "1m",
      callbacks: {
        onAdd: () => {},
        onUpdate: (d) => updates.push(d),
        onRemove: () => {},
        onToolFinished: () => {},
      },
    });

    // Position box placed across the Friday->Monday overnight gap: 10 bars wide (idx 10..20),
    // even though wall-clock delta is >11 hours!
    const gapBox: DrawingLine = {
      id: "pos-gap-1",
      type: "position",
      side: "long",
      color: "#089981",
      price: 10.5,
      targetPrice: 12.5,
      stopPrice: 9.5,
      time: bars[10]!.time,
      time2: bars[20]!.time,
      createdTf: "1m",
    };
    manager.setDrawings([gapBox]);

    // 1. Body-drag rightward onto continuous Monday bars (+100px = +10 bars -> idx 20..30)
    // Click in the TP body slightly off-center so we hit "body" rather than the center entry handle.
    const entryY = 400 * ((20 - 10.5) / 20);
    fireEvent.mouseDown(container, { button: 0, clientX: 130, clientY: entryY - 15 });
    fireEvent.mouseMove(window, { clientX: 230, clientY: entryY - 15 });
    fireEvent.mouseUp(window, { clientX: 230, clientY: entryY - 15 });

    const movedContinuous = updates[updates.length - 1];
    expect(movedContinuous).toBeDefined();
    expect(timeToIdx.get(movedContinuous!.time!)).toBe(20);
    expect(timeToIdx.get(movedContinuous!.time2!)).toBe(30);
    // Must NOT preserve the 11h gap in seconds (~40,000s = 670 bars)!
    expect(movedContinuous!.time2! - movedContinuous!.time!).toBe(600);

    // 2. Body-drag further right so the right edge enters blank right whitespace (idx 30..40)
    manager.setDrawings([movedContinuous!]);
    fireEvent.mouseDown(container, { button: 0, clientX: 230, clientY: entryY - 15 });
    fireEvent.mouseMove(window, { clientX: 330, clientY: entryY - 15 });
    fireEvent.mouseUp(window, { clientX: 330, clientY: entryY - 15 });

    const movedWhitespace = updates[updates.length - 1];
    expect(movedWhitespace).toBeDefined();
    expect(timeToIdx.get(movedWhitespace!.time!)).toBe(30);
    expect(movedWhitespace!.time2! - movedWhitespace!.time!).toBe(600);

    manager.destroy();
    container.remove();
  });

  it("keeps drawings isolated per chart pane slot so left drawings stay left and right drawings stay right", async () => {
    localStorage.clear();
    let pane0Hook!: ReturnType<typeof useChartDrawings>;
    let pane1Hook!: ReturnType<typeof useChartDrawings>;

    function Probe({
      slot,
      tf,
      onHook,
    }: {
      slot: number;
      tf: string;
      onHook: (h: ReturnType<typeof useChartDrawings>) => void;
    }) {
      const hook = useChartDrawings("JAGX", tf, slot);
      onHook(hook);
      return React.createElement(
        "div",
        { "data-testid": `probe-slot-${slot}` },
        String(hook.drawings.length),
      );
    }

    const { getByTestId, unmount } = render(
      React.createElement(
        React.Fragment,
        null,
        React.createElement(Probe, { slot: 0, tf: "5m", onHook: (h) => { pane0Hook = h; } }),
        React.createElement(Probe, { slot: 1, tf: "3m", onHook: (h) => { pane1Hook = h; } }),
      ),
    );

    await act(async () => {
      await Promise.resolve();
    });
    expect(getByTestId("probe-slot-0").textContent).toBe("0");
    expect(getByTestId("probe-slot-1").textContent).toBe("0");

    // Place a horizontal line on Left chart (slot 0) -> Right chart (slot 1) MUST stay empty
    await act(async () => {
      pane0Hook.addDrawing({
        id: "left-hline-1",
        type: "horizontal",
        price: 12.5,
        color: "#2196F3",
        createdTf: "5m",
      });
      await Promise.resolve();
    });

    expect(getByTestId("probe-slot-0").textContent).toBe("1");
    expect(getByTestId("probe-slot-1").textContent).toBe("0");

    // Place a horizontal line on Right chart (slot 1) -> Left chart (slot 0) remains untouched
    await act(async () => {
      pane1Hook.addDrawing({
        id: "right-hline-1",
        type: "horizontal",
        price: 10.04,
        color: "#f0b90b",
        createdTf: "3m",
      });
      await Promise.resolve();
    });

    expect(getByTestId("probe-slot-0").textContent).toBe("1");
    expect(getByTestId("probe-slot-1").textContent).toBe("1");
    expect(pane0Hook.drawings.map((d) => d.id)).toEqual(["left-hline-1"]);
    expect(pane1Hook.drawings.map((d) => d.id)).toEqual(["right-hline-1"]);

    // Verify dynamic-symbol scoped removal deletes ONLY from slot 1 in localStorage
    await api.chartDrawings.remove("right-hline-1");
    expect(await api.chartDrawings.list("JAGX")).toHaveLength(1);
    expect(await api.chartDrawings.list("JAGX__pane_1")).toHaveLength(0);

    unmount();
    localStorage.clear();
  });

  it("hides MultiChartPane header pill, toggles expand via canvas double-click, and keeps DrawingToolRail when expanded", () => {
    const restoreCanvas = installCanvasMock();
    try {
      const onToggleExpand = vi.fn();
      const onDrawingToolSelect = vi.fn();
      const { getByTestId, getByTitle, queryByTestId, rerender, unmount } = render(
        React.createElement(MultiChartPane, {
          slotId: 1,
          mainSymbol: "BTCUSD",
          defaultTimeframe: "1m",
          timeframe: "1m",
          isDark: true,
          symbols: [{ name: "BTCUSD", displayName: "Bitcoin / USD", category: "CRYPTO" }],
          ticks: {},
          onPromoteToMain: () => {},
          drawingTool: "none",
          onDrawingToolSelect,
          canExpand: true,
          isExpanded: false,
          onToggleExpand,
          expandLabel: "2×1",
        }),
      );

      expect(queryByTestId("pane-1-expand-btn")).toBeNull();
      expect(queryByTestId("pane-1-auto-btn")).toBeNull();
      expect(queryByTestId("pane-1-tf-badge")).toBeNull();
      expect(queryByTestId("tool-long-position")).toBeNull();

      fireEvent.doubleClick(getByTestId("pane-1-canvas"));
      expect(onToggleExpand).toHaveBeenCalledTimes(1);

      rerender(
        React.createElement(MultiChartPane, {
          slotId: 1,
          mainSymbol: "BTCUSD",
          defaultTimeframe: "1m",
          timeframe: "1m",
          isDark: true,
          symbols: [{ name: "BTCUSD", displayName: "Bitcoin / USD", category: "CRYPTO" }],
          ticks: {},
          onPromoteToMain: () => {},
          drawingTool: "none",
          onDrawingToolSelect,
          canExpand: true,
          isExpanded: true,
          onToggleExpand,
          expandLabel: "2×1",
        }),
      );

      fireEvent.doubleClick(getByTestId("pane-1-canvas"));
      expect(onToggleExpand).toHaveBeenCalledTimes(2);
      fireEvent.click(getByTitle("Trend Line (Alt+T)"));
      expect(onDrawingToolSelect).toHaveBeenCalledWith("trendline");
      fireEvent.click(getByTestId("tool-long-position"));
      expect(onDrawingToolSelect).toHaveBeenCalledWith("long-position");
      fireEvent.click(getByTestId("tool-short-position"));
      expect(onDrawingToolSelect).toHaveBeenCalledWith("short-position");
      unmount();
    } finally {
      restoreCanvas();
    }
  });

  it("accumulates live trade volume on 1m/3m bars and emits CandleUpdate across RTH opening gaps", () => {
    registerDynamicSymbol({
      name: "RTHLIVE",
      displayName: "RTH Live Stock",
      category: "STOCKS",
      initialPrice: 2.0,
      tickSize: 0.01,
      exchange: "NASDAQ",
    });

    const tPrev1559 = Math.floor(Date.UTC(2026, 10, 23, 20, 59, 0) / 1000); // 15:59 ET prev session
    const tPre0800 = Math.floor(Date.UTC(2026, 10, 24, 13, 0, 0) / 1000); // 08:00 ET Pre-Market
    const tOpen0930 = Math.floor(Date.UTC(2026, 10, 24, 14, 30, 0) / 1000); // 09:30 ET RTH open

    const bars1m: Candle[] = [
      { time: tPrev1559, open: 1.98, high: 2.02, low: 1.97, close: 2.0, volume: 15_000 },
      { time: tPre0800, open: 4.4, high: 4.6, low: 4.35, close: 4.5, volume: 50_000 },
    ];
    setRealStockSeries("RTHLIVE", "1m", bars1m);
    setRealStockSeries("RTHLIVE", "3m", aggregateTo5m(bars1m).map((b) => ({ ...b, time: Math.floor(b.time / 180) * 180 })));

    const emitted: Array<{ timeframe: string; close: number; volume: number; timestamp: number }> = [];
    const unsub = subscribeChannel("market-data", (ev) => {
      const rec = ev as {
        eventType?: string;
        symbol?: string;
        timeframe?: string;
        close?: number;
        volume?: number;
        timestamp?: number;
      };
      if (rec?.eventType === "CandleUpdate" && rec.symbol === "RTHLIVE") {
        emitted.push({
          timeframe: rec.timeframe!,
          close: rec.close!,
          volume: rec.volume!,
          timestamp: rec.timestamp!,
        });
      }
    });

    try {
      // +145% gap-up opening trades at 09:30:15 ET and 09:30:30 ET with explicit share volume
      applyLiveStockTrade("RTHLIVE", 4.8, (tOpen0930 + 15) * 1000, 250);
      applyLiveStockTrade("RTHLIVE", 4.9, (tOpen0930 + 30) * 1000, 150);

      const updates1m = emitted.filter((e) => e.timeframe === "1m");
      expect(updates1m).toHaveLength(2);
      expect(updates1m[0]).toMatchObject({ timestamp: tOpen0930, close: 4.8, volume: 250 });
      expect(updates1m[1]).toMatchObject({ timestamp: tOpen0930, close: 4.9, volume: 400 });

      const updates3m = emitted.filter((e) => e.timeframe === "3m");
      expect(updates3m[updates3m.length - 1]).toMatchObject({
        timestamp: tOpen0930,
        close: 4.9,
        volume: 400,
      });

      // Regular Session filter keeps yesterday's RTH + today's live 09:30 ET bar and excludes Pre-Market
      const rthBars = filterExtendedHoursCandles(getHistory("RTHLIVE", "1m"), false, null, "NASDAQ");
      expect(rthBars.map((b) => b.time)).toEqual([tPrev1559, tOpen0930]);
      expect(rthBars[1]!.volume).toBe(400);
      expect(rthBars[1]!.close).toBe(4.9);
    } finally {
      unsub();
      invalidateStockSeries("RTHLIVE");
    }
  });

  it("shows only Favorites in WatchlistPanel without category filter pills and allows searching to add new favorites", () => {
    localStorage.clear();
    localStorage.setItem(FAVORITES_STORAGE_KEY, JSON.stringify(["NVDA"]));
    const qc = new QueryClient();
    const { getByPlaceholderText, queryByText, getByText, unmount } = render(
      React.createElement(
        QueryClientProvider,
        { client: qc },
        React.createElement(WatchlistPanel, {
          symbols: [
            { name: "NVDA", displayName: "NVIDIA Corp.", category: "STOCKS" },
            { name: "BTCUSD", displayName: "Bitcoin / USD", category: "CRYPTO" },
          ],
          ticks: {},
          selectedSymbol: "NVDA",
          onSelect: () => {},
        }),
      ),
    );

    expect(queryByText("Todos")).toBeNull();
    expect(queryByText("EUR (€)")).toBeNull();
    expect(queryByText("Crypto & BTC.D")).toBeNull();
    expect(queryByText("Futuros Perp")).toBeNull();
    expect(getByText("NVDA")).toBeDefined();
    expect(queryByText("BTCUSD")).toBeNull();

    const searchInput = getByPlaceholderText("Buscar ticker para añadir a favoritos...");
    fireEvent.change(searchInput, { target: { value: "BTCUSD" } });
    expect(getByText("BTCUSD")).toBeDefined();
    unmount();
    localStorage.clear();
  });

  it("removes MTF, Alinear, and TradingView Analysis buttons from ChartToolbar", () => {
    const qc = new QueryClient();
    const { queryByText, queryByTitle, unmount } = render(
      React.createElement(
        QueryClientProvider,
        { client: qc },
        React.createElement(ChartToolbar, {
          selectedSymbol: "BTCUSD",
          symbols: [{ name: "BTCUSD", displayName: "Bitcoin / USD", category: "CRYPTO" }],
          onSymbolChange: () => {},
          timeframe: "1m",
          onTimeframeChange: () => {},
          activeIndicators: [],
          onToggleIndicator: () => {},
          showIndicatorMenu: false,
          onToggleIndicatorMenu: () => {},
          rightPanel: "watchlist",
          onRightPanel: () => {},
          showRightPanel: false,
          onToggleRightPanel: () => {},
          chartLayout: "2x1",
          onChartLayoutChange: () => {},
          syncPrice2x1: true,
          canSyncPrice2x1: true,
          onToggleSyncPrice2x1: () => {},
          showMtfPanel: false,
          onToggleMtfPanel: () => {},
        }),
      ),
    );

    expect(queryByText("MTF")).toBeNull();
    expect(queryByText("Alinear")).toBeNull();
    expect(queryByTitle("TradingView Analysis")).toBeNull();
    unmount();
  });

  it("detects live US Pre-Market window and scores Finviz-matched runners accurately", () => {
    // Wednesday 2026-11-25 07:40 ET = 12:40 UTC -> active Pre-Market (220 min elapsed)
    const preMarket0740Ms = Date.UTC(2026, 10, 25, 12, 40, 0);
    const regular1030Ms = Date.UTC(2026, 10, 25, 15, 30, 0);
    const after1700Ms = Date.UTC(2026, 10, 25, 22, 0, 0);
    const saturday0740Ms = Date.UTC(2026, 10, 28, 12, 40, 0);

    const preState = getUsPreMarketSessionState(preMarket0740Ms);
    expect(preState.isPreMarket).toBe(true);
    expect(preState.elapsedMinutes).toBe(220);
    expect(preState.expectedVolumeShare).toBeCloseTo((220 / 330) * 0.04, 4);

    expect(getUsPreMarketSessionState(regular1030Ms).isPreMarket).toBe(false);
    expect(getUsPreMarketSessionState(after1700Ms).isPreMarket).toBe(false);
    expect(getUsPreMarketSessionState(saturday0740Ms).isPreMarket).toBe(false);

    // Finviz-matched Pre-Market runners at 07:40 ET all score >= 5x RelVol
    const bnaiRelVol = computePreMarketRelativeVolume(2_075_956, 801_778, 2_144_480, 6_124_239, preMarket0740Ms);
    const dkiRelVol = computePreMarketRelativeVolume(9_040_000, 960_000, 960_000, 960_000, preMarket0740Ms);
    const medsRelVol = computePreMarketRelativeVolume(2_810_000, 7_000_000, 7_000_000, 7_000_000, preMarket0740Ms);
    const omhRelVol = computePreMarketRelativeVolume(975_000, 3_750_000, 3_750_000, 3_750_000, preMarket0740Ms);
    const apusRelVol = computePreMarketRelativeVolume(1_260_000, 4_000_000, 4_000_000, 4_000_000, preMarket0740Ms);

    expect(bnaiRelVol).not.toBeNull();
    expect(bnaiRelVol!).toBeGreaterThan(90);
    expect(dkiRelVol!).toBeGreaterThan(300);
    expect(medsRelVol!).toBeGreaterThanOrEqual(5);
    expect(omhRelVol!).toBeGreaterThanOrEqual(5);
    expect(apusRelVol!).toBeGreaterThanOrEqual(5);

    // Illiquid / low-volume noise at 07:40 ET stays below 5x RelVol
    const rectRelVol = computePreMarketRelativeVolume(100, 16_730, 10_000, 5_749, preMarket0740Ms);
    const snalRelVol = computePreMarketRelativeVolume(8_892, 145_000, 145_000, 145_000, preMarket0740Ms);
    const athrRelVol = computePreMarketRelativeVolume(1_026, 13_000, 13_000, 13_000, preMarket0740Ms);
    expect(rectRelVol!).toBeLessThan(1);
    expect(snalRelVol!).toBeLessThan(5);
    expect(athrRelVol!).toBeLessThan(5);
  });

  it("uses Finviz-style 90-day RelVol permanently in Regular Session (e.g. 09:45 ET / 15:45 CET) and after close", () => {
    // Wednesday 2026-11-25 09:31 ET = 14:31 UTC (1 min into open -> 0.025 floor)
    const open0931Ms = Date.UTC(2026, 10, 25, 14, 31, 0);
    // Wednesday 2026-11-25 09:45 ET = 14:45 UTC (15 min into open -> 15/390 = 0.03846)
    const open0945Ms = Date.UTC(2026, 10, 25, 14, 45, 0);
    // Wednesday 2026-11-25 16:30 ET = 21:30 UTC (after close -> 1.0 full day)
    const after1630Ms = Date.UTC(2026, 10, 25, 21, 30, 0);
    // Saturday 2026-11-28 11:00 ET = 16:00 UTC (weekend -> 1.0 full day)
    const weekendMs = Date.UTC(2026, 10, 28, 16, 0, 0);

    expect(getUsRegularSessionState(open0931Ms)).toEqual({
      isRegularSession: true,
      elapsedMinutes: 1,
      expectedVolumeShare: 0.025,
    });
    const state0945 = getUsRegularSessionState(open0945Ms);
    expect(state0945.isRegularSession).toBe(true);
    expect(state0945.elapsedMinutes).toBe(15);
    expect(state0945.expectedVolumeShare).toBeCloseTo(15 / 390, 4);
    expect(getUsRegularSessionState(after1630Ms).expectedVolumeShare).toBe(1);
    expect(getUsRegularSessionState(weekendMs).expectedVolumeShare).toBe(1);

    // BNAI at 09:45 ET (15:45 Spain): 1.5M vol vs 90d avg 801K (even though 10d avg is 6.12M) -> ~48.6x >= 5x!
    const bnai0945 = computeRegularRelativeVolume(1_500_000, 801_778, 2_144_480, 6_124_239, open0945Ms);
    expect(bnai0945).not.toBeNull();
    expect(bnai0945!).toBeGreaterThan(40);

    // Normal stock at 09:45 ET: 50K vol vs 90d avg 1M -> ~1.3x < 5x
    const normal0945 = computeRegularRelativeVolume(50_000, 1_000_000, 1_000_000, 1_000_000, open0945Ms);
    expect(normal0945!).toBeLessThan(2);

    // After close: 5M full-day volume vs 800K 90d avg -> 6.25x
    const bnaiAfterClose = computeRegularRelativeVolume(5_000_000, 800_000, 2_000_000, 6_000_000, after1630Ms);
    expect(bnaiAfterClose).toBe(6.25);
  });

  it("shows clear banner when Favorites-only mode is active in StockScreenerTab and exits on Filtro base or filter changes", async () => {
    localStorage.setItem(FAVORITES_STORAGE_KEY, JSON.stringify(["JAGX"]));
    localStorage.setItem(
      FAVORITES_META_STORAGE_KEY,
      JSON.stringify({
        JAGX: {
          name: "JAGX",
          displayName: "Jaguar Health, Inc.",
          category: "STOCKS",
          exchange: "NASDAQ",
          initialPrice: 10.4,
        },
      }),
    );

    const fetchMock = vi.fn().mockImplementation((url: unknown) => {
      if (String(url).includes("/__api/ibkr-config")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            configured: true,
            host: "127.0.0.1",
            port: 7497,
            clientId: 101,
            marketDataType: 1,
            source: "default",
            connectionState: "connected",
            lastError: null,
            activeStreams: 0,
            activeRequests: 0,
          }),
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({
          totalCount: 3,
          fetchedAt: Date.now(),
          source: "ibkr-scanner",
          items: [
            {
              id: "NASDAQ:NRSN",
              ticker: "NRSN",
              description: "NeuroSense Therapeutics",
              exchange: "NASDAQ",
              close: 3.79,
              change: 244.55,
              volume: 16_850_166,
              relativeVolume: 16958.35,
              marketCap: 2_700_000,
              priceToBook: null,
              epsDiluted: null,
              epsGrowthYoY: null,
              dividendYield: null,
              sector: "Health Technology",
              perfW: null,
              perf1M: null,
              perf3M: null,
              perfYTD: null,
              perfY: null,
              rsi: null,
              recommendAll: null,
              floatShares: 1_702_850,
              currency: "USD",
              country: "United States",
              premarketClose: 3.79,
              premarketChange: 244.55,
              premarketVolume: 16_850_166,
            },
          ],
        }),
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    try {
      const { getByTestId, getByText, queryByTestId, queryByText } = render(
        React.createElement(StockScreenerTab, { onOpenStockInChart: vi.fn() }),
      );

      await waitFor(() => {
        expect(getByText("NRSN")).toBeTruthy();
      });
      expect(queryByText("Auto 60s")).toBeNull();
      expect(queryByText(/Solo con Pre-Market \(NYSE/)).toBeNull();

      // Enable Favorites-only filter
      fireEvent.click(getByTestId("screener-favorites-toggle"));
      await waitFor(() => {
        expect(getByTestId("screener-favorites-banner")).toBeTruthy();
        expect(getByText(/Mostrando solo tus favoritas \(1\)/)).toBeTruthy();
      });

      // Clicking "Filtro base" exits Favorites-only mode and restores screener rows
      fireEvent.click(getByText("Filtro base"));
      await waitFor(() => {
        expect(queryByTestId("screener-favorites-banner")).toBeNull();
        expect(getByText("NRSN")).toBeTruthy();
      });

      // Enabling Favorites again then changing an active filter (RelVol >= 10x) also exits Favorites-only mode
      fireEvent.click(getByTestId("screener-favorites-toggle"));
      await waitFor(() => {
        expect(getByTestId("screener-favorites-banner")).toBeTruthy();
      });
      fireEvent.click(getByTestId("screener-relvol-chip"));
      fireEvent.click(getByText("≥ 10x"));
      await waitFor(() => {
        expect(queryByTestId("screener-favorites-banner")).toBeNull();
      });
    } finally {
      vi.unstubAllGlobals();
      localStorage.removeItem(FAVORITES_STORAGE_KEY);
      localStorage.removeItem(FAVORITES_META_STORAGE_KEY);
      cleanup();
    }
  });

  it("collects all Pre-Market session runs across multiple trading days and overnight gaps", () => {
    const monPre = [
      { time: 1_700_038_800, kind: "pre" as const },
      { time: 1_700_042_400, kind: "pre" as const },
    ];
    const monReg = [{ time: 1_700_060_000, kind: "regular" as const }];
    const tuePre = [
      { time: 1_700_125_200, kind: "pre" as const },
      { time: 1_700_128_800, kind: "pre" as const },
    ];
    const tueReg = [{ time: 1_700_146_400, kind: "regular" as const }];
    const wedPre = [{ time: 1_700_211_600, kind: "pre" as const }];

    expect(
      findPreMarketSessionRuns([...monPre, ...monReg, ...tuePre, ...tueReg, ...wedPre]),
    ).toEqual([
      { startIdx: 0, endIdx: 1 },
      { startIdx: 3, endIdx: 4 },
      { startIdx: 6, endIdx: 6 },
    ]);

    // Also splits two Pre-Market sessions separated by a >6h gap when regular bars are absent
    expect(findPreMarketSessionRuns([...monPre, ...tuePre])).toEqual([
      { startIdx: 0, endIdx: 1 },
      { startIdx: 2, endIdx: 3 },
    ]);
  });

  it("filters IBKR scanner candidates across small-caps strictly by Float, Price, Change and RelVol", () => {
    const open0942Ms = Date.UTC(2026, 10, 25, 14, 42, 0);
    const sameDayCloseMs = Date.UTC(2026, 10, 25, 20, 45, 0);
    const prevDayCloseMs = Date.UTC(2026, 10, 24, 21, 0, 0);

    expect(isSameNyTradingDay(open0942Ms, sameDayCloseMs)).toBe(true);
    expect(isSameNyTradingDay(open0942Ms, prevDayCloseMs)).toBe(false);
    expect(toIbkrContract("ALGS", "NASDAQ").primaryExch).toBe("ISLAND");

    const universeCandidates = [
      {
        ticker: "ALGS",
        description: "Aligos Therapeutics",
        close: 1.72,
        change: 15.44,
        volume: 30_000,
        relativeVolume: 8.2,
        floatShares: 5_569_426,
        marketCap: 10_000_000,
        sector: "Health Technology",
        premarketVolume: 30_000,
      },
      {
        ticker: "BLRX",
        description: "BioLineRx Ltd.",
        close: 0.927,
        change: -1.36,
        volume: 76_209,
        relativeVolume: 6.1,
        floatShares: 8_000_000,
        marketCap: 9_000_000,
        sector: "Health Technology",
        premarketVolume: 76_209,
      },
      {
        ticker: "ELOX",
        description: "Eloxx Pharmaceuticals",
        close: 13.38,
        change: 0,
        volume: 969,
        relativeVolume: 1.0,
        floatShares: 2_500_000,
        marketCap: 33_000_000,
        sector: "Health Technology",
        premarketVolume: 100,
      },
      {
        ticker: "NOFLT",
        description: "Missing Float Corp",
        close: 2.5,
        change: 55.0,
        volume: 6_000_000,
        relativeVolume: 50,
        floatShares: null,
        marketCap: 5_000_000,
        sector: "Technology",
        premarketVolume: 10_000,
      },
    ];

    const bounds = {
      priceMin: 1,
      priceMax: 20,
      changeMin: 10,
      floatMin: 800_000,
      floatMax: 20_000_000,
      relVolMin: 5,
      onlyPremarket: true,
    };

    const filtered = filterScreenerRows(universeCandidates, bounds);
    expect(filtered.map((r) => r.ticker)).toEqual(["ALGS"]);
  });

  it("enforces Replay data provenance, zero synthetic subdivision, strict VWAP coverage, and partial-candle look-ahead protection", () => {
    registerDynamicSymbol({
      name: "PROVCHK",
      displayName: "Provenance Check Corp",
      category: "STOCKS",
      initialPrice: 9.0,
      tickSize: 0.01,
      exchange: "NASDAQ",
    });

    const t0930 = Math.floor(Date.UTC(2026, 10, 24, 14, 30, 0) / 1000);
    const bars5m: Candle[] = Array.from({ length: 12 }, (_, i) => ({
      time: t0930 + i * 300,
      open: 9 + i * 0.1,
      high: 9.3 + i * 0.1,
      low: 8.9 + i * 0.1,
      close: 9.15 + i * 0.1,
      volume: 15_000 + i * 500,
    }));
    setRealStockSeries("PROVCHK", "5m", bars5m);

    // 1. Only 5m exists: starting Replay on 1m or switching 5m -> 1m must never invent synthetic 1m bars
    expect(useReplayStore.getState().start("PROVCHK", "1m", t0930 + 900).ok).toBe(false);
    expect(useReplayStore.getState().start("PROVCHK", "5m", t0930 + 900).ok).toBe(true);
    expect(useReplayStore.getState().changeTimeframe("1m")).toBe(false);
    expect(useReplayStore.getState().timeframe).toBe("5m");
    expect(getReplaySliceForTimeframe("PROVCHK", "1m", useReplayStore.getState().simTimeSec)).toEqual([]);

    // 2. Truncated 1m series starting at 09:35 ET without seed must not emit Regular Session VWAP
    const late1m: Candle[] = Array.from({ length: 10 }, (_, i) => ({
      time: t0930 + 300 + i * 60,
      open: 9.2,
      high: 9.4,
      low: 9.1,
      close: 9.3,
      volume: 4_000,
    }));
    expect(
      vwapBands(late1m, {
        anchor: "session",
        sessionTimeZone: "america-new-york",
        anchorAtRegularOpen: true,
      }).vwap,
    ).toEqual([]);

    useReplayStore.getState().stop();
    invalidateStockSeries("PROVCHK");
  });
});
