import * as turf from '@turf/turf';
import type { Feature, FeatureCollection, LineString, MultiLineString, Point } from 'geojson';
import type {
  VectorLayer,
  WaterLevelArrows,
  WaterLevelFill,
  WaterLevelHeightLabel,
  WaterLevelLines,
} from './types';

export const DEFAULT_LINES: Required<WaterLevelLines> = {
  majorInterval: 0.5,
  minorEnabled: false,
  minorDivisions: 4,
  outlineEnabled: false,
  dashStyle: 'solid',
  minorDashStyle: 'solid',
  minorColor: '#9aa3b1',
  minorWidthRatio: 0.5,
};

export const DEFAULT_ARROWS: Required<WaterLevelArrows> = {
  enabled: true,
  divisions: 8,
  color: '#1d4ed8',
  width: 1.5,
};

export const DEFAULT_HEIGHT_LABEL: Required<WaterLevelHeightLabel> = {
  visible: true,
  color: '#ffffff',
  haloColor: '#000000',
  size: 12,
};

export interface IDWSample {
  x: number;
  y: number;
  z: number;
}

export function idw(x: number, y: number, samples: IDWSample[], p = 2): number {
  let num = 0;
  let den = 0;
  for (const s of samples) {
    const dx = x - s.x;
    const dy = y - s.y;
    const d2 = dx * dx + dy * dy;
    if (d2 < 1e-18) return s.z;
    const w = 1 / Math.pow(d2, p / 2);
    num += w * s.z;
    den += w;
  }
  return den > 0 ? num / den : 0;
}

function buildTinInterpolator(samples: IDWSample[]): (x: number, y: number) => number {
  const pts = turf.featureCollection(
    samples.map((s) => turf.point([s.x, s.y], { z: s.z })),
  );
  let triangles: { x1: number; y1: number; z1: number; x2: number; y2: number; z2: number; x3: number; y3: number; z3: number }[] = [];
  try {
    const tin = turf.tin(pts as FeatureCollection<Point>, 'z');
    triangles = tin.features
      .map((f) => {
        const ring = (f.geometry as { coordinates: number[][][] }).coordinates[0];
        if (!ring || ring.length < 3) return null;
        const props = f.properties as { a?: number; b?: number; c?: number } | null;
        return {
          x1: ring[0][0], y1: ring[0][1], z1: props?.a ?? 0,
          x2: ring[1][0], y2: ring[1][1], z2: props?.b ?? 0,
          x3: ring[2][0], y3: ring[2][1], z3: props?.c ?? 0,
        };
      })
      .filter((t): t is NonNullable<typeof t> => t !== null);
  } catch {
    triangles = [];
  }
  return (x: number, y: number) => {
    for (const t of triangles) {
      const det = (t.y2 - t.y3) * (t.x1 - t.x3) + (t.x3 - t.x2) * (t.y1 - t.y3);
      if (Math.abs(det) < 1e-18) continue;
      const l1 = ((t.y2 - t.y3) * (x - t.x3) + (t.x3 - t.x2) * (y - t.y3)) / det;
      const l2 = ((t.y3 - t.y1) * (x - t.x3) + (t.x1 - t.x3) * (y - t.y3)) / det;
      const l3 = 1 - l1 - l2;
      if (l1 >= -1e-9 && l2 >= -1e-9 && l3 >= -1e-9) {
        return l1 * t.z1 + l2 * t.z2 + l3 * t.z3;
      }
    }
    return idw(x, y, samples);
  };
}

