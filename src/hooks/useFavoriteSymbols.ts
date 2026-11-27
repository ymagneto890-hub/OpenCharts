import { useCallback, useEffect, useMemo, useState } from "react";
import {
  type DemoSymbol,
  DEMO_SYMBOLS,
  getDemoSymbol,
  inferTickSizeFromPrice,
  registerDynamicSymbol,
} from "../services/demo/instruments.ts";

export const FAVORITES_STORAGE_KEY = "watchlist_favorites";
export const FAVORITES_META_STORAGE_KEY = "watchlist_favorites_meta_v1";
export const FAVORITES_UPDATED_EVENT = "oc-favorites-updated";

export interface FavoriteSymbolMeta {
  name: string;
  displayName?: string;
  category?: string;
  exchange?: string;
  initialPrice?: number;
  description?: string;
  country?: string;
  currency?: string;
}

export function normalizeFavoriteTicker(ticker: string): string {
  return ticker.trim().toUpperCase();
}

export function getFavoritesFromStorage(): string[] {
  try {
    const raw = localStorage.getItem(FAVORITES_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const item of parsed) {
      if (typeof item !== "string") continue;
      const norm = normalizeFavoriteTicker(item);
      if (!norm || seen.has(norm)) continue;
      seen.add(norm);
      out.push(norm);
    }
    return out;
  } catch {
    return [];
  }
}

export function getFavoriteMetaMap(): Record<string, FavoriteSymbolMeta> {
  try {
    const raw = localStorage.getItem(FAVORITES_META_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, FavoriteSymbolMeta> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (!v || typeof v !== "object") continue;
      const norm = normalizeFavoriteTicker(k);
      if (!norm) continue;
      const rec = v as Partial<FavoriteSymbolMeta>;
      out[norm] = {
        name: norm,
        displayName: typeof rec.displayName === "string" ? rec.displayName : undefined,
        category: typeof rec.category === "string" ? rec.category : undefined,
        exchange: typeof rec.exchange === "string" ? rec.exchange : undefined,
        initialPrice:
          typeof rec.initialPrice === "number" && Number.isFinite(rec.initialPrice) && rec.initialPrice > 0
            ? rec.initialPrice
            : undefined,
        description: typeof rec.description === "string" ? rec.description : undefined,
        country: typeof rec.country === "string" ? rec.country : undefined,
        currency: typeof rec.currency === "string" ? rec.currency : undefined,
      };
    }
    return out;
  } catch {
    return {};
  }
}

export function buildFavoriteDemoSymbol(
  ticker: string,
  meta?: FavoriteSymbolMeta,
): DemoSymbol {
  const norm = normalizeFavoriteTicker(ticker);
  const existing =
    DEMO_SYMBOLS.find((s) => s.name.toUpperCase() === norm) ?? getDemoSymbol(norm);
  if (existing) {
    return existing;
  }

  const price =
    meta?.initialPrice && Number.isFinite(meta.initialPrice) && meta.initialPrice > 0
      ? meta.initialPrice
      : 100;
  const tickSize = inferTickSizeFromPrice(price);
  const category = meta?.category || "STOCKS";

  return {
    id: norm,
    name: norm,
    displayName: meta?.displayName || meta?.description || norm,
    category,
    contractSize: 1,
    tickSize,
    tickValue: tickSize,
    marginPercent: category === "CRYPTO" || category === "FUTURES" ? 1 : 5,
    maxLeverage: category === "CRYPTO" || category === "FUTURES" ? 100 : 20,
    commission: 0,
    swapLong: 0,
    swapShort: 0,
    tradingHoursStart: null,
    tradingHoursEnd: null,
    isActive: true,
    initialPrice: price,
    precision: 2,
    exchange: meta?.exchange || "US",
    country: meta?.country || "United States",
    currency: meta?.currency || "USD",
  };
}

function writeFavoritesToStorage(order: string[], metaMap: Record<string, FavoriteSymbolMeta>): void {
  try {
    localStorage.setItem(FAVORITES_STORAGE_KEY, JSON.stringify(order));
    localStorage.setItem(FAVORITES_META_STORAGE_KEY, JSON.stringify(metaMap));
  } catch {
    // ignore storage quota errors
  }
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(FAVORITES_UPDATED_EVENT));
  }
}

