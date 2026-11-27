import {
  ColorType,
  CrosshairMode,
  createChart,
  type IChartApi,
  type ISeriesApi,
  type LogicalRange,
  LineStyle,
  type Time,
} from "lightweight-charts";
import { ChevronDown, ChevronUp, Maximize2, Minimize2, Minus, Plus, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { OscillatorPanePrimitive } from "../../lib/chart-plugins/oscillator-pane-primitive.ts";
import {
  balancedDivergenceOptions,
  detectDivergences,
  MACD_BALANCED_DEFAULTS,
  macd,
  RSI_BALANCED_DEFAULTS,
  rsi,
  stochasticRsi,
  type DivergenceSignal,
} from "../../lib/indicators.ts";
import { parseTimeframeSeconds } from "../../lib/timeframes.ts";
import type { Timeframe } from "./constants.ts";
import { formatMacdValue } from "./useIndicators.ts";
import { type ChartCandle, toIndicatorCandles } from "./utils.ts";

export interface ModularOscillatorBlockProps {
  type: "RSI" | "MACD" | "STOCH";
  chartData: ChartCandle[];
  confirmedChartData: ChartCandle[];
  timeframe: Timeframe;
  isDark: boolean;
  colors: {
    background: string;
    text: string;
    grid: string;
    crosshair: string;
  };
  pipDigits: number;
  heightPct: number;
  isLastBlock: boolean;
  isMaximized?: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onExpand: () => void;
  onShrink: () => void;
  onToggleMaximize?: () => void;
  onClose?: () => void;
  onRegisterChart?: (type: "RSI" | "MACD" | "STOCH", chart: IChartApi | null) => void;
  onRangeChange?: (range: LogicalRange | null, source: "RSI" | "MACD" | "STOCH") => void;
  getMainLogicalRange?: () => LogicalRange | null;
  crosshairTime?: Time | null;
  onCrosshairMove?: (time: Time | null, x?: number | null) => void;
}

export function ModularOscillatorBlock({
  type,
  chartData,
  confirmedChartData,
  timeframe,
  isDark,
  colors,
  pipDigits,
  heightPct,
  isLastBlock,
  isMaximized,
  canMoveUp,
  canMoveDown,
  onMoveUp,
  onMoveDown,
  onExpand,
  onShrink,
  onToggleMaximize,
  onClose,
  onRegisterChart,
  onRangeChange,
  getMainLogicalRange,
  crosshairTime: _crosshairTime,
  onCrosshairMove,
}: ModularOscillatorBlockProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);

  // Series references
  const rsiSeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const macdHistSeriesRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const macdLineSeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const macdSignalSeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const stochKSeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const stochDSeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const primitiveRef = useRef<OscillatorPanePrimitive | null>(null);

  // User interaction tracking so programmatic updates don't broadcast spurious ranges
  const isInteractingRef = useRef(false);
  const wheelTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [oscChartEpoch, setOscChartEpoch] = useState(0);

  const onRegisterChartRef = useRef(onRegisterChart);
  const onRangeChangeRef = useRef(onRangeChange);
  const onCrosshairMoveRef = useRef(onCrosshairMove);
  useEffect(() => {
    onRegisterChartRef.current = onRegisterChart;
    onRangeChangeRef.current = onRangeChange;
    onCrosshairMoveRef.current = onCrosshairMove;
  });

  const [showThresholds] = useState<boolean>(() => {
    return localStorage.getItem("macdShowThresholds") !== "false";
  });

  // Convert candles for indicators
  const indCandles = useMemo(() => toIndicatorCandles(chartData), [chartData]);
  const detectionCandles = useMemo(() => toIndicatorCandles(confirmedChartData), [confirmedChartData]);

  // Standard universal indicator defaults: RSI (14) and MACD (12, 26, 9)
  const rsiPeriod = RSI_BALANCED_DEFAULTS.intraday;
  const macdFastPeriod = MACD_BALANCED_DEFAULTS.fast;
  const macdSlowPeriod = MACD_BALANCED_DEFAULTS.slow;

  // Compute indicator data
  const rsiData = useMemo(() => {
    if (type !== "RSI" || indCandles.length === 0) return null;
    const values = rsi(indCandles, rsiPeriod);
    return { values };
  }, [type, indCandles, rsiPeriod]);

  const macdData = useMemo(() => {
    if (type !== "MACD" || indCandles.length === 0) return null;
    return macd(indCandles, macdFastPeriod, macdSlowPeriod, MACD_BALANCED_DEFAULTS.signal);
  }, [type, indCandles, macdFastPeriod, macdSlowPeriod]);

  const stochRsiData = useMemo(() => {
    if (type !== "STOCH" || indCandles.length === 0) return null;
    return stochasticRsi(indCandles, 14, 14, 3, 3);
  }, [type, indCandles]);

  const divergenceRsiData = useMemo(
    () => type === "RSI" ? rsi(detectionCandles, rsiPeriod) : [],
    [type, detectionCandles, rsiPeriod],
  );
  const divergenceMacdData = useMemo(
    () => type === "MACD"
      ? macd(detectionCandles, macdFastPeriod, macdSlowPeriod, MACD_BALANCED_DEFAULTS.signal)
      : null,
    [type, detectionCandles, macdFastPeriod, macdSlowPeriod],
  );

  // Maps for fast crosshair lookup
  const rsiValueMap = useMemo(() => {
    if (!rsiData) return new Map<number, number>();
    const map = new Map<number, number>();
    for (const item of rsiData.values) {
      map.set(item.time as number, item.value);
    }
    return map;
  }, [rsiData]);

  const stochValueMap = useMemo(() => {
    if (!stochRsiData) return new Map<number, { k: number; d?: number }>();
    const dMap = new Map<number, number>();
    for (const d of stochRsiData.d) {
      dMap.set(d.time as number, d.value);
    }
    const map = new Map<number, { k: number; d?: number }>();
    for (const k of stochRsiData.k) {
      const t = k.time as number;
      map.set(t, { k: k.value, d: dMap.get(t) });
    }
    return map;
  }, [stochRsiData]);

  const macdValueMap = useMemo(() => {
    if (!macdData)
      return new Map<number, { macd: number; signal?: number; hist?: number }>();
    const sigMap = new Map<number, number>();
    for (const s of macdData.signal) {
      sigMap.set(s.time as number, s.value);
    }
    const histMap = new Map<number, number>();
    for (const h of macdData.histogram) {
      histMap.set(h.time as number, h.value);
    }
    const map = new Map<number, { macd: number; signal?: number; hist?: number }>();
    for (const m of macdData.macd) {
      const t = m.time as number;
      map.set(t, {
        macd: m.value,
        signal: sigMap.get(t),
        hist: histMap.get(t),
      });
    }
    return map;
  }, [macdData]);

  const [showDivergences] = useState<boolean>(() => {
    return localStorage.getItem("oscShowDivergences") !== "false";
  });

  // Automatically detect non-repainting confirmed regular divergences for RSI and MACD Histogram
  const divergences = useMemo<DivergenceSignal[]>(() => {
    if (!showDivergences || detectionCandles.length < 15) return [];
    if (type === "RSI" && divergenceRsiData.length > 0) {
      return detectDivergences(detectionCandles, divergenceRsiData, {
        ...balancedDivergenceOptions(timeframe, "rsi", "rsi", false, false, "wick"),
        includeHidden: false,
      });
    }
    if (type === "MACD" && divergenceMacdData && divergenceMacdData.histogram.length > 0) {
      return detectDivergences(detectionCandles, divergenceMacdData.histogram, {
        ...balancedDivergenceOptions(timeframe, "macd", "histogram", true, false, "wick"),
        includeHidden: false,
      });
    }
    return [];
  }, [
    type,
    detectionCandles,
    divergenceRsiData,
    divergenceMacdData,
    showDivergences,
    timeframe,
  ]);

  // Initialize independent chart
  useEffect(() => {
    if (!containerRef.current) return;

    const chart = createChart(containerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: colors.background },
        textColor: colors.text,
        fontFamily: "'JetBrains Mono', 'SF Mono', 'Fira Code', monospace",
        fontSize: 15,
      },
      grid: {
        vertLines: { color: colors.grid, style: LineStyle.Dotted },
        horzLines: { color: colors.grid, style: LineStyle.Dotted },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: {
          visible: false,
          color: isDark ? "rgba(203, 213, 225, 0.45)" : "rgba(100, 116, 139, 0.45)",
          width: 1,
          style: LineStyle.Dotted,
          labelBackgroundColor: "#363a45",
          labelVisible: false,
        },
        horzLine: {
          color: colors.crosshair,
          width: 1,
          style: LineStyle.Dashed,
          labelBackgroundColor: "#363a45",
          labelVisible: true,
        },
      },
      rightPriceScale: {
        borderColor: colors.grid,
        scaleMargins: { top: 0.05, bottom: 0.05 },
        autoScale: true,
        alignLabels: true,
        borderVisible: true,
        entireTextOnly: false,
        ticksVisible: true,
        minimumWidth: 96,
      },
      timeScale: {
        borderColor: colors.grid,
        timeVisible: true,
        secondsVisible: parseTimeframeSeconds(timeframe) <= 60,
        rightOffset: parseTimeframeSeconds(timeframe) <= 60 ? 6 : 4,
        minBarSpacing: 0.5,
        fixLeftEdge: false,
        fixRightEdge: false,
        borderVisible: true,
        visible: Boolean(isMaximized || isLastBlock),
      },
      handleScroll: {
        mouseWheel: true,
        pressedMouseMove: true,
        horzTouchDrag: true,
        vertTouchDrag: true,
      },
      handleScale: {
        mouseWheel: true,
        pinch: true,
        axisPressedMouseMove: { time: true, price: true },
        axisDoubleClickReset: { time: true, price: true },
      },
    });

    chartRef.current = chart;
    onRegisterChartRef.current?.(type, chart);

    const el = containerRef.current;
    const handlePointerDown = () => {
      isInteractingRef.current = true;
    };
    const handlePointerUp = () => {
      isInteractingRef.current = false;
    };
    const handleWheel = () => {
      isInteractingRef.current = true;
      if (wheelTimerRef.current) clearTimeout(wheelTimerRef.current);
      wheelTimerRef.current = setTimeout(() => {
        isInteractingRef.current = false;
      }, 350);
    };

    el.addEventListener("mousedown", handlePointerDown);
    window.addEventListener("mouseup", handlePointerUp);
    el.addEventListener("touchstart", handlePointerDown, { passive: true });
    window.addEventListener("touchend", handlePointerUp);
    el.addEventListener("wheel", handleWheel, { passive: true });

    // Sync time scale: only propagate if the user is actively interacting with this pane
    chart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
      if (isInteractingRef.current) {
        onRangeChangeRef.current?.(range, type);
      }
    });

    // Crosshair sync (snapped discretely candle-to-candle)
    chart.subscribeCrosshairMove((param) => {
      if (!param || !param.time || !param.point || param.point.x < 0) {
        onCrosshairMoveRef.current?.(null, null);
        return;
      }
      const snappedX = chart.timeScale().timeToCoordinate(param.time);
      onCrosshairMoveRef.current?.(param.time, snappedX !== null ? Number(snappedX) : null);
    });

    // Create series based on block type
    if (type === "RSI") {
      const rsiSeries = chart.addLineSeries({
        color: "#BA68C8",
        lineWidth: 2,
        priceLineVisible: false,
        lastValueVisible: true,
        priceFormat: {
          type: "custom",
          formatter: (v: number) => v.toFixed(2),
        },
      });
      rsiSeriesRef.current = rsiSeries;

      // Overbought / Oversold reference lines with strong contrast
      rsiSeries.createPriceLine({
        price: 70,
        color: "rgba(186, 104, 200, 0.75)",
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: false,
        title: "",
      });
      rsiSeries.createPriceLine({
        price: 30,
        color: "rgba(186, 104, 200, 0.75)",
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: false,
        title: "",
      });
      rsiSeries.createPriceLine({
        price: 50,
        color: "rgba(203, 213, 225, 0.45)",
        lineWidth: 1,
        lineStyle: LineStyle.Dotted,
        axisLabelVisible: false,
        title: "",
      });
    } else if (type === "MACD") {
      const macdDigits = Math.max(2, pipDigits);
      const macdMinMove = Number((1 / Math.pow(10, macdDigits)).toFixed(macdDigits + 1));

      const histSeries = chart.addHistogramSeries({
        priceScaleId: "right",
        priceLineVisible: false,
        lastValueVisible: true,
        priceFormat: {
          type: "custom",
          minMove: macdMinMove,
          formatter: (val: number) => formatMacdValue(val, pipDigits),
        },
      });
      macdHistSeriesRef.current = histSeries;

      const macdLine = chart.addLineSeries({
        priceScaleId: "right",
        color: "#2962FF",
        lineWidth: 2,
        priceLineVisible: false,
        lastValueVisible: true,
        priceFormat: {
          type: "custom",
          minMove: macdMinMove,
          formatter: (val: number) => formatMacdValue(val, pipDigits),
        },
      });
      macdLineSeriesRef.current = macdLine;

      const signalLine = chart.addLineSeries({
        priceScaleId: "right",
        color: "#FF6D00",
        lineWidth: 2,
        priceLineVisible: false,
        lastValueVisible: true,
        priceFormat: {
          type: "custom",
          minMove: macdMinMove,
          formatter: (val: number) => formatMacdValue(val, pipDigits),
        },
      });
      macdSignalSeriesRef.current = signalLine;

      // Zero reference line (subtle dotted, without marking the axis)
      histSeries.createPriceLine({
        price: 0,
        color: "rgba(203, 213, 225, 0.35)",
        lineWidth: 1,
        lineStyle: LineStyle.Dotted,
        axisLabelVisible: false,
        title: "",
      });
    } else if (type === "STOCH") {
      const stochK = chart.addLineSeries({
        color: "#2962FF",
        lineWidth: 2,
        priceLineVisible: false,
        lastValueVisible: true,
        priceFormat: {
          type: "custom",
          formatter: (v: number) => v.toFixed(2),
        },
      });
      stochKSeriesRef.current = stochK;

      const stochD = chart.addLineSeries({
        color: "#FF6D00",
        lineWidth: 2,
        priceLineVisible: false,
        lastValueVisible: true,
        priceFormat: {
          type: "custom",
          formatter: (v: number) => v.toFixed(2),
        },
      });
      stochDSeriesRef.current = stochD;

      stochK.createPriceLine({
        price: 80,
        color: "rgba(148, 163, 184, 0.65)",
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: false,
        title: "",
      });
      stochK.createPriceLine({
        price: 20,
        color: "rgba(148, 163, 184, 0.65)",
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: false,
        title: "",
      });
      stochK.createPriceLine({
        price: 50,
        color: "rgba(148, 163, 184, 0.35)",
        lineWidth: 1,
        lineStyle: LineStyle.Dotted,
        axisLabelVisible: false,
        title: "",
      });
    }

    // Resize observer
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const w = Math.floor(entry.contentRect.width);
        const h = Math.floor(entry.contentRect.height);
        if (w > 0 && h > 0) {
          chart.applyOptions({ width: w, height: h });
        }
      }
    });
    ro.observe(containerRef.current);

    setOscChartEpoch((e) => e + 1);

    return () => {
      el.removeEventListener("mousedown", handlePointerDown);
      window.removeEventListener("mouseup", handlePointerUp);
      el.removeEventListener("touchstart", handlePointerDown);
      window.removeEventListener("touchend", handlePointerUp);
      el.removeEventListener("wheel", handleWheel);
      if (wheelTimerRef.current) clearTimeout(wheelTimerRef.current);
      ro.disconnect();
      onRegisterChartRef.current?.(type, null);
      chart.remove();
      chartRef.current = null;
      rsiSeriesRef.current = null;
      macdHistSeriesRef.current = null;
      macdLineSeriesRef.current = null;
      macdSignalSeriesRef.current = null;
      stochKSeriesRef.current = null;
      stochDSeriesRef.current = null;
      primitiveRef.current = null;
    };
  }, [type, pipDigits]);

  // Update timeScale options dynamically when timeframe changes without chart recreation
  useEffect(() => {
    if (!chartRef.current) return;
    chartRef.current.applyOptions({
      timeScale: {
        secondsVisible: parseTimeframeSeconds(timeframe) <= 60,
        rightOffset: parseTimeframeSeconds(timeframe) <= 60 ? 6 : 4,
      },
    });
  }, [timeframe, oscChartEpoch]);

  // Update theme colors and timeScale visibility dynamically
  useEffect(() => {
    if (!chartRef.current) return;
    chartRef.current.applyOptions({
      layout: {
        background: { type: ColorType.Solid, color: colors.background },
        textColor: colors.text,
      },
      grid: {
        vertLines: { color: colors.grid },
        horzLines: { color: colors.grid },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: {
          visible: false,
          labelVisible: false,
        },
      },
      timeScale: {
        borderColor: colors.grid,
        visible: Boolean(isMaximized || isLastBlock),
      },
    });
  }, [colors, isLastBlock, isMaximized, oscChartEpoch]);

  // Resize chart canvas immediately when maximized or height changes
  useEffect(() => {
    const handle = requestAnimationFrame(() => {
      if (containerRef.current && chartRef.current) {
        const w = containerRef.current.clientWidth;
        const h = containerRef.current.clientHeight;
        if (w > 0 && h > 0) {
          chartRef.current.applyOptions({ width: w, height: h });
        }
      }
    });
    return () => cancelAnimationFrame(handle);
  }, [isMaximized, heightPct, oscChartEpoch]);

  // Populate series data & attach divergence primitives
  useEffect(() => {
    if (!chartRef.current || indCandles.length === 0) return;

    if (type === "RSI" && rsiSeriesRef.current && rsiData) {
      const series = rsiSeriesRef.current;
      // Map data with whitespace alignment so indices match candles 1:1
      let minRsi = 20;
      let maxRsi = 80;
      const lineData = indCandles.map((c) => {
        const val = rsiValueMap.get(c.time);
        if (val !== undefined && Number.isFinite(val)) {
          if (val < minRsi) minRsi = val;
          if (val > maxRsi) maxRsi = val;
          return { time: c.time as Time, value: val };
        }
        return { time: c.time as Time };
      });
      series.setData(lineData);

      const minBound = Math.max(0, minRsi - 8);
      const maxBound = Math.min(100, maxRsi + 8);

      // Primitive for clean RSI pane levels & styling
      if (!primitiveRef.current) {
        const primitive = new OscillatorPanePrimitive(
          {
            kind: "rsi",
            title: "RSI",
            headerValues: [],
            divergences,
            slotTopRatio: 0,
            slotBottomRatio: 1,
            isDark,
            hideHeader: true,
          },
          minBound,
          maxBound,
        );
        series.attachPrimitive(primitive);
        primitiveRef.current = primitive;
      } else {
        primitiveRef.current.setOptions(
          {
            kind: "rsi",
            title: "RSI",
            headerValues: [],
            divergences,
            slotTopRatio: 0,
            slotBottomRatio: 1,
            isDark,
            hideHeader: true,
          },
          minBound,
          maxBound,
        );
      }
    } else if (
      type === "MACD" &&
      macdHistSeriesRef.current &&
      macdLineSeriesRef.current &&
      macdSignalSeriesRef.current &&
      macdData
    ) {
      const histSeries = macdHistSeriesRef.current;
      const macdLine = macdLineSeriesRef.current;
      const sigLine = macdSignalSeriesRef.current;

      const histItems = indCandles.map((c, idx) => {
        const item = macdValueMap.get(c.time);
        if (!item || item.hist === undefined || !Number.isFinite(item.hist)) {
          return { time: c.time as Time };
        }
        const prevItem = idx > 0 ? macdValueMap.get(indCandles[idx - 1]!.time) : null;
        const prevHist = prevItem?.hist ?? item.hist;
        const rising = item.hist >= prevHist;
        // High contrast saturated 4-color palette with strong distinction in red and green valleys
        const color =
          item.hist >= 0
            ? rising
              ? "#00E676"
              : "#A7F3D0"
            : !rising
              ? "#FF1744"
              : "#FF8A80";
        return {
          time: c.time as Time,
          value: item.hist,
          color,
        };
      });

      const macdLineItems = indCandles.map((c) => {
        const item = macdValueMap.get(c.time);
        if (!item || !Number.isFinite(item.macd)) return { time: c.time as Time };
        return { time: c.time as Time, value: item.macd };
      });

      const signalLineItems = indCandles.map((c) => {
        const item = macdValueMap.get(c.time);
        if (!item || item.signal === undefined || !Number.isFinite(item.signal)) {
          return { time: c.time as Time };
        }
        return { time: c.time as Time, value: item.signal };
      });

      histSeries.setData(histItems);
      macdLine.setData(macdLineItems);
      sigLine.setData(signalLineItems);

      if (!primitiveRef.current) {
        const primitive = new OscillatorPanePrimitive(
          {
            kind: "macd",
            title: "MACD",
            headerValues: [],
            divergences,
            macdThresholds: macdData.thresholds,
            lastBarTime: indCandles.length > 0 ? indCandles[indCandles.length - 1]!.time : undefined,
            showMacdThresholds: showThresholds,
            pricePrecision: pipDigits,
            slotTopRatio: 0,
            slotBottomRatio: 1,
            isDark,
            hideHeader: true,
          },
          -1,
          1,
        );
        macdLine.attachPrimitive(primitive);
        primitiveRef.current = primitive;
      } else {
        primitiveRef.current.setOptions({
          kind: "macd",
          title: "MACD",
          headerValues: [],
          divergences,
          macdThresholds: macdData.thresholds,
          lastBarTime: indCandles.length > 0 ? indCandles[indCandles.length - 1]!.time : undefined,
          showMacdThresholds: showThresholds,
          pricePrecision: pipDigits,
          slotTopRatio: 0,
          slotBottomRatio: 1,
          isDark,
          hideHeader: true,
        });
      }
    } else if (
      type === "STOCH" &&
      stochKSeriesRef.current &&
      stochDSeriesRef.current &&
      stochRsiData
    ) {
      const kSeries = stochKSeriesRef.current;
      const dSeries = stochDSeriesRef.current;
      let minStoch = 15;
      let maxStoch = 85;

      const kItems = indCandles.map((c) => {
        const item = stochValueMap.get(c.time);
        if (item && Number.isFinite(item.k)) {
          if (item.k < minStoch) minStoch = item.k;
          if (item.k > maxStoch) maxStoch = item.k;
          return { time: c.time as Time, value: item.k };
        }
        return { time: c.time as Time };
      });
      const dItems = indCandles.map((c) => {
        const item = stochValueMap.get(c.time);
        if (item && item.d !== undefined && Number.isFinite(item.d)) {
          if (item.d < minStoch) minStoch = item.d;
          if (item.d > maxStoch) maxStoch = item.d;
          return { time: c.time as Time, value: item.d };
        }
        return { time: c.time as Time };
      });

      kSeries.setData(kItems);
      dSeries.setData(dItems);

      const minBound = Math.max(0, minStoch - 5);
      const maxBound = Math.min(100, maxStoch + 5);
      const lastK = stochRsiData.k.length > 0 ? stochRsiData.k[stochRsiData.k.length - 1]!.value : null;
      const lastD = stochRsiData.d.length > 0 ? stochRsiData.d[stochRsiData.d.length - 1]!.value : null;
      const headerValues = [
        ...(lastK !== null && Number.isFinite(lastK) ? [{ text: `%K ${lastK.toFixed(2)}`, color: "#2962FF" }] : []),
        ...(lastD !== null && Number.isFinite(lastD) ? [{ text: `%D ${lastD.toFixed(2)}`, color: "#FF6D00" }] : []),
      ];

      if (!primitiveRef.current) {
        const primitive = new OscillatorPanePrimitive(
          {
            kind: "stoch",
            title: "Stoch RSI",
            subtitle: "14 14 3 3",
            headerValues,
            divergences: [],
            slotTopRatio: 0,
            slotBottomRatio: 1,
            isDark,
            hideHeader: false,
          },
          minBound,
          maxBound,
        );
        kSeries.attachPrimitive(primitive);
        primitiveRef.current = primitive;
      } else {
        primitiveRef.current.setOptions(
          {
            kind: "stoch",
            title: "Stoch RSI",
            subtitle: "14 14 3 3",
            headerValues,
            divergences: [],
            slotTopRatio: 0,
            slotBottomRatio: 1,
            isDark,
            hideHeader: false,
          },
          minBound,
          maxBound,
        );
      }
    }

    if (!isInteractingRef.current && chartRef.current) {
      const mainRange = getMainLogicalRange?.();
      if (mainRange) {
        try {
          chartRef.current.timeScale().setVisibleLogicalRange(mainRange);
        } catch {
          // ignore
        }
      }
    }
  }, [
    type,
    indCandles,
    rsiData,
    macdData,
    stochRsiData,
    rsiValueMap,
    macdValueMap,
    stochValueMap,
    divergences,
    isDark,
    pipDigits,
    showThresholds,
    timeframe,
    getMainLogicalRange,
    oscChartEpoch,
  ]);

  return (
    <div
      onDoubleClick={(e) => {
        if ((e.target as HTMLElement).closest("button, a, input, select")) return;
        onToggleMaximize?.();
      }}
      onPointerLeave={() => {
        onCrosshairMove?.(null, null);
      }}
      className="relative w-full h-full select-none overflow-hidden group cursor-default"
      style={{ minHeight: "60px" }}
      title={isMaximized ? "Doble clic para restaurar todos los paneles" : "Doble clic para maximizar este panel"}
    >
      {/* ── Top-Right Controls (Move Up, Move Down, Expand, Shrink, Maximize, Close) ── */}
      <div className="absolute top-2 right-24 z-20 pointer-events-auto flex items-center gap-1 bg-card/90 backdrop-blur-sm border border-border/80 rounded-md px-1 py-0.5 shadow-sm text-muted-foreground opacity-80 group-hover:opacity-100 hover:opacity-100 transition-opacity">
        <button
          type="button"
          disabled={!canMoveUp}
          onClick={onMoveUp}
          title="Mover hacia arriba"
          className="p-1 hover:text-foreground hover:bg-muted/80 rounded transition-colors disabled:opacity-30 disabled:pointer-events-none"
        >
          <ChevronUp className="w-3.5 h-3.5" />
        </button>
        <button
          type="button"
          disabled={!canMoveDown}
          onClick={onMoveDown}
          title="Mover hacia abajo"
          className="p-1 hover:text-foreground hover:bg-muted/80 rounded transition-colors disabled:opacity-30 disabled:pointer-events-none"
        >
          <ChevronDown className="w-3.5 h-3.5" />
        </button>
        <button
          type="button"
          onClick={onExpand}
          title="Aumentar altura"
          className="p-1 hover:text-foreground hover:bg-muted/80 rounded transition-colors"
        >
          <Plus className="w-3.5 h-3.5" />
        </button>
        <button
          type="button"
          onClick={onShrink}
          title="Reducir altura"
          className="p-1 hover:text-foreground hover:bg-muted/80 rounded transition-colors"
        >
          <Minus className="w-3.5 h-3.5" />
        </button>
        {onToggleMaximize && (
          <button
            type="button"
            onClick={onToggleMaximize}
            title={isMaximized ? "Restaurar paneles (doble clic)" : "Maximizar bloque (doble clic)"}
            className="p-1 hover:text-foreground hover:bg-muted/80 rounded transition-colors"
          >
            {isMaximized ? (
              <Minimize2 className="w-3.5 h-3.5 text-primary" />
            ) : (
              <Maximize2 className="w-3.5 h-3.5" />
            )}
          </button>
        )}
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            title="Cerrar bloque"
            className="p-1 hover:text-[#f6465d] hover:bg-[#f6465d]/10 rounded transition-colors ml-0.5"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      {/* ── Canvas Container ── */}
      <div ref={containerRef} className="w-full h-full" />
    </div>
  );
}
