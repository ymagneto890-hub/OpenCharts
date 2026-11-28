import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
import fs from "fs";
import type { IncomingMessage, ServerResponse } from "http";
import {
  IbkrEngine,
  type IbkrConnectionConfig,
  type IbkrStreamEvent,
} from "./src/server/ibkrEngine.ts";
import {
  FinvizScreener,
  type FinvizScreenerQueryPayload,
  type FinvizScreenerStreamEvent,
} from "./src/server/finvizScreener.ts";
import { StockNewsProvider } from "./src/server/stockNews.ts";
import {
  CryptoMarketDataService,
  type CryptoStreamEvent,
} from "./src/server/cryptoMarketData.ts";

const SCREENSHOTS_DIR = path.resolve(__dirname, "./trade_screenshots");
const STATE_FILE = path.resolve(SCREENSHOTS_DIR, "demo_state.json");
const IBKR_CONFIG_FILE = path.resolve(SCREENSHOTS_DIR, "ibkr_config.json");

function ensureScreenshotsDir() {
  if (!fs.existsSync(SCREENSHOTS_DIR)) {
    fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
  }
}

function readJsonBody<T>(
  req: IncomingMessage,
  res: ServerResponse,
  maxBytes: number,
  onParsed: (payload: T) => void,
): void {
  let body = "";
  let tooLarge = false;
  req.on("error", () => {
    if (!res.writableEnded) {
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "Request stream error" }));
    }
  });
  req.on("data", (chunk) => {
    if (tooLarge) return;
    body += chunk.toString();
    if (Buffer.byteLength(body, "utf8") > maxBytes) {
      tooLarge = true;
      if (!res.writableEnded) {
        res.statusCode = 413;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "Request payload too large" }));
      }
      req.destroy();
    }
  });
  req.on("end", () => {
    if (tooLarge || res.writableEnded) return;
    try {
      const parsed = (body.trim() ? JSON.parse(body) : {}) as T;
      onParsed(parsed);
    } catch {
      res.statusCode = 400;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "Invalid JSON payload" }));
    }
  });
}

function sendJson(res: ServerResponse, statusCode: number, data: unknown): void {
  if (res.writableEnded) return;
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(data));
}

