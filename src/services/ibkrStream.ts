// ── Interactive Brokers Real-Time Stream (1s base + Consolidated Quote) ──────────
import { getCachedIbkrConfigStatus } from "./ibkrConfig.ts";
import { getDemoSymbol } from "./demo/instruments.ts";

export interface IbkrLiveVwapAccumulator {
  anchorBucket: number;
  cumVol: number;
  mean: number;
  sumSqWeightedDiff: number;
  vwap: number | null;
}

export interface IbkrLiveBarEvent {
  symbol: string;
  bar: {
    time: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
  };
  vwap?: {
    extended: IbkrLiveVwapAccumulator;
    regular: IbkrLiveVwapAccumulator;
  };
}

export interface IbkrLiveQuoteEvent {
  symbol: string;
  bid?: number;
  ask?: number;
  last?: number;
  priorClose?: number;
  timestamp: number;
}

type Bar1sListener = (evt: IbkrLiveBarEvent) => void;
type QuoteListener = (evt: IbkrLiveQuoteEvent) => void;
type StreamStatusListener = (connected: boolean, reason?: string, marketDataType?: number) => void;

const refCounts = new Map<string, number>();
const bar1sListeners = new Set<Bar1sListener>();
const quoteListeners = new Set<QuoteListener>();
const statusListeners = new Set<StreamStatusListener>();

let activeSse: EventSource | null = null;
let subscribedKey = "";
let syncTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempts = 0;
let sseConnected = false;
let sseMarketDataType: number | null = null;

/** Returns true when IBKR live SSE socket is currently open & connected. */
export function isIbkrLiveStreamConnected(): boolean {
  return sseConnected;
}

/** Returns the effective IBKR market data type (1=Live, 2=Frozen, 4=Delayed-Frozen). */
export function getIbkrEffectiveMarketDataType(): number {
  if (sseMarketDataType === 1 || sseMarketDataType === 2 || sseMarketDataType === 4) {
    return sseMarketDataType;
  }
  const cached = getCachedIbkrConfigStatus();
  return cached?.effectiveMarketDataType ?? cached?.marketDataType ?? 1;
}

/** Returns true when IBKR is running in 15-minute Delayed Frozen mode (type 4). */
export function isIbkrDelayedMode(): boolean {
  return getIbkrEffectiveMarketDataType() === 4;
}

/** Subscribes to IBKR SSE live stream status changes. */
export function subscribeIbkrStreamStatus(fn: StreamStatusListener): () => void {
  statusListeners.add(fn);
  try {
    fn(sseConnected, undefined, getIbkrEffectiveMarketDataType());
  } catch {
    // ignore listener error
  }
  return () => {
    statusListeners.delete(fn);
  };
}

/** Subscribes to live 1-second bars pushed by IBKR. */
export function subscribeIbkr1sBar(fn: Bar1sListener): () => void {
  bar1sListeners.add(fn);
  return () => {
    bar1sListeners.delete(fn);
  };
}

/** Subscribes to consolidated quote / L1 updates pushed by IBKR. */
export function subscribeIbkrQuote(fn: QuoteListener): () => void {
  quoteListeners.add(fn);
  return () => {
    quoteListeners.delete(fn);
  };
}

function notifyStatus(connected: boolean, reason?: string, marketDataType?: number): void {
  sseConnected = connected;
  if (marketDataType === 1 || marketDataType === 2 || marketDataType === 4) {
    sseMarketDataType = marketDataType;
  }
  const effectiveMdt = getIbkrEffectiveMarketDataType();
  for (const fn of statusListeners) {
    try {
      fn(connected, reason, effectiveMdt);
    } catch {
      // ignore listener error
    }
  }
}

function getTrackedSymbols(): string[] {
  return Array.from(refCounts.entries())
    .filter(([, count]) => count > 0)
    .map(([sym]) => sym)
    .sort();
}

function closeActiveSse(): void {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (activeSse) {
    try {
      activeSse.close();
    } catch {
      // ignore close error
    }
    activeSse = null;
  }
}

