import { useMemo } from "react";
import { formatNumber, cn } from "../../lib/utils.ts";
import { getPipDigits } from "./utils.ts";

export function DOMPanel({
  symbol,
  tick,
}: {
  symbol: string;
  tick?: { bid: number; ask: number };
}) {
  const pipDigits = useMemo(() => getPipDigits(undefined, symbol), [symbol]);
  const levels = useMemo(() => {
    if (!tick) return [];
    const mid = (tick.bid + tick.ask) / 2;
    const minTick = Math.pow(10, -pipDigits);
    const step = tick.ask - tick.bid > minTick * 0.5 ? tick.ask - tick.bid : minTick;
    const result = [];

    for (let i = 10; i >= 1; i--) {
      result.push({
        price: mid + step * i,
        bidSize: 0,
        askSize: Math.floor(Math.random() * 50 + 5),
        type: "ask" as const,
      });
    }
    result.push({
      price: tick.ask,
      bidSize: 0,
      askSize: Math.floor(Math.random() * 100 + 20),
      type: "ask" as const,
    });
    result.push({
      price: tick.bid,
      bidSize: Math.floor(Math.random() * 100 + 20),
      askSize: 0,
      type: "bid" as const,
    });
    for (let i = 1; i <= 10; i++) {
      result.push({
        price: mid - step * i,
        bidSize: Math.floor(Math.random() * 50 + 5),
        askSize: 0,
        type: "bid" as const,
      });
    }
    return result;
    // tick is captured via tick?.bid and tick?.ask; including tick.bid/tick.ask is sufficient
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick?.bid, tick?.ask, pipDigits]);

  const maxSize = Math.max(...levels.map((l) => Math.max(l.bidSize, l.askSize)), 1);

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-secondary">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-bold uppercase tracking-wider text-muted-foreground">
            Depth of Market
          </h3>
          <span className="px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-400 text-[9px] font-semibold uppercase">
            Simulado
          </span>
        </div>
        <span className="text-sm font-bold">{symbol}</span>
      </div>
      <div className="flex-1 overflow-y-auto">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-card z-10">
            <tr>
              <th className="text-right w-[30%] py-2.5">Bid Size</th>
              <th className="text-center w-[40%] py-2.5">Price</th>
              <th className="text-left w-[30%] py-2.5">Ask Size</th>
            </tr>
          </thead>
          <tbody>
            {levels.map((l, i) => (
              <tr key={i} className="relative hover:bg-secondary/50">
                <td className="text-right relative py-2 font-mono font-semibold">
                  {l.bidSize > 0 && (
                    <>
                      <div
                        className="absolute inset-y-0 right-0 bg-buy/20"
                        style={{ width: `${(l.bidSize / maxSize) * 100}%` }}
                      />
                      <span className="relative text-buy">{l.bidSize}</span>
                    </>
                  )}
                </td>
                <td
                  className={cn(
                    "text-center font-mono font-bold py-2",
                    l.type === "ask" ? "text-sell" : "text-buy",
                  )}
                >
                  {formatNumber(l.price, pipDigits)}
                </td>
                <td className="text-left relative py-2 font-mono font-semibold">
                  {l.askSize > 0 && (
                    <>
                      <div
                        className="absolute inset-y-0 left-0 bg-sell/20"
                        style={{ width: `${(l.askSize / maxSize) * 100}%` }}
                      />
                      <span className="relative text-sell">{l.askSize}</span>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
