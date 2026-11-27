import type { CanvasRenderingTarget2D } from "fancy-canvas";
import type {
  DataChangedScope,
  ISeriesPrimitivePaneRenderer,
  ISeriesPrimitivePaneView,
  Logical,
  SeriesAttachedParameter,
  SeriesPrimitivePaneViewZOrder,
  Time,
} from "lightweight-charts";
import type { StockSessionMetadata } from "../../services/demo/candles.ts";
import { PluginBase } from "./plugin-base.ts";

export type ExtendedSessionKind = "pre" | "post" | "regular";

export interface ExtendedHoursOptions {
  meta: StockSessionMetadata | null;
  exchange?: string;
  isDark: boolean;
}

const US_EQUITY_EXCHANGES = new Set([
  "",
  "US",
  "NYSE",
  "NASDAQ",
  "NASDAQ GS",
  "NASDAQ GM",
  "NASDAQ CM",
  "NASDAQ GLOBAL SELECT",
  "NASDAQ GLOBAL MARKET",
  "NASDAQ CAPITAL MARKET",
  "AMEX",
  "NYSE AMERICAN",
  "NYSE MKT",
  "NYSE ARCA",
  "NYSEARCA",
  "ARCA",
  "BATS",
  "CBOE",
  "CBOE BZX",
  "BZX",
  "IEX",
  "MEMX",
  "NMS",
  "NGM",
  "NCM",
  "NYQ",
  "ASE",
  "PCX",
  "BTS",
  "OTC",
  "OTHER OTC",
  "OTCMKTS",
  "PINK",
]);

export function isUsEquityExchange(exchange?: string | null): boolean {
  const norm = (exchange ?? "").trim().toUpperCase().replace(/\s+/g, " ");
  return US_EQUITY_EXCHANGES.has(norm);
}
const PRE_START_MIN = 4 * 60; // 04:00 ET
const PRE_END_MIN = 9 * 60 + 30; // 09:30 ET
const POST_START_MIN = 16 * 60; // 16:00 ET
const POST_END_MIN = 20 * 60; // 20:00 ET
const MAX_SAME_SESSION_GAP_SEC = 6 * 3600;

let cachedNyFormatter: Intl.DateTimeFormat | null = null;
function getNyFormatter(): Intl.DateTimeFormat {
  if (!cachedNyFormatter) {
    cachedNyFormatter = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      weekday: "short",
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
    });
  }
  return cachedNyFormatter;
}

function getNyScheduleInfo(timeSec: number): { minutes: number; isWeekend: boolean } | null {
  try {
    const parts = getNyFormatter().formatToParts(new Date(timeSec * 1000));
    let hour = 0;
    let minute = 0;
    let weekday = "";
    for (const part of parts) {
      if (part.type === "hour") hour = Number(part.value) % 24;
      else if (part.type === "minute") minute = Number(part.value);
      else if (part.type === "weekday") weekday = part.value;
    }
    if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
    const isWeekend = weekday === "Sat" || weekday === "Sun";
    return { minutes: hour * 60 + minute, isWeekend };
  } catch {
    return null;
  }
}

function isInRanges(timeSec: number, ranges: ReadonlyArray<{ start: number; end: number }>): boolean {
  for (const r of ranges) {
    if (timeSec >= r.start && timeSec < r.end) return true;
  }
  return false;
}

/**
 * Classifies an intraday stock bar timestamp as Pre-Market, After-Hours, or Regular session.
 * Uses explicit session bounds when available, falling back to America/New_York weekday
 * session hours (04:00-09:30 Pre-Market, 09:30-16:00 Regular, 16:00-20:00 Post-Market).
 */
