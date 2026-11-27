import { useState, useId, useEffect } from "react";
import {
  Play,
  Pause,
  SkipBack,
  SkipForward,
  Square,
  Rewind,
  X,
  Calendar,
  MousePointer2,
  CalendarDays,
} from "lucide-react";
import { cn } from "../../lib/utils.ts";
import {
  getLastReplayTimeSec,
  REPLAY_SPEEDS,
  useReplayStore,
} from "../../services/demo/replay.ts";
import { toast } from "../../services/toast.ts";
import {
  fetchHistoryAsync,
  getHistory,
  isReplayDataSynthetic,
} from "../../services/demo/candles.ts";

function formatReplayTimestamp(timeSec: number): string {
  const d = new Date(timeSec * 1000);
  return d.toLocaleString("es-ES", {
    month: "short",
    day: "2-digit",
    year: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function getIsoDateInput(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const y = date.getFullYear();
  const m = pad(date.getMonth() + 1);
  const d = pad(date.getDate());
  const hh = pad(date.getHours());
  const mm = pad(date.getMinutes());
  return `${y}-${m}-${d}T${hh}:${mm}`;
}

interface ReplayHUDProps {
  accountId?: string | null;
  symbol?: string;
  timeframe?: string;
}

export function ReplayHUD({ accountId: _accountId, symbol = "BTCUSD", timeframe = "1d" }: ReplayHUDProps) {
  const {
    phase,
    visible,
    cursor,
    total,
    playing,
    speed,
    finished,
    isTemporary,
    beginPick,
    cancelPick,
    start,
    play,
    pause,
    step,
    stepBack,
    setSpeed,
    stop,
  } = useReplayStore();

  const [showDatePicker, setShowDatePicker] = useState(false);
  const [loadingRemoteDate, setLoadingRemoteDate] = useState(false);
  const [selectedDateTime, setSelectedDateTime] = useState(() => {
    const saved = getLastReplayTimeSec(symbol);
    if (saved) return getIsoDateInput(new Date(saved * 1000));
    const bars = getHistory(symbol, timeframe);
    if (bars.length > 5) {
      const idx = Math.max(0, bars.length - 30);
      return getIsoDateInput(new Date(bars[idx]!.time * 1000));
    }
    return getIsoDateInput(new Date(Date.now() - 2 * 3600_000));
  });
  const dateInputId = useId();

  const lastBar = visible && visible.length > 0 ? visible[visible.length - 1] : null;
  const syntheticData = lastBar ? isReplayDataSynthetic(symbol, timeframe, lastBar.time) : false;

  useEffect(() => {
    if (showDatePicker) {
      const saved = getLastReplayTimeSec(symbol);
      if (saved) {
        setSelectedDateTime(getIsoDateInput(new Date(saved * 1000)));
      } else {
        const bars = getHistory(symbol, timeframe);
        if (bars.length > 5) {
          const idx = Math.max(0, bars.length - 30);
          setSelectedDateTime(getIsoDateInput(new Date(bars[idx]!.time * 1000)));
        }
      }
    }
  }, [showDatePicker, symbol, timeframe]);

  useEffect(() => {
    if (phase !== "active") return;
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) {
        return;
      }
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        stepBack();
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        step();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [phase, step, stepBack]);

  const handleLaunchAtDate = async (dateToUse?: string) => {
    const rawStr = dateToUse || selectedDateTime;
    const dateObj = new Date(rawStr);
    if (isNaN(dateObj.getTime())) {
      toast.error("Fecha inválida", "Por favor ingresa una fecha y hora válidas.");
      return;
    }

    const timeSec = Math.floor(dateObj.getTime() / 1000);
    if (isReplayDataSynthetic(symbol, timeframe, timeSec)) {
      const pad = (n: number) => String(n).padStart(2, "0");
      const targetDate = `${dateObj.getFullYear()}-${pad(dateObj.getMonth() + 1)}-${pad(dateObj.getDate())}`;
      setLoadingRemoteDate(true);
      try {
        const tfsToLoad = Array.from(new Set([timeframe, "1m", "3m", "5m"]));
        await Promise.all(
          tfsToLoad.map((tf) => fetchHistoryAsync(symbol, tf, 1_500, { targetDate }).catch(() => [])),
        );
      } finally {
        setLoadingRemoteDate(false);
      }
    }

    const res = start(symbol, timeframe, timeSec, { temporary: false });
    if (res.ok) {
      toast.success(
        "Replay Actualizado",
        `Posicionado en ${dateObj.toLocaleDateString("es-ES")} ${dateObj.toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" })}. Velas posteriores ocultas.`,
      );
      setShowDatePicker(false);
    } else {
      toast.warning("Replay", res.error);
    }
  };

  return (
    <>
      {/* ── Toolbar Bar Replay Controls ── */}
      {phase === "idle" && (
        <div className="flex items-center gap-1 shrink-0">
          <button
            type="button"
            onClick={() => setShowDatePicker(true)}
            title="Iniciar Replay eligiendo una fecha exacta del pasado o seleccionando en la gráfica"
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-md border border-border hover:border-primary/40 hover:bg-primary/10 text-muted-foreground hover:text-primary text-xs font-medium transition-colors"
          >
            <Rewind className="h-3.5 w-3.5 text-primary" />
            <span>Replay</span>
            <Calendar className="h-3 w-3 ml-0.5 opacity-70" />
          </button>
        </div>
      )}

      {phase === "picking" && (
        <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-[#2962FF]/15 border border-[#2962FF]/40 text-[#2962FF] text-xs font-medium shrink-0 animate-pulse">
          <MousePointer2 className="h-3.5 w-3.5" />
          <span>Haz clic en una vela para cortar aquí</span>
          <button
            type="button"
            onClick={() => {
              cancelPick();
              setShowDatePicker(true);
            }}
            title="O escribe una fecha exacta"
            className="ml-1 px-1.5 py-0.5 rounded bg-[#2962FF]/20 hover:bg-[#2962FF]/30 text-[11px] font-semibold flex items-center gap-1 transition-colors"
          >
            <Calendar className="h-3 w-3" />
            <span>Fecha exacta</span>
          </button>
          <button
            type="button"
            onClick={cancelPick}
            title="Cancelar selección de Replay"
            className="ml-0.5 p-0.5 rounded hover:bg-[#2962FF]/20 text-[#2962FF]"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {phase === "active" && (
        <div className="flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-orange-500/10 border border-orange-500/30 shrink-0">
          <span className="text-orange-500 text-[10px] font-bold tracking-wider uppercase hidden sm:inline">
            Replay
          </span>

          {isTemporary && (
            <span
              title="Replay temporal iniciado desde Trade History: tu fecha por defecto del botón Replay no cambiará aunque avances o salgas."
              className="px-1 rounded bg-primary/20 text-primary text-[9px] font-bold uppercase"
            >
              Temporal
            </span>
          )}

          {syntheticData && (
            <span
              title="Esta fecha queda fuera de las velas reales disponibles para esta temporalidad: las velas se reconstruyen a partir de una temporalidad mayor con trayectorias aleatorias. El cierre/máx/mín de la vela madre es real, pero los indicadores y el orden intravela NO son datos de mercado. Usa una fecha más reciente o una temporalidad mayor."
              className="px-1 rounded bg-red-500/20 text-red-400 text-[9px] font-bold uppercase"
            >
              Sintético
            </span>
          )}

          {lastBar && (
            <span className="text-[11px] font-mono text-orange-400 tabular-nums">
              {formatReplayTimestamp(lastBar.time)}
            </span>
          )}

          <span className="text-[10px] font-mono text-muted-foreground tabular-nums hidden md:inline">
            ({cursor + 1}/{total} · {timeframe})
          </span>

          {/* Pick / Cut on chart while inside Replay */}
          <button
            type="button"
            onClick={beginPick}
            title="Cortar en otra vela haciendo clic en el gráfico"
            className="p-1 rounded hover:bg-orange-500/20 text-orange-400"
          >
            <MousePointer2 className="h-3.5 w-3.5" />
          </button>

          {/* Jump to another date button */}
          <button
            type="button"
            onClick={() => setShowDatePicker(true)}
            title="Cambiar fecha exacta de Replay"
            className="p-1 rounded hover:bg-orange-500/20 text-orange-400"
          >
            <Calendar className="h-3.5 w-3.5" />
          </button>

          {/* Step Backward (-1 bar) */}
          <button
            type="button"
            onClick={stepBack}
            disabled={cursor <= 0}
            title="Retroceder 1 vela (Flecha Izquierda)"
            className="flex items-center gap-0.5 px-1.5 py-0.5 rounded hover:bg-orange-500/20 text-orange-400 text-[10px] font-medium disabled:opacity-40"
          >
            <SkipBack className="h-3.5 w-3.5" />
            <span className="hidden lg:inline">-1</span>
          </button>

          {/* Play / Pause */}
          {!playing ? (
            <button
              type="button"
              onClick={play}
              disabled={finished}
              title="Reproducir velas"
              className="p-1 rounded hover:bg-orange-500/20 text-orange-500 disabled:opacity-40"
            >
              <Play className="h-3.5 w-3.5 fill-current" />
            </button>
          ) : (
            <button
              type="button"
              onClick={pause}
              title="Pausar Replay"
              className="p-1 rounded hover:bg-orange-500/20 text-orange-500"
            >
              <Pause className="h-3.5 w-3.5 fill-current" />
            </button>
          )}

          {/* Step Forward (+1 bar) */}
          <button
            type="button"
            onClick={step}
            disabled={finished}
            title="Avanzar 1 vela (Flecha Derecha)"
            className="flex items-center gap-0.5 px-1.5 py-0.5 rounded hover:bg-orange-500/20 text-orange-400 text-[10px] font-medium disabled:opacity-40"
          >
            <SkipForward className="h-3.5 w-3.5" />
            <span className="hidden lg:inline">+1</span>
          </button>

          {/* Speed selector */}
          <div className="flex items-center gap-0.5">
            {REPLAY_SPEEDS.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setSpeed(s)}
                className={cn(
                  "px-1 py-0.5 rounded text-[10px] font-medium transition-all",
                  speed === s
                    ? "bg-orange-500 text-white"
                    : "text-muted-foreground hover:bg-orange-500/20 hover:text-orange-500",
                )}
              >
                {s}x
              </button>
            ))}
          </div>

          {/* Stop / Exit Replay */}
          <button
            type="button"
            onClick={stop}
            title="Salir del modo Replay y volver a tiempo real"
            className="flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-destructive/15 hover:bg-destructive/25 text-destructive text-[10px] font-semibold"
          >
            <Square className="h-3 w-3 fill-current" />
            <span className="hidden sm:inline">Salir</span>
          </button>
        </div>
      )}

      {/* ── Exact Date Picker Modal ── */}
      {showDatePicker && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-150"
          onClick={() => setShowDatePicker(false)}
        >
          <div
            className="w-full max-w-md bg-card border border-border rounded-xl shadow-2xl overflow-hidden animate-in zoom-in-95 duration-150"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Modal Header */}
            <div className="flex items-center justify-between px-5 py-3.5 border-b border-border bg-muted/30">
              <div className="flex items-center gap-2">
                <div className="p-1.5 rounded-lg bg-orange-500/15 text-orange-500">
                  <CalendarDays className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="text-sm font-bold text-foreground">Iniciar Replay en Fecha Exacta</h3>
                  <p className="text-[11px] text-muted-foreground">
                    Elige la fecha y hora para ocultar el futuro y simular el mercado
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setShowDatePicker(false)}
                className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Modal Body */}
            <div className="p-5 space-y-4">
              {/* Date Input */}
              <div className="p-3.5 rounded-lg border border-border bg-secondary/30 space-y-2">
                <div className="flex items-center justify-between">
                  <label htmlFor={dateInputId} className="text-xs font-semibold text-foreground flex items-center gap-1.5">
                    <Calendar className="w-3.5 h-3.5 text-primary" />
                    <span>Fecha y Hora de Inicio ({symbol} • {timeframe}):</span>
                  </label>
                  {getLastReplayTimeSec(symbol) && (
                    <span className="text-[10px] text-primary/90 font-medium">
                      (Recordada de tu última sesión)
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <input
                    id={dateInputId}
                    type="datetime-local"
                    value={selectedDateTime}
                    min="2011-08-18T00:00"
                    max={getIsoDateInput(new Date())}
                    onChange={(e) => setSelectedDateTime(e.target.value)}
                    className="flex-1 px-3 py-2 bg-background border border-border rounded-lg text-sm font-mono text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary"
                  />
                  <button
                    type="button"
                    disabled={loadingRemoteDate}
                    onClick={() => {
                      void handleLaunchAtDate();
                    }}
                    className="px-4 py-2 bg-primary text-primary-foreground font-semibold rounded-lg text-xs hover:bg-primary/90 active:scale-95 transition-all flex items-center gap-1.5 shadow-sm shrink-0 disabled:opacity-50"
                  >
                    <Play className="w-3.5 h-3.5 fill-current" />
                    <span>{loadingRemoteDate ? "Cargando IBKR..." : "Iniciar Aquí"}</span>
                  </button>
                </div>
              </div>

              {/* Or Click on Chart */}
              <div className="pt-2 border-t border-border flex items-center justify-between">
                <button
                  type="button"
                  onClick={() => {
                    setShowDatePicker(false);
                    beginPick();
                  }}
                  className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1.5 py-1 px-2 rounded hover:bg-muted transition-colors"
                >
                  <MousePointer2 className="w-3.5 h-3.5 text-primary" />
                  <span>Prefiero hacer clic directamente en la gráfica</span>
                </button>
                <button
                  type="button"
                  onClick={() => setShowDatePicker(false)}
                  className="px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground rounded border border-border hover:bg-muted transition-colors"
                >
                  Cancelar
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
