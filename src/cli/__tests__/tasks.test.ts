import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { handleTasks } from "../commands/tasks";
import type { CliContext } from "../context";
import type { Task, CliResponse } from "../../shared/types";

vi.mock("../socket-client", () => ({
	sendRequest: vi.fn(),
}));

import { sendRequest } from "../socket-client";
const mockSend = vi.mocked(sendRequest);

let stdoutOutput: string;
let stderrOutput: string;
let stdoutSpy: ReturnType<typeof vi.spyOn>;
let stderrSpy: ReturnType<typeof vi.spyOn>;
let exitSpy: ReturnType<typeof vi.spyOn>;

const SOCKET = "/tmp/test.sock";

const CTX: CliContext = {
	projectId: "proj-001",
	taskId: "task-001",
	socketPath: SOCKET,
};

const TASKS: Task[] = [
	{
		id: "aaaaaaaa-1111-2222-3333-444444444444",
		seq: 1,
		projectId: "proj-001",
		title: "First task",
		description: "",
		status: "todo",
		baseBranch: "main",
		branchName: null,
		worktreePath: null,
		groupId: null,
		variantIndex: null,
		agentId: null,
		configId: null,
		createdAt: "2026-03-01T10:00:00Z",
		updatedAt: "2026-03-01T10:00:00Z",
	},
	{
		id: "bbbbbbbb-1111-2222-3333-444444444444",
		seq: 2,
		projectId: "proj-001",
		title: "Second task with a very long title that exceeds sixty characters limit for display",
		description: "",
		status: "in-progress",
		baseBranch: "main",
		branchName: "dev3/task-bbbbbbbb",
		worktreePath: "/tmp/wt",
		groupId: null,
		variantIndex: null,
		agentId: null,
		configId: null,
		createdAt: "2026-03-01T11:00:00Z",
		updatedAt: "2026-03-01T12:00:00Z",
	},
];

function okResp(data: unknown): CliResponse {
	return { id: "test-id", ok: true, data };
}

function errResp(error: string): CliResponse {
	return { id: "test-id", ok: false, error };
}

beforeEach(() => {
	stdoutOutput = "";
	stderrOutput = "";
	stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
		stdoutOutput += String(chunk);
		return true;
	});
	stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
		stderrOutput += String(chunk);
		return true;
	});
	exitSpy = vi.spyOn(process, "exit").mockImplementation((_code?: string | number | null) => {
		throw new Error(`EXIT_${_code ?? 0}`);
	}) as ReturnType<typeof vi.spyOn>;
	mockSend.mockReset();
});

afterEach(() => {
	stdoutSpy.mockRestore();
	stderrSpy.mockRestore();
	exitSpy.mockRestore();
});

const LIST = (flags: Record<string, string> = {}) => ({ positional: [], flags: { project: "proj-001", ...flags } });

