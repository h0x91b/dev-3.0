/**
 * Native asset build orchestrator — replaces the bash chain that used to live in
 * the `build:native` package script.
 *
 * The macOS notification shim is still built by its `.sh` script; Windows only
 * needs the `dist/native` copy source to exist. The terminal host bundler runs
 * on every platform — a package without it has no native terminal to launch.
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

export interface NativeBuildPlan {
	/** Bash scripts to delegate to; empty on platforms without a shell. */
	shellSteps: string[];
}

export function nativeBuildPlan(platform: NodeJS.Platform): NativeBuildPlan {
	if (platform === "win32") return { shellSteps: [] };
	return { shellSteps: ["scripts/build-native-notifications.sh"] };
}

function runOrExit(command: string[], label: string): void {
	const result = Bun.spawnSync(command, {
		cwd: resolve(import.meta.dir, ".."),
		stdout: "inherit",
		stderr: "inherit",
		env: process.env,
	});
	if (result.exitCode !== 0) {
		console.error(`[build-native] ${label} failed (exit ${result.exitCode})`);
		process.exit(result.exitCode ?? 1);
	}
}

function main(): void {
	const plan = nativeBuildPlan(process.platform);
	for (const script of plan.shellSteps) runOrExit(["bash", script], script);
	// Always present so the electrobun `dist/native` copy rule has a source.
	mkdirSync(resolve(import.meta.dir, "../dist/native"), { recursive: true });
	runOrExit([process.execPath, "scripts/build-terminal-host.ts"], "native terminal host bundle");
}

if (import.meta.main) main();
