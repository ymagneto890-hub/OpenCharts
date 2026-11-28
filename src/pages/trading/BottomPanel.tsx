import { useState, useEffect, useMemo, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  TrendingUp,
  TrendingDown,
  Target,
  Award,
  Scale,
  Activity,
  Flame,
  Percent,
  Clock,
  History,
  Globe,
  Newspaper,
  Bot,
  ChevronDown,
  ChevronUp,
  Camera,
  FileText,
  Wallet,
  RotateCcw,
  Rewind,
  Settings2,
  Check,
  ShieldAlert,
} from "lucide-react";
import { TradeScreenshotsModal } from "./TradeScreenshotsModal.tsx";
import { api } from "../../services/api.ts";
import { useTradingStore } from "../../services/store.tsx";
import { useReplayStore } from "../../services/demo/replay.ts";
import {
  useCancelOrder,
  useClosePosition,
  useCloseAllPositions,
  useClosedPositions,
  useEconomicCalendar,
} from "../../services/queries.ts";
import type {
  JournalEntry,
  CreateJournalEntryInput,
  UpdateJournalEntryInput,
} from "../../services/api/journal.ts";
import type { Account, ClosedPosition, Order, Position } from "../../services/schemas.ts";
import { Button } from "../../components/ui/button.tsx";
import { TradeJournalPanel } from "../../components/TradingDialogs.tsx";
import { AiTraderPanel } from "../AiTraderPage.tsx";
import { toast } from "../../services/toast.ts";
import { formatCurrency, formatNumber, formatDate, cn, pnlClass } from "../../lib/utils.ts";
import { MOCK_EVENTS, MOCK_NEWS } from "./constants.ts";
import { PositionsTable } from "./PositionsTable.tsx";
import { OrdersTable } from "./OrdersTable.tsx";
import { computeLivePnl, computeLivePrice } from "../../lib/livePnl.ts";
import { formatAssetUnits } from "../../hooks/useInstrumentLabels.ts";
import { getPipDigits } from "./utils.ts";
import {
  clearHistory,
  getClosedPositions,
  getSummary,
  resetAccount,
  setCostModel,
  setStartingBalance,
  subscribeEngine,
  type DemoSummary,
} from "../../services/demo/engine.ts";
import { evaluateEconomicEventSentiment } from "../../services/demo/economicEvents.ts";
import type { EconomicCalendarEvent } from "../../services/queries.ts";

type TradingActionError = {
  error?: { message?: string };
  message?: string;
};

type AccountOption = Pick<Account, "id"> & { label?: string | null };

function getErrorMessage(error: unknown): string {
  const actionError = error as TradingActionError;
  return actionError.error?.message || actionError.message || "Request failed";
}

