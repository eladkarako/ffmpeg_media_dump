::@echo off
chcp 65001 1>nul 2>nul
pushd "%~dp0"

"node.exe" "dump_writer.js" %*
set "EXIT_CODE=%ErrorLevel%"

pause
exit /b %EXIT_CODE%
