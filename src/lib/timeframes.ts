/**
 * Universal Timeframe Parser, Dynamic 1s->N Aggregation, and IBKR Historical Plan Resolver.
 * Shared cleanly between the Vite/Node IBKR backend engine and the React browser client.
 */

export interface OhlcvBar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export type IbkrBarSizeSetting =
  | "1 secs"
  | "5 secs"
  | "10 secs"
  | "15 secs"
  | "30 secs"
  | "1 min"
  | "2 mins"
  | "3 mins"
  | "5 mins"
  | "10 mins"
  | "15 mins"
  | "20 mins"
  | "30 mins"
  | "1 hour"
  | "2 hours"
  | "3 hours"
  | "4 hours"
  | "8 hours"
  | "1 day"
  | "1 week";

export interface IbkrHistoricalPlan {
  timeframe: string;
  targetSec: number;
  barSize: IbkrBarSizeSetting;
  nativeSec: number;
  requiresResample: boolean;
  durationStr: string;
  /** Number of chained endDateTime chunks needed when targetSec is very small (e.g. 1s) and minBars > 1800. */
  chunks: number;
  chunkDurationSec: number;
}

const TF_UNIT_SECONDS: Record<string, number> = {
  s: 1,
  sec: 1,
  secs: 1,
  m: 60,
  min: 60,
  mins: 60,
  h: 3600,
  hr: 3600,
  hrs: 3600,
  hour: 3600,
  hours: 3600,
  d: 86400,
  day: 86400,
  days: 86400,
  w: 604800,
  wk: 604800,
  week: 604800,
  weeks: 604800,
};

const TF_REGEX = /^(\d+)\s*(s|sec|secs|m|min|mins|h|hr|hrs|hour|hours|d|day|days|w|wk|week|weeks)$/i;

export function isValidTimeframe(tf: string): boolean {
  if (typeof tf !== "string") return false;
  const trimmed = tf.trim();
  const match = TF_REGEX.exec(trimmed);
  if (!match) return false;
  const count = Number(match[1]);
  return Number.isInteger(count) && count > 0 && count <= 10_000;
}

export function normalizeTimeframeLabel(tf: string): string {
  const match = TF_REGEX.exec(tf.trim());
  if (!match) return tf.trim().toLowerCase();
  const count = Number(match[1]);
  const rawUnit = match[2]!.toLowerCase();
  const unit = rawUnit.startsWith("s")
    ? "s"
    : rawUnit.startsWith("m")
      ? "m"
      : rawUnit.startsWith("h")
        ? "h"
        : rawUnit.startsWith("d")
          ? "d"
          : "w";
  return `${count}${unit}`;
}

export function parseTimeframeSeconds(tf: string): number {
  if (typeof tf !== "string") return 60;
  const match = TF_REGEX.exec(tf.trim());
  if (!match) return 60;
  const count = Number(match[1]);
  const unitMult = TF_UNIT_SECONDS[match[2]!.toLowerCase()];
  if (!Number.isFinite(count) || count <= 0 || !unitMult) return 60;
  return Math.max(1, Math.floor(count * unitMult));
}

export function getTimeframeMs(tf: string): number {
  return parseTimeframeSeconds(tf) * 1000;
}

export function isIntradayTimeframe(tf: string): boolean {
  return parseTimeframeSeconds(tf) < 86_400;
}

export function isSubMinuteTimeframe(tf: string): boolean {
  return parseTimeframeSeconds(tf) < 60;
}

/**
 * Aligns a timestamp (in seconds or milliseconds) to the start of its candle bucket (in unix seconds).
 * Weekly buckets ("1w" / 604800s) align to Monday 00:00 UTC.
 */
export function getBucketStartSec(timestampSecOrMs: number, tfOrSec: string | number): number {
  if (!Number.isFinite(timestampSecOrMs) || timestampSecOrMs <= 0) return 0;
  const sec =
    timestampSecOrMs > 1e11 ? Math.floor(timestampSecOrMs / 1000) : Math.floor(timestampSecOrMs);
  const stepSec =
    typeof tfOrSec === "number"
      ? Math.max(1, Math.floor(tfOrSec))
      : parseTimeframeSeconds(tfOrSec);
  if (stepSec === 604_800) {
    // Unix epoch 0 (1970-01-01) was Thursday. Align weekly buckets to Monday 00:00 UTC.
    const MONDAY_OFFSET = 259_200;
    const WEEK_SEC = 604_800;
    return Math.floor((sec + MONDAY_OFFSET) / WEEK_SEC) * WEEK_SEC - MONDAY_OFFSET;
  }
  return Math.floor(sec / stepSec) * stepSec;
}

