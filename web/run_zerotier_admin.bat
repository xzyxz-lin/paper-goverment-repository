@echo off
rem Double-click to allow ZeroTier access to Private Library (port 8040).
rem This file is pure ASCII on purpose (avoids cmd GBK/UTF-8 mojibake that made it exit silently).
chcp 65001 >nul

rem --- self-elevate: if not admin, relaunch this same .bat with admin rights (UAC prompt) ---
net session >nul 2>&1
if %errorlevel%==0 goto run
powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
exit /b

:run
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0enable_zerotier_access.ps1"
echo.
echo Firewall rule done. Access via http://10.44.55.169:8040
pause
