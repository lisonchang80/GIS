import type { FeatureCollection } from 'geojson';

export type BaseMapId =
  | 'osm'
  | 'satellite-esri'
  | 'satellite-esri-clarity'
  | 'satellite-google'
  | 'hybrid-google'
  | 'terrain'
  | 'dark'
  | 'nlsc-photo'
  | 'wayback';

export interface BaseMapVersion {
  label: string;
  tiles: string[];
}

export interface BaseMapOption {
  id: BaseMapId;
  name: string;
  attribution: string;
  maxzoom?: number;
  tiles?: string[];
  versions?: BaseMapVersion[];
  defaultVersionIndex?: number;
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
  strokeVisible?: boolean;
  pointRadius?: number;
  labelVisible?: boolean;
  labelColor?: string;
  labelHaloColor?: string;
  labelSize?: number;
  kind: LayerKind;
  data: FeatureCollection;
  featureCount: number;
  hydroDates?: string[];
  gwConcTabs?: GwConcTab[];
  waterLevel?: {
    dates: string[];
    activeDate: string;
    sourceLayerId?: string;
    model?: 'idw' | 'tin' | 'kriging' | 'indicator';
    sourceKind?: 'hydro' | 'gw-conc';
    sourceTabId?: string;
    sourceSubId?: string;
    substances?: Array<{ id: string; name: string }>;
    activeSubstance?: string;
    substanceStyles?: Record<string, SubstanceStyle>;
    logTransform?: boolean;
    clampNegative?: boolean;
    indicatorThreshold?: number;
    fill?: WaterLevelFill;
    lines?: WaterLevelLines;
    arrows?: WaterLevelArrows;
    heightLabel?: WaterLevelHeightLabel;
    dateLabel?: WaterLevelDateLabel;
    legend?: WaterLevelLegend;
  };
}

export interface WaterLevelLegend {
  visible?: boolean;
}

export interface SubstanceStyle {
  fill?: WaterLevelFill;
  lines?: WaterLevelLines;
  arrows?: WaterLevelArrows;
}

export interface GwConcSubstance {
  id: string;
  name: string;
  controlConc?: number;
  monitorConc?: number;
  unit?: string;
}

export interface GwConcTab {
  id: string;
  label?: string;
  substances: GwConcSubstance[];
  dates?: string[];
}

export type WaterLevelDashStyle = 'solid' | 'dash' | 'dot' | 'dashdot';

export interface WaterLevelLines {
  majorInterval?: number;
  minorEnabled?: boolean;
  minorDivisions?: number;
  outlineEnabled?: boolean;
  dashStyle?: WaterLevelDashStyle;
  minorDashStyle?: WaterLevelDashStyle;
  minorColor?: string;
  minorWidthRatio?: number;
}

export interface WaterLevelArrows {
  enabled?: boolean;
  divisions?: number;
  color?: string;
  width?: number;
}

export interface WaterLevelHeightLabel {
  visible?: boolean;
  color?: string;
  haloColor?: string;
  size?: number;
}

export interface WaterLevelDateLabel {
  visible?: boolean;
  lng?: number;
  lat?: number;
}

export type WaterLevelFillMode = 'none' | 'gradient' | 'custom';

export interface WaterLevelGradient {
  from: string;
  to: string;
  steps?: number;
}

export interface WaterLevelCustomBand {
  from: number;
  to: number;
  color: string;
}

export interface WaterLevelFill {
  mode: WaterLevelFillMode;
  opacity?: number;
  gradient?: WaterLevelGradient;
  bands?: WaterLevelCustomBand[];
}
