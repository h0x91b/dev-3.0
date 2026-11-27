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
vi.mock("../task-terminal-backend", () => ({ taskTerminalBackendIdentity: vi.fn(() => "tmux") }));
vi.mock("../rpc-handlers/tmux-pty/task-launch", () => ({ handlePaneExited: vi.fn(async () => {}) }));
vi.mock("../rpc-handlers/task-panes", () => ({ taskPanesHandlers: { taskPaneAction: vi.fn() } }));

import {
	EXTRA_AGENT_EXIT_BLIND_WAIT_MS,
	EXTRA_AGENT_EXIT_DEADLINE_MS,
	EXTRA_AGENT_EXIT_SETTLE_MS,
	_resetExtraAgentExitForTests,
	extraAgentLabel,
	isExtraAgentExitScheduled,
	recordAgentTurnEvent,
	scheduleExtraAgentExit,
} from "../extra-agent-exit";
import * as data from "../data";
import { agentPidsUnder, readAgentProcessEvidence, resolveAgentExitTargets, waitForPanesToEmpty } from "../agent-graceful-exit";
import { buildResumeCommand, getAllAgents } from "../agents";
import { addNote } from "../board-operations/task-notes";
import { sendPaneInput } from "../pane-input";
import { taskPanesHandlers } from "../rpc-handlers/task-panes";
import { handlePaneExited } from "../rpc-handlers/tmux-pty/task-launch";
import { taskTerminalBackendIdentity } from "../task-terminal-backend";

const task = { id: "task-1", projectId: "project-1" } as Task;
const PANE = "%5";
const SESSION = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const project = { id: "project-1" };
const entry = { paneId: PANE, agentCmd: "claude", agentId: "builtin-claude", configId: "claude-auto", sessionId: SESSION };
const target = { paneId: PANE, rootPid: 4242, entry };

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
	vi.mocked(sendPaneInput).mockResolvedValue({ status: "delivered" } as never);
	vi.mocked(taskPanesHandlers.taskPaneAction).mockResolvedValue({ panes: [{ paneId: "%1" }] } as never);
});

afterEach(() => {
	_resetExtraAgentExitForTests();
	vi.useRealTimers();
});

