import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EventName,
  MarketDataType,
  ScanCode,
  type Contract,
  type ScannerSubscription,
} from "@stoqey/ib";
import {
  aggregateCandles,
  computeRequiredWarmupBars,
  getBucketStartSec,
  mergeLive1sBarIntoSeries,
  parseTimeframeSeconds,
  resolveIbkrHistoricalQuery,
} from "../lib/timeframes.ts";
import { ema, emaStep, vwapBands, type CandleData } from "../lib/indicators.ts";
import {
  IbkrEngine,
  computeVwapSessionSeedsFromBars,
  toIbkrContract,
  type IbkrTransport,
} from "../server/ibkrEngine.ts";
import {
  applyIbkrBar1s,
  invalidateAllStockSeries,
  setRealStockSeries,
  getHistory,
} from "../services/demo/candles.ts";

class MockIbkrTransport extends EventEmitter implements IbkrTransport {
  isConnected = false;
  connectCalls = 0;
  disconnectCalls = 0;
  activeTbtReqIds = new Map<number, string>();
  activeMktDataReqIds = new Map<number, string>();
  historicalRequests: Array<{
    reqId: number;
    symbol: string;
    barSize: string;
    durationStr: string;
    endDateTime?: string;
  }> = [];
  cancelledHistoricalReqIds: number[] = [];
  scannerActiveReqIds = new Set<number>();
  marketDataTypes: MarketDataType[] = [];

  connect(): void {
    this.connectCalls += 1;
    queueMicrotask(() => {
      this.isConnected = true;
      this.emit(EventName.connected);
      this.emit(EventName.nextValidId, 1);
    });
  }

  disconnect(): void {
    this.disconnectCalls += 1;
    this.isConnected = false;
  }

  reqMarketDataType(marketDataType: MarketDataType): void {
    this.marketDataTypes.push(marketDataType);
  }

  reqHistoricalData(
    reqId: number,
    contract: Contract,
    endDateTime: string | undefined,
    durationStr: string,
    barSizeSetting: string,
  ): void {
    this.historicalRequests.push({
      reqId,
      symbol: contract.symbol ?? "",
      barSize: String(barSizeSetting),
      durationStr,
      endDateTime,
    });

    queueMicrotask(() => {
      if (this.cancelledHistoricalReqIds.includes(reqId)) return;
      const baseSec = 1_795_444_200; // 2026-11-23 14:30:00 UTC (09:30 ET)
      for (let i = 0; i < 60; i++) {
        this.emit(
          EventName.historicalData,
          reqId,
          String(baseSec + i * 60),
          100 + i * 0.1,
          100.5 + i * 0.1,
          99.5 + i * 0.1,
          100.2 + i * 0.1,
          1000,
          10,
          100.1,
          false,
        );
      }
      this.emit(EventName.historicalData, reqId, "finished-0-0", -1, -1, -1, -1, -1, -1, -1, false);
    });
  }

  cancelHistoricalData(reqId: number): void {
    this.cancelledHistoricalReqIds.push(reqId);
  }

  reqTickByTickData(reqId: number, contract: Contract): void {
    this.activeTbtReqIds.set(reqId, contract.symbol ?? "");
  }

  cancelTickByTickData(reqId: number): void {
    this.activeTbtReqIds.delete(reqId);
  }

  reqMktData(reqId: number, contract: Contract): void {
    this.activeMktDataReqIds.set(reqId, contract.symbol ?? "");
  }

  cancelMktData(reqId: number): void {
    this.activeMktDataReqIds.delete(reqId);
  }

  reqScannerSubscription(reqId: number, _subscription: ScannerSubscription): void {
    this.scannerActiveReqIds.add(reqId);
    queueMicrotask(() => {
      this.emit(EventName.scannerDataEnd, reqId);
    });
  }

  cancelScannerSubscription(reqId: number): void {
    this.scannerActiveReqIds.delete(reqId);
  }

  reqMatchingSymbols(reqId: number): void {
    queueMicrotask(() => {
      this.emit(EventName.symbolSamples, reqId, []);
    });
  }

  reqContractDetails(reqId: number): void {
    queueMicrotask(() => {
      this.emit(EventName.contractDetailsEnd, reqId);
    });
  }

