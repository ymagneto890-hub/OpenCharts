import { useEffect, useRef } from "react";
import type { IChartApi, ISeriesApi, Time } from "lightweight-charts";
import { LineStyle } from "lightweight-charts";
import {
  balancedDivergenceOptions,
  sma,
  ema,
  rsi,
  macd,
  MACD_BALANCED_DEFAULTS,
  bollingerBands,
  stochasticRsi,
  defaultVwapAnchorForTimeframe,
  computeFineGrainedSessionVwap,
  detectDivergences,
  computeMarketStructure,
  INDICATOR_REGISTRY,
  type CandleData,
  type IndicatorType,
  type VwapSessionSeed,
  type VwapSessionTimeZone,
  RSI_BALANCED_DEFAULTS,
} from "../../lib/indicators.ts";
import {
  DEFAULT_INDICATOR_SETTINGS,
  type IndicatorSettings,
  type VwapBandLineStyle,
} from "../../hooks/useIndicatorSettings.ts";
import { OscillatorPanePrimitive } from "../../lib/chart-plugins/oscillator-pane-primitive.ts";
import { MarketStructurePrimitive } from "../../lib/chart-plugins/market-structure-primitive.ts";
import { VolumeProfilePrimitive } from "../../lib/chart-plugins/volume-profile-primitive.ts";
import { parseTimeframeSeconds } from "../../lib/timeframes.ts";
import { getMinMove, toIndicatorCandles, type ChartCandle } from "./utils.ts";
import { CHART_COLORS, type Timeframe } from "./constants.ts";

/** Preferred ordering for bottom sub-panels: RSI higher up, MACD at the very bottom */
const BELOW_INDICATOR_ORDER: Record<string, number> = {
  RSI: 10,
  STOCH: 30,
  MACD: 40,
};

export function getMacdPrecision(pipDigits: number): number {
  return Math.max(2, pipDigits);
}

export function formatMacdValue(val: number, pipDigits: number): string {
  const digits = getMacdPrecision(pipDigits);
  return val.toFixed(digits);
}

export function vwapBandLineStyleToChart(style: VwapBandLineStyle): LineStyle {
  if (style === "solid") return LineStyle.Solid;
  if (style === "dotted") return LineStyle.Dotted;
  return LineStyle.Dashed;
}

const DEFAULT_EXCLUDE: IndicatorType[] = [];

