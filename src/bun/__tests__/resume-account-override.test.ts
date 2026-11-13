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
vi.mock("../tmux", () => ({ DEFAULT_TMUX_SOCKET: "dev3", taskSessionName: (id: string) => `dev3-${id}`, tmux: {} }));
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
import * as agents from "../agents";
import { getActiveClaudeConfigDir } from "../agent-accounts";
import { claudeConfigDirHasSession } from "../agent-transcripts";
import { chooseTaskCodexConversations } from "../codex-task-selection";
import { launchTaskPty } from "../rpc-handlers/tmux-pty/task-launch";
import { getPushMessage } from "../rpc-handlers/shared-pure";
import { findTaskAcrossProjects, wakeIfHibernated } from "../rpc-handlers/tmux-pty/task-state";
import { resumeTaskSession } from "../rpc-handlers/tmux-pty/resume";
import { resolveResumableSessionIds } from "../agent-transcripts";
import { taskTerminalBackendIdentity } from "../task-terminal-backend";

const project = { id: "p1", name: "P", path: "/repo" } as Project;
const claudePane: PaneSessionEntry = { main: true, agentCmd: "claude", agentId: "builtin-claude", configId: "c", sessionId: "s-claude", accountId: "acct-old" };
const codexPane: PaneSessionEntry = { agentCmd: "codex", agentId: "builtin-codex", configId: "x", sessionId: "s-codex", accountId: "codex-acct" };

function arrange(panes: PaneSessionEntry[], extra: Partial<Task> = {}): Task {
	const task = { id: "t1", seq: 3, status: "in-progress", worktreePath: "/wt", hibernated: true, sessionState: { panes }, ...extra } as Task;
	vi.mocked(findTaskAcrossProjects).mockResolvedValue({ task, project } as never);
	vi.mocked(data.getTask).mockResolvedValue(task);
	return task;
}

const launchedAccount = () => (vi.mocked(launchTaskPty).mock.calls[0][7] as { accountId?: string | null }).accountId;

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(taskTerminalBackendIdentity).mockReturnValue("tmux");
	vi.mocked(claudeConfigDirHasSession).mockReturnValue(true);
	vi.mocked(chooseTaskCodexConversations).mockResolvedValue(new Map());
});

describe("resume clears the agent-exited mark", () => {
	const FLAG = "2026-11-13T10:00:00.000Z";
	// Runs the mutator against the current row, like the real read-modify-write under the lock.
	function currentRow(row: Task) {
		vi.mocked(data.updateTaskWith).mockImplementation((async (_p: unknown, _id: string, mutator: (t: Task) => { updates: Partial<Task> }) => {
			const { updates } = await mutator(row);
			return { task: { ...row, ...updates }, result: null };
		}) as never);
	}

	it("clears the flag on the current row and pushes the update", async () => {
		const push = vi.fn();
		vi.mocked(getPushMessage).mockReturnValue(push as never);
		const task = arrange([claudePane], { agentExitedAt: FLAG });
		currentRow(task);
		await resumeTaskSession("t1");
		expect(data.updateTaskWith).toHaveBeenCalledTimes(1);
		expect(push).toHaveBeenCalledWith("taskUpdated", expect.objectContaining({ projectId: "p1", task: expect.not.objectContaining({ agentExitedAt: FLAG }) }));
	});

	it("decides on the current row, not on the snapshot loaded at the start", async () => {
		const push = vi.fn();
		vi.mocked(getPushMessage).mockReturnValue(push as never);
		const task = arrange([claudePane], { agentExitedAt: FLAG });
		currentRow({ ...task, agentExitedAt: undefined });
		await resumeTaskSession("t1");
		expect(push).not.toHaveBeenCalledWith("taskUpdated", expect.anything());
	});

	it("does not fail a successful relaunch when the clear throws", async () => {
		const task = arrange([claudePane], { agentExitedAt: FLAG });
		vi.mocked(data.updateTaskWith).mockRejectedValue(new Error("disk full"));
		await expect(resumeTaskSession("t1")).resolves.toMatchObject({ kind: "resumed" });
		expect(task.agentExitedAt).toBe(FLAG);
	});
});

