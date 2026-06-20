@echo off
REM ============================================================
REM  Web GIS - instant rollback
REM
REM  Swaps the previous build (dist_prev, saved by deploy.bat)
REM  back into place. The bad build is parked in dist_bad so you
REM  can inspect it. No rebuild needed - this is just two renames,
REM  and the running server serves the restored dist/ immediately.
REM ============================================================
setlocal
cd /d "%~dp0.."
chcp 65001 >nul

if not exist dist_prev goto no_backup

echo Rolling back to the previous build ...
if exist dist_bad rmdir /s /q dist_bad
if exist dist ren dist dist_bad
if errorlevel 1 goto locked
ren dist_prev dist
if errorlevel 1 goto restore_failed

echo === rolled back. The bad build is parked in dist_bad - delete it when ready. ===
goto end

:no_backup
echo [ABORT] no dist_prev to roll back to. Nothing changed.
exit /b 1

:locked
echo [ABORT] could not rename dist/ - a request may be in flight. Re-run rollback.bat.
exit /b 1

:restore_failed
echo [ERROR] restore failed - dist_bad holds the current build, dist_prev holds the previous one. Fix manually.
exit /b 1

:end
endlocal
