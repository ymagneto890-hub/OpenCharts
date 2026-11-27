import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import {
  BarSizeSetting,
  type Contract,
  type ContractDescription,
  type ContractDetails,
  EventName,
  IBApi,
  MarketDataType,
  type NewsProvider,
  type ScannerSubscription,
  SecType,
  type TagValue,
  TickByTickDataType,
  type TickType,
  WhatToShow,
} from "@stoqey/ib";
import {
  getNyTradingDayKey,
  type VwapSessionSeed,
} from "../lib/indicators.ts";
import {
  getUsPreMarketSessionState,
} from "../lib/premarketScreener.ts";
import {
  createDefaultScreenerPipeline,
  type ScreenerEnricher,
  type ScreenerPipeline,
  type ScreenerPipelineMeta,
  type ScreenerPostFilter,
} from "../lib/screenerPipeline.ts";
import {
  IbkrRealtimeScanner,
  type IbkrScannerCallbacks,
  type IbkrScannerHost,
  type IbkrScreenerStreamEvent,
} from "./ibkrScanner.ts";

const IB_TICK = {
  BID: 1,
  ASK: 2,
  LAST: 4,
  LAST_SIZE: 5,
  VOLUME: 8,
  CLOSE: 9,
  AVG_VOLUME: 21,
  RT_VOLUME: 48,
  DELAYED_BID: 66,
  DELAYED_ASK: 67,
  DELAYED_LAST: 68,
  DELAYED_LAST_SIZE: 71,
  DELAYED_HIGH: 72,
  DELAYED_LOW: 73,
  DELAYED_VOLUME: 74,
  DELAYED_CLOSE: 75,
  DELAYED_OPEN: 76,
  RT_TRD_VOLUME: 77,
  DELAYED_LAST_TIMESTAMP: 88,
} as const;
import {
  aggregateCandles,
  getBucketStartSec,
  mergeLive1sBarIntoSeries,
  type OhlcvBar,
  parseTimeframeSeconds,
  resolveIbkrHistoricalQuery,
} from "../lib/timeframes.ts";

export {
  type IbkrScreenerStreamEvent,
} from "./ibkrScanner.ts";
export type {
  ScreenerEnricher,
  ScreenerPostFilter,
  ScreenerPipelineMeta,
} from "../lib/screenerPipeline.ts";

export interface IbkrConnectionConfig {
  host: string;
  port: number;
  clientId: number;
  marketDataType: MarketDataType;
}

export type IbkrConnectionState =
  | "disconnected"
  | "connecting"
  | "connected"
  | "reconnecting";

export interface IbkrStatusPayload {
  configured: boolean;
  host: string;
  port: number;
  clientId: number;
  marketDataType: MarketDataType;
  effectiveMarketDataType?: MarketDataType;
  source: "file" | "env" | "default";
  connectionState: IbkrConnectionState;
  lastError: string | null;
  activeStreams: number;
  activeRequests: number;
}

export interface IbkrVwapAccumulator {
  anchorBucket: number;
  cumVol: number;
  mean: number;
  sumSqWeightedDiff: number;
  vwap: number | null;
}

export interface IbkrStreamEvent {
  type: "status" | "bar1s" | "quote";
  symbol?: string;
  connected?: boolean;
  connectionState?: IbkrConnectionState;
  marketDataType?: MarketDataType;
  reason?: string;
  bar?: OhlcvBar;
  vwap?: {
    extended: IbkrVwapAccumulator;
    regular: IbkrVwapAccumulator;
  };
  bid?: number;
  ask?: number;
  last?: number;
  priorClose?: number;
  timestamp?: number;
}

export interface IbkrHistoricalResult {
  symbol: string;
  timeframe: string;
  candles: OhlcvBar[];
  regularMarketPrice: number | null;
  preMarketRanges: Array<{ start: number; end: number }>;
  regularMarketRanges: Array<{ start: number; end: number }>;
  postMarketRanges: Array<{ start: number; end: number }>;
  exchangeTimezoneName: string;
  vwapSeeds: {
    extended: VwapSessionSeed | null;
    regular: VwapSessionSeed | null;
  };
  dataSource: "ibkr-consolidated";
}

export interface IbkrScreenerPayload {
  marketScope?: "global" | "us" | "us_otc";
  exchanges?: string[];
  onlyPremarket?: boolean;
  marketCapMin?: number | null;
  marketCapMax?: number | null;
  floatMin?: number | null;
  floatMax?: number | null;
  changeMin?: number | null;
  changeMax?: number | null;
  priceMin?: number | null;
  priceMax?: number | null;
  volumeMin?: number | null;
  relVolMin?: number | null;
  sector?: string | null;
  search?: string;
  sortBy?: string;
  sortOrder?: "asc" | "desc";
  offset?: number;
  limit?: number;
}

export interface IbkrScreenerRow {
  id: string;
  ticker: string;
  description: string;
  close: number;
  change: number | null;
  volume: number | null;
  relativeVolume: number | null;
  marketCap: number | null;
  priceToBook: number | null;
  epsDiluted: number | null;
  epsGrowthYoY: number | null;
  dividendYield: number | null;
  sector: string;
  exchange: string;
  perfW: number | null;
  perf1M: number | null;
  perf3M: number | null;
  perfYTD: number | null;
  perfY: number | null;
  rsi: number | null;
  recommendAll: number | null;
  floatShares: number | null;
  currency: string;
  country: string;
  premarketClose: number | null;
  premarketChange: number | null;
  premarketVolume: number | null;
}

export interface IbkrNewsHeadline {
  title: string;
  publisher: string;
  link: string;
  publishedAt: number | null;
  catalystTag: string | null;
}

export interface IbkrTransport {
  readonly isConnected: boolean;
  connect(clientId?: number): void;
  disconnect(): void;
  reqMarketDataType(marketDataType: MarketDataType): void;
  reqHistoricalData(
    reqId: number,
    contract: Contract,
    endDateTime: string | undefined,
    durationStr: string,
    barSizeSetting: BarSizeSetting,
    whatToShow: WhatToShow,
    useRTH: number | boolean,
    formatDate: number,
    keepUpToDate: boolean,
  ): void;
  cancelHistoricalData(reqId: number): void;
  reqTickByTickData(
    reqId: number,
    contract: Contract,
    tickType: TickByTickDataType,
    numberOfTicks: number,
    ignoreSize: boolean,
  ): void;
  cancelTickByTickData(reqId: number): void;
  reqMktData(
    reqId: number,
    contract: Contract,
    genericTickList: string | null,
    snapshot: boolean,
    regulatorySnapshot: boolean,
  ): void;
  cancelMktData(reqId: number): void;
  reqScannerSubscription(
    reqId: number,
    subscription: ScannerSubscription,
    scannerSubscriptionOptions?: TagValue[],
    scannerSubscriptionFilterOptions?: TagValue[],
  ): void;
  cancelScannerSubscription(reqId: number): void;
  reqMatchingSymbols(reqId: number, pattern: string): void;
  reqContractDetails(reqId: number, contract: Contract): void;
  reqNewsProviders(): void;
  reqHistoricalNews(
    reqId: number,
    conId: number,
    providerCodes: string,
    startDateTime: string,
    endDateTime: string,
    totalResults: number,
  ): void;
  on(event: string, listener: (...args: any[]) => void): void;
  off(event: string, listener: (...args: any[]) => void): void;
}

class StoqeyIbkrTransport implements IbkrTransport {
  private readonly api: IBApi;

  constructor(host: string, port: number, clientId: number) {
    this.api = new IBApi({
      host,
      port,
      clientId,
      maxReqPerSec: 40,
    });
  }

  get isConnected(): boolean {
    return this.api.isConnected;
  }

  connect(clientId?: number): void {
    this.api.connect(clientId);
  }

  disconnect(): void {
    this.api.disconnect();
  }

  reqMarketDataType(marketDataType: MarketDataType): void {
    this.api.reqMarketDataType(marketDataType);
  }

  reqHistoricalData(
    reqId: number,
    contract: Contract,
    endDateTime: string | undefined,
    durationStr: string,
    barSizeSetting: BarSizeSetting,
    whatToShow: WhatToShow,
    useRTH: number | boolean,
    formatDate: number,
    keepUpToDate: boolean,
  ): void {
    this.api.reqHistoricalData(
      reqId,
      contract,
      endDateTime,
      durationStr,
      barSizeSetting,
      whatToShow,
      useRTH,
      formatDate,
      keepUpToDate,
    );
  }

  cancelHistoricalData(reqId: number): void {
    this.api.cancelHistoricalData(reqId);
  }

  reqTickByTickData(
    reqId: number,
    contract: Contract,
    tickType: TickByTickDataType,
    numberOfTicks: number,
    ignoreSize: boolean,
  ): void {
    this.api.reqTickByTickData(reqId, contract, tickType, numberOfTicks, ignoreSize);
  }

  cancelTickByTickData(reqId: number): void {
    this.api.cancelTickByTickData(reqId);
  }

  reqMktData(
    reqId: number,
    contract: Contract,
    genericTickList: string | null,
    snapshot: boolean,
    regulatorySnapshot: boolean,
  ): void {
    this.api.reqMktData(reqId, contract, genericTickList, snapshot, regulatorySnapshot);
  }

  cancelMktData(reqId: number): void {
    this.api.cancelMktData(reqId);
  }

  reqScannerSubscription(
    reqId: number,
    subscription: ScannerSubscription,
    scannerSubscriptionOptions?: TagValue[],
    scannerSubscriptionFilterOptions?: TagValue[],
  ): void {
    this.api.reqScannerSubscription(
      reqId,
      subscription,
      scannerSubscriptionOptions,
      scannerSubscriptionFilterOptions,
    );
  }

  cancelScannerSubscription(reqId: number): void {
    this.api.cancelScannerSubscription(reqId);
  }

  reqMatchingSymbols(reqId: number, pattern: string): void {
    this.api.reqMatchingSymbols(reqId, pattern);
  }

  reqContractDetails(reqId: number, contract: Contract): void {
    this.api.reqContractDetails(reqId, contract);
  }

  reqNewsProviders(): void {
    this.api.reqNewsProviders();
  }

  reqHistoricalNews(
    reqId: number,
    conId: number,
    providerCodes: string,
    startDateTime: string,
    endDateTime: string,
    totalResults: number,
  ): void {
    this.api.reqHistoricalNews(
      reqId,
      conId,
      providerCodes,
      startDateTime,
      endDateTime,
      totalResults,
    );
  }

  on(event: string, listener: (...args: any[]) => void): void {
    this.api.on(event as any, listener);
  }

  off(event: string, listener: (...args: any[]) => void): void {
    this.api.off(event as any, listener);
  }
}

const DEFAULT_CONFIG: IbkrConnectionConfig = {
  host: "127.0.0.1",
  port: 7497,
  clientId: 17,
  marketDataType: MarketDataType.REALTIME,
};

const US_CONSOLIDATED_PRIMARY_EXCH: Record<string, string> = {
  NASDAQ: "ISLAND",
  "NASDAQ GS": "ISLAND",
  "NASDAQ GM": "ISLAND",
  "NASDAQ CM": "ISLAND",
  "NASDAQ GLOBAL SELECT": "ISLAND",
  "NASDAQ GLOBAL MARKET": "ISLAND",
  "NASDAQ CAPITAL MARKET": "ISLAND",
  ISLAND: "ISLAND",
  NMS: "ISLAND",
  NGM: "ISLAND",
  NCM: "ISLAND",
  NYSE: "NYSE",
  NYQ: "NYSE",
  AMEX: "AMEX",
  "NYSE AMERICAN": "AMEX",
  "NYSE MKT": "AMEX",
  ASE: "AMEX",
  ARCA: "ARCA",
  "NYSE ARCA": "ARCA",
  NYSEARCA: "ARCA",
  PCX: "ARCA",
  BATS: "BATS",
  CBOE: "BATS",
  "CBOE BZX": "BATS",
  BZX: "BATS",
  IEX: "IEX",
};

const KNOWN_FOREX_PAIRS = new Set([
  "EURUSD",
  "GBPUSD",
  "USDJPY",
  "USDCHF",
  "AUDUSD",
  "USDCAD",
  "NZDUSD",
  "EURGBP",
  "EURJPY",
  "EURCHF",
  "EURAUD",
  "EURCAD",
  "EURNZD",
  "EURMXN",
  "EURPLN",
  "EURSEK",
  "EURNOK",
  "EURTRY",
  "GBPJPY",
  "USDMXN",
]);

/**
 * Translates a terminal symbol into an IBKR Contract configured for the US
 * Consolidated Bundle (NYSE · NASDAQ · AMEX via SMART/USD).
 */
export function toIbkrContract(symbol: string, exchangeHint?: string): Contract {
  const upper = symbol.trim().toUpperCase();
  const compact = upper.replace(/[\s/_-]+/g, "");
  if (KNOWN_FOREX_PAIRS.has(compact) && compact.length === 6) {
    return {
      symbol: compact.slice(0, 3),
      secType: SecType.CASH,
      exchange: "IDEALPRO",
      currency: compact.slice(3, 6),
    };
  }

  // IBKR represents US share classes (e.g. BRK.B) with a space ("BRK B")
  const ibSymbol = upper.replace(/\./g, " ");
  const normExch = (exchangeHint ?? "").trim().toUpperCase().replace(/\s+/g, " ");
  const primaryExch = US_CONSOLIDATED_PRIMARY_EXCH[normExch];

  return {
    symbol: ibSymbol,
    secType: SecType.STK,
    exchange: "SMART",
    currency: "USD",
    ...(primaryExch ? { primaryExch } : {}),
  };
}

