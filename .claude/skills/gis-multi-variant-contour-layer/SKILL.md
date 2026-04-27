---
name: gis-multi-variant-contour-layer
description: Build a single contour layer that holds multiple variants (e.g. multi-pollutant for groundwater) with active-variant switching via map filter, not rebuild. Use when the user wants "all X × all dates → one combined layer" instead of N separate layers, with row of variant buttons in the layer panel. Pattern is generalizable to soil/gas concentration tabs, multi-parameter wells, etc. Optional Step 9 covers per-variant style overrides (substanceStyles[id]) for when variants need independent fill bands / lines / arrows due to disparate value ranges (e.g. concentrations spanning orders of magnitude).
---

# 多變數合併 contour 圖層

GIS 既有 contour 結構（`waterLevel`）原本是「一個圖層 = 一個量值（高程−深度 / 單一污染物）× N 個日期」。當需要「一個圖層 = 多個量值 × N 個日期」（典型場景：地下水濃度監測展開所有污染物）時，走這份 skill 描述的合併圖層 pattern。

## 何時用這 pattern vs 開 N 個獨立圖層

**用合併圖層**：
- 變數彼此語意相關，使用者會頻繁切換比較（同一份報告的不同污染物）
- 樣式/設定可共用部分（同一個模型、同一組日期）
- 圖層數會爆炸（5 種污染物 × 10 個批次 = 50 個圖層 → 不可行）

**N 個獨立圖層**：
- 變數彼此獨立，不會比較切換（不同井的不同水位線）
- 各自需要完全不同樣式
- 數量天然受限

## 必要條件

- contour pipeline 已支援該 source 的樣本收集（`collectXxxSamplesForDate(source, ..., date) → IDWSample[]`）
- 各變數有 unique id（不能用 name 當 key — 使用者可能改名）

## Step 1 — 擴充 `waterLevel` struct

`src/types.ts`：
```ts
waterLevel?: {
  // 既有欄位
  dates: string[];
  activeDate: string;
  // 新增
  substances?: Array<{ id: string; name: string }>;  // 取代 sourceSubId 單值
  activeSubstance?: string;
  // ...
};
```

**重點**：
- `substances` 與 `sourceSubId` **互斥** — 單變數圖層用 `sourceSubId`，多變數圖層用 `substances + activeSubstance`
- `substances` 只存最小資訊（id + name 用於顯示）；參數值（管制濃度等）每次 rebuild 從 source 圖層查最新版

## Step 2 — feature 級 tag

每個 contour feature 多打 `__substance: id` 屬性。在 generate handler 內：

```ts
for (const sub of substances) {
  const feats = buildContourLayerFeatures(layer, date, /* ... per-sub config ... */);
  for (const f of feats) {
    allFeatures.push({
      ...f,
      properties: {
        ...(f.properties ?? {}),
        __substance: sub.id,
        __substanceName: sub.name,  // 可選，方便 debug
      },
    });
  }
}
```

## Step 3 — MapView filter 串接

`src/MapView.tsx` 的 `wrap` 函式（包 base filter）目前疊上 `dateFilter`。再加 `subFilter`：

```ts
const subFilter = layer.waterLevel?.activeSubstance
  ? (['==', ['get', '__substance'], layer.waterLevel.activeSubstance] as ...)
  : null;
const wrap = (base) => {
  const filters = [base];
  if (dateFilter) filters.push(dateFilter);
  if (subFilter) filters.push(subFilter);
  if (filters.length === 1) return base;
  return ['all', ...filters] as ...;
};
```

**這個是核心優化**：切 `activeSubstance` 不重建 features，只改 filter，瞬間切換。

## Step 4 — `rebuildContourLayer` 多變數分支

`src/contour.ts` 的 `rebuildContourLayer`：

