/**
 * The graceful exit step that runs before every terminal teardown: it types the
 * agent's own quit command into each live agent pane and waits — bounded — for the
 * agent's process tree to empty, so the CLI's session-end hooks get to run.
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

import {
	GRACEFUL_AGENT_EXIT_BLIND_WAIT_MS,
	requestGracefulAgentExit,
	resolveAgentExitTargets,
} from "../agent-graceful-exit";
import { nativeTaskPanesState } from "../native-task-panes";
import { sendPaneInput } from "../pane-input";
import { collectProcessInfo, type ProcessInfoResult } from "../port-scanner";
import { tmux } from "../tmux";

const AGENT_ROOT_PID = 4100;
const AGENT_PID = 4101;

function task(overrides: Partial<Task> = {}): Task {
	return {
		id: "aabbccdd-0000-4000-8000-000000000000",
		projectId: "p1",
		title: "t",
		description: "",
		status: "in-progress",
		createdAt: 0,
		updatedAt: 0,
		sessionState: {
			panes: [{ paneId: "%3", agentCmd: "claude", sessionId: null, agentId: null, configId: null, agentFamily: "claude" }],
		},
		...overrides,
	} as unknown as Task;
}

/** A process tree where `agentAlive` decides whether the pane root still has its child. */
function tree(agentAlive: boolean): Map<number, number[]> {
	const map = new Map<number, number[]>([[1, [AGENT_ROOT_PID]]]);
	map.set(AGENT_ROOT_PID, agentAlive ? [AGENT_PID] : []);
	return map;
}

function processInfo(agentAlive: boolean): ProcessInfoResult {
	return { tree: tree(agentAlive), resources: new Map(), cmdlines: new Map() };
}

/** A clock the test drives: `sleep` advances it and never waits for real. */
function fakeClock() {
	let t = 1_000;
	return {
		now: () => t,
		sleep: vi.fn(async (ms: number) => {
			t += ms;
		}),
	};
}

beforeEach(() => {
	vi.mocked(tmux.listPanes).mockReset();
	vi.mocked(sendPaneInput).mockReset();
	vi.mocked(collectProcessInfo).mockReset();
	vi.mocked(nativeTaskPanesState).mockReset();
	vi.mocked(tmux.listPanes).mockResolvedValue([{ paneId: "%3", panePid: AGENT_ROOT_PID }] as never);
	vi.mocked(sendPaneInput).mockResolvedValue({
		deliveryId: "d1",
		backend: "tmux",
		paneId: "%3",
		status: "delivered",
	} as never);
});

describe("resolveAgentExitTargets", () => {
	it("pairs each recorded agent pane with its live pane root pid", async () => {
		const targets = await resolveAgentExitTargets(task());
		expect(targets).toEqual([
			{ paneId: "%3", rootPid: AGENT_ROOT_PID, entry: expect.objectContaining({ agentCmd: "claude" }) },
		]);
	});

	it("drops a recorded pane that tmux no longer lists", async () => {
		vi.mocked(tmux.listPanes).mockResolvedValue([{ paneId: "%9", panePid: 7 }] as never);
		expect(await resolveAgentExitTargets(task())).toEqual([]);
	});

	it("falls back to the first pane for a single entry with no recorded id", async () => {
		const legacy = task({
			sessionState: { panes: [{ paneId: null, agentCmd: "codex", sessionId: null, agentId: null, configId: null }] },
		} as Partial<Task>);
		const targets = await resolveAgentExitTargets(legacy);
		expect(targets.map((t) => t.paneId)).toEqual(["%3"]);
	});

	it("has nothing to ask on a task with no recorded agent panes", async () => {
		expect(await resolveAgentExitTargets(task({ sessionState: undefined } as Partial<Task>))).toEqual([]);
		expect(tmux.listPanes).not.toHaveBeenCalled();
	});

	it("routes a native task to its agent pane and the pane's shell pid", async () => {
		vi.mocked(nativeTaskPanesState).mockResolvedValue({
			taskId: "x",
			layout: "",
			activePaneId: "pane-1",
			panes: [
				{ paneId: "pane-1", sessionId: "s", hostPid: 1, shellPid: 555, cols: 80, rows: 24, alive: true },
				{ paneId: "pane-2", sessionId: "s2", hostPid: 2, shellPid: 556, cols: 80, rows: 24, alive: true },
			],
		});
		const targets = await resolveAgentExitTargets(task({ terminalBackend: "native" } as Partial<Task>));
		expect(targets).toEqual([{ paneId: "pane-1", rootPid: 555, entry: expect.objectContaining({ agentCmd: "claude" }) }]);
		expect(tmux.listPanes).not.toHaveBeenCalled();
	});

	it("has nothing to ask when the native agent pane is already dead", async () => {
		vi.mocked(nativeTaskPanesState).mockResolvedValue({
			taskId: "x",
			layout: "",
			activePaneId: "pane-1",
			panes: [{ paneId: "pane-1", sessionId: "s", hostPid: 1, shellPid: 555, cols: 80, rows: 24, alive: false }],
		});
		expect(await resolveAgentExitTargets(task({ terminalBackend: "native" } as Partial<Task>))).toEqual([]);
	});
});

