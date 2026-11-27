import { useEffect } from "react";
import { useQuery, useMutation, useQueryClient, type UseQueryOptions } from "@tanstack/react-query";
import { api } from "./api";
import { subscribeSymbolsChanged } from "./demo/instruments.ts";
import { isCryptoLiveStreamConnected } from "./cryptoStream.ts";
import { isIbkrLiveStreamConnected } from "./ibkrStream.ts";
import type {
  Account,
  AccountStats,
  ClosedPosition,
  EquityPoint,
  Fill,
  LedgerEntry,
  Order,
  Position,
  Symbol,
  Candle,
  PlaceOrderInput,
} from "./schemas";

export interface MarketDataCandlesPayload {
  candles: Candle[];
  metadata?: {
    isPartial?: boolean;
    backfillQueued?: boolean;
    historicalCoverageStart?: number | null;
  };
}

// ── Query Key Factories ─────────────────────────────────
export const queryKeys = {
  accounts: {
    all: ["accounts"] as const,
    mine: () => [...queryKeys.accounts.all, "mine"] as const,
    detail: (id: string) => [...queryKeys.accounts.all, id] as const,
    stats: (id: string) => [...queryKeys.accounts.all, id, "stats"] as const,
    ledger: (id: string, page: number) => [...queryKeys.accounts.all, id, "ledger", page] as const,
    equity: (id: string) => [...queryKeys.accounts.all, id, "equity"] as const,
  },
  trading: {
    positions: (accountId: string) => ["positions", accountId] as const,
    orders: (accountId: string, status?: string) =>
      status !== undefined
        ? (["orders", accountId, status] as const)
        : (["orders", accountId] as const),
    fills: (accountId: string, page: number) => ["fills", accountId, page] as const,
    closedPositions: (accountId: string, page: number) =>
      ["closedPositions", accountId, page] as const,
  },
  market: {
    symbols: ["symbols"] as const,
    candles: (symbol: string, tf: string) => ["candles", symbol, tf] as const,
    economicCalendar: (currencies: string[]) => ["economicCalendar", ...currencies] as const,
  },
  replay: {
    session: (accountId: string, date: string) => ["replay", "session", accountId, date] as const,
  },
} as const;

// ── Account Queries ────────────────────────────────────
export function useMyAccounts(opts?: Partial<UseQueryOptions<Account[]>>) {
  return useQuery<Account[]>({
    queryKey: queryKeys.accounts.mine(),
    queryFn: () => api.getMyAccounts(),
    staleTime: 5_000,
    ...opts,
  });
}

export function useAccount(id: string | null, opts?: Partial<UseQueryOptions<Account>>) {
  return useQuery<Account>({
    queryKey: queryKeys.accounts.detail(id!),
    queryFn: () => api.getAccount(id!),
    enabled: !!id,
    staleTime: 15_000,
    ...opts,
  });
}

export function useAccountStats(id: string | null) {
  return useQuery<AccountStats>({
    queryKey: queryKeys.accounts.stats(id!),
    queryFn: () => api.getAccountStats(id!),
    enabled: !!id,
    staleTime: 10_000,
  });
}

export function useEquityHistory(id: string | null) {
  return useQuery<EquityPoint[]>({
    queryKey: queryKeys.accounts.equity(id!),
    queryFn: () => api.getEquityHistory(),
    enabled: !!id,
    staleTime: 5_000,
  });
}

export function useLedger(id: string | null, page = 1) {
  return useQuery<{
    data: LedgerEntry[];
    total: number;
    page: number;
    pageSize: number;
    totalPages: number;
  }>({
    queryKey: queryKeys.accounts.ledger(id!, page),
    queryFn: () => api.getLedger(),
    enabled: !!id,
    staleTime: 30_000,
  });
}

// ── Trading Queries ────────────────────────────────────
export function usePositions(accountId: string | null) {
  return useQuery<Position[]>({
    queryKey: queryKeys.trading.positions(accountId!),
    queryFn: () => api.getPositions(accountId!),
    enabled: !!accountId,
    staleTime: 10_000,
    refetchInterval: 30_000,
    refetchOnWindowFocus: false,
  });
}

export function useOpenPositionCount() {
  return useQuery<number>({
    queryKey: ["openPositionCount"],
    queryFn: () => api.getOpenPositionCount(),
    refetchInterval: 5_000,
  });
}

