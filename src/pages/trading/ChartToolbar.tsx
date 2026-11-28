import {
  ArrowUpDown,
  BarChart3,
  Bot,
  ChevronDown,
  Clock,
  Filter,
  Layers,
  LayoutGrid,
  Loader2,
  type LucideIcon,
  Maximize2,
  Newspaper,
  Search,
  Settings2,
  Star,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { IbkrConfigModal } from "../../components/IbkrConfigModal.tsx";
import { INDICATOR_REGISTRY, type IndicatorType } from "../../lib/indicators.ts";
import { isValidTimeframe, normalizeTimeframeLabel } from "../../lib/timeframes.ts";
import { cn, formatNumber } from "../../lib/utils.ts";
import {
  type IbkrConfigStatus,
  getIbkrConfigStatus,
  subscribeIbkrConfigChanged,
} from "../../services/ibkrConfig.ts";
import {
  getIbkrEffectiveMarketDataType,
  isIbkrLiveStreamConnected,
  subscribeIbkrStreamStatus,
} from "../../services/ibkrStream.ts";
import {
  DEMO_SYMBOLS,
  discoverRemoteCrypto,
  discoverRemoteStocks,
  getDemoSymbol,
  registerDynamicSymbol,
  searchDemoSymbols,
  type DemoSymbol,
} from "../../services/demo/instruments.ts";
import {
  type DrawingLine,
  type DrawingTool,
  type MagnetMode,
  REPLAY_ENABLED,
  TIMEFRAMES,
  type Timeframe,
} from "./constants.ts";
import { getPipDigits } from "./utils.ts";
import {
  ChartTemplatesMenu,
  type MultiChartTemplateApplyPayload,
  type MultiChartTemplateState,
} from "./ChartTemplatesMenu.tsx";
import {
  type ConfigurableIndicatorKind,
  IndicatorSettingsModal,
} from "./IndicatorSettingsModal.tsx";
import type { ChartLayout } from "./MultiChartPane.tsx";
import { ReplayHUD } from "./ReplayHUD.tsx";
import { isLiveFeedHealthy } from "../../services/demo/feed.ts";
import { useReplayStore } from "../../services/demo/replay.ts";
import { useChartPreferences, updateChartPreferences } from "../../hooks/useChartPreferences.ts";
import {
  buildFavoriteDemoSymbol,
  normalizeFavoriteTicker,
  useFavoriteSymbols,
} from "../../hooks/useFavoriteSymbols.ts";
import { useIndicatorSettings } from "../../hooks/useIndicatorSettings.ts";

export interface ChartToolbarProps {
  selectedSymbol: string;
  symbols: Array<{
    id?: string;
    name: string;
    displayName?: string | null;
    assetClass?: string;
    baseCurrency?: string;
    quoteCurrency?: string;
    category?: string;
    isActive?: boolean;
  }>;
  onSymbolChange: (s: string) => void;
  timeframe: Timeframe;
  onTimeframeChange: (tf: Timeframe) => void;
  activeIndicators: IndicatorType[];
  onToggleIndicator: (type: IndicatorType) => void;
  showIndicatorMenu: boolean;
  onToggleIndicatorMenu: () => void;
  drawingTool?: DrawingTool;
  onDrawingTool?: (t: DrawingTool) => void;
  drawings?: DrawingLine[];
  onClearDrawings?: () => void;
  rightPanel: string;
  onRightPanel: (p: "order" | "dom" | "watchlist" | "news" | "ai-trader" | "tv-analysis") => void;
  aiTraderEnabled?: boolean;
  showRightPanel: boolean;
  onToggleRightPanel: () => void;
  tick?: { bid: number; ask: number; timestamp: number };
  symbolInfo?: {
    tickSize?: number;
    pipSize?: number;
    lotSize?: number;
    minLot?: number;
    maxLot?: number;
    lotStep?: number;
    contractSize?: number;
    marginPercent?: number;
    commission?: number;
  };
  isReplaying?: boolean;
  /** Effective step timeframe for Bar Replay (finest active timeframe in split-chart layouts). */
  replayTimeframe?: Timeframe;
  /** Additional active timeframes across split-chart panes to preload when Replay starts. */
  replayAdditionalTimeframes?: readonly string[];
  /** Secondary symbols in split-chart panes to preload when Replay starts. */
  replaySecondarySymbols?: ReadonlyArray<{ symbol: string; timeframe: string }>;
  /** Account whose sessions can be replayed — mounts the replay HUD when set. */
  replayAccountId?: string | null;
  activePlugins?: string[];
  onTogglePlugin?: (id: string) => void;
  /** Replace the full indicator list (template load). Enables the templates menu. */
  onSetIndicators?: (indicators: IndicatorType[]) => void;
  /** Replace the full plugin list (template load). Enables the templates menu. */
  onSetPlugins?: (ids: string[]) => void;
  magnetMode?: MagnetMode;
  onCycleMagnet?: () => void;
  stayInDrawingMode?: boolean;
  onToggleStayInDrawingMode?: () => void;
  floatingOrderOpen?: boolean;
  onToggleFloatingOrder?: () => void;
  chartLayout?: ChartLayout;
  onChartLayoutChange?: (layout: ChartLayout) => void;
  syncPrice2x1?: boolean;
  canSyncPrice2x1?: boolean;
  onToggleSyncPrice2x1?: () => void;
  focusedShowVolume?: boolean;
  onToggleVolume?: () => void;
  multiChartTemplateState?: MultiChartTemplateState;
  onApplyMultiChartTemplate?: (payload: MultiChartTemplateApplyPayload) => void;
  showMtfPanel?: boolean;
  onToggleMtfPanel?: () => void;
  showScreener?: boolean;
  onToggleScreener?: () => void;
}

export function ChartToolbar({
  selectedSymbol,
  symbols,
  onSymbolChange,
  timeframe,
  onTimeframeChange,
  activeIndicators,
  onToggleIndicator,
  showIndicatorMenu,
  onToggleIndicatorMenu,
  rightPanel,
  onRightPanel,
  showRightPanel,
  onToggleRightPanel,
  tick,
  symbolInfo,
  aiTraderEnabled,
  isReplaying: _isReplaying = false,
  replayTimeframe,
  replayAdditionalTimeframes,
  replaySecondarySymbols,
  replayAccountId,
  activePlugins = [],
  onSetIndicators,
  onSetPlugins,
  floatingOrderOpen = false,
  onToggleFloatingOrder,
  chartLayout = "1",
  onChartLayoutChange,
  syncPrice2x1 = false,
  canSyncPrice2x1 = true,
  onToggleSyncPrice2x1,
  focusedShowVolume,
  onToggleVolume,
  multiChartTemplateState,
  onApplyMultiChartTemplate,
  showMtfPanel: _showMtfPanel = false,
  onToggleMtfPanel: _onToggleMtfPanel,
  showScreener = false,
  onToggleScreener,
}: ChartToolbarProps) {
  const [showSymbolSearch, setShowSymbolSearch] = useState(false);
  const [symbolFilter, setSymbolFilter] = useState("");
  const [searchCat, setSearchCat] = useState<string>("ALL");
  const [remoteAltcoins, setRemoteAltcoins] = useState<DemoSymbol[]>([]);
  const [searchingRemote, setSearchingRemote] = useState(false);
  const [indSettingsModal, setIndSettingsModal] = useState<{
    open: boolean;
    kind: ConfigurableIndicatorKind;
  }>({ open: false, kind: "VPVR" });
  const [showLayoutMenu, setShowLayoutMenu] = useState(false);
  const [showIbkrModal, setShowIbkrModal] = useState(false);
  const [ibkrStatus, setIbkrStatus] = useState<IbkrConfigStatus | null>(null);
  const [ibkrStreamLive, setIbkrStreamLive] = useState<boolean>(() => isIbkrLiveStreamConnected());
  const [ibkrStreamMdt, setIbkrStreamMdt] = useState<number>(() => getIbkrEffectiveMarketDataType());
  const [customTfDraft, setCustomTfDraft] = useState("");
  const [showCustomTfInput, setShowCustomTfInput] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void getIbkrConfigStatus()
      .then((st) => {
        if (!cancelled) setIbkrStatus(st);
      })
      .catch(() => {
        // ignore initial status fetch error
      });
    const unsubConfig = subscribeIbkrConfigChanged((st) => {
      if (st) setIbkrStatus(st);
    });
    const unsubStream = subscribeIbkrStreamStatus((live, _reason, mdt) => {
      setIbkrStreamLive(live);
      if (typeof mdt === "number") setIbkrStreamMdt(mdt);
    });
    return () => {
      cancelled = true;
      unsubConfig();
      unsubStream();
    };
  }, []);
  const { favorites, favoriteOrder, favoriteMeta, isFavorite, toggleFavorite } = useFavoriteSymbols();
  const chartPrefs = useChartPreferences();
  const indicatorSettings = useIndicatorSettings();
  const enabledEmaLines = indicatorSettings.ema.lines.filter((l) => l.enabled);
  const emaLabel =
    enabledEmaLines.length === 0
      ? "EMA"
      : enabledEmaLines.length === 1
        ? `EMA ${enabledEmaLines[0]!.period}`
        : `EMA (${enabledEmaLines.map((l) => l.period).join(", ")})`;

  useEffect(() => {
    const q = symbolFilter.trim();
    const allowStocks = searchCat === "ALL" || searchCat === "STOCKS";
    const allowCrypto =
      searchCat === "ALL" || searchCat === "CRYPTO" || searchCat === "FUTURES" || searchCat === "EUR";
    if (!showSymbolSearch || q.length < 1 || (!allowStocks && !allowCrypto)) {
      setRemoteAltcoins([]);
      setSearchingRemote(false);
      return;
    }
    let cancelled = false;
    setSearchingRemote(true);
    const timer = setTimeout(() => {
      const tasks: Array<Promise<DemoSymbol[]>> = [];
      if (allowCrypto) tasks.push(discoverRemoteCrypto(q).catch(() => []));
      if (allowStocks) tasks.push(discoverRemoteStocks(q).catch(() => []));
      void Promise.all(tasks)
        .then((lists) => {
          if (!cancelled) {
            const seen = new Set<string>();
            const merged: DemoSymbol[] = [];
            for (const list of lists) {
              for (const s of list) {
                const key = normalizeFavoriteTicker(s.name);
                if (!seen.has(key)) {
                  seen.add(key);
                  merged.push(s);
                }
              }
            }
            setRemoteAltcoins(merged);
            setSearchingRemote(false);
          }
        })
        .catch(() => {
          if (!cancelled) setSearchingRemote(false);
        });
    }, 220);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [symbolFilter, showSymbolSearch, searchCat]);

  const combinedCatalog = useMemo(() => {
    const byName = new Map<string, DemoSymbol>();
    for (const s of DEMO_SYMBOLS) byName.set(normalizeFavoriteTicker(s.name), s);
    for (const s of symbols) {
      const key = normalizeFavoriteTicker(s.name);
      if (!byName.has(key)) {
        byName.set(key, s as unknown as DemoSymbol);
      }
    }
    for (const s of remoteAltcoins) {
      byName.set(normalizeFavoriteTicker(s.name), s);
    }
    for (const ticker of favoriteOrder) {
      if (!byName.has(ticker)) {
        byName.set(ticker, buildFavoriteDemoSymbol(ticker, favoriteMeta[ticker]));
      }
    }
    return Array.from(byName.values());
  }, [symbols, remoteAltcoins, favoriteOrder, favoriteMeta]);

  const filteredSymbols = useMemo(() => {
    if (searchCat === "FAV") {
      return searchDemoSymbols(symbolFilter, null, combinedCatalog).filter((s) =>
        isFavorite(s.name),
      );
    }
    const list = searchDemoSymbols(
      symbolFilter,
      searchCat === "ALL" ? null : searchCat,
      combinedCatalog,
    );
    if (!symbolFilter.trim()) {
      // Float favorites to the top when browsing without a search query
      return [...list].sort((a, b) => {
        const af = isFavorite(a.name) ? 0 : 1;
        const bf = isFavorite(b.name) ? 0 : 1;
        return af - bf;
      });
    }
    return list;
  }, [symbolFilter, searchCat, combinedCatalog, isFavorite]);

  const selectCatalogSymbol = useCallback(
    (s: DemoSymbol) => {
      if (!getDemoSymbol(s.name)) {
        registerDynamicSymbol({ ...s, displayName: s.displayName ?? undefined });
      }
      onSymbolChange(s.name);
      setShowSymbolSearch(false);
      setSymbolFilter("");
    },
    [onSymbolChange],
  );

  const toggleActiveSymbolFavorite = useCallback(() => {
    const norm = normalizeFavoriteTicker(selectedSymbol);
    const meta =
      symbols.find((s) => normalizeFavoriteTicker(s.name) === norm) ?? getDemoSymbol(selectedSymbol);
    toggleFavorite(
      selectedSymbol,
      meta
        ? {
            name: norm,
            displayName: meta.displayName ?? selectedSymbol,
            category: meta.category ?? "STOCKS",
            exchange: (meta as DemoSymbol).exchange,
            initialPrice: (meta as DemoSymbol).initialPrice ?? tick?.bid,
          }
        : undefined,
    );
  }, [selectedSymbol, symbols, tick?.bid, toggleFavorite]);

  const CATEGORY_TABS = [
    { id: "ALL", label: "Todos" },
    { id: "FAV", label: favorites.size > 0 ? `★ Fav (${favorites.size})` : "★ Fav" },
    { id: "EUR", label: "EUR (€)" },
    { id: "CRYPTO", label: "Crypto & BTC.D" },
    { id: "FUTURES", label: "Futuros Perp" },
    { id: "STOCKS", label: "Bolsa" },
    { id: "INDICES", label: "Índices" },
    { id: "COMMODITIES", label: "Mat. Primas" },
    { id: "FOREX", label: "Forex" },
  ] as const;

  const categoryBadgeLabel = (s: DemoSymbol) => {
    if (s.isDominanceIndex) return "DOMINANCIA";
    switch (s.category) {
      case "CRYPTO":
        return "CRYPTO";
      case "FUTURES":
        return "PERP";
      case "STOCKS":
        return "BOLSA";
      case "INDICES":
        return "ÍNDICE";
      case "COMMODITIES":
        return "MAT. PRIMA";
      case "FOREX":
        return "FOREX";
      default:
        return s.category;
    }
  };

  // Spread in quote-currency price units (ask - bid). Every instrument here is a crypto
  // pair quoted in USD, so a "pip" multiplier produced misleading numbers (8.2 USD showed as 821.8).
  const selectedSymbolInfo = (symbols.find((s) => s.name === selectedSymbol) ??
    getDemoSymbol(selectedSymbol)) as
    | { tickSize?: number | string }
    | undefined;
  const pipDigits = getPipDigits(selectedSymbolInfo, selectedSymbol);
  const isSelectedStock =
    (
      (
        symbols.find((s) => s.name === selectedSymbol) ??
        getDemoSymbol(selectedSymbol) ??
        DEMO_SYMBOLS.find((s) => s.name.toUpperCase() === selectedSymbol.trim().toUpperCase())
      )?.category ?? ""
    ).toUpperCase() === "STOCKS";
  const spreadRaw = tick ? Math.max(0, tick.ask - tick.bid) : null;
  const minStep = Math.pow(10, -pipDigits);
  const spread =
    spreadRaw == null || !Number.isFinite(spreadRaw)
      ? "--"
      : spreadRaw === 0
        ? (0).toFixed(pipDigits)
        : spreadRaw >= minStep * 0.99
          ? spreadRaw.toFixed(pipDigits)
          : spreadRaw.toFixed(
              Math.max(pipDigits, spreadRaw >= 0.01 ? 4 : spreadRaw >= 0.0001 ? 6 : 8),
            );

  // Real-exchange IBKR connection health
  const [feedLive, setFeedLive] = useState(() => isLiveFeedHealthy());
  const replayActive = useReplayStore((s) => s.phase === "active");
  useEffect(() => {
    const id = setInterval(() => setFeedLive(isLiveFeedHealthy()), 2000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="flex items-center gap-1 px-2 py-1 border-b border-border bg-card text-xs shrink-0 overflow-x-auto md:overflow-visible flex-nowrap md:flex-wrap no-scrollbar">
      {/* Symbol Selector */}
      <div className="relative shrink-0 flex items-center gap-0.5">
        <button
          onClick={() => setShowSymbolSearch((v) => !v)}
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md hover:bg-secondary font-bold text-sm tracking-tight"
        >
          {selectedSymbol}
          <ChevronDown className="h-3 w-3 opacity-60" />
        </button>
        <button
          type="button"
          data-testid="toolbar-favorite-btn"
          onClick={toggleActiveSymbolFavorite}
          title={
            isFavorite(selectedSymbol)
              ? `Quitar ${selectedSymbol} de favoritos`
              : `Añadir ${selectedSymbol} a favoritos`
          }
          className={cn(
            "p-1 rounded hover:bg-secondary transition-colors shrink-0",
            isFavorite(selectedSymbol)
              ? "text-yellow-400"
              : "text-muted-foreground/45 hover:text-yellow-400",
          )}
        >
          <Star
            className="h-3.5 w-3.5"
            fill={isFavorite(selectedSymbol) ? "currentColor" : "none"}
          />
        </button>

        {showSymbolSearch && (
          <>
            {/* Mobile: full-screen modal (avoids parent overflow clipping) */}
            <div
              className="md:hidden fixed inset-0 z-[100] bg-black/60"
              onClick={() => setShowSymbolSearch(false)}
            >
              <div
                className="fixed inset-x-0 top-0 bg-card border-b border-border shadow-2xl flex flex-col max-h-[85vh]"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="flex items-center gap-2 p-3 border-b border-border">
                  <Search className="h-4 w-4 text-muted-foreground shrink-0" />
                  <input
                    autoFocus
                    placeholder="Buscar BTCUSD, ETHEUR, BTCUSDT.P, altcoins, BTC.D, Bolsa, Oro, EURUSD..."
                    value={symbolFilter}
                    onChange={(e) => setSymbolFilter(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && filteredSymbols.length > 0) {
                        selectCatalogSymbol(filteredSymbols[0]!);
                      } else if (e.key === "Escape") {
                        setShowSymbolSearch(false);
                      }
                    }}
                    className="flex-1 bg-transparent text-base outline-none"
                  />
                  {searchingRemote && <Loader2 className="h-4 w-4 animate-spin text-primary shrink-0" />}
                  <button
                    onClick={() => {
                      setShowSymbolSearch(false);
                      setSymbolFilter("");
                    }}
                    className="p-1.5 rounded-md hover:bg-secondary"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
                <div className="flex items-center gap-1 px-3 py-2 border-b border-border overflow-x-auto no-scrollbar">
                  {CATEGORY_TABS.map((tab) => (
                    <button
                      key={tab.id}
                      type="button"
                      onClick={() => setSearchCat(tab.id)}
                      className={cn(
                        "px-2.5 py-1 rounded text-xs font-medium whitespace-nowrap transition-colors",
                        searchCat === tab.id
                          ? "bg-primary text-primary-foreground font-semibold"
                          : "bg-secondary/50 text-muted-foreground hover:text-foreground",
                      )}
                    >
                      {tab.label}
                    </button>
                  ))}
                </div>
                <div className="flex-1 overflow-y-auto overscroll-contain">
                  {filteredSymbols.length === 0 ? (
                    <div className="px-4 py-8 text-center text-sm text-muted-foreground">
                      {searchingRemote
                        ? `Buscando "${symbolFilter}" en mercados en vivo...`
                        : `Sin resultados para "${symbolFilter}"`}
                    </div>
                  ) : (
                    filteredSymbols.map((s) => {
                      const isFav = isFavorite(s.name);
                      return (
                        <div
                          key={s.id || s.name}
                          className={cn(
                            "w-full flex items-center justify-between px-4 py-2.5 text-base hover:bg-secondary border-b border-border/40 active:bg-secondary",
                            s.name === selectedSymbol && "bg-secondary",
                          )}
                        >
                          <button
                            type="button"
                            onClick={() =>
                              toggleFavorite(s.name, {
                                name: normalizeFavoriteTicker(s.name),
                                displayName: s.displayName ?? s.name,
                                category: s.category,
                                exchange: s.exchange,
                                initialPrice: s.initialPrice,
                                country: s.country,
                                currency: s.currency,
                              })
                            }
                            className={cn(
                              "mr-2.5 shrink-0",
                              isFav ? "text-yellow-400" : "text-muted-foreground/30",
                            )}
                          >
                            <Star className="h-4 w-4" fill={isFav ? "currentColor" : "none"} />
                          </button>
                          <button
                            type="button"
                            onClick={() => selectCatalogSymbol(s)}
                            className="flex-1 flex items-center justify-between min-w-0 text-left"
                          >
                            <div className="flex flex-col items-start min-w-0 pr-2">
                              <span className="font-semibold truncate">{s.name}</span>
                              {s.displayName && s.displayName !== s.name && (
                                <span className="text-xs text-muted-foreground truncate max-w-[200px]">
                                  {s.displayName}
                                </span>
                              )}
                            </div>
                            <div className="flex flex-col items-end shrink-0">
                              {s.initialPrice != null && (
                                <span className="font-mono text-xs font-semibold text-foreground">
                                  {s.isDominanceIndex
                                    ? `${s.initialPrice.toFixed(2)}%`
                                    : formatNumber(s.initialPrice, getPipDigits(s, s.name))}
                                </span>
                              )}
                              <span className="text-[10px] text-muted-foreground uppercase tracking-wide">
                                {categoryBadgeLabel(s)}
                                {s.exchange ? ` · ${s.exchange}` : ""}
                              </span>
                            </div>
                          </button>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            </div>

            {/* Desktop: rich universal asset search dropdown */}
            <div
              className="fixed inset-0 z-40 hidden md:block"
              onClick={() => setShowSymbolSearch(false)}
            />
            <div className="hidden md:flex flex-col absolute top-full left-0 z-50 mt-1 w-[430px] bg-card border border-border rounded-lg shadow-2xl overflow-hidden">
              <div className="flex items-center gap-2 px-3 py-2 border-b border-border bg-secondary/40">
                <Search className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                <input
                  autoFocus
                  placeholder="Buscar BTCUSD, ETHEUR, BTCUSDT.P, altcoins, BTC.D, Bolsa (AAPL, SAN), Oro, EURUSD..."
                  value={symbolFilter}
                  onChange={(e) => setSymbolFilter(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && filteredSymbols.length > 0) {
                      selectCatalogSymbol(filteredSymbols[0]!);
                    } else if (e.key === "Escape") {
                      setShowSymbolSearch(false);
                    }
                  }}
                  className="flex-1 bg-transparent text-xs outline-none text-foreground placeholder:text-muted-foreground"
                />
                {searchingRemote && (
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-primary shrink-0" />
                )}
                {symbolFilter && (
                  <button
                    type="button"
                    onClick={() => setSymbolFilter("")}
                    className="p-0.5 rounded hover:bg-secondary text-muted-foreground"
                  >
                    <X className="h-3 w-3" />
                  </button>
                )}
              </div>

              <div className="flex items-center gap-1 px-2 py-1.5 border-b border-border overflow-x-auto no-scrollbar bg-card">
                {CATEGORY_TABS.map((tab) => (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => setSearchCat(tab.id)}
                    className={cn(
                      "px-2 py-0.5 rounded text-[11px] font-medium whitespace-nowrap transition-colors",
                      searchCat === tab.id
                        ? "bg-primary text-primary-foreground font-semibold"
                        : "text-muted-foreground hover:bg-secondary hover:text-foreground",
                    )}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>

              <div className="max-h-[380px] overflow-y-auto divide-y divide-border/30">
                {filteredSymbols.length === 0 ? (
                  <div className="px-4 py-8 text-center text-xs text-muted-foreground">
                    {searchingRemote
                      ? `Buscando "${symbolFilter}" en mercados en vivo...`
                      : `No se encontraron activos para "${symbolFilter}"`}
                  </div>
                ) : (
                  filteredSymbols.map((s) => {
                    const isFav = isFavorite(s.name);
                    return (
                      <div
                        key={s.id || s.name}
                        className={cn(
                          "w-full flex items-center gap-2 px-3 py-2 text-xs hover:bg-secondary/80 transition-colors",
                          s.name === selectedSymbol && "bg-secondary",
                        )}
                      >
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleFavorite(s.name, {
                              name: normalizeFavoriteTicker(s.name),
                              displayName: s.displayName ?? s.name,
                              category: s.category,
                              exchange: s.exchange,
                              initialPrice: s.initialPrice,
                              country: s.country,
                              currency: s.currency,
                            });
                          }}
                          className={cn(
                            "shrink-0",
                            isFav
                              ? "text-yellow-400"
                              : "text-muted-foreground/25 hover:text-yellow-400/70",
                          )}
                          title="Favorito"
                        >
                          <Star className="h-3.5 w-3.5" fill={isFav ? "currentColor" : "none"} />
                        </button>
                        <button
                          type="button"
                          onClick={() => selectCatalogSymbol(s)}
                          className="flex-1 flex items-center justify-between min-w-0 text-left"
                        >
                          <div className="flex flex-col min-w-0 pr-2">
                            <span className="font-bold text-foreground truncate">{s.name}</span>
                            {s.displayName && (
                              <span className="text-[11px] text-muted-foreground truncate">
                                {s.displayName}
                              </span>
                            )}
                          </div>
                          <div className="flex items-center gap-2.5 shrink-0">
                            {s.initialPrice != null && (
                              <span className="font-mono font-semibold text-foreground tabular-nums">
                                {s.isDominanceIndex
                                  ? `${s.initialPrice.toFixed(2)}%`
                                  : formatNumber(s.initialPrice, getPipDigits(s, s.name))}
                              </span>
                            )}
                            <span className="px-1.5 py-0.5 rounded bg-secondary text-[10px] font-semibold text-muted-foreground uppercase">
                              {categoryBadgeLabel(s)}
                              {s.exchange ? ` · ${s.exchange}` : ""}
                            </span>
                          </div>
                        </button>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          </>
        )}
      </div>

      {/* Live Price — bid / ask badges like TradingView */}
      {tick && (
        <div className="flex items-center gap-1 md:gap-1.5 px-1.5 md:px-2 border-l border-r border-border shrink-0">
          <span className="inline-flex items-center gap-1 px-1 md:px-1.5 py-0.5 rounded bg-[#0ecb81]/15 text-[#0ecb81] font-mono font-bold text-[12px] md:text-[13px] tabular-nums tracking-tight">
            {formatNumber(
              tick.bid,
              getPipDigits(symbolInfo, selectedSymbol),
            )}
          </span>
          <span className="text-muted-foreground text-[10px] font-medium">/</span>
          <span className="inline-flex items-center gap-1 px-1 md:px-1.5 py-0.5 rounded bg-[#f6465d]/15 text-[#f6465d] font-mono font-bold text-[12px] md:text-[13px] tabular-nums tracking-tight">
            {formatNumber(
              tick.ask,
              getPipDigits(symbolInfo, selectedSymbol),
            )}
          </span>
          <span className="text-muted-foreground text-[10px] font-medium ml-0.5 hidden md:inline">
            Sprd: {spread}
          </span>
          {!replayActive && (
          <span
            title={
              feedLive
                ? "Datos conectados (IBKR para acciones EE. UU. · Binance/Kraken/Coinbase para cripto)"
                : "Sin conexión activa de datos en vivo: esperando IBKR o stream cripto"
            }
            className={cn(
              "flex items-center gap-1 text-[10px] font-semibold ml-1",
              feedLive
                ? isSelectedStock &&
                  ibkrStatus?.connectionState === "connected" &&
                  (ibkrStatus.effectiveMarketDataType ?? ibkrStatus.marketDataType ?? ibkrStreamMdt) === 4
                  ? "text-sky-400"
                  : "text-green-500"
                : "text-red-500",
            )}
          >
            <span className="h-1.5 w-1.5 rounded-full bg-current" />
            {feedLive
              ? isSelectedStock &&
                ibkrStatus?.connectionState === "connected" &&
                (ibkrStatus.effectiveMarketDataType ?? ibkrStatus.marketDataType ?? ibkrStreamMdt) === 4
                ? "DIFERIDO"
                : "LIVE"
              : "DESCONECTADO"}
          </span>
          )}
        </div>
      )}

      {/* Timeframe Selector — supports standard presets + any custom dynamic timeframe */}
      <div className="flex items-center gap-0.5 ml-1 shrink-0 notranslate" translate="no">
        {TIMEFRAMES.map((tf) => (
          <button
            key={tf}
            onClick={() => onTimeframeChange(tf)}
            translate="no"
            className={cn(
              "px-1.5 py-0.5 rounded text-xs font-semibold notranslate transition-all",
              tf === timeframe
                ? "bg-primary text-primary-foreground shadow-sm"
                : "hover:bg-secondary/80 text-muted-foreground hover:text-foreground",
            )}
          >
            {tf}
          </button>
        ))}
        {!(TIMEFRAMES as readonly string[]).includes(timeframe) && (
          <button
            type="button"
            onClick={() => onTimeframeChange(timeframe)}
            translate="no"
            className="px-1.5 py-0.5 rounded text-xs font-semibold notranslate bg-primary text-primary-foreground shadow-sm"
            title={`Timeframe personalizado activo (${timeframe})`}
          >
            {timeframe}
          </button>
        )}
        {showCustomTfInput ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const normalized = normalizeTimeframeLabel(customTfDraft);
              if (normalized && isValidTimeframe(normalized)) {
                onTimeframeChange(normalized as Timeframe);
                setCustomTfDraft("");
                setShowCustomTfInput(false);
              }
            }}
            className="inline-flex items-center ml-0.5"
          >
            <input
              type="text"
              value={customTfDraft}
              onChange={(e) => setCustomTfDraft(e.target.value)}
              onBlur={() => {
                if (!customTfDraft.trim()) setShowCustomTfInput(false);
              }}
              placeholder="7m, 45s"
              aria-label="Timeframe personalizado"
              autoFocus
              className="w-16 h-6 px-1.5 rounded border border-border bg-background text-[11px] font-mono focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </form>
        ) : (
          <button
            type="button"
            onClick={() => setShowCustomTfInput(true)}
            title="Añadir timeframe personalizado (ej. 45s, 2m, 4m, 7m, 10m, 2h)"
            className="px-1.5 py-0.5 rounded text-xs font-semibold hover:bg-secondary/80 text-muted-foreground hover:text-foreground transition-colors"
          >
            +
          </button>
        )}
      </div>

      {/* Historical bar replay controls */}
      {REPLAY_ENABLED && (
        <ReplayHUD
          accountId={replayAccountId}
          symbol={selectedSymbol}
          timeframe={replayTimeframe ?? timeframe}
          additionalTimeframes={replayAdditionalTimeframes}
          secondarySymbols={replaySecondarySymbols}
        />
      )}

      {/* Chart layout templates (save/load/autosave) */}
      {onSetIndicators && onSetPlugins && (
        <ChartTemplatesMenu
          activeIndicators={activeIndicators}
          onSetIndicators={onSetIndicators}
          activePlugins={activePlugins}
          onSetPlugins={onSetPlugins}
          multiChartState={multiChartTemplateState}
          onApplyMultiChartState={onApplyMultiChartTemplate}
        />
      )}

      <div className="h-4 border-l border-border mx-1 hidden md:block" />

      {/* Indicators */}
      {(() => {
        const volumeActive = focusedShowVolume ?? chartPrefs.showVolume;
        const activeIndicatorCount = activeIndicators.length + (volumeActive ? 1 : 0);
        return (
        <div className="relative hidden md:block">
          <button
            onClick={onToggleIndicatorMenu}
            className={cn(
              "flex items-center gap-1 px-2 py-1 rounded text-xs",
              activeIndicatorCount > 0
                ? "bg-primary/20 text-primary"
                : "hover:bg-secondary text-muted-foreground",
            )}
          >
            <BarChart3 className="h-3 w-3" />
            Indicators
            {activeIndicatorCount > 0 && (
              <span className="bg-primary text-primary-foreground rounded-full px-1 text-[9px]">
                {activeIndicatorCount}
              </span>
            )}
          </button>

          {showIndicatorMenu && (
            <>
              <div className="fixed inset-0 z-40" onClick={onToggleIndicatorMenu} />
              <div className="absolute top-full left-0 z-50 mt-1 w-64 bg-card border border-border rounded-lg shadow-xl p-2 space-y-1">
                <div className="flex items-center justify-between px-2 py-1.5 border-b border-border/60 mb-1">
                  <div className="flex flex-col">
                    <span className="text-xs font-semibold text-foreground">Separar osciladores</span>
                    <span className="text-[10px] text-muted-foreground">RSI · MACD · Stoch RSI</span>
                  </div>
                  <button
                    type="button"
                    onClick={() =>
                      updateChartPreferences({
                        separateOscillators: !chartPrefs.separateOscillators,
                      })
                    }
                    className={cn(
                      "relative inline-flex h-4 w-7 shrink-0 cursor-pointer rounded-full transition-colors",
                      chartPrefs.separateOscillators ? "bg-primary" : "bg-muted",
                    )}
                    title="Separar osciladores en paneles inferiores independientes"
                  >
                    <span
                      className={cn(
                        "inline-block h-3 w-3 transform rounded-full bg-white transition-transform mt-0.5",
                        chartPrefs.separateOscillators ? "translate-x-3.5" : "translate-x-0.5",
                      )}
                    />
                  </button>
                </div>

                {INDICATOR_REGISTRY.map((ind) => {
                  const isConfigurable =
                    ind.type === "EMA" ||
                    ind.type === "VWAP" ||
                    ind.type === "VPVR" ||
                    ind.type === "SMC";
                  const isActive = activeIndicators.includes(ind.type);
                  const displayLabel = ind.type === "EMA" ? emaLabel : ind.label;
                  const dotColor =
                    ind.type === "EMA" && enabledEmaLines[0]
                      ? enabledEmaLines[0].color
                      : ind.type === "VWAP"
                        ? indicatorSettings.vwap.color
                        : ind.color;
                  return (
                    <div
                      key={ind.type}
                      className={cn(
                        "flex items-center gap-1 rounded hover:bg-secondary",
                        isActive && "bg-secondary",
                      )}
                    >
                      <button
                        type="button"
                        onClick={() => onToggleIndicator(ind.type)}
                        className="flex-1 flex items-center gap-2 px-2 py-1.5 text-sm text-left min-w-0"
                      >
                        <span
                          className="w-2 h-2 rounded-full shrink-0"
                          style={{ backgroundColor: dotColor }}
                        />
                        <span className="flex-1 truncate">{displayLabel}</span>
                        <span className="text-[10px] text-muted-foreground shrink-0">
                          {ind.pane}
                        </span>
                      </button>
                      {isConfigurable && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setIndSettingsModal({
                              open: true,
                              kind: ind.type as ConfigurableIndicatorKind,
                            });
                            onToggleIndicatorMenu();
                          }}
                          title={`Configurar ${displayLabel}`}
                          className="p-1.5 mr-1 rounded text-muted-foreground hover:text-primary hover:bg-background/60 shrink-0"
                        >
                          <Settings2 className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>
                  );
                })}

                <button
                  type="button"
                  onClick={
                    onToggleVolume ??
                    (() => updateChartPreferences({ showVolume: !chartPrefs.showVolume }))
                  }
                  className={cn(
                    "w-full flex items-center gap-2 px-2 py-1.5 rounded text-sm hover:bg-secondary text-left",
                    volumeActive && "bg-secondary",
                  )}
                >
                  <span
                    className="w-2 h-2 rounded-full shrink-0"
                    style={{ backgroundColor: "#26a69a" }}
                  />
                  <span className="flex-1">Volumen (MA 20)</span>
                  <span className="text-[10px] text-muted-foreground">overlay</span>
                </button>
              </div>
            </>
          )}
        </div>
        );
      })()}

      {/* Multichart Layout Selector */}
      {onChartLayoutChange && (
        <div className="relative hidden md:block">
          <button
            type="button"
            onClick={() => setShowLayoutMenu((v) => !v)}
            title="Diseño Multigráfico (1 / 2×1 / 2×2)"
            className={cn(
              "flex items-center gap-1 px-2 py-1 rounded text-xs",
              chartLayout !== "1"
                ? "bg-primary/20 text-primary font-semibold"
                : "hover:bg-secondary text-muted-foreground",
            )}
          >
            <LayoutGrid className="h-3.5 w-3.5" />
            <span>{chartLayout === "1" ? "1" : chartLayout === "2x1" ? "2×1" : "2×2"}</span>
          </button>
          {showLayoutMenu && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setShowLayoutMenu(false)} />
              <div className="absolute top-full left-0 z-50 mt-1 w-52 bg-card border border-border rounded-lg shadow-xl p-1 space-y-0.5">
                {(
                  [
                    { id: "1", label: "1 Gráfico (Único)" },
                    { id: "2x1", label: "2×1 (Izq 1m · Der 5m/3m)" },
                    { id: "2x2", label: "2×2 (Cuadrícula)" },
                  ] as const
                ).map((opt) => (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => {
                      onChartLayoutChange(opt.id);
                      setShowLayoutMenu(false);
                    }}
                    className={cn(
                      "w-full flex items-center justify-between px-2.5 py-1.5 rounded text-xs hover:bg-secondary text-left",
                      chartLayout === opt.id && "bg-primary/15 text-primary font-semibold",
                    )}
                  >
                    <span>{opt.label}</span>
                  </button>
                ))}
                {chartLayout === "2x1" && canSyncPrice2x1 && onToggleSyncPrice2x1 && (
                  <div className="pt-1 mt-1 border-t border-border/60">
                    <button
                      type="button"
                      onClick={() => {
                        onToggleSyncPrice2x1();
                        setShowLayoutMenu(false);
                      }}
                      className={cn(
                        "w-full flex items-center justify-between px-2.5 py-1.5 rounded text-[11px] hover:bg-secondary text-left",
                        syncPrice2x1 ? "text-primary font-semibold" : "text-muted-foreground",
                      )}
                      title="Por defecto desactivado para que 1m y 5m/3m auto-escalen perfectamente sin recortar velas"
                    >
                      <span>Sincronizar eje Y (2×1)</span>
                      <span>{syncPrice2x1 ? "ON" : "OFF"}</span>
                    </button>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      )}

      {/* Stock Screener Toggle (Vol. rel >= 5x · Float 800K–20M · $1–$20 · >10%) */}
      {onToggleScreener && (
        <button
          type="button"
          onClick={onToggleScreener}
          title="Buscador de Acciones (Vol. rel ≥ 5x · Float 800K–20M · $1–$20 · Cbo % > +10%)"
          className={cn(
            "flex items-center gap-1 px-2 py-1 rounded text-xs shrink-0",
            showScreener
              ? "bg-primary/20 text-primary font-semibold"
              : "hover:bg-secondary text-muted-foreground",
          )}
        >
          <Filter className="h-3.5 w-3.5" />
          <span>Acciones</span>
        </button>
      )}

      {(() => {
        if (!showScreener && !isSelectedStock) return null;

        const isConnected = ibkrStatus?.connectionState === "connected";
        const effectiveMdt =
          ibkrStatus?.effectiveMarketDataType ?? ibkrStatus?.marketDataType ?? ibkrStreamMdt ?? 1;
        const isRt = effectiveMdt === 1 || effectiveMdt === 2;
        const badgeLabel = !isConnected
          ? "IBKR Offline"
          : isRt
            ? ibkrStreamLive
              ? "IBKR · US RT 1s"
              : "IBKR · US RT"
            : "IBKR · Diferido 15m";

        const badgeTitle = isConnected
          ? isRt
            ? `Interactive Brokers (${ibkrStatus.host}:${ibkrStatus.port}) — Tiempo real EE. UU. (NYSE · NASDAQ · AMEX) · TRADES + Volumen consolidado`
            : `Interactive Brokers (${ibkrStatus.host}:${ibkrStatus.port}) — Datos diferidos 15 min (sin suscripción de pago aún) · Precio TRADES, Volumen, VWAP y EMA exactos de IBKR`
          : "Haz clic para configurar TWS / IB Gateway (Interactive Brokers)";

        return (
          <>
            {isSelectedStock && (
              <button
                type="button"
                data-testid="extended-hours-toggle-btn"
                onClick={() =>
                  updateChartPreferences({ showExtendedHours: !chartPrefs.showExtendedHours })
                }
                title={
                  chartPrefs.showExtendedHours
                    ? "Sesión Ampliada activa (Pre-Market, Regular y Post-Market) — Haz clic para ver solo Sesión Normal"
                    : "Sesión Normal activa (solo horario regular 09:30–16:00 ET) — Haz clic para ver Pre-Market y Post-Market (Sesión Ampliada)"
                }
                className={cn(
                  "flex items-center gap-1 px-2 py-1 rounded text-xs font-semibold border shrink-0 transition-colors",
                  chartPrefs.showExtendedHours
                    ? "bg-amber-500/15 border-amber-500/40 text-amber-300 hover:bg-amber-500/25"
                    : "bg-secondary/80 border-border text-muted-foreground hover:text-foreground hover:bg-secondary",
                )}
              >
                <Clock className="h-3 w-3 shrink-0" />
                <span>{chartPrefs.showExtendedHours ? "Sesión ampliada" : "Sesión normal"}</span>
              </button>
            )}
            <button
              type="button"
              onClick={() => setShowIbkrModal(true)}
              title={badgeTitle}
              className={cn(
                "flex items-center gap-1.5 px-2 py-1 rounded text-xs font-semibold border shrink-0 transition-colors",
                !isConnected
                  ? "bg-amber-500/15 border-amber-500/40 text-amber-300 hover:bg-amber-500/25"
                  : isRt
                    ? "bg-emerald-500/15 border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/25"
                    : "bg-sky-500/15 border-sky-500/40 text-sky-300 hover:bg-sky-500/25",
              )}
            >
              <span
                className={cn(
                  "h-1.5 w-1.5 rounded-full shrink-0",
                  !isConnected
                    ? "bg-amber-400"
                    : isRt
                      ? cn("bg-emerald-400", ibkrStreamLive && "animate-pulse")
                      : "bg-sky-400",
                )}
              />
              <span>{badgeLabel}</span>
            </button>
          </>
        );
      })()}


      <div className="flex-1 hidden md:block" />

      {/* Right Panel Toggles */}
      <div className="hidden md:flex items-center gap-1">
        <ToolButton
          icon={ArrowUpDown}
          tooltip="Nueva Orden (Flotante)"
          active={floatingOrderOpen}
          onClick={onToggleFloatingOrder ?? (() => onRightPanel("order"))}
        />
        <ToolButton
          icon={Layers}
          tooltip="Depth of Market"
          active={showRightPanel && rightPanel === "dom"}
          onClick={() => onRightPanel("dom")}
        />
        <ToolButton
          icon={BarChart3}
          tooltip="Watchlist"
          active={showRightPanel && rightPanel === "watchlist"}
          onClick={() => onRightPanel("watchlist")}
        />
        <ToolButton
          icon={Newspaper}
          tooltip="News"
          active={showRightPanel && rightPanel === "news"}
          onClick={() => onRightPanel("news")}
        />
        {aiTraderEnabled && (
          <ToolButton
            icon={Bot}
            tooltip="AI Trader"
            active={showRightPanel && rightPanel === "ai-trader"}
            onClick={() => onRightPanel("ai-trader")}
          />
        )}
        <div className="h-5 border-l border-border mx-1" />
        <button
          onClick={onToggleRightPanel}
          className="px-2 py-1.5 rounded hover:bg-secondary text-muted-foreground"
        >
          <Maximize2 className="h-4 w-4" />
        </button>
      </div>

      <IndicatorSettingsModal
        open={indSettingsModal.open}
        initialKind={indSettingsModal.kind}
        onClose={() => setIndSettingsModal((prev) => ({ ...prev, open: false }))}
        activeIndicators={activeIndicators}
        onToggleIndicator={onToggleIndicator}
      />
      <IbkrConfigModal open={showIbkrModal} onClose={() => setShowIbkrModal(false)} />
    </div>
  );
}

export function ToolButton({
  icon: Icon,
  tooltip,
  active,
  onClick,
}: {
  icon: LucideIcon;
  tooltip: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      title={tooltip}
      className={cn(
        "px-2.5 py-1.5 rounded",
        active ? "bg-primary/20 text-primary" : "hover:bg-secondary text-muted-foreground",
      )}
    >
      <Icon className="h-[18px] w-[18px]" />
    </button>
  );
}

