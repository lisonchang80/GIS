import { useMemo, useRef, useState } from 'react';
import type { Feature, FeatureCollection } from 'geojson';
import * as turf from '@turf/turf';
import type { VectorLayer } from './types';

interface Props {
  layer: VectorLayer;
  onClose: () => void;
  onZoomFeature: (feature: Feature) => void;
  onUpdateLayer: (id: string, patch: Partial<VectorLayer>) => void;
  onDuplicateLayer: (id: string) => void;
  onExportLayer: (id: string) => void;
  pickingActive?: boolean;
  pickingFeatureIndex?: number | null;
  onStartPick?: (featureIndex: number) => void;
  onCancelPick?: () => void;
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
  onDuplicateLayer,
  onExportLayer,
  pickingActive,
  pickingFeatureIndex,
  onStartPick,
  onCancelPick,
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
    return ['名稱', ...Array.from(set)];
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
    if (name === '名稱') return;
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

  const hasPoints = layer.data.features.some((f) =>
    f.geometry?.type === 'Point' || f.geometry?.type === 'MultiPoint',
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
        <div className="dock-actions">
          <input
            className="search-input"
            placeholder="搜尋…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {hasPoints && !columns.includes('Z') && (
            <button
              className="btn sm"
              title="新增 Z 欄位（高程），預設 0"
              onClick={() => {
                const newFeatures = layer.data.features.map((f) => ({
                  ...f,
                  properties: { ...(f.properties ?? {}), Z: 0 },
                } as Feature));
                writeData(newFeatures);
              }}
            >+ Z</button>
          )}
          <button
            className="btn sm"
            onClick={() => setAddingColumn((v) => !v)}
          >+ 欄位</button>
        </div>
      </div>

        {addingColumn && (
          <div className="add-column-row">
            <input
              autoFocus
              className="search-input"
              placeholder="新欄位名稱（例如 Z、name、類別）"
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
            <button className="btn sm primary" onClick={() => handleAddColumn(newColName)}>
              建立
            </button>
            <button className="btn sm" onClick={() => { setAddingColumn(false); setNewColName(''); }}>
              取消
            </button>
          </div>
        )}

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
                <th
                  className={`size-col ${sortKey === '__size' ? 'sorted' : ''}`}
                  onClick={() => toggleSort('__size')}
                >
                  大小{sortKey === '__size' && (sortDesc ? ' ▼' : ' ▲')}
                </th>
                {columns.map((c) => (
                  <th
                    key={c}
                    onClick={() => toggleSort(c)}
                    className={sortKey === c ? 'sorted' : ''}
                  >
                    <span className="col-title">
                      {c}{sortKey === c && (sortDesc ? ' ▼' : ' ▲')}
                    </span>
                    {c !== '名稱' && (
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
                  <td className="size-col" title={size}>{size}</td>
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
              此圖層沒有使用者屬性欄位，顯示自動計算的幾何資訊。按上方「+ 欄位」或「+ Z」新增。
            </p>
          )}
        </div>
    </div>
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
      const km = turf.length(f as turf.AllGeoJSON, { units: 'kilometers' });
      return km < 1 ? `${(km * 1000).toFixed(1)} m` : `${km.toFixed(2)} km`;
    }
    if (geom.type === 'Polygon' || geom.type === 'MultiPolygon') {
      const m2 = turf.area(f as turf.AllGeoJSON);
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
      return turf.length(f as turf.AllGeoJSON, { units: 'meters' });
    }
    if (geom.type === 'Polygon' || geom.type === 'MultiPolygon') {
      return turf.area(f as turf.AllGeoJSON);
    }
  } catch {
    /* noop */
  }
  return null;
}
