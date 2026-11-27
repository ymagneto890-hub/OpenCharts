export type UsMarketSessionPhase = "premarket" | "regular" | "afterhours" | "closed";

export interface UsPreMarketSessionState {
  isPreMarket: boolean;
  elapsedMinutes: number;
  expectedVolumeShare: number;
}

export interface UsRegularSessionState {
  isRegularSession: boolean;
  elapsedMinutes: number;
  expectedVolumeShare: number;
}

const PRE_MARKET_START_MIN = 4 * 60; // 04:00 ET
const PRE_MARKET_END_MIN = 9 * 60 + 30; // 09:30 ET
const PRE_MARKET_TOTAL_MIN = PRE_MARKET_END_MIN - PRE_MARKET_START_MIN; // 330 min
const REGULAR_START_MIN = 9 * 60 + 30; // 09:30 ET
const REGULAR_END_MIN = 16 * 60; // 16:00 ET
const REGULAR_TOTAL_MIN = REGULAR_END_MIN - REGULAR_START_MIN; // 390 min

let cachedNyDayFormatter: Intl.DateTimeFormat | null = null;
function getNyDayFormatter(): Intl.DateTimeFormat {
  if (!cachedNyDayFormatter) {
    cachedNyDayFormatter = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
  }
  return cachedNyDayFormatter;
}

/**
 * Returns the `YYYYMMDD` trading date key in `America/New_York` for a Unix
 * timestamp in milliseconds, or `null` if the input is invalid.
 */
export function getNyTradingDayKey(timeMs: number): number | null {
  if (!Number.isFinite(timeMs) || timeMs <= 0) return null;
  try {
    const parts = getNyDayFormatter().formatToParts(new Date(timeMs));
    let year = 0;
    let month = 0;
    let day = 0;
    for (const part of parts) {
      if (part.type === "year") year = Number(part.value);
      else if (part.type === "month") month = Number(part.value);
      else if (part.type === "day") day = Number(part.value);
    }
    if (year > 0 && month > 0 && day > 0) {
      return year * 10_000 + month * 100 + day;
    }
  } catch {
    // ignore
  }
  return null;
}

/**
 * Checks whether two millisecond timestamps fall on the same New York trading day.
 */
export function isSameNyTradingDay(timeMsA: number, timeMsB: number): boolean {
  const keyA = getNyTradingDayKey(timeMsA);
  const keyB = getNyTradingDayKey(timeMsB);
  return keyA !== null && keyB !== null && keyA === keyB;
}

let cachedNyFormatter: Intl.DateTimeFormat | null = null;
function getNyFormatter(): Intl.DateTimeFormat {
  if (!cachedNyFormatter) {
    cachedNyFormatter = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      weekday: "short",
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
    });
  }
  return cachedNyFormatter;
}

/**
 * Computes whether US equities are currently in the live Pre-Market session
 * (`04:00–09:30 ET`, Monday–Friday) along with the expected share of daily
 * volume traded so far for pro-rated Pre-Market Relative Volume.
 */
export function getUsPreMarketSessionState(nowMs = Date.now()): UsPreMarketSessionState {
  try {
    const parts = getNyFormatter().formatToParts(new Date(nowMs));
    let hour = 0;
    let minute = 0;
    let weekday = "";
    for (const part of parts) {
      if (part.type === "hour") hour = Number(part.value) % 24;
      else if (part.type === "minute") minute = Number(part.value);
      else if (part.type === "weekday") weekday = part.value;
    }
    const isWeekend = weekday === "Sat" || weekday === "Sun";
    const minutes = hour * 60 + minute;
    const isPreMarket =
      !isWeekend &&
      Number.isFinite(minutes) &&
      minutes >= PRE_MARKET_START_MIN &&
      minutes < PRE_MARKET_END_MIN;
    const elapsedMinutes = isPreMarket ? Math.max(15, minutes - PRE_MARKET_START_MIN) : 0;
    const expectedVolumeShare = isPreMarket
      ? Math.min(0.04, Math.max(0.005, (elapsedMinutes / PRE_MARKET_TOTAL_MIN) * 0.04))
      : 1;
    return { isPreMarket, elapsedMinutes, expectedVolumeShare };
  } catch {
    return { isPreMarket: false, elapsedMinutes: 0, expectedVolumeShare: 1 };
  }
}

/**
 * Estimates live Pre-Market Relative Volume against the stock's daily average
 * volume baseline (preferring 90-day average to match Finviz 3M average volume,
 * with 30-day and 10-day fallbacks) scaled by expected pre-market participation.
 */