function invertMatrix(M: number[][]): number[][] | null {
  const n = M.length;
  const a: number[][] = M.map((row) => row.slice());
  const inv: number[][] = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)),
  );
  for (let i = 0; i < n; i++) {
    let pivot = i;
    let maxAbs = Math.abs(a[i][i]);
    for (let r = i + 1; r < n; r++) {
      if (Math.abs(a[r][i]) > maxAbs) {
        maxAbs = Math.abs(a[r][i]);
        pivot = r;
      }
    }
    if (maxAbs < 1e-12) return null;
    if (pivot !== i) {
      [a[i], a[pivot]] = [a[pivot], a[i]];
      [inv[i], inv[pivot]] = [inv[pivot], inv[i]];
    }
    const div = a[i][i];
    for (let c = 0; c < n; c++) {
      a[i][c] /= div;
      inv[i][c] /= div;
    }
    for (let r = 0; r < n; r++) {
      if (r === i) continue;
      const factor = a[r][i];
      if (factor === 0) continue;
      for (let c = 0; c < n; c++) {
        a[r][c] -= factor * a[i][c];
        inv[r][c] -= factor * inv[i][c];
      }
    }
  }
  return inv;
}

function buildKrigingInterpolator(samples: IDWSample[]): (x: number, y: number) => number {
  const N = samples.length;
  if (N < 3) return (x, y) => idw(x, y, samples);
  let maxD = 0;
  for (let i = 0; i < N; i++) {
    for (let j = i + 1; j < N; j++) {
      const dx = samples[i].x - samples[j].x;
      const dy = samples[i].y - samples[j].y;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d > maxD) maxD = d;
    }
  }
  const zs = samples.map((s) => s.z);
  const mean = zs.reduce((a, b) => a + b, 0) / N;
  const variance = zs.reduce((a, z) => a + (z - mean) * (z - mean), 0) / Math.max(1, N - 1);
  const sill = Math.max(variance, 1e-9);
  const range = Math.max(maxD / 3, 1e-9);
  const nugget = sill * 0.05;
  const gamma = (h: number) => nugget + (sill - nugget) * (1 - Math.exp(-3 * h / range));

  const M: number[][] = Array.from({ length: N + 1 }, () => new Array(N + 1).fill(0));
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      const dx = samples[i].x - samples[j].x;
      const dy = samples[i].y - samples[j].y;
      M[i][j] = gamma(Math.sqrt(dx * dx + dy * dy));
    }
    M[i][N] = 1;
    M[N][i] = 1;
  }
  M[N][N] = 0;
  const Minv = invertMatrix(M);
  if (!Minv) return (x, y) => idw(x, y, samples);

  return (x: number, y: number) => {
    const b: number[] = new Array(N + 1);
    for (let i = 0; i < N; i++) {
      const dx = samples[i].x - x;
      const dy = samples[i].y - y;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < 1e-12) return samples[i].z;
      b[i] = gamma(d);
    }
    b[N] = 1;
    let z = 0;
    for (let i = 0; i < N; i++) {
      let w = 0;
      for (let j = 0; j <= N; j++) w += Minv[i][j] * b[j];
      z += w * samples[i].z;
    }
    return z;
  };
}

interface IDWGrid {
  grid: FeatureCollection<Point>;
  zMin: number;
  zMax: number;
}

export type ContourModel = 'idw' | 'tin' | 'kriging' | 'indicator';

export interface ContourOptions {
  logTransform?: boolean;
  clampNegative?: boolean;
  indicatorThreshold?: number;
}

export interface ThresholdLine {
  value: number;
  kind: 'control' | 'monitor';
  label: string;
}

const LOG_EPS = 1e-6;

function makeInterpolator(model: ContourModel | undefined, samples: IDWSample[]): (x: number, y: number) => number {
  if (model === 'tin') {
    const tin = buildTinInterpolator(samples);
    return (x, y) => tin(x, y);
  }
  if (model === 'kriging' || model === 'indicator') {
    const krig = buildKrigingInterpolator(samples);
    return (x, y) => krig(x, y);
  }
  return (x, y) => idw(x, y, samples);
}

