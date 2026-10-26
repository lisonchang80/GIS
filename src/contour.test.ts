import { describe, expect, it } from 'vitest';
import {
  areaAboveThreshold,
  buildContourFeaturesForLayer,
  buildContourLayerFeatures,
  buildIDWGrid,
  buildIsobandFeaturesForLayer,
  type ContourModel,
  type IDWSample,
} from './contour';
import type { VectorLayer } from './types';

const MODELS: ContourModel[] = ['idw', 'tin', 'kriging', 'indicator'];
const SOURCE = {
  id: 'src',
  name: 'wells',
  visible: true,
  opacity: 1,
  color: '#000000',
  kind: 'point',
  featureCount: 0,
  data: { type: 'FeatureCollection', features: [] },
} as VectorLayer;
const GRADIENT = { mode: 'gradient' as const, gradient: { from: '#cce6ff', to: '#003366' } };

function contours(samples: IDWSample[], model: ContourModel, majorInterval = 0.5) {
  return buildContourLayerFeatures(SOURCE, 'd', GRADIENT, { majorInterval }, { enabled: true }, {
    model,
    samples,
    majorInterval,
    contourOpts: { indicatorThreshold: 5 },
  });
}

describe('buildIDWGrid / contours: 線狀場址（東西長、南北窄）', () => {
  // 三口井沿東西向道路：東西約 1 km、南北只差 11 m。格網大小只依寬度決定時，
  // 高度不到一格 → 1×N 格網 → turf.isolines 丟 "Matrix of points must be at least 2x2"，
  // 整個 App 卡在「載入專案…」。
  const roadside: IDWSample[] = [
    { x: 120.0, y: 23.0, z: 8 },
    { x: 120.005, y: 23.0001, z: 7 },
    { x: 120.01, y: 23.0, z: 6 },
  ];

  it.each(MODELS)('%s：不丟例外且畫得出等值線', (model) => {
    let feats: ReturnType<typeof contours> = [];
    expect(() => {
      feats = contours(roadside, model);
    }).not.toThrow();
    if (model !== 'indicator') {
      expect(feats.some((f) => f.properties?.__line === 'major')).toBe(true);
    }
  });

  it('格網至少 2×2，且等水位線跨越井的水位範圍', () => {
    const built = buildIDWGrid(roadside, 50, 'idw')!;
    const ys = new Set(built.grid.features.map((f) => f.geometry.coordinates[1]));
    const xs = new Set(built.grid.features.map((f) => f.geometry.coordinates[0]));
    expect(ys.size).toBeGreaterThanOrEqual(2);
    expect(xs.size).toBeGreaterThanOrEqual(2);
    const levels = buildContourFeaturesForLayer(SOURCE, 'd', { majorInterval: 0.5 }, 'idw', {}, roadside)
      .filter((f) => f.properties?.__line === 'major')
      .map((f) => Number(f.properties?.名稱));
    expect(Math.min(...levels)).toBeGreaterThanOrEqual(6);
    expect(Math.max(...levels)).toBeLessThanOrEqual(8);
  });

  it('南北長、東西不到 1 m 的點列也不丟例外', () => {
    const narrow: IDWSample[] = [
      { x: 120.0, y: 23.0, z: 1 },
      { x: 120.000005, y: 23.005, z: 2 },
      { x: 120.0, y: 23.01, z: 3 },
    ];
    for (const model of MODELS) expect(() => contours(narrow, model)).not.toThrow();
  });

  it('色帶與超標面積也不丟例外', () => {
    for (const model of MODELS) {
      expect(() =>
        buildIsobandFeaturesForLayer(SOURCE, 'd', GRADIENT, { model, samples: roadside, majorInterval: 0.5 }),
      ).not.toThrow();
      expect(areaAboveThreshold(roadside, 7, model)).toBeGreaterThan(0);
    }
  });
});

describe('既有的邊界情況（回歸）', () => {
  it('少於 3 點、完全共線（水平）、全部同一點：不產生等值線、不丟例外', () => {
    const cases: IDWSample[][] = [
      [{ x: 120, y: 23, z: 1 }, { x: 120.01, y: 23.01, z: 9 }],
      [{ x: 120, y: 23, z: 1 }, { x: 120.005, y: 23, z: 5 }, { x: 120.01, y: 23, z: 9 }],
      [{ x: 120, y: 23, z: 1 }, { x: 120, y: 23, z: 2 }, { x: 120, y: 23, z: 3 }],
    ];
    for (const samples of cases) {
      for (const model of MODELS) {
        expect(buildIDWGrid(samples, 50, model)).toBeNull();
        expect(contours(samples, model)).toEqual([]);
      }
    }
  });

  it('斜向共線的點：格網值有限且落在樣本範圍內', () => {
    const diag: IDWSample[] = [
      { x: 120, y: 23, z: 1 },
      { x: 120.005, y: 23.005, z: 5 },
      { x: 120.01, y: 23.01, z: 9 },
    ];
    for (const model of ['idw', 'tin', 'kriging'] as ContourModel[]) {
      const zs = buildIDWGrid(diag, 50, model)!.grid.features.map((f) => f.properties!.z as number);
      expect(zs.every(Number.isFinite)).toBe(true);
      expect(Math.min(...zs)).toBeGreaterThanOrEqual(1 - 1e-9);
      expect(Math.max(...zs)).toBeLessThanOrEqual(9 + 1e-9);
    }
  });

  it.each([1, 1e5, 1e-4])('重複座標（量級 %s）：Kriging 不爆掉、值仍在樣本範圍內', (scale) => {
    const dup: IDWSample[] = [
      { x: 120, y: 23, z: 1 * scale },
      { x: 120, y: 23, z: 3 * scale },
      { x: 120.01, y: 23, z: 9 * scale },
      { x: 120, y: 23.01, z: 4 * scale },
      { x: 120.01, y: 23.01, z: 2 * scale },
    ];
    for (const model of ['idw', 'tin', 'kriging'] as ContourModel[]) {
      const zs = buildIDWGrid(dup, 50, model)!.grid.features.map((f) => f.properties!.z as number);
      expect(zs.every(Number.isFinite)).toBe(true);
      expect(Math.min(...zs)).toBeGreaterThanOrEqual(1 * scale * (1 - 1e-9));
      expect(Math.max(...zs)).toBeLessThanOrEqual(9 * scale * (1 + 1e-9));
    }
  });

  it('所有點同值：不畫等值線', () => {
    const flat: IDWSample[] = [
      { x: 120, y: 23, z: 5 },
      { x: 120.01, y: 23, z: 5 },
      { x: 120, y: 23.01, z: 5 },
    ];
    for (const model of ['idw', 'tin', 'kriging'] as ContourModel[]) {
      expect(buildContourFeaturesForLayer(SOURCE, 'd', { majorInterval: 0.5 }, model, {}, flat)).toEqual([]);
    }
  });
});
