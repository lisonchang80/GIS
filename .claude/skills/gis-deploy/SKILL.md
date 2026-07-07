---
name: gis-deploy
description: 把 GIS 的改動上線到正式站 https://gis.tinghaochang.com（本機 :8000 + 共用 cloudflared tunnel）。分兩條路：前端改動走 packaging\deploy.bat（build 到 staging→換 dist，免重啟）、後端 server/*.py 改動要「重啟 :8000 進程」才會生效。Trigger：部署 / 上線 / deploy / 讓其他人看到 / 把改動推到正式站 GIS。涉及 packaging\deploy.bat、packaging\autostart\gis_public.vbs、packaging\start_public.bat、server/。
---

# GIS 上線流程

正式站 = 本機 `python -m uvicorn server.main:app --port 8000`（服務 built `dist/` + `/api`），
公開網址由共用 `tinghaochang-sites` tunnel 轉到 :8000。**前端改動**與**後端改動**上線方式不同。

## 先判斷改了什麼
- 只動 `src/`（React 前端）→ 走 **A. 前端 dist 換檔**（server 直讀 dist，免重啟）。
- 動了 `server/*.py`（FastAPI / db）→ 走 **B. 重啟 :8000**（Python 程式只在啟動時 import，一定要重啟）。
- 兩者都動 → 先 A 再 B（或先 B 再 A，順序不拘，但兩步都要做）。

## A. 前端 dist 換檔
`packaging\deploy.bat`：typecheck → `vite build --outDir dist_new` →（`dist`→`dist_prev`，`dist_new`→`dist`）。
server StaticFiles 直讀磁碟，**換完立即生效、免重啟**。舊版留在 `dist_prev`，壞了 `packaging\rollback.bat` 秒退。
- ⚠️ **絕不直接 `npm run build`**：預設寫 `dist/`＝正式站即時讀到＝把未驗證碼推上線（要驗 production build 用 `--outDir dist_verify` 丟棄）。
- ⚠️ **最後一步 rename 可能 "Access is denied"**（Windows Defender 掃剛 build 好的檔／檔案 handle 短暫鎖）→ deploy.bat 會自動 `dist_prev`→`dist` 還原、**站不會掛**。此時 `dist_new` 已建好，用重試補完換檔即可：
  ```powershell
  # 從 GIS root；把 dist_new 換上，dist 退成 dist_prev
  function TryMove($a,$b){for($i=0;$i -lt 5;$i++){try{Move-Item -LiteralPath $a $b -Force;return $true}catch{Start-Sleep -Milliseconds 800}}return $false}
  if(Test-Path dist_prev){Remove-Item -Recurse -Force dist_prev}
  TryMove 'dist' 'dist_prev'; TryMove 'dist_new' 'dist'
  ```

## B. 重啟 :8000（後端改動 / DB migration）
1. 找現行 PID：`netstat -ano | grep "127.0.0.1:8000" | grep LISTENING` → `taskkill //PID <pid> //F`
2. 重啟（**用 autostart 的 vbs，不要自己前景跑** start_public.bat 會卡住）：
   ```bash
   cmd //c wscript "D:\\Claude code\\GIS\\packaging\\autostart\\gis_public.vbs"
   ```
   vbs 隱藏視窗跑 `start_public.bat` → 載 `packaging\env.local.bat`（GIS_GOOGLE_CLIENT_ID / GIS_SESSION_SECRET）→ venv python 起 uvicorn。
3. **重啟前先確認 secrets 還在**：`grep -c GIS_GOOGLE_CLIENT_ID packaging/env.local.bat`（缺了重啟會讓 Google 登入壞掉）。
- DB schema 變更放 `db.init_db()`（啟動時跑），用 `PRAGMA table_info` 判斷再 `ALTER TABLE ... ADD COLUMN`，對既有 `server/gis.db` 才安全遷移。
- ⚠️ 現行進程 cmdline 可能顯示 system python（uvicorn worker），但**父進程**是 start_public.bat 的 venv python — 用 `Get-CimInstance Win32_Process` 看 ParentProcessId 確認是自己剛起的。

## 上線後驗證（都要做）
```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8000/                # SPA 200
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8000/api/me           # 401 = API 活著
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://localhost:8000/api/auth/google \
     -H "Content-Type: application/json" -d '{"credential":"x"}'                # 401 = client id 有載入（500=環境沒吃到）
curl -s -o /dev/null -w "%{http_code}\n" https://gis.tinghaochang.com/          # 200 = tunnel 正常
```
- 前端功能是否真的進 bundle：`curl -s localhost:8000/assets/index-*.js | grep -c '<某功能字串>'`。
- 後端 DB migration 是否套用：`sqlite3` / python 讀 `server/gis.db` 的 `PRAGMA table_info(...)`。
- 前端改動未 build 進 `dist/` 就只在原始碼、不會上線；`git commit` 不等於上線。

## 常見誤解
- 改 `server/db.py` 後只跑 deploy.bat → **沒生效**（只換了前端 dist，Python 沒重啟）。要走 B。
- 正登入中的使用者不會馬上看到「登入時才觸發」的後端行為（如自動種專案）→ 要重新登入才觸發 upsert_user。
