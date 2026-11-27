import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import {
  getChartPreferencesFromStorage,
  updateChartPreferences,
} from "../hooks/useChartPreferences.ts";
import {
  buildFavoriteDemoSymbol,
  FAVORITES_META_STORAGE_KEY,
  FAVORITES_STORAGE_KEY,
  toggleFavoriteSymbol,
  useFavoriteSymbols,
} from "../hooks/useFavoriteSymbols.ts";
import { ema, vwap, vwapBands } from "../lib/indicators.ts";
import { positionReadout } from "../lib/chart-plugins/drawing-tools/renderers.ts";
import { filterExtendedHoursCandles } from "../lib/chart-plugins/extended-hours-primitive.ts";
import { ChartToolbar } from "../pages/trading/ChartToolbar.tsx";
import { DrawingToolRail } from "../pages/trading/DrawingToolRail.tsx";
import { StockScreenerTab } from "../pages/trading/StockScreenerTab.tsx";
import { formatLineTitle } from "../pages/trading/useSlTpDrag.ts";
import { evaluateStockBarQuoteFreshness } from "../services/demo/candles.ts";
import {
  clearStockDiscoveryCache,
  discoverRemoteStocks,
  getDemoSymbol,
} from "../services/demo/instruments.ts";
import { selectSameSeriesPlaceholder } from "../services/queries.ts";
import { DEFAULT_SCREENER_FILTERS } from "../services/stockScreener.ts";

function DualFavoritesProbe() {
  const { favoriteOrder, isFavorite, toggleFavorite } = useFavoriteSymbols();
  return React.createElement(
    "div",
    null,
    React.createElement("span", { "data-testid": "fav-count" }, String(favoriteOrder.length)),
    React.createElement("span", { "data-testid": "fav-nvda" }, String(isFavorite("nvda"))),
    React.createElement(
      "button",
      {
        type: "button",
        "data-testid": "probe-toggle-rklb",
        onClick: () =>
          toggleFavorite("rklb", {
            displayName: "Rocket Lab USA",
            category: "STOCKS",
            exchange: "NASDAQ",
            initialPrice: 24.5,
          }),
      },
      "Toggle RKLB",
    ),
  );
}

