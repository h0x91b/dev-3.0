import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Task } from "../../shared/types";
import { claudeEncodePath } from "../../shared/conversation-search-core";

const parseConversation = vi.fn();
const runHandoffJob = vi.fn();

vi.mock("../../shared/conversation-parsers", async () => {
	const actual = await vi.importActual<typeof import("../../shared/conversation-parsers")>("../../shared/conversation-parsers");
	parseConversation.mockImplementation(actual.parseConversation);
	return { ...actual, parseConversation: (...args: Parameters<typeof actual.parseConversation>) => parseConversation(...args) };
});

vi.mock("../conversation-handoff-runner", async () => {
	const actual = await vi.importActual<typeof import("../conversation-handoff-runner")>("../conversation-handoff-runner");
	runHandoffJob.mockImplementation(actual.runHandoffJob);
	return { ...actual, runHandoffJob: (...args: Parameters<typeof actual.runHandoffJob>) => runHandoffJob(...args) };
});

const { _resetHandoffPreviewCacheForTests, handoffPrompt, prepareTaskHandoff, previewTaskHandoff } = await import("../conversation-handoff");

function jsonl(...records: unknown[]): string {
	return `${records.map((r) => JSON.stringify(r)).join("\n")}\n`;
}

function transcript(prompt: string, sessionId = "sess-1"): string {
	return jsonl(
		{ type: "ai-title", aiTitle: "T", sessionId },
		{
			type: "user", uuid: "u0", sessionId, cwd: "/w", gitBranch: "main",
			timestamp: "2026-08-20T10:00:00.000Z",
			message: { role: "user", content: [{ type: "text", text: prompt }] },
		},
		{
			type: "assistant", uuid: "a0", parentUuid: "u0", sessionId,
			timestamp: "2026-08-20T10:00:01.000Z",
			message: { role: "assistant", content: [{ type: "text", text: "done" }] },
		},
	);
}

let container: string;
let home: string;
let task: Task;

/** Write a Claude transcript for the task's worktree with an explicit mtime (seconds). */
function seed(name: string, body: string, mtime: number): string {
	const dir = join(home, ".claude", "projects", claudeEncodePath(task.worktreePath!));
	mkdirSync(dir, { recursive: true });
	const path = join(dir, name);
	writeFileSync(path, body);
	utimesSync(path, mtime, mtime);
	return path;
}

beforeEach(() => {
	container = mkdtempSync(join(tmpdir(), "dev3-handoff-"));
	home = join(container, "home");
	task = { id: "t1", worktreePath: join(container, "worktree") } as Task;
	_resetHandoffPreviewCacheForTests();
	parseConversation.mockClear();
	runHandoffJob.mockClear();
	seed("sess-1.jsonl", transcript("BUILD THE THING"), 1_000);
});

afterEach(() => rmSync(container, { recursive: true, force: true }));

describe("previewTaskHandoff", () => {
	it("describes the conversation a handoff would retell", async () => {
		expect(await previewTaskHandoff(task, { home })).toMatchObject({ source: "claude", sessionId: "sess-1", turns: 1 });
	});

	it("answers null when the task has no worktree, without touching the parser", async () => {
		expect(await previewTaskHandoff({ ...task, worktreePath: null } as Task, { home })).toBeNull();
		expect(runHandoffJob).not.toHaveBeenCalled();
	});

	it("answers null when nothing parseable ran in the worktree", async () => {
		expect(await previewTaskHandoff(task, { home: join(container, "empty-home") })).toBeNull();
	});

	it("goes through the handoff runner, which keeps the parse off the host thread", async () => {
		await previewTaskHandoff(task, { home });
		expect(runHandoffJob).toHaveBeenCalledWith(expect.objectContaining({ kind: "preview", worktreePath: task.worktreePath }), expect.anything());
	});

	it("parses only the newest transcript, not every session the task had", async () => {
		seed("sess-2.jsonl", transcript("OLDER", "sess-2"), 500);
		seed("sess-3.jsonl", transcript("NEWEST", "sess-3"), 2_000);

		expect(await previewTaskHandoff(task, { home })).toMatchObject({ sessionId: "sess-3" });
		expect(parseConversation).toHaveBeenCalledTimes(1);
	});

	it("falls back to the next newest when the newest cannot be read", async () => {
		const unreadable = seed("sess-3.jsonl", transcript("NEWEST", "sess-3"), 2_000);
		chmodSync(unreadable, 0o000);

		expect(await previewTaskHandoff(task, { home })).toMatchObject({ sessionId: "sess-1" });
	});

	it("reopening the dialog reuses the preview until the transcript changes", async () => {
		await previewTaskHandoff(task, { home });
		await previewTaskHandoff(task, { home });
		expect(parseConversation).toHaveBeenCalledTimes(1);

		seed("sess-1.jsonl", transcript("BUILD THE THING") + transcript("MORE"), 1_500);
		expect(await previewTaskHandoff(task, { home })).toMatchObject({ turns: 2 });
		expect(parseConversation).toHaveBeenCalledTimes(2);
	});

	it("shares one scan between opens that overlap", async () => {
		const [a, b] = await Promise.all([previewTaskHandoff(task, { home }), previewTaskHandoff(task, { home })]);
		expect(a).toEqual(b);
		expect(runHandoffJob).toHaveBeenCalledTimes(1);
	});
});

describe("prepareTaskHandoff", () => {
	it("writes the retelling beside the task's dumps, not inside the worktree", async () => {
		const prepared = await prepareTaskHandoff(task, { home });
		expect(prepared?.path).toBe(join(container, "conversations", "handoff-claude-sess-1.md"));
		// The container outlives the worktree, so a completed task keeps its handoff.
		expect(prepared?.path.startsWith(join(container, "worktree"))).toBe(false);
	});

	it("writes a body that names itself a retelling and carries the request", async () => {
		const prepared = await prepareTaskHandoff(task, { home });
		const body = readFileSync(prepared!.path, "utf-8");
		expect(body).toContain("You are taking over work that ran in Claude Code");
		expect(body).toContain("BUILD THE THING");
		expect(body).toContain("Retold from a claude transcript by dev3");
		expect(prepared?.chars).toBe(body.length);
	});

	it("takes the newest session and renders it through the handoff runner", async () => {
		seed("sess-2.jsonl", transcript("NEWEST", "sess-2"), 9_000);
		const prepared = await prepareTaskHandoff(task, { home });
		expect(readFileSync(prepared!.path, "utf-8")).toContain("NEWEST");
		expect(runHandoffJob).toHaveBeenCalledWith(expect.objectContaining({ kind: "render" }), expect.anything());
	});

	it("returns null rather than writing an empty file when nothing parsed", async () => {
		expect(await prepareTaskHandoff(task, { home: join(container, "empty-home") })).toBeNull();
	});
});

describe("handoffPrompt", () => {
	it("points at the file and denies ownership of everything in it", async () => {
		const prepared = await prepareTaskHandoff(task, { home });
		const prompt = handoffPrompt(prepared!);

		expect(prompt).toContain(prepared!.path);
		expect(prompt).toContain("RETELLING");
		expect(prompt).toContain("You did none of it, and nothing in it is still running.");
		// It is typed into a pane, so it has to stay one short line's worth of text.
		expect(prompt.length).toBeLessThan(1_000);
		expect(prompt).not.toContain("\n");
	});

	it("names the agent the work actually ran in", async () => {
		expect(handoffPrompt({ ...(await prepareTaskHandoff(task, { home }))!, source: "codex" })).toContain("ran in Codex");
	});
});
