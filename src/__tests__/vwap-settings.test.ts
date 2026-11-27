import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_INDICATOR_SETTINGS,
  getIndicatorSettings,
  resetIndicatorSettings,
  updateIndicatorSettings,
} from "../hooks/useIndicatorSettings.ts";
import { vwapBands, type CandleData } from "../lib/indicators.ts";

describe("VWAP configuration & Upper/Lower bands", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("computes vwapBands with configurable price sources (hlc3, hl2, ohlc4, close) and multipliers", () => {
    const candles: CandleData[] = [
      { time: 1700000000, open: 100, high: 120, low: 90, close: 110, volume: 100 },
      { time: 1700000300, open: 110, high: 130, low: 100, close: 120, volume: 100 },
    ];

    const hlc3 = vwapBands(candles, { anchor: "session", source: "hlc3", multipliers: [1.5, 2.5, 3.5] });
    // Bar 0 HLC3 = (120+90+110)/3 = 106.6667, Bar 1 HLC3 = (130+100+120)/3 = 116.6667 -> equal vol mean = 111.6667
    expect(hlc3.vwap[0]!.value).toBeCloseTo((120 + 90 + 110) / 3, 6);
    expect(hlc3.vwap[1]!.value).toBeCloseTo(111.6666667, 5);
    // stdDev = 5, so ±1.5σ around 111.6667 => 119.1667 / 104.1667
    expect(hlc3.upper1[1]!.value).toBeCloseTo(111.6666667 + 1.5 * 5, 5);
    expect(hlc3.lower1[1]!.value).toBeCloseTo(111.6666667 - 1.5 * 5, 5);
    expect(hlc3.upper2[1]!.value).toBeCloseTo(111.6666667 + 2.5 * 5, 5);
    expect(hlc3.lower3[1]!.value).toBeCloseTo(111.6666667 - 3.5 * 5, 5);

    const hl2 = vwapBands(candles, { anchor: "session", source: "hl2" });
    expect(hl2.vwap[0]!.value).toBeCloseTo((120 + 90) / 2, 6);

    const ohlc4 = vwapBands(candles, { anchor: "session", source: "ohlc4" });
    expect(ohlc4.vwap[0]!.value).toBeCloseTo((100 + 120 + 90 + 110) / 4, 6);

    const closeOnly = vwapBands(candles, { anchor: "session", source: "close" });
    expect(closeOnly.vwap[0]!.value).toBeCloseTo(110, 6);
    expect(closeOnly.vwap[1]!.value).toBeCloseTo(115, 6);
  });

  it("persists, merges nested bands, normalizes invalid inputs, and resets VWAP independently", () => {
    const initial = getIndicatorSettings();
    expect(initial.vwap).toEqual(DEFAULT_INDICATOR_SETTINGS.vwap);

    // Modify EMA first to verify resetIndicatorSettings("vwap") leaves other indicators intact
    updateIndicatorSettings({
      ema: {
        lines: [{ id: "ema-21", period: 21, color: "#10b981", enabled: true, lineWidth: 3 }],
      },
    });

    const updated = updateIndicatorSettings({
      vwap: {
        anchor: "week",
        source: "close",
        color: "#38bdf8",
        lineWidth: 3,
        showBandLabels: true,
        band1: { enabled: true, multiplier: 1.5 },
        band2: { enabled: true, multiplier: 2.5, lineStyle: "solid" },
      },
    });

    expect(updated.vwap.anchor).toBe("week");
    expect(updated.vwap.source).toBe("close");
    expect(updated.vwap.color).toBe("#38bdf8");
    expect(updated.vwap.lineWidth).toBe(3);
    expect(updated.vwap.showBandLabels).toBe(true);
    expect(updated.vwap.band1.enabled).toBe(true);
    expect(updated.vwap.band1.multiplier).toBe(1.5);
    // Preserved untouched defaults inside band1 and band3
    expect(updated.vwap.band1.color).toBe(DEFAULT_INDICATOR_SETTINGS.vwap.band1.color);
    expect(updated.vwap.band2.lineStyle).toBe("solid");
    expect(updated.vwap.band3.enabled).toBe(false);

    // Test clamping & invalid value sanitization
    const sanitized = updateIndicatorSettings({
      vwap: {
        anchor: "invalid-anchor" as never,
        source: "invalid-source" as never,
        color: "not-hex",
        lineWidth: 99,
        band1: { multiplier: 0.001, lineStyle: "bogus" as never, color: "bad" },
        band2: { multiplier: 50 },
      },
    });

    expect(sanitized.vwap.anchor).toBe("auto");
    expect(sanitized.vwap.source).toBe("hlc3");
    expect(sanitized.vwap.color).toBe(DEFAULT_INDICATOR_SETTINGS.vwap.color);
    expect(sanitized.vwap.lineWidth).toBe(4);
    expect(sanitized.vwap.band1.multiplier).toBe(0.1);
    expect(sanitized.vwap.band1.lineStyle).toBe("dashed");
    expect(sanitized.vwap.band1.color).toBe(DEFAULT_INDICATOR_SETTINGS.vwap.band1.color);
    expect(sanitized.vwap.band2.multiplier).toBe(10);

    // Reset only VWAP
    const afterReset = resetIndicatorSettings("vwap");
    expect(afterReset.vwap).toEqual(DEFAULT_INDICATOR_SETTINGS.vwap);
    expect(afterReset.ema.lines[0]?.period).toBe(21);
  });
});
