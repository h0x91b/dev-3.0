import codexQuestionHookTrace from "./fixtures/codex-0.154-question-hooks.json";
import { agentPromptLedger } from "../agent-prompt-ledger";
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from "vitest";
import { BOARD_CLEANUP_PROMPT, COORDINATOR_PROMPT, DEFAULT_PR_REVIEW_PROMPT, TASK_REF_UNRESOLVED_PREFIX, getAllowedTransitions, withPresetPrompt, type Project, type Task, type CliRequest, type TaskNote, type TaskMovement, type SharedArtifact, type SharedImage } from "../../shared/types";

// ---- Mocks ----

vi.mock("../task-workspace-guard", async (importOriginal) => ({
	...(await importOriginal<typeof import("../task-workspace-guard")>()),
	// Fixture worktree paths do not exist on disk; the guard has its own tests.
	assertTaskWorkspacePresent: vi.fn((_project: unknown, path: string | null | undefined) => path ?? ""),
	worktreeAccessState: vi.fn(() => "present"),
}));
// Pane placement is tested here; the Codex store guard has its own fixture suites
// and must never scan this machine's real stores from a suite without a temp HOME.
vi.mock("../codex-resume-home", () => ({ isInteractiveCodexConversation: vi.fn(async () => true) }));
vi.mock("../codex-task-selection", () => ({ configuredCodexHomes: vi.fn(async () => []), chooseTaskCodexConversations: vi.fn(async () => new Map()), claimCodexChoices: vi.fn(async () => undefined) }));

vi.mock("../data", () => ({
	loadProjects: vi.fn(),
	loadVirtualProjects: vi.fn(() => Promise.resolve([])),
	getProject: vi.fn(),
	loadTasks: vi.fn(),
	getTask: vi.fn(),
	addTask: vi.fn(),
	updateTask: vi.fn(),
	setTaskPriority: vi.fn(),
	updateTaskWith: vi.fn(),
	updateProject: vi.fn(),
	updateProjectWith: vi.fn(),
}));

vi.mock("../task-sessions", () => ({ rememberTaskSession: vi.fn() }));

vi.mock("../git", () => ({
	createWorktree: vi.fn(),
	removeWorktree: vi.fn(),
	getCurrentBranch: vi.fn(async () => null),
}));

vi.mock("../shared-images", () => ({
	SharedImageError: class SharedImageError extends Error {},
	saveSharedImage: vi.fn((_projectPath: string, src: string, caption?: string) => ({
		id: `img-${src}`,
		storedPath: `/wt/shared-images/${src.split("/").pop()}`,
		originalPath: src,
		name: src.split("/").pop() ?? src,
		mime: "image/png",
		bytes: 1,
		createdAt: 1,
		...(caption ? { caption } : {}),
	})),
	saveSharedClips: vi.fn(async (_projectPath: string, items: { path: string; caption?: string }[]) => items.map(({ path: src, caption }) => ({
		id: `clip-${src}`,
		storedPath: `/wt/shared-images/${src.split("/").pop()}`,
		originalPath: src,
		name: src.split("/").pop() ?? src,
		mime: src.endsWith(".mp3") ? "audio/mpeg" : "video/mp4",
		bytes: 1,
		createdAt: 1,
		...(caption ? { caption } : {}),
	}))),
}));

vi.mock("../shared-artifacts", () => ({
	SharedArtifactError: class SharedArtifactError extends Error {},
	saveSharedArtifact: vi.fn((_projectPath: string, htmlPath: string, assetPaths: string[], title?: string, keyOptions?: { artifactId?: string; forceNew?: boolean }) => ({
		id: "artifact-1",
		groupKey: keyOptions?.forceNew
			? "new:artifact-1"
			: keyOptions?.artifactId
				? `id:${keyOptions.artifactId.toLowerCase()}`
				: `title:${(title || "report").toLowerCase()}`,
		version: 1,
		kind: "html",
		title: title || "report",
		name: "report.html",
		storedPath: "/wt/shared-artifacts/artifact-1/report.html",
		originalPath: htmlPath,
		bytes: 10,
		createdAt: 1,
		assets: assetPaths.map((path) => ({
			name: path.split("/").pop(),
			storedPath: `/wt/shared-artifacts/artifact-1/${path.split("/").pop()}`,
			originalPath: path,
			mime: "image/png",
			bytes: 1,
		})),
	})),
}));

vi.mock("../pty-server", () => ({
	destroySession: vi.fn(),
	getTmuxLayout: vi.fn(async () => ({ sessionName: "dev3-task1234", exists: false, windows: [], panes: [] })),
}));

vi.mock("../user-activity", () => ({
	getUserIdleSeconds: vi.fn(async () => 7),
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
		createTask: vi.fn(),
		deleteTask: vi.fn(),
		moveTask: vi.fn(),
		runCleanupScript: vi.fn(),
		emitTaskSound: vi.fn(),
		getPushMessage: vi.fn(() => null),
		triggerColumnAgentIfNeeded: vi.fn(),
		notifyWatchedTaskStatusChange: vi.fn(),
		notifyFromCliDesktop: vi.fn(),
		isAppForeground: vi.fn(() => false),
		getActiveContext: vi.fn(() => ({ projectId: null, taskId: null })),
		isTerminalFocusActive: vi.fn(() => false),
		isNotificationSuppressed: vi.fn(() => false),
		activeNotificationSuppression: vi.fn(() => []),
		isProjectSilenced: vi.fn(() => false),
		pushCliAttention: vi.fn(),
		dropQueuedAttention: vi.fn(),
		pushCliToast: vi.fn(),
		pushCliShowImage: vi.fn(),
		pushCliShowArtifact: vi.fn(),
		setFocusMode: vi.fn(),
		clearMergeNotification: vi.fn(),
		queueTerminalFocusToast: vi.fn(),
	};
});

// The shared board operations push through the production port; route it to the
// mocked barrel so these adapter tests keep asserting on `getPushMessage`.
vi.mock("../board-operations/runtime", async () => {
	const barrel = await import("../rpc-handlers");
	return {
		boardPorts: {
			push: (name: string, payload: unknown) => barrel.getPushMessage()?.(name, payload),
			clearMergeNotification: (taskId: string) => barrel.clearMergeNotification(taskId),
			syncTerminalTitle: () => {},
		},
	};
});

vi.mock("../notification-log", () => ({
	appendNotificationLog: vi.fn(),
}));

vi.mock("../project-registration", () => ({
	registerProject: vi.fn(async () => ({ outcome: "added" })),
	cloneProject: vi.fn(async () => ({ outcome: "added" })),
	listSpaces: vi.fn(async () => ({ version: 1, spaces: [], order: [] })),
	createSpaceWith: vi.fn(async () => ({ id: "sp_1" })),
	changeProjectSpaces: vi.fn(async () => ({ deletedSpaces: [] })),
}));

vi.mock("../task-start-ref", () => ({
	resolveTaskStartRef: vi.fn(async () => undefined),
}));

const hookInfo = vi.hoisted(() => vi.fn());

vi.mock("../logger", () => ({
	createLogger: () => ({
		debug: vi.fn(),
		info: hookInfo,
		warn: vi.fn(),
		error: vi.fn(),
	}),
}));

vi.mock("../paths", () => ({
	DEV3_HOME: "/tmp/test-dev3",
}));

// The global epic registry, in memory: the real one lives in ~/.dev3.0/epics.json
// and has its own suite. Same ref rules as production (shared resolveEpicRef).
const epicStore = vi.hoisted(() => ({ epics: [] as import("../../shared/types").Epic[] }));
vi.mock("../epics-data", async () => {
	const { resolveEpicRef, EPIC_REF_INVALID_PREFIX } = await import("../../shared/types");
	const refError = (ref: string) => new Error(`${EPIC_REF_INVALID_PREFIX}No epic "${ref}"`);
	return {
		loadEpics: vi.fn(async () => epicStore.epics),
		loadEpicsFile: vi.fn(async () => ({ version: 1, epics: epicStore.epics })),
		getEpicById: vi.fn(async (id: string) => epicStore.epics.find((e) => e.id === id) ?? null),
		findEpic: vi.fn(async (ref: string) => {
			const result = resolveEpicRef(epicStore.epics, ref);
			if (result.kind === "found") return result.epic;
			throw refError(ref);
		}),
		createEpic: vi.fn(async (name: string, color?: string) => {
			const epic = { id: `epic-${epicStore.epics.length + 1}-0000-1111-2222`, name, color: color ?? "#3b82f6", archived: false, createdAt: 0 };
			epicStore.epics.push(epic);
			return epic;
		}),
		updateEpic: vi.fn(),
		epicRefError: refError,
	};
});

vi.mock("../socket-backpressure", () => ({
	flushAndEnd: vi.fn(),
	drainSocket: vi.fn(),
	pendingWrites: new Map(),
}));

vi.mock("../settings", () => ({
	loadSettings: vi.fn(() => ({ updateChannel: "stable", taskSortOrder: "oldest-first" })),
	saveSettings: vi.fn(),
	recordFavoriteUsages: vi.fn(),
}));

vi.mock("../agent-prompt-delivery", () => ({
	deliverAgentPrompt: vi.fn(async () => ({ status: "delivered" })),
}));

vi.mock("../scheduled-message-scheduler", () => ({
	sendMessageImmediately: vi.fn(async () => ({ status: "delivered" })),
	scheduleMessage: vi.fn(async (_project: unknown, task: { scheduledMessages?: unknown[] }) => task),
	cancelScheduledMessageByRef: vi.fn(),
}));

vi.mock("../scheduled-message-author", () => ({
	AGENT_IDENTITY_UNSUPPORTED_DETAIL: "agent identity cannot be verified on Windows yet",
	captureScheduledMessageAuthor: vi.fn(async (_task: unknown, paneId: string | null) =>
		paneId ? { paneId, sessionId: "conv-a", paneToken: "gen-1", agentProcess: "101@x" } : null),
	captureSenderAgent: vi.fn(async (_task: unknown, paneId: string | null) =>
		paneId
			? { ok: true, author: { paneId, sessionId: "conv-s", paneToken: "gen-9", agentProcess: "909@x" } }
			: { ok: false, reason: "no-agent", detail: "dev3 was not run from a task terminal pane, so there is no sending agent" }),
	resolveScheduledMessageAuthorPane: vi.fn(async (_task: unknown, author: { paneId: string }) => ({ ok: true, paneId: author.paneId })),
}));

vi.mock("../agent-message-target", () => ({
	withAgentPanes: vi.fn(async (_task: unknown, listing: unknown) => listing),
}));

vi.mock("../vents", () => ({
	addVent: vi.fn(() => ({ fileName: "2026-06-15_14-30_x.md", path: "/tmp/v/2026-06-15_14-30_x.md", name: "x" })),
}));

vi.mock("../remote-access-server", () => ({
	getAccessUrl: vi.fn(async () => "http://10.0.0.5:41234/?token=fresh"),
	getServerPort: vi.fn(() => 0),
	getStaticCode: vi.fn(() => null),
	getSignInLink: vi.fn(async () => null),
}));

// `tunnelManager` too: `port-tunnels` registers its change hook at module scope,
// and the socket server reaches that module through the launch path, so a mock
// without it dies on import rather than in a test.
vi.mock("../cloudflare-tunnel", () => ({
	getTunnelUrl: vi.fn(() => null),
	tunnelManager: {
		setChangeHook: vi.fn(),
		get: vi.fn(() => undefined),
		list: vi.fn(() => []),
		start: vi.fn(),
		stop: vi.fn(),
		stopAll: vi.fn(),
	},
}));

vi.mock("../codex-turn-watch", () => ({
	codexTurnWatches: { observe: vi.fn(), endTurn: vi.fn(), forgetTask: vi.fn(), close: vi.fn(), check: vi.fn() },
}));

vi.mock("node:fs", () => ({
	existsSync: vi.fn(() => false),
	readdirSync: vi.fn(() => []),
	unlinkSync: vi.fn(),
	mkdirSync: vi.fn(),
	writeFileSync: vi.fn(),
}));

import * as data from "../data";
import * as git from "../git";
import { rememberTaskSession } from "../task-sessions";
import * as pty from "../pty-server";
import { activateTask, createTask, deleteTask, moveTask, getPushMessage, notifyFromCliDesktop, isAppForeground, getActiveContext, isNotificationSuppressed, activeNotificationSuppression, isProjectSilenced, pushCliAttention, dropQueuedAttention, pushCliToast, pushCliShowImage, pushCliShowArtifact, setFocusMode, clearMergeNotification } from "../rpc-handlers";
import { appendNotificationLog } from "../notification-log";
import { loadSettings } from "../settings";
import { deliverAgentPrompt } from "../agent-prompt-delivery";
import { runDevServer, stopDevServer, restartDevServer, getDevServerStatus } from "../rpc-handlers/tmux-pty";
import { resolveTaskStartRef } from "../task-start-ref";
import { flushAndEnd } from "../socket-backpressure";
import { existsSync, readdirSync, unlinkSync, mkdirSync, writeFileSync } from "node:fs";
import { addVent } from "../vents";
import { getServerPort } from "../remote-access-server";
import { saveSharedClips, saveSharedImage } from "../shared-images";
import { saveSharedArtifact } from "../shared-artifacts";
import { closePaneRun, paneRunListing, readPaneRun, startPaneRun } from "../task-pane-runs";
import { cancelScheduledMessageByRef, scheduleMessage, sendMessageImmediately } from "../scheduled-message-scheduler";
import { captureScheduledMessageAuthor, resolveScheduledMessageAuthorPane } from "../scheduled-message-author";
import { withAgentPanes } from "../agent-message-target";
import { encodeAgentHandle } from "../../shared/agent-handle";
import { codexTurnWatches } from "../codex-turn-watch";
import { isInteractiveCodexConversation } from "../codex-resume-home";


// `task.open` imports the window layer lazily; mocking it keeps electrobun out.
vi.mock("../window-manager", () => ({
	getWindowCount: vi.fn(() => 1),
	focusFocusedWindow: vi.fn(() => true),
	openNewWindow: vi.fn(),
}));

vi.mock("../artifact-template", () => ({
	provisionArtifactStarter: vi.fn(() => ({ dir: "/wt-container/artifact-template-v1", mode: "on" })),
}));

vi.mock("../task-pane-runs", () => ({
	PaneRunError: class PaneRunError extends Error {},
	startPaneRun: vi.fn(async () => ({ runId: "run-0123456789ab", paneId: "pane-2", backend: "native", logPath: "/tmp/x.log", command: "bun run build" })),
	readPaneRun: vi.fn(async () => ({ runId: "run-0123456789ab" })),
	paneRunListing: vi.fn(async () => ({ backend: "native", panes: [], runs: [] })),
	closePaneRun: vi.fn(async () => ({ closed: true })),
}));

const { handleRequest, getSocketPath, startSocketServer, stopSocketServer } = await import(
	"../cli-socket-server"
);

// ---- Helpers ----

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
		id: "task-abc12345-1111-2222-3333-444444444444",
		seq: 1,
		projectId: "proj-1",
		title: "Test task",
		description: "A test task",
		status: "in-progress",
		baseBranch: "main",
		worktreePath: "/tmp/wt",
		branchName: "dev3/task-test",
		groupId: null,
		variantIndex: null,
		agentId: null,
		configId: null,
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		...overrides,
	};
}

function makeRequest(method: string, params: Record<string, unknown> = {}): CliRequest {
	return { id: "req-1", method, params };
}

// ---- Tests ----

/**
 * The operations write through `updateTaskWith`/`updateProjectWith`. Run their
 * mutators against the mocked board and hand a non-empty patch to the mocked
 * `updateTask`/`updateProject`, so adapter tests can keep asserting on the patch.
 * Rules themselves are tested on a real board in `board-operations-*.test.ts`.
 */
