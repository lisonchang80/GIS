import { useEffect, useRef } from 'react';
import maplibregl, { type Map as MLMap } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import {
  TerraDraw,
  TerraDrawSelectMode,
  TerraDrawPointMode,
  TerraDrawLineStringMode,
  TerraDrawPolygonMode,
  TerraDrawRectangleMode,
  TerraDrawCircleMode,
  TerraDrawFreehandMode,
} from 'terra-draw';
import { TerraDrawMapLibreGLAdapter } from 'terra-draw-maplibre-gl-adapter';
import type { BaseMapOption, ObstacleZone, VectorLayer, WaterLevelArrows, WaterLevelFill, WaterLevelLines } from './types';
import { buildBasemapStyle, basemapTiles } from './basemaps';
import { ensurePointIcon, pointIconId, SHAPE_IMG_SIZE, SHAPE_DRAW_RATIO } from './pointShapes';
import type { PointShape } from './types';

function getActiveStyle(layer: VectorLayer): {
  fill: WaterLevelFill | undefined;
  lines: WaterLevelLines | undefined;
  arrows: WaterLevelArrows | undefined;
} {
  const wl = layer.waterLevel;
  if (!wl) return { fill: undefined, lines: undefined, arrows: undefined };
  const isMultiSub = !!wl.substances && wl.substances.length > 0;
  if (isMultiSub && wl.activeSubstance) {
    const override = wl.substanceStyles?.[wl.activeSubstance];
    return {
      fill: override?.fill ?? wl.fill,
      lines: override?.lines ?? wl.lines,
      arrows: override?.arrows ?? wl.arrows,
    };
  }
  return { fill: wl.fill, lines: wl.lines, arrows: wl.arrows };
}

interface Props {
  basemap: BaseMapOption;
  basemapVersionIndex: number;
  basemapOpacity: number;
  layers: VectorLayer[];
  onMapReady?: (map: MLMap) => void;
  onDrawReady?: (draw: TerraDraw) => void;
  pickMode?: boolean;
  onPick?: (lng: number, lat: number) => void;
  onDateLabelMove?: (id: string, lng: number, lat: number) => void;
  obstacles?: ObstacleZone[];
}

// 障礙物 overlay：半透明灰填色 + 虛線框，讓使用者在地圖看到/對位排除區。
function applyObstacleOverlay(map: MLMap, obstacles: ObstacleZone[]): void {
  const fc = {
    type: 'FeatureCollection' as const,
    features: obstacles.map((o) => ({
      type: 'Feature' as const,
      geometry: o.geometry,
      properties: { enabled: !!o.enabled },
    })),
  };
  const src = map.getSource('obstacle-overlay-src') as maplibregl.GeoJSONSource | undefined;
  if (src) {
    src.setData(fc);
    return;
  }
  map.addSource('obstacle-overlay-src', { type: 'geojson', data: fc });
  map.addLayer({
    id: 'obstacle-overlay-fill',
    type: 'fill',
    source: 'obstacle-overlay-src',
    paint: { 'fill-color': '#9ca3af', 'fill-opacity': ['case', ['get', 'enabled'], 0.4, 0.12] },
  });
  map.addLayer({
    id: 'obstacle-overlay-line',
    type: 'line',
    source: 'obstacle-overlay-src',
    paint: { 'line-color': '#4b5563', 'line-width': 1.5, 'line-dasharray': [2, 2] },
  });
}

