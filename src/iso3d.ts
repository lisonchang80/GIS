// 土壤污染調查 3D 體積：把各深度層濃度內插成 3D 純量場，供 Three.js 堆疊切片
// 與 Plotly isosurface 共用。一個共用規則格網跑出：分級色帶切片(對齊 2D 等濃度線)、
// 缺層垂向內插、障礙物挖空、堆疊體積(Σ面積×厚)與平滑體積(體素積分)。
import * as turf from '@turf/turf';
import type { Feature, FeatureCollection, MultiPolygon, Polygon } from 'geojson';
import { collectSoilSurveySamplesForDepth, makeInterpolator, type ContourModel } from './contour';
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

// 濃度 ≤ ZERO_EPS（含負值已歸 0）視為「無」→ 不著色（白＝渲染時跳過/透明）。
// 用近零絕對值而非 M·1e-4，確保任何正濃度都會上色、只有真正等於 0 才透明。
const ZERO_EPS = 1e-6;

// ---- 濃度 → 分級顏色（與 2D 等濃度線 makeGwConcDefaults 完全一致）----
export function colorForConc(value: number, M?: number, C?: number): string {
  if (value <= ZERO_EPS) return '#ffffff'; // ≤0 → 無色
  if (typeof M !== 'number' || typeof C !== 'number' || M <= 0 || C <= M) {
    return '#ef4444'; // 無雙標準 → 單色（紅）
  }
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
  // 下界取「閾值」與「近零」較大者：閾值 0 時 → 只有 >0 才上色（等於 0 不著色）。
  const lower = Math.max(threshold, ZERO_EPS);
  if (typeof M === 'number' && typeof C === 'number' && M > 0 && C > M) {
    interior = [M / 2, M, C].filter((v) => v > lower + 1e-9 && v < top);
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
  points: { x: number; y: number; name: string }[]; // 鑽孔/採樣點位（本地公尺，與 xM/yM 同系）
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
  model?: ContourModel; // idw / tin / kriging（與 2D 等濃度線同一套內插）
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
    substanceName: p.substanceName, unit: p.unit, legend: [], obstacles: [], points: [],
  };
  if (allSamples.length === 0 || perDepth.every((d) => d.samples.length < 3)) return empty;

  const lng0 = allSamples.reduce((a, s) => a + s.x, 0) / allSamples.length;
  const lat0 = allSamples.reduce((a, s) => a + s.y, 0) / allSamples.length;
  const kx = lonMetersPerDeg(lat0);
  const proj = (lng: number, lat: number): [number, number] => [(lng - lng0) * kx, (lat - lat0) * LAT_M];

  // 鑽孔/採樣點位（每個有此分頁濃度的點要素一筆）→ 投影成本地公尺，供 3D 畫地表貫穿線標記。
  const points: { x: number; y: number; name: string }[] = [];
  for (const f of layer.data.features) {
    if (f.geometry?.type !== 'Point') continue;
    const props = (f.properties ?? {}) as Record<string, unknown>;
    const sv = (props['__soilSurvey'] as Record<string, Record<string, Record<string, unknown>>> | undefined)?.[tabId]?.[subId];
    if (!sv || !Object.values(sv).some((v) => typeof v === 'number' && Number.isFinite(v))) continue;
    const [lng, lat] = f.geometry.coordinates as [number, number];
    const [px, py] = proj(lng, lat);
    points.push({ x: px, y: py, name: typeof props['名稱'] === 'string' ? (props['名稱'] as string) : '' });
  }

  let valueMax = 0;
  for (const s of allSamples) { const z = Math.max(0, s.z); if (z > valueMax) valueMax = z; }

  // 共用規則格網（含 10% 外擴）
  const xs = allSamples.map((s) => s.x);
  const ys = allSamples.map((s) => s.y);
  let minX = Math.min(...xs); let maxX = Math.max(...xs);
  let minY = Math.min(...ys); let maxY = Math.max(...ys);
  const dxr = maxX - minX || 0.001; const dyr = maxY - minY || 0.001;
  // 與 2D buildIDWGrid 同樣外擴 15%，讓 3D 切片範圍/著色與 2D 等濃度線一致
  minX -= dxr * 0.15; maxX += dxr * 0.15; minY -= dyr * 0.15; maxY += dyr * 0.15;
  const X = Array.from({ length: N }, (_, i) => minX + ((maxX - minX) * i) / (N - 1));
  const Y = Array.from({ length: N }, (_, j) => minY + ((maxY - minY) * j) / (N - 1));
  const xM = X.map((l) => (l - lng0) * kx);
  const yM = Y.map((l) => (l - lat0) * LAT_M);
  const depths = perDepth.map((d) => d.depth);

  // 每層 z 陣列（row-major j→i），<3 點為 null。用所選模型內插（idw/tin/kriging）。
  const rawGrids: (number[] | null)[] = perDepth.map(({ samples }) => {
    if (samples.length < 3) return null;
    const interp = makeInterpolator(p.model, samples); // 一層建一次（tin 三角網 / kriging 解一次）
    const g = new Array(N * N);
    // 負值（內插過衝等）一律歸 0
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) g[j * N + i] = Math.max(0, interp(X[i], Y[j]));
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

  // 規則格網的水平體素尺寸（公尺）：面積/體積積分都以「每格點 = 一個 dxM×dyM 體素」為單位。
  const dxM = Math.abs(xM[1] - xM[0]);
  const dyM = Math.abs(yM[1] - yM[0]);
  const cellArea = dxM * dyM;
  const vLow = Math.max(threshold, ZERO_EPS); // ≥閾值（threshold 0 時 → 只算 >0）
  // 退化色帶要用的 bbox 矩形：外圍格點各往外擴半格，矩形面積 = N²·cellArea = 全格網積分面積。
  const hx = (X[1] - X[0]) / 2;
  const hy = (Y[1] - Y[0]) / 2;
  const fullGridRect = (): Feature<Polygon> =>
    turf.bboxPolygon([X[0] - hx, Y[0] - hy, X[N - 1] + hx, Y[N - 1] + hy]) as Feature<Polygon>;

  // ---- 切片（分級色帶 + 障礙物挖空）+ 堆疊面積 ----
  // 面積一律用「規則格網體素積分」算（與 turf.isobands 無關）：直接數 ≥閾值 的格點 × cellArea。
  // 不沿用 isobands 多邊形面積，是因為當 ≥閾值 帶填滿（近）整個格網時 marching-squares 沒有內部
  // 等高線 → turf.isobands 退化（面積塌成 ~0／翻成 bbox 補集／逐層非單調）。isobands 只留著畫彩色
  // 帶多邊形；某色帶填滿整個格網（無內部等高線）時改用 bbox 矩形當該色面，讓 3D 切片與面積一致。
  const slices: DepthSlice[] = [];
  let volumeStack = 0;
  perDepth.forEach((pd, k) => {
    const grid = grids[k];
    if (!grid || plan.breaks.length < 2) {
      slices.push({ topKey: pd.topKey, depth: pd.depth, area: 0, estimated: !!estimated[k], bands: [] });
      return;
    }
    const top = parseFloat(pd.topKey);
    const obs = obRangeOverlapsLayer(top, top + interval);
    const inObstacle = (i: number, j: number) =>
      obs.length > 0 && obs.some(({ feat }) => turf.booleanPointInPolygon([X[i], Y[j]], feat));

    // 體素積分面積 + 每段（顏色）落點數。bandCounts 只看純量場本身（不扣障礙物），
    // 障礙物之後再從色帶多邊形 difference 扣；面積則直接跳過障礙物覆蓋的格點。
    let area = 0;
    const bandCounts = new Array(plan.breaks.length - 1).fill(0);
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const v = grid[j * N + i];
        if (v < vLow) continue;
        for (let bi = 0; bi < bandCounts.length; bi++) {
          if (v >= plan.breaks[bi] && (v < plan.breaks[bi + 1] || bi === bandCounts.length - 1)) {
            bandCounts[bi]++;
            break;
          }
        }
        if (!inObstacle(i, j)) area += cellArea;
      }
    }

    // isobands 只負責「有內部等高線」的色帶多邊形；退化色帶（填滿整格網）改用 bbox 矩形。
    let bandsFC: FeatureCollection | null = null;
    try {
      const fc = turf.featureCollection(
        Array.from({ length: N * N }, (_, idx) => turf.point([X[idx % N], Y[Math.floor(idx / N)]], { z: grid[idx] })),
      );
      bandsFC = turf.isobands(fc, plan.breaks, { zProperty: 'z' }) as FeatureCollection;
    } catch {
      bandsFC = null;
    }

    const byColor = new Map<string, number[][][][]>();
    for (let bi = 0; bi < plan.colors.length; bi++) {
      const color = plan.colors[bi];
      if (!color || color === '#ffffff' || bandCounts[bi] === 0) continue;
      // isobands 對「幾乎填滿格網」的色帶會退化：當低於閾值的小區塊落在格網邊界（而非內部孔洞），
      // marching-squares 畫不出封閉內部等高線 → 該段多邊形塌成空殼／細條／翻成 bbox 補集。偵測法：
      // 比較該段「格點積分面積」與 isobands 實際面積，若色帶近乎填滿（≥80% 格點）且 isobands 面積遠小
      // 於格點面積（<50%）→ 視為退化，改用 bbox 矩形，讓 3D 切片板塊與面積 chip 一致。
      const featFromIso = bandsFC?.features[bi] ?? null;
      const gridBandArea = bandCounts[bi] * cellArea;
      let isoArea = 0;
      if (featFromIso) { try { isoArea = turf.area(featFromIso); } catch { isoArea = 0; } }
      const degenerate =
        bandCounts[bi] === N * N ||
        (bandCounts[bi] >= 0.8 * N * N && isoArea < 0.5 * gridBandArea);
      let geomFeat: Feature | null = degenerate ? fullGridRect() : featFromIso;
      if (!geomFeat) continue;
      for (const { feat } of obs) {
        if (!geomFeat) break;
        try {
          geomFeat = turf.difference(turf.featureCollection([geomFeat as Feature<Polygon | MultiPolygon>, feat])) as Feature | null;
        } catch { /* keep */ }
      }
      const g = (geomFeat?.geometry ?? null) as Polygon | MultiPolygon | null;
      if (!g) continue;
      const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
      const list = byColor.get(color) ?? [];
      for (const poly of polys) list.push(poly.map((ring) => ring.map(([lng, lat]) => proj(lng, lat))));
      byColor.set(color, list);
    }

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

  // ---- 平滑體積（體素積分：z 細分內插、障礙物挖空）----（dxM/dyM/vLow 已於切片前定義）
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
        if (v < vLow) continue;
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
    substanceName: p.substanceName, unit: p.unit, legend, obstacles: obProj, points,
  };
}