function buildIDWGrid(
  samples: IDWSample[],
  gridCells = 50,
  model?: ContourModel,
  opts: ContourOptions = {},
): IDWGrid | null {
  if (samples.length < 3) return null;
  const pts = turf.featureCollection(
    samples.map((s) => turf.point([s.x, s.y], { z: s.z })),
  );
  const bbox = turf.bbox(pts) as [number, number, number, number];
  const dx = bbox[2] - bbox[0];
  const dy = bbox[3] - bbox[1];
  if (dx <= 0 || dy <= 0) return null;
  const expanded: [number, number, number, number] = [
    bbox[0] - dx * 0.15,
    bbox[1] - dy * 0.15,
    bbox[2] + dx * 0.15,
    bbox[3] + dy * 0.15,
  ];
  const widthKm = turf.distance(
    [expanded[0], expanded[1]],
    [expanded[2], expanded[1]],
    { units: 'kilometers' },
  );
  const cellSize = Math.max(widthKm / gridCells, 0.0005);
  const grid = turf.pointGrid(expanded, cellSize, { units: 'kilometers' }) as FeatureCollection<Point>;

  let workingSamples = samples;
  let postZ: (z: number) => number = (z) => z;
  if (model === 'indicator') {
    const t = opts.indicatorThreshold ?? 0;
    workingSamples = samples.map((s) => ({ ...s, z: s.z > t ? 1 : 0 }));
  } else if (opts.logTransform) {
    workingSamples = samples.map((s) => ({ ...s, z: Math.log(Math.max(s.z, LOG_EPS)) }));
    postZ = (z) => Math.exp(z) - LOG_EPS;
  }

  const interpolate = makeInterpolator(model, workingSamples);
  for (const g of grid.features) {
    const [x, y] = g.geometry.coordinates as [number, number];
    let z = postZ(interpolate(x, y));
    if (model === 'indicator') z = Math.max(0, Math.min(1, z));
    if (opts.clampNegative && z < 0) z = 0;
    g.properties = { ...(g.properties ?? {}), z };
  }

  if (model === 'indicator') {
    return { grid, zMin: 0, zMax: 1 };
  }
  let zs = samples.map((s) => s.z);
  if (opts.clampNegative) zs = zs.map((z) => Math.max(0, z));
  const zMin = Math.min(...zs);
  const zMax = Math.max(...zs);
  return { grid, zMin, zMax };
}

export function generateIsolines(
  samples: IDWSample[],
  options: { breakCount?: number; gridCells?: number } = {},
): Feature<LineString | MultiLineString>[] {
  const { breakCount = 10, gridCells = 50 } = options;
  const built = buildIDWGrid(samples, gridCells);
  if (!built) return [];
  const { grid, zMin, zMax } = built;
  if (zMax - zMin < 1e-9) return [];
  const breaks: number[] = [];
  for (let i = 0; i <= breakCount; i++) {
    breaks.push(zMin + ((zMax - zMin) * i) / breakCount);
  }
  const iso = turf.isolines(grid, breaks, { zProperty: 'z' });
  return iso.features as Feature<LineString | MultiLineString>[];
}

function hexToRgb(hex: string): [number, number, number] {
  const m = hex.replace('#', '');
  const full = m.length === 3 ? m.split('').map((c) => c + c).join('') : m;
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  return [r, g, b];
}

function rgbToHex(r: number, g: number, b: number): string {
  return (
    '#' +
    [r, g, b]
      .map((x) => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, '0'))
      .join('')
  );
}

function lerpColor(from: string, to: string, t: number): string {
  const [r1, g1, b1] = hexToRgb(from);
  const [r2, g2, b2] = hexToRgb(to);
  return rgbToHex(r1 + (r2 - r1) * t, g1 + (g2 - g1) * t, b1 + (b2 - b1) * t);
}

export function gradientColors(from: string, to: string, n: number): string[] {
  if (n <= 1) return [from];
  return Array.from({ length: n }, (_, i) => lerpColor(from, to, i / (n - 1)));
}

interface BandPlan {
  breaks: number[];
  colors: string[];
}