export function computePreMarketRelativeVolume(
  premarketVolume: number | null | undefined,
  avgVol90d: number | null | undefined,
  avgVol30d: number | null | undefined,
  avgVol10d: number | null | undefined,
  nowMs = Date.now(),
): number | null {
  if (typeof premarketVolume !== "number" || !Number.isFinite(premarketVolume) || premarketVolume <= 0) {
    return null;
  }
  const baseAvg =
    typeof avgVol90d === "number" && Number.isFinite(avgVol90d) && avgVol90d > 0
      ? avgVol90d
      : typeof avgVol30d === "number" && Number.isFinite(avgVol30d) && avgVol30d > 0
        ? avgVol30d
        : typeof avgVol10d === "number" && Number.isFinite(avgVol10d) && avgVol10d > 0
          ? avgVol10d
          : null;
  if (!baseAvg) return null;
  const { expectedVolumeShare } = getUsPreMarketSessionState(nowMs);
  return Number((premarketVolume / (baseAvg * expectedVolumeShare)).toFixed(2));
}

/**
 * Computes whether US equities are currently in the Regular Trading Hours
 * session (`09:30–16:00 ET`, Monday–Friday) along with the expected share of
 * full-day volume elapsed so far (matching Finviz's 3-month / 90-day RelVol).
 * Outside RTH (after-hours, overnight, weekends), returns `expectedVolumeShare = 1`.
 */
export function getUsRegularSessionState(nowMs = Date.now()): UsRegularSessionState {
  try {
    const parts = getNyFormatter().formatToParts(new Date(nowMs));
    let hour = 0;
    let minute = 0;
    let weekday = "";
    for (const part of parts) {
      if (part.type === "hour") hour = Number(part.value) % 24;
      else if (part.type === "minute") minute = Number(part.value);
      else if (part.type === "weekday") weekday = part.value;
    }
    const isWeekend = weekday === "Sat" || weekday === "Sun";
    const minutes = hour * 60 + minute;
    const isRegularSession =
      !isWeekend &&
      Number.isFinite(minutes) &&
      minutes >= REGULAR_START_MIN &&
      minutes < REGULAR_END_MIN;
    const elapsedMinutes = isRegularSession
      ? Math.max(1, minutes - REGULAR_START_MIN)
      : REGULAR_TOTAL_MIN;
    const expectedVolumeShare = isRegularSession
      ? Math.min(1, Math.max(0.025, elapsedMinutes / REGULAR_TOTAL_MIN))
      : 1;
    return { isRegularSession, elapsedMinutes, expectedVolumeShare };
  } catch {
    return { isRegularSession: false, elapsedMinutes: REGULAR_TOTAL_MIN, expectedVolumeShare: 1 };
  }
}

const AFTERHOURS_END_MIN = 20 * 60; // 20:00 ET

/**
 * Classifies the current New York equity market session phase (`America/New_York`, Mon–Fri).
 */
export function getUsMarketSessionPhase(nowMs = Date.now()): UsMarketSessionPhase {
  try {
    const parts = getNyFormatter().formatToParts(new Date(nowMs));
    let hour = 0;
    let minute = 0;
    let weekday = "";
    for (const part of parts) {
      if (part.type === "hour") hour = Number(part.value) % 24;
      else if (part.type === "minute") minute = Number(part.value);
      else if (part.type === "weekday") weekday = part.value;
    }
    const isWeekend = weekday === "Sat" || weekday === "Sun";
    const minutes = hour * 60 + minute;
    if (isWeekend || !Number.isFinite(minutes)) return "closed";
    if (minutes >= PRE_MARKET_START_MIN && minutes < PRE_MARKET_END_MIN) return "premarket";
    if (minutes >= REGULAR_START_MIN && minutes < REGULAR_END_MIN) return "regular";
    if (minutes >= REGULAR_END_MIN && minutes < AFTERHOURS_END_MIN) return "afterhours";
    return "closed";
  } catch {
    return "closed";
  }
}

/**
 * Computes percentage change vs prior regular close (`((price - priorClose) / priorClose) * 100`).
 */
export function computeCandidateChangePercent(
  price: number | null | undefined,
  priorClose: number | null | undefined,
): number | null {
  if (
    typeof price !== "number" ||
    !Number.isFinite(price) ||
    price <= 0 ||
    typeof priorClose !== "number" ||
    !Number.isFinite(priorClose) ||
    priorClose <= 0
  ) {
    return null;
  }
  return Number((((price - priorClose) / priorClose) * 100).toFixed(2));
}

/**
 * Estimates Finviz-style Regular Session / End-of-Day Relative Volume against
 * the stock's 90-day (3-month) average daily volume (with 30d and 10d fallbacks),
 * pro-rated by elapsed Regular Trading Hours when the market is open.
 */
