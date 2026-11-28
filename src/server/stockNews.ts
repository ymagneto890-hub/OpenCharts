export interface StockNewsHeadline {
  title: string;
  publisher: string;
  link: string;
  publishedAt: number | null;
  catalystTag: string | null;
}

export interface StockNewsResponse {
  symbol: string;
  items: StockNewsHeadline[];
  source: "finviz" | "google-rss" | "ibkr" | "mixed";
}

const NEWS_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

const CACHE_TTL_MS = 90_000;
const MONTH_MAP: Record<string, number> = {
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  oct: 9,
  nov: 10,
  dec: 11,
};

export function classifyNewsCatalyst(title: string): string | null {
  const t = title.toLowerCase();
  if (/\b(fda|phase\s?[123]|clinical|trial|drug|approval|clearance|orphan|pdufa|nda|bla)\b/.test(t)) {
    return "FDA / Clínico";
  }
  if (/\b(earnings|eps|revenue|guidance|quarter|q[1-4]|results|beat|miss|profit|sales)\b/.test(t)) {
    return "Resultados";
  }
  if (/\b(partner|collab|agreement|deal|contract|award|license|alliance|order|launch)\b/.test(t)) {
    return "Alianza / Contrato";
  }
  if (/\b(buyout|acqui|merger|takeover|bid|buy-out|acquire)\b/.test(t)) {
    return "Compra / M&A";
  }
  if (/\b(offering|dilution|shelf|atm|warrant|reverse split|secondary|direct offering|s-1|s-3)\b/.test(t)) {
    return "Dilución / R.Split";
  }
  return null;
}

function decodeHtmlEntities(input: string): string {
  return input
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)))
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getNyOffsetMinutes(utcApproxMs: number): number {
  try {
    const dtf = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    const parts = dtf.formatToParts(new Date(utcApproxMs));
    let y = 0;
    let m = 0;
    let day = 0;
    let h = 0;
    let min = 0;
    let s = 0;
    for (const p of parts) {
      if (p.type === "year") y = Number(p.value);
      else if (p.type === "month") m = Number(p.value);
      else if (p.type === "day") day = Number(p.value);
      else if (p.type === "hour") h = Number(p.value) % 24;
      else if (p.type === "minute") min = Number(p.value);
      else if (p.type === "second") s = Number(p.value);
    }
    const nyAsUtc = Date.UTC(y, m - 1, day, h, min, s);
    return Math.round((utcApproxMs - nyAsUtc) / 60_000);
  } catch {
    return 300; // EST fallback (-05:00)
  }
}

function getCurrentNyYmd(nowMs: number): { year: number; month: number; day: number } {
  try {
    const dtf = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    const parts = dtf.formatToParts(new Date(nowMs));
    let year = 0;
    let month = 0;
    let day = 0;
    for (const p of parts) {
      if (p.type === "year") year = Number(p.value);
      else if (p.type === "month") month = Number(p.value) - 1;
      else if (p.type === "day") day = Number(p.value);
    }
    if (year > 0) return { year, month, day };
  } catch {
    // fallback below
  }
  const d = new Date(nowMs);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth(), day: d.getUTCDate() };
}

/**
 * Parses Finviz `#news-table` date cells such as:
 * - "Today 09:47AM"
 * - "Nov-26-26 09:47AM"
 * - "05:54AM" (inherits date from the previous row)
 */
export function parseFinvizNewsTimestamp(
  rawDateCell: string,
  prevDate: { year: number; month: number; day: number } | null,
  nowMs = Date.now(),
): { timestampMs: number | null; date: { year: number; month: number; day: number } | null } {
  const text = rawDateCell.replace(/\s+/g, " ").trim();
  if (!text) return { timestampMs: null, date: prevDate };

  let datePart = prevDate;
  let timeToken = text;

  const todayMatch = /^Today\s+(\d{1,2}:\d{2}\s*[AP]M)$/i.exec(text);
  if (todayMatch) {
    datePart = getCurrentNyYmd(nowMs);
    timeToken = todayMatch[1]!;
  } else {
    const fullMatch = /^([A-Za-z]{3})-(\d{1,2})-(\d{2,4})\s+(\d{1,2}:\d{2}\s*[AP]M)$/i.exec(text);
    if (fullMatch) {
      const mon = MONTH_MAP[fullMatch[1]!.toLowerCase()];
      const day = Number(fullMatch[2]);
      const rawYear = Number(fullMatch[3]);
      const year = rawYear < 100 ? 2000 + rawYear : rawYear;
      if (mon !== undefined && Number.isFinite(day) && Number.isFinite(year)) {
        datePart = { year, month: mon, day };
      }
      timeToken = fullMatch[4]!;
    }
  }

  const timeMatch = /^(\d{1,2}):(\d{2})\s*([AP]M)$/i.exec(timeToken.trim());
  if (!datePart || !timeMatch) {
    return { timestampMs: null, date: datePart };
  }

  let hour = Number(timeMatch[1]);
  const minute = Number(timeMatch[2]);
  const ampm = timeMatch[3]!.toUpperCase();
  if (ampm === "PM" && hour < 12) hour += 12;
  if (ampm === "AM" && hour === 12) hour = 0;

  const wallUtcMs = Date.UTC(datePart.year, datePart.month, datePart.day, hour, minute, 0);
  const offsetMin = getNyOffsetMinutes(wallUtcMs + 300 * 60_000);
  return { timestampMs: wallUtcMs + offsetMin * 60_000, date: datePart };
}

