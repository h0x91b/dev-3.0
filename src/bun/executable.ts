import { accessSync, constants, existsSync, statSync } from "node:fs";

/** True only when `path` names a regular file the current process can execute. */
export function isExecutableFile(path: string): boolean {
	try {
		if (!existsSync(path)) return false;
		if (!statSync(path).isFile()) return false;
		accessSync(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

/**
 * True when a saved binary path still points at the binary the base command
 * names (same file name, optionally with a Windows launcher extension).
 * A path cached for `claude` must stop applying once the command is edited to
 * e.g. `claude-codex` — otherwise the cache silently shadows the edit.
 */
export function binaryPathMatchesCommand(savedPath: string, baseCommand: string): boolean {
	const fileName = (value: string) => (value.split(/[\\/]/).pop() ?? "").toLowerCase();
	const base = fileName(baseCommand);
	const saved = fileName(savedPath);
	if (!base || !saved) return false;
	if (saved === base) return true;
	const stripLauncherExt = (name: string) => name.replace(/\.(exe|cmd|bat|com|ps1)$/, "");
	return stripLauncherExt(saved) === stripLauncherExt(base);
}

/**
 * The binary path that stands in for an agent's base command, or undefined to
 * resolve the command through PATH. A path the user typed in always wins and is
 * never name-checked; the auto-cached one applies only while it still names the
 * current base command, so editing the command is not shadowed by the old cache.
 */
export function agentBinaryPathOverride(
	agentId: string,
	baseCommand: string,
	cachedPaths: Record<string, string> | undefined,
	customPaths: Record<string, string> | undefined,
): string | undefined {
	const customPath = customPaths?.[agentId];
	if (customPath) return customPath;
	const cachedPath = cachedPaths?.[agentId];
	return cachedPath && binaryPathMatchesCommand(cachedPath, baseCommand) ? cachedPath : undefined;
}
