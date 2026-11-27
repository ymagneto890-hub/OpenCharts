import { useEffect, useState } from "react";
import type { VwapAnchorPeriod, VwapPriceSource } from "../lib/indicators.ts";

export interface VpvrSettings {
  scope: "visible" | "all";
  rows: number;
  valueAreaPct: number;
  widthPct: number;
  showPoc: boolean;
  showValueArea: boolean;
  showUpDown: boolean;
}

export interface SmcSettings {
  swingLength: number;
  labelSize: number;
  swingStyle: "dots" | "labels";
  showBos: boolean;
  showSwings: boolean;
  showFvg: boolean;
  hideMitigatedFvg: boolean;
  maxFvgs: number;
  maxBreaks: number;
}

export interface EmaLineConfig {
  id: string;
  period: number;
  color: string;
  enabled: boolean;
  lineWidth: number;
}

export interface EmaSettings {
  lines: EmaLineConfig[];
}

export type VwapAnchorSetting = "auto" | VwapAnchorPeriod;
export type VwapBandLineStyle = "solid" | "dashed" | "dotted";

export interface VwapBandConfig {
  enabled: boolean;
  multiplier: number;
  color: string;
  lineWidth: number;
  lineStyle: VwapBandLineStyle;
}

export interface VwapSettings {
  anchor: VwapAnchorSetting;
  source: VwapPriceSource;
  color: string;
  lineWidth: number;
  showBandLabels: boolean;
  band1: VwapBandConfig;
  band2: VwapBandConfig;
  band3: VwapBandConfig;
}

export type VwapSettingsPatch = Partial<
  Omit<VwapSettings, "band1" | "band2" | "band3"> & {
    band1: Partial<VwapBandConfig>;
    band2: Partial<VwapBandConfig>;
    band3: Partial<VwapBandConfig>;
  }
>;

export const EMA_COLOR_PALETTE = [
  "#f59e0b",
  "#2962ff",
  "#10b981",
  "#ec4899",
  "#a855f7",
  "#06b6d4",
  "#ef4444",
  "#84cc16",
] as const;

export interface IndicatorSettings {
  ema: EmaSettings;
  vwap: VwapSettings;
  vpvr: VpvrSettings;
  smc: SmcSettings;
}

export type IndicatorSettingsPatch = {
  ema?: Partial<EmaSettings>;
  vwap?: VwapSettingsPatch;
  vpvr?: Partial<VpvrSettings>;
  smc?: Partial<SmcSettings>;
};

const STORAGE_KEY = "oc_indicator_settings_v1";
const UPDATED_EVENT = "oc-indicator-settings-updated";

export const DEFAULT_INDICATOR_SETTINGS: IndicatorSettings = {
  ema: {
    lines: [
      { id: "ema-8", period: 8, color: "#f59e0b", enabled: true, lineWidth: 2 },
      { id: "ema-50", period: 50, color: "#2962ff", enabled: true, lineWidth: 2 },
    ],
  },
  vwap: {
    anchor: "auto",
    source: "hlc3",
    color: "#facc15",
    lineWidth: 2,
    showBandLabels: false,
    band1: { enabled: false, multiplier: 1, color: "#22c55e", lineWidth: 1, lineStyle: "dashed" },
    band2: { enabled: false, multiplier: 2, color: "#38bdf8", lineWidth: 1, lineStyle: "dashed" },
    band3: { enabled: false, multiplier: 3, color: "#f43f5e", lineWidth: 1, lineStyle: "dotted" },
  },
  vpvr: {
    scope: "visible",
    rows: 36,
    valueAreaPct: 70,
    widthPct: 22,
    showPoc: true,
    showValueArea: true,
    showUpDown: true,
  },
  smc: {
    swingLength: 5,
    labelSize: 13,
    swingStyle: "dots",
    showBos: true,
    showSwings: true,
    showFvg: true,
    hideMitigatedFvg: true,
    maxFvgs: 8,
    maxBreaks: 12,
  },
};

