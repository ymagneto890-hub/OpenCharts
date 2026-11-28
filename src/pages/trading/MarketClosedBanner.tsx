import { useEffect, useMemo, useState } from "react";
import { Clock } from "lucide-react";
import type { Symbol } from "../../services/schemas";
import { useChartPreferences } from "../../hooks/useChartPreferences.ts";
import { useReplayStore } from "../../services/demo/replay.ts";
import { useTradingStore } from "../../services/store.tsx";

/**
 * How long after the last tick we consider the feed still live.
 * 3 minutes covers the ~5-minute XAUUSD/forex daily rollover gap and brief
 * feed interruptions without masking genuine weekend/holiday closures.
 */
const LIVE_TICK_GRACE_MS = 3 * 60_000;

/**
 * On initial mount the tick store is empty. Wait this long before falling
 * back to schedule-based logic so the first ticks have a chance to arrive.
 */
const STARTUP_HOLDOFF_MS = 10_000;

interface TradingHours {
  dayOfWeek: number;
  openTime: string;
  closeTime: string;
}

const DAY_MAP: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

const zoneFormatterCache = new Map<string, Intl.DateTimeFormat>();
function getZoneFormatter(timezone: string): Intl.DateTimeFormat {
  let fmt = zoneFormatterCache.get(timezone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    zoneFormatterCache.set(timezone, fmt);
  }
  return fmt;
}

function getTimeInZone(date: Date, timezone: string): { day: number; time: string } {
  const parts = getZoneFormatter(timezone).formatToParts(date);
  const day = DAY_MAP[parts.find((p) => p.type === "weekday")?.value ?? ""] ?? date.getUTCDay();
  const h = parts.find((p) => p.type === "hour")?.value?.padStart(2, "0") ?? "00";
  const m = parts.find((p) => p.type === "minute")?.value?.padStart(2, "0") ?? "00";
  return { day, time: `${h}:${m}` };
}

function isInWindow(windows: TradingHours[], tz: string, date: Date): boolean {
  const { day: currentDay, time: currentTime } = getTimeInZone(date, tz);
  for (const w of windows) {
    const crossesMidnight = w.closeTime <= w.openTime;
    if (crossesMidnight) {
      if (w.dayOfWeek === currentDay && currentTime >= w.openTime) return true;
      const prev = (currentDay + 6) % 7;
      if (w.dayOfWeek === prev && currentTime < w.closeTime) return true;
    } else {
      if (
        w.dayOfWeek === currentDay &&
        currentTime >= w.openTime &&
        (w.closeTime === "24:00" || currentTime < w.closeTime)
      )
        return true;
    }
  }
  return false;
}

// Default forex hours (UTC) used when no tradingHours configured.
// Standard FX week: opens Sunday 22:00 UTC (Sydney), closes Friday 22:00 UTC (NY close).
function isForexDefaultOpen(date: Date): boolean {
  const day = date.getUTCDay();
  const hour = date.getUTCHours();
  if (day === 6) return false; // Saturday — always closed
  if (day === 0 && hour < 22) return false; // Sunday before 22:00 UTC
  if (day === 5 && hour >= 22) return false; // Friday from 22:00 UTC
  return true;
}

function isUsStockOpen(date: Date, extended: boolean): boolean {
  const { day, time } = getTimeInZone(date, "America/New_York");
  if (day === 0 || day === 6) return false;
  return extended ? time >= "04:00" && time < "20:00" : time >= "09:30" && time < "16:00";
}

function findNextOpenMs(
  windows: TradingHours[],
  tz: string,
  category: string,
  nowMs: number,
  extendedHours = true,
): number | null {
  const catUpper = category?.toUpperCase();
  if (catUpper === "CRYPTO" || catUpper === "FUTURES") return null;

  // Snap to minute boundary and scan minute-by-minute up to 7 days ahead
  const baseMinMs = Math.floor(nowMs / 60_000) * 60_000;
  for (let m = 1; m <= 10080; m++) {
    const t = baseMinMs + m * 60_000;
    const candidate = new Date(t);
    const open =
      windows.length > 0
        ? isInWindow(windows, tz, candidate)
        : catUpper === "STOCKS"
          ? isUsStockOpen(candidate, extendedHours)
          : isForexDefaultOpen(candidate);
    if (open) return t;
  }
  return null;
}

function formatCountdown(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0 || days > 0) parts.push(`${hours}h`);
  if (days === 0) parts.push(`${minutes}m ${seconds.toString().padStart(2, "0")}s`);
  return parts.join(" ");
}

interface Props {
  symbolInfo: Symbol | undefined;
}

export function MarketClosedBanner({ symbolInfo }: Props) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [mountedAt] = useState(() => Date.now());
  const ticks = useTradingStore((s) => s.ticks);
  const isReplayMode = useReplayStore((s) => s.phase !== "idle");
  const { showExtendedHours } = useChartPreferences();

  const category: string = symbolInfo?.category ?? "";
  const catUpper = category.toUpperCase();
  const is247 = !symbolInfo || isReplayMode || catUpper === "CRYPTO" || catUpper === "FUTURES";

  const symbolTick = symbolInfo ? ticks[symbolInfo.name ?? ""] : undefined;
  const hasRecentTick = Boolean(symbolTick && nowMs - symbolTick.timestamp < LIVE_TICK_GRACE_MS);
  const inStartupHoldoff = !symbolTick && nowMs - mountedAt < STARTUP_HOLDOFF_MS;

  const tradingHours = ((symbolInfo as Record<string, unknown> | undefined)?.tradingHours ??
    []) as TradingHours[];
  const tz: string =
    ((symbolInfo as Record<string, unknown> | undefined)?.sessionTimezone as string | undefined) ??
    "UTC";

  const nowDate = useMemo(() => new Date(nowMs), [nowMs]);
  const isOpen =
    is247 ||
    hasRecentTick ||
    inStartupHoldoff ||
    (tradingHours.length > 0
      ? isInWindow(tradingHours, tz, nowDate)
      : catUpper === "STOCKS"
        ? isUsStockOpen(nowDate, showExtendedHours)
        : isForexDefaultOpen(nowDate));

  // Compute next open timestamp only when closed (recomputes once per minute if not yet reached)
  const closedMinuteBucket = Math.floor(nowMs / 60_000);
  const nextOpenAtMs = useMemo(() => {
    if (isOpen) return null;
    return findNextOpenMs(tradingHours, tz, category, nowMs, showExtendedHours);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, symbolInfo?.name, tz, category, closedMinuteBucket, showExtendedHours]);

  useEffect(() => {
    if (is247) return;
    const id = setInterval(() => setNowMs(Date.now()), isOpen ? 10_000 : 1000);
    return () => clearInterval(id);
  }, [is247, isOpen]);

  if (isOpen) return null;

  const msUntilOpen = nextOpenAtMs != null ? Math.max(0, nextOpenAtMs - nowMs) : null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="flex items-center justify-center gap-2 px-3 py-1.5 bg-amber-500/10 border-b border-amber-500/20 text-amber-600 dark:text-amber-400 text-xs font-medium"
    >
      <Clock className="h-3 w-3 shrink-0" />
      <span>
        Market closed
        {msUntilOpen != null && (
          <>
            {" "}
            · Opens in{" "}
            <span className="font-mono tabular-nums">{formatCountdown(msUntilOpen)}</span>
          </>
        )}
      </span>
    </div>
  );
}
