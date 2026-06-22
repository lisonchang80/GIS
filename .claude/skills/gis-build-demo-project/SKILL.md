---
name: gis-build-demo-project
description: >
  Build a realistic, ready-to-import demo PROJECT (not a code feature) that showcases
  the GIS outputs against a real site — site boundary by land-number, groundwater
  concentration contours, water-level (等水位線)/flow, soil exceedance points, and the
  3D vertical survey. Workflow = generate source layers via a Python seed → PUT to the
  isolated dev backend → drive the UI to click the 生成 buttons (contour/exceedance/
  等水位線) → GET the full project → tidy (rename/reorder/visibility) → write
  examples/<name>.json. Trigger: "做一個 XXX 範例/示範專案", "依 OO 報告做示範",
  "弄個可匯入的 demo". Builds on gis-isolated-preview-verify for the backend.
---

# GIS：建立擬真示範專案（可匯入 JSON）

交付物 = **一個可在 App「匯入專案」直接載入的 ProjectState JSON**（放 `examples/`）。
不是改 code。衍生圖層（等濃度線/等水位線/超標圖）由 App 的「生成」鈕產出 → 無法純手寫，
必須在隔離環境裡跑 UI 生成，再從後端 GET 整包帶走。已用於台南安順場址示範（examples/）。

## 流程總覽
1. 寫 Python seed → 產生 **來源圖層**（點/多邊形 + 各監測分頁 + 每點數值）→ PUT 到 :8011。
2. 開 preview，逐圖層開屬性表 → 切到對應分頁 → 點「生成…」鈕產衍生圖層（自動存後端）。
3. `GET /api/projects/{id}` 撈整包（含衍生圖層）→ Python 整理（改名/排序/預設顯示/視野）。
4. 寫 `examples/<name>.json` + README + 保留 seed 產生器；隔離環境驗證「重新匯入」OK。
5. 拆掉隔離環境（見 [[gis-isolated-preview-verify]] Step 6），commit `examples/`。

## 資料 schema（手寫 seed 必對齊；feature.properties 內）
- **地下水濃度**：`__gwConc[tabId][subId][date]=number`；layer.`gwConcTabs=[{id,label,dates[],substances:[{id,name,controlConc,monitorConc,unit}]}]`。
- **土壤濃度（超標圖來源）**：`__soilConc[tabId][subId]=number` + 屬性 `批次名稱`(=`SOIL_BATCH_KEY`)；layer.`soilConcTabs=[{id,label,landUse,substances}]`。分級：v≥control→紅, ≥monitor→橙, else 綠。
- **土壤垂向（3D）**：`__soilSurvey[tabId][subId][depthKey]=number`，depthKey=`"%g"%深度`（"0","0.5"…，見 iso3d.buildDepthKeys）+ 屬性 `高程`；layer.`soilSurveyTabs=[{id,depthInterval,maxDepth,threshold,model,fillGaps,obstacles,substances}]`。
- **水位（等水位線/流向）**：layer.`hydroDates=[date]` + `__hydro[date]=水位埋深(m)`。**等水位線高程 z = 高程 − __hydro**（高程缺省 0 → z 變負/反相！）→ 一定要給每口井 `高程`，並令 `高程 = 目標水位高程 + 埋深`，水位才正確（內陸高、海側低＝流向海）。
- **標準參考**：`src/soilConcStandards.ts` / `gwConcStandards.ts`（汞土20/10·水0.02/0.01；五氯酚土200/200·水0.08/0.04；戴奧辛土1000/1000 ng-TEQ/kg）。表內沒有的物質要自己填 controlConc/monitorConc。
- ProjectState：`{version:1, savedAt, basemapId, basemapOpacity, projectName, layers:[…], mapView:{center:[lng,lat],zoom}}`；import 只驗 `version===1` + `layers` 是陣列。

