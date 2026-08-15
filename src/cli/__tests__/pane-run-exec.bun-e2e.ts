#!/usr/bin/env bun
/**
 * `dev3 pane run` EXECUTED, on this machine's real shell (seq 1548).
 *
 * The vitest suites assert what `paneRunShell` composes; they run on macOS and
 * cannot see whether Windows PowerShell actually accepts that composition. This
 * script runs the real pane-run process (`dev3 __pane-run`) against a real spec
 * file and reads back what landed in the log and the status file:
 *
 *  1. the command's output reaches the log as UTF-8 — the Windows console code
 *     page would turn a non-ASCII marker into mojibake without the encoding
 *     prelude, and the log is the only channel an agent has;
 *  2. a non-zero exit code arrives intact — `powershell -Command` does not
 *     propagate one by itself, which is what the exit epilogue exists for;
 *  3. Windows only: WHY neither caller of the PowerShell lookup may fall back to a
 *     PATH lookup when %SystemRoot% is absent. It launches `powershell.exe` from PATH
 *     in exactly that environment and records what Windows does with it — the control
 *     run above, with the variable present, is what makes that verdict readable.
 *
 * The POSIX legs are the control that `/bin/sh -c` still behaves as before.
 *
 * Run: bun run test:pane-run-exec
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "../../bun/spawn";
import { paneRunLogPath, paneRunSpecPath, paneRunStatusPath, PANE_RUN_VERB } from "../../bun/pane-run-store";
import { launchDialect } from "../../shared/platform-launch";

const IS_WINDOWS = process.platform === "win32";
/** Non-ASCII on purpose: this is what a wrong output encoding destroys. */
const MARKER = "dev3-pane-run-✓-проба";
const CLI_ENTRY = join(import.meta.dir, "..", "main.ts");

let failures = 0;
function check(condition: boolean, message: string): void {
	if (condition) console.log(`  ok   - ${message}`);
	else {
		failures++;
		console.error(`  FAIL - ${message}`);
	}
}

function printMarkerAndExit(code: number): string {
	return IS_WINDOWS ? `Write-Host '${MARKER}'; exit ${code}` : `printf '%s\\n' '${MARKER}'; exit ${code}`;
}

interface RunOutcome {
	log: string;
	status: { state?: string; exitCode?: number | null; detail?: string | null };
	stdout: string;
	stderr: string;
	cliExitCode: number | null;
}

