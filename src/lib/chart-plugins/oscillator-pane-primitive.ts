import { CanvasRenderingTarget2D } from "fancy-canvas";
import {
  AutoscaleInfo,
  ISeriesPrimitive,
  ISeriesPrimitivePaneRenderer,
  ISeriesPrimitivePaneView,
  Logical,
  Time,
} from "lightweight-charts";
import type { DivergenceSignal, MacdThresholds } from "../indicators.ts";
import { PluginBase } from "./plugin-base.ts";

export interface HeaderValueItem {
  text: string;
  color: string;
}

export interface OscillatorPaneOptions {
  kind: "rsi" | "macd" | "stoch";
  title: string;
  subtitle?: string;
  headerValues: HeaderValueItem[];
  divergences: DivergenceSignal[];
  macdThresholds?: MacdThresholds | null;
  lastBarTime?: number;
  showMacdThresholds?: boolean;
  pricePrecision?: number;
  /** Vertical slot top ratio [0..1] on the shared chart canvas */
  slotTopRatio?: number;
  /** Vertical slot bottom ratio [0..1] on the shared chart canvas */
  slotBottomRatio?: number;
  isDark?: boolean;
  /** When true, the HTML block header renders the title/values instead of canvas */
  hideHeader?: boolean;
}

interface PlacedRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

function drawRoundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
  ctx.lineTo(x + radius, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

class OscillatorPaneRenderer implements ISeriesPrimitivePaneRenderer {
  private _source: OscillatorPanePrimitive;

  constructor(source: OscillatorPanePrimitive) {
    this._source = source;
  }

  drawBackground(target: CanvasRenderingTarget2D): void {
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      const { width, height } = mediaSize;
      const opts = this._source.options;
      let series;
      try {
        series = this._source.series;
      } catch {
        return;
      }
      if (!series) return;

      const isFullPane = (opts.slotTopRatio ?? 0) <= 0.01 && (opts.slotBottomRatio ?? 1) >= 0.99;
      const paneTop = isFullPane ? 0 : Math.max(0, Math.round(((opts.slotTopRatio ?? 0) - 0.012) * height));
      const paneBottom = isFullPane ? height : Math.min(height, Math.round(((opts.slotBottomRatio ?? 1) + 0.008) * height));
      const paneHeight = Math.max(10, paneBottom - paneTop);

      ctx.save();
      ctx.beginPath();
      ctx.rect(0, paneTop, width, paneHeight);
      ctx.clip();

      if (!isFullPane) {
        // Crisp horizontal divider bar at the top of the oscillator sub-panel
        ctx.strokeStyle = opts.isDark !== false ? "rgba(51, 65, 85, 0.85)" : "rgba(203, 213, 225, 0.9)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, paneTop + 0.5);
        ctx.lineTo(width, paneTop + 0.5);
        ctx.stroke();
      }

      if (opts.kind === "rsi") {
        const y70 = series.priceToCoordinate(70);
        const y50 = series.priceToCoordinate(50);
        const y30 = series.priceToCoordinate(30);

        if (y70 != null && y30 != null) {
          const top = Math.min(y70, y30);
          const bandH = Math.abs(y30 - y70);
          ctx.fillStyle = opts.isDark !== false ? "rgba(156, 39, 176, 0.22)" : "rgba(156, 39, 176, 0.15)";
          ctx.fillRect(0, top, width, bandH);
        }

        ctx.setLineDash([4, 4]);
        ctx.lineWidth = 1;

        if (y70 != null) {
          ctx.strokeStyle = "rgba(186, 104, 200, 0.85)";
          ctx.beginPath();
          ctx.moveTo(0, y70);
          ctx.lineTo(width, y70);
          ctx.stroke();
        }

        if (y50 != null) {
          ctx.strokeStyle = "rgba(203, 213, 225, 0.45)";
          ctx.beginPath();
          ctx.moveTo(0, y50);
          ctx.lineTo(width, y50);
          ctx.stroke();
        }

        if (y30 != null) {
          ctx.strokeStyle = "rgba(186, 104, 200, 0.85)";
          ctx.beginPath();
          ctx.moveTo(0, y30);
          ctx.lineTo(width, y30);
          ctx.stroke();
        }
      } else if (opts.kind === "stoch") {
        const y80 = series.priceToCoordinate(80);
        const y50 = series.priceToCoordinate(50);
        const y20 = series.priceToCoordinate(20);

        if (y80 != null && y20 != null) {
          const top = Math.min(y80, y20);
          const bandH = Math.abs(y20 - y80);
          ctx.fillStyle =
            opts.isDark !== false ? "rgba(41, 98, 255, 0.14)" : "rgba(41, 98, 255, 0.10)";
          ctx.fillRect(0, top, width, bandH);
        }

        ctx.setLineDash([4, 4]);
        ctx.lineWidth = 1;

        if (y80 != null) {
          ctx.strokeStyle = "rgba(148, 163, 184, 0.65)";
          ctx.beginPath();
          ctx.moveTo(0, y80);
          ctx.lineTo(width, y80);
          ctx.stroke();
        }

        if (y50 != null) {
          ctx.strokeStyle = "rgba(148, 163, 184, 0.35)";
          ctx.beginPath();
          ctx.moveTo(0, y50);
          ctx.lineTo(width, y50);
          ctx.stroke();
        }

        if (y20 != null) {
          ctx.strokeStyle = "rgba(148, 163, 184, 0.65)";
          ctx.beginPath();
          ctx.moveTo(0, y20);
          ctx.lineTo(width, y20);
          ctx.stroke();
        }
      } else if (opts.kind === "macd") {
        const y0 = series.priceToCoordinate(0);
        if (y0 != null) {
          ctx.setLineDash([3, 3]);
          ctx.strokeStyle = opts.isDark !== false ? "rgba(203, 213, 225, 0.45)" : "rgba(100, 116, 139, 0.45)";
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(0, y0);
          ctx.lineTo(width, y0);
          ctx.stroke();
        }
      }

      ctx.restore();
    });
  }

  draw(target: CanvasRenderingTarget2D): void {
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      const { width, height } = mediaSize;
      const opts = this._source.options;

      const isFullPane = (opts.slotTopRatio ?? 0) <= 0.01 && (opts.slotBottomRatio ?? 1) >= 0.99;
      const paneTop = isFullPane ? 0 : Math.max(0, Math.round(((opts.slotTopRatio ?? 0) - 0.012) * height));
      const paneBottom = isFullPane ? height : Math.min(height, Math.round(((opts.slotBottomRatio ?? 1) + 0.008) * height));
      const paneHeight = Math.max(10, paneBottom - paneTop);

      ctx.save();
      ctx.beginPath();
      ctx.rect(0, paneTop, width, paneHeight);
      ctx.clip();

      const placedRects: PlacedRect[] = [];
      // Reserve top-left header area inside this sub-panel so badges never cover the title
      placedRects.push({ x: 0, y: paneTop, w: Math.min(width * 0.65, 380), h: 24 });

      // Reserve right-side MACD thresholds info box if enabled, space permits, and user is viewing live edge
      let macdBoxRect: PlacedRect | null = null;
      let isLiveEdgeVisible = true;
      if (opts.kind === "macd" && opts.macdThresholds && opts.showMacdThresholds !== false && width >= 480 && paneHeight >= 64) {
        try {
          const chart = this._source.chart;
          if (chart && opts.lastBarTime) {
            const timeScale = chart.timeScale();
            const lastX = timeScale.timeToCoordinate(opts.lastBarTime as Time);
            // When displaced left into the past or scrolled away, hide the floating threshold box
            if (lastX === null || lastX > width + 10 || lastX < 200) {
              isLiveEdgeVisible = false;
            }
          }
        } catch {
          // ignore
        }

        if (isLiveEdgeVisible) {
          const boxW = 216;
          const boxH = Math.min(68, paneHeight - 6);
          const boxX = width - boxW - 10;
          const boxY = Math.max(paneTop + 26, Math.round(paneTop + (paneHeight - boxH) / 2));
          macdBoxRect = { x: boxX - 8, y: boxY, w: boxW + 8, h: boxH };
          placedRects.push(macdBoxRect);
        }
      }

      // 1. Draw MACD right-side threshold callout box (matching TradingView screenshot)
      if (opts.kind === "macd" && opts.macdThresholds && macdBoxRect) {
        const th = opts.macdThresholds;
        const prec = opts.pricePrecision ?? 2;
        const fmt = (n: number | null) => (n != null ? n.toFixed(prec) : "—");

        const bx = macdBoxRect.x + 8;
        const by = macdBoxRect.y;
        const bw = macdBoxRect.w - 8;
        const bh = macdBoxRect.h;

        const isNegative = !th.isBullishCrossState;

        ctx.save();
        ctx.fillStyle = isNegative ? "rgba(239, 68, 68, 0.95)" : "rgba(26, 148, 138, 0.92)";
        drawRoundedRect(ctx, bx, by, bw, bh, 4);
        ctx.fill();

        const midY = by + bh / 2;
        ctx.beginPath();
        ctx.moveTo(bx, midY - 6);
        ctx.lineTo(bx, midY + 6);
        ctx.lineTo(bx - 7, midY);
        ctx.closePath();
        ctx.fill();

        ctx.fillStyle = "#FFFFFF";
        ctx.textAlign = "center";
        ctx.textBaseline = "top";

        ctx.font = "700 10px Inter, -apple-system, BlinkMacSystemFont, sans-serif";
        ctx.fillText("MACD", bx + bw / 2, by + 5);

        ctx.font = "500 9px Inter, -apple-system, BlinkMacSystemFont, sans-serif";
        const line1 = th.isHistRising
          ? `Sigue subiendo por encima de: ${fmt(th.histContinuePrice)}`
          : `Sigue bajando por debajo de: ${fmt(th.histContinuePrice)}`;
        const line2 = th.isBullishCrossState
          ? `Cruce bajista en: ${fmt(th.signalCrossPrice)}`
          : `Cruce alcista en: ${fmt(th.signalCrossPrice)}`;
        const line3 = th.isAboveZero
          ? `Cruce por debajo del punto 0: ${fmt(th.zeroCrossPrice)}`
          : `Cruce por encima del punto 0: ${fmt(th.zeroCrossPrice)}`;

        ctx.fillText(line1, bx + bw / 2, by + 20);
        ctx.fillText(line2, bx + bw / 2, by + 35);
        ctx.fillText(line3, bx + bw / 2, by + 50);
        ctx.restore();
      }

      // 2. Draw solid green/red divergence segments.
      if (opts.divergences && opts.divergences.length > 0) {
        this._drawDivergences(ctx, width);
      }

      // 3. Draw top-left sub-panel header (unless rendered by HTML block header)
      if (!opts.hideHeader) {
        ctx.save();
        ctx.font = "600 11px Inter, -apple-system, BlinkMacSystemFont, sans-serif";
        ctx.textBaseline = "top";
        ctx.textAlign = "left";

        let cursorX = 10;
        const headerY = paneTop + 4;

        ctx.fillStyle = opts.isDark !== false ? "#E2E8F0" : "#1E293B";
        ctx.fillText(opts.title, cursorX, headerY);
        cursorX += ctx.measureText(opts.title).width + 6;

        if (opts.subtitle) {
          ctx.font = "500 10.5px Inter, -apple-system, BlinkMacSystemFont, sans-serif";
          ctx.fillStyle = "#94A3B8";
          ctx.fillText(opts.subtitle, cursorX, headerY + 0.5);
          cursorX += ctx.measureText(opts.subtitle).width + 8;
        }

        ctx.font = "600 11px JetBrains Mono, monospace";
        for (const item of opts.headerValues) {
          ctx.fillStyle = item.color;
          ctx.fillText(item.text, cursorX, headerY);
          cursorX += ctx.measureText(item.text).width + 8;
        }
        ctx.restore();
      }

      ctx.restore();
    });
  }

  private _drawDivergences(
    ctx: CanvasRenderingContext2D,
    width: number,
  ): void {
    let series;
    let chart;
    try {
      series = this._source.series;
      chart = this._source.chart;
    } catch {
      return;
    }
    if (!series || !chart) return;

    const timeScale = chart.timeScale();
    const divergences = this._source.options.divergences;
    if (!divergences || divergences.length === 0) return;

    const palette: Record<DivergenceSignal["kind"], string> = {
      bull: "#00E676",
      "hidden-bull": "#00E676",
      bear: "#FFD600",
      "hidden-bear": "#FFD600",
    };

    for (const d of divergences) {
      const x1 = timeScale.timeToCoordinate(d.startTime as Time);
      const x2 = timeScale.timeToCoordinate(d.endTime as Time);
      const y1 = series.priceToCoordinate(d.startOsc);
      const y2 = series.priceToCoordinate(d.endOsc);

      if (x1 == null || x2 == null || y1 == null || y2 == null) continue;
      if (Math.max(x1, x2) < -50 || Math.min(x1, x2) > width + 50) continue;

      ctx.save();
      ctx.strokeStyle = palette[d.kind];
      ctx.fillStyle = palette[d.kind];
      ctx.lineWidth = 2.25;
      ctx.setLineDash([]);

      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();

      ctx.beginPath();
      ctx.arc(x1, y1, 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(x2, y2, 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }
}

class OscillatorPaneView implements ISeriesPrimitivePaneView {
  private _source: OscillatorPanePrimitive;

  constructor(source: OscillatorPanePrimitive) {
    this._source = source;
  }

  update(): void {}

  renderer(): ISeriesPrimitivePaneRenderer {
    return new OscillatorPaneRenderer(this._source);
  }
}

export class OscillatorPanePrimitive extends PluginBase implements ISeriesPrimitive<Time> {
  private _paneViews: OscillatorPaneView[];
  public options: OscillatorPaneOptions;
  private _minVal = -1;
  private _maxVal = 1;

  constructor(options: OscillatorPaneOptions, minVal = -1, maxVal = 1) {
    super();
    this.options = options;
    this._minVal = minVal;
    this._maxVal = maxVal;
    this._paneViews = [new OscillatorPaneView(this)];
  }

  public setOptions(options: OscillatorPaneOptions, minVal?: number, maxVal?: number): void {
    this.options = options;
    if (minVal !== undefined && Number.isFinite(minVal)) this._minVal = minVal;
    if (maxVal !== undefined && Number.isFinite(maxVal)) this._maxVal = maxVal;
    this.requestUpdate();
  }

  public get minVal(): number {
    return this._minVal;
  }

  public get maxVal(): number {
    return this._maxVal;
  }

  public paneViews(): readonly ISeriesPrimitivePaneView[] {
    return this._paneViews;
  }

  public autoscaleInfo(_startTimePoint: Logical, _endTimePoint: Logical): AutoscaleInfo | null {
    if (this.options.kind === "rsi" || this.options.kind === "stoch") {
      return {
        priceRange: {
          minValue: Math.min(15, this._minVal),
          maxValue: Math.max(85, this._maxVal),
        },
      };
    }
    // For MACD, return null so lightweight-charts autoscales dynamically to the visible bars!
    return null;
  }
}

