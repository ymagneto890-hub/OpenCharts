import { useCallback, useEffect, useRef, useState } from "react";
import type { DrawingLine } from "../pages/trading/constants";
import { api } from "../services/api";

// One reversible mutation for the undo/redo stacks.
type HistoryOp =
  | { kind: "add"; drawing: DrawingLine }
  | { kind: "update"; before: DrawingLine; after: DrawingLine }
  | { kind: "remove"; drawing: DrawingLine }
  | { kind: "clear"; drawings: DrawingLine[] };

const HISTORY_LIMIT = 100;
const DRAWINGS_CHANGED_EVENT = "oc-drawings-changed";

// Render order: lower zIndex first (drawn underneath). Stable for ties, so
// drawings without an explicit zIndex keep creation order.
function sortByZ(list: DrawingLine[]): DrawingLine[] {
  return [...list].sort((a, b) => (a.zIndex ?? 0) - (b.zIndex ?? 0));
}

let nextInstanceId = 0;

/**
 * Scope key isolating drawings per pane slot: slot 0 keeps the bare `symbol`
 * key for backwards compatibility while split panes (`1`, `2`, `3`, …) keep
 * completely separate drawing lists.
 */
export function drawingScopeKey(symbol: string, paneSlot = 0): string {
  return paneSlot === 0 ? symbol : `${symbol}__pane_${paneSlot}`;
}

