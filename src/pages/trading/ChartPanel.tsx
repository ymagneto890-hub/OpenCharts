import { useQueryClient } from "@tanstack/react-query";
import {
  type AutoscaleInfo,
  type CandlestickData,
  ColorType,
  CrosshairMode,
  createChart,
  type HistogramData,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type ISeriesPrimitive,
  type LineData,
  LineStyle,
  type LogicalRange,
  type SeriesMarker,
  type Time,
} from "lightweight-charts";
import {
  ChevronDown,
  ChevronUp,
  ListTree,
  Minus,
  Plus,
  RotateCcw,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import {
  Fragment,
  type MouseEvent as ReactMouseEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useChartPreferences } from "../../hooks/useChartPreferences.ts";
import { useIndicatorSettings } from "../../hooks/useIndicatorSettings.ts";
import { BandsIndicator } from "../../lib/chart-plugins/bands-indicator/bands-indicator.ts";
import { DeltaTooltipPrimitive } from "../../lib/chart-plugins/delta-tooltip/delta-tooltip.ts";
import {
  detectCrossings,
  playAlertBeep,
} from "../../lib/chart-plugins/drawing-tools/line-alerts.ts";
import { DrawingToolsManager } from "../../lib/chart-plugins/drawing-tools/manager.ts";
import {
  classifyExtendedSession,
  ExtendedHoursPrimitive,
  filterExtendedHoursCandles,
  isUsEquityExchange,
} from "../../lib/chart-plugins/extended-hours-primitive.ts";
import { CrosshairHighlightPrimitive } from "../../lib/chart-plugins/highlight-bar-crosshair/highlight-bar-crosshair.ts";
import { SessionBreaks } from "../../lib/chart-plugins/session-breaks/session-breaks.ts";
import { SessionHighlighting } from "../../lib/chart-plugins/session-highlighting/session-highlighting.ts";
import { TooltipPrimitive } from "../../lib/chart-plugins/tooltip/tooltip.ts";
import {
  atr,
  computeMarketStructure,
  computeVolumeProfile,
  type IndicatorType,
} from "../../lib/indicators.ts";
import { cn, generateId } from "../../lib/utils.ts";
import { parseTimeframeSeconds } from "../../lib/timeframes.ts";
import { api } from "../../services/api.ts";
import { trackCryptoSymbol } from "../../services/cryptoStream.ts";
import {
  isIbkrDelayedMode,
  isIbkrLiveStreamConnected,
  subscribeIbkrStreamStatus,
  trackIbkrSymbol,
} from "../../services/ibkrStream.ts";
import {
  computeCausalReplayVwapSeed,
  getHistory,
  getStockSessionMetadata,
  getStockVwapSeed,
  hasRealStockSeries,
  isCryptoInstrument,
} from "../../services/demo/candles.ts";
import { getDemoSymbol } from "../../services/demo/instruments.ts";
import { getReplaySliceForTimeframe, useReplayStore } from "../../services/demo/replay.ts";
import { queryKeys } from "../../services/queries.ts";
import type { Candle, Order, Position, Symbol } from "../../services/schemas.ts";
import { toast } from "../../services/toast.ts";
import {
  CHART_COLORS,
  type DrawingLine,
  type DrawingTool,
  type MagnetMode,
  mergeChartColors,
  TF_INTERVAL_MS,
  type Timeframe,
} from "./constants.ts";
import { ChartContextMenu } from "./ChartContextMenu.tsx";
import { ChartSettingsDialog } from "./ChartSettingsDialog.tsx";
import {
  DrawingContextMenu,
  DrawingFloatingToolbar,
  DrawingSettingsDialog,
} from "./DrawingToolsOverlay.tsx";
import { DrawingToolRail } from "./DrawingToolRail.tsx";
import { DRAWING_STYLES_EVENT, getStyleDefaults } from "./drawingStyles.ts";
import { ModularOscillatorBlock } from "./ModularOscillatorBlock.tsx";
import { NewsOverlay } from "./NewsOverlay.tsx";
import { ObjectTreePanel } from "./ObjectTreePanel.tsx";
import {
  computeAlignedLocalPriceRange,
  type PriceSyncController,
  type SyncedPriceBounds,
} from "./priceSyncBus.ts";
import { useChallengeLevels } from "./useChallengeLevels.ts";
import { useIndicators } from "./useIndicators.ts";
import { useNewsOverlay } from "./useNewsOverlay.ts";
import { useSlTpDrag } from "./useSlTpDrag.ts";
import {
  calculateReplayVolumeMa,
  calculateVolumeMa,
  getCandleBucketTime,
  getMinMove,
  toIndicatorCandles,
  toUnixMs,
  toUnixSeconds,
} from "./utils.ts";

// ── Staleness recovery ─────────────────────────────────────────────────────
// Shared by the live-candle and tick-smoothing effects so either path can
// trigger a REST refetch when the chart falls more than 1.5 intervals behind
// wall-clock. Throttled to ≤1 refetch per 3 s across both callers.
function requestGapRefetch(
  refAtRef: { current: number },
  qc: ReturnType<typeof useQueryClient>,
  symbol: string,
  timeframe: string,
): void {
  const now = Date.now();
  if (now - refAtRef.current <= 3_000) return;
  refAtRef.current = now;
  qc.invalidateQueries({ queryKey: queryKeys.market.candles(symbol, timeframe) });
}

// ── Scroll-triggered history loading ─────────────────────────
// When the user scrolls to the left edge of loaded data, fetch the preceding
// window from the candle API and prepend it so the chart extends seamlessly.

const LOAD_MORE_THRESHOLD = 20; // trigger when fewer than N bars remain on the left
const LOAD_MORE_WINDOW = 500; // how many interval-widths to fetch per extension

type LoadMoreState = {
  loading: boolean;
  noMoreData: boolean;
  lastFetchedBeforeMs: number;
  // When > 0, use this as toMs for the next fetch instead of getSeriesOldestMs.
  // Set after an empty-range response so we skip over gaps (e.g. Forex weekends)
  // rather than permanently locking noMoreData on the first empty window.
  fetchFromMs: number;
};

function getSeriesOldestMs(series: ISeriesApi<"Candlestick">): number {
  const data = series.data();
  return data.length === 0 ? 0 : (data[0]!.time as number) * 1_000;
}

function isLoadMoreEligible(
  state: LoadMoreState,
  series: ISeriesApi<"Candlestick">,
  range: LogicalRange,
): boolean {
  if (state.loading || state.noMoreData) return false;
  const barsInfo = series.barsInLogicalRange(range);
  if ((barsInfo?.barsBefore ?? Number.POSITIVE_INFINITY) > LOAD_MORE_THRESHOLD) return false;
  // A shifted window from a previous empty-range response is always eligible —
  // we need to try the window before the gap (e.g. before a Forex weekend).
  if (state.fetchFromMs > 0) return true;
  const oldestMs = getSeriesOldestMs(series);
  if (oldestMs === 0) return false;
  return state.lastFetchedBeforeMs === 0 || oldestMs < state.lastFetchedBeforeMs;
}

function fetchOlderRange(
  symbol: string,
  timeframe: string,
  timeframeRef: { current: string },
  toMs: number,
  state: LoadMoreState,
  onLoaded: (bars: Candle[]) => void,
): void {
  const windowMs = LOAD_MORE_WINDOW * (TF_INTERVAL_MS[timeframe as Timeframe] ?? 60_000);
  api
    .getCandles(symbol, timeframe, undefined, { fromMs: toMs - windowMs, toMs })
    .then((bars) => {
      // Drop stale response if timeframe changed while the fetch was in flight
      if (timeframeRef.current !== timeframe) return;
      if (bars.length === 0) {
        // Empty window — could be a gap (e.g. Forex weekend) rather than true
        // end of history. Shift the fetch boundary back one more window so the
        // next scroll event tries the range before this gap instead of stopping.
        const nextToMs = toMs - windowMs;
        if (nextToMs > 0) {
          state.fetchFromMs = nextToMs;
        } else {
          state.noMoreData = true;
        }
      } else {
        onLoaded(bars as Candle[]);
      }
    })
    .catch(() => {
      // Reset the fetch boundary so the user can retry by scrolling again.
      // Without this, a transient network error permanently blocks history
      // loading for the current view (lastFetchedBeforeMs stays set but no
      // bars were prepended, so the eligibility guard never clears).
      if (timeframeRef.current === timeframe) {
        state.lastFetchedBeforeMs = 0;
      }
    })
    .finally(() => {
      if (timeframeRef.current === timeframe) {
        state.loading = false;
      }
    });
}

function makeHistoryLoader(
  symbol: string,
  timeframeRef: { current: string },
  seriesRef: { current: ISeriesApi<"Candlestick"> | null },
  stateRef: { current: LoadMoreState },
  onLoaded: (bars: Candle[]) => void,
): (range: LogicalRange | null) => void {
  return (range) => {
    const series = seriesRef.current;
    if (!range || !series) return;
    const state = stateRef.current;
    if (!isLoadMoreEligible(state, series, range)) return;
    // Use the shifted boundary from a prior empty-range response when present,
    // otherwise fall back to the series' current oldest bar.
    const toMs = state.fetchFromMs > 0 ? state.fetchFromMs : getSeriesOldestMs(series);
    if (toMs === 0) return;
    state.loading = true;
    state.lastFetchedBeforeMs = toMs;
    state.fetchFromMs = 0;
    // Read the timeframe from a ref: the chart (and this subscription) persists
    // across TF changes, so the loader must always fetch the *current* TF.
    fetchOlderRange(symbol, timeframeRef.current, timeframeRef, toMs, state, onLoaded);
  };
}

// ── Props ────────────────────────────────────────────────────

export interface DraftOrderSlTpPreview {
  side: "BUY" | "SELL";
  entryPrice: number;
  quantity: number;
  takeProfit?: number | null;
  stopLoss?: number | null;
}

export interface ChartPanelProps {
  candles: Candle[];
  selectedSymbol: string;
  timeframe: Timeframe;
  isDark: boolean;
  activeIndicators: IndicatorType[];
  drawingTool: DrawingTool;
  drawings: DrawingLine[];
  onAddDrawing: (d: DrawingLine) => void;
  onUpdateDrawing?: (d: DrawingLine) => void;
  onRemoveDrawing?: (id: string) => void;
  /** Called when a drawing completes/cancels so the parent can disarm the tool. */
  onDrawingComplete?: () => void;
  /** Alt+T/H/F/R keyboard shortcut pressed — arm the given tool. */
  onDrawingToolSelect?: (t: DrawingTool) => void;
  onUndoDrawing?: () => void;
  onRedoDrawing?: () => void;
  /** Snap drawing anchors to candle O/H/L/C — off / weak (near) / strong (always). */
  magnetMode?: MagnetMode;
  /** Keep the drawing tool armed after each placement. */
  stayInDrawingMode?: boolean;
  positions: Position[];
  orders: Order[];
  tick?: { bid: number; ask: number; timestamp: number };
  liveCandle?: {
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
    timestamp: number;
  };
  pipDigits: number;
  symbolInfo?: Symbol;
  onModifyPosition?: (
    positionId: string,
    mods: { takeProfit?: number | null; stopLoss?: number | null },
  ) => Promise<unknown> | void;
  onClosePosition?: (positionId: string) => void;
  draftOrderPreview?: DraftOrderSlTpPreview | null;
  onModifyDraftSlTp?: (mods: { takeProfit?: number | null; stopLoss?: number | null }) => void;
  replayTradeEvents?: Array<{
    id: string;
    type: "entry" | "exit" | "violation";
    timestamp: string;
    symbolName: string | null;
    side: string | null;
    price: number | null;
    pnl: number | null;
    ruleCode?: string;
  }>;
  activePlugins?: string[];
  /** Toggle a chart plugin (session breaks etc.) — used by the settings dialog. */
  onTogglePlugin?: (id: string) => void;
  /** Account equity — feeds the position tool's $-risk / size readout. */
  accountEquity?: number;
  /** Active account — enables the challenge-aware level overlay. */
  accountId?: string | null;
  /** Context-menu quick order at the clicked price (opens the confirm dialog). */
  onQuickOrder?: (side: "BUY" | "SELL", type: "LIMIT" | "STOP", price: number) => void;
  /** Context-menu "Remove N drawings". */
  onClearDrawings?: () => void;
  /** Context-menu "Remove N indicators". */
  onClearIndicators?: () => void;
  /** Toggle/remove indicator from modular layout. */
  onToggleIndicator?: (type: IndicatorType) => void;
  /**
   * Session replay is active — candles are a historical slice, so the
   * staleness watchdog must not treat the old last-bar as a data gap.
   */
  isReplaying?: boolean;
  /** True when the user is clicking a historical bar on the chart to start Replay. */
  replayPicking?: boolean;
  onPickReplayBar?: (timeSec: number, sourceTf?: Timeframe) => void;
  /** Synchronize price axis with right multichart pane and hide redundant right price scale. */
  priceSyncActive?: boolean;
  priceSyncController?: PriceSyncController | null;
  /** Temporary pane maximize/restore controls when part of a 2x1 / 2x2 split grid. */
  canExpandPane?: boolean;
  isPaneExpanded?: boolean;
  onToggleExpandPane?: () => void;
  expandLayoutLabel?: string;
}

// ── Modular block layout types & helpers ───────────────────────────────────────

export type ModularBlockId = "PRICE" | "RSI" | "MACD" | "STOCH";

const DEFAULT_BLOCK_ORDER: ModularBlockId[] = ["RSI", "PRICE", "MACD"];
const DEFAULT_BLOCK_WEIGHTS: Record<ModularBlockId, number> = {
  RSI: 18,
  PRICE: 64,
  MACD: 18,
  STOCH: 18,
};

interface ResizeSplitterProps {
  topBlockId: ModularBlockId;
  bottomBlockId: ModularBlockId;
  totalWeight: number;
  containerHeightRef: React.RefObject<number>;
  onResize: (topId: ModularBlockId, botId: ModularBlockId, deltaWeight: number) => void;
}

function ResizeSplitter({
  topBlockId,
  bottomBlockId,
  totalWeight,
  containerHeightRef,
  onResize,
}: ResizeSplitterProps) {
  const [isDragging, setIsDragging] = useState(false);
  const startYRef = useRef(0);
  const cleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    return () => {
      cleanupRef.current?.();
      cleanupRef.current = null;
    };
  }, []);

  const handleMouseDown = (e: ReactMouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    cleanupRef.current?.();
    setIsDragging(true);
    startYRef.current = e.clientY;

    const onMouseMove = (ev: MouseEvent) => {
      const deltaY = ev.clientY - startYRef.current;
      startYRef.current = ev.clientY;
      const h = containerHeightRef.current || 600;
      const deltaWeight = (deltaY / h) * totalWeight;
      onResize(topBlockId, bottomBlockId, deltaWeight);
    };

    const onMouseUp = () => {
      setIsDragging(false);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      if (cleanupRef.current === onMouseUp) cleanupRef.current = null;
    };

    cleanupRef.current = onMouseUp;
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  };

  return (
    <div
      onMouseDown={handleMouseDown}
      className={cn(
        "relative h-1.5 w-full bg-border/40 hover:bg-primary/70 cursor-row-resize transition-colors flex items-center justify-center group z-30 select-none flex-shrink-0",
        isDragging && "bg-primary shadow-sm",
      )}
      title="Arrastra verticalmente para redimensionar los paneles"
    >
      <div className="w-8 h-1 rounded-full bg-muted-foreground/30 group-hover:bg-primary transition-colors" />
    </div>
  );
}

// ── Chart plugin overlays ─────────────────────────────────────────────────────

function getForexSessionColor(utcHour: number): string {
  if (utcHour >= 22 || utcHour < 8) return "rgba(255,200,50,0.04)";
  if (utcHour >= 8 && utcHour < 16) return "rgba(50,200,255,0.04)";
  if (utcHour >= 13) return "rgba(255,80,80,0.04)";
  return "transparent";
}

const forexSessionHighlighter = (date: Time): string =>
  getForexSessionColor(new Date((date as number) * 1000).getUTCHours());

interface PluginBuildCtx {
  isDark: boolean;
  timeframe: Timeframe;
  symbolCategory?: string;
}

const EQUITY_CATEGORY = /stock|equit|share|etf|index|indices/i;

// Session breaks are intraday-only — on daily+ charts every bar is already a
// full session. Equities/indices reset at 09:30 New York (RTH open); forex,
// crypto and everything else reset at 00:00 UTC.
function buildSessionBreaks(ctx: PluginBuildCtx): ISeriesPrimitive<Time> | null {
  const intervalMs = TF_INTERVAL_MS[ctx.timeframe] ?? 60_000;
  if (intervalMs >= 86_400_000) return null;
  return new SessionBreaks({
    color: ctx.isDark ? "rgba(130, 150, 190, 0.5)" : "rgba(90, 110, 150, 0.45)",
    sessionStart: EQUITY_CATEGORY.test(ctx.symbolCategory ?? "") ? "ny-0930" : "utc-midnight",
  });
}

const PLUGIN_FACTORIES: Record<string, (ctx: PluginBuildCtx) => ISeriesPrimitive<Time> | null> = {
  crosshair: ({ isDark }) =>
    new CrosshairHighlightPrimitive({
      color: isDark ? "rgba(255,255,255,0.05)" : "rgba(0,0,0,0.05)",
    }),
  session: () => new SessionHighlighting(forexSessionHighlighter),
  "session-breaks": buildSessionBreaks,
  bands: () => new BandsIndicator(),
  tooltip: () => new TooltipPrimitive({}),
  "delta-tooltip": () => new DeltaTooltipPrimitive({}),
};

function buildPlugin(id: string, ctx: PluginBuildCtx): ISeriesPrimitive<Time> | null {
  return PLUGIN_FACTORIES[id]?.(ctx) ?? null;
}

// ── Real-time series update helpers ──────────────────────────────────────────
// Extracted from the live-candle / tick / bid-ask effects so each effect body
// stays under the cognitive-complexity limit. Behaviour is unchanged — these are
// pure relocations that operate on a shared context handed in by the effect.

type ChartColors = (typeof CHART_COLORS)["dark"];
type Ref<T> = { current: T };
type LiveCandleData = {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  timestamp: number;
};
type TickData = { bid: number; ask: number; timestamp: number };

