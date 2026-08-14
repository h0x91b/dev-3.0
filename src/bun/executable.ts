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
	return !!base && !!saved && (saved === base || saved.startsWith(`${base}.`));
}
