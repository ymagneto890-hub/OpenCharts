import { CanvasRenderingTarget2D } from "fancy-canvas";
import type {
  AutoscaleInfo,
  ISeriesPrimitivePaneRenderer,
  ISeriesPrimitivePaneView,
  Logical,
  Time,
} from "lightweight-charts";
import type { SmcSettings } from "../../hooks/useIndicatorSettings.ts";
import type { MarketStructureResult } from "../indicators.ts";
import { PluginBase } from "./plugin-base.ts";

export interface MarketStructureInput {
  structure: MarketStructureResult;
  settings: SmcSettings;
  isDark: boolean;
}

class MarketStructureRenderer implements ISeriesPrimitivePaneRenderer {
  constructor(private readonly source: MarketStructurePrimitive) {}

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

      const { structure, settings, isDark } = this.source.data;
      const timeScale = chart.timeScale();
      const width = mediaSize.width;
      const height = mediaSize.height;

      let visFromSec: number | null = null;
      let visToSec: number | null = null;
      try {
        const vr = timeScale.getVisibleRange();
        if (vr) {
          visFromSec = Number(vr.from);
          visToSec = Number(vr.to);
        }
      } catch {
        // ignore visible range miss
      }

      const resolveX = (timeSec: number): number | null => {
        const direct = timeScale.timeToCoordinate(timeSec as Time);
        if (direct !== null) return direct;
        if (visFromSec !== null && timeSec < visFromSec) return -16;
        if (visToSec !== null && timeSec > visToSec) return width + 16;
        return null;
      };

      const fontSize = settings.labelSize ?? 13;
      const fvgFont = Math.max(10, fontSize - 2);
      const pillBg = isDark ? "rgba(11, 14, 20, 0.94)" : "rgba(255, 255, 255, 0.96)";

      ctx.save();

      // 1. Fair Value Gaps (FVG zones)
      if (settings.showFvg && structure.fvgs.length > 0) {
        const fvgs = (
          settings.hideMitigatedFvg
            ? structure.fvgs.filter((f) => !f.mitigated)
            : structure.fvgs
        ).slice(-settings.maxFvgs);

        for (const fvg of fvgs) {
          const xStart = resolveX(fvg.startTime);
          const xEnd =
            fvg.mitigated && fvg.mitigatedTime != null
              ? resolveX(fvg.mitigatedTime)
              : width;
          const yTop = series.priceToCoordinate(fvg.top);
          const yBot = series.priceToCoordinate(fvg.bottom);
          if (xStart == null || xEnd == null || yTop == null || yBot == null) continue;
          if (xEnd < 0 || xStart > width) continue;

          const left = Math.max(0, xStart);
          const right = Math.min(width, xEnd);
          const boxW = right - left;
          const top = Math.min(yTop, yBot);
          const boxH = Math.abs(yBot - yTop);
          if (boxW < 2 || top + boxH < -10 || top > height + 10) continue;

          const isBull = fvg.direction === "bullish";
          const fillAlpha = fvg.mitigated ? 0.05 : 0.13;
          const borderAlpha = fvg.mitigated ? 0.22 : 0.5;

          ctx.fillStyle = isBull
            ? `rgba(0, 230, 118, ${fillAlpha})`
            : `rgba(255, 59, 86, ${fillAlpha})`;
          ctx.strokeStyle = isBull
            ? `rgba(0, 230, 118, ${borderAlpha})`
            : `rgba(255, 59, 86, ${borderAlpha})`;
          ctx.lineWidth = 1;
          ctx.setLineDash([]);
          ctx.fillRect(left, top, boxW, boxH);
          ctx.strokeRect(left, top, boxW, boxH);

          if (boxH >= fvgFont + 2 && boxW >= 36) {
            ctx.font = `700 ${fvgFont}px 'Inter', 'JetBrains Mono', sans-serif`;
            ctx.fillStyle = isBull
              ? `rgba(0, 230, 118, ${fvg.mitigated ? 0.55 : 0.92})`
              : `rgba(255, 59, 86, ${fvg.mitigated ? 0.55 : 0.92})`;
            ctx.textBaseline = "middle";
            ctx.fillText("FVG", left + 5, top + boxH / 2);
          }
        }
      }

