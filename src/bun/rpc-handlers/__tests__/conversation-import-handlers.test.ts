/**
 * The scan/import seam: everything the import feature does is observable here —
 * which conversations are offered, what the resulting tasks look like, which
 * column they land in, which one gets a worktree, and that a second run adds
 * nothing.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Project, Task } from "../../../shared/types";
import type { ImportableConversation } from "../../conversation-import";
import { parseClaudeTranscript } from "../../../shared/conversation-parsers/claude";

const mocks = vi.hoisted(() => ({
	getProject: vi.fn(),
	loadTasks: vi.fn(),
	addTask: vi.fn(),
	updateTask: vi.fn(),
	updateProjectWith: vi.fn(),
	scanImportableConversations: vi.fn(),
	refExists: vi.fn(),
	createWorktree: vi.fn(),
	resolveProjectConfig: vi.fn(),
	push: vi.fn(),
}));

vi.mock("../../data", () => ({
	getProject: mocks.getProject,
	loadTasks: mocks.loadTasks,
	addTask: mocks.addTask,
	updateTask: mocks.updateTask,
	updateProjectWith: mocks.updateProjectWith,
}));
vi.mock("../../git", () => ({ refExists: mocks.refExists, createWorktree: mocks.createWorktree }));
vi.mock("../../repo-config", () => ({ resolveProjectConfig: mocks.resolveProjectConfig }));
vi.mock("../../conversation-import", () => ({ scanImportableConversations: mocks.scanImportableConversations }));
vi.mock("../shared", () => ({
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
	getPushMessage: () => mocks.push,
}));
// The transcript is a fixture string run through the real parser, so the
// description under test is the one a real conversation would produce.
vi.mock("../../conversation-parse", () => ({
	// Null for a file that cannot be read, exactly like the real one.
	parseTranscriptFile: (path: string) => {
		const body = FIXTURES.get(path);
		return body === undefined ? null : parseClaudeTranscript(body, path);
	},
}));

import { conversationImportHandlers } from "../conversation-import-handlers";

const FIXTURES = new Map<string, string>();

const PROJECT: Project = {
	id: "p1",
	name: "dev-3.0",
	path: "/code/dev-3.0",
	defaultBaseBranch: "main",
} as Project;

function transcript(prompt: string, answer: string): string {
	return [
		JSON.stringify({ type: "ai-title", aiTitle: "T", sessionId: "s" }),
		JSON.stringify({
			type: "user",
			sessionId: "s",
			uuid: "u1",
			timestamp: "2026-08-20T10:00:00.000Z",
			cwd: "/code/dev-3.0",
			gitBranch: "feat/parser",
			message: { role: "user", content: [{ type: "text", text: prompt }] },
		}),
		JSON.stringify({
			type: "assistant",
			sessionId: "s",
			uuid: "a1",
			parentUuid: "u1",
			timestamp: "2026-08-20T10:01:00.000Z",
			message: { role: "assistant", content: [{ type: "text", text: answer }] },
		}),
	].join("\n");
}

function conversation(over: Partial<ImportableConversation> = {}): ImportableConversation {
	const path = over.transcriptPath ?? `/store/${over.sessionId ?? "sess-1"}.jsonl`;
	FIXTURES.set(path, transcript("Please fix the parser", "Fixed it, tests pass."));
	return {
		sessionId: "sess-1",
		title: "Fix the parser",
		workingDir: "/code/dev-3.0",
		transcriptPath: path,
		gitBranch: "feat/parser",
		lastActivityMs: Date.UTC(2026, 7, 26),
		turns: 3,
		targetStatus: "user-questions",
		...over,
	};
}

/** The task `addTask` would have written, echoed back like the real one does. */
function createdTask(description: string, status: string, extras: Record<string, unknown>): Task {
	return {
		id: `task-${extras.importedSessionId}`,
		seq: 7,
		projectId: PROJECT.id,
		title: String(extras.title ?? ""),
		description,
		status,
		labelIds: extras.labelIds ?? [],
	} as unknown as Task;
}

