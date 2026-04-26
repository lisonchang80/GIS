import { useRef, useState } from 'react';
import { CollapsibleSection } from './CollapsibleSection';
import { TAIWAN_CITIES, type LandQueryParams } from './landQuery';

export type DrawMode =
  | 'static'
  | 'select'
  | 'point'
  | 'linestring'
  | 'polygon'
  | 'rectangle'
  | 'circle'
  | 'freehand';

interface Tool {
  id: DrawMode;
  label: string;
  icon: string;
  title: string;
}

const TOOLS: Tool[] = [
  { id: 'select', label: '選取', icon: '⭮', title: '選取 / 編輯 / 刪除節點' },
  { id: 'point', label: '點', icon: '●', title: '點擊地圖或輸入座標' },
  { id: 'linestring', label: '線', icon: '╱', title: '新增折線（雙擊結束）' },
  { id: 'polygon', label: '多邊形', icon: '▲', title: '新增多邊形（雙擊結束）' },
  { id: 'rectangle', label: '矩形', icon: '▭', title: '拖曳繪製矩形' },
  { id: 'circle', label: '圓形', icon: '◯', title: '拖曳繪製圓形' },
  { id: 'freehand', label: '自由', icon: '✎', title: '自由手繪' },
];

interface Props {
  activeMode: DrawMode;
  featureCount: number;
  onModeChange: (mode: DrawMode) => void;
  onDeleteSelected: () => void;
  onClearAll: () => void;
  onExport: () => void;
  onAddPointByCoords: (lng: number, lat: number) => string | null;
  onAddPolygonByLandNo: (params: LandQueryParams) => Promise<string | null>;
}

export function DrawToolbar(p: Props) {
  const [lng, setLng] = useState('');
  const [lat, setLat] = useState('');
  const [coordError, setCoordError] = useState<string | null>(null);
  const [landCity, setLandCity] = useState<string>(TAIWAN_CITIES[0]);
  const [landSection, setLandSection] = useState('');
  const [landParcel, setLandParcel] = useState('');
  const [landError, setLandError] = useState<string | null>(null);
  const [landLoading, setLandLoading] = useState(false);
  const landAbortRef = useRef<AbortController | null>(null);
  const [collapsed, setCollapsed] = useState(true);

  const handleAddLand = async () => {
    setLandError(null);
    if (!landSection.trim() || !landParcel.trim()) {
      setLandError('段名與地號皆為必填');
      return;
    }
    landAbortRef.current?.abort();
    const controller = new AbortController();
    landAbortRef.current = controller;
    setLandLoading(true);
    try {
      const err = await p.onAddPolygonByLandNo({
        city: landCity,
        section: landSection,
        parcel: landParcel,
      });
      if (controller.signal.aborted) return;
      if (err) {
        setLandError(err);
        return;
      }
      setLandSection('');
      setLandParcel('');
    } finally {
      if (landAbortRef.current === controller) {
        setLandLoading(false);
        landAbortRef.current = null;
      }
    }
  };

  const handleAddCoord = () => {
    setCoordError(null);
    const x = parseFloat(lng);
    const y = parseFloat(lat);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      setCoordError('請輸入有效的數字');
      return;
    }
    if (x < -180 || x > 180) {
      setCoordError('經度需介於 -180 ~ 180');
      return;
    }
    if (y < -90 || y > 90) {
      setCoordError('緯度需介於 -90 ~ 90');
      return;
    }
    const err = p.onAddPointByCoords(x, y);
    if (err) {
      setCoordError(err);
      return;
    }
    setLng('');
    setLat('');
  };

  return (
    <CollapsibleSection
      title={<>繪圖工具 <span className="counter">{p.featureCount}</span></>}
      collapsed={collapsed}
      onToggle={() => setCollapsed((c) => !c)}
    >
      <div className="tool-grid">
        {TOOLS.map((t) => (
          <button
            key={t.id}
            className={`tool-btn ${p.activeMode === t.id ? 'active' : ''}`}
            title={t.title}
            onClick={() =>
              p.onModeChange(p.activeMode === t.id ? 'static' : t.id)
            }
          >
            <span className="tool-icon">{t.icon}</span>
            <span className="tool-label">{t.label}</span>
          </button>
        ))}
      </div>

      <div className="tool-actions">
        <button className="btn sm" onClick={p.onDeleteSelected}>
          刪除選取
        </button>
        <button className="btn sm danger" onClick={p.onClearAll} disabled={p.featureCount === 0}>
          全部清除
        </button>
      </div>
      {p.activeMode === 'point' && (
        <div className="coord-box">
          <label className="label sublabel">輸入座標新增點</label>
          <div className="coord-row">
            <input
              type="number"
              className="coord-input"
              placeholder="經度 X"
              step="any"
              value={lng}
              onChange={(e) => setLng(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleAddCoord()}
            />
            <input
              type="number"
              className="coord-input"
              placeholder="緯度 Y"
              step="any"
              value={lat}
              onChange={(e) => setLat(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleAddCoord()}
            />
            <button className="btn sm primary coord-add" onClick={handleAddCoord}>
              新增
            </button>
          </div>
          {coordError ? (
            <p className="hint error-hint">{coordError}</p>
          ) : (
            <p className="hint">點擊地圖直接放點，或輸入十進位度座標（WGS84），例：121.5654, 25.0330</p>
          )}
        </div>
      )}

      {p.activeMode === 'polygon' && (
        <div className="coord-box">
          <label className="label sublabel">輸入地號新增多邊形</label>
          <select
            className="select"
            value={landCity}
            onChange={(e) => setLandCity(e.target.value)}
            disabled={landLoading}
          >
            {TAIWAN_CITIES.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
          <input
            type="text"
            className="coord-input"
            style={{ width: '100%', marginTop: 6 }}
            placeholder="段名（例：興雅段三小段）"
            value={landSection}
            onChange={(e) => setLandSection(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && !landLoading && handleAddLand()}
            disabled={landLoading}
          />
          <div className="coord-row" style={{ marginTop: 6 }}>
            <input
              type="text"
              className="coord-input"
              placeholder="地號（例：123 或 123-4）"
              value={landParcel}
              onChange={(e) => setLandParcel(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && !landLoading && handleAddLand()}
              disabled={landLoading}
            />
            <button
              className="btn sm primary coord-add"
              onClick={handleAddLand}
              disabled={landLoading || !landSection.trim() || !landParcel.trim()}
            >
              {landLoading ? '查詢中…' : '新增'}
            </button>
          </div>
          {landError ? (
            <p className="hint error-hint">{landError}</p>
          ) : (
            <p className="hint">資料來源：twland.ronny.tw（地政司圖資）</p>
          )}
        </div>
      )}

      <button
        className="btn sm primary"
        onClick={p.onExport}
        disabled={p.featureCount === 0}
        style={{ marginTop: 6 }}
      >
        匯出為圖層
      </button>
    </CollapsibleSection>
  );
}