function bridgeLockedWrites(): void {
	vi.mocked(data.updateTaskWith).mockImplementation(async (project, taskId, mutator) => {
		const current = (await data.loadTasks(project)).find((candidate) => candidate.id === taskId);
		if (!current) throw new Error(`Task not found: ${taskId}`);
		const { updates, result } = await mutator(current);
		if (Object.keys(updates).length === 0) return { task: current, result };
		const written = await data.updateTask(project, taskId, updates);
		return { task: written ?? { ...current, ...updates }, result };
	});
	vi.mocked(data.updateProjectWith).mockImplementation(async (projectId, mutator) => {
		const current = await data.getProject(projectId);
		const { updates, result } = await mutator(current);
		if (Object.keys(updates).length > 0) await data.updateProject(projectId, updates);
		return { project: { ...current, ...updates }, result };
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	bridgeLockedWrites();
	vi.mocked(isNotificationSuppressed).mockReturnValue(false);
	vi.mocked(activeNotificationSuppression).mockReturnValue([]);
	vi.mocked(isProjectSilenced).mockReturnValue(false);
	vi.mocked(moveTask).mockImplementation(async (params) => {
		const project = await data.getProject(params.projectId);
		const task = (await data.loadTasks(project)).find((candidate) => candidate.id === params.taskId);
		if (!task) throw new Error(`Task not found: ${params.taskId}`);
		const allowed = params.ifStatus?.split(",").map((value) => value.trim());
		const blocked = params.ifStatusNot?.split(",").map((value) => value.trim());
		if ((allowed && !allowed.includes(task.status)) || blocked?.includes(task.status)) return task;
		if (params.newStatus === task.status && task.customColumnId == null) return task;
		if (
			params.enforceAllowedTransition
			&& params.newStatus
			&& task.customColumnId == null
			&& !getAllowedTransitions(task.status).includes(params.newStatus)
		) {
			throw new Error(`Cannot move task from "${task.status}" to "${params.newStatus}". Allowed: ${getAllowedTransitions(task.status).join(", ")}`);
		}
		if (params.newStatus) {
			return { ...task, status: params.newStatus, customColumnId: params.customColumnId ?? null };
		}
		return {
			...task,
			status: params.customColumnId && (task.status === "completed" || task.status === "cancelled")
				? "in-progress"
				: task.status,
			customColumnId: params.customColumnId ?? null,
		};
	});
});

describe("message.send / message.schedule — the subject gate", () => {
	// The app's half of the gate. The CLI checks first, so reaching here means an
	// older `dev3` binary — and per the no-deprecation rule there is no path where
	// a subject-less message still goes through.
	beforeEach(() => {
		vi.mocked(data.loadProjects).mockResolvedValue([makeProject()]);
		vi.mocked(data.loadVirtualProjects).mockResolvedValue([]);
		vi.mocked(data.getProject).mockResolvedValue(makeProject());
		vi.mocked(data.loadTasks).mockResolvedValue([makeTask()]);
		vi.mocked(data.getTask).mockResolvedValue(makeTask());
	});

	function send(params: Record<string, unknown>) {
		return handleRequest(makeRequest("message.send", { taskId: makeTask().id, projectId: "proj-1", ...params }));
	}

	it("delivers with the subject and hands it to the send seam", async () => {
		const resp = await send({ text: "ping", subject: "CI green on main" });
		expect(resp.ok).toBe(true);
		expect(vi.mocked(sendMessageImmediately).mock.calls[0]?.[4]).toMatchObject({ subject: "CI green on main" });
	});

	it("refuses a missing, blank or over-limit subject, and never reaches the send seam", async () => {
		const missing = await send({ text: "ping" });
		expect(missing.ok).toBe(false);
		expect(missing.error).toContain("needs --subject");
		expect(missing.error).toContain("dev3 update");
		expect((await send({ text: "ping", subject: "  " })).ok).toBe(false);
		const long = await send({ text: "ping", subject: "a".repeat(81) });
		expect(long.ok).toBe(false);
		expect(long.error).toContain("too long");
		expect(sendMessageImmediately).not.toHaveBeenCalled();
	});

	it("applies the same gate to a scheduled message", async () => {
		const at = new Date(Date.now() + 60_000).toISOString();
		const bad = await handleRequest(
			makeRequest("message.schedule", { taskId: makeTask().id, projectId: "proj-1", text: "later", at }),
		);
		expect(bad.ok).toBe(false);
		expect(scheduleMessage).not.toHaveBeenCalled();

		const good = await handleRequest(
			makeRequest("message.schedule", { taskId: makeTask().id, projectId: "proj-1", text: "later", at, subject: "wake-up ping" }),
		);
		expect(good.ok).toBe(true);
		expect(vi.mocked(scheduleMessage).mock.calls[0]?.[2]).toMatchObject({ subject: "wake-up ping" });
	});
});

vi.mock("../external-senders", () => ({
	requireExternalSender: vi.fn((id: string) => {
		if (id !== "cli") throw new Error(`Unknown external sender "${id}".`);
		return { id, label: "CLI" };
	}),
}));

describe("message.send / message.sendAsSender — the sender guards", () => {
	// These keep a sender's message out of tasks.json and away from a task's own
	// identity; the CLI refuses the same shapes first, but other socket clients exist.
	beforeEach(() => {
		vi.mocked(data.loadProjects).mockResolvedValue([makeProject()]);
		vi.mocked(data.loadVirtualProjects).mockResolvedValue([]);
		vi.mocked(data.getProject).mockResolvedValue(makeProject());
		vi.mocked(data.loadTasks).mockResolvedValue([makeTask()]);
	});
	const base = () => ({ taskId: makeTask().id, projectId: "proj-1", text: "ping", subject: "s" });

	it("sends as the sender only on message.sendAsSender", async () => {
		const resp = await handleRequest(makeRequest("message.sendAsSender", { ...base(), asSender: "cli" }));
		expect(resp.ok).toBe(true);
		const [, , target, source, opts] = vi.mocked(sendMessageImmediately).mock.calls[0]!;
		expect(opts).toMatchObject({ externalSender: { id: "cli", label: "CLI" }, author: null });
		// No task source and no bound agent: it goes to the main agent, and the only
		// reply the envelope can offer is --to-sender.
		expect(target).toBeNull();
		expect(source).toBeNull();
	});

	it("refuses --agent, a plain message.send, and a task identity on a sender request, sending nothing", async () => {
		const handle = encodeAgentHandle({ paneId: "%3", sessionId: null, paneToken: "gen-1", agentProcess: "303@Mon Oct 26 09:00:00 2026" });
		const cases: Array<[string, Record<string, unknown>, string]> = [
			["message.sendAsSender", { agentHandle: handle }, "--agent"],
			["message.send", {}, "message.sendAsSender"],
			["message.sendAsSender", { sourceTaskId: makeTask().id }, "inside a task worktree"],
		];
		for (const [method, extra, error] of cases) {
			const resp = await handleRequest(makeRequest(method, { ...base(), asSender: "cli", ...extra }));
			expect(resp, error).toMatchObject({ ok: false, error: expect.stringContaining(error) });
		}
		expect(sendMessageImmediately).not.toHaveBeenCalled();
	});

	it("refuses asSender and a non-string account on plain agent.resume before resolving anything", async () => {
		const sender = await handleRequest(makeRequest("agent.resume", { taskId: makeTask().id, asSender: "cli" }));
		expect(sender).toMatchObject({ ok: false, error: expect.stringContaining("agent.resumeAsSender") });
		const account = await handleRequest(makeRequest("agent.resume", { taskId: makeTask().id, accountId: 42 }));
		expect(account).toMatchObject({ ok: false, error: expect.stringContaining("accountId must be") });
	});

	it("never queues a sender's message into tasks.json", async () => {
		const at = new Date(Date.now() + 60_000).toISOString();
		const resp = await handleRequest(makeRequest("message.schedule", { ...base(), at, asSender: "cli" }));
		expect(resp).toMatchObject({ ok: false, error: expect.stringContaining("--in or --at") });
		expect(scheduleMessage).not.toHaveBeenCalled();
	});
});

describe("message.scheduled.list / cancel — the CLI queue verbs", () => {
	const queued = (id: string, at: string, extra: Record<string, unknown> = {}) =>
		({ id, text: "wake   up\nplease", at, target: { kind: "agent" as const }, ...extra });

	it("message.schedule returns the new message's id", async () => {
		const task = makeTask({ scheduledMessages: [queued("old", "2099-01-01T00:00:00.000Z"), queued("new-id", "2099-01-02T00:00:00.000Z")] });
		vi.mocked(data.getProject).mockResolvedValue(makeProject());
		vi.mocked(data.loadTasks).mockResolvedValue([task]);
		vi.mocked(scheduleMessage).mockResolvedValueOnce(task);
		const resp = await handleRequest(makeRequest("message.schedule", {
			taskId: task.id, projectId: "proj-1", text: "later", subject: "s", at: new Date(Date.now() + 60_000).toISOString(),
		}));
		expect(resp.ok).toBe(true);
		expect(resp.data).toMatchObject({ messageId: "new-id", pending: 2 });
	});

	it("binds a self-scheduled message to the scheduling agent's pane, and another task's to that task", async () => {
		const task = makeTask();
		vi.mocked(data.getProject).mockResolvedValue(makeProject());
		vi.mocked(data.loadTasks).mockResolvedValue([task]);
		const resp = await handleRequest(makeRequest("message.schedule", {
			taskId: task.id, projectId: "proj-1", text: "later", subject: "s", at: new Date(Date.now() + 60_000).toISOString(),
			sourceTaskId: task.id, sourcePaneId: "%1", sourcePid: 4242,
		}));
		expect(resp.ok).toBe(true);
		expect(captureScheduledMessageAuthor).toHaveBeenCalledWith(expect.objectContaining({ id: task.id }), "%1", 4242, { tmuxEnv: null, envTaskId: null });
		expect(vi.mocked(scheduleMessage).mock.calls[0]?.[2]).toMatchObject({ author: { paneId: "%1", sessionId: "conv-a" } });

		// A message for ANOTHER task is addressed to that task, not to the sender's pane.
		vi.mocked(captureScheduledMessageAuthor).mockClear();
		await handleRequest(makeRequest("message.schedule", {
			taskId: task.id, projectId: "proj-1", text: "later", subject: "s", at: new Date(Date.now() + 60_000).toISOString(),
			sourceTaskId: "some-other-task", sourcePaneId: "%7",
		}));
		expect(captureScheduledMessageAuthor).not.toHaveBeenCalled();
		expect(vi.mocked(scheduleMessage).mock.calls[1]?.[2]).toMatchObject({ author: null });
	});

	const ADDRESSED = { paneId: "%3", sessionId: null, paneToken: "gen-1", agentProcess: "303@Mon Oct 26 09:00:00 2026" };

	it("binds a message scheduled with --agent to that agent, and refuses one that is already gone", async () => {
		const task = makeTask();
		vi.mocked(data.getProject).mockResolvedValue(makeProject());
		vi.mocked(data.loadTasks).mockResolvedValue([task]);
		const resp = await handleRequest(makeRequest("message.schedule", {
			taskId: task.id, projectId: "proj-1", text: "later", subject: "s", at: new Date(Date.now() + 60_000).toISOString(),
			agentHandle: encodeAgentHandle(ADDRESSED),
		}));
		expect(resp.ok).toBe(true);
		expect(resolveScheduledMessageAuthorPane).toHaveBeenCalledWith(expect.objectContaining({ id: task.id }), ADDRESSED);
		expect(vi.mocked(scheduleMessage).mock.calls[0]?.[2]).toMatchObject({ author: ADDRESSED });
		vi.mocked(scheduleMessage).mockClear();

		// An addressed agent that is already gone: refuse, queueing nothing.
		vi.mocked(resolveScheduledMessageAuthorPane).mockResolvedValueOnce({ ok: false, detail: "the addressed agent (pane %3) is no longer running in this task; not sent to another pane" });
		const gone = await handleRequest(makeRequest("message.schedule", {
			taskId: task.id, projectId: "proj-1", text: "later", subject: "s", at: new Date(Date.now() + 60_000).toISOString(),
			agentHandle: encodeAgentHandle(ADDRESSED),
		}));
		expect(gone.ok).toBe(false);
		expect(gone.error).toContain("the addressed agent (pane %3) is no longer running");
		expect(scheduleMessage).not.toHaveBeenCalled();
	});

	it("lists the queue earliest first, with sender seq and a flattened preview", async () => {
		const task = makeTask({ scheduledMessages: [
			queued("late", "2099-01-02T00:00:00.000Z", { subject: "second" }),
			queued("early", "2099-01-01T00:00:00.000Z", { source: { taskId: "peer", seq: 12 } }),
		] });
		vi.mocked(data.getProject).mockResolvedValue(makeProject());
		vi.mocked(data.loadTasks).mockResolvedValue([task]);
		const resp = await handleRequest(makeRequest("message.scheduled.list", { taskId: task.id, projectId: "proj-1" }));
		expect(resp.ok).toBe(true);
		const { messages } = resp.data as { messages: Array<Record<string, unknown>> };
		expect(messages.map((m) => m.id)).toEqual(["early", "late"]);
		expect(messages[0]).toMatchObject({ fromSeq: 12, subject: null, preview: "wake up please", target: "agent" });
		expect(messages[1]).toMatchObject({ fromSeq: null, subject: "second" });
	});

	it("cancel goes through the locked by-ref core and reports what it removed", async () => {
		const task = makeTask();
		vi.mocked(data.getProject).mockResolvedValue(makeProject());
		vi.mocked(data.loadTasks).mockResolvedValue([task]);
		vi.mocked(cancelScheduledMessageByRef).mockResolvedValueOnce({ task, message: queued("abc123", "2099-01-01T00:00:00.000Z") } as never);
		const resp = await handleRequest(makeRequest("message.scheduled.cancel", { taskId: task.id, projectId: "proj-1", messageId: "abc" }));
		expect(resp.ok).toBe(true);
		expect(cancelScheduledMessageByRef).toHaveBeenCalledWith(expect.anything(), task.id, "abc");
		expect((resp.data as { cancelled: { id: string } }).cancelled.id).toBe("abc123");
	});
});

describe("task.addLabels / task.removeLabels — merge, never replace", () => {
	const project = () => makeProject({ labels: [
		{ id: "lbl-1111-full", name: "a", color: "#000000" },
		{ id: "lbl-2222-full", name: "b", color: "#000000" },
		{ id: "lbl-3333-full", name: "c", color: "#000000" },
	] });
	function withTask(labelIds: string[]) {
		const task = makeTask({ labelIds });
		vi.mocked(data.getProject).mockResolvedValue(project());
		vi.mocked(data.loadTasks).mockResolvedValue([task]);
		vi.mocked(data.updateTaskWith).mockImplementation(async (_p, _id, mutator: any) => {
			const { updates, result } = await mutator(task);
			return { task: { ...task, ...updates }, result };
		});
		return task;
	}

	it("add keeps existing labels, resolves prefixes, and skips duplicates; remove drops only the named ones", async () => {
		withTask(["lbl-1111-full"]);
		const resp = await handleRequest(makeRequest("task.addLabels", { taskId: makeTask().id, projectId: "proj-1", labelIds: ["lbl-2222", "lbl-1111-full"] }));
		expect(resp.ok).toBe(true);
		expect((resp.data as { labelIds: string[] }).labelIds).toEqual(["lbl-1111-full", "lbl-2222-full"]);
		expect(data.updateTask).not.toHaveBeenCalled();

		withTask(["lbl-1111-full", "lbl-2222-full", "lbl-3333-full"]);
		const removed = await handleRequest(makeRequest("task.removeLabels", { taskId: makeTask().id, projectId: "proj-1", labelIds: ["lbl-2222"] }));
		expect((removed.data as { labelIds: string[] }).labelIds).toEqual(["lbl-1111-full", "lbl-3333-full"]);
	});

	// Two spellings of one label in a single call used to append it twice, and a
	// repeated id in task.labelIds is as permanent as a dangling one.
	it("add and set write one entry when the same label is named twice", async () => {
		for (const method of ["task.addLabels", "task.setLabels"]) {
			withTask([]);
			const resp = await handleRequest(makeRequest(method, { taskId: makeTask().id, projectId: "proj-1", labelIds: ["lbl-1111", "lbl-1111-full"] }));
			expect((resp.data as { labelIds: string[] }).labelIds, method).toEqual(["lbl-1111-full"]);
		}
	});

	it("an unknown label id fails the whole call without writing", async () => {
		withTask(["lbl-1111-full"]);
		const resp = await handleRequest(makeRequest("task.addLabels", { taskId: makeTask().id, projectId: "proj-1", labelIds: ["nope"] }));
		expect(resp.ok).toBe(false);
		expect(resp.error).toContain("Label not found: nope");
		expect(data.updateTaskWith).not.toHaveBeenCalled();
	});
});

describe("remote.accessUrl", () => {
	it("errors while no remote-access server is bound, and returns a fresh access URL once it runs", async () => {
		{
			vi.mocked(getServerPort).mockReturnValue(0);
			const resp = await handleRequest(makeRequest("remote.accessUrl"));
			expect(resp.ok).toBe(false);
			expect(resp.error).toContain("not running");
		}
		vi.clearAllMocks();
		{
			vi.mocked(getServerPort).mockReturnValue(41234);
			const resp = await handleRequest(makeRequest("remote.accessUrl"));
			expect(resp.ok).toBe(true);
			expect(resp.data).toMatchObject({
				url: "http://10.0.0.5:41234/?token=fresh",
				port: 41234,
				tunnelUrl: null,
				staticCode: null,
				signInLink: null,
			});
		}
	});
});


/**
 * `dev3 pane` is only real if the CLI's method names are actually registered here.
 * A green module with no wire to it is the failure mode this block exists to stop.
 */
describe("pane.* — the CLI's own pane surface", () => {
	beforeEach(() => {
		vi.mocked(data.loadProjects).mockResolvedValue([makeProject()]);
		vi.mocked(data.getProject).mockResolvedValue(makeProject());
		vi.mocked(data.loadTasks).mockResolvedValue([makeTask()]);
	});

	it("runs a command in a neighbouring pane in the task's worktree; reads an unknown or legacy placement as auto", async () => {
		{
			const resp = await handleRequest(
				makeRequest("pane.run", { taskId: makeTask().id, command: "bun run build", placement: "below", label: "Build" }),
			);
			expect(resp.ok).toBe(true);
			expect(vi.mocked(startPaneRun).mock.calls[0][0]).toMatchObject({
				command: "bun run build",
				placement: "below",
				label: "Build",
				cwd: "/tmp/wt",
			});
			expect(resp.data).toMatchObject({ runId: "run-0123456789ab" });
		}
		vi.clearAllMocks();
		{
			await handleRequest(makeRequest("pane.run", { taskId: makeTask().id, command: "ls", placement: "sideways" }));
			await handleRequest(makeRequest("pane.run", { taskId: makeTask().id, command: "ls", placement: "right", selfPaneId: "%3" }));
			expect(vi.mocked(startPaneRun).mock.calls[0][0]).toMatchObject({ placement: "auto", selfPaneId: null });
			expect(vi.mocked(startPaneRun).mock.calls[1][0]).toMatchObject({ placement: "auto", selfPaneId: "%3" });
		}
	});

	it("refuses a task with no worktree, or one that is gone, before starting anything (no $HOME fallback)", async () => {
		const guard = await import("../task-workspace-guard");
		vi.mocked(guard.assertTaskWorkspacePresent).mockImplementationOnce((_project, path) => {
			throw new guard.TaskWorkspaceUnavailableError("missing", String(path));
		});
		const gone = await handleRequest(makeRequest("pane.run", { taskId: makeTask().id, command: "ls" }));
		expect(gone.ok).toBe(false);
		expect(gone.error).toContain("worktree is missing");
		vi.mocked(data.loadTasks).mockResolvedValue([makeTask({ worktreePath: "" })]);
		const none = await handleRequest(makeRequest("pane.run", { taskId: makeTask().id, command: "ls" }));
		expect(none.ok).toBe(false);
		expect(none.error).toContain("no worktree");
		expect(startPaneRun).not.toHaveBeenCalled();
	});

	it("reads, lists and closes runs of that task", async () => {
		expect((await handleRequest(makeRequest("pane.logs", { taskId: makeTask().id, runId: "run-0123456789ab", lines: 50 }))).ok).toBe(true);
		expect(vi.mocked(readPaneRun).mock.calls[0].slice(1)).toEqual(["run-0123456789ab", 50]);

		expect((await handleRequest(makeRequest("pane.list", { taskId: makeTask().id, selfPaneId: "pane-1" }))).ok).toBe(true);
		expect(vi.mocked(paneRunListing).mock.calls[0][1]).toBe("pane-1");
		// Every listing is annotated with the agent panes and their handles.
		expect(withAgentPanes).toHaveBeenCalledWith(expect.objectContaining({ id: makeTask().id }), await vi.mocked(paneRunListing).mock.results[0]?.value);

		expect((await handleRequest(makeRequest("pane.close", { taskId: makeTask().id, runId: "run-0123456789ab" }))).ok).toBe(true);
		expect(vi.mocked(closePaneRun).mock.calls[0][1]).toBe("run-0123456789ab");
	});
});

describe("agent.spawn account boundary", () => {
	it("rejects a socket-supplied account override, even an empty or null one", async () => {
		for (const accountId of ["account-b", "", null]) {
			const resp = await handleRequest(makeRequest("agent.spawn", {
				taskId: "test-task", agentId: "builtin-codex", configId: "codex-default", accountId,
			}));
			expect(resp, String(accountId)).toMatchObject({ ok: false, error: expect.stringContaining("Account selection is not supported") });
		}
	});
});

describe("handleRequest dispatch", () => {
	it("returns error for unknown method", async () => {
		const resp = await handleRequest(makeRequest("unknown.method"));
		expect(resp.ok).toBe(false);
		expect(resp.error).toContain("Unknown method");
		expect(resp.id).toBe("req-1");
	});

	it("refuses a request missing a required parameter, naming it", async () => {
		const cases: Array<[string, Record<string, unknown>, string]> = [
			["tasks.list", {}, "projectId is required"],
			["task.show", {}, "taskId is required"],
			["task.create", { title: "New" }, "projectId is required"],
			["task.create", { projectId: "proj-1" }, "title is required"],
			["task.update", {}, "taskId is required"],
			["task.move", { newStatus: "todo" }, "taskId is required"],
			["task.move", { taskId: "t1" }, "newStatus is required"],
			["note.add", { content: "hi" }, "taskId is required"],
			["note.add", { taskId: "t1" }, "content is required"],
			["note.list", {}, "taskId is required"],
			["note.delete", { noteId: "n1" }, "taskId is required"],
			["note.delete", { taskId: "t1" }, "noteId is required"],
			["label.list", {}, "projectId is required"],
			["label.create", { name: "bug" }, "projectId is required"],
			["label.create", { projectId: "proj-1" }, "name is required"],
			["label.delete", { labelId: "lbl-1" }, "projectId is required"],
			["label.delete", { projectId: "proj-1" }, "labelId is required"],
			["task.setLabels", { projectId: "proj-1", labelIds: [] }, "taskId is required"],
			["task.setLabels", { taskId: "t1", labelIds: [] }, "projectId is required"],
			["task.setLabels", { taskId: "t1", projectId: "proj-1", labelIds: "not-array" }, "labelIds must be an array"],
			["pane.list", {}, "taskId is required"],
		];
		for (const [method, params, error] of cases) {
			const resp = await handleRequest(makeRequest(method, params));
			expect(resp, `${method} ${JSON.stringify(params)}`).toMatchObject({ ok: false, error: expect.stringContaining(error) });
		}
	});

	it("turns an Error or a non-Error throw from a handler into an error response", async () => {
		vi.mocked(data.loadProjects).mockRejectedValueOnce(new Error("DB failed"));
		expect(await handleRequest(makeRequest("projects.list"))).toMatchObject({ ok: false, error: "DB failed" });
		vi.mocked(data.loadProjects).mockRejectedValueOnce("string error");
		expect(await handleRequest(makeRequest("projects.list"))).toMatchObject({ ok: false, error: "string error" });
	});
});

describe("task.agentHook", () => {
	function mockAtomicHookUpdate(project: Project, initialTask: Task): void {
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.loadTasks).mockResolvedValue([initialTask]);
		vi.mocked(data.updateTaskWith).mockImplementation(async (_project, _taskId, mutator: any) => {
			const { updates, result } = await mutator(initialTask);
			return { task: { ...initialTask, ...updates }, result };
		});
	}

	it.each([
		["request_user_input", "in-progress"], ["request_user_input_async", "in-progress"],
		["request_user_input", "review-by-ai"], ["request_user_input_async", "review-by-ai"],
	] as const)(
		"keeps %s questions visible from %s across unrelated tools and Stop", async (toolName, initialStatus) => {
			const project = makeProject({ autoReviewEnabled: true });
			let storedTask = makeTask({ status: initialStatus });
			vi.mocked(data.getProject).mockResolvedValue(project);
			vi.mocked(data.loadTasks).mockImplementation(async () => [storedTask]);
			vi.mocked(data.updateTaskWith).mockImplementation(async (_project, _taskId, mutator: any) => {
				const { updates, result } = await mutator(storedTask);
				storedTask = { ...storedTask, ...updates };
				return { task: storedTask, result };
			});
			const hook = async (event: string, name?: string) => {
				const response = await handleRequest(makeRequest("task.agentHook", {
					taskId: storedTask.id, projectId: project.id, sessionId: `questions-${toolName}-${initialStatus}`,
					event, toolName: name, toolUseId: "question-1",
				}));
				expect(response.ok).toBe(true);
				storedTask = response.data as Task;
			};
			await hook(toolName === "request_user_input" ? "PreToolUse" : "PostToolUse", toolName);
			expect(storedTask.status).toBe("user-questions");
			await hook("PreToolUse", "Bash");
			await hook("PostToolUse", "Bash");
			expect(storedTask.status).toBe("user-questions");
			if (toolName === "request_user_input_async") {
				await hook("Stop");
				expect(storedTask.status).toBe("user-questions");
				await hook("UserPromptSubmit");
			} else {
				await hook("PostToolUse", toolName);
			}
			expect(storedTask.status).toBe(initialStatus);
			await hook("Stop");
			expect(storedTask.status).toBe(initialStatus === "review-by-ai" ? "review-by-user" : "review-by-ai");
		},
	);

	it("gates an omp pane until the extension marks the approval's end; frees an agy pane on its own approval's end", async () => {
		{
			const project = makeProject();
			const task = makeTask({ status: "in-progress" });
			mockAtomicHookUpdate(project, task);
			const hook = (event: string, extra: Record<string, unknown> = {}) => handleRequest(makeRequest("task.agentHook", {
				taskId: task.id, projectId: project.id, harness: "omp", paneId: "%7", event, ...extra,
			}));
			try {
				await hook("PermissionRequest");
				expect(agentPromptLedger.isPromptOpen(task.id, "%7")).toBe(true);
				await hook("PostToolUse");
				expect(agentPromptLedger.isPromptOpen(task.id, "%7")).toBe(true);
				await hook("PostToolUse", { promptEnd: true });
				expect(agentPromptLedger.isPromptOpen(task.id, "%7")).toBe(false);
			} finally {
				agentPromptLedger.reset();
			}
		}
		vi.clearAllMocks();
		{
			const project = makeProject();
			const task = makeTask({ status: "in-progress" });
			mockAtomicHookUpdate(project, task);
			const hook = (paneId: string, event: string) => handleRequest(makeRequest("task.agentHook", {
				taskId: task.id, projectId: project.id, harness: "agy", paneId, event,
			}));
			try {
				await hook("%7", "PermissionRequest");
				await hook("%8", "PermissionRequest");
				await hook("%7", "PostToolUse");
				expect(agentPromptLedger.isPromptOpen(task.id, "%7")).toBe(false);
				expect(agentPromptLedger.isPromptOpen(task.id, "%8")).toBe(true);
			} finally {
				agentPromptLedger.reset();
			}
		}
	});

	it("answers a session-less Codex async question whether or not its hooks name the pane", async () => {
		const project = makeProject();
		let storedTask = makeTask({ status: "in-progress" });
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.loadTasks).mockImplementation(async () => [storedTask]);
		vi.mocked(data.updateTaskWith).mockImplementation(async (_project, _taskId, mutator: any) => {
			const { updates, result } = await mutator(storedTask);
			storedTask = { ...storedTask, ...updates };
			return { task: storedTask, result };
		});
		const hook = async (params: Record<string, unknown>) => {
			const response = await handleRequest(makeRequest("task.agentHook", { taskId: storedTask.id, projectId: project.id, ...params }));
			expect(response.ok).toBe(true);
			storedTask = response.data as Task;
		};
		try {
			await hook({ event: "PostToolUse", toolName: "request_user_input_async", toolUseId: "q1", paneId: "%3" });
			expect(storedTask.status).toBe("user-questions");
			await hook({ event: "UserPromptSubmit" });
			expect(storedTask.status).toBe("in-progress");
		} finally {
			agentPromptLedger.reset();
		}
	});

	it("parks a Codex Stop that waits on an approval reply in user-questions, names the reply, and raises exactly one badge", async () => {
		const project = makeProject();
		const task = makeTask({ status: "in-progress" });
		mockAtomicHookUpdate(project, task);
		const push = vi.fn();
		vi.mocked(getPushMessage).mockReturnValue(push);

		const response = await handleRequest(makeRequest("task.agentHook", {
			taskId: task.id, projectId: project.id, sessionId: "approval-hold", event: "Stop", approvalHold: "Approved 0123456789ab",
		}));

		expect((response.data as Task).status).toBe("user-questions");
		expect(notifyFromCliDesktop).toHaveBeenCalledWith(expect.objectContaining({ body: expect.stringContaining("Approved 0123456789ab") }));
		// The move leaves the badge to the hold's own reason.
		expect(moveTask).toHaveBeenCalledWith(expect.objectContaining({ newStatus: "user-questions", skipQuestionsBadge: true }));
		expect(push.mock.calls.filter(([name]) => name === "cliAttention")).toHaveLength(1);
	});

	it("leaves the badge to the lifecycle machine for a plain permission request", async () => {
		const project = makeProject();
		const task = makeTask({ status: "in-progress" });
		mockAtomicHookUpdate(project, task);

		await handleRequest(makeRequest("task.agentHook", {
			taskId: task.id, projectId: project.id, sessionId: "plain-permission", event: "PermissionRequest",
		}));

		expect(moveTask).toHaveBeenCalledWith(expect.objectContaining({ newStatus: "user-questions", skipQuestionsBadge: false }));
	});

	it("never reopens a finished task for a late approval-hold Stop, but still badges one already in user-questions", async () => {
		{
			const project = makeProject();
			const task = makeTask({ status: "completed" });
			mockAtomicHookUpdate(project, task);

			const response = await handleRequest(makeRequest("task.agentHook", {
				taskId: task.id, projectId: project.id, sessionId: "late-hold", event: "Stop", approvalHold: "Approved 0123456789ab",
			}));

			expect((response.data as Task).status).toBe("completed");
			expect(notifyFromCliDesktop).not.toHaveBeenCalled();
		}
		vi.clearAllMocks();
		{
			const project = makeProject();
			const task = makeTask({ status: "user-questions" });
			mockAtomicHookUpdate(project, task);

			await handleRequest(makeRequest("task.agentHook", {
				taskId: task.id, projectId: project.id, sessionId: "parked-hold", event: "Stop", approvalHold: "Approved 0123456789ab",
			}));

			expect(notifyFromCliDesktop).toHaveBeenCalledWith(expect.objectContaining({ body: expect.stringContaining("Approved 0123456789ab") }));
		}
	});

	it("returns a reviewer parked on an approval hold to review-by-ai on its next prompt", async () => {
		const project = makeProject({ autoReviewEnabled: true });
		let task = makeTask({ status: "review-by-ai" });
		mockAtomicHookUpdate(project, task);
		const params = { taskId: task.id, projectId: project.id, sessionId: "review-hold" };

		task = (await handleRequest(makeRequest("task.agentHook", { ...params, event: "Stop", approvalHold: "Approved 0123456789ab" }))).data as Task;
		expect(task.status).toBe("user-questions");
		mockAtomicHookUpdate(project, task);
		task = (await handleRequest(makeRequest("task.agentHook", { ...params, event: "UserPromptSubmit" }))).data as Task;
		expect(task.status).toBe("review-by-ai");
	});

	describe("a Codex turn that ends on an API error", () => {
		const ERROR = "unexpected status 403 Forbidden: This reasoning level isn't available for the selected model.";

		async function armAndFail(sessionId: string, interactive = true): Promise<Task> {
			const project = makeProject();
			const task = makeTask({ status: "in-progress" });
			mockAtomicHookUpdate(project, task);
			await handleRequest(makeRequest("task.agentHook", {
				taskId: task.id, projectId: project.id, sessionId, event: "UserPromptSubmit", transcriptPath: `/tmp/rollout-${sessionId}.jsonl`,
			}));
			const calls = vi.mocked(codexTurnWatches.observe).mock.calls;
			const [input, onFailure] = calls[calls.length - 1]!;
			expect(input).toMatchObject({ taskId: task.id, sessionId, transcriptPath: `/tmp/rollout-${sessionId}.jsonl` });
			vi.mocked(isInteractiveCodexConversation).mockResolvedValueOnce(interactive);
			await onFailure({ ...input, message: ERROR });
			return task;
		}

		it("does not watch a transcript that is not the session's own rollout", async () => {
			const project = makeProject();
			const task = makeTask({ status: "in-progress" });
			mockAtomicHookUpdate(project, task);
			vi.mocked(codexTurnWatches.observe).mockClear();
			await handleRequest(makeRequest("task.agentHook", {
				taskId: task.id, projectId: project.id, sessionId: "own-session", event: "UserPromptSubmit", transcriptPath: "/etc/hosts",
			}));
			expect(codexTurnWatches.observe).not.toHaveBeenCalled();
		});

		it("parks the task in user-questions and names the error", async () => {
			const task = await armAndFail("errored-turn");
			expect(moveTask).toHaveBeenCalledWith(expect.objectContaining({ taskId: task.id, newStatus: "user-questions", skipQuestionsBadge: true }));
			expect(notifyFromCliDesktop).toHaveBeenCalledWith(expect.objectContaining({ body: expect.stringContaining("403 Forbidden") }));
		});

		it("ignores a failed turn from a subagent or codex exec session", async () => {
			await armAndFail("subagent-turn", false);
			expect(moveTask).not.toHaveBeenCalledWith(expect.objectContaining({ newStatus: "user-questions" }));
			expect(notifyFromCliDesktop).not.toHaveBeenCalled();
		});

		it("ends the watch when the turn stops normally", async () => {
			const project = makeProject();
			const task = makeTask({ status: "in-progress" });
			mockAtomicHookUpdate(project, task);
			await handleRequest(makeRequest("task.agentHook", { taskId: task.id, projectId: project.id, sessionId: "clean-turn", event: "Stop" }));
			expect(codexTurnWatches.endTurn).toHaveBeenCalledWith(task.id, "clean-turn");
		});
	});

	it("releases a blocking question on Interrupt and on SessionEnd", async () => {
		for (const event of ["Interrupt", "SessionEnd"]) {
			const project = makeProject();
			let task = makeTask({ status: "in-progress" });
			mockAtomicHookUpdate(project, task);
			const params = { taskId: task.id, projectId: project.id, sessionId: `cancel-${event}` };
			const question = await handleRequest(makeRequest("task.agentHook", {
				...params, event: "PreToolUse", toolName: "request_user_input", toolUseId: "q",
			}));
			task = question.data as Task;
			expect(task.status, event).toBe("user-questions");
			mockAtomicHookUpdate(project, task);
			const cancelled = await handleRequest(makeRequest("task.agentHook", { ...params, event }));
			expect((cancelled.data as Task).status, event).toBe("review-by-user");
		}
	});

	it("logs hook order and status decisions without question or answer content", async () => {
		const project = makeProject();
		const task = makeTask({ status: "in-progress" });
		mockAtomicHookUpdate(project, task);
		await handleRequest(makeRequest("task.agentHook", {
			taskId: task.id, projectId: project.id, sessionId: "log-test",
			event: "PostToolUse", toolName: "request_user_input_async", toolUseId: "q",
			questionIds: ["fingerprint"], prompt: "private answer", toolInput: "private question",
		}));
		expect(hookInfo).toHaveBeenCalledWith("Codex lifecycle hook", {
			taskId: task.id, harness: "codex", sessionId: "log-test", event: "PostToolUse",
			toolName: "request_user_input_async", toolUseId: "q", pendingQuestions: true,
			previousStatus: "in-progress", targetStatus: "user-questions",
			actualStatus: "user-questions", moveAccepted: true,
		});
		expect(JSON.stringify(hookInfo.mock.calls)).not.toContain("private");
		mockAtomicHookUpdate(project, makeTask({ status: "user-questions" }));
		await handleRequest(makeRequest("task.agentHook", {
			taskId: task.id, projectId: project.id, sessionId: "log-test", event: "SessionEnd",
		}));
	});

	it("replays installed Codex 0.154 hooks and preserves Has Questions at Stop", async () => {
		const project = makeProject({ autoReviewEnabled: true });
		let task = makeTask({ status: "in-progress" });
		const observed: string[] = [];
		for (const event of codexQuestionHookTrace) {
			mockAtomicHookUpdate(project, task);
			const response = await handleRequest(makeRequest("task.agentHook", {
				...event, taskId: task.id, projectId: project.id, sessionId: "codex-live-trace",
			}));
			expect(response.ok).toBe(true);
			task = response.data as Task;
			observed.push(task.status);
		}
		expect(observed).toEqual(["in-progress", "in-progress", "in-progress", "user-questions", "user-questions"]);
		mockAtomicHookUpdate(project, task);
		await handleRequest(makeRequest("task.agentHook", {
			taskId: task.id, projectId: project.id, sessionId: "codex-live-trace", event: "SessionEnd",
		}));
	});

	it("maps each plain lifecycle event to its column", async () => {
		const cases: Array<[event: string, from: Task["status"], autoReview: boolean, to: Task["status"]]> = [
			["UserPromptSubmit", "review-by-user", false, "in-progress"],
			["PermissionRequest", "in-progress", false, "user-questions"],
			["PostToolUse", "user-questions", false, "in-progress"],
			["Stop", "in-progress", false, "review-by-user"],
			["Stop", "in-progress", true, "review-by-ai"],
			["Stop", "review-by-ai", true, "review-by-user"],
			["Stop", "user-questions", true, "user-questions"],
		];
		for (const [event, from, autoReviewEnabled, to] of cases) {
			const project = makeProject({ autoReviewEnabled });
			const task = makeTask({ status: from });
			mockAtomicHookUpdate(project, task);
			const response = await handleRequest(makeRequest("task.agentHook", { taskId: task.id, projectId: project.id, event }));
			expect((response.data as Task).status, `${event} from ${from}, autoReview=${autoReviewEnabled}`).toBe(to);
		}
		// The automatic-review Stop goes through moveTask's guarded move.
		expect(moveTask).toHaveBeenCalledWith(expect.objectContaining({ newStatus: "review-by-ai", ifStatus: "in-progress,user-questions" }));
	});

	it("restores review-by-ai after a review agent approval finishes", async () => {
		const project = makeProject({ autoReviewEnabled: true });
		let storedTask = makeTask({ status: "review-by-ai" });
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.loadTasks).mockImplementation(async () => [storedTask]);
		vi.mocked(data.updateTaskWith).mockImplementation(async (_project, _taskId, mutator: any) => {
			const { updates, result } = await mutator(storedTask);
			storedTask = { ...storedTask, ...updates };
			return { task: storedTask, result };
		});

		await handleRequest(makeRequest("task.agentHook", {
			taskId: storedTask.id,
			projectId: project.id,
			event: "PermissionRequest",
			sessionId: "review-session",
		}));
		const response = await handleRequest(makeRequest("task.agentHook", {
			taskId: storedTask.id,
			projectId: project.id,
			event: "PostToolUse",
			sessionId: "review-session",
		}));

		expect((response.data as Task).status).toBe("review-by-ai");
	});

	it("remembers the reported session id, so a shared folder can tell this task's transcripts apart", async () => {
		const project = makeProject({ autoReviewEnabled: false });
		const task = makeTask({ status: "in-progress" });
		mockAtomicHookUpdate(project, task);

		await handleRequest(makeRequest("task.agentHook", {
			taskId: task.id,
			projectId: project.id,
			event: "PostToolUse",
			sessionId: "11111111-1111-4111-8111-111111111111",
		}));

		expect(rememberTaskSession).toHaveBeenCalledWith(
			expect.objectContaining({ id: project.id }),
			expect.objectContaining({ id: task.id }),
			"11111111-1111-4111-8111-111111111111",
		);
	});

	// #2127: a coordinator, an audit and a PR review have no diff of their own to review.
	it("keeps coordinator, pr-review and board-cleanup tasks out of automatic AI review on Stop", async () => {
		for (const taskType of ["coordinator", "pr-review", "board-cleanup"] as const) {
			const project = makeProject({ autoReviewEnabled: true });
			const task = makeTask({ status: "in-progress", taskType });
			mockAtomicHookUpdate(project, task);
			const response = await handleRequest(makeRequest("task.agentHook", { taskId: task.id, projectId: project.id, event: "Stop" }));
			expect((response.data as Task).status, taskType).toBe("review-by-user");
		}
	});

	it("rejects unknown lifecycle events", async () => {
		const project = makeProject();
		const task = makeTask();
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.loadTasks).mockResolvedValue([task]);

		const response = await handleRequest(makeRequest("task.agentHook", {
			taskId: task.id,
			projectId: project.id,
			event: "FutureEvent",
		}));

		expect(response.error).toContain("Unsupported status hook event");
	});
});

