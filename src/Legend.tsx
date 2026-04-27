import type { VectorLayer } from './types';
import { decimalsOf, getLegendModel, resolveSubstanceStyle } from './contour';

interface Props {
  layers: VectorLayer[];
}

export function Legend({ layers }: Props) {
  const cards: { layer: VectorLayer; sourceLayer: VectorLayer }[] = [];
  for (const layer of layers) {
    const wl = layer.waterLevel;
    if (!wl) continue;
    if (!layer.visible) continue;
    if (wl.sourceKind !== 'gw-conc') continue;
    if (!wl.substances || wl.substances.length === 0) continue;
    if (wl.legend?.visible === false) continue;
    const sourceLayer = layers.find((l) => l.id === wl.sourceLayerId);
    if (!sourceLayer) continue;
    cards.push({ layer, sourceLayer });
  }
  if (cards.length === 0) return null;
  return (
    <div className="legend-overlay">
      {cards.map(({ layer, sourceLayer }) => (
        <LegendCard key={layer.id} layer={layer} sourceLayer={sourceLayer} />
      ))}
    </div>
  );
}

function LegendCard({ layer, sourceLayer }: { layer: VectorLayer; sourceLayer: VectorLayer }) {
  const wl = layer.waterLevel!;
  const activeId = wl.activeSubstance ?? wl.substances?.[0]?.id;
  const tab = sourceLayer.gwConcTabs?.find((t) => t.id === wl.sourceTabId);
  const sub = tab?.substances.find((s) => s.id === activeId);
  if (!sub) return null;

  const resolved = resolveSubstanceStyle(wl.substanceStyles?.[sub.id], sub, wl.arrows);
  const stroke = layer.strokeColor ?? layer.color;
  const precision =
    typeof sub.monitorConc === 'number' ? decimalsOf(sub.monitorConc) : undefined;
  const model = getLegendModel(sub, resolved.fill, resolved.lines, stroke, precision);
  const unit = sub.unit ? ` (${sub.unit})` : '';

  return (
    <div className="legend-card">
      <div className="legend-card-head">
        <span className="legend-card-title">{sub.name}</span>
        <span className="legend-card-unit">{unit}</span>
      </div>

      {model.bands.length > 0 && (
        <div className="legend-bands">
          {model.bands.map((b, i) => (
            <div key={i} className="legend-band-row">
              <span className="legend-swatch" style={{ background: b.color }} />
              <span className="legend-band-label">{b.label}</span>
            </div>
          ))}
        </div>
      )}

      {model.thresholds.length > 0 && (
        <div className="legend-thresholds">
          {model.thresholds.map((t, i) => (
            <div key={i} className="legend-threshold-row">
              <svg width={28} height={10} className="legend-threshold-line">
                <line x1={2} y1={5} x2={26} y2={5} stroke={t.color} strokeWidth={2} />
              </svg>
              <span className="legend-threshold-label">{t.label}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