let cachedNyMinutesFormatter: Intl.DateTimeFormat | null = null;
function getNyClockParts(timeSec: number): { dayKey: number; minutes: number; isWeekend: boolean } {
  try {
    if (!cachedNyMinutesFormatter) {
      cachedNyMinutesFormatter = new Intl.DateTimeFormat("en-US", {
        timeZone: "America/New_York",
        weekday: "short",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour12: false,
        hour: "2-digit",
        minute: "2-digit",
      });
    }
    const parts = cachedNyMinutesFormatter.formatToParts(new Date(timeSec * 1000));
    let year = 0;
    let month = 0;
    let day = 0;
    let hour = 0;
    let minute = 0;
    let weekday = "";
    for (const part of parts) {
      if (part.type === "year") year = Number(part.value);
      else if (part.type === "month") month = Number(part.value);
      else if (part.type === "day") day = Number(part.value);
      else if (part.type === "hour") hour = Number(part.value) % 24;
      else if (part.type === "minute") minute = Number(part.value);
      else if (part.type === "weekday") weekday = part.value;
    }
    const dayKey = year > 0 && month > 0 && day > 0 ? year * 10_000 + month * 100 + day : getNyTradingDayKey(timeSec);
    return {
      dayKey,
      minutes: hour * 60 + minute,
      isWeekend: weekday === "Sat" || weekday === "Sun",
    };
  } catch {
    return { dayKey: getNyTradingDayKey(timeSec), minutes: 0, isWeekend: false };
  }
}

let nyFullDateFormatter: Intl.DateTimeFormat | null = null;
function resolveNyWallClockUtcSec(
  y: number,
  moZeroIndexed: number,
  d: number,
  h: number,
  mi: number,
  sec: number,
): number {
  const wallUtcMs = Date.UTC(y, moZeroIndexed, d, h, mi, sec);
  try {
    if (!nyFullDateFormatter) {
      nyFullDateFormatter = new Intl.DateTimeFormat("en-US", {
        timeZone: "America/New_York",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
      });
    }
    const readNyWallMs = (utcMs: number): number => {
      const parts = nyFullDateFormatter!.formatToParts(new Date(utcMs));
      let py = 0;
      let pmo = 0;
      let pd = 0;
      let ph = 0;
      let pmi = 0;
      let psec = 0;
      for (const p of parts) {
        if (p.type === "year") py = Number(p.value);
        else if (p.type === "month") pmo = Number(p.value);
        else if (p.type === "day") pd = Number(p.value);
        else if (p.type === "hour") ph = Number(p.value) % 24;
        else if (p.type === "minute") pmi = Number(p.value);
        else if (p.type === "second") psec = Number(p.value);
      }
      return Date.UTC(py, pmo - 1, pd, ph, pmi, psec);
    };
    let guessMs = wallUtcMs + 5 * 3600_000;
    guessMs += wallUtcMs - readNyWallMs(guessMs);
    guessMs += wallUtcMs - readNyWallMs(guessMs);
    return Math.floor(guessMs / 1000);
  } catch {
    return Math.floor((wallUtcMs + 5 * 3600_000) / 1000);
  }
}

export function parseIbkrBarTimeSec(rawTime: string | number): number {
  if (typeof rawTime === "number" && Number.isFinite(rawTime)) {
    return rawTime > 1e11 ? Math.floor(rawTime / 1000) : Math.floor(rawTime);
  }
  const s = String(rawTime ?? "").trim();
  if (!s || s.startsWith("finished")) return NaN;
  if (/^\d{9,13}$/.test(s)) {
    const n = Number(s);
    return n > 1e11 ? Math.floor(n / 1000) : Math.floor(n);
  }
  // YYYYMMDD (daily/weekly bars)
  const dayMatch = /^(\d{4})(\d{2})(\d{2})$/.exec(s);
  if (dayMatch) {
    return Math.floor(
      Date.UTC(Number(dayMatch[1]), Number(dayMatch[2]) - 1, Number(dayMatch[3]), 0, 0, 0) / 1000,
    );
  }
  // YYYYMMDD HH:mm:ss or YYYYMMDD-HH:mm:ss (optionally with timezone suffix)
  const dtMatch = /^(\d{4})(\d{2})(\d{2})[\s-]+(\d{2}):(\d{2}):(\d{2})(?:\s+(\S+))?$/.exec(s);
  if (dtMatch) {
    const y = Number(dtMatch[1]);
    const mo = Number(dtMatch[2]) - 1;
    const d = Number(dtMatch[3]);
    const h = Number(dtMatch[4]);
    const mi = Number(dtMatch[5]);
    const sec = Number(dtMatch[6]);
    const tz = (dtMatch[7] ?? "").toUpperCase();
    if (!tz || tz === "UTC" || tz === "GMT") {
      return Math.floor(Date.UTC(y, mo, d, h, mi, sec) / 1000);
    }
    if (tz === "EST") {
      return Math.floor((Date.UTC(y, mo, d, h, mi, sec) + 5 * 3600_000) / 1000);
    }
    if (tz === "EDT") {
      return Math.floor((Date.UTC(y, mo, d, h, mi, sec) + 4 * 3600_000) / 1000);
    }
    if (tz.includes("EASTERN") || tz === "AMERICA/NEW_YORK") {
      return resolveNyWallClockUtcSec(y, mo, d, h, mi, sec);
    }
    return Math.floor(Date.UTC(y, mo, d, h, mi, sec) / 1000);
  }
  const parsed = Date.parse(s);
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : NaN;
}

function formatIbkrEndDateTimeUtc(timeSec: number): string {
  const d = new Date(timeSec * 1000);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mi = String(d.getUTCMinutes()).padStart(2, "0");
  const ss = String(d.getUTCSeconds()).padStart(2, "0");
  return `${yyyy}${mm}${dd}-${hh}:${mi}:${ss}`;
}

function deriveUsSessionRanges(bars: ReadonlyArray<OhlcvBar>): {
  preMarketRanges: Array<{ start: number; end: number }>;
  regularMarketRanges: Array<{ start: number; end: number }>;
  postMarketRanges: Array<{ start: number; end: number }>;
} {
  const preMap = new Map<number, { start: number; end: number }>();
  const regMap = new Map<number, { start: number; end: number }>();
  const postMap = new Map<number, { start: number; end: number }>();

  for (const b of bars) {
    const info = getNyClockParts(b.time);
    if (info.isWeekend) continue;
    const min = info.minutes;
    let targetMap: Map<number, { start: number; end: number }> | null = null;
    if (min >= 240 && min < 570) targetMap = preMap; // 04:00 - 09:30 ET
    else if (min >= 570 && min < 960) targetMap = regMap; // 09:30 - 16:00 ET
    else if (min >= 960 && min < 1200) targetMap = postMap; // 16:00 - 20:00 ET
    if (!targetMap) continue;
    const cur = targetMap.get(info.dayKey);
    if (!cur) {
      targetMap.set(info.dayKey, { start: b.time, end: b.time + 1 });
    } else {
      cur.start = Math.min(cur.start, b.time);
      cur.end = Math.max(cur.end, b.time + 1);
    }
  }

  return {
    preMarketRanges: Array.from(preMap.values()).sort((a, b) => a.start - b.start),
    regularMarketRanges: Array.from(regMap.values()).sort((a, b) => a.start - b.start),
    postMarketRanges: Array.from(postMap.values()).sort((a, b) => a.start - b.start),
  };
}

function createVwapAccumulator(anchorBucket = 0): IbkrVwapAccumulator {
  return {
    anchorBucket,
    cumVol: 0,
    mean: 0,
    sumSqWeightedDiff: 0,
    vwap: null,
  };
}

function updateVwapAccumulator(
  acc: IbkrVwapAccumulator,
  anchorBucket: number,
  typicalPrice: number,
  volume: number,
): void {
  if (acc.anchorBucket !== anchorBucket) {
    acc.anchorBucket = anchorBucket;
    acc.cumVol = 0;
    acc.mean = 0;
    acc.sumSqWeightedDiff = 0;
    acc.vwap = null;
  }
  if (!Number.isFinite(typicalPrice) || typicalPrice <= 0) return;
  if (Number.isFinite(volume) && volume > 0) {
    const prevMean = acc.mean;
    acc.cumVol += volume;
    acc.mean = prevMean + (volume / acc.cumVol) * (typicalPrice - prevMean);
    acc.sumSqWeightedDiff += volume * (typicalPrice - prevMean) * (typicalPrice - acc.mean);
    acc.vwap = acc.mean;
  } else if (acc.cumVol > 0) {
    acc.vwap = acc.mean;
  }
}

export function computeVwapSessionSeedsFromBars(
  bars: ReadonlyArray<OhlcvBar>,
  visibleStartTimeSec: number,
  source: "hlc3" | "hl2" | "ohlc4" | "close" = "hlc3",
): { extended: VwapSessionSeed | null; regular: VwapSessionSeed | null } {
  if (bars.length === 0) return { extended: null, regular: null };
  const lastTime = bars[bars.length - 1]!.time;
  const targetDayKey = getNyTradingDayKey(lastTime);
  if (visibleStartTimeSec <= 0) return { extended: null, regular: null };

  const extAcc = createVwapAccumulator(targetDayKey);
  const regAcc = createVwapAccumulator(targetDayKey);

  const sorted = [...bars].sort((a, b) => a.time - b.time);
  let prevTime = -1;
  for (const bar of sorted) {
    if (bar.time === prevTime) continue;
    prevTime = bar.time;
    if (bar.time >= visibleStartTimeSec) break;
    const ny = getNyClockParts(bar.time);
    if (ny.dayKey !== targetDayKey || ny.isWeekend) continue;
    const tp =
      source === "close"
        ? bar.close
        : source === "hl2"
          ? (bar.high + bar.low) / 2
          : source === "ohlc4"
            ? (bar.open + bar.high + bar.low + bar.close) / 4
            : (bar.high + bar.low + bar.close) / 3;
    if (ny.minutes >= 240 && ny.minutes < 1200) {
      updateVwapAccumulator(extAcc, targetDayKey, tp, bar.volume);
    }
    if (ny.minutes >= 570 && ny.minutes < 960) {
      updateVwapAccumulator(regAcc, targetDayKey, tp, bar.volume);
    }
  }

  return {
    extended:
      extAcc.cumVol > 0
        ? {
            anchorBucket: extAcc.anchorBucket,
            cumVol: extAcc.cumVol,
            mean: extAcc.mean,
            sumSqWeightedDiff: extAcc.sumSqWeightedDiff,
          }
        : null,
    regular:
      regAcc.cumVol > 0
        ? {
            anchorBucket: regAcc.anchorBucket,
            cumVol: regAcc.cumVol,
            mean: regAcc.mean,
            sumSqWeightedDiff: regAcc.sumSqWeightedDiff,
          }
        : null,
  };
}

function classifyNewsCatalyst(title: string): string | null {
  const t = title.toLowerCase();
  if (/\b(fda|phase\s?[123]|clinical|trial|drug|approval|clearance|orphan)\b/.test(t)) {
    return "FDA / Clínico";
  }
  if (/\b(earnings|eps|revenue|guidance|quarter|q[1-4]|results|beat|miss)\b/.test(t)) {
    return "Resultados";
  }
  if (/\b(partner|collab|agreement|deal|contract|award|license|alliance)\b/.test(t)) {
    return "Alianza / Contrato";
  }
  if (/\b(buyout|acqui|merger|takeover|bid)\b/.test(t)) {
    return "Compra / M&A";
  }
  if (/\b(offering|dilution|shelf|atm|warrant|reverse split)\b/.test(t)) {
    return "Dilución / R.Split";
  }
  return null;
}

interface QueuedHistoricalJob {
  key: string;
  minSpacingMs: number;
  priority: "high" | "normal";
  signal?: AbortSignal;
  run: () => Promise<OhlcvBar[]>;
  resolve: (bars: OhlcvBar[]) => void;
  reject: (err: unknown) => void;
}

/**
 * Enforces IBKR Historical Data pacing rules:
 * - <= 50 historical requests per 10-minute rolling window (safety margin under IBKR's 60/10min limit)
 * - Minimum spacing between dispatches (300ms general, 450ms for <= 30s bars)
 * - Bounded concurrency (default 3) + high-priority lane so chart loads never stall behind scanner scans
 * - In-flight coalescing & 16s prefix cache to avoid identical-query pacing violations (Error 162)
 * - Immediate queue eviction when aborted before dispatch
 */
export class HistoricalPacingQueue {
  private readonly maxPerWindow: number;
  private readonly windowMs: number;
  private readonly cacheTtlMs: number;
  private readonly maxConcurrent: number;
  private readonly dispatchTimes: number[] = [];
  private readonly queue: QueuedHistoricalJob[] = [];
  private readonly inFlight = new Map<string, Promise<OhlcvBar[]>>();
  private readonly cache = new Map<string, { fetchedAt: number; bars: OhlcvBar[] }>();
  private lastDispatchAt = 0;
  private pumpTimer: ReturnType<typeof setTimeout> | null = null;
  private activeDispatches = 0;

  constructor(opts?: {
    maxPerWindow?: number;
    windowMs?: number;
    cacheTtlMs?: number;
    maxConcurrent?: number;
  }) {
    this.maxPerWindow = opts?.maxPerWindow ?? 50;
    this.windowMs = opts?.windowMs ?? 600_000;
    this.cacheTtlMs = opts?.cacheTtlMs ?? 16_000;
    this.maxConcurrent = Math.max(1, opts?.maxConcurrent ?? 2);
  }

  get queueLength(): number {
    return this.queue.length;
  }

