import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProjectSaver } from './projectSaver';
import { isConflict, type ProjectPayload } from './persistence';

const PAYLOAD: ProjectPayload = { basemapId: 'osm', layers: [] };

// 假伺服器：PUT 帶的 If-Match 必須等於目前版本，否則 409；回應很慢，讓存檔重疊。
function fakeServer(delayMs = 20) {
  let revision = 0;
  const bodies: string[] = [];
  const fetchFn = vi.fn(async (_url: string, init?: RequestInit) => {
    const ifMatch = new Headers(init?.headers).get('If-Match');
    await new Promise((r) => setTimeout(r, delayMs));
    if (ifMatch !== null && ifMatch !== `"${revision}"`) {
      return Response.json({ detail: 'conflict' }, { status: 409 });
    }
    revision += 1;
    bodies.push(String(init?.body));
    return Response.json({ savedAt: String(revision) }, { headers: { ETag: `"${revision}"` } });
  });
  vi.stubGlobal('fetch', fetchFn);
  return {
    fetchFn,
    bodies,
    otherTabSaves: () => {
      revision += 1;
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ProjectSaver', () => {
  it('自己連續存檔（前一次還沒回來就排下一次）不會撞 409', async () => {
    const server = fakeServer();
    const saver = new ProjectSaver();
    saver.setRevision(1, '"0"');
    const results = await Promise.allSettled([
      saver.save(1, { ...PAYLOAD, projectName: 'a' }),
      saver.save(1, { ...PAYLOAD, projectName: 'b' }),
      saver.save(1, { ...PAYLOAD, projectName: 'c' }),
    ]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled', 'fulfilled']);
    expect(server.bodies.map((b) => JSON.parse(b).projectName)).toEqual(['a', 'b', 'c']);
    expect(saver.getRevision(1)).toBe('"3"');
  });

  it('其他分頁先存了：回報衝突、版本號不變', async () => {
    const server = fakeServer(0);
    const saver = new ProjectSaver();
    saver.setRevision(1, '"0"');
    server.otherTabSaves();
    const err = await saver.save(1, PAYLOAD).catch((e) => e);
    expect(isConflict(err)).toBe(true);
    expect(saver.getRevision(1)).toBe('"0"');
    expect(server.bodies).toEqual([]);
  });

  it('一次失敗不會卡住後面的存檔', async () => {
    let n = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        n += 1;
        if (n === 1) return new Response('boom', { status: 500 });
        return Response.json({ savedAt: 't' }, { headers: { ETag: '"t"' } });
      }),
    );
    const saver = new ProjectSaver();
    const first = saver.save(1, PAYLOAD);
    const second = saver.save(1, PAYLOAD);
    await expect(first).rejects.toThrow('HTTP 500');
    await expect(second).resolves.toBe('"t"');
  });

  it('各專案的版本號分開記', async () => {
    fakeServer(0);
    const saver = new ProjectSaver();
    saver.setRevision(1, '"0"');
    saver.setRevision(2, '"0"');
    await saver.save(1, PAYLOAD);
    expect(saver.getRevision(1)).toBe('"1"');
    expect(saver.getRevision(2)).toBe('"0"');
  });
});