```ts
const isMultiSub = wl.sourceKind === '<kind>' && !!wl.sourceTabId && !!wl.substances && wl.substances.length > 0;

if (isMultiSub) {
  const allFeats: Feature[] = [];
  for (const subRef of wl.substances) {
    const sub = source.<tabsField>?.find(t => t.id === wl.sourceTabId)?.substances.find(s => s.id === subRef.id);
    if (!sub) continue;
    // 每個 variant 用自己的 controlConc / monitorConc / unit 等計算 thresholds + fill bands
    const subDefaults = makeXxxDefaultsForSub(sub);
    for (const date of wl.dates) {
      const samples = collectXxxSamplesForDate(source, wl.sourceTabId, sub.id, date);
      if (samples.length < 3) continue;
      const feats = buildContourLayerFeatures(source, date, subDefaults.fill, subDefaults.lines, wl.arrows, {
        model: wl.model,
        samples,
        contourOpts: /* per-sub opts */,
        thresholds: /* per-sub thresholds */,
      });
      for (const f of feats) {
        allFeats.push({
          ...f,
          properties: {
            ...(f.properties ?? {}),
            __substance: sub.id,
            __substanceName: sub.name,
          },
        });
      }
    }
  }
  return { ...target, data: { ...features: allFeats }, featureCount: allFeats.length };
}
// 否則走單變數既有路徑
```

**重點**：
- 每個 variant 的 fill / threshold / lines 在 rebuild 時從 source 查最新值，使用者改了 controlConc 自動跟著走
- 若 model === 'indicator'，`indicatorThreshold` 也每個 variant 不同（用該 variant 的 controlConc）

## Step 5 — `LayerItem` variant 按鈕列

`src/LayerItem.tsx`：

```tsx
const isMultiSub = !!wl?.substances && wl.substances.length > 0;

const setActiveSubstance = (subId: string) => {
  if (!wl) return;
  p.onUpdate({ waterLevel: { ...wl, activeSubstance: subId } });
};

// 在展開區內：
{isMultiSub && (
  <div className="water-level-row water-level-sub-row">
    {wl.substances.map(s => (
      <button
        key={s.id}
        className={`btn xs water-level-sub-btn${wl.activeSubstance === s.id ? ' active' : ''}`}
        onClick={() => setActiveSubstance(s.id)}
        title={s.name}
      >
        {s.name}
      </button>
    ))}
  </div>
)}
```

CSS 設 `flex-wrap: wrap` 讓按鈕多時自動換行：
```css
.water-level-sub-row {
  flex-wrap: wrap;
  row-gap: 4px;
}
.water-level-sub-btn.active {
  background: rgba(59, 130, 246, 0.3);
  border-color: rgba(59, 130, 246, 0.6);
  color: #fff;
}
```

## Step 6 — `LayerIcon` 變體

LayerIcon 用 inner-circle 數量區分 0 / 單變數複日 / 多變數合併：
```tsx
if (isGwConc) {
  const innerCount = isMultiSub ? 2 : isMulti ? 1 : 0;
  // 0 = 空圓底瓶 / 1 = + 1 同心圓 / 2 = + 2 同心圓
}
```

新類型可以用同一系列 ICON 加另一個區分維度（如顏色或形狀變體）。

## Step 7 — `setActiveDate` 別把 layer name 改成日期

單變數圖層 `setActiveDate` 順便把 `name` 設為 `activeDate`（"2026-05-01" 之類）。多變數合併時別這樣：

```ts
const setActiveDate = (date: string) => {
  p.onUpdate({
    waterLevel: { ...wl, activeDate: date },
    name: isMultiSub ? p.layer.name : date,  // 多變數保留原名
  });
};
```

## Step 8 — `computeContourKey` 不必含 `activeSubstance`

切變數只是 filter 變化，不需重建。**不要**把 `activeSubstance` 加進 `computeContourKey`，否則每次切都會觸發 rebuild（浪費）。

`activeDate` 同理 — 既有實作就排除，照抄。

## Step 9 — 物質內樣式覆寫（選做，但多變數類型強烈建議）

預設情況下 `wl.fill / wl.lines / wl.arrows` 是整層共用。但 variant 間閾值跨數量級時（例：苯 controlConc=0.5 mg/L、TCE=5 mg/L），共用同一組 fill bands 會讓某些 variant 失真。讓**每個 variant 可獨立設定 fill / lines / arrows**：

### 9.1 types — `substanceStyles` 欄位

`src/types.ts`：
```ts
waterLevel?: {
  // 既有欄位 ...
  substanceStyles?: Record<string, SubstanceStyle>;  // key = sub id
};

export interface SubstanceStyle {
  fill?: WaterLevelFill;
  lines?: WaterLevelLines;
  arrows?: WaterLevelArrows;
}
```

### 9.2 contour.ts — `resolveSubstanceStyle` helper

