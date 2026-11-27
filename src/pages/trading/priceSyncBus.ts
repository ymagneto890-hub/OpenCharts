export interface SyncedPriceBounds {
  /** Symbol owning these bounds (prevents stale bounds from another symbol). */
  symbol: string;
  /** Price at y = 0 of the master pane (top edge of plot area). */
  topPrice: number;
  /** Price at y = masterPaneHeight of the master pane (bottom edge of plot area above time axis). */
  botPrice: number;
  /** Viewport clientY of the top edge of the master plot area. */
  masterTop: number;
  /** Plot height in pixels of the master pane (excluding time axis). */
  masterPaneHeight: number;
}

export interface SyncedHoverPrice {
  source: "left" | "right";
  price: number;
  clientY: number;
}

/**
 * Computes the { minValue, maxValue } price range for a slave chart pane so that
 * every screen Y pixel maps to the exact same price as on the master chart pane.
 */
export function computeAlignedLocalPriceRange(
  bounds: SyncedPriceBounds | null,
  localTop: number,
  localPaneHeight: number,
): { minValue: number; maxValue: number } | null {
  if (!bounds) return null;
  if (
    !Number.isFinite(bounds.topPrice) ||
    !Number.isFinite(bounds.botPrice) ||
    !Number.isFinite(bounds.masterTop) ||
    !Number.isFinite(bounds.masterPaneHeight) ||
    !Number.isFinite(localTop) ||
    !Number.isFinite(localPaneHeight)
  ) {
    return null;
  }
  if (bounds.masterPaneHeight <= 0 || localPaneHeight <= 0) return null;
  if (bounds.topPrice <= bounds.botPrice) return null;

  const pricePerPx = (bounds.topPrice - bounds.botPrice) / bounds.masterPaneHeight;
  const yOffset = localTop - bounds.masterTop;
  const maxValue = bounds.topPrice - yOffset * pricePerPx;
  const minValue = bounds.topPrice - (yOffset + localPaneHeight) * pricePerPx;

  if (!Number.isFinite(minValue) || !Number.isFinite(maxValue) || maxValue <= minValue) {
    return null;
  }
  return { minValue, maxValue };
}

function boundsEqual(a: SyncedPriceBounds | null, b: SyncedPriceBounds | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.symbol === b.symbol &&
    Math.abs(a.topPrice - b.topPrice) <= 1e-7 &&
    Math.abs(a.botPrice - b.botPrice) <= 1e-7 &&
    Math.abs(a.masterTop - b.masterTop) <= 0.5 &&
    Math.abs(a.masterPaneHeight - b.masterPaneHeight) <= 0.5
  );
}

/**
 * Lightweight event bus connecting the master price pane (right) and slave pane (left)
 * without triggering React state updates on pointer/scroll events.
 */
export class PriceSyncController {
  private bounds: SyncedPriceBounds | null = null;
  private hover: SyncedHoverPrice | null = null;
  private readonly boundsListeners = new Set<(bounds: SyncedPriceBounds | null) => void>();
  private readonly hoverListeners = new Set<(hover: SyncedHoverPrice | null) => void>();
  private readonly resetListeners = new Set<() => void>();

  getBounds(): SyncedPriceBounds | null {
    return this.bounds;
  }

  publishBounds(bounds: SyncedPriceBounds | null): void {
    if (boundsEqual(this.bounds, bounds)) return;
    this.bounds = bounds;
    for (const fn of this.boundsListeners) {
      fn(bounds);
    }
  }

  subscribeBounds(fn: (bounds: SyncedPriceBounds | null) => void): () => void {
    this.boundsListeners.add(fn);
    if (this.bounds !== null) {
      fn(this.bounds);
    }
    return () => {
      this.boundsListeners.delete(fn);
    };
  }

  publishHover(hover: SyncedHoverPrice | null): void {
    this.hover = hover;
    for (const fn of this.hoverListeners) {
      fn(hover);
    }
  }

  clearHoverFrom(source: "left" | "right"): void {
    if (this.hover && this.hover.source === source) {
      this.hover = null;
      for (const fn of this.hoverListeners) {
        fn(null);
      }
    }
  }

  subscribeHover(fn: (hover: SyncedHoverPrice | null) => void): () => void {
    this.hoverListeners.add(fn);
    return () => {
      this.hoverListeners.delete(fn);
    };
  }

  requestResetAutoScale(): void {
    for (const fn of this.resetListeners) {
      fn();
    }
  }

  subscribeResetAutoScale(fn: () => void): () => void {
    this.resetListeners.add(fn);
    return () => {
      this.resetListeners.delete(fn);
    };
  }
}