## 場址範圍照「地號」畫（真實地籍）
`src/landQuery.ts` 打 `https://twland.ronny.tw/index/search?lands[]=縣市,段名,地號`（逗號分隔，需 urlencode），回 GeoJSON。seed 內直接抓官方列出的地號當 `kind:'polygon'` 的場址圖層 feature（同段多筆連號通常相鄰）。
- **先去權威官方來源拿「地段名 + 地號清單」，別自己猜地段。** 真實污染場址多有政府公告頁（例：臺南市環保局土壤及地下水污染整治場址資訊 `epb2.tnepb.gov.tw/cpdc/.../mode02.asp?m=…`），裡面直接列出地段與每筆地號（廠區/熱點/已解除管制常分群）。先 WebFetch 該頁抓地號，再丟 twland API 驗證解析、算中心/面積定位。
- 慘痛教訓：安順那次**沒查官方公告就自己挑了「顯宮段」**去畫，整個偏 2.6km；官方實為**安南區鹽田段**（廠區 668 系列/669、海水貯水池 659 等、東側 544-2 等共 35 筆）。先抓官方地號才一次到位。維基/搜尋座標未必錯，但**地段名一定要照官方**。
- **非地籍/工業場址（油庫、廠區）找不到逐筆地號時 → 用 OSM 實際 footprint**：地號 API 反查農地段只會撈到周邊小地號、撈不到整塊工業地。改用 Overpass 抓該設施 polygon（`nwr[~"name"~"中油|油庫"](bbox);out center tags;` 找 way id → `way(id);out geom;` 取 ring），驗證名稱/地址後當場址範圍，README 揭露「以實際 footprint 定界、整治場址逐筆地號未公開」。湖西油庫即用 OSM way 508438551（~6.7ha）。⚠️ Overpass POST 用 urllib 會 406 → 直接把 ring 座標內嵌進 seed（別 runtime fetch，較穩）。座標→地號無公開 API，要定位設施就用 OSM/Nominatim 拿經緯度。

## 在 UI 驅動「生成」（preview_eval）
- 開圖層屬性表：點該 `.layer-item` 內 textContent==='▤' 的 `.icon-btn`。
- 切分頁：點 `.dock-tab`（文字含「地下水濃度監測 / 土壤濃度監測 / 土壤污染調查 / 水文監測」）。**切完要等一拍**再找該分頁的鈕（同一 tick DOM 還沒換）。
- 生成鈕（依分頁）：
  - 濃度/超標多物質一鍵：`.bottom-dock .gw-conc-gen-all`（「生成所有污染物…」）。
  - 等水位線單日：`button[title*="生成單日等水位線"]`；複日 `.hydro-gen-btn`。
- 3D：土壤污染調查分頁 → 文字「3D 體積」鈕（modal WebGL，截圖會 timeout，改讀 HUD/體積文字）。

## demo 數據設計坑（會被使用者逐格檢查，見 [[feedback-simulated-data-realism]]）
- **垂向 3D 的峰值別放太高**：等濃度線/逐層面積用 `turf.isobands`，當某層污染**整片超過閾值**（如 IDW 峰 9950、閾值 20）時 isobands 退化 → 面積亂跳/反相/體積錯。對策：把垂向場做成**內部封閉羽流**（峰值中等 ~90、四周有明顯背景<閾值的點界定範圍），逐層超標面積才單調收斂。表層抓樣（超標圖，純點不內插）才可放真實最高值。〔此為現行 iso3d 計算限制，非資料錯〕
- 各內插層、各深度層都要 **≥3 個有效點** 才生得出等值線。
- **2D 等濃度線：物質「峰值/監測標準」比別爆大**（湖西 MTBE 120 / 標準 1 = 120× → logTransform 在細網格畫出 2382 條 iso 線、單一物質就讓檔案 7MB）。比值控在 ~數十倍內等濃度線才乾淨（TPH 33/10≈3× 只生 33 條）。對策：內插場用**適中代表峰值**（真實高值寫進 README/屬性說明），或把該物質**移出等濃度線層**（tidy 時濾掉 `__substance` 並從 `waterLevel.substances` 拿掉，留在井屬性表＋超標圖）。導出後**檢查檔案大小**（正常 demo ~1-1.5MB，破 5MB 就是某物質爆 iso）。
- 跨視圖一致（[[feedback-cross-view-consistency]]）：同一份資料 2D/3D 著色要一致；所有模型/選項都要真生效。

## 整理（GET → tidy → 寫檔）
衍生圖層**自動命名**（如「SGS… 多污染物 2024-11-20」「2024-11-20」）很醜 → GET 後用 Python 改名、重排（點在上、線等值線中、多邊形底）、設預設 `visible`（首屏只開重點層）、設 `mapView`。偵測衍生層：gw-conc 等濃度線 `waterLevel.sourceKind==='gw-conc'`；等水位線 `kind==='line' && waterLevel && !sourceKind`；超標圖 `layer.exceedance`。**cp950 console 印中文會炸**（檔案已寫成功，只是 print 失敗）→ 用 `io.TextIOWrapper(sys.stdout.buffer,'utf-8')` 或別印中文。

## 驗證 / 交付
- 最終一定要**把產出的 JSON 當新專案重新匯入**（POST+PUT 或 App 匯入）再 reload，確認 8 層順序/預設顯示/legend/無 console error。
- 無 code 變更 → 不必 deploy；commit `examples/`（JSON + README + seed 產生器）即可。
- 截圖會因 maplibre/WebGL timeout → 一律讀 DOM / 後端 features 數量佐證（band 數、分級數、體積、z 範圍）。
