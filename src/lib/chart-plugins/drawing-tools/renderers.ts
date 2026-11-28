import type { BitmapCoordinatesRenderingScope } from "fancy-canvas";
import type { DrawingLine, DrawingLineStyle } from "../../../pages/trading/constants";
import type { DrawCtxInfo, ResolvedEntry, ResolvedFibLevel } from "./types";

const HANDLE_RADIUS = 5;
const LINE_WIDTH = 2;
const FIB_BAND_ALPHA = 0.08;
const RECT_FILL_ALPHA = 0.14;

interface BPt {
  x: number;
  y: number;
}

function hexToRgba(hex: string, alpha: number): string {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!m) return hex;
  return `rgba(${parseInt(m[1]!, 16)}, ${parseInt(m[2]!, 16)}, ${parseInt(m[3]!, 16)}, ${alpha})`;
}

function toBitmap(scope: BitmapCoordinatesRenderingScope, x: number, y: number): BPt {
  return {
    x: Math.round(x * scope.horizontalPixelRatio),
    y: Math.round(y * scope.verticalPixelRatio),
  };
}

function showHandles(e: ResolvedEntry): boolean {
  return e.state === "hovered" || e.state === "selected";
}

// Dash pattern (media px) for each drawing line style.
function dashFor(style: DrawingLineStyle | undefined): readonly number[] | undefined {
  if (style === "dashed") return [6, 6];
  if (style === "dotted") return [2, 3];
  return undefined;
}

function applyDash(
  scope: BitmapCoordinatesRenderingScope,
  dash: readonly number[] | undefined,
): void {
  if (!dash) return;
  scope.context.setLineDash(dash.map((v) => v * scope.horizontalPixelRatio));
}

function strokeLine(
  scope: BitmapCoordinatesRenderingScope,
  a: BPt,
  b: BPt,
  color: string,
  widthMedia: number,
  dash?: readonly number[],
): void {
  const ctx = scope.context;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = widthMedia * scope.verticalPixelRatio;
  applyDash(scope, dash);
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.stroke();
  ctx.restore();
}

function drawHandle(scope: BitmapCoordinatesRenderingScope, p: BPt, color: string): void {
  const ctx = scope.context;
  ctx.save();
  ctx.beginPath();
  ctx.arc(p.x, p.y, HANDLE_RADIUS * scope.horizontalPixelRatio, 0, Math.PI * 2);
  ctx.fillStyle = "#ffffff";
  ctx.fill();
  ctx.lineWidth = 1.5 * scope.horizontalPixelRatio;
  ctx.strokeStyle = color;
  ctx.stroke();
  ctx.restore();
}

export function renderEntry(
  scope: BitmapCoordinatesRenderingScope,
  e: ResolvedEntry,
  _info: DrawCtxInfo,
): void {
  switch (e.d.type) {
    case "trendline":
      renderTrendline(scope, e);
      break;
    case "horizontal":
      renderHorizontal(scope, e);
      break;
    case "rectangle":
      renderRectangle(scope, e);
      break;
    case "fibonacci":
      renderFibonacci(scope, e);
      break;
    case "position":
      renderPosition(scope, e);
      break;
    case "vertical":
      renderVertical(scope, e);
      break;
    case "channel":
      renderChannel(scope, e);
      break;
    case "ellipse":
      renderEllipse(scope, e);
      break;
    case "arrow":
      renderArrow(scope, e);
      break;
    case "triangle":
      renderTriangle(scope, e);
      break;
    case "text":
      renderText(scope, e);
      break;
    case "fibextension":
      renderFibonacci(scope, e);
      break;
    default:
      break;
  }
}

// ── Parity tools: vertical / channel / shapes / text ─────────────────────────

