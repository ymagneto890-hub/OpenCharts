// ── Trading Page Constants ────────────────────────────────────────────────────

import { getTimeframeMs, isValidTimeframe } from "../../lib/timeframes.ts";

export const TIMEFRAMES = [
  "1s",
  "5s",
  "15s",
  "30s",
  "1m",
  "2m",
  "3m",
  "5m",
  "10m",
  "15m",
  "30m",
  "1h",
  "2h",
  "4h",
  "1d",
  "1w",
] as const;
export type Timeframe = (typeof TIMEFRAMES)[number] | (string & {});

export const REPLAY_ENABLED = true;

export const CHART_COLORS = {
  dark: {
    background: "#0b0e14",
    text: "#cbd5e1",
    grid: "#151923",
    crosshair: "#64748b",
    up: "#00E676",
    down: "#FF3B56",
    volumeUp: "rgba(0, 230, 118, 0.28)",
    volumeDown: "rgba(255, 59, 86, 0.28)",
    bidLine: "#00E676",
    askLine: "#FF3B56",
    bidLabelBg: "#00E676",
    askLabelBg: "#FF3B56",
    watermark: "rgba(255, 255, 255, 0.03)",
    lastPriceUp: "#00E676",
    lastPriceDown: "#FF3B56",
    orderLine: "#f0b90b",
    positionLong: "#00E676",
    positionShort: "#FF3B56",
    tpLine: "#00E676",
    slLine: "#FF3B56",
  },
  light: {
    background: "#ffffff",
    text: "#5d6068",
    grid: "#f0f2f5",
    crosshair: "#999",
    up: "#0ecb81",
    down: "#f6465d",
    volumeUp: "rgba(14, 203, 129, 0.25)",
    volumeDown: "rgba(246, 70, 93, 0.25)",
    bidLine: "#0ecb81",
    askLine: "#f6465d",
    bidLabelBg: "#0ecb81",
    askLabelBg: "#f6465d",
    watermark: "rgba(0, 0, 0, 0.03)",
    lastPriceUp: "#0ecb81",
    lastPriceDown: "#f6465d",
    orderLine: "#f0b90b",
    positionLong: "#0ecb81",
    positionShort: "#f6465d",
    tpLine: "#0ecb81",
    slLine: "#f6465d",
  },
};

export type ChartColors = (typeof CHART_COLORS)["dark"];

/**
 * Per-user color overrides (Chart Settings → Colors). Empty string = use the
 * theme default. Keys map 1:1 onto `ChartColors` fields via COLOR_OVERRIDE_MAP.
 */
export interface ChartColorOverrides {
  colorBackground: string;
  colorGrid: string;
  colorScaleText: string;
  colorCrosshair: string;
  colorBidLine: string;
  colorAskLine: string;
  colorPositionLong: string;
  colorPositionShort: string;
  colorOrderLine: string;
  colorTpLine: string;
  colorSlLine: string;
  /** Candle body colors (also drive wicks/borders unless overridden). */
  candleUpColor: string;
  candleDownColor: string;
}

const COLOR_OVERRIDE_MAP: ReadonlyArray<[keyof ChartColorOverrides, keyof ChartColors]> = [
  ["colorBackground", "background"],
  ["colorGrid", "grid"],
  ["colorScaleText", "text"],
  ["colorCrosshair", "crosshair"],
  ["colorBidLine", "bidLine"],
  ["colorAskLine", "askLine"],
  ["colorPositionLong", "positionLong"],
  ["colorPositionShort", "positionShort"],
  ["colorOrderLine", "orderLine"],
  ["colorTpLine", "tpLine"],
  ["colorSlLine", "slLine"],
  ["candleUpColor", "up"],
  ["candleDownColor", "down"],
];

/** Theme colors with the user's non-empty overrides applied on top. */
export function mergeChartColors(theme: ChartColors, overrides: ChartColorOverrides): ChartColors {
  const merged = { ...theme };
  for (const [overrideKey, themeKey] of COLOR_OVERRIDE_MAP) {
    const value = overrides[overrideKey];
    if (value) merged[themeKey] = value;
  }
  return merged;
}

