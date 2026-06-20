import type { GwConcSubstance, VectorLayer } from './types';
import { decimalsOf, getLegendModel, resolveSubstanceStyle } from './contour';
import { EXCEEDANCE_COLORS } from './exceedance';
import { ShapeSwatch } from './ShapeSwatch';

interface Props {
  layers: VectorLayer[];
}

export function Legend({ layers }: Props) {
  const cards: { layer: VectorLayer; sourceLayer: VectorLayer }[] = [];
  const exCards: { layer: VectorLayer; sourceLayer: VectorLayer }[] = [];
  for (const layer of layers) {
    if (!layer.visible) continue;
    const wl = layer.waterLevel;
    if (wl) {
      const isGwConc = wl.sourceKind === 'gw-conc' && !!wl.substances && wl.substances.length > 0;
      const isSoilSurvey = wl.sourceKind === 'soil-survey';
      if (!isGwConc && !isSoilSurvey) continue;
      if (wl.legend?.visible === false) continue;
      const sourceLayer = layers.find((l) => l.id === wl.sourceLayerId);
      if (!sourceLayer) continue;
      cards.push({ layer, sourceLayer });
      continue;
    }
    const ex = layer.exceedance;
    if (ex) {
      if (ex.legend?.visible === false) continue;
      const sourceLayer = layers.find((l) => l.id === ex.sourceLayerId);
      if (!sourceLayer) continue;
      exCards.push({ layer, sourceLayer });
    }
  }
  if (cards.length === 0 && exCards.length === 0) return null;
  return (
    <div className="legend-overlay">
      {cards.map(({ layer, sourceLayer }) => (
        <LegendCard key={layer.id} layer={layer} sourceLayer={sourceLayer} />
      ))}
      {exCards.map(({ layer, sourceLayer }) => (
        <ExceedanceLegendCard key={layer.id} layer={layer} sourceLayer={sourceLayer} />
      ))}
    </div>
  );
}

function ExceedanceLegendCard({ layer, sourceLayer }: { layer: VectorLayer; sourceLayer: VectorLayer }) {
  const ex = layer.exceedance!;
  const tab = sourceLayer.soilConcTabs?.find((t) => t.id === ex.sourceTabId);
  const activeSubId = ex.activeSubstance ?? ex.sourceSubId ?? ex.substances?.[0]?.id;
  const sub: GwConcSubstance | undefined = tab?.substances.find((s) => s.id === activeSubId);
  const title = sub?.name ?? '點位超標';
  const unitStr = sub?.unit?.trim();
  const unit = unitStr ? ` (${unitStr})` : '';
  const c = ex.colors;
  const C = sub?.controlConc;
  const M = sub?.monitorConc;
  const u = unitStr ? ` ${unitStr}` : '';

  // 各等級的顏色 + 門檻措辭
  type Lvl = 'alert' | 'warn' | 'ok';
  const levelDefs: Array<{ key: Lvl; color: string; label: string; show: boolean }> = [
    { key: 'alert', color: c?.alert ?? EXCEEDANCE_COLORS.alert, label: typeof C === 'number' ? `≥ ${C}${u}（超管制標準）` : '超管制標準', show: true },
    { key: 'warn', color: c?.warn ?? EXCEEDANCE_COLORS.warn, label: typeof M === 'number' ? `≥ ${M}${u}（超監測標準）` : '超監測標準', show: true },
    { key: 'ok', color: c?.ok ?? EXCEEDANCE_COLORS.ok, label: typeof M === 'number' ? `< ${M}${u}（低於監測標準）` : '低於監測標準', show: ex.showOk !== false },
  ];

  // 統計每個批次（當前物質）實際存在哪些等級
  const presence = new Map<string, Set<string>>();
  for (const f of layer.data.features) {
    const p = (f.properties ?? {}) as Record<string, unknown>;
    if (activeSubId && p['__substance'] !== activeSubId) continue;
    const b = typeof p['__batch'] === 'string' ? p['__batch'] : '';
    const lvl = p['__exLevel'];
    if (typeof lvl !== 'string') continue;
    if (!presence.has(b)) presence.set(b, new Set());
    presence.get(b)!.add(lvl);
  }

  // 以批次名稱為小標，底下列出該批形狀的紅/黃/綠（僅存在的等級）
  const visibleBatches = ex.batches.filter((b) => b.visible !== false);

  return (
    <div className="legend-card">
      <div className="legend-card-head">
        <span className="legend-card-title">{title}</span>
        <span className="legend-card-unit">{unit}</span>
      </div>
      {visibleBatches.map((b) => {
        const present = presence.get(b.name) ?? new Set<string>();
        const rows = levelDefs.filter((l) => l.show && present.has(l.key));
        return (
          <div key={b.name} className="legend-batch-group">
            <div className="legend-subhead">{b.name || '（未命名）'}</div>
            <div className="legend-bands">
              {rows.map((l) => (
                <div key={l.key} className="legend-band-row">
                  <span className="legend-shape-swatch"><ShapeSwatch shape={b.shape} color={l.color} size={14} /></span>
                  <span className="legend-band-label">{l.label}</span>
                </div>
              ))}
              {rows.length === 0 && (
                <div className="legend-band-row">
                  <span className="legend-band-label legend-empty">（此批無資料）</span>
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function LegendCard({ layer, sourceLayer }: { layer: VectorLayer; sourceLayer: VectorLayer }) {
  const wl = layer.waterLevel!;
  const isSoilSurvey = wl.sourceKind === 'soil-survey';
  const activeId = wl.activeSubstance ?? wl.substances?.[0]?.id ?? wl.sourceSubId;
  const tab = isSoilSurvey
    ? sourceLayer.soilSurveyTabs?.find((t) => t.id === wl.sourceTabId)
    : sourceLayer.gwConcTabs?.find((t) => t.id === wl.sourceTabId);
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
