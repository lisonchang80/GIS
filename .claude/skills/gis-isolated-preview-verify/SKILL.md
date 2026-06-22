---
name: gis-isolated-preview-verify
description: >
  Verify a GIS frontend change in a real browser WITHOUT touching the live public
  server (:8000) or the production dist/. Spins up an isolated FastAPI backend on
  :8011 (dev-login + temp SQLite), points the vite dev proxy at it, seeds a project
  via the API, drives the UI with the preview MCP tools, then tears everything down.
  Trigger: "驗證 / 在瀏覽器測 / preview / 看看跑不跑得起來" on any change to the GIS
  React app (src/), especially survey/contour/3D features behind the Google login gate.
---

# GIS：隔離 preview 驗證流程

GIS 前端在 Google 登入 gate 後面，正式站(:8000)的 dev-login 是關的、又直讀 `dist/`，
所以**不能**直接拿正式站驗、也**絕不能** `npm run build`/`vite build`（會即時上線未驗證碼）。
這套流程在 **:8011 開一個隔離後端 + vite dev**（記憶體、不碰 dist），驗完整個拆掉。

## 致命前提（最容易出事）
- **驗證一律用 vite DEV server**（preview_start，記憶體）。**絕不 `vite build`** — 預設寫 `dist/`＝正式站 StaticFiles 即時讀到＝把未驗證碼推上線（本人踩過一次，靠 `git stash`+重建已驗證版回滾）。
- 要看 **production build** 是否過、chunk 切割對 → `npx vite build --outDir dist_verify --emptyOutDir` 然後 `rm -rf dist_verify`（throwaway，不碰 `dist/`）。
- **preview_screenshot 會在 WebGL 卡死 30s timeout**（Three.js rAF loop、有時連 maplibre 也會）→ 改用 `preview_eval` 量 DOM 文字（legend / 體積 / chip / headers）驗證。
- ⚠️ **背景 launcher 進程會殘留**：用 run_in_background 起的 :8011，即使該 task 之後顯示 failed，uvicorn 仍可能在背景 LISTENING；下次再起會 bind 失敗（`WinError 10048` 通訊端位址只能用一次）。靠 `netstat -ano | grep 127.0.0.1:8011` 看實際 LISTENING PID，**只 kill 自己起的那個**——並行可能有人（使用者）也在用 :8011，別亂砍不是自己起的 PID。
- ⚠️ **並行編輯**：使用者可能同時在改同一個 repo（會直接 commit/push 你的改動、改回 `vite.config.ts`、甚至佔用 :8011）。動手前先 `git status` 看現況；別假設工作區只有你動過。

## Step 1 — 暫時把 vite proxy 指到 8011
`vite.config.ts`：`'/api': { target: 'http://localhost:8011' }`（原本 8000，**驗完一定要改回**）。

## Step 2 — 隔離後端 launcher
建 `server/_devverify.py`（throwaway，驗完刪）：
```python
import os, tempfile
from pathlib import Path
os.environ["GIS_DEV_LOGIN"] = "1"        # 開 dev-login 後門
os.environ["GIS_COOKIE_SECURE"] = "0"    # http localhost 才存得了 cookie
from server import db                     # noqa: E402
db.DB_PATH = Path(tempfile.gettempdir()) / "gis_devverify.db"  # 暫存 DB，不碰 server/gis.db
try: db.DB_PATH.unlink()
except FileNotFoundError: pass
if __name__ == "__main__":
    import uvicorn
    uvicorn.run("server.main:app", host="127.0.0.1", port=8011, log_level="warning")
```
跑：`"server/.venv/Scripts/python.exe" -m server._devverify`（背景；從 GIS root 跑，`-m` 才吃得到 `server` 套件）。
- **重點**：`db.DB_PATH` 與 `routes.py` 的 `GIS_DEV_LOGIN`/`GIS_COOKIE_SECURE` 都在 import 時讀，所以 env + DB_PATH 要在 `uvicorn.run` 之前設好。
- ⚠️ **啟動 race**：backend 剛起來時**第一個 API 請求常失敗**（POST 回沒有 `id`、PUT 422/405）→ `sleep 2~3` 再打，或失敗就重試一次。
- ⚠️ **`cd … && cmd &` 的 `cd` 只進背景子殼**：同一個 Bash 呼叫裡，背景指令之後接的**前景**指令（如 seed）會在工具預設 cwd（非 GIS）跑 → 噴「No such file」。每條前景指令自己帶 `cd "/d/Claude code/GIS" && …`。

## Step 3 — 用 API 灌種子專案（免手動點）
用 cookiejar 保 session：dev-login → POST `/api/projects` 拿 id → PUT `/api/projects/{id}` 整包 ProjectState。
```python
import json, urllib.request, http.cookiejar
cj = http.cookiejar.CookieJar()
op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))
op.open(urllib.request.Request("http://127.0.0.1:8011/api/auth/dev-login", method="POST"))
pid = json.load(op.open(urllib.request.Request(
    "http://127.0.0.1:8011/api/projects",
    data=json.dumps({"name":"v"}).encode(),
    headers={"Content-Type":"application/json"}, method="POST")))["id"]
op.open(urllib.request.Request(f"http://127.0.0.1:8011/api/projects/{pid}",
    data=json.dumps(project).encode(), headers={"Content-Type":"application/json"}, method="PUT"))
```
- `project` 必含 `version: 1` + `layers: [...]`（否則 loadProject 擋；422 多半是少 version 或 PUT 到不存在的 id）。
- **深度/日期 key 要對齊 app 格式**：survey 深度層 key 用 `"%g"%d`（整數不帶 `.0`，對齊 `buildDepthKeys`），否則整數層在 app 讀不到、表格顯示「-」。
- 想測缺層補估/障礙物等邊界，就在種子裡**故意**做（某層只放 1 點、塞一個 `obstacles:[{geometry,depthTop,depthBottom,enabled}]`）。