function parseNumericInput(val: string | number, fallback = 0): number {
  if (typeof val === "number") return Number.isFinite(val) ? val : fallback;
  if (!val || typeof val !== "string") return fallback;
  let clean = val.trim();
  if (clean.includes(",") && clean.includes(".")) {
    if (clean.lastIndexOf(".") > clean.lastIndexOf(",")) {
      clean = clean.replace(/,/g, "");
    } else {
      clean = clean.replace(/\./g, "").replace(",", ".");
    }
  } else if (clean.includes(",")) {
    clean = clean.replace(",", ".");
  }
  const parsed = parseFloat(clean);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export type BottomTabKey =
  | "positions"
  | "orders"
  | "history"
  | "journal"
  | "calendar"
  | "news"
  | "account"
  | "ai-trader";

export interface BottomPanelProps {
  tab: BottomTabKey;
  onTabChange: (t: BottomTabKey) => void;
  positions: Position[];
  orders: Order[];
  accountId: string | null;
  onModifyPosition?: (position: Position) => void;
  onModifyOrder?: (order: Order) => void;
  onSelectPositionSymbol?: (symbolName: string) => void;
  onSelectOrderSymbol?: (symbolName: string) => void;
  onReplayTrade?: (trade: ClosedPosition, entryTimeSec: number) => void;
  journalEntries: JournalEntry[];
  journalLoading: boolean;
  onCreateJournal: (data: CreateJournalEntryInput) => void;
  onUpdateJournal: (id: string, data: UpdateJournalEntryInput) => void;
  onDeleteJournal: (id: string) => void;
  aiTraderEnabled?: boolean;
  height?: number;
  isFeedConnected?: boolean;
  isCollapsed?: boolean;
  onToggleCollapse?: () => void;
}

export function BottomPanel({
  tab,
  onTabChange,
  positions,
  orders,
  accountId,
  onModifyPosition,
  onModifyOrder,
  onSelectPositionSymbol,
  onSelectOrderSymbol,
  onReplayTrade,
  journalEntries,
  journalLoading,
  onCreateJournal,
  onUpdateJournal,
  onDeleteJournal,
  aiTraderEnabled,
  height = 220,
  isFeedConnected = true,
  isCollapsed = false,
  onToggleCollapse,
}: BottomPanelProps) {
  const queryClient = useQueryClient();
  const cancelOrder = useCancelOrder();
  const closePosition = useClosePosition();
  const closeAllPositions = useCloseAllPositions();
  const [demoSummary, setDemoSummary] = useState<DemoSummary>(() => getSummary());

  useEffect(() => {
    setDemoSummary(getSummary());
    return subscribeEngine(() => {
      setDemoSummary(getSummary());
    });
  }, []);

  const handleCancel = (orderId: string) => {
    if (!accountId) return;
    if (!isFeedConnected) {
      toast.warning("No Data Feed", "Cannot cancel orders while disconnected");
      return;
    }
    if (cancelOrder.isPending) return;
    cancelOrder.mutate(
      { orderId, accountId },
      {
        onSuccess: () => toast.info("Order Cancelled", "Pending order has been cancelled"),
        onError: (err: unknown) => toast.error("Cancel Failed", getErrorMessage(err)),
      },
    );
  };

  const handleCancelAllOrders = async () => {
    if (!accountId) return;
    if (!isFeedConnected) {
      toast.warning("No Data Feed", "Cannot cancel orders while disconnected");
      return;
    }
    try {
      await api.cancelAllOrders();
      await queryClient.invalidateQueries({ queryKey: ["orders"] });
      if (accountId) {
        await queryClient.invalidateQueries({ queryKey: ["orders", accountId] });
      }
      toast.info("Orders Cancelled", "All pending orders have been cancelled");
    } catch (err: unknown) {
      toast.error("Cancel Failed", getErrorMessage(err));
    }
  };

  const handleClosePosition = (positionId: string) => {
    if (!accountId) return;
    if (!isFeedConnected) {
      toast.warning("No Data Feed", "Cannot close positions while disconnected");
      return;
    }
    if (closePosition.isPending) return;
    closePosition.mutate(
      { positionId, accountId },
      {
        onSuccess: () => toast.success("Position Closed", "Position has been closed"),
        onError: (err: unknown) => toast.error("Close Failed", getErrorMessage(err)),
      },
    );
  };

  const handlePartialClose = (positionId: string, quantity: number) => {
    if (!accountId) return;
    if (!isFeedConnected) {
      toast.warning("No Data Feed", "Cannot close positions while disconnected");
      return;
    }
    if (closePosition.isPending) return;
    closePosition.mutate(
      { positionId, accountId, quantity },
      {
        onSuccess: () =>
          toast.success("Partial Close", `Closed ${quantity} unit(s) of the position`),
        onError: (err: unknown) => toast.error("Partial Close Failed", getErrorMessage(err)),
      },
    );
  };

  const handleCloseAll = () => {
    if (!accountId) return;
    if (!isFeedConnected) {
      toast.warning("No Data Feed", "Cannot close positions while disconnected");
      return;
    }
    closeAllPositions.mutate(accountId, {
      onSuccess: () => toast.success("All Closed", "All positions have been closed"),
      onError: (err: unknown) => toast.error("Close All Failed", getErrorMessage(err)),
    });
  };

  const ticks = useTradingStore((s) => s.ticks);
  const replayPhase = useReplayStore((s) => s.phase);
  const replaySymbol = useReplayStore((s) => s.symbol);
  const openPositions = positions
    .filter((position) => position.quantity > 0)
    .map((p) => {
      if (replayPhase !== "idle" && replaySymbol === p.symbolName) return p;
      const tick = ticks[p.symbolName];
      if (!tick) return p;
      return {
        ...p,
        currentPrice: computeLivePrice(p, tick),
        unrealizedPnl: computeLivePnl(p, tick),
      };
    });
  const pendingOrders = orders.filter(
    (order) => order.status === "PENDING" || order.status === "NEW",
  );
  const totalPnl = openPositions.reduce((sum, position) => sum + (position.unrealizedPnl || 0), 0);
  const liveEquity = Number((demoSummary.balance + totalPnl).toFixed(2));

  const { data: closedData } = useClosedPositions(accountId, 1);
  const historyCount = closedData?.total ?? closedData?.data?.length ?? 0;

  const tabs: {
    key: BottomTabKey;
    label: string;
    icon: typeof Clock;
    count?: number;
  }[] = [
    { key: "positions", label: "Positions", icon: TrendingUp, count: openPositions.length },
    { key: "orders", label: "Orders", icon: Clock, count: pendingOrders.length },
    { key: "history", label: "Trade History", icon: History, count: historyCount },
    { key: "calendar", label: "Calendar", icon: Globe },
    { key: "news", label: "News", icon: Newspaper },
    { key: "account", label: "Cuenta Demo", icon: Wallet },
    ...(aiTraderEnabled ? [{ key: "ai-trader" as const, label: "AI Trader", icon: Bot }] : []),
  ];

  return (
    <div
      className={cn(
        "border-t border-border flex flex-col shrink-0 bg-card transition-[height] duration-150 ease-out",
        isCollapsed ? "h-[34px] overflow-hidden" : "max-h-[150px] md:max-h-none",
      )}
      style={isCollapsed ? undefined : { height }}
    >
      {/* Tab bar */}
      <div
        onDoubleClick={onToggleCollapse}
        className="flex items-center gap-0.5 px-2 py-0.5 border-b border-border bg-secondary text-xs overflow-x-auto no-scrollbar select-none"
      >
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => {
              if (isCollapsed) onToggleCollapse?.();
              onTabChange(t.key);
            }}
            className={cn(
              "flex items-center gap-1 px-2.5 py-1 rounded shrink-0 whitespace-nowrap transition-colors",
              tab === t.key
                ? "bg-card text-foreground shadow-sm font-medium"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <t.icon className="h-3 w-3" />
            <span className="hidden md:inline">{t.label}</span>
            {t.count !== undefined && t.count > 0 && (
              <span className="bg-primary text-primary-foreground rounded-full px-1.5 text-[9px]">
                {t.count}
              </span>
            )}
          </button>
        ))}

        {/* Right side of bottom bar: always-visible Capital / Balance & P&L even when panel is collapsed */}
        <div className="ml-auto flex items-center gap-2.5 shrink-0 pl-2">
          {openPositions.length > 0 && (
            <div className="flex items-center gap-2">
              <span className={cn("font-mono text-xs font-semibold", pnlClass(totalPnl))}>
                P&L: {totalPnl >= 0 ? "+" : ""}
                {formatCurrency(totalPnl)}
              </span>
              {!isCollapsed && tab === "positions" && (
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={handleCloseAll}
                  className="text-[10px] h-5"
                  disabled={closeAllPositions.isPending || !isFeedConnected}
                >
                  Close All
                </Button>
              )}
            </div>
          )}

          {!isCollapsed && tab === "orders" && pendingOrders.length > 0 && (
            <Button
              variant="outline"
              size="sm"
              onClick={handleCancelAllOrders}
              className="text-[10px] h-5 border-destructive/40 text-destructive hover:bg-destructive/10"
              disabled={!isFeedConnected}
            >
              Cancel All ({pendingOrders.length})
            </Button>
          )}

          {/* Always-visible Capital badge on the right of the bottom bar */}
          <div
            onClick={() => {
              if (isCollapsed) onToggleCollapse?.();
              onTabChange("account");
            }}
            title="Haz clic para abrir los ajustes y reinicio de Cuenta Demo"
            className="flex items-center gap-2 px-2.5 py-0.5 rounded bg-card/80 hover:bg-card border border-border/80 cursor-pointer transition-colors text-[11px] font-mono"
          >
            <Wallet className="h-3 w-3 text-primary shrink-0" />
            <span className="text-muted-foreground font-sans font-medium">Capital:</span>
            <span className="font-bold text-foreground">
              {formatCurrency(openPositions.length > 0 ? liveEquity : demoSummary.balance)}
            </span>
          </div>

          {/* Collapse / Deactivate Toggle Button */}
          {onToggleCollapse && (
            <button
              type="button"
              onClick={onToggleCollapse}
              title={
                isCollapsed
                  ? "Expandir panel inferior (o doble clic)"
                  : "Desactivar panel inferior para ganar espacio (o doble clic)"
              }
              className="p-1 hover:bg-card hover:text-foreground text-muted-foreground rounded transition-colors shrink-0 flex items-center gap-1 text-[11px]"
            >
              {isCollapsed ? (
                <>
                  <ChevronUp className="h-3.5 w-3.5 text-primary" />
                  <span className="text-[10px] font-medium text-primary hidden sm:inline">Mostrar panel</span>
                </>
              ) : (
                <ChevronDown className="h-3.5 w-3.5" />
              )}
            </button>
          )}
        </div>
      </div>

      {/* Content */}
      {!isCollapsed && (
        <div className="flex-1 overflow-auto">
        {tab === "positions" && (
          <PositionsTable
            positions={openPositions}
            onClose={handleClosePosition}
            onModify={onModifyPosition as unknown as ((p: { id: string }) => void) | undefined}
            onPartialClose={handlePartialClose}
            onSelectSymbol={onSelectPositionSymbol}
          />
        )}
        {tab === "orders" && (
          <OrdersTable
            orders={pendingOrders}
            onCancel={handleCancel}
            onModify={onModifyOrder as unknown as ((order: { id: string }) => void) | undefined}
            onSelectSymbol={onSelectOrderSymbol}
          />
        )}
        {tab === "history" && (
          <TradeHistoryTable accountId={accountId} onReplayTrade={onReplayTrade} />
        )}
        {tab === "journal" && (
          <TradeJournalPanel
            entries={journalEntries}
            isLoading={journalLoading}
            accountId={accountId}
            onCreateEntry={
              onCreateJournal as unknown as (
                data: Partial<{ notes: string; tags: string[] }> & {
                  notes: string;
                  tags: string[];
                },
              ) => void
            }
            onUpdateEntry={
              onUpdateJournal as unknown as (
                id: string,
                data: Partial<{ notes: string; tags: string[] }> & {
                  notes: string;
                  tags: string[];
                },
              ) => void
            }
            onDeleteEntry={onDeleteJournal}
          />
        )}
        {tab === "calendar" && <EconomicCalendar />}
        {tab === "news" && <NewsFeed />}
        {tab === "account" && (
          <DemoAccountTabPanel accountId={accountId} liveUnrealizedPnl={totalPnl} />
        )}
        {tab === "ai-trader" && <AiTraderPanel accountId={accountId} />}
      </div>
      )}
    </div>
  );
}

