import { useRef, useState } from 'react';
import { CollapsibleSection } from './CollapsibleSection';

interface Props {
  savedAt: Date | null;
  onExport: () => void;
  onImport: (file: File) => void;
  onClear: () => void;
}

export function ProjectBar(p: Props) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [collapsed, setCollapsed] = useState(true);

  return (
    <CollapsibleSection
      title="專案"
      collapsed={collapsed}
      onToggle={() => setCollapsed((c) => !c)}
    >
      <div className="project-actions">
        <button className="btn sm" onClick={p.onExport}>匯出…</button>
        <button className="btn sm" onClick={() => fileRef.current?.click()}>匯入…</button>
        <button className="btn sm danger" onClick={p.onClear}>清除存檔</button>
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
