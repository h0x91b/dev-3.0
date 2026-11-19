import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PaneSessionEntry, Project, Task } from "../../shared/types";

vi.mock("../data", () => ({ updateTask: vi.fn(), getTask: vi.fn(), updateTaskWith: vi.fn() }));
vi.mock("../pty-server", () => ({
	hasSession: vi.fn(() => false),
	destroySessionAwaited: vi.fn(),
	tmuxSessionExists: vi.fn(async () => true),
	splitAndRunCommand: vi.fn(async () => "%2"),
	getPtyPort: vi.fn(() => 9999),
}));
vi.mock("../agents", () => ({
	isClaudeCommand: vi.fn((cmd: string) => cmd === "claude"),
	getAllAgents: vi.fn(async () => []),
	findConfig: vi.fn(() => undefined),
	resolveCommandForAgent: vi.fn(async () => ({ command: "claude --resume", extraEnv: {} })),
	buildResumeCommand: vi.fn(() => "claude --resume"),
	claudeLaunchKeepsProjectFolder: vi.fn(() => false),
}));
vi.mock("../agent-accounts", () => ({
	codexAccountIdForHome: vi.fn(() => "codex-acct"),
	defaultAccountPaths: vi.fn(() => ({ claudeHome: "/home/u/.claude" })),
	getActiveClaudeConfigDir: vi.fn(async (id: string | null) => (id ? `/accounts/${id}` : null)),
}));
vi.mock("../agent-transcripts", () => ({
	resolveResumableSessionIds: vi.fn((_wt: string, panes: Array<{ sessionId: string | null }>) =>
		panes.map((p) => ({ sessionId: p.sessionId, substituted: false, startFresh: false, verified: true }))),
	claudeConfigDirHasSession: vi.fn(() => true),
}));
vi.mock("../codex-task-selection", () => ({ chooseTaskCodexConversations: vi.fn(async () => new Map()) }));
vi.mock("../repo-config", () => ({ resolveProjectEnv: vi.fn(async () => ({})) }));
vi.mock("../ops-worktree", () => ({ resolveLaunchProject: vi.fn(async (p: Project) => p), rootProjectFor: vi.fn((p: Project) => p) }));
vi.mock("../tmux", () => ({ DEFAULT_TMUX_SOCKET: "dev3", taskSessionName: (id: string) => `dev3-${id}`, tmux: { killSession: vi.fn() } }));
vi.mock("../temp-paths", () => ({ dev3TaskTempPath: (_id: string, name: string) => `/tmp/${name}` }));
vi.mock("../task-terminal-backend", () => ({ taskTerminalBackendIdentity: vi.fn(() => "tmux") }));
vi.mock("../native-task-panes", () => ({ nativeTaskPaneCommandsStrict: vi.fn(), nativeTaskPanesAlive: vi.fn(), stopNativeTaskPanes: vi.fn() }));
vi.mock("../task-workspace-guard", () => ({ assertTaskWorkspacePresent: vi.fn() }));
vi.mock("../scheduled-message-author", () => ({ taskMainAgentLiveness: vi.fn() }));
vi.mock("../agent-prompt-native", () => ({ NATIVE_AGENT_PANE_ID: "agent" }));
vi.mock("../rpc-handlers/shared-pure", () => ({
	getPushMessage: vi.fn(() => null),
	buildCmdScript: vi.fn(() => "script"),
	writeLaunchScript: vi.fn(),
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../rpc-handlers/tmux-pty/task-launch", () => ({
	launchTaskPty: vi.fn(async () => undefined),
	ensureAgentTrust: vi.fn(),
	applyAgentHooksToCommand: vi.fn(async (_wt: string, _base: string, cmd: string) => cmd),
	notifyStaleAccountDropped: vi.fn(),
}));
vi.mock("../rpc-handlers/tmux-pty/task-state", () => ({
	findTaskAcrossProjects: vi.fn(),
	markTerminalAttached: vi.fn(),
	wakeIfHibernated: vi.fn(),
}));

