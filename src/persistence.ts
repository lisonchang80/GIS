import { get, set, del } from 'idb-keyval';
import type { GeoJSONStoreFeatures } from 'terra-draw';
import type { BaseMapId, VectorLayer } from './types';

export const PROJECT_KEY = 'gis-project-v1';
export const PROJECT_VERSION = 1;

export interface MapViewState {
  center: [number, number];
  zoom: number;
  bearing?: number;
  pitch?: number;
}

export interface ProjectPayload {
  basemapId: BaseMapId;
  basemapVersionIndex?: number;
  basemapOpacity?: number;
  projectName?: string;
  layers: VectorLayer[];
  drawings?: GeoJSONStoreFeatures[];
  mapView?: MapViewState;
  colorCursor?: number;
}

export interface ProjectState extends ProjectPayload {
  version: number;
  savedAt: string;
}

export async function loadProject(): Promise<ProjectState | null> {
  try {
    const data = await get<ProjectState>(PROJECT_KEY);
    if (!data) return null;
    if (data.version !== PROJECT_VERSION) {
      console.warn(`Ignoring project with incompatible version: ${data.version}`);
      return null;
    }
    return data;
  } catch (e) {
    console.warn('loadProject failed', e);
    return null;
  }
}

export async function saveProject(payload: ProjectPayload): Promise<void> {
  const full: ProjectState = {
    ...payload,
    version: PROJECT_VERSION,
    savedAt: new Date().toISOString(),
  };
  await set(PROJECT_KEY, full);
}

export async function clearProject(): Promise<void> {
  await del(PROJECT_KEY);
}

export function downloadProject(payload: ProjectPayload): void {
  const full: ProjectState = {
    ...payload,
    version: PROJECT_VERSION,
    savedAt: new Date().toISOString(),
  };
  const blob = new Blob([JSON.stringify(full, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  a.download = `web-gis-${stamp}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

export async function importProjectFile(file: File): Promise<ProjectState> {
  const text = await file.text();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('不是有效的 JSON');
  }
  const candidate = data as Partial<ProjectState>;
  if (typeof candidate.version !== 'number' || !Array.isArray(candidate.layers)) {
    throw new Error('不是有效的 GIS 專案檔');
  }
  if (candidate.version !== PROJECT_VERSION) {
    throw new Error(`不支援的專案版本: ${candidate.version}（目前支援 v${PROJECT_VERSION}）`);
  }
  return candidate as ProjectState;
}
