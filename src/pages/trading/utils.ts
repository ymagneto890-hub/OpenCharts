import type { CandlestickData, HistogramData, LineData, Time } from "lightweight-charts";
import type { CandleData } from "../../lib/indicators.ts";
import { getBucketStartSec } from "../../lib/timeframes.ts";
import { getDemoSymbol } from "../../services/demo/instruments.ts";
import { KNOWN_CURRENCIES } from "./constants.ts";
import type { Timeframe } from "./constants.ts";

function tickSizeToDigits(tickSize: number | string): number | null {
  const n = Number(tickSize);
  if (Number.isFinite(n) && n > 0) {
    if (n < 1) {
      const s = n.toExponential();
      if (s.includes("e-")) {
        const [mantissa = "1", expStr = "2"] = s.split("e-");
        const exp = parseInt(expStr, 10);
        const frac = mantissa.includes(".") ? mantissa.split(".")[1]!.length : 0;
        return Math.min(8, Math.max(exp + frac, 2));
      }
      const decimals = Math.max(0, Math.round(-Math.log10(n)));
      return Math.min(8, Math.max(decimals, 2));
    }
    return 2;
  }
  const str = String(tickSize);
  if (str.includes(".")) {
    const dec = str.split(".")[1]!.replace(/0+$/, "").length || str.split(".")[1]!.length;
    return Math.min(8, Math.max(dec, 2));
  }
  return null;
}

/** Derive pip (decimal) precision from symbolInfo.tickSize or symbol name */
export function getPipDigits(
  first?: { tickSize?: number | string } | string | null,
  second?: { tickSize?: number | string } | string | null,
): number {
  const symbolInfo =
    typeof first === "object" && first !== null
      ? first
      : typeof second === "object" && second !== null
        ? second
        : undefined;
  const symbolName =
    typeof first === "string" ? first : typeof second === "string" ? second : undefined;

  if (symbolInfo?.tickSize) {
    const d = tickSizeToDigits(symbolInfo.tickSize);
    if (d !== null) return d;
  }
  return _symbolNameDecimals(symbolName);
}

function _symbolNameDecimals(symbolName?: string): number {
  if (!symbolName) return 2;
  const meta = getDemoSymbol(symbolName);
  if (meta) {
    if (typeof meta.precision === "number") return meta.precision;
    const d = tickSizeToDigits(meta.tickSize);
    if (d !== null) return d;
  }
  const n = symbolName.toUpperCase();
  if (n.includes("SHIB") || n.includes("PEPE") || n.includes("BONK") || n.includes("FLOKI")) return 8;
  if (n.includes("DOGE") || n.includes("VET") || n.includes("GALA")) return 5;
  if (n.includes("XRP") || n.includes("ADA") || n.includes("SUI") || n.includes("ARB")) return 4;
  if (n.includes("DOT") || n.includes("LINK") || n.includes("NEAR") || n.includes("USDJPY")) return 3;
  if (n.includes("JPY") || n.includes("XAU") || n.includes("GOLD")) return 2;
  if (
    n.includes("EURUSD") ||
    n.includes("EURGBP") ||
    n.includes("EURCHF") ||
    n.includes("EURAUD") ||
    n.includes("EURCAD") ||
    n.includes("EURNZD") ||
    n.includes("GBPUSD") ||
    n.includes("AUDUSD") ||
    n.includes("USDCAD")
  )
    return 4;
  return 2;
}

/** Get the minMove for lightweight-charts priceFormat from pip digits */
export function getMinMove(pipDigits: number): number {
  return Number((1 / Math.pow(10, pipDigits)).toFixed(pipDigits + 1));
}

/** Parse timestamp to unix seconds */
export function toUnixSeconds(ts: number | string | Date): number {
  if (typeof ts === "number") return ts > 1e12 ? Math.floor(ts / 1000) : ts;
  return Math.floor(new Date(ts).getTime() / 1000);
}

/** Normalise a numeric timestamp to unix milliseconds (accepts seconds or ms) */
export function toUnixMs(ts: number): number {
  return ts > 1e12 ? ts : ts * 1000;
}

export type ChartCandle = CandlestickData<Time> & { volume?: number };

/** Convert candles for indicator lib */
export function toIndicatorCandles(candles: ChartCandle[]): CandleData[] {
  return candles.map((c) => ({
    time: c.time as number,
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    volume: c.volume ?? 0,
  }));
}

/** Format seconds remaining as M:SS or H:MM:SS */
export function formatCountdown(totalSec: number): string {
  if (totalSec <= 0) return "0:00";
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = Math.floor(totalSec % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** Extract currency codes from a symbol name */
export function extractCurrencies(symbol: string): string[] {
  const upper = symbol.toUpperCase().replace(/[^A-Z]/g, "");
  const found: string[] = [];
  for (const c of KNOWN_CURRENCIES) {
    if (upper.includes(c)) found.push(c);
  }
  if (found.length === 0 && upper.length >= 6) {
    found.push(upper.slice(0, 3), upper.slice(3, 6));
  }
  return [...new Set(found)];
}

/** Return the candle-bucket start (unix seconds) for a given timestamp */
export function getCandleBucketTime(timestampMs: number, tf: Timeframe): number {
  return getBucketStartSec(timestampMs, tf);
}

export function calculateVolumeMa(
  volumeData: HistogramData<Time>[],
  period = 20,
): LineData<Time>[] {
  const out: LineData<Time>[] = [];
  const p = Math.floor(period);
  if (!Number.isFinite(period) || p <= 0 || volumeData.length < p) return out;
  let sum = 0;
  for (let i = 0; i < volumeData.length; i++) {
    sum += volumeData[i]!.value;
    if (i >= p) {
      sum -= volumeData[i - p]!.value;
    }
    if (i >= p - 1) {
      out.push({
        time: volumeData[i]!.time,
        value: Number((sum / p).toFixed(2)),
      });
    }
  }
  return out;
}