interface RtCtx {
  series: ISeriesApi<"Candlestick">;
  volume: ISeriesApi<"Histogram"> | null;
  volumeMa: ISeriesApi<"Line"> | null;
  recentVols: Ref<number[]>;
  prev19VolSum: Ref<number>;
  hasVolumeMa: Ref<boolean>;
  lastCandle: Ref<CandlestickData<Time> | null>;
  lastCandleSymbol: Ref<string>;
  liveCandleTs: Ref<number>;
  legendVol: Ref<number>;
  gapAt: Ref<number>;
  bidLine: Ref<IPriceLine | null>;
  askLine: Ref<IPriceLine | null>;
  midLine: Ref<IPriceLine | null>;
  exitReplayAt: Ref<number>;
  colors: ChartColors;
  timeframe: Timeframe;
  symbol: string;
  qc: ReturnType<typeof useQueryClient>;
  allowLiveBar?: (timeSec: number) => boolean;
  /** Prevent L1 quote ticks from opening phantom 0-volume future buckets before a real trade bar arrives. */
  blockTickNewBucket?: boolean;
  ignoreTickMidpoint?: boolean;
  isDelayedStock?: boolean;
}

function intervalSecOf(tf: Timeframe): number {
  return (TF_INTERVAL_MS[tf] ?? 60_000) / 1000;
}

// Paint the authoritative server volume bar for the current candle and roll Volume MA(20) on new buckets.
function paintServerVolume(
  live: LiveCandleData,
  barTime: Time,
  isNewBucket: boolean,
  ctx: RtCtx,
): void {
  if (!ctx.volume || live.volume == null) return;
  if (isNewBucket) {
    // Commit the just-closed bar's volume into the rolling 19-bar prior window
    const prevClosed = ctx.legendVol.current;
    const nextWindow = [...ctx.recentVols.current, prevClosed].slice(-19);
    ctx.recentVols.current = nextWindow;
    ctx.prev19VolSum.current = nextWindow.reduce((acc, v) => acc + v, 0);
    ctx.hasVolumeMa.current = nextWindow.length >= 19;
  }
  ctx.legendVol.current = live.volume;
  try {
    ctx.volume.update({
      time: barTime,
      value: live.volume,
      color: live.close >= live.open ? ctx.colors.volumeUp : ctx.colors.volumeDown,
    });
    if (ctx.volumeMa && ctx.hasVolumeMa.current) {
      ctx.volumeMa.update({
        time: barTime,
        value: Number(((ctx.prev19VolSum.current + live.volume) / 20).toFixed(2)),
      });
    }
  } catch {
    /* safe to ignore */
  }
}

// Primary: server-aggregated CandleUpdate (authoritative OHLCV from IBKR / Crypto exchange).
function applyServerCandle(live: LiveCandleData, ctx: RtCtx): void {
  const ts = toUnixSeconds(live.timestamp);
  if (
    Number.isNaN(ts) ||
    ts <= 0 ||
    !ctx.lastCandle.current ||
    ctx.lastCandleSymbol.current !== ctx.symbol ||
    (ctx.allowLiveBar && !ctx.allowLiveBar(ts)) ||
    !Number.isFinite(live.open) ||
    live.open <= 0 ||
    !Number.isFinite(live.high) ||
    live.high <= 0 ||
    !Number.isFinite(live.low) ||
    live.low <= 0 ||
    !Number.isFinite(live.close) ||
    live.close <= 0
  ) {
    return;
  }
  const prevTime = ctx.lastCandle.current.time as number;
  const isNewBucket = ts > prevTime;
  if (ts - prevTime > intervalSecOf(ctx.timeframe) * 1.5) {
    requestGapRefetch(ctx.gapAt, ctx.qc, ctx.symbol, ctx.timeframe);
  }
  const bar: CandlestickData<Time> = {
    time: ts as Time,
    open: live.open,
    high: live.high,
    low: live.low,
    close: live.close,
  };
  ctx.lastCandle.current = bar;
  ctx.liveCandleTs.current = toUnixMs(live.timestamp);
  try {
    ctx.series.update(bar);
  } catch {
    /* timestamp older than series — safe to ignore */
  }
  paintServerVolume(live, ts as Time, isNewBucket, ctx);
}

// Build the tick-smoothed bar for the current bucket (continuation or fresh).
function buildTickBar(
  prev: CandlestickData<Time>,
  isContinuation: boolean,
  bucketTime: Time,
  mid: number,
  ctx: RtCtx,
): CandlestickData<Time> | null {
  if (!Number.isFinite(mid) || mid <= 0) return null;
  if (isContinuation) {
    // Sanity check: prevent corrupted/stale ticks from stretching phantom wicks
    const maxDeviation = Math.max(Math.max(prev.open, prev.close) * 0.2, 1e-8);
    if (Math.abs(mid - prev.open) > maxDeviation && Math.abs(mid - prev.close) > maxDeviation) {
      return null;
    }
    return {
      time: bucketTime,
      open: prev.open,
      high: Math.max(prev.high, mid),
      low: Math.min(prev.low, mid),
      close: mid,
    };
  }
  if ((bucketTime as number) <= (prev.time as number)) return null;
  const isSessionGap = (bucketTime as number) - (prev.time as number) > intervalSecOf(ctx.timeframe) * 1.5;
  if (isSessionGap) {
    requestGapRefetch(ctx.gapAt, ctx.qc, ctx.symbol, ctx.timeframe);
  }
  const seedOpen = isSessionGap ? mid : prev.close;
  return {
    time: bucketTime,
    open: seedOpen,
    high: Math.max(seedOpen, mid),
    low: Math.min(seedOpen, mid),
    close: mid,
  };
}

// A new bucket has no aggregated volume yet — seed it at 0 so a fresh candle
// never inherits the previous bar's full-height volume.
function paintTickVolume(
  bar: CandlestickData<Time>,
  isContinuation: boolean,
  bucketTime: Time,
  ctx: RtCtx,
): void {
  if (!ctx.volume) return;
  if (!isContinuation) ctx.legendVol.current = 0;
  try {
    ctx.volume.update({
      time: bucketTime,
      value: ctx.legendVol.current,
      color: bar.close >= bar.open ? ctx.colors.volumeUp : ctx.colors.volumeDown,
    });
  } catch {
    /* safe to ignore */
  }
}

// Secondary: tick smoothing between server CandleUpdate pulses.
function applyTick(tick: TickData, ctx: RtCtx): void {
  // IBKR US Equities (`TRADES`) and Crypto Exchange streams are driven 100% by real trade bars;
  // never let L1 Bid/Ask midpoint quotes distort candle close, wicks, EMA 9, or VWAP.
  if (ctx.ignoreTickMidpoint) return;
  if (!tick.timestamp) return;
  const tickMs = toUnixMs(tick.timestamp);
  if (ctx.exitReplayAt.current && tickMs < ctx.exitReplayAt.current) return;
  if (ctx.liveCandleTs.current && tickMs <= ctx.liveCandleTs.current) return;
  const prev = ctx.lastCandle.current;
  if (!prev || ctx.lastCandleSymbol.current !== ctx.symbol) return;
  const mid = (tick.bid + tick.ask) / 2;
  const bucketTime = getCandleBucketTime(tickMs, ctx.timeframe) as Time;
  if (ctx.allowLiveBar && !ctx.allowLiveBar(bucketTime as number)) return;
  const isContinuation = prev.time === bucketTime;
  if (!isContinuation && ctx.blockTickNewBucket) return;
  const bar = buildTickBar(prev, isContinuation, bucketTime, mid, ctx);
  if (!bar) return;
  ctx.lastCandle.current = bar;
  try {
    ctx.series.update(bar);
  } catch {
    /* safe to ignore */
  }
  paintTickVolume(bar, isContinuation, bucketTime, ctx);
}

function removePriceLineSafe(ref: Ref<IPriceLine | null>, series: ISeriesApi<"Candlestick">): void {
  if (!ref.current) return;
  try {
    series.removePriceLine(ref.current);
  } catch {
    /* ignore */
  }
  ref.current = null;
}



function applyBidAskLines(
  _tick: TickData | undefined,
  _prefs: { showBidLine: boolean; showAskLine: boolean },
  ctx: RtCtx,
): void {
  const series = ctx.series;
  removePriceLineSafe(ctx.bidLine, series);
  removePriceLineSafe(ctx.askLine, series);
  removePriceLineSafe(ctx.midLine, series);
}

function detachPlugins(series: ISeriesApi<"Candlestick">, list: ISeriesPrimitive<Time>[]): void {
  for (const p of list) {
    try {
      series.detachPrimitive(p);
    } catch {
      /* stale ref */
    }
  }
}

function attachPlugins(
  series: ISeriesApi<"Candlestick">,
  ids: string[],
  ctx: PluginBuildCtx,
  list: ISeriesPrimitive<Time>[],
): void {
  for (const id of ids) {
    const p = buildPlugin(id, ctx);
    if (p) {
      try {
        series.attachPrimitive(p);
        list.push(p);
      } catch {
        /* ignore */
      }
    }
  }
}

// ── Server-data (setData) helpers ────────────────────────────────────────────
// Extracted from the historical-fetch / periodic-sync effect so its body stays
// under the complexity limit. Pure relocations — behaviour is unchanged.

function liveBarFrom(live: LiveCandleData): CandlestickData<Time> | null {
  const ts = toUnixSeconds(live.timestamp);
  if (Number.isNaN(ts) || ts <= 0) return null;
  return { time: ts as Time, open: live.open, high: live.high, low: live.low, close: live.close };
}

function scrollOrFit(chart: IChartApi | null, _barCount: number): void {
  const ts = chart?.timeScale();
  if (!ts) return;
  ts.scrollToPosition(4, false);
}

// Re-apply the latest live bar after a periodic refetch (viewport preserved).
function reapplyLive(live: LiveCandleData | undefined, ctx: RtCtx): void {
  if (!live) return;
  const bar = liveBarFrom(live);
  if (!bar) return;
  if (ctx.allowLiveBar && !ctx.allowLiveBar(bar.time as number)) return;
  try {
    ctx.series.update(bar);
  } catch {
    /* safe to ignore */
  }
  const isNewBucket =
    ctx.lastCandle.current !== null && (bar.time as number) > (ctx.lastCandle.current.time as number);
  ctx.lastCandle.current = bar;
  paintServerVolume(live, bar.time, isNewBucket, ctx);
}

// Replay the buffered live candle immediately after history is painted so the
// last bar isn't stuck at the final historical close until the next tick.
function replayBufferedLive(
  buffered: LiveCandleData | undefined,
  chartData: CandlestickData<Time>[],
  ctx: RtCtx,
): void {
  if (!buffered) return;
  const liveTs = toUnixSeconds(buffered.timestamp);
  const lastHistBarSec = (chartData[chartData.length - 1]?.time as number) ?? 0;
  if (Number.isNaN(liveTs) || liveTs <= 0 || liveTs < lastHistBarSec) return;
  if (ctx.allowLiveBar && !ctx.allowLiveBar(liveTs)) return;
  const liveBar = liveBarFrom(buffered);
  if (!liveBar) return;
  const isNewBucket = liveTs > lastHistBarSec;
  try {
    ctx.series.update(liveBar);
    ctx.lastCandle.current = liveBar;
    ctx.liveCandleTs.current = toUnixMs(buffered.timestamp);
    paintServerVolume(buffered, liveBar.time, isNewBucket, ctx);
  } catch {
    /* safe to ignore — timestamp may be older than series */
  }
}

// If the freshest bar is >2 intervals stale, schedule one delayed refetch to
// close the gap before any live CandleUpdate paints over it. Throttled to 3 s.
function scheduleStaleRefetch(
  chartData: CandlestickData<Time>[],
  ctx: RtCtx,
): (() => void) | undefined {
  const lastBarSec = (chartData[chartData.length - 1]?.time as number) ?? 0;
  const rawNowSec = Math.floor(Date.now() / 1000);
  const expectedClockSec = ctx.isDelayedStock ? rawNowSec - 900 : rawNowSec;
  const ageSec = expectedClockSec - lastBarSec;
  // Skip stale refetch when within 2 intervals of expected live/delayed clock, or when market is closed (>5h gap)
  if (lastBarSec <= 0 || ageSec <= intervalSecOf(ctx.timeframe) * 2 || ageSec > 18_000) {
    return undefined;
  }
  const now = Date.now();
  if (now - ctx.gapAt.current <= 3_000) return undefined;
  ctx.gapAt.current = now;
  const { symbol, timeframe, qc } = ctx;
  const timer = window.setTimeout(() => {
    qc.invalidateQueries({ queryKey: queryKeys.market.candles(symbol, timeframe) });
  }, 1_500);
  return () => window.clearTimeout(timer);
}

// ── Position / order overlay helpers ─────────────────────────────────────────

type SlTpField = "takeProfit" | "stopLoss";
interface SlTpEntry {
  line: IPriceLine;
  price: number;
  positionId: string;
  field: SlTpField;
  side: string;
  entryPrice: number;
  quantity: number;
  isDragging?: boolean;
}
type SlTpMap = Map<string, SlTpEntry>;
interface OverlayOpts {
  symbol: string;
  baseUnit: string;
  colors: ChartColors;
  contractSize: number;
}

function formatUnitQty(q: number): string {
  if (!Number.isFinite(q)) return "0";
  return Number(q.toFixed(6)).toString();
}

function upsertManagedLine(
  series: ISeriesApi<"Candlestick">,
  lineMap: Map<string, IPriceLine>,
  activeKeys: Set<string>,
  key: string,
  options: Parameters<ISeriesApi<"Candlestick">["createPriceLine"]>[0],
  skipUpdate = false,
): IPriceLine {
  activeKeys.add(key);
  const existing = lineMap.get(key);
  if (existing) {
    if (!skipUpdate) {
      try {
        existing.applyOptions(options);
      } catch {
        const fresh = series.createPriceLine(options);
        lineMap.set(key, fresh);
        return fresh;
      }
    }
    return existing;
  }
  const created = series.createPriceLine(options);
  lineMap.set(key, created);
  return created;
}

// One SL or TP line for a position (or draft preview), registered in the drag-to-edit map.
function upsertSlTpLine(
  series: ISeriesApi<"Candlestick">,
  lineMap: Map<string, IPriceLine>,
  activeKeys: Set<string>,
  activeSlTpKeys: Set<string>,
  slTpMap: SlTpMap,
  meta: {
    positionId: string;
    side: "LONG" | "SHORT";
    entryPrice: number;
    quantity: number;
    isDraft?: boolean;
  },
  field: SlTpField,
  price: number,
  _pnl: number,
  colors: ChartColors,
): void {
  const isTp = field === "takeProfit";
  const key = `${meta.positionId}:${isTp ? "tp" : "sl"}`;
  activeSlTpKeys.add(key);
  const existingEntry = slTpMap.get(key);
  const isDragging = Boolean(existingEntry?.isDragging);
  const line = upsertManagedLine(
    series,
    lineMap,
    activeKeys,
    `line:${key}`,
    {
      price: isDragging && existingEntry ? existingEntry.price : price,
      color: isTp ? colors.tpLine : colors.slLine,
      lineWidth: 2,
      lineStyle: LineStyle.Dashed,
      axisLabelVisible: true,
      title: isTp ? "TP" : "SL",
    },
    isDragging,
  );
  if (existingEntry) {
    existingEntry.line = line;
    if (!isDragging) {
      existingEntry.price = price;
    }
    existingEntry.entryPrice = meta.entryPrice;
    existingEntry.quantity = meta.quantity;
    existingEntry.side = meta.side;
  } else {
    slTpMap.set(key, {
      line,
      price,
      positionId: meta.positionId,
      field,
      side: meta.side,
      entryPrice: meta.entryPrice,
      quantity: meta.quantity,
      isDragging: false,
    });
  }
}

function syncPositionOverlay(
  series: ISeriesApi<"Candlestick">,
  pos: Position,
  opts: OverlayOpts,
  lineMap: Map<string, IPriceLine>,
  activeKeys: Set<string>,
  activeSlTpKeys: Set<string>,
  slTpMap: SlTpMap,
): void {
  if (pos.symbolName !== opts.symbol || !Number.isFinite(pos.entryPrice)) return;
  const direction = pos.side === "LONG" ? 1 : -1;
  const livePnl = typeof pos.unrealizedPnl === "number" ? pos.unrealizedPnl : 0;
  const pnlSign = livePnl >= 0 ? "+" : "";
  upsertManagedLine(series, lineMap, activeKeys, `pos:${pos.id}:entry`, {
    price: pos.entryPrice,
    color: pos.side === "LONG" ? opts.colors.up : opts.colors.down,
    lineWidth: 1,
    lineStyle: LineStyle.Dotted,
    axisLabelVisible: true,
    title: `${pos.side === "LONG" ? "BUY" : "SELL"} ${formatUnitQty(pos.quantity)} ${opts.baseUnit} (${pnlSign}$${livePnl.toFixed(2)})`,
  });

  const pnlAt = (target: number) =>
    parseFloat(
      ((target - pos.entryPrice) * direction * pos.quantity * opts.contractSize).toFixed(2),
    );
  const meta = {
    positionId: pos.id,
    side: pos.side,
    entryPrice: pos.entryPrice,
    quantity: pos.quantity,
  };
  if (typeof pos.takeProfit === "number" && Number.isFinite(pos.takeProfit)) {
    upsertSlTpLine(
      series,
      lineMap,
      activeKeys,
      activeSlTpKeys,
      slTpMap,
      meta,
      "takeProfit",
      pos.takeProfit,
      pnlAt(pos.takeProfit),
      opts.colors,
    );
  }
  if (typeof pos.stopLoss === "number" && Number.isFinite(pos.stopLoss)) {
    upsertSlTpLine(
      series,
      lineMap,
      activeKeys,
      activeSlTpKeys,
      slTpMap,
      meta,
      "stopLoss",
      pos.stopLoss,
      pnlAt(pos.stopLoss),
      opts.colors,
    );
  }
}

function syncOrderOverlay(
  series: ISeriesApi<"Candlestick">,
  ord: Order,
  opts: OverlayOpts,
  lineMap: Map<string, IPriceLine>,
  activeKeys: Set<string>,
): void {
  const triggerPrice = ord.type === "STOP" ? ord.stopPrice : ord.price;
  if (
    ord.symbolName !== opts.symbol ||
    ord.status !== "PENDING" ||
    typeof triggerPrice !== "number" ||
    !Number.isFinite(triggerPrice)
  ) {
    return;
  }
  upsertManagedLine(series, lineMap, activeKeys, `ord:${ord.id}`, {
    price: triggerPrice,
    color: opts.colors.orderLine,
    lineWidth: 1,
    lineStyle: LineStyle.Dashed,
    axisLabelVisible: true,
    title: `[P] ${ord.side} ${ord.type} ${formatUnitQty(ord.quantity)} ${opts.baseUnit}`,
  });
}

