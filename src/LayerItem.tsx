import { useState } from 'react';
import type { PointShape, VectorLayer } from './types';
import { LayerIcon } from './LayerIcon';
import { ShapePicker } from './ShapePicker';

interface Props {
  layer: VectorLayer;
  allLayers: VectorLayer[];
  index: number;
  total: number;
  dragOver: 'above' | 'below' | null;
  onToggle: () => void;
  onOpacity: (value: number) => void;
  onUpdate: (patch: Partial<VectorLayer>) => void;
  onRename: (name: string) => void;
  onRemove: () => void;
  onZoom: () => void;
  onShowAttributes: () => void;
  onToggleStyle: () => void;
  attributesActive: boolean;
  styleActive: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
  onDragOverRow: (position: 'above' | 'below') => void;
  onDragLeaveRow: () => void;
  onDropRow: () => void;
}

export function LayerItem(p: Props) {
  const [editingName, setEditingName] = useState(false);
  const [draftName, setDraftName] = useState(p.layer.name);
  const [waterLevelExpanded, setWaterLevelExpanded] = useState(false);

  const wl = p.layer.waterLevel;
  const ex = p.layer.exceedance;
  const isWaterLevel = !!wl;
  const isExceedance = !!ex;
  const isExpandable = isWaterLevel || isExceedance;
  const isWaterLevelMulti = !!wl && wl.dates.length > 1;
  const wlActiveIdx = wl ? Math.max(0, wl.dates.indexOf(wl.activeDate)) : 0;

  const isMultiSub = !!wl?.substances && wl.substances.length > 0;

  const isExMultiSub = !!ex?.substances && ex.substances.length > 0;
  const setExSub = (subId: string) => ex && p.onUpdate({ exceedance: { ...ex, activeSubstance: subId } });
  const toggleBatch = (name: string, visible: boolean) =>
    ex && p.onUpdate({ exceedance: { ...ex, batches: ex.batches.map((b) => (b.name === name ? { ...b, visible } : b)) } });
  const setBatchShape = (name: string, shape: PointShape) =>
    ex && p.onUpdate({ exceedance: { ...ex, batches: ex.batches.map((b) => (b.name === name ? { ...b, shape } : b)) } });

  const subStatus: Record<string, 'alert' | 'warn' | null> = {};
  if (isMultiSub && wl && wl.sourceKind === 'gw-conc' && wl.sourceLayerId && wl.sourceTabId) {
    const srcLayer = p.allLayers.find((l) => l.id === wl.sourceLayerId);
    const srcTab = srcLayer?.gwConcTabs?.find((t) => t.id === wl.sourceTabId);
    if (srcLayer && srcTab) {
      const activeDate = wl.activeDate;
      for (const s of wl.substances ?? []) {
        const subDef = srcTab.substances.find((x) => x.id === s.id);
        const C = subDef?.controlConc;
        const M = subDef?.monitorConc;
        let alert = false;
        let warn = false;
        for (const f of srcLayer.data.features) {
          const props = (f.properties ?? {}) as Record<string, unknown>;
          const gw = props['__gwConc'] as
            | Record<string, Record<string, Record<string, unknown>>>
            | undefined;
          const v = gw?.[wl.sourceTabId!]?.[s.id]?.[activeDate];
          if (typeof v !== 'number') continue;
          if (typeof C === 'number' && v >= C) {
            alert = true;
            break;
          }
          if (typeof M === 'number' && v >= M) warn = true;
        }
        subStatus[s.id] = alert ? 'alert' : warn ? 'warn' : null;
      }
    }
  }

  const setModel = (model: 'idw' | 'tin' | 'kriging' | 'indicator') => {
    if (!wl) return;
    p.onUpdate({ waterLevel: { ...wl, model } });
  };

  const setActiveSubstance = (subId: string) => {
    if (!wl) return;
    p.onUpdate({ waterLevel: { ...wl, activeSubstance: subId } });
  };

  const setActiveDate = (date: string) => {
    if (!wl) return;
    p.onUpdate({
      waterLevel: { ...wl, activeDate: date },
      name: isMultiSub ? p.layer.name : date,
    });
  };

  const stepDate = (delta: number) => {
    if (!wl) return;
    const next = Math.max(0, Math.min(wl.dates.length - 1, wlActiveIdx + delta));
    if (next !== wlActiveIdx) setActiveDate(wl.dates[next]);
  };

  const commitName = () => {
    const trimmed = draftName.trim();
    if (trimmed && trimmed !== p.layer.name) p.onRename(trimmed);
    else setDraftName(p.layer.name);
    setEditingName(false);
  };

  const onDragStart = (e: React.DragEvent<HTMLLIElement>) => {
    const target = e.target as HTMLElement;
    if (target.closest('input, button, textarea, select, .layer-name, .layer-icon')) {
      e.preventDefault();
      return;
    }
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', p.layer.id);
    p.onDragStart();
  };

  const onDragOver = (e: React.DragEvent<HTMLLIElement>) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const position = e.clientY < rect.top + rect.height / 2 ? 'above' : 'below';
    p.onDragOverRow(position);
  };

  return (
    <li
      className={[
        'layer-item',
        p.layer.visible ? '' : 'muted',
        p.dragOver === 'above' ? 'drop-above' : '',
        p.dragOver === 'below' ? 'drop-below' : '',
      ].filter(Boolean).join(' ')}
      draggable
      onDragStart={onDragStart}
      onDragEnd={p.onDragEnd}
      onDragOver={onDragOver}
      onDragLeave={p.onDragLeaveRow}
      onDrop={(e) => {
        e.preventDefault();
        p.onDropRow();
      }}
    >
      <div className="layer-row">
        <span className="drag-handle" title="拖曳以調整順序">⋮⋮</span>
        <input type="checkbox" checked={p.layer.visible} onChange={p.onToggle} />
        <div className={`layer-icon-wrap ${p.styleActive ? 'active' : ''}`} title="點擊以編輯樣式">
          <LayerIcon layer={p.layer} onClick={p.onToggleStyle} />
        </div>
        {editingName ? (
          <input
            autoFocus
            className="name-input"
            value={draftName}
            onChange={(e) => setDraftName(e.target.value)}
            onBlur={commitName}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitName();
              if (e.key === 'Escape') {
                setDraftName(p.layer.name);
                setEditingName(false);
              }
            }}
          />
        ) : (
          <span
            className="layer-name editable"
            title="點擊以重新命名"
            onClick={() => {
              setDraftName(p.layer.name);
              setEditingName(true);
            }}
          >
            {p.layer.name}
          </span>
        )}
        {isExpandable ? (
          <button
            className={`icon-btn ${waterLevelExpanded ? 'active' : ''}`}
            title={isExceedance ? '展開超標圖設定' : isWaterLevelMulti ? '展開日期/模型' : '展開模型'}
            onClick={() => setWaterLevelExpanded((v) => !v)}
          >{waterLevelExpanded ? '▾' : '▸'}</button>
        ) : (
          <button
            className={`icon-btn ${p.attributesActive ? 'active' : ''}`}
            title="開啟 / 關閉屬性表"
            onClick={p.onShowAttributes}
          >▤</button>
        )}
        <button className="icon-btn" title="縮放至圖層" onClick={p.onZoom}>⤢</button>
        <button className="icon-btn danger" title="移除" onClick={p.onRemove}>×</button>
      </div>
      {isWaterLevel && waterLevelExpanded && wl && (
        <>
          {isWaterLevelMulti && (
            <div className="water-level-row">
              <button
                className="btn xs"
                onClick={() => stepDate(-1)}
                disabled={wlActiveIdx <= 0}
                title="上一個日期"
              >◀</button>
              <span className="water-level-date">{wl.activeDate}</span>
              <button
                className="btn xs"
                onClick={() => stepDate(1)}
                disabled={wlActiveIdx >= wl.dates.length - 1}
                title="下一個日期"
              >▶</button>
              <span className="water-level-counter">
                {wlActiveIdx + 1} / {wl.dates.length}
              </span>
            </div>
          )}
          {isMultiSub && (
            <div className="water-level-row water-level-sub-row">
              {wl.substances!.map((s) => {
                const status = subStatus[s.id];
                const cls = [
                  'btn',
                  'xs',
                  'water-level-sub-btn',
                  wl.activeSubstance === s.id ? 'active' : '',
                  status ? status : '',
                ].filter(Boolean).join(' ');
                return (
                  <button
                    key={s.id}
                    type="button"
                    className={cls}
                    onClick={() => setActiveSubstance(s.id)}
                    title={s.name}
                  >
                    {s.name}
                  </button>
                );
              })}
            </div>
          )}
          <div className="water-level-row">
            <label className="water-level-model-label">模型</label>
            <select
              className="select water-level-model-select"
              value={wl.model ?? 'idw'}
              onChange={(e) => setModel(e.target.value as 'idw' | 'tin' | 'kriging' | 'indicator')}
            >
              <option value="idw">IDW</option>
              <option value="tin">TIN</option>
              <option value="kriging">Kriging</option>
              {isMultiSub || wl.sourceKind === 'gw-conc' ? (
                <option value="indicator">Indicator</option>
              ) : null}
            </select>
          </div>
          {wl.sourceKind === 'gw-conc' && (
            <div className="water-level-row water-level-flags-row">
              <label className="water-level-flag">
                <input
                  type="checkbox"
                  checked={!!wl.logTransform}
                  onChange={(e) => p.onUpdate({ waterLevel: { ...wl, logTransform: e.target.checked } })}
                />
                log-transform
              </label>
              <label className="water-level-flag">
                <input
                  type="checkbox"
                  checked={wl.clampNegative ?? true}
                  onChange={(e) => p.onUpdate({ waterLevel: { ...wl, clampNegative: e.target.checked } })}
                />
                負值歸 0
              </label>
            </div>
          )}
          <div className="water-level-row water-level-flags-row water-level-flags-display">
            {isMultiSub && (
              <label className="water-level-flag">
                <input
                  type="checkbox"
                  checked={wl.legend?.visible !== false}
                  onChange={(e) =>
                    p.onUpdate({
                      waterLevel: { ...wl, legend: { ...(wl.legend ?? {}), visible: e.target.checked } },
                    })
                  }
                />
                圖例
              </label>
            )}
            <label className="water-level-flag">
              <input
                type="checkbox"
                checked={wl.dateLabel?.visible !== false}
                onChange={(e) =>
                  p.onUpdate({
                    waterLevel: { ...wl, dateLabel: { ...(wl.dateLabel ?? {}), visible: e.target.checked } },
                  })
                }
              />
              日期
            </label>
          </div>
        </>
      )}
      {isExceedance && waterLevelExpanded && ex && (
        <>
          {isExMultiSub && (
            <div className="water-level-row water-level-sub-row">
              {ex.substances!.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  className={['btn', 'xs', 'water-level-sub-btn', ex.activeSubstance === s.id ? 'active' : ''].filter(Boolean).join(' ')}
                  onClick={() => setExSub(s.id)}
                  title={s.name}
                >
                  {s.name}
                </button>
              ))}
            </div>
          )}
          {ex.batches.length > 0 && (
            <div className="exceedance-batches">
              <div className="exceedance-batches-title">批次（勾選顯示・可改形狀）</div>
              {ex.batches.map((b) => (
                <div key={b.name} className="exceedance-batch-row">
                  <label className="exceedance-batch-check" title={b.name}>
                    <input
                      type="checkbox"
                      checked={b.visible !== false}
                      onChange={(e) => toggleBatch(b.name, e.target.checked)}
                    />
                    <span className="exceedance-batch-name">{b.name || '（未命名）'}</span>
                  </label>
                  <ShapePicker value={b.shape} color="#e5e7eb" onChange={(s) => setBatchShape(b.name, s)} />
                </div>
              ))}
            </div>
          )}
          <div className="water-level-row water-level-flags-row water-level-flags-display">
            <label className="water-level-flag">
              <input
                type="checkbox"
                checked={ex.showOk !== false}
                onChange={(e) => p.onUpdate({ exceedance: { ...ex, showOk: e.target.checked } })}
              />
              合格點
            </label>
            <label className="water-level-flag">
              <input
                type="checkbox"
                checked={ex.showNodata === true}
                onChange={(e) => p.onUpdate({ exceedance: { ...ex, showNodata: e.target.checked } })}
              />
              無資料點
            </label>
            <label className="water-level-flag">
              <input
                type="checkbox"
                checked={ex.legend?.visible !== false}
                onChange={(e) => p.onUpdate({ exceedance: { ...ex, legend: { ...(ex.legend ?? {}), visible: e.target.checked } } })}
              />
              圖例
            </label>
          </div>
        </>
      )}
    </li>
  );
}
