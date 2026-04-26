import { useEffect, useRef, useState } from 'react';
import type {
  GwConcSubstance,
  SubstanceStyle,
  VectorLayer,
  WaterLevelArrows,
  WaterLevelCustomBand,
  WaterLevelDashStyle,
  WaterLevelDateLabel,
  WaterLevelFill,
  WaterLevelFillMode,
  WaterLevelHeightLabel,
  WaterLevelLines,
} from './types';
import { makeGwConcDefaultsForSub } from './contour';

const DASH_PRESETS: { value: WaterLevelDashStyle; svgDash?: string }[] = [
  { value: 'solid' },
  { value: 'dash', svgDash: '6 3' },
  { value: 'dot', svgDash: '1 3' },
  { value: 'dashdot', svgDash: '6 3 1 3' },
];

function DashLinePreview({ dash, color, width }: { dash?: string; color: string; width: number }) {
  return (
    <svg width={70} height={10} style={{ display: 'block' }}>
      <line
        x1={2}
        y1={5}
        x2={68}
        y2={5}
        stroke={color}
        strokeWidth={width}
        strokeDasharray={dash}
        strokeLinecap="butt"
      />
    </svg>
  );
}

function DashSelect({
  value,
  onChange,
  color,
  width,
  disabled,
}: {
  value: WaterLevelDashStyle;
  onChange: (v: WaterLevelDashStyle) => void;
  color: string;
  width: number;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);
  const current = DASH_PRESETS.find((d) => d.value === value) ?? DASH_PRESETS[0];

  return (
    <div className="dash-select" ref={ref}>
      <button
        type="button"
        className="dash-select-trigger"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
      >
        <DashLinePreview dash={current.svgDash} color={color} width={width} />
        <span className="caret">▾</span>
      </button>
      {open && (
        <div className="dash-select-panel">
          {DASH_PRESETS.map((d) => (
            <button
              key={d.value}
              type="button"
              className={`dash-select-option${d.value === value ? ' is-active' : ''}`}
              onClick={() => {
                onChange(d.value);
                setOpen(false);
              }}
            >
              <DashLinePreview dash={d.svgDash} color={color} width={width} />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const DEFAULT_LINES_UI: Required<WaterLevelLines> = {
  majorInterval: 0.5,
  minorEnabled: false,
  minorDivisions: 4,
  outlineEnabled: false,
  dashStyle: 'solid',
  minorDashStyle: 'solid',
  minorColor: '#9aa3b1',
  minorWidthRatio: 0.5,
};

const DEFAULT_ARROWS_UI: Required<WaterLevelArrows> = {
  enabled: true,
  divisions: 8,
  color: '#1d4ed8',
  width: 1.5,
};

const DEFAULT_HEIGHT_LABEL_UI: Required<WaterLevelHeightLabel> = {
  visible: true,
  color: '#ffffff',
  haloColor: '#000000',
  size: 12,
};

interface Props {
  layer: VectorLayer;
  sourceLayer?: VectorLayer;
  onClose: () => void;
  onUpdate: (patch: Partial<VectorLayer>) => void;
}

const DEFAULT_GRADIENT = { from: '#cce6ff', to: '#003366' };
const BAND_PALETTE = ['#22c55e', '#facc15', '#f97316', '#ef4444', '#a855f7', '#06b6d4'];

export function StylePopover({ layer, sourceLayer, onClose, onUpdate }: Props) {
  const stroke = layer.strokeColor ?? layer.color;
  const strokeW = layer.strokeWidth ?? 2;
  const radius = layer.pointRadius ?? 5;
  const showPointSize = layer.kind === 'point' || layer.kind === 'mixed';
  const strokeOn = layer.strokeVisible !== false;
  const labelColor = layer.labelColor ?? '#ffffff';
  const labelHaloColor = layer.labelHaloColor ?? '#000000';
  const labelSize = layer.labelSize ?? 12;
  const hasNameField = layer.data.features.some((f) => {
    const v = (f.properties as Record<string, unknown> | null | undefined)?.['名稱'];
    return v !== undefined && v !== null && v !== '';
  });

  const isContour = !!layer.waterLevel;
  const dateLabelCfg: WaterLevelDateLabel = layer.waterLevel?.dateLabel ?? {};
  const heightLabelCfg: Required<WaterLevelHeightLabel> = {
    ...DEFAULT_HEIGHT_LABEL_UI,
    ...(layer.waterLevel?.heightLabel ?? {}),
  };
  const textOn = isContour
    ? !!dateLabelCfg.visible
    : layer.labelVisible !== false;
  const showTextSection = isContour || hasNameField;
  const setTextVisible = (v: boolean) => {
    if (isContour) {
      const wl = layer.waterLevel;
      if (!wl) return;
      onUpdate({
        waterLevel: {
          ...wl,
          dateLabel: { ...(wl.dateLabel ?? {}), visible: v },
        },
      });
    } else {
      onUpdate({ labelVisible: v });
    }
  };
  const updateHeightLabel = (patch: Partial<WaterLevelHeightLabel>) => {
    const wl = layer.waterLevel;
    if (!wl) return;
    onUpdate({
      waterLevel: {
        ...wl,
        heightLabel: { ...heightLabelCfg, ...patch },
      },
    });
  };
  const wl = layer.waterLevel;
  const isMultiSub = !!wl?.substances && wl.substances.length > 0;
  const activeSubId = isMultiSub ? wl?.activeSubstance ?? wl?.substances?.[0]?.id : undefined;
  const activeSubRef = isMultiSub ? wl?.substances?.find((s) => s.id === activeSubId) : undefined;

  let activeSub: GwConcSubstance | undefined;
  if (isMultiSub && activeSubId && sourceLayer) {
    const tab = sourceLayer.gwConcTabs?.find((t) => t.id === wl?.sourceTabId);
    activeSub = tab?.substances.find((s) => s.id === activeSubId);
  }
  const subDefaults = activeSub ? makeGwConcDefaultsForSub(activeSub) : { fill: undefined, lines: undefined };
  const subOverride: SubstanceStyle | undefined =
    isMultiSub && activeSubId ? wl?.substanceStyles?.[activeSubId] : undefined;
  const hasSubOverride =
    !!subOverride && (subOverride.fill !== undefined || subOverride.lines !== undefined || subOverride.arrows !== undefined);

  const effectiveFill: WaterLevelFill = isMultiSub
    ? (subOverride?.fill ?? subDefaults.fill ?? { mode: 'none' })
    : (wl?.fill ?? { mode: 'none' });
  const effectiveLines: WaterLevelLines | undefined = isMultiSub
    ? (subOverride?.lines ?? subDefaults.lines)
    : wl?.lines;
  const effectiveArrows: WaterLevelArrows | undefined = isMultiSub
    ? (subOverride?.arrows ?? wl?.arrows)
    : wl?.arrows;

  const fill: WaterLevelFill = effectiveFill;
  const fillMode: WaterLevelFillMode = fill.mode;
  const gradient = fill.gradient ?? DEFAULT_GRADIENT;
  const bands = fill.bands ?? [];
  const fillOpacity = fill.opacity ?? 0.6;

  const linesCfg: Required<WaterLevelLines> = {
    ...DEFAULT_LINES_UI,
    ...(effectiveLines ?? {}),
  };

  const arrowsCfg: Required<WaterLevelArrows> = {
    ...DEFAULT_ARROWS_UI,
    ...(effectiveArrows ?? {}),
  };

  const [majorIntervalDraft, setMajorIntervalDraft] = useState<string>(String(linesCfg.majorInterval));
  useEffect(() => {
    setMajorIntervalDraft(String(linesCfg.majorInterval));
  }, [linesCfg.majorInterval]);

  const previewWidth = Math.max(strokeW, 1.5);
  const minorPreviewWidth = Math.max(strokeW * linesCfg.minorWidthRatio, 1);

  const commitMajorInterval = () => {
    const v = parseFloat(majorIntervalDraft);
    if (Number.isFinite(v) && v > 0 && v !== linesCfg.majorInterval) {
      updateLines({ majorInterval: v });
    } else {
      setMajorIntervalDraft(String(linesCfg.majorInterval));
    }
  };

  const writeSubstanceStyle = (next: SubstanceStyle) => {
    if (!wl || !activeSubId) return;
    const merged = { ...(wl.substanceStyles ?? {}), [activeSubId]: next };
    onUpdate({ waterLevel: { ...wl, substanceStyles: merged } });
  };

  const updateLines = (patch: Partial<WaterLevelLines>) => {
    if (!wl) return;
    if (isMultiSub) {
      writeSubstanceStyle({ ...subOverride, lines: { ...linesCfg, ...patch } });
      return;
    }
    onUpdate({ waterLevel: { ...wl, lines: { ...linesCfg, ...patch } } });
  };

  const updateArrows = (patch: Partial<WaterLevelArrows>) => {
    if (!wl) return;
    if (isMultiSub) {
      writeSubstanceStyle({ ...subOverride, arrows: { ...arrowsCfg, ...patch } });
      return;
    }
    onUpdate({ waterLevel: { ...wl, arrows: { ...arrowsCfg, ...patch } } });
  };

  const updateFill = (patch: Partial<WaterLevelFill>) => {
    if (!wl) return;
    if (isMultiSub) {
      writeSubstanceStyle({ ...subOverride, fill: { ...fill, ...patch } });
      return;
    }
    onUpdate({ waterLevel: { ...wl, fill: { ...fill, ...patch } } });
  };

  const resetSubstanceStyle = () => {
    if (!wl || !activeSubId) return;
    const next = { ...(wl.substanceStyles ?? {}) };
    delete next[activeSubId];
    onUpdate({ waterLevel: { ...wl, substanceStyles: next } });
  };

  const addBand = () => {
    const last = bands[bands.length - 1];
    const from = last ? last.to : 0;
    const to = from + 1;
    const color = BAND_PALETTE[bands.length % BAND_PALETTE.length];
    updateFill({ bands: [...bands, { from, to, color }] });
  };

  const updateBand = (idx: number, patch: Partial<WaterLevelCustomBand>) => {
    updateFill({
      bands: bands.map((b, i) => (i === idx ? { ...b, ...patch } : b)),
    });
  };

  const removeBand = (idx: number) => {
    updateFill({ bands: bands.filter((_, i) => i !== idx) });
  };

  return (
    <div className="style-popover">
        <div className="popover-header">
          <span className="popover-title">樣式 · {layer.name}</span>
          <button className="icon-btn" onClick={onClose}>×</button>
        </div>

        <div className="popover-body">
          {!isContour && (
            <div className="popover-row">
              <label className="popover-label">填色</label>
              <input
                type="color"
                value={layer.color}
                onChange={(e) => onUpdate({ color: e.target.value })}
                className="color-swatch wide"
              />
            </div>
          )}

          {!isContour && (
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
          )}

          {!isContour && (
            <>
              <div className="popover-row">
                <label className="popover-label">
                  <input
                    type="checkbox"
                    checked={strokeOn}
                    onChange={(e) => onUpdate({ strokeVisible: e.target.checked })}
                    style={{ marginRight: 6 }}
                  />
                  描邊
                </label>
                <input
                  type="color"
                  value={stroke}
                  onChange={(e) => onUpdate({ strokeColor: e.target.value })}
                  className="color-swatch wide"
                  disabled={!strokeOn}
                />
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
                  disabled={!strokeOn}
                />
                <span className="popover-value">{strokeW}px</span>
              </div>
            </>
          )}

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

          {showTextSection && (
            <div className="popover-section">
              <div className="popover-section-title">文字</div>

              <div className="popover-row">
                <label className="popover-label">
                  <input
                    type="checkbox"
                    checked={textOn}
                    onChange={(e) => setTextVisible(e.target.checked)}
                    style={{ marginRight: 6 }}
                  />
                  {isContour ? '日期' : '顯示'}
                </label>
                <input
                  type="color"
                  value={labelColor}
                  onChange={(e) => onUpdate({ labelColor: e.target.value })}
                  className="color-swatch wide"
                  disabled={!textOn}
                />
              </div>

              <div className="popover-row">
                <label className="popover-label">外框</label>
                <input
                  type="color"
                  value={labelHaloColor}
                  onChange={(e) => onUpdate({ labelHaloColor: e.target.value })}
                  className="color-swatch wide"
                  disabled={!textOn}
                />
              </div>

              <div className="popover-row">
                <label className="popover-label">字級</label>
                <input
                  type="range"
                  min={8}
                  max={48}
                  step={1}
                  value={labelSize}
                  onChange={(e) => onUpdate({ labelSize: parseFloat(e.target.value) })}
                  className="slider"
                  disabled={!textOn}
                />
                <span className="popover-value">{labelSize}px</span>
              </div>

              {isContour && textOn && (
                <p className="hint" style={{ margin: '-2px 0 0' }}>
                  地圖上拖曳「日期」可調整位置
                </p>
              )}
            </div>
          )}

          {!isContour && !hasNameField && (
            <p className="hint" style={{ margin: '-4px 0 4px' }}>
              此圖層尚無「名稱」屬性，可至屬性表填入後即會顯示文字。
            </p>
          )}

          {isMultiSub && activeSubRef && (
            <div className="popover-section">
              <div className="popover-row" style={{ alignItems: 'center' }}>
                <label className="popover-label">當前物質</label>
                <span style={{ fontWeight: 600 }}>{activeSubRef.name}</span>
                <button
                  className="btn xs"
                  type="button"
                  disabled={!hasSubOverride}
                  onClick={resetSubstanceStyle}
                  title={hasSubOverride ? '清除此物質的自訂樣式' : '此物質尚未自訂樣式'}
                >
                  重設預設
                </button>
              </div>
              <p className="hint" style={{ margin: '-2px 0 0' }}>
                以下樣式僅套用於目前物質；切換物質可分別設定。
              </p>
            </div>
          )}

          {isContour && (
            <div className="popover-section">
              <div className="popover-section-title">等高線圖高度標示</div>

              <div className="popover-row">
                <label className="popover-label">
                  <input
                    type="checkbox"
                    checked={heightLabelCfg.visible}
                    onChange={(e) => updateHeightLabel({ visible: e.target.checked })}
                    style={{ marginRight: 6 }}
                  />
                  顯示
                </label>
                <input
                  type="color"
                  value={heightLabelCfg.color}
                  onChange={(e) => updateHeightLabel({ color: e.target.value })}
                  className="color-swatch wide"
                  disabled={!heightLabelCfg.visible}
                />
              </div>

              <div className="popover-row">
                <label className="popover-label">外框</label>
                <input
                  type="color"
                  value={heightLabelCfg.haloColor}
                  onChange={(e) => updateHeightLabel({ haloColor: e.target.value })}
                  className="color-swatch wide"
                  disabled={!heightLabelCfg.visible}
                />
              </div>

              <div className="popover-row">
                <label className="popover-label">字級</label>
                <input
                  type="range"
                  min={8}
                  max={32}
                  step={1}
                  value={heightLabelCfg.size}
                  onChange={(e) => updateHeightLabel({ size: parseFloat(e.target.value) })}
                  className="slider"
                  disabled={!heightLabelCfg.visible}
                />
                <span className="popover-value">{heightLabelCfg.size}px</span>
              </div>
            </div>
          )}

          {isContour && (
            <div className="popover-section">
              <div className="popover-section-title">等高線圖區間線條</div>

              <div className="popover-row">
                <label className="popover-label">
                  <input
                    type="checkbox"
                    checked={strokeOn}
                    onChange={(e) => onUpdate({ strokeVisible: e.target.checked })}
                    style={{ marginRight: 6 }}
                  />
                  顏色
                </label>
                <input
                  type="color"
                  value={stroke}
                  onChange={(e) => onUpdate({ strokeColor: e.target.value })}
                  className="color-swatch wide"
                  disabled={!strokeOn}
                />
              </div>

              <div className="popover-row">
                <label className="popover-label">線條粗細</label>
                <input
                  type="range"
                  min={0.5}
                  max={8}
                  step={0.5}
                  value={strokeW}
                  onChange={(e) => onUpdate({ strokeWidth: parseFloat(e.target.value) })}
                  className="slider"
                  disabled={!strokeOn}
                />
                <span className="popover-value">{strokeW}px</span>
              </div>

              <div className="popover-row">
                <label className="popover-label">線條樣式</label>
                <DashSelect
                  value={linesCfg.dashStyle}
                  onChange={(v) => updateLines({ dashStyle: v })}
                  color={stroke}
                  width={previewWidth}
                  disabled={!strokeOn}
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
                  disabled={!strokeOn}
                />
                <span className="popover-value">{Math.round(layer.opacity * 100)}%</span>
              </div>

              <div className="popover-row">
                <label className="popover-label">主線間距</label>
                <input
                  type="number"
                  className="band-num"
                  step={0.1}
                  min={0.01}
                  value={majorIntervalDraft}
                  onChange={(e) => setMajorIntervalDraft(e.target.value)}
                  onBlur={commitMajorInterval}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur();
                  }}
                  style={{ justifySelf: 'start', width: 80 }}
                />
                <span className="popover-value">m</span>
              </div>

              <div className="popover-row">
                <label className="popover-label">
                  <input
                    type="checkbox"
                    checked={linesCfg.minorEnabled}
                    onChange={(e) => updateLines({ minorEnabled: e.target.checked })}
                    style={{ marginRight: 6 }}
                  />
                  副線
                </label>
                <input
                  type="range"
                  min={2}
                  max={10}
                  step={1}
                  value={linesCfg.minorDivisions}
                  onChange={(e) => updateLines({ minorDivisions: parseInt(e.target.value, 10) })}
                  className="slider"
                  disabled={!linesCfg.minorEnabled}
                />
                <span className="popover-value">{linesCfg.minorDivisions} 等分</span>
              </div>

              <div className="popover-row">
                <label className="popover-label">副線粗細</label>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={linesCfg.minorWidthRatio}
                  onChange={(e) => updateLines({ minorWidthRatio: parseFloat(e.target.value) })}
                  className="slider"
                  disabled={!strokeOn || !linesCfg.minorEnabled}
                />
                <span className="popover-value">{Math.round(linesCfg.minorWidthRatio * 100)}%</span>
              </div>

              <div className="popover-row">
                <label className="popover-label">副線顏色</label>
                <input
                  type="color"
                  value={linesCfg.minorColor}
                  onChange={(e) => updateLines({ minorColor: e.target.value })}
                  className="color-swatch wide"
                  disabled={!strokeOn || !linesCfg.minorEnabled}
                />
              </div>

              <div className="popover-row">
                <label className="popover-label">副線樣式</label>
                <DashSelect
                  value={linesCfg.minorDashStyle}
                  onChange={(v) => updateLines({ minorDashStyle: v })}
                  color={linesCfg.minorColor}
                  width={minorPreviewWidth}
                  disabled={!strokeOn || !linesCfg.minorEnabled}
                />
              </div>

              <div className="popover-row">
                <label className="popover-label">
                  <input
                    type="checkbox"
                    checked={linesCfg.outlineEnabled}
                    onChange={(e) => updateLines({ outlineEnabled: e.target.checked })}
                    style={{ marginRight: 6 }}
                  />
                  外框
                </label>
                <span />
                <span />
              </div>
            </div>
          )}

          {isContour && (
            <div className="popover-section">
              <div className="popover-section-title">等高線圖區間填色</div>

              <div className="popover-row">
                <label className="popover-label">模式</label>
                <select
                  className="popover-select"
                  value={fillMode}
                  onChange={(e) => updateFill({ mode: e.target.value as WaterLevelFillMode })}
                >
                  <option value="none">無</option>
                  <option value="gradient">漸層</option>
                  <option value="custom">自訂範圍</option>
                </select>
              </div>

              {fillMode === 'gradient' && (
                <>
                  <div className="popover-row">
                    <label className="popover-label">起始色</label>
                    <input
                      type="color"
                      value={gradient.from}
                      onChange={(e) => updateFill({ gradient: { ...gradient, from: e.target.value } })}
                      className="color-swatch wide"
                    />
                  </div>
                  <div className="popover-row">
                    <label className="popover-label">結束色</label>
                    <input
                      type="color"
                      value={gradient.to}
                      onChange={(e) => updateFill({ gradient: { ...gradient, to: e.target.value } })}
                      className="color-swatch wide"
                    />
                  </div>
                  <p className="hint" style={{ margin: '-2px 0 0' }}>
                    分段以「主線間距」自動換算，依所有日期 z 範圍對齊
                  </p>
                  <div className="gradient-preview">
                    <div
                      className="gradient-preview-bar"
                      style={{ background: `linear-gradient(to right, ${gradient.from}, ${gradient.to})` }}
                    />
                  </div>
                </>
              )}

              {fillMode === 'custom' && (
                <div className="band-list">
                  {bands.length === 0 && (
                    <p className="hint" style={{ margin: '4px 0' }}>
                      尚未設定範圍，點下方「+ 新增範圍」開始。
                    </p>
                  )}
                  {bands.map((b, i) => (
                    <div key={i} className="band-row">
                      <input
                        type="number"
                        className="band-num"
                        value={b.from}
                        onChange={(e) => updateBand(i, { from: parseFloat(e.target.value) })}
                      />
                      <span className="band-sep">~</span>
                      <input
                        type="number"
                        className="band-num"
                        value={b.to}
                        onChange={(e) => updateBand(i, { to: parseFloat(e.target.value) })}
                      />
                      <input
                        type="color"
                        className="color-swatch"
                        value={b.color}
                        onChange={(e) => updateBand(i, { color: e.target.value })}
                      />
                      <button className="icon-btn" onClick={() => removeBand(i)} title="刪除">×</button>
                    </div>
                  ))}
                  <button className="btn xs" onClick={addBand} style={{ marginTop: 4 }}>
                    + 新增範圍
                  </button>
                </div>
              )}

              {fillMode !== 'none' && (
                <div className="popover-row">
                  <label className="popover-label">填色透明度</label>
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={fillOpacity}
                    onChange={(e) => updateFill({ opacity: parseFloat(e.target.value) })}
                    className="slider"
                  />
                  <span className="popover-value">{Math.round(fillOpacity * 100)}%</span>
                </div>
              )}
            </div>
          )}

          {isContour && (
            <div className="popover-section">
              <div className="popover-section-title">等高線圖向量箭頭</div>

              <div className="popover-row">
                <label className="popover-label">
                  <input
                    type="checkbox"
                    checked={arrowsCfg.enabled}
                    onChange={(e) => updateArrows({ enabled: e.target.checked })}
                    style={{ marginRight: 6 }}
                  />
                  顯示
                </label>
                <span />
                <span />
              </div>

              <div className="popover-row">
                <label className="popover-label">等分</label>
                <input
                  type="range"
                  min={4}
                  max={16}
                  step={1}
                  value={arrowsCfg.divisions}
                  onChange={(e) => updateArrows({ divisions: parseInt(e.target.value, 10) })}
                  className="slider"
                  disabled={!arrowsCfg.enabled}
                />
                <span className="popover-value">{arrowsCfg.divisions} 等分</span>
              </div>

              <div className="popover-row">
                <label className="popover-label">顏色</label>
                <input
                  type="color"
                  value={arrowsCfg.color}
                  onChange={(e) => updateArrows({ color: e.target.value })}
                  className="color-swatch wide"
                  disabled={!arrowsCfg.enabled}
                />
              </div>

              <div className="popover-row">
                <label className="popover-label">粗細</label>
                <input
                  type="range"
                  min={0.5}
                  max={5}
                  step={0.5}
                  value={arrowsCfg.width}
                  onChange={(e) => updateArrows({ width: parseFloat(e.target.value) })}
                  className="slider"
                  disabled={!arrowsCfg.enabled}
                />
                <span className="popover-value">{arrowsCfg.width}px</span>
              </div>
            </div>
          )}
        </div>
    </div>
  );
}
