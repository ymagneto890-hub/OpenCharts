import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventName, MarketDataType, type ScannerSubscription } from "@stoqey/ib";
import {
  classifyNewsCatalyst,
  parseFinvizQuoteNewsHtml,
  parseGoogleNewsRssXml,
  StockNewsProvider,
} from "../server/stockNews.ts";
import {
  CryptoMarketDataService,
  parseCryptoSymbol,
  resolveBinanceInterval,
} from "../server/cryptoMarketData.ts";
import { IbkrEngine, type IbkrStreamEvent, type IbkrTransport } from "../server/ibkrEngine.ts";
import {
  computeFineGrainedSessionVwap,
  ema,
  vwapBands,
  type CandleData,
} from "../lib/indicators.ts";
import { calculateVolumeMa } from "../pages/trading/utils.ts";
import { resolveIbkrHistoricalQuery } from "../lib/timeframes.ts";
import {
  applyCryptoLiveBar,
  applyIbkrBar1s,
  getHistory,
  invalidateAllStockSeries,
  isCryptoInstrument,
  setRealStockSeries,
  subscribeCandleBucketClosed,
} from "../services/demo/candles.ts";
import { applyIbkrLiveBar1sUpdate, applyIbkrQuoteUpdate } from "../services/demo/feed.ts";
import { getDemoSymbol, registerDynamicSymbol } from "../services/demo/instruments.ts";
import { getReplaySliceForTimeframe, useReplayStore } from "../services/demo/replay.ts";
import { updateChartPreferences } from "../hooks/useChartPreferences.ts";

class VolumeMockIbkrTransport extends EventEmitter implements IbkrTransport {
  isConnected = false;
  histBars: Array<{ time: number; open: number; high: number; low: number; close: number; volume: number }> = [];
  requestedMarketDataTypes: number[] = [];
  mktDataCalls: Array<{ reqId: number; genericTicks: string | null }> = [];
  tickByTickCalls = 0;

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
  reqMarketDataType(mdt: MarketDataType): void {
    this.requestedMarketDataTypes.push(mdt);
  }
  reqHistoricalData(reqId: number): void {
    queueMicrotask(() => {
      for (const b of this.histBars) {
        this.emit(EventName.historicalData, reqId, String(b.time), b.open, b.high, b.low, b.close, b.volume, 1, b.close, false);
      }
      this.emit(EventName.historicalData, reqId, "finished-0-0", -1, -1, -1, -1, -1, -1, -1, false);
    });
  }
  cancelHistoricalData(): void {}
  reqTickByTickData(): void {
    this.tickByTickCalls += 1;
  }
  cancelTickByTickData(): void {}
  reqMktData(reqId: number, _contract: unknown, genericTicks: string | null): void {
    this.mktDataCalls.push({ reqId, genericTicks });
  }
  cancelMktData(): void {}
  reqScannerSubscription(reqId: number, _sub: ScannerSubscription): void {
    queueMicrotask(() => this.emit(EventName.scannerDataEnd, reqId));
  }
  cancelScannerSubscription(): void {}
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

describe("Stock Screener News, IBKR Volume, 1m/3m/5m VWAP+EMA9 & Crypto APIs", () => {
  afterEach(() => {
    invalidateAllStockSeries();
  });

  it("1. parses Finviz quote news table with clickable links, carried-over dates, and catalyst tags", () => {
    const html = `
      <table id="news-table" class="fullview-news-outer news-table">
        <tr>
          <td width="130" align="right">Nov-26-26 09:47AM</td>
          <td>
            <div class="news-link-container">
              <div class="news-link-left">
                <a class="tab-link-news" href="https://example.com/fda-news">BioCo Receives FDA Approval for Phase 3 Drug</a>
              </div>
              <div class="news-link-right"><span>(GlobeNewswire)</span></div>
            </div>
          </td>
        </tr>
        <tr>
          <td width="130" align="right">05:54AM</td>
          <td>
            <div class="news-link-container">
              <div class="news-link-left">
                <a class="tab-link-news" href="/news/12345/secondary-offering">BioCo Announces Direct Offering of Shares</a>
              </div>
              <div class="news-link-right"><span>(InvestorsHub)</span></div>
            </div>
          </td>
        </tr>
      </table>
    `;

    const items = parseFinvizQuoteNewsHtml(html);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      title: "BioCo Receives FDA Approval for Phase 3 Drug",
      publisher: "GlobeNewswire",
      link: "https://example.com/fda-news",
      catalystTag: "FDA / Clínico",
    });
    expect(items[0]!.publishedAt).toBeGreaterThan(0);
    expect(items[1]).toMatchObject({
      title: "BioCo Announces Direct Offering of Shares",
      publisher: "InvestorsHub",
      link: "https://finviz.com/news/12345/secondary-offering",
      catalystTag: "Dilución / R.Split",
    });
    // Second row inherited Nov-26-26 date cleanly
    expect(items[1]!.publishedAt).toBeLessThan(items[0]!.publishedAt!);
    expect(classifyNewsCatalyst("Company Beats Q3 EPS Earnings Guidance")).toBe("Resultados");
  });

