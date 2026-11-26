import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { handleTask } from "../commands/task";
import type { CliContext } from "../context";
import type { ParsedArgs } from "../args";
import type { Task, CliResponse } from "../../shared/types";
import { DRAFT_TASK_ACTIVATION_ERROR, TASK_REF_UNRESOLVED_PREFIX } from "../../shared/types";
import { CLI_EXIT_CODE_EPIC_CREATE_FORBIDDEN, CLI_EXIT_CODE_EPIC_REF_INVALID, CLI_EXIT_CODE_LAUNCH_DECLINED, CLI_EXIT_CODE_LAUNCH_PREPARATION_FAILED, CLI_EXIT_CODE_RESET_DECLINED, CLI_EXIT_CODE_TASK_IS_DRAFT } from "../../shared/cli-exit-codes";
import { LAUNCH_PREPARATION_REPORT_BUDGET_MS } from "../../shared/launch-preparation";
import { handleEpic } from "../commands/epic";

vi.mock("../context", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../context")>();
	return { ...actual, readProjectDirect: vi.fn(actual.readProjectDirect) };
});

vi.mock("../stdin", () => ({
	readStdin: vi.fn(),
}));

// Mock sendRequest so we never hit a real socket
vi.mock("../socket-client", () => ({
	sendRequest: vi.fn(),
}));

import { sendRequest } from "../socket-client";
import { readStdin } from "../stdin";
import { readProjectDirect } from "../context";
const mockSend = vi.mocked(sendRequest);
const mockReadStdin = vi.mocked(readStdin);

let stdoutOutput: string;
let stderrOutput: string;
let stdoutSpy: ReturnType<typeof vi.spyOn>;
let stderrSpy: ReturnType<typeof vi.spyOn>;
let exitSpy: ReturnType<typeof vi.spyOn>;

const SOCKET = "/tmp/test.sock";

const FAKE_TASK: Task = {
	id: "aaaaaaaa-1111-2222-3333-444444444444",
	seq: 42,
	projectId: "proj-001",
	title: "Fix the login bug",
	description: "Users report 500 on login with SSO enabled",
	status: "in-progress",
	baseBranch: "main",
	branchName: "dev3/task-aaaaaaaa",
	worktreePath: "/tmp/worktrees/proj/aaaaaaaa/worktree",
	groupId: null,
	variantIndex: null,
	agentId: null,
	configId: null,
	createdAt: "2026-03-01T10:00:00Z",
	updatedAt: "2026-03-01T12:00:00Z",
	movedAt: "2026-03-01T11:00:00Z",
};

const CTX: CliContext = {
	projectId: "proj-001",
	taskId: "aaaaaaaa-1111-2222-3333-444444444444",
	socketPath: SOCKET,
};

function okResp(data: unknown): CliResponse {
	return { id: "test-id", ok: true, data };
}

function errResp(error: string): CliResponse {
	return { id: "test-id", ok: false, error };
}

function args(positional: string[] = [], flags: Record<string, string> = {}): ParsedArgs {
	return { positional, flags };
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
	mockReadStdin.mockReset();
	// The suite may itself run inside a tmux pane; only the tests about panes set one.
	vi.stubEnv("TMUX_PANE", "");
	vi.stubEnv("DEV3_PANE_ID", "");
});

afterEach(() => {
	vi.unstubAllEnvs();
	stdoutSpy.mockRestore();
	stderrSpy.mockRestore();
	exitSpy.mockRestore();
});

/** The `task.move` call, skipping the `approval.policy` pre-flight in front of it. */
function moveCall(mock: { mock: { calls: unknown[][] } }) {
	return mock.mock.calls.find((call) => call[1] === "task.move") as
		[string, string, Record<string, unknown>, Record<string, unknown>] | undefined;
}

function lastParams(): Record<string, unknown> {
	return mockSend.mock.calls[mockSend.mock.calls.length - 1]![2] as Record<string, unknown>;
}

function resetIO(): void {
	stdoutOutput = "";
	stderrOutput = "";
	mockSend.mockReset();
	mockReadStdin.mockReset();
}

type Refusal = { label: string; sub: string; a: ParsedArgs; ctx?: CliContext | null; stderr?: string[]; exit?: string };

/** Each case must fail with a usage-style exit before anything reaches the app. */
async function expectRefusedBeforeSending(cases: Refusal[]): Promise<void> {
	for (const c of cases) {
		resetIO();
		await expect(handleTask(c.sub, c.a, SOCKET, c.ctx ?? null), c.label).rejects.toThrow(c.exit ?? "EXIT_3");
		for (const snippet of c.stderr ?? []) expect(stderrOutput, c.label).toContain(snippet);
		expect(mockSend, c.label).not.toHaveBeenCalled();
	}
}

// ─── task show ───────────────────────────────────────────────────────────────

describe("task show", () => {
	it("shows a task by explicit ID with its default fields", async () => {
		mockSend.mockResolvedValue(okResp(FAKE_TASK));

		await handleTask("show", args(["aaaaaaaa"]), SOCKET, null);

		expect(mockSend).toHaveBeenCalledWith(SOCKET, "task.show", { taskId: "aaaaaaaa" });
		expect(stdoutOutput).toContain("Fix the login bug");
		expect(stdoutOutput).toContain("Agent is Working");
		expect(stdoutOutput).toMatch(/Priority:\s*P3/);
		expect(stdoutOutput).toContain("Description:");
		expect(stdoutOutput).toContain("Users report 500");
		for (const absent of ["Created by", "Draft:", "Overview:"]) expect(stdoutOutput, absent).not.toContain(absent);
	});

	it("prints an explicit priority, marks a draft, and skips a description equal to the title", async () => {
		mockSend.mockResolvedValue(okResp({ ...FAKE_TASK, status: "todo", draft: true, priority: "P0", description: FAKE_TASK.title }));

		await handleTask("show", args(["aaaaaaaa"]), SOCKET, null);

		expect(stdoutOutput).toMatch(/Priority:\s*P0/);
		// A draft must be visible so an agent does not start on a half-written prompt.
		expect(stdoutOutput).toMatch(/Draft:\s+yes/);
		expect(stdoutOutput).not.toContain("Description:");
	});

	it("prints the parent a task was created by, and a deleted parent as such", async () => {
		const child = { ...FAKE_TASK, origin: { kind: "task", taskId: "pppppppp-0000", projectId: "proj-002" } };
		mockSend.mockResolvedValue(okResp({
			...child,
			originParent: { id: "pppppppp-0000", projectId: "proj-002", projectName: "homebrew", seq: 1801, variantIndex: 2, title: "Coordinate" },
		}));
		await handleTask("show", args(["aaaaaaaa"]), SOCKET, null);
		expect(stdoutOutput).toMatch(/Created by:\s*<seq:proj-002\/1801> v2 · homebrew — Coordinate \(pppppppp\)/);

		stdoutOutput = "";
		mockSend.mockResolvedValue(okResp({ ...child, originParent: null }));
		await handleTask("show", args(["aaaaaaaa"]), SOCKET, null);
		expect(stdoutOutput).toMatch(/Created by:\s*a task \(deleted\)/);
	});

	it("takes task and project from context unless --project overrides it", async () => {
		mockSend.mockResolvedValue(okResp(FAKE_TASK));

		await handleTask("show", args(), SOCKET, CTX);
		expect(mockSend).toHaveBeenCalledWith(SOCKET, "task.show", { taskId: CTX.taskId, projectId: CTX.projectId });

		await handleTask("show", args(["aaaaaaaa"]), SOCKET, CTX);
		expect(lastParams().projectId).toBe(CTX.projectId);

		await handleTask("show", args(["aaaaaaaa"], { project: "other-proj" }), SOCKET, CTX);
		expect(lastParams().projectId).toBe("other-proj");
	});

	it("exits with a usage error without an ID or context or on unknown flags, and 1 on server failure", async () => {
		await expect(handleTask("show", args(), SOCKET, null)).rejects.toThrow("EXIT_3");
		expect(stderrOutput).toContain("Usage:");
		await expect(handleTask("show", args(["aaaaaaaa"], { bogus: "true" }), SOCKET, null)).rejects.toThrow("EXIT_3");
		mockSend.mockResolvedValue(errResp("Task not found"));

		await expect(handleTask("show", args(["bad"]), SOCKET, null)).rejects.toThrow("EXIT_1");
		expect(stderrOutput).toContain("Task not found");
	});

	it("shows the agent overview, and prefers the user override over it", async () => {
		mockSend.mockResolvedValue(okResp({ ...FAKE_TASK, overview: "Repro done, writing the lock" }));
		await handleTask("show", args(["aaaaaaaa"]), SOCKET, null);
		expect(stdoutOutput).toContain("Overview:");
		expect(stdoutOutput).toContain("Repro done, writing the lock");

		stdoutOutput = "";
		mockSend.mockResolvedValue(okResp({ ...FAKE_TASK, overview: "agent text", userOverview: "user pinned text" }));
		await handleTask("show", args(["aaaaaaaa"]), SOCKET, null);
		expect(stdoutOutput).toContain("user pinned text");
		expect(stdoutOutput).not.toContain("agent text");
	});

	it("inlines note bodies only with --notes, and the title/overview change log only with --history", async () => {
		mockSend.mockResolvedValue(
			okResp({
				...FAKE_TASK,
				notes: [
					{
						id: "note1111-2222-3333-4444-555555555555",
						content: "Root cause: missing mutex around session refresh",
						source: "ai",
						createdAt: "2026-03-01T13:00:00Z",
						updatedAt: "2026-03-01T13:00:00Z",
					},
				],
			}),
		);

		await handleTask("show", args(["aaaaaaaa"]), SOCKET, null);
		expect(stdoutOutput).toContain("Notes:");
		expect(stdoutOutput).not.toContain("Root cause: missing mutex");

		stdoutOutput = "";
		await handleTask("show", args(["aaaaaaaa"], { notes: "true" }), SOCKET, null);
		expect(stdoutOutput).toContain("Notes (1):");
		expect(stdoutOutput).toContain("note1111");
		expect(stdoutOutput).toContain("Root cause: missing mutex around session refresh");
		stdoutOutput = "";
		mockSend.mockResolvedValue(
			okResp({
				...FAKE_TASK,
				history: [
					{ at: "2026-03-01T10:00:00Z", title: "Old title", overview: null, changed: "created" },
					{
						at: "2026-03-01T11:30:00Z",
						title: "Fix the login bug",
						overview: "Repro done",
						changed: "both",
					},
				],
			}),
		);

		await handleTask("show", args(["aaaaaaaa"]), SOCKET, null);
		expect(stdoutOutput).not.toContain("History (");

		stdoutOutput = "";
		await handleTask("show", args(["aaaaaaaa"], { history: "true" }), SOCKET, null);
		expect(stdoutOutput).toContain("History (2):");
		expect(stdoutOutput).toContain("[created]");
		expect(stdoutOutput).toContain("title + overview changed");
		expect(stdoutOutput).toContain("Old title");
		expect(stdoutOutput).toContain("(none)");
	});

});

// ─── task create ─────────────────────────────────────────────────────────────

