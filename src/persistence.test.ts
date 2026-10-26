import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadProject } from './persistence';

function mockFetch(impl: () => Promise<Response>) {
  vi.stubGlobal('fetch', vi.fn(impl));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('loadProject', () => {
  it('returns null only for an existing-but-empty project (204)', async () => {
    mockFetch(async () => new Response(null, { status: 204 }));
    await expect(loadProject(1)).resolves.toBeNull();
  });

  it('returns the stored project', async () => {
    const project = { version: 1, basemapId: 'osm', layers: [], savedAt: '' };
    mockFetch(async () => Response.json(project));
    await expect(loadProject(1)).resolves.toEqual(project);
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