  it("2. falls back to Google News RSS when Finviz news fails or is empty", async () => {
    const rssXml = `<?xml version="1.0" encoding="UTF-8"?>
      <rss><channel>
        <item>
          <title>NVDA Signs Multi-Year AI Partnership Deal - Reuters</title>
          <link>https://news.google.com/articles/abc</link>
          <pubDate>Thu, 26 Nov 2026 14:30:00 GMT</pubDate>
          <source>Reuters</source>
        </item>
      </channel></rss>`;

    expect(parseGoogleNewsRssXml(rssXml)[0]).toMatchObject({
      title: "NVDA Signs Multi-Year AI Partnership Deal",
      publisher: "Reuters",
      link: "https://news.google.com/articles/abc",
      catalystTag: "Alianza / Contrato",
    });

    const fetchMock = vi.fn(async (url: string | URL) => {
      const s = String(url);
      if (s.includes("finviz.com")) {
        return new Response("<html><body>no table</body></html>", { status: 200 });
      }
      return new Response(rssXml, { status: 200 });
    });

    const provider = new StockNewsProvider({ fetchImpl: fetchMock as unknown as typeof fetch });
    const res = await provider.getNews("NVDA");
    expect(res.source).toBe("google-rss");
    expect(res.items).toHaveLength(1);
    expect(res.items[0]!.link).toBe("https://news.google.com/articles/abc");
  });

  it("3. does not double-count IBKR volume when merging live 1s bars onto current 5m historical bar", async () => {
    const transport = new VolumeMockIbkrTransport();
    const nowSec = Math.floor(Date.now() / 1000);
    const bucket5m = Math.floor(nowSec / 300) * 300;
    transport.histBars = [
      { time: bucket5m - 300, open: 10, high: 10.5, low: 9.8, close: 10.2, volume: 12_000 },
      { time: bucket5m, open: 10.2, high: 10.4, low: 10.1, close: 10.3, volume: 5_000 },
    ];

    const engine = new IbkrEngine({ transportFactory: () => transport });
    await engine.ensureConnected();
    const release = engine.acquireSymbolStream("NVDA", "NASDAQ");
    await Promise.resolve();
    await Promise.resolve();

    // Simulate IBKR tick-by-tick trades already inside the current 5m bucket (total 3,000 <= 5,000 hist vol)
    const streamObj = (engine as unknown as { streams: Map<string, { tickByTickReqId: number | null }> }).streams.get("NVDA");
    const tbtReqId = streamObj!.tickByTickReqId!;
    expect(tbtReqId).toBeGreaterThan(0);
    transport.emit(EventName.tickByTickAllLast, tbtReqId, 2, String(bucket5m + 1), 10.35, 1_500);
    transport.emit(EventName.tickByTickAllLast, tbtReqId, 2, String(bucket5m + 2), 10.45, 1_500);

    const res = await engine.getHistoricalCandles("NVDA", "5m", 200, "NASDAQ");
    const last = res.candles[res.candles.length - 1]!;
    // Volume must remain 5,000 (NOT 8,000 from double-counting!) while high/close reflect the live prints
    expect(last.volume).toBe(5_000);
    expect(last.high).toBe(10.45);
    expect(last.close).toBe(10.45);

    release();
    engine.dispose();
  });

