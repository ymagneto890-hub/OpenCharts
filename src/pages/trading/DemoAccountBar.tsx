import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { RotateCcw, Settings2, Wallet, X, AlertTriangle, Check } from "lucide-react";
import {
  getSummary,
  resetAccount,
  setStartingBalance,
  subscribeEngine,
  type DemoSummary,
} from "../../services/demo/engine.ts";
import { useTradingStore } from "../../services/store.tsx";
import { formatCurrency, cn, pnlClass } from "../../lib/utils.ts";
import { Button } from "../../components/ui/button.tsx";
import { toast } from "../../services/toast.ts";
import { isLiveFeedHealthy } from "../../services/demo/feed.ts";

interface DemoAccountBarProps {
  accountId: string | null;
  liveUnrealizedPnl?: number;
}

const CAPITAL_PRESETS = [1_000, 5_000, 10_000, 25_000, 50_000, 100_000] as const;

export function DemoAccountBar({ accountId, liveUnrealizedPnl }: DemoAccountBarProps) {
  const queryClient = useQueryClient();
  const loadAccounts = useTradingStore((s) => s.loadAccounts);
  const [summary, setSummary] = useState<DemoSummary>(() => getSummary());
  const [feedLive, setFeedLive] = useState(() => isLiveFeedHealthy());
  useEffect(() => {
    const id = setInterval(() => setFeedLive(isLiveFeedHealthy()), 2000);
    return () => clearInterval(id);
  }, []);

  // Modals state
  const [showCapitalModal, setShowCapitalModal] = useState(false);
  const [capitalInput, setCapitalInput] = useState("");

  const [showResetModal, setShowResetModal] = useState(false);
  const [resetCapitalInput, setResetCapitalInput] = useState("");
  const [resetFeePctInput, setResetFeePctInput] = useState("");
  const [keepHistory, setKeepHistory] = useState(false);

  useEffect(() => {
    setSummary(getSummary());
    return subscribeEngine(() => {
      setSummary(getSummary());
    });
  }, []);

  const unrealized = liveUnrealizedPnl ?? summary.unrealizedPnl;
  const equity = Number((summary.balance + unrealized).toFixed(2));

  const refreshAllQueries = async () => {
    setSummary(getSummary());
    await loadAccounts();
    queryClient.invalidateQueries({ queryKey: ["positions"] });
    queryClient.invalidateQueries({ queryKey: ["orders"] });
    queryClient.invalidateQueries({ queryKey: ["closedPositions"] });
    queryClient.invalidateQueries({ queryKey: ["fills"] });
    if (accountId) {
      queryClient.invalidateQueries({ queryKey: ["positions", accountId] });
      queryClient.invalidateQueries({ queryKey: ["orders", accountId] });
      queryClient.invalidateQueries({ queryKey: ["closedPositions", accountId] });
      queryClient.invalidateQueries({ queryKey: ["fills", accountId] });
    }
  };

  const handleOpenCapitalModal = () => {
    setCapitalInput(String(summary.startingBalance));
    setShowCapitalModal(true);
  };

  const handleSaveCapital = async () => {
    const val = parseFloat(capitalInput);
    if (!Number.isFinite(val) || val <= 0) {
      toast.warning("Capital inválido", "Introduce un capital inicial mayor a 0");
      return;
    }
    try {
      setStartingBalance(val);
      await refreshAllQueries();
      setShowCapitalModal(false);
      toast.success(
        "Capital Inicial Actualizado",
        `Nuevo capital inicial configurado en ${formatCurrency(val)}`,
      );
    } catch (err: unknown) {
      toast.error(
        "Error",
        err instanceof Error ? err.message : "No se pudo actualizar el capital inicial",
      );
    }
  };

  const handleOpenResetModal = () => {
    setResetCapitalInput(String(summary.startingBalance));
    setResetFeePctInput(String(Number((summary.feeRate * 100).toFixed(4))));
    setKeepHistory(false);
    setShowResetModal(true);
  };

  const handleConfirmReset = async () => {
    const startBal = parseFloat(resetCapitalInput);
    const feePct = parseFloat(resetFeePctInput);
    if (!Number.isFinite(startBal) || startBal <= 0) {
      toast.warning("Capital inválido", "Introduce un capital inicial mayor a 0");
      return;
    }
    const feeRate = Number.isFinite(feePct) && feePct >= 0 ? feePct / 100 : summary.feeRate;

    try {
      resetAccount({
        startingBalance: startBal,
        feeRate,
        keepHistory,
      });
      await refreshAllQueries();
      setShowResetModal(false);
      toast.success(
        "Cuenta Demo Reiniciada",
        `Saldo restablecido a ${formatCurrency(startBal)}${
          keepHistory ? " (historial conservado)" : " (historial borrado)"
        }`,
      );
    } catch (err: unknown) {
      toast.error(
        "No se pudo reiniciar",
        err instanceof Error ? err.message : "Error al reiniciar la cuenta",
      );
    }
  };

  return (
    <>
      <div className="flex items-center justify-between gap-2 px-3 py-1.5 border-b border-border bg-secondary/50 text-[11px] shrink-0 overflow-x-auto no-scrollbar">
        {/* Left: Account badge + Metrics */}
        <div className="flex items-center gap-3 md:gap-4 shrink-0">
          <div className="flex items-center gap-1.5 font-semibold text-foreground">
            <Wallet className="h-3.5 w-3.5 text-primary" />
            <span>Cuenta Demo</span>
          </div>

          <span
            title={feedLive ? "Precios consolidados de EE. UU. en tiempo real (IBKR)" : "Sin conexión activa con IBKR: los precios mostrados no están actualizados en vivo"}
            className={cn("flex items-center gap-1 font-semibold", feedLive ? "text-green-500" : "text-red-500")}
          >
            <span className="h-1.5 w-1.5 rounded-full bg-current" />
            {feedLive ? "LIVE" : "SIN DATOS REALES"}
          </span>

          <div className="h-3.5 border-l border-border" />

          {/* Initial Capital */}
          <div className="flex items-center gap-1">
            <span className="text-muted-foreground">Cap. Inicial:</span>
            <span className="font-mono font-semibold text-foreground">
              {formatCurrency(summary.startingBalance)}
            </span>
            <button
              type="button"
              onClick={handleOpenCapitalModal}
              title="Configurar capital inicial"
              className="p-0.5 rounded hover:bg-secondary text-muted-foreground hover:text-primary transition-colors"
            >
              <Settings2 className="h-3 w-3" />
            </button>
          </div>

          {/* Balance */}
          <div className="flex items-center gap-1">
            <span className="text-muted-foreground">Saldo:</span>
            <span className="font-mono font-bold text-foreground">
              {formatCurrency(summary.balance)}
            </span>
          </div>

          {/* Equity */}
          <div className="flex items-center gap-1">
            <span className="text-muted-foreground">Equidad:</span>
            <span className="font-mono font-semibold text-foreground">
              {formatCurrency(equity)}
            </span>
          </div>

          {/* Open P&L */}
          <div className="flex items-center gap-1">
            <span className="text-muted-foreground">P&L Abierto:</span>
            <span className={cn("font-mono font-semibold", pnlClass(unrealized))}>
              {unrealized >= 0 ? "+" : ""}
              {formatCurrency(unrealized)}
            </span>
          </div>

          <div className="h-3.5 border-l border-border hidden lg:block" />

          {/* Wins / Profits */}
          <div className="hidden lg:flex items-center gap-1">
            <span className="text-muted-foreground">Ganancias:</span>
            <span className="font-mono font-medium text-buy">
              +{formatCurrency(summary.grossProfit)}
            </span>
          </div>

          {/* Losses */}
          <div className="hidden lg:flex items-center gap-1">
            <span className="text-muted-foreground">Pérdidas:</span>
            <span className="font-mono font-medium text-sell">
              -{formatCurrency(summary.grossLoss)}
            </span>
          </div>

          {/* Commissions */}
          <div className="hidden md:flex items-center gap-1">
            <span className="text-muted-foreground">Comisiones:</span>
            <span className="font-mono text-muted-foreground">
              -{formatCurrency(summary.fees)}
            </span>
          </div>
        </div>

        {/* Right: Actions */}
        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={handleOpenCapitalModal}
            className="flex items-center gap-1.5 px-3 py-1 rounded border border-border bg-card hover:bg-secondary text-foreground text-xs font-semibold transition-colors"
          >
            <Settings2 className="h-3.5 w-3.5 text-primary" />
            <span>Capital Inicial</span>
          </button>
          <button
            type="button"
            onClick={handleOpenResetModal}
            className="flex items-center gap-1.5 px-3 py-1 rounded border border-destructive/30 bg-destructive/10 hover:bg-destructive/20 text-destructive text-xs font-semibold transition-colors"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            <span>Reiniciar Cuenta</span>
          </button>
        </div>
      </div>

      {/* Modal: Configurar Capital Inicial */}
      {showCapitalModal && (
        <>
          <div
            className="fixed inset-0 z-[80] bg-black/50 backdrop-blur-sm"
            onClick={() => setShowCapitalModal(false)}
          />
          <div className="fixed inset-0 z-[80] flex items-center justify-center p-4">
            <div className="w-full max-w-sm bg-card border border-border rounded-xl shadow-2xl overflow-hidden">
              <div className="px-5 py-3 border-b border-border flex items-center justify-between bg-secondary/40">
                <h3 className="text-sm font-semibold flex items-center gap-2">
                  <Wallet className="h-4 w-4 text-primary" />
                  Configurar Capital Inicial
                </h3>
                <button
                  onClick={() => setShowCapitalModal(false)}
                  className="text-muted-foreground hover:text-foreground"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>

              <div className="px-5 py-4 space-y-3">
                <div>
                  <label className="text-[10px] text-muted-foreground uppercase tracking-wider">
                    Capital Inicial (USD)
                  </label>
                  <input
                    type="number"
                    value={capitalInput}
                    onChange={(e) => setCapitalInput(e.target.value)}
                    min="10"
                    step="100"
                    className="w-full mt-1 text-sm font-mono"
                    autoFocus
                  />
                </div>

                <div className="grid grid-cols-3 gap-1.5">
                  {CAPITAL_PRESETS.map((preset) => (
                    <button
                      key={preset}
                      type="button"
                      onClick={() => setCapitalInput(String(preset))}
                      className={cn(
                        "py-1 rounded text-[11px] font-mono border transition-colors",
                        Number(capitalInput) === preset
                          ? "bg-primary/15 border-primary/40 text-primary font-semibold"
                          : "border-border hover:bg-secondary text-muted-foreground",
                      )}
                    >
                      ${preset.toLocaleString()}
                    </button>
                  ))}
                </div>

                <p className="text-[11px] text-muted-foreground leading-relaxed">
                  El saldo actual se ajustará automáticamente respetando las ganancias, pérdidas y
                  comisiones acumuladas en la sesión.
                </p>
              </div>

              <div className="px-5 py-3 border-t border-border/40 flex gap-2">
                <Button
                  variant="outline"
                  className="flex-1"
                  onClick={() => setShowCapitalModal(false)}
                >
                  Cancelar
                </Button>
                <Button className="flex-1" onClick={handleSaveCapital}>
                  Guardar Capital
                </Button>
              </div>
            </div>
          </div>
        </>
      )}

      {/* Modal: Reiniciar Cuenta Demo */}
      {showResetModal && (
        <>
          <div
            className="fixed inset-0 z-[80] bg-black/50 backdrop-blur-sm"
            onClick={() => setShowResetModal(false)}
          />
          <div className="fixed inset-0 z-[80] flex items-center justify-center p-4">
            <div className="w-full max-w-md bg-card border border-border rounded-xl shadow-2xl overflow-hidden">
              <div className="px-5 py-3 border-b border-destructive/20 bg-destructive/10 flex items-center justify-between">
                <h3 className="text-sm font-semibold flex items-center gap-2 text-destructive">
                  <AlertTriangle className="h-4 w-4" />
                  Reiniciar Cuenta Demo
                </h3>
                <button
                  onClick={() => setShowResetModal(false)}
                  className="text-muted-foreground hover:text-foreground"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>

              <div className="px-5 py-4 space-y-3.5">
                <p className="text-xs text-muted-foreground leading-relaxed">
                  Esta acción cerrará todas las posiciones abiertas y órdenes pendientes, y
                  restablecerá el saldo de tu cuenta demo al capital inicial indicado.
                </p>

                <div className="grid grid-cols-2 gap-2.5">
                  <div>
                    <label className="text-[10px] text-muted-foreground uppercase tracking-wider">
                      Nuevo Capital Inicial (USD)
                    </label>
                    <input
                      type="number"
                      value={resetCapitalInput}
                      onChange={(e) => setResetCapitalInput(e.target.value)}
                      min="10"
                      step="100"
                      className="w-full mt-1 text-sm font-mono"
                    />
                  </div>
                  <div>
                    <label className="text-[10px] text-muted-foreground uppercase tracking-wider">
                      Comisión por Operación (%)
                    </label>
                    <input
                      type="number"
                      value={resetFeePctInput}
                      onChange={(e) => setResetFeePctInput(e.target.value)}
                      min="0"
                      max="5"
                      step="0.01"
                      className="w-full mt-1 text-sm font-mono"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-3 gap-1.5">
                  {CAPITAL_PRESETS.map((preset) => (
                    <button
                      key={preset}
                      type="button"
                      onClick={() => setResetCapitalInput(String(preset))}
                      className={cn(
                        "py-1 rounded text-[10px] font-mono border transition-colors",
                        Number(resetCapitalInput) === preset
                          ? "bg-primary/15 border-primary/40 text-primary font-semibold"
                          : "border-border hover:bg-secondary text-muted-foreground",
                      )}
                    >
                      ${preset.toLocaleString()}
                    </button>
                  ))}
                </div>

                {/* History control */}
                <div className="pt-1 space-y-1.5">
                  <label className="text-[10px] text-muted-foreground uppercase tracking-wider block">
                    Control del Historial de Operaciones
                  </label>
                  <div className="grid grid-cols-1 gap-1.5">
                    <button
                      type="button"
                      onClick={() => setKeepHistory(false)}
                      className={cn(
                        "flex items-center justify-between px-3 py-2 rounded-lg border text-xs text-left transition-colors",
                        !keepHistory
                          ? "border-primary bg-primary/10 text-foreground font-medium"
                          : "border-border hover:bg-secondary/50 text-muted-foreground",
                      )}
                    >
                      <div>
                        <div className="font-medium text-foreground">
                          Borrar historial de operaciones
                        </div>
                        <div className="text-[10px] text-muted-foreground">
                          Elimina todas las operaciones cerradas, ganancias, pérdidas y comisiones
                        </div>
                      </div>
                      {!keepHistory && <Check className="h-4 w-4 text-primary shrink-0" />}
                    </button>

                    <button
                      type="button"
                      onClick={() => setKeepHistory(true)}
                      className={cn(
                        "flex items-center justify-between px-3 py-2 rounded-lg border text-xs text-left transition-colors",
                        keepHistory
                          ? "border-primary bg-primary/10 text-foreground font-medium"
                          : "border-border hover:bg-secondary/50 text-muted-foreground",
                      )}
                    >
                      <div>
                        <div className="font-medium text-foreground">
                          Conservar historial de operaciones cerradas
                        </div>
                        <div className="text-[10px] text-muted-foreground">
                          Restablece el saldo pero mantiene el registro histórico de operaciones
                        </div>
                      </div>
                      {keepHistory && <Check className="h-4 w-4 text-primary shrink-0" />}
                    </button>
                  </div>
                </div>
              </div>

              <div className="px-5 py-3 border-t border-border/40 flex gap-2">
                <Button
                  variant="outline"
                  className="flex-1"
                  onClick={() => setShowResetModal(false)}
                >
                  Cancelar
                </Button>
                <Button variant="destructive" className="flex-1" onClick={handleConfirmReset}>
                  Confirmar Reinicio
                </Button>
              </div>
            </div>
          </div>
        </>
      )}
    </>
  );
}
