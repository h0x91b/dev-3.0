import type { TaskNote } from "../../shared/types";
import { renderRecentNotesContext } from "../../shared/recent-notes-context";
import type { ParsedArgs } from "../args";
import { expandShortId, resolveProjectId, type CliContext } from "../context";
import { rejectUnknownFlags } from "../flag-validation";
import { sendRequest } from "../socket-client";

export type RecentNotesResult =
	| { kind: "block"; block: string }
	| { kind: "empty" }
	| { kind: "unavailable"; reason: string };

/**
 * Fetch one task's notes and render the bounded block. Never throws: callers
 * are session-start hooks and skill injection, which must not be blocked by it.
 */
export async function loadRecentNotesBlock(
	socketPath: string | null,
	taskId: string | undefined,
	projectId: string | undefined,
): Promise<RecentNotesResult> {
	if (!taskId) return { kind: "unavailable", reason: "not inside a dev3 task worktree" };
	if (!socketPath) return { kind: "unavailable", reason: "the dev3 app is not running" };
	try {
		const response = await sendRequest(socketPath, "note.list", {
			taskId,
			...(projectId ? { projectId } : {}),
		}, { timeoutMs: 3_000, connectAttempts: 2, retryDelayMs: 50 });
		if (!response.ok) return { kind: "unavailable", reason: response.error || "note.list failed" };
		const notes = Array.isArray(response.data) ? response.data as TaskNote[] : [];
		const block = renderRecentNotesContext(notes);
		return block ? { kind: "block", block } : { kind: "empty" };
	} catch (error) {
		return { kind: "unavailable", reason: error instanceof Error ? error.message : String(error) };
	}
}

/**
 * `dev3 note recent` — the same block the session-start hooks inject. It exits 0
 * even when the app is offline, because the Claude `/dev3` skill runs it as an
 * injection and a failing command there must not break the skill load.
 */
export async function handleNoteRecent(
	args: ParsedArgs,
	socketPath: string | null,
	context: CliContext | null,
): Promise<void> {
	rejectUnknownFlags(args, ["task", "task-id", "project"]);
	const rawTaskId = args.flags.task || args.flags["task-id"] || context?.taskId;
	const taskId = rawTaskId ? expandShortId(rawTaskId, context) : undefined;
	const projectId = resolveProjectId(args.flags.project, context) ?? undefined;
	const result = await loadRecentNotesBlock(socketPath, taskId, projectId);
	switch (result.kind) {
		case "block":
			process.stdout.write(`${result.block}\n`);
			return;
		case "empty":
			process.stdout.write("No notes on this task yet.\n");
			return;
		case "unavailable":
			process.stdout.write(`Recent notes unavailable (${result.reason}). Try \`dev3 note list\` later.\n`);
	}
}

/** Claude Code `SessionStart` sources that begin a conversation without this task's notes in it. */
const CLAUDE_CONTEXT_SOURCES = new Set(["startup", "clear", "compact"]);

function sessionStartSource(rawInput: string): string | undefined {
	try {
		const parsed = JSON.parse(rawInput) as Record<string, unknown>;
		if (parsed.hook_event_name !== "SessionStart") return undefined;
		return typeof parsed.source === "string" ? parsed.source : undefined;
	} catch {
		return undefined;
	}
}

export function sessionStartContextOutput(block: string): string {
	return JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: block } });
}

/**
 * Internal adapter for Claude Code's `SessionStart` hook: answer with the task's
 * recent notes as `additionalContext`. Quiet and exit 0 on every path — no
 * notes, app offline, a resumed transcript that already carries them.
 */
export async function handleClaudeSessionStart(
	rawInput: string,
	socketPath: string | null,
	context: CliContext | null,
): Promise<void> {
	const source = sessionStartSource(rawInput);
	if (!source || !CLAUDE_CONTEXT_SOURCES.has(source)) return;
	const result = await loadRecentNotesBlock(socketPath, context?.taskId, context?.projectId);
	if (result.kind === "block") process.stdout.write(sessionStartContextOutput(result.block));
	else if (result.kind === "unavailable") process.stderr.write(`dev3 SessionStart hook: ${result.reason}\n`);
}
