import type { Account, ClosedPosition, Fill, Order, Position } from "../schemas.ts";
import { publish } from "./bus.ts";
import { getDemoSymbol } from "./instruments.ts";

/**
 * In-browser paper-trading engine. The single source of truth for the demo
 * account, positions, orders and trade history.
 *
 * - State is persisted to localStorage after every mutation, so balance, open
 *   positions and the closed-trade history survive reloads and closed tabs.
 * - Quantities are plain asset units (0.005 BTC) — no lots. Notional is
 *   `price * qty * contractSize` (contractSize is 1 for the demo crypto pairs).
 * - A proportional commission (`feeRate`) is charged on every fill (entry and
 *   exit). Balance only ever changes by realized P&L minus fees.
 * - MARKET orders fill immediately at the latest price; LIMIT/STOP orders stay
 *   PENDING until the price (or, in replay, a candle's range) reaches them.
 * - Positions/orders belong to a `source`: "live" (real-time feed) or "replay"
 *   (historical practice). Each source is only ever priced by its own market
 *   data, and only the active source is visible through the getters.
 */

export const DEFAULT_STARTING_BALANCE = 100_000;
/** 0.25% per side, matching Bybit Spot / standard high-tier commission. */
export const DEFAULT_FEE_RATE = 0.0025;
const LEVERAGE = 100;
/**
 * Stop-out (forced liquidation): when equity falls to this fraction of the margin in use,
 * the worst losing position of the active mode is closed at the current market price,
 * repeating until the account is back above the threshold. 0.5 mirrors a typical broker
 * 50% margin-level stop-out. Without it a 100x position could lose far more than its margin.
 */
const STOP_OUT_RATIO = 0.5;
const STORAGE_KEY = "oc_demo_engine_v1";
const MAX_CLOSED = 5000;
const MAX_FILLS = 2000;
const MAX_ORDERS = 500;
const QTY_DECIMALS = 8;
const EPS = 1e-9;

type Source = "live" | "replay";
type EnginePosition = Position & { source: Source; entryFee: number };
type EngineOrder = Order & { source: Source };

/** OHLC range used to evaluate stops/pending orders (a tick has o=h=l=c). */
export type PriceBar = { open: number; high: number; low: number; close: number };

interface PersistedState {
  v: 1;
  accountId: string;
  createdAt: string;
  sessionId: number;
  sessionStartedAt: string;
  startingBalance: number;
  feeRate: number;
  feeMigratedBybit025?: boolean;
  /** Full bid/ask spread in basis points (1 bp = 0.01%); half is paid on each market-like fill. */
  spreadBps?: number;
  /** Extra adverse slippage in basis points on every market-like fill. */
  slippageBps?: number;
  balance: number;
  positions: EnginePosition[];
  orders: EngineOrder[];
  closed: ClosedPosition[];
  fills: Fill[];
}

export type PlaceOrderArgs = {
  accountId: string;
  symbol: string;
  side: string;
  type: string;
  quantity: number;
  price?: number;
  stopPrice?: number;
  takeProfit?: number;
  stopLoss?: number;
  notes?: string;
  oneHourScreenshot?: string;
  fourHourScreenshot?: string;
  entryScreenshot?: string;
  dailyScreenshot?: string;
  entryTimeframe?: string;
};

export interface DemoSummary {
  accountId: string;
  sessionId: number;
  startingBalance: number;
  feeRate: number;
  spreadBps: number;
  slippageBps: number;
  balance: number;
  equity: number;
  unrealizedPnl: number;
  /** Sum of closed-trade P&L before fees (current session). */
  realizedGross: number;
  /** All commissions paid in the current session, including open positions' entry fees. */
  fees: number;
  /** balance - startingBalance: realized P&L net of every fee paid. */
  netPnl: number;
  /** Sum of winning trades, net of their fees. */
  grossProfit: number;
  /** Sum of losing trades (positive number), net of their fees. */
  grossLoss: number;
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  openPositions: number;
  /** Closed trades kept from before the last reset (not part of current stats). */
  previousSessionTrades: number;
  replayActive: boolean;
}

// ── runtime-only (never persisted) ─────────────────────────────────────────
let mode: Source = "live";
let replaySymbol: string | null = null;
let replayClockMs: number | null = null;
const livePrice = new Map<string, number>();
const replayPrice = new Map<string, number>();
const listeners = new Set<() => void>();
let version = 0;

function uid(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function freshState(
  startingBalance = DEFAULT_STARTING_BALANCE,
  feeRate = DEFAULT_FEE_RATE,
): PersistedState {
  const now = new Date().toISOString();
  return {
    v: 1,
    accountId: uid(),
    createdAt: now,
    sessionId: 1,
    sessionStartedAt: now,
    startingBalance,
    feeRate,
    feeMigratedBybit025: true,
    spreadBps: 0,
    slippageBps: 0,
    balance: startingBalance,
    positions: [],
    orders: [],
    closed: [],
    fills: [],
  };
}

function isFiniteNum(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n);
}

function loadState(): PersistedState {
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(STORAGE_KEY) : null;
    if (!raw) return freshState();
    const s = JSON.parse(raw) as Partial<PersistedState>;
    if (
      s?.v !== 1 ||
      typeof s.accountId !== "string" ||
      !isFiniteNum(s.balance) ||
      !isFiniteNum(s.startingBalance) ||
      !Array.isArray(s.positions) ||
      !Array.isArray(s.orders) ||
      !Array.isArray(s.closed) ||
      !Array.isArray(s.fills)
    ) {
      return freshState();
    }
    const rawFee = isFiniteNum(s.feeRate) ? s.feeRate : DEFAULT_FEE_RATE;
    const migratedFee = !s.feeMigratedBybit025 && rawFee === 0.0005 ? DEFAULT_FEE_RATE : rawFee;
    const base = freshState(s.startingBalance, migratedFee);
    const loaded: PersistedState = {
      ...base,
      accountId: s.accountId,
      createdAt: s.createdAt ?? base.createdAt,
      sessionId: isFiniteNum(s.sessionId) ? s.sessionId : 1,
      sessionStartedAt: s.sessionStartedAt ?? base.sessionStartedAt,
      feeMigratedBybit025: true,
      spreadBps: isFiniteNum(s.spreadBps) && s.spreadBps >= 0 ? s.spreadBps : 0,
      slippageBps: isFiniteNum(s.slippageBps) && s.slippageBps >= 0 ? s.slippageBps : 0,
      balance: s.balance,
      positions: (s.positions as EnginePosition[]).map((p) => ({
        ...p,
        entryFee: isFiniteNum(p.entryFee) ? p.entryFee : 0,
        source: p.source === "replay" ? "replay" : "live",
      })),
      orders: (s.orders as EngineOrder[]).map((o) => ({
        ...o,
        source: o.source === "replay" ? "replay" : "live",
      })),
      closed: s.closed as ClosedPosition[],
      fills: s.fills as Fill[],
    };
    if (!s.feeMigratedBybit025 && typeof localStorage !== "undefined") {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(loaded));
      } catch {
        // ignore storage errors on migration
      }
    }
    return loaded;
  } catch {
    return freshState();
  }
}