/**
 * Armable tools. Some are placement-only aliases that commit a different stored
 * `type`: "ray"/"extended" store a "trendline" with extend flags;
 * "long-position"/"short-position" store a "position" with `side`; "measure" is
 * a transient gesture that never commits.
 */
export type DrawingTool =
  | "none"
  | "trendline"
  | "horizontal"
  | "fibonacci"
  | "rectangle"
  | "vertical"
  | "ray"
  | "extended"
  | "channel"
  | "text"
  | "fibextension"
  | "ellipse"
  | "arrow"
  | "triangle"
  | "position"
  | "long-position"
  | "short-position"
  | "measure";

/** Stored drawing kinds (excludes placement-only aliases). */
export type DrawingType = Exclude<
  DrawingTool,
  "none" | "ray" | "extended" | "long-position" | "short-position" | "measure"
>;

export type DrawingLineStyle = "solid" | "dashed" | "dotted";

/** Magnet snapping mode: off, weak (snap within a few px), or strong (always). */
export type MagnetMode = "none" | "weak" | "strong";

export interface DrawingLine {
  id: string;
  type: DrawingType;
  price: number;
  price2?: number;
  time?: number;
  time2?: number;
  /** Third anchor — parallel-channel offset line. */
  price3?: number;
  time3?: number;
  color: string;
  // v2 style/behavior fields — all optional so v1 drawings load unchanged
  /** Line width in px (default 2). */
  width?: number;
  lineStyle?: DrawingLineStyle;
  /** Locked drawings can be selected but not moved or resized. */
  locked?: boolean;
  /** Trendline only: extend the line to the pane edges. */
  extendLeft?: boolean;
  extendRight?: boolean;
  /** Hidden drawings stay in the object tree but don't render or hit-test. */
  hidden?: boolean;
  /** Render order — higher draws on top. Defaults to creation order. */
  zIndex?: number;
  /** Timeframe the drawing was created on (used by visibility "tf"). */
  createdTf?: string;
  /** "all" (default) shows on every timeframe; "tf" only on createdTf. */
  visibility?: "all" | "tf";
  // ── Styling depth (Tier 4) ──
  /** Fill colour for shapes / channel / fib bands (defaults to `color`). */
  fillColor?: string;
  /** Fill opacity 0–1 (defaults per drawing kind). */
  fillOpacity?: number;
  /** Arrowheads on line ends (trendline / arrow). */
  arrowStart?: boolean;
  arrowEnd?: boolean;
  /** Text content + size for text/callout drawings and attachable labels. */
  text?: string;
  fontSize?: number;
  /** Bold / italic styling for text drawings. */
  bold?: boolean;
  italic?: boolean;
  /** Optional text-box background (text drawings). */
  textBg?: boolean;
  textBgColor?: string;
  /** Optional text-box border (text drawings). */
  textBorder?: boolean;
  textBorderColor?: string;
  /** Custom fibonacci levels (fractions); defaults applied when absent. */
  fibLevels?: number[];
  // ── Position tool (long/short risk-reward) ──
  side?: "long" | "short";
  /** Stop-loss price (position tool). */
  stopPrice?: number;
  /** Take-profit price (position tool). */
  targetPrice?: number;
  /** % of account equity risked — drives size/$ readout (default 1). */
  riskPct?: number;
  // ── Price alerts on lines ──
  /** When set, the platform alerts when price crosses this line. */
  alertEnabled?: boolean;
  alertMessage?: string;
}

/** Swatch palette for the floating drawing toolbar (TradingView-style). */
export const DRAWING_COLORS = [
  "#2196F3",
  "#f0b90b",
  "#0ecb81",
  "#f6465d",
  "#9c27b0",
  "#ff9800",
  "#787b86",
  "#ffffff",
] as const;

export const DRAWING_WIDTHS = [1, 2, 3, 4] as const;

