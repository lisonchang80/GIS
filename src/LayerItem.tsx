import { useState } from 'react';
import type { VectorLayer } from './types';
import { LayerIcon } from './LayerIcon';

interface Props {
  layer: VectorLayer;
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
  const isWaterLevel = !!wl;
  const isWaterLevelMulti = !!wl && wl.dates.length > 1;
  const wlActiveIdx = wl ? Math.max(0, wl.dates.indexOf(wl.activeDate)) : 0;

  const isMultiSub = !!wl?.substances && wl.substances.length > 0;

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
        {isWaterLevel ? (
          <button
            className={`icon-btn ${waterLevelExpanded ? 'active' : ''}`}
            title={isWaterLevelMulti ? '展開日期/模型' : '展開模型'}
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
              {wl.substances!.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  className={`btn xs water-level-sub-btn${wl.activeSubstance === s.id ? ' active' : ''}`}
                  onClick={() => setActiveSubstance(s.id)}
                  title={s.name}
                >
                  {s.name}
                </button>
              ))}
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
    </li>
  );
}
