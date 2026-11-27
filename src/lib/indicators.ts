/**
 * Technical Indicator Calculations & Causal Divergence Detection
 * Pure functions for computing chart indicators from OHLCV candle data.
 * All calculations are strictly causal (only using bars <= index), so historical
 * replay never leaks future information.
 */

export interface CandleData {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

export interface IndicatorPoint {
  time: number;
  value: number;
}

export type DivergenceKind = "bull" | "bear" | "hidden-bull" | "hidden-bear";
export type DivergenceOscillatorSource = "rsi" | "macd" | "histogram";

export interface DivergenceContext {
  ema50Value: number | null;
  ema50DistancePct: number | null;
  ema50SlopePct: number | null;
  ema50Position: "above" | "below" | null;
  ema50TrendAligned: boolean | null;
  pivot1AverageVolume: number;
  pivot2AverageVolume: number;
  pivot2VolumeSma20Ratio: number | null;
  confirmationVolumeSma20Ratio: number | null;
}

export interface DivergenceSignal {
  kind: DivergenceKind;
  oscillatorSource?: DivergenceOscillatorSource;
  context?: DivergenceContext;
  /** Signal label: "Alcista" | "Bajista" | "Alcista Oculta" | "Bajista Oculta" */
  label: string;
  startTime: number;
  endTime: number;
  /** Bar timestamp when the signal was causally confirmed (without lookahead) */
  confirmedTime: number;
  startOsc: number;
  endOsc: number;
  startPrice: number;
  endPrice: number;
  startPriceTime?: number;
  endPriceTime?: number;
  startOscTime?: number;
  endOscTime?: number;
}

export interface MacdThresholds {
  isHistRising: boolean;
  isBullishCrossState: boolean;
  isAboveZero: boolean;
  macdValue?: number;
  signalValue?: number;
  histValue?: number;
  /** Price required on current/next close to keep histogram rising (or falling) */
  histContinuePrice: number | null;
  /** Price required for MACD line to cross Signal line */
  signalCrossPrice: number | null;
  /** Price required for MACD line to cross 0 */
  zeroCrossPrice: number | null;
}

/**
 * Ensure candles are sorted by time ascending and deduplicated (latest entry wins),
 * filtering out any rows with non-finite time or close.
 */
export function normalizeCandles(candles: CandleData[]): CandleData[] {
  if (!Array.isArray(candles) || candles.length === 0) return [];

  const sanitize = (c: CandleData): CandleData | null => {
    if (!Number.isFinite(c.time) || !Number.isFinite(c.close)) return null;
    const close = c.close;
    const open = Number.isFinite(c.open) ? c.open : close;
    let high = Number.isFinite(c.high) ? c.high : Math.max(open, close);
    let low = Number.isFinite(c.low) ? c.low : Math.min(open, close);
    if (high < Math.max(open, close)) high = Math.max(open, close);
    if (low > Math.min(open, close)) low = Math.min(open, close);
    const volume = Number.isFinite(c.volume) && (c.volume ?? 0) >= 0 ? c.volume : 0;
    return { time: c.time, open, high, low, close, volume };
  };

  if (candles.length === 1) {
    const s = sanitize(candles[0]!);
    return s ? [s] : [];
  }

  let strictlyAscending = true;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i]!;
    if (
      !Number.isFinite(c.time) ||
      !Number.isFinite(c.close) ||
      !Number.isFinite(c.open) ||
      !Number.isFinite(c.high) ||
      !Number.isFinite(c.low) ||
      (c.volume !== undefined && (!Number.isFinite(c.volume) || c.volume < 0)) ||
      c.high < Math.max(c.open, c.close) ||
      c.low > Math.min(c.open, c.close)
    ) {
      strictlyAscending = false;
      break;
    }
    if (i > 0 && c.time <= candles[i - 1]!.time) {
      strictlyAscending = false;
      break;
    }
  }
  if (strictlyAscending) return candles;

  const valid: CandleData[] = [];
  for (const c of candles) {
    const s = sanitize(c);
    if (s) valid.push(s);
  }
  valid.sort((a, b) => a.time - b.time);
  const deduped: CandleData[] = [];
  for (let i = 0; i < valid.length; i++) {
    const cur = valid[i]!;
    const next = valid[i + 1];
    if (!next || cur.time !== next.time) {
      deduped.push(cur);
    }
  }
  return deduped;
}

// ── Simple Moving Average ────────────────────────────────────
export function sma(rawCandles: CandleData[], period: number): IndicatorPoint[] {
  const p = Math.floor(period);
  if (!Number.isFinite(period) || p <= 0) return [];
  const candles = normalizeCandles(rawCandles);
  const result: IndicatorPoint[] = [];
  if (candles.length < p) return result;

  let sum = 0;
  for (let i = 0; i < p; i++) sum += candles[i]!.close;

  result.push({ time: candles[p - 1]!.time, value: sum / p });

  for (let i = p; i < candles.length; i++) {
    sum += candles[i]!.close - candles[i - p]!.close;
    result.push({ time: candles[i]!.time, value: sum / p });
  }
  return result;
}

// ── Exponential Moving Average (High-Precision IEEE-754) ─────
export function emaStep(prevEma: number, close: number, period: number): number {
  const p = Math.floor(period);
  if (!Number.isFinite(prevEma) || !Number.isFinite(close) || p <= 0) return prevEma;
  const k = 2 / (p + 1);
  // Incremental difference form avoids catastrophic cancellation and guarantees zero drift on constant series
  return prevEma + k * (close - prevEma);
}

export function ema(rawCandles: CandleData[], period: number): IndicatorPoint[] {
  const p = Math.floor(period);
  if (!Number.isFinite(period) || p <= 0) return [];
  const candles = normalizeCandles(rawCandles);
  const result: IndicatorPoint[] = [];
  if (candles.length < p) return result;

  // Neumaier compensated summation for high-precision initial SMA seed
  let sum = 0;
  let comp = 0;
  for (let i = 0; i < p; i++) {
    const x = candles[i]!.close;
    const t = sum + x;
    if (Math.abs(sum) >= Math.abs(x)) {
      comp += (sum - t) + x;
    } else {
      comp += (x - t) + sum;
    }
    sum = t;
  }
  let prev = (sum + comp) / p;
  result.push({ time: candles[p - 1]!.time, value: prev });

  const k = 2 / (p + 1);
  for (let i = p; i < candles.length; i++) {
    prev = prev + k * (candles[i]!.close - prev);
    result.push({ time: candles[i]!.time, value: prev });
  }
  return result;
}

// ── Relative Strength Index (Wilder's RMA, period 14) ────────
export function rsi(rawCandles: CandleData[], period = 14): IndicatorPoint[] {
  const p = Math.floor(period);
  if (!Number.isFinite(period) || p <= 0) return [];
  const candles = normalizeCandles(rawCandles);
  const result: IndicatorPoint[] = [];
  if (candles.length < p + 1) return result;

  let avgGain = 0;
  let avgLoss = 0;

  for (let i = 1; i <= p; i++) {
    const change = candles[i]!.close - candles[i - 1]!.close;
    if (change > 0) avgGain += change;
    else if (change < 0) avgLoss += -change;
  }
  avgGain /= p;
  avgLoss /= p;

  const computeRsi = (g: number, l: number): number => {
    if (g === 0 && l === 0) return 50;
    if (l === 0) return 100;
    if (g === 0) return 0;
    return 100 - 100 / (1 + g / l);
  };

  result.push({ time: candles[p]!.time, value: computeRsi(avgGain, avgLoss) });

  for (let i = p + 1; i < candles.length; i++) {
    const change = candles[i]!.close - candles[i - 1]!.close;
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;
    avgGain = (avgGain * (p - 1) + gain) / p;
    avgLoss = (avgLoss * (p - 1) + loss) / p;
    result.push({ time: candles[i]!.time, value: computeRsi(avgGain, avgLoss) });
  }
  return result;
}

// ── MACD (12, 26, 9) ─────────────────────────────────────────
export interface MACDResult {
  macd: IndicatorPoint[];
  signal: IndicatorPoint[];
  histogram: IndicatorPoint[];
  thresholds: MacdThresholds | null;
}

export const RSI_BALANCED_DEFAULTS = { intraday: 14, daily: 14 } as const;
export const MACD_BALANCED_DEFAULTS = { fast: 12, slow: 26, signal: 9 } as const;
export const MACD_4H_ALTERNATIVE = { fast: 19, slow: 39, signal: 9 } as const;

export function computeMacdThresholds(
  rawCandles: CandleData[],
  fastPeriod = 12,
  slowPeriod = 26,
  signalPeriod = 9,
): MacdThresholds | null {
  const fastP = Math.floor(fastPeriod);
  const slowP = Math.floor(slowPeriod);
  const sigP = Math.floor(signalPeriod);
  if (
    !Number.isFinite(fastPeriod) ||
    !Number.isFinite(slowPeriod) ||
    !Number.isFinite(signalPeriod) ||
    fastP <= 0 ||
    slowP <= 0 ||
    sigP <= 0
  ) {
    return null;
  }
  const candles = normalizeCandles(rawCandles);
  if (candles.length < Math.max(fastP, slowP) + sigP) return null;
  const fastEma = ema(candles, fastP);
  const slowEma = ema(candles, slowP);
  if (fastEma.length < 2 || slowEma.length < 2) return null;

  const slowMap = new Map(slowEma.map((p) => [p.time, p.value]));
  const macdVals: number[] = [];
  for (const fp of fastEma) {
    const sv = slowMap.get(fp.time);
    if (sv !== undefined) macdVals.push(fp.value - sv);
  }
  if (macdVals.length < sigP + 1) return null;

  const kSig = 2 / (sigP + 1);
  let sum = 0;
  for (let i = 0; i < sigP; i++) sum += macdVals[i]!;
  let sig = sum / sigP;
  let prevSig = sig;
  for (let i = sigP; i < macdVals.length; i++) {
    prevSig = sig;
    sig = macdVals[i]! * kSig + sig * (1 - kSig);
  }

  // Use the previous bar's EMAs (t - 1) to solve for the exact close price P on bar t
  const eFastPrev = fastEma[fastEma.length - 2]!.value;
  const eSlowPrev = slowEma[slowEma.length - 2]!.value;
  const macdCurr = macdVals[macdVals.length - 1]!;
  const macdPrev = macdVals[macdVals.length - 2]!;
  const histCurr = macdCurr - sig;
  const histPrev = macdPrev - prevSig;

  const kFast = 2 / (fastP + 1);
  const kSlow = 2 / (slowP + 1);
  const denom = kFast - kSlow;
  if (Math.abs(denom) < 1e-12) return null;

  const baseDiff = (1 - kSlow) * eSlowPrev - (1 - kFast) * eFastPrev;
  // MACD(t, P) = denom * P - baseDiff
  const zeroCrossPrice = baseDiff / denom;
  // MACD(t, P) = Signal(t, P) <=> MACD(t, P) = prevSig
  const signalCrossPrice = (prevSig + baseDiff) / denom;
  // Hist(t, P) = (1 - kSig) * (MACD(t, P) - prevSig) = histPrev
  const histContinuePrice =
    Math.abs(1 - kSig) < 1e-12
      ? null
      : (prevSig + histPrev / (1 - kSig) + baseDiff) / denom;

  return {
    isHistRising: histCurr >= histPrev,
    isBullishCrossState: macdCurr >= sig,
    isAboveZero: macdCurr >= 0,
    macdValue: macdCurr,
    signalValue: sig,
    histValue: histCurr,
    histContinuePrice:
      typeof histContinuePrice === "number" && Number.isFinite(histContinuePrice) && histContinuePrice > 0
        ? histContinuePrice
        : null,
    signalCrossPrice: Number.isFinite(signalCrossPrice) && signalCrossPrice > 0 ? signalCrossPrice : null,
    zeroCrossPrice: Number.isFinite(zeroCrossPrice) && zeroCrossPrice > 0 ? zeroCrossPrice : null,
  };
}

