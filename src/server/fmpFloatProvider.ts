import fs from "node:fs";
import path from "node:path";
import type {
  ScreenerCandidateRow,
  ScreenerEnricher,
  ScreenerEnricherStatus,
} from "../lib/screenerPipeline.ts";

export const FMP_SHARES_FLOAT_BASE_URL = "https://financialmodelingprep.com/stable/shares-float";
export const FMP_DAILY_CALL_LIMIT = 250;
export const FMP_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
export const FMP_REQUEST_TIMEOUT_MS = 5_000;
export const FMP_MAX_CONCURRENCY = 3;
export const FMP_TRANSIENT_RETRY_COOLDOWN_MS = 60_000;
export const FMP_AUTH_ERROR_COOLDOWN_MS = 5 * 60_000;

export interface FmpFloatCacheEntry {
  symbol: string;
  floatShares: number | null;
  freeFloat: number | null;
  outstandingShares: number | null;
  fetchedAt: number;
  dateKey: string;
  status: "ok" | "no_data";
}

export interface FmpFloatCacheFile {
  version: 1;
  dateKey: string;
  dailyRequestCount: number;
  quotaExhausted: boolean;
  entries: Record<string, FmpFloatCacheEntry>;
}

export interface FmpFloatProviderOptions {
  apiKey?: string;
  cacheFile?: string;
  dailyLimit?: number;
  ttlMs?: number;
  requestTimeoutMs?: number;
  maxConcurrency?: number;
  transientRetryCooldownMs?: number;
  fetchImpl?: typeof fetch;
  nowFn?: () => number;
  /** Optional fallback resolver (e.g. SEC EDGAR shares outstanding) when FMP lacks coverage or plan access for a ticker. */
  fallbackResolver?: (symbol: string, signal?: AbortSignal) => Promise<number | null>;
}

type ParsedFmpResult =
  | {
      kind: "ok";
      floatShares: number;
      freeFloat: number | null;
      outstandingShares: number | null;
    }
  | { kind: "no_data" }
  | { kind: "quota_error"; message: string }
  | { kind: "auth_error"; message: string }
  | { kind: "error"; message: string };

let nyDateFormatter: Intl.DateTimeFormat | null = null;

function getNyDateFormatter(): Intl.DateTimeFormat {
  if (!nyDateFormatter) {
    nyDateFormatter = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
  }
  return nyDateFormatter;
}

/**
 * Formats an epoch timestamp (ms) into `YYYY-MM-DD` in `America/New_York`.
 */
export function getNyDateKey(nowMs: number): string {
  try {
    const parts = getNyDateFormatter().formatToParts(new Date(nowMs));
    let year = "";
    let month = "";
    let day = "";
    for (const part of parts) {
      if (part.type === "year") year = part.value;
      else if (part.type === "month") month = part.value;
      else if (part.type === "day") day = part.value;
    }
    if (year && month && day) return `${year}-${month}-${day}`;
  } catch {
    // Fallback to UTC ISO date if timezone ICU formatting fails
  }
  return new Date(nowMs).toISOString().slice(0, 10);
}

function normalizeSymbol(raw: string): string {
  return raw.trim().toUpperCase();
}

function symbolsEquivalent(a: string, b: string): boolean {
  const normA = normalizeSymbol(a).replace(/\./g, "-");
  const normB = normalizeSymbol(b).replace(/\./g, "-");
  return normA.length > 0 && normA === normB;
}

function toPositiveFiniteNumber(raw: unknown): number | null {
  if (typeof raw === "number") {
    return Number.isFinite(raw) && raw > 0 ? raw : null;
  }
  if (typeof raw === "string") {
    const cleaned = raw.trim();
    if (!cleaned) return null;
    const num = Number(cleaned);
    return Number.isFinite(num) && num > 0 ? num : null;
  }
  return null;
}

