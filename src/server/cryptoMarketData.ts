import {
  aggregateCandles,
  getBucketStartSec,
  parseTimeframeSeconds,
  type OhlcvBar,
} from "../lib/timeframes.ts";

export interface CryptoCandlesResponse {
  symbol: string;
  timeframe: string;
  candles: OhlcvBar[];
  regularMarketPrice: number | null;
  exchangeTimezoneName: "UTC";
  dataSource: string;
}

export interface CryptoSearchItem {
  ticker: string;
  displayName: string;
  category: "CRYPTO" | "FUTURES";
  exchange: string;
  currency: string;
  isPerpetual: boolean;
  initialPrice?: number;
}

export interface CryptoStreamEvent {
  type: "status" | "bar" | "quote";
  symbol?: string;
  timeframe?: string;
  connected?: boolean;
  reason?: string;
  bar?: OhlcvBar;
  bid?: number;
  ask?: number;
  last?: number;
  timestamp?: number;
}

const BINANCE_SPOT_BASE = "https://data-api.binance.vision";
const BINANCE_FUTURES_BASE = "https://fapi.binance.com";
const KRAKEN_BASE = "https://api.kraken.com";
const COINBASE_BASE = "https://api.exchange.coinbase.com";
const COINGECKO_BASE = "https://api.coingecko.com/api/v3";

const HTTP_HEADERS: Record<string, string> = {
  Accept: "application/json",
};
const COINBASE_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  Accept: "application/json",
};

const BINANCE_NATIVE_INTERVALS: ReadonlyArray<{ sec: number; interval: string }> = [
  { sec: 1, interval: "1s" },
  { sec: 60, interval: "1m" },
  { sec: 180, interval: "3m" },
  { sec: 300, interval: "5m" },
  { sec: 900, interval: "15m" },
  { sec: 1800, interval: "30m" },
  { sec: 3600, interval: "1h" },
  { sec: 7200, interval: "2h" },
  { sec: 14400, interval: "4h" },
  { sec: 28800, interval: "8h" },
  { sec: 86400, interval: "1d" },
  { sec: 604800, interval: "1w" },
];

const KRAKEN_INTERVALS_MIN = [1, 5, 15, 30, 60, 240, 1440, 10080] as const;
const COINBASE_GRANULARITIES = [60, 300, 900, 3600, 21600, 86400] as const;

export interface ParsedCryptoSymbol {
  canonical: string;
  base: string;
  quote: "USD" | "USDT" | "EUR";
  isPerpetual: boolean;
  isDominance: boolean;
  binanceSymbol: string;
  krakenPair: string;
  coinbaseProduct: string;
}

export function parseCryptoSymbol(rawSymbol: string): ParsedCryptoSymbol {
  const upper = rawSymbol.trim().toUpperCase();
  if (upper === "BTC.D" || upper === "BTCD") {
    return {
      canonical: "BTC.D",
      base: "BTC",
      quote: "USD",
      isPerpetual: false,
      isDominance: true,
      binanceSymbol: "BTCUSDT",
      krakenPair: "XBTUSD",
      coinbaseProduct: "BTC-USD",
    };
  }

  const perpMatch =
    /^([A-Z0-9]{2,16})USDT\.P$/.exec(upper) ??
    /^([A-Z0-9]{2,16})USDTPERP$/.exec(upper) ??
    /^([A-Z0-9]{2,16})-PERP$/.exec(upper);
  if (perpMatch) {
    const base = perpMatch[1]!;
    return {
      canonical: `${base}USDT.P`,
      base,
      quote: "USDT",
      isPerpetual: true,
      isDominance: false,
      binanceSymbol: `${base}USDT`,
      krakenPair: `${base === "BTC" ? "XBT" : base}USD`,
      coinbaseProduct: `${base}-USD`,
    };
  }

  const compact = upper.replace(/[\s/_-]+/g, "");
  let base = compact;
  let quote: "USD" | "USDT" | "EUR" = "USD";
  if (compact.endsWith("USDT") && compact.length > 4) {
    base = compact.slice(0, -4);
    quote = "USDT";
  } else if (compact.endsWith("EUR") && compact.length > 3) {
    base = compact.slice(0, -3);
    quote = "EUR";
  } else if (compact.endsWith("USD") && compact.length > 3) {
    base = compact.slice(0, -3);
    quote = "USD";
  }

  const binanceQuote = quote === "EUR" ? "EUR" : "USDT";
  const krakenBase = base === "BTC" ? "XBT" : base === "DOGE" ? "XDG" : base;
  const krakenQuote = quote === "EUR" ? "EUR" : "USD";
  const coinbaseQuote = quote === "EUR" ? "EUR" : "USD";

  return {
    canonical: quote === "EUR" ? `${base}EUR` : `${base}USD`,
    base,
    quote,
    isPerpetual: false,
    isDominance: false,
    binanceSymbol: `${base}${binanceQuote}`,
    krakenPair: `${krakenBase}${krakenQuote}`,
    coinbaseProduct: `${base}-${coinbaseQuote}`,
  };
}

