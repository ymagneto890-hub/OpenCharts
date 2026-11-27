import { Clock, RefreshCw, TrendingDown, TrendingUp, Minus, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useIndicatorSettings } from "../../hooks/useIndicatorSettings.ts";
import {
  type CandleData,
  computeMarketStructure,
  ema,
  macd,
  rsi,
} from "../../lib/indicators.ts";
import { cn } from "../../lib/utils.ts";
import { fetchHistoryAsync, getHistory } from "../../services/demo/candles.ts";
import { getReplaySliceForTimeframe, useReplayStore } from "../../services/demo/replay.ts";
import type { Timeframe } from "./constants.ts";

export const MTF_TIMEFRAMES: readonly Timeframe[] = ["5m", "15m", "1h", "4h", "1d"];

interface TfSnapshot {
  tf: Timeframe;
  emaTrend: "bullish" | "bearish" | "neutral";
  emaDistPct: number | null;
  smcTrend: "bullish" | "bearish" | "neutral";
  rsiVal: number | null;
  macdBias: "bullish" | "bearish" | "neutral";
  overall: "bullish" | "bearish" | "neutral";
}

function analyzeBars(
  tf: Timeframe,
  bars: CandleData[],
  swingLength: number,
): TfSnapshot {
  if (!bars || bars.length < 10) {
    return {
      tf,
      emaTrend: "neutral",
      emaDistPct: null,
      smcTrend: "neutral",
      rsiVal: null,
      macdBias: "neutral",
      overall: "neutral",
    };
  }

  const lastClose = bars[bars.length - 1]!.close;
  const emaPts = ema(bars, 50);
  const lastEma = emaPts.length > 0 ? emaPts[emaPts.length - 1]!.value : null;
  let emaTrend: "bullish" | "bearish" | "neutral" = "neutral";
  let emaDistPct: number | null = null;
  if (lastEma && lastEma > 0) {
    emaDistPct = ((lastClose - lastEma) / lastEma) * 100;
    emaTrend = lastClose >= lastEma ? "bullish" : "bearish";
  }

  const smc = computeMarketStructure(bars, { swingLength });
  const smcTrend = smc.trend === "bullish" ? "bullish" : smc.trend === "bearish" ? "bearish" : "neutral";

  const rsiPts = rsi(bars, 14);
  const rsiVal = rsiPts.length > 0 ? rsiPts[rsiPts.length - 1]!.value : null;

  const macdRes = macd(bars, 12, 26, 9);
  const lastHist =
    macdRes.histogram.length > 0 ? macdRes.histogram[macdRes.histogram.length - 1]!.value : null;
  const macdBias: "bullish" | "bearish" | "neutral" =
    lastHist == null ? "neutral" : lastHist >= 0 ? "bullish" : "bearish";

  const score =
    (emaTrend === "bullish" ? 1 : emaTrend === "bearish" ? -1 : 0) +
    (smcTrend === "bullish" ? 1 : smcTrend === "bearish" ? -1 : 0) +
    (macdBias === "bullish" ? 1 : macdBias === "bearish" ? -1 : 0);

  const overall = score >= 1 ? "bullish" : score <= -1 ? "bearish" : "neutral";

  return {
    tf,
    emaTrend,
    emaDistPct,
    smcTrend,
    rsiVal,
    macdBias,
    overall,
  };
}

export interface MultiTimeframePanelProps {
  symbol: string;
  currentTimeframe: Timeframe;
  onSelectTimeframe: (tf: Timeframe) => void;
  onClose: () => void;
}

