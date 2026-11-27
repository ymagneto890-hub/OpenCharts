import { CanvasRenderingTarget2D } from "fancy-canvas";
import type {
  AutoscaleInfo,
  ISeriesPrimitivePaneRenderer,
  ISeriesPrimitivePaneView,
  Logical,
} from "lightweight-charts";
import type { VpvrSettings } from "../../hooks/useIndicatorSettings.ts";
import { type CandleData, computeVolumeProfile, type VolumeProfileResult } from "../indicators.ts";
import { PluginBase } from "./plugin-base.ts";

export interface VolumeProfileInput {
  candles: CandleData[];
  settings: VpvrSettings;
  isDark: boolean;
  pipDigits: number;
}

class VolumeProfileRenderer implements ISeriesPrimitivePaneRenderer {
  constructor(private readonly source: VolumeProfilePrimitive) {}

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

      const { candles, settings, isDark, pipDigits } = this.source.data;
      if (!candles || candles.length === 0) return;

      let startIdx = 0;
      let endIdx = candles.length - 1;
      if (settings.scope === "visible") {
        try {
          const lr = chart.timeScale().getVisibleLogicalRange();
          if (lr && Number.isFinite(lr.from) && Number.isFinite(lr.to)) {
            startIdx = Math.max(0, Math.floor(lr.from));
            endIdx = Math.min(candles.length - 1, Math.ceil(lr.to));
          }
        } catch {
          // fallback to full range
        }
      }

      if (endIdx < startIdx) return;
      const profile = this.source.getCachedProfile(startIdx, endIdx);
      if (!profile || profile.bins.length === 0 || profile.maxBinVolume <= 0) return;

      const width = mediaSize.width;
      const height = mediaSize.height;
      const rightX = Math.max(0, width - 4);
      const maxBarW = Math.max(24, width * (settings.widthPct / 100));

      ctx.save();

      // 1. Histogram bins (anchored to right edge of price pane)
      for (const bin of profile.bins) {
        if (bin.totalVolume <= 0) continue;
        const yTop = series.priceToCoordinate(bin.priceHigh);
        const yBot = series.priceToCoordinate(bin.priceLow);
        if (yTop == null || yBot == null) continue;

        const top = Math.min(yTop, yBot);
        const rawH = Math.abs(yBot - yTop);
        const barH = Math.max(1.5, rawH - 1);
        if (top + barH < -10 || top > height + 10) continue;

        const totalW = (bin.totalVolume / profile.maxBinVolume) * maxBarW;
        if (totalW <= 0.5) continue;

        const inValueArea = bin.index >= profile.valIndex && bin.index <= profile.vahIndex;
        const alpha = inValueArea ? (isDark ? 0.52 : 0.45) : isDark ? 0.2 : 0.16;

        if (settings.showUpDown) {
          const buyFrac = bin.buyVolume / Math.max(1e-12, bin.totalVolume);
          const buyW = totalW * buyFrac;
          const sellW = Math.max(0, totalW - buyW);
          if (sellW > 0.25) {
            ctx.fillStyle = `rgba(255, 59, 86, ${alpha})`;
            ctx.fillRect(rightX - sellW, top, sellW, barH);
          }
          if (buyW > 0.25) {
            ctx.fillStyle = `rgba(0, 230, 118, ${alpha})`;
            ctx.fillRect(rightX - totalW, top, buyW, barH);
          }
        } else {
          ctx.fillStyle = `rgba(59, 130, 246, ${alpha})`;
          ctx.fillRect(rightX - totalW, top, totalW, barH);
        }

        if (settings.showPoc && bin.index === profile.pocIndex) {
          ctx.strokeStyle = "rgba(245, 158, 11, 0.9)";
          ctx.lineWidth = 1;
          ctx.strokeRect(rightX - totalW, top, totalW, barH);
        }
      }