describe("task create", () => {
	const createdTask: Task = { ...FAKE_TASK, status: "todo", seq: 43, title: "New task" };

	it("creates task with explicit --project and --title and prints its seq and short ID", async () => {
		mockSend.mockResolvedValue(okResp(createdTask));

		await handleTask("create", args([], { project: "proj-001", title: "New task" }), SOCKET, null);

		expect(mockSend).toHaveBeenCalledWith(SOCKET, "task.create", {
			projectId: "proj-001",
			title: "New task",
		});
		expect(stdoutOutput).toContain("Created task");
		expect(stdoutOutput).toContain("New task");
		expect(stdoutOutput).toContain("(<seq:proj-001/43>)");
		expect(stdoutOutput).toContain("aaaaaaaa"); // first 8 chars
	});

	it("opts the new task in with --self-completion on", async () => {
		mockSend.mockResolvedValue(okResp(createdTask));

		await handleTask("create", args([], { project: "proj-001", title: "New task", "self-completion": "on" }), SOCKET, null);

		expect(mockSend).toHaveBeenCalledWith(SOCKET, "task.create", { projectId: "proj-001", title: "New task", selfCompletion: true });
	});

	it("takes the project from context and names the task it runs inside as the creator, even for another project", async () => {
		mockSend.mockResolvedValue(okResp(createdTask));

		await handleTask("create", args([], { title: "New task" }), SOCKET, CTX);
		expect(lastParams().projectId).toBe(CTX.projectId);

		await handleTask("create", args([], { project: "proj-other", title: "New task" }), SOCKET, CTX);
		expect(mockSend).toHaveBeenLastCalledWith(SOCKET, "task.create", {
			projectId: "proj-other",
			title: "New task",
			sourceTaskId: CTX.taskId,
		});
	});

	it("sends a normalized --type and names the role, and omits taskType for --type standard", async () => {
		mockSend.mockResolvedValue(okResp({ ...createdTask, taskType: "pr-review" }));
		await handleTask("create", args([], { project: "proj-001", title: "Review PR 42", type: "PR-Review" }), SOCKET, null);
		expect(mockSend).toHaveBeenCalledWith(SOCKET, "task.create", {
			projectId: "proj-001",
			title: "Review PR 42",
			taskType: "pr-review",
		});
		expect(stderrOutput).toContain("Role: pr-review");

		resetIO();
		mockSend.mockResolvedValue(okResp(createdTask));
		await handleTask("create", args([], { project: "proj-001", title: "New task", type: "standard" }), SOCKET, null);
		expect(mockSend).toHaveBeenCalledWith(SOCKET, "task.create", { projectId: "proj-001", title: "New task" });
		expect(stderrOutput).not.toContain("Role:");
	});

	it("rejects bad input before contacting the app", async () => {
		await expectRefusedBeforeSending([
			{ label: "unknown --type", sub: "create", a: args([], { project: "proj-001", title: "New task", type: "reviewer" }), stderr: ["--type must be one of coordinator, pr-review, board-cleanup or standard"] },
			{ label: "no --project and no context", sub: "create", a: args([], { title: "New task" }), stderr: ["--project"] },
			{ label: "no --title", sub: "create", a: args([], { project: "proj-001" }), stderr: ["--title"] },
			{ label: "whitespace-only --title", sub: "create", a: args([], { project: "proj-001", title: "   " }), stderr: ["--title"] },
		]);
	});

	describe("--pr / --branch", () => {
		it("sends --pr, implies pr-review, says where the worktree starts, and yields to an explicit --type", async () => {
			mockSend.mockResolvedValue(okResp({
				...createdTask,
				taskType: "pr-review",
				existingBranch: "arditti/fix/ctrl-o",
				foreignCode: true,
			}));

			await handleTask("create", args([], { project: "proj-001", title: "Review of #1512", pr: "1512" }), SOCKET, null);

			expect(mockSend).toHaveBeenCalledWith(SOCKET, "task.create", {
				projectId: "proj-001",
				title: "Review of #1512",
				taskType: "pr-review",
				pr: "1512",
			});
			expect(stderrOutput).toContain("Starts on: arditti/fix/ctrl-o");
			expect(stderrOutput).toContain("someone else's code");

			resetIO();
			mockSend.mockResolvedValue(okResp(createdTask));
			await handleTask("create", args([], { project: "proj-001", title: "X", pr: "5", type: "standard" }), SOCKET, null);
			expect(lastParams()).not.toHaveProperty("taskType");
			expect(lastParams().pr).toBe("5");
		});

		it("sends --branch without implying a type, and --worktree with it", async () => {
			mockSend.mockResolvedValue(okResp({ ...createdTask, existingBranch: "origin/feat/x" }));
			await handleTask("create", args([], { project: "proj-001", title: "Look", branch: "origin/feat/x" }), SOCKET, null);
			expect(mockSend).toHaveBeenCalledWith(SOCKET, "task.create", {
				projectId: "proj-001",
				title: "Look",
				branch: "origin/feat/x",
			});
			expect(stderrOutput).toContain("Starts on: origin/feat/x");
			expect(stderrOutput).not.toContain("someone else's code");

			resetIO();
			mockSend.mockResolvedValue(okResp({ ...createdTask, existingBranch: "linux-build", ownWorktree: true }));
			await handleTask("create", args([], { project: "proj-001", title: "Linux build", branch: "linux-build", worktree: "true" }), SOCKET, null);
			expect(mockSend).toHaveBeenCalledWith(SOCKET, "task.create", {
				projectId: "proj-001",
				title: "Linux build",
				branch: "linux-build",
				ownWorktree: true,
			});
			expect(stderrOutput).toContain("Runs in its own worktree");
		});

		it("does not claim an Operations board's tasks get their own worktree", async () => {
			vi.mocked(readProjectDirect).mockReturnValueOnce({ id: "proj-001", name: "Ops", path: "/ops", kind: "virtual" });
			mockSend.mockResolvedValue(okResp(createdTask));

			await handleTask("create", args([], { project: "proj-001", title: "Notes", worktree: "true" }), SOCKET, null);

			expect(stderrOutput).toContain("--worktree ignored");
			expect(stderrOutput).not.toContain("already get their own worktree");
		});

		it("rejects a value after --worktree, --pr with --branch, and --pr on a scratch task before contacting the app", async () => {
			await expectRefusedBeforeSending([
				{ label: "--worktree with a value", sub: "create", a: args([], { project: "proj-001", title: "X", worktree: "Linux build" }), stderr: ["--worktree takes no value"], exit: "EXIT_" },
				{ label: "--pr with --branch", sub: "create", a: args([], { project: "proj-001", title: "X", pr: "1", branch: "origin/x" }), stderr: ["pass one of them"] },
				{ label: "--pr on scratch", sub: "create", a: args([], { project: "proj-001", scratch: "true", run: "true", pr: "5" }) },
			]);
		});

		// Nothing was created, so the caller must be able to tell this apart from
		// "the task failed to be written" — hence its own code, not exit 1.
		it("exits 18 with the readable reason when the ref does not resolve", async () => {
			mockSend.mockResolvedValue({
				id: "1",
				ok: false,
				error: `${TASK_REF_UNRESOLVED_PREFIX}no pull request 999999 in this project (could not resolve).`,
			});

			await expect(
				handleTask("create", args([], { project: "proj-001", title: "Review of #999999", pr: "999999" }), SOCKET, null),
			).rejects.toThrow("EXIT_18");
			expect(stderrOutput).toContain("no pull request 999999 in this project");
			expect(stderrOutput).toContain("No task was created.");
			// The wire marker is plumbing — it must not reach the user's terminal.
			expect(stderrOutput).not.toContain(TASK_REF_UNRESOLVED_PREFIX);
		});

		it("still exits 1 for an ordinary creation failure", async () => {
			mockSend.mockResolvedValue({ id: "1", ok: false, error: "disk is full" });

			await expect(
				handleTask("create", args([], { project: "proj-001", title: "X" }), SOCKET, null),
			).rejects.toThrow("EXIT_1");
		});
	});
});

// ─── task create: description sources ───────────────────────────────────────
// With @file syntax the file content lands in positional[0] after
// resolveFileArgs. Bug once: createTask ignored positional args entirely and the
// file content was lost.

describe("task create description sources", () => {
	it("takes the description from --description or from positional (@file) content", async () => {
		const multiLine = "Port exposure\n\nShow which ports a task uses.\n\n**GitHub:** #190";
		const body = "Show which ports a task uses.\n\n**GitHub:** #190";
		const cases: Array<{ label: string; positional: string[]; flags: Record<string, string>; title: string; description?: string }> = [
			{ label: "--description flag", positional: [], flags: { title: "With desc", description: "Full description here" }, title: "With desc", description: "Full description here" },
			{ label: "positional with --title", positional: [body], flags: { title: "Port exposure" }, title: "Port exposure", description: body },
			{ label: "multi-line positional, no --title", positional: [multiLine], flags: {}, title: "Port exposure", description: multiLine },
			{ label: "single-line positional, no --title", positional: ["Fix the login bug"], flags: {}, title: "Fix the login bug" },
		];
		for (const c of cases) {
			resetIO();
			mockSend.mockResolvedValue(okResp(FAKE_TASK));
			await handleTask("create", args(c.positional, { project: "proj-001", ...c.flags }), SOCKET, null);
			expect(lastParams().title, c.label).toBe(c.title);
			if (c.description !== undefined) expect(lastParams().description, c.label).toBe(c.description);
		}
	});

	it("reads --description - from stdin without altering Markdown, using its first line when --title is omitted", async () => {
		mockSend.mockResolvedValue(okResp(FAKE_TASK));
		const markdown = '# Release notes\n\nUse **bold** and quote: "quoted".\n';
		mockReadStdin.mockResolvedValue(markdown);

		await handleTask("create", args([], { project: "proj-001", title: "Release notes", description: "-" }), SOCKET, null);

		expect(mockReadStdin).toHaveBeenCalledOnce();
		expect(mockSend).toHaveBeenCalledWith(SOCKET, "task.create", {
			projectId: "proj-001",
			title: "Release notes",
			description: markdown,
		});

		resetIO();
		mockSend.mockResolvedValue(okResp(FAKE_TASK));
		const untitled = "Release notes\n\n- Preserve this line exactly.\n";
		mockReadStdin.mockResolvedValue(untitled);
		await handleTask("create", args([], { project: "proj-001", description: "-" }), SOCKET, null);
		expect(lastParams().title).toBe("Release notes");
		expect(lastParams().description).toBe(untitled);
	});

	it("refuses a positional description together with --description instead of dropping one", async () => {
		await expectRefusedBeforeSending([
			{ label: "--description text", sub: "create", a: args(["positional text"], { project: "proj-001", title: "T", description: "flag text" }) },
			{ label: "--description -", sub: "create", a: args(["positional text"], { project: "proj-001", title: "T", description: "-" }) },
		]);
		expect(mockReadStdin).not.toHaveBeenCalled();
	});
});

// ─── task update ─────────────────────────────────────────────────────────────

