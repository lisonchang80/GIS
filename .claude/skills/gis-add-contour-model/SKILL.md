---
name: gis-add-contour-model
description: Add a new interpolation model (e.g. RBF / Spline / Natural Neighbor) to the GIS contour pipeline. Touches types.ts, contour.ts, AttributeTable.tsx, LayerItem.tsx in coordinated fashion. Use when user says "新增 XXX 內插模型" or wants another option in the 模型 dropdown beside IDW / TIN / Kriging / Indicator.
---

# 新增 contour 內插模型

GIS 專案目前已有四種模型（IDW / TIN / Kriging / Indicator Kriging）。新增第五種時要同步改動 4 個檔案，這個 skill 把流程定下來。

## 前置決策（先問使用者）

1. **模型識別字串**（kebab-case）：例如 `'rbf'`, `'spline'`, `'natural'`
2. **顯示名稱**（中文 + 括號註）：例如 `RBF（徑向基函數）`
3. **預設參數**：是否需要使用者可調的超參數？多數情況用合理 defaults 就好，跟 Kriging 一樣

## Step 1 — 擴充 `model` union 類型

`src/types.ts` 的 `waterLevel.model`：
```ts
model?: 'idw' | 'tin' | 'kriging' | 'indicator' | '<新模型>';
```

**注意 ContourModel 同步**：`src/contour.ts` 同樣有 `export type ContourModel = ...`，要兩處都改。

## Step 2 — 在 `src/contour.ts` 實作 interpolator

格式參考既有的 `buildTinInterpolator` / `buildKrigingInterpolator`：

```ts
function build<NewModel>Interpolator(samples: IDWSample[]): (x: number, y: number) => number {
  // 1. 預處理：建構任何需要重用的資料結構（例如 Kriging 的反矩陣、TIN 的三角網）
  // 2. 邊界情況：sample 太少時 fallback 回 idw
  // 3. 回傳 closure：吃 (x, y) 回傳 z
  return (x, y) => { /* ... */ };
}
```

關鍵注意：
- **Fallback 策略**：query 點落在資料邊界外時的處理方式（TIN 用凸包外 fallback IDW；Kriging 直接外推；新模型自行決定）
- **複雜度**：grid 為 50×50 = 2500 query × N samples。預先計算可重用的結構放在 closure 外（如 Kriging 的 `Minv`），不要每次 query 都重算
- **數值穩定**：矩陣可能 singular（重複樣本、共線等），需要 fallback。invertMatrix 已回傳 `null`，可以直接判斷

## Step 3 — 接進 `makeInterpolator` 工廠

`src/contour.ts` 的 `makeInterpolator`：
```ts
function makeInterpolator(model: ContourModel | undefined, samples: IDWSample[]) {
  if (model === 'tin') return /* ... */;
  if (model === 'kriging' || model === 'indicator') return /* ... uses kriging */;
  if (model === '<新模型>') {
    const f = build<NewModel>Interpolator(samples);
    return (x, y) => f(x, y);
  }
  return (x, y) => idw(x, y, samples);
}
```

### 範例：Indicator Kriging 怎麼接的

Indicator 模式不是獨立 interpolator，而是「資料前處理 → Kriging → 後處理」。前處理在 `buildIDWGrid` 內：
```ts
if (model === 'indicator') {
  const t = opts.indicatorThreshold ?? 0;
  workingSamples = samples.map((s) => ({ ...s, z: s.z > t ? 1 : 0 }));  // 二元化
}
// ... interpolate
if (model === 'indicator') z = Math.max(0, Math.min(1, z));  // 後處理 clamp [0,1]
if (model === 'indicator') return { grid, zMin: 0, zMax: 1 };  // 強制範圍
```

新模型如果也需要前/後處理（例如 log-transform 已支援），同樣可以走這個 pattern，不必另寫 interpolator。

## Step 4 — UI 下拉新增選項（兩處）

兩處要同步加：

**A. `src/AttributeTable.tsx`**：
- 找 `useState<'idw' | 'tin' | 'kriging' | 'indicator'>` → 擴充 type（注意水文監測 useState 不含 indicator，gw-conc 才有；按使用脈絡判斷）
- 找 `<select>` 內的 `<option>` → 加新選項
- `setContourModel(e.target.value as ...)` cast 同步擴充

**B. `src/LayerItem.tsx`**：
- 找 `setModel = (model: 'idw' | 'tin' | 'kriging' | 'indicator')` → 擴充 type
- 找 `<select className="water-level-model-select">` → 加 `<option>`
- 注意 LayerItem 的 indicator option 目前用 `{isMultiSub || wl.sourceKind === 'gw-conc' ? <option> : null}` 條件渲染，新模型若同樣只用於某種 sourceKind，可以仿這個 pattern

## Step 4.5 — `ContourOptions` 與 threshold 線

`src/contour.ts` 已有：
```ts
export interface ContourOptions {
  logTransform?: boolean;
  clampNegative?: boolean;
  indicatorThreshold?: number;
}

export interface ThresholdLine {
  value: number;
  kind: 'control' | 'monitor';
  label: string;
}
```

新模型如果需要：
- **新的 boolean 開關**（如「半變異函數自動擬合」）：擴充 `ContourOptions`，在 `buildIDWGrid` 讀；`waterLevel` struct 增同名欄位；`computeContourKey` 加進去；`rebuildContourLayer` 把 `wl.<newOpt>` 塞進 `contourOpts`
- **threshold 線（如「平均線 / 中位數線」）**：走 `__line: 'threshold-<kind>'` 的 pattern，MapView 的 `lineColor` / `lineWidth` / `lineDashExpr` match 表達式三處都要加 case；`buildContourFeaturesForLayer` 接 `thresholds?: ThresholdLine[]` 額外參數

## Step 5 — 驗證

1. 啟動 preview server，建一個多日水文監測 → 用新模型 generate → 等水位線應該正確顯示
2. 切換到其他模型再切回，等水位線會 re-sync（`computeContourKey` 已涵蓋 `model`）
3. 若新模型 query 慢（如 Kriging 大樣本），考慮在 syncContoursForSource 之前顯示 spinner（目前無此機制，可暫不處理）

## 不要做的事

- **不要**改 `buildIDWGrid` 的 grid 建構邏輯（cellSize、bbox buffer 已 tuned）
- **不要**為新模型另建 grid 函式 — 走 `makeInterpolator` 工廠就好
- **不要**忘了 `buildFlowArrowsForLayer` 也要走相同 model（目前 `options.model` 已透傳，無需改動）
- **不要**忘了同步 `ContourModel` 兩處（types.ts 與 contour.ts），TypeScript 會給你錯但容易漏一邊
- **不要**把 `clampNegative` / `logTransform` 寫死在新模型內，這些是正交的 `ContourOptions`，由使用者切換