// ── Replay trade-event marker helpers ────────────────────────────────────────

type ReplayTradeEvent = NonNullable<ChartPanelProps["replayTradeEvents"]>[number];

function entryMarker(ev: ReplayTradeEvent, time: Time): SeriesMarker<Time> {
  const isBuy = ev.side === "BUY";
  return {
    time,
    position: isBuy ? "belowBar" : "aboveBar",
    color: isBuy ? "#2196F3" : "#FF9800",
    shape: isBuy ? "arrowUp" : "arrowDown",
    text: isBuy ? "B" : "S",
  };
}

function exitMarker(ev: ReplayTradeEvent, time: Time): SeriesMarker<Time> {
  const profit = ev.pnl != null && ev.pnl >= 0;
  const text = ev.pnl != null ? `${ev.pnl >= 0 ? "+" : ""}$${Math.abs(ev.pnl).toFixed(0)}` : "Exit";
  return {
    time,
    position: profit ? "aboveBar" : "belowBar",
    color: profit ? "#0ecb81" : "#f6465d",
    shape: "circle",
    text,
  };
}

function buildReplayMarker(ev: ReplayTradeEvent, timeframe: Timeframe): SeriesMarker<Time> | null {
  const evMs = new Date(ev.timestamp).getTime();
  if (Number.isNaN(evMs)) return null;
  const time = getCandleBucketTime(evMs, timeframe) as Time;
  if (ev.type === "entry") return entryMarker(ev, time);
  if (ev.type === "exit") return exitMarker(ev, time);
  return {
    time,
    position: "aboveBar",
    color: "#FF1744",
    shape: "square",
    text: ev.ruleCode ?? "Rule",
  };
}

// ── HUD presentational sub-components ────────────────────────────────────────
// Extracted so the legend's per-value colour ternaries live here instead of
// inflating the ChartPanel render function's cognitive complexity.


// Floating toolbar / settings dialog for the currently selected drawing.
// Extracted so the selection branching doesn't inflate ChartPanel's CC.
function DrawingOverlays({
  drawing,
  showSettings,
  currentTf,
  onUpdate,
  onClone,
  onRemove,
  onOpenSettings,
  onCloseSettings,
}: {
  drawing: DrawingLine | null;
  showSettings: boolean;
  currentTf: string;
  onUpdate: (d: DrawingLine) => void;
  onClone: () => void;
  onRemove: () => void;
  onOpenSettings: () => void;
  onCloseSettings: () => void;
}) {
  if (!drawing) return null;
  if (showSettings) {
    return (
      <DrawingSettingsDialog
        drawing={drawing}
        currentTf={currentTf}
        onUpdate={onUpdate}
        onRemove={onRemove}
        onClose={onCloseSettings}
      />
    );
  }
  return (
    <DrawingFloatingToolbar
      drawing={drawing}
      onUpdate={onUpdate}
      onClone={onClone}
      onRemove={onRemove}
      onOpenSettings={onOpenSettings}
    />
  );
}

// Object-tree toggle button + panel. Extracted so the open/close branching
// doesn't inflate ChartPanel's cognitive complexity.
function ObjectTreeOverlay({
  drawings,
  selectedIds,
  pipDigits,
  currentTf,
  open,
  onToggle,
  onSelect,
  onUpdate,
  onRemove,
  onReorder,
}: {
  drawings: DrawingLine[];
  selectedIds: string[];
  pipDigits: number;
  currentTf: string;
  open: boolean;
  onToggle: () => void;
  onSelect: (d: DrawingLine) => void;
  onUpdate: (d: DrawingLine) => void;
  onRemove: (id: string) => void;
  onReorder: (d: DrawingLine, dir: "front" | "back") => void;
}) {
  if (drawings.length === 0) return null;
  return (
    <>
      <button
        type="button"
        title="Object tree (drawings)"
        onClick={onToggle}
        className={cn(
          "absolute bottom-2 left-2 z-10 p-1.5 rounded-md border border-border bg-card/90 shadow",
          open ? "text-primary" : "text-muted-foreground hover:text-foreground",
        )}
      >
        <ListTree className="h-3.5 w-3.5" />
      </button>
      {open && (
        <ObjectTreePanel
          drawings={drawings}
          selectedIds={selectedIds}
          pipDigits={pipDigits}
          currentTf={currentTf}
          onSelect={onSelect}
          onUpdate={onUpdate}
          onRemove={onRemove}
          onReorder={onReorder}
          onClose={onToggle}
        />
      )}
    </>
  );
}

// ═══════════════════════════════════════════════════════════
// CHART PANEL (lightweight-charts)
// ═══════════════════════════════════════════════════════════