      // 2. Value Area High / Low (VAH / VAL)
      if (settings.showValueArea && profile.vahIndex >= 0 && profile.valIndex >= 0) {
        const lineLeft = Math.max(0, rightX - maxBarW * 1.15);
        const drawVaLine = (price: number, label: string) => {
          const y = series.priceToCoordinate(price);
          if (y == null || y < -10 || y > height + 10) return;

          ctx.save();
          ctx.strokeStyle = isDark ? "rgba(56, 189, 248, 0.55)" : "rgba(2, 132, 199, 0.65)";
          ctx.lineWidth = 1;
          ctx.setLineDash([4, 4]);
          ctx.beginPath();
          ctx.moveTo(lineLeft, y);
          ctx.lineTo(rightX, y);
          ctx.stroke();

          ctx.font = "700 10px 'JetBrains Mono', monospace";
          const textW = ctx.measureText(label).width;
          const badgeX = Math.max(4, lineLeft - textW - 8);
          ctx.fillStyle = isDark ? "rgba(15, 23, 42, 0.9)" : "rgba(241, 245, 249, 0.94)";
          ctx.fillRect(badgeX - 4, y - 7, textW + 8, 14);
          ctx.fillStyle = isDark ? "#38bdf8" : "#0284c7";
          ctx.textBaseline = "middle";
          ctx.fillText(label, badgeX, y);
          ctx.restore();
        };

        drawVaLine(profile.vahPrice, "VAH");
        drawVaLine(profile.valPrice, "VAL");
      }

      // 3. Point of Control (POC)
      if (settings.showPoc && profile.pocIndex >= 0) {
        const yPoc = series.priceToCoordinate(profile.pocPrice);
        if (yPoc != null && yPoc >= -10 && yPoc <= height + 10) {
          ctx.save();
          ctx.strokeStyle = "#f59e0b";
          ctx.lineWidth = 1.5;
          ctx.setLineDash([]);
          ctx.beginPath();
          ctx.moveTo(0, yPoc);
          ctx.lineTo(rightX, yPoc);
          ctx.stroke();

          const label = `POC ${profile.pocPrice.toFixed(pipDigits)}`;
          ctx.font = "700 11px 'JetBrains Mono', monospace";
          const textW = ctx.measureText(label).width;
          const pillW = textW + 12;
          const pillX = Math.max(6, rightX - maxBarW - pillW - 6);
          const pillY = Math.max(4, Math.min(height - 20, yPoc - 9));

          ctx.fillStyle = "rgba(245, 158, 11, 0.95)";
          ctx.beginPath();
          ctx.roundRect(pillX, pillY, pillW, 17, 3);
          ctx.fill();

          ctx.fillStyle = "#0b0e14";
          ctx.textBaseline = "middle";
          ctx.fillText(label, pillX + 6, pillY + 8.5);
          ctx.restore();
        }
      }

      ctx.restore();
    });
  }
}

class VolumeProfileView implements ISeriesPrimitivePaneView {
  constructor(private readonly source: VolumeProfilePrimitive) {}

  update(): void {}

  renderer(): ISeriesPrimitivePaneRenderer {
    return new VolumeProfileRenderer(this.source);
  }
}

/**
 * Renders a configurable Volume Profile (VPVR) histogram, POC line, and
 * Value Area (VAH/VAL) directly onto the main price series pane.
 */
export class VolumeProfilePrimitive extends PluginBase {
  private readonly views: VolumeProfileView[];
  public data: VolumeProfileInput;
  private cachedKey = "";
  private cachedResult: VolumeProfileResult | null = null;

  constructor(data: VolumeProfileInput) {
    super();
    this.data = data;
    this.views = [new VolumeProfileView(this)];
  }

  updateData(data: VolumeProfileInput): void {
    this.data = data;
    this.cachedKey = "";
    this.requestUpdate();
  }

  getCachedProfile(startIdx: number, endIdx: number): VolumeProfileResult | null {
    const { candles, settings } = this.data;
    if (!candles || candles.length === 0 || endIdx < startIdx) return null;
    const last = candles[endIdx];
    const key = `${startIdx}:${endIdx}:${candles.length}:${last?.time ?? 0}:${last?.close ?? 0}:${last?.volume ?? 0}:${settings.rows}:${settings.valueAreaPct}`;
    if (key === this.cachedKey && this.cachedResult) {
      return this.cachedResult;
    }
    const slice =
      startIdx === 0 && endIdx === candles.length - 1
        ? candles
        : candles.slice(startIdx, endIdx + 1);
    const res = computeVolumeProfile(slice, {
      rows: settings.rows,
      valueAreaPct: settings.valueAreaPct,
    });
    this.cachedKey = key;
    this.cachedResult = res;
    return res;
  }

  paneViews(): readonly ISeriesPrimitivePaneView[] {
    return this.views;
  }

  autoscaleInfo(_startTimePoint: Logical, _endTimePoint: Logical): AutoscaleInfo | null {
    return null;
  }
}
