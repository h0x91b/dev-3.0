import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Project, Task, CliRequest } from "../../shared/types";

// ---- Mocks (same boundary set as cli-socket-completion-request.test.ts) ----

vi.mock("../data", () => ({
	loadProjects: vi.fn(),
	loadVirtualProjects: vi.fn(() => []),
	getProject: vi.fn(),
	loadTasks: vi.fn(),
	getTask: vi.fn(),
	addTask: vi.fn(),
	updateTask: vi.fn(),
	updateProject: vi.fn(),
}));

vi.mock("../git", () => ({
	createWorktree: vi.fn(),
	removeWorktree: vi.fn(),
}));

vi.mock("../pty-server", () => ({
	destroySession: vi.fn(),
}));

vi.mock("../rpc-handlers/tmux-pty", () => ({
	runDevServer: vi.fn(),
	stopDevServer: vi.fn(),
	restartDevServer: vi.fn(),
	getDevServerStatus: vi.fn(),
}));

vi.mock("../rpc-handlers", () => {
	const ACTIVE = ["in-progress", "user-questions", "review-by-user", "review-by-ai"];
	return {
		isActive: vi.fn((status: string) => ACTIVE.includes(status)),
		activateTask: vi.fn(),
		moveTask: vi.fn(),
		launchTaskWithAgentChoice: vi.fn(),
		createScratchTask: vi.fn(),
		deleteTask: vi.fn(),
		runCleanupScript: vi.fn(),
		emitTaskSound: vi.fn(),
		getPushMessage: vi.fn(() => null),
		triggerColumnAgentIfNeeded: vi.fn(),
		notifyWatchedTaskStatusChange: vi.fn(),
	};
});

vi.mock("../scheduled-message-author", () => ({
	AGENT_IDENTITY_UNSUPPORTED_DETAIL: "agent identity cannot be verified on Windows yet",
	captureScheduledMessageAuthor: vi.fn(async () => null),
	resolveScheduledMessageAuthorPane: vi.fn(),
	captureSenderAgent: vi.fn(async (_task: unknown, paneId: string | null) =>
		paneId
			? { ok: true, author: { paneId, sessionId: "conv-r", paneToken: "gen-1", agentProcess: "77@x" } }
			: { ok: false, reason: "no-agent", detail: "dev3 was not run from a task terminal pane, so there is no sending agent" }),
}));
vi.mock("../agent-launch-handoff", () => ({
	deliverLaunchHandoff: vi.fn(() => Promise.resolve(true)),
}));

vi.mock("../logger", () => ({
	createLogger: () => ({
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	}),
}));

vi.mock("../paths", () => ({
	DEV3_HOME: "/tmp/test-dev3",
}));

vi.mock("../socket-backpressure", () => ({
	flushAndEnd: vi.fn(),
	drainSocket: vi.fn(),
	pendingWrites: new Map(),
}));

vi.mock("../settings", () => ({
	// Auto-approval off by default here: these cases assert the ask/answer
	// contract, and a live 5-minute timer would outlive the test process.
	loadSettings: vi.fn(() => ({ updateChannel: "stable", taskSortOrder: "oldest-first", agentLaunchAutoApproveMinutes: 0 })),
	saveSettings: vi.fn(),
	recordFavoriteUsages: vi.fn(),
}));

vi.mock("../external-senders", () => ({
	requireExternalSender: vi.fn((id: string) => {
		if (id !== "openclaw:home:main") throw new Error(`Unknown external sender "${id}".`);
		return { id, label: "OpenClaw main (home)" };
	}),
}));

vi.mock("../cli-agent-spawn", () => ({
	validateLaunchSuggestion: vi.fn(),
}));

vi.mock("../agents", async () => {
	const { DEFAULT_AGENTS } = await import("../../shared/types");
	return { getAllAgents: vi.fn().mockResolvedValue(DEFAULT_AGENTS) };
});
vi.mock("node:fs", () => ({
	existsSync: vi.fn(() => false),
	readdirSync: vi.fn(() => []),
	unlinkSync: vi.fn(),
	mkdirSync: vi.fn(),
	writeFileSync: vi.fn(),
	lstatSync: vi.fn(() => { throw new Error("ENOENT"); }),
	statSync: vi.fn(() => ({ isFile: () => true })),
	readlinkSync: vi.fn(() => { throw new Error("EINVAL"); }),
	realpathSync: vi.fn((p: string) => p),
	symlinkSync: vi.fn(),
	accessSync: vi.fn(),
}));

import * as data from "../data";
import { moveTask, launchTaskWithAgentChoice, createScratchTask, deleteTask, getPushMessage } from "../rpc-handlers";
import { deliverLaunchHandoff } from "../agent-launch-handoff";
import { captureSenderAgent } from "../scheduled-message-author";
import { resolveAgentRequest, _resetAgentRequestsForTests } from "../agent-requests";
import { loadSettings } from "../settings";
import { validateLaunchSuggestion } from "../cli-agent-spawn";

const { handleRequest } = await import("../cli-socket-server");
const { requestAgentLaunchApproval } = await import("../cli-socket/approvals");

// ---- Helpers ----

const REQUESTER_ID = "task-req11111-1111-2222-3333-444444444444";
const TARGET_ID = "task-tgt22222-1111-2222-3333-444444444444";

function makeProject(overrides?: Partial<Project>): Project {
	return {
		id: "proj-1",
		name: "Test Project",
		path: "/tmp/test-project",
		setupScript: "",
		devScript: "",
		cleanupScript: "",
		defaultBaseBranch: "main",
		createdAt: new Date().toISOString(),
		...overrides,
	};
}

function makeTask(overrides?: Partial<Task>): Task {
	return {
		id: TARGET_ID,
		seq: 7,
		projectId: "proj-1",
		title: "Target task",
		description: "Waiting in To Do",
		status: "todo",
		baseBranch: "main",
		worktreePath: null,
		branchName: null,
		groupId: null,
		variantIndex: null,
		agentId: null,
		configId: null,
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		...overrides,
	};
}