// B1 (Seq 2003 review): no hook path may start a To Do card again — a hook from an
// agent that outlived a reset would otherwise launch a fresh, unconsented run.
describe("hooks never activate a To Do task", () => {
	function stubTodo(): { project: Project; task: Task } {
		const project = makeProject();
		const task = makeTask({ status: "todo", worktreePath: null, branchName: null });
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.loadTasks).mockResolvedValue([task]);
		vi.mocked(data.updateTaskWith).mockImplementation(async (_project, _taskId, mutator: any) => {
			const { updates, result } = await mutator(task);
			return { task: { ...task, ...updates }, result };
		});
		return { project, task };
	}

	it("no task.agentHook event, a pending question included, moves a To Do task (Codex/OMP/Copilot)", async () => {
		const events: Array<[string, string]> = [
			...["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PermissionRequest", "Stop"].map((e) => [e, "Bash"] as [string, string]),
			["PreToolUse", "request_user_input"],
		];
		for (const [event, toolName] of events) {
			const { project, task } = stubTodo();
			const response = await handleRequest(makeRequest("task.agentHook", {
				taskId: task.id, projectId: project.id, sessionId: `todo-${event}-${toolName}`, event, toolName, toolUseId: "t1",
			}));
			expect(response.ok, `${event} ${toolName}`).toBe(true);
		}
		expect(moveTask).not.toHaveBeenCalled();
		expect(activateTask).not.toHaveBeenCalled();
	});

	it("neither task.claudeStopFailure nor a task.move from the task's OWN agent (Claude hooks) moves a To Do task", async () => {
		{
			const { project, task } = stubTodo();
			const response = await handleRequest(makeRequest("task.claudeStopFailure", {
				taskId: task.id, projectId: project.id, error: "server_error",
			}));
			expect(response.ok).toBe(true);
			expect(moveTask).not.toHaveBeenCalled();
		}
		vi.clearAllMocks();
		{
			const { project, task } = stubTodo();
			const response = await handleRequest(makeRequest("task.move", {
				taskId: task.id, projectId: project.id, newStatus: "in-progress", ifStatusNot: "review-by-ai", sourceTaskId: task.id,
			}));
			expect(response.ok).toBe(true);
			expect(response.data).toEqual(task);
			expect(moveTask).not.toHaveBeenCalled();
		}
	});

	it("an explicit out-of-task task.move keeps today's start, marked explicitLaunch", async () => {
		const { project, task } = stubTodo();
		vi.mocked(moveTask).mockResolvedValue({ ...task, status: "in-progress" });
		await handleRequest(makeRequest("task.move", { taskId: task.id, projectId: project.id, newStatus: "in-progress" }));
		expect(moveTask).toHaveBeenCalledWith(expect.objectContaining({ newStatus: "in-progress", explicitLaunch: true }));
	});
});

describe("task.claudeStopFailure", () => {
	const LIMIT_MESSAGE = "You've hit your session limit · resets 3:40pm (Asia/Jerusalem)";

	function stub(project: Project, task: Task): void {
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.loadTasks).mockResolvedValue([task]);
	}

	it("parks a rate-limited turn in user-questions and names the reset time", async () => {
		const project = makeProject();
		const task = makeTask({ status: "in-progress" });
		stub(project, task);

		const response = await handleRequest(makeRequest("task.claudeStopFailure", {
			taskId: task.id,
			projectId: project.id,
			error: "rate_limit",
			lastAssistantMessage: LIMIT_MESSAGE,
		}));

		expect((response.data as { task: Task }).task.status).toBe("user-questions");
		expect(moveTask).toHaveBeenCalledWith(expect.objectContaining({ newStatus: "user-questions", skipQuestionsBadge: true }));
		expect(pushCliAttention).not.toHaveBeenCalled(); // not suppressed → pushed live
		expect(notifyFromCliDesktop).toHaveBeenCalledWith(expect.objectContaining({ body: LIMIT_MESSAGE }));
	});

	it("raises exactly one badge for a failed turn: its own reason, not the generic questions one", async () => {
		const project = makeProject();
		const task = makeTask({ status: "in-progress" });
		stub(project, task);
		const push = vi.fn();
		vi.mocked(getPushMessage).mockReturnValue(push);

		await handleRequest(makeRequest("task.claudeStopFailure", { taskId: task.id, projectId: project.id, error: "server_error" }));

		const badges = push.mock.calls.filter(([name]) => name === "cliAttention");
		expect(badges).toHaveLength(1);
		expect(badges[0]![1]).not.toHaveProperty("kind");
	});

	it("still badges a task already in user-questions, and leaves a finished task alone", async () => {
		{
			const project = makeProject();
			const task = makeTask({ status: "user-questions" });
			stub(project, task);

			await handleRequest(makeRequest("task.claudeStopFailure", {
				taskId: task.id,
				projectId: project.id,
				error: "server_error",
			}));

			expect(moveTask).not.toHaveBeenCalled();
			expect(notifyFromCliDesktop).toHaveBeenCalled();
		}
		vi.clearAllMocks();
		{
			const project = makeProject();
			const task = makeTask({ status: "completed" });
			stub(project, task);

			const response = await handleRequest(makeRequest("task.claudeStopFailure", {
				taskId: task.id,
				projectId: project.id,
				error: "rate_limit",
			}));

			expect((response.data as { moved: boolean }).moved).toBe(false);
			expect(moveTask).not.toHaveBeenCalled();
			expect(notifyFromCliDesktop).not.toHaveBeenCalled();
		}
	});

	it("queues the badge under focus mode instead of dropping it", async () => {
		vi.mocked(isNotificationSuppressed).mockReturnValue(true);
		const project = makeProject();
		const task = makeTask({ status: "in-progress" });
		stub(project, task);

		await handleRequest(makeRequest("task.claudeStopFailure", {
			taskId: task.id,
			projectId: project.id,
			error: "rate_limit",
		}));

		expect(pushCliAttention).toHaveBeenCalledWith({
			taskId: task.id,
			projectId: task.projectId,
			reason: "Usage limit reached — the agent stopped mid-task",
		});
	});
});

describe("projects.list", () => {

	it("merges virtual (Operations) boards into the list", async () => {
		const git = makeProject({ id: "p1" });
		const ops = makeProject({ id: "ops", kind: "virtual", builtin: true });
		vi.mocked(data.loadProjects).mockResolvedValue([git]);
		vi.mocked(data.loadVirtualProjects).mockResolvedValue([ops]);

		const resp = await handleRequest(makeRequest("projects.list"));
		expect(resp.ok).toBe(true);
		expect(resp.data).toEqual([git, ops]);
	});
});

describe("projects.add / projects.clone / spaces.*", () => {
	it("hands projects.add its flags (dropping non-string lists) and projects.clone its URL, folder and name", async () => {
		{
			const { registerProject } = await import("../project-registration");

			const resp = await handleRequest(makeRequest("projects.add", {
				path: "/repos/app", init: true, spaces: ["Work / Side", 7], newSpaces: "not-a-list", noSpace: "yes",
			}));

			expect(resp.ok).toBe(true);
			expect(registerProject).toHaveBeenCalledWith({
				path: "/repos/app", name: undefined, init: true, spaces: ["Work / Side"], newSpaces: [], noSpace: false,
			});
		}
		vi.clearAllMocks();
		{
			const { cloneProject } = await import("../project-registration");

			await handleRequest(makeRequest("projects.clone", { url: "https://example.com/g/r.git", dir: "/clones", name: "r" }));

			expect(cloneProject).toHaveBeenCalledWith({
				url: "https://example.com/g/r.git", dir: "/clones", name: "r", spaces: [], newSpaces: [], noSpace: false,
			});
		}
	});

	it("rejects an unknown spaces.change mode and a missing project, and routes spaces.change and spaces.create", async () => {
		{
			const bad = await handleRequest(makeRequest("spaces.change", { projectId: "p1", mode: "move", spaces: [] }));
			expect(bad.ok).toBe(false);
			expect(bad.error).toContain("Invalid mode");

			const noProject = await handleRequest(makeRequest("spaces.change", { mode: "add", spaces: ["A"] }));
			expect(noProject.ok).toBe(false);
			expect(noProject.error).toContain("projectId is required");
		}
		vi.clearAllMocks();
		{
			const { changeProjectSpaces, createSpaceWith } = await import("../project-registration");

			await handleRequest(makeRequest("spaces.change", { projectId: "p1", mode: "remove", spaces: ["A"] }));
			await handleRequest(makeRequest("spaces.create", { name: "Side", projectIds: ["p1"] }));

			expect(changeProjectSpaces).toHaveBeenCalledWith({ projectId: "p1", mode: "remove", spaces: ["A"] });
			expect(createSpaceWith).toHaveBeenCalledWith({ name: "Side", projectIds: ["p1"] });
		}
	});
});

describe("tasks.list", () => {

	it("returns a project's tasks, filters by status, and rejects an unknown status", async () => {
		const tasks = [
			makeTask({ id: "t1", status: "todo" }),
			makeTask({ id: "t2", status: "in-progress" }),
		];
		vi.mocked(data.getProject).mockResolvedValue(makeProject());
		vi.mocked(data.loadTasks).mockResolvedValue(tasks);

		const all = await handleRequest(makeRequest("tasks.list", { projectId: "proj-1" }));
		expect(all.data).toEqual(tasks);
		const todo = await handleRequest(makeRequest("tasks.list", { projectId: "proj-1", status: "todo" }));
		expect(todo.data).toEqual([tasks[0]]);
		const bogus = await handleRequest(makeRequest("tasks.list", { projectId: "proj-1", status: "bogus" }));
		expect(bogus.ok).toBe(false);
		expect(bogus.error).toContain("Invalid status: bogus");
	});
});

describe("task.update — priority", () => {
	it("rejects a garbage priority on update and on create, and an update with nothing to change", async () => {
		const project = makeProject();
		const task = makeTask();
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.loadTasks).mockResolvedValue([task]);

		const update = await handleRequest(
			makeRequest("task.update", { taskId: "task-abc12345", projectId: "proj-1", priority: "urgent" }),
		);
		expect(update.ok).toBe(false);
		expect(update.error).toContain("Invalid priority");
		expect(data.setTaskPriority).not.toHaveBeenCalled();
		const create = await handleRequest(makeRequest("task.create", { projectId: "proj-1", title: "X", priority: "P9" }));
		expect(create.ok).toBe(false);
		expect(create.error).toContain("Invalid priority");
		const nothing = await handleRequest(makeRequest("task.update", { taskId: "task-abc12345", projectId: "proj-1" }));
		expect(nothing.ok).toBe(false);
		expect(nothing.error).toContain("Nothing to update");
	});

	it("accepts a case-insensitive priority and writes it to this task", async () => {
		const project = makeProject();
		const task = makeTask();
		const changed = [makeTask({ priority: "P0" })];
		const pushFn = vi.fn();
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.loadTasks).mockResolvedValue([task]);
		vi.mocked(data.setTaskPriority).mockResolvedValue(changed);
		vi.mocked(getPushMessage).mockReturnValue(pushFn);

		const resp = await handleRequest(
			makeRequest("task.update", { taskId: "task-abc12345", projectId: "proj-1", priority: "p0" }),
		);
		expect(resp.ok).toBe(true);
		expect(data.setTaskPriority).toHaveBeenCalledWith(project, task.id, "P0");
		expect(pushFn).toHaveBeenCalledTimes(1);
		expect((resp.data as { task: Task }).task.priority).toBe("P0");
	});
});

describe("task.update / task.create: start after", () => {
	const project = makeProject();
	const prereq = makeTask({ id: "prereq-11111111", seq: 12, status: "in-progress" });
	const waiting = makeTask({ id: "waiting-22222222", seq: 13, status: "todo", worktreePath: null, branchName: null });

	beforeEach(() => {
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.updateTask).mockImplementation(async (_p, _id, updates) => ({ ...waiting, ...updates }) as Task);
		vi.mocked(getPushMessage).mockReturnValue(vi.fn());
	});

	it("arms the condition from a person at a terminal, with no agent recorded", async () => {
		vi.mocked(data.loadTasks).mockResolvedValue([prereq, waiting]);
		const resp = await handleRequest(makeRequest("task.update", { taskId: "seq:13", projectId: "proj-1", startAfter: "seq:12", until: "merged" }));
		expect(resp.ok).toBe(true);
		const patch = vi.mocked(data.updateTask).mock.calls[0]![2] as Partial<Task>;
		expect(patch.launchAfter).toMatchObject({ taskId: prereq.id, seq: 12, until: "merged" });
		expect(patch.launchAfter?.armedBy).toBeUndefined();
	});

	it("records the arming agent when run from inside another task", async () => {
		const coordinator = makeTask({ id: "coord-33333333", seq: 5, status: "in-progress" });
		vi.mocked(data.loadTasks).mockResolvedValue([prereq, waiting, coordinator]);
		vi.mocked(data.loadProjects).mockResolvedValue([project]);
		const resp = await handleRequest(makeRequest("task.update", { taskId: "seq:13", projectId: "proj-1", startAfter: "seq:12", sourceTaskId: coordinator.id }));
		expect(resp.ok).toBe(true);
		const patch = vi.mocked(data.updateTask).mock.calls[0]![2] as Partial<Task>;
		expect(patch.launchAfter).toMatchObject({ until: "completed", armedBy: { taskId: coordinator.id, seq: 5 } });
	});

	it("refuses a cycle and writes nothing", async () => {
		const prereqWaits = { ...prereq, status: "todo" as const, launchAfter: { taskId: waiting.id, seq: 13, until: "completed" as const, armedAt: "x" } };
		vi.mocked(data.loadTasks).mockResolvedValue([prereqWaits, waiting]);
		const resp = await handleRequest(makeRequest("task.update", { taskId: "seq:13", projectId: "proj-1", startAfter: "seq:12" }));
		expect(resp.ok).toBe(false);
		expect(resp.error).toContain("never start");

		vi.mocked(data.loadTasks).mockResolvedValue([prereq, waiting]);
		const until = await handleRequest(makeRequest("task.update", { taskId: "seq:13", projectId: "proj-1", startAfter: "seq:12", until: "soon" }));
		expect(until.ok).toBe(false);
		expect(until.error).toContain("--until must be one of completed, merged");
		expect(data.updateTask).not.toHaveBeenCalled();
	});

	it("clears it with noStartAfter", async () => {
		const armed = { ...waiting, launchAfter: { taskId: prereq.id, seq: 12, until: "completed" as const, armedAt: "x" } };
		vi.mocked(data.loadTasks).mockResolvedValue([prereq, armed]);
		const resp = await handleRequest(makeRequest("task.update", { taskId: "seq:13", projectId: "proj-1", noStartAfter: true }));
		expect(resp.ok).toBe(true);
		expect(data.updateTask).toHaveBeenCalledWith(project, armed.id, { launchAfter: null });
	});

	it("task.create refuses a missing or cancelled prerequisite before the task exists", async () => {
		vi.mocked(data.loadTasks).mockResolvedValue([waiting]);
		const missing = await handleRequest(makeRequest("task.create", { projectId: "proj-1", title: "Next", startAfter: "seq:99" }));
		expect(missing.ok).toBe(false);
		const cancelled = { ...prereq, status: "cancelled" as const };
		vi.mocked(data.loadTasks).mockResolvedValue([cancelled, waiting]);
		vi.mocked(createTask).mockResolvedValue(waiting);
		const resp = await handleRequest(makeRequest("task.create", { projectId: "proj-1", title: "Next", startAfter: "seq:12" }));
		expect(resp.ok).toBe(false);
		expect(resp.error).toContain("cancelled");
		expect(createTask).not.toHaveBeenCalled();
		expect(deleteTask).not.toHaveBeenCalled();
	});

	it("task.create arms the condition on the new task", async () => {
		vi.mocked(data.loadTasks).mockResolvedValue([prereq]);
		vi.mocked(createTask).mockResolvedValue(waiting);
		const resp = await handleRequest(makeRequest("task.create", { projectId: "proj-1", title: "Next", startAfter: "seq:12", until: "merged" }));
		expect(resp.ok).toBe(true);
		const patch = vi.mocked(data.updateTask).mock.lastCall![2] as Partial<Task>;
		expect(patch.launchAfter).toMatchObject({ taskId: prereq.id, seq: 12, until: "merged" });
	});
});

describe("task dependencies over the socket", () => {
	const project = makeProject();
	const first = makeTask({ id: "first-11111111", seq: 12, status: "in-progress" });
	const second = makeTask({ id: "second-2222222", seq: 13, status: "todo", worktreePath: null, branchName: null });
	let saved: Partial<Task> | null;

	beforeEach(() => {
		saved = null;
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.updateTaskWith).mockImplementation(async (_p, _id, mutator) => {
			const { updates, result } = await mutator(second);
			saved = updates;
			return { task: { ...second, ...updates } as Task, result };
		});
		vi.mocked(getPushMessage).mockReturnValue(vi.fn());
	});

	it("task.update adds the links by seq", async () => {
		vi.mocked(data.loadTasks).mockResolvedValue([first, second]);
		const resp = await handleRequest(makeRequest("task.update", { taskId: "seq:13", projectId: "proj-1", dependsOn: ["seq:12"] }));
		expect(resp.ok).toBe(true);
		expect(saved?.relations).toEqual([{ type: "blocked-by", taskId: first.id }]);
	});

	it("task.update refuses a cycle and an unknown ref, and writes nothing", async () => {
		const firstDepends = { ...first, relations: [{ type: "blocked-by" as const, taskId: second.id }] };
		vi.mocked(data.loadTasks).mockResolvedValue([firstDepends, second]);
		const cycle = await handleRequest(makeRequest("task.update", { taskId: "seq:13", projectId: "proj-1", dependsOn: ["seq:12"] }));
		expect(cycle.ok).toBe(false);
		expect(cycle.error).toContain("cycle");
		const unknown = await handleRequest(makeRequest("task.update", { taskId: "seq:13", projectId: "proj-1", dependsOn: ["seq:99"] }));
		expect(unknown.ok).toBe(false);
		expect(saved).toBeNull();
	});

	it("task.update refused for one link changes nothing else, not the removal and not the title", async () => {
		const holding = { ...second, relations: [{ type: "blocked-by" as const, taskId: first.id }] };
		vi.mocked(data.loadTasks).mockResolvedValue([first, holding]);
		const resp = await handleRequest(makeRequest("task.update", { taskId: "seq:13", projectId: "proj-1", title: "Renamed", noDependsOn: ["seq:12"], dependsOn: ["seq:13"] }));
		expect(resp.ok).toBe(false);
		expect(resp.error).toContain("itself");
		expect(saved).toBeNull();
		expect(data.updateTaskWith).not.toHaveBeenCalled();
		expect(data.updateTask).not.toHaveBeenCalled();
	});

	it("task.show and tasks.list carry the resolved links", async () => {
		const blocked = { ...second, relations: [{ type: "blocked-by" as const, taskId: first.id }] };
		vi.mocked(data.loadTasks).mockResolvedValue([first, blocked]);
		const shown = await handleRequest(makeRequest("task.show", { taskId: "seq:13", projectId: "proj-1" }));
		expect((shown.data as { dependencyInfo: unknown }).dependencyInfo).toMatchObject({ verdict: "blocked", dependsOn: [{ seq: 12, state: "open" }] });
		const listed = await handleRequest(makeRequest("tasks.list", { projectId: "proj-1", status: "in-progress" }));
		expect((listed.data as Array<{ dependencyInfo: unknown }>)[0]!.dependencyInfo).toMatchObject({ blocks: [{ seq: 13 }] });
	});

	it("task.move starts a blocked task and names its open dependencies", async () => {
		const blocked = { ...second, relations: [{ type: "blocked-by" as const, taskId: first.id }] };
		vi.mocked(data.loadTasks).mockResolvedValue([first, blocked]);
		vi.mocked(moveTask).mockResolvedValue({ ...blocked, status: "in-progress" } as Task);
		const resp = await handleRequest(makeRequest("task.move", { taskId: "seq:13", projectId: "proj-1", newStatus: "in-progress" }));
		expect(resp.ok).toBe(true);
		expect(moveTask).toHaveBeenCalled();
		expect((resp.data as { startedBlockedBy: Array<{ seq: number }> }).startedBlockedBy.map((d) => d.seq)).toEqual([12]);
	});
});