  get recentWindowCount(): number {
    const cutoff = Date.now() - this.windowMs;
    while (this.dispatchTimes.length > 0 && this.dispatchTimes[0]! < cutoff) {
      this.dispatchTimes.shift();
    }
    return this.dispatchTimes.length;
  }

  clearCache(): void {
    this.cache.clear();
  }

  dispose(): void {
    if (this.pumpTimer) {
      clearTimeout(this.pumpTimer);
      this.pumpTimer = null;
    }
    while (this.queue.length > 0) {
      const job = this.queue.shift()!;
      job.reject(new Error("IBKR pacing queue disposed"));
    }
    this.inFlight.clear();
  }

  enqueue(
    key: string,
    minSpacingMs: number,
    run: () => Promise<OhlcvBar[]>,
    signal?: AbortSignal,
    priority: "high" | "normal" = "normal",
  ): Promise<OhlcvBar[]> {
    if (signal?.aborted) {
      return Promise.reject(new Error("Request aborted"));
    }

    const now = Date.now();
    const cached = this.cache.get(key);
    if (cached && now - cached.fetchedAt < this.cacheTtlMs) {
      return Promise.resolve(cached.bars);
    }

    const existingFlight = this.inFlight.get(key);
    if (existingFlight) {
      return existingFlight;
    }

    const promise = new Promise<OhlcvBar[]>((resolve, reject) => {
      const job: QueuedHistoricalJob = {
        key,
        minSpacingMs,
        priority,
        signal,
        run,
        resolve,
        reject,
      };
      if (signal) {
        const onAbort = () => {
          const idx = this.queue.indexOf(job);
          if (idx >= 0) {
            this.queue.splice(idx, 1);
            reject(new Error("Request aborted before IBKR dispatch"));
          }
        };
        signal.addEventListener("abort", onAbort, { once: true });
      }
      if (priority === "high") {
        // Insert after existing high-priority jobs, ahead of normal-priority scanner jobs
        const firstNormalIdx = this.queue.findIndex((j) => j.priority !== "high");
        if (firstNormalIdx >= 0) {
          this.queue.splice(firstNormalIdx, 0, job);
        } else {
          this.queue.push(job);
        }
      } else {
        this.queue.push(job);
      }
      this.schedulePump(0);
    }).finally(() => {
      if (this.inFlight.get(key) === promise) {
        this.inFlight.delete(key);
      }
    });

    this.inFlight.set(key, promise);
    return promise;
  }

  private schedulePump(delayMs: number): void {
    if (this.pumpTimer) return;
    this.pumpTimer = setTimeout(() => {
      this.pumpTimer = null;
      this.pump();
    }, Math.max(0, delayMs));
  }

  private pump(): void {
    while (this.queue.length > 0 && this.activeDispatches < this.maxConcurrent) {
      const job = this.queue[0]!;
      if (job.signal?.aborted) {
        this.queue.shift();
        job.reject(new Error("Request aborted"));
        continue;
      }

      const now = Date.now();
      const cutoff = now - this.windowMs;
      while (this.dispatchTimes.length > 0 && this.dispatchTimes[0]! < cutoff) {
        this.dispatchTimes.shift();
      }

      const normalCap = Math.max(1, this.maxPerWindow - 10);
      if (job.priority !== "high" && this.dispatchTimes.length >= normalCap) {
        // Reserve the last 10 pacing slots for high-priority interactive chart loads;
        // fail-fast background scanner hydrations instead of hanging for 10 minutes.
        this.queue.shift();
        job.reject(new Error("IBKR historical pacing budget reserved for charts"));
        continue;
      }

      if (this.dispatchTimes.length >= this.maxPerWindow) {
        const oldest = this.dispatchTimes[0]!;
        const waitMs = Math.max(50, oldest + this.windowMs - now + 25);
        this.schedulePump(waitMs);
        return;
      }

      const sinceLast = now - this.lastDispatchAt;
      if (sinceLast < job.minSpacingMs) {
        this.schedulePump(job.minSpacingMs - sinceLast);
        return;
      }

      this.queue.shift();
      this.lastDispatchAt = Date.now();
      this.dispatchTimes.push(this.lastDispatchAt);
      this.activeDispatches += 1;

      void job
        .run()
        .then((bars) => {
          if (this.cache.size >= 48) {
            const oldestKey = this.cache.keys().next().value;
            if (oldestKey !== undefined) this.cache.delete(oldestKey);
          }
          this.cache.set(job.key, { fetchedAt: Date.now(), bars });
          job.resolve(bars);
        })
        .catch((err) => {
          job.reject(err);
        })
        .finally(() => {
          this.activeDispatches = Math.max(0, this.activeDispatches - 1);
          if (this.queue.length > 0) {
            this.schedulePump(0);
          }
        });
    }
  }
}

interface ActiveSymbolStream {
  symbol: string;
  contract: Contract;
  refs: number;
  warmReleaseTimer: ReturnType<typeof setTimeout> | null;
  tickByTickReqId: number | null;
  mktDataReqId: number | null;
  usingRtVolumeFallback: boolean;
  bars1s: Map<number, OhlcvBar>;
  bars1sIngestedAt: Map<number, number>;
  sessionBars1m: Map<number, OhlcvBar>;
  lastRtTotalVolume: number | null;
  lastCumulativeVolume: number | null;
  lastDelayedTradeSize: number;
  lastDelayedTimestampSec: number | null;
  lastTradeTimeSec: number | null;
  hasInitialDelayedSnapshot: boolean;
  lastBid: number | null;
  lastAsk: number | null;
  lastPrice: number | null;
  priorClose: number | null;
  vwapExtended: IbkrVwapAccumulator;
  vwapRegular: IbkrVwapAccumulator;
  backfillPromise: Promise<void> | null;
  lastTouchedAt: number;
}

interface PendingHistoricalReq {
  reqId: number;
  bars: OhlcvBar[];
  resolve: (bars: OhlcvBar[]) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  abortHandler?: () => void;
}

interface PendingGenericReq<T> {
  resolve: (val: T) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const MAX_WARM_STREAMS = 8;
const WARM_RELEASE_GRACE_MS = 1_500;
const MAX_1S_WINDOW_BARS = 7_200;

export class IbkrEngine extends EventEmitter {
  private readonly configFile: string | null;
  private readonly transportFactory: (cfg: IbkrConnectionConfig) => IbkrTransport;
  private transport: IbkrTransport | null = null;
  private config: IbkrConnectionConfig;
  private configSource: "file" | "env" | "default" = "default";
  private connectionState: IbkrConnectionState = "disconnected";
  private lastError: string | null = null;
  private effectiveMarketDataType: MarketDataType = 1 as MarketDataType;
  private desiredConnected = false;
  private connectPromise: Promise<void> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private nextReqId = 10_000;

  private readonly pacingQueue: HistoricalPacingQueue;
  private readonly streams = new Map<string, ActiveSymbolStream>();
  private readonly reqIdToStreamSymbol = new Map<number, string>();
  private readonly scannerSubscribers = new Map<string, Set<IbkrScannerCallbacks>>();
  private readonly scannerReqIdToCallbacks = new Map<
    number,
    { symbol: string; contract: Contract; callbacks: IbkrScannerCallbacks }
  >();
  private readonly screenerPipeline: ScreenerPipeline<IbkrScreenerRow>;
  private readonly scanner: IbkrRealtimeScanner;
  private readonly pendingHistorical = new Map<number, PendingHistoricalReq>();
  private readonly pendingScanners = new Map<
    number,
    PendingGenericReq<IbkrScreenerRow[]> & { rows: IbkrScreenerRow[]; seenTickers: Set<string> }
  >();
  private readonly pendingSymbolSearch = new Map<
    number,
    PendingGenericReq<ContractDescription[]>
  >();
  private readonly pendingContractDetails = new Map<
    number,
    PendingGenericReq<ContractDetails[]> & { items: ContractDetails[] }
  >();
  private readonly pendingNews = new Map<
    number,
    PendingGenericReq<IbkrNewsHeadline[]> & { items: IbkrNewsHeadline[] }
  >();
  private newsProvidersWaiter: PendingGenericReq<string> | null = null;
  private cachedNewsProviders: string | null = null;
  private readonly newsCache = new Map<string, { at: number; items: IbkrNewsHeadline[] }>();

  // Bound transport listeners stored so they can be detached cleanly on transport teardown
  private readonly boundHandlers: Array<[string, (...args: any[]) => void]> = [];

  constructor(opts?: {
    configFile?: string | null;
    transportFactory?: (cfg: IbkrConnectionConfig) => IbkrTransport;
    pacingQueue?: HistoricalPacingQueue;
  }) {
    super();
    this.configFile = opts?.configFile === undefined ? null : opts.configFile;
    this.transportFactory =
      opts?.transportFactory ??
      ((cfg) => new StoqeyIbkrTransport(cfg.host, cfg.port, cfg.clientId));
    this.pacingQueue = opts?.pacingQueue ?? new HistoricalPacingQueue();
    this.screenerPipeline = createDefaultScreenerPipeline<IbkrScreenerRow>();
    this.scanner = new IbkrRealtimeScanner(this.createScannerHost(), this.screenerPipeline);
    const loaded = this.loadConfigInternal();
    this.config = loaded.config;
    this.configSource = loaded.source;
    this.effectiveMarketDataType = this.config.marketDataType;
  }

  private loadConfigInternal(): {
    config: IbkrConnectionConfig;
    source: "file" | "env" | "default";
  } {
    if (this.configFile) {
      try {
        if (fs.existsSync(this.configFile)) {
          const parsed = JSON.parse(fs.readFileSync(this.configFile, "utf8")) as Partial<{
            host: unknown;
            port: unknown;
            clientId: unknown;
            marketDataType: unknown;
          }>;
          const host =
            typeof parsed.host === "string" && parsed.host.trim()
              ? parsed.host.trim()
              : DEFAULT_CONFIG.host;
          const port =
            typeof parsed.port === "number" && Number.isInteger(parsed.port) && parsed.port > 0
              ? parsed.port
              : DEFAULT_CONFIG.port;
          const clientId =
            typeof parsed.clientId === "number" &&
            Number.isInteger(parsed.clientId) &&
            parsed.clientId >= 0
              ? parsed.clientId
              : DEFAULT_CONFIG.clientId;
          const marketDataType =
            parsed.marketDataType === 1 || parsed.marketDataType === 2
              ? (parsed.marketDataType as MarketDataType)
              : parsed.marketDataType === 4 || parsed.marketDataType === 3
                ? MarketDataType.DELAYED_FROZEN
                : DEFAULT_CONFIG.marketDataType;
          return { config: { host, port, clientId, marketDataType }, source: "file" };
        }
      } catch {
        // Ignore invalid local config file and fall back to env/defaults
      }
    }

    const envHost = (process.env.IBKR_HOST || "").trim();
    const envPort = Number(process.env.IBKR_PORT || "");
    const envClientId = Number(process.env.IBKR_CLIENT_ID || "");
    const envMdt = Number(process.env.IBKR_MARKET_DATA_TYPE || "");
    if (envHost || Number.isFinite(envPort) || Number.isFinite(envClientId) || Number.isFinite(envMdt)) {
      return {
        config: {
          host: envHost || DEFAULT_CONFIG.host,
          port: Number.isInteger(envPort) && envPort > 0 ? envPort : DEFAULT_CONFIG.port,
          clientId:
            Number.isInteger(envClientId) && envClientId >= 0
              ? envClientId
              : DEFAULT_CONFIG.clientId,
          marketDataType:
            envMdt === 1 || envMdt === 2
              ? (envMdt as MarketDataType)
              : envMdt === 4 || envMdt === 3
                ? MarketDataType.DELAYED_FROZEN
                : DEFAULT_CONFIG.marketDataType,
        },
        source: "env",
      };
    }

    return { config: { ...DEFAULT_CONFIG }, source: "default" };
  }

  getStatusPayload(): IbkrStatusPayload {
    return {
      configured: this.connectionState === "connected" || this.configSource !== "default",
      host: this.config.host,
      port: this.config.port,
      clientId: this.config.clientId,
      marketDataType: this.config.marketDataType,
      effectiveMarketDataType: this.effectiveMarketDataType,
      source: this.configSource,
      connectionState: this.connectionState,
      lastError: this.lastError,
      activeStreams: this.streams.size,
      activeRequests: this.pendingHistorical.size,
    };
  }

  getDiagnostics(): {
    connectionState: IbkrConnectionState;
    activeStreams: number;
    activeReqIds: number;
    pendingHistorical: number;
    pendingScanners: number;
    queuedHistorical: number;
    recentWindowCount: number;
    streamSymbols: string[];
  } {
    return {
      connectionState: this.connectionState,
      activeStreams: this.streams.size,
      activeReqIds: this.reqIdToStreamSymbol.size,
      pendingHistorical: this.pendingHistorical.size,
      pendingScanners: this.pendingScanners.size,
      queuedHistorical: this.pacingQueue.queueLength,
      recentWindowCount: this.pacingQueue.recentWindowCount,
      streamSymbols: Array.from(this.streams.keys()),
    };
  }

  async updateConfig(next: Partial<IbkrConnectionConfig>): Promise<IbkrStatusPayload> {
    const merged: IbkrConnectionConfig = {
      host: typeof next.host === "string" && next.host.trim() ? next.host.trim() : this.config.host,
      port:
        typeof next.port === "number" && Number.isInteger(next.port) && next.port > 0 && next.port <= 65535
          ? next.port
          : this.config.port,
      clientId:
        typeof next.clientId === "number" && Number.isInteger(next.clientId) && next.clientId >= 0
          ? next.clientId
          : this.config.clientId,
      marketDataType:
        next.marketDataType === 1 || next.marketDataType === 2
          ? next.marketDataType
          : next.marketDataType === 4 || next.marketDataType === 3
            ? MarketDataType.DELAYED_FROZEN
            : this.config.marketDataType,
    };

    if (this.configFile) {
      fs.mkdirSync(path.dirname(this.configFile), { recursive: true });
      fs.writeFileSync(
        this.configFile,
        JSON.stringify({ ...merged, updatedAt: Date.now() }, null, 2),
        "utf8",
      );
      this.configSource = "file";
    }
    this.config = merged;
    this.effectiveMarketDataType = merged.marketDataType;
    this.lastError = null;
    this.pacingQueue.clearCache();

    await this.reconnectNow();
    return this.getStatusPayload();
  }

