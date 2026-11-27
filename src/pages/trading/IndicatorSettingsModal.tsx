import { Plus, RotateCcw, Settings2, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";
import {
  EMA_COLOR_PALETTE,
  resetIndicatorSettings,
  updateIndicatorSettings,
  useIndicatorSettings,
  type EmaLineConfig,
  type VwapAnchorSetting,
  type VwapBandConfig,
  type VwapBandLineStyle,
} from "../../hooks/useIndicatorSettings.ts";
import type { IndicatorType, VwapPriceSource } from "../../lib/indicators.ts";
import { cn } from "../../lib/utils.ts";

export type ConfigurableIndicatorKind = "EMA" | "VWAP" | "VPVR" | "SMC";

export interface IndicatorSettingsModalProps {
  open: boolean;
  initialKind: ConfigurableIndicatorKind;
  onClose: () => void;
  activeIndicators: IndicatorType[];
  onToggleIndicator: (type: IndicatorType) => void;
}

function ToggleRow({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <label className="flex items-center justify-between gap-3 py-1.5 cursor-pointer">
      <div className="min-w-0">
        <div className="text-xs font-medium text-foreground">{label}</div>
        {hint && <div className="text-[10px] text-muted-foreground">{hint}</div>}
      </div>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-4 w-4 accent-primary cursor-pointer shrink-0"
      />
    </label>
  );
}

function SliderRow({
  label,
  value,
  min,
  max,
  step = 1,
  suffix = "",
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  suffix?: string;
  onChange: (val: number) => void;
}) {
  return (
    <div className="space-y-1 py-1">
      <div className="flex items-center justify-between text-xs">
        <span className="text-foreground font-medium">{label}</span>
        <span className="font-mono font-bold text-primary tabular-nums">
          {value}
          {suffix}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-primary cursor-pointer"
      />
    </div>
  );
}

const EMA_QUICK_PRESETS = [8, 9, 20, 21, 50, 100, 200] as const;

const VWAP_ANCHOR_OPTIONS: Array<{ id: VwapAnchorSetting; label: string }> = [
  { id: "auto", label: "Auto" },
  { id: "session", label: "Sesión" },
  { id: "week", label: "Semana" },
  { id: "month", label: "Mes" },
  { id: "year", label: "Año" },
  { id: "none", label: "Sin reinicio" },
];

const VWAP_SOURCE_OPTIONS: Array<{ id: VwapPriceSource; label: string }> = [
  { id: "hlc3", label: "HLC3" },
  { id: "hl2", label: "HL2" },
  { id: "ohlc4", label: "OHLC4" },
  { id: "close", label: "Cierre" },
];

function VwapBandRow({
  label,
  band,
  onUpdate,
}: {
  label: string;
  band: VwapBandConfig;
  onUpdate: (patch: Partial<VwapBandConfig>) => void;
}) {
  const [multDraft, setMultDraft] = useState(String(band.multiplier));

  useEffect(() => {
    setMultDraft(String(band.multiplier));
  }, [band.multiplier]);

  const commitDraft = (raw: string) => {
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed < 0.1) {
      setMultDraft(String(band.multiplier));
      return;
    }
    const clamped = Math.round(Math.max(0.1, Math.min(10, parsed)) * 100) / 100;
    setMultDraft(String(clamped));
    if (clamped !== band.multiplier) {
      onUpdate({ multiplier: clamped });
    }
  };

  return (
    <div className="flex items-center gap-1.5 rounded-lg border border-border/70 bg-secondary/25 px-2.5 py-1.5">
      <input
        type="checkbox"
        checked={band.enabled}
        onChange={(e) => onUpdate({ enabled: e.target.checked })}
        aria-label={`Activar ${label}`}
        title={band.enabled ? `Desactivar ${label}` : `Activar ${label}`}
        className="h-3.5 w-3.5 accent-primary cursor-pointer shrink-0"
      />
      <input
        type="color"
        value={band.color}
        onChange={(e) => onUpdate({ color: e.target.value })}
        aria-label={`Color de ${label}`}
        title={`Color de ${label}`}
        className="h-6 w-7 cursor-pointer rounded border border-border bg-transparent p-0.5 shrink-0"
      />
      <span className="text-[11px] font-semibold text-muted-foreground shrink-0">{label}</span>
      <div className="flex items-center gap-0.5 ml-auto">
        <span className="text-[11px] font-mono text-muted-foreground">±</span>
        <input
          type="number"
          min={0.1}
          max={10}
          step={0.1}
          value={multDraft}
          onChange={(e) => {
            const val = e.target.value;
            setMultDraft(val);
            const n = Number(val);
            if (val.trim() !== "" && Number.isFinite(n) && n >= 0.1 && n <= 10) {
              onUpdate({ multiplier: Math.round(n * 100) / 100 });
            }
          }}
          onBlur={(e) => commitDraft(e.target.value)}
          aria-label={`Multiplicador de ${label}`}
          className="w-14 px-1.5 py-1 rounded bg-background border border-border text-xs font-mono font-bold text-foreground focus:border-primary outline-none"
        />
        <span className="text-[11px] font-mono text-muted-foreground mr-1">σ</span>
      </div>
      <select
        value={band.lineStyle}
        onChange={(e) => onUpdate({ lineStyle: e.target.value as VwapBandLineStyle })}
        aria-label={`Estilo de línea de ${label}`}
        className="px-1.5 py-1 rounded bg-background border border-border text-[11px] font-medium text-foreground focus:border-primary outline-none"
      >
        <option value="solid">Sólida</option>
        <option value="dashed">Discontinua</option>
        <option value="dotted">Punteada</option>
      </select>
      <select
        value={band.lineWidth}
        onChange={(e) => onUpdate({ lineWidth: Number(e.target.value) })}
        aria-label={`Grosor de ${label}`}
        className="px-1 py-1 rounded bg-background border border-border text-[11px] font-mono text-foreground focus:border-primary outline-none"
      >
        <option value={1}>1px</option>
        <option value={2}>2px</option>
        <option value={3}>3px</option>
        <option value={4}>4px</option>
      </select>
    </div>
  );
}