describe("task update", () => {
	it("updates title and description with explicit task ID", async () => {
		mockSend.mockResolvedValue(okResp({ ...FAKE_TASK, title: "Updated title" }));

		await handleTask("update", args(["aaaaaaaa"], { title: "Updated title", description: "D" }), SOCKET, null);

		expect(mockSend).toHaveBeenCalledWith(SOCKET, "task.update", {
			taskId: "aaaaaaaa",
			title: "Updated title",
			description: "D",
		});
		expect(stdoutOutput).toContain("Updated task");
		expect(stdoutOutput).toContain("Updated title");
	});

	it("takes task and project from context, lets --project override it, and injects no project without one", async () => {
		mockSend.mockResolvedValue(okResp(FAKE_TASK));

		await handleTask("update", args([], { title: "New title" }), SOCKET, CTX);
		expect(lastParams().taskId).toBe(CTX.taskId);
		expect(lastParams().projectId).toBe(CTX.projectId);

		await handleTask("update", args([], { title: "T", project: "other" }), SOCKET, CTX);
		expect(lastParams().projectId).toBe("other");

		// A foreign task by explicit ID, no context: the server resolves it by ID alone.
		await handleTask("update", args(["bbbbbbbb"], { title: "Foreign update" }), SOCKET, null);
		expect(lastParams().taskId).toBe("bbbbbbbb");
		expect(lastParams()).not.toHaveProperty("projectId");
	});

	it("reads --description - from stdin without altering Markdown, and refuses a bare --description", async () => {
		mockSend.mockResolvedValue(okResp(FAKE_TASK));
		const markdown = '# Updated plan\n\nKeep **quotes**: "intact".';
		mockReadStdin.mockResolvedValue(markdown);

		await handleTask("update", args(["aaaaaaaa"], { description: "-" }), SOCKET, null);

		expect(mockReadStdin).toHaveBeenCalledOnce();
		expect(lastParams().description).toBe(markdown);

		// A bare flag parses as "true" — it must not overwrite the description with it.
		mockSend.mockClear();
		await expect(handleTask("update", args(["aaaaaaaa"], { description: "true" }), SOCKET, null)).rejects.toThrow("EXIT_3");
		expect(mockSend).not.toHaveBeenCalled();
	});

	it("clears the description when --description is empty or whitespace-only", async () => {
		// Tri-state: a present flag (even empty/whitespace) means set, absent means leave alone.
		mockSend.mockResolvedValue(okResp({ ...FAKE_TASK, description: "" }));
		for (const value of ["   ", ""]) {
			await handleTask("update", args(["aaaaaaaa"], { description: value }), SOCKET, null);
			expect(lastParams(), JSON.stringify(value)).toHaveProperty("description", "");
		}
	});

	it("rejects bad input before sending", async () => {
		await expectRefusedBeforeSending([
			{ label: "no update field", sub: "update", a: args(["aaaaaaaa"]), stderr: ["--title", "--description"] },
			{ label: "no task ID and no context", sub: "update", a: args([], { title: "T" }) },
			{ label: "whitespace-only --title as the only field", sub: "update", a: args(["aaaaaaaa"], { title: "   " }) },
			{ label: "unknown --type", sub: "update", a: args(["aaaaaaaa"], { type: "overlord" }), stderr: ["--type"] },
			{ label: "invalid --manual-completion", sub: "update", a: args(["aaaaaaaa"], { "manual-completion": "sometimes" }), stderr: ["--manual-completion"] },
			{ label: "invalid --priority", sub: "update", a: args(["aaaaaaaa"], { priority: "urgent" }), stderr: ["--priority"] },
			{ label: "invalid --self-completion", sub: "update", a: args(["aaaaaaaa"], { "self-completion": "maybe" }), stderr: ["--self-completion must be on or off"], exit: "EXIT_" },
			{ label: "--print-role on another task", sub: "update", a: args(["bbbbbbbb"], { type: "coordinator", "print-role": "true" }), ctx: CTX },
			{ label: "--print-role without --type", sub: "update", a: args([], { title: "new", "print-role": "true" }), ctx: CTX },
		]);
	});

	it("accepts standalone flag updates normalized, including --type with standard mapped onto a cleared type", async () => {
		const cases: Array<{ flags: Record<string, string>; sent: Record<string, unknown> }> = [
			{ flags: { priority: "p0" }, sent: { priority: "P0" } },
			{ flags: { "manual-completion": "on" }, sent: { manualCompletion: true } },
			{ flags: { "self-completion": "on" }, sent: { selfCompletion: true } },
			{ flags: { title: "T", force: "true" }, sent: { title: "T", force: true } },
		];
		for (const c of cases) {
			resetIO();
			mockSend.mockResolvedValue(okResp({ task: FAKE_TASK, titlePreserved: false }));
			await handleTask("update", args(["aaaaaaaa"], c.flags), SOCKET, null);
			expect(mockSend, JSON.stringify(c.flags)).toHaveBeenCalledWith(SOCKET, "task.update", { taskId: "aaaaaaaa", ...c.sent });
			expect(stdoutOutput, JSON.stringify(c.flags)).toContain("Updated task");
		}
		resetIO();
		mockSend.mockResolvedValue(okResp({ task: { ...FAKE_TASK, taskType: "coordinator" }, titlePreserved: false, roleDelivery: "delivered" }));
		await handleTask("update", args(["aaaaaaaa"], { type: "coordinator" }), SOCKET, null);
		expect(mockSend).toHaveBeenCalledWith(SOCKET, "task.update", { taskId: "aaaaaaaa", taskType: "coordinator" });
		expect(stderrOutput).toContain("told the running agent");

		mockSend.mockResolvedValue(okResp({ task: FAKE_TASK, titlePreserved: false, roleDelivery: "no-session" }));
		await handleTask("update", args(["aaaaaaaa"], { type: "standard" }), SOCKET, null);
		expect(mockSend).toHaveBeenLastCalledWith(SOCKET, "task.update", { taskId: "aaaaaaaa", taskType: null });
	});

	it("never reports an undelivered role change as a success, and says a held one is still coming", async () => {
		const respond = (roleDelivery: string) =>
			mockSend.mockResolvedValue(okResp({ task: { ...FAKE_TASK, taskType: "coordinator" }, titlePreserved: false, roleDelivery }));

		respond("not-delivered");
		await handleTask("update", args(["aaaaaaaa"], { type: "coordinator" }), SOCKET, null);
		expect(stderrOutput).toContain("could NOT tell the running agent");

		// Held behind the agent's open prompt: it will arrive, so pasting it too would double it.
		stderrOutput = "";
		respond("held");
		await handleTask("update", args(["aaaaaaaa"], { type: "coordinator" }), SOCKET, null);
		expect(stderrOutput).toContain("sent after it is answered");
		expect(stderrOutput).not.toContain("paste the new role in yourself");
	});

	// What /dev3-coordinator runs: promote the task this worktree is already in and
	// read the brief here, rather than have it typed back into this same pane.
	it("prints the role brief on --print-role for the auto-detected task", async () => {
		mockSend.mockResolvedValue(okResp({
			task: { ...FAKE_TASK, taskType: "coordinator" },
			titlePreserved: false,
			roleDelivery: "printed",
			rolePrompt: "You are the COORDINATOR of this board.",
			rolePromptSource: "project",
		}));

		await handleTask("update", args([], { type: "coordinator", "print-role": "true" }), SOCKET, CTX);

		expect(mockSend).toHaveBeenCalledWith(SOCKET, "task.update", {
			taskId: CTX.taskId,
			projectId: CTX.projectId,
			taskType: "coordinator",
			printRole: true,
		});
		expect(stdoutOutput).toContain("Your role is now coordinator");
		expect(stdoutOutput).toContain("You are the COORDINATOR of this board.");
		expect(stdoutOutput).toContain("Brief source: project override");
		expect(stderrOutput).toContain("printed below instead of typed into your own pane");
	});

	it("prints the brief again when a repeat changed nothing", async () => {
		mockSend.mockResolvedValue(okResp({
			task: { ...FAKE_TASK, taskType: "coordinator" },
			titlePreserved: false,
			rolePrompt: "You are the COORDINATOR of this board.",
		}));

		await handleTask("update", args([], { type: "coordinator", "print-role": "true" }), SOCKET, CTX);

		expect(stdoutOutput).toContain("You are the COORDINATOR of this board.");
		// An older backend sends no source: no line rather than a guessed one.
		expect(stdoutOutput).not.toContain("Brief source:");
		expect(stderrOutput).not.toContain("Role:");
	});

	// The description is the agent's first prompt at launch and nothing re-delivers
	// it, so a rewrite on a live task has to say so at the keyboard.
	it("warns that a running agent will not see a new description (with --project in the hint), and stays quiet otherwise", async () => {
		mockSend.mockResolvedValue(okResp({ task: FAKE_TASK, titlePreserved: false }));

		await handleTask("update", args(["aaaaaaaa"], { description: "Now also fix it" }), SOCKET, null);
		expect(stdoutOutput).toContain("running agent will NOT see this");
		expect(stdoutOutput).toContain("dev3 message --task aaaaaaaa");

		stdoutOutput = "";
		await handleTask("update", args(["aaaaaaaa"], { description: "Now also fix it", project: "proj-002" }), SOCKET, null);
		expect(stdoutOutput).toContain("dev3 message --task aaaaaaaa --project proj-002");
		stdoutOutput = "";
		mockSend.mockResolvedValue(okResp({ task: { ...FAKE_TASK, status: "todo", worktreePath: null }, titlePreserved: false }));
		await handleTask("update", args(["aaaaaaaa"], { description: "Brief for later" }), SOCKET, null);
		expect(stdoutOutput).toContain("Updated task");
		expect(stdoutOutput).not.toContain("running agent");

		stdoutOutput = "";
		mockSend.mockResolvedValue(okResp({ task: FAKE_TASK, titlePreserved: false }));
		await handleTask("update", args(["aaaaaaaa"], { title: "Renamed by the agent" }), SOCKET, null);
		expect(stdoutOutput).not.toContain("running agent");
	});

	it("prints a notice when the server reports titlePreserved=true (issue #564)", async () => {
		mockSend.mockResolvedValue(okResp({
			task: { ...FAKE_TASK, customTitle: "User-set title" },
			titlePreserved: true,
		}));

		await handleTask(
			"update",
			args(["aaaaaaaa"], { title: "Agent rename attempt" }),
			SOCKET,
			null,
		);

		expect(stderrOutput).toContain("title preserved");
		expect(stderrOutput).toContain("user-edited");
		expect(stdoutOutput).toContain("Updated task");
		expect(stdoutOutput).toContain("User-set title");
	});

	it("accepts legacy Task-shape response without envelope", async () => {
		// Backward compatibility while old servers may still return Task directly.
		const updated = { ...FAKE_TASK, customTitle: "Renamed" };
		mockSend.mockResolvedValue(okResp(updated));

		await handleTask(
			"update",
			args(["aaaaaaaa"], { title: "Renamed" }),
			SOCKET,
			null,
		);

		expect(stdoutOutput).toContain("Renamed");
		expect(stderrOutput).not.toContain("title preserved");
	});
});

// ─── explicit target flags (--id / --task / --task-id) ───────────────────────
// They let agents show/update/move ANY task, not just the current one, and must
// never silently fall back to the context task.

