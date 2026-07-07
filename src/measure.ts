import maplibregl, { type Map as MLMap } from 'maplibre-gl';
import * as turf from '@turf/turf';
import type { Feature, FeatureCollection } from 'geojson';

export type MeasureMode = 'line' | 'polygon' | 'circle';

export interface MeasureResult {
  mode: MeasureMode;
  primary: string;      // 主要讀數（距離或面積）
  detail?: string;      // 次要資訊（點數 / 周長 / 半徑）
  inProgress: boolean;  // 是否仍在繪製中（尚未結束）
}

const SRC = 'measure-src';
const L_FILL = 'measure-fill';
const L_LINE = 'measure-line';
const L_VERT = 'measure-vertex';
// 玫瑰紅：在衛星影像與淺色底圖上都夠醒目，且與圖層預設色盤區隔
const ACCENT = '#f43f5e';

function emptyFC(): FeatureCollection {
  return { type: 'FeatureCollection', features: [] };
}
function ptFeat(p: [number, number]): Feature {
  return { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: p } };
}
function lineFeat(coords: [number, number][]): Feature {
  return { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: coords } };
}

function fmtDist(m: number): string {
  if (m < 1000) return `${m < 100 ? m.toFixed(1) : m.toFixed(0)} m`;
  return `${(m / 1000).toFixed(2)} km`;
}
function fmtArea(m2: number): { primary: string; detail: string } {
  const ha = m2 / 10000;
  const km2 = m2 / 1e6;
  if (m2 < 10000) return { primary: `${m2 < 100 ? m2.toFixed(1) : m2.toFixed(0)} m²`, detail: `${ha.toFixed(4)} 公頃` };
  if (km2 < 1) return { primary: `${ha.toFixed(3)} 公頃`, detail: `${m2.toFixed(0)} m²` };
  return { primary: `${km2.toFixed(3)} km²`, detail: `${ha.toFixed(2)} 公頃` };
}

const EPS = 1e-9;
function samePoint(a: [number, number], b: [number, number]): boolean {
  return Math.abs(a[0] - b[0]) < EPS && Math.abs(a[1] - b[1]) < EPS;
}

/**
 * 地圖量測工具：線段距離、多邊形面積、圓形面積。
 *
 * 刻意與專案的 TerraDraw 繪圖系統分離 —— 量測是「暫時性」的，
 * 不應寫進 draw snapshot（否則會被存進專案 / 匯出）。這裡自行掛
 * 地圖點擊事件，畫在專屬的 measure-* 圖層上，讀數用 HTML marker 顯示。
 */
export class MeasureController {
  private map: MLMap;
  private onChange: (r: MeasureResult | null) => void;
  private mode: MeasureMode | null = null;
  private pts: [number, number][] = [];
  private cursor: [number, number] | null = null;
  private finished = false;
  private marker: maplibregl.Marker | null = null;
  private layersReady = false;

  constructor(map: MLMap, onChange: (r: MeasureResult | null) => void) {
    this.map = map;
    this.onChange = onChange;
  }

  private ensureLayers(): void {
    if (this.layersReady) return;
    const map = this.map;
    if (!map.getSource(SRC)) map.addSource(SRC, { type: 'geojson', data: emptyFC() });
    if (!map.getLayer(L_FILL)) {
      map.addLayer({
        id: L_FILL,
        type: 'fill',
        source: SRC,
        filter: ['==', ['geometry-type'], 'Polygon'],
        paint: { 'fill-color': ACCENT, 'fill-opacity': 0.15 },
      });
    }
    if (!map.getLayer(L_LINE)) {
      map.addLayer({
        id: L_LINE,
        type: 'line',
        source: SRC,
        filter: ['any', ['==', ['geometry-type'], 'LineString'], ['==', ['geometry-type'], 'Polygon']],
        paint: { 'line-color': ACCENT, 'line-width': 2.5, 'line-dasharray': [2, 1.5] },
      });
    }
    if (!map.getLayer(L_VERT)) {
      map.addLayer({
        id: L_VERT,
        type: 'circle',
        source: SRC,
        filter: ['==', ['geometry-type'], 'Point'],
        paint: {
          'circle-radius': 4,
          'circle-color': '#ffffff',
          'circle-stroke-color': ACCENT,
          'circle-stroke-width': 2,
        },
      });
    }
    this.layersReady = true;
  }

