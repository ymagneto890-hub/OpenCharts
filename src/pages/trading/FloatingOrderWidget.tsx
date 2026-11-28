import { useState, useEffect, useMemo, useRef } from "react";
import {
  Minus,
  Plus,
  TrendingUp,
  TrendingDown,
  X,
  Minimize2,
  Maximize2,
  Zap,
  GripHorizontal,
  Calculator,
  ShieldAlert,
  Loader2,
  FileText,
} from "lucide-react";
import { usePlaceOrder } from "../../services/queries.ts";
import { Button } from "../../components/ui/button.tsx";
import type { PlaceOrderInput } from "../../services/schemas.ts";
import type { DraftOrderSlTpPreview } from "./ChartPanel.tsx";
import { toast } from "../../services/toast.ts";
import { cn, formatCurrency } from "../../lib/utils.ts";
import { getPipDigits } from "./utils.ts";
import { extractBaseAsset } from "../../hooks/useInstrumentLabels.ts";
import { getDemoSymbol } from "../../services/demo/instruments.ts";
import { getSettings, getAccount, subscribeEngine, DEFAULT_FEE_RATE } from "../../services/demo/engine.ts";

export interface FloatingOrderWidgetProps {
  symbol: string;
  symbolInfo?: {
    name?: string;
    tickSize?: number | string;
    contractSize?: number;
    marginPercent?: number;
    [k: string]: unknown;
  };
  tick?: { bid: number; ask: number; timestamp: number };
  accountId: string | null;
  accountBalance?: number;
  oneClick?: boolean;
  onToggleOneClick?: () => void;
  onConfirmOrder?: (order: PlaceOrderInput & { _submit: () => Promise<unknown> }) => void;
  isFeedConnected?: boolean;
  onOrderSuccess?: () => void;
  onDraftPreviewChange?: (preview: DraftOrderSlTpPreview | null) => void;
  externalDraftSlTp?: { takeProfit?: number | null; stopLoss?: number | null; seq: number } | null;
  onClose?: () => void;
}

function getSymbolUnitPresets(
  baseUnit: string,
  symbolName?: string,
  refPrice?: number,
): {
  defaultQty: string;
  step: number;
  presets: number[];
} {
  const u = baseUnit.toUpperCase();
  if (u === "BTC") {
    return { defaultQty: "0.005", step: 0.001, presets: [0.001, 0.005, 0.01, 0.05, 0.1] };
  }
  if (u === "ETH" || u === "BNB") {
    return { defaultQty: "0.05", step: 0.01, presets: [0.01, 0.05, 0.1, 0.5, 1] };
  }
  if (u === "SOL" || u === "AVAX") {
    return { defaultQty: "1", step: 0.1, presets: [0.1, 0.5, 1, 5, 10] };
  }
  if (u === "DOT" || u === "LINK") {
    return { defaultQty: "10", step: 1, presets: [1, 5, 10, 25, 50] };
  }
  if (u === "XRP" || u === "ADA" || u === "DOGE") {
    return { defaultQty: "100", step: 10, presets: [50, 100, 250, 500, 1000] };
  }

  const symMeta = symbolName ? getDemoSymbol(symbolName) : undefined;
  if (symMeta?.category === "STOCKS") {
    return { defaultQty: "5", step: 1, presets: [1, 5, 10, 25, 50] };
  }
  if (symMeta?.category === "FOREX") {
    return { defaultQty: "100", step: 50, presets: [50, 100, 500, 1000, 5000] };
  }
  if (symMeta?.category === "INDICES" || symMeta?.category === "COMMODITIES") {
    return { defaultQty: "1", step: 0.1, presets: [0.1, 0.5, 1, 2, 5] };
  }

  const p = refPrice && refPrice > 0 ? refPrice : (symMeta?.initialPrice ?? 0);
  if (p > 0) {
    if (p < 0.0005) {
      return {
        defaultQty: "10000000",
        step: 1000000,
        presets: [1000000, 5000000, 10000000, 25000000, 50000000],
      };
    }
    if (p < 0.05) {
      return { defaultQty: "10000", step: 1000, presets: [1000, 5000, 10000, 25000, 50000] };
    }
    if (p < 1) {
      return { defaultQty: "200", step: 50, presets: [50, 100, 200, 500, 1000] };
    }
    if (p < 20) {
      return { defaultQty: "10", step: 1, presets: [5, 10, 25, 50, 100] };
    }
    if (p < 500) {
      return { defaultQty: "1", step: 0.1, presets: [0.5, 1, 2, 5, 10] };
    }
  }
  return { defaultQty: "0.01", step: 0.001, presets: [0.001, 0.005, 0.01, 0.1, 1] };
}

