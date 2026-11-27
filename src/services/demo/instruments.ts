import type { Symbol } from "../schemas.ts";

export interface DemoSymbol extends Symbol {
  initialPrice?: number;
  precision?: number;
  exchange?: string;
  country?: string;
  currency?: string;
  keywords?: string[];
  isDominanceIndex?: boolean;
  isPerpetual?: boolean;
}

function inferPrecisionFromTick(tickSize: number): number {
  if (!(tickSize > 0) || !Number.isFinite(tickSize)) return 2;
  const raw = tickSize.toString();
  if (raw.includes("e-")) {
    const exp = parseInt(raw.split("e-")[1] ?? "2", 10);
    return Number.isFinite(exp) ? Math.min(8, Math.max(2, exp)) : 2;
  }
  if (raw.includes(".")) {
    const dec = raw.split(".")[1]!.replace(/0+$/, "").length;
    return Math.min(8, Math.max(2, dec));
  }
  return 2;
}

export function inferTickSizeFromPrice(price: number): number {
  if (!(price > 0) || !Number.isFinite(price)) return 0.01;
  if (price >= 100) return 0.01;
  if (price >= 10) return 0.001;
  if (price >= 0.5) return 0.0001;
  if (price >= 0.01) return 0.00001;
  if (price >= 0.0001) return 0.000001;
  return 0.00000001;
}

function makeInstrument(opts: {
  name: string;
  displayName: string;
  category: string;
  tickSize: number;
  initialPrice: number;
  exchange?: string;
  country?: string;
  currency?: string;
  keywords?: string[];
  maxLeverage?: number;
  marginPercent?: number;
  contractSize?: number;
  isDominanceIndex?: boolean;
  isPerpetual?: boolean;
}): DemoSymbol {
  const precision = inferPrecisionFromTick(opts.tickSize);
  return {
    id: opts.name,
    name: opts.name,
    displayName: opts.displayName,
    category: opts.category,
    contractSize: opts.contractSize ?? 1,
    tickSize: opts.tickSize,
    tickValue: opts.tickSize,
    marginPercent: opts.marginPercent ?? (opts.category === "CRYPTO" || opts.category === "FUTURES" ? 1 : 5),
    maxLeverage: opts.maxLeverage ?? (opts.category === "CRYPTO" || opts.category === "FUTURES" ? 100 : 20),
    commission: 0,
    swapLong: 0,
    swapShort: 0,
    tradingHoursStart: null,
    tradingHoursEnd: null,
    isActive: true,
    initialPrice: opts.initialPrice,
    precision,
    exchange: opts.exchange,
    country: opts.country,
    currency: opts.currency,
    keywords: opts.keywords,
    isDominanceIndex: opts.isDominanceIndex,
    isPerpetual: opts.isPerpetual,
  };
}

function stock(
  name: string,
  displayName: string,
  initialPrice: number,
  exchange = "NASDAQ",
  keywords: string[] = [],
): DemoSymbol {
  return makeInstrument({
    name,
    displayName,
    category: "STOCKS",
    tickSize: 0.01,
    initialPrice,
    exchange,
    country: "United States",
    currency: "USD",
    keywords: ["bolsa", "acciones", "stocks", "equities", "us", exchange.toLowerCase(), ...keywords],
    maxLeverage: 20,
    marginPercent: 5,
  });
}

function crypto(
  name: string,
  displayName: string,
  tickSize: number,
  initialPrice: number,
  keywords: string[] = [],
  extra: Partial<Pick<DemoSymbol, "isDominanceIndex" | "exchange">> = {},
): DemoSymbol {
  return makeInstrument({
    name,
    displayName,
    category: "CRYPTO",
    tickSize,
    initialPrice,
    exchange: extra.exchange ?? "CRYPTO",
    keywords: ["crypto", "cripto", ...keywords],
    isDominanceIndex: extra.isDominanceIndex,
  });
}

function cryptoEur(
  name: string,
  displayName: string,
  tickSize: number,
  initialPrice: number,
  keywords: string[] = [],
): DemoSymbol {
  return makeInstrument({
    name,
    displayName,
    category: "CRYPTO",
    tickSize,
    initialPrice,
    exchange: "CRYPTO",
    keywords: ["crypto", "cripto", "eur", "euro", ...keywords],
  });
}

