@echo off
rem ===========================================================
rem  Website Compare (standalone) launcher
rem    1) make sure the Docker engine is up
rem    2) docker compose up -d --build  (backend + frontend)
rem    3) open the browser and exit
rem  Logs live in Docker Desktop (or: docker compose logs -f backend).
rem ===========================================================
setlocal EnableExtensions
set "ROOT=%~dp0"
set "DD=%ProgramFiles%\Docker\Docker\Docker Desktop.exe"
set "DOCKER=%ProgramFiles%\Docker\Docker\resources\bin\docker.exe"
if not exist "%DOCKER%" set "DOCKER=docker"

title Website Compare launcher
echo.
echo   ===== Website Compare v0.1 (standalone) =====
echo.

echo [1/3] Checking Docker engine...
"%DOCKER%" info >nul 2>&1
if %errorlevel%==0 (
  echo       Docker is already running.
) else (
  echo       Docker is not running - starting Docker Desktop...
  if exist "%DD%" ( start "" "%DD%" ) else ( echo       Docker Desktop.exe not found - start Docker manually, then re-run. )
  echo       Waiting for the engine...
  call :waitdocker 60
  if not %errorlevel%==0 (
    echo  *** Docker could not be started. Start Docker Desktop, then run start-compare.bat again. ***
    pause
    exit /b 1
  )
)
echo.

echo [2/3] Starting the stack (backend + frontend)...
pushd "%ROOT%"
docker compose up -d --build
popd
echo       Waiting for the backend API...
call :waitbackend 60
echo.

echo [3/3] Opening http://localhost:5173 ...
start "" "http://localhost:5173"
echo       Logs: docker compose logs -f backend   (or frontend). You can close this window.
timeout /t 3 >nul
exit /b 0

:waitdocker
set /a _max=%~1
set /a _t=0
:wd_loop
"%DOCKER%" info >nul 2>&1
if %errorlevel%==0 exit /b 0
set /a _t+=2
if %_t% geq %_max% exit /b 1
<nul set /p "=."
timeout /t 2 >nul
goto :wd_loop

:waitbackend
set /a _bmax=%~1
set /a _bt=0
:wb_loop
curl -fsS -m 2 -o nul http://127.0.0.1:8000/api/health >nul 2>&1
if %errorlevel%==0 exit /b 0
set /a _bt+=2
if %_bt% geq %_bmax% exit /b 1
<nul set /p "=."
timeout /t 2 >nul
goto :wb_loop