  async resetConfig(): Promise<IbkrStatusPayload> {
    if (this.configFile && fs.existsSync(this.configFile)) {
      fs.unlinkSync(this.configFile);
    }
    const loaded = this.loadConfigInternal();
    this.config = loaded.config;
    this.configSource = loaded.source;
    this.effectiveMarketDataType = this.config.marketDataType;
    this.pacingQueue.clearCache();
    this.disconnect();
    return this.getStatusPayload();
  }

  async reconnectNow(): Promise<void> {
    this.disconnectTransportOnly();
    await this.ensureConnected();
  }

  async ensureConnected(): Promise<void> {
    this.desiredConnected = true;
    if (this.connectionState === "connected" && this.transport?.isConnected) {
      return;
    }
    if (this.connectPromise) {
      return this.connectPromise;
    }

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    this.connectionState = this.reconnectAttempt > 0 ? "reconnecting" : "connecting";
    this.emitStatus();

    this.connectPromise = new Promise<void>((resolve, reject) => {
      const transport = this.transportFactory(this.config);
      this.detachTransportListeners();
      this.transport = transport;

      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.connectPromise = null;
        const errMsg = `Tiempo de espera agotado conectando a IBKR (${this.config.host}:${this.config.port})`;
        this.lastError = errMsg;
        this.connectionState = "disconnected";
        this.emitStatus(errMsg);
        this.scheduleReconnect();
        reject(new Error(errMsg));
      }, 10_000);

      const onReady = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        this.connectPromise = null;
        this.reconnectAttempt = 0;
        this.lastError = null;
        this.connectionState = "connected";
        this.effectiveMarketDataType = this.config.marketDataType;
        try {
          transport.reqMarketDataType(this.effectiveMarketDataType);
        } catch {
          // ignore
        }
        this.emitStatus();
        this.resubscribeAllStreams();
        resolve();
      };

      const onConnectFail = (msg: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        this.connectPromise = null;
        this.lastError = msg;
        this.connectionState = "disconnected";
        this.emitStatus(msg);
        this.scheduleReconnect();
        reject(new Error(msg));
      };

      const register = (event: string, handler: (...args: any[]) => void) => {
        this.boundHandlers.push([event, handler]);
        transport.on(event, handler);
      };

      register(EventName.nextValidId, () => {
        if (!settled) {
          onReady();
        } else {
          this.reconnectAttempt = 0;
          this.lastError = null;
          this.connectionState = "connected";
          try {
            this.effectiveMarketDataType = this.config.marketDataType;
            transport.reqMarketDataType(this.effectiveMarketDataType);
          } catch {
            // ignore
          }
          this.emitStatus();
          this.resubscribeAllStreams();
        }
      });

      register(EventName.disconnected, () => {
        if (this.transport !== transport) return;
        const msg = "Desconectado de TWS / IB Gateway";
        if (!settled) {
          onConnectFail(msg);
          return;
        }
        this.connectionState = this.desiredConnected ? "reconnecting" : "disconnected";
        this.lastError = msg;
        this.failAllPendingRequests(new Error(msg));
        this.emitStatus(msg);
        if (this.desiredConnected) {
          this.scheduleReconnect();
        }
      });

      register(EventName.connectionClosed, () => {
        if (this.transport !== transport) return;
        const msg = "Conexión IBKR cerrada";
        if (!settled) {
          onConnectFail(msg);
          return;
        }
        this.connectionState = this.desiredConnected ? "reconnecting" : "disconnected";
        this.failAllPendingRequests(new Error(msg));
        this.emitStatus(msg);
        if (this.desiredConnected) {
          this.scheduleReconnect();
        }
      });

      register(EventName.error, (err: Error, code: number, reqId: number) => {
        this.handleIbkrError(err, code, reqId, settled ? undefined : onConnectFail);
      });

      register(
        EventName.historicalData,
        (
          reqId: number,
          time: string,
          open: number,
          high: number,
          low: number,
          close: number,
          volume: number,
        ) => {
          const pending = this.pendingHistorical.get(reqId);
          if (!pending) return;
          const timeStr = String(time ?? "");
          if (timeStr.startsWith("finished")) {
            this.cleanupHistoricalReq(reqId);
            pending.bars.sort((a, b) => a.time - b.time);
            const deduped = new Map<number, OhlcvBar>();
            for (const b of pending.bars) deduped.set(b.time, b);
            pending.resolve(Array.from(deduped.values()).sort((a, b) => a.time - b.time));
            return;
          }
          const tSec = parseIbkrBarTimeSec(timeStr);
          if (
            !Number.isFinite(tSec) ||
            !Number.isFinite(open) ||
            !Number.isFinite(high) ||
            !Number.isFinite(low) ||
            !Number.isFinite(close) ||
            close <= 0
          ) {
            return;
          }
          pending.bars.push({
            time: tSec,
            open,
            high: Math.max(high, open, close),
            low: Math.min(low, open, close),
            close,
            volume: Number.isFinite(volume) && volume >= 0 ? volume : 0,
          });
        },
      );

      register(
        EventName.tickByTickAllLast,
        (reqId: number, _tickType: number, time: string | number, price: number, size: number) => {
          const symbol = this.reqIdToStreamSymbol.get(reqId);
          if (!symbol) return;
          const stream = this.streams.get(symbol);
          if (!stream) return;
          const tSec = parseIbkrBarTimeSec(time);
          const safeTime = Number.isFinite(tSec) && tSec > 0 ? tSec : Math.floor(Date.now() / 1000);
          if (!Number.isFinite(price) || price <= 0) return;
          const safeSize = Number.isFinite(size) && size > 0 ? size : 0;
          this.ingestLiveTrade(stream, price, safeSize, safeTime);
        },
      );

      register(EventName.tickPrice, (reqId: number, field: TickType, value: number) => {
        if (!Number.isFinite(value) || value <= 0) return;

        const scannerSub = this.scannerReqIdToCallbacks.get(reqId);
        if (scannerSub) {
          scannerSub.callbacks.onPriceTick(field as number, value);
          return;
        }

        const symbol = this.reqIdToStreamSymbol.get(reqId);
        if (!symbol) return;

        const sharedScannerSet = this.scannerSubscribers.get(symbol);
        if (sharedScannerSet) {
          for (const cb of sharedScannerSet) {
            cb.onPriceTick(field as number, value);
          }
        }

        const stream = this.streams.get(symbol);
        if (!stream) return;

        if (field === IB_TICK.BID || field === IB_TICK.DELAYED_BID) {
          stream.lastBid = value;
          this.emitQuote(stream);
        } else if (field === IB_TICK.ASK || field === IB_TICK.DELAYED_ASK) {
          stream.lastAsk = value;
          this.emitQuote(stream);
        } else if (field === IB_TICK.CLOSE || field === IB_TICK.DELAYED_CLOSE) {
          stream.priorClose = value;
          this.emitQuote(stream);
        } else if (
          (field === IB_TICK.LAST || field === IB_TICK.DELAYED_LAST) &&
          stream.usingRtVolumeFallback
        ) {
          const prevPrice = stream.lastPrice;
          stream.lastPrice = value;
          // In Delayed Frozen mode (4), TWS immediately emits a frozen LAST snapshot even when the
          // market is closed or quiet. Always emitQuote() so toolbar/order panel show the exact IBKR
          // frozen/delayed price, and ONLY synthesize a 1s candle when an actual session trade occurred.
          if (this.effectiveMarketDataType !== MarketDataType.REALTIME) {
            const latestBarSec = this.getLatestKnownBarSec(stream);
            const hasFreshTick88 =
              stream.lastDelayedTimestampSec !== null &&
              stream.lastDelayedTimestampSec > 0 &&
              stream.lastDelayedTimestampSec >= latestBarSec;
            const size =
              stream.lastCumulativeVolume === null && stream.lastDelayedTradeSize > 0
                ? stream.lastDelayedTradeSize
                : 0;
            stream.lastDelayedTradeSize = 0;
            const nyDelayed = getNyClockParts(Math.floor(Date.now() / 1000) - 900);
            const inUsSession =
              !nyDelayed.isWeekend && nyDelayed.minutes >= 240 && nyDelayed.minutes < 1200;
            const shouldIngestCandle =
              hasFreshTick88 ||
              size > 0 ||
              (stream.hasInitialDelayedSnapshot && prevPrice !== value && inUsSession);
            stream.hasInitialDelayedSnapshot = true;

            if (shouldIngestCandle) {
              const tradeTimeSec = this.resolveStreamTradeTimeSec(stream);
              stream.lastTradeTimeSec = tradeTimeSec;
              this.emitQuote(stream);
              this.ingestLiveTrade(stream, value, size, tradeTimeSec);
            } else {
              this.emitQuote(stream);
            }
          } else {
            this.emitQuote(stream);
          }
        }
      });

      register(EventName.tickSize, (reqId: number, field?: TickType, value?: number) => {
        if (typeof field !== "number" || typeof value !== "number" || !Number.isFinite(value) || value < 0) {
          return;
        }
        const scannerSub = this.scannerReqIdToCallbacks.get(reqId);
        if (scannerSub) {
          scannerSub.callbacks.onSizeTick(field, value);
          return;
        }
        const symbol = this.reqIdToStreamSymbol.get(reqId);
        if (!symbol) return;
        const sharedScannerSet = this.scannerSubscribers.get(symbol);
        if (sharedScannerSet) {
          for (const cb of sharedScannerSet) {
            cb.onSizeTick(field, value);
          }
        }
        const stream = this.streams.get(symbol);
        if (!stream) return;
        if (
          stream.usingRtVolumeFallback &&
          this.effectiveMarketDataType !== MarketDataType.REALTIME
        ) {
          if (field === IB_TICK.VOLUME || field === IB_TICK.DELAYED_VOLUME) {
            const cumShares = Math.round(value);
            if (cumShares >= 0) {
              if (stream.lastCumulativeVolume === null) {
                stream.lastCumulativeVolume = cumShares;
                stream.lastDelayedTradeSize = 0;
              } else if (cumShares > stream.lastCumulativeVolume) {
                const deltaShares = cumShares - stream.lastCumulativeVolume;
                stream.lastCumulativeVolume = cumShares;
                stream.lastDelayedTradeSize = 0;
                if (stream.lastPrice !== null && stream.lastPrice > 0 && deltaShares > 0) {
                  const tradeTimeSec = this.resolveStreamTradeTimeSec(stream);
                  stream.lastTradeTimeSec = tradeTimeSec;
                  this.ingestLiveTrade(stream, stream.lastPrice, deltaShares, tradeTimeSec);
                }
              }
            }
          } else if (
            stream.lastCumulativeVolume === null &&
            (field === IB_TICK.LAST_SIZE || field === IB_TICK.DELAYED_LAST_SIZE) &&
            value > 0
          ) {
            if (stream.lastPrice !== null && stream.lastPrice > 0) {
              const tradeTimeSec = this.resolveStreamTradeTimeSec(stream);
              stream.lastTradeTimeSec = tradeTimeSec;
              this.ingestLiveTrade(stream, stream.lastPrice, value, tradeTimeSec);
            } else {
              stream.lastDelayedTradeSize = value;
            }
          }
        }
      });

      register(EventName.tickString, (reqId: number, field: TickType, value: string) => {
        if (field === IB_TICK.DELAYED_LAST_TIMESTAMP) {
          const symbol = this.reqIdToStreamSymbol.get(reqId);
          const stream = symbol ? this.streams.get(symbol) : undefined;
          if (stream) {
            const parsedSec = Number(String(value ?? "").trim());
            if (Number.isFinite(parsedSec) && parsedSec > 1_000_000_000) {
              const floored = Math.floor(parsedSec);
              stream.lastDelayedTimestampSec = floored;
              stream.lastTradeTimeSec = Math.max(stream.lastTradeTimeSec ?? 0, floored);
              if (stream.lastPrice !== null && stream.lastPrice > 0) {
                this.emitQuote(stream);
              }
            }
          }
          return;
        }
        if (field !== IB_TICK.RT_VOLUME && field !== IB_TICK.RT_TRD_VOLUME) return;
        const parts = String(value ?? "").split(";");
        const price = Number(parts[0]);
        const size = Number(parts[1]);
        const tsMs = Number(parts[2]);
        const totalVol = Number(parts[3]);
        if (!Number.isFinite(price) || price <= 0) return;

        const scannerSub = this.scannerReqIdToCallbacks.get(reqId);
        if (scannerSub) {
          scannerSub.callbacks.onRtVolumeTick(price, size, tsMs, totalVol);
          return;
        }

        const symbol = this.reqIdToStreamSymbol.get(reqId);
        if (!symbol) return;

        const sharedScannerSet = this.scannerSubscribers.get(symbol);
        if (sharedScannerSet) {
          for (const cb of sharedScannerSet) {
            cb.onRtVolumeTick(price, size, tsMs, totalVol);
          }
        }

        const stream = this.streams.get(symbol);
        if (!stream) return;

        let tradeVol = Number.isFinite(size) && size > 0 ? size : 0;
        if (Number.isFinite(totalVol) && totalVol >= 0) {
          if (stream.lastRtTotalVolume !== null && totalVol >= stream.lastRtTotalVolume) {
            const delta = totalVol - stream.lastRtTotalVolume;
            if (delta > 0) tradeVol = delta;
          }
          stream.lastRtTotalVolume = totalVol;
        }
        if (stream.usingRtVolumeFallback) {
          const sec =
            Number.isFinite(tsMs) && tsMs > 0
              ? Math.floor(tsMs / 1000)
              : Math.floor(Date.now() / 1000);
          this.ingestLiveTrade(stream, price, tradeVol, sec);
        }
      });

