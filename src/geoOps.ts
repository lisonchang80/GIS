import * as turf from '@turf/turf';
import type { Feature, FeatureCollection } from 'geojson';
import type { VectorLayer } from './types';
import { detectKind, ensureNames } from './importers';

export type BufferUnits = 'meters' | 'kilometers';

export function bufferLayer(
  layer: VectorLayer,
  distance: number,
  units: BufferUnits,
): FeatureCollection {
  if (!Number.isFinite(distance)) throw new Error('距離必須是數字');
  if (distance === 0) throw new Error('距離不能為 0');
  const out: Feature[] = [];
  for (const f of layer.data.features) {
    if (!f.geometry) continue;
    const result = turf.buffer(f as Feature, distance, { units });
    if (!result || !result.geometry) continue;
    out.push({ ...result, properties: { ...(f.properties ?? {}) } });
  }
  if (out.length === 0) throw new Error('沒有產生任何 buffer 結果');
  return { type: 'FeatureCollection', features: out };
}

export function fcToLayer(fc: FeatureCollection, name: string, color: string): VectorLayer {
  const data = ensureNames(fc);
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name,
    visible: true,
    opacity: 0.85,
    color,
    kind: detectKind(data),
    data,
    featureCount: data.features.length,
  };
}
