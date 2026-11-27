import type { ScreenerPipelineMeta } from "../lib/screenerPipeline.ts";

export type { ScreenerPipelineMeta };

export interface ScreenerStock {
  id: string;
  ticker: string;
  description: string;
  exchange: string;
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
  perfW: number | null;
  perf1M: number | null;
  perf3M: number | null;
  perfYTD: number | null;
  perfY: number | null;
  rsi: number | null;
  recommendAll: number | null;
  floatShares: number | null;
  currency?: string;
  country?: string;
  premarketClose?: number | null;
  premarketChange?: number | null;
  premarketVolume?: number | null;
}

export type ScreenerViewTab = "overview" | "performance" | "technicals";
export type ScreenerMarketScope = "global" | "us" | "us_otc";

export type ScreenerSortField =
  | "name"
  | "close"
  | "change"
  | "volume"
  | "relative_volume_10d_calc"
  | "market_cap_basic"
  | "float_shares_outstanding"
  | "price_book_fq"
  | "earnings_per_share_diluted_ttm"
  | "earnings_per_share_diluted_yoy_growth_ttm"
  | "dividend_yield_recent"
  | "Perf.W"
  | "Perf.1M"
  | "Perf.3M"
  | "Perf.YTD"
  | "Perf.Y"
  | "RSI"
  | "Recommend.All";

export interface ScreenerFilters {
  marketScope: ScreenerMarketScope;
  includeOtc: boolean;
  onlyPremarket: boolean;
  marketCapMin: number | null;
  marketCapMax: number | null;
  floatMin: number | null;
  floatMax: number | null;
  changeMin: number | null;
  changeMax: number | null;
  priceMin: number | null;
  priceMax: number | null;
  volumeMin: number | null;
  relVolMin: number | null;
  sector: string;
  search: string;
  sortBy: ScreenerSortField;
  sortOrder: "asc" | "desc";
}

export const US_MAJOR_EXCHANGES = ["NYSE", "NASDAQ", "AMEX"] as const;

export const DEFAULT_SCREENER_FILTERS: ScreenerFilters = {
  marketScope: "us",
  includeOtc: false,
  onlyPremarket: false,
  marketCapMin: null,
  marketCapMax: null,
  floatMin: null,
  floatMax: 20_000_000,
  changeMin: 10,
  changeMax: null,
  priceMin: null,
  priceMax: 20,
  volumeMin: null,
  relVolMin: 5,
  sector: "",
  search: "",
  sortBy: "change",
  sortOrder: "desc",
};

export const SCREENER_SECTORS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "", label: "Todos los sectores" },
  { value: "Technology", label: "Tecnología" },
  { value: "Healthcare", label: "Salud y biotecnología" },
  { value: "Financial", label: "Finanzas" },
  { value: "Consumer Cyclical", label: "Consumo cíclico" },
  { value: "Consumer Defensive", label: "Consumo defensivo" },
  { value: "Industrials", label: "Industriales" },
  { value: "Energy", label: "Energía" },
  { value: "Basic Materials", label: "Materiales básicos" },
  { value: "Communication Services", label: "Comunicaciones" },
  { value: "Real Estate", label: "Inmobiliario" },
  { value: "Utilities", label: "Servicios públicos" },
];

const EXTRA_SECTOR_TRANSLATIONS: Record<string, string> = {
  "Electronic Technology": "Tecnología electrónica",
  "Technology Services": "Servicios tecnológicos",
  "Health Technology": "Tecnología sanitaria",
  "Health Services": "Servicios de salud",
  Finance: "Finanzas",
  "Producer Manufacturing": "Manufactura industrial",
  "Consumer Non-Durables": "Consumibles perecederos",
  "Consumer Durables": "Bienes duraderos",
  "Consumer Services": "Servicios al consumidor",
  "Retail Trade": "Comercio minorista",
  "Energy Minerals": "Energía y petróleo",
  "Non-Energy Minerals": "Minería y materiales",
  "Industrial Services": "Servicios industriales",
  "Commercial Services": "Servicios comerciales",
  Communications: "Comunicaciones",
  Transportation: "Transporte",
  "Process Industries": "Industrias de procesos",
  "Distribution Services": "Distribución",
  Miscellaneous: "Varios",
};

