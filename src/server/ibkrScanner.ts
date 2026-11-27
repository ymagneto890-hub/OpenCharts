import {
  type Contract,
  Instrument,
  LocationCode,
  ScanCode,
  type ScannerSubscription,
  type TagValue,
} from "@stoqey/ib";
import { getNyTradingDayKey } from "../lib/indicators.ts";
import {
  computeCandidateChangePercent,
  computePreMarketRelativeVolume,
  computeRegularRelativeVolume,
  getUsMarketSessionPhase,
  type UsMarketSessionPhase,
} from "../lib/premarketScreener.ts";
import type {
  ScreenerPipeline,
  ScreenerPipelineMeta,
} from "../lib/screenerPipeline.ts";

export interface IbkrScannerRowInput {
  id: string;
  ticker: string;
  description: string;
  close: number;
  change: number | null;
  volume: number | null;
  relativeVolume: number | null;
  marketCap: number | null;
  priceToBook: number | null;
  epsDiluted: number | null;
  epsGrowthYoY: number | null;
  dividendYield: number | null;
  sector: string;
  exchange: string;
  perfW: number | null;
  perf1M: number | null;
  perf3M: number | null;
  perfYTD: number | null;
  perfY: number | null;
  rsi: number | null;
  recommendAll: number | null;
  floatShares: number | null;
  currency: string;
  country: string;
  premarketClose: number | null;
  premarketChange: number | null;
  premarketVolume: number | null;
}

export interface IbkrScannerQueryPayload {
  marketScope?: "global" | "us" | "us_otc";
  exchanges?: string[];
  onlyPremarket?: boolean;
  marketCapMin?: number | null;
  marketCapMax?: number | null;
  floatMin?: number | null;
  floatMax?: number | null;
  changeMin?: number | null;
  changeMax?: number | null;
  priceMin?: number | null;
  priceMax?: number | null;
  volumeMin?: number | null;
  relVolMin?: number | null;
  sector?: string | null;
  search?: string;
  sortBy?: string;
  sortOrder?: "asc" | "desc";
  offset?: number;
  limit?: number;
}

export interface IbkrScannerCallbacks {
  onPriceTick: (field: number, value: number) => void;
  onSizeTick: (field: number, value: number) => void;
  onRtVolumeTick: (price: number, size: number, tsMs: number, totalVol: number) => void;
}

export interface IbkrScannerHost {
  ensureConnected(): Promise<void>;
  getConnectionState(): "disconnected" | "connecting" | "connected" | "reconnecting";
  toContract(symbol: string, exchangeHint?: string): Contract;
  runRawScanner(
    subscription: ScannerSubscription,
    filterOptions?: TagValue[],
    timeoutMs?: number,
  ): Promise<IbkrScannerRowInput[]>;
  subscribeCandidateMktData(
    symbol: string,
    contract: Contract,
    callbacks: IbkrScannerCallbacks,
  ): () => void;
  fetchDailyBaseline(
    symbol: string,
    exchangeHint?: string,
    signal?: AbortSignal,
  ): Promise<{
    priorClose: number | null;
    avgVol10: number | null;
    avgVol30: number | null;
    avgVol90: number | null;
  }>;
  fetchPremarketSessionVolume(
    symbol: string,
    exchangeHint?: string,
    signal?: AbortSignal,
  ): Promise<{ premarketVolume: number; premarketClose: number | null }>;
}

export interface IbkrScreenerStreamEvent {
  type: "snapshot" | "update" | "status";
  connected?: boolean;
  reason?: string;
  totalCount?: number;
  items?: IbkrScannerRowInput[];
  fetchedAt?: number;
  source?: "ibkr-consolidated";
  pipelineMeta?: ScreenerPipelineMeta;
}

interface DailyBaselineCacheEntry {
  nyDayKey: number;
  priorClose: number | null;
  avgVol10: number | null;
  avgVol30: number | null;
  avgVol90: number | null;
  premarketVolume: number | null;
  premarketClose: number | null;
  cachedAt: number;
}

interface LiveCandidate {
  ticker: string;
  contract: Contract;
  baseRow: IbkrScannerRowInput;
  lastPrice: number;
  priorClose: number | null;
  liveVolume: number;
  hasAuthoritativeRtVol: boolean;
  premarketVolume: number;
  premarketClose: number | null;
  avgVol10: number | null;
  avgVol30: number | null;
  avgVol90: number | null;
  rankScore: number;
  lastTickAt: number;
  baselineHydrated: boolean;
  baselineInFlight: boolean;
  mktDataRelease: (() => void) | null;
}