## Step 4 — 開 preview、切到該專案
`preview_start {name:"vite"}`（`.claude/launch.json` 已有 vite 設定，會在 5180 起）→
`preview_eval`：`localStorage.setItem('gis-current-project-id', String(pid)); location.reload()` →
`sleep 3` 等重載。

## Step 5 — 量 DOM 驗證（不要截圖）
- ⚠️ **量寬度前先 `preview_resize`**：preview 視窗預設 `innerWidth`≈0/極窄 → 側欄(320+)會吃滿、`.bottom-dock` 算出 0 寬、版面量測全錯。先 `preview_resize {width:1440,height:900}` 再量 panel/dock/responsive。
`preview_eval` 跑 IIFE：找按鈕點開（`▤` 屬性表、`.dock-tab`、`.hydro-bottom-bar button` 等）、讀文字斷言。
- 控制元件多是 React controlled input → **不能只設 `.value`**（commit 讀不到 state）；要嘛 `.click()` checkbox/button，要嘛用 `preview_fill`。
- `<select>`（如「模型」下拉）要觸發 React onChange：用原型 setter 再 dispatch —
  `const set=Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set; set.call(sel,'tin'); sel.dispatchEvent(new Event('change',{bubbles:true}))`。
- ⚠️ **React 非同步 render**：dispatch click 改了 state（開 StylePopover／切 dock-tab／按「生成等水位線」）後，DOM 要到**下一個 tick** 才更新 → **點擊與讀取拆成兩個 `preview_eval`**；同一個 IIFE 內點完馬上讀會讀到舊 DOM（popover 還沒掛上、回 `open:false`）。
- 開圖層 **StylePopover** = 點該圖層列的 `.layer-icon-wrap`（title「點擊以編輯樣式」）；讀預設值用 `.style-popover .popover-row` 逐列取 `.popover-label` + `input[type=range/color/checkbox/number]` + `select` + `.popover-value`（DashSelect 自訂元件無 value，要讀 `.dash-select svg line` 的 `stroke-dasharray`）。
- `preview_console_logs {level:'error'}` 收尾確認無錯。

## Step 5.5 — 驗 DOM 量不到的狀態（WebGL / Plotly / maplibre）
Three.js 幾何、Plotly gl3d 軸標、maplibre map 實例都**不在 DOM**，截圖又 timeout。手法：**暫時把該 JS 物件曝到 `window`，`preview_eval` 讀出量化驗證，commit 前移除**（標 `// TEMP-DEBUG`；移除後 `grep -rn '__名稱\|TEMP-DEBUG' src/` 確認清乾淨再 `tsc`）。實證三招：
- **3D 切片逐色面積**：Iso3DViewer 在 `vol` useMemo 後加 `(window as any).__iso3dVol = vol`。eval 用鞋帶公式(shoelace)算 `vol.slices[k].bands[].polysM` 各色面積（polysM 已是本地公尺直接比）。證「2D 等濃度線 vs 3D 切片著色一致」→ 逐深度逐色對到 ~1% 即一致；差很多多半是 **bbox 外擴比例**或 **interpolator** 不一致。
- **Plotly 軸真有套用**：gl3d 軸標在 WebGL，DOM 讀不到 → 讀 `gd._fullLayout.scene.xaxis.title.text`（`gd`＝`.iso3d-canvas` 子層中含 `_fullLayout` 者）。Plotly 3.x **字串 title 簡寫失效**，要 `title:{text}` 否則退回預設 x/y/z（踩過）。
- **maplibre 反應性/強制分支**：load handler 加 `window.__gisMap=map`；可 `__gisMap.isStyleLoaded=()=>false` 強制走 idle fallback，再 `__gisMap.panBy([3,0])` 觸發重繪→idle，驗 source 有無被同步（驗「改 state 後地圖沒更新」類 bug）。
- 純資料面：contour 圖層 band features 可直接 `fetch('/api/projects/{id}')` 撈 `data.features`（`__kind==='band'`/`__color`/`__date`）算面積/顏色，免碰地圖。

## Step 6 — 清理（每次都要做）
1. `preview_stop`
2. `vite.config.ts` proxy 改回 `:8000`
3. 砍 8011：`netstat -ano | grep 127.0.0.1:8011 | grep LISTENING` 取 PID → `taskkill //PID <pid> //F`
4. `rm -f server/_devverify.py server/_devseed.py /c/Users/hao80/AppData/Local/Temp/gis_devverify.db`（種子另存 `_devseed.py` 較好維護；連 TEMP-DEBUG 曝點一併確認移除）
5. 確認 `dist/` 還是上一個正式版（`curl -s localhost:8000/ | grep -oE 'index-[A-Za-z0-9_-]+\.js'`）、正式 server 還活著

## 完成後上線（若要）
`git commit`/`push` →（在 GIS root）`packaging\deploy.bat`（build 到 dist_new→換檔、保留 dist_prev）；壞了 `packaging\rollback.bat` 秒退。見 [[webapp-google-auth-backend]] 的部署段。
