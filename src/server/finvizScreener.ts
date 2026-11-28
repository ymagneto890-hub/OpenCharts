export interface FinvizScreenerQueryPayload {
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

export interface FinvizScreenerRow {
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

export interface FinvizScreenerResponse {
  totalCount: number;
  items: FinvizScreenerRow[];
  fetchedAt: number;
  source: "finviz";
  finvizUrl: string;
}

export interface FinvizScreenerStreamEvent {
  type: "snapshot" | "update" | "status";
  connected?: boolean;
  reason?: string;
  totalCount?: number;
  items?: FinvizScreenerRow[];
  fetchedAt?: number;
  source?: "finviz";
  finvizUrl?: string;
}

const FINVIZ_BASE_URL = "https://finviz.com/screener/stocks";
/** Custom table view columns: No, Ticker, Company, Sector, Industry, Country, MarketCap, SharesOut, SharesFloat, AvgVol, RelVol, Price, Change, Volume */
const FINVIZ_CUSTOM_COLUMNS = "0,1,2,3,4,5,6,24,25,63,64,65,66,67";
const FINVIZ_PAGE_SIZE = 20;
const MAX_AUTO_PAGES = 4; // Up to 80 rows per initial scan without excessive requests
const CACHE_TTL_MS = 12_000;
const STREAM_POLL_MS = 20_000;

const FINVIZ_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

const FLOAT_PRESETS_M = [1, 2, 5, 10, 15, 20, 50, 100] as const;
const PRICE_PRESETS = [1, 2, 3, 4, 5, 7, 10, 15, 20, 30, 40, 50, 60, 70, 80, 90, 100] as const;
const RELVOL_PRESETS = [0.1, 0.2, 0.3, 0.5, 0.75, 1, 1.5, 2, 3, 5, 10] as const;
const CHANGE_PRESETS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 15, 20] as const;
const CURVOL_PRESETS_K = [50, 100, 200, 300, 400, 500, 750, 1000, 1500, 2000, 5000, 10000, 20000] as const;

const FINVIZ_SECTOR_CODES: Record<string, string> = {
  "basic materials": "sec_basicmaterials",
  "communication services": "sec_communicationservices",
  "consumer cyclical": "sec_consumercyclical",
  "consumer defensive": "sec_consumerdefensive",
  energy: "sec_energy",
  financial: "sec_financial",
  finance: "sec_financial",
  healthcare: "sec_healthcare",
  "health technology": "sec_healthcare",
  industrials: "sec_industrials",
  "real estate": "sec_realestate",
  technology: "sec_technology",
  "electronic technology": "sec_technology",
  "technology services": "sec_technology",
  utilities: "sec_utilities",
};

function isFiniteNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function pickPresetUnder(val: number, presets: readonly number[]): number | null {
  for (const p of presets) {
    if (Math.abs(p - val) < 1e-6 || p >= val) return p;
  }
  return null;
}

function pickPresetOver(val: number, presets: readonly number[]): number | null {
  let best: number | null = null;
  for (const p of presets) {
    if (Math.abs(p - val) < 1e-6 || p <= val) best = p;
  }
  return best;
}

/**
 * Translates UI screener filters into Finviz `f=` filter codes.
 * Default filters produce the exact user URL:
 * `f=sh_float_u20,ta_change_u10,sh_price_u20,sh_relvol_o5&ft=3`
 */
export function buildFinvizFilterCodes(payload: FinvizScreenerQueryPayload): string[] {
  const codes: string[] = [];

  // 1. Float (in shares -> Finviz millions)
  const hasFloatMin = isFiniteNum(payload.floatMin) && payload.floatMin > 0;
  const hasFloatMax = isFiniteNum(payload.floatMax) && payload.floatMax > 0;
  if (!hasFloatMin && hasFloatMax) {
    const maxM = payload.floatMax! / 1_000_000;
    const preset = pickPresetUnder(maxM, FLOAT_PRESETS_M);
    if (preset !== null) codes.push(`sh_float_u${preset}`);
  } else if (hasFloatMin && !hasFloatMax) {
    const minM = payload.floatMin! / 1_000_000;
    const preset = pickPresetOver(minM, FLOAT_PRESETS_M);
    if (preset !== null) codes.push(`sh_float_o${preset}`);
  } else if (hasFloatMin && hasFloatMax) {
    const maxM = Math.max(payload.floatMin!, payload.floatMax!) / 1_000_000;
    const preset = pickPresetUnder(maxM, FLOAT_PRESETS_M);
    if (preset !== null) codes.push(`sh_float_u${preset}`);
  }

  // 2. Change % (use free Finviz presets and enforce exact min/max in postFilterFinvizRows)
  const hasChgMin = isFiniteNum(payload.changeMin);
  const hasChgMax = isFiniteNum(payload.changeMax);
  if (hasChgMin && payload.changeMin! > 0) {
    const preset = pickPresetOver(payload.changeMin!, CHANGE_PRESETS);
    if (preset !== null) codes.push(`ta_change_u${preset}`);
  } else if (hasChgMax && payload.changeMax! < 0) {
    const preset = pickPresetOver(Math.abs(payload.changeMax!), CHANGE_PRESETS);
    if (preset !== null) codes.push(`ta_change_d${preset}`);
  }

  // 3. Price ($) — use free Finviz presets (avoid Elite-only XtoY codes) + exact post-filtering
  const hasPriceMin = isFiniteNum(payload.priceMin) && payload.priceMin > 0;
  const hasPriceMax = isFiniteNum(payload.priceMax) && payload.priceMax > 0;
  if (hasPriceMax) {
    const hi = hasPriceMin ? Math.max(payload.priceMin!, payload.priceMax!) : payload.priceMax!;
    const preset = pickPresetUnder(hi, PRICE_PRESETS);
    if (preset !== null) codes.push(`sh_price_u${preset}`);
  } else if (hasPriceMin) {
    const preset = pickPresetOver(payload.priceMin!, PRICE_PRESETS);
    if (preset !== null) codes.push(`sh_price_o${preset}`);
  }

  // 4. Relative Volume (Finviz 90-day / 3M relative volume)
  if (isFiniteNum(payload.relVolMin) && payload.relVolMin > 0) {
    const preset = pickPresetOver(payload.relVolMin, RELVOL_PRESETS);
    if (preset !== null) codes.push(`sh_relvol_o${preset}`);
  }

  // 5. Optional Current Volume
  if (isFiniteNum(payload.volumeMin) && payload.volumeMin > 0) {
    const volK = payload.volumeMin / 1_000;
    const preset = pickPresetOver(volK, CURVOL_PRESETS_K);
    if (preset !== null) codes.push(`sh_curvol_o${preset}`);
  }

  // 6. Optional Market Cap
  const capMin = isFiniteNum(payload.marketCapMin) ? payload.marketCapMin : null;
  const capMax = isFiniteNum(payload.marketCapMax) ? payload.marketCapMax : null;
  if (capMin === 50_000_000 && capMax === 300_000_000) codes.push("cap_micro");
  else if (capMin === 300_000_000 && capMax === 2_000_000_000) codes.push("cap_small");
  else if (capMin === 2_000_000_000 && capMax === 10_000_000_000) codes.push("cap_mid");
  else if (capMin === 10_000_000_000 && capMax === null) codes.push("cap_largeover");

  // 7. Optional Sector
  if (typeof payload.sector === "string" && payload.sector.trim()) {
    const secCode = FINVIZ_SECTOR_CODES[payload.sector.trim().toLowerCase()];
    if (secCode) codes.push(secCode);
  }

  return codes;
}

export function buildFinvizSortParam(sortBy?: string, sortOrder: "asc" | "desc" = "desc"): string {
  const prefix = sortOrder === "asc" ? "" : "-";
  switch (sortBy) {
    case "name":
      return `${prefix}ticker`;
    case "close":
      return `${prefix}price`;
    case "volume":
      return `${prefix}volume`;
    case "relative_volume_10d_calc":
      return `${prefix}relvol`;
    case "market_cap_basic":
      return `${prefix}marketcap`;
    case "float_shares_outstanding":
      return `${prefix}sharesfloat`;
    case "change":
    default:
      return `${prefix}change`;
  }
}

/** Builds the user-visible Finviz URL matching the active filters (e.g. `https://finviz.com/screener/stocks?f=sh_float_u20%2Cta_change_u10%2Csh_price_u20%2Csh_relvol_o5&ft=3`). */
export function buildPublicFinvizUrl(payload: FinvizScreenerQueryPayload): string {
  const codes = buildFinvizFilterCodes(payload);
  const qs = new URLSearchParams();
  if (codes.length > 0) qs.set("f", codes.join(","));
  qs.set("ft", "3");
  return `${FINVIZ_BASE_URL}?${qs.toString()}`;
}

/** Builds the internal Finviz custom-table URL (`v=152`) that embeds Float, RelVol, Price, Change, Volume, MarketCap, Sector & Company in SSR JSON. */
export function buildFinvizScrapeUrl(
  payload: FinvizScreenerQueryPayload,
  startRow = 1,
): string {
  const codes = buildFinvizFilterCodes(payload);
  const qs = new URLSearchParams();
  qs.set("v", "152");
  if (codes.length > 0) qs.set("f", codes.join(","));
  qs.set("ft", "3");
  qs.set("o", buildFinvizSortParam(payload.sortBy, payload.sortOrder ?? "desc"));
  qs.set("c", FINVIZ_CUSTOM_COLUMNS);
  if (startRow > 1) {
    qs.set("r", String(startRow));
  }
  return `${FINVIZ_BASE_URL}?${qs.toString()}`;
}

interface FinvizSsrRow {
  text?: {
    ticker?: string;
    company?: string;
    sector?: string;
    industry?: string;
    country?: string;
    exchange?: string;
  };
  numbers?: {
    marketCap?: number;
    sharesOutstanding2?: number;
    sharesFloat?: number;
    price?: number;
    change?: number;
    volume?: number;
    averageVolume?: number;
    relativeVolume?: number;
    rsi?: number;
  };
}

function normalizeCountry(raw?: string): string {
  if (!raw || raw === "USA") return "United States";
  return raw;
}

/**
 * Parses Finviz's SSR JSON (`data-ssr-props`) from the screener HTML page,
 * with a fallback regex parser for table rows if SSR markup changes.
 */
export function parseFinvizScreenerHtml(html: string): {
  totalCount: number;
  pageSize: number;
  rows: FinvizScreenerRow[];
} {
  const scriptRegex = /<script\s+type="application\/json"\s+data-ssr-props="[^"]*">([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;

  while ((match = scriptRegex.exec(html)) !== null) {
    const rawJson = match[1];
    if (!rawJson || !rawJson.includes('"rows"')) continue;
    try {
      const parsed = JSON.parse(rawJson) as {
        data?: {
          rows?: FinvizSsrRow[];
          totalCount?: number;
          pageSize?: number;
        };
      };
      const rawRows = parsed?.data?.rows;
      if (!Array.isArray(rawRows)) continue;

      const rows: FinvizScreenerRow[] = [];
      for (const r of rawRows) {
        const ticker = (r.text?.ticker ?? "").trim().toUpperCase();
        if (!ticker) continue;
        const n = r.numbers ?? {};
        const close = isFiniteNum(n.price) && n.price > 0 ? Number(n.price.toFixed(4)) : 0;
        const change = isFiniteNum(n.change) ? Number(n.change.toFixed(2)) : null;
        const volume = isFiniteNum(n.volume) && n.volume >= 0 ? Math.round(n.volume) : null;
        const relativeVolume = isFiniteNum(n.relativeVolume)
          ? Number(n.relativeVolume.toFixed(2))
          : null;
        const floatShares = isFiniteNum(n.sharesFloat) && n.sharesFloat > 0
          ? Math.round(n.sharesFloat * 1_000_000)
          : isFiniteNum(n.sharesOutstanding2) && n.sharesOutstanding2 > 0
            ? Math.round(n.sharesOutstanding2 * 1_000_000)
            : null;
        const marketCap = isFiniteNum(n.marketCap) && n.marketCap > 0
          ? Math.round(n.marketCap * 1_000_000)
          : null;
        const exchange = (r.text?.exchange ?? "US").trim().toUpperCase() || "US";

        rows.push({
          id: `FINVIZ:${ticker}`,
          ticker,
          description: (r.text?.company ?? ticker).trim() || ticker,
          close,
          change,
          volume,
          relativeVolume,
          marketCap,
          priceToBook: null,
          epsDiluted: null,
          epsGrowthYoY: null,
          dividendYield: null,
          sector: (r.text?.sector ?? "").trim(),
          exchange,
          perfW: null,
          perf1M: null,
          perf3M: null,
          perfYTD: null,
          perfY: null,
          rsi: isFiniteNum(n.rsi) ? Number(n.rsi.toFixed(2)) : null,
          recommendAll: null,
          floatShares,
          currency: "USD",
          country: normalizeCountry(r.text?.country),
          premarketClose: null,
          premarketChange: null,
          premarketVolume: null,
        });
      }

      const totalCount = isFiniteNum(parsed.data?.totalCount)
        ? parsed.data!.totalCount!
        : rows.length;
      const pageSize = isFiniteNum(parsed.data?.pageSize) && parsed.data!.pageSize! > 0
        ? parsed.data!.pageSize!
        : FINVIZ_PAGE_SIZE;

      return { totalCount, pageSize, rows };
    } catch {
      // try next script tag if any
    }
  }

  return { totalCount: 0, pageSize: FINVIZ_PAGE_SIZE, rows: [] };
}

