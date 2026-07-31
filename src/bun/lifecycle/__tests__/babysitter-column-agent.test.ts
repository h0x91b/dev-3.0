/**
 * PR Babysitter column agent (phase 1): entering the built-in review-by-colleague
 * column launches the configured babysitter agent — but ONLY when the resolved
 * project config enables it (babysitter.autonomy set and not "off"). The prompt
 * is the stored custom one or the one composed from the babysitter knobs; the
 * pane title follows customStatusLabels; there is no onExitCommand (the task
 * stays in the column while the PR is in review).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Project, Task } from "../../../shared/types";
import { composeBabysitPrompt, DEFAULT_BABYSIT_PROMPT } from "../../../shared/types";

vi.mock("../../logger", () => ({
	createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock("node:fs", () => ({ existsSync: vi.fn(() => true) }));
vi.mock("node:fs/promises", () => ({ mkdir: vi.fn(async () => undefined), rm: vi.fn(async () => undefined) }));

vi.mock("../../cow-clone", () => ({ clonePaths: vi.fn(async () => undefined) }));
vi.mock("../../data", () => ({ updateTask: vi.fn(async () => undefined), deleteTask: vi.fn(async () => undefined) }));
vi.mock("../../git", () => ({
	removeWorktree: vi.fn(async () => undefined),
	getBranchDiffStats: vi.fn(async () => ({ files: 1, insertions: 2, deletions: 3 })),
	taskDir: vi.fn(() => "/managed/task"),
	virtualWorkDir: vi.fn(() => "/managed/ops"),
}));
vi.mock("../../paths", () => ({ DEV3_HOME: "/home/.dev3.0", OPS_DIR: "/home/.dev3.0/ops" }));
vi.mock("../../port-pool", () => ({ releasePorts: vi.fn(), getPortAssignments: vi.fn(() => []) }));
vi.mock("../../preparation-runtime", () => ({
	assertTaskPreparationActive: vi.fn(),
	markTaskPreparationCancelled: vi.fn(() => ({
		pids: [],
		settled: Promise.resolve(),
		trackedProcessesExited: Promise.resolve(),
		reentrant: false,
	})),
	reportCurrentPreparationStage: vi.fn(),
	withTaskPreparationRunId: vi.fn(),
}));

vi.mock("../../pty-server", () => ({
	destroySession: vi.fn(),
	destroyNativeTaskSession: vi.fn(async () => undefined),
}));

vi.mock("../../repo-config", () => ({
	resolveProjectConfig: vi.fn(async (project: Project) => project),
}));
vi.mock("../../settings", () => ({ loadSettings: vi.fn(async () => ({})), loadSettingsSync: vi.fn(() => ({})) }));
vi.mock("../../shell-env", () => ({ getUserShell: vi.fn(() => "/bin/zsh") }));
vi.mock("../../spawn", () => ({ spawn: vi.fn(() => ({ exited: Promise.resolve(0) })) }));
vi.mock("../../temp-paths", () => ({ dev3TaskTempPath: vi.fn(() => "/tmp/dev3/task") }));

vi.mock("../../tmux", () => ({
	DEFAULT_TMUX_SOCKET: "dev3",
	activeTmuxConfigPath: vi.fn(() => "/tmp/dev3.tmux.conf"),
	cleanupSessionName: vi.fn((taskId: string) => `dev3-cleanup-${taskId.slice(0, 8)}`),
	tmux: {
		killSession: vi.fn(async () => undefined),
		spawnAttachedSession: vi.fn(() => ({ exited: Promise.resolve(0) })),
	},
}));

vi.mock("../../rpc-handlers/tmux-pty", () => ({
	cleanupTaskTmuxState: vi.fn(),
	killDevServerSession: vi.fn(async () => undefined),
	launchColumnAgent: vi.fn(async () => undefined),
	launchTaskPty: vi.fn(async () => undefined),
}));

vi.mock("../../rpc-handlers/settings-config", () => ({
	resolveOperationalProjectConfig: vi.fn(async () => ({ devScript: "", portCount: 0 })),
}));

vi.mock("../../rpc-handlers/shared", () => ({
	buildScriptRunnerCommand: vi.fn((path: string) => `/bin/zsh ${path}`),
	buildTaskLifecycleEnv: vi.fn(() => ({})),
	getPushMessage: vi.fn(() => null),
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
	notifyWatchedTaskEvent: vi.fn(),
	notifyWatchedTaskStatusChange: vi.fn(),
	pushCliAttention: vi.fn(),
}));

import * as repoConfig from "../../repo-config";
import { launchColumnAgent } from "../../rpc-handlers/tmux-pty";
import { launchLifecycleColumnAgent } from "../executor";

const TASK_ID = "aabbccdd-1111-2222-3333-444444444444";

function project(overrides: Partial<Project> = {}): Project {
	return {
		id: "proj-1",
		name: "Project",
		path: "/repo",
		setupScript: "",
		devScript: "",
		cleanupScript: "",
		defaultBaseBranch: "main",
		createdAt: "2026-07-01T00:00:00.000Z",
		...overrides,
	};
}

function task(): Task {
	return {
		id: TASK_ID,
		seq: 1,
		projectId: "proj-1",
		title: "Task",
		description: "",
		status: "review-by-colleague",
		baseBranch: "main",
		worktreePath: "/worktrees/task",
		branchName: "feat/x",
		groupId: null,
		variantIndex: null,
		agentId: null,
		configId: null,
		createdAt: "2026-07-01T00:00:00.000Z",
		updatedAt: "2026-07-01T00:00:00.000Z",
	} as Task;
}

const COLUMN = { status: "review-by-colleague", customColumnId: null } as const;

beforeEach(() => {
	vi.mocked(launchColumnAgent).mockClear();
	vi.mocked(repoConfig.resolveProjectConfig).mockImplementation(async (p: Project) => p);
});

describe("review-by-colleague column agent (PR babysitter)", () => {
	it("launches the read-only triage babysitter by default when no config exists", async () => {
		const result = await launchLifecycleColumnAgent(project(), task(), COLUMN);
		expect(result).toBeNull();
		expect(launchColumnAgent).toHaveBeenCalledWith(
			expect.anything(),
			expect.anything(),
			{
				agentId: "builtin-claude",
				configId: "claude-bypass-sonnet",
				prompt: DEFAULT_BABYSIT_PROMPT,
			},
			{ paneTitle: "PR Review", onExitCommand: undefined },
		);
	});

	it("does nothing when babysitter autonomy is off", async () => {
		const result = await launchLifecycleColumnAgent(project({ babysitter: { autonomy: "off" } }), task(), COLUMN);
		expect(result).toBeNull();
		expect(launchColumnAgent).not.toHaveBeenCalled();
	});

	it("launches with the composed prompt of the configured level", async () => {
		const result = await launchLifecycleColumnAgent(project({ babysitter: { autonomy: "fix" } }), task(), COLUMN);
		expect(result).toBeNull();
		const [, , config] = vi.mocked(launchColumnAgent).mock.calls[0];
		expect(config.prompt).toBe(composeBabysitPrompt({ autonomy: "fix" }));
	});

	it("composes the prompt from the resolved babysitter knobs", async () => {
		const babysitter = { autonomy: "triage" as const, handleComments: false };
		await launchLifecycleColumnAgent(project({ babysitter }), task(), COLUMN);
		const [, , config] = vi.mocked(launchColumnAgent).mock.calls[0];
		expect(config.prompt).toBe(composeBabysitPrompt(babysitter));
	});

	it("prefers a configured agent/config and a stored custom prompt", async () => {
		await launchLifecycleColumnAgent(
			project({
				babysitter: { autonomy: "land" },
				builtinColumnAgents: {
					"review-by-colleague": { agentId: "builtin-codex", configId: "codex-default", prompt: "Custom babysit" },
				},
			}),
			task(),
			COLUMN,
		);
		const [, , config] = vi.mocked(launchColumnAgent).mock.calls[0];
		expect(config).toEqual({ agentId: "builtin-codex", configId: "codex-default", prompt: "Custom babysit" });
	});

	it("falls back to the composed prompt when the stored prompt is empty", async () => {
		await launchLifecycleColumnAgent(
			project({
				babysitter: { autonomy: "fix" },
				builtinColumnAgents: {
					"review-by-colleague": { agentId: "builtin-claude", configId: "claude-bypass-sonnet", prompt: "" },
				},
			}),
			task(),
			COLUMN,
		);
		const [, , config] = vi.mocked(launchColumnAgent).mock.calls[0];
		expect(config.prompt).toBe(composeBabysitPrompt({ autonomy: "fix" }));
	});

	it("titles the pane from customStatusLabels", async () => {
		await launchLifecycleColumnAgent(
			project({
				babysitter: { autonomy: "fix" },
				customStatusLabels: { "review-by-colleague": "PR Babysitter" },
			}),
			task(),
			COLUMN,
		);
		const [, , , options] = vi.mocked(launchColumnAgent).mock.calls[0];
		expect(options.paneTitle).toBe("PR Babysitter");
	});

	it("resolves the babysitter config through the repo-config cascade", async () => {
		vi.mocked(repoConfig.resolveProjectConfig).mockImplementation(async (p: Project) => ({
			...p,
			babysitter: { autonomy: "fix" as const },
		}));
		await launchLifecycleColumnAgent(project(), task(), COLUMN);
		expect(repoConfig.resolveProjectConfig).toHaveBeenCalledWith(expect.anything(), "/worktrees/task");
		expect(launchColumnAgent).toHaveBeenCalled();
	});

	it("reports a columnAgentFailed event when the launch throws", async () => {
		vi.mocked(launchColumnAgent).mockRejectedValueOnce(new Error("boom"));
		const result = await launchLifecycleColumnAgent(project({ babysitter: { autonomy: "fix" } }), task(), COLUMN);
		expect(result).toEqual({ type: "columnAgentFailed", columnName: "PR Review", error: "Error: boom" });
	});
});