      register(
        EventName.scannerData,
        (reqId: number, _rank: number, contractDetails: ContractDetails) => {
          const pending = this.pendingScanners.get(reqId);
          if (!pending) return;
          const c = contractDetails?.contract;
          const rawTicker = (c?.symbol ?? "").trim().toUpperCase().replace(/\s+/g, ".");
          if (!rawTicker || pending.seenTickers.has(rawTicker)) return;
          pending.seenTickers.add(rawTicker);
          pending.rows.push({
            id: `${c?.exchange || "SMART"}:${rawTicker}`,
            ticker: rawTicker,
            description: contractDetails?.longName || rawTicker,
            close: 0,
            change: null,
            volume: null,
            relativeVolume: null,
            marketCap: null,
            priceToBook: null,
            epsDiluted: null,
            epsGrowthYoY: null,
            dividendYield: null,
            sector: contractDetails?.industry || contractDetails?.category || "",
            exchange: c?.primaryExch === "ISLAND" ? "NASDAQ" : c?.primaryExch || "US",
            perfW: null,
            perf1M: null,
            perf3M: null,
            perfYTD: null,
            perfY: null,
            rsi: null,
            recommendAll: null,
            floatShares: null,
            currency: c?.currency || "USD",
            country: "United States",
            premarketClose: null,
            premarketChange: null,
            premarketVolume: null,
          });
        },
      );

      register(EventName.scannerDataEnd, (reqId: number) => {
        const pending = this.pendingScanners.get(reqId);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pendingScanners.delete(reqId);
        try {
          transport.cancelScannerSubscription(reqId);
        } catch {
          // ignore
        }
        pending.resolve(pending.rows);
      });

      register(
        EventName.symbolSamples,
        (reqId: number, contractDescriptions: ContractDescription[]) => {
          const pending = this.pendingSymbolSearch.get(reqId);
          if (!pending) return;
          clearTimeout(pending.timer);
          this.pendingSymbolSearch.delete(reqId);
          pending.resolve(Array.isArray(contractDescriptions) ? contractDescriptions : []);
        },
      );

      register(
        EventName.contractDetails,
        (reqId: number, details: ContractDetails) => {
          const pending = this.pendingContractDetails.get(reqId);
          if (!pending) return;
          if (details) pending.items.push(details);
        },
      );

      register(EventName.contractDetailsEnd, (reqId: number) => {
        const pending = this.pendingContractDetails.get(reqId);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pendingContractDetails.delete(reqId);
        pending.resolve(pending.items);
      });

      register(EventName.newsProviders, (providers: NewsProvider[]) => {
        const codes = Array.isArray(providers)
          ? providers
              .map((p) => (typeof p?.providerCode === "string" ? p.providerCode.trim() : ""))
              .filter(Boolean)
              .join("+")
          : "";
        this.cachedNewsProviders = codes;
        if (this.newsProvidersWaiter) {
          const w = this.newsProvidersWaiter;
          this.newsProvidersWaiter = null;
          clearTimeout(w.timer);
          w.resolve(codes);
        }
      });

      register(
        EventName.historicalNews,
        (reqId: number, time: string, providerCode: string, _articleId: string, headline: string) => {
          const pending = this.pendingNews.get(reqId);
          if (!pending) return;
          const cleanTitle = String(headline ?? "").trim();
          if (!cleanTitle) return;
          const tSec = parseIbkrBarTimeSec(time);
          pending.items.push({
            title: cleanTitle,
            publisher: String(providerCode || "IBKR"),
            link: "",
            publishedAt: Number.isFinite(tSec) ? tSec * 1000 : null,
            catalystTag: classifyNewsCatalyst(cleanTitle),
          });
        },
      );

      register(EventName.historicalNewsEnd, (reqId: number) => {
        const pending = this.pendingNews.get(reqId);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pendingNews.delete(reqId);
        pending.resolve(pending.items);
      });

