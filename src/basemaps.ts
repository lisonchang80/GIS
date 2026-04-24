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
];

export function buildBasemapStyle(base: BaseMapOption): maplibregl.StyleSpecification {
  return {
    version: 8,
    glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
    sources: {
      basemap: {
        type: 'raster',
        tiles: base.tiles,
        tileSize: 256,
        maxzoom: base.maxzoom ?? 19,
        attribution: base.attribution,
      },
    },
    layers: [
      {
        id: 'basemap',
        type: 'raster',
        source: 'basemap',
      },
    ],
  };
}