export function classifyExtendedSession(
  timeSec: number,
  meta: StockSessionMetadata | null,
  exchange?: string,
): ExtendedSessionKind {
  if (!Number.isFinite(timeSec)) return "regular";
  if (meta && meta.pre.length > 0 && isInRanges(timeSec, meta.pre)) return "pre";
  if (meta && meta.post.length > 0 && isInRanges(timeSec, meta.post)) return "post";
  if (meta?.regular && meta.regular.length > 0 && isInRanges(timeSec, meta.regular)) {
    return "regular";
  }

  const isUsTimeZone =
    meta?.timezone === "America/New_York" ||
    (exchange !== undefined && exchange.trim().length > 0 && isUsEquityExchange(exchange));

  if (isUsTimeZone) {
    const ny = getNyScheduleInfo(timeSec);
    if (ny !== null && !ny.isWeekend) {
      if (ny.minutes >= PRE_START_MIN && ny.minutes < PRE_END_MIN) return "pre";
      if (ny.minutes >= POST_START_MIN && ny.minutes < POST_END_MIN) return "post";
    }
  }

  return "regular";
}

function normalizeTimeSec(ts: number | string | Date): number {
  if (typeof ts === "number") return ts > 1e12 ? Math.floor(ts / 1000) : ts;
  return Math.floor(new Date(ts).getTime() / 1000);
}

/**
 * Filters intraday stock candles to Regular Trading Hours when `showExtendedHours` is false.
 * Falls back to returning the unfiltered input if filtering leaves 0 bars (e.g. pure Pre-Market feed).
 */
export function filterExtendedHoursCandles<T extends { time: number | string | Date }>(
  candles: T[],
  showExtendedHours: boolean,
  meta: StockSessionMetadata | null,
  exchange?: string,
): T[] {
  if (showExtendedHours || candles.length === 0) return candles;
  const regular = candles.filter(
    (c) => classifyExtendedSession(normalizeTimeSec(c.time), meta, exchange) === "regular",
  );
  return regular.length > 0 ? regular : candles;
}

interface SessionBand {
  leftCss: number;
  rightCss: number;
}

export interface SessionRunRange {
  startIdx: number;
  endIdx: number;
}

/**
 * Finds all contiguous Pre-Market session runs across classified bars,
 * splitting whenever session kind changes or an overnight/multi-day gap occurs.
 */
export function findPreMarketSessionRuns(
  bars: ReadonlyArray<{ time: number; kind: ExtendedSessionKind }>,
): SessionRunRange[] {
  const runs: SessionRunRange[] = [];
  let runStart: number | null = null;
  let prevPreTime = 0;

  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i]!;
    if (bar.kind === "pre") {
      if (runStart === null) {
        runStart = i;
      } else if (bar.time - prevPreTime > MAX_SAME_SESSION_GAP_SEC) {
        runs.push({ startIdx: runStart, endIdx: i - 1 });
        runStart = i;
      }
      prevPreTime = bar.time;
    } else if (runStart !== null) {
      runs.push({ startIdx: runStart, endIdx: i - 1 });
      runStart = null;
    }
  }

  if (runStart !== null) {
    runs.push({ startIdx: runStart, endIdx: bars.length - 1 });
  }

  return runs;
}

class ExtendedHoursPaneRenderer implements ISeriesPrimitivePaneRenderer {
  private readonly _bands: SessionBand[];
  private readonly _isDark: boolean;

  constructor(bands: SessionBand[], isDark: boolean) {
    this._bands = bands;
    this._isDark = isDark;
  }

  draw(target: CanvasRenderingTarget2D): void {
    if (this._bands.length === 0) return;

    target.useBitmapCoordinateSpace((scope) => {
      const ctx = scope.context;
      const hpr = scope.horizontalPixelRatio;
      const vpr = scope.verticalPixelRatio;
      const maxX = scope.bitmapSize.width;
      const maxY = scope.bitmapSize.height;
      const accentHeight = Math.max(2, Math.round(2 * vpr));
      const fontSizePx = Math.max(9, Math.round(10 * Math.min(hpr, vpr)));

      ctx.save();
      ctx.font = `700 ${fontSizePx}px 'JetBrains Mono', ui-monospace, SFMono-Regular, monospace`;
      ctx.textBaseline = "top";

      for (const band of this._bands) {
        const rawX1 = Math.round(band.leftCss * hpr);
        const rawX2 = Math.round(band.rightCss * hpr);
        const x1 = Math.max(0, rawX1);
        const x2 = Math.min(maxX, rawX2);
        if (x2 <= x1) continue;

        const visibleCssWidth = (x2 - x1) / hpr;

        ctx.fillStyle = this._isDark ? "rgba(250, 204, 21, 0.14)" : "rgba(234, 179, 8, 0.18)";
        ctx.fillRect(x1, 0, x2 - x1, maxY);

        ctx.fillStyle = this._isDark ? "rgba(250, 204, 21, 0.55)" : "rgba(202, 138, 4, 0.65)";
        ctx.fillRect(x1, 0, x2 - x1, accentHeight);

        if (rawX2 >= 0 && rawX2 <= maxX) {
          ctx.fillStyle = this._isDark ? "rgba(250, 204, 21, 0.28)" : "rgba(202, 138, 4, 0.35)";
          ctx.fillRect(rawX2, 0, Math.max(1, Math.round(hpr)), maxY);
        }

        if (visibleCssWidth >= 28) {
          ctx.fillStyle = this._isDark ? "#facc15" : "#a16207";
          ctx.fillText("PRE", x1 + Math.round(5 * hpr), Math.round(6 * vpr));
        }
      }

      ctx.restore();
    });
  }
}

