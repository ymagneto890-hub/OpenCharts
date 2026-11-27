import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_INDICATOR_SETTINGS } from "../hooks/useIndicatorSettings.ts";
import {
  computeAlignedLocalPriceRange,
  PriceSyncController,
  type SyncedPriceBounds,
} from "../pages/trading/priceSyncBus.ts";
import { chartTemplatesApi } from "../services/api/chart-templates.ts";

describe("priceSyncBus (2x1 synchronized price scale & crosshair)", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("maps identical geometry to identical minValue and maxValue", () => {
    const bounds: SyncedPriceBounds = {
      symbol: "NVDA",
      topPrice: 175,
      botPrice: 125,
      masterTop: 100,
      masterPaneHeight: 500,
    };

    const range = computeAlignedLocalPriceRange(bounds, 100, 500);
    expect(range).toEqual({ minValue: 125, maxValue: 175 });
  });

  it("aligns pixel-to-price when slave pane is shifted down and shorter (e.g. oscillators open)", () => {
    // Master: clientY 100..600 (height 500px), prices 200..100 -> 0.2 price units per px
    const bounds: SyncedPriceBounds = {
      symbol: "NVDA",
      topPrice: 200,
      botPrice: 100,
      masterTop: 100,
      masterPaneHeight: 500,
    };

    // Slave starts 100px lower (clientY 200) and is 300px tall (clientY 200..500)
    const range = computeAlignedLocalPriceRange(bounds, 200, 300);
    expect(range).not.toBeNull();
    // At clientY = 200 (100px below masterTop), master price = 200 - 100*0.2 = 180
    expect(range!.maxValue).toBeCloseTo(180, 6);
    // At clientY = 500 (400px below masterTop), master price = 200 - 400*0.2 = 120
    expect(range!.minValue).toBeCloseTo(120, 6);
  });

  it("returns null for invalid, zero-height, or inverted bounds", () => {
    expect(computeAlignedLocalPriceRange(null, 0, 500)).toBeNull();
    expect(
      computeAlignedLocalPriceRange(
        { symbol: "NVDA", topPrice: 150, botPrice: 150, masterTop: 0, masterPaneHeight: 500 },
        0,
        500,
      ),
    ).toBeNull();
    expect(
      computeAlignedLocalPriceRange(
        { symbol: "NVDA", topPrice: 100, botPrice: 150, masterTop: 0, masterPaneHeight: 500 },
        0,
        500,
      ),
    ).toBeNull();
    expect(
      computeAlignedLocalPriceRange(
        { symbol: "NVDA", topPrice: 200, botPrice: 100, masterTop: 0, masterPaneHeight: 0 },
        0,
        500,
      ),
    ).toBeNull();
    expect(
      computeAlignedLocalPriceRange(
        { symbol: "NVDA", topPrice: 200, botPrice: 100, masterTop: 0, masterPaneHeight: 500 },
        0,
        0,
      ),
    ).toBeNull();
    expect(
      computeAlignedLocalPriceRange(
        { symbol: "NVDA", topPrice: Number.NaN, botPrice: 100, masterTop: 0, masterPaneHeight: 500 },
        0,
        500,
      ),
    ).toBeNull();
  });

  it("deduplicates identical bounds, does not dedupe across symbols, and notifies auto-scale reset", () => {
    const ctrl = new PriceSyncController();
    const listener = vi.fn();
    const resetListener = vi.fn();
    const unsub1 = ctrl.subscribeBounds(listener);
    const unsubReset = ctrl.subscribeResetAutoScale(resetListener);

    expect(listener).not.toHaveBeenCalled();

    const first: SyncedPriceBounds = {
      symbol: "NVDA",
      topPrice: 175.0,
      botPrice: 125.0,
      masterTop: 80,
      masterPaneHeight: 500,
    };
    ctrl.publishBounds(first);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenLastCalledWith(first);

    // Within tolerances (1e-7 for prices, 0.5 for pixels) for same symbol -> ignored
    ctrl.publishBounds({
      symbol: "NVDA",
      topPrice: 175.0 + 1e-9,
      botPrice: 125.0 - 1e-9,
      masterTop: 80.2,
      masterPaneHeight: 500.2,
    });
    expect(listener).toHaveBeenCalledTimes(1);

    // Different symbol must NEVER be deduplicated even with identical numbers
    const diffSymbol: SyncedPriceBounds = { ...first, symbol: "AAPL" };
    ctrl.publishBounds(diffSymbol);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenLastCalledWith(diffSymbol);

    // Late subscriber immediately receives non-null bounds
    const lateListener = vi.fn();
    const unsub2 = ctrl.subscribeBounds(lateListener);
    expect(lateListener).toHaveBeenCalledTimes(1);
    expect(lateListener).toHaveBeenCalledWith(diffSymbol);

    // Reset auto-scale request notifies listeners
    ctrl.requestResetAutoScale();
    expect(resetListener).toHaveBeenCalledTimes(1);

    unsub1();
    unsub2();
    unsubReset();
  });

  it("isolates hover clearing by source", () => {
    const ctrl = new PriceSyncController();
    const listener = vi.fn();
    const unsub = ctrl.subscribeHover(listener);

    ctrl.publishHover({ source: "left", price: 162.5, clientY: 240 });
    expect(listener).toHaveBeenLastCalledWith({ source: "left", price: 162.5, clientY: 240 });

    // Clearing from "right" must NOT clear hover originating from "left"
    ctrl.clearHoverFrom("right");
    expect(listener).toHaveBeenCalledTimes(1);

    // Clearing from "left" clears it and notifies listeners with null
    ctrl.clearHoverFrom("left");
    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenLastCalledWith(null);

    // Redundant clear does not re-emit
    ctrl.clearHoverFrom("left");
    expect(listener).toHaveBeenCalledTimes(2);

    unsub();
  });

  it("persists and loads 2x1 multi-chart template snapshots with pane indicators, volume, and indicatorSettings", async () => {
    const saved = await chartTemplatesApi.save("Scalp 2x1", {
      version: 1,
      prefs: { showVolume: false, showGrid: true },
      indicators: ["EMA", "VWAP", "RSI"],
      plugins: [],
      chartLayout: "2x1",
      mainTimeframe: "1m",
      syncPrice2x1: true,
      panes: {
        "1": {
          timeframe: "5m",
          indicators: ["EMA", "VWAP", "SMC"],
          showVolume: false,
        },
      },
      indicatorSettings: {
        ...DEFAULT_INDICATOR_SETTINGS,
        vwap: {
          ...DEFAULT_INDICATOR_SETTINGS.vwap,
          band1: { ...DEFAULT_INDICATOR_SETTINGS.vwap.band1, enabled: true, multiplier: 1.5 },
        },
      },
    });

    expect(saved.layoutType).toBe("2X1");
    const list = await chartTemplatesApi.list();
    expect(list).toHaveLength(1);
    const loaded = list[0]!.panels[0]!;
    expect(loaded.chartLayout).toBe("2x1");
    expect(loaded.mainTimeframe).toBe("1m");
    expect(loaded.syncPrice2x1).toBe(true);
    expect(loaded.panes?.["1"]).toEqual({
      timeframe: "5m",
      indicators: ["EMA", "VWAP", "SMC"],
      showVolume: false,
    });
    expect(loaded.indicatorSettings?.vwap.band1.enabled).toBe(true);
    expect(loaded.indicatorSettings?.vwap.band1.multiplier).toBe(1.5);
  });
});
