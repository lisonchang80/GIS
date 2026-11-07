import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Map as MLMap } from 'maplibre-gl';
import type { TerraDraw } from 'terra-draw';
import type { Feature, FeatureCollection } from 'geojson';
import { MapView } from './MapView';
import { LayerPanel } from './LayerPanel';
import { DrawToolbar, type DrawMode } from './DrawToolbar';
import { ProjectBar } from './ProjectBar';
import { startGisTour } from './webtour';
import { AttributeTable } from './AttributeTable';
import { StylePopover } from './StylePopover';
import { Iso3DViewer } from './Iso3DViewer';
import { Legend } from './Legend';
import { GeoOpsToolbar } from './GeoOpsToolbar';
import { MeasureToolbar } from './MeasureToolbar';
import { MeasureController, type MeasureMode, type MeasureResult } from './measure';
import { bufferLayer, fcToLayer, type BufferUnits } from './geoOps';
import { searchLand, type LandQueryParams } from './landQuery';
import { BASEMAPS, basemapDefaultVersionIndex } from './basemaps';
import type { BaseMapId, LayerGroup, VectorLayer } from './types';
import { SOIL_BATCH_KEY } from './types';
import { detectKind, ensureNames, fileToGeoJSON, geometryBounds } from './importers';
import { syncContoursForSource, syncSingleContour } from './contour';
import { syncExceedanceForSource } from './exceedance';
import {
  ApiError,
  createProject,
  deleteProject,
  downloadProject,
  importProjectFile,
  isConflict,
  isUnauthorized,
  listProjects,
  loadProject,
  revisionOf,
  saveErrorMessage,
  type ProjectMeta,
  type ProjectPayload,
} from './persistence';
import { ProjectSaver } from './projectSaver';
import {
  DEFAULT_BASEMAP,
  buildProjectPayload,
  prepareProject,
  sameMapView,
  type PreparedProject,
} from './projectData';
import { useAuth } from './authContext';
import './App.css';