export function macd(
  candles: CandleData[],
  fastPeriod = 12,
  slowPeriod = 26,
  signalPeriod = 9,
): MACDResult {
  const sigP = Math.floor(signalPeriod);
  if (
    !Number.isFinite(fastPeriod) ||
    !Number.isFinite(slowPeriod) ||
    !Number.isFinite(signalPeriod) ||
    fastPeriod <= 0 ||
    slowPeriod <= 0 ||
    sigP <= 0
  ) {
    return { macd: [], signal: [], histogram: [], thresholds: null };
  }
  const fastEma = ema(candles, fastPeriod);
  const slowEma = ema(candles, slowPeriod);

  // Align by time
  const slowTimes = new Map(slowEma.map((p) => [p.time, p.value]));
  const macdLine: IndicatorPoint[] = [];
  for (const fp of fastEma) {
    const sv = slowTimes.get(fp.time);
    if (sv !== undefined) {
      macdLine.push({ time: fp.time, value: fp.value - sv });
    }
  }

  // Signal line = EMA of MACD line
  const signalLine: IndicatorPoint[] = [];
  if (macdLine.length >= sigP) {
    const k = 2 / (sigP + 1);
    let sum = 0;
    for (let i = 0; i < sigP; i++) sum += macdLine[i]!.value;
    let prev = sum / sigP;
    signalLine.push({ time: macdLine[sigP - 1]!.time, value: prev });

    for (let i = sigP; i < macdLine.length; i++) {
      prev = macdLine[i]!.value * k + prev * (1 - k);
      signalLine.push({ time: macdLine[i]!.time, value: prev });
    }
  }

  // Histogram = MACD - Signal
  const signalTimes = new Map(signalLine.map((p) => [p.time, p.value]));
  const histogram: IndicatorPoint[] = [];
  for (const mp of macdLine) {
    const sv = signalTimes.get(mp.time);
    if (sv !== undefined) {
      histogram.push({ time: mp.time, value: mp.value - sv });
    }
  }

  const thresholds = computeMacdThresholds(candles, fastPeriod, slowPeriod, signalPeriod);
  return { macd: macdLine, signal: signalLine, histogram, thresholds };
}

// ── Causal Quantitative Divergence Detection (Fractal Pivots + Regime Zones) ─
export interface DivergenceOptions {
  mode?: "rsi" | "macd";
  leftBars?: number; // lbL (default 5)
  rightBars?: number; // lbR (default 3)
  priceLeftBars?: number;
  priceRightBars?: number;
  oscLeftBars?: number;
  oscRightBars?: number;
  neighborhoodWindow?: number; // window size around osc pivot to get real price wick extreme (default 1)
  toleranceBars?: number;
  minBars?: number; // Dmin (default 5)
  maxBars?: number; // MAX_BARS_RANGE override
  regularMaxBars?: number;
  hiddenMaxBars?: number;
  minSeparationBars?: number;
  filterZones?: boolean; // whether to apply RSI exhaust/overbought and MACD zero-line zone filters (default true)
  rsiBullMaxZone?: number; // first pivot limit for regular bullish divergences (default 35)
  rsiBearMinZone?: number; // first pivot limit for regular bearish divergences (default 65)
  minRsiDelta?: number;
  minMacdDelta?: number;
  minMacdSwingPct?: number;
  macdMinContractionPct?: number;
  requireMacdZeroCrossForRegular?: boolean;
  minPriceDifferencePct?: number;
  priceSource?: "wick" | "close";
  filterHiddenByEma50?: boolean;
  oscillatorSource?: DivergenceOscillatorSource;
  includeRegular?: boolean;
  includeHidden?: boolean;
}

/** Standard balanced divergence defaults (no per-timeframe overfitting). */
export function balancedDivergenceOptions(
  _timeframe: string,
  mode: "rsi" | "macd",
  oscillatorSource: DivergenceOscillatorSource = mode === "rsi" ? "rsi" : "histogram",
  requireMacdZeroCrossForRegular: boolean = oscillatorSource === "histogram",
  filterHiddenByEma50 = false,
  priceSource: "wick" | "close" = "wick",
): DivergenceOptions {
  return {
    mode,
    oscillatorSource,
    oscLeftBars: 5,
    oscRightBars: 3,
    neighborhoodWindow: mode === "macd" ? (oscillatorSource === "histogram" ? 2 : 3) : 2,
    minBars: 5,
    regularMaxBars: 60,
    hiddenMaxBars: 60,
    minSeparationBars: 5,
    minPriceDifferencePct: 0.001,
    minRsiDelta: 2,
    rsiBullMaxZone: 40,
    rsiBearMinZone: 60,
    minMacdSwingPct: 0.05,
    macdMinContractionPct: 0.10,
    requireMacdZeroCrossForRegular,
    filterHiddenByEma50,
    priceSource,
    includeRegular: true,
    includeHidden: true,
  };
}

interface AlignedSample {
  time: number;
  high: number;
  low: number;
  close: number;
  osc: number;
}

interface ConfirmedPivot {
  barIndex: number;
  oscTime: number;
  oscValue: number;
  priceTime: number;
  priceValue: number;
  priceIndex: number;
  confirmedTime: number;
  valido: boolean;
}

const DIVERGENCE_LABELS: Record<DivergenceKind, string> = {
  bull: "Alcista",
  bear: "Bajista",
  "hidden-bull": "Alcista Oculta",
  "hidden-bear": "Bajista Oculta",
};

/**
 * 3.5 Detector de Pivote Fractal Mínimo Confirmado (Sin Repintado)
 * Evaluado estrictamente en la barra t con lbR barras cerradas a la derecha.
 */
function isPivotLowConfirmed(
  samples: AlignedSample[],
  lbL: number,
  lbR: number,
  t: number,
): boolean {
  const idxCandidato = t - lbR;
  if (idxCandidato - lbL < 0) return false;
  const valCandidato = samples[idxCandidato]!.osc;

  // Izquierda: valCandidato debe ser estrictamente menor que las lbL barras precedentes
  for (let i = idxCandidato - lbL; i <= idxCandidato - 1; i++) {
    if (samples[i]!.osc <= valCandidato) return false;
  }
  // Derecha: valCandidato debe ser menor o igual que las lbR barras confirmadas
  for (let j = idxCandidato + 1; j <= t; j++) {
    if (samples[j]!.osc < valCandidato) return false;
  }
  return true;
}

/**
 * 3.6 Detector de Pivote Fractal Máximo Confirmado (Sin Repintado)
 */
function isPivotHighConfirmed(
  samples: AlignedSample[],
  lbL: number,
  lbR: number,
  t: number,
): boolean {
  const idxCandidato = t - lbR;
  if (idxCandidato - lbL < 0) return false;
  const valCandidato = samples[idxCandidato]!.osc;

  for (let i = idxCandidato - lbL; i <= idxCandidato - 1; i++) {
    if (samples[i]!.osc >= valCandidato) return false;
  }
  for (let j = idxCandidato + 1; j <= t; j++) {
    if (samples[j]!.osc > valCandidato) return false;
  }
  return true;
}

/**
 * 3.7 Extracción del Extremo de Precio en la Vecindad del Pivote (±window barras)
 * Asegura leer el verdadero mínimo/máximo de la mecha aunque preceda o siga al oscilador en 1-2 barras,
 * acotado estrictamente por maxIndex (t) para impedir cualquier anticipación de datos futuros.
 */
function getNeighborhoodMin(
  samples: AlignedSample[],
  idxPivote: number,
  window: number,
  maxIndex: number = samples.length - 1,
): { value: number; index: number; time: number } {
  const start = Math.max(0, idxPivote - window);
  const end = Math.min(samples.length - 1, maxIndex, idxPivote + window);
  let minVal = samples[idxPivote]!.low;
  let minIdx = idxPivote;

  for (let k = start; k <= end; k++) {
    if (samples[k]!.low < minVal) {
      minVal = samples[k]!.low;
      minIdx = k;
    }
  }
  return { value: minVal, index: minIdx, time: samples[minIdx]!.time };
}

function getNeighborhoodMax(
  samples: AlignedSample[],
  idxPivote: number,
  window: number,
  maxIndex: number = samples.length - 1,
): { value: number; index: number; time: number } {
  const start = Math.max(0, idxPivote - window);
  const end = Math.min(samples.length - 1, maxIndex, idxPivote + window);
  let maxVal = samples[idxPivote]!.high;
  let maxIdx = idxPivote;

  for (let k = start; k <= end; k++) {
    if (samples[k]!.high > maxVal) {
      maxVal = samples[k]!.high;
      maxIdx = k;
    }
  }
  return { value: maxVal, index: maxIdx, time: samples[maxIdx]!.time };
}

function isLocalPriceLowValid(
  samples: AlignedSample[],
  priceIdx: number,
  priceVal: number,
  t: number,
  priceLeftBars?: number,
  priceRightBars?: number,
): boolean {
  if (priceIdx <= 0 || priceIdx >= t) return false;
  if (samples[priceIdx - 1]!.low < priceVal) return false;
  if (samples[priceIdx + 1]!.low < priceVal) return false;
  if (priceLeftBars && priceLeftBars > 1) {
    const start = Math.max(0, priceIdx - priceLeftBars);
    for (let i = start; i < priceIdx; i++) {
      if (samples[i]!.low < priceVal) return false;
    }
  }
  if (priceRightBars && priceRightBars > 1) {
    const rightLimit = Math.min(t, priceIdx + priceRightBars);
    for (let j = priceIdx + 1; j <= rightLimit; j++) {
      if (samples[j]!.low < priceVal) return false;
    }
  }
  return true;
}

function isLocalPriceHighValid(
  samples: AlignedSample[],
  priceIdx: number,
  priceVal: number,
  t: number,
  priceLeftBars?: number,
  priceRightBars?: number,
): boolean {
  if (priceIdx <= 0 || priceIdx >= t) return false;
  if (samples[priceIdx - 1]!.high > priceVal) return false;
  if (samples[priceIdx + 1]!.high > priceVal) return false;
  if (priceLeftBars && priceLeftBars > 1) {
    const start = Math.max(0, priceIdx - priceLeftBars);
    for (let i = start; i < priceIdx; i++) {
      if (samples[i]!.high > priceVal) return false;
    }
  }
  if (priceRightBars && priceRightBars > 1) {
    const rightLimit = Math.min(t, priceIdx + priceRightBars);
    for (let j = priceIdx + 1; j <= rightLimit; j++) {
      if (samples[j]!.high > priceVal) return false;
    }
  }
  return true;
}

/**
 * Sistema Cuantitativo de Divergencias MACD + RSI (4H / 1D)
 * Arquitectura: Pivotes Fractales Confirmados (Sin Repintado) + Extremos de Vecindad + Filtros de Zona
 */
