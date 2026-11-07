import type { GeoJSONStoreFeatures } from 'terra-draw';
import type { BaseMapId, LayerGroup, VectorLayer } from './types';

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
  layerGroups?: LayerGroup[];
  drawings?: GeoJSONStoreFeatures[];
  mapView?: MapViewState;
  colorCursor?: number;
}

export interface ProjectState extends ProjectPayload {
  version: number;
  savedAt: string;
}

// Project storage lives on the backend (per Google-authenticated user). Each
// project has a numeric id; the cookie set at login carries the identity, so
// every call uses credentials: 'include'.

export interface ProjectMeta {
  id: number;
  name: string;
  updatedAt: string;
}

interface RawMeta {
  id: number;
  name: string;
  updated_at: string;
}

// A failed API call. `detail` is the server's message (FastAPI's {"detail": ...}),
// which for quota / conflict errors is already user-facing Chinese.
export class ApiError extends Error {
  readonly status: number;
  readonly detail?: string;
  constructor(status: number, detail?: string) {
    super(`HTTP ${status}`);
    this.name = 'ApiError';
    this.status = status;
    this.detail = detail;
  }
}

async function apiError(r: Response): Promise<ApiError> {
  let detail: string | undefined;
  try {
    const body = (await r.json()) as { detail?: unknown };
    if (typeof body?.detail === 'string') detail = body.detail;
  } catch {
    /* not JSON */
  }
  return new ApiError(r.status, detail);
}

export function isUnauthorized(e: unknown): boolean {
  return e instanceof ApiError && e.status === 401;
}

// Another tab / device saved the project after this tab loaded it (optimistic lock).
export function isConflict(e: unknown): boolean {
  return e instanceof ApiError && e.status === 409;
}

export const CONFLICT_MESSAGE = '此專案已在其他分頁或裝置更新，請重新載入。自動儲存已暫停，以免覆蓋較新的內容。';

const HAS_CJK = /[\u3400-\u9fff]/;

// User-facing text for a failed save / create (shown on screen, never only in the console).
export function saveErrorMessage(e: unknown): string {
  if (isConflict(e)) return CONFLICT_MESSAGE;
  if (e instanceof ApiError) {
    if (e.status === 401) return '登入已失效，最近的變更沒有儲存。請先「匯出」專案備份，再重新整理頁面登入。';
    if (e.detail && HAS_CJK.test(e.detail)) return e.detail;
    if (e.status === 413) {
      return '專案太大，超過單一專案的儲存上限，無法存到雲端。請刪除或簡化部分圖層（例如加大等值線間距）後再試，或先「匯出」備份。';
    }
    return `儲存失敗（HTTP ${e.status}），最近的變更尚未存到雲端。`;
  }
  return `儲存失敗（${(e as Error)?.message ?? e}），最近的變更尚未存到雲端。`;
}

function toMeta(p: RawMeta): ProjectMeta {
  return { id: p.id, name: p.name, updatedAt: p.updated_at };
}

// Throws on any failure (HTTP error, network, bad body). Only a real 200 with an
// empty list means "no projects": treating a failed fetch as empty made the app
// create a blank project and point localStorage at it.
export async function listProjects(): Promise<ProjectMeta[]> {
  const r = await fetch('/api/projects', { credentials: 'include' });
  if (!r.ok) throw await apiError(r);
  const rows = (await r.json()) as unknown;
  if (!Array.isArray(rows)) throw new Error('專案清單格式錯誤');
  return (rows as RawMeta[]).map(toMeta);
}

// Throws on failure (e.g. 413 when the per-user project quota is reached).
export async function createProject(name = '未命名專案'): Promise<ProjectMeta> {
  const r = await fetch('/api/projects', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  if (!r.ok) throw await apiError(r);
  return toMeta((await r.json()) as RawMeta);
}

// Revision (ETag) of a project as the server reported it; sent back as If-Match.
export function revisionOf(meta: ProjectMeta): string {
  return `"${meta.updatedAt}"`;
}

export interface LoadedProject {
  // null = the project exists but is still empty (204).
  project: ProjectState | null;
  // ETag of what was loaded; the next save sends it as If-Match.
  revision: string | null;
}

// Any failure throws: callers that treated a failed load as "empty" let autosave
// overwrite the stored project with a blank one.
export async function loadProject(id: number): Promise<LoadedProject> {
  const r = await fetch(`/api/projects/${id}`, { credentials: 'include', cache: 'no-store' });
  const revision = r.headers.get('ETag');
  if (r.status === 204) return { project: null, revision };
  if (!r.ok) throw await apiError(r);
  const data = (await r.json()) as ProjectState;
  if (!data || data.version !== PROJECT_VERSION) {
    throw new Error(`不支援的專案版本: ${data?.version}`);
  }
  return { project: data, revision };
}

// Browsers cap the bodies of in-flight keepalive requests at 64 KiB in total.
const KEEPALIVE_MAX_BODY = 60_000;

// revision: the ETag this edit is based on (null = unknown, save unconditionally).
// Returns the new revision. A 409 (another tab / device saved first) throws an
// ApiError that isConflict() recognises.
export async function saveProject(
  id: number,
  payload: ProjectPayload,
  revision: string | null = null,
  opts: { keepalive?: boolean } = {},
): Promise<string | null> {
  const full: ProjectState = {
    ...payload,
    version: PROJECT_VERSION,
    savedAt: new Date().toISOString(),
  };
  const body = JSON.stringify(full);
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (revision) headers['If-Match'] = revision;
  const r = await fetch(`/api/projects/${id}`, {
    method: 'PUT',
    credentials: 'include',
    headers,
    body,
    // pagehide: let a small save outlive the page; big ones can't use keepalive.
    // The limit counts bytes on the wire (UTF-8), not UTF-16 characters: Chinese text
    // is 3 bytes per character.
    keepalive:
      opts.keepalive && new TextEncoder().encode(body).byteLength <= KEEPALIVE_MAX_BODY ? true : undefined,
  });
  if (!r.ok) throw await apiError(r);
  return r.headers.get('ETag');
}

export async function deleteProject(id: number): Promise<void> {
  const r = await fetch(`/api/projects/${id}`, { method: 'DELETE', credentials: 'include' });
  if (!r.ok && r.status !== 401) throw new Error(`deleteProject failed: ${r.status}`);
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
