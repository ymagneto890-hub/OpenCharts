import type { Candle } from "../schemas.ts";
import {
  assessEmaWarmup,
  assessVwapSessionCoverage,
  computeMinEmaWarmupBars,
  type EmaWarmupAssessment,
  getNyTradingDayKey,
  getSessionAnchorStartSec,
  type VwapPriceSource,
  type VwapSessionSeed,
  type VwapSessionTimeZone,
} from "../../lib/indicators.ts";
import {
  aggregateCandles,
  aggregateCandlesWithIntegrity,
  computeRequiredWarmupBars,
  getBucketStartSec,
  isSubIntervalOhlcvCoherent,
  mergeLive1sBarIntoSeries,
  parseTimeframeSeconds,
} from "../../lib/timeframes.ts";
import { getIndicatorSettings } from "../../hooks/useIndicatorSettings.ts";
import { getDemoSymbol } from "./instruments.ts";

/**
 * Market candle store powered exclusively by Interactive Brokers (IBKR) in runtime.
 * Supports 1-second base streaming, dynamic multi-timeframe aggregation for any timeframe,
 * historical EMA warmup calculation, and continuous NY intraday VWAP session seeds.
 *
 * Note: Bundled fixtures in `./data/*.json` are loaded ONLY inside unit tests (`VITEST`)
 * for offline paper-trading / replay unit suites and are never used in live runtime.
 */

const BASE_TF_SECONDS: Record<string, number> = {
  "1s": 1,
  "5s": 5,
  "15s": 15,
  "30s": 30,
  "1m": 60,
  "2m": 120,
  "3m": 180,
  "5m": 300,
  "10m": 600,
  "15m": 900,
  "30m": 1800,
  "1h": 3600,
  "2h": 7200,
  "4h": 14400,
  "1d": 86400,
  "1w": 604800,
};

export const TF_SECONDS: Record<string, number> = new Proxy(BASE_TF_SECONDS, {
  get(target, prop) {
    if (typeof prop === "string") {
      if (prop in target) return target[prop];
      return parseTimeframeSeconds(prop);
    }
    return Reflect.get(target, prop);
  },
});

const TEMPLATE_SYMBOLS = ["BTCUSD", "ETHUSD", "SOLUSD", "BNBUSD", "XRPUSD", "ADAUSD"] as const;

function isTestEnv(): boolean {
  try {
    const env = (import.meta as unknown as { env?: Record<string, unknown> }).env;
    if (env?.MODE === "test" || env?.VITEST) return true;
  } catch {
    // ignore
  }
  return (
    typeof globalThis !== "undefined" &&
    Boolean((globalThis as { process?: { env?: Record<string, string> } }).process?.env?.VITEST)
  );
}

const modules = isTestEnv()
  ? import.meta.glob<{ default: unknown }>("./data/*.json", { eager: true })
  : {};

const series = new Map<string, Candle[]>();
const bundledFixtureKeys = new Set<string>();
if (isTestEnv()) {
  for (const [path, mod] of Object.entries(modules)) {
    if (!Array.isArray(mod.default)) continue;
    const key = path.replace("./data/", "").replace(".json", "");
    series.set(
      key,
      (mod.default as Candle[]).map((c) => ({ ...c })),
    );
    bundledFixtureKeys.add(key);
  }
}

export type CandleDataOrigin = "real" | "aggregated" | "synthetic" | "unavailable";

export interface ReplaySeriesResolution {
  candles: Candle[];
  origin: CandleDataOrigin;
  sourceTimeframe: string | null;
}

export type PartialCandleResolution =
  | { status: "ok"; candle: Candle }
  | { status: "empty-verified" }
  | { status: "missing-data" };

export interface SessionRange {
  start: number;
  end: number;
}

export interface StockSessionMetadata {
  pre: SessionRange[];
  regular?: SessionRange[];
  post: SessionRange[];
  timezone: string | null;
}

export interface IbkrLiveVwapState {
  extended: {
    anchorBucket: number;
    cumVol: number;
    mean: number;
    sumSqWeightedDiff: number;
    vwap: number | null;
  };
  regular: {
    anchorBucket: number;
    cumVol: number;
    mean: number;
    sumSqWeightedDiff: number;
    vwap: number | null;
  };
}

const liveSeriesKeys = new Set<string>();
const realStockSeriesKeys = new Set<string>();
const syntheticSeriesKeys = new Set<string>();
const historicalTargetSeries = new Map<string, Candle[]>();
const latestRealStockBarMs = new Map<string, number>();
const lastFetchAt = new Map<string, number>();
const inFlightFetches = new Map<string, Promise<Candle[]>>();
const cachedDeltas = new Map<string, number>();
const stockSessionMeta = new Map<string, StockSessionMetadata>();
const stockDataSources = new Map<string, string>();
const bars1sBySymbol = new Map<string, Candle[]>();
const stockVwapSeeds = new Map<
  string,
  { extended: VwapSessionSeed | null; regular: VwapSessionSeed | null }
>();
const liveVwapBySymbol = new Map<string, IbkrLiveVwapState>();

const stockSourceListeners = new Set<() => void>();
const realSeriesArrivalListeners = new Set<(symbol: string, timeframe: string) => void>();
const candleBucketClosedListeners = new Set<(symbol: string, timeframe: string) => void>();
const stockQuoteListeners = new Set<(symbol: string, price: number, timestampMs: number) => void>();

export function subscribeCandleBucketClosed(
  cb: (symbol: string, timeframe: string) => void,
): () => void {
  candleBucketClosedListeners.add(cb);
  return () => {
    candleBucketClosedListeners.delete(cb);
  };
}

function notifyCandleBucketClosed(symbol: string, timeframe: string): void {
  for (const cb of candleBucketClosedListeners) {
    try {
      cb(symbol, timeframe);
    } catch {
      // ignore subscriber errors
    }
  }
}

export function isCryptoInstrument(symbol: string): boolean {
  const sym = getDemoSymbol(symbol);
  if (!sym) return false;
  const cat = (sym.category ?? "").toUpperCase();
  return cat === "CRYPTO" || (cat === "FUTURES" && Boolean(sym.isPerpetual));
}

export function subscribeRealSeriesLoaded(
  cb: (symbol: string, timeframe: string) => void,
): () => void {
  realSeriesArrivalListeners.add(cb);
  return () => {
    realSeriesArrivalListeners.delete(cb);
  };
}

function notifyRealSeriesLoaded(symbol: string, timeframe: string): void {
  for (const cb of realSeriesArrivalListeners) {
    try {
      cb(symbol, timeframe);
    } catch {
      // ignore subscriber errors
    }
  }
}

export function subscribeStockDataSourceChanged(cb: () => void): () => void {
  stockSourceListeners.add(cb);
  return () => {
    stockSourceListeners.delete(cb);
  };
}

function notifyStockDataSourceChanged(): void {
  for (const cb of stockSourceListeners) {
    try {
      cb();
    } catch {
      // ignore listener errors
    }
  }
}

export function subscribeRealStockCandleQuote(
  cb: (symbol: string, price: number, timestampMs: number) => void,
): () => void {
  stockQuoteListeners.add(cb);
  return () => {
    stockQuoteListeners.delete(cb);
  };
}

export function getLatestRealStockTimestampMs(symbol: string): number | null {
  const ts = latestRealStockBarMs.get(symbol.trim().toUpperCase());
  return typeof ts === "number" && ts > 0 ? ts : null;
}

export function evaluateStockBarQuoteFreshness(
  barTimeSec: number,
  timeframe: string,
  prevTsMs: number,
): { isFresherBar: boolean; quoteTsMs: number } {
  if (!Number.isFinite(barTimeSec) || barTimeSec <= 0) {
    return { isFresherBar: false, quoteTsMs: 0 };
  }
  const barTsMs = Math.floor(barTimeSec) * 1000;
  const tfSec = TF_SECONDS[timeframe] ?? 60;
  const isIntradayTf = tfSec < 86_400;
  if (!isIntradayTf) {
    return {
      isFresherBar: barTsMs > 0 && prevTsMs === 0,
      quoteTsMs: barTsMs,
    };
  }
  const barEndMs = (Math.floor(barTimeSec) + tfSec) * 1000;
  const isFresherBar = barTsMs >= prevTsMs || barEndMs > prevTsMs;
  const quoteTsMs = barEndMs > prevTsMs ? Math.max(barTsMs, prevTsMs) : barTsMs;
  return { isFresherBar, quoteTsMs };
}

export function getStockDataSource(symbol: string, timeframe?: string): string | null {
  const upper = symbol.trim().toUpperCase();
  if (timeframe) {
    const exact = stockDataSources.get(`${upper}_${timeframe}`);
    if (exact) return exact;
  }
  const prefix = `${upper}_`;
  for (const [k, src] of stockDataSources.entries()) {
    if (k.startsWith(prefix) && src) return src;
  }
  return null;
}

export function getStockSessionMetadata(
  symbol: string,
  timeframe: string,
): StockSessionMetadata | null {
  const upper = symbol.trim().toUpperCase();
  const exact = stockSessionMeta.get(`${upper}_${timeframe}`);
  if (exact && (exact.pre.length > 0 || exact.post.length > 0)) {
    return exact;
  }
  const prefix = `${upper}_`;
  let best: StockSessionMetadata | null = exact ?? null;
  let bestCount = best ? best.pre.length + best.post.length : -1;
  for (const [k, meta] of stockSessionMeta.entries()) {
    if (!k.startsWith(prefix)) continue;
    const count = meta.pre.length + meta.post.length;
    if (count > bestCount) {
      best = meta;
      bestCount = count;
    }
  }
  return best;
}

/** Returns true if at least one real IBKR series is loaded in memory for `symbol`. */
export function hasRealStockSeries(symbol: string): boolean {
  const upper = symbol.trim().toUpperCase();
  const prefix = `${upper}_`;
  for (const k of realStockSeriesKeys) {
    if (k.toUpperCase().startsWith(prefix)) return true;
  }
  return false;
}

/** Returns the cached IBKR pre-window VWAP session seed for extended or regular hours. */
export function getStockVwapSeed(
  symbol: string,
  extendedHours: boolean,
  timeframe?: string,
): VwapSessionSeed | null {
  const upper = symbol.trim().toUpperCase();
  const seeds = timeframe
    ? stockVwapSeeds.get(`${upper}_${timeframe}`)
    : stockVwapSeeds.get(upper);
  if (!seeds) return null;
  return extendedHours ? seeds.extended : seeds.regular;
}

/** Returns the latest real-time IBKR VWAP accumulator snapshot for a symbol, if streaming. */
export function getLiveIbkrVwapSnapshot(
  symbol: string,
  extendedHours: boolean,
): { anchorBucket: number; cumVol: number; vwap: number | null } | null {
  const snap = liveVwapBySymbol.get(symbol.trim().toUpperCase());
  if (!snap) return null;
  const branch = extendedHours ? snap.extended : snap.regular;
  return { anchorBucket: branch.anchorBucket, cumVol: branch.cumVol, vwap: branch.vwap };
}

export function invalidateStockSeries(symbol: string): void {
  const upper = symbol.trim().toUpperCase();
  const prefix = `${upper}_`;
  for (const k of Array.from(series.keys())) {
    if (k.toUpperCase().startsWith(prefix)) series.delete(k);
  }
  for (const k of Array.from(liveSeriesKeys)) {
    if (k.toUpperCase().startsWith(prefix)) liveSeriesKeys.delete(k);
  }
  for (const k of Array.from(lastFetchAt.keys())) {
    if (k.toUpperCase().startsWith(prefix)) lastFetchAt.delete(k);
  }
  for (const k of Array.from(stockSessionMeta.keys())) {
    if (k.toUpperCase().startsWith(prefix)) stockSessionMeta.delete(k);
  }
  for (const k of Array.from(stockDataSources.keys())) {
    if (k.toUpperCase().startsWith(prefix)) stockDataSources.delete(k);
  }
  for (const k of Array.from(realStockSeriesKeys)) {
    if (k.toUpperCase().startsWith(prefix)) realStockSeriesKeys.delete(k);
  }
  for (const k of Array.from(syntheticSeriesKeys)) {
    if (k.toUpperCase().startsWith(prefix)) syntheticSeriesKeys.delete(k);
  }
  for (const k of Array.from(historicalTargetSeries.keys())) {
    if (k.toUpperCase().startsWith(prefix)) historicalTargetSeries.delete(k);
  }
  stockVwapSeeds.delete(upper);
  for (const k of Array.from(stockVwapSeeds.keys())) {
    if (k.toUpperCase().startsWith(prefix)) stockVwapSeeds.delete(k);
  }
  bars1sBySymbol.delete(upper);
  lastCrypto1mBarBySymbol.delete(upper);
  stockVwapSeeds.delete(upper);
  liveVwapBySymbol.delete(upper);
  latestRealStockBarMs.delete(upper);
  notifyStockDataSourceChanged();
}

