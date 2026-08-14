/**
 * `dev3 pane` — the app side of running one command in a neighbouring pane of a
 * task's own terminal, and of reading what it printed (seq 1538).
 *
 * ONE story for every backend and every platform. It sits on the existing
 * backend-neutral primitive (`splitTaskPane`), so a tmux task splits a tmux pane
 * and a native task splits a SplitTree pane, and neither path knows about the
 * other. Nothing here spawns tmux, and nothing here asks which OS it is on except
 * `paneRunShell`, where the answer genuinely changes the command.
 *
 * The output channel is a FILE the pane writes as it runs, not a screen read. A
 * screen read is `captureView`, which returns `not-enabled` for every native pane
 * in production (decision 202) — so on Windows, where there is no tmux at all, it
 * would have given an agent nothing. See
 * `decisions/2026/08/14/backend-agnostic-pane-runs.md`.
 */

import { randomUUID } from "node:crypto";
import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	readSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { Task } from "../shared/types";
import { WINDOWS_DEV3_CLI_BASENAME, resolveDev3CliPath } from "../shared/dev3-cli-path";
import {
	clampPaneRunTail,
	decodePaneRunStatus,
	isPaneRunId,
	isPaneRunLabel,
	paneRunCommandProblem,
	paneRunTail,
	type PaneRunListing,
	type PaneRunPaneLine,
	type PaneRunPlacement,
	type PaneRunStatus,
	type PaneRunView,
} from "../shared/pane-runs";
import { DEV3_HOME } from "./paths";
import {
	PANE_RUN_VERB,
	paneRunDir,
	paneRunLogPath,
	paneRunSpecPath,
	paneRunStatusPath,
} from "./pane-run-store";
import { closeTaskPane, splitTaskPane, type AuxPaneHandle } from "./task-aux-panes";
import { nativeTaskPaneCommands, nativeTaskPanesState } from "./native-task-panes";
import { taskTerminalBackendIdentity } from "./task-terminal-backend";
import { DEFAULT_TMUX_SOCKET, PANE_START_COMMAND_FORMAT, taskSessionName, tmux, TmuxError } from "./tmux";
import { createLogger } from "./logger";

const log = createLogger("task-pane-runs");

/** A pane run was asked for on a task whose terminal cannot provide a pane. */
export class PaneRunError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PaneRunError";
	}
}

export interface StartPaneRunSpec {
	task: Task;
	command: string;
	placement: PaneRunPlacement;
	label?: string;
	/** Working directory for the command — the task worktree, resolved by the caller. */
	cwd: string;
	env: Record<string, string>;
}

export interface StartedPaneRun {
	runId: string;
	paneId: string;
	backend: "tmux" | "native";
	logPath: string;
	command: string;
}

/**
 * The absolute dev3 binary a pane launches. Never the `~`-prefixed frozen string:
 * a native pane is spawned directly, with no shell to expand a tilde.
 *
 * `DEV3_PANE_RUN_CLI` is a dev/test seam, not a feature: a source checkout can
 * exercise a real pane run without first installing its binary over the user's.
 * Production never sets it, and it is absent from `dev3 --help` on purpose.
 */
export function dev3CliExecutable(): string {
	const override = process.env.DEV3_PANE_RUN_CLI?.trim();
	if (override) return override;
	if (process.platform === "win32") {
		const resolved = resolveDev3CliPath();
		return resolved === WINDOWS_DEV3_CLI_BASENAME
			? join(DEV3_HOME, "bin", WINDOWS_DEV3_CLI_BASENAME)
			: resolved;
	}
	return join(DEV3_HOME, "bin", "dev3");
}

function posixQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