function addTaskCall(index = 0): { status: string; extras: Record<string, unknown>; description: string } {
	const call = mocks.addTask.mock.calls[index];
	if (!call) throw new Error(`addTask was not called ${index + 1} time(s)`);
	return { description: call[1] as string, status: call[2] as string, extras: (call[3] ?? {}) as Record<string, unknown> };
}

beforeEach(() => {
	vi.clearAllMocks();
	FIXTURES.clear();
	mocks.getProject.mockResolvedValue(PROJECT);
	mocks.loadTasks.mockResolvedValue([]);
	mocks.scanImportableConversations.mockReturnValue([]);
	mocks.refExists.mockResolvedValue(true);
	mocks.resolveProjectConfig.mockImplementation(async (p: Project) => p);
	mocks.createWorktree.mockResolvedValue({ worktreePath: "/wt/task/worktree", branchName: "dev3/task-abcd1234" });
	mocks.updateProjectWith.mockImplementation(async (_id: string, fn: (p: Project) => Promise<{ result: unknown }>) => fn(PROJECT));
	mocks.addTask.mockImplementation(async (_p: Project, description: string, status: string, extras: Record<string, unknown>) =>
		createdTask(description, status, extras));
	mocks.updateTask.mockImplementation(async (_p: Project, id: string, updates: Partial<Task>) => ({ id, ...updates } as Task));
});

describe("scanImportableConversations", () => {
	it("offers the conversations the scanner found, without the transcript path", async () => {
		mocks.scanImportableConversations.mockReturnValue([conversation()]);
		const result = await conversationImportHandlers.scanImportableConversations({ projectId: "p1" });
		expect(result.conversations).toEqual([{
			sessionId: "sess-1",
			title: "Fix the parser",
			workingDir: "/code/dev-3.0",
			lastActivityMs: Date.UTC(2026, 7, 26),
			turns: 3,
			targetStatus: "user-questions",
		}]);
	});

	it("hides sessions already imported by an existing task", async () => {
		mocks.loadTasks.mockResolvedValue([{ id: "t1", importedSessionId: "sess-1" } as Task]);
		await conversationImportHandlers.scanImportableConversations({ projectId: "p1" });
		expect(mocks.scanImportableConversations.mock.calls[0][0].importedSessionIds).toEqual(["sess-1"]);
	});

	it("answers an empty list for a board with no repository", async () => {
		mocks.getProject.mockResolvedValue({ ...PROJECT, kind: "virtual" });
		expect(await conversationImportHandlers.scanImportableConversations({ projectId: "p1" }))
			.toEqual({ conversations: [] });
		expect(mocks.scanImportableConversations).not.toHaveBeenCalled();
	});
});