export function isEurSymbol(sym: { name: string }): boolean {
  const upper = sym.name.toUpperCase();
  return upper.endsWith("EUR") || upper.startsWith("EUR");
}

function cryptoPerp(
  name: string,
  displayName: string,
  tickSize: number,
  initialPrice: number,
  keywords: string[] = [],
  maxLeverage = 100,
): DemoSymbol {
  return makeInstrument({
    name,
    displayName,
    category: "FUTURES",
    tickSize,
    initialPrice,
    exchange: "PERP",
    keywords: ["futuros", "futures", "perpetuo", "perpetual", "perp", "crypto", ...keywords],
    maxLeverage,
    marginPercent: 1,
    isPerpetual: true,
  });
}

function indexInst(
  name: string,
  displayName: string,
  initialPrice: number,
  exchange = "INDEX",
  keywords: string[] = [],
): DemoSymbol {
  return makeInstrument({
    name,
    displayName,
    category: "INDICES",
    tickSize: 0.01,
    initialPrice,
    exchange,
    keywords: ["indice", "indices", "bolsa", "index", ...keywords],
    maxLeverage: 50,
    marginPercent: 2,
  });
}

function commodity(
  name: string,
  displayName: string,
  tickSize: number,
  initialPrice: number,
  keywords: string[] = [],
): DemoSymbol {
  return makeInstrument({
    name,
    displayName,
    category: "COMMODITIES",
    tickSize,
    initialPrice,
    exchange: "COMMODITIES",
    keywords: ["materias primas", "commodities", "futuros", ...keywords],
    maxLeverage: 50,
    marginPercent: 2,
  });
}

function forex(
  name: string,
  displayName: string,
  tickSize: number,
  initialPrice: number,
  keywords: string[] = [],
): DemoSymbol {
  return makeInstrument({
    name,
    displayName,
    category: "FOREX",
    tickSize,
    initialPrice,
    exchange: "FOREX",
    keywords: ["forex", "divisas", "fx", "monedas", ...keywords],
    maxLeverage: 100,
    marginPercent: 1,
  });
}