import * as data from "../data";
import { launchTaskPty } from "../rpc-handlers/tmux-pty/task-launch";
import { findTaskAcrossProjects } from "../rpc-handlers/tmux-pty/task-state";
import { ResumeUnavailableError, resumeTaskSession } from "../rpc-handlers/tmux-pty/resume";
import { resolveResumableSessionIds } from "../agent-transcripts";
import * as pty from "../pty-server";

const project = { id: "p1", name: "P", path: "/repo" } as Project;
const mainPane: PaneSessionEntry = { main: true, agentCmd: "claude", agentId: "builtin-claude", configId: "c", sessionId: "never-created", accountId: "acct-old" };
const extraPane: PaneSessionEntry = { agentCmd: "codex", agentId: "builtin-codex", configId: "x", sessionId: "s-codex", accountId: "codex-acct" };
const failure = (overrides: Partial<NonNullable<Task["launchFailure"]>> = {}) =>
	({ exitCode: 2, at: "2026-11-19T10:00:00Z", output: null, neverStarted: true, sessionId: "never-created", ...overrides });

function arrange(extra: Partial<Task> = {}): Task {
	const task = { id: "t1", seq: 3, status: "in-progress", worktreePath: "/wt", description: "Fix the login bug", sessionState: { panes: [mainPane] }, ...extra } as Task;
	vi.mocked(findTaskAcrossProjects).mockResolvedValue({ task, project } as never);
	vi.mocked(data.getTask).mockResolvedValue({ ...task, sessionState: { panes: [{ ...mainPane, sessionId: "fresh-id", paneId: "%9" }] } });
	return task;
}

const mainLaunch = () => vi.mocked(launchTaskPty).mock.calls[0];
const launchOpts = () => mainLaunch()[7] as { sessionId?: string; accountId?: string | null; freshSessionId?: string; freshWithTaskPrompt?: boolean };
const sessionStateWrites = () => vi.mocked(data.updateTask).mock.calls.filter(([, , updates]) => "sessionState" in updates);

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(pty.tmuxSessionExists).mockResolvedValue(true);
});

