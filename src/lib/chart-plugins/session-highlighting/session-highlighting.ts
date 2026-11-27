import { CanvasRenderingTarget2D } from "fancy-canvas";
import {
  Coordinate,
  DataChangedScope,
  ISeriesPrimitive,
  ISeriesPrimitivePaneRenderer,
  ISeriesPrimitivePaneView,
  SeriesAttachedParameter,
  SeriesDataItemTypeMap,
  SeriesPrimitivePaneViewZOrder,
  SeriesType,
  Time,
} from "lightweight-charts";
import { PluginBase } from "../plugin-base";

interface SessionHighlightingRendererData {
  x: Coordinate | number;
  color: string;
}

class SessionHighlightingPaneRenderer implements ISeriesPrimitivePaneRenderer {
  _viewData: SessionHighlightingViewData;
  constructor(data: SessionHighlightingViewData) {
    this._viewData = data;
  }
  draw(target: CanvasRenderingTarget2D) {
    const points: SessionHighlightingRendererData[] = this._viewData.data;
    target.useBitmapCoordinateSpace((scope) => {
      const ctx = scope.context;
      const yTop = 0;
      const height = scope.bitmapSize.height;
      const halfWidth = (scope.horizontalPixelRatio * this._viewData.barWidth) / 2;
      const cutOff = -1 * (halfWidth + 1);
      const maxX = scope.bitmapSize.width;
      points.forEach((point) => {
        const xScaled = point.x * scope.horizontalPixelRatio;
        if (xScaled < cutOff) return;
        ctx.fillStyle = point.color || "rgba(0, 0, 0, 0)";
        const x1 = Math.max(0, Math.round(xScaled - halfWidth));
        const x2 = Math.min(maxX, Math.round(xScaled + halfWidth));
        ctx.fillRect(x1, yTop, x2 - x1, height);
      });
    });
  }
}

interface SessionHighlightingViewData {
  data: SessionHighlightingRendererData[];
  options: Required<SessionHighlightingOptions>;
  barWidth: number;
}

class SessionHighlightingPaneView implements ISeriesPrimitivePaneView {
  _source: SessionHighlighting;
  _data: SessionHighlightingViewData;

  constructor(source: SessionHighlighting) {
    this._source = source;
    this._data = {
      data: [],
      barWidth: 6,
      options: this._source._options,
    };
  }

  update() {
    const timeScale = this._source.chart.timeScale();
    const coords = this._source._backgroundColors.map((d) => ({
      coord: timeScale.timeToCoordinate(d.time),
      color: d.color,
    }));
    this._data.data = coords.map((c) => ({
      x: c.coord ?? -100,
      color: c.color,
    }));
    let computedBarWidth = 0;
    for (let i = 1; i < coords.length; i++) {
      const prev = coords[i - 1]!.coord;
      const curr = coords[i]!.coord;
      if (prev !== null && curr !== null && curr > prev) {
        computedBarWidth = curr - prev;
        break;
      }
    }
    if (!(computedBarWidth > 0)) {
      computedBarWidth = timeScale.options().barSpacing || 6;
    }
    this._data.barWidth = computedBarWidth;
  }

  renderer() {
    return new SessionHighlightingPaneRenderer(this._data);
  }

  zOrder(): SeriesPrimitivePaneViewZOrder {
    return "bottom";
  }
}

export interface SessionHighlightingOptions {}

const defaults: Required<SessionHighlightingOptions> = {};

interface BackgroundData {
  time: Time;
  color: string;
}

export type SessionHighlighter = (date: Time) => string;

export class SessionHighlighting extends PluginBase implements ISeriesPrimitive<Time> {
  _paneViews: SessionHighlightingPaneView[];
  _seriesData: SeriesDataItemTypeMap[SeriesType][] = [];
  _backgroundColors: BackgroundData[] = [];
  _options: Required<SessionHighlightingOptions>;
  _highlighter: SessionHighlighter;

  constructor(highlighter: SessionHighlighter, options: SessionHighlightingOptions = {}) {
    super();
    this._highlighter = highlighter;
    this._options = { ...defaults, ...options };
    this._paneViews = [new SessionHighlightingPaneView(this)];
  }

  updateAllViews() {
    this._paneViews.forEach((pw) => pw.update());
  }

  paneViews() {
    return this._paneViews;
  }

  attached(p: SeriesAttachedParameter<Time>): void {
    super.attached(p);
    this.dataUpdated("full");
  }

  dataUpdated(_scope: DataChangedScope) {
    // plugin base has fired a data changed event
    // TODO: only update the last value if the scope is 'update'
    this._backgroundColors = this.series.data().map((dataPoint) => {
      return {
        time: dataPoint.time,
        color: this._highlighter(dataPoint.time),
      };
    });
    this.requestUpdate();
  }
}
