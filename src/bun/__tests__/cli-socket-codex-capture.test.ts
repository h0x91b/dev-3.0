import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import type { CliRequest, Project, Task } from "../../shared/types";
import { guardFsPromises, type FsRootGuard } from "./helpers/fs-root-guard";

// Real store discovery runs here: any path outside the fixture fails the test.
const fsGuard = vi.hoisted((): FsRootGuard => ({ roots: null, violations: [] }));
vi.mock("node:fs/promises", async (actual) => guardFsPromises(await actual<Record<string, unknown>>(), fsGuard));

// End-to-end for Codex per-pane session capture (decision 125): a real
// `task.agentHook` request (as sent by `dev3 hook codex`) flows through the real
// socket dispatch → capturePaneSession → real data.updateTaskWith → on-disk
// tasks.json. We then feed the persisted id to the real resume-command builder to
// confirm it produces a targeted `codex resume <id>`. Only electrobun-coupled deps
// are mocked; `data` and `agents` are real.

const tempHome = mkdtempSync(join(tmpdir(), "dev3-codex-capture-"));
const dev3Home = join(tempHome, ".dev3.0");
const originalHome = process.env.HOME;
const originalCodexHome = process.env.CODEX_HOME;

const PROJECT_PATH = "/tmp/codex-capture-project";
const PROJECT_SLUG = "tmp-codex-capture-project";

vi.mock("../task-workspace-guard", async (importOriginal) => ({
	...(await importOriginal<typeof import("../task-workspace-guard")>()),
	// Fixture worktree paths do not exist on disk; the guard has its own tests.
	assertTaskWorkspacePresent: (_project: unknown, path: string | null | undefined) => path ?? "",
	worktreeAccessState: () => "present",
}));
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

/** The rollout Codex writes for a session; the capture guard reads its header. */
function rollout(sessionId: string, payload: Record<string, unknown> = {}): void {
	const dir = join(tempHome, ".codex", "sessions", "2026", "09", "28");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, `rollout-2026-09-28T08-00-00-${sessionId}.jsonl`), `${JSON.stringify({ type: "session_meta", payload: { id: sessionId, cwd: "/tmp/wt", source: "cli", ...payload } })}\n`);
}

const MAIN = "01a09480-c8fc-7021-b4d1-73d850b67001";
const STEADY = "01a09480-c8fc-7021-b4d1-73d850b67002";
const CONV_X = "01a09480-c8fc-7021-b4d1-73d850b67003";

function agentHook(params: Record<string, unknown>): CliRequest {
	return { id: "req-1", method: "task.agentHook", params };
}

