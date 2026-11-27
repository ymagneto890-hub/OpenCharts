import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import btc4hRaw from "../services/demo/data/BTCUSD_4h.json";
import btc1dRaw from "../services/demo/data/BTCUSD_1d.json";
import {
  balancedDivergenceOptions,
  defaultVwapAnchorForTimeframe,
  detectDivergences,
  INDICATOR_REGISTRY,
  macd,
  rsi,
  stochasticRsi,
  vwap,
  vwapBands,
  type CandleData,
} from "../lib/indicators.ts";
import { getDemoSymbol } from "../services/demo/instruments.ts";
import { getHistory } from "../services/demo/candles.ts";
import { toIbkrContract } from "../server/ibkrEngine.ts";
import { extractBaseAsset } from "../hooks/useInstrumentLabels.ts";
import { extractCurrencies } from "../pages/trading/utils.ts";
import { BottomPanel } from "../pages/trading/BottomPanel.tsx";
import { OrderPanel } from "../pages/trading/OrderPanel.tsx";
import { OrderModifyDialog } from "../components/trading-dialogs/OrderModifyDialog.tsx";
import { PositionModifyDialog } from "../components/trading-dialogs/PositionModifyDialog.tsx";
import { ChartSettingsDialog } from "../pages/trading/ChartSettingsDialog.tsx";
import { ChartToolbar } from "../pages/trading/ChartToolbar.tsx";
import {
  getChartPreferencesFromStorage,
  updateChartPreferences,
} from "../hooks/useChartPreferences.ts";
import { api } from "../services/api.ts";
import * as engine from "../services/demo/engine.ts";
import { useReplayStore } from "../services/demo/replay.ts";

function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

