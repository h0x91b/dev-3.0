import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Native prompt delivery against mocked pane-set, PTY-binding and owner-routing
// seams. ../tmux is mocked too — not because this path uses it, but so a stray
// tmux call would be visible instead of silently working (rule: never fall back).
vi.mock("../tmux", () => ({
	tmux: {
		activePaneId: vi.fn(),
		listPanes: vi.fn(),
		sendKeys: vi.fn(),
		showOption: vi.fn(),
		setPaneOption: vi.fn(),
	},
	PANE_ID_FORMAT: { sentinel: "pane-id-format" },
	TMUX_AGENT_PANE_OPTION: "@dev3_agent",
	TMUX_LAST_AGENT_PANE_OPTION: "@dev3_last_agent_pane",
}));
vi.mock("../native-task-panes", () => ({ nativeTaskPanesState: vi.fn() }));
vi.mock("../pty-server", () => ({
	nativePaneTerminal: vi.fn(),
	reattachNativeTaskSession: vi.fn(),
	ensureNativePanePtySession: vi.fn(),
}));
vi.mock("../native-pane-owner", () => ({
	resolvePaneOwner: vi.fn(),
	forwardToOwner: vi.fn(),
}));
vi.mock("../logger", () => ({
	createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import type { NativeTaskPane, NativeTaskPanesState } from "../native-task-panes";
import { nativeTaskPanesState } from "../native-task-panes";
import { ensureNativePanePtySession, nativePaneTerminal, reattachNativeTaskSession } from "../pty-server";
import { forwardToOwner, resolvePaneOwner } from "../native-pane-owner";
import type { NativeTaskTerminal } from "../native-task-terminal";
import { tmux } from "../tmux";
import { AGENT_PROMPT_ENTER_DELAY_MS } from "../agent-prompt";
import {
	NATIVE_AGENT_PANE_ID,
	NATIVE_PROMPT_DELIVERY_METHOD,
	deliverNativePromptAsOwner,
	resolveNativeAgentPane,
	sendPromptToNativeAgentPane,
	sendPromptToNativePane,
} from "../agent-prompt-native";
import type { Task } from "../../shared/types";

const TASK_ID = "3fbe0929-25b3-4fbe-9218-7ceb490a43c3";

function task(overrides: Partial<Task> = {}): Task {
	return {
		id: TASK_ID,
		projectId: "project-1",
		worktreePath: "/tmp/worktree",
		...overrides,
	} as Task;
}

function pane(paneId: string, alive = true): NativeTaskPane {
	return { paneId, sessionId: `dev3-task-${TASK_ID}-${paneId}`, hostPid: 10, shellPid: 11, cols: 80, rows: 24, alive };
}

function panesState(panes: NativeTaskPane[]): NativeTaskPanesState {
	return { taskId: TASK_ID, panes, layout: "", activePaneId: panes[0]?.paneId ?? "" };
}

/** A fake binding whose host role is scriptable, tracking every byte written. */
function fakeTerminal(role: "writer" | "observer" = "writer") {
	const writes: string[] = [];
	const terminal = {
		sessionId: `dev3-task-${TASK_ID}-pane-1`,
		paneId: NATIVE_AGENT_PANE_ID,
		hostPid: 10,
		shellPid: 11,
		write: vi.fn((data: string) => void writes.push(data)),
		resize: vi.fn(),
		hostRole: vi.fn(() => role),
		hostWriterAttached: vi.fn(() => true),
		claimHostWriter: vi.fn(async () => role),
		writerPid: vi.fn(async () => 1),
		detach: vi.fn(),
	} as unknown as NativeTaskTerminal & { claimHostWriter: ReturnType<typeof vi.fn> };
	return { terminal, writes };
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.mocked(nativePaneTerminal).mockReturnValue(null);
	vi.mocked(reattachNativeTaskSession).mockResolvedValue(false);
	vi.mocked(ensureNativePanePtySession).mockResolvedValue(undefined);
	vi.mocked(resolvePaneOwner).mockResolvedValue({ kind: "local" });
	vi.mocked(forwardToOwner).mockResolvedValue({ delivered: true });
	vi.mocked(nativeTaskPanesState).mockResolvedValue(panesState([pane(NATIVE_AGENT_PANE_ID)]));
});

afterEach(() => {
	vi.useRealTimers();
	vi.clearAllMocks();
});

describe("resolveNativeAgentPane — discovery", () => {
	it("finds the agent pane in a single-pane task", async () => {
		await expect(resolveNativeAgentPane(TASK_ID)).resolves.toBe(NATIVE_AGENT_PANE_ID);
	});

	it("picks the agent pane, not a shell split, in a multi-pane task", async () => {
		// pane-2 is a plain shell AND the active pane — discovery must still land on
		// the agent rather than following focus (the live seq 1371 repro).
		const state = panesState([pane("pane-2"), pane(NATIVE_AGENT_PANE_ID)]);
		vi.mocked(nativeTaskPanesState).mockResolvedValue({ ...state, activePaneId: "pane-2" });
		await expect(resolveNativeAgentPane(TASK_ID)).resolves.toBe(NATIVE_AGENT_PANE_ID);
	});

	it("returns null when only shell panes survive the agent", async () => {
		vi.mocked(nativeTaskPanesState).mockResolvedValue(panesState([pane("pane-2"), pane("pane-3")]));
		await expect(resolveNativeAgentPane(TASK_ID)).resolves.toBeNull();
	});

	it("returns null when the agent pane is present but dead", async () => {
		vi.mocked(nativeTaskPanesState).mockResolvedValue(panesState([pane(NATIVE_AGENT_PANE_ID, false)]));
		await expect(resolveNativeAgentPane(TASK_ID)).resolves.toBeNull();
	});

	it("returns null for a stopped task with no pane set at all", async () => {
		vi.mocked(nativeTaskPanesState).mockResolvedValue(null);
		await expect(resolveNativeAgentPane(TASK_ID)).resolves.toBeNull();
	});
});

describe("sendPromptToNativeAgentPane — this process owns the lease", () => {
	it("writes the text, then submits exactly one carriage return after the delay", async () => {
		const { terminal, writes } = fakeTerminal("writer");
		vi.mocked(nativePaneTerminal).mockReturnValue(terminal);

		await expect(sendPromptToNativeAgentPane(task(), "check CI")).resolves.toBe(true);
		expect(writes).toEqual(["check CI"]);

		await vi.advanceTimersByTimeAsync(AGENT_PROMPT_ENTER_DELAY_MS);
		expect(writes).toEqual(["check CI", "\r"]);

		// Nothing fires later — one submit per delivery, never retried.
		await vi.advanceTimersByTimeAsync(AGENT_PROMPT_ENTER_DELAY_MS * 5);
		expect(writes).toEqual(["check CI", "\r"]);
		expect(forwardToOwner).not.toHaveBeenCalled();
	});

	it("never writes and never schedules a submit when no agent pane is live", async () => {
		vi.mocked(nativeTaskPanesState).mockResolvedValue(panesState([pane("pane-2")]));
		const { terminal, writes } = fakeTerminal("writer");
		vi.mocked(nativePaneTerminal).mockReturnValue(terminal);

		await expect(sendPromptToNativeAgentPane(task(), "check CI")).resolves.toBe(false);
		await vi.advanceTimersByTimeAsync(AGENT_PROMPT_ENTER_DELAY_MS * 2);
		expect(writes).toEqual([]);
	});

	it("never touches tmux, whatever the outcome", async () => {
		const { terminal } = fakeTerminal("writer");
		vi.mocked(nativePaneTerminal).mockReturnValue(terminal);
		await sendPromptToNativeAgentPane(task(), "check CI");
		await vi.advanceTimersByTimeAsync(AGENT_PROMPT_ENTER_DELAY_MS);

		vi.mocked(nativeTaskPanesState).mockResolvedValue(null);
		await sendPromptToNativeAgentPane(task(), "check CI");

		expect(tmux.sendKeys).not.toHaveBeenCalled();
		expect(tmux.listPanes).not.toHaveBeenCalled();
		expect(tmux.activePaneId).not.toHaveBeenCalled();
	});
});

describe("sendPromptToNativeAgentPane — another app process owns the lease", () => {
	it("forwards the whole delivery to the owner and writes nothing locally", async () => {
		const { terminal, writes } = fakeTerminal("observer");
		vi.mocked(nativePaneTerminal).mockReturnValue(terminal);
		vi.mocked(resolvePaneOwner).mockResolvedValue({ kind: "peer", pid: 4242, endpoint: "/sock/4242.sock" });

		await expect(sendPromptToNativeAgentPane(task(), "check CI")).resolves.toBe(true);

		expect(forwardToOwner).toHaveBeenCalledTimes(1);
		expect(forwardToOwner).toHaveBeenCalledWith(
			{ kind: "peer", pid: 4242, endpoint: "/sock/4242.sock" },
			NATIVE_PROMPT_DELIVERY_METHOD,
			{ taskId: TASK_ID, paneId: NATIVE_AGENT_PANE_ID, text: "check CI" },
		);

		// Exactly once: no local paste, and no local Enter after the delay either.
		await vi.advanceTimersByTimeAsync(AGENT_PROMPT_ENTER_DELAY_MS * 3);
		expect(writes).toEqual([]);
		expect(forwardToOwner).toHaveBeenCalledTimes(1);
	});

	it("reports false when the owner says it did not deliver", async () => {
		const { terminal, writes } = fakeTerminal("observer");
		vi.mocked(nativePaneTerminal).mockReturnValue(terminal);
		vi.mocked(resolvePaneOwner).mockResolvedValue({ kind: "peer", pid: 4242, endpoint: "/sock/4242.sock" });
		vi.mocked(forwardToOwner).mockResolvedValue({ delivered: false });

		await expect(sendPromptToNativeAgentPane(task(), "check CI")).resolves.toBe(false);
		expect(writes).toEqual([]);
	});

	it("reports false — and still writes nothing locally — when the forward fails", async () => {
		const { terminal, writes } = fakeTerminal("observer");
		vi.mocked(nativePaneTerminal).mockReturnValue(terminal);
		vi.mocked(resolvePaneOwner).mockResolvedValue({ kind: "peer", pid: 4242, endpoint: "/sock/4242.sock" });
		vi.mocked(forwardToOwner).mockRejectedValue(new Error("owner 4242 closed before answering"));

		await expect(sendPromptToNativeAgentPane(task(), "check CI")).resolves.toBe(false);
		await vi.advanceTimersByTimeAsync(AGENT_PROMPT_ENTER_DELAY_MS * 2);
		expect(writes).toEqual([]);
	});
});

describe("sendPromptToNativeAgentPane — vacant / unprovable lease", () => {
	it("claims a vacant lease and then delivers", async () => {
		const { terminal, writes } = fakeTerminal("observer");
		vi.mocked(terminal.claimHostWriter).mockResolvedValue("writer");
		vi.mocked(nativePaneTerminal).mockReturnValue(terminal);
		vi.mocked(resolvePaneOwner).mockResolvedValue({ kind: "vacant" });

		await expect(sendPromptToNativeAgentPane(task(), "check CI")).resolves.toBe(true);
		expect(terminal.claimHostWriter).toHaveBeenCalledTimes(1);
		expect(writes).toEqual(["check CI"]);
	});

	it("gives up when the vacant lease is taken before the claim lands", async () => {
		const { terminal, writes } = fakeTerminal("observer");
		vi.mocked(terminal.claimHostWriter).mockResolvedValue("observer");
		vi.mocked(nativePaneTerminal).mockReturnValue(terminal);
		vi.mocked(resolvePaneOwner).mockResolvedValue({ kind: "vacant" });

		await expect(sendPromptToNativeAgentPane(task(), "check CI")).resolves.toBe(false);
		expect(writes).toEqual([]);
	});

	it.each(["unknown", "gone"] as const)("refuses to guess when the owner is %s", async (kind) => {
		const { terminal, writes } = fakeTerminal("observer");
		vi.mocked(nativePaneTerminal).mockReturnValue(terminal);
		vi.mocked(resolvePaneOwner).mockResolvedValue({ kind });

		await expect(sendPromptToNativeAgentPane(task(), "check CI")).resolves.toBe(false);
		expect(writes).toEqual([]);
		expect(forwardToOwner).not.toHaveBeenCalled();
	});
});

describe("sendPromptToNativePane — binding on demand", () => {
	it("rebinds the agent pane when this process holds no binding yet", async () => {
		const { terminal, writes } = fakeTerminal("writer");
		vi.mocked(nativePaneTerminal).mockReturnValueOnce(null).mockReturnValue(terminal);
		vi.mocked(reattachNativeTaskSession).mockResolvedValue(true);

		await expect(sendPromptToNativeAgentPane(task(), "resume please")).resolves.toBe(true);
		expect(reattachNativeTaskSession).toHaveBeenCalledWith(TASK_ID, "project-1", "/tmp/worktree");
		expect(writes).toEqual(["resume please"]);
	});

	it("fails honestly when the rebind cannot produce a binding", async () => {
		await expect(sendPromptToNativeAgentPane(task(), "hello")).resolves.toBe(false);
		expect(resolvePaneOwner).not.toHaveBeenCalled();
	});

	it("does not attempt a rebind for a task with no worktree on record", async () => {
		await expect(sendPromptToNativeAgentPane(task({ worktreePath: null }), "hello")).resolves.toBe(false);
		expect(reattachNativeTaskSession).not.toHaveBeenCalled();
	});

	it("survives a throwing rebind and still reports the honest failure", async () => {
		vi.mocked(reattachNativeTaskSession).mockRejectedValue(new Error("host image missing"));
		await expect(sendPromptToNativeAgentPane(task(), "hello")).resolves.toBe(false);
	});

	it("registers a non-agent pane through its own PTY session, not the task reattach", async () => {
		const { terminal, writes } = fakeTerminal("writer");
		vi.mocked(nativeTaskPanesState).mockResolvedValue(panesState([pane(NATIVE_AGENT_PANE_ID), pane("pane-2")]));
		vi.mocked(nativePaneTerminal).mockReturnValueOnce(null).mockReturnValue(terminal);

		await expect(sendPromptToNativePane(task(), "pane-2", "ls")).resolves.toBe(true);
		expect(ensureNativePanePtySession).toHaveBeenCalledWith(
			TASK_ID,
			"pane-2",
			`dev3-task-${TASK_ID}-pane-2`,
			"project-1",
			"/tmp/worktree",
		);
		expect(reattachNativeTaskSession).not.toHaveBeenCalled();
		expect(writes).toEqual(["ls"]);
	});

	it("does not register a non-agent pane that is not alive", async () => {
		vi.mocked(nativeTaskPanesState).mockResolvedValue(panesState([pane("pane-2", false)]));
		await expect(sendPromptToNativePane(task(), "pane-2", "ls")).resolves.toBe(false);
		expect(ensureNativePanePtySession).not.toHaveBeenCalled();
	});
});

describe("deliverNativePromptAsOwner — the owner-side dead end", () => {
	const params = { taskId: TASK_ID, paneId: NATIVE_AGENT_PANE_ID, text: "check CI" };

	it("writes and submits once, and never forwards onward", async () => {
		const { terminal, writes } = fakeTerminal("writer");
		vi.mocked(nativePaneTerminal).mockReturnValue(terminal);

		await expect(deliverNativePromptAsOwner(params)).resolves.toBe(true);
		await vi.advanceTimersByTimeAsync(AGENT_PROMPT_ENTER_DELAY_MS);
		expect(writes).toEqual(["check CI", "\r"]);
		// The hop guard: the owner side resolves no owner and forwards nothing, so
		// a stale answer cannot bounce one message between two processes.
		expect(resolvePaneOwner).not.toHaveBeenCalled();
		expect(forwardToOwner).not.toHaveBeenCalled();
	});

	it("claims the lease when it fell vacant between resolution and arrival", async () => {
		const { terminal, writes } = fakeTerminal("observer");
		vi.mocked(terminal.claimHostWriter).mockResolvedValue("writer");
		vi.mocked(nativePaneTerminal).mockReturnValue(terminal);

		await expect(deliverNativePromptAsOwner(params)).resolves.toBe(true);
		expect(writes).toEqual(["check CI"]);
	});

	it("refuses when the lease is no longer ours", async () => {
		const { terminal, writes } = fakeTerminal("observer");
		vi.mocked(terminal.claimHostWriter).mockResolvedValue("observer");
		vi.mocked(nativePaneTerminal).mockReturnValue(terminal);

		await expect(deliverNativePromptAsOwner(params)).resolves.toBe(false);
		expect(writes).toEqual([]);
	});

	it("refuses when this process has no binding for the pane", async () => {
		await expect(deliverNativePromptAsOwner(params)).resolves.toBe(false);
	});
});
