/**
 * The process a pane run's pane actually runs (`dev3 __pane-run <dir> <runId>`).
 *
 * It is the dev3 CLI talking to itself, and that is the whole trick: the pane's
 * foreground process is a program we wrote, not a shell pipeline, so the SAME
 * implementation mirrors output on macOS, Linux and Windows. The one thing that
 * genuinely differs per platform — how a command string becomes a process — is
 * `paneRunShell`, authored per dialect.
 *
 * Why not `tee` / `Tee-Object`: they are two different programs with two different
 * quoting rules and two different default encodings, and the Windows one writes
 * UTF-16LE. A dialect-specific pipeline is exactly the assumption that broke the
 * Windows publish leg; this file has no pipeline at all.
 *
 * Output goes to two places at once: the pane (so the user watches it live) and the
 * log file (so the agent can read it afterwards). Bytes are written to the log
 * verbatim, so nothing re-encodes what the command printed.
 */

import { appendFileSync, closeSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "../../bun/spawn";
import { paneRunShell, paneRunLogPath, paneRunSpecPath, paneRunStatusPath } from "../../bun/pane-run-store";
import { decodePaneRunSpec, isPaneRunId, type PaneRunSpec, type PaneRunState } from "../../shared/pane-runs";
import { CLI_EXIT_CODE_SUCCESS } from "../../shared/cli-exit-codes";
import { exitInternalError, exitUsage } from "../output";

interface StatusPatch {
	state: PaneRunState;
	pid?: number | null;
	exitCode?: number | null;
	startedAt?: string | null;
	endedAt?: string | null;
	detail?: string | null;
}

/**
 * The status file is rewritten whole on every transition. A reader that catches a
 * partial write sees an undecodable file and reports the status as unknown, which
 * is the honest answer — never "not running".
 */
function writeStatus(dir: string, runId: string, patch: StatusPatch): void {
	const payload = {
		runId,
		state: patch.state,
		pid: patch.pid ?? null,
		exitCode: patch.exitCode ?? null,
		startedAt: patch.startedAt ?? null,
		endedAt: patch.endedAt ?? null,
		detail: patch.detail ?? null,
	};
	writeFileSync(paneRunStatusPath(dir, runId), `${JSON.stringify(payload)}\n`, "utf8");
}

function readSpec(dir: string, runId: string): PaneRunSpec {
	const raw = readFileSync(paneRunSpecPath(dir, runId), "utf8");
	const spec = decodePaneRunSpec(JSON.parse(raw) as unknown);
	if (!spec || spec.runId !== runId) throw new Error(`run ${runId} has an unusable spec file`);
	return spec;
}

/** Mirror one chunk to the pane and to the log, in that order. */
function mirror(logFd: number, chunk: Uint8Array): void {
	process.stdout.write(chunk);
	appendFileSync(logFd, chunk);
}

async function pump(stream: unknown, logFd: number): Promise<void> {
	if (!stream || typeof stream !== "object") return;
	for await (const chunk of stream as AsyncIterable<Uint8Array>) mirror(logFd, chunk);
}

/**
 * Hold the pane open after the command ends, so a finished build stays on screen
 * instead of the pane vanishing the moment it succeeds. The agent never needs this
 * — it reads the log — so the wait exists purely for the human watching.
 */
async function waitForDismissal(): Promise<void> {
	process.stdout.write("[dev3] press Enter to close this pane\n");
	for await (const _chunk of Bun.stdin.stream()) {
		void _chunk;
		return;
	}
}

export async function handlePaneExec(rawArgs: string[]): Promise<void> {
	const [dir, runId] = rawArgs;
	if (!dir || !isPaneRunId(runId)) {
		exitUsage("Usage: dev3 __pane-run <run-dir> <run-id>   (internal — started by `dev3 pane run`)");
		return;
	}

	let spec: PaneRunSpec;
	try {
		spec = readSpec(dir, runId);
	} catch (err) {
		// Nothing can be logged against a run whose spec is unreadable, and the pane
		// must not sit there looking like a command that produced no output.
		writeStatus(dir, runId, { state: "failed", detail: `the run spec could not be read: ${String(err)}` });
		exitInternalError(`dev3 pane run ${runId}: the run spec could not be read (${String(err)})`);
		return;
	}

	const logFd = openSync(paneRunLogPath(dir, runId), "a");
	writeStatus(dir, runId, { state: "starting", startedAt: new Date().toISOString() });
	process.stdout.write(`[dev3] run ${runId}: ${spec.command}\n`);

	let shell: ReturnType<typeof paneRunShell>;
	try {
		shell = paneRunShell(spec.command, { platform: process.platform, env: process.env });
	} catch (err) {
		writeStatus(dir, runId, { state: "failed", detail: String(err) });
		closeSync(logFd);
		exitInternalError(`dev3 pane run ${runId}: ${String(err)}`);
		return;
	}

	const startedAt = new Date().toISOString();
	let child: ReturnType<typeof spawn>;
	try {
		child = spawn([shell.executable, ...shell.argv], {
			cwd: spec.cwd,
			// stdin is closed on purpose: a pane run is for non-interactive work
			// (builds, tests, servers). An interactive command belongs in a plain
			// split the user drives themselves.
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
	} catch (err) {
		writeStatus(dir, runId, { state: "failed", startedAt, detail: `the command could not start: ${String(err)}` });
		closeSync(logFd);
		exitInternalError(`dev3 pane run ${runId}: the command could not start (${String(err)})`);
		return;
	}

	writeStatus(dir, runId, { state: "running", pid: child.pid, startedAt });

	await Promise.all([pump(child.stdout, logFd), pump(child.stderr, logFd)]);
	const exitCode = await child.exited;
	// A signal death surfaces as a null exit code, not as a made-up number: the
	// difference between "the build failed" and "something killed the build" is
	// exactly what an agent must not have to guess.
	const signalled = typeof child.signalCode === "string" && child.signalCode.length > 0;
	writeStatus(dir, runId, {
		state: "exited",
		pid: child.pid,
		exitCode: signalled ? null : exitCode,
		startedAt,
		endedAt: new Date().toISOString(),
		detail: signalled ? `killed by ${child.signalCode}` : null,
	});

	const ending = signalled ? `killed by ${child.signalCode}` : `exit code ${exitCode}`;
	const summary = `[dev3] run ${runId} finished — ${ending}\n`;
	mirror(logFd, new TextEncoder().encode(summary));
	closeSync(logFd);

	await waitForDismissal();
	process.exit(CLI_EXIT_CODE_SUCCESS);
}
