import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Task } from "../../shared/types";
import { parseClaudeTranscript } from "../../shared/conversation-parsers";

const parseWorktreeConversations = vi.fn();

vi.mock("../conversation-parse", async () => {
	const actual = await vi.importActual<typeof import("../conversation-parse")>("../conversation-parse");
	return { ...actual, parseWorktreeConversations: (...args: unknown[]) => parseWorktreeConversations(...args) };
});

const { handoffPrompt, prepareTaskHandoff, previewTaskHandoff } = await import("../conversation-handoff");

function jsonl(...records: unknown[]): string {
	return `${records.map((r) => JSON.stringify(r)).join("\n")}\n`;
}

function transcript(prompt: string): string {
	return jsonl(
		{ type: "ai-title", aiTitle: "T", sessionId: "sess-1" },
		{
			type: "user", uuid: "u0", sessionId: "sess-1", cwd: "/w", gitBranch: "main",
			timestamp: "2026-08-20T10:00:00.000Z",
			message: { role: "user", content: [{ type: "text", text: prompt }] },
		},
		{
			type: "assistant", uuid: "a0", parentUuid: "u0", sessionId: "sess-1",
			timestamp: "2026-08-20T10:00:01.000Z",
			message: { role: "assistant", content: [{ type: "text", text: "done" }] },
		},
	);
}

let container: string;
let task: Task;

beforeEach(() => {
	container = mkdtempSync(join(tmpdir(), "dev3-handoff-"));
	task = { id: "t1", worktreePath: join(container, "worktree") } as Task;
	parseWorktreeConversations.mockReset();
	parseWorktreeConversations.mockReturnValue([
		{ conversation: parseClaudeTranscript(transcript("BUILD THE THING"), "/t.jsonl"), mtimeMs: 2 },
	]);
});

afterEach(() => rmSync(container, { recursive: true, force: true }));

describe("previewTaskHandoff", () => {
	it("describes the conversation a handoff would retell", () => {
		expect(previewTaskHandoff(task)).toMatchObject({ source: "claude", sessionId: "sess-1", turns: 1 });
	});

	it("answers null when the task has no worktree, without touching the parser", () => {
		expect(previewTaskHandoff({ ...task, worktreePath: null } as Task)).toBeNull();
		expect(parseWorktreeConversations).not.toHaveBeenCalled();
	});

	it("answers null when nothing parseable ran in the worktree", () => {
		parseWorktreeConversations.mockReturnValue([]);
		expect(previewTaskHandoff(task)).toBeNull();
	});
});

describe("prepareTaskHandoff", () => {
	it("writes the retelling beside the task's dumps, not inside the worktree", async () => {
		const prepared = await prepareTaskHandoff(task);
		expect(prepared?.path).toBe(join(container, "conversations", "handoff-claude-sess-1.md"));
		// The container outlives the worktree, so a completed task keeps its handoff.
		expect(prepared?.path.startsWith(join(container, "worktree"))).toBe(false);
	});

	it("writes a body that names itself a retelling and carries the request", async () => {
		const prepared = await prepareTaskHandoff(task);
		const body = readFileSync(prepared!.path, "utf-8");
		expect(body).toContain("You are taking over work that ran in Claude Code");
		expect(body).toContain("BUILD THE THING");
		expect(body).toContain("Retold from a claude transcript by dev3");
		expect(prepared?.chars).toBe(body.length);
	});

	it("takes the newest session, which is the one the parser returns first", async () => {
		parseWorktreeConversations.mockReturnValue([
			{ conversation: parseClaudeTranscript(transcript("NEWEST"), "/new.jsonl"), mtimeMs: 9 },
			{ conversation: parseClaudeTranscript(transcript("OLDER"), "/old.jsonl"), mtimeMs: 1 },
		]);
		const prepared = await prepareTaskHandoff(task);
		expect(readFileSync(prepared!.path, "utf-8")).toContain("NEWEST");
	});

	it("returns null rather than writing an empty file when nothing parsed", async () => {
		parseWorktreeConversations.mockReturnValue([]);
		expect(await prepareTaskHandoff(task)).toBeNull();
	});
});

describe("handoffPrompt", () => {
	it("points at the file and denies ownership of everything in it", async () => {
		const prepared = await prepareTaskHandoff(task);
		const prompt = handoffPrompt(prepared!);

		expect(prompt).toContain(prepared!.path);
		expect(prompt).toContain("RETELLING");
		expect(prompt).toContain("You did none of it, and nothing in it is still running.");
		// It is typed into a pane, so it has to stay one short line's worth of text.
		expect(prompt.length).toBeLessThan(1_000);
		expect(prompt).not.toContain("\n");
	});

	it("names the agent the work actually ran in", async () => {
		expect(handoffPrompt({ ...(await prepareTaskHandoff(task))!, source: "codex" })).toContain("ran in Codex");
	});
});