describe("task.show", () => {

	describe("a qualified seq ref", () => {
		const mine = makeProject();
		const other = makeProject({ id: "proj-2", name: "Other" });
		const ownTask = makeTask({ id: "own-0000-1111-2222-333333333333", seq: 60 });
		const otherTask = makeTask({ id: "other-000-1111-2222-333333333333", projectId: "proj-2", seq: 60 });

		function wireTwoBoards() {
			vi.mocked(data.loadProjects).mockResolvedValue([mine, other]);
			vi.mocked(data.loadVirtualProjects).mockResolvedValue([]);
			vi.mocked(data.getProject).mockImplementation(async (id) => (id === "proj-2" ? other : mine));
			vi.mocked(data.loadTasks).mockImplementation(async (p) => (p.id === "proj-2" ? [otherTask] : [ownTask]));
		}

		it("resolves on the board it names, over the caller's own project", async () => {
			wireTwoBoards();
			const scoped = await handleRequest(makeRequest("task.show", { taskId: "seq:proj-2/60", projectId: "proj-1" }));
			const unscoped = await handleRequest(makeRequest("task.show", { taskId: "seq:proj-2/60" }));
			expect([(scoped.data as Task).id, (unscoped.data as Task).id]).toEqual([otherTask.id, otherTask.id]);
		});

		it("accepts the project name, and fails loudly on an unknown or ambiguous qualifier", async () => {
			wireTwoBoards();
			const byName = await handleRequest(makeRequest("task.show", { taskId: "seq:other/60", projectId: "proj-1" }));
			expect((byName.data as Task).id).toBe(otherTask.id);
			const unknown = await handleRequest(makeRequest("task.show", { taskId: "seq:nope1234/60", projectId: "proj-1" }));
			expect(unknown.error).toContain('No project matches "nope1234"');
			const ambiguous = await handleRequest(makeRequest("task.show", { taskId: "seq:proj/60", projectId: "proj-1" }));
			expect(ambiguous.error).toContain("matches 2 projects");
		});

		it("names another board in a dependency, which stays not found on this one", async () => {
			wireTwoBoards();
			vi.mocked(data.updateTask).mockImplementation(async (_p, _id, change) => ({ ...ownTask, ...change }));
			const same = await handleRequest(makeRequest("task.update", { taskId: ownTask.id, projectId: "proj-1", dependsOn: ["seq:proj-1/60"] }));
			const cross = await handleRequest(makeRequest("task.update", { taskId: ownTask.id, projectId: "proj-1", dependsOn: ["seq:proj-2/60"] }));
			expect(same.error ?? "").not.toContain("not found");
			expect(cross.error).toContain("Task not found");
		});
	});

	it("returns the live branch after an out-of-band `git branch -m` (issue #1003)", async () => {
		const project = makeProject();
		const task = makeTask();
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.loadTasks).mockResolvedValue([task]);
		vi.mocked(existsSync).mockReturnValue(true);
		vi.mocked(git.getCurrentBranch).mockResolvedValue("chore/dev3-example");
		vi.mocked(data.updateTask).mockResolvedValue({ ...task, branchName: "chore/dev3-example" });

		const resp = await handleRequest(
			makeRequest("task.show", { taskId: "task-abc12345", projectId: "proj-1" }),
		);
		expect(resp.ok).toBe(true);
		expect((resp.data as Task).branchName).toBe("chore/dev3-example");
		expect(data.updateTask).toHaveBeenCalledWith(project, task.id, { branchName: "chore/dev3-example" });

		// A stored branch that already matches the worktree is left alone.
		vi.mocked(data.updateTask).mockClear();
		vi.mocked(git.getCurrentBranch).mockResolvedValue(task.branchName);
		await handleRequest(makeRequest("task.show", { taskId: "task-abc12345", projectId: "proj-1" }));
		expect(data.updateTask).not.toHaveBeenCalled();
	});

	it("resolves a seq:<N> reference within the project", async () => {
		const project = makeProject();
		const task = makeTask({ seq: 42 });
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.loadTasks).mockResolvedValue([makeTask({ id: "other-task-1111-2222-3333-444444444444", seq: 7 }), task]);

		const resp = await handleRequest(
			makeRequest("task.show", { taskId: "seq:42", projectId: "proj-1" }),
		);
		expect(resp.ok).toBe(true);
		expect(resp.data).toEqual(task);
	});

	it("rejects a seq:<N> reference that matches several variants of one group", async () => {
		const project = makeProject();
		const v1 = makeTask({ id: "aaaaaaaa-1111-2222-3333-444444444444", seq: 42, groupId: "g1", variantIndex: 1 });
		const v2 = makeTask({ id: "bbbbbbbb-1111-2222-3333-444444444444", seq: 42, groupId: "g1", variantIndex: 2 });
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.loadTasks).mockResolvedValue([v1, v2]);

		const resp = await handleRequest(
			makeRequest("task.show", { taskId: "seq:42", projectId: "proj-1" }),
		);
		expect(resp.ok).toBe(false);
		expect(resp.error).toContain("matches 2 variant tasks");
		expect(resp.error).toContain("aaaaaaaa");
		expect(resp.error).toContain("bbbbbbbb");
	});

	it("rejects a seq:<N> reference that matches tasks in several projects", async () => {
		const projectA = makeProject({ id: "proj-a", name: "Alpha", path: "/tmp/a" });
		const projectB = makeProject({ id: "proj-b", name: "Beta", path: "/tmp/b" });
		vi.mocked(data.loadProjects).mockResolvedValue([projectA, projectB]);
		vi.mocked(data.loadVirtualProjects).mockResolvedValue([]);
		vi.mocked(data.loadTasks).mockImplementation(async (p) => [
			makeTask({ id: `${p.id}-task-1111-2222-3333-444444444444`, seq: 42, projectId: p.id }),
		]);

		const resp = await handleRequest(makeRequest("task.show", { taskId: "seq:42" }));
		expect(resp.ok).toBe(false);
		expect(resp.error).toContain("across projects");
		expect(resp.error).toContain("--project");
	});

	it("keeps a scoped lookup inside its project and names the board that does carry the ref", async () => {
		// The whole point of scoping: a seq the caller's own board does not have
		// must NOT come back as the stranger's task that happens to share the
		// number. The answer still has to be actionable, so it names the board.
		const projectA = makeProject({ id: "proj-a", name: "Alpha", path: "/tmp/a" });
		const projectB = makeProject({ id: "proj-b", name: "Beta", path: "/tmp/b" });
		vi.mocked(data.getProject).mockResolvedValue(projectA);
		vi.mocked(data.loadProjects).mockResolvedValue([projectA, projectB]);
		vi.mocked(data.loadVirtualProjects).mockResolvedValue([]);
		vi.mocked(data.loadTasks).mockImplementation(async (p) =>
			p.id === "proj-b" ? [makeTask({ id: "bbbbbbbb-1111-2222-3333-444444444444", seq: 130, projectId: "proj-b" })] : [],
		);

		const resp = await handleRequest(makeRequest("task.show", { taskId: "seq:130", projectId: "proj-a" }));

		expect(resp.ok).toBe(false);
		expect(resp.error).toContain('Task not found in project "Alpha"');
		expect(resp.error).toContain("does resolve on");
		expect(resp.error).toContain("Beta");
		expect(resp.error).toContain("--project proj-b");
		// The stranger's task must not leak out as a result.
		expect(resp.data).toBeUndefined();

		// With no board carrying the ref, the miss names no other board.
		vi.mocked(data.loadTasks).mockResolvedValue([]);
		const none = await handleRequest(makeRequest("task.show", { taskId: "seq:130", projectId: "proj-a" }));
		expect(none.ok).toBe(false);
		expect(none.error).not.toContain("does resolve on");
	});

	it("resolves the caller's own task when two boards share the seq", async () => {
		const projectA = makeProject({ id: "proj-a", name: "Alpha", path: "/tmp/a" });
		const projectB = makeProject({ id: "proj-b", name: "Beta", path: "/tmp/b" });
		const mine = makeTask({ id: "aaaaaaaa-1111-2222-3333-444444444444", seq: 130, projectId: "proj-a" });
		vi.mocked(data.getProject).mockResolvedValue(projectA);
		vi.mocked(data.loadProjects).mockResolvedValue([projectA, projectB]);
		vi.mocked(data.loadVirtualProjects).mockResolvedValue([]);
		vi.mocked(data.loadTasks).mockImplementation(async (p) =>
			p.id === "proj-a" ? [mine] : [makeTask({ id: "bbbbbbbb-1111-2222-3333-444444444444", seq: 130, projectId: "proj-b" })],
		);

		const resp = await handleRequest(makeRequest("task.show", { taskId: "seq:130", projectId: "proj-a" }));

		expect(resp.ok).toBe(true);
		expect((resp.data as Task).id).toBe(mine.id);
	});

	it("suggests the stable seq handle when a task id does not resolve", async () => {
		const project = makeProject();
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.loadTasks).mockResolvedValue([]);

		const resp = await handleRequest(
			makeRequest("task.show", { taskId: "deadbeef-1111-2222-3333-444444444444", projectId: "proj-1" }),
		);
		expect(resp.ok).toBe(false);
		// A project-scoped lookup names the board it searched and offers --project:
		// addressing another project's task is the commonest cause of this miss.
		expect(resp.error).toContain('Task not found in project "Test Project": deadbeef');
		expect(resp.error).toContain("--project <id>");
		expect(resp.error).toContain("seq:<N>");
		expect(resp.error).toContain("dev3 tasks list");
	});

	it("resolves an id, an 8+ char prefix and a seq:<N> across projects; refuses short, ambiguous and unknown refs", async () => {
		const project = makeProject();
		const task = makeTask({ id: "task-abc12345-aaaa-uuid", seq: 42 });
		const sibling = makeTask({ id: "task-abc12345-bbbb-uuid", seq: 2 });
		vi.mocked(data.loadProjects).mockResolvedValue([project]);
		vi.mocked(data.loadVirtualProjects).mockResolvedValue([]);
		vi.mocked(data.loadTasks).mockResolvedValue([task, sibling]);

		for (const ref of [task.id, "task-abc12345-a", "seq:42"]) {
			const resp = await handleRequest(makeRequest("task.show", { taskId: ref }));
			expect(resp.data, ref).toEqual(task);
		}
		const misses: Array<[string, string]> = [["task-ab", "Task not found"], ["task-abc12345", "Ambiguous"], ["nonexistent", "Task not found"]];
		for (const [ref, error] of misses) {
			const resp = await handleRequest(makeRequest("task.show", { taskId: ref }));
			expect(resp, ref).toMatchObject({ ok: false, error: expect.stringContaining(error) });
		}

		// A task that lives only on a virtual (Operations) board is scanned too.
		const ops = makeProject({ id: "ops", kind: "virtual", builtin: true });
		vi.mocked(data.loadProjects).mockResolvedValue([]);
		vi.mocked(data.loadVirtualProjects).mockResolvedValue([ops]);
		vi.mocked(data.loadTasks).mockResolvedValue([task]);
		expect((await handleRequest(makeRequest("task.show", { taskId: "task-abc12345" }))).data).toEqual(task);
	});

	it("skips projects with broken task files during cross-project resolution", async () => {
		const p1 = makeProject({ id: "p1" });
		const p2 = makeProject({ id: "p2" });
		const task = makeTask();
		vi.mocked(data.loadProjects).mockResolvedValue([p1, p2]);
		vi.mocked(data.loadTasks)
			.mockRejectedValueOnce(new Error("corrupt"))
			.mockResolvedValueOnce([task]);

		const resp = await handleRequest(
			makeRequest("task.show", { taskId: task.id }),
		);
		expect(resp.ok).toBe(true);
		expect(resp.data).toEqual(task);
	});
});

describe("devServer.*", () => {
	it("starts a dev server in the background, and restarts via restartDevServer, not a bare start", async () => {
		{
			const project = makeProject();
			const task = makeTask({ id: "task-abc12345-1111-2222-3333-444444444444" });
			const status = { taskId: task.id, running: true, devSessionName: "dev3-dev-task-abc1" };
			vi.mocked(data.getProject).mockResolvedValue(project);
			vi.mocked(data.loadTasks).mockResolvedValue([task]);
			vi.mocked(runDevServer).mockResolvedValue(status as any);

			const resp = await handleRequest(makeRequest("devServer.start", {
				projectId: "proj-1",
				taskId: "task-abc1",
			}));

			expect(resp.ok).toBe(true);
			expect(runDevServer).toHaveBeenCalledWith({ taskId: task.id, projectId: project.id });
			// A CLI start never carries `focus`, so its pane opens in the background.
			expect(vi.mocked(runDevServer).mock.calls[0][0]).not.toHaveProperty("focus");
			expect(resp.data).toEqual(status);
		}
		vi.clearAllMocks();
		{
			const project = makeProject();
			const task = makeTask({ id: "task-abc12345-1111-2222-3333-444444444444" });
			const status = { taskId: task.id, running: true, devSessionName: "dev3-dev-task-abc1" };
			vi.mocked(data.getProject).mockResolvedValue(project);
			vi.mocked(data.loadTasks).mockResolvedValue([task]);
			vi.mocked(restartDevServer).mockResolvedValue(status as any);

			const resp = await handleRequest(makeRequest("devServer.restart", {
				projectId: "proj-1",
				taskId: "task-abc1",
			}));

			expect(resp.ok).toBe(true);
			expect(restartDevServer).toHaveBeenCalledWith({ taskId: task.id, projectId: project.id });
			expect(runDevServer).not.toHaveBeenCalled();
			expect(resp.data).toEqual(status);
		}
	});

	it("stops a dev server by resolving task across projects", async () => {
		const project = makeProject();
		const task = makeTask({ id: "task-abc12345-1111-2222-3333-444444444444" });
		vi.mocked(data.loadProjects).mockResolvedValue([project]);
		vi.mocked(data.loadTasks).mockResolvedValue([task]);
		vi.mocked(stopDevServer).mockResolvedValue({ taskId: task.id, running: false } as any);

		const resp = await handleRequest(makeRequest("devServer.stop", {
			taskId: "task-abc1",
		}));

		expect(resp.ok).toBe(true);
		expect(stopDevServer).toHaveBeenCalledWith({ taskId: task.id, projectId: project.id });

		const status = { taskId: task.id, running: false, ports: [] };
		vi.mocked(getDevServerStatus).mockResolvedValue(status as any);
		const shown = await handleRequest(makeRequest("devServer.status", { taskId: task.id }));
		expect(getDevServerStatus).toHaveBeenCalledWith({ taskId: task.id, projectId: project.id });
		expect(shown.data).toEqual(status);
	});
});

describe("task.create", () => {

	it("creates task with title only (no description) and pushes message", async () => {
		const project = makeProject();
		const task = makeTask({ status: "todo" });
		const pushFn = vi.fn();

		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(createTask).mockResolvedValue(task);
		vi.mocked(getPushMessage).mockReturnValue(pushFn);

		const resp = await handleRequest(
			makeRequest("task.create", { projectId: "proj-1", title: "New task" }),
		);
		expect(resp.ok).toBe(true);
		expect(createTask).toHaveBeenCalledWith({ projectId: "proj-1", description: "New task" });
		expect(pushFn).toHaveBeenCalledWith("taskUpdated", { projectId: "proj-1", task });

		// No window to push to is not an error.
		vi.mocked(getPushMessage).mockReturnValue(null);
		expect((await handleRequest(makeRequest("task.create", { projectId: "proj-1", title: "New task" }))).ok).toBe(true);
	});

	it("creates task with description and sets customTitle", async () => {
		const project = makeProject();
		const task = makeTask({ status: "todo" });
		const updatedTask = makeTask({ status: "todo", customTitle: "Short title" });
		const pushFn = vi.fn();

		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(createTask).mockResolvedValue(task);
		vi.mocked(data.updateTask).mockResolvedValue(updatedTask);
		vi.mocked(getPushMessage).mockReturnValue(pushFn);

		const resp = await handleRequest(
			makeRequest("task.create", {
				projectId: "proj-1",
				title: "Short title",
				description: "Long detailed description\nwith multiple lines",
			}),
		);
		expect(resp.ok).toBe(true);
		expect(createTask).toHaveBeenCalledWith({ projectId: "proj-1", description: "Long detailed description\nwith multiple lines" });
		expect(data.updateTask).toHaveBeenCalledWith(project, task.id, { customTitle: "Short title" });
		expect(pushFn).toHaveBeenCalledWith("taskUpdated", { projectId: "proj-1", task: updatedTask });
	});

	describe("origin", () => {
		const parentProject = makeProject({ id: "proj-2", name: "Coordinators" });
		const parent = makeTask({ id: "parent-0000-1111-2222-333333333333", projectId: "proj-2", seq: 1801 });

		function wireBoards() {
			const project = makeProject();
			vi.mocked(data.getProject).mockResolvedValue(project);
			vi.mocked(data.loadProjects).mockResolvedValue([project, parentProject]);
			vi.mocked(data.loadVirtualProjects).mockResolvedValue([]);
			vi.mocked(data.loadTasks).mockImplementation(async (p) => (p.id === "proj-2" ? [parent] : []));
			vi.mocked(createTask).mockResolvedValue(makeTask({ status: "todo" }));
			vi.mocked(getPushMessage).mockReturnValue(vi.fn());
		}

		it("records the creating task, resolved in another project, as the parent", async () => {
			wireBoards();
			const resp = await handleRequest(makeRequest("task.create", { projectId: "proj-1", title: "Child", sourceTaskId: "parent-0" }));
			expect(resp.ok).toBe(true);
			expect(createTask).toHaveBeenCalledWith({
				projectId: "proj-1",
				description: "Child",
				origin: { kind: "task", taskId: parent.id, projectId: "proj-2" },
			});
		});

		it("records the exact variant that created the task", async () => {
			wireBoards();
			const variant2 = makeTask({ id: "variant2-1111-2222-3333-444444444444", projectId: "proj-2", seq: 1801, groupId: "g", variantIndex: 2 });
			vi.mocked(data.loadTasks).mockImplementation(async (p) => (p.id === "proj-2" ? [{ ...parent, groupId: "g", variantIndex: 1 }, variant2] : []));
			await handleRequest(makeRequest("task.create", { projectId: "proj-1", title: "Child", sourceTaskId: "variant2" }));
			expect(vi.mocked(createTask).mock.calls[0]![0].origin).toEqual({ kind: "task", taskId: variant2.id, projectId: "proj-2" });
		});

		it("records the user when the creator cannot be resolved (still creating) and outside any task context", async () => {
			wireBoards();
			const resp = await handleRequest(makeRequest("task.create", { projectId: "proj-1", title: "Child", sourceTaskId: "gone-123" }));
			expect(resp.ok).toBe(true);
			expect(createTask).toHaveBeenCalledWith({ projectId: "proj-1", description: "Child" });
			await handleRequest(makeRequest("task.create", { projectId: "proj-1", title: "Mine" }));
			expect(vi.mocked(createTask).mock.calls[1]![0]).not.toHaveProperty("origin");
		});

		it("gives refs written from another board that board's project", async () => {
			wireBoards();
			vi.mocked(data.updateTask).mockImplementation(async (_p, _id, change) => makeTask({ status: "todo", ...change }));
			await handleRequest(makeRequest("task.create", {
				projectId: "proj-1",
				title: "Follow up seq:60",
				description: "Source (seq:60 split it). See <pr:7>; run `dev3 task show seq:60` or dev3 note add --task seq:60 x",
				sourceTaskId: "parent-0",
			}));
			expect(vi.mocked(createTask).mock.calls[0]![0].description)
				.toBe("Source (seq:proj-2/60 split it). See <pr:proj-2/7>; run `dev3 task show seq:proj-2/60` or dev3 note add --task seq:proj-2/60 x");
			expect(vi.mocked(data.updateTask).mock.calls[0]![2]).toMatchObject({ customTitle: "Follow up seq:proj-2/60" });
		});

		it("keeps refs as written when the creator sits on the same board or is unknown", async () => {
			wireBoards();
			const sibling = makeTask({ id: "sibling-0000-1111-2222-333333333333", projectId: "proj-1", seq: 5 });
			vi.mocked(data.loadTasks).mockImplementation(async (p) => (p.id === "proj-2" ? [parent] : [sibling]));
			await handleRequest(makeRequest("task.create", { projectId: "proj-1", title: "A", description: "see seq:60", sourceTaskId: "sibling-0" }));
			await handleRequest(makeRequest("task.create", { projectId: "proj-1", title: "B", description: "see seq:60" }));
			await handleRequest(makeRequest("task.create", { projectId: "proj-1", title: "C", description: "see seq:60", sourceTaskId: "gone-123" }));
			expect(vi.mocked(createTask).mock.calls.map((c) => c[0].description)).toEqual(["see seq:60", "see seq:60", "see seq:60"]);
		});

		it("task.show resolves the parent, and reports a deleted one as null", async () => {
			wireBoards();
			const child = makeTask({ id: "child-11-1111-2222-3333-444444444444", origin: { kind: "task", taskId: parent.id, projectId: "proj-2" } });
			vi.mocked(data.loadTasks).mockImplementation(async (p) => (p.id === "proj-2" ? [parent] : [child]));
			const shown = await handleRequest(makeRequest("task.show", { taskId: "child-11", projectId: "proj-1" }));
			expect(shown.data).toMatchObject({ originParent: { id: parent.id, projectName: "Coordinators", seq: 1801, variantIndex: null } });

			vi.mocked(data.loadTasks).mockImplementation(async (p) => (p.id === "proj-2" ? [] : [child]));
			const orphan = await handleRequest(makeRequest("task.show", { taskId: "child-11", projectId: "proj-1" }));
			expect(orphan.data).toMatchObject({ originParent: null });

			// A task the user created gets no originParent at all.
			vi.mocked(data.loadTasks).mockResolvedValue([makeTask()]);
			const mine = await handleRequest(makeRequest("task.show", { taskId: "task-abc", projectId: "proj-1" }));
			expect(mine.data).not.toHaveProperty("originParent");
		});

		it("task.children lists direct children of the whole variant group across projects", async () => {
			const project = makeProject();
			const v1 = { ...parent, projectId: "proj-1", groupId: "g", variantIndex: 1 };
			const v2 = makeTask({ id: "variant2-1111-2222-3333-444444444444", seq: 1801, groupId: "g", variantIndex: 2 });
			const childA = makeTask({ id: "childA", seq: 5, status: "todo", origin: { kind: "task", taskId: v1.id, projectId: "proj-1" } });
			const childB = makeTask({ id: "childB", projectId: "proj-2", seq: 9, origin: { kind: "task", taskId: v2.id, projectId: "proj-1" } });
			const grandchild = makeTask({ id: "grand", projectId: "proj-2", seq: 10, origin: { kind: "task", taskId: "childB", projectId: "proj-2" } });
			vi.mocked(data.getProject).mockResolvedValue(project);
			vi.mocked(data.loadProjects).mockResolvedValue([project, parentProject]);
			vi.mocked(data.loadVirtualProjects).mockResolvedValue([]);
			vi.mocked(data.loadTasks).mockImplementation(async (p) => (p.id === "proj-1" ? [v1, v2, childA] : [childB, grandchild]));

			const resp = await handleRequest(makeRequest("task.children", { taskId: "seq:1801", projectId: "proj-1" }));
			expect(resp.ok).toBe(true);
			const result = resp.data as { parent: { seq: number }; children: Array<{ id: string; projectName: string }> };
			expect(result.parent.seq).toBe(1801);
			expect(result.children.map((c) => [c.id, c.projectName]).sort()).toEqual([["childA", "Test Project"], ["childB", "Coordinators"]]);
		});
	});

	describe("epic", () => {
		const parentProject = makeProject({ id: "proj-2", name: "Backend" });
		const payments = { id: "epicpay1-0000-1111-2222-333333333333", name: "Payments v2", color: "#3b82f6", archived: false, createdAt: 0 };
		const closed = { id: "epicold1-0000-1111-2222-333333333333", name: "Old effort", color: "#ef4444", archived: true, createdAt: 0 };

		function wire(parentEpicId?: string) {
			epicStore.epics = [{ ...payments }, { ...closed }];
			const parent = makeTask({ id: "parent-0000-1111-2222-333333333333", projectId: "proj-2", seq: 7, ...(parentEpicId ? { epicId: parentEpicId } : {}) });
			const project = makeProject();
			vi.mocked(data.getProject).mockResolvedValue(project);
			vi.mocked(data.loadProjects).mockResolvedValue([project, parentProject]);
			vi.mocked(data.loadVirtualProjects).mockResolvedValue([]);
			vi.mocked(data.loadTasks).mockImplementation(async (p) => (p.id === "proj-2" ? [parent] : []));
			vi.mocked(createTask).mockResolvedValue(makeTask({ status: "todo" }));
			vi.mocked(getPushMessage).mockReturnValue(vi.fn());
			return parent;
		}
		const created = () => vi.mocked(createTask).mock.calls[0]![0];

		it("inherits the creating task's epic across projects", async () => {
			wire(payments.id);
			const resp = await handleRequest(makeRequest("task.create", { projectId: "proj-1", title: "Child", sourceTaskId: "parent-0" }));
			expect(resp.ok).toBe(true);
			expect(created().epicId).toBe(payments.id);
		});

		it("does not inherit an archived epic, and still creates", async () => {
			wire(closed.id);
			const resp = await handleRequest(makeRequest("task.create", { projectId: "proj-1", title: "Child", sourceTaskId: "parent-0" }));
			expect(resp.ok).toBe(true);
			expect(created()).not.toHaveProperty("epicId");
		});

		it("gives no epic outside a task context, when the creator is gone, or with --no-epic", async () => {
			wire(payments.id);
			await handleRequest(makeRequest("task.create", { projectId: "proj-1", title: "Child", sourceTaskId: "parent-0", noEpic: true }));
			expect(created()).not.toHaveProperty("epicId");
			vi.mocked(createTask).mockClear();
			wire(payments.id);
			await handleRequest(makeRequest("task.create", { projectId: "proj-1", title: "Mine" }));
			await handleRequest(makeRequest("task.create", { projectId: "proj-1", title: "Orphan", sourceTaskId: "gone-123" }));
			expect(vi.mocked(createTask).mock.calls.map((c) => c[0].epicId)).toEqual([undefined, undefined]);
		});

		it("--epic overrides inheritance by name, case-insensitively", async () => {
			wire(undefined);
			epicStore.epics.push({ id: "epicother-000-1111-2222-333333333333", name: "Other", color: "#14b8a6", archived: false, createdAt: 0 });
			await handleRequest(makeRequest("task.create", { projectId: "proj-1", title: "Child", sourceTaskId: "parent-0", epic: "other" }));
			expect(created().epicId).toBe("epicother-000-1111-2222-333333333333");
		});

		it("refuses an unknown or archived --epic with the coded error and creates nothing", async () => {
			wire(undefined);
			const unknown = await handleRequest(makeRequest("task.create", { projectId: "proj-1", title: "X", epic: "Paymnts" }));
			expect(unknown.error).toMatch(/^epic-ref-invalid: /);
			const archived = await handleRequest(makeRequest("task.create", { projectId: "proj-1", title: "X", epic: "Old effort" }));
			expect(archived.error).toMatch(/^epic-ref-invalid: .*archived/);
			const both = await handleRequest(makeRequest("task.create", { projectId: "proj-1", title: "X", epic: "Payments v2", noEpic: true }));
			expect(both.ok).toBe(false);
			expect(createTask).not.toHaveBeenCalled();
		});

		it("lets the user and coordinators create epics, and refuses any other task", async () => {
			const parent = wire(undefined);
			const asUser = await handleRequest(makeRequest("epic.create", { name: "From the shell" }));
			expect(asUser.ok).toBe(true);
			const asAgent = await handleRequest(makeRequest("epic.create", { name: "Agent epic", sourceTaskId: "parent-0" }));
			expect(asAgent.error).toMatch(/^epic-create-forbidden: /);
			vi.mocked(data.loadTasks).mockImplementation(async (p) => (p.id === "proj-2" ? [{ ...parent, taskType: "coordinator" }] : []));
			const asCoordinator = await handleRequest(makeRequest("epic.create", { name: "Coordinated", sourceTaskId: "parent-0" }));
			expect(asCoordinator.ok).toBe(true);
			expect(epicStore.epics.map((e) => e.name)).toEqual(["Payments v2", "Old effort", "From the shell", "Coordinated"]);
		});

		it("task.update --epic changes only that task, --no-epic clears it, and children are untouched", async () => {
			const parent = wire(undefined);
			const child = makeTask({ id: "child-000-1111", projectId: "proj-2", seq: 8, origin: { kind: "task", taskId: parent.id, projectId: "proj-2" } });
			vi.mocked(data.loadTasks).mockImplementation(async (p) => (p.id === "proj-2" ? [parent, child] : []));
			vi.mocked(data.updateTask).mockImplementation(async (_p, id, updates) => ({ ...(id === parent.id ? parent : child), ...updates }));

			const set = await handleRequest(makeRequest("task.update", { taskId: parent.id, epic: "payments V2" }));
			expect(set.ok).toBe(true);
			expect((set.data as { task: { epicId?: string } }).task.epicId).toBe(payments.id);
			const cleared = await handleRequest(makeRequest("task.update", { taskId: parent.id, noEpic: true }));
			expect((cleared.data as { task: { epicId?: string } }).task.epicId).toBeUndefined();
			expect(vi.mocked(data.updateTask).mock.calls.map((c) => c[1])).toEqual([parent.id, parent.id]);

			const bad = await handleRequest(makeRequest("task.update", { taskId: parent.id, epic: "nope" }));
			expect(bad.error).toMatch(/^epic-ref-invalid: /);
		});

		it("task.update refuses to put a task into an archived epic, but a member may keep it", async () => {
			const parent = wire(undefined);
			vi.mocked(data.updateTask).mockImplementation(async (_p, _id, updates) => ({ ...parent, ...updates }));
			const joined = await handleRequest(makeRequest("task.update", { taskId: parent.id, epic: "Old effort" }));
			expect(joined.error).toMatch(/^epic-ref-invalid: .*archived/);
			expect(data.updateTask).not.toHaveBeenCalled();

			const member = wire(closed.id);
			vi.mocked(data.updateTask).mockImplementation(async (_p, _id, updates) => ({ ...member, ...updates }));
			const kept = await handleRequest(makeRequest("task.update", { taskId: member.id, epic: "Old effort" }));
			expect(kept.ok).toBe(true);
		});

		it("epic.tasks lists an epic's tasks from every project; task.show names the epic", async () => {
			wire(payments.id);
			const mine = makeTask({ id: "mine-0000-1111", seq: 3, status: "completed", epicId: payments.id });
			const other = makeTask({ id: "other-000-1111", seq: 4 });
			vi.mocked(data.loadTasks).mockImplementation(async (p) => (p.id === "proj-2"
				? [makeTask({ id: "parent-0000-1111-2222-333333333333", projectId: "proj-2", seq: 7, epicId: payments.id })]
				: [mine, other]));
			const resp = await handleRequest(makeRequest("epic.tasks", { epic: "Payments v2" }));
			const result = resp.data as { tasks: Array<{ id: string; projectName: string; status: string }> };
			expect(result.tasks.map((t) => [t.id, t.projectName, t.status]).sort()).toEqual([
				["mine-0000-1111", "Test Project", "completed"],
				["parent-0000-1111-2222-333333333333", "Backend", "in-progress"],
			].sort());

			const shown = await handleRequest(makeRequest("task.show", { taskId: "mine-000", projectId: "proj-1" }));
			expect(shown.data).toMatchObject({ epic: { id: payments.id, name: "Payments v2", archived: false } });
			const list = await handleRequest(makeRequest("epic.list"));
			expect((list.data as Array<{ name: string; taskCount: number }>).find((e) => e.name === "Payments v2")?.taskCount).toBe(2);
		});
	});

	// The whole point of the flag: a task created with a type must carry the role
	// brief in the description the agent reads, not just the badge on the card.
	describe("--type", () => {
		function wireCreate() {
			const project = makeProject();
			const task = makeTask({ status: "todo" });
			vi.mocked(data.getProject).mockResolvedValue(project);
			vi.mocked(createTask).mockResolvedValue(task);
			vi.mocked(data.updateTask).mockImplementation(async (_p, _id, updates) => ({ ...task, ...updates }));
			vi.mocked(getPushMessage).mockReturnValue(vi.fn());
			return { project, task };
		}

		it("writes the coordinator preamble above the description and stores the type", async () => {
			const { project } = wireCreate();

			const resp = await handleRequest(makeRequest("task.create", {
				projectId: "proj-1",
				title: "Run the board",
				description: "coordinate my board",
				taskType: "coordinator",
			}));

			expect(resp.ok).toBe(true);
			expect(createTask).toHaveBeenCalledWith({
				projectId: project.id,
				description: withPresetPrompt("coordinate my board", COORDINATOR_PROMPT),
				taskType: "coordinator",
			});
			expect(data.getProject).toHaveBeenCalledWith(project.id);
		});

		it("writes the pr-review preamble and keeps the title off the preamble", async () => {
			const { task } = wireCreate();

			const resp = await handleRequest(makeRequest("task.create", {
				projectId: "proj-1",
				title: "Review PR 42",
				taskType: "pr-review",
			}));

			expect(resp.ok).toBe(true);
			expect(vi.mocked(createTask).mock.calls[0]![0].description)
				.toBe(withPresetPrompt("Review PR 42", DEFAULT_PR_REVIEW_PROMPT));
			// Without a customTitle every review card would be named after the preamble.
			expect(data.updateTask).toHaveBeenCalledWith(expect.anything(), task.id, { customTitle: "Review PR 42" });
		});

		it("creates a cleanup role with its passive brief and preserves explicit scope", async () => {
			wireCreate();
			const resp = await handleRequest(makeRequest("task.create", { projectId: "proj-1", title: "Cleanup", description: "Audit all projects.", taskType: "board-cleanup" }));
			expect(resp.ok).toBe(true);
			expect(createTask).toHaveBeenCalledWith(expect.objectContaining({ taskType: "board-cleanup", description: withPresetPrompt("Audit all projects.", BOARD_CLEANUP_PROMPT) }));
		});

		it("carries a priority alongside the type", async () => {
			wireCreate();

			const resp = await handleRequest(makeRequest("task.create", {
				projectId: "proj-1",
				title: "Run the board",
				taskType: "coordinator",
				priority: "P0",
			}));

			expect(resp.ok).toBe(true);
			expect(vi.mocked(createTask).mock.calls[0]![0]).toMatchObject({ priority: "P0", taskType: "coordinator" });
		});

		it("treats standard as no type at all, and rejects an unknown type creating nothing", async () => {
			wireCreate();
			const standard = await handleRequest(makeRequest("task.create", { projectId: "proj-1", title: "Ordinary task", taskType: "standard" }));
			expect(standard.ok).toBe(true);
			expect(createTask).toHaveBeenCalledWith({ projectId: "proj-1", description: "Ordinary task" });
			vi.mocked(createTask).mockClear();

			const resp = await handleRequest(makeRequest("task.create", {
				projectId: "proj-1",
				title: "Nope",
				taskType: "reviewer",
			}));

			expect(resp.ok).toBe(false);
			expect(resp.error).toContain('Invalid task type "reviewer"');
			expect(resp.error).toContain("coordinator, pr-review");
			expect(createTask).not.toHaveBeenCalled();
		});
	});

	// The CLI reaches GUI parity by handing the SAME creation function the same
	// ref — `foreignCode` is derived from it there, and nowhere else.
	describe("--pr / --branch", () => {
		function wireCreate() {
			const project = makeProject();
			const task = makeTask({ status: "todo" });
			vi.mocked(data.getProject).mockResolvedValue(project);
			vi.mocked(createTask).mockResolvedValue(task);
			vi.mocked(data.updateTask).mockImplementation(async (_p, _id, updates) => ({ ...task, ...updates }));
			vi.mocked(getPushMessage).mockReturnValue(vi.fn());
			return { project, task };
		}

		it("passes the resolved pull-request ref to creation as existingBranch", async () => {
			const { project } = wireCreate();
			vi.mocked(resolveTaskStartRef).mockResolvedValue("arditti/fix/ctrl-o");

			const resp = await handleRequest(makeRequest("task.create", {
				projectId: "proj-1",
				title: "Review of #1512",
				taskType: "pr-review",
				pr: "1512",
			}));

			expect(resp.ok).toBe(true);
			expect(resolveTaskStartRef).toHaveBeenCalledWith({ project, pr: "1512", branch: undefined, ownWorktree: false });
			expect(vi.mocked(createTask).mock.calls[0]![0]).toMatchObject({
				existingBranch: "arditti/fix/ctrl-o",
				taskType: "pr-review",
			});
		});

		it("passes a --branch ref through the same seam", async () => {
			wireCreate();
			vi.mocked(resolveTaskStartRef).mockResolvedValue("origin/feat/x");

			const resp = await handleRequest(makeRequest("task.create", {
				projectId: "proj-1",
				title: "Look at feat/x",
				branch: "origin/feat/x",
			}));

			expect(resp.ok).toBe(true);
			expect(vi.mocked(createTask).mock.calls[0]![0]).toMatchObject({ existingBranch: "origin/feat/x" });

			// Neither flag: no existingBranch key at all.
			vi.mocked(resolveTaskStartRef).mockResolvedValue(undefined);
			await handleRequest(makeRequest("task.create", { projectId: "proj-1", title: "Ordinary" }));
			expect(vi.mocked(createTask).mock.calls[1]![0]).not.toHaveProperty("existingBranch");
		});

		it("creates NOTHING when the ref does not resolve", async () => {
			wireCreate();
			vi.mocked(resolveTaskStartRef).mockRejectedValueOnce(new Error(`${TASK_REF_UNRESOLVED_PREFIX}no pull request 999 in this project.`));

			const resp = await handleRequest(makeRequest("task.create", {
				projectId: "proj-1",
				title: "Review of #999",
				pr: "999",
			}));

			expect(resp.ok).toBe(false);
			expect(resp.error).toContain(TASK_REF_UNRESOLVED_PREFIX);
			expect(createTask).not.toHaveBeenCalled();
		});
	});
});