async function runPane(dir: string, runId: string, command: string): Promise<RunOutcome> {
	writeFileSync(
		paneRunSpecPath(dir, runId),
		`${JSON.stringify({ runId, taskId: "e2e", command, cwd: dir, label: "", requestedAt: new Date().toISOString() })}\n`,
		"utf8",
	);
	const child = spawn([process.execPath, CLI_ENTRY, PANE_RUN_VERB, dir, runId], {
		cwd: dir,
		// Closed stdin: the runner's "press Enter to close this pane" wait ends with
		// the stream, which is how a pane run behaves when nobody is watching it.
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
	const cliExitCode = await child.exited;
	const logPath = paneRunLogPath(dir, runId);
	const statusPath = paneRunStatusPath(dir, runId);
	return {
		log: existsSync(logPath) ? readFileSync(logPath, "utf8") : "",
		status: existsSync(statusPath) ? JSON.parse(readFileSync(statusPath, "utf8")) : {},
		stdout,
		stderr,
		cliExitCode,
	};
}

/**
 * The other caller of the same lookup: the launch dialect resolves its own shell on
 * every Windows task launch. This writes a real wrapper script the way dev3 does
 * (BOM first, or PowerShell 5.1 reads it as ANSI) and launches it through the spec
 * the dialect produced — so what is exercised is the launch, not the string.
 */
async function launchGeneratedScript(
	dir: string,
	name: string,
): Promise<{ stdout: string; stderr: string; exitCode: number | null; executable: string }> {
	const d = launchDialect("win32");
	const scriptPath = join(dir, `${name}${d.scriptExtension}`);
	const body = [...d.header(), d.print(MARKER), "exit 5", ""].join("\n");
	writeFileSync(scriptPath, d.scriptByteOrderMark + body, "utf8");
	const launch = d.scriptLaunch(scriptPath, { cwd: dir, env: {} });
	const child = spawn([launch.executable, ...launch.argv], { cwd: launch.cwd, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
	return { stdout, stderr, exitCode: await child.exited, executable: launch.executable };
}

/**
 * The fallback dev3 does NOT use, executed so the refusal above is a measurement
 * rather than an opinion: `powershell.exe` off PATH, same script, same stripped
 * environment. Windows PowerShell 5.1 loads its managed runtime out of
 * %SystemRoot% and cannot start without it, so this is what a "graceful
 * degradation" would actually have handed the user.
 */
async function launchFallbackShell(dir: string): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
	const d = launchDialect("win32");
	const scriptPath = join(dir, `wrapper-fallback${d.scriptExtension}`);
	const body = [...d.header(), d.print(MARKER), "exit 5", ""].join("\n");
	writeFileSync(scriptPath, d.scriptByteOrderMark + body, "utf8");
	const child = spawn(["powershell.exe", "-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath], {
		cwd: dir,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
	return { stdout, stderr, exitCode: await child.exited };
}

/** Printed whenever a Windows check fails: a verdict with no evidence is a guess. */
function evidence(label: string, lines: Record<string, unknown>): void {
	console.log(`  ---- ${label}`);
	for (const [key, value] of Object.entries(lines)) {
		console.log(`       ${key}: ${JSON.stringify(value)}`);
	}
}

/**
 * `main.ts` imports the generated build-info module, which a fresh checkout does
 * not have (it is written during a build, never committed). Generating it is a
 * prerequisite of running the CLI at all, not part of what this proves.
 */
async function ensureBuildInfo(): Promise<void> {
	const generated = join(import.meta.dir, "..", "..", "shared", "build-info.generated.ts");
	if (existsSync(generated)) return;
	const script = join(import.meta.dir, "..", "..", "..", "scripts", "generate-build-info.ts");
	const child = spawn([process.execPath, script], { stdout: "pipe", stderr: "pipe" });
	if ((await child.exited) !== 0) throw new Error("could not generate build-info.generated.ts");
}

await ensureBuildInfo();
const root = mkdtempSync(join(tmpdir(), "dev3-pane-run-e2e-"));

try {
	console.log(`pane run executed on ${process.platform}`);

	const normal = await runPane(root, "run-0123456789ab", printMarkerAndExit(3));
	check(normal.log.includes(MARKER), "the command's non-ASCII output reached the log intact (UTF-8, not the code page)");
	check(normal.stdout.includes(MARKER), "the same output reached the pane");
	check(normal.status.state === "exited", `the run ended in state 'exited' (got ${String(normal.status.state)})`);
	check(normal.status.exitCode === 3, `the command's exit code 3 survived the shell (got ${String(normal.status.exitCode)})`);
	check(normal.cliExitCode === 0, `the runner itself exited 0 (got ${String(normal.cliExitCode)})`);

	if (IS_WINDOWS) {
		// CONTROL first, with the environment untouched: it separates "the wrapper this
		// dialect writes is good" from anything the stripped environment does to it.
		const control = await launchGeneratedScript(root, "wrapper-control");
		check(control.stdout.includes(MARKER), "a generated wrapper script runs through the dialect's own launch spec");
		check(control.exitCode === 5, `that script's exit code arrives (got ${String(control.exitCode)})`);
		if (!control.stdout.includes(MARKER) || control.exitCode !== 5) {
			evidence("control wrapper", { executable: control.executable, stdout: control.stdout, stderr: control.stderr });
		}

		// The child inherits this process's environment, so removing the variable HERE
		// is what puts both callers into the case under test — nothing is mocked, and the
		// shell anything finds is whatever PATH resolves.
		const saved = { SystemRoot: process.env.SystemRoot, SYSTEMROOT: process.env.SYSTEMROOT, WINDIR: process.env.WINDIR };
		delete process.env.SystemRoot;
		delete process.env.SYSTEMROOT;
		delete process.env.WINDIR;
		let stripped: RunOutcome;
		let generated: Awaited<ReturnType<typeof launchGeneratedScript>> | null = null;
		let launchError: unknown = null;
		let wouldHaveBeen: Awaited<ReturnType<typeof launchFallbackShell>>;
		try {
			stripped = await runPane(root, "run-0123456789ac", printMarkerAndExit(4));
			wouldHaveBeen = await launchFallbackShell(root);
			// A throw here IS the defect under test, so it becomes a named failure rather
			// than an uncaught crash that says nothing about which caller broke.
			try {
				generated = await launchGeneratedScript(root, "wrapper-stripped");
			} catch (err) {
				launchError = err;
			}
		} finally {
			for (const [name, value] of Object.entries(saved)) {
				if (value === undefined) delete process.env[name];
				else process.env[name] = value;
			}
		}

		// MEASURED, not assumed: in this environment the runner never starts. The child
		// bun process produces no output, writes no status and exits non-zero before any
		// dev3 code runs — %SystemRoot% is missing for it too. So `paneRunShell`'s own
		// refusal is unobservable HERE and is covered by its unit test instead; what is
		// observable is that nothing dev3 could do at the lookup would have helped.
		check(
			!stripped.status.state && stripped.cliExitCode !== 0,
			`the pane-run process could not start at all without %SystemRoot% (status ${String(stripped.status.state)}, exit ${String(stripped.cliExitCode)})`,
		);
		// The launch dialect IS reached in-process, so its refusal is the assertion that
		// carries the decision — restoring a PATH fallback turns these two red.
		check(generated === null, `the launch dialect refused too (it returned ${generated?.executable ?? "nothing"})`);
		check(
			String(launchError).includes("SystemRoot"),
			`and refused by name (${String(launchError)})`,
		);

		// What a fallback would have bought instead, launched for real in this same
		// environment: powershell.exe IS found on PATH, starts, and dies.
		check(
			!wouldHaveBeen.stdout.includes(MARKER),
			"a PATH-resolved powershell.exe produces nothing in this environment — which is why there is no fallback",
		);
		evidence("what a PATH fallback would have run", {
			exitCode: wouldHaveBeen.exitCode,
			stdoutHasMarker: wouldHaveBeen.stdout.includes(MARKER),
			stderr: wouldHaveBeen.stderr.replaceAll("\u0000", "").slice(0, 300),
		});
		evidence("pane run without %SystemRoot%", {
			state: stripped.status.state,
			exitCode: stripped.status.exitCode,
			detail: stripped.status.detail,
			cliExitCode: stripped.cliExitCode,
			stdout: stripped.stdout.slice(0, 300),
			stderr: stripped.stderr.slice(0, 300),
		});
	} else {
		console.log("  skip - the %SystemRoot% fallback is Windows-only; POSIX has no such variable");
	}
} finally {
	rmSync(root, { recursive: true, force: true });
}

if (failures > 0) {
	console.error(`\n${failures} check(s) failed`);
	process.exit(1);
}
console.log("\nALL CHECKS PASSED");
