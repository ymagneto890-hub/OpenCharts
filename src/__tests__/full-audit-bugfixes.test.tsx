import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, fireEvent, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { IChartApi, ISeriesApi, SeriesType, Time } from "lightweight-charts";
import btc1dRaw from "../services/demo/data/BTCUSD_1d.json";
import * as engine from "../services/demo/engine.ts";
import {
  buildPartialCandleRange,
  buildPartialCandleUpTo,
  getHistory,
  getRawHistory,
  updateLatestBarPrice,
  TF_SECONDS,
} from "../services/demo/candles.ts";
import { useReplayStore } from "../services/demo/replay.ts";
import { demoApi } from "../services/demo/api.ts";
import { publish } from "../services/demo/bus.ts";
import { useTradingStore } from "../services/store.tsx";
import { queryKeys } from "../services/queries.ts";
import { formatDate, formatDateFull } from "../lib/utils.ts";
import { getPipDigits } from "../pages/trading/utils.ts";
import {
  atr,
  bollingerBands,
  computeMacdThresholds,
  ema,
  macd,
  rsi,
  sma,
  stochastic,
  stochasticRsi,
  type CandleData,
} from "../lib/indicators.ts";
import { convertTime, displayTime } from "../lib/chart-plugins/helpers/time.ts";
import { ClosestTimeIndexFinder } from "../lib/chart-plugins/helpers/closest-index.ts";
import { UpperLowerInRange } from "../lib/chart-plugins/helpers/min-max-in-range.ts";
import { DrawingToolsManager } from "../lib/chart-plugins/drawing-tools/manager.ts";
import { OrderPanel } from "../pages/trading/OrderPanel.tsx";
import { OrderConfirmDialog } from "../components/trading-dialogs/OrderConfirmDialog.tsx";
import { OrderModifyDialog } from "../components/trading-dialogs/OrderModifyDialog.tsx";
import { PositionModifyDialog } from "../components/trading-dialogs/PositionModifyDialog.tsx";
import { Button } from "../components/ui/button.tsx";
import { MarketDataBridge } from "../components/MarketDataBridge.tsx";
import type { DrawingLine } from "../pages/trading/constants.ts";
import type { Position } from "../services/schemas.ts";

function makeTestQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

