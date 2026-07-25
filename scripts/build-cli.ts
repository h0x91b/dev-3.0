/**
 * CLI build orchestrator — replaces the bash chain that used to live in the
 * `build:cli` package script.
 *
 * Windows has no bash, so the Windows package path must reach the compiled CLI
 * and the native host without invoking a shell script. POSIX keeps delegating to
 * the existing `.sh` steps verbatim so its behavior is unchanged.
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { cliBinaryName } from "../electrobun.config";

export interface CliBuildPlan {
	/** Repo-relative `bun build --compile` output path. */
	outfile: string;
	/** Bash scripts to delegate to; empty on platforms without a shell. */
	shellSteps: string[];
}

export function cliBuildPlan(platform: NodeJS.Platform): CliBuildPlan {
	const outfile = `dist/${cliBinaryName(platform)}`;
	if (platform === "win32") return { outfile, shellSteps: [] };
	return { outfile, shellSteps: ["scripts/stage-bundled-tmux.sh", "scripts/sign-cli-binaries.sh"] };
}

function runOrExit(command: string[], label: string): void {
	const result = Bun.spawnSync(command, {
		cwd: resolve(import.meta.dir, ".."),
		stdout: "inherit",
		stderr: "inherit",
		env: process.env,
	});
	if (result.exitCode !== 0) {
		console.error(`[build-cli] ${label} failed (exit ${result.exitCode})`);
		process.exit(result.exitCode ?? 1);
	}
}

function main(): void {
	const plan = cliBuildPlan(process.platform);
	runOrExit(
		[process.execPath, "build", "src/cli/main.ts", "--compile", "--outfile", plan.outfile],
		`CLI compile into ${plan.outfile}`,
	);

	for (const script of plan.shellSteps) runOrExit(["bash", script], script);

	if (plan.shellSteps.length === 0) {
		// Windows ships no bundled tmux and needs no codesigning, but the
		// electrobun copy rule still requires a `dist/tmux` source to exist.
		mkdirSync(resolve(import.meta.dir, "../dist/tmux"), { recursive: true });
		console.log("[build-cli] no shell available: dist/tmux stays empty, CLI signing skipped");
	}

	runOrExit([process.execPath, "scripts/build-native.ts"], "native build");
	console.log(`[build-cli] built ${plan.outfile}`);
}

if (import.meta.main) main();
