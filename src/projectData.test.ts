import { describe, expect, it, vi } from 'vitest';
import type { GeoJSONStoreFeatures } from 'terra-draw';
import { DEFAULT_BASEMAP, buildProjectPayload, prepareProject, type PreparedProject } from './projectData';
import type { ProjectState } from './persistence';
import type { VectorLayer } from './types';

const WELLS: VectorLayer = {
  id: 'src',
  name: '井位',
  visible: true,
  opacity: 1,
  color: '#000000',
  kind: 'point',
  featureCount: 3,
  data: {
    type: 'FeatureCollection',
    features: [
      [121.0, 25.0, 10],
      [121.001, 25.0, 9],
      [121.0, 25.001, 8],
    ].map(([x, y, z]) => ({
      type: 'Feature' as const,
      geometry: { type: 'Point' as const, coordinates: [x, y] },
      properties: { name: `W${z}`, 高程: z, __hydro: { d: 0 } },
    })),
  },
};

const CONTOUR: VectorLayer = {
  id: 'wl',
  name: '等水位線',
  visible: true,
  opacity: 1,
  color: '#1d4ed8',
  kind: 'line',
  featureCount: 0,
  data: { type: 'FeatureCollection', features: [] }, // 存檔裡的衍生 features 是空的，要在準備時重建
  waterLevel: { dates: ['d'], activeDate: 'd', sourceLayerId: 'src', model: 'idw', lines: { majorInterval: 0.5 } },
};

function project(over: Partial<ProjectState> = {}): ProjectState {
  return {
    version: 1,
    savedAt: '2026-11-07T00:00:00Z',
    basemapId: 'osm',
    projectName: 'B',
    layers: [WELLS, CONTOUR],
    layerGroups: [{ id: 'g', name: '群組' }],
    drawings: [],
    mapView: { center: [121, 25], zoom: 15 },
    colorCursor: 3,
    ...over,
  };
}

describe('prepareProject（審查 GIS-1）', () => {
  it('準備好全部要套用的狀態，衍生圖層已重建', () => {
    const p = prepareProject(project());
    expect(p.projectName).toBe('B');
    expect(p.basemapId).toBe('osm');
    expect(p.colorCursor).toBe(3);
    expect(p.layerGroups).toEqual([{ id: 'g', name: '群組' }]);
    expect(p.mapView).toEqual({ center: [121, 25], zoom: 15 });
    const wl = p.layers.find((l) => l.id === 'wl')!;
    expect(wl.data.features.some((f) => f.properties?.__line === 'major')).toBe(true);
    // ensureNames：名稱欄補齊
    expect(p.layers[0].data.features[0].properties?.['名稱']).toBe('W10');
  });

  it('不改動傳入的專案物件', () => {
    const input = project();
    const before = JSON.stringify(input);
    prepareProject(input);
    expect(JSON.stringify(input)).toBe(before);
  });

  it('null（空專案）回傳預設值', () => {
    const p = prepareProject(null);
    expect(p.source).toBeNull();
    expect(p.basemapId).toBe(DEFAULT_BASEMAP);
    expect(p.layers).toEqual([]);
    expect(p.projectName).toBe('未命名專案');
  });

  const broken: Array<[string, unknown]> = [
    ['缺 layers', { version: 1, basemapId: 'osm' }],
    ['layers 不是陣列', { version: 1, basemapId: 'osm', layers: {} }],
    ['圖層是 null', { version: 1, basemapId: 'osm', layers: [null] }],
    ['圖層缺 data', { version: 1, basemapId: 'osm', layers: [{ id: 'a' }] }],
    ['data.features 不是陣列', { version: 1, basemapId: 'osm', layers: [{ id: 'a', data: { type: 'FeatureCollection' } }] }],
    ['feature 是 null', { version: 1, basemapId: 'osm', layers: [{ id: 'a', data: { type: 'FeatureCollection', features: [null] } }] }],
    ['layerGroups 不是陣列', { version: 1, basemapId: 'osm', layers: [], layerGroups: 'x' }],
    ['drawings 不是陣列', { version: 1, basemapId: 'osm', layers: [], drawings: {} }],
  ];

  it.each(broken)('%s → 丟例外', (_label, bad) => {
    expect(() => prepareProject(bad as ProjectState)).toThrow(/專案資料格式錯誤/);
  });

  it('衍生圖層重建丟例外時整個準備失敗，呼叫端還沒套用任何狀態', () => {
    // 井位的 coordinates 是空陣列：turf 在重建等水位線時丟 "coordinates must contain numbers"
    const badWells: VectorLayer = {
      ...WELLS,
      data: {
        ...WELLS.data,
        features: [
          ...WELLS.data.features,
          { type: 'Feature', geometry: { type: 'Point', coordinates: [] }, properties: { 高程: 5, __hydro: { d: 0 } } },
        ],
      },
    };
    const apply = vi.fn<(p: PreparedProject) => void>();
    expect(() => apply(prepareProject(project({ layers: [badWells, CONTOUR] })))).toThrow();
    expect(apply).not.toHaveBeenCalled();
  });

  it('不認得的底圖與壞掉的視角改用預設，不讓地圖 jumpTo 丟例外', () => {
    const p = prepareProject(
      project({ basemapId: 'nope' as ProjectState['basemapId'], mapView: { center: [Number.NaN, 1] as [number, number], zoom: 3 } }),
    );
    expect(p.basemapId).toBe(DEFAULT_BASEMAP);
    expect(p.mapView).toBeUndefined();
  });
});

describe('buildProjectPayload（審查 GIS-12：自動存檔不覆蓋雲端專案）', () => {
  const state = {
    basemapId: 'osm' as const,
    basemapVersionIndex: 0,
    basemapOpacity: 1,
    projectName: 'B',
    layers: [WELLS],
    layerGroups: [],
    colorCursor: 2,
  };
  const drawing = { id: 'd1', type: 'Feature', geometry: { type: 'Point', coordinates: [1, 2] }, properties: { mode: 'point' } } as GeoJSONStoreFeatures;
  const pending = prepareProject(project({ layers: [WELLS], drawings: [drawing] }));

  it('地圖／繪圖工具還沒就緒：沿用載入時的 drawings 與 mapView，不存成空的', () => {
    const p = buildProjectPayload(state, { drawings: null, mapView: null }, pending);
    expect(p.drawings).toEqual([drawing]);
    expect(p.mapView).toEqual({ center: [121, 25], zoom: 15 });
  });

  it('就緒之後用即時的內容（包括使用者清空的繪圖）', () => {
    const p = buildProjectPayload(state, { drawings: [], mapView: { center: [120, 23], zoom: 8 } }, pending);
    expect(p.drawings).toEqual([]);
    expect(p.mapView).toEqual({ center: [120, 23], zoom: 8 });
  });

  it('帶上所有狀態欄位', () => {
    const p = buildProjectPayload(state, { drawings: [], mapView: null }, null);
    expect(p).toMatchObject({ basemapId: 'osm', projectName: 'B', layers: [WELLS], layerGroups: [], colorCursor: 2, drawings: [] });
    expect(p.mapView).toBeUndefined();
  });
});
