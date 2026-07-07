import type { FeatureCollection, Polygon } from 'geojson';

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

export interface LayerGroup {
  id: string;
  name: string;
  collapsed?: boolean;
}

export interface VectorLayer {
  id: string;
  name: string;
  groupId?: string; // 所屬圖層群組（無則為未分組）
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
  soilSurveyTabs?: SoilSurveyTab[];
  exceedance?: ExceedanceConfig;
  waterLevel?: {
    dates: string[];
    activeDate: string;
    sourceLayerId?: string;
    model?: 'idw' | 'tin' | 'kriging' | 'indicator';
    sourceKind?: 'hydro' | 'gw-conc' | 'soil-survey';
    sourceTabId?: string;
    sourceSubId?: string;
    depthInterval?: number; // soil-survey：深度層間隔（m），供圖層卡顯示深度區間 0~0.5m
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

// 土壤污染調查：與土壤濃度監測相似，但「批次」維度換成「深度」維度。
// 一次性採樣（無批次、無時間），每個點位在固定深度層（0 / 0.5 / … / maxDepth）各採一筆。
// 採樣值存 properties.__soilSurvey[tabId][subId][depthKey]，depthKey = 深度字串（'0'、'0.5'…）。
// 高程沿用既有 `高程` 屬性（預設 0），實際採樣高程 = 高程 − 深度（供 3D 用）。
export interface SoilSurveyTab {
  id: string;
  label?: string;
  landUse?: SoilLandUse; // 用地類別，影響新增物質時帶入的標準預設值
  substances: GwConcSubstance[];
  depthInterval?: number; // 採樣深度間隔，預設 0.5（m）
  maxDepth?: number; // 最深採樣深度，預設 4.0（m）
  activeSubstance?: string;
  activeDepth?: number; // 目前聚焦的深度層
  threshold?: number; // 等濃度線閾值，閾值以上計算面積/體積，預設 0
  model?: 'idw' | 'tin' | 'kriging';
  fillGaps?: boolean; // 整層點太少（<3）時，用上下層垂向內插補估該層，預設 true
  obstacles?: ObstacleZone[]; // 障礙物排除區（在深度區間內挖空、不計入面積/體積）
}

// 障礙物排除區：地圖上畫的形狀，在 depthTop~depthBottom 深度區間內把該範圍挖空。
// 圓形/矩形 terra-draw 也吐 Polygon，所以幾何一律存 Polygon。
export interface ObstacleZone {
  id: string;
  shape: 'polygon' | 'rectangle' | 'circle';
  geometry: Polygon;
  depthTop: number; // 障礙物上緣深度（m）
  depthBottom: number; // 障礙物下緣深度（m）
  enabled: boolean; // 打勾生效
  label?: string;
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
