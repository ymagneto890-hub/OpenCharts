import { useState, type Dispatch, type RefObject, type SetStateAction } from "react";
import {
  GripVertical,
  Newspaper,
  Settings2,
  TrendingDown,
  TrendingUp,
  Minus,
  X,
} from "lucide-react";
import { useDragOffset } from "../../hooks/useDragOffset.ts";
import { cn } from "../../lib/utils.ts";
import { evaluateEconomicEventSentiment } from "../../services/demo/economicEvents.ts";
import type { EconomicCalendarEvent } from "../../services/queries.ts";
import type { NewsOverlayConfig } from "./constants.ts";
import { type NewsPopupState } from "./useNewsOverlay.ts";

const NEWS_SENTIMENT_STORAGE_KEY = "oc_news_sentiment_overrides_v1";

function loadSentimentOverrides(): Record<string, "bullish" | "bearish" | "neutral"> {
  try {
    const raw = localStorage.getItem(NEWS_SENTIMENT_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, "bullish" | "bearish" | "neutral">)
      : {};
  } catch {
    return {};
  }
}

interface NewsOverlayProps {
  newsConfig: NewsOverlayConfig;
  setNewsConfig: Dispatch<SetStateAction<NewsOverlayConfig>>;
  showNewsConfigDialog: boolean;
  setShowNewsConfigDialog: Dispatch<SetStateAction<boolean>>;
  newsPopup: NewsPopupState | null;
  setNewsPopup: Dispatch<SetStateAction<NewsPopupState | null>>;
  isDark: boolean;
  pipDigits: number;
  containerRef: RefObject<HTMLDivElement | null>;
  upcomingEvents?: EconomicCalendarEvent[];
  isReplayActive?: boolean;
  currentSec?: number;
  selectedSymbol?: string;
  timeframe?: string;
  priceSyncActive?: boolean;
}

