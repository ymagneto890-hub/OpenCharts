import {
  Equal,
  EyeOff,
  GripVertical,
  Layers,
  Minus,
  MousePointer2,
  MoveVertical,
  PenTool,
  Ruler,
  Square,
  TrendingDown,
  TrendingUp,
  Type,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { type ComponentType, useEffect, useRef, useState } from "react";
import { useDragOffset } from "../../hooks/useDragOffset.ts";
import { cn } from "../../lib/utils.ts";
import type { DrawingTool } from "./constants.ts";

type RailIcon = ComponentType<{ className?: string }>;

function TrendLineIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <circle cx="5" cy="19" r="2" />
      <circle cx="19" cy="5" r="2" />
      <line x1="6.4" y1="17.6" x2="17.6" y2="6.4" />
    </svg>
  );
}

interface ToolMeta {
  tool: DrawingTool;
  icon: RailIcon;
  label: string;
}

interface ToolGroup {
  id: string;
  icon: RailIcon;
  label: string;
  tools: ToolMeta[];
}

// Clean left rail: only essential tools requested by trader
const LINES_GROUP: ToolGroup = {
  id: "lines",
  icon: Minus,
  label: "Lines",
  tools: [
    { tool: "horizontal", icon: Minus, label: "Horizontal Line" },
    { tool: "vertical", icon: MoveVertical, label: "Vertical Line" },
    { tool: "channel", icon: Equal, label: "Parallel Channel" },
  ],
};

function RailButton({
  icon: Icon,
  title,
  active,
  onClick,
  testId,
  activeClassName,
  iconClassName,
}: {
  icon: RailIcon;
  title: string;
  active?: boolean;
  onClick: () => void;
  testId?: string;
  activeClassName?: string;
  iconClassName?: string;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      title={title}
      onClick={onClick}
      className={cn(
        "p-1.5 rounded hover:bg-secondary",
        active ? (activeClassName ?? "bg-primary/20 text-primary") : "text-muted-foreground",
      )}
    >
      <Icon className={cn("h-4 w-4", iconClassName)} />
    </button>
  );
}