function planBands(
  zMin: number,
  zMax: number,
  fill: WaterLevelFill,
  majorInterval: number,
): BandPlan | null {
  if (fill.mode === 'gradient') {
    if (zMax - zMin < 1e-9) return null;
    if (!Number.isFinite(majorInterval) || majorInterval <= 0) return null;
    const from = fill.gradient?.from ?? '#cce6ff';
    const to = fill.gradient?.to ?? '#003366';
    const start = Math.floor(zMin / majorInterval) * majorInterval;
    const end = Math.ceil(zMax / majorInterval) * majorInterval;
    const breaks: number[] = [];
    for (let i = 0; ; i++) {
      const z = start + i * majorInterval;
      breaks.push(Number(z.toFixed(6)));
      if (z >= end - 1e-9) break;
      if (breaks.length > 1000) break;
    }
    const steps = breaks.length - 1;
    if (steps < 1) return null;
    const colors = gradientColors(from, to, steps);
    return { breaks, colors };
  }
  if (fill.mode === 'custom') {
    const bands = (fill.bands ?? [])
      .filter((b) => Number.isFinite(b.from) && Number.isFinite(b.to) && b.to > b.from)
      .slice()
      .sort((a, b) => a.from - b.from);
    if (bands.length === 0) return null;
    const breaks: number[] = [];
    const colors: string[] = [];
    for (const b of bands) {
      if (breaks.length === 0) {
        breaks.push(b.from);
      } else if (Math.abs(breaks[breaks.length - 1] - b.from) > 1e-9) {
        breaks.push(b.from);
        colors.push('__gap__');
      }
      breaks.push(b.to);
      colors.push(b.color);
    }
    return { breaks, colors };
  }
  return null;
}

export function buildIsobandFeaturesForLayer(
  sourceLayer: VectorLayer,
  date: string,
  fill: WaterLevelFill | undefined,
  options: { gridCells?: number; plan?: BandPlan; majorInterval?: number; model?: ContourModel; samples?: IDWSample[]; contourOpts?: ContourOptions } = {},
): Feature[] {
  if (!fill || fill.mode === 'none') return [];
  const samples = options.samples ?? collectSamplesForDate(sourceLayer, date);
  if (samples.length < 3) return [];
  const built = buildIDWGrid(samples, options.gridCells ?? 50, options.model, options.contourOpts);
  if (!built) return [];
  const { grid, zMin, zMax } = built;
  const interval = options.majorInterval ?? DEFAULT_LINES.majorInterval;
  const plan = options.plan ?? planBands(zMin, zMax, fill, interval);
  if (!plan || plan.breaks.length < 2) return [];
  let bands: FeatureCollection;
  try {
    bands = turf.isobands(grid, plan.breaks, { zProperty: 'z' }) as FeatureCollection;
  } catch {
    return [];
  }
  const out: Feature[] = [];
  bands.features.forEach((f, i) => {
    const color = plan.colors[i];
    if (!color || color === '__gap__') return;
    out.push({
      ...f,
      properties: {
        ...(f.properties ?? {}),
        __date: date,
        __kind: 'band',
        __color: color,
        名稱: '',
      },
    });
  });
  return out;
}

export function collectSamplesForDate(
  sourceLayer: VectorLayer,
  date: string,
): IDWSample[] {
  const out: IDWSample[] = [];
  for (const f of sourceLayer.data.features) {
    if (f.geometry?.type !== 'Point') continue;
    const props = (f.properties ?? {}) as Record<string, unknown>;
    const elev = props['高程'];
    const hydro = props['__hydro'] as Record<string, unknown> | undefined;
    const depth = hydro?.[date];
    if (typeof elev !== 'number' || typeof depth !== 'number') continue;
    const [x, y] = f.geometry.coordinates as [number, number];
    out.push({ x, y, z: elev - depth });
  }
  return out;
}

function computeMajorBreaks(zMin: number, zMax: number, interval: number): number[] {
  if (!Number.isFinite(interval) || interval <= 0) return [];
  const start = Math.floor(zMin / interval) * interval;
  const end = Math.ceil(zMax / interval) * interval;
  const out: number[] = [];
  for (let i = 0; ; i++) {
    const z = start + i * interval;
    if (z > end + 1e-9) break;
    if (z < zMin - 1e-9 || z > zMax + 1e-9) continue;
    out.push(Number(z.toFixed(6)));
  }
  return out;
}

