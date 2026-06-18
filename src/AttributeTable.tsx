import { useEffect, useMemo, useRef, useState } from 'react';
import type { Feature, FeatureCollection } from 'geojson';
import * as turf from '@turf/turf';
import type {
  ExceedanceConfig,
  GwConcSubstance,
  GwConcTab,
  SoilConcTab,
  SoilLandUse,
  VectorLayer,
  WaterLevelCustomBand,
  WaterLevelFill,
  WaterLevelLines,
} from './types';
import { SOIL_BATCH_KEY } from './types';
import {
  buildContourFeaturesForLayer,
  buildContourLayerFeatures,
  collectGwConcSamplesForDate,
  type ThresholdLine,
} from './contour';
import { lookupGwConcStandard } from './gwConcStandards';
import { lookupSoilConcStandard, SOIL_POLLUTANTS } from './soilConcStandards';
import {
  batchOf,
  buildExceedancePoints,
  classifyExceedance,
  collectBatches,
  EXCEEDANCE_COLORS,
  reconcileBatches,
  readSoilConc,
} from './exceedance';
import { fileToGeoJSON, ensureNames } from './importers';

function makeGwConcDefaults(sub: GwConcSubstance): {
  fill: WaterLevelFill | undefined;
  lines: WaterLevelLines;
  thresholds: ThresholdLine[];
} {
  const M = sub.monitorConc;
  const C = sub.controlConc;
  const lines: WaterLevelLines = {
    majorInterval: typeof M === 'number' && M > 0 ? M / 2 : undefined,
  };
  let fill: WaterLevelFill | undefined;
  if (typeof M === 'number' && typeof C === 'number' && M > 0 && C > M) {
    const eps = M * 0.0001;
    const bands: WaterLevelCustomBand[] = [
      { from: 0, to: eps, color: '#ffffff' },
      { from: eps, to: M / 2, color: '#22c55e' },
      { from: M / 2, to: M, color: '#eab308' },
      { from: M, to: C, color: '#f97316' },
      { from: C, to: 1e9, color: '#ef4444' },
    ];
    fill = { mode: 'custom', opacity: 0.4, bands };
  }
  const thresholds: ThresholdLine[] = [];
  if (typeof C === 'number') thresholds.push({ value: C, kind: 'control', label: '管制濃度標準' });
  if (typeof M === 'number') thresholds.push({ value: M, kind: 'monitor', label: '監測濃度標準' });
  return { fill, lines, thresholds };
}

function ConcMatrixIcon({ kind }: { kind: 'single' | 'multi-day' | 'multi-multi' }) {
  const stroke = '#ef4444';
  const sw = 1.5;
  const innerCount = kind === 'single' ? 0 : kind === 'multi-day' ? 1 : 2;
  return (
    <svg
      width={22}
      height={22}
      viewBox="0 0 24 24"
      fill="none"
      stroke={stroke}
      strokeWidth={sw}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ display: 'block' }}
    >
      <line x1={9} y1={2.8} x2={15} y2={2.8} />
      <path d="M 10 2.8 L 10 7 A 7.5 7.5 0 1 0 14 7 L 14 2.8" />
      {innerCount >= 1 && <circle cx={12} cy={14} r={4.5} />}
      {innerCount >= 2 && <circle cx={12} cy={14} r={2.2} />}
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg width={14} height={14} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block' }}>
      <path d="M2.5 4h11" />
      <path d="M5.5 4V2.5a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1V4" />
      <path d="M4 4l.7 9.2a1 1 0 0 0 1 .8h4.6a1 1 0 0 0 1-.8L12 4" />
      <path d="M6.5 7v5M9.5 7v5" />
    </svg>
  );
}

function DropIcon({ count }: { count: 1 | 2 }) {
  const drop = (cx: number, top: number, bot: number) => {
    const h = bot - top;
    const w = h * 0.45;
    return `M ${cx} ${top} C ${cx - w} ${top + h * 0.5}, ${cx - w} ${bot - h * 0.05}, ${cx} ${bot} C ${cx + w} ${bot - h * 0.05}, ${cx + w} ${top + h * 0.5}, ${cx} ${top} Z`;
  };
  const stroke = '#60a5fa';
  if (count === 1) {
    return (
      <svg width={14} height={14} viewBox="0 0 16 16" style={{ display: 'block' }}>
        <path d={drop(8, 2, 14)} fill="none" stroke={stroke} strokeWidth={1.5} strokeLinejoin="round" />
      </svg>
    );
  }
  return (
    <svg width={14} height={14} viewBox="0 0 16 16" style={{ display: 'block' }}>
      <path d={drop(8, 2, 14)} fill="none" stroke={stroke} strokeWidth={1.5} strokeLinejoin="round" />
      <path d={drop(8, 8, 12)} fill="none" stroke={stroke} strokeWidth={1.5} strokeLinejoin="round" />
    </svg>
  );
}

interface Props {
  layer: VectorLayer;
  onClose: () => void;
  onZoomFeature: (feature: Feature) => void;
  onUpdateLayer: (id: string, patch: Partial<VectorLayer>) => void;
  onAddLayer: (layer: VectorLayer) => void;
  onDuplicateLayer: (id: string) => void;
  onExportLayer: (id: string) => void;
  pickingActive?: boolean;
  pickingFeatureIndex?: number | null;
  onStartPick?: (featureIndex: number) => void;
  onCancelPick?: () => void;
  onStartAddPointPick?: () => void;
  addPointPickActive?: boolean;
}

interface EditingCell {
  row: number;
  key: string;
}