      try {
        transport.connect(this.config.clientId);
      } catch (err) {
        onConnectFail(err instanceof Error ? err.message : String(err));
      }
    });

    return this.connectPromise;
  }

  private handleIbkrError(
    err: Error,
    code: number,
    reqId: number,
    onConnectFail?: (msg: string) => void,
  ): void {
    const msg = err?.message || `IBKR error ${code}`;
    // 2104, 2106, 2107, 2158 = market data / historical farm connected (informational)
    if (code === 2104 || code === 2106 || code === 2107 || code === 2108 || code === 2158) {
      return;
    }

    // 1100 = Connectivity between IB and TWS lost
    if (code === 1100) {
      this.connectionState = "reconnecting";
      this.lastError = msg;
      this.emitStatus(msg);
      return;
    }

    // 1101 = Connectivity restored, market data lost -> re-subscribe everything
    if (code === 1101) {
      this.connectionState = "connected";
      this.lastError = null;
      this.emitStatus();
      this.resubscribeAllStreams();
      return;
    }

    // 1102 = Connectivity restored, market data maintained
    if (code === 1102) {
      this.connectionState = "connected";
      this.lastError = null;
      this.emitStatus();
      return;
    }

    // Connection refused / socket error during handshake
    if (code === 502 || code === 504 || code === 509 || (!reqId || reqId < 0)) {
      if (onConnectFail) {
        onConnectFail(msg);
        return;
      }
    }

    // 10167 = Informational notice from TWS that delayed market data is being displayed
    if (code === 10167) {
      if (this.effectiveMarketDataType === MarketDataType.REALTIME) {
        this.effectiveMarketDataType = MarketDataType.DELAYED_FROZEN;
        this.emitStatus();
      }
      return;
    }

    // 10089 / 10090 / 354 / 321 (generic tick rejected in delayed mode) -> auto-fallback to Delayed Frozen (4)
    if (
      reqId > 0 &&
      (code === 10089 ||
        code === 10090 ||
        code === 354 ||
        (code === 321 &&
          (Array.from(this.streams.values()).some((s) => s.mktDataReqId === reqId) ||
            this.scannerReqIdToCallbacks.has(reqId)))) &&
      (this.reqIdToStreamSymbol.has(reqId) || this.scannerReqIdToCallbacks.has(reqId))
    ) {
      if (this.effectiveMarketDataType !== MarketDataType.DELAYED_FROZEN) {
        this.effectiveMarketDataType = MarketDataType.DELAYED_FROZEN;
        this.lastError =
          `Sin suscripción API Live (código ${code}): usando datos diferidos IBKR automáticamente.`;
        try {
          this.transport?.reqMarketDataType(MarketDataType.DELAYED_FROZEN);
        } catch {
          // ignore
        }
        this.resubscribeMktDataForDelayedFallback();
        this.emitStatus(this.lastError);
      }
      return;
    }

    // Tick-by-tick limit exceeded or unsupported -> fall back cleanly to RTVolume / Delayed L1 stream
    if (reqId > 0) {
      const streamSym = this.reqIdToStreamSymbol.get(reqId);
      if (streamSym) {
        const stream = this.streams.get(streamSym);
        if (
          stream &&
          stream.tickByTickReqId === reqId &&
          (code === 10197 ||
            code === 10189 ||
            code === 10190 ||
            code === 10167 ||
            code === 10089 ||
            code === 10090 ||
            code === 354 ||
            code === 309 ||
            code === 321)
        ) {
          stream.usingRtVolumeFallback = true;
          this.reqIdToStreamSymbol.delete(reqId);
          stream.tickByTickReqId = null;
          return;
        }
      }
    }

    const histPending = this.pendingHistorical.get(reqId);
    if (histPending) {
      this.cleanupHistoricalReq(reqId);
      histPending.reject(new Error(`IBKR [${code}] ${msg}`));
      return;
    }

    const scanPending = this.pendingScanners.get(reqId);
    if (scanPending) {
      clearTimeout(scanPending.timer);
      this.pendingScanners.delete(reqId);
      try {
        this.transport?.cancelScannerSubscription(reqId);
      } catch {
        // ignore
      }
      scanPending.reject(new Error(`IBKR Scanner [${code}] ${msg}`));
      return;
    }

    const symPending = this.pendingSymbolSearch.get(reqId);
    if (symPending) {
      clearTimeout(symPending.timer);
      this.pendingSymbolSearch.delete(reqId);
      symPending.reject(new Error(`IBKR Search [${code}] ${msg}`));
      return;
    }

    const detPending = this.pendingContractDetails.get(reqId);
    if (detPending) {
      clearTimeout(detPending.timer);
      this.pendingContractDetails.delete(reqId);
      detPending.reject(new Error(`IBKR ContractDetails [${code}] ${msg}`));
      return;
    }

    const newsPending = this.pendingNews.get(reqId);
    if (newsPending) {
      clearTimeout(newsPending.timer);
      this.pendingNews.delete(reqId);
      newsPending.reject(new Error(`IBKR News [${code}] ${msg}`));
    }
  }

  private scheduleReconnect(): void {
    if (!this.desiredConnected || this.reconnectTimer || this.streams.size === 0) {
      return;
    }
    const baseDelay = Math.min(15_000, 1_000 * Math.pow(2, this.reconnectAttempt));
    const jitter = Math.floor(Math.random() * 250);
    this.reconnectAttempt = Math.min(10, this.reconnectAttempt + 1);
    this.connectionState = "reconnecting";
    this.emitStatus();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.desiredConnected || this.streams.size === 0) return;
      void this.ensureConnected().catch(() => {
        // ensureConnected schedules the next backoff on failure
      });
    }, baseDelay + jitter);
  }

  private detachTransportListeners(): void {
    if (!this.transport) return;
    for (const [ev, fn] of this.boundHandlers) {
      try {
        this.transport.off(ev, fn);
      } catch {
        // ignore
      }
    }
    this.boundHandlers.length = 0;
  }

  private disconnectTransportOnly(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.failAllPendingRequests(new Error("IBKR transport disconnected"));
    this.reqIdToStreamSymbol.clear();
    for (const stream of this.streams.values()) {
      stream.tickByTickReqId = null;
      stream.mktDataReqId = null;
    }
    if (this.transport) {
      const t = this.transport;
      this.detachTransportListeners();
      this.transport = null;
      try {
        t.disconnect();
      } catch {
        // ignore
      }
    }
    this.connectionState = "disconnected";
  }

  disconnect(): void {
    this.desiredConnected = false;
    this.reconnectAttempt = 0;
    this.scanner.dispose();
    this.scannerSubscribers.clear();
    this.scannerReqIdToCallbacks.clear();
    for (const stream of Array.from(this.streams.values())) {
      if (stream.warmReleaseTimer) {
        clearTimeout(stream.warmReleaseTimer);
        stream.warmReleaseTimer = null;
      }
      this.teardownSymbolStream(stream.symbol);
    }
    this.disconnectTransportOnly();
    this.emitStatus();
  }

  dispose(): void {
    this.disconnect();
    this.pacingQueue.dispose();
    this.removeAllListeners();
  }

  private getLatestKnownBarSec(stream: ActiveSymbolStream): number {
    let maxSec = 0;
    for (const t of stream.bars1s.keys()) {
      if (t > maxSec) maxSec = t;
    }
    for (const t of stream.sessionBars1m.keys()) {
      if (t > maxSec) maxSec = t;
    }
    return maxSec;
  }

  private resolveStreamTradeTimeSec(stream: ActiveSymbolStream): number {
    const nowSec = Math.floor(Date.now() / 1000);
    if (
      this.effectiveMarketDataType === MarketDataType.REALTIME ||
      this.effectiveMarketDataType === MarketDataType.FROZEN
    ) {
      return nowSec;
    }
    const latestBarSec = this.getLatestKnownBarSec(stream);
    if (stream.lastDelayedTimestampSec !== null && stream.lastDelayedTimestampSec > 0) {
      return Math.max(stream.lastDelayedTimestampSec, latestBarSec);
    }
    const delayedSec = nowSec - 900;
    return Math.max(delayedSec, latestBarSec);
  }

  private emitStatus(reason?: string): void {
    const evt: IbkrStreamEvent = {
      type: "status",
      connected: this.connectionState === "connected",
      connectionState: this.connectionState,
      marketDataType: this.effectiveMarketDataType,
      ...(reason ? { reason } : {}),
    };
    this.emit("stream-event", evt);
  }

  private emitQuote(stream: ActiveSymbolStream): void {
    const quoteTsMs =
      this.effectiveMarketDataType === MarketDataType.REALTIME ||
      this.effectiveMarketDataType === MarketDataType.FROZEN
        ? Date.now()
        : (stream.lastTradeTimeSec ?? this.resolveStreamTradeTimeSec(stream)) * 1000;
    const evt: IbkrStreamEvent = {
      type: "quote",
      symbol: stream.symbol,
      ...(stream.lastBid !== null ? { bid: stream.lastBid } : {}),
      ...(stream.lastAsk !== null ? { ask: stream.lastAsk } : {}),
      ...(stream.lastPrice !== null ? { last: stream.lastPrice } : {}),
      ...(stream.priorClose !== null ? { priorClose: stream.priorClose } : {}),
      timestamp: quoteTsMs,
    };
    this.emit("stream-event", evt);
  }

  private allocReqId(): number {
    this.nextReqId += 1;
    if (this.nextReqId > 2_000_000_000) this.nextReqId = 10_000;
    return this.nextReqId;
  }

  private cleanupHistoricalReq(reqId: number): void {
    const pending = this.pendingHistorical.get(reqId);
    if (!pending) return;
    clearTimeout(pending.timer);
    if (pending.signal && pending.abortHandler) {
      pending.signal.removeEventListener("abort", pending.abortHandler);
    }
    this.pendingHistorical.delete(reqId);
  }

  private failAllPendingRequests(err: Error): void {
    for (const reqId of Array.from(this.pendingHistorical.keys())) {
      const p = this.pendingHistorical.get(reqId)!;
      this.cleanupHistoricalReq(reqId);
      p.reject(err);
    }
    for (const [reqId, p] of this.pendingScanners.entries()) {
      clearTimeout(p.timer);
      this.pendingScanners.delete(reqId);
      p.reject(err);
    }
    for (const [reqId, p] of this.pendingSymbolSearch.entries()) {
      clearTimeout(p.timer);
      this.pendingSymbolSearch.delete(reqId);
      p.reject(err);
    }
    for (const [reqId, p] of this.pendingContractDetails.entries()) {
      clearTimeout(p.timer);
      this.pendingContractDetails.delete(reqId);
      p.reject(err);
    }
    for (const [reqId, p] of this.pendingNews.entries()) {
      clearTimeout(p.timer);
      this.pendingNews.delete(reqId);
      p.reject(err);
    }
    if (this.newsProvidersWaiter) {
      clearTimeout(this.newsProvidersWaiter.timer);
      const w = this.newsProvidersWaiter;
      this.newsProvidersWaiter = null;
      w.reject(err);
    }
  }

  private executeHistoricalRequest(
    contract: Contract,
    endDateTime: string | undefined,
    durationStr: string,
    barSize: BarSizeSetting,
    whatToShow: WhatToShow,
    signal?: AbortSignal,
    timeoutMs = 15_000,
  ): Promise<OhlcvBar[]> {
    return new Promise<OhlcvBar[]>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error("Request aborted"));
        return;
      }
      if (!this.transport || this.connectionState !== "connected") {
        reject(new Error("IBKR not connected"));
        return;
      }

      const reqId = this.allocReqId();
      const timer = setTimeout(() => {
        if (!this.pendingHistorical.has(reqId)) return;
        this.cleanupHistoricalReq(reqId);
        try {
          this.transport?.cancelHistoricalData(reqId);
        } catch {
          // ignore
        }
        reject(new Error(`IBKR historical request timeout (${contract.symbol} ${barSize})`));
      }, timeoutMs);

      const abortHandler = () => {
        if (!this.pendingHistorical.has(reqId)) return;
        this.cleanupHistoricalReq(reqId);
        try {
          this.transport?.cancelHistoricalData(reqId);
        } catch {
          // ignore
        }
        reject(new Error("Request aborted"));
      };
      if (signal) {
        signal.addEventListener("abort", abortHandler, { once: true });
      }

      this.pendingHistorical.set(reqId, {
        reqId,
        bars: [],
        resolve,
        reject,
        timer,
        signal,
        abortHandler,
      });

      try {
        this.transport.reqHistoricalData(
          reqId,
          contract,
          endDateTime ?? "",
          durationStr,
          barSize,
          whatToShow,
          0, // useRTH = 0 => include extended hours / pre-market
          2, // formatDate = 2 => unix epoch seconds
          false,
        );
      } catch (err) {
        this.cleanupHistoricalReq(reqId);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /**
   * Acquires a reference-counted live stream for `symbol` (1s base bars + quote + consolidated VWAP).
   * Switching timeframes NEVER releases or restarts the symbol stream.
   */
  acquireSymbolStream(
    symbol: string,
    exchangeHint?: string,
  ): () => void {
    const cleanSym = symbol.trim().toUpperCase();
    let stream = this.streams.get(cleanSym);
    if (stream) {
      stream.refs += 1;
      stream.lastTouchedAt = Date.now();
      if (stream.warmReleaseTimer) {
        clearTimeout(stream.warmReleaseTimer);
        stream.warmReleaseTimer = null;
      }
    } else {
      // Enforce warm stream cap before adding a new symbol
      this.evictExcessWarmStreams(MAX_WARM_STREAMS - 1);
      const todayKey = getNyTradingDayKey(Math.floor(Date.now() / 1000));
      stream = {
        symbol: cleanSym,
        contract: toIbkrContract(cleanSym, exchangeHint),
        refs: 1,
        warmReleaseTimer: null,
        tickByTickReqId: null,
        mktDataReqId: null,
        usingRtVolumeFallback: false,
        bars1s: new Map(),
        bars1sIngestedAt: new Map(),
        sessionBars1m: new Map(),
        lastRtTotalVolume: null,
        lastCumulativeVolume: null,
        lastDelayedTradeSize: 0,
        lastDelayedTimestampSec: null,
        lastTradeTimeSec: null,
        hasInitialDelayedSnapshot: false,
        lastBid: null,
        lastAsk: null,
        lastPrice: null,
        priorClose: null,
        vwapExtended: createVwapAccumulator(todayKey),
        vwapRegular: createVwapAccumulator(todayKey),
        backfillPromise: null,
        lastTouchedAt: Date.now(),
      };
      this.streams.set(cleanSym, stream);
      void this.startStreamAndBackfill(stream);
    }

    let released = false;
    return () => {
      if (released) return;
      released = true;
      const cur = this.streams.get(cleanSym);
      if (!cur) return;
      cur.refs = Math.max(0, cur.refs - 1);
      cur.lastTouchedAt = Date.now();
      if (cur.refs === 0 && !cur.warmReleaseTimer) {
        cur.warmReleaseTimer = setTimeout(() => {
          cur.warmReleaseTimer = null;
          const latest = this.streams.get(cleanSym);
          if (latest && latest.refs === 0) {
            this.teardownSymbolStream(cleanSym);
          }
        }, WARM_RELEASE_GRACE_MS);
      }
    };
  }

  private evictExcessWarmStreams(maxZeroRefToKeep: number): void {
    const zeroRef = Array.from(this.streams.values())
      .filter((s) => s.refs === 0)
      .sort((a, b) => a.lastTouchedAt - b.lastTouchedAt);
    while (this.streams.size > maxZeroRefToKeep && zeroRef.length > 0) {
      const victim = zeroRef.shift()!;
      if (victim.warmReleaseTimer) {
        clearTimeout(victim.warmReleaseTimer);
        victim.warmReleaseTimer = null;
      }
      this.teardownSymbolStream(victim.symbol);
    }
  }

  private teardownSymbolStream(symbol: string): void {
    const stream = this.streams.get(symbol);
    if (!stream) return;
    if (stream.warmReleaseTimer) {
      clearTimeout(stream.warmReleaseTimer);
      stream.warmReleaseTimer = null;
    }
    if (stream.tickByTickReqId !== null) {
      const rid = stream.tickByTickReqId;
      stream.tickByTickReqId = null;
      this.reqIdToStreamSymbol.delete(rid);
      try {
        this.transport?.cancelTickByTickData(rid);
      } catch {
        // ignore
      }
    }
    if (stream.mktDataReqId !== null) {
      const rid = stream.mktDataReqId;
      stream.mktDataReqId = null;
      this.reqIdToStreamSymbol.delete(rid);
      try {
        this.transport?.cancelMktData(rid);
      } catch {
        // ignore
      }
    }
    this.streams.delete(symbol);
  }

  private resubscribeAllStreams(): void {
    for (const stream of this.streams.values()) {
      if (stream.tickByTickReqId !== null) {
        const rid = stream.tickByTickReqId;
        stream.tickByTickReqId = null;
        this.reqIdToStreamSymbol.delete(rid);
        try {
          this.transport?.cancelTickByTickData(rid);
        } catch {
          // ignore cancel failure on stale reconnect handle
        }
      }
      if (stream.mktDataReqId !== null) {
        const rid = stream.mktDataReqId;
        stream.mktDataReqId = null;
        this.reqIdToStreamSymbol.delete(rid);
        try {
          this.transport?.cancelMktData(rid);
        } catch {
          // ignore cancel failure on stale reconnect handle
        }
      }
      this.attachTransportSubscriptions(stream);
      void this.backfillStreamSession(stream);
    }
    this.scanner.handleReconnect();
  }

  private attachTransportSubscriptions(stream: ActiveSymbolStream): void {
    if (!this.transport || this.connectionState !== "connected") return;

    if (this.effectiveMarketDataType !== MarketDataType.REALTIME) {
      stream.usingRtVolumeFallback = true;
    }

    if (stream.tickByTickReqId === null && !stream.usingRtVolumeFallback) {
      const tbtId = this.allocReqId();
      stream.tickByTickReqId = tbtId;
      this.reqIdToStreamSymbol.set(tbtId, stream.symbol);
      try {
        this.transport.reqTickByTickData(
          tbtId,
          stream.contract,
          TickByTickDataType.AllLast,
          0,
          false,
        );
      } catch {
        this.reqIdToStreamSymbol.delete(tbtId);
        stream.tickByTickReqId = null;
        stream.usingRtVolumeFallback = true;
      }
    }

    if (stream.mktDataReqId === null) {
      const mktId = this.allocReqId();
      stream.mktDataReqId = mktId;
      this.reqIdToStreamSymbol.set(mktId, stream.symbol);
      const genericTicks = this.effectiveMarketDataType === 1 ? "165,233" : "";
      try {
        this.transport.reqMktData(mktId, stream.contract, genericTicks, false, false);
      } catch {
        this.reqIdToStreamSymbol.delete(mktId);
        stream.mktDataReqId = null;
      }
    }
  }

  private resubscribeMktDataForDelayedFallback(): void {
    const transport = this.transport;
    if (!transport || this.connectionState !== "connected") return;

    // Re-subscribe active chart symbol L1 streams in delayed mode
    for (const stream of this.streams.values()) {
      if (stream.mktDataReqId !== null) {
        const oldId = stream.mktDataReqId;
        this.reqIdToStreamSymbol.delete(oldId);
        try {
          transport.cancelMktData(oldId);
        } catch {
          // ignore
        }
        stream.mktDataReqId = null;
      }
      const nextId = this.allocReqId();
      stream.mktDataReqId = nextId;
      this.reqIdToStreamSymbol.set(nextId, stream.symbol);
      try {
        transport.reqMktData(nextId, stream.contract, "", false, false);
      } catch {
        this.reqIdToStreamSymbol.delete(nextId);
        stream.mktDataReqId = null;
      }
    }

    // Re-subscribe active scanner candidate L1 lines in delayed mode
    const activeScannerEntries = Array.from(this.scannerReqIdToCallbacks.entries());
    for (const [oldReqId, entry] of activeScannerEntries) {
      this.scannerReqIdToCallbacks.delete(oldReqId);
      try {
        transport.cancelMktData(oldReqId);
      } catch {
        // ignore
      }
      const nextReqId = this.allocReqId();
      this.scannerReqIdToCallbacks.set(nextReqId, entry);
      try {
        transport.reqMktData(nextReqId, entry.contract, "", false, false);
      } catch {
        this.scannerReqIdToCallbacks.delete(nextReqId);
      }
    }
  }

  private async startStreamAndBackfill(stream: ActiveSymbolStream): Promise<void> {
    try {
      await this.ensureConnected();
    } catch {
      return;
    }
    if (this.streams.get(stream.symbol) !== stream) return;
    this.attachTransportSubscriptions(stream);
    await this.backfillStreamSession(stream);
  }

  private backfillStreamSession(stream: ActiveSymbolStream): Promise<void> {
    if (stream.backfillPromise) return stream.backfillPromise;
    stream.backfillPromise = (async () => {
      try {
        // Fetch 2D of 1m consolidated bars (04:00 ET pre-market -> now) for exact intraday VWAP seeding,
        // plus recent 1800s of 1s bars for instant sub-minute resolution.
        const backfillStartMs = Date.now();
        const whatToShow =
          stream.contract.secType === SecType.CASH ? WhatToShow.MIDPOINT : WhatToShow.TRADES;
        const [bars1m, bars1s] = await Promise.all([
          this.pacingQueue
            .enqueue(`${stream.symbol}|1 min|2 D|0`, 300, () =>
              this.executeHistoricalRequest(
                stream.contract,
                "",
                "2 D",
                BarSizeSetting.MINUTES_ONE,
                whatToShow,
              ),
            )
            .catch(() => [] as OhlcvBar[]),
          this.pacingQueue
            .enqueue(`${stream.symbol}|1 secs|1800 S|0`, 450, () =>
              this.executeHistoricalRequest(
                stream.contract,
                "",
                "1800 S",
                BarSizeSetting.SECONDS_ONE,
                whatToShow,
              ),
            )
            .catch(() => [] as OhlcvBar[]),
        ]);

        if (this.streams.get(stream.symbol) !== stream) return;

        const latestBackfill1sSec = bars1s.length > 0 ? bars1s[bars1s.length - 1]!.time : 0;
        for (const b of bars1s) {
          const existing = stream.bars1s.get(b.time);
          if (!existing) {
            stream.bars1s.set(b.time, b);
          } else {
            const liveAfterStart = (stream.bars1sIngestedAt.get(b.time) ?? 0) >= backfillStartMs;
            stream.bars1s.set(b.time, {
              time: b.time,
              open: b.open,
              high: Math.max(b.high, existing.high),
              low: Math.min(b.low, existing.low),
              close: liveAfterStart ? existing.close : b.close,
              volume: Math.max(b.volume, existing.volume),
            });
          }
        }
        for (const b of bars1m) {
          const existing1m = stream.sessionBars1m.get(b.time);
          if (!existing1m) {
            stream.sessionBars1m.set(b.time, b);
          } else {
            // Add only live 1s volume strictly newer than the historical snapshot without double-counting
            let postSnapshotVol = 0;
            let latestPostClose: number | null = null;
            for (const [secKey, b1s] of stream.bars1s.entries()) {
              if (secKey >= b.time && secKey < b.time + 60) {
                const ing = stream.bars1sIngestedAt.get(secKey) ?? 0;
                if (ing >= backfillStartMs && secKey > latestBackfill1sSec) {
                  postSnapshotVol += b1s.volume;
                  latestPostClose = b1s.close;
                }
              }
            }
            stream.sessionBars1m.set(b.time, {
              time: b.time,
              open: b.open,
              high: Math.max(b.high, existing1m.high),
              low: Math.min(b.low, existing1m.low),
              close: latestPostClose ?? b.close,
              volume: Math.max(b.volume + postSnapshotVol, existing1m.volume),
            });
          }
        }
        this.prune1sWindow(stream);
        this.rebuildStreamVwapAccumulators(stream);

        if (bars1s.length > 0) {
          const latest = bars1s[bars1s.length - 1]!;
          stream.lastPrice = latest.close;
          stream.lastTradeTimeSec = latest.time;
          this.emit("stream-event", {
            type: "bar1s",
            symbol: stream.symbol,
            bar: latest,
            vwap: {
              extended: { ...stream.vwapExtended },
              regular: { ...stream.vwapRegular },
            },
          } satisfies IbkrStreamEvent);
        } else if (bars1m.length > 0) {
          const latest1m = bars1m[bars1m.length - 1]!;
          if (stream.lastPrice === null) {
            stream.lastPrice = latest1m.close;
          }
          stream.lastTradeTimeSec = latest1m.time + 59;
          this.emitQuote(stream);
        }
      } finally {
        stream.backfillPromise = null;
      }
    })();
    return stream.backfillPromise;
  }

  private prune1sWindow(stream: ActiveSymbolStream): void {
    if (stream.bars1s.size <= MAX_1S_WINDOW_BARS) return;
    const keys = Array.from(stream.bars1s.keys()).sort((a, b) => a - b);
    const excess = keys.length - MAX_1S_WINDOW_BARS;
    for (let i = 0; i < excess; i++) {
      const k = keys[i]!;
      stream.bars1s.delete(k);
      stream.bars1sIngestedAt.delete(k);
    }
  }

  private rebuildStreamVwapAccumulators(stream: ActiveSymbolStream): void {
    const all1m = Array.from(stream.sessionBars1m.values()).sort((a, b) => a.time - b.time);
    const all1s = Array.from(stream.bars1s.values()).sort((a, b) => a.time - b.time);
    const latestTime =
      all1s[all1s.length - 1]?.time ??
      all1m[all1m.length - 1]?.time ??
      Math.floor(Date.now() / 1000);
    const activeDay = getNyTradingDayKey(latestTime);
    const ext = createVwapAccumulator(activeDay);
    const reg = createVwapAccumulator(activeDay);

    const first1sMinBucket =
      all1s.length > 0 ? getBucketStartSec(all1s[0]!.time, 60) : Number.MAX_SAFE_INTEGER;

    for (const b of all1m) {
      if (b.time >= first1sMinBucket) continue;
      const ny = getNyClockParts(b.time);
      if (ny.dayKey !== activeDay) continue;
      const tp = (b.high + b.low + b.close) / 3;
      updateVwapAccumulator(ext, activeDay, tp, b.volume);
      if (!ny.isWeekend && ny.minutes >= 570 && ny.minutes < 960) {
        updateVwapAccumulator(reg, activeDay, tp, b.volume);
      }
    }

    for (const b of all1s) {
      const ny = getNyClockParts(b.time);
      if (ny.dayKey !== activeDay) continue;
      const tp = (b.high + b.low + b.close) / 3;
      updateVwapAccumulator(ext, activeDay, tp, b.volume);
      if (!ny.isWeekend && ny.minutes >= 570 && ny.minutes < 960) {
        updateVwapAccumulator(reg, activeDay, tp, b.volume);
      }
    }

    stream.vwapExtended = ext;
    stream.vwapRegular = reg;
  }

  private ingestLiveTrade(
    stream: ActiveSymbolStream,
    price: number,
    size: number,
    timeSec: number,
  ): void {
    const sec = Math.floor(timeSec);
    const prev1s = stream.bars1s.get(sec);
    const updated1s: OhlcvBar = prev1s
      ? {
          time: sec,
          open: prev1s.open,
          high: Math.max(prev1s.high, price),
          low: Math.min(prev1s.low, price),
          close: price,
          volume: prev1s.volume + size,
        }
      : {
          time: sec,
          open: price,
          high: price,
          low: price,
          close: price,
          volume: size,
        };
    stream.bars1s.set(sec, updated1s);
    stream.bars1sIngestedAt.set(sec, Date.now());
    this.prune1sWindow(stream);

    // Keep 1m session buffer synchronized for VWAP & fast aggregation
    const minBucket = Math.floor(sec / 60) * 60;
    const prev1m = stream.sessionBars1m.get(minBucket);
    const updated1m: OhlcvBar = prev1m
      ? {
          time: minBucket,
          open: prev1m.open,
          high: Math.max(prev1m.high, price),
          low: Math.min(prev1m.low, price),
          close: price,
          volume: prev1m.volume + size,
        }
      : {
          time: minBucket,
          open: price,
          high: price,
          low: price,
          close: price,
          volume: size,
        };
    stream.sessionBars1m.set(minBucket, updated1m);

    // Update continuous intraday VWAP accumulators with exact trade print
    const ny = getNyClockParts(sec);
    updateVwapAccumulator(stream.vwapExtended, ny.dayKey, price, size);
    if (!ny.isWeekend && ny.minutes >= 570 && ny.minutes < 960) {
      updateVwapAccumulator(stream.vwapRegular, ny.dayKey, price, size);
    }

    stream.lastPrice = price;
    this.emit("stream-event", {
      type: "bar1s",
      symbol: stream.symbol,
      bar: { ...updated1s },
      vwap: {
        extended: { ...stream.vwapExtended },
        regular: { ...stream.vwapRegular },
      },
    } satisfies IbkrStreamEvent);
  }

  /**
   * Fetches stabilized historical candles + live 1s tail + VWAP session seeds for ANY timeframe.
   */
  async getHistoricalCandles(
    symbol: string,
    timeframe: string,
    minBars = 1500,
    exchangeHint?: string,
    signal?: AbortSignal,
    targetDate?: string,
  ): Promise<IbkrHistoricalResult> {
    await this.ensureConnected();
    const cleanSym = symbol.trim().toUpperCase();
    const contract = toIbkrContract(cleanSym, exchangeHint);
    const plan = resolveIbkrHistoricalQuery(timeframe, minBars);
    const minSpacing = plan.nativeSec <= 30 ? 450 : 300;
    const cleanTargetDate =
      typeof targetDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(targetDate.trim())
        ? targetDate.trim()
        : undefined;
    const targetEndSec = cleanTargetDate
      ? (() => {
          const [yStr, mStr, dStr] = cleanTargetDate.split("-");
          // End of NY After-Hours (20:00 ET <= 01:00 UTC next day; use 04:59:59 UTC next day to capture full session)
          const endUtcSec = Math.floor(
            Date.UTC(Number(yStr), Number(mStr) - 1, Number(dStr) + 1, 4, 59, 59) / 1000,
          );
          return Math.min(endUtcSec, Math.floor(Date.now() / 1000));
        })()
      : undefined;
    const initialEndStr = targetEndSec ? formatIbkrEndDateTimeUtc(targetEndSec) : "";

    const whatToShow =
      contract.secType === SecType.CASH ? WhatToShow.MIDPOINT : WhatToShow.TRADES;
    const histFetchStartMs = Date.now();
    const histFetchStartSec = Math.floor(histFetchStartMs / 1000);

    let rawBars: OhlcvBar[] = [];
    if (plan.chunks <= 1) {
      rawBars = await this.pacingQueue.enqueue(
        `${cleanSym}|${plan.barSize}|${plan.durationStr}|${initialEndStr || "0"}`,
        minSpacing,
        () =>
          this.executeHistoricalRequest(
            contract,
            initialEndStr,
            plan.durationStr,
            plan.barSize as BarSizeSetting,
            whatToShow,
            signal,
          ),
        signal,
        "high",
      );
    } else {
      const mergedChunks = new Map<number, OhlcvBar>();
      let endSec: number | undefined = targetEndSec;
      for (let i = 0; i < plan.chunks; i++) {
        if (signal?.aborted) throw new Error("Request aborted");
        const endStr = endSec ? formatIbkrEndDateTimeUtc(endSec) : "";
        const chunkBars = await this.pacingQueue.enqueue(
          `${cleanSym}|${plan.barSize}|${plan.durationStr}|${endStr}`,
          minSpacing,
          () =>
            this.executeHistoricalRequest(
              contract,
              endStr,
              plan.durationStr,
              plan.barSize as BarSizeSetting,
              whatToShow,
              signal,
            ),
          signal,
          "high",
        );
        for (const b of chunkBars) mergedChunks.set(b.time, b);
        if (chunkBars.length === 0) break;
        const earliest = chunkBars[0]!.time;
        endSec = earliest;
      }
      rawBars = Array.from(mergedChunks.values()).sort((a, b) => a.time - b.time);
    }

    let candles = plan.requiresResample
      ? aggregateCandles(rawBars, plan.targetSec)
      : rawBars;

    // Merge live 1s bars from any active symbol stream without double-counting volume
    // already included in IBKR's historical response for the current in-progress bucket.
    const stream = this.streams.get(cleanSym);
    if (!cleanTargetDate && stream && stream.bars1s.size > 0) {
      const live1s = Array.from(stream.bars1s.values()).sort((a, b) => a.time - b.time);
      const tfSec = parseTimeframeSeconds(timeframe);
      let working = candles.map((c) => ({ ...c }));

      if (working.length === 0) {
        working = aggregateCandles(live1s, tfSec);
      } else {
        const lastHistIdx = working.length - 1;
        const lastHist = working[lastHistIdx]!;
        let sameBucketLiveVol = 0;
        let sameBucketPostFetchVol = 0;
        const newer1s: OhlcvBar[] = [];
        const effectiveFetchCutSec =
          this.effectiveMarketDataType === MarketDataType.REALTIME ||
          this.effectiveMarketDataType === MarketDataType.FROZEN
            ? histFetchStartSec
            : histFetchStartSec - 900;

        const latestSession1mSec =
          stream.sessionBars1m.size > 0 ? Math.max(...stream.sessionBars1m.keys()) : 0;

        for (const b1s of live1s) {
          const bBucket = getBucketStartSec(b1s.time, tfSec);
          if (bBucket < lastHist.time) continue;
          if (bBucket === lastHist.time) {
            const ingestedAt = stream.bars1sIngestedAt.get(b1s.time) ?? 0;
            const isRealtimeMode =
              this.effectiveMarketDataType === MarketDataType.REALTIME ||
              this.effectiveMarketDataType === MarketDataType.FROZEN;
            const canUpdateClose = isRealtimeMode
              ? b1s.time >= latestSession1mSec
              : ingestedAt > histFetchStartMs || b1s.time > effectiveFetchCutSec;
            sameBucketLiveVol += b1s.volume;
            if (canUpdateClose) {
              lastHist.high = Math.max(lastHist.high, b1s.high);
              lastHist.low = Math.min(lastHist.low, b1s.low);
              lastHist.close = b1s.close;
              if (b1s.time > effectiveFetchCutSec) {
                sameBucketPostFetchVol += b1s.volume;
              }
            }
          } else {
            newer1s.push(b1s);
          }
        }
        lastHist.volume = Math.max(lastHist.volume + sameBucketPostFetchVol, sameBucketLiveVol);

        if (newer1s.length > 0) {
          const lastPrevVol = new Map<number, number>();
          for (const b1s of newer1s) {
            const prevVol = lastPrevVol.get(b1s.time) ?? 0;
            const merged = mergeLive1sBarIntoSeries(working, b1s, prevVol, timeframe);
            working = merged.bars;
            lastPrevVol.set(b1s.time, b1s.volume);
          }
        }
      }
      candles = working;
    }

    // Pull 1m session context for sub-minute charts (or reuse in-memory 1m buffer at zero extra
    // pacing cost for intraday charts whose window starts mid-session) so VWAP anchors to 04:00/09:30 ET.
    let vwapSeeds: { extended: VwapSessionSeed | null; regular: VwapSessionSeed | null } = {
      extended: null,
      regular: null,
    };
    const visibleStart = candles.length > 0 ? candles[0]!.time : 0;
    const visibleEnd = candles.length > 0 ? candles[candles.length - 1]!.time : 0;
    const tfSecForVwap = parseTimeframeSeconds(timeframe);
    const hasCached1m = !cleanTargetDate && Boolean(stream && stream.sessionBars1m.size > 0);
    const needsSubMinuteSeed = visibleStart > 0 && tfSecForVwap < 60;
    const canReuseCached1mSeed =
      visibleStart > 0 &&
      tfSecForVwap >= 60 &&
      tfSecForVwap < 86_400 &&
      hasCached1m &&
      getNyTradingDayKey(visibleStart) === getNyTradingDayKey(visibleEnd) &&
      getNyClockParts(visibleStart).minutes > 240;

    if (needsSubMinuteSeed || canReuseCached1mSeed) {
      let session1mBars =
        hasCached1m && stream
          ? Array.from(stream.sessionBars1m.values()).sort((a, b) => a.time - b.time)
          : [];
      if (session1mBars.length === 0 && needsSubMinuteSeed) {
        session1mBars = await this.pacingQueue
          .enqueue(
            `${cleanSym}|1 min|2 D|${initialEndStr || "0"}`,
            300,
            () =>
              this.executeHistoricalRequest(
                contract,
                initialEndStr,
                "2 D",
                BarSizeSetting.MINUTES_ONE,
                whatToShow,
                signal,
              ),
            signal,
            "high",
          )
          .catch(() => [] as OhlcvBar[]);
      }
      if (session1mBars.length > 0) {
        vwapSeeds = computeVwapSessionSeedsFromBars(session1mBars, visibleStart);
      }
    }

    const sessionRanges = deriveUsSessionRanges(candles);
    const latestCandle = candles.length > 0 ? candles[candles.length - 1]! : null;
    if (!cleanTargetDate && stream && latestCandle) {
      if (stream.lastTradeTimeSec === null || stream.lastTradeTimeSec < latestCandle.time) {
        stream.lastPrice = latestCandle.close;
        stream.lastTradeTimeSec = latestCandle.time;
      }
    }
    const regularMarketPrice =
      (!cleanTargetDate ? stream?.lastPrice : null) ?? latestCandle?.close ?? null;

    return {
      symbol: cleanSym,
      timeframe,
      candles,
      regularMarketPrice,
      preMarketRanges: sessionRanges.preMarketRanges,
      regularMarketRanges: sessionRanges.regularMarketRanges,
      postMarketRanges: sessionRanges.postMarketRanges,
      exchangeTimezoneName: "America/New_York",
      vwapSeeds,
      dataSource: "ibkr-consolidated",
    };
  }

  /**
   * Registers an external enricher (e.g. Phase 3 Float provider) in the decoupled
   * screener pipeline without modifying IBKR scanner internals.
   */
  registerScreenerEnricher(enricher: ScreenerEnricher<IbkrScreenerRow>): () => void {
    return this.screenerPipeline.registerEnricher(enricher);
  }

  /**
   * Registers a composable post-filter hook evaluated downstream of IBKR + enrichers.
   */
  registerScreenerPostFilter(hook: ScreenerPostFilter<IbkrScreenerRow>): () => void {
    return this.screenerPipeline.registerPostFilter(hook);
  }

  /**
   * Acquires a shared real-time SSE screener stream over IBKR US Consolidated market data.
   */
  acquireScreenerStream(
    payload: IbkrScreenerPayload,
    onEvent: (evt: IbkrScreenerStreamEvent) => void,
  ): () => void {
    return this.scanner.acquireStream(payload as Parameters<IbkrRealtimeScanner["acquireStream"]>[0], onEvent);
  }

  /**
   * Queries IBKR US Consolidated Scanner (NYSE · NASDAQ · AMEX) in real time with dynamic
   * session-aware filters and immediate scanner subscription cleanup.
   */
  async scanUsStocks(
    payload: IbkrScreenerPayload,
    signal?: AbortSignal,
  ): Promise<{
    totalCount: number;
    items: IbkrScreenerRow[];
    fetchedAt: number;
    source: "ibkr-consolidated";
    pipelineMeta: ScreenerPipelineMeta;
  }> {
    return this.scanner.scanSnapshot(
      payload as Parameters<IbkrRealtimeScanner["scanSnapshot"]>[0],
      signal,
    );
  }

  private createScannerHost(): IbkrScannerHost {
    return {
      ensureConnected: () => this.ensureConnected(),
      getConnectionState: () => this.connectionState,
      toContract: (symbol, exchangeHint) => toIbkrContract(symbol, exchangeHint),
      runRawScanner: (subscription, filterOptions, timeoutMs = 8_000) =>
        new Promise<IbkrScreenerRow[]>((resolve, reject) => {
          const transport = this.transport;
          if (!transport || this.connectionState !== "connected") {
            reject(new Error("IBKR not connected"));
            return;
          }
          const reqId = this.allocReqId();
          const timer = setTimeout(() => {
            const pending = this.pendingScanners.get(reqId);
            if (!pending) return;
            this.pendingScanners.delete(reqId);
            try {
              transport.cancelScannerSubscription(reqId);
            } catch {
              // ignore cancel error
            }
            resolve(pending.rows);
          }, timeoutMs);

          this.pendingScanners.set(reqId, {
            rows: [],
            seenTickers: new Set(),
            resolve,
            reject,
            timer,
          });

          try {
            transport.reqScannerSubscription(reqId, subscription, undefined, filterOptions);
          } catch (err) {
            clearTimeout(timer);
            this.pendingScanners.delete(reqId);
            reject(err instanceof Error ? err : new Error(String(err)));
          }
        }),
      subscribeCandidateMktData: (symbol, contract, callbacks) => {
        const cleanSym = symbol.trim().toUpperCase();
        const existingStream = this.streams.get(cleanSym);
        if (existingStream) {
          let set = this.scannerSubscribers.get(cleanSym);
          if (!set) {
            set = new Set();
            this.scannerSubscribers.set(cleanSym, set);
          }
          set.add(callbacks);
          if (existingStream.priorClose !== null && existingStream.priorClose > 0) {
            callbacks.onPriceTick(IB_TICK.CLOSE, existingStream.priorClose);
          }
          if (existingStream.lastPrice !== null && existingStream.lastPrice > 0) {
            callbacks.onPriceTick(IB_TICK.LAST, existingStream.lastPrice);
          }
          let released = false;
          return () => {
            if (released) return;
            released = true;
            const s = this.scannerSubscribers.get(cleanSym);
            if (!s) return;
            s.delete(callbacks);
            if (s.size === 0) this.scannerSubscribers.delete(cleanSym);
          };
        }

        let currentReqId = this.allocReqId();
        const entry = { symbol: cleanSym, contract, callbacks };
        this.scannerReqIdToCallbacks.set(currentReqId, entry);
        if (this.transport && this.connectionState === "connected") {
          const genericTicks = this.effectiveMarketDataType === 1 ? "165,233" : "";
          try {
            this.transport.reqMktData(currentReqId, contract, genericTicks, false, false);
          } catch {
            // ignore immediate request error
          }
        }
        let released = false;
        return () => {
          if (released) return;
          released = true;
          for (const [id, mapped] of Array.from(this.scannerReqIdToCallbacks.entries())) {
            if (mapped === entry) {
              this.scannerReqIdToCallbacks.delete(id);
              try {
                this.transport?.cancelMktData(id);
              } catch {
                // ignore cancel error
              }
            }
          }
        };
      },
      fetchDailyBaseline: async (symbol, exchangeHint, signal) => {
        const cleanSym = symbol.trim().toUpperCase();
        const contract = toIbkrContract(cleanSym, exchangeHint);
        const bars = await this.pacingQueue.enqueue(
          `${cleanSym}|1 day|4 M|1`,
          300,
          () =>
            this.executeHistoricalRequest(
              contract,
              "",
              "4 M",
              BarSizeSetting.DAYS_ONE,
              WhatToShow.TRADES,
              signal,
              4_500,
            ),
          signal,
        );
        if (bars.length === 0) {
          return { priorClose: null, avgVol10: null, avgVol30: null, avgVol90: null };
        }
        const todayKey = getNyTradingDayKey(Math.floor(Date.now() / 1000));
        const latest = bars[bars.length - 1]!;
        const latestDayKey =
          latest.time % 86_400 === 0
            ? (() => {
                const d = new Date(latest.time * 1000);
                return d.getUTCFullYear() * 10_000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
              })()
            : getNyTradingDayKey(latest.time);
        const latestIsToday = latestDayKey === todayKey;
        const priorBars = latestIsToday ? bars.slice(0, -1) : bars;
        const priorClose =
          priorBars.length > 0 ? priorBars[priorBars.length - 1]!.close : null;
        const avgSlice = (count: number): number | null => {
          const slice = priorBars.slice(-count);
          if (slice.length === 0) return null;
          return slice.reduce((acc, b) => acc + b.volume, 0) / slice.length;
        };
        return {
          priorClose,
          avgVol10: avgSlice(10),
          avgVol30: avgSlice(30),
          avgVol90: avgSlice(90),
        };
      },
      fetchPremarketSessionVolume: async (symbol, exchangeHint, signal) => {
        const cleanSym = symbol.trim().toUpperCase();
        const contract = toIbkrContract(cleanSym, exchangeHint);
        const bars = await this.pacingQueue.enqueue(
          `${cleanSym}|1 min|1 D|0`,
          300,
          () =>
            this.executeHistoricalRequest(
              contract,
              "",
              "1 D",
              BarSizeSetting.MINUTES_ONE,
              WhatToShow.TRADES,
              signal,
              4_500,
            ),
          signal,
        );
        const todayKey = getNyTradingDayKey(Math.floor(Date.now() / 1000));
        let premarketVolume = 0;
        let premarketClose: number | null = null;
        for (const b of bars) {
          if (getNyTradingDayKey(b.time) !== todayKey) continue;
          if (getUsPreMarketSessionState(b.time * 1000).isPreMarket) {
            premarketVolume += b.volume;
            premarketClose = b.close;
          }
        }
        return { premarketVolume, premarketClose };
      },
    };
  }

  async searchSymbols(query: string): Promise<
    Array<{
      ticker: string;
      description: string;
      exchange: string;
      currency: string;
      country: string;
    }>
  > {
    const clean = query.trim();
    if (clean.length < 1) return [];
    await this.ensureConnected();
    const transport = this.transport;
    if (!transport) return [];

    const reqId = this.allocReqId();
    const descriptions = await new Promise<ContractDescription[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pendingSymbolSearch.has(reqId)) return;
        this.pendingSymbolSearch.delete(reqId);
        resolve([]);
      }, 6_000);
      this.pendingSymbolSearch.set(reqId, { resolve, reject, timer });
      try {
        transport.reqMatchingSymbols(reqId, clean);
      } catch (err) {
        clearTimeout(timer);
        this.pendingSymbolSearch.delete(reqId);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });

    const out: Array<{
      ticker: string;
      description: string;
      exchange: string;
      currency: string;
      country: string;
    }> = [];
    const seen = new Set<string>();
    for (const d of descriptions) {
      const c = d?.contract;
      if (!c || c.secType !== SecType.STK || c.currency !== "USD") continue;
      const ticker = (c.symbol ?? "").trim().toUpperCase().replace(/\s+/g, ".");
      if (!ticker || seen.has(ticker)) continue;
      seen.add(ticker);
      const rawExch = (c.primaryExch ?? c.exchange ?? "US").trim().toUpperCase();
      const displayExch = rawExch === "ISLAND" ? "NASDAQ" : rawExch;
      out.push({
        ticker,
        description: c.description || ticker,
        exchange: displayExch,
        currency: "USD",
        country: "United States",
      });
    }
    return out;
  }

  async getStockNews(symbol: string): Promise<{ symbol: string; items: IbkrNewsHeadline[] }> {
    const cleanSym = symbol.trim().toUpperCase();
    const cached = this.newsCache.get(cleanSym);
    if (cached && Date.now() - cached.at < 120_000) {
      return { symbol: cleanSym, items: cached.items };
    }

    await this.ensureConnected();
    const transport = this.transport;
    if (!transport) return { symbol: cleanSym, items: [] };

    const detailsReqId = this.allocReqId();
    const details = await new Promise<ContractDetails[]>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingContractDetails.delete(detailsReqId);
        resolve([]);
      }, 5_000);
      this.pendingContractDetails.set(detailsReqId, { items: [], resolve, reject: () => resolve([]), timer });
      try {
        transport.reqContractDetails(detailsReqId, toIbkrContract(cleanSym));
      } catch {
        clearTimeout(timer);
        this.pendingContractDetails.delete(detailsReqId);
        resolve([]);
      }
    });
    const conId = details[0]?.contract?.conId;
    if (!conId || !Number.isFinite(conId)) {
      return { symbol: cleanSym, items: [] };
    }

    let providerCodes = this.cachedNewsProviders;
    if (providerCodes === null) {
      providerCodes = await new Promise<string>((resolve) => {
        const timer = setTimeout(() => {
          this.newsProvidersWaiter = null;
          resolve("");
        }, 4_000);
        this.newsProvidersWaiter = { resolve, reject: () => resolve(""), timer };
        try {
          transport.reqNewsProviders();
        } catch {
          clearTimeout(timer);
          this.newsProvidersWaiter = null;
          resolve("");
        }
      });
    }

    if (!providerCodes) {
      return { symbol: cleanSym, items: [] };
    }

    const now = new Date();
    const start = new Date(now.getTime() - 7 * 86_400_000);
    const fmtNewsDate = (d: Date) =>
      `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")} ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}:${String(d.getUTCSeconds()).padStart(2, "0")}.0`;

    const newsReqId = this.allocReqId();
    const items = await new Promise<IbkrNewsHeadline[]>((resolve) => {
      const timer = setTimeout(() => {
        const p = this.pendingNews.get(newsReqId);
        this.pendingNews.delete(newsReqId);
        resolve(p?.items ?? []);
      }, 6_000);
      this.pendingNews.set(newsReqId, { items: [], resolve, reject: () => resolve([]), timer });
      try {
        transport.reqHistoricalNews(
          newsReqId,
          conId,
          providerCodes,
          fmtNewsDate(start),
          fmtNewsDate(now),
          12,
        );
      } catch {
        clearTimeout(timer);
        this.pendingNews.delete(newsReqId);
        resolve([]);
      }
    });

    this.newsCache.set(cleanSym, { at: Date.now(), items });
    return { symbol: cleanSym, items };
  }
}
