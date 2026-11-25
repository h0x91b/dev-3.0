import { unlinkSync } from "node:fs";
import { open, readFile } from "node:fs/promises";
import { launchDialect } from "../../shared/platform-launch";
import type { CliToastMessageKey } from "../../shared/types";
import { dev3TaskTempPath } from "../temp-paths";

/** Files of one cleanup run: the user's script, its wrapper, and what the wrapper records. */
export interface CleanupScriptFiles {
	wrapper: string;
	body: string;
	status: string;
	log: string;
}

export type CleanupOutcome =
	| { kind: "ok" }
	| { kind: "failed"; exitCode: number }
	| { kind: "unfinished"; reason: string };

const TAIL_LINES = 20;
const TAIL_CHARS = 2000;
// CSI sequences and OSC sequences (titles etc.), as a script's own output carries them.
const ANSI_PATTERN = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;

export function cleanupScriptFiles(taskId: string): CleanupScriptFiles {
	const ext = launchDialect().scriptExtension;
	return {
		wrapper: dev3TaskTempPath(taskId, `cleanup${ext}`),
		body: dev3TaskTempPath(taskId, `cleanup-body${ext}`),
		status: dev3TaskTempPath(taskId, "cleanup-status"),
		log: dev3TaskTempPath(taskId, "cleanup-log"),
	};
}

/**
 * POSIX only: the tmux client exits 0 whatever the script did, so the wrapper
 * records the script's own status and its output. A file, not `| tee`: a child the
 * script leaves running would hold a pipe open and stall the teardown.
 */
export function buildCleanupWrapper(files: CleanupScriptFiles, runBody: string): string {
	const dialect = launchDialect();
	const rc = "__DEV3_CLEANUP_RC";
	return `${[
		...dialect.header(),
		"{",
		runBody,
		dialect.captureExitCode(rc),
		dialect.writeExitCodeFile(rc, files.status),
		`} > ${dialect.quote(files.log)} 2>&1`,
	].join("\n")}\n`;
}

export function removeCleanupRunFiles(files: CleanupScriptFiles, only: Array<keyof CleanupScriptFiles> = ["wrapper", "body", "status", "log"]): void {
	for (const key of only) {
		try {
			unlinkSync(files[key]);
		} catch {
			// Already gone, or never written.
		}
	}
}

/** The script's own exit code, or null when the wrapper never recorded one. */
export async function readCleanupExitCode(files: CleanupScriptFiles): Promise<number | null> {
	try {
		const text = (await readFile(files.status, "utf8")).trim();
		return /^\d+$/.test(text) ? Number(text) : null;
	} catch {
		return null;
	}
}

/** Only this much of the log's end is read, however large the script made it. */
export const CLEANUP_LOG_READ_BYTES = 16 * 1024;

export async function readCleanupLogTail(files: CleanupScriptFiles): Promise<string> {
	try {
		const handle = await open(files.log, "r");
		try {
			const { size } = await handle.stat();
			const start = Math.max(0, size - CLEANUP_LOG_READ_BYTES);
			const buffer = Buffer.alloc(size - start);
			const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
			let text = buffer.subarray(0, bytesRead).toString("utf8").replace(ANSI_PATTERN, "").replace(/\r/g, "");
			// A read that began mid-file starts on a cut line (and maybe a cut character).
			// Keep that line when it is all there is: the 2000-char cap trims its cut head.
			const rest = text.slice(text.indexOf("\n") + 1);
			if (start > 0 && rest.trim() !== "") text = rest;
			const tail = text.split("\n").filter((line) => line.trim() !== "").slice(-TAIL_LINES).join("\n");
			return tail.length > TAIL_CHARS ? tail.slice(-TAIL_CHARS) : tail;
		} finally {
			await handle.close();
		}
	} catch {
		return "";
	}
}

/** `hasNote`: a deleted task has nothing to hold the note, so the toast must not point at one. */
export function cleanupToastContent(
	outcome: Exclude<CleanupOutcome, { kind: "ok" }>,
	hasNote: boolean,
): { message: string; messageKey: CliToastMessageKey; messageParams?: Record<string, number> } {
	const tail = hasNote ? " — see the task's notes." : ".";
	if (outcome.kind === "failed") {
		return {
			message: `Cleanup script failed (exit ${outcome.exitCode}). Leftovers may remain${tail}`,
			messageKey: hasNote ? "kanban.cleanupFailed" : "kanban.cleanupFailedDeleted",
			messageParams: { code: outcome.exitCode },
		};
	}
	return {
		message: `Cleanup script did not finish (${outcome.reason}). Leftovers may remain${tail}`,
		messageKey: hasNote ? "kanban.cleanupUnfinished" : "kanban.cleanupUnfinishedDeleted",
	};
}

export function cleanupNoteContent(outcome: Exclude<CleanupOutcome, { kind: "ok" }>, logTail: string): string {
	return [
		outcome.kind === "failed"
			? `Cleanup script failed with exit code ${outcome.exitCode}.`
			: `Cleanup script did not finish: ${outcome.reason}.`,
		"What it should have removed (containers, databases, caches) may still be there.",
		"Last output:",
		"```",
		logTail.replaceAll("```", "'''") || "(no output)",
		"```",
	].join("\n");
}
