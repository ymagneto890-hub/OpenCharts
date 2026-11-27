import type { Candle } from "../schemas.ts";
import type { VwapSessionSeed } from "../../lib/indicators.ts";
import {
  aggregateCandles,
  computeRequiredWarmupBars,
  getBucketStartSec,
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

const TF_HIERARCHY = ["1w", "1d", "4h", "1h", "30m", "15m", "5m", "1m"] as const;
const TF_HIERARCHY_3M = ["1w", "1d", "4h", "1h", "30m", "15m", "3m", "1m"] as const;
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
if (isTestEnv()) {
  for (const [path, mod] of Object.entries(modules)) {
    if (!Array.isArray(mod.default)) continue;
    const key = path.replace("./data/", "").replace(".json", "");
    series.set(
      key,
      (mod.default as Candle[]).map((c) => ({ ...c })),
    );
  }
}

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
  const seeds =
    (timeframe ? stockVwapSeeds.get(`${upper}_${timeframe}`) : undefined) ??
    stockVwapSeeds.get(upper);
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
  stockVwapSeeds.delete(upper);
  for (const k of Array.from(stockVwapSeeds.keys())) {
    if (k.toUpperCase().startsWith(prefix)) stockVwapSeeds.delete(k);
  }
  bars1sBySymbol.delete(upper);
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
    realStockSeriesKeys.has(`${upper}_1m`) &&
    oneMin &&
    oneMin.length >= 180 &&
    targetSec > 60 &&
    targetSec % 60 === 0 &&
    targetSec <= 300
  ) {
    const resampled = resampleCandles(oneMin, targetSec);
    if (resampled.length > 0) return resampled;
  }

  if (!isTestEnv()) {
    return [];
  }

  if (timeframe === "3m" && oneMin && oneMin.length > 0) {
    const resampled3m = resampleCandles(oneMin, 180);
    if (resampled3m.length > 0) {
      series.set(key, resampled3m);
      if (liveSeriesKeys.has(`${symbol}_1m`)) liveSeriesKeys.add(key);
      return resampled3m;
    }
  }

  const sym = getDemoSymbol(symbol);
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
      if (liveSeriesKeys.has(liveSourceKey)) liveSeriesKeys.add(key);
      return scaled;
    }
  }

  const synthesized = synthesizeTestFixtureSeries(symbol, timeframe);
  if (synthesized.length > 0) {
    series.set(key, synthesized);
    liveSeriesKeys.add(key);
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

// ── Test-Only Replay Helpers ───────────────────────────────────────────────────
function seededRand(seed: number): () => number {
  let s = (seed ^ 0x9e3779b9) >>> 0;
  return () => {
    s = Math.imul(s ^ (s >>> 16), 0x21f0aaad);
    s = Math.imul(s ^ (s >>> 15), 0x735a2d97);
    return ((s = s ^ (s >>> 15)) >>> 0) / 4294967296;
  };
}

function subdivideCandle(parent: Candle, parentSec: number, childSec: number): Candle[] {
  const count = Math.max(1, Math.round(parentSec / childSec));
  if (count <= 1) return [{ ...parent }];

  const rand = seededRand(parent.time ^ Math.imul(childSec, 2654435761));
  const range = Math.max(0, parent.high - parent.low);
  const isBull = parent.close >= parent.open;

  let firstIdx = Math.floor(rand() * Math.max(1, Math.floor(count / 2)));
  let secondIdx =
    Math.floor(count / 2) + Math.floor(rand() * Math.max(1, count - Math.floor(count / 2)));
  if (secondIdx >= count) secondIdx = count - 1;
  if (firstIdx === secondIdx) {
    firstIdx = 0;
    secondIdx = count - 1;
  }

  const lowIdx = isBull ? firstIdx : secondIdx;
  const highIdx = isBull ? secondIdx : firstIdx;

  const firstExtreme = isBull
    ? parent.low + range * (0.05 + rand() * 0.15)
    : parent.high - range * (0.05 + rand() * 0.15);
  const secondExtreme = isBull
    ? parent.high - range * (0.05 + rand() * 0.15)
    : parent.low + range * (0.05 + rand() * 0.15);

  const closes: number[] = new Array(count);
  for (let i = 0; i < count; i++) {
    if (i === count - 1) {
      closes[i] = parent.close;
      continue;
    }
    let base: number;
    if (i <= firstIdx) {
      const t = firstIdx === 0 ? 1 : (i + 1) / (firstIdx + 1);
      base = parent.open + (firstExtreme - parent.open) * t;
    } else if (i <= secondIdx) {
      const t = (i - firstIdx) / Math.max(1, secondIdx - firstIdx);
      base = firstExtreme + (secondExtreme - firstExtreme) * t;
    } else {
      const t = (i - secondIdx) / Math.max(1, count - 1 - secondIdx);
      base = secondExtreme + (parent.close - secondExtreme) * t;
    }
    const noise = (rand() - 0.5) * range * 0.18;
    closes[i] = Math.min(parent.high, Math.max(parent.low, base + noise));
  }

  const rawWeights: number[] = new Array(count);
  let weightSum = 0;
  for (let i = 0; i < count; i++) {
    const w = 0.5 + rand();
    rawWeights[i] = w;
    weightSum += w;
  }

  const children: Candle[] = new Array(count);
  for (let i = 0; i < count; i++) {
    const open = i === 0 ? parent.open : closes[i - 1]!;
    const close = closes[i]!;
    const bodyHigh = Math.max(open, close);
    const bodyLow = Math.min(open, close);
    const high =
      i === highIdx
        ? parent.high
        : Math.min(parent.high, bodyHigh + range * (0.02 + rand() * 0.14));
    const low =
      i === lowIdx
        ? parent.low
        : Math.max(parent.low, bodyLow - range * (0.02 + rand() * 0.14));
    const volume =
      weightSum > 0 ? (parent.volume * rawWeights[i]!) / weightSum : parent.volume / count;

    children[i] = {
      time: parent.time + i * childSec,
      open,
      high,
      low,
      close,
      volume,
    };
  }
  return children;
}

export function setRealStockSeries(symbol: string, timeframe: string, bars: Candle[]): void {
  const cleanSym = symbol.trim().toUpperCase();
  const key = `${cleanSym}_${timeframe}`;
  const sorted = [...bars]
    .filter(
      (b) =>
        b &&
        Number.isFinite(b.time) &&
        Number.isFinite(b.open) &&
        Number.isFinite(b.high) &&
        Number.isFinite(b.low) &&
        Number.isFinite(b.close) &&
        b.close > 0,
    )
    .map((b) => ({
      time: Math.floor(b.time),
      open: b.open,
      high: Math.max(b.high, b.open, b.close),
      low: Math.min(b.low, b.open, b.close),
      close: b.close,
      volume: typeof b.volume === "number" && Number.isFinite(b.volume) && b.volume >= 0 ? b.volume : 0,
    }))
    .sort((a, b) => a.time - b.time);
  series.set(key, sorted);
  liveSeriesKeys.add(key);
  const wasMissing = !realStockSeriesKeys.has(key);
  realStockSeriesKeys.add(key);
  if (wasMissing) {
    notifyRealSeriesLoaded(cleanSym, timeframe);
  }
}

export function isReplayDataSynthetic(symbol: string, timeframe: string, targetTimeSec: number): boolean {
  const tfSec = TF_SECONDS[timeframe] ?? 60;
  const direct = getHistory(symbol, timeframe);
  if (direct.length === 0 || direct[direct.length - 1]!.time + tfSec < targetTimeSec) {
    return true;
  }
  const key = `${symbol.trim().toUpperCase()}_${timeframe}`;
  if (realStockSeriesKeys.has(key) || realStockSeriesKeys.has(`${symbol}_${timeframe}`)) {
    return direct[0]!.time > targetTimeSec;
  }
  return direct[0]!.time > targetTimeSec - tfSec * 30;
}

export function getReplayHistory(symbol: string, timeframe: string, targetTimeSec: number): Candle[] {
  const direct = getHistory(symbol, timeframe);
  if (!isReplayDataSynthetic(symbol, timeframe, targetTimeSec)) {
    return direct;
  }

  const hierarchy = timeframe === "3m" ? TF_HIERARCHY_3M : TF_HIERARCHY;
  const targetHIdx = (hierarchy as readonly string[]).indexOf(timeframe);
  if (targetHIdx <= 0) return direct;

  let ancIdx = -1;
  for (let i = targetHIdx - 1; i >= 0; i--) {
    const candidate = getHistory(symbol, hierarchy[i]!);
    if (candidate.length > 0 && candidate[0]!.time <= targetTimeSec) {
      ancIdx = i;
      break;
    }
  }
  if (ancIdx < 0) return direct;

  let currentBars = getHistory(symbol, hierarchy[ancIdx]!);
  for (let step = ancIdx + 1; step <= targetHIdx; step++) {
    const parentTf = hierarchy[step - 1]!;
    const childTf = hierarchy[step]!;
    const parentSec = TF_SECONDS[parentTf]!;
    const childSec = TF_SECONDS[childTf]!;

    const spanSec = Math.max(childSec * 1200, parentSec * 60);
    const minParentTime = targetTimeSec - spanSec;
    const maxParentTime = targetTimeSec + spanSec;
    const windowedParents = currentBars.filter(
      (b) => b.time + parentSec >= minParentTime && b.time <= maxParentTime,
    );
    const sourceParents = windowedParents.length > 0 ? windowedParents : currentBars;

    const nextBars: Candle[] = [];
    for (const p of sourceParents) {
      const sub = subdivideCandle(p, parentSec, childSec);
      for (const c of sub) nextBars.push(c);
    }
    currentBars = nextBars;
  }

  return currentBars;
}

export function buildPartialCandleOrNullUpTo(
  symbol: string,
  candle: Candle,
  timeframe: string,
  simTimeSec: number,
): Candle | null {
  const tfSec = TF_SECONDS[timeframe] ?? 60;
  if (simTimeSec <= candle.time || simTimeSec >= candle.time + tfSec) {
    return candle;
  }

  const elapsed = simTimeSec - candle.time;
  const upperSym = symbol.trim().toUpperCase();
  const hasReal1m =
    realStockSeriesKeys.has(`${upperSym}_1m`) || realStockSeriesKeys.has(`${symbol}_1m`);
  let subTf = "1m";
  for (const candidate of ["1d", "4h", "1h", "30m", "15m", "5m", "3m", "1m"] as const) {
    const cSec = TF_SECONDS[candidate]!;
    if (tfSec > cSec && elapsed % cSec === 0) {
      if (
        hasReal1m &&
        candidate !== "1m" &&
        !realStockSeriesKeys.has(`${upperSym}_${candidate}`) &&
        !realStockSeriesKeys.has(`${symbol}_${candidate}`)
      ) {
        continue;
      }
      subTf = candidate;
      break;
    }
  }

  const subCandles = getReplayHistory(symbol, subTf, simTimeSec);
  const slice = subCandles.filter((c) => c.time >= candle.time && c.time < simTimeSec);
  if (slice.length === 0) {
    const subCoversBucket =
      subCandles.length > 0 &&
      subCandles[0]!.time <= candle.time &&
      subCandles[subCandles.length - 1]!.time >= candle.time;
    if (subCoversBucket) return null;
    return {
      time: candle.time,
      open: candle.open,
      high: candle.open,
      low: candle.open,
      close: candle.open,
      volume: 0,
    };
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

  return { time: candle.time, open, high, low, close, volume };
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

export function buildPartialCandleRange(
  symbol: string,
  candle: Candle,
  timeframe: string,
  fromSec: number,
  toSec: number,
): Candle {
  const tfSec = TF_SECONDS[timeframe] ?? 60;
  let subTf = "1m";
  for (const candidate of ["1d", "4h", "1h", "30m", "15m", "5m", "3m", "1m"] as const) {
    const cSec = TF_SECONDS[candidate]!;
    if (tfSec > cSec && (fromSec - candle.time) % cSec === 0 && (toSec - fromSec) % cSec === 0) {
      subTf = candidate;
      break;
    }
  }
  const subCandles = getReplayHistory(symbol, subTf, toSec);
  const slice = subCandles.filter((c) => c.time >= fromSec && c.time < toSec);
  if (slice.length === 0) return candle;

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
  return { time: candle.time, open, high, low, close, volume };
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

  const prev1m = lastCrypto1mBarBySymbol.get(upperSym);
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
              volume: last.volume + volDelta,
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
  if (isTestEnv() || typeof fetch !== "function") {
    return getHistory(symbol, timeframe, limit, range);
  }

  const upperSym = symbol.trim().toUpperCase();
  const targetDate =
    typeof range?.targetDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(range.targetDate.trim())
      ? range.targetDate.trim()
      : undefined;
  const key = targetDate ? `${upperSym}_${timeframe}_hist_${targetDate}` : `${upperSym}_${timeframe}`;
  const toMs = range?.toMs ?? range?.to;
  if (toMs && !targetDate) {
    return getHistory(upperSym, timeframe, limit, range);
  }

  const now = Date.now();
  const lastAt = lastFetchAt.get(key) ?? 0;
  if (targetDate && now - lastAt < 300_000 && series.has(key)) {
    return [...(series.get(key) ?? [])];
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
        return getHistory(upperSym, timeframe, limit, range);
      }
      const payload = (await res.json()) as {
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
        stockVwapSeeds.set(targetDate ? `${upperSym}_${timeframe}` : key, seedEntry);
        if (seedEntry.extended || seedEntry.regular) {
          stockVwapSeeds.set(upperSym, seedEntry);
        }
      }

      if (typeof payload.dataSource === "string" && payload.dataSource.trim().length > 0) {
        const nextSrc = payload.dataSource.trim();
        const prevSrc = stockDataSources.get(key);
        stockDataSources.set(key, nextSrc);
        if (prevSrc !== nextSrc) notifyStockDataSourceChanged();
      }

      stockSessionMeta.set(targetDate ? `${upperSym}_${timeframe}` : key, {
        pre: sanitizeRanges(payload.preMarketRanges),
        regular: sanitizeRanges(payload.regularMarketRanges),
        post: sanitizeRanges(payload.postMarketRanges),
        timezone:
          typeof payload.exchangeTimezoneName === "string"
            ? payload.exchangeTimezoneName
            : "America/New_York",
      });

      if (Array.isArray(payload.candles) && payload.candles.length > 0) {
        const validBars = payload.candles
          .filter(
            (b) =>
              b &&
              Number.isFinite(b.time) &&
              Number.isFinite(b.open) &&
              Number.isFinite(b.high) &&
              Number.isFinite(b.low) &&
              Number.isFinite(b.close) &&
              b.close > 0,
          )
          .map((b) => ({
            time: Math.floor(b.time),
            open: b.open,
            high: Math.max(b.high, b.open, b.close),
            low: Math.min(b.low, b.open, b.close),
            close: b.close,
            volume: typeof b.volume === "number" && Number.isFinite(b.volume) ? b.volume : 0,
          }));

        if (validBars.length > 0) {
          if (targetDate) {
            series.set(key, validBars);
            lastFetchAt.set(key, Date.now());
            // Merge historical targetDate bars into the primary symbol/timeframe store so
            // Bar Replay (1m, 3m, 5m) steps over 100% real IBKR candles & volume without synthetic fallback.
            const baseKey = `${upperSym}_${timeframe}`;
            const mergedMap = new Map<number, Candle>();
            for (const b of validBars) mergedMap.set(b.time, b);
            for (const b of series.get(baseKey) ?? []) mergedMap.set(b.time, b);
            const mergedBars = Array.from(mergedMap.values()).sort((a, b) => a.time - b.time);
            series.set(baseKey, mergedBars);
            liveSeriesKeys.add(baseKey);
            const wasBaseMissing = !realStockSeriesKeys.has(baseKey);
            realStockSeriesKeys.add(baseKey);
            notifyRealSeriesLoaded(upperSym, timeframe);
            if (wasBaseMissing) {
              lastFetchAt.set(baseKey, Date.now());
            }
            return [...validBars];
          }

          const prevBars = realStockSeriesKeys.has(key) ? series.get(key) : undefined;
          if (prevBars && prevBars.length > 0) {
            const prevLast = prevBars[prevBars.length - 1]!;
            const nextLast = validBars[validBars.length - 1]!;
            const tfSec = TF_SECONDS[timeframe] ?? 60;
            if (prevLast.time === nextLast.time) {
              nextLast.high = Math.max(nextLast.high, prevLast.high);
              nextLast.low = Math.min(nextLast.low, prevLast.low);
              nextLast.volume = Math.max(nextLast.volume, prevLast.volume);
            } else if (prevLast.time > nextLast.time && prevLast.time - nextLast.time <= tfSec * 2) {
              validBars.push({ ...prevLast });
            }
          }

          if (timeframe === "1s") {
            bars1sBySymbol.set(upperSym, validBars.slice(-7_200));
          }

          const wasMissing = !realStockSeriesKeys.has(key);
          series.set(key, validBars);
          liveSeriesKeys.add(key);
          realStockSeriesKeys.add(key);
          lastFetchAt.set(key, Date.now());
          if (wasMissing) {
            notifyRealSeriesLoaded(upperSym, timeframe);
          }

          const latestBar = validBars[validBars.length - 1]!;
          const latestClose = latestBar.close;
          const prevTsMs = latestRealStockBarMs.get(upperSym) ?? 0;
          const tfSec = TF_SECONDS[timeframe] ?? 60;
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
      // Request aborted or gateway temporarily unavailable — preserve existing cached real series
    } finally {
      inFlightFetches.delete(flightKey);
    }
    if (targetDate) {
      return [...(series.get(key) ?? [])];
    }
    return getHistory(upperSym, timeframe, limit, range);
  })();

  inFlightFetches.set(flightKey, reqPromise);
  return reqPromise;
}

/** Update the latest bar in memory when a live quote/tick arrives. */
export function updateLatestBarPrice(
  symbol: string,
  price: number,
  occurredAtMs?: number,
  tradeVolume = 0,
): Array<{ timeframe: string; candle: Candle }> {
  if (!Number.isFinite(price) || price <= 0) return [];
  const safeVol = Number.isFinite(tradeVolume) && tradeVolume > 0 ? tradeVolume : 0;
  const upperSym = symbol.trim().toUpperCase();
  const isStock = (getDemoSymbol(symbol)?.category ?? "").toUpperCase() === "STOCKS";
  const hasRealEventTime =
    typeof occurredAtMs === "number" && Number.isFinite(occurredAtMs) && occurredAtMs > 0;
  const updatedBars: Array<{ timeframe: string; candle: Candle }> = [];

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
          updatedBars.push({ timeframe: tf, candle: { ...created } });
          continue;
        }
      }
      last.close = price;
      if (price > last.high) last.high = price;
      if (price < last.low) last.low = price;
      if (safeVol > 0) last.volume += safeVol;
      updatedBars.push({ timeframe: tf, candle: { ...last } });
      continue;
    }

    const last = bars[bars.length - 1]!;
    if (liveSeriesKeys.has(key)) {
      const bucket = hasRealEventTime ? bucketSecAt(occurredAtMs, tf) : currentBucketSec(tf);
      if (bucket > last.time) {
        bars.push({
          time: bucket,
          open: price,
          high: price,
          low: price,
          close: price,
          volume: 0,
        });
        continue;
      }
    }
    last.close = price;
    if (price > last.high) last.high = price;
    if (price < last.low) last.low = price;
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