describe("Full Audit Bugfixes Regression Suite", () => {
  beforeEach(() => {
    if (useReplayStore.getState().phase !== "idle") {
      useReplayStore.getState().stop();
    }
    if (engine.getMode() !== "live") {
      engine.exitReplay();
    }
    engine.resetAccount({
      startingBalance: 100_000,
      feeRate: 0,
      spreadBps: 0,
      slippageBps: 0,
      keepHistory: false,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    if (useReplayStore.getState().phase !== "idle") {
      useReplayStore.getState().stop();
    }
    if (engine.getMode() !== "live") {
      engine.exitReplay();
    }
  });

  // ── Phase 1: Demo Engine ────────────────────────────────────────────────────

  it("1. mark() ignores live ticks when mode is replay and preserves replay position PnL/stops", () => {
    engine.mark("BTCUSD", 50_000);
    engine.enterReplay("BTCUSD", {
      open: 60_000,
      high: 60_100,
      low: 59_900,
      close: 60_000,
      timeSec: 1_700_000_000,
    });

    engine.placeOrder({
      accountId: engine.getAccount().id,
      symbol: "BTCUSD",
      side: "BUY",
      type: "MARKET",
      quantity: 0.1,
      stopLoss: 59_000,
    });

    expect(engine.getPositions()).toHaveLength(1);

    // Simulate a background live tick arriving during replay well below SL
    engine.mark("BTCUSD", 50_000);

    const open = engine.getPositions();
    expect(open).toHaveLength(1);
    expect(open[0]!.currentPrice).toBe(60_000);
    expect(open[0]!.unrealizedPnl).toBe(0);
  });

  it("2. enterReplay() while already in replay closes previous replay positions before switching symbols", () => {
    engine.enterReplay("BTCUSD", {
      open: 60_000,
      high: 60_100,
      low: 59_900,
      close: 60_000,
      timeSec: 1_700_000_000,
    });
    engine.placeOrder({
      accountId: engine.getAccount().id,
      symbol: "BTCUSD",
      side: "BUY",
      type: "MARKET",
      quantity: 0.1,
    });
    expect(engine.getPositions()).toHaveLength(1);

    engine.enterReplay("ETHUSD", {
      open: 3_000,
      high: 3_050,
      low: 2_950,
      close: 3_000,
      timeSec: 1_700_000_900,
    });

    expect(engine.getPositions()).toHaveLength(0);
    expect(engine.getClosedPositions().some((c) => c.symbolName === "BTCUSD")).toBe(true);
  });

  it("3. closePosition() rejects non-positive or NaN partial quantities without closing full position", () => {
    engine.mark("BTCUSD", 50_000);
    engine.placeOrder({
      accountId: engine.getAccount().id,
      symbol: "BTCUSD",
      side: "BUY",
      type: "MARKET",
      quantity: 0.5,
    });

    const pos = engine.getPositions()[0]!;
    expect(engine.closePosition(pos.id, 0).success).toBe(false);
    expect(engine.closePosition(pos.id, -0.1).success).toBe(false);
    expect(engine.closePosition(pos.id, Number.NaN).success).toBe(false);

    const after = engine.getPositions();
    expect(after).toHaveLength(1);
    expect(after[0]!.quantity).toBe(0.5);
  });

  it("4. placeOrder validates MARKET SL/TP against execution price (immediatePx) including spread", () => {
    engine.resetAccount({
      startingBalance: 100_000,
      feeRate: 0,
      spreadBps: 200, // half spread = 100 bps = 1% -> ask at mid 100 is 101
      slippageBps: 0,
      keepHistory: false,
    });
    engine.mark("BTCUSD", 100);

    // Mid is 100, so takeProfit=100.5 looks > mid, yet it is <= ask (101) execution price!
    expect(() =>
      engine.placeOrder({
        accountId: engine.getAccount().id,
        symbol: "BTCUSD",
        side: "BUY",
        type: "MARKET",
        quantity: 1,
        takeProfit: 100.5,
      }),
    ).toThrow(/Take profit/i);
  });

  it("5. resolveClosedPositionLevels matches exit fill side & relative tolerance on sub-cent symbols", () => {
    engine.mark("PEPEUSD", 0.00001);
    engine.placeOrder({
      accountId: engine.getAccount().id,
      symbol: "PEPEUSD",
      side: "BUY",
      type: "MARKET",
      quantity: 1_000_000,
      stopLoss: 0.000009,
      takeProfit: 0.000012,
    });
    const pos = engine.getPositions()[0]!;
    engine.closePosition(pos.id);

    const closed = engine.getClosedPositions()[0]!;
    // Strip stored levels to force reconstruction from matching fills
    const stripped = { ...closed, stopLoss: undefined, takeProfit: undefined };
    const resolved = engine.resolveClosedPositionLevels(stripped);
    expect(resolved.stopLoss).toBeCloseTo(0.000009, 10);
    expect(resolved.takeProfit).toBeCloseTo(0.000012, 10);
  });

  // ── Phase 1: Candles, Replay & Demo API ─────────────────────────────────────

  it("6. updateLatestBarPrice clones bundled data without mutating static JSON and ignores invalid prices", () => {
    const rawLast = btc1dRaw[btc1dRaw.length - 1]!;
    const origClose = rawLast.close;
    const origHigh = rawLast.high;

    // Load history into cache first
    getHistory("BTCUSD", "1d");

    // Ignored invalid prices
    updateLatestBarPrice("BTCUSD", Number.NaN);
    updateLatestBarPrice("BTCUSD", -100);
    expect(rawLast.close).toBe(origClose);

    // Valid tick updates runtime cache without mutating imported JSON array
    updateLatestBarPrice("BTCUSD", origHigh + 5_000);
    expect(rawLast.close).toBe(origClose);
    expect(rawLast.high).toBe(origHigh);
  });

  it("7. buildPartialCandleUpTo returns a flat opening stub when sub-slice is empty", () => {
    const preHistoryBar = {
      time: 1_000_000_000,
      open: 10,
      high: 50,
      low: 1,
      close: 45,
      volume: 999,
    };
    const stub = buildPartialCandleUpTo("BTCUSD", preHistoryBar, "1d", 1_000_003_600);
    expect(stub).toEqual({
      time: 1_000_000_000,
      open: 10,
      high: 10,
      low: 10,
      close: 10,
      volume: 0,
    });
  });

  it("8. buildPartialCandleRange and replay.step() after mid-day TF switch evaluate only unrevealed [fromSec, toSec)", () => {
    const dayBars = getRawHistory("BTCUSD", "1d");
    const fourHourBars = getRawHistory("BTCUSD", "4h");

    // Find a day where morning 00:00..04:00 bar dipped strictly below all remaining bars of that day
    let matchedDay: (typeof dayBars)[number] | null = null;
    let morningLow = 0;
    let afternoonMinLow = 0;
    for (const d of dayBars) {
      if (d.time < fourHourBars[0]!.time) continue;
      const inDay = fourHourBars.filter((b) => b.time >= d.time && b.time < d.time + 86_400);
      if (inDay.length < 4) continue;
      const mLow = inDay[0]!.low;
      const restLow = Math.min(...inDay.slice(2).map((b) => b.low));
      if (mLow < restLow - 50) {
        matchedDay = d;
        morningLow = mLow;
        afternoonMinLow = restLow;
        break;
      }
    }
    expect(matchedDay).not.toBeNull();

    const fromSec = matchedDay!.time + 2 * TF_SECONDS["4h"]!;
    const toSec = matchedDay!.time + TF_SECONDS["1d"]!;
    const partialRange = buildPartialCandleRange("BTCUSD", matchedDay!, "1d", fromSec, toSec);
    expect(partialRange.low).toBeGreaterThan(morningLow);
    expect(partialRange.low).toBe(afternoonMinLow);

    // End-to-end replay test: step from 04:00 to 08:00, open SHORT with TP inside morningLow..afternoonMinLow,
    // switch TF to 1d, and step: TP must NOT trigger on already-elapsed morning wick.
    const startRes = useReplayStore.getState().start("BTCUSD", "4h", matchedDay!.time);
    expect(startRes.ok).toBe(true);
    useReplayStore.getState().step(); // now simTimeSec = matchedDay.time + 2 * 4h

    const entryPrice = useReplayStore.getState().visible!.at(-1)!.close;
    const tpInsideElapsedMorningWick = morningLow + (afternoonMinLow - morningLow) * 0.5;
    if (tpInsideElapsedMorningWick < entryPrice) {
      engine.placeOrder({
        accountId: engine.getAccount().id,
        symbol: "BTCUSD",
        side: "SELL",
        type: "MARKET",
        quantity: 0.1,
        takeProfit: tpInsideElapsedMorningWick,
      });
      useReplayStore.getState().changeTimeframe("1d");
      useReplayStore.getState().step();
      expect(engine.getPositions()).toHaveLength(1);
    }
  });

  it("9. demoApi.placeOrder deduplicates identical params separately by price and clears errors immediately", async () => {
    engine.mark("BTCUSD", 60_000);
    (
      window as unknown as { __opencharts_capture_screenshots?: () => Promise<Record<string, never>> }
    ).__opencharts_capture_screenshots = async () => ({});

    try {
      const p1 = demoApi.placeOrder({
        accountId: engine.getAccount().id,
        symbol: "BTCUSD",
        side: "BUY",
        type: "LIMIT",
        quantity: 0.1,
        price: 55_000,
      });
      const p2 = demoApi.placeOrder({
        accountId: engine.getAccount().id,
        symbol: "BTCUSD",
        side: "BUY",
        type: "LIMIT",
        quantity: 0.1,
        price: 56_000,
      });

      const [o1, o2] = await Promise.all([p1, p2]);
      expect(o1.id).not.toBe(o2.id);
      expect(o1.price).toBe(55_000);
      expect(o2.price).toBe(56_000);

      // Rejection clears cache immediately (invalid SL for LONG > price)
      await expect(
        demoApi.placeOrder({
          accountId: engine.getAccount().id,
          symbol: "BTCUSD",
          side: "BUY",
          type: "LIMIT",
          quantity: 0.1,
          price: 57_000,
          stopLoss: 58_000,
        }),
      ).rejects.toThrow();

      // Immediate retry with valid SL succeeds instead of replaying stale failure
      engine.mark("BTCUSD", 60_000);
      const recovered = await demoApi.placeOrder({
        accountId: engine.getAccount().id,
        symbol: "BTCUSD",
        side: "BUY",
        type: "LIMIT",
        quantity: 0.1,
        price: 57_000,
        stopLoss: 54_000,
      });
      expect(recovered.price).toBe(57_000);
    } finally {
      delete (
        window as unknown as { __opencharts_capture_screenshots?: unknown }
      ).__opencharts_capture_screenshots;
    }
  });

  // ── Phase 2 & 3: Utils, Store, Indicators, Chart Helpers ────────────────────

  it("10. formatDate/formatDateFull guard invalid dates and getPipDigits handles non-power-of-10 tickSize", () => {
    expect(formatDate("not-a-date")).toBe("—");
    expect(formatDate(new Date(Number.NaN))).toBe("—");
    expect(formatDateFull("invalid-iso")).toBe("—");
    expect(formatDateFull(new Date(Number.NaN))).toBe("—");

    expect(getPipDigits(undefined, { tickSize: 0.00025 })).toBe(5);
    expect(getPipDigits({ tickSize: 1e-8 }, undefined)).toBe(8);
  });

  it("11. indicators guard NaN/Infinity/non-positive periods and NaN volumes without crashing or hanging", () => {
    const sample: CandleData[] = [
      { time: 1000, open: 100, high: 102, low: 99, close: 101, volume: Number.NaN },
      { time: 2000, open: 101, high: 104, low: 100, close: 103, volume: -5 },
      { time: 3000, open: 103, high: 105, low: 102, close: 104, volume: 10 },
      { time: 4000, open: 104, high: 106, low: 103, close: 105, volume: 20 },
    ];

    expect(sma(sample, Number.NaN)).toEqual([]);
    expect(sma(sample, 0)).toEqual([]);
    expect(sma(sample, -3)).toEqual([]);
    expect(ema(sample, Number.POSITIVE_INFINITY)).toEqual([]);
    expect(rsi(sample, Number.NaN)).toEqual([]);
    expect(macd(sample, 0, 12, 9)).toEqual({
      macd: [],
      signal: [],
      histogram: [],
      thresholds: null,
    });
    expect(computeMacdThresholds(sample, 12, 26, 9)).toBeNull();
    expect(bollingerBands(sample, Number.NaN)).toEqual({ upper: [], middle: [], lower: [] });
    expect(atr(sample, 0)).toEqual([]);
    expect(stochastic(sample, Number.NaN, 3)).toEqual({ k: [], d: [] });
    expect(stochasticRsi(sample, 14, 0, 3, 3)).toEqual({ k: [], d: [] });

    // Valid period works even when earlier rows had NaN/negative volume
    const validSma = sma(sample, 2);
    expect(validSma.length).toBeGreaterThan(0);
    expect(validSma.every((p) => Number.isFinite(p.value))).toBe(true);
  });

  it("12. chart helpers convert BusinessDay month without off-by-one and handle empty collections", () => {
    const ms = convertTime({ year: 2026, month: 3, day: 15 } as Time);
    const d = new Date(ms);
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(2); // March is 0-indexed month 2
    expect(d.getDate()).toBe(15);

    const disp = displayTime({ year: 2026, month: 3, day: 15 } as Time);
    expect(disp).toBe(new Date(2026, 2, 15).toLocaleDateString());

    const finder = new ClosestTimeIndexFinder([]);
    expect(finder.findClosestIndex(12345, "left")).toBe(-1);

    const range = new UpperLowerInRange([]);
    expect(range.getMinMax(0, 10)).toEqual({ lower: Infinity, upper: -Infinity });
  });

  it("13. useTradingStore formats 1e-8 tickSize scientific-notation symbols with 8 decimals", async () => {
    const symName = "SCITEST1E8USD";
    useTradingStore.setState({
      symbols: [{ id: "sci-test", name: symName, tickSize: 1e-8 } as never],
    });
    useTradingStore.getState().updateTick(symName, 0.00001234, 0.00001235, Date.now());

    await waitFor(() => {
      const entry = useTradingStore.getState().ticks[symName];
      expect(entry).toBeDefined();
      expect(entry!.bidFmt).toBe("0.00001234");
      expect(entry!.askFmt).toBe("0.00001235");
    });
  });

  // ── Phase 3, 4 & 5: UI Components, DrawingToolsManager & Dialogs ───────────

  it("14. DrawingToolsManager ignores Backspace/Delete inside number inputs and selects", () => {
    const container = document.createElement("div");
    const numInput = document.createElement("input");
    numInput.type = "number";
    const select = document.createElement("select");
    document.body.append(container, numInput, select);

    const mockChart = {
      timeScale: () => ({
        timeToCoordinate: () => 50,
        coordinateToTime: () => 1000,
        logicalToCoordinate: () => 50,
        coordinateToLogical: () => 0,
        width: () => 400,
        height: () => 20,
      }),
      priceScale: () => ({ width: () => 50 }),
    } as unknown as IChartApi;

    const mockSeries = {
      priceToCoordinate: () => 100,
      coordinateToPrice: () => 100,
      attachPrimitive: vi.fn(),
      detachPrimitive: vi.fn(),
    } as unknown as ISeriesApi<SeriesType>;

    const onRemove = vi.fn();
    const mgr = new DrawingToolsManager({
      chart: mockChart,
      series: mockSeries,
      container,
      intervalSec: 3600,
      timeframe: "1h",
      callbacks: {
        onAdd: vi.fn(),
        onUpdate: vi.fn(),
        onRemove,
        onToolFinished: vi.fn(),
      },
    });

    const line: DrawingLine = {
      id: "d1",
      type: "horizontal",
      price: 100,
      color: "#fff",
      width: 1,
    };
    mgr.setDrawings([line]);
    mgr.setSelection(["d1"]);

    numInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", bubbles: true }));
    select.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true }));
    expect(onRemove).not.toHaveBeenCalled();

    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true }));
    expect(onRemove).toHaveBeenCalledWith("d1");

    mgr.destroy();
    container.remove();
    numInput.remove();
    select.remove();
  });

  it("15. OrderPanel preserves user-edited quantity when live tick crosses $1 threshold on same symbol", () => {
    const qc = makeTestQueryClient();
    const props = {
      symbol: "ALTCOINTESTUSD",
      accountId: engine.getAccount().id,
      accountBalance: 10_000,
      isFeedConnected: true,
    };

    const { getByTestId, rerender } = render(
      <QueryClientProvider client={qc}>
        <OrderPanel {...props} tick={{ bid: 0.5, ask: 0.501, timestamp: 1 }} />
      </QueryClientProvider>,
    );

    const qtyInput = getByTestId("order-quantity-input") as HTMLInputElement;
    expect(qtyInput.value).toBe("200");

    fireEvent.change(qtyInput, { target: { value: "777" } });
    expect(qtyInput.value).toBe("777");

    // Tick moves across the $1 tier boundary while symbol remains unchanged
    rerender(
      <QueryClientProvider client={qc}>
        <OrderPanel {...props} tick={{ bid: 1.5, ask: 1.501, timestamp: 2 }} />
      </QueryClientProvider>,
    );
    expect(qtyInput.value).toBe("777");

    // Switching symbol DOES reinitialize the quantity for the new instrument
    rerender(
      <QueryClientProvider client={qc}>
        <OrderPanel
          {...props}
          symbol="BTCUSD"
          tick={{ bid: 60_000, ask: 60_001, timestamp: 3 }}
        />
      </QueryClientProvider>,
    );
    expect(qtyInput.value).toBe("0.005");
  });

  it("16. OrderConfirmDialog, OrderModifyDialog, and PositionModifyDialog close on outer centering overlay click", () => {
    const onConfirmCancel = vi.fn();
    const confirmView = render(
      <OrderConfirmDialog
        isOpen={true}
        onConfirm={vi.fn()}
        onCancel={onConfirmCancel}
        order={{ symbol: "BTCUSD", side: "BUY", type: "MARKET", quantity: 0.1 }}
        tick={{ bid: 60_000, ask: 60_001 }}
      />,
    );
    const confirmCenterOverlay = confirmView.container.querySelector(".fixed.inset-0.flex")!;
    fireEvent.click(confirmCenterOverlay);
    expect(onConfirmCancel).toHaveBeenCalledTimes(1);
    confirmView.unmount();

    const onOrderClose = vi.fn();
    const orderModView = render(
      <OrderModifyDialog
        order={{
          id: "ord-1",
          symbolName: "BTCUSD",
          side: "BUY",
          type: "LIMIT",
          quantity: 0.1,
          price: 55_000,
        }}
        onClose={onOrderClose}
        onSaved={vi.fn()}
      />,
    );
    const orderCenterOverlay = orderModView.container.querySelector(".fixed.inset-0.flex")!;
    fireEvent.click(orderCenterOverlay);
    expect(onOrderClose).toHaveBeenCalledTimes(1);
    orderModView.unmount();

    const onPosClose = vi.fn();
    const posModView = render(
      <PositionModifyDialog
        position={{
          id: "pos-1",
          takeProfit: null,
          stopLoss: null,
          symbolName: "BTCUSD",
          side: "LONG",
          quantity: 0.1,
          entryPrice: 60_000,
          currentPrice: 60_500,
          unrealizedPnl: 50,
          openedAt: new Date().toISOString(),
        }}
        onClose={onPosClose}
        onSaved={vi.fn()}
      />,
    );
    const posCenterOverlay = posModView.container.querySelector(".fixed.inset-0.flex")!;
    fireEvent.click(posCenterOverlay);
    expect(onPosClose).toHaveBeenCalledTimes(1);
    posModView.unmount();
  });

  it("17. PositionModifyDialog preserves edited TP/SL when live position ticks arrive on same position", () => {
    const basePosition: Position = {
      id: "pos-live-1",
      accountId: "acc-test",
      margin: 60,
      symbolName: "BTCUSD",
      side: "LONG",
      quantity: 0.1,
      entryPrice: 60_000,
      currentPrice: 60_100,
      unrealizedPnl: 10,
      openedAt: new Date().toISOString(),
      takeProfit: 65_000,
      stopLoss: 58_000,
    };

    const { container, rerender } = render(
      <PositionModifyDialog position={basePosition} onClose={vi.fn()} onSaved={vi.fn()} />,
    );

    const inputs = container.querySelectorAll("input");
    const tpInput = inputs[0]!;
    fireEvent.change(tpInput, { target: { value: "68500" } });
    expect(tpInput.value).toBe("68500");

    // Live unrealizedPnl/currentPrice tick creates a fresh object reference with identical id/TP/SL
    rerender(
      <PositionModifyDialog
        position={{ ...basePosition, currentPrice: 60_450, unrealizedPnl: 45 }}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );
    expect(tpInput.value).toBe("68500");
  });

  it("18. Button with asChild and loading renders child cleanly without React.Children.only error", () => {
    const { getByRole } = render(
      <Button asChild loading>
        <a href="/trade">Go Trade</a>
      </Button>,
    );
    const link = getByRole("link", { name: "Go Trade" });
    expect(link).toBeInTheDocument();
    expect(link.getAttribute("href")).toBe("/trade");
  });

  it("19. MarketDataBridge evicts buffered PositionOpened if PositionClosed arrives within 50ms window", () => {
    vi.useFakeTimers();
    const qc = makeTestQueryClient();
    const accountId = "acc-bridge-test";
    qc.setQueryData<Position[]>(queryKeys.trading.positions(accountId), []);

    render(
      <QueryClientProvider client={qc}>
        <MarketDataBridge />
      </QueryClientProvider>,
    );

    const transientPos: Position = {
      id: "pos-transient",
      accountId,
      margin: 60,
      takeProfit: null,
      stopLoss: null,
      symbolName: "BTCUSD",
      side: "LONG",
      quantity: 0.1,
      entryPrice: 60_000,
      currentPrice: 60_000,
      unrealizedPnl: 0,
      openedAt: new Date().toISOString(),
    };

    act(() => {
      publish("positions", {
        eventType: "PositionOpened",
        accountId,
        positionId: transientPos.id,
        _entity: transientPos,
      });
      publish("positions", {
        eventType: "PositionClosed",
        accountId,
        positionId: transientPos.id,
      });
      vi.advanceTimersByTime(100);
    });

    const cached = qc.getQueryData<Position[]>(queryKeys.trading.positions(accountId)) ?? [];
    expect(cached.some((p) => p.id === transientPos.id)).toBe(false);
  });
});
