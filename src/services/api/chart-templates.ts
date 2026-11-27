// Chart templates persist to localStorage in demo mode (no backend).
import type { IndicatorSettings } from "../../hooks/useIndicatorSettings.ts";

export interface ChartTemplatePaneSnapshot {
  timeframe: string;
  indicators: string[];
  showVolume?: boolean | null;
}

export interface ChartTemplateContent {
  version: 1;
  /** Snapshot of the TEMPLATE_PREF_KEYS subset of ChartPreferences. */
  prefs: Record<string, string | boolean>;
  indicators: string[];
  plugins: string[];
  chartLayout?: "1" | "2x1" | "2x2";
  mainTimeframe?: string;
  syncPrice2x1?: boolean;
  panes?: Record<string, ChartTemplatePaneSnapshot>;
  indicatorSettings?: IndicatorSettings;
}

export interface ChartTemplate {
  id: string;
  name: string;
  layoutType: string;
  isDefault: boolean;
  panels: ChartTemplateContent[];
  updatedAt: string;
}

const KEY = "oc_chart_templates";

function readAll(): ChartTemplate[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "[]");
  } catch {
    return [];
  }
}
function writeAll(list: ChartTemplate[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    // ignore storage quota errors
  }
}

function uid(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export const chartTemplatesApi = {
  list: () => Promise.resolve(readAll()),

  /** Upserts by name (unique per user). */
  save: (name: string, content: ChartTemplateContent, isDefault = false) => {
    const list = readAll()
      .filter((t) => t.name !== name)
      .map((t) => (isDefault && t.isDefault ? { ...t, isDefault: false } : t));
    const template: ChartTemplate = {
      id: uid(),
      name,
      layoutType:
        content.chartLayout === "2x1"
          ? "2X1"
          : content.chartLayout === "2x2"
            ? "2X2"
            : "SINGLE",
      isDefault,
      panels: [content],
      updatedAt: new Date().toISOString(),
    };
    list.push(template);
    writeAll(list);
    return Promise.resolve(template);
  },

  remove: (id: string) => {
    writeAll(readAll().filter((t) => t.id !== id));
    return Promise.resolve({ deleted: true });
  },
};