describe("first launch ended before a conversation was created", () => {
	it("resume starts the agent fresh with the original prompt, in the same task, worktree, config and account", async () => {
		arrange({ launchFailure: failure() });
		const outcome = await resumeTaskSession("t1");

		expect(launchTaskPty).toHaveBeenCalledTimes(1);
		const [, launchedTask, worktree, agentId, configId, runSetup, resume] = mainLaunch();
		expect(launchedTask.id).toBe("t1");
		expect([worktree, agentId, configId, runSetup, resume]).toEqual(["/wt", "builtin-claude", "c", false, true]);
		expect(launchOpts()).toMatchObject({ accountId: "acct-old", freshWithTaskPrompt: true });
		expect(launchOpts().sessionId).toBeUndefined();
		expect(launchOpts().freshSessionId).toEqual(expect.any(String));
		expect(sessionStateWrites()).toHaveLength(0);
		expect(outcome).toMatchObject({
			kind: "resumed",
			result: { panes: [{ index: 0, mode: "fresh-session", status: "resumed", storedSessionId: "never-created", detail: expect.stringContaining("launched fresh with the task prompt") }] },
		});
	});

	it("also does it when the main pane has no saved id", async () => {
		arrange({ launchFailure: failure(), sessionState: { panes: [{ ...mainPane, sessionId: null }] } });
		await resumeTaskSession("t1");
		expect(launchOpts().freshWithTaskPrompt).toBe(true);
	});

	it("keeps the extra panes and resumes them as usual", async () => {
		arrange({ launchFailure: failure(), sessionState: { panes: [mainPane, extraPane] } });
		const outcome = await resumeTaskSession("t1");

		expect(launchOpts().freshWithTaskPrompt).toBe(true);
		expect(pty.splitAndRunCommand).toHaveBeenCalledTimes(1);
		expect(sessionStateWrites().every(([, , updates]) => updates.sessionState !== null)).toBe(true);
		expect(outcome).toMatchObject({ result: { panes: [{ mode: "fresh-session" }, { index: 1, mode: "exact", status: "resumed", sessionId: "s-codex" }] } });
	});

	it("works as a user restart, which otherwise refuses unless every conversation is restored", async () => {
		arrange({ launchFailure: failure() });
		vi.mocked(pty.tmuxSessionExists).mockResolvedValue(false);
		await expect(resumeTaskSession("t1", { restart: "always" })).resolves.toMatchObject({ kind: "resumed" });
		expect(launchOpts().freshWithTaskPrompt).toBe(true);
	});

	it("is allowed for `dev3 agent resume`, which refuses to start over from the description", async () => {
		arrange({ launchFailure: failure() });
		vi.mocked(pty.tmuxSessionExists).mockResolvedValueOnce(false);
		await expect(resumeTaskSession("t1", { refuseLive: true, refuseFresh: true, requireSessionIds: true })).resolves.toMatchObject({
			kind: "resumed",
			result: { panes: [{ mode: "fresh-session" }] },
		});
	});

	it("persists an account override on the task, like any resume", async () => {
		arrange({ launchFailure: failure() });
		await resumeTaskSession("t1", { accountId: "acct-new" });
		expect(launchOpts().accountId).toBe("acct-new");
		expect(data.updateTask).toHaveBeenCalledWith(project, "t1", { accountId: "acct-new" });
	});

	it("does not apply when the agent had started and then crashed", async () => {
		arrange({ launchFailure: failure({ neverStarted: false }) });
		await resumeTaskSession("t1");
		expect(launchOpts()).toMatchObject({ sessionId: "never-created" });
		expect(launchOpts().freshWithTaskPrompt).toBeUndefined();
	});

	it("does not apply when the main pane already carries another conversation", async () => {
		arrange({ launchFailure: failure(), sessionState: { panes: [{ ...mainPane, sessionId: "later-session" }] } });
		await resumeTaskSession("t1");
		expect(launchOpts()).toMatchObject({ sessionId: "later-session" });
		expect(launchOpts().freshWithTaskPrompt).toBeUndefined();
	});
});

describe("the conversation exists", () => {
	it("resume continues the same id, reported as exact, and keeps the history", async () => {
		arrange();
		const outcome = await resumeTaskSession("t1");
		expect(mainLaunch()[6]).toBe(true);
		expect(launchOpts()).toMatchObject({ sessionId: "never-created" });
		expect(launchOpts().freshSessionId).toBeUndefined();
		expect(sessionStateWrites()).toHaveLength(0);
		expect(outcome).toMatchObject({ result: { panes: [{ mode: "exact", sessionId: "never-created" }] } });
	});
});

describe("conversation history that cannot be read", () => {
	it("refuses the resume, launches nothing and leaves the saved conversation bound", async () => {
		arrange({ sessionState: { panes: [mainPane, extraPane] } });
		vi.mocked(resolveResumableSessionIds).mockReturnValueOnce([
			{ sessionId: "never-created", substituted: false, startFresh: false, verified: false, unreadable: { dir: "/home/u/.claude/projects/-wt", code: "EACCES" } },
			{ sessionId: "s-codex", substituted: false, startFresh: false, verified: true },
		]);
		const error = await resumeTaskSession("t1").catch((err: unknown) => err);

		expect(error).toBeInstanceOf(ResumeUnavailableError);
		expect((error as ResumeUnavailableError).reason).toBe("history-unreadable");
		expect((error as Error).message).toBe(
			"Cannot read this task's conversation history (/home/u/.claude/projects/-wt: EACCES). The task stays bound to conversation never-cr. Restore access and resume again, or choose Start fresh for a new conversation.",
		);
		expect(launchTaskPty).not.toHaveBeenCalled();
		expect(pty.splitAndRunCommand).not.toHaveBeenCalled();
		expect(data.updateTask).not.toHaveBeenCalled();
	});
});