let state: PersistedState = loadState();

const account: Account = {
  id: state.accountId,
  userId: "demo-user",
  templateId: "demo",
  label: "Demo Account",
  status: "ACTIVE",
  balance: state.balance,
  equity: state.balance,
  margin: 0,
  freeMargin: state.balance,
  phase: "LIVE",
  startDate: state.createdAt,
  createdAt: state.createdAt,
  updatedAt: state.createdAt,
  isHftMode: false,
  template: {
    name: "Demo Account",
    startingBalance: state.startingBalance,
    instrumentType: "CRYPTO",
  },
};

function persist(): void {
  version += 1;
  try {
    const serialized = JSON.stringify(state);
    localStorage.setItem(STORAGE_KEY, serialized);
    if (
      typeof window !== "undefined" &&
      typeof fetch === "function" &&
      !(typeof navigator !== "undefined" && navigator.userAgent?.toLowerCase().includes("jsdom"))
    ) {
      fetch("/__local_storage/state", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: serialized,
      }).catch(() => {});
    }
  } catch (err) {
    console.warn("[demo engine] could not persist state", err);
    // QuotaExceeded recovery: prune older history and retry
    try {
      if (state.closed.length > 200) {
        state.closed = state.closed.slice(0, 200);
      }
      if (state.fills.length > 200) {
        state.fills = state.fills.slice(0, 200);
      }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      // ignore
    }
  }
  for (const l of listeners) l();
}

// Migrate any legacy base64 screenshots in state to disk files (/trade-screenshots/*.png)
async function migrateBase64ScreenshotsToDisk(): Promise<void> {
  if (
    typeof window === "undefined" ||
    typeof fetch !== "function" ||
    (typeof navigator !== "undefined" && navigator.userAgent?.toLowerCase().includes("jsdom"))
  ) {
    return;
  }

  let changed = false;
  const uploadOne = async (
    val: string | undefined,
    sym: string,
    tradeId: string,
    tag: string,
  ): Promise<string | undefined> => {
    if (!val || !val.startsWith("data:image/")) return val;
    try {
      const res = await fetch("/__local_storage/screenshot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          filename: `${sym}_${tag}_${tradeId}`,
          dataUrl: val,
        }),
      });
      if (res.ok) {
        const json = (await res.json()) as { url?: string };
        if (json.url) {
          changed = true;
          return json.url;
        }
      }
    } catch {
      // keep base64 if server not reachable
    }
    return val;
  };

  for (const item of [...state.positions, ...state.closed, ...state.orders]) {
    if (item.oneHourScreenshot?.startsWith("data:image/")) {
      item.oneHourScreenshot = await uploadOne(item.oneHourScreenshot, item.symbolName, item.id, "1h");
    }
    if (item.fourHourScreenshot?.startsWith("data:image/")) {
      item.fourHourScreenshot = await uploadOne(item.fourHourScreenshot, item.symbolName, item.id, "4h");
    }
    if (item.dailyScreenshot?.startsWith("data:image/")) {
      item.dailyScreenshot = await uploadOne(item.dailyScreenshot, item.symbolName, item.id, "1d");
    }
    if (item.entryScreenshot?.startsWith("data:image/")) {
      item.entryScreenshot = await uploadOne(item.entryScreenshot, item.symbolName, item.id, "entry");
    }
  }

  if (changed) {
    persist();
    emitListsChanged();
  }
}

async function hydrateFromDiskIfMissing(): Promise<void> {
  if (
    typeof window === "undefined" ||
    typeof fetch !== "function" ||
    (typeof navigator !== "undefined" && navigator.userAgent?.toLowerCase().includes("jsdom"))
  ) {
    return;
  }
  try {
    if (typeof localStorage !== "undefined" && localStorage.getItem(STORAGE_KEY) !== null) {
      return;
    }
    const res = await fetch("/__local_storage/state");
    if (!res.ok) return;
    const raw = await res.text();
    if (!raw || raw === "null") return;
    const s = JSON.parse(raw) as Partial<PersistedState>;
    if (
      version === 0 &&
      s?.v === 1 &&
      typeof s.accountId === "string" &&
      isFiniteNum(s.balance) &&
      isFiniteNum(s.startingBalance) &&
      Array.isArray(s.positions) &&
      Array.isArray(s.orders) &&
      Array.isArray(s.closed) &&
      Array.isArray(s.fills)
    ) {
      localStorage.setItem(STORAGE_KEY, raw);
      state = loadState();
      account.id = state.accountId;
      account.startDate = state.createdAt;
      account.createdAt = state.createdAt;
      if (mode === "live") closeReplayLeftovers();
      recomputeEquity();
      for (const l of listeners) l();
      emitListsChanged();
      emitEquity();
    }
  } catch {
    // ignore
  }
}

setTimeout(() => {
  void hydrateFromDiskIfMissing().then(() => migrateBase64ScreenshotsToDisk());
}, 200);

