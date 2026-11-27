// ── Cryptocurrency Real-Time Stream (Binance Spot/Futures + Kraken fallback SSE) ──

export interface CryptoLiveBarEvent {
  symbol: string;
  timeframe: string;
  bar: {
    time: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
  };
}

export interface CryptoLiveQuoteEvent {
  symbol: string;
  bid?: number;
  ask?: number;
  last?: number;
  timestamp: number;
}

type BarListener = (evt: CryptoLiveBarEvent) => void;
type QuoteListener = (evt: CryptoLiveQuoteEvent) => void;
type StatusListener = (connected: boolean, reason?: string) => void;

const refCounts = new Map<string, number>();
const barListeners = new Set<BarListener>();
const quoteListeners = new Set<QuoteListener>();
const statusListeners = new Set<StatusListener>();

let activeSse: EventSource | null = null;
let subscribedKey = "";
let syncTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempts = 0;
let sseConnected = false;

export function isCryptoLiveStreamConnected(): boolean {
  return sseConnected;
}

export function subscribeCryptoStreamStatus(fn: StatusListener): () => void {
  statusListeners.add(fn);
  try {
    fn(sseConnected);
  } catch {
    // ignore
  }
  return () => {
    statusListeners.delete(fn);
  };
}

export function subscribeCryptoBar(fn: BarListener): () => void {
  barListeners.add(fn);
  return () => {
    barListeners.delete(fn);
  };
}

export function subscribeCryptoQuote(fn: QuoteListener): () => void {
  quoteListeners.add(fn);
  return () => {
    quoteListeners.delete(fn);
  };
}

function notifyStatus(connected: boolean, reason?: string): void {
  sseConnected = connected;
  for (const fn of statusListeners) {
    try {
      fn(connected, reason);
    } catch {
      // ignore
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
      // ignore
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

  const qs = new URLSearchParams({ symbols: nextKey });
  const es = new EventSource(`/__api/crypto-stream?${qs.toString()}`);
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
        timeframe?: string;
        connected?: boolean;
        reason?: string;
        bar?: CryptoLiveBarEvent["bar"];
        bid?: number;
        ask?: number;
        last?: number;
        timestamp?: number;
      };

      if (payload.type === "status") {
        notifyStatus(Boolean(payload.connected), payload.reason);
        return;
      }

      if (payload.type === "bar" && payload.symbol && payload.bar) {
        reconnectAttempts = 0;
        if (!sseConnected) notifyStatus(true);
        const evt: CryptoLiveBarEvent = {
          symbol: payload.symbol,
          timeframe: payload.timeframe || "1m",
          bar: payload.bar,
        };
        for (const fn of barListeners) {
          try {
            fn(evt);
          } catch {
            // ignore
          }
        }
        return;
      }

      if (payload.type === "quote" && payload.symbol) {
        if (!sseConnected) notifyStatus(true);
        const evt: CryptoLiveQuoteEvent = {
          symbol: payload.symbol,
          bid: payload.bid,
          ask: payload.ask,
          last: payload.last,
          timestamp: typeof payload.timestamp === "number" ? payload.timestamp : Date.now(),
        };
        for (const fn of quoteListeners) {
          try {
            fn(evt);
          } catch {
            // ignore
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
 * Tracks a cryptocurrency symbol in the active crypto SSE stream using ref-counting.
 * Switching timeframes never restarts the stream.
 */
export function trackCryptoSymbol(symbol: string): () => void {
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