function passesRange(
  val: number | null,
  minVal?: number | null,
  maxVal?: number | null,
  strictMin = false,
): boolean {
  const hasMin = isFiniteNum(minVal);
  const hasMax = isFiniteNum(maxVal);
  if (!hasMin && !hasMax) return true;
  if (!isFiniteNum(val)) return false;
  if (hasMin && (strictMin ? val <= minVal! : val < minVal!)) return false;
  if (hasMax && val > maxVal!) return false;
  return true;
}

/**
 * Applies exact numeric post-filters for any custom non-preset bounds entered in the UI
 * (e.g. Float 0.8M–20M, RelVol >= 4x, Search text, etc.).
 */
export function postFilterFinvizRows(
  rows: ReadonlyArray<FinvizScreenerRow>,
  payload: FinvizScreenerQueryPayload,
): FinvizScreenerRow[] {
  const q = (payload.search ?? "").trim().toLowerCase();
  const sectorFilter = (payload.sector ?? "").trim().toLowerCase();
  const strictPosChg = isFiniteNum(payload.changeMin) && payload.changeMin > 0 && payload.changeMax == null;

  return rows.filter((row) => {
    if (!passesRange(row.close, payload.priceMin, payload.priceMax)) return false;
    if (!passesRange(row.change, payload.changeMin, payload.changeMax, strictPosChg)) return false;
    if (!passesRange(row.floatShares, payload.floatMin, payload.floatMax)) return false;
    if (!passesRange(row.marketCap, payload.marketCapMin, payload.marketCapMax)) return false;
    if (isFiniteNum(payload.relVolMin) && (!isFiniteNum(row.relativeVolume) || row.relativeVolume < payload.relVolMin)) {
      return false;
    }
    if (isFiniteNum(payload.volumeMin) && (!isFiniteNum(row.volume) || row.volume < payload.volumeMin)) {
      return false;
    }
    if (sectorFilter && row.sector.toLowerCase() !== sectorFilter) return false;
    if (q && !row.ticker.toLowerCase().includes(q) && !row.description.toLowerCase().includes(q)) {
      return false;
    }
    return true;
  });
}