function newRunId(): string {
	return `run-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
}

function socketOf(task: Task): string {
	return task.tmuxSocket ?? DEFAULT_TMUX_SOCKET;
}

/**
 * Start one run. The spec file is written BEFORE the pane exists, so the pane's
 * process finds its command already on disk and nothing has to be quoted through a
 * launch argument.
 */
export async function startPaneRun(spec: StartPaneRunSpec): Promise<StartedPaneRun> {
	const problem = paneRunCommandProblem(spec.command);
	if (problem) throw new PaneRunError(`the command was refused: ${problem}`);
	const label = spec.label && isPaneRunLabel(spec.label) ? spec.label : "";

	const taskId = spec.task.id;
	const dir = paneRunDir(taskId);
	// 0700: the OS temp directory is shared with every other user on the machine,
	// and a run's spec names a command this user's shell will execute.
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const runId = newRunId();
	writeFileSync(
		paneRunSpecPath(dir, runId),
		`${JSON.stringify({
			runId,
			taskId,
			command: spec.command,
			cwd: spec.cwd,
			label,
			requestedAt: new Date().toISOString(),
		})}\n`,
		"utf8",
	);

	const cli = dev3CliExecutable();
	const argv = [PANE_RUN_VERB, dir, runId];
	let handle: AuxPaneHandle;
	try {
		handle = await splitTaskPane({
			task: spec.task,
			placement: spec.placement,
			size: "40%",
			cwd: spec.cwd,
			env: spec.env,
			socket: socketOf(spec.task),
			title: label || "Run",
			// The run id sits in the launch command on BOTH backends, which is how a pane
			// is re-found later without anything being remembered in RAM (the same trick
			// the auxiliary panes use with their script paths).
			tmuxCommand: [cli, ...argv].map(posixQuote).join(" "),
			nativeLaunch: { executable: cli, argv },
			// Native hands input focus back to the pane that had it, so a run an agent
			// started does not take its keyboard (tmux behaves as it does for every
			// other dev3 pane: the new pane becomes active).
			restoreFocus: true,
		});
	} catch (err) {
		// No pane means no run. A spec left behind would show up as a phantom run with
		// an unknowable outcome in every later `dev3 pane list`.
		rmSync(paneRunSpecPath(dir, runId), { force: true });
		throw err;
	}

	log.info("Started a pane run", { taskId: taskId.slice(0, 8), runId, backend: handle.backend, paneId: handle.paneId });
	return {
		runId,
		paneId: handle.paneId,
		backend: handle.backend,
		logPath: paneRunLogPath(dir, runId),
		command: spec.command,
	};
}

/**
 * Every pane of this task that is executing a run, keyed by run id. Read ONCE per
 * command: on tmux each lookup is a process spawn and on native it is a pane-set
 * sweep, so asking per run turned a listing of ten runs into ten backend queries.
 */
async function runPanes(task: Task): Promise<Map<string, AuxPaneHandle>> {
	const found = new Map<string, AuxPaneHandle>();
	if (taskTerminalBackendIdentity(task) === "native") {
		for (const pane of await nativeTaskPaneCommands(task.id)) {
			const runId = runIdOfCommand(pane.command.join(" "));
			if (runId && !found.has(runId)) found.set(runId, { backend: "native", paneId: pane.paneId });
		}
		return found;
	}
	try {
		const rows = await tmux.listPanes(PANE_START_COMMAND_FORMAT, {
			target: taskSessionName(task.id),
			socket: socketOf(task),
		});
		for (const row of rows) {
			const runId = runIdOfCommand(row.startCommand);
			if (runId && !found.has(runId)) found.set(runId, { backend: "tmux", paneId: row.paneId });
		}
	} catch (err) {
		// A task whose tmux session is gone genuinely owns no pane. Anything else is
		// a lookup that could not run, and must not read as "there is no pane".
		if (err instanceof TmuxError) return found;
		throw err;
	}
	return found;
}

/** The pane currently executing `runId`, or null when it is gone. */
async function findRunPane(task: Task, runId: string): Promise<AuxPaneHandle | null> {
	return (await runPanes(task)).get(runId) ?? null;
}

function readStatus(dir: string, runId: string): { status: PaneRunStatus | null; detail: string | null } {
	const path = paneRunStatusPath(dir, runId);
	if (!existsSync(path)) return { status: null, detail: "the run has not written a status file yet" };
	try {
		const status = decodePaneRunStatus(JSON.parse(readFileSync(path, "utf8")) as unknown);
		return status
			? { status, detail: null }
			: { status: null, detail: "the run's status file could not be believed" };
	} catch (err) {
		return { status: null, detail: `the run's status file could not be read: ${String(err)}` };
	}
}

function readSpecFile(dir: string, runId: string): { command: string; label: string } {
	try {
		const parsed = JSON.parse(readFileSync(paneRunSpecPath(dir, runId), "utf8")) as Record<string, unknown>;
		return {
			command: typeof parsed.command === "string" ? parsed.command : "",
			label: typeof parsed.label === "string" ? parsed.label : "",
		};
	} catch {
		return { command: "", label: "" };
	}
}

