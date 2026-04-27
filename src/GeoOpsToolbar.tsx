import { useState } from 'react';
import { CollapsibleSection } from './CollapsibleSection';
import type { VectorLayer } from './types';
import type { BufferUnits } from './geoOps';

interface Props {
  layers: VectorLayer[];
  onBuffer: (layerId: string, distance: number, units: BufferUnits) => string | null;
}

export function GeoOpsToolbar({ layers, onBuffer }: Props) {
  const [collapsed, setCollapsed] = useState(true);
  const [bufLayerId, setBufLayerId] = useState('');
  const [bufDist, setBufDist] = useState('100');
  const [bufUnit, setBufUnit] = useState<BufferUnits>('meters');
  const [bufError, setBufError] = useState<string | null>(null);

  const handleBuffer = () => {
    setBufError(null);
    if (!bufLayerId) {
      setBufError('請先選來源圖層');
      return;
    }
    const d = parseFloat(bufDist);
    if (!Number.isFinite(d) || d === 0) {
      setBufError('距離須為非零數字（負值會內縮）');
      return;
    }
    const err = onBuffer(bufLayerId, d, bufUnit);
    if (err) setBufError(err);
  };

  return (
    <CollapsibleSection
      title="處理工具"
      collapsed={collapsed}
      onToggle={() => setCollapsed((c) => !c)}
    >
      <div className="coord-box">
        <label className="label sublabel">緩衝（Buffer）</label>
        <select
          className="select"
          value={bufLayerId}
          onChange={(e) => setBufLayerId(e.target.value)}
        >
          <option value="">— 選擇來源圖層 —</option>
          {layers.map((l) => (
            <option key={l.id} value={l.id}>{l.name}（{l.featureCount}）</option>
          ))}
        </select>
        <div className="coord-row" style={{ marginTop: 6 }}>
          <input
            type="number"
            className="coord-input"
            placeholder="距離"
            step="any"
            value={bufDist}
            onChange={(e) => setBufDist(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleBuffer()}
          />
          <select
            className="select"
            style={{ flex: '0 0 auto', width: 90 }}
            value={bufUnit}
            onChange={(e) => setBufUnit(e.target.value as BufferUnits)}
          >
            <option value="meters">公尺</option>
            <option value="kilometers">公里</option>
          </select>
          <button
            className="btn sm primary coord-add"
            onClick={handleBuffer}
            disabled={!bufLayerId}
          >執行</button>
        </div>
        {bufError ? (
          <p className="hint error-hint">{bufError}</p>
        ) : (
          <p className="hint">點 → 圓形；線 → 走廊；面 → 擴張。負距離可內縮多邊形。</p>
        )}
      </div>
    </CollapsibleSection>
  );
}
