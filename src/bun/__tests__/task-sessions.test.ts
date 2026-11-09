import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project, Task } from "../../shared/types";

const home = mkdtempSync(join(tmpdir(), "dev3-task-sessions-"));
vi.mock("../git", () => ({ taskDir: (_p: Project, t: Task) => `${home}/worktrees/proj/${t.id}` }));
vi.mock("../logger", () => ({
	createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const { _resetTaskSessionsCacheForTests, rememberTaskSession, taskSessionIds } = await import("../task-sessions");
const { transcriptInSessions } = await import("../conversation-parse");

const originalDev3Home = process.env.DEV3_HOME;
const project = { id: "p1", path: "/home/me/notes" } as Project;
const folderTask = { id: "t1", worktreePath: "/home/me/notes" } as Task;

beforeEach(() => {
	process.env.DEV3_HOME = home;
	_resetTaskSessionsCacheForTests();
});

afterEach(() => {
	if (originalDev3Home === undefined) delete process.env.DEV3_HOME;
	else process.env.DEV3_HOME = originalDev3Home;
	rmSync(join(home, "worktrees"), { recursive: true, force: true });
});

describe("task sessions in a shared folder", () => {
	it("remembers every session a hook reports, once each", () => {
		rememberTaskSession(project, folderTask, "aaaa");
		rememberTaskSession(project, folderTask, "bbbb");
		rememberTaskSession(project, folderTask, "aaaa");

		const file = JSON.parse(readFileSync(`${home}/worktrees/proj/t1/agent-sessions.json`, "utf-8"));
		expect(file.sessionIds).toEqual(["aaaa", "bbbb"]);
	});

	it("adds the ids on the task's panes, which a launch assigns before any hook fires", () => {
		rememberTaskSession(project, folderTask, "aaaa");
		const task = { ...folderTask, sessionState: { panes: [{ sessionId: "pane-id" }] } } as unknown as Task;
		expect(taskSessionIds(project, task, task.worktreePath)?.sort()).toEqual(["aaaa", "pane-id"]);
	});

	it("does not filter a worktree dev3 owns, and records nothing for it", () => {
		const worktree = `${home}/worktrees/proj/t9/worktree`;
		mkdirSync(worktree, { recursive: true });
		const task = { id: "t9", worktreePath: worktree } as Task;
		rememberTaskSession(project, task, "aaaa");
		expect(taskSessionIds(project, task, worktree)).toBeNull();
	});
});

describe("transcriptInSessions", () => {
	const ID = "11111111-1111-4111-8111-111111111111";

	it("matches the id every store puts in the file name", () => {
		expect(transcriptInSessions(`/x/${ID}.jsonl`, [ID])).toBe(true);
		expect(transcriptInSessions(`/x/rollout-2026-10-04T10-00-00-${ID}.jsonl`, [ID.toUpperCase()])).toBe(true);
	});

	it("drops a file of another session, and one with no id in its name", () => {
		expect(transcriptInSessions(`/x/${ID}.jsonl`, ["22222222-2222-4222-8222-222222222222"])).toBe(false);
		expect(transcriptInSessions("/x/chat.json", [ID])).toBe(false);
	});

	it("keeps everything when there is no scope", () => {
		expect(transcriptInSessions("/x/chat.json", null)).toBe(true);
	});
});
