import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useIsFeedConnected } from "../components/ConnectionIndicator.tsx";
import { MobileTradingPanel } from "../components/MobileTradingPanel.tsx";
import {
  OrderConfirmDialog,
  OrderModifyDialog,
  PositionModifyDialog,
} from "../components/TradingDialogs.tsx";
import { NewsFeed as MarketNewsFeed } from "../components/TradingPowerFeatures.tsx";
import { useChartDrawings } from "../hooks/useChartDrawings.ts";
import {
  getChartPreferencesFromStorage,
  updateChartPreferences,
  useChartPreferences,
} from "../hooks/useChartPreferences.ts";
import { useTradeSound } from "../hooks/useTradeSound";
import { INDICATOR_REGISTRY, type IndicatorType } from "../lib/indicators.ts";
import { computeRequiredWarmupBars, isValidTimeframe } from "../lib/timeframes.ts";
import { getIndicatorSettings } from "../hooks/useIndicatorSettings.ts";
import { computeLivePnl, computeLivePrice } from "../lib/livePnl.ts";
import { posthog } from "../lib/posthog";
import type { CreateJournalEntryInput, UpdateJournalEntryInput } from "../services/api/journal.ts";
import { api } from "../services/api.ts";
import { subscribeIbkrConfigChanged } from "../services/ibkrConfig.ts";
import { resetIbkrStreamConnection } from "../services/ibkrStream.ts";
import {
  ensureReplayHistoricalDataLoaded,
  hasAuthenticReplayData,
  invalidateAllStockSeries,
  invalidateStockSeries,
  TF_SECONDS,
} from "../services/demo/candles.ts";
import { subscribeEngine } from "../services/demo/engine.ts";
import { syncCursorPrice } from "../services/demo/feed.ts";
import { getDemoSymbol, registerDynamicSymbol } from "../services/demo/instruments.ts";
import {
  getReplaySliceForTimeframe,
  pickFinestTimeframe,
  type ReplayPhase,
  useReplayStore,
} from "../services/demo/replay.ts";
import type { Candle } from "../services/schemas.ts";
import type { ScreenerStock } from "../services/stockScreener.ts";
import { Zap } from "lucide-react";
import {
  queryKeys,
  useCandles,
  useOrders,
  usePositions,
  useSymbols,
} from "../services/queries.ts";
import type { ClosedPosition, Order, PlaceOrderInput, Position, Symbol } from "../services/schemas.ts";
import { useTradingStore } from "../services/store.tsx";
import { toast } from "../services/toast.ts";
import { AiTraderPanel } from "./AiTraderPage.tsx";
import { BottomPanel, type BottomTabKey } from "./trading/BottomPanel.tsx";
import { ChartPanel, type DraftOrderSlTpPreview } from "./trading/ChartPanel.tsx";
import type {
  MultiChartTemplateApplyPayload,
  MultiChartTemplateState,
} from "./trading/ChartTemplatesMenu.tsx";
import { ChartToolbar } from "./trading/ChartToolbar.tsx";
import {
  type DrawingTool,
  type MagnetMode,
  type Timeframe,
} from "./trading/constants.ts";
import { DOMPanel } from "./trading/DOMPanel.tsx";
import { FloatingOrderWidget } from "./trading/FloatingOrderWidget.tsx";
import { MarketClosedBanner } from "./trading/MarketClosedBanner.tsx";
import {
  type ChartLayout,
  MULTICHART_OVERLAY_INDICATORS,
  MultiChartPane,
} from "./trading/MultiChartPane.tsx";
import { PriceSyncController } from "./trading/priceSyncBus.ts";
import { StockScreenerTab } from "./trading/StockScreenerTab.tsx";
import { getPipDigits } from "./trading/utils.ts";
import { WatchlistPanel } from "./trading/WatchlistPanel.tsx";
import {
  captureContainerCanvases,
  captureDailyChart,
  captureFourHourChart,
  captureOneHourChart,
  saveScreenshotToDisk,
} from "../lib/chart-plugins/trade-screenshot.ts";

type ErrorWithMessage = { message?: string };

/**
 * Resolves the candle array displayed on the main chart.
 * When Replay is active (`phase === "active"`, or `phase === "picking"` with a replay slice loaded),
 * NEVER falls back to live/current candles even if `replayVisible` is temporarily null or empty.
 */
export function resolveMainChartCandles(params: {
  phase: ReplayPhase;
  replayVisible: Candle[] | null;
  replayTimeframe: string | null;
  replaySimTimeSec: number;
  selectedSymbol: string;
  timeframe: string;
  liveCandles: Candle[];
}): Candle[] {
  const {
    phase,
    replayVisible,
    replayTimeframe,
    replaySimTimeSec,
    selectedSymbol,
    timeframe,
    liveCandles,
  } = params;

  const replayActive =
    phase === "active" || (phase === "picking" && replayVisible != null);
  if (!replayActive) {
    return liveCandles;
  }

  if (replayTimeframe === timeframe && replayVisible != null) {
    return replayVisible;
  }
  if (!(replaySimTimeSec > 0)) {
    return [];
  }
  return getReplaySliceForTimeframe(selectedSymbol, timeframe, replaySimTimeSec);
}

type ConfirmOrderState = {
  symbol: string;
  side: "BUY" | "SELL";
  type: string;
  quantity: number;
  price?: number;
  stopPrice?: number;
  takeProfit?: number;
  stopLoss?: number;
  _submit: () => Promise<unknown>;
} | null;

const DEFAULT_INDICATORS: IndicatorType[] = ["EMA", "RSI", "MACD", "ATR"];
const ACTIVE_INDICATORS_STORAGE_KEY = "activeIndicators_v2";
const VALID_INDICATOR_TYPES = new Set<string>(INDICATOR_REGISTRY.map((i) => i.type));

export function loadSavedIndicators(): IndicatorType[] {
  try {
    const saved = localStorage.getItem(ACTIVE_INDICATORS_STORAGE_KEY);
    if (saved !== null) {
      const parsed: unknown = JSON.parse(saved);
      if (Array.isArray(parsed)) {
        const valid = parsed.filter(
          (item): item is IndicatorType =>
            typeof item === "string" && VALID_INDICATOR_TYPES.has(item),
        );
        return Array.from(new Set(valid));
      }
    }
  } catch {
    // ignore corrupted storage and fall back to defaults
  }
  return [...DEFAULT_INDICATORS];
}

