import { publish } from "./bus.ts";
import {
  applyCryptoLiveBar,
  applyIbkrBar1s,
  getLatestRealStockTimestampMs,
  getSeedPrice,
  hasRealStockSeries,
  subscribeRealStockCandleQuote,
  updateLatestBarPrice,
  type IbkrLiveVwapState,
} from "./candles.ts";
import { isReplaySymbol, mark } from "./engine.ts";
import { DEMO_SYMBOLS, getDemoSymbol, subscribeSymbolsChanged } from "./instruments.ts";
import {
  isCryptoLiveStreamConnected,
  subscribeCryptoBar,
  subscribeCryptoQuote,
} from "../cryptoStream.ts";
import {
  isIbkrLiveStreamConnected,
  subscribeIbkr1sBar,
  subscribeIbkrQuote,
} from "../ibkrStream.ts";
import { getCachedIbkrConfigStatus } from "../ibkrConfig.ts";
import type { Candle } from "../schemas.ts";

/**
 * Market-data feed powered by Interactive Brokers (IBKR) for US Equities & Forex
 * and dedicated Crypto exchange streams for Cryptocurrencies & Perpetuals.
 */

const TICK_MS = 1000;
const STALE_AFTER_MS = 15_000;

type SymbolCursor = {
  symbol: string;
  price: number;
  anchorPrice: number;
  spread: number;
  bid?: number;
  ask?: number;
  lastQuoteAt: number;
  lastLiveAt: number;
  lastExchangeTs: number;
};

let timer: ReturnType<typeof setInterval> | null = null;
let unsub1sBar: (() => void) | null = null;
let unsubQuote: (() => void) | null = null;
let unsubCryptoBar: (() => void) | null = null;
let unsubCryptoQuote: (() => void) | null = null;
let cursors: SymbolCursor[] = [];
let cursorMap = new Map<string, SymbolCursor>();
let lastLivePriceAt = 0;

/** True when IBKR or Crypto stream is live or received a market update within the freshness window. */
export function isLiveFeedHealthy(): boolean {
  return (
    isIbkrLiveStreamConnected() ||
    getCachedIbkrConfigStatus()?.connectionState === "connected" ||
    isCryptoLiveStreamConnected() ||
    (lastLivePriceAt > 0 && Date.now() - lastLivePriceAt < STALE_AFTER_MS)
  );
}

function isStockSymbol(name: string): boolean {
  return (getDemoSymbol(name)?.category ?? "").toUpperCase() === "STOCKS";
}

function computeSpread(price: number, tickSize: number, isStock: boolean): number {
  const safeTick = tickSize > 0 && Number.isFinite(tickSize) ? tickSize : 0.01;
  const raw = price * 0.0001;
  if (isStock) {
    const steps = Math.max(1, Math.round(raw / safeTick));
    return Number((steps * safeTick).toFixed(6));
  }
  return Math.max(safeTick, raw);
}

function makeCursorForSymbol(name: string): SymbolCursor | null {
  const sym = getDemoSymbol(name);
  if (!sym) return null;
  const seed = getSeedPrice(sym.name) || sym.initialPrice || 1;
  const isStock = (sym.category ?? "").toUpperCase() === "STOCKS";
  return {
    symbol: sym.name,
    price: seed,
    anchorPrice: seed,
    spread: computeSpread(seed, sym.tickSize, isStock),
    lastQuoteAt: 0,
    lastLiveAt: 0,
    lastExchangeTs: getLatestRealStockTimestampMs(sym.name) ?? 0,
  };
}

function syncBidAskOnTrade(cur: SymbolCursor, price: number, now: number): void {
  const quoteStale = cur.lastQuoteAt > 0 && now - cur.lastQuoteAt > 3_000;
  const outsideBid = typeof cur.bid === "number" && price < cur.bid;
  const outsideAsk = typeof cur.ask === "number" && price > cur.ask;
  if (quoteStale || outsideBid || outsideAsk) {
    cur.bid = undefined;
    cur.ask = undefined;
  }
}

function syncCursors(): void {
  for (const s of DEMO_SYMBOLS) {
    if (!cursorMap.has(s.name)) {
      const c = makeCursorForSymbol(s.name);
      if (c) {
        cursors.push(c);
        cursorMap.set(s.name, c);
      }
    }
  }
}

subscribeSymbolsChanged(syncCursors);

function buildCursors(): SymbolCursor[] {
  cursorMap = new Map();
  const list: SymbolCursor[] = [];
  for (const s of DEMO_SYMBOLS) {
    const c = makeCursorForSymbol(s.name);
    if (c) {
      list.push(c);
      cursorMap.set(s.name, c);
    }
  }
  return list;
}