class ExtendedHoursPaneView implements ISeriesPrimitivePaneView {
  private readonly _source: ExtendedHoursPrimitive;
  private _bands: SessionBand[] = [];

  constructor(source: ExtendedHoursPrimitive) {
    this._source = source;
  }

  update(): void {
    const bars = this._source.classifiedBars();
    if (bars.length === 0) {
      this._bands = [];
      return;
    }

    const timeScale = this._source.chart.timeScale();
    const barSpacing = timeScale.options().barSpacing || 6;
    const halfBar = barSpacing / 2;

    const runs = findPreMarketSessionRuns(bars);
    const bands: SessionBand[] = [];
    for (const run of runs) {
      const xStart =
        timeScale.logicalToCoordinate(run.startIdx as Logical) ??
        timeScale.timeToCoordinate(bars[run.startIdx]!.time as Time);
      const xEnd =
        timeScale.logicalToCoordinate(run.endIdx as Logical) ??
        timeScale.timeToCoordinate(bars[run.endIdx]!.time as Time);
      if (xStart !== null && xEnd !== null) {
        bands.push({
          leftCss: Math.min(xStart, xEnd) - halfBar,
          rightCss: Math.max(xStart, xEnd) + halfBar,
        });
      }
    }

    this._bands = bands;
  }

  renderer(): ISeriesPrimitivePaneRenderer {
    return new ExtendedHoursPaneRenderer(this._bands, this._source.options().isDark);
  }

  zOrder(): SeriesPrimitivePaneViewZOrder {
    return "bottom";
  }
}

interface ClassifiedBar {
  time: number;
  kind: ExtendedSessionKind;
}

export class ExtendedHoursPrimitive extends PluginBase {
  private _options: ExtendedHoursOptions;
  private _bars: ClassifiedBar[] = [];
  private readonly _paneViews: ExtendedHoursPaneView[];

  constructor(options: ExtendedHoursOptions) {
    super();
    this._options = { ...options };
    this._paneViews = [new ExtendedHoursPaneView(this)];
  }

  options(): ExtendedHoursOptions {
    return this._options;
  }

  classifiedBars(): ClassifiedBar[] {
    return this._bars;
  }

  updateOptions(options: ExtendedHoursOptions): void {
    this._options = { ...options };
    this.recomputeBars();
    this.requestUpdate();
  }

  attached(p: SeriesAttachedParameter<Time>): void {
    super.attached(p);
    this.recomputeBars();
    this.requestUpdate();
  }

  protected dataUpdated(_scope: DataChangedScope): void {
    this.recomputeBars();
    this.requestUpdate();
  }

  updateAllViews(): void {
    this._paneViews.forEach((pw) => pw.update());
  }

  paneViews(): ISeriesPrimitivePaneView[] {
    return this._paneViews;
  }

  private recomputeBars(): void {
    try {
      const data = this.series.data();
      const next: ClassifiedBar[] = [];
      for (const bar of data) {
        if (typeof bar.time !== "number" || !Number.isFinite(bar.time)) continue;
        next.push({
          time: bar.time,
          kind: classifyExtendedSession(bar.time, this._options.meta, this._options.exchange),
        });
      }
      this._bars = next;
    } catch {
      this._bars = [];
    }
  }
}