  private bringToTop(): void {
    for (const id of [L_FILL, L_LINE, L_VERT]) {
      if (this.map.getLayer(id)) {
        try { this.map.moveLayer(id); } catch { /* noop */ }
      }
    }
  }

  getMode(): MeasureMode | null {
    return this.mode;
  }

  /** 啟用某種量測模式（會先清掉先前的量測）。 */
  start(mode: MeasureMode): void {
    const wasActive = this.mode !== null;
    this.mode = mode;
    this.pts = [];
    this.cursor = null;
    this.finished = false;
    this.ensureLayers();
    this.setEmpty();
    if (!wasActive) {
      const map = this.map;
      map.doubleClickZoom.disable();
      map.getCanvas().style.cursor = 'crosshair';
      map.on('click', this.onClick);
      map.on('mousemove', this.onMove);
      map.on('dblclick', this.onDblClick);
      document.addEventListener('keydown', this.onKey);
    }
    this.onChange({ mode, primary: '', inProgress: true });
  }

  /** 停用量測：移除事件、清掉畫面。 */
  deactivate(): void {
    const map = this.map;
    map.off('click', this.onClick);
    map.off('mousemove', this.onMove);
    map.off('dblclick', this.onDblClick);
    document.removeEventListener('keydown', this.onKey);
    try { map.doubleClickZoom.enable(); } catch { /* noop */ }
    map.getCanvas().style.cursor = '';
    this.mode = null;
    this.pts = [];
    this.cursor = null;
    this.finished = false;
    this.setEmpty();
    this.onChange(null);
  }

  /** 清掉目前這一筆量測，但保持在同一模式繼續量下一筆。 */
  clearCurrent(): void {
    this.pts = [];
    this.cursor = null;
    this.finished = false;
    this.setEmpty();
    if (this.mode) this.onChange({ mode: this.mode, primary: '', inProgress: true });
  }

  private setEmpty(): void {
    const src = this.map.getSource(SRC) as maplibregl.GeoJSONSource | undefined;
    src?.setData(emptyFC());
    this.marker?.remove();
    this.marker = null;
  }

  private onClick = (e: maplibregl.MapMouseEvent): void => {
    if (!this.mode) return;
    const p: [number, number] = [e.lngLat.lng, e.lngLat.lat];
    if (this.finished) {
      // 上一筆已結束 → 這一點開始新的量測
      this.pts = [];
      this.finished = false;
    }
    if (this.mode === 'circle') {
      if (this.pts.length === 0) {
        this.pts = [p];
      } else {
        this.pts = [this.pts[0], p];
        this.cursor = null;
        this.finished = true;
      }
    } else {
      this.pts.push(p);
    }
    this.cursor = p;
    this.render();
  };

  private onMove = (e: maplibregl.MapMouseEvent): void => {
    if (!this.mode || this.finished) return;
    if (this.pts.length === 0) return; // 尚未落下第一點，無橡皮筋可畫
    this.cursor = [e.lngLat.lng, e.lngLat.lat];
    this.render();
  };

  private onDblClick = (): void => {
    if (!this.mode || this.mode === 'circle') return;
    // 雙擊會先觸發兩次 click，末端多出一個重複點 → 去除
    if (this.pts.length >= 2 && samePoint(this.pts[this.pts.length - 1], this.pts[this.pts.length - 2])) {
      this.pts.pop();
    }
    const min = this.mode === 'line' ? 2 : 3;
    if (this.pts.length >= min) {
      this.cursor = null;
      this.finished = true;
      this.render();
    }
  };