describe("explicit task target flags", () => {
	type Target = { label: string; positional?: string[]; flags: Record<string, string>; ctx: CliContext | null; expected: string };
	const targets: Target[] = [
		{ label: "--id without a positional", flags: { id: "bbbbbbbb" }, ctx: null, expected: "bbbbbbbb" },
		{ label: "--id over context", flags: { id: "bbbbbbbb" }, ctx: CTX, expected: "bbbbbbbb" },
		{ label: "positional over --id", positional: ["cccccccc"], flags: { id: "bbbbbbbb" }, ctx: null, expected: "cccccccc" },
		{ label: "--task over context", flags: { task: "bbbbbbbb" }, ctx: CTX, expected: "bbbbbbbb" },
		{ label: "--task-id over context", flags: { "task-id": "cccccccc" }, ctx: CTX, expected: "cccccccc" },
	];

	it.each<{ sub: string; method: string; extra: Record<string, string> }>([
		{ sub: "show", method: "task.show", extra: {} },
		{ sub: "update", method: "task.update", extra: { title: "T" } },
		{ sub: "move", method: "task.move", extra: { status: "review-by-user" } },
	])("task $sub resolves the target in the right order", async ({ sub, method, extra }) => {
		for (const t of targets) {
			resetIO();
			mockSend.mockResolvedValue(okResp(FAKE_TASK));
			await handleTask(sub, args(t.positional ?? [], { ...t.flags, ...extra }), SOCKET, t.ctx);
			const call = mockSend.mock.calls.find((c) => c[1] === method);
			expect(call?.[2]?.taskId, t.label).toBe(t.expected);
		}
	});

	it("rejects unknown flags instead of falling back to context", async () => {
		await expectRefusedBeforeSending([
			{ label: "--taskk", sub: "update", a: args([], { taskk: "bbbbbbbb", description: "D" }), ctx: CTX, stderr: ["Unknown option", "--taskk"] },
		]);
	});

	// `tasks list` displays 8-char short IDs; we once observed live
	// `dev3 task show --id 5f01f223` → "Task not found", because the CLI passed the
	// prefix as-is and the server only matches full UUIDs.
	it("resolves an 8-char short ID to the full UUID before sending, for show, update and move", async () => {
		const shortId = FAKE_TASK.id.slice(0, 8);
		const cases: Array<[string, Record<string, string>]> = [
			["show", {}],
			["update", { title: "Updated" }],
			["move", { status: "review-by-user" }],
		];
		for (const [sub, flags] of cases) {
			resetIO();
			mockSend.mockResolvedValue(okResp(FAKE_TASK));
			await handleTask(sub, args([shortId], flags), SOCKET, CTX);
			expect(mockSend.mock.calls[0]![2]!.taskId, sub).toBe(FAKE_TASK.id);
		}
	});
});

// ─── task move ───────────────────────────────────────────────────────────────

describe("task move", () => {
	it("moves task to new status with explicit ID and prints arrow notation", async () => {
		mockSend.mockResolvedValue(okResp({ ...FAKE_TASK, status: "review-by-ai" as const }));

		await handleTask("move", args(["aaaaaaaa"], { status: "review-by-ai" }), SOCKET, null);

		expect(mockSend).toHaveBeenCalledWith(SOCKET, "task.move", {
			taskId: "aaaaaaaa",
			newStatus: "review-by-ai",
		});
		expect(stdoutOutput).toContain("Moved task");
		expect(stdoutOutput).toMatch(/→.*AI Review/);
	});

	it("takes task and project from context unless --project overrides it", async () => {
		mockSend.mockResolvedValue(okResp({ ...FAKE_TASK, status: "user-questions" as const }));
		await handleTask("move", args([], { status: "user-questions" }), SOCKET, CTX);
		let params = moveCall(mockSend)![2];
		expect(params.taskId).toBe(CTX.taskId);
		expect(params.projectId).toBe(CTX.projectId);
		expect(params.newStatus).toBe("user-questions");

		resetIO();
		mockSend.mockResolvedValue(okResp({ ...FAKE_TASK, status: "review-by-user" as const }));
		await handleTask("move", args(["aaaaaaaa"], { status: "review-by-user" }), SOCKET, CTX);
		expect(moveCall(mockSend)![2].projectId).toBe(CTX.projectId);

		resetIO();
		mockSend.mockResolvedValue(okResp({ ...FAKE_TASK, status: "review-by-user" as const }));
		await handleTask("move", args(["aaaaaaaa"], { status: "review-by-user", project: "other" }), SOCKET, CTX);
		params = moveCall(mockSend)![2];
		expect(params.projectId).toBe("other");
	});

	it("rejects bad input before sending", async () => {
		await expectRefusedBeforeSending([
			{ label: "no --status", sub: "move", a: args(["aaaaaaaa"]), stderr: ["--status"] },
			{ label: "no task ID and no context", sub: "move", a: args([], { status: "review-by-user" }) },
			{ label: "empty --status", sub: "move", a: args(["aaaaaaaa"], { status: "" }) },
			{ label: "--force on a status other than completed", sub: "move", a: args(["aaaaaaaa"], { status: "cancelled", force: "true" }), stderr: ["--force only applies to --status completed"], exit: "EXIT_" },
			{ label: "--if-status with --status todo", sub: "move", a: args(["aaaaaaaa"], { status: "todo", "if-status": "in-progress" }) },
		]);
	});

	// Unknown values may be custom column IDs, so the server validates them.
	it("forwards any status to the server and surfaces its refusal", async () => {
		for (const [status, error] of [
			["review-by-user", "Invalid status transition"],
			["garbage", 'Invalid status: "garbage"'],
			["in_progress", 'Invalid status: "in_progress"'],
		]) {
			resetIO();
			mockSend.mockResolvedValue(errResp(error));
			await expect(handleTask("move", args(["aaaaaaaa"], { status }), SOCKET, null), status).rejects.toThrow("EXIT_1");
			expect(mockSend, status).toHaveBeenCalled();
			expect(stderrOutput, status).toContain(error);
		}
	});

	it("exits with the draft exit code when the task is a draft", async () => {
		mockSend.mockResolvedValue(errResp(DRAFT_TASK_ACTIVATION_ERROR));

		await expect(
			handleTask("move", args(["aaaaaaaa"], { status: "in-progress" }), SOCKET, null),
		).rejects.toThrow(`EXIT_${CLI_EXIT_CODE_TASK_IS_DRAFT}`);
		expect(stderrOutput).toContain("draft");
	});

	it("keeps hook flags off the wire: --tolerate-app-offline changes nothing, --codex-stop-hook prints minimal JSON", async () => {
		// --tolerate-app-offline only softens the app-offline exit code (decided before
		// dispatch, in main.ts); a reachable app must behave exactly as without it.
		mockSend.mockResolvedValue(okResp({ ...FAKE_TASK, status: "in-progress" as const }));
		await handleTask("move", args(["aaaaaaaa"], { status: "in-progress", "tolerate-app-offline": "true" }), SOCKET, null);
		expect(mockSend).toHaveBeenCalledWith(SOCKET, "task.move", { taskId: "aaaaaaaa", newStatus: "in-progress" });
		expect(stderrOutput).not.toContain("Unknown flag");

		resetIO();
		mockSend.mockResolvedValue(okResp({ ...FAKE_TASK, status: "review-by-user" as const }));
		await handleTask("move", args(["aaaaaaaa"], { status: "review-by-user", "codex-stop-hook": "true" }), SOCKET, null);
		expect(mockSend).toHaveBeenCalledWith(SOCKET, "task.move", { taskId: "aaaaaaaa", newStatus: "review-by-user" });
		expect(stdoutOutput).toBe("{}");
	});

	it("passes --if-status / --if-status-not (comma lists included) only when given", async () => {
		mockSend.mockResolvedValue(okResp({ ...FAKE_TASK, status: "in-progress" as const }));
		const move = async (flags: Record<string, string>) => {
			await handleTask("move", args(["aaaaaaaa"], { status: "in-progress", ...flags }), SOCKET, null);
			return lastParams();
		};

		expect(await move({ "if-status": "todo" })).toMatchObject({ ifStatus: "todo", newStatus: "in-progress" });
		expect(await move({ "if-status-not": "review-by-ai,review-by-user" })).toMatchObject({ ifStatusNot: "review-by-ai,review-by-user" });
		expect(await move({ "if-status": "todo", "if-status-not": "review-by-ai" })).toMatchObject({ ifStatus: "todo", ifStatusNot: "review-by-ai" });
		const bare = await move({});
		expect(bare).not.toHaveProperty("ifStatus");
		expect(bare).not.toHaveProperty("ifStatusNot");
	});
});

// ─── task move --status completed (agent completion request) ────────────────
// "completed" is not a direct move: the CLI sends task.requestCompletion and
// blocks until the user answers the approval dialog in the app.

describe("task move --status completed", () => {
	it("sends task.requestCompletion with the long approval timeout, and prints minimal JSON for Codex stop hooks", async () => {
		mockSend.mockResolvedValue(okResp({ approved: true, task: { ...FAKE_TASK, status: "completed" } }));

		await handleTask("move", args(["aaaaaaaa"], { status: "completed" }), SOCKET, null);

		expect(mockSend).toHaveBeenCalledWith(
			SOCKET,
			"task.requestCompletion",
			{ taskId: "aaaaaaaa" },
			{ timeoutMs: 10 * 60 * 1000 },
		);
		expect(stderrOutput).toContain("requires user approval");
		expect(stdoutOutput).toContain("User approved");
		expect(stdoutOutput).toContain("moved to Completed");

		stdoutOutput = "";
		await handleTask("move", args(["aaaaaaaa"], { status: "completed", "codex-stop-hook": "true" }), SOCKET, null);
		expect(stdoutOutput).toBe("{}");
	});

	it("sends force with --force without waiting on a dialog, and surfaces the app's refusal when the task never opted in", async () => {
		mockSend.mockResolvedValue(okResp({ approved: true, task: { ...FAKE_TASK, status: "completed" } }));
		await handleTask("move", args(["aaaaaaaa"], { status: "completed", force: "true" }), SOCKET, null);
		expect(mockSend).toHaveBeenCalledWith(SOCKET, "task.requestCompletion", { taskId: "aaaaaaaa", force: true }, { timeoutMs: 2 * 60 * 1000 });
		expect(stderrOutput).not.toContain("requires user approval");
		expect(stdoutOutput).toContain("Completed without asking (--force)");

		mockSend.mockResolvedValue(errResp("This task has not opted in to self-completion"));
		await expect(
			handleTask("move", args(["aaaaaaaa"], { status: "completed", force: "true" }), SOCKET, null),
		).rejects.toThrow();
		expect(stderrOutput).toContain("has not opted in to self-completion");
	});

	// The task reached Completed another way (board, merged PR) while the dialog
	// was open: the app voids the request and the agent got what it asked for.
	it("succeeds when the request was voided because the task is already completed, Codex hook included", async () => {
		mockSend.mockResolvedValue(okResp({ approved: false, stale: true, taskStatus: "completed" }));

		await handleTask("move", args(["aaaaaaaa"], { status: "completed" }), SOCKET, null);
		expect(stdoutOutput).toContain("already Completed");
		expect(stdoutOutput).toContain("got there another way");

		stdoutOutput = "";
		await handleTask("move", args(["aaaaaaaa"], { status: "completed", "codex-stop-hook": "true" }), SOCKET, null);
		expect(stdoutOutput).not.toContain("already Completed");
		expect(stdoutOutput.trim().startsWith("{")).toBe(true);
	});

	it("exits 6 with the voided wording or the user's decline, and 1 on a server error", async () => {
		mockSend.mockResolvedValue(okResp({ approved: false, stale: true, taskStatus: "cancelled" }));
		await expect(handleTask("move", args(["aaaaaaaa"], { status: "completed" }), SOCKET, null)).rejects.toThrow("EXIT_6");
		expect(stderrOutput).toContain("voided before anyone answered");
		expect(stderrOutput).not.toContain("User declined");

		stderrOutput = "";
		mockSend.mockResolvedValue(okResp({ approved: false, stale: true, taskStatus: null }));
		await expect(handleTask("move", args(["aaaaaaaa"], { status: "completed" }), SOCKET, null)).rejects.toThrow("EXIT_6");
		expect(stderrOutput).toContain("was deleted");
		stderrOutput = "";
		mockSend.mockResolvedValue(okResp({ approved: false }));

		await expect(
			handleTask("move", args(["aaaaaaaa"], { status: "completed" }), SOCKET, null),
		).rejects.toThrow("EXIT_6");
		expect(stderrOutput).toContain("User declined the completion request");
		expect(stderrOutput).toContain("session stays alive");
		stderrOutput = "";
		mockSend.mockResolvedValue(errResp("Task is already completed"));

		await expect(
			handleTask("move", args(["aaaaaaaa"], { status: "completed" }), SOCKET, null),
		).rejects.toThrow("EXIT_1");
		expect(stderrOutput).toContain("Task is already completed");
	});

	it("exits with code 48 when the approved completion left the worktree half removed (h0x91b/dev-3.0#2269)", async () => {
		mockSend.mockResolvedValue({ ...errResp("The worktree at /tmp/wt is half removed: ..."), reason: "worktree-half-removed" });

		await expect(
			handleTask("move", args(["aaaaaaaa"], { status: "completed" }), SOCKET, null),
		).rejects.toThrow("EXIT_48");
		expect(stderrOutput).toContain("/tmp/wt is half removed");
		expect(stderrOutput).toContain("Run the same `dev3 task move` again");
		expect(stdoutOutput).not.toContain("User approved");
	});
});

