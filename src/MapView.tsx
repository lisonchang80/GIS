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
import { buildBasemapStyle } from './basemaps';

interface Props {
  basemap: BaseMapOption;
  layers: VectorLayer[];
  onMapReady?: (map: MLMap) => void;
  onDrawReady?: (draw: TerraDraw) => void;
  pickMode?: boolean;
  onPick?: (lng: number, lat: number) => void;
}

export function MapView({ basemap, layers, onMapReady, onDrawReady, pickMode, onPick }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MLMap | null>(null);
  const drawRef = useRef<TerraDraw | null>(null);
  const layersRef = useRef<VectorLayer[]>(layers);
  layersRef.current = layers;
  const appliedBasemapRef = useRef<string | null>(null);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: buildBasemapStyle(basemap),
      center: [121, 23.8],
      zoom: 6,
      localIdeographFontFamily: "'Noto Sans TC', 'Microsoft JhengHei', 'PingFang TC', 'Hiragino Sans', sans-serif",
    });
    appliedBasemapRef.current = basemap.id;
    map.addControl(new maplibregl.NavigationControl(), 'top-right');
    map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');
    map.on('load', () => {
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
      map.remove();
      mapRef.current = null;
      appliedBasemapRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (appliedBasemapRef.current === basemap.id) return;
    appliedBasemapRef.current = basemap.id;
    const snapshot = drawRef.current?.getSnapshot();
    if (drawRef.current) {
      try { drawRef.current.stop(); } catch { /* noop */ }
      drawRef.current = null;
    }
    map.setStyle(buildBasemapStyle(basemap));
    let cancelled = false;
    const onReady = () => {
      if (cancelled) return;
      if (!map.isStyleLoaded()) return;
      map.off('styledata', onReady);
      syncLayers(map, layersRef.current);
      removeTerraDrawLeftovers(map);
      const draw = createDraw(map);
      drawRef.current = draw;
      if (snapshot && snapshot.length > 0) {
        try { draw.addFeatures(snapshot); } catch { /* noop */ }
      }
      onDrawReady?.(draw);
    };
    map.on('styledata', onReady);
    return () => {
      cancelled = true;
      map.off('styledata', onReady);
    };
  }, [basemap]);

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

    if (!map.getLayer(fillId(layer.id))) {
      map.addLayer({
        id: fillId(layer.id),
        type: 'fill',
        source: srcId,
        filter: ['any', ['==', ['geometry-type'], 'Polygon'], ['==', ['geometry-type'], 'MultiPolygon']],
        paint: {
          'fill-color': layer.color,
          'fill-opacity': layer.opacity * 0.45,
        },
        layout: { visibility },
      });
    } else {
      map.setPaintProperty(fillId(layer.id), 'fill-color', layer.color);
      map.setPaintProperty(fillId(layer.id), 'fill-opacity', layer.opacity * 0.45);
      map.setLayoutProperty(fillId(layer.id), 'visibility', visibility);
    }

    if (!map.getLayer(lineId(layer.id))) {
      map.addLayer({
        id: lineId(layer.id),
        type: 'line',
        source: srcId,
        filter: [
          'any',
          ['==', ['geometry-type'], 'LineString'],
          ['==', ['geometry-type'], 'MultiLineString'],
          ['==', ['geometry-type'], 'Polygon'],
          ['==', ['geometry-type'], 'MultiPolygon'],
        ],
        paint: {
          'line-color': stroke,
          'line-opacity': layer.opacity,
          'line-width': strokeW,
        },
        layout: { visibility },
      });
    } else {
      map.setPaintProperty(lineId(layer.id), 'line-color', stroke);
      map.setPaintProperty(lineId(layer.id), 'line-opacity', layer.opacity);
      map.setPaintProperty(lineId(layer.id), 'line-width', strokeW);
      map.setLayoutProperty(lineId(layer.id), 'visibility', visibility);
    }

    const pointR = layer.pointRadius ?? 5;

    if (!map.getLayer(pointId(layer.id))) {
      map.addLayer({
        id: pointId(layer.id),
        type: 'circle',
        source: srcId,
        filter: ['any', ['==', ['geometry-type'], 'Point'], ['==', ['geometry-type'], 'MultiPoint']],
        paint: {
          'circle-color': layer.color,
          'circle-opacity': layer.opacity,
          'circle-radius': pointR,
          'circle-stroke-color': stroke,
          'circle-stroke-width': strokeW * 0.75,
        },
        layout: { visibility },
      });
    } else {
      map.setPaintProperty(pointId(layer.id), 'circle-color', layer.color);
      map.setPaintProperty(pointId(layer.id), 'circle-opacity', layer.opacity);
      map.setPaintProperty(pointId(layer.id), 'circle-radius', pointR);
      map.setPaintProperty(pointId(layer.id), 'circle-stroke-color', stroke);
      map.setPaintProperty(pointId(layer.id), 'circle-stroke-width', strokeW * 0.75);
      map.setLayoutProperty(pointId(layer.id), 'visibility', visibility);
    }

    if (!map.getLayer(labelId(layer.id))) {
      map.addLayer({
        id: labelId(layer.id),
        type: 'symbol',
        source: srcId,
        filter: ['all', ['has', '名稱'], ['!=', ['get', '名稱'], '']],
        layout: {
          'text-field': ['to-string', ['get', '名稱']],
          'text-font': ['Open Sans Regular'],
          'text-size': 12,
          'text-offset': [0, 1.2],
          'text-anchor': 'top',
          'text-allow-overlap': false,
          'text-optional': true,
          visibility,
        },
        paint: {
          'text-color': '#ffffff',
          'text-halo-color': 'rgba(0, 0, 0, 0.75)',
          'text-halo-width': 1.6,
        },
      });
    } else {
      map.setLayoutProperty(labelId(layer.id), 'visibility', visibility);
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