interface ScreenerSubscriber {
  id: number;
  payload: IbkrScannerQueryPayload;
  onEvent: (evt: IbkrScreenerStreamEvent) => void;
  lastEmittedSig: string;
}

const IB_SCAN_TICK = {
  LAST: 4,
  VOLUME: 8,
  CLOSE: 9,
  AVG_VOLUME: 21,
  DELAYED_LAST: 68,
  DELAYED_VOLUME: 74,
  DELAYED_CLOSE: 75,
} as const;

export const MAX_SCANNER_MKT_DATA_LINES = 30;
export const MAX_CONCURRENT_BASELINE_HYDRATIONS = 2;
const DISCOVERY_REFRESH_MS = 20_000;
const EMIT_THROTTLE_MS = 600;
const IDLE_TEARDOWN_GRACE_MS = 2_000;
const BASELINE_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const RAW_DISCOVERY_CACHE_MS = 4_000;

export function buildScannerSpecs(
  payload: IbkrScannerQueryPayload,
  sessionPhase: UsMarketSessionPhase,
): Array<{ subscription: ScannerSubscription; filterOptions?: TagValue[] }> {
  const locationCode =
    payload.marketScope === "us_otc" ? LocationCode.STK_US : LocationCode.STK_US_MAJOR;

  const baseSub = (scanCode: ScanCode): ScannerSubscription => ({
    numberOfRows: 35,
    instrument: Instrument.STK,
    locationCode,
    scanCode,
    ...(typeof payload.priceMin === "number" && Number.isFinite(payload.priceMin)
      ? { abovePrice: Math.max(0.01, Number((payload.priceMin * 0.9).toFixed(2))) }
      : {}),
    ...(typeof payload.priceMax === "number" && Number.isFinite(payload.priceMax)
      ? { belowPrice: Number((payload.priceMax * 1.1).toFixed(2)) }
      : {}),
    ...(typeof payload.volumeMin === "number" && Number.isFinite(payload.volumeMin)
      ? { aboveVolume: Math.max(0, Math.floor(payload.volumeMin * 0.5)) }
      : {}),
    ...(typeof payload.marketCapMin === "number" && Number.isFinite(payload.marketCapMin)
      ? { marketCapAbove: payload.marketCapMin }
      : {}),
    ...(typeof payload.marketCapMax === "number" && Number.isFinite(payload.marketCapMax)
      ? { marketCapBelow: payload.marketCapMax }
      : {}),
  });

  if (payload.sortBy === "change" && payload.sortOrder === "asc") {
    return [{ subscription: baseSub(ScanCode.TOP_PERC_LOSE) }];
  }

  if (
    sessionPhase === "regular" &&
    (payload.sortBy === "volume" || payload.sortBy === "relative_volume_10d_calc")
  ) {
    return [
      { subscription: baseSub(ScanCode.HOT_BY_VOLUME) },
      { subscription: baseSub(ScanCode.TOP_PERC_GAIN) },
    ];
  }

  // Both Pre-Market and default Regular discovery combine % Gainers + Hot Volume
  // (exact % change filtering is enforced downstream in ScreenerPipeline so IBKR never drops rows on unsupported TagValues)
  return [
    { subscription: baseSub(ScanCode.TOP_PERC_GAIN) },
    { subscription: baseSub(ScanCode.HOT_BY_VOLUME) },
  ];
}

/**
 * Coordinates real-time IBKR US Consolidated market scans, streaming L1 candidate updates,
 * bounded historical baselines, session-aware Pre-Market / Regular Relative Volume, and
 * downstream decoupled pipeline filtering.
 */
export class IbkrRealtimeScanner {
  private readonly host: IbkrScannerHost;
  private readonly pipeline: ScreenerPipeline<IbkrScannerRowInput>;

  private readonly candidates = new Map<string, LiveCandidate>();
  private readonly baselineCache = new Map<string, DailyBaselineCacheEntry>();
  private readonly subscribers = new Map<number, ScreenerSubscriber>();

  private nextSubscriberId = 1;
  private discoveryTimer: ReturnType<typeof setInterval> | null = null;
  private emitTimer: ReturnType<typeof setTimeout> | null = null;
  private idleTeardownTimer: ReturnType<typeof setTimeout> | null = null;
  private readinessWaiters = new Set<() => void>();

  private scannerMutex: Promise<unknown> = Promise.resolve();
  private lastDiscoveryAt = 0;
  private lastDiscoveryScopeKey = "";
  private activeBaselineWorkers = 0;
  private broadcastInFlight = false;
  private broadcastPending = false;
  private disposed = false;