export class FinvizScreener {
  private readonly fetchImpl: typeof fetch;
  private readonly cache = new Map<string, { at: number; result: FinvizScreenerResponse }>();
  private readonly inFlight = new Map<string, Promise<FinvizScreenerResponse>>();
  private readonly streamPools = new Map<
    string,
    {
      listeners: Set<(evt: FinvizScreenerStreamEvent) => void>;
      timer: ReturnType<typeof setInterval>;
      ac: AbortController;
      lastSig: string;
      lastSnapshot: FinvizScreenerStreamEvent | null;
    }
  >();
  private readonly cacheTtlMs: number;
  private readonly pollIntervalMs: number;

  constructor(opts?: {
    fetchImpl?: typeof fetch;
    cacheTtlMs?: number;
    pollIntervalMs?: number;
  }) {
    this.fetchImpl = opts?.fetchImpl ?? globalThis.fetch;
    this.cacheTtlMs = opts?.cacheTtlMs ?? CACHE_TTL_MS;
    this.pollIntervalMs = opts?.pollIntervalMs ?? STREAM_POLL_MS;
  }

  private async fetchPage(
    payload: FinvizScreenerQueryPayload,
    startRow: number,
    signal?: AbortSignal,
  ): Promise<{ totalCount: number; pageSize: number; rows: FinvizScreenerRow[] }> {
    const url = buildFinvizScrapeUrl(payload, startRow);
    const res = await this.fetchImpl(url, {
      method: "GET",
      headers: FINVIZ_HEADERS,
      signal,
    });
    if (!res.ok) {
      throw new Error(`Finviz respondió HTTP ${res.status}`);
    }
    const html = await res.text();
    return parseFinvizScreenerHtml(html);
  }