function findCursor(symbol: string): SymbolCursor | undefined {
  const upper = symbol.trim().toUpperCase();
  return cursorMap.get(symbol) ?? cursorMap.get(upper) ?? cursors.find((c) => c.symbol.toUpperCase() === upper);
}

function emitTick(cursor: SymbolCursor, occurredAtOverride?: number): void {
  if (!(cursor.price > 0) || isReplaySymbol(cursor.symbol)) return;
  const half = cursor.spread / 2;
  const bid =
    typeof cursor.bid === "number" && Number.isFinite(cursor.bid) && cursor.bid > 0
      ? cursor.bid
      : cursor.price - half;
  const ask =
    typeof cursor.ask === "number" && Number.isFinite(cursor.ask) && cursor.ask > 0
      ? cursor.ask
      : cursor.price + half;
  publish("market-data", {
    eventType: "MarketTick",
    symbol: cursor.symbol,
    bid,
    ask,
    occurredAt: occurredAtOverride ?? Date.now(),
  });
  mark(cursor.symbol, cursor.price);
}

function publishUpdatedCandles(
  targetSym: string,
  updatedBars: Array<{ timeframe: string; candle: Candle; isNewBucket?: boolean }>,
): void {
  if (isReplaySymbol(targetSym)) return;
  for (const { timeframe, candle, isNewBucket } of updatedBars) {
    if (isNewBucket) {
      publish("market-data", {
        eventType: "CandleClosed",
        symbol: targetSym,
        timeframe,
      });
    }
    publish("market-data", {
      eventType: "CandleUpdate",
      symbol: targetSym,
      timeframe,
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
      volume: candle.volume ?? 0,
      timestamp: candle.time,
    });
  }
}

/** Applies a real-time 1-minute cryptocurrency bar across all active timeframes & engine marks. */
export function applyCryptoLiveBarUpdate(symbol: string, bar1m: Candle): void {
  if (!Number.isFinite(bar1m.close) || bar1m.close <= 0) return;
  if (cursors.length === 0) cursors = buildCursors();
  syncCursors();

  const upperSym = symbol.trim().toUpperCase();
  const sym = getDemoSymbol(upperSym);
  const cur = findCursor(upperSym);
  const now = Date.now();
  lastLivePriceAt = now;

  if (sym && !sym.isDominanceIndex) {
    sym.initialPrice = bar1m.close;
  }

  const targetSym = cur?.symbol ?? upperSym;
  if (cur) {
    cur.price = bar1m.close;
    cur.anchorPrice = bar1m.close;
    syncBidAskOnTrade(cur, bar1m.close, now);
    cur.spread = computeSpread(bar1m.close, sym?.tickSize ?? 0.01, false);
    cur.lastLiveAt = now;
    cur.lastExchangeTs = Math.max(cur.lastExchangeTs, now);
    emitTick(cur, now);
  } else {
    mark(targetSym, bar1m.close);
  }

  const updatedBars = applyCryptoLiveBar(targetSym, bar1m);
  publishUpdatedCandles(targetSym, updatedBars);
}

/** Applies a real-time 1-second IBKR base bar across all active timeframes & engine marks. */
export function applyIbkrLiveBar1sUpdate(
  symbol: string,
  bar1s: Candle,
  vwapState?: IbkrLiveVwapState,
): void {
  if (!Number.isFinite(bar1s.close) || bar1s.close <= 0) return;
  if (cursors.length === 0) cursors = buildCursors();
  syncCursors();

  const upperSym = symbol.trim().toUpperCase();
  const sym = getDemoSymbol(upperSym);
  const cur = findCursor(upperSym);
  const tsMs = (Math.floor(bar1s.time) + 1) * 1000;
  const now = Date.now();
  lastLivePriceAt = now;

  if (sym && !sym.isDominanceIndex) {
    sym.initialPrice = bar1s.close;
  }

  const targetSym = cur?.symbol ?? upperSym;
  if (cur) {
    cur.price = bar1s.close;
    cur.anchorPrice = bar1s.close;
    syncBidAskOnTrade(cur, bar1s.close, now);
    cur.spread = computeSpread(bar1s.close, sym?.tickSize ?? 0.01, isStockSymbol(targetSym));
    cur.lastLiveAt = now;
    cur.lastExchangeTs = Math.max(cur.lastExchangeTs, tsMs);
    emitTick(cur, tsMs);
  } else {
    mark(targetSym, bar1s.close);
  }

  const updatedBars = applyIbkrBar1s(targetSym, bar1s, vwapState);
  publishUpdatedCandles(targetSym, updatedBars);
}

