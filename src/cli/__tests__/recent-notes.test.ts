/**
 * Recent task notes reaching a new conversation: the Claude `SessionStart`
 * adapter, the Codex hook's startup answer, and `dev3 note recent` (what the
 * Claude `/dev3` skill injects). Synthetic notes only.
 *
 * Output shape checked against Codex 0.159.0's embedded
 * `session-start.command.output` schema (additionalProperties: false) and
 * Claude Code's documented `hookSpecificOutput.additionalContext`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CliContext } from "../context";
import type { TaskNote } from "../../shared/types";

vi.mock("../socket-client", () => ({
	sendRequest: vi.fn(),
}));

import { sendRequest } from "../socket-client";
import { handleClaudeSessionStart, handleNoteRecent } from "../commands/recent-notes";
import { handleCodexHook } from "../commands/codex-hook";

const mockSend = vi.mocked(sendRequest);
const SOCKET = "/tmp/test.sock";
const CONTEXT: CliContext = { projectId: "project-1", taskId: "task-own", socketPath: SOCKET };

function note(n: number, content: string): TaskNote {
	const createdAt = new Date(Date.UTC(2026, 8, 1, 9, n)).toISOString();
	return { id: `${String(n).padStart(2, "0")}bbbbbb-0000-0000-0000-000000000000`, content, source: "ai", createdAt, updatedAt: createdAt };
}

const OWN_NOTES = Array.from({ length: 7 }, (_, i) => note(i, `own finding ${i}`));

/** A socket that answers note.list per task, like the app does, and acks status hooks. */
function serveNotes(byTask: Record<string, TaskNote[]>): void {
	mockSend.mockImplementation(async (_socket, method, params) => {
		if (method === "note.list") return { id: "1", ok: true, data: byTask[(params as { taskId: string }).taskId] ?? [] };
		return { id: "1", ok: true, data: {} };
	});
}

function sessionStart(source: string): string {
	return JSON.stringify({ hook_event_name: "SessionStart", source, session_id: "s-1", cwd: "/tmp/wt", model: "m", permission_mode: "default", transcript_path: null });
}

function additionalContext(output: string): string {
	const parsed = JSON.parse(output) as Record<string, unknown>;
	expect(Object.keys(parsed)).toEqual(["hookSpecificOutput"]);
	const specific = parsed.hookSpecificOutput as Record<string, unknown>;
	expect(Object.keys(specific).sort()).toEqual(["additionalContext", "hookEventName"]);
	expect(specific.hookEventName).toBe("SessionStart");
	return specific.additionalContext as string;
}

let stdout = "";
let stderr = "";
let stdoutSpy: ReturnType<typeof vi.spyOn>;
let stderrSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	stdout = "";
	stderr = "";
	stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
		stdout += String(chunk);
		return true;
	});
	stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
		stderr += String(chunk);
		return true;
	});
	mockSend.mockReset();
});

afterEach(() => {
	stdoutSpy.mockRestore();
	stderrSpy.mockRestore();
});

describe("Claude SessionStart adapter", () => {
	it.each(["startup", "clear", "compact"])("injects the newest five on %s", async (source) => {
		serveNotes({ "task-own": OWN_NOTES });
		await handleClaudeSessionStart(sessionStart(source), SOCKET, CONTEXT);
		const block = additionalContext(stdout);
		expect(block).toContain("The 5 newest of 7 notes");
		expect(block).toContain("> own finding 6");
		expect(block).not.toContain("> own finding 1");
		expect(block).toContain("`dev3 note show <id>`");
	});

	it("stays silent on resume — that transcript already holds its block", async () => {
		serveNotes({ "task-own": OWN_NOTES });
		await handleClaudeSessionStart(sessionStart("resume"), SOCKET, CONTEXT);
		expect(stdout).toBe("");
		expect(mockSend).not.toHaveBeenCalled();
	});

	it("reads only its own task — never a sibling variant's or another task's notes", async () => {
		serveNotes({
			"task-own": [note(1, "mine")],
			"task-sibling-variant": [note(2, "SIBLING SECRET")],
			"task-other": [note(3, "OTHER TASK")],
		});
		await handleClaudeSessionStart(sessionStart("startup"), SOCKET, CONTEXT);
		expect(mockSend).toHaveBeenCalledTimes(1);
		expect(mockSend.mock.calls[0]![2]).toEqual({ taskId: "task-own", projectId: "project-1" });
		const block = additionalContext(stdout);
		expect(block).toContain("> mine");
		expect(block).not.toContain("SIBLING");
		expect(block).not.toContain("OTHER TASK");
	});

	it("injects nothing when the task has no notes", async () => {
		serveNotes({});
		await handleClaudeSessionStart(sessionStart("startup"), SOCKET, CONTEXT);
		expect(stdout).toBe("");
	});

	it("never blocks startup when the app is offline or the socket errors", async () => {
		await handleClaudeSessionStart(sessionStart("startup"), null, CONTEXT);
		expect(stdout).toBe("");
		mockSend.mockRejectedValue(new Error("ECONNREFUSED"));
		await handleClaudeSessionStart(sessionStart("startup"), SOCKET, CONTEXT);
		expect(stdout).toBe("");
		expect(stderr).toContain("ECONNREFUSED");
	});

	it("does nothing outside a dev3 task or for a malformed payload", async () => {
		await handleClaudeSessionStart(sessionStart("startup"), SOCKET, null);
		await handleClaudeSessionStart("not json", SOCKET, CONTEXT);
		expect(stdout).toBe("");
	});
});