export function useChartDrawings(symbol: string, timeframe: string, paneSlot = 0) {
  const scopeKey = drawingScopeKey(symbol, paneSlot);
  const [drawings, setDrawings] = useState<DrawingLine[]>([]);
  const scopeKeyRef = useRef(scopeKey);
  const timeframeRef = useRef(timeframe);
  // Each chart pane instance gets a unique id so it can ignore its own change events.
  const instanceIdRef = useRef(`dw-${++nextInstanceId}`);
  // Mirror of `drawings` so mutators can read current state synchronously
  // (needed to capture `before` snapshots for undo without stale closures).
  const drawingsRef = useRef<DrawingLine[]>([]);
  const undoStackRef = useRef<HistoryOp[]>([]);
  const redoStackRef = useRef<HistoryOp[]>([]);

  useEffect(() => {
    scopeKeyRef.current = scopeKey;
    timeframeRef.current = timeframe;
  });

  const notifyChanged = useCallback((key: string, snapshot?: DrawingLine[]) => {
    if (typeof window === "undefined") return;
    window.dispatchEvent(
      new CustomEvent(DRAWINGS_CHANGED_EVENT, {
        detail: {
          symbol: key,
          source: instanceIdRef.current,
          drawings: snapshot ? snapshot.map((d) => ({ ...d })) : undefined,
        },
      }),
    );
  }, []);

  // Drawings load per pane+symbol and stay intact across timeframes on that pane.
  useEffect(() => {
    let cancelled = false;
    setDrawings([]);
    drawingsRef.current = [];
    undoStackRef.current = [];
    redoStackRef.current = [];
    api.chartDrawings
      .list(scopeKey)
      .then((data) => {
        if (cancelled) return;
        const sorted = sortByZ(data ?? []);
        setDrawings(sorted);
        drawingsRef.current = sorted;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [scopeKey]);

  // Reload if another instance sharing the exact same pane scope updates it.
  useEffect(() => {
    if (typeof window === "undefined") return;
    let cancelled = false;
    const onExternalChange = (ev: Event) => {
      const detail = (
        ev as CustomEvent<{ symbol?: string; source?: string; drawings?: DrawingLine[] }>
      ).detail;
      if (!detail || detail.source === instanceIdRef.current || detail.symbol !== scopeKey) return;
      if (Array.isArray(detail.drawings)) {
        const sorted = sortByZ(detail.drawings.map((d) => ({ ...d })));
        drawingsRef.current = sorted;
        setDrawings(sorted);
        return;
      }
      Promise.resolve(api.chartDrawings.list(scopeKey))
        .then((data) => {
          if (cancelled) return;
          const sorted = sortByZ(data ?? []);
          setDrawings(sorted);
          drawingsRef.current = sorted;
        })
        .catch(() => {});
    };
    window.addEventListener(DRAWINGS_CHANGED_EVENT, onExternalChange);
    return () => {
      cancelled = true;
      window.removeEventListener(DRAWINGS_CHANGED_EVENT, onExternalChange);
    };
  }, [scopeKey]);

  // ── Primitive applies (state + ref mirror + server, no history) ──

  const applyAdd = useCallback(
    (d: DrawingLine) => {
      const next = sortByZ([...drawingsRef.current.filter((x) => x.id !== d.id), d]);
      drawingsRef.current = next;
      setDrawings(next);
      const key = scopeKeyRef.current;
      notifyChanged(key, next);
      Promise.resolve(api.chartDrawings.save(key, timeframeRef.current, d)).catch(() => {});
    },
    [notifyChanged],
  );

  // The drawings POST endpoint upserts by drawingId, so edits reuse save().
  const applyUpdate = useCallback(
    (d: DrawingLine) => {
      const next = sortByZ(drawingsRef.current.map((x) => (x.id === d.id ? d : x)));
      drawingsRef.current = next;
      setDrawings(next);
      const key = scopeKeyRef.current;
      notifyChanged(key, next);
      Promise.resolve(api.chartDrawings.save(key, timeframeRef.current, d)).catch(() => {});
    },
    [notifyChanged],
  );

  const applyRemove = useCallback(
    (id: string) => {
      const next = drawingsRef.current.filter((x) => x.id !== id);
      drawingsRef.current = next;
      setDrawings(next);
      const key = scopeKeyRef.current;
      notifyChanged(key, next);
      Promise.resolve(api.chartDrawings.remove(id)).catch(() => {});
    },
    [notifyChanged],
  );

  const pushHistory = useCallback((op: HistoryOp) => {
    undoStackRef.current.push(op);
    if (undoStackRef.current.length > HISTORY_LIMIT) undoStackRef.current.shift();
    redoStackRef.current = [];
  }, []);

  // ── Public mutators (record history) ──

  const addDrawing = useCallback(
    (d: DrawingLine) => {
      pushHistory({ kind: "add", drawing: d });
      applyAdd(d);
    },
    [pushHistory, applyAdd],
  );

  const updateDrawing = useCallback(
    (d: DrawingLine) => {
      const before = drawingsRef.current.find((x) => x.id === d.id);
      if (before) pushHistory({ kind: "update", before, after: d });
      applyUpdate(d);
    },
    [pushHistory, applyUpdate],
  );

  const removeDrawing = useCallback(
    (id: string) => {
      const drawing = drawingsRef.current.find((x) => x.id === id);
      if (drawing) pushHistory({ kind: "remove", drawing });
      applyRemove(id);
    },
    [pushHistory, applyRemove],
  );

  const clearDrawings = useCallback(() => {
    if (drawingsRef.current.length > 0) {
      pushHistory({ kind: "clear", drawings: drawingsRef.current });
    }
    drawingsRef.current = [];
    setDrawings([]);
    const key = scopeKeyRef.current;
    notifyChanged(key, []);
    Promise.resolve(api.chartDrawings.clear(key)).catch(() => {});
  }, [pushHistory, notifyChanged]);

  // ── Undo / redo ──

  const revertOp = useCallback(
    (op: HistoryOp) => {
      if (op.kind === "add") applyRemove(op.drawing.id);
      else if (op.kind === "update") applyUpdate(op.before);
      else if (op.kind === "remove") applyAdd(op.drawing);
      else for (const d of op.drawings) applyAdd(d);
    },
    [applyAdd, applyUpdate, applyRemove],
  );

  const replayOp = useCallback(
    (op: HistoryOp) => {
      if (op.kind === "add") applyAdd(op.drawing);
      else if (op.kind === "update") applyUpdate(op.after);
      else if (op.kind === "remove") applyRemove(op.drawing.id);
      else for (const d of op.drawings) applyRemove(d.id);
    },
    [applyAdd, applyUpdate, applyRemove],
  );

  const undo = useCallback((): boolean => {
    const op = undoStackRef.current.pop();
    if (!op) return false;
    revertOp(op);
    redoStackRef.current.push(op);
    return true;
  }, [revertOp]);

  const redo = useCallback((): boolean => {
    const op = redoStackRef.current.pop();
    if (!op) return false;
    replayOp(op);
    undoStackRef.current.push(op);
    return true;
  }, [replayOp]);

  return { drawings, addDrawing, updateDrawing, removeDrawing, clearDrawings, undo, redo };
}