describe("tasks list", () => {
	it("filters closed tasks before paging without dropping drafts or custom columns, and pages past the end to an empty JSON page", async () => {
		const base = TASKS[0]!;
		mockSend.mockResolvedValue(okResp([
			{ ...base, id: "done", status: "completed", seq: 99 },
			{ ...base, id: "cancelled", status: "cancelled", seq: 98 },
			{ ...base, id: "draft", status: "todo", draft: true, seq: 4 },
			{ ...base, id: "parked", hibernated: true, status: "user-questions", seq: 3 },
			{ ...base, id: "custom", customColumnId: "custom", status: "in-progress", seq: 2 },
		]));
		await handleTasks("list", { positional: [], flags: { open: "true", json: "true", limit: "2", offset: "1" } }, SOCKET, CTX);
		const page = JSON.parse(stdoutOutput);
		expect(page).toMatchObject({ schemaVersion: 1, total: 3, offset: 1, limit: 2 });
		expect(page.tasks.map((task: { id: string }) => task.id)).toEqual(["parked", "draft"]);
		expect(page.tasks[0].hibernated).toBe(true);
		expect(page.tasks[1].draft).toBe(true);
		expect(mockSend).toHaveBeenCalledTimes(1);
		expect(mockSend).toHaveBeenCalledWith(SOCKET, "tasks.list", { projectId: CTX.projectId });

		stdoutOutput = "";
		mockSend.mockResolvedValue(okResp(TASKS));
		await handleTasks("list", { positional: [], flags: { open: "true", json: "true", offset: "100" } }, SOCKET, CTX);
		expect(JSON.parse(stdoutOutput)).toEqual({ schemaVersion: 1, tasks: [], total: TASKS.length, offset: 100, limit: 50 });
	});

	it("renders a table newest first, with short ids, status labels, truncated titles and a window footer", async () => {
		mockSend.mockResolvedValue(okResp(TASKS));

		await handleTasks("list", { positional: [], flags: { project: "proj-001", offset: "0" } }, SOCKET, null);

		expect(mockSend).toHaveBeenCalledWith(SOCKET, "tasks.list", { projectId: "proj-001" });
		expect(stdoutOutput).toContain("SEQ");
		expect(stdoutOutput).toContain("First task");
		expect(stdoutOutput).toContain("To Do");
		expect(stdoutOutput).toContain("Agent is Working");
		// The second task has a title > 60 chars, truncated with "...".
		expect(stdoutOutput).toContain("...");
		expect(stdoutOutput).toContain("aaaaaaaa");
		expect(stdoutOutput).not.toContain("aaaaaaaa-1111");
		expect(stdoutOutput).toContain("Showing 1-2 of 2.");
		// Server returns ascending; the CLI flips to descending by seq.
		expect(stdoutOutput.indexOf("bbbbbbbb")).toBeGreaterThan(-1);
		expect(stdoutOutput.indexOf("bbbbbbbb")).toBeLessThan(stdoutOutput.indexOf("aaaaaaaa"));
	});

	it("marks drafts, shows the custom title, and never mutates or writes a task (read-only render)", async () => {
		const original: Task = {
			...TASKS[0],
			id: "dddddddd-1111-2222-3333-444444444444",
			seq: 4,
			title: "Bug (from bug-hunt review): the raw auto-generated description blob",
			customTitle: "Fix custom title display",
			titleEditedByUser: true,
		};
		const snapshot = JSON.stringify(original);
		mockSend.mockResolvedValue(okResp([original, { ...TASKS[0], draft: true }]));

		await handleTasks("list", LIST(), SOCKET, null);

		expect(stdoutOutput).toContain("To Do (draft)");
		expect(stdoutOutput).toContain("Fix custom title display");
		expect(stdoutOutput).not.toContain("Bug (from bug-hunt review)");
		// Listing is purely a read — the task object must be byte-identical after.
		expect(JSON.stringify(original)).toBe(snapshot);
		// No write RPC should ever be issued by `tasks list`.
		expect(mockSend).toHaveBeenCalledTimes(1);
		expect(mockSend).toHaveBeenCalledWith(SOCKET, "tasks.list", { projectId: "proj-001" });
	});

	it("marks blocked and ready tasks, and names a cancelled dependency instead of calling it done", async () => {
		const dep = (seq: number, state: string) => ({ taskId: `t${seq}`, seq, title: `T${seq}`, status: state === "cancelled" ? "cancelled" : "todo", state });
		const info = (verdict: string, ...dependsOn: unknown[]) => ({ verdict, dependsOn, blocks: [] });
		mockSend.mockResolvedValue(okResp([
			{ ...TASKS[0], id: "aaaaaaaa-1", seq: 31, dependencyInfo: info("blocked", dep(3, "open"), dep(4, "cancelled")) },
			{ ...TASKS[0], id: "aaaaaaaa-2", seq: 32, dependencyInfo: info("ready", dep(5, "cancelled")) },
		]));
		await handleTasks("list", { positional: [], flags: { project: "proj-001" } }, SOCKET, null);
		expect(stdoutOutput).toContain("To Do (blocked by #3)");
		expect(stdoutOutput).toContain("To Do (ready, #5 cancelled)");

		stdoutOutput = "";
		await handleTasks("list", { positional: [], flags: { project: "proj-001", json: "true" } }, SOCKET, null);
		const rows = JSON.parse(stdoutOutput).tasks as Array<{ seq: number; dependency: unknown }>;
		expect(rows.find((r) => r.seq === 32)?.dependency).toEqual({ state: "ready", blockedBy: [], cancelled: [5] });
	});

	it("auto-detects projectId from context, passes --status to the server, and keeps --limit client-side", async () => {
		mockSend.mockResolvedValue(okResp(TASKS));

		await handleTasks("list", { positional: [], flags: {} }, SOCKET, CTX);
		expect(mockSend).toHaveBeenLastCalledWith(SOCKET, "tasks.list", { projectId: CTX.projectId });

		await handleTasks("list", LIST({ status: "todo" }), SOCKET, null);
		expect(mockSend).toHaveBeenLastCalledWith(SOCKET, "tasks.list", { projectId: "proj-001", status: "todo" });

		stdoutOutput = "";
		await handleTasks("list", LIST({ limit: "100" }), SOCKET, null);
		expect(mockSend).toHaveBeenLastCalledWith(SOCKET, "tasks.list", { projectId: "proj-001" });
		// A --limit above the task count shows them all.
		expect(stdoutOutput).toContain("First task");
		expect(stdoutOutput).toContain("bbbbbbbb");
	});

	it("defaults to 'list' when no subcommand, and prints 'No tasks found' for an empty list", async () => {
		mockSend.mockResolvedValue(okResp([]));

		// Use a full-length (>=36 char) id so expandShortProjectId returns it
		// verbatim. Short ids scan the on-disk projects.json, where a 1-char "p"
		// could prefix-match a leftover project from a sibling test file.
		const fullId = "proj-default-list-0000-0000-000000000000";
		await handleTasks(undefined, { positional: [], flags: { project: fullId } }, SOCKET, null);

		expect(mockSend).toHaveBeenCalledWith(SOCKET, "tasks.list", { projectId: fullId });
		expect(stdoutOutput).toContain("No tasks found");
	});

	it("exits on server error", async () => {
		mockSend.mockResolvedValue(errResp("Project not found"));

		await expect(
			handleTasks("list", { positional: [], flags: { project: "bad" } }, SOCKET, null),
		).rejects.toThrow("EXIT_1");
	});
});

