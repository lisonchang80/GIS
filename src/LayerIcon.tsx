import type { VectorLayer } from './types';

interface Props {
  layer: VectorLayer;
  onClick?: () => void;
}

export function LayerIcon({ layer, onClick }: Props) {
  const color = layer.color;
  const stroke = layer.strokeColor ?? layer.color;
  const strokeW = Math.min(layer.strokeWidth ?? 2, 3);
  const radius = Math.min(layer.pointRadius ?? 5, 8);
  const opacity = layer.opacity;

  const size = 24;
  const center = size / 2;

  let content: React.ReactNode;
  if (layer.kind === 'point') {
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
