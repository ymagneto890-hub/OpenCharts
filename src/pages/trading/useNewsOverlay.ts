import {
  useState,
  useEffect,
  useMemo,
  useRef,
  type RefObject,
  type Dispatch,
  type SetStateAction,
} from "react";
import type { IChartApi, CandlestickData, Time } from "lightweight-charts";
import { useEconomicCalendar, type EconomicCalendarEvent } from "../../services/queries.ts";
import { useReplayStore } from "../../services/demo/replay.ts";
import { type NewsOverlayConfig, TF_INTERVAL_MS, type Timeframe } from "./constants.ts";
import { extractCurrencies } from "./utils.ts";

// ── Types ────────────────────────────────────────────────────

export interface NewsPopupState {
  event: EconomicCalendarEvent;
  x: number;
  y: number;
}

export interface UseNewsOverlayReturn {
  newsConfig: NewsOverlayConfig;
  setNewsConfig: Dispatch<SetStateAction<NewsOverlayConfig>>;
  showNewsConfigDialog: boolean;
  setShowNewsConfigDialog: Dispatch<SetStateAction<boolean>>;
  newsPopup: NewsPopupState | null;
  setNewsPopup: Dispatch<SetStateAction<NewsPopupState | null>>;
  upcomingEvents: EconomicCalendarEvent[];
  isReplayActive: boolean;
  currentSec: number;
}

export function formatTimeUntil(targetSec: number, currentSec: number): string {
  const diffSec = targetSec - currentSec;
  if (diffSec <= 0) return "Ahora";
  const hours = Math.floor(diffSec / 3600);
  const days = Math.floor(hours / 24);
  if (days >= 1) {
    const remH = hours % 24;
    return remH > 0 ? `En ${days}d ${remH}h` : `En ${days}d`;
  }
  if (hours >= 1) {
    const mins = Math.floor((diffSec % 3600) / 60);
    return mins > 0 ? `En ${hours}h ${mins}m` : `En ${hours}h`;
  }
  const mins = Math.max(1, Math.floor(diffSec / 60));
  return `En ${mins}m`;
}

// ── Hook ─────────────────────────────────────────────────────

