import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import type { CliRequest, Project, Task } from "../../shared/types";
import { guardFsPromises, type FsRootGuard } from "./helpers/fs-root-guard";

// Real store discovery runs here: any path outside the fixture fails the test.
const fsGuard = vi.hoisted((): FsRootGuard => ({ roots: null, violations: [] }));
vi.mock("node:fs/promises", async (actual) => guardFsPromises(await actual<Record<string, unknown>>(), fsGuard));

// End-to-end for Claude per-pane session capture (#1950): a real
// `task.promptSubmitted` request (as sent by `dev3 hook claude-prompt`) flows
// through the real socket dispatch → capturePaneSession → on-disk tasks.json.
// Claude starts a new conversation on `/clear` and switches on `/resume`, and the
// pane's resume pointer has to follow. Only electrobun-coupled deps are mocked.

const tempHome = mkdtempSync(join(tmpdir(), "dev3-claude-capture-"));
const dev3Home = join(tempHome, ".dev3.0");
const originalHome = process.env.HOME;
const originalCodexHome = process.env.CODEX_HOME;

const PROJECT_PATH = "/tmp/claude-capture-project";
const PROJECT_SLUG = "tmp-claude-capture-project";

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
const claudePane = (paneId: string | null, sessionId: string | null): Pane =>
	({ paneId, agentCmd: "claude", sessionId, agentId: null, configId: null });

function makeTask(overrides?: Partial<Task>): Task {
	return {
		id: "task-1",
		seq: 1,
		projectId: "proj-1",
		title: "Claude capture task",
		description: "Claude capture task",
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
		name: "Claude Capture Project",
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

const LAUNCH_A = "00000000-0000-4000-8000-0000c1a0de01";
const LAUNCH_B = "00000000-0000-4000-8000-0000c1a0de02";
const AFTER_CLEAR = "00000000-0000-4000-8000-0000c1a0de03";

function promptSubmitted(params: Record<string, unknown>): CliRequest {
	return {
		id: "req-1",
		method: "task.promptSubmitted",
		params: { projectId: "proj-1", taskId: "task-1", harness: "claude", prompt: "keep going", ...params },
	};
}

describe("cli-socket — Claude per-pane session capture (e2e, real data)", () => {
	beforeEach(() => {
		vi.resetModules();
		process.env.HOME = tempHome;
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

	it("moves only the reporting pane onto its new conversation after /clear", async () => {
		const { handleRequest } = await import("../cli-socket-server");
		seed([makeTask({ sessionState: { panes: [claudePane("%1", LAUNCH_A), claudePane("%2", LAUNCH_B)] } })]);

		const resp = await handleRequest(promptSubmitted({ sessionId: AFTER_CLEAR, paneId: "%2" }));

		expect(resp.ok).toBe(true);
		expect(readPanes().map((p) => p.sessionId)).toEqual([LAUNCH_A, AFTER_CLEAR]);
	});

	it("ignores a pane dev3 never recorded, such as an agent-team teammate", async () => {
		// Adopting the unknown pane would hand a teammate's conversation to a
		// recorded pane; Claude's ids come from launch, so nothing is lost by waiting.
		const { handleRequest } = await import("../cli-socket-server");
		seed([makeTask({ sessionState: { panes: [claudePane("%1", LAUNCH_A), claudePane(null, LAUNCH_B)] } })]);

		await handleRequest(promptSubmitted({ sessionId: AFTER_CLEAR, paneId: "%9" }));

		expect(readPanes().map((p) => [p.paneId, p.sessionId])).toEqual([["%1", LAUNCH_A], [null, LAUNCH_B]]);
	});

	it("leaves the panes alone when the hook names no pane", async () => {
		const { handleRequest } = await import("../cli-socket-server");
		seed([makeTask({ sessionState: { panes: [claudePane("%1", LAUNCH_A)] } })]);

		await handleRequest(promptSubmitted({ sessionId: AFTER_CLEAR }));

		expect(readPanes()[0]?.sessionId).toBe(LAUNCH_A);
	});
});
