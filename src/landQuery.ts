import type { FeatureCollection } from 'geojson';

export const TAIWAN_CITIES = [
  '臺北市', '新北市', '桃園市', '臺中市', '臺南市', '高雄市',
  '基隆市', '新竹市', '嘉義市',
  '新竹縣', '苗栗縣', '彰化縣', '南投縣', '雲林縣', '嘉義縣',
  '屏東縣', '宜蘭縣', '花蓮縣', '臺東縣',
  '澎湖縣', '金門縣', '連江縣',
] as const;

export type TaiwanCity = (typeof TAIWAN_CITIES)[number];

export interface LandQueryParams {
  city: string;
  section: string;
  parcel: string;
}

export interface LandQueryResult {
  features: FeatureCollection;
  notFound: string[];
}

const ENDPOINT = 'https://twland.ronny.tw/index/search';
// 第三方服務掛住（不回應）時，fetch 預設永遠不結束 → 地號輸入框一直停在「查詢中…」。
export const LAND_QUERY_TIMEOUT_MS = 15000;

export async function searchLand(params: LandQueryParams, signal?: AbortSignal): Promise<LandQueryResult> {
  const { city, section, parcel } = params;
  const trimmedCity = city.trim();
  const trimmedSection = section.trim();
  const trimmedParcel = parcel.trim();
  if (!trimmedCity || !trimmedSection || !trimmedParcel) {
    throw new Error('縣市、段名、地號皆為必填');
  }
  const query = `${trimmedCity},${trimmedSection},${trimmedParcel}`;
  const url = `${ENDPOINT}?lands[]=${encodeURIComponent(query)}`;
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, LAND_QUERY_TIMEOUT_MS);
  let json: {
    type: string;
    features: FeatureCollection['features'];
    notfound?: { query: string; message: string }[];
  };
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      throw new Error(`查詢失敗（HTTP ${res.status}）`);
    }
    json = await res.json();
  } catch (e) {
    if (timedOut) throw new Error('查詢逾時，地號服務沒有回應，請稍後再試', { cause: e });
    throw e;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
  return {
    features: { type: 'FeatureCollection', features: json.features ?? [] },
    notFound: (json.notfound ?? []).map((n) => n.query),
  };
}
