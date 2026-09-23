import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import type { CliRequest, Project, Task } from "../../shared/types";

// End-to-end for Codex per-pane session capture (decision 125): a real
// `task.agentHook` request (as sent by `dev3 hook codex`) flows through the real
// socket dispatch → capturePaneSession → real data.updateTaskWith → on-disk
// tasks.json. We then feed the persisted id to the real resume-command builder to
// confirm it produces a targeted `codex resume <id>`. Only electrobun-coupled deps
// are mocked; `data` and `agents` are real.

const tempHome = mkdtempSync(join(tmpdir(), "dev3-codex-capture-"));
const dev3Home = join(tempHome, ".dev3.0");
const originalHome = process.env.HOME;

const PROJECT_PATH = "/tmp/codex-capture-project";
const PROJECT_SLUG = "tmp-codex-capture-project";

vi.mock("../rpc-handlers", () => ({
	isActive: vi.fn(() => true),
	activateTask: vi.fn(),
	getPushMessage: vi.fn(() => null),
	getPushMessageLocal: vi.fn(() => null),
	moveTask: vi.fn(),
	triggerColumnAgentIfNeeded: vi.fn(),
	notifyWatchedTaskStatusChange: vi.fn(),
}));

vi.mock("../rpc-handlers/tmux-pty", () => ({
	getDevServerStatus: vi.fn(),
	runDevServer: vi.fn(),
	stopDevServer: vi.fn(),
	restartDevServer: vi.fn(),
}));

