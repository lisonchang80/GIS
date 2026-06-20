// 土壤污染調查 3D 體積：把各深度層的濃度內插成 3D 純量場，
// 供 (A) Three.js 堆疊切片 與 (B) Plotly isosurface 兩種渲染共用。
// 面積/體積與分頁一致：同樣走 buildIDWGrid + turf.isobands + turf.area。
import * as turf from '@turf/turf';
import type { FeatureCollection, MultiPolygon, Polygon } from 'geojson';
import { buildIDWGrid, collectSoilSurveySamplesForDepth, idw } from './contour';
import type { VectorLayer } from './types';

export interface DepthSlice {
  depth: number; // m（正值代表往下）
  area: number; // m²（閾值以上）
  ringsM: number[][][]; // 閾值以上多邊形環，座標已投影成本地公尺 [[x,y],…]
}

export interface ScalarField {
  xM: number[]; // nx 本地公尺
  yM: number[]; // ny 本地公尺
  depths: number[]; // nz 公尺
  values: number[]; // 攤平，順序 k(深度)→j(y)→i(x)；無資料層為 NaN
}

export interface SurveyVolume {
  hasData: boolean;
  slices: DepthSlice[];
  volume: number; // m³
  field: ScalarField | null;
  horizSpanM: number; // 水平最大跨距（m），給垂直誇張用
  maxDepthM: number;
  interval: number; // 深度間隔（m），給切片厚度用
  valueMax: number;
  substanceName: string;
  unit: string;
}

const LAT_M = 110540; // 1° 緯度 ≈ 110540 m
const lonMetersPerDeg = (lat: number) => 111320 * Math.cos((lat * Math.PI) / 180);

// 採樣是「深度區間」：0~0.5m / 0.5~1.0m / …。回傳每層的「頂深」字串當 key
// （0 / 0.5 / … / maxDepth−interval）。N 層 = maxDepth / interval（不是 N+1 個點）。
export function buildDepthKeys(interval?: number, maxDepth?: number): string[] {
  const step = typeof interval === 'number' && interval > 0 ? interval : 0.5;
  const max = typeof maxDepth === 'number' && maxDepth >= 0 ? maxDepth : 4;
  const keys: string[] = [];
  for (let i = 0; i < 400; i++) {
    const top = +(i * step).toFixed(3);
    if (top + step > max + 1e-9) break; // 只收「下緣 ≤ maxDepth」的完整層
    keys.push(String(top));
  }
  return keys;
}

// 把頂深 key 轉成對外的區間標籤：'0' → '0~0.5m'、'0.5' → '0.5~1m'。
export function depthRangeLabel(topKey: string, interval?: number): string {
  const step = typeof interval === 'number' && interval > 0 ? interval : 0.5;
  const top = parseFloat(topKey);
  const bot = +(top + step).toFixed(3);
  return `${top}~${bot}m`;
}

// 該層的代表深度（中心點），用於內插取樣位置與 3D 垂向定位。
export function depthMid(topKey: string, interval?: number): number {
  const step = typeof interval === 'number' && interval > 0 ? interval : 0.5;
  return parseFloat(topKey) + step / 2;
}

export function buildSurveyVolume(
  layer: VectorLayer,
  tabId: string,
  subId: string,
  depthKeys: string[],
  interval: number,
  threshold: number,
  model: 'idw' | 'tin' | 'kriging',
  substanceName: string,
  unit: string,
): SurveyVolume {
  // depth = 該層中心點（代表深度），用於 3D 垂向定位與 isosurface 的 z。
  const perDepth = depthKeys.map((dk) => ({
    depth: parseFloat(dk) + interval / 2,
    samples: collectSoilSurveySamplesForDepth(layer, tabId, subId, dk),
  }));
  const allSamples = perDepth.flatMap((d) => d.samples);
  const withData = perDepth.filter((d) => d.samples.length >= 3);
  const empty: SurveyVolume = {
    hasData: false,
    slices: [],
    volume: 0,
    field: null,
    horizSpanM: 0,
    maxDepthM: 0,
    interval,
    valueMax: 0,
    substanceName,
    unit,
  };
  if (allSamples.length === 0 || withData.length === 0) return empty;

  const lng0 = allSamples.reduce((a, s) => a + s.x, 0) / allSamples.length;
  const lat0 = allSamples.reduce((a, s) => a + s.y, 0) / allSamples.length;
  const kx = lonMetersPerDeg(lat0);
  const proj = (lng: number, lat: number): [number, number] => [(lng - lng0) * kx, (lat - lat0) * LAT_M];

  // ---- 每深度層：閾值以上多邊形 + 面積 ----
  const slices: DepthSlice[] = [];
  let volume = 0;
  let valueMax = 0;
  for (const { depth, samples } of perDepth) {
    if (samples.length >= 3) {
      for (const s of samples) if (s.z > valueMax) valueMax = s.z;
    }
    if (samples.length < 3) {
      slices.push({ depth, area: 0, ringsM: [] });
      continue;
    }
    const built = buildIDWGrid(samples, 50, model);
    if (!built) {
      slices.push({ depth, area: 0, ringsM: [] });
      continue;
    }
    const lower = Math.max(threshold, built.zMin);
    if (!(built.zMax > lower)) {
      slices.push({ depth, area: 0, ringsM: [] });
      continue;
    }
    const upper = built.zMax + Math.max(Math.abs(built.zMax), 1) * 1e-6;
    let bands: FeatureCollection;
    try {
      bands = turf.isobands(built.grid, [lower, upper], { zProperty: 'z' }) as FeatureCollection;
    } catch {
      slices.push({ depth, area: 0, ringsM: [] });
      continue;
    }
    let area = 0;
    const ringsM: number[][][] = [];
    for (const f of bands.features) {
      const g = f.geometry as Polygon | MultiPolygon | null;
      if (!g) continue;
      area += turf.area(f);
      const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
      for (const poly of polys) for (const ring of poly) ringsM.push(ring.map(([lng, lat]) => proj(lng, lat)));
    }
    slices.push({ depth, area, ringsM });
    volume += area * interval;
  }

  // ---- 規則格網純量場（Plotly isosurface 用）----
  const xs = allSamples.map((s) => s.x);
  const ys = allSamples.map((s) => s.y);
  let minX = Math.min(...xs);
  let maxX = Math.max(...xs);
  let minY = Math.min(...ys);
  let maxY = Math.max(...ys);
  const dxr = maxX - minX || 0.001;
  const dyr = maxY - minY || 0.001;
  minX -= dxr * 0.1;
  maxX += dxr * 0.1;
  minY -= dyr * 0.1;
  maxY += dyr * 0.1;
  const N = 26;
  const xLng = Array.from({ length: N }, (_, i) => minX + ((maxX - minX) * i) / (N - 1));
  const yLat = Array.from({ length: N }, (_, j) => minY + ((maxY - minY) * j) / (N - 1));
  const xM = xLng.map((l) => (l - lng0) * kx);
  const yM = yLat.map((l) => (l - lat0) * LAT_M);
  const depths = perDepth.map((d) => d.depth);
  const values: number[] = [];
  for (const { samples } of perDepth) {
    const has = samples.length >= 3;
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        values.push(has ? idw(xLng[i], yLat[j], samples) : NaN);
      }
    }
  }
  const field: ScalarField = { xM, yM, depths, values };

  const horizSpanM = Math.max(Math.abs(maxX - minX) * kx, Math.abs(maxY - minY) * LAT_M);
  const maxDepthM = Math.max(...depths, interval);

  return { hasData: true, slices, volume, field, horizSpanM, maxDepthM, interval, valueMax, substanceName, unit };
}
