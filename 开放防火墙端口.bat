@echo off
chcp 65001 >nul
title 开放防火墙端口（机房小游戏）
set "PORT=%~1"
if "%PORT%"=="" set "PORT=8080"

net session >nul 2>&1
if errorlevel 1 goto needadmin

echo.
echo   即将为 TCP 端口 %PORT% 添加入站放行规则。
echo   （只影响本机防火墙的这一条规则，随时可以删掉）
echo.
netsh advfirewall firewall delete rule name="机房小游戏 %PORT%" >nul 2>&1
netsh advfirewall firewall add rule name="机房小游戏 %PORT%" dir=in action=allow protocol=TCP localport=%PORT%
if errorlevel 1 goto failed

echo.
echo   完成！已放行 TCP %PORT%，别的电脑现在应该能访问了。
echo.
echo   如需撤销，请在管理员命令行执行：
echo     netsh advfirewall firewall delete rule name="机房小游戏 %PORT%"
echo.
pause
exit /b 0

:needadmin
echo.
echo   [需要管理员权限]
echo.
echo   请右键本文件，选择「以管理员身份运行」。
echo.
pause
exit /b 1

:failed
echo.
echo   [失败] 添加规则时出错，可能被安全软件拦截了。
echo   也可以手动在「Windows Defender 防火墙 - 高级设置 - 入站规则」里
echo   为 TCP %PORT% 添加一条「允许连接」的规则。
echo.
pause
exit /b 1
