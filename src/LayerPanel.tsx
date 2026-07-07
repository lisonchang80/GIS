import { useRef, useState, type ReactNode } from 'react';
import type { BaseMapId, BaseMapOption, LayerGroup, VectorLayer } from './types';
import { LayerItem } from './LayerItem';
import { LayerGroupHeader } from './LayerGroupHeader';
import { CollapsibleSection } from './CollapsibleSection';
import { useAuth } from './authContext';

interface Props {
  basemaps: BaseMapOption[];
  activeBasemap: BaseMapId;
  onBasemapChange: (id: BaseMapId) => void;
  basemapVersionIndex: number;
  onBasemapVersionChange: (index: number) => void;
  basemapOpacity: number;
  onBasemapOpacityChange: (value: number) => void;
  onBasemapOpacityReset: () => void;
  onPan: (dx: number, dy: number) => void;
  onPanReset: () => void;
  projectName: string;
  layers: VectorLayer[];
  layerGroups: LayerGroup[];
  onUpdateLayer: (id: string, patch: Partial<VectorLayer>) => void;
  onRemoveLayer: (id: string) => void;
  onZoomLayer: (id: string) => void;
  onReorderLayer: (draggedId: string, targetId: string, position: 'above' | 'below') => void;
  onCreateGroup: () => void;
  onRenameGroup: (groupId: string, name: string) => void;
  onToggleGroupCollapse: (groupId: string) => void;
  onToggleGroupVisibility: (groupId: string) => void;
  onRemoveGroup: (groupId: string) => void;
  onAssignToGroup: (layerId: string, groupId: string | null) => void;
  onShowAttributes: (id: string) => void;
  onToggleStyle: (id: string) => void;
  onOpen3D: (id: string) => void;
  activeAttributesLayerId: string | null;
  activeStyleLayerId: string | null;
  onFiles: (files: FileList) => void;
  width: number;
  beforeBasemap?: ReactNode;
  children?: ReactNode;
}