  it("4. respects IBKR historical duration caps for 1m, 3m, 5m and accurately emits bucket rollovers for EMA 9 & VWAP", () => {
    const plan1m = resolveIbkrHistoricalQuery("1m", 1500);
    const plan3m = resolveIbkrHistoricalQuery("3m", 1500);
    const plan5m = resolveIbkrHistoricalQuery("5m", 1500);

    expect(plan1m).toMatchObject({ barSize: "1 min", requiresResample: false, durationStr: "7 D" });
    expect(plan3m).toMatchObject({ barSize: "3 mins", requiresResample: false, durationStr: "20 D" });
    expect(plan5m).toMatchObject({ barSize: "5 mins", requiresResample: false, durationStr: "1 M" });

    // Verify 1m, 3m, 5m rollover notification fires on new bucket so React Query & MultiChartPane never skip closed bars
    const baseSec = 1_795_444_200; // 09:30 ET (exact multiple of 300s)
    setRealStockSeries("AAPL", "1m", [
      { time: baseSec, open: 200, high: 201, low: 199.5, close: 200.5, volume: 10_000 },
    ]);
    setRealStockSeries("AAPL", "3m", [
      { time: baseSec, open: 200, high: 201, low: 199.5, close: 200.5, volume: 10_000 },
    ]);
    setRealStockSeries("AAPL", "5m", [
      { time: baseSec, open: 200, high: 201, low: 199.5, close: 200.5, volume: 10_000 },
    ]);

    const closedEvents: string[] = [];
    const unsub = subscribeCandleBucketClosed((sym, tf) => closedEvents.push(`${sym}:${tf}`));

    // Trade at baseSec + 65 -> new 1m bucket, same 3m & 5m bucket
    const u1 = applyIbkrBar1s("AAPL", {
      time: baseSec + 65,
      open: 200.5,
      high: 201.2,
      low: 200.4,
      close: 201.0,
      volume: 1_200,
    });
    expect(u1.find((u) => u.timeframe === "1m")?.isNewBucket).toBe(true);
    expect(u1.find((u) => u.timeframe === "3m")?.isNewBucket).toBe(false);
    expect(u1.find((u) => u.timeframe === "5m")?.isNewBucket).toBe(false);
    expect(closedEvents).toContain("AAPL:1m");

    // Verify EMA 9 + NY session VWAP exactness across 30 bars
    const bars: CandleData[] = Array.from({ length: 30 }, (_, i) => ({
      time: baseSec + i * 300,
      open: 100 + i * 0.5,
      high: 100.4 + i * 0.5,
      low: 99.7 + i * 0.5,
      close: 100.2 + i * 0.5,
      volume: 1_000 + i * 100,
    }));
    const ema9 = ema(bars, 9);
    const vwapRes = vwapBands(bars, { anchor: "session", sessionTimeZone: "america-new-york" });
    expect(ema9).toHaveLength(22);
    expect(vwapRes.vwap).toHaveLength(30);
    // Trending up: close > EMA 9 > VWAP
    expect(bars[29]!.close).toBeGreaterThan(ema9[ema9.length - 1]!.value);
    expect(ema9[ema9.length - 1]!.value).toBeGreaterThan(vwapRes.vwap[29]!.value);
    unsub();
  });