export function useNewsOverlay(
  containerRef: RefObject<HTMLDivElement | null>,
  chartRef: RefObject<IChartApi | null>,
  selectedSymbol: string,
  isDark: boolean,
  chartData: CandlestickData<Time>[],
  chartEpoch?: number,
  timeframe: string = "1d",
): UseNewsOverlayReturn {
  const [newsConfig, setNewsConfig] = useState<NewsOverlayConfig>(() => {
    const saved = localStorage.getItem("newsOverlayConfig");
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        return {
          enabled: parsed.enabled ?? true,
          lineColor: parsed.lineColor ?? "#ef4444",
          showPast: parsed.showPast ?? true,
          showFuture: parsed.showFuture ?? true,
          showHigh: parsed.showHigh ?? true,
          showMedium: parsed.showMedium ?? false,
          showLow: parsed.showLow ?? false,
        };
      } catch {
        /* ignore */
      }
    }
    return {
      enabled: true,
      lineColor: "#ef4444",
      showPast: true,
      showFuture: true,
      showHigh: true,
      showMedium: false,
      showLow: false,
    } satisfies NewsOverlayConfig;
  });
  const [showNewsConfigDialog, setShowNewsConfigDialog] = useState(false);
  const [newsPopup, setNewsPopup] = useState<NewsPopupState | null>(null);
  const newsMarkersRef = useRef<HTMLDivElement[]>([]);

  // Persist news config
  useEffect(() => {
    try {
      localStorage.setItem("newsOverlayConfig", JSON.stringify(newsConfig));
    } catch {
      // ignore storage errors
    }
  }, [newsConfig]);

  // Extract currency pair from symbol
  const symbolCurrencies = useMemo(() => extractCurrencies(selectedSymbol), [selectedSymbol]);
  const { data: rawCalendarData } = useEconomicCalendar(symbolCurrencies);

  const replayPhase = useReplayStore((s) => s.phase);
  const replaySimTimeSec = useReplayStore((s) => s.simTimeSec);
  const isReplayActive = replayPhase === "active";

  const currentSec = useMemo(() => {
    if (isReplayActive && replaySimTimeSec > 0) return replaySimTimeSec;
    if (chartData && chartData.length > 0) return Number(chartData[chartData.length - 1]!.time);
    return Math.floor(Date.now() / 1000);
  }, [isReplayActive, replaySimTimeSec, chartData]);

  // Next upcoming events relative to currentSec (e.g. for replay HUD & widgets)
  const upcomingEvents = useMemo(() => {
    return (rawCalendarData || [])
      .filter((e: EconomicCalendarEvent) => {
        if (
          symbolCurrencies.length > 0 &&
          !symbolCurrencies.includes(e.currency) &&
          e.currency !== "USD"
        ) {
          return false;
        }
        const eventTimeSec = Math.floor(new Date(e.time).getTime() / 1000);
        return eventTimeSec > currentSec;
      })
      .sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime())
      .slice(0, 10);
  }, [rawCalendarData, symbolCurrencies, currentSec]);

  // Filter events based on config
  const calendarEvents = useMemo(() => {
    if (!newsConfig.enabled) return [];
    return (rawCalendarData || []).filter((e: EconomicCalendarEvent) => {
      // Allow event if currency matches symbol or if currency is USD (moves crypto/forex markets)
      if (
        symbolCurrencies.length > 0 &&
        !symbolCurrencies.includes(e.currency) &&
        e.currency !== "USD"
      ) {
        return false;
      }

      // Filter by impact level (High, Medium, Low)
      if (e.impact === "high" && !newsConfig.showHigh) return false;
      if (e.impact === "medium" && !newsConfig.showMedium) return false;
      if (e.impact === "low" && !newsConfig.showLow) return false;

      // Filter by time (Past vs Future relative to currentSec / replay cursor)
      const eventTimeSec = Math.floor(new Date(e.time).getTime() / 1000);
      if (eventTimeSec <= currentSec && !newsConfig.showPast) return false;
      if (eventTimeSec > currentSec && !newsConfig.showFuture) return false;

      return true;
    });
  }, [rawCalendarData, newsConfig, symbolCurrencies, currentSec]);

  // Helper to find nearest candle time for snapping news event to exact bar on any timeframe
  const findNearestCandleTime = (targetSec: number): Time | null => {
    if (!chartData || chartData.length === 0) return null;
    let low = 0;
    let high = chartData.length - 1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      const t = chartData[mid]!.time as number;
      if (t === targetSec) return chartData[mid]!.time;
      if (t < targetSec) low = mid + 1;
      else high = mid - 1;
    }
    const idx = Math.max(0, Math.min(chartData.length - 1, low));
    const prevIdx = Math.max(0, idx - 1);
    const diff1 = Math.abs((chartData[idx]!.time as number) - targetSec);
    const diff2 = Math.abs((chartData[prevIdx]!.time as number) - targetSec);
    const intervalSec = chartData.length > 1
      ? Math.abs((chartData[1]!.time as number) - (chartData[0]!.time as number))
      : 86400;
    if (Math.min(diff1, diff2) > Math.max(intervalSec * 2, 86400 * 3)) {
      return null;
    }
    return diff1 < diff2 ? chartData[idx]!.time : chartData[prevIdx]!.time;
  };

  // Render news markers on chart (vertical lines + flag icons)
  useEffect(() => {
    const container = containerRef.current;
    const chart = chartRef.current;
    if (!container || !chart || !newsConfig.enabled || calendarEvents.length === 0) {
      newsMarkersRef.current.forEach((el) => el.remove());
      newsMarkersRef.current = [];
      return;
    }

    newsMarkersRef.current.forEach((el) => el.remove());
    newsMarkersRef.current = [];

    const timeScale = chart.timeScale();
    const lineColor = newsConfig.lineColor || "#ef4444";

    const hexToRgba = (hex: string, alpha: number) => {
      const m6 = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex.trim());
      if (m6) {
        return `rgba(${parseInt(m6[1]!, 16)},${parseInt(m6[2]!, 16)},${parseInt(m6[3]!, 16)},${alpha})`;
      }
      const m3 = /^#?([a-f\d])([a-f\d])([a-f\d])$/i.exec(hex.trim());
      if (m3) {
        return `rgba(${parseInt(m3[1]! + m3[1]!, 16)},${parseInt(m3[2]! + m3[2]!, 16)},${parseInt(m3[3]! + m3[3]!, 16)},${alpha})`;
      }
      return `rgba(239,68,68,${alpha})`;
    };

    const impactColor = (impact: string) => {
      if (impact === "high") return lineColor;
      if (impact === "medium") return "#f59e0b";
      return "#6b7280";
    };

    const renderMarkers = () => {
      newsMarkersRef.current.forEach((el) => el.remove());
      newsMarkersRef.current = [];

      const containerRect = container.getBoundingClientRect();
      const lastIndex = chartData.length - 1;
      const lastBar = lastIndex >= 0 ? chartData[lastIndex] : null;
      const lastTimeSec = lastBar ? Number(lastBar.time) : 0;

      const tfMs = TF_INTERVAL_MS[timeframe as Timeframe];
      const intervalSec =
        tfMs != null
          ? tfMs / 1000
          : chartData.length > 1
            ? Math.max(60, Number(chartData[lastIndex]!.time) - Number(chartData[lastIndex - 1]!.time))
            : 86400;

      // 1. Get the anchor coordinate of the last candle on the chart
      let xLast: number | null = lastBar
        ? (timeScale.timeToCoordinate(lastBar.time as Parameters<typeof timeScale.timeToCoordinate>[0]) as number | null)
        : null;

      // 2. Determine bar spacing in pixels between candles
      let barSpacing = 16;
      if (chartData.length >= 2 && lastBar && xLast !== null) {
        const xPrev = timeScale.timeToCoordinate(
          chartData[lastIndex - 1]!.time as Parameters<typeof timeScale.timeToCoordinate>[0],
        );
        if (xPrev !== null && Math.abs(xLast - (xPrev as number)) > 0) {
          barSpacing = Math.abs(xLast - (xPrev as number));
        }
      }
      if (barSpacing <= 0 || !Number.isFinite(barSpacing)) {
        const visibleRange = timeScale.getVisibleLogicalRange();
        if (visibleRange && visibleRange.to > visibleRange.from) {
          barSpacing = Math.max(4, (containerRect.width - 70) / (visibleRange.to - visibleRange.from));
        }
      }

      // If xLast is null (e.g. lastBar was scrolled off to the left), find any visible candle as anchor
      if (xLast === null && lastBar) {
        for (let i = lastIndex - 1; i >= 0; i--) {
          const coord = timeScale.timeToCoordinate(
            chartData[i]!.time as Parameters<typeof timeScale.timeToCoordinate>[0],
          );
          if (coord !== null) {
            const barsFromAnchor = (lastTimeSec - Number(chartData[i]!.time)) / intervalSec;
            xLast = (coord as number) + barsFromAnchor * barSpacing;
            break;
          }
        }
      }
      if (xLast === null && lastIndex >= 0) {
        xLast = timeScale.logicalToCoordinate(lastIndex as Parameters<typeof timeScale.logicalToCoordinate>[0]) as number | null;
      }

      // Track placed horizontal coordinates to stack simultaneous events cleanly
      const placedX: number[] = [];
      const drawnLineX: number[] = [];

      // Sort with high impact first so the primary line takes high impact color if on the same bar
      const sortedEvents = [...calendarEvents].sort((a, b) => {
        const diff = new Date(a.time).getTime() - new Date(b.time).getTime();
        if (diff !== 0) return diff;
        const impactScore: Record<string, number> = { high: 3, medium: 2, low: 1 };
        return (impactScore[b.impact] ?? 0) - (impactScore[a.impact] ?? 0);
      });

      for (const ev of sortedEvents) {
        const eventTimeSec = Math.floor(new Date(ev.time).getTime() / 1000);
        const isFuture = eventTimeSec > currentSec;
        let x: number | null = null;

        if (eventTimeSec <= lastTimeSec) {
          x = timeScale.timeToCoordinate(
            eventTimeSec as Parameters<typeof timeScale.timeToCoordinate>[0],
          );
          if (x === null && chartData.length > 0) {
            const nearestBar = findNearestCandleTime(eventTimeSec);
            if (nearestBar) {
              x = timeScale.timeToCoordinate(nearestBar);
            }
          }
        } else {
          // Future event in whitespace to the right
          const barOffset = (eventTimeSec - lastTimeSec) / intervalSec;
          if (xLast !== null && Number.isFinite(xLast)) {
            x = xLast + barOffset * barSpacing;
          }
        }

        // Hide if outside the visible chart canvas or underneath the right price scale
        if (x === null || x < 0 || x > containerRect.width - 55) continue;

        const color = impactColor(ev.impact);

        let stackLevel = 0;
        for (const prevX of placedX) {
          if (Math.abs(prevX - x) < 22) {
            stackLevel++;
          }
        }
        placedX.push(x);

        const bottomPos = 28 + stackLevel * 26;

        // Vertical dotted line: draw once per day/column so multiple events don't blur each other
        const alreadyHasLine = drawnLineX.some((lx) => Math.abs(lx - x) < 4);
        if (!alreadyHasLine) {
          drawnLineX.push(x);
          const line = document.createElement("div");
          line.style.position = "absolute";
          line.style.left = `${Math.round(x)}px`;
          line.style.top = "0";
          line.style.bottom = "28px";
          line.style.width = isFuture ? "2px" : "1px";
          line.style.backgroundImage = isFuture
            ? `repeating-linear-gradient(to bottom, ${hexToRgba(color, 0.95)} 0px, ${hexToRgba(color, 0.95)} 6px, transparent 6px, transparent 10px)`
            : `repeating-linear-gradient(to bottom, ${hexToRgba(color, 0.6)} 0px, ${hexToRgba(color, 0.6)} 4px, transparent 4px, transparent 8px)`;
          line.style.pointerEvents = "none";
          line.style.zIndex = "10";
          if (isFuture) {
            line.style.boxShadow = `0 0 8px ${hexToRgba(color, 0.5)}`;
          }
          container.appendChild(line);
          newsMarkersRef.current.push(line);
        }

        // Circular flag icon
        const flag = document.createElement("div");
        flag.style.position = "absolute";
        flag.style.left = `${Math.round(x - 11)}px`;
        flag.style.bottom = `${bottomPos}px`;
        flag.style.width = "22px";
        flag.style.height = "22px";
        flag.style.borderRadius = "50%";
        flag.style.display = "flex";
        flag.style.alignItems = "center";
        flag.style.justifyContent = "center";
        flag.style.fontSize = "11px";
        flag.style.fontWeight = "700";
        flag.style.cursor = "pointer";
        flag.style.zIndex = "15";
        flag.style.transition = "transform 0.15s ease, box-shadow 0.15s ease";
        flag.style.border = `2px solid ${color}`;
        flag.style.backgroundColor = isDark ? "#131722" : "#ffffff";
        flag.style.color = color;
        flag.style.boxShadow = isFuture
          ? `0 0 10px ${hexToRgba(color, 0.75)}`
          : "0 2px 6px rgba(0,0,0,0.35)";
        flag.textContent = ev.impact === "high" ? "⚡" : ev.impact === "medium" ? "📰" : "📊";
        const timeUntilStr = isFuture ? ` (${formatTimeUntil(eventTimeSec, currentSec)})` : "";
        flag.title = `${ev.event} (${ev.currency})${timeUntilStr} - Clic para ver detalles`;

        flag.addEventListener("mouseenter", () => {
          flag.style.transform = "scale(1.25)";
          flag.style.boxShadow = `0 0 14px ${hexToRgba(color, 0.9)}`;
        });
        flag.addEventListener("mouseleave", () => {
          flag.style.transform = "scale(1)";
          flag.style.boxShadow = isFuture
            ? `0 0 10px ${hexToRgba(color, 0.75)}`
            : "0 2px 6px rgba(0,0,0,0.35)";
        });

        flag.addEventListener("click", (e) => {
          e.stopPropagation();
          const rect = flag.getBoundingClientRect();
          const containerPos = container.getBoundingClientRect();
          setNewsPopup({
            event: ev,
            x: rect.left - containerPos.left + rect.width / 2,
            y: rect.top - containerPos.top - 8,
          });
        });

        container.appendChild(flag);
        newsMarkersRef.current.push(flag);
      }
    };

    renderMarkers();

    let rafId: number | null = null;
    const onRangeChange = () => {
      if (rafId !== null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        renderMarkers();
      });
    };
    timeScale.subscribeVisibleLogicalRangeChange(onRangeChange);
    timeScale.subscribeVisibleTimeRangeChange(onRangeChange);

    const resizeObserver = new ResizeObserver(() => onRangeChange());
    resizeObserver.observe(container);

    return () => {
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      try {
        timeScale.unsubscribeVisibleLogicalRangeChange(onRangeChange);
      } catch {
        /* chart disposed */
      }
      try {
        timeScale.unsubscribeVisibleTimeRangeChange(onRangeChange);
      } catch {
        /* chart disposed */
      }
      resizeObserver.disconnect();
      newsMarkersRef.current.forEach((el) => el.remove());
      newsMarkersRef.current = [];
    };
    // chartRef/containerRef are stable refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [calendarEvents, newsConfig, isDark, chartData, chartEpoch, currentSec, timeframe]);

  // Close news popup when clicking elsewhere
  useEffect(() => {
    if (!newsPopup) return;
    const handleClick = () => setNewsPopup(null);
    window.addEventListener("click", handleClick);
    return () => window.removeEventListener("click", handleClick);
  }, [newsPopup]);

  return {
    newsConfig,
    setNewsConfig,
    showNewsConfigDialog,
    setShowNewsConfigDialog,
    newsPopup,
    setNewsPopup,
    upcomingEvents,
    isReplayActive,
    currentSec,
  };
}