// ─── tasks list: usage errors ────────────────────────────────────────────────
// Every bad flag value is refused with exit 3 before any request. parseInt("abc")
// is NaN and parseInt("10abc") is 10 — both must be rejected, not sent.

describe("tasks list usage errors", () => {
	async function expectUsageError(name: string, subcommand: string, flags: Record<string, string>, ctx: CliContext | null, message?: string) {
		stderrOutput = "";
		await expect(handleTasks(subcommand, { positional: [], flags }, SOCKET, ctx), name).rejects.toThrow("EXIT_3");
		if (message) expect(stderrOutput, name).toContain(message);
	}

	it("rejects a missing project, an unknown subcommand, and bad filter values before any request", async () => {
		await expectUsageError("no --project, no context", "list", {}, null, "--project");
		await expectUsageError("unknown subcommand", "delete", {}, null, "Unknown subcommand");
		await expectUsageError("--open with a terminal --status", "list", { open: "true", status: "completed" }, CTX);
		await expectUsageError("garbage --status", "list", { project: "proj-001", status: "garbage" }, null, "Invalid status");
		await expectUsageError("typo'd --status", "list", { project: "proj-001", status: "inprogress" }, null);
		await expectUsageError("unknown --sort", "list", { project: "proj-001", sort: "title" }, null, "--sort");
		await expectUsageError("invalid --priority", "list", { project: "proj-001", priority: "P9" }, null, "--priority");
		await expectUsageError("empty --priority", "list", { project: "proj-001", priority: "," }, null);
		expect(mockSend).not.toHaveBeenCalled();
	});

	it("rejects non-numeric, negative and partial-number --limit / --offset before any request", async () => {
		await expectUsageError("--limit abc", "list", { project: "proj-001", limit: "abc" }, null, "--limit");
		await expectUsageError("--limit -5", "list", { project: "proj-001", limit: "-5" }, null);
		await expectUsageError("--limit 10abc", "list", { project: "proj-001", limit: "10abc" }, null);
		await expectUsageError("--offset abc", "list", { project: "proj-001", offset: "abc" }, null, "--offset");
		await expectUsageError("--offset -1", "list", { project: "proj-001", offset: "-1" }, null);
		expect(mockSend).not.toHaveBeenCalled();
	});
});