/**
 * Never pull more than this into the app's memory for one read. A run is meant for
 * servers and watchers, whose log grows without bound — reading a multi-gigabyte
 * file whole to hand back 200 lines would stall the app long before the tail
 * existed. Far more than the 2000-line ceiling can hold, so a full tail still fits.
 */
const LOG_WINDOW_BYTES = 4 * 1024 * 1024;

/**
 * The last {@link LOG_WINDOW_BYTES} of a run's log. `windowed` says the file was
 * longer than that, which makes any line count taken from this text a floor.
 */
function readLogWindow(logPath: string, runId: string): { text: string; windowed: boolean } {
	let size: number;
	try {
		size = statSync(logPath).size;
	} catch {
		return { text: "", windowed: false };
	}
	try {
		if (size <= LOG_WINDOW_BYTES) return { text: readFileSync(logPath, "utf8"), windowed: false };
		const fd = openSync(logPath, "r");
		try {
			const buffer = Buffer.allocUnsafe(LOG_WINDOW_BYTES);
			const read = readSync(fd, buffer, 0, LOG_WINDOW_BYTES, size - LOG_WINDOW_BYTES);
			const text = buffer.toString("utf8", 0, read);
			// The window opens mid-line, and possibly mid-character: drop everything up
			// to the first newline rather than hand back half a line as if it were one.
			const firstBreak = text.indexOf("\n");
			return { text: firstBreak >= 0 ? text.slice(firstBreak + 1) : "", windowed: true };
		} finally {
			closeSync(fd);
		}
	} catch (err) {
		log.warn("Could not read a pane run log", { runId, error: String(err) });
		return { text: "", windowed: false };
	}
}

function logHasOutput(logPath: string): boolean {
	try {
		return statSync(logPath).size > 0;
	} catch {
		return false;
	}
}

/**
 * A run's bounded tail plus its outcome. The tail is bounded BEFORE it is returned,
 * so a dev server that has been writing for an hour cannot arrive in an agent's
 * context whole — nor in the app's memory on the way there.
 */
export async function readPaneRun(task: Task, runId: string, lines?: number): Promise<PaneRunView> {
	if (!isPaneRunId(runId)) throw new PaneRunError(`${JSON.stringify(runId)} is not a run id`);
	const dir = paneRunDir(task.id);
	const logPath = paneRunLogPath(dir, runId);
	if (!existsSync(paneRunSpecPath(dir, runId))) {
		throw new PaneRunError(`task ${task.id.slice(0, 8)} has no run ${runId}`);
	}
	const { command, label } = readSpecFile(dir, runId);
	const { status, detail } = readStatus(dir, runId);
	const pane = await findRunPane(task, runId);

	const window = readLogWindow(logPath, runId);
	const { lines: tail, totalLines } = paneRunTail(window.text, clampPaneRunTail(lines));

	return {
		runId,
		label,
		command,
		paneId: pane?.paneId ?? "",
		backend: pane?.backend ?? taskTerminalBackendIdentity(task),
		status,
		statusDetail: detail,
		logPath,
		lines: tail,
		// A windowed log is truncated even when the tail covers every line the window
		// held — otherwise "showing all 200 lines" would describe a gigabyte-long file.
		truncated: window.windowed || tail.length < totalLines,
		totalLines,
		logWindowed: window.windowed,
	};
}

/**
 * Every run of this task, newest first, each with a short tail-free summary.
 * `panes` is passed in so a caller that already read the pane set does not make
 * the backend answer the same question twice.
 */
async function listRuns(task: Task, panes?: Map<string, AuxPaneHandle>): Promise<PaneRunView[]> {
	const dir = paneRunDir(task.id);
	if (!existsSync(dir)) return [];
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return [];
	}
	const runIds = names
		.filter((name) => name.endsWith(".run.json"))
		.map((name) => name.slice(0, -".run.json".length))
		.filter(isPaneRunId)
		.sort((a, b) => runMtime(dir, b) - runMtime(dir, a));

	// ONE pane read for the whole listing, and no log read at all: a listing names
	// outcomes, it does not carry logs, and reading every run's log to count lines
	// nobody prints is exactly how a listing gets expensive.
	const paneOfRun = panes ?? (await runPanes(task));
	const backend = taskTerminalBackendIdentity(task);
	return runIds.map((runId) => {
		const { command, label } = readSpecFile(dir, runId);
		const { status, detail } = readStatus(dir, runId);
		const pane = paneOfRun.get(runId) ?? null;
		return {
			runId,
			label,
			command,
			paneId: pane?.paneId ?? "",
			backend: pane?.backend ?? backend,
			status,
			statusDetail: detail,
			logPath: paneRunLogPath(dir, runId),
			lines: [],
			// Not "the tail was cut" here but "there is output to read with
			// `dev3 pane logs`" — the listing deliberately carries none of it.
			truncated: logHasOutput(paneRunLogPath(dir, runId)),
			totalLines: 0,
		};
	});
}

