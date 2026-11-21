/**
 * The environment electrobun's CLI must run in on Windows.
 *
 * The CLI shells out to Windows PowerShell 5.1 (`powershell -command "Expand-Archive ..."`)
 * to unpack the Bun it bundles. Started from a PowerShell 7 session, that 5.1 child inherits
 * PowerShell 7's module directories at the FRONT of `PSModulePath` and loads PowerShell 7's
 * own `Microsoft.PowerShell.Archive`, which calls .NET Core-only overloads and dies on
 * .NET Framework. See `decisions/2026/11/21/strip-pwsh7-module-paths-for-electrobun.md`.
 */

import { existsSync } from "node:fs";
import { win32 } from "node:path";

export interface PowerShellEnvResult {
	env: Record<string, string | undefined>;
	/** The `PSModulePath` entries removed, in their original order. */
	dropped: string[];
}

/**
 * A PowerShell 7 module directory: `$PSHOME\Modules` (the folder next to `pwsh.exe`, wherever
 * it is installed) or the per-user / all-users `...\PowerShell\Modules`. The Windows
 * PowerShell 5.1 equivalents live under `WindowsPowerShell`, which this never matches.
 */
export function isPowerShell7ModuleDir(entry: string, exists: (path: string) => boolean = existsSync): boolean {
	const normalized = win32.normalize(entry.trim()).replace(/\\+$/, "");
	if (win32.basename(normalized).toLowerCase() !== "modules") return false;
	const parent = win32.dirname(normalized);
	if (exists(win32.join(parent, "pwsh.exe"))) return true;
	if (win32.basename(parent).toLowerCase() !== "powershell") return false;
	const owner = win32.basename(win32.dirname(parent)).toLowerCase();
	return owner === "documents" || owner.startsWith("program files");
}

/** Off Windows, or with nothing to drop, the env comes back untouched (same object). */
export function withoutPowerShell7ModulePaths(
	env: Record<string, string | undefined>,
	platform: NodeJS.Platform = process.platform,
	exists: (path: string) => boolean = existsSync,
): PowerShellEnvResult {
	if (platform !== "win32") return { env, dropped: [] };
	// Windows env names are case-insensitive, so the key may arrive in any spelling.
	const key = Object.keys(env).find((name) => name.toLowerCase() === "psmodulepath");
	const value = key ? env[key] : undefined;
	if (!key || !value) return { env, dropped: [] };
	const entries = value.split(";");
	const dropped = entries.filter((entry) => entry.trim() && isPowerShell7ModuleDir(entry, exists));
	if (dropped.length === 0) return { env, dropped };
	const kept = entries.filter((entry) => entry.trim() && !dropped.includes(entry));
	return { env: { ...env, [key]: kept.join(";") }, dropped };
}

/** Applies the fix to this process, so every child it spawns inherits it, and says so. */
export function stripPowerShell7ModulePathsInPlace(label: string): void {
	const { env, dropped } = withoutPowerShell7ModulePaths(process.env);
	if (dropped.length === 0) return;
	for (const [name, value] of Object.entries(env)) if (/^psmodulepath$/i.test(name)) process.env[name] = value;
	console.log(
		`[${label}] PSModulePath: dropped PowerShell 7 module dirs (${dropped.join("; ")}) so electrobun's Windows PowerShell 5.1 children load their own Archive module`,
	);
}