const requester = makeTask({ id: REQUESTER_ID, seq: 3, title: "Asking task", status: "in-progress" });

function setupBoard(target: Task): void {
	const project = makeProject();
	vi.mocked(data.getProject).mockResolvedValue(project);
	vi.mocked(data.loadProjects).mockResolvedValue([project]);
	vi.mocked(data.loadTasks).mockResolvedValue([target, requester]);
}

function moveRequest(params: Record<string, unknown>): CliRequest {
	return { id: "req-1", method: "task.move", params };
}

beforeEach(() => {
	vi.clearAllMocks();
	_resetAgentRequestsForTests();
	vi.mocked(deliverLaunchHandoff).mockResolvedValue(true);
	// The launch answers once the child's preparation settles; by default it started.
	vi.mocked(data.getTask).mockImplementation(async (_project, id) => makeTask({ id, status: "in-progress", runtimeState: { runtime: "running", updatedAt: 1 } }));
});

describe("task.move — agent-initiated launch approval", () => {
	it("moves silently — no dialog, no sender capture — for own-task, human, and foreign non-activating moves", async () => {
		const cases = [
			{ name: "own task", board: makeTask(), moved: { ...requester, status: "review-by-ai" as const }, params: { taskId: REQUESTER_ID, newStatus: "review-by-ai", sourceTaskId: REQUESTER_ID } },
			{ name: "human into active", board: makeTask(), moved: makeTask({ status: "in-progress" }), params: { taskId: TARGET_ID, newStatus: "in-progress" } },
			{ name: "foreign non-activating", board: makeTask({ status: "in-progress" }), moved: makeTask({ status: "review-by-user" }), params: { taskId: TARGET_ID, newStatus: "review-by-user", sourceTaskId: REQUESTER_ID, sourcePaneId: "%2", sourcePid: 4242 } },
		];
		for (const c of cases) {
			vi.mocked(moveTask).mockClear();
			setupBoard(c.board);
			const pushFn = vi.fn();
			vi.mocked(getPushMessage).mockReturnValue(pushFn);
			vi.mocked(moveTask).mockResolvedValue(c.moved);

			const resp = await handleRequest(moveRequest({ projectId: "proj-1", ...c.params }));

			expect(resp.ok, c.name).toBe(true);
			expect(moveTask, c.name).toHaveBeenCalled();
			expect(pushFn, c.name).not.toHaveBeenCalled();
		}
		// A plain move that launches nothing never captures a sender.
		expect(captureSenderAgent).not.toHaveBeenCalled();
	});

	it("asks the user, then launches with the picked agent and hands off to the child", async () => {
		const target = makeTask({ overview: "Fix the parser" });
		setupBoard(target);
		const pushFn = vi.fn();
		vi.mocked(getPushMessage).mockReturnValue(pushFn);
		const launched = { ...target, status: "in-progress" as const };
		vi.mocked(launchTaskWithAgentChoice).mockResolvedValue([launched]);

		const respPromise = handleRequest(moveRequest({
			taskId: TARGET_ID,
			newStatus: "in-progress",
			projectId: "proj-1",
			sourceTaskId: REQUESTER_ID,
		}));
		await vi.waitFor(() => expect(pushFn).toHaveBeenCalled());

		const [event, payload] = pushFn.mock.calls[0] as [string, Record<string, unknown>];
		expect(event).toBe("agentLaunchRequested");
		expect(payload.taskId).toBe(TARGET_ID);
		expect(payload.taskTitle).toBe("Target task");
		expect(payload.targetStatus).toBe("in-progress");
		expect(payload.scratch).toBe(false);
		// The dialog names who is asking, so the user is not guessing.
		expect(payload.requesterSeq).toBe(3);
		expect(payload.requesterTitle).toBe("Asking task");

		const launch = { variants: [{ agentId: "builtin-claude", configId: "claude-auto", accountId: null }] };
		resolveAgentRequest(payload.requestId as string, { approved: true, launch });

		const resp = await respPromise;
		expect(resp.ok).toBe(true);
		expect(resp.data).toMatchObject({ approved: true, seq: 7, title: "Target task" });
		expect((resp.data as { launched: Array<{ replyCommand: string }> }).launched[0]!.replyCommand).toContain("dev3 message --task seq:7");
		// The user's pick reaches the launch — NOT the default agent.
		expect(launchTaskWithAgentChoice).toHaveBeenCalledWith({
			taskId: TARGET_ID,
			projectId: "proj-1",
			targetStatus: "in-progress",
			// P3 both sides: neither task set one, so nothing is inherited.
			choice: { ...launch, priority: "P3" },
		});
		// A plain move would have ignored the picked agent entirely.
		expect(moveTask).not.toHaveBeenCalled();
		expect(deliverLaunchHandoff).toHaveBeenCalledWith(expect.objectContaining({
			childTaskId: TARGET_ID,
			source: expect.objectContaining({ seq: 3 }),
			// No --handoff-file: the child still gets dev3's own default note.
			launcherNote: null,
		}));
	});

	it("gives the child no handoff note when the caller says the requester cannot take a report", async () => {
		// A start-after condition fires long after the task that armed it finished.
		const target = makeTask();
		setupBoard(target);
		const pushFn = vi.fn();
		vi.mocked(getPushMessage).mockReturnValue(pushFn);
		vi.mocked(launchTaskWithAgentChoice).mockResolvedValue([{ ...target, status: "in-progress" as const }]);

		const outcome = requestAgentLaunchApproval({
			project: makeProject(),
			task: target,
			targetStatus: "in-progress",
			requester: { taskId: REQUESTER_ID, seq: 3, title: "Asking task", projectId: "proj-1" },
			handoff: false,
		});
		await vi.waitFor(() => expect(pushFn).toHaveBeenCalled());
		const [, payload] = pushFn.mock.calls[0] as [string, Record<string, unknown>];
		expect(payload.requesterSeq).toBe(3);
		resolveAgentRequest(payload.requestId as string, { approved: true });
		await expect(outcome).resolves.toMatchObject({ approved: true });
		expect(launchTaskWithAgentChoice).toHaveBeenCalled();
		expect(deliverLaunchHandoff).not.toHaveBeenCalled();
	});

	// 2026-11-01 incident: the launch answered "started" at dispatch, while another
	// dev3 instance was deleting the child's worktree. The reply must carry how the
	// preparation actually ended.
	it("reports a preparation that failed after approval instead of a start", async () => {
		const target = makeTask();
		setupBoard(target);
		const pushFn = vi.fn();
		vi.mocked(getPushMessage).mockReturnValue(pushFn);
		vi.mocked(launchTaskWithAgentChoice).mockResolvedValue([{ ...target, status: "in-progress" as const }]);
		const preparing = makeTask({ status: "in-progress", preparing: true, runtimeState: { runtime: "preparing", stage: "creating-worktree", runId: "r1", updatedAt: 1 } });
		const failed = makeTask({ status: "todo", preparationError: "Preparation interrupted by app restart", runtimeState: { runtime: "idle", updatedAt: 2 } });
		vi.mocked(data.getTask).mockResolvedValueOnce(preparing).mockResolvedValue(failed);

		const respPromise = handleRequest(moveRequest({
			taskId: TARGET_ID,
			newStatus: "in-progress",
			projectId: "proj-1",
			sourceTaskId: REQUESTER_ID,
		}));
		await vi.waitFor(() => expect(pushFn).toHaveBeenCalled());
		const [, payload] = pushFn.mock.calls[0] as [string, Record<string, unknown>];
		resolveAgentRequest(payload.requestId as string, { approved: true });

		const resp = await respPromise;
		expect((resp.data as { launched: Array<{ preparation: unknown }> }).launched[0]!.preparation).toEqual({
			state: "failed",
			error: "Preparation interrupted by app restart",
		});
		expect(data.getTask).toHaveBeenCalledTimes(2);
	});

	it("lists the pending launch in approvals.list, and a decline launches nothing and clears it", async () => {
		setupBoard(makeTask());
		const pushFn = vi.fn();
		vi.mocked(getPushMessage).mockReturnValue(pushFn);
		vi.mocked(launchTaskWithAgentChoice).mockResolvedValue([makeTask({ status: "in-progress" })]);

		const respPromise = handleRequest(moveRequest({ taskId: TARGET_ID, newStatus: "in-progress", projectId: "proj-1", sourceTaskId: REQUESTER_ID }));
		await vi.waitFor(() => expect(pushFn).toHaveBeenCalled());

		const listed = await handleRequest({ id: "req-2", method: "approvals.list", params: {} });
		expect((listed.data as { requests: unknown[] }).requests).toEqual([expect.objectContaining({
			kind: "launch", taskId: TARGET_ID, taskTitle: "Target task", seqLabel: "7", projectName: "Test Project",
			requesterTaskId: REQUESTER_ID, requesterSeq: 3, requesterTitle: "Asking task", requesterSenderId: null,
		})]);

		resolveAgentRequest((pushFn.mock.calls[0]![1] as { requestId: string }).requestId, { approved: false });
		// Declining launches nothing.
		expect((await respPromise).data).toEqual({ approved: false });
		expect(launchTaskWithAgentChoice).not.toHaveBeenCalled();
		expect(deliverLaunchHandoff).not.toHaveBeenCalled();
		const after = await handleRequest({ id: "req-3", method: "approvals.list", params: {} });
		expect(after.data).toEqual({ requests: [] });
	});

	it("hands the child a reply command that reaches the asking AGENT, plus the launcher's --handoff-file note", async () => {
		const target = makeTask();
		setupBoard(target);
		const pushFn = vi.fn();
		vi.mocked(getPushMessage).mockReturnValue(pushFn);
		vi.mocked(launchTaskWithAgentChoice).mockResolvedValue([{ ...target, status: "in-progress" as const }]);

		const respPromise = handleRequest(moveRequest({
			taskId: TARGET_ID,
			newStatus: "in-progress",
			projectId: "proj-1",
			sourceTaskId: REQUESTER_ID,
			sourcePaneId: "%2",
			sourcePid: 4242,
			handoffNote: "Report to Seq 1141 only.",
		}));
		await vi.waitFor(() => expect(pushFn).toHaveBeenCalled());
		const [, payload] = pushFn.mock.calls[0] as [string, Record<string, unknown>];
		resolveAgentRequest(payload.requestId as string, {
			approved: true,
			launch: { variants: [{ agentId: "builtin-claude", configId: "claude-auto", accountId: null }] },
		});
		expect((await respPromise).ok).toBe(true);

		expect(captureSenderAgent).toHaveBeenCalledWith(expect.objectContaining({ id: REQUESTER_ID }), "%2", 4242, { tmuxEnv: null, envTaskId: null });
		expect(deliverLaunchHandoff).toHaveBeenCalledWith(expect.objectContaining({
			source: expect.objectContaining({ seq: 3, agent: expect.objectContaining({ paneId: "%2", agentProcess: "77@x" }) }),
			// The launcher's --handoff-file text reaches the child's note.
			launcherNote: "Report to Seq 1141 only.",
		}));
	});

	it("defaults the launch to the requester's priority when the target has none, but keeps an explicit band", async () => {
		// Issue #1496: a P0 agent's helper used to start at P3 and sink to the
		// bottom of the board.
		for (const [own, expected] of [[undefined, "P0"], ["P4", "P4"]] as const) {
			const target = makeTask(own ? { priority: own } : {});
			const project = makeProject();
			vi.mocked(data.getProject).mockResolvedValue(project);
			vi.mocked(data.loadProjects).mockResolvedValue([project]);
			vi.mocked(data.loadTasks).mockResolvedValue([target, { ...requester, priority: "P0" as const }]);
			const pushFn = vi.fn();
			vi.mocked(getPushMessage).mockReturnValue(pushFn);
			vi.mocked(launchTaskWithAgentChoice).mockResolvedValue([{ ...target, status: "in-progress" }]);

			const respPromise = handleRequest(moveRequest({
				taskId: TARGET_ID,
				newStatus: "in-progress",
				projectId: "proj-1",
				sourceTaskId: REQUESTER_ID,
			}));
			await vi.waitFor(() => expect(pushFn).toHaveBeenCalled());
			const [, payload] = pushFn.mock.calls[0] as [string, Record<string, unknown>];
			expect(payload.defaultPriority, `target ${own ?? "none"}`).toBe(expected);

			// Auto-approval with nobody watching carries no choice at all; the
			// inherited priority must still be applied.
			resolveAgentRequest(payload.requestId as string, { approved: true });
			await respPromise;
			expect(launchTaskWithAgentChoice).toHaveBeenLastCalledWith(expect.objectContaining({
				choice: expect.objectContaining({ priority: expected }),
			}));
		}
	});

	it("launches with the priority the user picked in the dialog", async () => {
		const target = makeTask();
		setupBoard(target);
		const pushFn = vi.fn();
		vi.mocked(getPushMessage).mockReturnValue(pushFn);
		vi.mocked(launchTaskWithAgentChoice).mockResolvedValue([{ ...target, status: "in-progress" }]);

		const respPromise = handleRequest(moveRequest({
			taskId: TARGET_ID,
			newStatus: "in-progress",
			projectId: "proj-1",
			sourceTaskId: REQUESTER_ID,
		}));
		await vi.waitFor(() => expect(pushFn).toHaveBeenCalled());
		const [, payload] = pushFn.mock.calls[0] as [string, Record<string, unknown>];

		resolveAgentRequest(payload.requestId as string, {
			approved: true,
			launch: { variants: [{ agentId: null, configId: null }], priority: "P1" },
		});
		await respPromise;
		expect(launchTaskWithAgentChoice).toHaveBeenCalledWith(expect.objectContaining({
			choice: expect.objectContaining({ priority: "P1" }),
		}));
	});

	it("addresses variants by seq + --variant — a live variant group shares one seq", async () => {
		const target = makeTask();
		// A real variant launch mints siblings: two tasks answering to seq 7 is what
		// makes a bare `--task seq:7` ambiguous, so the address has to name the member.
		const targetSibling = makeTask({ id: "task-tgt33333-1111-2222-3333-444444444444", variantIndex: 2 });
		const variantRequester = { ...requester, variantIndex: 1 };
		const project = makeProject();
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.loadProjects).mockResolvedValue([project]);
		vi.mocked(data.loadTasks).mockResolvedValue([target, targetSibling, variantRequester]);
		const pushFn = vi.fn();
		vi.mocked(getPushMessage).mockReturnValue(pushFn);
		vi.mocked(launchTaskWithAgentChoice).mockResolvedValue([{ ...target, status: "in-progress", variantIndex: 2 }]);

		const respPromise = handleRequest(moveRequest({
			taskId: TARGET_ID,
			newStatus: "in-progress",
			projectId: "proj-1",
			sourceTaskId: REQUESTER_ID,
		}));
		await vi.waitFor(() => expect(pushFn).toHaveBeenCalled());
		const [, payload] = pushFn.mock.calls[0] as [string, Record<string, unknown>];
		resolveAgentRequest(payload.requestId as string, {
			approved: true,
			launch: { variants: [{ agentId: "builtin-claude", configId: "claude-auto", accountId: null }] },
		});

		const resp = await respPromise;
		expect((resp.data as { launched: Array<{ replyCommand: string }> }).launched[0]!.replyCommand).toBe('dev3 message --task seq:7 --variant 2 --subject "what your reply is about" "your message"');
		expect(deliverLaunchHandoff).toHaveBeenCalledWith(expect.objectContaining({
			source: expect.objectContaining({ seq: 3, variantIndex: 1 }),
		}));
	});

	it("keeps the seq address for a lone variant survivor", async () => {
		// variantIndex outlives the siblings it was minted with, so it says nothing
		// about whether seq:7 still resolves. Nobody shares it here — issue from Seq 490.
		const target = makeTask({ variantIndex: 3 });
		setupBoard(target);
		const pushFn = vi.fn();
		vi.mocked(getPushMessage).mockReturnValue(pushFn);
		vi.mocked(launchTaskWithAgentChoice).mockResolvedValue([{ ...target, status: "in-progress" }]);

		const respPromise = handleRequest(moveRequest({
			taskId: TARGET_ID,
			newStatus: "in-progress",
			projectId: "proj-1",
			sourceTaskId: REQUESTER_ID,
		}));
		await vi.waitFor(() => expect(pushFn).toHaveBeenCalled());
		const [, payload] = pushFn.mock.calls[0] as [string, Record<string, unknown>];
		resolveAgentRequest(payload.requestId as string, {
			approved: true,
			launch: { variants: [{ agentId: "builtin-claude", configId: "claude-auto", accountId: null }] },
		});

		const resp = await respPromise;
		expect((resp.data as { launched: Array<{ replyCommand: string }> }).launched[0]!.replyCommand).toBe('dev3 message --task seq:7 --subject "what your reply is about" "your message"');
	});

	it("scopes the reply command with --project when the requester is on another board", async () => {
		const target = makeTask();
		const otherProject = makeProject({ id: "proj-2-fedcba98", name: "Other Project" });
		const foreignRequester = { ...requester, projectId: otherProject.id };
		vi.mocked(data.getProject).mockResolvedValue(makeProject());
		vi.mocked(data.loadProjects).mockResolvedValue([makeProject(), otherProject]);
		vi.mocked(data.loadTasks).mockImplementation(async (p: Project) =>
			(p.id === otherProject.id ? [foreignRequester] : [target]) as never,
		);
		const pushFn = vi.fn();
		vi.mocked(getPushMessage).mockReturnValue(pushFn);
		vi.mocked(launchTaskWithAgentChoice).mockResolvedValue([{ ...target, status: "in-progress" }]);

		const respPromise = handleRequest(moveRequest({
			taskId: TARGET_ID,
			newStatus: "in-progress",
			projectId: "proj-1",
			sourceTaskId: REQUESTER_ID,
		}));
		await vi.waitFor(() => expect(pushFn).toHaveBeenCalled());
		const [, payload] = pushFn.mock.calls[0] as [string, Record<string, unknown>];
		resolveAgentRequest(payload.requestId as string, {
			approved: true,
			launch: { variants: [{ agentId: "builtin-claude", configId: "claude-auto", accountId: null }] },
		});

		const resp = await respPromise;
		// Without the scope the requester would look seq:7 up on its OWN board.
		expect((resp.data as { launched: Array<{ replyCommand: string }> }).launched[0]!.replyCommand).toBe(
			'dev3 message --task seq:7 --project proj-1 --subject "what your reply is about" "your message"',
		);
	});

	it("errors instead of launching when no app window can show the dialog", async () => {
		setupBoard(makeTask());
		vi.mocked(getPushMessage).mockReturnValue(null);

		const resp = await handleRequest(moveRequest({
			taskId: TARGET_ID,
			newStatus: "in-progress",
			projectId: "proj-1",
			sourceTaskId: REQUESTER_ID,
		}));

		expect(resp.ok).toBe(false);
		expect(resp.error).toContain("No app window is connected");
		expect(launchTaskWithAgentChoice).not.toHaveBeenCalled();
	});

	// One request, but re-pushed per attempt: the dialog has to be reachable again
	// for a client that missed the original push (h0x91b/dev-3.0#1669). The
	// countdown is NOT re-armed — that is `markAgentRequestShown`'s first-display
	// rule, and a retry must not be able to postpone a launch.
	it("re-pushes the same launch request on a joined retry, keeping one deadline", async () => {
		setupBoard(makeTask());
		const pushFn = vi.fn();
		vi.mocked(getPushMessage).mockReturnValue(pushFn);

		const params = {
			taskId: TARGET_ID,
			newStatus: "in-progress",
			projectId: "proj-1",
			sourceTaskId: REQUESTER_ID,
		};
		const first = handleRequest(moveRequest(params));
		await vi.waitFor(() => expect(pushFn).toHaveBeenCalledTimes(1));
		const second = handleRequest(moveRequest(params));
		await vi.waitFor(() => expect(pushFn).toHaveBeenCalledTimes(2));

		const payload = pushFn.mock.calls[0][1] as { requestId: string; autoApproveAt: number | null };
		const retryPayload = pushFn.mock.calls[1][1] as { requestId: string; autoApproveAt: number | null };
		expect(retryPayload.requestId).toBe(payload.requestId);
		expect(retryPayload.autoApproveAt).toBe(payload.autoApproveAt);
		resolveAgentRequest(payload.requestId, { approved: false });

		const [respA, respB] = await Promise.all([first, second]);
		expect(respA.data).toEqual({ approved: false });
		expect(respB.data).toEqual({ approved: false });
	});
});

