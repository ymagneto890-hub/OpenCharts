import { create } from "zustand";
import { getChartPreferencesFromStorage } from "../../hooks/useChartPreferences.ts";
import { classifyExtendedSession } from "../../lib/chart-plugins/extended-hours-primitive.ts";
import type { Candle, ClosedPosition } from "../schemas.ts";
import { publish } from "./bus.ts";
import {
  buildPartialCandleOrNullUpTo,
  getReplayHistory,
  getStockSessionMetadata,
  resolvePartialCandleWindow,
  subscribeRealSeriesLoaded,
  TF_SECONDS,
} from "./candles.ts";
import * as engine from "./engine.ts";
import { resyncLiveTick } from "./feed.ts";
import { getDemoSymbol } from "./instruments.ts";

/**
 * Historical replay ("bar replay"). The user picks a past candle; every candle
 * after it is hidden and revealed one at a time. Simulated trades go through the
 * same paper engine (so balance, fees and history are updated), but priced only
 * by the replayed candles — see engine.enterReplay / replayAdvance.
 *
 * No look-ahead by construction: the full series lives in a module-private
 * variable and the store only ever exposes `visible` (candles up to the cursor).
 * Chart, indicators and divergence detection are all derived from that slice.
 */

export type ReplayPhase = "idle" | "picking" | "active";

export const REPLAY_SPEEDS = [1, 2, 5, 10, 30] as const;
const BASE_STEP_MS = 1000;

const REPLAY_LAST_TIME_KEY = (symbol?: string) =>
  symbol ? `oc_last_replay_time_${symbol}` : `oc_last_replay_time`;

export function getLastReplayTimeSec(symbol?: string): number | null {
  try {
    if (typeof localStorage === "undefined") return null;
    if (symbol) {
      const symVal = localStorage.getItem(REPLAY_LAST_TIME_KEY(symbol));
      if (symVal) {
        const num = Number(symVal);
        if (Number.isFinite(num) && num > 0) return num;
      }
    }
    const globVal = localStorage.getItem(REPLAY_LAST_TIME_KEY());
    if (globVal) {
      const num = Number(globVal);
      if (Number.isFinite(num) && num > 0) return num;
    }
  } catch {
    // ignore
  }
  return null;
}

export function saveLastReplayTimeSec(timeSec: number, symbol?: string): void {
  try {
    if (typeof localStorage === "undefined") return;
    if (timeSec > 0) {
      localStorage.setItem(REPLAY_LAST_TIME_KEY(), String(timeSec));
      if (symbol) {
        localStorage.setItem(REPLAY_LAST_TIME_KEY(symbol), String(timeSec));
      }
    }
  } catch {
    // ignore
  }
}

interface ReplayState {
  phase: ReplayPhase;
  symbol: string | null;
  timeframe: string | null;
  /** Candles up to and including the cursor — the only data the UI may draw. */
  visible: Candle[] | null;
  /** Total candles in the series, so the HUD can show progress without exposing them. */
  total: number;
  cursor: number;
  /** Exact simulated point in time (end of the latest revealed bar) preserved across timeframe changes. */
  simTimeSec: number;
  playing: boolean;
  speed: number;
  /** True once the last available candle has been revealed. */
  finished: boolean;
  /** True when launched temporarily from Trade History so it never overwrites the default saved replay date. */
  isTemporary: boolean;
  /** Historical closed trade being inspected when Replay is launched from Trade History. */
  inspectedTrade: ClosedPosition | null;
  /** Explicit warning when historical sub-candles or timeframe data are incomplete or unavailable. */
  dataWarning: string | null;