export function invalidateAllStockSeries(): void {
  const isStockKey = (k: string): boolean => {
    const idx = k.lastIndexOf("_");
    const sym = idx > 0 ? k.slice(0, idx) : k;
    return (getDemoSymbol(sym)?.category ?? "").toUpperCase() === "STOCKS";
  };
  for (const k of Array.from(series.keys())) {
    if (isStockKey(k)) series.delete(k);
  }
  for (const k of Array.from(liveSeriesKeys)) {
    if (isStockKey(k)) liveSeriesKeys.delete(k);
  }
  for (const k of Array.from(lastFetchAt.keys())) {
    if (isStockKey(k)) lastFetchAt.delete(k);
  }
  for (const k of Array.from(stockSessionMeta.keys())) {
    if (isStockKey(k)) stockSessionMeta.delete(k);
  }
  for (const k of Array.from(stockDataSources.keys())) {
    if (isStockKey(k)) stockDataSources.delete(k);
  }
  realStockSeriesKeys.clear();
  for (const k of Array.from(historicalTargetSeries.keys())) {
    if (isStockKey(k.split("_hist_")[0] ?? k)) historicalTargetSeries.delete(k);
  }
  bars1sBySymbol.clear();
  stockVwapSeeds.clear();
  liveVwapBySymbol.clear();
  latestRealStockBarMs.clear();
  notifyStockDataSourceChanged();
}

function resampleCandles(bars: Candle[], stepSec: number): Candle[] {
  if (bars.length === 0 || !(stepSec > 0)) return [];
  return aggregateCandles(bars, stepSec);
}

// ── Test-Only Offline Fixture Synthesis (never executed outside Vitest) ─────────
function hashString(input: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function getVolatilityFactor(category: string, isDominanceIndex?: boolean): number {
  if (isDominanceIndex) return 0.24;
  switch (category.toUpperCase()) {
    case "FOREX":
      return 0.16;
    case "INDICES":
      return 0.3;
    case "COMMODITIES":
      return 0.42;
    case "STOCKS":
      return 0.58;
    default:
      return 1.05;
  }
}

function roundToTick(val: number, tickSize: number): number {
  if (!(tickSize > 0) || !Number.isFinite(tickSize)) return Number(val.toFixed(2));
  const decimals = Math.min(8, Math.max(2, Math.round(-Math.log10(tickSize))));
  return Number(val.toFixed(decimals));
}

function synthesizeTestFixtureSeries(symbol: string, timeframe: string): Candle[] {
  if (!isTestEnv()) return [];
  const sym = getDemoSymbol(symbol);
  if (!sym) return [];

  const h = hashString(symbol.toUpperCase());
  const templateSym = TEMPLATE_SYMBOLS[h % TEMPLATE_SYMBOLS.length]!;
  const directTemplate = series.get(`${templateSym}_${timeframe}`);
  const tfSec = TF_SECONDS[timeframe] ?? 900;
  const resampledSub =
    (!directTemplate || directTemplate.length === 0) && tfSec >= 60
      ? resampleCandles(series.get(`${templateSym}_1m`) ?? [], tfSec)
      : undefined;
  const templateBars =
    (directTemplate && directTemplate.length > 0 ? directTemplate : undefined) ??
    (resampledSub && resampledSub.length > 0 ? resampledSub : undefined) ??
    series.get(`${templateSym}_1h`) ??
    [];
  if (templateBars.length === 0) return [];

  const targetPrice = sym.initialPrice && sym.initialPrice > 0 ? sym.initialPrice : 100;
  const tickSize = sym.tickSize > 0 ? sym.tickSize : 0.01;
  const volScale = getVolatilityFactor(sym.category, sym.isDominanceIndex);
  const flipPhase = (h & 7) >= 5 ? -1 : 1;
  const endBucket = currentBucketSec(timeframe);
  const sliceLen = Math.min(templateBars.length, 400);
  const startOffset = templateBars.length - sliceLen;

  const closes = new Array<number>(sliceLen);
  closes[sliceLen - 1] = targetPrice;
  for (let i = sliceLen - 1; i > 0; i--) {
    const curT = templateBars[startOffset + i]!;
    const prevT = templateBars[startOffset + i - 1]!;
    const rawRet = prevT.close > 0 ? (curT.close - prevT.close) / prevT.close : 0;
    const clampedRet = Math.max(-0.08, Math.min(0.08, rawRet * volScale * flipPhase));
    let prevClose = closes[i]! / Math.max(0.25, 1 + clampedRet);
    if (sym.isDominanceIndex && sym.name === "BTC.D") {
      prevClose = Math.max(38, Math.min(72, prevClose));
    }
    closes[i - 1] = Math.max(tickSize * 2, prevClose);
  }

  const out: Candle[] = new Array(sliceLen);
  for (let i = 0; i < sliceLen; i++) {
    const tb = templateBars[startOffset + i]!;
    const open = roundToTick(i === 0 ? closes[0]! : closes[i - 1]!, tickSize);
    const close = roundToTick(closes[i]!, tickSize);
    const bodyHi = Math.max(open, close);
    const bodyLo = Math.min(open, close);
    const wickUpRatio =
      tb.close > 0 ? Math.max(0, (tb.high - Math.max(tb.open, tb.close)) / tb.close) * volScale : 0.002;
    const wickLoRatio =
      tb.close > 0 ? Math.max(0, (Math.min(tb.open, tb.close) - tb.low) / tb.close) * volScale : 0.002;

    const high = roundToTick(bodyHi + close * Math.min(0.05, wickUpRatio), tickSize);
    const low = roundToTick(Math.max(tickSize, bodyLo - close * Math.min(0.05, wickLoRatio)), tickSize);
    const volBase = Math.max(100, (tb.volume || 1000) * (targetPrice > 0 ? 1000 / Math.max(0.001, targetPrice) : 1));
    out[i] = {
      time: endBucket - (sliceLen - 1 - i) * tfSec,
      open,
      high,
      low,
      close,
      volume: Math.round(volBase * (0.6 + ((h + i * 31) % 80) / 100)),
    };
  }
  return out;
}

function rawSeries(symbol: string, timeframe: string): Candle[] {
  const upper = symbol.trim().toUpperCase();
  const key = `${symbol}_${timeframe}`;
  const upperKey = `${upper}_${timeframe}`;
  const existing = series.get(upperKey) ?? series.get(key);
  if (existing && existing.length > 0) return existing;

  const targetSec = parseTimeframeSeconds(timeframe);

  // Instant dynamic aggregation from in-memory 1-second IBKR base bars ONLY for sub-minute timeframes (< 60s).
  // Never build 1m / 3m / 5m charts from a short 30-min 1s window because that truncates VWAP & EMA warmup.
  const bars1s = bars1sBySymbol.get(upper);
  if (bars1s && bars1s.length > 0 && targetSec >= 1 && targetSec < 60) {
    const aggregated = targetSec === 1 ? [...bars1s] : aggregateCandles(bars1s, targetSec);
    if (aggregated.length > 0) return aggregated;
  }

  // Optimistic local aggregation from real 1m series for short intraday multiples (e.g. 2m, 3m, 5m)
  const oneMin = series.get(`${upper}_1m`) ?? series.get(`${symbol}_1m`);
  if (
    (realStockSeriesKeys.has(`${upper}_1m`) || realStockSeriesKeys.has(`${symbol}_1m`)) &&
    oneMin &&
    oneMin.length >= 180 &&
    targetSec > 60 &&
    targetSec % 60 === 0 &&
    targetSec <= 300
  ) {
    const resampled = resampleCandles(oneMin, targetSec);
    if (resampled.length > 0) return resampled;
  }

  const sym = getDemoSymbol(symbol);
  const isStock =
    (sym?.category ?? "").toUpperCase() === "STOCKS" || hasRealStockSeries(symbol);

  // Never synthesize artificial candles for stocks or instruments backed by real IBKR series, even in tests.
  if (!isTestEnv() || isStock) {
    return [];
  }

  if (timeframe === "3m" && oneMin && oneMin.length > 0) {
    const resampled3m = resampleCandles(oneMin, 180);
    if (resampled3m.length > 0) {
      series.set(key, resampled3m);
      bundledFixtureKeys.add(key);
      if (liveSeriesKeys.has(`${symbol}_1m`)) liveSeriesKeys.add(key);
      return resampled3m;
    }
  }

  if (sym && (sym.isPerpetual || sym.category === "FUTURES")) {
    const raw = sym.name.toUpperCase();
    const base = raw.endsWith("USDT.P")
      ? raw.slice(0, -6)
      : raw.endsWith("USDT")
        ? raw.slice(0, -4)
        : raw.endsWith("USD")
          ? raw.slice(0, -3)
          : raw;
    const spotKey = `${base}USD_${timeframe}`;
    const directSpot = series.get(spotKey);
    const liveSourceKey = directSpot && directSpot.length > 0 ? spotKey : `${base}USD_1m`;
    const bundledSpot =
      directSpot && directSpot.length > 0
        ? directSpot
        : targetSec > 60 && targetSec % 60 === 0
          ? resampleCandles(series.get(`${base}USD_1m`) ?? [], targetSec)
          : undefined;
    if (bundledSpot && bundledSpot.length > 0) {
      const cloned = bundledSpot.map((c) => ({ ...c }));
      series.set(key, cloned);
      bundledFixtureKeys.add(key);
      if (liveSeriesKeys.has(liveSourceKey)) liveSeriesKeys.add(key);
      return cloned;
    }
  }

  if (sym && sym.category === "CRYPTO" && !sym.isPerpetual && upper.endsWith("EUR") && upper.length > 3) {
    const base = upper.slice(0, -3);
    const spotKey = `${base}USD_${timeframe}`;
    const directSpot = series.get(spotKey);
    const liveSourceKey = directSpot && directSpot.length > 0 ? spotKey : `${base}USD_1m`;
    const bundledSpot =
      directSpot && directSpot.length > 0
        ? directSpot
        : targetSec > 60 && targetSec % 60 === 0
          ? resampleCandles(series.get(`${base}USD_1m`) ?? [], targetSec)
          : undefined;
    if (bundledSpot && bundledSpot.length > 0) {
      const scale = 0.945;
      const tickSize = sym.tickSize > 0 ? sym.tickSize : 0.01;
      const scaled = bundledSpot.map((c) => {
        const open = roundToTick(c.open * scale, tickSize);
        const close = roundToTick(c.close * scale, tickSize);
        const high = Math.max(roundToTick(c.high * scale, tickSize), open, close);
        const low = Math.min(roundToTick(c.low * scale, tickSize), open, close);
        return { ...c, open, high, low, close };
      });
      series.set(key, scaled);
      bundledFixtureKeys.add(key);
      if (liveSeriesKeys.has(liveSourceKey)) liveSeriesKeys.add(key);
      return scaled;
    }
  }

  const synthesized = synthesizeTestFixtureSeries(symbol, timeframe);
  if (synthesized.length > 0) {
    series.set(key, synthesized);
    liveSeriesKeys.add(key);
    syntheticSeriesKeys.add(key);
    syntheticSeriesKeys.add(upperKey);
  }
  return synthesized;
}

function bucketSecAt(timeMs: number, timeframe: string): number {
  return getBucketStartSec(timeMs, timeframe);
}

function currentBucketSec(timeframe: string): number {
  return bucketSecAt(Date.now(), timeframe);
}

function shiftDelta(key: string, bars: Candle[], timeframe: string): number {
  if (!isTestEnv() || bars.length === 0 || liveSeriesKeys.has(key)) return 0;
  const existing = cachedDeltas.get(key);
  if (existing !== undefined) return existing;
  const lastReal = bars[bars.length - 1]!.time;
  const delta = currentBucketSec(timeframe) - lastReal;
  cachedDeltas.set(key, delta);
  return delta;
}

const RECENT_SHIFT_CUTOFF_SEC = 1_788_220_800; // 2026-09-01 00:00:00 UTC

/** Returns historical OHLCV bars for `symbol`/`timeframe` from IBKR cache (or Vitest fixtures). */
export function getHistory(
  symbol: string,
  timeframe: string,
  limit?: number,
  range?: { from?: number; to?: number; fromMs?: number; toMs?: number },
): Candle[] {
  const key = `${symbol}_${timeframe}`;
  const bars = rawSeries(symbol, timeframe);
  if (bars.length === 0) return [];
  const delta = shiftDelta(key, bars, timeframe);
  let shifted =
    delta === 0
      ? bars
      : bars.map((c) =>
          delta > 0 && c.time < RECENT_SHIFT_CUTOFF_SEC ? c : { ...c, time: c.time + delta },
        );

  const toVal = range?.toMs ?? range?.to;
  const fromVal = range?.fromMs ?? range?.from;
  if (typeof toVal === "number" && Number.isFinite(toVal) && toVal > 0) {
    const toSec = toVal > 1e11 ? Math.floor(toVal / 1000) : Math.floor(toVal);
    shifted = shifted.filter((c) => c.time < toSec);
  }
  if (typeof fromVal === "number" && Number.isFinite(fromVal) && fromVal > 0) {
    const fromSec = fromVal > 1e11 ? Math.floor(fromVal / 1000) : Math.floor(fromVal);
    shifted = shifted.filter((c) => c.time >= fromSec);
  }

  return limit && limit < shifted.length ? shifted.slice(-limit) : shifted;
}

export function getRawHistory(symbol: string, timeframe: string): Candle[] {
  return rawSeries(symbol, timeframe);
}

function normalizeSortedUniqueBars(bars: ReadonlyArray<Candle>): Candle[] {
  const byTime = new Map<number, Candle>();
  for (const b of bars) {
    if (
      !b ||
      !Number.isFinite(b.time) ||
      !Number.isFinite(b.open) ||
      !Number.isFinite(b.high) ||
      !Number.isFinite(b.low) ||
      !Number.isFinite(b.close) ||
      b.close <= 0
    ) {
      continue;
    }
    const t = Math.floor(b.time);
    byTime.set(t, {
      time: t,
      open: b.open,
      high: Math.max(b.high, b.open, b.close),
      low: Math.min(b.low, b.open, b.close),
      close: b.close,
      volume: typeof b.volume === "number" && Number.isFinite(b.volume) && b.volume >= 0 ? b.volume : 0,
    });
  }
  return Array.from(byTime.values()).sort((a, b) => a.time - b.time);
}

export function setRealStockSeries(symbol: string, timeframe: string, bars: Candle[]): void {
  const cleanSym = symbol.trim().toUpperCase();
  const key = `${cleanSym}_${timeframe}`;
  const sorted = normalizeSortedUniqueBars(bars);
  series.set(key, sorted);
  if (timeframe === "1m") {
    lastCrypto1mBarBySymbol.delete(cleanSym);
  }
  syntheticSeriesKeys.delete(key);
  syntheticSeriesKeys.delete(`${symbol}_${timeframe}`);
  liveSeriesKeys.add(key);
  const wasMissing = !realStockSeriesKeys.has(key);
  realStockSeriesKeys.add(key);
  if (wasMissing) {
    notifyRealSeriesLoaded(cleanSym, timeframe);
  }
}

function findBarIndexAtOrBefore(bars: ReadonlyArray<Candle>, timeSec: number): number {
  let lo = 0;
  let hi = bars.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid]!.time <= timeSec) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

