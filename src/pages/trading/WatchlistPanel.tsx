import { useEffect, useMemo, useState } from "react";
import { Loader2, Search, Star } from "lucide-react";
import { usePlaceOrder } from "../../services/queries.ts";
import { formatNumber, cn } from "../../lib/utils.ts";
import { toast } from "../../services/toast.ts";
import { getPipDigits } from "./utils.ts";
import { extractBaseAsset } from "../../hooks/useInstrumentLabels.ts";
import {
  buildFavoriteDemoSymbol,
  normalizeFavoriteTicker,
  useFavoriteSymbols,
} from "../../hooks/useFavoriteSymbols.ts";
import {
  DEMO_SYMBOLS,
  discoverRemoteStocks,
  getDemoSymbol,
  registerDynamicSymbol,
  searchDemoSymbols,
  type DemoSymbol,
} from "../../services/demo/instruments.ts";

const CATEGORY_LABELS: Record<string, string> = {
  CRYPTO: "Crypto & BTC.D",
  FUTURES: "Futuros Perp",
  STOCKS: "Bolsa",
  INDICES: "Índices",
  COMMODITIES: "Mat. Primas",
  FOREX: "Forex",
};

export function WatchlistPanel({
  symbols,
  ticks,
  selectedSymbol,
  onSelect,
  oneClick,
  accountId,
  isFeedConnected = true,
}: {
  symbols: Array<{
    id?: string;
    name: string;
    displayName?: string | null;
    assetClass?: string;
    category?: string;
    isActive?: boolean;
  }>;
  ticks: Record<string, { bid: number; ask: number; timestamp: number }>;
  selectedSymbol: string;
  onSelect: (s: string) => void;
  oneClick?: boolean;
  accountId?: string | null;
  isFeedConnected?: boolean;
}) {
  const [filter, setFilter] = useState("");
  const [remoteAltcoins, setRemoteAltcoins] = useState<DemoSymbol[]>([]);
  const [searchingRemote, setSearchingRemote] = useState(false);
  const placeOrder = usePlaceOrder();

  const { favorites, favoriteOrder, favoriteMeta, isFavorite, toggleFavorite } = useFavoriteSymbols();

  useEffect(() => {
    const q = filter.trim();
    if (q.length < 2) {
      setRemoteAltcoins([]);
      setSearchingRemote(false);
      return;
    }
    let cancelled = false;
    setSearchingRemote(true);
    const timer = setTimeout(() => {
      void discoverRemoteStocks(q)
        .then((stockFound) => {
          if (!cancelled) {
            const seen = new Set<string>();
            const merged: DemoSymbol[] = [];
            for (const s of stockFound) {
              const key = normalizeFavoriteTicker(s.name);
              if (!seen.has(key)) {
                seen.add(key);
                merged.push(s);
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
  }, [filter]);

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

  const filtered = useMemo(() => {
    const q = filter.trim();
    if (!q) {
      const orderMap = new Map(favoriteOrder.map((t, idx) => [t, idx]));
      return combinedCatalog
        .filter((s) => isFavorite(s.name))
        .sort((a, b) => {
          const ia = orderMap.get(normalizeFavoriteTicker(a.name)) ?? Number.MAX_SAFE_INTEGER;
          const ib = orderMap.get(normalizeFavoriteTicker(b.name)) ?? Number.MAX_SAFE_INTEGER;
          return ia - ib;
        });
    }
    return searchDemoSymbols(q, null, combinedCatalog);
  }, [combinedCatalog, filter, favoriteOrder, isFavorite]);

  const isSearching = filter.trim().length > 0;

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 py-3 border-b border-border bg-secondary">
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-bold uppercase tracking-wider text-muted-foreground">
            Favoritos &amp; Buscador
          </h3>
          <span className="text-[10px] font-mono text-muted-foreground">
            {isSearching ? `${filtered.length} resultados` : `${favorites.size} favoritos`}
          </span>
        </div>
        <div className="relative flex items-center">
          <Search className="h-3.5 w-3.5 text-muted-foreground absolute left-2.5 pointer-events-none" />
          <input
            placeholder="Buscar ticker para añadir a favoritos..."
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="w-full text-sm py-1.5 pl-8 pr-7 rounded bg-background border border-border/60 outline-none focus:border-primary"
          />
          {searchingRemote && (
            <Loader2 className="h-3.5 w-3.5 animate-spin text-primary absolute right-2" />
          )}
        </div>
      </div>
      <div className="flex-1 overflow-y-auto">
        {filtered.length === 0 && (
          <div className="px-4 py-8 text-center text-xs text-muted-foreground">
            {isSearching
              ? "Sin resultados para tu búsqueda."
              : "Sin favoritos todavía. Usa el buscador de arriba para añadir activos con ★."}
          </div>
        )}
        {filtered.map((s) => {
          const t = ticks[s.name];
          const isFav = isFavorite(s.name);
          const digits = getPipDigits(s, s.name);
          const handleQuickTrade = (side: "BUY" | "SELL") => {
            if (!isFeedConnected) {
              toast.warning("No Data Feed", "Cannot trade while disconnected");
              return;
            }
            if (!accountId) {
              toast.warning("No Account", "Select an account first");
              return;
            }
            const base = extractBaseAsset(s.name).toUpperCase();
            const effectivePrice = t?.ask || s.initialPrice;
            const qty =
              base === "BTC"
                ? 0.005
                : base === "ETH" || base === "BNB"
                  ? 0.05
                  : base === "SOL" || base === "AVAX"
                    ? 1
                    : base === "DOT" || base === "LINK"
                      ? 10
                      : base === "XRP" || base === "ADA" || base === "DOGE"
                        ? 100
                        : s.category === "STOCKS"
                          ? 5
                          : s.category === "FOREX"
                            ? 100
                            : effectivePrice && effectivePrice < 0.0005
                              ? 10_000_000
                              : 1;
            placeOrder.mutate(
              {
                accountId,
                symbol: s.name,
                side,
                type: "MARKET",
                quantity: qty,
              },
              {
                onSuccess: () => toast.success("Quick Trade", `${side} ${qty} ${s.name}`),
                onError: (err: unknown) =>
                  toast.error("Trade Failed", (err as { message?: string })?.message || "Failed"),
              },
            );
          };
          return (
            <div
              key={s.id || s.name}
              className={cn(
                "w-full flex items-center justify-between px-4 py-2.5 text-sm hover:bg-secondary border-b border-border/30 group",
                s.name === selectedSymbol && "bg-secondary",
              )}
            >
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  toggleFavorite(s.name, {
                    name: normalizeFavoriteTicker(s.name),
                    displayName: s.displayName ?? s.name,
                    category: s.category,
                    exchange: s.exchange,
                    initialPrice: t?.bid ?? s.initialPrice,
                    country: s.country,
                    currency: s.currency,
                  });
                }}
                className={cn(
                  "shrink-0 mr-2",
                  isFav ? "text-yellow-400" : "text-muted-foreground/20 hover:text-yellow-400/60",
                )}
              >
                <Star className="h-4 w-4" fill={isFav ? "currentColor" : "none"} />
              </button>
              <button
                onClick={() => {
                  if (!getDemoSymbol(s.name)) {
                    registerDynamicSymbol({ ...s, displayName: s.displayName ?? undefined });
                  }
                  onSelect(s.name);
                }}
                className="text-left flex-1 min-w-0 pr-2"
              >
                <div className="font-bold text-sm truncate">{s.name}</div>
                <div className="text-[11px] text-muted-foreground truncate">
                  {s.displayName ? `${s.displayName} · ` : ""}
                  {s.exchange || CATEGORY_LABELS[s.category] || s.category}
                </div>
              </button>
              {t ? (
                <div className="flex items-center gap-2 shrink-0">
                  <div className="text-right font-mono text-xs font-semibold tabular-nums">
                    <div className="text-buy">
                      {s.isDominanceIndex ? `${t.bid.toFixed(2)}%` : formatNumber(t.bid, digits)}
                    </div>
                    <div className="text-sell">
                      {s.isDominanceIndex ? `${t.ask.toFixed(2)}%` : formatNumber(t.ask, digits)}
                    </div>
                  </div>
                  {oneClick && (
                    <div className="hidden group-hover:flex flex-col gap-1 ml-1">
                      <button
                        onClick={() => handleQuickTrade("BUY")}
                        className="px-2 py-0.5 text-xs rounded bg-buy/20 text-buy hover:bg-buy/30 font-bold"
                      >
                        B
                      </button>
                      <button
                        onClick={() => handleQuickTrade("SELL")}
                        className="px-2 py-0.5 text-xs rounded bg-sell/20 text-sell hover:bg-sell/30 font-bold"
                      >
                        S
                      </button>
                    </div>
                  )}
                </div>
              ) : s.initialPrice != null ? (
                <div className="text-right font-mono text-xs font-semibold text-muted-foreground tabular-nums shrink-0">
                  {s.isDominanceIndex
                    ? `${s.initialPrice.toFixed(2)}%`
                    : formatNumber(s.initialPrice, digits)}
                </div>
              ) : (
                <span className="text-muted-foreground">--</span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