/**
 * Extracts clickable headlines, publishers, ET timestamps, and catalyst tags from
 * Finviz's stock quote page (`https://finviz.com/quote.ashx?t=SYMBOL`).
 */
export function parseFinvizQuoteNewsHtml(
  html: string,
  limit = 20,
  nowMs = Date.now(),
): StockNewsHeadline[] {
  const tableMatch = /<table[^>]*id=["']news-table["'][^>]*>([\s\S]*?)<\/table>/i.exec(html);
  if (!tableMatch) return [];
  const tableBody = tableMatch[1] ?? "";

  const items: StockNewsHeadline[] = [];
  const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let currentDate: { year: number; month: number; day: number } | null = null;
  let rowMatch: RegExpExecArray | null;

  while ((rowMatch = rowRegex.exec(tableBody)) !== null && items.length < limit) {
    const rowHtml = rowMatch[1] ?? "";
    const tdMatches = Array.from(rowHtml.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi));
    if (tdMatches.length < 2) continue;

    const rawDateText = decodeHtmlEntities(tdMatches[0]?.[1] ?? "");
    const contentTd = tdMatches[1]?.[1] ?? "";

    const linkMatch = /<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i.exec(contentTd);
    if (!linkMatch) continue;

    const rawHref = (linkMatch[1] ?? "").trim();
    const title = decodeHtmlEntities(linkMatch[2] ?? "");
    if (!title) continue;

    const link =
      rawHref.startsWith("http://") || rawHref.startsWith("https://")
        ? rawHref
        : rawHref.startsWith("/")
          ? `https://finviz.com${rawHref}`
          : "";

    // Publisher appears in `<div class="news-link-right"><span>(Publisher)</span>` or trailing `<span>`
    const pubMatch =
      /<div[^>]*class=["'][^"']*news-link-right[^"']*["'][^>]*>[\s\S]*?<span[^>]*>([\s\S]*?)<\/span>/i.exec(
        contentTd,
      ) ?? /<span[^>]*>\s*\(([^)]+)\)\s*<\/span>/i.exec(contentTd);
    const publisher = pubMatch
      ? decodeHtmlEntities(pubMatch[1] ?? "").replace(/^\((.*)\)$/, "$1").trim() || "Finviz"
      : "Finviz";

    const parsedTime = parseFinvizNewsTimestamp(rawDateText, currentDate, nowMs);
    currentDate = parsedTime.date;

    items.push({
      title,
      publisher,
      link,
      publishedAt: parsedTime.timestampMs,
      catalystTag: classifyNewsCatalyst(title),
    });
  }

  return items;
}

/** Parses Google News RSS XML as an independent fallback when Finviz has no headlines. */
export function parseGoogleNewsRssXml(xml: string, limit = 15): StockNewsHeadline[] {
  const items: StockNewsHeadline[] = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
  let match: RegExpExecArray | null;

  while ((match = itemRegex.exec(xml)) !== null && items.length < limit) {
    const block = match[1] ?? "";
    const titleMatch = /<title>([\s\S]*?)<\/title>/i.exec(block);
    const linkMatch = /<link>([\s\S]*?)<\/link>/i.exec(block);
    const pubDateMatch = /<pubDate>([\s\S]*?)<\/pubDate>/i.exec(block);
    const sourceMatch = /<source[^>]*>([\s\S]*?)<\/source>/i.exec(block);

    let title = decodeHtmlEntities(titleMatch?.[1] ?? "");
    const rawLink = decodeHtmlEntities(linkMatch?.[1] ?? "");
    const link = rawLink.startsWith("http://") || rawLink.startsWith("https://") ? rawLink : "";
    let publisher = decodeHtmlEntities(sourceMatch?.[1] ?? "");

    if (!publisher && title.includes(" - ")) {
      const idx = title.lastIndexOf(" - ");
      publisher = title.slice(idx + 3).trim();
      title = title.slice(0, idx).trim();
    } else if (publisher && title.endsWith(` - ${publisher}`)) {
      title = title.slice(0, -(publisher.length + 3)).trim();
    }

    if (!title) continue;
    const parsedMs = pubDateMatch ? Date.parse(decodeHtmlEntities(pubDateMatch[1] ?? "")) : NaN;

    items.push({
      title,
      publisher: publisher || "Google News",
      link,
      publishedAt: Number.isFinite(parsedMs) ? parsedMs : null,
      catalystTag: classifyNewsCatalyst(title),
    });
  }

  return items;
}

