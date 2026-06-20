---
name: gis-add-attr-tab
description: Add a new attribute table tab. Implemented tabs = 水文監測 / 地下水濃度監測 / 土壤濃度監測; remaining disabled placeholders = 土壤氣體濃度監測 / 土壤氣體濃度快篩 / 其他. Sets up the per-feature data store, header bar, table layout, optional generation pipeline (contour OR point-exceedance), and persistence. Use when user says "新增 XXX 監測分頁" or "把 OOO 分頁從佔位變成實際功能".
---

# 新增屬性表分頁

GIS 屬性表已實作「主屬性表 / 水文監測 / 地下水濃度監測 / 土壤濃度監測」，外加 3 個 disabled 佔位（土壤氣體濃度監測 / 快篩 / 其他）。要把佔位變成實作（或全新 tab），照這個流程做。

## 前置決策（先問使用者）

1. **資料形狀**：每筆 feature 上要存什麼？
   - 水文監測的範本：`properties.__hydro = { '日期': 量測深度 }`
   - 濃度類分頁（有日期+內插）：`properties.__gwConc = { tabId: { subId: { '日期': 濃度 } } }`
   - 濃度類分頁（無日期，分批）：`properties.__soilConc = { tabId: { subId: 濃度 } }`，批次走 feature 屬性 `批次名稱`
   - 鍵名前綴 `__` 開頭，避免跟使用者屬性混淆
2. **是否要日期維度**：水文/地下水監測需要；**土壤/氣體類採樣具破壞性、單次採樣 → 不要日期**，改用「批次」分組（見下）
3. **要產生哪種圖層？兩條 pipeline 二選一**：
   - **等值線（內插）** → 走 [gis-multi-variant-contour-layer]，適合地下水位/濃度（連續面）
   - **點位超標圖（非內插，逐點分級著色 + 每批不同形狀）** → 走 **[gis-point-exceedance-layer]**，適合土壤/氣體（破壞性採樣、分批、無時間序列）
4. **單位**：濃度 mg/L、土壤 mg/kg、氣體 ppm 等 — 影響 hint 文字

## Step 1 — 擴充類型

`src/types.ts`：
```ts
export interface VectorLayer {
  // ...
  hydroDates?: string[];          // 既有
  <newDataKey>Dates?: string[];   // 新分頁的日期清單存這裡
}
```

如果要產生面（contour-style）：擴充 `waterLevel` 或新增類似的 `<newAnalysis>` 結構。**通常複用 `waterLevel` 即可**（內插邏輯一樣，差別只在資料來源欄位）。

## Step 2 — 把佔位 enable

`src/AttributeTable.tsx` 找 `dock-tab-menu-item disabled`：
```tsx
<button className="dock-tab-menu-item" disabled title="即將推出">
  <span>地下水濃度監測</span>
  <span className="dock-tab-menu-hint">即將推出</span>
</button>
```

改成 enabled，並加 onClick 開啟分頁狀態：
```tsx
<button
  className="dock-tab-menu-item"
  disabled={!onlyPoints || gwConcOpen}
  onClick={() => { setGwConcOpen(true); setActiveTab('gw-conc'); setTabMenuOpen(false); }}
>...</button>
```

新增對應的 `useState`：`const [gwConcOpen, setGwConcOpen] = useState(...)`

## Step 3 — 建立 Tab Panel JSX

仿造 `activeTab === 'hydro'` 的整段，框架：
```tsx
{activeTab === 'gw-conc' && (
  <div className="hydro-view">  {/* 沿用 hydro-view 的 flex 佈局 */}
    <div className="hydro-formula">  {/* 頂端框 */}
      <span className="hydro-formula-label">公式</span>
      <code>{/* 視情況：濃度本身就是量測值，可顯示「採樣濃度」之類的描述 */}</code>
      <button className="btn xs" onClick={() => setAddingDate(v => !v)}>+ 日期</button>
      <div className="hydro-formula-actions">
        {/* 生成紀錄表 / 匯入紀錄表 按鈕 */}
      </div>
    </div>

    <div className="table-wrap">
      <table className="attr-table hydro-table">
        <thead>
          <tr>
            <th rowSpan={2} className="row-num hydro-frozen hydro-frozen-num">#</th>
            <th rowSpan={2} className="hydro-frozen hydro-frozen-name">名稱</th>
            {/* 不需要「高程」就拿掉，但記得改 hydro-frozen-name 的 left/width 邏輯 */}
            {/* 日期欄迭代 */}
          </tr>
          <tr>{/* 第二列：每個日期下面的子欄（深度/水位 → 改成你的指標） */}</tr>
        </thead>
        <tbody>{/* 每筆 feature 一列 */}</tbody>
      </table>
    </div>

    <div className="hydro-bottom-bar">  {/* 必須在 .table-wrap 之外！否則會跟著水平捲動 */}
      {/* 模型下拉 + 生成 ICON + 單位提示 */}
    </div>
  </div>
)}
```