export function useOrders(accountId: string | null, status?: string) {
  return useQuery<Order[]>({
    queryKey: queryKeys.trading.orders(accountId!, status),
    queryFn: () => api.getOrders(accountId!, status),
    enabled: !!accountId,
    staleTime: 10_000,
    refetchInterval: 30_000,
    refetchOnWindowFocus: false,
  });
}

export function useFills(accountId: string | null, page = 1) {
  return useQuery<{
    data: Fill[];
    total: number;
    page: number;
    pageSize: number;
    totalPages: number;
  }>({
    queryKey: queryKeys.trading.fills(accountId!, page),
    queryFn: () => api.getFills(accountId!, page),
    enabled: !!accountId,
    staleTime: 30_000,
  });
}

export function useClosedPositions(accountId: string | null, page = 1) {
  return useQuery<{
    data: ClosedPosition[];
    total: number;
    page: number;
    pageSize: number;
    totalPages: number;
  }>({
    queryKey: queryKeys.trading.closedPositions(accountId!, page),
    queryFn: () => api.getClosedPositions(accountId!, page),
    enabled: !!accountId,
    staleTime: 30_000,
  });
}

export function useClosedPositionsSummary(
  accountId: string | null,
  from: string | null,
  to: string | null,
) {
  return useQuery<{ pnl: number; commission: number; swap: number; tradeCount: number }>({
    queryKey: ["closedPositionsSummary", accountId, from, to] as const,
    queryFn: () => api.getClosedPositionsSummary(accountId!, from!, to!),
    enabled: !!(accountId && from && to),
    staleTime: 15_000,
    refetchInterval: 30_000,
  });
}

// ── Market Data Queries ────────────────────────────────
export function useSymbols() {
  const qc = useQueryClient();
  useEffect(() => {
    return subscribeSymbolsChanged(() => {
      qc.invalidateQueries({ queryKey: queryKeys.market.symbols });
    });
  }, [qc]);
  return useQuery<Symbol[]>({
    queryKey: queryKeys.market.symbols,
    queryFn: () => api.getSymbols(),
    staleTime: 5 * 60_000,
  });
}

export interface EconomicCalendarEvent {
  id: string;
  time: string;
  currency: string;
  impact: "low" | "medium" | "high";
  event: string;
  forecast?: string;
  previous?: string;
  actual?: string;
  country: string;
  sentiment?: "bullish" | "bearish" | "neutral";
  sentimentReason?: string;
}

export function useEconomicCalendar(currencies: string[]) {
  return useQuery<EconomicCalendarEvent[]>({
    queryKey: queryKeys.market.economicCalendar(currencies),
    queryFn: async () => {
      const res = await api.getEconomicCalendar();
      return res as EconomicCalendarEvent[];
    },
    enabled: currencies.length > 0,
    staleTime: 10 * 60_000,
  });
}

export function selectSameSeriesPlaceholder<T>(
  prev: T | undefined,
  prevQueryKey: readonly unknown[] | undefined,
  symbol: string,
  timeframe: string,
): T | undefined {
  if (Array.isArray(prevQueryKey) && prevQueryKey[1] === symbol && prevQueryKey[2] === timeframe) {
    return prev;
  }
  return undefined;
}

export function useCandles(
  symbol: string,
  timeframe: string,
  limit?: number,
  replayVersion?: number,
  targetDate?: string,
) {
  return useQuery<MarketDataCandlesPayload, Error, Candle[]>({
    queryKey: targetDate
      ? [...queryKeys.market.candles(symbol, timeframe), limit ?? "auto", replayVersion ?? 0, targetDate]
      : [...queryKeys.market.candles(symbol, timeframe), limit ?? "auto", replayVersion ?? 0],
    queryFn: () =>
      api.getCandlesWithMeta(
        symbol,
        timeframe,
        limit,
        targetDate ? { targetDate } : undefined,
      ),
    select: (data) => data.candles,
    staleTime: 30_000,
    placeholderData: (prev, prevQuery) =>
      targetDate ? undefined : selectSameSeriesPlaceholder(prev, prevQuery?.queryKey, symbol, timeframe),
    refetchInterval: (query) => {
      if (targetDate) return false;
      if (query.state.data?.metadata?.isPartial) return 3_000;
      return isIbkrLiveStreamConnected() || isCryptoLiveStreamConnected() ? false : 30_000;
    },
  });
}

