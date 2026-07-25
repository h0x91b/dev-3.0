/**
 * The `bun run dev` / `bun run start` orchestrator.
 *
 * The package scripts used to be one POSIX shell line: `A && B && VAR=x $(cmd)
 * electrobun dev`. Environment-variable prefixes, `$(...)` substitution and
 * `${VAR:-0}` defaulting are all shell syntax PowerShell does not speak, so on
 * Windows the dev loop could not start at all. This runs the identical steps as
 * a process chain with no shell involved, and resolves every tool through a
 * concrete file inside `node_modules` rather than a PATH lookup (Windows has no
 * `vite` executable — only `vite.cmd` — and `electrobun.cjs` needs a runtime).
 */

import { resolve } from "node:path";

/** Lazy: `import.meta.dir` is a Bun-runtime value, absent when tests import this. */
function repoRoot(): string {
	return resolve(import.meta.dir, "..");
}

/** Tools resolved as files so no shell wrapper or PATH entry is required. */
const VITE_BIN = "node_modules/vite/bin/vite.js";
const ELECTROBUN_BIN = "node_modules/electrobun/bin/electrobun.cjs";

export type DevMode = "dev" | "start";

export interface DevStep {
	label: string;
	command: string[];
}

/**
 * `start` deliberately skips `vite build` — it reuses whatever the last `dev`
 * emitted into `dist/`, which is the entire point of the second entry point.
 */
export function devPlan(mode: DevMode, execPath: string): DevStep[] {
	const steps: DevStep[] = [
		{ label: "build info", command: [execPath, "scripts/generate-build-info.ts"] },
		{ label: "changelog", command: [execPath, "scripts/generate-changelog.ts"] },
	];
	if (mode === "dev") {
		steps.push({ label: "renderer bundle", command: [execPath, VITE_BIN, "build"] });
	}
	steps.push(
		{ label: "CLI + native build", command: [execPath, "scripts/build-cli.ts"] },
		{ label: "electrobun build", command: [execPath, ELECTROBUN_BIN, "build"] },
	);
	return steps;
}

/**
 * Env for the `electrobun dev` run. `dev` additionally pins the stable per-machine
 * web-access code and the remote port, which the shell script passed inline.
 */
export function devRunEnv(
	mode: DevMode,
	source: { staticCode: string | null; port0: string | undefined },
): Record<string, string> {
	const env: Record<string, string> = { DEV3_FRESH_START: "1" };
	if (mode !== "dev") return env;
	if (source.staticCode) env.DEV3_REMOTE_STATIC_CODE = source.staticCode;
	// `${DEV3_PORT0:-0}`: 0 means "pick a free port".
	env.DEV3_REMOTE_PORT = source.port0?.trim() || "0";
	return env;
}

function runOrExit(step: DevStep): void {
	const result = Bun.spawnSync(step.command, {
		cwd: repoRoot(),
		stdout: "inherit",
		stderr: "inherit",
		env: process.env,
	});
	if (result.exitCode !== 0) {
		console.error(`[dev] ${step.label} failed (exit ${result.exitCode})`);
		process.exit(result.exitCode ?? 1);
	}
}

function readDevWebCode(): string | null {
	const result = Bun.spawnSync([process.execPath, "scripts/dev-web-code.ts"], {
		cwd: repoRoot(),
		stdout: "pipe",
		stderr: "inherit",
		env: process.env,
	});
	if (result.exitCode !== 0) {
		console.warn("[dev] dev web access code unavailable — the browser UI will need the rotating token");
		return null;
	}
	return new TextDecoder().decode(result.stdout).trim() || null;
}

function main(): void {
	const mode: DevMode = process.argv.includes("--start") ? "start" : "dev";
	for (const step of devPlan(mode, process.execPath)) runOrExit(step);

	const env = devRunEnv(mode, {
		staticCode: mode === "dev" ? readDevWebCode() : null,
		port0: process.env.DEV3_PORT0,
	});

	const child = Bun.spawn([process.execPath, ELECTROBUN_BIN, "dev"], {
		cwd: repoRoot(),
		stdout: "inherit",
		stderr: "inherit",
		stdin: "inherit",
		env: { ...process.env, ...env },
	});
	child.exited.then((code) => process.exit(code ?? 0));
}

if (import.meta.main) main();