function dedupeHeadlines(items: StockNewsHeadline[], limit: number): StockNewsHeadline[] {
  const seen = new Set<string>();
  const out: StockNewsHeadline[] = [];
  for (const item of items) {
    const key = item.title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
    if (out.length >= limit) break;
  }
  return out;
}

export class StockNewsProvider {
  private readonly fetchImpl: typeof fetch;
  private readonly cache = new Map<string, { at: number; response: StockNewsResponse }>();
  private readonly inFlight = new Map<string, Promise<StockNewsResponse>>();
  private readonly cacheTtlMs: number;
  private readonly ibkrFallback?: (symbol: string) => Promise<{ items: StockNewsHeadline[] }>;

  constructor(opts?: {
    fetchImpl?: typeof fetch;
    cacheTtlMs?: number;
    ibkrFallback?: (symbol: string) => Promise<{ items: StockNewsHeadline[] }>;
  }) {
    this.fetchImpl = opts?.fetchImpl ?? globalThis.fetch;
    this.cacheTtlMs = opts?.cacheTtlMs ?? CACHE_TTL_MS;
    this.ibkrFallback = opts?.ibkrFallback;
  }

  async getNews(symbol: string, limit = 18): Promise<StockNewsResponse> {
    const cleanSym = symbol.trim().toUpperCase();
    if (!cleanSym) {
      return { symbol: "", items: [], source: "finviz" };
    }

    const now = Date.now();
    const cached = this.cache.get(cleanSym);
    if (cached && now - cached.at < this.cacheTtlMs) {
      return cached.response;
    }

    const existing = this.inFlight.get(cleanSym);
    if (existing) return existing;

    const promise = (async (): Promise<StockNewsResponse> => {
      const finvizItems = await this.fetchFinvizNews(cleanSym, limit).catch(() => [] as StockNewsHeadline[]);
      if (finvizItems.length > 0) {
        const response: StockNewsResponse = {
          symbol: cleanSym,
          items: dedupeHeadlines(finvizItems, limit),
          source: "finviz",
        };
        this.storeCache(cleanSym, response);
        return response;
      }

      const rssItems = await this.fetchGoogleRssNews(cleanSym, limit).catch(() => [] as StockNewsHeadline[]);
      if (rssItems.length > 0) {
        const response: StockNewsResponse = {
          symbol: cleanSym,
          items: dedupeHeadlines(rssItems, limit),
          source: "google-rss",
        };
        this.storeCache(cleanSym, response);
        return response;
      }

      if (this.ibkrFallback) {
        const ibkrRes = await this.ibkrFallback(cleanSym).catch(() => ({ items: [] as StockNewsHeadline[] }));
        if (ibkrRes.items.length > 0) {
          const response: StockNewsResponse = {
            symbol: cleanSym,
            items: dedupeHeadlines(ibkrRes.items, limit),
            source: "ibkr",
          };
          this.storeCache(cleanSym, response);
          return response;
        }
      }

      const empty: StockNewsResponse = { symbol: cleanSym, items: [], source: "finviz" };
      return empty;
    })().finally(() => {
      if (this.inFlight.get(cleanSym) === promise) {
        this.inFlight.delete(cleanSym);
      }
    });

    this.inFlight.set(cleanSym, promise);
    return promise;
  }

  private storeCache(symbol: string, response: StockNewsResponse): void {
    if (this.cache.size >= 120) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(symbol, { at: Date.now(), response });
  }

  private async fetchFinvizNews(symbol: string, limit: number): Promise<StockNewsHeadline[]> {
    // Finviz uses hyphen for share classes (e.g. BRK-B instead of BRK.B)
    const finvizTicker = symbol.replace(/\./g, "-");
    const url = `https://finviz.com/quote.ashx?t=${encodeURIComponent(finvizTicker)}`;
    const res = await this.fetchImpl(url, {
      method: "GET",
      headers: NEWS_HEADERS,
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) {
      throw new Error(`Finviz news HTTP ${res.status}`);
    }
    const html = await res.text();
    return parseFinvizQuoteNewsHtml(html, limit);
  }

  private async fetchGoogleRssNews(symbol: string, limit: number): Promise<StockNewsHeadline[]> {
    const query = `${symbol} stock`;
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
    const res = await this.fetchImpl(url, {
      method: "GET",
      headers: NEWS_HEADERS,
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) {
      throw new Error(`Google News RSS HTTP ${res.status}`);
    }
    const xml = await res.text();
    return parseGoogleNewsRssXml(xml, limit);
  }
}