function diskStoragePlugin(): Plugin {
  let wsServer: import("vite").ViteDevServer["ws"] | null = null;
  let everConnected = false;
  let lastActiveAt = Date.now();

  const ibkr = new IbkrEngine({ configFile: IBKR_CONFIG_FILE });
  const finviz = new FinvizScreener();
  const stockNews = new StockNewsProvider({
    ibkrFallback: (sym) =>
      ibkr.getStatusPayload().connectionState === "connected"
        ? ibkr.getStockNews(sym)
        : Promise.resolve({ items: [] }),
  });
  const cryptoData = new CryptoMarketDataService();
  const activeSseCloseHandlers = new Set<() => void>();

  const attachMiddleware = (middlewares: {
    use: (
      fn: (req: IncomingMessage, res: ServerResponse, next: () => void) => void,
    ) => void;
  }) => {
    middlewares.use((req, res, next) => {
      const url = req.url || "";

      // 0. Health & client-lifecycle check for the Windows desktop launcher
      if (req.method === "GET" && url.startsWith("/__opencharts_health")) {
        const wsClients = wsServer?.clients ? wsServer.clients.size : 0;
        const sseClients = activeSseCloseHandlers.size;
        const activeClients = wsClients + sseClients;
        if (activeClients > 0) {
          everConnected = true;
          lastActiveAt = Date.now();
        }
        sendJson(res, 200, {
          app: "opencharts",
          status: "ok",
          pid: process.pid,
          wsClients,
          sseClients,
          activeClients,
          everConnected,
          idleMs: activeClients > 0 ? 0 : Math.max(0, Date.now() - lastActiveAt),
        });
        return;
      }

      lastActiveAt = Date.now();

      // 0b. IBKR TWS / IB Gateway configuration & live socket state
      if (url.startsWith("/__api/ibkr-config")) {
        if (req.method === "GET") {
          sendJson(res, 200, ibkr.getStatusPayload());
          return;
        }
        if (req.method === "DELETE") {
          void ibkr
            .resetConfig()
            .then((status) => sendJson(res, 200, status))
            .catch((err) =>
              sendJson(res, 500, {
                error: err instanceof Error ? err.message : String(err),
              }),
            );
          return;
        }
        if (req.method === "POST") {
          readJsonBody<Partial<IbkrConnectionConfig>>(req, res, 16 * 1024, (payload) => {
            ensureScreenshotsDir();
            void ibkr
              .updateConfig(payload)
              .then((status) => sendJson(res, 200, status))
              .catch((err) =>
                sendJson(res, 400, {
                  error: err instanceof Error ? err.message : String(err),
                }),
              );
          });
          return;
        }
      }

      // 1. Serve saved screenshot files from disk: GET /trade-screenshots/<filename>
      if (req.method === "GET" && url.startsWith("/trade-screenshots/")) {
        ensureScreenshotsDir();
        let rawName: string;
        try {
          rawName = decodeURIComponent(url.replace(/^\/trade-screenshots\//, "").split("?")[0]);
        } catch {
          res.statusCode = 400;
          res.end("Bad Request");
          return;
        }
        const safeName = path.basename(rawName);
        const ext = path.extname(safeName).toLowerCase();
        const allowedMime: Record<string, string> = {
          ".png": "image/png",
          ".jpg": "image/jpeg",
          ".jpeg": "image/jpeg",
          ".webp": "image/webp",
        };
        const mime = allowedMime[ext];
        const filePath = path.join(SCREENSHOTS_DIR, safeName);
        if (mime && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
          res.setHeader("Content-Type", mime);
          res.setHeader("Cache-Control", "public, max-age=31536000");
          fs.createReadStream(filePath).pipe(res);
          return;
        }
        res.statusCode = 404;
        res.end("Not found");
        return;
      }

      // 2. Save screenshot to disk: POST /__local_storage/screenshot
      if (req.method === "POST" && url.startsWith("/__local_storage/screenshot")) {
        ensureScreenshotsDir();
        readJsonBody<{ filename?: string; dataUrl?: string }>(req, res, 16 * 1024 * 1024, (payload) => {
          try {
            const dataUrl = payload.dataUrl || "";
            const match = dataUrl.match(/^data:image\/(png|jpeg|jpg|webp);base64,(.+)$/);
            if (!match) {
              sendJson(res, 400, { error: "Invalid image dataUrl" });
              return;
            }
            const ext = match[1] === "jpeg" ? "jpg" : match[1];
            const base64Data = match[2];
            const baseName = (payload.filename || `shot_${Date.now()}`).replace(
              /[^a-zA-Z0-9_-]/g,
              "_",
            );
            const finalName = `${baseName}.${ext}`;
            const filePath = path.join(SCREENSHOTS_DIR, finalName);
            fs.writeFileSync(filePath, Buffer.from(base64Data, "base64"));
            sendJson(res, 200, {
              url: `/trade-screenshots/${finalName}`,
              diskPath: filePath,
            });
          } catch (err) {
            sendJson(res, 500, { error: String(err) });
          }
        });
        return;
      }

      // 3. Read/Write demo engine state on disk: GET/POST /__local_storage/state
      if (url.startsWith("/__local_storage/state")) {
        ensureScreenshotsDir();
        if (req.method === "GET") {
          res.setHeader("Cache-Control", "no-store");
          if (fs.existsSync(STATE_FILE)) {
            res.statusCode = 200;
            res.setHeader("Content-Type", "application/json");
            fs.createReadStream(STATE_FILE).pipe(res);
          } else {
            res.statusCode = 404;
            res.end("null");
          }
          return;
        }
        if (req.method === "POST") {
          let body = "";
          req.on("error", () => {
            if (!res.writableEnded) {
              sendJson(res, 500, { error: "Request stream error" });
            }
          });
          req.on("data", (chunk) => {
            body += chunk.toString();
          });
          req.on("end", () => {
            try {
              JSON.parse(body);
            } catch {
              sendJson(res, 400, { error: "Invalid JSON payload" });
              return;
            }
            const tmpFile = `${STATE_FILE}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
            try {
              fs.writeFileSync(tmpFile, body, "utf-8");
              fs.renameSync(tmpFile, STATE_FILE);
              sendJson(res, 200, { saved: true });
            } catch (err) {
              try {
                if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
              } catch {
                // ignore cleanup failure
              }
              sendJson(res, 500, { error: String(err) });
            }
          });
          return;
        }
      }

      // 4. IBKR Historical & Stabilized OHLCV Candles (any timeframe + 1s tail + VWAP seeds)
      if (req.method === "GET" && url.startsWith("/__api/ibkr-candles")) {
        const parsedUrl = new URL(url, "http://127.0.0.1");
        const symbol = (parsedUrl.searchParams.get("symbol") ?? "").trim().toUpperCase();
        const timeframe = (parsedUrl.searchParams.get("timeframe") ?? "1m").trim();
        const minBarsRaw = Number(parsedUrl.searchParams.get("minBars") ?? "1500");
        const minBars = Number.isFinite(minBarsRaw) && minBarsRaw > 0 ? Math.min(20_000, Math.round(minBarsRaw)) : 1500;
        const exchangeHint = (parsedUrl.searchParams.get("exchange") ?? "").trim() || undefined;
        const targetDate = (parsedUrl.searchParams.get("targetDate") ?? "").trim() || undefined;

        if (!symbol) {
          sendJson(res, 400, { error: "Missing symbol parameter" });
          return;
        }

        const ac = new AbortController();
        const onClose = () => {
          if (!res.writableEnded) ac.abort();
        };
        res.on("close", onClose);

        void ibkr
          .getHistoricalCandles(symbol, timeframe, minBars, exchangeHint, ac.signal, targetDate)
          .then((result) => {
            res.off("close", onClose);
            sendJson(res, 200, result);
          })
          .catch((err) => {
            res.off("close", onClose);
            if (ac.signal.aborted || res.writableEnded) return;
            sendJson(res, 502, {
              error: err instanceof Error ? err.message : String(err),
            });
          });
        return;
      }

      // 5. IBKR Multiplexed Real-Time SSE Stream (1s base bars + quote + consolidated VWAP)
      if (req.method === "GET" && url.startsWith("/__api/ibkr-stream")) {
        const parsedUrl = new URL(url, "http://127.0.0.1");
        const rawSymbols = Array.from(
          new Set(
            (parsedUrl.searchParams.get("symbols") ?? "")
              .split(",")
              .map((s) => s.trim().toUpperCase())
              .filter(Boolean),
          ),
        ).slice(0, 12);

        const exchMap = new Map<string, string>();
        const rawExchanges = (parsedUrl.searchParams.get("exchanges") ?? "").split(",");
        for (const pair of rawExchanges) {
          const [sym, exch] = pair.split(":");
          if (sym && exch) exchMap.set(sym.trim().toUpperCase(), exch.trim().toUpperCase());
        }

        res.statusCode = 200;
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("Connection", "keep-alive");
        res.flushHeaders?.();

        const writeEvent = (evt: IbkrStreamEvent) => {
          if (res.writableEnded) return;
          try {
            res.write(`data: ${JSON.stringify(evt)}\n\n`);
          } catch {
            // ignore broken pipe
          }
        };

        const symSet = new Set(rawSymbols);
        const onStreamEvent = (evt: IbkrStreamEvent) => {
          if (evt.type === "status") {
            writeEvent(evt);
            return;
          }
          if (evt.symbol && symSet.has(evt.symbol)) {
            writeEvent(evt);
          }
        };
        ibkr.on("stream-event", onStreamEvent);

        const status = ibkr.getStatusPayload();
        writeEvent({
          type: "status",
          connected: status.connectionState === "connected",
          connectionState: status.connectionState,
          marketDataType: status.effectiveMarketDataType ?? status.marketDataType,
          reason: status.lastError ?? undefined,
        });

        const releases = rawSymbols.map((sym) => ibkr.acquireSymbolStream(sym, exchMap.get(sym)));

        const heartbeatTimer = setInterval(() => {
          if (res.writableEnded) return;
          try {
            res.write(": ping\n\n");
          } catch {
            // ignore heartbeat error
          }
        }, 15_000);

        let cleaned = false;
        const cleanup = () => {
          if (cleaned) return;
          cleaned = true;
          clearInterval(heartbeatTimer);
          ibkr.off("stream-event", onStreamEvent);
          activeSseCloseHandlers.delete(cleanup);
          for (const release of releases) {
            release();
          }
          if (!res.writableEnded) {
            try {
              res.end();
            } catch {
              // ignore close error
            }
          }
        };

        activeSseCloseHandlers.add(cleanup);
        req.on("close", cleanup);
        req.on("error", cleanup);
        res.on("close", cleanup);
        return;
      }

      // 6a. Finviz Auto-Refreshing Stock Screener SSE Stream: GET /__api/stock-screener/stream
      if (req.method === "GET" && url.startsWith("/__api/stock-screener/stream")) {
        const parsedUrl = new URL(url, "http://127.0.0.1");
        let filterPayload: FinvizScreenerQueryPayload = {};
        try {
          const rawFilters = parsedUrl.searchParams.get("filters");
          if (rawFilters) {
            filterPayload = JSON.parse(rawFilters) as FinvizScreenerQueryPayload;
          }
        } catch {
          filterPayload = {};
        }

        res.statusCode = 200;
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("Connection", "keep-alive");
        res.flushHeaders?.();

        const writeScreenerEvent = (evt: FinvizScreenerStreamEvent) => {
          if (res.writableEnded) return;
          try {
            res.write(`data: ${JSON.stringify(evt)}\n\n`);
          } catch {
            // ignore broken pipe
          }
        };

        const releaseScanner = finviz.acquireStream(filterPayload, writeScreenerEvent);
        const heartbeatTimer = setInterval(() => {
          if (res.writableEnded) return;
          try {
            res.write(": ping\n\n");
          } catch {
            // ignore heartbeat error
          }
        }, 15_000);

        let cleaned = false;
        const cleanup = () => {
          if (cleaned) return;
          cleaned = true;
          clearInterval(heartbeatTimer);
          activeSseCloseHandlers.delete(cleanup);
          releaseScanner();
          if (!res.writableEnded) {
            try {
              res.end();
            } catch {
              // ignore close error
            }
          }
        };

        activeSseCloseHandlers.add(cleanup);
        req.on("close", cleanup);
        req.on("error", cleanup);
        res.on("close", cleanup);
        return;
      }

      // 6. Finviz Stock Screener (Scraped SSR JSON): POST /__api/stock-screener
      if (req.method === "POST" && url.startsWith("/__api/stock-screener")) {
        const ac = new AbortController();
        const onAbortClose = () => {
          if (!res.writableEnded) ac.abort();
        };
        res.on("close", onAbortClose);

        readJsonBody<FinvizScreenerQueryPayload>(req, res, 64 * 1024, (payload) => {
          void finviz
            .scan(payload, ac.signal)
            .then((result) => {
              res.off("close", onAbortClose);
              sendJson(res, 200, result);
            })
            .catch((err) => {
              res.off("close", onAbortClose);
              if (ac.signal.aborted || res.writableEnded) return;
              sendJson(res, 502, {
                error: err instanceof Error ? err.message : String(err),
              });
            });
        });
        return;
      }

      // 7. IBKR Contract / Symbol Search: GET /__api/stock-search?q=...
      if (req.method === "GET" && url.startsWith("/__api/stock-search")) {
        const parsedUrl = new URL(url, "http://127.0.0.1");
        const query = (parsedUrl.searchParams.get("q") ?? "").trim();
        if (!query) {
          sendJson(res, 200, { items: [] });
          return;
        }
        void ibkr
          .searchSymbols(query)
          .then((items) => sendJson(res, 200, { items }))
          .catch((err) =>
            sendJson(res, 502, {
              error: err instanceof Error ? err.message : String(err),
              items: [],
            }),
          );
        return;
      }

      // 8. Stock News & Catalyst Headlines (Finviz Quote News + Google News RSS + optional IBKR): GET /__api/stock-news?symbol=...
      if (req.method === "GET" && url.startsWith("/__api/stock-news")) {
        const parsedUrl = new URL(url, "http://127.0.0.1");
        const symbol = (parsedUrl.searchParams.get("symbol") ?? "").trim().toUpperCase();
        if (!symbol) {
          sendJson(res, 400, { error: "Missing symbol parameter", items: [] });
          return;
        }
        void stockNews
          .getNews(symbol)
          .then((result) => sendJson(res, 200, result))
          .catch((err) =>
            sendJson(res, 502, {
              symbol,
              items: [],
              error: err instanceof Error ? err.message : String(err),
            }),
          );
        return;
      }

      // 9. Crypto Historical OHLCV Candles (Binance Spot/Futures + Kraken + Coinbase + CoinGecko BTC.D)
      if (req.method === "GET" && url.startsWith("/__api/crypto-candles")) {
        const parsedUrl = new URL(url, "http://127.0.0.1");
        const symbol = (parsedUrl.searchParams.get("symbol") ?? "").trim().toUpperCase();
        const timeframe = (parsedUrl.searchParams.get("timeframe") ?? "5m").trim();
        const minBarsRaw = Number(parsedUrl.searchParams.get("minBars") ?? "1500");
        const minBars =
          Number.isFinite(minBarsRaw) && minBarsRaw > 0
            ? Math.min(3_500, Math.round(minBarsRaw))
            : 1500;
        const targetDate = (parsedUrl.searchParams.get("targetDate") ?? "").trim() || undefined;
        if (!symbol) {
          sendJson(res, 400, { error: "Missing symbol parameter" });
          return;
        }
        const ac = new AbortController();
        const onClose = () => {
          if (!res.writableEnded) ac.abort();
        };
        res.on("close", onClose);
        void cryptoData
          .getHistoricalCandles(symbol, timeframe, minBars, ac.signal, targetDate)
          .then((result) => {
            res.off("close", onClose);
            sendJson(res, 200, result);
          })
          .catch((err) => {
            res.off("close", onClose);
            if (ac.signal.aborted || res.writableEnded) return;
            sendJson(res, 502, {
              error: err instanceof Error ? err.message : String(err),
            });
          });
        return;
      }

      // 10. Crypto Real-Time Multiplexed SSE Stream: GET /__api/crypto-stream?symbols=...
      if (req.method === "GET" && url.startsWith("/__api/crypto-stream")) {
        const parsedUrl = new URL(url, "http://127.0.0.1");
        const rawSymbols = Array.from(
          new Set(
            (parsedUrl.searchParams.get("symbols") ?? "")
              .split(",")
              .map((s) => s.trim().toUpperCase())
              .filter(Boolean),
          ),
        ).slice(0, 12);

        res.statusCode = 200;
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("Connection", "keep-alive");
        res.flushHeaders?.();

        const writeEvent = (evt: CryptoStreamEvent) => {
          if (res.writableEnded) return;
          try {
            res.write(`data: ${JSON.stringify(evt)}\n\n`);
          } catch {
            // ignore broken pipe
          }
        };

        writeEvent({ type: "status", connected: true });
        const releases = rawSymbols.map((sym) => cryptoData.acquireSymbolStream(sym, writeEvent));

        const heartbeatTimer = setInterval(() => {
          if (res.writableEnded) return;
          try {
            res.write(": ping\n\n");
          } catch {
            // ignore heartbeat error
          }
        }, 15_000);

        let cleaned = false;
        const cleanup = () => {
          if (cleaned) return;
          cleaned = true;
          clearInterval(heartbeatTimer);
          activeSseCloseHandlers.delete(cleanup);
          for (const release of releases) {
            release();
          }
          if (!res.writableEnded) {
            try {
              res.end();
            } catch {
              // ignore close error
            }
          }
        };

        activeSseCloseHandlers.add(cleanup);
        req.on("close", cleanup);
        req.on("error", cleanup);
        res.on("close", cleanup);
        return;
      }

      // 11. Crypto Symbol Search (Binance Spot + USD-M Perpetuals): GET /__api/crypto-search?q=...
      if (req.method === "GET" && url.startsWith("/__api/crypto-search")) {
        const parsedUrl = new URL(url, "http://127.0.0.1");
        const query = (parsedUrl.searchParams.get("q") ?? "").trim();
        if (!query) {
          sendJson(res, 200, { items: [] });
          return;
        }
        void cryptoData
          .searchSymbols(query)
          .then((items) => sendJson(res, 200, { items }))
          .catch((err) =>
            sendJson(res, 502, {
              error: err instanceof Error ? err.message : String(err),
              items: [],
            }),
          );
        return;
      }

      next();
    });
  };

  const shutdownStreamBridge = () => {
    for (const closeFn of Array.from(activeSseCloseHandlers)) {
      closeFn();
    }
    activeSseCloseHandlers.clear();
    ibkr.dispose();
    cryptoData.dispose();
  };

  return {
    name: "opencharts-disk-storage",
    configureServer(server) {
      wsServer = server.ws;
      attachMiddleware(server.middlewares);
      server.httpServer?.once("close", shutdownStreamBridge);
    },
    configurePreviewServer(server) {
      attachMiddleware(server.middlewares);
      server.httpServer?.once("close", shutdownStreamBridge);
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, __dirname, "");
  for (const key of ["IBKR_HOST", "IBKR_PORT", "IBKR_CLIENT_ID", "IBKR_MARKET_DATA_TYPE"] as const) {
    if (!process.env[key] && env[key]) {
      process.env[key] = env[key];
    }
  }

  return {
    plugins: [react(), diskStoragePlugin()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "@propsim/types": path.resolve(__dirname, "./src/vendor/types.ts"),
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("node_modules")) {
            if (
              id.includes("/react/") ||
              id.includes("/react-dom/") ||
              id.includes("/react-router") ||
              id.includes("/@radix-ui/") ||
              id.includes("/@tanstack/") ||
              id.includes("/zustand/") ||
              id.includes("/scheduler/")
            ) {
              return "vendor-react";
            }
            if (id.includes("/lucide-react/")) {
              return "vendor-icons";
            }
          }
        },
      },
    },
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    watch: {
      ignored: ["**/trade_screenshots/**"],
    },
    proxy: {
      "/api": {
        target: "http://localhost:3000",
        changeOrigin: true,
      },
      "/ws": {
        target: "ws://localhost:3000",
        ws: true,
      },
    },
  },
  };
});
