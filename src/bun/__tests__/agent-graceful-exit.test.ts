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
	leadingProgramNames,
	requestGracefulAgentExit,
	resolveAgentExitTargets,
} from "../agent-graceful-exit";
import { nativeTaskPanesState } from "../native-task-panes";
import { sendPaneInput } from "../pane-input";
import { collectProcessInfo, type ProcessInfoResult } from "../port-scanner";
import { tmux } from "../tmux";

const AGENT_ROOT_PID = 4100;
const AGENT_PID = 4101;
const HOOK_PID = 4102;
/** Anything else living under the pane's shell — a job the user left running. */
const STRANGER_PID = 4199;

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

/**
 * A process table with exactly the pids named under the pane root. The launch shell
 * itself always exists — an empty table is a `ps` that failed, which is a different
 * thing entirely and has its own test.
 */
function processInfo(under: readonly number[]): ProcessInfoResult {
	const tree = new Map<number, number[]>([[1, [AGENT_ROOT_PID]]]);
	tree.set(AGENT_ROOT_PID, [...under]);
	const cmdlines = new Map<number, string>([
		[AGENT_ROOT_PID, "/bin/zsh -l"],
		[AGENT_PID, "/Users/dev/.local/bin/claude --session-id abc --model opus review the /exit path"],
		[HOOK_PID, "/bin/bash /Users/dev/hooks/session-end.sh"],
		[STRANGER_PID, "npm run watch"],
	]);
	return { tree, resources: new Map(), cmdlines };
}

/** What a missing or failed `ps` actually produces: parsed output of "". */
const UNREADABLE: ProcessInfoResult = { tree: new Map(), resources: new Map(), cmdlines: new Map() };

/**
 * Readiness is a gate, not a default: nothing is typed unless the CLI is PROVED to be
 * at its prompt, so every case that expects typing has to say so out loud.
 */
const READY = { readiness: async () => "ready" as const };

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

describe("leadingProgramNames", () => {
	it("reads argv0 and an interpreted CLI's script, and stops at the first flag", () => {
		expect(leadingProgramNames("/usr/local/bin/codex")).toEqual(["codex"]);
		expect(leadingProgramNames("node /opt/gemini/bundle/gemini.js --yolo")).toEqual(["node", "gemini"]);
		expect(leadingProgramNames("/opt/opencode/opencode.exe")).toEqual(["opencode"]);
		// The prompt lives after the flags, and it routinely quotes other agents' names.
		expect(leadingProgramNames("/bin/claude --model opus tell me about codex")).toEqual(["claude"]);
	});
});

