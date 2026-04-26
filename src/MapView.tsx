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
import type { BaseMapOption, VectorLayer } from './types';
import { buildBasemapStyle, basemapTiles } from './basemaps';

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
}

export function MapView({ basemap, basemapVersionIndex, basemapOpacity, layers, onMapReady, onDrawReady, pickMode, onPick, onDateLabelMove }: Props) {
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
    const onReady = () => {
      if (!map.isStyleLoaded()) return;
      map.off('styledata', onReady);
      syncLayers(map, layersRef.current);
    };
    map.on('styledata', onReady);
    return () => {
      map.off('styledata', onReady);
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
function labelId(id: string) {
  return `layer-label-${id}`;
}
const MANAGED_PREFIXES = ['layer-fill-', 'layer-line-', 'layer-point-', 'layer-label-'];

function syncLayers(map: MLMap, layers: VectorLayer[]) {
  const style = map.getStyle();
  const existing = style.layers ?? [];
  const managed = existing.filter((l) =>
    MANAGED_PREFIXES.some((p) => l.id.startsWith(p)),
  );
  const keepIds = new Set<string>();
  for (const l of layers) {
    keepIds.add(fillId(l.id));
    keepIds.add(lineId(l.id));
    keepIds.add(pointId(l.id));
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

    const dateFilter = layer.waterLevel
      ? (['==', ['get', '__date'], layer.waterLevel.activeDate] as unknown as maplibregl.FilterSpecification)
      : null;
    const subFilter = layer.waterLevel?.activeSubstance
      ? (['==', ['get', '__substance'], layer.waterLevel.activeSubstance] as unknown as maplibregl.FilterSpecification)
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
    const pointFilter = wrap(['any', ['==', ['geometry-type'], 'Point'], ['==', ['geometry-type'], 'MultiPoint']] as unknown as maplibregl.FilterSpecification);
    const labelFilter = wrap(['all', ['has', '名稱'], ['!=', ['get', '名稱'], '']] as unknown as maplibregl.FilterSpecification);

    const isContour = !!layer.waterLevel;
    const fillColor = isContour
      ? (['coalesce', ['get', '__color'], 'rgba(0,0,0,0)'] as unknown as maplibregl.ExpressionSpecification)
      : layer.color;
    const fillOpacity = isContour
      ? (layer.waterLevel?.fill?.opacity ?? 0.6)
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

    const arrowColor = layer.waterLevel?.arrows?.color ?? '#1d4ed8';
    const arrowWidth = layer.waterLevel?.arrows?.width ?? 1.5;
    const minorWidthRatio = layer.waterLevel?.lines?.minorWidthRatio ?? 0.5;
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
    const majorDash = dashFor(layer.waterLevel?.lines?.dashStyle);
    const minorDash = dashFor(layer.waterLevel?.lines?.minorDashStyle);
    const minorColor = layer.waterLevel?.lines?.minorColor ?? '#9aa3b1';
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

    const pointR = layer.pointRadius ?? 5;

    if (!map.getLayer(pointId(layer.id))) {
      map.addLayer({
        id: pointId(layer.id),
        type: 'circle',
        source: srcId,
        filter: pointFilter,
        paint: {
          'circle-color': layer.color,
          'circle-opacity': layer.opacity,
          'circle-radius': pointR,
          'circle-stroke-color': stroke,
          'circle-stroke-width': pointStrokeW,
        },
        layout: { visibility },
      });
    } else {
      map.setFilter(pointId(layer.id), pointFilter);
      map.setPaintProperty(pointId(layer.id), 'circle-color', layer.color);
      map.setPaintProperty(pointId(layer.id), 'circle-opacity', layer.opacity);
      map.setPaintProperty(pointId(layer.id), 'circle-radius', pointR);
      map.setPaintProperty(pointId(layer.id), 'circle-stroke-color', stroke);
      map.setPaintProperty(pointId(layer.id), 'circle-stroke-width', pointStrokeW);
      map.setLayoutProperty(pointId(layer.id), 'visibility', visibility);
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
    for (const id of [fillId(l.id), lineId(l.id), pointId(l.id), labelId(l.id)]) {
      if (map.getLayer(id)) {
        try { map.moveLayer(id); } catch { /* noop */ }
      }
    }
  }
}

function bboxCenter(layer: VectorLayer): [number, number] | null {
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
  return [(minX + maxX) / 2, (minY + maxY) / 2];
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
      pos = bboxCenter(layer);
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
