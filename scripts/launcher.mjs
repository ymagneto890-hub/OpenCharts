#!/usr/bin/env node
/**
 * OpenCharts — Automatic Windows Desktop Launcher & Lifecycle Supervisor
 *
 * Responsibilities:
 * 1. Resolves the project root dynamically regardless of current working directory.
 * 2. Prevents race conditions via a single-instance lockfile.
 * 3. Checks if OpenCharts is already serving on 127.0.0.1:5173:
 *    - If already running and a browser window is connected, brings the existing
 *      OpenCharts window to the foreground without spawning a duplicate server or window.
 *    - If already running with 0 connected windows, reuses the running server and opens Chrome.
 *    - If port 5173 is occupied by a different application, reports a clear error dialog.
 * 4. If not running, starts Vite in a background daemon bound strictly to 127.0.0.1:5173,
 *    waits until HTTP readiness is verified on both /__opencharts_health and /,
 *    and then launches the installed Chrome PWA window (or Chrome --app fallback).
 * 5. Supervises the server lifecycle and automatically terminates the Vite process
 *    once all OpenCharts browser windows have been closed (with a reload grace period).
 */

import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "..");

process.chdir(PROJECT_ROOT);

const STATE_DIR = path.join(PROJECT_ROOT, "trade_screenshots");
const LOCK_FILE = path.join(STATE_DIR, "launcher.lock");
const SERVER_LOG = path.join(STATE_DIR, "server.log");
const CHROME_PWA_APP_ID = "idemibpphagihbobmgmaojhjfidlfpdl";
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 5173;

function ensureStateDir() {
  if (!fs.existsSync(STATE_DIR)) {
    fs.mkdirSync(STATE_DIR, { recursive: true });
  }
}

function parseArgs(argv) {
  const opts = {
    daemon: false,
    noBrowser: false,
    silentErrors: false,
    stopServer: false,
    host: DEFAULT_HOST,
    port: Number(process.env.OPENCHARTS_PORT || DEFAULT_PORT),
    startupGraceMs: Number(process.env.OPENCHARTS_STARTUP_GRACE_MS || 45_000),
    shutdownGraceMs: Number(process.env.OPENCHARTS_SHUTDOWN_GRACE_MS || 120_000),
    readyTimeoutMs: Number(process.env.OPENCHARTS_READY_TIMEOUT_MS || 40_000),
    viteBinOverride: process.env.OPENCHARTS_VITE_BIN || "",
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--daemon") opts.daemon = true;
    else if (arg === "--no-browser") opts.noBrowser = true;
    else if (arg === "--silent-errors") opts.silentErrors = true;
    else if (arg === "--stop") opts.stopServer = true;
    else if (arg === "--port" && argv[i + 1]) opts.port = Number(argv[++i]);
    else if (arg === "--startup-grace-ms" && argv[i + 1]) opts.startupGraceMs = Number(argv[++i]);
    else if (arg === "--shutdown-grace-ms" && argv[i + 1]) opts.shutdownGraceMs = Number(argv[++i]);
    else if (arg === "--ready-timeout-ms" && argv[i + 1]) opts.readyTimeoutMs = Number(argv[++i]);
    else if (arg === "--vite-bin" && argv[i + 1]) opts.viteBinOverride = argv[++i];
  }
  return opts;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isProcessAlive(pid) {
  if (!pid || typeof pid !== "number" || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killProcessTree(pid) {
  if (!pid || pid <= 0) return;
  try {
    if (process.platform === "win32") {
      execFileSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
    } else {
      process.kill(pid, "SIGTERM");
    }
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already exited
    }
  }
}

function showWindowsErrorDialog(title, message, silent = false) {
  console.error(`[${title}] ${message}`);
  if (silent || process.platform !== "win32") return;
  try {
    const cleanMsg = String(message).replace(/"/g, "'").replace(/\r?\n/g, "\" & vbCrLf & \"");
    const cleanTitle = String(title).replace(/"/g, "'");
    const vbsPath = path.join(STATE_DIR, "error_dialog.vbs");
    ensureStateDir();
    fs.writeFileSync(
      vbsPath,
      `MsgBox "${cleanMsg}", 16, "${cleanTitle}"\r\n`,
      "utf8",
    );
    execFileSync("wscript.exe", ["//nologo", vbsPath], {
      stdio: "ignore",
      windowsHide: false,
    });
  } catch {
    // ignore dialog error
  }
}

function httpGet(host, port, urlPath, timeoutMs = 1200) {
  return new Promise((resolve) => {
    const req = http.get(
      {
        host,
        port,
        path: urlPath,
        timeout: timeoutMs,
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          if (body.length < 65536) body += chunk;
        });
        res.on("end", () => {
          resolve({ ok: true, statusCode: res.statusCode || 0, body });
        });
      },
    );
    req.on("timeout", () => {
      req.destroy();
      resolve({ ok: false, statusCode: 0, body: "" });
    });
    req.on("error", () => {
      resolve({ ok: false, statusCode: 0, body: "" });
    });
  });
}

function checkTcpPortInUse(host, port, timeoutMs = 800) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const done = (inUse) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(inUse);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
    socket.connect(port, host);
  });
}