// ─── tasks list: --limit, default limit and --offset paging ──────────────────

function makeTasks(count: number): Task[] {
	return Array.from({ length: count }, (_, i) => ({
		...TASKS[0],
		id: `t${String(i).padStart(8, "0")}-1111-2222-3333-444444444444`,
		seq: i + 1,
		title: `task number ${i + 1}`,
	}));
}

describe("tasks list paging", () => {
	it("truncates results to --limit count (keeps the newest)", async () => {
		mockSend.mockResolvedValue(okResp(TASKS));

		await handleTasks("list", LIST({ limit: "1" }), SOCKET, null);

		expect(stdoutOutput).toContain("Second task");
		expect(stdoutOutput).not.toContain("First task");
	});

	it("shows only the newest 50 tasks when --limit is omitted, and does not paginate when the total fits", async () => {
		mockSend.mockResolvedValue(okResp(makeTasks(60)));
		await handleTasks("list", LIST(), SOCKET, null);
		// Newest is seq 60; oldest in window is seq 11 (60 down to 11 = 50 rows).
		expect(stdoutOutput).toContain("task number 60");
		expect(stdoutOutput).toContain("task number 11");
		expect(stdoutOutput).not.toContain("task number 10");
		expect(stdoutOutput).toContain("Showing 1-50 of 60.");
		expect(stdoutOutput).toContain("Next page: --offset 50");

		stdoutOutput = "";
		mockSend.mockResolvedValue(okResp(makeTasks(3)));
		await handleTasks("list", LIST(), SOCKET, null);
		expect(stdoutOutput).toContain("Showing 1-3 of 3.");
		expect(stdoutOutput).not.toContain("Next page");
	});

	it("skips the first N tasks (after newest-first sort), and reports an offset past the end", async () => {
		mockSend.mockResolvedValue(okResp(TASKS));

		await handleTasks("list", LIST({ offset: "1" }), SOCKET, null);
		expect(stdoutOutput).toContain("First task");
		expect(stdoutOutput).not.toContain("Second task");
		expect(stdoutOutput).toContain("Showing 2-2 of 2.");

		stdoutOutput = "";
		await handleTasks("list", LIST({ offset: "5" }), SOCKET, null);
		expect(stdoutOutput).toContain("No tasks at offset 5 (2 total).");
	});

	it("combines --offset with --limit for a middle window", async () => {
		mockSend.mockResolvedValue(okResp(makeTasks(10)));

		await handleTasks("list", LIST({ offset: "2", limit: "3" }), SOCKET, null);

		// Newest-first: seq 10,9,8 (offset 2 → start at seq 8), 3 rows → 8,7,6.
		expect(stdoutOutput).toContain("task number 8");
		expect(stdoutOutput).toContain("task number 6");
		expect(stdoutOutput).not.toContain("task number 9");
		expect(stdoutOutput).not.toContain("task number 5");
		expect(stdoutOutput).toContain("Showing 3-5 of 10.");
		expect(stdoutOutput).toContain("Next page: --offset 5 --limit 3");
	});
});

