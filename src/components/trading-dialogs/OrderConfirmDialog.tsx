import { cn, formatCurrency, formatNumber } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { TrendingUp, TrendingDown } from "lucide-react";
import { useInstrumentLabels } from "../../hooks/useInstrumentLabels.ts";
import { getPipDigits } from "../../pages/trading/utils.ts";
import { getSummary } from "../../services/demo/engine.ts";

interface OrderConfirmDialogProps {
  isOpen: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  order: {
    symbol: string;
    side: "BUY" | "SELL";
    type: string;
    quantity: number;
    price?: number;
    stopPrice?: number;
    takeProfit?: number;
    stopLoss?: number;
  } | null;
  tick?: { bid: number; ask: number };
  symbolInfo?: {
    digits?: number;
    pip?: number;
    tickSize?: number;
    contractSize?: number;
    marginPercent?: number;
    commission?: number;
    [key: string]: unknown;
  } | null;
  loading?: boolean;
}

export function OrderConfirmDialog({
  isOpen,
  onConfirm,
  onCancel,
  order,
  tick,
  symbolInfo,
  loading,
}: OrderConfirmDialogProps) {
  const { formatQty } = useInstrumentLabels();
  if (!isOpen || !order) return null;

  const digits = getPipDigits(symbolInfo ?? undefined, order.symbol);
  const contractSize = symbolInfo?.contractSize ?? 1;

  const executionPrice =
    order.type === "MARKET"
      ? order.side === "BUY"
        ? tick?.ask
        : tick?.bid
      : order.price || order.stopPrice;

  const notional = executionPrice ? order.quantity * contractSize * executionPrice : null;

  const marginRequired =
    notional !== null && symbolInfo
      ? notional * ((symbolInfo.marginPercent || 1) / 100)
      : null;

  const feeRate = getSummary().feeRate;
  const commission =
    notional !== null
      ? symbolInfo?.commission
        ? symbolInfo.commission * order.quantity
        : notional * feeRate
      : null;

  const tpPnl =
    order.takeProfit && executionPrice
      ? (order.side === "BUY"
          ? order.takeProfit - executionPrice
          : executionPrice - order.takeProfit) *
        order.quantity *
        contractSize
      : null;

  const slPnl =
    order.stopLoss && executionPrice
      ? (order.side === "BUY" ? order.stopLoss - executionPrice : executionPrice - order.stopLoss) *
        order.quantity *
        contractSize
      : null;

  return (
    <>
      <div className="fixed inset-0 z-[70] bg-black/50 backdrop-blur-sm" onClick={onCancel} />
      <div
        className="fixed inset-0 z-[70] flex items-center justify-center p-4"
        onClick={(e) => {
          if (e.target === e.currentTarget) onCancel();
        }}
      >
        <div className="w-full max-w-sm bg-card border border-border rounded-xl shadow-2xl overflow-hidden">
          <div
            className={cn(
              "px-5 py-3 border-b",
              order.side === "BUY" ? "bg-buy/10 border-buy/20" : "bg-sell/10 border-sell/20",
            )}
          >
            <h3 className="text-sm font-semibold flex items-center gap-2">
              {order.side === "BUY" ? (
                <TrendingUp className="h-4 w-4 text-buy" />
              ) : (
                <TrendingDown className="h-4 w-4 text-sell" />
              )}
              Confirm {order.side} Order
            </h3>
          </div>

          <div className="px-5 py-4 space-y-2 text-sm">
            <Row label="Symbol" value={order.symbol} bold />
            <Row
              label="Side"
              value={order.side}
              valueClass={order.side === "BUY" ? "text-buy" : "text-sell"}
            />
            <Row label="Type" value={order.type} />
            <Row label="Quantity (Units)" value={formatQty(order.quantity, order.symbol)} />
            {executionPrice && <Row label="Price" value={formatNumber(executionPrice, digits)} />}
            {notional !== null && <Row label="Notional Value" value={formatCurrency(notional)} />}
            {order.takeProfit && (
              <Row
                label="Take Profit"
                value={formatNumber(order.takeProfit, digits)}
                extra={
                  tpPnl !== null ? `(${tpPnl >= 0 ? "+" : ""}${formatCurrency(tpPnl)})` : undefined
                }
                valueClass="text-buy"
              />
            )}
            {order.stopLoss && (
              <Row
                label="Stop Loss"
                value={formatNumber(order.stopLoss, digits)}
                extra={
                  slPnl !== null ? `(${slPnl >= 0 ? "+" : ""}${formatCurrency(slPnl)})` : undefined
                }
                valueClass="text-sell"
              />
            )}
            {marginRequired !== null && (
              <Row label="Margin Required" value={formatCurrency(marginRequired)} />
            )}
            {commission !== null && <Row label="Est. Commission" value={formatCurrency(commission)} />}
          </div>

          <div className="px-5 py-3 border-t border-border/40 flex gap-2">
            <Button variant="outline" className="flex-1" onClick={onCancel}>
              Cancel
            </Button>
            <Button
              variant={order.side === "BUY" ? "buy" : "sell"}
              className="flex-1"
              onClick={onConfirm}
              loading={loading}
              disabled={loading}
            >
              {loading ? "Placing..." : `Confirm ${order.side}`}
            </Button>
          </div>
        </div>
      </div>
    </>
  );
}

function Row({
  label,
  value,
  valueClass,
  bold,
  extra,
}: {
  label: string;
  value: string;
  valueClass?: string;
  bold?: boolean;
  extra?: string;
}) {
  return (
    <div className="flex items-center justify-between py-0.5">
      <span className="text-muted-foreground text-xs">{label}</span>
      <span className={cn("font-mono text-xs", valueClass, bold && "font-semibold text-sm")}>
        {value}
        {extra && <span className="text-[10px] ml-1 opacity-70">{extra}</span>}
      </span>
    </div>
  );
}