// A reset: `todo` on a task with a run. The user approves it in the app, whoever
// asks — no task context grants consent (T17, T17b).
describe("task move --status todo", () => {
	it("always goes through task.requestReset with the long approval timeout, with or without a task context", async () => {
		for (const ctx of [null, CTX]) {
			mockSend.mockReset();
			mockSend.mockResolvedValue(okResp({ approved: true, task: { ...FAKE_TASK, status: "todo" } }));
			await handleTask("move", args(["aaaaaaaa"], { status: "todo" }), SOCKET, ctx);
			expect(mockSend.mock.calls.map((call) => call[1])).toEqual(["task.requestReset"]);
			expect(mockSend.mock.calls[0]![3]).toEqual({ timeoutMs: 10 * 60 * 1000 });
		}
		expect(stderrOutput).toContain("resets it");
		expect(stdoutOutput).toContain("moved to To Do");
	});

	it("reports a plain move when there was nothing to reset", async () => {
		mockSend.mockResolvedValue(okResp({ approved: true, plainMove: true, task: { ...FAKE_TASK, status: "todo" } }));
		await handleTask("move", args(["aaaaaaaa"], { status: "todo" }), SOCKET, null);
		expect(stdoutOutput).toContain("owned no run, so nothing was reset");
		expect(stdoutOutput).not.toContain("User approved");
	});

	it("exits 27 when the user declines, saying nothing was stopped or deleted", async () => {
		mockSend.mockResolvedValue(okResp({ approved: false }));
		await expect(handleTask("move", args(["aaaaaaaa"], { status: "todo" }), SOCKET, null)).rejects.toThrow(`EXIT_${CLI_EXIT_CODE_RESET_DECLINED}`);
		expect(stderrOutput).toContain("nothing was stopped or deleted");
	});
});

// ─── task move --status cancelled (agent cancellation request) ──────────────
// Same approval contract as `completed`, its own method and its own exit code:
// "the work landed" and "the work is garbage" must not be one answer.

describe("task move --status cancelled", () => {
	it("sends task.requestCancellation with the long approval timeout", async () => {
		mockSend.mockResolvedValue(okResp({ approved: true, task: { ...FAKE_TASK, status: "cancelled" } }));

		await handleTask("move", args(["aaaaaaaa"], { status: "cancelled" }), SOCKET, null);

		expect(mockSend).toHaveBeenCalledWith(
			SOCKET,
			"task.requestCancellation",
			{ taskId: "aaaaaaaa" },
			{ timeoutMs: 10 * 60 * 1000 },
		);
		expect(stderrOutput).toContain("requires user approval");
		expect(stdoutOutput).toContain("User approved");
		expect(stdoutOutput).toContain("moved to Cancelled");
	});

	it("exits with code 22 when the user declines", async () => {
		mockSend.mockResolvedValue(okResp({ approved: false }));

		await expect(
			handleTask("move", args(["aaaaaaaa"], { status: "cancelled" }), SOCKET, null),
		).rejects.toThrow("EXIT_22");
		expect(stderrOutput).toContain("User declined the cancellation request");
		expect(stderrOutput).toContain("session stays alive");
	});

	it("on an approval timeout, warns this session dies for its own task but not for another task", async () => {
		mockSend.mockRejectedValue(new Error("Socket timeout (600s)"));

		await expect(
			handleTask("move", args(["aaaaaaaa"], { status: "cancelled" }), SOCKET, CTX),
		).rejects.toThrow("EXIT_1");
		expect(stderrOutput).toContain("Timed out waiting for the user's decision");
		expect(stderrOutput).toContain("this session will be destroyed");
		stderrOutput = "";
		// The dialog is about the TARGET task, so for `--task`/`--project` the old
		// "this session will be destroyed" was simply false, and it read as if the
		// prompt were scoped to the requester (h0x91b/dev-3.0#1669).
		mockSend.mockRejectedValue(new Error("Socket timeout (600s)"));

		await expect(
			handleTask("move", args([], { task: "seq:7", project: "proj-002", status: "cancelled" }), SOCKET, CTX),
		).rejects.toThrow("EXIT_1");
		expect(stderrOutput).toContain("This session is not the target");
		expect(stderrOutput).not.toContain("this session will be destroyed");
	});

	it("says whose worktree died when another task was cancelled", async () => {
		mockSend.mockResolvedValue(okResp({
			approved: true,
			task: { ...FAKE_TASK, id: "bbbbbbbb-1111-2222-3333-444444444444", status: "cancelled" },
		}));

		await handleTask("move", args([], { task: "seq:7", project: "proj-002", status: "cancelled" }), SOCKET, CTX);

		expect(stdoutOutput).toContain("this session is unaffected");
		expect(stdoutOutput).not.toContain("This worktree and terminal session are being destroyed");
	});
});

// ─── approval after a dropped socket ────────────────────────────────────────
// The request lives in the app, not on the connection. When the socket drops
// mid-wait the CLI asks the SAME app where it stands (approval.status) and only
// re-attaches (attachOnly) to a request it confirmed is pending — so neither a
// retry nor a restart can ever open a second dialog. Pending, declined,
// approved and unknown each get their own exit.

function emptyResponse(): Error {
	const err = new Error("Empty response from server");
	err.name = "EmptyResponseError";
	return err;
}

type Step = CliResponse | Error;

/** Script sendRequest per method; each call consumes the next step (the last one repeats). */
function script(steps: Record<string, Step[]>): void {
	mockSend.mockImplementation(async (_socket, method) => {
		const queue = steps[method];
		if (!queue || queue.length === 0) throw new Error(`unexpected ${method}`);
		const step = queue.length > 1 ? queue.shift()! : queue[0];
		if (step instanceof Error) throw step;
		return step;
	});
}

function status(state: "pending" | "answered" | "none", taskStatus: string, approved?: boolean) {
	return okResp({ kind: "cancel", state, taskStatus, ...(approved === undefined ? {} : { approved }) });
}

function callsOf(method: string) {
	return mockSend.mock.calls.filter((call) => call[1] === method);
}

// S4/S6 (Seq 2003 review 2003-010): a legacy To Do card that owns a worktree is
// ALREADY `todo`, so for a reset the status alone proves nothing.
describe("task move --status todo after the socket drops", () => {
	const method = "task.requestReset";
	const reset = (state: "pending" | "answered" | "none", resetNeeded: boolean, extra: Record<string, unknown> = {}) =>
		okResp({ kind: "reset", state, taskStatus: "todo", resetNeeded, ...extra });

	it("a pending request on a todo card is still pending (exit 25), not a false success", async () => {
		script({ [method]: [new Error("Socket timeout (600s)")], "approval.status": [reset("pending", true)] });
		await expect(handleTask("move", args(["aaaaaaaa"], { status: "todo" }), SOCKET, null)).rejects.toThrow("EXIT_25");
		expect(stdoutOutput).not.toContain("now To Do");
	});

	it("no record + todo card that still owns its run → outcome unknown, not success", async () => {
		script({ [method]: [emptyResponse()], "approval.status": [reset("none", true)] });
		await expect(handleTask("move", args(["aaaaaaaa"], { status: "todo" }), SOCKET, null)).rejects.toThrow("EXIT_26");
	});

	it("todo and no run left to reset → the reset happened", async () => {
		script({ [method]: [emptyResponse()], "approval.status": [reset("answered", false, { approved: true })] });
		await handleTask("move", args(["aaaaaaaa"], { status: "todo" }), SOCKET, null);
		expect(stdoutOutput).toContain("now To Do");
	});

	it("a voided request says so — no false 'nothing was deleted'", async () => {
		script({ [method]: [emptyResponse()], "approval.status": [reset("answered", false, { approved: false, stale: true })] });
		await expect(handleTask("move", args(["aaaaaaaa"], { status: "todo" }), SOCKET, null)).rejects.toThrow(`EXIT_${CLI_EXIT_CODE_RESET_DECLINED}`);
		expect(stderrOutput).toContain("voided before anyone answered");
		expect(stderrOutput).toContain("may have removed its worktree");
		expect(stderrOutput).not.toContain("nothing was stopped or deleted");
	});

	it("a direct stale result says the same, and a kept branch is reported", async () => {
		mockSend.mockResolvedValue(okResp({ approved: false, stale: true }));
		await expect(handleTask("move", args(["aaaaaaaa"], { status: "todo" }), SOCKET, null)).rejects.toThrow(`EXIT_${CLI_EXIT_CODE_RESET_DECLINED}`);
		expect(stderrOutput).toContain("voided before anyone answered");

		stderrOutput = "";
		mockSend.mockResolvedValue(okResp({ approved: true, task: { ...FAKE_TASK, status: "todo" }, keptBranches: [{ name: "release/2.0", reason: "not-owned" }] }));
		await handleTask("move", args(["aaaaaaaa"], { status: "todo" }), SOCKET, null);
		expect(stdoutOutput).toContain("Kept branch release/2.0: dev3 did not create it for this task");
	});
});

// Completion and cancellation share one re-attach loop (waitForDestructiveApproval),
// so only the per-kind outcomes run for both; the loop mechanics run once, for cancel.
describe.each([
	{ status: "cancelled", method: "task.requestCancellation", declineExit: "EXIT_22" },
	{ status: "completed", method: "task.requestCompletion", declineExit: "EXIT_6" },
] as const)("task move --status $status after the socket drops", ({ status: target, method, declineExit }) => {
	it("re-attaches to a request the app confirms is pending, and reports the user's answer", async () => {
		script({
			[method]: [emptyResponse(), okResp({ approved: true, task: { ...FAKE_TASK, status: target } })],
			"approval.status": [status("pending", "in-progress")],
		});

		await handleTask("move", args(["aaaaaaaa"], { status: target }), SOCKET, null);

		const requests = callsOf(method);
		expect(requests).toHaveLength(2);
		expect(requests[0][2]).toEqual({ taskId: "aaaaaaaa" });
		expect(requests[1][2]).toEqual({ taskId: "aaaaaaaa", attachOnly: true });
		expect(stderrOutput).toContain("still pending there");
		expect(stdoutOutput).toContain("User approved");
	});

	it("never re-sends the request when the app says the user already declined", async () => {
		script({ [method]: [emptyResponse()], "approval.status": [status("answered", "in-progress", false)] });

		await expect(handleTask("move", args(["aaaaaaaa"], { status: target }), SOCKET, null)).rejects.toThrow(declineExit);
		expect(callsOf(method)).toHaveLength(1);
		expect(stderrOutput).toContain("User declined");
	});
});