function RailGroup({
  group,
  activeTool,
  open,
  onToggle,
  onSelect,
}: {
  group: ToolGroup;
  activeTool: DrawingTool;
  open: boolean;
  onToggle: () => void;
  onSelect: (t: DrawingTool) => void;
}) {
  const activeMeta = group.tools.find((t) => t.tool === activeTool);
  const Icon = activeMeta?.icon ?? group.icon;


  return (
    <div className="relative">
      <RailButton icon={Icon} title={group.label} active={Boolean(activeMeta)} onClick={onToggle} />
      {open && (
        <div className="absolute left-full top-0 ml-1 z-30 min-w-[180px] rounded-md bg-card border border-border shadow-xl py-1">
          {group.tools.map((t) => (
            <button
              key={t.tool}
              type="button"
              onClick={() => onSelect(t.tool)}
              className={cn(
                "w-full flex items-center gap-2.5 px-3 py-1.5 text-sm hover:bg-secondary text-left",
                activeTool === t.tool && "bg-secondary text-primary",
              )}
            >
              <t.icon className="h-3.5 w-3.5 shrink-0" />
              {t.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function DrawingToolRail({
  drawingTool,
  onDrawingTool,
  onZoomIn,
  onZoomOut,
}: {
  drawingTool: DrawingTool;
  onDrawingTool: (t: DrawingTool) => void;
  onZoomIn?: () => void;
  onZoomOut?: () => void;
}) {
  const [openGroup, setOpenGroup] = useState<string | null>(null);
  const [hidden, setHidden] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const drag = useDragOffset();

  useEffect(() => {
    if (!openGroup) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpenGroup(null);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [openGroup]);

  const select = (t: DrawingTool) => {
    onDrawingTool(drawingTool === t ? "none" : t);
    setOpenGroup(null);
  };

  const hide = () => {
    setOpenGroup(null);
    setHidden(true);
  };

  // Collapsed: a small restorable button where the rail was last positioned.
  if (hidden) {
    return (
      <button
        type="button"
        title="Show drawing tools"
        onClick={() => setHidden(false)}
        style={drag.style}
        className="absolute left-1.5 top-12 z-20 rounded-md border border-border bg-card/90 p-1.5 text-muted-foreground backdrop-blur-sm hover:text-primary shadow-md"
      >
        <PenTool className="h-4 w-4" />
      </button>
    );
  }

  return (
    <div
      ref={ref}
      style={drag.style}
      className="absolute left-1.5 top-12 z-20 flex flex-col items-center gap-0.5 rounded-md bg-card/90 border border-border p-0.5 backdrop-blur-sm shadow-md"
    >
      <div
        onPointerDown={drag.onPointerDown}
        title="Drag to move"
        className="flex w-full cursor-move justify-center py-0.5 text-muted-foreground/50 hover:text-muted-foreground"
      >
        <GripVertical className="h-3.5 w-3.5" />
      </div>
      {/* 1. Cursor */}
      <RailButton
        icon={MousePointer2}
        title="Cursor"
        active={drawingTool === "none"}
        onClick={() => {
          onDrawingTool("none");
          setOpenGroup(null);
        }}
      />

      {/* 2. Líneas (Horizontal, Vertical, Canal) */}
      <RailGroup
        group={LINES_GROUP}
        activeTool={drawingTool}
        open={openGroup === "lines"}
        onToggle={() => setOpenGroup((o) => (o === "lines" ? null : "lines"))}
        onSelect={select}
      />

      {/* 3. Trend Line (1 clic directo) */}
      <RailButton
        icon={TrendLineIcon}
        title="Trend Line (Alt+T)"
        active={drawingTool === "trendline"}
        onClick={() => {
          onDrawingTool(drawingTool === "trendline" ? "none" : "trendline");
          setOpenGroup(null);
        }}
      />

      {/* 4. Rectángulo (1 clic directo) */}
      <RailButton
        icon={Square}
        title="Rectángulo (Alt+R)"
        active={drawingTool === "rectangle"}
        onClick={() => {
          onDrawingTool(drawingTool === "rectangle" ? "none" : "rectangle");
          setOpenGroup(null);
        }}
      />

      {/* 4. Regla (Medir porcentaje y precio) - Antes que Fibonacci */}
      <RailButton
        icon={Ruler}
        title="Medir porcentaje y precio rápido (Regla - Alt+M)"
        active={drawingTool === "measure"}
        onClick={() => {
          onDrawingTool(drawingTool === "measure" ? "none" : "measure");
          setOpenGroup(null);
        }}
      />

      {/* 5. Calculadora Risk/Reward desde punto de entrada elegido (Long / Short) */}
      <RailButton
        testId="tool-long-position"
        icon={TrendingUp}
        title="Posición Larga (R:R) — Haz clic en tu punto de entrada y ajusta TP/SL"
        active={drawingTool === "long-position"}
        activeClassName="bg-emerald-500/20 text-emerald-400"
        iconClassName={drawingTool === "long-position" ? "text-emerald-400" : "text-emerald-400/80"}
        onClick={() => {
          onDrawingTool(drawingTool === "long-position" ? "none" : "long-position");
          setOpenGroup(null);
        }}
      />
      <RailButton
        testId="tool-short-position"
        icon={TrendingDown}
        title="Posición Corta (R:R) — Haz clic en tu punto de entrada y ajusta TP/SL"
        active={drawingTool === "short-position"}
        activeClassName="bg-rose-500/20 text-rose-400"
        iconClassName={drawingTool === "short-position" ? "text-rose-400" : "text-rose-400/80"}
        onClick={() => {
          onDrawingTool(drawingTool === "short-position" ? "none" : "short-position");
          setOpenGroup(null);
        }}
      />

      {/* 6. Retroceso de Fibonacci (1 clic directo) */}
      <RailButton
        icon={Layers}
        title="Fibonacci"
        active={drawingTool === "fibonacci"}
        onClick={() => {
          onDrawingTool(drawingTool === "fibonacci" ? "none" : "fibonacci");
          setOpenGroup(null);
        }}
      />

      {/* 6. Texto */}
      <RailButton
        icon={Type}
        title="Texto"
        active={drawingTool === "text"}
        onClick={() => {
          onDrawingTool(drawingTool === "text" ? "none" : "text");
          setOpenGroup(null);
        }}
      />
      <div className="my-0.5 w-full border-t border-border/50" />
      {onZoomIn && (
        <RailButton
          icon={ZoomIn}
          title="Acercar gráfico (Zoom In / +)"
          onClick={onZoomIn}
        />
      )}
      {onZoomOut && (
        <RailButton
          icon={ZoomOut}
          title="Alejar gráfico (Zoom Out / -)"
          onClick={onZoomOut}
        />
      )}
      <div className="my-0.5 w-full border-t border-border/50" />
      <RailButton icon={EyeOff} title="Hide toolbar" onClick={hide} />
    </div>
  );
}
