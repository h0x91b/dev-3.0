// ---- Package scripts runner ----

export type ScriptPlacement = "left" | "top" | "right" | "bottom" | "window";

export const SCRIPT_PLACEMENTS: readonly ScriptPlacement[] = ["left", "top", "right", "bottom", "window"] as const;

export type ScriptRunner = "bun" | "pnpm" | "yarn" | "npm";

export const SCRIPT_RUNNERS: readonly ScriptRunner[] = ["bun", "pnpm", "yarn", "npm"] as const;

export interface PackageScriptEntry {
	name: string;
	command: string;
}

export interface PackageScripts {
	/** True if a parseable package.json exists in the worktree. */
	exists: boolean;
	/** Worktree-relative path to the parsed package.json (e.g. "package.json"). */
	path: string | null;
	scripts: PackageScriptEntry[];
	runner: ScriptRunner;
	/** Runner was auto-detected from a lockfile (vs falling back to npm). */
	runnerAutoDetected: boolean;
	/** Multiple lockfiles found — runner is ambiguous. */
	multipleLockfiles: boolean;
	/** Lockfiles actually present in the worktree. */
	lockfiles: string[];
	/** Reason the package.json could not be used, if any (file missing / parse error / no scripts). */
	error: string | null;
}

/** Where a runnable entry in the Scripts dropdown comes from. */
export type ScriptSource = "package" | "make";

export const SCRIPT_SOURCES: readonly ScriptSource[] = ["package", "make"] as const;

export interface MakefileScripts {
	/** True if a readable Makefile exists in the worktree. */
	exists: boolean;
	/** Which makefile name was found (`GNUmakefile` | `makefile` | `Makefile`), or null. */
	path: string | null;
	/** Extracted targets. Reuses {@link PackageScriptEntry}: `command` is a recipe preview. */
	targets: PackageScriptEntry[];
	/** Reason the Makefile could not be used, if any (`no-makefile` / `no-targets` / read error). */
	error: string | null;
}

/** Everything the Scripts dropdown can run in one worktree: npm scripts + Makefile targets. */
export interface WorktreeScripts {
	package: PackageScripts;
	makefile: MakefileScripts;
}

/**
 * Storage key for {@link Task.scriptLastRunAt} / {@link Task.scriptLastPlacement}.
 * Package scripts keep their bare name (preserves history from before Makefile
 * support existed); make targets are namespaced so a `test` target never
 * collides with a `test` npm script. Both the renderer and the RPC handler MUST
 * use this helper so the keys agree.
 */
export function scriptStorageKey(source: ScriptSource, name: string): string {
	return source === "make" ? `make:${name}` : name;
}