function syncStreamConnection(): void {
  if (typeof window === "undefined" || typeof EventSource === "undefined") return;
  const symbols = getTrackedSymbols();
  const nextKey = symbols.join(",");

  if (!nextKey) {
    subscribedKey = "";
    closeActiveSse();
    notifyStatus(false, "no-symbols");
    return;
  }

  if (nextKey === subscribedKey && activeSse && activeSse.readyState !== EventSource.CLOSED) {
    return;
  }

  subscribedKey = nextKey;
  closeActiveSse();

  const exchangeHints = symbols
    .map((s) => {
      const exch = getDemoSymbol(s)?.exchange?.trim();
      return exch ? `${s}:${exch}` : "";
    })
    .filter(Boolean)
    .join(",");

  const qs = new URLSearchParams({ symbols: nextKey });
  if (exchangeHints) qs.set("exchanges", exchangeHints);

  const es = new EventSource(`/__api/ibkr-stream?${qs.toString()}`);
  activeSse = es;

  es.onopen = () => {
    if (activeSse !== es) return;
    reconnectAttempts = 0;
  };

  es.onmessage = (msg) => {
    if (activeSse !== es || !msg.data) return;
    try {
      const payload = JSON.parse(msg.data) as {
        type?: string;
        symbol?: string;
        connected?: boolean;
        connectionState?: string;
        marketDataType?: number;
        reason?: string;
        bar?: IbkrLiveBarEvent["bar"];
        vwap?: IbkrLiveBarEvent["vwap"];
        bid?: number;
        ask?: number;
        last?: number;
        priorClose?: number;
        timestamp?: number;
      };

      if (payload.type === "status") {
        notifyStatus(Boolean(payload.connected), payload.reason, payload.marketDataType);
        return;
      }

      if (payload.type === "bar1s" && payload.symbol && payload.bar) {
        reconnectAttempts = 0;
        if (!sseConnected) notifyStatus(true);
        const evt: IbkrLiveBarEvent = {
          symbol: payload.symbol,
          bar: payload.bar,
          vwap: payload.vwap,
        };
        for (const fn of bar1sListeners) {
          try {
            fn(evt);
          } catch {
            // ignore bar listener error
          }
        }
        return;
      }

      if (payload.type === "quote" && payload.symbol) {
        if (!sseConnected) notifyStatus(true);
        const evt: IbkrLiveQuoteEvent = {
          symbol: payload.symbol,
          bid: payload.bid,
          ask: payload.ask,
          last: payload.last,
          priorClose: payload.priorClose,
          timestamp: typeof payload.timestamp === "number" ? payload.timestamp : Date.now(),
        };
        for (const fn of quoteListeners) {
          try {
            fn(evt);
          } catch {
            // ignore quote listener error
          }
        }
      }
    } catch {
      // ignore malformed SSE event
    }
  };

  es.onerror = () => {
    if (activeSse !== es) return;
    closeActiveSse();
    notifyStatus(false, "sse-disconnected");
    const delayMs = Math.min(15_000, 1_500 * Math.pow(2, reconnectAttempts));
    reconnectAttempts += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      subscribedKey = "";
      syncStreamConnection();
    }, delayMs);
  };
}

function scheduleSync(): void {
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    syncTimer = null;
    syncStreamConnection();
  }, 80);
}

/**
 * Tracks a US equity symbol in the active IBKR SSE stream using reference counting.
 * Switching timeframes on the same symbol does NOT release or reopen the stream.
 */
export function trackIbkrSymbol(symbol: string): () => void {
  const clean = symbol.trim().toUpperCase();
  if (!clean) return () => {};

  refCounts.set(clean, (refCounts.get(clean) ?? 0) + 1);
  scheduleSync();

  let released = false;
  return () => {
    if (released) return;
    released = true;
    const prev = refCounts.get(clean) ?? 0;
    if (prev <= 1) {
      refCounts.delete(clean);
    } else {
      refCounts.set(clean, prev - 1);
    }
    scheduleSync();
  };
}

/** Forces an immediate teardown & resubscribe of the active IBKR SSE connection (e.g. after config save). */
export function resetIbkrStreamConnection(): void {
  subscribedKey = "";
  reconnectAttempts = 0;
  closeActiveSse();
  syncStreamConnection();
}