describe("ui.show-image", () => {
	function wireShowImage(project: Project, task: Task, pushFn: ReturnType<typeof vi.fn>) {
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.loadTasks).mockResolvedValue([task]);
		vi.mocked(getPushMessage).mockReturnValue(pushFn as never);
		vi.mocked(data.updateTaskWith).mockImplementation(async (_project, _taskId, mutator) => {
			const { updates, result } = await (mutator as (t: Task) => Promise<{ updates: Partial<Task>; result: unknown }>)(task);
			return { task: { ...task, ...updates }, result } as never;
		});
	}

	it("stores images, pushes taskUpdated + cliShowImage", async () => {
		const project = makeProject();
		const task = makeTask({ seq: 12 });
		const pushFn = vi.fn();
		wireShowImage(project, task, pushFn);

		const resp = await handleRequest(
			makeRequest("ui.show-image", { taskId: task.id, projectId: project.id, paths: ["/tmp/a.png", "/tmp/b.png"] }),
		);

		expect(resp.ok).toBe(true);
		expect(resp.data).toMatchObject({ delivered: true, stored: 2, taskId: task.id });
		expect(pushFn).toHaveBeenCalledWith("taskUpdated", expect.objectContaining({ projectId: project.id }));
		expect(pushFn).toHaveBeenCalledWith(
			"cliShowImage",
			expect.objectContaining({ taskId: task.id, newCount: 2, taskSeq: task.seq, projectName: project.name, newKind: "image" }),
		);
	});

	it("focus mode: persists (taskUpdated) but queues cliShowImage", async () => {
		const project = makeProject();
		const task = makeTask();
		const pushFn = vi.fn();
		wireShowImage(project, task, pushFn);
		vi.mocked(loadSettings).mockReturnValueOnce({ focusMode: true } as never);
		vi.mocked(isNotificationSuppressed).mockReturnValue(true);

		const resp = await handleRequest(
			makeRequest("ui.show-image", { taskId: task.id, projectId: project.id, paths: ["/tmp/a.png"] }),
		);

		expect(resp.ok).toBe(true);
		expect(resp.data).toMatchObject({ delivered: true, queued: true, stored: 1 });
		expect(pushFn).toHaveBeenCalledWith("taskUpdated", expect.anything());
		expect(pushFn).not.toHaveBeenCalledWith("cliShowImage", expect.anything());
		expect(pushCliShowImage).toHaveBeenCalledWith(expect.objectContaining({ taskId: task.id, newCount: 1 }));
	});

	it("ui.show-media stores a video clip through the clip path into the same history", async () => {
		const project = makeProject();
		const existing = { id: "old", storedPath: "/wt/a.png", originalPath: "/tmp/a.png", name: "a.png", mime: "image/png", bytes: 1, createdAt: 0 };
		const task = makeTask({ seq: 4, sharedImages: [existing] });
		const pushFn = vi.fn();
		wireShowImage(project, task, pushFn);
		const imageSpy = vi.mocked(saveSharedImage);
		const videoSpy = vi.mocked(saveSharedClips);
		imageSpy.mockClear();
		videoSpy.mockClear();

		const resp = await handleRequest(
			makeRequest("ui.show-media", { taskId: task.id, projectId: project.id, images: [{ path: "/tmp/demo.mp4", caption: "play me" }] }),
		);

		expect(resp.ok).toBe(true);
		expect(resp.data).toMatchObject({ delivered: true, stored: 1 });
		expect(videoSpy).toHaveBeenCalledWith(project, [{ path: "/tmp/demo.mp4", caption: "play me" }]);
		expect(imageSpy).not.toHaveBeenCalled();
		const cliPush = pushFn.mock.calls.find((c) => c[0] === "cliShowImage");
		expect(cliPush?.[1]).toMatchObject({ newKind: "video", newCount: 1 });
		expect(cliPush?.[1].images.map((i: SharedImage) => i.mime)).toEqual(["image/png", "video/mp4"]);
		// Clips land in their own additive field; the image list older versions read is untouched.
		const calls = vi.mocked(data.updateTaskWith).mock.calls;
		const update = calls[calls.length - 1]?.[2] as (t: Task) => { updates: Partial<Task> };
		const { updates } = update(task);
		expect(updates.sharedVideos?.map((v) => v.originalPath)).toEqual(["/tmp/demo.mp4"]);
		expect("sharedImages" in updates).toBe(false);
		expect("sharedAudio" in updates).toBe(false);
	});

	it("ui.show-media files audio in its own field, keeps captions, and labels the batch", async () => {
		const project = makeProject();
		const task = makeTask({ seq: 6 });
		const pushFn = vi.fn();
		wireShowImage(project, task, pushFn);

		const resp = await handleRequest(
			makeRequest("ui.show-media", { taskId: task.id, projectId: project.id, images: [{ path: "/tmp/voice.mp3", caption: "listen at 0:02" }] }),
		);

		expect(resp.ok).toBe(true);
		const cliPush = pushFn.mock.calls.find((c) => c[0] === "cliShowImage");
		expect(cliPush?.[1]).toMatchObject({ newKind: "audio", newCount: 1 });
		expect(cliPush?.[1].images).toEqual([expect.objectContaining({ mime: "audio/mpeg", caption: "listen at 0:02" })]);
		// Never into sharedVideos: versions that know it read any non-video entry as an image.
		const calls = vi.mocked(data.updateTaskWith).mock.calls;
		const update = calls[calls.length - 1]?.[2] as (t: Task) => { updates: Partial<Task> };
		const { updates } = update(task);
		expect(updates.sharedAudio?.map((a) => a.originalPath)).toEqual(["/tmp/voice.mp3"]);
		expect("sharedVideos" in updates).toBe(false);
		expect("sharedImages" in updates).toBe(false);
	});

	it("ui.show-media splits a mixed batch across both clip fields and calls it media", async () => {
		const project = makeProject();
		const task = makeTask({ seq: 7 });
		const pushFn = vi.fn();
		wireShowImage(project, task, pushFn);

		await handleRequest(makeRequest("ui.show-media", { taskId: task.id, projectId: project.id, images: [{ path: "/tmp/a.mp4" }, { path: "/tmp/b.mp3" }] }));

		const cliPush = pushFn.mock.calls.find((c) => c[0] === "cliShowImage");
		expect(cliPush?.[1]).toMatchObject({ newKind: "media", newCount: 2 });
		const calls = vi.mocked(data.updateTaskWith).mock.calls;
		const update = calls[calls.length - 1]?.[2] as (t: Task) => { updates: Partial<Task> };
		const { updates } = update(task);
		expect(updates.sharedVideos?.map((v) => v.originalPath)).toEqual(["/tmp/a.mp4"]);
		expect(updates.sharedAudio?.map((a) => a.originalPath)).toEqual(["/tmp/b.mp3"]);
	});

	it("no longer answers ui.show-video", async () => {
		const resp = await handleRequest(makeRequest("ui.show-video", { taskId: "t", images: [{ path: "/tmp/a.mp4" }] }));
		expect(resp.ok).toBe(false);
	});

	it("accepts the images:[{path,caption}] shape and threads per-image captions", async () => {
		const project = makeProject();
		const task = makeTask({ seq: 3 });
		const pushFn = vi.fn();
		wireShowImage(project, task, pushFn);
		const saveSpy = vi.mocked(saveSharedImage);
		saveSpy.mockClear();

		const resp = await handleRequest(
			makeRequest("ui.show-image", {
				taskId: task.id,
				projectId: project.id,
				images: [
					{ path: "/tmp/a.png", caption: "before" },
					{ path: "/tmp/b.png", caption: "after" },
				],
			}),
		);

		expect(resp.ok).toBe(true);
		expect(resp.data).toMatchObject({ delivered: true, stored: 2 });
		expect(saveSpy).toHaveBeenCalledWith(project, "/tmp/a.png", "before");
		expect(saveSpy).toHaveBeenCalledWith(project, "/tmp/b.png", "after");
		const cliPush = pushFn.mock.calls.find((c) => c[0] === "cliShowImage");
		expect(cliPush?.[1].images).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ originalPath: "/tmp/a.png", caption: "before" }),
				expect.objectContaining({ originalPath: "/tmp/b.png", caption: "after" }),
			]),
		);
	});

	it("retains image history beyond the previous per-task cap", async () => {
		const project = makeProject();
		const existing: SharedImage[] = Array.from({ length: 50 }, (_, index) => ({
			id: `old-${index}`,
			storedPath: `/wt/shared-images/old-${index}.png`,
			originalPath: `/tmp/old-${index}.png`,
			name: `old-${index}.png`,
			mime: "image/png",
			bytes: 10,
			createdAt: index,
		}));
		const task = makeTask({ sharedImages: existing });
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.loadTasks).mockResolvedValue([task]);
		let persisted: Task | undefined;
		vi.mocked(data.updateTaskWith).mockImplementation(async (_project, _taskId, mutator) => {
			const { updates, result } = await (mutator as (t: Task) => { updates: Partial<Task>; result: unknown })(task);
			persisted = { ...task, ...updates };
			return { task: persisted, result } as never;
		});

		await handleRequest(makeRequest("ui.show-image", { taskId: task.id, projectId: project.id, paths: ["/tmp/new.png"] }));

		expect(persisted?.sharedImages?.map((image) => image.id)).toEqual([
			...existing.map((image) => image.id),
			"img-/tmp/new.png",
		]);
	});

	it("errors when no paths are given", async () => {
		const project = makeProject();
		const task = makeTask();
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.loadTasks).mockResolvedValue([task]);

		const resp = await handleRequest(makeRequest("ui.show-image", { taskId: task.id, projectId: project.id, paths: [] }));
		expect(resp.ok).toBe(false);
		expect(resp.error).toContain("At least one image path is required");
	});
});

describe("ui.show-artifact", () => {
	it("retains artifact history beyond the previous per-task cap", async () => {
		const project = makeProject();
		const existing: SharedArtifact[] = Array.from({ length: 20 }, (_, index) => ({
			id: `artifact-${index}`,
			kind: "html",
			title: `Artifact ${index}`,
			name: `artifact-${index}.html`,
			storedPath: `/wt/shared-artifacts/artifact-${index}/report.html`,
			originalPath: `/tmp/artifact-${index}.html`,
			bytes: 10,
			createdAt: index,
			assets: [],
		}));
		const task = makeTask({ sharedArtifacts: existing });
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.loadTasks).mockResolvedValue([task]);
		let persisted: Task | undefined;
		vi.mocked(data.updateTaskWith).mockImplementation(async (_project, _taskId, mutator) => {
			const { updates, result } = await (mutator as (t: Task) => { updates: Partial<Task>; result: unknown })(task);
			persisted = { ...task, ...updates };
			return { task: persisted, result } as never;
		});

		await handleRequest(makeRequest("ui.show-artifact", {
			taskId: task.id,
			projectId: project.id,
			htmlPath: "/tmp/report.html",
		}));

		expect(persisted?.sharedArtifacts?.map((artifact) => artifact.id)).toEqual([
			...existing.map((artifact) => artifact.id),
			"artifact-1",
		]);
	});

	it("stores HTML plus local assets and pushes taskUpdated + cliShowArtifact", async () => {
		const project = makeProject();
		const task = makeTask({ seq: 14 });
		const pushFn = vi.fn();
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.loadTasks).mockResolvedValue([task]);
		vi.mocked(getPushMessage).mockReturnValue(pushFn as never);
		vi.mocked(data.updateTaskWith).mockImplementation(async (_project, _taskId, mutator) => {
			const { updates, result } = await (mutator as (t: Task) => Promise<{ updates: Partial<Task>; result: unknown }>)(task);
			return { task: { ...task, ...updates }, result } as never;
		});

		const response = await handleRequest(makeRequest("ui.show-artifact", {
			taskId: task.id,
			projectId: project.id,
			htmlPath: "/tmp/report.html",
			assetPaths: ["/tmp/app.css", "/tmp/app.js", "/tmp/chart.png"],
			title: "Metrics",
		}));

		expect(response.ok).toBe(true);
		expect(saveSharedArtifact).toHaveBeenCalledWith(
			project,
			"/tmp/report.html",
			["/tmp/app.css", "/tmp/app.js", "/tmp/chart.png"],
			"Metrics",
			{ artifactId: undefined, forceNew: false },
		);
		expect(pushFn).toHaveBeenCalledWith("taskUpdated", expect.objectContaining({ projectId: project.id }));
		expect(pushFn).toHaveBeenCalledWith(
			"cliShowArtifact",
			expect.objectContaining({ taskId: task.id, newCount: 1, taskSeq: task.seq }),
		);
	});

	it("re-publishing the same title adds a version to the one row", async () => {
		const project = makeProject();
		const task = makeTask({
			sharedArtifacts: [{
				id: "existing",
				groupKey: "title:metrics",
				version: 1,
				kind: "html",
				title: "Metrics",
				name: "old.html",
				storedPath: "/wt/shared-artifacts/existing/old.html",
				originalPath: "/tmp/old.html",
				bytes: 5,
				createdAt: 1,
				assets: [],
			}],
		});
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.loadTasks).mockResolvedValue([task]);
		let persisted: Task | undefined;
		vi.mocked(data.updateTaskWith).mockImplementation(async (_project, _taskId, mutator) => {
			const { updates, result } = await (mutator as (t: Task) => { updates: Partial<Task>; result: unknown })(task);
			persisted = { ...task, ...updates };
			return { task: persisted, result } as never;
		});

		const response = await handleRequest(makeRequest("ui.show-artifact", {
			taskId: task.id,
			projectId: project.id,
			htmlPath: "/tmp/report.html",
			title: "Metrics",
		}));

		expect(response.ok).toBe(true);
		expect(response.data).toMatchObject({ version: 2 });
		expect(persisted?.sharedArtifacts).toHaveLength(1);
		const merged = persisted?.sharedArtifacts?.[0];
		expect(merged?.id).toBe("existing");
		expect(merged?.version).toBe(2);
		expect(merged?.name).toBe("report.html");
		expect(merged?.previousVersions?.map((entry) => entry.storedPath)).toEqual(["/wt/shared-artifacts/existing/old.html"]);
	});

	it("collapses pre-versioning rows sharing a title on the next publish", async () => {
		const project = makeProject();
		const legacy: SharedArtifact[] = [1, 2, 3].map((n) => ({
			id: `legacy-${n}`,
			kind: "html",
			title: "Metrics",
			name: `legacy-${n}.html`,
			storedPath: `/wt/shared-artifacts/legacy-${n}/report.html`,
			originalPath: `/tmp/legacy-${n}.html`,
			bytes: 5,
			createdAt: n,
			assets: [],
		}));
		const task = makeTask({ sharedArtifacts: legacy });
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.loadTasks).mockResolvedValue([task]);
		let persisted: Task | undefined;
		vi.mocked(data.updateTaskWith).mockImplementation(async (_project, _taskId, mutator) => {
			const { updates, result } = await (mutator as (t: Task) => { updates: Partial<Task>; result: unknown })(task);
			persisted = { ...task, ...updates };
			return { task: persisted, result } as never;
		});

		await handleRequest(makeRequest("ui.show-artifact", {
			taskId: task.id,
			projectId: project.id,
			htmlPath: "/tmp/report.html",
			title: "Metrics",
		}));

		expect(persisted?.sharedArtifacts).toHaveLength(1);
		expect(persisted?.sharedArtifacts?.[0].id).toBe("legacy-1");
		expect(persisted?.sharedArtifacts?.[0].version).toBe(4);
		// Every stored path survives the collapse — nothing on disk is dropped.
		expect(persisted?.sharedArtifacts?.[0].previousVersions?.map((entry) => entry.storedPath)).toEqual([
			"/wt/shared-artifacts/legacy-1/report.html",
			"/wt/shared-artifacts/legacy-2/report.html",
			"/wt/shared-artifacts/legacy-3/report.html",
		]);
	});

	it("--new keeps the publish as its own artifact", async () => {
		const project = makeProject();
		const task = makeTask({
			sharedArtifacts: [{
				id: "existing",
				groupKey: "title:metrics",
				version: 1,
				kind: "html",
				title: "Metrics",
				name: "old.html",
				storedPath: "/wt/shared-artifacts/existing/old.html",
				originalPath: "/tmp/old.html",
				bytes: 5,
				createdAt: 1,
				assets: [],
			}],
		});
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.loadTasks).mockResolvedValue([task]);
		let persisted: Task | undefined;
		vi.mocked(data.updateTaskWith).mockImplementation(async (_project, _taskId, mutator) => {
			const { updates, result } = await (mutator as (t: Task) => { updates: Partial<Task>; result: unknown })(task);
			persisted = { ...task, ...updates };
			return { task: persisted, result } as never;
		});

		await handleRequest(makeRequest("ui.show-artifact", {
			taskId: task.id,
			projectId: project.id,
			htmlPath: "/tmp/report.html",
			title: "Metrics",
			forceNew: true,
		}));

		expect(saveSharedArtifact).toHaveBeenCalledWith(
			project,
			"/tmp/report.html",
			[],
			"Metrics",
			{ artifactId: undefined, forceNew: true },
		);
		expect(persisted?.sharedArtifacts?.map((artifact) => artifact.id)).toEqual(["existing", "artifact-1"]);
	});

	it("groups on --artifact-id even when the title was reworded", async () => {
		const project = makeProject();
		const task = makeTask({
			sharedArtifacts: [{
				id: "existing",
				groupKey: "id:weekly",
				version: 1,
				kind: "html",
				title: "Old wording",
				name: "old.html",
				storedPath: "/wt/shared-artifacts/existing/old.html",
				originalPath: "/tmp/old.html",
				bytes: 5,
				createdAt: 1,
				assets: [],
			}],
		});
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.loadTasks).mockResolvedValue([task]);
		let persisted: Task | undefined;
		vi.mocked(data.updateTaskWith).mockImplementation(async (_project, _taskId, mutator) => {
			const { updates, result } = await (mutator as (t: Task) => { updates: Partial<Task>; result: unknown })(task);
			persisted = { ...task, ...updates };
			return { task: persisted, result } as never;
		});

		await handleRequest(makeRequest("ui.show-artifact", {
			taskId: task.id,
			projectId: project.id,
			htmlPath: "/tmp/report.html",
			title: "Brand new wording",
			artifactId: "weekly",
		}));

		expect(persisted?.sharedArtifacts).toHaveLength(1);
		expect(persisted?.sharedArtifacts?.[0].version).toBe(2);
		// The newest title wins on the row the user sees.
		expect(persisted?.sharedArtifacts?.[0].title).toBe("Brand new wording");
	});

	it("rejects a missing HTML path", async () => {
		const project = makeProject();
		const task = makeTask();
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.loadTasks).mockResolvedValue([task]);
		const response = await handleRequest(makeRequest("ui.show-artifact", { taskId: task.id, projectId: project.id }));
		expect(response.ok).toBe(false);
		expect(response.error).toContain("HTML artifact path is required");
	});

	it("focus mode queues cliShowArtifact after persisting it", async () => {
		const project = makeProject();
		const task = makeTask({ seq: 14 });
		const pushFn = vi.fn();
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.loadTasks).mockResolvedValue([task]);
		vi.mocked(getPushMessage).mockReturnValue(pushFn as never);
		vi.mocked(data.updateTaskWith).mockImplementation(async (_project, _taskId, mutator) => {
			const { updates, result } = await (mutator as (t: Task) => Promise<{ updates: Partial<Task>; result: unknown }>)(task);
			return { task: { ...task, ...updates }, result } as never;
		});
		vi.mocked(loadSettings).mockReturnValueOnce({ focusMode: true } as never);
		vi.mocked(isNotificationSuppressed).mockReturnValue(true);

		const response = await handleRequest(makeRequest("ui.show-artifact", {
			taskId: task.id,
			projectId: project.id,
			htmlPath: "/tmp/report.html",
		}));

		expect(response.ok).toBe(true);
		expect(response.data).toMatchObject({ delivered: true, queued: true, stored: 1 });
		expect(pushFn).toHaveBeenCalledWith("taskUpdated", expect.anything());
		expect(pushCliShowArtifact).toHaveBeenCalledWith(expect.objectContaining({ taskId: task.id, newCount: 1 }));
	});
});

describe("artifact.template-dir", () => {
	it("provisions the starter on demand and answers with its path, or reports the failure instead of inventing one", async () => {
		{
			const project = makeProject();
			const task = makeTask();
			vi.mocked(data.getProject).mockResolvedValue(project);
			vi.mocked(data.loadTasks).mockResolvedValue([task]);
			const { provisionArtifactStarter } = await import("../artifact-template");

			const resp = await handleRequest(makeRequest("artifact.template-dir", {
				taskId: task.id,
				projectId: project.id,
				worktreePath: "/wt-container/worktree",
			}));

			expect(resp.ok).toBe(true);
			expect(resp.data).toMatchObject({ dir: "/wt-container/artifact-template-v1", mode: "on", taskId: task.id });
			expect(provisionArtifactStarter).toHaveBeenCalledWith(project, task, { worktreePath: "/wt-container/worktree" });
		}
		vi.clearAllMocks();
		{
			const project = makeProject();
			const task = makeTask();
			vi.mocked(data.getProject).mockResolvedValue(project);
			vi.mocked(data.loadTasks).mockResolvedValue([task]);
			const { provisionArtifactStarter } = await import("../artifact-template");
			vi.mocked(provisionArtifactStarter).mockImplementationOnce(() => {
				throw new Error("Bundled dev3 artifact template not found");
			});

			const resp = await handleRequest(makeRequest("artifact.template-dir", { taskId: task.id, projectId: project.id }));

			expect(resp.ok).toBe(false);
			expect(resp.error).toContain("artifact template not found");
		}
	});
});

