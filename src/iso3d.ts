// 土壤污染調查 3D 體積：把各深度層濃度內插成 3D 純量場，供 Three.js 堆疊切片
// 與 Plotly isosurface 共用。一個共用規則格網跑出：分級色帶切片(對齊 2D 等濃度線)、
// 缺層垂向內插、障礙物挖空、堆疊體積(Σ面積×厚)與平滑體積(體素積分)。
import * as turf from '@turf/turf';
import type { Feature, FeatureCollection, MultiPolygon, Polygon } from 'geojson';
import { collectSoilSurveySamplesForDepth, idw } from './contour';
import type { ObstacleZone, VectorLayer } from './types';

// ---- 深度區間工具（採樣以區間為單位：0~0.5m / 0.5~1m / …）----
export function buildDepthKeys(interval?: number, maxDepth?: number): string[] {
  const step = typeof interval === 'number' && interval > 0 ? interval : 0.5;
  const max = typeof maxDepth === 'number' && maxDepth >= 0 ? maxDepth : 4;
  const keys: string[] = [];
  for (let i = 0; i < 400; i++) {
    const top = +(i * step).toFixed(3);
    if (top + step > max + 1e-9) break;
    keys.push(String(top));
  }
  return keys;
}
export function depthRangeLabel(topKey: string, interval?: number): string {
  const step = typeof interval === 'number' && interval > 0 ? interval : 0.5;
  const top = parseFloat(topKey);
  const bot = +(top + step).toFixed(3);
  return `${top}~${bot}m`;
}
export function depthMid(topKey: string, interval?: number): number {
  const step = typeof interval === 'number' && interval > 0 ? interval : 0.5;
  return parseFloat(topKey) + step / 2;
}

// ---- 濃度 → 分級顏色（與 2D 等濃度線 makeGwConcDefaults 完全一致）----
export function colorForConc(value: number, M?: number, C?: number): string {
  if (typeof M !== 'number' || typeof C !== 'number' || M <= 0 || C <= M) {
    return '#ef4444'; // 無雙標準 → 單色（紅）
  }
  const eps = M * 1e-4;
  if (value < eps) return '#ffffff';
  if (value < M / 2) return '#22c55e';
  if (value < M) return '#eab308';
  if (value < C) return '#f97316';
  return '#ef4444';
}
const BAND_LABEL: Record<string, string> = {
  '#22c55e': '< ½ 監測',
  '#eab308': '½ 監測 ~ 監測',
  '#f97316': '監測 ~ 管制',
  '#ef4444': '≥ 管制',
};

// isobands 斷點 + 每段顏色（只保留 ≥ threshold 的範圍；白色段不畫）。
function bandPlan(threshold: number, valueMax: number, M?: number, C?: number): { breaks: number[]; colors: string[] } {
  const top = valueMax + Math.max(Math.abs(valueMax), 1) * 1e-6;
  let interior: number[] = [];
  let lower = threshold;
  if (typeof M === 'number' && typeof C === 'number' && M > 0 && C > M) {
    const eps = M * 1e-4;
    lower = Math.max(threshold, eps);
    interior = [M / 2, M, C].filter((v) => v > lower + 1e-9 && v < top);
  } else {
    lower = Math.max(threshold, 0);
  }
  if (!(top > lower)) return { breaks: [], colors: [] };
  const breaks = [lower, ...interior, top];
  const colors: string[] = [];
  for (let i = 0; i < breaks.length - 1; i++) {
    colors.push(colorForConc((breaks[i] + breaks[i + 1]) / 2, M, C));
  }
  return { breaks, colors };
}

