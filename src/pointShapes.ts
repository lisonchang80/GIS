import type { Map as MLMap } from 'maplibre-gl';
import type { PointShape } from './types';

export const POINT_SHAPES: PointShape[] = [
  'circle', 'square', 'triangle', 'triangle-down', 'diamond',
  'pentagon', 'hexagon', 'octagon', 'star5', 'star6',
  'triangle-left', 'triangle-right', 'cross', 'x', 'wye',
  'ring', 'square-hollow', 'triangle-hollow', 'diamond-hollow', 'target',
];

export const SHAPE_LABELS: Record<PointShape, string> = {
  circle: '圓', square: '方', triangle: '三角', 'triangle-down': '倒三角', diamond: '菱形',
  pentagon: '五邊形', hexagon: '六邊形', octagon: '八邊形', star5: '五角星', star6: '六角星',
  'triangle-left': '左三角', 'triangle-right': '右三角', cross: '十字', x: '叉', wye: 'Y 形',
  ring: '空心圓', 'square-hollow': '空心方', 'triangle-hollow': '空心三角', 'diamond-hollow': '空心菱', target: '靶心',
};

export const SHAPE_IMG_SIZE = 64;
// 形狀直徑 / 畫布尺寸（pad = size*0.18 → r = size*0.32 → 直徑 = size*0.64）
export const SHAPE_DRAW_RATIO = 0.64;

function regularPolygon(cx: number, cy: number, r: number, n: number, rot: number): [number, number][] {
  const pts: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const a = rot + (i * 2 * Math.PI) / n;
    pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return pts;
}