export function MapView({ basemap, basemapVersionIndex, basemapOpacity, layers, onMapReady, onDrawReady, pickMode, onPick, onDateLabelMove, obstacles }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MLMap | null>(null);
  const drawRef = useRef<TerraDraw | null>(null);
  const layersRef = useRef<VectorLayer[]>(layers);
  layersRef.current = layers;
  const basemapOpacityRef = useRef(basemapOpacity);
  basemapOpacityRef.current = basemapOpacity;
  const appliedBasemapRef = useRef<string | null>(null);
  const appliedVersionRef = useRef<number>(basemapVersionIndex);
  const dateMarkersRef = useRef<Map<string, maplibregl.Marker>>(new Map());
  const onDateLabelMoveRef = useRef(onDateLabelMove);
  onDateLabelMoveRef.current = onDateLabelMove;
  const obstaclesRef = useRef<ObstacleZone[]>(obstacles ?? []);
  obstaclesRef.current = obstacles ?? [];

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const apply = () => applyObstacleOverlay(map, obstaclesRef.current);
    if (map.isStyleLoaded()) apply();
    else map.once('idle', apply);
  }, [obstacles]);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: buildBasemapStyle(basemap, basemapVersionIndex),
      center: [121, 23.8],
      zoom: 6,
      localIdeographFontFamily: "'Noto Sans TC', 'Microsoft JhengHei', 'PingFang TC', 'Hiragino Sans', sans-serif",
    });
    appliedBasemapRef.current = basemap.id;
    appliedVersionRef.current = basemapVersionIndex;
    map.addControl(new maplibregl.NavigationControl(), 'top-right');
    map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');
    map.on('load', () => {
      applyBasemapOpacity(map, basemapOpacityRef.current);
      syncLayers(map, layersRef.current);
      removeTerraDrawLeftovers(map);
      const draw = createDraw(map);
      drawRef.current = draw;
      onMapReady?.(map);
      onDrawReady?.(draw);
    });
    mapRef.current = map;
    return () => {
      if (drawRef.current) {
        try { drawRef.current.stop(); } catch { /* noop */ }
        drawRef.current = null;
      }
      dateMarkersRef.current.clear();
      map.remove();
      mapRef.current = null;
      appliedBasemapRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (
      appliedBasemapRef.current === basemap.id &&
      appliedVersionRef.current === basemapVersionIndex
    ) {
      return;
    }
    appliedBasemapRef.current = basemap.id;
    appliedVersionRef.current = basemapVersionIndex;

    let cancelled = false;
    const apply = () => {
      if (cancelled) return;
      if (!map.isStyleLoaded()) {
        map.once('idle', apply);
        return;
      }
      if (map.getLayer('basemap')) map.removeLayer('basemap');
      if (map.getSource('basemap')) map.removeSource('basemap');
      map.addSource('basemap', {
        type: 'raster',
        tiles: basemapTiles(basemap, basemapVersionIndex),
        tileSize: 256,
        maxzoom: basemap.maxzoom ?? 19,
        attribution: basemap.attribution,
      });
      const otherLayers = (map.getStyle().layers ?? []).filter(
        (l) => l.id !== 'background' && l.id !== 'basemap',
      );
      const beforeId = otherLayers[0]?.id;
      map.addLayer({ id: 'basemap', type: 'raster', source: 'basemap' }, beforeId);
      applyBasemapOpacity(map, basemapOpacityRef.current);
    };
    apply();
    return () => {
      cancelled = true;
    };
  }, [basemap, basemapVersionIndex]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    applyBasemapOpacity(map, basemapOpacity);
  }, [basemapOpacity]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (map.isStyleLoaded()) {
      syncLayers(map, layers);
      return;
    }
    // 樣式尚未就緒（多半是底圖/資料來源仍在載入，例如剛切換專案、匯入、生成等濃度線）。
    // 用 'idle'（所有來源/圖磚載完才觸發）重試；'styledata' 在來源「載完」時不一定再次觸發，
    // 會導致同步遺失、直到重新整理才生效。
    const run = () => syncLayers(map, layersRef.current);
    map.once('idle', run);
    return () => {
      map.off('idle', run);
    };
  }, [layers]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    syncDateMarkers(map, layers, dateMarkersRef.current, (id, lng, lat) =>
      onDateLabelMoveRef.current?.(id, lng, lat),
    );
  }, [layers]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !pickMode) return;
    map.getCanvas().style.cursor = 'crosshair';
    const onClick = (e: maplibregl.MapMouseEvent) => {
      onPick?.(e.lngLat.lng, e.lngLat.lat);
    };
    map.once('click', onClick);
    return () => {
      map.off('click', onClick);
      map.getCanvas().style.cursor = '';
    };
  }, [pickMode, onPick]);

  return <div ref={containerRef} className="map-canvas" />;
}

function applyBasemapOpacity(map: MLMap, opacity: number) {
  if (!map.getLayer('basemap')) return;
  try {
    map.setPaintProperty('basemap', 'raster-opacity', opacity);
  } catch { /* noop */ }
}

