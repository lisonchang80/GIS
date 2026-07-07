import { useEffect, useRef, useState, type DragEvent } from 'react';
import type { LayerGroup } from './types';

interface Props {
  group: LayerGroup;
  memberCount: number;
  allVisible: boolean;
  anyVisible: boolean;
  isDropTarget: boolean;
  onToggleVisibility: () => void;
  onToggleCollapse: () => void;
  onRename: (name: string) => void;
  onRemove: () => void;
  onDragOver: (e: DragEvent<HTMLDivElement>) => void;
  onDragLeave: () => void;
  onDrop: (e: DragEvent<HTMLDivElement>) => void;
}

export function LayerGroupHeader(p: Props) {
  const checkRef = useRef<HTMLInputElement>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(p.group.name);

  useEffect(() => {
    if (checkRef.current) checkRef.current.indeterminate = p.anyVisible && !p.allVisible;
  }, [p.anyVisible, p.allVisible]);

  const commit = () => {
    const trimmed = draft.trim();
    if (trimmed && trimmed !== p.group.name) p.onRename(trimmed);
    else setDraft(p.group.name);
    setEditing(false);
  };

  return (
    <div
      className={`layer-group-header ${p.isDropTarget ? 'drop-into' : ''}`}
      onDragOver={p.onDragOver}
      onDragLeave={p.onDragLeave}
      onDrop={p.onDrop}
    >
      <button
        className="icon-btn group-collapse"
        title={p.group.collapsed ? '展開群組' : '收合群組'}
        onClick={p.onToggleCollapse}
      >{p.group.collapsed ? '▸' : '▾'}</button>
      <input
        ref={checkRef}
        type="checkbox"
        checked={p.memberCount > 0 && p.allVisible}
        disabled={p.memberCount === 0}
        title="同時勾選 / 取消群組內所有圖層"
        onChange={p.onToggleVisibility}
      />
      <span className="group-folder-icon" aria-hidden>🗀</span>
      {editing ? (
        <input
          autoFocus
          className="name-input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
            if (e.key === 'Escape') { setDraft(p.group.name); setEditing(false); }
          }}
        />
      ) : (
        <span
          className="layer-group-name editable"
          title="點擊以重新命名群組"
          onClick={() => { setDraft(p.group.name); setEditing(true); }}
        >
          {p.group.name}
        </span>
      )}
      <span className="group-count">{p.memberCount}</span>
      <button
        className="icon-btn danger"
        title="解散群組（保留圖層）"
        onClick={p.onRemove}
      >⊟</button>
    </div>
  );
}
