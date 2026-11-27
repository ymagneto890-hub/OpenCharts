// ── IBKR Gateway / TWS Client Configuration Service ──────────────────────────────

export type IbkrConnectionState =
  | "disconnected"
  | "connecting"
  | "connected"
  | "reconnecting";

export type IbkrMarketDataType = 1 | 2 | 4;

export interface IbkrConfigStatus {
  configured: boolean;
  host: string;
  port: number;
  clientId: number;
  marketDataType: IbkrMarketDataType;
  effectiveMarketDataType?: IbkrMarketDataType;
  source: "file" | "env" | "default";
  connectionState: IbkrConnectionState;
  lastError: string | null;
  activeStreams: number;
  activeRequests: number;
}

export interface SaveIbkrConfigInput {
  host: string;
  port: number;
  clientId: number;
  marketDataType: IbkrMarketDataType;
}

const listeners = new Set<(status: IbkrConfigStatus | null) => void>();

let cachedStatus: IbkrConfigStatus | null = null;

/** Subscribes to IBKR config/status changes triggered by modal save/reset. */
export function subscribeIbkrConfigChanged(
  fn: (status: IbkrConfigStatus | null) => void,
): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Notifies listeners that IBKR connection settings were updated. */
export function notifyIbkrConfigChanged(): void {
  for (const fn of listeners) {
    try {
      fn(cachedStatus);
    } catch {
      // ignore subscriber failure
    }
  }
}

/** Returns the last known IBKR configuration status without performing network I/O. */
export function getCachedIbkrConfigStatus(): IbkrConfigStatus | null {
  return cachedStatus;
}

function isTestRuntime(): boolean {
  try {
    const env = (import.meta as unknown as { env?: Record<string, unknown> }).env;
    if (env?.MODE === "test" || env?.VITEST) return true;
  } catch {
    // ignore
  }
  return (
    typeof globalThis !== "undefined" &&
    Boolean((globalThis as { process?: { env?: Record<string, string> } }).process?.env?.VITEST)
  );
}

const DEFAULT_OFFLINE_STATUS: IbkrConfigStatus = {
  configured: true,
  host: "127.0.0.1",
  port: 7497,
  clientId: 101,
  marketDataType: 1,
  source: "default",
  connectionState: "disconnected",
  lastError: null,
  activeStreams: 0,
  activeRequests: 0,
};

/** Fetches the current IBKR Gateway / TWS connection config & state from Vite middleware. */
export async function getIbkrConfigStatus(forceRefresh = false): Promise<IbkrConfigStatus> {
  if (!forceRefresh && cachedStatus) {
    return cachedStatus;
  }
  if (!forceRefresh && isTestRuntime()) {
    return { ...DEFAULT_OFFLINE_STATUS };
  }
  const res = await fetch("/__api/ibkr-config", { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} obteniendo configuración IBKR`);
  }
  const data = (await res.json()) as IbkrConfigStatus;
  cachedStatus = data;
  return data;
}

/** Saves IBKR Gateway / TWS host, port, clientId & market data type and reconnects. */
export async function saveIbkrConfig(
  input: SaveIbkrConfigInput,
): Promise<IbkrConfigStatus> {
  const res = await fetch("/__api/ibkr-config", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const data = (await res.json().catch(() => ({}))) as Partial<IbkrConfigStatus> & {
    error?: string;
  };
  if (!res.ok) {
    throw new Error(data.error || `Error guardando configuración IBKR (HTTP ${res.status})`);
  }
  const status = data as IbkrConfigStatus;
  cachedStatus = status;
  notifyIbkrConfigChanged();
  return status;
}

/** Removes saved file overrides and reverts to env/default IBKR settings. */
export async function deleteIbkrConfig(): Promise<IbkrConfigStatus> {
  const res = await fetch("/__api/ibkr-config", { method: "DELETE" });
  const data = (await res.json().catch(() => ({}))) as Partial<IbkrConfigStatus> & {
    error?: string;
  };
  if (!res.ok) {
    throw new Error(data.error || `Error restableciendo configuración IBKR (HTTP ${res.status})`);
  }
  const status = data as IbkrConfigStatus;
  cachedStatus = status;
  notifyIbkrConfigChanged();
  return status;
}
