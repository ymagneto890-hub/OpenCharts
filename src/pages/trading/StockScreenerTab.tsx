import { useVirtualizer } from "@tanstack/react-virtual";
import {
  AlertTriangle,
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  ArrowUpDown,
  ChevronDown,
  ExternalLink,
  Filter,
  Loader2,
  Newspaper,
  RefreshCw,
  RotateCcw,
  Search,
  Star,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  normalizeFavoriteTicker,
  useFavoriteSymbols,
} from "../../hooks/useFavoriteSymbols.ts";
import { cn } from "../../lib/utils.ts";
import { getDemoSymbol } from "../../services/demo/instruments.ts";
import {
  DEFAULT_SCREENER_FILTERS,
  fetchStockNews,
  fetchStockScreener,
  formatDecimal,
  formatMarketCap,
  formatPercent,
  formatPrice,
  formatVolume,
  SCREENER_SECTORS,
  subscribeStockScreenerStream,
  type ScreenerFilters,
  type ScreenerSortField,
  type ScreenerStock,
  type StockNewsItem,
  translateSector,
} from "../../services/stockScreener.ts";

export interface StockScreenerTabProps {
  onOpenStockInChart: (stock: ScreenerStock) => void;
  onBackToChart?: () => void;
  activeSymbol?: string;
}

type OpenPopover =
  | "relVol"
  | "float"
  | "change"
  | "price"
  | "marketCap"
  | "volume"
  | null;

const ROW_HEIGHT = 54;

interface ColumnDef {
  id: string;
  label: string;
  sortField?: ScreenerSortField;
  align?: "left" | "right";
  widthClass: string;
}

const OVERVIEW_COLUMNS: ColumnDef[] = [
  { id: "symbol", label: "Símbolo", sortField: "name", align: "left", widthClass: "w-[260px] shrink-0" },
  { id: "close", label: "Precio", sortField: "close", align: "right", widthClass: "w-[160px] shrink-0" },
  { id: "change", label: "Cbo %", sortField: "change", align: "right", widthClass: "w-[96px] shrink-0" },
  {
    id: "relativeVolume",
    label: "Vol. rel.",
    sortField: "relative_volume_10d_calc",
    align: "right",
    widthClass: "w-[96px] shrink-0",
  },
  {
    id: "float",
    label: "Float",
    sortField: "float_shares_outstanding",
    align: "right",
    widthClass: "w-[100px] shrink-0",
  },
  {
    id: "catalyst",
    label: "Noticias / Cat.",
    align: "left",
    widthClass: "w-[136px] shrink-0",
  },
  { id: "volume", label: "Vol.", sortField: "volume", align: "right", widthClass: "w-[92px] shrink-0" },
  {
    id: "marketCap",
    label: "Cap. de mercado",
    sortField: "market_cap_basic",
    align: "right",
    widthClass: "w-[130px] shrink-0",
  },
  { id: "sector", label: "Sector", align: "left", widthClass: "w-[165px] shrink-0" },
];

const AVATAR_PALETTE = [
  "bg-emerald-500/20 text-emerald-300 border-emerald-500/30",
  "bg-sky-500/20 text-sky-300 border-sky-500/30",
  "bg-amber-500/20 text-amber-300 border-amber-500/30",
  "bg-violet-500/20 text-violet-300 border-violet-500/30",
  "bg-rose-500/20 text-rose-300 border-rose-500/30",
  "bg-cyan-500/20 text-cyan-300 border-cyan-500/30",
];

function avatarClassForTicker(ticker: string): string {
  let sum = 0;
  for (let i = 0; i < ticker.length; i++) sum += ticker.charCodeAt(i);
  return AVATAR_PALETTE[sum % AVATAR_PALETTE.length]!;
}

function formatFloatChipLabel(min: number | null, max: number | null): string {
  const fmtBound = (v: number) => {
    if (v >= 1e9) return `${Number((v / 1e9).toFixed(2))}B`;
    if (v >= 1e6) return `${Number((v / 1e6).toFixed(1))}M`;
    if (v >= 1e3) return `${Number((v / 1e3).toFixed(0))}K`;
    return String(v);
  };
  if (min != null && max != null) return `${fmtBound(min)}–${fmtBound(max)}`;
  if (min != null) return `≥ ${fmtBound(min)}`;
  if (max != null) return `< ${fmtBound(max)}`;
  return "Float";
}

function formatChangeChipLabel(min: number | null, max: number | null): string {
  if (min != null && max != null) return `${min}% a ${max}%`;
  if (min != null) return `> ${min > 0 ? `+${min}` : min}%`;
  if (max != null) return `< ${max > 0 ? `+${max}` : max}%`;
  return "Cbo %";
}

function formatPriceChipLabel(min: number | null, max: number | null): string {
  if (min != null && max != null) return `$${min} – $${max}`;
  if (min != null) return `> $${min}`;
  if (max != null) return `< $${max}`;
  return "Precio";
}

function formatCapChipLabel(min: number | null, max: number | null): string {
  const fmtBound = (v: number) =>
    v >= 1e9 ? `${Number((v / 1e9).toFixed(2))} B` : `${Number((v / 1e6).toFixed(0))} M`;
  if (min != null && max != null) return `${fmtBound(min)} a ${fmtBound(max)} USD`;
  if (min != null) return `> ${fmtBound(min)} USD`;
  if (max != null) return `< ${fmtBound(max)} USD`;
  return "Cap. de mercado";
}

function pctColorClass(val: number | null | undefined): string {
  if (typeof val !== "number" || !Number.isFinite(val)) return "text-muted-foreground";
  if (val > 0) return "text-emerald-400";
  if (val < 0) return "text-rose-400";
  return "text-muted-foreground";
}

