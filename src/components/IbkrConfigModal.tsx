import { useEffect, useState } from "react";
import { X, Radio, CheckCircle2, AlertTriangle, Trash2, Loader2 } from "lucide-react";
import {
  deleteIbkrConfig,
  getIbkrConfigStatus,
  saveIbkrConfig,
  type IbkrConfigStatus,
  type IbkrMarketDataType,
} from "../services/ibkrConfig.ts";

interface IbkrConfigModalProps {
  open: boolean;
  onClose: () => void;
  onUpdated?: (status: IbkrConfigStatus) => void;
}

const PORT_PRESETS = [
  { port: 7497, label: "TWS Paper (7497)" },
  { port: 7496, label: "TWS Live (7496)" },
  { port: 4002, label: "IB Gateway Paper (4002)" },
  { port: 4001, label: "IB Gateway Live (4001)" },
] as const;

export function IbkrConfigModal({ open, onClose, onUpdated }: IbkrConfigModalProps) {
  const [host, setHost] = useState("127.0.0.1");
  const [port, setPort] = useState<string>("7497");
  const [clientId, setClientId] = useState<string>("101");
  const [marketDataType, setMarketDataType] = useState<IbkrMarketDataType>(1);
  const [status, setStatus] = useState<IbkrConfigStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let active = true;
    setLoading(true);
    setError(null);
    setNotice(null);
    getIbkrConfigStatus(true)
      .then((next) => {
        if (!active) return;
        setStatus(next);
        setHost(next.host || "127.0.0.1");
        setPort(String(next.port || 7497));
        setClientId(String(next.clientId || 101));
        setMarketDataType(next.marketDataType === 4 ? 4 : 1);
      })
      .catch((err) => {
        if (!active) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [open]);

  if (!open) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    setNotice(null);
    const parsedPort = Number(port);
    const parsedClientId = Number(clientId);
    if (!host.trim()) {
      setError("El Host es obligatorio (ej. 127.0.0.1).");
      setSaving(false);
      return;
    }
    if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
      setError("El puerto debe ser un entero entre 1 y 65535.");
      setSaving(false);
      return;
    }
    if (!Number.isInteger(parsedClientId) || parsedClientId < 0) {
      setError("El Client ID debe ser un entero positivo o cero.");
      setSaving(false);
      return;
    }
    try {
      const next = await saveIbkrConfig({
        host: host.trim(),
        port: parsedPort,
        clientId: parsedClientId,
        marketDataType,
      });
      setStatus(next);
      setNotice("Conexión IBKR actualizada y reconectando...");
      onUpdated?.(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const handleReset = async () => {
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const next = await deleteIbkrConfig();
      setStatus(next);
      setHost(next.host || "127.0.0.1");
      setPort(String(next.port || 7497));
      setClientId(String(next.clientId || 101));
      setMarketDataType(next.marketDataType === 4 ? 4 : 1);
      setNotice("Configuración restablecida a valores por defecto.");
      onUpdated?.(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const connected = status?.connectionState === "connected";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-xl border border-border bg-card shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-muted/20">
          <div className="flex items-center gap-2">
            <Radio className="w-4 h-4 text-primary" />
            <h2 className="text-sm font-semibold">Interactive Brokers (TWS / IB Gateway)</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
            title="Cerrar"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-4 space-y-4">
          <div className="rounded-lg border border-border/70 bg-background/60 p-3 text-xs space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground font-medium">Estado del socket IBKR:</span>
              {loading ? (
                <span className="inline-flex items-center gap-1 text-muted-foreground">
                  <Loader2 className="w-3.5 h-3.5 animate-spin" /> Consultando...
                </span>
              ) : connected ? (
                <span className="inline-flex items-center gap-1 text-emerald-400 font-semibold">
                  <CheckCircle2 className="w-3.5 h-3.5" /> Conectado ({status?.host}:{status?.port})
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 text-amber-400 font-semibold">
                  <AlertTriangle className="w-3.5 h-3.5" /> {status?.connectionState ?? "desconectado"}
                </span>
              )}
            </div>
            <p className="text-[11px] text-muted-foreground leading-relaxed">
              Fuente consolidada EE. UU. (<strong>NYSE · NASDAQ · AMEX</strong>) con flujo base de 1 segundo,
              horario extendido / pre-market y VWAP/EMAs en tiempo real.
            </p>
            {status?.lastError && (
              <p className="text-[11px] text-amber-400/90 font-mono break-all">
                Último aviso IBKR: {status.lastError}
              </p>
            )}
          </div>

          <div>
            <label className="block text-[11px] font-medium text-muted-foreground mb-1">
              Presets de Puerto TWS / Gateway
            </label>
            <div className="grid grid-cols-2 gap-1.5">
              {PORT_PRESETS.map((preset) => (
                <button
                  key={preset.port}
                  type="button"
                  onClick={() => setPort(String(preset.port))}
                  className={`px-2.5 py-1.5 rounded border text-[11px] font-medium text-left transition-colors ${
                    Number(port) === preset.port
                      ? "border-primary bg-primary/15 text-primary"
                      : "border-border bg-background hover:bg-muted/50 text-foreground"
                  }`}
                >
                  {preset.label}
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-3 gap-2.5">
            <div className="col-span-1">
              <label className="block text-[11px] font-medium text-muted-foreground mb-1">
                Host
              </label>
              <input
                type="text"
                value={host}
                onChange={(e) => setHost(e.target.value)}
                placeholder="127.0.0.1"
                className="w-full h-8 px-2.5 rounded border border-border bg-background text-xs font-mono focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>
            <div>
              <label className="block text-[11px] font-medium text-muted-foreground mb-1">
                Puerto
              </label>
              <input
                type="number"
                value={port}
                onChange={(e) => setPort(e.target.value)}
                placeholder="7497"
                className="w-full h-8 px-2.5 rounded border border-border bg-background text-xs font-mono focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>
            <div>
              <label className="block text-[11px] font-medium text-muted-foreground mb-1">
                Client ID
              </label>
              <input
                type="number"
                value={clientId}
                onChange={(e) => setClientId(e.target.value)}
                placeholder="101"
                className="w-full h-8 px-2.5 rounded border border-border bg-background text-xs font-mono focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>
          </div>

          <div>
            <label className="block text-[11px] font-medium text-muted-foreground mb-1">
              Tipo de Datos de Mercado
            </label>
            <select
              value={marketDataType}
              onChange={(e) => setMarketDataType(Number(e.target.value) as IbkrMarketDataType)}
              className="w-full min-h-9 h-auto py-2 px-3 rounded border border-border bg-background text-xs leading-5 text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
            >
              <option value={1}>1 — Real-Time Consolidado (US Value Bundle)</option>
              <option value={4}>4 — Delayed Frozen (diferido 15 min · sesión y fuera de sesión)</option>
            </select>
          </div>

          {error && (
            <div className="rounded border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {error}
            </div>
          )}
          {notice && (
            <div className="rounded border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-400">
              {notice}
            </div>
          )}

          <div className="flex items-center justify-between gap-2 pt-1">
            <button
              type="button"
              onClick={handleReset}
              disabled={saving}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded border border-border text-xs text-muted-foreground hover:text-foreground hover:bg-muted/50 disabled:opacity-50"
            >
              <Trash2 className="w-3.5 h-3.5" />
              Restablecer
            </button>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onClose}
                className="px-3 py-1.5 rounded border border-border text-xs hover:bg-muted/50"
              >
                Cerrar
              </button>
              <button
                type="submit"
                disabled={saving}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded bg-primary text-primary-foreground text-xs font-semibold hover:bg-primary/90 disabled:opacity-50"
              >
                {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                Guardar y Conectar
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