const NY_CLOCK_FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  weekday: "short",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

const WEEKDAY_MAP: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

function getNyClockParts(epochSec: number): {
  year: number;
  month: number;
  day: number;
  dayKey: number;
  weekday: number;
  minutes: number;
} {
  let year = 1970;
  let month = 1;
  let day = 1;
  let weekday = 4;
  let hour = 0;
  let minute = 0;
  for (const p of NY_CLOCK_FMT.formatToParts(new Date(epochSec * 1000))) {
    if (p.type === "year") year = Number(p.value);
    else if (p.type === "month") month = Number(p.value);
    else if (p.type === "day") day = Number(p.value);
    else if (p.type === "weekday") weekday = WEEKDAY_MAP[p.value] ?? 1;
    else if (p.type === "hour") hour = Number(p.value) % 24;
    else if (p.type === "minute") minute = Number(p.value);
  }
  return {
    year,
    month,
    day,
    dayKey: year * 10000 + month * 100 + day,
    weekday,
    minutes: hour * 60 + minute,
  };
}

function nthWeekdayOfMonth(year: number, month: number, weekday: number, nth: number): number {
  const firstDow = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  const offset = (weekday - firstDow + 7) % 7;
  return 1 + offset + (nth - 1) * 7;
}

function lastWeekdayOfMonth(year: number, month: number, weekday: number): number {
  const lastDate = new Date(Date.UTC(year, month, 0));
  const lastDay = lastDate.getUTCDate();
  const lastDow = lastDate.getUTCDay();
  const back = (lastDow - weekday + 7) % 7;
  return lastDay - back;
}

function easterSundayMonthDay(year: number): { month: number; day: number } {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return { month, day };
}

function matchesObservedFixedHoliday(
  year: number,
  month: number,
  day: number,
  holMonth: number,
  holDay: number,
): boolean {
  const dow = new Date(Date.UTC(year, holMonth - 1, holDay)).getUTCDay();
  if (dow === 6) {
    // Saturday observed on Friday
    const obs = new Date(Date.UTC(year, holMonth - 1, holDay - 1));
    return obs.getUTCFullYear() === year && obs.getUTCMonth() + 1 === month && obs.getUTCDate() === day;
  }
  if (dow === 0) {
    // Sunday observed on Monday
    const obs = new Date(Date.UTC(year, holMonth - 1, holDay + 1));
    return obs.getUTCFullYear() === year && obs.getUTCMonth() + 1 === month && obs.getUTCDate() === day;
  }
  return month === holMonth && day === holDay;
}

export function isUsEquityMarketHoliday(year: number, month: number, day: number): boolean {
  // New Year's Day (including Dec 31 observed when Jan 1 next year falls on Saturday)
  if (matchesObservedFixedHoliday(year, month, day, 1, 1)) return true;
  if (month === 12 && day === 31 && new Date(Date.UTC(year + 1, 0, 1)).getUTCDay() === 6) return true;
  // Martin Luther King Jr. Day (3rd Monday of Jan)
  if (month === 1 && day === nthWeekdayOfMonth(year, 1, 1, 3)) return true;
  // Washington's Birthday / Presidents' Day (3rd Monday of Feb)
  if (month === 2 && day === nthWeekdayOfMonth(year, 2, 1, 3)) return true;
  // Good Friday (Easter Sunday minus 2 days)
  const easter = easterSundayMonthDay(year);
  const gf = new Date(Date.UTC(year, easter.month - 1, easter.day - 2));
  if (gf.getUTCFullYear() === year && gf.getUTCMonth() + 1 === month && gf.getUTCDate() === day) return true;
  // Memorial Day (last Monday of May)
  if (month === 5 && day === lastWeekdayOfMonth(year, 5, 1)) return true;
  // Juneteenth (since 2022)
  if (year >= 2022 && matchesObservedFixedHoliday(year, month, day, 6, 19)) return true;
  // Independence Day
  if (matchesObservedFixedHoliday(year, month, day, 7, 4)) return true;
  // Labor Day (1st Monday of Sep)
  if (month === 9 && day === nthWeekdayOfMonth(year, 9, 1, 1)) return true;
  // Thanksgiving Day (4th Thursday of Nov)
  if (month === 11 && day === nthWeekdayOfMonth(year, 11, 4, 4)) return true;
  // Christmas Day
  if (matchesObservedFixedHoliday(year, month, day, 12, 25)) return true;
  return false;
}

function isUsEquityEarlyCloseDay(year: number, month: number, day: number, weekday: number): boolean {
  // Day after Thanksgiving (Friday)
  if (month === 11 && weekday === 5 && day === nthWeekdayOfMonth(year, 11, 4, 4) + 1) return true;
  // Christmas Eve (weekday)
  if (month === 12 && day === 24 && weekday >= 1 && weekday <= 5) return true;
  // July 3 (weekday)
  if (month === 7 && day === 3 && weekday >= 1 && weekday <= 5) return true;
  return false;
}

function isNyTradingDay(year: number, month: number, day: number, weekday: number): boolean {
  return weekday >= 1 && weekday <= 5 && !isUsEquityMarketHoliday(year, month, day);
}

