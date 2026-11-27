import {
  type CandlestickData,
  ColorType,
  createChart,
  CrosshairMode,
  type HistogramData,
  type IChartApi,
  type ISeriesApi,
  type LineData,
  LineStyle,
  type LogicalRange,
  type Time,
} from "lightweight-charts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useChartDrawings } from "../../hooks/useChartDrawings.ts";
import { useChartPreferences } from "../../hooks/useChartPreferences.ts";
import {
  DEFAULT_INDICATOR_SETTINGS,
  useIndicatorSettings,
} from "../../hooks/useIndicatorSettings.ts";
import { DrawingToolsManager } from "../../lib/chart-plugins/drawing-tools/manager.ts";
import {
  classifyExtendedSession,
  ExtendedHoursPrimitive,
  filterExtendedHoursCandles,
  isUsEquityExchange,
} from "../../lib/chart-plugins/extended-hours-primitive.ts";
import { MarketStructurePrimitive } from "../../lib/chart-plugins/market-structure-primitive.ts";
import { VolumeProfilePrimitive } from "../../lib/chart-plugins/volume-profile-primitive.ts";
import {
  bollingerBands,
  computeFineGrainedSessionVwap,
  computeMarketStructure,
  computeReplayEmaWithWarmup,
  defaultVwapAnchorForTimeframe,
  ema,
  getNyTradingDayKey,
  getVwapAnchorBucket,
  type IndicatorType,
  sma,
} from "../../lib/indicators.ts";
import {
  computeRequiredWarmupBars,
  parseTimeframeSeconds,
} from "../../lib/timeframes.ts";
import { cn, formatNumber, generateId } from "../../lib/utils.ts";
import {
  computeCausalReplayVwapSeed,
  fetchHistoryAsync,
  getHistory,
  getStockSessionMetadata,
  getStockVwapSeed,
  hasRealStockSeries,
  isCryptoInstrument,
  subscribeCandleBucketClosed,
  TF_SECONDS,
} from "../../services/demo/candles.ts";
import {
  isCryptoLiveStreamConnected,
  trackCryptoSymbol,
} from "../../services/cryptoStream.ts";
import {
  isIbkrLiveStreamConnected,
  trackIbkrSymbol,
} from "../../services/ibkrStream.ts";
import {
  DEMO_SYMBOLS,
  getDemoSymbol,
} from "../../services/demo/instruments.ts";
import { getReplaySliceForTimeframe, useReplayStore } from "../../services/demo/replay.ts";
import { useTradingStore } from "../../services/store.tsx";
import {
  CHART_COLORS,
  type DrawingLine,
  type DrawingTool,
  type Timeframe,
} from "./constants.ts";
import { DRAWING_STYLES_EVENT, getStyleDefaults } from "./drawingStyles.ts";
import {
  DrawingContextMenu,
  DrawingFloatingToolbar,
  DrawingSettingsDialog,
} from "./DrawingToolsOverlay.tsx";
import { DrawingToolRail } from "./DrawingToolRail.tsx";
import type { PriceSyncController } from "./priceSyncBus.ts";
import { vwapBandLineStyleToChart } from "./useIndicators.ts";
import {
  calculateReplayVolumeMa,
  calculateVolumeMa,
  getCandleBucketTime,
  getMinMove,
  getPipDigits,
  toIndicatorCandles,
  toUnixSeconds,
} from "./utils.ts";

export type ChartLayout = "1" | "2x1" | "2x2";

export const MULTICHART_OVERLAY_INDICATORS: ReadonlyArray<{
  type: IndicatorType;
  label: string;
  color: string;
}> = [
  { type: "EMA", label: "EMA", color: "#3b82f6" },
  { type: "VWAP", label: "VWAP", color: "#eab308" },
  { type: "SMA", label: "SMA (20)", color: "#a855f7" },
  { type: "BOLL", label: "Bollinger (20)", color: "#06b6d4" },
  { type: "VPVR", label: "Vol. Profile (VPVR)", color: "#f59e0b" },
  { type: "SMC", label: "Estructura (SMC)", color: "#10b981" },
];

const DEFAULT_PANE_INDICATORS: IndicatorType[] = ["EMA", "VWAP"];

type PaneCandle = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
};

const EMPTY_CANDLES: PaneCandle[] = [];
const PANE_CANDLE_LIMIT = 1_500;

export interface MultiChartPaneProps {
  slotId: number;
  mainSymbol: string;
  defaultTimeframe: Timeframe;
  isDark: boolean;
  symbols: Array<{ id?: string; name: string; displayName?: string | null; category?: string }>;
  ticks: Record<string, { bid: number; ask: number; timestamp: number }>;
  onPromoteToMain?: (symbol: string, timeframe: Timeframe) => void;
  timeframe?: Timeframe;
  onChangeTimeframe?: (timeframe: Timeframe) => void;
  activeIndicators?: IndicatorType[];
  showVolume?: boolean;
  isFocused?: boolean;
  onFocus?: () => void;
  priceSyncMaster?: boolean;
  priceSyncController?: PriceSyncController | null;
  onPaneSymbolChange?: (symbol: string) => void;
  isReplaying?: boolean;
  replaySimTimeSec?: number;
  replayPicking?: boolean;
  onPickReplayBar?: (timeSec: number, sourceTf: Timeframe) => void;
  drawingTool?: DrawingTool;
  onDrawingComplete?: () => void;
  onDrawingToolSelect?: (tool: DrawingTool) => void;
  accountEquity?: number;
  hideDrawings?: boolean;
  canExpand?: boolean;
  isExpanded?: boolean;
  onToggleExpand?: () => void;
  expandLabel?: string;
}

