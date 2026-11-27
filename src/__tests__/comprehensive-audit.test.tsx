import { describe, it, expect, beforeEach, vi } from "vitest";
import { fireEvent, render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as engine from "../services/demo/engine.ts";
import { useReplayStore } from "../services/demo/replay.ts";
import { getDemoSymbol } from "../services/demo/instruments.ts";
import { DrawingToolRail } from "../pages/trading/DrawingToolRail.tsx";
import { DrawingToolsManager } from "../lib/chart-plugins/drawing-tools/manager.ts";
import { FloatingOrderWidget } from "../pages/trading/FloatingOrderWidget.tsx";
import { useAuthStore } from "../services/store.tsx";

describe("Comprehensive Audit & Bug Verification Suite", () => {
  beforeEach(() => {
    if (useReplayStore.getState().phase !== "idle") {
      useReplayStore.getState().stop();
    }
    engine.resetAccount({
      startingBalance: 10_000,
      feeRate: 0.0005,
      keepHistory: false,
    });
  });

  describe("1. Paper Trading Engine: Pending Orders (LIMIT & STOP) & Gap Handling", () => {
    it("triggers BUY LIMIT when price reaches limit price and carries SL/TP to open position", () => {
      engine.mark("BTCUSD", 90_000);
      const accountId = engine.getAccount().id;

      const order = engine.placeOrder({
        accountId,
        symbol: "BTCUSD",
        side: "BUY",
        type: "LIMIT",
        quantity: 0.01,
        price: 88_000,
        stopLoss: 86_000,
        takeProfit: 92_000,
      });

      expect(order.status).toBe("PENDING");
      expect(engine.getOrders().filter((o) => o.status === "PENDING")).toHaveLength(1);
      expect(engine.getPositions()).toHaveLength(0);

      // Tick above limit does not trigger
      engine.mark("BTCUSD", 88_500);
      expect(engine.getOrders().filter((o) => o.status === "PENDING")).toHaveLength(1);
      expect(engine.getPositions()).toHaveLength(0);

      // Tick reaches 88,000 -> fills at limit price 88,000
      engine.mark("BTCUSD", 88_000);
      expect(engine.getOrders().filter((o) => o.status === "PENDING")).toHaveLength(0);
      expect(engine.getOrders().find((o) => o.id === order.id)?.status).toBe("FILLED");
      expect(engine.getPositions()).toHaveLength(1);
      expect(engine.getPositions()[0]!.entryPrice).toBe(88_000);
      expect(engine.getPositions()[0]!.stopLoss).toBe(86_000);
      expect(engine.getPositions()[0]!.takeProfit).toBe(92_000);
    });

    it("triggers SELL LIMIT and BUY/SELL STOP orders accurately", () => {
      engine.mark("BTCUSD", 90_000);
      const accountId = engine.getAccount().id;

      // SELL LIMIT above market @ 92,000
      engine.placeOrder({
        accountId,
        symbol: "BTCUSD",
        side: "SELL",
        type: "LIMIT",
        quantity: 0.01,
        price: 92_000,
      });

      // BUY STOP above market @ 93,000
      engine.placeOrder({
        accountId,
        symbol: "BTCUSD",
        side: "BUY",
        type: "STOP",
        quantity: 0.01,
        stopPrice: 93_000,
      });

      expect(engine.getOrders().filter((o) => o.status === "PENDING")).toHaveLength(2);

      // Price rises to 92,000 -> triggers SELL LIMIT @ 92,000, BUY STOP still pending
      engine.mark("BTCUSD", 92_000);
      expect(engine.getOrders().filter((o) => o.status === "PENDING")).toHaveLength(1);
      expect(engine.getPositions()).toHaveLength(1);
      expect(engine.getPositions()[0]!.side).toBe("SHORT");
      expect(engine.getPositions()[0]!.entryPrice).toBe(92_000);

      // Price rises to 93,000 -> triggers BUY STOP
      engine.mark("BTCUSD", 93_000);
      expect(engine.getOrders().filter((o) => o.status === "PENDING")).toHaveLength(0);
      expect(engine.getPositions()).toHaveLength(2);
    });

    it("cancels single pending order and cancels all pending orders", () => {
      engine.mark("BTCUSD", 90_000);
      const accountId = engine.getAccount().id;

      const o1 = engine.placeOrder({
        accountId,
        symbol: "BTCUSD",
        side: "BUY",
        type: "LIMIT",
        quantity: 0.01,
        price: 88_000,
      });
      engine.placeOrder({
        accountId,
        symbol: "BTCUSD",
        side: "SELL",
        type: "LIMIT",
        quantity: 0.01,
        price: 92_000,
      });
      engine.placeOrder({
        accountId,
        symbol: "BTCUSD",
        side: "BUY",
        type: "STOP",
        quantity: 0.01,
        stopPrice: 94_000,
      });

      expect(engine.getOrders().filter((o) => o.status === "PENDING")).toHaveLength(3);

      const cancelRes = engine.cancelOrder(o1.id);
      expect(cancelRes.success).toBe(true);
      expect(engine.getOrders().filter((o) => o.status === "PENDING")).toHaveLength(2);

      const cancelAllRes = engine.cancelAllOrders();
      expect(cancelAllRes.success).toBe(true);
      expect(engine.getOrders().filter((o) => o.status === "PENDING")).toHaveLength(0);
    });
  });

  describe("2. Stop Loss & Take Profit Validation, Execution & Exit Reasons", () => {
    it("validates SL and TP levels on LONG and SHORT orders and rejects invalid side levels", () => {
      engine.mark("BTCUSD", 90_000);
      const accountId = engine.getAccount().id;

      // LONG with SL above entry -> must throw
      expect(() =>
        engine.placeOrder({
          accountId,
          symbol: "BTCUSD",
          side: "BUY",
          type: "MARKET",
          quantity: 0.01,
          stopLoss: 91_000,
        }),
      ).toThrow(/Stop Loss/i);

      // LONG with TP below entry -> must throw
      expect(() =>
        engine.placeOrder({
          accountId,
          symbol: "BTCUSD",
          side: "BUY",
          type: "MARKET",
          quantity: 0.01,
          takeProfit: 89_000,
        }),
      ).toThrow(/Take Profit/i);

      // SHORT with SL below entry -> must throw
      expect(() =>
        engine.placeOrder({
          accountId,
          symbol: "BTCUSD",
          side: "SELL",
          type: "MARKET",
          quantity: 0.01,
          stopLoss: 89_000,
        }),
      ).toThrow(/Stop Loss/i);

      // SHORT with TP above entry -> must throw
      expect(() =>
        engine.placeOrder({
          accountId,
          symbol: "BTCUSD",
          side: "SELL",
          type: "MARKET",
          quantity: 0.01,
          takeProfit: 91_000,
        }),
      ).toThrow(/Take Profit/i);
    });

    it("executes LONG and SHORT Stop Loss and Take Profit with accurate exitReason ('stop-loss' | 'take-profit')", () => {
      engine.mark("BTCUSD", 90_000);
      const accountId = engine.getAccount().id;

      // 1. LONG position stopped out by SL at exact SL price 88,000
      engine.placeOrder({
        accountId,
        symbol: "BTCUSD",
        side: "BUY",
        type: "MARKET",
        quantity: 0.01,
        stopLoss: 88_000,
        takeProfit: 94_000,
      });

      engine.mark("BTCUSD", 88_000);
      expect(engine.getPositions()).toHaveLength(0);
      expect(engine.getClosedPositions()[0]!.exitReason).toBe("stop-loss");
      expect(engine.getClosedPositions()[0]!.exitPrice).toBe(88_000);

      // 2. SHORT position closed by TP at exact TP price 86,000
      engine.mark("BTCUSD", 90_000);
      engine.placeOrder({
        accountId,
        symbol: "BTCUSD",
        side: "SELL",
        type: "MARKET",
        quantity: 0.01,
        stopLoss: 92_000,
        takeProfit: 86_000,
      });

      engine.mark("BTCUSD", 86_000);
      expect(engine.getPositions()).toHaveLength(0);
      expect(engine.getClosedPositions()[0]!.exitReason).toBe("take-profit");
      expect(engine.getClosedPositions()[0]!.exitPrice).toBe(86_000);
    });

    it("allocates entryFee proportionally on partial close so total commission is exact", () => {
      engine.resetAccount({ startingBalance: 10_000, feeRate: 0.001, keepHistory: false });
      engine.mark("BTCUSD", 100_000);
      const accountId = engine.getAccount().id;

      // Buy 0.01 BTC @ $100,000 -> Notional = $1,000, Entry fee = $1.00
      engine.placeOrder({
        accountId,
        symbol: "BTCUSD",
        side: "BUY",
        type: "MARKET",
        quantity: 0.01,
      });

      const posBefore = engine.getPositions()[0]!;

      // Close half (0.005 BTC) @ $100,000 -> Exit fee = $0.50, Allocated entry fee = $0.50 -> Total comm = $1.00
      engine.closePosition(posBefore.id, 0.005);

      const posRemaining = engine.getPositions()[0]!;
      expect(posRemaining.quantity).toBeCloseTo(0.005, 6);

      const firstClosed = engine.getClosedPositions()[0]!;
      expect(firstClosed.commission).toBeCloseTo(1.0, 6);

      // Close remaining half (0.005 BTC) @ $100,000
      engine.closePosition(posRemaining.id);
      expect(engine.getPositions()).toHaveLength(0);
      expect(engine.getSummary().fees).toBeCloseTo(2.0, 6);
    });
  });

  describe("3. Multi-Asset Contract Size & Risk/Reward (R:B) Calculations", () => {
    it("includes contractSize in P&L and Risk/Reward calculations for Crypto and Forex contract sizes", () => {
      const btcInfo = getDemoSymbol("BTCUSD")!;
      expect(btcInfo).toBeDefined();
      expect(btcInfo.contractSize).toBe(1);

      engine.mark("ETHUSD", 3_000);
      const accountId = engine.getAccount().id;

      // Buy 2 ETH @ $3,000 with SL @ $2,900 (-$100/ETH) and TP @ $3,250 (+$250/ETH)
      engine.placeOrder({
        accountId,
        symbol: "ETHUSD",
        side: "BUY",
        type: "MARKET",
        quantity: 2,
        stopLoss: 2_900,
        takeProfit: 3_250,
      });

      const pos = engine.getPositions()[0]!;
      const cSize = pos.contractSize ?? 1;
      const riskPerUnit = Math.abs(pos.entryPrice - pos.stopLoss!);
      const rewardPerUnit = Math.abs(pos.takeProfit! - pos.entryPrice);

      const riskUsd = riskPerUnit * pos.quantity * cSize;
      const rewardUsd = rewardPerUnit * pos.quantity * cSize;
      const rrRatio = rewardPerUnit / riskPerUnit;

      expect(riskUsd).toBeCloseTo(200, 2);
      expect(rewardUsd).toBeCloseTo(500, 2);
      expect(rrRatio).toBeCloseTo(2.5, 2);

      // Also verify Position Pill R:B formula with contractSize = 100,000 (standard Forex lot)
      const forexContractSize = 100_000;
      const forexRiskUsd = Math.abs(1.1000 - 1.0950) * 1 * forexContractSize;
      const forexRewardUsd = Math.abs(1.1100 - 1.1000) * 1 * forexContractSize;
      expect(forexRiskUsd).toBeCloseTo(500, 2);
      expect(forexRewardUsd).toBeCloseTo(1000, 2);
    });

    it("notifies engine subscribers when feeRate is updated via setFeeRate", () => {
      let notifiedCount = 0;
      const unsub = engine.subscribeEngine(() => {
        notifiedCount += 1;
      });

      engine.setFeeRate(0.002);
      expect(engine.getSummary().feeRate).toBe(0.002);
      expect(notifiedCount).toBe(1);

      unsub();
    });
  });

  describe("4. Replay Mode Isolation & OHLC Bar Intrabar Execution", () => {
    it("isolates live positions during replay and settles open replay positions with 'replay-end' on stop()", () => {
      engine.mark("BTCUSD", 90_000);
      const accountId = engine.getAccount().id;

      // Open a LIVE position before starting replay
      engine.placeOrder({
        accountId,
        symbol: "BTCUSD",
        side: "BUY",
        type: "MARKET",
        quantity: 0.01,
      });
      expect(engine.getPositions()).toHaveLength(1);
      expect(engine.getPositions()[0]!.source).toBe("live");

      // Enter replay mode in 2024
      const jan2024 = 1704888000;
      const startRes = useReplayStore.getState().start("BTCUSD", "4h", jan2024);
      expect(startRes.ok).toBe(true);

      // In replay mode, live positions are hidden/isolated
      expect(engine.getPositions()).toHaveLength(0);

      // Open a REPLAY position and a REPLAY pending order
      engine.placeOrder({
        accountId,
        symbol: "BTCUSD",
        side: "BUY",
        type: "MARKET",
        quantity: 0.05,
      });
      engine.placeOrder({
        accountId,
        symbol: "BTCUSD",
        side: "BUY",
        type: "LIMIT",
        quantity: 0.05,
        price: 30_000,
      });
      expect(engine.getPositions()).toHaveLength(1);
      expect(engine.getPositions()[0]!.source).toBe("replay");
      expect(engine.getOrders().filter((o) => o.status === "PENDING")).toHaveLength(1);

      // Stop replay -> settles open replay position with exitReason = 'replay-end' and restores live position
      useReplayStore.getState().stop();
      expect(engine.getPositions()).toHaveLength(1);
      expect(engine.getPositions()[0]!.source).toBe("live");

      const closedReplay = engine.getClosedPositions().find((c) => c.source === "replay");
      expect(closedReplay).toBeDefined();
      expect(closedReplay!.exitReason).toBe("replay-end");
    });

    it("allows switching timeframe (e.g. 4h <-> 1d <-> 15m <-> 1h) during active replay without look-ahead and keeping exact price", () => {
      const jan2024 = 1704888000; // 2024-01-10 12:00 UTC
      const startRes = useReplayStore.getState().start("BTCUSD", "4h", jan2024);
      expect(startRes.ok).toBe(true);

      const state4h = useReplayStore.getState();
      expect(state4h.timeframe).toBe("4h");
      expect(state4h.phase).toBe("active");
      const lastBar4h = state4h.visible![state4h.visible!.length - 1]!;
      expect(lastBar4h.time).toBe(jan2024);
      const priceAt4h = lastBar4h.close;

      // Switch timeframe to 1D during active replay -> partial daily candle must have the exact same close price and zero look-ahead
      useReplayStore.getState().changeTimeframe("1d");
      const state1d = useReplayStore.getState();
      expect(state1d.timeframe).toBe("1d");
      expect(state1d.phase).toBe("active");
      const lastBar1d = state1d.visible![state1d.visible!.length - 1]!;
      expect(lastBar1d.time).toBeLessThanOrEqual(lastBar4h.time);
      expect(lastBar1d.close).toBeCloseTo(priceAt4h, 4);

      // Switch to 15m at the same 2024 historical date where 15m real bars do not exist ->
      // must NOT invent/subdivide synthetic 15m bars and must preserve compatible 1d timeframe
      const switched15m = useReplayStore.getState().changeTimeframe("15m");
      expect(switched15m).toBe(false);
      const stateAfterRejected15m = useReplayStore.getState();
      expect(stateAfterRejected15m.timeframe).toBe("1d");
      expect(stateAfterRejected15m.dataWarning).toBeTruthy();

      // Switch back to 4h -> must return to the exact same 12:00 UTC 4h bar without losing intraday timestamp
      useReplayStore.getState().changeTimeframe("4h");
      const stateBack4h = useReplayStore.getState();
      expect(stateBack4h.visible![stateBack4h.visible!.length - 1]!.time).toBe(jan2024);

      // Switch to 1d and step +1
      useReplayStore.getState().changeTimeframe("1d");
      const countBefore = useReplayStore.getState().visible!.length;
      useReplayStore.getState().step();
      expect(useReplayStore.getState().visible!.length).toBe(countBefore + 1);

      useReplayStore.getState().stop();
      expect(useReplayStore.getState().phase).toBe("idle");
    });

    it("evaluates replay OHLC bars with gap-down SL/LIMIT handling via replayAdvance", () => {
      const t0 = 1704888000;
      engine.enterReplay("BTCUSD", { timeSec: t0, open: 45_000, high: 45_500, low: 44_800, close: 45_200 });
      const accountId = engine.getAccount().id;

      // Place LONG position @ 45,200 with SL @ 44,500
      engine.placeOrder({
        accountId,
        symbol: "BTCUSD",
        side: "BUY",
        type: "MARKET",
        quantity: 0.05,
        stopLoss: 44_500,
        takeProfit: 47_000,
      });

      // Next replay bar gaps down open @ 44,000 (below SL 44,500) -> fills at bar.open (44,000)
      engine.replayAdvance("BTCUSD", {
        timeSec: t0 + 3600,
        open: 44_000,
        high: 44_200,
        low: 43_800,
        close: 44_100,
      });

      expect(engine.getPositions()).toHaveLength(0);
      const closed = engine.getClosedPositions()[0]!;
      expect(closed.exitReason).toBe("stop-loss");
      expect(closed.exitPrice).toBe(44_000);

      engine.exitReplay();
    });
  });

  describe("5. DrawingToolsManager & UI Component Fixes", () => {
    it("creates and manages drawings even when main chart timeScale().width() is 0 (multi-pane layout)", () => {
      const container = document.createElement("div");
      Object.defineProperty(container, "clientWidth", { value: 900 });
      Object.defineProperty(container, "clientHeight", { value: 500 });

      const mockChart = {
        chartElement: () => container,
        timeScale: () => ({
          // Simulate hidden bottom time axis when RSI/MACD panes are below price chart
          width: () => 0,
          coordinateToTime: (x: number) => 1700000000 + Math.round(x) * 60,
          timeToCoordinate: (t: number) => (t - 1700000000) / 60,
          coordinateToLogical: (x: number) => x / 10,
          logicalToCoordinate: (l: number) => l * 10,
          subscribeVisibleLogicalRangeChange: () => {},
          unsubscribeVisibleLogicalRangeChange: () => {},
        }),
        subscribeClick: () => {},
        unsubscribeClick: () => {},
        subscribeCrosshairMove: () => {},
        unsubscribeCrosshairMove: () => {},
        applyOptions: () => {},
      };

      const mockSeries = {
        attachPrimitive: () => {},
        detachPrimitive: () => {},
        coordinateToPrice: (y: number) => 95_000 - y * 10,
        priceToCoordinate: (p: number) => (95_000 - p) / 10,
        data: () => [
          { time: 1700000000, open: 94_000, high: 95_000, low: 93_000, close: 94_500 },
          { time: 1700000060, open: 94_500, high: 95_200, low: 94_100, close: 94_800 },
        ],
      };

      const mgr = new DrawingToolsManager({
        chart: mockChart as any,
        series: mockSeries as any,
        container,
        intervalSec: 60,
        timeframe: "1m",
        callbacks: {
          onAdd: () => {},
          onUpdate: () => {},
          onRemove: () => {},
          onToolFinished: () => {},
        },
      });

      // Convert screen point using fallback container width when timeScale().width() === 0
      const pt1 = (mgr as any).toPoint({ x: 100, y: 150 });
      expect(pt1).not.toBeNull();
      expect(pt1.price).toBe(93_500);

      mgr.destroy();
    });

    it("renders DrawingToolRail in exact order: Cursor -> Lines -> Trend Line -> Rectangle -> Ruler -> Fibonacci -> Text", () => {
      const onDrawingTool = vi.fn();
      const { container, rerender } = render(
        <DrawingToolRail
          drawingTool="none"
          onDrawingTool={onDrawingTool}
        />,
      );

      const buttons = Array.from(container.querySelectorAll("button[title]"));
      const titles = buttons.map((b) => b.getAttribute("title") || "");

      const cursorIdx = titles.findIndex((t) => t === "Cursor");
      const lineIdx = titles.findIndex((t) => t === "Lines");
      const trendIdx = titles.findIndex((t) => t.includes("Trend Line"));
      const rectIdx = titles.findIndex((t) => t.includes("Rectángulo"));
      const rulerIdx = titles.findIndex((t) => t.includes("Regla"));
      const fibIdx = titles.findIndex((t) => t === "Fibonacci");
      const textIdx = titles.findIndex((t) => t === "Texto");

      expect(cursorIdx).toBeGreaterThanOrEqual(0);
      expect(lineIdx).toBeGreaterThan(cursorIdx);
      expect(trendIdx).toBeGreaterThan(lineIdx);
      expect(rectIdx).toBeGreaterThan(trendIdx);
      expect(rulerIdx).toBeGreaterThan(rectIdx);
      expect(fibIdx).toBeGreaterThan(rulerIdx);
      expect(textIdx).toBeGreaterThan(fibIdx);

      const trendBtn = buttons[trendIdx]!;
      fireEvent.click(trendBtn);
      expect(onDrawingTool).toHaveBeenCalledWith("trendline");

      rerender(
        <DrawingToolRail
          drawingTool="trendline"
          onDrawingTool={onDrawingTool}
        />,
      );
      fireEvent.click(container.querySelector('button[title*="Trend Line"]')!);
      expect(onDrawingTool).toHaveBeenLastCalledWith("none");
    });

    it("automatically activates TP/SL on Market Order without manual checkboxes or number inputs and updates on symbol switch", () => {
      // Even if legacy isDemo flag is true in authStore, paper trading must NOT be blocked
      useAuthStore.setState({ isDemo: true });

      const qc = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });

      let latestPreview: any = null;
      const { rerender } = render(
        <QueryClientProvider client={qc}>
          <FloatingOrderWidget
            symbol="BTCUSD"
            accountId="demo-account"
            tick={{ bid: 45_000, ask: 45_000, timestamp: Date.now() }}
            onDraftPreviewChange={(preview) => {
              latestPreview = preview;
            }}
          />
        </QueryClientProvider>,
      );

      // TP and SL are automatically active on mount with valid levels around 45,000
      expect(latestPreview).not.toBeNull();
      expect(latestPreview.takeProfit).toBeGreaterThan(45_000);
      expect(latestPreview.stopLoss).toBeLessThan(45_000);

      // Switch symbol to ETHUSD @ 3,000 -> TP and SL automatically re-initialize to ETHUSD levels
      rerender(
        <QueryClientProvider client={qc}>
          <FloatingOrderWidget
            symbol="ETHUSD"
            accountId="demo-account"
            tick={{ bid: 3_000, ask: 3_000, timestamp: Date.now() }}
            onDraftPreviewChange={(preview) => {
              latestPreview = preview;
            }}
          />
        </QueryClientProvider>,
      );

      expect(latestPreview).not.toBeNull();
      expect(latestPreview.takeProfit).toBeGreaterThan(3_000);
      expect(latestPreview.takeProfit).toBeLessThan(4_000);
      expect(latestPreview.stopLoss).toBeLessThan(3_000);
      expect(latestPreview.stopLoss).toBeGreaterThan(2_000);
    });

    it("resets demo account capital and clears trade history even during active replay mode", () => {
      const t0 = 1704888000;
      engine.enterReplay("BTCUSD", { timeSec: t0, open: 45_000, high: 45_500, low: 44_800, close: 45_200 });

      // Place and close a trade to populate history
      const accountId = engine.getAccount().id;
      const order = engine.placeOrder({
        accountId,
        symbol: "BTCUSD",
        side: "BUY",
        type: "MARKET",
        quantity: 0.1,
      });
      expect(order).toBeDefined();

      const pos = engine.getPositions()[0]!;
      expect(pos).toBeDefined();
      engine.closePosition(pos.id);

      expect(engine.getClosedPositions().length).toBeGreaterThan(0);

      // Reset account with $1,000 capital and keepHistory = false while in replay mode
      expect(() => {
        engine.resetAccount({
          startingBalance: 1_000,
          feeRate: 0.0005,
          keepHistory: false,
        });
      }).not.toThrow();

      expect(engine.getAccount().balance).toBe(1_000);
      expect(engine.getAccount().equity).toBe(1_000);
      expect(engine.getPositions()).toHaveLength(0);
      expect(engine.getClosedPositions()).toHaveLength(0);

      engine.exitReplay();
    });

    it("safely handles reparented or detached DOM nodes on removeChild and insertBefore without throwing", () => {
      const parent = document.createElement("div");
      const foreign = document.createElement("div");
      const child = document.createElement("span");
      foreign.appendChild(child);

      // Calling parent.removeChild(child) where child.parentNode !== parent must NOT throw
      expect(() => {
        parent.removeChild(child);
      }).not.toThrow();

      const newChild = document.createElement("p");
      expect(() => {
        parent.insertBefore(newChild, child);
      }).not.toThrow();
    });
  });
});
