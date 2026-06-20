import { useCallback, useEffect, useRef, useState } from 'react';
import type { Map as MLMap } from 'maplibre-gl';
import type { TerraDraw } from 'terra-draw';
import type { Feature, FeatureCollection } from 'geojson';
import { MapView } from './MapView';
import { LayerPanel } from './LayerPanel';
import { DrawToolbar, type DrawMode } from './DrawToolbar';
import { ProjectBar } from './ProjectBar';
import { AttributeTable } from './AttributeTable';
import { StylePopover } from './StylePopover';
import { Legend } from './Legend';
import { GeoOpsToolbar } from './GeoOpsToolbar';
import { bufferLayer, fcToLayer, type BufferUnits } from './geoOps';
import { searchLand, type LandQueryParams } from './landQuery';
import { BASEMAPS, basemapDefaultVersionIndex } from './basemaps';
import type { BaseMapId, VectorLayer } from './types';
import { SOIL_BATCH_KEY } from './types';
import { detectKind, ensureNames, fileToGeoJSON, geometryBounds } from './importers';
import { syncAllContours, syncContoursForSource, syncSingleContour } from './contour';
import { syncAllExceedance, syncExceedanceForSource } from './exceedance';
import {
  createProject,
  deleteProject,
  downloadProject,
  importProjectFile,
  listProjects,
  loadProject,
  saveProject,
  type ProjectMeta,
  type ProjectPayload,
  type ProjectState,
} from './persistence';
import './App.css';

const PALETTE = ['#ef4444', '#3b82f6', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899', '#14b8a6', '#f97316'];
const CURRENT_PROJECT_KEY = 'gis-current-project-id';
const DEFAULT_BASEMAP: BaseMapId = 'satellite-google';
const TERRA_DRAW_INTERNAL_KEYS = new Set(['mode', 'selected', 'midPoint', 'midPointFeature']);

function computeContourKey(wl: VectorLayer['waterLevel']): string {
  if (!wl) return '';
  return JSON.stringify({
    fill: wl.fill ?? null,
    lines: wl.lines ?? null,
    arrows: wl.arrows ?? null,
    substanceStyles: wl.substanceStyles ?? null,
    model: wl.model ?? null,
    sourceKind: wl.sourceKind ?? null,
    sourceTabId: wl.sourceTabId ?? null,
    sourceSubId: wl.sourceSubId ?? null,
    logTransform: wl.logTransform ?? null,
    clampNegative: wl.clampNegative ?? null,
    indicatorThreshold: wl.indicatorThreshold ?? null,
  });
}

function cleanDrawProps(props: Record<string, unknown> | null | undefined): Record<string, unknown> {
  if (!props) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(props)) {
    if (TERRA_DRAW_INTERNAL_KEYS.has(k)) continue;
    if (v === undefined) continue;
    out[k] = v;
  }
  return out;
}

