@echo off
REM ============================================================
REM  Web GIS - safe one-click deploy
REM
REM  Builds the frontend into a STAGING dir (dist_new) so the
REM  live dist/ keeps serving the whole time, then swaps it in.
REM  The previous build is kept as dist_prev for instant rollback
REM  (packaging\rollback.bat). The running server serves the new
REM  dist/ immediately - StaticFiles reads from disk, no restart.
REM
REM  Window of risk shrinks from "the whole vite build" down to a
REM  single directory rename.
REM ============================================================
setlocal
cd /d "%~dp0.."
chcp 65001 >nul

echo === Web GIS deploy ===

REM 1. Guard: the Google client id is baked in at build time. If it is
REM    missing, every real login breaks - so refuse to build.
findstr /C:"VITE_GOOGLE_CLIENT_ID" .env.local >nul 2>&1
if errorlevel 1 goto no_env

REM 2. Heads-up: the build ships the current working tree, not a commit.
git diff --quiet HEAD 2>nul
if errorlevel 1 echo [WARN] working tree differs from HEAD - those uncommitted changes WILL go live.

REM 3. Typecheck, then build into the staging dir. Live dist/ untouched.
echo Typechecking ...
call npx tsc -b
if errorlevel 1 goto build_failed
echo Building into dist_new ...
if exist dist_new rmdir /s /q dist_new
call npx vite build --outDir dist_new --emptyOutDir
if errorlevel 1 goto build_failed

REM 4. Swap: previous dist -> dist_prev (rollback), staging -> live.
if exist dist_prev rmdir /s /q dist_prev
if exist dist ren dist dist_prev
if errorlevel 1 goto swap_locked
ren dist_new dist
if errorlevel 1 goto promote_failed

echo.
echo === DONE ===
netstat -ano | findstr ":8000" | findstr "LISTENING" >nul
if errorlevel 1 (echo [NOTE] nothing is serving :8000 - run packaging\start_public.bat to bring the site up.) else (echo Live now - the running server serves the new dist immediately, no restart needed.)
echo Roll back anytime with packaging\rollback.bat   [previous build kept in dist_prev]
goto end

:no_env
echo [ABORT] .env.local has no VITE_GOOGLE_CLIENT_ID - Google login would break. Nothing built.
exit /b 1

:build_failed
echo [ABORT] build failed - live dist/ untouched, site unchanged.
if exist dist_new rmdir /s /q dist_new
exit /b 1

:swap_locked
echo [ABORT] could not rename dist/ - a request may be in flight. New build is waiting in dist_new; just re-run deploy.bat.
exit /b 1

:promote_failed
echo [ERROR] promoting dist_new failed - restoring previous build.
if exist dist_prev ren dist_prev dist
exit /b 1

:end
endlocal