export function resolveBinanceInterval(
  timeframe: string,
  isFutures: boolean,
): { interval: string; nativeSec: number; targetSec: number; requiresResample: boolean } {
  const targetSec = parseTimeframeSeconds(timeframe);
  const supported = isFutures
    ? BINANCE_NATIVE_INTERVALS.filter((x) => x.sec >= 60)
    : BINANCE_NATIVE_INTERVALS;

  let chosen = supported[0]!;
  for (const candidate of supported) {
    if (candidate.sec <= targetSec && targetSec % candidate.sec === 0) {
      chosen = candidate;
    }
  }
  if (targetSec % chosen.sec !== 0) {
    chosen = supported.find((x) => x.sec === 60) ?? supported[0]!;
  }

  return {
    interval: chosen.interval,
    nativeSec: chosen.sec,
    targetSec,
    requiresResample: chosen.sec !== targetSec,
  };
}

function parseBinanceKlines(raw: unknown): OhlcvBar[] {
  if (!Array.isArray(raw)) return [];
  const out: OhlcvBar[] = [];
  for (const row of raw) {
    if (!Array.isArray(row) || row.length < 6) continue;
    const openTimeMs = Number(row[0]);
    const open = Number(row[1]);
    const high = Number(row[2]);
    const low = Number(row[3]);
    const close = Number(row[4]);
    const volume = Number(row[5]);
    if (
      !Number.isFinite(openTimeMs) ||
      !Number.isFinite(open) ||
      !Number.isFinite(high) ||
      !Number.isFinite(low) ||
      !Number.isFinite(close) ||
      close <= 0
    ) {
      continue;
    }
    out.push({
      time: Math.floor(openTimeMs / 1000),
      open,
      high: Math.max(high, open, close),
      low: Math.min(low, open, close),
      close,
      volume: Number.isFinite(volume) && volume >= 0 ? volume : 0,
    });
  }
  out.sort((a, b) => a.time - b.time);
  return out;
}

interface CatalogEntry {
  ticker: string;
  base: string;
  quote: string;
  displayName: string;
  category: "CRYPTO" | "FUTURES";
  exchange: string;
  isPerpetual: boolean;
}

interface ActiveCryptoSub {
  symbol: string;
  parsed: ParsedCryptoSymbol;
  refs: number;
  listeners: Set<(evt: CryptoStreamEvent) => void>;
  timer: ReturnType<typeof setInterval> | null;
  lastBar1m: OhlcvBar | null;
  lastQuotePrice: number | null;
}

export class CryptoMarketDataService {
  private readonly fetchImpl: typeof fetch;
  private readonly candleCache = new Map<string, { at: number; result: CryptoCandlesResponse }>();
  private readonly inFlight = new Map<string, Promise<CryptoCandlesResponse>>();
  private readonly subs = new Map<string, ActiveCryptoSub>();
  private catalogCache: { at: number; items: CatalogEntry[] } | null = null;
  private btcDominanceCache: { at: number; pct: number } | null = null;

  constructor(opts?: { fetchImpl?: typeof fetch }) {
    this.fetchImpl = opts?.fetchImpl ?? globalThis.fetch;
  }

  dispose(): void {
    for (const sub of this.subs.values()) {
      if (sub.timer) clearInterval(sub.timer);
      sub.listeners.clear();
    }
    this.subs.clear();
    this.candleCache.clear();
    this.inFlight.clear();
  }

