import { accessSync, constants, existsSync, statSync } from "node:fs";
import type { GlobalSettings } from "../shared/types";

export type CustomPathSettings = Pick<GlobalSettings, "agentCustomBinaryPaths" | "strictAgentCustomBinaryPaths">;

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

function isStrictCustomPath(agentId: string, settings: CustomPathSettings): boolean {
	const path = settings.agentCustomBinaryPaths?.[agentId];
	return !!path && settings.strictAgentCustomBinaryPaths?.[agentId] === path;
}

/** A custom path saved before custom paths became strict that no longer works. It
 *  keeps the PATH fallback it was saved under (a Node upgrade removing an nvm path
 *  must not brick the agent); the caller warns and offers a reset instead. */
export function staleCustomPath(agentId: string, settings: CustomPathSettings): string | null {
	const path = settings.agentCustomBinaryPaths?.[agentId];
	return path && !isStrictCustomPath(agentId, settings) && !isExecutableFile(path) ? path : null;
}

/** The custom paths a launch obeys: every one except a stale pre-strict path. */
export function enforcedCustomBinaryPaths(settings: CustomPathSettings): Record<string, string> | undefined {
	const paths = settings.agentCustomBinaryPaths;
	if (!paths) return undefined;
	return Object.fromEntries(Object.entries(paths).filter(([agentId]) => !staleCustomPath(agentId, settings)));
}

/** The path the user chose for an agent when it is set but unusable (missing or
 *  not executable), else null. A broken choice is never replaced by the system
 *  binary: that would run a different program than the one the user picked.
 *  Pass `enforcedCustomBinaryPaths(settings)`, so a stale pre-strict path is not one. */
export function brokenCustomPath(agentId: string, customPaths: Record<string, string> | undefined): string | null {
	const path = customPaths?.[agentId];
	return path && !isExecutableFile(path) ? path : null;
}

export function customExecutableMessage(agentName: string, path: string): string {
	return `Custom executable for agent "${agentName}" not found or not executable: ${path}`;
}