  constructor(
    host: IbkrScannerHost,
    pipeline: ScreenerPipeline<IbkrScannerRowInput>,
  ) {
    this.host = host;
    this.pipeline = pipeline;
  }

  getKnownCandidateSymbols(): string[] {
    return Array.from(this.candidates.keys());
  }

  /**
   * Executes a snapshot scan (used by `POST /__api/stock-screener`) while respecting
   * TWS concurrent scanner & market-data line budgets and releasing idle lines promptly.
   */
  async scanSnapshot(
    payload: IbkrScannerQueryPayload,
    signal?: AbortSignal,
  ): Promise<{
    totalCount: number;
    items: IbkrScannerRowInput[];
    fetchedAt: number;
    source: "ibkr-consolidated";
    pipelineMeta: ScreenerPipelineMeta;
  }> {
    this.disposed = false;
    await this.host.ensureConnected();
    if (this.idleTeardownTimer) {
      clearTimeout(this.idleTeardownTimer);
      this.idleTeardownTimer = null;
    }

    const effectivePayload = this.mergeSharedDiscoveryFilters(payload);
    await this.discoverAndSyncPool(effectivePayload, signal);
    await this.waitAndHydrateMissingBaselines(payload, signal);

    const nowMs = Date.now();
    const rawRows = this.buildCandidateRows(payload, nowMs);
    const result = await this.pipeline.execute(rawRows, payload, { nowMs, signal });

    if (this.subscribers.size === 0) {
      this.scheduleIdleTeardown();
    }

    const offset = Math.max(0, Math.floor(Number(payload.offset ?? 0) || 0));
    const limit = Math.min(500, Math.max(1, Math.floor(Number(payload.limit ?? 500) || 500)));

    return {
      totalCount: result.totalCount,
      items: result.rows.slice(offset, offset + limit),
      fetchedAt: nowMs,
      source: "ibkr-consolidated",
      pipelineMeta: result.meta,
    };
  }

