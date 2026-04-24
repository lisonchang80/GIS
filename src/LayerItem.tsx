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
        <button
          className={`icon-btn ${p.attributesActive ? 'active' : ''}`}
          title="開啟 / 關閉屬性表"
          onClick={p.onShowAttributes}
        >▤</button>
        <button className="icon-btn" title="縮放至圖層" onClick={p.onZoom}>⤢</button>
        <button className="icon-btn danger" title="移除" onClick={p.onRemove}>×</button>
      </div>
    </li>
  );
}
