/**
 * The batch script that finishes a Windows self-update after the app quits.
 *
 * Electrobun's own version (node_modules/electrobun/dist/api/bun/core/Updater.ts)
 * waited on `tasklist /FI "IMAGENAME eq launcher.exe"`, on `bun.exe` and on
 * `bun Helper` — IMAGE NAMES, which match every such process on the machine.
 * One stale launcher.exe, or any unrelated Bun, wedged the update forever behind
 * a console that printed nothing. This script waits on the app's PID, force-closes
 * only processes running FROM the tree being replaced, and says what it is doing.
 */

export interface WindowsSwapScriptOptions {
	/** PID of the running app. The wait is scoped to exactly this process. */
	pid: number;
	/** Version being installed — shown to the user, not used for any path. */
	version: string;
	/** The tree being replaced, e.g. `%LOCALAPPDATA%\…\canary\app`. */
	targetAppDir: string;
	/** The freshly extracted tree that takes its place. */
	newAppDir: string;
	/** Scratch directory removed once the swap lands. */
	extractionDir: string;
	/** `launcher.exe` inside {@link targetAppDir}, started when the swap lands. */
	launcherPath: string;
	/** Every line the script prints is appended here too. */
	logPath: string;
	/** Seconds to wait for the app to exit before force-closing its tree. */
	exitWaitSeconds?: number;
	/** How many times to retry removing a locked old tree, 2s apart. */
	removeRetries?: number;
}

const DEFAULT_EXIT_WAIT_SECONDS = 60;
const DEFAULT_REMOVE_RETRIES = 10;

function toWindowsPath(p: string): string {
	return p.replace(/\//g, "\\");
}

export function buildWindowsSwapScript(opts: WindowsSwapScriptOptions): string {
	const exitWait = opts.exitWaitSeconds ?? DEFAULT_EXIT_WAIT_SECONDS;
	const removeRetries = opts.removeRetries ?? DEFAULT_REMOVE_RETRIES;
	const target = toWindowsPath(opts.targetAppDir);
	const newApp = toWindowsPath(opts.newAppDir);
	const extraction = toWindowsPath(opts.extractionDir);
	const launcher = toWindowsPath(opts.launcherPath);
	const log = toWindowsPath(opts.logPath);

	const script = `@echo off
setlocal enabledelayedexpansion
title dev3 update
set "DEV3LOG=${log}"
call :say "dev3 ${opts.version} - finishing the update"
call :say "waiting for dev3 to exit (pid ${opts.pid})"

set /a waited=0
:waitloop
tasklist /FI "PID eq ${opts.pid}" /NH 2>NUL | find "${opts.pid}" >NUL
if errorlevel 1 goto exited
set /a waited+=1
if !waited! GEQ ${exitWait} goto forceclose
call :say "  dev3 still running after !waited!s"
ping -n 2 127.0.0.1 >nul
goto waitloop

:forceclose
call :say "dev3 did not exit after ${exitWait}s - closing what is still running from the old folder"
powershell -NoProfile -Command "Get-Process | Where-Object { $_.Path -like '${target}\\*' } | Stop-Process -Force" >>"%DEV3LOG%" 2>&1
ping -n 3 127.0.0.1 >nul

:exited
call :say "removing the old version"
set /a rmtry=0
:rmloop
if not exist "${target}" goto rmdone
rmdir /s /q "${target}" 2>nul
if not exist "${target}" goto rmdone
set /a rmtry+=1
if !rmtry! GEQ ${removeRetries} goto rmfailed
call :say "  old folder is locked, retry !rmtry! of ${removeRetries}"
ping -n 3 127.0.0.1 >nul
goto rmloop

:rmfailed
call :say "UPDATE FAILED - could not remove ${target}"
call :say "Something is still running from that folder. Close it (Task Manager) or reboot, then update again."
call :say "Your current dev3 is untouched. Full log: %DEV3LOG%"
pause
exit /b 1

:rmdone
call :say "installing ${opts.version}"
move "${newApp}" "${target}" >>"%DEV3LOG%" 2>&1
if not exist "${launcher}" (
    call :say "UPDATE FAILED - launcher missing at ${launcher} after the move"
    call :say "Full log: %DEV3LOG%"
    pause
    exit /b 1
)

rmdir /s /q "${extraction}" 2>nul
call :say "starting dev3 ${opts.version}"
start "" "${launcher}"
call :say "update complete"

for /f "tokens=2" %%t in ('schtasks /query /fo list ^| findstr /i "Dev3Update_"') do (
    schtasks /delete /tn "%%t" /f >nul 2>&1
)
ping -n 2 127.0.0.1 >nul
del "%~f0"
exit /b 0

:say
echo %~1
echo [%date% %time%] %~1 >>"%DEV3LOG%"
exit /b 0
`;
	// cmd.exe seeks the batch file by byte offset while it runs. With LF-only line
	// endings that seek lands mid-line and `call :say` dies with "cannot find the
	// batch label" — measured on windows-latest, run 31814660786.
	return script.replace(/\r?\n/g, "\r\n");
}