export function detectDivergences(
  rawCandles: CandleData[],
  oscillator: IndicatorPoint[],
  options: DivergenceOptions = {},
): DivergenceSignal[] {
  const candles = normalizeCandles(rawCandles);
  const lbL = options.oscLeftBars ?? options.leftBars ?? 5;
  const lbR = options.oscRightBars ?? options.rightBars ?? 3;
  const defaultNeighborhood =
    options.mode === "macd" ? (options.oscillatorSource === "histogram" ? 2 : 3) : 2;
  const neighborhoodWin =
    options.neighborhoodWindow ?? options.toleranceBars ?? defaultNeighborhood;
  const minBars = options.minBars ?? 5;
  const regularMaxBars = options.regularMaxBars ?? options.maxBars ?? 50;
  const hiddenMaxBars = options.hiddenMaxBars ?? Math.min(30, options.maxBars ?? 50);
  const maxPairBars = Math.max(regularMaxBars, hiddenMaxBars);
  const minSep = options.minSeparationBars ?? 5;
  const filterZones = options.filterZones ?? true;
  const bullMaxZone = options.rsiBullMaxZone ?? 40;
  const bearMinZone = options.rsiBearMinZone ?? 60;
  const minRsiDelta = options.minRsiDelta ?? 3;
  const minMacdSwingPct = options.minMacdSwingPct ?? 0.05;
  const macdMinContractionPct = options.macdMinContractionPct ?? 0.15;
  const requireMacdZeroCross = options.requireMacdZeroCrossForRegular ?? false;
  const minPriceRel = options.minPriceDifferencePct ?? 0.0015;
  const includeRegular = options.includeRegular ?? true;
  const includeHidden = options.includeHidden ?? true;

  const minRequired = lbL + lbR + minBars;
  if (candles.length < minRequired) return [];

  const candleByTime = new Map<number, CandleData>();
  const candleIndexByTime = new Map<number, number>();
  for (let i = 0; i < candles.length; i++) {
    candleByTime.set(candles[i]!.time, candles[i]!);
    candleIndexByTime.set(candles[i]!.time, i);
  }

  const ema50ByTime = new Map(ema(candles, 50).map((point) => [point.time, point.value]));
  const volumeSma20ByIndex: Array<number | null> = Array(candles.length).fill(null);
  let rollingVolume = 0;
  for (let i = 0; i < candles.length; i++) {
    rollingVolume += candles[i]!.volume ?? 0;
    if (i >= 20) rollingVolume -= candles[i - 20]!.volume ?? 0;
    if (i >= 19) volumeSma20ByIndex[i] = rollingVolume / 20;
  }

  const averagePivotVolume = (index: number): number => {
    const first = Math.max(0, index - 1);
    const last = Math.min(candles.length - 1, index + 1);
    let total = 0;
    let count = 0;
    for (let i = first; i <= last; i++) {
      total += candles[i]!.volume ?? 0;
      count++;
    }
    return count > 0 ? total / count : 0;
  };

  const withSignalContext = (signal: DivergenceSignal): DivergenceSignal => {
    const pivot1Index = candleIndexByTime.get(signal.startPriceTime ?? signal.startTime);
    const pivot2Index = candleIndexByTime.get(signal.endPriceTime ?? signal.endTime);
    const confirmationIndex = candleIndexByTime.get(signal.confirmedTime);
    const emaValue = ema50ByTime.get(signal.confirmedTime) ?? null;
    const previousEmaValue = confirmationIndex != null && confirmationIndex > 0
      ? ema50ByTime.get(candles[confirmationIndex - 1]!.time) ?? null
      : null;
    const confirmationClose = confirmationIndex != null ? candles[confirmationIndex]!.close : null;
    const ema50DistancePct = emaValue != null && confirmationClose != null && emaValue !== 0
      ? ((confirmationClose - emaValue) / emaValue) * 100
      : null;
    const ema50SlopePct = emaValue != null && previousEmaValue != null && previousEmaValue !== 0
      ? ((emaValue - previousEmaValue) / previousEmaValue) * 100
      : null;
    const ema50Position = ema50DistancePct == null ? null : ema50DistancePct >= 0 ? "above" : "below";
    const isBullish = signal.kind === "bull" || signal.kind === "hidden-bull";
    const ema50TrendAligned = ema50Position == null || ema50SlopePct == null
      ? null
      : isBullish
        ? ema50Position === "above" && ema50SlopePct > 0
        : ema50Position === "below" && ema50SlopePct < 0;

    const pivot1AverageVolume = pivot1Index == null ? 0 : averagePivotVolume(pivot1Index);
    const pivot2AverageVolume = pivot2Index == null ? 0 : averagePivotVolume(pivot2Index);
    const pivot2Sma20 = pivot2Index == null ? null : volumeSma20ByIndex[pivot2Index] ?? null;
    const confirmationSma20 = confirmationIndex == null ? null : volumeSma20ByIndex[confirmationIndex] ?? null;

    return {
      ...signal,
      context: {
        ema50Value: emaValue,
        ema50DistancePct,
        ema50SlopePct,
        ema50Position,
        ema50TrendAligned,
        pivot1AverageVolume,
        pivot2AverageVolume,
        pivot2VolumeSma20Ratio:
          pivot2Sma20 != null && pivot2Sma20 > 0 ? pivot2AverageVolume / pivot2Sma20 : null,
        confirmationVolumeSma20Ratio:
          confirmationIndex != null && confirmationSma20 != null && confirmationSma20 > 0
            ? (candles[confirmationIndex]!.volume ?? 0) / confirmationSma20
            : null,
      },
    };
  };

  const hiddenTrendAligned = (direction: "bull" | "bear", confirmedTime: number): boolean => {
    const index = candleIndexByTime.get(confirmedTime);
    const emaValue = ema50ByTime.get(confirmedTime);
    if (index == null || index === 0 || emaValue == null) return false;
    const previousEma = ema50ByTime.get(candles[index - 1]!.time);
    if (previousEma == null) return false;
    const close = candles[index]!.close;
    return direction === "bull"
      ? close > emaValue && emaValue > previousEma
      : close < emaValue && emaValue < previousEma;
  };

  const samples: AlignedSample[] = [];
  for (const pt of oscillator) {
    const c = candleByTime.get(pt.time);
    if (c && Number.isFinite(pt.value)) {
      samples.push({
        time: pt.time,
        high: options.priceSource === "close" ? c.close : c.high,
        low: options.priceSource === "close" ? c.close : c.low,
        close: c.close,
        osc: pt.value,
      });
    }
  }

  const N = samples.length;
  if (N < minRequired) return [];

  const oscAbsScaleByIndex: number[] = Array(N).fill(0);
  let rollingAbsOsc = 0;
  for (let i = 0; i < N; i++) {
    rollingAbsOsc += Math.abs(samples[i]!.osc);
    if (i >= 50) rollingAbsOsc -= Math.abs(samples[i - 50]!.osc);
    oscAbsScaleByIndex[i] = rollingAbsOsc / Math.min(i + 1, 50);
  }

  const minOscDelta = (anchor: number, endAnchor = 0, barIndex = -1): number => {
    if (options.mode === "rsi") return minRsiDelta;
    if (options.minMacdDelta != null) return options.minMacdDelta;
    const peakMag = Math.max(Math.abs(anchor), Math.abs(endAnchor));
    const rollingFloor =
      barIndex >= 0 ? (oscAbsScaleByIndex[barIndex] ?? 0) * (minMacdSwingPct * 0.25) : 0;
    return Math.max(1e-12, peakMag * minMacdSwingPct, rollingFloor);
  };

  const macdRegularContractionValid = (start: number, end: number): boolean => {
    if (options.mode !== "macd") return true;
    const startMagnitude = Math.abs(start);
    return startMagnitude > 1e-12 && Math.abs(end) <= startMagnitude * (1 - macdMinContractionPct);
  };

  /** True if bar idx is strictly the deepest negative trough since the preceding zero-cross (causal backward walk). */
  const isDeepestInNegWave = (idx: number): boolean => {
    const target = samples[idx]!.osc;
    for (let k = idx - 1; k >= 0; k--) {
      const v = samples[k]!.osc;
      if (v >= 0) break;
      if (v < target - 1e-12) return false;
    }
    return true;
  };

  /** True if bar idx is strictly the highest positive peak since the preceding zero-cross (causal backward walk). */
  const isTallestInPosWave = (idx: number): boolean => {
    const target = samples[idx]!.osc;
    for (let k = idx - 1; k >= 0; k--) {
      const v = samples[k]!.osc;
      if (v <= 0) break;
      if (v > target + 1e-12) return false;
    }
    return true;
  };

  /** Enforce Alexander Elder's zero-line cross between histogram waves and true wave extremes. */
  const macdWaveSeparationValid = (
    side: "low" | "high",
    p1: number,
    p2: number,
    maxBetween: number,
    minBetween: number,
  ): boolean => {
    if (options.mode !== "macd" || !requireMacdZeroCross) return true;
    const s1 = samples[p1]!.osc;
    const s2 = samples[p2]!.osc;
    if (side === "low") {
      if (s1 < 0 && s2 < 0) {
        if (!(maxBetween > 0)) return false;
        if (options.oscillatorSource === "histogram") {
          return isDeepestInNegWave(p1) && isDeepestInNegWave(p2);
        }
      } else if (s1 > 0 && s2 > 0) {
        if (!(minBetween < 0)) return false;
      }
    } else {
      if (s1 > 0 && s2 > 0) {
        if (!(minBetween < 0)) return false;
        if (options.oscillatorSource === "histogram") {
          return isTallestInPosWave(p1) && isTallestInPosWave(p2);
        }
      } else if (s1 < 0 && s2 < 0) {
        if (!(maxBetween > 0)) return false;
      }
    }
    return true;
  };

  const hasClearLowLineOfSight = (p1: number, p2: number): boolean => {
    if (p2 - p1 <= 1) return true;
    const floor = Math.min(samples[p1]!.osc, samples[p2]!.osc);
    for (let k = p1 + 1; k < p2; k++) {
      if (samples[k]!.osc < floor - 1e-12) return false;
    }
    return true;
  };

  const hasClearHighLineOfSight = (p1: number, p2: number): boolean => {
    if (p2 - p1 <= 1) return true;
    const ceil = Math.max(samples[p1]!.osc, samples[p2]!.osc);
    for (let k = p1 + 1; k < p2; k++) {
      if (samples[k]!.osc > ceil + 1e-12) return false;
    }
    return true;
  };

  const hasClearPriceLowLineOfSight = (p1: ConfirmedPivot, p2: { index: number; value: number }): boolean => {
    if (p2.index - p1.priceIndex <= 1) return true;
    const floor = Math.min(p1.priceValue, p2.value);
    for (let k = p1.priceIndex + 1; k < p2.index; k++) {
      if (samples[k]!.low < floor - 1e-12) return false;
    }
    return true;
  };

  const hasClearPriceHighLineOfSight = (p1: ConfirmedPivot, p2: { index: number; value: number }): boolean => {
    if (p2.index - p1.priceIndex <= 1) return true;
    const ceil = Math.max(p1.priceValue, p2.value);
    for (let k = p1.priceIndex + 1; k < p2.index; k++) {
      if (samples[k]!.high > ceil + 1e-12) return false;
    }
    return true;
  };

  interface RawCandidate {
    signal: DivergenceSignal;
    p2: number;
  }

  const lowCandidates: RawCandidate[] = [];
  const highCandidates: RawCandidate[] = [];

  // Historial de memoria de pivotes confirmados
  const memoryLows: ConfirmedPivot[] = [];
  const memoryHighs: ConfirmedPivot[] = [];
  let lastAcceptedLowP2 = -Infinity;
  let lastAcceptedHighP2 = -Infinity;

  // Bucle principal causal: cada vela t cerrada evalúa pivotes candidatos en t - lbR
  for (let t = lbL + lbR; t < N; t++) {
    const idxPiv = t - lbR;

    // --- A. EVALUACIÓN DE PIVOTES MÍNIMOS (DIVERGENCIAS ALCISTAS) ---
    if (isPivotLowConfirmed(samples, lbL, lbR, t)) {
      const oscActual = samples[idxPiv]!.osc;
      const priceExt = getNeighborhoodMin(samples, idxPiv, neighborhoodWin, t);
      const precioActual = priceExt.value;

      if (
        isLocalPriceLowValid(
          samples,
          priceExt.index,
          precioActual,
          t,
          options.priceLeftBars,
          options.priceRightBars,
        )
      ) {
        // Evaluar únicamente contra el pivote swing inmediatamente anterior (ta.valuewhen(..., 1))
        let consumedCurrentLow = false;
        for (let m = memoryLows.length - 1; m >= 0; m--) {
          const memLow = memoryLows[m]!;
          const dist = idxPiv - memLow.barIndex;
          if (dist < minBars) continue;
          if (dist > maxPairBars) break;
          if (!memLow.valido) break;
          if (priceExt.index <= memLow.priceIndex) continue;
          if (!hasClearLowLineOfSight(memLow.barIndex, idxPiv)) continue;
          if (!hasClearPriceLowLineOfSight(memLow, priceExt)) continue;

          // Verificar separación real entre los dos valles (rebote intermedio del oscilador y sin ruptura de mínimo de precio)
          let maxOscBetween = -Infinity;
          let minOscBetween = Infinity;
          for (let k = memLow.barIndex + 1; k < idxPiv; k++) {
            const oscVal = samples[k]!.osc;
            if (oscVal > maxOscBetween) maxOscBetween = oscVal;
            if (oscVal < minOscBetween) minOscBetween = oscVal;
          }
          const valleyBaseline = Math.max(memLow.oscValue, oscActual);
          if (maxOscBetween <= valleyBaseline + minOscDelta(memLow.oscValue, oscActual, idxPiv) * 0.25) continue;
          if (options.mode === "macd" && filterZones && maxOscBetween < valleyBaseline * 0.85) continue;

          let filtroZonaRegBull = true;
          let filtroZonaHidBull = true;

          if (filterZones) {
            if (options.mode === "rsi") {
              filtroZonaRegBull = memLow.oscValue <= bullMaxZone;
            } else if (options.mode === "macd") {
              const inNegativeZone = memLow.oscValue < 0 && oscActual < 0;
              filtroZonaRegBull = inNegativeZone;
              if (options.oscillatorSource === "histogram") {
                filtroZonaHidBull = inNegativeZone;
              }
            }
          }

          const oscDiff = oscActual - memLow.oscValue;
          const priceRelDiff = (precioActual - memLow.priceValue) / Math.max(1e-9, memLow.priceValue);
          const anchorDelta = minOscDelta(memLow.oscValue, oscActual, idxPiv);

          let kind: DivergenceKind | null = null;
          if (
            includeRegular &&
            priceRelDiff <= -minPriceRel &&
            oscDiff >= anchorDelta &&
            filtroZonaRegBull &&
            macdRegularContractionValid(memLow.oscValue, oscActual) &&
            macdWaveSeparationValid("low", memLow.barIndex, idxPiv, maxOscBetween, minOscBetween)
          ) {
            // 1. Regular Alcista: Precio LL + Oscilador HL
            kind = "bull";
          } else if (
            includeHidden &&
            priceRelDiff >= minPriceRel &&
            oscDiff <= -anchorDelta &&
            filtroZonaHidBull &&
            (options.mode !== "macd" ||
              options.oscillatorSource !== "histogram" ||
              macdWaveSeparationValid("low", memLow.barIndex, idxPiv, maxOscBetween, minOscBetween)) &&
            (!options.filterHiddenByEma50 || hiddenTrendAligned("bull", samples[t]!.time))
          ) {
            // 2. Oculta Alcista: Precio HL + Oscilador LL
            kind = "hidden-bull";
          }

          const classMaxBars = kind?.startsWith("hidden") ? hiddenMaxBars : regularMaxBars;
          if (kind && dist <= classMaxBars) {
            if (idxPiv - lastAcceptedLowP2 >= minSep) {
              lowCandidates.push({
                p2: idxPiv,
                signal: {
                  kind,
                  label: DIVERGENCE_LABELS[kind],
                  oscillatorSource: options.oscillatorSource,
                  startTime: memLow.oscTime,
                  endTime: samples[idxPiv]!.time,
                  confirmedTime: samples[t]!.time, // Estricto anti-repintado: confirmada en vela t
                  startOsc: memLow.oscValue,
                  endOsc: oscActual,
                  startPrice: memLow.priceValue,
                  endPrice: precioActual,
                  startPriceTime: memLow.priceTime,
                  endPriceTime: priceExt.time,
                  startOscTime: memLow.oscTime,
                  endOscTime: samples[idxPiv]!.time,
                },
              });
              memLow.valido = false;
              consumedCurrentLow = true;
              lastAcceptedLowP2 = idxPiv;
              break;
            }
          }
        }

        memoryLows.push({
          barIndex: idxPiv,
          oscTime: samples[idxPiv]!.time,
          oscValue: oscActual,
          priceTime: priceExt.time,
          priceValue: precioActual,
          priceIndex: priceExt.index,
          confirmedTime: samples[t]!.time,
          valido: !consumedCurrentLow,
        });
      }
    }

    // --- B. EVALUACIÓN DE PIVOTES MÁXIMOS (DIVERGENCIAS BAJISTAS) ---
    if (isPivotHighConfirmed(samples, lbL, lbR, t)) {
      const oscActual = samples[idxPiv]!.osc;
      const priceExt = getNeighborhoodMax(samples, idxPiv, neighborhoodWin, t);
      const precioActual = priceExt.value;

      if (
        isLocalPriceHighValid(
          samples,
          priceExt.index,
          precioActual,
          t,
          options.priceLeftBars,
          options.priceRightBars,
        )
      ) {
        // Evaluar únicamente contra el pivote swing inmediatamente anterior (ta.valuewhen(..., 1))
        let consumedCurrentHigh = false;
        for (let m = memoryHighs.length - 1; m >= 0; m--) {
          const memHigh = memoryHighs[m]!;
          const dist = idxPiv - memHigh.barIndex;
          if (dist < minBars) continue;
          if (dist > maxPairBars) break;
          if (!memHigh.valido) break;
          if (priceExt.index <= memHigh.priceIndex) continue;
          if (!hasClearHighLineOfSight(memHigh.barIndex, idxPiv)) continue;
          if (!hasClearPriceHighLineOfSight(memHigh, priceExt)) continue;

          // Verificar separación real entre las dos crestas (retroceso intermedio del oscilador y sin ruptura de máximo de precio)
          let minOscBetween = Infinity;
          let maxOscBetween = -Infinity;
          for (let k = memHigh.barIndex + 1; k < idxPiv; k++) {
            const oscVal = samples[k]!.osc;
            if (oscVal < minOscBetween) minOscBetween = oscVal;
            if (oscVal > maxOscBetween) maxOscBetween = oscVal;
          }
          const hillBaseline = Math.min(memHigh.oscValue, oscActual);
          if (minOscBetween >= hillBaseline - minOscDelta(memHigh.oscValue, oscActual, idxPiv) * 0.25) continue;
          if (options.mode === "macd" && filterZones && minOscBetween > hillBaseline * 0.85) continue;

          let filtroZonaRegBear = true;
          let filtroZonaHidBear = true;

          if (filterZones) {
            if (options.mode === "rsi") {
              filtroZonaRegBear = memHigh.oscValue >= bearMinZone;
            } else if (options.mode === "macd") {
              const inPositiveZone = memHigh.oscValue > 0 && oscActual > 0;
              filtroZonaRegBear = inPositiveZone;
              if (options.oscillatorSource === "histogram") {
                filtroZonaHidBear = inPositiveZone;
              }
            }
          }

          const oscDiff = oscActual - memHigh.oscValue;
          const priceRelDiff = (precioActual - memHigh.priceValue) / Math.max(1e-9, memHigh.priceValue);
          const anchorDelta = minOscDelta(memHigh.oscValue, oscActual, idxPiv);

          let kind: DivergenceKind | null = null;
          if (
            includeRegular &&
            priceRelDiff >= minPriceRel &&
            oscDiff <= -anchorDelta &&
            filtroZonaRegBear &&
            macdRegularContractionValid(memHigh.oscValue, oscActual) &&
            macdWaveSeparationValid("high", memHigh.barIndex, idxPiv, maxOscBetween, minOscBetween)
          ) {
            // 3. Regular Bajista: Precio HH + Oscilador LH
            kind = "bear";
          } else if (
            includeHidden &&
            priceRelDiff <= -minPriceRel &&
            oscDiff >= anchorDelta &&
            filtroZonaHidBear &&
            (options.mode !== "macd" ||
              options.oscillatorSource !== "histogram" ||
              macdWaveSeparationValid("high", memHigh.barIndex, idxPiv, maxOscBetween, minOscBetween)) &&
            (!options.filterHiddenByEma50 || hiddenTrendAligned("bear", samples[t]!.time))
          ) {
            // 4. Oculta Bajista: Precio LH + Oscilador HH
            kind = "hidden-bear";
          }

          const classMaxBars = kind?.startsWith("hidden") ? hiddenMaxBars : regularMaxBars;
          if (kind && dist <= classMaxBars) {
            if (idxPiv - lastAcceptedHighP2 >= minSep) {
              highCandidates.push({
                p2: idxPiv,
                signal: {
                  kind,
                  label: DIVERGENCE_LABELS[kind],
                  oscillatorSource: options.oscillatorSource,
                  startTime: memHigh.oscTime,
                  endTime: samples[idxPiv]!.time,
                  confirmedTime: samples[t]!.time,
                  startOsc: memHigh.oscValue,
                  endOsc: oscActual,
                  startPrice: memHigh.priceValue,
                  endPrice: precioActual,
                  startPriceTime: memHigh.priceTime,
                  endPriceTime: priceExt.time,
                  startOscTime: memHigh.oscTime,
                  endOscTime: samples[idxPiv]!.time,
                },
              });
              memHigh.valido = false;
              consumedCurrentHigh = true;
              lastAcceptedHighP2 = idxPiv;
              break;
            }
          }
        }

        memoryHighs.push({
          barIndex: idxPiv,
          oscTime: samples[idxPiv]!.time,
          oscValue: oscActual,
          priceTime: priceExt.time,
          priceValue: precioActual,
          priceIndex: priceExt.index,
          confirmedTime: samples[t]!.time,
          valido: !consumedCurrentHigh,
        });
      }
    }
  }

  return [...lowCandidates.map((c) => c.signal), ...highCandidates.map((c) => c.signal)]
    .sort((a, b) => a.endTime - b.endTime)
    .map(withSignalContext);
}