function computeMinorBreaks(
  zMin: number,
  zMax: number,
  interval: number,
  divisions: number,
): number[] {
  if (!Number.isFinite(interval) || interval <= 0) return [];
  if (!Number.isFinite(divisions) || divisions < 2) return [];
  const sub = interval / divisions;
  const start = Math.floor(zMin / sub) * sub;
  const end = Math.ceil(zMax / sub) * sub;
  const out: number[] = [];
  for (let i = 0; ; i++) {
    const z = start + i * sub;
    if (z > end + 1e-9) break;
    if (z < zMin - 1e-9 || z > zMax + 1e-9) continue;
    const ratio = z / interval;
    if (Math.abs(ratio - Math.round(ratio)) < 1e-6) continue;
    out.push(Number(z.toFixed(6)));
  }
  return out;
}

function buildOutlineFeature(samples: IDWSample[], date: string): Feature | null {
  if (samples.length < 1) return null;
  const xs = samples.map((s) => s.x);
  const ys = samples.map((s) => s.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const dx = maxX - minX;
  const dy = maxY - minY;
  if (dx <= 0 || dy <= 0) return null;
  const x0 = minX - dx * 0.15;
  const x1 = maxX + dx * 0.15;
  const y0 = minY - dy * 0.15;
  const y1 = maxY + dy * 0.15;
  return {
    type: 'Feature',
    geometry: {
      type: 'LineString',
      coordinates: [
        [x0, y0],
        [x1, y0],
        [x1, y1],
        [x0, y1],
        [x0, y0],
      ],
    },
    properties: { __date: date, __kind: 'outline', __line: 'outline', 名稱: '' },
  };
}

export function buildContourFeaturesForLayer(
  sourceLayer: VectorLayer,
  date: string,
  lines?: WaterLevelLines,
  model?: ContourModel,
  contourOpts: ContourOptions = {},
  samplesOverride?: IDWSample[],
  thresholds?: ThresholdLine[],
): Feature[] {
  const samples = samplesOverride ?? collectSamplesForDate(sourceLayer, date);
  if (samples.length < 3) return [];
  const cfg: Required<WaterLevelLines> = { ...DEFAULT_LINES, ...(lines ?? {}) };
  const built = buildIDWGrid(samples, 50, model, contourOpts);
  if (!built) return [];
  const { grid, zMin, zMax } = built;
  if (zMax - zMin < 1e-9) return [];

  const out: Feature[] = [];

  const majorBreaks = computeMajorBreaks(zMin, zMax, cfg.majorInterval);
  if (majorBreaks.length > 0) {
    const majorIso = turf.isolines(grid, majorBreaks, { zProperty: 'z' });
    for (const f of majorIso.features) {
      const z = typeof f.properties?.z === 'number' ? (f.properties.z as number) : null;
      out.push({
        ...f,
        properties: {
          ...(f.properties ?? {}),
          __date: date,
          __kind: 'iso',
          __line: 'major',
          名稱: z !== null ? z.toFixed(2) : '',
        },
      });
    }
  }

  if (cfg.minorEnabled) {
    const minorBreaks = computeMinorBreaks(zMin, zMax, cfg.majorInterval, cfg.minorDivisions);
    if (minorBreaks.length > 0) {
      const minorIso = turf.isolines(grid, minorBreaks, { zProperty: 'z' });
      for (const f of minorIso.features) {
        out.push({
          ...f,
          properties: {
            ...(f.properties ?? {}),
            __date: date,
            __kind: 'iso',
            __line: 'minor',
            名稱: '',
          },
        });
      }
    }
  }

  if (cfg.outlineEnabled) {
    const outline = buildOutlineFeature(samples, date);
    if (outline) out.push(outline);
  }

  if (thresholds && thresholds.length > 0) {
    for (const t of thresholds) {
      if (!Number.isFinite(t.value) || t.value < zMin || t.value > zMax) continue;
      let tIso: FeatureCollection;
      try {
        tIso = turf.isolines(grid, [t.value], { zProperty: 'z' }) as FeatureCollection;
      } catch {
        continue;
      }
      for (const f of tIso.features) {
        out.push({
          ...f,
          properties: {
            ...(f.properties ?? {}),
            __date: date,
            __kind: 'iso',
            __line: t.kind === 'control' ? 'threshold-control' : 'threshold-monitor',
            名稱: t.label,
          },
        });
      }
    }
  }

  return out;
}

export function buildFlowArrowsForLayer(
  sourceLayer: VectorLayer,
  date: string,
  options: { gridCells?: number; model?: ContourModel; samples?: IDWSample[] } = {},
): Feature[] {
  const samples = options.samples ?? collectSamplesForDate(sourceLayer, date);
  if (samples.length < 3) return [];
  const { gridCells = 8 } = options;
  const interpolate = makeInterpolator(options.model, samples);
  const pts = turf.featureCollection(
    samples.map((s) => turf.point([s.x, s.y], { z: s.z })),
  );
  const bbox = turf.bbox(pts) as [number, number, number, number];
  const dx = bbox[2] - bbox[0];
  const dy = bbox[3] - bbox[1];
  if (dx <= 0 || dy <= 0) return [];
  const cellX = dx / gridCells;
  const cellY = dy / gridCells;
  const arrowLen = Math.min(cellX, cellY) * 0.6;
  const eps = Math.min(cellX, cellY) * 0.1;
  const headLen = arrowLen * 0.32;
  const headAngle = Math.PI / 6;
  const arrows: Feature[] = [];
  for (let i = 1; i < gridCells; i++) {
    for (let j = 1; j < gridCells; j++) {
      const x = bbox[0] + i * cellX;
      const y = bbox[1] + j * cellY;
      const gx = (interpolate(x + eps, y) - interpolate(x - eps, y)) / (2 * eps);
      const gy = (interpolate(x, y + eps) - interpolate(x, y - eps)) / (2 * eps);
      const fx = -gx;
      const fy = -gy;
      const mag = Math.sqrt(fx * fx + fy * fy);
      if (!Number.isFinite(mag) || mag < 1e-15) continue;
      const ux = (fx / mag) * arrowLen;
      const uy = (fy / mag) * arrowLen;
      const x0 = x - ux / 2;
      const y0 = y - uy / 2;
      const x1 = x + ux / 2;
      const y1 = y + uy / 2;
      const ang = Math.atan2(uy, ux);
      const hx1 = x1 - Math.cos(ang - headAngle) * headLen;
      const hy1 = y1 - Math.sin(ang - headAngle) * headLen;
      const hx2 = x1 - Math.cos(ang + headAngle) * headLen;
      const hy2 = y1 - Math.sin(ang + headAngle) * headLen;
      arrows.push({
        type: 'Feature',
        geometry: {
          type: 'MultiLineString',
          coordinates: [
            [[x0, y0], [x1, y1]],
            [[hx1, hy1], [x1, y1], [hx2, hy2]],
          ],
        },
        properties: { __date: date, __kind: 'arrow', __line: 'arrow', 名稱: '' },
      });
    }
  }
  return arrows;
}

export function getGlobalZRange(
  sourceLayer: VectorLayer,
  dates: string[],
): { zMin: number; zMax: number } | null {
  const all: number[] = [];
  for (const date of dates) {
    const samples = collectSamplesForDate(sourceLayer, date);
    for (const s of samples) all.push(s.z);
  }
  if (all.length === 0) return null;
  return { zMin: Math.min(...all), zMax: Math.max(...all) };
}

export function buildContourLayerFeatures(
  sourceLayer: VectorLayer,
  date: string,
  fill?: WaterLevelFill,
  lines?: WaterLevelLines,
  arrows?: WaterLevelArrows,
  options: { plan?: BandPlan; majorInterval?: number; model?: ContourModel; samples?: IDWSample[]; contourOpts?: ContourOptions; thresholds?: ThresholdLine[] } = {},
): Feature[] {
  const interval = options.majorInterval ?? lines?.majorInterval ?? DEFAULT_LINES.majorInterval;
  const arrowsCfg: Required<WaterLevelArrows> = { ...DEFAULT_ARROWS, ...(arrows ?? {}) };
  return [
    ...buildIsobandFeaturesForLayer(sourceLayer, date, fill, {
      plan: options.plan,
      majorInterval: interval,
      model: options.model,
      samples: options.samples,
      contourOpts: options.contourOpts,
    }),
    ...buildContourFeaturesForLayer(sourceLayer, date, lines, options.model, options.contourOpts ?? {}, options.samples, options.thresholds),
    ...(arrowsCfg.enabled
      ? buildFlowArrowsForLayer(sourceLayer, date, {
          gridCells: arrowsCfg.divisions,
          model: options.model,
          samples: options.samples,
        })
      : []),
  ];
}

export function collectGwConcSamplesForDate(
  layer: VectorLayer,
  tabId: string,
  subId: string,
  date: string,
): IDWSample[] {
  const out: IDWSample[] = [];
  for (const f of layer.data.features) {
    if (f.geometry?.type !== 'Point') continue;
    const props = (f.properties ?? {}) as Record<string, unknown>;
    const gw = props['__gwConc'] as Record<string, Record<string, Record<string, unknown>>> | undefined;
    const v = gw?.[tabId]?.[subId]?.[date];
    if (typeof v !== 'number' || !Number.isFinite(v)) continue;
    const [x, y] = f.geometry.coordinates as [number, number];
    out.push({ x, y, z: v });
  }
  return out;
}

function rebuildContourLayer(target: VectorLayer, source: VectorLayer): VectorLayer {
  const wl = target.waterLevel!;
  const interval = wl.lines?.majorInterval ?? DEFAULT_LINES.majorInterval;
  const contourOpts: ContourOptions = {
    logTransform: wl.logTransform,
    clampNegative: wl.clampNegative,
    indicatorThreshold: wl.indicatorThreshold,
  };
  const isMultiSub = wl.sourceKind === 'gw-conc' && !!wl.sourceTabId && !!wl.substances && wl.substances.length > 0;
  const isSingleGwConc = wl.sourceKind === 'gw-conc' && !!wl.sourceTabId && !!wl.sourceSubId && !isMultiSub;

  if (isMultiSub) {
    const tab = source.gwConcTabs?.find((t) => t.id === wl.sourceTabId);
    const allFeats: Feature[] = [];
    for (const subRef of wl.substances!) {
      const sub = tab?.substances.find((s) => s.id === subRef.id);
      if (!sub) continue;
      const thresholds: ThresholdLine[] = [];
      if (typeof sub.controlConc === 'number') {
        thresholds.push({ value: sub.controlConc, kind: 'control', label: '管制濃度標準' });
      }
      if (typeof sub.monitorConc === 'number') {
        thresholds.push({ value: sub.monitorConc, kind: 'monitor', label: '監測濃度標準' });
      }
      const subDefaults = makeGwConcDefaultsForSub(sub);
      const subOpts: ContourOptions = {
        ...contourOpts,
        indicatorThreshold:
          wl.model === 'indicator' ? sub.controlConc : contourOpts.indicatorThreshold,
      };
      for (const date of wl.dates) {
        const samples = collectGwConcSamplesForDate(source, wl.sourceTabId!, sub.id, date);
        if (samples.length < 3) continue;
        const feats = buildContourLayerFeatures(source, date, subDefaults.fill, subDefaults.lines, wl.arrows, {
          majorInterval: subDefaults.lines?.majorInterval ?? interval,
          model: wl.model,
          samples,
          contourOpts: subOpts,
          thresholds,
        });
        for (const f of feats) {
          allFeats.push({
            ...f,
            properties: {
              ...(f.properties ?? {}),
              __substance: sub.id,
              __substanceName: sub.name,
            },
          });
        }
      }
    }
    return {
      ...target,
      data: { type: 'FeatureCollection', features: allFeats } as FeatureCollection,
      featureCount: allFeats.length,
    };
  }

  let thresholds: ThresholdLine[] | undefined;
  if (isSingleGwConc) {
    const tab = source.gwConcTabs?.find((t) => t.id === wl.sourceTabId);
    const sub = tab?.substances.find((s) => s.id === wl.sourceSubId);
    if (sub) {
      thresholds = [];
      if (typeof sub.controlConc === 'number') {
        thresholds.push({ value: sub.controlConc, kind: 'control', label: '管制濃度標準' });
      }
      if (typeof sub.monitorConc === 'number') {
        thresholds.push({ value: sub.monitorConc, kind: 'monitor', label: '監測濃度標準' });
      }
    }
  }
  const allFeats: Feature[] = [];
  let plan: BandPlan | null = null;
  if (wl.fill && wl.fill.mode !== 'none' && !isSingleGwConc) {
    const range = getGlobalZRange(source, wl.dates);
    if (range) plan = planBands(range.zMin, range.zMax, wl.fill, interval);
  }
  for (const date of wl.dates) {
    const samples = isSingleGwConc
      ? collectGwConcSamplesForDate(source, wl.sourceTabId!, wl.sourceSubId!, date)
      : undefined;
    const feats = buildContourLayerFeatures(source, date, wl.fill, wl.lines, wl.arrows, {
      plan: plan ?? undefined,
      majorInterval: interval,
      model: wl.model,
      samples,
      contourOpts,
      thresholds,
    });
    allFeats.push(...feats);
  }
  return {
    ...target,
    data: { type: 'FeatureCollection', features: allFeats } as FeatureCollection,
    featureCount: allFeats.length,
  };
}

function makeGwConcDefaultsForSub(sub: { controlConc?: number; monitorConc?: number }): {
  fill: WaterLevelFill | undefined;
  lines: WaterLevelLines | undefined;
} {
  const M = sub.monitorConc;
  const C = sub.controlConc;
  const lines: WaterLevelLines | undefined =
    typeof M === 'number' && M > 0 ? { majorInterval: M / 4 } : undefined;
  let fill: WaterLevelFill | undefined;
  if (typeof M === 'number' && typeof C === 'number' && M > 0 && C > M) {
    const eps = M * 0.0001;
    fill = {
      mode: 'custom',
      opacity: 0.6,
      bands: [
        { from: 0, to: eps, color: '#ffffff' },
        { from: eps, to: M / 2, color: '#22c55e' },
        { from: M / 2, to: M, color: '#eab308' },
        { from: M, to: C, color: '#f97316' },
        { from: C, to: 1e9, color: '#ef4444' },
      ],
    };
  }
  return { fill, lines };
}

export function syncContoursForSource(
  layers: VectorLayer[],
  sourceId: string,
): VectorLayer[] {
  const source = layers.find((l) => l.id === sourceId);
  if (!source || source.waterLevel) return layers;
  return layers.map((l) => {
    if (l.waterLevel?.sourceLayerId !== sourceId) return l;
    return rebuildContourLayer(l, source);
  });
}

export function syncSingleContour(
  layers: VectorLayer[],
  contourId: string,
): VectorLayer[] {
  const target = layers.find((l) => l.id === contourId);
  if (!target?.waterLevel?.sourceLayerId) return layers;
  const source = layers.find((l) => l.id === target.waterLevel!.sourceLayerId);
  if (!source) return layers;
  const rebuilt = rebuildContourLayer(target, source);
  return layers.map((l) => (l.id === contourId ? rebuilt : l));
}

export function syncAllContours(layers: VectorLayer[]): VectorLayer[] {
  let next = layers;
  for (const l of layers) {
    if (l.waterLevel) continue;
    next = syncContoursForSource(next, l.id);
  }
  return next;
}

export function sourceFingerprint(source: VectorLayer): string {
  const parts: string[] = [];
  for (const f of source.data.features) {
    if (f.geometry?.type !== 'Point') continue;
    const props = (f.properties ?? {}) as Record<string, unknown>;
    const [x, y] = f.geometry.coordinates as [number, number];
    const elev = props['高程'];
    const hydro = (props['__hydro'] as Record<string, unknown>) ?? {};
    parts.push(`${x},${y},${elev},${JSON.stringify(hydro)}`);
  }
  return parts.join('|');
}