describe("ui control (notify / attention / state)", () => {
	it("ui.notify: pushes a cliToast without a task, keeps a custom duration, and logs null provenance", async () => {
		const pushFn = vi.fn();
		vi.mocked(getPushMessage).mockReturnValue(pushFn);

		const resp = await handleRequest(makeRequest("ui.notify", { message: "hello", level: "info" }));
		expect(resp.ok).toBe(true);
		expect(resp.data).toMatchObject({ delivered: true, mode: "toast", taskId: null });
		expect(pushFn).toHaveBeenCalledWith("cliToast", {
			taskId: null,
			projectId: null,
			message: "hello",
			level: "info",
		});
		// A task-less row records null provenance, never a guess.
		const row = vi.mocked(appendNotificationLog).mock.calls[0][0];
		expect(row).toMatchObject({ taskId: null, taskSeq: null, projectId: null, sourceTaskId: null, sourceSeq: null });
		expect(row).not.toHaveProperty("sourceSessionId");
		expect(row).not.toHaveProperty("sourceTitle");

		await handleRequest(makeRequest("ui.notify", { message: "brief", level: "info", durationMs: 2_000 }));
		expect(pushFn).toHaveBeenCalledWith("cliToast", expect.objectContaining({ message: "brief", durationMs: 2_000 }));
	});

	it("ui.notify: rejects a bad duration, level, empty message or task-less --desktop, and logs none of them", async () => {
		const cases: Array<[Record<string, unknown>, string]> = [
			[{ message: "brief", durationMs: 31_000 }, "durationMs must be between 2000ms and 30000ms"],
			[{ message: "x", level: "warning" }, "Invalid level"],
			[{ message: "   " }, "message is required"],
			[{ message: "x", desktop: true }, "requires a task"],
		];
		for (const [params, error] of cases) {
			const resp = await handleRequest(makeRequest("ui.notify", params));
			expect(resp, error).toMatchObject({ ok: false, error: expect.stringContaining(error) });
		}
		expect(appendNotificationLog).not.toHaveBeenCalled();
	});

	it("ui.notify: queues the cliToast during suppression and logs what held it back", async () => {
		vi.mocked(isNotificationSuppressed).mockReturnValue(true);
		vi.mocked(activeNotificationSuppression).mockReturnValue(["focusMode"]);

		const resp = await handleRequest(makeRequest("ui.notify", { message: "hello", level: "info" }));

		expect(resp.ok).toBe(true);
		expect(resp.data).toMatchObject({ delivered: true, mode: "toast", queued: true });
		expect(pushCliToast).toHaveBeenCalledWith({
			taskId: null,
			projectId: null,
			message: "hello",
			level: "info",
		});
		expect(appendNotificationLog).toHaveBeenCalledWith(
			expect.objectContaining({ outcome: "queued", suppressedBy: ["focusMode"] }),
		);
	});

	it("ui.notify: focus mode queues the toast instead of pushing it", async () => {
		const pushFn = vi.fn();
		vi.mocked(getPushMessage).mockReturnValue(pushFn);
		vi.mocked(loadSettings).mockReturnValueOnce({ focusMode: true } as never);
		vi.mocked(isNotificationSuppressed).mockReturnValue(true);

		const resp = await handleRequest(makeRequest("ui.notify", { message: "hi" }));
		expect(resp.data).toMatchObject({ delivered: true, queued: true });
		expect(pushFn).not.toHaveBeenCalled();
		expect(setFocusMode).toHaveBeenCalledWith(true);
	});

	it("ui.notify: resolves the task so the toast is clickable, and logs target and caller", async () => {
		const project = makeProject();
		const task = makeTask();
		const pushFn = vi.fn();
		vi.mocked(data.loadProjects).mockResolvedValue([project]);
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.loadTasks).mockResolvedValue([task]);
		vi.mocked(getPushMessage).mockReturnValue(pushFn);

		const resp = await handleRequest(
			makeRequest("ui.notify", {
				message: "done", level: "success", taskId: task.id, projectId: project.id,
				sourceTaskId: task.id, sourceSessionId: "session-abc",
			}),
		);
		expect(resp.ok).toBe(true);
		expect(appendNotificationLog).toHaveBeenCalledWith(
			expect.objectContaining({
				mode: "toast",
				level: "success",
				message: "done",
				outcome: "delivered",
				taskId: task.id,
				taskSeq: task.seq,
				projectId: project.id,
				sourceTaskId: task.id,
				sourceSeq: task.seq,
				sourceSessionId: "session-abc",
			}),
		);
		expect(pushFn).toHaveBeenCalledWith(
			"cliToast",
			expect.objectContaining({
				taskId: task.id,
				projectId: project.id,
				message: "done",
				level: "success",
				taskSeq: task.seq,
				projectName: project.name,
			}),
		);
	});

	it("ui.notify: --desktop fires a native notification via notifyFromCliDesktop", async () => {
		const project = makeProject();
		const task = makeTask({ seq: 7 });
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.loadTasks).mockResolvedValue([task]);

		const resp = await handleRequest(
			makeRequest("ui.notify", { message: "needs you", desktop: true, taskId: task.id, projectId: project.id }),
		);
		expect(resp.ok).toBe(true);
		expect(resp.data).toMatchObject({ delivered: true, mode: "desktop", taskId: task.id });
		expect(notifyFromCliDesktop).toHaveBeenCalledWith(
			expect.objectContaining({
				task: expect.objectContaining({ id: task.id }),
				body: "needs you",
				projectName: project.name,
			}),
		);
		expect(appendNotificationLog).toHaveBeenCalledWith(
			expect.objectContaining({ mode: "desktop", outcome: "delivered", taskId: task.id }),
		);
	});

	it("ui.notify: records `no-window` when nothing could be shown", async () => {
		vi.mocked(getPushMessage).mockReturnValue(null);

		const resp = await handleRequest(makeRequest("ui.notify", { message: "unseen" }));

		expect(resp.data).toMatchObject({ delivered: false });
		expect(appendNotificationLog).toHaveBeenCalledWith(expect.objectContaining({ outcome: "no-window" }));
	});

	it("ui.notify: the CLI's fan-out copy is not recorded a second time", async () => {
		vi.mocked(getPushMessage).mockReturnValue(vi.fn());

		await handleRequest(makeRequest("ui.notify", { message: "once", fanout: true }));

		expect(appendNotificationLog).not.toHaveBeenCalled();
	});

	it("ui.notify: a silenced project leaves no row, on either surface", async () => {
		const project = makeProject();
		const task = makeTask();
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.loadTasks).mockResolvedValue([task]);
		vi.mocked(isProjectSilenced).mockReturnValue(true);
		vi.mocked(isNotificationSuppressed).mockReturnValue(true);

		await handleRequest(makeRequest("ui.notify", { message: "hidden", taskId: task.id, projectId: project.id }));
		await handleRequest(
			makeRequest("ui.notify", { message: "hidden", desktop: true, taskId: task.id, projectId: project.id }),
		);

		expect(appendNotificationLog).not.toHaveBeenCalled();
	});

	it("ui.attention: pushes cliAttention for the resolved task, and queues it under focus mode", async () => {
		{
			const project = makeProject();
			const task = makeTask();
			const pushFn = vi.fn();
			vi.mocked(data.getProject).mockResolvedValue(project);
			vi.mocked(data.loadTasks).mockResolvedValue([task]);
			vi.mocked(getPushMessage).mockReturnValue(pushFn);

			const resp = await handleRequest(
				makeRequest("ui.attention", { taskId: task.id, projectId: project.id, reason: "PR ready" }),
			);
			expect(resp.ok).toBe(true);
			expect(resp.data).toMatchObject({ delivered: true, taskId: task.id });
			expect(pushFn).toHaveBeenCalledWith("cliAttention", { taskId: task.id, reason: "PR ready" });
		}
		vi.clearAllMocks();
		{
			const project = makeProject();
			const task = makeTask();
			const pushFn = vi.fn();
			vi.mocked(data.getProject).mockResolvedValue(project);
			vi.mocked(data.loadTasks).mockResolvedValue([task]);
			vi.mocked(getPushMessage).mockReturnValue(pushFn);
			vi.mocked(loadSettings).mockReturnValueOnce({ focusMode: true } as never);
			vi.mocked(isNotificationSuppressed).mockReturnValue(true);

			const resp = await handleRequest(makeRequest("ui.attention", { taskId: task.id, projectId: project.id, reason: "x" }));
			expect(resp.ok).toBe(true);
			expect(resp.data).toMatchObject({ delivered: true, queued: true });
			expect(pushFn).not.toHaveBeenCalled();
			expect(pushCliAttention).toHaveBeenCalledWith({ taskId: task.id, projectId: task.projectId, reason: "x" });
		}
	});

	it("ui.attention --clear: lowers the badge even while focus mode suppresses new ones", async () => {
		const project = makeProject();
		const task = makeTask();
		const pushFn = vi.fn();
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.loadTasks).mockResolvedValue([task]);
		vi.mocked(getPushMessage).mockReturnValue(pushFn);
		vi.mocked(loadSettings).mockReturnValueOnce({ focusMode: true } as never);
		vi.mocked(isNotificationSuppressed).mockReturnValue(true);

		const resp = await handleRequest(
			makeRequest("ui.attention", { taskId: task.id, projectId: project.id, reason: "", clear: true }),
		);

		expect(resp.ok).toBe(true);
		expect(resp.data).toMatchObject({ delivered: true, taskId: task.id });
		expect(dropQueuedAttention).toHaveBeenCalledWith(task.id);
		expect(pushCliAttention).not.toHaveBeenCalled();
		expect(pushFn).toHaveBeenCalledWith("cliAttention", { taskId: task.id, reason: "", clear: true });
	});

	it("ui.state: reports foreground and active context", async () => {
		vi.mocked(isAppForeground).mockReturnValue(true);
		vi.mocked(getActiveContext).mockReturnValue({ projectId: "proj-1", taskId: "task-9" });

		const resp = await handleRequest(makeRequest("ui.state"));
		expect(resp.ok).toBe(true);
		expect(resp.data).toEqual({
			appRunning: true,
			foreground: true,
			activeProjectId: "proj-1",
			activeTaskId: "task-9",
			userIdleSeconds: 7,
			tmux: null,
		});

		const withTask = await handleRequest(makeRequest("ui.state", { taskId: "task-abc" }));
		expect((withTask.data as { tmux: unknown }).tmux).toMatchObject({ sessionName: "dev3-task1234", exists: false });
	});
});

describe("task.update", () => {

	it("updates title with projectId", async () => {
		const project = makeProject();
		const task = makeTask();
		const updated = { ...task, customTitle: "Updated" };
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.loadTasks).mockResolvedValue([task]);
		vi.mocked(data.updateTask).mockResolvedValue(updated);
		vi.mocked(getPushMessage).mockReturnValue(vi.fn());

		const resp = await handleRequest(
			makeRequest("task.update", { taskId: task.id, projectId: "proj-1", title: "Updated" }),
		);
		expect(resp.ok).toBe(true);
		expect(data.updateTask).toHaveBeenCalledWith(project, task.id, { customTitle: "Updated" });
		const result = resp.data as { task: Task; titlePreserved: boolean };
		expect(result.task.id).toBe(task.id);
		expect(result.titlePreserved).toBe(false);
	});

	it("opts a task in to self-completion when another task asks, and tells the user", async () => {
		const project = makeProject();
		const task = makeTask();
		const pushFn = vi.fn();
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.loadTasks).mockResolvedValue([task]);
		vi.mocked(data.updateTask).mockResolvedValue({ ...task, selfCompletion: true });
		vi.mocked(getPushMessage).mockReturnValue(pushFn);

		const resp = await handleRequest(makeRequest("task.update", {
			taskId: task.id, projectId: project.id, selfCompletion: true, sourceTaskId: "some-coordinator-task",
		}));

		expect(resp.ok).toBe(true);
		expect(data.updateTask).toHaveBeenCalledWith(project, task.id, { selfCompletion: true });
		expect(pushFn).toHaveBeenCalledWith("manualCompletionChanged", expect.objectContaining({ taskId: task.id, selfCompletion: true }));
		expect(clearMergeNotification).toHaveBeenCalledWith(task.id);
	});

	it("refuses a task opting itself in to self-completion", async () => {
		const project = makeProject();
		const task = makeTask();
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.loadTasks).mockResolvedValue([task]);

		const resp = await handleRequest(makeRequest("task.update", {
			taskId: task.id, projectId: project.id, selfCompletion: true, sourceTaskId: task.id,
		}));

		expect(resp.ok).toBe(false);
		expect(resp.error).toContain("cannot opt itself in");
		expect(data.updateTask).not.toHaveBeenCalled();
	});

	it("updates manual completion and emits an agent-only change event", async () => {
		const project = makeProject();
		const task = makeTask({ manualCompletion: false });
		const updated = { ...task, manualCompletion: true, mergeCompletionPrompt: null };
		const pushFn = vi.fn();
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.loadTasks).mockResolvedValue([task]);
		vi.mocked(data.updateTask).mockResolvedValue(updated);
		vi.mocked(getPushMessage).mockReturnValue(pushFn);

		const resp = await handleRequest(makeRequest("task.update", {
			taskId: task.id,
			projectId: project.id,
			manualCompletion: true,
		}));

		expect(resp.ok).toBe(true);
		// No stored merge prompt to reset, so the patch carries only the policy.
		expect(data.updateTask).toHaveBeenCalledWith(project, task.id, { manualCompletion: true });
		expect(clearMergeNotification).toHaveBeenCalledWith(task.id);
		expect(pushFn).toHaveBeenCalledWith("manualCompletionChanged", {
			taskId: task.id,
			projectId: project.id,
			manualCompletion: true,
			taskSeq: task.seq,
			taskTitle: "Test task",
			projectName: project.name,
		});
	});

	// The hole the coordinator flagged: flipping the field alone would leave a card
	// wearing a badge its agent was never told about.
	describe("task.update --type", () => {
		it("promotes a task, prepends the role preamble, and tells the running agent", async () => {
			const project = makeProject();
			const task = makeTask({ description: "coordinate my board" });
			vi.mocked(data.getProject).mockResolvedValue(project);
			vi.mocked(data.loadTasks).mockResolvedValue([task]);
			vi.mocked(data.updateTask).mockImplementation(async (_p, _id, updates) => ({ ...task, ...updates }));

			const resp = await handleRequest(makeRequest("task.update", {
				taskId: task.id,
				projectId: project.id,
				taskType: "coordinator",
			}));

			expect(resp.ok).toBe(true);
			const updates = vi.mocked(data.updateTask).mock.calls[0]![2] as Partial<Task>;
			expect(updates.taskType).toBe("coordinator");
			expect(updates.description!.startsWith(COORDINATOR_PROMPT)).toBe(true);
			expect(updates.description!.endsWith("coordinate my board")).toBe(true);
			expect(vi.mocked(deliverAgentPrompt).mock.calls[0]![1]).toContain(COORDINATOR_PROMPT);
			expect((resp.data as { roleDelivery?: string }).roleDelivery).toBe("delivered");
		});

		it("demotes a task and strips the preamble back off", async () => {
			const project = makeProject();
			const task = makeTask({
				taskType: "coordinator",
				description: withPresetPrompt("coordinate my board", COORDINATOR_PROMPT),
			});
			vi.mocked(data.getProject).mockResolvedValue(project);
			vi.mocked(data.loadTasks).mockResolvedValue([task]);
			vi.mocked(data.updateTask).mockImplementation(async (_p, _id, updates) => ({ ...task, ...updates }));

			const resp = await handleRequest(makeRequest("task.update", {
				taskId: task.id,
				projectId: project.id,
				taskType: "standard",
			}));

			expect(resp.ok).toBe(true);
			const updates = vi.mocked(data.updateTask).mock.calls[0]![2] as Partial<Task>;
			expect(updates.taskType).toBeNull();
			expect(updates.description).toBe("coordinate my board");
			expect(vi.mocked(deliverAgentPrompt).mock.calls[0]![1]).toContain("no longer carries a special role");
		});

		it("swaps one role's brief for another, leaving no trace of the old one and delivering the new", async () => {
			const swaps: Array<[Task["taskType"], string, string]> = [
				["pr-review", DEFAULT_PR_REVIEW_PROMPT, DEFAULT_PR_REVIEW_PROMPT.slice(0, 40)],
				["board-cleanup", BOARD_CLEANUP_PROMPT, "a BOARD CLEANUP adviser"],
			];
			for (const [taskType, brief, delivered] of swaps) {
				vi.mocked(data.updateTask).mockClear();
				vi.mocked(deliverAgentPrompt).mockClear();
				const project = makeProject();
				const task = makeTask({ taskType: "coordinator", description: withPresetPrompt("look at this branch", COORDINATOR_PROMPT) });
				vi.mocked(data.getProject).mockResolvedValue(project);
				vi.mocked(data.loadTasks).mockResolvedValue([task]);
				vi.mocked(data.updateTask).mockImplementation(async (_p, _id, updates) => ({ ...task, ...updates }));
				const resp = await handleRequest(makeRequest("task.update", { taskId: task.id, projectId: project.id, taskType }));
				expect(resp.ok, String(taskType)).toBe(true);
				const updates = vi.mocked(data.updateTask).mock.calls[0]![2] as Partial<Task>;
				expect(updates.taskType).toBe(taskType);
				expect(updates.description).toBe(withPresetPrompt("look at this branch", brief));
				expect(updates.description).not.toContain(COORDINATOR_PROMPT);
				expect(vi.mocked(deliverAgentPrompt).mock.calls[0]![1]).toContain(delivered);
			}
		});

		it("says plainly when there is no session to tell", async () => {
			const project = makeProject();
			const task = makeTask({ worktreePath: null });
			vi.mocked(data.getProject).mockResolvedValue(project);
			vi.mocked(data.loadTasks).mockResolvedValue([task]);
			vi.mocked(data.updateTask).mockImplementation(async (_p, _id, updates) => ({ ...task, ...updates }));

			const resp = await handleRequest(makeRequest("task.update", {
				taskId: task.id,
				projectId: project.id,
				taskType: "coordinator",
			}));

			expect(resp.ok).toBe(true);
			expect((resp.data as { roleDelivery?: string }).roleDelivery).toBe("no-session");
			expect(deliverAgentPrompt).not.toHaveBeenCalled();
		});

		// /dev3-coordinator promotes the task its own agent is running in, so the
		// brief travels back in the response instead of into that agent's pane.
		it("prints the brief instead of typing it into the caller's own pane", async () => {
			const project = makeProject();
			const task = makeTask({ description: "coordinate my board" });
			vi.mocked(data.getProject).mockResolvedValue(project);
			vi.mocked(data.loadTasks).mockResolvedValue([task]);
			vi.mocked(data.updateTask).mockImplementation(async (_p, _id, updates) => ({ ...task, ...updates }));

			const resp = await handleRequest(makeRequest("task.update", {
				taskId: task.id,
				projectId: project.id,
				taskType: "coordinator",
				printRole: true,
			}));

			expect(resp.ok).toBe(true);
			const body = resp.data as { roleDelivery?: string; rolePrompt?: string; rolePromptSource?: string };
			expect(body.roleDelivery).toBe("printed");
			expect(body.rolePrompt).toBe(COORDINATOR_PROMPT);
			expect(body.rolePromptSource).toBe("built-in");
			// The mid-conversation channel carries the same defaults as a coordinator
			// that started as one — including create-and-launch.
			expect(body.rolePrompt).toContain("CREATING A TASK MEANS STARTING IT");
			expect(body.rolePrompt).toContain("a timeout is NOT a decline");
			expect(deliverAgentPrompt).not.toHaveBeenCalled();
			const updates = vi.mocked(data.updateTask).mock.calls[0]![2] as Partial<Task>;
			expect(updates.taskType).toBe("coordinator");
			expect(updates.description!.startsWith(COORDINATOR_PROMPT)).toBe(true);
		});

		// The whole reason the skill prints instead of carrying its own copy: a
		// project that rewrote the brief must get ITS brief, not the built-in one.
		it("prints the project's own brief when one overrides the built-in", async () => {
			const project = { ...makeProject(), coordinatorPrompt: "You coordinate MY board, my way." };
			const task = makeTask({ description: "coordinate my board" });
			vi.mocked(data.getProject).mockResolvedValue(project);
			vi.mocked(data.loadTasks).mockResolvedValue([task]);
			vi.mocked(data.updateTask).mockImplementation(async (_p, _id, updates) => ({ ...task, ...updates }));

			const resp = await handleRequest(makeRequest("task.update", {
				taskId: task.id,
				projectId: project.id,
				taskType: "coordinator",
				printRole: true,
			}));

			expect(resp.ok).toBe(true);
			const body = resp.data as { rolePrompt?: string; rolePromptSource?: string };
			expect(body.rolePrompt).toBe("You coordinate MY board, my way.");
			// The skill's embedded built-in copy must yield to this, and the source line is how it knows.
			expect(body.rolePromptSource).toBe("project");
		});

		it("re-prints the brief on a repeat that changes nothing on the board", async () => {
			const project = makeProject();
			const task = makeTask({
				taskType: "coordinator",
				description: withPresetPrompt("coordinate my board", COORDINATOR_PROMPT),
			});
			vi.mocked(data.getProject).mockResolvedValue(project);
			vi.mocked(data.loadTasks).mockResolvedValue([task]);

			const resp = await handleRequest(makeRequest("task.update", {
				taskId: task.id,
				projectId: project.id,
				taskType: "coordinator",
				printRole: true,
			}));

			expect(resp.ok).toBe(true);
			const body = resp.data as { roleDelivery?: string; rolePrompt?: string };
			expect(body.rolePrompt).toBe(COORDINATOR_PROMPT);
			expect(body.roleDelivery).toBeUndefined();
			expect(data.updateTask).not.toHaveBeenCalled();
			expect(deliverAgentPrompt).not.toHaveBeenCalled();
		});

		it("rejects an unknown type, and skips the type the task already has, without writing anything", async () => {
			const project = makeProject();
			const task = makeTask();
			vi.mocked(data.getProject).mockResolvedValue(project);
			vi.mocked(data.loadTasks).mockResolvedValue([task]);

			const resp = await handleRequest(makeRequest("task.update", {
				taskId: task.id,
				projectId: project.id,
				taskType: "overlord",
			}));

			expect(resp.ok).toBe(false);

			// The type the task already has: nothing to write, nobody to tell.
			vi.mocked(data.loadTasks).mockResolvedValue([makeTask({ taskType: "coordinator" })]);
			const same = await handleRequest(makeRequest("task.update", { taskId: task.id, projectId: project.id, taskType: "coordinator" }));
			expect(same.ok).toBe(true);
			expect(data.updateTask).not.toHaveBeenCalled();
			expect(deliverAgentPrompt).not.toHaveBeenCalled();
		});
	});

	it("qualifies refs in a description written from a task on another board", async () => {
		const project = makeProject();
		const task = makeTask({ customTitle: "Mine" });
		const writer = makeTask({ id: "writer-00-1111-2222-333333333333", projectId: "proj-2", seq: 9 });
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.loadProjects).mockResolvedValue([project, makeProject({ id: "proj-2", name: "Other" })]);
		vi.mocked(data.loadVirtualProjects).mockResolvedValue([]);
		vi.mocked(data.loadTasks).mockImplementation(async (p) => (p.id === "proj-2" ? [writer] : [task]));
		vi.mocked(data.updateTask).mockImplementation(async (_p, _id, change) => ({ ...task, ...change }));
		vi.mocked(getPushMessage).mockReturnValue(null);

		await handleRequest(makeRequest("task.update", { taskId: task.id, projectId: "proj-1", description: "blocked on seq:60", sourceTaskId: writer.id }));
		await handleRequest(makeRequest("task.update", { taskId: task.id, projectId: "proj-1", description: "blocked on seq:60", sourceTaskId: task.id }));
		await handleRequest(makeRequest("task.update", { taskId: task.id, projectId: "proj-1", description: "blocked on seq:60" }));
		expect(vi.mocked(data.updateTask).mock.calls.map((c) => c[2].description))
			.toEqual(["blocked on seq:proj-2/60", "blocked on seq:60", "blocked on seq:60"]);
	});

	it("leaves the target board's own refs alone when another board's agent edits its description", async () => {
		const project = makeProject();
		const task = makeTask({ customTitle: "Mine", description: "Goal.\nAfter seq:3 lands." });
		const writer = makeTask({ id: "writer-00-1111-2222-333333333333", projectId: "proj-2", seq: 9 });
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.loadProjects).mockResolvedValue([project, makeProject({ id: "proj-2", name: "Other" })]);
		vi.mocked(data.loadVirtualProjects).mockResolvedValue([]);
		vi.mocked(data.loadTasks).mockImplementation(async (p) => (p.id === "proj-2" ? [writer] : [task]));
		vi.mocked(data.updateTask).mockImplementation(async (_p, _id, change) => ({ ...task, ...change }));
		vi.mocked(getPushMessage).mockReturnValue(null);

		await handleRequest(makeRequest("task.update", {
			taskId: task.id, projectId: "proj-1", description: "Goal.\nAfter seq:3 lands.\nAlso waits on seq:60.", sourceTaskId: writer.id,
		}));
		expect(vi.mocked(data.updateTask).mock.calls[0]![2].description).toBe("Goal.\nAfter seq:3 lands.\nAlso waits on seq:proj-2/60.");
	});

	it("leaves an auto-generated title alone when another board's agent writes it back", async () => {
		const project = makeProject();
		const task = makeTask({ title: "After seq:3 lands", customTitle: null });
		const writer = makeTask({ id: "writer-00-1111-2222-333333333333", projectId: "proj-2", seq: 9 });
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.loadProjects).mockResolvedValue([project, makeProject({ id: "proj-2", name: "Other" })]);
		vi.mocked(data.loadVirtualProjects).mockResolvedValue([]);
		vi.mocked(data.loadTasks).mockImplementation(async (p) => (p.id === "proj-2" ? [writer] : [task]));
		vi.mocked(data.updateTask).mockImplementation(async (_p, _id, change) => ({ ...task, ...change }));
		vi.mocked(getPushMessage).mockReturnValue(null);

		await handleRequest(makeRequest("task.update", { taskId: task.id, projectId: "proj-1", title: "After seq:3 lands", sourceTaskId: writer.id }));
		expect(vi.mocked(data.updateTask).mock.calls[0]![2]).toMatchObject({ customTitle: "After seq:3 lands" });
	});

	// Issue #564 — agent following its skill must not overwrite a title the user
	// already set via the UI. The CLI is the agent-facing entry point; refuse to
	// overwrite the title when titleEditedByUser is true, unless --force is passed.
	it("preserves user-edited title when --title is provided without --force", async () => {
		const project = makeProject();
		const task = makeTask({ customTitle: "User-set title", titleEditedByUser: true });
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.loadTasks).mockResolvedValue([task]);
		vi.mocked(getPushMessage).mockReturnValue(null);

		const resp = await handleRequest(
			makeRequest("task.update", {
				taskId: task.id,
				projectId: "proj-1",
				title: "Agent-proposed rename",
			}),
		);
		expect(resp.ok).toBe(true);
		// updateTask must NOT be called — nothing to write.
		expect(data.updateTask).not.toHaveBeenCalled();
		const result = resp.data as { task: Task; titlePreserved: boolean };
		expect(result.titlePreserved).toBe(true);
		expect(result.task.customTitle).toBe("User-set title");
	});

	// Re-opened #583 — a customTitle set by a previous agent (titleEditedByUser
	// is false) is NOT protected, otherwise the title gets frozen forever on
	// whatever the first agent wrote. Later agents must be able to rewrite it.
	it("overwrites agent-set customTitle (titleEditedByUser=false) without --force", async () => {
		const project = makeProject();
		const task = makeTask({ customTitle: "Old agent title", titleEditedByUser: false });
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.loadTasks).mockResolvedValue([task]);
		vi.mocked(data.updateTask).mockResolvedValue({ ...task, customTitle: "New agent title" });
		vi.mocked(getPushMessage).mockReturnValue(null);

		const resp = await handleRequest(
			makeRequest("task.update", {
				taskId: task.id,
				projectId: "proj-1",
				title: "New agent title",
			}),
		);
		expect(resp.ok).toBe(true);
		const call = vi.mocked(data.updateTask).mock.calls[0][2];
		expect(call.customTitle).toBe("New agent title");
		// CLI must never claim a user edit — only the UI rename RPC sets that flag.
		expect(call.titleEditedByUser).toBeUndefined();
		const result = resp.data as { task: Task; titlePreserved: boolean };
		expect(result.titlePreserved).toBe(false);
	});

	// The whole review-task naming design rests on this: dev3 writes a DRAFT title
	// at creation and the reviewing agent is told to replace it. The draft lives in
	// `title` with NO customTitle at all, which is a shape the guard's other cases
	// never exercise — if it were protected, the prompt's instruction could not be
	// carried out and every review card would keep the PR author's own wording.
	it("lets an agent rename over dev3's drafted review title", async () => {
		const project = makeProject();
		const task = makeTask({
			title: "Review of #493 from Arseny Pavlenko about pin tmux to a vendored",
			customTitle: undefined,
			titleEditedByUser: false,
		});
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.loadTasks).mockResolvedValue([task]);
		vi.mocked(data.updateTask).mockResolvedValue({ ...task, customTitle: "Review of #493 from Arseny Pavlenko about drop the PATH shim" });
		vi.mocked(getPushMessage).mockReturnValue(null);

		const resp = await handleRequest(
			makeRequest("task.update", {
				taskId: task.id,
				projectId: "proj-1",
				title: "Review of #493 from Arseny Pavlenko about drop the PATH shim",
			}),
		);

		expect(resp.ok).toBe(true);
		expect((resp.data as { titlePreserved: boolean }).titlePreserved).toBe(false);
		const call = vi.mocked(data.updateTask).mock.calls[0][2];
		expect(call.customTitle).toBe("Review of #493 from Arseny Pavlenko about drop the PATH shim");
		expect(call.titleEditedByUser).toBeUndefined();
	});

	it("overwrites user-edited title when --force is set", async () => {
		const project = makeProject();
		const task = makeTask({ customTitle: "User-set title", titleEditedByUser: true });
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.loadTasks).mockResolvedValue([task]);
		vi.mocked(data.updateTask).mockResolvedValue({ ...task, customTitle: "Agent override" });
		vi.mocked(getPushMessage).mockReturnValue(null);

		const resp = await handleRequest(
			makeRequest("task.update", {
				taskId: task.id,
				projectId: "proj-1",
				title: "Agent override",
				force: true,
			}),
		);
		expect(resp.ok).toBe(true);
		const call = vi.mocked(data.updateTask).mock.calls[0][2];
		expect(call.customTitle).toBe("Agent override");
		const result = resp.data as { task: Task; titlePreserved: boolean };
		expect(result.titlePreserved).toBe(false);
	});

	it("still allows --title to clear customTitle (--title \"\") without --force, and drops the user-edit flag", async () => {
		const project = makeProject();
		const task = makeTask({ customTitle: "User-set title", titleEditedByUser: true });
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.loadTasks).mockResolvedValue([task]);
		vi.mocked(data.updateTask).mockResolvedValue({ ...task, customTitle: null, titleEditedByUser: false });
		vi.mocked(getPushMessage).mockReturnValue(null);

		const resp = await handleRequest(
			makeRequest("task.update", { taskId: task.id, projectId: "proj-1", title: "" }),
		);
		expect(resp.ok).toBe(true);
		const call = vi.mocked(data.updateTask).mock.calls[0][2];
		expect(call.customTitle).toBeNull();
		expect(call.titleEditedByUser).toBe(false);
	});
});

