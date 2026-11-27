import { useState } from "react";
import { X, Scissors, Camera } from "lucide-react";
import { formatNumber, formatCurrency, formatDate, cn, pnlClass } from "../../lib/utils.ts";
import { formatAssetUnits } from "../../hooks/useInstrumentLabels.ts";
import { getPipDigits } from "./utils.ts";
import { TradeScreenshotsModal } from "./TradeScreenshotsModal.tsx";
import type { Position } from "../../services/schemas.ts";

interface PositionRow {
  id: string;
  symbolName: string;
  side: "LONG" | "SHORT" | string;
  quantity: number;
  entryPrice: number;
  currentPrice?: number | null;
  unrealizedPnl: number;
  margin?: number;
  stopLoss?: number | null;
  takeProfit?: number | null;
  openedAt: string | Date;
  notes?: string;
  fourHourScreenshot?: string;
  entryScreenshot?: string;
  dailyScreenshot?: string;
  entryTimeframe?: string;
}

export function PositionsTable({
  positions,
  onClose,
  onModify,
  onPartialClose,
  onSelectSymbol,
}: {
  positions: PositionRow[];
  onClose: (id: string) => void;
  onModify?: (p: PositionRow) => void;
  onPartialClose?: (id: string, quantity: number) => void;
  onSelectSymbol?: (symbolName: string) => void;
}) {
  const [partialCloseId, setPartialCloseId] = useState<string | null>(null);
  const [partialQty, setPartialQty] = useState("");
  const [selectedPos, setSelectedPos] = useState<Position | null>(null);

  const handlePartialSubmit = (positionId: string, maxQty: number) => {
    const qty = parseFloat(partialQty);
    if (!qty || qty <= 0 || qty >= maxQty) return;
    onPartialClose?.(positionId, qty);
    setPartialCloseId(null);
    setPartialQty("");
  };

  return (
    <div className="flex flex-col h-full overflow-auto">
      {positions.length === 0 ? (
        <div className="flex items-center justify-center h-full text-muted-foreground text-xs py-8">
          No open positions
        </div>
      ) : (
        <table className="w-full text-[11px]">
      <thead className="sticky top-0 bg-card z-10">
        <tr>
          <th>Symbol</th>
          <th>Side</th>
          <th>Units</th>
          <th>Entry</th>
          <th>Current</th>
          <th>P&L</th>
          <th>SL</th>
          <th>TP</th>
          <th>Time</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        {positions.map((p) => {
          const digits = getPipDigits(p.symbolName);
          return (
            <tr
              key={p.id}
              className={cn("hover:bg-secondary/30", onSelectSymbol ? "cursor-pointer" : undefined)}
              onClick={() => onSelectSymbol?.(p.symbolName)}
              onKeyDown={(e) => {
                if (!onSelectSymbol) return;
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onSelectSymbol(p.symbolName);
                }
              }}
              tabIndex={onSelectSymbol ? 0 : undefined}
            >
              <td className="font-semibold">{p.symbolName}</td>
              <td className={p.side === "LONG" ? "text-buy" : "text-sell"}>{p.side}</td>
              <td className="font-mono">{formatAssetUnits(p.quantity, p.symbolName)}</td>
              <td className="font-mono">{formatNumber(p.entryPrice, digits)}</td>
              <td className="font-mono">
                {p.currentPrice ? formatNumber(p.currentPrice, digits) : "--"}
              </td>
              <td className={cn("font-mono font-semibold", pnlClass(p.unrealizedPnl))}>
                <div className="flex items-center gap-1">
                  <span>
                    {p.unrealizedPnl >= 0 ? "+" : ""}
                    {formatCurrency(p.unrealizedPnl)}
                  </span>
                  {p.margin != null && p.margin > 0 && (
                    <span className="text-[10px] opacity-75 font-normal">
                      ({p.unrealizedPnl >= 0 ? "+" : ""}
                      {((p.unrealizedPnl / p.margin) * 100).toFixed(1)}%)
                    </span>
                  )}
                </div>
              </td>
              <td className="font-mono text-sell">
                {p.stopLoss ? formatNumber(p.stopLoss, digits) : "--"}
              </td>
              <td className="font-mono text-buy">
                {p.takeProfit ? formatNumber(p.takeProfit, digits) : "--"}
              </td>
              <td className="text-muted-foreground">{formatDate(p.openedAt)}</td>
              <td>
                {partialCloseId === p.id ? (
                  <div className="flex items-center gap-1">
                    <input
                      type="number"
                      value={partialQty}
                      onChange={(e) => setPartialQty(e.target.value)}
                      onClick={(e) => e.stopPropagation()}
                      placeholder={`< ${p.quantity}`}
                      min={0.0001}
                      max={p.quantity}
                      step="any"
                      className="w-20 h-5 text-[10px] rounded border border-border bg-background px-1 font-mono"
                      autoFocus
                      onKeyDown={(e) => {
                        if (e.key === "Enter") handlePartialSubmit(p.id, p.quantity);
                        if (e.key === "Escape") {
                          setPartialCloseId(null);
                          setPartialQty("");
                        }
                      }}
                    />
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handlePartialSubmit(p.id, p.quantity);
                      }}
                      className="px-1 py-0.5 text-[9px] rounded bg-warning/20 text-warning hover:bg-warning/30"
                    >
                      Go
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setPartialCloseId(null);
                        setPartialQty("");
                      }}
                      className="px-1 py-0.5 text-[9px] rounded bg-secondary text-muted-foreground hover:bg-secondary/80"
                    >
                      <X className="h-2.5 w-2.5" />
                    </button>
                  </div>
                ) : (
                  <div className="flex gap-1">
                    {onModify && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          onModify(p);
                        }}
                        className="px-1.5 py-0.5 text-[10px] rounded bg-accent/20 text-accent hover:bg-accent/30"
                      >
                        Modify
                      </button>
                    )}
                    {onPartialClose && p.quantity > 0.0001 && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setPartialCloseId(p.id);
                          setPartialQty(String(Number((p.quantity / 2).toFixed(6))));
                        }}
                        className="px-1.5 py-0.5 text-[10px] rounded bg-warning/20 text-warning hover:bg-warning/30 flex items-center gap-0.5"
                        title="Partial Close"
                      >
                        <Scissors className="h-2.5 w-2.5" /> Partial
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setSelectedPos(p as unknown as Position);
                      }}
                      className="px-1.5 py-0.5 text-[10px] rounded bg-primary/10 text-primary hover:bg-primary/20 flex items-center gap-0.5"
                      title="Ver capturas (4H y Diario) y notas del trade"
                    >
                      <Camera className="h-3 w-3" />
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onClose(p.id);
                      }}
                      className="px-1.5 py-0.5 text-[10px] rounded bg-destructive/20 text-destructive hover:bg-destructive/30"
                    >
                      Close
                    </button>
                  </div>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
    )}
    {selectedPos && (
      <TradeScreenshotsModal
        trade={selectedPos}
        onClose={() => setSelectedPos(null)}
      />
    )}
    </div>
  );
}
