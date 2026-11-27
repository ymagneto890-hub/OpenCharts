import { CanvasRenderingTarget2D } from "fancy-canvas";
import type {
  ISeriesPrimitivePaneRenderer,
  ISeriesPrimitivePaneView,
  Logical,
  Time,
  AutoscaleInfo,
} from "lightweight-charts";
import type { DivergenceSignal } from "../indicators.ts";
import { PluginBase } from "./plugin-base.ts";

const DIVERGENCE_COLORS: Record<DivergenceSignal["kind"], string> = {
  bull: "#00E676",
  "hidden-bull": "#00E676",
  bear: "#FFD600",
  "hidden-bear": "#FFD600",
};

class PriceDivergenceRenderer implements ISeriesPrimitivePaneRenderer {
  constructor(private readonly source: PriceDivergencePrimitive) {}

  draw(target: CanvasRenderingTarget2D): void {
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      let chart;
      let series;
      try {
        chart = this.source.chart;
        series = this.source.series;
      } catch {
        return;
      }
      if (!chart || !series) return;
      const timeScale = chart.timeScale();

      for (const divergence of this.source.divergences) {
        const startTime = (divergence.startPriceTime ?? divergence.startTime) as Time;
        const endTime = (divergence.endPriceTime ?? divergence.endTime) as Time;
        const x1 = timeScale.timeToCoordinate(startTime);
        const x2 = timeScale.timeToCoordinate(endTime);
        const y1 = series.priceToCoordinate(divergence.startPrice);
        const y2 = series.priceToCoordinate(divergence.endPrice);
        if (x1 == null || x2 == null || y1 == null || y2 == null) continue;
        if (Math.max(x1, x2) < -40 || Math.min(x1, x2) > mediaSize.width + 40) continue;

        ctx.save();
        ctx.strokeStyle = DIVERGENCE_COLORS[divergence.kind];
        ctx.fillStyle = DIVERGENCE_COLORS[divergence.kind];
        ctx.lineWidth = 2;
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();

        ctx.beginPath();
        ctx.arc(x1, y1, 2.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.arc(x2, y2, 2.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
    });
  }
}

class PriceDivergenceView implements ISeriesPrimitivePaneView {
  constructor(private readonly source: PriceDivergencePrimitive) {}

  update(): void {}

  renderer(): ISeriesPrimitivePaneRenderer {
    return new PriceDivergenceRenderer(this.source);
  }
}

/** Draws the price-side segment using the exact wick pivots used by the detector. */
export class PriceDivergencePrimitive extends PluginBase {
  private readonly views: PriceDivergenceView[];
  public divergences: DivergenceSignal[];

  constructor(divergences: DivergenceSignal[] = []) {
    super();
    this.divergences = divergences;
    this.views = [new PriceDivergenceView(this)];
  }

  setDivergences(divergences: DivergenceSignal[]): void {
    this.divergences = divergences;
    this.requestUpdate();
  }

  paneViews(): readonly ISeriesPrimitivePaneView[] {
    return this.views;
  }

  autoscaleInfo(_startTimePoint: Logical, _endTimePoint: Logical): AutoscaleInfo | null {
    return null;
  }
}