export default function App() {
  const [initialized, setInitialized] = useState(false);
  const [basemapId, setBasemapId] = useState<BaseMapId>(DEFAULT_BASEMAP);
  const [basemapVersionIndex, setBasemapVersionIndex] = useState(0);
  const [basemapOpacity, setBasemapOpacity] = useState(1);
  const [projectName, setProjectName] = useState('未命名專案');
  const [layers, setLayers] = useState<VectorLayer[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [drawMode, setDrawMode] = useState<DrawMode>('static');
  const [drawCount, setDrawCount] = useState(0);
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [mapMoveTick, setMapMoveTick] = useState(0);
  const [attributesLayerId, setAttributesLayerId] = useState<string | null>(null);
  const [stylePopoverLayerId, setStylePopoverLayerId] = useState<string | null>(null);
  const [pickingCoords, setPickingCoords] = useState<{ layerId: string; featureIndex: number } | null>(null);
  const [addPointTarget, setAddPointTarget] = useState<string | null>(null);
  const [projects, setProjects] = useState<ProjectMeta[]>([]);
  const [currentProjectId, setCurrentProjectId] = useState<number | null>(null);

  const toggleAttributes = useCallback((id: string) => {
    setAttributesLayerId((prev) => (prev === id ? null : id));
  }, []);

  const toggleStylePopover = useCallback((id: string) => {
    setStylePopoverLayerId((prev) => (prev === id ? null : id));
  }, []);

  const mapRef = useRef<MLMap | null>(null);
  const drawRef = useRef<TerraDraw | null>(null);
  const colorCursor = useRef(0);
  const pendingProjectRef = useRef<ProjectState | null>(null);
  const mapViewAppliedRef = useRef(false);
  const drawingsAppliedRef = useRef(false);

  const basemap = BASEMAPS.find((b) => b.id === basemapId) ?? BASEMAPS[0];

  useEffect(() => {
    (async () => {
      let list = await listProjects();
      if (list.length === 0) {
        const created = await createProject('未命名專案');
        if (created) list = [created];
      }
      let chosenId: number | null = null;
      let project: ProjectState | null = null;
      if (list.length > 0) {
        const savedId = Number(localStorage.getItem(CURRENT_PROJECT_KEY));
        const chosen = list.find((p) => p.id === savedId) ?? list[0];
        chosenId = chosen.id;
        project = await loadProject(chosen.id);
      }
      if (project) {
        setBasemapId(project.basemapId);
        const base = BASEMAPS.find((b) => b.id === project.basemapId);
        const defaultIdx = base ? basemapDefaultVersionIndex(base) : 0;
        setBasemapVersionIndex(project.basemapVersionIndex ?? defaultIdx);
        setBasemapOpacity(project.basemapOpacity ?? 1);
        if (project.projectName) setProjectName(project.projectName);
        setLayers(syncAllExceedance(syncAllContours(project.layers.map((l) => ({ ...l, data: ensureNames(l.data) })))));
        if (typeof project.colorCursor === 'number') colorCursor.current = project.colorCursor;
        pendingProjectRef.current = project;
        setSavedAt(project.savedAt ? new Date(project.savedAt) : null);
      } else {
        const base = BASEMAPS.find((b) => b.id === DEFAULT_BASEMAP);
        if (base) setBasemapVersionIndex(basemapDefaultVersionIndex(base));
      }
      setProjects(list);
      setCurrentProjectId(chosenId);
      if (chosenId != null) localStorage.setItem(CURRENT_PROJECT_KEY, String(chosenId));
      setInitialized(true);
    })();
  }, []);

  const applyPendingMapView = useCallback(() => {
    const pending = pendingProjectRef.current;
    const map = mapRef.current;
    if (!pending?.mapView || !map || mapViewAppliedRef.current) return;
    map.jumpTo({ center: pending.mapView.center, zoom: pending.mapView.zoom });
    mapViewAppliedRef.current = true;
  }, []);

  const applyPendingDrawings = useCallback(() => {
    const pending = pendingProjectRef.current;
    const draw = drawRef.current;
    if (!pending?.drawings || !draw || drawingsAppliedRef.current) return;
    try {
      draw.addFeatures(pending.drawings);
    } catch (e) {
      console.warn('restore drawings failed', e);
    }
    drawingsAppliedRef.current = true;
    setDrawCount(draw.getSnapshot().length);
  }, []);

  // Apply a loaded (or null = empty) project to all state. Used for project
  // switch / new / import / clear — refs are ready by then, so drawings and
  // map view are applied directly (the mount path uses the pending-ref dance).
  const applyProject = useCallback((project: ProjectState | null) => {
    if (project) {
      setBasemapId(project.basemapId);
      const base = BASEMAPS.find((b) => b.id === project.basemapId);
      const defaultIdx = base ? basemapDefaultVersionIndex(base) : 0;
      setBasemapVersionIndex(project.basemapVersionIndex ?? defaultIdx);
      setBasemapOpacity(project.basemapOpacity ?? 1);
      setProjectName(project.projectName ?? '未命名專案');
      setLayers(syncAllExceedance(syncAllContours(project.layers.map((l) => ({ ...l, data: ensureNames(l.data) })))));
      colorCursor.current = typeof project.colorCursor === 'number' ? project.colorCursor : 0;
      setSavedAt(project.savedAt ? new Date(project.savedAt) : null);
    } else {
      setBasemapId(DEFAULT_BASEMAP);
      const base = BASEMAPS.find((b) => b.id === DEFAULT_BASEMAP);
      setBasemapVersionIndex(base ? basemapDefaultVersionIndex(base) : 0);
      setBasemapOpacity(1);
      setProjectName('未命名專案');
      setLayers([]);
      colorCursor.current = 0;
      setSavedAt(null);
    }
    setAttributesLayerId(null);
    setStylePopoverLayerId(null);
    setPickingCoords(null);
    setAddPointTarget(null);
    setDrawMode('static');
    pendingProjectRef.current = project;
    mapViewAppliedRef.current = false;
    drawingsAppliedRef.current = false;
    const draw = drawRef.current;
    if (draw) {
      try {
        draw.clear();
      } catch {
        /* noop */
      }
      if (project?.drawings && project.drawings.length > 0) {
        try {
          draw.addFeatures(project.drawings);
        } catch (e) {
          console.warn('apply drawings failed', e);
        }
      }
      drawingsAppliedRef.current = true;
      setDrawCount(draw.getSnapshot().length);
    }
    const map = mapRef.current;
    if (map && project?.mapView) {
      map.jumpTo({ center: project.mapView.center, zoom: project.mapView.zoom });
      mapViewAppliedRef.current = true;
    }
  }, []);

  const buildPayload = useCallback((): ProjectPayload => {
    const draw = drawRef.current;
    const map = mapRef.current;
    return {
      basemapId,
      basemapVersionIndex,
      basemapOpacity,
      projectName,
      layers,
      drawings: draw?.getSnapshot() ?? [],
      mapView: map
        ? { center: [map.getCenter().lng, map.getCenter().lat] as [number, number], zoom: map.getZoom() }
        : undefined,
      colorCursor: colorCursor.current,
    };
  }, [basemapId, basemapVersionIndex, basemapOpacity, projectName, layers]);

  const handleMapReady = useCallback(
    (map: MLMap) => {
      mapRef.current = map;
      map.on('moveend', () => setMapMoveTick((t) => t + 1));
      applyPendingMapView();
    },
    [applyPendingMapView],
  );

  const handleDrawReady = useCallback(
    (draw: TerraDraw) => {
      drawRef.current = draw;
      setDrawCount(draw.getSnapshot().length);
      draw.on('change', () => setDrawCount(draw.getSnapshot().length));
      applyPendingDrawings();
    },
    [applyPendingDrawings],
  );

  useEffect(() => {
    applyPendingMapView();
    applyPendingDrawings();
  }, [initialized, applyPendingMapView, applyPendingDrawings]);

  useEffect(() => {
    const draw = drawRef.current;
    if (!draw) return;
    try {
      draw.setMode(drawMode);
    } catch (e) {
      console.warn('setMode failed', e);
    }
  }, [drawMode]);

  useEffect(() => {
    if (!initialized || currentProjectId == null) return;
    const pid = currentProjectId;
    const handle = setTimeout(() => {
      saveProject(pid, buildPayload())
        .then(() => {
          setSavedAt(new Date());
          setProjects((prev) =>
            prev.map((p) => (p.id === pid ? { ...p, name: projectName || p.name } : p)),
          );
        })
        .catch((e) => console.warn('saveProject failed', e));
    }, 500);
    return () => clearTimeout(handle);
  }, [
    initialized,
    currentProjectId,
    basemapId,
    basemapVersionIndex,
    basemapOpacity,
    projectName,
    layers,
    drawCount,
    mapMoveTick,
    buildPayload,
  ]);

  const handleBasemapChange = useCallback((id: BaseMapId) => {
    setBasemapId(id);
    const base = BASEMAPS.find((b) => b.id === id);
    if (base) setBasemapVersionIndex(basemapDefaultVersionIndex(base));
  }, []);

  const handlePan = useCallback((dx: number, dy: number) => {
    mapRef.current?.panBy([dx, dy], { duration: 350 });
  }, []);

  const handlePanReset = useCallback(() => {
    mapRef.current?.flyTo({ center: [121, 23.8], zoom: 6, duration: 700 });
  }, []);

  const handleFiles = useCallback(async (files: FileList) => {
    setError(null);
    const newLayers: VectorLayer[] = [];
    for (const file of Array.from(files)) {
      try {
        const raw = await fileToGeoJSON(file);
        const fc = ensureNames(raw);
        const color = PALETTE[colorCursor.current % PALETTE.length];
        colorCursor.current += 1;
        newLayers.push({
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          name: file.name.replace(/\.[^.]+$/, ''),
          visible: true,
          opacity: 0.85,
          color,
          kind: detectKind(fc),
          data: fc,
          featureCount: fc.features.length,
        });
      } catch (e) {
        setError(`${file.name}: ${(e as Error).message}`);
      }
    }
    if (newLayers.length > 0) {
      setLayers((prev) => [...newLayers, ...prev]);
      const first = newLayers[0];
      const bounds = geometryBounds(first.data);
      if (bounds && mapRef.current) {
        mapRef.current.fitBounds(
          [
            [bounds[0], bounds[1]],
            [bounds[2], bounds[3]],
          ],
          { padding: 60, duration: 800 },
        );
      }
    }
  }, []);

  const updateLayer = useCallback((id: string, patch: Partial<VectorLayer>) => {
    setLayers((prev) => {
      const next = prev.map((l) => (l.id === id ? { ...l, ...patch } : l));
      if ('data' in patch || 'gwConcTabs' in patch || 'soilConcTabs' in patch) {
        return syncExceedanceForSource(syncContoursForSource(next, id), id);
      }
      if ('waterLevel' in patch) {
        const before = prev.find((l) => l.id === id);
        const after = next.find((l) => l.id === id);
        const beforeKey = computeContourKey(before?.waterLevel);
        const afterKey = computeContourKey(after?.waterLevel);
        if (beforeKey !== afterKey && after?.waterLevel?.sourceLayerId) {
          return syncSingleContour(next, id);
        }
      }
      return next;
    });
  }, []);

  const handleDateLabelMove = useCallback(
    (id: string, lng: number, lat: number) => {
      setLayers((prev) =>
        prev.map((l) => {
          if (l.id !== id || !l.waterLevel) return l;
          return {
            ...l,
            waterLevel: {
              ...l.waterLevel,
              dateLabel: { ...(l.waterLevel.dateLabel ?? {}), visible: true, lng, lat },
            },
          };
        }),
      );
    },
    [],
  );

  const addLayer = useCallback((layer: VectorLayer) => {
    setLayers((prev) => [layer, ...prev]);
  }, []);

  const removeLayer = useCallback((id: string) => {
    setLayers((prev) => prev.filter((l) => l.id !== id));
  }, []);

  const zoomToLayer = useCallback((id: string) => {
    const layer = layers.find((x) => x.id === id);
    if (!layer || !mapRef.current) return;
    const b = geometryBounds(layer.data);
    if (b) {
      mapRef.current.fitBounds(
        [[b[0], b[1]], [b[2], b[3]]],
        { padding: 60, duration: 600 },
      );
    }
  }, [layers]);

  const reorderLayer = useCallback((draggedId: string, targetId: string, position: 'above' | 'below') => {
    setLayers((prev) => {
      const fromIdx = prev.findIndex((l) => l.id === draggedId);
      const toIdx = prev.findIndex((l) => l.id === targetId);
      if (fromIdx === -1 || toIdx === -1 || fromIdx === toIdx) return prev;
      const next = prev.slice();
      const [moved] = next.splice(fromIdx, 1);
      let insertAt = next.findIndex((l) => l.id === targetId);
      if (position === 'below') insertAt += 1;
      next.splice(insertAt, 0, moved);
      return next;
    });
  }, []);

  const duplicateLayer = useCallback((id: string) => {
    setLayers((prev) => {
      const i = prev.findIndex((l) => l.id === id);
      if (i === -1) return prev;
      const src = prev[i];
      const copy: VectorLayer = {
        ...src,
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        name: `${src.name} (複製)`,
        data: JSON.parse(JSON.stringify(src.data)) as FeatureCollection,
      };
      const next = prev.slice();
      next.splice(i, 0, copy);
      return next;
    });
  }, []);

  const exportLayerAsGeoJSON = useCallback((id: string) => {
    const layer = layers.find((l) => l.id === id);
    if (!layer) return;
    const blob = new Blob([JSON.stringify(layer.data, null, 2)], { type: 'application/geo+json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const safe = layer.name.replace(/[^\w\u4e00-\u9fff-]+/g, '_');
    a.download = `${safe || 'layer'}.geojson`;
    a.click();
    URL.revokeObjectURL(url);
  }, [layers]);

  const zoomToFeature = useCallback((feature: Feature) => {
    const b = geometryBounds({ type: 'FeatureCollection', features: [feature] });
    if (!b || !mapRef.current) return;
    const spanX = b[2] - b[0];
    const spanY = b[3] - b[1];
    if (spanX === 0 && spanY === 0) {
      mapRef.current.flyTo({
        center: [b[0], b[1]],
        zoom: Math.max(mapRef.current.getZoom(), 15),
        duration: 700,
      });
    } else {
      mapRef.current.fitBounds(
        [[b[0], b[1]], [b[2], b[3]]],
        { padding: 80, duration: 700 },
      );
    }
  }, []);

  const handleDeleteSelected = () => {
    const draw = drawRef.current;
    if (!draw) return;
    const snapshot = draw.getSnapshot();
    const selectedIds = snapshot
      .filter((f) => f.properties?.selected)
      .map((f) => f.id)
      .filter((id): id is string | number => id !== undefined);
    if (selectedIds.length > 0) draw.removeFeatures(selectedIds);
  };

  const handleClearAll = () => {
    drawRef.current?.clear();
  };

  const handleAddPointByCoords = (lng: number, lat: number): string | null => {
    const draw = drawRef.current;
    const map = mapRef.current;
    if (!draw) return '地圖尚未就緒';
    try {
      const result = draw.addFeatures([
        {
          id: crypto.randomUUID(),
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [lng, lat] },
          properties: { mode: 'point' },
        },
      ]);
      const failed = result?.find((r) => r && r.valid === false);
      if (failed) return failed.reason ?? '座標驗證失敗';
      if (map) {
        const targetZoom = Math.max(map.getZoom(), 14);
        map.flyTo({ center: [lng, lat], zoom: targetZoom, duration: 700 });
      }
      return null;
    } catch (e) {
      return (e as Error).message;
    }
  };

  const handleExportDraw = () => {
    const draw = drawRef.current;
    if (!draw) return;
    const snapshot = draw.getSnapshot();
    if (snapshot.length === 0) return;
    const cleaned = snapshot.map((f) => ({
      type: 'Feature' as const,
      geometry: JSON.parse(JSON.stringify(f.geometry)),
      properties: cleanDrawProps(f.properties as Record<string, unknown> | null),
    }));
    const fc: FeatureCollection = ensureNames({ type: 'FeatureCollection', features: cleaned });
    const color = PALETTE[colorCursor.current % PALETTE.length];
    colorCursor.current += 1;
    const layer: VectorLayer = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name: `繪製圖層 ${new Date().toLocaleTimeString('zh-TW', { hour12: false })}`,
      visible: true,
      opacity: 0.85,
      color,
      kind: detectKind(fc),
      data: fc,
      featureCount: fc.features.length,
    };
    setLayers((prev) => [layer, ...prev]);
    setDrawMode('static');
    requestAnimationFrame(() => {
      try { draw.clear(); } catch { /* noop */ }
      mapRef.current?.triggerRepaint();
    });
  };

  const handleExportProject = () => {
    downloadProject(buildPayload());
  };

  const handleImportProject = async (file: File) => {
    setError(null);
    try {
      const project = await importProjectFile(file);
      applyProject(project);
    } catch (e) {
      setError(`匯入失敗: ${(e as Error).message}`);
    }
  };

  const runGeoOp = useCallback(
    (
      sourceId: string,
      run: (layer: VectorLayer) => FeatureCollection,
      nameSuffix: string,
    ): string | null => {
      const source = layers.find((l) => l.id === sourceId);
      if (!source) return '找不到來源圖層';
      try {
        const fc = run(source);
        const color = PALETTE[colorCursor.current % PALETTE.length];
        colorCursor.current += 1;
        const newLayer = fcToLayer(fc, `${source.name} ${nameSuffix}`, color);
        setLayers((prev) => [newLayer, ...prev]);
        const b = geometryBounds(newLayer.data);
        if (b && mapRef.current) {
          mapRef.current.fitBounds(
            [[b[0], b[1]], [b[2], b[3]]],
            { padding: 60, duration: 700 },
          );
        }
        return null;
      } catch (e) {
        return (e as Error).message;
      }
    },
    [layers],
  );

  const handleBuffer = useCallback(
    (sourceId: string, distance: number, units: BufferUnits): string | null => {
      const unitLabel = units === 'meters' ? 'm' : 'km';
      return runGeoOp(sourceId, (l) => bufferLayer(l, distance, units), `緩衝 ${distance}${unitLabel}`);
    },
    [runGeoOp],
  );

  const handleStartPickCoords = useCallback((featureIndex: number) => {
    if (!attributesLayerId) return;
    setDrawMode('static');
    setPickingCoords({ layerId: attributesLayerId, featureIndex });
  }, [attributesLayerId]);

  const handleStartAddPointPick = useCallback(() => {
    if (!attributesLayerId) return;
    setDrawMode('static');
    setPickingCoords(null);
    setAddPointTarget(attributesLayerId);
  }, [attributesLayerId]);

  const handleMapPick = useCallback((lng: number, lat: number) => {
    if (addPointTarget) {
      const targetId = addPointTarget;
      setLayers((prev) => {
        const next = prev.map((l) => {
          if (l.id !== targetId) return l;
          const props: Record<string, unknown> = {};
          if ((l.soilConcTabs?.length ?? 0) > 0) props[SOIL_BATCH_KEY] = '';
          const feat: Feature = {
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [lng, lat] },
            properties: props,
          };
          const features = [...l.data.features, feat];
          return { ...l, data: { ...l.data, features }, featureCount: features.length };
        });
        return syncExceedanceForSource(syncContoursForSource(next, targetId), targetId);
      });
      setAddPointTarget(null);
      return;
    }
    if (!pickingCoords) return;
    const { layerId, featureIndex } = pickingCoords;
    setLayers((prev) => {
      const next = prev.map((l) => {
        if (l.id !== layerId) return l;
        const newFeatures = l.data.features.map((f, i) => {
          if (i !== featureIndex) return f;
          if (f.geometry?.type !== 'Point') return f;
          return { ...f, geometry: { type: 'Point' as const, coordinates: [lng, lat] } };
        });
        return { ...l, data: { ...l.data, features: newFeatures } };
      });
      return syncExceedanceForSource(syncContoursForSource(next, layerId), layerId);
    });
    setPickingCoords(null);
  }, [pickingCoords, addPointTarget]);

  const handleCancelPick = useCallback(() => setPickingCoords(null), []);

  const handleAddPolygonByLandNo = async (params: LandQueryParams): Promise<string | null> => {
    const draw = drawRef.current;
    const map = mapRef.current;
    if (!draw) return '地圖尚未就緒';
    try {
      const result = await searchLand(params);
      if (result.features.features.length === 0) {
        return `查無資料：${result.notFound[0] ?? `${params.city},${params.section},${params.parcel}`}`;
      }
      const roundCoord = (c: number[]): number[] => [
        Math.round(c[0] * 1e9) / 1e9,
        Math.round(c[1] * 1e9) / 1e9,
      ];
      const roundPolygon = (rings: number[][][]): number[][][] =>
        rings.map((ring) => ring.map(roundCoord));
      type DrawFeatures = Parameters<typeof draw.addFeatures>[0];
      type DrawFeature = DrawFeatures[number];
      type DrawProps = DrawFeature['properties'];
      const drawFeatures: DrawFeatures = [];
      for (const f of result.features.features) {
        if (!f.geometry) continue;
        const baseProps = { mode: 'polygon', ...(f.properties ?? {}) } as unknown as DrawProps;
        if (f.geometry.type === 'Polygon') {
          drawFeatures.push({
            id: crypto.randomUUID(),
            type: 'Feature',
            geometry: { type: 'Polygon', coordinates: roundPolygon(f.geometry.coordinates) },
            properties: baseProps,
          });
        } else if (f.geometry.type === 'MultiPolygon') {
          for (const polygon of f.geometry.coordinates) {
            drawFeatures.push({
              id: crypto.randomUUID(),
              type: 'Feature',
              geometry: { type: 'Polygon', coordinates: roundPolygon(polygon) },
              properties: baseProps,
            });
          }
        }
      }
      if (drawFeatures.length === 0) return '查詢結果無多邊形幾何';
      const addResult = draw.addFeatures(drawFeatures);
      const failed = addResult?.find((r) => r && r.valid === false);
      if (failed) return failed.reason ?? '幾何驗證失敗';
      const b = geometryBounds(result.features);
      if (b && map) {
        map.fitBounds(
          [[b[0], b[1]], [b[2], b[3]]],
          { padding: 80, duration: 700, maxZoom: 19 },
        );
      }
      return null;
    } catch (e) {
      return (e as Error).message;
    }
  };

  useEffect(() => {
    if (!pickingCoords && !addPointTarget) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setPickingCoords(null);
        setAddPointTarget(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pickingCoords, addPointTarget]);

  const handleClearProject = () => {
    if (!window.confirm('確定清空目前專案的內容嗎？\n圖層與繪製會被清除（專案本身會保留）。')) return;
    applyProject(null);
  };

  const handleSwitchProject = useCallback(
    async (id: number) => {
      if (id === currentProjectId) return;
      if (currentProjectId != null) {
        try {
          await saveProject(currentProjectId, buildPayload());
        } catch (e) {
          console.warn('save before switch failed', e);
        }
      }
      localStorage.setItem(CURRENT_PROJECT_KEY, String(id));
      setCurrentProjectId(id);
      const project = await loadProject(id);
      applyProject(project);
      setProjects(await listProjects());
    },
    [currentProjectId, buildPayload, applyProject],
  );

  const handleNewProject = useCallback(async (name: string) => {
    if (currentProjectId != null) {
      try {
        await saveProject(currentProjectId, buildPayload());
      } catch (e) {
        console.warn('save before new failed', e);
      }
    }
    const created = await createProject(name);
    if (!created) return;
    localStorage.setItem(CURRENT_PROJECT_KEY, String(created.id));
    setCurrentProjectId(created.id);
    applyProject(null);
    setProjectName(name);
    setProjects(await listProjects());
  }, [currentProjectId, buildPayload, applyProject]);

  // "Save As": clone the CURRENT content into a brand-new project under a new
  // name and switch to the copy. The original keeps its own name + content.
  const handleSaveAsProject = useCallback(async (name: string) => {
    if (currentProjectId != null) {
      try {
        await saveProject(currentProjectId, buildPayload());
      } catch (e) {
        console.warn('save before saveAs failed', e);
      }
    }
    const created = await createProject(name);
    if (!created) return;
    try {
      await saveProject(created.id, { ...buildPayload(), projectName: name });
    } catch (e) {
      console.warn('saveAs write failed', e);
    }
    localStorage.setItem(CURRENT_PROJECT_KEY, String(created.id));
    setCurrentProjectId(created.id);
    setProjectName(name);
    setSavedAt(new Date());
    setProjects(await listProjects());
  }, [currentProjectId, buildPayload]);

  // The delete dialog supplies the target id (current project by default, or any
  // other project picked from its dropdown). Only re-home the UI if we deleted
  // the project that's currently open.
  const handleDeleteProject = useCallback(async (id: number) => {
    await deleteProject(id);
    let list = await listProjects();
    if (list.length === 0) {
      const created = await createProject('未命名專案');
      if (created) list = [created];
    }
    setProjects(list);
    if (id !== currentProjectId) return;
    const next = list[0] ?? null;
    setCurrentProjectId(next?.id ?? null);
    if (next) {
      localStorage.setItem(CURRENT_PROJECT_KEY, String(next.id));
      applyProject(await loadProject(next.id));
      setProjectName(next.name || '未命名專案');
    } else {
      localStorage.removeItem(CURRENT_PROJECT_KEY);
      applyProject(null);
    }
  }, [currentProjectId, applyProject]);

  if (!initialized) {
    return (
      <div className="loading-screen">
        <div className="loading-text">載入專案…</div>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <LayerPanel
        basemaps={BASEMAPS}
        activeBasemap={basemapId}
        onBasemapChange={handleBasemapChange}
        basemapVersionIndex={basemapVersionIndex}
        onBasemapVersionChange={setBasemapVersionIndex}
        basemapOpacity={basemapOpacity}
        onBasemapOpacityChange={setBasemapOpacity}
        onBasemapOpacityReset={() => setBasemapOpacity(1)}
        onPan={handlePan}
        onPanReset={handlePanReset}
        projectName={
          projects.find((pr) => pr.id === currentProjectId)?.name || projectName || '未命名專案'
        }
        layers={layers}
        onUpdateLayer={updateLayer}
        onRemoveLayer={removeLayer}
        onZoomLayer={zoomToLayer}
        onReorderLayer={reorderLayer}
        onShowAttributes={toggleAttributes}
        onToggleStyle={toggleStylePopover}
        activeAttributesLayerId={attributesLayerId}
        activeStyleLayerId={stylePopoverLayerId}
        onFiles={handleFiles}
        beforeBasemap={
          <ProjectBar
            savedAt={savedAt}
            projects={projects}
            currentProjectId={currentProjectId}
            onSwitch={handleSwitchProject}
            onNew={handleNewProject}
            onSaveAs={handleSaveAsProject}
            onDelete={handleDeleteProject}
            onExport={handleExportProject}
            onImport={handleImportProject}
            onClear={handleClearProject}
          />
        }
      >
        <DrawToolbar
          activeMode={drawMode}
          featureCount={drawCount}
          onModeChange={setDrawMode}
          onDeleteSelected={handleDeleteSelected}
          onClearAll={handleClearAll}
          onExport={handleExportDraw}
          onAddPointByCoords={handleAddPointByCoords}
          onAddPolygonByLandNo={handleAddPolygonByLandNo}
        />
        <GeoOpsToolbar
          layers={layers}
          onBuffer={handleBuffer}
        />
      </LayerPanel>
      <main className="map-area">
        <MapView
          basemap={basemap}
          basemapVersionIndex={basemapVersionIndex}
          basemapOpacity={basemapOpacity}
          layers={layers}
          onMapReady={handleMapReady}
          onDrawReady={handleDrawReady}
          pickMode={!!pickingCoords || !!addPointTarget}
          onPick={handleMapPick}
          onDateLabelMove={handleDateLabelMove}
        />
        <Legend layers={layers} />
        {error && (
          <div className="toast error" onClick={() => setError(null)}>
            {error}
          </div>
        )}
      </main>
      {attributesLayerId && (() => {
        const layer = layers.find((l) => l.id === attributesLayerId);
        if (!layer) return null;
        return (
          <AttributeTable
            layer={layer}
            onClose={() => setAttributesLayerId(null)}
            onZoomFeature={zoomToFeature}
            onUpdateLayer={updateLayer}
            onAddLayer={addLayer}
            onDuplicateLayer={duplicateLayer}
            onExportLayer={exportLayerAsGeoJSON}
            pickingActive={pickingCoords?.layerId === layer.id}
            pickingFeatureIndex={pickingCoords?.layerId === layer.id ? pickingCoords.featureIndex : null}
            onStartPick={handleStartPickCoords}
            onCancelPick={handleCancelPick}
            onStartAddPointPick={handleStartAddPointPick}
            addPointPickActive={addPointTarget === layer.id}
          />
        );
      })()}
      {stylePopoverLayerId && (() => {
        const layer = layers.find((l) => l.id === stylePopoverLayerId);
        if (!layer) return null;
        const sourceLayer = layer.waterLevel?.sourceLayerId
          ? layers.find((l) => l.id === layer.waterLevel!.sourceLayerId)
          : undefined;
        return (
          <StylePopover
            layer={layer}
            sourceLayer={sourceLayer}
            onClose={() => setStylePopoverLayerId(null)}
            onUpdate={(patch) => updateLayer(layer.id, patch)}
          />
        );
      })()}
    </div>
  );
}
