/**
 * The backend-neutral vocabulary of a PANE RUN: one command an agent asked dev3
 * to run in a neighbouring pane of its own task terminal, plus the bounded record
 * of what that command printed and how it ended.
 *
 * A pane run exists because `dev3 peek` cannot serve this story. Peek reads a
 * pane's SCREEN, and on the native backend a screen read is `not-enabled` in
 * production (decision 202) — so on Windows, where tmux does not exist, an agent
 * had no way to see the output of anything it started. A run does not read a
 * screen: the command's own output is mirrored into a file as it is produced, so
 * the same words reach the user's eyes and the agent's context on both backends
 * and on every platform.
 *
 * Two different questions, two different nouns, no overlap:
 *  • `dev3 peek` — what is on a pane right now, for a pane nobody promised you.
 *  • `dev3 pane logs` — what the command YOU started printed, and how it ended.
 *
 * Pure: no node/Bun imports, so every rule here is unit-testable under all three
 * vitest configs.
 */

import { tailLinesWithCount } from "./task-peek";

/** Default tail budget — a dev server writes forever, so a read is never "all of it". */
export const PANE_RUN_TAIL_DEFAULT_LINES = 200;

/** Hard ceiling on one read, so an agent cannot paste a build log into its context. */
export const PANE_RUN_TAIL_MAX_LINES = 2000;

/** Longest command string accepted, so a runaway paste cannot become a launch. */
export const PANE_RUN_COMMAND_MAX_LENGTH = 4000;

/** Longest label accepted. Labels are cosmetic; a long one is a mistake, not a need. */
export const PANE_RUN_LABEL_MAX_LENGTH = 40;

/** Where the new pane lands relative to the agent's own pane. */
export type PaneRunPlacement = "right" | "below";

/**
 * A run id is minted by the app and appears in a file name, a process argv, and a
 * pane's launch command, so it stays deliberately narrow.
 */
const RUN_ID_PATTERN = /^run-[0-9a-f]{12}$/;

export const PANE_RUN_ID_RULE = RUN_ID_PATTERN.source;

export function isPaneRunId(value: unknown): value is string {
	return typeof value === "string" && RUN_ID_PATTERN.test(value);
}

/** A label is only ever shown to a human; anything exotic is dropped, not escaped. */
const LABEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ._-]*$/;

export function isPaneRunLabel(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= PANE_RUN_LABEL_MAX_LENGTH &&
		LABEL_PATTERN.test(value)
	);
}

/** What the app wrote down before the pane existed. The runner reads exactly this. */
export interface PaneRunSpec {
	readonly runId: string;
	readonly taskId: string;
	/** The command as the agent typed it, interpreted by the pane's platform shell. */
	readonly command: string;
	readonly cwd: string;
	readonly label: string;
	/** ISO-8601, from the app's clock — the runner never invents a start time. */
	readonly requestedAt: string;
}

/**
 * How a run ended, or that it has not. `starting` exists because the pane's
 * process may not have reached its first write yet, and reporting that as
 * "running" would let an agent read an empty log as "the build printed nothing".
 */
export type PaneRunState = "starting" | "running" | "exited" | "failed";

export interface PaneRunStatus {
	readonly runId: string;
	readonly state: PaneRunState;
	/** Pid of the command itself (not the runner), once spawned. */
	readonly pid: number | null;
	/**
	 * Exit code, present only for `exited`. `null` with `state: "exited"` means the
	 * command was killed by a signal — a real outcome, not a missing field.
	 */
	readonly exitCode: number | null;
	readonly startedAt: string | null;
	readonly endedAt: string | null;
	/** Why a `failed` run never ran, in one plain sentence. */
	readonly detail: string | null;
}