關鍵 CSS class（已存在於 App.css，沿用即可）：
- `.hydro-frozen` / `.hydro-frozen-num` / `.hydro-frozen-name` / `.hydro-frozen-elev` — 凍結欄
- `.hydro-date-th` / `.hydro-date-th-inner` / `.hydro-date-label` — 日期欄頭部
- `.col-gen` / `.col-del` — 日期欄上的小 ICON 按鈕
- `.hydro-bottom-bar` / `.hydro-model-label` / `.hydro-model-select` / `.hydro-gen-btn` — 底部
- `.cell-input` / `.editable` — 可編輯儲存格

## Step 4 — 連到 contour pipeline（若要產生面）

如果要做「濃度等值面」，最節省工的做法是**複用 `waterLevel` 結構**，但把 sample collection 改寫一份：

`src/contour.ts` 可加一支 `collectConcSamplesForDate(layer, date, substance?)`，仿 `collectSamplesForDate` 但讀 `properties.__gwConc[date]` 而非 `__hydro[date]`。

或者更乾淨：抽象化一個 `collectSamples(layer, date, valueExtractor)` 高階函式，同一個 contour pipeline 多種資料來源。

**非日期維度也能整條重用（土壤污染調查實證 2026-06-21）**：分頁的維度若不是日期（例如「深度層」），把該維度的值**當成 date 字串**塞進 `waterLevel.dates`/`activeDate`、`rebuildContourLayer` 加一個 `sourceKind` 分支（仿 isSingleGwConc，arrows 強制關），就能**零改動**重用 MapView 的等值線渲染與 LayerItem 的日期切換器（變成深度切換器）。只要再加一支對應的 `collect…SamplesFor<維度>` 取樣函式即可。3D 體積/面積另走 `src/iso3d.ts`（`buildSurveyVolume` 共用規則格網：分級色帶切片、缺層垂向內插、`turf.difference` 障礙物挖空、堆疊 vs 體素雙體積）。

`buildContourLayerFeatures` / `rebuildContourLayer` 內部呼叫的 `collectSamplesForDate` 改用 valueExtractor 注入。**注意這是 breaking change，要全檔搜尋所有 caller**。

## Step 4.5 — 過濾 `__newDataKey` 不被外露為主屬性表欄位

**重要！容易漏掉**：`AttributeTable` 的 `columns` useMemo 從 `feature.properties` 收集所有 key 當欄位顯示。`__hydro`/`__gwConc` 之類內部 key 必須手動排除：

```ts
const columns = useMemo(() => {
  const set = new Set<string>();
  for (const f of layer.data.features) {
    for (const k of Object.keys(f.properties ?? {})) set.add(k);
  }
  set.delete('名稱');
  set.delete('高程');
  set.delete('__hydro');
  set.delete('__gwConc');
  set.delete('__<newDataKey>');  // ← 加這行
  // ...
}, [layer.data]);
```

否則新分頁建立後，主屬性表會冒出一個 `__<newDataKey>` 欄位顯示 JSON 化的整個物件。

## Step 4.6 — Tab 層級 vs sub-tab 層級資料切分

水文監測：`hydroDates` 在 layer 層級（單一污染物隱含）。
地下水濃度監測：dates 在 **tab 層級**（同實例所有污染物共用），values 在 **sub-tab 層級**（每個污染物獨立）。

決策原則：
- 「一份報告」屬於 tab 層級（label / dates）
- 「該物質的設定值」屬於 sub-tab 層級（管制濃度 / 監測濃度 / 單位）
- 「採樣值」屬於 feature 層級（`__newDataKey[tabId][subId][date]`）

