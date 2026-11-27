import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Task } from "../../shared/types";

vi.mock("../logger", () => ({ createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));
vi.mock("../data", () => ({ getProject: vi.fn(), getTask: vi.fn() }));
vi.mock("../agent-graceful-exit", () => ({
	resolveAgentExitTargets: vi.fn(),
	readAgentProcessEvidence: vi.fn(),
	agentPidsUnder: vi.fn(),
	waitForPanesToEmpty: vi.fn(),
}));
vi.mock("../agents", () => ({ getAllAgents: vi.fn(), buildResumeCommand: vi.fn() }));
vi.mock("../board-operations/task-notes", () => ({ addNote: vi.fn() }));
vi.mock("../board-operations/runtime", () => ({ boardPorts: { ports: true } }));
vi.mock("../pane-input", () => ({ sendPaneInput: vi.fn() }));
vi.mock("../scheduled-message-author", () => ({ readPaneAgentIdentity: vi.fn() }));
vi.mock("../agent-message-target", () => ({ addressedAgentRefusal: vi.fn() }));
vi.mock("../task-terminal-backend", () => ({ taskTerminalBackendIdentity: vi.fn(() => "tmux") }));
vi.mock("../rpc-handlers/tmux-pty/task-launch", () => ({ handlePaneExited: vi.fn(async () => {}) }));
vi.mock("../rpc-handlers/task-panes", () => ({ taskPanesHandlers: { taskPaneAction: vi.fn() } }));

import {
	EXTRA_AGENT_EXIT_DEADLINE_MS,
	EXTRA_AGENT_EXIT_SETTLE_MS,
	_resetExtraAgentExitForTests,
	captureExitBinding,
	exitBindingRefusal,
	extraAgentLabel,
	isExtraAgentExitScheduled,
	recordAgentTurnEvent,
	scheduleExtraAgentExit,
} from "../extra-agent-exit";
import * as data from "../data";
import { forgetPaneExitState, forgetTaskExitState } from "../extra-agent-exit-state";
import { addressedAgentRefusal } from "../agent-message-target";
import { readPaneAgentIdentity } from "../scheduled-message-author";
import { agentPidsUnder, readAgentProcessEvidence, resolveAgentExitTargets, waitForPanesToEmpty } from "../agent-graceful-exit";
import { buildResumeCommand, getAllAgents } from "../agents";
import { addNote } from "../board-operations/task-notes";
import { sendPaneInput } from "../pane-input";
import { taskPanesHandlers } from "../rpc-handlers/task-panes";
import { handlePaneExited } from "../rpc-handlers/tmux-pty/task-launch";
import { taskTerminalBackendIdentity } from "../task-terminal-backend";

const task = { id: "task-1", projectId: "project-1", sessionState: { panes: [{ paneId: "%5", sessionId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" }] } } as Task;
const PANE = "%5";
const SESSION = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const project = { id: "project-1" };
const entry = { paneId: PANE, agentCmd: "claude", agentId: "builtin-claude", configId: "claude-auto", sessionId: SESSION };
const target = { paneId: PANE, rootPid: 4242, entry };
const author = { paneId: PANE, sessionId: SESSION, paneToken: "token", agentProcess: "77@Mon Jan 1 00:00:00 2024" };
const binding = { author, sessionId: SESSION, rootPid: 4242 };
const replacement = { ...author, agentProcess: "99@Mon Jan 1 00:05:00 2024" };
const replaceAgent = (refusal: string) => {
	vi.mocked(addressedAgentRefusal).mockResolvedValue(refusal);
	vi.mocked(readPaneAgentIdentity).mockResolvedValue({ ok: true, author: replacement });
};
const schedule = (paneId = PANE, self = true, extra: { requestedAt?: number } = {}) => scheduleExtraAgentExit(task, paneId, { self, binding, ...extra });
const report = (event: "Stop" | "UserPromptSubmit", paneId = PANE, sessionId: string | null = SESSION) => recordAgentTurnEvent(task, paneId, event, sessionId);

async function advance(ms: number) {
	await vi.advanceTimersByTimeAsync(ms);
}

beforeEach(() => {
	vi.useFakeTimers();
	_resetExtraAgentExitForTests();
	vi.clearAllMocks();
	vi.mocked(data.getProject).mockResolvedValue(project as never);
	vi.mocked(data.getTask).mockResolvedValue(task);
	vi.mocked(resolveAgentExitTargets).mockResolvedValue([target as never]);
	vi.mocked(readAgentProcessEvidence).mockResolvedValue({ tree: new Map(), cmdlines: new Map() });
	vi.mocked(agentPidsUnder).mockReturnValue([4243]);
	vi.mocked(waitForPanesToEmpty).mockResolvedValue({ kind: "exited", elapsedMs: 120 });
	vi.mocked(getAllAgents).mockResolvedValue([{ id: "builtin-claude", name: "Claude", configurations: [{ id: "claude-auto", name: "Opus · auto" }] }] as never);
	vi.mocked(buildResumeCommand).mockReturnValue(`claude --resume ${SESSION}`);
	vi.mocked(addressedAgentRefusal).mockResolvedValue(null);
	vi.mocked(readPaneAgentIdentity).mockResolvedValue({ ok: true, author });
	vi.mocked(sendPaneInput).mockResolvedValue({ status: "delivered" } as never);
	vi.mocked(taskPanesHandlers.taskPaneAction).mockResolvedValue({ panes: [{ paneId: "%1" }] } as never);
});

afterEach(() => {
	_resetExtraAgentExitForTests();
	vi.useRealTimers();
});

describe("extra agent exit scheduling", () => {
	it("self: keeps the pane alone while the turn runs, then types the quit command a moment after the Stop", async () => {
		expect(schedule(PANE, true)).toEqual({ scheduled: true, already: false });
		await advance(60_000);
		expect(sendPaneInput).not.toHaveBeenCalled();
		expect(taskPanesHandlers.taskPaneAction).not.toHaveBeenCalled();

		await report("Stop", PANE);
		await advance(EXTRA_AGENT_EXIT_SETTLE_MS - 1);
		expect(sendPaneInput).not.toHaveBeenCalled();
		await advance(1);

		expect(sendPaneInput).toHaveBeenCalledWith(task, PANE, expect.any(Array), { idPrefix: "extra-agent-exit" });
		expect(waitForPanesToEmpty).toHaveBeenCalledWith([target]);
		expect(taskPanesHandlers.taskPaneAction).toHaveBeenCalledWith({ taskId: task.id, action: { kind: "close", paneId: PANE } });
		expect(isExtraAgentExitScheduled(task.id, PANE)).toBe(false);
	});

	it("self: a Stop recorded before the call is not its turn's end", async () => {
		await report("Stop", PANE);
		schedule(PANE, true);
		await advance(10_000);
		expect(sendPaneInput).not.toHaveBeenCalled();
	});

	it("another agent that is idle (last report Stop) is closed at once", async () => {
		await report("Stop", PANE);
		schedule(PANE, false);
		await advance(0);
		expect(sendPaneInput).toHaveBeenCalledTimes(1);
		expect(taskPanesHandlers.taskPaneAction).toHaveBeenCalledTimes(1);
	});

	it("another agent that is busy or unknown waits for its next Stop", async () => {
		await report("UserPromptSubmit", PANE);
		schedule(PANE, false);
		await advance(30_000);
		expect(sendPaneInput).not.toHaveBeenCalled();
		await report("Stop", PANE);
		await advance(EXTRA_AGENT_EXIT_SETTLE_MS);
		expect(sendPaneInput).toHaveBeenCalledTimes(1);

		_resetExtraAgentExitForTests();
		vi.clearAllMocks();
		schedule("%6", false);
		await advance(30_000);
		expect(sendPaneInput).not.toHaveBeenCalled();
	});

	it("closes the pane hard, typing nothing, when no turn ends within the deadline", async () => {
		schedule(PANE, true);
		await advance(EXTRA_AGENT_EXIT_DEADLINE_MS - 1);
		expect(taskPanesHandlers.taskPaneAction).not.toHaveBeenCalled();
		await advance(1);
		expect(sendPaneInput).not.toHaveBeenCalled();
		expect(waitForPanesToEmpty).not.toHaveBeenCalled();
		expect(taskPanesHandlers.taskPaneAction).toHaveBeenCalledTimes(1);
		expect(addNote).toHaveBeenCalledTimes(1);
	});

	it("a second schedule for the same pane changes nothing and runs the exit once", async () => {
		expect(schedule(PANE, true)).toEqual({ scheduled: true, already: false });
		expect(schedule(PANE, false)).toEqual({ scheduled: true, already: true });
		expect(isExtraAgentExitScheduled(task.id, PANE)).toBe(true);
		await report("Stop", PANE);
		await advance(EXTRA_AGENT_EXIT_SETTLE_MS);
		expect(sendPaneInput).toHaveBeenCalledTimes(1);
		expect(taskPanesHandlers.taskPaneAction).toHaveBeenCalledTimes(1);
	});

	it("a Stop after the exit started does not start it twice", async () => {
		schedule(PANE, true);
		await report("Stop", PANE);
		await report("Stop", PANE);
		await advance(EXTRA_AGENT_EXIT_SETTLE_MS * 3);
		expect(taskPanesHandlers.taskPaneAction).toHaveBeenCalledTimes(1);
	});
});

describe("running the exit", () => {
	async function runSelfExit() {
		schedule(PANE, true);
		await report("Stop", PANE);
		await advance(EXTRA_AGENT_EXIT_SETTLE_MS);
	}

	it("closes without typing when the agent has no quit command", async () => {
		vi.mocked(resolveAgentExitTargets).mockResolvedValue([{ ...target, entry: { ...entry, agentCmd: "my-own-cli", agentId: null } } as never]);
		await runSelfExit();
		expect(sendPaneInput).not.toHaveBeenCalled();
		expect(taskPanesHandlers.taskPaneAction).toHaveBeenCalledTimes(1);
	});

	it("types nothing at a pane whose agent already left", async () => {
		vi.mocked(agentPidsUnder).mockReturnValue([]);
		await runSelfExit();
		expect(sendPaneInput).not.toHaveBeenCalled();
		expect(taskPanesHandlers.taskPaneAction).toHaveBeenCalledTimes(1);
	});

	it("still closes the pane when the quit command was not delivered, without waiting for an exit", async () => {
		vi.mocked(sendPaneInput).mockResolvedValue({ status: "not-started", reason: "pane-gone" } as never);
		await runSelfExit();
		expect(waitForPanesToEmpty).not.toHaveBeenCalled();
		expect(taskPanesHandlers.taskPaneAction).toHaveBeenCalledTimes(1);
	});

	it("closes the pane even when the agent ignored the quit command", async () => {
		vi.mocked(waitForPanesToEmpty).mockResolvedValue({ kind: "timed-out", elapsedMs: 30_000, stillRunning: [PANE], evidence: "read" });
		await runSelfExit();
		expect(taskPanesHandlers.taskPaneAction).toHaveBeenCalledTimes(1);
	});

	it("writes a task note with the conversation id and the resume command", async () => {
		await runSelfExit();
		expect(buildResumeCommand).toHaveBeenCalledWith("claude", SESSION, undefined);
		expect(addNote).toHaveBeenCalledWith(
			expect.anything(), project, task.id,
			`Closed extra agent Claude / Opus · auto (pane ${PANE}, self-exit). Conversation: ${SESSION}. Resume: claude --resume ${SESSION}`,
			expect.anything(),
		);
	});

	it("says the id is unknown and offers no resume command when the pane has none", async () => {
		vi.mocked(resolveAgentExitTargets).mockResolvedValue([{ ...target, entry: { ...entry, sessionId: null } } as never]);
		await report("Stop", PANE);
		schedule(PANE, false);
		await advance(0);
		expect(buildResumeCommand).not.toHaveBeenCalled();
		expect(vi.mocked(addNote).mock.calls[0]![3]).toBe(`Closed extra agent Claude / Opus · auto (pane ${PANE}, closed by another agent). Conversation: id unknown.`);
	});

	it("writes only the could-not-close note, and does not throw, when the pane is still open after the close", async () => {
		vi.mocked(taskPanesHandlers.taskPaneAction).mockResolvedValue({ panes: [{ paneId: PANE }] } as never);
		await runSelfExit();
		expect(addNote).toHaveBeenCalledTimes(1);
		expect(vi.mocked(addNote).mock.calls[0]![3]).toContain("Could not close");
		expect(isExtraAgentExitScheduled(task.id, PANE)).toBe(false);
	});

	it("still writes the note when the agent took its pane along when it quit", async () => {
		vi.mocked(waitForPanesToEmpty).mockImplementation(async () => {
			vi.mocked(resolveAgentExitTargets).mockResolvedValue([]);
			return { kind: "exited", elapsedMs: 50 };
		});
		await runSelfExit();
		expect(taskPanesHandlers.taskPaneAction).not.toHaveBeenCalled();
		expect(handlePaneExited).toHaveBeenCalledWith(task.id, PANE);
		expect(addNote).toHaveBeenCalledTimes(1);
	});

	it("still writes the note when the pane died before the last input step", async () => {
		vi.mocked(sendPaneInput).mockImplementation(async () => {
			vi.mocked(resolveAgentExitTargets).mockResolvedValue([]);
			return { status: "indeterminate" } as never;
		});
		await runSelfExit();
		expect(taskPanesHandlers.taskPaneAction).not.toHaveBeenCalled();
		expect(addNote).toHaveBeenCalledTimes(1);
	});

	it("treats a close that fails because the pane just left as closed, and reports any other failure", async () => {
		vi.mocked(taskPanesHandlers.taskPaneAction).mockImplementation(async () => {
			vi.mocked(resolveAgentExitTargets).mockResolvedValue([]);
			throw new Error("tmux kill-pane failed: can't find pane: %5");
		});
		await runSelfExit();
		expect(addNote).toHaveBeenCalledTimes(1);
		expect(handlePaneExited).toHaveBeenCalledTimes(1);
	});

	it("does not reconcile a native task's registry", async () => {
		vi.mocked(taskTerminalBackendIdentity).mockReturnValue("native");
		vi.mocked(waitForPanesToEmpty).mockImplementation(async () => {
			vi.mocked(resolveAgentExitTargets).mockResolvedValue([]);
			return { kind: "exited", elapsedMs: 50 };
		});
		await runSelfExit();
		expect(handlePaneExited).not.toHaveBeenCalled();
		expect(addNote).toHaveBeenCalledTimes(1);
		vi.mocked(taskTerminalBackendIdentity).mockReturnValue("tmux");
	});

	it("does nothing when the pane is already gone", async () => {
		vi.mocked(resolveAgentExitTargets).mockResolvedValue([]);
		await runSelfExit();
		expect(sendPaneInput).not.toHaveBeenCalled();
		expect(taskPanesHandlers.taskPaneAction).not.toHaveBeenCalled();
		expect(isExtraAgentExitScheduled(task.id, PANE)).toBe(false);
	});

	it("survives a failing step and frees the schedule", async () => {
		vi.mocked(taskPanesHandlers.taskPaneAction).mockRejectedValue(new Error("tmux gone"));
		await runSelfExit();
		expect(vi.mocked(addNote).mock.calls[0]![3]).toContain("tmux gone");
		expect(addNote).toHaveBeenCalledTimes(1);
		expect(isExtraAgentExitScheduled(task.id, PANE)).toBe(false);
	});
});

describe("which conversation's turn counts (A)", () => {
	it("a Stop from a foreign session in the same pane neither starts a pending exit nor marks the pane idle", async () => {
		schedule(PANE, true);
		await report("Stop", PANE, "ffffffff-0000-4000-8000-000000000000");
		await advance(EXTRA_AGENT_EXIT_SETTLE_MS * 3);
		expect(sendPaneInput).not.toHaveBeenCalled();
		_resetExtraAgentExitForTests();
		await report("Stop", PANE, "ffffffff-0000-4000-8000-000000000000");
		schedule(PANE, false);
		await advance(EXTRA_AGENT_EXIT_SETTLE_MS * 3);
		expect(sendPaneInput).not.toHaveBeenCalled();
	});

	it("accepts a report while the pane has no recorded session yet", async () => {
		const fresh = { ...task, sessionState: { panes: [{ paneId: PANE, sessionId: null }] } } as Task;
		scheduleExtraAgentExit(fresh, PANE, { self: true, binding });
		await recordAgentTurnEvent(fresh, PANE, "Stop", "whatever");
		await advance(EXTRA_AGENT_EXIT_SETTLE_MS);
		expect(sendPaneInput).toHaveBeenCalledTimes(1);
	});
});

describe("a new turn inside the settle window (C)", () => {
	it("cancels the exit until the next Stop, which then runs it", async () => {
		schedule(PANE, true);
		await report("Stop");
		await advance(EXTRA_AGENT_EXIT_SETTLE_MS - 100);
		await report("UserPromptSubmit");
		await advance(EXTRA_AGENT_EXIT_SETTLE_MS * 3);
		expect(sendPaneInput).not.toHaveBeenCalled();
		expect(taskPanesHandlers.taskPaneAction).not.toHaveBeenCalled();
		expect(isExtraAgentExitScheduled(task.id, PANE)).toBe(true);
		await report("Stop");
		await advance(EXTRA_AGENT_EXIT_SETTLE_MS);
		expect(sendPaneInput).toHaveBeenCalledTimes(1);
		expect(taskPanesHandlers.taskPaneAction).toHaveBeenCalledTimes(1);
	});

	it("goes back to waiting when a prompt landed after the settle timer fired, under the original deadline", async () => {
		schedule(PANE, true);
		await report("Stop");
		vi.mocked(data.getTask).mockImplementationOnce(async () => {
			await report("UserPromptSubmit");
			return task;
		});
		await advance(EXTRA_AGENT_EXIT_SETTLE_MS);
		expect(sendPaneInput).not.toHaveBeenCalled();
		expect(isExtraAgentExitScheduled(task.id, PANE)).toBe(true);
		await advance(EXTRA_AGENT_EXIT_DEADLINE_MS - EXTRA_AGENT_EXIT_SETTLE_MS);
		expect(sendPaneInput).not.toHaveBeenCalled();
		expect(taskPanesHandlers.taskPaneAction).toHaveBeenCalledTimes(1);
	});
});

describe("a turn that ended while the dialog was open (G)", () => {
	it("starts a self exit at once when a Stop arrived after the request began", async () => {
		const requestedAt = Date.now();
		await advance(5_000);
		await report("Stop");
		schedule(PANE, true, { requestedAt });
		await advance(0);
		expect(sendPaneInput).toHaveBeenCalledTimes(1);
	});

	it("still waits when the Stop came before the request began, or a prompt followed it", async () => {
		await report("Stop");
		await advance(5_000);
		schedule(PANE, true, { requestedAt: Date.now() });
		await advance(2_000);
		expect(sendPaneInput).not.toHaveBeenCalled();
		_resetExtraAgentExitForTests();
		const requestedAt = Date.now();
		await advance(1_000);
		await report("Stop");
		await report("UserPromptSubmit");
		schedule(PANE, true, { requestedAt });
		await advance(2_000);
		expect(sendPaneInput).not.toHaveBeenCalled();
	});
});

describe("the exit belongs to the agent it was asked for (B)", () => {
	it("drops it, typing and closing nothing, when another agent took the pane over, and says so in a note", async () => {
		replaceAgent("the addressed agent is no longer running in this task");
		schedule(PANE, true);
		await report("Stop");
		await advance(EXTRA_AGENT_EXIT_SETTLE_MS);
		expect(sendPaneInput).not.toHaveBeenCalled();
		expect(taskPanesHandlers.taskPaneAction).not.toHaveBeenCalled();
		expect(vi.mocked(addNote).mock.calls[0]![3]).toBe(`Exit of extra agent Claude / Opus · auto in pane ${PANE} was dropped: the addressed agent is no longer running in this task`);
	});

	it("does not let the old deadline close a replacement", async () => {
		replaceAgent("replaced");
		schedule(PANE, true);
		await advance(EXTRA_AGENT_EXIT_DEADLINE_MS);
		expect(taskPanesHandlers.taskPaneAction).not.toHaveBeenCalled();
		expect(vi.mocked(addNote).mock.calls[0]![3]).toContain("was dropped: replaced");
	});

	it("checks again before closing, and drops the exit when a replacement took the pane meanwhile", async () => {
		schedule(PANE, true);
		await report("Stop");
		await advance(EXTRA_AGENT_EXIT_SETTLE_MS);
		expect(addressedAgentRefusal).toHaveBeenCalledTimes(2);
		expect(taskPanesHandlers.taskPaneAction).toHaveBeenCalledTimes(1);

		_resetExtraAgentExitForTests();
		vi.clearAllMocks();
		vi.mocked(readPaneAgentIdentity).mockResolvedValue({ ok: true, author: replacement });
		vi.mocked(addressedAgentRefusal).mockResolvedValueOnce(null).mockResolvedValueOnce("replaced while waiting");
		schedule(PANE, true);
		await report("Stop");
		await advance(EXTRA_AGENT_EXIT_SETTLE_MS);
		expect(taskPanesHandlers.taskPaneAction).not.toHaveBeenCalled();
		expect(vi.mocked(addNote).mock.calls[0]![3]).toContain("was dropped: replaced while waiting");
	});

	it("does not treat an agent that already left as a replacement: the pane is closed and the note written", async () => {
		const left = "the addressed agent (pane %5) is no longer running in this task; not sent to another pane";
		// (a) quit typed, the agent left, a lingering child kept the subtree non-empty past the wait
		vi.mocked(waitForPanesToEmpty).mockResolvedValue({ kind: "timed-out", elapsedMs: 30_000, stillRunning: [PANE], evidence: "read" });
		vi.mocked(addressedAgentRefusal).mockResolvedValueOnce(null).mockResolvedValueOnce(left);
		vi.mocked(readPaneAgentIdentity).mockResolvedValue({ ok: false, reason: "no-agent", detail: "exited" });
		schedule(PANE, true);
		await report("Stop");
		await advance(EXTRA_AGENT_EXIT_SETTLE_MS);
		expect(sendPaneInput).toHaveBeenCalledTimes(1);
		expect(taskPanesHandlers.taskPaneAction).toHaveBeenCalledTimes(1);
		expect(vi.mocked(addNote).mock.calls[0]![3]).toContain("Closed extra agent");

		// (b) the agent exited on its own before the keys went out
		_resetExtraAgentExitForTests();
		vi.clearAllMocks();
		vi.mocked(addressedAgentRefusal).mockResolvedValue(left);
		vi.mocked(readPaneAgentIdentity).mockResolvedValue({ ok: false, reason: "no-agent", detail: "exited" });
		vi.mocked(agentPidsUnder).mockReturnValue([]);
		vi.mocked(taskPanesHandlers.taskPaneAction).mockResolvedValue({ panes: [{ paneId: "%1" }] } as never);
		schedule(PANE, true);
		await report("Stop");
		await advance(EXTRA_AGENT_EXIT_SETTLE_MS);
		expect(sendPaneInput).not.toHaveBeenCalled();
		expect(taskPanesHandlers.taskPaneAction).toHaveBeenCalledTimes(1);
		expect(vi.mocked(addNote).mock.calls[0]![3]).toContain("Closed extra agent");
	});

	it("falls back to the pane's conversation and root process where identity cannot be proven", async () => {
		const fallback = { author: null, sessionId: SESSION, rootPid: 4242 };
		await expect(exitBindingRefusal(task, PANE, fallback)).resolves.toBeNull();
		vi.mocked(resolveAgentExitTargets).mockResolvedValue([{ ...target, entry: { ...entry, sessionId: "other" } } as never]);
		await expect(exitBindingRefusal(task, PANE, fallback)).resolves.toContain("another conversation");
		vi.mocked(resolveAgentExitTargets).mockResolvedValue([{ ...target, rootPid: 1 } as never]);
		await expect(exitBindingRefusal(task, PANE, fallback)).resolves.toContain("restarted");
		vi.mocked(resolveAgentExitTargets).mockResolvedValue([]);
		await expect(exitBindingRefusal(task, PANE, fallback)).resolves.toBeNull();
		expect(addressedAgentRefusal).not.toHaveBeenCalled();
	});

	it("captures the process identity, or the fallback when it cannot be read", async () => {
		await expect(captureExitBinding(task, target as never)).resolves.toEqual(binding);
		expect(readPaneAgentIdentity).toHaveBeenCalledWith(task, PANE, { generation: true });
		vi.mocked(readPaneAgentIdentity).mockResolvedValue({ ok: false, reason: "unsupported", detail: "windows" });
		await expect(captureExitBinding(task, target as never)).resolves.toEqual({ author: null, sessionId: SESSION, rootPid: 4242 });
	});

	it("forgets a pane's idle state and scheduled exit when the pane exits, and a task's when its terminal is torn down", async () => {
		await report("Stop");
		schedule(PANE, true);
		forgetPaneExitState(task.id, PANE);
		expect(isExtraAgentExitScheduled(task.id, PANE)).toBe(false);
		schedule(PANE, false);
		await advance(10_000);
		expect(sendPaneInput).not.toHaveBeenCalled();

		await report("Stop", "%6");
		schedule("%7", true);
		forgetTaskExitState(task.id);
		expect(isExtraAgentExitScheduled(task.id, "%7")).toBe(false);
		schedule("%6", false);
		await advance(EXTRA_AGENT_EXIT_SETTLE_MS * 3);
		expect(sendPaneInput).not.toHaveBeenCalled();
		await advance(EXTRA_AGENT_EXIT_DEADLINE_MS);
	});
});

describe("whose Stop counts for a pane with no recorded session (P)", () => {
	const unrecorded = { ...task, sessionState: { panes: [] } } as Task;

	it("a nested non-interactive Codex Stop neither starts the exit nor marks the pane idle; an interactive one does", async () => {
		scheduleExtraAgentExit(unrecorded, PANE, { self: true, binding });
		await recordAgentTurnEvent(unrecorded, PANE, "Stop", "nested-exec", async () => false);
		await advance(EXTRA_AGENT_EXIT_SETTLE_MS * 3);
		expect(sendPaneInput).not.toHaveBeenCalled();
		await recordAgentTurnEvent(unrecorded, PANE, "Stop", "interactive", async () => true);
		await advance(EXTRA_AGENT_EXIT_SETTLE_MS);
		expect(sendPaneInput).toHaveBeenCalledTimes(1);

		_resetExtraAgentExitForTests();
		vi.clearAllMocks();
		await recordAgentTurnEvent(unrecorded, PANE, "Stop", "nested-exec", async () => false);
		scheduleExtraAgentExit(unrecorded, PANE, { self: false, binding });
		await advance(10_000);
		expect(sendPaneInput).not.toHaveBeenCalled();
	});

	it("a Codex Stop without a session id is not proved, and a non-Codex Stop counts", async () => {
		await recordAgentTurnEvent(unrecorded, PANE, "Stop", null, async () => true);
		scheduleExtraAgentExit(unrecorded, PANE, { self: false, binding });
		await advance(10_000);
		expect(sendPaneInput).not.toHaveBeenCalled();
		_resetExtraAgentExitForTests();
		await recordAgentTurnEvent(unrecorded, PANE, "Stop", null);
		scheduleExtraAgentExit(unrecorded, PANE, { self: false, binding });
		await advance(0);
		expect(sendPaneInput).toHaveBeenCalledTimes(1);
	});
});

describe("a prompt of another conversation (R)", () => {
	it("keeps the pane busy after Stop(A), prompt(B) while the task still records A, so an --agent exit types nothing", async () => {
		await report("Stop", PANE, SESSION);
		await report("UserPromptSubmit", PANE, "bbbbbbbb-0000-4000-8000-000000000000");
		schedule(PANE, false);
		await advance(10_000);
		expect(sendPaneInput).not.toHaveBeenCalled();
		expect(isExtraAgentExitScheduled(task.id, PANE)).toBe(true);
	});
});

describe("a running exit stops on teardown (Q)", () => {
	function pauseQuitWait() {
		let finish = () => {};
		vi.mocked(waitForPanesToEmpty).mockImplementation(() => new Promise((resolve) => { finish = () => resolve({ kind: "exited", elapsedMs: 1 }); }));
		return () => finish();
	}

	it("a task teardown during the quit wait cancels the run, so a replacement agent is not closed", async () => {
		const finishWait = pauseQuitWait();
		schedule(PANE, true);
		await report("Stop");
		await advance(EXTRA_AGENT_EXIT_SETTLE_MS);
		expect(sendPaneInput).toHaveBeenCalledTimes(1);
		forgetTaskExitState(task.id);
		vi.mocked(resolveAgentExitTargets).mockResolvedValue([{ ...target, rootPid: 1 } as never]);
		finishWait();
		await advance(0);
		expect(taskPanesHandlers.taskPaneAction).not.toHaveBeenCalled();
		expect(addNote).not.toHaveBeenCalled();
	});

	it("a pane exit after the quit command went out is the expected result: the exit still finishes with its note", async () => {
		const finishWait = pauseQuitWait();
		schedule(PANE, true);
		await report("Stop");
		await advance(EXTRA_AGENT_EXIT_SETTLE_MS);
		forgetPaneExitState(task.id, PANE);
		vi.mocked(resolveAgentExitTargets).mockResolvedValue([]);
		finishWait();
		await advance(0);
		expect(addNote).toHaveBeenCalledTimes(1);
	});
});

describe("the turn is re-read right before acting (S)", () => {
	it("a prompt that lands while the process evidence is read sends no quit command and leaves the exit pending", async () => {
		let release = () => {};
		vi.mocked(readAgentProcessEvidence).mockImplementation(() => new Promise((resolve) => { release = () => resolve({ tree: new Map(), cmdlines: new Map() }); }));
		schedule(PANE, true);
		await report("Stop");
		await advance(EXTRA_AGENT_EXIT_SETTLE_MS);
		await vi.waitFor(() => expect(readAgentProcessEvidence).toHaveBeenCalled());
		await report("UserPromptSubmit");
		release();
		await advance(0);
		expect(sendPaneInput).not.toHaveBeenCalled();
		expect(isExtraAgentExitScheduled(task.id, PANE)).toBe(true);
		await advance(EXTRA_AGENT_EXIT_DEADLINE_MS);
		expect(taskPanesHandlers.taskPaneAction).toHaveBeenCalledTimes(1);
	});

	it("clears the deadline timer on every way an exit finishes", async () => {
		vi.mocked(resolveAgentExitTargets).mockResolvedValue([]);
		schedule(PANE, true);
		await report("Stop");
		await advance(EXTRA_AGENT_EXIT_SETTLE_MS);
		expect(isExtraAgentExitScheduled(task.id, PANE)).toBe(false);
		expect(vi.getTimerCount()).toBe(0);
	});
});

describe("a close that fails (H)", () => {
	it("leaves a note asking for a manual close, whether the close throws or leaves the pane open", async () => {
		vi.mocked(taskPanesHandlers.taskPaneAction).mockRejectedValue(new Error("tmux kill-pane failed: busy"));
		schedule(PANE, true);
		await report("Stop");
		await advance(EXTRA_AGENT_EXIT_SETTLE_MS);
		expect(vi.mocked(addNote).mock.calls[0]![3]).toBe(`Could not close extra agent Claude / Opus · auto in pane ${PANE}: tmux kill-pane failed: busy. Close it by hand.`);
		expect(addNote).toHaveBeenCalledTimes(1);

		_resetExtraAgentExitForTests();
		vi.clearAllMocks();
		vi.mocked(taskPanesHandlers.taskPaneAction).mockResolvedValue({ panes: [{ paneId: PANE }] } as never);
		schedule(PANE, true);
		await report("Stop");
		await advance(EXTRA_AGENT_EXIT_SETTLE_MS);
		expect(vi.mocked(addNote).mock.calls[0]![3]).toContain("still open after the close request. Close it by hand.");
	});
});

describe("extraAgentLabel", () => {
	it("names the agent and preset, else the command", async () => {
		await expect(extraAgentLabel(entry)).resolves.toBe("Claude / Opus · auto");
		await expect(extraAgentLabel({ ...entry, configId: "gone" })).resolves.toBe("Claude");
		await expect(extraAgentLabel({ ...entry, agentId: null, agentCmd: "/usr/local/bin/codex" })).resolves.toBe("codex");
		vi.mocked(getAllAgents).mockRejectedValue(new Error("unreadable"));
		await expect(extraAgentLabel(entry)).resolves.toBe("claude");
	});
});