// ─── tasks list: status grouping ─────────────────────────────────────────────

describe("tasks list status grouping", () => {
	function withStatus(seq: number, status: Task["status"], extra: Partial<Task> = {}): Task {
		return {
			...TASKS[0],
			id: `s${String(seq).padStart(8, "0")}-1111-2222-3333-444444444444`,
			seq,
			title: `task ${status} ${seq}`,
			status,
			...extra,
		};
	}

	it("puts live work first (newest first inside it), then To Do, then completed, then cancelled", async () => {
		mockSend.mockResolvedValue(
			okResp([
				withStatus(1, "cancelled"),
				withStatus(2, "completed"),
				withStatus(3, "todo"),
				withStatus(4, "in-progress"),
				withStatus(7, "in-progress"),
			]),
		);

		await handleTasks("list", LIST(), SOCKET, null);

		const at = (title: string) => stdoutOutput.indexOf(title);
		expect(at("task in-progress 7")).toBeGreaterThan(-1);
		expect(at("task in-progress 7")).toBeLessThan(at("task in-progress 4"));
		expect(at("task in-progress 4")).toBeLessThan(at("task todo 3"));
		expect(at("task todo 3")).toBeLessThan(at("task completed 2"));
		expect(at("task completed 2")).toBeLessThan(at("task cancelled 1"));
	});

	it("treats every review/question column and a custom column as live work", async () => {
		mockSend.mockResolvedValue(
			okResp([
				withStatus(10, "todo"),
				withStatus(1, "user-questions"),
				withStatus(2, "review-by-ai"),
				withStatus(3, "review-by-user"),
				withStatus(4, "review-by-colleague"),
				withStatus(5, "todo", { customColumnId: "3d339f70" }),
			]),
		);

		await handleTasks("list", LIST(), SOCKET, null);

		const todoIdx = stdoutOutput.indexOf("task todo 10");
		for (const title of [
			"task user-questions 1",
			"task review-by-ai 2",
			"task review-by-user 3",
			"task review-by-colleague 4",
			"task todo 5",
		]) {
			expect(stdoutOutput.indexOf(title), title).toBeGreaterThan(-1);
			expect(stdoutOutput.indexOf(title), title).toBeLessThan(todoIdx);
		}
	});

	it("fills a small --limit with live work before completed tasks", async () => {
		mockSend.mockResolvedValue(
			okResp([withStatus(50, "completed"), withStatus(49, "completed"), withStatus(2, "in-progress")]),
		);

		await handleTasks("list", LIST({ limit: "1" }), SOCKET, null);

		expect(stdoutOutput).toContain("task in-progress 2");
		expect(stdoutOutput).not.toContain("task completed 50");
	});
});

// ─── tasks list: priority column, filter and sort ────────────────────────────
// The board ranks a column by priority; before this the CLI listing hid the
// field entirely and ordered by seq, so the two disagreed and triaging from the
// terminal meant one `task show` per task.

