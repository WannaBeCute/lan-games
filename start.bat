@echo off
setlocal
chcp 65001 >nul
title 机房小游戏服务器
cd /d "%~dp0"

echo.
echo   ======================================================
echo      机房小游戏服务器     坦克大战  +  五子棋
echo   ======================================================
echo.

set "NODE_EXE="

rem ---- 1) 先找 PATH 里的 node ----
for /f "delims=" %%i in ('where node 2^>nul') do if not defined NODE_EXE set "NODE_EXE=%%i"

rem ---- 2) PATH 里没有，再找常见安装位置 ----
if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles(x86)%\nodejs\node.exe"
if not defined NODE_EXE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE_EXE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not defined NODE_EXE if exist "%APPDATA%\nvm\node.exe" set "NODE_EXE=%APPDATA%\nvm\node.exe"
if not defined NODE_EXE if exist "C:\nodejs\node.exe" set "NODE_EXE=C:\nodejs\node.exe"

if defined NODE_EXE goto run

echo   [错误] 没有找到 Node.js
echo.
echo     本游戏需要先安装 Node.js：  https://nodejs.org
echo     安装时一路点下一步即可，装完后重新运行本文件。
echo.
echo     注意：请勿直接双击 server\server.js
echo           Windows 会用系统自带的脚本宿主打开它，从而报语法错误。
echo.
pause
exit /b 1

:run
echo   使用 Node： %NODE_EXE%
"%NODE_EXE%" -v
echo.
echo   正在启动服务，关闭本窗口即停止服务...
echo.

"%NODE_EXE%" "%~dp0server\server.cjs" %*

echo.
echo   服务器已停止。
pause
