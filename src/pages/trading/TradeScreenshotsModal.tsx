import { useState, useEffect, useRef } from "react";
import {
  Camera,
  Download,
  Maximize2,
  Minimize2,
  X,
  Clock,
  Layers,
  Calendar,
  TrendingUp,
  TrendingDown,
  AlertCircle,
  FileText,
  Save,
  Check,
  Loader2,
  RefreshCw,
} from "lucide-react";
import type { ClosedPosition, Position } from "../../services/schemas.ts";
import { cn, formatDate, formatNumber, pnlClass } from "../../lib/utils.ts";
import { formatAssetUnits } from "../../hooks/useInstrumentLabels.ts";
import { getPipDigits } from "./utils.ts";
import { api } from "../../services/api.ts";
import {
  captureDailyChart,
  captureFourHourChart,
  captureOneHourChart,
  parseTradeTimestampSec,
} from "../../lib/chart-plugins/trade-screenshot.ts";

export interface TradeScreenshotsModalProps {
  trade: (ClosedPosition | Position) | null;
  onClose: () => void;
}

export function TradeScreenshotsModal({ trade, onClose }: TradeScreenshotsModalProps) {
  const isClosed = trade != null && "exitPrice" in trade && trade.exitPrice != null;
  const closedTrade = isClosed ? (trade as ClosedPosition) : null;
  const digits = trade ? getPipDigits(trade.symbolName) : 2;

  const isDirty1h = Boolean(
    trade?.oneHourScreenshot &&
      trade?.entryScreenshot &&
      trade.oneHourScreenshot === trade.entryScreenshot &&
      trade?.entryTimeframe === "1h",
  );
  const isDirty4h = Boolean(
    trade?.fourHourScreenshot &&
    trade?.entryScreenshot &&
    trade.fourHourScreenshot === trade.entryScreenshot &&
    trade?.entryTimeframe === "4h",
  );
  const isDirtyDaily = Boolean(
    trade?.dailyScreenshot &&
    trade?.entryScreenshot &&
    trade.dailyScreenshot === trade.entryScreenshot &&
    trade?.entryTimeframe === "1d",
  );

  const initial1h = isDirty1h ? undefined : trade?.oneHourScreenshot;
  const initial4h = isDirty4h ? undefined : trade?.fourHourScreenshot;
  const initialDaily = isDirtyDaily ? undefined : trade?.dailyScreenshot;
  const entryScreenshot = trade?.entryScreenshot;
  const entryTf = trade?.entryTimeframe || "Timeframe";
  const showEntryTab = Boolean(
    entryScreenshot && entryTf !== "1h" && entryTf !== "4h" && entryTf !== "1d",
  );

  // If a trade has identical 4h and daily screenshots (legacy bug), repair it:
  const isDuplicate = Boolean(
    initial4h && initialDaily && initial4h === initialDaily,
  );
  const safeInitial4h =
    isDuplicate && trade?.entryTimeframe === "1d" ? undefined : initial4h;
  const safeInitialDaily =
    isDuplicate && trade?.entryTimeframe === "4h" ? undefined : initialDaily;

  const [oneHourScreenshot, setOneHourScreenshot] = useState<string | undefined>(initial1h);
  const [fourHourScreenshot, setFourHourScreenshot] = useState<string | undefined>(safeInitial4h);
  const [dailyScreenshot, setDailyScreenshot] = useState<string | undefined>(safeInitialDaily);
  const [isGenerating1h, setIsGenerating1h] = useState(false);
  const [isGenerating4h, setIsGenerating4h] = useState(false);
  const [isGeneratingDaily, setIsGeneratingDaily] = useState(false);

  // Trade Notes state
  const [notes, setNotes] = useState(trade?.notes || "");
  const [isEditingNotes, setIsEditingNotes] = useState(false);
  const [isSavingNotes, setIsSavingNotes] = useState(false);
  const [savedSuccess, setSavedSuccess] = useState(false);

  const [activeTab, setActiveTab] = useState<"1h" | "4h" | "daily" | "entry">(() => {
    if (initial1h) return "1h";
    if (safeInitial4h) return "4h";
    if (safeInitialDaily) return "daily";
    return "1h";
  });
  const [isZoomed, setIsZoomed] = useState(false);

  const activeTradeIdRef = useRef<string | undefined>(trade?.id);
  activeTradeIdRef.current = trade?.id;
  const saveNoticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (saveNoticeTimerRef.current) {
        clearTimeout(saveNoticeTimerRef.current);
        saveNoticeTimerRef.current = null;
      }
    };
  }, []);

  // Synchronize and auto-generate missing charts on-the-fly without disturbing live UI
  useEffect(() => {
    setIsEditingNotes(false);
    setSavedSuccess(false);
    setIsSavingNotes(false);
    setIsGenerating1h(false);
    setIsGenerating4h(false);
    setIsGeneratingDaily(false);
    setActiveTab((prev) => (prev === "entry" && !showEntryTab ? "1h" : prev));
    if (saveNoticeTimerRef.current) {
      clearTimeout(saveNoticeTimerRef.current);
      saveNoticeTimerRef.current = null;
    }

    if (!trade) return;

    let cancelled = false;
    const targetTradeId = trade.id;

    const dirty1h = Boolean(
      trade.entryTimeframe === "1h" &&
        trade.oneHourScreenshot &&
        trade.entryScreenshot &&
        trade.oneHourScreenshot === trade.entryScreenshot,
    );
    const dirty4h = Boolean(
      trade.entryTimeframe === "4h" &&
      trade.fourHourScreenshot &&
      trade.entryScreenshot &&
      trade.fourHourScreenshot === trade.entryScreenshot,
    );
    const dirtyDaily = Boolean(
      trade.entryTimeframe === "1d" &&
      trade.dailyScreenshot &&
      trade.entryScreenshot &&
      trade.dailyScreenshot === trade.entryScreenshot,
    );

    const cur1h = dirty1h ? undefined : trade.oneHourScreenshot;
    let cur4h = dirty4h ? undefined : trade.fourHourScreenshot;
    let curDaily = dirtyDaily ? undefined : trade.dailyScreenshot;

    // If identical, repair the non-entry chart
    if (cur4h && curDaily && cur4h === curDaily) {
      if (trade.entryTimeframe === "1d") {
        cur4h = undefined;
      } else {
        curDaily = undefined;
      }
    }

    setOneHourScreenshot(cur1h);
    setFourHourScreenshot(cur4h);
    setDailyScreenshot(curDaily);
    setNotes(trade.notes || "");

    const isDark =
      typeof document !== "undefined" &&
      (document.documentElement.classList.contains("dark") ||
        !document.documentElement.classList.contains("light"));

    const tradeTimeSec = parseTradeTimestampSec(trade.openedAt);

    // Automatically generate missing 1H chart cleanly offscreen
    if (!cur1h) {
      setIsGenerating1h(true);
      captureOneHourChart(trade.symbolName, isDark, tradeTimeSec)
        .then((res) => {
          if (res) {
            api.updateTradeScreenshot?.(targetTradeId, "1h", res);
            if (!cancelled && activeTradeIdRef.current === targetTradeId) {
              setOneHourScreenshot(res);
            }
          }
        })
        .catch((err) => console.warn("[TradeScreenshotsModal] Failed 1h capture:", err))
        .finally(() => {
          if (!cancelled && activeTradeIdRef.current === targetTradeId) {
            setIsGenerating1h(false);
          }
        });
    }

    // Automatically generate missing 4H chart cleanly offscreen
    if (!cur4h) {
      setIsGenerating4h(true);
      captureFourHourChart(trade.symbolName, isDark, tradeTimeSec)
        .then((res) => {
          if (res) {
            api.updateTradeScreenshot?.(targetTradeId, "4h", res);
            if (!cancelled && activeTradeIdRef.current === targetTradeId) {
              setFourHourScreenshot(res);
            }
          }
        })
        .catch((err) => console.warn("[TradeScreenshotsModal] Failed 4h capture:", err))
        .finally(() => {
          if (!cancelled && activeTradeIdRef.current === targetTradeId) {
            setIsGenerating4h(false);
          }
        });
    }

    // Automatically generate missing Daily chart cleanly offscreen
    if (!curDaily) {
      setIsGeneratingDaily(true);
      captureDailyChart(trade.symbolName, isDark, tradeTimeSec)
        .then((res) => {
          if (res) {
            api.updateTradeScreenshot?.(targetTradeId, "daily", res);
            if (!cancelled && activeTradeIdRef.current === targetTradeId) {
              setDailyScreenshot(res);
            }
          }
        })
        .catch((err) => console.warn("[TradeScreenshotsModal] Failed daily capture:", err))
        .finally(() => {
          if (!cancelled && activeTradeIdRef.current === targetTradeId) {
            setIsGeneratingDaily(false);
          }
        });
    }

    return () => {
      cancelled = true;
    };
  }, [trade?.id, trade?.symbolName]);

  const handleGenerateCurrent = () => {
    if (!trade) return;
    const targetTradeId = trade.id;
    const isDark =
      typeof document !== "undefined" &&
      (document.documentElement.classList.contains("dark") ||
        !document.documentElement.classList.contains("light"));

    const tradeTimeSec = parseTradeTimestampSec(trade.openedAt);

    if (activeTab === "1h") {
      setIsGenerating1h(true);
      captureOneHourChart(trade.symbolName, isDark, tradeTimeSec)
        .then((res) => {
          if (res) {
            api.updateTradeScreenshot?.(targetTradeId, "1h", res);
            if (activeTradeIdRef.current === targetTradeId) {
              (trade as { oneHourScreenshot?: string }).oneHourScreenshot = res;
              setOneHourScreenshot(res);
            }
          }
        })
        .catch((err) => console.warn("[TradeScreenshotsModal] Failed manual 1h capture:", err))
        .finally(() => {
          if (activeTradeIdRef.current === targetTradeId) {
            setIsGenerating1h(false);
          }
        });
    } else if (activeTab === "4h") {
      setIsGenerating4h(true);
      captureFourHourChart(trade.symbolName, isDark, tradeTimeSec)
        .then((res) => {
          if (res) {
            api.updateTradeScreenshot?.(targetTradeId, "4h", res);
            if (activeTradeIdRef.current === targetTradeId) {
              (trade as { fourHourScreenshot?: string }).fourHourScreenshot = res;
              setFourHourScreenshot(res);
            }
          }
        })
        .catch((err) => console.warn("[TradeScreenshotsModal] Failed manual 4h capture:", err))
        .finally(() => {
          if (activeTradeIdRef.current === targetTradeId) {
            setIsGenerating4h(false);
          }
        });
    } else if (activeTab === "daily") {
      setIsGeneratingDaily(true);
      captureDailyChart(trade.symbolName, isDark, tradeTimeSec)
        .then((res) => {
          if (res) {
            api.updateTradeScreenshot?.(targetTradeId, "daily", res);
            if (activeTradeIdRef.current === targetTradeId) {
              (trade as { dailyScreenshot?: string }).dailyScreenshot = res;
              setDailyScreenshot(res);
            }
          }
        })
        .catch((err) => console.warn("[TradeScreenshotsModal] Failed manual daily capture:", err))
        .finally(() => {
          if (activeTradeIdRef.current === targetTradeId) {
            setIsGeneratingDaily(false);
          }
        });
    }
  };

  const handleSaveNotes = async () => {
    if (!trade) return;
    const targetTradeId = trade.id;
    setIsSavingNotes(true);
    try {
      await api.updateTradeNotes?.(targetTradeId, notes);
      if (activeTradeIdRef.current !== targetTradeId) return;
      setSavedSuccess(true);
      setIsEditingNotes(false);
      if (saveNoticeTimerRef.current) clearTimeout(saveNoticeTimerRef.current);
      saveNoticeTimerRef.current = setTimeout(() => {
        setSavedSuccess(false);
        saveNoticeTimerRef.current = null;
      }, 2000);
    } catch (err) {
      console.warn("[TradeScreenshotsModal] Failed saving notes:", err);
    } finally {
      if (activeTradeIdRef.current === targetTradeId) {
        setIsSavingNotes(false);
      }
    }
  };

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (isZoomed) {
          setIsZoomed(false);
        } else {
          onClose();
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose, isZoomed]);

  if (!trade) return null;

  const currentImage =
    activeTab === "1h"
      ? oneHourScreenshot
      : activeTab === "4h"
        ? fourHourScreenshot
        : activeTab === "daily"
          ? dailyScreenshot
          : entryScreenshot;

  const isCurrentGenerating =
    activeTab === "1h"
      ? isGenerating1h
      : activeTab === "4h"
        ? isGenerating4h
        : activeTab === "daily"
          ? isGeneratingDaily
          : false;

  const handleDownload = () => {
    if (!currentImage) return;
    const link = document.createElement("a");
    link.href = currentImage;
    link.download = `openchart_${trade.symbolName}_${trade.id}_${activeTab.toUpperCase()}.png`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const isLong = trade.side === "LONG" || trade.side === "BUY";
  const gross = closedTrade?.realizedPnl ?? 0;
  const comm = closedTrade?.commission ?? 0;
  const net = (closedTrade as { netPnl?: number } | null)?.netPnl ?? gross - comm;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-2 sm:p-4 bg-black/80 backdrop-blur-sm animate-in fade-in duration-150"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className={cn(
          "bg-card border border-border rounded-xl shadow-2xl flex flex-col overflow-hidden transition-all duration-200",
          isZoomed
            ? "w-[98vw] h-[96vh] max-w-none"
            : "w-[94vw] max-w-6xl max-h-[94vh]",
        )}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-card/90">
          <div className="flex items-center gap-2.5 flex-wrap">
            <div className="p-1.5 rounded-md bg-primary/10 text-primary">
              <Camera className="w-4 h-4" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="font-bold text-sm tracking-wide text-foreground">
                  {trade.symbolName}
                </span>
                <span
                  className={cn(
                    "px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase flex items-center gap-0.5",
                    isLong
                      ? "bg-buy/20 text-buy border border-buy/30"
                      : "bg-sell/20 text-sell border border-sell/30",
                  )}
                >
                  {isLong ? (
                    <TrendingUp className="w-3 h-3" />
                  ) : (
                    <TrendingDown className="w-3 h-3" />
                  )}
                  {trade.side}
                </span>
                <span className="text-xs font-mono text-muted-foreground">
                  {formatAssetUnits(trade.quantity, trade.symbolName)}
                </span>
                {closedTrade && (
                  <span
                    className={cn(
                      "px-2 py-0.5 rounded text-[11px] font-mono font-bold ml-1",
                      pnlClass(net),
                    )}
                  >
                    {net >= 0 ? "+" : ""}${net.toFixed(2)}
                  </span>
                )}
                {closedTrade?.exitReason && (
                  <span className="px-1.5 py-0.5 rounded bg-secondary text-muted-foreground text-[10px] font-medium uppercase">
                    {closedTrade.exitReason}
                  </span>
                )}
              </div>
              <div className="text-[11px] text-muted-foreground font-mono flex items-center gap-3 mt-0.5">
                <span>
                  Entrada:{" "}
                  <strong className="text-foreground">
                    {formatNumber(trade.entryPrice, digits)}
                  </strong>
                </span>
                {closedTrade?.exitPrice && (
                  <span>
                    Salida:{" "}
                    <strong className="text-foreground">
                      {formatNumber(closedTrade.exitPrice, digits)}
                    </strong>
                  </span>
                )}
                <span>
                  Apertura: {formatDate(trade.openedAt)}
                </span>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => setIsZoomed(!isZoomed)}
              title={isZoomed ? "Reducir tamaño" : "Pantalla completa"}
              className="p-1.5 rounded-md hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors"
            >
              {isZoomed ? (
                <Minimize2 className="w-4 h-4" />
              ) : (
                <Maximize2 className="w-4 h-4" />
              )}
            </button>
            <button
              type="button"
              onClick={onClose}
              title="Cerrar modal"
              className="p-1.5 rounded-md hover:bg-destructive/20 text-muted-foreground hover:text-destructive transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* ── Trade Notes / Journal Thesis Section ── */}
        <div className="px-4 py-2 border-b border-border/70 bg-secondary/30 flex items-start gap-2.5">
          <FileText className="w-4 h-4 text-primary shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] font-semibold text-primary uppercase tracking-wider flex items-center gap-1.5">
                <span>Motivo / Tesis del Trade</span>
                {savedSuccess && (
                  <span className="text-[10px] text-emerald-400 font-normal flex items-center gap-0.5">
                    <Check className="w-3 h-3" /> Guardado
                  </span>
                )}
              </span>
              {!isEditingNotes ? (
                <button
                  type="button"
                  onClick={() => setIsEditingNotes(true)}
                  className="text-[10px] text-muted-foreground hover:text-foreground underline transition-colors cursor-pointer"
                >
                  {notes ? "Editar nota" : "+ Añadir explicación del trade"}
                </button>
              ) : (
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={handleSaveNotes}
                    disabled={isSavingNotes}
                    className="flex items-center gap-1 px-2.5 py-0.5 rounded bg-primary text-primary-foreground text-[10px] font-medium hover:bg-primary/90 transition-colors disabled:opacity-50"
                  >
                    {isSavingNotes ? (
                      <Loader2 className="w-2.5 h-2.5 animate-spin" />
                    ) : (
                      <Save className="w-2.5 h-2.5" />
                    )}
                    <span>Guardar</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setNotes(trade.notes || "");
                      setIsEditingNotes(false);
                    }}
                    className="px-2 py-0.5 rounded text-[10px] text-muted-foreground hover:text-foreground"
                  >
                    Cancelar
                  </button>
                </div>
              )}
            </div>

            {isEditingNotes ? (
              <div className="mt-1.5">
                <textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Escribe por qué abriste la operación (ej: ruptura de rango con volumen en 15m, rebote en soporte 4H, divergencia RSI, etc.)..."
                  rows={2}
                  className="w-full bg-background border border-border rounded p-2 text-xs text-foreground focus:outline-none focus:border-primary resize-none font-sans"
                />
              </div>
            ) : notes ? (
              <p className="text-xs text-foreground mt-0.5 leading-relaxed font-sans font-normal">
                {notes}
              </p>
            ) : (
              <p className="text-[11px] text-muted-foreground/60 italic mt-0.5">
                Sin notas registradas para esta operación. Haz clic en "Añadir explicación" para documentar tu análisis.
              </p>
            )}
          </div>
        </div>

        {/* Sub-header / Tabs & Actions */}
        <div className="flex items-center justify-between px-4 py-2 border-b border-border/80 bg-secondary/40 text-xs flex-wrap gap-2">
          <div className="flex items-center gap-2 flex-wrap">
            <button
              type="button"
              onClick={() => setActiveTab("1h")}
              className={cn(
                "flex items-center gap-1.5 px-3 py-1.5 rounded-md font-medium transition-all shadow-sm",
                activeTab === "1h"
                  ? "bg-primary text-primary-foreground font-semibold"
                  : "bg-card text-muted-foreground hover:text-foreground hover:bg-card/80",
              )}
            >
              {isGenerating1h ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin text-primary" />
              ) : (
                <Clock className="w-3.5 h-3.5" />
              )}
              <span>Gráfico 1 Hora (1H)</span>
              {oneHourScreenshot && (
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 ml-1" />
              )}
            </button>

            <button
              type="button"
              onClick={() => setActiveTab("4h")}
              className={cn(
                "flex items-center gap-1.5 px-3 py-1.5 rounded-md font-medium transition-all shadow-sm",
                activeTab === "4h"
                  ? "bg-primary text-primary-foreground font-semibold"
                  : "bg-card text-muted-foreground hover:text-foreground hover:bg-card/80",
              )}
            >
              {isGenerating4h ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin text-primary" />
              ) : (
                <Clock className="w-3.5 h-3.5" />
              )}
              <span>Gráfico 4 Horas (4H)</span>
              {fourHourScreenshot && (
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 ml-1" />
              )}
            </button>

            <button
              type="button"
              onClick={() => setActiveTab("daily")}
              className={cn(
                "flex items-center gap-1.5 px-3 py-1.5 rounded-md font-medium transition-all shadow-sm",
                activeTab === "daily"
                  ? "bg-primary text-primary-foreground font-semibold"
                  : "bg-card text-muted-foreground hover:text-foreground hover:bg-card/80",
              )}
            >
              {isGeneratingDaily ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin text-primary" />
              ) : (
                <Calendar className="w-3.5 h-3.5" />
              )}
              <span>Gráfico Diario (1D)</span>
              {dailyScreenshot && (
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 ml-1" />
              )}
            </button>

            {showEntryTab && (
              <button
                type="button"
                onClick={() => setActiveTab("entry")}
                className={cn(
                  "flex items-center gap-1.5 px-3 py-1.5 rounded-md font-medium transition-all shadow-sm",
                  activeTab === "entry"
                    ? "bg-primary text-primary-foreground font-semibold"
                    : "bg-card text-muted-foreground hover:text-foreground hover:bg-card/80",
                )}
              >
                <Layers className="w-3.5 h-3.5" />
                <span>Gatillo de Entrada ({entryTf})</span>
                {entryScreenshot && (
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 ml-1" />
                )}
              </button>
            )}
          </div>

          <div className="flex items-center gap-2">
            {(activeTab === "1h" || activeTab === "4h" || activeTab === "daily") && (
              <button
                type="button"
                onClick={handleGenerateCurrent}
                disabled={isCurrentGenerating}
                title="Volver a generar gráfico limpio sin TP/SL en alta resolución"
                className="flex items-center gap-1.5 px-2.5 py-1 rounded bg-card hover:bg-secondary border border-border text-foreground text-[11px] transition-colors disabled:opacity-40"
              >
                <RefreshCw
                  className={cn("w-3 h-3 text-primary", isCurrentGenerating && "animate-spin")}
                />
                <span>Regenerar limpio</span>
              </button>
            )}
            <button
              type="button"
              onClick={handleDownload}
              disabled={!currentImage}
              title="Descargar imagen en alta resolución"
              className="flex items-center gap-1.5 px-2.5 py-1 rounded bg-card hover:bg-secondary border border-border text-foreground text-[11px] transition-colors disabled:opacity-40 disabled:pointer-events-none"
            >
              <Download className="w-3 h-3 text-primary" />
              <span>Descargar</span>
            </button>
          </div>
        </div>

        {/* Main Image Content */}
        <div className="flex-1 overflow-auto p-4 flex flex-col items-center justify-center bg-black/40 min-h-[300px]">
          {isCurrentGenerating ? (
            <div className="flex flex-col items-center justify-center text-center p-8 text-muted-foreground animate-pulse">
              <Loader2 className="w-8 h-8 text-primary animate-spin mb-3" />
              <p className="text-sm font-semibold text-foreground">
                {activeTab === "1h"
                  ? "Cargando gráfico de 1 Hora (1H)..."
                  : activeTab === "daily"
                    ? "Cargando gráfico Diario (1D)..."
                    : "Cargando gráfico de 4 Horas (4H)..."}
              </p>
              <p className="text-xs text-muted-foreground/80 mt-1 max-w-sm">
                Sincronizando velas y estructura técnica...
              </p>
            </div>
          ) : currentImage ? (
            <div className="relative max-w-full flex flex-col items-center group">
              <img
                src={currentImage}
                alt={`Captura ${trade.symbolName} ${activeTab}`}
                onClick={() => setIsZoomed(!isZoomed)}
                title="Haz clic para alternar pantalla completa"
                className={cn(
                  "max-w-full rounded-lg border border-border/80 shadow-2xl object-contain transition-all cursor-zoom-in select-none",
                  isZoomed ? "max-h-[84vh] cursor-zoom-out" : "max-h-[72vh]",
                )}
                style={{ imageRendering: "auto" }}
              />
              <div className="text-[11px] text-muted-foreground mt-2 flex items-center gap-1 text-center font-mono">
                <span>
                  {activeTab === "1h"
                    ? "Gráfico de 1 Hora (1H): Estructura táctica, timing intradía, volumen (MA 20) y RSI (14)"
                    : activeTab === "4h"
                      ? "Gráfico de 4 Horas (4H): Estructura intradía, soporte/resistencia, volumen (MA 20) y RSI (14)"
                      : activeTab === "daily"
                        ? "Gráfico Diario (1D): Contexto macroestructural y dirección de la tendencia principal"
                        : `Gatillo de entrada en marco temporal de ejecución (${entryTf}) con precio e indicadores activos`}
                </span>
              </div>
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center text-center p-8 text-muted-foreground">
              <AlertCircle className="w-8 h-8 text-muted-foreground/60 mb-2" />
              <p className="text-sm font-medium">Captura no disponible para esta vista</p>
              <p className="text-xs text-muted-foreground/80 mt-1 max-w-sm">
                Las operaciones capturan automáticamente el gráfico de 1 Hora (1H), 4 Horas (4H) y Diario (1D) al abrir la operación.
              </p>
              <button
                type="button"
                onClick={handleGenerateCurrent}
                disabled={isCurrentGenerating}
                className="mt-3.5 flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-primary text-primary-foreground text-xs font-semibold hover:bg-primary/90 transition-colors shadow-sm cursor-pointer disabled:opacity-50"
              >
                <Camera className="w-3.5 h-3.5" />
                <span>
                  Generar gráfico{" "}
                  {activeTab === "1h"
                    ? "de 1 Hora (1H)"
                    : activeTab === "daily"
                      ? "Diario (1D)"
                      : "de 4 Horas (4H)"}{" "}
                  ahora
                </span>
              </button>
            </div>
          )}
        </div>

        {/* Footer / Educational Tip */}
        <div className="px-4 py-2.5 border-t border-border bg-card/90 flex items-center justify-between gap-4 text-[11px] text-muted-foreground">
          <div className="flex items-center gap-2 overflow-hidden text-ellipsis whitespace-nowrap">
            <span className="font-semibold text-primary">💡 Análisis Post-Trade:</span>
            <span>
              Revisa las 3 temporalidades guardadas (1H, 4H y Diario 1D) para evaluar tu alineación multi-timeframe.
            </span>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1 rounded bg-secondary hover:bg-secondary/80 text-foreground text-xs font-medium shrink-0 cursor-pointer"
          >
            Cerrar
          </button>
        </div>
      </div>
    </div>
  );
}