  async getHistoricalCandles(
    symbol: string,
    timeframe: string,
    minBars = 1000,
    signal?: AbortSignal,
    targetDate?: string,
  ): Promise<CryptoCandlesResponse> {
    const parsed = parseCryptoSymbol(symbol);
    const safeMinBars = Math.max(100, Math.min(3500, Math.round(minBars || 1000)));
    const cleanTargetDate =
      typeof targetDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(targetDate.trim())
        ? targetDate.trim()
        : undefined;
    const targetEndSec = cleanTargetDate
      ? (() => {
          const [yStr, mStr, dStr] = cleanTargetDate.split("-");
          const endUtcSec = Math.floor(
            Date.UTC(Number(yStr), Number(mStr) - 1, Number(dStr) + 1, 4, 59, 59) / 1000,
          );
          return Math.min(endUtcSec, Math.floor(Date.now() / 1000));
        })()
      : undefined;
    const targetEndMs = targetEndSec !== undefined ? targetEndSec * 1000 : undefined;
    const cacheKey = `${parsed.canonical}|${timeframe}|${safeMinBars}|${cleanTargetDate ?? "live"}`;

    const cached = this.candleCache.get(cacheKey);
    if (cached && Date.now() - cached.at < (cleanTargetDate ? 300_000 : 4_000)) {
      return cached.result;
    }

    const existing = this.inFlight.get(cacheKey);
    if (existing) return existing;

    const promise = (async (): Promise<CryptoCandlesResponse> => {
      if (parsed.isDominance) {
        const res = await this.fetchBtcDominanceCandles(timeframe, safeMinBars, signal, targetEndMs);
        this.storeCandleCache(cacheKey, res);
        return res;
      }

      const plan = resolveBinanceInterval(timeframe, parsed.isPerpetual);
      const nativeBarsNeeded = Math.min(
        3500,
        Math.ceil(safeMinBars * (plan.targetSec / plan.nativeSec)),
      );

      // 1. Primary: Binance Public Spot or USD-M Futures API
      try {
        const raw = await this.fetchBinanceKlinesPaginated(
          parsed.binanceSymbol,
          plan.interval,
          nativeBarsNeeded,
          parsed.isPerpetual,
          signal,
          targetEndMs,
        );
        if (raw.length > 0) {
          const candles = plan.requiresResample
            ? aggregateCandles(raw, plan.targetSec)
            : raw;
          const res: CryptoCandlesResponse = {
            symbol: parsed.canonical,
            timeframe,
            candles,
            regularMarketPrice: candles[candles.length - 1]?.close ?? null,
            exchangeTimezoneName: "UTC",
            dataSource: parsed.isPerpetual ? "binance-futures" : "binance-spot",
          };
          this.storeCandleCache(cacheKey, res);
          return res;
        }
      } catch {
        // fall through to secondary exchanges
      }

      // 2. Fallback A: Kraken Public OHLC API (only when not requesting a distant targetDate)
      if (!cleanTargetDate) {
        try {
          const krakenBars = await this.fetchKrakenOhlc(parsed.krakenPair, plan.targetSec, signal);
          if (krakenBars.length > 0) {
            const candles = aggregateCandles(krakenBars, plan.targetSec);
            const res: CryptoCandlesResponse = {
              symbol: parsed.canonical,
              timeframe,
              candles,
              regularMarketPrice: candles[candles.length - 1]?.close ?? null,
              exchangeTimezoneName: "UTC",
              dataSource: "kraken",
            };
            this.storeCandleCache(cacheKey, res);
            return res;
          }
        } catch {
          // fall through to Coinbase
        }
      }

      // 3. Fallback B: Coinbase Exchange Public Candles API
      const cbBars = await this.fetchCoinbaseCandles(
        parsed.coinbaseProduct,
        plan.targetSec,
        signal,
        targetEndSec,
      );
      if (cbBars.length > 0) {
        const candles = aggregateCandles(cbBars, plan.targetSec);
        const res: CryptoCandlesResponse = {
          symbol: parsed.canonical,
          timeframe,
          candles,
          regularMarketPrice: candles[candles.length - 1]?.close ?? null,
          exchangeTimezoneName: "UTC",
          dataSource: "coinbase",
        };
        this.storeCandleCache(cacheKey, res);
        return res;
      }

      throw new Error(`No se encontraron velas cripto para ${parsed.canonical}`);
    })().finally(() => {
      if (this.inFlight.get(cacheKey) === promise) {
        this.inFlight.delete(cacheKey);
      }
    });

    this.inFlight.set(cacheKey, promise);
    return promise;
  }

