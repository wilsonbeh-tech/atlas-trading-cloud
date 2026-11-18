@echo off
where node >nul 2>nul
if %errorlevel%==0 (
  node %*
) else (
  set ELECTRON_RUN_AS_NODE=1
  "%LOCALAPPDATA%\Programs\Qoder\Qoder.exe" %*
)