// Note rules (sources, concurrency, prefix and not-found handling) are pinned on a
// real board in board-operations-notes/parity; these check the socket adapter.
describe("note.* — the socket adapter", () => {
	// The note verbs recompute the notes array inside the per-task lock via updateTaskWith.
	function wire(task: Task): void {
		vi.mocked(data.getProject).mockResolvedValue(makeProject());
		vi.mocked(data.loadTasks).mockResolvedValue([task]);
		vi.mocked(getPushMessage).mockReturnValue(null);
		vi.mocked(data.updateTaskWith).mockImplementation(async (_project, _taskId, mutator) => {
			const { updates, result } = await (mutator as (t: Task) => Promise<{ updates: Partial<Task>; result: unknown }>)(task);
			return { task: { ...task, ...updates }, result } as never;
		});
	}
	const note = (id: string, content = "A"): TaskNote => ({ id, content, source: "ai", createdAt: "", updatedAt: "" });

	it("note.add appends after existing notes with source ai by default, or the given source", async () => {
		const existing = { ...note("note-existing", "Old note"), source: "user" as const };
		wire(makeTask({ notes: [existing] }));

		const resp = await handleRequest(makeRequest("note.add", { taskId: makeTask().id, projectId: "proj-1", content: "Hello" }));
		const notes = (resp.data as Task).notes ?? [];
		expect(notes).toHaveLength(2);
		expect(notes[0]).toEqual(existing);
		expect(notes[1]).toMatchObject({ content: "Hello", source: "ai" });

		const explicit = await handleRequest(makeRequest("note.add", { taskId: makeTask().id, projectId: "proj-1", content: "From user", source: "user" }));
		expect(((explicit.data as Task).notes ?? [])[1]?.source).toBe("user");
	});

	it("note.list returns the task's notes, or an empty list", async () => {
		const notes = [note("n1")];
		wire(makeTask({ notes }));
		expect((await handleRequest(makeRequest("note.list", { taskId: makeTask().id, projectId: "proj-1" }))).data).toEqual(notes);
		wire(makeTask({ notes: undefined }));
		expect((await handleRequest(makeRequest("note.list", { taskId: makeTask().id, projectId: "proj-1" }))).data).toEqual([]);
	});

	it("note.delete removes by full id or prefix, and refuses an ambiguous prefix", async () => {
		for (const ref of ["note-full-uuid-1234", "note-full"]) {
			wire(makeTask({ notes: [note("note-full-uuid-1234")] }));
			const resp = await handleRequest(makeRequest("note.delete", { taskId: makeTask().id, projectId: "proj-1", noteId: ref }));
			expect((resp.data as Task).notes, ref).toHaveLength(0);
		}
		wire(makeTask({ notes: [note("note-abcd-1234-aaaa"), note("note-abcd-1234-bbbb")] }));
		const ambiguous = await handleRequest(makeRequest("note.delete", { taskId: makeTask().id, projectId: "proj-1", noteId: "note-abcd-1234" }));
		expect(ambiguous).toMatchObject({ ok: false, error: expect.stringContaining("Ambiguous") });
	});
});

// moveTask itself is mocked here (see the top-level beforeEach); these pin what
// the socket hands it and the checks the adapter makes before calling it.
describe("task.move", () => {
	function wire(task: Task, project = makeProject()): void {
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.loadTasks).mockResolvedValue([task]);
		vi.mocked(getPushMessage).mockReturnValue(vi.fn());
	}

	it("refuses an unknown status and a disallowed transition", async () => {
		wire(makeTask({ status: "in-progress" }));
		const bogus = await handleRequest(makeRequest("task.move", { taskId: makeTask().id, projectId: "proj-1", newStatus: "bogus" }));
		expect(bogus).toMatchObject({ ok: false, error: expect.stringContaining("Invalid status: \"bogus\"") });

		wire(makeTask({ status: "todo" }));
		const disallowed = await handleRequest(makeRequest("task.move", { taskId: makeTask().id, projectId: "proj-1", newStatus: "review-by-user" }));
		expect(disallowed.ok).toBe(false);
		expect(disallowed.error).toContain("Cannot move task");
		expect(disallowed.error).toContain("Allowed:");
	});

	it("returns task unchanged when same status", async () => {
		const task = makeTask({ status: "in-progress" });
		wire(task);
		const resp = await handleRequest(makeRequest("task.move", { taskId: task.id, projectId: "proj-1", newStatus: "in-progress" }));
		expect(resp.data).toEqual(task);
		expect(data.updateTask).not.toHaveBeenCalled();
	});

	it("hands moveTask an enforced, explicit move from any column, touching no worktree itself", async () => {
		const moves: Array<[Task["status"], Task["status"]]> = [
			["in-progress", "review-by-user"], ["todo", "in-progress"], ["completed", "in-progress"], ["cancelled", "in-progress"],
		];
		for (const [from, to] of moves) {
			vi.mocked(moveTask).mockClear();
			const task = makeTask({ status: from });
			wire(task);
			const resp = await handleRequest(makeRequest("task.move", { taskId: task.id, projectId: "proj-1", newStatus: to }));
			expect(resp.ok, `${from} → ${to}`).toBe(true);
			expect(moveTask).toHaveBeenCalledWith({
				taskId: task.id, projectId: "proj-1", newStatus: to,
				ifStatus: undefined, ifStatusNot: undefined, enforceAllowedTransition: true, explicitLaunch: true,
			});
		}
		expect(git.createWorktree).not.toHaveBeenCalled();
		expect(pty.destroySession).not.toHaveBeenCalled();
	});

	it("passes --if-status-not through, returning the task unchanged when the guard blocks", async () => {
		const task = makeTask({ status: "todo", worktreePath: null, branchName: null });
		wire(task);
		const blocked = await handleRequest(makeRequest("task.move", { taskId: task.id, projectId: "proj-1", newStatus: "in-progress", ifStatusNot: "todo" }));
		expect(blocked.data).toEqual(task);
		const passing = await handleRequest(makeRequest("task.move", { taskId: task.id, projectId: "proj-1", newStatus: "in-progress", ifStatusNot: "completed" }));
		expect((passing.data as Task).status).toBe("in-progress");
		expect(vi.mocked(moveTask).mock.calls.map((c) => c[0].ifStatusNot)).toEqual(["todo", "completed"]);
	});

	it("maps a custom column id to customColumnId, and a blocking guard keeps a completed task closed", async () => {
		const customColumn = { id: "col-1234abcd-0000-0000-0000-000000000000", name: "Review", color: "#3b82f6", llmInstruction: "" };
		const task = makeTask({ status: "completed", worktreePath: null, branchName: null });
		wire(task, makeProject({ customColumns: [customColumn] }));

		const resp = await handleRequest(makeRequest("task.move", { taskId: task.id, projectId: "proj-1", newStatus: customColumn.id, ifStatusNot: "completed" }));

		expect(resp.data).toEqual(task);
		expect(moveTask).toHaveBeenCalledWith(expect.objectContaining({ customColumnId: customColumn.id, ifStatusNot: "completed" }));
	});
});

// Label rules (colour picking, trimming, prefixes, unknown ids, provenance) are pinned
// on a real board in board-operations-labels/parity; these check the socket adapter.
describe("label.* / task.setLabels — the socket adapter", () => {
	function wireProject(project: Project): void {
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.updateProjectWith).mockImplementation(async (_projectId, mutator) => {
			const { updates, result } = await (mutator as (p: Project) => Promise<{ updates: Partial<Project>; result: unknown }>)(project);
			return { project: { ...project, ...updates }, result } as never;
		});
	}

	it("label.list returns the project's labels, and label.create adds one with a palette colour", async () => {
		const labels = [{ id: "lbl-1", name: "bug", color: "#ef4444" }];
		wireProject(makeProject({ labels }));
		expect((await handleRequest(makeRequest("label.list", { projectId: "proj-1" }))).data).toEqual(labels);

		wireProject(makeProject({ labels: [] }));
		vi.mocked(getPushMessage).mockReturnValue(vi.fn());
		const created = await handleRequest(makeRequest("label.create", { projectId: "proj-1", name: "bug" }));
		expect(created.data).toMatchObject({ name: "bug", color: "#ef4444", id: expect.any(String) });
	});

	it("label.delete removes the label from the project and only from the tasks carrying it", async () => {
		const labels = [
			{ id: "lbl-full-uuid-1234", name: "bug", color: "#ef4444" },
			{ id: "lbl-2", name: "feature", color: "#14b8a6" },
		];
		const project = makeProject({ labels });
		const taskWithLabel = makeTask({ id: "t1", labelIds: ["lbl-full-uuid-1234", "lbl-2"] });
		const taskWithout = makeTask({ id: "t2", labelIds: [] });
		// Both the project and the task writes go through their locks, so a concurrent edit is not clobbered.
		wireProject(project);
		vi.mocked(data.loadTasks).mockResolvedValue([taskWithLabel, taskWithout]);
		vi.mocked(data.updateTaskWith).mockResolvedValue({ task: taskWithLabel, result: undefined } as any);

		const resp = await handleRequest(makeRequest("label.delete", { projectId: "proj-1", labelId: "lbl-full" }));
		expect(resp.ok).toBe(true);
		// The mutators recompute from the CURRENT project and task, so concurrent changes survive.
		const projMutator = vi.mocked(data.updateProjectWith).mock.calls[0][1];
		expect(await projMutator(project)).toEqual({ updates: { labels: [labels[1]] }, result: true });
		expect(data.updateTaskWith).toHaveBeenCalledTimes(1);
		expect(data.updateTaskWith).toHaveBeenCalledWith(expect.objectContaining({ id: project.id }), "t1", expect.any(Function));
		const mutator = vi.mocked(data.updateTaskWith).mock.calls[0][2];
		expect(await mutator({ ...taskWithLabel, labelIds: ["lbl-full-uuid-1234", "lbl-2", "lbl-3"] } as any)).toEqual({
			updates: { labelIds: ["lbl-2", "lbl-3"], userLabelIds: ["lbl-2", "lbl-3"] },
			result: true,
		});
	});

	it("task.setLabels sets and clears an agent's labels on a task resolved by id, prefix or seq", async () => {
		const project = makeProject({ labels: [{ id: "lbl-1", name: "bug", color: "#ef4444" }, { id: "lbl-2", name: "feature", color: "#14b8a6" }] });
		// An agent-owned label: the user's own would survive an agent's clear.
		const task = makeTask({ seq: 42, labelIds: ["lbl-1"], userLabelIds: [] });
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.loadTasks).mockResolvedValue([task]);
		vi.mocked(data.updateTask).mockImplementation(async (_project, taskId, updates) => {
			if (taskId !== task.id) throw new Error(`Task not found: ${taskId}`);
			return { ...task, ...updates };
		});
		vi.mocked(getPushMessage).mockReturnValue(vi.fn());

		for (const ref of [task.id, task.id.slice(0, 8), "seq:42"]) {
			const resp = await handleRequest(makeRequest("task.setLabels", { taskId: ref, projectId: "proj-1", labelIds: ["lbl-1", "lbl-2"] }));
			expect(resp.ok, ref).toBe(true);
		}
		expect(vi.mocked(data.updateTask).mock.calls.map((c) => c[2])).toEqual(
			Array(3).fill({ labelIds: ["lbl-1", "lbl-2"], userLabelIds: [] }),
		);
		await handleRequest(makeRequest("task.setLabels", { taskId: task.id, projectId: "proj-1", labelIds: [] }));
		expect(data.updateTask).toHaveBeenLastCalledWith(project, task.id, { labelIds: [], userLabelIds: [] });
	});

	it("task.setLabels refuses an unknown task selector and an ambiguous label prefix, writing nothing", async () => {
		const project = makeProject({ labels: [
			{ id: "aaaa1111-2222-3333-4444-aaaaaaaaaaaa", name: "bug", color: "#ef4444" },
			{ id: "aaaa1111-2222-3333-4444-bbbbbbbbbbbb", name: "feature", color: "#14b8a6" },
		] });
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.loadTasks).mockResolvedValue([makeTask({ labelIds: [] })]);

		const unknownTask = await handleRequest(makeRequest("task.setLabels", { taskId: "missing-task", projectId: project.id, labelIds: [project.labels![0]!.id] }));
		expect(unknownTask).toMatchObject({ ok: false, error: expect.stringContaining("missing-task") });
		const ambiguous = await handleRequest(makeRequest("task.setLabels", { taskId: makeTask().id, projectId: "proj-1", labelIds: ["aaaa1111-2222-3333"] }));
		expect(ambiguous).toMatchObject({ ok: false, error: expect.stringContaining("Ambiguous") });
		expect(data.updateTask).not.toHaveBeenCalled();
	});
});

describe("startSocketServer", () => {
	beforeAll(() => {
		(globalThis as any).Bun.listen = vi.fn();
	});

	it("creates sockets directory and sets socketPath", () => {
		vi.mocked(existsSync).mockReturnValue(false);
		vi.mocked(readdirSync).mockReturnValue([]);

		const path = startSocketServer();

		expect(mkdirSync).toHaveBeenCalledWith("/tmp/test-dev3/sockets", { recursive: true });
		expect(path).toContain("/tmp/test-dev3/sockets/");
		expect(path).toContain(".sock");
		expect(getSocketPath()).toBe(path);
	});

	it("removes leftover socket file if it exists", () => {
		vi.mocked(existsSync).mockImplementation((p: any) => {
			// SOCKETS_DIR does not exist (skip stale cleanup) but socketPath does
			if (String(p).endsWith(".sock")) return true;
			return false;
		});
		vi.mocked(readdirSync).mockReturnValue([]);

		startSocketServer();

		expect(unlinkSync).toHaveBeenCalled();
	});

	it("keeps sockets for alive processes", () => {
		// Use a PID different from current process to avoid collision with socketPath cleanup
		const alivePid = 77777;
		const killSpy = vi.spyOn(process, "kill").mockReturnValue(true);

		vi.mocked(existsSync).mockReturnValue(true);
		vi.mocked(readdirSync).mockReturnValue([`${alivePid}.sock`] as any);

		startSocketServer();

		// Should have checked if process is alive (no throw = alive)
		expect(killSpy).toHaveBeenCalledWith(alivePid, 0);
		// Should NOT have removed the socket for the alive process via stale cleanup
		const unlinkCalls = vi.mocked(unlinkSync).mock.calls.map((c) => String(c[0]));
		const staleCalls = unlinkCalls.filter((p) => p.includes(`${alivePid}.sock`));
		expect(staleCalls).toHaveLength(0);

		killSpy.mockRestore();
	});

	it("buffers a large request split across socket data events", async () => {
		vi.mocked(existsSync).mockReturnValue(false);
		vi.mocked(readdirSync).mockReturnValue([]);
		startSocketServer();

		const listenCalls = vi.mocked((globalThis as any).Bun.listen).mock.calls;
		const listenOptions = listenCalls[listenCalls.length - 1][0];
		const socketHandlers = listenOptions.socket;
		const socket = {};
		const project = makeProject();
		const task = makeTask({ status: "todo" });
		const description = `Line of markdown content.\n`.repeat(600);
		const request = JSON.stringify(makeRequest("task.create", {
			projectId: project.id,
			title: "Large description",
			description,
		})) + "\n";
		const splitAt = Math.floor(request.length / 2);

		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(createTask).mockResolvedValue(task);
		vi.mocked(data.updateTask).mockResolvedValue(task);

		await socketHandlers.data(socket, Buffer.from(request.slice(0, splitAt), "utf-8"));
		expect(flushAndEnd).not.toHaveBeenCalled();

		await socketHandlers.data(socket, Buffer.from(request.slice(splitAt), "utf-8"));

		expect(createTask).toHaveBeenCalledWith({ projectId: project.id, description: description.trim() });
		const flushCalls = vi.mocked(flushAndEnd).mock.calls;
		const response = flushCalls[flushCalls.length - 1][1] as string;
		expect(JSON.parse(response.trim())).toMatchObject({ id: "req-1", ok: true });
	});

	it("returns a clear error when a CLI request exceeds the payload limit", async () => {
		vi.mocked(existsSync).mockReturnValue(false);
		vi.mocked(readdirSync).mockReturnValue([]);
		startSocketServer();

		const listenCalls = vi.mocked((globalThis as any).Bun.listen).mock.calls;
		const listenOptions = listenCalls[listenCalls.length - 1][0];
		const socketHandlers = listenOptions.socket;
		const socket = {};
		const oversizedRequest = "x".repeat(1024 * 1024 + 1);

		await socketHandlers.data(socket, Buffer.from(oversizedRequest, "utf-8"));

		const flushCalls = vi.mocked(flushAndEnd).mock.calls;
		const response = flushCalls[flushCalls.length - 1][1] as string;
		expect(JSON.parse(response.trim())).toMatchObject({
			id: "unknown",
			ok: false,
			error: "Payload exceeded 1024 KB limit, current size 1025 KB",
		});
	});
});

describe("stopSocketServer", () => {

	it("does nothing when socket file does not exist", () => {
		vi.mocked(existsSync).mockReturnValue(false);
		vi.mocked(readdirSync).mockReturnValue([]);
		(globalThis as any).Bun.listen = vi.fn();
		startSocketServer();

		vi.clearAllMocks();
		vi.mocked(existsSync).mockReturnValue(false);

		stopSocketServer();
		expect(unlinkSync).not.toHaveBeenCalled();
	});
});

// Socket meta sidecar: records whether this instance was launched from inside a
// dev3 task context (DEV3_TASK_ID env — devScript-booted dev builds, `dev3
// remote` started from an agent pane). The CLI deprioritizes such guest sockets
// during discovery so control commands route to the primary app (#910/#920).
describe("socket meta sidecar", () => {
	const REAL_DEV3_TASK_ID = process.env.DEV3_TASK_ID;

	beforeEach(() => {
		delete process.env.DEV3_TASK_ID;
	});

	afterEach(() => {
		if (REAL_DEV3_TASK_ID === undefined) {
			delete process.env.DEV3_TASK_ID;
		} else {
			process.env.DEV3_TASK_ID = REAL_DEV3_TASK_ID;
		}
	});

	it("writes a meta sidecar with hostTaskId null for a primary instance", () => {
		vi.clearAllMocks();
		vi.mocked(existsSync).mockReturnValue(false);
		vi.mocked(readdirSync).mockReturnValue([]);
		(globalThis as any).Bun.listen = vi.fn();

		const socketPath = startSocketServer();

		expect(writeFileSync).toHaveBeenCalledTimes(1);
		const [metaPath, content] = vi.mocked(writeFileSync).mock.calls[0] as [string, string];
		expect(socketPath).not.toBeNull();
		expect(metaPath).toBe(socketPath!.replace(/\.sock$/, ".meta.json"));
		expect(JSON.parse(content)).toMatchObject({ pid: process.pid, hostTaskId: null });
	});

	it("records the launching task in hostTaskId when DEV3_TASK_ID is set", () => {
		process.env.DEV3_TASK_ID = "aabbccdd-1111-2222-3333-444444444444";
		vi.clearAllMocks();
		vi.mocked(existsSync).mockReturnValue(false);
		vi.mocked(readdirSync).mockReturnValue([]);
		(globalThis as any).Bun.listen = vi.fn();

		startSocketServer();

		const [, content] = vi.mocked(writeFileSync).mock.calls[0] as [string, string];
		expect(JSON.parse(content).hostTaskId).toBe("aabbccdd-1111-2222-3333-444444444444");
	});

	it("cleans up stale meta sidecars of dead pids at startup", () => {
		vi.clearAllMocks();
		vi.mocked(existsSync).mockImplementation((p: unknown) => String(p).endsWith("/sockets"));
		vi.mocked(readdirSync).mockReturnValue(["999999.sock", "999999.meta.json"] as never);
		(globalThis as any).Bun.listen = vi.fn();
		const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
			const err = new Error("gone") as NodeJS.ErrnoException;
			err.code = "ESRCH";
			throw err;
		});

		startSocketServer();
		killSpy.mockRestore();

		const unlinked = vi.mocked(unlinkSync).mock.calls.map((c) => String(c[0]));
		expect(unlinked.some((p) => p.endsWith("/999999.sock"))).toBe(true);
		expect(unlinked.some((p) => p.endsWith("/999999.meta.json"))).toBe(true);
	});

	it("removes the socket and its meta sidecar on stopSocketServer", () => {
		vi.clearAllMocks();
		vi.mocked(existsSync).mockReturnValue(false);
		vi.mocked(readdirSync).mockReturnValue([]);
		(globalThis as any).Bun.listen = vi.fn();
		startSocketServer();

		vi.clearAllMocks();
		vi.mocked(existsSync).mockReturnValue(true);

		stopSocketServer();

		const unlinked = vi.mocked(unlinkSync).mock.calls.map((c) => String(c[0]));
		expect(unlinked.some((p) => p.endsWith(".sock"))).toBe(true);
		expect(unlinked.some((p) => p.endsWith(".meta.json"))).toBe(true);
	});
});

describe("vent.add", () => {
	it("records a vent and returns its filename (always on, no opt-in)", async () => {
		const resp = await handleRequest(makeRequest("vent.add", { name: "tmux split broken", content: "details here" }));

		expect(resp.ok).toBe(true);
		expect(resp.data).toEqual({ fileName: "2026-06-15_14-30_x.md" });
		expect(addVent).toHaveBeenCalledWith("tmux split broken", "details here");
	});

	it("rejects an empty name or content", async () => {
		expect((await handleRequest(makeRequest("vent.add", { name: "", content: "c" }))).ok).toBe(false);
		expect((await handleRequest(makeRequest("vent.add", { name: "n", content: "" }))).ok).toBe(false);
		expect(addVent).not.toHaveBeenCalled();
	});
});

describe("task.open", () => {
	it("focuses the live window and pushes the same nav an inbound deep link uses", async () => {
		const project = makeProject();
		const task = makeTask();
		const push = vi.fn();
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.loadTasks).mockResolvedValue([task]);
		vi.mocked(getPushMessage).mockReturnValue(push as never);
		const wm = await import("../window-manager");
		vi.mocked(wm.getWindowCount).mockReturnValue(1);

		const resp = await handleRequest(makeRequest("task.open", { taskId: task.id, projectId: project.id }));

		expect(resp.ok).toBe(true);
		expect(resp.data).toMatchObject({ taskId: task.id, projectId: project.id, delivered: true });
		expect(wm.focusFocusedWindow).toHaveBeenCalled();
		expect(push).toHaveBeenCalledWith("openDeepLink", { kind: "task", taskId: task.id, projectId: project.id });
	});

	it("stashes the target and reopens a window when the app sits window-less", async () => {
		const project = makeProject();
		const task = makeTask();
		const push = vi.fn();
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.loadTasks).mockResolvedValue([task]);
		vi.mocked(getPushMessage).mockReturnValue(push as never);
		const wm = await import("../window-manager");
		vi.mocked(wm.getWindowCount).mockReturnValue(0);

		const resp = await handleRequest(makeRequest("task.open", { taskId: task.id, projectId: project.id }));

		expect(resp.data).toMatchObject({ delivered: true, reopened: true });
		expect(wm.openNewWindow).toHaveBeenCalled();
		expect(push).not.toHaveBeenCalled();
		const { consumePendingDeepLinkNav } = await import("../deep-link-nav");
		expect(consumePendingDeepLinkNav()).toEqual({ kind: "task", taskId: task.id, projectId: project.id });
	});
});