  private storeCandleCache(key: string, result: CryptoCandlesResponse): void {
    if (this.candleCache.size >= 80) {
      const oldest = this.candleCache.keys().next().value;
      if (oldest !== undefined) this.candleCache.delete(oldest);
    }
    this.candleCache.set(key, { at: Date.now(), result });
  }

  private async fetchBinanceKlinesPaginated(
    binanceSymbol: string,
    interval: string,
    totalWanted: number,
    isFutures: boolean,
    signal?: AbortSignal,
    endTimeMsOverride?: number,
  ): Promise<OhlcvBar[]> {
    const base = isFutures ? BINANCE_FUTURES_BASE : BINANCE_SPOT_BASE;
    const path = isFutures ? "/fapi/v1/klines" : "/api/v3/klines";
    const maxPerReq = isFutures ? 1500 : 1000;
    const merged = new Map<number, OhlcvBar>();
    let cursorEndMs = endTimeMsOverride;

    for (let page = 0; page < 4 && merged.size < totalWanted; page++) {
      const reqLimit = Math.min(maxPerReq, Math.max(100, totalWanted - merged.size));
      const endParam =
        typeof cursorEndMs === "number" && Number.isFinite(cursorEndMs) && cursorEndMs > 0
          ? `&endTime=${Math.floor(cursorEndMs)}`
          : "";
      const url = `${base}${path}?symbol=${encodeURIComponent(binanceSymbol)}&interval=${encodeURIComponent(interval)}&limit=${reqLimit}${endParam}`;
      const res = await this.fetchImpl(url, { headers: HTTP_HEADERS, signal });
      if (!res.ok) {
        if (page === 0) {
          throw new Error(`Binance ${isFutures ? "Futures" : "Spot"} HTTP ${res.status}`);
        }
        break;
      }
      const batch = parseBinanceKlines(await res.json());
      if (batch.length === 0) break;
      for (const b of batch) merged.set(b.time, b);
      if (batch.length < reqLimit) break;
      cursorEndMs = batch[0]!.time * 1000 - 1;
    }

    return Array.from(merged.values()).sort((a, b) => a.time - b.time);
  }

  private async fetchKrakenOhlc(
    krakenPair: string,
    targetSec: number,
    signal?: AbortSignal,
  ): Promise<OhlcvBar[]> {
    const targetMin = Math.max(1, Math.floor(targetSec / 60));
    let chosenMin = 1;
    for (const m of KRAKEN_INTERVALS_MIN) {
      if (m <= targetMin && targetMin % m === 0) chosenMin = m;
    }
    const url = `${KRAKEN_BASE}/0/public/OHLC?pair=${encodeURIComponent(krakenPair)}&interval=${chosenMin}`;
    const res = await this.fetchImpl(url, { headers: HTTP_HEADERS, signal });
    if (!res.ok) throw new Error(`Kraken HTTP ${res.status}`);
    const data = (await res.json()) as { error?: string[]; result?: Record<string, unknown> };
    if (Array.isArray(data.error) && data.error.length > 0) {
      throw new Error(data.error.join("; "));
    }
    const resultObj = data.result ?? {};
    const pairKey = Object.keys(resultObj).find((k) => k !== "last");
    const rows = pairKey ? resultObj[pairKey] : null;
    if (!Array.isArray(rows)) return [];
    const out: OhlcvBar[] = [];
    for (const r of rows) {
      if (!Array.isArray(r) || r.length < 7) continue;
      const time = Number(r[0]);
      const open = Number(r[1]);
      const high = Number(r[2]);
      const low = Number(r[3]);
      const close = Number(r[4]);
      const volume = Number(r[6]);
      if (!Number.isFinite(time) || !Number.isFinite(close) || close <= 0) continue;
      out.push({
        time: Math.floor(time),
        open,
        high: Math.max(high, open, close),
        low: Math.min(low, open, close),
        close,
        volume: Number.isFinite(volume) && volume >= 0 ? volume : 0,
      });
    }
    out.sort((a, b) => a.time - b.time);
    return out;
  }

