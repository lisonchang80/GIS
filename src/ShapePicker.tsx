import { useEffect, useRef, useState } from 'react';
import type { PointShape } from './types';
import { POINT_SHAPES, SHAPE_LABELS } from './pointShapes';
import { ShapeSwatch } from './ShapeSwatch';

interface Props {
  value: PointShape;
  color?: string;
  onChange: (shape: PointShape) => void;
  size?: number;
}

// 圖形化的形狀下拉：按鈕顯示目前形狀 swatch，展開為形狀格網
export function ShapePicker({ value, color = '#e5e7eb', onChange, size = 16 }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  return (
    <div className="shape-picker" ref={ref}>
      <button
        type="button"
        className="shape-picker-btn"
        title={SHAPE_LABELS[value]}
        onClick={() => setOpen((o) => !o)}
      >
        <ShapeSwatch shape={value} color={color} size={size} />
        <span className="shape-picker-caret">▾</span>
      </button>
      {open && (
        <div className="shape-picker-menu">
          {POINT_SHAPES.map((s) => (
            <button
              key={s}
              type="button"
              className={`shape-cell${s === value ? ' active' : ''}`}
              title={SHAPE_LABELS[s]}
              onClick={() => { onChange(s); setOpen(false); }}
            >
              <ShapeSwatch shape={s} color={color} size={size} />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
