import { describe, expect, it, vi } from "vitest";
import {
  buildFinvizFilterCodes,
  buildPublicFinvizUrl,
  FinvizScreener,
  parseFinvizScreenerHtml,
} from "../server/finvizScreener";
import { buildScreenerRequest, DEFAULT_SCREENER_FILTERS } from "../services/stockScreener";

function makeFinvizHtml(rows: unknown[], totalCount = rows.length, pageSize = 20): string {
  const ssrPayload = {
    url: "/screener/stocks",
    data: {
      rows,
      totalCount,
      firstRow: 0,
      pageSize,
    },
  };
  return `<!DOCTYPE html><html><body><script type="application/json" data-ssr-props="ssr-island-1">${JSON.stringify(
    ssrPayload,
  )}</script></body></html>`;
}

describe("Finviz Stock Screener Scraper", () => {
  it("builds exact Finviz filter codes and public URL matching sh_float_u20,ta_change_u10,sh_price_u20,sh_relvol_o5&ft=3", () => {
    const req = buildScreenerRequest(DEFAULT_SCREENER_FILTERS);
    const codes = buildFinvizFilterCodes(req);
    expect(codes).toEqual([
      "sh_float_u20",
      "ta_change_u10",
      "sh_price_u20",
      "sh_relvol_o5",
    ]);
    expect(buildPublicFinvizUrl(req)).toBe(
      "https://finviz.com/screener/stocks?f=sh_float_u20%2Cta_change_u10%2Csh_price_u20%2Csh_relvol_o5&ft=3",
    );
  });

  it("parses Finviz SSR JSON rows accurately with Float, RelVol, Price, Change, Volume, MarketCap, and Company", () => {
    const html = makeFinvizHtml(
      [
        {
          text: {
            ticker: "ALGS",
            company: "Aligos Therapeutics Inc",
            sector: "Healthcare",
            industry: "Biotechnology",
            country: "USA",
          },
          numbers: {
            marketCap: 15.93,
            sharesOutstanding2: 7.05,
            sharesFloat: 5.42,
            price: 2.26,
            change: 51.6778,
            volume: 32_914_979,
            relativeVolume: 48.25,
          },
        },
        {
          text: {
            ticker: "BGLC",
            company: "BioNexus Gene Lab Corp",
            sector: "Basic Materials",
            country: "Malaysia",
          },
          numbers: {
            marketCap: 4.4,
            sharesFloat: 1.85,
            price: 1.26,
            change: 113.5593,
            volume: 55_339_199,
            relativeVolume: 6961.531,
          },
        },
      ],
      18,
    );

    const parsed = parseFinvizScreenerHtml(html);
    expect(parsed.totalCount).toBe(18);
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.rows[0]).toMatchObject({
      ticker: "ALGS",
      description: "Aligos Therapeutics Inc",
      close: 2.26,
      change: 51.68,
      volume: 32_914_979,
      relativeVolume: 48.25,
      floatShares: 5_420_000,
      marketCap: 15_930_000,
      sector: "Healthcare",
      country: "United States",
    });
    expect(parsed.rows[1]).toMatchObject({
      ticker: "BGLC",
      floatShares: 1_850_000,
      country: "Malaysia",
    });
  });

  it("fetches, caches, and post-filters custom UI bounds cleanly", async () => {
    const html = makeFinvizHtml([
      {
        text: { ticker: "ALGS", company: "Aligos Therapeutics Inc", sector: "Healthcare", country: "USA" },
        numbers: { sharesFloat: 5.4, price: 2.26, change: 51.68, volume: 32_900_000, relativeVolume: 48.2 },
      },
      {
        text: { ticker: "MICRO", company: "Tiny Float Co", sector: "Technology", country: "USA" },
        numbers: { sharesFloat: 0.4, price: 3.1, change: 15.2, volume: 2_100_000, relativeVolume: 7.4 },
      },
    ]);

    const fetchMock = vi.fn(async () => new Response(html, { status: 200 }));
    const screener = new FinvizScreener({
      fetchImpl: fetchMock as unknown as typeof fetch,
      cacheTtlMs: 30_000,
    });

    const req = buildScreenerRequest(DEFAULT_SCREENER_FILTERS);
    const res1 = await screener.scan(req);
    expect(res1.source).toBe("finviz");
    expect(res1.items.map((r) => r.ticker)).toEqual(["ALGS", "MICRO"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Cache hit within TTL does not re-fetch Finviz
    const res2 = await screener.scan(req);
    expect(res2.items).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Custom floatMin (e.g. >= 1M) filters out 0.4M float row cleanly
    const resCustom = await screener.scan({ ...req, floatMin: 1_000_000 });
    expect(resCustom.items.map((r) => r.ticker)).toEqual(["ALGS"]);
  });
});