const PALETTE = ['#ef4444', '#3b82f6', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899', '#14b8a6', '#f97316'];
const CURRENT_PROJECT_KEY = 'gis-current-project-id';
// 內容（圖層、繪圖、底圖、名稱）改了：0.5 s 後存。只有地圖視角變了：5 s 後才存
// （每次存檔都是整包專案，平移地圖不該每停一下就上傳數 MB），離開頁面時立即存。
const CONTENT_SAVE_DELAY_MS = 500;
const VIEW_SAVE_DELAY_MS = 5000;
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

function loadFailedMessage(name: string | undefined, e: unknown, stayed = false): string {
  const head = `無法載入專案「${name || '未命名專案'}」（${(e as Error).message}）。`;
  return head + (stayed ? '仍停留在目前的專案。' : '為避免覆蓋雲端資料，自動儲存已暫停，請重新整理頁面再試。');
}

function listFailedMessage(e: unknown): string {
  return `無法讀取專案清單（${(e as Error).message}）。為避免建立多餘的空白專案，自動儲存已暫停，請重新整理頁面再試。`;
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
  const [layerGroups, setLayerGroups] = useState<LayerGroup[]>([]);
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
  const [panelWidth, setPanelWidth] = useState<number>(() => {
    const saved = Number(localStorage.getItem('gis-panel-width'));
    return saved >= 280 && saved <= 720 ? saved : 320;
  });
  const [iso3DTarget, setIso3DTarget] = useState<{ layerId: string; tabId: string; subId: string } | null>(null);
  const [obstacleCapture, setObstacleCapture] = useState<{ layerId: string; tabId: string; shape: 'polygon' | 'rectangle' | 'circle' } | null>(null);
  const [measureMode, setMeasureMode] = useState<MeasureMode | null>(null);
  const [measureResult, setMeasureResult] = useState<MeasureResult | null>(null);

  // 首次登入後（App 只在 LoginGate authed 時才 mount）自動播一次功能導覽；右下 ? 可重播。
  // 等 initialized 才啟動，確保專案列 / 圖層清單 / 地圖等 DOM 都已 render。
  useEffect(() => {
    if (initialized) startGisTour();
  }, [initialized]);

  const toggleAttributes = useCallback((id: string) => {
    setAttributesLayerId((prev) => (prev === id ? null : id));
  }, []);

  const toggleStylePopover = useCallback((id: string) => {
    setStylePopoverLayerId((prev) => (prev === id ? null : id));
  }, []);

  const mapRef = useRef<MLMap | null>(null);
  const drawRef = useRef<TerraDraw | null>(null);
  const measureRef = useRef<MeasureController | null>(null);
  const colorCursor = useRef(0);
  const pendingProjectRef = useRef<PreparedProject | null>(null);
  const mapViewAppliedRef = useRef(false);
  const drawingsAppliedRef = useRef(false);

  const auth = useAuth();
  const onSessionExpiredRef = useRef(auth?.onSessionExpired);
  useLayoutEffect(() => {
    onSessionExpiredRef.current = auth?.onSessionExpired;
  });
  const sessionExpired = useCallback(() => onSessionExpiredRef.current?.(), []);

  // 存檔：同一時間只送一個 PUT，每個都帶上一次成功存檔（或載入）時的版本號（If-Match）。
  const [saver] = useState(() => new ProjectSaver());
  const [saveError, setSaveError] = useState<string | null>(null);
  // 收到 409（別的分頁／裝置已更新）的專案：停止自動存檔，直到重新載入它
  const [conflictProjectId, setConflictProjectId] = useState<number | null>(null);
  const saveTimerRef = useRef<{ handle: ReturnType<typeof setTimeout>; kind: 'content' | 'view' } | null>(null);
  const lastSavedViewRef = useRef<PreparedProject['mapView']>(undefined);
  // 剛載入專案的那一次 render 不是使用者的修改，不必存（否則另一個分頁會因此誤報衝突）
  const skipNextContentSaveRef = useRef(false);
  // 載入或上次成功存檔之後有沒有新的修改（離開專案前只在有修改時才存）
  const unsavedRef = useRef(false);

  const basemap = BASEMAPS.find((b) => b.id === basemapId) ?? BASEMAPS[0];

  const cancelPendingSave = useCallback(() => {
    const t = saveTimerRef.current;
    if (t) clearTimeout(t.handle);
    saveTimerRef.current = null;
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
    if (!pending || pending.drawings.length === 0 || !draw || drawingsAppliedRef.current) return;
    try {
      draw.addFeatures(pending.drawings);
    } catch (e) {
      console.warn('restore drawings failed', e);
    }
    drawingsAppliedRef.current = true;
    const n = draw.getSnapshot().length;
    // 還原載入時的繪圖不算修改：drawCount 若因此改變，那次 render 不觸發存檔
    setDrawCount((prev) => {
      if (prev !== n) skipNextContentSaveRef.current = true;
      return n;
    });
  }, []);

  // Apply a prepared project (see prepareProject: everything that can throw has
  // already run, so this only sets state). `loaded` = it is what the server has
  // (switch / bootstrap / new): don't save it straight back.
  const applyProject = useCallback((p: PreparedProject, opts: { loaded?: boolean } = {}) => {
    if (opts.loaded) {
      cancelPendingSave();
      skipNextContentSaveRef.current = true;
      lastSavedViewRef.current = p.mapView;
      unsavedRef.current = false;
      setConflictProjectId(null);
      setSaveError(null);
    }
    setBasemapId(p.basemapId);
    setBasemapVersionIndex(p.basemapVersionIndex);
    setBasemapOpacity(p.basemapOpacity);
    setProjectName(p.projectName);
    setLayers(p.layers);
    setLayerGroups(p.layerGroups);
    colorCursor.current = p.colorCursor;
    setSavedAt(p.savedAt);
    setAttributesLayerId(null);
    setStylePopoverLayerId(null);
    setPickingCoords(null);
    setAddPointTarget(null);
    setDrawMode('static');
    measureRef.current?.deactivate();
    setMeasureMode(null);
    pendingProjectRef.current = p;
    mapViewAppliedRef.current = false;
    drawingsAppliedRef.current = false;
    const draw = drawRef.current;
    if (draw) {
      try {
        draw.clear();
      } catch {
        /* noop */
      }
      if (p.drawings.length > 0) {
        try {
          draw.addFeatures(p.drawings);
        } catch (e) {
          console.warn('apply drawings failed', e);
        }
      }
      drawingsAppliedRef.current = true;
      setDrawCount(draw.getSnapshot().length);
    }
    const map = mapRef.current;
    if (map && p.mapView) {
      map.jumpTo({ center: p.mapView.center, zoom: p.mapView.zoom });
      mapViewAppliedRef.current = true;
    }
  }, [cancelPendingSave]);

  // 操作途中收到 401（登入失效）：畫面上還有沒存進雲端的修改時，不回登入畫面
  // （LoginGate 會卸掉整個 App，修改就沒了），改成留在原畫面提示先匯出備份；
  // 沒有未存的修改才回登入畫面。
  // 畫面上有沒有還沒存進雲端的東西：內容修改／存檔失敗，或排著的視角存檔且視角真的變了
  const hasUnsavedChanges = useCallback((): boolean => {
    if (unsavedRef.current) return true;
    const pending = saveTimerRef.current;
    if (!pending) return false;
    if (pending.kind === 'content') return true;
    const map = mapRef.current;
    if (!map) return false;
    const view = { center: [map.getCenter().lng, map.getCenter().lat] as [number, number], zoom: map.getZoom() };
    return !sameMapView(view, lastSavedViewRef.current);
  }, []);

  const onUnauthorized = useCallback(() => {
    if (hasUnsavedChanges()) {
      const message = saveErrorMessage(new ApiError(401));
      setSaveError(message);
      setError(message);
      return;
    }
    sessionExpired();
  }, [sessionExpired, hasUnsavedChanges]);

  const refreshProjects = useCallback(async () => {
    try {
      setProjects(await listProjects());
    } catch (e) {
      if (isUnauthorized(e)) {
        onUnauthorized();
        return;
      }
      console.warn('listProjects failed', e);
      setError(`無法更新專案清單（${(e as Error).message}），顯示的是先前的清單。`);
    }
  }, [onUnauthorized]);

  useEffect(() => {
    (async () => {
      let list: ProjectMeta[] = [];
      let chosen: ProjectMeta | null = null;
      try {
        list = await listProjects();
        // 只有伺服器確實回了空清單（200 []）才自動建一個；讀取失敗會在上面就丟例外
        if (list.length === 0) list = [await createProject('未命名專案')];
        const savedId = Number(localStorage.getItem(CURRENT_PROJECT_KEY));
        chosen = list.find((p) => p.id === savedId) ?? list[0];
        const loaded = await loadProject(chosen.id);
        // 全部準備好（可能丟例外）才開始改狀態
        const prepared = prepareProject(loaded.project);
        saver.setRevision(chosen.id, loaded.revision);
        applyProject(prepared, { loaded: true });
        setCurrentProjectId(chosen.id);
        localStorage.setItem(CURRENT_PROJECT_KEY, String(chosen.id));
      } catch (e) {
        if (isUnauthorized(e)) {
          sessionExpired();
          return;
        }
        // currentProjectId 維持 null → 自動存檔不會啟動，雲端專案不會被空白畫面覆蓋
        console.warn('initial project load failed', e);
        applyProject(prepareProject(null));
        setError(chosen ? loadFailedMessage(chosen.name, e) : listFailedMessage(e));
      } finally {
        setProjects(list);
        setInitialized(true);
      }
    })();
  }, [applyProject, saver, sessionExpired]);

  const buildPayload = useCallback((): ProjectPayload => {
    const draw = drawRef.current;
    const map = mapRef.current;
    return buildProjectPayload(
      { basemapId, basemapVersionIndex, basemapOpacity, projectName, layers, layerGroups, colorCursor: colorCursor.current },
      {
        drawings: draw ? draw.getSnapshot() : null,
        mapView: map
          ? { center: [map.getCenter().lng, map.getCenter().lat] as [number, number], zoom: map.getZoom() }
          : null,
      },
      pendingProjectRef.current,
    );
  }, [basemapId, basemapVersionIndex, basemapOpacity, projectName, layers, layerGroups]);

  // Latest values for the save timer / page-hide handler, which outlive renders.
  const buildPayloadRef = useRef(buildPayload);
  const currentProjectIdRef = useRef(currentProjectId);
  const conflictProjectIdRef = useRef(conflictProjectId);
  const initializedRef = useRef(initialized);
  useLayoutEffect(() => {
    buildPayloadRef.current = buildPayload;
    currentProjectIdRef.current = currentProjectId;
    conflictProjectIdRef.current = conflictProjectId;
    initializedRef.current = initialized;
  });

  // Save now through the queue. Never throws: failures are put on screen.
  const saveNow = useCallback(
    async (
      pid: number,
      payload: ProjectPayload,
      opts: { keepalive?: boolean } = {},
    ): Promise<{ ok: true } | { ok: false; message: string; unauthorized: boolean }> => {
      try {
        await saver.save(pid, payload, opts);
      } catch (caught) {
        console.warn('saveProject failed', caught);
        let e = caught;
        if (!(e instanceof ApiError) || e.status === 0 || e.status >= 500) {
          // 伺服器在收完整包專案前就回 401（登入失效）時，瀏覽器常只看到「連線被重設」，
          // 中間經過 proxy（vite、cloudflared）則常變成 502：再問一次 /api/me 才知道真正原因
          try {
            if ((await fetch('/api/me', { credentials: 'include' })).status === 401) e = new ApiError(401);
          } catch {
            /* 真的斷線 */
          }
        }
        const message = saveErrorMessage(e);
        if (pid === currentProjectIdRef.current) unsavedRef.current = true; // 包括只動視角的那次
        if (isConflict(e)) setConflictProjectId(pid);
        setSaveError(message);
        // 衝突、超過上限、登入失效：跳出提示（斷線只在專案列顯示，下次修改會再試）
        if (e instanceof ApiError) setError(message);
        return { ok: false, message, unauthorized: isUnauthorized(e) };
      }
      if (pid === currentProjectIdRef.current) {
        setSavedAt(new Date());
        setSaveError(null);
        lastSavedViewRef.current = payload.mapView;
        // 存檔途中又有修改的話，計時器會再排一次存檔，仍算未儲存
        if (!saveTimerRef.current) unsavedRef.current = false;
      }
      setProjects((prev) => prev.map((p) => (p.id === pid ? { ...p, name: payload.projectName || p.name } : p)));
      return { ok: true };
    },
    [saver],
  );

  const flushSave = useCallback(
    (kind: 'content' | 'view', opts: { keepalive?: boolean } = {}) => {
      cancelPendingSave();
      const pid = currentProjectIdRef.current;
      if (!initializedRef.current || pid == null || conflictProjectIdRef.current === pid) return;
      const payload = buildPayloadRef.current();
      // 只有視角變動、而且其實沒移動（視窗縮放、jumpTo 到存好的視角）：不上傳
      if (kind === 'view' && sameMapView(payload.mapView, lastSavedViewRef.current)) return;
      void saveNow(pid, payload, opts);
    },
    [cancelPendingSave, saveNow],
  );

  const scheduleSave = useCallback(
    (kind: 'content' | 'view') => {
      const pending = saveTimerRef.current;
      // 已經排了 0.5 s 後的整包存檔（會順便帶上目前視角）：不必再排較晚的
      if (kind === 'view' && pending?.kind === 'content') return;
      if (pending) clearTimeout(pending.handle);
      const handle = setTimeout(
        () => {
          saveTimerRef.current = null;
          flushSave(kind);
        },
        kind === 'content' ? CONTENT_SAVE_DELAY_MS : VIEW_SAVE_DELAY_MS,
      );
      saveTimerRef.current = { handle, kind };
      // 內容修改才標成未儲存；只動視角時，排著的計時器本身就代表「還沒存」，
      // 計時器到了卻發現視角其實沒變（例如載入後的 jumpTo）就沒有東西要存
      if (kind === 'content') unsavedRef.current = true;
    },
    [flushSave],
  );

  const handleMapReady = useCallback(
    (map: MLMap) => {
      mapRef.current = map;
      measureRef.current = new MeasureController(map, setMeasureResult);
      map.on('moveend', () => setMapMoveTick((t) => t + 1));
      applyPendingMapView();
    },
    [applyPendingMapView],
  );

  const handleSelectMeasure = useCallback(
    (mode: MeasureMode | null) => {
      const ctrl = measureRef.current;
      if (!ctrl) return;
      if (!mode || mode === measureMode) {
        ctrl.deactivate();
        setMeasureMode(null);
        return;
      }
      setDrawMode('static'); // 量測與繪圖互斥
      ctrl.start(mode);
      setMeasureMode(mode);
    },
    [measureMode],
  );

  const handleClearMeasure = useCallback(() => {
    measureRef.current?.clearCurrent();
  }, []);

  // 選了任何繪圖工具就自動關掉量測，避免兩套點擊行為打架
  useEffect(() => {
    if (drawMode !== 'static' && measureRef.current?.getMode()) {
      measureRef.current.deactivate();
      setMeasureMode(null);
    }
  }, [drawMode]);

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

  // 障礙物擷取：使用者按「新增障礙物(形狀)」→ 進入該繪製模式；畫完(finish)抓幾何寫進該分頁。
  const handleDrawObstacle = useCallback(
    (layerId: string, tabId: string, shape: 'polygon' | 'rectangle' | 'circle') => {
      setObstacleCapture({ layerId, tabId, shape });
      setDrawMode(shape as DrawMode);
    },
    [],
  );

  useEffect(() => {
    const draw = drawRef.current;
    if (!draw || !obstacleCapture) return;
    const onFinish = (id: string | number) => {
      const feat = draw.getSnapshot().find((f) => f.id === id);
      const geom = feat?.geometry;
      if (geom && geom.type === 'Polygon') {
        const cap = obstacleCapture;
        setLayers((prev) =>
          prev.map((l) => {
            if (l.id !== cap.layerId) return l;
            const tabs = (l.soilSurveyTabs ?? []).map((t) => {
              if (t.id !== cap.tabId) return t;
              const ob = {
                id: crypto.randomUUID(),
                shape: cap.shape,
                geometry: JSON.parse(JSON.stringify(geom)) as typeof geom,
                depthTop: 0,
                depthBottom: t.maxDepth ?? 4,
                enabled: true,
              };
              return { ...t, obstacles: [...(t.obstacles ?? []), ob] };
            });
            return { ...l, soilSurveyTabs: tabs };
          }),
        );
      }
      try { draw.removeFeatures([id]); } catch { /* noop */ }
      setObstacleCapture(null);
      setDrawMode('static');
    };
    draw.on('finish', onFinish);
    return () => {
      try { draw.off('finish', onFinish); } catch { /* noop */ }
    };
  }, [obstacleCapture]);

  const activeObstacles = useMemo(() => {
    if (!attributesLayerId) return [];
    const l = layers.find((x) => x.id === attributesLayerId);
    return (l?.soilSurveyTabs ?? []).flatMap((t) => t.obstacles ?? []);
  }, [attributesLayerId, layers]);

  // 內容變了（buildPayload 依賴的狀態、繪圖數）：0.5 s 後整包存檔
  useEffect(() => {
    if (!initialized || currentProjectId == null) return;
    if (skipNextContentSaveRef.current) {
      skipNextContentSaveRef.current = false;
      return;
    }
    scheduleSave('content');
  }, [initialized, currentProjectId, buildPayload, drawCount, scheduleSave]);

  // 只有地圖視角變了（moveend，也包括視窗縮放）：等 5 s 沒再動才存
  useEffect(() => {
    if (mapMoveTick === 0) return;
    scheduleSave('view');
  }, [mapMoveTick, scheduleSave]);

  // 切到別的分頁、關掉或離開頁面：還沒送出的存檔立即送出
  useEffect(() => {
    const flushPending = () => {
      const pending = saveTimerRef.current;
      if (pending) flushSave(pending.kind, { keepalive: true });
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') flushPending();
    };
    window.addEventListener('pagehide', flushPending);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('pagehide', flushPending);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [flushSave]);

  useEffect(() => cancelPendingSave, [cancelPendingSave]);

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
      if ('data' in patch || 'gwConcTabs' in patch || 'soilConcTabs' in patch || 'soilSurveyTabs' in patch) {
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
    setLayers((prev) => {
      const next = [layer, ...prev];
      // 新增的等值線/等水位線圖層：立即依其 waterLevel 設定重建一次。否則生成當下
      // 不會帶填色 plan（漸層/自訂範圍 bands），要等使用者改一次樣式才出現。
      if (layer.waterLevel?.sourceLayerId) {
        return syncSingleContour(next, layer.id);
      }
      return next;
    });
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
      // 拖到某圖層旁邊時，繼承目標列的群組歸屬：拖進群組成員之間 = 加入該群組；
      // 拖到未分組列旁 = 離開群組。因為一定緊貼目標插入，群組成員的連續性得以維持。
      const target = prev[toIdx];
      const withGroup = moved.groupId === target.groupId ? moved : { ...moved, groupId: target.groupId };
      let insertAt = next.findIndex((l) => l.id === targetId);
      if (position === 'below') insertAt += 1;
      next.splice(insertAt, 0, withGroup);
      return next;
    });
  }, []);

  // 群組管理 --------------------------------------------------------------
  const createLayerGroup = useCallback(() => {
    setLayerGroups((prev) => {
      const n = prev.length + 1;
      const group: LayerGroup = {
        id: `grp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        name: `群組 ${n}`,
      };
      return [...prev, group];
    });
  }, []);

  const renameLayerGroup = useCallback((groupId: string, name: string) => {
    setLayerGroups((prev) => prev.map((g) => (g.id === groupId ? { ...g, name } : g)));
  }, []);

  const toggleLayerGroupCollapse = useCallback((groupId: string) => {
    setLayerGroups((prev) => prev.map((g) => (g.id === groupId ? { ...g, collapsed: !g.collapsed } : g)));
  }, []);

  // 群組的勾選框：全開才算勾選；點一下 → 全部同步為（原本非全開就全開，全開就全關）
  const toggleLayerGroupVisibility = useCallback((groupId: string) => {
    setLayers((prev) => {
      const members = prev.filter((l) => l.groupId === groupId);
      if (members.length === 0) return prev;
      const allVisible = members.every((l) => l.visible);
      const nextVisible = !allVisible;
      return prev.map((l) => (l.groupId === groupId ? { ...l, visible: nextVisible } : l));
    });
  }, []);

  // 解散群組：成員全部變回未分組，圖層本身保留
  const removeLayerGroup = useCallback((groupId: string) => {
    setLayers((prev) => prev.map((l) => (l.groupId === groupId ? { ...l, groupId: undefined } : l)));
    setLayerGroups((prev) => prev.filter((g) => g.id !== groupId));
  }, []);

  // 把某圖層指派進群組（拖到群組標題）或移出（groupId=null）
  const assignLayerToGroup = useCallback((layerId: string, groupId: string | null) => {
    setLayers((prev) => {
      const fromIdx = prev.findIndex((l) => l.id === layerId);
      if (fromIdx === -1) return prev;
      const moved = { ...prev[fromIdx], groupId: groupId ?? undefined };
      const rest = prev.slice();
      rest.splice(fromIdx, 1);
      let insertAt: number;
      if (groupId) {
        // 插到該群組現有成員區塊的最前面（若空群組則放到最上方）
        const firstMember = rest.findIndex((l) => l.groupId === groupId);
        insertAt = firstMember === -1 ? 0 : firstMember;
      } else {
        insertAt = 0; // 移出群組 → 放到最上方（未分組）
      }
      rest.splice(insertAt, 0, moved);
      return rest;
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
      // 先整份準備好（壞檔在這裡就丟例外），確認後才改狀態：否則底圖／名稱先套用、
      // 圖層沒換，自動存檔會把目前專案改名
      const prepared = prepareProject(await importProjectFile(file));
      if (
        !window.confirm(
          `匯入會取代目前專案「${projectName || '未命名專案'}」的全部內容（圖層、繪圖、底圖與名稱），確定？`,
        )
      ) return;
      applyProject(prepared);
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
          if ((l.soilSurveyTabs?.length ?? 0) > 0) props['高程'] = 0;
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
    applyProject(prepareProject(null));
  };

  // 離開目前專案（切換／新增）前先存檔。存不進去（超過上限、斷線、登入失效）時
  // 讓使用者決定：留下來（預設），或放棄未儲存的變更繼續。衝突中的專案不存
  // （伺服器上已是別處較新的版本，使用者也已被提示要重新載入）。沒有修改就不存
  // （白白換掉版本號，會讓同時開著這個專案的其他分頁誤報衝突）。
  const saveBeforeLeaving = useCallback(async (): Promise<boolean> => {
    const pid = currentProjectId;
    const unsaved = hasUnsavedChanges();
    cancelPendingSave();
    if (pid == null || conflictProjectId === pid || !unsaved) return true;
    const r = await saveNow(pid, buildPayload());
    if (r.ok) return true;
    // 登入失效：離開也只會在下一步 401，而回登入畫面會丟掉這些修改 → 留在原畫面
    if (r.unauthorized) return false;
    return window.confirm(`${r.message}\n\n仍要離開目前的專案，放棄還沒儲存的變更嗎？`);
  }, [currentProjectId, conflictProjectId, hasUnsavedChanges, cancelPendingSave, saveNow, buildPayload]);

  const handleSwitchProject = useCallback(
    async (id: number) => {
      if (id === currentProjectId) return;
      if (!(await saveBeforeLeaving())) return;
      // 先載入並準備好（可能丟例外），再於同一個 tick 切換 id 與內容：若先
      // setCurrentProjectId，載入期間的自動存檔會把「舊專案的內容」寫進新專案的 id；
      // 若準備（重建衍生圖層）在 setState 之後才丟例外，也會留下同樣的混合狀態。
      let loaded: Awaited<ReturnType<typeof loadProject>>;
      let prepared: PreparedProject;
      try {
        loaded = await loadProject(id);
        prepared = prepareProject(loaded.project);
      } catch (e) {
        if (isUnauthorized(e)) {
          onUnauthorized();
          return;
        }
        console.warn('loadProject failed', e);
        setError(loadFailedMessage(projects.find((p) => p.id === id)?.name, e, currentProjectId != null));
        return; // 留在目前的專案
      }
      setError(null);
      localStorage.setItem(CURRENT_PROJECT_KEY, String(id));
      saver.setRevision(id, loaded.revision);
      setCurrentProjectId(id);
      applyProject(prepared, { loaded: true });
      await refreshProjects();
    },
    [currentProjectId, saveBeforeLeaving, applyProject, projects, saver, onUnauthorized, refreshProjects],
  );

  const handleNewProject = useCallback(async (name: string) => {
    if (!(await saveBeforeLeaving())) return;
    let created: ProjectMeta;
    try {
      created = await createProject(name);
    } catch (e) {
      if (isUnauthorized(e)) {
        onUnauthorized();
        return;
      }
      console.warn('createProject failed', e);
      setError(`無法新增專案：${saveErrorMessage(e)}`);
      return;
    }
    setError(null);
    localStorage.setItem(CURRENT_PROJECT_KEY, String(created.id));
    saver.setRevision(created.id, revisionOf(created));
    setCurrentProjectId(created.id);
    applyProject(prepareProject(null), { loaded: true });
    setProjectName(name);
    await refreshProjects();
  }, [saveBeforeLeaving, applyProject, saver, onUnauthorized, refreshProjects]);

  // "Save As": clone the CURRENT content into a brand-new project under a new
  // name and switch to the copy. The original keeps its own name + content.
  // (Also the way out of a conflict: keep this tab's version as a new project.)
  const handleSaveAsProject = useCallback(async (name: string) => {
    const unsaved = hasUnsavedChanges();
    cancelPendingSave();
    if (currentProjectId != null && conflictProjectId !== currentProjectId && unsaved) {
      // 原專案存不進去也照樣另存：內容會在新專案裡。登入失效例外：另存一樣會 401，
      // 留在原畫面（saveNow 已提示先匯出備份），不回登入畫面丟掉修改
      const r = await saveNow(currentProjectId, buildPayload());
      if (!r.ok && r.unauthorized) return;
    }
    let created: ProjectMeta;
    try {
      created = await createProject(name);
    } catch (e) {
      if (isUnauthorized(e)) {
        onUnauthorized();
        return;
      }
      console.warn('createProject failed', e);
      setError(`無法另存新專案：${saveErrorMessage(e)}`);
      return;
    }
    saver.setRevision(created.id, revisionOf(created));
    const r = await saveNow(created.id, { ...buildPayload(), projectName: name });
    localStorage.setItem(CURRENT_PROJECT_KEY, String(created.id));
    setCurrentProjectId(created.id);
    setConflictProjectId(null);
    setProjectName(name);
    if (r.ok) {
      skipNextContentSaveRef.current = true; // 剛存好的內容，不必再存一次
      unsavedRef.current = false;
      setSavedAt(new Date());
      setSaveError(null);
    } else {
      setError(`已建立「${name}」，但內容沒有存進去：${r.message}`);
    }
    await refreshProjects();
  }, [currentProjectId, conflictProjectId, hasUnsavedChanges, cancelPendingSave, saveNow, buildPayload, saver, onUnauthorized, refreshProjects]);

  // The delete dialog supplies the target id (current project by default, or any
  // other project picked from its dropdown). Only re-home the UI if we deleted
  // the project that's currently open.
  const handleDeleteProject = useCallback(async (id: number) => {
    const deletingCurrent = id === currentProjectId;
    if (deletingCurrent) cancelPendingSave(); // 不要再對已刪除的專案送存檔
    try {
      await deleteProject(id);
    } catch (e) {
      console.warn('deleteProject failed', e);
      setError(`刪除失敗（${(e as Error).message}），專案沒有被刪除。`);
      return;
    }
    let list: ProjectMeta[];
    try {
      list = await listProjects();
      // 只有伺服器確實回了空清單才自動建一個
      if (list.length === 0) list = [await createProject('未命名專案')];
    } catch (e) {
      if (isUnauthorized(e)) {
        onUnauthorized();
        return;
      }
      console.warn('refresh after delete failed', e);
      // 讀不到清單：沿用畫面上的舊清單（扣掉剛刪的），不自動新建空白專案
      list = projects.filter((p) => p.id !== id);
      setError(`專案已刪除，但無法更新專案清單（${(e as Error).message}）。`);
    }
    setProjects(list);
    if (!deletingCurrent) return;
    const next = list[0] ?? null;
    if (next) {
      // 同 handleSwitchProject：內容載入並準備好後才把 id 指過去，避免把已刪專案的內容存進 next
      let loaded: Awaited<ReturnType<typeof loadProject>>;
      let prepared: PreparedProject;
      try {
        loaded = await loadProject(next.id);
        prepared = prepareProject(loaded.project);
      } catch (e) {
        if (isUnauthorized(e)) {
          onUnauthorized();
          return;
        }
        console.warn('loadProject failed', e);
        setCurrentProjectId(null); // 暫停自動存檔，不覆蓋 next
        applyProject(prepareProject(null));
        setError(loadFailedMessage(next.name, e));
        return;
      }
      localStorage.setItem(CURRENT_PROJECT_KEY, String(next.id));
      saver.setRevision(next.id, loaded.revision);
      setCurrentProjectId(next.id);
      applyProject(prepared, { loaded: true });
      setProjectName(next.name || '未命名專案');
    } else {
      setCurrentProjectId(null);
      localStorage.removeItem(CURRENT_PROJECT_KEY);
      applyProject(prepareProject(null));
    }
  }, [currentProjectId, cancelPendingSave, applyProject, projects, saver, onUnauthorized]);

  const startPanelResize = (e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = panelWidth;
    let latest = startW;
    const onMove = (ev: PointerEvent) => {
      latest = Math.max(280, Math.min(720, startW + (ev.clientX - startX)));
      setPanelWidth(latest);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      document.body.classList.remove('resizing-x');
      localStorage.setItem('gis-panel-width', String(latest));
    };
    document.body.classList.add('resizing-x');
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  if (!initialized) {
    return (
      <div className="loading-screen">
        <div className="loading-text">載入專案…</div>
      </div>
    );
  }

  return (
    <div className="app-shell" style={{ '--panel-width': `${panelWidth}px` } as React.CSSProperties}>
      <div className="rotate-gate" role="alert">
        <div className="rotate-gate-icon" aria-hidden>⟳</div>
        <div className="rotate-gate-title">請將手機轉為橫向</div>
        <div className="rotate-gate-sub">本地圖工作台需要較寬的畫面，橫向操作較順手</div>
      </div>
      <LayerPanel
        width={panelWidth}
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
        layerGroups={layerGroups}
        onUpdateLayer={updateLayer}
        onRemoveLayer={removeLayer}
        onZoomLayer={zoomToLayer}
        onReorderLayer={reorderLayer}
        onCreateGroup={createLayerGroup}
        onRenameGroup={renameLayerGroup}
        onToggleGroupCollapse={toggleLayerGroupCollapse}
        onToggleGroupVisibility={toggleLayerGroupVisibility}
        onRemoveGroup={removeLayerGroup}
        onAssignToGroup={assignLayerToGroup}
        onShowAttributes={toggleAttributes}
        onToggleStyle={toggleStylePopover}
        onOpen3D={(layerId) => {
          const wl = layers.find((l) => l.id === layerId)?.waterLevel;
          if (wl?.sourceKind === 'soil-survey' && wl.sourceLayerId && wl.sourceTabId && wl.sourceSubId) {
            setIso3DTarget({ layerId: wl.sourceLayerId, tabId: wl.sourceTabId, subId: wl.sourceSubId });
          }
        }}
        activeAttributesLayerId={attributesLayerId}
        activeStyleLayerId={stylePopoverLayerId}
        onFiles={handleFiles}
        beforeBasemap={
          <ProjectBar
            savedAt={savedAt}
            saveError={saveError}
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
        <MeasureToolbar
          activeMode={measureMode}
          result={measureResult}
          onSelect={handleSelectMeasure}
          onClear={handleClearMeasure}
        />
        <GeoOpsToolbar
          layers={layers}
          onBuffer={handleBuffer}
        />
      </LayerPanel>
      <div
        className="panel-resize-handle"
        onPointerDown={startPanelResize}
        title="拖曳調整側欄寬度"
        role="separator"
        aria-orientation="vertical"
      />
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
          obstacles={activeObstacles}
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
            onOpen3D={(layerId, tabId, subId) => setIso3DTarget({ layerId, tabId, subId })}
            onDrawObstacle={handleDrawObstacle}
          />
        );
      })()}
      {iso3DTarget && (() => {
        const layer = layers.find((l) => l.id === iso3DTarget.layerId);
        const tab = layer?.soilSurveyTabs?.find((t) => t.id === iso3DTarget.tabId);
        if (!layer || !tab) return null;
        return (
          <Iso3DViewer
            layer={layer}
            tab={tab}
            subId={iso3DTarget.subId}
            onClose={() => setIso3DTarget(null)}
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