describe("task move --status cancelled: re-attach loop after the socket drops", () => {
	const target = "cancelled";
	const method = "task.requestCancellation";
	const declineExit = "EXIT_22";

	it("reports an approval that landed while disconnected, and a move with no record of the answer, as success", async () => {
		script({ [method]: [emptyResponse()], "approval.status": [status("answered", target, true)] });
		await handleTask("move", args(["aaaaaaaa"], { status: target }), SOCKET, null);
		expect(callsOf(method)).toHaveLength(1);
		expect(stdoutOutput).toContain("User approved");

		resetIO();
		script({ [method]: [emptyResponse()], "approval.status": [status("none", target)] });
		await handleTask("move", args(["aaaaaaaa"], { status: target }), SOCKET, null);
		expect(stdoutOutput).toContain("no record of how the request was answered");
		expect(stdoutOutput).not.toContain("User approved");
	});

	it("exits 26 without re-asking when the app has no record and the task has not moved", async () => {
		script({ [method]: [emptyResponse()], "approval.status": [status("none", "in-progress")] });

		await expect(handleTask("move", args(["aaaaaaaa"], { status: target }), SOCKET, null)).rejects.toThrow("EXIT_26");
		expect(callsOf(method)).toHaveLength(1);
		expect(stderrOutput).toContain("outcome is unknown");
		// No record is not evidence either way.
		expect(stderrOutput).toContain("not evidence");
		expect(stderrOutput).not.toContain("User declined");
		expect(stderrOutput).not.toMatch(/nothing was approved/i);
	});

	it("never re-attaches through an app that does not know approval.status", async () => {
		vi.useFakeTimers();
		try {
			// An old app would read attachOnly as a fresh ask and answer it; the CLI
			// must never get that far.
			script({
				[method]: [emptyResponse(), okResp({ approved: true, task: { ...FAKE_TASK, status: target } })],
				"approval.status": [errResp("Unknown method: approval.status")],
			});

			const run = expect(handleTask("move", args(["aaaaaaaa"], { status: target }), SOCKET, null)).rejects.toThrow("EXIT_26");
			await vi.advanceTimersByTimeAsync(61_000);
			await run;
			expect(callsOf(method)).toHaveLength(1);
			expect(stderrOutput).toContain("could not be reached again");
		} finally {
			vi.useRealTimers();
		}
	});

	it("keeps probing through a restart window, then re-attaches", async () => {
		vi.useFakeTimers();
		try {
			const appDown = new Error("APP_NOT_RUNNING");
			script({
				[method]: [emptyResponse(), okResp({ approved: false })],
				"approval.status": [appDown, appDown, status("pending", "in-progress")],
			});

			const run = expect(handleTask("move", args(["aaaaaaaa"], { status: target }), SOCKET, null)).rejects.toThrow(declineExit);
			await vi.advanceTimersByTimeAsync(10_000);
			await run;
			expect(callsOf("approval.status")).toHaveLength(3);
			expect(callsOf(method)[1][2]).toMatchObject({ attachOnly: true });
		} finally {
			vi.useRealTimers();
		}
	});

	it("exits 25 when the wait ran out and the app says the request is still pending", async () => {
		script({ [method]: [new Error("Socket timeout (600s)")], "approval.status": [status("pending", "in-progress")] });

		await expect(handleTask("move", args(["aaaaaaaa"], { status: target }), SOCKET, null)).rejects.toThrow("EXIT_25");
		expect(callsOf(method)).toHaveLength(1);
		expect(stderrOutput).toContain("still pending");
		expect(stderrOutput).toContain("does not open a second dialog");
	});

	it("does not treat a refused first connect as a lost request", async () => {
		script({ [method]: [new Error("APP_NOT_RUNNING")], "approval.status": [status("pending", "in-progress")] });

		await expect(handleTask("move", args(["aaaaaaaa"], { status: target }), SOCKET, null)).rejects.toThrow("APP_NOT_RUNNING");
		expect(callsOf("approval.status")).toHaveLength(0);
	});

	it("treats the app going down DURING a re-attach as another loss, not a hard error", async () => {
		// Once the app confirmed the request is pending, a refused connect means it
		// went away mid-wait: keep probing, do not surface APP_NOT_RUNNING.
		script({
			[method]: [emptyResponse(), new Error("APP_NOT_RUNNING"), okResp({ approved: false })],
			"approval.status": [status("pending", "in-progress")],
		});

		await expect(handleTask("move", args(["aaaaaaaa"], { status: target }), SOCKET, null)).rejects.toThrow(declineExit);
		expect(callsOf(method)).toHaveLength(3);
		expect(callsOf(method)[2][2]).toMatchObject({ attachOnly: true });
	});

	it("stops at the original deadline when the connection keeps dropping on accept", async () => {
		vi.useFakeTimers();
		try {
			// Every attempt is accepted and then dropped, and the app keeps answering
			// "pending" — without a deadline check the re-attach loop never ends.
			mockSend.mockImplementation(async (_socket, called) => {
				if (called === "approval.status") return status("pending", "in-progress");
				vi.setSystemTime(Date.now() + 61_000);
				throw emptyResponse();
			});

			await expect(handleTask("move", args(["aaaaaaaa"], { status: target }), SOCKET, null)).rejects.toThrow("EXIT_25");
			expect(callsOf(method).length).toBeLessThanOrEqual(12);
			expect(stderrOutput).toContain("still pending");
		} finally {
			vi.useRealTimers();
		}
	});
});

// ─── task (unknown subcommand) / task list ──────────────────────────────────

describe("task subcommand dispatch", () => {
	it("exits with a usage error for an unknown or missing subcommand, and forwards `task list` to tasks.list", async () => {
		await expect(handleTask("deploy", args(), SOCKET, null)).rejects.toThrow("EXIT_3");
		expect(stderrOutput).toContain("Unknown subcommand");
		await expect(handleTask(undefined, args(), SOCKET, null)).rejects.toThrow("EXIT_3");
		mockSend.mockResolvedValue(okResp([FAKE_TASK]));
		await handleTask("list", args([], {}), SOCKET, CTX);
		expect(mockSend).toHaveBeenCalledWith(
			SOCKET,
			"tasks.list",
			expect.objectContaining({ projectId: "proj-001" }),
		);
		expect(stdoutOutput).toContain("Fix the login bug");
	});

});

// ─── agent-initiated launch approval ─────────────────────────────────────────