const SECTOR_LABEL_MAP = new Map<string, string>([
  ...SCREENER_SECTORS.map((s) => [s.value, s.label] as const),
  ...Object.entries(EXTRA_SECTOR_TRANSLATIONS),
]);

export function translateSector(sector: string): string {
  if (!sector) return "—";
  return SECTOR_LABEL_MAP.get(sector) ?? sector;
}

export interface ScreenerRequestPayload {
  marketScope: ScreenerMarketScope;
  exchanges: string[];
  onlyPremarket: boolean;
  marketCapMin: number | null;
  marketCapMax: number | null;
  floatMin: number | null;
  floatMax: number | null;
  changeMin: number | null;
  changeMax: number | null;
  priceMin: number | null;
  priceMax: number | null;
  volumeMin: number | null;
  relVolMin: number | null;
  sector: string | null;
  search: string;
  sortBy: ScreenerSortField;
  sortOrder: "asc" | "desc";
  offset: number;
  limit: number;
}

export interface ScreenerResponse {
  totalCount: number;
  items: ScreenerStock[];
  fetchedAt: number;
  source: string;
  finvizUrl?: string;
  pipelineMeta?: ScreenerPipelineMeta;
}

export function buildScreenerRequest(
  filters: ScreenerFilters,
  offset = 0,
  limit = 500,
): ScreenerRequestPayload {
  const onlyPremarket = Boolean(filters.onlyPremarket);
  const rawScope: ScreenerMarketScope =
    filters.marketScope ?? (filters.includeOtc ? "us_otc" : "us");
  const scope: ScreenerMarketScope = onlyPremarket ? "us" : rawScope;
  return {
    marketScope: scope,
    exchanges: scope === "us" ? [...US_MAJOR_EXCHANGES] : [],
    onlyPremarket,
    marketCapMin: filters.marketCapMin,
    marketCapMax: filters.marketCapMax,
    floatMin: filters.floatMin,
    floatMax: filters.floatMax,
    changeMin: filters.changeMin,
    changeMax: filters.changeMax,
    priceMin: filters.priceMin,
    priceMax: filters.priceMax,
    volumeMin: filters.volumeMin,
    relVolMin: filters.relVolMin,
    sector: filters.sector ? filters.sector : null,
    search: filters.search.trim(),
    sortBy: filters.sortBy,
    sortOrder: filters.sortOrder,
    offset: Math.max(0, Math.floor(offset)),
    limit: Math.min(2000, Math.max(1, Math.floor(limit))),
  };
}

export async function fetchStockScreener(
  filters: ScreenerFilters,
  offset = 0,
  limit = 500,
  signal?: AbortSignal,
): Promise<ScreenerResponse> {
  const payload = buildScreenerRequest(filters, offset, limit);
  const res = await fetch("/__api/stock-screener", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal,
  });

  if (!res.ok) {
    let errMsg = `HTTP ${res.status}`;
    try {
      const errJson = (await res.json()) as { error?: string };
      if (errJson?.error) errMsg = errJson.error;
    } catch {
      // ignore json parse failure
    }
    throw new Error(errMsg);
  }

  return (await res.json()) as ScreenerResponse;
}

export interface ScreenerStreamHandlers {
  onData: (res: ScreenerResponse) => void;
  onStatus?: (live: boolean, reason?: string) => void;
}

/**
 * Subscribes to the Finviz auto-refreshing screener SSE stream with exponential
 * reconnect backoff and clean teardown on unmount/filter changes.
 */
