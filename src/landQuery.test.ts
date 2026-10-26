import { afterEach, describe, expect, it, vi } from 'vitest';
import { LAND_QUERY_TIMEOUT_MS, searchLand } from './landQuery';

const PARAMS = { city: '臺北市', section: '測試段', parcel: '123' };

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// 模擬 twland.ronny.tw 掛住：請求永遠不回應，只在被 abort 時才結束
function hangingFetch() {
  return vi.fn((_url: string, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    }),
  );
}

describe('searchLand', () => {
  it('外部服務掛住時會逾時，而不是讓「查詢中…」永遠卡住', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', hangingFetch());
    const result = searchLand(PARAMS);
    const assertion = expect(result).rejects.toThrow('逾時');
    await vi.advanceTimersByTimeAsync(LAND_QUERY_TIMEOUT_MS + 10);
    await assertion;
  });

  it('呼叫端仍可自行中止', async () => {
    vi.stubGlobal('fetch', hangingFetch());
    const controller = new AbortController();
    const result = searchLand(PARAMS, controller.signal);
    controller.abort();
    await expect(result).rejects.toThrow();
  });

  it('正常回應照常解析', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ type: 'FeatureCollection', features: [], notfound: [{ query: 'q', message: 'm' }] })),
    );
    await expect(searchLand(PARAMS)).resolves.toEqual({
      features: { type: 'FeatureCollection', features: [] },
      notFound: ['q'],
    });
  });
});
