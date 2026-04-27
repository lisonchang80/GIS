---
name: gis-threshold-highlight
description: Apply alert/warn highlight classes to UI surfaces (attribute table cells, layer panel substance buttons, etc.) based on whether a numeric value exceeds controlConc / monitorConc thresholds. Use when user wants "超過管制變紅底，管制與監測之間上橘底" or any similar threshold-driven visual on a numeric value. Pattern generalizes to any monitoring tab (gw-conc / soil / gas) with control/monitor thresholds, and to other UI elements that should reflect breach state at the active date.
---

# Threshold-based highlight

對 controlConc / monitorConc 這類「管制 / 監測」雙門檻的監測數值，用一致的 alert/warn 類名套上紅 / 橘色高亮。已套在地下水濃度監測的屬性表 cell 與 LayerItem 物質按鈕。同一份 pattern 也適用未來的土壤濃度、土壤氣體濃度等分頁。

## 核心規則

```ts
function levelOf(num: number, M?: number, C?: number): 'alert' | 'warn' | null {
  if (typeof C === 'number' && num >= C) return 'alert';
  if (typeof M === 'number' && num >= M) return 'warn';
  return null;
}
```

- `alert`（紅）= 超過管制濃度（C）
- `warn`（橘）= 介於監測（M）與管制（C）之間
- 缺 M 或 C 不擲錯，視為該層級不存在
- 順序固定：先檢查 C 再檢查 M（即使資料異常 M > C 也讓 alert 優先）

## CSS class 命名約定

| 用途 | class |
|---|---|
| 屬性表 cell | `gw-conc-cell-alert` / `gw-conc-cell-warn` |
| LayerItem 物質按鈕 | `water-level-sub-btn.alert` / `.warn` |

新 UI 表面建議沿用同名後綴（`-alert` / `-warn` 或 `.alert` / `.warn`），避免每處重新發明。

## 顏色（與既有 threshold 線同色系）

- 紅 `rgba(239, 68, 68, X)`（同 `#ef4444` threshold-control）
- 橘 `rgba(249, 115, 22, X)`（同 `#f97316` threshold-monitor）

不透明度：背景 `0.22` ~ `0.42`，邊框 `0.55` ~ `0.95`。Cell 比按鈕底色稍淡（cell 0.22/0.28、btn 0.22/0.28；hover 0.34/0.4）。

## Step 1 — 屬性表 cell

在 `subDates.map` cell render 內：

```tsx
const C = activeSubstance.controlConc;
const M = activeSubstance.monitorConc;
let level: 'alert' | 'warn' | null = null;
if (num !== null) {
  if (typeof C === 'number' && num >= C) level = 'alert';
  else if (typeof M === 'number' && num >= M) level = 'warn';
}
const cellCls = ['editable', isEditing ? 'editing' : '', level ? `gw-conc-cell-${level}` : '']
  .filter(Boolean).join(' ');
```

CSS（在 `.gw-conc-table` 區塊附近）：
```css
.attr-table td.gw-conc-cell-warn  { background: rgba(249, 115, 22, 0.22); }
.attr-table td.gw-conc-cell-alert { background: rgba(239, 68, 68, 0.28); }
.attr-table td.gw-conc-cell-warn.editable:hover  { background: rgba(249, 115, 22, 0.34); outline: 1px dashed rgba(249, 115, 22, 0.85); outline-offset: -1px; }
.attr-table td.gw-conc-cell-alert.editable:hover { background: rgba(239, 68, 68, 0.4);  outline: 1px dashed rgba(239, 68, 68, 0.9);  outline-offset: -1px; }
```

**Hover override 必須提**：`.attr-table td.editable:hover` 預設藍底會蓋掉，自訂 hover rule 要把同 specificity 的橘/紅版補回去。

## Step 2 — LayerItem 物質按鈕（隨 activeDate 變動）

LayerItem 需要 sourceLayer 的 features 才能算每個物質在 activeDate 的最大值狀態。從 LayerPanel 透過 prop 傳入：

```tsx
// LayerPanel.tsx
<LayerItem ... allLayers={p.layers} />

// LayerItem.tsx Props
allLayers: VectorLayer[];
```

