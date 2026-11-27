import type { Position } from "../services/schemas";

export interface LiveTick {
  bid: number;
  ask: number;
  timestamp: number;
}

// Instantaneous floating PnL directly evaluated against live bid/ask
export function computeLivePnl(p: Position, tick?: LiveTick): number {
  if (!tick) return p.unrealizedPnl;
  const livePrice = p.side === "LONG" ? tick.bid : tick.ask;
  const dir = p.side === "LONG" ? 1 : -1;
  const contract = p.contractSize || 1;
  return (livePrice - p.entryPrice) * p.quantity * contract * dir;
}

export function computeLivePrice(p: Position, tick?: LiveTick): number {
  if (!tick) return p.currentPrice ?? p.entryPrice;
  return p.side === "LONG" ? tick.bid : tick.ask;
}