describe("Trading UX improvements (Extended Hours, Synced Favorites, Clean TP/SL, 1-click R:R)", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
  });

  it("filters extended-hours candles cleanly when showExtendedHours is false and falls back if no regular bars exist", () => {
    // Monday 2026-01-12 (EST = UTC-5)
    const preSec = Math.floor(Date.parse("2026-01-12T13:00:00Z") / 1000); // 08:00 ET
    const regSec = Math.floor(Date.parse("2026-01-12T15:00:00Z") / 1000); // 10:00 ET
    const postSec = Math.floor(Date.parse("2026-01-12T22:00:00Z") / 1000); // 17:00 ET

    const bars = [
      { time: preSec, open: 100, high: 101, low: 99, close: 100.5 },
      { time: regSec, open: 101, high: 103, low: 100, close: 102.5 },
      { time: postSec, open: 102.5, high: 104, low: 102, close: 103 },
    ];

    expect(filterExtendedHoursCandles(bars, true, null, "NASDAQ")).toEqual(bars);

    const rthOnly = filterExtendedHoursCandles(bars, false, null, "NASDAQ");
    expect(rthOnly).toHaveLength(1);
    expect(rthOnly[0]!.time).toBe(regSec);

    // Pure pre-market feed must fall back to showing available bars rather than going blank
    const preOnly = [bars[0]!];
    expect(filterExtendedHoursCandles(preOnly, false, null, "NASDAQ")).toEqual(preOnly);
  });

  it("synchronizes favorites and dynamic stock metadata across components via localStorage events", () => {
    const first = render(React.createElement(DualFavoritesProbe));
    const second = render(React.createElement(DualFavoritesProbe));

    expect(first.getAllByTestId("fav-count")[0]!.textContent).toBe("0");
    expect(second.getAllByTestId("fav-count")[1]!.textContent).toBe("0");

    // Star RKLB in first mounted probe -> second probe must update immediately
    fireEvent.click(first.getAllByTestId("probe-toggle-rklb")[0]!);

    expect(first.getAllByTestId("fav-count")[0]!.textContent).toBe("1");
    expect(second.getAllByTestId("fav-count")[1]!.textContent).toBe("1");

    const storedFavs = JSON.parse(localStorage.getItem(FAVORITES_STORAGE_KEY) || "[]");
    expect(storedFavs).toContain("RKLB");

    const storedMeta = JSON.parse(localStorage.getItem(FAVORITES_META_STORAGE_KEY) || "{}");
    expect(storedMeta.RKLB).toMatchObject({
      name: "RKLB",
      displayName: "Rocket Lab USA",
      category: "STOCKS",
      exchange: "NASDAQ",
      initialPrice: 24.5,
    });

    const built = buildFavoriteDemoSymbol("RKLB", storedMeta.RKLB);
    expect(built.name).toBe("RKLB");
    expect(built.category).toBe("STOCKS");
    expect(built.initialPrice).toBe(24.5);

    act(() => {
      toggleFavoriteSymbol("nvda");
    });
    expect(second.getAllByTestId("fav-nvda")[1]!.textContent).toBe("true");
  });

  it("formats TP and SL price-line labels cleanly without extra text or arrows", () => {
    expect(formatLineTitle("takeProfit", 1.12, false)).toBe("TP");
    expect(formatLineTitle("takeProfit", 1.12, true)).toBe("TP");
    expect(formatLineTitle("stopLoss", -3.13, false)).toBe("SL");
    expect(formatLineTitle("stopLoss", -3.13, true)).toBe("SL");
  });

  it("exposes Extended Hours (Sesión ampliada / normal) and quick star toggles in ChartToolbar for stocks", () => {
    updateChartPreferences({ showExtendedHours: true });
    expect(getChartPreferencesFromStorage().showExtendedHours).toBe(true);

    const { getByTestId } = render(
      React.createElement(ChartToolbar, {
        selectedSymbol: "NVDA",
        symbols: [],
        onSymbolChange: vi.fn(),
        timeframe: "5m",
        onTimeframeChange: vi.fn(),
        activeIndicators: [],
        onToggleIndicator: vi.fn(),
        showIndicatorMenu: false,
        onToggleIndicatorMenu: vi.fn(),
        rightPanel: "order",
        onRightPanel: vi.fn(),
        showRightPanel: false,
        onToggleRightPanel: vi.fn(),
      }),
    );

    const extBtn = getByTestId("extended-hours-toggle-btn");
    expect(extBtn.textContent).toContain("Sesión ampliada");

    fireEvent.click(extBtn);
    expect(getChartPreferencesFromStorage().showExtendedHours).toBe(false);
    expect(extBtn.textContent).toContain("Sesión normal");

    fireEvent.click(extBtn);
    expect(getChartPreferencesFromStorage().showExtendedHours).toBe(true);
    expect(extBtn.textContent).toContain("Sesión ampliada");

    const starBtn = getByTestId("toolbar-favorite-btn");
    fireEvent.click(starBtn);
    const storedFavs = JSON.parse(localStorage.getItem(FAVORITES_STORAGE_KEY) || "[]");
    expect(storedFavs).toContain("NVDA");
  });

  it("exposes 1-click Long and Short Risk/Reward position tools on DrawingToolRail", () => {
    const onDrawingTool = vi.fn();
    const { getByTestId } = render(
      React.createElement(DrawingToolRail, {
        drawingTool: "none",
        onDrawingTool,
      }),
    );

    fireEvent.click(getByTestId("tool-long-position"));
    expect(onDrawingTool).toHaveBeenCalledWith("long-position");

    fireEvent.click(getByTestId("tool-short-position"));
    expect(onDrawingTool).toHaveBeenCalledWith("short-position");
  });

  it("displays ONLY the Risk/Reward ratio in positionReadout without TP/SL/Entrada/Riesgo clutter", () => {
    const lines = positionReadout({
      id: "pos-rr-1",
      type: "position",
      side: "long",
      color: "#089981",
      price: 100,
      targetPrice: 112.5,
      stopPrice: 95,
      riskPct: 1,
    });
    expect(lines).toEqual(["R:R 1 : 2.50"]);

    const shortLines = positionReadout({
      id: "pos-rr-2",
      type: "position",
      side: "short",
      color: "#f23645",
      price: 10,
      targetPrice: 7,
      stopPrice: 11,
      riskPct: 1,
    });
    expect(shortLines).toEqual(["R:R 1 : 3.00"]);
  });

  it("uses user trading screener defaults (RelVol>=5x, Float 800K-20M, Price $1-$20, Cbo%>10%) without Volume/MarketCap filters", () => {
    expect(DEFAULT_SCREENER_FILTERS).toMatchObject({
      marketScope: "us",
      onlyPremarket: true,
      marketCapMin: null,
      marketCapMax: null,
      volumeMin: null,
      relVolMin: 5,
      floatMin: 800_000,
      floatMax: 20_000_000,
      priceMin: 1,
      priceMax: 20,
      changeMin: 10,
    });
  });

  it("discovers remote screener stocks like CUE for the top search bar with stock tickSize precision", async () => {
    clearStockDiscoveryCache();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        totalCount: 2,
        items: [
          {
            ticker: "CUE",
            description: "Cue Biopharma, Inc.",
            exchange: "NASDAQ",
            close: 1.42,
            country: "United States",
            currency: "USD",
          },
          {
            ticker: "PENN",
            description: "Sub Dollar Stock",
            exchange: "NASDAQ",
            close: 0.45,
            country: "United States",
            currency: "USD",
          },
        ],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    try {
      const results = await discoverRemoteStocks("cue");
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(results[0]).toMatchObject({
        name: "CUE",
        category: "STOCKS",
        exchange: "NASDAQ",
        initialPrice: 1.42,
        tickSize: 0.01,
      });
      expect(getDemoSymbol("CUE")?.category).toBe("STOCKS");
      expect(results[1]?.tickSize).toBe(0.0001);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("does not distort VWAP or std-dev bands on zero-volume bars once real session volume exists", () => {
    const baseSec = 1_700_000_000;
    const candles = [
      { time: baseSec, open: 10, high: 10, low: 10, close: 10, volume: 1000 },
      { time: baseSec + 60, open: 12, high: 12, low: 12, close: 12, volume: 1000 },
      // 0-volume tick after real volume: price jumps to 50 but volume is 0
      { time: baseSec + 120, open: 50, high: 50, low: 50, close: 50, volume: 0 },
    ];

    const vwapPts = vwap(candles, false);
    expect(vwapPts[1]!.value).toBeCloseTo(11, 6);
    expect(vwapPts[2]!.value).toBeCloseTo(11, 6);

    const bands = vwapBands(candles, { anchor: "session", source: "close" });
    expect(bands.vwap[1]!.value).toBeCloseTo(11, 6);
    expect(bands.vwap[2]!.value).toBeCloseTo(11, 6);
    expect(bands.upper1[2]!.value).toBeCloseTo(bands.upper1[1]!.value, 6);
    expect(bands.lower1[2]!.value).toBeCloseTo(bands.lower1[1]!.value, 6);

    // Pure zero-volume feed still falls back to equal-weighted typical/source price average
    const zeroVolOnly = [
      { time: baseSec, open: 10, high: 10, low: 10, close: 10, volume: 0 },
      { time: baseSec + 60, open: 14, high: 14, low: 14, close: 14, volume: 0 },
    ];
    const fb = vwapBands(zeroVolOnly, { anchor: "session", source: "close" });
    expect(fb.vwap[0]!.value).toBeCloseTo(10, 6);
    expect(fb.vwap[1]!.value).toBeCloseTo(12, 6);
  });

  it("renders Market Cap and Volume in StockScreenerTab as optional inactive chips until selected", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        totalCount: 0,
        items: [],
        fetchedAt: Date.now(),
        source: "ibkr-scanner",
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    try {
      const { getByTestId, getByText } = render(
        React.createElement(StockScreenerTab, {
          onOpenStockInChart: vi.fn(),
        }),
      );

      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      const initialBody = JSON.parse(String(fetchMock.mock.calls[0]![1]?.body));
      expect(initialBody.marketCapMin).toBeNull();
      expect(initialBody.marketCapMax).toBeNull();
      expect(initialBody.volumeMin).toBeNull();

      const mcChip = getByTestId("screener-marketcap-chip");
      const volChip = getByTestId("screener-volume-chip");
      expect(mcChip.textContent).toBe("Cap. de mercado");
      expect(volChip.textContent).toBe("Volumen");

      // Selecting an optional Volume filter updates ONLY volumeMin and preserves relVolMin: 5
      fireEvent.click(volChip);
      fireEvent.click(getByText("Volumen > 1M"));
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
      const updatedBody = JSON.parse(String(fetchMock.mock.calls[1]![1]?.body));
      expect(updatedBody.volumeMin).toBe(1_000_000);
      expect(updatedBody.relVolMin).toBe(5);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("computes EMA 8 with SMA seed and k=2/(p+1) smoothing accurately", () => {
    const closes = [10, 11, 12, 13, 14, 15, 16, 17, 19, 18];
    const bars = closes.map((c, idx) => ({
      time: 1_700_000_000 + idx * 60,
      open: c,
      high: c,
      low: c,
      close: c,
      volume: 100,
    }));

    const pts = ema(bars, 8);
    expect(pts).toHaveLength(3); // 10 - 8 + 1
    // First point is SMA of first 8 bars: (10+11+12+13+14+15+16+17)/8 = 13.5
    expect(pts[0]!.value).toBeCloseTo(13.5, 6);
    const k = 2 / 9;
    const expected1 = 19 * k + 13.5 * (1 - k);
    const expected2 = 18 * k + expected1 * (1 - k);
    expect(pts[1]!.value).toBeCloseTo(expected1, 6);
    expect(pts[2]!.value).toBeCloseTo(expected2, 6);
  });

  it("resets NY-session VWAP by America/New_York trading day (not UTC midnight) and weights hlc3 by volume", () => {
    // 2026-11-24 is EST (UTC-5):
    // 04:00 ET = 09:00 UTC, 09:30 ET = 14:30 UTC, 19:30 ET = next day 00:30 UTC (same NY day!)
    // 2026-11-25 04:00 ET = 2026-11-25 09:00 UTC (new NY trading day)
    const tPre = Math.floor(Date.UTC(2026, 10, 24, 9, 0, 0) / 1000);
    const tRth = Math.floor(Date.UTC(2026, 10, 24, 14, 30, 0) / 1000);
    const tPostAfterUtcMidnight = Math.floor(Date.UTC(2026, 10, 25, 0, 30, 0) / 1000);
    const tNextDayPre = Math.floor(Date.UTC(2026, 10, 25, 9, 0, 0) / 1000);

    const bars = [
      // Pre-market hlc3 = (9+12+9)/3 = 10, vol = 100
      { time: tPre, open: 10, high: 12, low: 9, close: 9, volume: 100 },
      // Regular hours hlc3 = (19+22+19)/3 = 20, vol = 300 -> VWAP = (10*100 + 20*300) / 400 = 17.5
      { time: tRth, open: 19, high: 22, low: 19, close: 19, volume: 300 },
      // Post-market (19:30 ET, 00:30 UTC) with 0 volume -> must carry forward 17.5 (NOT reset at UTC midnight!)
      { time: tPostAfterUtcMidnight, open: 30, high: 30, low: 30, close: 30, volume: 0 },
      // Next NY trading day 04:00 ET -> MUST reset cleanly to hlc3 = 5
      { time: tNextDayPre, open: 5, high: 6, low: 4, close: 5, volume: 200 },
    ];

    const res = vwapBands(bars, {
      anchor: "session",
      sessionTimeZone: "america-new-york",
      source: "hlc3",
    });

    expect(res.vwap[0]!.value).toBeCloseTo(10, 6);
    expect(res.vwap[1]!.value).toBeCloseTo(17.5, 6);
    expect(res.vwap[2]!.value).toBeCloseTo(17.5, 6);
    expect(res.vwap[3]!.value).toBeCloseTo(5, 6);
  });

  it("keeps 5m/15m stock bar quotes fresh after a 1m bar without advancing timestamps forward", () => {
    const t1010 = 1_795_443_000; // 5m bar starting 10:10
    const t1000 = 1_795_442_400; // 15m bar starting 10:00
    const prev1mMs = (t1010 + 240) * 1000; // 10:14:00 from 1m chart

    const res5m = evaluateStockBarQuoteFreshness(t1010, "5m", prev1mMs);
    expect(res5m.isFresherBar).toBe(true);
    expect(res5m.quoteTsMs).toBe(prev1mMs);

    const res15m = evaluateStockBarQuoteFreshness(t1000, "15m", prev1mMs);
    expect(res15m.isFresherBar).toBe(true);
    expect(res15m.quoteTsMs).toBe(prev1mMs);

    // An earlier closed 5m bar (09:55..10:00) must NOT overwrite a 10:14 live quote
    const stale5m = evaluateStockBarQuoteFreshness(t1000 - 300, "5m", prev1mMs);
    expect(stale5m.isFresherBar).toBe(false);

    // A 1d bar must NEVER overwrite an active intraday quote
    const stale1d = evaluateStockBarQuoteFreshness(t1000, "1d", prev1mMs);
    expect(stale1d.isFresherBar).toBe(false);
  });

  it("only returns placeholder candle data when symbol and timeframe match", () => {
    const fakeCandles = { candles: [{ time: 1, open: 100, high: 101, low: 99, close: 100, volume: 10 }] };
    expect(
      selectSameSeriesPlaceholder(fakeCandles, ["candles", "NVDA", "5m", 1000, 0], "NVDA", "5m"),
    ).toBe(fakeCandles);
    expect(
      selectSameSeriesPlaceholder(fakeCandles, ["candles", "NVDA", "5m", 1000, 0], "CUE", "5m"),
    ).toBeUndefined();
    expect(
      selectSameSeriesPlaceholder(fakeCandles, ["candles", "NVDA", "5m", 1000, 0], "NVDA", "1m"),
    ).toBeUndefined();
  });
});
