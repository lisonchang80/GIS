import { useRef, useState, type ReactNode } from 'react';
import type { BaseMapId, BaseMapOption, VectorLayer } from './types';
import { LayerItem } from './LayerItem';

interface Props {
  basemaps: BaseMapOption[];
  activeBasemap: BaseMapId;
  onBasemapChange: (id: BaseMapId) => void;
  layers: VectorLayer[];
  onUpdateLayer: (id: string, patch: Partial<VectorLayer>) => void;
  onRemoveLayer: (id: string) => void;
  onZoomLayer: (id: string) => void;
  onReorderLayer: (draggedId: string, targetId: string, position: 'above' | 'below') => void;
  onShowAttributes: (id: string) => void;
  onToggleStyle: (id: string) => void;
  activeAttributesLayerId: string | null;
  activeStyleLayerId: string | null;
  onFiles: (files: FileList) => void;
  children?: ReactNode;
}

export function LayerPanel(p: Props) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const [overPosition, setOverPosition] = useState<'above' | 'below' | null>(null);

  return (
    <aside className="panel">
      <div className="panel-section">
        <h1 className="panel-title">Web GIS</h1>
        <p className="panel-sub">圖層管理與空間資料檢視</p>
      </div>

      <div className="panel-section">
        <label className="label">底圖</label>
        <select
          className="select"
          value={p.activeBasemap}
          onChange={(e) => p.onBasemapChange(e.target.value as BaseMapId)}
        >
          {p.basemaps.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>
      </div>

      <div className="panel-section">
        <label className="label">匯入資料</label>
        <input
          ref={fileRef}
          type="file"
          multiple
          accept=".geojson,.json,.kml,.gpx,.zip,.shp"
          style={{ display: 'none' }}
          onChange={(e) => {
            if (e.target.files && e.target.files.length > 0) {
              p.onFiles(e.target.files);
              if (fileRef.current) fileRef.current.value = '';
            }
          }}
        />
        <button className="btn primary" onClick={() => fileRef.current?.click()}>
          選擇檔案…
        </button>
        <p className="hint">支援 GeoJSON / KML / GPX / Shapefile (.zip)</p>
      </div>

      {p.children}

      <div className="panel-section layers-section">
        <label className="label">
          圖層 <span className="counter">{p.layers.length}</span>
          {p.layers.length > 1 && <span className="hint-inline">拖曳排序</span>}
        </label>
        {p.layers.length === 0 && <p className="empty">尚無圖層，請匯入檔案</p>}
        <ul className="layer-list">
          {p.layers.map((layer, i) => (
            <LayerItem
              key={layer.id}
              layer={layer}
              index={i}
              total={p.layers.length}
              dragOver={overId === layer.id && draggingId !== layer.id ? overPosition : null}
              onToggle={() => p.onUpdateLayer(layer.id, { visible: !layer.visible })}
              onOpacity={(v) => p.onUpdateLayer(layer.id, { opacity: v })}
              onUpdate={(patch) => p.onUpdateLayer(layer.id, patch)}
              onRename={(name) => p.onUpdateLayer(layer.id, { name })}
              onRemove={() => p.onRemoveLayer(layer.id)}
              onZoom={() => p.onZoomLayer(layer.id)}
              onShowAttributes={() => p.onShowAttributes(layer.id)}
              onToggleStyle={() => p.onToggleStyle(layer.id)}
              attributesActive={p.activeAttributesLayerId === layer.id}
              styleActive={p.activeStyleLayerId === layer.id}
              onDragStart={() => setDraggingId(layer.id)}
              onDragEnd={() => {
                setDraggingId(null);
                setOverId(null);
                setOverPosition(null);
              }}
              onDragOverRow={(position) => {
                if (draggingId !== layer.id) {
                  setOverId(layer.id);
                  setOverPosition(position);
                }
              }}
              onDragLeaveRow={() => {
                if (overId === layer.id) {
                  setOverId(null);
                  setOverPosition(null);
                }
              }}
              onDropRow={() => {
                if (draggingId && draggingId !== layer.id && overPosition) {
                  p.onReorderLayer(draggingId, layer.id, overPosition);
                }
                setDraggingId(null);
                setOverId(null);
                setOverPosition(null);
              }}
            />
          ))}
        </ul>
      </div>
    </aside>
  );
}