/** Timeframe interval in milliseconds (supports 1s, 3m, 5m, and any dynamic timeframe). */
export const TF_INTERVAL_MS: Record<string, number> = new Proxy(
  {
    "1s": 1_000,
    "5s": 5_000,
    "15s": 15_000,
    "30s": 30_000,
    "1m": 60_000,
    "2m": 120_000,
    "3m": 3 * 60_000,
    "5m": 5 * 60_000,
    "10m": 10 * 60_000,
    "15m": 15 * 60_000,
    "30m": 30 * 60_000,
    "1h": 60 * 60_000,
    "2h": 2 * 60 * 60_000,
    "4h": 4 * 60 * 60_000,
    "1d": 24 * 60 * 60_000,
    "1w": 7 * 24 * 60 * 60_000,
  } as Record<string, number>,
  {
    get(target, prop) {
      if (typeof prop === "string") {
        if (prop in target) return target[prop];
        if (isValidTimeframe(prop)) return getTimeframeMs(prop);
      }
      return Reflect.get(target, prop);
    },
  },
);

export const KNOWN_CURRENCIES = [
  "BTC",
  "EUR",
  "USD",
  "GBP",
  "JPY",
  "AUD",
  "NZD",
  "CAD",
  "CHF",
  "CNY",
  "HKD",
  "SGD",
  "SEK",
  "NOK",
  "MXN",
  "ZAR",
  "TRY",
  "PLN",
  "CZK",
  "HUF",
  "DKK",
];

export interface NewsOverlayConfig {
  enabled: boolean;
  lineColor: string;
  showPast: boolean;
  showFuture: boolean;
  showHigh: boolean;
  showMedium: boolean;
  showLow: boolean;
}

export interface EconomicEvent {
  time: string;
  currency: string;
  impact: "low" | "medium" | "high";
  event: string;
  forecast?: string;
  previous?: string;
  actual?: string;
}

export const MOCK_EVENTS: EconomicEvent[] = [
  {
    time: "08:30",
    currency: "USD",
    impact: "high",
    event: "Nóminas no agrícolas (NFP)",
    forecast: "180K",
    previous: "175K",
  },
  {
    time: "10:00",
    currency: "USD",
    impact: "medium",
    event: "PMI manufacturero del ISM",
    forecast: "49.8",
    previous: "49.2",
  },
  {
    time: "14:00",
    currency: "EUR",
    impact: "high",
    event: "Decisión de tipos de interés del BCE",
    forecast: "4.50%",
    previous: "4.50%",
  },
  {
    time: "08:00",
    currency: "GBP",
    impact: "medium",
    event: "PIB mensual (m/m)",
    forecast: "0.2%",
    previous: "0.1%",
  },
  {
    time: "21:30",
    currency: "JPY",
    impact: "low",
    event: "Tasa de desempleo",
    forecast: "2.5%",
    previous: "2.5%",
  },
  { time: "15:30", currency: "USD", impact: "high", event: "Declaración del FOMC" },
  {
    time: "02:00",
    currency: "CNY",
    impact: "medium",
    event: "IPC interanual (CPI y/y)",
    forecast: "0.3%",
    previous: "0.2%",
  },
];

export interface NewsItem {
  time: string;
  title: string;
  source: string;
  impact: "bullish" | "bearish" | "neutral";
}

export const MOCK_NEWS: NewsItem[] = [
  {
    time: "Hace 2m",
    title: "La Fed señala un posible recorte de tipos de interés en la reunión de septiembre",
    source: "Reuters",
    impact: "bullish",
  },
  {
    time: "Hace 15m",
    title: "El EUR/USD rompe al alza la resistencia clave situada en 1,0950",
    source: "FXStreet",
    impact: "bullish",
  },
  {
    time: "Hace 32m",
    title: "Los precios del petróleo suben con fuerza tras la extensión de recortes de la OPEP+",
    source: "Bloomberg",
    impact: "neutral",
  },
  {
    time: "Hace 1h",
    title: "El Banco de Japón mantiene inalterada su política monetaria ultralaxa",
    source: "Nikkei",
    impact: "bearish",
  },
  {
    time: "Hace 2h",
    title: "Los rendimientos de los bonos del Tesoro de EE. UU. suben antes de los datos de empleo",
    source: "CNBC",
    impact: "bearish",
  },
  {
    time: "Hace 3h",
    title: "El oro alcanza nuevos máximos históricos ante el aumento de la incertidumbre global",
    source: "Reuters",
    impact: "bullish",
  },
];