/** A status file that cannot be believed reads as unknown, never as "not running". */
export function decodePaneRunStatus(raw: unknown): PaneRunStatus | null {
	if (!raw || typeof raw !== "object") return null;
	const value = raw as Record<string, unknown>;
	if (!isPaneRunId(value.runId)) return null;
	const state = value.state;
	if (state !== "starting" && state !== "running" && state !== "exited" && state !== "failed") return null;
	const pid = typeof value.pid === "number" && Number.isInteger(value.pid) ? value.pid : null;
	const exitCode = typeof value.exitCode === "number" && Number.isInteger(value.exitCode) ? value.exitCode : null;
	return {
		runId: value.runId,
		state,
		pid,
		exitCode,
		startedAt: typeof value.startedAt === "string" ? value.startedAt : null,
		endedAt: typeof value.endedAt === "string" ? value.endedAt : null,
		detail: typeof value.detail === "string" && value.detail.length > 0 ? value.detail : null,
	};
}

export function decodePaneRunSpec(raw: unknown): PaneRunSpec | null {
	if (!raw || typeof raw !== "object") return null;
	const value = raw as Record<string, unknown>;
	if (!isPaneRunId(value.runId)) return null;
	if (typeof value.taskId !== "string" || value.taskId.length === 0) return null;
	if (typeof value.command !== "string" || value.command.length === 0) return null;
	if (typeof value.cwd !== "string" || value.cwd.length === 0) return null;
	return {
		runId: value.runId,
		taskId: value.taskId,
		command: value.command,
		cwd: value.cwd,
		label: typeof value.label === "string" ? value.label : "",
		requestedAt: typeof value.requestedAt === "string" ? value.requestedAt : "",
	};
}

/** A command the CLI must refuse before a pane is ever opened. */
export function paneRunCommandProblem(command: unknown): string | null {
	if (typeof command !== "string" || command.trim().length === 0) return "the command is empty";
	if (command.length > PANE_RUN_COMMAND_MAX_LENGTH) {
		return `the command is longer than ${PANE_RUN_COMMAND_MAX_LENGTH} characters`;
	}
	// A NUL cannot survive argv or a status file, and a bare CR/LF would make the
	// pane run a second, unreviewed command.
	if (/[\0\r\n]/.test(command)) return "the command contains a newline or a NUL byte";
	return null;
}

/**
 * The bounded tail of a run's log, plus how much there was. Escape sequences are
 * stripped with the same function `dev3 peek` uses, so both surfaces hand an agent
 * plain text and neither one leaks a progress-bar redraw into its context.
 */
export function paneRunTail(text: string, limit: number): { lines: string[]; totalLines: number } {
	return tailLinesWithCount(text, limit);
}

/** Clamp a requested tail to the documented window. Out-of-range is corrected, not refused. */
export function clampPaneRunTail(lines: unknown): number {
	const requested = typeof lines === "number" ? lines : Number(lines);
	if (!Number.isFinite(requested)) return PANE_RUN_TAIL_DEFAULT_LINES;
	return Math.max(1, Math.min(PANE_RUN_TAIL_MAX_LINES, Math.floor(requested)));
}

/**
 * What one pane run looks like to a reader. `truncated` is stated rather than
 * implied: an agent that cannot tell a tail from a whole log will report the
 * first error it sees as the first error there was.
 */
export interface PaneRunView {
	readonly runId: string;
	readonly label: string;
	readonly command: string;
	readonly paneId: string;
	readonly backend: "tmux" | "native";
	readonly status: PaneRunStatus | null;
	/** Why the status is unknown, when it is. */
	readonly statusDetail: string | null;
	readonly logPath: string;
	readonly lines: readonly string[];
	readonly truncated: boolean;
	readonly totalLines: number;
	/**
	 * The log was longer than the window ONE read pulls into memory, so `totalLines`
	 * counts that window and is a floor, not the file's line count. Stated rather
	 * than implied: "the last 200 of 200 lines" would otherwise read as the whole log.
	 */
	readonly logWindowed?: boolean;
}