describe("tasks list priority", () => {
	function withPriority(seq: number, priority: Task["priority"], extra: Partial<Task> = {}): Task {
		return {
			...TASKS[0],
			id: `p${String(seq).padStart(8, "0")}-1111-2222-3333-444444444444`,
			seq,
			title: `task ${seq}`,
			status: "todo",
			priority,
			...extra,
		};
	}

	it("prints a PRI column, defaulting a task that predates the field to P3 (which --priority P3 matches)", async () => {
		mockSend.mockResolvedValue(okResp([withPriority(1, "P0")]));
		await handleTasks("list", LIST(), SOCKET, null);
		expect(stdoutOutput).toContain("PRI");
		expect(stdoutOutput).toMatch(/P0\s+To Do\s+task 1/);

		stdoutOutput = "";
		mockSend.mockResolvedValue(okResp([{ ...TASKS[0], priority: undefined }]));
		await handleTasks("list", LIST(), SOCKET, null);
		expect(stdoutOutput).toMatch(/P3\s+To Do\s+First task/);

		stdoutOutput = "";
		await handleTasks("list", LIST({ priority: "P3" }), SOCKET, null);
		expect(stdoutOutput).toContain("First task");
	});

	it("sorts by priority inside a group, highest first, breaking a tie with newest seq", async () => {
		mockSend.mockResolvedValue(
			okResp([withPriority(1, "P4"), withPriority(2, "P0"), withPriority(3, "P2"), withPriority(5, "P1"), withPriority(9, "P1")]),
		);

		await handleTasks("list", LIST(), SOCKET, null);

		const at = (title: string) => stdoutOutput.indexOf(title);
		expect(at("task 2")).toBeLessThan(at("task 9"));
		expect(at("task 9")).toBeLessThan(at("task 5"));
		expect(at("task 5")).toBeLessThan(at("task 3"));
		expect(at("task 3")).toBeLessThan(at("task 1"));
	});

	it("keeps the status grouping above priority, and sinks a hibernated task below every live priority, as the board does", async () => {
		const cases: Array<[string, Task[]]> = [
			["a P0 in To Do stays under live work", [withPriority(1, "P0"), withPriority(2, "P4", { status: "in-progress" })]],
			["a hibernated P0 sinks", [
				withPriority(1, "P0", { status: "in-progress", hibernated: true }),
				withPriority(2, "P4", { status: "in-progress" }),
			]],
		];
		for (const [name, tasks] of cases) {
			stdoutOutput = "";
			mockSend.mockResolvedValue(okResp(tasks));

			await handleTasks("list", LIST(), SOCKET, null);

			expect(stdoutOutput.indexOf("task 2"), name).toBeLessThan(stdoutOutput.indexOf("task 1"));
		}
	});

	it("--sort seq restores plain newest-first inside a group", async () => {
		mockSend.mockResolvedValue(okResp([withPriority(1, "P0"), withPriority(2, "P4")]));

		await handleTasks("list", LIST({ sort: "seq" }), SOCKET, null);

		expect(stdoutOutput.indexOf("task 2")).toBeLessThan(stdoutOutput.indexOf("task 1"));
	});

	it("--priority keeps only the named band, or a comma-separated list in any case and bare digits", async () => {
		mockSend.mockResolvedValue(
			okResp([withPriority(1, "P0"), withPriority(2, "P2"), withPriority(3, "P4")]),
		);
		await handleTasks("list", LIST({ priority: "P2" }), SOCKET, null);
		expect(stdoutOutput).toContain("task 2");
		expect(stdoutOutput).not.toContain("task 1");
		expect(stdoutOutput).not.toContain("task 3");
		expect(stdoutOutput).toContain("Showing 1-1 of 1.");

		stdoutOutput = "";
		mockSend.mockResolvedValue(
			okResp([withPriority(1, "P0"), withPriority(2, "P1"), withPriority(3, "P4")]),
		);
		await handleTasks("list", LIST({ priority: "p0,1" }), SOCKET, null);
		expect(stdoutOutput).toContain("task 1");
		expect(stdoutOutput).toContain("task 2");
		expect(stdoutOutput).not.toContain("task 3");
	});

	it("composes --priority with --label", async () => {
		mockSend.mockResolvedValue(
			okResp([
				withPriority(1, "P0", { labelIds: ["lab00001"] }),
				withPriority(2, "P0", { labelIds: ["other111"] }),
			]),
		);

		await handleTasks("list", LIST({ priority: "P0", label: "lab00001" }), SOCKET, null);

		expect(stdoutOutput).toContain("task 1");
		expect(stdoutOutput).not.toContain("task 2");
	});
});