export const DEMO_SYMBOLS: DemoSymbol[] = [
  // ── Core US Consolidated Equities & ETFs (NYSE · NASDAQ · AMEX via IBKR) ──
  stock("SPY", "SPDR S&P 500 ETF Trust", 590.0, "ARCA", ["spy", "sp500", "etf", "index"]),
  stock("QQQ", "Invesco QQQ Trust", 505.0, "NASDAQ", ["qqq", "nasdaq", "etf", "tech"]),
  stock("IWM", "iShares Russell 2000 ETF", 225.0, "ARCA", ["iwm", "small caps", "russell", "etf"]),
  stock("DIA", "SPDR Dow Jones Industrial Average ETF", 435.0, "ARCA", ["dia", "dow", "etf"]),
  stock("AAPL", "Apple Inc.", 228.5, "NASDAQ", ["apple", "iphone", "tech", "eeuu"]),
  stock("MSFT", "Microsoft Corp.", 426.2, "NASDAQ", ["microsoft", "windows", "ai", "tech"]),
  stock("NVDA", "NVIDIA Corp.", 138.4, "NASDAQ", ["nvidia", "gpu", "ai", "semiconductores"]),
  stock("AMZN", "Amazon.com Inc.", 206.8, "NASDAQ", ["amazon", "ecommerce", "aws"]),
  stock("GOOGL", "Alphabet Inc. (Google)", 178.9, "NASDAQ", ["google", "alphabet", "ai", "tech"]),
  stock("META", "Meta Platforms", 585.3, "NASDAQ", ["meta", "facebook", "instagram", "ai"]),
  stock("TSLA", "Tesla Inc.", 318.6, "NASDAQ", ["tesla", "ev", "coches electricos", "elon"]),
  stock("AMD", "Advanced Micro Devices", 146.2, "NASDAQ", ["amd", "chips", "semiconductores"]),
  stock("NFLX", "Netflix Inc.", 842.0, "NASDAQ", ["netflix", "streaming"]),
  stock("AVGO", "Broadcom Inc.", 174.5, "NASDAQ", ["broadcom", "semiconductores"]),
  stock("SMCI", "Super Micro Computer", 42.0, "NASDAQ", ["smci", "ai", "servers"]),
  stock("MU", "Micron Technology", 104.0, "NASDAQ", ["micron", "chips"]),
  stock("ARM", "Arm Holdings", 148.0, "NASDAQ", ["arm", "semiconductores"]),
  stock("MRVL", "Marvell Technology", 96.0, "NASDAQ", ["mrvl", "chips"]),
  stock("INTC", "Intel Corp.", 24.5, "NASDAQ", ["intel", "chips"]),
  stock("BRK.B", "Berkshire Hathaway", 464.1, "NYSE", ["berkshire", "buffett"]),
  stock("JPM", "JPMorgan Chase", 242.3, "NYSE", ["jpmorgan", "banca", "finanzas"]),
  stock("BAC", "Bank of America", 44.5, "NYSE", ["bac", "banca"]),
  stock("GS", "Goldman Sachs", 565.0, "NYSE", ["goldman", "banca"]),
  stock("V", "Visa Inc.", 310.4, "NYSE", ["visa", "pagos"]),
  stock("MA", "Mastercard Inc.", 524.8, "NYSE", ["mastercard", "pagos"]),
  stock("WMT", "Walmart Inc.", 86.2, "NYSE", ["walmart", "retail"]),
  stock("DIS", "Walt Disney Co.", 112.4, "NYSE", ["disney"]),
  stock("BA", "Boeing Co.", 152.0, "NYSE", ["boeing", "aerospace"]),
  stock("XOM", "Exxon Mobil Corp.", 118.0, "NYSE", ["exxon", "energia", "oil"]),
  stock("COIN", "Coinbase Global", 268.9, "NASDAQ", ["coinbase", "exchange"]),
  stock("MSTR", "MicroStrategy / Strategy", 342.1, "NASDAQ", ["microstrategy", "strategy"]),
  stock("PLTR", "Palantir Technologies", 62.4, "NASDAQ", ["palantir", "ai", "defensa"]),
  stock("UBER", "Uber Technologies", 72.1, "NYSE", ["uber", "movilidad"]),
  stock("HOOD", "Robinhood Markets", 36.5, "NASDAQ", ["hood", "broker"]),
  stock("SOFI", "SoFi Technologies", 14.2, "NASDAQ", ["sofi", "fintech"]),
  stock("MARA", "MARA Holdings", 21.5, "NASDAQ", ["mara", "mining"]),
  stock("RIOT", "Riot Platforms", 12.4, "NASDAQ", ["riot", "mining"]),
  stock("IONQ", "IonQ Inc.", 34.5, "NYSE", ["ionq", "quantum"]),
  stock("BABA", "Alibaba Group", 88.4, "NYSE", ["alibaba", "china"]),
  stock("TSM", "TSMC (Taiwan Semi)", 192.6, "NYSE", ["tsmc", "semiconductores", "chips"]),
  stock("ASML", "ASML Holding", 698.4, "NASDAQ", ["asml", "chips"]),

  // ── Secondary Instruments (Offline / Replay Test Fixtures) ──
  crypto("BTCUSD", "Bitcoin", 0.01, 90_000, ["btc", "bitcoin", "major"]),
  crypto("ETHUSD", "Ethereum", 0.01, 3_150, ["eth", "ethereum", "ether", "l1"]),
  crypto("SOLUSD", "Solana", 0.01, 185, ["sol", "solana", "l1"]),
  crypto("BNBUSD", "BNB", 0.01, 610, ["bnb"]),
  crypto("XRPUSD", "XRP", 0.0001, 2.35, ["xrp", "ripple"]),
  crypto("ADAUSD", "Cardano", 0.0001, 0.78, ["ada", "cardano"]),
  crypto("DOGEUSD", "Dogecoin", 0.00001, 0.28, ["doge", "meme", "dogecoin"]),
  crypto("AVAXUSD", "Avalanche", 0.01, 32.4, ["avax", "avalanche", "l1"]),
  crypto("LINKUSD", "Chainlink", 0.001, 18.6, ["link", "chainlink", "oracle", "defi"]),
  crypto("PEPEUSD", "Pepe", 0.00000001, 0.0000165, ["pepe", "meme"]),
  cryptoEur("BTCEUR", "Bitcoin / EUR", 0.01, 85_000, ["btc", "bitcoin"]),
  cryptoEur("ETHEUR", "Ethereum / EUR", 0.01, 2_980, ["eth", "ethereum"]),
  cryptoEur("SOLEUR", "Solana / EUR", 0.01, 175, ["sol", "solana"]),
  cryptoPerp("BTCUSDT.P", "Bitcoin Perpetuo", 0.1, 90_000, ["btc", "bitcoin"], 125),
  cryptoPerp("ETHUSDT.P", "Ethereum Perpetuo", 0.01, 3_150, ["eth", "ethereum"], 100),
  stock("SAN", "Banco Santander", 4.68, "BME", ["santander", "españa", "ibex", "banca"]),
  stock("BBVA", "BBVA", 9.74, "BME", ["bbva", "españa", "ibex", "banca"]),
  stock("ITX", "Inditex (Zara)", 52.8, "BME", ["inditex", "zara", "españa", "ibex"]),
  crypto(
    "BTC.D",
    "Dominancia de Bitcoin (BTC.D %)",
    0.01,
    58.45,
    ["btc.d", "btcd", "dominancia", "bitcoin dominance"],
    { isDominanceIndex: true, exchange: "CRYPTOCAP" },
  ),
  indexInst("SPX500", "S&P 500 Index", 5940.0, "INDEX", ["sp500", "s&p"]),
  indexInst("NAS100", "Nasdaq 100 Index", 20750.0, "NASDAQ", ["nasdaq", "ndx"]),
  indexInst("GER40", "DAX 40 Alemania", 19280.0, "XETR", ["dax", "dax 40", "alemania", "ger40"]),
  indexInst("ESP35", "IBEX 35 España", 11640.0, "BME", ["ibex", "ibex 35", "espana", "españa", "madrid"]),
  commodity("XAUUSD", "Oro / Gold Spot", 0.01, 2635.0, ["oro", "gold", "xau"]),
  commodity("XAUEUR", "Oro / Euro (Gold EUR)", 0.01, 2490.0, ["oro", "gold", "xau"]),
  commodity("XAGUSD", "Plata / Silver Spot", 0.001, 30.85, ["plata", "silver", "xag"]),
  commodity("XAGEUR", "Plata / Euro (Silver EUR)", 0.001, 29.15, ["plata", "silver", "xag", "eur", "euro", "metal"]),
  commodity("USOIL", "Petróleo WTI Crude", 0.01, 69.2, ["petroleo", "oil", "wti", "crudo", "energia"]),
  commodity("UKOIL", "Petróleo Brent Crude", 0.01, 73.1, ["brent", "petroleo", "oil", "energia"]),
  forex("EURUSD", "Euro / US Dollar", 0.0001, 1.058, ["euro", "dolar", "eur", "usd"]),
  forex("GBPUSD", "British Pound / US Dollar", 0.0001, 1.268, ["libra", "gbp"]),
  forex("USDJPY", "US Dollar / Japanese Yen", 0.001, 154.6, ["yen", "jpy"]),
  forex("EURCHF", "Euro / Swiss Franc", 0.0001, 0.935, ["eur", "chf"]),
];

