import { describe, expect, it } from 'vitest';
import type { Feature } from 'geojson';
import {
  MAX_MAJOR_LINES,
  MAX_MINOR_LINES,
  buildContourFeaturesForLayer,
  capContourIntervals,
  syncSingleContour,
  type IDWSample,
} from './contour';
import type { VectorLayer } from './types';

// 審查 GIS-4：主線級距沒有數量上限。8 口井、一口熱點 12、其餘 ≤0.05，
// 級距 0.0025（多污染物預設 M/4，M=0.01）時每個日期約 4800 條主線、13 MB。
const HOTSPOT: IDWSample[] = [
  { x: 121.0, y: 25.0, z: 12 },
  { x: 121.001, y: 25.0, z: 0.05 },
  { x: 121.002, y: 25.0005, z: 0.01 },
  { x: 121.0, y: 25.001, z: 0.02 },
  { x: 121.001, y: 25.0015, z: 0.03 },
  { x: 121.002, y: 25.002, z: 0.0 },
  { x: 121.0005, y: 25.002, z: 0.04 },
  { x: 121.0015, y: 25.0005, z: 0.01 },
];

const EMPTY_SOURCE = {
  id: 'src',
  name: 'wells',
  visible: true,
  opacity: 1,
  color: '#000000',
  kind: 'point',
  featureCount: 0,
  data: { type: 'FeatureCollection', features: [] },
} as VectorLayer;

function levels(feats: Feature[], line: string): number[] {
  const zs = feats
    .filter((f) => f.properties?.__line === line)
    .map((f) => f.properties?.z as number);
  return [...new Set(zs)].sort((a, b) => a - b);
}

describe('capContourIntervals', () => {
  it('不超過上限時原樣使用使用者的級距', () => {
    expect(capContourIntervals(0, 10, 0.5, 4)).toEqual({ majorInterval: 0.5, minorDivisions: 4, capped: false });
  });

  it('超過 200 條主線時放大到 nice number 的級距', () => {
    const r = capContourIntervals(0, 12, 0.0025, 4);
    expect(r.capped).toBe(true);
    expect(r.majorInterval).toBeGreaterThan(0.0025);
    // nice number：1、2、2.5、5 乘以 10 的次方
    const mantissa = r.majorInterval / 10 ** Math.floor(Math.log10(r.majorInterval));
    expect([1, 2, 2.5, 5].some((m) => Math.abs(m - mantissa) < 1e-9)).toBe(true);
    const count = Math.floor(12 / r.majorInterval) + 1;
    expect(count).toBeLessThanOrEqual(MAX_MAJOR_LINES);
  });

  it('副線總數不超過 800 條（＝主線上限 200 × 4）', () => {
    expect(MAX_MINOR_LINES).toBe(800);
    const r = capContourIntervals(0, 199, 1, 10); // 199 個間隔 × 9 條副線 = 1791
    expect(r.majorInterval).toBe(1);
    expect(r.minorDivisions).toBeLessThan(10);
    expect(199 * (r.minorDivisions - 1)).toBeLessThanOrEqual(MAX_MINOR_LINES);
    expect(r.capped).toBe(true);
  });
});

describe('buildContourFeaturesForLayer：主線／副線數量上限', () => {
  it('峰值 12、級距 0.0025：主線不超過 200 條，並回報實際採用的級距', () => {
    let cap: { majorInterval: number; minorDivisions: number } | undefined;
    const feats = buildContourFeaturesForLayer(
      EMPTY_SOURCE,
      'd',
      { majorInterval: 0.0025, minorEnabled: true, minorDivisions: 10 },
      'idw',
      {},
      HOTSPOT,
      undefined,
      undefined,
      (info) => {
        cap = info;
      },
    );
    const major = levels(feats, 'major');
    expect(major.length).toBeGreaterThan(10);
    expect(major.length).toBeLessThanOrEqual(MAX_MAJOR_LINES);
    expect(levels(feats, 'minor').length).toBeLessThanOrEqual(MAX_MINOR_LINES);
    expect(cap?.majorInterval).toBeGreaterThan(0.0025);
  });

  it('級距合理時不回報放大', () => {
    let called = false;
    buildContourFeaturesForLayer(EMPTY_SOURCE, 'd', { majorInterval: 1 }, 'idw', {}, HOTSPOT, undefined, undefined, () => {
      called = true;
    });
    expect(called).toBe(false);
  });
});

describe('等水位線圖層：放大級距時不回寫使用者設定、在圖層上標記', () => {
  const source: VectorLayer = {
    ...EMPTY_SOURCE,
    data: {
      type: 'FeatureCollection',
      features: HOTSPOT.map((s) => ({
        type: 'Feature' as const,
        geometry: { type: 'Point' as const, coordinates: [s.x, s.y] },
        properties: { 名稱: '', 高程: s.z, __hydro: { d: 0 } },
      })),
    },
    featureCount: HOTSPOT.length,
  };
  const contour = (majorInterval: number): VectorLayer => ({
    ...EMPTY_SOURCE,
    id: 'wl',
    name: '等水位線',
    kind: 'line',
    waterLevel: { dates: ['d'], activeDate: 'd', sourceLayerId: 'src', model: 'idw', lines: { majorInterval } },
  });

  it('太密：layer.contourCap 記下設定值與實際值，lines.majorInterval 不變', () => {
    const out = syncSingleContour([source, contour(0.001)], 'wl').find((l) => l.id === 'wl')!;
    expect(out.waterLevel?.lines?.majorInterval).toBe(0.001);
    const cap = out.contourCap?.['*'];
    expect(cap?.requestedInterval).toBe(0.001);
    expect(cap?.effectiveInterval).toBeGreaterThan(0.001);
    expect(levels(out.data.features, 'major').length).toBeLessThanOrEqual(MAX_MAJOR_LINES);
  });

  it('改回合理級距後標記消失', () => {
    const capped = syncSingleContour([source, contour(0.001)], 'wl');
    const relaxed = capped.map((l) => (l.id === 'wl' ? { ...l, waterLevel: { ...l.waterLevel!, lines: { majorInterval: 1 } } } : l));
    const out = syncSingleContour(relaxed, 'wl').find((l) => l.id === 'wl')!;
    expect(out.contourCap).toBeUndefined();
  });
});
