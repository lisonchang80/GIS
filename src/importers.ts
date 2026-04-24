import type { Feature, FeatureCollection, Geometry } from 'geojson';
import shp from 'shpjs';
import toGeoJSON from '@mapbox/togeojson';
import type { LayerKind } from './types';

export async function fileToGeoJSON(file: File): Promise<FeatureCollection> {
  const name = file.name.toLowerCase();

  if (name.endsWith('.geojson') || name.endsWith('.json')) {
    const text = await file.text();
    return normalize(JSON.parse(text));
  }

  if (name.endsWith('.kml')) {
    const text = await file.text();
    const dom = new DOMParser().parseFromString(text, 'text/xml');
    return normalize(toGeoJSON.kml(dom));
  }

  if (name.endsWith('.gpx')) {
    const text = await file.text();
    const dom = new DOMParser().parseFromString(text, 'text/xml');
    return normalize(toGeoJSON.gpx(dom));
  }

  if (name.endsWith('.zip') || name.endsWith('.shp')) {
    const buffer = await file.arrayBuffer();
    const result = await shp(buffer);
    const fc = Array.isArray(result) ? mergeCollections(result) : result;
    return normalize(fc as FeatureCollection);
  }

  throw new Error(`不支援的檔案格式: ${file.name}`);
}

function mergeCollections(list: FeatureCollection[]): FeatureCollection {
  const features: Feature[] = [];
  for (const fc of list) features.push(...fc.features);
  return { type: 'FeatureCollection', features };
}

function normalize(input: unknown): FeatureCollection {
  const obj = input as { type?: string; features?: Feature[] };
  if (obj.type === 'FeatureCollection' && Array.isArray(obj.features)) {
    return obj as FeatureCollection;
  }
  if (obj.type === 'Feature') {
    return { type: 'FeatureCollection', features: [obj as Feature] };
  }
  throw new Error('檔案內容不是有效的 GeoJSON');
}

export function detectKind(fc: FeatureCollection): LayerKind {
  const types = new Set<string>();
  for (const f of fc.features) {
    if (!f.geometry) continue;
    types.add(f.geometry.type);
  }
  const hasPoint = types.has('Point') || types.has('MultiPoint');
  const hasLine = types.has('LineString') || types.has('MultiLineString');
  const hasPoly = types.has('Polygon') || types.has('MultiPolygon');
  const count = [hasPoint, hasLine, hasPoly].filter(Boolean).length;
  if (count > 1) return 'mixed';
  if (hasPoint) return 'point';
  if (hasLine) return 'line';
  if (hasPoly) return 'polygon';
  return 'mixed';
}

export function defaultFeatureName(feature: Feature, index: number): string {
  const t = feature.geometry?.type;
  if (t === 'Point' || t === 'MultiPoint') return `點 ${index + 1}`;
  if (t === 'LineString' || t === 'MultiLineString') return `線 ${index + 1}`;
  if (t === 'Polygon' || t === 'MultiPolygon') return `面 ${index + 1}`;
  return `項目 ${index + 1}`;
}

export function ensureNames(fc: FeatureCollection): FeatureCollection {
  return {
    ...fc,
    features: fc.features.map((f) => {
      const orig = { ...(f.properties ?? {}) } as Record<string, unknown>;
      const existing = orig['名稱'];
      const name =
        existing !== undefined && existing !== null && existing !== ''
          ? existing
          : (orig['name'] as unknown) ??
            (orig['NAME'] as unknown) ??
            (orig['Name'] as unknown) ??
            (orig['title'] as unknown) ??
            '';
      delete orig['名稱'];
      return { ...f, properties: { 名稱: name, ...orig } };
    }),
  };
}

export function geometryBounds(fc: FeatureCollection): [number, number, number, number] | null {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  const visit = (geom: Geometry) => {
    if (geom.type === 'Point') extend(geom.coordinates as number[]);
    else if (geom.type === 'MultiPoint' || geom.type === 'LineString')
      (geom.coordinates as number[][]).forEach(extend);
    else if (geom.type === 'MultiLineString' || geom.type === 'Polygon')
      (geom.coordinates as number[][][]).forEach((ring) => ring.forEach(extend));
    else if (geom.type === 'MultiPolygon')
      (geom.coordinates as number[][][][]).forEach((poly) =>
        poly.forEach((ring) => ring.forEach(extend)),
      );
    else if (geom.type === 'GeometryCollection') geom.geometries.forEach(visit);
  };
  const extend = (c: number[]) => {
    if (c[0] < minX) minX = c[0];
    if (c[1] < minY) minY = c[1];
    if (c[0] > maxX) maxX = c[0];
    if (c[1] > maxY) maxY = c[1];
  };
  for (const f of fc.features) if (f.geometry) visit(f.geometry);
  if (!isFinite(minX)) return null;
  return [minX, minY, maxX, maxY];
}
