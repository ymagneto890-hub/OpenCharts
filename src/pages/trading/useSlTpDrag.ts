import { useState, useEffect, useRef, type RefObject } from "react";
import type { IChartApi, ISeriesApi, IPriceLine } from "lightweight-charts";
import type { DrawingTool } from "./constants.ts";

// ── Types ────────────────────────────────────────────────────

export interface DragPriceState {
  price: number;
  y: number;
  field: "TP" | "SL";
  pnlUsd: number;
  positionId?: string;
}

export interface SlTpLineEntry {
  positionId: string;
  field: "takeProfit" | "stopLoss";
  line: IPriceLine;
  price: number;
  entryPrice: number;
  quantity: number;
  side: string;
  isDragging?: boolean;
}

export interface SymbolInfo {
  contractSize?: number;
  [key: string]: unknown;
}

export function formatLineTitle(
  field: "takeProfit" | "stopLoss",
  _pnlUsd: number,
  _isDraft?: boolean,
): string {
  return field === "takeProfit" ? "TP" : "SL";
}

export interface UseSlTpDragResult {
  dragPrice: DragPriceState | null;
  startDragManual: (entry: SlTpLineEntry, clientY: number) => void;
}

// ── Hook ─────────────────────────────────────────────────────

export function useSlTpDrag(
  containerRef: RefObject<HTMLDivElement | null>,
  chartRef: RefObject<IChartApi | null>,
  candleSeriesRef: RefObject<ISeriesApi<"Candlestick"> | null>,
  slTpLinesRef: RefObject<Map<string, SlTpLineEntry>>,
  drawingTool: DrawingTool,
  onModifyPosition:
    | ((
        posId: string,
        mods: { takeProfit?: number | null; stopLoss?: number | null },
      ) => Promise<unknown> | void)
    | undefined,
  pipDigits: number,
  symbolInfo: SymbolInfo | null | undefined,
  chartEpoch: number,
): UseSlTpDragResult {
  const dragRef = useRef<{
    active: boolean;
    key: string;
    entry: SlTpLineEntry;
    positionId: string;
    field: "takeProfit" | "stopLoss";
    priceLine: IPriceLine;
    startPrice: number;
    entryPrice: number;
    quantity: number;
    side: string;
  } | null>(null);
  const [dragPrice, setDragPrice] = useState<DragPriceState | null>(null);

  const onModifyPositionRef = useRef(onModifyPosition);
  onModifyPositionRef.current = onModifyPosition;
  const pipDigitsRef = useRef(pipDigits);
  pipDigitsRef.current = pipDigits;
  const symbolInfoRef = useRef(symbolInfo);
  symbolInfoRef.current = symbolInfo;

  const draftRafRef = useRef<number | null>(null);
  const pendingDraftUpdateRef = useRef<{ field: "takeProfit" | "stopLoss"; price: number } | null>(
    null,
  );

  useEffect(() => {
    const container = containerRef.current;
    const chart = chartRef.current;
    const series = candleSeriesRef.current;
    if (!container || !chart || !series) return;

    const SNAP_PX = 18;

    const yToPrice = (clientY: number): number | null => {
      const rect = container.getBoundingClientRect();
      if (!rect || rect.height <= 0) return null;
      // Clamp between 4px and (rect.height - 4px) to ensure coordinateToPrice
      // never returns null when dragging cursor past top/bottom bounds of the chart
      const clampedY = Math.max(4, Math.min(rect.height - 4, clientY - rect.top));
      const price = series.coordinateToPrice(clampedY);
      return typeof price === "number" && isFinite(price) && price > 0 ? price : null;
    };

    const computePnl = (
      targetPrice: number,
      entryPrice: number,
      side: string,
      quantity: number,
    ): number => {
      const cSize = symbolInfoRef.current?.contractSize ?? 1;
      const dir = side === "LONG" ? 1 : -1;
      return parseFloat(((targetPrice - entryPrice) * dir * quantity * cSize).toFixed(2));
    };

    const findNearestLine = (
      clientY: number,
    ): { key: string; entry: SlTpLineEntry; dist: number } | null => {
      const rect = container.getBoundingClientRect();
      const mouseY = clientY - rect.top;
      let closest: { key: string; entry: SlTpLineEntry; dist: number } | null = null;

      for (const [key, entry] of slTpLinesRef.current) {
        const lineY = series.priceToCoordinate(entry.price);
        if (lineY === null || lineY === undefined) continue;
        const dist = Math.abs(mouseY - (lineY as number));
        if (dist <= SNAP_PX && (!closest || dist < closest.dist)) {
          closest = { key, entry, dist };
        }
      }
      return closest;
    };

    const handleMouseDown = (e: MouseEvent) => {
      if (e.button !== 0 || drawingTool !== "none") return;
      const nearest = findNearestLine(e.clientY);
      if (!nearest) return;

      e.preventDefault();
      e.stopPropagation();
      nearest.entry.isDragging = true;
      dragRef.current = {
        active: true,
        key: nearest.key,
        entry: nearest.entry,
        positionId: nearest.entry.positionId,
        field: nearest.entry.field,
        priceLine: nearest.entry.line,
        startPrice: nearest.entry.price,
        entryPrice: nearest.entry.entryPrice,
        quantity: nearest.entry.quantity,
        side: nearest.entry.side,
      };
      chart.applyOptions({
        handleScroll: {
          mouseWheel: false,
          pressedMouseMove: false,
          horzTouchDrag: false,
          vertTouchDrag: false,
        },
      });
      container.style.cursor = "ns-resize";
    };

    const handleMouseMove = (e: MouseEvent) => {
      const drag = dragRef.current;

      if (drag?.active) {
        const price = yToPrice(e.clientY);
        if (price !== null) {
          const rounded = parseFloat(price.toFixed(pipDigitsRef.current));
          drag.entry.price = rounded;
          const pnlUsd = computePnl(rounded, drag.entryPrice, drag.side, drag.quantity);

          try {
            drag.priceLine.applyOptions({
              price: rounded,
              title: formatLineTitle(drag.field, pnlUsd, drag.positionId === "__draft__"),
            });
          } catch {
            /* line may have been recreated */
          }

          const rect = container.getBoundingClientRect();
          setDragPrice({
            price: rounded,
            y: Math.max(0, Math.min(rect.height, e.clientY - rect.top)),
            field: drag.field === "takeProfit" ? "TP" : "SL",
            pnlUsd,
            positionId: drag.positionId,
          });

          // Ultra-fast 60/120fps synchronized update for draft orders
          if (drag.positionId === "__draft__" && onModifyPositionRef.current) {
            pendingDraftUpdateRef.current = { field: drag.field, price: rounded };
            if (draftRafRef.current === null) {
              draftRafRef.current = requestAnimationFrame(() => {
                draftRafRef.current = null;
                if (pendingDraftUpdateRef.current && onModifyPositionRef.current) {
                  const { field, price: p } = pendingDraftUpdateRef.current;
                  onModifyPositionRef.current("__draft__", { [field]: p });
                }
              });
            }
          }
        }
        return;
      }

      // Cursor hover feedback when inside container
      if (e.target && container.contains(e.target as Node)) {
        const nearest = findNearestLine(e.clientY);
        if (nearest && drawingTool === "none") {
          container.style.cursor = "ns-resize";
        } else if (drawingTool === "none" && container.style.cursor === "ns-resize") {
          container.style.cursor = "default";
        }
      }
    };

    const handleMouseUp = (e: MouseEvent) => {
      const drag = dragRef.current;
      if (!drag?.active) return;

      if (draftRafRef.current !== null) {
        cancelAnimationFrame(draftRafRef.current);
        draftRafRef.current = null;
      }
      pendingDraftUpdateRef.current = null;

      const rawPrice = yToPrice(e.clientY);
      const newPrice = rawPrice ?? drag.entry.price;
      for (const e of slTpLinesRef.current.values()) {
        e.isDragging = false;
      }
      drag.entry.isDragging = false;
      dragRef.current = null;
      setDragPrice(null);

      chart.applyOptions({
        handleScroll: {
          mouseWheel: false,
          pressedMouseMove: true,
          horzTouchDrag: true,
          vertTouchDrag: true,
        },
      });
      container.style.cursor = "default";

      const revertLine = () => {
        drag.entry.price = drag.startPrice;
        const startPnl = computePnl(drag.startPrice, drag.entryPrice, drag.side, drag.quantity);
        try {
          drag.priceLine.applyOptions({
            price: drag.startPrice,
            title: formatLineTitle(drag.field, startPnl, drag.positionId === "__draft__"),
          });
        } catch {
          /* ignore */
        }
      };

      if (newPrice === null || !Number.isFinite(newPrice)) {
        revertLine();
        return;
      }
      const rounded = parseFloat(newPrice.toFixed(pipDigitsRef.current));

      if (Math.abs(rounded - drag.startPrice) < Math.pow(10, -pipDigitsRef.current)) {
        revertLine();
        return;
      }

      drag.entry.price = rounded;
      if (onModifyPositionRef.current) {
        try {
          const maybePromise = onModifyPositionRef.current(drag.positionId, {
            [drag.field]: rounded,
          });
          if (maybePromise && typeof (maybePromise as Promise<unknown>).catch === "function") {
            (maybePromise as Promise<unknown>).catch(() => {
              revertLine();
            });
          }
        } catch {
          revertLine();
        }
      }
    };

    const handleCancel = () => {
      const drag = dragRef.current;
      if (!drag?.active) return;
      if (draftRafRef.current !== null) {
        cancelAnimationFrame(draftRafRef.current);
        draftRafRef.current = null;
      }
      pendingDraftUpdateRef.current = null;
      drag.entry.price = drag.startPrice;
      const revertedPnl = computePnl(drag.startPrice, drag.entryPrice, drag.side, drag.quantity);
      try {
        drag.priceLine.applyOptions({
          price: drag.startPrice,
          title: formatLineTitle(drag.field, revertedPnl, drag.positionId === "__draft__"),
        });
      } catch {
        /* line may have been recreated */
      }
      if (drag.positionId === "__draft__" && onModifyPositionRef.current) {
        onModifyPositionRef.current("__draft__", { [drag.field]: drag.startPrice });
      }
      for (const e of slTpLinesRef.current.values()) {
        e.isDragging = false;
      }
      drag.entry.isDragging = false;
      dragRef.current = null;
      setDragPrice(null);
      try {
        chart.applyOptions({
          handleScroll: {
            mouseWheel: false,
            pressedMouseMove: true,
            horzTouchDrag: true,
            vertTouchDrag: true,
          },
        });
      } catch {
        /* chart may be disposed */
      }
      container.style.cursor = "default";
    };

    container.addEventListener("mousedown", handleMouseDown, true);
    // Listen on window for mousemove and mouseup so dragging never freezes/drops
    // when cursor moves over badges, overlays, side panels, or outside the canvas!
    window.addEventListener("mousemove", handleMouseMove, { passive: true });
    window.addEventListener("mouseup", handleMouseUp);
    window.addEventListener("blur", handleCancel);

    return () => {
      handleCancel();
      container.removeEventListener("mousedown", handleMouseDown, true);
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
      window.removeEventListener("blur", handleCancel);
      if (draftRafRef.current !== null) {
        cancelAnimationFrame(draftRafRef.current);
        draftRafRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drawingTool, chartEpoch]);

  const startDragManual = (entry: SlTpLineEntry, clientY: number) => {
    const container = containerRef.current;
    const chart = chartRef.current;
    const series = candleSeriesRef.current;
    if (!container || !chart || !series) return;

    entry.isDragging = true;
    for (const v of slTpLinesRef.current.values()) {
      if (v.positionId === entry.positionId && v.field === entry.field) {
        v.isDragging = true;
        break;
      }
    }
    dragRef.current = {
      active: true,
      key: `${entry.positionId}:${entry.field === "takeProfit" ? "tp" : "sl"}`,
      entry,
      positionId: entry.positionId,
      field: entry.field,
      priceLine: entry.line,
      startPrice: entry.price,
      entryPrice: entry.entryPrice,
      quantity: entry.quantity,
      side: entry.side,
    };

    chart.applyOptions({
      handleScroll: {
        mouseWheel: false,
        pressedMouseMove: false,
        horzTouchDrag: false,
        vertTouchDrag: false,
      },
    });
    container.style.cursor = "ns-resize";

    const cSize = symbolInfoRef.current?.contractSize ?? 1;
    const dir = entry.side === "LONG" ? 1 : -1;
    const pnlUsd = parseFloat(((entry.price - entry.entryPrice) * dir * entry.quantity * cSize).toFixed(2));
    const rect = container.getBoundingClientRect();
    setDragPrice({
      price: entry.price,
      y: clientY - rect.top,
      field: entry.field === "takeProfit" ? "TP" : "SL",
      pnlUsd,
      positionId: entry.positionId,
    });
  };

  return { dragPrice, startDragManual };
}