// ── Bollinger Bands ──────────────────────────────────────────
export interface BollingerResult {
  upper: IndicatorPoint[];
  middle: IndicatorPoint[];
  lower: IndicatorPoint[];
}

export function bollingerBands(
  rawCandles: CandleData[],
  period = 20,
  stdDevMultiplier = 2,
): BollingerResult {
  const upper: IndicatorPoint[] = [];
  const middle: IndicatorPoint[] = [];
  const lower: IndicatorPoint[] = [];

  const p = Math.floor(period);
  if (!Number.isFinite(period) || p <= 0 || !Number.isFinite(stdDevMultiplier)) {
    return { upper, middle, lower };
  }
  const candles = normalizeCandles(rawCandles);
  if (candles.length < p) return { upper, middle, lower };

  for (let i = p - 1; i < candles.length; i++) {
    let sum = 0;
    for (let j = i - p + 1; j <= i; j++) sum += candles[j]!.close;
    const avg = sum / p;

    let variance = 0;
    for (let j = i - p + 1; j <= i; j++) {
      variance += (candles[j]!.close - avg) ** 2;
    }
    const stdDev = Math.sqrt(variance / p);

    const t = candles[i]!.time;
    middle.push({ time: t, value: avg });
    upper.push({ time: t, value: avg + stdDevMultiplier * stdDev });
    lower.push({ time: t, value: avg - stdDevMultiplier * stdDev });
  }

  return { upper, middle, lower };
}