/** Subscribe to persisted-state changes (trades, reset, settings) — not to price ticks. */
export function subscribeEngine(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function getEngineVersion(): number {
  return version;
}

function nowIso(): string {
  return new Date(
    mode === "replay" && replayClockMs != null ? replayClockMs : Date.now(),
  ).toISOString();
}

// ── getters ────────────────────────────────────────────────────────────────
export function getAccount(): Account {
  return { ...account, template: account.template ? { ...account.template } : undefined };
}
export function getAccounts(): Account[] {
  return [getAccount()];
}
export function getPositions(): Position[] {
  return state.positions.filter((p) => p.source === mode).map((p) => ({ ...p }));
}
export function getOrders(): Order[] {
  return state.orders.filter((o) => o.source === mode).map((o) => ({ ...o }));
}
export function resolveClosedPositionLevels(c: ClosedPosition): ClosedPosition {
  const persisted = state.closed.find((x) => x.id === c.id);
  let tp = c.takeProfit ?? persisted?.takeProfit;
  let sl = c.stopLoss ?? persisted?.stopLoss;
  if (tp == null || sl == null) {
    const matchedOrder = state.orders.find(
      (o) =>
        o.symbolName === c.symbolName &&
        (o.side === "BUY") === (c.side === "LONG") &&
        (o.updatedAt === c.openedAt ||
          o.createdAt === c.openedAt ||
          (o.avgFillPrice != null &&
            Math.abs(o.avgFillPrice - c.entryPrice) <=
              Math.max(1e-8, Math.abs(c.entryPrice) * 1e-6))),
    );
    if (matchedOrder) {
      if (tp == null) tp = matchedOrder.takeProfit ?? null;
      if (sl == null) sl = matchedOrder.stopLoss ?? null;
    }
    if (sl == null && c.exitReason === "stop-loss") {
      sl = c.exitPrice;
    }
    if (tp == null && c.exitReason === "take-profit") {
      tp = c.exitPrice;
    }
  }
  return { ...c, takeProfit: tp ?? null, stopLoss: sl ?? null };
}

export function getClosedPositions(): ClosedPosition[] {
  return state.closed.map((c) => resolveClosedPositionLevels(c));
}
export function getFills(): Fill[] {
  return state.fills.map((f) => ({ ...f }));
}
export function getMode(): Source {
  return mode;
}
export function isReplaySymbol(symbol: string): boolean {
  return mode === "replay" && replaySymbol === symbol;
}
/** Latest price for a symbol from whichever market-data source is active. */
export function getLastPrice(symbol: string): number {
  if (isReplaySymbol(symbol)) return replayPrice.get(symbol) ?? 0;
  return livePrice.get(symbol) ?? 0;
}

function priceOfSource(symbol: string, source: Source): number | undefined {
  return source === "replay" ? replayPrice.get(symbol) : livePrice.get(symbol);
}

// ── maths ──────────────────────────────────────────────────────────────────
function contractSizeOf(symbol: string): number {
  return getDemoSymbol(symbol)?.contractSize ?? 1;
}
function notional(symbol: string, qty: number, price: number): number {
  return price * qty * contractSizeOf(symbol);
}
function pnlOf(
  pos: Pick<Position, "symbolName" | "side" | "entryPrice">,
  qty: number,
  price: number,
): number {
  const dir = pos.side === "LONG" ? 1 : -1;
  return (price - pos.entryPrice) * qty * contractSizeOf(pos.symbolName) * dir;
}
function roundQty(q: number): number {
  const f = 10 ** QTY_DECIMALS;
  return Math.round(q * f) / f;
}

function recomputeEquity(): void {
  let unrealized = 0;
  let margin = 0;
  for (const p of state.positions) {
    const price = priceOfSource(p.symbolName, p.source) ?? p.currentPrice ?? p.entryPrice;
    p.currentPrice = price;
    p.unrealizedPnl = pnlOf(p, p.quantity, price);
    if (p.source === mode) {
      unrealized += p.unrealizedPnl;
      margin += p.margin;
    }
  }
  account.balance = state.balance;
  account.margin = margin;
  account.equity = state.balance + unrealized;
  account.freeMargin = account.equity - margin;
  account.updatedAt = new Date().toISOString();
  if (account.template) account.template.startingBalance = state.startingBalance;
}

interface ReplaySnapshot {
  balance: number;
  positions: EnginePosition[];
  orders: EngineOrder[];
  closed: ClosedPosition[];
  fills: Fill[];
}

const replaySnapshots = new Map<number, ReplaySnapshot>();
let replayInitialSnapshot: ReplaySnapshot | null = null;

function takeReplaySnapshot(): ReplaySnapshot {
  return {
    balance: state.balance,
    positions: state.positions.map((p) => ({ ...p })),
    orders: state.orders.map((o) => ({ ...o })),
    closed: state.closed.map((c) => ({ ...c })),
    fills: state.fills.map((f) => ({ ...f })),
  };
}

const MAX_REPLAY_SNAPSHOTS = 300;

function saveReplaySnapshot(): void {
  if (mode !== "replay" || replayClockMs == null) return;
  const sec = Math.floor(replayClockMs / 1000);
  if (replaySnapshots.has(sec)) replaySnapshots.delete(sec);
  replaySnapshots.set(sec, takeReplaySnapshot());
  while (replaySnapshots.size > MAX_REPLAY_SNAPSHOTS) {
    const oldest = replaySnapshots.keys().next().value;
    if (oldest === undefined) break;
    replaySnapshots.delete(oldest);
  }
}

function restoreReplaySnapshot(snap: ReplaySnapshot): void {
  state.balance = snap.balance;
  state.positions = snap.positions.map((p) => ({ ...p }));
  state.orders = snap.orders.map((o) => ({ ...o }));
  state.closed = snap.closed.map((c) => ({ ...c }));
  state.fills = snap.fills.map((f) => ({ ...f }));
}

function emitEquity(): void {
  publish("account", {
    eventType: "EquityUpdated",
    accountId: account.id,
    equity: account.equity,
    balance: account.balance,
    freeMargin: account.freeMargin,
    marginUsed: account.margin,
  });
}

function emitListsChanged(): void {
  publish("positions", { eventType: "ModeChanged", accountId: account.id });
  publish("orders", { eventType: "ModeChanged", accountId: account.id });
}

// ── validation ─────────────────────────────────────────────────────────────
function assertLevels(
  side: "LONG" | "SHORT",
  ref: number,
  sl?: number | null,
  tp?: number | null,
): void {
  const long = side === "LONG";
  if (sl != null) {
    if (!Number.isFinite(sl) || !(sl > 0)) throw new Error("Stop loss must be a positive price");
    if (long ? sl >= ref : sl <= ref) {
      throw new Error(
        `Stop loss must be ${long ? "below" : "above"} the reference price for a ${long ? "long" : "short"}`,
      );
    }
  }
  if (tp != null) {
    if (!Number.isFinite(tp) || !(tp > 0)) throw new Error("Take profit must be a positive price");
    if (long ? tp <= ref : tp >= ref) {
      throw new Error(
        `Take profit must be ${long ? "above" : "below"} the reference price for a ${long ? "long" : "short"}`,
      );
    }
  }
}

function assertMargin(symbol: string, qty: number, price: number): void {
  const required = notional(symbol, qty, price) / LEVERAGE;
  const fee = notional(symbol, qty, price) * state.feeRate;
  recomputeEquity();
  if (account.freeMargin < required + fee) {
    throw new Error(
      `Insufficient margin: need ${(required + fee).toFixed(2)} USD, free margin is ${Math.max(0, account.freeMargin).toFixed(2)} USD`,
    );
  }
}

// ── fills ──────────────────────────────────────────────────────────────────
/**
 * Execution-cost model. Market-like fills (market orders, triggered STOP entries, stop-loss,
 * manual / forced closes) pay half the spread plus slippage against the trader: BUY fills
 * above the reference price, SELL fills below it. LIMIT entries and take-profit exits are
 * passive and fill at their level. Both costs default to 0 (reference price, no friction).
 */
function adverseFill(side: "BUY" | "SELL", price: number): number {
  const f = ((state.spreadBps ?? 0) / 2 + (state.slippageBps ?? 0)) / 10_000;
  return side === "BUY" ? price * (1 + f) : price * (1 - f);
}

/**
 * Compute immediate fill price for a marketable pending order at placement/modification time.
 * Marketable orders cross the book immediately and pay half-spread + slippage, but a LIMIT order
 * is never allowed to fill at a worse price than its limit price.
 */
function marketablePendingFillPrice(order: Pick<Order, "side" | "type" | "price">, rawFill: number): number {
  const withFriction = adverseFill(order.side, rawFill);
  if (order.type === "LIMIT" && order.price != null) {
    return order.side === "BUY"
      ? Math.min(withFriction, order.price)
      : Math.max(withFriction, order.price);
  }
  return withFriction;
}

function trimLists(): void {
  if (state.closed.length > MAX_CLOSED) state.closed.length = MAX_CLOSED;
  if (state.fills.length > MAX_FILLS) state.fills.length = MAX_FILLS;
  if (state.orders.length > MAX_ORDERS) {
    // Keep every pending order; drop the oldest finished ones.
    const pending = state.orders.filter((o) => o.status === "PENDING");
    const done = state.orders
      .filter((o) => o.status !== "PENDING")
      .slice(0, Math.max(0, MAX_ORDERS - pending.length));
    state.orders = [...pending, ...done].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
}

function openPosition(order: EngineOrder, price: number): EnginePosition {
  const qty = order.quantity;
  const fee = notional(order.symbolName, qty, price) * state.feeRate;
  state.balance -= fee;
  const isLong = order.side === "BUY";
  const pos: EnginePosition = {
    id: uid(),
    accountId: account.id,
    symbolName: order.symbolName,
    side: isLong ? "LONG" : "SHORT",
    quantity: qty,
    entryPrice: price,
    currentPrice: price,
    unrealizedPnl: 0,
    margin: notional(order.symbolName, qty, price) / LEVERAGE,
    contractSize: contractSizeOf(order.symbolName),
    openedAt: nowIso(),
    takeProfit: order.takeProfit,
    stopLoss: order.stopLoss,
    source: order.source,
    entryFee: fee,
    notes: order.notes,
    oneHourScreenshot: order.oneHourScreenshot,
    fourHourScreenshot: order.fourHourScreenshot,
    entryScreenshot: order.entryScreenshot,
    dailyScreenshot: order.dailyScreenshot,
    entryTimeframe: order.entryTimeframe,
  };
  state.positions.push(pos);
  state.fills.unshift({
    id: uid(),
    orderId: order.id,
    accountId: account.id,
    symbolName: pos.symbolName,
    side: order.side,
    quantity: qty,
    price,
    commission: fee,
    realizedPnl: null,
    createdAt: pos.openedAt,
  });
  return pos;
}

function fillOrder(order: EngineOrder, price: number): void {
  order.status = "FILLED";
  order.filledQuantity = order.quantity;
  order.avgFillPrice = price;
  order.updatedAt = nowIso();
  const pos = openPosition(order, price);
  trimLists();
  recomputeEquity();
  publish("orders", {
    eventType: "OrderFilled",
    accountId: account.id,
    orderId: order.id,
    _entity: { ...order },
  });
  publish("positions", {
    eventType: "PositionOpened",
    accountId: account.id,
    positionId: pos.id,
    _entity: { ...pos },
  });
  persist();
  emitEquity();
}

function rejectOrder(order: EngineOrder, reason: string): void {
  order.status = "REJECTED";
  order.comment = reason;
  order.updatedAt = nowIso();
  publish("orders", {
    eventType: "OrderCanceled",
    accountId: account.id,
    orderId: order.id,
    _entity: { ...order },
  });
  persist();
}

/**
 * Market orders fill instantly at the latest price; LIMIT/STOP orders are queued
 * as PENDING and filled later by mark()/replayAdvance(). Throws on invalid input
 * (non-positive quantity, missing price, wrong-side SL/TP, insufficient margin).
 */
export function placeOrder(input: PlaceOrderArgs): Order {
  if (!getDemoSymbol(input.symbol)) throw new Error(`Unknown symbol ${input.symbol}`);
  if (mode === "replay" && input.symbol !== replaySymbol) {
    throw new Error(`Replay is running on ${replaySymbol}; you can only trade that symbol until you exit replay`);
  }
  const qty = roundQty(Number(input.quantity));
  if (!(qty > 0)) throw new Error("Quantity must be greater than 0");
  const type = (input.type as Order["type"]) ?? "MARKET";
  if (type !== "MARKET" && type !== "LIMIT" && type !== "STOP") {
    throw new Error(`Unsupported order type ${type}`);
  }
  const side = input.side === "BUY" ? "BUY" : "SELL";
  const posSide = side === "BUY" ? "LONG" : "SHORT";
  const market = getLastPrice(input.symbol);

  let ref: number;
  if (type === "MARKET") {
    if (!Number.isFinite(market) || !(market > 0)) throw new Error(`No market price available yet for ${input.symbol}`);
    ref = market;
  } else if (type === "LIMIT") {
    if (!(input.price != null && Number.isFinite(input.price) && input.price > 0)) throw new Error("Limit orders require a valid price");
    ref = input.price;
  } else {
    if (!(input.stopPrice != null && Number.isFinite(input.stopPrice) && input.stopPrice > 0)) {
      throw new Error("Stop orders require a valid stop price");
    }
    ref = input.stopPrice;
  }
  const now = nowIso();
  const order: EngineOrder = {
    id: uid(),
    accountId: account.id,
    symbolName: input.symbol,
    side,
    type,
    quantity: qty,
    price: type === "LIMIT" ? ref : null,
    stopPrice: type === "STOP" ? ref : null,
    takeProfit: input.takeProfit ?? null,
    stopLoss: input.stopLoss ?? null,
    status: "PENDING",
    filledQuantity: 0,
    avgFillPrice: null,
    comment: null,
    createdAt: now,
    updatedAt: now,
    source: mode,
    notes: input.notes?.trim() || undefined,
    oneHourScreenshot: input.oneHourScreenshot,
    fourHourScreenshot: input.fourHourScreenshot,
    entryScreenshot: input.entryScreenshot,
    dailyScreenshot: input.dailyScreenshot,
    entryTimeframe: input.entryTimeframe,
  };

  let immediatePx: number | null = null;
  if (type === "MARKET") {
    immediatePx = adverseFill(side, ref);
  } else if (market > 0) {
    const immediateFill = evaluatePending(order, { open: market, high: market, low: market, close: market });
    if (immediateFill != null) {
      immediatePx = marketablePendingFillPrice(order, immediateFill);
    }
  }

  assertLevels(posSide, immediatePx ?? ref, input.stopLoss, input.takeProfit);
  assertMargin(input.symbol, qty, immediatePx ?? ref);
  state.orders.unshift(order);
  publish("orders", {
    eventType: "OrderPlaced",
    accountId: account.id,
    orderId: order.id,
    _entity: { ...order },
  });
  if (immediatePx != null) {
    fillOrder(order, immediatePx);
  } else {
    persist();
  }
  saveReplaySnapshot();
  return { ...order };
}

function recordClose(
  pos: EnginePosition,
  qty: number,
  rawExitPrice: number,
  reason: NonNullable<ClosedPosition["exitReason"]>,
): void {
  // Prevent duplicate close recording if position was already closed
  if (!state.positions.some((p) => p.id === pos.id)) {
    return;
  }
  // Take-profit is a passive limit-style exit; every other close crosses the spread.
  const exitPrice =
    reason === "take-profit"
      ? rawExitPrice
      : adverseFill(pos.side === "LONG" ? "SELL" : "BUY", rawExitPrice);
  const gross = pnlOf(pos, qty, exitPrice);
  const exitFee = notional(pos.symbolName, qty, exitPrice) * state.feeRate;
  const entryFeePart = pos.entryFee * Math.min(1, qty / pos.quantity);
  pos.entryFee -= entryFeePart;
  state.balance += gross - exitFee;
  const now = nowIso();
  const remaining = roundQty(pos.quantity - qty);
  const full = remaining <= EPS || qty >= pos.quantity - EPS;
  state.closed.unshift({
    id: uid(),
    accountId: account.id,
    symbolName: pos.symbolName,
    side: pos.side,
    quantity: qty,
    entryPrice: pos.entryPrice,
    exitPrice,
    takeProfit: pos.takeProfit ?? null,
    stopLoss: pos.stopLoss ?? null,
    realizedPnl: gross,
    commission: entryFeePart + exitFee,
    swap: 0,
    openedAt: pos.openedAt,
    closedAt: now,
    isPartialClose: !full,
    source: pos.source,
    exitReason: reason,
    sessionId: state.sessionId,
    notes: pos.notes,
    oneHourScreenshot: pos.oneHourScreenshot,
    fourHourScreenshot: pos.fourHourScreenshot,
    entryScreenshot: pos.entryScreenshot,
    dailyScreenshot: pos.dailyScreenshot,
    entryTimeframe: pos.entryTimeframe,
  });
  state.fills.unshift({
    id: uid(),
    orderId: pos.id,
    accountId: account.id,
    symbolName: pos.symbolName,
    side: pos.side === "LONG" ? "SELL" : "BUY",
    quantity: qty,
    price: exitPrice,
    commission: exitFee,
    realizedPnl: gross,
    createdAt: now,
  });
  trimLists();
  if (full) {
    state.positions = state.positions.filter((p) => p.id !== pos.id);
    publish("positions", {
      eventType: "PositionClosed",
      accountId: account.id,
      positionId: pos.id,
    });
  } else {
    pos.quantity = roundQty(pos.quantity - qty);
    pos.margin = notional(pos.symbolName, pos.quantity, pos.entryPrice) / LEVERAGE;
    publish("positions", {
      eventType: "PositionUpdated",
      accountId: account.id,
      positionId: pos.id,
      quantity: pos.quantity,
      unrealizedPnl: pnlOf(pos, pos.quantity, exitPrice),
      averagePrice: pos.entryPrice,
      stopLoss: pos.stopLoss,
      takeProfit: pos.takeProfit,
    });
  }
  recomputeEquity();
  persist();
  emitEquity();
}

export function closePosition(positionId: string, quantity?: number): { success: boolean } {
  if (quantity !== undefined && (!Number.isFinite(quantity) || quantity <= 0)) {
    return { success: false };
  }
  const pos = state.positions.find((p) => p.id === positionId && p.source === mode);
  if (!pos) return { success: false };
  const price = priceOfSource(pos.symbolName, pos.source) ?? pos.currentPrice ?? pos.entryPrice;
  const qty = quantity !== undefined && quantity < pos.quantity - EPS ? roundQty(quantity) : pos.quantity;
  recordClose(pos, qty, price, "manual");
  saveReplaySnapshot();
  return { success: true };
}

export function closeAllPositions(): { success: boolean } {
  for (const p of state.positions.filter((x) => x.source === mode)) closePosition(p.id);
  saveReplaySnapshot();
  return { success: true };
}

export function modifyPosition(
  positionId: string,
  mods: { takeProfit?: number | null; stopLoss?: number | null },
): Position | undefined {
  const pos = state.positions.find((p) => p.id === positionId && p.source === mode);
  if (!pos) return undefined;
  const price = priceOfSource(pos.symbolName, pos.source) ?? pos.currentPrice ?? pos.entryPrice;
  // Levels are validated against the current price: a level already on the wrong
  // side of the market would trigger instantly, which is never what a drag meant.
  if (price) assertLevels(pos.side, price, mods.stopLoss ?? undefined, mods.takeProfit ?? undefined);
  if (mods.stopLoss !== undefined) pos.stopLoss = mods.stopLoss;
  if (mods.takeProfit !== undefined) pos.takeProfit = mods.takeProfit;
  publish("positions", {
    eventType: "PositionUpdated",
    accountId: account.id,
    positionId,
    unrealizedPnl: pos.unrealizedPnl,
    quantity: pos.quantity,
    averagePrice: pos.entryPrice,
    stopLoss: pos.stopLoss,
    takeProfit: pos.takeProfit,
  });
  persist();
  saveReplaySnapshot();
  return { ...pos };
}

export interface ModifyOrderArgs {
  price?: number | null;
  stopPrice?: number | null;
  quantity?: number;
  takeProfit?: number | null;
  stopLoss?: number | null;
}

export function modifyOrder(orderId: string, mods: ModifyOrderArgs): Order | undefined {
  const order = state.orders.find(
    (o) => o.id === orderId && o.status === "PENDING" && o.source === mode,
  );
  if (!order) return undefined;
  const nextQty = mods.quantity !== undefined ? roundQty(Number(mods.quantity)) : order.quantity;
  if (!(nextQty > 0)) throw new Error("Quantity must be greater than 0");
  const nextPrice =
    mods.price !== undefined
      ? mods.price
      : mods.stopPrice !== undefined && order.type === "LIMIT"
        ? mods.stopPrice
        : order.price;
  const nextStopPrice =
    mods.stopPrice !== undefined
      ? mods.stopPrice
      : mods.price !== undefined && order.type === "STOP"
        ? mods.price
        : order.stopPrice;
  const ref = order.type === "STOP" ? nextStopPrice : nextPrice;
  if (!(ref != null && Number.isFinite(ref) && ref > 0)) throw new Error("Order requires a valid trigger price");
  const nextSl = mods.stopLoss !== undefined ? mods.stopLoss : order.stopLoss;
  const nextTp = mods.takeProfit !== undefined ? mods.takeProfit : order.takeProfit;
  const posSide = order.side === "BUY" ? "LONG" : "SHORT";

  const candidateOrder: Pick<Order, "side" | "type" | "price" | "stopPrice"> = {
    side: order.side,
    type: order.type,
    price: order.type === "LIMIT" ? ref : order.price,
    stopPrice: order.type === "STOP" ? ref : order.stopPrice,
  };
  const market = getLastPrice(order.symbolName);
  let immediatePx: number | null = null;
  if (market > 0) {
    const fill = evaluatePending(candidateOrder, { open: market, high: market, low: market, close: market });
    if (fill != null) {
      immediatePx = marketablePendingFillPrice(candidateOrder, fill);
    }
  }

  // Validate SL/TP and margin against the actual execution reference before mutating state
  assertLevels(posSide, immediatePx ?? ref, nextSl, nextTp);
  assertMargin(order.symbolName, nextQty, immediatePx ?? ref);

  order.quantity = nextQty;
  if (order.type === "LIMIT") order.price = ref;
  if (order.type === "STOP") order.stopPrice = ref;
  order.stopLoss = nextSl ?? null;
  order.takeProfit = nextTp ?? null;
  order.updatedAt = nowIso();
  publish("orders", {
    eventType: "OrderPlaced",
    accountId: account.id,
    orderId: order.id,
    _entity: { ...order },
  });
  if (immediatePx != null) {
    fillOrder(order, immediatePx);
    saveReplaySnapshot();
    return { ...order };
  }
  persist();
  saveReplaySnapshot();
  return { ...order };
}

export function cancelOrder(orderId: string): { success: boolean } {
  const order = state.orders.find(
    (o) => o.id === orderId && o.status === "PENDING" && o.source === mode,
  );
  if (!order) return { success: false };
  order.status = "CANCELLED";
  order.updatedAt = nowIso();
  publish("orders", {
    eventType: "OrderCanceled",
    accountId: account.id,
    orderId,
    _entity: { ...order },
  });
  persist();
  saveReplaySnapshot();
  return { success: true };
}

export function cancelAllOrders(): { success: boolean } {
  for (const o of state.orders.filter((x) => x.source === mode && x.status === "PENDING")) {
    cancelOrder(o.id);
  }
  saveReplaySnapshot();
  return { success: true };
}

// ── trigger evaluation (shared by live ticks and replay candles) ───────────
/** SL is checked before TP: if one bar touches both, the conservative outcome wins. */
export function evaluateStops(
  pos: Pick<Position, "side" | "stopLoss" | "takeProfit">,
  bar: PriceBar,
): { price: number; reason: "stop-loss" | "take-profit" } | null {
  const long = pos.side === "LONG";
  const { stopLoss: sl, takeProfit: tp } = pos;
  if (sl != null && (long ? bar.low <= sl : bar.high >= sl)) {
    // A gap through the stop fills at the open, not at the (better) stop level.
    const price = long ? Math.min(sl, bar.open) : Math.max(sl, bar.open);
    return { price, reason: "stop-loss" };
  }
  if (tp != null && (long ? bar.high >= tp : bar.low <= tp)) {
    const price = long ? Math.max(tp, bar.open) : Math.min(tp, bar.open);
    return { price, reason: "take-profit" };
  }
  return null;
}

/** Fill price for a pending order if `bar` triggers it, otherwise null. */
export function evaluatePending(
  order: Pick<Order, "side" | "type" | "price" | "stopPrice">,
  bar: PriceBar,
): number | null {
  const buy = order.side === "BUY";
  if (order.type === "LIMIT" && order.price != null) {
    const l = order.price;
    if (buy) return bar.low <= l ? Math.min(l, bar.open) : null;
    return bar.high >= l ? Math.max(l, bar.open) : null;
  }
  if (order.type === "STOP" && order.stopPrice != null) {
    const s = order.stopPrice;
    if (buy) return bar.high >= s ? Math.max(s, bar.open) : null;
    return bar.low <= s ? Math.min(s, bar.open) : null;
  }
  return null;
}

function processBar(symbol: string, source: Source, bar: PriceBar): void {
  const barIso = nowIso();
  const openedByLimitInThisBar = new Set<string>();
  const pendings = state.orders.filter(
    (o) => o.source === source && o.symbolName === symbol && o.status === "PENDING",
  );
  for (const order of pendings) {
    const fill = evaluatePending(order, bar);
    if (fill == null) continue;
    try {
      const px = order.type === "STOP" ? adverseFill(order.side, fill) : fill;
      assertMargin(order.symbolName, order.quantity, px);
      const countBefore = state.positions.length;
      fillOrder(order, px);
      if (order.type === "LIMIT" && state.positions.length > countBefore) {
        const newest = state.positions[state.positions.length - 1];
        if (newest) openedByLimitInThisBar.add(newest.id);
      }
    } catch (err) {
      rejectOrder(order, err instanceof Error ? err.message : "Rejected");
    }
  }
  for (const pos of state.positions.filter((p) => p.source === source && p.symbolName === symbol)) {
    // A position opened by a pending order inside this very bar has an unknown intrabar path
    // with respect to take-profit or a STOP entry's pullback, EXCEPT when:
    // 1. A LIMIT order filled at `entryPrice` and the bar continued beyond `stopLoss` (e.g. BUY LIMIT at 100, SL at 98, bar low = 95 -> low 95 was strictly reached after passing 100), OR
    // 2. The bar's closing price itself is already beyond `stopLoss`.
    if (source === "replay" && pos.openedAt === barIso) {
      const sl = pos.stopLoss;
      if (sl != null) {
        const long = pos.side === "LONG";
        const limitBreachedSl = openedByLimitInThisBar.has(pos.id) && (long ? bar.low <= sl : bar.high >= sl);
        const closeBreachedSl = long ? bar.close <= sl : bar.close >= sl;
        if (limitBreachedSl || closeBreachedSl) {
          const slPrice = long ? Math.min(sl, bar.open) : Math.max(sl, bar.open);
          recordClose(pos, pos.quantity, slPrice, "stop-loss");
        }
      }
      continue;
    }
    const hit = evaluateStops(pos, bar);
    if (hit) recordClose(pos, pos.quantity, hit.price, hit.reason);
  }
}

function touchPositions(symbol: string, source: Source, price: number): void {
  for (const pos of state.positions) {
    if (pos.source !== source || pos.symbolName !== symbol) continue;
    pos.currentPrice = price;
    pos.unrealizedPnl = pnlOf(pos, pos.quantity, price);
    publish("positions", {
      eventType: "PositionUpdated",
      accountId: account.id,
      positionId: pos.id,
      unrealizedPnl: pos.unrealizedPnl,
      quantity: pos.quantity,
      averagePrice: pos.entryPrice,
    });
  }
}

/** Force-close the worst positions of `source` while equity <= STOP_OUT_RATIO * margin used. */
function enforceStopOut(source: Source): void {
  for (let guard = 0; guard < 50; guard++) {
    recomputeEquity();
    const candidates = state.positions.filter((p) => p.source === source);
    if (candidates.length === 0) return;
    let sourceUnrealized = 0;
    let sourceMargin = 0;
    for (const p of candidates) {
      sourceUnrealized += p.unrealizedPnl;
      sourceMargin += p.margin;
    }
    const sourceEquity = state.balance + sourceUnrealized;
    if (!(sourceMargin > 0) || sourceEquity > sourceMargin * STOP_OUT_RATIO) return;
    const worst = candidates.reduce((a, b) => (a.unrealizedPnl <= b.unrealizedPnl ? a : b));
    const price = priceOfSource(worst.symbolName, worst.source) ?? worst.currentPrice ?? worst.entryPrice;
    recordClose(worst, worst.quantity, price, "liquidation");
  }
}

/** Seed the latest live price without triggering pending orders or stops on stale fallback ticks. */
export function seedLivePrice(symbol: string, price: number): void {
  if (price > 0) {
    livePrice.set(symbol, price);
  }
}

/** Called by the live feed on every tick: marks positions, fires pending orders / SL / TP. */
export function mark(symbol: string, price: number): void {
  livePrice.set(symbol, price);
  if (mode === "replay") return;
  const relevant =
    state.positions.some((p) => p.source === "live" && p.symbolName === symbol) ||
    state.orders.some(
      (o) => o.source === "live" && o.symbolName === symbol && o.status === "PENDING",
    );
  if (!relevant) return;
  processBar(symbol, "live", { open: price, high: price, low: price, close: price });
  touchPositions(symbol, "live", price);
  enforceStopOut("live");
  recomputeEquity();
  emitEquity();
}

// ── replay ─────────────────────────────────────────────────────────────────
/** Switch to replay mode for one symbol. Live positions/orders are hidden (not touched). */
export function enterReplay(symbol: string, firstBar: PriceBar & { timeSec: number }): void {
  if (mode === "replay") closeReplayLeftovers();
  mode = "replay";
  replaySymbol = symbol;
  replayPrice.clear();
  replaySnapshots.clear();
  replayClockMs = firstBar.timeSec * 1000;
  replayPrice.set(symbol, firstBar.close);
  replayInitialSnapshot = takeReplaySnapshot();
  saveReplaySnapshot();
  recomputeEquity();
  emitListsChanged();
  emitEquity();
}

/**
 * Advance replay by one fully-formed candle: pending orders and SL/TP are tested
 * against that candle's range only (never beyond it), then the price moves to its close.
 */
export function replayAdvance(symbol: string, bar: PriceBar & { timeSec: number }): void {
  if (mode !== "replay" || replaySymbol !== symbol) return;
  replayClockMs = bar.timeSec * 1000;
  processBar(symbol, "replay", bar);
  replayPrice.set(symbol, bar.close);
  touchPositions(symbol, "replay", bar.close);
  enforceStopOut("replay");
  saveReplaySnapshot();
  recomputeEquity();
  emitEquity();
}

/**
 * Rewind replay to an earlier candle: restores the exact replay state as of that candle
 * (or the state prior to the rewound candle) so stepping backward and forward again is
 * 100% deterministic and never duplicates executions, PnL, or commissions.
 */
export function replayRewind(symbol: string, bar: PriceBar & { timeSec: number }): void {
  if (mode !== "replay" || replaySymbol !== symbol) return;
  const targetSec = Math.floor(bar.timeSec);
  const targetMs = bar.timeSec * 1000;
  // Prune snapshots from future bars that we just rewound past
  for (const key of Array.from(replaySnapshots.keys())) {
    if (key > targetSec) {
      replaySnapshots.delete(key);
    }
  }
  let snap = replaySnapshots.get(targetSec);
  if (!snap) {
    // Find the latest snapshot at or before targetSec, or fall back to initial snapshot
    let bestSec = -Infinity;
    for (const [sec, candidate] of replaySnapshots.entries()) {
      if (sec <= targetSec && sec > bestSec) {
        bestSec = sec;
        snap = candidate;
      }
    }
    if (!snap) snap = replayInitialSnapshot ?? undefined;
  }
  if (snap) {
    restoreReplaySnapshot(snap);
  }
  replayClockMs = targetMs;
  replayPrice.set(symbol, bar.close);
  touchPositions(symbol, "replay", bar.close);
  saveReplaySnapshot();
  recomputeEquity();
  persist();
  emitListsChanged();
  emitEquity();
}

/** Leave replay: open replay positions are closed at the last replay price, replay orders dropped. */
export function exitReplay(): void {
  if (mode !== "replay") return;
  closeReplayLeftovers();
  mode = "live";
  replaySymbol = null;
  replayClockMs = null;
  replayPrice.clear();
  replaySnapshots.clear();
  replayInitialSnapshot = null;
  recomputeEquity();
  persist();
  emitListsChanged();
  emitEquity();
}

function closeReplayLeftovers(): void {
  for (const pos of state.positions.filter((p) => p.source === "replay")) {
    const price = replayPrice.get(pos.symbolName) ?? pos.currentPrice ?? pos.entryPrice;
    recordClose(pos, pos.quantity, price, "replay-end");
  }
  const before = state.orders.length;
  state.orders = state.orders.filter((o) => !(o.source === "replay" && o.status === "PENDING"));
  if (state.orders.length !== before) persist();
}

// Replay state is memory-only: a position left over from a page reload mid-replay
// is settled at its last known price instead of lingering with a dead feed.
closeReplayLeftovers();

// ── account configuration / reset / summary ────────────────────────────────
export function setStartingBalance(startingBalance: number): DemoSummary {
  if (!(startingBalance >= 1 && startingBalance <= 1e9)) {
    throw new Error("Starting capital must be between 1 and 1,000,000,000");
  }
  const delta = startingBalance - state.startingBalance;
  const realizedNetDelta = state.balance - state.startingBalance;
  state.startingBalance = startingBalance;
  state.balance = startingBalance + realizedNetDelta;
  if (mode === "replay" && delta !== 0) {
    if (replayInitialSnapshot) {
      replayInitialSnapshot.balance += delta;
    }
    for (const snap of replaySnapshots.values()) {
      snap.balance += delta;
    }
  }
  recomputeEquity();
  persist();
  saveReplaySnapshot();
  emitEquity();
  return getSummary();
}

export function setFeeRate(feeRate: number): void {
  if (!(feeRate >= 0 && feeRate < 0.1)) throw new Error("Fee must be between 0% and 10%");
  state.feeRate = feeRate;
  persist();
}

/** Set the execution-cost model (basis points; 1 bp = 0.01%). Applies to future fills only. */
export function setCostModel(spreadBps: number, slippageBps: number): void {
  if (!(spreadBps >= 0 && spreadBps <= 500) || !(slippageBps >= 0 && slippageBps <= 500)) {
    throw new Error("Spread and slippage must be between 0 and 500 bps");
  }
  state.spreadBps = spreadBps;
  state.slippageBps = slippageBps;
  persist();
}

export interface ResetOptions {
  startingBalance?: number;
  feeRate?: number;
  spreadBps?: number;
  slippageBps?: number;
  /** Keep the closed-trade history (it stays listed but no longer counts in the stats). */
  keepHistory: boolean;
}

/**
 * Restore the demo account. Open positions and pending orders are discarded;
 * the balance returns to `startingBalance`; history is kept or wiped as asked.
 * A new session id makes the stats start from zero either way.
 */
export function resetAccount(opts: ResetOptions): void {
  const startingBalance = opts.startingBalance ?? state.startingBalance;
  if (!(startingBalance >= 1 && startingBalance <= 1e9)) {
    throw new Error("Starting capital must be between 1 and 1,000,000,000");
  }
  const feeRate = opts.feeRate ?? state.feeRate;
  if (!(feeRate >= 0 && feeRate < 0.1)) throw new Error("Fee must be between 0% and 10%");
  const spreadBps = opts.spreadBps ?? state.spreadBps ?? 0;
  const slippageBps = opts.slippageBps ?? state.slippageBps ?? 0;
  if (!(spreadBps >= 0 && spreadBps <= 500) || !(slippageBps >= 0 && slippageBps <= 500)) {
    throw new Error("Spread and slippage must be between 0 and 500 bps");
  }
  const now = new Date().toISOString();
  const droppedIds = state.positions.map((p) => p.id);
  state = {
    ...state,
    sessionId: state.sessionId + 1,
    sessionStartedAt: now,
    startingBalance,
    feeRate,
    spreadBps,
    slippageBps,
    balance: startingBalance,
    positions: [],
    orders: [],
    closed: opts.keepHistory ? state.closed : [],
    fills: opts.keepHistory ? state.fills : [],
  };
  replaySnapshots.clear();
  if (mode === "replay") {
    replayInitialSnapshot = takeReplaySnapshot();
    saveReplaySnapshot();
  } else {
    replayInitialSnapshot = null;
  }
  for (const id of droppedIds) {
    publish("positions", { eventType: "PositionClosed", accountId: account.id, positionId: id });
  }
  recomputeEquity();
  persist();
  emitListsChanged();
  emitEquity();
}

/** Clear all closed trades and fills without resetting account balance or settings. */
export function clearHistory(): void {
  state = {
    ...state,
    closed: [],
    fills: [],
  };
  persist();
  emitListsChanged();
}

export function getSummary(): DemoSummary {
  recomputeEquity();
  const session = state.closed.filter((c) => c.sessionId === state.sessionId);
  let realizedGross = 0;
  let closedFees = 0;
  let grossProfit = 0;
  let grossLoss = 0;
  let wins = 0;
  let losses = 0;
  for (const c of session) {
    const net = c.realizedPnl - c.commission;
    realizedGross += c.realizedPnl;
    closedFees += c.commission;
    if (net > 0) {
      grossProfit += net;
      wins += 1;
    } else if (net < 0) {
      grossLoss += -net;
      losses += 1;
    }
  }
  const openFees = state.positions
    .filter((p) => p.source === mode)
    .reduce((s, p) => s + (p.entryFee ?? 0), 0);
  const trades = session.length;
  return {
    accountId: account.id,
    sessionId: state.sessionId,
    startingBalance: state.startingBalance,
    feeRate: state.feeRate,
    spreadBps: state.spreadBps ?? 0,
    slippageBps: state.slippageBps ?? 0,
    balance: state.balance,
    equity: account.equity,
    unrealizedPnl: account.equity - state.balance,
    realizedGross,
    fees: closedFees + openFees,
    netPnl: state.balance - state.startingBalance,
    grossProfit,
    grossLoss,
    trades,
    wins,
    losses,
    winRate: trades > 0 ? wins / trades : 0,
    openPositions: state.positions.filter((p) => p.source === mode).length,
    previousSessionTrades: state.closed.length - trades,
    replayActive: mode === "replay",
  };
}

export function getSettings(): {
  startingBalance: number;
  feeRate: number;
  spreadBps: number;
  slippageBps: number;
} {
  return {
    startingBalance: state.startingBalance,
    feeRate: state.feeRate,
    spreadBps: state.spreadBps ?? 0,
    slippageBps: state.slippageBps ?? 0,
  };
}

export function updateTradeNotes(tradeId: string, notes: string): void {
  const trimmed = notes.trim() || undefined;
  const closed = state.closed.find((c) => c.id === tradeId);
  if (closed) {
    closed.notes = trimmed;
    persist();
    emitListsChanged();
    return;
  }
  const pos = state.positions.find((p) => p.id === tradeId);
  if (pos) {
    pos.notes = trimmed;
    persist();
    emitListsChanged();
  }
}

export function updateTradeScreenshot(
  tradeId: string,
  type: "1h" | "4h" | "daily" | "entry",
  dataUrl: string,
): void {
  if (!dataUrl) return;
  const closed = state.closed.find((c) => c.id === tradeId);
  if (closed) {
    if (type === "1h") closed.oneHourScreenshot = dataUrl;
    else if (type === "4h") closed.fourHourScreenshot = dataUrl;
    else if (type === "daily") closed.dailyScreenshot = dataUrl;
    else closed.entryScreenshot = dataUrl;
    persist();
    emitListsChanged();
    return;
  }
  const pos = state.positions.find((p) => p.id === tradeId);
  if (pos) {
    if (type === "1h") pos.oneHourScreenshot = dataUrl;
    else if (type === "4h") pos.fourHourScreenshot = dataUrl;
    else if (type === "daily") pos.dailyScreenshot = dataUrl;
    else pos.entryScreenshot = dataUrl;
    persist();
    emitListsChanged();
  }
}

export function attachOrderScreenshots(
  orderId: string,
  shots: {
    oneHourScreenshot?: string;
    fourHourScreenshot?: string;
    dailyScreenshot?: string;
    entryScreenshot?: string;
    entryTimeframe?: string;
  },
): void {
  const order = state.orders.find((o) => o.id === orderId);
  if (!order) return;
  let changed = false;
  const applyTo = (
    target: Pick<
      EngineOrder,
      "oneHourScreenshot" | "fourHourScreenshot" | "dailyScreenshot" | "entryScreenshot" | "entryTimeframe"
    >,
  ) => {
    if (shots.oneHourScreenshot && !target.oneHourScreenshot) {
      target.oneHourScreenshot = shots.oneHourScreenshot;
      changed = true;
    }
    if (shots.fourHourScreenshot && !target.fourHourScreenshot) {
      target.fourHourScreenshot = shots.fourHourScreenshot;
      changed = true;
    }
    if (shots.dailyScreenshot && !target.dailyScreenshot) {
      target.dailyScreenshot = shots.dailyScreenshot;
      changed = true;
    }
    if (shots.entryScreenshot && !target.entryScreenshot) {
      target.entryScreenshot = shots.entryScreenshot;
      changed = true;
    }
    if (shots.entryTimeframe && !target.entryTimeframe) {
      target.entryTimeframe = shots.entryTimeframe;
      changed = true;
    }
  };
  applyTo(order);
  for (const pos of state.positions) {
    if (pos.symbolName === order.symbolName && pos.openedAt === order.updatedAt) {
      applyTo(pos);
    }
  }
  for (const closed of state.closed) {
    if (closed.symbolName === order.symbolName && closed.openedAt === order.updatedAt) {
      applyTo(closed);
    }
  }
  if (changed) {
    persist();
    emitListsChanged();
  }
}

// Prime derived account fields from the persisted state.
recomputeEquity();
