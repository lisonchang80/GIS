import { useEffect, useRef, useState } from 'react';
import { CollapsibleSection } from './CollapsibleSection';
import type { ProjectMeta } from './persistence';

interface Props {
  savedAt: Date | null;
  projects: ProjectMeta[];
  currentProjectId: number | null;
  onSwitch: (id: number) => void;
  onNew: (name: string) => void;
  onSaveAs: (name: string) => void;
  onDelete: (id: number) => void;
  onExport: () => void;
  onImport: (file: File) => void;
  onClear: () => void;
}

type Popup = 'select' | 'new' | 'saveAs' | 'delete' | null;

export function ProjectBar(p: Props) {
  const fileRef = useRef<HTMLInputElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [popup, setPopup] = useState<Popup>(null);
  const [nameDraft, setNameDraft] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<number | null>(null);

  const current = p.projects.find((x) => x.id === p.currentProjectId) ?? null;
  const currentName = current?.name || '未命名專案';

  // Close any open popup on outside-click or Esc.
  useEffect(() => {
    if (!popup) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setPopup(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPopup(null);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [popup]);

  const openNew = () => {
    setNameDraft('');
    setPopup('new');
  };
  const openSaveAs = () => {
    setNameDraft(`${currentName} 複本`);
    setPopup('saveAs');
  };
  const openDelete = () => {
    setDeleteTarget(p.currentProjectId);
    setPopup('delete');
  };
  const toggleSelect = () => setPopup((x) => (x === 'select' ? null : 'select'));

  const submitName = () => {
    const name = nameDraft.trim() || '未命名專案';
    if (popup === 'new') p.onNew(name);
    else if (popup === 'saveAs') p.onSaveAs(name);
    setPopup(null);
  };

  const confirmDelete = () => {
    if (deleteTarget != null) p.onDelete(deleteTarget);
    setPopup(null);
  };

  return (
    <CollapsibleSection
      title="專案"
      collapsed={collapsed}
      onToggle={() => setCollapsed((c) => !c)}
    >
      <div className="project-bar" ref={wrapRef}>
        <button
          className={`project-pick-btn${popup === 'select' ? ' is-open' : ''}`}
          onClick={toggleSelect}
          title="選擇專案"
        >
          <span className="project-pick-name">{currentName}</span>
          <span className="caret">▾</span>
        </button>

        <div className="project-btn-actions">
          <button className="btn sm" onClick={openNew} title="新建空白專案">新建</button>
          <button
            className="btn sm"
            onClick={openSaveAs}
            disabled={p.currentProjectId == null}
            title="把目前內容另存為新專案"
          >
            另存
          </button>
          <button
            className="btn sm danger"
            onClick={openDelete}
            disabled={p.currentProjectId == null}
            title="刪除專案"
          >
            刪除
          </button>
        </div>

        {popup === 'select' && (
          <div className="project-popup project-select-popup" role="listbox">
            {p.projects.length === 0 && <div className="project-popup-empty">（無專案）</div>}
            {p.projects.map((proj) => (
              <button
                key={proj.id}
                role="option"
                aria-selected={proj.id === p.currentProjectId}
                className={`project-option${proj.id === p.currentProjectId ? ' is-active' : ''}`}
                onClick={() => {
                  setPopup(null);
                  p.onSwitch(proj.id);
                }}
              >
                <span className="project-option-name">{proj.name || '未命名專案'}</span>
                {proj.id === p.currentProjectId && <span className="project-option-tick">✓</span>}
              </button>
            ))}
          </div>
        )}

        {(popup === 'new' || popup === 'saveAs') && (
          <div className="project-popup project-name-popup">
            <div className="project-popup-title">{popup === 'new' ? '新建專案' : '另存專案'}</div>
            <input
              className="project-popup-input"
              autoFocus
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submitName();
              }}
              placeholder="專案名稱"
            />
            <div className="project-popup-actions">
              <button className="btn xs" onClick={() => setPopup(null)}>取消</button>
              <button className="btn xs primary" onClick={submitName}>
                {popup === 'new' ? '建立' : '另存'}
              </button>
            </div>
          </div>
        )}

        {popup === 'delete' && (
          <div className="project-popup project-delete-popup">
            <div className="project-popup-title">刪除專案</div>
            <select
              className="select"
              value={deleteTarget ?? ''}
              onChange={(e) => setDeleteTarget(Number(e.target.value))}
            >
              {p.projects.map((proj) => (
                <option key={proj.id} value={proj.id}>
                  {proj.id === p.currentProjectId
                    ? `（目前）${proj.name || '未命名專案'}`
                    : proj.name || '未命名專案'}
                </option>
              ))}
            </select>
            <p className="project-popup-warn">此動作無法復原。</p>
            <div className="project-popup-actions">
              <button className="btn xs" onClick={() => setPopup(null)}>取消</button>
              <button
                className="btn xs danger"
                onClick={confirmDelete}
                disabled={deleteTarget == null}
              >
                刪除
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="project-actions">
        <button className="btn sm" onClick={p.onExport}>匯出…</button>
        <button className="btn sm" onClick={() => fileRef.current?.click()}>匯入…</button>
        <button className="btn sm danger" onClick={p.onClear}>清空內容</button>
      </div>
      <input
        ref={fileRef}
        type="file"
        accept=".json"
        style={{ display: 'none' }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) p.onImport(f);
          if (fileRef.current) fileRef.current.value = '';
        }}
      />
      <p className="hint save-status">
        {p.savedAt
          ? `✓ 已儲存於 ${p.savedAt.toLocaleTimeString('zh-TW', { hour12: false })}`
          : '尚未儲存'}
      </p>
    </CollapsibleSection>
  );
}