vi.mock("../logger", () => ({
	createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

type Pane = NonNullable<Task["sessionState"]>["panes"][number];
const codexPane = (paneId: string | null, sessionId: string | null): Pane =>
	({ paneId, agentCmd: "codex", sessionId, agentId: null, configId: null });

function makeTask(overrides?: Partial<Task>): Task {
	return {
		id: "task-1",
		seq: 1,
		projectId: "proj-1",
		title: "Codex capture task",
		description: "Codex capture task",
		status: "in-progress",
		baseBranch: "main",
		worktreePath: "/tmp/wt",
		branchName: null,
		groupId: null,
		variantIndex: null,
		agentId: null,
		configId: null,
		createdAt: "2026-07-11T00:00:00.000Z",
		updatedAt: "2026-07-11T00:00:00.000Z",
		notes: [],
		...overrides,
	};
}

function seed(tasks: Task[]): Project {
	const project: Project = {
		id: "proj-1",
		name: "Codex Capture Project",
		path: PROJECT_PATH,
		setupScript: "",
		devScript: "",
		cleanupScript: "",
		defaultBaseBranch: "main",
		createdAt: "2026-07-11T00:00:00.000Z",
		labels: [],
	};
	writeFileSync(join(dev3Home, "projects.json"), JSON.stringify([project], null, 2));
	// Past the one-time agents layout resync, as on any installed machine.
	writeFileSync(join(dev3Home, "settings.json"), JSON.stringify({ agentsLayoutRevision: 1_000 }));
	mkdirSync(join(dev3Home, "data", PROJECT_SLUG), { recursive: true });
	writeFileSync(join(dev3Home, "data", PROJECT_SLUG, "tasks.json"), JSON.stringify(tasks, null, 2));
	return project;
}

function readPanes(): Pane[] {
	const tasks = JSON.parse(readFileSync(join(dev3Home, "data", PROJECT_SLUG, "tasks.json"), "utf8")) as Task[];
	return tasks[0]?.sessionState?.panes ?? [];
}

function agentHook(params: Record<string, unknown>): CliRequest {
	return { id: "req-1", method: "task.agentHook", params };
}

describe("cli-socket — Codex per-pane session capture (e2e, real data)", () => {
	beforeEach(() => {
		vi.resetModules();
		process.env.HOME = tempHome;
		rmSync(tempHome, { recursive: true, force: true });
		mkdirSync(dev3Home, { recursive: true });
	});

	afterAll(() => {
		process.env.HOME = originalHome;
		rmSync(tempHome, { recursive: true, force: true });
	});

	it("persists the hook's session_id onto the pane matching $TMUX_PANE, and resume targets it", async () => {
		await import("../data");
		const { handleRequest } = await import("../cli-socket-server");
		const { buildResumeCommand } = await import("../agents");

		seed([makeTask({
			sessionState: { panes: [codexPane("%1", null), { ...codexPane("%2", null), accountId: "account-b" }] },
		})]);

		const resp = await handleRequest(agentHook({
			projectId: "proj-1",
			taskId: "task-1",
			event: "SessionStart",
			sessionId: "019f50b3-6415-7dc3-8ad5-b60f0818f704",
			paneId: "%2",
		}));
		expect(resp.ok).toBe(true);

		const panes = readPanes();
		expect(panes[0]?.sessionId).toBeNull();
		expect(panes[1]?.sessionId).toBe("019f50b3-6415-7dc3-8ad5-b60f0818f704");
		expect(panes[1]?.accountId).toBe("account-b");

		// The persisted id drives a targeted resume, exactly as resumeTask does.
		expect(buildResumeCommand("codex", panes[1]!.sessionId ?? undefined))
			.toBe("codex resume 019f50b3-6415-7dc3-8ad5-b60f0818f704");
	});

	it("adopts the lone null-paneId (main) pane when no stored paneId matches", async () => {
		await import("../data");
		const { handleRequest } = await import("../cli-socket-server");

		seed([makeTask({ sessionState: { panes: [codexPane(null, null)] } })]);

		await handleRequest(agentHook({
			projectId: "proj-1",
			taskId: "task-1",
			event: "UserPromptSubmit",
			sessionId: "codex-main-sess",
			paneId: "%7",
		}));

		const [main] = readPanes();
		expect(main?.paneId).toBe("%7");
		expect(main?.sessionId).toBe("codex-main-sess");
	});

	it("repeating the same hook never rewrites tasks.json", async () => {
		await import("../data");
		const { handleRequest } = await import("../cli-socket-server");

		seed([makeTask({ sessionState: { panes: [codexPane("%2", null)] } })]);
		const tasksFile = join(dev3Home, "data", PROJECT_SLUG, "tasks.json");
		const hook = agentHook({
			projectId: "proj-1",
			taskId: "task-1",
			event: "UserPromptSubmit",
			sessionId: "steady-state-sess",
			paneId: "%2",
		});

		await handleRequest(hook);
		expect(readPanes()[0]?.sessionId).toBe("steady-state-sess");
		// Atomic saves go through rename, so every write lands a NEW inode.
		const inodeAfterCapture = statSync(tasksFile).ino;

		// Codex fires this hook for the entire life of the session; each repeat used
		// to cost a full parse+serialize+write of the whole board.
		for (let i = 0; i < 5; i++) await handleRequest(hook);

		expect(statSync(tasksFile).ino).toBe(inodeAfterCapture);
		expect(readPanes()[0]?.sessionId).toBe("steady-state-sess");
	});

	it("captures an omp session the same way, and resume targets it with --resume", async () => {
		await import("../data");
		const { handleRequest } = await import("../cli-socket-server");
		const { buildResumeCommand } = await import("../agents");

		seed([makeTask({
			sessionState: { panes: [{ ...codexPane("%3", null), agentCmd: "omp" }] },
		})]);

		const resp = await handleRequest(agentHook({
			projectId: "proj-1",
			taskId: "task-1",
			harness: "omp",
			event: "SessionStart",
			sessionId: "01a0a1da-8ddd-77c7-b725-058fe11b33ba",
			paneId: "%3",
		}));
		expect(resp.ok).toBe(true);

		const [pane] = readPanes();
		expect(pane?.sessionId).toBe("01a0a1da-8ddd-77c7-b725-058fe11b33ba");
		expect(buildResumeCommand("omp", pane!.sessionId ?? undefined))
			.toBe("omp --resume 01a0a1da-8ddd-77c7-b725-058fe11b33ba");
	});

	it("is a no-op without a paneId (falls back to resume-last at recovery)", async () => {
		await import("../data");
		const { handleRequest } = await import("../cli-socket-server");
		const { buildResumeCommand } = await import("../agents");

		seed([makeTask({ sessionState: { panes: [codexPane("%1", null)] } })]);

		await handleRequest(agentHook({
			projectId: "proj-1",
			taskId: "task-1",
			event: "SessionStart",
			sessionId: "orphan-no-pane",
		}));

		expect(readPanes()[0]?.sessionId).toBeNull();
		// With no captured id, recovery uses resume-last.
		expect(buildResumeCommand("codex", undefined)).toBe("codex resume --last");
	});
	it("follows a conversation resumed in a pane nobody recorded instead of leaving it on the dead one", async () => {
		await import("../data");
		const { handleRequest } = await import("../cli-socket-server");

		// Seq 1801, 2026-09-14: the entry still named the failed pane %5 while the
		// same conversation ran on in %6 — every hook from %6 used to be ignored.
		seed([makeTask({ sessionState: { panes: [{ ...codexPane("%5", "conv-x"), accountId: "account-b" }] } })]);

		await handleRequest(agentHook({ projectId: "proj-1", taskId: "task-1", event: "UserPromptSubmit", sessionId: "conv-x", paneId: "%6" }));

		expect(readPanes()).toEqual([expect.objectContaining({ paneId: "%6", sessionId: "conv-x", accountId: "account-b" })]);
	});

	it("recreates the main entry for the task's own agent after reconciliation removed every entry", async () => {
		await import("../data");
		const { handleRequest } = await import("../cli-socket-server");
		const { buildResumeCommand } = await import("../agents");

		seed([makeTask({ agentId: "builtin-codex", configId: "codex-default", sessionState: { panes: [] } })]);

		await handleRequest(agentHook({ projectId: "proj-1", taskId: "task-1", event: "UserPromptSubmit", sessionId: "01a09480-c8fc-7021-b4d1-73d850b67083", paneId: "%6" }));

		const panes = readPanes();
		expect(panes).toHaveLength(1);
		expect(panes[0]).toMatchObject({ paneId: "%6", sessionId: "01a09480-c8fc-7021-b4d1-73d850b67083", agentId: "builtin-codex", configId: "codex-default", agentCmd: "codex" });
		// No account is guessed: resume finds the store that holds the conversation.
		expect(panes[0]?.accountId).toBeUndefined();
		expect(buildResumeCommand(panes[0]!.agentCmd, panes[0]!.sessionId ?? undefined)).toBe("codex resume 01a09480-c8fc-7021-b4d1-73d850b67083");
	});

	it.each([
		["another agent's task", { agentId: "builtin-claude", configId: null }],
		["a task without an agent", { agentId: null, configId: null }],
	])("does not invent a main entry on %s", async (_label, agent) => {
		await import("../data");
		const { handleRequest } = await import("../cli-socket-server");

		seed([makeTask({ ...agent, sessionState: { panes: [] } })]);
		await handleRequest(agentHook({ projectId: "proj-1", taskId: "task-1", event: "UserPromptSubmit", sessionId: "conv-x", paneId: "%6" }));

		expect(readPanes()).toEqual([]);
	});

	it("skips an unknown pane when the stored entries leave it ambiguous", async () => {
		await import("../data");
		const { handleRequest } = await import("../cli-socket-server");

		const panes = [codexPane("%1", "conv-a"), codexPane("%2", "conv-b")];
		seed([makeTask({ agentId: "builtin-codex", sessionState: { panes } })]);
		await handleRequest(agentHook({ projectId: "proj-1", taskId: "task-1", event: "UserPromptSubmit", sessionId: "conv-new", paneId: "%9" }));

		expect(readPanes()).toEqual(panes);
	});
});