export function useIndicators(
  chartRef: React.RefObject<IChartApi | null>,
  candleSeriesRef: React.RefObject<ISeriesApi<"Candlestick"> | null>,
  chartData: ChartCandle[],
  activeIndicators: IndicatorType[],
  isDark: boolean,
  separatePanes = true,
  chartEpoch = 0,
  pipDigits = 2,
  excludeTypes: IndicatorType[] = DEFAULT_EXCLUDE,
  timeframe: Timeframe = "4h",
  indicatorSettings: IndicatorSettings = DEFAULT_INDICATOR_SETTINGS,
  vwapSessionTimeZone: VwapSessionTimeZone = "utc",
  suppressRightAutoscale = false,
  priorVwapSeed: VwapSessionSeed | null = null,
  vwapAnchorAtRegularOpen = false,
  fine1mVwapCandles: CandleData[] | null = null,
): void {
  const indicatorSeriesRef = useRef<Map<string, ISeriesApi<"Line"> | ISeriesApi<"Histogram">>>(
    new Map(),
  );
  const structureKeyRef = useRef<string>("");
  const vpvrPrimRef = useRef<{
    series: ISeriesApi<"Candlestick">;
    prim: VolumeProfilePrimitive;
  } | null>(null);
  const smcPrimRef = useRef<{
    series: ISeriesApi<"Candlestick">;
    prim: MarketStructurePrimitive;
  } | null>(null);
  const colors = isDark ? CHART_COLORS.dark : CHART_COLORS.light;

  const detachOverlayPrimitives = () => {
    if (vpvrPrimRef.current) {
      try {
        vpvrPrimRef.current.series.detachPrimitive(vpvrPrimRef.current.prim);
      } catch {
        /* chart already disposed */
      }
      vpvrPrimRef.current = null;
    }
    if (smcPrimRef.current) {
      try {
        smcPrimRef.current.series.detachPrimitive(smcPrimRef.current.prim);
      } catch {
        /* chart already disposed */
      }
      smcPrimRef.current = null;
    }
  };

  useEffect(() => {
    return () => {
      detachOverlayPrimitives();
    };
  }, []);

  useEffect(() => {
    if (!chartRef.current || !candleSeriesRef.current || chartData.length === 0) {
      if (chartRef.current && indicatorSeriesRef.current.size > 0) {
        for (const series of indicatorSeriesRef.current.values()) {
          try {
            chartRef.current.removeSeries(series);
          } catch {
            /* chart already disposed */
          }
        }
        indicatorSeriesRef.current.clear();
      }
      structureKeyRef.current = "";
      detachOverlayPrimitives();
      return;
    }

    const overlayPriceFormat = {
      type: "price" as const,
      precision: pipDigits,
      minMove: getMinMove(pipDigits),
    };

    const chart = chartRef.current;
    const candleSeries = candleSeriesRef.current;
    const indCandles = toIndicatorCandles(chartData);
    const effectiveIndicators =
      excludeTypes.length > 0
        ? activeIndicators.filter((t) => !excludeTypes.includes(t))
        : activeIndicators;

    // Identify active below indicators on this chart
    const belowIndicators = effectiveIndicators.filter(
      (type) => INDICATOR_REGISTRY.find((r) => r.type === type)?.pane === "below",
    );

    const nextStructureKey = [
      effectiveIndicators.join(","),
      isDark ? "1" : "0",
      separatePanes ? "1" : "0",
      String(chartEpoch),
      String(pipDigits),
      timeframe,
      JSON.stringify(indicatorSettings),
      vwapSessionTimeZone,
      suppressRightAutoscale ? "1" : "0",
      vwapAnchorAtRegularOpen ? "rth930" : "sess",
    ].join("|");
    const canReuseOverlaySeries =
      belowIndicators.length === 0 && structureKeyRef.current === nextStructureKey;

    if (!canReuseOverlaySeries) {
      // Remove old indicator series safely when indicator set, settings, or layout changed
      for (const [_key, series] of indicatorSeriesRef.current) {
        try {
          chart.removeSeries(series);
        } catch {
          /* already removed when chart was recreated */
        }
      }
      indicatorSeriesRef.current.clear();
      structureKeyRef.current = nextStructureKey;
    }

    const upsertOverlayLine = (
      key: string,
      opts: Parameters<IChartApi["addLineSeries"]>[0],
      pts: ReadonlyArray<{ time: number; value: number }>,
    ) => {
      const existing = canReuseOverlaySeries
        ? (indicatorSeriesRef.current.get(key) as ISeriesApi<"Line"> | undefined)
        : undefined;
      const s = existing ?? chart.addLineSeries(opts);
      s.setData(pts.map((p) => ({ time: p.time as Time, value: p.value })));
      if (!existing) indicatorSeriesRef.current.set(key, s);
    };

    // Sort according to preferred order: RSI on top (closest to candles), MACD at the bottom
    const sortedBelow = [...belowIndicators].sort(
      (a, b) => (BELOW_INDICATOR_ORDER[a] ?? 50) - (BELOW_INDICATOR_ORDER[b] ?? 50),
    );

    const count = sortedBelow.length;
    const slotByType = new Map<IndicatorType, { top: number; bottom: number }>();
    const scaleMarginsByType = new Map<IndicatorType, { top: number; bottom: number }>();

    if (count === 0 || !separatePanes) {
      if (!suppressRightAutoscale) {
        chart.priceScale("right").applyOptions({
          scaleMargins: { top: 0.06, bottom: 0.16 },
        });
      }
      try {
        chart.priceScale("").applyOptions({
          scaleMargins: { top: 0.85, bottom: 0 },
        });
      } catch {
        /* volume scale not ready */
      }
      if (!separatePanes) {
        for (const indType of sortedBelow) {
          slotByType.set(indType, { top: 0.1, bottom: 0.9 });
          scaleMarginsByType.set(indType, { top: 0.1, bottom: 0.1 });
        }
      }
    } else {
      // Reserve clean vertical slices for each lower sub-panel (RSI 14 and MACD 12, 26, 9)
      const totalBottomReservation = count === 1 ? 0.28 : count === 2 ? 0.46 : 0.56;
      const Y_START = 1.0 - totalBottomReservation;
      const Y_END = 0.985;
      const availableHeight = Y_END - Y_START;
      const gap = count > 1 ? 0.025 : 0;
      const totalGaps = (count - 1) * gap;
      const slotHeight = (availableHeight - totalGaps) / count;

      // Candlestick area sits strictly above the oscillator panels
      const candleBottomMargin = totalBottomReservation + 0.025;
      chart.priceScale("right").applyOptions({
        scaleMargins: { top: 0.04, bottom: candleBottomMargin },
      });

      // Volume histogram sits inside the bottom 10% of the candlestick area
      try {
        chart.priceScale("").applyOptions({
          scaleMargins: {
            top: Math.max(0.08, Y_START - 0.11),
            bottom: candleBottomMargin,
          },
        });
      } catch {
        /* volume scale not ready */
      }

      sortedBelow.forEach((indType, i) => {
        const slotTopY = Y_START + i * (slotHeight + gap);
        const slotBottomY = slotTopY + slotHeight;
        // Leave room at the top of each sub-panel for its title header & divergence pills
        const scaleMarginTop = slotTopY + 0.028;
        const scaleMarginBottom = Math.max(0.015, 1.0 - slotBottomY + 0.012);

        slotByType.set(indType, { top: slotTopY, bottom: slotBottomY });
        scaleMarginsByType.set(indType, { top: scaleMarginTop, bottom: scaleMarginBottom });
      });
    }

    const applyBelowScaleOptions = (
      indType: IndicatorType,
      series: ISeriesApi<"Line"> | ISeriesApi<"Histogram">,
    ) => {
      const margins = scaleMarginsByType.get(indType) ?? { top: 0.72, bottom: 0.02 };
      series.priceScale().applyOptions({
        autoScale: true,
        scaleMargins: margins,
        borderColor: colors.grid,
        borderVisible: true,
      });
    };

    // Instantiate all active indicator series
    for (const type of effectiveIndicators) {
      const config = INDICATOR_REGISTRY.find((r) => r.type === type);
      if (!config) continue;

      switch (type) {
        case "SMA": {
          const period = config.defaultParams.period ?? 20;
          const data = sma(indCandles, period);
          upsertOverlayLine(
            "SMA",
            {
              color: config.color,
              lineWidth: 2,
              priceScaleId: "right",
              priceLineVisible: false,
              priceFormat: overlayPriceFormat,
              ...(suppressRightAutoscale ? { autoscaleInfoProvider: () => null } : {}),
            },
            data,
          );
          break;
        }
        case "EMA": {
          const emaLines = (
            indicatorSettings.ema?.lines ?? DEFAULT_INDICATOR_SETTINGS.ema.lines
          ).filter((l) => l.enabled && l.period >= 1);
          for (const line of emaLines) {
            const data = ema(indCandles, line.period);
            upsertOverlayLine(
              `EMA:${line.id}:${line.period}`,
              {
                color: line.color,
                lineWidth: Math.min(4, Math.max(1, Math.round(line.lineWidth))) as 1 | 2 | 3 | 4,
                priceScaleId: "right",
                priceLineVisible: false,
                lastValueVisible: true,
                priceFormat: overlayPriceFormat,
                ...(suppressRightAutoscale ? { autoscaleInfoProvider: () => null } : {}),
              },
              data,
            );
          }
          break;
        }
        case "RSI": {
          const period = RSI_BALANCED_DEFAULTS.intraday;
          const data = rsi(indCandles, period);
          const lastVal = data.length > 0 ? data[data.length - 1]!.value : null;
          const slot = slotByType.get("RSI") ?? { top: 0.72, bottom: 0.98 };

          const s = chart.addLineSeries({
            color: "#BA68C8",
            lineWidth: 2,
            priceScaleId: "rsi",
            priceLineVisible: false,
            lastValueVisible: true,
            priceFormat: {
              type: "custom",
              formatter: (val: number) => val.toFixed(2),
            },
          });
          applyBelowScaleOptions("RSI", s);
          s.setData(data.map((p) => ({ time: p.time as Time, value: p.value })));

          const showDivergences = localStorage.getItem("oscShowDivergences") !== "false";
          const divergences =
            showDivergences && indCandles.length >= 15
              ? detectDivergences(
                  indCandles,
                  data,
                  {
                    ...balancedDivergenceOptions(timeframe, "rsi", "rsi", false, false, "wick"),
                    includeHidden: false,
                  },
                )
              : [];
          const primitive = new OscillatorPanePrimitive(
            {
              kind: "rsi",
              title: "RSI",
              subtitle: `${period} close`,
              headerValues:
                lastVal != null
                  ? [{ text: lastVal.toFixed(2), color: "#BA68C8" }]
                  : [],
              divergences,
              slotTopRatio: slot.top,
              slotBottomRatio: slot.bottom,
              isDark,
            },
            0,
            100,
          );
          s.attachPrimitive(primitive);
          indicatorSeriesRef.current.set("RSI", s);
          break;
        }
        case "MACD": {
          const fastP = MACD_BALANCED_DEFAULTS.fast;
          const slowP = MACD_BALANCED_DEFAULTS.slow;
          const sigP = MACD_BALANCED_DEFAULTS.signal;
          const data = macd(indCandles, fastP, slowP, sigP);
          const macdDigits = getMacdPrecision(pipDigits);
          const macdMinMove = Number((1 / Math.pow(10, macdDigits)).toFixed(macdDigits + 1));

          // 4-color High-Contrast MACD Histogram
          const histo = chart.addHistogramSeries({
            priceScaleId: "macd",
            priceLineVisible: false,
            lastValueVisible: true,
            priceFormat: {
              type: "custom",
              minMove: macdMinMove,
              formatter: (val: number) => formatMacdValue(val, pipDigits),
            },
          });
          applyBelowScaleOptions("MACD", histo);
          histo.setData(
            data.histogram.map((p, idx) => {
              const prev = idx > 0 ? data.histogram[idx - 1]!.value : p.value;
              const rising = p.value >= prev;
              const color =
                p.value >= 0
                  ? rising
                    ? "#00E676"
                    : "#A7F3D0"
                  : !rising
                    ? "#FF1744"
                    : "#FF8A80";
              return {
                time: p.time as Time,
                value: p.value,
                color,
              };
            }),
          );
          indicatorSeriesRef.current.set("MACD-hist", histo);

          const mLine = chart.addLineSeries({
            color: "#2979FF",
            lineWidth: 2,
            priceScaleId: "macd",
            priceLineVisible: false,
            lastValueVisible: true,
            priceFormat: {
              type: "custom",
              minMove: macdMinMove,
              formatter: (val: number) => formatMacdValue(val, pipDigits),
            },
          });
          mLine.setData(data.macd.map((p) => ({ time: p.time as Time, value: p.value })));
          indicatorSeriesRef.current.set("MACD-line", mLine);

          const sLine = chart.addLineSeries({
            color: "#FF6D00",
            lineWidth: 2,
            priceScaleId: "macd",
            priceLineVisible: false,
            lastValueVisible: true,
            priceFormat: {
              type: "custom",
              minMove: macdMinMove,
              formatter: (val: number) => formatMacdValue(val, pipDigits),
            },
          });
          sLine.setData(data.signal.map((p) => ({ time: p.time as Time, value: p.value })));
          indicatorSeriesRef.current.set("MACD-signal", sLine);

          let minMacd = 0;
          let maxMacd = 0;
          for (const p of data.macd) {
            if (p.value < minMacd) minMacd = p.value;
            if (p.value > maxMacd) maxMacd = p.value;
          }
          for (const p of data.signal) {
            if (p.value < minMacd) minMacd = p.value;
            if (p.value > maxMacd) maxMacd = p.value;
          }
          for (const p of data.histogram) {
            if (p.value < minMacd) minMacd = p.value;
            if (p.value > maxMacd) maxMacd = p.value;
          }

          const lastM = data.macd.length > 0 ? data.macd[data.macd.length - 1]!.value : null;
          const lastS = data.signal.length > 0 ? data.signal[data.signal.length - 1]!.value : null;
          const lastH =
            data.histogram.length > 0 ? data.histogram[data.histogram.length - 1]!.value : null;
          const slot = slotByType.get("MACD") ?? { top: 0.76, bottom: 0.985 };

          const headerValues = [];
          if (lastM != null) headerValues.push({ text: formatMacdValue(lastM, pipDigits), color: "#2979FF" });
          if (lastS != null) headerValues.push({ text: formatMacdValue(lastS, pipDigits), color: "#FF6D00" });
          if (lastH != null) {
            headerValues.push({
              text: formatMacdValue(lastH, pipDigits),
              color: lastH >= 0 ? "#00E676" : "#FF1744",
            });
          }

          const showDivergences = localStorage.getItem("oscShowDivergences") !== "false";
          const divergences =
            showDivergences && indCandles.length >= 15
              ? detectDivergences(
                  indCandles,
                  data.histogram,
                  {
                    ...balancedDivergenceOptions(timeframe, "macd", "histogram", true, false, "wick"),
                    includeHidden: false,
                  },
                )
              : [];
          const primitive = new OscillatorPanePrimitive(
            {
              kind: "macd",
              title: "MACD",
              subtitle: `${fastP} ${slowP} ${sigP} close`,
              headerValues,
              divergences,
              macdThresholds: data.thresholds,
              lastBarTime: indCandles.length > 0 ? (indCandles[indCandles.length - 1]!.time as number) : undefined,
              showMacdThresholds: localStorage.getItem("macdShowThresholds") !== "false",
              pricePrecision: pipDigits,
              slotTopRatio: slot.top,
              slotBottomRatio: slot.bottom,
              isDark,
            },
            minMacd,
            maxMacd,
          );
          mLine.attachPrimitive(primitive);
          break;
        }
        case "BOLL": {
          const data = bollingerBands(
            indCandles,
            config.defaultParams.period,
            config.defaultParams.stdDev,
          );
          upsertOverlayLine(
            "BOLL-upper",
            {
              color: config.color + "80",
              lineWidth: 1,
              priceScaleId: "right",
              priceLineVisible: false,
              priceFormat: overlayPriceFormat,
              ...(suppressRightAutoscale ? { autoscaleInfoProvider: () => null } : {}),
            },
            data.upper,
          );
          upsertOverlayLine(
            "BOLL-mid",
            {
              color: config.color,
              lineWidth: 1,
              priceScaleId: "right",
              priceLineVisible: false,
              priceFormat: overlayPriceFormat,
              ...(suppressRightAutoscale ? { autoscaleInfoProvider: () => null } : {}),
            },
            data.middle,
          );
          upsertOverlayLine(
            "BOLL-lower",
            {
              color: config.color + "80",
              lineWidth: 1,
              priceScaleId: "right",
              priceLineVisible: false,
              priceFormat: overlayPriceFormat,
              ...(suppressRightAutoscale ? { autoscaleInfoProvider: () => null } : {}),
            },
            data.lower,
          );
          break;
        }
        case "ATR": {
          // ATR (14) is displayed exclusivamente como etiqueta numérica en la gráfica de precio (sin curva que estorbe).
          break;
        }
        case "STOCH": {
          const data = stochasticRsi(
            indCandles,
            config.defaultParams.rsiPeriod,
            config.defaultParams.stochPeriod,
            config.defaultParams.kSmooth,
            config.defaultParams.dSmooth,
          );
          const kLine = chart.addLineSeries({
            color: "#2962FF",
            lineWidth: 2,
            priceScaleId: "stoch",
            priceLineVisible: false,
          });
          applyBelowScaleOptions("STOCH", kLine);
          kLine.setData(data.k.map((p) => ({ time: p.time as Time, value: p.value })));
          indicatorSeriesRef.current.set("STOCH-K", kLine);

          const dLine = chart.addLineSeries({
            color: "#FF6D00",
            lineWidth: 2,
            priceScaleId: "stoch",
            priceLineVisible: false,
          });
          dLine.setData(data.d.map((p) => ({ time: p.time as Time, value: p.value })));
          indicatorSeriesRef.current.set("STOCH-D", dLine);

          const refHigh = chart.addLineSeries({
            color: isDark ? "#555" : "#bbb",
            lineWidth: 1,
            lineStyle: LineStyle.Dashed,
            priceScaleId: "stoch",
            lastValueVisible: false,
            priceLineVisible: false,
          });
          refHigh.setData(data.k.map((p) => ({ time: p.time as Time, value: 80 })));
          indicatorSeriesRef.current.set("STOCH-80", refHigh);

          const refLow = chart.addLineSeries({
            color: isDark ? "#555" : "#bbb",
            lineWidth: 1,
            lineStyle: LineStyle.Dashed,
            priceScaleId: "stoch",
            lastValueVisible: false,
            priceLineVisible: false,
          });
          refLow.setData(data.k.map((p) => ({ time: p.time as Time, value: 20 })));
          indicatorSeriesRef.current.set("STOCH-20", refLow);
          break;
        }
        case "VWAP": {
          const vwapCfg = indicatorSettings.vwap ?? DEFAULT_INDICATOR_SETTINGS.vwap;
          const anchor =
            vwapCfg.anchor === "auto"
              ? defaultVwapAnchorForTimeframe(timeframe)
              : vwapCfg.anchor;
          const data = computeFineGrainedSessionVwap(
            indCandles,
            fine1mVwapCandles,
            parseTimeframeSeconds(timeframe),
            {
              anchor,
              multipliers: [
                vwapCfg.band1.multiplier,
                vwapCfg.band2.multiplier,
                vwapCfg.band3.multiplier,
              ],
              sessionTimeZone: vwapSessionTimeZone,
              source: vwapCfg.source,
              priorSessionSeed: anchor === "session" ? (priorVwapSeed ?? undefined) : undefined,
              anchorAtRegularOpen: vwapAnchorAtRegularOpen,
            },
          );
          upsertOverlayLine(
            "VWAP",
            {
              color: vwapCfg.color,
              lineWidth: Math.min(4, Math.max(1, Math.round(vwapCfg.lineWidth))) as 1 | 2 | 3 | 4,
              lineStyle: LineStyle.Solid,
              priceScaleId: "right",
              priceLineVisible: false,
              lastValueVisible: true,
              crosshairMarkerVisible: true,
              priceFormat: overlayPriceFormat,
              ...(suppressRightAutoscale ? { autoscaleInfoProvider: () => null } : {}),
            },
            data.vwap,
          );

          const bands = [
            [vwapCfg.band1, data.upper1, data.lower1, "1"],
            [vwapCfg.band2, data.upper2, data.lower2, "2"],
            [vwapCfg.band3, data.upper3, data.lower3, "3"],
          ] as const;

          for (const [band, upperPts, lowerPts, idx] of bands) {
            if (!band.enabled) continue;
            const bandOpts = {
              color: band.color,
              lineWidth: Math.min(4, Math.max(1, Math.round(band.lineWidth))) as 1 | 2 | 3 | 4,
              lineStyle: vwapBandLineStyleToChart(band.lineStyle),
              priceScaleId: "right",
              priceLineVisible: false,
              lastValueVisible: vwapCfg.showBandLabels,
              crosshairMarkerVisible: false,
              priceFormat: overlayPriceFormat,
              ...(suppressRightAutoscale ? { autoscaleInfoProvider: () => null } : {}),
            };
            upsertOverlayLine(`VWAP-upper${idx}`, bandOpts, upperPts);
            upsertOverlayLine(`VWAP-lower${idx}`, bandOpts, lowerPts);
          }
          break;
        }
        case "VPVR":
        case "SMC":
          // Rendered as interactive ISeriesPrimitive overlays below
          break;
      }
    }

    // ── Sync VPVR primitive ──────────────────────────────────
    if (effectiveIndicators.includes("VPVR")) {
      const vpvrInput = {
        candles: indCandles,
        settings: indicatorSettings.vpvr,
        isDark,
        pipDigits,
      };
      if (vpvrPrimRef.current && vpvrPrimRef.current.series === candleSeries) {
        vpvrPrimRef.current.prim.updateData(vpvrInput);
      } else {
        if (vpvrPrimRef.current) {
          try {
            vpvrPrimRef.current.series.detachPrimitive(vpvrPrimRef.current.prim);
          } catch {
            /* disposed */
          }
          vpvrPrimRef.current = null;
        }
        const prim = new VolumeProfilePrimitive(vpvrInput);
        try {
          candleSeries.attachPrimitive(prim);
          vpvrPrimRef.current = { series: candleSeries, prim };
        } catch {
          /* series not ready */
        }
      }
    } else if (vpvrPrimRef.current) {
      try {
        vpvrPrimRef.current.series.detachPrimitive(vpvrPrimRef.current.prim);
      } catch {
        /* disposed */
      }
      vpvrPrimRef.current = null;
    }

    // ── Sync SMC Market Structure primitive ──────────────────
    if (effectiveIndicators.includes("SMC")) {
      const structure = computeMarketStructure(indCandles, {
        swingLength: indicatorSettings.smc.swingLength,
      });
      const smcInput = {
        structure,
        settings: indicatorSettings.smc,
        isDark,
      };
      if (smcPrimRef.current && smcPrimRef.current.series === candleSeries) {
        smcPrimRef.current.prim.updateData(smcInput);
      } else {
        if (smcPrimRef.current) {
          try {
            smcPrimRef.current.series.detachPrimitive(smcPrimRef.current.prim);
          } catch {
            /* disposed */
          }
          smcPrimRef.current = null;
        }
        const prim = new MarketStructurePrimitive(smcInput);
        try {
          candleSeries.attachPrimitive(prim);
          smcPrimRef.current = { series: candleSeries, prim };
        } catch {
          /* series not ready */
        }
      }
    } else if (smcPrimRef.current) {
      try {
        smcPrimRef.current.series.detachPrimitive(smcPrimRef.current.prim);
      } catch {
        /* disposed */
      }
      smcPrimRef.current = null;
    }
  }, [
    activeIndicators,
    chartData,
    isDark,
    separatePanes,
    chartEpoch,
    pipDigits,
    excludeTypes,
    timeframe,
    indicatorSettings,
    vwapSessionTimeZone,
    suppressRightAutoscale,
    priorVwapSeed,
    vwapAnchorAtRegularOpen,
    fine1mVwapCandles,
  ]);
}