  private async fetchCoinbaseCandles(
    product: string,
    targetSec: number,
    signal?: AbortSignal,
    endSecOverride?: number,
  ): Promise<OhlcvBar[]> {
    let gran = 60;
    for (const g of COINBASE_GRANULARITIES) {
      if (g <= targetSec && targetSec % g === 0) gran = g;
    }
    const rangeParams =
      typeof endSecOverride === "number" && Number.isFinite(endSecOverride) && endSecOverride > 0
        ? `&start=${encodeURIComponent(new Date((endSecOverride - gran * 299) * 1000).toISOString())}&end=${encodeURIComponent(new Date(endSecOverride * 1000).toISOString())}`
        : "";
    const url = `${COINBASE_BASE}/products/${encodeURIComponent(product)}/candles?granularity=${gran}${rangeParams}`;
    const res = await this.fetchImpl(url, { headers: COINBASE_HEADERS, signal });
    if (!res.ok) throw new Error(`Coinbase HTTP ${res.status}`);
    const rows = (await res.json()) as unknown;
    if (!Array.isArray(rows)) return [];
    const out: OhlcvBar[] = [];
    for (const r of rows) {
      if (!Array.isArray(r) || r.length < 6) continue;
      const time = Number(r[0]);
      const low = Number(r[1]);
      const high = Number(r[2]);
      const open = Number(r[3]);
      const close = Number(r[4]);
      const volume = Number(r[5]);
      if (!Number.isFinite(time) || !Number.isFinite(close) || close <= 0) continue;
      out.push({
        time: Math.floor(time),
        open,
        high: Math.max(high, open, close),
        low: Math.min(low, open, close),
        close,
        volume: Number.isFinite(volume) && volume >= 0 ? volume : 0,
      });
    }
    out.sort((a, b) => a.time - b.time);
    return out;
  }

  private async fetchLiveBtcDominancePct(signal?: AbortSignal): Promise<number> {
    if (this.btcDominanceCache && Date.now() - this.btcDominanceCache.at < 120_000) {
      return this.btcDominanceCache.pct;
    }
    try {
      const res = await this.fetchImpl(`${COINGECKO_BASE}/global`, {
        headers: HTTP_HEADERS,
        signal,
      });
      if (res.ok) {
        const json = (await res.json()) as {
          data?: { market_cap_percentage?: { btc?: number } };
        };
        const btcPct = json?.data?.market_cap_percentage?.btc;
        if (typeof btcPct === "number" && Number.isFinite(btcPct) && btcPct > 10 && btcPct < 95) {
          this.btcDominanceCache = { at: Date.now(), pct: btcPct };
          return btcPct;
        }
      }
    } catch {
      // fall through
    }
    return this.btcDominanceCache?.pct ?? 58.5;
  }

