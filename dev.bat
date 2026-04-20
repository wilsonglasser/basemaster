@echo off
rem Wrapper que carrega o ambiente MSVC (vcvars64) e roda `pnpm tauri dev`.
rem Use isto em vez de chamar `pnpm tauri dev` diretamente — sem o vcvars,
rem o linker do MSYS2 (`/usr/bin/link`) sequestra o build do Cargo.

setlocal
set VCVARS="C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
if not exist %VCVARS% (
    echo [dev.bat] vcvars64.bat nao encontrado em %VCVARS%
    echo Ajuste o caminho neste arquivo se sua instalacao do VS Build Tools for diferente.
    exit /b 1
)
call %VCVARS% >nul
if errorlevel 1 exit /b 1

set PATH=C:\Users\wilso\.cargo\bin;%PATH%
pnpm tauri dev %*
