@echo off
REM ============================================================
REM  Web GIS public site - manual launcher (visible window)
REM
REM  Serves the built SPA + API from FastAPI on 127.0.0.1:8000
REM  (same origin). The PUBLIC URL is provided by the shared
REM  Cloudflare tunnel (the same one that serves ClinScope):
REM      https://gis.tinghaochang.com
REM
REM  This launcher starts ONLY the GIS server. The tunnel is
REM  shared and already running for ClinScope; it routes
REM  gis.tinghaochang.com here via ~/.cloudflared/config.yml.
REM
REM  Prereqs (one-time): see docs\DEPLOY.md
REM    1. npm run build          (produces dist\, served here)
REM    2. fill packaging\env.local.bat   (OAuth client id + secret)
REM    3. add the gis ingress to config.yml + restart the tunnel
REM ============================================================
chcp 65001 >nul
set PYTHONIOENCODING=utf-8
set GIS_COOKIE_SECURE=1
set GIS_DEV_LOGIN=0

REM Secrets (GIS_GOOGLE_CLIENT_ID, GIS_SESSION_SECRET) live in a local,
REM gitignored file so they never get committed:
if exist "%~dp0env.local.bat" call "%~dp0env.local.bat"

if "%GIS_GOOGLE_CLIENT_ID%"=="" echo [WARN] GIS_GOOGLE_CLIENT_ID is empty - Google login will fail. Fill packaging\env.local.bat
if "%GIS_SESSION_SECRET%"=="" echo [WARN] GIS_SESSION_SECRET is empty - using insecure default. Fill packaging\env.local.bat

echo Starting GIS server on 127.0.0.1:8000 ...
"D:\Claude code\GIS\server\.venv\Scripts\python.exe" -m uvicorn server.main:app --host 127.0.0.1 --port 8000 --app-dir "D:\Claude code\GIS"
