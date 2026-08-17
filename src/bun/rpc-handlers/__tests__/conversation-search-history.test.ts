/**
 * Title/overview history lives in a per-task sidecar, so the search handler has
 * to hydrate it. A silent regression here is invisible: the search still
 * returns results, it just stops scoring everything a task was ever called.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Task } from "../../../shared/types";

const mocks = vi.hoisted(() => ({
	getProject: vi.fn(),
	loadTasks: vi.fn(),
	readAllTaskBlobs: vi.fn(),
	searchConversations: vi.fn((_input: { tasks: Array<{ historyTexts: string[] }> }) => [] as unknown[]),
}));

vi.mock("../../data", () => ({ getProject: mocks.getProject, loadTasks: mocks.loadTasks }));
vi.mock("../../task-blobs", () => ({ readAllTaskBlobs: mocks.readAllTaskBlobs }));
vi.mock("../../conversation-search", () => ({ searchConversations: mocks.searchConversations }));
vi.mock("../../git", () => ({ projectSlug: () => "slug" }));
vi.mock("../shared", () => ({
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { conversationSearchHandlers } from "../conversation-search-handlers";

const task = (over: Partial<Task>): Task =>
	({ id: "t1", title: "Now", description: "", status: "completed", ...over }) as Task;

beforeEach(() => {
	vi.clearAllMocks();
	mocks.searchConversations.mockReturnValue([]);
	mocks.getProject.mockResolvedValue({ id: "p1", path: "/repo" });
});

function historyTextsPassedToEngine(): string[] {
	const call = mocks.searchConversations.mock.calls[0]?.[0];
	if (!call) throw new Error("the search engine was never called");
	return call.tasks[0].historyTexts;
}

describe("searchConversations history hydration", () => {
	it("feeds the engine the history archived in the task's sidecar", async () => {
		mocks.loadTasks.mockResolvedValue([task({ history: [] })]);
		mocks.readAllTaskBlobs.mockResolvedValue(
			new Map([["t1", { taskId: "t1", savedAt: "x", history: [{ at: "2026-01-01T00:00:00Z", changed: "title", title: "Old name", overview: "Old plan" }] }]]),
		);

		await conversationSearchHandlers.searchConversations({ projectId: "p1", query: "old" });

		expect(historyTextsPassedToEngine()).toEqual(["Old name", "Old plan"]);
	});

	it("unions a downgraded version's in-file history with the sidecar", async () => {
		mocks.loadTasks.mockResolvedValue([
			task({ history: [{ at: "2026-02-01T00:00:00Z", changed: "title", title: "Rollback name", overview: null }] }),
		]);
		mocks.readAllTaskBlobs.mockResolvedValue(
			new Map([["t1", { taskId: "t1", savedAt: "x", history: [{ at: "2026-01-01T00:00:00Z", changed: "title", title: "Archived name" }] }]]),
		);

		await conversationSearchHandlers.searchConversations({ projectId: "p1", query: "name" });

		expect(historyTextsPassedToEngine()).toEqual(["Rollback name", "Archived name"]);
	});

	it("survives a task with no sidecar at all", async () => {
		mocks.loadTasks.mockResolvedValue([task({})]);
		mocks.readAllTaskBlobs.mockResolvedValue(new Map());

		await conversationSearchHandlers.searchConversations({ projectId: "p1", query: "x" });

		expect(historyTextsPassedToEngine()).toEqual([]);
	});
});