describe("importConversations", () => {
	it("creates a task titled by Claude, labelled imported, keyed on the session", async () => {
		mocks.scanImportableConversations.mockReturnValue([conversation()]);
		const result = await conversationImportHandlers.importConversations({ projectId: "p1", sessionIds: ["sess-1"] });

		expect(result.imported).toBe(1);
		expect(result.problems).toEqual([]);
		const { extras, status } = addTaskCall();
		expect(status).toBe("user-questions");
		expect(extras.title).toBe("Fix the parser");
		expect(extras.importedSessionId).toBe("sess-1");
		expect(extras.labelIds).toHaveLength(1);
	});

	it("leads the description with the user's own request and says where it came from", async () => {
		mocks.scanImportableConversations.mockReturnValue([conversation()]);
		await conversationImportHandlers.importConversations({ projectId: "p1", sessionIds: ["sess-1"] });

		const { description } = addTaskCall();
		expect(description).toContain("## The request that started this");
		expect(description).toContain("Please fix the parser");
		expect(description).toContain("Fixed it, tests pass.");
		expect(description.indexOf("Please fix the parser")).toBeLessThan(description.indexOf("Fixed it, tests pass."));
	});

	it("creates the `imported` label once and reuses it afterwards", async () => {
		mocks.scanImportableConversations.mockReturnValue([conversation(), conversation({ sessionId: "sess-2" })]);
		await conversationImportHandlers.importConversations({ projectId: "p1", sessionIds: ["sess-1", "sess-2"] });

		const created = mocks.updateProjectWith.mock.results
			.map((r) => r.value as Promise<{ updates: { labels?: unknown[] } }>);
		const updates = await Promise.all(created);
		const labelWrites = updates.filter((u) => Array.isArray(u.updates.labels));
		expect(labelWrites).toHaveLength(1);
		expect((labelWrites[0].updates.labels as { name: string }[])[0].name).toBe("imported");
	});

	it("gives a recent conversation a worktree branched off the branch it ran on", async () => {
		mocks.scanImportableConversations.mockReturnValue([conversation()]);
		await conversationImportHandlers.importConversations({ projectId: "p1", sessionIds: ["sess-1"] });

		expect(addTaskCall().extras.baseBranch).toBe("feat/parser");
		expect(mocks.createWorktree).toHaveBeenCalledTimes(1);
		expect(mocks.updateTask.mock.calls[0][2]).toMatchObject({
			worktreePath: "/wt/task/worktree",
			branchName: "dev3/task-abcd1234",
		});
	});

	it("falls back to the project's base branch when the conversation's branch is gone", async () => {
		mocks.refExists.mockResolvedValue(false);
		mocks.scanImportableConversations.mockReturnValue([conversation({ gitBranch: "deleted/branch" })]);
		await conversationImportHandlers.importConversations({ projectId: "p1", sessionIds: ["sess-1"] });
		expect(addTaskCall().extras.baseBranch).toBe("main");
	});

	it("gives an old conversation no worktree at all", async () => {
		mocks.scanImportableConversations.mockReturnValue([conversation({ targetStatus: "completed" })]);
		await conversationImportHandlers.importConversations({ projectId: "p1", sessionIds: ["sess-1"] });

		expect(addTaskCall().status).toBe("completed");
		expect(addTaskCall().extras.baseBranch).toBeUndefined();
		expect(mocks.createWorktree).not.toHaveBeenCalled();
	});

	it("keeps the task when its worktree could not be created, and says so", async () => {
		mocks.createWorktree.mockRejectedValue(new Error("branch does not exist"));
		mocks.scanImportableConversations.mockReturnValue([conversation()]);
		const result = await conversationImportHandlers.importConversations({ projectId: "p1", sessionIds: ["sess-1"] });

		expect(result.imported).toBe(1);
		expect(result.problems[0].error).toContain("without a worktree");
	});

	it("imports only what was selected", async () => {
		mocks.scanImportableConversations.mockReturnValue([conversation(), conversation({ sessionId: "sess-2" })]);
		const result = await conversationImportHandlers.importConversations({ projectId: "p1", sessionIds: ["sess-2"] });

		expect(result.imported).toBe(1);
		expect(addTaskCall().extras.importedSessionId).toBe("sess-2");
	});

	it("adds nothing on a second run, because the scan no longer offers the session", async () => {
		mocks.scanImportableConversations.mockReturnValue([]);
		const result = await conversationImportHandlers.importConversations({ projectId: "p1", sessionIds: ["sess-1"] });
		expect(result).toEqual({ imported: 0, tasks: [], problems: [] });
		expect(mocks.addTask).not.toHaveBeenCalled();
	});

	it("carries on past a conversation that cannot be parsed", async () => {
		const broken = conversation({ sessionId: "broken", transcriptPath: "/store/missing.jsonl" });
		FIXTURES.delete("/store/missing.jsonl");
		mocks.scanImportableConversations.mockReturnValue([broken, conversation({ sessionId: "good" })]);

		const result = await conversationImportHandlers.importConversations({
			projectId: "p1",
			sessionIds: ["broken", "good"],
		});
		expect(result.imported).toBe(1);
		expect(result.problems).toHaveLength(1);
	});

	it("tells every open surface about each new task", async () => {
		mocks.scanImportableConversations.mockReturnValue([conversation()]);
		await conversationImportHandlers.importConversations({ projectId: "p1", sessionIds: ["sess-1"] });
		expect(mocks.push).toHaveBeenCalledWith("taskUpdated", expect.objectContaining({ projectId: "p1" }));
	});
});
