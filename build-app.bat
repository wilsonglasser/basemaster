@echo off
rem Wrapper que carrega o ambiente MSVC (vcvars64) e roda `pnpm tauri build`.

setlocal
set VCVARS="C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
if not exist %VCVARS% (
    echo [build-app.bat] vcvars64.bat nao encontrado em %VCVARS%
    exit /b 1
)
call %VCVARS% >nul
if errorlevel 1 exit /b 1

set PATH=C:\Users\wilso\.cargo\bin;%PATH%
pnpm tauri build %*