// ---- 結構 ----
export interface BandSlab {
  color: string;
  // 該色帶多邊形（已扣障礙物），本地公尺；每個 poly = [外環, 內環(洞)…]，供 THREE.Shape 挖洞
  polysM: number[][][][];
}
export interface DepthSlice {
  topKey: string;
  depth: number; // 中心點深度 m
  area: number; // m²（≥threshold，已扣障礙物）
  estimated: boolean; // 缺層垂向補估
  bands: BandSlab[];
}
export interface ScalarField {
  xM: number[];
  yM: number[];
  depths: number[]; // 層中心點 m
  values: number[]; // 攤平 k→j→i；無資料(且補不到)為 NaN
}
export interface ObstacleProjected {
  depthTop: number;
  depthBottom: number;
  ringsM: number[][][]; // 投影後外環（供 3D 畫灰柱）
}
export interface SurveyVolume {
  hasData: boolean;
  slices: DepthSlice[];
  field: ScalarField | null;
  volumeStack: number; // m³（Σ 面積×interval）
  volumeSmooth: number; // m³（體素積分）
  horizSpanM: number;
  maxDepthM: number;
  interval: number;
  valueMax: number;
  substanceName: string;
  unit: string;
  legend: { color: string; label: string }[];
  obstacles: ObstacleProjected[];
}

export interface SurveyVolumeParams {
  layer: VectorLayer;
  tabId: string;
  subId: string;
  depthKeys: string[];
  interval: number;
  threshold: number;
  monitorConc?: number;
  controlConc?: number;
  substanceName: string;
  unit: string;
  obstacles?: ObstacleZone[];
  fillGaps?: boolean;
}

const LAT_M = 110540;
const lonMetersPerDeg = (lat: number) => 111320 * Math.cos((lat * Math.PI) / 180);
const N = 32; // 共用格網解析度

// 缺層補估：對 z 陣列為 null 的層，用上下最近有效層線性內插（端點外 hold 最近）。
function fillLayers(grids: (number[] | null)[], depths: number[]): { filled: (number[] | null)[]; estimated: boolean[] } {
  const n = grids.length;
  const filled = grids.slice();
  const estimated = new Array(n).fill(false);
  const valid = grids.map((g) => g !== null);
  for (let k = 0; k < n; k++) {
    if (valid[k]) continue;
    let a = -1;
    let b = -1;
    for (let i = k - 1; i >= 0; i--) if (valid[i]) { a = i; break; }
    for (let i = k + 1; i < n; i++) if (valid[i]) { b = i; break; }
    const ga = a >= 0 ? grids[a]! : null;
    const gb = b >= 0 ? grids[b]! : null;
    if (ga && gb) {
      const t = (depths[k] - depths[a]) / (depths[b] - depths[a]);
      filled[k] = ga.map((va, idx) => va + (gb[idx] - va) * t);
    } else if (ga) {
      filled[k] = ga.slice();
    } else if (gb) {
      filled[k] = gb.slice();
    } else {
      continue;
    }
    estimated[k] = true;
  }
  return { filled, estimated };
}