新增污染物時自動繼承 `tab.dates`（讀同一個來源即可，不用複製）。

## Step 4.7 — 頂層 trash 共用模式

不要每個 tab 各自掛 × 關閉鈕（密集且容易誤按）。改成：
1. 在每個 tab 第一行內容列右側放一個共用的 trash icon（紅色，`margin-left: auto`）
2. 在 `AttributeTable` 內定義一個 `trashButton` JSX 變數，三個 tab（主屬性表 / 水文監測 / 地下水濃度監測）的第一行都插入它
3. 點擊根據 `activeTab` 派發到對應的 `delete<Hydro|GwConc...>Tab()` handler
4. `activeTab === 'main'` 時加 `cursor: not-allowed` 樣式表示不可刪
5. 若該 tab 有 sub-tab 拖曳刪除需求（如 gw-conc 的污染物），同一個 trash 也接 `onDragOver/onDrop` 處理

CSS：`.dock-tab-trash { margin-left: auto; ... }` + `.dock-tab-trash.active { cursor: pointer }` + `.dock-tab-trash.armed/.drag-over { ... }` 三段狀態。

## Step 5 — 持久化

`hydroDates` 已經自動 round-trip（idb-keyval 序列化整個 layers 陣列）。新分頁的 `<newDataKey>Dates` 加到 `VectorLayer` 介面後**自動跟著序列化**，無需動 `persistence.ts`。

但要注意：
- **`ensureNames`** 在 load 時會被叫一次，遍歷 features.properties；它會 spread 整個 properties，所以 `__newDataKey` 會被保留 — OK
- **`syncAllContours`** 只處理 `waterLevel` 圖層；如果新分頁產生的不是等水位線而是別的結構，要同步加類似 sync 函式
- **`updateLayer`** 在 App.tsx 偵測 `'data' in patch` 時 sync contour；若新分頁的設定改動（如 controlConc）會影響 contour（如 threshold lines），要把該欄位也加進 trigger 條件，例如 `'data' in patch || 'gwConcTabs' in patch`

## Step 6 — LayerItem 顯示調整（可選）

`src/LayerItem.tsx` 目前對 contour 圖層（有 `waterLevel`）顯示展開鈕，對非 contour 點圖層顯示 `▤` 屬性表按鈕。

如果新分頁需要在 LayerItem 上有特殊 UI（例如顯示當前選中的物質、切換採樣場次），仿 `setActiveDate` / `setModel` 加 callback。

## Step 6.5 — Threshold 視覺高亮（可選，建議）

若新分頁的資料含 `controlConc` / `monitorConc` 雙門檻（gw-conc / 土壤 / 土壤氣體 都會），cell 與相關 UI 元件套 alert/warn 高亮 → 走 `gis-threshold-highlight` skill。摘要：

- Cell：`gw-conc-cell-alert` / `gw-conc-cell-warn` class
- LayerItem 物質按鈕：`.water-level-sub-btn.alert` / `.warn`，會隨 `wl.activeDate` 自動重算
- 顏色固定：紅 `rgba(239, 68, 68, X)` / 橘 `rgba(249, 115, 22, X)`

## Step 7 — 更新 project memory

寫完後在 `C:\Users\hao80\.claude\projects\D--Claude-code\memory\gis_project_status.md` 把該分頁從「未完成」搬到「已完成」，順手記錄資料形狀與重要設計決策。

## 不要做的事

- **不要**把 bottom bar（模型 + 生成 ICON + 單位）放在 `.table-wrap` 內 — 會跟著水平捲動
- **不要**用 `position: sticky` 在 `.editable` cell 而沒處理 specificity — `.attr-table td.editable { position: relative }` 會蓋掉，要用 `td.<frozen-class>` 雙 class 提升優先級
- **不要**對表格欄位省略 explicit width — `table-layout: fixed` 下欄位會被擠成 0
- **不要**在新分頁的 model dropdown 漏掉 IDW / TIN / Kriging（如果有走 contour pipeline，三種都要支援）
- **不要**忘了把 `__<newDataKey>` 加進 main 屬性表的 `columns` 排除清單（見 Step 4.5），不然會外露成 JSON 欄位
- **不要**為每個 tab 各自掛 × 關閉鈕，改用共用 trash 派發（見 Step 4.7）
