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

// Project storage now lives on the backend (per Google-authenticated user),
// reached via the same-origin /api/project endpoints. The cookie set at login
// carries the identity, so every call uses credentials: 'include'.

export async function loadProject(): Promise<ProjectState | null> {
  try {
    const r = await fetch('/api/project', { credentials: 'include' });
    if (r.status === 401 || r.status === 204) return null;
    if (!r.ok) {
      console.warn('loadProject failed', r.status);
      return null;
    }
    const data = (await r.json()) as ProjectState;
    if (!data || data.version !== PROJECT_VERSION) {
      if (data) console.warn(`Ignoring project with incompatible version: ${data.version}`);
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
  const r = await fetch('/api/project', {
    method: 'PUT',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(full),
  });
  if (!r.ok) throw new Error(`saveProject failed: ${r.status}`);
}

export async function clearProject(): Promise<void> {
  const r = await fetch('/api/project', { method: 'DELETE', credentials: 'include' });
  if (!r.ok && r.status !== 401) throw new Error(`clearProject failed: ${r.status}`);
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
