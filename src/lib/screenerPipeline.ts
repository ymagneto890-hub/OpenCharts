import {
  filterScreenerRows,
  getUsMarketSessionPhase,
  passesOptionalRange,
  type ScreenerFilterBounds,
  type UsMarketSessionPhase,
} from "./premarketScreener.ts";

export type ScreenerCapability = "floatShares" | "fundamentals" | "catalyst" | (string & {});

export interface ScreenerCandidateRow {
  id: string;
  ticker: string;
  description: string;
  close: number;
  change: number | null;
  volume: number | null;
  relativeVolume: number | null;
  marketCap: number | null;
  floatShares: number | null;
  sector: string;
  exchange: string;
  premarketClose?: number | null;
  premarketChange?: number | null;
  premarketVolume?: number | null;
}

export interface ScreenerPipelineFilters extends ScreenerFilterBounds {
  sortBy?: string;
  sortOrder?: "asc" | "desc";
}

export interface ScreenerPipelineContext {
  filters: ScreenerPipelineFilters;
  sessionPhase: UsMarketSessionPhase;
  nowMs: number;
  signal?: AbortSignal;
  activeCapabilities: ReadonlySet<ScreenerCapability>;
}

/**
 * Sanitized runtime telemetry exposed by an external enricher (never contains secrets).
 */
export interface ScreenerEnricherStatus {
  id: string;
  configured: boolean;
  dailyCallsUsed: number;
  dailyLimit: number;
  remainingCalls: number;
  cachedSymbols: number;
  quotaExhausted: boolean;
  lastError: string | null;
}

/**
 * External candidate enricher (e.g. Phase 3 Float / fundamentals provider) decoupled
 * from IBKR market scanner internals.
 */
export interface ScreenerEnricher<T extends ScreenerCandidateRow = ScreenerCandidateRow> {
  readonly id: string;
  readonly priority?: number;
  readonly provides: ReadonlyArray<ScreenerCapability>;
  readonly isEnabled?: () => boolean;
  readonly getStatus?: () => ScreenerEnricherStatus;
  enrich(
    rows: ReadonlyArray<T>,
    ctx: ScreenerPipelineContext,
  ): Promise<ReadonlyArray<T>> | ReadonlyArray<T>;
}

/**
 * Composable post-filter hook evaluated after external enrichers complete.
 */
export interface ScreenerPostFilter<T extends ScreenerCandidateRow = ScreenerCandidateRow> {
  readonly id: string;
  readonly priority?: number;
  readonly requiresCapability?: ScreenerCapability;
  evaluate(row: T, ctx: ScreenerPipelineContext): boolean;
}

export interface ScreenerPipelineMeta {
  activeEnrichers: string[];
  activeFilters: string[];
  pendingCapabilities: ScreenerCapability[];
  sessionPhase: UsMarketSessionPhase;
  enricherStatus?: Record<string, ScreenerEnricherStatus>;
}

export interface ScreenerPipelineResult<T> {
  rows: T[];
  totalCount: number;
  meta: ScreenerPipelineMeta;
}

const BUILTIN_EXTERNAL_FLOAT_FILTER_ID = "external-float-filter";

function extractSortableNumber(row: ScreenerCandidateRow, sortBy: string): number | null {
  switch (sortBy) {
    case "change":
      return row.change;
    case "close":
      return row.close;
    case "volume":
      return row.volume;
    case "relative_volume_10d_calc":
      return row.relativeVolume;
    case "market_cap_basic":
      return row.marketCap;
    case "float_shares_outstanding":
      return row.floatShares;
    default: {
      const val = (row as unknown as Record<string, unknown>)[sortBy];
      return typeof val === "number" && Number.isFinite(val) ? val : null;
    }
  }
}

function sortCandidateRows<T extends ScreenerCandidateRow>(
  rows: T[],
  sortBy = "change",
  sortOrder: "asc" | "desc" = "desc",
): T[] {
  const dir = sortOrder === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    if (sortBy === "name") {
      return a.ticker.localeCompare(b.ticker) * dir;
    }
    const va = extractSortableNumber(a, sortBy);
    const vb = extractSortableNumber(b, sortBy);
    const validA = typeof va === "number" && Number.isFinite(va);
    const validB = typeof vb === "number" && Number.isFinite(vb);
    if (validA && validB) {
      if (va !== vb) return (va - vb) * dir;
      return a.ticker.localeCompare(b.ticker);
    }
    if (validA) return -1;
    if (validB) return 1;
    return a.ticker.localeCompare(b.ticker);
  });
}

/**
 * Multi-stage screener pipeline isolating core IBKR market filters from optional
 * external enrichers & post-filters (such as Phase 3 Float data).
 */
export class ScreenerPipeline<T extends ScreenerCandidateRow = ScreenerCandidateRow> {
  private readonly enrichers = new Map<string, ScreenerEnricher<T>>();
  private readonly postFilters = new Map<string, ScreenerPostFilter<T>>();

  registerEnricher(enricher: ScreenerEnricher<T>): () => void {
    this.enrichers.set(enricher.id, enricher);
    let removed = false;
    return () => {
      if (removed) return;
      removed = true;
      if (this.enrichers.get(enricher.id) === enricher) {
        this.enrichers.delete(enricher.id);
      }
    };
  }