export function saveActiveIndicators(next: IndicatorType[]): void {
  try {
    localStorage.setItem(ACTIVE_INDICATORS_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // ignore storage quota errors
  }
}

function getErrorMessage(err: unknown): string {
  if (err && typeof err === "object" && "message" in err) {
    const message = (err as ErrorWithMessage).message;
    if (typeof message === "string" && message.length > 0) return message;
  }
  return "Request failed";
}

export function TradingPage() {
  const hasTrackedFirstTrade = useRef(false);

  const handleFirstTrade = useCallback(() => {
    if (!hasTrackedFirstTrade.current) {
      hasTrackedFirstTrade.current = true;
      posthog.capture("funnel.trade.first_executed", { sessionId: posthog.get_session_id?.() });
    }
  }, []);

  const {
    selectedSymbol,
    setSelectedSymbol,
    ticks,
    updateTick,
    activeAccountId,
    symbols: _storeSymbols,
    replayVersion,
  } = useTradingStore();

  // Historical bar replay store
  const replay = useReplayStore();
  const isReplayActive =
    replay.phase === "active" || (replay.phase === "picking" && replay.visible != null);
  const isReplayPicking = replay.phase === "picking";

  // Chart timeframe persistence (#8)
  const [timeframe, setTimeframe] = useState<Timeframe>(() => {
    const saved = localStorage.getItem(`tf_${selectedSymbol}`);
    return saved && isValidTimeframe(saved) ? (saved as Timeframe) : "15m";
  });
  const chartLayoutRef = useRef<ChartLayout>("1");
  const handleTimeframeChange = useCallback(
    (tf: Timeframe) => {
      if (replay.phase === "active" && (chartLayoutRef.current === "1" || replay.isTemporary)) {
        const switched = replay.changeTimeframe(tf);
        if (!switched) {
          toast.warning(
            "Datos históricos insuficientes",
            `No existen velas históricas reales para ${tf} en esta fecha. Se conserva ${replay.timeframe ?? timeframe}.`,
          );
          return;
        }
      }
      setTimeframe(tf);
      localStorage.setItem(`tf_${selectedSymbol}`, tf);
    },
    [selectedSymbol, replay, timeframe],
  );

  // Capture 1H, 4H, and 1D screenshots offscreen alongside the on-screen chart
  const captureTimeframeScreenshots = useCallback(
    async (
      targetSymbol: string,
    ): Promise<{
      oneHourScreenshot?: string;
      fourHourScreenshot?: string;
      dailyScreenshot?: string;
      entryScreenshot?: string;
      entryTimeframe?: string;
    }> => {
      const container = document.getElementById("opencharts-main-chart-container");
      if (!container) return {};

      const isDarkTheme =
        document.documentElement.classList.contains("dark") ||
        !document.documentElement.classList.contains("light");

      const currentTf = timeframe;
      let entryScreenshot: string | undefined;
      let oneHourScreenshot: string | undefined;
      let fourHourScreenshot: string | undefined;
      let dailyScreenshot: string | undefined;

      // Detect if currently in historical replay mode
      const replay = useReplayStore.getState();
      const replayMaxTimeSec =
        replay.phase === "active" && replay.visible && replay.visible.length > 0
          ? Number(replay.visible[replay.visible.length - 1]!.time)
          : undefined;

      // 1. Capture current visible chart (has exact user indicators, price, and drawings)
      const currentBadge =
        currentTf === "1h"
          ? "1 HORA"
          : currentTf === "4h"
            ? "4 HORAS"
            : currentTf === "1d"
              ? "DIARIO"
              : "GATILLO DE ENTRADA";

      const currentDataUrl = captureContainerCanvases(
        container,
        `${targetSymbol} · ${currentTf.toUpperCase()} · ${currentBadge}`,
        isDarkTheme,
        false,
        replayMaxTimeSec,
      );
      if (currentDataUrl) {
        entryScreenshot = await saveScreenshotToDisk(
          currentDataUrl,
          targetSymbol,
          `entry_${currentTf}`,
        );
      }

      // 2. Always capture clean 1H, 4H, and Daily charts offscreen (pure candles, volume, RSI, MACD without TP/SL lines)
      try {
        const [h1Cap, fCap, dCap] = await Promise.all([
          captureOneHourChart(targetSymbol, isDarkTheme, replayMaxTimeSec),
          captureFourHourChart(targetSymbol, isDarkTheme, replayMaxTimeSec),
          captureDailyChart(targetSymbol, isDarkTheme, replayMaxTimeSec),
        ]);
        if (h1Cap) oneHourScreenshot = h1Cap;
        if (fCap) fourHourScreenshot = fCap;
        if (dCap) dailyScreenshot = dCap;
      } catch (err) {
        console.warn("[screenshot] Error capturing offscreen timeframe chart:", err);
      }

      // Fallback in case any offscreen capture was missed
      if (!oneHourScreenshot) {
        try {
          oneHourScreenshot = await captureOneHourChart(targetSymbol, isDarkTheme, replayMaxTimeSec);
        } catch {
          /* fallback */
        }
      }
      if (!fourHourScreenshot) {
        try {
          fourHourScreenshot = await captureFourHourChart(targetSymbol, isDarkTheme, replayMaxTimeSec);
        } catch {
          /* fallback */
        }
      }
      if (!dailyScreenshot) {
        try {
          dailyScreenshot = await captureDailyChart(targetSymbol, isDarkTheme, replayMaxTimeSec);
        } catch {
          /* fallback */
        }
      }

      // 3. Absolute sanity guard: 4H and Daily MUST NEVER be identical images
      if (fourHourScreenshot && dailyScreenshot && fourHourScreenshot === dailyScreenshot) {
        if (currentTf === "1d") {
          fourHourScreenshot = await captureFourHourChart(targetSymbol, isDarkTheme, replayMaxTimeSec);
        } else {
          dailyScreenshot = await captureDailyChart(targetSymbol, isDarkTheme, replayMaxTimeSec);
        }
      }

      return {
        oneHourScreenshot,
        fourHourScreenshot,
        dailyScreenshot,
        entryScreenshot,
        entryTimeframe: currentTf,
      };
    },
    [timeframe, selectedSymbol],
  );

  useEffect(() => {
    if (typeof window !== "undefined") {
      (window as unknown as { __opencharts_capture_screenshots?: typeof captureTimeframeScreenshots }).__opencharts_capture_screenshots =
        captureTimeframeScreenshots;
    }
    return () => {
      if (typeof window !== "undefined") {
        delete (window as unknown as { __opencharts_capture_screenshots?: typeof captureTimeframeScreenshots }).__opencharts_capture_screenshots;
      }
    };
  }, [captureTimeframeScreenshots]);

  // Restore timeframe when symbol changes & stop replay if symbol switched
  useEffect(() => {
    const r = useReplayStore.getState();
    if (r.phase !== "idle" && r.symbol !== selectedSymbol) {
      r.stop();
    }
    if (
      r.phase === "active" &&
      r.symbol === selectedSymbol &&
      r.timeframe &&
      isValidTimeframe(r.timeframe) &&
      localStorage.getItem("oc_chart_layout") !== "2x1" &&
      localStorage.getItem("oc_chart_layout") !== "2x2"
    ) {
      setTimeframe(r.timeframe as Timeframe);
      return;
    }
    const saved = localStorage.getItem(`tf_${selectedSymbol}`);
    if (saved && isValidTimeframe(saved)) setTimeframe(saved as Timeframe);
  }, [selectedSymbol]);

  const [activeIndicators, setActiveIndicators] = useState<IndicatorType[]>(loadSavedIndicators);
  const handleUpdateIndicators = useCallback(
    (updater: IndicatorType[] | ((prev: IndicatorType[]) => IndicatorType[])) => {
      setActiveIndicators((prev) => {
        const next = typeof updater === "function" ? updater(prev) : updater;
        saveActiveIndicators(next);
        return next;
      });
    },
    [],
  );

  const [showIndicatorMenu, setShowIndicatorMenu] = useState(false);
  const [chartLayout, setChartLayout] = useState<ChartLayout>(() => {
    try {
      const v = localStorage.getItem("oc_chart_layout");
      return v === "2x1" || v === "2x2" ? v : "1";
    } catch {
      return "1";
    }
  });
  chartLayoutRef.current = chartLayout;
  const [focusedPaneSlot, setFocusedPaneSlot] = useState<0 | 1 | 2 | 3>(0);
  const [expandedPaneSlot, setExpandedPaneSlot] = useState<0 | 1 | 2 | 3 | null>(null);
  const handleToggleExpandPane = useCallback((slot: 0 | 1 | 2 | 3) => {
    setExpandedPaneSlot((cur) => (cur === slot ? null : slot));
    setFocusedPaneSlot(slot);
  }, []);
  const [paneTimeframes, setPaneTimeframes] = useState<Record<1 | 2 | 3, Timeframe>>(() => {
    const readTf = (slot: 1 | 2 | 3, fallback: Timeframe): Timeframe => {
      try {
        const saved = localStorage.getItem(`oc_multichart_tf_${slot}`) as Timeframe | null;
        return saved && isValidTimeframe(saved) ? saved : fallback;
      } catch {
        return fallback;
      }
    };
    return {
      1: readTf(1, timeframe === "1m" ? "5m" : "1m"),
      2: readTf(2, "15m"),
      3: readTf(3, "1h"),
    };
  });
  const [paneIndicators, setPaneIndicators] = useState<Record<1 | 2 | 3, IndicatorType[]>>(() => {
    const allowed = new Set(MULTICHART_OVERLAY_INDICATORS.map((o) => o.type));
    const fallbackFromMain = loadSavedIndicators().filter((t) => allowed.has(t));
    const readInd = (slot: 1 | 2 | 3): IndicatorType[] => {
      try {
        const raw = localStorage.getItem(`oc_multichart_ind_${slot}`);
        if (!raw) return fallbackFromMain.length > 0 ? fallbackFromMain : ["EMA", "VWAP"];
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return ["EMA", "VWAP"];
        return parsed.filter(
          (t): t is IndicatorType => typeof t === "string" && allowed.has(t as IndicatorType),
        );
      } catch {
        return ["EMA", "VWAP"];
      }
    };
    return {
      1: readInd(1),
      2: readInd(2),
      3: readInd(3),
    };
  });

  const handleSetPaneTimeframe = useCallback((slot: 1 | 2 | 3, tf: Timeframe) => {
    setPaneTimeframes((prev) => ({ ...prev, [slot]: tf }));
    try {
      localStorage.setItem(`oc_multichart_tf_${slot}`, tf);
    } catch {
      /* ignore */
    }
  }, []);

  const handleTogglePaneIndicator = useCallback((slot: 1 | 2 | 3, ind: IndicatorType) => {
    const allowed = new Set(MULTICHART_OVERLAY_INDICATORS.map((o) => o.type));
    if (!allowed.has(ind)) return;
    setPaneIndicators((prev) => {
      const cur = prev[slot];
      const nextList = cur.includes(ind) ? cur.filter((x) => x !== ind) : [...cur, ind];
      try {
        localStorage.setItem(`oc_multichart_ind_${slot}`, JSON.stringify(nextList));
      } catch {
        /* ignore */
      }
      return { ...prev, [slot]: nextList };
    });
  }, []);

  const handleSetPaneIndicators = useCallback((slot: 1 | 2 | 3, next: IndicatorType[]) => {
    const allowed = new Set(MULTICHART_OVERLAY_INDICATORS.map((o) => o.type));
    const filtered = Array.from(new Set(next.filter((ind) => allowed.has(ind))));
    setPaneIndicators((prev) => ({ ...prev, [slot]: filtered }));
    try {
      localStorage.setItem(`oc_multichart_ind_${slot}`, JSON.stringify(filtered));
    } catch {
      /* ignore */
    }
  }, []);

  const handleChartLayoutChange = useCallback((next: ChartLayout) => {
    setChartLayout(next);
    setExpandedPaneSlot(null);
    setFocusedPaneSlot((cur) => {
      if (next === "1") return 0;
      if (next === "2x1" && cur > 1) return 0;
      return cur;
    });
    try {
      localStorage.setItem("oc_chart_layout", next);
    } catch {
      /* ignore */
    }
  }, []);

  const priceSyncController = useMemo(() => new PriceSyncController(), []);
  const [slot1Symbol, setSlot1Symbol] = useState<string>(selectedSymbol);
  const [slot2Symbol, setSlot2Symbol] = useState<string>(selectedSymbol);
  const [slot3Symbol, setSlot3Symbol] = useState<string>(selectedSymbol);

  const replayAdditionalTimeframes = useMemo<Timeframe[]>(() => {
    const tfs: Timeframe[] = [timeframe];
    if (chartLayout === "2x1" || chartLayout === "2x2") {
      if (slot1Symbol === selectedSymbol) tfs.push(paneTimeframes[1]);
    }
    if (chartLayout === "2x2") {
      if (slot2Symbol === selectedSymbol) tfs.push(paneTimeframes[2]);
      if (slot3Symbol === selectedSymbol) tfs.push(paneTimeframes[3]);
    }
    return Array.from(new Set(tfs));
  }, [
    timeframe,
    chartLayout,
    selectedSymbol,
    slot1Symbol,
    slot2Symbol,
    slot3Symbol,
    paneTimeframes,
  ]);

  const replaySecondarySymbols = useMemo(() => {
    const out: Array<{ symbol: string; timeframe: string }> = [];
    if (chartLayout === "2x1" || chartLayout === "2x2") {
      if (slot1Symbol && slot1Symbol !== selectedSymbol) {
        out.push({ symbol: slot1Symbol, timeframe: paneTimeframes[1] });
      }
    }
    if (chartLayout === "2x2") {
      if (slot2Symbol && slot2Symbol !== selectedSymbol) {
        out.push({ symbol: slot2Symbol, timeframe: paneTimeframes[2] });
      }
      if (slot3Symbol && slot3Symbol !== selectedSymbol) {
        out.push({ symbol: slot3Symbol, timeframe: paneTimeframes[3] });
      }
    }
    return out;
  }, [chartLayout, selectedSymbol, slot1Symbol, slot2Symbol, slot3Symbol, paneTimeframes]);

  const activeReplayStepTimeframe = useMemo<Timeframe>(() => {
    if (replay.phase === "active" && replay.symbol === selectedSymbol && replay.simTimeSec > 0) {
      const authenticCandidates = replayAdditionalTimeframes.filter((tf) =>
        hasAuthenticReplayData(selectedSymbol, tf, replay.simTimeSec - 1),
      );
      if (authenticCandidates.length > 0) {
        return pickFinestTimeframe(authenticCandidates) as Timeframe;
      }
      if (replay.timeframe) {
        return replay.timeframe as Timeframe;
      }
    }
    return pickFinestTimeframe(replayAdditionalTimeframes) as Timeframe;
  }, [
    replayAdditionalTimeframes,
    replay.phase,
    replay.symbol,
    replay.simTimeSec,
    replay.timeframe,
    selectedSymbol,
  ]);

  useEffect(() => {
    const r = useReplayStore.getState();
    if (
      r.phase === "active" &&
      !r.isTemporary &&
      r.symbol === selectedSymbol &&
      r.timeframe !== activeReplayStepTimeframe
    ) {
      r.changeTimeframe(activeReplayStepTimeframe);
    }
  }, [
    activeReplayStepTimeframe,
    selectedSymbol,
    replay.phase,
    replay.isTemporary,
    replay.symbol,
    replay.timeframe,
  ]);
  const [paneShowVolume, setPaneShowVolume] = useState<Record<1 | 2 | 3, boolean | null>>(() => {
    const readVol = (slot: 1 | 2 | 3): boolean | null => {
      try {
        const raw = localStorage.getItem(`oc_multichart_vol_${slot}`);
        if (raw === "true") return true;
        if (raw === "false") return false;
      } catch {
        /* ignore */
      }
      return null;
    };
    return { 1: readVol(1), 2: readVol(2), 3: readVol(3) };
  });

  const handleTogglePaneVolume = useCallback((slot: 1 | 2 | 3) => {
    setPaneShowVolume((prev) => {
      const current = prev[slot] ?? getChartPreferencesFromStorage().showVolume;
      const nextVal = !current;
      try {
        localStorage.setItem(`oc_multichart_vol_${slot}`, String(nextVal));
      } catch {
        /* ignore */
      }
      return { ...prev, [slot]: nextVal };
    });
  }, []);

  const [syncPrice2x1, setSyncPrice2x1] = useState<boolean>(() => {
    try {
      return localStorage.getItem("oc_sync_price_2x1") === "true";
    } catch {
      return false;
    }
  });

  const handleToggleSyncPrice2x1 = useCallback(() => {
    setSyncPrice2x1((prev) => {
      const next = !prev;
      try {
        localStorage.setItem("oc_sync_price_2x1", String(next));
      } catch {
        /* ignore */
      }
      return next;
    });
  }, []);

  const canSyncPrice2x1 = chartLayout === "2x1" && slot1Symbol === selectedSymbol;
  const effectivePriceSync = canSyncPrice2x1 && syncPrice2x1 && expandedPaneSlot === null;

  const multiChartTemplateState = useMemo<MultiChartTemplateState>(
    () => ({
      chartLayout,
      mainTimeframe: timeframe,
      mainIndicators: activeIndicators,
      syncPrice2x1,
      paneTimeframes,
      paneIndicators,
      paneShowVolume,
    }),
    [
      chartLayout,
      timeframe,
      activeIndicators,
      syncPrice2x1,
      paneTimeframes,
      paneIndicators,
      paneShowVolume,
    ],
  );

  const handleApplyMultiChartTemplate = useCallback(
    (payload: MultiChartTemplateApplyPayload) => {
      handleUpdateIndicators(payload.mainIndicators);
      if (payload.mainTimeframe && isValidTimeframe(payload.mainTimeframe)) {
        handleTimeframeChange(payload.mainTimeframe);
      }
      if (typeof payload.syncPrice2x1 === "boolean") {
        setSyncPrice2x1(payload.syncPrice2x1);
        try {
          localStorage.setItem("oc_sync_price_2x1", String(payload.syncPrice2x1));
        } catch {
          /* ignore */
        }
      }
      if (
        payload.chartLayout === "1" ||
        payload.chartLayout === "2x1" ||
        payload.chartLayout === "2x2"
      ) {
        handleChartLayoutChange(payload.chartLayout);
      }
      if (payload.panes) {
        const slots: Array<1 | 2 | 3> = [1, 2, 3];
        for (const slot of slots) {
          const snap = payload.panes[String(slot)];
          if (!snap) continue;
          if (snap.timeframe && isValidTimeframe(snap.timeframe)) {
            handleSetPaneTimeframe(slot, snap.timeframe as Timeframe);
          }
          if (Array.isArray(snap.indicators)) {
            handleSetPaneIndicators(slot, snap.indicators as IndicatorType[]);
          }
          if (snap.showVolume !== undefined) {
            const volVal = typeof snap.showVolume === "boolean" ? snap.showVolume : null;
            setPaneShowVolume((prev) => ({ ...prev, [slot]: volVal }));
            try {
              if (volVal === null) {
                localStorage.removeItem(`oc_multichart_vol_${slot}`);
              } else {
                localStorage.setItem(`oc_multichart_vol_${slot}`, String(volVal));
              }
            } catch {
              /* ignore */
            }
          }
        }
      }
    },
    [
      handleUpdateIndicators,
      handleTimeframeChange,
      handleChartLayoutChange,
      handleSetPaneTimeframe,
      handleSetPaneIndicators,
    ],
  );

  const handlePromotePaneToMain = useCallback(
    (sym: string, tf: Timeframe) => {
      try {
        localStorage.setItem(`tf_${sym}`, tf);
      } catch {
        /* ignore */
      }
      if (sym !== selectedSymbol) {
        setSelectedSymbol(sym);
      }
      handleTimeframeChange(tf);
    },
    [selectedSymbol, setSelectedSymbol, handleTimeframeChange],
  );

  const [drawingTool, setDrawingTool] = useState<DrawingTool>("none");
  const {
    drawings,
    addDrawing: rawAddDrawing,
    updateDrawing: rawUpdateDrawing,
    removeDrawing: rawRemoveDrawing,
    clearDrawings: rawClearDrawings,
    undo: undoDrawing,
    redo: redoDrawing,
  } = useChartDrawings(selectedSymbol, timeframe, 0);

  // Unified Undo / Redo history across drawings, SL/TP drags, and Replay steps
  type UndoEntry =
    | { kind: "drawing" }
    | {
        kind: "draft-sltp";
        before: { takeProfit?: number | null; stopLoss?: number | null };
        after: { takeProfit?: number | null; stopLoss?: number | null };
      }
    | {
        kind: "position-sltp";
        positionId: string;
        before: { takeProfit?: number | null; stopLoss?: number | null };
        after: { takeProfit?: number | null; stopLoss?: number | null };
      };
  const actionUndoRef = useRef<UndoEntry[]>([]);
  const actionRedoRef = useRef<UndoEntry[]>([]);

  useEffect(() => {
    actionUndoRef.current = [];
    actionRedoRef.current = [];
  }, [selectedSymbol]);

  const addDrawing = useCallback(
    (d: Parameters<typeof rawAddDrawing>[0]) => {
      actionUndoRef.current.push({ kind: "drawing" });
      actionRedoRef.current = [];
      rawAddDrawing(d);
    },
    [rawAddDrawing],
  );
  const updateDrawing = useCallback(
    (d: Parameters<typeof rawUpdateDrawing>[0]) => {
      actionUndoRef.current.push({ kind: "drawing" });
      actionRedoRef.current = [];
      rawUpdateDrawing(d);
    },
    [rawUpdateDrawing],
  );
  const removeDrawing = useCallback(
    (id: string) => {
      actionUndoRef.current.push({ kind: "drawing" });
      actionRedoRef.current = [];
      rawRemoveDrawing(id);
    },
    [rawRemoveDrawing],
  );
  const clearDrawings = useCallback(() => {
    actionUndoRef.current.push({ kind: "drawing" });
    actionRedoRef.current = [];
    rawClearDrawings();
  }, [rawClearDrawings]);

  const [activePlugins, setActivePlugins] = useState<string[]>(
    () => getChartPreferencesFromStorage().activePlugins,
  );
  const handleTogglePlugin = useCallback((id: string) => {
    setActivePlugins((prev) => {
      const next = prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id];
      updateChartPreferences({ activePlugins: next });
      return next;
    });
  }, []);
  const handleSetPlugins = useCallback((ids: string[]) => {
    setActivePlugins(ids);
    updateChartPreferences({ activePlugins: ids });
  }, []);
  const [bottomTab, setBottomTab] = useState<BottomTabKey>("positions");
  const [rightPanel, setRightPanel] = useState<
    "order" | "dom" | "watchlist" | "news" | "ai-trader"
  >("watchlist");
  const [showRightPanel, setShowRightPanel] = useState(false);

  const handleSelectRightPanel = useCallback(
    (p: "order" | "dom" | "watchlist" | "news" | "ai-trader" | "tv-analysis") => {
      if (p === "order") {
        setFloatingOrderOpen((v) => !v);
        return;
      }
      if (p === "tv-analysis") return;
      setRightPanel(p);
      setShowRightPanel(true);
    },
    [],
  );

  // Draft SL/TP preview state synced between OrderPanel and ChartPanel
  const [draftOrderPreview, setDraftOrderPreview] = useState<DraftOrderSlTpPreview | null>(null);
  const draftOrderPreviewRef = useRef<DraftOrderSlTpPreview | null>(null);
  draftOrderPreviewRef.current = draftOrderPreview;
  const [externalDraftSlTp, setExternalDraftSlTp] = useState<{
    takeProfit?: number | null;
    stopLoss?: number | null;
    seq: number;
  } | null>(null);

  const applyDraftSlTpDirect = useCallback(
    (mods: { takeProfit?: number | null; stopLoss?: number | null }) => {
      setExternalDraftSlTp((prev) => ({
        ...mods,
        seq: (prev?.seq ?? 0) + 1,
      }));
      setDraftOrderPreview((prev) => {
        if (!prev) return null;
        return {
          ...prev,
          ...(mods.takeProfit !== undefined ? { takeProfit: mods.takeProfit } : {}),
          ...(mods.stopLoss !== undefined ? { stopLoss: mods.stopLoss } : {}),
        };
      });
    },
    [],
  );

  const handleModifyDraftSlTp = useCallback(
    (mods: { takeProfit?: number | null; stopLoss?: number | null }) => {
      const cur = draftOrderPreviewRef.current;
      if (cur) {
        const before: { takeProfit?: number | null; stopLoss?: number | null } = {};
        if (mods.takeProfit !== undefined) before.takeProfit = cur.takeProfit;
        if (mods.stopLoss !== undefined) before.stopLoss = cur.stopLoss;
        actionUndoRef.current.push({
          kind: "draft-sltp",
          before,
          after: mods,
        });
        actionRedoRef.current = [];
      }
      applyDraftSlTpDirect(mods);
    },
    [applyDraftSlTpDirect],
  );

  // ── Vertical resize: chart vs bottom panel ──
  const [bottomPanelHeight, setBottomPanelHeight] = useState(() => {
    try {
      const saved = localStorage.getItem("bottomPanelHeight");
      const n = saved ? parseInt(saved, 10) : NaN;
      return Number.isFinite(n) && n >= 100 && n <= 600 ? n : 220;
    } catch {
      return 220;
    }
  });
  const resizingRef = useRef(false);
  const resizeStartY = useRef(0);
  const resizeStartH = useRef(0);
  const resizeCleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    return () => {
      resizeCleanupRef.current?.();
      resizeCleanupRef.current = null;
    };
  }, []);

  const handleResizeStart = useCallback(
    (e: React.MouseEvent | React.TouchEvent) => {
      const startY = "touches" in e ? e.touches[0]?.clientY : e.clientY;
      if (startY == null) return;
      e.preventDefault();
      resizeCleanupRef.current?.();
      resizingRef.current = true;
      resizeStartY.current = startY;
      resizeStartH.current = bottomPanelHeight;

      const onMove = (ev: MouseEvent | TouchEvent) => {
        if (!resizingRef.current) return;
        const y = "touches" in ev ? ev.touches[0]?.clientY : (ev as MouseEvent).clientY;
        if (y == null) return;
        const delta = resizeStartY.current - y;
        const newH = Math.max(100, Math.min(600, resizeStartH.current + delta));
        setBottomPanelHeight(newH);
      };
      const onUp = () => {
        resizingRef.current = false;
        setBottomPanelHeight((h) => {
          try {
            localStorage.setItem("bottomPanelHeight", String(h));
          } catch {
            // ignore
          }
          return h;
        });
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        window.removeEventListener("touchmove", onMove);
        window.removeEventListener("touchend", onUp);
        window.removeEventListener("touchcancel", onUp);
        if (resizeCleanupRef.current === onUp) resizeCleanupRef.current = null;
      };
      resizeCleanupRef.current = onUp;
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
      window.addEventListener("touchmove", onMove, { passive: false });
      window.addEventListener("touchend", onUp);
      window.addEventListener("touchcancel", onUp);
    },
    [bottomPanelHeight],
  );

  // Collapsible bottom panel state
  const [bottomPanelCollapsed, setBottomPanelCollapsed] = useState(() => {
    return localStorage.getItem("bottomPanelCollapsed") === "true";
  });
  const handleToggleBottomPanelCollapse = useCallback(() => {
    setBottomPanelCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem("bottomPanelCollapsed", String(next));
      } catch {
        // ignore
      }
      return next;
    });
  }, []);

  // Floating order panel state (active when expanded / showRightPanel is false)
  const [floatingOrderOpen, setFloatingOrderOpen] = useState(true);

  // (#4) One-click trading mode
  const [oneClick, setOneClick] = useState(
    () => localStorage.getItem("oneClickTrading") === "true",
  );

  // Trade sound effect
  const { playTradeSound } = useTradeSound();
  const toggleOneClick = useCallback(() => {
    setOneClick((prev) => {
      const v = !prev;
      localStorage.setItem("oneClickTrading", String(v));
      return v;
    });
  }, []);

  // (#6) Position modify dialog
  const [modifyingPosition, setModifyingPosition] = useState<Position | null>(null);

  // (#30) Order modify dialog
  const [modifyingOrder, setModifyingOrder] = useState<Order | null>(null);

  // (#7) Order confirmation dialog
  const [confirmOrder, setConfirmOrder] = useState<ConfirmOrderState>(null);
  const [confirmLoading, setConfirmLoading] = useState(false);

  const queryClient = useQueryClient();
  const { data: symbols = [] } = useSymbols();
  const isFeedConnected = useIsFeedConnected();

  // Keep React Query caches synced with demo engine changes (SL/TP hits, replay fills, resets)
  useEffect(() => {
    return subscribeEngine(() => {
      if (activeAccountId) {
        queryClient.invalidateQueries({ queryKey: ["positions", activeAccountId] });
        queryClient.invalidateQueries({ queryKey: ["orders", activeAccountId] });
        queryClient.invalidateQueries({ queryKey: ["closedPositions", activeAccountId] });
        queryClient.invalidateQueries({ queryKey: ["fills", activeAccountId] });
      }
      queryClient.invalidateQueries({ queryKey: ["positions"] });
      queryClient.invalidateQueries({ queryKey: ["orders"] });
      queryClient.invalidateQueries({ queryKey: ["closedPositions"] });
      void useTradingStore.getState().loadAccounts();
    });
  }, [activeAccountId, queryClient]);

  // Prime the active symbol with a fresh server-side snapshot immediately on
  // symbol switch so bid/ask appears without waiting for the next WS tick.
  useEffect(() => {
    if (isReplayActive) return;
    let cancelled = false;
    void api
      .getTick(selectedSymbol)
      .then((tick) => {
        if (cancelled || !tick || useReplayStore.getState().phase !== "idle") return;
        updateTick(
          selectedSymbol,
          Number(tick.bid),
          Number(tick.ask),
          typeof tick.timestamp === "number" ? tick.timestamp : Date.now(),
        );
      })
      .catch(() => {
        // Ignore snapshot misses; WS stream remains authoritative.
      });
    return () => {
      cancelled = true;
    };
  }, [selectedSymbol, updateTick, isReplayActive]);

  // Pacing-safe prefetch of the active symbol + timeframe (avoids bursting multiple concurrent historical queries)
  useEffect(() => {
    if (isReplayActive) return;
    void queryClient.prefetchQuery({
      queryKey: [...queryKeys.market.candles(selectedSymbol, timeframe), "auto", 0],
      queryFn: () => api.getCandlesWithMeta(selectedSymbol, timeframe),
      staleTime: 30_000,
    });
  }, [selectedSymbol, timeframe, queryClient, isReplayActive]);

  // Reload open stock charts immediately when IBKR connection settings are saved or reset
  useEffect(() => {
    return subscribeIbkrConfigChanged(() => {
      invalidateAllStockSeries();
      resetIbkrStreamConnection();
      void queryClient.invalidateQueries({ queryKey: ["candles"] });
    });
  }, [queryClient]);

  // Handler for chart drag-to-edit SL/TP levels
  const applyPositionSlTpDirect = useCallback(
    async (positionId: string, mods: { takeProfit?: number | null; stopLoss?: number | null }) => {
      if (!isFeedConnected) {
        toast.warning(
          "No Data Feed",
          "Cannot modify positions while disconnected from the data feed",
        );
        if (activeAccountId)
          queryClient.invalidateQueries({
            queryKey: ["positions", activeAccountId],
          });
        return;
      }
      try {
        await api.modifyPosition(positionId, mods);
        const field = mods.takeProfit !== undefined ? "TP" : "SL";
        const price = mods.takeProfit !== undefined ? mods.takeProfit : mods.stopLoss;
        toast.success(
          `${field} Updated`,
          price !== null ? `${field} set to ${price}` : `${field} removed`,
        );
        if (activeAccountId) {
          queryClient.invalidateQueries({
            queryKey: ["positions", activeAccountId],
          });
        }
      } catch (err: unknown) {
        toast.error("Modify Failed", getErrorMessage(err));
        if (activeAccountId) {
          queryClient.invalidateQueries({
            queryKey: ["positions", activeAccountId],
          });
        }
        throw err;
      }
    },
    [activeAccountId, queryClient, isFeedConnected],
  );

  const positionsRef = useRef<Position[]>([]);
  const handleChartModifyPosition = useCallback(
    async (positionId: string, mods: { takeProfit?: number | null; stopLoss?: number | null }) => {
      const existing = positionsRef.current.find((p) => p.id === positionId);
      const before: { takeProfit?: number | null; stopLoss?: number | null } | null = existing
        ? {
            ...(mods.takeProfit !== undefined ? { takeProfit: existing.takeProfit ?? null } : {}),
            ...(mods.stopLoss !== undefined ? { stopLoss: existing.stopLoss ?? null } : {}),
          }
        : null;
      await applyPositionSlTpDirect(positionId, mods);
      if (isFeedConnected && before) {
        actionUndoRef.current.push({
          kind: "position-sltp",
          positionId,
          before,
          after: mods,
        });
        actionRedoRef.current = [];
      }
    },
    [applyPositionSlTpDirect, isFeedConnected],
  );

  const handleUnifiedUndo = useCallback(() => {
    while (actionUndoRef.current.length > 0) {
      const op = actionUndoRef.current.pop()!;
      if (op.kind === "drawing") {
        if (undoDrawing()) {
          actionRedoRef.current.push(op);
          return;
        }
      } else if (op.kind === "draft-sltp") {
        applyDraftSlTpDirect(op.before);
        actionRedoRef.current.push(op);
        return;
      } else if (op.kind === "position-sltp") {
        void applyPositionSlTpDirect(op.positionId, op.before);
        actionRedoRef.current.push(op);
        return;
      }
    }
    // Fallback: try drawing undo directly or Replay stepBack if in active replay
    if (undoDrawing()) return;
    const r = useReplayStore.getState();
    if (r.phase === "active" && r.cursor > 0) {
      r.stepBack();
    }
  }, [undoDrawing, applyDraftSlTpDirect, applyPositionSlTpDirect]);

  const handleUnifiedRedo = useCallback(() => {
    while (actionRedoRef.current.length > 0) {
      const op = actionRedoRef.current.pop()!;
      if (op.kind === "drawing") {
        if (redoDrawing()) {
          actionUndoRef.current.push(op);
          return;
        }
      } else if (op.kind === "draft-sltp") {
        applyDraftSlTpDirect(op.after);
        actionUndoRef.current.push(op);
        return;
      } else if (op.kind === "position-sltp") {
        void applyPositionSlTpDirect(op.positionId, op.after);
        actionUndoRef.current.push(op);
        return;
      }
    }
    redoDrawing();
  }, [redoDrawing, applyDraftSlTpDirect, applyPositionSlTpDirect]);

  // Handler for closing a position directly from the Chart Position Controls bar
  const handleChartClosePosition = useCallback(
    async (positionId: string) => {
      if (!activeAccountId) return;
      try {
        await api.closePosition(positionId);
        toast.success("Position Closed", "Position has been closed from chart");
        queryClient.invalidateQueries({ queryKey: ["positions", activeAccountId] });
        queryClient.invalidateQueries({ queryKey: ["closedPositions", activeAccountId] });
        queryClient.invalidateQueries({ queryKey: ["fills", activeAccountId] });
      } catch (err: unknown) {
        toast.error("Close Failed", getErrorMessage(err));
      }
    },
    [activeAccountId, queryClient],
  );

  // Chart context-menu quick orders (Buy/Sell limit/stop at the clicked price).
  const handleQuickOrder = useCallback(
    (side: "BUY" | "SELL", type: "LIMIT" | "STOP", price: number) => {
      if (!activeAccountId) {
        toast.warning("No Account", "Select an account before placing orders");
        return;
      }
      const upper = selectedSymbol.toUpperCase();
      const defaultUnitQty = upper.startsWith("BTC")
        ? 0.005
        : upper.startsWith("ETH")
          ? 0.05
          : 0.1;
      const input: PlaceOrderInput = {
        accountId: activeAccountId,
        symbol: selectedSymbol,
        side,
        type,
        quantity: defaultUnitQty,
        ...(type === "LIMIT" ? { price } : { stopPrice: price }),
      };
      setConfirmOrder({
        symbol: selectedSymbol,
        side,
        type,
        quantity: defaultUnitQty,
        price: type === "LIMIT" ? price : undefined,
        stopPrice: type === "STOP" ? price : undefined,
        _submit: () => api.placeOrder(input),
      });
    },
    [activeAccountId, selectedSymbol],
  );

  const handleClearIndicators = useCallback(() => {
    handleUpdateIndicators([]);
  }, [handleUpdateIndicators]);

  const handlePickReplayBar = useCallback(
    (timeSec: number, sourceTf?: Timeframe) => {
      const clickedTf = sourceTf ?? timeframe;
      const candidateStepTf = activeReplayStepTimeframe;
      const clickedSec = TF_SECONDS[clickedTf] ?? 60;
      const candidateStepSec = TF_SECONDS[candidateStepTf] ?? 60;
      const adjustedCutSec =
        clickedSec > candidateStepSec ? timeSec + clickedSec - candidateStepSec : timeSec;
      const effectiveStepTf = hasAuthenticReplayData(
        selectedSymbol,
        candidateStepTf,
        adjustedCutSec,
      )
        ? candidateStepTf
        : clickedTf;
      const finalCutSec =
        effectiveStepTf === candidateStepTf ? adjustedCutSec : timeSec;

      const pad = (n: number) => String(n).padStart(2, "0");
      const d = new Date(finalCutSec * 1000);
      const targetDate = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

      const launch = async () => {
        const loadRes = await ensureReplayHistoricalDataLoaded({
          symbol: selectedSymbol,
          primaryTimeframe: effectiveStepTf,
          additionalTimeframes: replayAdditionalTimeframes,
          secondarySymbols: replaySecondarySymbols,
          targetDate,
          targetTimeSec: finalCutSec,
          anchorAtRegularOpen: !getChartPreferencesFromStorage().showExtendedHours,
        });
        const resolvedTf = hasAuthenticReplayData(
          selectedSymbol,
          candidateStepTf,
          adjustedCutSec,
        )
          ? candidateStepTf
          : effectiveStepTf;
        const resolvedCut = resolvedTf === candidateStepTf ? adjustedCutSec : finalCutSec;
        const res = replay.start(selectedSymbol, resolvedTf, resolvedCut, { temporary: false });
        if (res.ok) {
          if (loadRes.warnings.length > 0) {
            replay.setDataWarning(loadRes.warnings[0]!);
          }
          toast.success(
            "Replay Histórico Iniciado",
            chartLayout === "1"
              ? "Las velas futuras están ocultas. Avanza vela a vela o realiza operaciones simuladas."
              : `Replay sincronizado en todas las gráficas (paso ${resolvedTf}). Avanza vela a vela o reproduce.`,
          );
        } else {
          toast.warning("Replay", loadRes.error ?? res.error);
        }
      };
      void launch();
    },
    [
      replay,
      selectedSymbol,
      timeframe,
      activeReplayStepTimeframe,
      replayAdditionalTimeframes,
      replaySecondarySymbols,
      chartLayout,
    ],
  );

  const handleReplayFromHistory = useCallback(
    (trade: ClosedPosition, entryTimeSec: number) => {
      const symbolName = trade.symbolName;
      const res = replay.start(symbolName, "4h", entryTimeSec, { temporary: true, trade });
      if (res.ok) {
        if (symbolName !== selectedSymbol) {
          setSelectedSymbol(symbolName);
        }
        setTimeframe("4h");
        localStorage.setItem(`tf_${symbolName}`, "4h");
        const entryDate = new Date(entryTimeSec * 1000);
        toast.success(
          "Replay Temporal (4H)",
          `Posicionado en la entrada del trade (${entryDate.toLocaleDateString("es-ES")} ${entryDate.toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" })}). Niveles de Entrada, SL y TP visibles en el gráfico.`,
        );
      } else {
        toast.warning("Replay", res.error);
      }
    },
    [replay, selectedSymbol, setSelectedSymbol],
  );

  // Deep-history target used after the initial fast render completes.
  // Fast initial render batch (1,000 bars max).
  // Older historical bars (from the deep 20,000+ dataset) load on-demand
  // as the user scrolls back in time via the chart's makeHistoryLoader.
  const deepCandleLimit = useMemo(() => {
    if (timeframe === "1w") return 500;
    const emaLines = getIndicatorSettings().ema?.lines ?? [];
    const activePeriods = emaLines.filter((l) => l.enabled && l.period > 0).map((l) => l.period);
    return Math.max(1_500, computeRequiredWarmupBars(activePeriods));
  }, [timeframe]);
  const { data: candles = [] } = useCandles(
    selectedSymbol,
    timeframe,
    deepCandleLimit,
    replayVersion,
  );
  const mainChartCandles = useMemo(
    () =>
      resolveMainChartCandles({
        phase: replay.phase,
        replayVisible: replay.visible,
        replayTimeframe: replay.timeframe,
        replaySimTimeSec: replay.simTimeSec,
        selectedSymbol,
        timeframe,
        liveCandles: candles,
      }),
    [
      replay.phase,
      replay.visible,
      replay.timeframe,
      replay.simTimeSec,
      selectedSymbol,
      timeframe,
      candles,
    ],
  );
  const chartPrefs = useChartPreferences();
  const cycleMagnetMode = useCallback(() => {
    const order: MagnetMode[] = ["none", "weak", "strong"];
    const next = order[(order.indexOf(chartPrefs.magnetMode) + 1) % order.length] ?? "none";
    updateChartPreferences({ magnetMode: next });
  }, [chartPrefs.magnetMode]);

  const { data: positions = [] } = usePositions(activeAccountId);
  positionsRef.current = positions;
  const { data: orders = [] } = useOrders(activeAccountId);

  const tick = ticks[selectedSymbol];
  const replayLastBar =
    isReplayActive && replay.visible && replay.visible.length > 0
      ? replay.visible[replay.visible.length - 1]
      : null;
  const effectiveTick = useMemo(() => {
    if (isReplayActive) {
      if (!replayLastBar) return undefined;
      return {
        bid: replayLastBar.close,
        ask: replayLastBar.close,
        timestamp: replayLastBar.time * 1000,
      };
    }
    return tick;
  }, [isReplayActive, replayLastBar, tick]);

  const livePositions = useMemo(
    () =>
      positions.map((p) => {
        const symTick =
          isReplayActive && p.symbolName === selectedSymbol ? effectiveTick : ticks[p.symbolName];
        if (!symTick) return p;
        return {
          ...p,
          currentPrice: computeLivePrice(p, symTick),
          unrealizedPnl: computeLivePnl(p, symTick),
        };
      }),
    [positions, ticks, isReplayActive, selectedSymbol, effectiveTick],
  );

  const chartPositions = chartPrefs.overlayPositionsOnChart ? livePositions : [];
  const chartOrders = chartPrefs.overlayPositionsOnChart ? orders : [];

  // Get account data for risk display
  const account = useTradingStore((s) => s.accounts.find((a) => a.id === activeAccountId));

  const symbolInfo = symbols.find((s) => s.name === selectedSymbol) as Symbol | undefined;
  const liveCandleUpdates = useTradingStore((s) => s.liveCandleUpdates);
  const liveCandle = liveCandleUpdates[`${selectedSymbol}:${timeframe}`];
  const pipDigits = useMemo(
    () => getPipDigits(symbolInfo, selectedSymbol),
    [symbolInfo, selectedSymbol],
  );

  const isDark = !document.documentElement.classList.contains("light");

  // Top-level workspace tab ("chart" | "screener")
  const [activeTab, setActiveTab] = useState<"chart" | "screener">("chart");
  const [screenerMounted, setScreenerMounted] = useState(false);

  const handleSelectWorkspaceTab = useCallback((tab: "chart" | "screener") => {
    if (tab === "screener") setScreenerMounted(true);
    setActiveTab(tab);
  }, []);

  useEffect(() => {
    if (activeTab !== "chart") return;
    const raf = requestAnimationFrame(() => {
      window.dispatchEvent(new Event("resize"));
    });
    return () => cancelAnimationFrame(raf);
  }, [activeTab]);

  const handleOpenStockFromScreener = useCallback(
    (stock: ScreenerStock) => {
      const existingSym = getDemoSymbol(stock.ticker);
      if (existingSym?.exchange && stock.exchange && existingSym.exchange !== stock.exchange) {
        invalidateStockSeries(stock.ticker);
      }
      registerDynamicSymbol({
        name: stock.ticker,
        displayName: stock.description,
        category: "STOCKS",
        initialPrice: stock.close,
        tickSize: stock.close < 1 ? 0.0001 : 0.01,
        exchange: stock.exchange,
        country: stock.country,
        currency: stock.currency,
        keywords: [
          stock.ticker.toLowerCase(),
          stock.description.toLowerCase(),
          stock.sector.toLowerCase(),
          stock.exchange.toLowerCase(),
          ...(stock.country ? [stock.country.toLowerCase()] : []),
          "bolsa",
          "acciones",
        ],
      });
      syncCursorPrice(stock.ticker, stock.close);
      if ((stock.premarketVolume ?? 0) > 0 && !chartPrefs.showExtendedHours) {
        updateChartPreferences({ showExtendedHours: true });
      }
      void useTradingStore.getState().loadSymbols();
      void queryClient.invalidateQueries({ queryKey: queryKeys.market.symbols });
      const savedTf = localStorage.getItem(`tf_${stock.ticker}`);
      let targetTf: Timeframe =
        savedTf && isValidTimeframe(savedTf) ? (savedTf as Timeframe) : timeframe;
      if (targetTf === "1d" || targetTf === "1w") {
        targetTf = "5m";
        localStorage.setItem(`tf_${stock.ticker}`, targetTf);
      }
      if (targetTf !== timeframe) {
        setTimeframe(targetTf);
      }
      void queryClient.prefetchQuery({
        queryKey: [...queryKeys.market.candles(stock.ticker, targetTf), "auto", 0],
        queryFn: () => api.getCandlesWithMeta(stock.ticker, targetTf),
        staleTime: 30_000,
      });
      setSelectedSymbol(stock.ticker);
      setActiveTab("chart");
      toast.success(stock.ticker, `${stock.description} abierto en el gráfico`);
    },
    [chartPrefs.showExtendedHours, queryClient, setSelectedSymbol, timeframe],
  );

  // Mobile trading state
  const [mobilePanelOpen, setMobilePanelOpen] = useState(false);

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* ── Dedicated Full-Screen Stock Screener Tab ─────────── */}
      {screenerMounted && (
        <div
          className={
            activeTab === "screener"
              ? "flex flex-col flex-1 min-h-0 overflow-hidden"
              : "hidden"
          }
        >
          <StockScreenerTab
            onOpenStockInChart={handleOpenStockFromScreener}
            onBackToChart={() => handleSelectWorkspaceTab("chart")}
            activeSymbol={selectedSymbol}
          />
        </div>
      )}

      {/* ── Trading Chart Workspace Tab ──────────────────────── */}
      <div
        className={
          activeTab === "chart"
            ? "flex flex-col flex-1 min-h-0 overflow-hidden"
            : "hidden"
        }
      >
      {/* ── Top Toolbar ──────────────────────────────────── */}
      <ChartToolbar
        selectedSymbol={selectedSymbol}
        symbols={symbols}
        onSymbolChange={(sym) => {
          setSelectedSymbol(sym);
        }}
        timeframe={focusedPaneSlot === 0 ? timeframe : paneTimeframes[focusedPaneSlot]}
        onTimeframeChange={(tf) => {
          if (focusedPaneSlot === 0) handleTimeframeChange(tf);
          else handleSetPaneTimeframe(focusedPaneSlot, tf);
        }}
        activeIndicators={
          focusedPaneSlot === 0 ? activeIndicators : paneIndicators[focusedPaneSlot]
        }
        onToggleIndicator={(type) => {
          if (focusedPaneSlot === 0) {
            handleUpdateIndicators((prev) =>
              prev.includes(type) ? prev.filter((t) => t !== type) : [...prev, type],
            );
          } else {
            handleTogglePaneIndicator(focusedPaneSlot, type);
          }
        }}
        showIndicatorMenu={showIndicatorMenu}
        onToggleIndicatorMenu={() => setShowIndicatorMenu((v) => !v)}
        drawingTool={drawingTool}
        onDrawingTool={setDrawingTool}
        drawings={drawings}
        onClearDrawings={clearDrawings}
        rightPanel={rightPanel}
        onRightPanel={handleSelectRightPanel}
        showRightPanel={showRightPanel}
        onToggleRightPanel={() => setShowRightPanel((v) => !v)}
        floatingOrderOpen={floatingOrderOpen}
        onToggleFloatingOrder={() => setFloatingOrderOpen((v) => !v)}
        tick={effectiveTick}
        symbolInfo={symbolInfo}
        aiTraderEnabled={false}
        isReplaying={isReplayActive}
        replayTimeframe={activeReplayStepTimeframe}
        replayAdditionalTimeframes={replayAdditionalTimeframes}
        replaySecondarySymbols={replaySecondarySymbols}
        replayAccountId={activeAccountId}
        activePlugins={activePlugins}
        onTogglePlugin={handleTogglePlugin}
        onSetIndicators={(next) => {
          if (focusedPaneSlot === 0) {
            handleUpdateIndicators(next);
          } else {
            handleSetPaneIndicators(focusedPaneSlot, next);
          }
        }}
        onSetPlugins={handleSetPlugins}
        magnetMode={chartPrefs.magnetMode}
        onCycleMagnet={cycleMagnetMode}
        stayInDrawingMode={chartPrefs.stayInDrawingMode}
        onToggleStayInDrawingMode={() =>
          updateChartPreferences({ stayInDrawingMode: !chartPrefs.stayInDrawingMode })
        }
        chartLayout={chartLayout}
        onChartLayoutChange={handleChartLayoutChange}
        syncPrice2x1={syncPrice2x1}
        canSyncPrice2x1={canSyncPrice2x1}
        onToggleSyncPrice2x1={handleToggleSyncPrice2x1}
        focusedShowVolume={
          focusedPaneSlot === 0
            ? chartPrefs.showVolume
            : (paneShowVolume[focusedPaneSlot] ?? chartPrefs.showVolume)
        }
        onToggleVolume={
          focusedPaneSlot === 0
            ? () => updateChartPreferences({ showVolume: !chartPrefs.showVolume })
            : () => handleTogglePaneVolume(focusedPaneSlot)
        }
        multiChartTemplateState={multiChartTemplateState}
        onApplyMultiChartTemplate={handleApplyMultiChartTemplate}
        showScreener={activeTab === "screener"}
        onToggleScreener={() =>
          handleSelectWorkspaceTab(activeTab === "screener" ? "chart" : "screener")
        }
      />

      <MarketClosedBanner symbolInfo={symbolInfo} />

      {/* ── Main Layout ──────────────────────────────────── */}
      <div className="flex flex-col md:flex-row flex-1 overflow-hidden">
        {/* Chart + Bottom Panel */}
        <div className="flex flex-col flex-1 min-w-0 min-h-0">
          {/* Chart Area (Single or Multichart Split Grid) */}
          <div
            className={
              chartLayout === "1" || expandedPaneSlot !== null
                ? "flex-1 min-h-[200px] relative"
                : chartLayout === "2x1"
                  ? "flex-1 min-h-[200px] grid grid-cols-1 md:grid-cols-2 grid-rows-2 md:grid-rows-1 gap-[2px] bg-slate-500/60"
                  : "flex-1 min-h-[200px] grid grid-cols-1 md:grid-cols-2 grid-rows-4 md:grid-rows-2 gap-[2px] bg-slate-500/60"
            }
          >
            <div
              onMouseDownCapture={() => setFocusedPaneSlot(0)}
              className={`${
                expandedPaneSlot !== null && expandedPaneSlot !== 0
                  ? "hidden"
                  : "relative min-w-0 min-h-0 w-full h-full bg-card"
              }${
                chartLayout !== "1" && expandedPaneSlot === null && focusedPaneSlot === 0
                  ? " ring-1 ring-inset ring-primary/60"
                  : ""
              }`}
            >
              <ChartPanel
                candles={mainChartCandles}
                selectedSymbol={selectedSymbol}
                timeframe={timeframe}
                isDark={isDark}
                activeIndicators={activeIndicators}
                drawingTool={drawingTool}
                drawings={isReplayActive && replay.isTemporary ? [] : drawings}
                onAddDrawing={addDrawing}
                onUpdateDrawing={updateDrawing}
                onRemoveDrawing={removeDrawing}
                onDrawingComplete={() => setDrawingTool("none")}
                onDrawingToolSelect={setDrawingTool}
                onUndoDrawing={handleUnifiedUndo}
                onRedoDrawing={handleUnifiedRedo}
                magnetMode={chartPrefs.magnetMode}
                stayInDrawingMode={chartPrefs.stayInDrawingMode}
                positions={chartPositions}
                orders={chartOrders}
                tick={isReplayActive ? effectiveTick : tick}
                liveCandle={isReplayActive ? undefined : liveCandle}
                pipDigits={pipDigits}
                symbolInfo={symbolInfo}
                onModifyPosition={handleChartModifyPosition}
                onClosePosition={handleChartClosePosition}
                draftOrderPreview={isReplayActive && replay.isTemporary ? null : draftOrderPreview}
                onModifyDraftSlTp={handleModifyDraftSlTp}
                replayPicking={isReplayPicking}
                onPickReplayBar={handlePickReplayBar}
                isReplaying={isReplayActive}
                priceSyncActive={effectivePriceSync}
                priceSyncController={priceSyncController}
                activePlugins={activePlugins}
                onTogglePlugin={handleTogglePlugin}
                accountEquity={account?.equity ?? account?.balance ?? 0}
                accountId={activeAccountId}
                onQuickOrder={handleQuickOrder}
                onClearDrawings={clearDrawings}
                onClearIndicators={handleClearIndicators}
                onToggleIndicator={(type) =>
                  handleUpdateIndicators((prev) =>
                    prev.includes(type) ? prev.filter((t) => t !== type) : [...prev, type],
                  )
                }
                canExpandPane={chartLayout !== "1"}
                isPaneExpanded={expandedPaneSlot === 0}
                onToggleExpandPane={() => handleToggleExpandPane(0)}
                expandLayoutLabel={chartLayout === "2x2" ? "2×2" : "2×1"}
              />

              {/* Floating Quick Market Order Widget */}
              {floatingOrderOpen && (
                <FloatingOrderWidget
                  symbol={selectedSymbol}
                  symbolInfo={symbolInfo}
                  tick={isReplayActive ? effectiveTick : tick}
                  accountId={activeAccountId}
                  accountBalance={account?.balance}
                  oneClick={oneClick}
                  onToggleOneClick={toggleOneClick}
                  onConfirmOrder={setConfirmOrder}
                  isFeedConnected={isFeedConnected}
                  onOrderSuccess={() => {
                    playTradeSound();
                    handleFirstTrade();
                  }}
                  onDraftPreviewChange={setDraftOrderPreview}
                  externalDraftSlTp={externalDraftSlTp}
                  onClose={() => setFloatingOrderOpen(false)}
                />
              )}

              {/* Floating button to reopen order widget when closed */}
              {!floatingOrderOpen && (
                <button
                  type="button"
                  onClick={() => setFloatingOrderOpen(true)}
                  className="absolute top-3 left-14 z-30 flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-card/95 hover:bg-card border border-border/90 shadow-xl backdrop-blur-md text-xs font-mono font-bold text-foreground transition-all hover:scale-105"
                  title="Abrir orden flotante a mercado"
                >
                  <Zap className="w-3.5 h-3.5 text-primary" />
                  <span>Nueva Orden</span>
                </button>
              )}
            </div>

            {chartLayout !== "1" && (
              <div
                className={
                  expandedPaneSlot !== null && expandedPaneSlot !== 1
                    ? "hidden"
                    : "relative min-w-0 min-h-0 w-full h-full bg-card"
                }
              >
                <MultiChartPane
                  slotId={1}
                  mainSymbol={selectedSymbol}
                  defaultTimeframe={timeframe === "1m" ? "5m" : "1m"}
                  timeframe={paneTimeframes[1]}
                  onChangeTimeframe={(tf) => handleSetPaneTimeframe(1, tf)}
                  activeIndicators={paneIndicators[1]}
                  showVolume={paneShowVolume[1] ?? chartPrefs.showVolume}
                  isFocused={focusedPaneSlot === 1 && expandedPaneSlot === null}
                  onFocus={() => setFocusedPaneSlot(1)}
                  isDark={isDark}
                  symbols={symbols}
                  ticks={ticks}
                  onPromoteToMain={handlePromotePaneToMain}
                  priceSyncMaster={effectivePriceSync}
                  priceSyncController={priceSyncController}
                  onPaneSymbolChange={setSlot1Symbol}
                  isReplaying={isReplayActive}
                  replaySimTimeSec={isReplayActive ? replay.simTimeSec : 0}
                  replayPicking={isReplayPicking}
                  onPickReplayBar={handlePickReplayBar}
                  drawingTool={drawingTool}
                  onDrawingComplete={() => setDrawingTool("none")}
                  onDrawingToolSelect={setDrawingTool}
                  accountEquity={account?.equity ?? account?.balance ?? 0}
                  hideDrawings={isReplayActive && replay.isTemporary}
                  canExpand={true}
                  isExpanded={expandedPaneSlot === 1}
                  onToggleExpand={() => handleToggleExpandPane(1)}
                  expandLabel={chartLayout === "2x2" ? "2×2" : "2×1"}
                />
              </div>
            )}

            {chartLayout === "2x2" && (
              <>
                <div
                  className={
                    expandedPaneSlot !== null && expandedPaneSlot !== 2
                      ? "hidden"
                      : "relative min-w-0 min-h-0 w-full h-full bg-card"
                  }
                >
                  <MultiChartPane
                    slotId={2}
                    mainSymbol={selectedSymbol}
                    defaultTimeframe="15m"
                    timeframe={paneTimeframes[2]}
                    onChangeTimeframe={(tf) => handleSetPaneTimeframe(2, tf)}
                    activeIndicators={paneIndicators[2]}
                    showVolume={paneShowVolume[2] ?? chartPrefs.showVolume}
                    isFocused={focusedPaneSlot === 2 && expandedPaneSlot === null}
                    onFocus={() => setFocusedPaneSlot(2)}
                    isDark={isDark}
                    symbols={symbols}
                    ticks={ticks}
                    onPromoteToMain={handlePromotePaneToMain}
                    onPaneSymbolChange={setSlot2Symbol}
                    isReplaying={isReplayActive}
                    replaySimTimeSec={isReplayActive ? replay.simTimeSec : 0}
                    replayPicking={isReplayPicking}
                    onPickReplayBar={handlePickReplayBar}
                    drawingTool={drawingTool}
                    onDrawingComplete={() => setDrawingTool("none")}
                    onDrawingToolSelect={setDrawingTool}
                    accountEquity={account?.equity ?? account?.balance ?? 0}
                    hideDrawings={isReplayActive && replay.isTemporary}
                    canExpand={true}
                    isExpanded={expandedPaneSlot === 2}
                    onToggleExpand={() => handleToggleExpandPane(2)}
                    expandLabel="2×2"
                  />
                </div>
                <div
                  className={
                    expandedPaneSlot !== null && expandedPaneSlot !== 3
                      ? "hidden"
                      : "relative min-w-0 min-h-0 w-full h-full bg-card"
                  }
                >
                  <MultiChartPane
                    slotId={3}
                    mainSymbol={selectedSymbol}
                    defaultTimeframe="1h"
                    timeframe={paneTimeframes[3]}
                    onChangeTimeframe={(tf) => handleSetPaneTimeframe(3, tf)}
                    activeIndicators={paneIndicators[3]}
                    showVolume={paneShowVolume[3] ?? chartPrefs.showVolume}
                    isFocused={focusedPaneSlot === 3 && expandedPaneSlot === null}
                    onFocus={() => setFocusedPaneSlot(3)}
                    isDark={isDark}
                    symbols={symbols}
                    ticks={ticks}
                    onPromoteToMain={handlePromotePaneToMain}
                    onPaneSymbolChange={setSlot3Symbol}
                    isReplaying={isReplayActive}
                    replaySimTimeSec={isReplayActive ? replay.simTimeSec : 0}
                    replayPicking={isReplayPicking}
                    onPickReplayBar={handlePickReplayBar}
                    drawingTool={drawingTool}
                    onDrawingComplete={() => setDrawingTool("none")}
                    onDrawingToolSelect={setDrawingTool}
                    accountEquity={account?.equity ?? account?.balance ?? 0}
                    hideDrawings={isReplayActive && replay.isTemporary}
                    canExpand={true}
                    isExpanded={expandedPaneSlot === 3}
                    onToggleExpand={() => handleToggleExpandPane(3)}
                    expandLabel="2×2"
                  />
                </div>
              </>
            )}
          </div>

          {/* ── Resize Handle (hidden when bottom panel is collapsed) ── */}
          {!bottomPanelCollapsed && (
            <div
              onMouseDown={handleResizeStart}
              onTouchStart={handleResizeStart}
              className="hidden md:flex h-1.5 cursor-row-resize items-center justify-center hover:bg-primary/20 active:bg-primary/30 transition-colors group border-t border-border bg-secondary/40 touch-none"
            >
              <div className="w-8 h-0.5 rounded-full bg-border group-hover:bg-primary/50 transition-colors" />
            </div>
          )}

          {/* Bottom Panel (Positions / Orders / Journal / Calendar / News) */}
          <BottomPanel
            tab={bottomTab}
            onTabChange={setBottomTab}
            positions={livePositions}
            orders={orders}
            accountId={activeAccountId}
            onModifyPosition={setModifyingPosition}
            onModifyOrder={setModifyingOrder}
            onSelectPositionSymbol={setSelectedSymbol}
            onSelectOrderSymbol={setSelectedSymbol}
            onReplayTrade={handleReplayFromHistory}
            aiTraderEnabled={false}
            height={bottomPanelHeight}
            isFeedConnected={isFeedConnected}
            isCollapsed={bottomPanelCollapsed}
            onToggleCollapse={handleToggleBottomPanelCollapse}
            journalEntries={[]}
            journalLoading={false}
            onCreateJournal={(_data: CreateJournalEntryInput) => {}}
            onUpdateJournal={(_id: string, _data: UpdateJournalEntryInput) => {}}
            onDeleteJournal={(_id: string) => {}}
          />
        </div>

        {/* Right Panel */}
        {showRightPanel && (
          <div className="hidden md:flex w-full md:w-[360px] xl:w-[430px] border-t md:border-t-0 md:border-l border-border flex-col bg-card overflow-hidden shrink-0 md:max-h-none">
            {rightPanel === "dom" && <DOMPanel symbol={selectedSymbol} tick={effectiveTick} />}
            {rightPanel === "watchlist" && (
              <WatchlistPanel
                symbols={symbols}
                ticks={ticks}
                selectedSymbol={selectedSymbol}
                onSelect={setSelectedSymbol}
                oneClick={oneClick}
                accountId={activeAccountId}
                isFeedConnected={isFeedConnected}
              />
            )}
            {rightPanel === "news" && (
              <div className="flex-1 overflow-y-auto p-2 space-y-2">
                <MarketNewsFeed symbol={selectedSymbol} />
              </div>
            )}
            {rightPanel === "ai-trader" && (
              <div className="flex-1 overflow-hidden">
                <AiTraderPanel accountId={activeAccountId} />
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── Mobile Trading Panel (small screens only) ──── */}
      <div className="md:hidden">
        {!mobilePanelOpen && (
          <button
            onClick={() => setMobilePanelOpen(true)}
            className="fixed bottom-20 right-4 z-40 bg-primary text-primary-foreground rounded-full w-14 h-14 flex items-center justify-center shadow-lg active:scale-95 transition-transform"
          >
            <span className="text-2xl font-bold">$</span>
          </button>
        )}
        {mobilePanelOpen && (
          <div className="fixed inset-x-0 bottom-0 z-50 max-h-[70vh] overflow-y-auto bg-card border-t border-border rounded-t-2xl shadow-2xl safe-area-bottom">
            <div className="flex justify-center py-1">
              <button
                onClick={() => setMobilePanelOpen(false)}
                className="w-10 h-1.5 rounded-full bg-muted-foreground/30"
              />
            </div>
            <MobileTradingPanel
              symbol={selectedSymbol}
              bid={effectiveTick?.bid}
              ask={effectiveTick?.ask}
              accountBalance={account?.balance}
              positions={livePositions || []}
              onClosePosition={handleChartClosePosition}
              onCloseAllPositions={async () => {
                if (!activeAccountId) return;
                try {
                  await api.closeAllPositions();
                  toast.success("Positions Closed", "All positions have been closed");
                  queryClient.invalidateQueries({ queryKey: ["positions", activeAccountId] });
                  queryClient.invalidateQueries({ queryKey: ["closedPositions", activeAccountId] });
                  queryClient.invalidateQueries({ queryKey: ["fills", activeAccountId] });
                  queryClient.invalidateQueries({ queryKey: queryKeys.accounts.detail(activeAccountId) });
                } catch (err: unknown) {
                  toast.error("Close All Failed", getErrorMessage(err));
                }
              }}
              onPlaceOrder={(order) => {
                if (!activeAccountId) {
                  toast.warning("No Account", "Select an account before placing orders");
                  return;
                }
                if (oneClick) {
                  api
                    .placeOrder({ ...order, accountId: activeAccountId } as PlaceOrderInput)
                    .then(() => {
                      playTradeSound();
                      handleFirstTrade();
                      queryClient.invalidateQueries({ queryKey: ["positions", activeAccountId] });
                      queryClient.invalidateQueries({ queryKey: ["orders", activeAccountId] });
                      queryClient.invalidateQueries({ queryKey: ["closedPositions", activeAccountId] });
                      queryClient.invalidateQueries({ queryKey: ["fills", activeAccountId] });
                      queryClient.invalidateQueries({ queryKey: queryKeys.accounts.detail(activeAccountId) });
                    })
                    .catch((err: unknown) => {
                      toast.error("Order Failed", getErrorMessage(err));
                    });
                  setMobilePanelOpen(false);
                  return;
                }
                setConfirmOrder({
                  ...order,
                  _submit: () =>
                    api.placeOrder({ ...order, accountId: activeAccountId } as PlaceOrderInput),
                });
                setMobilePanelOpen(false);
              }}
            />
          </div>
        )}
      </div>
      </div>

      {/* Dialogs */}
      <PositionModifyDialog
        position={modifyingPosition}
        onClose={() => setModifyingPosition(null)}
        onSaved={() => {
          setModifyingPosition(null);
          if (activeAccountId) {
            queryClient.invalidateQueries({ queryKey: ["positions", activeAccountId] });
            queryClient.invalidateQueries({ queryKey: ["closedPositions", activeAccountId] });
            queryClient.invalidateQueries({ queryKey: ["fills", activeAccountId] });
            queryClient.invalidateQueries({ queryKey: queryKeys.accounts.detail(activeAccountId) });
          }
        }}
        tick={effectiveTick}
        isFeedConnected={isFeedConnected}
      />
      <OrderModifyDialog
        order={modifyingOrder}
        onClose={() => setModifyingOrder(null)}
        onSaved={() => {
          setModifyingOrder(null);
          if (activeAccountId) {
            queryClient.invalidateQueries({ queryKey: ["orders", activeAccountId] });
            queryClient.invalidateQueries({ queryKey: ["positions", activeAccountId] });
            queryClient.invalidateQueries({ queryKey: ["fills", activeAccountId] });
            queryClient.invalidateQueries({ queryKey: queryKeys.accounts.detail(activeAccountId) });
          }
        }}
        tick={effectiveTick}
      />
      <OrderConfirmDialog
        isOpen={!!confirmOrder}
        order={confirmOrder}
        onConfirm={() => {
          if (confirmOrder?._submit) {
            setConfirmLoading(true);
            confirmOrder
              ._submit()
              .then(() => {
                playTradeSound();
                handleFirstTrade();
                if (activeAccountId) {
                  queryClient.invalidateQueries({ queryKey: ["positions", activeAccountId] });
                  queryClient.invalidateQueries({ queryKey: ["orders", activeAccountId] });
                  queryClient.invalidateQueries({ queryKey: ["closedPositions", activeAccountId] });
                  queryClient.invalidateQueries({ queryKey: ["fills", activeAccountId] });
                  queryClient.invalidateQueries({ queryKey: queryKeys.accounts.detail(activeAccountId) });
                }
              })
              .catch((err: unknown) => {
                toast.error("Order Failed", getErrorMessage(err));
              })
              .finally(() => {
                setConfirmLoading(false);
                setConfirmOrder(null);
              });
          }
        }}
        onCancel={() => setConfirmOrder(null)}
        tick={effectiveTick}
        symbolInfo={symbolInfo}
        loading={confirmLoading}
      />
    </div>
  );
}
