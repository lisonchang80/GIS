import type { BaseMapOption } from './types';

export const BASEMAPS: BaseMapOption[] = [
  {
    id: 'osm',
    name: 'OpenStreetMap',
    tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
    attribution: '© OpenStreetMap contributors',
    maxzoom: 19,
  },
  {
    id: 'satellite-google',
    name: '衛星影像 (Google)',
    tiles: [
      'https://mt0.google.com/vt/lyrs=s&x={x}&y={y}&z={z}',
      'https://mt1.google.com/vt/lyrs=s&x={x}&y={y}&z={z}',
      'https://mt2.google.com/vt/lyrs=s&x={x}&y={y}&z={z}',
      'https://mt3.google.com/vt/lyrs=s&x={x}&y={y}&z={z}',
    ],
    attribution: '© Google',
    maxzoom: 21,
  },
  {
    id: 'hybrid-google',
    name: '衛星混合 (Google，含標記)',
    tiles: [
      'https://mt0.google.com/vt/lyrs=y&x={x}&y={y}&z={z}',
      'https://mt1.google.com/vt/lyrs=y&x={x}&y={y}&z={z}',
      'https://mt2.google.com/vt/lyrs=y&x={x}&y={y}&z={z}',
      'https://mt3.google.com/vt/lyrs=y&x={x}&y={y}&z={z}',
    ],
    attribution: '© Google',
    maxzoom: 21,
  },
  {
    id: 'satellite-esri-clarity',
    name: '衛星影像 (Esri Clarity)',
    tiles: [
      'https://clarity.maptiles.arcgis.com/arcgis/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    ],
    attribution: 'Tiles © Esri Clarity — Maxar, Earthstar Geographics',
    maxzoom: 19,
  },
  {
    id: 'satellite-esri',
    name: '衛星影像 (Esri)',
    tiles: [
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    ],
    attribution: 'Tiles © Esri — Source: Esri, Maxar, Earthstar Geographics',
    maxzoom: 19,
  },
  {
    id: 'terrain',
    name: '地形圖 (OpenTopoMap)',
    tiles: ['https://a.tile.opentopomap.org/{z}/{x}/{y}.png'],
    attribution: 'Map data: © OpenStreetMap, SRTM | Style: © OpenTopoMap (CC-BY-SA)',
    maxzoom: 17,
  },
  {
    id: 'dark',
    name: '深色 (CARTO)',
    tiles: [
      'https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png',
      'https://b.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png',
      'https://c.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png',
    ],
    attribution: '© OpenStreetMap contributors © CARTO',
    maxzoom: 19,
  },
  {
    id: 'nlsc-photo',
    name: 'NLSC 歷年正射影像（台灣）',
    attribution: '國土測繪中心 NLSC 正射影像 WMTS',
    maxzoom: 20,
    versions: [
      { label: '民國 92-94 年（2003-2005）', tiles: ['https://wmts.nlsc.gov.tw/wmts/PHOTO1/default/GoogleMapsCompatible/{z}/{y}/{x}'] },
      { label: '民國 103 年（2014）', tiles: ['https://wmts.nlsc.gov.tw/wmts/PHOTO2014/default/GoogleMapsCompatible/{z}/{y}/{x}'] },
      { label: '民國 104 年（2015）', tiles: ['https://wmts.nlsc.gov.tw/wmts/PHOTO2015/default/GoogleMapsCompatible/{z}/{y}/{x}'] },
      { label: '民國 105 年（2016）', tiles: ['https://wmts.nlsc.gov.tw/wmts/PHOTO2016/default/GoogleMapsCompatible/{z}/{y}/{x}'] },
      { label: '民國 106 年（2017）', tiles: ['https://wmts.nlsc.gov.tw/wmts/PHOTO2017/default/GoogleMapsCompatible/{z}/{y}/{x}'] },
      { label: '民國 107 年（2018）', tiles: ['https://wmts.nlsc.gov.tw/wmts/PHOTO2018/default/GoogleMapsCompatible/{z}/{y}/{x}'] },
      { label: '民國 108 年（2019）', tiles: ['https://wmts.nlsc.gov.tw/wmts/PHOTO2019/default/GoogleMapsCompatible/{z}/{y}/{x}'] },
      { label: '民國 109 年（2020）', tiles: ['https://wmts.nlsc.gov.tw/wmts/PHOTO2020/default/GoogleMapsCompatible/{z}/{y}/{x}'] },
      { label: '通用最新版', tiles: ['https://wmts.nlsc.gov.tw/wmts/PHOTO2/default/GoogleMapsCompatible/{z}/{y}/{x}'] },
    ],
    defaultVersionIndex: 8,
  },
  {
    id: 'wayback',
    name: 'Esri Wayback（全球歷史）',
    attribution: '© Esri, Maxar, Earthstar Geographics — World Imagery Wayback',
    maxzoom: 19,
    versions: [
      { label: '2024-01-18', tiles: ['https://wayback.maptiles.arcgis.com/arcgis/rest/services/World_Imagery/WMTS/1.0.0/default028mm/MapServer/tile/41468/{z}/{y}/{x}'] },
      { label: '2024-12-12', tiles: ['https://wayback.maptiles.arcgis.com/arcgis/rest/services/World_Imagery/WMTS/1.0.0/default028mm/MapServer/tile/16453/{z}/{y}/{x}'] },
      { label: '2025-10-23', tiles: ['https://wayback.maptiles.arcgis.com/arcgis/rest/services/World_Imagery/WMTS/1.0.0/default028mm/MapServer/tile/20512/{z}/{y}/{x}'] },
      { label: '2025-12-18', tiles: ['https://wayback.maptiles.arcgis.com/arcgis/rest/services/World_Imagery/WMTS/1.0.0/default028mm/MapServer/tile/13192/{z}/{y}/{x}'] },
      { label: '2026-02-26', tiles: ['https://wayback.maptiles.arcgis.com/arcgis/rest/services/World_Imagery/WMTS/1.0.0/default028mm/MapServer/tile/64001/{z}/{y}/{x}'] },
      { label: '2026-03-26', tiles: ['https://wayback.maptiles.arcgis.com/arcgis/rest/services/World_Imagery/WMTS/1.0.0/default028mm/MapServer/tile/22869/{z}/{y}/{x}'] },
    ],
    defaultVersionIndex: 5,
  },
];

export function basemapTiles(base: BaseMapOption, versionIndex: number): string[] {
  if (base.versions && base.versions.length > 0) {
    const idx = Math.max(0, Math.min(versionIndex, base.versions.length - 1));
    return base.versions[idx].tiles;
  }
  return base.tiles ?? [];
}

export function basemapDefaultVersionIndex(base: BaseMapOption): number {
  if (!base.versions) return 0;
  return base.defaultVersionIndex ?? base.versions.length - 1;
}

export function buildBasemapStyle(base: BaseMapOption, versionIndex = 0): maplibregl.StyleSpecification {
  return {
    version: 8,
    glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
    sources: {
      basemap: {
        type: 'raster',
        tiles: basemapTiles(base, versionIndex),
        tileSize: 256,
        maxzoom: base.maxzoom ?? 19,
        attribution: base.attribution,
      },
    },
    layers: [
      {
        id: 'background',
        type: 'background',
        paint: { 'background-color': '#ffffff' },
      },
      {
        id: 'basemap',
        type: 'raster',
        source: 'basemap',
      },
    ],
  };
}