/** Applies a consolidated IBKR L1 quote snapshot (`bid`, `ask`, `last`) without phantom ticks. */
export function applyIbkrQuoteUpdate(evt: {
  symbol: string;
  bid?: number;
  ask?: number;
  last?: number;
  timestamp: number;
}): void {
  const upperSym = evt.symbol.trim().toUpperCase();
  if (cursors.length === 0) cursors = buildCursors();
  syncCursors();
  const sym = getDemoSymbol(upperSym);
  const cur = findCursor(upperSym);
  const isStock = isStockSymbol(upperSym);
  const bid = typeof evt.bid === "number" && Number.isFinite(evt.bid) && evt.bid > 0 ? evt.bid : undefined;
  const ask = typeof evt.ask === "number" && Number.isFinite(evt.ask) && evt.ask > 0 ? evt.ask : undefined;
  const hasLast = typeof evt.last === "number" && Number.isFinite(evt.last) && evt.last > 0;
  const mid = bid && ask ? (bid + ask) / 2 : undefined;
  // For US Stocks, preserve authoritative IBKR TRADES `last` / candle `close` instead of overwriting
  // `cur.price` with wide Bid/Ask midpoints whenever a real trade price is already known.
  const hasKnownStockTradePrice = isStock && Boolean(cur && cur.lastExchangeTs > 0 && cur.price > 0);
  const refPrice = hasLast
    ? evt.last
    : hasKnownStockTradePrice
      ? cur!.price
      : mid;
  const now = Date.now();
  lastLivePriceAt = now;

  if (!refPrice) return;
  if (sym && !sym.isDominanceIndex && (hasLast || !hasKnownStockTradePrice)) {
    sym.initialPrice = refPrice;
  }

  if (cur) {
    cur.price = refPrice;
    cur.anchorPrice = refPrice;
    if (bid !== undefined) cur.bid = bid;
    if (ask !== undefined) cur.ask = ask;
    if (bid !== undefined || ask !== undefined) cur.lastQuoteAt = now;
    cur.spread = bid && ask && ask > bid ? ask - bid : computeSpread(refPrice, sym?.tickSize ?? 0.01, isStock);
    cur.lastLiveAt = now;
    cur.lastExchangeTs = Math.max(cur.lastExchangeTs, evt.timestamp || now);
    emitTick(cur, evt.timestamp || now);
  } else {
    mark(upperSym, refPrice);
  }
}

export function startDemoFeed(): void {
  if (timer) return;
  cursors = buildCursors();
  for (const c of cursors) {
    if (isStockSymbol(c.symbol) && c.lastExchangeTs <= 0 && !hasRealStockSeries(c.symbol)) {
      continue;
    }
    emitTick(c, c.lastExchangeTs > 0 ? c.lastExchangeTs : undefined);
  }

  if (!unsub1sBar) {
    unsub1sBar = subscribeIbkr1sBar((evt) => {
      applyIbkrLiveBar1sUpdate(evt.symbol, evt.bar, evt.vwap);
    });
  }
  if (!unsubQuote) {
    unsubQuote = subscribeIbkrQuote((evt) => {
      applyIbkrQuoteUpdate(evt);
    });
  }
  if (!unsubCryptoBar) {
    unsubCryptoBar = subscribeCryptoBar((evt) => {
      applyCryptoLiveBarUpdate(evt.symbol, evt.bar);
    });
  }
  if (!unsubCryptoQuote) {
    unsubCryptoQuote = subscribeCryptoQuote((evt) => {
      applyIbkrQuoteUpdate(evt);
    });
  }

  timer = setInterval(() => {
    syncCursors();
    for (const c of cursors) {
      const isStock = isStockSymbol(c.symbol);
      // Do NOT broadcast hardcoded DEMO_SYMBOLS placeholder prices for US Equities before IBKR loads.
      if (isStock && c.lastExchangeTs <= 0 && c.lastLiveAt <= 0 && !hasRealStockSeries(c.symbol)) {
        continue;
      }
      const sym = getDemoSymbol(c.symbol);
      if (sym?.initialPrice && Number.isFinite(sym.initialPrice) && sym.initialPrice > 0) {
        c.anchorPrice = sym.initialPrice;
        if (c.lastLiveAt === 0) {
          c.price = sym.initialPrice;
          c.spread =
            c.bid && c.ask && c.ask > c.bid
              ? c.ask - c.bid
              : computeSpread(sym.initialPrice, sym.tickSize ?? 0.01, isStock);
        }
      }
      if (c.price > 0 && !isReplaySymbol(c.symbol)) {
        mark(c.symbol, c.price);
      }
      // Only emit ticks when backed by a real exchange timestamp or live update so quiet/Forex
      // instruments never synthesize phantom zero-volume future candles with Date.now().
      if (c.lastExchangeTs > 0 || c.lastLiveAt > 0) {
        emitTick(c, c.lastExchangeTs > 0 ? c.lastExchangeTs : c.lastLiveAt);
      }
    }
  }, TICK_MS);
}

