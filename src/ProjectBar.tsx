import { useRef, useState } from 'react';
import { CollapsibleSection } from './CollapsibleSection';
import type { ProjectMeta } from './persistence';

interface Props {
  savedAt: Date | null;
  projects: ProjectMeta[];
  currentProjectId: number | null;
  onSwitch: (id: number) => void;
  onNew: () => void;
  onDelete: () => void;
  onExport: () => void;
  onImport: (file: File) => void;
  onClear: () => void;
}

export function ProjectBar(p: Props) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [collapsed, setCollapsed] = useState(false);

  return (
    <CollapsibleSection
      title="專案"
      collapsed={collapsed}
      onToggle={() => setCollapsed((c) => !c)}
    >
      <div className="project-switch-row">
        <select
          className="select project-select"
          value={p.currentProjectId ?? ''}
          onChange={(e) => p.onSwitch(Number(e.target.value))}
          title="切換專案"
        >
          {p.projects.length === 0 && <option value="">（無專案）</option>}
          {p.projects.map((proj) => (
            <option key={proj.id} value={proj.id}>
              {proj.name || '未命名專案'}
            </option>
          ))}
        </select>
        <button className="btn sm" onClick={p.onNew} title="新增專案">＋</button>
        <button
          className="btn sm danger"
          onClick={p.onDelete}
          disabled={p.currentProjectId == null}
          title="刪除目前專案"
        >
          🗑
        </button>
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