describe("resume with an account override", () => {
	it("keeps every pane's saved account when no override is given", async () => {
		arrange([claudePane]);
		await resumeTaskSession("t1");
		expect(launchedAccount()).toBe("acct-old");
		expect(getActiveClaudeConfigDir).not.toHaveBeenCalled();
		expect(vi.mocked(data.updateTask).mock.calls.some((call) => "accountId" in call[2])).toBe(false);
	});

	it("launches the Claude main pane on the chosen account and pins it on the task", async () => {
		arrange([claudePane]);
		const outcome = await resumeTaskSession("t1", { accountId: "acct-new" });
		expect(launchedAccount()).toBe("acct-new");
		expect(data.updateTask).toHaveBeenCalledWith(project, "t1", { accountId: "acct-new" });
		expect(outcome).toMatchObject({ kind: "resumed", result: { panes: [expect.objectContaining({ accountId: "acct-new" })] } });
	});

	it("checks the system login's own folder when null is chosen", async () => {
		arrange([claudePane]);
		await resumeTaskSession("t1", { accountId: null });
		expect(claudeConfigDirHasSession).toHaveBeenCalledWith("/home/u/.claude", "s-claude");
		expect(launchedAccount()).toBeNull();
	});

	it("moves an extra Claude pane too but leaves a Codex pane on its own home", async () => {
		const extraClaude = { ...claudePane, main: false, sessionId: "s-extra" };
		arrange([codexPane, extraClaude]);
		vi.mocked(chooseTaskCodexConversations).mockResolvedValue(new Map([[0, { sessionId: "s-codex", codexHome: "/codex-home" }]]) as never);
		await resumeTaskSession("t1", { accountId: "acct-new" });
		expect(launchedAccount()).toBe("codex-acct");
		const extraOpts = vi.mocked(agents.resolveCommandForAgent).mock.calls[0][3];
		expect(extraOpts).toMatchObject({ accountId: "acct-new" });
		expect(vi.mocked(data.updateTask).mock.calls.some((call) => "accountId" in call[2])).toBe(false);
	});

	it("refuses, before waking anything, an account that cannot see the conversation", async () => {
		arrange([claudePane]);
		vi.mocked(claudeConfigDirHasSession).mockReturnValue(false);
		await expect(resumeTaskSession("t1", { accountId: "acct-split" })).rejects.toMatchObject({ reason: "account-cannot-see-conversation" });
		expect(claudeConfigDirHasSession).toHaveBeenCalledWith("/accounts/acct-split", "s-claude");
		expect(wakeIfHibernated).not.toHaveBeenCalled();
		expect(launchTaskPty).not.toHaveBeenCalled();
	});

	it("keeps the account's folder out of the refusal, which reaches toasts and other agents", async () => {
		arrange([claudePane]);
		vi.mocked(claudeConfigDirHasSession).mockReturnValue(false);
		const err = await resumeTaskSession("t1", { accountId: "acct-split" }).catch((e: Error) => e);
		expect((err as Error).message).not.toContain("/accounts/acct-split");
	});

	it("treats a re-pick of the pane's own account as no switch", async () => {
		const task = arrange([{ ...claudePane, sessionId: null }]);
		vi.mocked(resolveResumableSessionIds).mockReturnValueOnce([{ sessionId: null, substituted: false, startFresh: false, verified: false }]);
		await resumeTaskSession("t1", { accountId: "acct-old" });
		expect(launchedAccount()).toBe("acct-old");
		expect(data.updateTask).not.toHaveBeenCalledWith(project, task.id, { accountId: "acct-old" });
	});

	it.each([
		["Auto", "auto", [claudePane]],
		["a Codex-only task", "acct-new", [codexPane]],
	] as const)("refuses %s as a resume account", async (_label, accountId, panes) => {
		arrange([...panes]);
		await expect(resumeTaskSession("t1", { accountId })).rejects.toMatchObject({ reason: "account-invalid" });
		expect(launchTaskPty).not.toHaveBeenCalled();
	});

	it("refuses an account that cannot launch, with its own reason", async () => {
		arrange([claudePane]);
		vi.mocked(getActiveClaudeConfigDir).mockRejectedValueOnce(new Error("Unknown Claude account: nope"));
		await expect(resumeTaskSession("t1", { accountId: "nope" })).rejects.toMatchObject({ reason: "account-invalid", message: "Unknown Claude account: nope" });
		expect(wakeIfHibernated).not.toHaveBeenCalled();
	});

	it("refuses a Claude pane with no conversation id: --continue would open the other account's latest", async () => {
		arrange([{ ...claudePane, sessionId: null }]);
		vi.mocked(resolveResumableSessionIds).mockReturnValueOnce([{ sessionId: null, substituted: false, startFresh: false, verified: false }]);
		await expect(resumeTaskSession("t1", { accountId: "acct-new" })).rejects.toMatchObject({ reason: "account-cannot-see-conversation" });
		expect(launchTaskPty).not.toHaveBeenCalled();
	});

	it("judges only the main pane on the native backend, which relaunches nothing else", async () => {
		vi.mocked(taskTerminalBackendIdentity).mockReturnValue("native");
		arrange([claudePane, { ...claudePane, main: false, sessionId: "s-parked" }]);
		vi.mocked(claudeConfigDirHasSession).mockImplementation((_dir, id) => id === "s-claude");
		await resumeTaskSession("t1", { accountId: "acct-new" });
		expect(launchedAccount()).toBe("acct-new");
	});

	it("refuses to join a resume already running instead of dropping the account pick", async () => {
		arrange([claudePane]);
		let release!: () => void;
		vi.mocked(launchTaskPty).mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve(undefined); }));
		const first = resumeTaskSession("t1");
		await vi.waitFor(() => expect(launchTaskPty).toHaveBeenCalled());
		await expect(resumeTaskSession("t1", { accountId: "acct-new" })).rejects.toThrow("already running");
		release();
		await first;
	});
});