export function AttributeTable({
  layer,
  onClose,
  onZoomFeature,
  onUpdateLayer,
  onAddLayer,
  onDuplicateLayer,
  onExportLayer,
  pickingActive,
  pickingFeatureIndex,
  onStartPick,
  onCancelPick,
  onStartAddPointPick,
  addPointPickActive,
}: Props) {
  const [query, setQuery] = useState('');
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortDesc, setSortDesc] = useState(false);
  const [editing, setEditing] = useState<EditingCell | null>(null);
  const [editValue, setEditValue] = useState('');
  const [addingColumn, setAddingColumn] = useState(false);
  const [newColName, setNewColName] = useState('');
  const [coordsEdit, setCoordsEdit] = useState<{ row: number; value: string; error?: string } | null>(null);
  const [dockHeight, setDockHeight] = useState(() =>
    Math.max(260, Math.round(window.innerHeight * 0.42)),
  );
  const resizingRef = useRef(false);
  const recordFileRef = useRef<HTMLInputElement>(null);
  const [tabMenuOpen, setTabMenuOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<string>('main');
  const [hydroOpen, setHydroOpen] = useState(
    () => (layer.hydroDates?.length ?? 0) > 0,
  );

  useEffect(() => {
    if ((layer.hydroDates?.length ?? 0) > 0) {
      setHydroOpen(true);
    }
  }, [layer.id]);

  const gwConcTabs = layer.gwConcTabs ?? [];
  const activeGwConcTab = gwConcTabs.find((t) => t.id === activeTab);
  const soilConcTabs = layer.soilConcTabs ?? [];
  const activeSoilConcTab = soilConcTabs.find((t) => t.id === activeTab);
  const hasSoilTabs = soilConcTabs.length > 0;
  const [draggingSubId, setDraggingSubId] = useState<string | null>(null);
  const [dragOverTrash, setDragOverTrash] = useState(false);
  const pointFileRef = useRef<HTMLInputElement>(null);
  const [addPointMenuOpen, setAddPointMenuOpen] = useState(false);
  const [addingManualPoint, setAddingManualPoint] = useState(false);
  const [manualPoint, setManualPoint] = useState({ lng: '', lat: '', name: '' });

  const appendPointFeatures = (features: Feature[]) => {
    if (features.length === 0) return;
    const withCols = features.map((f) => {
      const props = { ...((f.properties ?? {}) as Record<string, unknown>) };
      if (hasSoilTabs && !(SOIL_BATCH_KEY in props)) props[SOIL_BATCH_KEY] = '';
      return { ...f, properties: props } as Feature;
    });
    const data = { ...layer.data, features: [...layer.data.features, ...withCols] } as FeatureCollection;
    onUpdateLayer(layer.id, { data, featureCount: data.features.length });
  };

  const handleAddManualPoint = () => {
    const lng = parseFloat(manualPoint.lng);
    const lat = parseFloat(manualPoint.lat);
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) {
      window.alert('請輸入有效的經度、緯度');
      return;
    }
    const name = manualPoint.name.trim();
    appendPointFeatures([
      {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [lng, lat] },
        properties: { ...(name ? { 名稱: name } : {}) },
      } as Feature,
    ]);
    setManualPoint({ lng: '', lat: '', name: '' });
    setAddingManualPoint(false);
    setAddPointMenuOpen(false);
  };

  const handleAddPointFile = async (file: File) => {
    try {
      const fc = ensureNames(await fileToGeoJSON(file));
      const pts = fc.features.filter(
        (f) => f.geometry?.type === 'Point' || f.geometry?.type === 'MultiPoint',
      );
      if (pts.length === 0) {
        window.alert('檔案中沒有點位資料');
        return;
      }
      appendPointFeatures(pts);
      window.alert(`已新增 ${pts.length} 個點位`);
    } catch (e) {
      window.alert('載入失敗：' + (e as Error).message);
    }
    setAddPointMenuOpen(false);
  };

  const deleteHydroTab = () => {
    const hasData = (layer.hydroDates?.length ?? 0) > 0;
    if (hasData) {
      if (!window.confirm('刪除水文監測分頁將清除所有日期與量測深度資料，確定？')) return;
      const newFeatures = layer.data.features.map((f) => {
        const props = (f.properties ?? {}) as Record<string, unknown>;
        if (!('__hydro' in props)) return f;
        const nextProps = { ...props };
        delete nextProps['__hydro'];
        return { ...f, properties: nextProps } as Feature;
      });
      const data: FeatureCollection = { ...layer.data, features: newFeatures };
      onUpdateLayer(layer.id, { data, hydroDates: [] });
    }
    setHydroOpen(false);
    if (activeTab === 'hydro') setActiveTab('main');
  };

  const deleteGwConcTab = (tabId: string) => {
    const tab = gwConcTabs.find((t) => t.id === tabId);
    if (!tab) return;
    const hasContent = (tab.label?.trim().length ?? 0) > 0 || tab.substances.length > 0;
    if (hasContent) {
      if (!window.confirm('刪除此地下水濃度監測分頁將清除所有設定與資料，確定？')) return;
    }
    const newFeatures = layer.data.features.map((f) => {
      const props = (f.properties ?? {}) as Record<string, unknown>;
      const gw = props['__gwConc'] as Record<string, unknown> | undefined;
      if (!gw || !(tabId in gw)) return f;
      const next = { ...gw };
      delete next[tabId];
      return { ...f, properties: { ...props, __gwConc: next } } as Feature;
    });
    const data: FeatureCollection = { ...layer.data, features: newFeatures };
    const nextTabs = gwConcTabs.filter((t) => t.id !== tabId);
    onUpdateLayer(layer.id, { data, gwConcTabs: nextTabs });
    if (activeTab === tabId) setActiveTab('main');
  };

  const deleteGwConcSubstance = (tabId: string, subId: string) => {
    const tab = gwConcTabs.find((t) => t.id === tabId);
    if (!tab) return;
    const target = tab.substances.find((s) => s.id === subId);
    if (!target) return;
    const label = target.name?.trim() || '此污染物';
    if (!window.confirm(`確定刪除「${label}」？所有相關資料都會移除。`)) return;
    const nextSubstances = tab.substances.filter((s) => s.id !== subId);
    const newTabs = gwConcTabs.map((t) =>
      t.id === tabId ? { ...t, substances: nextSubstances } : t,
    );
    const newFeatures = layer.data.features.map((f) => {
      const props = (f.properties ?? {}) as Record<string, unknown>;
      const gw = props['__gwConc'] as Record<string, unknown> | undefined;
      const tabBucket = gw?.[tabId] as Record<string, unknown> | undefined;
      if (!tabBucket || !(subId in tabBucket)) return f;
      const nextBucket = { ...tabBucket };
      delete nextBucket[subId];
      return {
        ...f,
        properties: { ...props, __gwConc: { ...gw, [tabId]: nextBucket } },
      } as Feature;
    });
    const data: FeatureCollection = { ...layer.data, features: newFeatures };
    onUpdateLayer(layer.id, { data, gwConcTabs: newTabs });
  };

  const deleteSoilConcTab = (tabId: string) => {
    const tab = soilConcTabs.find((t) => t.id === tabId);
    if (!tab) return;
    const hasContent = (tab.label?.trim().length ?? 0) > 0 || tab.substances.length > 0;
    if (hasContent) {
      if (!window.confirm('刪除此土壤濃度監測分頁將清除所有設定與資料，確定？')) return;
    }
    const newFeatures = layer.data.features.map((f) => {
      const props = (f.properties ?? {}) as Record<string, unknown>;
      const soil = props['__soilConc'] as Record<string, unknown> | undefined;
      if (!soil || !(tabId in soil)) return f;
      const next = { ...soil };
      delete next[tabId];
      return { ...f, properties: { ...props, __soilConc: next } } as Feature;
    });
    const data: FeatureCollection = { ...layer.data, features: newFeatures };
    const nextTabs = soilConcTabs.filter((t) => t.id !== tabId);
    onUpdateLayer(layer.id, { data, soilConcTabs: nextTabs });
    if (activeTab === tabId) setActiveTab('main');
  };

  const deleteSoilConcSubstance = (tabId: string, subId: string) => {
    const tab = soilConcTabs.find((t) => t.id === tabId);
    if (!tab) return;
    const target = tab.substances.find((s) => s.id === subId);
    if (!target) return;
    const label = target.name?.trim() || '此污染物';
    if (!window.confirm(`確定刪除「${label}」？所有相關資料都會移除。`)) return;
    const nextSubstances = tab.substances.filter((s) => s.id !== subId);
    const newTabs = soilConcTabs.map((t) =>
      t.id === tabId ? { ...t, substances: nextSubstances } : t,
    );
    const newFeatures = layer.data.features.map((f) => {
      const props = (f.properties ?? {}) as Record<string, unknown>;
      const soil = props['__soilConc'] as Record<string, unknown> | undefined;
      const tabBucket = soil?.[tabId] as Record<string, unknown> | undefined;
      if (!tabBucket || !(subId in tabBucket)) return f;
      const nextBucket = { ...tabBucket };
      delete nextBucket[subId];
      return {
        ...f,
        properties: { ...props, __soilConc: { ...soil, [tabId]: nextBucket } },
      } as Feature;
    });
    const data: FeatureCollection = { ...layer.data, features: newFeatures };
    onUpdateLayer(layer.id, { data, soilConcTabs: newTabs });
  };

  const canDeleteActiveTab = activeTab !== 'main';
  const handleTrashClick = () => {
    if (!canDeleteActiveTab) return;
    if (activeTab === 'hydro') deleteHydroTab();
    else if (activeSoilConcTab) deleteSoilConcTab(activeTab);
    else deleteGwConcTab(activeTab);
  };

  const trashButton = (
    <div
      className={`dock-tab-trash${canDeleteActiveTab ? ' active' : ''}${draggingSubId ? ' armed' : ''}${dragOverTrash ? ' drag-over' : ''}`}
      title={
        !canDeleteActiveTab
          ? '主屬性表無法刪除'
          : activeTab === 'hydro'
            ? '刪除水文監測分頁'
            : activeSoilConcTab
              ? '刪除此土壤濃度監測分頁（或拖曳污染物到此刪除）'
              : '刪除此地下水濃度監測分頁（或拖曳污染物到此刪除）'
      }
      onClick={() => {
        if (draggingSubId) return;
        handleTrashClick();
      }}
      onDragOver={(e) => {
        if (!draggingSubId) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        setDragOverTrash(true);
      }}
      onDragLeave={() => setDragOverTrash(false)}
      onDrop={(e) => {
        e.preventDefault();
        if (draggingSubId && activeSoilConcTab) {
          deleteSoilConcSubstance(activeSoilConcTab.id, draggingSubId);
        } else if (draggingSubId && activeGwConcTab) {
          deleteGwConcSubstance(activeGwConcTab.id, draggingSubId);
        }
        setDragOverTrash(false);
        setDraggingSubId(null);
      }}
    >
      <TrashIcon />
    </div>
  );
  const [addingDate, setAddingDate] = useState(false);
  const [newDate, setNewDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [hydroEditing, setHydroEditing] = useState<
    { originalIdx: number; date: string; value: string } | null
  >(null);
  const [dateEditing, setDateEditing] = useState<{ date: string; value: string } | null>(null);
  const [contourModel, setContourModel] = useState<'idw' | 'tin' | 'kriging'>('idw');

  useEffect(() => {
    if (!tabMenuOpen) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest('.dock-tab-add-wrap')) return;
      setTabMenuOpen(false);
    };
    const t = setTimeout(() => window.addEventListener('click', handler), 0);
    return () => {
      clearTimeout(t);
      window.removeEventListener('click', handler);
    };
  }, [tabMenuOpen]);

  useEffect(() => {
    const features = layer.data.features;
    const needs = features.some(
      (f) =>
        (f.geometry?.type === 'Point' || f.geometry?.type === 'MultiPoint') &&
        (f.properties?.['高程'] === undefined || f.properties?.['高程'] === null),
    );
    if (!needs) return;
    const newFeatures = features.map((f) => {
      if (f.geometry?.type !== 'Point' && f.geometry?.type !== 'MultiPoint') return f;
      const props = (f.properties ?? {}) as Record<string, unknown>;
      if (props['高程'] !== undefined && props['高程'] !== null) return f;
      return { ...f, properties: { ...props, 高程: 0 } } as Feature;
    });
    const data: FeatureCollection = { ...layer.data, features: newFeatures };
    onUpdateLayer(layer.id, { data });
  }, [layer.id, layer.data, onUpdateLayer]);

  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    resizingRef.current = true;
    const onMove = (ev: MouseEvent) => {
      if (!resizingRef.current) return;
      const h = window.innerHeight - ev.clientY;
      setDockHeight(Math.max(180, Math.min(window.innerHeight * 0.85, h)));
    };
    const onUp = () => {
      resizingRef.current = false;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const columns = useMemo(() => {
    const set = new Set<string>();
    for (const f of layer.data.features) {
      if (f.properties && typeof f.properties === 'object') {
        for (const k of Object.keys(f.properties)) set.add(k);
      }
    }
    set.delete('名稱');
    set.delete('高程');
    set.delete('__hydro');
    set.delete('__gwConc');
    const hasPoint = layer.data.features.some(
      (f) => f.geometry?.type === 'Point' || f.geometry?.type === 'MultiPoint',
    );
    const base = hasPoint ? ['名稱', '高程'] : ['名稱'];
    return [...base, ...Array.from(set)];
  }, [layer.data]);

  const rows = useMemo(() => {
    const normalized = layer.data.features.map((f, i) => ({
      feature: f,
      index: i,
      props: (f.properties ?? {}) as Record<string, unknown>,
      geomType: f.geometry?.type ?? 'null',
      coords: computeCoords(f),
      size: computeSize(f),
      sizeValue: computeSizeValue(f),
    }));
    const q = query.trim().toLowerCase();
    const filtered = q
      ? normalized.filter(({ props, coords, size, geomType }) =>
          Object.values(props).some((v) => String(v ?? '').toLowerCase().includes(q)) ||
          coords.toLowerCase().includes(q) ||
          size.toLowerCase().includes(q) ||
          geomType.toLowerCase().includes(q),
        )
      : normalized;
    if (sortKey) {
      filtered.sort((a, b) => {
        let av: unknown, bv: unknown;
        if (sortKey === '__coords') { av = a.coords; bv = b.coords; }
        else if (sortKey === '__size') { av = a.sizeValue ?? -Infinity; bv = b.sizeValue ?? -Infinity; }
        else { av = a.props[sortKey]; bv = b.props[sortKey]; }
        return sortDesc ? compareValues(bv, av) : compareValues(av, bv);
      });
    }
    return filtered;
  }, [layer.data, query, sortKey, sortDesc]);

  const toggleSort = (key: string) => {
    if (sortKey === key) {
      if (!sortDesc) setSortDesc(true);
      else {
        setSortKey(null);
        setSortDesc(false);
      }
    } else {
      setSortKey(key);
      setSortDesc(false);
    }
  };

  const writeData = (newFeatures: Feature[], featureCount?: number) => {
    const data: FeatureCollection = { ...layer.data, features: newFeatures };
    onUpdateLayer(layer.id, {
      data,
      featureCount: featureCount ?? newFeatures.length,
    });
  };

  const startEdit = (row: number, key: string) => {
    const current = layer.data.features[row]?.properties?.[key];
    setEditValue(current === undefined || current === null ? '' : String(current));
    setEditing({ row, key });
  };

  const commitEdit = () => {
    if (!editing) return;
    const { row, key } = editing;
    const value = coerceValue(editValue);
    const newFeatures = layer.data.features.map((f, i) => {
      if (i !== row) return f;
      const nextProps = { ...(f.properties ?? {}) };
      if (value === null) delete nextProps[key];
      else nextProps[key] = value;
      return { ...f, properties: nextProps } as Feature;
    });
    writeData(newFeatures);
    setEditing(null);
  };

  const cancelEdit = () => setEditing(null);

  const handleAddColumn = (columnName: string) => {
    const name = columnName.trim();
    if (!name) return;
    if (columns.includes(name)) return;
    const newFeatures = layer.data.features.map((f) => {
      const nextProps = { ...(f.properties ?? {}), [name]: null };
      return { ...f, properties: nextProps } as Feature;
    });
    writeData(newFeatures);
    setAddingColumn(false);
    setNewColName('');
  };

  const handleDeleteColumn = (name: string) => {
    if (name === '名稱' || name === '高程') return;
    if (!window.confirm(`確定刪除欄位「${name}」？所有 feature 的該屬性都會移除。`)) return;
    const newFeatures = layer.data.features.map((f) => {
      const nextProps = { ...(f.properties ?? {}) };
      delete nextProps[name];
      return { ...f, properties: nextProps } as Feature;
    });
    writeData(newFeatures);
  };

  const handleDeleteRow = (row: number) => {
    if (!window.confirm(`確定刪除第 ${row + 1} 筆 feature？`)) return;
    const newFeatures = layer.data.features.filter((_, i) => i !== row);
    writeData(newFeatures);
  };

  const startCoordsEdit = (row: number) => {
    const f = layer.data.features[row];
    if (!f || f.geometry?.type !== 'Point') return;
    const [lng, lat] = f.geometry.coordinates as [number, number];
    setCoordsEdit({ row, value: `${lng}, ${lat}` });
  };

  const commitCoordsEdit = () => {
    if (!coordsEdit) return;
    const parts = coordsEdit.value.split(/[,\s]+/).filter(Boolean);
    if (parts.length !== 2) {
      setCoordsEdit({ ...coordsEdit, error: '請輸入 「經度, 緯度」' });
      return;
    }
    const lng = parseFloat(parts[0]);
    const lat = parseFloat(parts[1]);
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) {
      setCoordsEdit({ ...coordsEdit, error: '不是有效的數字' });
      return;
    }
    if (lng < -180 || lng > 180) {
      setCoordsEdit({ ...coordsEdit, error: '經度需介於 -180 ~ 180' });
      return;
    }
    if (lat < -90 || lat > 90) {
      setCoordsEdit({ ...coordsEdit, error: '緯度需介於 -90 ~ 90' });
      return;
    }
    const newFeatures = layer.data.features.map((f, i) => {
      if (i !== coordsEdit.row || f.geometry?.type !== 'Point') return f;
      return { ...f, geometry: { type: 'Point' as const, coordinates: [lng, lat] } };
    });
    writeData(newFeatures);
    setCoordsEdit(null);
  };

  const cancelCoordsEdit = () => setCoordsEdit(null);

  const hydroDates = layer.hydroDates ?? [];

  const handleAddDate = () => {
    const d = newDate.trim();
    if (!d) return;
    if (hydroDates.includes(d)) {
      setAddingDate(false);
      return;
    }
    const next = [...hydroDates, d].sort();
    onUpdateLayer(layer.id, { hydroDates: next });
    setAddingDate(false);
    setNewDate(new Date().toISOString().slice(0, 10));
  };

  const handleRemoveDate = (date: string) => {
    if (!window.confirm(`確定刪除日期「${date}」？所有量測深度資料都會移除。`)) return;
    const nextDates = hydroDates.filter((d) => d !== date);
    const newFeatures = layer.data.features.map((f) => {
      const props = (f.properties ?? {}) as Record<string, unknown>;
      const hydro = props['__hydro'];
      if (!hydro || typeof hydro !== 'object') return f;
      const next = { ...(hydro as Record<string, unknown>) };
      delete next[date];
      return {
        ...f,
        properties: { ...props, __hydro: next },
      } as Feature;
    });
    const data: FeatureCollection = { ...layer.data, features: newFeatures };
    onUpdateLayer(layer.id, { data, hydroDates: nextDates });
  };

  const startHydroEdit = (originalIdx: number, date: string) => {
    const f = layer.data.features[originalIdx];
    const hydro = (f?.properties as Record<string, unknown> | undefined)?.['__hydro'] as
      | Record<string, unknown>
      | undefined;
    const cur = hydro?.[date];
    setHydroEditing({
      originalIdx,
      date,
      value: typeof cur === 'number' ? String(cur) : '',
    });
  };

  const commitHydroEdit = () => {
    if (!hydroEditing) return;
    const { originalIdx, date, value } = hydroEditing;
    const trimmed = value.trim();
    let nextDepth: number | null = null;
    if (trimmed !== '') {
      const num = parseFloat(trimmed);
      if (Number.isFinite(num)) nextDepth = num;
    }
    const newFeatures = layer.data.features.map((f, i) => {
      if (i !== originalIdx) return f;
      const props = (f.properties ?? {}) as Record<string, unknown>;
      const hydro = (props['__hydro'] as Record<string, unknown> | undefined) ?? {};
      const nextHydro = { ...hydro };
      if (nextDepth === null) delete nextHydro[date];
      else nextHydro[date] = nextDepth;
      return { ...f, properties: { ...props, __hydro: nextHydro } } as Feature;
    });
    writeData(newFeatures);
    setHydroEditing(null);
  };

  const cancelHydroEdit = () => setHydroEditing(null);

  const startEditDate = (date: string) => {
    setDateEditing({ date, value: date });
  };

  const commitEditDate = () => {
    if (!dateEditing) return;
    const { date, value } = dateEditing;
    const next = value.trim();
    if (!next || next === date) {
      setDateEditing(null);
      return;
    }
    if (hydroDates.includes(next)) {
      window.alert(`日期「${next}」已存在`);
      setDateEditing(null);
      return;
    }
    const nextDates = hydroDates.map((d) => (d === date ? next : d)).sort();
    const newFeatures = layer.data.features.map((f) => {
      const props = (f.properties ?? {}) as Record<string, unknown>;
      const hydro = props['__hydro'];
      if (!hydro || typeof hydro !== 'object') return f;
      const cur = hydro as Record<string, unknown>;
      if (!(date in cur)) return f;
      const nextHydro = { ...cur };
      nextHydro[next] = nextHydro[date];
      delete nextHydro[date];
      return { ...f, properties: { ...props, __hydro: nextHydro } } as Feature;
    });
    const data: FeatureCollection = { ...layer.data, features: newFeatures };
    onUpdateLayer(layer.id, { data, hydroDates: nextDates });
    setDateEditing(null);
  };

  const cancelEditDate = () => setDateEditing(null);

  const handleGenerateRecord = () => {
    const points = layer.data.features.filter(
      (f) => f.geometry?.type === 'Point' || f.geometry?.type === 'MultiPoint',
    );
    if (points.length === 0) {
      window.alert('沒有 Point feature 可生成紀錄表');
      return;
    }
    const lines = ['名稱,經度,緯度,高程(m),日期,量測深度(m)'];
    for (const f of points) {
      const props = (f.properties ?? {}) as Record<string, unknown>;
      const name = csvEscape(formatValue(props['名稱']));
      let lng = '';
      let lat = '';
      if (f.geometry?.type === 'Point') {
        const [x, y] = f.geometry.coordinates as [number, number];
        lng = x.toFixed(6);
        lat = y.toFixed(6);
      }
      const elev = typeof props['高程'] === 'number'
        ? (props['高程'] as number).toFixed(3)
        : '';
      lines.push(`${name},${lng},${lat},${elev},,`);
    }
    const csv = '\uFEFF' + lines.join('\r\n') + '\r\n';
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const stamp = new Date().toISOString().slice(0, 10);
    a.download = `水文監測紀錄表-${layer.name}-${stamp}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleImportRecord = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result ?? '').replace(/^\uFEFF/, '');
      const rows = parseCsv(text);
      if (rows.length < 2) {
        window.alert('CSV 沒有資料');
        return;
      }
      const header = rows[0].map((s) => s.trim());
      const nameIdx = header.indexOf('名稱');
      const dateIdx = header.indexOf('日期');
      const depthIdx = header.findIndex((h) => h.startsWith('量測深度'));
      if (nameIdx < 0 || dateIdx < 0 || depthIdx < 0) {
        window.alert('CSV 格式錯誤：需含有「名稱」、「日期」、「量測深度」三欄');
        return;
      }
      const nameToIdx = new Map<string, number>();
      layer.data.features.forEach((f, i) => {
        if (f.geometry?.type !== 'Point' && f.geometry?.type !== 'MultiPoint') return;
        const props = (f.properties ?? {}) as Record<string, unknown>;
        const n = formatValue(props['名稱']).trim();
        if (n && !nameToIdx.has(n)) nameToIdx.set(n, i);
      });
      const updates = new Map<number, Map<string, number>>();
      const newDateSet = new Set<string>(layer.hydroDates ?? []);
      let imported = 0;
      let skipped = 0;
      for (let i = 1; i < rows.length; i++) {
        const r = rows[i];
        const name = (r[nameIdx] ?? '').trim();
        const date = (r[dateIdx] ?? '').trim();
        const depthStr = (r[depthIdx] ?? '').trim();
        if (!name && !date && !depthStr) continue;
        if (!name || !date || !depthStr) { skipped++; continue; }
        const depth = parseFloat(depthStr);
        if (!Number.isFinite(depth)) { skipped++; continue; }
        const idx = nameToIdx.get(name);
        if (idx === undefined) { skipped++; continue; }
        if (!updates.has(idx)) updates.set(idx, new Map());
        updates.get(idx)!.set(date, depth);
        newDateSet.add(date);
        imported++;
      }
      if (imported === 0) {
        window.alert(`沒有可匯入的資料${skipped > 0 ? `（${skipped} 筆忽略）` : ''}`);
        return;
      }
      const newFeatures = layer.data.features.map((f, i) => {
        const u = updates.get(i);
        if (!u) return f;
        const props = (f.properties ?? {}) as Record<string, unknown>;
        const hydro = (props['__hydro'] as Record<string, unknown> | undefined) ?? {};
        const next = { ...hydro };
        for (const [date, depth] of u) next[date] = depth;
        return { ...f, properties: { ...props, __hydro: next } } as Feature;
      });
      const data: FeatureCollection = { ...layer.data, features: newFeatures };
      onUpdateLayer(layer.id, {
        data,
        hydroDates: Array.from(newDateSet).sort(),
      });
      window.alert(
        `匯入完成：${imported} 筆${skipped > 0 ? `，${skipped} 筆忽略（名稱對不到或數值無效）` : ''}`,
      );
    };
    reader.readAsText(file, 'utf-8');
  };

  const handleGenerateSingleContour = (date: string) => {
    const isolines = buildContourFeaturesForLayer(layer, date);
    if (isolines.length === 0) {
      window.alert(`日期「${date}」資料不足以生成等水位線（至少 3 個有效深度）`);
      return;
    }
    const features = buildContourLayerFeatures(layer, date);
    const newLayer: VectorLayer = {
      id: `wlc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      name: date,
      visible: true,
      opacity: 0.85,
      color: '#3b82f6',
      strokeColor: '#3b82f6',
      strokeWidth: 1.5,
      labelVisible: true,
      labelColor: '#ffffff',
      labelSize: 11,
      kind: 'line',
      data: { type: 'FeatureCollection', features } as FeatureCollection,
      featureCount: features.length,
      waterLevel: {
        dates: [date],
        activeDate: date,
        sourceLayerId: layer.id,
        model: contourModel,
      },
    };
    onAddLayer(newLayer);
  };

  const handleGenerateMultiContour = () => {
    const dates = layer.hydroDates ?? [];
    if (dates.length === 0) {
      window.alert('沒有日期可生成');
      return;
    }
    const allFeatures: Feature[] = [];
    const goodDates: string[] = [];
    for (const date of dates) {
      const iso = buildContourFeaturesForLayer(layer, date);
      if (iso.length > 0) {
        allFeatures.push(...buildContourLayerFeatures(layer, date));
        goodDates.push(date);
      }
    }
    if (goodDates.length === 0) {
      window.alert('所有日期的資料都不足以生成等水位線（每日至少 3 個有效深度）');
      return;
    }
    const latest = goodDates[goodDates.length - 1];
    const newLayer: VectorLayer = {
      id: `wlc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      name: latest,
      visible: true,
      opacity: 0.85,
      color: '#3b82f6',
      strokeColor: '#3b82f6',
      strokeWidth: 1.5,
      labelVisible: true,
      labelColor: '#ffffff',
      labelSize: 11,
      kind: 'line',
      data: { type: 'FeatureCollection', features: allFeatures } as FeatureCollection,
      featureCount: allFeatures.length,
      waterLevel: {
        dates: goodDates,
        activeDate: latest,
        sourceLayerId: layer.id,
        model: contourModel,
      },
    };
    onAddLayer(newLayer);
  };

  const onlyPoints =
    layer.data.features.length > 0 &&
    layer.data.features.every(
      (f) => f.geometry?.type === 'Point' || f.geometry?.type === 'MultiPoint',
    );

  if (pickingActive) {
    const target = pickingFeatureIndex !== null && pickingFeatureIndex !== undefined
      ? layer.data.features[pickingFeatureIndex]
      : null;
    const name = (target?.properties as Record<string, unknown> | undefined)?.['名稱'];
    return (
      <div className="pick-banner">
        <span className="pick-icon">📍</span>
        <div className="pick-text">
          <strong>在地圖上點擊目標位置</strong>
          <span className="meta-text">
            {layer.name}
            {pickingFeatureIndex !== null && pickingFeatureIndex !== undefined
              ? ` · 第 ${pickingFeatureIndex + 1} 筆${name ? `「${String(name)}」` : ''}`
              : ''}
            ，按 Esc 取消
          </span>
        </div>
        <button className="btn sm" onClick={onCancelPick}>取消</button>
      </div>
    );
  }

  return (
    <div className="bottom-dock" style={{ height: dockHeight }}>
      <div className="dock-resize-handle" onMouseDown={startResize} title="拖曳調整高度" />
      <button className="dock-close" title="關閉" onClick={onClose}>×</button>
      <div className="dock-header">
        <div className="dock-title-block">
          <div className="dock-title-row">
            <h2 className="modal-title">{layer.name}</h2>
            <div className="title-icons">
              <button
                className="icon-btn-mini"
                title="複製整個圖層"
                onClick={() => onDuplicateLayer(layer.id)}
              >⎘</button>
              <button
                className="icon-btn-mini"
                title="匯出為 GeoJSON 檔"
                onClick={() => onExportLayer(layer.id)}
              >⬇</button>
            </div>
          </div>
          <p className="modal-sub">
            {rows.length} / {layer.featureCount} features · {columns.length} fields · 點擊儲存格可編輯
          </p>
        </div>
      </div>

        <div className="dock-tabs">
          <button
            className={`dock-tab ${activeTab === 'main' ? 'active' : ''}`}
            type="button"
            title="預設分頁，無法刪除"
            onClick={() => setActiveTab('main')}
          >
            主屬性表
          </button>
          {hydroOpen && (
            <button
              className={`dock-tab ${activeTab === 'hydro' ? 'active' : ''}`}
              type="button"
              onClick={() => setActiveTab('hydro')}
            >
              水文監測
            </button>
          )}
          {gwConcTabs.map((tab) => (
            <button
              key={tab.id}
              className={`dock-tab ${activeTab === tab.id ? 'active' : ''}`}
              type="button"
              onClick={() => setActiveTab(tab.id)}
            >
              {gwConcTabTitle(tab)}
            </button>
          ))}
          {soilConcTabs.map((tab) => (
            <button
              key={tab.id}
              className={`dock-tab ${activeTab === tab.id ? 'active' : ''}`}
              type="button"
              onClick={() => setActiveTab(tab.id)}
            >
              {soilConcTabTitle(tab)}
            </button>
          ))}
          <div className="dock-tab-add-wrap">
            <button
              className="dock-tab-add"
              type="button"
              title="新增分頁"
              onClick={() => setTabMenuOpen((v) => !v)}
            >+</button>
            {tabMenuOpen && (
              <div className="dock-tab-menu">
                <div className="dock-tab-menu-title">新增分頁</div>
                <button
                  className="dock-tab-menu-item"
                  disabled={!onlyPoints || hydroOpen}
                  title={
                    hydroOpen ? '已開啟' : !onlyPoints ? '需要 Point 圖層' : '新增水文監測分頁'
                  }
                  onClick={() => {
                    setHydroOpen(true);
                    setActiveTab('hydro');
                    setTabMenuOpen(false);
                  }}
                >
                  <span>水文監測</span>
                  {(hydroOpen || !onlyPoints) && (
                    <span className="dock-tab-menu-hint">
                      {hydroOpen ? '已開啟' : '需要 Point'}
                    </span>
                  )}
                </button>
                <button
                  className="dock-tab-menu-item"
                  disabled={!onlyPoints}
                  title={!onlyPoints ? '需要 Point 圖層' : '新增地下水濃度監測分頁'}
                  onClick={() => {
                    const id = `gw-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
                    const newTab: GwConcTab = { id, substances: [] };
                    onUpdateLayer(layer.id, {
                      gwConcTabs: [...gwConcTabs, newTab],
                    });
                    setActiveTab(id);
                    setTabMenuOpen(false);
                  }}
                >
                  <span>地下水濃度監測</span>
                  {!onlyPoints && (
                    <span className="dock-tab-menu-hint">需要 Point</span>
                  )}
                </button>
                <button
                  className="dock-tab-menu-item"
                  disabled={!onlyPoints}
                  title={!onlyPoints ? '需要 Point 圖層' : '新增土壤濃度監測分頁'}
                  onClick={() => {
                    const id = `soil-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
                    const newTab: SoilConcTab = { id, landUse: 'general', substances: [] };
                    const needsCol = layer.data.features.some(
                      (f) => !(SOIL_BATCH_KEY in ((f.properties ?? {}) as Record<string, unknown>)),
                    );
                    const patch: Partial<VectorLayer> = { soilConcTabs: [...soilConcTabs, newTab] };
                    if (needsCol) {
                      patch.data = {
                        ...layer.data,
                        features: layer.data.features.map((f) => {
                          const props = (f.properties ?? {}) as Record<string, unknown>;
                          if (SOIL_BATCH_KEY in props) return f;
                          return { ...f, properties: { ...props, [SOIL_BATCH_KEY]: '' } } as Feature;
                        }),
                      } as FeatureCollection;
                    }
                    onUpdateLayer(layer.id, patch);
                    setActiveTab('main');
                    setTabMenuOpen(false);
                    window.alert(
                      '已新增「土壤濃度監測」分頁，並在主屬性表加入「批次名稱」欄位。\n\n請先在主屬性表為每個點位填寫「批次名稱」（同一批採樣填相同名稱），再回到此分頁選擇批次輸入濃度。',
                    );
                  }}
                >
                  <span>土壤濃度監測</span>
                  {!onlyPoints && (
                    <span className="dock-tab-menu-hint">需要 Point</span>
                  )}
                </button>
                <button className="dock-tab-menu-item" disabled title="即將推出">
                  <span>土壤氣體濃度監測</span>
                  <span className="dock-tab-menu-hint">即將推出</span>
                </button>
                <button className="dock-tab-menu-item" disabled title="即將推出">
                  <span>土壤氣體濃度快篩</span>
                  <span className="dock-tab-menu-hint">即將推出</span>
                </button>
                <button className="dock-tab-menu-item" disabled title="即將推出">
                  <span>其他</span>
                  <span className="dock-tab-menu-hint">即將推出</span>
                </button>
              </div>
            )}
          </div>
        </div>

        {activeTab === 'main' && (
        <div className="dock-actions tab-actions">
          <input
            className="search-input"
            placeholder="搜尋…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <button
            className="btn xs"
            onClick={() => setAddingColumn((v) => !v)}
          >+ 欄位</button>
          <div className="add-point-wrap">
            <button
              className={`btn xs ${addPointPickActive ? 'primary' : ''}`}
              onClick={() => setAddPointMenuOpen((v) => !v)}
              title="新增點位（手動座標 / 地圖點選 / 載入檔案）"
            >+ 點位</button>
            {addPointMenuOpen && (
              <div className="add-point-menu">
                <button
                  className="dock-tab-menu-item"
                  onClick={() => { setAddingManualPoint(true); setAddPointMenuOpen(false); }}
                >手動輸入座標</button>
                <button
                  className="dock-tab-menu-item"
                  onClick={() => { setAddPointMenuOpen(false); onStartAddPointPick?.(); }}
                >在地圖上點選</button>
                <button
                  className="dock-tab-menu-item"
                  onClick={() => pointFileRef.current?.click()}
                >載入檔案（多點位）</button>
              </div>
            )}
            <input
              ref={pointFileRef}
              type="file"
              accept=".geojson,.json,.kml,.gpx,.zip,.shp,.csv"
              style={{ display: 'none' }}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) handleAddPointFile(f);
                if (pointFileRef.current) pointFileRef.current.value = '';
              }}
            />
          </div>
          {trashButton}
        </div>
        )}

        {activeTab === 'main' && addPointPickActive && (
          <div className="add-column-row pick-hint-row">
            <span className="hint">在地圖上點選位置以新增點位（Esc 取消）</span>
          </div>
        )}

        {activeTab === 'main' && addingManualPoint && (
          <div className="add-column-row">
            <input
              autoFocus
              className="search-input mini"
              type="number"
              step="any"
              placeholder="經度 lng"
              value={manualPoint.lng}
              onChange={(e) => setManualPoint((p) => ({ ...p, lng: e.target.value }))}
            />
            <input
              className="search-input mini"
              type="number"
              step="any"
              placeholder="緯度 lat"
              value={manualPoint.lat}
              onChange={(e) => setManualPoint((p) => ({ ...p, lat: e.target.value }))}
            />
            <input
              className="search-input"
              placeholder="名稱（選填）"
              value={manualPoint.name}
              onChange={(e) => setManualPoint((p) => ({ ...p, name: e.target.value }))}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleAddManualPoint();
                if (e.key === 'Escape') setAddingManualPoint(false);
              }}
            />
            <button className="btn xs primary" onClick={handleAddManualPoint}>新增</button>
            <button className="btn xs" onClick={() => setAddingManualPoint(false)}>取消</button>
          </div>
        )}

        {activeTab === 'main' && addingColumn && (
          <div className="add-column-row">
            <input
              autoFocus
              className="search-input"
              placeholder="新欄位名稱"
              value={newColName}
              onChange={(e) => setNewColName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleAddColumn(newColName);
                if (e.key === 'Escape') {
                  setAddingColumn(false);
                  setNewColName('');
                }
              }}
            />
            <button className="btn xs primary" onClick={() => handleAddColumn(newColName)}>
              建立
            </button>
            <button className="btn xs" onClick={() => { setAddingColumn(false); setNewColName(''); }}>
              取消
            </button>
          </div>
        )}

        {activeTab === 'main' && (
        <div className="table-wrap">
          <table className="attr-table">
            <thead>
              <tr>
                <th className="row-num">#</th>
                <th className="geom-col">幾何</th>
                <th
                  className={`coords-col ${sortKey === '__coords' ? 'sorted' : ''}`}
                  onClick={() => toggleSort('__coords')}
                >
                  座標{sortKey === '__coords' && (sortDesc ? ' ▼' : ' ▲')}
                </th>
                {!onlyPoints && (
                  <th
                    className={`size-col ${sortKey === '__size' ? 'sorted' : ''}`}
                    onClick={() => toggleSort('__size')}
                  >
                    大小{sortKey === '__size' && (sortDesc ? ' ▼' : ' ▲')}
                  </th>
                )}
                {columns.map((c) => (
                  <th
                    key={c}
                    onClick={() => toggleSort(c)}
                    className={sortKey === c ? 'sorted' : ''}
                  >
                    <span className="col-title">
                      {c}{sortKey === c && (sortDesc ? ' ▼' : ' ▲')}
                    </span>
                    {c !== '名稱' && c !== '高程' && (
                      <button
                        className="col-del"
                        title={`刪除欄位 ${c}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDeleteColumn(c);
                        }}
                      >×</button>
                    )}
                  </th>
                ))}
                <th className="action-col"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ feature, index, props, geomType, coords, size }) => {
                const isPoint = geomType === 'Point';
                const isEditingCoords = coordsEdit?.row === index;
                return (
                <tr key={index}>
                  <td className="row-num">{index + 1}</td>
                  <td className="geom-col">{geomType}</td>
                  <td
                    className={`coords-col ${isPoint ? 'editable' : ''} ${isEditingCoords ? 'editing' : ''}`}
                    onClick={() => !isEditingCoords && isPoint && startCoordsEdit(index)}
                    title={isEditingCoords ? '' : isPoint ? `${coords}  (點擊以編輯)` : coords}
                  >
                    {isEditingCoords ? (
                      <div className="coord-edit-wrap">
                        <input
                          autoFocus
                          className={`cell-input ${coordsEdit?.error ? 'has-error' : ''}`}
                          value={coordsEdit.value}
                          onChange={(e) => setCoordsEdit({ row: index, value: e.target.value })}
                          onBlur={commitCoordsEdit}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') commitCoordsEdit();
                            if (e.key === 'Escape') cancelCoordsEdit();
                          }}
                          onClick={(e) => e.stopPropagation()}
                          placeholder="經度, 緯度"
                        />
                        {coordsEdit.error && <span className="coord-edit-err">{coordsEdit.error}</span>}
                      </div>
                    ) : (
                      <div className="coord-display">
                        <span>{coords}</span>
                        {isPoint && onStartPick && (
                          <button
                            className="icon-btn pick-btn"
                            title="從地圖上點擊選取新位置"
                            onClick={(e) => {
                              e.stopPropagation();
                              onStartPick(index);
                            }}
                          >📍</button>
                        )}
                      </div>
                    )}
                  </td>
                  {!onlyPoints && <td className="size-col" title={size}>{size}</td>}
                  {columns.map((c) => {
                    const isEditing = editing?.row === index && editing.key === c;
                    return (
                      <td
                        key={c}
                        className={`editable ${isEditing ? 'editing' : ''}`}
                        onClick={() => !isEditing && startEdit(index, c)}
                        title={isEditing ? '' : formatValue(props[c])}
                      >
                        {isEditing ? (
                          <input
                            autoFocus
                            className="cell-input"
                            value={editValue}
                            onChange={(e) => setEditValue(e.target.value)}
                            onBlur={commitEdit}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') commitEdit();
                              if (e.key === 'Escape') cancelEdit();
                            }}
                            onClick={(e) => e.stopPropagation()}
                          />
                        ) : (
                          <span>{formatValue(props[c])}</span>
                        )}
                      </td>
                    );
                  })}
                  <td className="action-col">
                    <button
                      className="icon-btn"
                      title="定位到此 feature"
                      onClick={() => onZoomFeature(feature)}
                    >⤢</button>
                    <button
                      className="icon-btn danger"
                      title="刪除此 feature"
                      onClick={() => handleDeleteRow(index)}
                    >×</button>
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
          {columns.length === 0 && (
            <p className="hint" style={{ padding: '8px 12px' }}>
              此圖層沒有使用者屬性欄位，顯示自動計算的幾何資訊。按上方「+ 欄位」新增。
            </p>
          )}
        </div>
        )}

        {activeTab === 'hydro' && (
          <div className="hydro-view">
            <div className="hydro-formula">
              <span className="hydro-formula-label">公式</span>
              <code>水位 = 高程 − 量測深度</code>
              <button
                className="btn xs"
                onClick={() => setAddingDate((v) => !v)}
                style={{ marginLeft: 8 }}
              >
                + 日期
              </button>
              <div className="hydro-formula-actions">
                <button
                  className="btn xs"
                  title="下載 CSV 紀錄表（給現場人員填寫）"
                  onClick={handleGenerateRecord}
                >
                  生成紀錄表
                </button>
                <button
                  className="btn xs"
                  title="從 CSV 匯入紀錄（同名稱+日期會覆蓋，不同日期會新增）"
                  onClick={() => recordFileRef.current?.click()}
                >
                  匯入紀錄表
                </button>
                <input
                  ref={recordFileRef}
                  type="file"
                  accept=".csv,text/csv"
                  style={{ display: 'none' }}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) handleImportRecord(f);
                    if (recordFileRef.current) recordFileRef.current.value = '';
                  }}
                />
              </div>
              {trashButton}
            </div>

            {addingDate && (
              <div className="add-column-row">
                <input
                  autoFocus
                  type="date"
                  className="search-input"
                  value={newDate}
                  onChange={(e) => setNewDate(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleAddDate();
                    if (e.key === 'Escape') setAddingDate(false);
                  }}
                />
                <button className="btn xs primary" onClick={handleAddDate}>
                  建立
                </button>
                <button className="btn xs" onClick={() => setAddingDate(false)}>
                  取消
                </button>
              </div>
            )}

            <div className="table-wrap">
              <table className="attr-table hydro-table">
                <thead>
                  <tr>
                    <th rowSpan={2} className="row-num hydro-frozen hydro-frozen-num">#</th>
                    <th rowSpan={2} className="hydro-frozen hydro-frozen-name">名稱</th>
                    <th rowSpan={2} className="hydro-frozen hydro-frozen-elev">高程</th>
                    {hydroDates.map((date) => {
                      const isEditingDate = dateEditing?.date === date;
                      return (
                        <th key={date} colSpan={2} className="hydro-date-th">
                          <div className="hydro-date-th-inner">
                            {isEditingDate ? (
                              <input
                                autoFocus
                                type="date"
                                className="cell-input"
                                value={dateEditing.value}
                                onChange={(e) =>
                                  setDateEditing({ date, value: e.target.value })
                                }
                                onBlur={commitEditDate}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') commitEditDate();
                                  if (e.key === 'Escape') cancelEditDate();
                                }}
                                onClick={(e) => e.stopPropagation()}
                              />
                            ) : (
                              <span
                                className="hydro-date-label"
                                title={`${date}（點擊修改）`}
                                onClick={() => startEditDate(date)}
                              >
                                {date}
                              </span>
                            )}
                            <button
                              className="col-gen"
                              title={`為 ${date} 生成單日等水位線圖層`}
                              onClick={() => handleGenerateSingleContour(date)}
                            >
                              <DropIcon count={1} />
                            </button>
                            <button
                              className="col-del"
                              title={`刪除日期 ${date}`}
                              onClick={() => handleRemoveDate(date)}
                            >×</button>
                          </div>
                        </th>
                      );
                    })}
                  </tr>
                  <tr>
                    {hydroDates.flatMap((date) => [
                      <th key={`${date}-d`} className="hydro-sub-th">深度</th>,
                      <th key={`${date}-l`} className="hydro-sub-th">水位</th>,
                    ])}
                  </tr>
                </thead>
                <tbody>
                  {layer.data.features
                    .map((f, originalIdx) => ({ feature: f, originalIdx }))
                    .filter(
                      ({ feature }) =>
                        feature.geometry?.type === 'Point' ||
                        feature.geometry?.type === 'MultiPoint',
                    )
                    .map(({ feature, originalIdx }, i) => {
                      const props = (feature.properties ?? {}) as Record<string, unknown>;
                      const elev = props['高程'];
                      const elevNum = typeof elev === 'number' ? elev : null;
                      const hydro = (props['__hydro'] as Record<string, unknown> | undefined) ?? {};
                      const isEditingElev =
                        editing?.row === originalIdx && editing.key === '高程';
                      return (
                        <tr key={originalIdx}>
                          <td className="row-num hydro-frozen hydro-frozen-num">{i + 1}</td>
                          <td className="hydro-frozen hydro-frozen-name">{formatValue(props['名稱'])}</td>
                          <td
                            className={`editable hydro-frozen hydro-frozen-elev ${isEditingElev ? 'editing' : ''}`}
                            onClick={() => !isEditingElev && startEdit(originalIdx, '高程')}
                          >
                            {isEditingElev ? (
                              <input
                                autoFocus
                                className="cell-input"
                                value={editValue}
                                onChange={(e) => setEditValue(e.target.value)}
                                onBlur={commitEdit}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') commitEdit();
                                  if (e.key === 'Escape') cancelEdit();
                                }}
                                onClick={(e) => e.stopPropagation()}
                              />
                            ) : (
                              <span>{formatValue(elev)}</span>
                            )}
                          </td>
                          {hydroDates.flatMap((date) => {
                            const depth = hydro[date];
                            const depthNum = typeof depth === 'number' ? depth : null;
                            const level =
                              depthNum !== null && elevNum !== null
                                ? elevNum - depthNum
                                : null;
                            const isEditing =
                              hydroEditing?.originalIdx === originalIdx &&
                              hydroEditing.date === date;
                            return [
                              <td
                                key={`${date}-d`}
                                className={`editable ${isEditing ? 'editing' : ''}`}
                                onClick={() => !isEditing && startHydroEdit(originalIdx, date)}
                              >
                                {isEditing ? (
                                  <input
                                    autoFocus
                                    type="number"
                                    step="any"
                                    className="cell-input"
                                    value={hydroEditing.value}
                                    onChange={(e) =>
                                      setHydroEditing({ ...hydroEditing, value: e.target.value })
                                    }
                                    onBlur={commitHydroEdit}
                                    onKeyDown={(e) => {
                                      if (e.key === 'Enter') commitHydroEdit();
                                      if (e.key === 'Escape') cancelHydroEdit();
                                    }}
                                    onClick={(e) => e.stopPropagation()}
                                  />
                                ) : (
                                  <span>{depthNum !== null ? depthNum.toFixed(3) : '-'}</span>
                                )}
                              </td>,
                              <td key={`${date}-l`} className="hydro-level-cell">
                                {level !== null ? level.toFixed(3) : '-'}
                              </td>,
                            ];
                          })}
                        </tr>
                      );
                    })}
                </tbody>
              </table>
            </div>
            <div className="hydro-bottom-bar">
              <label className="hydro-model-label">模型</label>
              <select
                className="select hydro-model-select"
                value={contourModel}
                onChange={(e) => setContourModel(e.target.value as 'idw' | 'tin' | 'kriging')}
              >
                <option value="idw">IDW（反距離加權）</option>
                <option value="tin">TIN（Delaunay 線性）</option>
                <option value="kriging">Kriging（普通克利金）</option>
              </select>
              <button
                className="hydro-gen-btn"
                title="生成複日等水位線圖層"
                onClick={handleGenerateMultiContour}
                disabled={hydroDates.length === 0}
              >
                <DropIcon count={2} />
              </button>
              <span className="hydro-unit-hint">※ 單位為公尺 (m)</span>
            </div>
          </div>
        )}

        {activeGwConcTab && (
          <GwConcTabPanel
            tab={activeGwConcTab}
            allTabs={gwConcTabs}
            layer={layer}
            onUpdateLayer={onUpdateLayer}
            onAddLayer={onAddLayer}
            draggingSubId={draggingSubId}
            setDraggingSubId={setDraggingSubId}
            onDeleteSubstance={(subId) => deleteGwConcSubstance(activeGwConcTab.id, subId)}
            trashSlot={trashButton}
          />
        )}
        {activeSoilConcTab && (
          <SoilConcTabPanel
            tab={activeSoilConcTab}
            allTabs={soilConcTabs}
            layer={layer}
            onUpdateLayer={onUpdateLayer}
            onAddLayer={onAddLayer}
            draggingSubId={draggingSubId}
            setDraggingSubId={setDraggingSubId}
            trashSlot={trashButton}
          />
        )}
    </div>
  );
}