export const DEMO_SYMBOL_NAMES = DEMO_SYMBOLS.map((s) => s.name);

const SYMBOL_CHANGE_LISTENERS = new Set<() => void>();

export function subscribeSymbolsChanged(cb: () => void): () => void {
  SYMBOL_CHANGE_LISTENERS.add(cb);
  return () => {
    SYMBOL_CHANGE_LISTENERS.delete(cb);
  };
}

function notifySymbolsChanged(): void {
  for (const cb of SYMBOL_CHANGE_LISTENERS) {
    try {
      cb();
    } catch {
      // ignore listener errors
    }
  }
}

/**
 * Registers a dynamically discovered instrument (for example, any US equity returned by IBKR)
 * so the paper-trading engine, feed, and chart resolve it cleanly.
 */
export function registerDynamicSymbol(input: {
  name: string;
  displayName?: string;
  category?: string;
  initialPrice?: number;
  tickSize?: number;
  exchange?: string;
  country?: string;
  currency?: string;
  keywords?: string[];
  isPerpetual?: boolean;
}): DemoSymbol {
  const normalized = input.name.trim().toUpperCase();
  const existing = DEMO_SYMBOLS.find((s) => s.name.toUpperCase() === normalized);
  if (existing) {
    if (
      typeof input.initialPrice === "number" &&
      Number.isFinite(input.initialPrice) &&
      input.initialPrice > 0 &&
      !existing.isDominanceIndex
    ) {
      existing.initialPrice = input.initialPrice;
    }
    if (existing.category === "STOCKS") {
      if (input.displayName) existing.displayName = input.displayName;
      if (input.exchange) existing.exchange = input.exchange;
      if (input.country !== undefined) existing.country = input.country;
      if (input.currency) existing.currency = input.currency;
      if (typeof input.tickSize === "number" && Number.isFinite(input.tickSize) && input.tickSize > 0) {
        existing.tickSize = input.tickSize;
      } else if (
        typeof input.initialPrice === "number" &&
        Number.isFinite(input.initialPrice) &&
        input.initialPrice > 0
      ) {
        existing.tickSize = input.initialPrice >= 1 ? 0.01 : 0.0001;
      }
    } else {
      if (input.displayName && (!existing.displayName || existing.displayName === existing.name)) {
        existing.displayName = input.displayName;
      }
      if (input.exchange && !existing.exchange) existing.exchange = input.exchange;
      if (input.country && !existing.country) existing.country = input.country;
      if (input.currency && !existing.currency) existing.currency = input.currency;
    }
    return existing;
  }

  const initialPrice =
    typeof input.initialPrice === "number" && Number.isFinite(input.initialPrice) && input.initialPrice > 0
      ? input.initialPrice
      : 1;
  const isPerp = Boolean(input.isPerpetual);
  const resolvedCategory =
    input.category ??
    (isPerp
      ? "FUTURES"
      : normalized.endsWith("USD") || normalized.endsWith("USDT") || normalized.endsWith("EUR")
        ? "CRYPTO"
        : "STOCKS");
  const isStock = resolvedCategory === "STOCKS";
  const tickSize =
    input.tickSize ??
    (isStock ? (initialPrice >= 1 ? 0.01 : 0.0001) : inferTickSizeFromPrice(initialPrice));

  const created = makeInstrument({
    name: normalized,
    displayName: input.displayName ?? normalized,
    category: resolvedCategory,
    tickSize,
    initialPrice,
    exchange: input.exchange ?? (isStock ? "SMART" : isPerp ? "PERP" : "EXCHANGE"),
    country: input.country ?? (isStock ? "United States" : undefined),
    currency: input.currency ?? "USD",
    maxLeverage: isStock ? 20 : undefined,
    marginPercent: isStock ? 5 : undefined,
    keywords:
      input.keywords ??
      ["bolsa", "acciones", "stocks", "eeuu", "us", "ibkr", normalized.toLowerCase()],
    isPerpetual: isPerp,
  });
  DEMO_SYMBOLS.push(created);
  DEMO_SYMBOL_NAMES.push(created.name);
  notifySymbolsChanged();
  return created;
}