  private onKey = (e: KeyboardEvent): void => {
    if (!this.mode) return;
    if (e.key === 'Escape') {
      this.clearCurrent();
    } else if (e.key === 'Enter' && this.mode !== 'circle') {
      const min = this.mode === 'line' ? 2 : 3;
      if (this.pts.length >= min && !this.finished) {
        this.cursor = null;
        this.finished = true;
        this.render();
      }
    }
  };

  private render(): void {
    if (!this.mode) return;
    this.ensureLayers();
    const feats: Feature[] = [];
    let result: MeasureResult | null = null;
    let readoutPos: [number, number] | null = null;

    if (this.mode === 'line') {
      for (const p of this.pts) feats.push(ptFeat(p));
      const coords = this.pathCoords();
      if (coords.length >= 2) {
        feats.push(lineFeat(coords));
        const m = turf.length(lineFeat(coords), { units: 'kilometers' }) * 1000;
        readoutPos = coords[coords.length - 1];
        result = { mode: 'line', primary: fmtDist(m), detail: `${this.pts.length} 點`, inProgress: !this.finished };
      } else {
        result = { mode: 'line', primary: '', inProgress: true };
      }
    } else if (this.mode === 'polygon') {
      for (const p of this.pts) feats.push(ptFeat(p));
      const ring = this.pathCoords();
      if (ring.length >= 3) {
        const closed = [...ring, ring[0]];
        const poly: Feature = { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [closed] } };
        feats.push(poly);
        const area = turf.area(poly);
        const perim = turf.length(lineFeat(closed), { units: 'kilometers' }) * 1000;
        const a = fmtArea(area);
        const c = turf.centroid(poly).geometry.coordinates as [number, number];
        readoutPos = c;
        result = { mode: 'polygon', primary: a.primary, detail: `周長 ${fmtDist(perim)}`, inProgress: !this.finished };
      } else {
        if (ring.length === 2) feats.push(lineFeat(ring));
        result = { mode: 'polygon', primary: '', inProgress: true };
      }
    } else {
      const center = this.pts[0];
      if (center) {
        feats.push(ptFeat(center));
        const edge = this.finished ? this.pts[1] : this.cursor;
        if (edge) {
          const radiusKm = turf.distance(center, edge, { units: 'kilometers' });
          const radiusM = radiusKm * 1000;
          if (radiusM > 0) {
            feats.push(turf.circle(center, radiusKm, { steps: 72, units: 'kilometers' }));
            const area = Math.PI * radiusM * radiusM;
            const a = fmtArea(area);
            readoutPos = center;
            result = { mode: 'circle', primary: a.primary, detail: `半徑 ${fmtDist(radiusM)}`, inProgress: !this.finished };
          }
        }
      }
      if (!result) result = { mode: 'circle', primary: '', inProgress: true };
    }

    const src = this.map.getSource(SRC) as maplibregl.GeoJSONSource | undefined;
    src?.setData({ type: 'FeatureCollection', features: feats });
    this.bringToTop();
    this.updateMarker(readoutPos, result);
    this.onChange(result);
  }

  // 目前折線／多邊形的座標串（繪製中含游標點）
  private pathCoords(): [number, number][] {
    if (this.finished || !this.cursor || this.pts.length === 0) return [...this.pts];
    return [...this.pts, this.cursor];
  }

  private updateMarker(pos: [number, number] | null, result: MeasureResult | null): void {
    if (!pos || !result || !result.primary) {
      this.marker?.remove();
      this.marker = null;
      return;
    }
    if (!this.marker) {
      const el = document.createElement('div');
      el.className = 'measure-readout';
      this.marker = new maplibregl.Marker({ element: el, anchor: 'bottom', offset: [0, -10] });
      this.marker.setLngLat(pos).addTo(this.map);
    } else {
      this.marker.setLngLat(pos);
    }
    const el = this.marker.getElement();
    el.innerHTML =
      `<span class="mr-main">${result.primary}</span>` +
      (result.detail ? `<span class="mr-sub">${result.detail}</span>` : '');
  }
}