export interface AggregateCandlesOptions {
  /** Base resolution in seconds (e.g. 60 for 1m) used to detect missing intermediate sub-candles per bucket. */
  sourceStepSec?: number;
  /** When true (and `sourceStepSec` is set), excludes buckets missing intermediate sub-candles unless verified sparse. */
  requireCompleteBuckets?: boolean;
  /** When true, allows missing zero-trade minutes inside buckets covered by `[verifiedCoverageStartSec, verifiedCoverageEndSec]`. */
  allowSparseZeroTradeGaps?: boolean;
  verifiedCoverageStartSec?: number;
  verifiedCoverageEndSec?: number;
}

export interface AggregatedCandleIntegrityResult {
  candles: OhlcvBar[];
  incompleteBucketTimes: number[];
  completeBucketTimes: number[];
  duplicateInputCount: number;
  outOfOrderInputCount: number;
  misalignedInputCount: number;
}

/**
 * Deterministically aggregates finer OHLCV bars while tracking duplicates, out-of-order inputs,
 * misaligned timestamps, and incomplete target buckets (e.g., intermediate missing sub-candles).
 */
export function aggregateCandlesWithIntegrity<T extends OhlcvBar>(
  bars: ReadonlyArray<T>,
  targetTfOrSec: string | number,
  options?: AggregateCandlesOptions,
): AggregatedCandleIntegrityResult {
  if (!Array.isArray(bars) || bars.length === 0) {
    return {
      candles: [],
      incompleteBucketTimes: [],
      completeBucketTimes: [],
      duplicateInputCount: 0,
      outOfOrderInputCount: 0,
      misalignedInputCount: 0,
    };
  }
  const stepSec =
    typeof targetTfOrSec === "number"
      ? Math.max(1, Math.floor(targetTfOrSec))
      : parseTimeframeSeconds(targetTfOrSec);

  const sourceSec = options?.sourceStepSec;
  const checkCompleteness =
    typeof sourceSec === "number" &&
    Number.isFinite(sourceSec) &&
    sourceSec > 0 &&
    stepSec > sourceSec &&
    stepSec % sourceSec === 0;

  let duplicateInputCount = 0;
  let outOfOrderInputCount = 0;
  let misalignedInputCount = 0;
  let prevRawTime = -Infinity;
  const dedupedByTime = new Map<number, T>();
  for (const bar of bars) {
    if (
      !bar ||
      !Number.isFinite(bar.time) ||
      !Number.isFinite(bar.open) ||
      !Number.isFinite(bar.high) ||
      !Number.isFinite(bar.low) ||
      !Number.isFinite(bar.close) ||
      bar.close <= 0
    ) {
      continue;
    }
    const t = Math.floor(bar.time);
    if (t < prevRawTime) outOfOrderInputCount += 1;
    else prevRawTime = t;
    if (dedupedByTime.has(t)) duplicateInputCount += 1;
    dedupedByTime.set(t, bar);
  }

  const sorted = Array.from(dedupedByTime.values()).sort((a, b) => a.time - b.time);
  const buckets = new Map<number, OhlcvBar>();
  const bucketAlignedSlots = new Map<number, Set<number>>();
  const bucketHasMisaligned = new Set<number>();

  for (const bar of sorted) {
    const barTime = Math.floor(bar.time);
    const bTime = getBucketStartSec(barTime, stepSec);
    const barHigh = Math.max(bar.high, bar.open, bar.close);
    const barLow = Math.min(bar.low, bar.open, bar.close);
    const barVol = Number.isFinite(bar.volume) && bar.volume >= 0 ? bar.volume : 0;
    const existing = buckets.get(bTime);
    if (!existing) {
      buckets.set(bTime, {
        time: bTime,
        open: bar.open,
        high: barHigh,
        low: barLow,
        close: bar.close,
        volume: barVol,
      });
    } else {
      existing.high = Math.max(existing.high, barHigh);
      existing.low = Math.min(existing.low, barLow);
      existing.close = bar.close;
      existing.volume += barVol;
    }

    if (checkCompleteness) {
      if ((barTime - bTime) % sourceSec! === 0) {
        let slots = bucketAlignedSlots.get(bTime);
        if (!slots) {
          slots = new Set<number>();
          bucketAlignedSlots.set(bTime, slots);
        }
        slots.add(barTime);
      } else {
        misalignedInputCount += 1;
        bucketHasMisaligned.add(bTime);
      }
    }
  }

  const allSorted = Array.from(buckets.values()).sort((a, b) => a.time - b.time);

  if (!checkCompleteness) {
    return {
      candles: allSorted,
      incompleteBucketTimes: [],
      completeBucketTimes: allSorted.map((c) => c.time),
      duplicateInputCount,
      outOfOrderInputCount,
      misalignedInputCount: 0,
    };
  }

  const expectedSlots = Math.round(stepSec / sourceSec!);
  const completeBucketTimes: number[] = [];
  const incompleteBucketTimes: number[] = [];
  const completeSet = new Set<number>();
  const allowSparse = Boolean(options?.allowSparseZeroTradeGaps);
  const covStart = options?.verifiedCoverageStartSec;
  const covEnd = options?.verifiedCoverageEndSec;

  for (const candle of allSorted) {
    const hasMisaligned = bucketHasMisaligned.has(candle.time);
    const alignedSlots = bucketAlignedSlots.get(candle.time);
    let allSlotsExact = !hasMisaligned && alignedSlots !== undefined && alignedSlots.size === expectedSlots;
    if (allSlotsExact && alignedSlots) {
      for (let k = 0; k < expectedSlots; k++) {
        if (!alignedSlots.has(candle.time + k * sourceSec!)) {
          allSlotsExact = false;
          break;
        }
      }
    }
    const hasVerifiedSparseCov =
      !hasMisaligned &&
      allowSparse &&
      typeof covStart === "number" &&
      typeof covEnd === "number" &&
      covStart <= candle.time &&
      covEnd >= candle.time + stepSec;
    if (allSlotsExact || hasVerifiedSparseCov) {
      completeBucketTimes.push(candle.time);
      completeSet.add(candle.time);
    } else {
      incompleteBucketTimes.push(candle.time);
    }
  }

  return {
    candles: options?.requireCompleteBuckets
      ? allSorted.filter((c) => completeSet.has(c.time))
      : allSorted,
    incompleteBucketTimes,
    completeBucketTimes,
    duplicateInputCount,
    outOfOrderInputCount,
    misalignedInputCount,
  };
}