describe("tasks list --children-of", () => {
	const RESULT = {
		parent: { id: "pppp", seq: 1801, projectId: "proj-001", projectName: "dev-3.0", title: "Coordinate" },
		children: [
			{ id: "cccccccc-2", seq: 9, variantIndex: null, projectId: "proj-002", projectName: "homebrew", status: "todo", title: "Bump cask" },
			{ id: "cccccccc-1", seq: 1802, variantIndex: 2, projectId: "proj-001", projectName: "dev-3.0", status: "in-progress", title: "Fix CLI" },
		],
	};

	it("asks for the children of the parent in the current project and lists every project", async () => {
		mockSend.mockResolvedValue({ id: "1", ok: true, data: RESULT } as CliResponse);
		await handleTasks("list", { positional: [], flags: { "children-of": "seq:1801" } }, SOCKET, CTX);

		expect(mockSend).toHaveBeenCalledWith(SOCKET, "task.children", { taskId: "seq:1801", projectId: "proj-001" });
		expect(stdoutOutput).toContain("Children of <seq:1801> · dev-3.0");
		expect(stdoutOutput).toContain("homebrew");
		expect(stdoutOutput).toContain("1802-2");
		expect(stdoutOutput).toContain("Agent is Working");
		expect(stdoutOutput.indexOf("dev-3.0  ")).toBeLessThan(stdoutOutput.indexOf("homebrew"));
	});

	it("resolves the parent in --project and prints JSON; says so when there are no children", async () => {
		mockSend.mockResolvedValue({ id: "1", ok: true, data: RESULT } as CliResponse);
		await handleTasks("list", { positional: [], flags: { "children-of": "seq:1801", project: "proj-009", json: "true" } }, SOCKET, CTX);

		expect(mockSend).toHaveBeenCalledWith(SOCKET, "task.children", { taskId: "seq:1801", projectId: "proj-009" });
		const parsed = JSON.parse(stdoutOutput);
		expect(parsed.children.map((c: { seq: number }) => c.seq)).toEqual([1802, 9]);

		stdoutOutput = "";
		mockSend.mockResolvedValue({ id: "1", ok: true, data: { ...RESULT, children: [] } } as CliResponse);
		await handleTasks("list", { positional: [], flags: { "children-of": "seq:1801" } }, SOCKET, CTX);
		expect(stdoutOutput).toContain("No children.");
	});
});

describe("tasks list --epic", () => {
	const RESULT = {
		epic: { id: "epicpay1-0000", name: "Payments v2", color: "#3b82f6", archived: false, createdAt: 0 },
		tasks: [
			{ id: "tttttttt-2", seq: 9, variantIndex: null, projectId: "proj-002", projectName: "backend", status: "completed", title: "Payments API", epicId: "epicpay1-0000" },
			{ id: "tttttttt-1", seq: 1802, variantIndex: null, projectId: "proj-001", projectName: "app", status: "in-progress", title: "Checkout page", epicId: "epicpay1-0000" },
		],
	};

	it("lists the epic's tasks from every project and every status, ignoring the current project, as text and JSON", async () => {
		mockSend.mockResolvedValue({ id: "1", ok: true, data: RESULT } as CliResponse);
		await handleTasks("list", { positional: [], flags: { epic: "Payments v2" } }, SOCKET, CTX);

		expect(mockSend).toHaveBeenCalledWith(SOCKET, "epic.tasks", { epic: "Payments v2" });
		expect(stdoutOutput).toContain("Epic Payments v2 (epicpay1)");
		expect(stdoutOutput).toContain("backend");
		expect(stdoutOutput).toContain("Completed");
		expect(stdoutOutput.indexOf("app  ")).toBeLessThan(stdoutOutput.indexOf("backend"));

		stdoutOutput = "";
		await handleTasks("list", { positional: [], flags: { epic: "Payments v2", json: "true" } }, SOCKET, CTX);
		expect(JSON.parse(stdoutOutput).tasks.map((t: { seq: number }) => t.seq)).toEqual([1802, 9]);
	});
});