function hasSkippedNyTradingDayBetween(
  startYear: number,
  startMonth: number,
  startDay: number,
  endYear: number,
  endMonth: number,
  endDay: number,
): boolean {
  const cur = new Date(Date.UTC(startYear, startMonth - 1, startDay + 1));
  const endMs = Date.UTC(endYear, endMonth - 1, endDay);
  while (cur.getTime() < endMs) {
    const y = cur.getUTCFullYear();
    const m = cur.getUTCMonth() + 1;
    const d = cur.getUTCDate();
    const dow = cur.getUTCDay();
    if (isNyTradingDay(y, m, d, dow)) return true;
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return false;
}

export interface SeriesCoverageCheckOptions {
  /** Provider-certified sparse coverage where absent bars inside an open session genuinely had zero trades. */
  allowSparseZeroTradeGaps?: boolean;
  /** When true, also validates that there are no internal gaps earlier in the active open session up to `targetTimeSec`. */
  validateSessionContinuity?: boolean;
}

export interface OpenSessionGapInfo {
  fromSec: number;
  toSec: number;
  missingBars: number;
}

export interface OpenSessionContinuityReport {
  isContinuous: boolean;
  gaps: OpenSessionGapInfo[];
}

/**
 * Validates continuity of expected intervals during the open trading session containing `targetTimeSec`,
 * detecting small and intermediate gaps while respecting legitimate market closes, official early closes,
 * overnight closures, weekends, and US equity holidays.
 */
export function assessSeriesOpenSessionContinuity(
  bars: ReadonlyArray<Candle>,
  tfSec: number,
  targetTimeSec: number,
  isStock: boolean,
  options?: { allowSparseZeroTradeGaps?: boolean },
): OpenSessionContinuityReport {
  if (bars.length === 0 || !(tfSec > 0) || tfSec >= 86_400 || !Number.isFinite(targetTimeSec)) {
    return { isContinuous: true, gaps: [] };
  }
  if (options?.allowSparseZeroTradeGaps) {
    return { isContinuous: true, gaps: [] };
  }

  const gaps: OpenSessionGapInfo[] = [];
  if (isStock) {
    const tgtNy = getNyClockParts(targetTimeSec);
    if (!isNyTradingDay(tgtNy.year, tgtNy.month, tgtNy.day, tgtNy.weekday)) {
      return { isContinuous: true, gaps: [] };
    }
    const closeMin = isUsEquityEarlyCloseDay(tgtNy.year, tgtNy.month, tgtNy.day, tgtNy.weekday)
      ? 780
      : 960;

    let prevBar: Candle | null = null;
    for (const bar of bars) {
      if (bar.time > targetTimeSec) break;
      const bNy = getNyClockParts(bar.time);
      if (bNy.dayKey !== tgtNy.dayKey) continue;
      // Check continuity strictly inside open Regular Trading Hours [09:30 ET, closeMin)
      if (bNy.minutes < 570 || bNy.minutes >= closeMin) continue;
      if (prevBar !== null) {
        const delta = bar.time - prevBar.time;
        if (delta > tfSec) {
          gaps.push({
            fromSec: prevBar.time + tfSec,
            toSec: bar.time,
            missingBars: Math.max(1, Math.round(delta / tfSec) - 1),
          });
        }
      }
      prevBar = bar;
    }
    return { isContinuous: gaps.length === 0, gaps };
  }

  // 24x7 non-stock instruments (e.g. crypto): no market closures during the target UTC day
  const targetUtcDay = Math.floor(targetTimeSec / 86_400);
  let prevBar: Candle | null = null;
  for (const bar of bars) {
    if (bar.time > targetTimeSec) break;
    if (Math.floor(bar.time / 86_400) !== targetUtcDay) continue;
    if (prevBar !== null) {
      const delta = bar.time - prevBar.time;
      if (delta > tfSec) {
        gaps.push({
          fromSec: prevBar.time + tfSec,
          toSec: bar.time,
          missingBars: Math.max(1, Math.round(delta / tfSec) - 1),
        });
      }
    }
    prevBar = bar;
  }
  return { isContinuous: gaps.length === 0, gaps };
}

export function doesSeriesCoverTargetTime(
  bars: ReadonlyArray<Candle>,
  tfSec: number,
  targetTimeSec: number,
  isStock: boolean,
  options?: SeriesCoverageCheckOptions,
): boolean {
  if (bars.length === 0 || !Number.isFinite(targetTimeSec) || targetTimeSec <= 0) return false;
  if (bars[0]!.time > targetTimeSec) return false;
  const idx = findBarIndexAtOrBefore(bars, targetTimeSec);
  if (idx < 0) return false;
  const nearestBefore = bars[idx]!;
  // Reject disjoint series where a multi-week hole separates the nearest bar from `targetTimeSec`
  const maxAllowedGapSec =
    tfSec >= 604_800
      ? 21 * 86_400
      : tfSec >= 86_400
        ? 10 * 86_400
        : 5 * 86_400;
  if (targetTimeSec - nearestBefore.time > maxAllowedGapSec) return false;

  const lastBar = bars[bars.length - 1]!;
  if (lastBar.time + tfSec >= targetTimeSec) {
    // Reject even small missing-data holes during open trading sessions (no arbitrary 30m/60m tolerance!)
    if (!options?.allowSparseZeroTradeGaps && tfSec < 86_400 && nearestBefore.time + tfSec < targetTimeSec) {
      if (isStock) {
        const prevEndNy = getNyClockParts(nearestBefore.time + tfSec);
        const tgtNy = getNyClockParts(targetTimeSec);
        const closeMin = isUsEquityEarlyCloseDay(tgtNy.year, tgtNy.month, tgtNy.day, tgtNy.weekday)
          ? 780
          : 960;
        if (
          prevEndNy.dayKey === tgtNy.dayKey &&
          isNyTradingDay(tgtNy.year, tgtNy.month, tgtNy.day, tgtNy.weekday) &&
          prevEndNy.minutes >= 570 &&
          prevEndNy.minutes < closeMin &&
          tgtNy.minutes >= 570 &&
          tgtNy.minutes < closeMin
        ) {
          return false;
        }
      } else {
        // 24x7 non-stock instrument has no market closures: any open gap at targetTimeSec is missing data
        return false;
      }
    }
    if (options?.validateSessionContinuity) {
      const continuity = assessSeriesOpenSessionContinuity(
        bars,
        tfSec,
        targetTimeSec,
        isStock,
        options,
      );
      if (!continuity.isContinuous) return false;
    }
    return true;
  }

  // `targetTimeSec` is strictly AFTER `lastBar.time + tfSec`:
  // Never accept an incomplete intraday stock series (e.g. ending at 10:00 ET) for a later
  // open-session timestamp (e.g. 15:00 ET) merely because both fall on the same NY day.
  if (isStock && tfSec < 86_400) {
    const lastEndSec = lastBar.time + tfSec;
    const lastEndNy = getNyClockParts(lastEndSec);
    const tgtNy = getNyClockParts(targetTimeSec);
    const closeThresholdMin = isUsEquityEarlyCloseDay(
      lastEndNy.year,
      lastEndNy.month,
      lastEndNy.day,
      lastEndNy.weekday,
    )
      ? 775 // 12:55 ET on official 13:00 ET early-close sessions
      : 955; // 15:55 ET on regular 16:00 ET sessions
    const reachedSessionClose = lastEndNy.minutes >= closeThresholdMin;

    if (tgtNy.dayKey === lastEndNy.dayKey) {
      if (!isNyTradingDay(tgtNy.year, tgtNy.month, tgtNy.day, tgtNy.weekday)) {
        return true;
      }
      if (tgtNy.minutes < closeThresholdMin + 5) {
        // Still inside active pre-market or regular hours: never fabricate future coverage past `lastBar.time + tfSec`
        return false;
      }
      // Post-close evening (e.g. 16:30 ET / 20:30 ET / 23:59 ET): valid ONLY if the series reached market close
      return reachedSessionClose;
    }

    if (tgtNy.dayKey > lastEndNy.dayKey) {
      const targetIsClosedTime =
        !isNyTradingDay(tgtNy.year, tgtNy.month, tgtNy.day, tgtNy.weekday) ||
        tgtNy.minutes < 240; // Overnight 00:00–03:59 ET before pre-market opens
      if (!targetIsClosedTime) return false;
      if (!reachedSessionClose) return false;
      return !hasSkippedNyTradingDayBetween(
        lastEndNy.year,
        lastEndNy.month,
        lastEndNy.day,
        tgtNy.year,
        tgtNy.month,
        tgtNy.day,
      );
    }
    return false;
  }

  if (isStock && tfSec >= 86_400) {
    return targetTimeSec - (lastBar.time + tfSec) <= Math.max(tfSec * 2, 4 * 86_400);
  }
  return targetTimeSec - (lastBar.time + tfSec) <= Math.max(tfSec, 300);
}

function seriesCoversTargetTime(
  bars: ReadonlyArray<Candle>,
  tfSec: number,
  targetTimeSec: number,
  isStock: boolean,
): boolean {
  return doesSeriesCoverTargetTime(bars, tfSec, targetTimeSec, isStock);
}

function getDirectAuthenticCandidates(symbol: string, timeframe: string): Candle[][] {
  const upper = symbol.trim().toUpperCase();
  const exactKey = `${symbol}_${timeframe}`;
  const upperKey = `${upper}_${timeframe}`;
  const out: Candle[][] = [];

  // 1. Check isolated targetDate historical snapshots first so past Replay dates never mix with live bars
  const histPrefix = `${upper}_${timeframe}_hist_`;
  for (const [k, bars] of historicalTargetSeries.entries()) {
    if (k.startsWith(histPrefix) && bars.length > 0) {
      out.push(bars);
    }
  }

  // 2. Check primary in-memory series ONLY if its origin is real (IBKR or real test fixture, never synthetic)
  const isSynthetic =
    syntheticSeriesKeys.has(upperKey) || syntheticSeriesKeys.has(exactKey);
  if (!isSynthetic) {
    const isRealStock =
      realStockSeriesKeys.has(upperKey) || realStockSeriesKeys.has(exactKey);
    if (isRealStock) {
      const direct = series.get(upperKey) ?? series.get(exactKey);
      if (direct && direct.length > 0) out.push(direct);
    } else if (timeframe === "1s") {
      const b1s = bars1sBySymbol.get(upper);
      if (b1s && b1s.length > 0) out.push(b1s);
    } else if (isTestEnv()) {
      const sym = getDemoSymbol(symbol);
      const isStock =
        (sym?.category ?? "").toUpperCase() === "STOCKS" || hasRealStockSeries(symbol);
      if (!isStock) {
        // Trigger bundled spot/perp lookup if not yet materialized
        const raw = rawSeries(symbol, timeframe);
        const nowSynthetic =
          syntheticSeriesKeys.has(upperKey) || syntheticSeriesKeys.has(exactKey);
        if (
          raw.length > 0 &&
          !nowSynthetic &&
          (bundledFixtureKeys.has(upperKey) || bundledFixtureKeys.has(exactKey))
        ) {
          const shifted = getHistory(symbol, timeframe);
          if (shifted.length > 0) out.push(shifted);
        }
      }
    }
  }

  return out;
}

const FINER_AGGREGATION_ORDER = [
  "1m",
  "1s",
  "2m",
  "3m",
  "5m",
  "10m",
  "15m",
  "30m",
  "1h",
  "2h",
  "4h",
] as const;

/**
 * Resolves Replay candles for `(symbol, timeframe)` at `targetTimeSec` with explicit provenance:
 * - `"real"`: Original exchange candles for `timeframe` covering `targetTimeSec`.
 * - `"aggregated"`: Deterministically aggregated upward from authentic finer-timeframe candles.
 * - `"synthetic"`: Only non-exchange offline synthetic data exists (NEVER returned as Replay candles).
 * - `"unavailable"`: No authentic candles cover `targetTimeSec`.
 *
 * Artificial downward subdivision (`subdivideCandle`) is strictly prohibited.
 */
export function getReplaySeriesWithProvenance(
  symbol: string,
  timeframe: string,
  targetTimeSec: number,
): ReplaySeriesResolution {
  const tfSec = TF_SECONDS[timeframe] ?? parseTimeframeSeconds(timeframe);
  const sym = getDemoSymbol(symbol);
  const isStock =
    (sym?.category ?? "").toUpperCase() === "STOCKS" || hasRealStockSeries(symbol);

  // 1. Direct real historical candles for `timeframe`
  const directCandidates = getDirectAuthenticCandidates(symbol, timeframe);
  for (const cand of directCandidates) {
    if (seriesCoversTargetTime(cand, tfSec, targetTimeSec, isStock)) {
      return { candles: cand, origin: "real", sourceTimeframe: timeframe };
    }
  }

  // 2. Valid upward aggregation from authentic finer timeframes (`finerSec < tfSec`)
  for (const finerTf of FINER_AGGREGATION_ORDER) {
    const finerSec = TF_SECONDS[finerTf]!;
    if (finerSec >= tfSec) continue;
    if (tfSec < 60 && finerSec !== 1 && tfSec % finerSec !== 0) continue;
    if (tfSec >= 60 && finerSec === 1) continue; // Do not build multi-minute Replay from short 1s tail
    if (tfSec % finerSec !== 0) continue;
    if (isStock && tfSec >= 86_400) continue; // US equity daily bars align to NY session dates, not UTC multiples

    const finerCandidates = getDirectAuthenticCandidates(symbol, finerTf);
    for (const finerBars of finerCandidates) {
      if (seriesCoversTargetTime(finerBars, finerSec, targetTimeSec, isStock)) {
        const res = aggregateCandlesWithIntegrity(finerBars, tfSec, {
          sourceStepSec: finerSec,
          requireCompleteBuckets: true,
        });
        let aggregatedCandles = res.candles;

        // Allow reconstructing ONLY the active trailing in-progress bucket at `targetTimeSec`
        // strictly from contiguous real finer bars in `[targetBucket, revealedEndSec)` (no gaps, no future bars).
        // Interior incomplete buckets with missing sub-candles remain strictly excluded.
        const targetBucket = getBucketStartSec(Math.floor(targetTimeSec), tfSec);
        const alreadyHasTargetBucket =
          aggregatedCandles.length > 0 &&
          aggregatedCandles[aggregatedCandles.length - 1]!.time >= targetBucket;
        if (
          !alreadyHasTargetBucket &&
          targetBucket <= targetTimeSec &&
          targetTimeSec < targetBucket + tfSec
        ) {
          const revealedEndSec = Math.floor(targetTimeSec / finerSec) * finerSec + finerSec;
          const expectedPartialSlots = Math.round((revealedEndSec - targetBucket) / finerSec);
          const partialFiner: Candle[] = [];
          const seenSlots = new Set<number>();
          let hasMisalignedInPartial = false;
          for (const fb of finerBars) {
            const ft = Math.floor(fb.time);
            if (ft < targetBucket) continue;
            if (ft >= revealedEndSec) break;
            if ((ft - targetBucket) % finerSec !== 0) {
              hasMisalignedInPartial = true;
              break;
            }
            if (!seenSlots.has(ft)) {
              seenSlots.add(ft);
              partialFiner.push(fb);
            }
          }
          if (
            !hasMisalignedInPartial &&
            expectedPartialSlots > 0 &&
            seenSlots.size === expectedPartialSlots &&
            partialFiner.length === expectedPartialSlots
          ) {
            const open = partialFiner[0]!.open;
            const close = partialFiner[partialFiner.length - 1]!.close;
            let high = Math.max(open, close);
            let low = Math.min(open, close);
            let volume = 0;
            for (const pb of partialFiner) {
              if (pb.high > high) high = pb.high;
              if (pb.low < low) low = pb.low;
              volume += pb.volume;
            }
            aggregatedCandles = [
              ...aggregatedCandles,
              { time: targetBucket, open, high, low, close, volume },
            ];
          }
        }

        if (
          aggregatedCandles.length > 0 &&
          seriesCoversTargetTime(aggregatedCandles, tfSec, targetTimeSec, isStock)
        ) {
          return {
            candles: aggregatedCandles,
            origin: "aggregated",
            sourceTimeframe: finerTf,
          };
        }
      }
    }
  }

  const upper = symbol.trim().toUpperCase();
  const hasSyntheticOnly =
    syntheticSeriesKeys.has(`${upper}_${timeframe}`) ||
    syntheticSeriesKeys.has(`${symbol}_${timeframe}`);
  return {
    candles: [],
    origin: hasSyntheticOnly ? "synthetic" : "unavailable",
    sourceTimeframe: null,
  };
}

export function getCandleSeriesOrigin(
  symbol: string,
  timeframe: string,
  targetTimeSec?: number,
): CandleDataOrigin {
  if (typeof targetTimeSec === "number" && Number.isFinite(targetTimeSec) && targetTimeSec > 0) {
    return getReplaySeriesWithProvenance(symbol, timeframe, targetTimeSec).origin;
  }
  const upper = symbol.trim().toUpperCase();
  const exactKey = `${symbol}_${timeframe}`;
  const upperKey = `${upper}_${timeframe}`;
  if (syntheticSeriesKeys.has(upperKey) || syntheticSeriesKeys.has(exactKey)) {
    return "synthetic";
  }
  if (
    realStockSeriesKeys.has(upperKey) ||
    realStockSeriesKeys.has(exactKey) ||
    bundledFixtureKeys.has(upperKey) ||
    bundledFixtureKeys.has(exactKey)
  ) {
    const direct = series.get(upperKey) ?? series.get(exactKey);
    if (direct && direct.length > 0) return "real";
  }
  const probe = rawSeries(symbol, timeframe);
  if (probe.length === 0) return "unavailable";
  if (syntheticSeriesKeys.has(upperKey) || syntheticSeriesKeys.has(exactKey)) {
    return "synthetic";
  }
  return "aggregated";
}

export function hasAuthenticReplayData(
  symbol: string,
  timeframe: string,
  targetTimeSec: number,
): boolean {
  const res = getReplaySeriesWithProvenance(symbol, timeframe, targetTimeSec);
  return (res.origin === "real" || res.origin === "aggregated") && res.candles.length > 0;
}

export function isReplayDataSynthetic(
  symbol: string,
  timeframe: string,
  targetTimeSec: number,
): boolean {
  return !hasAuthenticReplayData(symbol, timeframe, targetTimeSec);
}

export function getReplayHistory(
  symbol: string,
  timeframe: string,
  targetTimeSec: number,
): Candle[] {
  const resolved = getReplaySeriesWithProvenance(symbol, timeframe, targetTimeSec);
  if (resolved.origin === "real" || resolved.origin === "aggregated") {
    return resolved.candles;
  }
  return [];
}

const PARTIAL_SUB_CANDIDATES = [
  "1m",
  "3m",
  "5m",
  "15m",
  "30m",
  "1h",
  "4h",
  "1s",
] as const;

export function validateSubIntervalCoverage(
  subCandles: ReadonlyArray<Candle>,
  subSec: number,
  candle: Candle,
  tfSec: number,
  rangeStart: number,
  rangeEnd: number,
  options?: { allowSparseProviderCoverage?: boolean },
): boolean {
  if (!Array.isArray(subCandles) || subCandles.length === 0 || !(subSec > 0)) return false;

  const orderedSubs = normalizeSortedUniqueBars(subCandles);
  if (orderedSubs.length === 0) return false;

  const firstSubTime = orderedSubs[0]!.time;
  const lastSubTime = orderedSubs[orderedSubs.length - 1]!.time;
  if (firstSubTime > rangeStart) return false;

  const parentEnd = candle.time + tfSec;
  const parentSubs: Candle[] = [];
  const windowSubs: Candle[] = [];
  const windowSlots = new Set<number>();

  for (const c of orderedSubs) {
    if (c.time >= candle.time && c.time < parentEnd) {
      parentSubs.push(c);
    }
    if (c.time >= rangeStart && c.time < rangeEnd) {
      windowSubs.push(c);
      if ((c.time - rangeStart) % subSec === 0) {
        windowSlots.add(c.time);
      }
    }
  }

  const expectedWindowSlots = Math.max(1, Math.round((rangeEnd - rangeStart) / subSec));
  const hasAllContiguousWindowSlots =
    (rangeEnd - rangeStart) % subSec === 0 &&
    windowSlots.size === expectedWindowSlots &&
    lastSubTime + subSec >= rangeEnd;

  // Enforce strict OHLCV coherence between `candle` and its sub-candles BEFORE accepting
  // any partial reconstruction — including when `candle.volume === 0` or all window slots exist.
  if (!isSubIntervalOhlcvCoherent(candle, parentSubs, windowSubs)) {
    return false;
  }

  if (hasAllContiguousWindowSlots) {
    return true;
  }

  // If any intermediate slot inside `[rangeStart, rangeEnd)` is absent:
  // Never assume absent minutes had zero volume unless provider coverage is verified OR
  // the present sub-candles reconcile 100% of the parent candle's volume & OHLC extremes.
  const surroundsWindow =
    firstSubTime <= candle.time && lastSubTime + subSec >= rangeEnd;

  if (parentSubs.length === 0) {
    return (
      candle.volume === 0 &&
      (surroundsWindow || Boolean(options?.allowSparseProviderCoverage))
    );
  }

  if (candle.volume > 0) {
    let parentSubVol = 0;
    let subHigh = -Infinity;
    let subLow = Infinity;
    for (const c of parentSubs) {
      parentSubVol += c.volume;
      if (c.high > subHigh) subHigh = c.high;
      if (c.low < subLow) subLow = c.low;
    }
    const volTol = Math.max(1e-6, candle.volume * 1e-6);
    const volMatches = Math.abs(parentSubVol - candle.volume) <= volTol;
    const priceTol = Math.max(1e-5, Math.abs(candle.close) * 1e-6);
    const ohlcMatches =
      Math.abs(parentSubs[0]!.open - candle.open) <= priceTol &&
      Math.abs(parentSubs[parentSubs.length - 1]!.close - candle.close) <= priceTol &&
      Math.abs(subHigh - candle.high) <= priceTol &&
      Math.abs(subLow - candle.low) <= priceTol;

    if (volMatches && ohlcMatches && lastSubTime + subSec >= rangeEnd) {
      return true;
    }
    return false;
  }

  // `candle.volume === 0`: already verified above that all `parentSubs` and `windowSubs`
  // have `volume === 0` and OHLC bounds consistent with `candle`.
  return surroundsWindow || Boolean(options?.allowSparseProviderCoverage);
}

function doesSubSeriesCoverParentInterval(
  subCandles: ReadonlyArray<Candle>,
  subSec: number,
  candle: Candle,
  tfSec: number,
  rangeStart: number,
  rangeEnd: number,
): boolean {
  return validateSubIntervalCoverage(
    subCandles,
    subSec,
    candle,
    tfSec,
    rangeStart,
    rangeEnd,
  );
}

export function resolvePartialCandleWindow(
  symbol: string,
  candle: Candle,
  timeframe: string,
  fromSec: number,
  toSec: number,
): PartialCandleResolution {
  const tfSec = TF_SECONDS[timeframe] ?? parseTimeframeSeconds(timeframe);
  if (toSec <= fromSec) return { status: "missing-data" };

  let sawVerifiedEmptyCoverage = false;
  for (const candidate of PARTIAL_SUB_CANDIDATES) {
    const cSec = TF_SECONDS[candidate]!;
    if (cSec >= tfSec) continue;
    if ((fromSec - candle.time) % cSec !== 0 || (toSec - fromSec) % cSec !== 0) continue;

    const resolved = getReplaySeriesWithProvenance(symbol, candidate, toSec - 1);
    if (resolved.origin !== "real") continue;
    const subCandles = normalizeSortedUniqueBars(resolved.candles);
    if (!doesSubSeriesCoverParentInterval(subCandles, cSec, candle, tfSec, fromSec, toSec)) {
      continue;
    }

    const slice = subCandles.filter((c) => c.time >= fromSec && c.time < toSec);
    if (slice.length === 0) {
      sawVerifiedEmptyCoverage = true;
      continue;
    }

    const open = slice[0]!.open;
    const close = slice[slice.length - 1]!.close;
    let high = Math.max(open, close);
    let low = Math.min(open, close);
    let volume = 0;
    for (const c of slice) {
      if (c.high > high) high = c.high;
      if (c.low < low) low = c.low;
      volume += c.volume;
    }
    return {
      status: "ok",
      candle: { time: candle.time, open, high, low, close, volume },
    };
  }

  if (sawVerifiedEmptyCoverage) {
    return { status: "empty-verified" };
  }
  return { status: "missing-data" };
}

export function buildPartialCandleOrNullUpTo(
  symbol: string,
  candle: Candle,
  timeframe: string,
  simTimeSec: number,
): Candle | null {
  const tfSec = TF_SECONDS[timeframe] ?? parseTimeframeSeconds(timeframe);
  if (simTimeSec <= candle.time || simTimeSec >= candle.time + tfSec) {
    return candle;
  }
  const res = resolvePartialCandleWindow(symbol, candle, timeframe, candle.time, simTimeSec);
  return res.status === "ok" ? res.candle : null;
}

export function buildPartialCandleUpTo(
  symbol: string,
  candle: Candle,
  timeframe: string,
  simTimeSec: number,
): Candle {
  return (
    buildPartialCandleOrNullUpTo(symbol, candle, timeframe, simTimeSec) ?? {
      time: candle.time,
      open: candle.open,
      high: candle.open,
      low: candle.open,
      close: candle.open,
      volume: 0,
    }
  );
}

/**
 * Reconstructs the exact OHLCV of `candle` strictly inside `[fromSec, toSec)` using
 * authentic finer-timeframe historical candles. Returns `null` when finer historical data
 * covering `[fromSec, toSec)` is unavailable — NEVER returns the full parent `candle`.
 */
export function buildPartialCandleRange(
  symbol: string,
  candle: Candle,
  timeframe: string,
  fromSec: number,
  toSec: number,
): Candle | null {
  const res = resolvePartialCandleWindow(symbol, candle, timeframe, fromSec, toSec);
  return res.status === "ok" ? res.candle : null;
}

/**
 * Computes a strictly causal `VwapSessionSeed` for Replay when `visibleStartSec` begins after
 * the session anchor (`04:00 ET` / `09:30 ET` / `00:00 UTC`), using ONLY authentic 1-minute bars
 * in `[sessionAnchorSec, Math.min(visibleStartSec, simTimeSec))` whose bar end is `<= simTimeSec`.
 */
export function computeCausalReplayVwapSeed(
  symbol: string,
  visibleStartSec: number,
  simTimeSec: number,
  options: {
    sessionTimeZone?: VwapSessionTimeZone;
    anchorAtRegularOpen?: boolean;
    source?: VwapPriceSource;
    /** When true, provider metadata certifies that absent 1m bars in `[anchorStartSec, cutoffExclusive)` genuinely had zero trades. */
    allowSparseZeroTradeGaps?: boolean;
  } = {},
): VwapSessionSeed | null {
  if (!symbol || !symbol.trim() || !(visibleStartSec > 0) || !(simTimeSec > 0)) return null;
  const upperSym = symbol.trim().toUpperCase();
  const sessionTz: VwapSessionTimeZone = options.sessionTimeZone ?? "america-new-york";
  const anchorAtRegularOpen =
    Boolean(options.anchorAtRegularOpen) && sessionTz === "america-new-york";
  const source: VwapPriceSource = options.source ?? "hlc3";

  const cutoffExclusive = Math.min(visibleStartSec, simTimeSec);
  const anchorStartSec = getSessionAnchorStartSec(
    visibleStartSec,
    sessionTz,
    anchorAtRegularOpen,
  );
  if (cutoffExclusive <= anchorStartSec) return null;

  const resolved1m = getReplaySeriesWithProvenance(upperSym, "1m", simTimeSec - 1);
  if (
    (resolved1m.origin !== "real" &&
      !(resolved1m.origin === "aggregated" && resolved1m.sourceTimeframe === "1s")) ||
    resolved1m.candles.length === 0
  ) {
    return null;
  }
  const bars1m = resolved1m.candles;
  // Require authentic 1m coverage from the session anchor so we never seed an incomplete session
  if (bars1m[0]!.time > anchorStartSec) return null;

  const targetBucket =
    sessionTz === "america-new-york"
      ? getNyTradingDayKey(visibleStartSec)
      : Math.floor(visibleStartSec / 86400);

  // Per-day independent check: never rely on a prior day's bars (or pre-market bars when
  // anchored to 09:30 ET RTH) to assume today's session started at `anchorStartSec`.
  let earliestSameDayBarSec = Infinity;
  for (const b of bars1m) {
    if (anchorAtRegularOpen && b.time < anchorStartSec) continue;
    const bBucket =
      sessionTz === "america-new-york"
        ? getNyTradingDayKey(b.time)
        : Math.floor(b.time / 86400);
    if (bBucket === targetBucket) {
      earliestSameDayBarSec = b.time;
      break;
    }
  }
  if (earliestSameDayBarSec > anchorStartSec) return null;

  // Validate full 1-minute continuity across `[anchorStartSec, cutoffExclusive)` so internal
  // unjustified gaps, duplicates, misaligned timestamps, or invalid volumes invalidate the seed.
  const alignedCutoffSec = Math.floor(cutoffExclusive / 60) * 60;
  const expectedSlots = Math.floor((alignedCutoffSec - anchorStartSec) / 60);
  if (expectedSlots <= 0) return null;

  const seenSlots = new Set<number>();
  let cumVol = 0;
  let mean = 0;
  let sumSqWeightedDiff = 0;

  for (const b of bars1m) {
    if (b.time < anchorStartSec) continue;
    // Strict zero-look-ahead: bar must be completely closed by `simTimeSec` AND strictly prior to `visibleStartSec`
    if (b.time >= cutoffExclusive || b.time + 60 > simTimeSec) break;
    const bBucket =
      sessionTz === "america-new-york"
        ? getNyTradingDayKey(b.time)
        : Math.floor(b.time / 86400);
    if (bBucket !== targetBucket) continue;

    // Reject misaligned or duplicate timestamps inside the seed window
    if (b.time !== Math.floor(b.time) || (b.time - anchorStartSec) % 60 !== 0) {
      return null;
    }
    if (seenSlots.has(b.time)) {
      return null;
    }
    seenSlots.add(b.time);

    if (!Number.isFinite(b.volume) || b.volume < 0) return null;
    if (!(b.volume > 0)) continue;
    const tp =
      source === "close"
        ? b.close
        : source === "hl2"
          ? (b.high + b.low) / 2
          : source === "ohlc4"
            ? (b.open + b.high + b.low + b.close) / 4
            : (b.high + b.low + b.close) / 3;
    if (!Number.isFinite(tp) || tp <= 0) return null;
    const prevMean = mean;
    cumVol += b.volume;
    mean = prevMean + (b.volume / cumVol) * (tp - prevMean);
    sumSqWeightedDiff += b.volume * (tp - prevMean) * (tp - mean);
  }

  if (!options.allowSparseZeroTradeGaps && seenSlots.size !== expectedSlots) {
    return null;
  }

  if (!(cumVol > 0)) return null;
  return {
    anchorBucket: targetBucket,
    cumVol,
    mean,
    sumSqWeightedDiff: Math.max(0, sumSqWeightedDiff),
    coveredUntilSec: cutoffExclusive,
    source,
    symbol: upperSym,
    sessionMode: anchorAtRegularOpen ? "regular" : "extended",
    sessionAnchorSec: anchorStartSec,
    coverageComplete: true,
  };
}

/**
 * Applies a live 1-second IBKR base bar into the in-memory 1s store AND dynamically updates
 * every loaded timeframe series (1s, 1m, 3m, 5m, or any custom timeframe) without double-counting
 * intra-second volume updates.
 */
export function applyIbkrBar1s(
  symbol: string,
  bar1s: Candle,
  vwapState?: IbkrLiveVwapState,
): Array<{ timeframe: string; candle: Candle; isNewBucket: boolean }> {
  if (!Number.isFinite(bar1s.close) || bar1s.close <= 0 || !Number.isFinite(bar1s.time)) {
    return [];
  }
  const upperSym = symbol.trim().toUpperCase();
  const normalized1s: Candle = {
    time: Math.floor(bar1s.time),
    open: bar1s.open,
    high: Math.max(bar1s.high, bar1s.open, bar1s.close),
    low: Math.min(bar1s.low, bar1s.open, bar1s.close),
    close: bar1s.close,
    volume: Number.isFinite(bar1s.volume) && bar1s.volume >= 0 ? bar1s.volume : 0,
  };

  if (vwapState) {
    liveVwapBySymbol.set(upperSym, vwapState);
  }

  const prev1sList = bars1sBySymbol.get(upperSym) ?? [];
  const prevSameSec = prev1sList.find((b) => b.time === normalized1s.time);
  const prevSameSecVol = prevSameSec ? prevSameSec.volume : 0;

  const merged1s = mergeLive1sBarIntoSeries(prev1sList, normalized1s, prevSameSecVol, "1s");
  bars1sBySymbol.set(upperSym, merged1s.bars.slice(-7_200));

  const eventMs = (normalized1s.time + 1) * 1000;
  const prevTs = latestRealStockBarMs.get(upperSym) ?? 0;
  if (eventMs > prevTs) latestRealStockBarMs.set(upperSym, eventMs);

  const updates: Array<{ timeframe: string; candle: Candle; isNewBucket: boolean }> = [];

  // 1s series update if tracked
  const key1s = `${upperSym}_1s`;
  let isNew1s = merged1s.isNewBucket;
  if (series.has(key1s)) {
    const next1s = mergeLive1sBarIntoSeries(
      series.get(key1s) ?? [],
      normalized1s,
      prevSameSecVol,
      "1s",
    );
    isNew1s = next1s.isNewBucket;
    series.set(key1s, next1s.bars.slice(-7_200));
    liveSeriesKeys.add(key1s);
    realStockSeriesKeys.add(key1s);
    if (isNew1s) notifyCandleBucketClosed(upperSym, "1s");
  }
  updates.push({ timeframe: "1s", candle: { ...normalized1s }, isNewBucket: isNew1s });

  // Propagate to all loaded timeframes for this symbol (including 1m, 3m, 5m & dynamic timeframes)
  const prefix = `${upperSym}_`;
  for (const [k, bars] of series.entries()) {
    if (!k.toUpperCase().startsWith(prefix)) continue;
    const tf = k.slice(prefix.length);
    if (tf === "1s" || bars.length === 0) continue;

    const merged = mergeLive1sBarIntoSeries(bars, normalized1s, prevSameSecVol, tf);
    series.set(k, merged.bars);
    if (merged.isNewBucket) {
      notifyCandleBucketClosed(upperSym, tf);
    }
    updates.push({ timeframe: tf, candle: merged.updatedCandle, isNewBucket: merged.isNewBucket });
  }

  return updates;
}

const lastCrypto1mBarBySymbol = new Map<string, Candle>();

/**
 * Applies a live 1-minute cryptocurrency OHLCV bar across all loaded timeframes
 * (1m, 3m, 5m, 15m, 1h, 4h, 1d, etc.) using exact delta volume without double-counting.
 */
export function applyCryptoLiveBar(
  symbol: string,
  bar1m: Candle,
): Array<{ timeframe: string; candle: Candle; isNewBucket: boolean }> {
  if (!Number.isFinite(bar1m.close) || bar1m.close <= 0 || !Number.isFinite(bar1m.time)) {
    return [];
  }
  const upperSym = symbol.trim().toUpperCase();
  const normalized: Candle = {
    time: Math.floor(bar1m.time),
    open: bar1m.open,
    high: Math.max(bar1m.high, bar1m.open, bar1m.close),
    low: Math.min(bar1m.low, bar1m.open, bar1m.close),
    close: bar1m.close,
    volume: Number.isFinite(bar1m.volume) && bar1m.volume >= 0 ? bar1m.volume : 0,
  };

  const existing1mSeries = series.get(`${upperSym}_1m`);
  const prev1m =
    lastCrypto1mBarBySymbol.get(upperSym) ??
    (existing1mSeries && existing1mSeries.length > 0
      ? existing1mSeries[existing1mSeries.length - 1]
      : undefined);
  const isInitialSnapshotWithout1m = !prev1m;
  const prevSameMinVol = prev1m && prev1m.time === normalized.time ? prev1m.volume : 0;
  const volDelta = Math.max(0, normalized.volume - prevSameMinVol);
  lastCrypto1mBarBySymbol.set(upperSym, { ...normalized });

  const eventMs = Date.now();
  const prevTs = latestRealStockBarMs.get(upperSym) ?? 0;
  if (eventMs > prevTs) latestRealStockBarMs.set(upperSym, eventMs);

  const updates: Array<{ timeframe: string; candle: Candle; isNewBucket: boolean }> = [];
  const prefix = `${upperSym}_`;

  for (const [k, bars] of series.entries()) {
    if (!k.toUpperCase().startsWith(prefix)) continue;
    const tf = k.slice(prefix.length);
    if (bars.length === 0) continue;
    const tfSec = parseTimeframeSeconds(tf);
    if (tfSec < 60) continue;

    const bucket = getBucketStartSec(normalized.time, tfSec);
    const nextBars = [...bars];
    const lastIdx = nextBars.length - 1;
    const last = nextBars[lastIdx]!;

    if (bucket < last.time) {
      // Finalized previous 1m bar correction right after rollover
      if (tfSec === 60) {
        const matchIdx = nextBars.findIndex((b) => b.time === bucket);
        if (matchIdx >= 0) {
          nextBars[matchIdx] = { ...normalized };
          series.set(k, nextBars);
        }
      }
      continue;
    }

    if (bucket === last.time) {
      const updated: Candle =
        tfSec === 60
          ? { ...normalized }
          : {
              time: last.time,
              open: last.open,
              high: Math.max(last.high, normalized.high),
              low: Math.min(last.low, normalized.low),
              close: normalized.close,
              volume: isInitialSnapshotWithout1m
                ? Math.max(last.volume, normalized.volume)
                : last.volume + volDelta,
            };
      nextBars[lastIdx] = updated;
      series.set(k, nextBars);
      updates.push({ timeframe: tf, candle: { ...updated }, isNewBucket: false });
      continue;
    }

    const created: Candle = {
      time: bucket,
      open: normalized.open,
      high: normalized.high,
      low: normalized.low,
      close: normalized.close,
      volume: normalized.volume,
    };
    nextBars.push(created);
    series.set(k, nextBars);
    notifyCandleBucketClosed(upperSym, tf);
    updates.push({ timeframe: tf, candle: { ...created }, isNewBucket: true });
  }

  return updates;
}

function parseTargetDateBoundsUtcSec(targetDate: string): {
  dayStartUtcSec: number;
  dayEndNyUtcSec: number;
} | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(targetDate.trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]) - 1;
  const d = Number(m[3]);
  const dayStartUtcSec = Math.floor(Date.UTC(y, mo, d, 0, 0, 0) / 1000);
  const dayEndNyUtcSec = Math.floor(Date.UTC(y, mo, d + 1, 4, 59, 59) / 1000);
  return { dayStartUtcSec, dayEndNyUtcSec };
}