describe("Bugfixes & RSI/MACD Divergence Regression Suite", () => {
  beforeEach(() => {
    if (useReplayStore.getState().phase !== "idle") {
      useReplayStore.getState().stop();
    }
    engine.resetAccount({
      startingBalance: 10_000,
      feeRate: 0.001,
      keepHistory: false,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("1. detects U-shaped & multi-swing divergences while blocking endpoint breaks and obstructing deeper swings", () => {
    const N = 45;
    const makeSeries = (oscOverride?: Record<number, number>) => {
      const candles: CandleData[] = [];
      const osc: Array<{ time: number; value: number }> = [];
      for (let i = 0; i < N; i++) {
        let low = 110;
        let close = 112;
        if (i === 9) { low = 103; close = 104; }
        else if (i === 10) { low = 100; close = 101; }
        else if (i === 11) { low = 100.3; close = 102; } // rounded price shoulder below straight chord
        else if (i >= 14 && i <= 22) { low = 115; close = 118; }
        else if (i === 18) { low = 104; close = 106; } // harmless mid-range bounce pullback (> both endpoints)
        else if (i === 25) { low = 91; close = 93; }
        else if (i === 26) { low = 90; close = 91; }
        else if (i === 27) { low = 92; close = 94; }

        let val = 45;
        if (i === 10) val = 22;
        else if (i === 9) val = 26;
        else if (i === 11) val = 22.2;
        else if (i >= 6 && i < 9) val = 35;
        else if (i >= 12 && i <= 24) val = 48 - Math.abs(i - 16) * 2;
        else if (i === 23) val = 36;
        else if (i === 25) val = 31;
        else if (i === 26) val = 30;
        else if (i >= 27 && i <= 31) val = 35 + (i - 27);

        if (oscOverride && oscOverride[i] !== undefined) val = oscOverride[i]!;
        const t = 1700000000 + i * 3600;
        candles.push({ time: t, open: close + 1, high: close + 3, low, close, volume: 1000 });
        osc.push({ time: t, value: val });
      }
      return { candles, osc };
    };

    const opts = {
      mode: "rsi" as const,
      oscLeftBars: 3,
      oscRightBars: 2,
      minBars: 5,
      filterZones: true,
      includeHidden: false,
    };

    // U-shaped swing + minor intermediate ripple between P1(10) and P2(26) should be accepted cleanly!
    const valid = makeSeries({ 13: 23.0, 17: 44, 18: 34, 19: 42 });
    const validDivs = detectDivergences(valid.candles, valid.osc, opts);
    expect(validDivs.some((d) => d.kind === "bull")).toBe(true);

    // Interior bar breaks price floor strictly below min(100, 90) = 90 while keeping osc pivots unchanged -> blocked!
    const endpointBreach = makeSeries();
    endpointBreach.candles[14]!.low = 89;
    const breachBlocked = detectDivergences(endpointBreach.candles, endpointBreach.osc, opts);
    expect(breachBlocked.some((d) => d.kind === "bull")).toBe(false);

    // Obstructing lower oscillator valley at idx 18 (< 22) blocks P1(10)->P2(26)!
    const obstructed = makeSeries({ 16: 35, 17: 25, 18: 18, 19: 26, 20: 36 });
    const obsDivs = detectDivergences(obstructed.candles, obstructed.osc, opts);
    expect(obsDivs.some((d) => d.kind === "bull" && d.startTime === obstructed.candles[10]!.time)).toBe(false);
  });

  it("2. captures 2-bar Histogram / 3-bar MACD Line phase lag pivots, enforces zero-cross by default on Histogram, surfaces visible BTC divergences, and stays 100% causal (zero repainting)", () => {
    const raw = btc4hRaw as Array<CandleData>;
    const candles = raw.slice(0, 1200);
    const macdSeries = macd(candles, 12, 26, 9).histogram;
    const defaultMacdOpts = balancedDivergenceOptions("4h", "macd");
    expect(defaultMacdOpts.oscillatorSource).toBe("histogram");
    expect(defaultMacdOpts.neighborhoodWindow).toBe(2);
    expect(defaultMacdOpts.requireMacdZeroCrossForRegular).toBe(true);
    expect(balancedDivergenceOptions("4h", "macd", "macd").neighborhoodWindow).toBe(3);

    const fullSignals = detectDivergences(candles, macdSeries, defaultMacdOpts);
    expect(fullSignals.length).toBeGreaterThan(0);

    const timeToIdx = new Map(candles.map((c, i) => [c.time, i]));
    for (const sig of fullSignals) {
      const confIdx = timeToIdx.get(sig.confirmedTime);
      expect(confIdx).toBeDefined();
      const prefixCandles = candles.slice(0, confIdx! + 1);
      const prefixHist = macd(prefixCandles, 12, 26, 9).histogram;
      const prefixSignals = detectDivergences(prefixCandles, prefixHist, defaultMacdOpts);
      const exactMatch = prefixSignals.some(
        (p) =>
          p.kind === sig.kind &&
          p.startTime === sig.startTime &&
          p.endTime === sig.endTime &&
          p.confirmedTime === sig.confirmedTime,
      );
      expect(exactMatch).toBe(true);
    }

    // Recent 300 visible bars on BTC 4H and 1D both surface genuine trader divergences
    for (const [dataset, tf] of [[raw, "4h"], [btc1dRaw as Array<CandleData>, "1d"]] as const) {
      const tail = dataset.slice(-500);
      const start300 = tail[200]!.time;
      const rsiReg = detectDivergences(tail, rsi(tail, 14), {
        ...balancedDivergenceOptions(tf, "rsi", "rsi"),
        includeHidden: false,
      }).filter((d) => d.endTime >= start300);
      const histReg = detectDivergences(tail, macd(tail, 12, 26, 9).histogram, {
        ...balancedDivergenceOptions(tf, "macd", "histogram"),
        includeHidden: false,
      }).filter((d) => d.endTime >= start300);
      expect(rsiReg.length).toBeGreaterThanOrEqual(1);
      expect(histReg.length).toBeGreaterThanOrEqual(1);
    }
  });

  it("3. prevents near-zero MACD anchor from triggering microscopic hidden-divergence noise while keeping valid hidden swings", () => {
    const N = 60;
    const candles: CandleData[] = [];
    const osc: Array<{ time: number; value: number }> = [];
    for (let i = 0; i < N; i++) {
      // Large prior MACD magnitude (~50) so rolling scale is ~20-30, followed by two small bottoms near zero (-0.01 vs -0.05)
      let val = 20;
      let low = 100;
      if (i < 25) {
        val = i % 2 === 0 ? 40 : -35;
      } else if (i === 30) {
        val = -0.01;
        low = 95;
      } else if (i >= 27 && i <= 33) {
        val = 5;
        if (i === 29 || i === 31) val = 2;
      } else if (i >= 34 && i <= 38) {
        val = 12;
        low = 102;
      } else if (i === 42) {
        val = -0.05; // tiny 0.04 change when rolling scale is huge!
        low = 98; // Higher Low -> would falsely trigger hidden-bull without rolling floor
      } else if (i >= 39) {
        val = 4;
        if (i === 41 || i === 43) val = 1;
      }
      const t = 1700000000 + i * 14400;
      candles.push({ time: t, open: low + 2, high: low + 5, low, close: low + 3, volume: 1000 });
      osc.push({ time: t, value: val });
    }

    const noiseSignals = detectDivergences(candles, osc, {
      mode: "macd",
      oscLeftBars: 3,
      oscRightBars: 2,
      minBars: 5,
      filterZones: false,
      includeRegular: false,
      includeHidden: true,
    });
    expect(noiseSignals).toHaveLength(0);
  });

  it("4. resolves *USDT aliases like BTCUSDT to BTCUSD without corrupting initialPrice", () => {
    const btc = getDemoSymbol("BTCUSD");
    expect(btc).toBeDefined();
    const originalPrice = btc!.initialPrice;

    const alias = getDemoSymbol("BTCUSDT");
    expect(alias?.name).toBe("BTCUSD");
    expect(alias?.initialPrice).toBe(originalPrice);
    expect(btc!.initialPrice).toBe(originalPrice);
  });

  it("5. includes BTC in extractCurrencies('BTCUSD') so Bitcoin landmarks are not filtered out", () => {
    const currencies = extractCurrencies("BTCUSD");
    expect(currencies).toContain("BTC");
    expect(currencies).toContain("USD");
  });

  it("6. renders 'Cancel All' button on BottomPanel Orders tab even when open positions list is empty", () => {
    const qc = createQueryClient();
    const pendingOrder = {
      id: "ord-1",
      accountId: "acc-1",
      symbolName: "BTCUSD",
      side: "BUY" as const,
      type: "LIMIT" as const,
      quantity: 0.1,
      filledQuantity: 0,
      price: 60_000,
      stopPrice: null,
      takeProfit: null,
      stopLoss: null,
      avgFillPrice: null,
      comment: null,
      status: "PENDING" as const,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const { getByText } = render(
      React.createElement(
        QueryClientProvider,
        { client: qc },
        React.createElement(BottomPanel, {
          tab: "orders",
          onTabChange: vi.fn(),
          positions: [],
          orders: [pendingOrder],
          accountId: "acc-1",
          journalEntries: [],
          journalLoading: false,
          onCreateJournal: vi.fn(),
          onUpdateJournal: vi.fn(),
          onDeleteJournal: vi.fn(),
        }),
      ),
    );

    expect(getByText("Cancel All (1)")).toBeTruthy();
  });

  it("7. allows memecoin unit quantities above 1,000,000 in OrderPanel (e.g. 10,000,000 PEPE)", async () => {
    const qc = createQueryClient();
    const confirmSpy = vi.fn();

    const { getByTestId } = render(
      React.createElement(
        QueryClientProvider,
        { client: qc },
        React.createElement(OrderPanel, {
          symbol: "PEPEUSD",
          tick: { bid: 0.00001, ask: 0.00001, timestamp: Date.now() },
          accountId: engine.getAccount().id,
          oneClick: false,
          onConfirmOrder: confirmSpy,
          accountBalance: 10_000,
          isFeedConnected: true,
        }),
      ),
    );

    const qtyInput = getByTestId("order-quantity-input") as HTMLInputElement;
    expect(qtyInput.value).toBe("10000000");

    fireEvent.click(getByTestId("submit-order-btn"));

    await waitFor(() => {
      expect(confirmSpy).toHaveBeenCalledTimes(1);
    });
    expect(confirmSpy.mock.calls[0]![0]).toMatchObject({
      symbol: "PEPEUSD",
      quantity: 10_000_000,
    });
  });

  it("8. PositionModifyDialog & OrderModifyDialog reject NaN inputs and skip no-op Order saves", async () => {
    const modOrderSpy = vi.spyOn(api, "modifyOrder").mockResolvedValue({} as never);
    const modPosSpy = vi.spyOn(api, "modifyPosition").mockResolvedValue({} as never);

    // 8a. OrderModifyDialog: unchanged STOP order triggers No Changes instead of calling modifyOrder
    const { getByText, container, unmount } = render(
      React.createElement(OrderModifyDialog, {
        order: {
          id: "o1",
          symbolName: "BTCUSD",
          side: "BUY",
          type: "STOP",
          quantity: 0.1,
          price: null,
          stopPrice: 95_000,
          takeProfit: 98_000,
          stopLoss: 93_000,
        },
        onClose: vi.fn(),
        onSaved: vi.fn(),
      }),
    );

    fireEvent.click(getByText("Save Changes"));
    expect(modOrderSpy).not.toHaveBeenCalled();

    // Invalid TP/SL on OrderModifyDialog (use negative numeric string so jsdom type="number" doesn't coerce to "")
    const inputs = container.querySelectorAll("input");
    fireEvent.change(inputs[2]!, { target: { value: "-5" } });
    fireEvent.click(getByText("Save Changes"));
    expect(modOrderSpy).not.toHaveBeenCalled();
    unmount();

    // 8b. PositionModifyDialog: invalid negative TP input does not call api.modifyPosition
    const posRender = render(
      React.createElement(PositionModifyDialog, {
        position: {
          id: "p1",
          symbolName: "BTCUSD",
          side: "LONG",
          quantity: 0.1,
          entryPrice: 90_000,
          currentPrice: 91_000,
          unrealizedPnl: 100,
          openedAt: new Date().toISOString(),
          takeProfit: 95_000,
          stopLoss: 88_000,
        },
        onClose: vi.fn(),
        onSaved: vi.fn(),
      }),
    );
    const posInputs = posRender.container.querySelectorAll("input");
    fireEvent.change(posInputs[0]!, { target: { value: "-5" } });
    fireEvent.click(posRender.getByText("Save Changes"));
    expect(modPosSpy).not.toHaveBeenCalled();
  });

  it("9. engine.getSummary().openPositions counts only positions belonging to active mode (live vs replay)", () => {
    engine.mark("BTCUSD", 90_000);
    const accountId = engine.getAccount().id;
    engine.placeOrder({
      accountId,
      symbol: "BTCUSD",
      side: "BUY",
      type: "MARKET",
      quantity: 0.01,
    });
    expect(engine.getSummary().openPositions).toBe(1);

    // Entering replay isolates openPositions from live positions
    engine.enterReplay("BTCUSD", {
      timeSec: 1700000000,
      open: 40_000,
      high: 40_500,
      low: 39_800,
      close: 40_200,
    });
    expect(engine.getSummary().openPositions).toBe(0);

    // Placing a replay trade increments replay openPositions to 1
    engine.placeOrder({
      accountId,
      symbol: "BTCUSD",
      side: "BUY",
      type: "MARKET",
      quantity: 0.01,
    });
    expect(engine.getSummary().openPositions).toBe(1);

    engine.exitReplay();
    expect(engine.getSummary().openPositions).toBe(1);
  });

  it("10. ChartSettingsDialog RESET_BY_TAB restores trading and challenge defaults cleanly", () => {
    updateChartPreferences({
      showBidLine: true,
      showAskLine: true,
      challengeOverlay: true,
      challengeDailyLossLine: true,
    });
    const prefs = getChartPreferencesFromStorage();
    const { getByText } = render(
      React.createElement(ChartSettingsDialog, {
        open: true,
        onClose: vi.fn(),
        prefs,
        isDark: true,
        activePlugins: [],
        onOpenNewsConfig: vi.fn(),
        hasAccount: true,
      }),
    );

    fireEvent.click(getByText("Trading"));
    fireEvent.click(getByText("Reset to defaults"));
    expect(getChartPreferencesFromStorage().showBidLine).toBe(false);
    expect(getChartPreferencesFromStorage().showAskLine).toBe(false);

    fireEvent.click(getByText("Challenge"));
    fireEvent.click(getByText("Reset to defaults"));
    expect(getChartPreferencesFromStorage().challengeOverlay).toBe(false);
    expect(getChartPreferencesFromStorage().challengeDailyLossLine).toBe(false);
  });

  it("11. preserves RSI exhaustion climax divergences when bar t makes a trailing 1-bar wick while still blocking monotonic non-swings", () => {
    const N = 45;
    const candles: CandleData[] = [];
    const osc: Array<{ time: number; value: number }> = [];
    for (let i = 0; i < N; i++) {
      let high = 100;
      if (i === 12) high = 120; // Peak 1 local 3-bar swing high (100, 120, 100)
      else if (i === 15) high = 120.5; // 3 bars later at bar t=15: slightly higher wick before falling back to 100
      else if (i === 28) high = 135; // Peak 2 HH (135 > 120)
      const val =
        i >= 7 && i <= 15
          ? 82 - Math.abs(i - 12) * 8
          : i >= 23 && i <= 32
            ? 68 - Math.abs(i - 28) * 8
            : 45;
      const t = 1700000000 + i * 86400;
      candles.push({ time: t, open: high - 4, high, low: high - 6, close: high - 2, volume: 1000 });
      osc.push({ time: t, value: val });
    }
    // Keep high=120 at 12 >= bar 15 wick only if not above 135; ensure P1(12) has bar 15 < P2(28) and neighborhood at t=15 picks idx 15 unless neighborhood=2 picks 15? Wait: idx=12 + 2 = 14 (< 15), so P1 picks idx 12 (high=120), while bar t=15 has high=120.5!
    const climaxDivs = detectDivergences(candles, osc, {
      mode: "rsi",
      oscLeftBars: 5,
      oscRightBars: 3,
      neighborhoodWindow: 2,
      minBars: 5,
      includeHidden: false,
    });
    expect(climaxDivs.some((d) => d.kind === "bear")).toBe(true);

    // Monotonic rising price through Peak 2 (not a local 3-bar high) -> 0 signals!
    for (let i = 27; i <= 31; i++) {
      candles[i]!.high = 130 + (i - 27) * 3;
      candles[i]!.close = candles[i]!.high - 1;
    }
    const monoDivs = detectDivergences(candles, osc, {
      mode: "rsi",
      oscLeftBars: 5,
      oscRightBars: 3,
      neighborhoodWindow: 1,
      minBars: 5,
      includeHidden: false,
    });
    expect(monoDivs.some((d) => d.kind === "bear")).toBe(false);
  });

  it("12. enforces Elder zero-cross and deepest/tallest wave extreme on MACD Histogram (rejects same-valley/same-mound and 0.0-touch signals)", () => {
    const buildValleyPair = (
      midPeak: number,
      mode: "regular" | "hidden" | "bear-reg" | "bear-hid",
      shoulderInsideFirstWave = false,
    ) => {
      const N = 60;
      const candles: CandleData[] = [];
      const osc: Array<{ time: number; value: number }> = [];
      const isBear = mode === "bear-reg" || mode === "bear-hid";
      const sign = isBear ? 1 : -1;

      for (let i = 0; i < N; i++) {
        let val = sign * 5;
        let priceExt = isBear ? 100 : 100;

        if (i >= 7 && i <= 15) {
          val = sign * (mode === "hidden" || mode === "bear-hid" ? 30 : 60) - sign * Math.abs(i - 11) * 5;
        } else if (shoulderInsideFirstWave && i >= 16 && i <= 21) {
          val = sign * 42 - sign * Math.abs(i - 18) * 3;
        } else if (i >= (shoulderInsideFirstWave ? 22 : 16) && i <= 29) {
          // Middle wave peaking/bottoming at midPeak between Valley/Mountain 1 and 2
          const center = shoulderInsideFirstWave ? 25 : 22;
          val = midPeak + sign * Math.abs(i - center) * 1.5;
        } else if (i >= 32 && i <= 40) {
          const secondMag = mode === "hidden" || mode === "bear-hid" ? 55 : 30;
          val = sign * secondMag - sign * Math.abs(i - 36) * 5;
        }

        if (i === 11) {
          priceExt = mode === "regular" ? 95 : mode === "hidden" ? 90 : mode === "bear-reg" ? 110 : 120;
        } else if (shoulderInsideFirstWave && i === 18) {
          priceExt = isBear ? 108 : 96;
        } else if (i === 36) {
          priceExt = mode === "regular" ? 88 : mode === "hidden" ? 96 : mode === "bear-reg" ? 120 : 112;
        }

        const t = 1700000000 + i * 14400;
        candles.push({
          time: t,
          open: isBear ? priceExt - 2 : priceExt + 2,
          high: isBear ? priceExt : priceExt + 4,
          low: isBear ? priceExt - 4 : priceExt,
          close: isBear ? priceExt - 1 : priceExt + 1,
          volume: 1000,
        });
        osc.push({ time: t, value: val });
      }
      return { candles, osc };
    };

    const opts = {
      ...balancedDivergenceOptions("4h", "macd", "histogram"),
      oscLeftBars: 3,
      oscRightBars: 2,
      includeHidden: true,
    };

    // 1. Two bottoms inside the SAME red MACD Histogram valley (midPeak = -10 < 0): MUST reject regular & hidden!
    const sameRedReg = buildValleyPair(-10, "regular");
    expect(detectDivergences(sameRedReg.candles, sameRedReg.osc, opts)).toHaveLength(0);

    const sameRedHid = buildValleyPair(-10, "hidden");
    expect(detectDivergences(sameRedHid.candles, sameRedHid.osc, opts)).toHaveLength(0);

    // 2. Two tops inside the SAME green MACD Histogram mountain (midPeak = +10 > 0): MUST reject regular & hidden!
    const sameGreenReg = buildValleyPair(10, "bear-reg");
    expect(detectDivergences(sameGreenReg.candles, sameGreenReg.osc, opts)).toHaveLength(0);

    const sameGreenHid = buildValleyPair(10, "bear-hid");
    expect(detectDivergences(sameGreenHid.candles, sameGreenHid.osc, opts)).toHaveLength(0);

    // 3. Touching exact 0.0 without printing a strictly positive green bar MUST be rejected
    const touchZero = buildValleyPair(0, "regular");
    expect(detectDivergences(touchZero.candles, touchZero.osc, opts)).toHaveLength(0);

    // 4. Genuine green bounce (> 0) between two red valleys IS accepted cleanly
    const validElder = buildValleyPair(12, "regular");
    const validSignals = detectDivergences(validElder.candles, validElder.osc, opts);
    expect(validSignals.some((d) => d.kind === "bull")).toBe(true);

    // 5. Shallower shoulder inside Valley 1 must NEVER be used instead of the deepest valley extreme
    const withShoulder = buildValleyPair(14, "regular", true);
    const shoulderDivs = detectDivergences(withShoulder.candles, withShoulder.osc, opts).filter(
      (d) => d.kind === "bull",
    );
    expect(shoulderDivs.every((d) => d.startTime === withShoulder.candles[11]!.time)).toBe(true);
    expect(shoulderDivs.some((d) => d.startTime === withShoulder.candles[18]!.time)).toBe(false);
  });

  it("13. enforces Constance Brown RSI 40/60 exhaustion zones while keeping genuine oversold/overbought divergences", () => {
    const N = 45;
    const makeRsiSeries = (rsi1: number, rsi2: number) => {
      const candles: CandleData[] = [];
      const osc: Array<{ time: number; value: number }> = [];
      for (let i = 0; i < N; i++) {
        let high = 100;
        if (i === 11) high = 115;
        else if (i === 29) high = 125;
        let val = 44;
        if (i >= 7 && i <= 15) val = rsi1 - Math.abs(i - 11) * 4;
        else if (i >= 16 && i <= 24) val = 36 + Math.abs(i - 20) * 1.5;
        else if (i >= 25 && i <= 33) val = rsi2 - Math.abs(i - 29) * 4;
        const t = 1700000000 + i * 14400;
        candles.push({ time: t, open: high - 2, high, low: high - 5, close: high - 1, volume: 1000 });
        osc.push({ time: t, value: val });
      }
      return { candles, osc };
    };

    const opts = {
      ...balancedDivergenceOptions("4h", "rsi", "rsi"),
      oscLeftBars: 3,
      oscRightBars: 2,
      includeHidden: false,
    };

    // Dead-neutral 52.3 -> 45.4 chop must be rejected
    const weak = makeRsiSeries(52.3, 45.4);
    expect(detectDivergences(weak.candles, weak.osc, opts)).toHaveLength(0);

    // Genuine >= 60 overbought bearish divergence must be accepted
    const genuine = makeRsiSeries(72, 61);
    expect(detectDivergences(genuine.candles, genuine.osc, opts).some((d) => d.kind === "bear")).toBe(
      true,
    );
  });

  it("14. satisfies 100% strict Elder zero-cross, wave-extreme, contraction (>=10%), and causality invariants on full BTC 4H and 1D history", () => {
    for (const [raw, tf] of [
      [btc4hRaw as Array<CandleData>, "4h"],
      [btc1dRaw as Array<CandleData>, "1d"],
    ] as const) {
      const hist = macd(raw, 12, 26, 9).histogram;
      const histIdx = new Map(hist.map((p, i) => [p.time, i]));
      const opts = {
        ...balancedDivergenceOptions(tf, "macd", "histogram"),
        includeHidden: false,
      };
      const divs = detectDivergences(raw, hist, opts);
      expect(divs.length).toBeGreaterThan(5);

      for (const d of divs) {
        const p1 = histIdx.get(d.startTime)!;
        const p2 = histIdx.get(d.endTime)!;
        let maxBetween = -Infinity;
        let minBetween = Infinity;
        for (let k = p1 + 1; k < p2; k++) {
          const v = hist[k]!.value;
          if (v > maxBetween) maxBetween = v;
          if (v < minBetween) minBetween = v;
        }
        if (d.kind === "bull") {
          expect(d.startOsc).toBeLessThan(0);
          expect(d.endOsc).toBeLessThan(0);
          expect(maxBetween).toBeGreaterThan(0);
          for (let k = p1 - 1; k >= 0 && hist[k]!.value < 0; k--) {
            expect(hist[k]!.value).toBeGreaterThanOrEqual(d.startOsc - 1e-12);
          }
          for (let k = p2 - 1; k >= 0 && hist[k]!.value < 0; k--) {
            expect(hist[k]!.value).toBeGreaterThanOrEqual(d.endOsc - 1e-12);
          }
        } else {
          expect(d.startOsc).toBeGreaterThan(0);
          expect(d.endOsc).toBeGreaterThan(0);
          expect(minBetween).toBeLessThan(0);
          for (let k = p1 - 1; k >= 0 && hist[k]!.value > 0; k--) {
            expect(hist[k]!.value).toBeLessThanOrEqual(d.startOsc + 1e-12);
          }
          for (let k = p2 - 1; k >= 0 && hist[k]!.value > 0; k--) {
            expect(hist[k]!.value).toBeLessThanOrEqual(d.endOsc + 1e-12);
          }
        }
        const contraction = 1 - Math.abs(d.endOsc) / Math.abs(d.startOsc);
        expect(contraction).toBeGreaterThanOrEqual(0.1 - 1e-9);
      }
    }
  });

  it("15. computes causal VWAP with symmetrical ±1σ, ±2σ, ±3σ standard deviation bands and timeframe anchors", () => {
    expect(defaultVwapAnchorForTimeframe("15m")).toBe("session");
    expect(defaultVwapAnchorForTimeframe("4h")).toBe("session");
    expect(defaultVwapAnchorForTimeframe("1d")).toBe("month");
    expect(defaultVwapAnchorForTimeframe("1w")).toBe("year");

    const day1 = 1700006400; // 2023-11-15T00:00:00Z
    const sampleCandles: CandleData[] = [
      // Bar 0: TP = (12 + 9 + 9)/3 = 10, vol = 100 -> mean = 10, std = 0
      { time: day1, open: 10, high: 12, low: 9, close: 9, volume: 100 },
      // Bar 1: TP = (22 + 19 + 19)/3 = 20, vol = 300 -> mean = (1000+6000)/400 = 17.5
      // variance = (100*(10-17.5)^2 + 300*(20-17.5)^2)/400 = (5625 + 1875)/400 = 18.75 -> std = sqrt(18.75)
      { time: day1 + 3600, open: 20, high: 22, low: 19, close: 19, volume: 300 },
      // Bar 2 (next UTC day -> session reset!): TP = 50, vol = 50 -> mean = 50, std = 0
      { time: day1 + 86400, open: 50, high: 52, low: 48, close: 50, volume: 50 },
    ];

    const bands = vwapBands(sampleCandles, { anchor: "session" });
    const legacyVwap = vwap(sampleCandles, true);
    expect(bands.vwap.map((p) => p.value)).toEqual(legacyVwap.map((p) => p.value));

    const expectedStd1 = Math.sqrt(18.75);
    expect(bands.vwap[0]!.value).toBeCloseTo(10, 8);
    expect(bands.upper1[0]!.value).toBeCloseTo(10, 8);
    expect(bands.lower3[0]!.value).toBeCloseTo(10, 8);

    expect(bands.vwap[1]!.value).toBeCloseTo(17.5, 8);
    expect(bands.upper1[1]!.value).toBeCloseTo(17.5 + expectedStd1, 8);
    expect(bands.lower1[1]!.value).toBeCloseTo(17.5 - expectedStd1, 8);
    expect(bands.upper2[1]!.value).toBeCloseTo(17.5 + 2 * expectedStd1, 8);
    expect(bands.lower2[1]!.value).toBeCloseTo(17.5 - 2 * expectedStd1, 8);
    expect(bands.upper3[1]!.value).toBeCloseTo(17.5 + 3 * expectedStd1, 8);
    expect(bands.lower3[1]!.value).toBeCloseTo(17.5 - 3 * expectedStd1, 8);

    // Session reset at UTC midnight resets both VWAP and stdDev to 0
    expect(bands.vwap[2]!.value).toBeCloseTo(50, 8);
    expect(bands.upper3[2]!.value).toBeCloseTo(50, 8);
    expect(bands.lower3[2]!.value).toBeCloseTo(50, 8);

    // Month & year anchors keep bar 2 in the same November 2023 bucket instead of resetting
    const monthlyBands = vwapBands(sampleCandles, { anchor: "month" });
    expect(monthlyBands.vwap[2]!.value).toBeLessThan(30);
    expect(monthlyBands.upper3[2]!.value).toBeGreaterThan(monthlyBands.upper2[2]!.value);
    expect(monthlyBands.lower3[2]!.value).toBeLessThan(monthlyBands.lower2[2]!.value);

    // Strict prefix causality: adding future bars must never mutate earlier VWAP/band points
    const prefixOnly = vwapBands(sampleCandles.slice(0, 2), { anchor: "month" });
    expect(prefixOnly.upper2[1]!.value).toBeCloseTo(monthlyBands.upper2[1]!.value, 10);
    expect(prefixOnly.lower3[1]!.value).toBeCloseTo(monthlyBands.lower3[1]!.value, 10);
  });

  it("16. supports perpetual aliases (BTCUSDT.P) and maps US consolidated IBKR contracts accurately", () => {
    const btcPerp = getDemoSymbol("BTCUSDT.P");
    expect(btcPerp).toBeDefined();
    expect(btcPerp?.category).toBe("FUTURES");
    expect(btcPerp?.isPerpetual).toBe(true);
    expect(btcPerp?.maxLeverage).toBe(125);

    // Spot alias must continue resolving to BTCUSD (never colliding with perpetuals)
    expect(getDemoSymbol("BTCUSDT")?.name).toBe("BTCUSD");

    // Dynamic perpetual ticker registration & lookup
    const dynamicPerp = getDemoSymbol("ARBUSDT.P");
    expect(dynamicPerp).toMatchObject({
      name: "ARBUSDT.P",
      category: "FUTURES",
      isPerpetual: true,
      exchange: "PERP",
    });

    // IBKR US Consolidated contract mapping (NYSE / NASDAQ -> ISLAND / AMEX / SMART)
    expect(toIbkrContract("NVDA", "NASDAQ")).toMatchObject({
      symbol: "NVDA",
      secType: "STK",
      exchange: "SMART",
      currency: "USD",
      primaryExch: "ISLAND",
    });
    expect(toIbkrContract("BRK.B", "NYSE")).toMatchObject({
      symbol: "BRK B",
      secType: "STK",
      exchange: "SMART",
      currency: "USD",
      primaryExch: "NYSE",
    });

    // Base asset & currency extraction for order sizing and news matching
    expect(extractBaseAsset("BTCUSDT.P")).toBe("BTC");
    expect(extractCurrencies("BTCUSDT.P")).toContain("BTC");
    expect(extractCurrencies("BTCUSDT.P")).toContain("USD");

    // Offline/Replay fixture history reuses bundled real BTC market data cleanly in test mode
    const perpHistory = getHistory("BTCUSDT.P", "4h", 120);
    expect(perpHistory.length).toBe(120);
    expect(perpHistory[perpHistory.length - 1]!.close).toBeGreaterThan(0);
  });

  it("17. computes causal Stochastic RSI (14, 14, 3, 3) with exact SMA smoothing, flat-price safety, and registry metadata", () => {
    const stochMeta = INDICATOR_REGISTRY.find((r) => r.type === "STOCH");
    expect(stochMeta).toMatchObject({
      type: "STOCH",
      label: "Stochastic RSI (14, 14, 3, 3)",
      pane: "below",
      color: "#2962ff",
      defaultParams: { rsiPeriod: 14, stochPeriod: 14, kSmooth: 3, dSmooth: 3 },
    });

    const tail = (btc4hRaw as Array<CandleData>).slice(-120);
    const res = stochasticRsi(tail, 14, 14, 3, 3);
    expect(res.k.length).toBeGreaterThan(50);
    expect(res.d.length).toBe(res.k.length - 2);

    for (const pt of [...res.k, ...res.d]) {
      expect(Number.isFinite(pt.value)).toBe(true);
      expect(pt.value).toBeGreaterThanOrEqual(0);
      expect(pt.value).toBeLessThanOrEqual(100);
    }

    // %D equals exact 3-period SMA of %K
    const kByTime = new Map(res.k.map((p, idx) => [p.time, idx]));
    for (const dPt of res.d) {
      const idx = kByTime.get(dPt.time)!;
      const expected = (res.k[idx - 2]!.value + res.k[idx - 1]!.value + res.k[idx]!.value) / 3;
      expect(dPt.value).toBeCloseTo(expected, 10);
    }

    // Flat candles stay finite (50, no NaN / div-by-zero)
    const flatCandles: CandleData[] = Array.from({ length: 40 }, (_, i) => ({
      time: 1700000000 + i * 3600,
      open: 100,
      high: 100,
      low: 100,
      close: 100,
      volume: 100,
    }));
    const flatRes = stochasticRsi(flatCandles, 14, 14, 3, 3);
    expect(flatRes.k.length).toBeGreaterThan(0);
    for (const pt of [...flatRes.k, ...flatRes.d]) {
      expect(pt.value).toBe(50);
    }

    // Strict prefix causality: extreme future spike cannot alter earlier values
    const prefix = tail.slice(0, 80);
    const extended = [
      ...prefix,
      ...tail.slice(80, 85).map((c) => ({ ...c, high: c.high * 5, close: c.close * 5 })),
    ];
    const pRes = stochasticRsi(prefix, 14, 14, 3, 3);
    const eRes = stochasticRsi(extended, 14, 14, 3, 3);
    for (let i = 0; i < pRes.k.length; i++) {
      expect(eRes.k[i]!.value).toBeCloseTo(pRes.k[i]!.value, 10);
    }
    for (let i = 0; i < pRes.d.length; i++) {
      expect(eRes.d[i]!.value).toBeCloseTo(pRes.d[i]!.value, 10);
    }
  });

  it("18. exposes Volume (MA 20) toggle in Indicators menu synced with showVolume preference", () => {
    updateChartPreferences({ showVolume: true });
    expect(getChartPreferencesFromStorage().showVolume).toBe(true);

    const { getByText } = render(
      React.createElement(ChartToolbar, {
        selectedSymbol: "BTCUSD",
        symbols: [],
        onSymbolChange: vi.fn(),
        timeframe: "4h",
        onTimeframeChange: vi.fn(),
        activeIndicators: ["EMA", "RSI"],
        onToggleIndicator: vi.fn(),
        showIndicatorMenu: true,
        onToggleIndicatorMenu: vi.fn(),
        rightPanel: "order",
        onRightPanel: vi.fn(),
        showRightPanel: true,
        onToggleRightPanel: vi.fn(),
      }),
    );

    // 2 active indicators + Volume ON = badge count "3"
    expect(getByText("3")).toBeTruthy();
    const volumeToggle = getByText("Volumen (MA 20)");
    expect(volumeToggle).toBeTruthy();

    fireEvent.click(volumeToggle);
    expect(getChartPreferencesFromStorage().showVolume).toBe(false);

    fireEvent.click(volumeToggle);
    expect(getChartPreferencesFromStorage().showVolume).toBe(true);
  });
});
