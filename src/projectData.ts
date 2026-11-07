import type { GeoJSONStoreFeatures } from 'terra-draw';
import { BASEMAPS, basemapDefaultVersionIndex } from './basemaps';
import { syncAllContours } from './contour';
import { syncAllExceedance } from './exceedance';
import { ensureNames } from './importers';
import type { MapViewState, ProjectPayload, ProjectState } from './persistence';
import type { BaseMapId, LayerGroup, VectorLayer } from './types';

export const DEFAULT_BASEMAP: BaseMapId = 'satellite-google';
export const DEFAULT_PROJECT_NAME = '未命名專案';

// Everything App needs to show a project, computed up front. Building this can
// throw (malformed data, a derived-layer rebuild that blows up); only once it
// succeeded does App start calling setState, so a failure can't leave a mix of
// the new project's id / name and the old project's layers for autosave to write.
export interface PreparedProject {
  source: ProjectState | null; // null = empty project
  basemapId: BaseMapId;
  basemapVersionIndex: number;
  basemapOpacity: number;
  projectName: string;
  layers: VectorLayer[];
  layerGroups: LayerGroup[];
  colorCursor: number;
  savedAt: Date | null;
  drawings: GeoJSONStoreFeatures[];
  mapView?: MapViewState;
}

function fail(what: string): never {
  throw new Error(`專案資料格式錯誤：${what}`);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function validMapView(v: unknown): MapViewState | undefined {
  if (!isObject(v)) return undefined;
  const c = v.center;
  if (!Array.isArray(c) || c.length < 2 || !c.slice(0, 2).every((n) => typeof n === 'number' && Number.isFinite(n))) {
    return undefined;
  }
  if (typeof v.zoom !== 'number' || !Number.isFinite(v.zoom)) return undefined;
  const out: MapViewState = { center: [c[0] as number, c[1] as number], zoom: v.zoom };
  if (typeof v.bearing === 'number' && Number.isFinite(v.bearing)) out.bearing = v.bearing;
  if (typeof v.pitch === 'number' && Number.isFinite(v.pitch)) out.pitch = v.pitch;
  return out;
}

function defaultVersionIndex(id: BaseMapId): number {
  const base = BASEMAPS.find((b) => b.id === id);
  return base ? basemapDefaultVersionIndex(base) : 0;
}

// Pure: never mutates `project`, never touches React state. Throws on bad data.
export function prepareProject(project: ProjectState | null): PreparedProject {
  if (project === null) {
    return {
      source: null,
      basemapId: DEFAULT_BASEMAP,
      basemapVersionIndex: defaultVersionIndex(DEFAULT_BASEMAP),
      basemapOpacity: 1,
      projectName: DEFAULT_PROJECT_NAME,
      layers: [],
      layerGroups: [],
      colorCursor: 0,
      savedAt: null,
      drawings: [],
    };
  }
  if (!isObject(project)) fail('不是物件');
  if (!Array.isArray(project.layers)) fail('缺少 layers 陣列');
  project.layers.forEach((l, i) => {
    if (!isObject(l)) fail(`第 ${i + 1} 個圖層不是物件`);
    const data = (l as unknown as Record<string, unknown>).data;
    if (!isObject(data) || !Array.isArray(data.features)) {
      fail(`圖層「${String((l as { name?: unknown }).name ?? i + 1)}」缺少 data.features 陣列`);
    }
    (data.features as unknown[]).forEach((f, j) => {
      if (!isObject(f)) fail(`圖層「${String((l as { name?: unknown }).name ?? i + 1)}」的第 ${j + 1} 個圖徵不是物件`);
    });
  });
  if (project.layerGroups !== undefined && !Array.isArray(project.layerGroups)) fail('layerGroups 不是陣列');
  if (project.drawings !== undefined && !Array.isArray(project.drawings)) fail('drawings 不是陣列');

  const known = BASEMAPS.some((b) => b.id === project.basemapId);
  const basemapId: BaseMapId = known ? project.basemapId : DEFAULT_BASEMAP;
  const versionIndex =
    known && typeof project.basemapVersionIndex === 'number' && Number.isInteger(project.basemapVersionIndex)
      ? project.basemapVersionIndex
      : defaultVersionIndex(basemapId);
  const opacity =
    typeof project.basemapOpacity === 'number' && Number.isFinite(project.basemapOpacity) ? project.basemapOpacity : 1;
  const savedAt = typeof project.savedAt === 'string' && project.savedAt ? new Date(project.savedAt) : null;

  // The derived layers (contours / exceedance points) are rebuilt from their
  // sources; this is the step that has thrown in production before.
  const layers = syncAllExceedance(syncAllContours(project.layers.map((l) => ({ ...l, data: ensureNames(l.data) }))));

  return {
    source: project,
    basemapId,
    basemapVersionIndex: versionIndex,
    basemapOpacity: opacity,
    projectName: typeof project.projectName === 'string' && project.projectName ? project.projectName : DEFAULT_PROJECT_NAME,
    layers,
    layerGroups: project.layerGroups ?? [],
    colorCursor: typeof project.colorCursor === 'number' && Number.isFinite(project.colorCursor) ? project.colorCursor : 0,
    savedAt: savedAt && !Number.isNaN(savedAt.getTime()) ? savedAt : null,
    drawings: project.drawings ?? [],
    mapView: validMapView(project.mapView),
  };
}

export interface PayloadState {
  basemapId: BaseMapId;
  basemapVersionIndex: number;
  basemapOpacity: number;
  projectName: string;
  layers: VectorLayer[];
  layerGroups: LayerGroup[];
  colorCursor: number;
}

// What the save sends. `live` is null for parts whose widget isn't ready yet:
// the map / draw tool only become ready after maplibre 'load' (all base tiles in),
// and until then the loaded project's drawings / view are kept, otherwise the
// first autosave would store them as empty (tiles that hang never fire 'load').
export function buildProjectPayload(
  state: PayloadState,
  live: { drawings: GeoJSONStoreFeatures[] | null; mapView: MapViewState | null },
  pending: PreparedProject | null,
): ProjectPayload {
  return {
    basemapId: state.basemapId,
    basemapVersionIndex: state.basemapVersionIndex,
    basemapOpacity: state.basemapOpacity,
    projectName: state.projectName,
    layers: state.layers,
    layerGroups: state.layerGroups,
    drawings: live.drawings ?? pending?.drawings ?? [],
    mapView: live.mapView ?? pending?.mapView,
    colorCursor: state.colorCursor,
  };
}

// Same view (within ~1 cm / a hair of zoom): a moveend that didn't really move
// the map (resize, jumpTo to the saved view) shouldn't upload the whole project.
export function sameMapView(a: MapViewState | undefined, b: MapViewState | undefined): boolean {
  if (!a || !b) return false;
  return (
    Math.abs(a.center[0] - b.center[0]) < 1e-7 &&
    Math.abs(a.center[1] - b.center[1]) < 1e-7 &&
    Math.abs(a.zoom - b.zoom) < 1e-6
  );
}
