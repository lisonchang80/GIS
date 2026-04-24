import type { VectorLayer } from './types';

interface Props {
  layer: VectorLayer;
  onClose: () => void;
  onUpdate: (patch: Partial<VectorLayer>) => void;
}

export function StylePopover({ layer, onClose, onUpdate }: Props) {
  const stroke = layer.strokeColor ?? layer.color;
  const strokeW = layer.strokeWidth ?? 2;
  const radius = layer.pointRadius ?? 5;
  const showPointSize = layer.kind === 'point' || layer.kind === 'mixed';

  return (
    <div className="style-popover">
        <div className="popover-header">
          <span className="popover-title">樣式 · {layer.name}</span>
          <button className="icon-btn" onClick={onClose}>×</button>
        </div>

        <div className="popover-body">
          <div className="popover-row">
            <label className="popover-label">填色</label>
            <input
              type="color"
              value={layer.color}
              onChange={(e) => onUpdate({ color: e.target.value })}
              className="color-swatch wide"
            />
          </div>

          <div className="popover-row">
            <label className="popover-label">描邊顏色</label>
            <input
              type="color"
              value={stroke}
              onChange={(e) => onUpdate({ strokeColor: e.target.value })}
              className="color-swatch wide"
            />
          </div>

          <div className="popover-row">
            <label className="popover-label">透明度</label>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={layer.opacity}
              onChange={(e) => onUpdate({ opacity: parseFloat(e.target.value) })}
              className="slider"
            />
            <span className="popover-value">{Math.round(layer.opacity * 100)}%</span>
          </div>

          <div className="popover-row">
            <label className="popover-label">描邊粗細</label>
            <input
              type="range"
              min={0.5}
              max={8}
              step={0.5}
              value={strokeW}
              onChange={(e) => onUpdate({ strokeWidth: parseFloat(e.target.value) })}
              className="slider"
            />
            <span className="popover-value">{strokeW}px</span>
          </div>

          {showPointSize && (
            <div className="popover-row">
              <label className="popover-label">點大小</label>
              <input
                type="range"
                min={2}
                max={15}
                step={0.5}
                value={radius}
                onChange={(e) => onUpdate({ pointRadius: parseFloat(e.target.value) })}
                className="slider"
              />
              <span className="popover-value">{radius}px</span>
            </div>
          )}
        </div>
    </div>
  );
}