      // 2. BOS & CHoCH structure break lines (solid line + circular "B" / "C" badge)
      if (settings.showBos && structure.breaks.length > 0) {
        const breaks = structure.breaks.slice(-settings.maxBreaks);
        const badgeRadius = Math.max(8, Math.round(fontSize * 0.72));
        const badgeFontSize = Math.max(9, Math.round(fontSize * 0.85));
        const badgeGap = 3;

        for (const brk of breaks) {
          const x1Raw = resolveX(brk.fromTime);
          const x2Raw = resolveX(brk.toTime);
          const y = series.priceToCoordinate(brk.price);
          if (x1Raw == null || x2Raw == null || y == null) continue;
          if (y < -24 || y > height + 24) continue;

          const x1 = Math.max(0, Math.min(width, x1Raw));
          const x2 = Math.max(0, Math.min(width, x2Raw));
          if (Math.max(x1Raw, x2Raw) < 0 || Math.min(x1Raw, x2Raw) > width) continue;
          if (Math.abs(x2 - x1) < 4) continue;

          const isBull = brk.direction === "bullish";
          const color = isBull ? "#00E676" : "#FF3B56";
          const letter = brk.kind === "CHoCH" ? "C" : "B";
          const midX = (x1 + x2) / 2;
          const labelY = isBull
            ? Math.max(badgeRadius + 2, y - badgeRadius - badgeGap)
            : Math.min(height - badgeRadius - 2, y + badgeRadius + badgeGap);

          ctx.save();
          ctx.strokeStyle = color;
          ctx.lineWidth = 1.8;
          ctx.setLineDash([]);
          ctx.beginPath();
          ctx.moveTo(x1, y);
          ctx.lineTo(x2, y);
          ctx.stroke();

          ctx.beginPath();
          ctx.arc(midX, labelY, badgeRadius, 0, Math.PI * 2);
          ctx.fillStyle = pillBg;
          ctx.fill();
          ctx.strokeStyle = color;
          ctx.lineWidth = 1.6;
          ctx.stroke();

          ctx.font = `700 ${badgeFontSize}px 'Inter', 'JetBrains Mono', sans-serif`;
          ctx.fillStyle = color;
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText(letter, midX, labelY + 0.5);
          ctx.restore();
        }
      }

      // 3. Structural swing markers: either large neon violet dots OR bare HH/HL/LH/LL labels (no rectangle)
      if (settings.showSwings && structure.swings.length > 0) {
        const recentSwings = structure.swings.slice(-Math.max(24, settings.maxBreaks * 3));

        if (settings.swingStyle === "labels") {
          ctx.font = `700 ${fontSize}px 'Inter', 'JetBrains Mono', sans-serif`;
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          const labelOffset = Math.round(fontSize * 0.75) + 4;

          for (const sw of recentSwings) {
            const x = timeScale.timeToCoordinate(sw.time as Time);
            const y = series.priceToCoordinate(sw.price);
            if (x == null || y == null) continue;
            if (x < -20 || x > width + 20 || y < -20 || y > height + 20) continue;

            const isBullLabel = sw.label === "HH" || sw.label === "HL";
            ctx.fillStyle = isBullLabel ? "#00E676" : "#FF3B56";
            const labelY =
              sw.kind === "high"
                ? Math.max(fontSize / 2 + 2, y - labelOffset)
                : Math.min(height - fontSize / 2 - 2, y + labelOffset);
            ctx.fillText(sw.label, x, labelY);
          }
        } else {
          const r = Math.max(6, Math.min(12, Math.round(fontSize * 0.58)));
          const offset = r + 5;
          const swingColor = isDark ? "#E879F9" : "#C026D3";
          ctx.setLineDash([]);
          ctx.fillStyle = swingColor;
          ctx.strokeStyle = pillBg;
          ctx.lineWidth = 2;

          for (const sw of recentSwings) {
            const x = timeScale.timeToCoordinate(sw.time as Time);
            const y = series.priceToCoordinate(sw.price);
            if (x == null || y == null) continue;
            if (x < -20 || x > width + 20 || y < -20 || y > height + 20) continue;

            const dotY =
              sw.kind === "high"
                ? Math.max(r + 2, y - offset)
                : Math.min(height - r - 2, y + offset);

            ctx.beginPath();
            ctx.arc(x, dotY, r, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
          }
        }
      }

      ctx.restore();
    });
  }
}

class MarketStructureView implements ISeriesPrimitivePaneView {
  constructor(private readonly source: MarketStructurePrimitive) {}

  update(): void {}

  renderer(): ISeriesPrimitivePaneRenderer {
    return new MarketStructureRenderer(this.source);
  }
}

/**
 * Renders causal Market Structure (SMC) overlays: Swing labels (HH/HL/LH/LL),
 * BOS/CHoCH structure breaks, and Fair Value Gaps (FVG).
 */
export class MarketStructurePrimitive extends PluginBase {
  private readonly views: MarketStructureView[];
  public data: MarketStructureInput;

  constructor(data: MarketStructureInput) {
    super();
    this.data = data;
    this.views = [new MarketStructureView(this)];
  }

  updateData(data: MarketStructureInput): void {
    this.data = data;
    this.requestUpdate();
  }

  paneViews(): readonly ISeriesPrimitivePaneView[] {
    return this.views;
  }

  autoscaleInfo(_startTimePoint: Logical, _endTimePoint: Logical): AutoscaleInfo | null {
    return null;
  }
}
