import type { ReactNode } from 'react';

interface Props {
  title: ReactNode;
  collapsed: boolean;
  onToggle: () => void;
  rightExtra?: ReactNode;
  className?: string;
  children?: ReactNode;
}

export function CollapsibleSection({ title, collapsed, onToggle, rightExtra, className, children }: Props) {
  return (
    <div className={`panel-section${collapsed ? ' collapsed' : ''}${className ? ` ${className}` : ''}`}>
      <div className="section-header">
        <button
          type="button"
          className="collapse-btn"
          onClick={onToggle}
          aria-label={collapsed ? '展開' : '收合'}
          title={collapsed ? '展開' : '收合'}
        >
          {collapsed ? '▸' : '▾'}
        </button>
        <span className="section-title">{title}</span>
        {rightExtra && <span className="section-extra">{rightExtra}</span>}
      </div>
      {!collapsed && <div className="section-body">{children}</div>}
    </div>
  );
}