function renderVertical(scope: BitmapCoordinatesRenderingScope, e: ResolvedEntry): void {
  if (e.x1 === null) return;
  const x = Math.round(e.x1 * scope.horizontalPixelRatio);
  strokeLine(
    scope,
    { x, y: 0 },
    { x, y: scope.bitmapSize.height },
    e.d.color,
    e.d.width ?? 1.5,
    dashFor(e.d.lineStyle),
  );
  if (showHandles(e)) {
    drawHandle(scope, { x, y: Math.round(scope.bitmapSize.height / 2) }, e.d.color);
  }
}

// Parallel channel: the main anchor line plus a copy offset by (price3 − price1),
// with a translucent fill between them.
function renderChannel(scope: BitmapCoordinatesRenderingScope, e: ResolvedEntry): void {
  if (e.x1 === null || e.y1 === null || e.x2 === null || e.y2 === null) return;
  if (e.y3 == null) return;
  const dy = e.y3 - e.y1;
  const a1 = toBitmap(scope, e.x1, e.y1);
  const b1 = toBitmap(scope, e.x2, e.y2);
  const a2 = toBitmap(scope, e.x1, e.y3);
  const b2 = toBitmap(scope, e.x2, e.y2 + dy);
  const ctx = scope.context;
  ctx.save();
  ctx.fillStyle = hexToRgba(e.d.fillColor ?? e.d.color, e.d.fillOpacity ?? 0.1);
  ctx.beginPath();
  ctx.moveTo(a1.x, a1.y);
  ctx.lineTo(b1.x, b1.y);
  ctx.lineTo(b2.x, b2.y);
  ctx.lineTo(a2.x, a2.y);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
  const dash = dashFor(e.d.lineStyle);
  strokeLine(scope, a1, b1, e.d.color, e.d.width ?? LINE_WIDTH, dash);
  strokeLine(scope, a2, b2, e.d.color, e.d.width ?? LINE_WIDTH, dash);
  if (showHandles(e)) {
    drawHandle(scope, a1, e.d.color);
    drawHandle(scope, b1, e.d.color);
    drawHandle(scope, a2, e.d.color);
  }
}

function renderEllipse(scope: BitmapCoordinatesRenderingScope, e: ResolvedEntry): void {
  if (e.x1 === null || e.y1 === null || e.x2 === null || e.y2 === null) return;
  const a = toBitmap(scope, e.x1, e.y1);
  const b = toBitmap(scope, e.x2, e.y2);
  const ctx = scope.context;
  const cx = (a.x + b.x) / 2;
  const cy = (a.y + b.y) / 2;
  ctx.save();
  ctx.beginPath();
  ctx.ellipse(cx, cy, Math.abs(b.x - a.x) / 2, Math.abs(b.y - a.y) / 2, 0, 0, Math.PI * 2);
  ctx.fillStyle = hexToRgba(e.d.fillColor ?? e.d.color, e.d.fillOpacity ?? RECT_FILL_ALPHA);
  ctx.fill();
  ctx.strokeStyle = e.d.color;
  ctx.lineWidth = (e.d.width ?? 1.5) * scope.verticalPixelRatio;
  applyDash(scope, dashFor(e.d.lineStyle));
  ctx.stroke();
  ctx.restore();
  if (showHandles(e)) drawRectHandles(scope, a, b, e.d.color);
}

function renderArrow(scope: BitmapCoordinatesRenderingScope, e: ResolvedEntry): void {
  if (e.x1 === null || e.y1 === null || e.x2 === null || e.y2 === null) return;
  const a = toBitmap(scope, e.x1, e.y1);
  const b = toBitmap(scope, e.x2, e.y2);
  strokeLine(scope, a, b, e.d.color, e.d.width ?? LINE_WIDTH, dashFor(e.d.lineStyle));
  drawArrowhead(scope, a, b, e.d.color);
  if (showHandles(e)) {
    drawHandle(scope, a, e.d.color);
    drawHandle(scope, b, e.d.color);
  }
}