export function computeRegularRelativeVolume(
  regularVolume: number | null | undefined,
  avgVol90d: number | null | undefined,
  avgVol30d: number | null | undefined,
  avgVol10d: number | null | undefined,
  nowMs = Date.now(),
): number | null {
  if (typeof regularVolume !== "number" || !Number.isFinite(regularVolume) || regularVolume <= 0) {
    return null;
  }
  const baseAvg =
    typeof avgVol90d === "number" && Number.isFinite(avgVol90d) && avgVol90d > 0
      ? avgVol90d
      : typeof avgVol30d === "number" && Number.isFinite(avgVol30d) && avgVol30d > 0
        ? avgVol30d
        : typeof avgVol10d === "number" && Number.isFinite(avgVol10d) && avgVol10d > 0
          ? avgVol10d
          : null;
  if (!baseAvg) return null;
  const { expectedVolumeShare } = getUsRegularSessionState(nowMs);
  return Number((regularVolume / (baseAvg * expectedVolumeShare)).toFixed(2));
}

export interface StockAvgVolumes {
  avg90: number | null;
  avg30: number | null;
  avg10: number | null;
}

export interface ScreenerFilterBounds {
  priceMin?: number | null;
  priceMax?: number | null;
  changeMin?: number | null;
  changeMax?: number | null;
  floatMin?: number | null;
  floatMax?: number | null;
  relVolMin?: number | null;
  volumeMin?: number | null;
  marketCapMin?: number | null;
  marketCapMax?: number | null;
  onlyPremarket?: boolean;
  sector?: string | null;
  search?: string;
}

export function passesOptionalRange(
  val: number | null | undefined,
  minVal: number | null | undefined,
  maxVal: number | null | undefined,
  opts?: { strictMin?: boolean; strictMax?: boolean },
): boolean {
  const hasMin = typeof minVal === "number" && Number.isFinite(minVal);
  const hasMax = typeof maxVal === "number" && Number.isFinite(maxVal);
  if (!hasMin && !hasMax) return true;
  if (typeof val !== "number" || !Number.isFinite(val)) return false;
  const lo = hasMin && hasMax ? Math.min(minVal!, maxVal!) : hasMin ? minVal! : null;
  const hi = hasMin && hasMax ? Math.max(minVal!, maxVal!) : hasMax ? maxVal! : null;
  if (lo !== null && (opts?.strictMin ? val <= lo : val < lo)) return false;
  if (hi !== null && (opts?.strictMax ? val >= hi : val > hi)) return false;
  return true;
}

/**
 * Filters IBKR US Consolidated scanner rows according to active screener criteria.
 */
export function filterScreenerRows<
  T extends {
    ticker: string;
    description: string;
    close: number;
    change: number | null;
    volume: number | null;
    relativeVolume: number | null;
    floatShares: number | null;
    marketCap: number | null;
    sector: string;
    premarketVolume?: number | null;
  },
>(items: T[], bounds: ScreenerFilterBounds, options?: { skipFloatFilter?: boolean }): T[] {
  const sectorFilter = typeof bounds.sector === "string" ? bounds.sector.trim().toLowerCase() : "";
  const searchFilter = typeof bounds.search === "string" ? bounds.search.trim().toLowerCase() : "";
  const strictPositiveChangeMin =
    typeof bounds.changeMin === "number" &&
    Number.isFinite(bounds.changeMin) &&
    bounds.changeMin > 0 &&
    bounds.changeMax == null;

  const out: T[] = [];
  for (const item of items) {
    if (!passesOptionalRange(item.close, bounds.priceMin, bounds.priceMax)) continue;
    if (
      !passesOptionalRange(item.change, bounds.changeMin, bounds.changeMax, {
        strictMin: strictPositiveChangeMin,
      })
    ) {
      continue;
    }
    if (
      !options?.skipFloatFilter &&
      !passesOptionalRange(item.floatShares, bounds.floatMin, bounds.floatMax)
    ) {
      continue;
    }
    if (!passesOptionalRange(item.marketCap, bounds.marketCapMin, bounds.marketCapMax)) continue;
    if (
      typeof bounds.relVolMin === "number" &&
      Number.isFinite(bounds.relVolMin) &&
      (item.relativeVolume === null || item.relativeVolume < bounds.relVolMin)
    ) {
      continue;
    }
    if (
      typeof bounds.volumeMin === "number" &&
      Number.isFinite(bounds.volumeMin) &&
      (item.volume === null || item.volume < bounds.volumeMin)
    ) {
      continue;
    }
    if (bounds.onlyPremarket && !(typeof item.premarketVolume === "number" && item.premarketVolume > 0)) {
      continue;
    }
    if (sectorFilter && item.sector.trim().toLowerCase() !== sectorFilter) continue;
    if (
      searchFilter &&
      !item.ticker.toLowerCase().includes(searchFilter) &&
      !item.description.toLowerCase().includes(searchFilter)
    ) {
      continue;
    }
    out.push(item);
  }
  return out;
}
