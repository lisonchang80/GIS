import { useState } from 'react';
import { CollapsibleSection } from './CollapsibleSection';
import type { MeasureMode, MeasureResult } from './measure';

interface Tool {
  id: MeasureMode;
  label: string;
  icon: string;
  title: string;
}

const TOOLS: Tool[] = [
  { id: 'line', label: '線・距離', icon: '╱', title: '點擊新增節點，雙擊（或 Enter）結束；量測折線總長' },
  { id: 'polygon', label: '多邊形・面積', icon: '▲', title: '點擊新增節點，雙擊（或 Enter）結束；量測面積與周長' },
  { id: 'circle', label: '圓形・面積', icon: '◯', title: '點一下定圓心，移動滑鼠拉半徑，再點一下結束' },
];

const HINTS: Record<MeasureMode, string> = {
  line: '點擊地圖新增節點，雙擊或按 Enter 結束。按 Esc 清除，可接著量下一條。',
  polygon: '點擊地圖新增節點（至少 3 點），雙擊或按 Enter 結束。按 Esc 清除。',
  circle: '點一下定圓心，移動滑鼠決定半徑，再點一下結束。按 Esc 清除。',
};

interface Props {
  activeMode: MeasureMode | null;
  result: MeasureResult | null;
  onSelect: (mode: MeasureMode | null) => void;
  onClear: () => void;
}

export function MeasureToolbar({ activeMode, result, onSelect, onClear }: Props) {
  const [collapsed, setCollapsed] = useState(true);

  return (
    <CollapsibleSection
      title="量測工具"
      collapsed={collapsed}
      onToggle={() => setCollapsed((c) => !c)}
    >
      <div className="tool-grid measure-grid">
        {TOOLS.map((t) => (
          <button
            key={t.id}
            className={`tool-btn ${activeMode === t.id ? 'active' : ''}`}
            title={t.title}
            onClick={() => onSelect(activeMode === t.id ? null : t.id)}
          >
            <span className="tool-icon">{t.icon}</span>
            <span className="tool-label">{t.label}</span>
          </button>
        ))}
      </div>

      {activeMode && (
        <div className="coord-box">
          {result && result.primary ? (
            <div className="measure-result">
              <span className="measure-value">{result.primary}</span>
              {result.detail && <span className="measure-detail">{result.detail}</span>}
              {result.inProgress && <span className="measure-progress">量測中…</span>}
            </div>
          ) : (
            <p className="hint">{HINTS[activeMode]}</p>
          )}
          <div className="tool-actions" style={{ marginTop: 6 }}>
            <button className="btn sm" onClick={onClear}>清除量測</button>
            <button className="btn sm" onClick={() => onSelect(null)}>結束工具</button>
          </div>
        </div>
      )}
    </CollapsibleSection>
  );
}
