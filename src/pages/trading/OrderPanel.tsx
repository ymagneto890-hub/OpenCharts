import { useState, useEffect, useMemo, useRef } from "react";
import {
  Minus,
  Plus,
  TrendingUp,
  TrendingDown,
  AlertTriangle,
  Zap,
  Volume2,
  VolumeX,
  Calculator,
  ShieldAlert,
  Percent,
  FileText,
} from "lucide-react";
import { usePlaceOrder } from "../../services/queries.ts";
import { getAccount, getSettings, subscribeEngine } from "../../services/demo/engine.ts";
import { readTraderPrefs } from "../../hooks/useTraderPreferences.ts";
import { Button } from "../../components/ui/button.tsx";
import { DisconnectedTradingBanner } from "../../components/ConnectionIndicator.tsx";
import type { PlaceOrderInput } from "../../services/schemas.ts";
import type { DraftOrderSlTpPreview } from "./ChartPanel.tsx";
import { toast } from "../../services/toast.ts";
import { formatCurrency, formatNumber, cn } from "../../lib/utils.ts";
import { getPipDigits, getMinMove } from "./utils.ts";
import { extractBaseAsset } from "../../hooks/useInstrumentLabels.ts";
import { getDemoSymbol } from "../../services/demo/instruments.ts";

type ConfirmableOrder = PlaceOrderInput & { _submit: () => Promise<unknown> };

