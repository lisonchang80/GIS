---
name: gis-point-exceedance-layer
description: Build a non-interpolated "point exceedance map" layer — per-feature classified against control/monitor standards, symbolized by colored point shapes, grouped by a per-feature batch attribute. Use this (NOT the contour pipeline) when sampling is destructive / one-shot so there is no time series and no spatial interpolation — e.g. 土壤濃度監測 (done), 土壤氣體濃度監測 / 快篩 (placeholders). Covers the batch data model, exceedance.ts engine, non-SDF recolorable point-shape icons in MapView, batch toggles in LayerItem, and the batch-grouped Legend. Trigger: "做成點位超標圖 / 不要等值線 / 分批採樣 / 每批不同點位".
---

# Point Exceedance Layer (non-interpolated)

When a monitoring tab's samples are **destructive / one-shot** (soil, soil-gas), you do NOT resample the same point, so there is **no date axis and no interpolation**. Instead each sample point is classified against the substance's control/monitor standards and drawn as a colored point shape. Points are grouped by a per-feature **batch** attribute (each batch = a different set of points). This is a separate pipeline from `gis-multi-variant-contour-layer` (which interpolates).

Reference implementation = 土壤濃度監測 (soil-conc). Files: `types.ts`, `soilConcStandards.ts`, `exceedance.ts`, `pointShapes.ts`, `ShapeSwatch.tsx`, `ShapePicker.tsx`, `AttributeTable.tsx` (SoilConcTabPanel), `MapView.tsx`, `LayerItem.tsx`, `Legend.tsx`, `LayerIcon.tsx`, `App.tsx`.

## Data model (types.ts)
- Tab: `XxxConcTab[]` on VectorLayer, with `landUse?` + `activeBatch?` but **no dates**. Substances reuse `GwConcSubstance` (controlConc/monitorConc/unit).
- Concentration store: `feature.properties.__xxxConc[tabId][subId] = number` (NO date level — parallel to `__gwConc` but one level shallower).
- Batch is a **per-feature attribute** with a fixed key constant (e.g. `SOIL_BATCH_KEY = '批次名稱'`). One point belongs to one batch; batch list = distinct values among point features.
- Generated layer config: `VectorLayer.exceedance: ExceedanceConfig` with `sourceLayerId/sourceTabId`, `sourceSubId | substances+activeSubstance`, **`batches: {name, shape, visible}[]`**, `colors/showOk/showNodata/radius/legend`. NO dates/activeDate.

## exceedance.ts engine
- `classifyExceedance(v, control, monitor) → 'alert'|'warn'|'ok'|'nodata'`.
- `readXxxConc(f, tabId, subId)` (no date).
- `batchOf(f)` / `collectBatches(layer)` — distinct non-empty batch names in feature order.
- `buildExceedancePoints(source, tab, subs)` — per point × substance, bake `__batch / __substance / __substanceName / __exLevel / __conc / __unit`.
- `reconcileBatches(existing, names)` — preserve known batch shape/visible, assign `shapeForIndex(i)` to new batches.
- `rebuildExceedanceLayer` + `syncExceedanceForSource(layers, sourceId)` + `syncAllExceedance(layers)` — parallel to the contour sync. Wire into App: `updateLayer` triggers on `'xxxConcTabs' in patch`, chain `syncExceedanceForSource(syncContoursForSource(next, id), id)`; load/import use `syncAllExceedance(syncAllContours(...))`; handleMapPick chains too.

## Point shapes — **MUST be non-SDF** (critical gotcha)
maplibre **SDF symbols round sharp corners and blur thin strokes** → only circle and square look right; triangles/stars/cross/hollow all break. So DO NOT use `addImage(..., {sdf:true}) + icon-color`.
Instead (`pointShapes.ts`):
- `drawShape(ctx, shape, size, fill, stroke?, strokeW?)` draws the shape on canvas with **fill + outline baked in** (sharp). Solid shapes: fill then stroke. Line/hollow shapes (cross/x/wye/ring/*-hollow/target): under-stroke wider in stroke color then narrower in fill (gives a halo edge).
- `ensurePointIcon(map, shape, fill, stroke, strokeW)` → registers a **non-SDF** `addImage(id, imageData, {pixelRatio:1})` keyed `pt|shape|fill|stroke`, cached (colors are limited: 4 exceedance levels + per-layer color).
- MapView dual path: `useSymbol = !!exceedance || (pointShape && !== 'circle')`. Symbol layer `icon-image` = nested match: `['match', ['get','__batch'], ...batch→levelExpr(shape), levelExpr('circle')]` where `levelExpr(shape) = ['match', ['get','__exLevel'], 'alert', pointIconId(shape, alertColor, white), ...]`. `icon-size = 2*pointR/(SHAPE_IMG_SIZE*SHAPE_DRAW_RATIO)`, `icon-allow-overlap:true`, NO icon-color/halo (baked). Keep the plain `circle` layer for default point layers (cheaper, crisp).
- `ShapeSwatch.tsx` (canvas preview reusing drawShape) + `ShapePicker.tsx` (graphical shape dropdown — a native `<select>` cannot show shapes). Use ShapePicker in LayerItem per batch and the 20-cell grid in StylePopover. `LayerIcon` for plain point layers returns `<ShapeSwatch shape={pointShape} color={color}>` so the panel icon matches the map.

## Tab panel (AttributeTable SoilConcTabPanel)
- Header: 機構/批次 + 用地類別 + **批次名稱 dropdown** (replaces the date axis; scopes the edit grid to one batch's points) + 匯入報告 + 多污染物生成 + trash.
- Grid = points of active batch × single concentration column (active substance), with `gis-threshold-highlight` cell classes.
- On tab creation: add the batch attribute column to all features (empty string), `window.alert` warning, then **force `setActiveTab('main')`** so the user fills batch names first. If no batches exist yet, show a prompt instead of the grid.
- Generate buttons build the exceedance layer via `buildExceedancePoints` + `reconcileBatches([], collectBatches(layer))`.

## LayerItem expand + Legend
- LayerItem exceedance expand: substance buttons + **batch list** (checkbox toggle visibility + ShapePicker per batch) + showOk/showNodata/legend toggles. Hidden batches filtered out via `['!', ['in', ['get','__batch'], ['literal', hidden]]]` (also applied to the label filter).
- Legend (Legend.tsx ExceedanceLegendCard): **grouped by batch**. Each batch name is a sub-heading; under it list that batch's shape tinted red/yellow/green, **only for levels actually present** in that batch for the active substance (compute presence by scanning `layer.data.features` filtered by `__substance`, collecting `__batch × __exLevel`). Level wording is threshold-based: `≥ {control} {unit}（超管制標準）` / `≥ {monitor} {unit}（超監測標準）` / `< {monitor} {unit}（低於監測標準）`. Respect showOk/showNodata.

## Main-table add-points ("+ 點位")
Soil-style tabs need many points across batches. AttributeTable main tab has a `+ 點位` menu: 手動座標 (inline form) / 地圖點選 (App `addPointTarget` state + pickMode, handleMapPick append branch) / 載入檔案 (fileToGeoJSON+ensureNames, append point features). `appendPointFeatures` adds the empty batch attribute when the layer has the tab.

## Standards table
New `xxxConcStandards.ts` mirroring `gwConcStandards.ts`: `lookupXxxStandard(name, landUse?)` returning {controlConc, monitorConc, unit}. Soil has farmland/general two-tier for metals; keep the "values are reference defaults, verify against latest公告" disclaimer.