  reqNewsProviders(): void {
    queueMicrotask(() => {
      this.emit(EventName.newsProviders, []);
    });
  }

  reqHistoricalNews(reqId: number): void {
    queueMicrotask(() => {
      this.emit(EventName.historicalNewsEnd, reqId, false);
    });
  }
}

describe("Phase 1 IBKR Single-Source Architecture Verification", () => {
  afterEach(() => {
    vi.useRealTimers();
    invalidateAllStockSeries();
  });

  it("1. removes all legacy market data APIs, connectors, URLs, and env vars from non-test source", () => {
    const rootDir = path.resolve(__dirname, "../..");
    const filesToScan: string[] = [
      path.join(rootDir, "vite.config.ts"),
      path.join(rootDir, "package.json"),
    ];

    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (full.endsWith("__tests__") || full.endsWith(path.join("services", "demo", "data"))) {
            continue;
          }
          walk(full);
        } else if (/\.(ts|tsx|js|mjs|json)$/.test(entry.name)) {
          filesToScan.push(full);
        }
      }
    };
    walk(path.join(rootDir, "src"));

    const forbidden = /\b(alpaca|yahoo|finnhub|massive)\b|polygon\.io|scanner\.tradingview|s3\.tradingview|TradingViewWidgets|TradingViewEconomicCalendar/i;
    const violations: string[] = [];

    for (const filePath of filesToScan) {
      const content = fs.readFileSync(filePath, "utf8");
      const match = content.match(forbidden);
      if (match) {
        violations.push(`${path.relative(rootDir, filePath)}: ${match[0]}`);
      }
    }

    // Ensure US equities engine & scanner remain strictly IBKR-only (never touching crypto exchanges)
    const ibkrEngineSrc = fs.readFileSync(path.join(rootDir, "src/server/ibkrEngine.ts"), "utf8");
    expect(ibkrEngineSrc).not.toMatch(/binance|kraken|coinbase|coingecko/i);

    expect(violations).toEqual([]);
    expect(fs.existsSync(path.join(rootDir, "src/services/alpacaConfig.ts"))).toBe(false);
    expect(fs.existsSync(path.join(rootDir, "src/services/alpacaStream.ts"))).toBe(false);
    expect(fs.existsSync(path.join(rootDir, "src/components/AlpacaConfigModal.tsx"))).toBe(false);
    expect(fs.existsSync(path.join(rootDir, "src/components/TradingViewWidgets.tsx"))).toBe(false);
    expect(fs.existsSync(path.join(rootDir, "trade_screenshots/alpaca_config.json"))).toBe(false);
  });

  it("2. builds 1m, 3m, 5m, and custom dynamic timeframes from 1s base bars without double-counting intra-second volume", () => {
    const startSec = 1_795_443_300; // exact multiple of 2100s (LCM of 15s, 1m, 3m, 5m, 7m)
    const bars1s = Array.from({ length: 420 }, (_, i) => ({
      time: startSec + i,
      open: 100 + i * 0.01,
      high: 100.05 + i * 0.01,
      low: 99.95 + i * 0.01,
      close: 100.02 + i * 0.01,
      volume: 10,
    }));

    expect(aggregateCandles(bars1s, parseTimeframeSeconds("1m"))).toHaveLength(7);
    expect(aggregateCandles(bars1s, parseTimeframeSeconds("3m"))).toHaveLength(3);
    expect(aggregateCandles(bars1s, parseTimeframeSeconds("5m"))).toHaveLength(2);
    expect(aggregateCandles(bars1s, parseTimeframeSeconds("7m"))).toHaveLength(1);
    expect(aggregateCandles(bars1s, parseTimeframeSeconds("15s"))).toHaveLength(28);

    // Custom non-native timeframe query resolution routes cleanly to largest dividing IBKR native bar size
    expect(resolveIbkrHistoricalQuery("7m", 400)).toMatchObject({
      targetSec: 420,
      barSize: "1 min",
      requiresResample: true,
    });
    expect(resolveIbkrHistoricalQuery("45s", 400)).toMatchObject({
      targetSec: 45,
      barSize: "15 secs",
      requiresResample: true,
    });

    // Intra-second incremental updates must merge exact delta volume (never double-count)
    setRealStockSeries("NVDA", "1m", [
      { time: startSec, open: 100, high: 101, low: 99.5, close: 100.5, volume: 500 },
    ]);
    setRealStockSeries("NVDA", "3m", [
      { time: startSec, open: 100, high: 101, low: 99.5, close: 100.5, volume: 500 },
    ]);
    setRealStockSeries("NVDA", "7m", [
      { time: getBucketStartSec(startSec, 420), open: 100, high: 101, low: 99.5, close: 100.5, volume: 500 },
    ]);

    const tSec = startSec + 65; // belongs to 1m bar startSec+60, and 3m/7m bar startSec
    applyIbkrBar1s("NVDA", { time: tSec, open: 100.5, high: 101.2, low: 100.4, close: 101.1, volume: 40 });
    applyIbkrBar1s("NVDA", { time: tSec, open: 100.5, high: 101.8, low: 100.4, close: 101.6, volume: 95 });

    const bars1m = getHistory("NVDA", "1m");
    const bars3m = getHistory("NVDA", "3m");
    expect(bars1m[bars1m.length - 1]!.volume).toBe(95);
    expect(bars1m[bars1m.length - 1]!.close).toBe(101.6);
    expect(bars3m[bars3m.length - 1]!.volume).toBe(595);

    const directMerge = mergeLive1sBarIntoSeries(
      [{ time: startSec, open: 10, high: 10, low: 10, close: 10, volume: 100 }],
      { time: startSec + 2, open: 10.5, high: 10.8, low: 10.4, close: 10.7, volume: 25 },
      10,
      "5m",
    );
    expect(directMerge.updatedCandle.volume).toBe(115);
  });

  it("3. maintains continuous NY intraday VWAP across pre-market & RTH and matches full-day values via priorSessionSeed", () => {
    // 2026-11-23 is EST (-5h): 04:00 ET = 09:00 UTC, 09:30 ET = 14:30 UTC
    const pre0400Utc = Math.floor(Date.UTC(2026, 10, 23, 9, 0, 0) / 1000);
    const fullDay1m: Array<CandleData & { volume: number }> = [];
    for (let i = 0; i < 420; i++) {
      // 04:00 ET -> 11:00 ET (7 hours = 420 mins, crossing 09:30 ET at i = 330)
      const p = 50 + Math.sin(i / 17) * 2.5 + i * 0.02;
      fullDay1m.push({
        time: pre0400Utc + i * 60,
        open: p - 0.1,
        high: p + 0.35,
        low: p - 0.35,
        close: p,
        volume: 1_000 + (i % 7) * 250,
      });
    }

    const fullExt = vwapBands(fullDay1m, {
      anchor: "session",
      sessionTimeZone: "america-new-york",
      source: "hlc3",
    });

    // Suppose only the last 60 bars (from i = 360, 10:00 ET) are passed along with priorSessionSeed
    const visibleStartSec = fullDay1m[360]!.time;
    const seeds = computeVwapSessionSeedsFromBars(fullDay1m, visibleStartSec);
    expect(seeds.extended).not.toBeNull();
    expect(seeds.regular).not.toBeNull();

    const windowedExt = vwapBands(fullDay1m.slice(360), {
      anchor: "session",
      sessionTimeZone: "america-new-york",
      source: "hlc3",
      priorSessionSeed: seeds.extended ?? undefined,
    });

    const fullLast = fullExt.vwap[fullExt.vwap.length - 1]!.value;
    const winLast = windowedExt.vwap[windowedExt.vwap.length - 1]!.value;
    expect(winLast).toBeCloseTo(fullLast, 8);
    expect(windowedExt.upper1[windowedExt.upper1.length - 1]!.value).toBeCloseTo(
      fullExt.upper1[fullExt.upper1.length - 1]!.value,
      8,
    );
  });

  it("4. computes high-precision EMAs with sufficient warmup bars stabilized from first visible bar", () => {
    const required = computeRequiredWarmupBars([8, 20, 50, 200]);
    expect(required).toBeGreaterThanOrEqual(1500);

    const candles: CandleData[] = Array.from({ length: required + 200 }, (_, i) => {
      const p = 120 + Math.sin(i / 15) * 4 + i * 0.015;
      return {
        time: 1_795_400_000 + i * 60,
        open: p - 0.1,
        high: p + 0.2,
        low: p - 0.2,
        close: p,
        volume: 500,
      };
    });

    // Compare full-history EMA(50) vs cropped-at-warmup-end EMA(50): convergence error < 1e-6
    const fullEma50 = ema(candles, 50);
    const fullEma200 = ema(candles, 200);
    expect(fullEma50[fullEma50.length - 1]!.value).toBeCloseTo(
      emaStep(fullEma50[fullEma50.length - 2]!.value, candles[candles.length - 1]!.close, 50),
      10,
    );

    const warmupCropped = candles.slice(400);
    const croppedEma50 = ema(warmupCropped, 50);
    const tailFull = fullEma50[fullEma50.length - 1]!.value;
    const tailCrop = croppedEma50[croppedEma50.length - 1]!.value;
    expect(Math.abs(tailFull - tailCrop)).toBeLessThan(1e-6);
    expect(fullEma200.length).toBeGreaterThan(200);
  });

  it("5. manages IBKR reconnects, pacing coalescing, abort safety, and zero subscription leaks across 50 rapid switches", async () => {
    const transport = new MockIbkrTransport();
    const engine = new IbkrEngine({
      transportFactory: () => transport,
    });

    await engine.ensureConnected();
    expect(engine.getStatusPayload().connectionState).toBe("connected");
    expect(toIbkrContract("BRK.B", "NYSE")).toMatchObject({
      symbol: "BRK B",
      exchange: "SMART",
      currency: "USD",
      primaryExch: "NYSE",
    });

    // Coalesce concurrent identical historical requests into a single IBKR wire request & dynamically aggregate 7m
    const [r1, r2] = await Promise.all([
      engine.getHistoricalCandles("NVDA", "7m", 300, "NASDAQ"),
      engine.getHistoricalCandles("NVDA", "7m", 300, "NASDAQ"),
    ]);
    expect(r1.candles.length).toBeGreaterThanOrEqual(8);
    expect(r1.candles.length).toBeLessThan(60); // 60 x 1min bars aggregated dynamically to 7m bars
    expect(r2.candles.length).toBe(r1.candles.length);
    const nvdaReqs = transport.historicalRequests.filter((r) => r.symbol === "NVDA");
    expect(nvdaReqs.length).toBe(1);

    // Simulate 50 rapid ticker & timeframe switches: switching timeframes keeps same stream;
    // releasing previous symbol subscriptions leaves zero leaked IBKR reqIds after warm grace.
    let activeRelease: (() => void) | null = null;
    const tickers = ["NVDA", "AAPL", "MSFT", "TSLA", "AMD", "PLTR", "META", "AMZN", "SPY", "QQQ"];
    for (let i = 0; i < 50; i++) {
      const sym = tickers[i % tickers.length]!;
      const nextRelease = engine.acquireSymbolStream(sym, "NASDAQ");
      activeRelease?.();
      activeRelease = nextRelease;
    }

    // Reconnect event (Error 1100 -> 1102) re-establishes active stream cleanly
    transport.emit(EventName.error, new Error("Connectivity lost"), 1100, -1);
    expect(engine.getStatusPayload().connectionState).toBe("reconnecting");
    transport.emit(EventName.error, new Error("Connectivity restored"), 1102, -1);
    expect(engine.getStatusPayload().connectionState).toBe("connected");

    // Scanner releases its subscription deterministically
    await engine.scanUsStocks({ onlyPremarket: true, limit: 25 });
    expect(transport.scannerActiveReqIds.size).toBe(0);

    // Release final stream and dispose -> 0 active streams & 0 dangling TWS reqIds
    activeRelease?.();
    engine.dispose();
    expect(engine.getStatusPayload().activeStreams).toBe(0);
    expect(transport.activeTbtReqIds.size).toBe(0);
    expect(transport.activeMktDataReqIds.size).toBe(0);
    expect(ScanCode.TOP_PERC_GAIN).toBe(0);
    expect(MarketDataType.REALTIME).toBe(1);
  });
});
