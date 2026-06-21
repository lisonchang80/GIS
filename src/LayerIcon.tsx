import type { VectorLayer } from './types';
import { ShapeSwatch } from './ShapeSwatch';

interface Props {
  layer: VectorLayer;
  onClick?: () => void;
}

export function LayerIcon({ layer, onClick }: Props) {
  // 一般點圖層：用實際選定的形狀（與地圖一致）
  if (!layer.waterLevel && !layer.exceedance && layer.kind === 'point') {
    return (
      <span
        className="layer-icon shape-icon"
        onClick={onClick}
        role="button"
        style={{ cursor: onClick ? 'pointer' : undefined }}
      >
        <ShapeSwatch shape={layer.pointShape ?? 'circle'} color={layer.color} size={22} />
      </span>
    );
  }

  const color = layer.color;
  const stroke = layer.strokeColor ?? layer.color;
  const strokeW = Math.min(layer.strokeWidth ?? 2, 3);
  const radius = Math.min(layer.pointRadius ?? 5, 8);
  const opacity = layer.opacity;

  const size = 24;
  const center = size / 2;

  let content: React.ReactNode;
  if (layer.waterLevel) {
    const isGwConc = layer.waterLevel.sourceKind === 'gw-conc';
    const isSoilSurvey = layer.waterLevel.sourceKind === 'soil-survey';
    const isMulti = layer.waterLevel.dates.length > 1;
    const isMultiSub = !!layer.waterLevel.substances && layer.waterLevel.substances.length > 0;
    const dropPath = (cx: number, top: number, bot: number) => {
      const h = bot - top;
      const w = h * 0.45;
      return `M ${cx} ${top} C ${cx - w} ${top + h * 0.5}, ${cx - w} ${bot - h * 0.05}, ${cx} ${bot} C ${cx + w} ${bot - h * 0.05}, ${cx + w} ${top + h * 0.5}, ${cx} ${top} Z`;
    };
    if (isSoilSurvey) {
      // 紅黃綠三層水滴：外綠 → 中黃 → 內紅，對應等濃度分級（低→中→高）
      content = (
        <g strokeLinejoin="round" fillOpacity={opacity} strokeOpacity={opacity}>
          <path d={dropPath(center, 2.5, 21.5)} fill="#dcfce7" stroke="#22c55e" strokeWidth={2} />
          <path d={dropPath(center, 8, 20)} fill="#fde68a" stroke="#eab308" strokeWidth={1.4} />
          <path d={dropPath(center, 13, 18.7)} fill="#ef4444" stroke="#dc2626" strokeWidth={1} />
        </g>
      );
    } else if (isGwConc) {
      const innerCount = isMultiSub ? 2 : isMulti ? 1 : 0;
      content = (
        <g
          fill="none"
          stroke="#ef4444"
          strokeWidth={1.7}
          strokeOpacity={opacity}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <line x1={9} y1={3} x2={15} y2={3} />
          <path d="M 10 3 L 10 7.5 A 7.5 7.5 0 1 0 14 7.5 L 14 3" />
          {innerCount >= 1 && <circle cx={12} cy={14.5} r={4.5} />}
          {innerCount >= 2 && <circle cx={12} cy={14.5} r={2.2} />}
        </g>
      );
    } else {
      const drops = isMulti
        ? [
            { top: 3, bot: 21 },
            { top: 12, bot: 18 },
          ]
        : [{ top: 4, bot: 20 }];
      content = (
        <>
          {drops.map((d, i) => (
            <path
              key={i}
              d={dropPath(center, d.top, d.bot)}
              fill="none"
              stroke="#60a5fa"
              strokeWidth={2}
              strokeOpacity={opacity}
              strokeLinejoin="round"
            />
          ))}
        </>
      );
    }
  } else if (layer.exceedance) {
    const cfg = layer.exceedance.colors;
    const dots = [cfg?.alert ?? '#dc2626', cfg?.warn ?? '#f59e0b', cfg?.ok ?? '#16a34a'];
    content = (
      <g fillOpacity={opacity}>
        {dots.map((c, i) => (
          <circle key={i} cx={6 + i * 6} cy={center} r={3} fill={c} />
        ))}
      </g>
    );
  } else if (layer.kind === 'point') {
    content = (
      <circle
        cx={center}
        cy={center}
        r={radius}
        fill={color}
        fillOpacity={opacity}
        stroke={stroke}
        strokeWidth={strokeW}
      />
    );
  } else if (layer.kind === 'line') {
    content = (
      <polyline
        points={`2,${size - 4} ${center - 2},${center + 2} ${center + 2},${center - 2} ${size - 2},4`}
        fill="none"
        stroke={stroke}
        strokeWidth={Math.max(strokeW * 1.5, 2)}
        strokeOpacity={opacity}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    );
  } else if (layer.kind === 'polygon') {
    content = (
      <polygon
        points={`${size - 3},4 ${size - 3},${size - 3} 4,${size - 3} 3,${center}`}
        fill={color}
        fillOpacity={opacity * 0.55}
        stroke={stroke}
        strokeWidth={strokeW}
        strokeLinejoin="round"
      />
    );
  } else {
    content = (
      <>
        <rect
          x={3}
          y={10}
          width={11}
          height={11}
          fill={color}
          fillOpacity={opacity * 0.4}
          stroke={stroke}
          strokeWidth={1}
        />
        <line
          x1={10}
          y1={14}
          x2={20}
          y2={14}
          stroke={stroke}
          strokeWidth={2}
          strokeOpacity={opacity}
        />
        <circle
          cx={17}
          cy={6}
          r={3}
          fill={color}
          fillOpacity={opacity}
          stroke={stroke}
          strokeWidth={1}
        />
      </>
    );
  }

  return (
    <svg
      className="layer-icon"
      width={size}
      height={size}
      onClick={onClick}
      role="button"
      style={{ cursor: onClick ? 'pointer' : undefined }}
    >
      {content}
    </svg>
  );
}