  beginPick: () => void;
  cancelPick: () => void;
  /** Start replaying `symbol`/`timeframe` from the candle at (or just before) `timeSec`. */
  start: (
    symbol: string,
    timeframe: string,
    timeSec: number,
    opts?: { temporary?: boolean; trade?: ClosedPosition | null },
  ) => { ok: true } | { ok: false; error: string };
  /**
   * Change timeframe during active replay while staying at the exact same historical timestamp.
   * Returns `false` (preserving the current compatible timeframe) when authentic historical data
   * is unavailable for `newTimeframe`.
   */
  changeTimeframe: (newTimeframe: string) => boolean;
  setDataWarning: (warning: string | null) => void;
  play: () => void;
  pause: () => void;
  step: () => void;
  stepBack: () => void;
  setSpeed: (speed: number) => void;
  stop: () => void;
}

let series: Candle[] = [];
let timer: ReturnType<typeof setInterval> | null = null;

function clearTimer(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

function shouldSkipHiddenExtendedBar(symbol: string, timeframe: string): boolean {
  const tfSec = TF_SECONDS[timeframe] ?? 60;
  if (tfSec >= 86_400) return false;
  const demoSym = getDemoSymbol(symbol);
  if ((demoSym?.category ?? "").toUpperCase() !== "STOCKS") return false;
  return !getChartPreferencesFromStorage().showExtendedHours;
}

function isRegularSessionCandle(symbol: string, timeframe: string, timeSec: number): boolean {
  const demoSym = getDemoSymbol(symbol);
  const meta = getStockSessionMetadata(symbol, timeframe);
  return classifyExtendedSession(timeSec, meta, demoSym?.exchange) === "regular";
}

function publishTick(symbol: string, price: number, timeSec?: number): void {
  publish("market-data", {
    eventType: "MarketTick",
    symbol,
    bid: price,
    ask: price,
    occurredAt: typeof timeSec === "number" && timeSec > 0 ? timeSec * 1000 : Date.now(),
  });
}

/** Index of the last candle whose open time is <= timeSec, or -1. */
export function indexAtOrBefore(candles: Pick<Candle, "time">[], timeSec: number): number {
  let lo = 0;
  let hi = candles.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (candles[mid]!.time <= timeSec) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

/** Picks the finest (smallest-duration) timeframe from a non-empty list of chart timeframes. */
export function pickFinestTimeframe(timeframes: readonly string[]): string {
  let best = timeframes[0] ?? "15m";
  let bestSec = TF_SECONDS[best] ?? Number.MAX_SAFE_INTEGER;
  for (const tf of timeframes) {
    const sec = TF_SECONDS[tf];
    if (typeof sec === "number" && sec > 0 && sec < bestSec) {
      best = tf;
      bestSec = sec;
    }
  }
  return best;
}

const replaySliceCache = new Map<string, Candle[]>();

/**
 * Computes the exact zero-look-ahead candle slice for any `(symbol, timeframe)` up to `simTimeSec`
 * (where `simTimeSec` is the exclusive end timestamp of the latest revealed replay bar).
 * Higher timeframes (`5m`, `15m`, `1h`, `4h`, `1d`) automatically build their in-progress bar
 * from revealed finer-grained sub-candles so multi-chart layouts (`2x1`, `2x2`) step in 100% sync.
 */
export function getReplaySliceForTimeframe(
  symbol: string,
  timeframe: string,
  simTimeSec: number,
): Candle[] {
  if (!symbol || !timeframe || !(simTimeSec > 0)) return [];

  const st = useReplayStore.getState();
  if (
    (st.phase === "active" || st.phase === "picking") &&
    st.visible &&
    st.symbol === symbol &&
    st.timeframe === timeframe &&
    st.simTimeSec === simTimeSec
  ) {
    return st.visible;
  }

  const tfSec = TF_SECONDS[timeframe] ?? 60;
  const candles = getReplayHistory(symbol, timeframe, simTimeSec - 1);
  if (candles.length === 0) return [];

  const cacheKey = `${symbol}|${timeframe}|${simTimeSec}|${candles.length}|${candles[candles.length - 1]!.time}`;
  const cached = replaySliceCache.get(cacheKey);
  if (cached) return cached;

  const idx = indexAtOrBefore(candles, simTimeSec - 1);
  if (idx < 0) return [];

  const visibleSlice = candles.slice(0, idx + 1);
  const lastCandle = visibleSlice[visibleSlice.length - 1];
  if (lastCandle && lastCandle.time < simTimeSec && lastCandle.time + tfSec > simTimeSec) {
    const partial = buildPartialCandleOrNullUpTo(symbol, lastCandle, timeframe, simTimeSec);
    if (partial === null) {
      visibleSlice.pop();
    } else {
      visibleSlice[visibleSlice.length - 1] = partial;
    }
  }

  if (replaySliceCache.size >= 24) {
    const oldest = replaySliceCache.keys().next().value;
    if (oldest !== undefined) replaySliceCache.delete(oldest);
  }
  replaySliceCache.set(cacheKey, visibleSlice);
  return visibleSlice;
}

const IDLE: Pick<
  ReplayState,
  | "phase"
  | "symbol"
  | "timeframe"
  | "visible"
  | "total"
  | "cursor"
  | "simTimeSec"
  | "playing"
  | "finished"
  | "isTemporary"
  | "inspectedTrade"
  | "dataWarning"
> = {
  phase: "idle",
  symbol: null,
  timeframe: null,
  visible: null,
  total: 0,
  cursor: 0,
  simTimeSec: 0,
  playing: false,
  finished: false,
  isTemporary: false,
  inspectedTrade: null,
  dataWarning: null,
};

export const useReplayStore = create<ReplayState>((set, get) => {
  const restartTimer = () => {
    clearTimer();
    const { playing, speed } = get();
    if (!playing) return;
    timer = setInterval(() => get().step(), Math.max(30, BASE_STEP_MS / speed));
  };

  return {
    ...IDLE,
    speed: 1,

    beginPick: () => {
      const s = get();
      if (s.phase === "idle" || s.phase === "active") {
        clearTimer();
        set({ phase: "picking", playing: false });
      }
    },
    cancelPick: () => {
      const s = get();
      if (s.phase === "picking") {
        if (s.visible && s.visible.length > 0 && s.symbol) {
          set({ phase: "active" });
        } else {
          set({ phase: "idle" });
        }
      }
    },

    start: (symbol, timeframe, timeSec, opts) => {
      clearTimer();
      const s = get();
      const isTemporary = Boolean(opts?.temporary);
      const wasActiveSameSymbol = (s.phase === "active" || s.phase === "picking") && s.visible != null && s.symbol === symbol;

      // If transitioning from a normal replay into a temporary trade-history replay, preserve the normal replay's position first
      if (isTemporary && !s.isTemporary && (s.phase === "active" || s.phase === "picking") && s.symbol) {
        const prevLastBar = s.visible && s.visible.length > 0 ? s.visible[s.visible.length - 1] : null;
        const prevTimeToSave = prevLastBar ? prevLastBar.time : s.simTimeSec;
        if (prevTimeToSave > 0) {
          saveLastReplayTimeSec(prevTimeToSave, s.symbol);
        }
      }

      const candles = getReplayHistory(symbol, timeframe, timeSec);
      if (candles.length === 0) {
        return {
          ok: false,
          error: `No existen datos históricos reales disponibles para ${symbol} (${timeframe}) en la fecha seleccionada.`,
        };
      }
      const idx = indexAtOrBefore(candles, timeSec);
      if (idx < 0) return { ok: false, error: "No candle at or before the selected time" };
      if (idx >= candles.length - 1) {
        return { ok: false, error: "Pick an earlier candle — there is nothing after the latest one to replay" };
      }
      series = candles;
      replaySliceCache.clear();
      const bar = candles[idx]!;
      const tfSec = TF_SECONDS[timeframe] ?? 60;
      const simTimeSec = bar.time + tfSec;
      if (wasActiveSameSymbol) {
        engine.replayRewind(symbol, {
          open: bar.open,
          high: bar.high,
          low: bar.low,
          close: bar.close,
          timeSec: bar.time,
        });
      } else {
        engine.enterReplay(symbol, {
          open: bar.open,
          high: bar.high,
          low: bar.low,
          close: bar.close,
          timeSec: bar.time,
        });
      }
      if (!isTemporary) {
        saveLastReplayTimeSec(bar.time, symbol);
      }
      publishTick(symbol, bar.close, bar.time);
      set({
        phase: "active",
        symbol,
        timeframe,
        cursor: idx,
        simTimeSec,
        total: candles.length,
        visible: candles.slice(0, idx + 1),
        playing: false,
        finished: false,
        isTemporary,
        inspectedTrade: isTemporary && opts?.trade ? engine.resolveClosedPositionLevels(opts.trade) : null,
        dataWarning: null,
      });
      return { ok: true };
    },

    setDataWarning: (warning) => {
      set({ dataWarning: warning });
    },

    changeTimeframe: (newTimeframe: string) => {
      const s = get();
      if (s.phase !== "active" || !s.symbol) return false;
      if (s.timeframe === newTimeframe) return true;

      const oldTfSec = TF_SECONDS[s.timeframe ?? "15m"] ?? 60;
      const fallbackLastBar = s.visible && s.visible.length > 0 ? s.visible[s.visible.length - 1] : series[s.cursor];
      const simTimeSec = s.simTimeSec > 0 ? s.simTimeSec : fallbackLastBar ? fallbackLastBar.time + oldTfSec : 0;
      if (simTimeSec <= 0) return false;

      const newTfSec = TF_SECONDS[newTimeframe] ?? 60;
      const candles = getReplayHistory(s.symbol, newTimeframe, simTimeSec - 1);
      if (candles.length === 0) {
        set({
          dataWarning: `No existen datos históricos reales para ${newTimeframe} en este instante; se conserva ${s.timeframe}.`,
        });
        return false;
      }

      let idx = indexAtOrBefore(candles, simTimeSec - 1);
      if (idx < 0) {
        set({
          dataWarning: `No existen velas históricas anteriores al instante reproducido para ${newTimeframe}; se conserva ${s.timeframe}.`,
        });
        return false;
      }

      const visibleSlice = candles.slice(0, idx + 1);
      let nextWarning: string | null = null;
      const lastCandle = visibleSlice[visibleSlice.length - 1];
      if (lastCandle && lastCandle.time < simTimeSec && lastCandle.time + newTfSec > simTimeSec) {
        const partialRes = resolvePartialCandleWindow(
          s.symbol,
          lastCandle,
          newTimeframe,
          lastCandle.time,
          simTimeSec,
        );
        if (partialRes.status === "ok") {
          visibleSlice[visibleSlice.length - 1] = partialRes.candle;
        } else if (partialRes.status === "empty-verified") {
          if (visibleSlice.length > 1) {
            visibleSlice.pop();
            idx = visibleSlice.length - 1;
          } else {
            return false;
          }
        } else {
          // Missing finer sub-candles for mid-bar reconstruction: never expose future parent OHLCV
          if (visibleSlice.length > 1) {
            visibleSlice.pop();
            idx = visibleSlice.length - 1;
            nextWarning = `Faltan velas inferiores reales para reconstruir la vela en curso de ${newTimeframe}; se muestran únicamente las velas cerradas previas.`;
          } else {
            set({
              dataWarning: `Información histórica insuficiente para reconstruir la vela parcial de ${newTimeframe}; se conserva ${s.timeframe}.`,
            });
            return false;
          }
        }
      }

      series = candles;
      replaySliceCache.clear();
      const activeBar = visibleSlice[visibleSlice.length - 1];
      if (activeBar) {
        if (!s.isTemporary) {
          saveLastReplayTimeSec(activeBar.time, s.symbol);
        }
        publishTick(s.symbol, activeBar.close, activeBar.time);
      }

      const atEnd =
        idx >= candles.length - 1 &&
        (!activeBar || activeBar.time + newTfSec <= simTimeSec);
      set({
        timeframe: newTimeframe,
        cursor: idx,
        simTimeSec,
        total: candles.length,
        visible: visibleSlice,
        finished: atEnd,
        dataWarning: nextWarning,
      });
      return true;
    },

    play: () => {
      const s = get();
      if (s.phase !== "active" || s.finished) return;
      set({ playing: true });
      restartTimer();
    },

    pause: () => {
      set({ playing: false });
      clearTimer();
    },

    step: () => {
      const s = get();
      if (s.phase !== "active" || !s.symbol) return;
      const tf = s.timeframe ?? "15m";
      const tfSec = TF_SECONDS[tf] ?? 60;

      // Recover or extend series if HMR cleared module state or if nearing end of windowed intraday slice
      let cursor = s.cursor;
      if (series.length === 0 || cursor + 5 >= series.length) {
        const anchorSec =
          s.simTimeSec > 0
            ? s.simTimeSec
            : s.visible && s.visible.length > 0
              ? s.visible[s.visible.length - 1]!.time + tfSec
              : 0;
        if (anchorSec > 0) {
          const refreshed = getReplayHistory(s.symbol, tf, anchorSec);
          if (refreshed.length > 0) {
            let newIdx = indexAtOrBefore(refreshed, anchorSec - 1);
            if (newIdx >= 0) {
              // Preserve popped mid-bar cursor position if `visible` had popped an unverified partial candle
              const lastVis = s.visible && s.visible.length > 0 ? s.visible[s.visible.length - 1] : null;
              if (lastVis && refreshed[newIdx]!.time > lastVis.time) {
                const matchVis = indexAtOrBefore(refreshed, lastVis.time);
                if (matchVis >= 0) newIdx = matchVis;
              }
              series = refreshed;
              cursor = newIdx;
            }
          }
        }
      }

      // If `fullCurrent` is the last bar and is partially revealed (`simTimeSec < bar.time + tfSec`),
      // finish only the remaining `[simTimeSec, bar.time + tfSec)` window cleanly when finer data exists.
      const fullCurrentAtCursor = series[cursor];
      if (
        cursor >= series.length - 1 &&
        fullCurrentAtCursor &&
        s.simTimeSec > 0 &&
        fullCurrentAtCursor.time < s.simTimeSec &&
        fullCurrentAtCursor.time + tfSec > s.simTimeSec
      ) {
        const remEnd = fullCurrentAtCursor.time + tfSec;
        const remRes = resolvePartialCandleWindow(
          s.symbol,
          fullCurrentAtCursor,
          tf,
          s.simTimeSec,
          remEnd,
        );
        if (remRes.status === "missing-data") {
          clearTimer();
          set({
            playing: false,
            dataWarning:
              "Avance detenido: faltan velas inferiores reales para completar el tramo restante de la vela parcial sin sesgo futuro.",
          });
          return;
        }
        if (remRes.status === "ok") {
          engine.replayAdvance(s.symbol, {
            open: remRes.candle.open,
            high: remRes.candle.high,
            low: remRes.candle.low,
            close: remRes.candle.close,
            timeSec: fullCurrentAtCursor.time,
          });
        }
        replaySliceCache.clear();
        clearTimer();
        set({
          simTimeSec: remEnd,
          visible: series.slice(0, cursor + 1),
          finished: true,
          playing: false,
          dataWarning: null,
        });
        return;
      }

      let next = cursor + 1;
      if (shouldSkipHiddenExtendedBar(s.symbol, tf)) {
        let probe = next;
        while (probe < series.length && !isRegularSessionCandle(s.symbol, tf, series[probe]!.time)) {
          probe++;
        }
        next = probe;
      }
      if (next >= series.length) {
        clearTimer();
        set({ playing: false, finished: true });
        return;
      }

      // If the current bar at cursor was only partially revealed (e.g. switched from 4h to 1d mid-day),
      // reconstruct ONLY the unrevealed remainder `[simTimeSec, fullCurrent.time + tfSec)` from real finer bars.
      // Block advancement if finer historical data is missing — NEVER feed `fullCurrent` to the engine.
      const fullCurrent = series[cursor];
      if (
        fullCurrent &&
        s.simTimeSec > 0 &&
        fullCurrent.time < s.simTimeSec &&
        fullCurrent.time + tfSec > s.simTimeSec
      ) {
        const remRes = resolvePartialCandleWindow(
          s.symbol,
          fullCurrent,
          tf,
          s.simTimeSec,
          fullCurrent.time + tfSec,
        );
        if (remRes.status === "missing-data") {
          clearTimer();
          set({
            playing: false,
            dataWarning:
              "Avance detenido: faltan velas inferiores reales para completar el tramo restante de la vela parcial sin sesgo futuro.",
          });
          return;
        }
        if (remRes.status === "ok") {
          engine.replayAdvance(s.symbol, {
            open: remRes.candle.open,
            high: remRes.candle.high,
            low: remRes.candle.low,
            close: remRes.candle.close,
            timeSec: fullCurrent.time,
          });
        }
      }

      const bar = series[next]!;
      const nextSimTimeSec = bar.time + tfSec;
      if (s.simTimeSec > 0 && bar.time < s.simTimeSec && nextSimTimeSec > s.simTimeSec) {
        // `bar` spans across `s.simTimeSec` (e.g. partial bar was popped during mid-bar timeframe switch).
        // Evaluate ONLY `[s.simTimeSec, nextSimTimeSec)` and block if finer historical bars are unavailable.
        const nextRemRes = resolvePartialCandleWindow(
          s.symbol,
          bar,
          tf,
          s.simTimeSec,
          nextSimTimeSec,
        );
        if (nextRemRes.status === "missing-data") {
          clearTimer();
          set({
            playing: false,
            dataWarning:
              "Avance detenido: faltan velas inferiores reales para reconstruir el tramo restante de la vela en curso sin información futura.",
          });
          return;
        }
        if (nextRemRes.status === "ok") {
          engine.replayAdvance(s.symbol, {
            open: nextRemRes.candle.open,
            high: nextRemRes.candle.high,
            low: nextRemRes.candle.low,
            close: nextRemRes.candle.close,
            timeSec: bar.time,
          });
        }
      } else {
        engine.replayAdvance(s.symbol, {
          open: bar.open,
          high: bar.high,
          low: bar.low,
          close: bar.close,
          timeSec: bar.time,
        });
      }
      replaySliceCache.clear();
      if (!s.isTemporary) {
        saveLastReplayTimeSec(bar.time, s.symbol);
      }
      publishTick(s.symbol, bar.close, bar.time);
      const atEnd = next >= series.length - 1;
      if (atEnd) clearTimer();
      set({
        cursor: next,
        simTimeSec: nextSimTimeSec,
        total: series.length,
        visible: series.slice(0, next + 1),
        finished: atEnd,
        playing: atEnd ? false : s.playing,
        dataWarning: null,
      });
    },

    stepBack: () => {
      const s = get();
      if (s.phase !== "active" || !s.symbol) return;
      clearTimer();
      const tf = s.timeframe ?? "15m";
      const tfSec = TF_SECONDS[tf] ?? 60;

      let cursor = s.cursor;
      if (series.length === 0) {
        const anchorSec =
          s.simTimeSec > 0
            ? s.simTimeSec
            : s.visible && s.visible.length > 0
              ? s.visible[s.visible.length - 1]!.time + tfSec
              : 0;
        if (anchorSec > 0) {
          const refreshed = getReplayHistory(s.symbol, tf, anchorSec);
          if (refreshed.length > 0) {
            let newIdx = indexAtOrBefore(refreshed, anchorSec - 1);
            if (newIdx >= 0) {
              const lastVis = s.visible && s.visible.length > 0 ? s.visible[s.visible.length - 1] : null;
              if (lastVis && refreshed[newIdx]!.time > lastVis.time) {
                const matchVis = indexAtOrBefore(refreshed, lastVis.time);
                if (matchVis >= 0) newIdx = matchVis;
              }
              series = refreshed;
              cursor = newIdx;
            }
          }
        }
      }

      if (cursor <= 0) return;

      const currentBar = series[cursor];
      const isMidPartial =
        Boolean(currentBar) &&
        s.simTimeSec > 0 &&
        currentBar!.time < s.simTimeSec &&
        currentBar!.time + tfSec > s.simTimeSec;

      let prev = cursor - 1;
      if (shouldSkipHiddenExtendedBar(s.symbol, tf)) {
        let probe = prev;
        while (probe >= 0 && !isRegularSessionCandle(s.symbol, tf, series[probe]!.time)) {
          probe--;
        }
        if (probe < 0) return;
        prev = probe;
      }
      const bar = series[prev]!;
      const prevSimTimeSec = isMidPartial ? currentBar!.time : bar.time + tfSec;
      const rewoundVisible = series.slice(0, prev + 1);
      engine.replayRewind(s.symbol, {
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
        timeSec: bar.time,
      });
      replaySliceCache.clear();
      if (!s.isTemporary) {
        saveLastReplayTimeSec(bar.time, s.symbol);
      }
      publishTick(s.symbol, bar.close, bar.time);
      set({
        cursor: prev,
        simTimeSec: prevSimTimeSec,
        total: series.length,
        visible: rewoundVisible,
        finished: false,
        playing: false,
        dataWarning: null,
      });
    },

    setSpeed: (speed) => {
      set({ speed });
      restartTimer();
    },

    stop: () => {
      clearTimer();
      const s = get();
      const prevSym = s.symbol;
      const lastBar = s.visible && s.visible.length > 0 ? s.visible[s.visible.length - 1] : null;
      const timeToSave = lastBar ? lastBar.time : s.simTimeSec;
      if (!s.isTemporary && timeToSave > 0 && prevSym) {
        saveLastReplayTimeSec(timeToSave, prevSym);
      }
      if (s.phase === "active" || (s.phase === "picking" && s.visible != null)) {
        engine.exitReplay();
      }
      series = [];
      replaySliceCache.clear();
      set({ ...IDLE });
      if (prevSym) resyncLiveTick(prevSym);
    },
  };
});

// Hot-swap synthetic fallback replay bars to real exchange candles as soon as async history arrives
subscribeRealSeriesLoaded((loadedSymbol) => {
  replaySliceCache.clear();
  const s = useReplayStore.getState();
  if ((s.phase !== "active" && s.phase !== "picking") || !s.symbol || !s.timeframe) return;
  if (s.symbol.trim().toUpperCase() !== loadedSymbol.trim().toUpperCase()) return;
  if (!(s.simTimeSec > 0)) return;

  const tf = s.timeframe;
  const tfSec = TF_SECONDS[tf] ?? 60;
  const candles = getReplayHistory(s.symbol, tf, s.simTimeSec - 1);
  if (candles.length === 0) return;

  let idx = indexAtOrBefore(candles, s.simTimeSec - 1);
  if (idx < 0) return;
  series = candles;
  const visibleSlice = candles.slice(0, idx + 1);
  const lastCandle = visibleSlice[visibleSlice.length - 1];
  if (lastCandle && lastCandle.time < s.simTimeSec && lastCandle.time + tfSec > s.simTimeSec) {
    const partial = buildPartialCandleOrNullUpTo(s.symbol, lastCandle, tf, s.simTimeSec);
    if (partial === null && visibleSlice.length > 1) {
      visibleSlice.pop();
      idx = visibleSlice.length - 1;
    } else if (partial !== null) {
      visibleSlice[visibleSlice.length - 1] = partial;
    }
  }
  const activeBar = visibleSlice[visibleSlice.length - 1];
  if (activeBar) {
    publishTick(s.symbol, activeBar.close, activeBar.time);
  }
  useReplayStore.setState({
    cursor: idx,
    total: candles.length,
    visible: visibleSlice,
    finished: idx >= candles.length - 1,
    dataWarning: null,
  });
});