// ── Average True Range ───────────────────────────────────────
export function atr(rawCandles: CandleData[], period = 14): IndicatorPoint[] {
  const result: IndicatorPoint[] = [];
  const p = Math.floor(period);
  if (!Number.isFinite(period) || p <= 0) return result;
  const candles = normalizeCandles(rawCandles);
  if (candles.length < p + 1) return result;

  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const tr = Math.max(
      candles[i]!.high - candles[i]!.low,
      Math.abs(candles[i]!.high - candles[i - 1]!.close),
      Math.abs(candles[i]!.low - candles[i - 1]!.close),
    );
    trs.push(tr);
  }

  let sum = 0;
  for (let i = 0; i < p; i++) sum += trs[i]!;
  let prev = sum / p;
  result.push({ time: candles[p]!.time, value: prev });

  for (let i = p; i < trs.length; i++) {
    prev = (prev * (p - 1) + trs[i]!) / p;
    result.push({ time: candles[i + 1]!.time, value: prev });
  }
  return result;
}

// ── Stochastic Oscillator ────────────────────────────────────
export interface StochasticResult {
  k: IndicatorPoint[];
  d: IndicatorPoint[];
}

function smaFromPoints(points: IndicatorPoint[], period: number): IndicatorPoint[] {
  const out: IndicatorPoint[] = [];
  const p = Math.floor(period);
  if (!Number.isFinite(period) || p <= 0 || points.length < p) return out;
  for (let i = p - 1; i < points.length; i++) {
    let sum = 0;
    for (let j = i - p + 1; j <= i; j++) sum += points[j]!.value;
    out.push({ time: points[i]!.time, value: sum / p });
  }
  return out;
}

export function stochastic(rawCandles: CandleData[], kPeriod = 14, dPeriod = 3): StochasticResult {
  const kp = Math.floor(kPeriod);
  const dp = Math.floor(dPeriod);
  if (!Number.isFinite(kPeriod) || !Number.isFinite(dPeriod) || kp <= 0 || dp <= 0) {
    return { k: [], d: [] };
  }
  const candles = normalizeCandles(rawCandles);
  const kLine: IndicatorPoint[] = [];
  if (candles.length < kp) return { k: [], d: [] };

  for (let i = kp - 1; i < candles.length; i++) {
    let highest = -Infinity;
    let lowest = Infinity;
    for (let j = i - kp + 1; j <= i; j++) {
      if (candles[j]!.high > highest) highest = candles[j]!.high;
      if (candles[j]!.low < lowest) lowest = candles[j]!.low;
    }
    const range = highest - lowest;
    const kVal =
      range <= 1e-12 ? 50 : Math.max(0, Math.min(100, ((candles[i]!.close - lowest) / range) * 100));
    kLine.push({ time: candles[i]!.time, value: kVal });
  }

  return { k: kLine, d: smaFromPoints(kLine, dp) };
}

/** Causal Stochastic RSI (14, 14, 3, 3): %K = SMA(Stoch(RSI), kSmooth), %D = SMA(%K, dSmooth). */
export function stochasticRsi(
  rawCandles: CandleData[],
  rsiPeriod = 14,
  stochPeriod = 14,
  kSmooth = 3,
  dSmooth = 3,
): StochasticResult {
  const rp = Math.floor(rsiPeriod);
  const sp = Math.floor(stochPeriod);
  const ks = Math.floor(kSmooth);
  const ds = Math.floor(dSmooth);
  if (
    !Number.isFinite(rsiPeriod) ||
    !Number.isFinite(stochPeriod) ||
    !Number.isFinite(kSmooth) ||
    !Number.isFinite(dSmooth) ||
    rp <= 0 ||
    sp <= 0 ||
    ks <= 0 ||
    ds <= 0
  ) {
    return { k: [], d: [] };
  }
  const rsiPoints = rsi(rawCandles, rp);
  if (rsiPoints.length < sp) return { k: [], d: [] };

  const rawStoch: IndicatorPoint[] = [];
  for (let i = sp - 1; i < rsiPoints.length; i++) {
    let highest = -Infinity;
    let lowest = Infinity;
    for (let j = i - sp + 1; j <= i; j++) {
      const v = rsiPoints[j]!.value;
      if (v > highest) highest = v;
      if (v < lowest) lowest = v;
    }
    const range = highest - lowest;
    const val =
      range <= 1e-12
        ? 50
        : Math.max(0, Math.min(100, ((rsiPoints[i]!.value - lowest) / range) * 100));
    rawStoch.push({ time: rsiPoints[i]!.time, value: val });
  }

  const kLine = smaFromPoints(rawStoch, ks);
  const dLine = smaFromPoints(kLine, ds);
  return { k: kLine, d: dLine };
}

// ── Volume Weighted Average Price & Standard Deviation Bands ─
export type VwapAnchorPeriod = "session" | "week" | "month" | "year" | "none";
export type VwapSessionTimeZone = "utc" | "america-new-york";
export type VwapPriceSource = "hlc3" | "hl2" | "ohlc4" | "close";

export interface VwapSessionSeed {
  anchorBucket: number;
  cumVol: number;
  mean: number;
  sumSqWeightedDiff: number;
}

export interface VwapBandsOptions {
  anchor?: VwapAnchorPeriod;
  multipliers?: [number, number, number];
  sessionTimeZone?: VwapSessionTimeZone;
  source?: VwapPriceSource;
  priorSessionSeed?: VwapSessionSeed | null;
  /** When true on NY sessions, anchors VWAP strictly at 09:30 ET (excluding pre-market bars from VWAP math). */
  anchorAtRegularOpen?: boolean;
  /**
   * Earliest unix timestamp (seconds) covered by the underlying historical dataset before UI session filtering.
   * Used to distinguish genuine zero-trade opening minutes from truncated history that begins mid-session.
   */
  rawCoverageStartSec?: number;
  /** Earliest unix timestamp (seconds) covered by `fine1mCandles` before UI session filtering. */
  fineRawCoverageStartSec?: number;
  /**
   * When true, omits any initial truncated session whose historical coverage starts strictly after
   * the session anchor (`09:30 ET` for regular, `04:00 ET` for NY extended, `00:00 UTC` for UTC)
   * unless `priorSessionSeed` supplies the missing pre-window volume.
   */
  requireCompleteSession?: boolean;
}

export interface VwapSessionCoverageAssessment {
  isComplete: boolean;
  anchorBucket: number | null;
  sessionAnchorSec: number | null;
  earliestBarSec: number | null;
  coverageStartSec: number | null;
  seeded: boolean;
}

export interface VwapBandsResult {
  vwap: IndicatorPoint[];
  upper1: IndicatorPoint[];
  lower1: IndicatorPoint[];
  upper2: IndicatorPoint[];
  lower2: IndicatorPoint[];
  upper3: IndicatorPoint[];
  lower3: IndicatorPoint[];
}

/** Pick standard VWAP anchor period matching the chart timeframe. */
export function defaultVwapAnchorForTimeframe(timeframe?: string): VwapAnchorPeriod {
  if (timeframe === "1w") return "year";
  if (timeframe === "1d") return "month";
  return "session";
}

let cachedNyDayFormatter: Intl.DateTimeFormat | null = null;
export function getNyTradingDayKey(timeSec: number): number {
  try {
    if (!cachedNyDayFormatter) {
      cachedNyDayFormatter = new Intl.DateTimeFormat("en-US", {
        timeZone: "America/New_York",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      });
    }
    const parts = cachedNyDayFormatter.formatToParts(new Date(timeSec * 1000));
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
    // fall through to UTC day key
  }
  return Math.floor(timeSec / 86400);
}

let cachedNySessionClockFormatter: Intl.DateTimeFormat | null = null;
function getNySessionMinutes(timeSec: number): { dayKey: number; minutes: number } {
  try {
    if (!cachedNySessionClockFormatter) {
      cachedNySessionClockFormatter = new Intl.DateTimeFormat("en-US", {
        timeZone: "America/New_York",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      });
    }
    const parts = cachedNySessionClockFormatter.formatToParts(new Date(timeSec * 1000));
    let year = 0;
    let month = 0;
    let day = 0;
    let hour = 0;
    let minute = 0;
    for (const part of parts) {
      if (part.type === "year") year = Number(part.value);
      else if (part.type === "month") month = Number(part.value);
      else if (part.type === "day") day = Number(part.value);
      else if (part.type === "hour") hour = Number(part.value) % 24;
      else if (part.type === "minute") minute = Number(part.value);
    }
    if (year > 0 && month > 0 && day > 0) {
      return { dayKey: year * 10_000 + month * 100 + day, minutes: hour * 60 + minute };
    }
  } catch {
    // fall through
  }
  const d = new Date(timeSec * 1000);
  return {
    dayKey: Math.floor(timeSec / 86400),
    minutes: d.getUTCHours() * 60 + d.getUTCMinutes(),
  };
}

export function getVwapAnchorBucket(
  timeSec: number,
  anchor: VwapAnchorPeriod,
  sessionTimeZone: VwapSessionTimeZone = "utc",
): number {
  if (anchor === "none") return 0;
  if (anchor === "session") {
    return sessionTimeZone === "america-new-york"
      ? getNyTradingDayKey(timeSec)
      : Math.floor(timeSec / 86400);
  }
  if (anchor === "week") return Math.floor((timeSec + 3 * 86400) / (7 * 86400)); // UTC Monday reset
  const d = new Date(timeSec * 1000);
  if (anchor === "month") return d.getUTCFullYear() * 12 + d.getUTCMonth();
  return d.getUTCFullYear();
}

export function vwap(
  rawCandles: CandleData[],
  sessionReset = true,
  priorSessionSeed: VwapSessionSeed | null = null,
): IndicatorPoint[] {
  const candles = normalizeCandles(rawCandles);
  const result: IndicatorPoint[] = [];
  let cumVolPrice = 0;
  let cumVol = 0;
  let fallbackSum = 0;
  let fallbackCount = 0;
  let lastDay = -1;

  for (const c of candles) {
    if (sessionReset) {
      const day = Math.floor(c.time / 86400);
      if (day !== lastDay) {
        if (
          lastDay === -1 &&
          priorSessionSeed &&
          priorSessionSeed.anchorBucket === day &&
          priorSessionSeed.cumVol > 0
        ) {
          cumVol = priorSessionSeed.cumVol;
          cumVolPrice = priorSessionSeed.mean * priorSessionSeed.cumVol;
        } else {
          cumVolPrice = 0;
          cumVol = 0;
        }
        fallbackSum = 0;
        fallbackCount = 0;
        lastDay = day;
      }
    }
    const typicalPrice = (c.high + c.low + c.close) / 3;
    if (c.volume != null && c.volume > 0) {
      cumVolPrice += typicalPrice * c.volume;
      cumVol += c.volume;
      result.push({ time: c.time, value: cumVolPrice / cumVol });
    } else if (cumVol > 0) {
      // Zero-volume bar after real volume exists: carry forward without injecting fake volume
      result.push({ time: c.time, value: cumVolPrice / cumVol });
    } else {
      fallbackSum += typicalPrice;
      fallbackCount += 1;
      result.push({ time: c.time, value: fallbackSum / fallbackCount });
    }
  }
  return result;
}

