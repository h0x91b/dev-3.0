/**
 * The watchdog's per-task decision: notice a dead agent and relaunch+resume it,
 * back off and wait out a rate limit, and give up + escalate after the cap. The
 * dependencies (liveness, resume, rate-limit report, pushes) are all mocked; this
 * drives `evaluateTask` and asserts what it decided to do.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Task } from "../../shared/types";
import type { KeepAliveState } from "../../shared/types/keep-alive";
import { KEEP_ALIVE_MAX_ATTEMPTS, KEEP_ALIVE_RATE_LIMIT_BUFFER_MS } from "../../shared/keep-alive";

const H = vi.hoisted(() => ({
	task: null as unknown as Task,
	patches: [] as Partial<KeepAliveState>[],
}));

vi.mock("../data", () => ({
	loadProjects: vi.fn(async () => [{ id: "proj-1" }]),
	loadVirtualProjects: vi.fn(async () => []),
	loadTasks: vi.fn(async () => [H.task]),
	updateTaskWith: vi.fn(async (_p: unknown, _id: unknown, mutator: (t: Task) => { updates: Partial<Task>; result: unknown }) => {
		const { updates } = await mutator(H.task);
		if (updates.keepAlive !== undefined) {
			H.patches.push(updates.keepAlive as KeepAliveState);
			H.task = { ...H.task, keepAlive: updates.keepAlive } as Task;
		}
		return { task: H.task, result: undefined };
	}),
}));
vi.mock("../rpc-handlers/tmux-pty", () => ({
	resumeTaskSession: vi.fn(async () => ({ kind: "resumed", url: "ws://x", result: {} })),
	taskTerminalAlive: vi.fn(async () => true),
	ResumeUnavailableError: class ResumeUnavailableError extends Error {},
}));
// Liveness is the agent PROCESS, not the tmux session — mock it at that seam so a
// test cannot pass by treating "session alive" (a leftover shell) as "agent alive".
vi.mock("../scheduled-message-author", () => ({ taskMainAgentLiveness: vi.fn(async () => "exited") }));
vi.mock("../rate-limit-monitor", () => ({ getCachedRateLimitsReport: vi.fn(() => null) }));
vi.mock("../rpc-handlers", () => ({
	getPushMessage: vi.fn(() => vi.fn()),
	pushCliToast: vi.fn(),
	pushCliAttention: vi.fn(),
}));
vi.mock("../logger", () => ({ createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));

import { resumeTaskSession, ResumeUnavailableError, taskTerminalAlive } from "../rpc-handlers/tmux-pty";
import { taskMainAgentLiveness } from "../scheduled-message-author";
import { getCachedRateLimitsReport } from "../rate-limit-monitor";
import { pushCliAttention, pushCliToast } from "../rpc-handlers";
import { evaluateTask, startTaskKeepAliveScheduler, stopTaskKeepAliveScheduler } from "../task-keep-alive-scheduler";

const project = { id: "proj-1", name: "Proj", path: "/x/repo" } as never;
const NOW = 2_000_000;

function makeTask(keepAlive: KeepAliveState, extra: Partial<Task> = {}): Task {
	return {
		id: "tttttttt-tttt-tttt-tttt-tttttttttttt",
		projectId: "proj-1",
		seq: 9,
		title: "Monitor",
		status: "in-progress",
		keepAlive,
		sessionState: { panes: [{ agentCmd: "claude", sessionId: "s1", agentId: "a", configId: null, agentFamily: "claude", accountId: null }] },
		...extra,
	} as unknown as Task;
}

function lastPatch(): Partial<KeepAliveState> {
	return H.patches[H.patches.length - 1];
}

beforeEach(() => {
	vi.clearAllMocks();
	H.patches = [];
	// The keepShell case by default: the agent exited, its shell still holds the session.
	vi.mocked(taskMainAgentLiveness).mockResolvedValue("exited");
	vi.mocked(taskTerminalAlive).mockResolvedValue(true);
	vi.mocked(resumeTaskSession).mockResolvedValue({ kind: "resumed", url: "ws://x", result: {} } as never);
	vi.mocked(getCachedRateLimitsReport).mockReturnValue(null);
});

describe("evaluateTask", () => {
	it("clears the shell an exited agent left, then resumes it and arms the backoff", async () => {
		const task = makeTask({ enabled: true, status: "watching", attempts: 0 });
		H.task = task;
		await evaluateTask(project, task, NOW);
		expect(resumeTaskSession).toHaveBeenCalledWith(task.id, { restart: "if-exited" });
		expect(lastPatch()).toMatchObject({ status: "reviving", attempts: 1, lastVerdict: "revived" });
		expect(lastPatch().nextAttemptAt).toBeGreaterThan(NOW);
	});

	it("revives a task whose whole terminal is gone, with nothing to tear down", async () => {
		vi.mocked(taskMainAgentLiveness).mockResolvedValue("unknown");
		vi.mocked(taskTerminalAlive).mockResolvedValue(false);
		const task = makeTask({ enabled: true, status: "watching", attempts: 0 });
		H.task = task;
		await evaluateTask(project, task, NOW);
		expect(resumeTaskSession).toHaveBeenCalledWith(task.id, { refuseLive: true });
	});

	it("never tears down a live terminal on a guess — a failed probe, Windows, a setup script", async () => {
		vi.mocked(taskMainAgentLiveness).mockResolvedValue("unknown");
		const task = makeTask({ enabled: true, status: "watching", attempts: 0 });
		H.task = task;
		await evaluateTask(project, task, NOW);
		expect(resumeTaskSession).not.toHaveBeenCalled();
		expect(H.patches).toHaveLength(0);
	});

	it("leaves a terminal alone when the shared resume path cannot confirm the agent exited", async () => {
		vi.mocked(resumeTaskSession).mockResolvedValue({ kind: "already-running", backend: "tmux" } as never);
		const task = makeTask({ enabled: true, status: "watching", attempts: 0 });
		H.task = task;
		await evaluateTask(project, task, NOW);
		expect(lastPatch()).toMatchObject({ status: "reviving", attempts: 1, lastVerdict: "error" });
	});

	it("resets a recovering task to watching once its agent is alive again, without resuming", async () => {
		vi.mocked(taskMainAgentLiveness).mockResolvedValue("alive");
		const task = makeTask({ enabled: true, status: "reviving", attempts: 3 });
		H.task = task;
		await evaluateTask(project, task, NOW);
		expect(resumeTaskSession).not.toHaveBeenCalled();
		expect(lastPatch()).toMatchObject({ status: "watching", attempts: 0, lastVerdict: "healthy" });
	});

	it("waits for a known rate-limit reset instead of hammering", async () => {
		vi.mocked(getCachedRateLimitsReport).mockReturnValue({
			generatedAt: NOW,
			snapshots: [{ source: "claude", accountId: null, capturedAt: NOW, creditsBalance: null, monthlyCredits: null, planType: null, windows: [{ id: "w", usedPercent: 100, resetsAt: NOW + 10_000, windowMinutes: null }] }],
		});
		const task = makeTask({ enabled: true, status: "watching", attempts: 0 });
		H.task = task;
		await evaluateTask(project, task, NOW);
		expect(resumeTaskSession).not.toHaveBeenCalled();
		expect(lastPatch()).toMatchObject({ status: "reviving", lastVerdict: "rate-limited", nextAttemptAt: NOW + 10_000 + KEEP_ALIVE_RATE_LIMIT_BUFFER_MS });
	});

	it("holds during the backoff window", async () => {
		const task = makeTask({ enabled: true, status: "reviving", attempts: 1, nextAttemptAt: NOW + 50_000 });
		H.task = task;
		await evaluateTask(project, task, NOW);
		expect(resumeTaskSession).not.toHaveBeenCalled();
		expect(H.patches).toHaveLength(0);
	});

	it("gives up and escalates after the retry cap", async () => {
		const task = makeTask({ enabled: true, status: "reviving", attempts: KEEP_ALIVE_MAX_ATTEMPTS });
		H.task = task;
		await evaluateTask(project, task, NOW);
		expect(resumeTaskSession).not.toHaveBeenCalled();
		expect(lastPatch()).toMatchObject({ status: "gave-up", lastVerdict: "gave-up" });
		expect(pushCliAttention).toHaveBeenCalledTimes(1);
		expect(pushCliToast).toHaveBeenCalledTimes(1);
	});

	it("gives up when the conversation cannot be resumed", async () => {
		vi.mocked(resumeTaskSession).mockRejectedValue(new ResumeUnavailableError("no-saved-session", "no saved session"));
		const task = makeTask({ enabled: true, status: "watching", attempts: 0 });
		H.task = task;
		await evaluateTask(project, task, NOW);
		expect(lastPatch()).toMatchObject({ status: "gave-up", lastVerdict: "unresumable" });
		expect(pushCliAttention).toHaveBeenCalledTimes(1);
	});

	it("does nothing once it has already given up", async () => {
		const task = makeTask({ enabled: true, status: "gave-up", attempts: KEEP_ALIVE_MAX_ATTEMPTS + 1 });
		H.task = task;
		await evaluateTask(project, task, NOW);
		expect(resumeTaskSession).not.toHaveBeenCalled();
		expect(H.patches).toHaveLength(0);
	});
});

// Closing the last agent pane parks its entry (no pane id) instead of dropping it,
// so the watchdog still sees a launched task with a conversation to resume.
describe("a task whose last agent pane closed", () => {
	const parkedTask = () => makeTask({ enabled: true, status: "watching", attempts: 0 }, {
		sessionState: { panes: [{ main: true, agentCmd: "claude", sessionId: "s1", agentId: "a", configId: null, agentFamily: "claude", accountId: null, paneId: null, parked: true }] },
	} as Partial<Task>);

	async function runOneTick(): Promise<void> {
		startTaskKeepAliveScheduler();
		try {
			await vi.waitFor(() => expect(taskTerminalAlive).toHaveBeenCalled());
			await new Promise((resolve) => setTimeout(resolve, 0));
		} finally {
			stopTaskKeepAliveScheduler();
		}
	}

	beforeEach(() => {
		vi.mocked(taskMainAgentLiveness).mockResolvedValue("unknown");
		H.task = parkedTask();
	});

	it("is revived into its saved conversation once the terminal is gone", async () => {
		vi.mocked(taskTerminalAlive).mockResolvedValue(false);
		await runOneTick();
		await vi.waitFor(() => expect(resumeTaskSession).toHaveBeenCalledWith(H.task.id, { refuseLive: true }));
	});

	it("is left alone while another pane keeps the terminal alive", async () => {
		vi.mocked(taskTerminalAlive).mockResolvedValue(true);
		await runOneTick();
		expect(resumeTaskSession).not.toHaveBeenCalled();
	});
});