/**
 * Fetches historical OHLCV bars + stabilized EMA warmup history + NY VWAP seeds.
 * - US Equities & Forex route exclusively to Interactive Brokers (`/__api/ibkr-candles`).
 * - Cryptocurrencies & Crypto Perpetuals route to the dedicated Crypto API (`/__api/crypto-candles`).
 */
export async function fetchHistoryAsync(
  symbol: string,
  timeframe: string,
  limit?: number,
  range?: { from?: number; to?: number; fromMs?: number; toMs?: number; targetDate?: string },
): Promise<Candle[]> {
  const upperSym = symbol.trim().toUpperCase();
  const targetDate =
    typeof range?.targetDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(range.targetDate.trim())
      ? range.targetDate.trim()
      : undefined;

  const hasMockedFetch =
    typeof fetch === "function" &&
    typeof (fetch as unknown as { mock?: unknown }).mock === "object";
  if ((isTestEnv() && !hasMockedFetch) || typeof fetch !== "function") {
    if (targetDate) {
      const bounds = parseTargetDateBoundsUtcSec(targetDate);
      return bounds ? getReplayHistory(symbol, timeframe, bounds.dayEndNyUtcSec) : [];
    }
    return getHistory(symbol, timeframe, limit, range);
  }

  const key = targetDate ? `${upperSym}_${timeframe}_hist_${targetDate}` : `${upperSym}_${timeframe}`;
  const toMs = range?.toMs ?? range?.to;
  if (toMs && !targetDate) {
    return getHistory(upperSym, timeframe, limit, range);
  }

  const now = Date.now();
  const lastAt = lastFetchAt.get(key) ?? 0;
  if (targetDate && now - lastAt < 300_000 && historicalTargetSeries.has(key)) {
    const cachedHist = historicalTargetSeries.get(key) ?? [];
    if (cachedHist.length > 0) return [...cachedHist];
  }
  if (!targetDate && now - lastAt < 4_500 && realStockSeriesKeys.has(key)) {
    return getHistory(upperSym, timeframe, limit, range);
  }

  const emaLines = getIndicatorSettings().ema?.lines ?? [];
  const activePeriods = emaLines.filter((l) => l.enabled && l.period > 0).map((l) => l.period);
  const minBars = Math.max(limit ?? 0, computeRequiredWarmupBars(activePeriods));
  const flightKey = `${key}|${minBars}`;
  const existingFlight = inFlightFetches.get(flightKey);
  if (existingFlight) {
    return existingFlight;
  }

  const symMeta = getDemoSymbol(upperSym);
  const isCrypto = isCryptoInstrument(upperSym);
  const params = new URLSearchParams({
    symbol: upperSym,
    timeframe,
    minBars: String(minBars),
  });
  if (!isCrypto && symMeta?.exchange) params.set("exchange", symMeta.exchange);
  if (targetDate) params.set("targetDate", targetDate);

  const endpoint = isCrypto
    ? `/__api/crypto-candles?${params.toString()}`
    : `/__api/ibkr-candles?${params.toString()}`;

  const reqPromise = (async () => {
    try {
      const res = await fetch(endpoint);
      if (!res.ok) {
        // Never substitute live/current candles when a historical targetDate download fails
        return targetDate ? [] : getHistory(upperSym, timeframe, limit, range);
      }
      const payload = (await res.json()) as {
        symbol?: string | null;
        candles?: Candle[];
        regularMarketPrice?: number | null;
        preMarketRanges?: SessionRange[];
        regularMarketRanges?: SessionRange[];
        postMarketRanges?: SessionRange[];
        exchangeTimezoneName?: string | null;
        vwapSeeds?: {
          extended?: VwapSessionSeed | null;
          regular?: VwapSessionSeed | null;
        };
        dataSource?: string | null;
      };

      if (
        typeof payload.symbol === "string" &&
        payload.symbol.trim().length > 0 &&
        payload.symbol.trim().toUpperCase() !== upperSym
      ) {
        return targetDate ? [] : getHistory(upperSym, timeframe, limit, range);
      }

      const sanitizeRanges = (raw: unknown): SessionRange[] =>
        Array.isArray(raw)
          ? raw.filter(
              (r): r is SessionRange =>
                Boolean(r) &&
                typeof (r as SessionRange).start === "number" &&
                Number.isFinite((r as SessionRange).start) &&
                typeof (r as SessionRange).end === "number" &&
                Number.isFinite((r as SessionRange).end) &&
                (r as SessionRange).end > (r as SessionRange).start,
            )
          : [];

      if (payload.vwapSeeds) {
        const seedEntry = {
          extended: payload.vwapSeeds.extended ?? null,
          regular: payload.vwapSeeds.regular ?? null,
        };
        // Isolate VWAP seeds strictly per symbol + timeframe (and targetDate)
        stockVwapSeeds.set(key, seedEntry);
      }

      if (typeof payload.dataSource === "string" && payload.dataSource.trim().length > 0) {
        const nextSrc = payload.dataSource.trim();
        const prevSrc = stockDataSources.get(key);
        stockDataSources.set(key, nextSrc);
        if (prevSrc !== nextSrc) notifyStockDataSourceChanged();
      }

      const incomingMeta: StockSessionMetadata = {
        pre: sanitizeRanges(payload.preMarketRanges),
        regular: sanitizeRanges(payload.regularMarketRanges),
        post: sanitizeRanges(payload.postMarketRanges),
        timezone:
          typeof payload.exchangeTimezoneName === "string"
            ? payload.exchangeTimezoneName
            : "America/New_York",
      };
      stockSessionMeta.set(key, incomingMeta);
      const baseMetaKey = `${upperSym}_${timeframe}`;
      if (targetDate) {
        const prevMeta = stockSessionMeta.get(baseMetaKey);
        if (!prevMeta) {
          stockSessionMeta.set(baseMetaKey, incomingMeta);
        } else {
          const mergeRangeLists = (a: SessionRange[], b: SessionRange[]): SessionRange[] => {
            const byStart = new Map<number, SessionRange>();
            for (const r of a) byStart.set(r.start, r);
            for (const r of b) {
              const cur = byStart.get(r.start);
              byStart.set(r.start, cur ? { start: r.start, end: Math.max(cur.end, r.end) } : r);
            }
            return Array.from(byStart.values()).sort((x, y) => x.start - y.start);
          };
          stockSessionMeta.set(baseMetaKey, {
            pre: mergeRangeLists(prevMeta.pre, incomingMeta.pre),
            regular: mergeRangeLists(prevMeta.regular ?? [], incomingMeta.regular ?? []),
            post: mergeRangeLists(prevMeta.post, incomingMeta.post),
            timezone: incomingMeta.timezone ?? prevMeta.timezone,
          });
        }
      }

      if (Array.isArray(payload.candles) && payload.candles.length > 0) {
        let validBars = normalizeSortedUniqueBars(payload.candles);
        const tfSec = TF_SECONDS[timeframe] ?? parseTimeframeSeconds(timeframe);

        if (targetDate) {
          const bounds = parseTargetDateBoundsUtcSec(targetDate);
          if (!bounds) return [];
          // Strip any stray bar past the requested targetDate session end so future dates can never leak in
          validBars = validBars.filter((b) => b.time <= bounds.dayEndNyUtcSec);
          const isStock =
            (symMeta?.category ?? "").toUpperCase() === "STOCKS" || !isCrypto;
          if (
            validBars.length === 0 ||
            !seriesCoversTargetTime(validBars, tfSec, bounds.dayEndNyUtcSec, isStock) &&
              validBars[validBars.length - 1]!.time < bounds.dayStartUtcSec - 5 * 86_400
          ) {
            return [];
          }

          historicalTargetSeries.set(key, validBars);
          lastFetchAt.set(key, Date.now());

          // Only merge into `baseKey` when `baseKey` is empty or contiguous with `validBars`
          // (no multi-day gap that would distort EMA warmup or mix disjoint dates).
          const baseKey = `${upperSym}_${timeframe}`;
          const existingBase = series.get(baseKey);
          const maxContiguousGap = Math.max(tfSec * 10, 5 * 86_400);
          if (!existingBase || existingBase.length === 0) {
            series.set(baseKey, [...validBars]);
            syntheticSeriesKeys.delete(baseKey);
            liveSeriesKeys.add(baseKey);
            realStockSeriesKeys.add(baseKey);
          } else if (realStockSeriesKeys.has(baseKey)) {
            const histEnd = validBars[validBars.length - 1]!.time;
            const histStart = validBars[0]!.time;
            const baseStart = existingBase[0]!.time;
            const baseEnd = existingBase[existingBase.length - 1]!.time;
            const isContiguous =
              histEnd + maxContiguousGap >= baseStart &&
              baseEnd + maxContiguousGap >= histStart;
            if (isContiguous) {
              const mergedMap = new Map<number, Candle>();
              for (const b of validBars) mergedMap.set(b.time, b);
              for (const b of existingBase) mergedMap.set(b.time, b);
              series.set(
                baseKey,
                Array.from(mergedMap.values()).sort((a, b) => a.time - b.time),
              );
            }
          }
          notifyRealSeriesLoaded(upperSym, timeframe);
          return [...validBars];
        }

        if (validBars.length > 0) {
          const prevBars = realStockSeriesKeys.has(key) ? series.get(key) : undefined;
          if (prevBars && prevBars.length > 0) {
            const prevLast = prevBars[prevBars.length - 1]!;
            const nextLast = validBars[validBars.length - 1]!;
            if (prevLast.time === nextLast.time) {
              nextLast.high = Math.max(nextLast.high, prevLast.high);
              nextLast.low = Math.min(nextLast.low, prevLast.low);
            } else if (prevLast.time > nextLast.time && prevLast.time - nextLast.time <= tfSec * 2) {
              validBars.push({ ...prevLast });
            }
          }

          if (timeframe === "1s") {
            bars1sBySymbol.set(upperSym, validBars.slice(-7_200));
          }
          if (isCrypto && timeframe === "1m" && validBars.length > 0) {
            lastCrypto1mBarBySymbol.set(upperSym, { ...validBars[validBars.length - 1]! });
          }

          const wasMissing = !realStockSeriesKeys.has(key);
          series.set(key, validBars);
          syntheticSeriesKeys.delete(key);
          liveSeriesKeys.add(key);
          realStockSeriesKeys.add(key);
          lastFetchAt.set(key, Date.now());
          if (wasMissing) {
            notifyRealSeriesLoaded(upperSym, timeframe);
          }

          const latestBar = validBars[validBars.length - 1]!;
          const latestClose = latestBar.close;
          const prevTsMs = latestRealStockBarMs.get(upperSym) ?? 0;
          const { isFresherBar, quoteTsMs } = evaluateStockBarQuoteFreshness(
            latestBar.time,
            timeframe,
            prevTsMs,
          );
          if (quoteTsMs > prevTsMs && (tfSec < 86_400 || prevTsMs === 0)) {
            latestRealStockBarMs.set(upperSym, quoteTsMs);
          }

          const livePrice =
            typeof payload.regularMarketPrice === "number" &&
            Number.isFinite(payload.regularMarketPrice) &&
            payload.regularMarketPrice > 0
              ? payload.regularMarketPrice
              : latestClose > 0
                ? latestClose
                : 0;
          const isIntraday = tfSec < 86_400;
          if (symMeta && livePrice > 0 && (isFresherBar || isIntraday)) {
            symMeta.initialPrice = livePrice;
          }
          const notifyTsMs = Math.max(quoteTsMs, prevTsMs);
          if (livePrice > 0 && notifyTsMs > 0 && (isFresherBar || isIntraday)) {
            for (const cb of stockQuoteListeners) {
              try {
                cb(upperSym, livePrice, notifyTsMs);
              } catch {
                // ignore subscriber errors
              }
            }
          }
        }
      }
    } catch {
      // Request aborted or gateway temporarily unavailable — never return current live series for targetDate
      if (targetDate) return [];
    } finally {
      inFlightFetches.delete(flightKey);
    }
    if (targetDate) {
      return [];
    }
    return getHistory(upperSym, timeframe, limit, range);
  })();

  inFlightFetches.set(flightKey, reqPromise);
  return reqPromise;
}