describe("extra agent exit scheduling", () => {
	it("self: keeps the pane alone while the turn runs, then types the quit command a moment after the Stop", async () => {
		expect(scheduleExtraAgentExit(task, PANE, { self: true })).toEqual({ scheduled: true, already: false });
		await advance(60_000);
		expect(sendPaneInput).not.toHaveBeenCalled();
		expect(taskPanesHandlers.taskPaneAction).not.toHaveBeenCalled();

		recordAgentTurnEvent(task.id, PANE, "Stop");
		await advance(EXTRA_AGENT_EXIT_SETTLE_MS - 1);
		expect(sendPaneInput).not.toHaveBeenCalled();
		await advance(1);

		expect(sendPaneInput).toHaveBeenCalledWith(task, PANE, expect.any(Array), { idPrefix: "extra-agent-exit" });
		expect(waitForPanesToEmpty).toHaveBeenCalledWith([target]);
		expect(taskPanesHandlers.taskPaneAction).toHaveBeenCalledWith({ taskId: task.id, action: { kind: "close", paneId: PANE } });
		expect(isExtraAgentExitScheduled(task.id, PANE)).toBe(false);
	});

	it("self: a Stop recorded before the call is not its turn's end", async () => {
		recordAgentTurnEvent(task.id, PANE, "Stop");
		scheduleExtraAgentExit(task, PANE, { self: true });
		await advance(10_000);
		expect(sendPaneInput).not.toHaveBeenCalled();
	});

	it("another agent that is idle (last report Stop) is closed at once", async () => {
		recordAgentTurnEvent(task.id, PANE, "Stop");
		scheduleExtraAgentExit(task, PANE, { self: false });
		await advance(0);
		expect(sendPaneInput).toHaveBeenCalledTimes(1);
		expect(taskPanesHandlers.taskPaneAction).toHaveBeenCalledTimes(1);
	});

	it("another agent that is busy or unknown waits for its next Stop", async () => {
		recordAgentTurnEvent(task.id, PANE, "UserPromptSubmit");
		scheduleExtraAgentExit(task, PANE, { self: false });
		await advance(30_000);
		expect(sendPaneInput).not.toHaveBeenCalled();
		recordAgentTurnEvent(task.id, PANE, "Stop");
		await advance(EXTRA_AGENT_EXIT_SETTLE_MS);
		expect(sendPaneInput).toHaveBeenCalledTimes(1);

		_resetExtraAgentExitForTests();
		vi.clearAllMocks();
		scheduleExtraAgentExit(task, "%6", { self: false });
		await advance(30_000);
		expect(sendPaneInput).not.toHaveBeenCalled();
	});

	it("closes the pane hard, typing nothing, when no turn ends within the deadline", async () => {
		scheduleExtraAgentExit(task, PANE, { self: true });
		await advance(EXTRA_AGENT_EXIT_DEADLINE_MS - 1);
		expect(taskPanesHandlers.taskPaneAction).not.toHaveBeenCalled();
		await advance(1);
		expect(sendPaneInput).not.toHaveBeenCalled();
		expect(waitForPanesToEmpty).not.toHaveBeenCalled();
		expect(taskPanesHandlers.taskPaneAction).toHaveBeenCalledTimes(1);
		expect(addNote).toHaveBeenCalledTimes(1);
	});

	it("a second schedule for the same pane changes nothing and runs the exit once", async () => {
		expect(scheduleExtraAgentExit(task, PANE, { self: true })).toEqual({ scheduled: true, already: false });
		expect(scheduleExtraAgentExit(task, PANE, { self: false })).toEqual({ scheduled: true, already: true });
		expect(isExtraAgentExitScheduled(task.id, PANE)).toBe(true);
		recordAgentTurnEvent(task.id, PANE, "Stop");
		await advance(EXTRA_AGENT_EXIT_SETTLE_MS);
		expect(sendPaneInput).toHaveBeenCalledTimes(1);
		expect(taskPanesHandlers.taskPaneAction).toHaveBeenCalledTimes(1);
	});

	it("a Stop after the exit started does not start it twice", async () => {
		scheduleExtraAgentExit(task, PANE, { self: true });
		recordAgentTurnEvent(task.id, PANE, "Stop");
		recordAgentTurnEvent(task.id, PANE, "Stop");
		await advance(EXTRA_AGENT_EXIT_SETTLE_MS * 3);
		expect(taskPanesHandlers.taskPaneAction).toHaveBeenCalledTimes(1);
	});
});

describe("running the exit", () => {
	async function runSelfExit() {
		scheduleExtraAgentExit(task, PANE, { self: true });
		recordAgentTurnEvent(task.id, PANE, "Stop");
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

	it("waits a fixed time after typing when the platform has no process table", async () => {
		vi.mocked(readAgentProcessEvidence).mockResolvedValue(null);
		await runSelfExit();
		expect(sendPaneInput).toHaveBeenCalledTimes(1);
		expect(waitForPanesToEmpty).not.toHaveBeenCalled();
		expect(taskPanesHandlers.taskPaneAction).not.toHaveBeenCalled();
		await advance(EXTRA_AGENT_EXIT_BLIND_WAIT_MS);
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
		recordAgentTurnEvent(task.id, PANE, "Stop");
		scheduleExtraAgentExit(task, PANE, { self: false });
		await advance(0);
		expect(buildResumeCommand).not.toHaveBeenCalled();
		expect(vi.mocked(addNote).mock.calls[0]![3]).toBe(`Closed extra agent Claude / Opus · auto (pane ${PANE}, closed by another agent). Conversation: id unknown.`);
	});

	it("writes no note and does not throw when the pane is still open after the close", async () => {
		vi.mocked(taskPanesHandlers.taskPaneAction).mockResolvedValue({ panes: [{ paneId: PANE }] } as never);
		await runSelfExit();
		expect(addNote).not.toHaveBeenCalled();
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
		expect(addNote).not.toHaveBeenCalled();
		expect(isExtraAgentExitScheduled(task.id, PANE)).toBe(false);
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