export function useAccountMetrics(accountId: string | null) {
  return useQuery({
    queryKey: ["account-metrics", accountId] as const,
    queryFn: () => api.getAccountMetrics(),
    enabled: !!accountId,
    staleTime: 10_000,
    refetchInterval: 30_000,
  });
}

export function useMarketDataHealth() {
  return useQuery({
    queryKey: ["market-data-health"] as const,
    queryFn: () => api.getMarketDataHealth(),
    staleTime: 5_000,
    refetchInterval: 5_000,
  });
}

// ── Mutations ──────────────────────────────────────────
export function usePlaceOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: PlaceOrderInput) => api.placeOrder(input),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({
        queryKey: queryKeys.trading.orders(vars.accountId),
      });
      qc.invalidateQueries({
        queryKey: queryKeys.trading.positions(vars.accountId),
      });
      qc.invalidateQueries({
        queryKey: queryKeys.accounts.detail(vars.accountId),
      });
      qc.invalidateQueries({
        queryKey: ["fills", vars.accountId],
      });
    },
  });
}

export function useCancelOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ orderId }: { orderId: string; accountId: string }) => api.cancelOrder(orderId),
    onMutate: async ({ orderId, accountId }) => {
      await qc.cancelQueries({ queryKey: queryKeys.trading.orders(accountId) });
      const prev = qc.getQueryData<Order[]>(queryKeys.trading.orders(accountId));
      if (prev) {
        qc.setQueryData(
          queryKeys.trading.orders(accountId),
          prev.map((o) => (o.id === orderId ? { ...o, status: "CANCELLED" } : o)),
        );
      }
      return { prev };
    },
    onError: (_err, { accountId }, ctx) => {
      if (ctx?.prev) qc.setQueryData(queryKeys.trading.orders(accountId), ctx.prev);
    },
    onSettled: (_data, _err, { accountId }) => {
      qc.invalidateQueries({ queryKey: queryKeys.trading.orders(accountId) });
    },
  });
}

export function useClosePosition() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      positionId,
      quantity,
    }: {
      positionId: string;
      accountId: string;
      quantity?: number;
    }) => api.closePosition(positionId, quantity),
    onSuccess: (_data, { accountId }) => {
      qc.invalidateQueries({
        queryKey: queryKeys.trading.positions(accountId),
      });
      qc.invalidateQueries({ queryKey: queryKeys.accounts.detail(accountId) });
      qc.invalidateQueries({ queryKey: ["closedPositions", accountId] });
      qc.invalidateQueries({ queryKey: ["fills", accountId] });
    },
  });
}

export function useModifyPosition() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      positionId,
      modifications,
    }: {
      positionId: string;
      accountId: string;
      modifications: { takeProfit?: number | null; stopLoss?: number | null };
    }) => api.modifyPosition(positionId, modifications),
    onSuccess: (_data, { accountId }) => {
      qc.invalidateQueries({
        queryKey: queryKeys.trading.positions(accountId),
      });
    },
  });
}

export function useCloseAllPositions() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (accountId: string) => api.closeAllPositions(accountId),
    onSuccess: (_data, accountId) => {
      qc.invalidateQueries({
        queryKey: queryKeys.trading.positions(accountId),
      });
      qc.invalidateQueries({ queryKey: queryKeys.accounts.detail(accountId) });
      qc.invalidateQueries({ queryKey: ["closedPositions", accountId] });
      qc.invalidateQueries({ queryKey: ["fills", accountId] });
    },
  });
}

export function useModifyOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      orderId,
      modifications,
    }: {
      orderId: string;
      accountId: string;
      modifications: {
        price?: number | null;
        stopPrice?: number | null;
        quantity?: number;
        takeProfit?: number | null;
        stopLoss?: number | null;
      };
    }) => api.modifyOrder(orderId, modifications),
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({
        queryKey: queryKeys.trading.orders(vars.accountId),
      });
      qc.invalidateQueries({
        queryKey: queryKeys.trading.positions(vars.accountId),
      });
      qc.invalidateQueries({
        queryKey: ["fills", vars.accountId],
      });
      qc.invalidateQueries({
        queryKey: queryKeys.accounts.detail(vars.accountId),
      });
    },
  });
}

export function useReplaySession(accountId: string | null, sessionDate: string | null) {
  return useQuery({
    queryKey: queryKeys.replay.session(accountId!, sessionDate!),
    queryFn: () => api.replayGetSession(),
    enabled: !!accountId && !!sessionDate,
    staleTime: 30_000,
    gcTime: 5 * 60 * 1000,
  });
}