export function FloatingOrderWidget({
  symbol,
  symbolInfo,
  tick,
  accountId,
  accountBalance,
  oneClick = true,
  onToggleOneClick: _onToggleOneClick,
  onConfirmOrder,
  isFeedConnected = true,
  onOrderSuccess,
  onDraftPreviewChange,
  externalDraftSlTp,
  onClose,
}: FloatingOrderWidgetProps) {
  const baseUnit = useMemo(() => extractBaseAsset(symbol), [symbol]);
  const unitConfig = useMemo(
    () => getSymbolUnitPresets(baseUnit, symbol, tick?.bid),
    [baseUnit, symbol, tick?.bid],
  );
  const pipDigits = useMemo(() => getPipDigits(symbolInfo, symbol), [symbolInfo, symbol]);

  const [side, setSide] = useState<"BUY" | "SELL">("BUY");
  const [quantity, setQuantity] = useState(unitConfig.defaultQty);
  const [isMinimized, setIsMinimized] = useState(false);

  // Take Profit and Stop Loss are always active on Market Order (controlled via chart drag)
  const [tpEnabled, setTpEnabled] = useState(true);
  const [takeProfit, setTakeProfit] = useState("");
  const [slEnabled, setSlEnabled] = useState(true);
  const [stopLoss, setStopLoss] = useState("");
  const [notes, setNotes] = useState("");
  const userDraggedTpRef = useRef(false);
  const userDraggedSlRef = useRef(false);

  const [isSubmitting, setIsSubmitting] = useState(false);
  const isSubmittingRef = useRef(false);

  const placeOrder = usePlaceOrder();

  const bid = tick?.bid ?? 0;
  const ask = tick?.ask ?? 0;
  const refPrice = side === "BUY" ? (ask > 0 ? ask : bid) : (bid > 0 ? bid : ask);

  // ── Risk-Based Position Size Calculator State & Calculations ──
  const [showRiskCalc, setShowRiskCalc] = useState(false);
  const [riskPercent, setRiskPercent] = useState("1");
  const [includeFeesInRisk, setIncludeFeesInRisk] = useState(true);
  const [feeRate, setFeeRate] = useState(() => {
    try {
      return getSettings().feeRate ?? DEFAULT_FEE_RATE;
    } catch {
      return DEFAULT_FEE_RATE;
    }
  });

  useEffect(() => {
    return subscribeEngine(() => {
      try {
        setFeeRate(getSettings().feeRate ?? DEFAULT_FEE_RATE);
      } catch {
        // ignore
      }
    });
  }, []);

  const effectiveBalance = useMemo(() => {
    if (accountBalance && accountBalance > 0) return accountBalance;
    try {
      return getAccount().balance || 10_000;
    } catch {
      return 10_000;
    }
  }, [accountBalance]);

  const contractSize = symbolInfo?.contractSize ?? 1;
  const rawRiskNum = parseFloat(riskPercent);
  const parsedRiskPct =
    Number.isFinite(rawRiskNum) && rawRiskNum > 0
      ? Math.min(100, Math.max(0.01, rawRiskNum))
      : 1;
  const targetRiskDollar = (effectiveBalance * parsedRiskPct) / 100;

  const currentSlNum = slEnabled ? parseFloat(stopLoss) : NaN;
  const isSlValid =
    Number.isFinite(currentSlNum) &&
    currentSlNum > 0 &&
    refPrice > 0 &&
    (side === "BUY" ? currentSlNum < refPrice : currentSlNum > refPrice);

  const slDistance =
    refPrice > 0 && Number.isFinite(currentSlNum)
      ? Math.abs(refPrice - currentSlNum)
      : 0;
  const slDistancePct =
    refPrice > 0 && slDistance > 0 ? (slDistance / refPrice) * 100 : 0;

  // Round-trip commission factor (entry taker fee + exit taker fee)
  const roundTripFeeFactor = includeFeesInRisk
    ? 2 * feeRate * refPrice * contractSize
    : 0;

  const effectiveLossPerUnit =
    slDistance > 0 ? slDistance * contractSize + roundTripFeeFactor : 0;

  const calculatedRawUnits =
    effectiveLossPerUnit > 0 ? targetRiskDollar / effectiveLossPerUnit : 0;

  const stepDecimals = Math.max(
    (String(unitConfig.step).split(".")[1] || "").length,
    unitConfig.step < 1 ? 6 : 2,
  );

  const floorRiskUnits = (raw: number, dec: number): number => {
    if (!Number.isFinite(raw) || raw <= 0) return 0;
    const factor = 10 ** dec;
    const floored = Math.floor(raw * factor + 1e-9) / factor;
    return floored > 0 ? floored : Number(raw.toFixed(6));
  };

  const calculatedUnits =
    isSlValid && slDistance > 0 && calculatedRawUnits > 0 && Number.isFinite(calculatedRawUnits)
      ? floorRiskUnits(calculatedRawUnits, stepDecimals)
      : 0;

  const calcNotional = calculatedUnits * refPrice * contractSize;
  const calcMargin = calcNotional * ((symbolInfo?.marginPercent ?? 1) / 100);
  const calcTotalFees = calcNotional * feeRate * 2;

  const handleApplyRiskSize = (pct?: number) => {
    const targetPct = pct ?? parsedRiskPct;
    if (pct != null) setRiskPercent(String(pct));

    if (!(refPrice > 0)) {
      toast.warning(
        "Precio no disponible",
        "Espera a recibir precio de mercado para calcular la orden.",
      );
      return;
    }

    if (!slEnabled || isNaN(currentSlNum) || currentSlNum <= 0) {
      toast.warning(
        "Stop Loss no configurado",
        "Para calcular el tamaño por riesgo debes activar y definir el Stop Loss primero.",
      );
      setShowRiskCalc(true);
      return;
    }

    if (side === "BUY" && currentSlNum >= refPrice) {
      toast.warning(
        "Stop Loss inválido",
        "En compras (BUY), el Stop Loss debe estar por debajo del precio de entrada.",
      );
      return;
    }

    if (side === "SELL" && currentSlNum <= refPrice) {
      toast.warning(
        "Stop Loss inválido",
        "En ventas (SELL), el Stop Loss debe estar por encima del precio de entrada.",
      );
      return;
    }

    const tRisk = (effectiveBalance * targetPct) / 100;
    const rTrip = includeFeesInRisk ? 2 * feeRate * refPrice * contractSize : 0;
    const lossPerUnit = slDistance * contractSize + rTrip;
    if (lossPerUnit <= 0) return;

    const raw = tRisk / lossPerUnit;
    const finalUnits = floorRiskUnits(raw, stepDecimals);
    if (!(finalUnits > 0)) {
      toast.warning(
        "Riesgo insuficiente para el tamaño mínimo",
        "El capital arriesgado es demasiado pequeño para la distancia de Stop Loss seleccionada.",
      );
      return;
    }

    setQuantity(String(finalUnits));
    toast.success(
      `Riesgo ${targetPct}% aplicado`,
      `Tamaño fijado en ${finalUnits} ${baseUnit} (${formatCurrency(finalUnits * refPrice * contractSize)}) para arriesgar máx. ${formatCurrency(tRisk)} en SL`,
    );
  };

  const handleSuggestSl = (distancePercent: number) => {
    if (!(refPrice > 0)) return;
    const factor = side === "BUY" ? 1 - distancePercent / 100 : 1 + distancePercent / 100;
    const suggestedPrice = refPrice * factor;
    const formatted = parseFloat(suggestedPrice.toFixed(pipDigits));
    setSlEnabled(true);
    userDraggedSlRef.current = true;
    setStopLoss(String(formatted));

    const slDist = Math.abs(refPrice - formatted);
    const tRisk = (effectiveBalance * parsedRiskPct) / 100;
    const rTrip = includeFeesInRisk ? 2 * feeRate * refPrice * contractSize : 0;
    const lossPerUnit = slDist * contractSize + rTrip;
    if (lossPerUnit > 0) {
      const raw = tRisk / lossPerUnit;
      const finalUnits = floorRiskUnits(raw, stepDecimals);
      if (finalUnits > 0) {
        setQuantity(String(finalUnits));
        toast.success(
          `SL al ${distancePercent}% y riesgo ${parsedRiskPct}% fijado`,
          `Stop Loss en ${formatted} y tamaño en ${finalUnits} ${baseUnit} (riesgo máx: ${formatCurrency(tRisk)})`,
        );
      }
    }
  };

  // Reset default qty and symbol-specific TP/SL ONLY when symbol changes
  const prevSymbolRef = useRef(symbol);
  const defaultQtyRef = useRef(unitConfig.defaultQty);
  defaultQtyRef.current = unitConfig.defaultQty;

  useEffect(() => {
    if (prevSymbolRef.current === symbol) return;
    prevSymbolRef.current = symbol;
    setQuantity(defaultQtyRef.current);
    setTpEnabled(true);
    setTakeProfit("");
    setSlEnabled(true);
    setStopLoss("");
    userDraggedTpRef.current = false;
    userDraggedSlRef.current = false;
    setNotes("");
  }, [symbol]);

  // Auto-populate and keep default TP & SL valid whenever refPrice > 0
  useEffect(() => {
    if (!(refPrice > 0)) return;
    const curTp = parseFloat(takeProfit);
    const tpValid =
      Number.isFinite(curTp) &&
      curTp > 0 &&
      (side === "BUY" ? curTp > refPrice : curTp < refPrice);
    if (!userDraggedTpRef.current || !tpValid) {
      const defaultTp = refPrice * (side === "BUY" ? 1.015 : 0.985);
      const nextTpStr = defaultTp.toFixed(pipDigits);
      if (nextTpStr !== takeProfit) {
        setTakeProfit(nextTpStr);
      }
    }

    const curSl = parseFloat(stopLoss);
    const slValid =
      Number.isFinite(curSl) &&
      curSl > 0 &&
      (side === "BUY" ? curSl < refPrice : curSl > refPrice);
    if (!userDraggedSlRef.current || !slValid) {
      const defaultSl = refPrice * (side === "BUY" ? 0.99 : 1.01);
      const nextSlStr = defaultSl.toFixed(pipDigits);
      if (nextSlStr !== stopLoss) {
        setStopLoss(nextSlStr);
      }
    }
  }, [refPrice, side, pipDigits, takeProfit, stopLoss]);

  // Clear draft preview lines when widget unmounts
  useEffect(() => {
    return () => {
      onDraftPreviewChange?.(null);
    };
  }, [onDraftPreviewChange]);

  const isExternalUpdateRef = useRef(false);

  // Synchronize when external drag on chart updates SL/TP
  useEffect(() => {
    if (!externalDraftSlTp) return;
    isExternalUpdateRef.current = true;
    if (externalDraftSlTp.takeProfit !== undefined && externalDraftSlTp.takeProfit !== null) {
      setTpEnabled(true);
      userDraggedTpRef.current = true;
      setTakeProfit(externalDraftSlTp.takeProfit.toFixed(pipDigits));
    }
    if (externalDraftSlTp.stopLoss !== undefined && externalDraftSlTp.stopLoss !== null) {
      setSlEnabled(true);
      userDraggedSlRef.current = true;
      setStopLoss(externalDraftSlTp.stopLoss.toFixed(pipDigits));
    }
  }, [externalDraftSlTp, pipDigits]);

  const handleSideChange = (nextSide: "BUY" | "SELL") => {
    setSide(nextSide);
    userDraggedTpRef.current = false;
    userDraggedSlRef.current = false;
    if (refPrice > 0) {
      const defaultTp = refPrice * (nextSide === "BUY" ? 1.015 : 0.985);
      setTakeProfit(defaultTp.toFixed(pipDigits));
      const defaultSl = refPrice * (nextSide === "BUY" ? 0.99 : 1.01);
      setStopLoss(defaultSl.toFixed(pipDigits));
    }
  };

  // Emit draft preview to chart so lines and badge sliders appear and can be dragged
  useEffect(() => {
    if (isExternalUpdateRef.current) {
      isExternalUpdateRef.current = false;
      return;
    }
    if (!onDraftPreviewChange) return;
    if ((!tpEnabled && !slEnabled) || !(refPrice > 0)) {
      onDraftPreviewChange(null);
      return;
    }
    const qtyNum = parseFloat(quantity);
    const tpNum = tpEnabled ? parseFloat(takeProfit) : null;
    const slNum = slEnabled ? parseFloat(stopLoss) : null;
    onDraftPreviewChange({
      side,
      entryPrice: refPrice,
      quantity: Number.isFinite(qtyNum) && qtyNum > 0 ? qtyNum : Number(unitConfig.defaultQty),
      takeProfit: tpNum && Number.isFinite(tpNum) && tpNum > 0 ? tpNum : null,
      stopLoss: slNum && Number.isFinite(slNum) && slNum > 0 ? slNum : null,
    });
  }, [
    onDraftPreviewChange,
    tpEnabled,
    slEnabled,
    takeProfit,
    stopLoss,
    side,
    refPrice,
    quantity,
    unitConfig.defaultQty,
  ]);

  const handleSubmit = async () => {
    if (isSubmittingRef.current || placeOrder.isPending) return;
    if (!isFeedConnected) {
      toast.warning("Sin conexión", "No se pueden enviar órdenes sin feed de datos");
      return;
    }
    if (!accountId) {
      toast.warning("Sin cuenta", "Selecciona una cuenta primero");
      return;
    }
    const qty = parseFloat(quantity);
    if (!Number.isFinite(qty) || qty <= 0) {
      toast.warning("Cantidad inválida", `Introduce una cantidad válida en ${baseUnit}`);
      return;
    }
    if (qty > 1e12) {
      toast.warning("Cantidad excesiva", `La cantidad excede el límite por orden en ${baseUnit}`);
      return;
    }

    const input: PlaceOrderInput = {
      accountId,
      symbol,
      side,
      type: "MARKET",
      quantity: qty,
    };

    if (tpEnabled && takeProfit) input.takeProfit = parseFloat(takeProfit) || undefined;
    if (slEnabled && stopLoss) input.stopLoss = parseFloat(stopLoss) || undefined;
    if (notes.trim()) input.notes = notes.trim();

    const execute = async () => {
      isSubmittingRef.current = true;
      setIsSubmitting(true);
      try {
        return await placeOrder.mutateAsync(input, {
          onSuccess: () => {
            toast.success("Orden ejecutada", `${side === "BUY" ? "Compra" : "Venta"} a mercado: ${qty} ${baseUnit}`);
            setNotes("");
            onOrderSuccess?.();
          },
          onError: (err: unknown) => {
            const e = err as { error?: { message?: string }; message?: string };
            toast.error("Error en la orden", e?.error?.message || e?.message || "No se pudo ejecutar la orden");
          },
        });
      } finally {
        isSubmittingRef.current = false;
        setIsSubmitting(false);
      }
    };

    if (!oneClick && onConfirmOrder) {
      onConfirmOrder({
        ...input,
        _submit: execute,
      });
      return;
    }

    try {
      await execute();
    } catch {
      // Handled in onError
    }
  };

  // Position dragging on screen with direct GPU transform & 0ms lag
  const [pos, setPos] = useState({ x: 20, y: 56 });
  const posRef = useRef(pos);
  posRef.current = pos;
  const widgetRef = useRef<HTMLDivElement>(null);
  const isDraggingWidgetRef = useRef(false);
  const dragStartRef = useRef({ x: 0, y: 0, posX: 0, posY: 0 });
  const dragCleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    return () => {
      dragCleanupRef.current?.();
      dragCleanupRef.current = null;
    };
  }, []);

  const handlePointerDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest("button, input, select, a")) return;
    e.preventDefault();
    dragCleanupRef.current?.();
    isDraggingWidgetRef.current = true;
    dragStartRef.current = {
      x: e.clientX,
      y: e.clientY,
      posX: posRef.current.x,
      posY: posRef.current.y,
    };

    let targetX = posRef.current.x;
    let targetY = posRef.current.y;

    const onPointerMove = (ev: PointerEvent) => {
      if (!isDraggingWidgetRef.current) return;
      const dx = ev.clientX - dragStartRef.current.x;
      const dy = ev.clientY - dragStartRef.current.y;
      const rectW = widgetRef.current?.offsetWidth ?? 300;
      const rectH = widgetRef.current?.offsetHeight ?? 360;
      const maxX = typeof window !== "undefined" ? Math.max(8, window.innerWidth - rectW - 8) : 9999;
      const maxY = typeof window !== "undefined" ? Math.max(40, window.innerHeight - Math.min(rectH, 80) - 8) : 9999;
      targetX = Math.min(maxX, Math.max(8, dragStartRef.current.posX + dx));
      targetY = Math.min(maxY, Math.max(40, dragStartRef.current.posY + dy));
      if (widgetRef.current) {
        widgetRef.current.style.transform = `translate3d(${targetX}px, ${targetY}px, 0)`;
      }
    };

    const cleanup = () => {
      isDraggingWidgetRef.current = false;
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
      if (dragCleanupRef.current === cleanup) dragCleanupRef.current = null;
    };

    const onPointerUp = () => {
      if (!isDraggingWidgetRef.current) return;
      cleanup();
      setPos({ x: targetX, y: targetY });
    };

    dragCleanupRef.current = cleanup;
    window.addEventListener("pointermove", onPointerMove, { passive: true });
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);
  };

  // Calculations
  const qtyVal = parseFloat(quantity) || 0;
  const notionalUsd = qtyVal * contractSize * refPrice;

  const tpVal = tpEnabled ? parseFloat(takeProfit) : NaN;
  const slVal = slEnabled ? parseFloat(stopLoss) : NaN;
  const tpProfit =
    !isNaN(tpVal) && refPrice > 0
      ? (tpVal - refPrice) * (side === "BUY" ? 1 : -1) * qtyVal * contractSize
      : null;
  const slLoss =
    !isNaN(slVal) && refPrice > 0
      ? (slVal - refPrice) * (side === "BUY" ? 1 : -1) * qtyVal * contractSize
      : null;

  const riskUsd = slLoss !== null ? Math.abs(slLoss) : null;
  const rewardUsd = tpProfit !== null ? Math.max(0, tpProfit) : null;
  const riskRewardRatio =
    riskUsd !== null && rewardUsd !== null && riskUsd > 0.001
      ? rewardUsd / riskUsd
      : null;

  if (isMinimized) {
    return (
      <div
        ref={widgetRef}
        onPointerDown={handlePointerDown}
        style={{
          transform: `translate3d(${pos.x}px, ${pos.y}px, 0)`,
          willChange: "transform",
          transition: "none",
          top: 0,
          left: 0,
        }}
        className="absolute z-30 flex items-center gap-2 px-3 py-1.5 rounded-lg bg-card/95 border border-border/90 shadow-xl text-xs font-mono select-none cursor-grab active:cursor-grabbing touch-none"
      >
        <span className="font-bold text-primary flex items-center gap-1.5">
          <Zap className="w-3.5 h-3.5" /> Orden Flotante ({symbol})
        </span>
        <button
          type="button"
          onClick={() => setIsMinimized(false)}
          className="p-1 hover:bg-secondary rounded text-muted-foreground hover:text-foreground transition-colors"
          title="Expandir orden flotante"
        >
          <Maximize2 className="w-3.5 h-3.5" />
        </button>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            className="p-1 hover:bg-[#f6465d]/20 hover:text-[#f6465d] rounded text-muted-foreground transition-colors"
            title="Cerrar orden flotante"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        )}
      </div>
    );
  }

  return (
    <div
      ref={widgetRef}
      style={{
        transform: `translate3d(${pos.x}px, ${pos.y}px, 0)`,
        willChange: "transform",
        transition: "none",
        top: 0,
        left: 0,
      }}
      className="absolute z-30 w-[370px] rounded-xl bg-card border border-border/90 shadow-2xl text-xs overflow-hidden select-none"
    >
      {/* ── Drag Header ── */}
      <div
        onPointerDown={handlePointerDown}
        className="flex items-center justify-between px-3.5 py-2.5 border-b border-border bg-secondary/60 cursor-grab active:cursor-grabbing text-muted-foreground select-none touch-none"
      >
        <div className="flex items-center gap-1.5 font-bold text-foreground text-xs tracking-wide">
          <GripHorizontal className="w-4 h-4 opacity-60" />
          <span>ORDEN A MERCADO ({symbol})</span>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setIsMinimized(true)}
            className="p-1 hover:bg-secondary rounded text-muted-foreground hover:text-foreground transition-colors"
            title="Minimizar orden flotante"
          >
            <Minimize2 className="w-3.5 h-3.5" />
          </button>
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              className="p-1 hover:bg-[#f6465d]/20 hover:text-[#f6465d] rounded text-muted-foreground transition-colors"
              title="Cerrar"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      <div className="p-3.5 space-y-3">
        {/* ── Buy / Sell Toggle ── */}
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => handleSideChange("BUY")}
            className={cn(
              "py-3 px-3 rounded-lg font-bold flex items-center justify-center gap-1.5 border transition-all text-sm tracking-wide",
              side === "BUY"
                ? "bg-[#0ecb81] text-slate-950 border-[#0ecb81] shadow-md shadow-[#0ecb81]/20 scale-[1.01]"
                : "bg-secondary/40 text-muted-foreground border-border hover:border-[#0ecb81]/50 hover:text-foreground",
            )}
          >
            <TrendingUp className="w-4 h-4" />
            <span>BUY</span>
          </button>

          <button
            type="button"
            onClick={() => handleSideChange("SELL")}
            className={cn(
              "py-3 px-3 rounded-lg font-bold flex items-center justify-center gap-1.5 border transition-all text-sm tracking-wide",
              side === "SELL"
                ? "bg-[#f6465d] text-white border-[#f6465d] shadow-md shadow-[#f6465d]/20 scale-[1.01]"
                : "bg-secondary/40 text-muted-foreground border-border hover:border-[#f6465d]/50 hover:text-foreground",
            )}
          >
            <TrendingDown className="w-4 h-4" />
            <span>SELL</span>
          </button>
        </div>

        {/* ── Quantity Section & Risk Calculator ── */}
        <div>
          <div className="flex items-center justify-between text-[11px] mb-1 font-medium text-muted-foreground">
            <span>CANTIDAD ({baseUnit})</span>
            {notionalUsd > 0 && <span className="font-mono">≈ {formatCurrency(notionalUsd)}</span>}
          </div>
          <div className="flex items-center border border-border rounded-lg bg-background overflow-hidden focus-within:border-primary">
            <button
              type="button"
              onClick={() => {
                const current = parseFloat(quantity) || unitConfig.step;
                const next = Math.max(unitConfig.step, current - unitConfig.step);
                setQuantity(String(parseFloat(next.toFixed(6))));
              }}
              className="p-1.5 hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors"
            >
              <Minus className="w-3.5 h-3.5" />
            </button>
            <input
              type="number"
              step={unitConfig.step}
              min={unitConfig.step}
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
              className="w-full bg-transparent text-center font-mono font-bold text-xs py-1.5 focus:outline-none"
            />
            <button
              type="button"
              onClick={() => {
                const current = parseFloat(quantity) || 0;
                const next = current + unitConfig.step;
                setQuantity(String(parseFloat(next.toFixed(6))));
              }}
              className="p-1.5 hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors"
            >
              <Plus className="w-3.5 h-3.5" />
            </button>
          </div>


          {/* Quick Risk Buttons Bar */}
          <div className="flex items-center gap-1 mt-1.5 pt-1.5 border-t border-border/40">
            <button
              type="button"
              onClick={() => setShowRiskCalc((v) => !v)}
              className={cn(
                "text-[10px] px-1.5 py-0.5 rounded flex items-center gap-1 font-semibold border transition-all shrink-0",
                showRiskCalc
                  ? "bg-primary text-primary-foreground border-primary"
                  : "bg-primary/10 text-primary border-primary/30 hover:bg-primary/20",
              )}
              title="Abrir calculadora de posición por % de riesgo"
            >
              <Calculator className="w-3 h-3" />
              <span>Riesgo %</span>
            </button>
            {[0.5, 1, 2, 3].map((pct) => (
              <button
                key={pct}
                type="button"
                onClick={() => handleApplyRiskSize(pct)}
                className={cn(
                  "flex-1 py-0.5 text-[10px] font-mono font-bold rounded border transition-all",
                  parsedRiskPct === pct && isSlValid
                    ? "bg-primary/20 text-primary border-primary/60 font-semibold"
                    : "bg-secondary/60 hover:bg-secondary border-border/70 text-foreground",
                )}
                title={`Calcular tamaño para arriesgar exactamente ${pct}% de tu capital`}
              >
                {pct}%
              </button>
            ))}
          </div>

          {/* Detailed Risk Calculator Box */}
          {showRiskCalc && (
            <div className="mt-2 p-2.5 rounded-lg border border-primary/30 bg-primary/5 space-y-2 text-xs animate-in fade-in duration-150">
              <div className="flex items-center justify-between">
                <span className="font-semibold text-[11px] text-foreground flex items-center gap-1">
                  <Calculator className="w-3.5 h-3.5 text-primary" />
                  Calculadora por Riesgo %
                </span>
                <span className="text-[10px] font-mono text-muted-foreground">
                  Cap: {formatCurrency(effectiveBalance)}
                </span>
              </div>

              {/* Custom risk % input */}
              <div className="flex items-center gap-1.5">
                <span className="text-[10px] text-muted-foreground">Arriesgar:</span>
                <div className="relative w-16">
                  <input
                    type="number"
                    step="0.1"
                    min="0.05"
                    max="100"
                    value={riskPercent}
                    onChange={(e) => setRiskPercent(e.target.value)}
                    className="w-full text-center text-xs font-mono py-0.5 pr-3.5 bg-background border border-border rounded font-bold"
                  />
                  <span className="absolute right-1 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground font-bold">%</span>
                </div>
                <span className="text-[10px] font-mono text-muted-foreground">
                  = <strong className="text-destructive font-bold">{formatCurrency(targetRiskDollar)}</strong>
                </span>
              </div>

              {!isSlValid ? (
                <div className="p-2 rounded bg-amber-500/10 border border-amber-500/30 text-[10px] space-y-1.5 text-amber-200">
                  <div className="flex items-center gap-1 font-semibold text-amber-300">
                    <ShieldAlert className="w-3.5 h-3.5 shrink-0" />
                    <span>Requiere Stop Loss activo</span>
                  </div>
                  <p className="text-[10px] leading-tight text-amber-200/90">
                    Para calcular cuánto dinero entrar necesitamos saber la distancia exacta hasta tu Stop Loss.
                  </p>
                  <div className="flex gap-1.5 pt-0.5">
                    <button
                      type="button"
                      onClick={() => handleSuggestSl(1)}
                      className="flex-1 py-1 px-1.5 rounded bg-amber-500/20 hover:bg-amber-500/30 text-amber-200 font-medium text-[9px] border border-amber-500/40"
                    >
                      + Fijar SL a 1%
                    </button>
                    <button
                      type="button"
                      onClick={() => handleSuggestSl(2)}
                      className="flex-1 py-1 px-1.5 rounded bg-amber-500/20 hover:bg-amber-500/30 text-amber-200 font-medium text-[9px] border border-amber-500/40"
                    >
                      + Fijar SL a 2%
                    </button>
                  </div>
                </div>
              ) : (
                <div className="space-y-1.5 pt-1 border-t border-border/60">
                  <div className="grid grid-cols-2 gap-1.5 text-[10px] font-mono bg-background/60 p-2 rounded border border-border/40">
                    <div>
                      <span className="text-muted-foreground block text-[9px]">Pérdida en SL ({parsedRiskPct}%):</span>
                      <strong className="text-destructive font-bold">{formatCurrency(targetRiskDollar)}</strong>
                    </div>
                    <div>
                      <span className="text-muted-foreground block text-[9px]">Distancia al SL:</span>
                      <strong>{slDistance.toFixed(pipDigits)} ({slDistancePct.toFixed(2)}%)</strong>
                    </div>
                    <div>
                      <span className="text-muted-foreground block text-[9px]">Comisiones ida/vuelta:</span>
                      <span>{includeFeesInRisk ? formatCurrency(calcTotalFees) : "No descontadas"}</span>
                    </div>
                    <div>
                      <span className="text-muted-foreground block text-[9px]">Margen requerido:</span>
                      <span>{formatCurrency(calcMargin)}</span>
                    </div>
                  </div>

                  <label className="flex items-center gap-1.5 cursor-pointer text-[10px] text-muted-foreground hover:text-foreground">
                    <input
                      type="checkbox"
                      checked={includeFeesInRisk}
                      onChange={(e) => setIncludeFeesInRisk(e.target.checked)}
                      className="rounded accent-primary w-3 h-3"
                    />
                    <span>Descontar comisiones del riesgo ({((feeRate * 2) * 100).toFixed(2)}% total)</span>
                  </label>

                  <button
                    type="button"
                    onClick={() => handleApplyRiskSize()}
                    disabled={calculatedUnits <= 0}
                    className="w-full py-1.5 px-2 rounded bg-primary text-primary-foreground font-bold text-[11px] hover:bg-primary/90 transition-all flex items-center justify-center gap-1.5 shadow-sm disabled:opacity-50"
                  >
                    <Zap className="w-3 h-3" />
                    <span>
                      Aplicar {calculatedUnits} {baseUnit} ({formatCurrency(calcNotional)})
                    </span>
                  </button>
                </div>
              )}
            </div>
          )}
        </div>

        {/* ── Take Profit & Stop Loss (Always Active on Market Order, Adjusted via Chart Drag) ── */}
        <div className="grid grid-cols-2 gap-2">
          <div className="border border-[#0ecb81]/30 rounded-lg px-2.5 py-1.5 bg-[#0ecb81]/10 flex items-center justify-center">
            <span className="text-[11px] font-bold text-[#0ecb81]">TAKE PROFIT</span>
          </div>

          <div className="border border-[#f6465d]/30 rounded-lg px-2.5 py-1.5 bg-[#f6465d]/10 flex items-center justify-center">
            <span className="text-[11px] font-bold text-[#f6465d]">STOP LOSS</span>
          </div>
        </div>

        {/* ── Beautiful Risk / Reward Ratio Display ── */}
        {riskRewardRatio !== null && (
          <div className="rounded-lg p-2.5 bg-secondary/50 border border-border/80 shadow-sm space-y-1.5">
            <div className="flex items-center justify-between text-[11px]">
              <span className="font-semibold text-muted-foreground flex items-center gap-1.5">
                <span className="text-sm">⚖️</span>
                <span>Riesgo / Beneficio</span>
              </span>
              <span
                className={cn(
                  "font-mono font-bold px-2 py-0.5 rounded text-[11px] shadow-sm tracking-tight",
                  riskRewardRatio >= 2
                    ? "bg-[#0ecb81]/20 text-[#0ecb81] border border-[#0ecb81]/40"
                    : riskRewardRatio >= 1
                      ? "bg-amber-500/20 text-amber-400 border border-amber-500/40"
                      : "bg-[#f6465d]/20 text-[#f6465d] border border-[#f6465d]/40",
                )}
              >
                1 : {riskRewardRatio.toFixed(2)}
              </span>
            </div>

            {/* Visual ratio bar */}
            <div className="flex items-center gap-2 text-[10px] font-mono">
              <span className="text-[#f6465d] font-bold">
                -${riskUsd!.toFixed(2)}
              </span>
              <div className="flex-1 h-2 bg-background rounded-full overflow-hidden flex border border-border/40">
                <div
                  className="bg-[#f6465d]"
                  style={{
                    width: `${Math.max(10, Math.min(90, (1 / (1 + riskRewardRatio)) * 100))}%`,
                  }}
                  title={`Riesgo: $${riskUsd!.toFixed(2)}`}
                />
                <div
                  className="bg-[#0ecb81]"
                  style={{
                    width: `${Math.max(10, Math.min(90, (riskRewardRatio / (1 + riskRewardRatio)) * 100))}%`,
                  }}
                  title={`Beneficio: +$${rewardUsd!.toFixed(2)}`}
                />
              </div>
              <span className="text-[#0ecb81] font-bold">
                +${rewardUsd!.toFixed(2)}
              </span>
            </div>
          </div>
        )}

        {/* Hint to drag directly on chart */}
        {(tpEnabled || slEnabled) && (
          <p className="text-[10px] text-muted-foreground text-center italic">
            ↕ Arrastra las líneas o deslizadores en el gráfico para ajustar precio
          </p>
        )}

        {/* ── Trade Notes / Journal Thesis Input ── */}
        <div className="border border-border/60 rounded-lg p-2 bg-secondary/15 space-y-1">
          <div className="flex items-center justify-between">
            <label className="text-[10px] font-semibold text-muted-foreground flex items-center gap-1">
              <FileText className="w-3 h-3 text-primary" />
              <span>Motivo del Trade / Notas</span>
            </label>
            {notes && (
              <span className="text-[9px] text-primary font-mono font-medium">Visible en historial</span>
            )}
          </div>
          <input
            type="text"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Ej: Ruptura con volumen, rebote en soporte 4H..."
            className="w-full bg-background border border-border rounded px-2 py-1 text-xs text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:border-primary"
            maxLength={180}
          />
        </div>

        {/* ── Submit Button with Debounce Protection ── */}
        <Button
          type="button"
          onClick={handleSubmit}
          disabled={placeOrder.isPending || isSubmitting || !isFeedConnected}
          className={cn(
            "w-full font-bold text-xs py-2 h-9 text-slate-950 font-sans transition-all",
            side === "BUY"
              ? "bg-[#0ecb81] hover:bg-[#0ecb81]/90"
              : "bg-[#f6465d] hover:bg-[#f6465d]/90 text-white",
          )}
        >
          {placeOrder.isPending || isSubmitting ? (
            <span className="flex items-center justify-center gap-1.5">
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              <span>Ejecutando orden...</span>
            </span>
          ) : (
            `${side === "BUY" ? "Comprar" : "Vender"} ${quantity} ${baseUnit}`
          )}
        </Button>
      </div>
    </div>
  );
}