const KNOWN_FOREX_OR_COMMODITY_SET = new Set([
  "XAUUSD",
  "XAGUSD",
  "XAUEUR",
  "XAGEUR",
  "EURUSD",
  "GBPUSD",
  "AUDUSD",
  "NZDUSD",
  "USDEUR",
  "GBPEUR",
  "CHFEUR",
  "AUDEUR",
  "CADEUR",
  "NZDEUR",
  "JPYEUR",
]);

export function getDemoSymbol(name: string): DemoSymbol | undefined {
  if (!name) return undefined;
  const upper = name.trim().toUpperCase();
  const compact = upper.replace(/[\s/_-]+/g, "");
  const found = DEMO_SYMBOLS.find(
    (s) => s.name.toUpperCase() === upper || s.name.toUpperCase() === compact,
  );
  if (found) return found;

  // Resolve generic perpetual alias tickers (e.g. "ARBUSDT.P", "BTCUSDTPERP", "ETH-PERP")
  const perpMatch =
    upper.match(/^([A-Z0-9]{2,16})USDT\.P$/) ??
    upper.match(/^([A-Z0-9]{2,16})USDTPERP$/) ??
    upper.match(/^([A-Z0-9]{2,16})-PERP$/);
  if (perpMatch) {
    const base = perpMatch[1]!;
    const canonicalPerp = `${base}USDT.P`;
    const existingPerp = DEMO_SYMBOLS.find((s) => s.name.toUpperCase() === canonicalPerp);
    if (existingPerp) return existingPerp;
    return registerDynamicSymbol({
      name: canonicalPerp,
      displayName: `${base} Perpetuo (USDT-M)`,
      category: "FUTURES",
      initialPrice: 1,
      exchange: "PERP",
      isPerpetual: true,
    });
  }

  // Resolve generic altcoin/EUR aliases (e.g. "KASPAEUR", "ETH/EUR")
  if (
    /^[A-Z0-9]{2,12}EUR$/.test(compact) &&
    !KNOWN_FOREX_OR_COMMODITY_SET.has(compact)
  ) {
    const base = compact.slice(0, -3);
    const canonicalName = `${base}EUR`;
    const canonical = DEMO_SYMBOLS.find((s) => s.name.toUpperCase() === canonicalName);
    if (canonical) return canonical;
    return registerDynamicSymbol({
      name: canonicalName,
      displayName: `${base} / EUR`,
      category: "CRYPTO",
      initialPrice: 1,
      exchange: "CRYPTO",
    });
  }

  // Resolve generic *USD / *USDT aliases without overwriting existing initialPrice
  if (
    /^[A-Z0-9]{2,12}(USD|USDT)$/.test(compact) &&
    !KNOWN_FOREX_OR_COMMODITY_SET.has(compact)
  ) {
    const base = compact.endsWith("USDT") ? compact.slice(0, -4) : compact.slice(0, -3);
    const canonicalName = `${base}USD`;
    const canonical = DEMO_SYMBOLS.find((s) => s.name.toUpperCase() === canonicalName);
    if (canonical) return canonical;
    return registerDynamicSymbol({
      name: canonicalName,
      displayName: `${base} / USD`,
      category: "CRYPTO",
      initialPrice: 1,
      exchange: "CRYPTO",
    });
  }

  return undefined;
}