describe("cli-socket — Codex per-pane session capture (e2e, real data)", () => {
	beforeEach(() => {
		vi.resetModules();
		process.env.HOME = tempHome;
		// A developer shell may point CODEX_HOME at a real account store; never scan it.
		delete process.env.CODEX_HOME;
		rmSync(tempHome, { recursive: true, force: true });
		mkdirSync(dev3Home, { recursive: true });
		fsGuard.violations = [];
		fsGuard.roots = [tempHome, realpathSync(tempHome), PROJECT_PATH, "/tmp/wt"];
	});

	afterEach(() => {
		fsGuard.roots = null;
		expect(fsGuard.violations).toEqual([]);
	});

	afterAll(() => {
		process.env.HOME = originalHome;
		if (originalCodexHome !== undefined) process.env.CODEX_HOME = originalCodexHome;
		rmSync(tempHome, { recursive: true, force: true });
	});

	it("persists the hook's session_id onto the pane matching $TMUX_PANE, and resume targets it", async () => {
		await import("../data");
		const { handleRequest } = await import("../cli-socket-server");
		const { buildResumeCommand } = await import("../agents");

		seed([makeTask({
			sessionState: { panes: [codexPane("%1", null), { ...codexPane("%2", null), accountId: "account-b" }] },
		})]);
		rollout("019f50b3-6415-7dc3-8ad5-b60f0818f704");

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
		rollout(MAIN);

		await handleRequest(agentHook({
			projectId: "proj-1",
			taskId: "task-1",
			event: "UserPromptSubmit",
			sessionId: MAIN,
			paneId: "%7",
		}));

		const [main] = readPanes();
		expect(main?.paneId).toBe("%7");
		expect(main?.sessionId).toBe(MAIN);
	});

	it("repeating the same hook never rewrites tasks.json", async () => {
		await import("../data");
		const { handleRequest } = await import("../cli-socket-server");

		seed([makeTask({ sessionState: { panes: [codexPane("%2", null)] } })]);
		rollout(STEADY);
		const tasksFile = join(dev3Home, "data", PROJECT_SLUG, "tasks.json");
		const hook = agentHook({
			projectId: "proj-1",
			taskId: "task-1",
			event: "UserPromptSubmit",
			sessionId: STEADY,
			paneId: "%2",
		});

		await handleRequest(hook);
		expect(readPanes()[0]?.sessionId).toBe(STEADY);
		// Atomic saves go through rename, so every write lands a NEW inode.
		const inodeAfterCapture = statSync(tasksFile).ino;

		// Codex fires this hook for the entire life of the session; each repeat used
		// to cost a full parse+serialize+write of the whole board.
		for (let i = 0; i < 5; i++) await handleRequest(hook);

		expect(statSync(tasksFile).ino).toBe(inodeAfterCapture);
		expect(readPanes()[0]?.sessionId).toBe(STEADY);
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

	it("places a Codex id without a paneId on a task's only pane (native session without a pane suffix)", async () => {
		await import("../data");
		const { handleRequest } = await import("../cli-socket-server");

		seed([makeTask({ sessionState: { panes: [codexPane(null, null)] } })]);
		rollout(MAIN);
		await handleRequest(agentHook({ projectId: "proj-1", taskId: "task-1", event: "UserPromptSubmit", sessionId: MAIN }));

		expect(readPanes()).toEqual([expect.objectContaining({ paneId: null, sessionId: MAIN })]);
	});

	it("leaves a paneId-less hook alone when the task has several panes", async () => {
		await import("../data");
		const { handleRequest } = await import("../cli-socket-server");
		const { buildResumeCommand } = await import("../agents");

		seed([makeTask({ sessionState: { panes: [codexPane("%1", null), codexPane("%2", null)] } })]);
		rollout(MAIN);
		await handleRequest(agentHook({ projectId: "proj-1", taskId: "task-1", event: "SessionStart", sessionId: MAIN }));

		expect(readPanes().map((pane) => pane.sessionId)).toEqual([null, null]);
		// Nothing captured means nothing to resume by id — never `--last` (#1847).
		expect(buildResumeCommand("codex", undefined)).toBeNull();
	});

	it("keeps Copilot's rule: without a paneId nothing is placed", async () => {
		await import("../data");
		const { handleRequest } = await import("../cli-socket-server");

		seed([makeTask({ sessionState: { panes: [{ ...codexPane(null, null), agentCmd: "copilot" }] } })]);
		await handleRequest(agentHook({ projectId: "proj-1", taskId: "task-1", harness: "copilot", event: "UserPromptSubmit", sessionId: MAIN }));

		expect(readPanes()[0]?.sessionId).toBeNull();
	});

	it.each([
		["a subagent thread", { thread_source: "subagent" }],
		["a codex exec run", { source: "exec" }],
	])("never records %s as the pane's conversation", async (_label, payload) => {
		await import("../data");
		const { handleRequest } = await import("../cli-socket-server");

		seed([makeTask({ sessionState: { panes: [codexPane("%1", null)] } })]);
		rollout(MAIN, payload);
		await handleRequest(agentHook({ projectId: "proj-1", taskId: "task-1", event: "SessionStart", sessionId: MAIN, paneId: "%1" }));

		expect(readPanes()[0]?.sessionId).toBeNull();
	});

	it("skips an id whose rollout is not written yet, and binds it on a later hook", async () => {
		await import("../data");
		const { handleRequest } = await import("../cli-socket-server");

		seed([makeTask({ sessionState: { panes: [codexPane("%1", null)] } })]);
		const hook = agentHook({ projectId: "proj-1", taskId: "task-1", event: "SessionStart", sessionId: MAIN, paneId: "%1" });
		await handleRequest(hook);
		expect(readPanes()[0]?.sessionId).toBeNull();

		rollout(MAIN);
		await handleRequest({ ...hook, params: { ...hook.params, event: "UserPromptSubmit" } });
		expect(readPanes()[0]?.sessionId).toBe(MAIN);
	});

	it("follows a conversation resumed in a pane nobody recorded instead of leaving it on the dead one", async () => {
		await import("../data");
		const { handleRequest } = await import("../cli-socket-server");

		// Seq 1801, 2026-09-14: the entry still named the failed pane %5 while the
		// same conversation ran on in %6 — every hook from %6 used to be ignored.
		seed([makeTask({ sessionState: { panes: [{ ...codexPane("%5", CONV_X), accountId: "account-b" }] } })]);
		rollout(CONV_X);

		await handleRequest(agentHook({ projectId: "proj-1", taskId: "task-1", event: "UserPromptSubmit", sessionId: CONV_X, paneId: "%6" }));

		expect(readPanes()).toEqual([expect.objectContaining({ paneId: "%6", sessionId: CONV_X, accountId: "account-b" })]);
	});

	it("recreates the main entry for the task's own agent after reconciliation removed every entry", async () => {
		await import("../data");
		const { handleRequest } = await import("../cli-socket-server");
		const { buildResumeCommand } = await import("../agents");

		seed([makeTask({ agentId: "builtin-codex", configId: "codex-default", sessionState: { panes: [] } })]);
		rollout("01a09480-c8fc-7021-b4d1-73d850b67083");

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
		rollout(CONV_X);
		await handleRequest(agentHook({ projectId: "proj-1", taskId: "task-1", event: "UserPromptSubmit", sessionId: CONV_X, paneId: "%6" }));

		expect(readPanes()).toEqual([]);
	});

	it("skips an unknown pane when the stored entries leave it ambiguous", async () => {
		await import("../data");
		const { handleRequest } = await import("../cli-socket-server");

		const panes = [codexPane("%1", "conv-a"), codexPane("%2", "conv-b")];
		seed([makeTask({ agentId: "builtin-codex", sessionState: { panes } })]);
		rollout(CONV_X);
		await handleRequest(agentHook({ projectId: "proj-1", taskId: "task-1", event: "UserPromptSubmit", sessionId: CONV_X, paneId: "%9" }));

		expect(readPanes()).toEqual(panes);
	});
});