export interface EnsureReplayHistoryParams {
  symbol: string;
  primaryTimeframe: string;
  additionalTimeframes?: ReadonlyArray<string>;
  secondarySymbols?: ReadonlyArray<{ symbol: string; timeframe: string }>;
  targetDate: string;
  targetTimeSec: number;
  anchorAtRegularOpen?: boolean;
  /** Active EMA periods to validate warm-up bar depth up to `targetTimeSec`. */
  emaPeriods?: ReadonlyArray<number>;
}

export interface EnsureReplayHistoryResult {
  ok: boolean;
  error?: string;
  warnings: string[];
  emaWarmup?: EmaWarmupAssessment;
  vwap1mComplete?: boolean;
}

/**
 * Ensures all authentic historical series required for a Replay session are downloaded,
 * validated for symbol, date coverage, 1m session-anchor coverage, and EMA warm-up depth
 * BEFORE playback begins.
 */
export async function ensureReplayHistoricalDataLoaded(
  params: EnsureReplayHistoryParams,
): Promise<EnsureReplayHistoryResult> {
  const {
    symbol,
    primaryTimeframe,
    additionalTimeframes = [],
    secondarySymbols = [],
    targetDate,
    targetTimeSec,
    anchorAtRegularOpen = false,
    emaPeriods,
  } = params;
  const upperSym = symbol.trim().toUpperCase();
  const symMeta = getDemoSymbol(upperSym);
  const isStock =
    (symMeta?.category ?? "").toUpperCase() === "STOCKS" || hasRealStockSeries(upperSym);
  const isCrypto = isCryptoInstrument(upperSym);
  const warnings: string[] = [];

  const allSameSymbolTfs = new Set<string>([primaryTimeframe, ...additionalTimeframes]);
  let needs1mForIntraday = false;
  for (const tf of allSameSymbolTfs) {
    const sec = TF_SECONDS[tf] ?? parseTimeframeSeconds(tf);
    if (sec > 60 && sec < 86_400) {
      needs1mForIntraday = true;
    }
  }
  if ((isStock || isCrypto) && needs1mForIntraday) {
    allSameSymbolTfs.add("1m");
  }

  const sessionTz: VwapSessionTimeZone = isStock ? "america-new-york" : "utc";
  const targetDayBucket =
    sessionTz === "america-new-york"
      ? getNyTradingDayKey(targetTimeSec)
      : Math.floor(targetTimeSec / 86400);

  const configuredPeriods =
    emaPeriods ??
    (getIndicatorSettings().ema?.lines ?? [])
      .filter((l) => l.enabled && l.period > 0)
      .map((l) => l.period);
  const minEmaWarmupBars =
    configuredPeriods.length > 0
      ? Math.max(...configuredPeriods.map((p) => computeMinEmaWarmupBars(p)))
      : 0;
  const minBars = Math.max(computeRequiredWarmupBars(configuredPeriods), minEmaWarmupBars);

  const needsFetchForTf = (sym: string, tf: string): boolean => {
    const cleanSym = sym.trim().toUpperCase();
    const histCacheKey = `${cleanSym}_${tf}_hist_${targetDate}`;
    const alreadyFetchedTarget = historicalTargetSeries.has(histCacheKey);
    const directCandidates = getDirectAuthenticCandidates(sym, tf);
    const tfSec = TF_SECONDS[tf] ?? parseTimeframeSeconds(tf);
    const symIsStock =
      (getDemoSymbol(sym)?.category ?? "").toUpperCase() === "STOCKS" || hasRealStockSeries(sym);
    for (const bars of directCandidates) {
      if (!seriesCoversTargetTime(bars, tfSec, targetTimeSec, symIsStock)) continue;
      if (tf === "1m" && tfSec < 86_400) {
        const upToTarget = bars.filter((b) => b.time <= targetTimeSec);
        const cov = assessVwapSessionCoverage(upToTarget, {
          anchor: "session",
          sessionTimeZone: symIsStock ? "america-new-york" : "utc",
          anchorAtRegularOpen,
        });
        const targetDayOk = cov.days?.[targetDayBucket]?.isComplete ?? cov.isComplete;
        if (!targetDayOk && !alreadyFetchedTarget) {
          continue;
        }
      }
      if (minEmaWarmupBars > 0 && !alreadyFetchedTarget) {
        const barsUpToTarget = findBarIndexAtOrBefore(bars, targetTimeSec) + 1;
        if (barsUpToTarget < minEmaWarmupBars) {
          continue; // Insufficient prior warmup bars cached -> try fetching deeper targetDate history
        }
      }
      return false;
    }
    return true;
  };

  const fetchTasks: Array<Promise<{ sym: string; tf: string; bars: Candle[] }>> = [];
  for (const tf of allSameSymbolTfs) {
    if (needsFetchForTf(upperSym, tf)) {
      fetchTasks.push(
        fetchHistoryAsync(upperSym, tf, minBars, { targetDate }).then((bars) => ({
          sym: upperSym,
          tf,
          bars,
        })),
      );
    }
  }
  for (const item of secondarySymbols) {
    const cleanSecSym = item.symbol.trim().toUpperCase();
    if (!cleanSecSym || cleanSecSym === upperSym) continue;
    if (needsFetchForTf(cleanSecSym, item.timeframe)) {
      fetchTasks.push(
        fetchHistoryAsync(cleanSecSym, item.timeframe, minBars, { targetDate }).then((bars) => ({
          sym: cleanSecSym,
          tf: item.timeframe,
          bars,
        })),
      );
    }
    const secTfSec = TF_SECONDS[item.timeframe] ?? parseTimeframeSeconds(item.timeframe);
    if (secTfSec > 60 && secTfSec < 86_400 && needsFetchForTf(cleanSecSym, "1m")) {
      fetchTasks.push(
        fetchHistoryAsync(cleanSecSym, "1m", minBars, { targetDate }).then((bars) => ({
          sym: cleanSecSym,
          tf: "1m",
          bars,
        })),
      );
    }
  }

  if (fetchTasks.length > 0) {
    await Promise.all(fetchTasks);
  }

  const primaryResolved = getReplaySeriesWithProvenance(upperSym, primaryTimeframe, targetTimeSec);
  if (
    (primaryResolved.origin !== "real" && primaryResolved.origin !== "aggregated") ||
    primaryResolved.candles.length === 0
  ) {
    return {
      ok: false,
      error: `No hay datos históricos reales disponibles de ${upperSym} (${primaryTimeframe}) para ${targetDate}.`,
      warnings,
      vwap1mComplete: false,
    };
  }

  const primaryTfSec = TF_SECONDS[primaryTimeframe] ?? parseTimeframeSeconds(primaryTimeframe);
  const primaryContinuity = assessSeriesOpenSessionContinuity(
    primaryResolved.candles,
    primaryTfSec,
    targetTimeSec,
    isStock,
  );
  if (!primaryContinuity.isContinuous) {
    const totalMissing = primaryContinuity.gaps.reduce((acc, g) => acc + g.missingBars, 0);
    return {
      ok: false,
      error: `Histórico incompleto para ${upperSym} (${primaryTimeframe}) en ${targetDate}: se detectaron ${primaryContinuity.gaps.length} hueco(s) (${totalMissing} velas faltantes) durante la sesión abierta.`,
      warnings,
      vwap1mComplete: false,
    };
  }

  const primaryIdxAtTarget = findBarIndexAtOrBefore(primaryResolved.candles, targetTimeSec);
  const barsAvailableForWarmup = primaryIdxAtTarget >= 0 ? primaryIdxAtTarget + 1 : 0;
  const emaWarmup = assessEmaWarmup(barsAvailableForWarmup, configuredPeriods);
  if (!emaWarmup.isSufficient) {
    const firstInsuff = emaWarmup.insufficientPeriods[0]!;
    warnings.push(
      `Histórico insuficiente para calentamiento completo de EMA ${firstInsuff.period} (${firstInsuff.availableBars}/${firstInsuff.requiredMinBars} velas previas).`,
    );
  }

  let vwap1mComplete = true;
  if (needs1mForIntraday && (isStock || isCrypto)) {
    const resolved1m = getReplaySeriesWithProvenance(upperSym, "1m", targetTimeSec);
    if (resolved1m.origin !== "real" || resolved1m.candles.length === 0) {
      vwap1mComplete = false;
      warnings.push(
        `No se pudieron cargar velas reales de 1m para ${upperSym} en ${targetDate}; el VWAP intradía requiere histórico real de 1 minuto.`,
      );
    } else {
      const bars1mUpToTarget = resolved1m.candles.filter((b) => b.time <= targetTimeSec);
      const cov1m = assessVwapSessionCoverage(bars1mUpToTarget, {
        anchor: "session",
        sessionTimeZone: sessionTz,
        anchorAtRegularOpen,
        expectedBarStepSec: 60,
        validateInternalGaps: true,
        symbol: upperSym,
      });
      const dayComplete = cov1m.days?.[targetDayBucket]?.isComplete ?? cov1m.isComplete;
      if (!dayComplete) {
        vwap1mComplete = false;
        warnings.push(
          cov1m.hasInternalGaps
            ? `El histórico de 1m para ${upperSym} en esta sesión presenta huecos internos; el VWAP se oculta para evitar cálculos inexactos.`
            : `El histórico de 1m para ${upperSym} en esta sesión empieza después del inicio (${anchorAtRegularOpen ? "09:30 ET" : "04:00 ET"}); la sesión está incompleta para el VWAP.`,
        );
      }
    }
  }

  for (const tf of additionalTimeframes) {
    if (tf === primaryTimeframe) continue;
    const secRes = getReplaySeriesWithProvenance(upperSym, tf, targetTimeSec);
    if (secRes.origin !== "real" && secRes.origin !== "aggregated") {
      warnings.push(
        `El panel secundario (${tf}) no dispone de datos históricos reales para ${targetDate}.`,
      );
    }
  }

  return { ok: true, warnings, emaWarmup, vwap1mComplete };
}