function normalizeSearchToken(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}

export function searchDemoSymbols(
  query: string,
  category?: string | null,
  customList?: DemoSymbol[],
): DemoSymbol[] {
  const source = customList ?? DEMO_SYMBOLS;
  const q = normalizeSearchToken(query);

  const catFiltered = source.filter((s) => {
    if (s.isActive === false) return false;
    if (!category || category === "ALL") return true;
    if (category.toUpperCase() === "EUR") return isEurSymbol(s);
    return s.category.toUpperCase() === category.toUpperCase();
  });

  if (!q) return catFiltered;

  const qCompact = q.replace(/[\s/_-]+/g, "");
  const scored: Array<{ sym: DemoSymbol; score: number }> = [];
  for (const sym of catFiltered) {
    const nameNorm = normalizeSearchToken(sym.name);
    const nameCompact = nameNorm.replace(/[\s/_.-]+/g, "");
    const dispNorm = normalizeSearchToken(sym.displayName ?? "");
    const dispCompact = dispNorm.replace(/[\s/_.-]+/g, "");
    const catNorm = normalizeSearchToken(sym.category);
    const exNorm = normalizeSearchToken(sym.exchange ?? "");
    const kwNorm = (sym.keywords ?? []).map(normalizeSearchToken);

    let score = 0;
    if (nameNorm === q || nameCompact === q.replace(/\./g, "") || (qCompact && nameCompact === qCompact)) {
      score = 1000;
    } else if (nameNorm.startsWith(q) || (qCompact && nameCompact.startsWith(qCompact))) {
      score = 700;
    } else if (nameNorm.includes(q) || (qCompact && nameCompact.includes(qCompact))) {
      score = 500;
    } else if (dispNorm.startsWith(q) || (qCompact && dispCompact.startsWith(qCompact))) {
      score = 450;
    } else if (dispNorm.includes(q) || (qCompact && dispCompact.includes(qCompact))) {
      score = 350;
    } else if (kwNorm.some((k) => k === q)) {
      score = 320;
    } else if (kwNorm.some((k) => k.includes(q))) {
      score = 250;
    } else if (exNorm.includes(q) || catNorm.includes(q)) {
      score = 150;
    }

    if (score > 0) scored.push({ sym, score });
  }

  scored.sort((a, b) => b.score - a.score || a.sym.name.localeCompare(b.sym.name));
  return scored.map((item) => item.sym);
}

const stockDiscoveryCache = new Map<string, { at: number; items: DemoSymbol[] }>();
const STOCK_DISCOVERY_TTL_MS = 30_000;

/**
 * Discovers any US consolidated equity matching `query` via IBKR (`/__api/stock-search`),
 * registers it in `DEMO_SYMBOLS`, and returns sorted matches.
 */