describe("task.createScratchAndRun", () => {
	function scratchRequest(params: Record<string, unknown>): CliRequest {
		return { id: "req-1", method: "task.createScratchAndRun", params };
	}

	it("requires a requesting task, then creates the scratch task and launches it with the picked agent", async () => {
		// A human has the Scratch Task button.
		setupBoard(makeTask());
		const refused = await handleRequest(scratchRequest({ projectId: "proj-1" }));
		expect(refused.ok).toBe(false);
		expect(refused.error).toContain("inside a task worktree");
		expect(createScratchTask).not.toHaveBeenCalled();

		const scratch = makeTask({ title: "Scratch — 14:32", description: "Scratch — 14:32", scratch: true, seq: 9 });
		setupBoard(scratch);
		vi.mocked(createScratchTask).mockResolvedValue(scratch);
		vi.mocked(launchTaskWithAgentChoice).mockResolvedValue([{ ...scratch, status: "in-progress" }]);
		const pushFn = vi.fn();
		vi.mocked(getPushMessage).mockReturnValue(pushFn);

		const respPromise = handleRequest(scratchRequest({ projectId: "proj-1", sourceTaskId: REQUESTER_ID }));
		await vi.waitFor(() => expect(pushFn).toHaveBeenCalled());

		const [event, payload] = pushFn.mock.calls[0] as [string, Record<string, unknown>];
		expect(event).toBe("agentLaunchRequested");
		expect(payload.scratch).toBe(true);

		resolveAgentRequest(payload.requestId as string, {
			approved: true,
			launch: { variants: [{ agentId: "codex", configId: "codex-default" }] },
		});

		const resp = await respPromise;
		expect(resp.ok).toBe(true);
		expect(resp.data).toMatchObject({ approved: true, seq: 9 });
		expect(deleteTask).not.toHaveBeenCalled();
		// No pane reported, so the child is told replies cannot reach the asker.
		expect(deliverLaunchHandoff).toHaveBeenCalledWith(expect.objectContaining({
			source: expect.objectContaining({ agentUnavailable: expect.stringContaining("not run from a task terminal pane") }),
		}));
	});

	it("discards the placeholder task when the user declines", async () => {
		const scratch = makeTask({ scratch: true });
		setupBoard(scratch);
		vi.mocked(createScratchTask).mockResolvedValue(scratch);
		const pushFn = vi.fn();
		vi.mocked(getPushMessage).mockReturnValue(pushFn);

		const respPromise = handleRequest(scratchRequest({ projectId: "proj-1", sourceTaskId: REQUESTER_ID }));
		await vi.waitFor(() => expect(pushFn).toHaveBeenCalled());

		const payload = pushFn.mock.calls[0][1] as { requestId: string };
		resolveAgentRequest(payload.requestId, { approved: false });

		const resp = await respPromise;
		expect(resp.data).toEqual({ approved: false });
		// An empty scratch card must not be left littering To Do.
		expect(deleteTask).toHaveBeenCalledWith({ taskId: scratch.id, projectId: "proj-1" });
		expect(launchTaskWithAgentChoice).not.toHaveBeenCalled();
	});
});

