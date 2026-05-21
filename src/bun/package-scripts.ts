import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { PackageScripts, ScriptRunner, PackageScriptEntry } from "../shared/types";

interface LockfileRule {
	file: string;
	runner: ScriptRunner;
}

const LOCKFILE_RULES: LockfileRule[] = [
	{ file: "bun.lockb", runner: "bun" },
	{ file: "bun.lock", runner: "bun" },
	{ file: "pnpm-lock.yaml", runner: "pnpm" },
	{ file: "yarn.lock", runner: "yarn" },
	{ file: "package-lock.json", runner: "npm" },
];

export interface DetectedRunner {
	runner: ScriptRunner;
	autoDetected: boolean;
	lockfiles: string[];
}

export function detectRunner(worktreePath: string): DetectedRunner {
	const lockfiles: string[] = [];
	let firstRunner: ScriptRunner | null = null;
	for (const rule of LOCKFILE_RULES) {
		if (existsSync(join(worktreePath, rule.file))) {
			lockfiles.push(rule.file);
			if (!firstRunner) firstRunner = rule.runner;
		}
	}
	return {
		runner: firstRunner ?? "npm",
		autoDetected: firstRunner !== null,
		lockfiles,
	};
}

function emptyResult(runner: DetectedRunner, error: string | null): PackageScripts {
	return {
		exists: false,
		path: null,
		scripts: [],
		runner: runner.runner,
		runnerAutoDetected: runner.autoDetected,
		multipleLockfiles: runner.lockfiles.length > 1,
		lockfiles: runner.lockfiles,
		error,
	};
}

export function parsePackageScripts(worktreePath: string | null): PackageScripts {
	if (!worktreePath) {
		return emptyResult({ runner: "npm", autoDetected: false, lockfiles: [] }, "no-worktree");
	}
	const runner = detectRunner(worktreePath);
	const pkgPath = join(worktreePath, "package.json");
	if (!existsSync(pkgPath)) {
		return emptyResult(runner, "no-package-json");
	}
	let raw: string;
	try {
		raw = readFileSync(pkgPath, "utf-8");
	} catch (err) {
		return emptyResult(runner, `read-failed: ${(err as Error).message}`);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		return emptyResult(runner, `parse-failed: ${(err as Error).message}`);
	}
	if (!parsed || typeof parsed !== "object") {
		return emptyResult(runner, "invalid-package-json");
	}
	const scriptsRaw = (parsed as { scripts?: unknown }).scripts;
	if (!scriptsRaw || typeof scriptsRaw !== "object") {
		return {
			...emptyResult(runner, "no-scripts"),
			exists: true,
			path: "package.json",
		};
	}
	const scripts: PackageScriptEntry[] = [];
	for (const [name, cmd] of Object.entries(scriptsRaw as Record<string, unknown>)) {
		if (typeof cmd !== "string") continue;
		if (typeof name !== "string" || !name) continue;
		scripts.push({ name, command: cmd });
	}
	return {
		exists: true,
		path: "package.json",
		scripts,
		runner: runner.runner,
		runnerAutoDetected: runner.autoDetected,
		multipleLockfiles: runner.lockfiles.length > 1,
		lockfiles: runner.lockfiles,
		error: scripts.length === 0 ? "no-scripts" : null,
	};
}

export function resolveRunnerCommand(runner: ScriptRunner, scriptName: string): string {
	const safeName = scriptName.replace(/[^a-zA-Z0-9:_\-./]/g, "");
	if (safeName !== scriptName) {
		throw new Error(`invalid script name: ${scriptName}`);
	}
	switch (runner) {
		case "bun":
			return `bun run ${safeName}`;
		case "pnpm":
			return `pnpm run ${safeName}`;
		case "yarn":
			return `yarn ${safeName}`;
		case "npm":
		default:
			return `npm run ${safeName}`;
	}
}