describe("requestGracefulAgentExit", () => {
	it("types the adapter's quit program and returns once the agent's tree is empty", async () => {
		vi.mocked(collectProcessInfo)
			.mockResolvedValueOnce(processInfo(true)) // before asking: agent alive
			.mockResolvedValueOnce(processInfo(true)) // first poll: still alive
			.mockResolvedValueOnce(processInfo(false)); // second poll: gone
		const clock = fakeClock();

		const outcome = await requestGracefulAgentExit(task(), { ...clock, pollMs: 250 });

		expect(sendPaneInput).toHaveBeenCalledTimes(1);
		const [, paneId, stages, opts] = vi.mocked(sendPaneInput).mock.calls[0]!;
		expect(paneId).toBe("%3");
		expect(stages.map((stage) => stage.steps)).toEqual([
			[{ kind: "key", key: "ctrl-c" }],
			[{ kind: "text", text: "/exit" }],
			[{ kind: "key", key: "enter" }],
		]);
		expect(opts).toMatchObject({ idPrefix: "agent-exit" });
		expect(outcome).toEqual({ kind: "exited", elapsedMs: 250, panes: 1 });
	});

	it("gives up at the deadline and reports which panes still run", async () => {
		vi.mocked(collectProcessInfo).mockResolvedValue(processInfo(true));
		const clock = fakeClock();

		const outcome = await requestGracefulAgentExit(task(), { ...clock, timeoutMs: 1_000, pollMs: 250 });

		expect(outcome).toEqual({ kind: "timed-out", elapsedMs: 1_000, panes: 1, stillRunning: ["%3"] });
		// Four polls of 250 ms fill the one-second budget exactly; never a wait past it.
		expect(clock.sleep).toHaveBeenCalledTimes(4);
		expect(clock.sleep.mock.calls.every(([ms]) => ms <= 250)).toBe(true);
	});

	it("does not type into a pane whose agent already left", async () => {
		vi.mocked(collectProcessInfo).mockResolvedValue(processInfo(false));

		const outcome = await requestGracefulAgentExit(task(), fakeClock());

		expect(sendPaneInput).not.toHaveBeenCalled();
		expect(outcome).toEqual({ kind: "skipped", reason: "already-exited" });
	});

	it("skips a CLI with no known quit command", async () => {
		vi.mocked(collectProcessInfo).mockResolvedValue(processInfo(true));
		const custom = task({
			sessionState: { panes: [{ paneId: "%3", agentCmd: "my-agent", sessionId: null, agentId: null, configId: null }] },
		} as Partial<Task>);

		const outcome = await requestGracefulAgentExit(custom, fakeClock());

		expect(sendPaneInput).not.toHaveBeenCalled();
		expect(outcome).toEqual({ kind: "skipped", reason: "no-exit-command" });
	});

	it("does not wait when the quit command could not be delivered", async () => {
		vi.mocked(collectProcessInfo).mockResolvedValue(processInfo(true));
		vi.mocked(sendPaneInput).mockResolvedValue({
			deliveryId: "d1",
			backend: "tmux",
			paneId: "%3",
			status: "not-started",
			reason: "pane-dead",
			retryableAsNewDelivery: false,
		} as never);
		const clock = fakeClock();

		const outcome = await requestGracefulAgentExit(task(), clock);

		expect(outcome).toEqual({ kind: "skipped", reason: "not-delivered" });
		expect(clock.sleep).not.toHaveBeenCalled();
	});

	it("waits one blind grace period when the process tree cannot be read", async () => {
		vi.mocked(collectProcessInfo).mockRejectedValue(new Error("ps: not found"));
		const clock = fakeClock();

		const outcome = await requestGracefulAgentExit(task(), clock);

		expect(sendPaneInput).toHaveBeenCalledTimes(1);
		expect(clock.sleep).toHaveBeenCalledWith(GRACEFUL_AGENT_EXIT_BLIND_WAIT_MS);
		expect(outcome).toEqual({ kind: "blind-wait", elapsedMs: GRACEFUL_AGENT_EXIT_BLIND_WAIT_MS, panes: 1 });
	});

	it("never throws when tmux cannot list the panes", async () => {
		vi.mocked(tmux.listPanes).mockRejectedValue(new Error("no server running"));

		const outcome = await requestGracefulAgentExit(task(), fakeClock());

		expect(outcome).toMatchObject({ kind: "skipped", reason: "no-agent-pane" });
		expect(sendPaneInput).not.toHaveBeenCalled();
	});
});
