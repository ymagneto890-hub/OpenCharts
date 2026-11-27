import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  FMP_SHARES_FLOAT_BASE_URL,
  FmpFloatProvider,
  getNyDateKey,
  parseFmpSharesFloatPayload,
} from "../server/fmpFloatProvider";
import {
  createDefaultScreenerPipeline,
  type ScreenerCandidateRow,
} from "../lib/screenerPipeline";
import { DEFAULT_SCREENER_FILTERS, type ScreenerFilters } from "../services/stockScreener";

const PHASE3_TEST_FILTERS: ScreenerFilters = {
  ...DEFAULT_SCREENER_FILTERS,
  onlyPremarket: true,
  priceMin: 1,
  priceMax: 20,
  floatMin: 800_000,
  floatMax: 20_000_000,
  changeMin: 10,
  relVolMin: 5,
};

function makeCandidate(
  ticker: string,
  overrides: Partial<ScreenerCandidateRow> = {},
): ScreenerCandidateRow {
  return {
    id: `SMART:${ticker}`,
    ticker,
    description: `${ticker} Corp.`,
    close: 4.5,
    change: 24.5,
    volume: 1_800_000,
    relativeVolume: 8.4,
    marketCap: 45_000_000,
    floatShares: null,
    sector: "Health Technology",
    exchange: "NASDAQ",
    premarketClose: 4.5,
    premarketChange: 24.5,
    premarketVolume: 950_000,
    ...overrides,
  };
}

function makeTempCachePath(name: string): { dir: string; file: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openchart-fmp-"));
  return { dir, file: path.join(dir, name) };
}

function fmpJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("Phase 3 — FMP shares-float connector, persistent daily cache & final filter", () => {
  it("queries FMP ONLY for IBKR candidates that already passed Price $1-$20, Change > +10%, RelVol >= 5x", async () => {
    const requestedSymbols: string[] = [];
    const requestedUrls: string[] = [];

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      requestedUrls.push(url);
      const parsed = new URL(url);
      const sym = parsed.searchParams.get("symbol") ?? "";
      requestedSymbols.push(sym);
      return fmpJsonResponse([
        {
          symbol: sym,
          date: "2026-11-26 09:00:00",
          freeFloat: 78.2,
          floatShares: sym === "PASSA" ? 3_500_000 : 12_000_000,
          outstandingShares: 15_000_000,
        },
      ]);
    });

    const fmp = new FmpFloatProvider({
      apiKey: "test-secret-key",
      fetchImpl: fetchMock as unknown as typeof fetch,
      nowFn: () => Date.UTC(2026, 10, 26, 15, 0, 0),
    });

    const pipeline = createDefaultScreenerPipeline<ScreenerCandidateRow>();
    pipeline.registerEnricher(fmp.createEnricher());

    const ibkrCandidates: ScreenerCandidateRow[] = [
      // Fails Price < $1
      makeCandidate("PENNY", { close: 0.75 }),
      // Fails Price > $20
      makeCandidate("EXPENS", { close: 22.4 }),
      // Fails strict Change > +10% (exact 10.0 is excluded)
      makeCandidate("EXACT10", { change: 10.0 }),
      // Fails Change <= +10%
      makeCandidate("LOWCHG", { change: 6.2 }),
      // Fails RelVol < 5x
      makeCandidate("LOWRV", { relativeVolume: 4.95 }),
      // Fails Pre-Market volume when onlyPremarket=true
      makeCandidate("NOPREM", { premarketVolume: 0 }),
      // Passes all IBKR dynamic filters
      makeCandidate("PASSA", { close: 3.8, change: 32.1, relativeVolume: 11.2 }),
      makeCandidate("PASSB", { close: 15.0, change: 14.5, relativeVolume: 5.0 }),
    ];

    const result = await pipeline.execute(ibkrCandidates, PHASE3_TEST_FILTERS, {
      nowMs: Date.UTC(2026, 10, 26, 15, 0, 0),
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(requestedSymbols.sort()).toEqual(["PASSA", "PASSB"]);
    for (const url of requestedUrls) {
      expect(url.startsWith(`${FMP_SHARES_FLOAT_BASE_URL}?`)).toBe(true);
      expect(url).toContain("apikey=test-secret-key");
    }

    expect(result.rows.map((r) => r.ticker)).toEqual(["PASSA", "PASSB"]);
    expect(result.rows[0]!.floatShares).toBe(3_500_000);
    expect(result.rows[1]!.floatShares).toBe(12_000_000);
    expect(result.meta.activeEnrichers).toContain("fmp-shares-float");
    expect(result.meta.activeFilters).toContain("external-float-filter");
    expect(result.meta.pendingCapabilities).toEqual([]);
  });

  it("enforces final Float filter 800K - 20M inclusive and excludes out-of-range or missing float tickers", async () => {
    const floatByTicker: Record<string, unknown> = {
      TINY: [{ symbol: "TINY", floatShares: 799_999 }],
      EDGE_LO: [{ symbol: "EDGE_LO", floatShares: 800_000 }],
      SWEET: [{ symbol: "SWEET", floatShares: 4_250_000 }],
      EDGE_HI: [{ symbol: "EDGE_HI", floatShares: 20_000_000 }],
      HEAVY: [{ symbol: "HEAVY", floatShares: 20_000_001 }],
      EMPTY: [],
      ZERO: [{ symbol: "ZERO", floatShares: 0 }],
    };

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const sym = new URL(String(input)).searchParams.get("symbol") ?? "";
      return fmpJsonResponse(floatByTicker[sym] ?? []);
    });

    const fmp = new FmpFloatProvider({
      apiKey: "test-key",
      fetchImpl: fetchMock as unknown as typeof fetch,
      nowFn: () => Date.UTC(2026, 10, 26, 15, 0, 0),
    });

    const pipeline = createDefaultScreenerPipeline<ScreenerCandidateRow>();
    pipeline.registerEnricher(fmp.createEnricher());

    const rows = Object.keys(floatByTicker).map((sym, idx) =>
      makeCandidate(sym, { change: 50 - idx }),
    );

    const result = await pipeline.execute(rows, PHASE3_TEST_FILTERS, {
      nowMs: Date.UTC(2026, 10, 26, 15, 0, 0),
    });

    expect(result.rows.map((r) => r.ticker)).toEqual(["EDGE_LO", "SWEET", "EDGE_HI"]);
    expect(result.rows.every((r) => r.floatShares !== null && r.floatShares >= 800_000 && r.floatShares <= 20_000_000)).toBe(true);
  });

  it("persists daily cache in memory and JSON disk (including negative cache) and expires after new NY day / 24h", async () => {
    const { dir, file } = makeTempCachePath("fmp_cache.json");
    try {
      let nowMs = Date.UTC(2026, 10, 26, 14, 0, 0); // 2026-11-26 ET
      const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
        const sym = new URL(String(input)).searchParams.get("symbol") ?? "";
        if (sym === "NOFLT") return fmpJsonResponse([]);
        return fmpJsonResponse([{ symbol: sym, floatShares: 6_100_000 }]);
      });

      // 1) Cold start queries FMP once per symbol
      const provider1 = new FmpFloatProvider({
        apiKey: "cache-test-key",
        cacheFile: file,
        fetchImpl: fetchMock as unknown as typeof fetch,
        nowFn: () => nowMs,
      });

      const batch1 = await provider1.getFloatBatch(["KULR", "NOFLT"]);
      expect(batch1.get("KULR")).toBe(6_100_000);
      expect(batch1.get("NOFLT")).toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fs.existsSync(file)).toBe(true);

      // 2) Same instance same day -> 0 FMP calls (even for negative-cached NOFLT)
      const batch2 = await provider1.getFloatBatch(["KULR", "NOFLT"]);
      expect(batch2.get("KULR")).toBe(6_100_000);
      expect(batch2.get("NOFLT")).toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(2);

      // 3) Restarted instance loading persisted JSON -> 0 FMP calls & preserves quota count
      const provider2 = new FmpFloatProvider({
        apiKey: "cache-test-key",
        cacheFile: file,
        fetchImpl: fetchMock as unknown as typeof fetch,
        nowFn: () => nowMs,
      });
      const batch3 = await provider2.getFloatBatch(["KULR", "NOFLT"]);
      expect(batch3.get("KULR")).toBe(6_100_000);
      expect(batch3.get("NOFLT")).toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(provider2.getStatus().dailyCallsUsed).toBe(2);
      expect(provider2.getStatus().cachedSymbols).toBe(2);

      // 4) Next NY trading day (>= 24h) -> resets daily quota & refreshes cache
      nowMs = Date.UTC(2026, 10, 27, 14, 5, 0);
      expect(getNyDateKey(nowMs)).toBe("2026-11-27");
      const batchNextDay = await provider2.getFloatBatch(["KULR"]);
      expect(batchNextDay.get("KULR")).toBe(6_100_000);
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(provider2.getStatus().dailyCallsUsed).toBe(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("protects the 250 calls/day cap cleanly without blocking cached results", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const sym = new URL(String(input)).searchParams.get("symbol") ?? "";
      return fmpJsonResponse([{ symbol: sym, floatShares: 2_500_000 }]);
    });

    const fmp = new FmpFloatProvider({
      apiKey: "quota-test-key",
      dailyLimit: 2,
      fetchImpl: fetchMock as unknown as typeof fetch,
      nowFn: () => Date.UTC(2026, 10, 26, 15, 0, 0),
    });

    const pipeline = createDefaultScreenerPipeline<ScreenerCandidateRow>();
    pipeline.registerEnricher(fmp.createEnricher());

    const res1 = await pipeline.execute(
      [makeCandidate("AAA"), makeCandidate("BBB"), makeCandidate("CCC")],
      PHASE3_TEST_FILTERS,
    );

    // Only 2 HTTP calls dispatched sequentially or via bounded pool; 3rd ticker cleanly excluded
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(res1.rows.length).toBe(2);
    expect(fmp.getStatus().quotaExhausted).toBe(true);
    expect(fmp.getStatus().dailyCallsUsed).toBe(2);

    // Cached tickers continue passing on subsequent scans with 0 HTTP calls
    const cachedTickers = res1.rows.map((r) => r.ticker);
    const res2 = await pipeline.execute(
      cachedTickers.map((t) => makeCandidate(t)),
      PHASE3_TEST_FILTERS,
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(res2.rows.map((r) => r.ticker)).toEqual(cachedTickers);
  });

  it("handles HTTP 429, network failures, secret redaction, cooldown retry, in-flight coalescing & missing API key", async () => {
    let nowMs = Date.UTC(2026, 10, 26, 15, 0, 0);

    // A) Network failure + secret redaction + short cooldown (NOT negative-cached for 24h)
    let shouldFail = true;
    const secret = "SUPER_SECRET_FMP_TOKEN_999";
    const transientFetch = vi.fn(async (input: RequestInfo | URL) => {
      if (shouldFail) {
        throw new Error(`connect ETIMEDOUT ${String(input)}`);
      }
      return fmpJsonResponse([{ symbol: "GPRO", floatShares: 5_000_000 }]);
    });

    const fmpNet = new FmpFloatProvider({
      apiKey: secret,
      transientRetryCooldownMs: 60_000,
      fetchImpl: transientFetch as unknown as typeof fetch,
      nowFn: () => nowMs,
    });

    const failBatch = await fmpNet.getFloatBatch(["GPRO"]);
    expect(failBatch.get("GPRO")).toBeNull();
    expect(fmpNet.getStatus().lastError).toContain("apikey=[REDACTED]");
    expect(fmpNet.getStatus().lastError).not.toContain(secret);

    // Within 60s cooldown, avoids hammering failing endpoint
    await fmpNet.getFloatBatch(["GPRO"]);
    expect(transientFetch).toHaveBeenCalledTimes(1);

    // After cooldown expires, retries and succeeds
    shouldFail = false;
    nowMs += 65_000;
    const okBatch = await fmpNet.getFloatBatch(["GPRO"]);
    expect(okBatch.get("GPRO")).toBe(5_000_000);
    expect(transientFetch).toHaveBeenCalledTimes(2);
    expect(fmpNet.getStatus().lastError).toBeNull();

    // B) HTTP 429 stops remaining uncached calls cleanly
    const rateLimitedFetch = vi.fn(async () => fmpJsonResponse({ "Error Message": "Limit Reach" }, 429));
    const fmp429 = new FmpFloatProvider({
      apiKey: "rl-key",
      fetchImpl: rateLimitedFetch as unknown as typeof fetch,
      nowFn: () => nowMs,
    });
    const rlResult = await fmp429.getFloatBatch(["X1", "X2"]);
    expect(rlResult.get("X1")).toBeNull();
    expect(rlResult.get("X2")).toBeNull();
    expect(fmp429.getStatus().quotaExhausted).toBe(true);

    // C) In-flight coalescing across concurrent requests for the same ticker
    let resolveDelayed!: (val: Response) => void;
    const slowFetch = vi.fn(
      () =>
        new Promise<Response>((res) => {
          resolveDelayed = res;
        }),
    );
    const fmpCoalesce = new FmpFloatProvider({
      apiKey: "coalesce-key",
      fetchImpl: slowFetch as unknown as typeof fetch,
      nowFn: () => nowMs,
    });
    const p1 = fmpCoalesce.getFloatBatch(["COALA"]);
    const p2 = fmpCoalesce.getFloatBatch(["COALA"]);
    const p3 = fmpCoalesce.getFloatBatch(["COALA"]);
    expect(slowFetch).toHaveBeenCalledTimes(1);
    resolveDelayed(fmpJsonResponse([{ symbol: "COALA", floatShares: 9_200_000 }]));
    const [m1, m2, m3] = await Promise.all([p1, p2, p3]);
    expect(m1.get("COALA")).toBe(9_200_000);
    expect(m2.get("COALA")).toBe(9_200_000);
    expect(m3.get("COALA")).toBe(9_200_000);

    // D) Missing FMP_API_KEY disables enricher gracefully without blocking IBKR results
    const emptyKeyFetch = vi.fn();
    const fmpMissing = new FmpFloatProvider({
      apiKey: "",
      fetchImpl: emptyKeyFetch as unknown as typeof fetch,
    });
    const pipeline = createDefaultScreenerPipeline<ScreenerCandidateRow>();
    pipeline.registerEnricher(fmpMissing.createEnricher());
    const degraded = await pipeline.execute([makeCandidate("PLUG")], PHASE3_TEST_FILTERS);
    expect(emptyKeyFetch).not.toHaveBeenCalled();
    expect(degraded.rows.map((r) => r.ticker)).toEqual(["PLUG"]);
    expect(degraded.meta.pendingCapabilities).toContain("floatShares");
    expect(degraded.meta.enricherStatus?.["fmp-shares-float"]?.configured).toBe(false);
  });

  it("parses FMP error messages and share-class array payloads accurately", () => {
    expect(
      parseFmpSharesFloatPayload(
        [{ symbol: "BRK-B", floatShares: 1_300_000_000, freeFloat: 99.1 }],
        "BRK.B",
      ),
    ).toEqual({
      kind: "ok",
      floatShares: 1_300_000_000,
      freeFloat: 99.1,
      outstandingShares: null,
    });
    expect(parseFmpSharesFloatPayload([], "XYZ")).toEqual({ kind: "no_data" });
    expect(
      parseFmpSharesFloatPayload({ "Error Message": "Limit Reach. Please upgrade your plan." }, "XYZ")
        .kind,
    ).toBe("quota_error");
  });

  it("documents FMP_API_KEY in .env.example and contains zero hardcoded API keys in source", () => {
    const repoRoot = path.resolve(__dirname, "../..");
    const envExample = fs.readFileSync(path.join(repoRoot, ".env.example"), "utf8");
    expect(envExample).toContain("FMP_API_KEY=");

    const providerSrc = fs.readFileSync(
      path.join(repoRoot, "src/server/fmpFloatProvider.ts"),
      "utf8",
    );
    expect(providerSrc).not.toMatch(/apikey=[A-Za-z0-9]{12,}/i);
  });

  it("does not trip global quotaExhausted on FMP HTTP 402 per-symbol plan restriction and resolves via fallback", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const sym = new URL(String(input)).searchParams.get("symbol") ?? "";
      if (sym === "KULR") {
        return new Response(
          "Premium Query Parameter: 'Special Endpoint : This value set for 'symbol' is not available under your current subscription'",
          { status: 402 },
        );
      }
      return fmpJsonResponse([{ symbol: sym, floatShares: 12_500_000 }]);
    });

    const fallbackResolver = vi.fn(async (sym: string) =>
      sym === "KULR" ? 14_200_000 : null,
    );

    const fmp = new FmpFloatProvider({
      apiKey: "free-tier-key",
      fetchImpl: fetchMock as unknown as typeof fetch,
      fallbackResolver,
      nowFn: () => Date.UTC(2026, 10, 26, 15, 0, 0),
    });

    const batch = await fmp.getFloatBatch(["KULR", "NVDA"]);
    expect(batch.get("KULR")).toBe(14_200_000);
    expect(batch.get("NVDA")).toBe(12_500_000);
    expect(fmp.getStatus().quotaExhausted).toBe(false);
    expect(fallbackResolver).toHaveBeenCalledWith("KULR", undefined);
  });
});