function star(cx: number, cy: number, rOuter: number, rInner: number, n: number, rot: number): [number, number][] {
  const pts: [number, number][] = [];
  for (let i = 0; i < n * 2; i++) {
    const r = i % 2 === 0 ? rOuter : rInner;
    const a = rot + (i * Math.PI) / n;
    pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return pts;
}

function plusPoly(c: number, r: number, t: number): [number, number][] {
  return [
    [c - t, c - r], [c + t, c - r], [c + t, c - t], [c + r, c - t],
    [c + r, c + t], [c + t, c + t], [c + t, c + r], [c - t, c + r],
    [c - t, c + t], [c - r, c + t], [c - r, c - t], [c - t, c - t],
  ];
}

// 在 [0,size] 畫布上畫置中形狀。非 SDF：填色 + 描邊直接畫進點陣，銳利保留尖角。
export function drawShape(
  ctx: CanvasRenderingContext2D,
  shape: PointShape,
  size: number,
  fill = '#ffffff',
  stroke?: string,
  strokeW = 0,
) {
  const c = size / 2;
  const pad = size * 0.18;
  const r = c - pad;
  const up = -Math.PI / 2;
  const lw = size * 0.16;
  const hasStroke = !!stroke && strokeW > 0;
  ctx.clearRect(0, 0, size, size);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  const poly = (pts: [number, number][]) => {
    ctx.beginPath();
    pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath();
  };
  // 實心形狀：填 fill，外圈描 stroke
  const doFill = (build: () => void) => {
    build();
    ctx.fillStyle = fill;
    ctx.fill();
    if (hasStroke) {
      ctx.lineWidth = strokeW;
      ctx.strokeStyle = stroke!;
      ctx.stroke();
    }
  };
  // 線型/空心形狀：先描較寬的 stroke 當外緣，再描 fill 當主體
  const doStroke = (build: () => void, width: number) => {
    if (hasStroke) {
      build();
      ctx.lineWidth = width + strokeW * 2;
      ctx.strokeStyle = stroke!;
      ctx.stroke();
    }
    build();
    ctx.lineWidth = width;
    ctx.strokeStyle = fill;
    ctx.stroke();
  };

  switch (shape) {
    case 'circle': doFill(() => { ctx.beginPath(); ctx.arc(c, c, r, 0, Math.PI * 2); }); break;
    case 'square': doFill(() => { ctx.beginPath(); ctx.rect(c - r * 0.9, c - r * 0.9, r * 1.8, r * 1.8); }); break;
    case 'triangle': doFill(() => poly(regularPolygon(c, c, r, 3, up))); break;
    case 'triangle-down': doFill(() => poly(regularPolygon(c, c, r, 3, Math.PI / 2))); break;
    case 'triangle-left': doFill(() => poly(regularPolygon(c, c, r, 3, Math.PI))); break;
    case 'triangle-right': doFill(() => poly(regularPolygon(c, c, r, 3, 0))); break;
    case 'diamond': doFill(() => poly(regularPolygon(c, c, r, 4, up))); break;
    case 'pentagon': doFill(() => poly(regularPolygon(c, c, r, 5, up))); break;
    case 'hexagon': doFill(() => poly(regularPolygon(c, c, r, 6, 0))); break;
    case 'octagon': doFill(() => poly(regularPolygon(c, c, r, 8, Math.PI / 8))); break;
    case 'star5': doFill(() => poly(star(c, c, r, r * 0.45, 5, up))); break;
    case 'star6': doFill(() => poly(star(c, c, r, r * 0.5, 6, up))); break;
    case 'cross': doFill(() => poly(plusPoly(c, r, r * 0.4))); break;
    case 'x':
      doStroke(() => {
        const d = r * 0.72;
        ctx.beginPath();
        ctx.moveTo(c - d, c - d); ctx.lineTo(c + d, c + d);
        ctx.moveTo(c + d, c - d); ctx.lineTo(c - d, c + d);
      }, lw * 1.3);
      break;
    case 'wye':
      doStroke(() => {
        ctx.beginPath();
        for (let i = 0; i < 3; i++) {
          const a = up + (i * 2 * Math.PI) / 3;
          ctx.moveTo(c, c);
          ctx.lineTo(c + r * Math.cos(a), c + r * Math.sin(a));
        }
      }, lw * 1.3);
      break;
    case 'ring': doStroke(() => { ctx.beginPath(); ctx.arc(c, c, r - lw / 2, 0, Math.PI * 2); }, lw); break;
    case 'square-hollow': doStroke(() => { ctx.beginPath(); ctx.rect(c - r * 0.82, c - r * 0.82, r * 1.64, r * 1.64); }, lw); break;
    case 'triangle-hollow': doStroke(() => poly(regularPolygon(c, c, r - lw / 2, 3, up)), lw); break;
    case 'diamond-hollow': doStroke(() => poly(regularPolygon(c, c, r - lw / 2, 4, up)), lw); break;
    case 'target':
      doStroke(() => { ctx.beginPath(); ctx.arc(c, c, r - lw / 2, 0, Math.PI * 2); }, lw * 0.8);
      doFill(() => { ctx.beginPath(); ctx.arc(c, c, r * 0.34, 0, Math.PI * 2); });
      break;
    default: doFill(() => { ctx.beginPath(); ctx.arc(c, c, r, 0, Math.PI * 2); });
  }
}

export function pointIconId(shape: PointShape, fill: string, stroke: string): string {
  return `pt|${shape}|${fill}|${stroke}`;
}

// 確保（形狀 × 填色 × 描邊）的非 SDF 點陣圖示已註冊，回傳圖示 id
export function ensurePointIcon(
  map: MLMap,
  shape: PointShape,
  fill: string,
  stroke = '#ffffff',
  strokeW = SHAPE_IMG_SIZE * 0.06,
): string {
  const id = pointIconId(shape, fill, stroke);
  if (map.hasImage(id)) return id;
  const cnv = document.createElement('canvas');
  cnv.width = SHAPE_IMG_SIZE;
  cnv.height = SHAPE_IMG_SIZE;
  const ctx = cnv.getContext('2d');
  if (!ctx) return id;
  drawShape(ctx, shape, SHAPE_IMG_SIZE, fill, stroke, strokeW);
  const img = ctx.getImageData(0, 0, SHAPE_IMG_SIZE, SHAPE_IMG_SIZE);
  try {
    map.addImage(id, { width: SHAPE_IMG_SIZE, height: SHAPE_IMG_SIZE, data: new Uint8Array(img.data.buffer) }, { pixelRatio: 1 });
  } catch { /* noop */ }
  return id;
}

// 給生成的批次圖層分配不同形狀（依序輪詢，circle 在前）
export function shapeForIndex(i: number): PointShape {
  return POINT_SHAPES[i % POINT_SHAPES.length];
}