describe("requestGracefulAgentExit", () => {
	it("types the adapter's quit program and returns once the pane goes quiet", async () => {
		vi.mocked(collectProcessInfo)
			.mockResolvedValueOnce(processInfo([AGENT_PID])) // before asking: the agent itself is there
			.mockResolvedValueOnce(processInfo([AGENT_PID])) // first poll: still running
			.mockResolvedValueOnce(processInfo([])); // second poll: pane empty
		const clock = fakeClock();

		const outcome = await requestGracefulAgentExit(task(), { ...clock, ...READY, pollMs: 250 });

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

	it("keeps waiting for an exit hook that outlives the agent", async () => {
		vi.mocked(collectProcessInfo)
			.mockResolvedValueOnce(processInfo([AGENT_PID])) // before asking
			.mockResolvedValueOnce(processInfo([AGENT_PID, HOOK_PID])) // the hook has started
			.mockResolvedValueOnce(processInfo([HOOK_PID])) // the agent is gone, the hook is not
			.mockResolvedValueOnce(processInfo([])); // the hook finished
		const clock = fakeClock();

		const outcome = await requestGracefulAgentExit(task(), { ...clock, ...READY, pollMs: 250 });

		// The agent's own absence must never end the wait — buying the hook this time
		// is the whole reason the step exists.
		expect(outcome).toEqual({ kind: "exited", elapsedMs: 500, panes: 1 });
	});

	it("gives up at the deadline and reports which panes still run", async () => {
		vi.mocked(collectProcessInfo).mockResolvedValue(processInfo([AGENT_PID]));
		const clock = fakeClock();

		const outcome = await requestGracefulAgentExit(task(), { ...clock, ...READY, timeoutMs: 1_000, pollMs: 250 });

		expect(outcome).toEqual({ kind: "timed-out", elapsedMs: 1_000, panes: 1, stillRunning: ["%3"] });
		// Four polls of 250 ms fill the one-second budget exactly; never a wait past it.
		expect(clock.sleep).toHaveBeenCalledTimes(4);
		expect(clock.sleep.mock.calls.every(([ms]) => ms <= 250)).toBe(true);
	});

	it.each([
		["still booting into its trust prompt", "not-ready"],
		["a harness dev3 cannot probe", "unknown"],
	] as const)("types nothing at an agent that is alive but %s", async (_label, state) => {
		// An alive CLI that has no prompt yet would take the program's Enter as an
		// answer to whatever dialog it IS showing — a trust or first-run choice made
		// on the user's behalf, which outlives a hibernation that keeps the worktree.
		vi.mocked(collectProcessInfo).mockResolvedValue(processInfo([AGENT_PID]));
		const clock = fakeClock();

		const outcome = await requestGracefulAgentExit(task(), { ...clock, readiness: async () => state });

		expect(sendPaneInput).not.toHaveBeenCalled();
		expect(clock.sleep).not.toHaveBeenCalled();
		expect(outcome).toEqual({ kind: "skipped", reason: "not-ready" });
	});

	it("authorizes each pane on its own, never one pane's verdict for both", async () => {
		// The receipt behind readiness is keyed on the TASK, so nothing here may fan one
		// answer across panes: a second agent pane can be mid-launch while the first is
		// long past its trust prompt.
		const SECOND_ROOT_PID = 4200;
		vi.mocked(tmux.listPanes).mockResolvedValue([
			{ paneId: "%3", panePid: AGENT_ROOT_PID },
			{ paneId: "%4", panePid: SECOND_ROOT_PID },
		] as never);
		const two = processInfo([AGENT_PID]);
		two.tree.set(SECOND_ROOT_PID, [4201]);
		two.cmdlines.set(4201, "/Users/dev/.local/bin/claude --session-id def");
		vi.mocked(collectProcessInfo).mockResolvedValue(two);
		const twoPanes = task({
			sessionState: {
				panes: [
					{ paneId: "%3", agentCmd: "claude", sessionId: null, agentId: null, configId: null, agentFamily: "claude" },
					{ paneId: "%4", agentCmd: "claude", sessionId: null, agentId: null, configId: null, agentFamily: "claude" },
				],
			},
		} as Partial<Task>);

		const outcome = await requestGracefulAgentExit(twoPanes, {
			...fakeClock(),
			timeoutMs: 0,
			readiness: async (_task, target) => (target.paneId === "%3" ? "ready" : "not-ready"),
		});

		expect(sendPaneInput).toHaveBeenCalledTimes(1);
		expect(vi.mocked(sendPaneInput).mock.calls[0]![1]).toBe("%3");
		expect(outcome).toMatchObject({ kind: "timed-out", panes: 1, stillRunning: ["%3"] });
	});

	it("demands proof of readiness rather than assuming it", async () => {
		// The default resolver answers `unknown` until the production readiness receipt
		// is wired in. Nothing may type on an unproved prompt in the meantime, and this
		// is the test that fails if someone ever makes the default permissive.
		vi.mocked(collectProcessInfo).mockResolvedValue(processInfo([AGENT_PID]));

		const outcome = await requestGracefulAgentExit(task(), fakeClock());

		expect(sendPaneInput).not.toHaveBeenCalled();
		expect(outcome).toEqual({ kind: "skipped", reason: "not-ready" });
	});

	it("does not type into a pane whose agent already left", async () => {
		vi.mocked(collectProcessInfo).mockResolvedValue(processInfo([]));

		const outcome = await requestGracefulAgentExit(task(), { ...fakeClock(), ...READY });

		expect(sendPaneInput).not.toHaveBeenCalled();
		expect(outcome).toEqual({ kind: "skipped", reason: "no-agent-process" });
	});

	it("does not type at a pane running something that is not the agent", async () => {
		// The launch script hands the pane to a shell when the agent exits, so whatever
		// the user starts there is a descendant too. Busy is not the same as alive.
		vi.mocked(collectProcessInfo).mockResolvedValue(processInfo([STRANGER_PID]));

		const outcome = await requestGracefulAgentExit(task(), { ...fakeClock(), ...READY });

		expect(sendPaneInput).not.toHaveBeenCalled();
		expect(outcome).toEqual({ kind: "skipped", reason: "no-agent-process" });
	});

	it("skips a CLI with no known quit command", async () => {
		const running = processInfo([AGENT_PID]);
		running.cmdlines.set(AGENT_PID, "/usr/local/bin/my-agent --serve");
		vi.mocked(collectProcessInfo).mockResolvedValue(running);
		const custom = task({
			sessionState: { panes: [{ paneId: "%3", agentCmd: "my-agent", sessionId: null, agentId: null, configId: null }] },
		} as Partial<Task>);

		const outcome = await requestGracefulAgentExit(custom, { ...fakeClock(), ...READY });

		expect(sendPaneInput).not.toHaveBeenCalled();
		expect(outcome).toEqual({ kind: "skipped", reason: "no-exit-command" });
	});

	it("does not wait when the quit command could not be delivered", async () => {
		vi.mocked(collectProcessInfo).mockResolvedValue(processInfo([AGENT_PID]));
		vi.mocked(sendPaneInput).mockResolvedValue({
			deliveryId: "d1",
			backend: "tmux",
			paneId: "%3",
			status: "not-started",
			reason: "pane-dead",
			retryableAsNewDelivery: false,
		} as never);
		const clock = fakeClock();

		const outcome = await requestGracefulAgentExit(task(), { ...clock, ...READY });

		expect(outcome).toEqual({ kind: "skipped", reason: "not-delivered" });
		expect(clock.sleep).not.toHaveBeenCalled();
	});

	it("skips, loudly, when the process table is unreadable rather than empty", async () => {
		// This is what a missing `ps` really produces: `runText` swallows the failure and
		// returns "", which parses to an EMPTY table. Read as "no descendants" it would
		// mean "every agent already left" — the feature silently off on any platform
		// without `ps`. It must be evidence-absent instead.
		vi.mocked(collectProcessInfo).mockResolvedValue(UNREADABLE);
		const clock = fakeClock();

		const outcome = await requestGracefulAgentExit(task(), { ...clock, ...READY });

		expect(sendPaneInput).not.toHaveBeenCalled();
		expect(clock.sleep).not.toHaveBeenCalled();
		expect(outcome).toEqual({ kind: "skipped", reason: "no-process-evidence" });
	});

	it("skips when the process scan throws outright", async () => {
		vi.mocked(collectProcessInfo).mockRejectedValue(new Error("ps: not found"));

		const outcome = await requestGracefulAgentExit(task(), { ...fakeClock(), ...READY });

		expect(sendPaneInput).not.toHaveBeenCalled();
		expect(outcome).toEqual({ kind: "skipped", reason: "no-process-evidence" });
	});

	it("never throws when the pane send itself rejects", async () => {
		vi.mocked(collectProcessInfo).mockResolvedValue(processInfo([AGENT_PID]));
		vi.mocked(sendPaneInput).mockRejectedValue(new Error("tmux: no server"));

		const outcome = await requestGracefulAgentExit(task(), { ...fakeClock(), ...READY });

		expect(outcome).toEqual({ kind: "skipped", reason: "not-delivered" });
	});

	it("never throws when tmux cannot list the panes", async () => {
		vi.mocked(tmux.listPanes).mockRejectedValue(new Error("no server running"));

		const outcome = await requestGracefulAgentExit(task(), { ...fakeClock(), ...READY });

		expect(outcome).toMatchObject({ kind: "skipped", reason: "no-agent-pane" });
		expect(sendPaneInput).not.toHaveBeenCalled();
	});
});
