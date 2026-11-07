import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ApiError,
  createProject,
  isConflict,
  isUnauthorized,
  listProjects,
  loadProject,
  saveErrorMessage,
  saveProject,
  type ProjectPayload,
} from './persistence';

function mockFetch(impl: (url: string, init?: RequestInit) => Promise<Response>) {
  const fn = vi.fn(impl);
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const PAYLOAD: ProjectPayload = { basemapId: 'osm', layers: [] };

describe('loadProject', () => {
  it('returns null only for an existing-but-empty project (204), with its revision', async () => {
    mockFetch(async () => new Response(null, { status: 204, headers: { ETag: '"r0"' } }));
    await expect(loadProject(1)).resolves.toEqual({ project: null, revision: '"r0"' });
  });

  it('returns the stored project and its ETag', async () => {
    const project = { version: 1, basemapId: 'osm', layers: [], savedAt: '' };
    mockFetch(async () => Response.json(project, { headers: { ETag: '"r1"' } }));
    await expect(loadProject(1)).resolves.toEqual({ project, revision: '"r1"' });
  });

  // 這些失敗若被當成「空專案」，自動存檔就會把雲端的專案覆蓋成空白
  it.each([401, 404, 500, 502, 524])('throws on HTTP %i instead of treating it as empty', async (status) => {
    mockFetch(async () => new Response('error', { status }));
    await expect(loadProject(1)).rejects.toThrow(`HTTP ${status}`);
  });

  it('throws on network failure', async () => {
    mockFetch(async () => {
      throw new TypeError('Failed to fetch');
    });
    await expect(loadProject(1)).rejects.toThrow('Failed to fetch');
  });

  it('throws on an incompatible project version', async () => {
    mockFetch(async () => Response.json({ version: 2, layers: [] }));
    await expect(loadProject(1)).rejects.toThrow('不支援的專案版本');
  });

  it('throws on a truncated / non-JSON body', async () => {
    mockFetch(async () => new Response('{"version": 1, "lay', { status: 200 }));
    await expect(loadProject(1)).rejects.toThrow();
  });
});

// 審查 GIS-11：清單讀取失敗若回 []，開頁／刪除後會自動新建空白專案並把 localStorage 指過去
describe('listProjects', () => {
  it('returns the list on 200', async () => {
    mockFetch(async () => Response.json([{ id: 3, name: 'A', updated_at: 't' }]));
    await expect(listProjects()).resolves.toEqual([{ id: 3, name: 'A', updatedAt: 't' }]);
  });

  it('returns [] only for a real 200 empty list', async () => {
    mockFetch(async () => Response.json([]));
    await expect(listProjects()).resolves.toEqual([]);
  });

  it.each([401, 500, 502, 524])('throws on HTTP %i instead of returning []', async (status) => {
    mockFetch(async () => new Response('error', { status }));
    const err = await listProjects().catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(status);
    expect(isUnauthorized(err)).toBe(status === 401);
  });

  it('throws on network failure', async () => {
    mockFetch(async () => {
      throw new TypeError('Failed to fetch');
    });
    await expect(listProjects()).rejects.toThrow('Failed to fetch');
  });

  it('throws when the body is not a list', async () => {
    mockFetch(async () => Response.json({ detail: 'x' }));
    await expect(listProjects()).rejects.toThrow();
  });
});

describe('createProject', () => {
  it('returns the new project with its revision', async () => {
    mockFetch(async () => Response.json({ id: 9, name: 'N', updated_at: 't9' }));
    await expect(createProject('N')).resolves.toEqual({ id: 9, name: 'N', updatedAt: 't9' });
  });

  it('throws with the server message when over quota (no silent null)', async () => {
    mockFetch(async () => Response.json({ detail: '專案數量已達上限（每位使用者最多 50 個）' }, { status: 413 }));
    const err = await createProject('N').catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(saveErrorMessage(err)).toContain('專案數量已達上限');
  });
});

// 審查 GIS-2：樂觀鎖
describe('saveProject', () => {
  it('sends If-Match and returns the new ETag', async () => {
    const fetchFn = mockFetch(async () => Response.json({ savedAt: 't2' }, { headers: { ETag: '"t2"' } }));
    await expect(saveProject(1, PAYLOAD, '"t1"')).resolves.toBe('"t2"');
    const headers = new Headers(fetchFn.mock.calls[0][1]?.headers);
    expect(headers.get('If-Match')).toBe('"t1"');
  });

  it('sends no If-Match when the revision is unknown', async () => {
    const fetchFn = mockFetch(async () => Response.json({ savedAt: 't2' }));
    await saveProject(1, PAYLOAD, null);
    expect(new Headers(fetchFn.mock.calls[0][1]?.headers).has('If-Match')).toBe(false);
  });

  it('throws a conflict error on 409', async () => {
    mockFetch(async () => Response.json({ detail: '此專案已在其他分頁或裝置更新，請重新載入。' }, { status: 409 }));
    const err = await saveProject(1, PAYLOAD, '"old"').catch((e) => e);
    expect(isConflict(err)).toBe(true);
    expect(saveErrorMessage(err)).toContain('請重新載入');
  });

  it('shows the quota message on 413', async () => {
    mockFetch(async () => Response.json({ detail: '儲存空間已達上限：每位使用者所有專案合計最多 500 MB' }, { status: 413 }));
    const err = await saveProject(1, PAYLOAD, null).catch((e) => e);
    expect(saveErrorMessage(err)).toContain('儲存空間已達上限');
  });

  it('translates the body-size 413 into Chinese', async () => {
    mockFetch(async () => Response.json({ detail: 'request body too large' }, { status: 413 }));
    const err = await saveProject(1, PAYLOAD, null).catch((e) => e);
    expect(saveErrorMessage(err)).toContain('單一專案');
  });

  it('uses keepalive only for small bodies', async () => {
    const fetchFn = mockFetch(async () => Response.json({ savedAt: 't' }));
    await saveProject(1, PAYLOAD, null, { keepalive: true });
    expect(fetchFn.mock.calls[0][1]?.keepalive).toBe(true);
    const big: ProjectPayload = { ...PAYLOAD, projectName: 'x'.repeat(100_000) };
    await saveProject(1, big, null, { keepalive: true });
    expect(fetchFn.mock.calls[1][1]?.keepalive).toBeFalsy();
  });

  // 瀏覽器的 64 KiB 上限算的是位元組：中文一字 3 bytes，字元數遠小於上限也會被拒（Failed to fetch）
  it('counts keepalive size in UTF-8 bytes, not characters', async () => {
    const fetchFn = mockFetch(async () => Response.json({ savedAt: 't' }));
    const chinese: ProjectPayload = { ...PAYLOAD, projectName: '測'.repeat(40_000) };
    const body = JSON.stringify({ ...chinese, version: 1, savedAt: new Date().toISOString() });
    expect(body.length).toBeLessThan(60_000);
    expect(new TextEncoder().encode(body).byteLength).toBeGreaterThan(64 * 1024);
    await saveProject(1, chinese, null, { keepalive: true });
    expect(fetchFn.mock.calls[0][1]?.keepalive).toBeFalsy();
  });
});