function clampNum(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function clampFloat(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  const clamped = Math.max(min, Math.min(max, n));
  return Math.round(clamped * 100) / 100;
}

const HEX_COLOR_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const VALID_VWAP_ANCHORS = new Set<VwapAnchorSetting>([
  "auto",
  "session",
  "week",
  "month",
  "year",
  "none",
]);
const VALID_VWAP_SOURCES = new Set<VwapPriceSource>(["hlc3", "hl2", "ohlc4", "close"]);
const VALID_BAND_STYLES = new Set<VwapBandLineStyle>(["solid", "dashed", "dotted"]);

function normalizeVwapBand(raw: unknown, def: VwapBandConfig): VwapBandConfig {
  const b = (raw && typeof raw === "object" ? raw : {}) as Partial<VwapBandConfig>;
  return {
    enabled: typeof b.enabled === "boolean" ? b.enabled : def.enabled,
    multiplier: clampFloat(b.multiplier, 0.1, 10, def.multiplier),
    color:
      typeof b.color === "string" && HEX_COLOR_RE.test(b.color.trim())
        ? b.color.trim()
        : def.color,
    lineWidth: clampNum(b.lineWidth, 1, 4, def.lineWidth),
    lineStyle:
      typeof b.lineStyle === "string" && VALID_BAND_STYLES.has(b.lineStyle as VwapBandLineStyle)
        ? (b.lineStyle as VwapBandLineStyle)
        : def.lineStyle,
  };
}

function cloneVwapDefaults(): VwapSettings {
  const dw = DEFAULT_INDICATOR_SETTINGS.vwap;
  return {
    ...dw,
    band1: { ...dw.band1 },
    band2: { ...dw.band2 },
    band3: { ...dw.band3 },
  };
}

function normalizeSettings(raw: unknown): IndicatorSettings {
  const obj = (raw && typeof raw === "object" ? raw : {}) as {
    ema?: Partial<EmaSettings>;
    vwap?: VwapSettingsPatch;
    vpvr?: Partial<VpvrSettings>;
    smc?: Partial<SmcSettings>;
  };
  const e = obj.ema ?? {};
  const w = obj.vwap ?? {};
  const v = obj.vpvr ?? {};
  const s = obj.smc ?? {};
  const de = DEFAULT_INDICATOR_SETTINGS.ema;
  const dw = DEFAULT_INDICATOR_SETTINGS.vwap;
  const dv = DEFAULT_INDICATOR_SETTINGS.vpvr;
  const ds = DEFAULT_INDICATOR_SETTINGS.smc;

  const rawLines = Array.isArray(e.lines) ? e.lines : [];
  const normalizedLines: EmaLineConfig[] = rawLines
    .slice(0, 8)
    .map((item, idx) => {
      const rec = (item && typeof item === "object" ? item : {}) as Partial<EmaLineConfig>;
      const period = clampNum(rec.period, 1, 500, idx === 0 ? 8 : 50);
      const id =
        typeof rec.id === "string" && rec.id.trim().length > 0
          ? rec.id.trim()
          : `ema-${period}-${idx}`;
      const color =
        typeof rec.color === "string" && HEX_COLOR_RE.test(rec.color.trim())
          ? rec.color.trim()
          : EMA_COLOR_PALETTE[idx % EMA_COLOR_PALETTE.length]!;
      const enabled = typeof rec.enabled === "boolean" ? rec.enabled : true;
      const lineWidth = clampNum(rec.lineWidth, 1, 4, 2);
      return { id, period, color, enabled, lineWidth };
    });

  const emaLines =
    normalizedLines.length > 0
      ? normalizedLines
      : de.lines.map((line) => ({ ...line }));

  return {
    ema: {
      lines: emaLines,
    },
    vwap: {
      anchor:
        typeof w.anchor === "string" && VALID_VWAP_ANCHORS.has(w.anchor as VwapAnchorSetting)
          ? (w.anchor as VwapAnchorSetting)
          : dw.anchor,
      source:
        typeof w.source === "string" && VALID_VWAP_SOURCES.has(w.source as VwapPriceSource)
          ? (w.source as VwapPriceSource)
          : dw.source,
      color:
        typeof w.color === "string" && HEX_COLOR_RE.test(w.color.trim())
          ? w.color.trim()
          : dw.color,
      lineWidth: clampNum(w.lineWidth, 1, 4, dw.lineWidth),
      showBandLabels:
        typeof w.showBandLabels === "boolean" ? w.showBandLabels : dw.showBandLabels,
      band1: normalizeVwapBand(w.band1, dw.band1),
      band2: normalizeVwapBand(w.band2, dw.band2),
      band3: normalizeVwapBand(w.band3, dw.band3),
    },
    vpvr: {
      scope: v.scope === "all" ? "all" : "visible",
      rows: clampNum(v.rows, 12, 100, dv.rows),
      valueAreaPct: clampNum(v.valueAreaPct, 50, 90, dv.valueAreaPct),
      widthPct: clampNum(v.widthPct, 10, 45, dv.widthPct),
      showPoc: typeof v.showPoc === "boolean" ? v.showPoc : dv.showPoc,
      showValueArea: typeof v.showValueArea === "boolean" ? v.showValueArea : dv.showValueArea,
      showUpDown: typeof v.showUpDown === "boolean" ? v.showUpDown : dv.showUpDown,
    },
    smc: {
      swingLength: clampNum(s.swingLength, 2, 20, ds.swingLength),
      labelSize: clampNum(s.labelSize, 10, 20, ds.labelSize),
      swingStyle: s.swingStyle === "labels" ? "labels" : "dots",
      showBos: typeof s.showBos === "boolean" ? s.showBos : ds.showBos,
      showSwings: typeof s.showSwings === "boolean" ? s.showSwings : ds.showSwings,
      showFvg: typeof s.showFvg === "boolean" ? s.showFvg : ds.showFvg,
      hideMitigatedFvg:
        typeof s.hideMitigatedFvg === "boolean" ? s.hideMitigatedFvg : ds.hideMitigatedFvg,
      maxFvgs: clampNum(s.maxFvgs, 1, 30, ds.maxFvgs),
      maxBreaks: clampNum(s.maxBreaks, 1, 40, ds.maxBreaks),
    },
  };
}

function broadcastUpdated(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(UPDATED_EVENT));
}

