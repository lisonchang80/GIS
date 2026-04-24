import type { FeatureCollection } from 'geojson';

export type BaseMapId =
  | 'osm'
  | 'satellite-esri'
  | 'satellite-esri-clarity'
  | 'satellite-google'
  | 'hybrid-google'
  | 'terrain'
  | 'dark';

export interface BaseMapOption {
  id: BaseMapId;
  name: string;
  tiles: string[];
  attribution: string;
  maxzoom?: number;
}

export type LayerKind = 'point' | 'line' | 'polygon' | 'mixed';

export interface VectorLayer {
  id: string;
  name: string;
  visible: boolean;
  opacity: number;
  color: string;
  strokeColor?: string;
  strokeWidth?: number;
  pointRadius?: number;
  kind: LayerKind;
  data: FeatureCollection;
  featureCount: number;
}
