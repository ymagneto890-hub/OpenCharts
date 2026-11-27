import { useMemo } from "react";
import { useTradingStore } from "@/services/store";

export type InstrumentType = "FOREX_CFD" | "CRYPTO" | "FUTURES" | "STOCKS";

export interface InstrumentLabels {
  /** Unit name for order sizes: "unidades", "shares", "contracts" */
  sizeUnit: string;
  /** Singular unit name: "unidad", "share", "contract" */
  sizeUnitSingular: string;
  /** Label for order entry form: "Cantidad (Unidades)", etc. */
  sizeLabel: string;
  /** Short column header: "Unidades", "Shares", "Contracts" */
  sizeColumnHeader: string;
  /** Default quantity for new orders */
  defaultQuantity: string;
  /** Step increment for quantity input */
  quantityStep: string;
  /** Min quantity allowed */
  quantityMin: string;
  /** Price movement unit: "ticks", "points", "cents" */
  priceMovementUnit: string;
  /** Commission label: "Comisión", "Per Contract Fee", "Per Share Fee" */
  commissionLabel: string;
  /** Contract size label: "Tamaño por unidad", "Multiplier", "Lot Size" */
  contractSizeLabel: string;
  /** Format a quantity with its unit */
  formatQuantity: (qty: number, symbolName?: string) => string;
  /** Alias for formatQuantity */
  formatQty: (qty: number, symbolName?: string) => string;
  /** Short lowercase unit label */
  unitLabel: string;
  /** Capitalized unit label */
  unitLabelCap: string;
  /** Whether instrument is futures */
  isFutures: boolean;
  /** Raw instrument type */
  instrumentType: InstrumentType;
}

export function extractBaseAsset(symbolName?: string): string {
  if (!symbolName) return "u.";
  const trimmed = symbolName.trim().replace(/\.P$/i, "");
  if (trimmed.includes("/")) {
    return trimmed.split("/")[0] || trimmed;
  }
  const upper = trimmed.toUpperCase();
  for (const quote of ["USDT", "USDC", "USD", "EUR", "GBP", "JPY"]) {
    if (upper.endsWith(quote) && upper.length > quote.length) {
      return trimmed.slice(0, trimmed.length - quote.length);
    }
  }
  return trimmed;
}

export function formatAssetUnits(qty: number, symbolName?: string): string {
  const clean = Number.isFinite(qty) ? Number(qty.toFixed(8)).toString() : "0";
  if (symbolName) {
    const base = extractBaseAsset(symbolName);
    return `${clean} ${base}`;
  }
  return `${clean} u.`;
}

type BaseLabels = Omit<
  InstrumentLabels,
  "instrumentType" | "formatQty" | "unitLabel" | "unitLabelCap" | "isFutures"
>;

const LABELS_MAP: Record<InstrumentType, BaseLabels> = {
  FOREX_CFD: {
    sizeUnit: "unidades",
    sizeUnitSingular: "unidad",
    sizeLabel: "Cantidad (Unidades)",
    sizeColumnHeader: "Unidades",
    defaultQuantity: "0.01",
    quantityStep: "0.001",
    quantityMin: "0.0001",
    priceMovementUnit: "ticks",
    commissionLabel: "Comisión",
    contractSizeLabel: "Valor por unidad",
    formatQuantity: (qty: number, symbolName?: string) => formatAssetUnits(qty, symbolName),
  },
  CRYPTO: {
    sizeUnit: "unidades",
    sizeUnitSingular: "unidad",
    sizeLabel: "Cantidad (Unidades)",
    sizeColumnHeader: "Unidades",
    defaultQuantity: "0.005",
    quantityStep: "0.001",
    quantityMin: "0.0001",
    priceMovementUnit: "ticks",
    commissionLabel: "Comisión",
    contractSizeLabel: "Valor por unidad",
    formatQuantity: (qty: number, symbolName?: string) => formatAssetUnits(qty, symbolName),
  },
  FUTURES: {
    sizeUnit: "contracts",
    sizeUnitSingular: "contract",
    sizeLabel: "Contracts",
    sizeColumnHeader: "Contracts",
    defaultQuantity: "1",
    quantityStep: "1",
    quantityMin: "1",
    priceMovementUnit: "ticks",
    commissionLabel: "Per Contract Fee",
    contractSizeLabel: "Point Value",
    formatQuantity: (qty: number) => `${Math.round(qty)} ${qty === 1 ? "contract" : "contracts"}`,
  },
  STOCKS: {
    sizeUnit: "shares",
    sizeUnitSingular: "share",
    sizeLabel: "Shares",
    sizeColumnHeader: "Shares",
    defaultQuantity: "10",
    quantityStep: "1",
    quantityMin: "1",
    priceMovementUnit: "cents",
    commissionLabel: "Per Share Fee",
    contractSizeLabel: "Lot Size",
    formatQuantity: (qty: number) => `${Math.round(qty)} ${qty === 1 ? "share" : "shares"}`,
  },
};

export function useInstrumentLabels(overrideType?: string): InstrumentLabels {
  const activeAccount = useTradingStore((s) => s.accounts.find((a) => a.id === s.activeAccountId));
  const rawType = (overrideType ||
    activeAccount?.template?.instrumentType ||
    "CRYPTO") as InstrumentType;
  const validType: InstrumentType = rawType in LABELS_MAP ? rawType : "CRYPTO";

  return useMemo(() => {
    const base = LABELS_MAP[validType];
    return {
      ...base,
      formatQty: base.formatQuantity,
      unitLabel: base.sizeUnit,
      unitLabelCap: base.sizeColumnHeader,
      isFutures: validType === "FUTURES",
      instrumentType: validType,
    };
  }, [validType]);
}
