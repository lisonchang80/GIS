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
  const res = await fetch(url, { signal });
  if (!res.ok) {
    throw new Error(`查詢失敗（HTTP ${res.status}）`);
  }
  const json = (await res.json()) as {
    type: string;
    features: FeatureCollection['features'];
    notfound?: { query: string; message: string }[];
  };
  return {
    features: { type: 'FeatureCollection', features: json.features ?? [] },
    notFound: (json.notfound ?? []).map((n) => n.query),
  };
}