function removeTerraDrawLeftovers(map: MLMap) {
  const style = map.getStyle();
  const layersInStyle = style.layers ?? [];
  for (const l of layersInStyle) {
    if (l.id.startsWith('td-')) {
      try { if (map.getLayer(l.id)) map.removeLayer(l.id); } catch { /* noop */ }
    }
  }
  const sources = Object.keys(style.sources ?? {});
  for (const s of sources) {
    if (s.startsWith('td-')) {
      try { if (map.getSource(s)) map.removeSource(s); } catch { /* noop */ }
    }
  }
}

function createDraw(map: MLMap): TerraDraw {
  const draw = new TerraDraw({
    adapter: new TerraDrawMapLibreGLAdapter({ map }),
    modes: [
      new TerraDrawSelectMode({
        flags: {
          point: { feature: { draggable: true } },
          linestring: {
            feature: {
              draggable: true,
              coordinates: { midpoints: true, draggable: true, deletable: true },
            },
          },
          polygon: {
            feature: {
              draggable: true,
              coordinates: { midpoints: true, draggable: true, deletable: true },
            },
          },
          rectangle: {
            feature: { draggable: true, coordinates: { draggable: true } },
          },
          circle: { feature: { draggable: true } },
          freehand: {
            feature: { draggable: true, coordinates: { midpoints: true, draggable: true, deletable: true } },
          },
        },
      }),
      new TerraDrawPointMode(),
      new TerraDrawLineStringMode(),
      new TerraDrawPolygonMode(),
      new TerraDrawRectangleMode(),
      new TerraDrawCircleMode(),
      new TerraDrawFreehandMode(),
    ],
  });
  draw.start();
  return draw;
}

function sourceId(id: string) {
  return `layer-src-${id}`;
}
function fillId(id: string) {
  return `layer-fill-${id}`;
}
function lineId(id: string) {
  return `layer-line-${id}`;
}
function pointId(id: string) {
  return `layer-point-${id}`;
}
function pointSymId(id: string) {
  return `layer-pointsym-${id}`;
}
function labelId(id: string) {
  return `layer-label-${id}`;
}
const MANAGED_PREFIXES = ['layer-fill-', 'layer-line-', 'layer-pointsym-', 'layer-point-', 'layer-label-'];