/** One line naming the run's outcome — the thing an agent must not have to infer. */
export function paneRunOutcomeLine(view: PaneRunView): string {
	const status = view.status;
	if (!status) return `outcome: unknown — ${view.statusDetail ?? "the run's status file could not be read"}`;
	switch (status.state) {
		case "starting":
		case "running":
			// A run dies with its pane — that is exactly what `dev3 pane close` does —
			// and a killed runner never gets to write its final status. So a status still
			// saying "running" with no pane behind it is a stale file, not a live command,
			// and reporting it as running would leave an agent waiting for an ending that
			// already happened.
			if (!view.paneId) {
				return "outcome: gone — the pane running it is no longer there, so the command has stopped; the tail is everything it printed";
			}
			return status.state === "starting"
				? "outcome: starting — the command has not reported a pid yet"
				: `outcome: still running${status.pid ? ` (pid ${status.pid})` : ""} — an empty tail means quiet, not finished`;
		case "exited":
			return status.exitCode === null
				? "outcome: finished — killed by a signal, no exit code"
				: `outcome: finished — exit code ${status.exitCode}`;
		case "failed":
			return `outcome: never ran — ${status.detail ?? "the pane could not start the command"}`;
	}
}

export function renderPaneRunLog(view: PaneRunView): string {
	const head = [
		`run ${view.runId}${view.label ? ` · ${view.label}` : ""} · pane ${view.paneId} (${view.backend})`,
		`command: ${view.command}`,
		paneRunOutcomeLine(view),
		view.truncated
			? `showing the last ${view.lines.length} of ${view.totalLines}${view.logWindowed ? "+" : ""} lines · full log: ${view.logPath}`
			: `showing all ${view.lines.length} line${view.lines.length === 1 ? "" : "s"} · log: ${view.logPath}`,
	];
	return `${head.join("\n")}\n\n${view.lines.join("\n")}${view.lines.length ? "\n" : ""}`;
}

/** One pane of a task's terminal, as an agent needs to see it. */
export interface PaneRunPaneLine {
	readonly paneId: string;
	readonly index: number;
	readonly label: string;
	readonly active: boolean;
	readonly self: boolean;
	readonly alive: boolean | null;
	/** The run this pane is executing, when dev3 started it. */
	readonly runId: string | null;
}

export interface PaneRunListing {
	readonly backend: "tmux" | "native";
	/** Whether this backend can be asked for a pane's screen text (`dev3 peek --pane`). */
	readonly screenReadable: boolean;
	readonly screenReadableDetail: string;
	readonly selfPaneId: string | null;
	readonly panes: readonly PaneRunPaneLine[];
	readonly runs: readonly PaneRunView[];
}

export function renderPaneRunListing(listing: PaneRunListing): string {
	const lines: string[] = [
		`terminal backend: ${listing.backend}`,
		`screen text of a pane you did not start: ${listing.screenReadable ? "readable" : "NOT readable"} — ${listing.screenReadableDetail}`,
		"",
		"panes:",
	];
	if (listing.panes.length === 0) {
		lines.push("  (none — this task has no running terminal)");
	}
	for (const pane of listing.panes) {
		const marks = [
			pane.self ? "you" : null,
			pane.active ? "active" : null,
			pane.alive === false ? "dead" : null,
			pane.runId ? `run ${pane.runId}` : null,
		].filter(Boolean);
		lines.push(`  ${pane.index}. ${pane.paneId} ${pane.label}${marks.length ? ` [${marks.join(", ")}]` : ""}`);
	}
	lines.push("", "runs:");
	if (listing.runs.length === 0) {
		lines.push("  (none — start one with `dev3 pane run \"<command>\"`)");
	}
	for (const run of listing.runs) {
		lines.push(`  ${run.runId}${run.label ? ` · ${run.label}` : ""} · ${paneRunOutcomeLine(run).replace(/^outcome: /, "")}`);
		lines.push(`    ${run.command}`);
	}
	return `${lines.join("\n")}\n`;
}