export function MultiChartPane({
  slotId,
  mainSymbol,
  defaultTimeframe,
  isDark,
  symbols,
  ticks,
  timeframe: controlledTf,
  activeIndicators: controlledIndicators,
  showVolume: showVolumeProp,
  isFocused = false,
  onFocus,
  priceSyncMaster = false,
  priceSyncController = null,
  onPaneSymbolChange,
  isReplaying = false,
  replaySimTimeSec = 0,
  replayPicking = false,
  onPickReplayBar,
  drawingTool = "none",
  onDrawingComplete,
  onDrawingToolSelect,
  accountEquity = 0,
  hideDrawings = false,
  canExpand = false,
  isExpanded = false,
  onToggleExpand,
}: MultiChartPaneProps) {
  const paneTf = controlledTf ?? defaultTimeframe;
  const paneIndicators = controlledIndicators ?? DEFAULT_PANE_INDICATORS;
  const showEma = paneIndicators.includes("EMA");
  const showVwap = paneIndicators.includes("VWAP");
  const showSma = paneIndicators.includes("SMA");
  const showBb = paneIndicators.includes("BOLL");
  const showVpvr = paneIndicators.includes("VPVR");
  const showSmc = paneIndicators.includes("SMC");

  const paneSymbol = mainSymbol;
  const indicatorSettings = useIndicatorSettings();
  const chartPrefs = useChartPreferences();
  const effectiveShowVolume = showVolumeProp ?? chartPrefs.showVolume;

  useEffect(() => {
    onPaneSymbolChange?.(paneSymbol);
  }, [paneSymbol, onPaneSymbolChange]);

  const {
    drawings,
    addDrawing,
    updateDrawing,
    removeDrawing,
    undo: undoDrawing,
    redo: redoDrawing,
  } = useChartDrawings(paneSymbol, paneTf, slotId);

  const visibleDrawings = useMemo(
    () =>
      hideDrawings
        ? []
        : drawings.filter((d) => !d.hidden && (d.visibility !== "tf" || d.createdTf === paneTf)),
    [drawings, paneTf, hideDrawings],
  );

  const [selectedDrawingIds, setSelectedDrawingIds] = useState<string[]>([]);
  const [showDrawingSettings, setShowDrawingSettings] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ id: string; x: number; y: number } | null>(null);

  useEffect(() => {
    setSelectedDrawingIds([]);
    setShowDrawingSettings(false);
    setContextMenu(null);
  }, [paneSymbol]);

  const selectedDrawing = useMemo(() => {
    if (selectedDrawingIds.length !== 1) return null;
    return visibleDrawings.find((d) => d.id === selectedDrawingIds[0]) ?? null;
  }, [visibleDrawings, selectedDrawingIds]);

  const drawingManagerRef = useRef<DrawingToolsManager | null>(null);
  const drawingToolRef = useRef(drawingTool);
  const replayPickingRef = useRef(replayPicking);
  const drawingsRef = useRef(visibleDrawings);
  const paneTfRef = useRef(paneTf);
  const magnetRef = useRef(chartPrefs.magnetMode);
  const stayInModeRef = useRef(chartPrefs.stayInDrawingMode);
  const accountEquityRef = useRef(accountEquity);
  const styleDefaultsRef = useRef(getStyleDefaults());
  const onAddDrawingRef = useRef(addDrawing);
  const onUpdateDrawingRef = useRef(updateDrawing);
  const onRemoveDrawingRef = useRef(removeDrawing);
  const onUndoDrawingRef = useRef(undoDrawing);
  const onRedoDrawingRef = useRef(redoDrawing);
  const onDrawingCompleteRef = useRef(onDrawingComplete);
  const onDrawingToolSelectRef = useRef(onDrawingToolSelect);

  useEffect(() => {
    drawingToolRef.current = drawingTool;
    replayPickingRef.current = replayPicking;
    drawingManagerRef.current?.setTool(replayPicking ? "none" : drawingTool);
  }, [drawingTool, replayPicking]);

  useEffect(() => {
    drawingsRef.current = visibleDrawings;
    drawingManagerRef.current?.setDrawings(visibleDrawings);
  }, [visibleDrawings]);

  useEffect(() => {
    paneTfRef.current = paneTf;
    drawingManagerRef.current?.updateTimeframe(paneTf, TF_SECONDS[paneTf] ?? 60);
  }, [paneTf]);

  useEffect(() => {
    magnetRef.current = chartPrefs.magnetMode;
    drawingManagerRef.current?.setMagnetMode(chartPrefs.magnetMode);
  }, [chartPrefs.magnetMode]);

  useEffect(() => {
    stayInModeRef.current = chartPrefs.stayInDrawingMode;
    drawingManagerRef.current?.setStayInDrawingMode(chartPrefs.stayInDrawingMode);
  }, [chartPrefs.stayInDrawingMode]);

  useEffect(() => {
    accountEquityRef.current = accountEquity;
    drawingManagerRef.current?.setAccountEquity(accountEquity);
  }, [accountEquity]);

  useEffect(() => {
    const refresh = () => {
      styleDefaultsRef.current = getStyleDefaults();
      drawingManagerRef.current?.setStyleDefaults(styleDefaultsRef.current);
    };
    window.addEventListener(DRAWING_STYLES_EVENT, refresh);
    return () => window.removeEventListener(DRAWING_STYLES_EVENT, refresh);
  }, []);

  useEffect(() => {
    onAddDrawingRef.current = addDrawing;
    onUpdateDrawingRef.current = updateDrawing;
    onRemoveDrawingRef.current = removeDrawing;
    onUndoDrawingRef.current = undoDrawing;
    onRedoDrawingRef.current = redoDrawing;
    onDrawingCompleteRef.current = onDrawingComplete;
    onDrawingToolSelectRef.current = onDrawingToolSelect;
  }, [
    addDrawing,
    updateDrawing,
    removeDrawing,
    undoDrawing,
    redoDrawing,
    onDrawingComplete,
    onDrawingToolSelect,
  ]);

  const handleCloneDrawing = useCallback(() => {
    const d = selectedDrawing;
    if (!d) return;
    const offsetSec = (TF_SECONDS[paneTf] ?? 60) * 5;
    addDrawing({
      ...d,
      id: generateId(),
      time: d.time != null ? d.time + offsetSec : undefined,
      time2: d.time2 != null ? d.time2 + offsetSec : undefined,
      time3: d.time3 != null ? d.time3 + offsetSec : undefined,
    });
  }, [selectedDrawing, paneTf, addDrawing]);

  const handleReorderDrawing = useCallback(
    (d: DrawingLine, dir: "front" | "back") => {
      const zs = drawings.map((x) => x.zIndex ?? 0);
      const zIndex = dir === "front" ? Math.max(...zs, 0) + 1 : Math.min(...zs, 0) - 1;
      updateDrawing({ ...d, zIndex });
    },
    [drawings, updateDrawing],
  );

  const symbolInfo = useMemo(
    () =>
      symbols.find((s) => s.name === paneSymbol) ??
      DEMO_SYMBOLS.find((s) => s.name === paneSymbol),
    [symbols, paneSymbol],
  );
  const pipDigits = useMemo(
    () => getPipDigits(symbolInfo as { tickSize?: number | string } | undefined, paneSymbol),
    [symbolInfo, paneSymbol],
  );

  const paneCandleLimit = useMemo(() => {
    const emaLines = (
      indicatorSettings.ema?.lines ?? DEFAULT_INDICATOR_SETTINGS.ema.lines
    ).filter((l) => l.enabled && l.period > 0);
    return Math.max(
      PANE_CANDLE_LIMIT,
      computeRequiredWarmupBars(emaLines.map((l) => l.period)),
    );
  }, [indicatorSettings.ema?.lines]);

  const [candlesState, setCandlesState] = useState<{
    symbol: string;
    tf: Timeframe;
    bars: PaneCandle[];
  }>(() => ({
    symbol: paneSymbol,
    tf: paneTf,
    bars: isReplaying ? EMPTY_CANDLES : getHistory(paneSymbol, paneTf, PANE_CANDLE_LIMIT),
  }));

  // Keep real-time live stream bound ONLY to symbol (switching timeframe never restarts stream)
  useEffect(() => {
    if (isReplaying) return;
    if (isCryptoInstrument(paneSymbol)) {
      return trackCryptoSymbol(paneSymbol);
    }
    const isStock = (getDemoSymbol(paneSymbol)?.category ?? "").toUpperCase() === "STOCKS";
    if (!isStock) return;
    return trackIbkrSymbol(paneSymbol);
  }, [paneSymbol, isReplaying]);

  useEffect(() => {
    if (isReplaying) {
      // Never trigger live/current IBKR downloads while Bar Replay is active
      return;
    }
    const syncBars = getHistory(paneSymbol, paneTf, paneCandleLimit);
    setCandlesState({ symbol: paneSymbol, tf: paneTf, bars: syncBars });
    let cancelled = false;
    const refresh = () => {
      void fetchHistoryAsync(paneSymbol, paneTf, paneCandleLimit).then((bars) => {
        if (!cancelled && bars.length > 0) {
          setCandlesState({ symbol: paneSymbol, tf: paneTf, bars });
        }
      });
    };
    refresh();

    // Sync closed live bars immediately into pane state so EMA 9 & VWAP never skip closed 1m / 3m / 5m candles
    const unsubClosed = subscribeCandleBucketClosed((sym, tf) => {
      if (cancelled || isReplaying) return;
      if (sym.toUpperCase() === paneSymbol.toUpperCase() && tf === paneTf) {
        const fresh = getHistory(paneSymbol, paneTf, paneCandleLimit);
        if (fresh.length > 0) {
          setCandlesState({ symbol: paneSymbol, tf: paneTf, bars: fresh });
        }
      }
    });

    const isStock = (getDemoSymbol(paneSymbol)?.category ?? "").toUpperCase() === "STOCKS";
    const isCrypto = isCryptoInstrument(paneSymbol);
    const pollId =
      isStock || isCrypto
        ? setInterval(() => {
            const liveUp = isCrypto ? isCryptoLiveStreamConnected() : isIbkrLiveStreamConnected();
            if (!liveUp) refresh();
          }, 30_000)
        : null;

    return () => {
      cancelled = true;
      unsubClosed();
      if (pollId) clearInterval(pollId);
    };
  }, [paneSymbol, paneTf, isReplaying, paneCandleLimit]);

  const liveCandles =
    candlesState.symbol === paneSymbol && candlesState.tf === paneTf
      ? candlesState.bars
      : EMPTY_CANDLES;

  const candles = useMemo<PaneCandle[]>(() => {
    if (isReplaying) {
      if (replaySimTimeSec > 0) {
        return getReplaySliceForTimeframe(paneSymbol, paneTf, replaySimTimeSec);
      }
      return EMPTY_CANDLES;
    }
    return liveCandles;
  }, [isReplaying, replaySimTimeSec, paneSymbol, paneTf, liveCandles]);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volSeriesRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const volMaSeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const overlaySeriesRef = useRef<Map<string, ISeriesApi<"Line">>>(new Map());
  const overlayStructureKeyRef = useRef<string>("");
  const vpvrPrimRef = useRef<VolumeProfilePrimitive | null>(null);
  const smcPrimRef = useRef<MarketStructurePrimitive | null>(null);
  const extendedHoursPrimRef = useRef<ExtendedHoursPrimitive | null>(null);
  const prevPaneKeyRef = useRef<string>("");
  const wasReplayingRef = useRef<boolean>(false);
  const prevReplayLenRef = useRef<number>(0);
  const prevReplayLastTimeRef = useRef<number>(0);
  const replayCutOffsetRef = useRef<{ barsLeft: number; barsRight: number } | null>(null);
  const lastCandleRef = useRef<{
    symbol: string;
    time: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
  } | null>(null);

  const colors = isDark ? CHART_COLORS.dark : CHART_COLORS.light;

  const priceSyncMasterRef = useRef(priceSyncMaster);
  priceSyncMasterRef.current = priceSyncMaster;
  const priceSyncControllerRef = useRef(priceSyncController);
  priceSyncControllerRef.current = priceSyncController;
  const pipDigitsRef = useRef(pipDigits);
  pipDigitsRef.current = pipDigits;
  const paneSymbolRef = useRef(paneSymbol);
  paneSymbolRef.current = paneSymbol;
  const effectiveShowVolumeRef = useRef(effectiveShowVolume);
  effectiveShowVolumeRef.current = effectiveShowVolume;
  const effectiveShowVolumeMa = effectiveShowVolume && (chartPrefs.showVolumeMa ?? true);
  const effectiveShowVolumeMaRef = useRef(effectiveShowVolumeMa);
  effectiveShowVolumeMaRef.current = effectiveShowVolumeMa;
  const autoScaleHealAttemptsRef = useRef(0);
  const recentVolsRef = useRef<number[]>([]);
  const prev19VolSumRef = useRef<number>(0);
  const hasVolumeMaRef = useRef<boolean>(false);
  const syncHorzLineRef = useRef<HTMLDivElement | null>(null);
  const syncPricePillRef = useRef<HTMLDivElement | null>(null);
  const boundsRafRef = useRef<number | null>(null);

  const getPaneHeight = useCallback((chart: IChartApi, el: HTMLDivElement): number => {
    let tsH = 26;
    try {
      const ts = chart.timeScale();
      if (typeof ts.height === "function") {
        tsH = ts.height();
      }
    } catch {
      /* ignore */
    }
    return Math.max(1, el.clientHeight - tsH);
  }, []);

  const emitMasterBounds = useCallback(() => {
    if (!priceSyncMasterRef.current || !priceSyncControllerRef.current) return;
    const chart = chartRef.current;
    const series = candleSeriesRef.current;
    const el = containerRef.current;
    if (!chart || !series || !el) return;
    if (lastCandleRef.current && lastCandleRef.current.symbol !== paneSymbolRef.current) return;

    const paneH = getPaneHeight(chart, el);
    const topPrice = series.coordinateToPrice(0);
    const botPrice = series.coordinateToPrice(paneH);
    if (
      topPrice === null ||
      botPrice === null ||
      !Number.isFinite(Number(topPrice)) ||
      !Number.isFinite(Number(botPrice)) ||
      Number(topPrice) <= Number(botPrice)
    ) {
      return;
    }

    const lastClose = lastCandleRef.current?.close ?? 0;
    if (lastClose > 0 && (Number(botPrice) > lastClose * 2.5 || Number(topPrice) < lastClose * 0.4)) {
      if (autoScaleHealAttemptsRef.current < 2) {
        autoScaleHealAttemptsRef.current += 1;
        try {
          chart.priceScale("right").applyOptions({ autoScale: true });
        } catch {
          /* ignore */
        }
        if (boundsRafRef.current === null) {
          boundsRafRef.current = requestAnimationFrame(() => {
            boundsRafRef.current = null;
            emitMasterBounds();
          });
        }
      }
      return;
    }

    autoScaleHealAttemptsRef.current = 0;
    const rect = el.getBoundingClientRect();
    priceSyncControllerRef.current.publishBounds({
      symbol: paneSymbolRef.current,
      topPrice: Number(topPrice),
      botPrice: Number(botPrice),
      masterTop: rect.top,
      masterPaneHeight: paneH,
    });
  }, [getPaneHeight]);

  const scheduleEmitBounds = useCallback(() => {
    if (!priceSyncMasterRef.current || !priceSyncControllerRef.current) return;
    if (boundsRafRef.current !== null) return;
    boundsRafRef.current = requestAnimationFrame(() => {
      boundsRafRef.current = null;
      emitMasterBounds();
    });
  }, [emitMasterBounds]);

  // Create chart instance on container / theme / precision changes
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const minMove = getMinMove(pipDigits);
    const chart = createChart(el, {
      layout: {
        background: { type: ColorType.Solid, color: colors.background },
        textColor: colors.text,
        fontFamily: "'JetBrains Mono', 'SF Mono', 'Fira Code', 'Cascadia Code', monospace",
        fontSize: 15,
      },
      grid: {
        vertLines: { color: colors.grid, style: LineStyle.Dotted },
        horzLines: { color: colors.grid, style: LineStyle.Dotted },
      },
      rightPriceScale: {
        borderColor: colors.grid,
        scaleMargins: { top: 0.06, bottom: 0.18 },
        alignLabels: true,
        borderVisible: true,
        ticksVisible: true,
        minimumWidth: 96,
      },
      timeScale: {
        borderColor: colors.grid,
        timeVisible: true,
        secondsVisible: parseTimeframeSeconds(paneTf) <= 60,
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: colors.crosshair, labelBackgroundColor: colors.crosshair },
        horzLine: {
          color: colors.crosshair,
          style: LineStyle.Dashed,
          labelBackgroundColor: "#363a45",
        },
      },
      width: el.clientWidth || 300,
      height: el.clientHeight || 200,
    });

    const candleSeries = chart.addCandlestickSeries({
      upColor: colors.up,
      downColor: colors.down,
      borderUpColor: colors.up,
      borderDownColor: colors.down,
      wickUpColor: colors.up,
      wickDownColor: colors.down,
      priceFormat: { type: "price", precision: pipDigits, minMove },
      lastValueVisible: true,
      priceLineVisible: true,
      priceLineWidth: 1,
      priceLineColor: "",
      priceLineStyle: LineStyle.Dotted,
    });

    const volSeries = chart.addHistogramSeries({
      priceFormat: { type: "volume" },
      priceScaleId: "",
      lastValueVisible: false,
      priceLineVisible: false,
      visible: effectiveShowVolumeRef.current,
    });
    volSeries.priceScale().applyOptions({
      scaleMargins: { top: 0.84, bottom: 0 },
    });

    const volMaSeries = chart.addLineSeries({
      priceFormat: { type: "volume" },
      priceScaleId: "",
      color: "#2962FF",
      lineWidth: 2,
      lastValueVisible: false,
      priceLineVisible: false,
      visible: effectiveShowVolumeMaRef.current,
    });

    chartRef.current = chart;
    candleSeriesRef.current = candleSeries;
    volSeriesRef.current = volSeries;
    volMaSeriesRef.current = volMaSeries;
    overlaySeriesRef.current.clear();
    overlayStructureKeyRef.current = "";
    vpvrPrimRef.current = null;
    smcPrimRef.current = null;
    extendedHoursPrimRef.current = null;
    prevPaneKeyRef.current = "";

    const drawingManager = new DrawingToolsManager({
      chart,
      series: candleSeries,
      container: el,
      intervalSec: TF_SECONDS[paneTfRef.current] ?? 60,
      timeframe: paneTfRef.current,
      accountEquity: accountEquityRef.current,
      callbacks: {
        onAdd: (d) => onAddDrawingRef.current(d),
        onUpdate: (d) => onUpdateDrawingRef.current(d),
        onRemove: (id) => onRemoveDrawingRef.current(id),
        onToolFinished: () => onDrawingCompleteRef.current?.(),
        onSelectionChange: (ids) => {
          setSelectedDrawingIds(ids);
          setShowDrawingSettings(false);
        },
        onRequestSettings: (id) => {
          setSelectedDrawingIds([id]);
          setShowDrawingSettings(true);
        },
        onContextMenu: (id, clientX, clientY) => {
          setSelectedDrawingIds([id]);
          setContextMenu({ id, x: clientX, y: clientY });
        },
        onSelectTool: (t) => onDrawingToolSelectRef.current?.(t),
        onUndo: () => onUndoDrawingRef.current(),
        onRedo: () => onRedoDrawingRef.current(),
      },
    });
    drawingManager.setTool(replayPickingRef.current ? "none" : drawingToolRef.current);
    drawingManager.setDrawings(drawingsRef.current);
    drawingManager.setMagnetMode(magnetRef.current);
    drawingManager.setStyleDefaults(styleDefaultsRef.current);
    drawingManager.setStayInDrawingMode(stayInModeRef.current);
    drawingManagerRef.current = drawingManager;

    const handleCrosshairMove = (param: { point?: { x: number; y: number } }) => {
      if (!priceSyncMasterRef.current || !priceSyncControllerRef.current) return;
      if (!param?.point || param.point.y < 0) {
        priceSyncControllerRef.current.clearHoverFrom("right");
        return;
      }
      const p = candleSeries.coordinateToPrice(param.point.y);
      if (p === null || !Number.isFinite(Number(p))) return;
      const top = el.getBoundingClientRect().top;
      priceSyncControllerRef.current.publishHover({
        source: "right",
        price: Number(p),
        clientY: top + param.point.y,
      });
    };
    chart.subscribeCrosshairMove(handleCrosshairMove);

    const handleLogicalRangeChange = () => {
      scheduleEmitBounds();
    };
    chart.timeScale().subscribeVisibleLogicalRangeChange(handleLogicalRangeChange);

    const handleMouseLeave = () => {
      priceSyncControllerRef.current?.clearHoverFrom("right");
    };
    const handlePointerMove = (e: PointerEvent) => {
      if (e.buttons !== 0) scheduleEmitBounds();
    };
    const handleInteraction = () => {
      scheduleEmitBounds();
    };
    el.addEventListener("mouseleave", handleMouseLeave);
    el.addEventListener("pointermove", handlePointerMove);
    el.addEventListener("pointerup", handleInteraction);
    el.addEventListener("wheel", handleInteraction, { passive: true });
    el.addEventListener("dblclick", handleInteraction);

    const ro =
      typeof ResizeObserver !== "undefined"
        ? new ResizeObserver((entries) => {
            for (const entry of entries) {
              const { width, height } = entry.contentRect;
              if (width > 0 && height > 0) {
                chart.applyOptions({ width, height });
                scheduleEmitBounds();
              }
            }
          })
        : null;
    ro?.observe(el);

    return () => {
      ro?.disconnect();
      el.removeEventListener("mouseleave", handleMouseLeave);
      el.removeEventListener("pointermove", handlePointerMove);
      el.removeEventListener("pointerup", handleInteraction);
      el.removeEventListener("wheel", handleInteraction);
      el.removeEventListener("dblclick", handleInteraction);
      try {
        chart.unsubscribeCrosshairMove(handleCrosshairMove);
        chart.timeScale().unsubscribeVisibleLogicalRangeChange(handleLogicalRangeChange);
      } catch {
        /* ignore */
      }
      if (vpvrPrimRef.current) {
        try {
          candleSeries.detachPrimitive(vpvrPrimRef.current);
        } catch {
          /* ignore */
        }
        vpvrPrimRef.current = null;
      }
      if (smcPrimRef.current) {
        try {
          candleSeries.detachPrimitive(smcPrimRef.current);
        } catch {
          /* ignore */
        }
        smcPrimRef.current = null;
      }
      if (extendedHoursPrimRef.current) {
        try {
          candleSeries.detachPrimitive(extendedHoursPrimRef.current);
        } catch {
          /* ignore */
        }
        extendedHoursPrimRef.current = null;
      }
      drawingManager.destroy();
      drawingManagerRef.current = null;
      try {
        chart.remove();
      } catch {
        /* ignore */
      }
      chartRef.current = null;
      candleSeriesRef.current = null;
      volSeriesRef.current = null;
      volMaSeriesRef.current = null;
      overlaySeriesRef.current.clear();
      overlayStructureKeyRef.current = "";
    };
  }, [
    colors.background,
    colors.crosshair,
    colors.down,
    colors.grid,
    colors.text,
    colors.up,
    pipDigits,
    scheduleEmitBounds,
  ]);

  const handleZoomIn = useCallback(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const timeScale = chart.timeScale();
    const range = timeScale.getVisibleLogicalRange();
    if (!range) {
      timeScale.fitContent();
      return;
    }
    const count = range.to - range.from;
    const delta = count * 0.25;
    const newFrom = range.from + delta / 2;
    const newTo = range.to - delta / 2;
    if (newTo - newFrom >= 4) {
      timeScale.setVisibleLogicalRange({ from: newFrom, to: newTo });
    }
  }, []);

  const handleZoomOut = useCallback(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const timeScale = chart.timeScale();
    const range = timeScale.getVisibleLogicalRange();
    if (!range) {
      timeScale.fitContent();
      return;
    }
    const count = range.to - range.from;
    const delta = count * 0.3;
    const newFrom = range.from - delta / 2;
    const newTo = range.to + delta / 2;
    timeScale.setVisibleLogicalRange({ from: newFrom, to: newTo });
  }, []);

  // Sync volume & Volume MA(20) visibility immediately when toggled from toolbar
  useEffect(() => {
    volSeriesRef.current?.applyOptions({ visible: effectiveShowVolume });
    volMaSeriesRef.current?.applyOptions({ visible: effectiveShowVolumeMa });
  }, [effectiveShowVolume, effectiveShowVolumeMa]);

  const sessionCtx = useMemo(() => {
    const demoSym = getDemoSymbol(paneSymbol);
    const isStock = (symbolInfo?.category ?? demoSym?.category ?? "").toUpperCase() === "STOCKS";
    const meta = isStock ? getStockSessionMetadata(paneSymbol, paneTf) : null;
    const exchange = demoSym?.exchange;
    const isIntraday = paneTf !== "1d" && paneTf !== "1w";
    const isUsStock =
      isStock && (meta?.timezone === "America/New_York" || isUsEquityExchange(exchange));
    return { isStock, meta, exchange, isIntraday, isUsStock };
  }, [paneSymbol, paneTf, symbolInfo]);

  const displayCandles = useMemo(() => {
    if (sessionCtx.isStock && sessionCtx.isIntraday && !chartPrefs.showExtendedHours) {
      return filterExtendedHoursCandles(candles, false, sessionCtx.meta, sessionCtx.exchange);
    }
    return candles;
  }, [candles, sessionCtx, chartPrefs.showExtendedHours]);

  const hasExtendedFilterFallback = useMemo(
    () =>
      sessionCtx.isStock &&
      sessionCtx.isIntraday &&
      !chartPrefs.showExtendedHours &&
      candles.length > 0 &&
      displayCandles === candles,
    [sessionCtx, chartPrefs.showExtendedHours, candles, displayCandles],
  );

  const tick = ticks[paneSymbol];
  const liveCandle = useTradingStore((s) => s.liveCandleUpdates[`${paneSymbol}:${paneTf}`]);
  const liveDisplayCandles = useMemo(() => {
    if (isReplaying || displayCandles.length === 0) {
      return displayCandles;
    }
    const allowTime = (timeSec: number) =>
      !sessionCtx.isStock ||
      !sessionCtx.isIntraday ||
      chartPrefs.showExtendedHours ||
      hasExtendedFilterFallback ||
      classifyExtendedSession(timeSec, sessionCtx.meta, sessionCtx.exchange) === "regular";

    let working = displayCandles;
    if (liveCandle && liveCandle.timestamp > 0 && liveCandle.close > 0) {
      const liveTs = toUnixSeconds(liveCandle.timestamp);
      const last = displayCandles[displayCandles.length - 1]!;
      if (Number.isFinite(liveTs) && liveTs >= last.time && allowTime(liveTs)) {
        const liveRow: PaneCandle = {
          time: liveTs,
          open: liveCandle.open,
          high: liveCandle.high,
          low: liveCandle.low,
          close: liveCandle.close,
          volume:
            liveTs === last.time
              ? Math.max(last.volume ?? 0, liveCandle.volume ?? 0)
              : (liveCandle.volume ?? 0),
        };
        working = liveTs === last.time ? [...displayCandles.slice(0, -1), liveRow] : [...displayCandles, liveRow];
      }
    }

    // For IBKR US Equities (`TRADES`) and Crypto exchange streams, candle OHLC, EMA 9, and VWAP
    // must use ONLY authoritative trade bars — never `(bid + ask) / 2` L1 quote midpoints.
    if (sessionCtx.isStock || isCryptoInstrument(paneSymbol)) {
      return working;
    }

    if (!tick || !(tick.timestamp > 0)) {
      return working;
    }
    const price = (tick.bid + tick.ask) / 2;
    if (!Number.isFinite(price) || price <= 0) return working;
    const bucket = getCandleBucketTime(tick.timestamp, paneTf);
    const tail = working[working.length - 1]!;
    if (bucket < tail.time || !allowTime(bucket)) return working;

    const tfSec = TF_SECONDS[paneTf] ?? 60;
    const isSessionGap = bucket - tail.time > tfSec * 1.5;
    if (!isSessionGap) {
      const maxDev = Math.max(Math.max(tail.open, tail.close) * 0.2, 1e-8);
      if (Math.abs(price - tail.open) > maxDev && Math.abs(price - tail.close) > maxDev) {
        return working;
      }
    }
    if (bucket === tail.time) {
      const updated: PaneCandle = {
        ...tail,
        high: Math.max(tail.high, price),
        low: Math.min(tail.low, price),
        close: price,
      };
      return [...working.slice(0, -1), updated];
    }
    if (sessionCtx.isStock || isCryptoInstrument(paneSymbol)) {
      return working;
    }
    const seedOpen = isSessionGap ? price : tail.close;
    return [
      ...working,
      {
        time: bucket,
        open: seedOpen,
        high: Math.max(seedOpen, price),
        low: Math.min(seedOpen, price),
        close: price,
        volume: 0,
      },
    ];
  }, [
    isReplaying,
    displayCandles,
    liveCandle,
    tick,
    paneSymbol,
    paneTf,
    sessionCtx,
    chartPrefs.showExtendedHours,
    hasExtendedFilterFallback,
  ]);

  // Populate candles, volume, Volume MA(20), Replay viewport sync, and extended-hours shading
  useEffect(() => {
    const chart = chartRef.current;
    const candleSeries = candleSeriesRef.current;
    const volSeries = volSeriesRef.current;
    if (!chart || !candleSeries || !volSeries) return;

    if (displayCandles.length === 0) {
      try {
        candleSeries.setData([]);
        volSeries.setData([]);
        volMaSeriesRef.current?.setData([]);
      } catch {
        /* ignore */
      }
      if (extendedHoursPrimRef.current) {
        try {
          candleSeries.detachPrimitive(extendedHoursPrimRef.current);
        } catch {
          /* ignore */
        }
        extendedHoursPrimRef.current = null;
      }
      lastCandleRef.current = null;
      prev19VolSumRef.current = 0;
      hasVolumeMaRef.current = false;
      priceSyncControllerRef.current?.publishBounds(null);
      return;
    }

    const preSetDataRange = chart.timeScale().getVisibleLogicalRange();

    const chartCandles: CandlestickData<Time>[] = displayCandles.map((c) => ({
      time: c.time as Time,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
    }));
    const volData: HistogramData<Time>[] = displayCandles.map((c) => ({
      time: c.time as Time,
      value: c.volume ?? 0,
      color: c.close >= c.open ? colors.volumeUp : colors.volumeDown,
    }));
    const tfSecForVol = TF_SECONDS[paneTf] ?? parseTimeframeSeconds(paneTf);
    const volMaData: LineData<Time>[] =
      isReplaying && replaySimTimeSec > 0
        ? calculateReplayVolumeMa(volData, tfSecForVol, replaySimTimeSec, 20)
        : calculateVolumeMa(volData, 20);
    if (volData.length >= 20) {
      const prev19: number[] = [];
      let s19 = 0;
      for (let i = volData.length - 20; i < volData.length - 1; i++) {
        const v = volData[i]!.value;
        prev19.push(v);
        s19 += v;
      }
      recentVolsRef.current = prev19;
      prev19VolSumRef.current = s19;
      hasVolumeMaRef.current = true;
    } else {
      recentVolsRef.current = volData.slice(0, -1).map((d) => d.value);
      prev19VolSumRef.current = recentVolsRef.current.reduce((a, b) => a + b, 0);
      hasVolumeMaRef.current = false;
    }

    candleSeries.setData(chartCandles);
    volSeries.setData(volData);
    volMaSeriesRef.current?.setData(volMaData);

    const paneKey = `${paneSymbol}:${paneTf}:${chartPrefs.showExtendedHours ? "ext" : "rth"}`;
    const isPaneChanged = prevPaneKeyRef.current !== paneKey;
    prevPaneKeyRef.current = paneKey;

    const isEnteringReplay = !wasReplayingRef.current && isReplaying;
    const isExitingReplay = wasReplayingRef.current && !isReplaying;
    wasReplayingRef.current = isReplaying;

    const last = displayCandles[displayCandles.length - 1]!;
    lastCandleRef.current = {
      symbol: paneSymbol,
      time: last.time,
      open: last.open,
      high: last.high,
      low: last.low,
      close: last.close,
      volume: last.volume ?? 0,
    };

    if (isReplaying) {
      const latestBarTime = last.time;
      const prevBarTime = prevReplayLastTimeRef.current;
      const delta =
        prevReplayLenRef.current > 0 ? displayCandles.length - prevReplayLenRef.current : 0;
      const tfSec = TF_SECONDS[paneTf] ?? 60;
      const isIntraBarStep =
        !isEnteringReplay &&
        !isPaneChanged &&
        prevReplayLenRef.current > 0 &&
        delta === 0 &&
        prevBarTime > 0 &&
        latestBarTime === prevBarTime;
      const isSequentialStep =
        isIntraBarStep ||
        (!isEnteringReplay &&
          !isPaneChanged &&
          prevReplayLenRef.current > 0 &&
          Math.abs(delta) === 1 &&
          prevBarTime > 0 &&
          Math.abs(latestBarTime - prevBarTime) <= tfSec * 2);

      prevReplayLenRef.current = displayCandles.length;
      prevReplayLastTimeRef.current = latestBarTime;

      if (!isSequentialStep) {
        autoScaleHealAttemptsRef.current = 0;
        const lastIdx = displayCandles.length - 1;
        const cutOffset = replayCutOffsetRef.current;
        replayCutOffsetRef.current = null;
        const targetRange = (cutOffset
          ? { from: lastIdx - cutOffset.barsLeft, to: lastIdx + cutOffset.barsRight }
          : {
              from: lastIdx - (paneTf === "1m" ? 75 : 60),
              to: lastIdx + (paneTf === "1m" ? 18 : 12),
            }) as unknown as LogicalRange;
        try {
          chart.priceScale("right").applyOptions({ autoScale: true });
          chart.timeScale().setVisibleLogicalRange(targetRange);
        } catch {
          /* ignore */
        }
      } else if (preSetDataRange) {
        try {
          chart.timeScale().setVisibleLogicalRange({
            from: preSetDataRange.from + delta,
            to: preSetDataRange.to + delta,
          } as unknown as LogicalRange);
        } catch {
          /* ignore */
        }
      }
    } else {
      prevReplayLenRef.current = 0;
      prevReplayLastTimeRef.current = 0;
      if (isPaneChanged || isExitingReplay) {
        autoScaleHealAttemptsRef.current = 0;
        try {
          chart.priceScale("right").applyOptions({ autoScale: true });
          chart.timeScale().resetTimeScale();
          chart.timeScale().scrollToPosition(paneTf === "1m" ? 10 : 6, false);
        } catch {
          /* ignore */
        }
      }
    }

    // Extended-hours overlay (Yellow Pre-Market)
    if (sessionCtx.isStock && sessionCtx.isIntraday && chartPrefs.showExtendedHours) {
      if (extendedHoursPrimRef.current) {
        extendedHoursPrimRef.current.updateOptions({
          meta: sessionCtx.meta,
          exchange: sessionCtx.exchange,
          isDark,
        });
      } else {
        const prim = new ExtendedHoursPrimitive({
          meta: sessionCtx.meta,
          exchange: sessionCtx.exchange,
          isDark,
        });
        try {
          candleSeries.attachPrimitive(prim);
          extendedHoursPrimRef.current = prim;
        } catch {
          /* ignore */
        }
      }
    } else if (extendedHoursPrimRef.current) {
      try {
        candleSeries.detachPrimitive(extendedHoursPrimRef.current);
      } catch {
        /* ignore */
      }
      extendedHoursPrimRef.current = null;
    }

    scheduleEmitBounds();
  }, [
    displayCandles,
    chartPrefs.showExtendedHours,
    colors.volumeDown,
    colors.volumeUp,
    isDark,
    isReplaying,
    replaySimTimeSec,
    paneSymbol,
    paneTf,
    sessionCtx,
    scheduleEmitBounds,
  ]);

  const paneAnchorAtRegularOpen =
    sessionCtx.isUsStock && !chartPrefs.showExtendedHours && !hasExtendedFilterFallback;
  const paneVwapSource = (indicatorSettings.vwap ?? DEFAULT_INDICATOR_SETTINGS.vwap).source;

  const paneVwapSeed = useMemo(() => {
    if (!sessionCtx.isUsStock) return null;
    if (isReplaying) {
      if (!(replaySimTimeSec > 0) || liveDisplayCandles.length === 0) return null;
      return computeCausalReplayVwapSeed(
        paneSymbol,
        liveDisplayCandles[0]!.time,
        replaySimTimeSec,
        {
          sessionTimeZone: "america-new-york",
          anchorAtRegularOpen: paneAnchorAtRegularOpen,
          source: paneVwapSource,
        },
      );
    }
    return getStockVwapSeed(paneSymbol, chartPrefs.showExtendedHours, paneTf);
  }, [
    sessionCtx.isUsStock,
    isReplaying,
    replaySimTimeSec,
    liveDisplayCandles,
    paneSymbol,
    paneAnchorAtRegularOpen,
    paneVwapSource,
    chartPrefs.showExtendedHours,
    paneTf,
  ]);

  const paneFine1mVwapBundle = useMemo(() => {
    const tfSec = parseTimeframeSeconds(paneTf);
    if (tfSec <= 60 || tfSec >= 86_400) {
      return { candles: null as PaneCandle[] | null, rawCoverageStartSec: undefined as number | undefined };
    }
    if (!sessionCtx.isStock && !isCryptoInstrument(paneSymbol)) {
      return { candles: null, rawCoverageStartSec: undefined };
    }
    if (sessionCtx.isStock && !hasRealStockSeries(paneSymbol) && !isReplaying) {
      return { candles: null, rawCoverageStartSec: undefined };
    }
    const raw1m =
      isReplaying && replaySimTimeSec > 0
        ? getReplaySliceForTimeframe(paneSymbol, "1m", replaySimTimeSec)
        : getHistory(paneSymbol, "1m");
    if (raw1m.length === 0) {
      return { candles: null, rawCoverageStartSec: undefined };
    }
    if (sessionCtx.isStock && !chartPrefs.showExtendedHours && !hasExtendedFilterFallback) {
      const rth1m = filterExtendedHoursCandles(raw1m, false, sessionCtx.meta, sessionCtx.exchange);
      return {
        candles: rth1m,
        rawCoverageStartSec: rth1m.length > 0 ? rth1m[0]!.time : undefined,
      };
    }
    return { candles: raw1m, rawCoverageStartSec: raw1m[0]!.time };
  }, [
    paneTf,
    paneSymbol,
    sessionCtx,
    isReplaying,
    replaySimTimeSec,
    chartPrefs.showExtendedHours,
    hasExtendedFilterFallback,
    liveDisplayCandles,
  ]);
  const paneFine1mVwapCandles = paneFine1mVwapBundle.candles;
  const paneRawCoverageStartSec = paneAnchorAtRegularOpen
    ? liveDisplayCandles.length > 0
      ? liveDisplayCandles[0]!.time
      : undefined
    : candles.length > 0
      ? candles[0]!.time
      : undefined;

  // Overlay indicators (EMA, VWAP + bands, SMA, BOLL, VPVR, SMC) reused in-place without 5s flicker and updated on live ticks
  useEffect(() => {
    const chart = chartRef.current;
    const candleSeries = candleSeriesRef.current;
    if (!chart || !candleSeries) return;

    const detachOverlayPrimitives = () => {
      if (vpvrPrimRef.current) {
        try {
          candleSeries.detachPrimitive(vpvrPrimRef.current);
        } catch {
          /* ignore */
        }
        vpvrPrimRef.current = null;
      }
      if (smcPrimRef.current) {
        try {
          candleSeries.detachPrimitive(smcPrimRef.current);
        } catch {
          /* ignore */
        }
        smcPrimRef.current = null;
      }
    };

    if (liveDisplayCandles.length === 0) {
      for (const oldSeries of overlaySeriesRef.current.values()) {
        try {
          chart.removeSeries(oldSeries);
        } catch {
          /* ignore */
        }
      }
      overlaySeriesRef.current.clear();
      overlayStructureKeyRef.current = "";
      detachOverlayPrimitives();
      return;
    }

    const overlayPriceFormat = {
      type: "price" as const,
      precision: pipDigits,
      minMove: getMinMove(pipDigits),
    };

    const nextOverlayKey = [
      paneSymbol,
      paneTf,
      isDark ? "1" : "0",
      String(pipDigits),
      showEma ? "1" : "0",
      showVwap ? "1" : "0",
      showSma ? "1" : "0",
      showBb ? "1" : "0",
      JSON.stringify(indicatorSettings),
      sessionCtx.isUsStock ? "ny" : "utc",
      chartPrefs.showExtendedHours ? "ext" : "rth",
      paneAnchorAtRegularOpen ? "rth930" : "sess",
    ].join("|");

    const canReuseOverlays = overlayStructureKeyRef.current === nextOverlayKey;
    if (!canReuseOverlays) {
      for (const oldSeries of overlaySeriesRef.current.values()) {
        try {
          chart.removeSeries(oldSeries);
        } catch {
          /* ignore */
        }
      }
      overlaySeriesRef.current.clear();
      overlayStructureKeyRef.current = nextOverlayKey;
    }

    const upsertOverlayLine = (
      key: string,
      opts: Parameters<IChartApi["addLineSeries"]>[0],
      pts: ReadonlyArray<{ time: number; value: number }>,
    ) => {
      const existing = canReuseOverlays ? overlaySeriesRef.current.get(key) : undefined;
      const s = existing ?? chart.addLineSeries(opts);
      s.setData(pts.map((p) => ({ time: p.time as Time, value: p.value })));
      if (!existing) overlaySeriesRef.current.set(key, s);
    };

    const indCandles = toIndicatorCandles(
      liveDisplayCandles.map((c) => ({ ...c, time: c.time as Time })),
    );

    if (showEma) {
      const emaLines = (
        indicatorSettings.ema?.lines ?? DEFAULT_INDICATOR_SETTINGS.ema.lines
      ).filter((l) => l.enabled && l.period >= 1);
      for (const line of emaLines) {
        const emaPts = isReplaying
          ? computeReplayEmaWithWarmup(indCandles, line.period).points
          : ema(indCandles, line.period);
        upsertOverlayLine(
          `EMA:${line.id}:${line.period}`,
          {
            color: line.color,
            lineWidth: Math.min(4, Math.max(1, Math.round(line.lineWidth))) as 1 | 2 | 3 | 4,
            priceScaleId: "right",
            priceLineVisible: false,
            lastValueVisible: true,
            priceFormat: overlayPriceFormat,
          },
          emaPts,
        );
      }
    }

    if (showVwap) {
      const vwapCfg = indicatorSettings.vwap ?? DEFAULT_INDICATOR_SETTINGS.vwap;
      const anchor =
        vwapCfg.anchor === "auto"
          ? defaultVwapAnchorForTimeframe(paneTf)
          : vwapCfg.anchor;
      const paneTfSec = parseTimeframeSeconds(paneTf);
      const paneVwapTz = sessionCtx.isUsStock ? "america-new-york" : "utc";
      const vwapData = computeFineGrainedSessionVwap(
        indCandles,
        paneFine1mVwapCandles,
        paneTfSec,
        {
          anchor,
          multipliers: [
            vwapCfg.band1.multiplier,
            vwapCfg.band2.multiplier,
            vwapCfg.band3.multiplier,
          ],
          sessionTimeZone: paneVwapTz,
          source: vwapCfg.source,
          priorSessionSeed: anchor === "session" ? (paneVwapSeed ?? undefined) : undefined,
          anchorAtRegularOpen: paneAnchorAtRegularOpen,
          rawCoverageStartSec: paneRawCoverageStartSec,
          fineRawCoverageStartSec: paneFine1mVwapBundle.rawCoverageStartSec,
          requireCompleteSession: sessionCtx.isUsStock || isReplaying,
        },
      );
      if (isReplaying && anchor === "session" && paneTfSec > 60 && indCandles.length > 0) {
        const lastBar = indCandles[indCandles.length - 1]!;
        const lastDay =
          paneVwapTz === "america-new-york"
            ? getNyTradingDayKey(lastBar.time)
            : getVwapAnchorBucket(lastBar.time, "session", paneVwapTz);
        const hasCurrentDayVwap = vwapData.vwap.some((pt) => {
          const ptDay =
            paneVwapTz === "america-new-york"
              ? getNyTradingDayKey(pt.time)
              : getVwapAnchorBucket(pt.time, "session", paneVwapTz);
          return ptDay === lastDay;
        });
        if (!hasCurrentDayVwap) {
          const st = useReplayStore.getState();
          if (!st.dataWarning) {
            st.setDataWarning(
              `VWAP oculto en ${paneTf}: falta histórico real completo de 1m para esta sesión.`,
            );
          }
        }
      }
      upsertOverlayLine(
        "VWAP",
        {
          color: vwapCfg.color,
          lineWidth: Math.min(4, Math.max(1, Math.round(vwapCfg.lineWidth))) as 1 | 2 | 3 | 4,
          priceScaleId: "right",
          priceLineVisible: false,
          lastValueVisible: true,
          priceFormat: overlayPriceFormat,
        },
        vwapData.vwap,
      );

      const bands = [
        [vwapCfg.band1, vwapData.upper1, vwapData.lower1, "1"],
        [vwapCfg.band2, vwapData.upper2, vwapData.lower2, "2"],
        [vwapCfg.band3, vwapData.upper3, vwapData.lower3, "3"],
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
        };
        upsertOverlayLine(`VWAP-upper${idx}`, bandOpts, upperPts);
        upsertOverlayLine(`VWAP-lower${idx}`, bandOpts, lowerPts);
      }
    }

    if (showSma) {
      upsertOverlayLine(
        "SMA",
        {
          color: "#a855f7",
          lineWidth: 2,
          priceScaleId: "right",
          priceLineVisible: false,
          lastValueVisible: false,
          priceFormat: overlayPriceFormat,
        },
        sma(indCandles, 20),
      );
    }

    if (showBb) {
      const bb = bollingerBands(indCandles, 20, 2);
      upsertOverlayLine(
        "BOLL-upper",
        {
          color: "rgba(6, 182, 212, 0.7)",
          lineWidth: 1,
          priceScaleId: "right",
          priceLineVisible: false,
          lastValueVisible: false,
          priceFormat: overlayPriceFormat,
        },
        bb.upper,
      );
      upsertOverlayLine(
        "BOLL-mid",
        {
          color: "#06b6d4",
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          priceScaleId: "right",
          priceLineVisible: false,
          lastValueVisible: false,
          priceFormat: overlayPriceFormat,
        },
        bb.middle,
      );
      upsertOverlayLine(
        "BOLL-lower",
        {
          color: "rgba(6, 182, 212, 0.7)",
          lineWidth: 1,
          priceScaleId: "right",
          priceLineVisible: false,
          lastValueVisible: false,
          priceFormat: overlayPriceFormat,
        },
        bb.lower,
      );
    }

    // VPVR overlay
    if (showVpvr) {
      const vpvrInput = {
        candles: indCandles,
        settings: indicatorSettings.vpvr,
        isDark,
        pipDigits,
      };
      if (vpvrPrimRef.current) {
        vpvrPrimRef.current.updateData(vpvrInput);
      } else {
        const prim = new VolumeProfilePrimitive(vpvrInput);
        try {
          candleSeries.attachPrimitive(prim);
          vpvrPrimRef.current = prim;
        } catch {
          /* ignore */
        }
      }
    } else if (vpvrPrimRef.current) {
      try {
        candleSeries.detachPrimitive(vpvrPrimRef.current);
      } catch {
        /* ignore */
      }
      vpvrPrimRef.current = null;
    }

    // SMC overlay
    if (showSmc) {
      const smcInput = {
        structure: computeMarketStructure(indCandles, {
          swingLength: indicatorSettings.smc.swingLength,
        }),
        settings: indicatorSettings.smc,
        isDark,
      };
      if (smcPrimRef.current) {
        smcPrimRef.current.updateData(smcInput);
      } else {
        const prim = new MarketStructurePrimitive(smcInput);
        try {
          candleSeries.attachPrimitive(prim);
          smcPrimRef.current = prim;
        } catch {
          /* ignore */
        }
      }
    } else if (smcPrimRef.current) {
      try {
        candleSeries.detachPrimitive(smcPrimRef.current);
      } catch {
        /* ignore */
      }
      smcPrimRef.current = null;
    }
  }, [
    liveDisplayCandles,
    indicatorSettings,
    isDark,
    paneSymbol,
    paneTf,
    pipDigits,
    sessionCtx.isUsStock,
    chartPrefs.showExtendedHours,
    paneVwapSeed,
    paneAnchorAtRegularOpen,
    paneFine1mVwapCandles,
    showBb,
    showEma,
    showSma,
    showSmc,
    showVpvr,
    showVwap,
  ]);

  // Replay bar-picker click subscription on secondary panes
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !replayPicking || !onPickReplayBar) return;

    const handler = (param: { time?: Time; point?: { x: number; y: number } }) => {
      let clickedTime = param?.time as number | undefined;
      if (!clickedTime && param?.point) {
        const t = chart.timeScale().coordinateToTime(param.point.x);
        if (typeof t === "number") clickedTime = t;
      }
      if (typeof clickedTime === "number" && Number.isFinite(clickedTime)) {
        const oldRange = chart.timeScale().getVisibleLogicalRange();
        let oldCutIdx = -1;
        for (let i = displayCandles.length - 1; i >= 0; i--) {
          if (displayCandles[i]!.time <= clickedTime) {
            oldCutIdx = i;
            break;
          }
        }
        if (oldRange && oldCutIdx >= 0) {
          replayCutOffsetRef.current = {
            barsLeft: Math.max(15, oldCutIdx - oldRange.from),
            barsRight: Math.max(6, oldRange.to - oldCutIdx),
          };
        } else {
          replayCutOffsetRef.current = null;
        }
        onPickReplayBar(clickedTime, paneTf);
      }
    };

    chart.subscribeClick(handler);
    return () => {
      try {
        chart.unsubscribeClick(handler);
      } catch {
        /* ignore */
      }
    };
  }, [replayPicking, onPickReplayBar, displayCandles, paneTf, pipDigits, isDark]);

  // Authoritative real-time OHLCV updates (IBKR 1s base / bus CandleUpdate)
  useEffect(() => {
    if (isReplaying || !liveCandle) return;
    const candleSeries = candleSeriesRef.current;
    const last = lastCandleRef.current;
    if (!candleSeries || !last || last.symbol !== paneSymbol) return;
    const ts = toUnixSeconds(liveCandle.timestamp);
    if (!Number.isFinite(ts) || ts <= 0 || ts < last.time) return;
    if (
      !Number.isFinite(liveCandle.open) ||
      liveCandle.open <= 0 ||
      !Number.isFinite(liveCandle.close) ||
      liveCandle.close <= 0
    ) {
      return;
    }
    if (sessionCtx.isStock && sessionCtx.isIntraday && !chartPrefs.showExtendedHours && !hasExtendedFilterFallback) {
      if (classifyExtendedSession(ts, sessionCtx.meta, sessionCtx.exchange) !== "regular") {
        return;
      }
    }
    const isNewBucket = ts > last.time;
    if (isNewBucket) {
      const nextWindow = [...recentVolsRef.current, last.volume].slice(-19);
      recentVolsRef.current = nextWindow;
      prev19VolSumRef.current = nextWindow.reduce((acc, v) => acc + v, 0);
      hasVolumeMaRef.current = nextWindow.length >= 19;
    }
    const nextVol =
      ts === last.time
        ? Math.max(last.volume, liveCandle.volume ?? 0)
        : (liveCandle.volume ?? 0);
    const next = {
      symbol: paneSymbol,
      time: ts,
      open: liveCandle.open,
      high: liveCandle.high,
      low: liveCandle.low,
      close: liveCandle.close,
      volume: nextVol,
    };
    lastCandleRef.current = next;
    try {
      candleSeries.update({
        time: next.time as Time,
        open: next.open,
        high: next.high,
        low: next.low,
        close: next.close,
      });
      volSeriesRef.current?.update({
        time: next.time as Time,
        value: next.volume,
        color: next.close >= next.open ? colors.volumeUp : colors.volumeDown,
      });
      if (volMaSeriesRef.current && hasVolumeMaRef.current) {
        volMaSeriesRef.current.update({
          time: next.time as Time,
          value: Number(((prev19VolSumRef.current + next.volume) / 20).toFixed(2)),
        });
      }
      scheduleEmitBounds();
    } catch {
      /* ignore out-of-order lightweight-charts update */
    }
  }, [
    isReplaying,
    liveCandle,
    paneSymbol,
    sessionCtx,
    chartPrefs.showExtendedHours,
    hasExtendedFilterFallback,
    colors.volumeUp,
    colors.volumeDown,
    scheduleEmitBounds,
  ]);

  // Live tick updates on the active candlestick (guarded against out-of-order and outlier timestamps)
  useEffect(() => {
    if (isReplaying) return;
    // IBKR US Equities (`TRADES`) and Crypto exchange streams are driven 100% by real trade bars;
    // never let L1 Bid/Ask midpoint quotes overwrite candle close/high/low.
    if (sessionCtx.isStock || isCryptoInstrument(paneSymbol)) return;
    const candleSeries = candleSeriesRef.current;
    const last = lastCandleRef.current;
    if (!candleSeries || !last || !tick || last.symbol !== paneSymbol) return;

    const price = (tick.bid + tick.ask) / 2;
    if (!(price > 0) || !Number.isFinite(price)) return;

    if (!(tick.timestamp > 0)) return;
    const bucket = getCandleBucketTime(tick.timestamp, paneTf);
    if (bucket < last.time) return;

    const tfSec = TF_SECONDS[paneTf] ?? 60;
    const isSessionGap = bucket - last.time > tfSec * 1.5;
    if (!isSessionGap) {
      const maxDev = Math.max(Math.max(last.open, last.close) * 0.2, 1e-8);
      if (Math.abs(price - last.open) > maxDev && Math.abs(price - last.close) > maxDev) {
        return;
      }
    }

    if (
      sessionCtx.isStock &&
      sessionCtx.isIntraday &&
      !chartPrefs.showExtendedHours &&
      !hasExtendedFilterFallback
    ) {
      if (classifyExtendedSession(bucket, sessionCtx.meta, sessionCtx.exchange) !== "regular") {
        return;
      }
    }

    if (bucket !== last.time && (sessionCtx.isStock || isCryptoInstrument(paneSymbol))) {
      return;
    }

    const next =
      bucket === last.time
        ? {
            symbol: paneSymbol,
            time: last.time,
            open: last.open,
            high: Math.max(last.high, price),
            low: Math.min(last.low, price),
            close: price,
            volume: last.volume,
          }
        : {
            symbol: paneSymbol,
            time: bucket,
            open: price,
            high: price,
            low: price,
            close: price,
            volume: 0,
          };

    lastCandleRef.current = next;
    try {
      candleSeries.update({
        time: next.time as Time,
        open: next.open,
        high: next.high,
        low: next.low,
        close: next.close,
      });
      volSeriesRef.current?.update({
        time: next.time as Time,
        value: next.volume,
        color: next.close >= next.open ? colors.volumeUp : colors.volumeDown,
      });
      if (volMaSeriesRef.current && hasVolumeMaRef.current) {
        volMaSeriesRef.current.update({
          time: next.time as Time,
          value: Number(((prev19VolSumRef.current + next.volume) / 20).toFixed(2)),
        });
      }
      scheduleEmitBounds();
    } catch {
      /* ignore out-of-order lightweight-charts update */
    }
  }, [
    isReplaying,
    tick,
    paneSymbol,
    paneTf,
    sessionCtx,
    chartPrefs.showExtendedHours,
    hasExtendedFilterFallback,
    colors.volumeUp,
    colors.volumeDown,
    scheduleEmitBounds,
  ]);

  // Publish master price bounds & render cross-pane horizontal crosshair when hovering left chart
  useEffect(() => {
    if (!priceSyncMaster || !priceSyncController) {
      priceSyncController?.publishBounds(null);
      priceSyncController?.clearHoverFrom("right");
      if (syncHorzLineRef.current) syncHorzLineRef.current.style.display = "none";
      if (syncPricePillRef.current) syncPricePillRef.current.style.display = "none";
      return;
    }

    emitMasterBounds();
    scheduleEmitBounds();

    const unsubHover = priceSyncController.subscribeHover((hover) => {
      const lineEl = syncHorzLineRef.current;
      const pillEl = syncPricePillRef.current;
      if (!lineEl || !pillEl) return;

      const chart = chartRef.current;
      const series = candleSeriesRef.current;
      const el = containerRef.current;
      if (!hover || hover.source !== "left" || !chart || !series || !el) {
        lineEl.style.display = "none";
        pillEl.style.display = "none";
        return;
      }

      const y = series.priceToCoordinate(hover.price);
      const paneH = getPaneHeight(chart, el);
      if (y === null || !Number.isFinite(Number(y)) || Number(y) < 0 || Number(y) > paneH) {
        lineEl.style.display = "none";
        pillEl.style.display = "none";
        return;
      }

      const yPx = Math.round(Number(y));
      let psWidth = 0;
      try {
        const ps = chart.priceScale("right");
        if (typeof ps.width === "function") psWidth = ps.width();
      } catch {
        /* ignore */
      }

      lineEl.style.display = "block";
      lineEl.style.right = `${psWidth}px`;
      lineEl.style.transform = `translateY(${yPx}px)`;

      pillEl.style.display = "flex";
      pillEl.style.top = `${yPx}px`;
      if (psWidth > 0) {
        pillEl.style.width = `${psWidth}px`;
      }
      pillEl.textContent = formatNumber(hover.price, pipDigitsRef.current);
    });

    const unsubReset = priceSyncController.subscribeResetAutoScale(() => {
      autoScaleHealAttemptsRef.current = 0;
      try {
        chartRef.current?.priceScale("right").applyOptions({ autoScale: true });
      } catch {
        /* ignore */
      }
      scheduleEmitBounds();
    });

    return () => {
      if (boundsRafRef.current !== null) {
        cancelAnimationFrame(boundsRafRef.current);
        boundsRafRef.current = null;
      }
      unsubHover();
      unsubReset();
      priceSyncController.publishBounds(null);
      priceSyncController.clearHoverFrom("right");
      if (syncHorzLineRef.current) syncHorzLineRef.current.style.display = "none";
      if (syncPricePillRef.current) syncPricePillRef.current.style.display = "none";
    };
  }, [priceSyncMaster, priceSyncController, emitMasterBounds, scheduleEmitBounds, getPaneHeight]);

  return (
    <div
      onMouseDownCapture={onFocus}
      data-testid={`multichart-pane-${slotId}`}
      data-timeframe={paneTf}
      data-symbol={paneSymbol}
      className={cn(
        "relative flex flex-col w-full h-full min-w-0 min-h-0 border-0 bg-card transition-shadow",
        isFocused && "ring-1 ring-inset ring-primary/60",
      )}
    >
      {/* Chart Canvas & Synced Crosshair Overlay */}
      <div
        data-testid={`pane-${slotId}-canvas`}
        onDoubleClick={(e) => {
          if (!canExpand || !onToggleExpand || drawingTool !== "none" || replayPicking) return;
          if (
            (e.target as HTMLElement | null)?.closest(
              "button, a, input, select, textarea, [data-testid='drawing-tool-rail']",
            )
          ) {
            return;
          }
          const rect = containerRef.current?.getBoundingClientRect();
          if (
            rect &&
            rect.width > 0 &&
            rect.height > 0 &&
            (e.clientX >= rect.right - 85 || e.clientY >= rect.bottom - 32)
          ) {
            return;
          }
          onToggleExpand();
        }}
        title={
          canExpand
            ? isExpanded
              ? "Doble clic para restaurar vista dividida"
              : "Doble clic para ampliar este gráfico"
            : undefined
        }
        className={cn(
          "flex-1 min-h-0 w-full relative overflow-hidden",
          replayPicking && "cursor-crosshair",
        )}
      >
        <div ref={containerRef} className="w-full h-full relative" />
        {isReplaying && (
          <span
            data-testid={`pane-${slotId}-replay-badge`}
            className="pointer-events-none absolute top-1.5 left-2 z-20 px-1.5 py-0.5 rounded bg-orange-500/15 border border-orange-500/40 text-[10px] font-mono font-bold uppercase text-orange-400"
            title="Este panel está sincronizado en tiempo histórico con el Replay"
          >
            Replay
          </span>
        )}
        {isReplaying && displayCandles.length === 0 && (
          <div
            data-testid={`pane-${slotId}-replay-empty`}
            className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center px-4 text-center"
          >
            <span className="px-2.5 py-1 rounded-md bg-card/90 border border-border text-[11px] font-medium text-muted-foreground">
              Sin datos históricos reales disponibles para {paneSymbol} ({paneTf}) en esta fecha de Replay
            </span>
          </div>
        )}
        <div
          ref={syncHorzLineRef}
          data-testid={`pane-${slotId}-sync-horz-line`}
          className="pointer-events-none absolute left-0 right-0 top-0 z-20 hidden border-t border-dashed"
          style={{ borderColor: colors.crosshair }}
        />
        <div
          ref={syncPricePillRef}
          data-testid={`pane-${slotId}-sync-price-pill`}
          className="pointer-events-none absolute right-0 z-30 hidden -translate-y-1/2 items-center justify-center px-1.5 py-1 text-[15px] font-mono tabular-nums text-white bg-[#363a45] leading-none"
        />

        {isExpanded && onDrawingToolSelect && (
          <DrawingToolRail
            drawingTool={drawingTool}
            onDrawingTool={onDrawingToolSelect}
            onZoomIn={handleZoomIn}
            onZoomOut={handleZoomOut}
          />
        )}

        {selectedDrawing && !showDrawingSettings && (
          <DrawingFloatingToolbar
            drawing={selectedDrawing}
            onUpdate={updateDrawing}
            onClone={handleCloneDrawing}
            onRemove={() => removeDrawing(selectedDrawing.id)}
            onOpenSettings={() => setShowDrawingSettings(true)}
          />
        )}

        {selectedDrawing && showDrawingSettings && (
          <DrawingSettingsDialog
            drawing={selectedDrawing}
            currentTf={paneTf}
            onUpdate={updateDrawing}
            onRemove={() => removeDrawing(selectedDrawing.id)}
            onClose={() => setShowDrawingSettings(false)}
          />
        )}

        {contextMenu && selectedDrawing && (
          <DrawingContextMenu
            drawing={selectedDrawing}
            x={contextMenu.x}
            y={contextMenu.y}
            onClose={() => setContextMenu(null)}
            onSettings={() => setShowDrawingSettings(true)}
            onDuplicate={handleCloneDrawing}
            onReorder={(dir) => handleReorderDrawing(selectedDrawing, dir)}
            onToggleLock={() =>
              updateDrawing({ ...selectedDrawing, locked: !selectedDrawing.locked })
            }
            onToggleAlert={() =>
              updateDrawing({ ...selectedDrawing, alertEnabled: !selectedDrawing.alertEnabled })
            }
            onRemove={() => removeDrawing(selectedDrawing.id)}
          />
        )}
      </div>
    </div>
  );
}
