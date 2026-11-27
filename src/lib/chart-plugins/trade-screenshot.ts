import {
  ColorType,
  createChart,
  LineStyle,
  type IChartApi,
  type UTCTimestamp,
} from "lightweight-charts";
import {
  fetchHistoryAsync,
  getHistory,
  getRawHistory,
  getReplayHistory,
} from "../../services/demo/candles.ts";
import { useReplayStore } from "../../services/demo/replay.ts";
import type { Candle } from "../../services/schemas.ts";
import {
  balancedDivergenceOptions,
  detectDivergences,
  ema,
  MACD_BALANCED_DEFAULTS,
  macd,
  RSI_BALANCED_DEFAULTS,
  rsi,
} from "../indicators.ts";
import { OscillatorPanePrimitive } from "./oscillator-pane-primitive.ts";

export function getActiveReplayTimeSec(): number | undefined {
  try {
    const state = useReplayStore.getState();
    if (state.phase === "active" && state.visible && state.visible.length > 0) {
      const lastBar = state.visible[state.visible.length - 1];
      if (lastBar && Number.isFinite(Number(lastBar.time))) {
        return Number(lastBar.time);
      }
    }
  } catch {
    // safe
  }
  return undefined;
}

export async function saveScreenshotToDisk(
  dataUrl: string | undefined,
  symbol: string,
  timeframeTag: string,
): Promise<string | undefined> {
  if (!dataUrl) return undefined;
  // Already saved on disk
  if (dataUrl.startsWith("/trade-screenshots/")) return dataUrl;
  // In test / jsdom environment or non-dataUrl, return as-is
  if (
    !dataUrl.startsWith("data:image/") ||
    (typeof navigator !== "undefined" &&
      navigator.userAgent &&
      navigator.userAgent.toLowerCase().includes("jsdom"))
  ) {
    return dataUrl;
  }

  try {
    const filename = `${symbol}_${timeframeTag}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const res = await fetch("/__local_storage/screenshot", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename, dataUrl }),
    });
    if (res.ok) {
      const json = (await res.json()) as { url?: string };
      if (json.url) return json.url;
    }
  } catch {
    // Fallback to dataUrl if offline or server unreachable
  }
  return dataUrl;
}

export function parseTradeTimestampSec(raw: unknown): number | undefined {
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
    return raw > 1e11 ? Math.floor(raw / 1000) : Math.floor(raw);
  }
  if (typeof raw === "string" && raw.trim().length > 0) {
    const parsed = new Date(raw).getTime();
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.floor(parsed / 1000);
    }
    const num = Number(raw);
    if (Number.isFinite(num) && num > 0) {
      return num > 1e11 ? Math.floor(num / 1000) : Math.floor(num);
    }
  }
  if (raw instanceof Date) {
    const t = raw.getTime();
    if (Number.isFinite(t) && t > 0) return Math.floor(t / 1000);
  }
  return undefined;
}

interface ScreenshotOscillatorPrefs {
  showDivergences: boolean;
}

function readScreenshotOscillatorPrefs(): ScreenshotOscillatorPrefs {
  const storage = typeof localStorage !== "undefined" ? localStorage : null;
  return {
    showDivergences: storage ? storage.getItem("oscShowDivergences") !== "false" : true,
  };
}

/**
 * Composites all visible <canvas> elements within a container element into a single
 * clean image. Omits all HTML menus, toolbars, buttons, and popups, capturing exclusively
 * the chart price, active indicators (RSI, MACD, Volume, etc.), and drawings.
 */
export function captureContainerCanvases(
  container: HTMLElement,
  watermarkText?: string,
  forceDark?: boolean,
  drawPaneDividers = false,
  customTimestampSec?: number,
  badgeLabels?: { rsiLabel?: string; macdLabel?: string },
): string {
  if (typeof document === "undefined" || typeof window === "undefined") {
    return "";
  }

  const containerRect = container.getBoundingClientRect();
  const width = Math.max(containerRect.width, container.offsetWidth, 400);
  const height = Math.max(containerRect.height, container.offsetHeight, 300);

  const isDark =
    forceDark !== undefined
      ? forceDark
      : document.documentElement.classList.contains("dark") ||
        !document.documentElement.classList.contains("light");

  // High definition resolution for crisp, pixel-perfect trade captures
  const MAX_W = 1920;
  const scale = width < 1600 ? Math.min(2, 1920 / width) : (width > MAX_W ? MAX_W / width : 1);
  const targetW = Math.round(width * scale);
  const targetH = Math.round(height * scale);

  const destCanvas = document.createElement("canvas");
  destCanvas.width = targetW;
  destCanvas.height = targetH;
  const ctx = destCanvas.getContext("2d");
  if (!ctx) return "";
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";

  // 1. Clean chart background
  ctx.fillStyle = isDark ? "#0d1117" : "#ffffff";
  ctx.fillRect(0, 0, targetW, targetH);

  // 2. Draw all <canvas> layers in the order they appear
  const canvases = Array.from(container.querySelectorAll("canvas"));
  for (const c of canvases) {
    if (c.width === 0 || c.height === 0) continue;
    const cRect = c.getBoundingClientRect();
    const x = Math.max(0, (cRect.left - containerRect.left) * scale);
    const y = Math.max(0, (cRect.top - containerRect.top) * scale);
    const w = (cRect.width || c.width) * scale;
    const h = (cRect.height || c.height) * scale;

    if (w > 0 && h > 0) {
      try {
        ctx.drawImage(c, 0, 0, c.width, c.height, x, y, w, h);
      } catch {
        // Safe against detached or tainted canvases
      }
    }
  }

  // 3. Clear divider lines and indicator badges for offscreen multi-pane layouts (RSI top, Price mid, MACD bottom)
  if (drawPaneDividers) {
    ctx.save();
    // RSI badge (at top-left)
    const rsiLabel = badgeLabels?.rsiLabel ?? "RSI (14)";
    ctx.font = `600 11px 'JetBrains Mono', monospace`;
    const rsiW = Math.max(68, Math.ceil(ctx.measureText(rsiLabel).width + 14));
    ctx.fillStyle = isDark ? "rgba(15, 23, 42, 0.85)" : "rgba(241, 245, 249, 0.92)";
    ctx.fillRect(12, 12, rsiW, 18);
    ctx.strokeStyle = isDark ? "rgba(186, 104, 200, 0.6)" : "rgba(186, 104, 200, 0.8)";
    ctx.strokeRect(12, 12, rsiW, 18);
    ctx.fillStyle = "#BA68C8";
    ctx.textBaseline = "middle";
    ctx.fillText(rsiLabel, 18, 21);

    // Divider between RSI and Price (at 220px / 1020px boundary)
    const priceY = Math.round(targetH * (220 / 1020));
    ctx.strokeStyle = isDark ? "rgba(51, 65, 85, 0.7)" : "rgba(203, 213, 225, 0.8)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, priceY);
    ctx.lineTo(targetW, priceY);
    ctx.stroke();

    // Divider between Price and MACD (at 800px / 1020px boundary)
    const macdY = Math.round(targetH * (800 / 1020));
    ctx.beginPath();
    ctx.moveTo(0, macdY);
    ctx.lineTo(targetW, macdY);
    ctx.stroke();

    const macdLabel = badgeLabels?.macdLabel ?? "MACD (12, 26, 9)";
    const macdW = Math.max(115, Math.ceil(ctx.measureText(macdLabel).width + 14));
    ctx.fillStyle = isDark ? "rgba(15, 23, 42, 0.85)" : "rgba(241, 245, 249, 0.92)";
    ctx.fillRect(12, macdY + 4, macdW, 18);
    ctx.strokeStyle = isDark ? "rgba(41, 98, 255, 0.6)" : "rgba(41, 98, 255, 0.8)";
    ctx.strokeRect(12, macdY + 4, macdW, 18);
    ctx.fillStyle = isDark ? "#60a5fa" : "#2563eb";
    ctx.fillText(macdLabel, 18, macdY + 13);
    ctx.restore();
  }

  // 4. Subtle watermark badge for trade identification (timeframe & symbol)
  if (watermarkText) {
    ctx.save();
    const padX = 10;
    const padY = 5;
    const fontSize = 11;
    ctx.font = `600 ${fontSize}px 'JetBrains Mono', -apple-system, BlinkMacSystemFont, monospace`;
    const textMetrics = ctx.measureText(watermarkText);
    const boxW = textMetrics.width + padX * 2;
    const boxH = fontSize + padY * 2 + 2;
    const boxX = 12;
    const boxY = drawPaneDividers ? Math.round(targetH * (220 / 1020)) + 6 : 12;

    // Watermark pill background
    ctx.fillStyle = isDark ? "rgba(15, 23, 42, 0.85)" : "rgba(241, 245, 249, 0.92)";
    ctx.strokeStyle = isDark ? "rgba(51, 65, 85, 0.7)" : "rgba(203, 213, 225, 0.8)";
    ctx.lineWidth = 1;
    if (typeof ctx.roundRect === "function") {
      ctx.beginPath();
      ctx.roundRect(boxX, boxY, boxW, boxH, 5);
      ctx.fill();
      ctx.stroke();
    } else {
      ctx.fillRect(boxX, boxY, boxW, boxH);
      ctx.strokeRect(boxX, boxY, boxW, boxH);
    }

    // Watermark text
    ctx.fillStyle = isDark ? "#38bdf8" : "#0284c7";
    ctx.textBaseline = "middle";
    ctx.fillText(watermarkText, boxX + padX, boxY + boxH / 2);

    // Timestamp pill (top-right)
    const effectiveDate =
      typeof customTimestampSec === "number" && customTimestampSec > 0
        ? new Date(customTimestampSec * 1000)
        : new Date();
    const dateStr = effectiveDate.toLocaleString("es-ES", {
      dateStyle: "short",
      timeStyle: "medium",
    });
    ctx.font = `500 10px 'JetBrains Mono', monospace`;
    const dateMetrics = ctx.measureText(dateStr);
    const dateBoxW = dateMetrics.width + 12;
    const dateBoxH = 20;
    const dateBoxX = targetW - dateBoxW - 12;
    const dateBoxY = 12;

    ctx.fillStyle = isDark ? "rgba(15, 23, 42, 0.75)" : "rgba(241, 245, 249, 0.85)";
    ctx.strokeStyle = isDark ? "rgba(51, 65, 85, 0.6)" : "rgba(203, 213, 225, 0.7)";
    if (typeof ctx.roundRect === "function") {
      ctx.beginPath();
      ctx.roundRect(dateBoxX, dateBoxY, dateBoxW, dateBoxH, 4);
      ctx.fill();
      ctx.stroke();
    } else {
      ctx.fillRect(dateBoxX, dateBoxY, dateBoxW, dateBoxH);
      ctx.strokeRect(dateBoxX, dateBoxY, dateBoxW, dateBoxH);
    }
    ctx.fillStyle = isDark ? "#94a3b8" : "#64748b";
    ctx.fillText(dateStr, dateBoxX + 6, dateBoxY + dateBoxH / 2);

    ctx.restore();
  }

  try {
    return destCanvas.toDataURL("image/png");
  } catch {
    return "";
  }
}

/**
 * Renders an offscreen chart for any timeframe (e.g. 4h, 1d) with candlesticks,
 * volume histogram, 20-period Volume MA, and RSI (14), capturing it into a clean JPEG.
 */
export async function captureOffscreenChart(
  symbol: string,
  timeframe: string,
  watermarkLabel: string,
  isDark = true,
  maxTimeSec?: number,
): Promise<string> {
  if (typeof document === "undefined" || typeof window === "undefined") {
    return "";
  }

  // JSDOM / Node test environment lacks native canvas 2D text metrics for lightweight-charts
  if (
    typeof navigator !== "undefined" &&
    navigator.userAgent &&
    navigator.userAgent.toLowerCase().includes("jsdom")
  ) {
    return `data:image/jpeg;base64,mock_${symbol}_${timeframe}_chart`;
  }

  const effectiveMaxTimeSec = parseTradeTimestampSec(maxTimeSec) ?? getActiveReplayTimeSec();

  if (typeof window !== "undefined" && !window.matchMedia) {
    (window as unknown as { matchMedia: unknown }).matchMedia = () => ({
      matches: false,
      media: "",
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    });
  }

  const TOTAL_W = 1920;
  const RSI_H = 220;
  const PRICE_H = 580;
  const MACD_H = 220;
  const TOTAL_H = RSI_H + PRICE_H + MACD_H; // 1020px Full HD

  const container = document.createElement("div");
  container.style.position = "fixed";
  container.style.top = "0";
  container.style.left = "0";
  container.style.width = `${TOTAL_W}px`;
  container.style.height = `${TOTAL_H}px`;
  container.style.display = "flex";
  container.style.flexDirection = "column";
  container.style.opacity = "0.001";
  container.style.zIndex = "-99999";
  container.style.pointerEvents = "none";
  container.style.overflow = "hidden";
  container.style.backgroundColor = isDark ? "#0d1117" : "#ffffff";
  document.body.appendChild(container);

  const chartsToClean: IChartApi[] = [];

  try {
    let allBars: Candle[] = [];
    if (typeof effectiveMaxTimeSec === "number" && Number.isFinite(effectiveMaxTimeSec) && effectiveMaxTimeSec > 0) {
      // In historical replay or trade timestamp, get replay history which deterministically
      // provides lower timeframes (e.g. 1h) derived from ancestor timeframes (e.g. 4h, 1d)
      try {
        const replayBars = getReplayHistory(symbol, timeframe, effectiveMaxTimeSec);
        if (
          replayBars &&
          replayBars.length > 0 &&
          replayBars[0]!.time <= effectiveMaxTimeSec
        ) {
          allBars = replayBars;
        }
      } catch (err) {
        console.warn(`[trade-screenshot] getReplayHistory error (${symbol} ${timeframe}):`, err);
      }

      if (!allBars || allBars.length === 0) {
        // Fallback to genuine unshifted raw history if it covers the target timestamp
        const raw = getRawHistory(symbol, timeframe);
        if (raw && raw.length > 0 && raw[0]!.time <= effectiveMaxTimeSec) {
          allBars = raw;
        }
      }
    }
    if (!allBars || allBars.length === 0) {
      try {
        allBars = getHistory(symbol, timeframe);
      } catch {
        // fallback
      }
    }
    if (!allBars || allBars.length === 0) {
      try {
        const timeoutPromise = new Promise<Candle[]>((resolve) =>
          setTimeout(() => resolve([]), 500),
        );
        const fetched = await Promise.race([
          fetchHistoryAsync(symbol, timeframe),
          timeoutPromise,
        ]);
        if (fetched && fetched.length > 0) {
          allBars = fetched;
        }
      } catch {
        // Fallback
      }
    }
    if (!allBars || allBars.length === 0) return "";

    // Keep up to 300 bars for indicator warmup (EMA 50, RSI 14, MACD 12/26/9, Divergences),
    // and display the most recent 100 bars with 1:1 timestamp alignment across all 3 panes.
    let bars: Candle[] = allBars;
    if (typeof effectiveMaxTimeSec === "number" && Number.isFinite(effectiveMaxTimeSec) && effectiveMaxTimeSec > 0) {
      const filtered = allBars.filter((b) => Number(b.time) <= effectiveMaxTimeSec);
      if (filtered.length > 0) {
        bars = filtered;
      } else {
        bars = effectiveMaxTimeSec < allBars[0]!.time ? allBars.slice(0, 300) : allBars.slice(-300);
      }
    }
    if (bars.length > 300) {
      bars = bars.slice(-300);
    }
    if (bars.length === 0) return "";

    // Sanitize and ensure strictly ascending unique timestamps
    const cleanBars: Candle[] = [];
    let prevTime = -Infinity;
    for (const b of bars) {
      const t = Number(b.time);
      if (
        Number.isFinite(t) &&
        t > prevTime &&
        Number.isFinite(b.open) &&
        Number.isFinite(b.high) &&
        Number.isFinite(b.low) &&
        Number.isFinite(b.close) &&
        Number.isFinite(b.volume)
      ) {
        cleanBars.push({
          time: t,
          open: b.open,
          high: b.high,
          low: b.low,
          close: b.close,
          volume: b.volume,
        });
        prevTime = t;
      }
    }
    if (cleanBars.length === 0) return "";

    const displayBars = cleanBars.slice(-100);
    const displayStartTime = displayBars[0]!.time;
    const pipDigits =
      displayBars[displayBars.length - 1]!.close >= 1000
        ? 2
        : displayBars[displayBars.length - 1]!.close >= 1
          ? 3
          : 5;

    // ── 1. Create separate stacked DOM panes (RSI at top, Price mid, MACD bottom) ──
    const rsiDiv = document.createElement("div");
    rsiDiv.style.width = `${TOTAL_W}px`;
    rsiDiv.style.height = `${RSI_H}px`;
    rsiDiv.style.position = "relative";
    container.appendChild(rsiDiv);

    const priceDiv = document.createElement("div");
    priceDiv.style.width = `${TOTAL_W}px`;
    priceDiv.style.height = `${PRICE_H}px`;
    priceDiv.style.position = "relative";
    container.appendChild(priceDiv);

    const macdDiv = document.createElement("div");
    macdDiv.style.width = `${TOTAL_W}px`;
    macdDiv.style.height = `${MACD_H}px`;
    macdDiv.style.position = "relative";
    container.appendChild(macdDiv);

    const commonLayout = {
      background: { type: ColorType.Solid, color: isDark ? "#0d1117" : "#ffffff" },
      textColor: isDark ? "#94a3b8" : "#475569",
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 11,
    };
    const commonGrid = {
      vertLines: { color: isDark ? "#1e293b" : "#e2e8f0", style: LineStyle.Dotted },
      horzLines: { color: isDark ? "#1e293b" : "#e2e8f0", style: LineStyle.Dotted },
    };

    // ── 2. Price Chart Pane (Candlesticks + EMA 50 + Volume + 20 MA) ───────
    const chartPrice = createChart(priceDiv, {
      width: TOTAL_W,
      height: PRICE_H,
      layout: commonLayout,
      grid: commonGrid,
      rightPriceScale: {
        borderColor: isDark ? "#334155" : "#cbd5e1",
        minimumWidth: 80,
        autoScale: true,
        scaleMargins: { top: 0.08, bottom: 0.22 },
      },
      timeScale: {
        visible: false,
        fixLeftEdge: true,
        fixRightEdge: true,
      },
    });
    chartsToClean.push(chartPrice);

    const candleSeries = chartPrice.addCandlestickSeries({
      upColor: "#22c55e",
      downColor: "#ef4444",
      borderUpColor: "#22c55e",
      borderDownColor: "#ef4444",
      wickUpColor: "#22c55e",
      wickDownColor: "#ef4444",
    });

    candleSeries.setData(
      displayBars.map((b) => ({
        time: b.time as UTCTimestamp,
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
      })),
    );

    const ema50Points = ema(cleanBars, 50);
    if (ema50Points.length > 0) {
      const ema50Map = new Map(ema50Points.map((p) => [p.time, p.value]));
      const ema50Series = chartPrice.addLineSeries({
        color: "#38bdf8",
        lineWidth: 2,
        crosshairMarkerVisible: false,
        lastValueVisible: false,
        priceLineVisible: false,
      });
      ema50Series.setData(
        displayBars.map((b) => {
          const val = ema50Map.get(b.time);
          return val !== undefined && Number.isFinite(val)
            ? { time: b.time as UTCTimestamp, value: val }
            : { time: b.time as UTCTimestamp };
        }),
      );
    }

    const volumeSeries = chartPrice.addHistogramSeries({
      priceFormat: { type: "volume" },
      priceScaleId: "volume",
      lastValueVisible: false,
      priceLineVisible: false,
    });
    chartPrice.priceScale("volume").applyOptions({
      scaleMargins: { top: 0.8, bottom: 0 },
      borderVisible: false,
    });
    volumeSeries.setData(
      displayBars.map((b) => ({
        time: b.time as UTCTimestamp,
        value: b.volume,
        color: b.close >= b.open ? "rgba(34, 197, 94, 0.45)" : "rgba(239, 68, 68, 0.45)",
      })),
    );

    const maSeries = chartPrice.addLineSeries({
      priceScaleId: "volume",
      color: "#f59e0b",
      lineWidth: 1,
      crosshairMarkerVisible: false,
      lastValueVisible: false,
      priceLineVisible: false,
    });
    const volMaMap = new Map<number, number>();
    const PERIOD = 20;
    for (let i = PERIOD - 1; i < cleanBars.length; i++) {
      let sum = 0;
      for (let j = 0; j < PERIOD; j++) {
        sum += cleanBars[i - j]!.volume;
      }
      volMaMap.set(cleanBars[i]!.time, sum / PERIOD);
    }
    maSeries.setData(
      displayBars.map((b) => {
        const val = volMaMap.get(b.time);
        return val !== undefined && Number.isFinite(val)
          ? { time: b.time as UTCTimestamp, value: val }
          : { time: b.time as UTCTimestamp };
      }),
    );

    // ── 3. RSI Chart Pane (Purple line, 70/50/30 levels + Divergences) ────
    const chartRsi = createChart(rsiDiv, {
      width: TOTAL_W,
      height: RSI_H,
      layout: commonLayout,
      grid: commonGrid,
      rightPriceScale: {
        borderColor: isDark ? "#334155" : "#cbd5e1",
        minimumWidth: 80,
        autoScale: true,
        scaleMargins: { top: 0.1, bottom: 0.1 },
      },
      timeScale: {
        visible: false,
        fixLeftEdge: true,
        fixRightEdge: true,
      },
    });
    chartsToClean.push(chartRsi);

    const oscPrefs = readScreenshotOscillatorPrefs();
    const rsiPeriod = RSI_BALANCED_DEFAULTS.intraday;
    const macdFast = MACD_BALANCED_DEFAULTS.fast;
    const macdSlow = MACD_BALANCED_DEFAULTS.slow;
    const macdSignal = MACD_BALANCED_DEFAULTS.signal;

    const rsiPoints = rsi(cleanBars, rsiPeriod);
    if (rsiPoints.length > 0) {
      const rsiMap = new Map(rsiPoints.map((p) => [p.time, p.value]));
      const rsiSeries = chartRsi.addLineSeries({
        color: "#BA68C8",
        lineWidth: 2,
        crosshairMarkerVisible: false,
        lastValueVisible: true,
        priceLineVisible: true,
      });
      rsiSeries.setData(
        displayBars.map((b) => {
          const val = rsiMap.get(b.time);
          return val !== undefined && Number.isFinite(val)
            ? { time: b.time as UTCTimestamp, value: val }
            : { time: b.time as UTCTimestamp };
        }),
      );
      rsiSeries.createPriceLine({
        price: 70,
        color: "rgba(186, 104, 200, 0.8)",
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: false,
      });
      rsiSeries.createPriceLine({
        price: 30,
        color: "rgba(186, 104, 200, 0.8)",
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: false,
      });
      rsiSeries.createPriceLine({
        price: 50,
        color: "rgba(203, 213, 225, 0.45)",
        lineWidth: 1,
        lineStyle: LineStyle.Dotted,
        axisLabelVisible: false,
      });

      const rsiDivs =
        oscPrefs.showDivergences
          ? detectDivergences(cleanBars, rsiPoints, {
              ...balancedDivergenceOptions(timeframe, "rsi", "rsi", false, false, "wick"),
              includeHidden: false,
            }).filter((d) => d.endTime >= displayStartTime)
          : [];
      if (rsiDivs.length > 0) {
        rsiSeries.attachPrimitive(
          new OscillatorPanePrimitive(
            {
              kind: "rsi",
              title: "RSI",
              headerValues: [],
              divergences: rsiDivs,
              hideHeader: true,
              pricePrecision: pipDigits,
              isDark,
            },
            0,
            100,
          ),
        );
      }
    }

    // ── 4. MACD Chart Pane (Hist + MACD + Signal + Zero line + Divergences) ──
    const chartMacd = createChart(macdDiv, {
      width: TOTAL_W,
      height: MACD_H,
      layout: commonLayout,
      grid: commonGrid,
      rightPriceScale: {
        borderColor: isDark ? "#334155" : "#cbd5e1",
        minimumWidth: 80,
        autoScale: true,
        scaleMargins: { top: 0.15, bottom: 0.15 },
      },
      timeScale: {
        visible: true,
        timeVisible: true,
        borderColor: isDark ? "#334155" : "#cbd5e1",
        fixLeftEdge: true,
        fixRightEdge: true,
      },
    });
    chartsToClean.push(chartMacd);

    const macdResult = macd(cleanBars, macdFast, macdSlow, macdSignal);
    if (macdResult && macdResult.macd.length > 0) {
      const macdHistSeries = chartMacd.addHistogramSeries({
        priceLineVisible: false,
        lastValueVisible: false,
      });
      const validHist = macdResult.histogram.filter(
        (h) => Number.isFinite(h.value) && Number.isFinite(h.time),
      );
      const histColorByTime = new Map<number, { value: number; color: string }>();
      for (let idx = 0; idx < validHist.length; idx++) {
        const h = validHist[idx]!;
        const prev = idx > 0 ? validHist[idx - 1]!.value : h.value;
        const rising = h.value >= prev;
        const color =
          h.value >= 0
            ? rising
              ? "#00E676"
              : "#A7F3D0"
            : !rising
              ? "#FF1744"
              : "#FF8A80";
        histColorByTime.set(h.time, { value: h.value, color });
      }
      macdHistSeries.setData(
        displayBars.map((b) => {
          const entry = histColorByTime.get(b.time);
          return entry
            ? { time: b.time as UTCTimestamp, value: entry.value, color: entry.color }
            : { time: b.time as UTCTimestamp };
        }),
      );

      const macdMap = new Map(
        macdResult.macd
          .filter((m) => Number.isFinite(m.value) && Number.isFinite(m.time))
          .map((m) => [m.time, m.value]),
      );
      const macdLineSeries = chartMacd.addLineSeries({
        color: "#2962FF",
        lineWidth: 2,
        priceLineVisible: false,
        lastValueVisible: true,
      });
      macdLineSeries.setData(
        displayBars.map((b) => {
          const val = macdMap.get(b.time);
          return val !== undefined ? { time: b.time as UTCTimestamp, value: val } : { time: b.time as UTCTimestamp };
        }),
      );

      const sigMap = new Map(
        macdResult.signal
          .filter((s) => Number.isFinite(s.value) && Number.isFinite(s.time))
          .map((s) => [s.time, s.value]),
      );
      const macdSigSeries = chartMacd.addLineSeries({
        color: "#FF6D00",
        lineWidth: 2,
        priceLineVisible: false,
        lastValueVisible: true,
      });
      macdSigSeries.setData(
        displayBars.map((b) => {
          const val = sigMap.get(b.time);
          return val !== undefined ? { time: b.time as UTCTimestamp, value: val } : { time: b.time as UTCTimestamp };
        }),
      );

      macdHistSeries.createPriceLine({
        price: 0,
        color: isDark ? "rgba(203, 213, 225, 0.4)" : "rgba(100, 116, 139, 0.4)",
        lineWidth: 1,
        lineStyle: LineStyle.Dotted,
        axisLabelVisible: false,
      });

      const rawMacdDivs = !oscPrefs.showDivergences
        ? []
        : detectDivergences(cleanBars, macdResult.histogram, {
            ...balancedDivergenceOptions(
              timeframe,
              "macd",
              "histogram",
              true,
              false,
              "wick",
            ),
            includeHidden: false,
          });

      const macdDivs = rawMacdDivs.filter((d) => d.endTime >= displayStartTime);

      if (macdDivs.length > 0) {
        const displayMacdVals = displayBars.flatMap((b) => {
          const mv = macdMap.get(b.time);
          const hv = histColorByTime.get(b.time)?.value;
          return [mv, hv].filter((v): v is number => typeof v === "number" && Number.isFinite(v));
        });
        const minMacd = displayMacdVals.length > 0 ? Math.min(...displayMacdVals) : -1;
        const maxMacd = displayMacdVals.length > 0 ? Math.max(...displayMacdVals) : 1;
        macdLineSeries.attachPrimitive(
          new OscillatorPanePrimitive(
            {
              kind: "macd",
              title: "MACD",
              headerValues: [],
              divergences: macdDivs,
              hideHeader: true,
              pricePrecision: pipDigits,
              isDark,
            },
            minMacd,
            maxMacd,
          ),
        );
      }
    }

    // Horizontal time alignment across all panes
    chartPrice.timeScale().fitContent();
    chartRsi.timeScale().fitContent();
    chartMacd.timeScale().fitContent();

    // Allow lightweight-charts canvas to complete painting across frames
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 150);
    });

    const effectiveWatermarkTime =
      typeof effectiveMaxTimeSec === "number" && effectiveMaxTimeSec > 0
        ? effectiveMaxTimeSec
        : cleanBars.length > 0
          ? cleanBars[cleanBars.length - 1]!.time
          : undefined;

    const dataUrl = captureContainerCanvases(
      container,
      watermarkLabel,
      isDark,
      true,
      effectiveWatermarkTime,
      {
        rsiLabel: `RSI (${rsiPeriod})`,
        macdLabel: `MACD (${macdFast}, ${macdSlow}, ${macdSignal})`,
      },
    );
    return dataUrl;
  } catch (err) {
    console.warn(`[trade-screenshot] Error in captureOffscreenChart (${timeframe}):`, err);
    return "";
  } finally {
    for (const c of chartsToClean) {
      try {
        c.remove();
      } catch {
        // safe
      }
    }
    try {
      if (container.parentNode) {
        container.parentNode.removeChild(container);
      } else if (typeof container.remove === "function") {
        container.remove();
      }
    } catch {
      // safe
    }
  }
}

export async function captureDailyChart(
  symbol: string,
  isDark = true,
  maxTimeSec?: number,
): Promise<string> {
  const raw = await captureOffscreenChart(symbol, "1d", `${symbol} · 1D · DIARIO`, isDark, maxTimeSec);
  return (await saveScreenshotToDisk(raw, symbol, "1d")) || raw;
}

export async function captureFourHourChart(
  symbol: string,
  isDark = true,
  maxTimeSec?: number,
): Promise<string> {
  const raw = await captureOffscreenChart(symbol, "4h", `${symbol} · 4H · 4 HORAS`, isDark, maxTimeSec);
  return (await saveScreenshotToDisk(raw, symbol, "4h")) || raw;
}

export async function captureOneHourChart(
  symbol: string,
  isDark = true,
  maxTimeSec?: number,
): Promise<string> {
  const raw = await captureOffscreenChart(symbol, "1h", `${symbol} · 1H · 1 HORA`, isDark, maxTimeSec);
  return (await saveScreenshotToDisk(raw, symbol, "1h")) || raw;
}

/**
 * Automatically captures 1-Hour (1H), 4-Hour (4H), and Daily (1D) charts,
 * as well as the active on-screen timeframe. Synchronizes with historical replay if active.
 */
export async function captureTradeScreenshots(
  symbol: string,
  maxTimeSec?: number,
): Promise<{
  oneHourScreenshot?: string;
  fourHourScreenshot?: string;
  dailyScreenshot?: string;
  entryScreenshot?: string;
  entryTimeframe?: string;
}> {
  if (typeof document === "undefined" || typeof window === "undefined") {
    return {};
  }

  const effectiveMaxTime = maxTimeSec ?? getActiveReplayTimeSec();

  const isDark =
    document.documentElement.classList.contains("dark") ||
    !document.documentElement.classList.contains("light");

  let entryScreenshot: string | undefined;
  let entryTimeframe = "15m";

  // Capture current on-screen chart if available
  const container = document.getElementById("opencharts-main-chart-container");
  if (container) {
    const tf = container.getAttribute("data-timeframe") || "15m";
    entryTimeframe = tf;
    const chartSymbol = container.getAttribute("data-symbol") || symbol;
    const badge =
      tf === "1h"
        ? "1 HORA"
        : tf === "4h"
          ? "4 HORAS"
          : tf === "1d"
            ? "DIARIO"
            : "GATILLO DE ENTRADA";
    try {
      const dataUrl = captureContainerCanvases(
        container,
        `${chartSymbol} · ${tf.toUpperCase()} · ${badge}`,
        isDark,
        false,
        effectiveMaxTime,
      );
      if (dataUrl) {
        entryScreenshot = (await saveScreenshotToDisk(dataUrl, symbol, `entry_${tf}`)) || dataUrl;
      }
    } catch (err) {
      console.warn("[trade-screenshot] Failed to capture main chart canvases", err);
    }
  }

  // 1. Always capture clean 1H, 4H, and Daily charts offscreen (pure candles, volume, RSI, MACD without TP/SL order lines)
  let oneHourScreenshot: string | undefined;
  let fourHourScreenshot: string | undefined;
  let dailyScreenshot: string | undefined;
  try {
    const [h1Cap, fCap, dCap] = await Promise.all([
      captureOneHourChart(symbol, isDark, effectiveMaxTime),
      captureFourHourChart(symbol, isDark, effectiveMaxTime),
      captureDailyChart(symbol, isDark, effectiveMaxTime),
    ]);
    if (h1Cap) oneHourScreenshot = h1Cap;
    if (fCap) fourHourScreenshot = fCap;
    if (dCap) dailyScreenshot = dCap;
  } catch (err) {
    console.warn("[trade-screenshot] Failed to capture offscreen charts:", err);
  }

  if (!oneHourScreenshot) {
    try {
      oneHourScreenshot = await captureOneHourChart(symbol, isDark, effectiveMaxTime);
    } catch {
      /* fallback */
    }
  }
  if (!fourHourScreenshot) {
    try {
      fourHourScreenshot = await captureFourHourChart(symbol, isDark, effectiveMaxTime);
    } catch {
      /* fallback */
    }
  }
  if (!dailyScreenshot) {
    try {
      dailyScreenshot = await captureDailyChart(symbol, isDark, effectiveMaxTime);
    } catch {
      /* fallback */
    }
  }

  // 3. Absolute sanity guard: 4H and Daily MUST NEVER be identical images
  if (fourHourScreenshot && dailyScreenshot && fourHourScreenshot === dailyScreenshot) {
    if (entryTimeframe === "1d") {
      const raw4h = await captureOffscreenChart(symbol, "4h", `${symbol} · 4H · 4 HORAS`, isDark, effectiveMaxTime);
      fourHourScreenshot = (await saveScreenshotToDisk(raw4h, symbol, "4h")) || raw4h;
    } else {
      dailyScreenshot = await captureDailyChart(symbol, isDark, effectiveMaxTime);
    }
  }

  return {
    oneHourScreenshot,
    fourHourScreenshot,
    dailyScreenshot,
    entryScreenshot,
    entryTimeframe,
  };
}