  /**
   * Computes a live-anchored Bitcoin Dominance (BTC.D %) OHLC series using CoinGecko's
   * live dominance percentage + Binance BTCUSDT / ETHUSDT relative strength curve.
   */
  private async fetchBtcDominanceCandles(
    timeframe: string,
    minBars: number,
    signal?: AbortSignal,
    targetEndMs?: number,
  ): Promise<CryptoCandlesResponse> {
    const plan = resolveBinanceInterval(timeframe, false);
    const needed = Math.min(1000, Math.ceil(minBars * (plan.targetSec / plan.nativeSec)));
    const [liveDomPct, btcBars, ethBars] = await Promise.all([
      this.fetchLiveBtcDominancePct(signal),
      this.fetchBinanceKlinesPaginated("BTCUSDT", plan.interval, needed, false, signal, targetEndMs).catch(() =>
        this.fetchKrakenOhlc("XBTUSD", plan.targetSec, signal),
      ),
      this.fetchBinanceKlinesPaginated("ETHUSDT", plan.interval, needed, false, signal, targetEndMs).catch(() =>
        this.fetchKrakenOhlc("ETHUSD", plan.targetSec, signal).catch(() => [] as OhlcvBar[]),
      ),
    ]);

    const ethByTime = new Map(ethBars.map((b) => [b.time, b]));
    const rawRatios: Array<{ time: number; o: number; h: number; l: number; c: number; v: number }> = [];
    for (const b of btcBars) {
      const e = ethByTime.get(b.time);
      if (!e || e.close <= 0) continue;
      const o = b.open / Math.max(1e-8, e.open);
      const c = b.close / e.close;
      const h = Math.max(o, c, b.high / Math.max(1e-8, e.low));
      const l = Math.min(o, c, b.low / Math.max(1e-8, e.high));
      rawRatios.push({ time: b.time, o, h, l, c, v: b.volume });
    }

    const latestRatio = rawRatios[rawRatios.length - 1]?.c ?? 1;
    // Calibrate dominance movement gently around live CoinGecko BTC.D %
    const calibrated: OhlcvBar[] = rawRatios.map((r) => {
      const scaleVal = (val: number) => {
        const rel = latestRatio > 0 ? (val - latestRatio) / latestRatio : 0;
        return Number(Math.max(20, Math.min(85, liveDomPct * (1 + rel * 0.35))).toFixed(2));
      };
      const open = scaleVal(r.o);
      const close = scaleVal(r.c);
      const high = Math.max(open, close, scaleVal(r.h));
      const low = Math.min(open, close, scaleVal(r.l));
      return { time: r.time, open, high, low, close, volume: Math.round(r.v) };
    });

    const candles = plan.requiresResample ? aggregateCandles(calibrated, plan.targetSec) : calibrated;
    return {
      symbol: "BTC.D",
      timeframe,
      candles,
      regularMarketPrice: Number(liveDomPct.toFixed(2)),
      exchangeTimezoneName: "UTC",
      dataSource: "coingecko+binance",
    };
  }

  /** Searches live Binance Spot & USD-M Futures pairs matching `query`. */
  async searchSymbols(query: string, limit = 30): Promise<CryptoSearchItem[]> {
    const q = query.trim().toUpperCase().replace(/[\s/_-]+/g, "");
    if (!q) return [];

    const catalog = await this.getCatalog();
    const scored: Array<{ item: CatalogEntry; score: number }> = [];
    for (const entry of catalog) {
      const t = entry.ticker.toUpperCase();
      const b = entry.base.toUpperCase();
      let score = 0;
      if (t === q || b === q) score = 1000;
      else if (t.startsWith(q) || b.startsWith(q)) score = 700;
      else if (t.includes(q) || b.includes(q)) score = 400;
      if (score > 0) {
        if (!entry.isPerpetual && entry.quote === "USD") score += 20;
        scored.push({ item: entry, score });
      }
    }
    scored.sort((a, b) => b.score - a.score || a.item.ticker.localeCompare(b.item.ticker));

    return scored.slice(0, limit).map(({ item }) => ({
      ticker: item.ticker,
      displayName: item.displayName,
      category: item.category,
      exchange: item.exchange,
      currency: item.quote,
      isPerpetual: item.isPerpetual,
    }));
  }

