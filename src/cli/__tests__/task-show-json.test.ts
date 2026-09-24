import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { handleTask } from "../commands/task";
import { buildTaskShowJson } from "../task-json";
import type { ParsedArgs } from "../args";
import type { CliResponse, Task } from "../../shared/types";

vi.mock("../socket-client", () => ({ sendRequest: vi.fn() }));
import { sendRequest } from "../socket-client";
const mockSend = vi.mocked(sendRequest);

const SOCKET = "/tmp/test.sock";
const TASK = {
	id: "aaaaaaaa-1111-2222-3333-444444444444",
	seq: 42,
	projectId: "proj-001",
	title: "Fix the login bug",
	customTitle: "Fix login",
	titleEditedByUser: true,
	description: "Line one\n\n  indented — ünïcode `ticks` and \"quotes\"\n",
	overview: "agent overview",
	userOverview: "user overview wins",
	status: "in-progress",
	priority: "P1",
	baseBranch: "main",
	branchName: "fix/login",
	worktreePath: "/tmp/wt",
	groupId: null,
	variantIndex: null,
	agentId: "claude",
	configId: null,
	labelIds: ["lbl-1", "lbl-2"],
	notes: [{ id: "note-1", content: "root cause", source: "ai", createdAt: "2026-03-01T10:00:00Z", updatedAt: "2026-03-01T10:00:00Z" }],
	history: [{ at: "2026-03-01T10:00:00Z", changed: "created", title: "Fix the login bug", overview: null }],
	createdAt: "2026-03-01T10:00:00Z",
	updatedAt: "2026-03-01T12:00:00Z",
	tmuxSocket: "internal-field-not-in-contract",
} as unknown as Task;

let stdout: string;
beforeEach(() => {
	stdout = "";
	vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
		stdout += String(chunk);
		return true;
	});
	vi.spyOn(process.stderr, "write").mockImplementation(() => true);
	vi.spyOn(process, "exit").mockImplementation((code?: string | number | null) => {
		throw new Error(`EXIT_${code ?? 0}`);
	}) as ReturnType<typeof vi.spyOn>;
	mockSend.mockReset();
	mockSend.mockResolvedValue({ id: "x", ok: true, data: TASK } as CliResponse);
});
afterEach(() => vi.restoreAllMocks());

const args = (positional: string[], flags: Record<string, string> = {}): ParsedArgs => ({ positional, flags });

describe("task show --json", () => {
	it("prints one parseable object with the raw description byte for byte", async () => {
		await handleTask("show", args(["aaaaaaaa"], { json: "true" }), SOCKET, null);
		const parsed = JSON.parse(stdout);
		expect(parsed.description).toBe(TASK.description);
		expect(parsed).toMatchObject({
			schemaVersion: 1,
			id: TASK.id,
			seq: 42,
			title: "Fix login",
			titleEditedByUser: true,
			overview: "user overview wins",
			status: "in-progress",
			priority: "P1",
			branch: "fix/login",
			baseBranch: "main",
			worktree: "/tmp/wt",
			labelIds: ["lbl-1", "lbl-2"],
			noteCount: 1,
		});
	});

	it("is a fixed projection: the key set is the contract, internals never leak", () => {
		expect(Object.keys(buildTaskShowJson(TASK)).sort()).toEqual([
			"baseBranch", "branch", "createdAt", "customColumnId", "description", "draft", "groupId", "id",
			"labelIds", "manualCompletion", "movedAt", "noteCount", "overview", "prNumber", "prUrl", "priority",
			"projectId", "schemaVersion", "seq", "status", "statusLabel", "taskType", "title", "titleEditedByUser",
			"updatedAt", "variantIndex", "worktree",
		]);
	});

	it("adds notes and history only when asked", async () => {
		await handleTask("show", args(["aaaaaaaa"], { json: "true", notes: "true", history: "true" }), SOCKET, null);
		const parsed = JSON.parse(stdout);
		expect(parsed.notes).toEqual([{ id: "note-1", source: "ai", content: "root cause", createdAt: "2026-03-01T10:00:00Z", updatedAt: "2026-03-01T10:00:00Z" }]);
		expect(parsed.history).toHaveLength(1);
		expect(buildTaskShowJson(TASK).notes).toBeUndefined();
	});

	it("fills absent optionals with null/defaults instead of dropping the key", () => {
		const bare = { ...TASK, labelIds: undefined, notes: undefined, branchName: null, priority: undefined, overview: null, userOverview: null } as unknown as Task;
		expect(buildTaskShowJson(bare)).toMatchObject({ labelIds: [], noteCount: 0, branch: null, priority: "P3", overview: null, movedAt: null });
	});

	it("the plain form is unchanged and is not JSON", async () => {
		await handleTask("show", args(["aaaaaaaa"]), SOCKET, null);
		expect(stdout).toContain("Seq:");
		expect(() => JSON.parse(stdout)).toThrow();
	});
});