export async function discoverRemoteStocks(query: string): Promise<DemoSymbol[]> {
  const q = query.trim();
  if (q.length < 1 || typeof fetch !== "function") return [];

  const cacheKey = q.toUpperCase();
  const cached = stockDiscoveryCache.get(cacheKey);
  if (cached && Date.now() - cached.at < STOCK_DISCOVERY_TTL_MS) {
    return cached.items;
  }

  try {
    const res = await fetch(`/__api/stock-search?q=${encodeURIComponent(q)}`);
    if (!res.ok) return [];
    const data = (await res.json()) as {
      items?: Array<{
        ticker?: string;
        description?: string;
        exchange?: string;
        country?: string;
        currency?: string;
      }>;
    };
    const rawItems = Array.isArray(data?.items) ? data.items : [];

    const sorted = [...rawItems]
      .filter((it) => typeof it.ticker === "string" && it.ticker.trim().length > 0)
      .sort((a, b) => {
        const ta = a.ticker!.trim().toUpperCase();
        const tb = b.ticker!.trim().toUpperCase();
        const rank = (t: string) =>
          t === cacheKey ? 0 : t.startsWith(cacheKey) ? 1 : t.includes(cacheKey) ? 2 : 3;
        return rank(ta) - rank(tb);
      });

    const registered: DemoSymbol[] = [];
    for (const item of sorted) {
      const ticker = item.ticker!.trim().toUpperCase();
      const rawItem = item as { close?: unknown };
      const close =
        typeof rawItem.close === "number" && Number.isFinite(rawItem.close) && rawItem.close > 0
          ? rawItem.close
          : 1;
      const sym = registerDynamicSymbol({
        name: ticker,
        displayName: item.description?.trim() || ticker,
        category: "STOCKS",
        initialPrice: close,
        tickSize: close >= 1 ? 0.01 : 0.0001,
        exchange: item.exchange?.trim() || "SMART",
        country: item.country || "United States",
        currency: item.currency || "USD",
      });
      registered.push(sym);
    }

    stockDiscoveryCache.set(cacheKey, { at: Date.now(), items: registered });
    return registered;
  } catch {
    return [];
  }
}

export function clearStockDiscoveryCache(): void {
  stockDiscoveryCache.clear();
  cryptoDiscoveryCache.clear();
}

const cryptoDiscoveryCache = new Map<string, { at: number; items: DemoSymbol[] }>();

/**
 * Discovers live cryptocurrency Spot, EUR, and Perpetual pairs matching `query`
 * via `/__api/crypto-search` (Binance Spot + USD-M Futures), registers them in
 * `DEMO_SYMBOLS`, and returns sorted matches.
 */
export async function discoverRemoteCrypto(query: string): Promise<DemoSymbol[]> {
  const q = query.trim();
  if (q.length < 1 || typeof fetch !== "function") return [];

  const cacheKey = q.toUpperCase();
  const cached = cryptoDiscoveryCache.get(cacheKey);
  if (cached && Date.now() - cached.at < STOCK_DISCOVERY_TTL_MS) {
    return cached.items;
  }

  try {
    const res = await fetch(`/__api/crypto-search?q=${encodeURIComponent(q)}`);
    if (!res.ok) return [];
    const data = (await res.json()) as {
      items?: Array<{
        ticker?: string;
        displayName?: string;
        category?: "CRYPTO" | "FUTURES";
        exchange?: string;
        currency?: string;
        isPerpetual?: boolean;
        initialPrice?: number;
      }>;
    };
    const rawItems = Array.isArray(data?.items) ? data.items : [];
    const registered: DemoSymbol[] = [];
    for (const item of rawItems) {
      const ticker = item.ticker?.trim().toUpperCase();
      if (!ticker) continue;
      const sym = registerDynamicSymbol({
        name: ticker,
        displayName: item.displayName?.trim() || ticker,
        category: item.category === "FUTURES" || item.isPerpetual ? "FUTURES" : "CRYPTO",
        initialPrice: item.initialPrice,
        exchange: item.exchange?.trim() || (item.isPerpetual ? "BINANCE PERP" : "BINANCE"),
        currency: item.currency || "USD",
        isPerpetual: Boolean(item.isPerpetual),
        keywords: ["crypto", "cripto", ticker.toLowerCase()],
      });
      registered.push(sym);
    }
    cryptoDiscoveryCache.set(cacheKey, { at: Date.now(), items: registered });
    return registered;
  } catch {
    return [];
  }
}