describe("task move — agent asking to start another task", () => {
	const OTHER = "bbbbbbbb-1111-2222-3333-444444444444";
	const BASELINE_MS = 10 * 60 * 1000 + LAUNCH_PREPARATION_REPORT_BUDGET_MS;
	const launch = () => handleTask("move", args([], { task: OTHER, status: "in-progress" }), SOCKET, CTX);

	it("tells the app which task is asking, waits the baseline, and prints the new task's seq and how to talk to it", async () => {
		mockSend.mockResolvedValue(okResp({ approved: true, seq: 77, title: "Other task", launched: [{ variantIndex: null, replyCommand: 'dev3 message --task seq:77 "your message"' }] }));

		await launch();

		// A cheap `approval.policy` read comes first so the CLI can size its own
		// timeout to the configured delay — the move itself is the second call.
		expect(mockSend.mock.calls[0]![1]).toBe("approval.policy");
		const move = moveCall(mockSend)!;
		expect(move[2]!.sourceTaskId).toBe(CTX.taskId);
		// The dialog can sit open for minutes, so this call waits far longer than
		// the default socket timeout.
		expect(move[3]).toEqual({ timeoutMs: BASELINE_MS });
		expect(stdoutOutput).toContain("seq:77");
		expect(stdoutOutput).toContain("dev3 message --task seq:77");
	});

	it("waits past a one-hour delay instead of giving up after the fixed ten minutes", async () => {
		// The bug this covers: both approval timeouts were hard-coded to 10 minutes,
		// so any configured delay longer than that killed the waiting agent before
		// the timer it was waiting on could fire.
		mockSend.mockImplementation(async (_socket: string, method: string) => {
			if (method === "approval.policy") return okResp({ autoApproveMs: 60 * 60 * 1000 });
			return okResp({ approved: true, seq: 77, title: "Other task", launched: [{ variantIndex: null, replyCommand: "x" }] });
		});

		await launch();

		// One hour plus the two-minute grace, not the ten-minute baseline.
		expect(moveCall(mockSend)![3]).toEqual({ timeoutMs: 60 * 60 * 1000 + 2 * 60 * 1000 + LAUNCH_PREPARATION_REPORT_BUDGET_MS });
	});

	it("keeps the baseline when the app cannot say what its delay is, and never shortens it for a short delay", async () => {
		for (const policy of ["throws", "short"] as const) {
			resetIO();
			mockSend.mockImplementation(async (_socket: string, method: string) => {
				if (method === "approval.policy") {
					if (policy === "throws") throw new Error("Socket timeout (5s)");
					return okResp({ autoApproveMs: 15_000 });
				}
				return okResp({ approved: true, seq: 77, title: "Other task", launched: [{ variantIndex: null, replyCommand: "x" }] });
			});
			await launch();
			expect(moveCall(mockSend)![3], policy).toEqual({ timeoutMs: BASELINE_MS });
		}
	});

	// 2026-11-01 incident: another dev3 instance deleted the launched task's
	// worktree mid-preparation, and the requester was still told it started.
	it("exits with the preparation-failed code when the approved task (or any one variant) failed to prepare", async () => {
		mockSend.mockResolvedValue(okResp({
			approved: true,
			seq: 77,
			title: "Other task",
			launched: [{ variantIndex: null, replyCommand: "x", preparation: { state: "failed", error: "Preparation interrupted by app restart" } }],
		}));

		await expect(launch()).rejects.toThrow(`EXIT_${CLI_EXIT_CODE_LAUNCH_PREPARATION_FAILED}`);
		expect(stderrOutput).toContain("failed to prepare");
		expect(stderrOutput).toContain("Preparation interrupted by app restart");
		expect(stdoutOutput).not.toContain("is starting");
		expect(stdoutOutput).not.toContain("It knows you started it");

		resetIO();
		mockSend.mockResolvedValue(okResp({
			approved: true,
			seq: 77,
			title: "Other task",
			launched: [
				{ variantIndex: 1, replyCommand: "a", preparation: { state: "started" } },
				{ variantIndex: 2, replyCommand: "b", preparation: { state: "failed", error: "setup script exited 1" } },
			],
		}));
		await expect(launch()).rejects.toThrow(`EXIT_${CLI_EXIT_CODE_LAUNCH_PREPARATION_FAILED}`);
		expect(stderrOutput).toContain("variant #2: setup script exited 1");
	});

	it("says a launch is still preparing instead of implying the agent is up", async () => {
		mockSend.mockResolvedValue(okResp({
			approved: true,
			seq: 77,
			title: "Other task",
			launched: [{ variantIndex: null, replyCommand: "x", preparation: { state: "still-preparing" } }],
		}));

		await launch();

		expect(stdoutOutput).toContain("still preparing");
		expect(stdoutOutput).toContain("dev3 task show --task seq:77");
	});

	it("exits with the launch-declined code when the user says no, and says voided when the target went away mid-dialog", async () => {
		mockSend.mockResolvedValue(okResp({ approved: false }));
		await expect(launch()).rejects.toThrow(`EXIT_${CLI_EXIT_CODE_LAUNCH_DECLINED}`);
		expect(stderrOutput).toContain("declined the launch request");

		stderrOutput = "";
		mockSend.mockResolvedValue(okResp({ approved: false, stale: true }));
		await expect(launch()).rejects.toThrow(`EXIT_${CLI_EXIT_CODE_LAUNCH_DECLINED}`);
		expect(stderrOutput).toContain("voided before anyone answered");
		expect(stderrOutput).not.toContain("User declined");
	});

	it("hands out one address per variant when the user launched a group", async () => {
		// The seq is shared by the whole group, so quoting it as THE address would
		// give the requester a handle the CLI rejects as ambiguous.
		mockSend.mockResolvedValue(okResp({
			approved: true,
			seq: 77,
			title: "Other task",
			launched: [
				{ variantIndex: 1, replyCommand: 'dev3 message --task 11111111 "your message"' },
				{ variantIndex: 2, replyCommand: 'dev3 message --task 22222222 "your message"' },
				{ variantIndex: 3, replyCommand: 'dev3 message --task 33333333 "your message"' },
			],
		}));

		await launch();

		expect(stdoutOutput).toContain("starting as 3 variants");
		expect(stdoutOutput).toContain("variant #1  dev3 message --task 11111111");
		expect(stdoutOutput).toContain("variant #3  dev3 message --task 33333333");
		// Never hand back the shared seq as an address for a live group.
		expect(stdoutOutput).not.toContain('--task seq:77 "your message"');
	});

	describe("--handoff-file", () => {
		it("sends the file's text so the launched agent gets it without a second message, and nothing without the flag", async () => {
			const path = join(tmpdir(), `dev3-handoff-${Date.now()}.md`);
			writeFileSync(path, "  Report to Seq 1141 only.\n", "utf8");
			mockSend.mockResolvedValue(okResp({ approved: true, seq: 77, title: "Other", launched: [{ variantIndex: null, replyCommand: "x" }] }));

			try {
				await handleTask("move", args([], { task: OTHER, status: "in-progress", "handoff-file": path }), SOCKET, CTX);
				expect(moveCall(mockSend)![2]!.handoffNote).toBe("Report to Seq 1141 only.");
			} finally {
				rmSync(path, { force: true });
			}

			mockSend.mockClear();
			await launch();
			expect(moveCall(mockSend)![2]!).not.toHaveProperty("handoffNote");
		});

		it("fails on the launcher's own terminal when the file cannot be read", async () => {
			await expectRefusedBeforeSending([
				{ label: "missing handoff file", sub: "move", a: args([], { task: OTHER, status: "in-progress", "handoff-file": "/nope/missing.md" }), ctx: CTX, stderr: ["cannot read"] },
			]);
		});
	});

	describe("--agent/--config (issue #1911)", () => {
		it("passes the suggested agent and preset with the launch request, and nothing without the flags", async () => {
			mockSend.mockResolvedValue(okResp({ approved: true, seq: 77, title: "Other", launched: [{ variantIndex: null, replyCommand: "x" }] }));
			const sent = async (flags: Record<string, string>) => {
				mockSend.mockClear();
				await handleTask("move", args([], { task: OTHER, status: "in-progress", ...flags }), SOCKET, CTX);
				return moveCall(mockSend)![2]!;
			};

			expect(await sent({ agent: "builtin-codex", config: "codex-low" })).toMatchObject({ agentId: "builtin-codex", configId: "codex-low" });

			const agentOnly = await sent({ agent: "builtin-codex" });
			expect(agentOnly.agentId).toBe("builtin-codex");
			expect(agentOnly).not.toHaveProperty("configId");

			// No flags: the dialog keeps the global default.
			const none = await sent({});
			expect(none).not.toHaveProperty("agentId");
			expect(none).not.toHaveProperty("configId");
		});

		it("refuses --config without --agent, and the flags on a move that is not a launch", async () => {
			await expectRefusedBeforeSending([
				{ label: "--config without --agent", sub: "move", a: args([], { task: OTHER, status: "in-progress", config: "codex-low" }), ctx: CTX, stderr: ["--config requires --agent"] },
				{ label: "own status move", sub: "move", a: args([], { status: "review-by-ai", agent: "builtin-codex" }), ctx: CTX, stderr: ["only apply when starting ANOTHER task"] },
				{ label: "completion request", sub: "move", a: args([], { task: OTHER, status: "completed", agent: "builtin-codex" }), ctx: CTX },
			]);
		});
	});

	it("keeps the agent's OWN status move on the fast path", async () => {
		mockSend.mockResolvedValue(okResp({ ...FAKE_TASK, status: "review-by-ai" as const }));

		await handleTask("move", args([], { status: "review-by-ai" }), SOCKET, CTX);

		// No approval possible for your own task: no long timeout, no source hint
		// beyond the one the app uses to recognise "this is me".
		expect(mockSend).toHaveBeenCalledWith(SOCKET, "task.move", {
			taskId: CTX.taskId,
			newStatus: "review-by-ai",
			projectId: "proj-001",
			sourceTaskId: CTX.taskId,
		});
	});

	it("names its own pane and pid, so the task it launches can reply to THIS agent", async () => {
		vi.stubEnv("TMUX_PANE", "%3");
		mockSend.mockResolvedValue(okResp({ ...FAKE_TASK, status: "in-progress" as const }));
		await launch();
		expect(moveCall(mockSend)?.[2]).toMatchObject({ sourceTaskId: CTX.taskId, sourcePaneId: "%3", sourcePid: process.pid });
	});
});

describe("task create --scratch --run", () => {
	it("refuses everything a scratch launch cannot honour before contacting the app", async () => {
		await expectRefusedBeforeSending([
			{ label: "--scratch without --run", sub: "create", a: args([], { scratch: "true", project: "proj-001" }), ctx: CTX, stderr: ["--scratch and --run go together"] },
			{ label: "a title/description", sub: "create", a: args(["do the thing"], { scratch: "true", run: "true", project: "proj-001" }), ctx: CTX, stderr: ["no title, description or type"] },
			{ label: "--type", sub: "create", a: args([], { scratch: "true", run: "true", type: "coordinator", project: "proj-001" }), ctx: CTX, stderr: ["no title, description or type"] },
			{ label: "outside a task worktree", sub: "create", a: args([], { scratch: "true", run: "true", project: "proj-001" }), stderr: ["inside a task worktree"] },
			{ label: "--agent on a plain create, which launches nothing", sub: "create", a: args([], { title: "Later", agent: "builtin-codex", project: "proj-001" }), ctx: CTX, stderr: ["--agent/--config only apply to a launch"] },
		]);
	});

	it("requests the scratch launch, reports the approved peer, and passes --agent/--config as the suggested choice", async () => {
		mockSend.mockResolvedValue(okResp({ approved: true, seq: 91, title: "Scratch — 14:32", replyCommand: 'dev3 message --task seq:91 "your message"' }));

		await handleTask("create", args([], { scratch: "true", run: "true" }), SOCKET, CTX);

		expect(mockSend).toHaveBeenCalledWith(
			SOCKET,
			"task.createScratchAndRun",
			{ projectId: "proj-001", sourceTaskId: CTX.taskId },
			{ timeoutMs: 10 * 60 * 1000 + LAUNCH_PREPARATION_REPORT_BUDGET_MS },
		);
		expect(stdoutOutput).toContain("seq:91");

		await handleTask("create", args([], { scratch: "true", run: "true", agent: "builtin-codex", config: "codex-low" }), SOCKET, CTX);
		expect(mockSend).toHaveBeenLastCalledWith(
			SOCKET,
			"task.createScratchAndRun",
			{ projectId: "proj-001", sourceTaskId: CTX.taskId, agentId: "builtin-codex", configId: "codex-low" },
			{ timeoutMs: 10 * 60 * 1000 + LAUNCH_PREPARATION_REPORT_BUDGET_MS },
		);
	});

	it("names its own pane and pid, so the scratch peer can reply to THIS agent", async () => {
		vi.stubEnv("TMUX_PANE", "");
		vi.stubEnv("DEV3_PANE_ID", "pane-2");
		vi.stubEnv("TMUX", "");
		vi.stubEnv("DEV3_TASK_ID", "");
		mockSend.mockResolvedValue(okResp({ approved: true, seq: 91, title: "Scratch — 14:32" }));
		await handleTask("create", args([], { scratch: "true", run: "true" }), SOCKET, CTX);
		const launch = mockSend.mock.calls.find(([, method]) => method === "task.createScratchAndRun");
		expect(launch?.[2]).toEqual({ projectId: "proj-001", sourceTaskId: CTX.taskId, sourcePaneId: "pane-2", sourcePid: process.pid });
	});

	it("exits with the launch-declined code when the scratch request is refused", async () => {
		mockSend.mockResolvedValue(okResp({ approved: false }));

		await expect(
			handleTask("create", args([], { scratch: "true", run: "true" }), SOCKET, CTX),
		).rejects.toThrow(`EXIT_${CLI_EXIT_CODE_LAUNCH_DECLINED}`);
	});
});

describe("task open", () => {
	it("sends task.open with the explicit id and reports focused, reopened and undelivered outcomes", async () => {
		mockSend.mockResolvedValue(okResp({ taskId: FAKE_TASK.id, projectId: "proj-001", delivered: true }));
		await handleTask("open", args(["aaaaaaaa"]), SOCKET, null);
		expect(mockSend).toHaveBeenCalledWith(SOCKET, "task.open", { taskId: "aaaaaaaa" });
		expect(stdoutOutput).toContain("Opened task aaaaaaaa in the app.");

		stdoutOutput = "";
		mockSend.mockResolvedValue(okResp({ taskId: FAKE_TASK.id, delivered: true, reopened: true }));
		await handleTask("open", args(["aaaaaaaa"]), SOCKET, null);
		expect(stdoutOutput).toContain("Opening a window on task aaaaaaaa.");

		// No renderer to navigate: nothing was opened.
		stdoutOutput = "";
		mockSend.mockResolvedValue(okResp({ taskId: FAKE_TASK.id, delivered: false }));
		await handleTask("open", args(["aaaaaaaa"]), SOCKET, null);
		expect(stdoutOutput).toContain("nothing was opened");
	});

	it("auto-detects the task and project from the worktree context, and refuses when none resolves", async () => {
		mockSend.mockResolvedValue(okResp({ taskId: FAKE_TASK.id, projectId: "proj-001", delivered: true }));
		await handleTask("open", args([]), SOCKET, CTX);
		expect(mockSend).toHaveBeenCalledWith(SOCKET, "task.open", {
			taskId: CTX.taskId,
			projectId: CTX.projectId,
		});

		await expectRefusedBeforeSending([{ label: "no task", sub: "open", a: args([]), exit: "EXIT_" }]);
	});
});