async function checkOpenChartsHealth(host, port) {
  const res = await httpGet(host, port, "/__opencharts_health", 2500);
  if (!res.ok || res.statusCode !== 200) {
    return { running: false, health: null };
  }
  try {
    const data = JSON.parse(res.body);
    if (data && data.app === "opencharts" && data.status === "ok") {
      return { running: true, health: data };
    }
  } catch {
    // not JSON from opencharts
  }
  return { running: false, health: null };
}

async function isOpenChartsFullyReady(host, port) {
  const { running, health } = await checkOpenChartsHealth(host, port);
  if (!running) return { ready: false, health: null };
  const rootRes = await httpGet(host, port, "/", 8000);
  const ready =
    rootRes.ok &&
    rootRes.statusCode === 200 &&
    (rootRes.body.includes("OpenCharts") || rootRes.body.includes('id="root"'));
  return { ready, health };
}

function focusExistingOpenChartsWindow() {
  if (process.platform !== "win32") return false;
  try {
    const vbsPath = path.join(STATE_DIR, "focus_window.vbs");
    ensureStateDir();
    fs.writeFileSync(
      vbsPath,
      [
        'Set WshShell = CreateObject("WScript.Shell")',
        'If WshShell.AppActivate("OpenCharts") Then',
        "  WScript.Quit 0",
        "Else",
        "  WScript.Quit 1",
        "End If",
      ].join("\r\n"),
      "utf8",
    );
    execFileSync("wscript.exe", ["//nologo", vbsPath], {
      stdio: "ignore",
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
}

function findChromePaths() {
  const localAppData = process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || "", "AppData", "Local");
  const progFiles = process.env.PROGRAMFILES || "C:\\Program Files";
  const progFilesX86 = process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)";

  const candidates = [
    path.join(progFiles, "Google", "Chrome", "Application"),
    path.join(progFilesX86, "Google", "Chrome", "Application"),
    path.join(localAppData, "Google", "Chrome", "Application"),
  ];

  const pwaDir = path.join(
    localAppData,
    "Google",
    "Chrome",
    "User Data",
    "Default",
    "Web Applications",
    `_crx_${CHROME_PWA_APP_ID}`,
  );
  const hasInstalledPwa = fs.existsSync(pwaDir);

  for (const dir of candidates) {
    const chromeExe = path.join(dir, "chrome.exe");
    const proxyExe = path.join(dir, "chrome_proxy.exe");
    if (fs.existsSync(chromeExe)) {
      return {
        chromeExe,
        proxyExe: fs.existsSync(proxyExe) ? proxyExe : chromeExe,
        hasInstalledPwa,
      };
    }
  }
  return null;
}

function openChromeWindow(port) {
  const url = `http://localhost:${port}/`;
  const chrome = findChromePaths();

  if (chrome) {
    if (chrome.hasInstalledPwa && port === DEFAULT_PORT) {
      // Launch the existing installed Chrome PWA window so icon, titlebar, and profile match 100%
      const child = spawn(
        chrome.proxyExe,
        ["--profile-directory=Default", `--app-id=${CHROME_PWA_APP_ID}`],
        {
          detached: true,
          stdio: "ignore",
          windowsHide: false,
        },
      );
      child.unref();
      return { method: "chrome-pwa", executable: chrome.proxyExe };
    }

    // Launch Chrome in standalone --app mode
    const child = spawn(
      chrome.chromeExe,
      ["--profile-directory=Default", `--app=${url}`],
      {
        detached: true,
        stdio: "ignore",
        windowsHide: false,
      },
    );
    child.unref();
    return { method: "chrome-app", executable: chrome.chromeExe };
  }

  // Fallback to system default browser
  const child = spawn("cmd.exe", ["/c", "start", "", url], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
  return { method: "system-default", executable: "cmd.exe" };
}

/**
 * Background daemon mode: owns the Vite child process and cleanly terminates it
 * once all connected OpenCharts browser windows have closed (after reload grace period).
 */
async function runDaemon(opts) {
  ensureStateDir();
  const viteBin =
    opts.viteBinOverride ||
    path.join(PROJECT_ROOT, "node_modules", "vite", "bin", "vite.js");

  if (!fs.existsSync(viteBin)) {
    fs.writeFileSync(
      SERVER_LOG,
      `[ERROR] No se encontró el binario de Vite en: ${viteBin}\n`,
      "utf8",
    );
    process.exit(1);
  }

  const logFd = fs.openSync(SERVER_LOG, "w");
  const viteProc = spawn(
    process.execPath,
    [viteBin, "--host", opts.host, "--port", String(opts.port), "--strictPort"],
    {
      cwd: PROJECT_ROOT,
      stdio: ["ignore", logFd, logFd],
      windowsHide: true,
    },
  );

  let viteExited = false;
  viteProc.on("exit", (code) => {
    viteExited = true;
    try {
      fs.closeSync(logFd);
    } catch {
      // ignore
    }
    process.exit(code ?? 0);
  });

  const cleanup = () => {
    if (!viteExited && viteProc.pid) {
      killProcessTree(viteProc.pid);
    }
  };
  process.on("SIGINT", () => {
    cleanup();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    cleanup();
    process.exit(0);
  });

  const startedAt = Date.now();
  let clientEverSeen = false;
  let zeroClientsSince = null;

  while (!viteExited) {
    await sleep(1500);
    const { running, health } = await checkOpenChartsHealth(opts.host, opts.port);
    if (!running || !health) continue;

    const activeClients = health.activeClients ?? health.wsClients ?? 0;

    if (health.everConnected || activeClients > 0) {
      clientEverSeen = true;
    }

    if (activeClients > 0) {
      zeroClientsSince = null;
      continue;
    }

    if (clientEverSeen) {
      if (zeroClientsSince === null) {
        zeroClientsSince = Date.now();
      }
      const elapsedZero = Date.now() - zeroClientsSince;
      if (elapsedZero >= opts.shutdownGraceMs && health.idleMs >= opts.shutdownGraceMs) {
        cleanup();
        process.exit(0);
      }
    } else {
      // Still waiting for the initial browser window to connect
      if (Date.now() - startedAt >= opts.startupGraceMs) {
        cleanup();
        process.exit(0);
      }
    }
  }
}

async function acquireLock() {
  ensureStateDir();
  if (fs.existsSync(LOCK_FILE)) {
    try {
      const existing = JSON.parse(fs.readFileSync(LOCK_FILE, "utf8"));
      if (
        existing &&
        typeof existing.pid === "number" &&
        existing.pid !== process.pid &&
        isProcessAlive(existing.pid) &&
        Date.now() - (existing.timestamp || 0) < 30_000
      ) {
        return false;
      }
    } catch {
      // stale lockfile
    }
  }
  fs.writeFileSync(
    LOCK_FILE,
    JSON.stringify({ pid: process.pid, timestamp: Date.now() }),
    "utf8",
  );
  return true;
}

function releaseLock() {
  try {
    if (fs.existsSync(LOCK_FILE)) {
      const data = JSON.parse(fs.readFileSync(LOCK_FILE, "utf8"));
      if (data?.pid === process.pid) {
        fs.unlinkSync(LOCK_FILE);
      }
    }
  } catch {
    // ignore
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.daemon) {
    await runDaemon(opts);
    return;
  }

  if (opts.stopServer) {
    const { running, health } = await checkOpenChartsHealth(opts.host, opts.port);
    if (running && health?.pid) {
      killProcessTree(health.pid);
    }
    return;
  }

  // 1. Single-instance lock so rapid double-clicks on Desktop icon do not race
  const locked = await acquireLock();
  if (!locked) {
    process.exit(0);
  }
  process.on("exit", releaseLock);

  // 2. Check if OpenCharts is already running on the target port
  const initialCheck = await isOpenChartsFullyReady(opts.host, opts.port);
  if (initialCheck.ready) {
    if (!opts.noBrowser) {
      const wsClients = initialCheck.health?.wsClients ?? 0;
      const focused = focusExistingOpenChartsWindow();
      if (!focused && wsClients === 0) {
        openChromeWindow(opts.port);
      }
    }
    releaseLock();
    process.exit(0);
  }

  // 3. Check if the port is occupied by a DIFFERENT application
  const portBusyOn127 = await checkTcpPortInUse(opts.host, opts.port);
  const portBusyOnLocalhost = await checkTcpPortInUse("localhost", opts.port);
  if (portBusyOn127 || portBusyOnLocalhost) {
    // Give it one more brief health check in case OpenCharts just started
    await sleep(400);
    const retryCheck = await isOpenChartsFullyReady(opts.host, opts.port);
    if (retryCheck.ready) {
      if (!opts.noBrowser) {
        if (!focusExistingOpenChartsWindow() && (retryCheck.health?.wsClients ?? 0) === 0) {
          openChromeWindow(opts.port);
        }
      }
      releaseLock();
      process.exit(0);
    }

    showWindowsErrorDialog(
      "OpenCharts — Puerto ocupado",
      `No se pudo iniciar OpenCharts porque el puerto ${opts.port} está ocupado por otra aplicación.\n\nCierra el programa que esté usando el puerto ${opts.port} y vuelve a pulsar el icono de OpenCharts.`,
      opts.silentErrors,
    );
    releaseLock();
    process.exit(1);
  }

  // 4. Verify dependencies exist (install if node_modules is missing)
  const viteBin =
    opts.viteBinOverride ||
    path.join(PROJECT_ROOT, "node_modules", "vite", "bin", "vite.js");
  if (!fs.existsSync(viteBin)) {
    if (!opts.viteBinOverride && fs.existsSync(path.join(PROJECT_ROOT, "package.json"))) {
      try {
        execFileSync("npm.cmd", ["install", "--no-audit", "--no-fund"], {
          cwd: PROJECT_ROOT,
          stdio: "ignore",
          windowsHide: true,
        });
      } catch (err) {
        showWindowsErrorDialog(
          "OpenCharts — Error de dependencias",
          `No se encontraron las dependencias del proyecto (node_modules) y falló su instalación automática:\n${err instanceof Error ? err.message : String(err)}`,
          opts.silentErrors,
        );
        releaseLock();
        process.exit(1);
      }
    }
    if (!fs.existsSync(viteBin)) {
      showWindowsErrorDialog(
        "OpenCharts — Error de inicio",
        `No se encontró el servidor de la aplicación (${viteBin}). Comprueba que las dependencias están instaladas con 'npm install'.`,
        opts.silentErrors,
      );
      releaseLock();
      process.exit(1);
    }
  }

  // 5. Spawn the background supervisor daemon that starts Vite
  const daemonArgs = [
    __filename,
    "--daemon",
    "--port",
    String(opts.port),
    "--startup-grace-ms",
    String(opts.startupGraceMs),
    "--shutdown-grace-ms",
    String(opts.shutdownGraceMs),
  ];
  if (opts.viteBinOverride) {
    daemonArgs.push("--vite-bin", opts.viteBinOverride);
  }

  const daemonChild = spawn(process.execPath, daemonArgs, {
    cwd: PROJECT_ROOT,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  daemonChild.unref();

  // 6. Wait until OpenCharts responds over HTTP before opening Chrome
  const deadline = Date.now() + opts.readyTimeoutMs;
  let serverReady = false;

  while (Date.now() < deadline) {
    if (daemonChild.pid && !isProcessAlive(daemonChild.pid)) {
      break;
    }
    const status = await isOpenChartsFullyReady(opts.host, opts.port);
    if (status.ready) {
      serverReady = true;
      break;
    }
    await sleep(150);
  }

  if (!serverReady) {
    if (daemonChild.pid && isProcessAlive(daemonChild.pid)) {
      killProcessTree(daemonChild.pid);
    }
    let logExcerpt = "";
    try {
      if (fs.existsSync(SERVER_LOG)) {
        logExcerpt = fs.readFileSync(SERVER_LOG, "utf8").trim().slice(-500);
      }
    } catch {
      // ignore
    }
    showWindowsErrorDialog(
      "OpenCharts — Error al iniciar el servidor",
      `El servidor local de OpenCharts no pudo iniciarse en http://${opts.host}:${opts.port}/.\n\n${logExcerpt ? `Detalle:\n${logExcerpt}` : "Revisa trade_screenshots/server.log para más información."}`,
      opts.silentErrors,
    );
    releaseLock();
    process.exit(1);
  }

  // 7. Server is verified HTTP-ready! Open the Chrome app window
  if (!opts.noBrowser) {
    openChromeWindow(opts.port);
  }

  releaseLock();
  process.exit(0);
}

main().catch((err) => {
  releaseLock();
  console.error("Fatal launcher error:", err);
  process.exit(1);
});
