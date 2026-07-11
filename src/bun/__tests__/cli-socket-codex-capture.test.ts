import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { CliRequest, Project, Task } from "../../shared/types";

// End-to-end for Codex per-pane session capture (decision 125): a real
// `task.agentHook` request (as sent by `dev3 hook codex`) flows through the real
// socket dispatch → captureCodexPaneSession → real data.updateTaskWith → on-disk
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
			sessionState: { panes: [codexPane("%1", null), codexPane("%2", null)] },
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
});