  registerPostFilter(hook: ScreenerPostFilter<T>): () => void {
    this.postFilters.set(hook.id, hook);
    let removed = false;
    return () => {
      if (removed) return;
      removed = true;
      if (this.postFilters.get(hook.id) === hook) {
        this.postFilters.delete(hook.id);
      }
    };
  }

  hasCapability(cap: ScreenerCapability): boolean {
    for (const enricher of this.enrichers.values()) {
      if (typeof enricher.isEnabled === "function" && !enricher.isEnabled()) {
        continue;
      }
      if (enricher.provides.includes(cap)) return true;
    }
    return false;
  }

  getRegisteredEnrichers(): ReadonlyArray<string> {
    return Array.from(this.enrichers.values())
      .sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100))
      .map((e) => e.id);
  }

  getRegisteredFilters(): ReadonlyArray<string> {
    return Array.from(this.postFilters.values())
      .sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100))
      .map((f) => f.id);
  }

  async execute(
    candidates: ReadonlyArray<T>,
    filters: ScreenerPipelineFilters,
    opts?: { nowMs?: number; signal?: AbortSignal },
  ): Promise<ScreenerPipelineResult<T>> {
    const nowMs = typeof opts?.nowMs === "number" && Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now();
    const sessionPhase = getUsMarketSessionPhase(nowMs);

    // Stage 1: Core IBKR market criteria (Price, Change %, RelVol, Volume, Search, Session)
    let working = filterScreenerRows([...candidates], filters, { skipFloatFilter: true });

    const orderedEnrichers = Array.from(this.enrichers.values()).sort(
      (a, b) => (a.priority ?? 100) - (b.priority ?? 100),
    );
    const activeCapabilities = new Set<ScreenerCapability>();
    const activeEnrichers: string[] = [];
    const enricherStatus: Record<string, ScreenerEnricherStatus> = {};

    const ctx: ScreenerPipelineContext = {
      filters,
      sessionPhase,
      nowMs,
      signal: opts?.signal,
      activeCapabilities,
    };

    // Stage 2: External Enrichers (e.g. Phase 3 Float API) — executed ONLY on Stage 1 survivors
    for (const enricher of orderedEnrichers) {
      if (enricher.getStatus) {
        try {
          enricherStatus[enricher.id] = enricher.getStatus();
        } catch {
          // ignore status telemetry failure
        }
      }
      if (typeof enricher.isEnabled === "function" && !enricher.isEnabled()) {
        continue;
      }
      if (opts?.signal?.aborted) break;
      try {
        const enriched = await enricher.enrich(working, ctx);
        if (Array.isArray(enriched)) {
          working = [...enriched];
          activeEnrichers.push(enricher.id);
          for (const cap of enricher.provides) {
            activeCapabilities.add(cap);
          }
        }
      } catch {
        // Isolate external enricher failures so IBKR screener results still stream cleanly
      } finally {
        if (enricher.getStatus) {
          try {
            enricherStatus[enricher.id] = enricher.getStatus();
          } catch {
            // ignore status telemetry failure
          }
        }
      }
    }

    // Stage 3: Composable Post-Filters
    const orderedFilters = Array.from(this.postFilters.values()).sort(
      (a, b) => (a.priority ?? 100) - (b.priority ?? 100),
    );
    const activeFilters: string[] = [];
    const pendingSet = new Set<ScreenerCapability>();

    for (const hook of orderedFilters) {
      if (hook.requiresCapability && !activeCapabilities.has(hook.requiresCapability)) {
        if (hook.id === BUILTIN_EXTERNAL_FLOAT_FILTER_ID) {
          const wantsFloat = filters.floatMin != null || filters.floatMax != null;
          if (wantsFloat) {
            pendingSet.add("floatShares");
            // Never drop IBKR candidates that have null floatShares while no external Float provider is active
            working = working.filter(
              (row) =>
                typeof row.floatShares !== "number" ||
                !Number.isFinite(row.floatShares) ||
                passesOptionalRange(row.floatShares, filters.floatMin, filters.floatMax),
            );
          }
        } else {
          pendingSet.add(hook.requiresCapability);
        }
        continue;
      }

      activeFilters.push(hook.id);
      working = working.filter((row) => {
        try {
          return hook.evaluate(row, ctx);
        } catch {
          return true;
        }
      });
    }

    // Stage 4: Dynamic Sorting
    const sorted = sortCandidateRows(
      working,
      filters.sortBy ?? "change",
      filters.sortOrder ?? "desc",
    );

    return {
      rows: sorted,
      totalCount: sorted.length,
      meta: {
        activeEnrichers,
        activeFilters,
        pendingCapabilities: Array.from(pendingSet),
        sessionPhase,
        ...(Object.keys(enricherStatus).length > 0 ? { enricherStatus } : {}),
      },
    };
  }
}

/**
 * Instantiates the default screener pipeline with the Phase 3 external Float filter hook pre-registered.
 */
export function createDefaultScreenerPipeline<
  T extends ScreenerCandidateRow = ScreenerCandidateRow,
>(): ScreenerPipeline<T> {
  const pipeline = new ScreenerPipeline<T>();
  pipeline.registerPostFilter({
    id: BUILTIN_EXTERNAL_FLOAT_FILTER_ID,
    priority: 100,
    requiresCapability: "floatShares",
    evaluate: (row, ctx) =>
      passesOptionalRange(row.floatShares, ctx.filters.floatMin, ctx.filters.floatMax),
  });
  return pipeline;
}