export function buildSurveyVolume(p: SurveyVolumeParams): SurveyVolume {
  const { layer, tabId, subId, depthKeys, interval, threshold, monitorConc: M, controlConc: C } = p;
  const obstacles = (p.obstacles ?? []).filter((o) => o.enabled && o.geometry);
  const fillGaps = p.fillGaps !== false;

  const perDepth = depthKeys.map((dk) => ({
    topKey: dk,
    depth: parseFloat(dk) + interval / 2,
    samples: collectSoilSurveySamplesForDepth(layer, tabId, subId, dk),
  }));
  const allSamples = perDepth.flatMap((d) => d.samples);
  const empty: SurveyVolume = {
    hasData: false, slices: [], field: null, volumeStack: 0, volumeSmooth: 0,
    horizSpanM: 0, maxDepthM: 0, interval, valueMax: 0,
    substanceName: p.substanceName, unit: p.unit, legend: [], obstacles: [],
  };
  if (allSamples.length === 0 || perDepth.every((d) => d.samples.length < 3)) return empty;

  const lng0 = allSamples.reduce((a, s) => a + s.x, 0) / allSamples.length;
  const lat0 = allSamples.reduce((a, s) => a + s.y, 0) / allSamples.length;
  const kx = lonMetersPerDeg(lat0);
  const proj = (lng: number, lat: number): [number, number] => [(lng - lng0) * kx, (lat - lat0) * LAT_M];

  let valueMax = 0;
  for (const s of allSamples) if (s.z > valueMax) valueMax = s.z;

  // 共用規則格網（含 10% 外擴）
  const xs = allSamples.map((s) => s.x);
  const ys = allSamples.map((s) => s.y);
  let minX = Math.min(...xs); let maxX = Math.max(...xs);
  let minY = Math.min(...ys); let maxY = Math.max(...ys);
  const dxr = maxX - minX || 0.001; const dyr = maxY - minY || 0.001;
  minX -= dxr * 0.1; maxX += dxr * 0.1; minY -= dyr * 0.1; maxY += dyr * 0.1;
  const X = Array.from({ length: N }, (_, i) => minX + ((maxX - minX) * i) / (N - 1));
  const Y = Array.from({ length: N }, (_, j) => minY + ((maxY - minY) * j) / (N - 1));
  const xM = X.map((l) => (l - lng0) * kx);
  const yM = Y.map((l) => (l - lat0) * LAT_M);
  const depths = perDepth.map((d) => d.depth);

  // 每層 z 陣列（row-major j→i），<3 點為 null
  const rawGrids: (number[] | null)[] = perDepth.map(({ samples }) => {
    if (samples.length < 3) return null;
    const g = new Array(N * N);
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) g[j * N + i] = idw(X[i], Y[j], samples);
    return g;
  });
  const { filled: grids, estimated } = fillGaps
    ? fillLayers(rawGrids, depths)
    : { filled: rawGrids, estimated: new Array(N * N).fill(false) as boolean[] };

  // 障礙物投影 + 判斷某深度是否被某障礙物覆蓋
  const obProj: ObstacleProjected[] = obstacles.map((o) => ({
    depthTop: o.depthTop, depthBottom: o.depthBottom,
    ringsM: o.geometry.coordinates.map((ring) => ring.map(([lng, lat]) => proj(lng, lat))),
  }));
  const obFeatures = obstacles.map((o) => turf.feature(o.geometry) as Feature<Polygon>);
  const obAtDepth = (d: number) =>
    obstacles.map((o, idx) => ({ o, feat: obFeatures[idx] })).filter(({ o }) => d > o.depthTop - 1e-9 && d < o.depthBottom + 1e-9);
  const obRangeOverlapsLayer = (top: number, bot: number) =>
    obstacles.map((o, idx) => ({ o, feat: obFeatures[idx] })).filter(({ o }) => o.depthTop < bot - 1e-9 && o.depthBottom > top + 1e-9);

  const plan = bandPlan(threshold, valueMax, M, C);

  // ---- 切片（分級色帶 + 障礙物挖空）+ 堆疊面積 ----
  const slices: DepthSlice[] = [];
  let volumeStack = 0;
  perDepth.forEach((pd, k) => {
    const grid = grids[k];
    if (!grid || plan.breaks.length < 2) {
      slices.push({ topKey: pd.topKey, depth: pd.depth, area: 0, estimated: !!estimated[k], bands: [] });
      return;
    }
    const fc = turf.featureCollection(
      Array.from({ length: N * N }, (_, idx) => turf.point([X[idx % N], Y[Math.floor(idx / N)]], { z: grid[idx] })),
    );
    let bandsFC: FeatureCollection;
    try {
      bandsFC = turf.isobands(fc, plan.breaks, { zProperty: 'z' }) as FeatureCollection;
    } catch {
      slices.push({ topKey: pd.topKey, depth: pd.depth, area: 0, estimated: !!estimated[k], bands: [] });
      return;
    }
    const top = parseFloat(pd.topKey);
    const obs = obRangeOverlapsLayer(top, top + interval);
    const byColor = new Map<string, number[][][][]>();
    let area = 0;
    bandsFC.features.forEach((f, i) => {
      const color = plan.colors[i];
      if (!color || color === '#ffffff') return;
      let geomFeat: Feature | null = f;
      for (const { feat } of obs) {
        if (!geomFeat) break;
        try {
          geomFeat = turf.difference(turf.featureCollection([geomFeat as Feature<Polygon | MultiPolygon>, feat])) as Feature | null;
        } catch { /* keep */ }
      }
      if (!geomFeat) return;
      const g = geomFeat.geometry as Polygon | MultiPolygon | null;
      if (!g) return;
      area += turf.area(geomFeat);
      const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
      const list = byColor.get(color) ?? [];
      for (const poly of polys) list.push(poly.map((ring) => ring.map(([lng, lat]) => proj(lng, lat))));
      byColor.set(color, list);
    });
    slices.push({
      topKey: pd.topKey, depth: pd.depth, area, estimated: !!estimated[k],
      bands: [...byColor.entries()].map(([color, polysM]) => ({ color, polysM })),
    });
    volumeStack += area * interval;
  });

  // ---- 純量場（Plotly）：障礙物覆蓋的體素設 NaN，渲染時會被挖空 ----
  const values: number[] = [];
  for (let k = 0; k < perDepth.length; k++) {
    const grid = grids[k];
    const obs = obAtDepth(depths[k]);
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        let v = grid ? grid[j * N + i] : NaN;
        if (Number.isFinite(v) && obs.length && obs.some(({ feat }) => turf.booleanPointInPolygon([X[i], Y[j]], feat))) {
          v = NaN;
        }
        values.push(v);
      }
    }
  }
  const field: ScalarField = { xM, yM, depths, values };

  // ---- 平滑體積（體素積分：z 細分內插、障礙物挖空）----
  const dxM = Math.abs(xM[1] - xM[0]);
  const dyM = Math.abs(yM[1] - yM[0]);
  const zTop = depths[0] - interval / 2;
  const zBot = depths[depths.length - 1] + interval / 2;
  const zSteps = Math.max(8, depths.length * 4);
  const dz = (zBot - zTop) / zSteps;
  let volumeSmooth = 0;
  for (let zi = 0; zi < zSteps; zi++) {
    const z = zTop + (zi + 0.5) * dz;
    // 找 z 落在哪兩個層中心點之間
    let k0 = 0;
    while (k0 < depths.length - 1 && depths[k0 + 1] < z) k0++;
    const k1 = Math.min(k0 + 1, depths.length - 1);
    const g0 = grids[k0]; const g1 = grids[k1];
    const t = depths[k1] !== depths[k0] ? (z - depths[k0]) / (depths[k1] - depths[k0]) : 0;
    const obs = obAtDepth(z);
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const v0 = g0 ? g0[j * N + i] : NaN;
        const v1 = g1 ? g1[j * N + i] : NaN;
        let v: number;
        if (Number.isFinite(v0) && Number.isFinite(v1)) v = v0 + (v1 - v0) * Math.max(0, Math.min(1, t));
        else if (Number.isFinite(v0)) v = v0;
        else if (Number.isFinite(v1)) v = v1;
        else continue;
        if (v < threshold) continue;
        if (obs.length && obs.some(({ feat }) => turf.booleanPointInPolygon([X[i], Y[j]], feat))) continue;
        volumeSmooth += dxM * dyM * dz;
      }
    }
  }

  const horizSpanM = Math.max(Math.abs(maxX - minX) * kx, Math.abs(maxY - minY) * LAT_M);
  const maxDepthM = zBot;
  // 圖例：bandPlan 出現過的顏色（去重、依濃度排序），白色不列
  const legendColors = [...new Set(plan.colors)].filter((c) => c !== '#ffffff');
  const order = ['#22c55e', '#eab308', '#f97316', '#ef4444'];
  legendColors.sort((a, b) => order.indexOf(a) - order.indexOf(b));
  const legend = legendColors.map((color) => ({ color, label: BAND_LABEL[color] ?? '污染' }));

  return {
    hasData: true, slices, field, volumeStack, volumeSmooth,
    horizSpanM, maxDepthM, interval, valueMax,
    substanceName: p.substanceName, unit: p.unit, legend, obstacles: obProj,
  };
}
