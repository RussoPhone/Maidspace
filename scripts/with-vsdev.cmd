@echo off
setlocal

set "CARGO_BUILD_JOBS=1"
set "PATH=%USERPROFILE%\.cargo\bin;C:\Program Files\nodejs;%PATH%"

set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
if exist "%VSWHERE%" (
  for /f "usebackq tokens=*" %%i in (`"%VSWHERE%" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`) do set "VSINSTALL=%%i"
)

if defined VSINSTALL if exist "%VSINSTALL%\Common7\Tools\VsDevCmd.bat" (
  call "%VSINSTALL%\Common7\Tools\VsDevCmd.bat" -arch=x64 >nul
)

if "%~1"=="" (
  echo Uso: scripts\with-vsdev.cmd comando [args...]
  exit /b 2
)

%*
exit /b %ERRORLEVEL%
