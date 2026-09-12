import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import type { Project, Task } from "../../shared/types";

/**
 * The reader behind the traffic inspector's Conversation tab. What matters here
 * is the two stores: a running task answers from its live transcript, a finished
 * one from dev3's archived dump, and the same conversation must never appear
 * twice because both exist.
 */

const container = mkdtempSync(`${tmpdir()}/dev3-task-conv-`);
const live: { value: { conversation: Record<string, unknown>; mtimeMs: number }[] } = { value: [] };

vi.mock("../git", () => ({
	taskDir: (_project: unknown, task: { id: string }) => `${container}/${task.id}`,
	virtualWorkDir: (_project: unknown, task: { id: string }) => `${container}/${task.id}/work`,
}));

vi.mock("../conversation-parse", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../conversation-parse")>();
	return { ...actual, parseWorktreeConversations: () => live.value };
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
		startedAt: `2026-09-01T10:0${index}:00.000Z`,
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
	live.value = [];
});

describe("readTaskConversation", () => {
	it("reads an archived dump when the worktree is gone, and says so", () => {
		const task = taskWith("archived-only");
		writeDump(task, "claude-s1.json", {
			source: "claude",
			sessionId: "s1",
			model: "opus",
			startedAt: "2026-09-01T10:00:00.000Z",
			endedAt: "2026-09-01T11:00:00.000Z",
			turns: [turn(0, "do the thing", "done")],
			fidelity: { level: "full", warnings: [] },
		});

		const view = readTaskConversation(project, task);

		expect(view.sessions).toHaveLength(1);
		expect(view.sessions[0].origin).toBe("archived");
		expect(view.totalTurns).toBe(1);
		expect(view.turns[0].userText).toBe("do the thing");
		expect(view.turns[0].assistantText).toBe("done");
	});

	it("prefers the live transcript over its own archived copy", () => {
		const task = taskWith("live-and-archived");
		writeDump(task, "claude-s2.json", {
			source: "claude",
			sessionId: "s2",
			turns: [turn(0, "old", "old reply")],
			fidelity: { level: "full", warnings: [] },
		});
		live.value = [
			{
				conversation: {
					source: "claude",
					sessionId: "s2",
					sourcePath: "/transcripts/s2.jsonl",
					model: null,
					startedAt: "2026-09-02T10:00:00.000Z",
					endedAt: "2026-09-02T12:00:00.000Z",
					turns: [turn(0, "old", "old reply"), turn(1, "and more", "more reply")],
					fidelity: { level: "full", warnings: [] },
				},
				mtimeMs: 2,
			},
		];

		const view = readTaskConversation(project, task);

		expect(view.sessions).toHaveLength(1);
		expect(view.sessions[0].origin).toBe("live");
		expect(view.totalTurns).toBe(2);
	});

	it("pages backwards through a long conversation without losing the count", () => {
		const task = taskWith("long-history");
		const many = Array.from({ length: 30 }, (_, index) => turn(index, `ask ${index}`, `reply ${index}`));
		writeDump(task, "claude-s3.json", {
			source: "claude",
			sessionId: "s3",
			turns: many,
			fidelity: { level: "partial", warnings: ["unmapped record"] },
		});

		const newest = readTaskConversation(project, task, { limit: 10 });
		expect(newest.turns).toHaveLength(10);
		expect(newest.totalTurns).toBe(30);
		expect(newest.firstIndex).toBe(20);
		expect(newest.sessions[0].fidelity).toBe("partial");

		const earlier = readTaskConversation(project, task, {
			sessionKey: newest.sessionKey,
			before: newest.firstIndex,
			limit: 10,
		});
		expect(earlier.turns[0].index).toBe(10);
		expect(earlier.turns[earlier.turns.length - 1].index).toBe(19);
	});

	it("answers with no sessions rather than an error when nothing is readable", () => {
		const view = readTaskConversation(project, taskWith("nothing-here"));
		expect(view.sessions).toEqual([]);
		expect(view.turns).toEqual([]);
		expect(view.sessionKey).toBeNull();
	});
});