export function NewsOverlay({
  newsConfig,
  setNewsConfig,
  showNewsConfigDialog,
  setShowNewsConfigDialog,
  newsPopup,
  setNewsPopup,
  isDark,
  containerRef,
  priceSyncActive = false,
}: NewsOverlayProps) {
  const configDrag = useDragOffset();

  const [sentimentOverrides, setSentimentOverrides] = useState<
    Record<string, "bullish" | "bearish" | "neutral">
  >(() => loadSentimentOverrides());

  const handleSetOverride = (eventId: string, value: "bullish" | "bearish" | "neutral") => {
    setSentimentOverrides((prev) => {
      const next = { ...prev, [eventId]: value };
      try {
        localStorage.setItem(NEWS_SENTIMENT_STORAGE_KEY, JSON.stringify(next));
      } catch {
        // ignore
      }
      return next;
    });
  };

  const activeEval = newsPopup ? evaluateEconomicEventSentiment(newsPopup.event) : null;
  const effectiveSentiment = newsPopup
    ? (sentimentOverrides[newsPopup.event.id] ??
      newsPopup.event.sentiment ??
      activeEval?.sentiment ??
      "neutral")
    : "neutral";

  return (
    <>

      {/* News event popup */}
      {newsPopup && (
        <div
          className="absolute z-30"
          style={{
            left: Math.max(
              8,
              Math.min(newsPopup.x - 190, (containerRef.current?.clientWidth || 400) - 395),
            ),
            top: Math.max(newsPopup.y - 320, 8),
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <div
            className={cn(
              "w-[calc(100vw-2rem)] sm:w-[380px] rounded-xl shadow-2xl border overflow-hidden",
              isDark ? "bg-[#1e222d] border-[#363a45]" : "bg-white border-gray-200",
            )}
          >
            <div
              className={cn(
                "h-1.5",
                effectiveSentiment === "bullish"
                  ? "bg-emerald-500"
                  : effectiveSentiment === "bearish"
                    ? "bg-red-500"
                    : "bg-amber-500",
              )}
            />
            <div className="p-4 space-y-3">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h4
                    className={cn(
                      "font-bold text-[16px] sm:text-[17px] leading-snug tracking-tight",
                      isDark ? "text-white" : "text-gray-900",
                    )}
                  >
                    {newsPopup.event.event}
                  </h4>
                  <p className="text-[12.5px] text-muted-foreground mt-0.5 font-medium">
                    {(() => {
                      const d = new Date(newsPopup.event.time);
                      if (Number.isNaN(d.getTime())) return "—";
                      const dateStr = d.toLocaleDateString("es-ES", {
                        day: "numeric",
                        month: "short",
                        year: "numeric",
                      });
                      const timeStr = d.toLocaleTimeString("es-ES", {
                        hour: "2-digit",
                        minute: "2-digit",
                        hourCycle: "h23",
                      });
                      return `${dateStr} · ${timeStr}`;
                    })()}
                  </p>
                </div>
                <button
                  onClick={() => setNewsPopup(null)}
                  className="text-muted-foreground hover:text-foreground p-1 shrink-0 rounded-md hover:bg-secondary/40 transition-colors"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>

              {/* Resultado del Informe: Alcista (Bueno) / Bajista (Malo) */}
              <div
                className={cn(
                  "rounded-lg border p-3 transition-colors space-y-2",
                  effectiveSentiment === "bullish"
                    ? "bg-emerald-500/10 border-emerald-500/35"
                    : effectiveSentiment === "bearish"
                      ? "bg-red-500/10 border-red-500/35"
                      : "bg-amber-500/10 border-amber-500/35",
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[12px] font-bold uppercase tracking-wider text-muted-foreground">
                    Efecto del Informe:
                  </span>
                  <span
                    className={cn(
                      "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md font-extrabold text-[12px] sm:text-[13px] tracking-wide",
                      effectiveSentiment === "bullish"
                        ? "bg-emerald-500/25 text-emerald-400 border border-emerald-500/40"
                        : effectiveSentiment === "bearish"
                          ? "bg-red-500/25 text-red-400 border border-red-500/40"
                          : "bg-amber-500/25 text-amber-400 border border-amber-500/40",
                    )}
                  >
                    {effectiveSentiment === "bullish" ? (
                      <>
                        <TrendingUp className="h-4 w-4" />
                        ALCISTA · BUENO
                      </>
                    ) : effectiveSentiment === "bearish" ? (
                      <>
                        <TrendingDown className="h-4 w-4" />
                        BAJISTA · MALO
                      </>
                    ) : (
                      <>
                        <Minus className="h-4 w-4" />
                        NEUTRAL · EN LÍNEA
                      </>
                    )}
                  </span>
                </div>
                <p
                  className={cn(
                    "text-[13px] sm:text-[13.5px] leading-relaxed font-medium",
                    isDark ? "text-gray-200" : "text-gray-800",
                  )}
                >
                  {newsPopup.event.sentimentReason || activeEval?.reason}
                </p>

                {/* Botones para marcar/cambiar si es Alcista (Bueno) o Bajista (Malo) */}
                <div className="pt-2 border-t border-border/30 flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => handleSetOverride(newsPopup.event.id, "bullish")}
                    className={cn(
                      "flex-1 flex items-center justify-center gap-1.5 py-2 px-2.5 rounded-md text-[12px] sm:text-[12.5px] font-bold transition-all border",
                      effectiveSentiment === "bullish"
                        ? "bg-emerald-500 text-white border-emerald-500 shadow-md scale-[1.02]"
                        : "bg-emerald-500/10 text-emerald-400 border-emerald-500/30 hover:bg-emerald-500/20 active:scale-95",
                    )}
                  >
                    <TrendingUp className="h-4 w-4" />
                    Alcista (Bueno)
                  </button>
                  <button
                    type="button"
                    onClick={() => handleSetOverride(newsPopup.event.id, "bearish")}
                    className={cn(
                      "flex-1 flex items-center justify-center gap-1.5 py-2 px-2.5 rounded-md text-[12px] sm:text-[12.5px] font-bold transition-all border",
                      effectiveSentiment === "bearish"
                        ? "bg-red-500 text-white border-red-500 shadow-md scale-[1.02]"
                        : "bg-red-500/10 text-red-400 border-red-500/30 hover:bg-red-500/20 active:scale-95",
                    )}
                  >
                    <TrendingDown className="h-4 w-4" />
                    Bajista (Malo)
                  </button>
                </div>
              </div>

              {/* Datos numéricos del informe */}
              <div className="space-y-2 py-1">
                <div className="flex items-center justify-between text-[13px]">
                  <span className="text-muted-foreground font-medium">Dato Actual</span>
                  <span
                    className={cn(
                      "font-extrabold font-mono text-[16px]",
                      effectiveSentiment === "bullish"
                        ? "text-emerald-400"
                        : effectiveSentiment === "bearish"
                          ? "text-red-400"
                          : isDark
                            ? "text-white"
                            : "text-gray-900",
                    )}
                  >
                    {newsPopup.event.actual || "—"}
                  </span>
                </div>
                <div className="flex items-center justify-between text-[13px]">
                  <span className="text-muted-foreground font-medium">Previsión</span>
                  <span className="font-mono font-bold text-[14px]">
                    {newsPopup.event.forecast || "—"}
                  </span>
                </div>
                <div className="flex items-center justify-between text-[13px]">
                  <span className="text-muted-foreground font-medium">Anterior</span>
                  <span className="font-mono font-medium text-muted-foreground text-[14px]">
                    {newsPopup.event.previous || "—"}
                  </span>
                </div>
              </div>

              <div className="pt-2.5 border-t border-border/40 flex items-center gap-2 text-[12px] text-muted-foreground">
                <span
                  className={cn(
                    "inline-flex items-center gap-1 px-2 py-0.5 rounded font-bold text-[10.5px] tracking-wide",
                    newsPopup.event.impact === "high"
                      ? "bg-red-500/20 text-red-400 border border-red-500/30"
                      : newsPopup.event.impact === "medium"
                        ? "bg-amber-500/20 text-amber-400 border border-amber-500/30"
                        : "bg-gray-500/20 text-gray-300 border border-gray-500/30",
                  )}
                >
                  {newsPopup.event.impact === "high"
                    ? "ALTO IMPACTO"
                    : newsPopup.event.impact === "medium"
                      ? "MEDIO IMPACTO"
                      : "BAJO IMPACTO"}
                </span>
                <span className="font-bold text-foreground/90">{newsPopup.event.currency}</span>
                <span className="text-muted-foreground/40">|</span>
                <span className="font-medium text-foreground/80">{newsPopup.event.country}</span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* News config button */}
      <button
        onClick={(e) => {
          e.stopPropagation();
          setShowNewsConfigDialog((v) => !v);
          setNewsPopup(null);
        }}
        className={cn(
          "absolute bottom-10 z-10 flex items-center gap-1 px-2 py-1 rounded text-[10px] font-medium transition-all",
          priceSyncActive ? "right-3" : "right-28",
          newsConfig.enabled
            ? "bg-red-500/15 text-red-400 border border-red-500/30 hover:bg-red-500/25"
            : "bg-secondary/60 text-muted-foreground border border-border hover:bg-secondary",
        )}
        title="Configuración de noticias y eventos macro"
      >
        <Newspaper className="h-3 w-3" />
        Noticias
        <Settings2 className="h-2.5 w-2.5 ml-0.5 opacity-60" />
      </button>

      {/* News configuration dialog (draggable by its header) */}
      {showNewsConfigDialog && (
        <div
          className={cn(
            "absolute bottom-[4.5rem] z-30 w-[calc(100vw-1rem)] sm:w-[270px]",
            priceSyncActive ? "right-3" : "right-2 sm:right-28",
          )}
          style={configDrag.style}
          onClick={(e) => e.stopPropagation()}
        >
          <div
            className={cn(
              "rounded-lg shadow-2xl border overflow-hidden",
              isDark ? "bg-[#1e222d] border-[#363a45]" : "bg-white border-gray-200",
            )}
          >
            <div
              onPointerDown={configDrag.onPointerDown}
              className="flex cursor-grab select-none items-center justify-between px-3 py-2 border-b border-border/40 active:cursor-grabbing"
            >
              <span
                className={cn(
                  "flex items-center gap-1.5 font-bold text-[12px]",
                  isDark ? "text-white" : "text-gray-900",
                )}
              >
                <GripVertical className="h-3 w-3 text-muted-foreground/60" />
                Configuración de Noticias
              </span>
              <button
                onClick={() => setShowNewsConfigDialog(false)}
                className="text-muted-foreground hover:text-foreground p-0.5"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>

            <div className="p-3 space-y-3">
              <label className="flex items-center justify-between cursor-pointer">
                <span className="text-[11px] font-medium">Activar noticias en el gráfico</span>
                <input
                  type="checkbox"
                  checked={newsConfig.enabled}
                  onChange={(e) => setNewsConfig((c) => ({ ...c, enabled: e.target.checked }))}
                  className="h-3.5 w-3.5 rounded accent-red-500 cursor-pointer"
                />
              </label>

              <div className="flex items-center justify-between">
                <span className="text-[11px] font-medium">Color de Línea</span>
                <div className="flex items-center gap-1.5">
                  <input
                    type="color"
                    value={newsConfig.lineColor}
                    onChange={(e) => setNewsConfig((c) => ({ ...c, lineColor: e.target.value }))}
                    className="w-6 h-5 rounded border-0 cursor-pointer p-0 bg-transparent"
                  />
                  <span className="text-[9px] font-mono text-muted-foreground">
                    {newsConfig.lineColor}
                  </span>
                </div>
              </div>

              <div className="border-t border-border/40" />

              <div className="space-y-1.5">
                <span
                  className={cn(
                    "text-[10px] font-semibold uppercase tracking-wider",
                    isDark ? "text-muted-foreground" : "text-gray-500",
                  )}
                >
                  Filtros Temporales
                </span>
                <label className="flex items-center justify-between cursor-pointer">
                  <span className="text-[11px]">Mostrar eventos pasados (histórico)</span>
                  <input
                    type="checkbox"
                    checked={newsConfig.showPast}
                    onChange={(e) => setNewsConfig((c) => ({ ...c, showPast: e.target.checked }))}
                    className="h-3.5 w-3.5 rounded accent-red-500 cursor-pointer"
                  />
                </label>
                <label className="flex items-center justify-between cursor-pointer">
                  <span className="text-[11px]">Mostrar eventos futuros</span>
                  <input
                    type="checkbox"
                    checked={newsConfig.showFuture}
                    onChange={(e) => setNewsConfig((c) => ({ ...c, showFuture: e.target.checked }))}
                    className="h-3.5 w-3.5 rounded accent-red-500 cursor-pointer"
                  />
                </label>
              </div>

              <div className="border-t border-border/40" />

              <div className="space-y-1.5">
                <span
                  className={cn(
                    "text-[10px] font-semibold uppercase tracking-wider",
                    isDark ? "text-muted-foreground" : "text-gray-500",
                  )}
                >
                  Niveles de Impacto
                </span>
                <label className="flex items-center justify-between cursor-pointer">
                  <span className="flex items-center gap-1.5 text-[11px]">
                    <span className="inline-block w-2 h-2 rounded-full bg-red-500" />
                    Alto Impacto (Alta volatilidad)
                  </span>
                  <input
                    type="checkbox"
                    checked={newsConfig.showHigh}
                    onChange={(e) => setNewsConfig((c) => ({ ...c, showHigh: e.target.checked }))}
                    className="h-3.5 w-3.5 rounded accent-red-500 cursor-pointer"
                  />
                </label>
                <label className="flex items-center justify-between cursor-pointer">
                  <span className="flex items-center gap-1.5 text-[11px]">
                    <span className="inline-block w-2 h-2 rounded-full bg-amber-500" />
                    Medio Impacto (Moderado)
                  </span>
                  <input
                    type="checkbox"
                    checked={newsConfig.showMedium}
                    onChange={(e) => setNewsConfig((c) => ({ ...c, showMedium: e.target.checked }))}
                    className="h-3.5 w-3.5 rounded accent-amber-500 cursor-pointer"
                  />
                </label>
                <label className="flex items-center justify-between cursor-pointer">
                  <span className="flex items-center gap-1.5 text-[11px]">
                    <span className="inline-block w-2 h-2 rounded-full bg-gray-400" />
                    Bajo Impacto (Baja volatilidad)
                  </span>
                  <input
                    type="checkbox"
                    checked={newsConfig.showLow}
                    onChange={(e) => setNewsConfig((c) => ({ ...c, showLow: e.target.checked }))}
                    className="h-3.5 w-3.5 rounded accent-gray-500 cursor-pointer"
                  />
                </label>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
