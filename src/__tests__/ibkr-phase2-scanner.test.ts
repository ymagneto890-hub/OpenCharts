import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EventName,
  LocationCode,
  ScanCode,
  type Contract,
  type ContractDetails,
  type MarketDataType,
  type ScannerSubscription,
  type TagValue,
} from "@stoqey/ib";
import {
  computeCandidateChangePercent,
  filterScreenerRows,
  getUsMarketSessionPhase,
} from "../lib/premarketScreener.ts";
import { createDefaultScreenerPipeline } from "../lib/screenerPipeline.ts";
import { ema, vwapBands } from "../lib/indicators.ts";
import { aggregateCandles, parseTimeframeSeconds } from "../lib/timeframes.ts";
import { IbkrEngine, type IbkrScreenerRow, type IbkrTransport } from "../server/ibkrEngine.ts";
import {
  MAX_CONCURRENT_BASELINE_HYDRATIONS,
  MAX_SCANNER_MKT_DATA_LINES,
  buildScannerSpecs,
} from "../server/ibkrScanner.ts";
import { DEFAULT_SCREENER_FILTERS, buildScreenerRequest } from "../services/stockScreener.ts";
import { registerDynamicSymbol, getDemoSymbol } from "../services/demo/instruments.ts";
import { getHistory, invalidateStockSeries, setRealStockSeries } from "../services/demo/candles.ts";
import { applyLiveStockTrade } from "../services/demo/feed.ts";

class MockScannerTransport extends EventEmitter implements IbkrTransport {
  isConnected = false;
  scannerResults = new Map<ScanCode, string[]>();
  scannerCalls: Array<{
    reqId: number;
    sub: ScannerSubscription;
    filterOptions?: TagValue[];
  }> = [];
  activeScannerReqIds = new Set<number>();
  activeMktData = new Map<number, string>();
  activeTbt = new Map<number, string>();
  mktDataSymbolCount = new Map<string, number>();

  inFlightHistorical = 0;
  maxConcurrentHistorical = 0;
  historicalCountBySymbol = new Map<string, number>();

  /** Optional hook invoked immediately when `reqMktData` subscribes a symbol. */
  onMktDataSubscribed?: (reqId: number, symbol: string) => void;
  autoResolveBaselines = true;

  connect(): void {
    queueMicrotask(() => {
      this.isConnected = true;
      this.emit(EventName.connected);
      this.emit(EventName.nextValidId, 1);
    });
  }

  disconnect(): void {
    this.isConnected = false;
  }

  reqMarketDataType(_marketDataType: MarketDataType): void {}

  reqHistoricalData(
    reqId: number,
    contract: Contract,
    _endDateTime: string | undefined,
    _durationStr: string,
    barSizeSetting: string,
  ): void {
    const sym = (contract.symbol ?? "").toUpperCase();
    this.inFlightHistorical += 1;
    this.maxConcurrentHistorical = Math.max(this.maxConcurrentHistorical, this.inFlightHistorical);
    this.historicalCountBySymbol.set(sym, (this.historicalCountBySymbol.get(sym) ?? 0) + 1);

    setTimeout(() => {
      this.inFlightHistorical = Math.max(0, this.inFlightHistorical - 1);
      if (this.autoResolveBaselines) {
        const baseSec = 1_795_000_000;
        const stepSec = barSizeSetting.includes("day") ? 86_400 : 60;
        const count = barSizeSetting.includes("day") ? 35 : 5;
        for (let i = 0; i < count; i++) {
          this.emit(
            EventName.historicalData,
            reqId,
            String(baseSec + i * stepSec),
            5.0,
            5.2,
            4.9,
            5.0,
            100_000,
            10,
            5.0,
            false,
          );
        }
      }
      this.emit(EventName.historicalData, reqId, "finished-0-0", -1, -1, -1, -1, -1, -1, -1, false);
    }, 15);
  }

  cancelHistoricalData(): void {}

  reqTickByTickData(reqId: number, contract: Contract): void {
    this.activeTbt.set(reqId, (contract.symbol ?? "").toUpperCase());
  }