/**
 * Validates OHLCV coherence between a higher-timeframe parent candle and its finer sub-candles.
 * Rejects contradictory prices (sub-high > parent-high, sub-low < parent-low, mismatched opening bar),
 * non-zero sub-volume under a zero-volume parent candle, or sub-volume exceeding the parent candle's volume.
 */
export function isSubIntervalOhlcvCoherent<T extends OhlcvBar>(
  parentCandle: OhlcvBar,
  parentSubs: ReadonlyArray<T>,
  windowSubs: ReadonlyArray<T>,
): boolean {
  if (
    !parentCandle ||
    !Number.isFinite(parentCandle.open) ||
    !Number.isFinite(parentCandle.high) ||
    !Number.isFinite(parentCandle.low) ||
    !Number.isFinite(parentCandle.close) ||
    parentCandle.close <= 0
  ) {
    return false;
  }
  const parentVol =
    Number.isFinite(parentCandle.volume) && parentCandle.volume >= 0
      ? parentCandle.volume
      : -1;
  if (parentVol < 0) return false;

  const parentHigh = Math.max(parentCandle.high, parentCandle.open, parentCandle.close);
  const parentLow = Math.min(parentCandle.low, parentCandle.open, parentCandle.close);
  const priceTol = Math.max(1e-5, Math.abs(parentCandle.close) * 1e-6);
  // Allow tiny 2-decimal rounding accumulation across summed sub-candles (e.g. 966.68 vs 966.69)
  // while keeping zero-volume parent candles strictly at 0 (`1e-6`).
  const volTol = Math.max(0.05, parentVol * 1e-4);

  const checkSubList = (subs: ReadonlyArray<T>): { ok: boolean; totalVol: number } => {
    let totalVol = 0;
    for (const c of subs) {
      if (
        !c ||
        !Number.isFinite(c.open) ||
        !Number.isFinite(c.high) ||
        !Number.isFinite(c.low) ||
        !Number.isFinite(c.close) ||
        c.close <= 0 ||
        !Number.isFinite(c.volume) ||
        c.volume < 0
      ) {
        return { ok: false, totalVol: 0 };
      }
      const cHigh = Math.max(c.high, c.open, c.close);
      const cLow = Math.min(c.low, c.open, c.close);
      if (cHigh > parentHigh + priceTol || cLow < parentLow - priceTol) {
        return { ok: false, totalVol: 0 };
      }
      totalVol += c.volume;
    }
    return { ok: true, totalVol };
  };

  const parentCheck = checkSubList(parentSubs);
  if (!parentCheck.ok) return false;
  const windowCheck = checkSubList(windowSubs);
  if (!windowCheck.ok) return false;

  if (parentVol === 0) {
    if (parentCheck.totalVol > 1e-6 || windowCheck.totalVol > 1e-6) {
      return false;
    }
  } else {
    if (parentCheck.totalVol > parentVol + volTol || windowCheck.totalVol > parentVol + volTol) {
      return false;
    }
  }

  if (
    parentSubs.length > 0 &&
    Math.floor(parentSubs[0]!.time) === Math.floor(parentCandle.time) &&
    Math.abs(parentSubs[0]!.open - parentCandle.open) > priceTol
  ) {
    return false;
  }

  if (
    windowSubs.length > 0 &&
    Math.floor(windowSubs[0]!.time) === Math.floor(parentCandle.time) &&
    Math.abs(windowSubs[0]!.open - parentCandle.open) > priceTol
  ) {
    return false;
  }

  return true;
}