describe("task.move — unanswered launch auto-approves", () => {
	it("pushes the deadline and launches itself when nobody answers", async () => {
		vi.mocked(loadSettings).mockReturnValue({
			updateChannel: "stable", taskSortOrder: "oldest-first", agentLaunchAutoApproveMinutes: 5,
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
		} as any);
		const target = makeTask();
		setupBoard(target);
		const pushFn = vi.fn();
		vi.mocked(getPushMessage).mockReturnValue(pushFn);
		vi.mocked(launchTaskWithAgentChoice).mockResolvedValue([{ ...target, status: "in-progress" }]);

		// Installed BEFORE the request: the timer is created inside it, and a clock
		// swapped in afterwards would never own it.
		vi.useFakeTimers({ shouldAdvanceTime: true });
		try {
			const respPromise = handleRequest(moveRequest({
				taskId: TARGET_ID,
				newStatus: "in-progress",
				projectId: "proj-1",
				sourceTaskId: REQUESTER_ID,
			}));
			await vi.waitFor(() => expect(pushFn).toHaveBeenCalled());

			const payload = pushFn.mock.calls[0][1] as { autoApproveAt: number | null };
			// The dialog needs the deadline to render a countdown that matches the timer.
			expect(payload.autoApproveAt).toBeGreaterThan(Date.now());

			await vi.advanceTimersByTimeAsync(5 * 60_000);
			const resp = await respPromise;

			expect(resp.ok).toBe(true);
			expect(resp.data).toMatchObject({ approved: true });
			expect(launchTaskWithAgentChoice).toHaveBeenCalledTimes(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("carries no deadline when the setting is off", async () => {
		vi.mocked(loadSettings).mockReturnValue({
			updateChannel: "stable", taskSortOrder: "oldest-first", agentLaunchAutoApproveMinutes: 0,
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
		} as any);
		setupBoard(makeTask());
		const pushFn = vi.fn();
		vi.mocked(getPushMessage).mockReturnValue(pushFn);

		const respPromise = handleRequest(moveRequest({
			taskId: TARGET_ID,
			newStatus: "in-progress",
			projectId: "proj-1",
			sourceTaskId: REQUESTER_ID,
		}));
		await vi.waitFor(() => expect(pushFn).toHaveBeenCalled());

		const payload = pushFn.mock.calls[0][1] as { requestId: string; autoApproveAt: number | null };
		expect(payload.autoApproveAt).toBeNull();
		resolveAgentRequest(payload.requestId, { approved: false });
		await respPromise;
	});
});

describe("task.move — agent-initiated launch with variants", () => {
	const SIBLING_ID = "task-sib33333-1111-2222-3333-444444444444";

	/**
	 * Drive the approval dialog to a decision and return the CLI response.
	 * `boardAfter` replaces the task list the reply addresses are computed from —
	 * the launch is what mints the siblings, so it is read after approval.
	 */
	async function approveWith(launch: unknown, boardAfter?: Task[]) {
		setupBoard(makeTask());
		const pushFn = vi.fn();
		vi.mocked(getPushMessage).mockReturnValue(pushFn);

		const respPromise = handleRequest(moveRequest({
			taskId: TARGET_ID,
			newStatus: "in-progress",
			projectId: "proj-1",
			sourceTaskId: REQUESTER_ID,
		}));
		await vi.waitFor(() => expect(pushFn).toHaveBeenCalled());
		const [, payload] = pushFn.mock.calls[0] as [string, Record<string, unknown>];
		if (boardAfter) vi.mocked(data.loadTasks).mockResolvedValue(boardAfter);
		resolveAgentRequest(payload.requestId as string, { approved: true, launch } as never);
		return { resp: await respPromise, payload };
	}

	it("refuses variants for a target that is already in a group", async () => {
		// spawnVariants mints a FRESH group off a todo source; a member of an
		// existing group has nothing to branch from.
		const pushFn = vi.fn();
		setupBoard(makeTask({ groupId: "grp-1", variantIndex: 2 }));
		vi.mocked(getPushMessage).mockReturnValue(pushFn);
		vi.mocked(launchTaskWithAgentChoice).mockResolvedValue([makeTask({ status: "in-progress" })]);

		const respPromise = handleRequest(moveRequest({
			taskId: TARGET_ID, newStatus: "in-progress", projectId: "proj-1", sourceTaskId: REQUESTER_ID,
		}));
		await vi.waitFor(() => expect(pushFn).toHaveBeenCalled());
		const [, payload] = pushFn.mock.calls[0] as [string, Record<string, unknown>];
		expect(payload.canAddVariants).toBe(false);

		// A client that asks for three anyway is clamped, not allowed to blow up
		// inside spawnVariants and strand the blocked requester.
		resolveAgentRequest(payload.requestId as string, {
			approved: true,
			launch: { variants: [{ agentId: "a", configId: "x" }, { agentId: "b", configId: "y" }, { agentId: "c", configId: "z" }] },
		});
		await respPromise;
		expect(launchTaskWithAgentChoice).toHaveBeenCalledWith(expect.objectContaining({
			choice: expect.objectContaining({ variants: [{ agentId: "a", configId: "x" }] }),
		}));
	});

	it("launches every picked variant, hands off to each, and addresses them by id", async () => {
		const head = makeTask({ status: "in-progress", groupId: "grp-9", variantIndex: 1 });
		const sibling = makeTask({ id: SIBLING_ID, status: "in-progress", groupId: "grp-9", variantIndex: 2 });
		vi.mocked(launchTaskWithAgentChoice).mockResolvedValue([head, sibling]);

		const variants = [
			{ agentId: "builtin-claude", configId: "claude-auto" },
			{ agentId: "builtin-codex", configId: "codex-default" },
		];
		// The board AFTER the launch — this is what makes seq:7 ambiguous.
		const { resp, payload } = await approveWith({ variants }, [head, sibling, requester]);
		// A todo target outside any group may be spawned as one.
		expect(payload.canAddVariants).toBe(true);

		expect(launchTaskWithAgentChoice).toHaveBeenCalledWith(expect.objectContaining({
			choice: expect.objectContaining({ variants }),
		}));
		// Every variant is a separate agent and has to be told who started it.
		expect(deliverLaunchHandoff).toHaveBeenCalledTimes(2);
		expect(deliverLaunchHandoff).toHaveBeenCalledWith(expect.objectContaining({ childTaskId: TARGET_ID }));
		expect(deliverLaunchHandoff).toHaveBeenCalledWith(expect.objectContaining({ childTaskId: SIBLING_ID }));

		// seq:7 now matches two live tasks, so the requester gets one address per
		// variant — the shared seq plus the index that tells them apart.
		expect(resp.data).toMatchObject({
			approved: true,
			seq: 7,
			launched: [
				{ variantIndex: 1, replyCommand: 'dev3 message --task seq:7 --variant 1 --subject "what your reply is about" "your message"' },
				{ variantIndex: 2, replyCommand: 'dev3 message --task seq:7 --variant 2 --subject "what your reply is about" "your message"' },
			],
		});
	});
});

describe("launch requests with a suggested agent/config (issue #1911)", () => {
	const SUGGESTED = { agentId: "builtin-codex", configId: "codex-low" };

	async function startMove(params: Record<string, unknown> = {}, taskOverrides: Partial<Task> = {}) {
		const target = makeTask(taskOverrides);
		setupBoard(target);
		const pushFn = vi.fn();
		vi.mocked(getPushMessage).mockReturnValue(pushFn);
		vi.mocked(launchTaskWithAgentChoice).mockResolvedValue([{ ...target, status: "in-progress" }]);
		const respPromise = handleRequest(moveRequest({
			taskId: TARGET_ID, newStatus: "in-progress", projectId: "proj-1", sourceTaskId: REQUESTER_ID, ...params,
		}));
		await vi.waitFor(() => expect(pushFn).toHaveBeenCalled());
		const payload = pushFn.mock.calls[0]![1] as Record<string, unknown>;
		return { respPromise, payload };
	}

	beforeEach(() => {
		vi.mocked(validateLaunchSuggestion).mockResolvedValue(SUGGESTED);
		vi.mocked(loadSettings).mockReturnValue({ agentLaunchAutoApproveMinutes: 0 } as never);
	});

	it("validates the suggestion, preselects it in the dialog, and launches what the user picked over it", async () => {
		const { respPromise, payload } = await startMove({ agentId: "builtin-codex", configId: "codex-low" });
		expect(validateLaunchSuggestion).toHaveBeenCalledWith({ agentId: "builtin-codex", configId: "codex-low" });
		expect(payload.suggested).toEqual(SUGGESTED);
		const launch = { variants: [{ agentId: "builtin-claude", configId: "claude-auto", accountId: null }] };
		resolveAgentRequest(payload.requestId as string, { approved: true, launch });
		await respPromise;
		expect(launchTaskWithAgentChoice).toHaveBeenCalledWith(expect.objectContaining({ choice: { ...launch, priority: "P3" } }));
	});

	it("an unattended auto-approval launches the suggestion, not the global default", async () => {
		vi.mocked(loadSettings).mockReturnValue({ agentLaunchAutoApproveMinutes: 1 } as never);
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		try {
			const { respPromise } = await startMove({ agentId: "builtin-codex", configId: "codex-low" });
			vi.advanceTimersByTime(60_000);
			await respPromise;
		} finally {
			vi.useRealTimers();
		}
		expect(launchTaskWithAgentChoice).toHaveBeenCalledWith(expect.objectContaining({ choice: { variants: [SUGGESTED], priority: "P3" } }));
	});

	it("a coordinator with no flags preselects and auto-launches the coordinator preset", async () => {
		vi.mocked(loadSettings).mockReturnValue({ agentLaunchAutoApproveMinutes: 1 } as never);
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const coordinator = { agentId: "builtin-claude", configId: "claude-auto-fable51-medium" };
		let payload: Record<string, unknown>;
		try {
			const started = await startMove({}, { taskType: "coordinator" });
			payload = started.payload;
			vi.advanceTimersByTime(60_000);
			await started.respPromise;
		} finally {
			vi.useRealTimers();
		}
		expect(payload.suggested).toEqual(coordinator);
		expect(launchTaskWithAgentChoice).toHaveBeenCalledWith(expect.objectContaining({ choice: { variants: [coordinator], priority: "P3" } }));
	});

	it("without flags: no suggestion, no validation, and auto-approval keeps the default variant", async () => {
		vi.mocked(loadSettings).mockReturnValue({ agentLaunchAutoApproveMinutes: 1 } as never);
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		let payload: Record<string, unknown>;
		try {
			const started = await startMove();
			payload = started.payload;
			vi.advanceTimersByTime(60_000);
			await started.respPromise;
		} finally {
			vi.useRealTimers();
		}
		expect(payload).not.toHaveProperty("suggested");
		expect(validateLaunchSuggestion).not.toHaveBeenCalled();
		expect(launchTaskWithAgentChoice).toHaveBeenCalledWith(expect.objectContaining({
			choice: { variants: [{ agentId: null, configId: null }], priority: "P3" },
		}));
	});

	it("refuses an invalid suggestion, an account id, or a suggestion on a non-launch move before any dialog", async () => {
		setupBoard(makeTask());
		const pushFn = vi.fn();
		vi.mocked(getPushMessage).mockReturnValue(pushFn);
		vi.mocked(validateLaunchSuggestion).mockRejectedValueOnce(new Error('Unknown config "codex-max" for agent "builtin-codex".'));
		const launch = { taskId: TARGET_ID, newStatus: "in-progress", projectId: "proj-1", sourceTaskId: REQUESTER_ID };
		const cases = [
			{ params: { ...launch, agentId: "builtin-codex", configId: "codex-max" }, error: "Unknown config" },
			// The account stays the user's pick.
			{ params: { ...launch, agentId: "builtin-codex", accountId: "slot-1" }, error: "Account selection is not supported" },
			{ params: { taskId: REQUESTER_ID, newStatus: "review-by-ai", projectId: "proj-1", sourceTaskId: REQUESTER_ID, agentId: "builtin-codex" }, error: "only apply when the move asks to start" },
		];
		for (const c of cases) {
			const resp = await handleRequest(moveRequest(c.params));
			expect(resp.ok, c.error).toBe(false);
			expect(resp.error).toContain(c.error);
		}
		expect(pushFn).not.toHaveBeenCalled();
		expect(launchTaskWithAgentChoice).not.toHaveBeenCalled();
		expect(moveTask).not.toHaveBeenCalled();
	});

	it("scratch: an invalid suggestion creates no placeholder task, a valid one preselects the dialog", async () => {
		setupBoard(makeTask());
		vi.mocked(validateLaunchSuggestion).mockRejectedValueOnce(new Error('Unknown agent "nope" — see dev3 agent list.'));
		const bad = await handleRequest({ id: "req-1", method: "task.createScratchAndRun", params: { projectId: "proj-1", sourceTaskId: REQUESTER_ID, agentId: "nope" } });
		expect(bad.ok).toBe(false);
		expect(bad.error).toContain("Unknown agent");
		expect(createScratchTask).not.toHaveBeenCalled();

		const scratch = makeTask({ title: "Scratch — 14:32", scratch: true, seq: 9 });
		setupBoard(scratch);
		vi.mocked(createScratchTask).mockResolvedValue(scratch);
		const pushFn = vi.fn();
		vi.mocked(getPushMessage).mockReturnValue(pushFn);
		const respPromise = handleRequest({ id: "req-1", method: "task.createScratchAndRun", params: { projectId: "proj-1", sourceTaskId: REQUESTER_ID, agentId: "builtin-codex", configId: "codex-low" } });
		await vi.waitFor(() => expect(pushFn).toHaveBeenCalled());
		const payload = pushFn.mock.calls[0]![1] as Record<string, unknown>;
		expect(payload.suggested).toEqual(SUGGESTED);
		resolveAgentRequest(payload.requestId as string, { approved: false });
		await respPromise;
	});
});

describe("task.moveAsSender — a start an external sender asks for", () => {
	function senderMoveRequest(params: Record<string, unknown>): CliRequest {
		return { id: "req-1", method: "task.moveAsSender", params };
	}

	it("goes through the same dialog, naming the sender, and hands back an --as-sender reply command", async () => {
		const target = makeTask();
		setupBoard(target);
		const pushFn = vi.fn();
		vi.mocked(getPushMessage).mockReturnValue(pushFn);
		vi.mocked(launchTaskWithAgentChoice).mockResolvedValue([{ ...target, status: "in-progress" as const }]);

		const respPromise = handleRequest(senderMoveRequest({
			taskId: TARGET_ID,
			newStatus: "in-progress",
			projectId: "proj-1",
			asSender: "openclaw:home:main",
		}));
		await vi.waitFor(() => expect(pushFn).toHaveBeenCalled());
		const [event, payload] = pushFn.mock.calls[0] as [string, Record<string, unknown>];
		expect(event).toBe("agentLaunchRequested");
		expect(payload.requesterSender).toEqual({ senderId: "openclaw:home:main", label: "OpenClaw main (home)" });
		expect(payload.requesterTitle).toBe("OpenClaw main (home)");
		resolveAgentRequest(payload.requestId as string, { approved: true, launch: { variants: [{ agentId: null, configId: null }] } });

		const resp = await respPromise;
		const replyCommand = (resp.data as { launched: Array<{ replyCommand: string }> }).launched[0]!.replyCommand;
		expect(replyCommand).toContain("dev3 message --as-sender openclaw:home:main --task seq:7 --project proj-1");
		// A sender has no task to report back to, so no handoff note is typed.
		expect(deliverLaunchHandoff).not.toHaveBeenCalled();
		expect(moveTask).not.toHaveBeenCalled();
	});

	it("refuses a sender start that is malformed, from a task, from an unknown sender, or on plain task.move", async () => {
		setupBoard(makeTask());
		const pushFn = vi.fn();
		vi.mocked(getPushMessage).mockReturnValue(pushFn);
		const base = { taskId: TARGET_ID, newStatus: "in-progress", projectId: "proj-1", asSender: "openclaw:home:main" };
		const cases: Array<[CliRequest, RegExp | string]> = [
			// No app ever runs a sender's start as an ordinary move.
			[moveRequest(base), "task.moveAsSender"],
			// Refused instead of silently dropped.
			[senderMoveRequest({ ...base, handoffNote: "brief" }), "--handoff-file does not apply with --as-sender"],
			[senderMoveRequest({ ...base, asSender: "ghost" }), /^Unknown external sender/],
			[senderMoveRequest({ ...base, sourceTaskId: REQUESTER_ID }), "--as-sender cannot be used from inside a task"],
		];
		for (const [req, error] of cases) {
			const resp = await handleRequest(req);
			expect(resp, String(error)).toMatchObject({ ok: false, error: typeof error === "string" ? expect.stringContaining(error) : expect.stringMatching(error) });
		}
		expect(pushFn).not.toHaveBeenCalled();
		expect(moveTask).not.toHaveBeenCalled();
		expect(launchTaskWithAgentChoice).not.toHaveBeenCalled();
	});

	it("refuses moving a running task, so no column agent starts without a dialog, but a repeated start is a no-op", async () => {
		setupBoard(makeTask({ status: "in-progress" }));
		const pushFn = vi.fn();
		vi.mocked(getPushMessage).mockReturnValue(pushFn);
		const refused = await handleRequest(senderMoveRequest({ taskId: TARGET_ID, newStatus: "review-by-ai", projectId: "proj-1", asSender: "openclaw:home:main" }));
		expect(refused).toMatchObject({ ok: false, error: "A sender can only start a task that is not running." });
		const repeated = await handleRequest(senderMoveRequest({ taskId: TARGET_ID, newStatus: "in-progress", projectId: "proj-1", asSender: "openclaw:home:main" }));
		expect(repeated).toMatchObject({ ok: true, data: { id: TARGET_ID, status: "in-progress" } });
		expect(moveTask).not.toHaveBeenCalled();
		expect(pushFn).not.toHaveBeenCalled();
	});
});