export function MultiTimeframePanel({
  symbol,
  currentTimeframe,
  onSelectTimeframe,
  onClose,
}: MultiTimeframePanelProps) {
  const indicatorSettings = useIndicatorSettings();
  const [refreshTick, setRefreshTick] = useState(0);
  const [loading, setLoading] = useState(false);

  const [barsByTf, setBarsByTf] = useState<Partial<Record<Timeframe, CandleData[]>>>(() => {
    const initial: Partial<Record<Timeframe, CandleData[]>> = {};
    for (const tf of MTF_TIMEFRAMES) {
      initial[tf] = getHistory(symbol, tf, 300);
    }
    return initial;
  });

  const loadAllTimeframes = useCallback(async () => {
    setLoading(true);
    try {
      const entries = await Promise.all(
        MTF_TIMEFRAMES.map(async (tf) => {
          const bars = await fetchHistoryAsync(symbol, tf, 300);
          return [tf, bars] as const;
        }),
      );
      const next: Partial<Record<Timeframe, CandleData[]>> = {};
      for (const [tf, bars] of entries) {
        next[tf] = bars;
      }
      setBarsByTf(next);
    } finally {
      setLoading(false);
    }
  }, [symbol]);

  useEffect(() => {
    const syncInitial: Partial<Record<Timeframe, CandleData[]>> = {};
    for (const tf of MTF_TIMEFRAMES) {
      syncInitial[tf] = getHistory(symbol, tf, 300);
    }
    setBarsByTf(syncInitial);

    let cancelled = false;
    void Promise.all(
      MTF_TIMEFRAMES.map(async (tf) => {
        const bars = await fetchHistoryAsync(symbol, tf, 300);
        return [tf, bars] as const;
      }),
    ).then((entries) => {
      if (cancelled) return;
      const next: Partial<Record<Timeframe, CandleData[]>> = {};
      for (const [tf, bars] of entries) next[tf] = bars;
      setBarsByTf(next);
    });

    const id = setInterval(() => {
      void loadAllTimeframes();
    }, 15_000);

    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [symbol, refreshTick, loadAllTimeframes]);

  const replayPhase = useReplayStore((s) => s.phase);
  const replaySymbol = useReplayStore((s) => s.symbol);
  const replaySimTimeSec = useReplayStore((s) => s.simTimeSec);
  const isSymbolReplaying =
    (replayPhase === "active" || replayPhase === "picking") &&
    replaySymbol === symbol &&
    replaySimTimeSec > 0;

  const snapshots = useMemo(
    () =>
      MTF_TIMEFRAMES.map((tf) => {
        const sourceBars = isSymbolReplaying
          ? getReplaySliceForTimeframe(symbol, tf, replaySimTimeSec)
          : (barsByTf[tf] ?? []);
        return analyzeBars(tf, sourceBars, indicatorSettings.smc.swingLength);
      }),
    [barsByTf, indicatorSettings.smc.swingLength, isSymbolReplaying, symbol, replaySimTimeSec],
  );

  const summary = useMemo(() => {
    const bull = snapshots.filter((s) => s.overall === "bullish").length;
    const bear = snapshots.filter((s) => s.overall === "bearish").length;
    if (bull > bear && bull >= 3) {
      return { label: `Alcista ${bull}/${snapshots.length}`, tone: "bull" as const };
    }
    if (bear > bull && bear >= 3) {
      return { label: `Bajista ${bear}/${snapshots.length}`, tone: "bear" as const };
    }
    return { label: `Mixto (${bull}↑ / ${bear}↓)`, tone: "neutral" as const };
  }, [snapshots]);

  return (
    <div className="border-b border-border bg-card/95 px-3 py-1.5 shrink-0">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        {/* Left header & MTF summary */}
        <div className="flex items-center gap-2 shrink-0">
          <div className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
            <Clock className="h-3.5 w-3.5 text-primary" />
            <span>Panel MTF</span>
            <span className="text-[11px] font-mono text-muted-foreground">({symbol})</span>
          </div>
          <span
            className={cn(
              "px-2 py-0.5 rounded text-[11px] font-mono font-bold",
              summary.tone === "bull" && "bg-[#00E676]/15 text-[#00E676]",
              summary.tone === "bear" && "bg-[#FF3B56]/15 text-[#FF3B56]",
              summary.tone === "neutral" && "bg-secondary text-muted-foreground",
            )}
          >
            Sesgo MTF: {summary.label}
          </span>
        </div>

        {/* Timeframe summary cards */}
        <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar flex-1 min-w-0 py-0.5">
          {snapshots.map((snap) => {
            const isCurrent = snap.tf === currentTimeframe;
            const rsiState =
              snap.rsiVal == null
                ? "--"
                : snap.rsiVal >= 70
                  ? `${snap.rsiVal.toFixed(0)} SC`
                  : snap.rsiVal <= 30
                    ? `${snap.rsiVal.toFixed(0)} SV`
                    : snap.rsiVal.toFixed(0);
            return (
              <button
                key={snap.tf}
                type="button"
                onClick={() => onSelectTimeframe(snap.tf)}
                title={`Cambiar gráfico principal a ${snap.tf}`}
                className={cn(
                  "flex items-center gap-2 px-2.5 py-1 rounded-md border text-[11px] transition-colors shrink-0",
                  isCurrent
                    ? "border-primary bg-primary/10 shadow-sm"
                    : "border-border/70 bg-secondary/40 hover:bg-secondary",
                )}
              >
                <span className="font-mono font-bold text-foreground uppercase">{snap.tf}</span>

                {/* EMA Trend */}
                <span
                  className={cn(
                    "inline-flex items-center gap-0.5 font-semibold",
                    snap.emaTrend === "bullish"
                      ? "text-[#00E676]"
                      : snap.emaTrend === "bearish"
                        ? "text-[#FF3B56]"
                        : "text-muted-foreground",
                  )}
                  title={
                    snap.emaDistPct != null
                      ? `EMA 50: ${snap.emaDistPct >= 0 ? "+" : ""}${snap.emaDistPct.toFixed(2)}%`
                      : "EMA 50"
                  }
                >
                  {snap.emaTrend === "bullish" ? (
                    <TrendingUp className="h-3 w-3" />
                  ) : snap.emaTrend === "bearish" ? (
                    <TrendingDown className="h-3 w-3" />
                  ) : (
                    <Minus className="h-3 w-3" />
                  )}
                  <span>EMA</span>
                </span>

                {/* SMC Structure */}
                <span
                  className={cn(
                    "px-1 rounded text-[10px] font-mono font-semibold",
                    snap.smcTrend === "bullish"
                      ? "bg-[#00E676]/15 text-[#00E676]"
                      : snap.smcTrend === "bearish"
                        ? "bg-[#FF3B56]/15 text-[#FF3B56]"
                        : "bg-secondary text-muted-foreground",
                  )}
                  title="Estructura de Mercado (SMC)"
                >
                  {snap.smcTrend === "bullish"
                    ? "SMC↑"
                    : snap.smcTrend === "bearish"
                      ? "SMC↓"
                      : "SMC–"}
                </span>

                {/* RSI 14 */}
                <span
                  className={cn(
                    "font-mono tabular-nums",
                    snap.rsiVal != null && snap.rsiVal >= 70
                      ? "text-[#FF3B56] font-bold"
                      : snap.rsiVal != null && snap.rsiVal <= 30
                        ? "text-[#00E676] font-bold"
                        : "text-muted-foreground",
                  )}
                  title="RSI (14)"
                >
                  RSI {rsiState}
                </span>

                {/* MACD bias */}
                <span
                  className={cn(
                    "font-mono text-[10px] font-semibold",
                    snap.macdBias === "bullish"
                      ? "text-[#00E676]"
                      : snap.macdBias === "bearish"
                        ? "text-[#FF3B56]"
                        : "text-muted-foreground",
                  )}
                  title="Sesgo MACD"
                >
                  MACD {snap.macdBias === "bullish" ? "▲" : snap.macdBias === "bearish" ? "▼" : "·"}
                </span>
              </button>
            );
          })}
        </div>

        {/* Right actions */}
        <div className="flex items-center gap-1 shrink-0">
          <button
            type="button"
            onClick={() => setRefreshTick((t) => t + 1)}
            title="Actualizar análisis MTF"
            className="p-1 rounded hover:bg-secondary text-muted-foreground hover:text-foreground"
          >
            <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin text-primary")} />
          </button>
          <button
            type="button"
            onClick={onClose}
            title="Cerrar panel MTF"
            className="p-1 rounded hover:bg-secondary text-muted-foreground hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}