function gwConcTabTitle(tab: GwConcTab): string {
  const label = tab.label?.trim();
  return label ? `地下水濃度監測 (${label})` : '地下水濃度監測';
}

function soilConcTabTitle(tab: SoilConcTab): string {
  const label = tab.label?.trim();
  return label ? `土壤濃度監測 (${label})` : '土壤濃度監測';
}

function GwConcTabPanel({
  tab,
  allTabs,
  layer,
  onUpdateLayer,
  onAddLayer,
  draggingSubId,
  setDraggingSubId,
  trashSlot,
}: {
  tab: GwConcTab;
  allTabs: GwConcTab[];
  layer: VectorLayer;
  onUpdateLayer: (id: string, patch: Partial<VectorLayer>) => void;
  onAddLayer: (layer: VectorLayer) => void;
  draggingSubId: string | null;
  setDraggingSubId: (id: string | null) => void;
  onDeleteSubstance: (subId: string) => void;
  trashSlot: React.ReactNode;
}) {
  const [activeSub, setActiveSub] = useState<string | null>(
    tab.substances[0]?.id ?? null,
  );
  const [addingSubstance, setAddingSubstance] = useState(false);
  const [newSubstanceName, setNewSubstanceName] = useState('');
  const [dragOverSubId, setDragOverSubId] = useState<string | null>(null);
  const [addingDate, setAddingDate] = useState(false);
  const [newDate, setNewDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [cellEditing, setCellEditing] = useState<{ originalIdx: number; date: string; value: string } | null>(null);
  const [dateEditing, setDateEditing] = useState<{ date: string; value: string } | null>(null);
  const [contourModel, setContourModel] = useState<'idw' | 'tin' | 'kriging' | 'indicator'>('idw');
  const [logTransform, setLogTransform] = useState(false);
  const [clampNegative, setClampNegative] = useState(true);
  const reportFileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (activeSub && tab.substances.some((s) => s.id === activeSub)) return;
    setActiveSub(tab.substances[0]?.id ?? null);
  }, [tab.id, tab.substances, activeSub]);

  const updateTab = (patch: Partial<GwConcTab>) => {
    const next = allTabs.map((t) => (t.id === tab.id ? { ...t, ...patch } : t));
    onUpdateLayer(layer.id, { gwConcTabs: next });
  };

  const updateSubstance = (subId: string, patch: Partial<GwConcSubstance>) => {
    updateTab({
      substances: tab.substances.map((s) => (s.id === subId ? { ...s, ...patch } : s)),
    });
  };

  const handleAddSubstance = () => {
    const name = newSubstanceName.trim();
    if (!name) return;
    const id = `sub-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const std = lookupGwConcStandard(name);
    const newSub: GwConcSubstance = {
      id,
      name,
      ...(std ? { controlConc: std.controlConc, monitorConc: std.monitorConc, unit: std.unit } : {}),
    };
    updateTab({ substances: [...tab.substances, newSub] });
    setActiveSub(id);
    setAddingSubstance(false);
    setNewSubstanceName('');
  };

  const reorderSubstance = (fromId: string, toId: string) => {
    if (fromId === toId) return;
    const from = tab.substances.findIndex((s) => s.id === fromId);
    const to = tab.substances.findIndex((s) => s.id === toId);
    if (from < 0 || to < 0) return;
    const next = [...tab.substances];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    updateTab({ substances: next });
  };

  const activeSubstance = tab.substances.find((s) => s.id === activeSub);
  const subDates = tab.dates ?? [];

  const handleAddDate = () => {
    const d = newDate.trim();
    if (!d) return;
    if (subDates.includes(d)) {
      setAddingDate(false);
      return;
    }
    const nextDates = [...subDates, d].sort();
    updateTab({ dates: nextDates });
    setAddingDate(false);
    setNewDate(new Date().toISOString().slice(0, 10));
  };

  const handleRemoveDate = (date: string) => {
    if (!window.confirm(`確定刪除日期「${date}」？所有污染物在此日期的資料都會移除。`)) return;
    const nextDates = subDates.filter((d) => d !== date);
    const tabId = tab.id;
    const newFeatures = layer.data.features.map((f) => {
      const props = (f.properties ?? {}) as Record<string, unknown>;
      const gw = (props['__gwConc'] as Record<string, Record<string, Record<string, unknown>>> | undefined);
      const tabBucket = gw?.[tabId];
      if (!tabBucket) return f;
      let changed = false;
      const nextTabBucket: Record<string, Record<string, unknown>> = {};
      for (const [subId, subBucket] of Object.entries(tabBucket)) {
        if (!(date in subBucket)) {
          nextTabBucket[subId] = subBucket;
          continue;
        }
        const nextSubBucket = { ...subBucket };
        delete nextSubBucket[date];
        nextTabBucket[subId] = nextSubBucket;
        changed = true;
      }
      if (!changed) return f;
      return {
        ...f,
        properties: { ...props, __gwConc: { ...gw, [tabId]: nextTabBucket } },
      } as Feature;
    });
    const newTabs = allTabs.map((t) => (t.id === tabId ? { ...t, dates: nextDates } : t));
    onUpdateLayer(layer.id, {
      gwConcTabs: newTabs,
      data: { ...layer.data, features: newFeatures } as FeatureCollection,
    });
  };

  const handleEditDate = (oldDate: string, newDateStr: string) => {
    const next = newDateStr.trim();
    if (!next || next === oldDate) return;
    if (subDates.includes(next)) {
      window.alert(`日期「${next}」已存在`);
      return;
    }
    const nextDates = subDates.map((d) => (d === oldDate ? next : d)).sort();
    const tabId = tab.id;
    const newFeatures = layer.data.features.map((f) => {
      const props = (f.properties ?? {}) as Record<string, unknown>;
      const gw = (props['__gwConc'] as Record<string, Record<string, Record<string, unknown>>> | undefined);
      const tabBucket = gw?.[tabId];
      if (!tabBucket) return f;
      let changed = false;
      const nextTabBucket: Record<string, Record<string, unknown>> = {};
      for (const [subId, subBucket] of Object.entries(tabBucket)) {
        if (!(oldDate in subBucket)) {
          nextTabBucket[subId] = subBucket;
          continue;
        }
        const nextSubBucket = { ...subBucket };
        nextSubBucket[next] = nextSubBucket[oldDate];
        delete nextSubBucket[oldDate];
        nextTabBucket[subId] = nextSubBucket;
        changed = true;
      }
      if (!changed) return f;
      return {
        ...f,
        properties: { ...props, __gwConc: { ...gw, [tabId]: nextTabBucket } },
      } as Feature;
    });
    const newTabs = allTabs.map((t) => (t.id === tabId ? { ...t, dates: nextDates } : t));
    onUpdateLayer(layer.id, {
      gwConcTabs: newTabs,
      data: { ...layer.data, features: newFeatures } as FeatureCollection,
    });
  };

  const startCellEdit = (originalIdx: number, date: string) => {
    if (!activeSubstance) return;
    const f = layer.data.features[originalIdx];
    const cur = (f?.properties as Record<string, unknown> | undefined)?.['__gwConc'] as
      | Record<string, Record<string, Record<string, unknown>>>
      | undefined;
    const v = cur?.[tab.id]?.[activeSubstance.id]?.[date];
    setCellEditing({
      originalIdx,
      date,
      value: typeof v === 'number' ? String(v) : '',
    });
  };

  const commitCellEdit = () => {
    if (!cellEditing || !activeSubstance) return;
    const { originalIdx, date, value } = cellEditing;
    const trimmed = value.trim();
    let nextVal: number | null = null;
    if (trimmed !== '') {
      const n = parseFloat(trimmed);
      if (Number.isFinite(n)) nextVal = n;
    }
    const tabId = tab.id;
    const subId = activeSubstance.id;
    const newFeatures = layer.data.features.map((f, i) => {
      if (i !== originalIdx) return f;
      const props = (f.properties ?? {}) as Record<string, unknown>;
      const gw = ((props['__gwConc'] as Record<string, Record<string, Record<string, unknown>>> | undefined) ?? {});
      const tabBucket = gw[tabId] ?? {};
      const subBucket = (tabBucket[subId] as Record<string, unknown> | undefined) ?? {};
      const nextSubBucket = { ...subBucket };
      if (nextVal === null) delete nextSubBucket[date];
      else nextSubBucket[date] = nextVal;
      const nextTabBucket = { ...tabBucket, [subId]: nextSubBucket };
      const nextGw = { ...gw, [tabId]: nextTabBucket };
      return { ...f, properties: { ...props, __gwConc: nextGw } } as Feature;
    });
    onUpdateLayer(layer.id, {
      data: { ...layer.data, features: newFeatures } as FeatureCollection,
    });
    setCellEditing(null);
  };

  const cancelCellEdit = () => setCellEditing(null);

  const handleImportReport = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result ?? '').replace(/^\uFEFF/, '');
      const rows = parseCsv(text);
      if (rows.length < 2) {
        window.alert('CSV 沒有資料');
        return;
      }
      const header = rows[0].map((s) => s.trim());
      const nameIdx = header.indexOf('名稱');
      const dateIdx = header.indexOf('日期');
      const subIdx = header.indexOf('污染物');
      const concIdx = header.findIndex((h) => h === '濃度' || h.startsWith('濃度'));
      if (nameIdx < 0 || dateIdx < 0 || subIdx < 0 || concIdx < 0) {
        window.alert('CSV 格式錯誤：需含「名稱」、「日期」、「污染物」、「濃度」四欄');
        return;
      }
      const nameToIdx = new Map<string, number>();
      layer.data.features.forEach((f, i) => {
        if (f.geometry?.type !== 'Point' && f.geometry?.type !== 'MultiPoint') return;
        const props = (f.properties ?? {}) as Record<string, unknown>;
        const n = formatValue(props['名稱']).trim();
        if (n && !nameToIdx.has(n)) nameToIdx.set(n, i);
      });
      const subByName = new Map<string, GwConcSubstance>();
      for (const s of tab.substances) {
        if (s.name?.trim()) subByName.set(s.name.trim(), s);
      }
      const newSubstances: GwConcSubstance[] = [...tab.substances];
      const dateSet = new Set<string>(subDates);
      const updates = new Map<number, Map<string, Map<string, number>>>();
      let imported = 0;
      let skipped = 0;
      for (let i = 1; i < rows.length; i++) {
        const r = rows[i];
        const name = (r[nameIdx] ?? '').trim();
        const date = (r[dateIdx] ?? '').trim();
        const subName = (r[subIdx] ?? '').trim();
        const concStr = (r[concIdx] ?? '').trim();
        if (!name && !date && !subName && !concStr) continue;
        if (!name || !date || !subName || !concStr) { skipped++; continue; }
        const conc = parseFloat(concStr);
        if (!Number.isFinite(conc)) { skipped++; continue; }
        const featIdx = nameToIdx.get(name);
        if (featIdx === undefined) { skipped++; continue; }
        let sub = subByName.get(subName);
        if (!sub) {
          const std = lookupGwConcStandard(subName);
          sub = {
            id: `sub-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            name: subName,
            ...(std ? { controlConc: std.controlConc, monitorConc: std.monitorConc, unit: std.unit } : {}),
          };
          subByName.set(subName, sub);
          newSubstances.push(sub);
        }
        dateSet.add(date);
        if (!updates.has(featIdx)) updates.set(featIdx, new Map());
        const featMap = updates.get(featIdx)!;
        if (!featMap.has(sub.id)) featMap.set(sub.id, new Map());
        featMap.get(sub.id)!.set(date, conc);
        imported++;
      }
      if (imported === 0) {
        window.alert(`沒有可匯入的資料${skipped > 0 ? `（${skipped} 筆忽略）` : ''}`);
        return;
      }
      const tabId = tab.id;
      const newFeatures = layer.data.features.map((f, i) => {
        const u = updates.get(i);
        if (!u) return f;
        const props = (f.properties ?? {}) as Record<string, unknown>;
        const gw = ((props['__gwConc'] as Record<string, Record<string, Record<string, unknown>>> | undefined) ?? {});
        const tabBucket = { ...(gw[tabId] ?? {}) };
        for (const [subId, dateMap] of u) {
          const subBucket = { ...((tabBucket[subId] as Record<string, unknown>) ?? {}) };
          for (const [d, v] of dateMap) subBucket[d] = v;
          tabBucket[subId] = subBucket;
        }
        return {
          ...f,
          properties: { ...props, __gwConc: { ...gw, [tabId]: tabBucket } },
        } as Feature;
      });
      const newTabs = allTabs.map((t) =>
        t.id === tabId
          ? { ...t, substances: newSubstances, dates: Array.from(dateSet).sort() }
          : t,
      );
      onUpdateLayer(layer.id, {
        gwConcTabs: newTabs,
        data: { ...layer.data, features: newFeatures } as FeatureCollection,
      });
      window.alert(
        `匯入完成：${imported} 筆${skipped > 0 ? `，${skipped} 筆忽略（名稱對不到 / 數值無效 / 欄位空白）` : ''}`,
      );
    };
    reader.readAsText(file, 'utf-8');
  };

  const handleGenerateSingleConc = (date: string) => {
    if (!activeSubstance) return;
    const samples = collectGwConcSamplesForDate(layer, tab.id, activeSubstance.id, date);
    if (samples.length < 3) {
      window.alert(`日期「${date}」資料不足以生成等濃度線（至少 3 個有效濃度值）`);
      return;
    }
    const contourOpts = {
      logTransform,
      clampNegative,
      indicatorThreshold:
        contourModel === 'indicator' ? activeSubstance.controlConc : undefined,
    };
    const { fill, lines, thresholds } = makeGwConcDefaults(activeSubstance);
    const arrows = { enabled: false };
    const features = buildContourLayerFeatures(layer, date, fill, lines, arrows, {
      model: contourModel,
      samples,
      contourOpts,
      thresholds,
    });
    if (features.length === 0) {
      window.alert('無法生成（樣本可能太集中或數值幾乎相同）');
      return;
    }
    const labelTitle = activeSubstance.name || '濃度';
    const newLayer: VectorLayer = {
      id: `gwc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      name: `${labelTitle} ${date}`,
      visible: true,
      opacity: 0.85,
      color: '#000000',
      strokeColor: '#000000',
      strokeWidth: 1.5,
      labelVisible: true,
      labelColor: '#ffffff',
      labelSize: 11,
      kind: 'line',
      data: { type: 'FeatureCollection', features } as FeatureCollection,
      featureCount: features.length,
      waterLevel: {
        dates: [date],
        activeDate: date,
        sourceLayerId: layer.id,
        model: contourModel,
        sourceKind: 'gw-conc',
        sourceTabId: tab.id,
        sourceSubId: activeSubstance.id,
        logTransform,
        clampNegative,
        indicatorThreshold:
          contourModel === 'indicator' ? activeSubstance.controlConc : undefined,
        fill,
        lines,
        arrows,
      },
    };
    onAddLayer(newLayer);
  };

  const handleGenerateAllSubstancesMulti = () => {
    if (tab.substances.length === 0) {
      window.alert('沒有污染物可生成');
      return;
    }
    if (subDates.length === 0) {
      window.alert('沒有日期可生成');
      return;
    }
    const allFeatures: Feature[] = [];
    const includedSubs: Array<{ id: string; name: string }> = [];
    const allDateSet = new Set<string>();
    const skippedSubs: string[] = [];
    for (const sub of tab.substances) {
      const { fill, lines, thresholds } = makeGwConcDefaults(sub);
      const contourOpts = {
        logTransform,
        clampNegative,
        indicatorThreshold:
          contourModel === 'indicator' ? sub.controlConc : undefined,
      };
      let added = false;
      for (const date of subDates) {
        const samples = collectGwConcSamplesForDate(layer, tab.id, sub.id, date);
        if (samples.length < 3) continue;
        const feats = buildContourLayerFeatures(layer, date, fill, lines, { enabled: false }, {
          model: contourModel,
          samples,
          contourOpts,
          thresholds,
        });
        if (feats.length === 0) continue;
        for (const f of feats) {
          allFeatures.push({
            ...f,
            properties: {
              ...(f.properties ?? {}),
              __substance: sub.id,
              __substanceName: sub.name,
            },
          });
        }
        allDateSet.add(date);
        added = true;
      }
      if (added) {
        includedSubs.push({ id: sub.id, name: sub.name });
      } else {
        skippedSubs.push(sub.name || '(未命名)');
      }
    }
    if (includedSubs.length === 0) {
      window.alert('所有污染物都資料不足，沒有生成圖層');
      return;
    }
    const goodDates = Array.from(allDateSet).sort();
    const latest = goodDates[goodDates.length - 1];
    const firstSub = includedSubs[0];
    const newLayer: VectorLayer = {
      id: `gwc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}-multi`,
      name: `${tab.label?.trim() ? `${tab.label} ` : ''}多污染物 ${latest}`,
      visible: true,
      opacity: 0.85,
      color: '#000000',
      strokeColor: '#000000',
      strokeWidth: 1.5,
      labelVisible: true,
      labelColor: '#ffffff',
      labelSize: 11,
      kind: 'line',
      data: { type: 'FeatureCollection', features: allFeatures } as FeatureCollection,
      featureCount: allFeatures.length,
      waterLevel: {
        dates: goodDates,
        activeDate: latest,
        sourceLayerId: layer.id,
        model: contourModel,
        sourceKind: 'gw-conc',
        sourceTabId: tab.id,
        substances: includedSubs,
        activeSubstance: firstSub.id,
        logTransform,
        clampNegative,
        arrows: { enabled: false },
      },
    };
    onAddLayer(newLayer);
    if (skippedSubs.length > 0) {
      window.alert(`已生成；資料不足略過：${skippedSubs.join('、')}`);
    }
  };

  const handleGenerateMultiConc = () => {
    if (!activeSubstance) return;
    const dates = subDates;
    if (dates.length === 0) {
      window.alert('沒有日期可生成');
      return;
    }
    const { fill, lines, thresholds } = makeGwConcDefaults(activeSubstance);
    const arrows = { enabled: false };
    const allFeatures: Feature[] = [];
    const goodDates: string[] = [];
    const contourOpts = {
      logTransform,
      clampNegative,
      indicatorThreshold:
        contourModel === 'indicator' ? activeSubstance.controlConc : undefined,
    };
    for (const date of dates) {
      const samples = collectGwConcSamplesForDate(layer, tab.id, activeSubstance.id, date);
      if (samples.length < 3) continue;
      const feats = buildContourLayerFeatures(layer, date, fill, lines, arrows, {
        model: contourModel,
        samples,
        contourOpts,
        thresholds,
      });
      if (feats.length === 0) continue;
      allFeatures.push(...feats);
      goodDates.push(date);
    }
    if (goodDates.length === 0) {
      window.alert('所有日期的資料都不足以生成等濃度線（每日至少 3 個有效濃度值）');
      return;
    }
    const latest = goodDates[goodDates.length - 1];
    const labelTitle = activeSubstance.name || '濃度';
    const newLayer: VectorLayer = {
      id: `gwc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      name: `${labelTitle} ${latest}`,
      visible: true,
      opacity: 0.85,
      color: '#000000',
      strokeColor: '#000000',
      strokeWidth: 1.5,
      labelVisible: true,
      labelColor: '#ffffff',
      labelSize: 11,
      kind: 'line',
      data: { type: 'FeatureCollection', features: allFeatures } as FeatureCollection,
      featureCount: allFeatures.length,
      waterLevel: {
        dates: goodDates,
        activeDate: latest,
        sourceLayerId: layer.id,
        model: contourModel,
        sourceKind: 'gw-conc',
        sourceTabId: tab.id,
        sourceSubId: activeSubstance.id,
        logTransform,
        clampNegative,
        indicatorThreshold:
          contourModel === 'indicator' ? activeSubstance.controlConc : undefined,
        fill,
        lines,
        arrows,
      },
    };
    onAddLayer(newLayer);
  };

  return (
    <div className="hydro-view">
      <div className="gw-conc-config gw-conc-config-top">
        <label className="gw-conc-field">
          <span className="gw-conc-field-label">機構/批次</span>
          <input
            className="cell-input"
            type="text"
            placeholder="例如 SGS"
            value={tab.label ?? ''}
            onChange={(e) => updateTab({ label: e.target.value })}
          />
        </label>
        <button
          className="btn xs"
          onClick={() => setAddingDate((v) => !v)}
        >+ 日期</button>
        <button
          className="btn xs"
          title="匯入 CSV 報告（每列含名稱/日期/污染物/濃度，缺少的污染物會自動建立）"
          onClick={() => reportFileRef.current?.click()}
        >匯入報告</button>
        <input
          ref={reportFileRef}
          type="file"
          accept=".csv,text/csv"
          style={{ display: 'none' }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) handleImportReport(f);
            if (reportFileRef.current) reportFileRef.current.value = '';
          }}
        />
        <button
          className="hydro-gen-btn gw-conc-gen-all"
          title="生成所有污染物 × 所有日期的等濃度線圖層"
          onClick={handleGenerateAllSubstancesMulti}
          disabled={tab.substances.length === 0 || subDates.length === 0}
        >
          <ConcMatrixIcon kind="multi-multi" />
        </button>
        {trashSlot}
      </div>

      <div className="gw-conc-subtabs">
        {tab.substances.map((s) => {
          const dragging = draggingSubId === s.id;
          const dropTarget = dragOverSubId === s.id && draggingSubId && draggingSubId !== s.id;
          return (
            <div
              key={s.id}
              className={`gw-conc-subtab${activeSub === s.id ? ' active' : ''}${dragging ? ' dragging' : ''}${dropTarget ? ' drop-target' : ''}`}
              draggable
              onClick={() => setActiveSub(s.id)}
              onDragStart={(e) => {
                setDraggingSubId(s.id);
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', s.id);
              }}
              onDragEnd={() => {
                setDraggingSubId(null);
                setDragOverSubId(null);
              }}
              onDragOver={(e) => {
                if (!draggingSubId || draggingSubId === s.id) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                setDragOverSubId(s.id);
              }}
              onDragLeave={() => {
                if (dragOverSubId === s.id) setDragOverSubId(null);
              }}
              onDrop={(e) => {
                e.preventDefault();
                if (draggingSubId) reorderSubstance(draggingSubId, s.id);
                setDragOverSubId(null);
                setDraggingSubId(null);
              }}
            >
              <span className="gw-conc-subtab-label">{s.name || '未命名'}</span>
            </div>
          );
        })}
        <button
          type="button"
          className="gw-conc-subtab-add"
          onClick={() => setAddingSubstance(true)}
        >+ 新增污染物</button>
      </div>

      {addingSubstance && (
        <div className="add-column-row">
          <input
            autoFocus
            className="search-input"
            placeholder="污染物名稱（例如 甲苯）"
            list="gw-conc-pollutant-list"
            value={newSubstanceName}
            onChange={(e) => setNewSubstanceName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleAddSubstance();
              if (e.key === 'Escape') {
                setAddingSubstance(false);
                setNewSubstanceName('');
              }
            }}
          />
          <button className="btn xs primary" onClick={handleAddSubstance}>建立</button>
          <button
            className="btn xs"
            onClick={() => {
              setAddingSubstance(false);
              setNewSubstanceName('');
            }}
          >取消</button>
          <datalist id="gw-conc-pollutant-list">
            <option value="苯" />
            <option value="甲苯" />
            <option value="乙苯" />
            <option value="二甲苯" />
            <option value="萘" />
            <option value="MTBE" />
            <option value="三氯乙烯" />
            <option value="四氯乙烯" />
            <option value="氯乙烯" />
            <option value="1,1-二氯乙烯" />
            <option value="1,2-二氯乙烷" />
            <option value="1,1,1-三氯乙烷" />
            <option value="二氯甲烷" />
            <option value="砷" />
            <option value="鎘" />
            <option value="鉻" />
            <option value="鉛" />
            <option value="銅" />
            <option value="鋅" />
            <option value="鎳" />
            <option value="汞" />
            <option value="氰化物" />
            <option value="硝酸鹽氮" />
            <option value="氟鹽" />
          </datalist>
        </div>
      )}

      {activeSubstance ? (
        <div className="gw-conc-config">
          <label className="gw-conc-field">
            <span className="gw-conc-field-label">管制濃度</span>
            <input
              className="cell-input"
              type="number"
              step="any"
              placeholder="—"
              value={activeSubstance.controlConc ?? ''}
              onChange={(e) => {
                const v = e.target.value.trim();
                if (v === '') {
                  const { controlConc: _d, ...rest } = activeSubstance;
                  updateTab({
                    substances: tab.substances.map((s) =>
                      s.id === activeSubstance.id ? rest : s,
                    ),
                  });
                  return;
                }
                const n = parseFloat(v);
                if (Number.isFinite(n)) updateSubstance(activeSubstance.id, { controlConc: n });
              }}
            />
          </label>
          <label className="gw-conc-field">
            <span className="gw-conc-field-label">監測濃度</span>
            <input
              className="cell-input"
              type="number"
              step="any"
              placeholder="—"
              value={activeSubstance.monitorConc ?? ''}
              onChange={(e) => {
                const v = e.target.value.trim();
                if (v === '') {
                  const { monitorConc: _d, ...rest } = activeSubstance;
                  updateTab({
                    substances: tab.substances.map((s) =>
                      s.id === activeSubstance.id ? rest : s,
                    ),
                  });
                  return;
                }
                const n = parseFloat(v);
                if (Number.isFinite(n)) updateSubstance(activeSubstance.id, { monitorConc: n });
              }}
            />
          </label>
          <label className="gw-conc-field">
            <span className="gw-conc-field-label">單位</span>
            <input
              className="cell-input"
              type="text"
              placeholder="例如 mg/L"
              value={activeSubstance.unit ?? ''}
              onChange={(e) => updateSubstance(activeSubstance.id, { unit: e.target.value })}
            />
          </label>
        </div>
      ) : (
        !addingSubstance && (
          <p className="hint" style={{ padding: '12px' }}>
            尚無污染物，點選「+ 新增污染物」開始建立
          </p>
        )
      )}

      {addingDate && (
        <div className="add-column-row">
          <input
            autoFocus
            type="date"
            className="search-input"
            value={newDate}
            onChange={(e) => setNewDate(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleAddDate();
              if (e.key === 'Escape') setAddingDate(false);
            }}
          />
          <button className="btn xs primary" onClick={handleAddDate}>建立</button>
          <button className="btn xs" onClick={() => setAddingDate(false)}>取消</button>
        </div>
      )}

      {activeSubstance && (
        <>
          <div className="table-wrap">
            <table className="attr-table hydro-table gw-conc-table">
              <thead>
                <tr>
                  <th className="row-num hydro-frozen hydro-frozen-num">#</th>
                  <th className="hydro-frozen hydro-frozen-name gw-conc-frozen-last">名稱</th>
                  {subDates.map((date) => {
                    const isEditingDate = dateEditing?.date === date;
                    return (
                      <th key={date} className="hydro-date-th">
                        <div className="hydro-date-th-inner">
                          {isEditingDate ? (
                            <input
                              autoFocus
                              type="date"
                              className="cell-input"
                              value={dateEditing.value}
                              onChange={(e) => setDateEditing({ date, value: e.target.value })}
                              onBlur={() => {
                                if (dateEditing) handleEditDate(dateEditing.date, dateEditing.value);
                                setDateEditing(null);
                              }}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                  if (dateEditing) handleEditDate(dateEditing.date, dateEditing.value);
                                  setDateEditing(null);
                                }
                                if (e.key === 'Escape') setDateEditing(null);
                              }}
                              onClick={(e) => e.stopPropagation()}
                            />
                          ) : (
                            <span
                              className="hydro-date-label"
                              title={`${date}（點擊修改）`}
                              onClick={() => setDateEditing({ date, value: date })}
                            >
                              {date}
                            </span>
                          )}
                          <button
                            className="col-gen"
                            title={`為 ${date} 生成單日等濃度線圖層`}
                            onClick={() => handleGenerateSingleConc(date)}
                          >
                            <ConcMatrixIcon kind="single" />
                          </button>
                          <button
                            className="col-del"
                            title={`刪除日期 ${date}`}
                            onClick={() => handleRemoveDate(date)}
                          >×</button>
                        </div>
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {layer.data.features
                  .map((f, originalIdx) => ({ feature: f, originalIdx }))
                  .filter(
                    ({ feature }) =>
                      feature.geometry?.type === 'Point' ||
                      feature.geometry?.type === 'MultiPoint',
                  )
                  .map(({ feature, originalIdx }, i) => {
                    const props = (feature.properties ?? {}) as Record<string, unknown>;
                    const gw = (props['__gwConc'] as Record<string, Record<string, Record<string, unknown>>> | undefined);
                    const subBucket = gw?.[tab.id]?.[activeSubstance.id];
                    return (
                      <tr key={originalIdx}>
                        <td className="row-num hydro-frozen hydro-frozen-num">{i + 1}</td>
                        <td className="hydro-frozen hydro-frozen-name gw-conc-frozen-last">{formatValue(props['名稱'])}</td>
                        {subDates.map((date) => {
                          const v = subBucket?.[date];
                          const num = typeof v === 'number' ? v : null;
                          const isEditing =
                            cellEditing?.originalIdx === originalIdx &&
                            cellEditing.date === date;
                          const C = activeSubstance.controlConc;
                          const M = activeSubstance.monitorConc;
                          let level: 'alert' | 'warn' | null = null;
                          if (num !== null) {
                            if (typeof C === 'number' && num >= C) level = 'alert';
                            else if (typeof M === 'number' && num >= M) level = 'warn';
                          }
                          const cellCls = [
                            'editable',
                            isEditing ? 'editing' : '',
                            level ? `gw-conc-cell-${level}` : '',
                          ].filter(Boolean).join(' ');
                          return (
                            <td
                              key={date}
                              className={cellCls}
                              onClick={() => !isEditing && startCellEdit(originalIdx, date)}
                            >
                              {isEditing ? (
                                <input
                                  autoFocus
                                  type="number"
                                  step="any"
                                  className="cell-input"
                                  value={cellEditing.value}
                                  onChange={(e) => setCellEditing({ ...cellEditing, value: e.target.value })}
                                  onBlur={commitCellEdit}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter') commitCellEdit();
                                    if (e.key === 'Escape') cancelCellEdit();
                                  }}
                                  onClick={(e) => e.stopPropagation()}
                                />
                              ) : (
                                <span>{num !== null ? num.toString() : '-'}</span>
                              )}
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </div>

          <div className="hydro-bottom-bar">
            <label className="hydro-model-label">模型</label>
            <select
              className="select hydro-model-select"
              value={contourModel}
              onChange={(e) => setContourModel(e.target.value as 'idw' | 'tin' | 'kriging' | 'indicator')}
            >
              <option value="idw">IDW（反距離加權）</option>
              <option value="tin">TIN（Delaunay 線性）</option>
              <option value="kriging">Kriging（普通克利金）</option>
              <option value="indicator">Indicator Kriging（超標機率）</option>
            </select>
            <label className="gw-conc-toggle">
              <input
                type="checkbox"
                checked={logTransform}
                onChange={(e) => setLogTransform(e.target.checked)}
              />
              log-transform
            </label>
            <label className="gw-conc-toggle">
              <input
                type="checkbox"
                checked={clampNegative}
                onChange={(e) => setClampNegative(e.target.checked)}
              />
              負值歸0
            </label>
            <button
              className="hydro-gen-btn"
              title="生成複日等濃度線圖層"
              onClick={handleGenerateMultiConc}
              disabled={subDates.length === 0}
            >
              <ConcMatrixIcon kind="multi-day" />
            </button>
            <span className="hydro-unit-hint">
              ※ 單位 {activeSubstance.unit?.trim() || '—'}
            </span>
          </div>
        </>
      )}
    </div>
  );
}

function SoilConcTabPanel({
  tab,
  allTabs,
  layer,
  onUpdateLayer,
  onAddLayer,
  draggingSubId,
  setDraggingSubId,
  trashSlot,
}: {
  tab: SoilConcTab;
  allTabs: SoilConcTab[];
  layer: VectorLayer;
  onUpdateLayer: (id: string, patch: Partial<VectorLayer>) => void;
  onAddLayer: (layer: VectorLayer) => void;
  draggingSubId: string | null;
  setDraggingSubId: (id: string | null) => void;
  trashSlot: React.ReactNode;
}) {
  const [activeSub, setActiveSub] = useState<string | null>(tab.substances[0]?.id ?? null);
  const [addingSubstance, setAddingSubstance] = useState(false);
  const [newSubstanceName, setNewSubstanceName] = useState('');
  const [dragOverSubId, setDragOverSubId] = useState<string | null>(null);
  const [cellEditing, setCellEditing] = useState<{ originalIdx: number; value: string } | null>(null);
  const reportFileRef = useRef<HTMLInputElement>(null);

  const landUse: SoilLandUse = tab.landUse ?? 'general';
  const batches = collectBatches(layer);
  const activeBatch = tab.activeBatch && batches.includes(tab.activeBatch) ? tab.activeBatch : (batches[0] ?? '');

  useEffect(() => {
    if (activeSub && tab.substances.some((s) => s.id === activeSub)) return;
    setActiveSub(tab.substances[0]?.id ?? null);
  }, [tab.id, tab.substances, activeSub]);

  const updateTab = (patch: Partial<SoilConcTab>) => {
    const next = allTabs.map((t) => (t.id === tab.id ? { ...t, ...patch } : t));
    onUpdateLayer(layer.id, { soilConcTabs: next });
  };

  const updateSubstance = (subId: string, patch: Partial<GwConcSubstance>) => {
    updateTab({ substances: tab.substances.map((s) => (s.id === subId ? { ...s, ...patch } : s)) });
  };

  const activeSubstance = tab.substances.find((s) => s.id === activeSub);

  const handleAddSubstance = () => {
    const name = newSubstanceName.trim();
    if (!name) return;
    const id = `sub-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const std = lookupSoilConcStandard(name, landUse);
    const newSub: GwConcSubstance = {
      id,
      name,
      ...(std ? { controlConc: std.controlConc, monitorConc: std.monitorConc, unit: std.unit } : { unit: 'mg/kg' }),
    };
    updateTab({ substances: [...tab.substances, newSub] });
    setActiveSub(id);
    setAddingSubstance(false);
    setNewSubstanceName('');
  };

  const reorderSubstance = (fromId: string, toId: string) => {
    if (fromId === toId) return;
    const from = tab.substances.findIndex((s) => s.id === fromId);
    const to = tab.substances.findIndex((s) => s.id === toId);
    if (from < 0 || to < 0) return;
    const next = [...tab.substances];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    updateTab({ substances: next });
  };

  const startCellEdit = (originalIdx: number) => {
    if (!activeSubstance) return;
    const v = readSoilConc(layer.data.features[originalIdx], tab.id, activeSubstance.id);
    setCellEditing({ originalIdx, value: v !== null ? String(v) : '' });
  };

  const commitCellEdit = () => {
    if (!cellEditing || !activeSubstance) return;
    const { originalIdx, value } = cellEditing;
    const trimmed = value.trim();
    let nextVal: number | null = null;
    if (trimmed !== '') {
      const n = parseFloat(trimmed);
      if (Number.isFinite(n)) nextVal = n;
    }
    const tabId = tab.id;
    const subId = activeSubstance.id;
    const newFeatures = layer.data.features.map((f, i) => {
      if (i !== originalIdx) return f;
      const props = (f.properties ?? {}) as Record<string, unknown>;
      const soil = (props['__soilConc'] as Record<string, Record<string, unknown>> | undefined) ?? {};
      const tabBucket = { ...((soil[tabId] as Record<string, unknown>) ?? {}) };
      if (nextVal === null) delete tabBucket[subId];
      else tabBucket[subId] = nextVal;
      return { ...f, properties: { ...props, __soilConc: { ...soil, [tabId]: tabBucket } } } as Feature;
    });
    onUpdateLayer(layer.id, { data: { ...layer.data, features: newFeatures } as FeatureCollection });
    setCellEditing(null);
  };

  const handleImportReport = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result ?? '').replace(/^\uFEFF/, '');
      const rows = parseCsv(text);
      if (rows.length < 2) {
        window.alert('CSV 沒有資料');
        return;
      }
      const header = rows[0].map((s) => s.trim());
      const nameIdx = header.indexOf('名稱');
      const subIdx = header.indexOf('污染物');
      const concIdx = header.findIndex((h) => h === '濃度' || h.startsWith('濃度'));
      const batchIdx = header.indexOf(SOIL_BATCH_KEY);
      if (nameIdx < 0 || subIdx < 0 || concIdx < 0) {
        window.alert('CSV 格式錯誤：需含「名稱」、「污染物」、「濃度」三欄（可選「批次名稱」）');
        return;
      }
      const nameToIdx = new Map<string, number>();
      layer.data.features.forEach((f, i) => {
        if (f.geometry?.type !== 'Point' && f.geometry?.type !== 'MultiPoint') return;
        const n = formatValue((f.properties as Record<string, unknown> | undefined)?.['名稱']).trim();
        if (n && !nameToIdx.has(n)) nameToIdx.set(n, i);
      });
      const subByName = new Map<string, GwConcSubstance>();
      for (const s of tab.substances) if (s.name?.trim()) subByName.set(s.name.trim(), s);
      const newSubstances: GwConcSubstance[] = [...tab.substances];
      const concUpdates = new Map<number, Map<string, number>>();
      const batchUpdates = new Map<number, string>();
      let imported = 0;
      let skipped = 0;
      for (let i = 1; i < rows.length; i++) {
        const r = rows[i];
        const name = (r[nameIdx] ?? '').trim();
        const subName = (r[subIdx] ?? '').trim();
        const concStr = (r[concIdx] ?? '').trim();
        if (!name && !subName && !concStr) continue;
        if (!name || !subName || !concStr) { skipped++; continue; }
        const conc = parseFloat(concStr);
        if (!Number.isFinite(conc)) { skipped++; continue; }
        const featIdx = nameToIdx.get(name);
        if (featIdx === undefined) { skipped++; continue; }
        let sub = subByName.get(subName);
        if (!sub) {
          const std = lookupSoilConcStandard(subName, landUse);
          sub = {
            id: `sub-${Date.now()}-${Math.random().toString(36).slice(2, 6)}-${i}`,
            name: subName,
            ...(std ? { controlConc: std.controlConc, monitorConc: std.monitorConc, unit: std.unit } : { unit: 'mg/kg' }),
          };
          subByName.set(subName, sub);
          newSubstances.push(sub);
        }
        if (!concUpdates.has(featIdx)) concUpdates.set(featIdx, new Map());
        concUpdates.get(featIdx)!.set(sub.id, conc);
        if (batchIdx >= 0) {
          const b = (r[batchIdx] ?? '').trim();
          if (b) batchUpdates.set(featIdx, b);
        }
        imported++;
      }
      if (imported === 0) {
        window.alert(`沒有可匯入的資料${skipped > 0 ? `（${skipped} 筆忽略）` : ''}`);
        return;
      }
      const tabId = tab.id;
      const newFeatures = layer.data.features.map((f, i) => {
        const cu = concUpdates.get(i);
        const bu = batchUpdates.get(i);
        if (!cu && bu === undefined) return f;
        const props = (f.properties ?? {}) as Record<string, unknown>;
        const nextProps: Record<string, unknown> = { ...props };
        if (cu) {
          const soil = (props['__soilConc'] as Record<string, Record<string, unknown>> | undefined) ?? {};
          const tabBucket = { ...((soil[tabId] as Record<string, unknown>) ?? {}) };
          for (const [subId, v] of cu) tabBucket[subId] = v;
          nextProps['__soilConc'] = { ...soil, [tabId]: tabBucket };
        }
        if (bu !== undefined) nextProps[SOIL_BATCH_KEY] = bu;
        return { ...f, properties: nextProps } as Feature;
      });
      const newTabs = allTabs.map((t) => (t.id === tabId ? { ...t, substances: newSubstances } : t));
      onUpdateLayer(layer.id, {
        soilConcTabs: newTabs,
        data: { ...layer.data, features: newFeatures } as FeatureCollection,
      });
      window.alert(`匯入完成：${imported} 筆${skipped > 0 ? `，${skipped} 筆忽略（名稱對不到 / 數值無效 / 欄位空白）` : ''}`);
    };
    reader.readAsText(file, 'utf-8');
  };

  const makeExceedanceLayer = (name: string, features: Feature[], config: ExceedanceConfig): VectorLayer => ({
    id: `soilx-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    name,
    visible: true,
    opacity: 0.95,
    color: EXCEEDANCE_COLORS.alert,
    strokeColor: '#ffffff',
    strokeWidth: 1.5,
    strokeVisible: true,
    pointRadius: config.radius ?? 7,
    labelVisible: true,
    labelColor: '#ffffff',
    labelHaloColor: '#000000',
    labelSize: 11,
    kind: 'point',
    data: { type: 'FeatureCollection', features } as FeatureCollection,
    featureCount: features.length,
    exceedance: config,
  });

  const countMeasured = (subs: GwConcSubstance[]): number => {
    let n = 0;
    for (const f of layer.data.features) {
      if (f.geometry?.type !== 'Point') continue;
      for (const s of subs) if (readSoilConc(f, tab.id, s.id) !== null) n++;
    }
    return n;
  };

  const baseConfig = (): Pick<ExceedanceConfig, 'sourceLayerId' | 'sourceKind' | 'sourceTabId' | 'showOk' | 'showNodata' | 'radius'> => ({
    sourceLayerId: layer.id,
    sourceKind: 'soil-conc',
    sourceTabId: tab.id,
    showOk: true,
    showNodata: false,
    radius: 7,
  });

  const handleGenerateSingle = () => {
    if (!activeSubstance) return;
    if (countMeasured([activeSubstance]) === 0) {
      window.alert(`「${activeSubstance.name}」尚無任何濃度資料`);
      return;
    }
    const features = buildExceedancePoints(layer, tab, [activeSubstance]);
    const config: ExceedanceConfig = {
      ...baseConfig(),
      sourceSubId: activeSubstance.id,
      batches: reconcileBatches([], batches),
    };
    onAddLayer(makeExceedanceLayer(`${activeSubstance.name} 超標圖`, features, config));
  };

  const handleGenerateAll = () => {
    if (tab.substances.length === 0) return;
    if (countMeasured(tab.substances) === 0) {
      window.alert('尚無任何濃度資料');
      return;
    }
    const features = buildExceedancePoints(layer, tab, tab.substances);
    const config: ExceedanceConfig = {
      ...baseConfig(),
      substances: tab.substances.map((s) => ({ id: s.id, name: s.name })),
      activeSubstance: tab.substances[0].id,
      batches: reconcileBatches([], batches),
    };
    onAddLayer(makeExceedanceLayer(`${tab.label?.trim() ? `${tab.label} ` : ''}多污染物超標圖`, features, config));
  };

  const batchRows = layer.data.features
    .map((f, originalIdx) => ({ feature: f, originalIdx }))
    .filter(({ feature }) => feature.geometry?.type === 'Point' || feature.geometry?.type === 'MultiPoint')
    .filter(({ feature }) => batchOf(feature) === activeBatch);

  return (
    <div className="hydro-view">
      <div className="gw-conc-config gw-conc-config-top">
        <label className="gw-conc-field">
          <span className="gw-conc-field-label">機構/批次</span>
          <input
            className="cell-input"
            type="text"
            placeholder="例如 SGS"
            value={tab.label ?? ''}
            onChange={(e) => updateTab({ label: e.target.value })}
          />
        </label>
        <label className="gw-conc-field">
          <span className="gw-conc-field-label">用地類別</span>
          <select
            className="select"
            value={landUse}
            onChange={(e) => updateTab({ landUse: e.target.value as SoilLandUse })}
            title="影響新增污染物時帶入的管制/監測標準預設值"
          >
            <option value="general">其他用地</option>
            <option value="farmland">食用作物農地</option>
          </select>
        </label>
        <label className="gw-conc-field">
          <span className="gw-conc-field-label">批次名稱</span>
          <select
            className="select"
            value={activeBatch}
            disabled={batches.length === 0}
            onChange={(e) => updateTab({ activeBatch: e.target.value })}
            title="選擇要輸入/檢視的採樣批次（批次名稱於主屬性表填寫）"
          >
            {batches.length === 0 && <option value="">（尚無批次）</option>}
            {batches.map((b) => <option key={b} value={b}>{b}</option>)}
          </select>
        </label>
        <button
          className="btn xs"
          title="匯入 CSV 報告（每列含名稱/污染物/濃度，可選批次名稱；缺少的污染物會自動建立）"
          onClick={() => reportFileRef.current?.click()}
        >匯入報告</button>
        <input
          ref={reportFileRef}
          type="file"
          accept=".csv,text/csv"
          style={{ display: 'none' }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) handleImportReport(f);
            if (reportFileRef.current) reportFileRef.current.value = '';
          }}
        />
        <button
          className="hydro-gen-btn gw-conc-gen-all"
          title="生成所有污染物的點位超標圖（含所有批次）"
          onClick={handleGenerateAll}
          disabled={tab.substances.length === 0 || batches.length === 0}
        >
          <ExceedanceIcon kind="multi" />
        </button>
        {trashSlot}
      </div>

      {batches.length === 0 ? (
        <p className="hint" style={{ padding: '14px' }}>
          尚未填寫批次名稱。請至「主屬性表」為每個點位填寫「批次名稱」欄位（同一批採樣填相同名稱），再回到此分頁。
        </p>
      ) : (
        <>
          <div className="gw-conc-subtabs">
            {tab.substances.map((s) => {
              const dragging = draggingSubId === s.id;
              const dropTarget = dragOverSubId === s.id && draggingSubId && draggingSubId !== s.id;
              return (
                <div
                  key={s.id}
                  className={`gw-conc-subtab${activeSub === s.id ? ' active' : ''}${dragging ? ' dragging' : ''}${dropTarget ? ' drop-target' : ''}`}
                  draggable
                  onClick={() => setActiveSub(s.id)}
                  onDragStart={(e) => {
                    setDraggingSubId(s.id);
                    e.dataTransfer.effectAllowed = 'move';
                    e.dataTransfer.setData('text/plain', s.id);
                  }}
                  onDragEnd={() => {
                    setDraggingSubId(null);
                    setDragOverSubId(null);
                  }}
                  onDragOver={(e) => {
                    if (!draggingSubId || draggingSubId === s.id) return;
                    e.preventDefault();
                    e.dataTransfer.dropEffect = 'move';
                    setDragOverSubId(s.id);
                  }}
                  onDragLeave={() => {
                    if (dragOverSubId === s.id) setDragOverSubId(null);
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    if (draggingSubId) reorderSubstance(draggingSubId, s.id);
                    setDragOverSubId(null);
                    setDraggingSubId(null);
                  }}
                >
                  <span className="gw-conc-subtab-label">{s.name || '未命名'}</span>
                </div>
              );
            })}
            <button type="button" className="gw-conc-subtab-add" onClick={() => setAddingSubstance(true)}>+ 新增污染物</button>
          </div>

          {addingSubstance && (
            <div className="add-column-row">
              <input
                autoFocus
                className="search-input"
                placeholder="污染物名稱（例如 鉛）"
                list="soil-conc-pollutant-list"
                value={newSubstanceName}
                onChange={(e) => setNewSubstanceName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleAddSubstance();
                  if (e.key === 'Escape') {
                    setAddingSubstance(false);
                    setNewSubstanceName('');
                  }
                }}
              />
              <button className="btn xs primary" onClick={handleAddSubstance}>建立</button>
              <button className="btn xs" onClick={() => { setAddingSubstance(false); setNewSubstanceName(''); }}>取消</button>
              <datalist id="soil-conc-pollutant-list">
                {SOIL_POLLUTANTS.map((p) => <option key={p} value={p} />)}
              </datalist>
            </div>
          )}

          {activeSubstance ? (
            <div className="gw-conc-config">
              <label className="gw-conc-field">
                <span className="gw-conc-field-label">管制標準</span>
                <input
                  className="cell-input"
                  type="number"
                  step="any"
                  placeholder="—"
                  value={activeSubstance.controlConc ?? ''}
                  onChange={(e) => {
                    const v = e.target.value.trim();
                    if (v === '') {
                      const { controlConc: _d, ...rest } = activeSubstance;
                      updateTab({ substances: tab.substances.map((s) => (s.id === activeSubstance.id ? rest : s)) });
                      return;
                    }
                    const n = parseFloat(v);
                    if (Number.isFinite(n)) updateSubstance(activeSubstance.id, { controlConc: n });
                  }}
                />
              </label>
              <label className="gw-conc-field">
                <span className="gw-conc-field-label">監測標準</span>
                <input
                  className="cell-input"
                  type="number"
                  step="any"
                  placeholder="—"
                  value={activeSubstance.monitorConc ?? ''}
                  onChange={(e) => {
                    const v = e.target.value.trim();
                    if (v === '') {
                      const { monitorConc: _d, ...rest } = activeSubstance;
                      updateTab({ substances: tab.substances.map((s) => (s.id === activeSubstance.id ? rest : s)) });
                      return;
                    }
                    const n = parseFloat(v);
                    if (Number.isFinite(n)) updateSubstance(activeSubstance.id, { monitorConc: n });
                  }}
                />
              </label>
              <label className="gw-conc-field">
                <span className="gw-conc-field-label">單位</span>
                <input
                  className="cell-input"
                  type="text"
                  placeholder="例如 mg/kg"
                  value={activeSubstance.unit ?? ''}
                  onChange={(e) => updateSubstance(activeSubstance.id, { unit: e.target.value })}
                />
              </label>
            </div>
          ) : (
            !addingSubstance && (
              <p className="hint" style={{ padding: '12px' }}>尚無污染物，點選「+ 新增污染物」開始建立</p>
            )
          )}

          {activeSubstance && (
            <>
              <div className="table-wrap">
                <table className="attr-table hydro-table gw-conc-table">
                  <thead>
                    <tr>
                      <th className="row-num hydro-frozen hydro-frozen-num">#</th>
                      <th className="hydro-frozen hydro-frozen-name gw-conc-frozen-last">名稱</th>
                      <th className="hydro-date-th">濃度（{activeSubstance.name}）</th>
                    </tr>
                  </thead>
                  <tbody>
                    {batchRows.map(({ feature, originalIdx }, i) => {
                      const props = (feature.properties ?? {}) as Record<string, unknown>;
                      const num = readSoilConc(feature, tab.id, activeSubstance.id);
                      const isEditing = cellEditing?.originalIdx === originalIdx;
                      const level = classifyExceedance(num, activeSubstance.controlConc, activeSubstance.monitorConc);
                      const cellLevel = level === 'alert' ? 'alert' : level === 'warn' ? 'warn' : null;
                      const cellCls = ['editable', isEditing ? 'editing' : '', cellLevel ? `gw-conc-cell-${cellLevel}` : ''].filter(Boolean).join(' ');
                      return (
                        <tr key={originalIdx}>
                          <td className="row-num hydro-frozen hydro-frozen-num">{i + 1}</td>
                          <td className="hydro-frozen hydro-frozen-name gw-conc-frozen-last">{formatValue(props['名稱'])}</td>
                          <td className={cellCls} onClick={() => !isEditing && startCellEdit(originalIdx)}>
                            {isEditing ? (
                              <input
                                autoFocus
                                type="number"
                                step="any"
                                className="cell-input"
                                value={cellEditing.value}
                                onChange={(e) => setCellEditing({ ...cellEditing, value: e.target.value })}
                                onBlur={commitCellEdit}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') commitCellEdit();
                                  if (e.key === 'Escape') setCellEditing(null);
                                }}
                                onClick={(e) => e.stopPropagation()}
                              />
                            ) : (
                              <span>{num !== null ? num.toString() : '-'}</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                    {batchRows.length === 0 && (
                      <tr><td colSpan={3} className="hint" style={{ padding: '10px' }}>此批次目前沒有點位</td></tr>
                    )}
                  </tbody>
                </table>
              </div>

              <div className="hydro-bottom-bar">
                <span className="hydro-legend-inline">
                  <span className="ex-dot" style={{ background: EXCEEDANCE_COLORS.alert }} />超管制
                  <span className="ex-dot" style={{ background: EXCEEDANCE_COLORS.warn }} />超監測
                  <span className="ex-dot" style={{ background: EXCEEDANCE_COLORS.ok }} />合格
                </span>
                <button
                  className="hydro-gen-btn"
                  title="生成此污染物的點位超標圖（含所有批次）"
                  onClick={handleGenerateSingle}
                  disabled={batches.length === 0}
                >
                  <ExceedanceIcon kind="single" />
                </button>
                <span className="hydro-unit-hint">※ 批次 {activeBatch || '—'}・單位 {activeSubstance.unit?.trim() || '—'}</span>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}

function ExceedanceIcon({ kind }: { kind: 'single' | 'multi' }) {
  // 點位分級示意：三色點
  const dots = kind === 'multi' ? 3 : 1;
  const colors = [EXCEEDANCE_COLORS.alert, EXCEEDANCE_COLORS.warn, EXCEEDANCE_COLORS.ok];
  return (
    <svg width={18} height={14} viewBox="0 0 18 14" aria-hidden>
      {Array.from({ length: dots }).map((_, i) => (
        <circle key={i} cx={4 + i * 5} cy={7} r={2.6} fill={colors[i] ?? EXCEEDANCE_COLORS.ok} />
      ))}
    </svg>
  );
}

function formatValue(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function coerceValue(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  const num = Number(trimmed);
  if (!Number.isNaN(num) && /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(trimmed)) return num;
  return raw;
}

function compareValues(a: unknown, b: unknown): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  const aStr = a === null || a === undefined ? '' : String(a);
  const bStr = b === null || b === undefined ? '' : String(b);
  const aNum = Number(aStr);
  const bNum = Number(bStr);
  if (!Number.isNaN(aNum) && !Number.isNaN(bNum) && aStr !== '' && bStr !== '') {
    return aNum - bNum;
  }
  return aStr.localeCompare(bStr);
}

function computeCoords(f: Feature): string {
  const geom = f.geometry;
  if (!geom) return '';
  try {
    if (geom.type === 'Point') {
      const [lng, lat] = geom.coordinates as [number, number];
      return `${lng.toFixed(5)}, ${lat.toFixed(5)}`;
    }
    if (geom.type === 'MultiPoint') {
      return `${geom.coordinates.length} 個點`;
    }
    const c = turf.centroid(f as turf.AllGeoJSON);
    const [lng, lat] = c.geometry.coordinates as [number, number];
    return `≈ ${lng.toFixed(5)}, ${lat.toFixed(5)}`;
  } catch {
    return '';
  }
}

function computeSize(f: Feature): string {
  const geom = f.geometry;
  if (!geom) return '';
  try {
    if (geom.type === 'LineString' || geom.type === 'MultiLineString') {
      const km = turf.length(f, { units: 'kilometers' });
      return km < 1 ? `${(km * 1000).toFixed(1)} m` : `${km.toFixed(2)} km`;
    }
    if (geom.type === 'Polygon' || geom.type === 'MultiPolygon') {
      const m2 = turf.area(f);
      return m2 < 10000 ? `${m2.toFixed(1)} m²` : `${(m2 / 10000).toFixed(2)} ha`;
    }
  } catch {
    /* noop */
  }
  return '';
}

function computeSizeValue(f: Feature): number | null {
  const geom = f.geometry;
  if (!geom) return null;
  try {
    if (geom.type === 'LineString' || geom.type === 'MultiLineString') {
      return turf.length(f, { units: 'meters' });
    }
    if (geom.type === 'Polygon' || geom.type === 'MultiPolygon') {
      return turf.area(f);
    }
  } catch {
    /* noop */
  }
  return null;
}

function csvEscape(s: string): string {
  if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let cur: string[] = [];
  let field = '';
  let inQuote = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuote) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuote = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuote = true;
    } else if (c === ',') {
      cur.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      cur.push(field);
      rows.push(cur);
      cur = [];
      field = '';
    } else {
      field += c;
    }
  }
  if (field !== '' || cur.length > 0) {
    cur.push(field);
    rows.push(cur);
  }
  return rows.filter((r) => r.length > 0 && r.some((c) => c.trim() !== ''));
}