describe("Codex hook — startup notes", () => {
	it("answers SessionStart startup with the block AND still syncs status", async () => {
		serveNotes({ "task-own": OWN_NOTES });
		await handleCodexHook(sessionStart("startup"), SOCKET, CONTEXT);
		expect(mockSend.mock.calls.map((call) => call[1]).sort()).toEqual(["note.list", "task.agentHook"]);
		expect(additionalContext(stdout)).toContain("The 5 newest of 7 notes");
	});

	it.each(["resume", "clear", "compact", "fork"])("keeps the bare {} on %s", async (source) => {
		serveNotes({ "task-own": OWN_NOTES });
		await handleCodexHook(sessionStart(source), SOCKET, CONTEXT);
		expect(stdout).toBe("{}");
		expect(mockSend.mock.calls.map((call) => call[1])).toEqual(["task.agentHook"]);
	});

	it("keeps the bare {} on every other event", async () => {
		serveNotes({ "task-own": OWN_NOTES });
		await handleCodexHook(JSON.stringify({ hook_event_name: "Stop" }), SOCKET, CONTEXT);
		expect(stdout).toBe("{}");
	});

	it("falls back to {} with no notes, offline, or a failing note.list", async () => {
		serveNotes({});
		await handleCodexHook(sessionStart("startup"), SOCKET, CONTEXT);
		await handleCodexHook(sessionStart("startup"), null, CONTEXT);
		mockSend.mockImplementation(async (_s, method) =>
			method === "note.list" ? { id: "1", ok: false, error: "boom" } : { id: "1", ok: true, data: {} });
		await handleCodexHook(sessionStart("startup"), SOCKET, CONTEXT);
		expect(stdout).toBe("{}{}{}");
	});
});

describe("dev3 note recent", () => {
	const args = (flags: Record<string, string> = {}) => ({ flags, positional: [], flagValues: {} }) as never;

	it("prints the same bounded block for the current task", async () => {
		serveNotes({ "task-own": OWN_NOTES });
		await handleNoteRecent(args(), SOCKET, CONTEXT);
		expect(stdout).toContain("## Recent dev3 notes on this task");
		expect(stdout).toContain("> own finding 6");
		expect(mockSend.mock.calls[0]![2]).toEqual({ taskId: "task-own", projectId: "project-1" });
	});

	it("says so plainly when there are none", async () => {
		serveNotes({});
		await handleNoteRecent(args(), SOCKET, CONTEXT);
		expect(stdout).toBe("No notes on this task yet.\n");
	});

	it("answers offline with one line instead of failing the skill load", async () => {
		await handleNoteRecent(args(), null, CONTEXT);
		expect(stdout).toBe("Recent notes unavailable (the dev3 app is not running). Try `dev3 note list` later.\n");
	});

	it("reads another task only when asked explicitly with --task", async () => {
		serveNotes({ "seq:42": [note(1, "theirs")] });
		await handleNoteRecent(args({ task: "seq:42" }), SOCKET, CONTEXT);
		expect(stdout).toContain("> theirs");
	});
});
