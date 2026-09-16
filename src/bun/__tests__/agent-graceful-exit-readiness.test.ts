/**
 * The graceful exit through the REAL readiness resolver — no stubbed verdicts.
 *
 * The unit suite injects a resolver, which proves this module's own logic and nothing
 * about the receipts it will actually be asked. These cases drive `agent-readiness`
 * itself: a launch is registered, real receipts arrive (or deliberately do not), and
 * the step is asked to quit. The three that matter are a pane that never reported,
 * a receipt from a superseded launch, and an exit hook still running after the agent
 * is gone.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Task } from "../../shared/types";

vi.mock("../logger", () => ({
	createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock("../tmux", () => ({
	DEFAULT_TMUX_SOCKET: "dev3",
	PANE_ID_PID_FORMAT: { formatString: "#{pane_id}\t#{pane_pid}", parse: vi.fn() },
	taskSessionName: (taskId: string) => `dev3-${taskId.slice(0, 8)}`,
	tmux: { listPanes: vi.fn() },
}));
vi.mock("../pane-input", () => ({ sendPaneInput: vi.fn() }));
vi.mock("../port-scanner", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../port-scanner")>();
	return { ...actual, collectProcessInfo: vi.fn() };
});
vi.mock("../native-task-panes", () => ({ nativeTaskPanesState: vi.fn() }));

import { requestGracefulAgentExit } from "../agent-graceful-exit";
import {
	noteAgentLaunching,
	noteAgentSessionAlive,
	resetAgentReadinessForTests,
} from "../agent-readiness";
import { sendPaneInput } from "../pane-input";
import { collectProcessInfo, type ProcessInfoResult } from "../port-scanner";
import { tmux } from "../tmux";

const TASK_ID = "aabbccdd-0000-4000-8000-000000000000";
const MAIN_PANE = "%3";
const SECOND_PANE = "%4";
const MAIN_ROOT_PID = 4100;
const SECOND_ROOT_PID = 4200;
const AGENT_PID = 4101;
const HOOK_PID = 4102;
const SECOND_AGENT_PID = 4201;

function task(panes: string[] = [MAIN_PANE]): Task {
	return {
		id: TASK_ID,
		projectId: "p1",
		title: "t",
		description: "",
		status: "in-progress",
		createdAt: 0,
		updatedAt: 0,
		sessionState: {
			panes: panes.map((paneId) => ({
				paneId,
				agentCmd: "claude",
				sessionId: null,
				agentId: null,
				configId: null,
				agentFamily: "claude",
			})),
		},
	} as unknown as Task;
}

/** A process table where each pane root carries the pids named for it. */
function processInfo(under: Record<number, number[]>): ProcessInfoResult {
	const tree = new Map<number, number[]>([[1, [MAIN_ROOT_PID, SECOND_ROOT_PID]]]);
	for (const [root, pids] of Object.entries(under)) tree.set(Number(root), pids);
	const cmdlines = new Map<number, string>([
		[AGENT_PID, "/Users/dev/.local/bin/claude --session-id s1"],
		[SECOND_AGENT_PID, "/Users/dev/.local/bin/claude --session-id s2"],
		[HOOK_PID, "/bin/bash /Users/dev/hooks/session-end.sh"],
	]);
	return { tree, resources: new Map(), cmdlines };
}

const fakeClock = () => {
	let t = 1_000;
	return { now: () => t, sleep: vi.fn(async (ms: number) => { t += ms; }) };
};

/** Register a launch and report the receipt that proves that pane reached its prompt. */
function launchAndReportReady(paneId: string, sessionId: string, primary = true): void {
	const launchId = noteAgentLaunching(TASK_ID, { reportsLifecycle: true, primary, paneId });
	expect(launchId).not.toBeNull();
	expect(noteAgentSessionAlive(TASK_ID, { sessionId, paneId, launchId })).toBe(true);
}

beforeEach(() => {
	resetAgentReadinessForTests();
	vi.mocked(tmux.listPanes).mockReset();
	vi.mocked(sendPaneInput).mockReset();
	vi.mocked(collectProcessInfo).mockReset();
	vi.mocked(tmux.listPanes).mockResolvedValue([
		{ paneId: MAIN_PANE, panePid: MAIN_ROOT_PID },
		{ paneId: SECOND_PANE, panePid: SECOND_ROOT_PID },
	] as never);
	vi.mocked(sendPaneInput).mockResolvedValue({
		deliveryId: "d1",
		backend: "tmux",
		paneId: MAIN_PANE,
		status: "delivered",
	} as never);
});

