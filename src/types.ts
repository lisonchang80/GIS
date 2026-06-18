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

// 20 種點形狀（以 SDF symbol icon 實作，可重新著色 + halo 描邊）
export type PointShape =
  | 'circle'
  | 'square'
  | 'triangle'
  | 'triangle-down'
  | 'diamond'
  | 'pentagon'
  | 'hexagon'
  | 'star5'
  | 'star6'
  | 'cross'
  | 'x'
  | 'octagon'
  | 'triangle-left'
  | 'triangle-right'
  | 'ring'
  | 'square-hollow'
  | 'triangle-hollow'
  | 'diamond-hollow'
  | 'target'
  | 'wye';

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
  pointShape?: PointShape;
  labelVisible?: boolean;
  labelColor?: string;
  labelHaloColor?: string;
  labelSize?: number;
  kind: LayerKind;
  data: FeatureCollection;
  featureCount: number;
  hydroDates?: string[];
  gwConcTabs?: GwConcTab[];
  soilConcTabs?: SoilConcTab[];
  exceedance?: ExceedanceConfig;
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

// 土壤濃度監測：沿用與 GwConcSubstance 相同的物質欄位（管制/監測標準 + 單位）
// 土壤採樣具破壞性，不在同點重複採樣 → 無時間維度；改以「批次」分組（每批不同點位）
export type SoilLandUse = 'farmland' | 'general';

// 點位的批次屬性鍵（main 屬性表欄位）
export const SOIL_BATCH_KEY = '批次名稱';

export interface SoilConcTab {
  id: string;
  label?: string;
  landUse?: SoilLandUse; // 用地類別，影響新增物質時帶入的標準預設值
  substances: GwConcSubstance[];
  activeBatch?: string; // 編輯表格目前聚焦的批次
}

export type ExceedanceLevel = 'alert' | 'warn' | 'ok' | 'nodata';

export interface ExceedanceColors {
  alert?: string;
  warn?: string;
  ok?: string;
  nodata?: string;
}

export interface ExceedanceBatch {
  name: string;
  shape: PointShape;
  visible?: boolean; // 預設 true
}

// 由土壤濃度監測生成的「點位超標圖」圖層設定（非內插，逐點分級著色 + 每批不同形狀）
export interface ExceedanceConfig {
  sourceLayerId: string;
  sourceKind: 'soil-conc';
  sourceTabId: string;
  sourceSubId?: string; // 單一物質
  substances?: Array<{ id: string; name: string }>; // 多物質
  activeSubstance?: string;
  batches: ExceedanceBatch[]; // 每批一個形狀，可勾選顯示
  colors?: ExceedanceColors;
  showOk?: boolean; // 預設 true
  showNodata?: boolean; // 預設 false
  radius?: number;
  legend?: { visible?: boolean };
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
