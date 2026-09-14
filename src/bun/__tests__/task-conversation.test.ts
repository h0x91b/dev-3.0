import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import type { Project, Task } from "../../shared/types";

/**
 * The reader behind the traffic inspector's Conversation tab. Two things matter
 * here: the two stores (a running task answers from its live transcript, a
 * finished one from dev3's archived dump, and the same conversation never
 * appears twice), and the laziness — listing six sessions must open zero files,
 * because parsing all of them is what made the first read take 20.6 s.
 */

const container = mkdtempSync(`${tmpdir()}/dev3-task-conv-`);
const transcripts: { value: { kind: string; path: string }[] } = { value: [] };
const parsed = vi.fn((path: string) => ({
	source: "claude",
	sessionId: "live",
	sourcePath: path,
	model: "opus",
	turns: [turn(0, "live prompt", "live reply")],
	fidelity: { level: "partial", warnings: ["unmapped"] },
}));

vi.mock("../git", () => ({
	taskDir: (_project: unknown, task: { id: string }) => `${container}/${task.id}`,
	virtualWorkDir: (_project: unknown, task: { id: string }) => `${container}/${task.id}/work`,
}));

vi.mock("../conversation-search", () => ({
	transcriptFilesForWorktree: () => transcripts.value,
}));

vi.mock("../conversation-parse", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../conversation-parse")>();
	return { ...actual, parseTranscriptFile: (path: string) => parsed(path) };
});

const { readTaskConversation } = await import("../task-conversation");

const project = { id: "p1", name: "P", path: "/repo", kind: "git" } as unknown as Project;

/** Each test owns a task id, because a dump directory is keyed on it. */
function taskWith(id: string): Task {
	const worktreePath = `${container}/${id}/worktree`;
	mkdirSync(worktreePath, { recursive: true });
	return { id, worktreePath } as unknown as Task;
}

function messageEvent(seq: number, role: "user" | "assistant", text: string) {
	return { id: String(seq), seq, kind: "message", role, text };
}

function turn(index: number, prompt: string, reply: string) {
	return {
		index,
		startedAt: `2026-09-01T10:00:00.000Z`,
		endedAt: null,
		events: [messageEvent(index * 2, "user", prompt), messageEvent(index * 2 + 1, "assistant", reply)],
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
}

function writeDump(task: Task, name: string, body: Record<string, unknown>) {
	const dir = `${container}/${task.id}/conversations`;
	mkdirSync(dir, { recursive: true });
	writeFileSync(`${dir}/${name}`, JSON.stringify(body));
}

beforeEach(() => {
	transcripts.value = [];
	parsed.mockClear();
});

describe("readTaskConversation", () => {
	it("reads an archived dump when the worktree is gone, and says so", () => {
		const task = taskWith("archived-only");
		writeDump(task, "claude-s1.json", {
			source: "claude",
			sessionId: "s1",
			model: "opus",
			turns: [turn(0, "do the thing", "done")],
			fidelity: { level: "full", warnings: [] },
		});

		const view = readTaskConversation(project, task);

		expect(view.sessions).toHaveLength(1);
		expect(view.sessions[0].origin).toBe("archived");
		expect(view.sessions[0].sessionId).toBe("s1");
		expect(view.totalTurns).toBe(1);
		expect(view.turns[0].userText).toBe("do the thing");
		expect(view.turns[0].assistantText).toBe("done");
	});

	it("opens only the selected session, whatever else the task owns", () => {
		const task = taskWith("many-sessions");
		transcripts.value = [
			{ kind: "claude", path: `${container}/${task.id}/worktree/a.jsonl` },
			{ kind: "claude", path: `${container}/${task.id}/worktree/b.jsonl` },
			{ kind: "gemini", path: `${container}/${task.id}/worktree/c.json` },
		];
		writeDump(task, "codex-9999.json", { source: "codex", sessionId: "9999", turns: [turn(0, "old", "old")] });

		const view = readTaskConversation(project, task);

		// Three sessions listed — the unparseable gemini file is not one of them —
		// and listing them opened no transcript at all.
		expect(view.sessions).toHaveLength(3);
		expect(parsed).not.toHaveBeenCalled();

		const live = view.sessions.find((session) => session.origin === "live");
		const picked = readTaskConversation(project, task, { sessionKey: live?.key });
		expect(parsed).toHaveBeenCalledTimes(1);
		expect(picked.fidelity).toBe("partial");
		expect(picked.model).toBe("opus");
	});

	it("prefers the live transcript over its own archived copy", () => {
		const task = taskWith("live-and-archived");
		// Both stores name the session in the file name — Claude's `<uuid>.jsonl` and
		// the dump's `<source>-<uuid>.json` — which is how they pair without a parse.
		const uuid = "11111111-2222-3333-4444-555555555555";
		writeDump(task, `claude-${uuid}.json`, { source: "claude", sessionId: uuid, turns: [turn(0, "old", "old")] });
		transcripts.value = [{ kind: "claude", path: `${container}/${task.id}/worktree/${uuid}.jsonl` }];

		const view = readTaskConversation(project, task);

		expect(view.sessions).toHaveLength(1);
		expect(view.sessions[0].origin).toBe("live");
		expect(view.turns[0].userText).toBe("live prompt");
	});

	it("pages backwards through a long conversation without losing the count", () => {
		const task = taskWith("long-history");
		const many = Array.from({ length: 30 }, (_, index) => turn(index, `ask ${index}`, `reply ${index}`));
		writeDump(task, "claude-s3.json", { source: "claude", sessionId: "s3", turns: many });

		const newest = readTaskConversation(project, task, { limit: 10 });
		expect(newest.turns).toHaveLength(10);
		expect(newest.totalTurns).toBe(30);
		expect(newest.firstIndex).toBe(20);

		const earlier = readTaskConversation(project, task, {
			sessionKey: newest.sessionKey,
			before: newest.firstIndex,
			limit: 10,
		});
		expect(earlier.turns[0].index).toBe(10);
		expect(earlier.turns[earlier.turns.length - 1].index).toBe(19);
	});

	it("sends a long message whole, so the panel can open it without another read", () => {
		const task = taskWith("long-turn");
		const long = "x".repeat(12_000);
		writeDump(task, "claude-s4.json", { source: "claude", sessionId: "s4", turns: [turn(0, long, "ok")] });

		const view = readTaskConversation(project, task);
		expect(view.turns[0].userText).toHaveLength(12_000);
		expect(view.turns[0].clippedChars).toBe(0);
	});

	it("still refuses to carry a pathological message, and counts what it left", () => {
		const task = taskWith("pathological-turn");
		const huge = "x".repeat(60_000);
		writeDump(task, "claude-s5.json", { source: "claude", sessionId: "s5", turns: [turn(0, huge, "ok")] });

		const view = readTaskConversation(project, task);
		expect(view.turns[0].clippedChars).toBe(10_000);
		expect(view.turns[0].userText?.endsWith("…")).toBe(true);
	});

	it("answers with no sessions rather than an error when nothing is readable", () => {
		const view = readTaskConversation(project, taskWith("nothing-here"));
		expect(view.sessions).toEqual([]);
		expect(view.turns).toEqual([]);
		expect(view.sessionKey).toBeNull();
	});
});