```ts
export function resolveSubstanceStyle(
  override: SubstanceStyle | undefined,
  sub: <SubstanceType>,
  fallbackArrows?: WaterLevelArrows,
): { fill, lines, arrows } {
  const defaults = makeXxxDefaultsForSub(sub);  // Step 4 既有 helper，須 export 出去
  return {
    fill: override?.fill ?? defaults.fill,
    lines: override?.lines ?? defaults.lines,
    arrows: override?.arrows ?? fallbackArrows,
  };
}
```

把 Step 4 multi-sub 分支裡 `subDefaults = makeXxxDefaultsForSub(sub)` 改成 `resolveSubstanceStyle(wl.substanceStyles?.[sub.id], sub, wl.arrows)`。

### 9.3 MapView — active variant 解析 paint props

```ts
function getActiveStyle(layer: VectorLayer) {
  const wl = layer.waterLevel;
  if (!wl) return { fill: undefined, lines: undefined, arrows: undefined };
  const isMultiSub = !!wl.substances && wl.substances.length > 0;
  if (isMultiSub && wl.activeSubstance) {
    const override = wl.substanceStyles?.[wl.activeSubstance];
    return {
      fill: override?.fill ?? wl.fill,
      lines: override?.lines ?? wl.lines,
      arrows: override?.arrows ?? wl.arrows,
    };
  }
  return { fill: wl.fill, lines: wl.lines, arrows: wl.arrows };
}
```

paint property（fill opacity、line dash、arrow color、minor color 等）全改從 `getActiveStyle(layer).xxx` 取。

### 9.4 StylePopover — 讀寫路由 + 重設按鈕

- 多接 `sourceLayer?: VectorLayer` prop（從 source 拿 sub 元資訊算 defaults）
- multi-variant 模式：
  - **讀**：`subOverride?.fill ?? subDefaults.fill ?? { mode: 'none' }`，lines/arrows 同理
  - **寫**：更新到 `substanceStyles[activeSubId]`，不要碰 `wl.fill / wl.lines / wl.arrows`
  - 加「當前物質 X / 重設預設」banner（重設鈕在無 override 時 disabled）

App.tsx render StylePopover 時順手 lookup：
```tsx
const sourceLayer = layer.waterLevel?.sourceLayerId
  ? layers.find((l) => l.id === layer.waterLevel!.sourceLayerId)
  : undefined;
```

### 9.5 computeContourKey 納入 substanceStyles

```ts
return JSON.stringify({
  fill: wl.fill ?? null,
  lines: wl.lines ?? null,
  arrows: wl.arrows ?? null,
  substanceStyles: wl.substanceStyles ?? null,  // 新增
  // ... 其他既有
});
```

漏掉的話改 fill bands 不會觸發 rebuild — bug 會偽裝成「設定無效」很難 debug。

### 9.6 行為注意

- 切換 active variant 仍不重建（filter 變化），跟 Step 8 一致
- 但**改 substanceStyles 必須 rebuild**：fill bands 的顏色已 baked 到 feature `__color` property
- 「重設預設」清掉 entry 後，rebuild 走 fallback 到 `makeXxxDefaultsForSub`，使用該 variant 當下的 controlConc/monitorConc 推算

## 不要做的事

- **不要**為每個變數建獨立圖層後再硬塞回一個 `Map<id, Layer>` — 直接走合併 features + filter 才能享受 maplibre 的硬體加速切換
- **不要**用 variant.name 當 feature tag — 改名會 break；務必用 stable id
- **不要**忘了 source 圖層的設定變動（如 controlConc）需要觸發 contour re-sync。在 `App.tsx` 的 `updateLayer` 把 `'<configField>' in patch` 也加進 `syncContoursForSource` 觸發條件
- **不要**讓 `setActiveSubstance` 改 layer name；切變數對 panel 顯示應該無影響（除了 active 高亮）
- **不要**在 MapView filter 串接時忘了 `subFilter` null 時的 fallback 路徑（單變數圖層沒有 activeSubstance）
- **不要**讓 `wl.fill` / `wl.lines` 成為 multi-variant 圖層的「主要儲存」— 應該用 `substanceStyles[id]` 做 per-variant；`wl.fill` 在 multi-variant 模式只剩「無覆寫時的 fallback」角色
- **不要**把 `makeXxxDefaultsForSub` 留在 contour.ts 內部 — Step 9.2 須 export，因為 StylePopover (Step 9.4) 也要用它算 default fill bands
- **不要**忘記 StylePopover 在 multi-variant 模式下需要拿到 source layer（Step 9.4 的 `sourceLayer` prop）— 沒有它就讀不到 monitorConc / controlConc，無法算 fallback fill bands
