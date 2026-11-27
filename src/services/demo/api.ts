import type { DrawingLine } from "../../pages/trading/constants.ts";
import type { Candle, Order } from "../schemas.ts";
import { fetchHistoryAsync, getLatestRealStockTimestampMs } from "./candles.ts";
import { DEMO_ECONOMIC_EVENTS } from "./economicEvents.ts";
import * as engine from "./engine.ts";
import { DEMO_SYMBOLS, getDemoSymbol } from "./instruments.ts";
import {
  captureDailyChart,
  captureFourHourChart,
  captureTradeScreenshots,
  getActiveReplayTimeSec,
} from "../../lib/chart-plugins/trade-screenshot.ts";

/**
 * Demo-mode API. Replaces the HTTP client for everything the terminal needs:
 * trading actions hit the in-browser paper engine, market data comes from the
 * bundled real OHLC, and chart drawings persist to localStorage. Methods not
 * implemented here fall through to a benign stub (see services/api.ts).
 */

const DEMO_USER = {
  id: "demo-user",
  email: "demo@opencharts.dev",
  firstName: "Demo",
  lastName: "Trader",
  roles: ["trader"],
  status: "ACTIVE",
  createdAt: new Date().toISOString(),
};

function authResponse() {
  return { accessToken: "demo-token", refreshToken: "demo-refresh", user: DEMO_USER };
}

// ── Chart drawings (localStorage) ─────────────────────────
const DRAW_KEY = (symbol: string) => `oc_drawings_${symbol}`;

function readDrawings(symbol: string): DrawingLine[] {
  try {
    return JSON.parse(localStorage.getItem(DRAW_KEY(symbol)) ?? "[]");
  } catch {
    return [];
  }
}
function writeDrawings(symbol: string, list: DrawingLine[]): void {
  try {
    localStorage.setItem(DRAW_KEY(symbol), JSON.stringify(list));
  } catch {
    // ignore storage quota errors
  }
}

const chartDrawings = {
  list: (symbol: string) => Promise.resolve(readDrawings(symbol)),
  save: (symbol: string, _tf: string, drawing: DrawingLine) => {
    const list = readDrawings(symbol).filter((d) => d.id !== drawing.id);
    list.push(drawing);
    writeDrawings(symbol, list);
    return Promise.resolve({ saved: true });
  },
  remove: (drawingId: string) => {
    try {
      if (
        typeof localStorage !== "undefined" &&
        typeof localStorage.length === "number" &&
        typeof localStorage.key === "function"
      ) {
        const keys: string[] = [];
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (k && k.startsWith("oc_drawings_")) keys.push(k);
        }
        for (const k of keys) {
          const list = JSON.parse(localStorage.getItem(k) ?? "[]") as DrawingLine[];
          const filtered = list.filter((d) => d.id !== drawingId);
          if (filtered.length !== list.length) {
            localStorage.setItem(k, JSON.stringify(filtered));
          }
        }
      } else {
        for (const s of DEMO_SYMBOLS) {
          writeDrawings(s.name, readDrawings(s.name).filter((d) => d.id !== drawingId));
        }
      }
    } catch {
      // ignore storage errors
    }
    return Promise.resolve({ deleted: true });
  },
  clear: (symbol: string) => {
    writeDrawings(symbol, []);
    return Promise.resolve({ cleared: true });
  },
};

const candlesMeta = (candles: Candle[]) => ({
  candles,
  metadata: { isPartial: false, backfillQueued: false, historicalCoverageStart: null },
});

const PAGE_SIZE = 50;

/** Run `fn` inside a promise so synchronous engine errors become rejections. */
function later<T>(fn: () => T): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    try {
      resolve(fn());
    } catch (err) {
      reject(err);
    }
  });
}

