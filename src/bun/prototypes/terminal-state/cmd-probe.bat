@echo off
setlocal EnableDelayedExpansion
rem Deterministic cmd.exe VT probe for the Windows terminal-state capture spike.
rem Emits a fixed title, colors, palette history, and cursor presentation, then
rem sleeps so the capture can snapshot a live frame before the process is killed.
rem ASCII only and no paths/secrets so the capture is shareable as a fixture.

for /F %%a in ('echo prompt $E ^| cmd') do set "ESC=%%a"

echo !ESC!]0;cmd terminal-state probe!ESC!\
echo !ESC![2J!ESC![H
echo !ESC![1;38;2;80;160;240mcmd.exe deterministic probe!ESC![0m
for /L %%i in (1,1,8) do echo !ESC![38;5;%%imhistory line %%i!ESC![0m
echo !ESC![?25l!ESC![6 q
ping -n 6 127.0.0.1 >nul
