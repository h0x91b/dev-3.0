import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Real repo-config against real files; everything that would spawn or launch is stubbed.
vi.mock("../../logger", () => ({
	createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock("../../cow-clone", () => ({ clonePaths: vi.fn(async () => undefined) }));
vi.mock("../../data", () => ({}));
vi.mock("../../git", () => ({
	detectDefaultCompareRef: vi.fn(async () => "origin/main"),
	projectSlug: (p: string) => p.replace(/^\//, "").replaceAll("/", "-"),
}));
vi.mock("../../paths", () => ({ DEV3_HOME: "/home/.dev3.0", OPS_DIR: "/home/.dev3.0/ops" }));
vi.mock("../../port-pool", () => ({}));
vi.mock("../../preparation-runtime", () => ({}));
vi.mock("../../agent-graceful-exit", () => ({}));
vi.mock("../../pty-server", () => ({}));
vi.mock("../../settings", () => ({ loadSettings: vi.fn(async () => ({})), loadSettingsSync: vi.fn(() => ({})) }));
vi.mock("../../shell-env", () => ({ getUserShell: vi.fn(() => "/bin/zsh") }));
vi.mock("../../spawn", () => ({ spawn: vi.fn() }));
vi.mock("../../temp-paths", () => ({ dev3TaskTempPath: vi.fn(() => "/tmp/dev3/task") }));
vi.mock("../../tmux", () => ({ DEFAULT_TMUX_SOCKET: "dev3", activeTmuxConfigPath: vi.fn(), cleanupSessionName: vi.fn(), tmux: {} }));
vi.mock("../../rpc-handlers/tmux-pty", () => ({
	cleanupTaskTmuxState: vi.fn(),
	killDevServerSession: vi.fn(),
	launchColumnAgent: vi.fn(async () => undefined),
	launchTaskPty: vi.fn(),
}));
vi.mock("../../rpc-handlers/settings-config", async () => ({
	resolveOperationalProjectConfig: (await vi.importActual<typeof import("../../repo-config")>("../../repo-config")).resolveOperationalProjectConfig,
}));
vi.mock("../../rpc-handlers/shared", () => ({
	buildScriptRunnerCommand: vi.fn(),
	buildTaskLifecycleEnv: vi.fn(() => ({})),
	getPushMessage: vi.fn(() => null),
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
	notifyWatchedTaskEvent: vi.fn(),
	notifyWatchedTaskStatusChange: vi.fn(),
	pushCliAttention: vi.fn(),
}));
vi.mock("../../worktree-trust", () => ({ forgetWorktreeTrust: vi.fn() }));
vi.mock("../../board-operations/task-notes", () => ({ addNote: vi.fn() }));
vi.mock("../../board-operations/runtime", () => ({ boardPorts: {} }));
vi.mock("../../agent-requests", () => ({ voidAgentRequest: vi.fn() }));
vi.mock("../../board-operations/types", () => ({ AGENT_ACTOR: { kind: "agent" } }));

import { launchColumnAgent } from "../../rpc-handlers/tmux-pty";
import { saveConfigToWinningLayer } from "../../repo-config";
import { launchLifecycleColumnAgent } from "../executor";
import type { ColumnAgentConfig, Project, Task } from "../../../shared/types";

const A: ColumnAgentConfig = { agentId: "agent-a", configId: "config-a", prompt: "SYNTHETIC PROMPT A" };
const B: ColumnAgentConfig = { agentId: "agent-b", configId: "config-b", prompt: "SYNTHETIC PROMPT B" };
const REVIEW_COLUMN = { status: "review-by-ai" as const, customColumnId: null };

let root: string;
let main: string;
let worktree: string;

function writeConfig(base: string, file: "config.json" | "config.local.json", value: object): void {
	mkdirSync(join(base, ".dev3"), { recursive: true });
	writeFileSync(join(base, ".dev3", file), JSON.stringify(value));
}

function project(overrides: Partial<Project> = {}): Project {
	return {
		id: "proj-1", name: "P", path: main, setupScript: "", devScript: "", cleanupScript: "",
		defaultBaseBranch: "main", createdAt: "", builtinColumnAgents: { "review-by-ai": A },
		...overrides,
	};
}

function task(overrides: Partial<Task> = {}): Task {
	return { id: "aabbccdd-1111-2222-3333-444444444444", projectId: "proj-1", worktreePath: worktree, ...overrides } as Task;
}

async function launchedConfig(p: Project, t: Task = task()): Promise<ColumnAgentConfig> {
	const failure = await launchLifecycleColumnAgent(p, t, REVIEW_COLUMN);
	expect(failure).toBeNull();
	expect(launchColumnAgent).toHaveBeenCalledTimes(1);
	return vi.mocked(launchColumnAgent).mock.calls[0][2];
}

beforeEach(() => {
	vi.clearAllMocks();
	root = mkdtempSync(join(tmpdir(), "dev3-review-column-"));
	main = join(root, "main");
	worktree = join(root, "worktree");
	mkdirSync(main);
	mkdirSync(worktree);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

// h0x91b/dev-3.0#1940: Project Settings saved B into the main checkout's .dev3 file
// (projects.json kept A), but the launcher read only the worktree's files.
describe("AI Review column launch reads the config Project Settings saved", () => {
	for (const file of ["config.json", "config.local.json"] as const) {
		it(`launches agent, config and prompt B after a save routed into the main checkout's ${file}`, async () => {
			writeConfig(main, file, { builtinColumnAgents: { "review-by-ai": A } });
			const leftover = await saveConfigToWinningLayer(main, { builtinColumnAgents: { "review-by-ai": B } });
			expect(leftover).toEqual({});

			expect(await launchedConfig(project())).toEqual(B);
		});
	}

	it("still lets the task worktree's own committed config win over the main checkout", async () => {
		writeConfig(main, "config.json", { builtinColumnAgents: { "review-by-ai": B } });
		writeConfig(worktree, "config.json", { builtinColumnAgents: { "review-by-ai": A } });

		expect(await launchedConfig(project())).toEqual(A);
	});

	it("never takes the review agent from a foreign-code worktree", async () => {
		writeConfig(main, "config.json", { builtinColumnAgents: { "review-by-ai": B } });
		writeConfig(worktree, "config.json", { builtinColumnAgents: { "review-by-ai": A } });

		expect(await launchedConfig(project(), task({ foreignCode: true }))).toEqual(B);
	});

	it("falls back to projects.json when no .dev3 file owns the field", async () => {
		expect(await launchedConfig(project({ builtinColumnAgents: { "review-by-ai": B } }))).toEqual(B);
	});
});