function runMtime(dir: string, runId: string): number {
	try {
		return statSync(paneRunSpecPath(dir, runId)).mtimeMs;
	} catch {
		return 0;
	}
}

/**
 * What an agent needs before it can act: which backend it is actually on, which
 * pane is its own, and whether a pane's SCREEN can be read here at all. Stated by
 * the CLI rather than inferred from the platform — the native backend is not
 * Windows-only, and that inference would rot.
 */
export async function paneRunListing(task: Task, selfPaneId: string | null): Promise<PaneRunListing> {
	const backend = taskTerminalBackendIdentity(task);
	const panes: PaneRunPaneLine[] = [];
	// The pane set is read here, once, and the run list is told what it found —
	// asking the backend again per run is what made a listing cost a spawn per run.
	const paneOfRun = new Map<string, AuxPaneHandle>();

	if (backend === "native") {
		const state = await nativeTaskPanesState(task.id);
		const commands = state ? await nativeTaskPaneCommands(task.id) : [];
		state?.panes.forEach((pane, index) => {
			const command = commands.find((entry) => entry.paneId === pane.paneId)?.command.join(" ") ?? "";
			const runId = runIdOfCommand(command);
			if (runId && !paneOfRun.has(runId)) paneOfRun.set(runId, { backend: "native", paneId: pane.paneId });
			panes.push({
				paneId: pane.paneId,
				index: index + 1,
				label: command.slice(0, 60),
				active: pane.paneId === state.activePaneId,
				self: selfPaneId === pane.paneId,
				alive: pane.alive,
				runId,
			});
		});
	} else {
		try {
			const rows = await tmux.listPanes(PANE_START_COMMAND_FORMAT, {
				target: taskSessionName(task.id),
				socket: socketOf(task),
			});
			rows.forEach((row, index) => {
				const runId = runIdOfCommand(row.startCommand);
				if (runId && !paneOfRun.has(runId)) paneOfRun.set(runId, { backend: "tmux", paneId: row.paneId });
				panes.push({
					paneId: row.paneId,
					index: index + 1,
					label: row.startCommand.slice(0, 60),
					active: false,
					self: selfPaneId === row.paneId,
					alive: null,
					runId,
				});
			});
		} catch (err) {
			if (!(err instanceof TmuxError)) throw err;
		}
	}
	const runs = await listRuns(task, paneOfRun);

	return {
		backend,
		// The honest capability, not a platform guess: tmux reads a pane's screen with
		// capture-pane, and a native pane publishes no capture artifact in production.
		screenReadable: backend === "tmux",
		screenReadableDetail:
			backend === "tmux"
				? "`dev3 peek --pane <N>` returns this pane's screen text"
				: "the native backend publishes no screen snapshot (decision 202), so `dev3 peek` returns a pane summary without a tail — use `dev3 pane run` + `dev3 pane logs` for output you need to read",
		selfPaneId,
		panes,
		runs,
	};
}

/**
 * The run a launch command is executing. The LAST match wins: the run id is the
 * command's final argument, while the run directory earlier in it is a path that
 * must never be mistaken for one.
 */
function runIdOfCommand(command: string): string | null {
	const matches = command.match(/run-[0-9a-f]{12}/g);
	return matches ? matches[matches.length - 1] : null;
}

/** Close the pane a run is executing in. Killing the pane kills the command. */
export async function closePaneRun(task: Task, runId: string): Promise<{ closed: boolean }> {
	if (!isPaneRunId(runId)) throw new PaneRunError(`${JSON.stringify(runId)} is not a run id`);
	const pane = await findRunPane(task, runId);
	if (!pane) return { closed: false };
	await closeTaskPane(task, pane, socketOf(task));
	log.info("Closed a pane run", { taskId: task.id.slice(0, 8), runId, paneId: pane.paneId });
	return { closed: true };
}