// ---- `dev3 message --variant <i>` ----

describe("message.send — --variant narrows a variant group", () => {
	const V1 = "aaaaaaaa-1111-2222-3333-444444444444";
	const V2 = "bbbbbbbb-1111-2222-3333-444444444444";

	function group() {
		return [
			makeTask({ id: V1, seq: 42, groupId: "g1", variantIndex: 1 }),
			makeTask({ id: V2, seq: 42, groupId: "g1", variantIndex: 2 }),
		];
	}

	function scopeTo(tasks: Task[]) {
		vi.mocked(data.getProject).mockResolvedValue(makeProject());
		vi.mocked(data.loadTasks).mockResolvedValue(tasks);
	}

	it("resolves the member carrying that index instead of rejecting the shared seq", async () => {
		scopeTo(group());

		const resp = await handleRequest(
			makeRequest("message.send", { subject: "test subject", taskId: "seq:42", projectId: "proj-1", variantIndex: 2, text: "hi" }),
		);

		expect(resp.ok).toBe(true);
		expect(resp.data).toMatchObject({ taskId: V2 });
		expect(vi.mocked(sendMessageImmediately).mock.calls[0]?.[0]).toMatchObject({ id: V2 });
	});

	it("still rejects the shared seq when no --variant is given", async () => {
		scopeTo(group());

		const resp = await handleRequest(
			makeRequest("message.send", { subject: "test subject", taskId: "seq:42", projectId: "proj-1", text: "hi" }),
		);

		expect(resp.ok).toBe(false);
		expect(resp.error).toContain("matches 2 variant tasks");
		expect(resp.error).toContain("--variant");

		// Every other command's resolution is untouched by a variantIndex.
		const show = await handleRequest(makeRequest("task.show", { taskId: "seq:42", projectId: "proj-1", variantIndex: 1 }));
		expect(show.error).toContain("matches 2 variant tasks");
	});

	it("fails loudly on an unknown index, a seq that is no group, an id ref, or a non-integer index", async () => {
		const send = (taskId: string, variantIndex: unknown) =>
			handleRequest(makeRequest("message.send", { subject: "test subject", taskId, projectId: "proj-1", variantIndex, text: "hi" }));
		scopeTo(group());
		const unknown = await send("seq:42", 5);
		expect(unknown.error).toContain("has no variant 5");
		expect(unknown.error).toContain("Live variants: 1, 2");
		expect((await send(V1, 1)).error).toContain("--variant narrows a variant group addressed by seq");
		expect((await send("seq:42", "one")).error).toContain("expected a non-negative integer");
		scopeTo([makeTask({ id: V1, seq: 42 })]);
		expect((await send("seq:42", 1)).error).toContain("not a variant group");
		expect(sendMessageImmediately).not.toHaveBeenCalled();
	});

	it("still resolves a lone survivor by the index it was minted with", async () => {
		// `variantIndex` is permanent, the collision that minted it is not — a
		// reply command emitted while the siblings were alive keeps working.
		scopeTo([makeTask({ id: V1, seq: 42, groupId: "g1", variantIndex: 1 })]);

		const resp = await handleRequest(
			makeRequest("message.send", { subject: "test subject", taskId: "seq:42", projectId: "proj-1", variantIndex: 1, text: "hi" }),
		);

		expect(resp.ok).toBe(true);
		expect(resp.data).toMatchObject({ taskId: V1 });
	});

	it("narrows the same way when the message is scheduled", async () => {
		scopeTo(group());

		const resp = await handleRequest(
			makeRequest("message.schedule", { subject: "test subject",
				taskId: "seq:42",
				projectId: "proj-1",
				variantIndex: 1,
				text: "hi",
				at: new Date(Date.now() + 60_000).toISOString(),
			}),
		);

		expect(resp.ok).toBe(true);
		expect(resp.data).toMatchObject({ taskId: V1 });
		expect(vi.mocked(scheduleMessage).mock.calls[0]?.[1]).toMatchObject({ id: V1 });
	});

	it("keeps looking on other boards when one carries the seq but not the variant", async () => {
		const alpha = makeProject({ id: "proj-a", name: "Alpha", path: "/tmp/a" });
		const beta = makeProject({ id: "proj-b", name: "Beta", path: "/tmp/b" });
		vi.mocked(data.loadProjects).mockResolvedValue([alpha, beta]);
		vi.mocked(data.loadVirtualProjects).mockResolvedValue([]);
		vi.mocked(data.loadTasks).mockImplementation(async (p) =>
			p.id === "proj-a"
				? [makeTask({ id: V1, seq: 42, projectId: "proj-a" })]
				: [makeTask({ id: V2, seq: 42, projectId: "proj-b", groupId: "g1", variantIndex: 1 })],
		);

		const resp = await handleRequest(makeRequest("message.send", { subject: "test subject", taskId: "seq:42", variantIndex: 1, text: "hi" }));

		expect(resp.ok).toBe(true);
		expect(resp.data).toMatchObject({ taskId: V2 });
	});
});

describe("events.list — the board's memory channel", () => {
	function note(id: string, createdAt: string, content = `note ${id}`): TaskNote {
		return { id, content, source: "ai", createdAt, updatedAt: createdAt };
	}

	beforeEach(() => {
		vi.mocked(data.loadProjects).mockResolvedValue([makeProject()]);
		vi.mocked(data.loadVirtualProjects).mockResolvedValue([]);
		vi.mocked(data.getProject).mockResolvedValue(makeProject());
	});

	// The whole reason the command exists: a live task can still message a
	// coordinator, a finished one cannot, and its notes outlived its worktree.
	it("includes notes from completed and cancelled tasks", async () => {
		const now = new Date().toISOString();
		vi.mocked(data.loadTasks).mockResolvedValue([
			makeTask({ id: "t-live", seq: 1, status: "in-progress", notes: [note("n-live", now)] }),
			makeTask({ id: "t-done", seq: 2, status: "completed", notes: [note("n-done", now)] }),
			makeTask({ id: "t-dead", seq: 3, status: "cancelled", notes: [note("n-dead", now)] }),
		]);

		const resp = await handleRequest(makeRequest("events.list", { cursor: null, limit: 100 }));

		expect(resp.ok).toBe(true);
		const events = (resp.data as { events: Array<{ id: string }> }).events;
		expect(events.map((e) => e.id).sort()).toEqual(["n-dead", "n-done", "n-live"]);
		// Every event carries its owning task's seq, title and status.
		expect(events.find((e) => e.id === "n-done")).toMatchObject({
			kind: "note", seq: 2, taskTitle: "Test task", taskStatus: "completed", projectName: "Test Project",
		});
	});

	it("advances: a cursor from one read returns nothing, then exactly the new note", async () => {
		const tasks = [makeTask({ id: "t1", notes: [note("n1", "2026-08-29T10:00:00.000Z")] })];
		vi.mocked(data.loadTasks).mockResolvedValue(tasks);

		const first = await handleRequest(makeRequest("events.list", {
			cursor: "2026-01-01T00:00:00.000Z",
			limit: 100,
		}));
		const cursorLine = (first.data as { cursor: string }).cursor;
		expect(cursorLine).toBe("2026-08-29T10:00:00.000");

		const second = await handleRequest(makeRequest("events.list", {
			cursor: "2026-08-29T10:00:00.000Z",
			limit: 100,
		}));
		expect((second.data as { events: unknown[] }).events).toHaveLength(0);

		tasks[0] = makeTask({ id: "t1", notes: [note("n1", "2026-08-29T10:00:00.000Z"), note("n2", "2026-08-29T11:00:00.000Z")] });
		const third = await handleRequest(makeRequest("events.list", {
			cursor: "2026-08-29T10:00:00.000Z",
			limit: 100,
		}));
		expect((third.data as { events: Array<{ id: string }> }).events.map((e) => e.id)).toEqual(["n2"]);
	});

	it("resolves an id prefix against the same scope it is about to read", async () => {
		vi.mocked(data.loadTasks).mockResolvedValue([
			makeTask({
				id: "t1",
				notes: [
					note("8eb2da3d", "2026-08-29T10:00:00.000Z"),
					note("cafe0001", "2026-08-29T11:00:00.000Z"),
				],
			}),
		]);

		const resp = await handleRequest(makeRequest("events.list", { cursorId: "8eb2da3d", limit: 100 }));

		expect(resp.ok).toBe(true);
		const sel = resp.data as { events: Array<{ id: string }>; from: string };
		expect(sel.events.map((e) => e.id)).toEqual(["cafe0001"]);
		// Handed back so a quiet sweep started from an id still leaves a position.
		expect(sel.from).toBe("2026-08-29T10:00:00.000");

		// An id that resolves to nothing fails instead of answering with a quiet board.
		const miss = await handleRequest(makeRequest("events.list", { cursorId: "deadbeef", limit: 100 }));
		expect(miss.ok).toBe(false);
		expect(miss.error).toContain("event-cursor-unresolved:");
		expect(miss.error).toContain("deadbeef");
	});

	it("counts the cap instead of truncating in silence", async () => {
		vi.mocked(data.loadTasks).mockResolvedValue([
			makeTask({
				id: "t1",
				notes: Array.from({ length: 12 }, (_, i) => note(`n${String(i).padStart(2, "0")}`, `2026-08-29T${String(i).padStart(2, "0")}:00:00.000Z`)),
			}),
		]);

		const resp = await handleRequest(makeRequest("events.list", {
			cursor: "2026-01-01T00:00:00.000Z",
			limit: 5,
		}));

		const sel = resp.data as { events: Array<{ id: string }>; droppedNewer: number; matched: number };
		expect(sel.events.map((e) => e.id)).toEqual(["n00", "n01", "n02", "n03", "n04"]);
		expect(sel.droppedNewer).toBe(7);
		expect(sel.matched).toBe(12);
	});

	it("keeps reading the other boards when one is unreadable, and skips a note with an unreadable timestamp", async () => {
		const alpha = makeProject({ id: "proj-a", name: "Alpha", path: "/tmp/a" });
		const beta = makeProject({ id: "proj-b", name: "Beta", path: "/tmp/b" });
		vi.mocked(data.loadProjects).mockResolvedValue([alpha, beta]);
		vi.mocked(data.loadTasks).mockImplementation(async (p) => {
			if (p.id === "proj-a") throw new Error("tasks.json is corrupt");
			return [makeTask({ id: "t-b", projectId: "proj-b", createdAt: "not a date", notes: [note("n-bad", "not a date"), note("n-b", new Date().toISOString())] })];
		});

		const resp = await handleRequest(makeRequest("events.list", { cursor: null, limit: 100 }));

		expect(resp.ok).toBe(true);
		expect((resp.data as { events: Array<{ id: string }> }).events.map((e) => e.id)).toEqual(["n-b"]);
	});

	describe("movements — the second kind", () => {
		function move(id: string, at: string, extra: Partial<TaskMovement> = {}): TaskMovement {
			return { id, at, kind: "status", from: "todo", to: "in-progress", ...extra };
		}

		// The point of the kind: a task that finished cannot message anyone, and the
		// moves it made are as dead as its worktree unless they were recorded.
		it("still reports a movement made by a task that has since completed", async () => {
			vi.mocked(data.loadTasks).mockResolvedValue([
				makeTask({
					id: "t-done",
					seq: 1675,
					title: "Add board movements",
					status: "completed",
					movements: [
						move("aaaa0001", "2026-08-29T10:00:00.000Z"),
						move("aaaa0002", "2026-08-29T11:00:00.000Z", { from: "in-progress", to: "completed" }),
					],
				}),
			]);

			const resp = await handleRequest(makeRequest("events.list", { cursor: "2026-01-01T00:00:00.000Z", limit: 100 }));

			const events = (resp.data as { events: Array<Record<string, unknown>> }).events;
			expect(events.map((e) => e.id)).toEqual(["aaaa0001", "aaaa0002"]);
			expect(events[1]).toMatchObject({
				kind: "move",
				seq: 1675,
				taskTitle: "Add board movements",
				taskStatus: "completed",
				text: "Agent is Working → Completed",
			});
		});

		it("separates the two kinds in both directions", async () => {
			vi.mocked(data.loadTasks).mockResolvedValue([
				makeTask({
					id: "t1",
					notes: [note("n1", "2026-08-29T10:00:00.000Z")],
					movements: [move("aaaa0001", "2026-08-29T11:00:00.000Z")],
				}),
			]);
			const read = async (kind?: string) =>
				(await handleRequest(makeRequest("events.list", {
					cursor: "2026-01-01T00:00:00.000Z",
					limit: 100,
					...(kind ? { kind } : {}),
				}))).data as { events: Array<{ id: string; kind: string }> };

			expect((await read()).events.map((e) => e.id)).toEqual(["n1", "aaaa0001"]);
			expect((await read("note")).events.map((e) => e.id)).toEqual(["n1"]);
			expect((await read("move")).events.map((e) => e.id)).toEqual(["aaaa0001"]);
		});

		it("names the custom column rather than the status hiding under it", async () => {
			vi.mocked(data.getProject).mockResolvedValue(
				makeProject({ customColumns: [{ id: "col-hold", name: "On hold", color: "#fff", llmInstruction: "" }] }),
			);
			vi.mocked(data.loadProjects).mockResolvedValue([
				makeProject({ customColumns: [{ id: "col-hold", name: "On hold", color: "#fff", llmInstruction: "" }] }),
			]);
			vi.mocked(data.loadTasks).mockResolvedValue([
				makeTask({
					id: "t1",
					movements: [move("aaaa0001", "2026-08-29T10:00:00.000Z", {
						kind: "column", from: "todo", to: "todo", toColumnId: "col-hold",
					})],
				}),
			]);

			const resp = await handleRequest(makeRequest("events.list", { cursor: "2026-01-01T00:00:00.000Z", limit: 100 }));

			expect((resp.data as { events: Array<{ text: string }> }).events[0].text).toBe("To Do → On hold");
		});

		// A trimmed log presented as complete is the same silent loss a cursor exists
		// to prevent — so the count is reported, and only when it falls in range.
		it("reports evicted movements when they fall inside the answered range", async () => {
			vi.mocked(data.loadTasks).mockResolvedValue([
				makeTask({ id: "t1", movementsDropped: 7, movements: [move("aaaa0001", "2026-08-29T10:00:00.000Z")] }),
			]);

			const inRange = await handleRequest(makeRequest("events.list", { cursor: "2026-08-01T00:00:00.000Z", limit: 100 }));
			expect((inRange.data as { movementsEvicted: number }).movementsEvicted).toBe(7);

			// Reading from AFTER the oldest survivor: the evicted moves are older still,
			// so they are outside what was asked for and must not be reported as a gap.
			const afterwards = await handleRequest(makeRequest("events.list", { cursor: "2026-08-29T10:30:00.000Z", limit: 100 }));
			expect((afterwards.data as { movementsEvicted: number }).movementsEvicted).toBe(0);
		});

		it("shows no movement at all for a task that predates the feature", async () => {
			vi.mocked(data.loadTasks).mockResolvedValue([
				makeTask({ id: "t-legacy", status: "completed", movedAt: "2026-08-29T10:00:00.000Z" }),
			]);

			const resp = await handleRequest(makeRequest("events.list", { cursor: "2026-01-01T00:00:00.000Z", limit: 100 }));

			expect((resp.data as { events: unknown[] }).events).toEqual([]);
		});
	});
});

describe("review.*", () => {
	function wireReviewTask(task: Task): void {
		vi.mocked(data.updateTaskWith).mockImplementation(async (_project, _taskId, mutator) => {
			const { updates, result } = await (mutator as (t: Task) => Promise<{ updates: Partial<Task>; result: unknown }>)(task);
			return { task: { ...task, ...updates }, result } as never;
		});
	}
	const comment = {
		id: "c1234567-0000",
		body: "Wrong number",
		createdAt: "2026-09-15T10:00:00.000Z",
		anchor: { kind: "diff-line", fileId: "f", filePath: "src/a.ts", side: "newFile", startLine: 1, endLine: 1 },
	};

	it("review.list returns the task's comments", async () => {
		const project = makeProject();
		const task = makeTask({ review: [comment] } as Partial<Task>);
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.loadTasks).mockResolvedValue([task]);
		const resp = await handleRequest(makeRequest("review.list", { taskId: task.id, projectId: "proj-1" }));
		expect(resp.ok).toBe(true);
		expect(resp.data).toEqual([comment]);
	});

	it("review.resolve accepts an id prefix, stamps the agent and appends the reply", async () => {
		const project = makeProject();
		const task = makeTask({ review: [comment] } as Partial<Task>);
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.loadTasks).mockResolvedValue([task]);
		wireReviewTask(task);
		vi.mocked(getPushMessage).mockReturnValue(null);
		const resp = await handleRequest(makeRequest("review.resolve", { taskId: task.id, projectId: "proj-1", commentId: "c1234567", reply: "Fixed it" }));
		expect(resp.ok).toBe(true);
		const { commentId, task: updated } = resp.data as { commentId: string; task: Task };
		expect(commentId).toBe("c1234567-0000");
		expect(updated.review?.[0]).toMatchObject({ resolvedBy: "agent" });
		expect(updated.review?.[0].replies?.[0]).toMatchObject({ author: "agent", body: "Fixed it" });
	});

	it("review.reply fails on an unknown id and on an empty body", async () => {
		const project = makeProject();
		const task = makeTask({ review: [comment] } as Partial<Task>);
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.loadTasks).mockResolvedValue([task]);
		let resp = await handleRequest(makeRequest("review.reply", { taskId: task.id, projectId: "proj-1", commentId: "zzz", body: "hi" }));
		expect(resp.ok).toBe(false);
		expect(resp.error).toContain("not found");
		resp = await handleRequest(makeRequest("review.reply", { taskId: task.id, projectId: "proj-1", commentId: "c1234567", body: "  " }));
		expect(resp.ok).toBe(false);
		expect(resp.error).toContain("body is required");
	});
});

describe("message.send — the sender's role travels to the envelope", () => {
	// The receiver's auto-mode classifier treats a coordinator's order as the
	// user's own words; it keys on this role, so the app must stamp it.
	const SENDER = "cccccccc-1111-2222-3333-444444444444";
	const TARGET = "dddddddd-1111-2222-3333-444444444444";

	function sendFrom(sender: Task, extra: Record<string, unknown> = {}) {
		const tasks = [sender, makeTask({ id: TARGET, seq: 2 })];
		vi.mocked(data.loadProjects).mockResolvedValue([makeProject()]);
		vi.mocked(data.loadVirtualProjects).mockResolvedValue([]);
		vi.mocked(data.getProject).mockResolvedValue(makeProject());
		vi.mocked(data.loadTasks).mockResolvedValue(tasks);
		vi.mocked(data.getTask).mockImplementation(async (_p, id) => tasks.find((t) => t.id === id)!);
		return handleRequest(
			makeRequest("message.send", { subject: "merge it", taskId: TARGET, projectId: "proj-1", sourceTaskId: SENDER, text: "merge", ...extra }),
		);
	}

	it("stamps role coordinator when a coordinator task sends, and no role for an ordinary one", async () => {
		const resp = await sendFrom(makeTask({ id: SENDER, seq: 1, taskType: "coordinator" }));
		expect(resp.ok).toBe(true);
		expect(vi.mocked(sendMessageImmediately).mock.calls[0]?.[3]).toMatchObject({ taskId: SENDER, role: "coordinator" });
		await sendFrom(makeTask({ id: SENDER, seq: 1 }));
		const ordinary = vi.mocked(sendMessageImmediately).mock.calls[1]?.[3];
		expect(ordinary).toMatchObject({ taskId: SENDER });
		expect(ordinary).not.toHaveProperty("role");
	});

	it("stamps the sending agent from the pane and pid the CLI reported, so a reply reaches it", async () => {
		const resp = await sendFrom(makeTask({ id: SENDER, seq: 1 }), { sourcePaneId: "%5", sourcePid: 777 });
		expect(resp.ok).toBe(true);
		expect(vi.mocked(sendMessageImmediately).mock.calls[0]?.[3]).toMatchObject({
			taskId: SENDER,
			agent: { paneId: "%5", agentProcess: "909@x" },
		});
		expect(resp.data).not.toHaveProperty("replyUnavailable");
	});

	it("tells the sender when no agent could be proven, and the source says why", async () => {
		const resp = await sendFrom(makeTask({ id: SENDER, seq: 1 }));
		expect(resp.ok).toBe(true);
		const source = vi.mocked(sendMessageImmediately).mock.calls[0]?.[3];
		expect(source).not.toHaveProperty("agent");
		expect(source).toMatchObject({ agentUnavailable: expect.stringContaining("not run from a task terminal pane") });
		expect(resp.data).toMatchObject({ replyUnavailable: expect.stringContaining("not run from a task terminal pane") });
	});

	it("addresses --agent to that one agent and reports the pane and role it went to", async () => {
		const addressed = { paneId: "%3", sessionId: null, paneToken: "gen-1", agentProcess: "303@Mon Oct 26 09:00:00 2026" };
		vi.mocked(sendMessageImmediately).mockResolvedValueOnce({ status: "held", paneId: "%3", agentRole: "review", spilledPath: null, messageId: "m-1" });
		const resp = await sendFrom(makeTask({ id: SENDER, seq: 1 }), { agentHandle: encodeAgentHandle(addressed) });
		expect(resp.ok).toBe(true);
		expect(vi.mocked(sendMessageImmediately).mock.calls[0]?.[4]).toMatchObject({ author: addressed });
		expect(resp.data).toMatchObject({ status: "held", paneId: "%3", agentRole: "review" });
	});

	it("refuses an old a1. handle (with what to do instead) and a malformed handle, sending nothing", async () => {
		const resp = await sendFrom(makeTask({ id: SENDER, seq: 1 }), { agentHandle: "a1.WyIlMyIsbnVsbCwiZ2VuLTEiLCIzMDNAeCJd" });
		expect(resp.ok).toBe(false);
		expect(resp.error).toContain("written by an older dev3");
		expect(resp.error).toContain("dev3 pane list --task <id>");
		const malformed = await sendFrom(makeTask({ id: SENDER, seq: 1 }), { agentHandle: "%3" });
		expect(malformed.error).toContain("not an agent handle");
		expect(sendMessageImmediately).not.toHaveBeenCalled();
	});
});


describe("Claude approval ownership", () => {
	let stored: Task;
	let project: Project;

	beforeEach(() => {
		project = makeProject();
		stored = makeTask({ id: crypto.randomUUID(), status: "in-progress" });
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.loadTasks).mockImplementation(async () => [stored]);
		const move = vi.mocked(moveTask).getMockImplementation()!;
		vi.mocked(moveTask).mockImplementation(async params => {
			stored = await move(params);
			return stored;
		});
	});

	async function hook(event: string, agentId?: string, sessionId = "session-1") {
		const response = await handleRequest(makeRequest(event === "PostToolUse" ? "task.claudePostToolUse" : "task.claudeToolStatus", {
			taskId: stored.id, projectId: project.id, event, agentId, sessionId,
		}));
		expect(response.ok).toBe(true);
		return stored.status;
	}

	it("keeps a parent's approval wait while other agents start, wait and finish, until the parent resumes", async () => {
		await hook("PermissionRequest");
		await hook("PermissionRequest", "reader");
		await hook("PreToolUse", "other");
		expect(await hook("PostToolUse", "other")).toBe("user-questions");
		expect(await hook("PostToolUse", "reader")).toBe("user-questions");
		// PermissionRequest provides no tool_use_id: any tool of the same owner clears its wait.
		expect(await hook("PostToolUse")).toBe("in-progress");
	});

	it("lets a background agent clear its own approval without waiting for the parent", async () => {
		await hook("PermissionRequest", "reader");
		await hook("PostToolUse", "unrelated");
		expect(stored.status).toBe("user-questions");
		expect(await hook("PreToolUse", "reader")).toBe("in-progress");
	});

	it("clears an owner's wait after PostToolUseFailure, SubagentStop and TeammateIdle", async () => {
		for (const event of ["PostToolUseFailure", "SubagentStop", "TeammateIdle"]) {
			await hook("PermissionRequest", "reader");
			expect(await hook(event, "reader"), event).toBe("in-progress");
		}
	});

	it("restores AI review after a background approval", async () => {
		stored = { ...stored, status: "review-by-ai" };
		await hook("PermissionRequest", "reviewer");
		expect(await hook("PostToolUse", "reviewer")).toBe("review-by-ai");
	});

	it("reports continued teammate work after the parent has stopped", async () => {
		stored = { ...stored, status: "review-by-user" };
		expect(await hook("PreToolUse", "teammate")).toBe("in-progress");
	});

	it("returns to the parent's stopped lane on the final SubagentStop or TeammateIdle", async () => {
		for (const event of ["SubagentStop", "TeammateIdle"]) {
			stored = { ...stored, status: "review-by-user" };
			await hook("PreToolUse", "first", event);
			await hook("PostToolUse", "second", event);
			expect(await hook(event, "first", event), event).toBe("in-progress");
			expect(await hook(event, "second", event), event).toBe("review-by-user");
		}
	});

	it("records a parent Stop during a child approval, then restores its review-by-user or review-by-ai target", async () => {
		for (const stopTarget of ["review-by-user", "review-by-ai"] as const) {
			stored = { ...stored, status: "in-progress" };
			await hook("PermissionRequest", "reader", stopTarget);
			const response = await handleRequest(makeRequest("task.claudeTurnEnded", {
				taskId: stored.id, projectId: project.id, sessionId: stopTarget, paneId: "%1", stopTarget,
			}));
			expect(response.ok).toBe(true);
			expect(stored.status, stopTarget).toBe("user-questions");
			expect(await hook("SubagentStop", "reader", stopTarget), stopTarget).toBe(stopTarget);
		}
	});

	it("keeps working when the parent stops before its active child", async () => {
		await hook("PreToolUse", "reader");
		await handleRequest(makeRequest("task.claudeTurnEnded", {
			taskId: stored.id, projectId: project.id, sessionId: "session-1", paneId: "%1", stopTarget: "review-by-user",
		}));
		expect(stored.status).toBe("in-progress");
		expect(await hook("SubagentStop", "reader")).toBe("review-by-user");
	});

	it("clears a cancelled headless session's approval without a pane", async () => {
		await hook("PermissionRequest", undefined, "sdk");
		const response = await handleRequest(makeRequest("task.claudeTurnEnded", {
			taskId: stored.id, projectId: project.id, sessionId: "sdk", sessionEnded: true,
		}));
		expect(response.ok).toBe(true);
		expect(stored.status).toBe("in-progress");
	});

	it("does not clear unowned questions with background activity after an app restart", async () => {
		stored = { ...stored, status: "user-questions" };
		expect(await hook("PostToolUse", "reader")).toBe("user-questions");
	});

	it("scopes an agent's identity to its conversation", async () => {
		await hook("PermissionRequest", "reader", "first");
		expect(await hook("PostToolUse", "reader", "second")).toBe("user-questions");
		expect(await hook("PostToolUse", "reader", "first")).toBe("in-progress");
	});
});
