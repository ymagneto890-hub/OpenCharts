import { useEffect, useMemo, useState } from "react";
import { api } from "../services/api.ts";
import { useAuthStore } from "../services/store.tsx";

export type TraderPrefs = Record<string, string>;

const LEGACY_TRADER_PREFS_KEY = "trader_prefs";
const CHART_PREFS_UPDATED_EVENT = "chart-preferences-updated";

export function getTraderPrefsStorageKey(userId?: string | null): string {
  return userId ? `${LEGACY_TRADER_PREFS_KEY}:${userId}` : LEGACY_TRADER_PREFS_KEY;
}

function parsePrefs(raw: string | null): TraderPrefs {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as TraderPrefs;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function readTraderPrefs(userId?: string | null): TraderPrefs {
  const scoped = parsePrefs(localStorage.getItem(getTraderPrefsStorageKey(userId)));
  if (Object.keys(scoped).length > 0) return scoped;
  return parsePrefs(localStorage.getItem(LEGACY_TRADER_PREFS_KEY));
}

export function writeTraderPrefs(prefs: TraderPrefs, userId?: string | null): void {
  try {
    localStorage.setItem(getTraderPrefsStorageKey(userId), JSON.stringify(prefs));
  } catch {
    // ignore storage quota errors
  }
}

export function applyAccentColorFromPrefs(prefs: TraderPrefs): void {
  const accent = prefs.accentColor;
  if (!accent) return;
  document.documentElement.style.setProperty("--accent", accent);
}

function dispatchChartPrefsUpdated(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(CHART_PREFS_UPDATED_EVENT));
}

export function useTraderPreferences() {
  const userId = useAuthStore((s) => s.user?.id);
  const [prefs, setPrefs] = useState<TraderPrefs>(() => readTraderPrefs(userId));
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const local = readTraderPrefs(userId);
    setPrefs(local);
    applyAccentColorFromPrefs(local);

    api
      .getPreferences()
      .then((serverPrefs) => {
        if (cancelled) return;
        if (serverPrefs && typeof serverPrefs === "object") {
          const merged = { ...serverPrefs, ...local };
          setPrefs(merged);
          writeTraderPrefs(merged, userId);
          applyAccentColorFromPrefs(merged);
        }
        setLoaded(true);
      })
      .catch(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [userId]);

  const savePreferences = useMemo(
    () => (next: TraderPrefs) => {
      setPrefs(next);
      writeTraderPrefs(next, userId);
      applyAccentColorFromPrefs(next);
      dispatchChartPrefsUpdated();
      api.savePreferences(next).catch(() => {});
    },
    [userId],
  );

  const savePreference = useMemo(
    () => (key: string, value: string) => {
      const next = { ...readTraderPrefs(userId), [key]: value };
      savePreferences(next);
    },
    [userId, savePreferences],
  );

  return {
    prefs,
    loaded,
    savePreference,
    savePreferences,
  };
}