  /**
   * Acquires a shared real-time SSE scanner stream for a client filter configuration.
   * Multiple tabs/clients share a single budgeted <=30-line `reqMktData` candidate pool.
   */
  acquireStream(
    payload: IbkrScannerQueryPayload,
    onEvent: (evt: IbkrScreenerStreamEvent) => void,
  ): () => void {
    this.disposed = false;
    if (this.idleTeardownTimer) {
      clearTimeout(this.idleTeardownTimer);
      this.idleTeardownTimer = null;
    }

    const subId = this.nextSubscriberId++;
    const subscriber: ScreenerSubscriber = {
      id: subId,
      payload: { ...payload },
      onEvent,
      lastEmittedSig: "",
    };
    this.subscribers.set(subId, subscriber);
    this.ensureDiscoveryLoop();

    const ac = new AbortController();
    void (async () => {
      try {
        await this.host.ensureConnected();
        if (ac.signal.aborted || !this.subscribers.has(subId)) return;
        const effective = this.mergeSharedDiscoveryFilters(subscriber.payload);
        await this.discoverAndSyncPool(effective, ac.signal);
        await this.waitAndHydrateMissingBaselines(subscriber.payload, ac.signal);
        if (ac.signal.aborted || !this.subscribers.has(subId)) return;
        await this.emitToSubscriber(subscriber, "snapshot");
      } catch (err) {
        if (!this.subscribers.has(subId) || ac.signal.aborted) return;
        subscriber.onEvent({
          type: "status",
          connected: false,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    })();

    let released = false;
    return () => {
      if (released) return;
      released = true;
      ac.abort();
      this.subscribers.delete(subId);
      if (this.subscribers.size === 0) {
        if (this.discoveryTimer) {
          clearInterval(this.discoveryTimer);
          this.discoveryTimer = null;
        }
        this.scheduleIdleTeardown();
      }
    };
  }

  /** Re-subscribes all live candidate market-data lines after TWS reconnect (1101). */
  handleReconnect(): void {
    if (this.disposed || this.candidates.size === 0) return;
    for (const candidate of this.candidates.values()) {
      if (candidate.mktDataRelease) {
        candidate.mktDataRelease();
        candidate.mktDataRelease = null;
      }
      this.attachCandidateMktData(candidate);
    }
    this.scheduleBroadcast();
  }

  /** Releases all candidate subscriptions, discovery timers, and baseline queues. */
  dispose(): void {
    this.disposed = true;
    if (this.discoveryTimer) {
      clearInterval(this.discoveryTimer);
      this.discoveryTimer = null;
    }
    if (this.emitTimer) {
      clearTimeout(this.emitTimer);
      this.emitTimer = null;
    }
    if (this.idleTeardownTimer) {
      clearTimeout(this.idleTeardownTimer);
      this.idleTeardownTimer = null;
    }
    this.teardownAllCandidates();
    this.subscribers.clear();
    this.flushReadinessWaiters();
  }

  private scheduleIdleTeardown(): void {
    if (this.idleTeardownTimer) clearTimeout(this.idleTeardownTimer);
    this.idleTeardownTimer = setTimeout(() => {
      this.idleTeardownTimer = null;
      if (this.subscribers.size === 0) {
        this.teardownAllCandidates();
      }
    }, IDLE_TEARDOWN_GRACE_MS);
  }

  private teardownAllCandidates(): void {
    for (const candidate of this.candidates.values()) {
      if (candidate.mktDataRelease) {
        candidate.mktDataRelease();
        candidate.mktDataRelease = null;
      }
    }
    this.candidates.clear();
    this.lastDiscoveryAt = 0;
  }

  private ensureDiscoveryLoop(): void {
    if (this.discoveryTimer) return;
    this.discoveryTimer = setInterval(() => {
      if (this.subscribers.size === 0 || this.disposed) return;
      const merged = this.mergeAllSubscriberFilters();
      void this.discoverAndSyncPool(merged)
        .then(() => this.waitAndHydrateMissingBaselines(merged))
        .then(() => this.broadcastAllSubscribers())
        .catch(() => {
          // keep running across transient scan hiccups
        });
    }, DISCOVERY_REFRESH_MS);
  }

  private mergeAllSubscriberFilters(): IbkrScannerQueryPayload {
    const subs = Array.from(this.subscribers.values());
    if (subs.length === 0) return {};
    if (subs.length === 1) return subs[0]!.payload;
    let minPrice: number | null = null;
    let maxPrice: number | null = null;
    let minChg: number | null = null;
    let anyPremarket = false;
    let anyOtc = false;
    for (const s of subs) {
      const p = s.payload;
      if (typeof p.priceMin === "number") {
        minPrice = minPrice === null ? p.priceMin : Math.min(minPrice, p.priceMin);
      }
      if (typeof p.priceMax === "number") {
        maxPrice = maxPrice === null ? p.priceMax : Math.max(maxPrice, p.priceMax);
      }
      if (typeof p.changeMin === "number") {
        minChg = minChg === null ? p.changeMin : Math.min(minChg, p.changeMin);
      }
      if (p.onlyPremarket) anyPremarket = true;
      if (p.marketScope === "us_otc") anyOtc = true;
    }
    return {
      marketScope: anyOtc ? "us_otc" : "us",
      onlyPremarket: anyPremarket,
      priceMin: minPrice,
      priceMax: maxPrice,
      changeMin: minChg,
      limit: MAX_SCANNER_MKT_DATA_LINES,
    };
  }

  private mergeSharedDiscoveryFilters(
    requested: IbkrScannerQueryPayload,
  ): IbkrScannerQueryPayload {
    if (this.subscribers.size === 0) return requested;
    const activeMerged = this.mergeAllSubscriberFilters();
    return {
      ...requested,
      priceMin:
        typeof requested.priceMin === "number" && typeof activeMerged.priceMin === "number"
          ? Math.min(requested.priceMin, activeMerged.priceMin)
          : (requested.priceMin ?? activeMerged.priceMin),
      priceMax:
        typeof requested.priceMax === "number" && typeof activeMerged.priceMax === "number"
          ? Math.max(requested.priceMax, activeMerged.priceMax)
          : (requested.priceMax ?? activeMerged.priceMax),
      changeMin:
        typeof requested.changeMin === "number" && typeof activeMerged.changeMin === "number"
          ? Math.min(requested.changeMin, activeMerged.changeMin)
          : (requested.changeMin ?? activeMerged.changeMin),
    };
  }

  private serializeScannerRun<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.scannerMutex.then(fn, fn);
    this.scannerMutex = next.catch(() => undefined);
    return next;
  }

  private async discoverAndSyncPool(
    payload: IbkrScannerQueryPayload,
    signal?: AbortSignal,
  ): Promise<void> {
    const scopeKey = JSON.stringify([
      payload.marketScope ?? "us",
      Boolean(payload.onlyPremarket),
      payload.priceMin ?? null,
      payload.priceMax ?? null,
      payload.changeMin ?? null,
      payload.sortBy ?? "change",
      payload.sortOrder ?? "desc",
    ]);

    const now = Date.now();
    if (
      this.candidates.size > 0 &&
      scopeKey === this.lastDiscoveryScopeKey &&
      now - this.lastDiscoveryAt < RAW_DISCOVERY_CACHE_MS
    ) {
      return;
    }

    const discovered = await this.serializeScannerRun(async () => {
      if (signal?.aborted || this.disposed) return [] as IbkrScannerRowInput[];
      const sessionPhase = getUsMarketSessionPhase(Date.now());
      const specs = buildScannerSpecs(payload, sessionPhase);
      const mergedByTicker = new Map<string, { row: IbkrScannerRowInput; rankScore: number }>();

      for (const spec of specs) {
        if (signal?.aborted || this.disposed) break;
        let rows: IbkrScannerRowInput[] = [];
        try {
          rows = await this.host.runRawScanner(spec.subscription, spec.filterOptions, 6_000);
        } catch {
          if (spec.filterOptions) {
            try {
              rows = await this.host.runRawScanner(spec.subscription, undefined, 6_000);
            } catch {
              rows = [];
            }
          }
        }
        rows.forEach((row, idx) => {
          const ticker = row.ticker.trim().toUpperCase();
          if (!ticker) return;
          const score = 1_000 - idx * 10;
          const existing = mergedByTicker.get(ticker);
          if (!existing) {
            mergedByTicker.set(ticker, { row, rankScore: score });
          } else {
            existing.rankScore += score * 0.5;
          }
        });
      }

      return Array.from(mergedByTicker.values())
        .sort((a, b) => b.rankScore - a.rankScore)
        .map((entry) => entry.row);
    });

    if (signal?.aborted || this.disposed || discovered.length === 0) return;

    this.lastDiscoveryAt = Date.now();
    this.lastDiscoveryScopeKey = scopeKey;
    const nyDayKey = getNyTradingDayKey(Math.floor(this.lastDiscoveryAt / 1000)) ?? 0;

    // Limit to MAX_SCANNER_MKT_DATA_LINES total active candidates
    const desired = discovered.slice(0, MAX_SCANNER_MKT_DATA_LINES);
    const desiredSet = new Set(desired.map((r) => r.ticker.trim().toUpperCase()));

    // Evict stale symbols not in the new top 30 pool
    for (const [sym, candidate] of Array.from(this.candidates.entries())) {
      if (!desiredSet.has(sym)) {
        if (candidate.mktDataRelease) {
          candidate.mktDataRelease();
          candidate.mktDataRelease = null;
        }
        this.candidates.delete(sym);
      }
    }

    // Add newly discovered candidates & attach streaming L1 ticks
    desired.forEach((row, idx) => {
      const sym = row.ticker.trim().toUpperCase();
      const existing = this.candidates.get(sym);
      const cachedBase = this.baselineCache.get(sym);
      const validCache =
        cachedBase &&
        cachedBase.nyDayKey === nyDayKey &&
        Date.now() - cachedBase.cachedAt < BASELINE_CACHE_TTL_MS
          ? cachedBase
          : null;

      if (existing) {
        existing.baseRow = { ...existing.baseRow, ...row };
        existing.rankScore = 100 - idx;
        if (validCache) {
          if (existing.priorClose === null && validCache.priorClose !== null) {
            existing.priorClose = validCache.priorClose;
          }
          existing.avgVol10 = existing.avgVol10 ?? validCache.avgVol10;
          existing.avgVol30 = existing.avgVol30 ?? validCache.avgVol30;
          existing.avgVol90 = existing.avgVol90 ?? validCache.avgVol90;
        }
        if (!existing.mktDataRelease) {
          this.attachCandidateMktData(existing);
        }
        return;
      }

      if (this.candidates.size >= MAX_SCANNER_MKT_DATA_LINES) return;

      const candidate: LiveCandidate = {
        ticker: sym,
        contract: this.host.toContract(sym, row.exchange),
        baseRow: { ...row },
        lastPrice: row.close > 0 ? row.close : 0,
        priorClose: validCache?.priorClose ?? null,
        liveVolume: typeof row.volume === "number" && row.volume > 0 ? row.volume : 0,
        hasAuthoritativeRtVol: false,
        premarketVolume:
          validCache?.premarketVolume ??
          (typeof row.premarketVolume === "number" && row.premarketVolume > 0
            ? row.premarketVolume
            : 0),
        premarketClose: validCache?.premarketClose ?? row.premarketClose ?? null,
        avgVol10: validCache?.avgVol10 ?? null,
        avgVol30: validCache?.avgVol30 ?? null,
        avgVol90: validCache?.avgVol90 ?? null,
        rankScore: 100 - idx,
        lastTickAt: 0,
        baselineHydrated: Boolean(validCache),
        baselineInFlight: false,
        mktDataRelease: null,
      };
      this.candidates.set(sym, candidate);
      this.attachCandidateMktData(candidate);
    });
  }

  private attachCandidateMktData(candidate: LiveCandidate): void {
    const callbacks: IbkrScannerCallbacks = {
      onPriceTick: (field, value) => {
        if (!Number.isFinite(value) || value <= 0) return;
        const nowMs = Date.now();
        const phase = getUsMarketSessionPhase(nowMs);
        if (field === IB_SCAN_TICK.LAST || field === IB_SCAN_TICK.DELAYED_LAST) {
          candidate.lastPrice = value;
          candidate.lastTickAt = nowMs;
          if (phase === "premarket") {
            candidate.premarketClose = value;
          }
          this.onCandidateUpdated(candidate);
        } else if (field === IB_SCAN_TICK.CLOSE || field === IB_SCAN_TICK.DELAYED_CLOSE) {
          candidate.priorClose = value;
          candidate.lastTickAt = nowMs;
          this.onCandidateUpdated(candidate);
        }
      },
      onSizeTick: (field, value) => {
        if (!Number.isFinite(value) || value < 0) return;
        const nowMs = Date.now();
        const phase = getUsMarketSessionPhase(nowMs);
        if (field === IB_SCAN_TICK.AVG_VOLUME && value > 0) {
          // IBKR reports AVG_VOLUME (tick 21) in 100-share round lots
          candidate.avgVol90 = value * 100;
          candidate.lastTickAt = nowMs;
          this.onCandidateUpdated(candidate);
        } else if (
          (field === IB_SCAN_TICK.VOLUME || field === IB_SCAN_TICK.DELAYED_VOLUME) &&
          value > 0
        ) {
          if (!candidate.hasAuthoritativeRtVol) {
            // Modern IBKR TWS/Gateway API (>=163) reports VOLUME & DELAYED_VOLUME directly in shares
            const shareVol = Math.round(value);
            if (shareVol > candidate.liveVolume) {
              candidate.liveVolume = shareVol;
            }
          }
          if (phase === "premarket" && candidate.liveVolume > candidate.premarketVolume) {
            candidate.premarketVolume = candidate.liveVolume;
          }
          candidate.lastTickAt = nowMs;
          this.onCandidateUpdated(candidate);
        }
      },
      onRtVolumeTick: (price, size, _tsMs, totalVol) => {
        if (!Number.isFinite(price) || price <= 0) return;
        const nowMs = Date.now();
        const phase = getUsMarketSessionPhase(nowMs);
        candidate.lastPrice = price;
        if (phase === "premarket") {
          candidate.premarketClose = price;
        }
        if (Number.isFinite(totalVol) && totalVol > 0) {
          candidate.hasAuthoritativeRtVol = true;
          if (totalVol > candidate.liveVolume) {
            candidate.liveVolume = totalVol;
          }
        } else if (Number.isFinite(size) && size > 0) {
          candidate.liveVolume += size;
        }
        if (phase === "premarket" && candidate.liveVolume > candidate.premarketVolume) {
          candidate.premarketVolume = candidate.liveVolume;
        }
        candidate.lastTickAt = nowMs;
        this.onCandidateUpdated(candidate);
      },
    };

    candidate.mktDataRelease = this.host.subscribeCandidateMktData(
      candidate.ticker,
      candidate.contract,
      callbacks,
    );
  }

  private onCandidateUpdated(candidate: LiveCandidate): void {
    if (this.isCandidateReady(candidate)) {
      this.flushReadinessWaiters();
    }
    if (this.subscribers.size > 0) {
      this.scheduleBroadcast();
    }
  }

  private isCandidateReady(c: LiveCandidate): boolean {
    const hasPrice = c.lastPrice > 0;
    const hasPriorClose = c.priorClose !== null && c.priorClose > 0;
    const hasAvgVol = (c.avgVol90 ?? c.avgVol30 ?? c.avgVol10 ?? 0) > 0;
    return hasPrice && hasPriorClose && hasAvgVol;
  }

  private flushReadinessWaiters(): void {
    if (this.arePoolCandidatesMostlyReady()) {
      for (const resolve of Array.from(this.readinessWaiters)) {
        this.readinessWaiters.delete(resolve);
        resolve();
      }
    }
  }

  private arePoolCandidatesMostlyReady(): boolean {
    if (this.candidates.size === 0) return true;
    for (const c of this.candidates.values()) {
      if (!this.isCandidateReady(c)) return false;
    }
    return true;
  }

  private waitForBriefLiveTicks(timeoutMs: number, signal?: AbortSignal): Promise<void> {
    if (this.arePoolCandidatesMostlyReady() || signal?.aborted) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.readinessWaiters.delete(finish);
        signal?.removeEventListener("abort", finish);
        resolve();
      };
      const timer = setTimeout(finish, timeoutMs);
      this.readinessWaiters.add(finish);
      signal?.addEventListener("abort", finish, { once: true });
    });
  }

  /**
   * Waits briefly for real-time ticks, then performs strictly concurrency-bounded
   * (`<= 2` concurrent requests) historical fallback ONLY for candidates still missing
   * priorClose, average volume, or Pre-Market volume.
   */
  private async waitAndHydrateMissingBaselines(
    payload: IbkrScannerQueryPayload,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.waitForBriefLiveTicks(600, signal);
    if (signal?.aborted || this.disposed) return;

    const sessionPhase = getUsMarketSessionPhase(Date.now());
    const needsList = Array.from(this.candidates.values())
      .filter((c) => {
        if (c.baselineInFlight) return false;
        const missingBase =
          c.priorClose === null || (c.avgVol90 ?? c.avgVol30 ?? c.avgVol10) === null;
        const missingPmDuringRth =
          Boolean(payload.onlyPremarket) &&
          sessionPhase !== "premarket" &&
          c.premarketVolume <= 0 &&
          !c.baselineHydrated;
        return (!c.baselineHydrated && missingBase) || missingPmDuringRth;
      })
      .sort((a, b) => b.rankScore - a.rankScore)
      .slice(0, 15);

    if (needsList.length === 0) return;

    const nyDayKey = getNyTradingDayKey(Math.floor(Date.now() / 1000)) ?? 0;
    let cursor = 0;

    const runWorker = async () => {
      while (cursor < needsList.length && !signal?.aborted && !this.disposed) {
        if (this.activeBaselineWorkers >= MAX_CONCURRENT_BASELINE_HYDRATIONS) {
          await new Promise((r) => setTimeout(r, 25));
          continue;
        }
        const idx = cursor++;
        const candidate = needsList[idx];
        if (!candidate) break;
        candidate.baselineInFlight = true;
        this.activeBaselineWorkers += 1;
        try {
          const needsBase =
            candidate.priorClose === null ||
            (candidate.avgVol90 ?? candidate.avgVol30 ?? candidate.avgVol10) === null;

          if (needsBase) {
            const base = await this.host.fetchDailyBaseline(
              candidate.ticker,
              candidate.baseRow.exchange,
              signal,
            );
            if (candidate.priorClose === null && base.priorClose !== null) {
              candidate.priorClose = base.priorClose;
            }
            if (candidate.avgVol90 === null) candidate.avgVol90 = base.avgVol90;
            if (candidate.avgVol30 === null) candidate.avgVol30 = base.avgVol30;
            if (candidate.avgVol10 === null) candidate.avgVol10 = base.avgVol10;
          }

          // Only spend a second historical query for Pre-Market volume when the candidate
          // plausibly passes the active price & change% criteria.
          const candPrice = candidate.lastPrice > 0 ? candidate.lastPrice : candidate.baseRow.close;
          const priceOk =
            (payload.priceMin == null || (candPrice > 0 && candPrice >= payload.priceMin)) &&
            (payload.priceMax == null || (candPrice > 0 && candPrice <= payload.priceMax));
          const candChange = computeCandidateChangePercent(candPrice, candidate.priorClose);
          const changeOk =
            payload.changeMin == null ||
            candChange === null ||
            candChange >= payload.changeMin * 0.8;

          if (
            payload.onlyPremarket &&
            sessionPhase !== "premarket" &&
            candidate.premarketVolume <= 0 &&
            priceOk &&
            changeOk &&
            !signal?.aborted
          ) {
            const pm = await this.host.fetchPremarketSessionVolume(
              candidate.ticker,
              candidate.baseRow.exchange,
              signal,
            );
            if (pm.premarketVolume > 0) {
              candidate.premarketVolume = pm.premarketVolume;
            }
            if (pm.premarketClose !== null && candidate.premarketClose === null) {
              candidate.premarketClose = pm.premarketClose;
            }
          }

          candidate.baselineHydrated = true;
          this.baselineCache.set(candidate.ticker, {
            nyDayKey,
            priorClose: candidate.priorClose,
            avgVol10: candidate.avgVol10,
            avgVol30: candidate.avgVol30,
            avgVol90: candidate.avgVol90,
            premarketVolume: candidate.premarketVolume > 0 ? candidate.premarketVolume : null,
            premarketClose: candidate.premarketClose,
            cachedAt: Date.now(),
          });
        } catch {
          // Leave available real-time metrics intact on single-symbol error
        } finally {
          this.activeBaselineWorkers = Math.max(0, this.activeBaselineWorkers - 1);
          candidate.baselineInFlight = false;
        }
      }
    };

    const workerCount = Math.min(MAX_CONCURRENT_BASELINE_HYDRATIONS, needsList.length);
    await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
  }

  private buildCandidateRows(
    payload: IbkrScannerQueryPayload,
    nowMs: number,
  ): IbkrScannerRowInput[] {
    const phase = getUsMarketSessionPhase(nowMs);
    const out: IbkrScannerRowInput[] = [];

    for (const c of this.candidates.values()) {
      const price = c.lastPrice > 0 ? c.lastPrice : c.baseRow.close;
      const change =
        price > 0 && c.priorClose !== null
          ? computeCandidateChangePercent(price, c.priorClose)
          : c.baseRow.change;

      const pmVol =
        phase === "premarket"
          ? Math.max(c.premarketVolume, c.liveVolume)
          : c.premarketVolume;
      const pmClose =
        phase === "premarket"
          ? price > 0
            ? price
            : c.premarketClose
          : c.premarketClose;
      const pmChange =
        pmClose !== null && c.priorClose !== null
          ? computeCandidateChangePercent(pmClose, c.priorClose)
          : phase === "premarket"
            ? change
            : null;

      const usePreMarketRelVol =
        phase === "premarket" ||
        (Boolean(payload.onlyPremarket) && phase !== "regular" && pmVol > 0);

      const relVol = usePreMarketRelVol
        ? computePreMarketRelativeVolume(
            pmVol > 0 ? pmVol : c.liveVolume,
            c.avgVol90,
            c.avgVol30,
            c.avgVol10,
            nowMs,
          )
        : computeRegularRelativeVolume(
            c.liveVolume > 0 ? c.liveVolume : pmVol,
            c.avgVol90,
            c.avgVol30,
            c.avgVol10,
            nowMs,
          );

      const totalVol = Math.max(c.liveVolume, pmVol);

      out.push({
        ...c.baseRow,
        close: price,
        change,
        volume: totalVol > 0 ? totalVol : c.baseRow.volume,
        relativeVolume: relVol ?? c.baseRow.relativeVolume,
        premarketClose: pmClose,
        premarketChange: pmChange,
        premarketVolume: pmVol > 0 ? pmVol : null,
      });
    }

    return out;
  }

  private scheduleBroadcast(): void {
    if (this.emitTimer || this.disposed) return;
    this.emitTimer = setTimeout(() => {
      this.emitTimer = null;
      void this.broadcastAllSubscribers();
    }, EMIT_THROTTLE_MS);
  }

  private async broadcastAllSubscribers(): Promise<void> {
    if (this.disposed || this.subscribers.size === 0) return;
    if (this.broadcastInFlight) {
      this.broadcastPending = true;
      return;
    }
    this.broadcastInFlight = true;
    try {
      const subs = Array.from(this.subscribers.values());
      for (const sub of subs) {
        if (!this.subscribers.has(sub.id)) continue;
        await this.emitToSubscriber(sub, "update");
      }
    } finally {
      this.broadcastInFlight = false;
      if (this.broadcastPending && !this.disposed) {
        this.broadcastPending = false;
        this.scheduleBroadcast();
      }
    }
  }

  private async emitToSubscriber(
    subscriber: ScreenerSubscriber,
    eventType: "snapshot" | "update",
  ): Promise<void> {
    const nowMs = Date.now();
    const rawRows = this.buildCandidateRows(subscriber.payload, nowMs);
    const result = await this.pipeline.execute(rawRows, subscriber.payload, { nowMs });

    const limit = Math.min(
      500,
      Math.max(1, Math.floor(Number(subscriber.payload.limit ?? 500) || 500)),
    );
    const items = result.rows.slice(0, limit);
    const sig = JSON.stringify(
      items.map((r) => [r.ticker, r.close, r.change, r.relativeVolume, r.volume, r.floatShares]),
    );

    if (eventType === "update" && sig === subscriber.lastEmittedSig) {
      return;
    }
    subscriber.lastEmittedSig = sig;
    subscriber.onEvent({
      type: eventType,
      totalCount: result.totalCount,
      items,
      fetchedAt: nowMs,
      source: "ibkr-consolidated",
      pipelineMeta: result.meta,
    });
  }
}