function syncLayers(map: MLMap, layers: VectorLayer[]) {
  const style = map.getStyle();
  const existing = style.layers ?? [];
  const managed = existing.filter((l) =>
    MANAGED_PREFIXES.some((p) => l.id.startsWith(p)),
  );
  const keepIds = new Set<string>();
  for (const l of layers) {
    const useSymbol = !!l.exceedance || (!!l.pointShape && l.pointShape !== 'circle');
    keepIds.add(fillId(l.id));
    keepIds.add(lineId(l.id));
    keepIds.add(useSymbol ? pointSymId(l.id) : pointId(l.id));
    keepIds.add(labelId(l.id));
  }
  for (const l of managed) {
    if (!keepIds.has(l.id)) {
      if (map.getLayer(l.id)) map.removeLayer(l.id);
    }
  }
  const sources = Object.keys(style.sources ?? {}).filter((s) => s.startsWith('layer-src-'));
  for (const s of sources) {
    const id = s.replace('layer-src-', '');
    if (!layers.find((l) => l.id === id)) {
      if (map.getSource(s)) map.removeSource(s);
    }
  }

  for (const layer of layers) {
    const srcId = sourceId(layer.id);
    const src = map.getSource(srcId) as maplibregl.GeoJSONSource | undefined;
    if (src) {
      src.setData(layer.data);
    } else {
      map.addSource(srcId, { type: 'geojson', data: layer.data });
    }

    const visibility = layer.visible ? 'visible' : 'none';

    const stroke = layer.strokeColor ?? layer.color;
    const strokeW = layer.strokeWidth ?? 2;
    const strokeOn = layer.strokeVisible !== false;
    const lineVisibility = layer.visible && strokeOn ? 'visible' : 'none';
    const pointStrokeW = strokeOn ? strokeW * 0.75 : 0;
    const isContourLbl = !!layer.waterLevel;
    const heightLbl = layer.waterLevel?.heightLabel;
    const labelColor = isContourLbl
      ? (heightLbl?.color ?? '#ffffff')
      : (layer.labelColor ?? '#ffffff');
    const labelSize = isContourLbl
      ? (heightLbl?.size ?? 12)
      : (layer.labelSize ?? 12);
    const labelHalo = isContourLbl
      ? (heightLbl?.haloColor ?? '#000000')
      : (layer.labelHaloColor ?? '#000000');
    const labelEffectivelyVisible = isContourLbl
      ? heightLbl?.visible !== false
      : layer.labelVisible !== false;
    const labelVisibility = layer.visible && labelEffectivelyVisible ? 'visible' : 'none';

    const genActiveDate = layer.waterLevel?.activeDate;
    const genActiveSub = layer.waterLevel?.activeSubstance ?? layer.exceedance?.activeSubstance;
    const dateFilter = genActiveDate
      ? (['==', ['get', '__date'], genActiveDate] as unknown as maplibregl.FilterSpecification)
      : null;
    const subFilter = genActiveSub
      ? (['==', ['get', '__substance'], genActiveSub] as unknown as maplibregl.FilterSpecification)
      : null;
    const wrap = (base: maplibregl.FilterSpecification): maplibregl.FilterSpecification => {
      const filters: maplibregl.FilterSpecification[] = [base];
      if (dateFilter) filters.push(dateFilter);
      if (subFilter) filters.push(subFilter);
      if (filters.length === 1) return base;
      return (['all', ...filters] as unknown as maplibregl.FilterSpecification);
    };

    const fillFilter = wrap(['any', ['==', ['geometry-type'], 'Polygon'], ['==', ['geometry-type'], 'MultiPolygon']] as unknown as maplibregl.FilterSpecification);
    const isContourLayer = !!layer.waterLevel;
    const lineBase = isContourLayer
      ? ([
          'any',
          ['==', ['geometry-type'], 'LineString'],
          ['==', ['geometry-type'], 'MultiLineString'],
        ] as unknown as maplibregl.FilterSpecification)
      : ([
          'any',
          ['==', ['geometry-type'], 'LineString'],
          ['==', ['geometry-type'], 'MultiLineString'],
          ['==', ['geometry-type'], 'Polygon'],
          ['==', ['geometry-type'], 'MultiPolygon'],
        ] as unknown as maplibregl.FilterSpecification);
    const lineFilter = wrap(lineBase);
    let pointFilter = wrap(['any', ['==', ['geometry-type'], 'Point'], ['==', ['geometry-type'], 'MultiPoint']] as unknown as maplibregl.FilterSpecification);
    let labelFilter = wrap(['all', ['has', '名稱'], ['!=', ['get', '名稱'], '']] as unknown as maplibregl.FilterSpecification);
    if (layer.exceedance) {
      const excl: maplibregl.FilterSpecification[] = [];
      if (layer.exceedance.showOk === false) {
        excl.push(['!=', ['get', '__exLevel'], 'ok'] as unknown as maplibregl.FilterSpecification);
      }
      if (layer.exceedance.showNodata !== true) {
        excl.push(['!=', ['get', '__exLevel'], 'nodata'] as unknown as maplibregl.FilterSpecification);
      }
      const hiddenBatches = layer.exceedance.batches.filter((b) => b.visible === false).map((b) => b.name);
      if (hiddenBatches.length > 0) {
        excl.push(['!', ['in', ['get', '__batch'], ['literal', hiddenBatches]]] as unknown as maplibregl.FilterSpecification);
      }
      if (excl.length > 0) {
        pointFilter = (['all', pointFilter, ...excl] as unknown as maplibregl.FilterSpecification);
        labelFilter = (['all', labelFilter, ...excl] as unknown as maplibregl.FilterSpecification);
      }
    }

    const isContour = !!layer.waterLevel;
    const activeStyle = getActiveStyle(layer);
    const fillColor = isContour
      ? (['coalesce', ['get', '__color'], 'rgba(0,0,0,0)'] as unknown as maplibregl.ExpressionSpecification)
      : layer.color;
    const fillOpacity = isContour
      ? (activeStyle.fill?.opacity ?? 0.6)
      : layer.opacity * 0.45;

    if (!map.getLayer(fillId(layer.id))) {
      map.addLayer({
        id: fillId(layer.id),
        type: 'fill',
        source: srcId,
        filter: fillFilter,
        paint: {
          'fill-color': fillColor,
          'fill-opacity': fillOpacity,
        },
        layout: { visibility },
      });
    } else {
      map.setFilter(fillId(layer.id), fillFilter);
      map.setPaintProperty(fillId(layer.id), 'fill-color', fillColor);
      map.setPaintProperty(fillId(layer.id), 'fill-opacity', fillOpacity);
      map.setLayoutProperty(fillId(layer.id), 'visibility', visibility);
    }

    const arrowColor = activeStyle.arrows?.color ?? '#1d4ed8';
    const arrowWidth = activeStyle.arrows?.width ?? 1.5;
    const minorWidthRatio = activeStyle.lines?.minorWidthRatio ?? 0.5;
    const lineWidth = isContour
      ? (['match', ['get', '__line'],
          'minor', strokeW * minorWidthRatio,
          'outline', strokeW * 1.5,
          'arrow', arrowWidth,
          'threshold-control', strokeW * 1.6,
          'threshold-monitor', strokeW * 1.6,
          strokeW] as unknown as maplibregl.ExpressionSpecification)
      : strokeW;
    const lineOpacity = isContour
      ? (['*', layer.opacity, ['match', ['get', '__line'],
          'minor', 0.5,
          1]] as unknown as maplibregl.ExpressionSpecification)
      : 1;
    const dashFor = (style: string | undefined): number[] => {
      if (style === 'dash') return [4, 2];
      if (style === 'dot') return [1, 2];
      if (style === 'dashdot') return [4, 2, 1, 2];
      return [1, 0];
    };
    const majorDash = dashFor(activeStyle.lines?.dashStyle);
    const minorDash = dashFor(activeStyle.lines?.minorDashStyle);
    const minorColor = activeStyle.lines?.minorColor ?? '#9aa3b1';
    const lineColor = isContour
      ? (['match', ['get', '__line'],
          'minor', minorColor,
          'arrow', arrowColor,
          'threshold-control', '#ef4444',
          'threshold-monitor', '#f97316',
          stroke] as unknown as maplibregl.ExpressionSpecification)
      : stroke;
    const lineDashExpr = isContour
      ? (['match', ['get', '__line'],
          'minor', ['literal', minorDash],
          'arrow', ['literal', [1, 0]],
          'threshold-control', ['literal', [1, 0]],
          'threshold-monitor', ['literal', [1, 0]],
          ['literal', majorDash]] as unknown as maplibregl.ExpressionSpecification)
      : null;

    if (!map.getLayer(lineId(layer.id))) {
      map.addLayer({
        id: lineId(layer.id),
        type: 'line',
        source: srcId,
        filter: lineFilter,
        paint: {
          'line-color': lineColor,
          'line-opacity': lineOpacity,
          'line-width': lineWidth,
          ...(lineDashExpr ? { 'line-dasharray': lineDashExpr } : {}),
        },
        layout: { visibility: lineVisibility },
      });
    } else {
      map.setFilter(lineId(layer.id), lineFilter);
      map.setPaintProperty(lineId(layer.id), 'line-color', lineColor);
      map.setPaintProperty(lineId(layer.id), 'line-opacity', lineOpacity);
      map.setPaintProperty(lineId(layer.id), 'line-width', lineWidth);
      map.setPaintProperty(lineId(layer.id), 'line-dasharray', lineDashExpr ?? null);
      map.setLayoutProperty(lineId(layer.id), 'visibility', lineVisibility);
    }

    const ex = layer.exceedance;
    const pointR = ex?.radius ?? layer.pointRadius ?? 5;
    const useSymbol = !!ex || (!!layer.pointShape && layer.pointShape !== 'circle');
    const circleColor: string | maplibregl.ExpressionSpecification = ex
      ? (['match', ['get', '__exLevel'],
          'alert', ex.colors?.alert ?? '#dc2626',
          'warn', ex.colors?.warn ?? '#f59e0b',
          'ok', ex.colors?.ok ?? '#16a34a',
          ex.colors?.nodata ?? '#9ca3af'] as unknown as maplibregl.ExpressionSpecification)
      : layer.color;

    if (useSymbol) {
      if (map.getLayer(pointId(layer.id))) map.removeLayer(pointId(layer.id));
      // 非 SDF：填色 + 描邊直接畫進圖示（保留尖角），依需要的（形狀×色）即時註冊
      let iconImage: string | maplibregl.ExpressionSpecification;
      if (ex) {
        const exStroke = '#ffffff';
        const levelColor: Record<string, string> = {
          alert: ex.colors?.alert ?? '#dc2626',
          warn: ex.colors?.warn ?? '#f59e0b',
          ok: ex.colors?.ok ?? '#16a34a',
          nodata: ex.colors?.nodata ?? '#9ca3af',
        };
        const shapesUsed = new Set<PointShape>(ex.batches.map((b) => b.shape));
        shapesUsed.add('circle');
        for (const sh of shapesUsed) {
          for (const lvl of ['alert', 'warn', 'ok', 'nodata']) {
            ensurePointIcon(map, sh, levelColor[lvl], exStroke);
          }
        }
        const levelExpr = (sh: PointShape): maplibregl.ExpressionSpecification =>
          (['match', ['get', '__exLevel'],
            'alert', pointIconId(sh, levelColor.alert, exStroke),
            'warn', pointIconId(sh, levelColor.warn, exStroke),
            'ok', pointIconId(sh, levelColor.ok, exStroke),
            pointIconId(sh, levelColor.nodata, exStroke)] as unknown as maplibregl.ExpressionSpecification);
        iconImage = ex.batches.length > 0
          ? (['match', ['get', '__batch'],
              ...ex.batches.flatMap((b) => [b.name, levelExpr(b.shape)]),
              levelExpr('circle')] as unknown as maplibregl.ExpressionSpecification)
          : levelExpr('circle');
      } else {
        const sh = layer.pointShape ?? 'circle';
        const strokeCol = strokeOn ? stroke : 'rgba(0,0,0,0)';
        const strokeWpx = strokeOn ? Math.max(strokeW, 1) * 2 : 0;
        iconImage = ensurePointIcon(map, sh, layer.color, strokeCol, strokeWpx);
      }
      const iconSize = (pointR * 2) / (SHAPE_IMG_SIZE * SHAPE_DRAW_RATIO);
      if (!map.getLayer(pointSymId(layer.id))) {
        map.addLayer({
          id: pointSymId(layer.id),
          type: 'symbol',
          source: srcId,
          filter: pointFilter,
          layout: {
            'icon-image': iconImage,
            'icon-size': iconSize,
            'icon-allow-overlap': true,
            'icon-ignore-placement': true,
            visibility,
          },
          paint: {
            'icon-opacity': layer.opacity,
          },
        });
      } else {
        map.setFilter(pointSymId(layer.id), pointFilter);
        map.setLayoutProperty(pointSymId(layer.id), 'icon-image', iconImage);
        map.setLayoutProperty(pointSymId(layer.id), 'icon-size', iconSize);
        map.setLayoutProperty(pointSymId(layer.id), 'visibility', visibility);
        map.setPaintProperty(pointSymId(layer.id), 'icon-opacity', layer.opacity);
      }
    } else {
      if (map.getLayer(pointSymId(layer.id))) map.removeLayer(pointSymId(layer.id));
      if (!map.getLayer(pointId(layer.id))) {
        map.addLayer({
          id: pointId(layer.id),
          type: 'circle',
          source: srcId,
          filter: pointFilter,
          paint: {
            'circle-color': circleColor,
            'circle-opacity': layer.opacity,
            'circle-radius': pointR,
            'circle-stroke-color': stroke,
            'circle-stroke-width': pointStrokeW,
          },
          layout: { visibility },
        });
      } else {
        map.setFilter(pointId(layer.id), pointFilter);
        map.setPaintProperty(pointId(layer.id), 'circle-color', circleColor);
        map.setPaintProperty(pointId(layer.id), 'circle-opacity', layer.opacity);
        map.setPaintProperty(pointId(layer.id), 'circle-radius', pointR);
        map.setPaintProperty(pointId(layer.id), 'circle-stroke-color', stroke);
        map.setPaintProperty(pointId(layer.id), 'circle-stroke-width', pointStrokeW);
        map.setLayoutProperty(pointId(layer.id), 'visibility', visibility);
      }
    }

    if (!map.getLayer(labelId(layer.id))) {
      map.addLayer({
        id: labelId(layer.id),
        type: 'symbol',
        source: srcId,
        filter: labelFilter,
        layout: {
          'text-field': ['to-string', ['get', '名稱']],
          'text-font': ['Open Sans Regular'],
          'text-size': labelSize,
          'text-offset': isContour ? [0, 0] : [0, 1.2],
          'text-anchor': isContour ? 'center' : 'top',
          'text-allow-overlap': false,
          'text-optional': true,
          ...(isContour
            ? {
                'symbol-placement': 'line',
                'text-rotation-alignment': 'map',
                'text-keep-upright': true,
                'text-pitch-alignment': 'map',
                'symbol-spacing': 400,
                'text-padding': 8,
              }
            : {}),
          visibility: labelVisibility,
        },
        paint: {
          'text-color': labelColor,
          'text-halo-color': labelHalo,
          'text-halo-width': 1.6,
        },
      });
    } else {
      map.setFilter(labelId(layer.id), labelFilter);
      map.setLayoutProperty(labelId(layer.id), 'visibility', labelVisibility);
      map.setLayoutProperty(labelId(layer.id), 'text-size', labelSize);
      map.setPaintProperty(labelId(layer.id), 'text-color', labelColor);
      map.setPaintProperty(labelId(layer.id), 'text-halo-color', labelHalo);
    }
  }

  for (let i = layers.length - 1; i >= 0; i--) {
    const l = layers[i];
    for (const id of [fillId(l.id), lineId(l.id), pointId(l.id), pointSymId(l.id), labelId(l.id)]) {
      if (map.getLayer(id)) {
        try { map.moveLayer(id); } catch { /* noop */ }
      }
    }
  }
}

