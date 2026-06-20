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
`preview_eval` 跑 IIFE：找按鈕點開（`▤` 屬性表、`.dock-tab`、`.hydro-bottom-bar button` 等）、讀文字斷言。
- 控制元件多是 React controlled input → **不能只設 `.value`**（commit 讀不到 state）；要嘛 `.click()` checkbox/button，要嘛用 `preview_fill`。
- `preview_console_logs {level:'error'}` 收尾確認無錯。

## Step 6 — 清理（每次都要做）
1. `preview_stop`
2. `vite.config.ts` proxy 改回 `:8000`
3. 砍 8011：`netstat -ano | grep 127.0.0.1:8011 | grep LISTENING` 取 PID → `taskkill //PID <pid> //F`
4. `rm -f server/_devverify.py /c/Users/hao80/AppData/Local/Temp/gis_devverify.db`
5. 確認 `dist/` 還是上一個正式版（`curl -s localhost:8000/ | grep -oE 'index-[A-Za-z0-9_-]+\.js'`）、正式 server 還活著

## 完成後上線（若要）
`git commit`/`push` →（在 GIS root）`packaging\deploy.bat`（build 到 dist_new→換檔、保留 dist_prev）；壞了 `packaging\rollback.bat` 秒退。見 [[webapp-google-auth-backend]] 的部署段。