let cachedNyFullPartsFormatter: Intl.DateTimeFormat | null = null;
function nyDayKeyAndAnchorToUtcSec(dayKey: number, anchorHour: number, anchorMinute: number): number {
  const y = Math.floor(dayKey / 10_000);
  const m = Math.floor((dayKey % 10_000) / 100);
  const d = dayKey % 100;
  const wallUtcMs = Date.UTC(y, m - 1, d, anchorHour, anchorMinute, 0);
  try {
    if (!cachedNyFullPartsFormatter) {
      cachedNyFullPartsFormatter = new Intl.DateTimeFormat("en-US", {
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
      const parts = cachedNyFullPartsFormatter!.formatToParts(new Date(utcMs));
      let py = 0;
      let pm = 0;
      let pd = 0;
      let ph = 0;
      let pmi = 0;
      let psec = 0;
      for (const p of parts) {
        if (p.type === "year") py = Number(p.value);
        else if (p.type === "month") pm = Number(p.value);
        else if (p.type === "day") pd = Number(p.value);
        else if (p.type === "hour") ph = Number(p.value) % 24;
        else if (p.type === "minute") pmi = Number(p.value);
        else if (p.type === "second") psec = Number(p.value);
      }
      return Date.UTC(py, pm - 1, pd, ph, pmi, psec);
    };
    let guessMs = wallUtcMs + 5 * 3600_000;
    guessMs += wallUtcMs - readNyWallMs(guessMs);
    guessMs += wallUtcMs - readNyWallMs(guessMs);
    return Math.floor(guessMs / 1000);
  } catch {
    return Math.floor((wallUtcMs + 5 * 3600_000) / 1000);
  }
}

export function getSessionAnchorStartSec(
  sampleBarTimeSec: number,
  sessionTimeZone: VwapSessionTimeZone = "utc",
  anchorAtRegularOpen = false,
): number {
  if (sessionTimeZone === "america-new-york") {
    const dayKey = getNyTradingDayKey(sampleBarTimeSec);
    return anchorAtRegularOpen
      ? nyDayKeyAndAnchorToUtcSec(dayKey, 9, 30)
      : nyDayKeyAndAnchorToUtcSec(dayKey, 4, 0);
  }
  return Math.floor(sampleBarTimeSec / 86400) * 86400;
}

/**
 * Evaluates whether `rawCandles` (plus optional `priorSessionSeed` and `rawCoverageStartSec`)
 * completely covers the latest session in `rawCandles` from its true session anchor
 * (`09:30 ET` for NY Regular Session, `04:00 ET` for NY Extended Session, `00:00 UTC` for UTC).
 */
export function assessVwapSessionCoverage(
  rawCandles: CandleData[],
  options: VwapBandsOptions = {},
): VwapSessionCoverageAssessment {
  const anchor: VwapAnchorPeriod = options.anchor ?? "session";
  const sessionTimeZone: VwapSessionTimeZone = options.sessionTimeZone ?? "utc";
  const anchorAtRegularOpen =
    Boolean(options.anchorAtRegularOpen) &&
    anchor === "session" &&
    sessionTimeZone === "america-new-york";
  const candles = normalizeCandles(rawCandles);
  if (candles.length === 0) {
    return {
      isComplete: false,
      anchorBucket: null,
      sessionAnchorSec: null,
      earliestBarSec: null,
      coverageStartSec: null,
      seeded: false,
    };
  }
  if (anchor !== "session") {
    return {
      isComplete: true,
      anchorBucket: getVwapAnchorBucket(candles[candles.length - 1]!.time, anchor, sessionTimeZone),
      sessionAnchorSec: candles[0]!.time,
      earliestBarSec: candles[0]!.time,
      coverageStartSec: candles[0]!.time,
      seeded: false,
    };
  }

  const eligible = anchorAtRegularOpen
    ? candles.filter((c) => {
        const ny = getNySessionMinutes(c.time);
        return ny.minutes >= 570 && ny.minutes < 960;
      })
    : candles;
  if (eligible.length === 0) {
    return {
      isComplete: false,
      anchorBucket: null,
      sessionAnchorSec: null,
      earliestBarSec: null,
      coverageStartSec: null,
      seeded: false,
    };
  }

  const lastBar = eligible[eligible.length - 1]!;
  const targetDay = getVwapAnchorBucket(lastBar.time, "session", sessionTimeZone);
  const sessionAnchorSec = getSessionAnchorStartSec(
    lastBar.time,
    sessionTimeZone,
    anchorAtRegularOpen,
  );
  let earliestDayBarSec = lastBar.time;
  for (const c of eligible) {
    if (getVwapAnchorBucket(c.time, "session", sessionTimeZone) === targetDay) {
      earliestDayBarSec = c.time;
      break;
    }
  }
  const coverageStartSec =
    typeof options.rawCoverageStartSec === "number" && Number.isFinite(options.rawCoverageStartSec)
      ? Math.min(options.rawCoverageStartSec, candles[0]!.time)
      : candles[0]!.time;
  const priorSeed = options.priorSessionSeed ?? null;
  const seeded =
    priorSeed != null && priorSeed.anchorBucket === targetDay && priorSeed.cumVol > 0;
  const isComplete = seeded || coverageStartSec <= sessionAnchorSec;

  return {
    isComplete,
    anchorBucket: targetDay,
    sessionAnchorSec,
    earliestBarSec: earliestDayBarSec,
    coverageStartSec,
    seeded,
  };
}

export function isVwapSessionCoverageComplete(
  rawCandles: CandleData[],
  options: VwapBandsOptions = {},
): boolean {
  return assessVwapSessionCoverage(rawCandles, options).isComplete;
}

/**
 * Causal VWAP with 3 symmetrical standard deviation bands (±1σ, ±2σ, ±3σ)
 * computed via volume-weighted Welford updates over the selected price source.
 * Supports `priorSessionSeed` so sub-minute charts (e.g. 1s/5s/15s) starting mid-session
 * continue seamlessly from the 04:00 ET / 09:30 ET consolidated session VWAP.
 */
export function vwapBands(
  rawCandles: CandleData[],
  options: VwapBandsOptions = {},
): VwapBandsResult {
  const anchor: VwapAnchorPeriod = options.anchor ?? "session";
  const sessionTimeZone: VwapSessionTimeZone = options.sessionTimeZone ?? "utc";
  const source: VwapPriceSource = options.source ?? "hlc3";
  const [m1, m2, m3] = options.multipliers ?? [1, 2, 3];
  const priorSeed = options.priorSessionSeed ?? null;
  const anchorAtRegularOpen =
    Boolean(options.anchorAtRegularOpen) &&
    anchor === "session" &&
    sessionTimeZone === "america-new-york";
  const enforceCompleteSession =
    anchor === "session" && (Boolean(options.requireCompleteSession) || anchorAtRegularOpen);
  const candles = normalizeCandles(rawCandles);
  const coverageStartSec =
    candles.length > 0
      ? typeof options.rawCoverageStartSec === "number" &&
        Number.isFinite(options.rawCoverageStartSec)
        ? Math.min(options.rawCoverageStartSec, candles[0]!.time)
        : candles[0]!.time
      : Infinity;

  const vwapLine: IndicatorPoint[] = [];
  const upper1: IndicatorPoint[] = [];
  const lower1: IndicatorPoint[] = [];
  const upper2: IndicatorPoint[] = [];
  const lower2: IndicatorPoint[] = [];
  const upper3: IndicatorPoint[] = [];
  const lower3: IndicatorPoint[] = [];

  let cumVol = 0;
  let mean = 0;
  let sumSqWeightedDiff = 0;
  let fallbackCount = 0;
  let fallbackMean = 0;
  let fallbackSumSq = 0;
  let lastBucket: number | null = null;
  let bucketIncomplete = false;

  for (const c of candles) {
    let bucket: number;
    if (anchorAtRegularOpen) {
      const ny = getNySessionMinutes(c.time);
      if (ny.minutes < 570 || ny.minutes >= 960) continue; // Anchor strictly to 09:30–16:00 ET regular session
      bucket = ny.dayKey;
    } else {
      bucket = getVwapAnchorBucket(c.time, anchor, sessionTimeZone);
    }
    if (anchor !== "none" && bucket !== lastBucket) {
      const hasMatchingSeed =
        lastBucket === null &&
        priorSeed != null &&
        priorSeed.anchorBucket === bucket &&
        priorSeed.cumVol > 0;
      if (hasMatchingSeed) {
        cumVol = priorSeed.cumVol;
        mean = priorSeed.mean;
        sumSqWeightedDiff = Math.max(0, priorSeed.sumSqWeightedDiff);
        bucketIncomplete = false;
      } else {
        cumVol = 0;
        mean = 0;
        sumSqWeightedDiff = 0;
        if (enforceCompleteSession) {
          const anchorSec = getSessionAnchorStartSec(
            c.time,
            sessionTimeZone,
            anchorAtRegularOpen,
          );
          bucketIncomplete = coverageStartSec > anchorSec;
        } else {
          bucketIncomplete = false;
        }
      }
      fallbackCount = 0;
      fallbackMean = 0;
      fallbackSumSq = 0;
      lastBucket = bucket;
    }

    if (bucketIncomplete) {
      continue;
    }

    const barPrice =
      source === "close"
        ? c.close
        : source === "hl2"
          ? (c.high + c.low) / 2
          : source === "ohlc4"
            ? (c.open + c.high + c.low + c.close) / 4
            : (c.high + c.low + c.close) / 3;

    let activeMean: number;
    let activeStdDev: number;

    if (c.volume != null && c.volume > 0) {
      const vol = c.volume;
      const prevMean = mean;
      cumVol += vol;
      mean = prevMean + (vol / cumVol) * (barPrice - prevMean);
      sumSqWeightedDiff += vol * (barPrice - prevMean) * (barPrice - mean);
      activeMean = mean;
      activeStdDev = Math.sqrt(Math.max(0, sumSqWeightedDiff / cumVol));
    } else if (cumVol > 0) {
      // Carry forward session VWAP & stdDev unchanged on 0-volume ticks/gaps
      activeMean = mean;
      activeStdDev = Math.sqrt(Math.max(0, sumSqWeightedDiff / cumVol));
    } else {
      // Equal-weight fallback only while session has had no real volume (e.g. Forex)
      const prevFbMean = fallbackMean;
      fallbackCount += 1;
      fallbackMean = prevFbMean + (barPrice - prevFbMean) / fallbackCount;
      fallbackSumSq += (barPrice - prevFbMean) * (barPrice - fallbackMean);
      activeMean = fallbackMean;
      activeStdDev = Math.sqrt(Math.max(0, fallbackSumSq / fallbackCount));
    }

    const t = c.time;
    vwapLine.push({ time: t, value: activeMean });
    upper1.push({ time: t, value: activeMean + m1 * activeStdDev });
    lower1.push({ time: t, value: activeMean - m1 * activeStdDev });
    upper2.push({ time: t, value: activeMean + m2 * activeStdDev });
    lower2.push({ time: t, value: activeMean - m2 * activeStdDev });
    upper3.push({ time: t, value: activeMean + m3 * activeStdDev });
    lower3.push({ time: t, value: activeMean - m3 * activeStdDev });
  }

  return { vwap: vwapLine, upper1, lower1, upper2, lower2, upper3, lower3 };
}

/**
 * Computes institutional session VWAP + ±1σ/2σ/3σ bands on higher intraday timeframes
 * (e.g. 3m, 5m, 15m) anchored to 1-minute trade-volume resolution whenever 1m session bars
 * are available, guaranteeing 0.00 discrepancy between 1m (left) and 5m/3m (right) charts.
 */
export function computeFineGrainedSessionVwap(
  targetCandles: CandleData[],
  fine1mCandles: CandleData[] | null | undefined,
  targetTfSec: number,
  options: VwapBandsOptions = {},
): VwapBandsResult {
  const anchor: VwapAnchorPeriod = options.anchor ?? "session";
  if (
    !fine1mCandles ||
    fine1mCandles.length === 0 ||
    !Number.isFinite(targetTfSec) ||
    targetTfSec <= 60 ||
    anchor !== "session"
  ) {
    return vwapBands(targetCandles, options);
  }

  const normalizedFine = normalizeCandles(fine1mCandles);
  if (normalizedFine.length === 0) {
    return vwapBands(targetCandles, options);
  }

  const fineCoverageStartSec =
    typeof options.fineRawCoverageStartSec === "number" &&
    Number.isFinite(options.fineRawCoverageStartSec)
      ? Math.min(options.fineRawCoverageStartSec, normalizedFine[0]!.time)
      : normalizedFine[0]!.time;

  const base = vwapBands(targetCandles, options);
  if (base.vwap.length === 0) return base;

  const fineRes = vwapBands(normalizedFine, {
    ...options,
    rawCoverageStartSec: fineCoverageStartSec,
  });
  if (fineRes.vwap.length === 0) {
    // If 1m history is present for the same session day(s) as `base`, do NOT silently pretend
    // a truncated 1m session is covered by falling back to coarse bars when complete session coverage is required.
    const sessionTzCheck: VwapSessionTimeZone = options.sessionTimeZone ?? "utc";
    const anchorReg =
      Boolean(options.anchorAtRegularOpen) && sessionTzCheck === "america-new-york";
    if (options.requireCompleteSession || anchorReg) {
      const incompleteFineDays = new Set<number>();
      for (const c of normalizedFine) {
        const d = getVwapAnchorBucket(c.time, "session", sessionTzCheck);
        const anchorSec = getSessionAnchorStartSec(c.time, sessionTzCheck, anchorReg);
        const seeded =
          options.priorSessionSeed != null &&
          options.priorSessionSeed.anchorBucket === d &&
          options.priorSessionSeed.cumVol > 0;
        if (!seeded && fineCoverageStartSec > anchorSec) {
          incompleteFineDays.add(d);
        }
      }
      if (incompleteFineDays.size > 0) {
        const keepIdx: number[] = [];
        for (let i = 0; i < base.vwap.length; i++) {
          const d = getVwapAnchorBucket(base.vwap[i]!.time, "session", sessionTzCheck);
          if (!incompleteFineDays.has(d)) keepIdx.push(i);
        }
        return {
          vwap: keepIdx.map((i) => base.vwap[i]!),
          upper1: keepIdx.map((i) => base.upper1[i]!),
          lower1: keepIdx.map((i) => base.lower1[i]!),
          upper2: keepIdx.map((i) => base.upper2[i]!),
          lower2: keepIdx.map((i) => base.lower2[i]!),
          upper3: keepIdx.map((i) => base.upper3[i]!),
          lower3: keepIdx.map((i) => base.lower3[i]!),
        };
      }
    }
    return base;
  }

  const sessionTz: VwapSessionTimeZone = options.sessionTimeZone ?? "utc";
  const anchorAtRegularOpen =
    Boolean(options.anchorAtRegularOpen) && sessionTz === "america-new-york";
  const earliestTargetByDay = new Map<number, number>();
  for (const pt of base.vwap) {
    const day = getVwapAnchorBucket(pt.time, "session", sessionTz);
    const prev = earliestTargetByDay.get(day);
    if (prev === undefined || pt.time < prev) earliestTargetByDay.set(day, pt.time);
  }

  const earliestFineByDay = new Map<number, number>();
  const fineDayKeys: number[] = new Array(fineRes.vwap.length);
  for (let idx = 0; idx < fineRes.vwap.length; idx++) {
    const t = fineRes.vwap[idx]!.time;
    const day = getVwapAnchorBucket(t, "session", sessionTz);
    fineDayKeys[idx] = day;
    const prev = earliestFineByDay.get(day);
    if (prev === undefined || t < prev) earliestFineByDay.set(day, t);
  }

  const coveredDays = new Set<number>();
  for (const [day, targetStart] of earliestTargetByDay.entries()) {
    const fineStart = earliestFineByDay.get(day);
    if (fineStart === undefined) continue;
    // Strict session coverage: never accept a lone mid-bucket 1m bar (e.g. 09:34 inside 09:30..09:35)
    // unless `fine1mCandles` was already recording at or before `targetStart` (proving 09:30..09:33 had 0 trades).
    const coversTargetStart =
      fineStart <= targetStart ||
      (fineCoverageStartSec <= targetStart && fineStart < targetStart + targetTfSec);
    if (!coversTargetStart) continue;
    if (options.requireCompleteSession || anchorAtRegularOpen) {
      const anchorSec = getSessionAnchorStartSec(
        targetStart,
        sessionTz,
        anchorAtRegularOpen,
      );
      const seeded =
        options.priorSessionSeed != null &&
        options.priorSessionSeed.anchorBucket === day &&
        options.priorSessionSeed.cumVol > 0;
      if (!seeded && fineCoverageStartSec > anchorSec) continue;
    }
    coveredDays.add(day);
  }
  if (coveredDays.size === 0) return base;

  const outVwap = base.vwap.slice();
  const outU1 = base.upper1.slice();
  const outL1 = base.lower1.slice();
  const outU2 = base.upper2.slice();
  const outL2 = base.lower2.slice();
  const outU3 = base.upper3.slice();
  const outL3 = base.lower3.slice();

  let j = 0;
  for (let i = 0; i < outVwap.length; i++) {
    const t = outVwap[i]!.time;
    const day = getVwapAnchorBucket(t, "session", sessionTz);
    if (!coveredDays.has(day)) continue;

    const endExclusive = t + targetTfSec;
    while (j + 1 < fineRes.vwap.length && fineRes.vwap[j + 1]!.time < endExclusive) {
      j++;
    }
    if (fineRes.vwap[j]!.time < endExclusive && fineDayKeys[j] === day) {
      outVwap[i] = { time: t, value: fineRes.vwap[j]!.value };
      outU1[i] = { time: t, value: fineRes.upper1[j]!.value };
      outL1[i] = { time: t, value: fineRes.lower1[j]!.value };
      outU2[i] = { time: t, value: fineRes.upper2[j]!.value };
      outL2[i] = { time: t, value: fineRes.lower2[j]!.value };
      outU3[i] = { time: t, value: fineRes.upper3[j]!.value };
      outL3[i] = { time: t, value: fineRes.lower3[j]!.value };
    }
  }

  return {
    vwap: outVwap,
    upper1: outU1,
    lower1: outL1,
    upper2: outU2,
    lower2: outL2,
    upper3: outU3,
    lower3: outL3,
  };
}

// ── Volume Profile (VPVR) ────────────────────────────────────

export interface VolumeProfileBin {
  index: number;
  priceLow: number;
  priceHigh: number;
  priceMid: number;
  totalVolume: number;
  buyVolume: number;
  sellVolume: number;
}

export interface VolumeProfileOptions {
  rows?: number;
  valueAreaPct?: number;
}

export interface VolumeProfileResult {
  bins: VolumeProfileBin[];
  pocIndex: number;
  pocPrice: number;
  vahIndex: number;
  valIndex: number;
  vahPrice: number;
  valPrice: number;
  totalVolume: number;
  maxBinVolume: number;
  minPrice: number;
  maxPrice: number;
}

/**
 * Computes a price-by-volume histogram (VPVR) across the supplied candles,
 * locating the Point of Control (POC) and Value Area (VAH / VAL).
 */
export function computeVolumeProfile(
  candles: CandleData[],
  opts?: VolumeProfileOptions,
): VolumeProfileResult {
  const clean = normalizeCandles(candles);
  if (clean.length === 0) {
    return {
      bins: [],
      pocIndex: -1,
      pocPrice: 0,
      vahIndex: -1,
      valIndex: -1,
      vahPrice: 0,
      valPrice: 0,
      totalVolume: 0,
      maxBinVolume: 0,
      minPrice: 0,
      maxPrice: 0,
    };
  }

  const rows = Math.max(12, Math.min(100, Math.round(opts?.rows ?? 36)));
  const valueAreaPct = Math.max(50, Math.min(90, opts?.valueAreaPct ?? 70));

  let rawMin = clean[0]!.low;
  let rawMax = clean[0]!.high;
  for (let i = 1; i < clean.length; i++) {
    const c = clean[i]!;
    if (c.low < rawMin) rawMin = c.low;
    if (c.high > rawMax) rawMax = c.high;
  }

  const rawSpan = rawMax - rawMin;
  const minPrice = rawSpan > 0 ? rawMin : rawMin - Math.max(1e-6, Math.abs(rawMin) * 0.0005);
  const maxPrice = rawSpan > 0 ? rawMax : rawMax + Math.max(1e-6, Math.abs(rawMax) * 0.0005);
  const span = maxPrice - minPrice;
  const binHeight = span / rows;

  const bins: VolumeProfileBin[] = Array.from({ length: rows }, (_, i) => {
    const priceLow = minPrice + i * binHeight;
    const priceHigh = i === rows - 1 ? maxPrice : minPrice + (i + 1) * binHeight;
    return {
      index: i,
      priceLow,
      priceHigh,
      priceMid: (priceLow + priceHigh) / 2,
      totalVolume: 0,
      buyVolume: 0,
      sellVolume: 0,
    };
  });

  let totalVolume = 0;
  const clampBin = (p: number) =>
    Math.max(0, Math.min(rows - 1, Math.floor(((p - minPrice) / span) * rows)));

  for (const c of clean) {
    const vol = typeof c.volume === "number" && Number.isFinite(c.volume) && c.volume > 0 ? c.volume : 1;
    const isBull = c.close >= c.open;
    totalVolume += vol;

    if (c.high <= c.low) {
      const idx = clampBin(c.close);
      const bin = bins[idx]!;
      bin.totalVolume += vol;
      if (isBull) bin.buyVolume += vol;
      else bin.sellVolume += vol;
      continue;
    }

    const startBin = clampBin(c.low);
    const endBin = clampBin(c.high);
    let overlapSum = 0;
    const overlaps: number[] = [];
    for (let b = startBin; b <= endBin; b++) {
      const bin = bins[b]!;
      const overlap = Math.max(0, Math.min(c.high, bin.priceHigh) - Math.max(c.low, bin.priceLow));
      overlaps.push(overlap);
      overlapSum += overlap;
    }

    const count = endBin - startBin + 1;
    for (let k = 0; k < count; k++) {
      const bin = bins[startBin + k]!;
      const frac = overlapSum > 0 ? overlaps[k]! / overlapSum : 1 / count;
      const part = vol * frac;
      bin.totalVolume += part;
      if (isBull) bin.buyVolume += part;
      else bin.sellVolume += part;
    }
  }

  let pocIndex = 0;
  let maxBinVolume = -1;
  for (let i = 0; i < bins.length; i++) {
    if (bins[i]!.totalVolume > maxBinVolume) {
      maxBinVolume = bins[i]!.totalVolume;
      pocIndex = i;
    }
  }

  let lowIdx = pocIndex;
  let highIdx = pocIndex;
  let accVol = bins[pocIndex]!.totalVolume;
  const targetVol = totalVolume * (valueAreaPct / 100);

  while (accVol < targetVol && (lowIdx > 0 || highIdx < rows - 1)) {
    const upVol = highIdx + 1 < rows ? bins[highIdx + 1]!.totalVolume : -1;
    const dnVol = lowIdx - 1 >= 0 ? bins[lowIdx - 1]!.totalVolume : -1;
    if (upVol >= dnVol) {
      highIdx++;
      accVol += Math.max(0, upVol);
    } else {
      lowIdx--;
      accVol += Math.max(0, dnVol);
    }
  }

  return {
    bins,
    pocIndex,
    pocPrice: bins[pocIndex]!.priceMid,
    vahIndex: highIdx,
    valIndex: lowIdx,
    vahPrice: bins[highIdx]!.priceHigh,
    valPrice: bins[lowIdx]!.priceLow,
    totalVolume,
    maxBinVolume: Math.max(0, maxBinVolume),
    minPrice,
    maxPrice,
  };
}

// ── Automatic Market Structure (SMC: Swings, BOS/CHoCH, FVG) ─

export type SwingLabel = "HH" | "HL" | "LH" | "LL";

export interface SwingPoint {
  kind: "high" | "low";
  label: SwingLabel;
  price: number;
  time: number;
  barIndex: number;
  confirmedTime: number;
}

export interface StructureBreak {
  kind: "BOS" | "CHoCH";
  direction: "bullish" | "bearish";
  price: number;
  fromTime: number;
  toTime: number;
  confirmedBarIndex: number;
}

export interface FairValueGap {
  direction: "bullish" | "bearish";
  top: number;
  bottom: number;
  startTime: number;
  endTime: number;
  mitigated: boolean;
  mitigatedTime?: number;
}

export interface SmcOptions {
  swingLength?: number;
}

export interface MarketStructureResult {
  trend: "bullish" | "bearish" | "neutral";
  swings: SwingPoint[];
  breaks: StructureBreak[];
  fvgs: FairValueGap[];
  lastSwingHigh: SwingPoint | null;
  lastSwingLow: SwingPoint | null;
}

/**
 * Strictly causal Smart Money Concepts (SMC) market structure detector:
 * confirms swing highs/lows (HH/HL/LH/LL) after `swingLength` bars, emits
 * BOS & CHoCH structure breaks on bar close, and tracks 3-bar Fair Value Gaps.
 */
export function computeMarketStructure(
  candles: CandleData[],
  opts?: SmcOptions,
): MarketStructureResult {
  const clean = normalizeCandles(candles);
  const swingLength = Math.max(2, Math.min(20, Math.round(opts?.swingLength ?? 5)));

  const swings: SwingPoint[] = [];
  const breaks: StructureBreak[] = [];
  const fvgs: FairValueGap[] = [];

  let trend: "bullish" | "bearish" | "neutral" = "neutral";
  const state: {
    lastSwingHigh: SwingPoint | null;
    lastSwingLow: SwingPoint | null;
    activeHigh: SwingPoint | null;
    activeLow: SwingPoint | null;
    activeHighBroken: boolean;
    activeLowBroken: boolean;
    lastBullBreakBarIdx: number;
    lastBearBreakBarIdx: number;
  } = {
    lastSwingHigh: null,
    lastSwingLow: null,
    activeHigh: null,
    activeLow: null,
    activeHighBroken: false,
    activeLowBroken: false,
    lastBullBreakBarIdx: -1,
    lastBearBreakBarIdx: -1,
  };

  const emitSwingHigh = (idx: number, confirmedTime: number) => {
    const bar = clean[idx]!;
    const label: SwingLabel =
      !state.lastSwingHigh || bar.high >= state.lastSwingHigh.price ? "HH" : "LH";
    const sp: SwingPoint = {
      kind: "high",
      label,
      price: bar.high,
      time: bar.time,
      barIndex: idx,
      confirmedTime,
    };
    swings.push(sp);
    state.lastSwingHigh = sp;
    state.activeHigh = sp;
    state.activeHighBroken = false;
  };

  const emitSwingLow = (idx: number, confirmedTime: number) => {
    const bar = clean[idx]!;
    const label: SwingLabel =
      !state.lastSwingLow || bar.low >= state.lastSwingLow.price ? "HL" : "LL";
    const sp: SwingPoint = {
      kind: "low",
      label,
      price: bar.low,
      time: bar.time,
      barIndex: idx,
      confirmedTime,
    };
    swings.push(sp);
    state.lastSwingLow = sp;
    state.activeLow = sp;
    state.activeLowBroken = false;
  };

  for (let barIdx = 0; barIdx < clean.length; barIdx++) {
    const c = clean[barIdx]!;

    // 1. Causal pivot confirmation at p = barIdx - swingLength (uses only bars <= barIdx)
    const p = barIdx - swingLength;
    if (p >= swingLength) {
      const pivot = clean[p]!;
      let isPivotHigh = true;
      let isPivotLow = true;

      for (let j = p - swingLength; j < p; j++) {
        if (clean[j]!.high >= pivot.high) isPivotHigh = false;
        if (clean[j]!.low <= pivot.low) isPivotLow = false;
        if (!isPivotHigh && !isPivotLow) break;
      }
      if (isPivotHigh || isPivotLow) {
        for (let j = p + 1; j <= p + swingLength; j++) {
          if (clean[j]!.high > pivot.high) isPivotHigh = false;
          if (clean[j]!.low < pivot.low) isPivotLow = false;
          if (!isPivotHigh && !isPivotLow) break;
        }
      }

      if (isPivotHigh && isPivotLow) {
        const lastKind = swings[swings.length - 1]?.kind;
        if (lastKind === "high") {
          emitSwingLow(p, c.time);
          emitSwingHigh(p, c.time);
        } else {
          emitSwingHigh(p, c.time);
          emitSwingLow(p, c.time);
        }
      } else if (isPivotHigh) {
        const prev = swings[swings.length - 1];
        if (prev && prev.kind === "high") {
          // Enforce strict High -> Low -> High alternation using only already-elapsed bars
          const scanStart = p > prev.barIndex + 1 ? prev.barIndex + 1 : prev.barIndex;
          const scanEnd = p > prev.barIndex + 1 ? p - 1 : p;
          let minIdx = scanStart;
          for (let j = scanStart + 1; j <= scanEnd; j++) {
            if (clean[j]!.low < clean[minIdx]!.low) minIdx = j;
          }
          emitSwingLow(minIdx, c.time);
        }
        emitSwingHigh(p, c.time);
      } else if (isPivotLow) {
        const prev = swings[swings.length - 1];
        if (prev && prev.kind === "low") {
          // Enforce strict Low -> High -> Low alternation using only already-elapsed bars
          const scanStart = p > prev.barIndex + 1 ? prev.barIndex + 1 : prev.barIndex;
          const scanEnd = p > prev.barIndex + 1 ? p - 1 : p;
          let maxIdx = scanStart;
          for (let j = scanStart + 1; j <= scanEnd; j++) {
            if (clean[j]!.high > clean[maxIdx]!.high) maxIdx = j;
          }
          emitSwingHigh(maxIdx, c.time);
        }
        emitSwingLow(p, c.time);
      }
    }

    // 2. Track FVG mitigation on current bar before emitting new FVG
    for (const fvg of fvgs) {
      if (fvg.mitigated) continue;
      if (fvg.direction === "bullish" && c.low <= fvg.bottom) {
        fvg.mitigated = true;
        fvg.mitigatedTime = c.time;
      } else if (fvg.direction === "bearish" && c.high >= fvg.top) {
        fvg.mitigated = true;
        fvg.mitigatedTime = c.time;
      }
    }

    // 3. Detect 3-bar Fair Value Gap ending on barIdx
    if (barIdx >= 2) {
      const b0 = clean[barIdx - 2]!;
      const b2 = c;
      if (b2.low > b0.high) {
        fvgs.push({
          direction: "bullish",
          top: b2.low,
          bottom: b0.high,
          startTime: b0.time,
          endTime: b2.time,
          mitigated: false,
        });
      } else if (b2.high < b0.low) {
        fvgs.push({
          direction: "bearish",
          top: b0.low,
          bottom: b2.high,
          startTime: b0.time,
          endTime: b2.time,
          mitigated: false,
        });
      }
    }

    // 4. Causal BOS / CHoCH break on close (anchored to first closing breakout candle)
    if (state.activeHigh && !state.activeHighBroken) {
      let firstBreakIdx = -1;
      for (let k = state.activeHigh.barIndex + 1; k <= barIdx; k++) {
        if (clean[k]!.close > state.activeHigh.price) {
          firstBreakIdx = k;
          break;
        }
      }
      if (firstBreakIdx !== -1) {
        state.activeHighBroken = true;
        if (firstBreakIdx > state.lastBullBreakBarIdx) {
          const kind: "BOS" | "CHoCH" = trend === "bearish" ? "CHoCH" : "BOS";
          breaks.push({
            kind,
            direction: "bullish",
            price: state.activeHigh.price,
            fromTime: state.activeHigh.time,
            toTime: clean[firstBreakIdx]!.time,
            confirmedBarIndex: barIdx,
          });
          trend = "bullish";
          state.lastBullBreakBarIdx = firstBreakIdx;
        }
      }
    }

    if (state.activeLow && !state.activeLowBroken) {
      let firstBreakIdx = -1;
      for (let k = state.activeLow.barIndex + 1; k <= barIdx; k++) {
        if (clean[k]!.close < state.activeLow.price) {
          firstBreakIdx = k;
          break;
        }
      }
      if (firstBreakIdx !== -1) {
        state.activeLowBroken = true;
        if (firstBreakIdx > state.lastBearBreakBarIdx) {
          const kind: "BOS" | "CHoCH" = trend === "bullish" ? "CHoCH" : "BOS";
          breaks.push({
            kind,
            direction: "bearish",
            price: state.activeLow.price,
            fromTime: state.activeLow.time,
            toTime: clean[firstBreakIdx]!.time,
            confirmedBarIndex: barIdx,
          });
          trend = "bearish";
          state.lastBearBreakBarIdx = firstBreakIdx;
        }
      }
    }
  }

  return {
    trend,
    swings,
    breaks,
    fvgs,
    lastSwingHigh: state.lastSwingHigh,
    lastSwingLow: state.lastSwingLow,
  };
}

// ── Indicator Registry (for UI) ──────────────────────────────
export type IndicatorType =
  | "SMA"
  | "EMA"
  | "RSI"
  | "MACD"
  | "BOLL"
  | "ATR"
  | "STOCH"
  | "VWAP"
  | "VPVR"
  | "SMC";

export type IndicatorPane = "overlay" | "below";

export interface IndicatorConfig {
  type: IndicatorType;
  label: string;
  pane: IndicatorPane;
  defaultParams: Record<string, number>;
  color: string;
}

export const INDICATOR_REGISTRY: IndicatorConfig[] = [
  {
    type: "EMA",
    label: "EMA 50",
    pane: "overlay",
    defaultParams: { period: 50 },
    color: "#2962ff",
  },
  {
    type: "RSI",
    label: "RSI 14",
    pane: "below",
    defaultParams: { period: 14 },
    color: "#ab47bc",
  },
  {
    type: "MACD",
    label: "MACD 12, 26, 9",
    pane: "below",
    defaultParams: { fast: 12, slow: 26, signal: 9 },
    color: "#2962ff",
  },
  {
    type: "SMA",
    label: "SMA 20",
    pane: "overlay",
    defaultParams: { period: 20 },
    color: "#f0b90b",
  },
  {
    type: "BOLL",
    label: "Bollinger Bands (20, 2)",
    pane: "overlay",
    defaultParams: { period: 20, stdDev: 2 },
    color: "#26a69a",
  },
  {
    type: "VWAP",
    label: "VWAP",
    pane: "overlay",
    defaultParams: { mult1: 1, mult2: 2, mult3: 3 },
    color: "#facc15",
  },
  {
    type: "VPVR",
    label: "Perfil de Volumen (VPVR)",
    pane: "overlay",
    defaultParams: { rows: 36, valueAreaPct: 70, widthPct: 22 },
    color: "#f59e0b",
  },
  {
    type: "SMC",
    label: "Estructura de Mercado (SMC)",
    pane: "overlay",
    defaultParams: { swingLength: 5, maxFvgs: 8 },
    color: "#10b981",
  },
  {
    type: "ATR",
    label: "ATR 14",
    pane: "overlay",
    defaultParams: { period: 14 },
    color: "#ff7043",
  },
  {
    type: "STOCH",
    label: "Stochastic RSI (14, 14, 3, 3)",
    pane: "below",
    defaultParams: { rsiPeriod: 14, stochPeriod: 14, kSmooth: 3, dSmooth: 3 },
    color: "#2962ff",
  },
];