function bboxRightBottom(layer: VectorLayer): [number, number] | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const visit = (coords: unknown): void => {
    if (!Array.isArray(coords)) return;
    if (typeof coords[0] === 'number' && typeof coords[1] === 'number') {
      const x = coords[0] as number;
      const y = coords[1] as number;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      return;
    }
    for (const c of coords) visit(c);
  };
  for (const f of layer.data.features) {
    if (!f.geometry) continue;
    visit((f.geometry as { coordinates?: unknown }).coordinates);
  }
  if (!Number.isFinite(minX)) return null;
  const padX = (maxX - minX) * 0.04;
  const padY = (maxY - minY) * 0.04;
  return [maxX - padX, minY + padY];
}

function syncDateMarkers(
  map: MLMap,
  layers: VectorLayer[],
  markers: Map<string, maplibregl.Marker>,
  onMove: (id: string, lng: number, lat: number) => void,
) {
  const wantedIds = new Set<string>();
  for (const layer of layers) {
    const dl = layer.waterLevel?.dateLabel;
    if (!layer.visible || !layer.waterLevel || !dl?.visible) continue;
    let pos: [number, number] | null = null;
    if (typeof dl.lng === 'number' && typeof dl.lat === 'number') {
      pos = [dl.lng, dl.lat];
    } else {
      pos = bboxRightBottom(layer);
    }
    if (!pos) continue;

    let marker = markers.get(layer.id);
    if (!marker) {
      const el = document.createElement('div');
      el.className = 'date-label-marker';
      marker = new maplibregl.Marker({ element: el, draggable: true });
      const m = marker;
      m.on('dragend', () => {
        const ll = m.getLngLat();
        onMove(layer.id, ll.lng, ll.lat);
      });
      marker.setLngLat(pos).addTo(map);
      markers.set(layer.id, marker);
    } else {
      marker.setLngLat(pos);
    }

    const el = marker.getElement();
    el.textContent = layer.waterLevel.activeDate;
    const color = layer.labelColor ?? '#ffffff';
    const halo = layer.labelHaloColor ?? '#000000';
    const size = layer.labelSize ?? 12;
    el.style.color = color;
    el.style.fontSize = `${size}px`;
    el.style.textShadow =
      `-1px -1px 0 ${halo}, 1px -1px 0 ${halo}, -1px 1px 0 ${halo}, 1px 1px 0 ${halo}`;

    wantedIds.add(layer.id);
  }
  for (const [id, m] of markers) {
    if (!wantedIds.has(id)) {
      m.remove();
      markers.delete(id);
    }
  }
}