  cancelTickByTickData(reqId: number): void {
    this.activeTbt.delete(reqId);
  }

  reqMktData(reqId: number, contract: Contract): void {
    const sym = (contract.symbol ?? "").toUpperCase();
    this.activeMktData.set(reqId, sym);
    this.mktDataSymbolCount.set(sym, (this.mktDataSymbolCount.get(sym) ?? 0) + 1);
    this.onMktDataSubscribed?.(reqId, sym);
  }

  cancelMktData(reqId: number): void {
    this.activeMktData.delete(reqId);
  }

  reqScannerSubscription(
    reqId: number,
    subscription: ScannerSubscription,
    _opts?: TagValue[],
    filterOptions?: TagValue[],
  ): void {
    this.scannerCalls.push({ reqId, sub: subscription, filterOptions });
    this.activeScannerReqIds.add(reqId);

    queueMicrotask(() => {
      const tickers = this.scannerResults.get(subscription.scanCode) ?? [];
      tickers.forEach((ticker, idx) => {
        const details: ContractDetails = {
          contract: {
            symbol: ticker,
            exchange: "SMART",
            primaryExch: "ISLAND",
            currency: "USD",
          },
          longName: `${ticker} Corp.`,
          industry: "Technology",
        };
        this.emit(EventName.scannerData, reqId, idx, details, "", "", "");
      });
      this.emit(EventName.scannerDataEnd, reqId);
    });
  }

  cancelScannerSubscription(reqId: number): void {
    this.activeScannerReqIds.delete(reqId);
  }

  reqMatchingSymbols(reqId: number): void {
    queueMicrotask(() => this.emit(EventName.symbolSamples, reqId, []));
  }

  reqContractDetails(reqId: number): void {
    queueMicrotask(() => this.emit(EventName.contractDetailsEnd, reqId));
  }

  reqNewsProviders(): void {
    queueMicrotask(() => this.emit(EventName.newsProviders, []));
  }

  reqHistoricalNews(reqId: number): void {
    queueMicrotask(() => this.emit(EventName.historicalNewsEnd, reqId, false));
  }
}

function makeCandidate(overrides: Partial<IbkrScreenerRow>): IbkrScreenerRow {
  return {
    id: `SMART:${overrides.ticker ?? "TEST"}`,
    ticker: "TEST",
    description: "Test Equity",
    close: 5.0,
    change: 15.0,
    volume: 1_000_000,
    relativeVolume: 8.0,
    marketCap: 50_000_000,
    priceToBook: null,
    epsDiluted: null,
    epsGrowthYoY: null,
    dividendYield: null,
    sector: "Technology",
    exchange: "NASDAQ",
    perfW: null,
    perf1M: null,
    perf3M: null,
    perfYTD: null,
    perfY: null,
    rsi: null,
    recommendAll: null,
    floatShares: null,
    currency: "USD",
    country: "United States",
    premarketClose: 5.0,
    premarketChange: 15.0,
    premarketVolume: 1_000_000,
    ...overrides,
  };
}