export function stopDemoFeed(): void {
  if (timer) clearInterval(timer);
  timer = null;
  if (unsub1sBar) {
    unsub1sBar();
    unsub1sBar = null;
  }
  if (unsubQuote) {
    unsubQuote();
    unsubQuote = null;
  }
  if (unsubCryptoBar) {
    unsubCryptoBar();
    unsubCryptoBar = null;
  }
  if (unsubCryptoQuote) {
    unsubCryptoQuote();
    unsubCryptoQuote = null;
  }
}

export function resyncLiveTick(symbol: string): void {
  if (cursors.length === 0) cursors = buildCursors();
  syncCursors();
  const cur = findCursor(symbol);
  if (!cur) return;
  const sym = getDemoSymbol(cur.symbol);
  if (!(cur.price > 0) && sym?.initialPrice && sym.initialPrice > 0) {
    cur.price = sym.initialPrice;
    cur.anchorPrice = sym.initialPrice;
  }
  emitTick(cur, cur.lastExchangeTs > 0 ? cur.lastExchangeTs : undefined);
}

export function syncCursorPrice(symbol: string, price: number, occurredAtMs?: number): void {
  if (!Number.isFinite(price) || price <= 0) return;
  if (cursors.length === 0 && timer) cursors = buildCursors();
  syncCursors();
  const sym = getDemoSymbol(symbol);
  if (sym && !sym.isDominanceIndex) {
    sym.initialPrice = price;
  }
  const cur = findCursor(symbol);
  const isStock = (sym?.category ?? "").toUpperCase() === "STOCKS";
  if (cur) {
    cur.price = price;
    cur.anchorPrice = price;
    syncBidAskOnTrade(cur, price, Date.now());
    cur.spread = computeSpread(price, sym?.tickSize ?? 0.01, isStock);
    const realTs =
      typeof occurredAtMs === "number" && Number.isFinite(occurredAtMs) && occurredAtMs > 0
        ? occurredAtMs
        : (getLatestRealStockTimestampMs(symbol) ?? cur.lastExchangeTs);
    if (realTs > 0) {
      cur.lastExchangeTs = Math.max(cur.lastExchangeTs, realTs);
      updateLatestBarPrice(cur.symbol, price, cur.lastExchangeTs);
      emitTick(cur, cur.lastExchangeTs);
    } else {
      mark(cur.symbol, price);
    }
  } else {
    mark(symbol, price);
  }
}

/** Applies a real-time exchange trade print (from IBKR tick stream) immediately. */
export function applyLiveStockTrade(
  symbol: string,
  price: number,
  timestampMs: number,
  tradeSize = 0,
): void {
  if (!Number.isFinite(price) || price <= 0) return;
  const ts =
    typeof timestampMs === "number" && Number.isFinite(timestampMs) && timestampMs > 0
      ? timestampMs
      : Date.now();
  if (cursors.length === 0) cursors = buildCursors();
  syncCursors();

  const upperSym = symbol.trim().toUpperCase();
  const sym = getDemoSymbol(symbol);
  const cur = findCursor(upperSym);
  const latestKnownTs = Math.max(
    cur?.lastExchangeTs ?? 0,
    getLatestRealStockTimestampMs(upperSym) ?? 0,
  );
  if (latestKnownTs > 0 && ts < latestKnownTs) return;

  if (sym && !sym.isDominanceIndex) {
    sym.initialPrice = price;
  }
  const now = Date.now();
  lastLivePriceAt = now;
  const targetSym = cur?.symbol ?? symbol;
  if (cur) {
    cur.price = price;
    cur.anchorPrice = price;
    syncBidAskOnTrade(cur, price, now);
    cur.spread = computeSpread(
      price,
      sym?.tickSize ?? 0.01,
      (sym?.category ?? "").toUpperCase() === "STOCKS",
    );
    cur.lastLiveAt = now;
    cur.lastExchangeTs = ts;
    const updatedBars = updateLatestBarPrice(cur.symbol, price, ts, tradeSize);
    emitTick(cur, ts);
    publishUpdatedCandles(targetSym, updatedBars);
  } else {
    const updatedBars = updateLatestBarPrice(symbol, price, ts, tradeSize);
    mark(symbol, price);
    publishUpdatedCandles(targetSym, updatedBars);
  }
}

subscribeRealStockCandleQuote((symbol, price, timestampMs) => {
  const cur = findCursor(symbol);
  if (cur && cur.lastLiveAt > 0 && Date.now() - cur.lastLiveAt < 5_000 && cur.lastExchangeTs >= timestampMs) {
    return;
  }
  syncCursorPrice(symbol, price, timestampMs);
});