describe("epic flags", () => {
	const created = { ...FAKE_TASK, epicId: "epicpay1-0000" };

	it("task create sends --epic and --no-epic and refuses both at once", async () => {
		mockSend.mockResolvedValue(okResp(created));
		await handleTask("create", args([], { title: "New", epic: "Payments v2" }), SOCKET, CTX);
		expect(mockSend.mock.calls[0]![2]).toMatchObject({ title: "New", epic: "Payments v2", sourceTaskId: CTX.taskId });

		mockSend.mockClear();
		mockSend.mockResolvedValue(okResp(FAKE_TASK));
		await handleTask("create", args([], { title: "New", "no-epic": "true" }), SOCKET, CTX);
		expect(mockSend.mock.calls[0]![2]).toMatchObject({ noEpic: true });

		mockSend.mockClear();
		await expect(handleTask("create", args([], { title: "New", epic: "X", "no-epic": "true" }), SOCKET, CTX)).rejects.toThrow("EXIT_3");
		expect(mockSend).not.toHaveBeenCalled();
	});

	it("an unknown epic exits 43 and a refused epic create exits 44", async () => {
		mockSend.mockResolvedValue({ id: "1", ok: false, error: 'epic-ref-invalid: No epic "Paymnts".' });
		await expect(handleTask("update", args(["aaaaaaaa"], { epic: "Paymnts" }), SOCKET, null)).rejects.toThrow(`EXIT_${CLI_EXIT_CODE_EPIC_REF_INVALID}`);
		expect(stderrOutput).toContain('No epic "Paymnts".');
		expect(stderrOutput).not.toContain("epic-ref-invalid");

		mockSend.mockResolvedValue({ id: "1", ok: false, error: "epic-create-forbidden: Only the user or a coordinator task can create an epic." });
		await expect(handleEpic("create", args([], { name: "Mine" }), SOCKET, CTX)).rejects.toThrow(`EXIT_${CLI_EXIT_CODE_EPIC_CREATE_FORBIDDEN}`);
		expect(mockSend).toHaveBeenLastCalledWith(SOCKET, "epic.create", { name: "Mine", sourceTaskId: CTX.taskId });
	});

	it("task update --no-epic is an update on its own", async () => {
		mockSend.mockResolvedValue(okResp({ task: FAKE_TASK }));
		await handleTask("update", args(["aaaaaaaa"], { "no-epic": "true" }), SOCKET, null);
		expect(mockSend.mock.calls[0]![2]).toMatchObject({ noEpic: true });
	});

	it("task show prints the epic line only when the task has one", async () => {
		mockSend.mockResolvedValue(okResp(FAKE_TASK));
		await handleTask("show", args(["aaaaaaaa"]), SOCKET, null);
		expect(stdoutOutput).not.toContain("Epic:");

		stdoutOutput = "";
		mockSend.mockResolvedValue(okResp({ ...created, epic: { id: "epicpay1-0000", name: "Payments v2", color: "#3b82f6", archived: true } }));
		await handleTask("show", args(["aaaaaaaa"]), SOCKET, null);
		expect(stdoutOutput).toMatch(/Epic:\s*Payments v2 \(epicpay1\) — archived/);
	});
});

describe("--depends-on", () => {
	const open = { taskId: "bbbbbbbb", seq: 12, title: "First", status: "in-progress", state: "open" };
	const done = { taskId: "cccccccc", seq: 13, title: "Second", status: "completed", state: "done" };

	it("task create and update send the refs as a list", async () => {
		mockSend.mockResolvedValue(okResp(FAKE_TASK));
		await handleTask("create", args([], { project: "proj-001", title: "Next", "depends-on": "seq:12, seq:13" }), SOCKET, null);
		expect(mockSend).toHaveBeenCalledWith(SOCKET, "task.create", expect.objectContaining({ dependsOn: ["seq:12", "seq:13"] }));

		mockSend.mockResolvedValue(okResp({ task: FAKE_TASK }));
		await handleTask("update", args(["aaaaaaaa"], { "depends-on": "seq:12", "no-depends-on": "seq:13" }), SOCKET, null);
		expect(mockSend).toHaveBeenLastCalledWith(SOCKET, "task.update", { taskId: "aaaaaaaa", dependsOn: ["seq:12"], noDependsOn: ["seq:13"] });
	});

	it("a bare --no-depends-on removes every dependency, and a bare --depends-on is a usage error", async () => {
		mockSend.mockResolvedValue(okResp({ task: FAKE_TASK }));
		await handleTask("update", args(["aaaaaaaa"], { "no-depends-on": "true" }), SOCKET, null);
		expect(mockSend).toHaveBeenCalledWith(SOCKET, "task.update", { taskId: "aaaaaaaa", noDependsOn: true });
		expect(stderrOutput).toContain("Dependencies: none.");
		await expect(handleTask("update", args(["aaaaaaaa"], { "depends-on": "true" }), SOCKET, null)).rejects.toThrow("EXIT_3");
		await expect(handleTask("create", args([], { project: "proj-001", title: "Next", "no-depends-on": "seq:1" }), SOCKET, null)).rejects.toThrow("EXIT_3");
	});

	it("task show lists what the task depends on and what it blocks, naming a cancelled dependency as cancelled", async () => {
		mockSend.mockResolvedValue(okResp({ ...FAKE_TASK, dependencyInfo: { verdict: "blocked", dependsOn: [open, done], blocks: [{ taskId: "dddddddd", seq: 20, title: "Later", status: "todo" }] } }));
		await handleTask("show", args(["aaaaaaaa"]), SOCKET, null);
		expect(stdoutOutput).toMatch(/Depends on:\s*#12 \(Agent is Working\), #13 \(Completed\) - blocked by #12/);
		expect(stdoutOutput).toMatch(/Blocks:\s*#20 \(To Do\)/);

		stdoutOutput = "";
		mockSend.mockResolvedValue(okResp({ ...FAKE_TASK, dependencyInfo: { verdict: "ready", dependsOn: [done], blocks: [] } }));
		await handleTask("show", args(["aaaaaaaa"], { json: "true" }), SOCKET, null);
		expect(JSON.parse(stdoutOutput).dependencies).toEqual({
			state: "ready",
			dependsOn: [{ taskId: "cccccccc", seq: 13, title: "Second", status: "completed", open: false, state: "done" }],
			blocks: [],
		});

		stdoutOutput = "";
		const cancelled = { taskId: "eeeeeeee", seq: 14, title: "Dropped", status: "cancelled", state: "cancelled" };
		mockSend.mockResolvedValue(okResp({ ...FAKE_TASK, dependencyInfo: { verdict: "ready", dependsOn: [done, cancelled], blocks: [] } }));
		await handleTask("show", args(["aaaaaaaa"]), SOCKET, null);
		expect(stdoutOutput).toMatch(/Depends on:\s*#13 \(Completed\), #14 \(Cancelled\) - ready, but #14 was cancelled/);
	});

	it("warns that start-after starts the task even while its other dependencies are open", async () => {
		const launchAfter = { taskId: "bbbbbbbb", seq: 12, until: "completed", armedAt: "2026-11-15T10:00:00Z" };
		const relations = [{ type: "blocked-by", taskId: "cccccccc" }, { type: "blocked-by", taskId: "bbbbbbbb" }];
		mockSend.mockResolvedValue(okResp({ task: { ...FAKE_TASK, seq: 44, status: "todo", launchAfter, relations } }));
		await handleTask("update", args(["aaaaaaaa"], { "depends-on": "seq:13" }), SOCKET, null);
		expect(stderrOutput).toContain("Dependencies: 2.");
		expect(stderrOutput).toContain("Warning: #44 starts by itself after #12 even if its other dependency is still open.");

		stderrOutput = "";
		mockSend.mockResolvedValue(okResp({ task: { ...FAKE_TASK, seq: 44, status: "todo", launchAfter, relations: [relations[1]] } }));
		await handleTask("update", args(["aaaaaaaa"], { "start-after": "seq:12" }), SOCKET, null);
		expect(stderrOutput).not.toContain("Warning:");
	});

	it("task move warns, and still moves, when the started task has open dependencies", async () => {
		mockSend.mockResolvedValue(okResp({ ...FAKE_TASK, seq: 44, status: "in-progress", startedBlockedBy: [open] }));
		await handleTask("move", args(["aaaaaaaa"], { status: "in-progress" }), SOCKET, null);
		expect(stderrOutput).toContain("Warning: #44 was started while it still depends on #12 (Agent is Working).");
		expect(stdoutOutput).toContain("Moved task");
	});
});

describe("--start-after", () => {
	const waiting: Task = {
		...FAKE_TASK,
		status: "todo",
		seq: 44,
		launchAfter: { taskId: "bbbbbbbb", seq: 12, until: "merged", armedAt: "2026-11-04T10:00:00Z" },
	};

	it("task create sends the prerequisite, --until and a launch agent, and says what it waits for", async () => {
		mockSend.mockResolvedValue(okResp(waiting));
		await handleTask("create", args([], { project: "proj-001", title: "Next", "start-after": "seq:12", until: "merged", agent: "claude" }), SOCKET, null);
		expect(mockSend).toHaveBeenCalledWith(SOCKET, "task.create", expect.objectContaining({
			startAfter: "seq:12",
			until: "merged",
			agentId: "claude",
			configId: null,
		}));
		expect(stderrOutput).toContain("Starts after: #12, when its PR merges");
	});

	it("rejects --until without --start-after, an unknown --until, and --start-after with --no-start-after", async () => {
		await expectRefusedBeforeSending([
			{ label: "--until alone", sub: "create", a: args([], { project: "proj-001", title: "Next", until: "merged" }) },
			{ label: "unknown --until", sub: "create", a: args([], { project: "proj-001", title: "Next", "start-after": "seq:12", until: "done" }) },
			{ label: "--start-after with --no-start-after", sub: "update", a: args(["aaaaaaaa"], { "start-after": "seq:12", "no-start-after": "true" }) },
		]);
	});

	it("task update arms it from inside a task, and sends the asking task with a new title or description", async () => {
		mockSend.mockResolvedValue(okResp({ task: waiting, titlePreserved: false }));
		await handleTask("update", args([], { task: "seq:44", "start-after": "seq:12", until: "merged" }), SOCKET, CTX);
		expect(mockSend).toHaveBeenCalledWith(SOCKET, "task.update", expect.objectContaining({
			taskId: "seq:44",
			startAfter: "seq:12",
			until: "merged",
			sourceTaskId: CTX.taskId,
		}));
		mockSend.mockResolvedValue(okResp({ task: waiting, titlePreserved: false }));
		await handleTask("update", args([], { task: "seq:44", project: "proj-002", description: "see seq:60" }), SOCKET, CTX);
		expect(mockSend).toHaveBeenLastCalledWith(SOCKET, "task.update", expect.objectContaining({ description: "see seq:60", sourceTaskId: CTX.taskId }));
		await handleTask("update", args([], { task: "seq:44", priority: "P2" }), SOCKET, CTX);
		expect(mockSend.mock.calls[mockSend.mock.calls.length - 1]![2]).not.toHaveProperty("sourceTaskId");
	});

	it("task update --no-start-after is a standalone update, and task show prints the condition", async () => {
		mockSend.mockResolvedValue(okResp({ task: { ...waiting, launchAfter: null }, titlePreserved: false }));
		await handleTask("update", args(["aaaaaaaa"], { "no-start-after": "true" }), SOCKET, null);
		expect(mockSend).toHaveBeenCalledWith(SOCKET, "task.update", { taskId: "aaaaaaaa", noStartAfter: true });
		expect(stderrOutput).toContain("Start-after cleared");
		mockSend.mockResolvedValue(okResp(waiting));
		await handleTask("show", args(["aaaaaaaa"]), SOCKET, null);
		expect(stdoutOutput).toMatch(/Starts after:\s+#12, when its PR merges/);
	});

});