計算：

```ts
const subStatus: Record<string, 'alert' | 'warn' | null> = {};
if (isMultiSub && wl && wl.sourceKind === 'gw-conc' && wl.sourceLayerId && wl.sourceTabId) {
  const srcLayer = p.allLayers.find((l) => l.id === wl.sourceLayerId);
  const srcTab = srcLayer?.gwConcTabs?.find((t) => t.id === wl.sourceTabId);
  if (srcLayer && srcTab) {
    for (const s of wl.substances ?? []) {
      const subDef = srcTab.substances.find((x) => x.id === s.id);
      const C = subDef?.controlConc;
      const M = subDef?.monitorConc;
      let alert = false, warn = false;
      for (const f of srcLayer.data.features) {
        const props = (f.properties ?? {}) as Record<string, unknown>;
        const gw = props['__gwConc'] as Record<string, Record<string, Record<string, unknown>>> | undefined;
        const v = gw?.[wl.sourceTabId!]?.[s.id]?.[wl.activeDate];
        if (typeof v !== 'number') continue;
        if (typeof C === 'number' && v >= C) { alert = true; break; }
        if (typeof M === 'number' && v >= M) warn = true;
      }
      subStatus[s.id] = alert ? 'alert' : warn ? 'warn' : null;
    }
  }
}
```

- **聚合策略**：任一點超管制 → alert；無 alert 但有點介於 → warn
- alert 一旦確定可 `break`（已是最高等級）
- warn 不能 break — 還可能後面遇到 alert

按鈕 className：

```tsx
const cls = [
  'btn', 'xs', 'water-level-sub-btn',
  wl.activeSubstance === s.id ? 'active' : '',
  status ? status : '',
].filter(Boolean).join(' ');
```

CSS：

```css
.water-level-sub-btn.warn  { background: rgba(249, 115, 22, 0.22); border-color: rgba(249, 115, 22, 0.6);  color: #fff; }
.water-level-sub-btn.alert { background: rgba(239, 68, 68, 0.28); border-color: rgba(239, 68, 68, 0.65); color: #fff; }
.water-level-sub-btn.active.warn  { background: rgba(249, 115, 22, 0.36); border-color: rgba(249, 115, 22, 0.9);  box-shadow: inset 0 0 0 1px rgba(59, 130, 246, 0.85); }
.water-level-sub-btn.active.alert { background: rgba(239, 68, 68, 0.42); border-color: rgba(239, 68, 68, 0.95); box-shadow: inset 0 0 0 1px rgba(59, 130, 246, 0.85); }
```

**Active + warn/alert 共存策略**：threshold 色當主背景，藍色 `inset box-shadow` 表示選中。比硬 override 更直覺。

## Step 3 — 其他 UI 表面

要套同一 pattern 到別處（譬如未來新分頁、或圖例 legend、或地圖上的點 marker）：

1. 寫一個 `levelOf(num, M, C)` helper（或 inline）
2. 把 class 加到 className 串
3. CSS 用 `.parent .alert` / `.parent .warn` 命名（避免 class 名碰撞）

不要再發明新的色號 / 命名 — 一致性優先。

## 易踩的坑

- **Hover override**：CSS 預設 hover 規則（藍底）會蓋掉自訂高亮。記得補同 specificity 的 hover 變體
- **缺 M / C 的 fallback**：`typeof === 'number'` 檢查，不要用 truthy（M=0 會被當成沒設）
- **聚合 vs 單點**：按鈕反映「此圖層此日期下所有點的最壞狀態」；cell 反映該點該日期該物質的單一值。不要混淆
- **activeDate 換日期不重算**：因為計算放在 render 主體，每次 re-render 會重跑。只要 setActiveDate 觸發 setLayers 就會 re-render — 不需 useMemo 也不需手動 invalidate

## 不要做的事

- 不要把 alert/warn 寫進 feature properties（`__alert: true`）— 這是純衍生狀態，存到資料層會造成二次同步問題
- 不要在 contour rebuild 階段挑色 — contour 圖層的填色是另一條獨立 pipeline（fill bands），跟這個 highlight 不相關