describe("graceful exit against the real readiness receipts", () => {
	it("types nothing while the agent is still booting into its trust prompt", async () => {
		// Launch registered, no receipt yet: this is the window the trust dialog lives in.
		noteAgentLaunching(TASK_ID, { reportsLifecycle: true, primary: true, paneId: MAIN_PANE });
		vi.mocked(collectProcessInfo).mockResolvedValue(processInfo({ [MAIN_ROOT_PID]: [AGENT_PID] }));

		const outcome = await requestGracefulAgentExit(task(), fakeClock());

		expect(sendPaneInput).not.toHaveBeenCalled();
		expect(outcome).toEqual({ kind: "skipped", reason: "not-ready" });
	});

	it("types nothing for a task the receipts know nothing about", async () => {
		vi.mocked(collectProcessInfo).mockResolvedValue(processInfo({ [MAIN_ROOT_PID]: [AGENT_PID] }));

		const outcome = await requestGracefulAgentExit(task(), fakeClock());

		expect(sendPaneInput).not.toHaveBeenCalled();
		expect(outcome).toEqual({ kind: "skipped", reason: "not-ready" });
	});

	it("refuses a receipt from a superseded launch", async () => {
		const stale = noteAgentLaunching(TASK_ID, { reportsLifecycle: true, primary: true, paneId: MAIN_PANE });
		// The task is relaunched; the old agent's hook only reports afterwards.
		noteAgentLaunching(TASK_ID, { reportsLifecycle: true, primary: true, paneId: MAIN_PANE });
		expect(noteAgentSessionAlive(TASK_ID, { sessionId: "old", paneId: MAIN_PANE, launchId: stale })).toBe(false);
		vi.mocked(collectProcessInfo).mockResolvedValue(processInfo({ [MAIN_ROOT_PID]: [AGENT_PID] }));

		const outcome = await requestGracefulAgentExit(task(), fakeClock());

		expect(sendPaneInput).not.toHaveBeenCalled();
		expect(outcome).toEqual({ kind: "skipped", reason: "not-ready" });
	});

	it("asks only the pane that reported, never its booting sibling", async () => {
		launchAndReportReady(MAIN_PANE, "s1");
		// A second agent pane joins the same era and never reports: still in its dialog.
		noteAgentLaunching(TASK_ID, { reportsLifecycle: true, primary: false, paneId: SECOND_PANE });
		vi.mocked(collectProcessInfo).mockResolvedValue(
			processInfo({ [MAIN_ROOT_PID]: [AGENT_PID], [SECOND_ROOT_PID]: [SECOND_AGENT_PID] }),
		);

		const outcome = await requestGracefulAgentExit(task([MAIN_PANE, SECOND_PANE]), {
			...fakeClock(),
			timeoutMs: 0,
		});

		expect(sendPaneInput).toHaveBeenCalledTimes(1);
		expect(vi.mocked(sendPaneInput).mock.calls[0]![1]).toBe(MAIN_PANE);
		expect(outcome).toMatchObject({ kind: "timed-out", panes: 1, stillRunning: [MAIN_PANE] });
	});

	it("asks a ready agent and waits for the exit hook that outlives it", async () => {
		launchAndReportReady(MAIN_PANE, "s1");
		vi.mocked(collectProcessInfo)
			.mockResolvedValueOnce(processInfo({ [MAIN_ROOT_PID]: [AGENT_PID] })) // before asking
			.mockResolvedValueOnce(processInfo({ [MAIN_ROOT_PID]: [AGENT_PID, HOOK_PID] })) // hook started
			.mockResolvedValueOnce(processInfo({ [MAIN_ROOT_PID]: [HOOK_PID] })) // agent gone, hook writing
			.mockResolvedValueOnce(processInfo({ [MAIN_ROOT_PID]: [] })); // hook finished

		const outcome = await requestGracefulAgentExit(task(), { ...fakeClock(), pollMs: 250 });

		expect(sendPaneInput).toHaveBeenCalledTimes(1);
		expect(vi.mocked(sendPaneInput).mock.calls[0]![2].map((stage) => stage.steps)).toEqual([
			[{ kind: "key", key: "ctrl-c" }],
			[{ kind: "text", text: "/exit" }],
			[{ kind: "key", key: "enter" }],
		]);
		// The agent's own absence never ends the wait: the hook is the reason we asked.
		expect(outcome).toEqual({ kind: "exited", elapsedMs: 500, panes: 1 });
	});
});