export function ChartPanel({
  candles,
  selectedSymbol,
  timeframe,
  isDark,
  activeIndicators,
  drawingTool,
  drawings,
  onAddDrawing,
  onUpdateDrawing,
  onRemoveDrawing,
  onDrawingComplete,
  onDrawingToolSelect,
  onUndoDrawing,
  onRedoDrawing,
  magnetMode = "none",
  stayInDrawingMode = false,
  positions,
  orders,
  tick,
  liveCandle,
  pipDigits,
  symbolInfo,
  onModifyPosition,
  onClosePosition: _onClosePosition,
  draftOrderPreview,
  onModifyDraftSlTp,
  replayTradeEvents,
  activePlugins = [],
  onTogglePlugin,
  accountEquity = 0,
  accountId,
  onQuickOrder,
  onClearDrawings,
  onClearIndicators,
  onToggleIndicator,
  isReplaying = false,
  replayPicking = false,
  onPickReplayBar,
  priceSyncActive = false,
  priceSyncController = null,
  canExpandPane = false,
  isPaneExpanded = false,
  onToggleExpandPane,
}: ChartPanelProps) {
  const queryClient = useQueryClient();
  const lastGapRefetchAtRef = useRef<number>(0);
  const outerContainerRef = useRef<HTMLDivElement>(null);
  const containerHeightRef = useRef<number>(600);
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const priceSyncActiveRef = useRef(priceSyncActive);
  priceSyncActiveRef.current = priceSyncActive;
  const priceSyncControllerRef = useRef(priceSyncController);
  priceSyncControllerRef.current = priceSyncController;
  const syncHorzLineRef = useRef<HTMLDivElement | null>(null);
  const oscillatorChartsRef = useRef<Map<"RSI" | "MACD" | "STOCH", IChartApi>>(new Map());
  const isSyncingRangeRef = useRef<boolean>(false);
  const [sharedCrosshairTime, setSharedCrosshairTime] = useState<Time | null>(null);
  const [sharedCrosshairX, setSharedCrosshairX] = useState<number | null>(null);

  const handleModularCrosshairMove = useCallback((time: Time | null, fallbackX?: number | null) => {
    if (!time) {
      setSharedCrosshairTime(null);
      setSharedCrosshairX(null);
      return;
    }
    const mainX = chartRef.current?.timeScale().timeToCoordinate(time);
    setSharedCrosshairTime(time);
    setSharedCrosshairX(mainX != null ? Number(mainX) : (fallbackX ?? null));
  }, []);

  const getMainLogicalRange = useCallback((): LogicalRange | null => {
    return chartRef.current?.timeScale().getVisibleLogicalRange() ?? null;
  }, []);

  // ── Modular layout blocks & weights state ──
  const [blockOrder, setBlockOrder] = useState<ModularBlockId[]>(() => {
    try {
      const saved = localStorage.getItem("opencharts:block-order");
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length > 0) {
          const valid = parsed.filter((id): id is ModularBlockId =>
            id === "PRICE" || id === "RSI" || id === "MACD" || id === "STOCH",
          );
          // Put RSI strictly above PRICE as requested
          if (valid.includes("RSI") && valid.includes("PRICE")) {
            const rsiIdx = valid.indexOf("RSI");
            const priceIdx = valid.indexOf("PRICE");
            if (rsiIdx > priceIdx) {
              valid.splice(rsiIdx, 1);
              const newPriceIdx = valid.indexOf("PRICE");
              valid.splice(newPriceIdx, 0, "RSI");
            }
          }
          if (valid.length > 0) {
            try {
              localStorage.setItem("opencharts:block-order", JSON.stringify(valid));
            } catch {
              // ignore
            }
            return valid;
          }
        }
      }
    } catch {
      // ignore
    }
    const def = DEFAULT_BLOCK_ORDER;
    try {
      localStorage.setItem("opencharts:block-order", JSON.stringify(def));
    } catch {
      // ignore
    }
    return def;
  });

  const [blockWeights, setBlockWeights] = useState<Record<ModularBlockId, number>>(() => {
    try {
      const saved = localStorage.getItem("opencharts:block-weights");
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed && typeof parsed.PRICE === "number" && parsed.PRICE >= 50) {
          return { ...DEFAULT_BLOCK_WEIGHTS, ...parsed };
        }
      }
    } catch {
      // ignore
    }
    return DEFAULT_BLOCK_WEIGHTS;
  });

  const isRsiActive = activeIndicators.includes("RSI");
  const isMacdActive = activeIndicators.includes("MACD");
  const isStochActive = activeIndicators.includes("STOCH");

  const [maximizedBlockId, setMaximizedBlockId] = useState<ModularBlockId | null>(null);

  const toggleMaximizeBlock = useCallback((id: ModularBlockId) => {
    setMaximizedBlockId((prev) => (prev === id ? null : id));
  }, []);

  const allActiveBlocks = useMemo<ModularBlockId[]>(() => {
    const activeSet = new Set<ModularBlockId>(["PRICE"]);
    if (isRsiActive) activeSet.add("RSI");
    if (isMacdActive) activeSet.add("MACD");
    if (isStochActive) activeSet.add("STOCH");

    // Order active blocks according to blockOrder (supporting RSI above PRICE)
    const ordered: ModularBlockId[] = blockOrder.filter((id) => activeSet.has(id));
    for (const id of activeSet) {
      if (!ordered.includes(id)) {
        ordered.push(id);
      }
    }
    return ordered;
  }, [blockOrder, isRsiActive, isMacdActive, isStochActive]);

  const totalActiveWeight = useMemo(() => {
    return allActiveBlocks.reduce((acc, id) => acc + (blockWeights[id] ?? 20), 0);
  }, [allActiveBlocks, blockWeights]);

  useEffect(() => {
    if (maximizedBlockId && !allActiveBlocks.includes(maximizedBlockId)) {
      setMaximizedBlockId(null);
    }
  }, [maximizedBlockId, allActiveBlocks]);

  const effectiveMaximizedBlockId =
    maximizedBlockId && allActiveBlocks.includes(maximizedBlockId) ? maximizedBlockId : null;

  const getBlockHeightPct = useCallback(
    (id: ModularBlockId) => {
      if (effectiveMaximizedBlockId) {
        return effectiveMaximizedBlockId === id ? 100 : 0;
      }
      if (allActiveBlocks.length === 1) return 100;
      const w = blockWeights[id] ?? 20;
      return totalActiveWeight > 0 ? (w / totalActiveWeight) * 100 : 100 / allActiveBlocks.length;
    },
    [allActiveBlocks, blockWeights, totalActiveWeight, effectiveMaximizedBlockId],
  );

  const moveBlock = useCallback(
    (id: ModularBlockId, direction: "up" | "down") => {
      const idx = allActiveBlocks.indexOf(id);
      if (idx === -1) return;
      const targetIdx = direction === "up" ? idx - 1 : idx + 1;
      if (targetIdx < 0 || targetIdx >= allActiveBlocks.length) return;

      const targetId = allActiveBlocks[targetIdx]!;
      const nextBlocks = [...allActiveBlocks];
      nextBlocks[idx] = targetId;
      nextBlocks[targetIdx] = id;

      setBlockOrder(nextBlocks);
      try {
        localStorage.setItem("opencharts:block-order", JSON.stringify(nextBlocks));
      } catch {
        // ignore
      }
    },
    [allActiveBlocks],
  );

  const resizeBlock = useCallback(
    (id: ModularBlockId, deltaWeight: number) => {
      if (allActiveBlocks.length <= 1) return;
      setBlockWeights((prev) => {
        const curW = prev[id] ?? 20;
        const newW = Math.max(12, Math.min(80, curW + deltaWeight));
        const actualDelta = newW - curW;
        if (actualDelta === 0) return prev;

        const otherBlocks = allActiveBlocks.filter((b) => b !== id);
        const otherWeightSum = otherBlocks.reduce((acc, b) => acc + (prev[b] ?? 20), 0);

        const next = { ...prev, [id]: newW };
        for (const b of otherBlocks) {
          const ratio = otherWeightSum > 0 ? (prev[b] ?? 20) / otherWeightSum : 1 / otherBlocks.length;
          const adjusted = Math.max(10, (prev[b] ?? 20) - actualDelta * ratio);
          next[b] = adjusted;
        }

        try {
          localStorage.setItem("opencharts:block-weights", JSON.stringify(next));
        } catch {
          // ignore
        }
        return next;
      });
    },
    [allActiveBlocks],
  );

  const handleSplitterResize = useCallback(
    (topBlockId: ModularBlockId, bottomBlockId: ModularBlockId, deltaWeight: number) => {
      setBlockWeights((prev) => {
        const topW = prev[topBlockId] ?? 20;
        const botW = prev[bottomBlockId] ?? 20;
        const sum = topW + botW;

        const newTopW = Math.max(12, Math.min(sum - 12, topW + deltaWeight));
        const newBotW = sum - newTopW;

        const next = { ...prev, [topBlockId]: newTopW, [bottomBlockId]: newBotW };
        try {
          localStorage.setItem("opencharts:block-weights", JSON.stringify(next));
        } catch {
          // ignore
        }
        return next;
      });
    },
    [],
  );

  const handleRegisterOscillatorChart = useCallback(
    (type: "RSI" | "MACD" | "STOCH", chart: IChartApi | null) => {
      if (chart) {
        oscillatorChartsRef.current.set(type, chart);
        const currentRange = chartRef.current?.timeScale().getVisibleLogicalRange();
        if (currentRange) {
          try {
            chart.timeScale().setVisibleLogicalRange(currentRange);
          } catch {
            // ignore
          }
        }
      } else {
        oscillatorChartsRef.current.delete(type);
      }
    },
    [],
  );

  const handleOscillatorRangeChange = useCallback(
    (range: LogicalRange | null, source: "RSI" | "MACD" | "STOCH") => {
      if (!range || isSyncingRangeRef.current) return;
      isSyncingRangeRef.current = true;
      try {
        if (chartRef.current) {
          chartRef.current.timeScale().setVisibleLogicalRange(range);
        }
        for (const [type, otherChart] of oscillatorChartsRef.current) {
          if (type !== source && otherChart) {
            otherChart.timeScale().setVisibleLogicalRange(range);
          }
        }
      } finally {
        isSyncingRangeRef.current = false;
      }
    },
    [],
  );

  // Scroll-triggered historical extension — older bars prepended as the user
  // scrolls left past what the initial deep-fetch already loaded.
  const [historicalExtra, setHistoricalExtra] = useState<Candle[]>([]);
  const loadMoreRef = useRef<LoadMoreState>({
    loading: false,
    noMoreData: false,
    lastFetchedBeforeMs: 0,
    lastFetchedToMs: 0,
    fetchFromMs: 0,
  } as LoadMoreState);
  const volumeSeriesRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const volumeMaSeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const overlayLineMapRef = useRef<Map<string, IPriceLine>>(new Map());
  const drawingManagerRef = useRef<DrawingToolsManager | null>(null);
  const timeframeRef = useRef(timeframe);
  const prevTimeframeRef = useRef<string>(timeframe);
  const replayCutOffsetRef = useRef<{ barsLeft: number; barsRight: number } | null>(null);
  const prevReplayLenRef = useRef<number>(0);
  const prevReplayLastTimeRef = useRef<number>(0);
  const isEnteringReplayRef = useRef<boolean>(false);
  const wasReplayingRef = useRef<boolean>(isReplaying);
  const exitReplayAtRef = useRef<number>(0);
  const chartPluginsRef = useRef<ISeriesPrimitive<Time>[]>([]);
  const extendedHoursPrimRef = useRef<{
    series: ISeriesApi<"Candlestick">;
    prim: ExtendedHoursPrimitive;
  } | null>(null);
  const bidLineRef = useRef<IPriceLine | null>(null);
  const askLineRef = useRef<IPriceLine | null>(null);
  const midLineRef = useRef<IPriceLine | null>(null);

  // ── SL/TP drag-to-edit state ──
  const slTpLinesRef = useRef<SlTpMap>(new Map());

  const [chartEpoch, setChartEpoch] = useState(0);

  const chartPrefs = useChartPreferences();
  const inspectedTrade = useReplayStore((s) => s.inspectedTrade);
  const replaySimTimeSec = useReplayStore((s) => s.simTimeSec);
  const colors = useMemo(
    () => mergeChartColors(isDark ? CHART_COLORS.dark : CHART_COLORS.light, chartPrefs),
    [isDark, chartPrefs],
  );

  // Synchronously reset historical extension when symbol or timeframe changes so old bars are not mixed
  const [prevTfSymbol, setPrevTfSymbol] = useState({ symbol: selectedSymbol, timeframe });
  const isTfOrSymbolSwitching =
    prevTfSymbol.symbol !== selectedSymbol || prevTfSymbol.timeframe !== timeframe;
  if (isTfOrSymbolSwitching) {
    setPrevTfSymbol({ symbol: selectedSymbol, timeframe });
    setHistoricalExtra([]);
    loadMoreRef.current = {
      loading: false,
      noMoreData: false,
      lastFetchedBeforeMs: 0,
      fetchFromMs: 0,
    };
    lastGapRefetchAtRef.current = 0;
  }

  // Reset historical extension whenever symbol or timeframe changes
  useEffect(() => {
    setHistoricalExtra([]);
    loadMoreRef.current = {
      loading: false,
      noMoreData: false,
      lastFetchedBeforeMs: 0,
      fetchFromMs: 0,
    };
    lastGapRefetchAtRef.current = 0;
  }, [selectedSymbol, timeframe]);

  // ── Drawing selection (floating toolbar / settings dialog / object tree) ──
  const [selectedDrawingIds, setSelectedDrawingIds] = useState<string[]>([]);
  const [showDrawingSettings, setShowDrawingSettings] = useState(false);
  const [showObjectTree, setShowObjectTree] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ id: string; x: number; y: number } | null>(null);

  // ── Chart-wide context menu + settings dialog ──
  const drawingMenuOpenedRef = useRef(false);
  const [chartMenu, setChartMenu] = useState<{ x: number; y: number; price: number | null } | null>(
    null,
  );
  const [showChartSettings, setShowChartSettings] = useState(false);
  const selectedDrawing = useMemo(
    () =>
      selectedDrawingIds.length === 1
        ? (drawings.find((d) => d.id === selectedDrawingIds[0]) ?? null)
        : null,
    [drawings, selectedDrawingIds],
  );

  const visibleDrawings = useMemo(
    () => drawings.filter((d) => !d.hidden && (d.visibility !== "tf" || d.createdTf === timeframe)),
    [drawings, timeframe],
  );

  const drawingToolRef = useRef(drawingTool);
  const drawingsRef = useRef(visibleDrawings);
  const magnetRef = useRef(magnetMode);
  const stayInModeRef = useRef(stayInDrawingMode);
  const accountEquityRef = useRef(accountEquity);
  const styleDefaultsRef = useRef(getStyleDefaults());
  const onAddDrawingRef = useRef(onAddDrawing);
  const onUpdateDrawingRef = useRef(onUpdateDrawing);
  const onRemoveDrawingRef = useRef(onRemoveDrawing);
  const onDrawingCompleteRef = useRef(onDrawingComplete);
  const onDrawingToolSelectRef = useRef(onDrawingToolSelect);
  const onUndoDrawingRef = useRef(onUndoDrawing);
  const onRedoDrawingRef = useRef(onRedoDrawing);
  useEffect(() => {
    drawingToolRef.current = drawingTool;
    drawingManagerRef.current?.setTool(replayPicking ? "none" : drawingTool);
  }, [drawingTool, replayPicking]);
  useEffect(() => {
    drawingsRef.current = visibleDrawings;
    drawingManagerRef.current?.setDrawings(visibleDrawings);
  }, [visibleDrawings]);
  useEffect(() => {
    magnetRef.current = magnetMode;
    drawingManagerRef.current?.setMagnetMode(magnetMode);
  }, [magnetMode]);
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
    stayInModeRef.current = stayInDrawingMode;
    drawingManagerRef.current?.setStayInDrawingMode(stayInDrawingMode);
  }, [stayInDrawingMode]);
  useEffect(() => {
    onAddDrawingRef.current = onAddDrawing;
    onUpdateDrawingRef.current = onUpdateDrawing;
    onRemoveDrawingRef.current = onRemoveDrawing;
    onDrawingCompleteRef.current = onDrawingComplete;
    onDrawingToolSelectRef.current = onDrawingToolSelect;
    onUndoDrawingRef.current = onUndoDrawing;
    onRedoDrawingRef.current = onRedoDrawing;
  });

  const handleCloneDrawing = useCallback(() => {
    const d = selectedDrawing;
    if (!d) return;
    const offsetSec = ((TF_INTERVAL_MS[timeframe] ?? 60_000) / 1000) * 5;
    onAddDrawing({
      ...d,
      id: generateId(),
      time: d.time != null ? d.time + offsetSec : undefined,
      time2: d.time2 != null ? d.time2 + offsetSec : undefined,
      time3: d.time3 != null ? d.time3 + offsetSec : undefined,
    });
  }, [selectedDrawing, timeframe, onAddDrawing]);

  const handleReorderDrawing = useCallback(
    (d: DrawingLine, dir: "front" | "back") => {
      const zs = drawings.map((x) => x.zIndex ?? 0);
      const zIndex = dir === "front" ? Math.max(...zs, 0) + 1 : Math.min(...zs, 0) - 1;
      onUpdateDrawing?.({ ...d, zIndex });
    },
    [drawings, onUpdateDrawing],
  );

  const handleObjectTreeSelect = useCallback((d: DrawingLine) => {
    drawingManagerRef.current?.setSelection([d.id]);
  }, []);

  // ── Extracted hooks ────────────────────────────────────────
  const allCandles = useMemo(() => {
    if (isReplaying || isTfOrSymbolSwitching || historicalExtra.length === 0) return candles;
    const candleTimes = new Set(candles.map((c) => c.time));
    const extra = historicalExtra.filter((c) => !candleTimes.has(c.time));
    return [...extra, ...candles];
  }, [isReplaying, isTfOrSymbolSwitching, historicalExtra, candles]);
  const isStockSymbol = useMemo(() => {
    const demoSym = getDemoSymbol(selectedSymbol);
    const resolvedCategory = (symbolInfo?.category ?? demoSym?.category ?? "").toUpperCase();
    return resolvedCategory === "STOCKS";
  }, [selectedSymbol, symbolInfo]);
  const isIntradayTf = timeframe !== "1d" && timeframe !== "1w";
  const visibleCandles = useMemo(() => {
    if (!isStockSymbol || !isIntradayTf || chartPrefs.showExtendedHours) return allCandles;
    const demoSym = getDemoSymbol(selectedSymbol);
    const meta = getStockSessionMetadata(selectedSymbol, timeframe);
    return filterExtendedHoursCandles(allCandles, false, meta, demoSym?.exchange);
  }, [allCandles, isStockSymbol, isIntradayTf, chartPrefs.showExtendedHours, selectedSymbol, timeframe]);
  const hasExtendedFilterFallback = useMemo(
    () =>
      isStockSymbol &&
      isIntradayTf &&
      !chartPrefs.showExtendedHours &&
      allCandles.length > 0 &&
      visibleCandles === allCandles,
    [isStockSymbol, isIntradayTf, chartPrefs.showExtendedHours, allCandles, visibleCandles],
  );
  const [ibkrDelayed, setIbkrDelayed] = useState<boolean>(() => isIbkrDelayedMode());
  useEffect(() => {
    return subscribeIbkrStreamStatus((_live, _reason, mdt) => {
      setIbkrDelayed(mdt === 4 || isIbkrDelayedMode());
    });
  }, []);

  const { chartData, volumeData, volumeMaData } = useChartData(
    visibleCandles,
    colors,
    isReplaying,
    parseTimeframeSeconds(timeframe),
    replaySimTimeSec,
  );
  const confirmedChartData = useMemo(() => {
    if (chartData.length === 0) return chartData;
    if (isReplaying) {
      if (replaySimTimeSec > 0) {
        const tfSec = (TF_INTERVAL_MS[timeframe] ?? 60_000) / 1000;
        const last = chartData[chartData.length - 1]!;
        if ((last.time as number) + tfSec > replaySimTimeSec) {
          return chartData.slice(0, -1);
        }
      }
      return chartData;
    }
    const refMs = isStockSymbol && ibkrDelayed ? Date.now() - 900_000 : Date.now();
    const currentBucket = getCandleBucketTime(refMs, timeframe);
    const liveTs = liveCandle && liveCandle.timestamp > 0 ? toUnixSeconds(liveCandle.timestamp) : 0;
    return chartData.filter(
      (candle) =>
        (candle.time as number) < currentBucket &&
        !(liveTs > 0 && (candle.time as number) === liveTs),
    );
  }, [chartData, isReplaying, replaySimTimeSec, timeframe, isStockSymbol, ibkrDelayed, liveCandle]);

  const {
    newsConfig,
    setNewsConfig,
    showNewsConfigDialog,
    setShowNewsConfigDialog,
    newsPopup,
    setNewsPopup,
    upcomingEvents,
    isReplayActive,
    currentSec,
  } = useNewsOverlay(containerRef, chartRef, selectedSymbol, isDark, chartData, chartEpoch, timeframe);

  const handleModifyPositionOrDraft = useCallback(
    (posId: string, mods: { takeProfit?: number | null; stopLoss?: number | null }) => {
      if (posId === "__draft__") {
        onModifyDraftSlTp?.(mods);
        return;
      }
      return onModifyPosition?.(posId, mods);
    },
    [onModifyPosition, onModifyDraftSlTp],
  );

  const { dragPrice, startDragManual } = useSlTpDrag(
    containerRef,
    chartRef,
    candleSeriesRef,
    slTpLinesRef,
    drawingTool,
    handleModifyPositionOrDraft,
    pipDigits,
    symbolInfo,
    chartEpoch,
  );

  // ── Challenge-aware rule levels (daily loss / max DD / profit target) ──
  const challengeFlags = useMemo(
    () => ({
      enabled: chartPrefs.challengeOverlay && !!accountId,
      dailyLoss: chartPrefs.challengeDailyLossLine,
      maxDrawdown: chartPrefs.challengeMaxDrawdownLine,
      profitTarget: chartPrefs.challengeProfitTargetLine,
    }),
    [
      chartPrefs.challengeOverlay,
      chartPrefs.challengeDailyLossLine,
      chartPrefs.challengeMaxDrawdownLine,
      chartPrefs.challengeProfitTargetLine,
      accountId,
    ],
  );
  useChallengeLevels({
    accountId,
    selectedSymbol,
    positions,
    tick,
    contractSize: symbolInfo?.contractSize ?? 1,
    accountEquity,
    candleSeriesRef,
    flags: challengeFlags,
    chartEpoch,
  });

  // ── Chart context-menu actions ──
  const handleChartContextMenu = useCallback((e: ReactMouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    if (drawingMenuOpenedRef.current) {
      drawingMenuOpenedRef.current = false;
      return;
    }
    const rect = e.currentTarget.getBoundingClientRect();
    const raw = candleSeriesRef.current?.coordinateToPrice(e.clientY - rect.top);
    const price = typeof raw === "number" && Number.isFinite(raw) ? raw : null;
    setChartMenu({ x: e.clientX, y: e.clientY, price });
  }, []);

  const [isManualScale, setIsManualScale] = useState(false);

  const handleResetView = useCallback(() => {
    const chart = chartRef.current;
    if (!chart) return;
    chart.timeScale().resetTimeScale();
    chart.priceScale("right").applyOptions({ autoScale: true });
    chart.timeScale().scrollToRealTime();
    setIsManualScale(false);
    if (priceSyncActiveRef.current && priceSyncControllerRef.current) {
      priceSyncControllerRef.current.requestResetAutoScale();
    }
  }, []);

  const handleToggleAutoScale = useCallback(() => {
    const chart = chartRef.current;
    if (!chart) return;
    if (priceSyncActiveRef.current && priceSyncControllerRef.current) {
      priceSyncControllerRef.current.requestResetAutoScale();
      chart.priceScale("right").applyOptions({ autoScale: true });
      chart.timeScale().scrollToRealTime();
      setIsManualScale(false);
      toast.info("Escala automática", "Escala sincronizada reajustada a las velas.");
      return;
    }
    const priceScale = chart.priceScale("right");
    const currentAuto = priceScale.options().autoScale;
    if (currentAuto) {
      priceScale.applyOptions({ autoScale: false });
      setIsManualScale(true);
      toast.info("Modo escala libre", "Ahora puedes arrastrar el gráfico hacia arriba y abajo libremente.");
    } else {
      priceScale.applyOptions({ autoScale: true });
      chart.timeScale().scrollToRealTime();
      setIsManualScale(false);
      toast.info("Escala automática", "Gráfico reajustado a las velas.");
    }
  }, []);

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

  // ── Keyboard shortcuts for chart zoom (+ / - / Ctrl+0) ──
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const activeTag = document.activeElement?.tagName.toLowerCase();
      if (
        activeTag === "input" ||
        activeTag === "textarea" ||
        activeTag === "select" ||
        (document.activeElement as HTMLElement)?.isContentEditable
      ) {
        return;
      }
      if (e.key === "+" || e.key === "=") {
        e.preventDefault();
        handleZoomIn();
      } else if (e.key === "-" || e.key === "_") {
        e.preventDefault();
        handleZoomOut();
      } else if ((e.ctrlKey || e.metaKey || e.altKey) && e.key === "0") {
        e.preventDefault();
        handleResetView();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleZoomIn, handleZoomOut, handleResetView]);

  const handleCopyPrice = useCallback(
    (price: number) => {
      const text = price.toFixed(pipDigits);
      void navigator.clipboard
        ?.writeText(text)
        .then(() => toast.success("Copied", text))
        .catch(() => toast.error("Copy failed", "Clipboard unavailable"));
    },
    [pipDigits],
  );

  const handleAddAlert = useCallback(
    (price: number) => {
      const rounded = parseFloat(price.toFixed(pipDigits));
      onAddDrawing({
        id: generateId(),
        type: "horizontal",
        price: rounded,
        color: "#f0b90b",
        alertEnabled: true,
        createdTf: timeframe,
      });
      toast.info("Alert set", `${selectedSymbol} at ${rounded}`);
    },
    [onAddDrawing, pipDigits, timeframe, selectedSymbol],
  );

  const indicatorSettings = useIndicatorSettings();

  const currentAtr14 = useMemo(() => {
    if (chartData.length < 15) return null;
    const pts = atr(toIndicatorCandles(chartData), 14);
    return pts.length > 0 ? pts[pts.length - 1]!.value : null;
  }, [chartData]);

  const smcTrend = useMemo(() => {
    if (!activeIndicators.includes("SMC") || chartData.length < 12) return null;
    const res = computeMarketStructure(toIndicatorCandles(chartData), {
      swingLength: indicatorSettings.smc.swingLength,
    });
    return res.trend;
  }, [activeIndicators, chartData, indicatorSettings.smc.swingLength]);

  const vpvrPoc = useMemo(() => {
    if (!activeIndicators.includes("VPVR") || chartData.length === 0) return null;
    const slice =
      indicatorSettings.vpvr.scope === "visible" ? chartData.slice(-200) : chartData;
    const res = computeVolumeProfile(toIndicatorCandles(slice), {
      rows: indicatorSettings.vpvr.rows,
      valueAreaPct: indicatorSettings.vpvr.valueAreaPct,
    });
    return res.pocIndex >= 0 ? res.pocPrice : null;
  }, [
    activeIndicators,
    chartData,
    indicatorSettings.vpvr.scope,
    indicatorSettings.vpvr.rows,
    indicatorSettings.vpvr.valueAreaPct,
  ]);

  const demoSymForVwap = getDemoSymbol(selectedSymbol);
  const resolvedCategoryForVwap = (symbolInfo?.category ?? demoSymForVwap?.category ?? "").toUpperCase();
  const isStockForVwap = resolvedCategoryForVwap === "STOCKS";
  const stockMetaForVwap = isStockForVwap ? getStockSessionMetadata(selectedSymbol, timeframe) : null;
  const isUsStockForVwap =
    isStockForVwap &&
    (stockMetaForVwap?.timezone === "America/New_York" ||
      isUsEquityExchange(demoSymForVwap?.exchange));

  const liveIndicatorData = useMemo(() => {
    if (isReplaying || chartData.length === 0) return chartData;
    const last = chartData[chartData.length - 1]!;
    const lastTimeSec = last.time as number;
    const allowTime = (timeSec: number) =>
      !isStockSymbol ||
      !isIntradayTf ||
      chartPrefs.showExtendedHours ||
      hasExtendedFilterFallback ||
      classifyExtendedSession(timeSec, stockMetaForVwap, demoSymForVwap?.exchange) === "regular";

    let working = chartData;
    if (liveCandle && liveCandle.timestamp > 0 && liveCandle.close > 0) {
      const liveTs = toUnixSeconds(liveCandle.timestamp);
      if (Number.isFinite(liveTs) && liveTs >= lastTimeSec && allowTime(liveTs)) {
        const liveRow = {
          time: liveTs as Time,
          open: liveCandle.open,
          high: liveCandle.high,
          low: liveCandle.low,
          close: liveCandle.close,
          volume:
            liveTs === lastTimeSec
              ? Math.max(last.volume ?? 0, liveCandle.volume ?? 0)
              : (liveCandle.volume ?? 0),
        };
        working = liveTs === lastTimeSec ? [...chartData.slice(0, -1), liveRow] : [...chartData, liveRow];
      }
    }

    // For IBKR US Equities (`TRADES`) and Crypto exchange streams, candle OHLC, EMA 9, and VWAP
    // must use ONLY authoritative trade bars — never `(bid + ask) / 2` L1 quote midpoints.
    if (isStockSymbol || isCryptoInstrument(selectedSymbol)) {
      return working;
    }

    if (!tick || !(tick.timestamp > 0)) return working;
    const mid = (tick.bid + tick.ask) / 2;
    if (!Number.isFinite(mid) || mid <= 0) return working;
    const tickMs = toUnixMs(tick.timestamp);
    const bucket = getCandleBucketTime(tickMs, timeframe);
    const tail = working[working.length - 1]!;
    const tailTime = tail.time as number;
    if (bucket < tailTime || !allowTime(bucket)) return working;

    const isSessionGap = bucket - tailTime > intervalSecOf(timeframe) * 1.5;
    if (!isSessionGap) {
      const maxDev = Math.max(Math.max(tail.open, tail.close) * 0.2, 1e-8);
      if (Math.abs(mid - tail.open) > maxDev && Math.abs(mid - tail.close) > maxDev) {
        return working;
      }
    }
    if (bucket === tailTime) {
      const updated = {
        ...tail,
        high: Math.max(tail.high, mid),
        low: Math.min(tail.low, mid),
        close: mid,
      };
      return [...working.slice(0, -1), updated];
    }
    // For IBKR stocks & live crypto streams, wait for an authoritative trade bar before opening a new bucket
    // so L1 quotes never inject phantom 0-volume bars into EMA 9 or VWAP.
    if (isStockSymbol || isCryptoInstrument(selectedSymbol)) {
      return working;
    }
    const seedOpen = isSessionGap ? mid : tail.close;
    return [
      ...working,
      {
        time: bucket as Time,
        open: seedOpen,
        high: Math.max(seedOpen, mid),
        low: Math.min(seedOpen, mid),
        close: mid,
        volume: 0,
      },
    ];
  }, [
    isReplaying,
    chartData,
    liveCandle,
    tick,
    timeframe,
    selectedSymbol,
    isStockSymbol,
    isIntradayTf,
    chartPrefs.showExtendedHours,
    hasExtendedFilterFallback,
    stockMetaForVwap,
    demoSymForVwap?.exchange,
  ]);

  const anchorVwapAtRegularOpen =
    isUsStockForVwap && !chartPrefs.showExtendedHours && !hasExtendedFilterFallback;

  const activePriorVwapSeed = useMemo(() => {
    if (!isUsStockForVwap) return null;
    if (isReplaying) {
      if (!(replaySimTimeSec > 0) || liveIndicatorData.length === 0) return null;
      const firstSec = Number(liveIndicatorData[0]!.time);
      if (!Number.isFinite(firstSec) || firstSec <= 0) return null;
      return computeCausalReplayVwapSeed(selectedSymbol, firstSec, replaySimTimeSec, {
        sessionTimeZone: "america-new-york",
        anchorAtRegularOpen: anchorVwapAtRegularOpen,
        source: indicatorSettings.vwap?.source ?? "hlc3",
      });
    }
    return getStockVwapSeed(selectedSymbol, chartPrefs.showExtendedHours, timeframe);
  }, [
    isUsStockForVwap,
    isReplaying,
    replaySimTimeSec,
    liveIndicatorData,
    selectedSymbol,
    anchorVwapAtRegularOpen,
    indicatorSettings.vwap?.source,
    chartPrefs.showExtendedHours,
    timeframe,
  ]);

  const fine1mVwapBundle = useMemo(() => {
    const tfSec = parseTimeframeSeconds(timeframe);
    if (tfSec <= 60 || tfSec >= 86_400) {
      return { candles: null, rawCoverageStartSec: undefined as number | undefined };
    }
    if (!isStockSymbol && !isCryptoInstrument(selectedSymbol)) {
      return { candles: null, rawCoverageStartSec: undefined };
    }
    if (isStockSymbol && !hasRealStockSeries(selectedSymbol) && !isReplaying) {
      return { candles: null, rawCoverageStartSec: undefined };
    }
    const raw1m =
      isReplaying && replaySimTimeSec > 0
        ? getReplaySliceForTimeframe(selectedSymbol, "1m", replaySimTimeSec)
        : getHistory(selectedSymbol, "1m");
    if (raw1m.length === 0) {
      return { candles: null, rawCoverageStartSec: undefined };
    }
    const rawCoverageStartSec = raw1m[0]!.time;
    if (isStockSymbol && !chartPrefs.showExtendedHours && !hasExtendedFilterFallback) {
      return {
        candles: filterExtendedHoursCandles(raw1m, false, stockMetaForVwap, demoSymForVwap?.exchange),
        rawCoverageStartSec,
      };
    }
    return { candles: raw1m, rawCoverageStartSec };
  }, [
    timeframe,
    selectedSymbol,
    isStockSymbol,
    isReplaying,
    replaySimTimeSec,
    chartPrefs.showExtendedHours,
    hasExtendedFilterFallback,
    stockMetaForVwap,
    demoSymForVwap?.exchange,
    liveIndicatorData,
  ]);
  const fine1mVwapCandles = fine1mVwapBundle.candles;
  const chartRawCoverageStartSec = candles.length > 0 ? candles[0]!.time : undefined;

  useIndicators(
    chartRef,
    candleSeriesRef,
    liveIndicatorData,
    activeIndicators,
    isDark,
    chartPrefs.separateOscillators,
    chartEpoch,
    pipDigits,
    ["RSI", "MACD", "STOCH", "ATR"],
    timeframe,
    indicatorSettings,
    isUsStockForVwap ? "america-new-york" : "utc",
    Boolean(priceSyncActive),
    activePriorVwapSeed,
    anchorVwapAtRegularOpen,
    fine1mVwapCandles,
    chartRawCoverageStartSec,
    fine1mVwapBundle.rawCoverageStartSec,
    isUsStockForVwap,
    isReplaying,
  );

  // ── Real-time live stream (IBKR for stocks, Crypto SSE for crypto/perps; persists across TF switches) ──
  useEffect(() => {
    if (isReplaying) return;
    if (isCryptoInstrument(selectedSymbol)) {
      return trackCryptoSymbol(selectedSymbol);
    }
    const demoSym = getDemoSymbol(selectedSymbol);
    const resolvedCategory = (symbolInfo?.category ?? demoSym?.category ?? "").toUpperCase();
    if (resolvedCategory !== "STOCKS") return;
    return trackIbkrSymbol(selectedSymbol);
  }, [selectedSymbol, symbolInfo, isReplaying]);

  // ── Extended-hours session shading (Yellow Pre-Market / Blue After-Hours) ──
  useEffect(() => {
    const series = candleSeriesRef.current;
    const demoSym = getDemoSymbol(selectedSymbol);

    if (series && isStockSymbol && isIntradayTf && chartPrefs.showExtendedHours && chartData.length > 0) {
      const meta = getStockSessionMetadata(selectedSymbol, timeframe);
      const exchange = demoSym?.exchange;
      if (extendedHoursPrimRef.current && extendedHoursPrimRef.current.series === series) {
        extendedHoursPrimRef.current.prim.updateOptions({ meta, exchange, isDark });
      } else {
        if (extendedHoursPrimRef.current) {
          try {
            extendedHoursPrimRef.current.series.detachPrimitive(extendedHoursPrimRef.current.prim);
          } catch {
            /* disposed */
          }
          extendedHoursPrimRef.current = null;
        }
        const prim = new ExtendedHoursPrimitive({ meta, exchange, isDark });
        try {
          series.attachPrimitive(prim);
          extendedHoursPrimRef.current = { series, prim };
        } catch {
          /* series not ready */
        }
      }
    } else if (extendedHoursPrimRef.current) {
      try {
        extendedHoursPrimRef.current.series.detachPrimitive(extendedHoursPrimRef.current.prim);
      } catch {
        /* disposed */
      }
      extendedHoursPrimRef.current = null;
    }
  }, [
    selectedSymbol,
    timeframe,
    chartData,
    isDark,
    chartEpoch,
    isStockSymbol,
    isIntradayTf,
    chartPrefs.showExtendedHours,
  ]);

  // ── Replay trade event markers ─────────────────────────────
  useEffect(() => {
    const series = candleSeriesRef.current;
    if (!series) return;
    const setMarkersSafe = (list: SeriesMarker<Time>[]) => {
      try {
        series.setMarkers(list);
      } catch {
        /* chart already disposed */
      }
    };
    if (!replayTradeEvents || replayTradeEvents.length === 0) {
      setMarkersSafe([]);
      return;
    }
    const markers: SeriesMarker<Time>[] = [];
    for (const ev of replayTradeEvents) {
      const marker = buildReplayMarker(ev, timeframe);
      if (marker) markers.push(marker);
    }
    // lightweight-charts requires markers sorted by time ascending
    markers.sort((a, b) => (a.time as number) - (b.time as number));
    setMarkersSafe(markers);
    return () => {
      setMarkersSafe([]);
    };
  }, [replayTradeEvents, timeframe]);

  // ── Create / destroy the chart instance ────────────────────
  useEffect(() => {
    if (!containerRef.current) return;

    const minMove = getMinMove(pipDigits);

    const chart = createChart(containerRef.current, {
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
        scaleMargins: { top: 0.06, bottom: 0.18 },
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
        secondsVisible: timeframeRef.current === "1m",
        rightOffset: isReplaying ? 30 : (timeframeRef.current === "1m" ? 6 : 4),
        minBarSpacing: 0.5,
        fixLeftEdge: false,
        fixRightEdge: false,
        borderVisible: true,
        visible:
          maximizedBlockId === "PRICE" ||
          (!maximizedBlockId && allActiveBlocks[allActiveBlocks.length - 1] === "PRICE"),
      },
      watermark: {
        visible: false,
      },
      handleScroll: {
        mouseWheel: false,
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

    const candleSeries = chart.addCandlestickSeries({
      upColor: colors.up,
      downColor: colors.down,
      borderUpColor: colors.up,
      borderDownColor: colors.down,
      wickUpColor: colors.up,
      wickDownColor: colors.down,
      priceFormat: {
        type: "price",
        precision: pipDigits,
        minMove,
      },
      // Show authoritative last price on the right price scale and dotted horizontal price line
      lastValueVisible: true,
      priceLineVisible: true,
      priceLineWidth: 1,
      priceLineColor: "",
      priceLineStyle: LineStyle.Dotted,
    });
    candleSeriesRef.current = candleSeries;

    // Volume histogram at the bottom of the chart: hide redundant/zero price scale badges
    const volumeSeries = chart.addHistogramSeries({
      priceFormat: { type: "volume" },
      priceScaleId: "",
      lastValueVisible: false,
      priceLineVisible: false,
    });
    chart.priceScale("").applyOptions({
      scaleMargins: { top: 0.85, bottom: 0 },
    });
    volumeSeriesRef.current = volumeSeries;

    // Volume 20-period Moving Average line overlaid on the volume pane
    const volumeMaSeries = chart.addLineSeries({
      priceFormat: { type: "volume" },
      priceScaleId: "",
      color: "#2962FF",
      lineWidth: 2,
      lastValueVisible: false,
      priceLineVisible: false,
    });
    volumeMaSeriesRef.current = volumeMaSeries;

    // Subscribe to crosshair move for shared crosshair across modular panes (snapped discretely candle-to-candle)
    chart.subscribeCrosshairMove((param) => {
      if (priceSyncActiveRef.current && priceSyncControllerRef.current) {
        if (!param?.point || param.point.y < 0) {
          priceSyncControllerRef.current.clearHoverFrom("left");
        } else {
          const p = candleSeriesRef.current?.coordinateToPrice(param.point.y);
          if (p !== null && p !== undefined && Number.isFinite(Number(p))) {
            const top = containerRef.current?.getBoundingClientRect().top ?? 0;
            priceSyncControllerRef.current.publishHover({
              source: "left",
              price: Number(p),
              clientY: top + param.point.y,
            });
          }
        }
      }
      if (!param?.time || !param.point || param.point.x < 0) {
        setSharedCrosshairTime(null);
        setSharedCrosshairX(null);
        return;
      }
      const snappedX = chart.timeScale().timeToCoordinate(param.time);
      setSharedCrosshairTime(param.time);
      setSharedCrosshairX(snappedX !== null ? Number(snappedX) : null);
    });

    // Handle resize
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        if (entry.target === containerRef.current) {
          const w = Math.floor(entry.contentRect.width);
          const h = Math.floor(entry.contentRect.height);
          if (w > 0 && h > 0) {
            chart.applyOptions({ width: w, height: h });
          }
        }
      }
      if (outerContainerRef.current) {
        containerHeightRef.current = outerContainerRef.current.clientHeight;
      }
    });
    ro.observe(containerRef.current);
    if (outerContainerRef.current) {
      ro.observe(outerContainerRef.current);
    }

    // Interactive drawing layer (place / preview / select / drag / delete) —
    // callbacks go through refs so the create-effect doesn't depend on them.
    const drawingManager = new DrawingToolsManager({
      chart,
      series: candleSeries,
      container: containerRef.current,
      intervalSec: (TF_INTERVAL_MS[timeframeRef.current] ?? 60_000) / 1000,
      timeframe: timeframeRef.current,
      accountEquity: accountEquityRef.current,
      callbacks: {
        onAdd: (d) => onAddDrawingRef.current(d),
        onUpdate: (d) => onUpdateDrawingRef.current?.(d),
        onRemove: (id) => onRemoveDrawingRef.current?.(id),
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
          drawingMenuOpenedRef.current = true;
          setSelectedDrawingIds([id]);
          setContextMenu({ id, x: clientX, y: clientY });
        },
        onSelectTool: (t) => onDrawingToolSelectRef.current?.(t),
        onUndo: () => onUndoDrawingRef.current?.(),
        onRedo: () => onRedoDrawingRef.current?.(),
      },
    });
    drawingManager.setDrawings(drawingsRef.current);
    drawingManager.setTool(drawingToolRef.current);
    drawingManager.setMagnetMode(magnetRef.current);
    drawingManager.setStyleDefaults(styleDefaultsRef.current);
    drawingManager.setStayInDrawingMode(stayInModeRef.current);
    drawingManagerRef.current = drawingManager;

    // Subscribe to time-scale scrolling so we can load older bars when the
    // user scrolls past the leftmost loaded candle (infinite history pattern).
    // `historyLoadCancelled` guards against a stale fetch resolving after a
    // symbol/timeframe/theme change: the cleanup sets it to true before
    // unsubscribing so any in-flight `onLoaded` callback is silently dropped.
    let historyLoadCancelled = false;
    const handleRangeChange = makeHistoryLoader(
      selectedSymbol,
      timeframeRef,
      candleSeriesRef,
      loadMoreRef,
      (bars) => {
        if (!historyLoadCancelled && bars.length > 0) {
          setHistoricalExtra((prev) => {
            const seen = new Set(prev.map((b) => b.time));
            const fresh = bars.filter((b) => !seen.has(b.time));
            return [...fresh, ...prev];
          });
        }
      },
    );
    const combinedRangeChange = (range: LogicalRange | null) => {
      handleRangeChange(range);
      if (range && !isSyncingRangeRef.current) {
        isSyncingRangeRef.current = true;
        try {
          for (const [_t, otherChart] of oscillatorChartsRef.current) {
            if (otherChart) {
              otherChart.timeScale().setVisibleLogicalRange(range);
            }
          }
        } catch {
          // ignore
        } finally {
          isSyncingRangeRef.current = false;
        }
      }
    };
    chart.timeScale().subscribeVisibleLogicalRangeChange(combinedRangeChange);

    const chartContainer = containerRef.current;
    const handleContainerWheel = (e: WheelEvent) => {
      const target = e.target as HTMLElement;
      if (target?.closest("input, textarea, button, [role='dialog'], .no-chart-zoom")) return;

      e.preventDefault();
      e.stopPropagation();

      const timeScale = chart.timeScale();
      const range = timeScale.getVisibleLogicalRange();
      if (!range) return;

      const count = range.to - range.from;

      if (Math.abs(e.deltaY) < 1 && Math.abs(e.deltaX) > 0) {
        // Trackpad horizontal swipe pan
        const rect = chartContainer?.getBoundingClientRect();
        const panDelta = count * (e.deltaX / ((rect?.width ?? 800) || 800)) * 0.75;
        timeScale.setVisibleLogicalRange({ from: range.from + panDelta, to: range.to + panDelta });
        return;
      }

      // Wheel vertical zoom (scroll up = zoom in, scroll down = zoom out)
      const zoomFactor = e.deltaY < 0 ? -0.15 : 0.15;
      const delta = count * zoomFactor;

      const rect = chartContainer?.getBoundingClientRect();
      const mouseRatio =
        rect && rect.width > 0 ? Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)) : 0.5;

      const newFrom = range.from + delta * mouseRatio;
      const newTo = range.to - delta * (1 - mouseRatio);

      if (newTo - newFrom >= 4) {
        timeScale.setVisibleLogicalRange({ from: newFrom, to: newTo });
      }
    };

    chartContainer?.addEventListener("wheel", handleContainerWheel, { passive: false, capture: true });

    const handleDblClick = (e: MouseEvent) => {
      const rect = chartContainer?.getBoundingClientRect();
      if (rect && e.clientX >= rect.right - 85) {
        setIsManualScale(false);
      }
    };
    chartContainer?.addEventListener("dblclick", handleDblClick);

    // Signal listener-binding hooks that a live chart instance now exists.
    setChartEpoch((e) => e + 1);

    return () => {
      historyLoadCancelled = true;
      chartContainer?.removeEventListener("wheel", handleContainerWheel, { capture: true });
      chartContainer?.removeEventListener("dblclick", handleDblClick);
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(combinedRangeChange);
      ro.disconnect();
      drawingManager.destroy();
      drawingManagerRef.current = null;
      setSelectedDrawingIds([]);
      setShowDrawingSettings(false);
      chart.remove();
      chartRef.current = null;
      candleSeriesRef.current = null;
      volumeSeriesRef.current = null;
      volumeMaSeriesRef.current = null;
      bidLineRef.current = null;
      askLineRef.current = null;
      midLineRef.current = null;
      overlayLineMapRef.current.clear();
      slTpLinesRef.current.clear();
      chartPluginsRef.current = [];
      extendedHoursPrimRef.current = null;
      lastCandleRef.current = null;
      lastCandleSymbolRef.current = "";
      legendVolRef.current = 0;
      liveCandleTsRef.current = 0;
      loadMoreRef.current = {
        loading: false,
        noMoreData: false,
        lastFetchedBeforeMs: 0,
        fetchFromMs: 0,
      };
      lastGapRefetchAtRef.current = 0;
    };
  }, [
    isDark,
    pipDigits,
    colors.background,
    colors.text,
    colors.grid,
    colors.crosshair,
    colors.watermark,
    colors.up,
    colors.down,
    selectedSymbol,
    handleModularCrosshairMove,
  ]);

  // Ensure built-in vertical crosshair line and built-in date label are always hidden on the Price chart
  // so only the unified discrete vertical line across Price, RSI, and MACD is displayed
  useEffect(() => {
    chartRef.current?.applyOptions({
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: {
          visible: false,
          labelVisible: false,
        },
      },
    });
  }, [chartEpoch, isDark, activePlugins]);

  // Resize chart canvas immediately when any block is maximized or restored
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
  }, [maximizedBlockId]);

  // Synchronize price axis bounds and cross-pane horizontal crosshair when 2x1 price sync is active
  useEffect(() => {
    const chart = chartRef.current;
    const candleSeries = candleSeriesRef.current;
    const el = containerRef.current;

    const handleMouseLeave = () => {
      priceSyncController?.clearHoverFrom("left");
    };
    el?.addEventListener("mouseleave", handleMouseLeave);

    if (!priceSyncActive || !priceSyncController || !chart || !candleSeries || !el) {
      try {
        chart?.priceScale("right").applyOptions({
          visible: true,
          autoScale: true,
          scaleMargins: { top: 0.06, bottom: 0.18 },
        });
        candleSeries?.applyOptions({
          autoscaleInfoProvider: (base: () => AutoscaleInfo | null) => base(),
        });
      } catch {
        /* chart disposed */
      }
      if (syncHorzLineRef.current) {
        syncHorzLineRef.current.style.display = "none";
      }
      return () => {
        el?.removeEventListener("mouseleave", handleMouseLeave);
        priceSyncController?.clearHoverFrom("left");
      };
    }

    try {
      chart.priceScale("right").applyOptions({
        visible: false,
        autoScale: true,
        scaleMargins: { top: 0, bottom: 0 },
      });
    } catch {
      /* chart disposed */
    }

    const getPaneHeight = () => {
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
    };

    const applyBounds = (bounds: SyncedPriceBounds | null) => {
      if (!bounds || bounds.symbol !== selectedSymbol) return;
      const localTop = el.getBoundingClientRect().top;
      const localPaneH = getPaneHeight();
      const rawRange = computeAlignedLocalPriceRange(bounds, localTop, localPaneH);
      if (!rawRange) return;
      const refPrice = lastCandleRef.current?.close ?? 0;
      if (refPrice > 0 && (rawRange.minValue > refPrice * 5 || rawRange.maxValue < refPrice * 0.2)) {
        try {
          candleSeries.applyOptions({
            autoscaleInfoProvider: (base: () => AutoscaleInfo | null) => base(),
          });
        } catch {
          /* chart disposed */
        }
        return;
      }
      // If modular sub-panels (e.g. RSI above PRICE) offset `localTop` so the latest candle would clip
      // off-screen, shift/clamp the synced range so the active 1m candles stay cleanly framed.
      let effectiveRange = rawRange;
      if (refPrice > 0 && (refPrice < rawRange.minValue || refPrice > rawRange.maxValue)) {
        effectiveRange = {
          minValue: Math.min(bounds.botPrice, refPrice * 0.995),
          maxValue: Math.max(bounds.topPrice, refPrice * 1.005),
        };
      }
      try {
        candleSeries.applyOptions({
          autoscaleInfoProvider: () => ({ priceRange: effectiveRange }),
        });
        chart.priceScale("right").applyOptions({
          visible: false,
          autoScale: true,
          scaleMargins: { top: 0.04, bottom: 0.16 },
        });
      } catch {
        /* chart disposed */
      }
    };

    const unsubBounds = priceSyncController.subscribeBounds(applyBounds);
    const rafId = requestAnimationFrame(() => applyBounds(priceSyncController.getBounds()));

    const ro =
      typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(() => {
            applyBounds(priceSyncController.getBounds());
          })
        : null;
    ro?.observe(el);

    const unsubHover = priceSyncController.subscribeHover((hover) => {
      const lineEl = syncHorzLineRef.current;
      if (!lineEl) return;
      if (!hover || hover.source !== "right") {
        lineEl.style.display = "none";
        return;
      }
      const y = candleSeries.priceToCoordinate(hover.price);
      const paneH = getPaneHeight();
      if (y === null || !Number.isFinite(Number(y)) || Number(y) < 0 || Number(y) > paneH) {
        lineEl.style.display = "none";
        return;
      }
      lineEl.style.display = "block";
      lineEl.style.transform = `translateY(${Math.round(Number(y))}px)`;
    });

    return () => {
      cancelAnimationFrame(rafId);
      ro?.disconnect();
      unsubBounds();
      unsubHover();
      el.removeEventListener("mouseleave", handleMouseLeave);
      priceSyncController.clearHoverFrom("left");
      if (syncHorzLineRef.current) {
        syncHorzLineRef.current.style.display = "none";
      }
    };
  }, [priceSyncActive, priceSyncController, chartEpoch, blockOrder, effectiveMaximizedBlockId, selectedSymbol]);

  // ── Replay bar-picker click subscription ───────────────────
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
        for (let i = chartData.length - 1; i >= 0; i--) {
          if ((chartData[i]!.time as number) <= clickedTime) {
            oldCutIdx = i;
            break;
          }
        }
        if (oldRange && oldCutIdx >= 0) {
          replayCutOffsetRef.current = {
            barsLeft: Math.max(15, oldCutIdx - oldRange.from),
            barsRight: Math.max(4, oldRange.to - oldCutIdx),
          };
        } else {
          replayCutOffsetRef.current = null;
        }
        isEnteringReplayRef.current = true;
        onPickReplayBar(clickedTime, timeframe);
      }
    };

    chart.subscribeClick(handler);
    return () => {
      try {
        chart.unsubscribeClick(handler);
      } catch {
        /* chart already destroyed */
      }
    };
  }, [replayPicking, onPickReplayBar, chartEpoch, chartData, timeframe]);

  // Watermark disabled
  useEffect(() => {
    chartRef.current?.applyOptions({
      watermark: {
        visible: false,
      },
    });
  }, [chartEpoch]);

  // ── Live appearance settings (no chart recreation) ──
  useEffect(() => {
    const up = colors.up;
    const down = colors.down;
    candleSeriesRef.current?.applyOptions({
      upColor: up,
      downColor: down,
      borderUpColor: up,
      borderDownColor: down,
      wickUpColor: up,
      wickDownColor: down,
      wickVisible: chartPrefs.showWicks,
      borderVisible: chartPrefs.showCandleBorders,
    });
  }, [
    chartPrefs.candleUpColor,
    chartPrefs.candleDownColor,
    chartPrefs.showWicks,
    chartPrefs.showCandleBorders,
    colors.up,
    colors.down,
    chartEpoch,
  ]);

  useEffect(() => {
    volumeSeriesRef.current?.applyOptions({ visible: chartPrefs.showVolume });
    volumeMaSeriesRef.current?.applyOptions({
      visible: chartPrefs.showVolume && (chartPrefs.showVolumeMa ?? true),
    });
  }, [chartPrefs.showVolume, chartPrefs.showVolumeMa, chartEpoch]);

  useEffect(() => {
    chartRef.current?.applyOptions({
      grid: {
        vertLines: { visible: chartPrefs.showGrid },
        horzLines: { visible: chartPrefs.showGrid },
      },
    });
  }, [chartPrefs.showGrid, chartEpoch]);

  useEffect(() => {
    timeframeRef.current = timeframe;
    chartRef.current?.applyOptions({
      timeScale: {
        secondsVisible: parseTimeframeSeconds(timeframe) <= 60,
        rightOffset: isReplaying ? 30 : (parseTimeframeSeconds(timeframe) <= 60 ? 6 : 4),
        minBarSpacing: 0.5,
      },
    });
    drawingManagerRef.current?.updateTimeframe(
      timeframe,
      (TF_INTERVAL_MS[timeframe] ?? 60_000) / 1000,
    );
  }, [timeframe, isReplaying]);

  // Ensure timeScale date axis is ONLY shown on the bottom-most active block
  useEffect(() => {
    if (!chartRef.current) return;
    const isPriceLast =
      maximizedBlockId === "PRICE" ||
      (!maximizedBlockId && allActiveBlocks[allActiveBlocks.length - 1] === "PRICE");
    chartRef.current.timeScale().applyOptions({
      visible: isPriceLast,
    });
  }, [allActiveBlocks, maximizedBlockId]);

  // ── Refs for smooth real-time streaming ────────────────
  const lastCandleRef = useRef<CandlestickData<Time> | null>(null);
  const lastCandleSymbolRef = useRef<string>("");
  const lastLoadKeyRef = useRef<string>("");
  const latestLiveCandleRef = useRef<typeof liveCandle | undefined>(undefined);
  const latestTickRef = useRef<typeof tick | undefined>(undefined);
  const liveCandleTsRef = useRef<number>(0);
  const legendVolRef = useRef<number>(0);
  const recentVolsRef = useRef<number[]>([]);
  const prev19VolSumRef = useRef<number>(0);
  const hasVolumeMaRef = useRef<boolean>(false);

  const allowLiveBar = useCallback(
    (timeSec: number): boolean => {
      if (!isStockSymbol || !isIntradayTf || chartPrefs.showExtendedHours || hasExtendedFilterFallback) {
        return true;
      }
      const demoSym = getDemoSymbol(selectedSymbol);
      const meta = getStockSessionMetadata(selectedSymbol, timeframe);
      return classifyExtendedSession(timeSec, meta, demoSym?.exchange) === "regular";
    },
    [
      isStockSymbol,
      isIntradayTf,
      chartPrefs.showExtendedHours,
      hasExtendedFilterFallback,
      selectedSymbol,
      timeframe,
    ],
  );

  const makeRtCtx = useCallback(
    (series: ISeriesApi<"Candlestick">): RtCtx => ({
      series,
      volume: volumeSeriesRef.current,
      volumeMa: volumeMaSeriesRef.current,
      recentVols: recentVolsRef,
      prev19VolSum: prev19VolSumRef,
      hasVolumeMa: hasVolumeMaRef,
      lastCandle: lastCandleRef,
      lastCandleSymbol: lastCandleSymbolRef,
      liveCandleTs: liveCandleTsRef,
      legendVol: legendVolRef,
      gapAt: lastGapRefetchAtRef,
      bidLine: bidLineRef,
      askLine: askLineRef,
      midLine: midLineRef,
      exitReplayAt: exitReplayAtRef,
      colors,
      timeframe,
      symbol: selectedSymbol,
      qc: queryClient,
      allowLiveBar,
      blockTickNewBucket: isStockSymbol || isCryptoInstrument(selectedSymbol),
      ignoreTickMidpoint: isStockSymbol || isCryptoInstrument(selectedSymbol),
      isDelayedStock: isStockSymbol && ibkrDelayed,
    }),
    [colors, timeframe, selectedSymbol, queryClient, allowLiveBar, isStockSymbol, ibkrDelayed],
  );

  useEffect(() => {
    latestLiveCandleRef.current = liveCandle;
  }, [liveCandle]);

  useEffect(() => {
    latestTickRef.current = tick;
  }, [tick]);

  // Update candle data from server (historical fetch / periodic sync / replay slice)
  useEffect(() => {
    const series = candleSeriesRef.current;
    if (!series) return;
    if (chartData.length === 0) {
      lastCandleRef.current = null;
      lastCandleSymbolRef.current = "";
      legendVolRef.current = 0;
      prev19VolSumRef.current = 0;
      hasVolumeMaRef.current = false;
      try {
        series.setData([]);
        volumeSeriesRef.current?.setData([]);
        volumeMaSeriesRef.current?.setData([]);
      } catch {
        /* chart disposed */
      }
      return;
    }
    const ctx = makeRtCtx(series);
    const loadKey = `${selectedSymbol}:${timeframe}:${chartEpoch}:${isReplaying ? "replay" : "live"}:${chartPrefs.showExtendedHours ? "ext" : "rth"}`;
    const isNewChart = lastLoadKeyRef.current !== loadKey;
    const isTfChange = prevTimeframeRef.current !== timeframe;
    prevTimeframeRef.current = timeframe;

    const isEnteringReplay = isEnteringReplayRef.current || (!wasReplayingRef.current && isReplaying);
    const isExitingReplay = wasReplayingRef.current && !isReplaying;
    wasReplayingRef.current = isReplaying;

    if (!isReplaying) {
      prevReplayLenRef.current = 0;
      prevReplayLastTimeRef.current = 0;
    }

    if (isExitingReplay) {
      exitReplayAtRef.current = Date.now();
    }

    const preSetDataRange = chartRef.current?.timeScale().getVisibleLogicalRange() ?? null;

    series.setData(chartData);
    volumeSeriesRef.current?.setData(volumeData);
    volumeMaSeriesRef.current?.setData(volumeMaData);
    legendVolRef.current = volumeData.length > 0 ? (volumeData[volumeData.length - 1]!.value ?? 0) : 0;
    if (volumeData.length >= 20) {
      const prev19: number[] = [];
      let s19 = 0;
      for (let i = volumeData.length - 20; i < volumeData.length - 1; i++) {
        const v = volumeData[i]!.value;
        prev19.push(v);
        s19 += v;
      }
      recentVolsRef.current = prev19;
      prev19VolSumRef.current = s19;
      hasVolumeMaRef.current = true;
    } else {
      recentVolsRef.current = volumeData.slice(0, -1).map((d) => d.value);
      prev19VolSumRef.current = recentVolsRef.current.reduce((a, b) => a + b, 0);
      hasVolumeMaRef.current = false;
    }
    const latestBar = chartData[chartData.length - 1] ?? null;
    lastCandleRef.current = latestBar;
    lastCandleSymbolRef.current = selectedSymbol;
    if (isNewChart || isEnteringReplay) {
      chartRef.current?.priceScale("right").applyOptions({ autoScale: true });
      setIsManualScale(false);
    }
    if (isReplaying) {
      const latestBarTime = latestBar ? (latestBar.time as number) : 0;
      const prevBarTime = prevReplayLastTimeRef.current;
      const delta = prevReplayLenRef.current > 0 ? chartData.length - prevReplayLenRef.current : 0;
      const isSequentialBar =
        prevBarTime > 0 &&
        latestBarTime > 0 &&
        Math.abs(latestBarTime - prevBarTime) <= intervalSecOf(timeframe) * 2;
      const isIntraBarReplayUpdate =
        !isEnteringReplay &&
        !isTfChange &&
        prevReplayLenRef.current > 0 &&
        delta === 0 &&
        prevBarTime > 0 &&
        latestBarTime === prevBarTime;
      const isReplayStep =
        isIntraBarReplayUpdate ||
        (!isEnteringReplay &&
          !isTfChange &&
          prevReplayLenRef.current > 0 &&
          Math.abs(delta) === 1 &&
          isSequentialBar);
      prevReplayLenRef.current = chartData.length;
      prevReplayLastTimeRef.current = latestBarTime;
      isEnteringReplayRef.current = false;
      lastLoadKeyRef.current = loadKey;

      if (!isReplayStep) {
        chartRef.current?.priceScale("right").applyOptions({ autoScale: true });
        setIsManualScale(false);
        const newCutIdx = chartData.length - 1;
        const rightPad = isReplaying ? 30 : (parseTimeframeSeconds(timeframe) <= 60 ? 10 : 6);
        const cutOffset = replayCutOffsetRef.current;
        replayCutOffsetRef.current = null;
        const targetRange = (cutOffset
          ? { from: newCutIdx - cutOffset.barsLeft, to: newCutIdx + cutOffset.barsRight }
          : { from: newCutIdx - 90, to: newCutIdx + rightPad }) as unknown as LogicalRange;

        if (chartRef.current) {
          isSyncingRangeRef.current = true;
          try {
            chartRef.current.timeScale().setVisibleLogicalRange(targetRange);
            for (const [_t, otherChart] of oscillatorChartsRef.current) {
              if (otherChart) {
                try {
                  otherChart.timeScale().setVisibleLogicalRange(targetRange);
                } catch {
                  // ignore
                }
              }
            }
          } finally {
            requestAnimationFrame(() => {
              isSyncingRangeRef.current = false;
            });
          }
        }
      } else if (chartRef.current) {
        // Advance viewport by delta (+1 or -1) and keep Price, RSI & MACD 100% locked 1:1
        const baseRange = preSetDataRange ?? chartRef.current.timeScale().getVisibleLogicalRange();
        if (baseRange) {
          const stepRange = {
            from: baseRange.from + delta,
            to: baseRange.to + delta,
          } as unknown as LogicalRange;
          isSyncingRangeRef.current = true;
          try {
            chartRef.current.timeScale().setVisibleLogicalRange(stepRange);
            for (const [_t, otherChart] of oscillatorChartsRef.current) {
              if (otherChart) {
                try {
                  otherChart.timeScale().setVisibleLogicalRange(stepRange);
                } catch {
                  // ignore
                }
              }
            }
          } finally {
            requestAnimationFrame(() => {
              isSyncingRangeRef.current = false;
            });
          }
        }
      }
      return;
    }

    // Case 3: Timeframe change or exiting replay (cleanly frame at the latest candles)
    if (isTfChange || isExitingReplay) {
      lastLoadKeyRef.current = loadKey;
      isSyncingRangeRef.current = true;
      if (chartRef.current) {
        chartRef.current.timeScale().resetTimeScale();
        chartRef.current.timeScale().scrollToPosition(parseTimeframeSeconds(timeframe) <= 60 ? 10 : 6, false);
        const newRange = chartRef.current.timeScale().getVisibleLogicalRange();
        if (newRange) {
          for (const [_t, otherChart] of oscillatorChartsRef.current) {
            if (otherChart) {
              try {
                otherChart.timeScale().setVisibleLogicalRange(newRange);
              } catch {
                // ignore
              }
            }
          }
        }
      }
      requestAnimationFrame(() => {
        isSyncingRangeRef.current = false;
      });
      const buffered = latestLiveCandleRef.current;
      liveCandleTsRef.current = 0;
      replayBufferedLive(buffered, chartData, ctx);
      return scheduleStaleRefetch(chartData, ctx);
    }

    // Case 4: Subsequent live updates without new chart epoch/timeframe
    const buffered = latestLiveCandleRef.current;
    if (!isNewChart) {
      reapplyLive(buffered, ctx);
      const recentTick = latestTickRef.current;
      if (recentTick && recentTick.timestamp > 0 && Date.now() - recentTick.timestamp < 5_000) {
        applyTick(recentTick, ctx);
      }
      const liveRange = chartRef.current?.timeScale().getVisibleLogicalRange();
      if (liveRange) {
        for (const [_t, otherChart] of oscillatorChartsRef.current) {
          if (otherChart) {
            try {
              otherChart.timeScale().setVisibleLogicalRange(liveRange);
            } catch {
              // ignore
            }
          }
        }
      }
      return;
    }

    // Case 5: Initial chart load / symbol change
    scrollOrFit(chartRef.current, chartData.length);
    const initialRange = chartRef.current?.timeScale().getVisibleLogicalRange();
    if (initialRange) {
      for (const [_t, otherChart] of oscillatorChartsRef.current) {
        if (otherChart) {
          try {
            otherChart.timeScale().setVisibleLogicalRange(initialRange);
          } catch {
            // ignore
          }
        }
      }
    }
    lastLoadKeyRef.current = loadKey;
    liveCandleTsRef.current = 0;
    replayBufferedLive(buffered, chartData, ctx);
    return scheduleStaleRefetch(chartData, ctx);
  }, [chartData, volumeData, volumeMaData, selectedSymbol, timeframe, makeRtCtx, chartEpoch, isReplaying]);

  // ── Real-time candle updates ──────────────────────────
  useEffect(() => {
    if (isReplaying) return;
    const series = candleSeriesRef.current;
    if (!series || !liveCandle || !lastCandleRef.current) return;
    applyServerCandle(liveCandle, makeRtCtx(series));
  }, [liveCandle, makeRtCtx, isReplaying]);

  useEffect(() => {
    if (isReplaying) return;
    const series = candleSeriesRef.current;
    if (!series || !tick) return;
    applyTick(tick, makeRtCtx(series));
  }, [tick, makeRtCtx, isReplaying]);

  // ── Line-cross price alerts (client-side, in-session) ──────────
  const alertMidRef = useRef<number | null>(null);
  const alertFiredRef = useRef<Map<string, number>>(new Map());
  useEffect(() => {
    alertMidRef.current = null;
  }, [selectedSymbol, isReplaying]);
  useEffect(() => {
    if (!tick || isReplaying) return;
    const mid = (tick.bid + tick.ask) / 2;
    const prev = alertMidRef.current;
    alertMidRef.current = mid;
    if (prev === null) return;
    const nowSec = Math.floor(tick.timestamp / 1000);
    const crossed = detectCrossings(drawingsRef.current, prev, mid, nowSec, alertFiredRef.current);
    for (const d of crossed) {
      toast.info(
        "Price alert",
        d.alertMessage ?? `${selectedSymbol} crossed your ${d.type} @ ${mid.toFixed(pipDigits)}`,
      );
      playAlertBeep();
    }
  }, [tick, selectedSymbol, pipDigits, isReplaying]);

  // ── Staleness watchdog ────────────────────────────────────────
  useEffect(() => {
    if (isReplaying) return;
    const intervalSec = (TF_INTERVAL_MS[timeframe] ?? 60_000) / 1000;
    const id = setInterval(() => {
      if (!lastCandleRef.current) return;
      if (isStockSymbol && isIbkrLiveStreamConnected()) return;
      const rawNowSec = Date.now() / 1000;
      const expectedSec = isStockSymbol && ibkrDelayed ? rawNowSec - 900 : rawNowSec;
      const staleSec = expectedSec - (lastCandleRef.current.time as number);
      if (staleSec < intervalSec * 2 || staleSec > 18_000) return;
      requestGapRefetch(lastGapRefetchAtRef, queryClient, selectedSymbol, timeframe);
    }, 30_000);
    return () => clearInterval(id);
  }, [selectedSymbol, timeframe, queryClient, isReplaying, isStockSymbol, ibkrDelayed]);

  // ── Chart plugin overlays ──────────────────────────────────
  const symbolCategory = symbolInfo?.category;
  useEffect(() => {
    if (!candleSeriesRef.current) return;
    const series = candleSeriesRef.current;
    detachPlugins(series, chartPluginsRef.current);
    chartPluginsRef.current = [];
    attachPlugins(
      series,
      activePlugins,
      { isDark, timeframe, symbolCategory },
      chartPluginsRef.current,
    );
  }, [activePlugins, isDark, selectedSymbol, timeframe, symbolCategory, chartEpoch]);

  // ── Live bid/ask price tracking lines ──────────────────────
  const effectiveTick = useMemo(() => {
    if (isReplaying) {
      const lastClose = chartData[chartData.length - 1]?.close;
      return lastClose ? { bid: lastClose, ask: lastClose, timestamp: Date.now() } : undefined;
    }
    return tick;
  }, [isReplaying, chartData, tick]);

  useEffect(() => {
    const series = candleSeriesRef.current;
    if (!series) return;
    applyBidAskLines(
      effectiveTick,
      { showBidLine: chartPrefs.showBidLine, showAskLine: chartPrefs.showAskLine },
      makeRtCtx(series),
    );
  }, [effectiveTick, chartPrefs.showBidLine, chartPrefs.showAskLine, makeRtCtx, chartEpoch]);

  const baseUnit = useMemo(
    () => selectedSymbol.split("/")[0] ?? selectedSymbol,
    [selectedSymbol],
  );

  // ── Position/order/draft overlays (in-place update, never interrupts drag) ──
  useEffect(() => {
    const series = candleSeriesRef.current;
    if (!series) return;
    const lineMap = overlayLineMapRef.current;
    const slTpMap = slTpLinesRef.current;
    const activeKeys = new Set<string>();
    const activeSlTpKeys = new Set<string>();

    if (chartPrefs.overlayPositionsOnChart) {
      const contractSize = symbolInfo?.contractSize ?? 1;
      const opts: OverlayOpts = {
        symbol: selectedSymbol,
        baseUnit,
        colors,
        contractSize,
      };
      for (const pos of positions) {
        syncPositionOverlay(series, pos, opts, lineMap, activeKeys, activeSlTpKeys, slTpMap);
      }
      for (const ord of orders) {
        syncOrderOverlay(series, ord, opts, lineMap, activeKeys);
      }
      if (draftOrderPreview && Number.isFinite(draftOrderPreview.entryPrice) && draftOrderPreview.entryPrice > 0) {
        const draftSide = draftOrderPreview.side === "BUY" ? "LONG" : "SHORT";
        const dir = draftSide === "LONG" ? 1 : -1;
        const draftQty = draftOrderPreview.quantity > 0 ? draftOrderPreview.quantity : 0;
        const draftMeta = {
          positionId: "__draft__",
          side: draftSide as "LONG" | "SHORT",
          entryPrice: draftOrderPreview.entryPrice,
          quantity: draftQty,
          isDraft: true,
        };
        const pnlAt = (target: number) =>
          parseFloat(
            ((target - draftOrderPreview.entryPrice) * dir * draftQty * contractSize).toFixed(2),
          );
        if (
          typeof draftOrderPreview.takeProfit === "number" &&
          Number.isFinite(draftOrderPreview.takeProfit) &&
          draftOrderPreview.takeProfit > 0
        ) {
          upsertSlTpLine(
            series,
            lineMap,
            activeKeys,
            activeSlTpKeys,
            slTpMap,
            draftMeta,
            "takeProfit",
            draftOrderPreview.takeProfit,
            pnlAt(draftOrderPreview.takeProfit),
            colors,
          );
        }
        if (
          typeof draftOrderPreview.stopLoss === "number" &&
          Number.isFinite(draftOrderPreview.stopLoss) &&
          draftOrderPreview.stopLoss > 0
        ) {
          upsertSlTpLine(
            series,
            lineMap,
            activeKeys,
            activeSlTpKeys,
            slTpMap,
            draftMeta,
            "stopLoss",
            draftOrderPreview.stopLoss,
            pnlAt(draftOrderPreview.stopLoss),
            colors,
          );
        }
      }
    }

    if (
      isReplaying &&
      inspectedTrade &&
      inspectedTrade.symbolName === selectedSymbol
    ) {
      const tpVal = inspectedTrade.takeProfit;
      const slVal = inspectedTrade.stopLoss;
      if (typeof tpVal === "number" && Number.isFinite(tpVal) && tpVal > 0) {
        upsertManagedLine(series, lineMap, activeKeys, `hist:${inspectedTrade.id}:tp`, {
          price: tpVal,
          color: colors.tpLine,
          lineWidth: 3,
          lineStyle: LineStyle.Solid,
          axisLabelVisible: true,
          title: "",
        });
      }

      if (typeof slVal === "number" && Number.isFinite(slVal) && slVal > 0) {
        upsertManagedLine(series, lineMap, activeKeys, `hist:${inspectedTrade.id}:sl`, {
          price: slVal,
          color: colors.slLine,
          lineWidth: 3,
          lineStyle: LineStyle.Solid,
          axisLabelVisible: true,
          title: "",
        });
      }

      if (!priceSyncActive) {
        series.applyOptions({
          autoscaleInfoProvider: (original: () => { priceRange: { minValue: number; maxValue: number } | null } | null) => {
            const res = original();
            if (!res || !res.priceRange) return res;
            let minValue = res.priceRange.minValue;
            let maxValue = res.priceRange.maxValue;
            if (typeof tpVal === "number" && Number.isFinite(tpVal) && tpVal > 0) {
              minValue = Math.min(minValue, tpVal);
              maxValue = Math.max(maxValue, tpVal);
            }
            if (typeof slVal === "number" && Number.isFinite(slVal) && slVal > 0) {
              minValue = Math.min(minValue, slVal);
              maxValue = Math.max(maxValue, slVal);
            }
            const span = Math.max(Math.abs(maxValue - minValue), Math.abs(maxValue) * 0.01, 1e-8);
            return {
              ...res,
              priceRange: {
                minValue: minValue - span * 0.06,
                maxValue: maxValue + span * 0.06,
              },
            };
          },
        });
        chartRef.current?.priceScale("right").applyOptions({ autoScale: true });
      }
    } else if (!priceSyncActive) {
      series.applyOptions({ autoscaleInfoProvider: undefined });
    }

    for (const [key, line] of lineMap.entries()) {
      if (!activeKeys.has(key)) {
        try {
          series.removePriceLine(line);
        } catch {
          /* ignore */
        }
        lineMap.delete(key);
      }
    }
    for (const key of slTpMap.keys()) {
      if (!activeSlTpKeys.has(key)) {
        slTpMap.delete(key);
      }
    }
  }, [
    positions,
    orders,
    draftOrderPreview,
    isReplaying,
    inspectedTrade,
    selectedSymbol,
    baseUnit,
    symbolInfo,
    colors,
    chartPrefs.overlayPositionsOnChart,
    chartEpoch,
    priceSyncActive,
  ]);

  const symbolPositions = useMemo(
    () => positions.filter((p) => p.symbolName === selectedSymbol),
    [positions, selectedSymbol],
  );

  // ── Live On-Chart Risk/Reward Computation ──
  const chartRiskReward = useMemo(() => {
    const cSize = symbolInfo?.contractSize ?? 1;

    // 1. If user is actively dragging an SL or TP line on the chart
    if (dragPrice) {
      let isL = false;
      let entryPrice = 0;
      let qty = 0;
      let curTp: number | null = null;
      let curSl: number | null = null;

      if (dragPrice.positionId === "__draft__" && draftOrderPreview) {
        isL = draftOrderPreview.side === "BUY";
        entryPrice = draftOrderPreview.entryPrice;
        qty = draftOrderPreview.quantity > 0 ? draftOrderPreview.quantity : 1;
        curTp = dragPrice.field === "TP" ? dragPrice.price : (draftOrderPreview.takeProfit ?? null);
        curSl = dragPrice.field === "SL" ? dragPrice.price : (draftOrderPreview.stopLoss ?? null);
      } else if (dragPrice.positionId) {
        const pos = symbolPositions.find((p) => p.id === dragPrice.positionId);
        if (pos) {
          isL = pos.side === "LONG";
          entryPrice = pos.entryPrice;
          qty = pos.quantity;
          curTp = dragPrice.field === "TP" ? dragPrice.price : (pos.takeProfit ?? null);
          curSl = dragPrice.field === "SL" ? dragPrice.price : (pos.stopLoss ?? null);
        }
      }

      if (entryPrice > 0) {
        const hasTp = curTp != null && Number.isFinite(curTp) && curTp > 0;
        const hasSl = curSl != null && Number.isFinite(curSl) && curSl > 0;
        const rewardDist = hasTp ? (isL ? curTp! - entryPrice : entryPrice - curTp!) : null;
        const riskDist = hasSl ? (isL ? entryPrice - curSl! : curSl! - entryPrice) : null;
        const rewardDollar = rewardDist != null && rewardDist > 0 ? rewardDist * qty * cSize : null;
        const riskDollar = riskDist != null && riskDist > 0 ? riskDist * qty * cSize : null;
        const ratio = rewardDollar != null && riskDollar != null && riskDollar > 0.001
          ? rewardDollar / riskDollar
          : null;
        return {
          source: "drag" as const,
          side: isL ? ("LONG" as const) : ("SHORT" as const),
          entryPrice,
          tpPrice: curTp,
          slPrice: curSl,
          riskDollar,
          rewardDollar,
          riskDist,
          rewardDist,
          ratio,
        };
      }
    }

    // 2. If draftOrderPreview is active from OrderPanel or FloatingOrderWidget
    if (
      draftOrderPreview &&
      Number.isFinite(draftOrderPreview.entryPrice) &&
      draftOrderPreview.entryPrice > 0 &&
      (draftOrderPreview.takeProfit != null || draftOrderPreview.stopLoss != null)
    ) {
      const isL = draftOrderPreview.side === "BUY";
      const entryPrice = draftOrderPreview.entryPrice;
      const qty = draftOrderPreview.quantity > 0 ? draftOrderPreview.quantity : 1;
      const tp = draftOrderPreview.takeProfit ?? null;
      const sl = draftOrderPreview.stopLoss ?? null;
      const hasTp = tp != null && Number.isFinite(tp) && tp > 0;
      const hasSl = sl != null && Number.isFinite(sl) && sl > 0;
      const rewardDist = hasTp ? (isL ? tp! - entryPrice : entryPrice - tp!) : null;
      const riskDist = hasSl ? (isL ? entryPrice - sl! : sl! - entryPrice) : null;
      const rewardDollar = rewardDist != null && rewardDist > 0 ? rewardDist * qty * cSize : null;
      const riskDollar = riskDist != null && riskDist > 0 ? riskDist * qty * cSize : null;
      const ratio = rewardDollar != null && riskDollar != null && riskDollar > 0.001
        ? rewardDollar / riskDollar
        : null;

      if (rewardDollar != null || riskDollar != null) {
        return {
          source: "draft" as const,
          side: isL ? ("LONG" as const) : ("SHORT" as const),
          entryPrice,
          tpPrice: tp,
          slPrice: sl,
          riskDollar,
          rewardDollar,
          riskDist,
          rewardDist,
          ratio,
        };
      }
    }

    // 3. If an open position exists on the symbol with TP or SL
    const activePos = symbolPositions.find((p) => p.takeProfit != null || p.stopLoss != null);
    if (activePos) {
      const isL = activePos.side === "LONG";
      const entryPrice = activePos.entryPrice;
      const qty = activePos.quantity;
      const tp = activePos.takeProfit ?? null;
      const sl = activePos.stopLoss ?? null;
      const hasTp = tp != null && Number.isFinite(tp) && tp > 0;
      const hasSl = sl != null && Number.isFinite(sl) && sl > 0;
      const rewardDist = hasTp ? (isL ? tp! - entryPrice : entryPrice - tp!) : null;
      const riskDist = hasSl ? (isL ? entryPrice - sl! : sl! - entryPrice) : null;
      const rewardDollar = rewardDist != null && rewardDist > 0 ? rewardDist * qty * cSize : null;
      const riskDollar = riskDist != null && riskDist > 0 ? riskDist * qty * cSize : null;
      const ratio = rewardDollar != null && riskDollar != null && riskDollar > 0.001
        ? rewardDollar / riskDollar
        : null;

      if (rewardDollar != null || riskDollar != null) {
        return {
          source: "position" as const,
          side: isL ? ("LONG" as const) : ("SHORT" as const),
          entryPrice,
          tpPrice: tp,
          slPrice: sl,
          riskDollar,
          rewardDollar,
          riskDist,
          rewardDist,
          ratio,
        };
      }
    }

    return null;
  }, [dragPrice, draftOrderPreview, symbolPositions, symbolInfo]);

  return (
    <div
      ref={outerContainerRef}
      id="opencharts-main-chart-container"
      data-symbol={selectedSymbol}
      data-timeframe={timeframe}
      onPointerLeave={() => {
        setSharedCrosshairTime(null);
        setSharedCrosshairX(null);
      }}
      className={cn(
        "relative w-full h-full flex flex-col overflow-hidden select-none",
        replayPicking && "cursor-crosshair",
      )}
      style={{ backgroundColor: colors.background }}
    >
      {allActiveBlocks.map((blockId, index) => {
        const isFirst = index === 0;
        const isLast = index === allActiveBlocks.length - 1;
        const isHidden = effectiveMaximizedBlockId !== null && effectiveMaximizedBlockId !== blockId;
        const heightPct = getBlockHeightPct(blockId);

        return (
          <Fragment key={blockId}>
            {!isFirst && !effectiveMaximizedBlockId && (
              <ResizeSplitter
                topBlockId={allActiveBlocks[index - 1]!}
                bottomBlockId={blockId}
                totalWeight={totalActiveWeight}
                containerHeightRef={containerHeightRef}
                onResize={handleSplitterResize}
              />
            )}

            <div
              className={cn(
                "relative w-full overflow-hidden",
                isHidden ? "hidden pointer-events-none" : "min-h-[50px]",
              )}
              style={
                effectiveMaximizedBlockId
                  ? {
                      height: isHidden ? "0%" : "100%",
                      display: isHidden ? "none" : undefined,
                    }
                  : {
                      flex: `${blockWeights[blockId] ?? 20} ${blockWeights[blockId] ?? 20} 0%`,
                      display: isHidden ? "none" : undefined,
                    }
              }
            >
              {blockId === "PRICE" && (
                <div
                  data-testid="pane-0-canvas"
                  onDoubleClick={(e) => {
                    if (
                      (e.target as HTMLElement | null)?.closest(
                        "button, a, input, select, textarea, [data-testid='drawing-tool-rail']",
                      )
                    ) {
                      return;
                    }
                    if (drawingTool !== "none" || replayPicking) return;
                    const rect = containerRef.current?.getBoundingClientRect();
                    if (
                      rect &&
                      rect.width > 0 &&
                      rect.height > 0 &&
                      (e.clientX >= rect.right - 85 || e.clientY >= rect.bottom - 32)
                    ) {
                      return;
                    }
                    if (canExpandPane && onToggleExpandPane) {
                      onToggleExpandPane();
                    } else {
                      toggleMaximizeBlock("PRICE");
                    }
                  }}
                  className="relative w-full h-full overflow-hidden"
                  title={
                    canExpandPane
                      ? isPaneExpanded
                        ? "Doble clic para restaurar vista dividida"
                        : "Doble clic para ampliar este gráfico"
                      : effectiveMaximizedBlockId === "PRICE"
                        ? "Doble clic para restaurar paneles"
                        : "Doble clic para maximizar gráfico de precio"
                  }
                >
                  {/* Drag-to-edit tooltip */}
                  {dragPrice && (
                    <div
                      className="absolute left-1/2 -translate-x-1/2 z-20 pointer-events-none"
                      style={{ top: Math.max(8, dragPrice.y - 32) }}
                    >
                      <div
                        className={cn(
                          "px-2.5 py-1 rounded text-[11px] font-mono font-bold shadow-lg border backdrop-blur-sm flex items-center gap-2",
                          dragPrice.field === "TP"
                            ? "bg-[#0ecb81]/20 text-[#0ecb81] border-[#0ecb81]/40"
                            : "bg-[#f6465d]/20 text-[#f6465d] border-[#f6465d]/40",
                        )}
                      >
                        <span>{dragPrice.field} → {dragPrice.price.toFixed(pipDigits)}</span>
                        <span
                          className={dragPrice.pnlUsd >= 0 ? "text-[#0ecb81]" : "text-[#f6465d]"}
                        >
                          ({dragPrice.pnlUsd >= 0 ? "+" : ""}${dragPrice.pnlUsd.toFixed(2)})
                        </span>
                        {chartRiskReward?.ratio != null && (
                          <span className="ml-1 pl-2 border-l border-border/60 text-[10px] text-foreground font-bold flex items-center gap-1.5">
                            <span>⚖️ R:B 1 : {chartRiskReward.ratio.toFixed(2)}</span>
                            <div className="w-12 h-1.5 bg-background rounded-full overflow-hidden flex border border-border/40">
                              <div
                                className="bg-[#f6465d]"
                                style={{ width: `${Math.max(10, Math.min(90, (1 / (1 + chartRiskReward.ratio)) * 100))}%` }}
                              />
                              <div
                                className="bg-[#0ecb81]"
                                style={{ width: `${Math.max(10, Math.min(90, (chartRiskReward.ratio / (1 + chartRiskReward.ratio)) * 100))}%` }}
                              />
                            </div>
                          </span>
                        )}
                      </div>
                    </div>
                  )}

                  {/* Transparent drag hit-zone over native right-edge SL/TP badges */}
                  {Array.from(slTpLinesRef.current.entries()).map(([key, entry]) => {
                    if (
                      entry.positionId !== "__draft__" &&
                      !positions.some((p) => p.id === entry.positionId)
                    ) {
                      return null;
                    }
                    const series = candleSeriesRef.current;
                    if (!series) return null;
                    const lineY = series.priceToCoordinate(entry.price);
                    if (
                      lineY === null ||
                      lineY === undefined ||
                      lineY < 10 ||
                      lineY > (containerRef.current?.clientHeight ?? 600) - 20
                    ) {
                      return null;
                    }

                    return (
                      <div
                        key={`badge_hit_${key}`}
                        onMouseDown={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          startDragManual(entry, e.clientY);
                        }}
                        style={{ top: lineY - 13 }}
                        className="absolute right-0 w-48 h-[26px] z-20 cursor-ns-resize bg-transparent hover:bg-primary/10 transition-colors select-none"
                        title="Haz clic y arrastra para ajustar el precio"
                      />
                    );
                  })}

                  {/* Selected-drawing floating toolbar / settings dialog */}
                  <DrawingOverlays
                    drawing={selectedDrawing}
                    showSettings={showDrawingSettings}
                    currentTf={timeframe}
                    onUpdate={(d) => onUpdateDrawing?.(d)}
                    onClone={handleCloneDrawing}
                    onRemove={() => selectedDrawing && onRemoveDrawing?.(selectedDrawing.id)}
                    onOpenSettings={() => setShowDrawingSettings(true)}
                    onCloseSettings={() => setShowDrawingSettings(false)}
                  />

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
                        onUpdateDrawing?.({ ...selectedDrawing, locked: !selectedDrawing.locked })
                      }
                      onToggleAlert={() =>
                        onUpdateDrawing?.({ ...selectedDrawing, alertEnabled: !selectedDrawing.alertEnabled })
                      }
                      onRemove={() => onRemoveDrawing?.(selectedDrawing.id)}
                    />
                  )}

                  {/* Object tree */}
                  <ObjectTreeOverlay
                    drawings={drawings}
                    selectedIds={selectedDrawingIds}
                    pipDigits={pipDigits}
                    currentTf={timeframe}
                    open={showObjectTree}
                    onToggle={() => setShowObjectTree((v) => !v)}
                    onSelect={handleObjectTreeSelect}
                    onUpdate={(d) => onUpdateDrawing?.(d)}
                    onRemove={(id) => onRemoveDrawing?.(id)}
                    onReorder={handleReorderDrawing}
                  />

                  {/* News overlay */}
                  <NewsOverlay
                    newsConfig={newsConfig}
                    setNewsConfig={setNewsConfig}
                    showNewsConfigDialog={showNewsConfigDialog}
                    setShowNewsConfigDialog={setShowNewsConfigDialog}
                    newsPopup={newsPopup}
                    setNewsPopup={setNewsPopup}
                    isDark={isDark}
                    pipDigits={pipDigits}
                    containerRef={containerRef}
                    upcomingEvents={upcomingEvents}
                    isReplayActive={isReplayActive}
                    currentSec={currentSec}
                    selectedSymbol={selectedSymbol}
                    timeframe={timeframe}
                    priceSyncActive={priceSyncActive}
                  />

                  {/* Chart container */}
                  <div ref={containerRef} className="w-full h-full relative" onContextMenu={handleChartContextMenu} />
                  <div
                    ref={syncHorzLineRef}
                    data-testid="chart-sync-horz-line"
                    className="pointer-events-none absolute left-0 right-0 top-0 z-20 hidden border-t border-dashed"
                    style={{ borderColor: colors.crosshair }}
                  />

                  {/* Top-Right Price Controls & ATR (14) Readout */}
                  <div
                    className="absolute z-30 pointer-events-auto flex items-center gap-2"
                    style={{ top: "8px", right: priceSyncActive ? "12px" : "104px" }}
                  >
                    {activeIndicators.includes("ATR") && currentAtr14 !== null && (
                      <div
                        className="flex items-center gap-1.5 bg-card/95 backdrop-blur-md border border-border/90 rounded-md px-2.5 py-1 shadow-md font-mono text-xs select-none"
                        title="Average True Range actual de 14 periodos"
                      >
                        <span className="text-muted-foreground font-semibold">ATR (14):</span>
                        <span className="text-[#ff7043] font-bold tabular-nums">
                          {currentAtr14.toFixed(pipDigits)}
                        </span>
                      </div>
                    )}
                    {smcTrend !== null && (
                      <div
                        className="flex items-center gap-1.5 bg-card/95 backdrop-blur-md border border-border/90 rounded-md px-2 py-1 shadow-md font-mono text-xs select-none"
                        title="Tendencia de Estructura de Mercado (SMC)"
                      >
                        <span className="text-muted-foreground font-semibold">SMC:</span>
                        <span
                          className={cn(
                            "font-bold",
                            smcTrend === "bullish"
                              ? "text-[#00E676]"
                              : smcTrend === "bearish"
                                ? "text-[#FF3B56]"
                                : "text-muted-foreground",
                          )}
                        >
                          {smcTrend === "bullish"
                            ? "Alcista"
                            : smcTrend === "bearish"
                              ? "Bajista"
                              : "Rango"}
                        </span>
                      </div>
                    )}
                    {vpvrPoc !== null && (
                      <div
                        className="flex items-center gap-1.5 bg-card/95 backdrop-blur-md border border-border/90 rounded-md px-2 py-1 shadow-md font-mono text-xs select-none"
                        title="Point of Control (Perfil de Volumen)"
                      >
                        <span className="text-muted-foreground font-semibold">POC:</span>
                        <span className="text-[#f59e0b] font-bold tabular-nums">
                          {vpvrPoc.toFixed(pipDigits)}
                        </span>
                      </div>
                    )}
                    <div className="flex items-center gap-1 bg-card/95 backdrop-blur-md border border-border/90 rounded-md px-1 py-0.5 shadow-md text-muted-foreground opacity-90 hover:opacity-100 transition-opacity">
                      <button
                        type="button"
                        disabled={index === 0}
                        onClick={() => moveBlock("PRICE", "up")}
                        title="Mover precio hacia arriba"
                        className="p-1 hover:text-foreground hover:bg-muted/80 rounded transition-colors disabled:opacity-30 disabled:pointer-events-none"
                      >
                        <ChevronUp className="w-3.5 h-3.5" />
                      </button>
                      <button
                        type="button"
                        disabled={index === allActiveBlocks.length - 1}
                        onClick={() => moveBlock("PRICE", "down")}
                        title="Mover precio hacia abajo"
                        className="p-1 hover:text-foreground hover:bg-muted/80 rounded transition-colors disabled:opacity-30 disabled:pointer-events-none"
                      >
                        <ChevronDown className="w-3.5 h-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => resizeBlock("PRICE", +5)}
                        title="Aumentar altura del precio"
                        className="p-1 hover:text-foreground hover:bg-muted/80 rounded transition-colors"
                      >
                        <Plus className="w-3.5 h-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => resizeBlock("PRICE", -5)}
                        title="Reducir altura del precio"
                        className="p-1 hover:text-foreground hover:bg-muted/80 rounded transition-colors"
                      >
                        <Minus className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>

                  {/* TradingView-style Floating Zoom Navigation Pill */}
                  <div
                    className="absolute bottom-2 left-12 z-30 flex items-center gap-1 bg-card/95 backdrop-blur-md border border-border shadow-md rounded-md p-0.5 text-muted-foreground select-none pointer-events-auto transition-opacity"
                    title="Controles de zoom del gráfico (Rueda del ratón, botones + / -, o teclas + / - / Ctrl+0)"
                  >
                    <button
                      type="button"
                      onClick={handleZoomIn}
                      title="Acercar gráfico (Zoom In / tecla +)"
                      className="p-1.5 hover:text-foreground hover:bg-muted rounded active:scale-95 transition-all"
                    >
                      <ZoomIn className="w-4 h-4" />
                    </button>
                    <button
                      type="button"
                      onClick={handleZoomOut}
                      title="Alejar gráfico (Zoom Out / tecla -)"
                      className="p-1.5 hover:text-foreground hover:bg-muted rounded active:scale-95 transition-all"
                    >
                      <ZoomOut className="w-4 h-4" />
                    </button>
                    <div className="w-[1px] h-3.5 bg-border/60 mx-0.5" />
                    <button
                      type="button"
                      onClick={handleToggleAutoScale}
                      title={
                        isManualScale
                          ? "Escala libre activa (puedes mover la gráfica arriba y abajo). Clic para volver a centrar (Auto)"
                          : "Escala automática activa. Clic para desbloquear y mover el gráfico arriba y abajo libremente (o arrastra el eje de precios)"
                      }
                      className={cn(
                        "px-1.5 py-1 text-[11px] font-semibold rounded active:scale-95 transition-all flex items-center gap-1",
                        isManualScale
                          ? "bg-amber-500/20 text-amber-400 border border-amber-500/30 hover:bg-amber-500/30 font-bold"
                          : "hover:text-foreground hover:bg-muted"
                      )}
                    >
                      <RotateCcw className="w-3 h-3" />
                      <span>{isManualScale ? "Manual" : "Auto"}</span>
                    </button>
                  </div>

                  {/* Left vertical tool rail */}
                  <DrawingToolRail
                    drawingTool={drawingTool}
                    onDrawingTool={(t) => onDrawingToolSelect?.(t)}
                    onZoomIn={handleZoomIn}
                    onZoomOut={handleZoomOut}
                  />
                </div>
              )}

              {blockId === "RSI" && (() => {
                return (
                  <ModularOscillatorBlock
                    type="RSI"
                    chartData={liveIndicatorData}
                    confirmedChartData={confirmedChartData}
                    timeframe={timeframe}
                    isDark={isDark}
                    colors={colors}
                    pipDigits={pipDigits}
                    heightPct={heightPct}
                    isLastBlock={isLast}
                    isMaximized={maximizedBlockId === "RSI"}
                    canMoveUp={index > 0}
                    canMoveDown={index < allActiveBlocks.length - 1}
                    onMoveUp={() => moveBlock("RSI", "up")}
                    onMoveDown={() => moveBlock("RSI", "down")}
                    onExpand={() => resizeBlock("RSI", +5)}
                    onShrink={() => resizeBlock("RSI", -5)}
                    onToggleMaximize={() => toggleMaximizeBlock("RSI")}
                    onClose={onToggleIndicator ? () => onToggleIndicator("RSI") : undefined}
                    onRegisterChart={handleRegisterOscillatorChart}
                    onRangeChange={handleOscillatorRangeChange}
                    getMainLogicalRange={getMainLogicalRange}
                    crosshairTime={sharedCrosshairTime}
                    onCrosshairMove={handleModularCrosshairMove}
                  />
                );
              })()}

              {blockId === "MACD" && (() => {
                return (
                  <ModularOscillatorBlock
                    type="MACD"
                    chartData={liveIndicatorData}
                    confirmedChartData={confirmedChartData}
                    timeframe={timeframe}
                    isDark={isDark}
                    colors={colors}
                    pipDigits={pipDigits}
                    heightPct={heightPct}
                    isLastBlock={isLast}
                    isMaximized={maximizedBlockId === "MACD"}
                    canMoveUp={index > 0}
                    canMoveDown={index < allActiveBlocks.length - 1}
                    onMoveUp={() => moveBlock("MACD", "up")}
                    onMoveDown={() => moveBlock("MACD", "down")}
                    onExpand={() => resizeBlock("MACD", +5)}
                    onShrink={() => resizeBlock("MACD", -5)}
                    onToggleMaximize={() => toggleMaximizeBlock("MACD")}
                    onClose={onToggleIndicator ? () => onToggleIndicator("MACD") : undefined}
                    onRegisterChart={handleRegisterOscillatorChart}
                    onRangeChange={handleOscillatorRangeChange}
                    getMainLogicalRange={getMainLogicalRange}
                    crosshairTime={sharedCrosshairTime}
                    onCrosshairMove={handleModularCrosshairMove}
                  />
                );
              })()}

              {blockId === "STOCH" && (() => {
                return (
                  <ModularOscillatorBlock
                    type="STOCH"
                    chartData={liveIndicatorData}
                    confirmedChartData={confirmedChartData}
                    timeframe={timeframe}
                    isDark={isDark}
                    colors={colors}
                    pipDigits={pipDigits}
                    heightPct={heightPct}
                    isLastBlock={isLast}
                    isMaximized={maximizedBlockId === "STOCH"}
                    canMoveUp={index > 0}
                    canMoveDown={index < allActiveBlocks.length - 1}
                    onMoveUp={() => moveBlock("STOCH", "up")}
                    onMoveDown={() => moveBlock("STOCH", "down")}
                    onExpand={() => resizeBlock("STOCH", +5)}
                    onShrink={() => resizeBlock("STOCH", -5)}
                    onToggleMaximize={() => toggleMaximizeBlock("STOCH")}
                    onClose={onToggleIndicator ? () => onToggleIndicator("STOCH") : undefined}
                    onRegisterChart={handleRegisterOscillatorChart}
                    onRangeChange={handleOscillatorRangeChange}
                    getMainLogicalRange={getMainLogicalRange}
                    crosshairTime={sharedCrosshairTime}
                    onCrosshairMove={handleModularCrosshairMove}
                  />
                );
              })()}
            </div>
          </Fragment>
        );
      })}

      {/* Chart-wide right-click menu */}
      {chartMenu && (
        <ChartContextMenu
          x={chartMenu.x}
          y={chartMenu.y}
          price={chartMenu.price}
          pipDigits={pipDigits}
          symbol={selectedSymbol}
          tick={effectiveTick}
          drawingsCount={visibleDrawings.length}
          indicatorsCount={activeIndicators.length + (chartPrefs.showVolume ? 1 : 0)}
          onClose={() => setChartMenu(null)}
          onResetView={handleResetView}
          onCopyPrice={handleCopyPrice}
          onAddAlert={handleAddAlert}
          onQuickOrder={onQuickOrder}
          onOpenObjectTree={() => setShowObjectTree(true)}
          onRemoveAllDrawings={onClearDrawings}
          onClearIndicators={onClearIndicators}
          onOpenSettings={() => setShowChartSettings(true)}
        />
      )}

      <ChartSettingsDialog
        open={showChartSettings}
        onClose={() => setShowChartSettings(false)}
        prefs={chartPrefs}
        isDark={isDark}
        activePlugins={activePlugins}
        onTogglePlugin={onTogglePlugin}
        onOpenNewsConfig={() => setShowNewsConfigDialog(true)}
        hasAccount={!!accountId}
      />

      {/* Synchronized Vertical Crosshair Guide Line Traversing All Modular Blocks */}
      {sharedCrosshairX !== null && sharedCrosshairX >= 0 && (
        <div
          className="absolute top-0 bottom-0 pointer-events-none z-30"
          style={{
            left: `${sharedCrosshairX}px`,
            width: "1px",
          }}
        >
          <svg className="w-full h-full overflow-visible" style={{ width: "1px" }}>
            <line
              x1="0.5"
              y1="0"
              x2="0.5"
              y2="100%"
              stroke={isDark ? "rgba(203, 213, 225, 0.55)" : "rgba(100, 116, 139, 0.55)"}
              strokeWidth="1"
              strokeDasharray="3 3"
            />
          </svg>
          {typeof sharedCrosshairTime === "number" && (
            <div className="absolute bottom-0.5 -translate-x-1/2 px-2 py-0.5 rounded bg-[#363a45] text-white font-mono text-[11px] font-semibold whitespace-nowrap shadow-md border border-white/10">
              {new Date(sharedCrosshairTime * 1000).toLocaleString("es-ES", {
                day: "2-digit",
                month: "short",
                year: "2-digit",
                ...(timeframe === "1d" || timeframe === "1w"
                  ? {}
                  : { hour: "2-digit", minute: "2-digit", hour12: false }),
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Local helper: Build chart data (candles + volume) ────────

type CandleRow = CandlestickData<Time> & { volume: number };

function secOrMsToMs(v: number): number {
  return v < 1_000_000_000_000 ? v * 1000 : v;
}

function candleTimeSec(c: Candle): number {
  let tMs = NaN;
  if (typeof c.time === "number" && c.time > 0) tMs = secOrMsToMs(c.time);
  else if (typeof c.timestamp === "number" && c.timestamp > 0) tMs = secOrMsToMs(c.timestamp);
  else if (typeof c.timestamp === "string") tMs = Date.parse(c.timestamp);
  return Number.isNaN(tMs) ? NaN : Math.floor(tMs / 1000);
}

function toCandleRow(c: Candle): CandleRow {
  return {
    time: candleTimeSec(c) as Time,
    open: Number(c.open),
    high: Number(c.high),
    low: Number(c.low),
    close: Number(c.close),
    volume: Number(c.volume) || 0,
  };
}

function dedupeByTime(sorted: CandleRow[]): CandleRow[] {
  const out: CandleRow[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const cur = sorted[i]!;
    const next = sorted[i + 1];
    if (!next || (cur.time as number) !== (next.time as number)) out.push(cur);
  }
  return out;
}

function useChartData(
  candles: Candle[],
  colors: { volumeUp: string; volumeDown: string },
  isReplaying = false,
  tfSec = 60,
  replaySimTimeSec = 0,
) {
  return useMemo(() => {
    const sorted = candles
      .map(toCandleRow)
      .filter(
        (c) =>
          !Number.isNaN(c.time as number) &&
          (c.time as number) > 0 &&
          Number.isFinite(c.open) &&
          c.open > 0 &&
          Number.isFinite(c.high) &&
          c.high > 0 &&
          Number.isFinite(c.low) &&
          c.low > 0 &&
          Number.isFinite(c.close) &&
          c.close > 0,
      )
      .sort((a, b) => (a.time as number) - (b.time as number));
    const deduped = dedupeByTime(sorted);

    const chartData: CandleRow[] = deduped;
    const volumeData: HistogramData<Time>[] = deduped.map((c) => ({
      time: c.time,
      value: c.volume,
      color: c.close >= c.open ? colors.volumeUp : colors.volumeDown,
    }));
    const volumeMaData: LineData<Time>[] =
      isReplaying && replaySimTimeSec > 0
        ? calculateReplayVolumeMa(volumeData, tfSec, replaySimTimeSec, 20)
        : calculateVolumeMa(volumeData, 20);

    return { chartData, volumeData, volumeMaData };
  }, [candles, colors.volumeUp, colors.volumeDown, isReplaying, tfSec, replaySimTimeSec]);
}