  private async getCatalog(): Promise<CatalogEntry[]> {
    if (this.catalogCache && Date.now() - this.catalogCache.at < 10 * 60_000) {
      return this.catalogCache.items;
    }

    const items: CatalogEntry[] = [];
    const seen = new Set<string>();

    const [spotRes, futRes] = await Promise.all([
      this.fetchImpl(`${BINANCE_SPOT_BASE}/api/v3/exchangeInfo`, {
        headers: HTTP_HEADERS,
        signal: AbortSignal.timeout(8_000),
      }).catch(() => null),
      this.fetchImpl(`${BINANCE_FUTURES_BASE}/fapi/v1/exchangeInfo`, {
        headers: HTTP_HEADERS,
        signal: AbortSignal.timeout(8_000),
      }).catch(() => null),
    ]);

    if (spotRes?.ok) {
      try {
        const data = (await spotRes.json()) as {
          symbols?: Array<{
            symbol?: string;
            status?: string;
            baseAsset?: string;
            quoteAsset?: string;
          }>;
        };
        for (const s of data.symbols ?? []) {
          if (s.status !== "TRADING" || !s.baseAsset || !s.quoteAsset) continue;
          if (s.quoteAsset === "USDT") {
            const ticker = `${s.baseAsset}USD`;
            if (!seen.has(ticker)) {
              seen.add(ticker);
              items.push({
                ticker,
                base: s.baseAsset,
                quote: "USD",
                displayName: `${s.baseAsset} / USD (Spot)`,
                category: "CRYPTO",
                exchange: "BINANCE",
                isPerpetual: false,
              });
            }
          } else if (s.quoteAsset === "EUR") {
            const ticker = `${s.baseAsset}EUR`;
            if (!seen.has(ticker)) {
              seen.add(ticker);
              items.push({
                ticker,
                base: s.baseAsset,
                quote: "EUR",
                displayName: `${s.baseAsset} / EUR (Spot)`,
                category: "CRYPTO",
                exchange: "BINANCE",
                isPerpetual: false,
              });
            }
          }
        }
      } catch {
        // ignore spot parse error
      }
    }

    if (futRes?.ok) {
      try {
        const data = (await futRes.json()) as {
          symbols?: Array<{
            symbol?: string;
            status?: string;
            contractType?: string;
            baseAsset?: string;
            quoteAsset?: string;
          }>;
        };
        for (const s of data.symbols ?? []) {
          if (
            s.status !== "TRADING" ||
            s.contractType !== "PERPETUAL" ||
            s.quoteAsset !== "USDT" ||
            !s.baseAsset
          ) {
            continue;
          }
          const ticker = `${s.baseAsset}USDT.P`;
          if (!seen.has(ticker)) {
            seen.add(ticker);
            items.push({
              ticker,
              base: s.baseAsset,
              quote: "USDT",
              displayName: `${s.baseAsset} Perpetuo (USDT-M)`,
              category: "FUTURES",
              exchange: "BINANCE PERP",
              isPerpetual: true,
            });
          }
        }
      } catch {
        // ignore futures parse error
      }
    }

    if (items.length > 0) {
      this.catalogCache = { at: Date.now(), items };
    }
    return this.catalogCache?.items ?? items;
  }

  /**
   * Acquires a shared real-time crypto stream (bookTicker bid/ask + active 1m OHLCV bar)
   * refreshed every 1.5s from Binance Spot/Futures (with Kraken fallback) so charts stay
   * live with zero browser CORS/WS issues.
   */
  acquireSymbolStream(
    symbol: string,
    onEvent: (evt: CryptoStreamEvent) => void,
  ): () => void {
    const parsed = parseCryptoSymbol(symbol);
    const key = parsed.canonical;
    let sub = this.subs.get(key);

    if (!sub) {
      sub = {
        symbol: key,
        parsed,
        refs: 0,
        listeners: new Set(),
        timer: null,
        lastBar1m: null,
        lastQuotePrice: null,
      };
      this.subs.set(key, sub);
      this.startPollingSub(sub);
    }

    sub.refs += 1;
    sub.listeners.add(onEvent);

    if (sub.lastBar1m) {
      onEvent({
        type: "bar",
        symbol: sub.symbol,
        timeframe: "1m",
        bar: { ...sub.lastBar1m },
      });
    }

    let released = false;
    return () => {
      if (released) return;
      released = true;
      const cur = this.subs.get(key);
      if (!cur) return;
      cur.listeners.delete(onEvent);
      cur.refs = Math.max(0, cur.refs - 1);
      if (cur.refs === 0) {
        if (cur.timer) clearInterval(cur.timer);
        this.subs.delete(key);
      }
    };
  }

