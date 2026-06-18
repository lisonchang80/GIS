import type { Feature, FeatureCollection } from 'geojson';
import type {
  ExceedanceBatch,
  ExceedanceLevel,
  GwConcSubstance,
  SoilConcTab,
  VectorLayer,
} from './types';
import { SOIL_BATCH_KEY } from './types';
import { shapeForIndex } from './pointShapes';

export const EXCEEDANCE_COLORS = {
  alert: '#dc2626', // 超管制標準
  warn: '#f59e0b', // 超監測標準
  ok: '#16a34a', // 合格
  nodata: '#9ca3af', // 無資料
} as const;

export const EXCEEDANCE_LABELS: Record<ExceedanceLevel, string> = {
  alert: '超管制標準',
  warn: '超監測標準',
  ok: '合格',
  nodata: '無資料',
};

export function classifyExceedance(
  v: number | null,
  control?: number,
  monitor?: number,
): ExceedanceLevel {
  if (v === null || !Number.isFinite(v)) return 'nodata';
  if (typeof control === 'number' && v >= control) return 'alert';
  if (typeof monitor === 'number' && v >= monitor) return 'warn';
  return 'ok';
}

// 土壤濃度無時間維度：每點每物質單一值 __soilConc[tabId][subId]
export function readSoilConc(feature: Feature, tabId: string, subId: string): number | null {
  const props = (feature.properties ?? {}) as Record<string, unknown>;
  const soil = props['__soilConc'] as Record<string, Record<string, unknown>> | undefined;
  const v = soil?.[tabId]?.[subId];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export function batchOf(feature: Feature): string {
  const props = (feature.properties ?? {}) as Record<string, unknown>;
  const v = props[SOIL_BATCH_KEY];
  return v == null ? '' : String(v).trim();
}

// 蒐集圖層中所有非空批次名稱（依出現順序）
export function collectBatches(layer: VectorLayer): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const f of layer.data.features) {
    if (f.geometry?.type !== 'Point') continue;
    const b = batchOf(f);
    if (b && !seen.has(b)) {
      seen.add(b);
      out.push(b);
    }
  }
  return out;
}

// 為每個點位 × 物質生成一個分級後的點 feature（批次存進 __batch）
export function buildExceedancePoints(
  source: VectorLayer,
  tab: SoilConcTab,
  subs: GwConcSubstance[],
): Feature[] {
  const out: Feature[] = [];
  for (const f of source.data.features) {
    if (f.geometry?.type !== 'Point') continue;
    const [lng, lat] = f.geometry.coordinates as [number, number];
    const props = (f.properties ?? {}) as Record<string, unknown>;
    const name = props['名稱'];
    const batch = batchOf(f);
    for (const sub of subs) {
      const v = readSoilConc(f, tab.id, sub.id);
      const level = classifyExceedance(v, sub.controlConc, sub.monitorConc);
      out.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [lng, lat] },
        properties: {
          ...(name != null ? { 名稱: name } : {}),
          __batch: batch,
          __substance: sub.id,
          __substanceName: sub.name,
          __exLevel: level,
          __conc: v,
          __unit: sub.unit ?? '',
        },
      });
    }
  }
  return out;
}

// 合併既有批次設定（保留形狀/勾選）與來源最新批次清單
export function reconcileBatches(existing: ExceedanceBatch[], names: string[]): ExceedanceBatch[] {
  const byName = new Map(existing.map((b) => [b.name, b]));
  return names.map((name, i) => byName.get(name) ?? { name, shape: shapeForIndex(i), visible: true });
}

function resolveSubs(ex: NonNullable<VectorLayer['exceedance']>, tab: SoilConcTab): GwConcSubstance[] {
  if (ex.substances && ex.substances.length > 0) {
    return ex.substances
      .map((r) => tab.substances.find((s) => s.id === r.id))
      .filter((s): s is GwConcSubstance => !!s);
  }
  if (ex.sourceSubId) {
    const s = tab.substances.find((x) => x.id === ex.sourceSubId);
    return s ? [s] : [];
  }
  return [];
}

function rebuildExceedanceLayer(target: VectorLayer, source: VectorLayer): VectorLayer {
  const ex = target.exceedance!;
  const tab = source.soilConcTabs?.find((t) => t.id === ex.sourceTabId);
  if (!tab) return target;
  const subs = resolveSubs(ex, tab);
  const features = buildExceedancePoints(source, tab, subs);
  const nextSubstances = ex.substances
    ? ex.substances.map((r) => {
        const s = tab.substances.find((x) => x.id === r.id);
        return s ? { id: s.id, name: s.name } : r;
      })
    : ex.substances;
  const nextBatches = reconcileBatches(ex.batches, collectBatches(source));
  return {
    ...target,
    data: { type: 'FeatureCollection', features } as FeatureCollection,
    featureCount: features.length,
    exceedance: { ...ex, substances: nextSubstances, batches: nextBatches },
  };
}

export function syncExceedanceForSource(
  layers: VectorLayer[],
  sourceId: string,
): VectorLayer[] {
  const source = layers.find((l) => l.id === sourceId);
  if (!source || source.exceedance) return layers;
  return layers.map((l) =>
    l.exceedance?.sourceLayerId === sourceId ? rebuildExceedanceLayer(l, source) : l,
  );
}

export function syncAllExceedance(layers: VectorLayer[]): VectorLayer[] {
  let next = layers;
  for (const l of layers) {
    if (l.exceedance) continue;
    next = syncExceedanceForSource(next, l.id);
  }
  return next;
}