function drawArrowhead(
  scope: BitmapCoordinatesRenderingScope,
  from: BPt,
  to: BPt,
  color: string,
): void {
  const ctx = scope.context;
  const ang = Math.atan2(to.y - from.y, to.x - from.x);
  const len = 12 * scope.horizontalPixelRatio;
  const spread = Math.PI / 7;
  ctx.save();
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(to.x, to.y);
  ctx.lineTo(to.x - len * Math.cos(ang - spread), to.y - len * Math.sin(ang - spread));
  ctx.lineTo(to.x - len * Math.cos(ang + spread), to.y - len * Math.sin(ang + spread));
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function renderTriangle(scope: BitmapCoordinatesRenderingScope, e: ResolvedEntry): void {
  if (e.x1 === null || e.y1 === null || e.x2 === null || e.y2 === null) return;
  const a = toBitmap(scope, e.x1, e.y1);
  const b = toBitmap(scope, e.x2, e.y2);
  const ctx = scope.context;
  ctx.save();
  ctx.beginPath();
  ctx.moveTo((a.x + b.x) / 2, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.lineTo(a.x, b.y);
  ctx.closePath();
  ctx.fillStyle = hexToRgba(e.d.fillColor ?? e.d.color, e.d.fillOpacity ?? RECT_FILL_ALPHA);
  ctx.fill();
  ctx.strokeStyle = e.d.color;
  ctx.lineWidth = (e.d.width ?? 1.5) * scope.verticalPixelRatio;
  applyDash(scope, dashFor(e.d.lineStyle));
  ctx.stroke();
  ctx.restore();
  if (showHandles(e)) {
    drawHandle(scope, a, e.d.color);
    drawHandle(scope, b, e.d.color);
  }
}

function textFont(d: ResolvedEntry["d"], sizePx: number): string {
  const style = d.italic ? "italic " : "";
  const weight = d.bold ? "bold " : "";
  return `${style}${weight}${Math.round(sizePx)}px sans-serif`;
}

function renderText(scope: BitmapCoordinatesRenderingScope, e: ResolvedEntry): void {
  if (e.x1 === null || e.y1 === null) return;
  const ctx = scope.context;
  const hpr = scope.horizontalPixelRatio;
  const size = (e.d.fontSize ?? 14) * scope.verticalPixelRatio;
  const lines = (e.d.text ?? "Text").split("\n");
  const at = toBitmap(scope, e.x1, e.y1);
  const lineH = size * 1.3;
  const pad = 4 * hpr;

  ctx.save();
  ctx.font = textFont(e.d, size);
  ctx.textBaseline = "top";

  const textW = Math.max(...lines.map((l) => ctx.measureText(l).width));
  const boxW = textW + pad * 2;
  const boxH = lines.length * lineH + pad * 2;
  const bx = at.x - pad;
  const by = at.y - pad;

  if (e.d.textBg) {
    ctx.fillStyle = e.d.textBgColor ?? "#1e222d";
    ctx.fillRect(bx, by, boxW, boxH);
  }
  if (e.d.textBorder) {
    ctx.strokeStyle = e.d.textBorderColor ?? e.d.color;
    ctx.lineWidth = hpr;
    ctx.strokeRect(bx, by, boxW, boxH);
  }

  ctx.fillStyle = e.d.color;
  lines.forEach((l, i) => ctx.fillText(l, at.x, at.y + i * lineH));

  if (showHandles(e)) {
    ctx.strokeStyle = e.d.color;
    ctx.lineWidth = hpr;
    ctx.setLineDash([3 * hpr, 3 * hpr]);
    ctx.strokeRect(bx, by, boxW, boxH);
  }
  ctx.restore();
}

// ── Position tool (long/short risk-reward) ───────────────────────────────────

const POS_GREEN = "#089981";
const POS_RED = "#f23645";

function renderPosition(
  scope: BitmapCoordinatesRenderingScope,
  e: ResolvedEntry,
): void {
  const { x1, x2, y1, yStop, yTarget } = e;
  if (x1 === null || x2 === null || y1 === null || yStop == null || yTarget == null) return;
  const xa = Math.min(x1, x2);
  const xb = Math.max(x1, x2);
  posZone(scope, xa, xb, y1, yTarget, POS_GREEN);
  posZone(scope, xa, xb, y1, yStop, POS_RED);
  strokeLine(scope, toBitmap(scope, xa, y1), toBitmap(scope, xb, y1), "#d1d4dc", 1.5, [5, 3]);
  if (showHandles(e)) renderPositionHandles(scope, e, xa, xb, y1);
  const lines = positionReadout(e.d);
  if (lines.length > 0) {
    const at = toBitmap(scope, xb + 8, y1);
    drawLabelBox(scope, at.x, at.y, lines, e.d.color, {
      fontSizePx: 16,
      bold: true,
      centerY: true,
    });
  }
}

function posZone(
  scope: BitmapCoordinatesRenderingScope,
  xa: number,
  xb: number,
  yFrom: number,
  yTo: number,
  color: string,
): void {
  const ctx = scope.context;
  const a = toBitmap(scope, xa, Math.min(yFrom, yTo));
  const b = toBitmap(scope, xb, Math.max(yFrom, yTo));
  ctx.save();
  ctx.fillStyle = hexToRgba(color, 0.12);
  ctx.fillRect(a.x, a.y, b.x - a.x, b.y - a.y);
  ctx.strokeStyle = hexToRgba(color, 0.6);
  ctx.lineWidth = scope.verticalPixelRatio;
  ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
  ctx.restore();
}

function renderPositionHandles(
  scope: BitmapCoordinatesRenderingScope,
  e: ResolvedEntry,
  xa: number,
  xb: number,
  y1: number,
): void {
  const xm = (xa + xb) / 2;
  drawHandle(scope, toBitmap(scope, xm, y1), e.d.color);
  if (e.yTarget != null) drawHandle(scope, toBitmap(scope, xm, e.yTarget), e.d.color);
  if (e.yStop != null) drawHandle(scope, toBitmap(scope, xm, e.yStop), e.d.color);
  drawHandle(scope, toBitmap(scope, xb, y1), e.d.color);
}

export function positionReadout(d: DrawingLine): string[] {
  if (d.stopPrice == null || d.targetPrice == null) return [];
  const reward = Math.abs(d.targetPrice - d.price);
  const risk = Math.abs(d.price - d.stopPrice);
  const rr = risk > 0 ? reward / risk : 0;
  return [`R:R 1 : ${rr.toFixed(2)}`];
}

function roundedRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  if (typeof ctx.roundRect === "function") {
    ctx.roundRect(x, y, w, h, r);
    return;
  }
  const radius = Math.min(r, w / 2, h / 2);
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
  ctx.lineTo(x + radius, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
}

// Reusable dark readout box (position stats, text labels).
function drawLabelBox(
  scope: BitmapCoordinatesRenderingScope,
  x: number,
  y: number,
  lines: string[],
  borderColor: string,
  opts?: { fontSizePx?: number; bold?: boolean; centerY?: boolean },
): void {
  const ctx = scope.context;
  const hpr = scope.horizontalPixelRatio;
  const vpr = scope.verticalPixelRatio;
  const fontSize = opts?.fontSizePx ?? 10;
  const isBold = Boolean(opts?.bold);
  ctx.save();
  ctx.font = `${isBold ? "700 " : ""}${Math.round(fontSize * vpr)}px monospace`;
  const lineH = Math.round(fontSize * 1.35 * vpr);
  const padX = Math.round((opts?.fontSizePx ? 10 : 6) * hpr);
  const padY = Math.round((opts?.fontSizePx ? 6 : 3) * vpr);
  const width = Math.max(...lines.map((l) => ctx.measureText(l).width)) + padX * 2;
  const height = lines.length * lineH + padY * 2;
  const rawY = opts?.centerY ? y - height / 2 : y;
  const bx = Math.max(0, Math.min(x, scope.bitmapSize.width - width));
  const by = Math.max(0, Math.min(rawY, scope.bitmapSize.height - height));
  ctx.fillStyle = "rgba(20, 24, 35, 0.94)";
  ctx.beginPath();
  roundedRectPath(ctx, bx, by, width, height, (isBold ? 6 : 4) * hpr);
  ctx.fill();
  ctx.strokeStyle = borderColor;
  ctx.lineWidth = (isBold ? 1.5 : 1) * hpr;
  ctx.stroke();
  ctx.fillStyle = isBold ? "#ffffff" : "#e0e3ea";
  ctx.textBaseline = "middle";
  lines.forEach((l, i) => ctx.fillText(l, bx + padX, by + padY + (i + 0.5) * lineH));
  ctx.restore();
}

function renderMeasureTool(
  scope: BitmapCoordinatesRenderingScope,
  e: ResolvedEntry,
  a: BPt,
  b: BPt,
): void {
  const isBull = b.y <= a.y;
  const color = isBull ? "#00E676" : "#FF3B56";
  const hpr = scope.horizontalPixelRatio;
  const vpr = scope.verticalPixelRatio;

  // Ensure a comfortable minimum width (70px) so vertical measurements show a clean bracket
  const minW = 70 * hpr;
  const rawW = Math.abs(b.x - a.x);
  let left = Math.min(a.x, b.x);
  let right = Math.max(a.x, b.x);
  if (rawW < minW) {
    const midX = (a.x + b.x) / 2;
    left = midX - minW / 2;
    right = midX + minW / 2;
  }
  const top = Math.min(a.y, b.y);
  const bottom = Math.max(a.y, b.y);
  const width = Math.max(1, right - left);
  const height = Math.max(2 * vpr, bottom - top);
  const centerX = (left + right) / 2;

  const ctx = scope.context;
  ctx.save();
  // 1. Vivid shaded measurement zone
  ctx.fillStyle = isBull ? "rgba(0, 230, 118, 0.22)" : "rgba(255, 59, 86, 0.22)";
  ctx.fillRect(left, top, width, height);

  // 2. High-contrast dashed boundary rectangle
  ctx.strokeStyle = isBull ? "rgba(0, 230, 118, 0.88)" : "rgba(255, 59, 86, 0.88)";
  ctx.lineWidth = 1.5 * hpr;
  ctx.setLineDash([4 * hpr, 3 * hpr]);
  ctx.strokeRect(left, top, width, height);
  ctx.restore();

  // 3. Strong horizontal bracket caps at start and end prices
  strokeLine(scope, { x: left, y: a.y }, { x: right, y: a.y }, color, 2.2);
  strokeLine(scope, { x: left, y: b.y }, { x: right, y: b.y }, color, 2.2);

  // 4. Central vertical connecting line + direction arrowhead
  strokeLine(
    scope,
    { x: centerX, y: a.y },
    { x: centerX, y: b.y },
    color,
    2,
    [4, 3],
  );
  if (Math.abs(b.y - a.y) >= 14 * vpr) {
    drawArrowhead(scope, { x: centerX, y: a.y }, { x: centerX, y: b.y }, color);
  }

  // 5. Handles at the measurement points
  drawHandle(scope, { x: centerX, y: a.y }, color);
  drawHandle(scope, { x: centerX, y: b.y }, color);

  // 6. High-contrast stats badge (delta price, % change, candles count)
  if (e.stats && e.stats.length > 0) {
    drawStatsBox(
      scope,
      { x: right, y: b.y },
      e.stats,
      { color },
      { x: right, y: a.y },
      true,
    );
  }
}

function renderTrendline(scope: BitmapCoordinatesRenderingScope, e: ResolvedEntry): void {
  if (e.x1 === null || e.y1 === null || e.x2 === null || e.y2 === null) return;
  const a = toBitmap(scope, e.x1, e.y1);
  const b = toBitmap(scope, e.x2, e.y2);

  if (e.d.id === "measure") {
    renderMeasureTool(scope, e, a, b);
    return;
  }

  const seg = e.seg ?? { x1: e.x1, y1: e.y1, x2: e.x2, y2: e.y2 };
  const sa = toBitmap(scope, seg.x1, seg.y1);
  const sb = toBitmap(scope, seg.x2, seg.y2);

  strokeLine(
    scope,
    sa,
    sb,
    e.d.color,
    e.d.width ?? LINE_WIDTH,
    dashFor(e.d.lineStyle),
  );
  if (e.d.arrowEnd) drawArrowhead(scope, sa, sb, e.d.color);
  if (e.d.arrowStart) drawArrowhead(scope, sb, sa, e.d.color);
  if (showHandles(e) || e.state === "preview") {
    drawHandle(scope, a, e.d.color);
    drawHandle(scope, b, e.d.color);
    if (showHandles(e)) drawMidpointHandle(scope, a, b, e.d.color);
  }
  if (e.d.alertEnabled) {
    const right = a.x >= b.x ? a : b;
    drawAlertBadge(scope, right.x, right.y);
  }
  if (e.stats && e.stats.length > 0) {
    drawStatsBox(scope, b, e.stats, e.d, a, false);
  }
}

// Smaller square handle at the anchor midpoint — grabbing it body-drags the
// whole line (the hit-test already treats the line body as a move target).
function drawMidpointHandle(
  scope: BitmapCoordinatesRenderingScope,
  a: BPt,
  b: BPt,
  color: string,
): void {
  const ctx = scope.context;
  const half = 3 * scope.horizontalPixelRatio;
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  ctx.save();
  ctx.fillStyle = "#ffffff";
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5 * scope.horizontalPixelRatio;
  ctx.beginPath();
  ctx.rect(mx - half, my - half, half * 2, half * 2);
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

// Δprice / % / bars / angle readout near the second anchor (TV-style).
function drawStatsBox(
  scope: BitmapCoordinatesRenderingScope,
  at: BPt,
  stats: string[],
  d: { color: string },
  from: BPt,
  isMeasure = false,
): void {
  const ctx = scope.context;
  const hpr = scope.horizontalPixelRatio;
  const vpr = scope.verticalPixelRatio;

  if (isMeasure) {
    const headline = stats[0] ?? "";
    const subline = stats[1] ?? "";
    const isBull = from.y >= at.y;
    const accent = isBull ? "#00E676" : "#FF3B56";
    const pctColor = isBull ? "#4ADE80" : "#FF6B81";

    ctx.save();
    const headFont = `700 ${Math.round(13.5 * vpr)}px 'Inter', -apple-system, BlinkMacSystemFont, 'JetBrains Mono', monospace`;
    const subFont = `600 ${Math.round(11 * vpr)}px 'Inter', -apple-system, BlinkMacSystemFont, monospace`;
    const padX = 10 * hpr;
    const padY = 8 * vpr;
    const lineH1 = 18 * vpr;
    const lineH2 = 15 * vpr;

    ctx.font = headFont;
    const w1 = ctx.measureText(headline).width;
    ctx.font = subFont;
    const w2 = subline ? ctx.measureText(subline).width : 0;

    const width = Math.max(w1, w2) + padX * 2;
    const height = (subline ? lineH1 + lineH2 : lineH1) + padY * 2 - 2 * vpr;
    const x = Math.min(Math.max(4 * hpr, at.x + 12 * hpr), scope.bitmapSize.width - width - 4 * hpr);
    const y = Math.min(Math.max(4 * vpr, at.y + 10 * vpr), scope.bitmapSize.height - height - 4 * vpr);

    // Rich dark high-contrast card with colored tint & vivid 2px border
    ctx.fillStyle = "rgba(10, 14, 22, 0.96)";
    ctx.beginPath();
    roundedRectPath(ctx, x, y, width, height, 6 * hpr);
    ctx.fill();

    ctx.fillStyle = isBull ? "rgba(0, 230, 118, 0.14)" : "rgba(255, 59, 86, 0.14)";
    ctx.fill();

    ctx.strokeStyle = accent;
    ctx.lineWidth = 2 * hpr;
    ctx.stroke();

    // Render headline: price delta in pure crisp white, percentage in vivid neon green/red
    ctx.font = headFont;
    ctx.textBaseline = "top";
    const pctSepIdx = headline.indexOf(" (");
    if (pctSepIdx !== -1) {
      const pricePart = headline.slice(0, pctSepIdx);
      const pctPart = headline.slice(pctSepIdx);
      ctx.fillStyle = "#FFFFFF";
      ctx.fillText(pricePart, x + padX, y + padY);
      const priceW = ctx.measureText(pricePart).width;
      ctx.fillStyle = pctColor;
      ctx.fillText(pctPart, x + padX + priceW, y + padY);
    } else {
      ctx.fillStyle = "#FFFFFF";
      ctx.fillText(headline, x + padX, y + padY);
    }

    if (subline) {
      ctx.font = subFont;
      ctx.fillStyle = "#CBD5E1";
      ctx.fillText(subline, x + padX, y + padY + lineH1);
    }
    ctx.restore();
    return;
  }

  const angleDeg = Math.round((Math.atan2(from.y - at.y, at.x - from.x) * 180) / Math.PI);
  const lines = [...stats, `${angleDeg}°`];
  ctx.save();
  ctx.font = `${Math.round(10 * vpr)}px monospace`;
  const lineH = 13 * vpr;
  const pad = 6 * hpr;
  const width = Math.max(...lines.map((l) => ctx.measureText(l).width)) + pad * 2;
  const height = lines.length * lineH + pad;
  const x = Math.max(0, Math.min(at.x + 10 * hpr, scope.bitmapSize.width - width));
  const y = Math.max(0, Math.min(at.y + 10 * vpr, scope.bitmapSize.height - height));
  ctx.fillStyle = "rgba(20, 24, 35, 0.92)";
  ctx.beginPath();
  roundedRectPath(ctx, x, y, width, height, 4 * hpr);
  ctx.fill();
  ctx.strokeStyle = d.color;
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.fillStyle = "#e0e3ea";
  ctx.textBaseline = "top";
  lines.forEach((line, i) => {
    ctx.fillText(line, x + pad, y + pad / 2 + i * lineH);
  });
  ctx.restore();
}

function renderHorizontal(scope: BitmapCoordinatesRenderingScope, e: ResolvedEntry): void {
  if (e.y1 === null) return;
  const y = Math.round(e.y1 * scope.verticalPixelRatio);
  strokeLine(
    scope,
    { x: 0, y },
    { x: scope.bitmapSize.width, y },
    e.d.color,
    e.d.width ?? 1.5,
    dashFor(e.d.lineStyle),
  );
  if (showHandles(e))
    drawHandle(scope, { x: Math.round(scope.bitmapSize.width / 2), y }, e.d.color);
  if (e.d.alertEnabled) {
    drawAlertBadge(scope, scope.bitmapSize.width - 14 * scope.horizontalPixelRatio, y);
  }
}

// Amber bell dot marking a line that fires an alert when price crosses it.
function drawAlertBadge(scope: BitmapCoordinatesRenderingScope, x: number, y: number): void {
  const ctx = scope.context;
  const r = 4 * scope.horizontalPixelRatio;
  ctx.save();
  ctx.fillStyle = "#f0b90b";
  ctx.strokeStyle = "#1b1f2a";
  ctx.lineWidth = scope.horizontalPixelRatio;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

function renderRectangle(scope: BitmapCoordinatesRenderingScope, e: ResolvedEntry): void {
  if (e.x1 === null || e.y1 === null || e.x2 === null || e.y2 === null) return;
  const a = toBitmap(scope, e.x1, e.y1);
  const b = toBitmap(scope, e.x2, e.y2);
  const ctx = scope.context;
  ctx.save();
  ctx.fillStyle = hexToRgba(e.d.fillColor ?? e.d.color, e.d.fillOpacity ?? RECT_FILL_ALPHA);
  ctx.fillRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
  ctx.strokeStyle = e.d.color;
  ctx.lineWidth = (e.d.width ?? 1.5) * scope.verticalPixelRatio;
  applyDash(scope, dashFor(e.d.lineStyle));
  ctx.strokeRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
  ctx.restore();
  if (showHandles(e)) drawRectHandles(scope, a, b, e.d.color);
}

function drawRectHandles(
  scope: BitmapCoordinatesRenderingScope,
  a: BPt,
  b: BPt,
  color: string,
): void {
  drawHandle(scope, a, color);
  drawHandle(scope, b, color);
  drawHandle(scope, { x: a.x, y: b.y }, color);
  drawHandle(scope, { x: b.x, y: a.y }, color);
}

function renderFibonacci(scope: BitmapCoordinatesRenderingScope, e: ResolvedEntry): void {
  if (e.x1 === null || e.x2 === null || !e.fibLevels || e.fibLevels.length === 0) return;
  const xA = Math.round(Math.min(e.x1, e.x2) * scope.horizontalPixelRatio);
  const xB = Math.round(Math.max(e.x1, e.x2) * scope.horizontalPixelRatio);
  renderFibBands(scope, e.fibLevels, xA, xB);
  for (const lvl of e.fibLevels) renderFibLevel(scope, lvl, xA, xB);
  renderFibConnector(scope, e);
}

function renderFibBands(
  scope: BitmapCoordinatesRenderingScope,
  levels: ResolvedFibLevel[],
  xA: number,
  xB: number,
): void {
  const ctx = scope.context;
  for (let i = 0; i < levels.length - 1; i++) {
    const top = levels[i]!;
    const bottom = levels[i + 1]!;
    if (top.y === null || bottom.y === null) continue;
    const yA = Math.round(top.y * scope.verticalPixelRatio);
    const yB = Math.round(bottom.y * scope.verticalPixelRatio);
    ctx.fillStyle = hexToRgba(bottom.color, FIB_BAND_ALPHA);
    ctx.fillRect(xA, Math.min(yA, yB), xB - xA, Math.abs(yB - yA));
  }
}

function renderFibLevel(
  scope: BitmapCoordinatesRenderingScope,
  lvl: ResolvedFibLevel,
  xA: number,
  xB: number,
): void {
  if (lvl.y === null) return;
  const y = Math.round(lvl.y * scope.verticalPixelRatio);
  strokeLine(scope, { x: xA, y }, { x: xB, y }, lvl.color, 1);
  const ctx = scope.context;
  ctx.save();
  ctx.font = `${Math.round(10 * scope.verticalPixelRatio)}px monospace`;
  const hpr = scope.horizontalPixelRatio;
  const nearLeftEdge = xA < 85 * hpr;
  ctx.textAlign = nearLeftEdge ? "left" : "right";
  ctx.textBaseline = "middle";
  ctx.fillStyle = lvl.color;
  ctx.fillText(lvl.label, nearLeftEdge ? xA + 6 * hpr : xA - 6 * hpr, y);
  ctx.restore();
}

// Dashed diagonal between the two anchors, like TradingView's fib trend
// connector — also where the drag handles live.
function renderFibConnector(scope: BitmapCoordinatesRenderingScope, e: ResolvedEntry): void {
  if (e.x1 === null || e.y1 === null || e.x2 === null || e.y2 === null) return;
  const a = toBitmap(scope, e.x1, e.y1);
  const b = toBitmap(scope, e.x2, e.y2);
  strokeLine(scope, a, b, e.d.color, 1, [4, 4]);
  if (showHandles(e)) {
    drawHandle(scope, a, e.d.color);
    drawHandle(scope, b, e.d.color);
  }
}