  async scan(
    payload: FinvizScreenerQueryPayload,
    signal?: AbortSignal,
    forceFresh = false,
  ): Promise<FinvizScreenerResponse> {
    const offset = Math.max(0, Math.floor(Number(payload.offset ?? 0) || 0));
    const limit = Math.min(500, Math.max(1, Math.floor(Number(payload.limit ?? 500) || 500)));
    const cacheKey = JSON.stringify({ ...payload, offset, limit });

    const now = Date.now();
    if (!forceFresh) {
      const cached = this.cache.get(cacheKey);
      if (cached && now - cached.at < this.cacheTtlMs) {
        return cached.result;
      }
    }

    const existing = this.inFlight.get(cacheKey);
    if (existing) return existing;

    const promise = (async (): Promise<FinvizScreenerResponse> => {
      const startRow = offset + 1;
      const firstPage = await this.fetchPage(payload, startRow, signal);

      const seen = new Set<string>();
      const collected: FinvizScreenerRow[] = [];
      for (const row of firstPage.rows) {
        if (!seen.has(row.ticker)) {
          seen.add(row.ticker);
          collected.push(row);
        }
      }

      const pageSize = firstPage.pageSize || FINVIZ_PAGE_SIZE;
      const maxRowsWanted = Math.min(limit, MAX_AUTO_PAGES * pageSize);
      const extraStarts: number[] = [];
      let nextStart = startRow + pageSize;
      while (
        nextStart <= firstPage.totalCount &&
        collected.length + extraStarts.length * pageSize < maxRowsWanted &&
        extraStarts.length < MAX_AUTO_PAGES - 1
      ) {
        extraStarts.push(nextStart);
        nextStart += pageSize;
      }

      for (let i = 0; i < extraStarts.length; i += 2) {
        if (signal?.aborted) break;
        const batch = extraStarts.slice(i, i + 2);
        const pages = await Promise.all(
          batch.map((rStart) => this.fetchPage(payload, rStart, signal).catch(() => null)),
        );
        for (const p of pages) {
          if (!p) continue;
          for (const row of p.rows) {
            if (!seen.has(row.ticker)) {
              seen.add(row.ticker);
              collected.push(row);
            }
          }
        }
      }

      const filtered = postFilterFinvizRows(collected, payload);
      const exactFinvizMatch = filtered.length === collected.length;
      const totalCount = exactFinvizMatch
        ? Math.max(filtered.length, firstPage.totalCount)
        : filtered.length;

      const result: FinvizScreenerResponse = {
        totalCount,
        items: filtered.slice(0, limit),
        fetchedAt: Date.now(),
        source: "finviz",
        finvizUrl: buildPublicFinvizUrl(payload),
      };

      if (this.cache.size >= 32) {
        const oldest = this.cache.keys().next().value;
        if (oldest !== undefined) this.cache.delete(oldest);
      }
      this.cache.set(cacheKey, { at: result.fetchedAt, result });
      return result;
    })().finally(() => {
      if (this.inFlight.get(cacheKey) === promise) {
        this.inFlight.delete(cacheKey);
      }
    });

    this.inFlight.set(cacheKey, promise);
    return promise;
  }