export function subscribeStockScreenerStream(
  filters: ScreenerFilters,
  handlers: ScreenerStreamHandlers,
): () => void {
  if (typeof window === "undefined" || typeof EventSource === "undefined") {
    return () => {};
  }

  const payload = buildScreenerRequest(filters, 0, 500);
  const url = `/__api/stock-screener/stream?filters=${encodeURIComponent(JSON.stringify(payload))}`;

  let es: EventSource | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectAttempt = 0;
  let closed = false;

  const clearReconnect = () => {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  };

  const closeCurrent = () => {
    if (es) {
      try {
        es.close();
      } catch {
        // ignore close error
      }
      es = null;
    }
  };

  const connect = () => {
    if (closed) return;
    closeCurrent();
    const source = new EventSource(url);
    es = source;

    source.onopen = () => {
      if (closed || es !== source) return;
      reconnectAttempt = 0;
      handlers.onStatus?.(true);
    };

    source.onmessage = (evt) => {
      if (closed || es !== source || !evt.data) return;
      try {
        const parsed = JSON.parse(evt.data) as {
          type?: "snapshot" | "update" | "status";
          connected?: boolean;
          reason?: string;
          totalCount?: number;
          items?: ScreenerStock[];
          fetchedAt?: number;
          source?: string;
          finvizUrl?: string;
          pipelineMeta?: ScreenerPipelineMeta;
        };
        if (parsed.type === "status") {
          handlers.onStatus?.(Boolean(parsed.connected), parsed.reason);
          return;
        }
        if (
          (parsed.type === "snapshot" || parsed.type === "update") &&
          Array.isArray(parsed.items)
        ) {
          reconnectAttempt = 0;
          handlers.onStatus?.(true);
          handlers.onData({
            totalCount:
              typeof parsed.totalCount === "number" ? parsed.totalCount : parsed.items.length,
            items: parsed.items,
            fetchedAt: typeof parsed.fetchedAt === "number" ? parsed.fetchedAt : Date.now(),
            source: parsed.source || "finviz",
            finvizUrl: parsed.finvizUrl,
            pipelineMeta: parsed.pipelineMeta,
          });
        }
      } catch {
        // ignore malformed SSE packet
      }
    };

    source.onerror = () => {
      if (closed || es !== source) return;
      closeCurrent();
      handlers.onStatus?.(false, "sse-disconnected");
      clearReconnect();
      const delayMs = Math.min(15_000, 1_500 * Math.pow(2, reconnectAttempt));
      reconnectAttempt += 1;
      reconnectTimer = setTimeout(connect, delayMs);
    };
  };

  connect();

  return () => {
    closed = true;
    clearReconnect();
    closeCurrent();
  };
}

export interface StockNewsItem {
  title: string;
  publisher: string;
  link: string;
  publishedAt: number | null;
  catalystTag: string | null;
}

export async function fetchStockNews(
  symbol: string,
  signal?: AbortSignal,
): Promise<{ symbol: string; items: StockNewsItem[] }> {
  const sym = symbol.trim().toUpperCase();
  const res = await fetch(`/__api/stock-news?symbol=${encodeURIComponent(sym)}`, { signal });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  return (await res.json()) as { symbol: string; items: StockNewsItem[] };
}

export function formatMarketCap(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return "—";
  if (value >= 1e12) return `${(value / 1e12).toFixed(2)} T USD`;
  if (value >= 1e9) return `${(value / 1e9).toFixed(2)} B USD`;
  if (value >= 1e6) return `${(value / 1e6).toFixed(1)} M USD`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)} K USD`;
  return `${value.toFixed(0)} USD`;
}

export function formatVolume(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return "—";
  if (value >= 1e9) return `${(value / 1e9).toFixed(2)} B`;
  if (value >= 1e6) return `${(value / 1e6).toFixed(2)} M`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(2)} K`;
  return value.toFixed(0);
}

export function formatPercent(value: number | null | undefined, showSign = true): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  const sign = showSign && value > 0 ? "+" : "";
  return `${sign}${value.toFixed(2)}%`;
}

export function formatPrice(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  if (value >= 1000) return value.toFixed(2);
  if (value >= 1) return value.toFixed(2);
  return value.toFixed(4);
}

export function formatDecimal(value: number | null | undefined, digits = 2): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  return value.toFixed(digits);
}

export interface RatingInfo {
  label: string;
  tone: "strong-buy" | "buy" | "neutral" | "sell" | "strong-sell" | "none";
}

export function getRatingInfo(recommendAll: number | null | undefined): RatingInfo {
  if (typeof recommendAll !== "number" || !Number.isFinite(recommendAll)) {
    return { label: "—", tone: "none" };
  }
  if (recommendAll >= 0.5) return { label: "Compra fuerte", tone: "strong-buy" };
  if (recommendAll >= 0.1) return { label: "Compra", tone: "buy" };
  if (recommendAll > -0.1) return { label: "Neutral", tone: "neutral" };
  if (recommendAll > -0.5) return { label: "Venta", tone: "sell" };
  return { label: "Venta fuerte", tone: "strong-sell" };
}