// ── Trade History Table ──────────────────────────────────────
function TradeHistoryTable({
  accountId,
  onReplayTrade,
}: {
  accountId: string | null;
  onReplayTrade?: (trade: ClosedPosition, entryTimeSec: number) => void;
}) {
  const [page, setPage] = useState(1);
  const [selectedTrade, setSelectedTrade] = useState<ClosedPosition | null>(null);

  const handleJumpToTradeReplay = (t: ClosedPosition) => {
    const rawEntry = t.openedAt || t.closedAt;
    if (!rawEntry) return;
    const ms = new Date(rawEntry).getTime();
    if (!Number.isFinite(ms) || ms <= 0) return;
    const entryTimeSec = Math.floor(ms / 1000);
    if (onReplayTrade) {
      onReplayTrade(t, entryTimeSec);
      return;
    }
    const res = useReplayStore.getState().start(t.symbolName, "4h", entryTimeSec, { temporary: true, trade: t });
    if (res.ok) {
      useTradingStore.getState().setSelectedSymbol(t.symbolName);
      try {
        localStorage.setItem(`tf_${t.symbolName}`, "4h");
      } catch {
        // ignore storage errors
      }
      toast.success(
        "Replay Temporal (4H)",
        `Posicionado en la entrada del trade (${formatDate(rawEntry)}). Tu fecha por defecto de Replay no ha cambiado.`,
      );
    } else {
      toast.warning("Replay", res.error);
    }
  };
  const { data: closedData, isLoading, refetch } = useClosedPositions(accountId, page);
  const trades: ClosedPosition[] = closedData?.data || [];
  const uniqueTrades = useMemo(() => {
    const seen = new Set<string>();
    return trades.filter((t) => {
      if (!t.id) return true;
      if (seen.has(t.id)) return false;
      seen.add(t.id);
      return true;
    });
  }, [trades]);
  const totalPages = closedData?.totalPages || 1;
  const accounts = useTradingStore((s) => s.accounts as AccountOption[]);
  const activeAccount = accounts.find((account) => account.id === accountId);

  // Re-fetch immediately when demo engine state changes (SL/TP trigger, replay close, account reset)
  useEffect(() => {
    return subscribeEngine(() => {
      refetch();
    });
  }, [refetch]);

  const prevAccRef = useRef(accountId);
  useEffect(() => {
    if (prevAccRef.current !== accountId) {
      setPage(1);
      prevAccRef.current = accountId;
    }
  }, [accountId]);

  if (!accountId)
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground text-xs">
        Select an account
      </div>
    );
  if (isLoading)
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground text-xs">
        Loading...
      </div>
    );
  if (uniqueTrades.length === 0)
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground text-xs">
        No trade history yet
        {activeAccount ? ` for ${activeAccount.label || accountId?.slice(0, 8)}` : ""}
      </div>
    );

  return (
    <div className="flex flex-col h-full">
      <table className="w-full text-[11px]">
        <thead className="sticky top-0 bg-card z-10">
          <tr>
            <th>Closed</th>
            <th>Symbol</th>
            <th>Side</th>
            <th>Units</th>
            <th>Entry</th>
            <th>Exit</th>
            <th>Reason</th>
            <th>Commission</th>
            <th>Gross P&L</th>
            <th>Net P&L</th>
            <th>Notas / Motivo</th>
            <th className="text-center">Capturas</th>
          </tr>
        </thead>
        <tbody>
          {uniqueTrades.map((t) => {
            const digits = getPipDigits(t.symbolName);
            const comm = t.commission ?? 0;
            const gross = t.realizedPnl ?? 0;
            const net = (t as { netPnl?: number }).netPnl ?? gross - comm;
            const rawReason = t.exitReason || (t as { reason?: string }).reason || "manual";
            const reason =
              rawReason === "take-profit" || rawReason === "TP"
                ? "TP"
                : rawReason === "stop-loss" || rawReason === "SL"
                  ? "SL"
                  : rawReason === "replay-end"
                    ? "Replay"
                    : rawReason === "liquidation"
                      ? "Liquidación"
                      : "Manual";
            return (
              <tr key={t.id} className="hover:bg-secondary/30">
                <td className="text-muted-foreground font-mono">
                  <button
                    type="button"
                    onClick={() => handleJumpToTradeReplay(t)}
                    title={`Ir al Replay temporal en 4H en el momento de entrada (${formatDate(t.openedAt || t.closedAt || "")}) — no cambia tu fecha de Replay por defecto`}
                    className="inline-flex items-center gap-1 hover:text-primary hover:underline transition-colors cursor-pointer text-left group"
                  >
                    <Rewind className="w-3 h-3 text-primary/70 group-hover:text-primary shrink-0 transition-transform group-hover:-translate-x-0.5" />
                    <span>{formatDate(t.closedAt || t.openedAt)}</span>
                  </button>
                </td>
                <td className="font-semibold">{t.symbolName}</td>
                <td className={t.side === "LONG" ? "text-buy" : "text-sell"}>{t.side}</td>
                <td className="font-mono">{formatAssetUnits(t.quantity, t.symbolName)}</td>
                <td className="font-mono">
                  {t.entryPrice ? formatNumber(t.entryPrice, digits) : "--"}
                </td>
                <td className="font-mono">
                  {t.exitPrice ? formatNumber(t.exitPrice, digits) : "--"}
                </td>
                <td>
                  <span
                    className={cn(
                      "px-1.5 py-0.5 rounded text-[9px] font-medium",
                      reason === "TP"
                        ? "bg-buy/20 text-buy"
                        : reason === "SL"
                          ? "bg-sell/20 text-sell"
                          : "bg-secondary text-muted-foreground",
                    )}
                  >
                    {reason}
                  </span>
                </td>
                <td className="font-mono text-muted-foreground">
                  {comm > 0 ? `-${comm.toFixed(2)}` : "0.00"}
                </td>
                <td
                  className={cn(
                    "font-mono",
                    gross >= 0 ? "text-success/70" : "text-destructive/70",
                  )}
                >
                  {`${gross >= 0 ? "+" : ""}${gross.toFixed(2)}`}
                </td>
                <td className={cn("font-mono font-semibold", pnlClass(net))}>
                  {`${net >= 0 ? "+" : ""}${net.toFixed(2)}`}
                </td>
                <td className="max-w-[170px] truncate" title={t.notes || "Sin notas registradas"}>
                  {t.notes ? (
                    <button
                      type="button"
                      onClick={() => setSelectedTrade(t)}
                      className="inline-flex items-center gap-1 text-[10px] text-foreground font-sans px-1.5 py-0.5 rounded bg-primary/10 border border-primary/20 hover:bg-primary/20 transition-colors max-w-full truncate text-left cursor-pointer"
                    >
                      <FileText className="w-2.5 h-2.5 text-primary shrink-0" />
                      <span className="truncate">{t.notes}</span>
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setSelectedTrade(t)}
                      className="text-muted-foreground/40 hover:text-primary text-[10px] transition-colors cursor-pointer"
                      title="Añadir nota o explicación del trade"
                    >
                      + nota
                    </button>
                  )}
                </td>
                <td className="text-center">
                  <button
                    type="button"
                    onClick={() => setSelectedTrade(t)}
                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium bg-primary/10 hover:bg-primary/20 text-primary transition-colors cursor-pointer"
                    title="Ver capturas (4H y Diario) y bitácora del trade"
                  >
                    <Camera className="w-3 h-3" />
                    <span>Ver</span>
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-2 py-1 border-t border-border text-[10px]">
          <button
            onClick={() => setPage(Math.max(1, page - 1))}
            disabled={page <= 1}
            className="px-1.5 py-0.5 rounded bg-secondary hover:bg-secondary/80 disabled:opacity-40"
          >
            Prev
          </button>
          <span className="text-muted-foreground">
            {page} / {totalPages}
          </span>
          <button
            onClick={() => setPage(Math.min(totalPages, page + 1))}
            disabled={page >= totalPages}
            className="px-1.5 py-0.5 rounded bg-secondary hover:bg-secondary/80 disabled:opacity-40"
          >
            Next
          </button>
        </div>
      )}
      {selectedTrade && (
        <TradeScreenshotsModal
          trade={selectedTrade}
          onClose={() => setSelectedTrade(null)}
        />
      )}
    </div>
  );
}