  /**
   * Acquires an auto-refreshing SSE stream backed by Finviz scraping (refreshes every 20s while open).
   */
  acquireStream(
    payload: FinvizScreenerQueryPayload,
    onEvent: (evt: FinvizScreenerStreamEvent) => void,
  ): () => void {
    const poolKey = JSON.stringify(payload);
    let pool = this.streamPools.get(poolKey);

    if (!pool) {
      const ac = new AbortController();
      const listeners = new Set<(evt: FinvizScreenerStreamEvent) => void>();
      const created = {
        listeners,
        ac,
        lastSig: "",
        lastSnapshot: null as FinvizScreenerStreamEvent | null,
        timer: null as unknown as ReturnType<typeof setInterval>,
      };

      const broadcast = (evt: FinvizScreenerStreamEvent) => {
        for (const fn of created.listeners) {
          try {
            fn(evt);
          } catch {
            // ignore broken SSE writer
          }
        }
      };

      const pushScan = async (type: "snapshot" | "update", forceFresh: boolean) => {
        if (ac.signal.aborted || created.listeners.size === 0) return;
        try {
          const res = await this.scan(payload, ac.signal, forceFresh);
          if (ac.signal.aborted || created.listeners.size === 0) return;
          const sig = JSON.stringify(
            res.items.map((r) => [r.ticker, r.close, r.change, r.relativeVolume, r.volume, r.floatShares]),
          );
          const evt: FinvizScreenerStreamEvent = {
            type,
            connected: true,
            totalCount: res.totalCount,
            items: res.items,
            fetchedAt: res.fetchedAt,
            source: "finviz",
            finvizUrl: res.finvizUrl,
          };
          created.lastSnapshot = evt;
          if (type === "update" && sig === created.lastSig) return;
          created.lastSig = sig;
          broadcast(evt);
        } catch (err) {
          if (ac.signal.aborted || created.listeners.size === 0) return;
          broadcast({
            type: "status",
            connected: false,
            reason: err instanceof Error ? err.message : String(err),
          });
        }
      };

      created.timer = setInterval(() => {
        void pushScan("update", true);
      }, this.pollIntervalMs);
      pool = created;
      this.streamPools.set(poolKey, pool);
      pool.listeners.add(onEvent);
      void pushScan("snapshot", false);
    } else {
      pool.listeners.add(onEvent);
      if (pool.lastSnapshot) {
        try {
          onEvent({ ...pool.lastSnapshot, type: "snapshot" });
        } catch {
          // ignore
        }
      }
    }

    let released = false;
    return () => {
      if (released) return;
      released = true;
      const cur = this.streamPools.get(poolKey);
      if (!cur) return;
      cur.listeners.delete(onEvent);
      if (cur.listeners.size === 0) {
        clearInterval(cur.timer);
        cur.ac.abort();
        this.streamPools.delete(poolKey);
      }
    };
  }
}
