/**
 * The Windows half: known folders and `.lnk` read/write, both through
 * `WScript.Shell`, the same COM object electrobun's extractor uses — so a
 * shortcut we write and one Setup wrote are the same kind of file.
 *
 * Every call is best effort. A shortcut is a convenience; nothing here may stop
 * the app from starting.
 */

import { spawnSync } from "../spawn";

export interface WindowsShortcutSurface {
	/** Absolute path of a Windows known folder, or `null` when it cannot be resolved. */
	knownFolder(name: "DesktopDirectory" | "Programs"): string | null;
	/** Target of an existing `.lnk`, or `null` when the file is absent or unreadable. */
	readShortcutTarget(lnkPath: string): string | null;
	writeShortcut(input: { lnkPath: string; target: string; workingDir: string; iconPath: string }): boolean;
}

const POWERSHELL = `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;

/** PowerShell single-quoted literal: only `'` needs doubling inside one. */
function quote(value: string): string {
	return `'${value.split("'").join("''")}'`;
}

function runPowerShell(script: string): { ok: boolean; stdout: string } {
	const result = spawnSync([POWERSHELL, "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", script], {
		stdout: "pipe",
		stderr: "pipe",
	});
	return { ok: result.exitCode === 0, stdout: result.stdout?.toString() ?? "" };
}

export const powershellShortcutSurface: WindowsShortcutSurface = {
	knownFolder(name) {
		const { ok, stdout } = runPowerShell(`[Environment]::GetFolderPath(${quote(name)})`);
		const value = stdout.trim();
		return ok && value.length > 0 ? value : null;
	},

	readShortcutTarget(lnkPath) {
		const script = [
			"$ErrorActionPreference = 'Stop'",
			`if (-not (Test-Path -LiteralPath ${quote(lnkPath)} -PathType Leaf)) { exit 0 }`,
			"$WshShell = New-Object -ComObject WScript.Shell",
			`$WshShell.CreateShortcut(${quote(lnkPath)}).TargetPath`,
		].join("; ");
		const { ok, stdout } = runPowerShell(script);
		const value = stdout.trim();
		return ok && value.length > 0 ? value : null;
	},

	writeShortcut({ lnkPath, target, workingDir, iconPath }) {
		const script = [
			"$ErrorActionPreference = 'Stop'",
			"$WshShell = New-Object -ComObject WScript.Shell",
			`$Shortcut = $WshShell.CreateShortcut(${quote(lnkPath)})`,
			`$Shortcut.TargetPath = ${quote(target)}`,
			`$Shortcut.WorkingDirectory = ${quote(workingDir)}`,
			`$Shortcut.IconLocation = ${quote(iconPath)}`,
			"$Shortcut.WindowStyle = 1",
			"$Shortcut.Save()",
		].join("; ");
		return runPowerShell(script).ok;
	},
};