/**
 * Deterministically aggregates finer OHLCV bars (e.g. 1s or 1m) into any target timeframe or step in seconds.
 */
export function aggregateCandles<T extends OhlcvBar>(
  bars: ReadonlyArray<T>,
  targetTfOrSec: string | number,
  options?: AggregateCandlesOptions,
): OhlcvBar[] {
  return aggregateCandlesWithIntegrity(bars, targetTfOrSec, options).candles;
}

/**
 * Merges a real-time 1-second consolidated bar into an active target-timeframe series
 * using exact volume deltas so intra-second updates never double-count volume.
 */
export function mergeLive1sBarIntoSeries(
  seriesBars: ReadonlyArray<OhlcvBar>,
  bar1s: OhlcvBar,
  prevBar1sVolForSameSec: number,
  targetTf: string,
): { bars: OhlcvBar[]; updatedCandle: OhlcvBar; isNewBucket: boolean } {
  const stepSec = parseTimeframeSeconds(targetTf);
  const bucketTime = getBucketStartSec(bar1s.time, stepSec);
  const safeBarVol = Number.isFinite(bar1s.volume) && bar1s.volume >= 0 ? bar1s.volume : 0;
  const safePrevVol =
    Number.isFinite(prevBar1sVolForSameSec) && prevBar1sVolForSameSec >= 0
      ? prevBar1sVolForSameSec
      : 0;
  const volDelta = Math.max(0, safeBarVol - safePrevVol);
  const barHigh = Math.max(bar1s.high, bar1s.open, bar1s.close);
  const barLow = Math.min(bar1s.low, bar1s.open, bar1s.close);

  if (seriesBars.length === 0) {
    const created: OhlcvBar = {
      time: bucketTime,
      open: bar1s.open,
      high: barHigh,
      low: barLow,
      close: bar1s.close,
      volume: safeBarVol,
    };
    return { bars: [created], updatedCandle: { ...created }, isNewBucket: true };
  }

  const nextBars = [...seriesBars];
  const lastIdx = nextBars.length - 1;
  const last = nextBars[lastIdx]!;

  if (bucketTime < last.time) {
    // Out-of-order late second; find matching bucket if already present without disturbing head
    const matchIdx = nextBars.findIndex((b) => b.time === bucketTime);
    if (matchIdx >= 0) {
      const target = nextBars[matchIdx]!;
      const updated: OhlcvBar = {
        time: target.time,
        open: target.open,
        high: Math.max(target.high, barHigh),
        low: Math.min(target.low, barLow),
        close: stepSec === 1 ? bar1s.close : target.close,
        volume: stepSec === 1 ? Math.max(target.volume, safeBarVol) : target.volume + volDelta,
      };
      nextBars[matchIdx] = updated;
      return { bars: nextBars, updatedCandle: { ...updated }, isNewBucket: false };
    }
    return { bars: nextBars, updatedCandle: { ...last }, isNewBucket: false };
  }

  if (bucketTime === last.time) {
    const updated: OhlcvBar = {
      time: last.time,
      open: last.open,
      high: Math.max(last.high, barHigh),
      low: Math.min(last.low, barLow),
      close: bar1s.close,
      volume:
        stepSec === 1
          ? Math.max(last.volume, safeBarVol)
          : last.volume + volDelta,
    };
    nextBars[lastIdx] = updated;
    return { bars: nextBars, updatedCandle: { ...updated }, isNewBucket: false };
  }

  const created: OhlcvBar = {
    time: bucketTime,
    open: bar1s.open,
    high: barHigh,
    low: barLow,
    close: bar1s.close,
    volume: safeBarVol,
  };
  nextBars.push(created);
  return { bars: nextBars, updatedCandle: { ...created }, isNewBucket: true };
}