  private startPollingSub(sub: ActiveCryptoSub): void {
    let busy = false;
    const poll = async () => {
      if (busy || sub.refs <= 0) return;
      busy = true;
      try {
        if (sub.parsed.isDominance) {
          const domPct = await this.fetchLiveBtcDominancePct();
          const nowMs = Date.now();
          const bucket = getBucketStartSec(nowMs, 60);
          const bar: OhlcvBar = {
            time: bucket,
            open: sub.lastBar1m?.time === bucket ? sub.lastBar1m.open : domPct,
            high: sub.lastBar1m?.time === bucket ? Math.max(sub.lastBar1m.high, domPct) : domPct,
            low: sub.lastBar1m?.time === bucket ? Math.min(sub.lastBar1m.low, domPct) : domPct,
            close: domPct,
            volume: sub.lastBar1m?.time === bucket ? sub.lastBar1m.volume : 1,
          };
          sub.lastBar1m = bar;
          sub.lastQuotePrice = domPct;
          this.broadcast(sub, { type: "quote", symbol: sub.symbol, bid: domPct, ask: domPct, last: domPct, timestamp: nowMs });
          this.broadcast(sub, { type: "bar", symbol: sub.symbol, timeframe: "1m", bar });
          return;
        }

        const base = sub.parsed.isPerpetual ? BINANCE_FUTURES_BASE : BINANCE_SPOT_BASE;
        const klinePath = sub.parsed.isPerpetual ? "/fapi/v1/klines" : "/api/v3/klines";
        const tickerPath = sub.parsed.isPerpetual ? "/fapi/v1/ticker/bookTicker" : "/api/v3/ticker/bookTicker";

        const [klineRes, tickerRes] = await Promise.all([
          this.fetchImpl(
            `${base}${klinePath}?symbol=${encodeURIComponent(sub.parsed.binanceSymbol)}&interval=1m&limit=2`,
            { headers: HTTP_HEADERS, signal: AbortSignal.timeout(4_500) },
          ).catch(() => null),
          this.fetchImpl(
            `${base}${tickerPath}?symbol=${encodeURIComponent(sub.parsed.binanceSymbol)}`,
            { headers: HTTP_HEADERS, signal: AbortSignal.timeout(4_500) },
          ).catch(() => null),
        ]);

        const nowMs = Date.now();
        let emittedQuote = false;
        if (tickerRes?.ok) {
          const t = (await tickerRes.json()) as { bidPrice?: string; askPrice?: string };
          const bid = Number(t.bidPrice);
          const ask = Number(t.askPrice);
          if (Number.isFinite(bid) && bid > 0 && Number.isFinite(ask) && ask > 0) {
            const mid = (bid + ask) / 2;
            sub.lastQuotePrice = mid;
            this.broadcast(sub, {
              type: "quote",
              symbol: sub.symbol,
              bid,
              ask,
              last: mid,
              timestamp: nowMs,
            });
            emittedQuote = true;
          }
        }

        if (klineRes?.ok) {
          const bars = parseBinanceKlines(await klineRes.json());
          if (bars.length > 0) {
            // Emit previous bar if we just crossed a minute boundary so closed volume/OHLC is exact
            if (bars.length >= 2 && sub.lastBar1m && sub.lastBar1m.time === bars[0]!.time) {
              this.broadcast(sub, {
                type: "bar",
                symbol: sub.symbol,
                timeframe: "1m",
                bar: bars[0]!,
              });
            }
            const latest = bars[bars.length - 1]!;
            sub.lastBar1m = latest;
            if (!emittedQuote) {
              sub.lastQuotePrice = latest.close;
              this.broadcast(sub, {
                type: "quote",
                symbol: sub.symbol,
                bid: latest.close,
                ask: latest.close,
                last: latest.close,
                timestamp: nowMs,
              });
            }
            this.broadcast(sub, {
              type: "bar",
              symbol: sub.symbol,
              timeframe: "1m",
              bar: latest,
            });
          }
        } else {
          // Kraken fallback for pairs not on Binance
          const krakenBars = await this.fetchKrakenOhlc(sub.parsed.krakenPair, 60).catch(
            () => [] as OhlcvBar[],
          );
          if (krakenBars.length > 0) {
            const latest = krakenBars[krakenBars.length - 1]!;
            sub.lastBar1m = latest;
            sub.lastQuotePrice = latest.close;
            this.broadcast(sub, {
              type: "quote",
              symbol: sub.symbol,
              bid: latest.close,
              ask: latest.close,
              last: latest.close,
              timestamp: nowMs,
            });
            this.broadcast(sub, {
              type: "bar",
              symbol: sub.symbol,
              timeframe: "1m",
              bar: latest,
            });
          }
        }
      } catch {
        // transient network error; retry on next tick
      } finally {
        busy = false;
      }
    };

    void poll();
    sub.timer = setInterval(() => {
      void poll();
    }, 1_500);
  }

  private broadcast(sub: ActiveCryptoSub, evt: CryptoStreamEvent): void {
    for (const listener of sub.listeners) {
      try {
        listener(evt);
      } catch {
        // ignore broken listener
      }
    }
  }
}