export interface OrderPanelProps {
  symbol: string;
  symbolInfo?: {
    name?: string;
    description?: string;
    pipSize?: number;
    tickSize?: number;
    pricescale?: number;
    contractSize?: number;
    marginPercent?: number;
    commission?: number;
    [k: string]: unknown;
  };
  tick?: { bid: number; ask: number; timestamp: number };
  accountId: string | null;
  oneClick?: boolean;
  onToggleOneClick?: () => void;
  onConfirmOrder?: (order: ConfirmableOrder) => void;
  accountBalance?: number;
  isFeedConnected?: boolean;
  soundMuted?: boolean;
  onToggleMute?: () => void;
  onOrderSuccess?: () => void;
  onDraftPreviewChange?: (preview: DraftOrderSlTpPreview | null) => void;
  externalDraftSlTp?: { takeProfit?: number | null; stopLoss?: number | null; seq: number } | null;
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

export function OrderPanel({
  symbol,
  symbolInfo,
  tick,
  accountId,
  oneClick,
  onToggleOneClick,
  onConfirmOrder,
  accountBalance,
  isFeedConnected = true,
  soundMuted,
  onToggleMute,
  onOrderSuccess,
  onDraftPreviewChange,
  externalDraftSlTp,
}: OrderPanelProps) {
  const baseUnit = useMemo(() => extractBaseAsset(symbol), [symbol]);
  const unitConfig = useMemo(
    () => getSymbolUnitPresets(baseUnit, symbol, tick?.bid),
    [baseUnit, symbol, tick?.bid],
  );
  const pipDigits = useMemo(() => getPipDigits(symbolInfo, symbol), [symbolInfo, symbol]);
  const priceStep = useMemo(() => String(getMinMove(pipDigits)), [pipDigits]);

  const [side, setSide] = useState<"BUY" | "SELL">("BUY");
  const [orderType, setOrderType] = useState<"MARKET" | "LIMIT" | "STOP">("MARKET");
  const [quantity, setQuantity] = useState(() => {
    const prefs = readTraderPrefs();
    const raw = prefs.defaultQty;
    if (raw) {
      const n = parseFloat(raw);
      if (Number.isFinite(n) && n > 0 && n !== 0.1) return String(Number(n.toFixed(8)));
    }
    return unitConfig.defaultQty;
  });
  const [price, setPrice] = useState("");
  const [stopPrice, setStopPrice] = useState("");
  const [tpEnabled, setTpEnabled] = useState(true);
  const [slEnabled, setSlEnabled] = useState(true);
  const [takeProfit, setTakeProfit] = useState("");
  const [stopLoss, setStopLoss] = useState("");
  const [notes, setNotes] = useState("");
  const userDraggedTpRef = useRef(false);
  const userDraggedSlRef = useRef(false);
  const [feeRate, setFeeRate] = useState(() => getSettings().feeRate);

  useEffect(() => {
    return subscribeEngine(() => {
      setFeeRate(getSettings().feeRate);
    });
  }, []);

  // Reset symbol-specific fields ONLY when switching symbol (never on live tick bucket threshold changes)
  const prevSymbolRef = useRef(symbol);
  const defaultQtyRef = useRef(unitConfig.defaultQty);
  defaultQtyRef.current = unitConfig.defaultQty;

  useEffect(() => {
    if (prevSymbolRef.current === symbol) return;
    prevSymbolRef.current = symbol;
    setQuantity(defaultQtyRef.current);
    setPrice("");
    setStopPrice("");
    setTpEnabled(true);
    setSlEnabled(true);
    setTakeProfit("");
    setStopLoss("");
    userDraggedTpRef.current = false;
    userDraggedSlRef.current = false;
    setNotes("");
  }, [symbol]);

  const placeOrder = usePlaceOrder();

  const refPrice = useMemo(() => {
    if (orderType === "LIMIT") {
      const p = parseFloat(price);
      if (Number.isFinite(p) && p > 0) return p;
    }
    if (orderType === "STOP") {
      const sp = parseFloat(stopPrice);
      if (Number.isFinite(sp) && sp > 0) return sp;
    }
    if (tick) return side === "BUY" ? tick.ask : tick.bid;
    return 0;
  }, [orderType, price, stopPrice, tick, side]);

  // Auto-populate and keep default TP & SL valid whenever refPrice > 0
  useEffect(() => {
    if (!(refPrice > 0)) return;
    const curTp = parseFloat(takeProfit);
    const tpValid =
      Number.isFinite(curTp) &&
      curTp > 0 &&
      (side === "BUY" ? curTp > refPrice : curTp < refPrice);
    if (!userDraggedTpRef.current || (orderType === "MARKET" && !tpValid)) {
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
    if (!userDraggedSlRef.current || (orderType === "MARKET" && !slValid)) {
      const defaultSl = refPrice * (side === "BUY" ? 0.99 : 1.01);
      const nextSlStr = defaultSl.toFixed(pipDigits);
      if (nextSlStr !== stopLoss) {
        setStopLoss(nextSlStr);
      }
    }
  }, [refPrice, side, orderType, pipDigits, takeProfit, stopLoss]);

  const isExternalUpdateRef = useRef(false);

  // Apply external chart drag updates to draft SL/TP
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

  // Emit draft preview to ChartPanel so TP/SL lines can be dragged directly on the chart
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

  const isSubmittingRef = useRef(false);

  const handleSubmit = () => {
    if (isSubmittingRef.current || placeOrder.isPending) return;
    if (!isFeedConnected) {
      toast.warning("Sin conexión", "No se pueden enviar órdenes sin conexión al feed de datos");
      return;
    }
    if (!accountId) {
      toast.warning("Sin cuenta", "Selecciona una cuenta primero");
      return;
    }
    const qty = parseFloat(quantity);
    if (!Number.isFinite(qty) || qty <= 0) {
      toast.warning("Cantidad inválida", `Introduce una cantidad positiva en ${baseUnit}`);
      return;
    }
    if (qty > 1e12) {
      toast.warning("Cantidad excesiva", `La cantidad excede el límite por orden en ${baseUnit}`);
      return;
    }
    if (orderType === "LIMIT" && (!price || isNaN(parseFloat(price)) || parseFloat(price) <= 0)) {
      toast.warning("Precio requerido", "Las órdenes Limit requieren un precio válido");
      return;
    }
    if (
      orderType === "STOP" &&
      (!stopPrice || isNaN(parseFloat(stopPrice)) || parseFloat(stopPrice) <= 0)
    ) {
      toast.warning("Precio Stop requerido", "Las órdenes Stop requieren un precio válido");
      return;
    }
    const effectiveType = orderType;

    isSubmittingRef.current = true;

    const input: PlaceOrderInput = {
      accountId,
      symbol,
      side,
      type: effectiveType as PlaceOrderInput["type"],
      quantity: qty,
    };

    if (orderType === "LIMIT" && price) input.price = parseFloat(price);
    if (orderType === "STOP" && stopPrice) input.stopPrice = parseFloat(stopPrice);
    if (tpEnabled && takeProfit) input.takeProfit = parseFloat(takeProfit) || undefined;
    if (slEnabled && stopLoss) input.stopLoss = parseFloat(stopLoss) || undefined;
    if (notes.trim()) input.notes = notes.trim();

    const doSubmit = () =>
      placeOrder
        .mutateAsync(input, {
          onSuccess: () => {
            toast.success(
              "Orden ejecutada",
              `${side === "BUY" ? "Compra" : "Venta"} ${qty} ${baseUnit} (${effectiveType})`,
            );
            setNotes("");
            onOrderSuccess?.();
          },
          onError: (err: unknown) => {
            const e = err as {
              error?: { code?: string; message?: string };
              message?: string;
              code?: string;
            };
            const msg = e?.error?.message || e?.message || "No se pudo ejecutar la orden";
            toast.error("Error en la orden", msg);
          },
        })
        .finally(() => {
          isSubmittingRef.current = false;
        });

    if (oneClick && orderType === "MARKET") {
      doSubmit().catch(() => {});
      return;
    }

    if (onConfirmOrder) {
      onConfirmOrder({
        accountId,
        symbol,
        side,
        type: effectiveType,
        quantity: qty,
        price: input.price,
        stopPrice: input.stopPrice,
        takeProfit: input.takeProfit,
        stopLoss: input.stopLoss,
        _submit: doSubmit,
      });
      isSubmittingRef.current = false;
      return;
    }

    doSubmit();
  };

  const contractSize = symbolInfo?.contractSize ?? 1;
  const qtyVal = parseFloat(quantity) || 0;
  const notionalUsd = qtyVal * contractSize * refPrice;
  const marginRequired = notionalUsd * ((symbolInfo?.marginPercent ?? 1) / 100);
  const estimatedEntryFee = notionalUsd * feeRate;

  // ── Risk-Based Position Size Calculator ───────────────────
  const [showRiskCalc, setShowRiskCalc] = useState(false);
  const [riskPercent, setRiskPercent] = useState("1");
  const [includeFeesInRisk, setIncludeFeesInRisk] = useState(true);

  const effectiveBalance = useMemo(() => {
    if (accountBalance && accountBalance > 0) return accountBalance;
    try {
      return getAccount().balance || 10_000;
    } catch {
      return 10_000;
    }
  }, [accountBalance]);

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
        "Espera a recibir precio de mercado o define el precio límite.",
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
        toast.info(
          `SL fijado al ${distancePercent}% (${formatted})`,
          `Tamaño calculado: ${finalUnits} ${baseUnit} (${formatCurrency(finalUnits * refPrice * contractSize)}) para arriesgar el ${parsedRiskPct}% (${formatCurrency(tRisk)})`,
        );
      }
    }
  };

  const adjustQuantity = (delta: number) => {
    setQuantity((prev) => {
      const cur = parseFloat(prev) || 0;
      const next = Math.max(unitConfig.step / 10, cur + delta);
      return String(Number(next.toFixed(6)));
    });
  };

  return (
    <div className="flex flex-col h-full" data-testid="order-form">
      <div className="flex items-center justify-between px-3 py-2 border-b border-border bg-secondary">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Nueva Orden
        </h3>
        <div className="flex items-center gap-2">
          <button
            onClick={onToggleMute}
            className={cn(
              "flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-medium border transition-colors",
              !soundMuted
                ? "bg-accent/15 text-accent border-accent/30"
                : "text-muted-foreground border-border hover:bg-secondary",
            )}
            title={soundMuted ? "Activar sonidos" : "Silenciar sonidos"}
          >
            {soundMuted ? <VolumeX className="h-2.5 w-2.5" /> : <Volume2 className="h-2.5 w-2.5" />}
          </button>
          <button
            onClick={onToggleOneClick}
            className={cn(
              "flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-medium border transition-colors",
              oneClick
                ? "bg-buy/15 text-buy border-buy/30"
                : "text-muted-foreground border-border hover:bg-secondary",
            )}
            title="1-Click trading: ejecutar órdenes a mercado sin confirmación"
          >
            <Zap className="h-2.5 w-2.5" />
            1-Click
          </button>
          <span className="text-xs font-semibold">{symbol}</span>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        {/* Side */}
        <div className="grid grid-cols-2 gap-1">
          <Button
            variant={side === "BUY" ? "buy" : "outline"}
            size="sm"
            onClick={() => handleSideChange("BUY")}
            className="text-xs"
          >
            <TrendingUp className="h-3 w-3 mr-1" />
            BUY {tick ? formatNumber(tick.ask, pipDigits) : ""}
          </Button>
          <Button
            variant={side === "SELL" ? "sell" : "outline"}
            size="sm"
            onClick={() => handleSideChange("SELL")}
            className="text-xs"
          >
            <TrendingDown className="h-3 w-3 mr-1" />
            SELL {tick ? formatNumber(tick.bid, pipDigits) : ""}
          </Button>
        </div>

        {/* Order Type */}
        <div>
          <label className="text-[10px] text-muted-foreground uppercase tracking-wider">
            Tipo de Orden
          </label>
          <div className="grid grid-cols-3 gap-1 mt-1">
            {(["MARKET", "LIMIT", "STOP"] as const).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setOrderType(t)}
                className={cn(
                  "px-1 py-1 text-[10px] rounded border border-border font-medium",
                  t === orderType
                    ? "bg-primary text-primary-foreground border-primary"
                    : "hover:bg-secondary",
                )}
              >
                {t}
              </button>
            ))}
          </div>
        </div>

        {/* Direct Asset Quantity (Units, no lots) & Risk Sizing Calculator */}
        <div>
          <div className="flex items-center justify-between mb-1">
            <label className="text-[10px] text-muted-foreground uppercase tracking-wider font-semibold">
              Cantidad ({baseUnit})
            </label>
            <button
              type="button"
              onClick={() => setShowRiskCalc(!showRiskCalc)}
              className={cn(
                "inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded transition-all shadow-sm",
                showRiskCalc
                  ? "bg-primary text-primary-foreground"
                  : "bg-primary/10 text-primary hover:bg-primary/20",
              )}
              title="Calcula automáticamente la cantidad a comprar según el % de riesgo que deseas arriesgar y la distancia al Stop Loss"
            >
              <Calculator className="w-3 h-3" />
              <span>Calcular Riesgo %</span>
            </button>
          </div>

          <div className="flex items-center gap-1 mt-1">
            <button
              type="button"
              onClick={() => adjustQuantity(-unitConfig.step)}
              className="px-2 py-1.5 rounded bg-secondary hover:bg-border transition-colors"
              title={`-${unitConfig.step} ${baseUnit}`}
            >
              <Minus className="h-3 w-3" />
            </button>
            <div className="relative flex-1">
              <input
                type="number"
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
                placeholder={`Ej: ${unitConfig.defaultQty}`}
                className="w-full text-center text-sm font-mono pr-10"
                step="any"
                min="0.000001"
                data-testid="order-quantity-input"
              />
              <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] font-mono font-semibold text-muted-foreground pointer-events-none">
                {baseUnit}
              </span>
            </div>
            <button
              type="button"
              onClick={() => adjustQuantity(unitConfig.step)}
              className="px-2 py-1.5 rounded bg-secondary hover:bg-border transition-colors"
              title={`+${unitConfig.step} ${baseUnit}`}
            >
              <Plus className="h-3 w-3" />
            </button>
          </div>

          {/* Unit presets & Quick Risk bar */}
          <div className="flex gap-1 mt-1">
            {unitConfig.presets.map((q) => (
              <button
                key={q}
                type="button"
                onClick={() => setQuantity(String(q))}
                className={cn(
                  "flex-1 text-[10px] font-mono py-0.5 rounded border border-border transition-colors",
                  parseFloat(quantity) === q
                    ? "bg-primary/20 text-primary border-primary/50 font-semibold"
                    : "hover:bg-secondary/60 text-muted-foreground",
                )}
              >
                {q}
              </button>
            ))}
          </div>

          {/* Quick Risk Buttons Bar */}
          <div className="flex items-center gap-1 mt-1.5 pt-1 border-t border-border/40">
            <span className="text-[9px] font-medium text-muted-foreground flex items-center gap-0.5 shrink-0">
              <Percent className="w-2.5 h-2.5" /> Riesgo:
            </span>
            {[0.5, 1, 2, 3].map((pct) => (
              <button
                key={pct}
                type="button"
                onClick={() => handleApplyRiskSize(pct)}
                className={cn(
                  "flex-1 py-0.5 text-[9px] font-mono font-bold rounded border transition-all",
                  parsedRiskPct === pct && isSlValid
                    ? "bg-primary/20 text-primary border-primary/60 font-semibold"
                    : "bg-secondary/60 hover:bg-secondary border-border/70 text-foreground",
                )}
                title={`Calcular tamaño para arriesgar exactamente ${pct}% de tu cuenta`}
              >
                {pct}%
              </button>
            ))}
          </div>

          {/* ── Interactive Detailed Risk Calculator Box ── */}
          {showRiskCalc && (
            <div className="mt-2 p-2.5 rounded-lg border border-primary/30 bg-primary/5 space-y-2 text-xs animate-in fade-in duration-150">
              <div className="flex items-center justify-between">
                <span className="font-semibold text-[11px] text-foreground flex items-center gap-1">
                  <Calculator className="w-3.5 h-3.5 text-primary" />
                  Calculadora de Riesgo por %
                </span>
                <span className="text-[10px] font-mono text-muted-foreground">
                  Balance: {formatCurrency(effectiveBalance)}
                </span>
              </div>

              {/* Custom risk percentage input */}
              <div className="flex items-center gap-1.5">
                <span className="text-[10px] text-muted-foreground">Riesgo a perder:</span>
                <div className="relative w-20">
                  <input
                    type="number"
                    step="0.1"
                    min="0.05"
                    max="100"
                    value={riskPercent}
                    onChange={(e) => setRiskPercent(e.target.value)}
                    className="w-full text-center text-xs font-mono py-0.5 pr-4 border-border rounded font-bold"
                  />
                  <span className="absolute right-1.5 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground font-bold">%</span>
                </div>
                <span className="text-[10px] font-mono text-muted-foreground">
                  = <strong className="text-destructive font-bold">{formatCurrency(targetRiskDollar)}</strong>
                </span>
              </div>

              {/* Status / Breakdown */}
              {!isSlValid ? (
                <div className="p-2 rounded bg-amber-500/10 border border-amber-500/30 text-[10px] space-y-1.5 text-amber-200">
                  <div className="flex items-center gap-1 font-semibold text-amber-300">
                    <ShieldAlert className="w-3.5 h-3.5 shrink-0" />
                    <span>Requiere Stop Loss activo</span>
                  </div>
                  <p className="text-[10px] leading-tight text-amber-200/90">
                    Para calcular el dinero a meter necesitamos saber a qué distancia tienes el Stop Loss.
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
                      <span className="text-muted-foreground block text-[9px]">Pérdida Máxima ({parsedRiskPct}%):</span>
                      <strong className="text-destructive font-bold">{formatCurrency(targetRiskDollar)}</strong>
                    </div>
                    <div>
                      <span className="text-muted-foreground block text-[9px]">Distancia al SL:</span>
                      <strong>{slDistance.toFixed(pipDigits)} ({slDistancePct.toFixed(2)}%)</strong>
                    </div>
                    <div>
                      <span className="text-muted-foreground block text-[9px]">Comisiones est. (x2):</span>
                      <span className="text-muted-foreground font-mono">~{formatCurrency(calcTotalFees)}</span>
                    </div>
                    <div>
                      <span className="text-muted-foreground block text-[9px]">Margen Requerido:</span>
                      <span className="text-foreground">{formatCurrency(calcMargin)}</span>
                    </div>
                  </div>

                  <div className="flex items-center justify-between pt-0.5">
                    <label className="flex items-center gap-1.5 text-[10px] text-muted-foreground cursor-pointer select-none">
                      <input
                        type="checkbox"
                        checked={includeFeesInRisk}
                        onChange={(e) => setIncludeFeesInRisk(e.target.checked)}
                        className="rounded border-border accent-primary h-3 w-3"
                      />
                      <span>Descontar comisiones del riesgo</span>
                    </label>
                  </div>

                  <button
                    type="button"
                    onClick={() => handleApplyRiskSize()}
                    className="w-full py-1.5 rounded bg-primary hover:bg-primary/90 text-primary-foreground font-bold text-xs flex items-center justify-center gap-1.5 shadow-sm transition-all"
                  >
                    <span>⚡ Aplicar {calculatedUnits} {baseUnit} a la orden</span>
                    <span className="text-[10px] opacity-80">({formatCurrency(calcNotional)})</span>
                  </button>
                </div>
              )}
            </div>
          )}
        </div>

        {orderType === "LIMIT" && (
          <div>
            <label className="text-[10px] text-muted-foreground uppercase tracking-wider">
              Precio Límite
            </label>
            <input
              type="number"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              placeholder={tick ? formatNumber(side === "BUY" ? tick.ask : tick.bid, pipDigits) : ""}
              className="w-full mt-1 text-sm font-mono"
              step={priceStep}
            />
          </div>
        )}

        {orderType === "STOP" && (
          <div>
            <label className="text-[10px] text-muted-foreground uppercase tracking-wider">
              Precio Stop
            </label>
            <input
              type="number"
              value={stopPrice}
              onChange={(e) => setStopPrice(e.target.value)}
              placeholder={tick ? formatNumber(side === "BUY" ? tick.ask : tick.bid, pipDigits) : ""}
              className="w-full mt-1 text-sm font-mono"
              step={priceStep}
            />
          </div>
        )}

        {/* Take Profit & Stop Loss (Always Active, Adjusted via Chart Drag) */}
        <div className="space-y-2 pt-1 border-t border-border/60">
          <div className="grid grid-cols-2 gap-2">
            <div className="border border-[#0ecb81]/30 rounded-lg px-2.5 py-2 bg-[#0ecb81]/10 flex items-center justify-between">
              <span className="text-[10px] font-bold uppercase tracking-wider text-[#0ecb81]">
                Take Profit
              </span>
            </div>
            <div className="border border-[#f6465d]/30 rounded-lg px-2.5 py-2 bg-[#f6465d]/10 flex items-center justify-between">
              <span className="text-[10px] font-bold uppercase tracking-wider text-[#f6465d]">
                Stop Loss
              </span>
            </div>
          </div>
          <p className="text-[10px] text-muted-foreground leading-tight">
            ↕ Arrastra las líneas de TP/SL directamente sobre el gráfico para ajustar el precio.
          </p>
        </div>

        {/* Risk-per-trade display */}
        {(() => {
          const slVal = slEnabled ? parseFloat(stopLoss) : NaN;
          const tpVal = tpEnabled ? parseFloat(takeProfit) : NaN;

          if (!(refPrice > 0) || (!Number.isFinite(slVal) && !Number.isFinite(tpVal)) || qtyVal <= 0) {
            return null;
          }

          const slDistance = Number.isFinite(slVal) ? Math.abs(refPrice - slVal) : 0;
          const riskDollar = slDistance * qtyVal * contractSize;
          const balance = effectiveBalance;
          const riskPct = balance > 0 ? (riskDollar / balance) * 100 : 0;
          const tpDollar = Number.isFinite(tpVal)
            ? Math.abs(tpVal - refPrice) * qtyVal * contractSize
            : null;
          const rrRatio = tpDollar && riskDollar > 0 ? tpDollar / riskDollar : null;

          const riskColor =
            riskPct > 5 ? "text-destructive" : riskPct > 2 ? "text-warning" : "text-buy";

          return (
            <div className="bg-secondary/50 rounded p-2 text-[10px] space-y-1 border border-border/50">
              <div className="flex items-center gap-1 mb-1">
                <AlertTriangle className={cn("h-3 w-3", riskColor)} />
                <span className="font-semibold text-[10px] uppercase tracking-wider text-muted-foreground">
                  Proyección SL / TP
                </span>
              </div>
              {Number.isFinite(slVal) && (
                <>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Riesgo SL</span>
                    <span className={cn("font-mono font-semibold", riskColor)}>
                      -{formatCurrency(riskDollar)} ({riskPct.toFixed(2)}%)
                    </span>
                  </div>
                </>
              )}
              {tpDollar != null && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Beneficio TP</span>
                  <span className="font-mono font-semibold text-buy">
                    +{formatCurrency(tpDollar)}
                  </span>
                </div>
              )}
              {rrRatio != null && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Ratio R:B</span>
                  <span
                    className={cn(
                      "font-mono font-semibold",
                      rrRatio >= 2 ? "text-buy" : rrRatio >= 1 ? "text-foreground" : "text-sell",
                    )}
                  >
                    1:{rrRatio.toFixed(2)}
                  </span>
                </div>
              )}
            </div>
          );
        })()}

        {/* Unit / Notional / Margin / Commission info */}
        {refPrice > 0 && (
          <div className="bg-secondary rounded p-2 text-[10px] space-y-1">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Cantidad</span>
              <span className="font-mono font-semibold">
                {qtyVal} {baseUnit}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Valor Nocional</span>
              <span className="font-mono">{formatCurrency(notionalUsd)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Margen Requerido</span>
              <span className="font-mono">{formatCurrency(marginRequired)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">
                Comisión ({(feeRate * 100).toFixed(3)}%)
              </span>
              <span className="font-mono">{formatCurrency(estimatedEntryFee)}</span>
            </div>
          </div>
        )}

        {!isFeedConnected && <DisconnectedTradingBanner />}

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

        <Button
          variant={side === "BUY" ? "buy" : "sell"}
          className="w-full"
          onClick={handleSubmit}
          loading={placeOrder.isPending}
          disabled={!accountId || placeOrder.isPending || !isFeedConnected}
          data-testid="submit-order-btn"
        >
          {!isFeedConnected
            ? "Sin conexión"
            : placeOrder.isPending
              ? "Enviando…"
              : `${side === "BUY" ? "Comprar" : "Vender"} ${quantity} ${baseUnit}`}
        </Button>

        {placeOrder.isError && (
          <p className="text-destructive text-xs mt-1 p-1.5 bg-destructive/10 rounded">
            {(placeOrder.error as { message?: string } | null)?.message || "Error al enviar orden"}
          </p>
        )}
      </div>
    </div>
  );
}