/**
 * Computes sufficient warmup bars so all active EMAs converge to < 1e-5 error
 * from the very first visible candle.
 */
export function computeRequiredWarmupBars(emaPeriods: ReadonlyArray<number>): number {
  const validPeriods = emaPeriods.filter((p) => Number.isFinite(p) && p > 0);
  const maxPeriod = validPeriods.length > 0 ? Math.max(200, ...validPeriods) : 200;
  return Math.max(1500, Math.round(maxPeriod) * 6 + 300);
}

const IBKR_NATIVE_BARS: ReadonlyArray<{ sec: number; barSize: IbkrBarSizeSetting }> = [
  { sec: 1, barSize: "1 secs" },
  { sec: 5, barSize: "5 secs" },
  { sec: 10, barSize: "10 secs" },
  { sec: 15, barSize: "15 secs" },
  { sec: 30, barSize: "30 secs" },
  { sec: 60, barSize: "1 min" },
  { sec: 120, barSize: "2 mins" },
  { sec: 180, barSize: "3 mins" },
  { sec: 300, barSize: "5 mins" },
  { sec: 600, barSize: "10 mins" },
  { sec: 900, barSize: "15 mins" },
  { sec: 1200, barSize: "20 mins" },
  { sec: 1800, barSize: "30 mins" },
  { sec: 3600, barSize: "1 hour" },
  { sec: 7200, barSize: "2 hours" },
  { sec: 10800, barSize: "3 hours" },
  { sec: 14400, barSize: "4 hours" },
  { sec: 28800, barSize: "8 hours" },
  { sec: 86400, barSize: "1 day" },
  { sec: 604800, barSize: "1 week" },
];

/**
 * Maps any timeframe (standard or user-defined, e.g. 1s, 10s, 3m, 4m, 7m, 45m, 6h, 1d, 1w)
 * to the highest-resolution native IBKR BarSizeSetting that divides `targetSec` cleanly,
 * along with a duration string sized to return at least `minBars` historical bars.
 */