// ── Economic Calendar ────────────────────────────────────────
function EconomicCalendar() {
  const { data: calendarEvents } = useEconomicCalendar(["USD", "EUR", "GBP"]);
  const [sentimentOverrides, setSentimentOverrides] = useState<
    Record<string, "bullish" | "bearish" | "neutral">
  >(() => {
    try {
      const raw = localStorage.getItem("oc_news_sentiment_overrides_v1");
      const parsed = raw ? JSON.parse(raw) : null;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  });

  const toggleEventSentiment = (eventId: string, current: "bullish" | "bearish" | "neutral") => {
    const nextVal: "bullish" | "bearish" = current === "bullish" ? "bearish" : "bullish";
    setSentimentOverrides((prev) => {
      const updated = { ...prev, [eventId]: nextVal };
      try {
        localStorage.setItem("oc_news_sentiment_overrides_v1", JSON.stringify(updated));
      } catch {
        // safe
      }
      return updated;
    });
  };

  const impactColor: Record<string, string> = {
    low: "bg-muted text-muted-foreground",
    medium: "bg-warning/20 text-warning",
    high: "bg-destructive/20 text-destructive",
  };

  const events = calendarEvents && calendarEvents.length > 0 ? calendarEvents : MOCK_EVENTS;

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center justify-between px-2 py-1 border-b border-border/40 shrink-0">
        <div className="flex items-center gap-2">
          <span className="px-2 py-0.5 rounded text-[10px] font-medium bg-primary/15 text-primary">
            Calendario Económico ({events.length} eventos históricos y futuros)
          </span>
        </div>
      </div>
      <div className="flex-1 overflow-auto">
        <table className="w-full text-[11px]">
          <thead className="sticky top-0 bg-card z-10 border-b border-border/40">
            <tr>
              <th className="text-left px-2 py-1">Fecha / Hora</th>
              <th className="text-left px-2 py-1">Divisa</th>
                <th className="text-left px-2 py-1">Impacto</th>
                <th className="text-left px-2 py-1">Evento</th>
                <th className="text-center px-2 py-1">Efecto / Sentimiento</th>
                <th className="text-right px-2 py-1">Previsión</th>
                <th className="text-right px-2 py-1">Anterior</th>
                <th className="text-right px-2 py-1">Actual</th>
              </tr>
            </thead>
            <tbody>
              {events.map((ev, i) => {
                const formattedTime = ev.time.includes("T")
                  ? ev.time.replace("T", " ").slice(0, 16)
                  : ev.time;
                const evId = "id" in ev ? (ev as { id: string }).id : `ev-${i}`;
                const autoEval = "id" in ev ? evaluateEconomicEventSentiment(ev as EconomicCalendarEvent) : null;
                const rawSentiment =
                  sentimentOverrides[evId] ??
                  ("sentiment" in ev ? (ev as { sentiment?: "bullish" | "bearish" | "neutral" }).sentiment : undefined) ??
                  autoEval?.sentiment;
                const sentiment: "bullish" | "bearish" | "neutral" =
                  rawSentiment === "bullish" || rawSentiment === "bearish" ? rawSentiment : "neutral";
                const sentimentReason =
                  ("sentimentReason" in ev && typeof (ev as { sentimentReason?: string }).sentimentReason === "string"
                    ? (ev as { sentimentReason: string }).sentimentReason
                    : autoEval?.reason) || "Dato económico";

                return (
                  <tr key={evId} className="hover:bg-secondary/30 border-b border-border/10">
                    <td className="px-2 py-1 text-muted-foreground font-mono">{formattedTime}</td>
                    <td className="px-2 py-1 font-semibold">{ev.currency}</td>
                    <td className="px-2 py-1">
                      <span
                        className={cn(
                          "px-1.5 py-0.5 rounded text-[9px] font-medium",
                          impactColor[ev.impact] || "bg-muted text-muted-foreground",
                        )}
                      >
                        {ev.impact.toUpperCase()}
                      </span>
                    </td>
                    <td className="px-2 py-1">{ev.event}</td>
                    <td className="px-2 py-1 text-center">
                      <button
                        type="button"
                        onClick={() => toggleEventSentiment(evId, sentiment)}
                        title={`${sentimentReason} (Clic para cambiar a ${sentiment === "bullish" ? "Bajista" : "Alcista"})`}
                        className={cn(
                          "px-2 py-0.5 rounded text-[10px] font-bold border transition-colors inline-flex items-center gap-1 cursor-pointer",
                          sentiment === "bullish"
                            ? "bg-emerald-500/15 text-emerald-400 border-emerald-500/30 hover:bg-emerald-500/25"
                            : sentiment === "bearish"
                              ? "bg-red-500/15 text-red-400 border-red-500/30 hover:bg-red-500/25"
                              : "bg-amber-500/15 text-amber-400 border-amber-500/30 hover:bg-amber-500/25",
                        )}
                      >
                        {sentiment === "bullish"
                          ? "▲ ALCISTA (BUENO)"
                          : sentiment === "bearish"
                            ? "▼ BAJISTA (MALO)"
                            : "— NEUTRAL"}
                      </button>
                    </td>
                    <td className="px-2 py-1 text-right font-mono">{ev.forecast || "--"}</td>
                    <td className="px-2 py-1 text-right font-mono text-muted-foreground">{ev.previous || "--"}</td>
                    <td
                      className={cn(
                        "px-2 py-1 text-right font-mono font-semibold",
                        sentiment === "bullish"
                          ? "text-emerald-400"
                          : sentiment === "bearish"
                            ? "text-red-400"
                            : undefined,
                      )}
                    >
                      {ev.actual || "--"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
    </div>
  );
}

// ── News Feed ────────────────────────────────────────────────
function NewsFeed() {
  const { data: calendarEvents } = useEconomicCalendar(["USD", "EUR", "GBP"]);

  const impactStyle = {
    bullish: "text-buy",
    bearish: "text-sell",
    neutral: "text-muted-foreground",
  };

  const combinedNews = useMemo(() => {
    const list = [...MOCK_NEWS];
    if (calendarEvents) {
      for (const ev of calendarEvents.slice(0, 40)) {
        const d = new Date(ev.time);
        const dateStr = d.toLocaleDateString(undefined, {
          month: "short",
          day: "numeric",
          year: "numeric",
        });
        const timeStr = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
        const autoEval = evaluateEconomicEventSentiment(ev);
        const sentiment = ev.sentiment || autoEval.sentiment;
        list.push({
          time: `${dateStr} ${timeStr}`,
          source: ev.country ? `${ev.country} Macro` : "Econ Data",
          impact: sentiment,
          title: `[${ev.currency}] ${ev.event} - Actual: ${ev.actual || "Pendiente"} (Prev: ${ev.previous || "--"}, Exp: ${ev.forecast || "--"}) · ${autoEval.label}`,
        });
      }
    }
    return list;
  }, [calendarEvents]);

  return (
    <div className="divide-y divide-border/30 overflow-auto h-full">
      {combinedNews.map((item, i) => (
        <div key={i} className="px-3 py-2 hover:bg-secondary/30 cursor-pointer">
          <div className="flex items-center gap-2 text-[10px] text-muted-foreground mb-0.5">
            <span className="font-mono">{item.time}</span>
            <span className="text-muted-foreground">|</span>
            <span>{item.source}</span>
            <span className={cn("font-semibold", impactStyle[item.impact])}>
              {item.impact === "bullish"
                ? "ALCISTA (BUENO)"
                : item.impact === "bearish"
                  ? "BAJISTA (MALO)"
                  : "NEUTRAL"}
            </span>
          </div>
          <p className="text-xs leading-snug">{item.title}</p>
        </div>
      ))}
    </div>
  );
}

const CAPITAL_PRESETS = [1_000, 5_000, 10_000, 25_000, 50_000, 100_000] as const;

function DemoAccountTabPanel({
  accountId,
  liveUnrealizedPnl,
}: {
  accountId: string | null;
  liveUnrealizedPnl?: number;
}) {
  const queryClient = useQueryClient();
  const [summary, setSummary] = useState<DemoSummary>(() => getSummary());
  const [closedList, setClosedList] = useState<ClosedPosition[]>(() => getClosedPositions());

  const [capitalInput, setCapitalInput] = useState(() => String(getSummary().startingBalance));
  const [resetCapitalInput, setResetCapitalInput] = useState(() =>
    String(getSummary().startingBalance),
  );
  const [resetFeePctInput, setResetFeePctInput] = useState(() =>
    String(Number((getSummary().feeRate * 100).toFixed(4))),
  );
  const [keepHistory, setKeepHistory] = useState(false);
  const [spreadBpsInput, setSpreadBpsInput] = useState(() => String(getSummary().spreadBps));
  const [slippageBpsInput, setSlippageBpsInput] = useState(() => String(getSummary().slippageBps));

  useEffect(() => {
    const sync = () => {
      const s = getSummary();
      setSummary(s);
      setClosedList(getClosedPositions());
      setSpreadBpsInput(String(s.spreadBps));
      setSlippageBpsInput(String(s.slippageBps));
    };
    sync();
    return subscribeEngine(sync);
  }, []);

  const unrealized = liveUnrealizedPnl ?? summary.unrealizedPnl;
  const equity = Number((summary.balance + unrealized).toFixed(2));

  // Compute performance KPIs for the active demo session
  const sessionTrades = useMemo(() => {
    return closedList.filter((c) => c.sessionId === summary.sessionId);
  }, [closedList, summary.sessionId]);

  const stats = useMemo(() => {
    const netPnls = sessionTrades.map((c) => c.realizedPnl - c.commission);
    const wins = netPnls.filter((n) => n > 0);
    const losses = netPnls.filter((n) => n < 0);
    const totalTrades = netPnls.length;
    const winCount = wins.length;
    const lossCount = losses.length;
    const winRatePct = totalTrades > 0 ? (winCount / totalTrades) * 100 : 0;
    const totalProfit = wins.reduce((a, b) => a + b, 0);
    const totalLoss = Math.abs(losses.reduce((a, b) => a + b, 0));

    const avgWin = winCount > 0 ? totalProfit / winCount : 0;
    const avgLoss = lossCount > 0 ? totalLoss / lossCount : 0;
    const payoffRatio = avgLoss > 0 ? avgWin / avgLoss : avgWin > 0 ? Infinity : 0;
    const profitFactor = totalLoss > 0 ? totalProfit / totalLoss : totalProfit > 0 ? Infinity : 0;
    const netTotalPnl = netPnls.reduce((a, b) => a + b, 0);
    const expectancy = totalTrades > 0 ? netTotalPnl / totalTrades : 0;
    const bestTrade = netPnls.length > 0 ? Math.max(...netPnls) : 0;
    const worstTrade = netPnls.length > 0 ? Math.min(...netPnls) : 0;

    let maxConsecutiveWins = 0;
    let curWins = 0;
    let maxConsecutiveLosses = 0;
    let curLosses = 0;
    const chrono = [...netPnls].reverse();

    let peakBalance = summary.startingBalance;
    let runningBalance = summary.startingBalance;
    let maxDrawdownDollar = 0;
    let maxDrawdownPct = 0;

    for (const pnl of chrono) {
      if (pnl > 0) {
        curWins += 1;
        curLosses = 0;
        if (curWins > maxConsecutiveWins) maxConsecutiveWins = curWins;
      } else if (pnl < 0) {
        curLosses += 1;
        curWins = 0;
        if (curLosses > maxConsecutiveLosses) maxConsecutiveLosses = curLosses;
      } else {
        curWins = 0;
        curLosses = 0;
      }

      runningBalance += pnl;
      if (runningBalance > peakBalance) {
        peakBalance = runningBalance;
      }
      const ddDollar = peakBalance - runningBalance;
      const ddPct = peakBalance > 0 ? (ddDollar / peakBalance) * 100 : 0;
      if (ddDollar > maxDrawdownDollar) {
        maxDrawdownDollar = ddDollar;
      }
      if (ddPct > maxDrawdownPct) {
        maxDrawdownPct = ddPct;
      }
    }

    const tpExits = sessionTrades.filter((c) => c.exitReason === "take-profit").length;
    const slExits = sessionTrades.filter((c) => c.exitReason === "stop-loss").length;
    const liqExits = sessionTrades.filter((c) => c.exitReason === "liquidation").length;
    const manualExits = sessionTrades.filter(
      (c) => c.exitReason === "manual" || !c.exitReason || c.exitReason === "replay-end",
    ).length;

    return {
      totalTrades,
      winCount,
      lossCount,
      winRatePct,
      avgWin,
      avgLoss,
      payoffRatio,
      profitFactor,
      expectancy,
      bestTrade,
      worstTrade,
      maxConsecutiveWins,
      maxConsecutiveLosses,
      maxDrawdownDollar,
      maxDrawdownPct,
      tpExits,
      slExits,
      liqExits,
      manualExits,
    };
  }, [sessionTrades, summary.startingBalance]);

  const refreshAllQueries = async () => {
    const s = getSummary();
    setSummary(s);
    setClosedList(getClosedPositions());
    setCapitalInput(String(s.startingBalance));
    setResetCapitalInput(String(s.startingBalance));
    setResetFeePctInput(String(Number((s.feeRate * 100).toFixed(4))));
    const store = useTradingStore.getState();
    await store.loadAccounts();
    await store.loadPositions();
    await store.loadOrders();
    queryClient.invalidateQueries({ queryKey: ["positions"] });
    queryClient.invalidateQueries({ queryKey: ["orders"] });
    queryClient.invalidateQueries({ queryKey: ["closedPositions"] });
    queryClient.invalidateQueries({ queryKey: ["fills"] });
    if (accountId) {
      queryClient.invalidateQueries({ queryKey: ["positions", accountId] });
      queryClient.invalidateQueries({ queryKey: ["orders", accountId] });
      queryClient.invalidateQueries({ queryKey: ["closedPositions", accountId] });
      queryClient.invalidateQueries({ queryKey: ["fills", accountId] });
    }
  };

  const handleSaveCapital = async () => {
    const val = parseNumericInput(capitalInput, 0);
    if (!Number.isFinite(val) || val <= 0) {
      toast.warning("Capital inválido", "Introduce un capital inicial mayor a 0");
      return;
    }
    try {
      setStartingBalance(val);
      await refreshAllQueries();
      toast.success(
        "Capital Inicial Actualizado",
        `Nuevo capital inicial configurado en ${formatCurrency(val)}`,
      );
    } catch (err: unknown) {
      toast.error(
        "Error",
        err instanceof Error ? err.message : "No se pudo actualizar el capital inicial",
      );
    }
  };

  const handleSaveCosts = () => {
    const spread = parseNumericInput(spreadBpsInput, -1);
    const slip = parseNumericInput(slippageBpsInput, -1);
    if (!(spread >= 0 && spread <= 500) || !(slip >= 0 && slip <= 500)) {
      toast.warning("Costes inválidos", "Spread y slippage deben estar entre 0 y 500 puntos básicos");
      return;
    }
    try {
      setCostModel(spread, slip);
      setSummary(getSummary());
      toast.success(
        "Costes de ejecución guardados",
        `Spread ${spread} bps + slippage ${slip} bps (aplica a nuevas ejecuciones)`,
      );
    } catch (err: unknown) {
      toast.error("Error", err instanceof Error ? err.message : "No se pudieron guardar los costes");
    }
  };

  const handleConfirmReset = async () => {
    const startBal = parseNumericInput(resetCapitalInput, 0);
    const feePct = parseNumericInput(resetFeePctInput, -1);
    if (!Number.isFinite(startBal) || startBal <= 0) {
      toast.warning("Capital inválido", "Introduce un capital inicial mayor a 0");
      return;
    }
    if (!Number.isFinite(feePct) || feePct < 0 || feePct >= 10) {
      toast.warning("Comisión inválida", "La comisión debe estar entre 0% y 10%");
      return;
    }
    const feeRate = feePct / 100;

    try {
      resetAccount({
        startingBalance: startBal,
        feeRate,
        keepHistory,
      });
      if (!keepHistory) {
        queryClient.setQueriesData({ queryKey: ["closedPositions"] }, {
          data: [],
          total: 0,
          page: 1,
          pageSize: 50,
          totalPages: 1,
        });
        queryClient.setQueriesData({ queryKey: ["fills"] }, {
          data: [],
          total: 0,
          page: 1,
          pageSize: 50,
          totalPages: 1,
        });
      }
      queryClient.setQueriesData({ queryKey: ["positions"] }, []);
      queryClient.setQueriesData({ queryKey: ["orders"] }, []);
      await refreshAllQueries();
      toast.success(
        "Cuenta Demo Reiniciada",
        `Saldo restablecido a ${formatCurrency(startBal)}${
          keepHistory ? " (historial conservado)" : " (historial borrado)"
        }`,
      );
    } catch (err: unknown) {
      toast.error(
        "No se pudo reiniciar",
        err instanceof Error ? err.message : "Error al reiniciar la cuenta",
      );
    }
  };

  return (
    <div className="p-3.5 space-y-3.5 overflow-auto h-full text-xs">
      {/* 1. Top Metrics Strip: Saldos y Capital */}
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-2.5">
        <div className="p-2.5 rounded-lg border border-border bg-secondary/30">
          <div className="text-[11px] font-medium text-muted-foreground">Capital Inicial</div>
          <div className="font-mono font-bold text-base text-foreground mt-0.5">
            {formatCurrency(summary.startingBalance)}
          </div>
        </div>
        <div className="p-2.5 rounded-lg border border-border bg-secondary/30">
          <div className="text-[11px] font-medium text-muted-foreground">Saldo Actual</div>
          <div className="font-mono font-bold text-base text-foreground mt-0.5">
            {formatCurrency(summary.balance)}
          </div>
        </div>
        <div className="p-2.5 rounded-lg border border-border bg-secondary/30">
          <div className="text-[11px] font-medium text-muted-foreground">Equidad (Capital Vivo)</div>
          <div className="font-mono font-bold text-base text-foreground mt-0.5">
            {formatCurrency(equity)}
          </div>
        </div>
        <div className="p-2.5 rounded-lg border border-border bg-secondary/30">
          <div className="text-[11px] font-medium text-muted-foreground">P&L Flotante</div>
          <div className={cn("font-mono font-bold text-base mt-0.5", pnlClass(unrealized))}>
            {unrealized >= 0 ? "+" : ""}
            {formatCurrency(unrealized)}
          </div>
        </div>
        <div className="p-2.5 rounded-lg border border-border bg-secondary/30">
          <div className="text-[11px] font-medium text-muted-foreground">Ganancias Brutas</div>
          <div className="font-mono font-bold text-base text-buy mt-0.5">
            +{formatCurrency(summary.grossProfit)}
          </div>
        </div>
        <div className="p-2.5 rounded-lg border border-border bg-secondary/30">
          <div className="text-[11px] font-medium text-muted-foreground">Pérdidas Brutas</div>
          <div className="font-mono font-bold text-base text-sell mt-0.5">
            -{formatCurrency(summary.grossLoss)}
          </div>
        </div>
        <div className="p-2.5 rounded-lg border border-border bg-secondary/30">
          <div className="text-[11px] font-medium text-muted-foreground">Comisiones Totales</div>
          <div className="font-mono font-bold text-base text-muted-foreground mt-0.5">
            -{formatCurrency(summary.fees)}
          </div>
        </div>
      </div>

      {/* 2. Rendimiento & Estadísticas de Trading (Average de Ganancias, Victorias, Win Rate, etc.) */}
      <div className="rounded-xl border border-border/80 bg-secondary/15 p-3.5 space-y-3">
        <div className="flex items-center justify-between">
          <h4 className="font-bold text-foreground flex items-center gap-2 text-[13px]">
            <Award className="h-4 w-4 text-primary" />
            <span>Estadísticas de Rendimiento & Ratios de Trading (Sesión Actual)</span>
          </h4>
          <span className="text-[11px] text-muted-foreground font-mono">
            {stats.totalTrades} {stats.totalTrades === 1 ? "operación cerrada" : "operaciones cerradas"}
          </span>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2.5">
          {/* Tarjeta 1: Win Rate / Victorias */}
          <div className="p-2.5 rounded-lg border border-border/70 bg-card/70 space-y-1">
            <div className="flex items-center justify-between text-[11px] text-muted-foreground font-medium">
              <span>Victorias / Win Rate</span>
              <Target className="h-3.5 w-3.5 text-primary" />
            </div>
            <div
              className={cn(
                "font-mono font-extrabold text-lg",
                stats.winRatePct >= 50
                  ? "text-buy"
                  : stats.totalTrades > 0
                    ? "text-sell"
                    : "text-foreground",
              )}
            >
              {stats.winRatePct.toFixed(1)}%
            </div>
            <div className="text-[10.5px] text-muted-foreground">
              {stats.winCount}W / {stats.lossCount}L ({stats.totalTrades} trades)
            </div>
          </div>

          {/* Tarjeta 2: Average de Ganancias (Avg Win) */}
          <div className="p-2.5 rounded-lg border border-border/70 bg-card/70 space-y-1">
            <div className="flex items-center justify-between text-[11px] text-muted-foreground font-medium">
              <span>Ganancia Media</span>
              <TrendingUp className="h-3.5 w-3.5 text-buy" />
            </div>
            <div className="font-mono font-extrabold text-lg text-buy">
              +{formatCurrency(stats.avgWin)}
            </div>
            <div className="text-[10.5px] text-muted-foreground">
              Promedio por trade ganador
            </div>
          </div>

          {/* Tarjeta 3: Pérdida Media (Avg Loss) */}
          <div className="p-2.5 rounded-lg border border-border/70 bg-card/70 space-y-1">
            <div className="flex items-center justify-between text-[11px] text-muted-foreground font-medium">
              <span>Pérdida Media</span>
              <TrendingDown className="h-3.5 w-3.5 text-sell" />
            </div>
            <div className="font-mono font-extrabold text-lg text-sell">
              -{formatCurrency(stats.avgLoss)}
            </div>
            <div className="text-[10.5px] text-muted-foreground">
              Promedio por trade perdedor
            </div>
          </div>

          {/* Tarjeta 4: Ratio Riesgo / Beneficio Real (Payoff Ratio) */}
          <div className="p-2.5 rounded-lg border border-border/70 bg-card/70 space-y-1">
            <div className="flex items-center justify-between text-[11px] text-muted-foreground font-medium">
              <span>Ratio R:R Real</span>
              <Scale className="h-3.5 w-3.5 text-primary" />
            </div>
            <div className="font-mono font-extrabold text-lg text-foreground">
              {stats.payoffRatio === Infinity ? "∞" : stats.payoffRatio.toFixed(2)} : 1
            </div>
            <div className="text-[10.5px] text-muted-foreground">
              Avg Win ÷ Avg Loss
            </div>
          </div>

          {/* Tarjeta 5: Profit Factor */}
          <div className="p-2.5 rounded-lg border border-border/70 bg-card/70 space-y-1">
            <div className="flex items-center justify-between text-[11px] text-muted-foreground font-medium">
              <span>Profit Factor</span>
              <Activity className="h-3.5 w-3.5 text-primary" />
            </div>
            <div
              className={cn(
                "font-mono font-extrabold text-lg",
                stats.profitFactor >= 1.5
                  ? "text-buy"
                  : stats.profitFactor >= 1
                    ? "text-foreground"
                    : "text-sell",
              )}
            >
              {stats.profitFactor === Infinity ? "∞" : stats.profitFactor.toFixed(2)}
            </div>
            <div className="text-[10.5px] text-muted-foreground">
              Ganancias ÷ Pérdidas
            </div>
          </div>

          {/* Tarjeta 6: Esperanza Matemática / P&L medio */}
          <div className="p-2.5 rounded-lg border border-border/70 bg-card/70 space-y-1">
            <div className="flex items-center justify-between text-[11px] text-muted-foreground font-medium">
              <span>Esperanza / Trade</span>
              <Percent className="h-3.5 w-3.5 text-primary" />
            </div>
            <div className={cn("font-mono font-extrabold text-lg", pnlClass(stats.expectancy))}>
              {stats.expectancy >= 0 ? "+" : ""}
              {formatCurrency(stats.expectancy)}
            </div>
            <div className="text-[10.5px] text-muted-foreground">
              Resultado neto medio
            </div>
          </div>
        </div>

        {/* Fila secundaria de detalles: Mejor trade, Peor trade, Rachas, Max Drawdown y Desglose */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2.5 pt-1 text-[11.5px]">
          <div className="flex items-center justify-between px-3 py-2 rounded-lg bg-card/50 border border-border/50">
            <span className="text-muted-foreground">Mejor Trade:</span>
            <span className={`font-mono font-bold ${pnlClass(stats.bestTrade)}`}>
              {stats.bestTrade > 0 ? "+" : ""}
              {formatCurrency(stats.bestTrade)}
            </span>
          </div>
          <div className="flex items-center justify-between px-3 py-2 rounded-lg bg-card/50 border border-border/50">
            <span className="text-muted-foreground">Peor Trade:</span>
            <span className={`font-mono font-bold ${pnlClass(stats.worstTrade)}`}>
              {stats.worstTrade > 0 ? "+" : ""}
              {formatCurrency(stats.worstTrade)}
            </span>
          </div>
          <div className="flex items-center justify-between px-3 py-2 rounded-lg bg-card/50 border border-border/50">
            <span className="text-muted-foreground flex items-center gap-1">
              <Flame className="h-3.5 w-3.5 text-orange-400" />
              <span>Rachas máx:</span>
            </span>
            <span className="font-mono font-bold text-foreground">
              {stats.maxConsecutiveWins}W / {stats.maxConsecutiveLosses}L
            </span>
          </div>
          <div className="flex items-center justify-between px-3 py-2 rounded-lg bg-card/50 border border-border/50">
            <span className="text-muted-foreground flex items-center gap-1">
              <ShieldAlert className="h-3.5 w-3.5 text-sell" />
              <span>Max Drawdown:</span>
            </span>
            <span className="font-mono font-bold text-sell">
              -{formatCurrency(stats.maxDrawdownDollar)} ({stats.maxDrawdownPct.toFixed(1)}%)
            </span>
          </div>
        </div>

        {/* Desglose de salidas por motivo */}
        <div className="flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground px-1 pt-1 border-t border-border/40">
          <span className="font-semibold text-foreground">Salidas de posición:</span>
          <span className="text-buy font-medium">TP: {stats.tpExits}</span>
          <span className="text-sell font-medium">SL: {stats.slExits}</span>
          {stats.liqExits > 0 && <span className="text-destructive font-bold">Liquidación: {stats.liqExits}</span>}
          <span>Manual / Replay: {stats.manualExits}</span>
        </div>
      </div>

      {/* Controls: Capital Inicial & Reiniciar Cuenta */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {/* Card 1: Configurar Capital Inicial */}
        <div className="p-3 rounded-lg border border-border bg-secondary/20 space-y-2.5">
          <div className="flex items-center justify-between">
            <h4 className="font-bold text-foreground flex items-center gap-1.5 text-xs">
              <Settings2 className="h-3.5 w-3.5 text-primary" />
              <span>Configurar Capital Inicial</span>
            </h4>
          </div>

          <div className="flex items-center gap-2">
            <input
              type="number"
              value={capitalInput}
              onChange={(e) => setCapitalInput(e.target.value)}
              min="10"
              step="100"
              className="flex-1 bg-background border border-border rounded px-2.5 py-1.5 font-mono text-xs"
            />
            <Button size="sm" onClick={handleSaveCapital} className="text-xs h-8 px-3">
              Guardar Capital
            </Button>
          </div>

          <div className="grid grid-cols-6 gap-1">
            {CAPITAL_PRESETS.map((preset) => (
              <button
                key={preset}
                type="button"
                onClick={() => setCapitalInput(String(preset))}
                className={cn(
                  "py-1 rounded text-[10px] font-mono border transition-colors",
                  Number(capitalInput) === preset
                    ? "bg-primary/15 border-primary/40 text-primary font-semibold"
                    : "border-border hover:bg-secondary text-muted-foreground",
                )}
              >
                ${(preset / 1000).toFixed(0)}k
              </button>
            ))}
          </div>

          {/* Execution costs: non-destructive, applies to future fills only */}
          <div className="pt-2 border-t border-border/60 space-y-1.5">
            <div className="text-[11px] font-semibold text-foreground">Costes de ejecución (puntos básicos)</div>
            <div className="grid grid-cols-[1fr_1fr_auto] gap-2 items-end">
              <div>
                <label className="text-[10px] text-muted-foreground block mb-0.5">Spread (bps)</label>
                <input
                  type="number"
                  value={spreadBpsInput}
                  onChange={(e) => setSpreadBpsInput(e.target.value)}
                  min="0"
                  max="500"
                  step="0.5"
                  className="w-full bg-background border border-border rounded px-2 py-1 font-mono text-xs"
                />
              </div>
              <div>
                <label className="text-[10px] text-muted-foreground block mb-0.5">Slippage (bps)</label>
                <input
                  type="number"
                  value={slippageBpsInput}
                  onChange={(e) => setSlippageBpsInput(e.target.value)}
                  min="0"
                  max="500"
                  step="0.5"
                  className="w-full bg-background border border-border rounded px-2 py-1 font-mono text-xs"
                />
              </div>
              <Button size="sm" onClick={handleSaveCosts} className="text-xs h-7 px-3">
                Guardar
              </Button>
            </div>
            <div className="text-[10px] text-muted-foreground leading-snug">
              1 bp = 0,01 %. Las órdenes de mercado, stops y cierres pagan medio spread + slippage en contra;
              las órdenes límite y el take-profit no. Referencia: BTC ≈ 1–2 bps de spread; altcoins más.
            </div>
          </div>
        </div>

        {/* Card 2: Reiniciar Cuenta Demo */}
        <div className="p-3 rounded-lg border border-destructive/30 bg-destructive/5 space-y-2.5">
          <div className="flex items-center justify-between">
            <h4 className="font-bold text-destructive flex items-center gap-1.5 text-xs">
              <RotateCcw className="h-3.5 w-3.5" />
              <span>Reiniciar Cuenta Demo</span>
            </h4>
            <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground cursor-pointer select-none">
              <input
                type="checkbox"
                checked={keepHistory}
                onChange={(e) => setKeepHistory(e.target.checked)}
                className="rounded accent-primary w-3.5 h-3.5"
              />
              <span className="flex items-center gap-1">
                {keepHistory && <Check className="h-3 w-3 text-primary" />}
                Conservar historial
              </span>
            </label>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-[10px] text-muted-foreground block mb-0.5">
                Nuevo Capital (USD)
              </label>
              <input
                type="number"
                value={resetCapitalInput}
                onChange={(e) => setResetCapitalInput(e.target.value)}
                min="10"
                step="100"
                className="w-full bg-background border border-border rounded px-2 py-1 font-mono text-xs"
              />
            </div>
            <div>
              <label className="text-[10px] text-muted-foreground block mb-0.5">
                Comisión (%)
              </label>
              <input
                type="number"
                value={resetFeePctInput}
                onChange={(e) => setResetFeePctInput(e.target.value)}
                min="0"
                max="5"
                step="0.01"
                className="w-full bg-background border border-border rounded px-2 py-1 font-mono text-xs"
              />
            </div>
          </div>

          <Button
            variant="destructive"
            size="sm"
            onClick={handleConfirmReset}
            className="w-full text-xs h-8 font-bold flex items-center justify-center gap-1.5"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            <span>
              {keepHistory
                ? "Reiniciar Capital (Conservar Historial)"
                : "Reiniciar Capital y Borrar Historial"}
            </span>
          </Button>

          <div className="flex items-center justify-between pt-1 border-t border-destructive/20 text-[10.5px]">
            <span className="text-muted-foreground/80">
              {!keepHistory
                ? "⚠️ Saldo a $" + parseNumericInput(resetCapitalInput, 1000).toLocaleString() + " y borrará todos los trades"
                : "ℹ️ Conserva el historial de operaciones anteriores"}
            </span>
            <button
              type="button"
              onClick={async () => {
                try {
                  clearHistory();
                  queryClient.setQueriesData({ queryKey: ["closedPositions"] }, {
                    data: [],
                    total: 0,
                    page: 1,
                    pageSize: 50,
                    totalPages: 1,
                  });
                  queryClient.setQueriesData({ queryKey: ["fills"] }, {
                    data: [],
                    total: 0,
                    page: 1,
                    pageSize: 50,
                    totalPages: 1,
                  });
                  await refreshAllQueries();
                  toast.success("Historial Borrado", "Se ha vaciado el historial de operaciones");
                } catch (err: unknown) {
                  toast.error("Error", err instanceof Error ? err.message : "No se pudo borrar");
                }
              }}
              className="text-muted-foreground hover:text-destructive underline decoration-dotted transition-colors shrink-0 ml-2"
              title="Borrar únicamente el historial de operaciones sin cambiar el capital"
            >
              Solo borrar historial
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