function nextUnusedEmaColor(lines: EmaLineConfig[]): string {
  const used = new Set(lines.map((l) => l.color.toLowerCase()));
  const free = EMA_COLOR_PALETTE.find((c) => !used.has(c.toLowerCase()));
  return free ?? EMA_COLOR_PALETTE[lines.length % EMA_COLOR_PALETTE.length]!;
}

function EmaLineRow({
  line,
  canDelete,
  onUpdate,
  onRemove,
}: {
  line: EmaLineConfig;
  canDelete: boolean;
  onUpdate: (patch: Partial<EmaLineConfig>) => void;
  onRemove: () => void;
}) {
  const [periodDraft, setPeriodDraft] = useState(String(line.period));

  useEffect(() => {
    setPeriodDraft(String(line.period));
  }, [line.period]);

  const commitDraft = (raw: string) => {
    const parsed = Math.round(Number(raw));
    if (!Number.isFinite(parsed) || parsed < 1) {
      setPeriodDraft(String(line.period));
      return;
    }
    const clamped = Math.max(1, Math.min(500, parsed));
    setPeriodDraft(String(clamped));
    if (clamped !== line.period) {
      onUpdate({ period: clamped });
    }
  };

  return (
    <div className="flex items-center gap-2 rounded-lg border border-border/70 bg-secondary/25 px-2.5 py-1.5">
      <input
        type="checkbox"
        checked={line.enabled}
        onChange={(e) => onUpdate({ enabled: e.target.checked })}
        title={line.enabled ? "Desactivar esta EMA" : "Activar esta EMA"}
        className="h-3.5 w-3.5 accent-primary cursor-pointer shrink-0"
      />
      <input
        type="color"
        value={line.color}
        onChange={(e) => onUpdate({ color: e.target.value })}
        title="Color de la línea EMA"
        className="h-6 w-7 cursor-pointer rounded border border-border bg-transparent p-0.5 shrink-0"
      />
      <span className="text-xs font-semibold text-muted-foreground shrink-0">EMA</span>
      <input
        type="number"
        min={1}
        max={500}
        value={periodDraft}
        onChange={(e) => {
          const val = e.target.value;
          setPeriodDraft(val);
          const n = Math.round(Number(val));
          if (val.trim() !== "" && Number.isFinite(n) && n >= 1 && n <= 500) {
            onUpdate({ period: n });
          }
        }}
        onBlur={(e) => commitDraft(e.target.value)}
        aria-label={`Periodo de EMA ${line.period}`}
        className="w-16 px-2 py-1 rounded bg-background border border-border text-xs font-mono font-bold text-foreground focus:border-primary outline-none"
      />
      <select
        value={line.lineWidth}
        onChange={(e) => onUpdate({ lineWidth: Number(e.target.value) })}
        title="Grosor de línea"
        className="px-1.5 py-1 rounded bg-background border border-border text-[11px] font-mono text-foreground outline-none shrink-0"
      >
        <option value={1}>1px</option>
        <option value={2}>2px</option>
        <option value={3}>3px</option>
        <option value={4}>4px</option>
      </select>
      <button
        type="button"
        onClick={onRemove}
        disabled={!canDelete}
        title={canDelete ? "Eliminar EMA" : "Debe quedar al menos 1 EMA"}
        className="ml-auto p-1 rounded text-muted-foreground hover:text-rose-400 hover:bg-secondary disabled:opacity-30 disabled:pointer-events-none shrink-0"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

export function IndicatorSettingsModal({
  open,
  initialKind,
  onClose,
  activeIndicators,
  onToggleIndicator,
}: IndicatorSettingsModalProps) {
  const [kind, setKind] = useState<ConfigurableIndicatorKind>(initialKind);
  const [newPeriodInput, setNewPeriodInput] = useState("20");
  const settings = useIndicatorSettings();

  useEffect(() => {
    if (open) setKind(initialKind);
  }, [open, initialKind]);

  if (!open) return null;

  const isEnabled = activeIndicators.includes(kind);

  const handleAddCustomPeriod = () => {
    const parsed = Math.round(Number(newPeriodInput));
    if (!Number.isFinite(parsed) || parsed < 1) return;
    const clamped = Math.max(1, Math.min(500, parsed));
    const lines = settings.ema.lines;
    const existing = lines.find((l) => l.period === clamped);
    if (existing) {
      updateIndicatorSettings({
        ema: {
          lines: lines.map((l) => (l.id === existing.id ? { ...l, enabled: true } : l)),
        },
      });
    } else if (lines.length < 8) {
      updateIndicatorSettings({
        ema: {
          lines: [
            ...lines,
            {
              id: `ema-${clamped}-${Date.now()}`,
              period: clamped,
              color: nextUnusedEmaColor(lines),
              enabled: true,
              lineWidth: 2,
            },
          ],
        },
      });
    }
  };

  return (
    <>
      <div className="fixed inset-0 z-[90] bg-black/55 backdrop-blur-sm" onClick={onClose} />
      <div className="fixed inset-0 z-[95] flex items-center justify-center p-4 pointer-events-none">
        <div
          className="pointer-events-auto w-full max-w-md rounded-xl border border-border bg-card shadow-2xl overflow-hidden"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-secondary/40">
            <div className="flex items-center gap-2">
              <Settings2 className="h-4 w-4 text-primary" />
              <h3 className="text-sm font-semibold">Configuración de Indicadores</h3>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="p-1 rounded hover:bg-secondary text-muted-foreground hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          {/* Indicator selector tabs */}
          <div className="flex gap-1 px-4 pt-3 border-b border-border/60 overflow-x-auto no-scrollbar">
            <button
              type="button"
              onClick={() => setKind("EMA")}
              className={cn(
                "px-3 py-1.5 text-xs font-semibold rounded-t-md border-b-2 transition-colors whitespace-nowrap",
                kind === "EMA"
                  ? "border-primary text-primary bg-primary/5"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              Medias Móviles (EMA)
            </button>
            <button
              type="button"
              onClick={() => setKind("VWAP")}
              className={cn(
                "px-3 py-1.5 text-xs font-semibold rounded-t-md border-b-2 transition-colors whitespace-nowrap",
                kind === "VWAP"
                  ? "border-primary text-primary bg-primary/5"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              VWAP
            </button>
            <button
              type="button"
              onClick={() => setKind("VPVR")}
              className={cn(
                "px-3 py-1.5 text-xs font-semibold rounded-t-md border-b-2 transition-colors whitespace-nowrap",
                kind === "VPVR"
                  ? "border-primary text-primary bg-primary/5"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              Perfil de Volumen (VPVR)
            </button>
            <button
              type="button"
              onClick={() => setKind("SMC")}
              className={cn(
                "px-3 py-1.5 text-xs font-semibold rounded-t-md border-b-2 transition-colors whitespace-nowrap",
                kind === "SMC"
                  ? "border-primary text-primary bg-primary/5"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              Estructura de Mercado (SMC)
            </button>
          </div>

          {/* Body */}
          <div className="px-4 py-3 space-y-3 max-h-[65vh] overflow-y-auto">
            {/* Active toggle */}
            <div className="flex items-center justify-between rounded-lg border border-border/70 bg-secondary/30 px-3 py-2">
              <div>
                <div className="text-xs font-semibold text-foreground">
                  {kind === "EMA"
                    ? "Medias Móviles Exponenciales (EMA)"
                    : kind === "VWAP"
                      ? "VWAP y Bandas (Upper / Lower Band)"
                      : kind === "VPVR"
                        ? "Perfil de Volumen (VPVR)"
                        : "Estructura de Mercado Automática (SMC)"}
                </div>
                <div className="text-[10px] text-muted-foreground">
                  {isEnabled ? "Visible en el gráfico principal" : "Desactivado actualmente"}
                </div>
              </div>
              <button
                type="button"
                onClick={() => onToggleIndicator(kind)}
                className={cn(
                  "px-2.5 py-1 rounded text-xs font-semibold transition-colors",
                  isEnabled
                    ? "bg-primary text-primary-foreground"
                    : "bg-secondary text-muted-foreground hover:text-foreground",
                )}
              >
                {isEnabled ? "Activo" : "Activar"}
              </button>
            </div>

            {kind === "EMA" ? (
              <div className="space-y-3">
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-medium text-foreground">Líneas EMA configuradas</span>
                    <span className="text-[10px] text-muted-foreground font-mono">
                      {settings.ema.lines.filter((l) => l.enabled).length} activas · máx. 8
                    </span>
                  </div>
                  <div className="space-y-1.5">
                    {settings.ema.lines.map((line) => (
                      <EmaLineRow
                        key={line.id}
                        line={line}
                        canDelete={settings.ema.lines.length > 1}
                        onUpdate={(patch) => {
                          const nextLines = settings.ema.lines.map((item) =>
                            item.id === line.id ? { ...item, ...patch } : item,
                          );
                          updateIndicatorSettings({ ema: { lines: nextLines } });
                        }}
                        onRemove={() => {
                          if (settings.ema.lines.length <= 1) return;
                          const nextLines = settings.ema.lines.filter(
                            (item) => item.id !== line.id,
                          );
                          updateIndicatorSettings({ ema: { lines: nextLines } });
                        }}
                      />
                    ))}
                  </div>
                </div>

                {/* Quick preset pills */}
                <div className="space-y-1.5 pt-1 border-t border-border/60">
                  <div className="text-xs font-medium text-foreground">
                    Periodos rápidos
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {EMA_QUICK_PRESETS.map((preset) => {
                      const existing = settings.ema.lines.find((l) => l.period === preset);
                      const isPresetEnabled = Boolean(existing?.enabled);
                      return (
                        <button
                          key={preset}
                          type="button"
                          onClick={() => {
                            const lines = settings.ema.lines;
                            if (existing) {
                              if (existing.enabled) {
                                const enabledCount = lines.filter((l) => l.enabled).length;
                                if (enabledCount <= 1) return;
                                updateIndicatorSettings({
                                  ema: {
                                    lines: lines.map((l) =>
                                      l.id === existing.id ? { ...l, enabled: false } : l,
                                    ),
                                  },
                                });
                              } else {
                                updateIndicatorSettings({
                                  ema: {
                                    lines: lines.map((l) =>
                                      l.id === existing.id ? { ...l, enabled: true } : l,
                                    ),
                                  },
                                });
                              }
                            } else if (lines.length < 8) {
                              updateIndicatorSettings({
                                ema: {
                                  lines: [
                                    ...lines,
                                    {
                                      id: `ema-${preset}-${Date.now()}`,
                                      period: preset,
                                      color: nextUnusedEmaColor(lines),
                                      enabled: true,
                                      lineWidth: 2,
                                    },
                                  ],
                                },
                              });
                            }
                          }}
                          className={cn(
                            "px-2.5 py-1 rounded text-xs font-mono font-semibold border transition-colors",
                            isPresetEnabled
                              ? "border-primary bg-primary/15 text-primary"
                              : "border-border bg-secondary/60 text-muted-foreground hover:text-foreground hover:bg-secondary",
                          )}
                        >
                          EMA {preset}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Add custom period */}
                <div className="space-y-1.5 pt-1 border-t border-border/60">
                  <div className="text-xs font-medium text-foreground">
                    Añadir periodo personalizado (1–500)
                  </div>
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      min={1}
                      max={500}
                      value={newPeriodInput}
                      onChange={(e) => setNewPeriodInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key !== "Enter") return;
                        e.preventDefault();
                        handleAddCustomPeriod();
                      }}
                      placeholder="Ej: 8, 21, 50, 200"
                      className="flex-1 px-2.5 py-1.5 rounded bg-background border border-border text-xs font-mono text-foreground focus:border-primary outline-none"
                    />
                    <button
                      type="button"
                      disabled={settings.ema.lines.length >= 8}
                      onClick={handleAddCustomPeriod}
                      className="inline-flex items-center gap-1 px-3 py-1.5 rounded text-xs font-semibold bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-40"
                    >
                      <Plus className="h-3.5 w-3.5" />
                      <span>Añadir</span>
                    </button>
                  </div>
                </div>
              </div>
            ) : kind === "VWAP" ? (
              <div className="space-y-3">
                {/* Main VWAP line */}
                <div className="flex items-center justify-between rounded-lg border border-border/70 bg-secondary/25 px-3 py-2">
                  <span className="text-xs font-medium text-foreground">Línea principal VWAP</span>
                  <div className="flex items-center gap-2">
                    <input
                      type="color"
                      value={settings.vwap.color}
                      onChange={(e) => updateIndicatorSettings({ vwap: { color: e.target.value } })}
                      aria-label="Color principal de VWAP"
                      className="h-6 w-7 cursor-pointer rounded border border-border bg-transparent p-0.5"
                    />
                    <select
                      value={settings.vwap.lineWidth}
                      onChange={(e) =>
                        updateIndicatorSettings({ vwap: { lineWidth: Number(e.target.value) } })
                      }
                      aria-label="Grosor de línea principal VWAP"
                      className="px-1.5 py-1 rounded bg-background border border-border text-[11px] font-mono text-foreground focus:border-primary outline-none"
                    >
                      <option value={1}>1px</option>
                      <option value={2}>2px</option>
                      <option value={3}>3px</option>
                      <option value={4}>4px</option>
                    </select>
                  </div>
                </div>

                {/* Anchor period */}
                <div className="space-y-1.5">
                  <div className="text-xs font-medium text-foreground">Anclaje (Reinicio)</div>
                  <div className="grid grid-cols-3 gap-1.5">
                    {VWAP_ANCHOR_OPTIONS.map((opt) => (
                      <button
                        key={opt.id}
                        type="button"
                        onClick={() => updateIndicatorSettings({ vwap: { anchor: opt.id } })}
                        className={cn(
                          "py-1.5 rounded text-xs font-medium border transition-colors",
                          settings.vwap.anchor === opt.id
                            ? "border-primary bg-primary/15 text-primary font-semibold"
                            : "border-border text-muted-foreground hover:bg-secondary",
                        )}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Price source */}
                <div className="space-y-1.5">
                  <div className="text-xs font-medium text-foreground">Fuente de precio</div>
                  <div className="grid grid-cols-4 gap-1.5">
                    {VWAP_SOURCE_OPTIONS.map((opt) => (
                      <button
                        key={opt.id}
                        type="button"
                        onClick={() => updateIndicatorSettings({ vwap: { source: opt.id } })}
                        className={cn(
                          "py-1.5 rounded text-xs font-mono font-medium border transition-colors",
                          settings.vwap.source === opt.id
                            ? "border-primary bg-primary/15 text-primary font-semibold"
                            : "border-border text-muted-foreground hover:bg-secondary",
                        )}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Upper & Lower Bands */}
                <div className="space-y-2 pt-1 border-t border-border/60">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-medium text-foreground">
                      Bandas (Upper / Lower Band)
                    </span>
                    <div className="flex items-center gap-1">
                      {(
                        [
                          { label: "Solo VWAP", b1: false, b2: false, b3: false },
                          { label: "±1σ", b1: true, b2: false, b3: false },
                          { label: "±1σ / ±2σ", b1: true, b2: true, b3: false },
                          { label: "±1σ..±3σ", b1: true, b2: true, b3: true },
                        ] as const
                      ).map((preset) => {
                        const active =
                          settings.vwap.band1.enabled === preset.b1 &&
                          settings.vwap.band2.enabled === preset.b2 &&
                          settings.vwap.band3.enabled === preset.b3;
                        return (
                          <button
                            key={preset.label}
                            type="button"
                            onClick={() =>
                              updateIndicatorSettings({
                                vwap: {
                                  band1: { enabled: preset.b1 },
                                  band2: { enabled: preset.b2 },
                                  band3: { enabled: preset.b3 },
                                },
                              })
                            }
                            className={cn(
                              "px-1.5 py-0.5 rounded text-[10px] font-mono font-semibold border transition-colors",
                              active
                                ? "border-primary bg-primary/15 text-primary"
                                : "border-border bg-secondary/60 text-muted-foreground hover:text-foreground",
                            )}
                          >
                            {preset.label}
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  <div className="space-y-1.5">
                    <VwapBandRow
                      label="Banda #1"
                      band={settings.vwap.band1}
                      onUpdate={(patch) => updateIndicatorSettings({ vwap: { band1: patch } })}
                    />
                    <VwapBandRow
                      label="Banda #2"
                      band={settings.vwap.band2}
                      onUpdate={(patch) => updateIndicatorSettings({ vwap: { band2: patch } })}
                    />
                    <VwapBandRow
                      label="Banda #3"
                      band={settings.vwap.band3}
                      onUpdate={(patch) => updateIndicatorSettings({ vwap: { band3: patch } })}
                    />
                  </div>

                  <ToggleRow
                    label="Mostrar precios de bandas en el eje"
                    hint="Muestra los valores actuales de Upper y Lower Band en la columna derecha"
                    checked={settings.vwap.showBandLabels}
                    onChange={(showBandLabels) =>
                      updateIndicatorSettings({ vwap: { showBandLabels } })
                    }
                  />
                </div>
              </div>
            ) : kind === "VPVR" ? (
              <div className="space-y-2.5">
                <div className="space-y-1">
                  <div className="text-xs font-medium text-foreground">Rango de cálculo</div>
                  <div className="grid grid-cols-2 gap-1.5">
                    <button
                      type="button"
                      onClick={() => updateIndicatorSettings({ vpvr: { scope: "visible" } })}
                      className={cn(
                        "py-1.5 rounded text-xs font-medium border transition-colors",
                        settings.vpvr.scope === "visible"
                          ? "border-primary bg-primary/15 text-primary font-semibold"
                          : "border-border text-muted-foreground hover:bg-secondary",
                      )}
                    >
                      Rango visible
                    </button>
                    <button
                      type="button"
                      onClick={() => updateIndicatorSettings({ vpvr: { scope: "all" } })}
                      className={cn(
                        "py-1.5 rounded text-xs font-medium border transition-colors",
                        settings.vpvr.scope === "all"
                          ? "border-primary bg-primary/15 text-primary font-semibold"
                          : "border-border text-muted-foreground hover:bg-secondary",
                      )}
                    >
                      Todo el histórico
                    </button>
                  </div>
                </div>

                <SliderRow
                  label="Filas de precio (resolución)"
                  value={settings.vpvr.rows}
                  min={12}
                  max={100}
                  step={2}
                  onChange={(rows) => updateIndicatorSettings({ vpvr: { rows } })}
                />
                <SliderRow
                  label="Área de Valor (Value Area)"
                  value={settings.vpvr.valueAreaPct}
                  min={50}
                  max={90}
                  suffix="%"
                  onChange={(valueAreaPct) => updateIndicatorSettings({ vpvr: { valueAreaPct } })}
                />
                <SliderRow
                  label="Ancho máximo del perfil"
                  value={settings.vpvr.widthPct}
                  min={10}
                  max={45}
                  suffix="%"
                  onChange={(widthPct) => updateIndicatorSettings({ vpvr: { widthPct } })}
                />

                <div className="border-t border-border/60 pt-2 space-y-1">
                  <ToggleRow
                    label="Mostrar línea POC (Point of Control)"
                    hint="Nivel de precio con mayor volumen negociado"
                    checked={settings.vpvr.showPoc}
                    onChange={(showPoc) => updateIndicatorSettings({ vpvr: { showPoc } })}
                  />
                  <ToggleRow
                    label="Mostrar Value Area (VAH / VAL)"
                    hint="Límites superior e inferior del área de valor"
                    checked={settings.vpvr.showValueArea}
                    onChange={(showValueArea) =>
                      updateIndicatorSettings({ vpvr: { showValueArea } })
                    }
                  />
                  <ToggleRow
                    label="Dividir volumen Compra / Venta"
                    hint="Verde para velas alcistas y rojo para bajistas"
                    checked={settings.vpvr.showUpDown}
                    onChange={(showUpDown) => updateIndicatorSettings({ vpvr: { showUpDown } })}
                  />
                </div>
              </div>
            ) : (
              <div className="space-y-2.5">
                <div className="space-y-1">
                  <div className="text-xs font-medium text-foreground">
                    Estilo de máximos y mínimos
                  </div>
                  <div className="grid grid-cols-2 gap-1.5">
                    <button
                      type="button"
                      onClick={() => updateIndicatorSettings({ smc: { swingStyle: "dots" } })}
                      className={cn(
                        "py-1.5 rounded text-xs font-medium border transition-colors",
                        settings.smc.swingStyle === "dots"
                          ? "border-primary bg-primary/15 text-primary font-semibold"
                          : "border-border text-muted-foreground hover:bg-secondary",
                      )}
                    >
                      Círculos
                    </button>
                    <button
                      type="button"
                      onClick={() => updateIndicatorSettings({ smc: { swingStyle: "labels" } })}
                      className={cn(
                        "py-1.5 rounded text-xs font-medium border transition-colors",
                        settings.smc.swingStyle === "labels"
                          ? "border-primary bg-primary/15 text-primary font-semibold"
                          : "border-border text-muted-foreground hover:bg-secondary",
                      )}
                    >
                      Etiquetas (HH / HL / LH / LL)
                    </button>
                  </div>
                </div>

                <SliderRow
                  label="Sensibilidad de Swing (velas a cada lado)"
                  value={settings.smc.swingLength}
                  min={2}
                  max={20}
                  onChange={(swingLength) => updateIndicatorSettings({ smc: { swingLength } })}
                />
                <SliderRow
                  label="Tamaño de etiquetas"
                  value={settings.smc.labelSize}
                  min={10}
                  max={20}
                  suffix="px"
                  onChange={(labelSize) => updateIndicatorSettings({ smc: { labelSize } })}
                />
                <SliderRow
                  label="Máximo de quiebres BOS / CHoCH visibles"
                  value={settings.smc.maxBreaks}
                  min={1}
                  max={40}
                  onChange={(maxBreaks) => updateIndicatorSettings({ smc: { maxBreaks } })}
                />
                <SliderRow
                  label="Máximo de zonas FVG visibles"
                  value={settings.smc.maxFvgs}
                  min={1}
                  max={30}
                  onChange={(maxFvgs) => updateIndicatorSettings({ smc: { maxFvgs } })}
                />

                <div className="border-t border-border/60 pt-2 space-y-1">
                  <ToggleRow
                    label="Mostrar quiebres BOS y CHoCH"
                    hint="Break of Structure y Change of Character sin repintado"
                    checked={settings.smc.showBos}
                    onChange={(showBos) => updateIndicatorSettings({ smc: { showBos } })}
                  />
                  <ToggleRow
                    label="Mostrar puntos de Swing (máximos y mínimos)"
                    hint="Círculos en máximos y mínimos estructurales confirmados"
                    checked={settings.smc.showSwings}
                    onChange={(showSwings) => updateIndicatorSettings({ smc: { showSwings } })}
                  />
                  <ToggleRow
                    label="Mostrar Fair Value Gaps (FVG)"
                    hint="Desequilibrios de 3 velas"
                    checked={settings.smc.showFvg}
                    onChange={(showFvg) => updateIndicatorSettings({ smc: { showFvg } })}
                  />
                  <ToggleRow
                    label="Ocultar FVG ya mitigados"
                    hint="Limpia los huecos ya rellenados por el precio"
                    checked={settings.smc.hideMitigatedFvg}
                    onChange={(hideMitigatedFvg) =>
                      updateIndicatorSettings({ smc: { hideMitigatedFvg } })
                    }
                  />
                </div>
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="flex items-center justify-between px-4 py-3 border-t border-border bg-secondary/20">
            <button
              type="button"
              onClick={() =>
                resetIndicatorSettings(
                  kind === "EMA"
                    ? "ema"
                    : kind === "VWAP"
                      ? "vwap"
                      : kind === "VPVR"
                        ? "vpvr"
                        : "smc",
                )
              }
              className="flex items-center gap-1.5 px-2.5 py-1 rounded text-xs text-muted-foreground hover:text-foreground hover:bg-secondary"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              Restablecer
            </button>
            <button
              type="button"
              onClick={onClose}
              className="px-3.5 py-1 rounded text-xs font-semibold bg-primary text-primary-foreground hover:opacity-90"
            >
              Listo
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
