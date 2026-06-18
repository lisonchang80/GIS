import { useEffect, useRef } from 'react';
import type { PointShape } from './types';
import { drawShape } from './pointShapes';

interface Props {
  shape: PointShape;
  color?: string;
  size?: number;
}

// 小型 canvas 預覽，重用地圖端的同一套 drawShape 幾何
export function ShapeSwatch({ shape, color = '#e5e7eb', size = 20 }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cnv = ref.current;
    if (!cnv) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    cnv.width = size * dpr;
    cnv.height = size * dpr;
    const ctx = cnv.getContext('2d');
    if (!ctx) return;
    drawShape(ctx, shape, size * dpr, color);
  }, [shape, color, size]);
  return <canvas ref={ref} style={{ width: size, height: size, display: 'block' }} />;
}