function parseOptionalNumber(raw: string): number | null {
  const cleaned = raw.trim().replace(",", ".");
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

export function StockScreenerTab({
  onOpenStockInChart,
  onBackToChart,
  activeSymbol,
}: StockScreenerTabProps) {
  const [filters, setFilters] = useState<ScreenerFilters>(() => ({ ...DEFAULT_SCREENER_FILTERS }));
  const [searchInput, setSearchInput] = useState("");
  const [openPopover, setOpenPopover] = useState<OpenPopover>(null);

  // Draft inputs inside popovers (matching Finviz URL defaults: sh_float_u20,ta_change_u10,sh_price_u20,sh_relvol_o5&ft=3)
  const [relVolMinInput, setRelVolMinInput] = useState("5");
  const [capMinMInput, setCapMinMInput] = useState("");
  const [capMaxMInput, setCapMaxMInput] = useState("");
  const [floatMinMInput, setFloatMinMInput] = useState("");
  const [floatMaxMInput, setFloatMaxMInput] = useState("20");
  const [chgMinInput, setChgMinInput] = useState("10");
  const [chgMaxInput, setChgMaxInput] = useState("");
  const [priceMinInput, setPriceMinInput] = useState("");
  const [priceMaxInput, setPriceMaxInput] = useState("20");

  // Screener dataset state
  const [items, setItems] = useState<ScreenerStock[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [fetchedAt, setFetchedAt] = useState<number | null>(null);
  const [finvizUrl, setFinvizUrl] = useState<string>(
    "https://finviz.com/screener/stocks?f=sh_float_u20%2Cta_change_u10%2Csh_price_u20%2Csh_relvol_o5&ft=3",
  );
  const [streamLive, setStreamLive] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Catalyst / News checker modal state
  const [newsModalStock, setNewsModalStock] = useState<ScreenerStock | null>(null);
  const [newsLoading, setNewsLoading] = useState(false);
  const [newsError, setNewsError] = useState<string | null>(null);
  const [newsItems, setNewsItems] = useState<StockNewsItem[]>([]);
  const newsAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => {
      newsAbortRef.current?.abort();
      newsAbortRef.current = null;
    };
  }, []);

  const closeCatalystModal = useCallback(() => {
    newsAbortRef.current?.abort();
    newsAbortRef.current = null;
    setNewsModalStock(null);
  }, []);

  const openCatalystModal = useCallback(async (e: React.MouseEvent, stock: ScreenerStock) => {
    e.preventDefault();
    e.stopPropagation();
    newsAbortRef.current?.abort();
    const ctrl = new AbortController();
    newsAbortRef.current = ctrl;
    setNewsModalStock(stock);
    setNewsItems([]);
    setNewsError(null);
    setNewsLoading(true);
    try {
      const res = await fetchStockNews(stock.ticker, ctrl.signal);
      if (ctrl.signal.aborted) return;
      setNewsItems(res.items);
    } catch (err) {
      if ((err as { name?: string })?.name === "AbortError" || ctrl.signal.aborted) return;
      setNewsError(err instanceof Error ? err.message : "No se pudieron cargar las noticias");
    } finally {
      if (!ctrl.signal.aborted) {
        setNewsLoading(false);
      }
    }
  }, []);

  // Favorites synced globally across StockScreenerTab, WatchlistPanel & ChartToolbar
  const { favorites, favoriteOrder, favoriteMeta, toggleFavorite } = useFavoriteSymbols();
  const [onlyFavorites, setOnlyFavorites] = useState(false);

  const stockFavoriteOrder = useMemo(
    () =>
      favoriteOrder.filter((ticker) => {
        const metaCat = favoriteMeta[ticker]?.category;
        if (metaCat) return metaCat.toUpperCase() === "STOCKS";
        const demoCat = getDemoSymbol(ticker)?.category;
        if (demoCat) return demoCat.toUpperCase() === "STOCKS";
        return true;
      }),
    [favoriteOrder, favoriteMeta],
  );

  const handleToggleFavorite = useCallback(
    (e: React.MouseEvent, stock: ScreenerStock) => {
      e.preventDefault();
      e.stopPropagation();
      toggleFavorite(stock.ticker, {
        name: normalizeFavoriteTicker(stock.ticker),
        displayName: stock.description || stock.ticker,
        category: "STOCKS",
        exchange: stock.exchange,
        initialPrice: stock.close,
        description: stock.description,
        country: stock.country,
        currency: stock.currency,
      });
    },
    [toggleFavorite],
  );

  // Debounce search text -> filters.search (skip triggering a duplicate call when equal)
  useEffect(() => {
    const trimmed = searchInput.trim();
    if (trimmed === filters.search) return;
    const id = setTimeout(() => {
      setFilters((prev) => (prev.search === trimmed ? prev : { ...prev, search: trimmed }));
    }, 280);
    return () => clearTimeout(id);
  }, [searchInput, filters.search]);

  const abortRef = useRef<AbortController | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  const loadPage = useCallback(
    async (offset = 0, limit = 500, append = false) => {
      if (abortRef.current) abortRef.current.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;

      if (append) setLoadingMore(true);
      else setLoading(true);
      setError(null);

      try {
        const res = await fetchStockScreener(filters, offset, limit, ctrl.signal);
        if (ctrl.signal.aborted) return;
        setTotalCount(res.totalCount);
        setFetchedAt(res.fetchedAt || Date.now());
        if (res.finvizUrl) setFinvizUrl(res.finvizUrl);
        setItems((prev) => {
          if (!append) return res.items;
          const seen = new Set(prev.map((x) => x.id || x.ticker));
          const merged = [...prev];
          for (const row of res.items) {
            const keyId = row.id || row.ticker;
            if (!seen.has(keyId)) {
              seen.add(keyId);
              merged.push(row);
            }
          }
          return merged;
        });
      } catch (err) {
        if ((err as { name?: string })?.name === "AbortError") return;
        setError(err instanceof Error ? err.message : "Error cargando el analizador de acciones");
      } finally {
        if (!ctrl.signal.aborted) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [filters],
  );

  // Automatic initial load + reload whenever filters change
  useEffect(() => {
    void loadPage(0, 500, false);
    return () => {
      abortRef.current?.abort();
    };
  }, [loadPage]);

  // Auto-refreshing Finviz screener SSE updates
  useEffect(() => {
    const unsub = subscribeStockScreenerStream(filters, {
      onData: (res) => {
        setTotalCount(res.totalCount);
        setFetchedAt(res.fetchedAt || Date.now());
        if (res.finvizUrl) setFinvizUrl(res.finvizUrl);
        setItems((prev) => {
          if (prev.length <= res.items.length) return res.items;
          const freshIds = new Set(res.items.map((r) => r.id || r.ticker));
          const merged = [...res.items];
          for (const oldRow of prev) {
            const key = oldRow.id || oldRow.ticker;
            if (!freshIds.has(key)) merged.push(oldRow);
          }
          return merged;
        });
        setLoading(false);
        setError(null);
      },
      onStatus: (live) => {
        setStreamLive(live);
      },
    });
    return unsub;
  }, [filters]);

  const openStockInCurrentMode = useCallback(
    (stock: ScreenerStock) => {
      onOpenStockInChart(stock);
    },
    [onOpenStockInChart],
  );

  // Keep draft inputs in sync whenever popover opens
  useEffect(() => {
    if (openPopover === "relVol") {
      setRelVolMinInput(filters.relVolMin != null ? String(filters.relVolMin) : "");
    } else if (openPopover === "marketCap") {
      setCapMinMInput(filters.marketCapMin != null ? String(filters.marketCapMin / 1e6) : "");
      setCapMaxMInput(filters.marketCapMax != null ? String(filters.marketCapMax / 1e6) : "");
    } else if (openPopover === "float") {
      setFloatMinMInput(filters.floatMin != null ? String(filters.floatMin / 1e6) : "");
      setFloatMaxMInput(filters.floatMax != null ? String(filters.floatMax / 1e6) : "");
    } else if (openPopover === "change") {
      setChgMinInput(filters.changeMin != null ? String(filters.changeMin) : "");
      setChgMaxInput(filters.changeMax != null ? String(filters.changeMax) : "");
    } else if (openPopover === "price") {
      setPriceMinInput(filters.priceMin != null ? String(filters.priceMin) : "");
      setPriceMaxInput(filters.priceMax != null ? String(filters.priceMax) : "");
    }
  }, [openPopover, filters]);

  const filterSig = JSON.stringify([
    filters.marketScope,
    filters.onlyPremarket,
    filters.relVolMin,
    filters.floatMin,
    filters.floatMax,
    filters.changeMin,
    filters.changeMax,
    filters.priceMin,
    filters.priceMax,
    filters.marketCapMin,
    filters.marketCapMax,
    filters.volumeMin,
    filters.sector,
  ]);
  const prevFilterSigRef = useRef(filterSig);
  useEffect(() => {
    if (prevFilterSigRef.current !== filterSig) {
      prevFilterSigRef.current = filterSig;
      setOnlyFavorites(false);
    }
  }, [filterSig]);

  useEffect(() => {
    if (scrollContainerRef.current) {
      scrollContainerRef.current.scrollTop = 0;
    }
  }, [filters, onlyFavorites]);

  const handleSort = useCallback((field: ScreenerSortField) => {
    setFilters((prev) => ({
      ...prev,
      sortBy: field,
      sortOrder: prev.sortBy === field && prev.sortOrder === "desc" ? "asc" : "desc",
    }));
  }, []);

  const handleResetDefaultFilters = useCallback(() => {
    setSearchInput("");
    setOpenPopover(null);
    setOnlyFavorites(false);
    setFilters({ ...DEFAULT_SCREENER_FILTERS });
  }, []);

  const handleShowAllStocks = useCallback(() => {
    setSearchInput("");
    setOpenPopover(null);
    setOnlyFavorites(false);
    setFilters((prev) => ({
      ...prev,
      marketCapMin: null,
      marketCapMax: null,
      floatMin: null,
      floatMax: null,
      changeMin: null,
      changeMax: null,
      priceMin: null,
      priceMax: null,
      volumeMin: null,
      relVolMin: null,
      sector: "",
      search: "",
      sortBy: "change",
      sortOrder: "desc",
    }));
  }, []);

  const columns = OVERVIEW_COLUMNS;

  const displayedItems = useMemo(() => {
    if (!onlyFavorites) return items;

    const byTicker = new Map<string, ScreenerStock>();
    for (const row of items) {
      byTicker.set(normalizeFavoriteTicker(row.ticker), row);
    }

    const q = searchInput.trim().toLowerCase();
    const out: ScreenerStock[] = [];
    for (const ticker of stockFavoriteOrder) {
      const existing = byTicker.get(ticker);
      let row: ScreenerStock;
      if (existing) {
        row = existing;
      } else {
        const meta = favoriteMeta[ticker];
        const demo = getDemoSymbol(ticker);
        row = {
          id: ticker,
          ticker,
          description: meta?.description || meta?.displayName || demo?.displayName || ticker,
          exchange: meta?.exchange || demo?.exchange || "US",
          close: meta?.initialPrice ?? demo?.initialPrice ?? 0,
          change: null,
          volume: null,
          relativeVolume: null,
          marketCap: null,
          priceToBook: null,
          epsDiluted: null,
          epsGrowthYoY: null,
          dividendYield: null,
          sector: "",
          perfW: null,
          perf1M: null,
          perf3M: null,
          perfYTD: null,
          perfY: null,
          rsi: null,
          recommendAll: null,
          floatShares: null,
          currency: meta?.currency || demo?.currency || "USD",
          country: meta?.country || demo?.country,
        };
      }

      if (q) {
        const matchTicker = row.ticker.toLowerCase().includes(q);
        const matchDesc = row.description.toLowerCase().includes(q);
        if (!matchTicker && !matchDesc) continue;
      }
      out.push(row);
    }
    return out;
  }, [onlyFavorites, items, stockFavoriteOrder, favoriteMeta, searchInput]);

  const rowVirtualizer = useVirtualizer({
    count: displayedItems.length,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
    initialRect: { width: 1200, height: 600 },
  });

  const virtualItems = rowVirtualizer.getVirtualItems();

  const hasRelVolFilter = filters.relVolMin != null;
  const hasMarketCapFilter = filters.marketCapMin != null || filters.marketCapMax != null;
  const hasVolumeFilter = filters.volumeMin != null;
  const hasFloatFilter = filters.floatMin != null || filters.floatMax != null;
  const hasChangeFilter = filters.changeMin != null || filters.changeMax != null;
  const hasPriceFilter = filters.priceMin != null || filters.priceMax != null;

  const renderStockRow = (stock: ScreenerStock, style?: React.CSSProperties) => {
    const isFav = favorites.has(normalizeFavoriteTicker(stock.ticker));
    const isActive = normalizeFavoriteTicker(activeSymbol ?? "") === normalizeFavoriteTicker(stock.ticker);
    const isSweetSpotPrice = stock.close >= 1 && stock.close <= 5;
    const isHighRelVol = stock.relativeVolume != null && stock.relativeVolume >= 5;

    return (
      <div
        key={stock.id || stock.ticker}
        style={style}
        onClick={() => openStockInCurrentMode(stock)}
        role="row"
        className={cn(
          "flex items-center px-3 border-b border-border/50 text-xs cursor-pointer transition-colors hover:bg-secondary/60 select-none min-w-[1222px]",
          isActive && "bg-primary/10 border-l-2 border-l-primary",
        )}
      >
        {/* Símbolo + Empresa */}
        <div className="w-[260px] shrink-0 flex items-center gap-2 pr-2 min-w-0">
          <button
            type="button"
            data-testid={`screener-fav-${stock.ticker}`}
            onClick={(e) => handleToggleFavorite(e, stock)}
            className={cn(
              "p-0.5 rounded hover:bg-secondary shrink-0",
              isFav ? "text-amber-400" : "text-muted-foreground/40 hover:text-amber-400",
            )}
            title={isFav ? "Quitar de favoritos" : "Añadir a favoritos"}
          >
            <Star className="h-3.5 w-3.5" fill={isFav ? "currentColor" : "none"} />
          </button>
          <span
            className={cn(
              "w-7 h-7 rounded-full border flex items-center justify-center text-xs font-bold shrink-0",
              avatarClassForTicker(stock.ticker),
            )}
          >
            {stock.ticker.slice(0, 2)}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <span className="font-mono font-bold text-foreground">{stock.ticker}</span>
              <span className="text-xs opacity-75 px-1.5 py-px rounded bg-secondary text-muted-foreground font-semibold">
                {stock.exchange}
              </span>
              {(stock.premarketVolume ?? 0) > 0 && (
                <span
                  className="text-[10px] leading-tight px-1 py-px rounded bg-amber-500/20 text-amber-300 border border-amber-500/35 font-bold"
                  title={[
                    `Vol. Pre-Market: ${formatVolume(stock.premarketVolume)}`,
                    stock.premarketChange != null
                      ? `Cbo Pre-Market: ${formatPercent(stock.premarketChange)}`
                      : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                >
                  PRE
                </span>
              )}
            </div>
            <div
              className="text-xs opacity-80 text-muted-foreground truncate"
              title={stock.country ? `${stock.description} · ${stock.country}` : stock.description}
            >
              {stock.description}
            </div>
          </div>
        </div>

        {/* Precio */}
        <div className="w-[160px] shrink-0 text-right font-mono font-semibold text-foreground pr-2 flex items-center justify-end gap-1.5">
          {isSweetSpotPrice && (
            <span
              className="text-[10px] leading-none px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/35 font-semibold whitespace-nowrap shrink-0"
              title="Zona óptima de precio ($1.00 – $5.00)"
            >
              $1-5
            </span>
          )}
          <span className="whitespace-nowrap tabular-nums">
            {formatPrice(stock.close)}{" "}
            <span className="text-xs opacity-75 font-normal text-muted-foreground">
              {stock.currency || "USD"}
            </span>
          </span>
        </div>

        {/* Cbo % */}
        <div
          className={cn(
            "w-[96px] shrink-0 text-right font-mono font-semibold pr-2",
            pctColorClass(stock.change),
          )}
        >
          {formatPercent(stock.change)}
        </div>

        <div
          className={cn(
            "w-[96px] shrink-0 text-right font-mono pr-2",
            isHighRelVol ? "text-emerald-400 font-bold" : "text-muted-foreground",
          )}
          title={isHighRelVol ? "Cumple Vol. relativo ≥ 5x" : undefined}
        >
          {stock.relativeVolume != null ? `${formatDecimal(stock.relativeVolume)}x` : "—"}
        </div>
        <div
          className={cn(
            "w-[100px] shrink-0 text-right font-mono pr-2",
            stock.floatShares != null &&
              stock.floatShares >= 800_000 &&
              stock.floatShares <= 20_000_000
              ? "text-sky-400 font-semibold"
              : "text-muted-foreground",
          )}
        >
          {formatVolume(stock.floatShares)}
        </div>
        <div className="w-[136px] shrink-0 pr-2">
          <button
            type="button"
            data-testid={`screener-news-${stock.ticker}`}
            onClick={(e) => void openCatalystModal(e, stock)}
            title={`Comprobar noticias / catalizador de ${stock.ticker}`}
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-secondary hover:bg-primary/20 hover:text-primary border border-border/80 text-[11px] font-semibold transition-colors"
          >
            <Newspaper className="h-3 w-3 shrink-0" />
            <span>Ver noticias</span>
          </button>
        </div>
        <div className="w-[92px] shrink-0 text-right font-mono text-foreground/90 pr-2">
          {formatVolume(stock.volume)}
        </div>
        <div className="w-[130px] shrink-0 text-right font-mono text-foreground/90 pr-2">
          {formatMarketCap(stock.marketCap)}
        </div>
        <div
          className="w-[165px] shrink-0 text-left text-xs opacity-80 text-muted-foreground truncate pr-2"
          title={translateSector(stock.sector)}
        >
          {translateSector(stock.sector)}
        </div>

      </div>
    );
  };

  return (
    <div className="flex flex-col flex-1 h-full min-h-0 bg-background text-foreground overflow-hidden relative">
      {/* Backdrop for filter popovers */}
      {openPopover && (
        <div className="fixed inset-0 z-30" onClick={() => setOpenPopover(null)} />
      )}

      {/* ── Header Bar ─────────────────────────────────────────── */}
      <div className="px-4 pt-3 pb-2 border-b border-border/70 bg-card/60 shrink-0 space-y-2.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2.5 flex-wrap">
            {onBackToChart && (
              <button
                type="button"
                onClick={onBackToChart}
                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-semibold bg-secondary hover:bg-secondary/80 text-foreground border border-border transition-colors"
                title="Volver al gráfico"
              >
                <ArrowLeft className="h-3.5 w-3.5" />
                <span>Gráfico</span>
                {activeSymbol && (
                  <span className="font-mono text-muted-foreground">{activeSymbol}</span>
                )}
              </button>
            )}
            <div className="flex items-center gap-2">
              <Filter className="h-4 w-4 text-primary" />
              <h1 className="text-base font-bold tracking-tight">Analizador de acciones</h1>
            </div>
          </div>

          <div className="flex items-center gap-1.5 flex-wrap">
            {fetchedAt && (
              <span className="text-xs opacity-75 text-muted-foreground font-mono mr-1 hidden md:inline">
                {new Date(fetchedAt).toLocaleTimeString("es-ES", {
                  hour: "2-digit",
                  minute: "2-digit",
                  second: "2-digit",
                })}
              </span>
            )}
            <a
              href={finvizUrl}
              target="_blank"
              rel="noopener noreferrer"
              className={cn(
                "inline-flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-semibold border transition-colors",
                streamLive
                  ? "bg-emerald-500/15 border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/25"
                  : "bg-secondary border-border text-foreground hover:bg-secondary/80",
              )}
              title="Abrir consulta actual en Finviz"
            >
              <span
                className={cn(
                  "h-1.5 w-1.5 rounded-full shrink-0",
                  streamLive ? "bg-emerald-400 animate-pulse" : "bg-sky-400",
                )}
              />
              <span>Finviz Screener</span>
              <ExternalLink className="h-3 w-3 opacity-75" />
            </a>
            <button
              type="button"
              onClick={() => void loadPage(0, Math.max(500, items.length || 500), false)}
              disabled={loading}
              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium bg-secondary hover:bg-secondary/80 text-foreground disabled:opacity-50"
            >
              <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
              <span>Actualizar</span>
            </button>
            <button
              type="button"
              onClick={handleResetDefaultFilters}
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded text-xs font-medium bg-secondary/70 hover:bg-secondary text-muted-foreground hover:text-foreground"
              title="Restablecer filtro Finviz (Float < 20M · Cbo % > +10% · Precio < $20 · Vol. rel > 5x)"
            >
              <RotateCcw className="h-3 w-3" />
              <span className="hidden sm:inline">Filtro base</span>
            </button>
          </div>
        </div>

        {/* ── Filter Pill Strip ─────────────────────────────────── */}
        <div className="flex flex-wrap items-center gap-2">
          {/* Search box */}
          <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-background border border-border focus-within:border-primary w-60 sm:w-64">
            <Search className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            <input
              type="text"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="Buscar ticker o empresa..."
              className="flex-1 bg-transparent text-xs outline-none text-foreground placeholder:text-muted-foreground"
            />
            {searchInput && (
              <button
                type="button"
                onClick={() => {
                  setSearchInput("");
                  setFilters((p) => ({ ...p, search: "" }));
                }}
                className="text-muted-foreground hover:text-foreground"
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </div>

          {/* Favorites only toggle chip */}
          <button
            type="button"
            data-testid="screener-favorites-toggle"
            onClick={() => setOnlyFavorites((v) => !v)}
            className={cn(
              "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-semibold border transition-colors",
              onlyFavorites
                ? "bg-amber-500/20 border-amber-500/50 text-amber-300"
                : "bg-secondary border-border text-foreground hover:bg-secondary/80",
            )}
            title="Ver tu lista de acciones favoritas"
          >
            <Star
              className="h-3.5 w-3.5 text-amber-400 shrink-0"
              fill={onlyFavorites || stockFavoriteOrder.length > 0 ? "currentColor" : "none"}
            />
            <span>Favoritas</span>
            {stockFavoriteOrder.length > 0 && (
              <span className="px-1 rounded bg-background/60 font-mono text-[11px]">
                {stockFavoriteOrder.length}
              </span>
            )}
          </button>

          {/* Relative Volume filter chip + popover (default >= 5x) */}
          <div className="relative z-40">
            <div
              className={cn(
                "inline-flex items-center rounded-md text-xs font-semibold border overflow-hidden",
                hasRelVolFilter
                  ? "bg-foreground text-background border-foreground"
                  : "bg-secondary/70 text-foreground border-border hover:bg-secondary",
              )}
            >
              <button
                type="button"
                data-testid="screener-relvol-chip"
                onClick={() => setOpenPopover((p) => (p === "relVol" ? null : "relVol"))}
                className="flex items-center gap-1 px-2.5 py-1"
              >
                <span>
                  {hasRelVolFilter ? `Vol. rel ≥ ${filters.relVolMin}x` : "Vol. rel"}
                </span>
                {!hasRelVolFilter && <ChevronDown className="h-3 w-3 opacity-70" />}
              </button>
              {hasRelVolFilter && (
                <button
                  type="button"
                  onClick={() => setFilters((p) => ({ ...p, relVolMin: null }))}
                  className="px-1.5 py-1 hover:opacity-70"
                  title="Quitar filtro de volumen relativo"
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </div>

            {openPopover === "relVol" && (
              <div className="absolute left-0 top-full mt-1.5 w-64 bg-card border border-border rounded-lg shadow-2xl p-3 space-y-2.5 z-50">
                <div className="text-xs font-bold text-foreground">Volumen relativo mínimo</div>
                <label className="block space-y-1 text-xs opacity-85 text-muted-foreground">
                  <span>Múltiplo sobre media (x)</span>
                  <input
                    type="number"
                    step="0.5"
                    value={relVolMinInput}
                    onChange={(e) => setRelVolMinInput(e.target.value)}
                    placeholder="5"
                    className="w-full px-2 py-1 rounded bg-background border border-border text-xs text-foreground"
                  />
                </label>
                <div className="flex flex-wrap gap-1">
                  {[
                    { label: "≥ 5x (Base)", val: 5 },
                    { label: "≥ 3x", val: 3 },
                    { label: "≥ 2x", val: 2 },
                    { label: "≥ 10x", val: 10 },
                    { label: "Sin límite", val: null },
                  ].map((opt) => (
                    <button
                      key={opt.label}
                      type="button"
                      onClick={() => {
                        setFilters((p) => ({ ...p, relVolMin: opt.val }));
                        setOpenPopover(null);
                      }}
                      className="px-2 py-0.5 rounded bg-secondary hover:bg-primary/20 hover:text-primary text-xs font-medium"
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
                <div className="flex justify-end gap-1.5 pt-1 border-t border-border/60">
                  <button
                    type="button"
                    onClick={() => setOpenPopover(null)}
                    className="px-2.5 py-1 rounded text-xs text-muted-foreground hover:bg-secondary"
                  >
                    Cancelar
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setFilters((p) => ({ ...p, relVolMin: parseOptionalNumber(relVolMinInput) }));
                      setOpenPopover(null);
                    }}
                    className="px-3 py-1 rounded text-xs font-semibold bg-primary text-primary-foreground"
                  >
                    Aplicar
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Cbo % filter chip + popover */}
          <div className="relative z-40">
            <div
              className={cn(
                "inline-flex items-center rounded-md text-xs font-semibold border overflow-hidden",
                hasChangeFilter
                  ? "bg-foreground text-background border-foreground"
                  : "bg-secondary/70 text-foreground border-border hover:bg-secondary",
              )}
            >
              <button
                type="button"
                onClick={() => setOpenPopover((p) => (p === "change" ? null : "change"))}
                className="flex items-center gap-1 px-2.5 py-1"
              >
                <span>
                  {hasChangeFilter
                    ? `Cbo % ${formatChangeChipLabel(filters.changeMin, filters.changeMax)}`
                    : "Cbo %"}
                </span>
                {!hasChangeFilter && <ChevronDown className="h-3 w-3 opacity-70" />}
              </button>
              {hasChangeFilter && (
                <button
                  type="button"
                  onClick={() => setFilters((p) => ({ ...p, changeMin: null, changeMax: null }))}
                  className="px-1.5 py-1 hover:opacity-70"
                  title="Quitar filtro de Cbo %"
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </div>

            {openPopover === "change" && (
              <div className="absolute left-0 top-full mt-1.5 w-68 bg-card border border-border rounded-lg shadow-2xl p-3 space-y-2.5 z-50">
                <div className="text-xs font-bold text-foreground">Cambio diario (Cbo %)</div>
                <div className="grid grid-cols-2 gap-2">
                  <label className="space-y-1 text-xs opacity-85 text-muted-foreground">
                    <span>Mínimo %</span>
                    <input
                      type="number"
                      value={chgMinInput}
                      onChange={(e) => setChgMinInput(e.target.value)}
                      placeholder="10"
                      className="w-full px-2 py-1 rounded bg-background border border-border text-xs text-foreground"
                    />
                  </label>
                  <label className="space-y-1 text-xs opacity-85 text-muted-foreground">
                    <span>Máximo %</span>
                    <input
                      type="number"
                      value={chgMaxInput}
                      onChange={(e) => setChgMaxInput(e.target.value)}
                      placeholder="Sin límite"
                      className="w-full px-2 py-1 rounded bg-background border border-border text-xs text-foreground"
                    />
                  </label>
                </div>
                <div className="flex flex-wrap gap-1">
                  {[
                    { label: "> +10%", min: 10, max: null },
                    { label: "> +5%", min: 5, max: null },
                    { label: "> +20%", min: 20, max: null },
                    { label: "< -10%", min: null, max: -10 },
                    { label: "Sin límite", min: null, max: null },
                  ].map((opt) => (
                    <button
                      key={opt.label}
                      type="button"
                      onClick={() => {
                        setFilters((p) => ({ ...p, changeMin: opt.min, changeMax: opt.max }));
                        setOpenPopover(null);
                      }}
                      className="px-2 py-0.5 rounded bg-secondary hover:bg-primary/20 hover:text-primary text-xs font-medium"
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
                <div className="flex justify-end gap-1.5 pt-1 border-t border-border/60">
                  <button
                    type="button"
                    onClick={() => setOpenPopover(null)}
                    className="px-2.5 py-1 rounded text-xs text-muted-foreground hover:bg-secondary"
                  >
                    Cancelar
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setFilters((p) => ({
                        ...p,
                        changeMin: parseOptionalNumber(chgMinInput),
                        changeMax: parseOptionalNumber(chgMaxInput),
                      }));
                      setOpenPopover(null);
                    }}
                    className="px-3 py-1 rounded text-xs font-semibold bg-primary text-primary-foreground"
                  >
                    Aplicar
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Float filter chip + popover (default sh_float_u20 -> < 20M) */}
          <div className="relative z-40">
            <div
              className={cn(
                "inline-flex items-center rounded-md text-xs font-semibold border overflow-hidden",
                hasFloatFilter
                  ? "bg-foreground text-background border-foreground"
                  : "bg-secondary/70 text-foreground border-border hover:bg-secondary",
              )}
            >
              <button
                type="button"
                onClick={() => setOpenPopover((p) => (p === "float" ? null : "float"))}
                className="flex items-center gap-1 px-2.5 py-1"
                title="Filtrar por Free Float en Finviz (sh_float_u20)"
              >
                <span>
                  {hasFloatFilter
                    ? `Float ${formatFloatChipLabel(filters.floatMin, filters.floatMax)}`
                    : "Float"}
                </span>
                {!hasFloatFilter && <ChevronDown className="h-3 w-3 opacity-70" />}
              </button>
              {hasFloatFilter && (
                <button
                  type="button"
                  onClick={() => setFilters((p) => ({ ...p, floatMin: null, floatMax: null }))}
                  className="px-1.5 py-1 hover:opacity-70"
                  title="Quitar filtro de Float"
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </div>

            {openPopover === "float" && (
              <div className="absolute left-0 top-full mt-1.5 w-72 bg-card border border-border rounded-lg shadow-2xl p-3 space-y-2.5 z-50">
                <div className="text-xs font-bold text-foreground">
                  Float (acciones disponibles, en M)
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <label className="space-y-1 text-xs opacity-85 text-muted-foreground">
                    <span>Mínimo (M)</span>
                    <input
                      type="number"
                      value={floatMinMInput}
                      onChange={(e) => setFloatMinMInput(e.target.value)}
                      placeholder="Sin límite"
                      className="w-full px-2 py-1 rounded bg-background border border-border text-xs text-foreground"
                    />
                  </label>
                  <label className="space-y-1 text-xs opacity-85 text-muted-foreground">
                    <span>Máximo (M)</span>
                    <input
                      type="number"
                      value={floatMaxMInput}
                      onChange={(e) => setFloatMaxMInput(e.target.value)}
                      placeholder="20"
                      className="w-full px-2 py-1 rounded bg-background border border-border text-xs text-foreground"
                    />
                  </label>
                </div>
                <div className="flex flex-wrap gap-1">
                  {[
                    { label: "< 20M (Base)", min: null, max: 20_000_000 },
                    { label: "< 10M", min: null, max: 10_000_000 },
                    { label: "< 5M", min: null, max: 5_000_000 },
                    { label: "< 50M", min: null, max: 50_000_000 },
                    { label: "Sin límite", min: null, max: null },
                  ].map((opt) => (
                    <button
                      key={opt.label}
                      type="button"
                      onClick={() => {
                        setFilters((p) => ({ ...p, floatMin: opt.min, floatMax: opt.max }));
                        setOpenPopover(null);
                      }}
                      className="px-2 py-0.5 rounded bg-secondary hover:bg-primary/20 hover:text-primary text-xs font-medium"
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
                <div className="flex justify-end gap-1.5 pt-1 border-t border-border/60">
                  <button
                    type="button"
                    onClick={() => setOpenPopover(null)}
                    className="px-2.5 py-1 rounded text-xs text-muted-foreground hover:bg-secondary"
                  >
                    Cancelar
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      const minM = parseOptionalNumber(floatMinMInput);
                      const maxM = parseOptionalNumber(floatMaxMInput);
                      setFilters((p) => ({
                        ...p,
                        floatMin: minM != null ? minM * 1e6 : null,
                        floatMax: maxM != null ? maxM * 1e6 : null,
                      }));
                      setOpenPopover(null);
                    }}
                    className="px-3 py-1 rounded text-xs font-semibold bg-primary text-primary-foreground"
                  >
                    Aplicar
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Precio chip + popover (default sh_price_u20 -> < $20) */}
          <div className="relative z-40">
            <div
              className={cn(
                "inline-flex items-center rounded-md text-xs font-semibold border overflow-hidden",
                hasPriceFilter
                  ? "bg-foreground text-background border-foreground"
                  : "bg-secondary/70 text-foreground border-border hover:bg-secondary",
              )}
            >
              <button
                type="button"
                onClick={() => setOpenPopover((p) => (p === "price" ? null : "price"))}
                className="flex items-center gap-1 px-2.5 py-1"
              >
                <span>
                  {hasPriceFilter
                    ? `Precio ${formatPriceChipLabel(filters.priceMin, filters.priceMax)}`
                    : "Precio"}
                </span>
                {!hasPriceFilter && <ChevronDown className="h-3 w-3 opacity-70" />}
              </button>
              {hasPriceFilter && (
                <button
                  type="button"
                  onClick={() => setFilters((p) => ({ ...p, priceMin: null, priceMax: null }))}
                  className="px-1.5 py-1 hover:opacity-70"
                  title="Quitar filtro de precio"
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </div>

            {openPopover === "price" && (
              <div className="absolute left-0 top-full mt-1.5 w-68 bg-card border border-border rounded-lg shadow-2xl p-3 space-y-2.5 z-50">
                <div className="text-xs font-bold text-foreground">Rango de precio (USD)</div>
                <div className="grid grid-cols-2 gap-2">
                  <label className="space-y-1 text-xs opacity-85 text-muted-foreground">
                    <span>Mín. ($)</span>
                    <input
                      type="number"
                      value={priceMinInput}
                      onChange={(e) => setPriceMinInput(e.target.value)}
                      placeholder="Sin límite"
                      className="w-full px-2 py-1 rounded bg-background border border-border text-xs text-foreground"
                    />
                  </label>
                  <label className="space-y-1 text-xs opacity-85 text-muted-foreground">
                    <span>Máx. ($)</span>
                    <input
                      type="number"
                      value={priceMaxInput}
                      onChange={(e) => setPriceMaxInput(e.target.value)}
                      placeholder="20"
                      className="w-full px-2 py-1 rounded bg-background border border-border text-xs text-foreground"
                    />
                  </label>
                </div>
                <div className="flex flex-wrap gap-1">
                  {[
                    { label: "< $20 (Base)", min: null, max: 20 },
                    { label: "$1 – $20", min: 1, max: 20 },
                    { label: "$1 – $5", min: 1, max: 5 },
                    { label: "< $10", min: null, max: 10 },
                    { label: "Sin límite", min: null, max: null },
                  ].map((opt) => (
                    <button
                      key={opt.label}
                      type="button"
                      onClick={() => {
                        setFilters((p) => ({ ...p, priceMin: opt.min, priceMax: opt.max }));
                        setOpenPopover(null);
                      }}
                      className="px-2 py-0.5 rounded bg-secondary hover:bg-primary/20 hover:text-primary text-xs font-medium"
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
                <div className="flex justify-end gap-1.5 pt-1 border-t border-border/60">
                  <button
                    type="button"
                    onClick={() => setOpenPopover(null)}
                    className="px-2.5 py-1 rounded text-xs text-muted-foreground hover:bg-secondary"
                  >
                    Cancelar
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setFilters((p) => ({
                        ...p,
                        priceMin: parseOptionalNumber(priceMinInput),
                        priceMax: parseOptionalNumber(priceMaxInput),
                      }));
                      setOpenPopover(null);
                    }}
                    className="px-3 py-1 rounded text-xs font-semibold bg-primary text-primary-foreground"
                  >
                    Aplicar
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Optional extra Market Cap filter chip (inactive by default) */}
          <div className="relative z-40">
            <div
              className={cn(
                "inline-flex items-center rounded-md text-xs font-semibold border overflow-hidden",
                hasMarketCapFilter
                  ? "bg-foreground text-background border-foreground"
                  : "bg-secondary/70 text-foreground border-border hover:bg-secondary",
              )}
            >
              <button
                type="button"
                data-testid="screener-marketcap-chip"
                onClick={() => setOpenPopover((p) => (p === "marketCap" ? null : "marketCap"))}
                className="flex items-center gap-1 px-2.5 py-1"
                title="Filtro opcional de capitalización (desactivado por defecto)"
              >
                <span>
                  {hasMarketCapFilter
                    ? `Cap. de mercado ${formatCapChipLabel(filters.marketCapMin, filters.marketCapMax)}`
                    : "Cap. de mercado"}
                </span>
                {!hasMarketCapFilter && <ChevronDown className="h-3 w-3 opacity-70" />}
              </button>
              {hasMarketCapFilter && (
                <button
                  type="button"
                  onClick={() =>
                    setFilters((p) => ({ ...p, marketCapMin: null, marketCapMax: null }))
                  }
                  className="px-1.5 py-1 hover:opacity-70"
                  title="Quitar filtro de capitalización"
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </div>

            {openPopover === "marketCap" && (
              <div className="absolute left-0 top-full mt-1.5 w-72 bg-card border border-border rounded-lg shadow-2xl p-3 space-y-2.5 z-50">
                <div className="text-xs font-bold text-foreground">
                  Capitalización de mercado (opcional · M USD)
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <label className="space-y-1 text-xs opacity-85 text-muted-foreground">
                    <span>Mínimo (M USD)</span>
                    <input
                      type="number"
                      value={capMinMInput}
                      onChange={(e) => setCapMinMInput(e.target.value)}
                      placeholder="Sin filtro"
                      className="w-full px-2 py-1 rounded bg-background border border-border text-xs text-foreground"
                    />
                  </label>
                  <label className="space-y-1 text-xs opacity-85 text-muted-foreground">
                    <span>Máximo (M USD)</span>
                    <input
                      type="number"
                      value={capMaxMInput}
                      onChange={(e) => setCapMaxMInput(e.target.value)}
                      placeholder="Sin filtro"
                      className="w-full px-2 py-1 rounded bg-background border border-border text-xs text-foreground"
                    />
                  </label>
                </div>
                <div className="flex flex-wrap gap-1">
                  {[
                    { label: "50M – 300M", min: 50_000_000, max: 300_000_000 },
                    { label: "300M – 2B", min: 300_000_000, max: 2_000_000_000 },
                    { label: "2B – 10B", min: 2_000_000_000, max: 10_000_000_000 },
                    { label: "> 10B", min: 10_000_000_000, max: null },
                    { label: "Sin límite", min: null, max: null },
                  ].map((opt) => (
                    <button
                      key={opt.label}
                      type="button"
                      onClick={() => {
                        setFilters((p) => ({ ...p, marketCapMin: opt.min, marketCapMax: opt.max }));
                        setOpenPopover(null);
                      }}
                      className="px-2 py-0.5 rounded bg-secondary hover:bg-primary/20 hover:text-primary text-xs font-medium"
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
                <div className="flex justify-end gap-1.5 pt-1 border-t border-border/60">
                  <button
                    type="button"
                    onClick={() => setOpenPopover(null)}
                    className="px-2.5 py-1 rounded text-xs text-muted-foreground hover:bg-secondary"
                  >
                    Cancelar
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      const minM = parseOptionalNumber(capMinMInput);
                      const maxM = parseOptionalNumber(capMaxMInput);
                      setFilters((p) => ({
                        ...p,
                        marketCapMin: minM != null ? minM * 1e6 : null,
                        marketCapMax: maxM != null ? maxM * 1e6 : null,
                      }));
                      setOpenPopover(null);
                    }}
                    className="px-3 py-1 rounded text-xs font-semibold bg-primary text-primary-foreground"
                  >
                    Aplicar
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Optional extra Volume filter chip (inactive by default) */}
          <div className="relative z-40">
            <div
              className={cn(
                "inline-flex items-center rounded-md text-xs font-semibold border overflow-hidden",
                hasVolumeFilter
                  ? "bg-foreground text-background border-foreground"
                  : "bg-secondary/70 text-foreground border-border hover:bg-secondary",
              )}
            >
              <button
                type="button"
                data-testid="screener-volume-chip"
                onClick={() => setOpenPopover((p) => (p === "volume" ? null : "volume"))}
                className="flex items-center gap-1 px-2.5 py-1"
                title="Filtro opcional de volumen mínimo (desactivado por defecto)"
              >
                <span>
                  {filters.volumeMin != null
                    ? `Vol > ${formatVolume(filters.volumeMin)}`
                    : "Volumen"}
                </span>
                {!hasVolumeFilter && <ChevronDown className="h-3 w-3 opacity-70" />}
              </button>
              {hasVolumeFilter && (
                <button
                  type="button"
                  onClick={() => setFilters((p) => ({ ...p, volumeMin: null }))}
                  className="px-1.5 py-1 hover:opacity-70"
                  title="Quitar filtro de volumen"
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </div>

            {openPopover === "volume" && (
              <div className="absolute left-0 top-full mt-1.5 w-60 bg-card border border-border rounded-lg shadow-2xl p-2 space-y-1 z-50">
                <div className="px-2 py-1 text-xs font-bold text-muted-foreground uppercase">
                  Filtro opcional de volumen
                </div>
                {[
                  { label: "Volumen > 500K", vol: 500_000 },
                  { label: "Volumen > 1M", vol: 1_000_000 },
                  { label: "Volumen > 5M", vol: 5_000_000 },
                  { label: "Volumen > 10M", vol: 10_000_000 },
                  { label: "Sin filtro (por defecto)", vol: null },
                ].map((opt) => (
                  <button
                    key={opt.label}
                    type="button"
                    onClick={() => {
                      setFilters((p) => ({ ...p, volumeMin: opt.vol }));
                      setOpenPopover(null);
                    }}
                    className="w-full text-left px-2.5 py-1.5 rounded text-xs hover:bg-secondary"
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Sector select */}
          <select
            value={filters.sector}
            onChange={(e) => setFilters((p) => ({ ...p, sector: e.target.value }))}
            className={cn(
              "px-2.5 py-1 rounded-md text-xs font-semibold border outline-none cursor-pointer",
              filters.sector
                ? "bg-primary/20 text-primary border-primary/40"
                : "bg-secondary/70 text-foreground border-border",
            )}
            title="Filtrar por sector"
          >
            {SCREENER_SECTORS.map((sec) => (
              <option key={sec.value || "__all"} value={sec.value} className="bg-card text-foreground">
                {sec.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* ── Favorites Mode Notice ────────────────────────────────── */}
      {onlyFavorites && (
        <div
          data-testid="screener-favorites-banner"
          className="mx-4 mt-3 px-3 py-2 rounded-md bg-amber-500/15 border border-amber-500/40 text-xs text-amber-200 flex items-center justify-between gap-2"
        >
          <span>
            Mostrando solo tus favoritas ({displayedItems.length.toLocaleString("es-ES")}). Hay{" "}
            {totalCount.toLocaleString("es-ES")} acciones en el escáner.
          </span>
          <button
            type="button"
            onClick={() => setOnlyFavorites(false)}
            className="px-2.5 py-1 rounded bg-amber-500/25 hover:bg-amber-500/35 text-amber-100 font-semibold shrink-0"
          >
            Ver todas las del escáner
          </button>
        </div>
      )}

      {/* ── Error Banner ─────────────────────────────────────────── */}
      {error && (
        <div className="mx-4 mt-3 px-3 py-2 rounded-md bg-rose-500/15 border border-rose-500/40 text-xs text-rose-300 flex items-center justify-between gap-2">
          <span>No se pudo consultar el mercado en tiempo real: {error}</span>
          <button
            type="button"
            onClick={() => void loadPage(0, 500, false)}
            className="px-2.5 py-1 rounded bg-rose-500/20 hover:bg-rose-500/30 text-rose-200 font-semibold shrink-0"
          >
            Reintentar
          </button>
        </div>
      )}

      {/* ── Virtualized Table Area ───────────────────────────────── */}
      <div
        ref={scrollContainerRef}
        className="flex-1 min-h-0 overflow-auto relative"
      >
        {/* Sticky Table Header */}
        <div className="sticky top-0 z-20 flex items-center px-3 h-10 border-b border-border bg-card/95 backdrop-blur-sm text-xs font-semibold text-muted-foreground min-w-[1222px]">
          {columns.map((col) => {
            const isSorted = col.sortField != null && filters.sortBy === col.sortField;
            return (
              <div
                key={col.id}
                className={cn(
                  col.widthClass,
                  col.align === "right" ? "text-right pr-2" : "text-left pr-2",
                )}
              >
                {col.sortField ? (
                  <button
                    type="button"
                    onClick={() => handleSort(col.sortField!)}
                    className={cn(
                      "inline-flex items-center gap-1 hover:text-foreground transition-colors",
                      col.align === "right" && "flex-row-reverse",
                      isSorted && "text-primary font-bold",
                    )}
                  >
                    <span>{col.label}</span>
                    {isSorted ? (
                      filters.sortOrder === "desc" ? (
                        <ArrowDown className="h-3 w-3 shrink-0" />
                      ) : (
                        <ArrowUp className="h-3 w-3 shrink-0" />
                      )
                    ) : (
                      <ArrowUpDown className="h-3 w-3 opacity-35 shrink-0" />
                    )}
                  </button>
                ) : (
                  <span>{col.label}</span>
                )}
              </div>
            );
          })}
        </div>

        {/* Loading state */}
        {loading && !onlyFavorites && displayedItems.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 gap-2.5 text-muted-foreground">
            <Loader2 className="h-6 w-6 animate-spin text-primary" />
            <span className="text-xs">Escaneando acciones en Finviz…</span>
          </div>
        ) : displayedItems.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 gap-3 text-center px-4">
            <div className="text-sm font-semibold text-foreground">
              {onlyFavorites
                ? "Todavía no tienes acciones en Favoritas"
                : "Ninguna acción cumple los filtros actuales en este momento"}
            </div>
            <p className="text-xs text-muted-foreground max-w-md">
              {onlyFavorites
                ? "Haz clic en la estrella ★ junto a cualquier acción (o arriba en el gráfico) para añadirla a tu lista."
                : "Puedes ajustar los filtros o restablecer el filtro base de Finviz."}
            </p>
            <div className="flex items-center gap-2">
              {onlyFavorites ? (
                <button
                  type="button"
                  onClick={() => setOnlyFavorites(false)}
                  className="px-3 py-1.5 rounded-md bg-primary text-primary-foreground text-xs font-semibold"
                >
                  Volver a todas las acciones
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={handleShowAllStocks}
                    className="px-3 py-1.5 rounded-md bg-primary text-primary-foreground text-xs font-semibold"
                  >
                    Ver todas las acciones
                  </button>
                  <button
                    type="button"
                    onClick={handleResetDefaultFilters}
                    className="px-3 py-1.5 rounded-md bg-secondary hover:bg-secondary/80 text-xs font-semibold"
                  >
                    Restablecer Float &lt; 20M · Cbo &gt; +10% · Precio &lt; $20 · Vol. rel ≥ 5x
                  </button>
                </>
              )}
            </div>
          </div>
        ) : virtualItems.length > 0 ? (
          <div
            style={{ height: `${rowVirtualizer.getTotalSize()}px`, position: "relative" }}
            className="min-w-[1222px]"
          >
            {virtualItems.map((vRow) => {
              const stock = displayedItems[vRow.index];
              if (!stock) return null;
              return renderStockRow(stock, {
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                height: `${vRow.size}px`,
                transform: `translateY(${vRow.start}px)`,
              });
            })}
          </div>
        ) : (
          <div className="min-w-[1222px]">
            {displayedItems.slice(0, 50).map((stock) =>
              renderStockRow(stock, { height: `${ROW_HEIGHT}px` }),
            )}
          </div>
        )}
      </div>

      {/* ── Footer Pagination Bar ────────────────────────────────── */}
      <div className="px-4 py-2 border-t border-border bg-card/80 flex flex-wrap items-center justify-between gap-2 text-xs shrink-0">
        <div className="text-muted-foreground">
          {onlyFavorites ? (
            <>
              Mostrando{" "}
              <span className="font-mono font-semibold text-foreground">
                {displayedItems.length.toLocaleString("es-ES")}
              </span>{" "}
              acciones favoritas
            </>
          ) : (
            <>
              Mostrando{" "}
              <span className="font-mono font-semibold text-foreground">
                {items.length.toLocaleString("es-ES")}
              </span>{" "}
              de{" "}
              <span className="font-mono font-semibold text-foreground">
                {totalCount.toLocaleString("es-ES")}
              </span>{" "}
              acciones en Finviz (NYSE · NASDAQ · AMEX)
            </>
          )}
        </div>

        <div className="flex items-center gap-2">
          {!onlyFavorites && items.length < totalCount && (
            <>
              <button
                type="button"
                disabled={loadingMore || loading}
                onClick={() => void loadPage(items.length, 500, true)}
                className="inline-flex items-center gap-1.5 px-3 py-1 rounded bg-primary/15 hover:bg-primary/25 text-primary font-semibold disabled:opacity-50"
              >
                {loadingMore && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                <span>
                  Cargar +{Math.min(80, totalCount - items.length).toLocaleString("es-ES")} acciones
                </span>
              </button>
            </>
          )}
        </div>
      </div>

      {/* Catalyst / News Checker Modal */}
      {newsModalStock && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          onClick={closeCatalystModal}
        >
          <div
            className="w-full max-w-lg rounded-xl border border-border bg-card shadow-2xl overflow-hidden flex flex-col max-h-[80vh]"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-secondary/40">
              <div className="min-w-0 pr-3">
                <div className="flex items-center gap-2">
                  <Newspaper className="h-4 w-4 text-primary shrink-0" />
                  <span className="font-mono font-bold text-sm">{newsModalStock.ticker}</span>
                  <span className="text-xs px-1.5 py-0.5 rounded bg-secondary text-muted-foreground font-semibold">
                    {newsModalStock.exchange}
                  </span>
                  <span className={cn("text-xs font-mono font-semibold", pctColorClass(newsModalStock.change))}>
                    {formatPercent(newsModalStock.change)}
                  </span>
                </div>
                <div className="text-xs text-muted-foreground truncate mt-0.5">
                  Noticias y catalizadores recientes · {newsModalStock.description}
                </div>
              </div>
              <button
                type="button"
                onClick={closeCatalystModal}
                className="p-1 rounded hover:bg-secondary text-muted-foreground hover:text-foreground shrink-0"
                title="Cerrar"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-4 space-y-2.5">
              {newsLoading ? (
                <div className="flex items-center justify-center py-10 gap-2 text-xs text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin text-primary" />
                  <span>Buscando catalizadores de {newsModalStock.ticker}…</span>
                </div>
              ) : newsError ? (
                <div className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2.5 text-xs text-rose-300">
                  Error al consultar noticias: {newsError}
                </div>
              ) : newsItems.length === 0 ? (
                <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-3 text-xs text-amber-200 flex items-start gap-2.5">
                  <AlertTriangle className="h-4 w-4 text-amber-400 shrink-0 mt-0.5" />
                  <div>
                    <div className="font-semibold">Sin noticias recientes encontradas</div>
                    <p className="text-amber-200/80 mt-0.5">
                      Precaución: confirma si existe un catalizador real (resultados, FDA, contrato o compra) para evitar subidas sin fundamento.
                    </p>
                  </div>
                </div>
              ) : (
                newsItems.map((item, idx) => {
                  const href =
                    item.link && item.link.trim().length > 0
                      ? item.link
                      : `https://finviz.com/quote.ashx?t=${encodeURIComponent(newsModalStock.ticker.replace(/\./g, "-"))}`;
                  return (
                  <a
                    key={`${href}-${idx}`}
                    href={href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block rounded-lg border border-border/70 bg-background/60 hover:bg-secondary/60 px-3 py-2.5 transition-colors group"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="space-y-1 min-w-0">
                        <div className="flex flex-wrap items-center gap-1.5">
                          {item.catalystTag && (
                            <span
                              className={cn(
                                "text-[10px] font-bold px-1.5 py-0.5 rounded border",
                                item.catalystTag === "Dilución / R.Split"
                                  ? "bg-rose-500/20 text-rose-300 border-rose-500/40"
                                  : "bg-emerald-500/20 text-emerald-300 border-emerald-500/40",
                              )}
                            >
                              {item.catalystTag}
                            </span>
                          )}
                          <span className="text-[11px] font-semibold text-muted-foreground">
                            {item.publisher}
                          </span>
                          {item.publishedAt && (
                            <span className="text-[11px] text-muted-foreground/80 font-mono">
                              ·{" "}
                              {new Date(item.publishedAt).toLocaleString("es-ES", {
                                day: "2-digit",
                                month: "short",
                                hour: "2-digit",
                                minute: "2-digit",
                              })}
                            </span>
                          )}
                        </div>
                        <div className="text-xs font-semibold text-foreground group-hover:text-primary leading-snug">
                          {item.title}
                        </div>
                      </div>
                      <ExternalLink className="h-3.5 w-3.5 text-muted-foreground group-hover:text-primary shrink-0 mt-0.5" />
                    </div>
                  </a>
                  );
                })
              )}
            </div>

            <div className="px-4 py-2.5 border-t border-border bg-secondary/20 flex items-center justify-between gap-2">
              <span className="text-[11px] text-muted-foreground">
                Filtro recomendado: resultados, alianza, FDA o compra
              </span>
              <button
                type="button"
                onClick={() => {
                  const s = newsModalStock;
                  setNewsModalStock(null);
                  openStockInCurrentMode(s);
                }}
                className="px-3 py-1 rounded-md bg-primary text-primary-foreground text-xs font-semibold hover:opacity-90 shrink-0"
              >
                Abrir en gráfico
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