export function LayerPanel(p: Props) {
  const auth = useAuth();
  const fileRef = useRef<HTMLInputElement>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const [overPosition, setOverPosition] = useState<'above' | 'below' | null>(null);
  const [overGroupId, setOverGroupId] = useState<string | null>(null);
  const [basemapCollapsed, setBasemapCollapsed] = useState(true);

  const activeBase = p.basemaps.find((b) => b.id === p.activeBasemap);
  const versions = activeBase?.versions;
  const hasVersions = !!versions && versions.length > 0;
  const versionIndex = hasVersions
    ? Math.max(0, Math.min(p.basemapVersionIndex, versions.length - 1))
    : 0;
  const versionLabel = hasVersions ? versions[versionIndex].label : '—';
  const defaultIdx = hasVersions ? activeBase?.defaultVersionIndex ?? versions.length - 1 : 0;

  const PAN_PX = 120;

  const renderLayerItem = (layer: VectorLayer, i: number, grouped: boolean) => (
    <LayerItem
      key={layer.id}
      layer={layer}
      allLayers={p.layers}
      index={i}
      total={p.layers.length}
      grouped={grouped}
      onRemoveFromGroup={grouped ? () => p.onAssignToGroup(layer.id, null) : undefined}
      dragOver={overId === layer.id && draggingId !== layer.id ? overPosition : null}
      onToggle={() => p.onUpdateLayer(layer.id, { visible: !layer.visible })}
      onOpacity={(v) => p.onUpdateLayer(layer.id, { opacity: v })}
      onUpdate={(patch) => p.onUpdateLayer(layer.id, patch)}
      onRename={(name) => p.onUpdateLayer(layer.id, { name })}
      onRemove={() => p.onRemoveLayer(layer.id)}
      onZoom={() => p.onZoomLayer(layer.id)}
      onShowAttributes={() => p.onShowAttributes(layer.id)}
      onToggleStyle={() => p.onToggleStyle(layer.id)}
      onOpen3D={() => p.onOpen3D(layer.id)}
      attributesActive={p.activeAttributesLayerId === layer.id}
      styleActive={p.activeStyleLayerId === layer.id}
      onDragStart={() => setDraggingId(layer.id)}
      onDragEnd={() => {
        setDraggingId(null);
        setOverId(null);
        setOverPosition(null);
        setOverGroupId(null);
      }}
      onDragOverRow={(position) => {
        if (draggingId !== layer.id) {
          setOverId(layer.id);
          setOverPosition(position);
          setOverGroupId(null);
        }
      }}
      onDragLeaveRow={() => {
        if (overId === layer.id) {
          setOverId(null);
          setOverPosition(null);
        }
      }}
      onDropRow={() => {
        if (draggingId && draggingId !== layer.id && overPosition) {
          p.onReorderLayer(draggingId, layer.id, overPosition);
        }
        setDraggingId(null);
        setOverId(null);
        setOverPosition(null);
        setOverGroupId(null);
      }}
    />
  );

  // 群組標題的拖入處理：把被拖曳的圖層指派進該群組
  const groupDropHandlers = (groupId: string) => ({
    onDragOver: (e: React.DragEvent<HTMLDivElement>) => {
      if (!draggingId) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      setOverGroupId(groupId);
      setOverId(null);
      setOverPosition(null);
    },
    onDragLeave: () => setOverGroupId((g) => (g === groupId ? null : g)),
    onDrop: (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      if (draggingId) p.onAssignToGroup(draggingId, groupId);
      setDraggingId(null);
      setOverGroupId(null);
    },
  });

  // 組出顯示列：空群組列在最上方（作為拖曳目標），其餘依圖層陣列順序，
  // 同群組的連續區塊收攏在一個群組標題底下。
  const groupsById = new Map(p.layerGroups.map((g) => [g.id, g] as const));
  const usedGroupIds = new Set(p.layers.map((l) => l.groupId).filter(Boolean) as string[]);
  const emptyGroups = p.layerGroups.filter((g) => !usedGroupIds.has(g.id));

  type Row =
    | { kind: 'layer'; layer: VectorLayer; index: number }
    | { kind: 'group'; group: LayerGroup; members: { layer: VectorLayer; index: number }[] };
  const rows: Row[] = [];
  let i = 0;
  while (i < p.layers.length) {
    const layer = p.layers[i];
    const group = layer.groupId ? groupsById.get(layer.groupId) : undefined;
    if (group) {
      const members: { layer: VectorLayer; index: number }[] = [];
      let j = i;
      while (j < p.layers.length && p.layers[j].groupId === group.id) {
        members.push({ layer: p.layers[j], index: j });
        j++;
      }
      rows.push({ kind: 'group', group, members });
      i = j;
    } else {
      rows.push({ kind: 'layer', layer, index: i });
      i++;
    }
  }

  const renderGroup = (group: LayerGroup, members: { layer: VectorLayer; index: number }[]) => {
    const allVisible = members.length > 0 && members.every((m) => m.layer.visible);
    const anyVisible = members.some((m) => m.layer.visible);
    return (
      <li key={group.id} className="layer-group">
        <LayerGroupHeader
          group={group}
          memberCount={members.length}
          allVisible={allVisible}
          anyVisible={anyVisible}
          isDropTarget={overGroupId === group.id}
          onToggleVisibility={() => p.onToggleGroupVisibility(group.id)}
          onToggleCollapse={() => p.onToggleGroupCollapse(group.id)}
          onRename={(name) => p.onRenameGroup(group.id, name)}
          onRemove={() => p.onRemoveGroup(group.id)}
          {...groupDropHandlers(group.id)}
        />
        {!group.collapsed && (
          <ul className="layer-group-body">
            {members.length === 0 ? (
              <li className="layer-group-empty">拖曳圖層到此加入群組</li>
            ) : (
              members.map((m) => renderLayerItem(m.layer, m.index, true))
            )}
          </ul>
        )}
      </li>
    );
  };

  return (
    <aside className="panel" style={{ width: p.width, minWidth: p.width, flex: '0 0 auto' }}>
      <div className="panel-section panel-header">
        <div className="panel-header-top">
          <h1 className="panel-title">Web GIS</h1>
          {auth && (
            <div className="panel-user" title={auth.user.email}>
              {auth.user.picture ? (
                <img src={auth.user.picture} alt="" className="panel-user-avatar" />
              ) : (
                <span className="panel-user-avatar panel-user-avatar-fallback">
                  {(auth.user.name || auth.user.email || '?').slice(0, 1).toUpperCase()}
                </span>
              )}
              <span className="panel-user-name">{auth.user.name || auth.user.email}</span>
              <button className="panel-user-logout" onClick={auth.logout} title="登出">
                登出
              </button>
            </div>
          )}
        </div>
        <div className="project-name-display" title={p.projectName}>
          {p.projectName}
        </div>
      </div>

      {p.beforeBasemap}

      <CollapsibleSection
        title="底圖"
        collapsed={basemapCollapsed}
        onToggle={() => setBasemapCollapsed((c) => !c)}
      >
        <select
          className="select"
          value={p.activeBasemap}
          onChange={(e) => p.onBasemapChange(e.target.value as BaseMapId)}
        >
          {p.basemaps.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>

        <div className="control-row">
          <label className="control-label">年份</label>
          <button
            className="btn xs"
            disabled={!hasVersions || versionIndex === 0}
            onClick={() => p.onBasemapVersionChange(versionIndex - 1)}
            title="上一個年份"
          >◀</button>
          <span className="control-value year-label">{versionLabel}</span>
          <button
            className="btn xs"
            disabled={!hasVersions || versionIndex >= (versions?.length ?? 1) - 1}
            onClick={() => p.onBasemapVersionChange(versionIndex + 1)}
            title="下一個年份"
          >▶</button>
          <button
            className="btn xs"
            disabled={!hasVersions || versionIndex === defaultIdx}
            onClick={() => p.onBasemapVersionChange(defaultIdx)}
            title="跳到最新"
          >現在</button>
        </div>

        <div className="control-row">
          <label className="control-label">透明度</label>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={p.basemapOpacity}
            onChange={(e) => p.onBasemapOpacityChange(parseFloat(e.target.value))}
            className="slider"
          />
          <span className="control-value">{Math.round(p.basemapOpacity * 100)}%</span>
          <button
            className="btn xs"
            onClick={p.onBasemapOpacityReset}
            disabled={p.basemapOpacity === 1}
            title="還原為 100%"
          >還原</button>
        </div>

        <div className="control-row">
          <label className="control-label">平移</label>
          <div className="pan-pad">
            <button className="btn xs pan-up" onClick={() => p.onPan(0, -PAN_PX)} title="上">↑</button>
            <button className="btn xs pan-left" onClick={() => p.onPan(-PAN_PX, 0)} title="左">←</button>
            <button className="btn xs pan-center" onClick={p.onPanReset} title="還原視野">⌂</button>
            <button className="btn xs pan-right" onClick={() => p.onPan(PAN_PX, 0)} title="右">→</button>
            <button className="btn xs pan-down" onClick={() => p.onPan(0, PAN_PX)} title="下">↓</button>
          </div>
        </div>
      </CollapsibleSection>

      {p.children}

      <div className="panel-section layers-section">
        <div className="layers-header">
          <span className="label">
            圖層 <span className="counter">{p.layers.length}</span>
            {p.layers.length > 1 && <span className="hint-inline">拖曳排序</span>}
          </span>
          <button
            className="btn xs"
            onClick={p.onCreateGroup}
            title="新增圖層群組，可將圖層拖曳進去統一控制顯示"
          >
            新增群組
          </button>
          <button
            className="btn xs primary"
            onClick={() => fileRef.current?.click()}
            title="支援 GeoJSON / KML / GPX / Shapefile (.zip)"
          >
            匯入圖層
          </button>
          <input
            ref={fileRef}
            type="file"
            multiple
            accept=".geojson,.json,.kml,.gpx,.zip,.shp"
            style={{ display: 'none' }}
            onChange={(e) => {
              if (e.target.files && e.target.files.length > 0) {
                p.onFiles(e.target.files);
                if (fileRef.current) fileRef.current.value = '';
              }
            }}
          />
        </div>
        {p.layers.length === 0 && p.layerGroups.length === 0 && (
          <p className="empty">尚無圖層，請匯入檔案</p>
        )}
        <ul className="layer-list">
          {emptyGroups.map((g) => renderGroup(g, []))}
          {rows.map((row) =>
            row.kind === 'group'
              ? renderGroup(row.group, row.members)
              : renderLayerItem(row.layer, row.index, false),
          )}
        </ul>
      </div>
    </aside>
  );
}