/** Update the latest bar in memory when a live quote/tick arrives. */
export function updateLatestBarPrice(
  symbol: string,
  price: number,
  occurredAtMs?: number,
  tradeVolume = 0,
): Array<{ timeframe: string; candle: Candle; isNewBucket?: boolean }> {
  if (!Number.isFinite(price) || price <= 0) return [];
  const safeVol = Number.isFinite(tradeVolume) && tradeVolume > 0 ? tradeVolume : 0;
  const upperSym = symbol.trim().toUpperCase();
  const isStock = (getDemoSymbol(symbol)?.category ?? "").toUpperCase() === "STOCKS";
  const hasRealEventTime =
    typeof occurredAtMs === "number" && Number.isFinite(occurredAtMs) && occurredAtMs > 0;
  const updatedBars: Array<{ timeframe: string; candle: Candle; isNewBucket?: boolean }> = [];

  if (isStock && hasRealEventTime) {
    const prevTs = latestRealStockBarMs.get(upperSym) ?? 0;
    if (occurredAtMs > prevTs) {
      latestRealStockBarMs.set(upperSym, occurredAtMs);
    }
  }

  const candidateTfs = new Set<string>(Object.keys(BASE_TF_SECONDS));
  const prefix = `${upperSym}_`;
  for (const k of series.keys()) {
    if (k.toUpperCase().startsWith(prefix)) {
      candidateTfs.add(k.slice(prefix.length));
    }
  }

  for (const tf of candidateTfs) {
    const upperKey = `${upperSym}_${tf}`;
    const exactKey = `${symbol}_${tf}`;
    const key = series.has(upperKey) ? upperKey : exactKey;
    const bars = series.get(key);
    if (!bars || bars.length === 0) continue;

    if (isStock) {
      if (!realStockSeriesKeys.has(key) && !realStockSeriesKeys.has(upperKey)) continue;
      const last = bars[bars.length - 1]!;
      if (hasRealEventTime) {
        const bucket = bucketSecAt(occurredAtMs, tf);
        if (bucket < last.time) continue;
        if (bucket > last.time) {
          const created: Candle = {
            time: bucket,
            open: price,
            high: price,
            low: price,
            close: price,
            volume: safeVol,
          };
          bars.push(created);
          notifyCandleBucketClosed(upperSym, tf);
          updatedBars.push({ timeframe: tf, candle: { ...created }, isNewBucket: true });
          continue;
        }
      }
      const updatedStock: Candle = {
        ...last,
        close: price,
        high: Math.max(last.high, price),
        low: Math.min(last.low, price),
        volume: safeVol > 0 ? last.volume + safeVol : last.volume,
      };
      bars[bars.length - 1] = updatedStock;
      updatedBars.push({ timeframe: tf, candle: { ...updatedStock }, isNewBucket: false });
      continue;
    }

    const last = bars[bars.length - 1]!;
    if (liveSeriesKeys.has(key)) {
      const bucket = hasRealEventTime ? bucketSecAt(occurredAtMs, tf) : currentBucketSec(tf);
      if (bucket > last.time) {
        const created: Candle = {
          time: bucket,
          open: price,
          high: price,
          low: price,
          close: price,
          volume: 0,
        };
        bars.push(created);
        notifyCandleBucketClosed(upperSym, tf);
        updatedBars.push({ timeframe: tf, candle: { ...created }, isNewBucket: true });
        continue;
      }
    }
    const updatedOther: Candle = {
      ...last,
      close: price,
      high: Math.max(last.high, price),
      low: Math.min(last.low, price),
    };
    bars[bars.length - 1] = updatedOther;
    updatedBars.push({ timeframe: tf, candle: { ...updatedOther }, isNewBucket: false });
  }
  return updatedBars;
}

export function getTickPrices(symbol: string): number[] {
  const bars = rawSeries(symbol, "1m");
  return bars.map((c) => c.close);
}

export function getSeedPrice(symbol: string): number {
  const bars = rawSeries(symbol, "1m");
  if (bars.length > 0) return bars[bars.length - 1]!.close;
  return getDemoSymbol(symbol)?.initialPrice ?? 0;
}