function sanitizeErrorMessage(message: string, apiKey: string): string {
  let clean = message.replace(/apikey=[^&\s"']+/gi, "apikey=[REDACTED]");
  if (apiKey) {
    clean = clean.split(apiKey).join("[REDACTED]");
  }
  return clean.trim() || "Error desconocido al consultar FMP";
}

/**
 * Parses a JSON payload returned by FMP `/stable/shares-float`.
 */
export function parseFmpSharesFloatPayload(
  payload: unknown,
  requestedSymbol: string,
): ParsedFmpResult {
  if (payload == null) {
    return { kind: "no_data" };
  }

  if (!Array.isArray(payload)) {
    if (typeof payload === "object") {
      const obj = payload as Record<string, unknown>;
      const rawMsg =
        typeof obj["Error Message"] === "string"
          ? obj["Error Message"]
          : typeof obj.message === "string"
            ? obj.message
            : typeof obj.error === "string"
              ? obj.error
              : "";
      if (rawMsg) {
        const lower = rawMsg.toLowerCase();
        if (/(limit|quota|too many|exceeded|upgrade)/.test(lower)) {
          return { kind: "quota_error", message: rawMsg };
        }
        if (/(invalid api|apikey|unauthorized|forbidden)/.test(lower)) {
          return { kind: "auth_error", message: rawMsg };
        }
        return { kind: "error", message: rawMsg };
      }
    }
    return { kind: "no_data" };
  }

  if (payload.length === 0) {
    return { kind: "no_data" };
  }

  const normalizedReq = normalizeSymbol(requestedSymbol);
  const candidates = payload.filter(
    (entry): entry is Record<string, unknown> => entry !== null && typeof entry === "object",
  );
  const matched =
    candidates.find(
      (entry) =>
        typeof entry.symbol === "string" && symbolsEquivalent(entry.symbol, normalizedReq),
    ) ?? candidates[0];

  if (!matched) {
    return { kind: "no_data" };
  }

  const floatShares = toPositiveFiniteNumber(matched.floatShares);
  if (floatShares === null) {
    return { kind: "no_data" };
  }

  return {
    kind: "ok",
    floatShares,
    freeFloat: toPositiveFiniteNumber(matched.freeFloat),
    outstandingShares: toPositiveFiniteNumber(matched.outstandingShares),
  };
}

/**
 * Server-side Financial Modeling Prep (FMP) Shares Float connector with persistent daily
 * caching (in-memory + atomic JSON disk cache) and 250 calls/day quota protection.
 *
 * Used strictly for ticker Float lookups on IBKR screener candidates that have already
 * passed dynamic IBKR market filters.
 */
export class FmpFloatProvider {
  private readonly apiKey: string;
  private readonly cacheFile: string | null;
  private readonly dailyLimit: number;
  private readonly ttlMs: number;
  private readonly requestTimeoutMs: number;
  private readonly maxConcurrency: number;
  private readonly transientRetryCooldownMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly nowFn: () => number;
  private readonly fallbackResolver:
    | ((symbol: string, signal?: AbortSignal) => Promise<number | null>)
    | null;

  private cacheDateKey: string;
  private dailyRequestCount = 0;
  private quotaExhausted = false;
  private lastError: string | null = null;
  private authErrorCooldownUntilMs = 0;

  private readonly entries = new Map<string, FmpFloatCacheEntry>();
  private readonly transientCooldowns = new Map<string, number>();
  private readonly inFlight = new Map<string, Promise<number | null>>();

  constructor(opts: FmpFloatProviderOptions = {}) {
    const rawKey = opts.apiKey ?? process.env.FMP_API_KEY ?? "";
    this.apiKey = rawKey.trim();
    this.cacheFile = opts.cacheFile ? path.resolve(opts.cacheFile) : null;
    this.dailyLimit = Math.max(1, Math.floor(opts.dailyLimit ?? FMP_DAILY_CALL_LIMIT));
    this.ttlMs = Math.max(60_000, Math.floor(opts.ttlMs ?? FMP_CACHE_TTL_MS));
    this.requestTimeoutMs = Math.max(500, Math.floor(opts.requestTimeoutMs ?? FMP_REQUEST_TIMEOUT_MS));
    this.maxConcurrency = Math.max(1, Math.floor(opts.maxConcurrency ?? FMP_MAX_CONCURRENCY));
    this.transientRetryCooldownMs = Math.max(
      1_000,
      Math.floor(opts.transientRetryCooldownMs ?? FMP_TRANSIENT_RETRY_COOLDOWN_MS),
    );
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    this.nowFn = opts.nowFn ?? (() => Date.now());
    this.fallbackResolver = opts.fallbackResolver ?? null;
    this.cacheDateKey = getNyDateKey(this.nowFn());

    this.loadCacheFromDisk();
    this.rolloverIfNeeded(this.nowFn());
  }

  isConfigured(): boolean {
    return this.apiKey.length > 0 || this.fallbackResolver !== null;
  }

  getStatus(): ScreenerEnricherStatus {
    const nowMs = this.nowFn();
    this.rolloverIfNeeded(nowMs);
    return {
      id: "fmp-shares-float",
      configured: this.isConfigured(),
      dailyCallsUsed: this.dailyRequestCount,
      dailyLimit: this.dailyLimit,
      remainingCalls: Math.max(0, this.dailyLimit - this.dailyRequestCount),
      cachedSymbols: this.entries.size,
      quotaExhausted: this.quotaExhausted || this.dailyRequestCount >= this.dailyLimit,
      lastError: this.lastError,
    };
  }

  getCachedFloat(symbol: string): { hit: boolean; floatShares: number | null } {
    const nowMs = this.nowFn();
    this.rolloverIfNeeded(nowMs);
    const norm = normalizeSymbol(symbol);
    if (!norm) return { hit: false, floatShares: null };

    const entry = this.entries.get(norm);
    if (!entry) return { hit: false, floatShares: null };

    if (entry.dateKey !== this.cacheDateKey || nowMs - entry.fetchedAt >= this.ttlMs) {
      this.entries.delete(norm);
      this.persistCacheToDisk();
      return { hit: false, floatShares: null };
    }

    return { hit: true, floatShares: entry.floatShares };
  }

  /**
   * Resolves Float for a batch of tickers using today's cache first and querying FMP
   * concurrently (bounded) ONLY for uncached symbols within quota/cooldown bounds.
   */
  async getFloatBatch(
    symbols: ReadonlyArray<string>,
    signal?: AbortSignal,
  ): Promise<Map<string, number | null>> {
    const out = new Map<string, number | null>();
    if (symbols.length === 0) return out;

    const nowMs = this.nowFn();
    this.rolloverIfNeeded(nowMs);

    const uniqueSymbols: string[] = [];
    const seen = new Set<string>();
    for (const raw of symbols) {
      const norm = normalizeSymbol(raw);
      if (!norm || seen.has(norm)) continue;
      seen.add(norm);
      uniqueSymbols.push(norm);
    }

    const uncached: string[] = [];
    for (const sym of uniqueSymbols) {
      const cached = this.getCachedFloat(sym);
      if (cached.hit) {
        out.set(sym, cached.floatShares);
      } else {
        uncached.push(sym);
      }
    }

    if (uncached.length === 0 || !this.isConfigured() || signal?.aborted) {
      for (const sym of uncached) {
        out.set(sym, null);
      }
      return out;
    }

    let cursor = 0;
    const worker = async () => {
      while (cursor < uncached.length) {
        if (signal?.aborted) break;
        const idx = cursor++;
        const sym = uncached[idx]!;
        const floatVal = await this.fetchAndCacheSymbol(sym, signal);
        out.set(sym, floatVal);
      }
    };

    const concurrency = Math.min(this.maxConcurrency, uncached.length);
    await Promise.all(Array.from({ length: concurrency }, () => worker()));

    for (const sym of uncached) {
      if (!out.has(sym)) {
        out.set(sym, this.getCachedFloat(sym).floatShares);
      }
    }
    return out;
  }

  /**
   * Creates a decoupled `ScreenerEnricher` ready to register into `IbkrEngine` / `ScreenerPipeline`.
   */
  createEnricher<T extends ScreenerCandidateRow>(): ScreenerEnricher<T> {
    return {
      id: "fmp-shares-float",
      priority: 10,
      provides: ["floatShares"],
      isEnabled: () => this.isConfigured(),
      getStatus: () => this.getStatus(),
      enrich: async (rows, ctx) => {
        if (rows.length === 0) return [];
        const resolved = await this.getFloatBatch(
          rows.map((r) => r.ticker),
          ctx.signal,
        );
        return rows.map((row) => ({
          ...row,
          floatShares: resolved.get(normalizeSymbol(row.ticker)) ?? null,
        }));
      },
    };
  }

  private async resolveViaFallback(
    symbol: string,
    signal?: AbortSignal,
    cacheMiss = false,
  ): Promise<number | null> {
    if (!this.fallbackResolver || signal?.aborted) {
      if (cacheMiss) {
        const now = this.nowFn();
        this.entries.set(symbol, {
          symbol,
          floatShares: null,
          freeFloat: null,
          outstandingShares: null,
          fetchedAt: now,
          dateKey: this.cacheDateKey,
          status: "no_data",
        });
        this.persistCacheToDisk();
      }
      return null;
    }

    try {
      const fallbackShares = await this.fallbackResolver(symbol, signal);
      const completedAt = this.nowFn();
      this.rolloverIfNeeded(completedAt);
      if (typeof fallbackShares === "number" && Number.isFinite(fallbackShares) && fallbackShares > 0) {
        this.entries.set(symbol, {
          symbol,
          floatShares: fallbackShares,
          freeFloat: null,
          outstandingShares: fallbackShares,
          fetchedAt: completedAt,
          dateKey: this.cacheDateKey,
          status: "ok",
        });
        this.transientCooldowns.delete(symbol);
        this.persistCacheToDisk();
        return fallbackShares;
      }
      if (cacheMiss) {
        this.entries.set(symbol, {
          symbol,
          floatShares: null,
          freeFloat: null,
          outstandingShares: null,
          fetchedAt: completedAt,
          dateKey: this.cacheDateKey,
          status: "no_data",
        });
        this.persistCacheToDisk();
      }
      return null;
    } catch {
      return null;
    }
  }

  private async fetchAndCacheSymbol(
    symbol: string,
    signal?: AbortSignal,
  ): Promise<number | null> {
    const cachedAgain = this.getCachedFloat(symbol);
    if (cachedAgain.hit) return cachedAgain.floatShares;

    const existingFlight = this.inFlight.get(symbol);
    if (existingFlight) {
      return existingFlight;
    }

    const nowMs = this.nowFn();
    this.rolloverIfNeeded(nowMs);

    if (!this.isConfigured() || signal?.aborted) {
      return null;
    }

    const fmpUnavailable =
      !this.apiKey ||
      this.quotaExhausted ||
      this.dailyRequestCount >= this.dailyLimit ||
      nowMs < this.authErrorCooldownUntilMs;

    if (fmpUnavailable) {
      if (!this.fallbackResolver) return null;
      const fbTask = this.resolveViaFallback(symbol, signal, false);
      this.inFlight.set(symbol, fbTask);
      void fbTask.finally(() => {
        if (this.inFlight.get(symbol) === fbTask) this.inFlight.delete(symbol);
      });
      return fbTask;
    }

    const transientRetryAt = this.transientCooldowns.get(symbol) ?? 0;
    if (nowMs < transientRetryAt) {
      return null;
    }

    // Reserve daily quota slot synchronously before async dispatch
    this.dailyRequestCount += 1;
    if (this.dailyRequestCount >= this.dailyLimit) {
      this.quotaExhausted = true;
    }
    this.persistCacheToDisk();

    const task = (async (): Promise<number | null> => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.requestTimeoutMs);
      const onParentAbort = () => controller.abort();
      signal?.addEventListener("abort", onParentAbort, { once: true });

      try {
        const endpoint = `${FMP_SHARES_FLOAT_BASE_URL}?symbol=${encodeURIComponent(symbol)}&apikey=${encodeURIComponent(this.apiKey)}`;
        const response = await this.fetchImpl(endpoint, {
          method: "GET",
          headers: { Accept: "application/json" },
          signal: controller.signal,
        });

        if (response.status === 429) {
          this.quotaExhausted = true;
          this.lastError = `Cuota FMP alcanzada (HTTP ${response.status})`;
          this.persistCacheToDisk();
          return await this.resolveViaFallback(symbol, signal, false);
        }

        if (response.status === 402) {
          const bodyText = await response.text().catch(() => "");
          const lowerBody = bodyText.toLowerCase();
          const isPerSymbolPlanRestriction =
            /(premium query parameter|special endpoint|not available under your current subscription|restricted endpoint)/.test(
              lowerBody,
            );
          if (isPerSymbolPlanRestriction) {
            // Free FMP plans restrict small-cap tickers individually via HTTP 402 — do NOT trip global quotaExhausted
            return await this.resolveViaFallback(symbol, signal, true);
          }
          this.quotaExhausted = true;
          this.lastError = `Cuota FMP alcanzada (HTTP ${response.status})`;
          this.persistCacheToDisk();
          return await this.resolveViaFallback(symbol, signal, false);
        }

        if (response.status === 401 || response.status === 403) {
          this.authErrorCooldownUntilMs = this.nowFn() + FMP_AUTH_ERROR_COOLDOWN_MS;
          this.lastError = `Autenticación FMP rechazada (HTTP ${response.status})`;
          return await this.resolveViaFallback(symbol, signal, false);
        }

        if (!response.ok) {
          this.transientCooldowns.set(symbol, this.nowFn() + this.transientRetryCooldownMs);
          this.lastError = `Error FMP HTTP ${response.status}`;
          return await this.resolveViaFallback(symbol, signal, false);
        }

        const json = (await response.json()) as unknown;
        const parsed = parseFmpSharesFloatPayload(json, symbol);
        const completedAt = this.nowFn();
        this.rolloverIfNeeded(completedAt);

        if (parsed.kind === "quota_error") {
          this.quotaExhausted = true;
          this.lastError = sanitizeErrorMessage(parsed.message, this.apiKey);
          this.persistCacheToDisk();
          return await this.resolveViaFallback(symbol, signal, false);
        }

        if (parsed.kind === "auth_error") {
          this.authErrorCooldownUntilMs = completedAt + FMP_AUTH_ERROR_COOLDOWN_MS;
          this.lastError = sanitizeErrorMessage(parsed.message, this.apiKey);
          return await this.resolveViaFallback(symbol, signal, false);
        }

        if (parsed.kind === "error") {
          this.transientCooldowns.set(symbol, completedAt + this.transientRetryCooldownMs);
          this.lastError = sanitizeErrorMessage(parsed.message, this.apiKey);
          return await this.resolveViaFallback(symbol, signal, false);
        }

        if (parsed.kind === "no_data" && this.fallbackResolver) {
          this.lastError = null;
          return await this.resolveViaFallback(symbol, signal, true);
        }

        const entry: FmpFloatCacheEntry =
          parsed.kind === "ok"
            ? {
                symbol,
                floatShares: parsed.floatShares,
                freeFloat: parsed.freeFloat,
                outstandingShares: parsed.outstandingShares,
                fetchedAt: completedAt,
                dateKey: this.cacheDateKey,
                status: "ok",
              }
            : {
                symbol,
                floatShares: null,
                freeFloat: null,
                outstandingShares: null,
                fetchedAt: completedAt,
                dateKey: this.cacheDateKey,
                status: "no_data",
              };

        this.entries.set(symbol, entry);
        this.transientCooldowns.delete(symbol);
        this.lastError = null;
        this.persistCacheToDisk();
        return entry.floatShares;
      } catch (err) {
        const failNow = this.nowFn();
        this.transientCooldowns.set(symbol, failNow + this.transientRetryCooldownMs);
        const rawMessage = err instanceof Error ? err.message : String(err);
        this.lastError = sanitizeErrorMessage(rawMessage, this.apiKey);
        return await this.resolveViaFallback(symbol, signal, false);
      } finally {
        clearTimeout(timeoutId);
        signal?.removeEventListener("abort", onParentAbort);
      }
    })();

    this.inFlight.set(symbol, task);
    void task.finally(() => {
      if (this.inFlight.get(symbol) === task) {
        this.inFlight.delete(symbol);
      }
    });
    return task;
  }

  private rolloverIfNeeded(nowMs: number): void {
    const todayKey = getNyDateKey(nowMs);
    let dirty = false;

    if (todayKey !== this.cacheDateKey) {
      this.cacheDateKey = todayKey;
      this.dailyRequestCount = 0;
      this.quotaExhausted = false;
      this.lastError = null;
      this.authErrorCooldownUntilMs = 0;
      this.transientCooldowns.clear();
      dirty = true;
    }

    for (const [sym, entry] of this.entries.entries()) {
      if (entry.dateKey !== this.cacheDateKey || nowMs - entry.fetchedAt >= this.ttlMs) {
        this.entries.delete(sym);
        dirty = true;
      }
    }

    if (dirty) {
      this.persistCacheToDisk();
    }
  }

  private loadCacheFromDisk(): void {
    if (!this.cacheFile) return;
    try {
      if (!fs.existsSync(this.cacheFile)) return;
      const raw = fs.readFileSync(this.cacheFile, "utf8");
      if (!raw.trim()) return;
      const parsed = JSON.parse(raw) as Partial<FmpFloatCacheFile>;
      if (!parsed || typeof parsed !== "object") return;

      const persistedDateKey = typeof parsed.dateKey === "string" ? parsed.dateKey : "";
      if (persistedDateKey === this.cacheDateKey) {
        if (typeof parsed.dailyRequestCount === "number" && Number.isFinite(parsed.dailyRequestCount)) {
          this.dailyRequestCount = Math.max(0, Math.floor(parsed.dailyRequestCount));
        }
        this.quotaExhausted =
          Boolean(parsed.quotaExhausted) || this.dailyRequestCount >= this.dailyLimit;
      }

      if (parsed.entries && typeof parsed.entries === "object") {
        const nowMs = this.nowFn();
        for (const [key, value] of Object.entries(parsed.entries)) {
          if (!value || typeof value !== "object") continue;
          const sym = normalizeSymbol(value.symbol ?? key);
          if (!sym) continue;
          if (value.dateKey !== this.cacheDateKey) continue;
          if (typeof value.fetchedAt !== "number" || !Number.isFinite(value.fetchedAt)) continue;
          if (nowMs - value.fetchedAt >= this.ttlMs) continue;

          const floatShares =
            typeof value.floatShares === "number" && Number.isFinite(value.floatShares) && value.floatShares > 0
              ? value.floatShares
              : null;
          this.entries.set(sym, {
            symbol: sym,
            floatShares,
            freeFloat:
              typeof value.freeFloat === "number" && Number.isFinite(value.freeFloat)
                ? value.freeFloat
                : null,
            outstandingShares:
              typeof value.outstandingShares === "number" &&
              Number.isFinite(value.outstandingShares)
                ? value.outstandingShares
                : null,
            fetchedAt: value.fetchedAt,
            dateKey: value.dateKey,
            status: floatShares !== null ? "ok" : "no_data",
          });
        }
      }
    } catch {
      // Ignore corrupt or unreadable cache file and start with empty cache
    }
  }

  private persistCacheToDisk(): void {
    if (!this.cacheFile) return;
    try {
      const dir = path.dirname(this.cacheFile);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const serialized: Record<string, FmpFloatCacheEntry> = {};
      for (const [sym, entry] of this.entries.entries()) {
        serialized[sym] = entry;
      }
      const payload: FmpFloatCacheFile = {
        version: 1,
        dateKey: this.cacheDateKey,
        dailyRequestCount: this.dailyRequestCount,
        quotaExhausted: this.quotaExhausted,
        entries: serialized,
      };
      const tmpPath = `${this.cacheFile}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
      fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2), "utf8");
      fs.renameSync(tmpPath, this.cacheFile);
    } catch {
      // Disk persistence errors must never block scanner execution
    }
  }
}