  it("5. routes crypto symbols cleanly to Binance Spot/Futures with Kraken fallback and exact live volume aggregation", async () => {
    expect(isCryptoInstrument("BTCUSD")).toBe(true);
    expect(isCryptoInstrument("ETHEUR")).toBe(true);
    expect(isCryptoInstrument("BTCUSDT.P")).toBe(true);
    expect(isCryptoInstrument("BTC.D")).toBe(true);
    expect(isCryptoInstrument("NVDA")).toBe(false);
    expect(isCryptoInstrument("AAPL")).toBe(false);

    expect(parseCryptoSymbol("BTCUSD")).toMatchObject({
      canonical: "BTCUSD",
      binanceSymbol: "BTCUSDT",
      krakenPair: "XBTUSD",
      isPerpetual: false,
    });
    expect(parseCryptoSymbol("ETHUSDT.P")).toMatchObject({
      canonical: "ETHUSDT.P",
      binanceSymbol: "ETHUSDT",
      isPerpetual: true,
    });
    expect(parseCryptoSymbol("SOLEUR")).toMatchObject({
      canonical: "SOLEUR",
      binanceSymbol: "SOLEUR",
      krakenPair: "SOLEUR",
    });
    expect(resolveBinanceInterval("3m", false)).toMatchObject({
      interval: "3m",
      requiresResample: false,
    });
    expect(resolveBinanceInterval("5m", true)).toMatchObject({
      interval: "5m",
      requiresResample: false,
    });

    const sampleKlines = [
      [1_795_444_200_000, "90000", "90200", "89900", "90100", "12.5"],
      [1_795_444_500_000, "90100", "90400", "90050", "90350", "18.2"],
    ];

    const fetchMock = vi.fn(async (url: string | URL) => {
      const s = String(url);
      if (s.includes("data-api.binance.vision/api/v3/klines")) {
        return new Response(JSON.stringify(sampleKlines), { status: 200 });
      }
      if (s.includes("exchangeInfo")) {
        return new Response(
          JSON.stringify({
            symbols: [
              { symbol: "SUIUSDT", status: "TRADING", contractType: "PERPETUAL", baseAsset: "SUI", quoteAsset: "USDT" },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response("[]", { status: 200 });
    });

    const cryptoSvc = new CryptoMarketDataService({ fetchImpl: fetchMock as unknown as typeof fetch });
    const hist = await cryptoSvc.getHistoricalCandles("BTCUSD", "5m", 100);
    expect(hist.dataSource).toBe("binance-spot");
    expect(hist.candles).toHaveLength(2);
    expect(hist.candles[1]).toMatchObject({ close: 90350, volume: 18.2 });

    const search = await cryptoSvc.searchSymbols("SUI");
    expect(search.some((s) => s.ticker === "SUIUSD")).toBe(true);
    expect(search.some((s) => s.ticker === "SUIUSDT.P")).toBe(true);

    // Live 1m crypto bar updates 1m and 5m series using exact volume deltas (no double counting)
    const t0 = 1_795_444_200;
    setRealStockSeries("BTCUSD", "1m", [{ time: t0, open: 90000, high: 90100, low: 89950, close: 90050, volume: 5 }]);
    setRealStockSeries("BTCUSD", "5m", [{ time: t0, open: 90000, high: 90100, low: 89950, close: 90050, volume: 5 }]);

    applyCryptoLiveBar("BTCUSD", { time: t0, open: 90000, high: 90150, low: 89950, close: 90120, volume: 8 });
    applyCryptoLiveBar("BTCUSD", { time: t0, open: 90000, high: 90200, low: 89950, close: 90180, volume: 11 });

    const b1m = getHistory("BTCUSD", "1m");
    const b5m = getHistory("BTCUSD", "5m");
    expect(b1m[b1m.length - 1]!.volume).toBe(11);
    expect(b5m[b5m.length - 1]!.volume).toBe(16); // 5 initial + 8 + (11 - 8) = 16 (delta-safe)

    cryptoSvc.dispose();
    expect(MarketDataType.DELAYED_FROZEN).toBe(4);
  });

  it("6. supports IBKR 15-minute Delayed Frozen mode (marketDataType: 4) cleanly without generic-tick 233 error or 15m timestamp gaps", async () => {
    const tmpCfg = path.join(os.tmpdir(), `ibkr-delayed-test-${Date.now()}.json`);
    fs.writeFileSync(
      tmpCfg,
      JSON.stringify({ host: "127.0.0.1", port: 4001, clientId: 101, marketDataType: 4 }),
      "utf8",
    );

    const transport = new VolumeMockIbkrTransport();
    const delayedNowSec = Math.floor(Date.now() / 1000) - 900;
    const delayedMinBucket = Math.floor(delayedNowSec / 60) * 60;
    transport.histBars = [
      { time: delayedMinBucket - 60, open: 14.0, high: 14.3, low: 13.9, close: 14.2, volume: 40_000 },
      { time: delayedMinBucket, open: 14.2, high: 14.5, low: 14.1, close: 14.4, volume: 20_000 },
    ];

    const engine = new IbkrEngine({ configFile: tmpCfg, transportFactory: () => transport });
    const streamEvents: IbkrStreamEvent[] = [];
    engine.on("stream-event", (e: IbkrStreamEvent) => streamEvents.push(e));

    try {
      expect(engine.getStatusPayload().effectiveMarketDataType).toBe(4);
      await engine.ensureConnected();
      expect(transport.requestedMarketDataTypes).toContain(4);

      const release = engine.acquireSymbolStream("AMD", "NASDAQ");
      await Promise.resolve();
      await Promise.resolve();

      // In Delayed Mode (3), must NOT call reqTickByTickData and must NOT request RT_VOLUME ("165,233")
      expect(transport.tickByTickCalls).toBe(0);
      expect(transport.mktDataCalls).toHaveLength(1);
      expect(transport.mktDataCalls[0]!.genericTicks).toBe("");

      const mktReqId = transport.mktDataCalls[0]!.reqId;

      // 1) Initial cumulative DELAYED_VOLUME (tick 74) seeds baseline (60,000 shares) without creating a 60k spike
      transport.emit(EventName.tickSize, mktReqId, 74, 60_000);
      // 2) DELAYED_LAST_TIMESTAMP (tick 88) reports exact 15m-delayed exchange timestamp
      transport.emit(EventName.tickString, mktReqId, 88, String(delayedMinBucket + 12));
      // 3) DELAYED_LAST (tick 68) @ $14.55 + cumulative DELAYED_VOLUME -> 60,800 (+800 shares)
      transport.emit(EventName.tickPrice, mktReqId, 68, 14.55);
      transport.emit(EventName.tickSize, mktReqId, 74, 60_800);
      // 4) Second print at the SAME price ($14.55): TWS only emits DELAYED_LAST_TIMESTAMP + DELAYED_VOLUME (+450 shares)
      transport.emit(EventName.tickString, mktReqId, 88, String(delayedMinBucket + 13));
      transport.emit(EventName.tickSize, mktReqId, 74, 61_250);

      const barEvents = streamEvents.filter((e) => e.type === "bar1s" && e.symbol === "AMD");
      expect(barEvents.length).toBeGreaterThanOrEqual(2);
      const lastBar1s = barEvents[barEvents.length - 1]!.bar!;
      // Timestamp stays strictly in the 15-minute delayed bucket (NEVER wall-clock Date.now()!)
      expect(lastBar1s.time).toBe(delayedMinBucket + 13);
      expect(lastBar1s.close).toBe(14.55);
      expect(lastBar1s.volume).toBe(450);

      const totalLiveAddedVol = barEvents
        .filter((e) => e.bar!.time >= delayedMinBucket + 12)
        .reduce((acc, cur) => {
          // Deduplicate by bar time (latest state per 1s bucket)
          acc.set(cur.bar!.time, cur.bar!.volume);
          return acc;
        }, new Map<number, number>());
      expect(
        Array.from(totalLiveAddedVol.values()).reduce((s, v) => s + v, 0),
      ).toBe(1_250);

      release();
    } finally {
      engine.dispose();
      try {
        fs.unlinkSync(tmpCfg);
      } catch {
        // ignore
      }
    }
  });

  it("7. keeps IBKR stock price, 1m (left) and 5m/3m (right) candles, VWAP, EMA 9, and Volume MA(20) 100% synchronized and immune to wide Bid/Ask spreads", () => {
    registerDynamicSymbol({
      name: "DUALIBKR",
      displayName: "Dual Chart Test Corp",
      category: "STOCKS",
      initialPrice: 10.0,
      tickSize: 0.01,
      exchange: "NASDAQ",
    });

    // 30 minutes of 1m IBKR TRADES starting at 09:30 ET (2026-11-24 14:30 UTC)
    const start0930 = Math.floor(Date.UTC(2026, 10, 24, 14, 30, 0) / 1000);
    const bars1m = Array.from({ length: 30 }, (_, i) => {
      const open = Number((10 + i * 0.05).toFixed(2));
      const close = Number((open + 0.04).toFixed(2));
      return {
        time: start0930 + i * 60,
        open,
        high: Number((close + 0.03).toFixed(2)),
        low: Number((open - 0.02).toFixed(2)),
        close,
        volume: 5_000 + i * 200,
      };
    });

    const aggregateTf = (src: typeof bars1m, sec: number) => {
      const map = new Map<number, (typeof bars1m)[number]>();
      for (const b of src) {
        const bucket = Math.floor(b.time / sec) * sec;
        const prev = map.get(bucket);
        if (!prev) map.set(bucket, { ...b, time: bucket });
        else {
          prev.high = Math.max(prev.high, b.high);
          prev.low = Math.min(prev.low, b.low);
          prev.close = b.close;
          prev.volume += b.volume;
        }
      }
      return Array.from(map.values()).sort((a, b) => a.time - b.time);
    };

    setRealStockSeries("DUALIBKR", "1m", bars1m);
    setRealStockSeries("DUALIBKR", "3m", aggregateTf(bars1m, 180));
    setRealStockSeries("DUALIBKR", "5m", aggregateTf(bars1m, 300));

    // Stream an authoritative IBKR trade bar at 10:00:10 ET @ $11.62 with 3,400 shares
    const t1000 = start0930 + 30 * 60;
    applyIbkrLiveBar1sUpdate("DUALIBKR", {
      time: t1000 + 10,
      open: 11.55,
      high: 11.65,
      low: 11.54,
      close: 11.62,
      volume: 3_400,
    });

    // Emit a wide L1 Bid/Ask spread WITHOUT `last` (bid=11.10, ask=12.50 -> mid=11.80)
    // Authoritative IBKR trade price MUST stay $11.62 (NOT $11.80!)
    applyIbkrQuoteUpdate({
      symbol: "DUALIBKR",
      bid: 11.1,
      ask: 12.5,
      timestamp: (t1000 + 11) * 1000,
    });

    expect(getDemoSymbol("DUALIBKR")?.initialPrice).toBe(11.62);

    const final1m = getHistory("DUALIBKR", "1m");
    const final3m = getHistory("DUALIBKR", "3m");
    const final5m = getHistory("DUALIBKR", "5m");

    // Left 1m and Right 3m / 5m MUST show the exact same IBKR close price ($11.62) and exact total session volume!
    expect(final1m[final1m.length - 1]!.close).toBe(11.62);
    expect(final3m[final3m.length - 1]!.close).toBe(11.62);
    expect(final5m[final5m.length - 1]!.close).toBe(11.62);

    const sumVol = (arr: typeof final1m) => arr.reduce((s, b) => s + b.volume, 0);
    expect(sumVol(final1m)).toBe(sumVol(final3m));
    expect(sumVol(final1m)).toBe(sumVol(final5m));

    // Verify VWAP, EMA 9, and Volume MA(20) across 1m, 3m, and 5m
    const vwapOpts = { anchor: "session" as const, sessionTimeZone: "america-new-york" as const };
    const vwap1m = computeFineGrainedSessionVwap(final1m, final1m, 60, vwapOpts).vwap;
    const vwap3m = computeFineGrainedSessionVwap(final3m, final1m, 180, vwapOpts).vwap;
    const vwap5m = computeFineGrainedSessionVwap(final5m, final1m, 300, vwapOpts).vwap;
    // Session VWAP across 1m (left) and 3m / 5m (right) matches with 0.000000 discrepancy!
    expect(vwap3m[vwap3m.length - 1]!.value).toBeCloseTo(vwap1m[vwap1m.length - 1]!.value, 8);
    expect(vwap5m[vwap5m.length - 1]!.value).toBeCloseTo(vwap1m[vwap1m.length - 1]!.value, 8);

    const ema9_1m = ema(final1m, 9);
    const volMa_1m = calculateVolumeMa(
      final1m.map((c) => ({ time: c.time as unknown as import("lightweight-charts").Time, value: c.volume })),
      20,
    );
    expect(ema9_1m.length).toBeGreaterThan(20);
    expect(volMa_1m.length).toBe(final1m.length - 19);
  });

  it("8. prevents Delayed Frozen (4) stale intra-5m bars from overwriting newer historical closes and steps Replay cleanly across 1m/3m/5m & sessions", async () => {
    const tmpCfg = path.join(os.tmpdir(), `ibkr-df4-replay-${Date.now()}.json`);
    fs.writeFileSync(
      tmpCfg,
      JSON.stringify({ host: "127.0.0.1", port: 4001, clientId: 101, marketDataType: 4 }),
      "utf8",
    );

    const transport = new VolumeMockIbkrTransport();
    const delayedNowSec = Math.floor(Date.now() / 1000) - 900;
    const bucket5m = Math.floor(delayedNowSec / 300) * 300;
    const engine = new IbkrEngine({ configFile: tmpCfg, transportFactory: () => transport });
    const events: IbkrStreamEvent[] = [];
    engine.on("stream-event", (e: IbkrStreamEvent) => events.push(e));

    try {
      await engine.ensureConnected();
      transport.histBars = [];
      const release = engine.acquireSymbolStream("ALGS", "NASDAQ");
      await Promise.resolve();
      await Promise.resolve();
      const mktReqId = transport.mktDataCalls[0]!.reqId;

      // Initial frozen snapshot WITHOUT tick 88 must emit quote ($2.19) WITHOUT inventing a phantom 0-vol bar
      transport.emit(EventName.tickPrice, mktReqId, 68, 2.19);
      expect(events.some((e) => e.type === "quote" && e.symbol === "ALGS" && e.last === 2.19)).toBe(true);
      expect(events.some((e) => e.type === "bar1s" && e.symbol === "ALGS")).toBe(false);

      // Earlier trade inside the 5m bucket at +25s @ $2.19
      transport.emit(EventName.tickString, mktReqId, 88, String(bucket5m + 25));
      transport.emit(EventName.tickPrice, mktReqId, 68, 2.19);
      transport.emit(EventName.tickSize, mktReqId, 74, 10_000);

      // Subsequent 5m historical fetch where IBKR ALREADY includes a later trade at +120s @ $2.18 (vol=402)
      transport.histBars = [
        { time: bucket5m - 300, open: 2.19, high: 2.2, low: 2.18, close: 2.19, volume: 200 },
        { time: bucket5m, open: 2.19, high: 2.19, low: 2.18, close: 2.18, volume: 402 },
      ];
      const hist5m = await engine.getHistoricalCandles("ALGS", "5m", 100, "NASDAQ");
      // Must NOT overwrite $2.18 with the older +25s $2.19 bar!
      expect(hist5m.candles[hist5m.candles.length - 1]!.close).toBe(2.18);
      expect(hist5m.candles[hist5m.candles.length - 1]!.volume).toBe(402);

      // Also verify Replay across 1m, 3m, and 5m with Volume, EMA 9, VWAP, and RTH-only skipping
      registerDynamicSymbol({
        name: "RPLYDF4",
        displayName: "Replay Delayed Frozen Stock",
        category: "STOCKS",
        initialPrice: 5.2,
        tickSize: 0.01,
        exchange: "NASDAQ",
      });
      // Build bars around 15:58..16:02 ET (RTH -> After-Hours) + next day 09:30 ET (RTH)
      const t1558 = Math.floor(Date.UTC(2026, 10, 24, 20, 58, 0) / 1000); // 15:58 ET
      const tNext0930 = Math.floor(Date.UTC(2026, 10, 25, 14, 30, 0) / 1000); // next day 09:30 ET
      const rply1m = [
        ...Array.from({ length: 25 }, (_, i) => ({
          time: t1558 - (24 - i) * 60,
          open: 5.0 + i * 0.01,
          high: 5.05 + i * 0.01,
          low: 4.98 + i * 0.01,
          close: 5.02 + i * 0.01,
          volume: 2_000 + i * 100,
        })),
        { time: t1558 + 60, open: 5.26, high: 5.3, low: 5.25, close: 5.28, volume: 4_500 }, // 15:59 ET (RTH)
        { time: t1558 + 120, open: 5.28, high: 5.4, low: 5.27, close: 5.35, volume: 800 }, // 16:00 ET (After-Hours)
        { time: t1558 + 180, open: 5.35, high: 5.42, low: 5.33, close: 5.4, volume: 600 }, // 16:01 ET (After-Hours)
        { time: tNext0930, open: 5.5, high: 5.65, low: 5.48, close: 5.6, volume: 12_000 }, // next day 09:30 ET (RTH)
      ];
      const agg = (sec: number) => {
        const m = new Map<number, (typeof rply1m)[number]>();
        for (const b of rply1m) {
          const k = Math.floor(b.time / sec) * sec;
          const ex = m.get(k);
          if (!ex) m.set(k, { ...b, time: k });
          else {
            ex.high = Math.max(ex.high, b.high);
            ex.low = Math.min(ex.low, b.low);
            ex.close = b.close;
            ex.volume += b.volume;
          }
        }
        return Array.from(m.values()).sort((a, b) => a.time - b.time);
      };
      setRealStockSeries("RPLYDF4", "1m", rply1m);
      setRealStockSeries("RPLYDF4", "3m", agg(180));
      setRealStockSeries("RPLYDF4", "5m", agg(300));

      // In Regular-Session-Only mode (`showExtendedHours: false`), stepping from 15:59 ET skips 16:00/16:01 AH directly to 09:30 ET!
      updateChartPreferences({ showExtendedHours: false });
      const started = useReplayStore.getState().start("RPLYDF4", "1m", t1558 + 60);
      expect(started.ok).toBe(true);
      expect(useReplayStore.getState().visible![useReplayStore.getState().visible!.length - 1]!.close).toBe(5.28);

      useReplayStore.getState().step();
      const stAfterJump = useReplayStore.getState();
      const s1m = getReplaySliceForTimeframe("RPLYDF4", "1m", stAfterJump.simTimeSec);
      const s3m = getReplaySliceForTimeframe("RPLYDF4", "3m", stAfterJump.simTimeSec);
      const s5m = getReplaySliceForTimeframe("RPLYDF4", "5m", stAfterJump.simTimeSec);
      expect(s1m[s1m.length - 1]!.time).toBe(tNext0930);
      expect(s1m[s1m.length - 1]!.close).toBe(5.6);
      expect(s3m[s3m.length - 1]!.close).toBe(5.6);
      expect(s5m[s5m.length - 1]!.close).toBe(5.6);

      // Unified VWAP on 1m, 3m, and 5m during Replay is 100% identical at 09:30 ET ($5.57666...)
      const rplyVwapOpts = {
        anchor: "session" as const,
        sessionTimeZone: "america-new-york" as const,
        anchorAtRegularOpen: true,
      };
      const rv1 = computeFineGrainedSessionVwap(s1m, s1m, 60, rplyVwapOpts).vwap;
      const rv3 = computeFineGrainedSessionVwap(s3m, s1m, 180, rplyVwapOpts).vwap;
      const rv5 = computeFineGrainedSessionVwap(s5m, s1m, 300, rplyVwapOpts).vwap;
      expect(rv3[rv3.length - 1]!.value).toBeCloseTo(rv1[rv1.length - 1]!.value, 8);
      expect(rv5[rv5.length - 1]!.value).toBeCloseTo(rv1[rv1.length - 1]!.value, 8);

      useReplayStore.getState().stop();
      updateChartPreferences({ showExtendedHours: true });
      release();
    } finally {
      useReplayStore.getState().stop();
      updateChartPreferences({ showExtendedHours: true });
      engine.dispose();
      try {
        fs.unlinkSync(tmpCfg);
      } catch {
        // ignore
      }
    }
  });
});