describe("Phase 2 Real-Time IBKR Scanner & Decoupled Pipeline", () => {
  afterEach(() => {
    vi.useRealTimers();
    invalidateStockSeries("SCANR");
  });

  it("1. enforces Finviz default filters (Float < 20M, > +10%, Price < $20, >= 5x RelVol) and supports dynamic reconfiguration", () => {
    expect(DEFAULT_SCREENER_FILTERS).toMatchObject({
      priceMin: null,
      priceMax: 20,
      changeMin: 10,
      floatMin: null,
      floatMax: 20_000_000,
      relVolMin: 5,
      onlyPremarket: false,
    });
    expect(buildScreenerRequest(DEFAULT_SCREENER_FILTERS)).toMatchObject({
      priceMin: null,
      priceMax: 20,
      changeMin: 10,
      floatMin: null,
      floatMax: 20_000_000,
      relVolMin: 5,
      exchanges: ["NYSE", "NASDAQ", "AMEX"],
    });

    const rows = [
      makeCandidate({ ticker: "SUB_DOLLAR_OK", close: 0.85, change: 25, relativeVolume: 10 }),
      makeCandidate({ ticker: "MIN_PRICE_OK", close: 1.0, change: 10.01, relativeVolume: 5.0 }),
      makeCandidate({ ticker: "EXACT_10PCT_OUT", close: 4.5, change: 10.0, relativeVolume: 9.0 }),
      makeCandidate({ ticker: "LOW_RELVOL_OUT", close: 6.2, change: 18.0, relativeVolume: 4.99 }),
      makeCandidate({ ticker: "MAX_PRICE_OK", close: 20.0, change: 22.0, relativeVolume: 7.5 }),
      makeCandidate({ ticker: "TOO_EXPENSIVE", close: 20.01, change: 30.0, relativeVolume: 12.0 }),
    ];

    const filteredDefault = filterScreenerRows(
      rows,
      {
        priceMin: DEFAULT_SCREENER_FILTERS.priceMin,
        priceMax: DEFAULT_SCREENER_FILTERS.priceMax,
        changeMin: DEFAULT_SCREENER_FILTERS.changeMin,
        changeMax: DEFAULT_SCREENER_FILTERS.changeMax,
        relVolMin: DEFAULT_SCREENER_FILTERS.relVolMin,
        onlyPremarket: false,
      },
      { skipFloatFilter: true },
    );

    expect(filteredDefault.map((r) => r.ticker)).toEqual([
      "SUB_DOLLAR_OK",
      "MIN_PRICE_OK",
      "MAX_PRICE_OK",
    ]);

    // Configurable custom bounds ($2-$15, > +20%, >= 10x)
    const customRows = [
      makeCandidate({ ticker: "RUNNER_A", close: 3.5, change: 24.5, relativeVolume: 11.2 }),
      makeCandidate({ ticker: "RUNNER_B", close: 16.0, change: 24.5, relativeVolume: 11.2 }),
      makeCandidate({ ticker: "RUNNER_C", close: 5.0, change: 19.0, relativeVolume: 15.0 }),
    ];
    const filteredCustom = filterScreenerRows(
      customRows,
      { priceMin: 2, priceMax: 15, changeMin: 20, relVolMin: 10, onlyPremarket: false },
      { skipFloatFilter: true },
    );
    expect(filteredCustom.map((r) => r.ticker)).toEqual(["RUNNER_A"]);
  });

  it("2. scans Pre-Market and Regular sessions via IBKR, computes RelVol from RT_VOLUME & AVG_VOLUME, and pushes real-time SSE updates", async () => {
    vi.useFakeTimers();
    // 2026-11-23 07:30 ET = 12:30 UTC (Pre-Market)
    vi.setSystemTime(new Date("2026-11-23T12:30:00.000Z"));
    expect(getUsMarketSessionPhase(Date.now())).toBe("premarket");
    expect(computeCandidateChangePercent(6.0, 5.0)).toBe(20);
    const specs = buildScannerSpecs({ priceMin: 1, priceMax: 20, changeMin: 10 }, "premarket");
    expect(specs.map((s) => s.subscription.scanCode)).toEqual([
      ScanCode.TOP_PERC_GAIN,
      ScanCode.HOT_BY_VOLUME,
    ]);

    const transport = new MockScannerTransport();
    transport.scannerResults.set(ScanCode.TOP_PERC_GAIN, ["GPRO", "KULR"]);
    transport.scannerResults.set(ScanCode.HOT_BY_VOLUME, ["KULR", "BLNK"]);

    const mktReqIds = new Map<string, number>();
    transport.onMktDataSubscribed = (reqId, sym) => {
      mktReqIds.set(sym, reqId);
      queueMicrotask(() => {
        if (sym === "GPRO") {
          transport.emit(EventName.tickPrice, reqId, 9, 4.0); // CLOSE
          transport.emit(EventName.tickSize, reqId, 21, 10_000); // AVG_VOLUME (x100 = 1,000,000)
          transport.emit(
            EventName.tickString,
            reqId,
            48,
            `4.65;500;${Date.now()};350000;4.60;true`,
          ); // +16.25%, PM RelVol > 5x
        } else if (sym === "KULR") {
          transport.emit(EventName.tickPrice, reqId, 9, 2.0);
          transport.emit(EventName.tickSize, reqId, 21, 5_000); // 500,000 avg vol
          transport.emit(
            EventName.tickString,
            reqId,
            48,
            `2.17;200;${Date.now()};200000;2.15;true`,
          ); // +8.50% initially -> excluded until live breakout!
        } else if (sym === "BLNK") {
          transport.emit(EventName.tickPrice, reqId, 9, 25.0);
          transport.emit(EventName.tickSize, reqId, 21, 5_000);
          transport.emit(
            EventName.tickString,
            reqId,
            48,
            `29.50;200;${Date.now()};200000;29.10;true`,
          ); // $29.50 > $20 -> excluded
        }
      });
    };

    const engine = new IbkrEngine({ transportFactory: () => transport });
    const receivedEvents: Array<{ type: string; tickers: string[] }> = [];

    const releaseStream = engine.acquireScreenerStream(
      {
        marketScope: "us",
        onlyPremarket: true,
        priceMin: 1,
        priceMax: 20,
        changeMin: 10,
        relVolMin: 5,
      },
      (evt) => {
        if (evt.items) {
          receivedEvents.push({
            type: evt.type,
            tickers: evt.items.map((r) => r.ticker),
          });
        }
      },
    );

    // Flush connect + discovery + microtask ticks + readiness grace
    await vi.advanceTimersByTimeAsync(400);

    expect(transport.scannerCalls.length).toBeGreaterThanOrEqual(2);
    expect(transport.scannerCalls[0]!.sub.locationCode).toBe(LocationCode.STK_US_MAJOR);
    expect(transport.activeScannerReqIds.size).toBe(0);

    expect(receivedEvents.length).toBeGreaterThanOrEqual(1);
    const snap = receivedEvents[receivedEvents.length - 1]!;
    expect(snap.tickers).toEqual(["GPRO"]);

    // Live RT_VOLUME tick breaks KULR out from +8.5% -> +13.5% ($2.27): should dynamically enter stream
    const kulrReqId = mktReqIds.get("KULR")!;
    transport.emit(
      EventName.tickString,
      kulrReqId,
      48,
      `2.27;1200;${Date.now()};260000;2.21;true`,
    );
    await vi.advanceTimersByTimeAsync(700);

    const afterBreakout = receivedEvents[receivedEvents.length - 1]!;
    expect(afterBreakout.tickers).toContain("GPRO");
    expect(afterBreakout.tickers).toContain("KULR");

    // Live tick pushes GPRO above $20 ($21.10) -> should exit dynamically
    const gproReqId = mktReqIds.get("GPRO")!;
    transport.emit(
      EventName.tickString,
      gproReqId,
      48,
      `21.10;100;${Date.now()};360000;20.50;true`,
    );
    await vi.advanceTimersByTimeAsync(700);

    const afterExit = receivedEvents[receivedEvents.length - 1]!;
    expect(afterExit.tickers).toEqual(["KULR"]);

    // Verify Regular Session transition (10:30 ET)
    vi.setSystemTime(new Date("2026-11-23T15:30:00.000Z"));
    expect(getUsMarketSessionPhase(Date.now())).toBe("regular");

    releaseStream();
    await vi.advanceTimersByTimeAsync(2_200);
    expect(transport.activeMktData.size).toBe(0);
    engine.dispose();
  });

  it("3. strictly enforces <= 30 reqMktData budget, reuses active chart streams, bounds historical concurrency <= 2, and leaks zero subscriptions", async () => {
    vi.useFakeTimers();
    const transport = new MockScannerTransport();
    const lotsOfSymbols = Array.from({ length: 45 }, (_, i) => (i === 0 ? "NVDA" : `SYM${i}`));
    transport.scannerResults.set(ScanCode.TOP_PERC_GAIN, lotsOfSymbols);
    transport.scannerResults.set(ScanCode.HOT_BY_VOLUME, ["SYM1", "SYM2"]);

    transport.onMktDataSubscribed = (reqId) => {
      // Simulate only LAST arriving without CLOSE/AVG_VOLUME to force bounded historical fallback
      queueMicrotask(() => {
        transport.emit(EventName.tickPrice, reqId, 4, 8.5);
      });
    };

    const engine = new IbkrEngine({ transportFactory: () => transport });
    const connPromise = engine.ensureConnected();
    await vi.advanceTimersByTimeAsync(10);
    await connPromise;

    // Chart already streaming NVDA before scanner runs
    const releaseChart = engine.acquireSymbolStream("NVDA", "NASDAQ");
    await vi.advanceTimersByTimeAsync(800);

    const scan1Promise = engine.scanUsStocks({
      marketScope: "us",
      onlyPremarket: false,
      priceMin: 1,
      priceMax: 20,
      changeMin: 10,
      relVolMin: 5,
    });
    await vi.advanceTimersByTimeAsync(15_000);
    const res1 = await scan1Promise;

    expect(res1.source).toBe("ibkr-consolidated");
    // Hard budget ceiling: total scanner + chart reqMktData lines strictly <= MAX_SCANNER_MKT_DATA_LINES
    expect(transport.activeMktData.size).toBeLessThanOrEqual(MAX_SCANNER_MKT_DATA_LINES);
    // NVDA must reuse existing chart reqMktData stream (only 1 subscription total)
    expect(transport.mktDataSymbolCount.get("NVDA")).toBe(1);
    // Background baseline hydration must strictly honor MAX_CONCURRENT_BASELINE_HYDRATIONS (<= 2)
    expect(transport.maxConcurrentHistorical).toBeLessThanOrEqual(MAX_CONCURRENT_BASELINE_HYDRATIONS);
    expect(transport.activeScannerReqIds.size).toBe(0);

    // Second scan within baseline TTL reuses daily cached baselines (no redundant fetches for same pool)
    const countBefore = transport.historicalCountBySymbol.get("SYM1") ?? 0;
    const scan2Promise = engine.scanUsStocks({
      marketScope: "us",
      onlyPremarket: false,
      priceMin: 1,
      priceMax: 20,
      changeMin: 10,
      relVolMin: 5,
    });
    await vi.advanceTimersByTimeAsync(5_000);
    await scan2Promise;
    expect(transport.historicalCountBySymbol.get("SYM1") ?? 0).toBe(countBefore);

    releaseChart();
    await vi.advanceTimersByTimeAsync(2_200);
    engine.dispose();
    expect(transport.activeMktData.size).toBe(0);
    expect(transport.activeTbt.size).toBe(0);
    expect(transport.activeScannerReqIds.size).toBe(0);
  });

  it("4. decouples external Float filtering via composable pipeline hooks without breaking Phase 2 IBKR scanning", async () => {
    const pipeline = createDefaultScreenerPipeline<IbkrScreenerRow>();

    const ibkrOnlyRows: IbkrScreenerRow[] = [
      makeCandidate({ ticker: "SMALLF", close: 4.2, change: 28.0, relativeVolume: 9.0, floatShares: null }),
      makeCandidate({ ticker: "BIGCAP", close: 8.5, change: 22.0, relativeVolume: 7.5, floatShares: null }),
      makeCandidate({ ticker: "LOWCHG", close: 3.1, change: 9.5, relativeVolume: 12.0, floatShares: null }),
    ];

    // Before external Float provider is connected: floatMin/floatMax do NOT drop IBKR rows where floatShares === null
    const phase2Result = await pipeline.execute(ibkrOnlyRows, {
      priceMin: 1,
      priceMax: 20,
      changeMin: 10,
      relVolMin: 5,
      floatMin: 800_000,
      floatMax: 20_000_000,
      onlyPremarket: false,
    });

    expect(phase2Result.rows.map((r) => r.ticker)).toEqual(["SMALLF", "BIGCAP"]);
    expect(phase2Result.meta.pendingCapabilities).toContain("floatShares");
    expect(phase2Result.meta.activeEnrichers).toEqual([]);

    // Phase 3 hook: register an external Float enricher cleanly without touching IBKR logic
    const unregFloat = pipeline.registerEnricher({
      id: "mock-external-float",
      priority: 10,
      provides: ["floatShares"],
      enrich: (rows) =>
        rows.map((r) => ({
          ...r,
          floatShares:
            r.ticker === "SMALLF" ? 5_400_000 : r.ticker === "BIGCAP" ? 180_000_000 : r.floatShares,
        })),
    });

    const phase3Result = await pipeline.execute(ibkrOnlyRows, {
      priceMin: 1,
      priceMax: 20,
      changeMin: 10,
      relVolMin: 5,
      floatMin: 800_000,
      floatMax: 20_000_000,
      onlyPremarket: false,
    });

    expect(phase3Result.rows.map((r) => r.ticker)).toEqual(["SMALLF"]);
    expect(phase3Result.rows[0]!.floatShares).toBe(5_400_000);
    expect(phase3Result.meta.pendingCapabilities).toEqual([]);
    expect(phase3Result.meta.activeEnrichers).toEqual(["mock-external-float"]);
    expect(phase3Result.meta.activeFilters).toContain("external-float-filter");

    // Removing the enricher cleanly reverts to Phase 2 pass-through behavior
    unregFloat();
    const reverted = await pipeline.execute(ibkrOnlyRows, {
      priceMin: 1,
      priceMax: 20,
      changeMin: 10,
      relVolMin: 5,
      floatMin: 800_000,
      floatMax: 20_000_000,
      onlyPremarket: false,
    });
    expect(reverted.rows.map((r) => r.ticker)).toEqual(["SMALLF", "BIGCAP"]);
  });

  it("5. seamlessly loads scanner candidate onto chart with multi-timeframe bars, VWAP, and EMAs", () => {
    registerDynamicSymbol({
      name: "SCANR",
      displayName: "Scanner Runner Corp.",
      category: "STOCKS",
      initialPrice: 3.45,
      tickSize: 0.01,
      exchange: "NASDAQ",
      country: "United States",
      currency: "USD",
    });

    expect(getDemoSymbol("SCANR")).toMatchObject({
      name: "SCANR",
      category: "STOCKS",
      exchange: "NASDAQ",
      initialPrice: 3.45,
    });

    // Populate real 1m history from Pre-Market into Regular Session and verify dynamic 3m / 5m / 7m + VWAP + EMAs
    const startSec = Math.floor(Date.UTC(2026, 10, 23, 13, 0, 0) / 1000); // 08:00 ET
    const bars1m = Array.from({ length: 240 }, (_, i) => {
      const price = 3.2 + Math.sin(i / 12) * 0.15 + i * 0.002;
      return {
        time: startSec + i * 60,
        open: price - 0.01,
        high: price + 0.04,
        low: price - 0.04,
        close: price,
        volume: 5_000 + i * 25,
      };
    });

    setRealStockSeries("SCANR", "1m", bars1m);
    applyLiveStockTrade("SCANR", 3.92, (startSec + 240 * 60) * 1000, 1_500);

    const loaded1m = getHistory("SCANR", "1m");
    expect(loaded1m.length).toBeGreaterThan(200);
    expect(loaded1m[loaded1m.length - 1]!.close).toBeCloseTo(3.92, 4);

    const bars3m = aggregateCandles(loaded1m, parseTimeframeSeconds("3m"));
    const bars5m = aggregateCandles(loaded1m, parseTimeframeSeconds("5m"));
    const bars7m = aggregateCandles(loaded1m, parseTimeframeSeconds("7m"));
    expect(bars3m.length).toBeGreaterThan(60);
    expect(bars5m.length).toBeGreaterThan(40);
    expect(bars7m.length).toBeGreaterThan(30);

    const ema8 = ema(bars5m, 8);
    const vwapRes = vwapBands(bars5m, { anchor: "session", sessionTimeZone: "america-new-york" });
    expect(ema8.length).toBeGreaterThan(30);
    expect(vwapRes.vwap.length).toBe(bars5m.length);
  });
});