export function resolveIbkrHistoricalQuery(tf: string, minBars = 1500): IbkrHistoricalPlan {
  const targetSec = parseTimeframeSeconds(tf);
  const safeMinBars = Math.max(100, Math.min(8000, Math.floor(minBars)));

  // Pick the largest native IBKR bar size that divides targetSec (or fallback to 1 secs / 1 min / 1 day)
  let chosen = IBKR_NATIVE_BARS[0]!;
  for (const candidate of IBKR_NATIVE_BARS) {
    if (candidate.sec <= targetSec && targetSec % candidate.sec === 0) {
      chosen = candidate;
    }
  }
  if (targetSec % chosen.sec !== 0) {
    chosen = targetSec < 60 ? IBKR_NATIVE_BARS[0]! : targetSec < 86400 ? IBKR_NATIVE_BARS[5]! : IBKR_NATIVE_BARS[18]!;
  }

  const requiresResample = chosen.sec !== targetSec;
  const nativeBarsNeeded = Math.ceil(safeMinBars * (targetSec / chosen.sec));

  // Sub-minute IBKR bars (<= 30s) follow strict IBKR max duration limits per request:
  // 1 secs: <= 1800 S (30 min) per single request comfortably without pacing rejection
  if (chosen.sec === 1) {
    const chunkDurationSec = 1800;
    const chunks = Math.min(3, Math.max(1, Math.ceil(nativeBarsNeeded / 1800)));
    return {
      timeframe: tf,
      targetSec,
      barSize: chosen.barSize,
      nativeSec: chosen.sec,
      requiresResample,
      durationStr: `${chunkDurationSec} S`,
      chunks,
      chunkDurationSec,
    };
  }

  if (chosen.sec <= 30) {
    // 5s..30s: IBKR supports up to 86400 S (1 D) for >= 5s; use trading days or seconds
    const totalSecNeeded = nativeBarsNeeded * chosen.sec;
    if (totalSecNeeded <= 28_800) {
      const clampedSec = Math.max(3600, Math.min(28_800, Math.ceil(totalSecNeeded * 1.35)));
      return {
        timeframe: tf,
        targetSec,
        barSize: chosen.barSize,
        nativeSec: chosen.sec,
        requiresResample,
        durationStr: `${clampedSec} S`,
        chunks: 1,
        chunkDurationSec: clampedSec,
      };
    }
    // Extended hours cover ~16h/day (04:00-20:00 ET) = 57,600s/day; conservatively use ~23,400s RTH/day
    const tradingDays = Math.min(5, Math.max(1, Math.ceil(totalSecNeeded / 23_400) + 1));
    return {
      timeframe: tf,
      targetSec,
      barSize: chosen.barSize,
      nativeSec: chosen.sec,
      requiresResample,
      durationStr: `${tradingDays} D`,
      chunks: 1,
      chunkDurationSec: tradingDays * 86_400,
    };
  }

  if (chosen.sec < 86_400) {
    // Minute & hourly bars: respect IBKR's official max duration per bar size so
    // 1m, 3m, and 5m requests NEVER hit Error 162/321 duration-limit rejections:
    //   1 min  -> <= 7 D (1 W)  (~3,000-4,500 extended-hours bars)
    //   2m/3m  -> <= 21 D       (~2,500-4,000 extended-hours bars)
    //   5 mins -> <= 1 M        (~3,500+ extended-hours bars)
    //   10m..30m -> <= 3 M
    const nativeBarsPerDay = Math.max(1, Math.floor((390 * 60) / chosen.sec));
    const tradingDays = Math.max(2, Math.ceil(nativeBarsNeeded / nativeBarsPerDay) + 1);
    let calendarDays = Math.ceil(tradingDays * 1.48);

    if (chosen.sec === 60) {
      calendarDays = Math.min(calendarDays, 7);
    } else if (chosen.sec <= 180) {
      calendarDays = Math.min(calendarDays, 21);
    } else if (chosen.sec === 300) {
      calendarDays = Math.min(calendarDays, 28);
    } else if (chosen.sec <= 1800) {
      calendarDays = Math.min(calendarDays, 90);
    }

    let durationStr: string;
    if (chosen.sec === 300 && calendarDays >= 28) {
      durationStr = "1 M";
    } else if (calendarDays <= 30) {
      durationStr = `${calendarDays} D`;
    } else if (calendarDays <= 360) {
      const months = Math.min(11, Math.max(1, Math.ceil(calendarDays / 28)));
      durationStr = `${months} M`;
    } else {
      const years = Math.min(10, Math.max(1, Math.ceil(calendarDays / 365)));
      durationStr = `${years} Y`;
    }

    return {
      timeframe: tf,
      targetSec,
      barSize: chosen.barSize,
      nativeSec: chosen.sec,
      requiresResample,
      durationStr,
      chunks: 1,
      chunkDurationSec: calendarDays * 86_400,
    };
  }

  if (chosen.sec === 86_400) {
    // Daily: ~252 trading days / year
    const years = Math.min(20, Math.max(6, Math.ceil(nativeBarsNeeded / 252) + 1));
    return {
      timeframe: tf,
      targetSec,
      barSize: chosen.barSize,
      nativeSec: chosen.sec,
      requiresResample,
      durationStr: `${years} Y`,
      chunks: 1,
      chunkDurationSec: years * 365 * 86_400,
    };
  }

  // Weekly: ~52 bars / year
  const years = Math.min(30, Math.max(20, Math.ceil(nativeBarsNeeded / 52) + 1));
  return {
    timeframe: tf,
    targetSec,
    barSize: chosen.barSize,
    nativeSec: chosen.sec,
    requiresResample,
    durationStr: `${years} Y`,
    chunks: 1,
    chunkDurationSec: years * 365 * 86_400,
  };
}