export const demoApi = {
  // ── Auth (no real auth in demo) ──
  login: (..._args: unknown[]) => Promise.resolve(authResponse()),
  demoLogin: () => Promise.resolve(authResponse()),
  register: (..._args: unknown[]) => Promise.resolve(authResponse()),
  completeMfaLogin: (..._args: unknown[]) => Promise.resolve(authResponse()),
  logout: (..._args: unknown[]) => Promise.resolve({ success: true }),
  refreshToken: (..._args: unknown[]) =>
    Promise.resolve({ accessToken: "demo-token", refreshToken: "demo-refresh" }),
  getMyProfile: () => Promise.resolve(DEMO_USER),
  getMe: () => Promise.resolve(DEMO_USER),

  // ── Accounts ──
  getMyAccounts: () => Promise.resolve(engine.getAccounts()),
  getAccount: (..._args: unknown[]) => Promise.resolve(engine.getAccount()),
  getEquityHistory: () => Promise.resolve([]),
  getLedger: () => Promise.resolve({ data: [], total: 0, page: 1, pageSize: 50, totalPages: 0 }),
  getAccountStats: (..._args: unknown[]) => {
    const s = engine.getSummary();
    const session = engine.getClosedPositions().filter((c) => c.sessionId === s.sessionId);
    const nets = session.map((c) => c.realizedPnl - c.commission);
    const winsList = nets.filter((n) => n > 0);
    const lossList = nets.filter((n) => n < 0);
    return Promise.resolve({
      totalTrades: s.trades,
      winRate: s.winRate * 100,
      avgWin: winsList.length ? s.grossProfit / winsList.length : 0,
      avgLoss: lossList.length ? -s.grossLoss / lossList.length : 0,
      profitFactor: s.grossLoss > 0 ? s.grossProfit / s.grossLoss : s.grossProfit > 0 ? Infinity : 0,
      bestTrade: nets.length ? Math.max(...nets) : 0,
      worstTrade: nets.length ? Math.min(...nets) : 0,
    });
  },
  setAccountLabel: () => Promise.resolve({ success: true }),
  getAccountMetrics: () => {
    const a = engine.getAccount();
    return Promise.resolve({
      accountId: a.id,
      equity: a.equity,
      balance: a.balance,
      freeMargin: a.freeMargin,
      marginUsed: a.margin,
      floatingPnl: a.equity - a.balance,
      dailyPnl: 0,
      ddDaily: null,
      ddDailyMax: null,
      ddTotal: null,
      ddTotalMax: null,
      ddTrailing: null,
      ddTrailingMax: null,
      trailingDrawdownFloor: null,
      trailingDrawdownPeak: null,
      trailingDrawdownMode: null,
      trailingDrawdownTrailMode: null,
      trailingDrawdownFloorLocked: false,
      trailingDrawdownTrailToBreakeven: false,
      profitTargetPercent: null,
      profitTargetProgress: 0,
      minTradingDays: null,
      tradingDaysCompleted: 0,
      minDaysProgress: 0,
      status: a.status,
      phase: a.phase,
      highWaterMark: a.balance,
      startingBalance: a.template?.startingBalance ?? a.balance,
      currency: "USD",
      lastMarkTs: new Date().toISOString(),
    });
  },

  // ── Symbols & market data ──
  getSymbols: () => Promise.resolve([...DEMO_SYMBOLS]),
  getCandles: (
    symbol: string,
    timeframe: string,
    limit?: number,
    range?: { from?: number; to?: number; fromMs?: number; toMs?: number; targetDate?: string },
  ) => fetchHistoryAsync(symbol, timeframe, limit, range),
  getCandlesWithMeta: (
    symbol: string,
    timeframe: string,
    limit?: number,
    range?: { from?: number; to?: number; fromMs?: number; toMs?: number; targetDate?: string },
  ) => fetchHistoryAsync(symbol, timeframe, limit, range).then(candlesMeta),
  getTick: (symbol: string) => {
    const price = engine.getLastPrice(symbol);
    const sym = getDemoSymbol(symbol);
    if ((sym?.category ?? "").toUpperCase() === "STOCKS") {
      const realTs = getLatestRealStockTimestampMs(symbol);
      if (!realTs) {
        return Promise.resolve(
          null as unknown as { symbol: string; bid: number; ask: number; timestamp: number },
        );
      }
      const spread = Math.max(sym?.tickSize ?? 0.01, price * 0.0001);
      const half = spread / 2;
      return Promise.resolve({
        symbol,
        bid: Math.max(0, price - half),
        ask: price + half,
        timestamp: realTs,
      });
    }
    return Promise.resolve({ symbol, bid: price, ask: price, timestamp: Date.now() });
  },
  getMarketDataHealth: () => Promise.resolve({ status: "ok" }),
  getEconomicCalendar: () => Promise.resolve(DEMO_ECONOMIC_EVENTS),

  // ── Trading (paper engine) ──
  // Engine errors (bad SL/TP side, insufficient margin…) surface as rejected
  // promises so react-query / the order panel can toast them.
  placeOrder: (() => {
    const inFlightOrders = new Map<string, Promise<Order>>();

    return async (data: engine.PlaceOrderArgs) => {
      const orderKey = JSON.stringify([
        data.accountId,
        data.symbol,
        data.side,
        data.type ?? "MARKET",
        data.quantity,
        data.price ?? null,
        data.stopPrice ?? null,
        data.stopLoss ?? null,
        data.takeProfit ?? null,
        data.notes ?? null,
      ]);
      const existing = inFlightOrders.get(orderKey);
      if (existing) return existing;

    const executeOrder = async () => {
      let oneHourScreenshot = data.oneHourScreenshot;
      let fourHourScreenshot = data.fourHourScreenshot;
      let entryScreenshot = data.entryScreenshot;
      let dailyScreenshot = data.dailyScreenshot;
      let entryTimeframe = data.entryTimeframe;

      if (fourHourScreenshot && dailyScreenshot && fourHourScreenshot === dailyScreenshot) {
        if (entryTimeframe === "1d") {
          fourHourScreenshot = undefined;
        } else {
          dailyScreenshot = undefined;
        }
      }

      if (!oneHourScreenshot || !fourHourScreenshot || !dailyScreenshot) {
        try {
          const captureFn =
            typeof window !== "undefined"
              ? (window as unknown as { __opencharts_capture_screenshots?: (sym: string) => Promise<{
                  oneHourScreenshot?: string;
                  fourHourScreenshot?: string;
                  dailyScreenshot?: string;
                  entryScreenshot?: string;
                  entryTimeframe?: string;
                }> }).__opencharts_capture_screenshots
              : undefined;

          const captured = captureFn
            ? await captureFn(data.symbol)
            : await captureTradeScreenshots(data.symbol);

          if (!oneHourScreenshot && captured.oneHourScreenshot) {
            oneHourScreenshot = captured.oneHourScreenshot;
          }
          if (!fourHourScreenshot && captured.fourHourScreenshot) {
            fourHourScreenshot = captured.fourHourScreenshot;
          }
          if (!dailyScreenshot && captured.dailyScreenshot) {
            dailyScreenshot = captured.dailyScreenshot;
          }
          if (!entryScreenshot && captured.entryScreenshot) {
            entryScreenshot = captured.entryScreenshot;
          }
          if (!entryTimeframe && captured.entryTimeframe) {
            entryTimeframe = captured.entryTimeframe;
          }

          // Absolute sanity check: 4H and Daily MUST NEVER be identical images
          if (fourHourScreenshot && dailyScreenshot && fourHourScreenshot === dailyScreenshot) {
            const activeReplayTime = getActiveReplayTimeSec();
            if (entryTimeframe === "1d") {
              fourHourScreenshot = await captureFourHourChart(data.symbol, undefined, activeReplayTime);
            } else {
              dailyScreenshot = await captureDailyChart(data.symbol, undefined, activeReplayTime);
            }
          }
        } catch (err) {
          console.warn("[trade-screenshot] auto capture failed:", err);
        }
      }

      return later(() =>
        engine.placeOrder({
          ...data,
          oneHourScreenshot,
          fourHourScreenshot,
          entryScreenshot,
          dailyScreenshot,
          entryTimeframe,
        }),
      );
    };

    const pending = executeOrder().then(
      (res) => {
        setTimeout(() => {
          if (inFlightOrders.get(orderKey) === pending) {
            inFlightOrders.delete(orderKey);
          }
        }, 300);
        return res;
      },
      (err) => {
        if (inFlightOrders.get(orderKey) === pending) {
          inFlightOrders.delete(orderKey);
        }
        throw err;
      },
    );

    inFlightOrders.set(orderKey, pending);
    return pending;
  };
})(),
  cancelOrder: (orderId: string) => later(() => engine.cancelOrder(orderId)),
  modifyOrder: (orderId: string, mods: engine.ModifyOrderArgs = {}) =>
    later(() => engine.modifyOrder(orderId, mods)),
  cancelAllOrders: () => later(() => engine.cancelAllOrders()),
  getOrders: (..._args: unknown[]) => Promise.resolve(engine.getOrders()),
  getPositions: (..._args: unknown[]) => Promise.resolve(engine.getPositions()),
  getOpenPositionCount: () => Promise.resolve(engine.getPositions().length),
  closePosition: (positionId: string, quantity?: number) =>
    later(() => engine.closePosition(positionId, quantity)),
  closeAllPositions: (..._args: unknown[]) => later(() => engine.closeAllPositions()),
  modifyPosition: (positionId: string, mods: { takeProfit?: number | null; stopLoss?: number | null }) =>
    later(() => engine.modifyPosition(positionId, mods)),
  getFills: (..._args: unknown[]) => {
    const fills = engine.getFills();
    return Promise.resolve({ data: fills, total: fills.length, page: 1, pageSize: fills.length || 50, totalPages: 1 });
  },
  getClosedPositions: (_accountId?: string, page = 1) => {
    const all = engine.getClosedPositions();
    const totalPages = Math.max(1, Math.ceil(all.length / PAGE_SIZE));
    const p = Math.min(Math.max(1, page), totalPages);
    return Promise.resolve({
      data: all.slice((p - 1) * PAGE_SIZE, p * PAGE_SIZE),
      total: all.length,
      page: p,
      pageSize: PAGE_SIZE,
      totalPages,
    });
  },
  getClosedPositionsSummary: (_accountId?: string, from?: string, to?: string) => {
    const parsedLo = from ? Date.parse(from) : NaN;
    const parsedHi = to ? Date.parse(to) : NaN;
    const lo = from && Number.isFinite(parsedLo) ? parsedLo : -Infinity;
    const hi = to && Number.isFinite(parsedHi) ? parsedHi : Infinity;
    const inRange = engine.getClosedPositions().filter((c) => {
      const t = Date.parse(c.closedAt ?? c.openedAt);
      return Number.isFinite(t) && t >= lo && t <= hi;
    });
    return Promise.resolve({
      pnl: inRange.reduce((s, c) => s + c.realizedPnl, 0),
      commission: inRange.reduce((s, c) => s + c.commission, 0),
      swap: 0,
      tradeCount: inRange.length,
    });
  },
  getFillQuality: () => Promise.resolve([]),

  // ── Demo account: capital, fees, reset, live summary ──
  getDemoSummary: () => Promise.resolve(engine.getSummary()),
  resetDemoAccount: (opts: engine.ResetOptions) => later(() => engine.resetAccount(opts)),
  clearDemoTradeHistory: () => later(() => engine.clearHistory()),
  setDemoStartingBalance: (startingBalance: number) =>
    later(() => engine.setStartingBalance(startingBalance)),
  setDemoFeeRate: (feeRate: number) => later(() => engine.setFeeRate(feeRate)),


  // ── Trade notes & screenshots ──
  updateTradeNotes: (tradeId: string, notes: string) =>
    later(() => engine.updateTradeNotes(tradeId, notes)),
  updateTradeScreenshot: (tradeId: string, type: "1h" | "4h" | "daily" | "entry", dataUrl: string) =>
    later(() => engine.updateTradeScreenshot(tradeId, type, dataUrl)),

  // ── Trade journal (localStorage-free demo: empty) ──
  getJournalEntries: () => Promise.resolve([]),
  createJournalEntry: () => Promise.resolve(null),
  updateJournalEntry: () => Promise.resolve(null),
  deleteJournalEntry: () => Promise.resolve({ success: true }),

  // ── Chart persistence ──
  chartDrawings,
  getPreferences: () => Promise.resolve({} as Record<string, string>),
  savePreferences: (_prefs?: Record<string, string>) => Promise.resolve({ success: true }),

  // ── Feature gating / misc (terminal reads these on mount) ──
  getFeatureFlags: () => Promise.resolve({}),
  isAiTraderEnabled: () => Promise.resolve(false),
  getAnnouncements: () => Promise.resolve([]),
  getAnnouncementsUnreadCount: () => Promise.resolve(0),
  replayGetSession: () => Promise.resolve(null),
};