function inferMetaFromCatalog(norm: string): FavoriteSymbolMeta | undefined {
  const existing =
    DEMO_SYMBOLS.find((s) => s.name.toUpperCase() === norm) ?? getDemoSymbol(norm);
  if (!existing) return undefined;
  return {
    name: norm,
    displayName: existing.displayName ?? existing.name,
    category: existing.category,
    exchange: existing.exchange,
    initialPrice: existing.initialPrice,
    country: existing.country,
    currency: existing.currency,
  };
}

/**
 * Toggles a ticker in `watchlist_favorites`, persists its metadata so screener stocks
 * survive reloads inside Favorites lists, and notifies all mounted listeners.
 * Returns `true` if the ticker is now favorited, `false` if removed.
 */
export function toggleFavoriteSymbol(
  ticker: string,
  meta?: Partial<FavoriteSymbolMeta>,
): boolean {
  const norm = normalizeFavoriteTicker(ticker);
  if (!norm) return false;

  const current = getFavoritesFromStorage();
  const metaMap = getFavoriteMetaMap();
  const exists = current.includes(norm);

  let nextOrder: string[];
  let nowFavorite: boolean;
  if (exists) {
    nextOrder = current.filter((t) => t !== norm);
    nowFavorite = false;
  } else {
    nextOrder = [norm, ...current];
    nowFavorite = true;
    const inferred = inferMetaFromCatalog(norm);
    const mergedMeta: FavoriteSymbolMeta = {
      name: norm,
      ...(inferred ?? {}),
      ...(metaMap[norm] ?? {}),
      ...(meta ?? {}),
    };
    if (!mergedMeta.category) {
      mergedMeta.category = "STOCKS";
    }
    metaMap[norm] = mergedMeta;

    if (!DEMO_SYMBOLS.some((s) => s.name.toUpperCase() === norm)) {
      registerDynamicSymbol({
        name: norm,
        displayName: mergedMeta.displayName || mergedMeta.description || norm,
        category: mergedMeta.category,
        exchange: mergedMeta.exchange,
        initialPrice: mergedMeta.initialPrice,
        country: mergedMeta.country,
        currency: mergedMeta.currency,
      });
    }
  }

  writeFavoritesToStorage(nextOrder, metaMap);
  return nowFavorite;
}

export function useFavoriteSymbols() {
  const [favoriteOrder, setFavoriteOrder] = useState<string[]>(() => getFavoritesFromStorage());
  const [favoriteMeta, setFavoriteMeta] = useState<Record<string, FavoriteSymbolMeta>>(() =>
    getFavoriteMetaMap(),
  );

  useEffect(() => {
    const sync = () => {
      const order = getFavoritesFromStorage();
      const meta = getFavoriteMetaMap();
      for (const ticker of order) {
        const entry = meta[ticker];
        if (entry && !DEMO_SYMBOLS.some((s) => s.name.toUpperCase() === ticker)) {
          registerDynamicSymbol({
            name: ticker,
            displayName: entry.displayName || entry.description || ticker,
            category: entry.category || "STOCKS",
            exchange: entry.exchange,
            initialPrice: entry.initialPrice,
            country: entry.country,
            currency: entry.currency,
          });
        }
      }
      setFavoriteOrder(order);
      setFavoriteMeta(meta);
    };

    sync();
    const handleStorage = (e: StorageEvent) => {
      if (
        e.key === null ||
        e.key === FAVORITES_STORAGE_KEY ||
        e.key === FAVORITES_META_STORAGE_KEY
      ) {
        sync();
      }
    };
    window.addEventListener("storage", handleStorage);
    window.addEventListener(FAVORITES_UPDATED_EVENT, sync);
    return () => {
      window.removeEventListener("storage", handleStorage);
      window.removeEventListener(FAVORITES_UPDATED_EVENT, sync);
    };
  }, []);

  const favorites = useMemo(() => new Set<string>(favoriteOrder), [favoriteOrder]);

  const isFavorite = useCallback(
    (ticker: string) => favorites.has(normalizeFavoriteTicker(ticker)),
    [favorites],
  );

  const toggleFavorite = useCallback(
    (ticker: string, meta?: Partial<FavoriteSymbolMeta>) => toggleFavoriteSymbol(ticker, meta),
    [],
  );

  return {
    favorites,
    favoriteOrder,
    favoriteMeta,
    isFavorite,
    toggleFavorite,
  };
}