export function getIndicatorSettings(): IndicatorSettings {
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(STORAGE_KEY) : null;
    if (!raw) return normalizeSettings({});
    return normalizeSettings(JSON.parse(raw));
  } catch {
    return normalizeSettings({});
  }
}

export function updateIndicatorSettings(patch: IndicatorSettingsPatch): IndicatorSettings {
  const current = getIndicatorSettings();
  const pw = patch.vwap;
  const next = normalizeSettings({
    ema: patch.ema ? { ...current.ema, ...patch.ema } : current.ema,
    vwap: pw
      ? {
          ...current.vwap,
          ...pw,
          band1: pw.band1 ? { ...current.vwap.band1, ...pw.band1 } : current.vwap.band1,
          band2: pw.band2 ? { ...current.vwap.band2, ...pw.band2 } : current.vwap.band2,
          band3: pw.band3 ? { ...current.vwap.band3, ...pw.band3 } : current.vwap.band3,
        }
      : current.vwap,
    vpvr: { ...current.vpvr, ...(patch.vpvr ?? {}) },
    smc: { ...current.smc, ...(patch.smc ?? {}) },
  });
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    }
  } catch {
    // ignore storage quota errors
  }
  broadcastUpdated();
  return next;
}

export function resetIndicatorSettings(
  kind?: "ema" | "vwap" | "vpvr" | "smc",
): IndicatorSettings {
  const current = getIndicatorSettings();
  const next = normalizeSettings({
    ema:
      !kind || kind === "ema"
        ? { lines: DEFAULT_INDICATOR_SETTINGS.ema.lines.map((line) => ({ ...line })) }
        : current.ema,
    vwap: !kind || kind === "vwap" ? cloneVwapDefaults() : current.vwap,
    vpvr: !kind || kind === "vpvr" ? { ...DEFAULT_INDICATOR_SETTINGS.vpvr } : current.vpvr,
    smc: !kind || kind === "smc" ? { ...DEFAULT_INDICATOR_SETTINGS.smc } : current.smc,
  });
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    }
  } catch {
    // ignore storage quota errors
  }
  broadcastUpdated();
  return next;
}

export function useIndicatorSettings(): IndicatorSettings {
  const [settings, setSettings] = useState<IndicatorSettings>(() => getIndicatorSettings());

  useEffect(() => {
    const refresh = () => setSettings(getIndicatorSettings());
    refresh();
    window.addEventListener("storage", refresh);
    window.addEventListener(UPDATED_EVENT, refresh);
    return () => {
      window.removeEventListener("storage", refresh);
      window.removeEventListener(UPDATED_EVENT, refresh);
    };
  }, []);

  return settings;
}
