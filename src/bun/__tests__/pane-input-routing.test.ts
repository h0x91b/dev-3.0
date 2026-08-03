import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Routing must come from the TASK, never from the request. These cases exist so a
// caller payload can never steer a native task into the tmux adapter or back.
vi.mock("../task-terminal-backend", () => ({ taskTerminalBackendIdentity: vi.fn() }));
vi.mock("../pane-input-native", async (importOriginal) => ({
	...(await importOriginal<typeof import("../pane-input-native")>()),
	deliverNativePaneInput: vi.fn(),
	resolveNativePaneIncarnation: vi.fn(),
}));
vi.mock("../pane-input-tmux", async (importOriginal) => ({
	...(await importOriginal<typeof import("../pane-input-tmux")>()),
	executeTmuxPaneInput: vi.fn(),
}));
vi.mock("../tmux", () => ({
	DEFAULT_TMUX_SOCKET: "dev3",
	taskSessionName: (taskId: string) => `dev3-task-${taskId}`,
	tmux: { observePane: vi.fn() },
}));
vi.mock("../logger", () => ({
	createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { taskTerminalBackendIdentity } from "../task-terminal-backend";
import { tmux } from "../tmux";
import { deliverNativePaneInput, resolveNativePaneIncarnation } from "../pane-input-native";
import { executeTmuxPaneInput } from "../pane-input-tmux";
import { deliverPaneInput, newPaneInputDeliveryId, pinTaskPane, sendPaneInput } from "../pane-input";
import {
	type PaneIncarnation,
	type PaneInputOutcome,
	type PaneInputProgram,
} from "../../shared/pane-input";
import type { Task } from "../../shared/types";

const TASK_ID = "ef0ea197-8cac-4134-99dc-1566191ccca7";
const OTHER_TASK_ID = "aaaaaaaa-8cac-4134-99dc-1566191ccca7";

function task(overrides: Partial<Task> = {}): Task {
	return { id: TASK_ID, projectId: "project-1", worktreePath: "/tmp/worktree", ...overrides } as Task;
}

const SERVER_TOKEN = "srv-token-1";

const NATIVE_PIN: PaneIncarnation = {
	backend: "native",
	taskId: TASK_ID,
	paneId: "pane-2",
	sessionId: `dev3-task-${TASK_ID}-pane-2`,
	host: { pid: 10, startSignature: "host-sig" },
	shell: { pid: 11, startSignature: "shell-sig" },
};

const TMUX_PIN: PaneIncarnation = {
	backend: "tmux",
	taskId: TASK_ID,
	paneId: "%3",
	sessionName: `dev3-task-${TASK_ID}`,
	serverToken: SERVER_TOKEN,
};

let programSeq = 0;

// Unique per case: the production ledger is shared and deliberately cannot be reset from
// a test, so a reused id would be deduped instead of reaching the adapter.
function program(incarnation: PaneInputProgram["incarnation"], overrides: Partial<PaneInputProgram> = {}): PaneInputProgram {
	programSeq += 1;
	return {
		deliveryId: `d-${incarnation.paneId}-${programSeq}`,
		attempt: 1,
		incarnation,
		stages: [{ steps: [{ kind: "text", text: "hello" }] }],
		...overrides,
	};
}

function outcome(status: PaneInputOutcome["status"] = "delivered"): PaneInputOutcome {
	return { deliveryId: "x", backend: "native", paneId: "pane-2", status, acceptedThrough: 1 } as PaneInputOutcome;
}

beforeEach(() => {
	vi.mocked(deliverNativePaneInput).mockResolvedValue(outcome());
	vi.mocked(executeTmuxPaneInput).mockResolvedValue(outcome());
	vi.mocked(resolveNativePaneIncarnation).mockResolvedValue({ ok: true, incarnation: NATIVE_PIN });
	vi.mocked(tmux.observePane).mockResolvedValue({
		kind: "present",
		sessionName: `dev3-task-${TASK_ID}`,
		serverToken: SERVER_TOKEN,
	});
});

afterEach(() => {
	vi.clearAllMocks();
});

// At-most-once dedup is keyed on this id. A constant, or a pid-and-counter that a successor
// process restarts, would collide with ids an owner still remembers.
describe("a delivery id is unique per call", () => {
	it("never repeats an id, and keeps the caller's prefix", () => {
		const ids = Array.from({ length: 50 }, () => newPaneInputDeliveryId("alt-click"));
		expect(new Set(ids).size).toBe(ids.length);
		expect(ids.every((id) => id.startsWith("alt-click-"))).toBe(true);
	});
});

describe("the task's persisted backend picks the adapter", () => {
	it("sends a native task through the native adapter only", async () => {
		vi.mocked(taskTerminalBackendIdentity).mockReturnValue("native");
		await deliverPaneInput(task(), program(NATIVE_PIN));
		expect(deliverNativePaneInput).toHaveBeenCalledTimes(1);
		expect(executeTmuxPaneInput).not.toHaveBeenCalled();
	});

	it("sends a tmux task through the tmux adapter only, on the task's socket", async () => {
		vi.mocked(taskTerminalBackendIdentity).mockReturnValue("tmux");
		await deliverPaneInput(task({ tmuxSocket: "custom" }), program(TMUX_PIN));
		expect(executeTmuxPaneInput).toHaveBeenCalledTimes(1);
		expect(vi.mocked(executeTmuxPaneInput).mock.calls[0]?.[1]).toBe("custom");
		expect(deliverNativePaneInput).not.toHaveBeenCalled();
	});

	it("falls back to the default tmux socket when the task has none", async () => {
		vi.mocked(taskTerminalBackendIdentity).mockReturnValue("tmux");
		await deliverPaneInput(task(), program(TMUX_PIN));
		expect(vi.mocked(executeTmuxPaneInput).mock.calls[0]?.[1]).toBe("dev3");
	});
});

describe("a request cannot steer its own routing", () => {
	it("refuses a native task whose program claims the tmux backend", async () => {
		vi.mocked(taskTerminalBackendIdentity).mockReturnValue("native");
		const result = await deliverPaneInput(task(), program({ ...TMUX_PIN }));
		expect(deliverNativePaneInput).not.toHaveBeenCalled();
		expect(executeTmuxPaneInput).not.toHaveBeenCalled();
		expect(result).toMatchObject({ status: "not-started", reason: "invalid-input", backend: "native" });
		if (result.status !== "not-started") return;
		expect(result.detail).toContain("task runs on the native backend");
	});

	it("refuses a tmux task whose program claims the native backend", async () => {
		vi.mocked(taskTerminalBackendIdentity).mockReturnValue("tmux");
		const result = await deliverPaneInput(task(), program(NATIVE_PIN));
		expect(deliverNativePaneInput).not.toHaveBeenCalled();
		expect(executeTmuxPaneInput).not.toHaveBeenCalled();
		expect(result).toMatchObject({ status: "not-started", reason: "invalid-input" });
	});

	it("refuses a program pinned to a different task", async () => {
		vi.mocked(taskTerminalBackendIdentity).mockReturnValue("native");
		const result = await deliverPaneInput(task(), program({ ...NATIVE_PIN, taskId: OTHER_TASK_ID }));
		expect(deliverNativePaneInput).not.toHaveBeenCalled();
		expect(result).toMatchObject({ status: "not-started", reason: "invalid-input" });
		if (result.status !== "not-started") return;
		expect(result.detail).toContain(OTHER_TASK_ID);
	});

	it("reports the TASK's backend on a refusal, not the one the request claimed", async () => {
		vi.mocked(taskTerminalBackendIdentity).mockReturnValue("tmux");
		const result = await deliverPaneInput(task(), program(NATIVE_PIN));
		expect(result.backend).toBe("tmux");
	});

	it("validates the program before it looks at anything else", async () => {
		vi.mocked(taskTerminalBackendIdentity).mockReturnValue("native");
		const result = await deliverPaneInput(task(), program(NATIVE_PIN, { stages: [] }));
		expect(deliverNativePaneInput).not.toHaveBeenCalled();
		expect(result).toMatchObject({ status: "not-started", reason: "invalid-input" });
	});
});

describe("the request is owned before anything awaits", () => {
	// A caller that keeps a reference could otherwise slip past the NUL and byte guards
	// after admission, while the recorded canonical still describes the original bytes.
	it("ignores a mutation made after the call, even before the first microtask", async () => {
		vi.mocked(taskTerminalBackendIdentity).mockReturnValue("native");
		const steps: { kind: "text"; text: string }[] = [{ kind: "text", text: "safe" }];
		const mutable = { deliveryId: "d-mut", attempt: 1, incarnation: NATIVE_PIN, stages: [{ steps }] };

		const running = deliverPaneInput(task(), mutable as never);
		steps[0].text = `dangerous${"\u0000"}`;
		await running;

		expect(vi.mocked(deliverNativePaneInput).mock.calls[0]?.[1]?.stages[0].steps[0]).toEqual({
			kind: "text",
			text: "safe",
		});
	});

	// Pinning is asynchronous, so every call-time input must be owned before it runs.
	it("ignores stages, attempt and deadline mutated while pinning", async () => {
		vi.mocked(taskTerminalBackendIdentity).mockReturnValue("native");
		let release: () => void = () => undefined;
		vi.mocked(resolveNativePaneIncarnation).mockImplementation(
			async () =>
				new Promise((resolve) => {
					release = () => resolve({ ok: true, incarnation: NATIVE_PIN });
				}),
		);
		const steps: { kind: "text"; text: string }[] = [{ kind: "text", text: "safe" }];
		const opts = { deliveryId: "d-while-pinning", attempt: 2, deadlineMs: 4_000 };

		const running = sendPaneInput(task(), "pane-2", [{ steps }], opts);
		// The caller changes its mind mid-pin: text, attempt (2 -> 1, which would turn a
		// probe into a fresh execution) and the deadline.
		steps[0].text = "dangerous";
		opts.attempt = 1;
		opts.deadlineMs = 8_000;
		release();
		await running;

		const handed = vi.mocked(deliverNativePaneInput).mock.calls[0]?.[1];
		expect(handed?.stages[0].steps[0]).toEqual({ kind: "text", text: "safe" });
		expect(handed?.attempt).toBe(2);
		expect(handed?.deadlineMs).toBe(4_000);
	});

	// A coercing normalizer would turn these into valid programs behind validation's back.
	it("refuses an unknown backend, an unknown step kind and boxed identity fields", async () => {
		vi.mocked(taskTerminalBackendIdentity).mockReturnValue("native");
		const bogusBackend = {
			deliveryId: "d-bogus-backend",
			attempt: 1,
			incarnation: { ...NATIVE_PIN, backend: "bogus" },
			stages: [{ steps: [{ kind: "key", key: "ctrl-c" }] }],
		};
		await expect(deliverPaneInput(task(), bogusBackend as never)).resolves.toMatchObject({
			status: "not-started",
			reason: "invalid-input",
		});

		const bogusStep = {
			deliveryId: "d-bogus-step",
			attempt: 1,
			incarnation: NATIVE_PIN,
			stages: [{ steps: [{ kind: "bogus", key: "ctrl-c" }] }],
		};
		await expect(deliverPaneInput(task(), bogusStep as never)).resolves.toMatchObject({
			status: "not-started",
			reason: "invalid-input",
		});

		const boxedIdentity = {
			deliveryId: "d-boxed",
			attempt: 1,
			incarnation: { ...NATIVE_PIN, host: { pid: "10", startSignature: 42 } },
			stages: [{ steps: [{ kind: "text", text: "hi" }] }],
		};
		await expect(deliverPaneInput(task(), boxedIdentity as never)).resolves.toMatchObject({
			status: "not-started",
			reason: "invalid-input",
		});

		expect(deliverNativePaneInput).not.toHaveBeenCalled();
	});

	it("freezes the snapshot it hands on, so nothing downstream can be edited either", async () => {
		vi.mocked(taskTerminalBackendIdentity).mockReturnValue("native");
		await deliverPaneInput(task(), program(NATIVE_PIN));
		const handed = vi.mocked(deliverNativePaneInput).mock.calls[0]?.[1];
		expect(Object.isFrozen(handed)).toBe(true);
		expect(Object.isFrozen(handed?.stages)).toBe(true);
		expect(Object.isFrozen(handed?.stages[0].steps[0])).toBe(true);
	});
});

describe("pinning follows the same rule", () => {
	it("asks the native resolver for a native task", async () => {
		vi.mocked(taskTerminalBackendIdentity).mockReturnValue("native");
		await expect(pinTaskPane(task(), "pane-2")).resolves.toEqual({ ok: true, incarnation: NATIVE_PIN });
		expect(resolveNativePaneIncarnation).toHaveBeenCalledWith(task(), "pane-2");
	});

	it("builds a tmux pin from the task's session name and the live server token", async () => {
		vi.mocked(taskTerminalBackendIdentity).mockReturnValue("tmux");
		await expect(pinTaskPane(task(), "%3")).resolves.toEqual({ ok: true, incarnation: TMUX_PIN });
		expect(resolveNativePaneIncarnation).not.toHaveBeenCalled();
	});

	// The hazard this closes: a server restart BETWEEN two reads. Pane %3 of generation A
	// and a token minted by generation B would pin a pane that no longer exists, and a
	// recycled %3 on the new server would then pass the guard.
	it("takes pane, session and token from ONE observation, so a restart cannot split them", async () => {
		vi.mocked(taskTerminalBackendIdentity).mockReturnValue("tmux");
		vi.mocked(tmux.observePane)
			.mockResolvedValueOnce({ kind: "present", sessionName: `dev3-task-${TASK_ID}`, serverToken: "generation-A" })
			.mockResolvedValue({ kind: "present", sessionName: `dev3-task-${TASK_ID}`, serverToken: "generation-B" });
		const pin = await pinTaskPane(task(), "%3");
		expect(pin).toEqual({ ok: true, incarnation: { ...TMUX_PIN, serverToken: "generation-A" } });
		expect(tmux.observePane).toHaveBeenCalledTimes(1);
	});

	// A server nothing minted a token on has no generation to pin to, and pinning must not
	// write one: it is an observation.
	it("refuses to pin a server that has no dev3 token at all", async () => {
		vi.mocked(taskTerminalBackendIdentity).mockReturnValue("tmux");
		vi.mocked(tmux.observePane).mockResolvedValue({ kind: "unusable", detail: "this tmux server has no dev3 generation token" });
		const pin = await pinTaskPane(task(), "%3");
		expect(pin).toMatchObject({ ok: false, reason: "backend-failure" });
		if (pin.ok) return;
		expect(pin.detail).toContain("no dev3 generation token");
		expect(Object.keys(tmux)).toEqual(["observePane"]);
	});

	// The preflight can PROVE absence; without it a gone pane only surfaced later as a
	// changed incarnation.
	it("reports an observed tmux pane as absent, and an unusable observation as backend-failure", async () => {
		vi.mocked(taskTerminalBackendIdentity).mockReturnValue("tmux");
		vi.mocked(tmux.observePane).mockResolvedValue({ kind: "absent" });
		await expect(pinTaskPane(task(), "%3")).resolves.toMatchObject({ ok: false, reason: "pane-absent" });

		vi.mocked(tmux.observePane).mockResolvedValue({ kind: "unusable", detail: "no server running" });
		await expect(pinTaskPane(task(), "%3")).resolves.toMatchObject({ ok: false, reason: "backend-failure" });
	});

	// A pane that lives in ANOTHER task's session is not this task's pane.
	it("reports a pane observed in a different session as absent", async () => {
		vi.mocked(taskTerminalBackendIdentity).mockReturnValue("tmux");
		vi.mocked(tmux.observePane).mockResolvedValue({
			kind: "present",
			sessionName: "dev3-task-someone-else",
			serverToken: SERVER_TOKEN,
		});
		const pin = await pinTaskPane(task(), "%3");
		expect(pin).toMatchObject({ ok: false, reason: "pane-absent" });
		if (pin.ok) return;
		expect(pin.detail).toContain("dev3-task-someone-else");
	});
});

describe("sendPaneInput wires the pieces together", () => {
	it("pins, then delivers, and passes the caller's attempt through", async () => {
		vi.mocked(taskTerminalBackendIdentity).mockReturnValue("native");
		await sendPaneInput(task(), "pane-2", [{ steps: [{ kind: "key", key: "left", count: 2 }] }], {
			deliveryId: "stable-id",
			attempt: 3,
		});
		const forwarded = vi.mocked(deliverNativePaneInput).mock.calls[0]?.[1];
		expect(forwarded).toMatchObject({ deliveryId: "stable-id", attempt: 3, incarnation: NATIVE_PIN });
	});

	// attempt is mandatory, so a caller that does not set one is a first dispatch.
	it("stamps attempt 1 when the caller does not set one", async () => {
		vi.mocked(taskTerminalBackendIdentity).mockReturnValue("native");
		await sendPaneInput(task(), "pane-2", [{ steps: [{ kind: "text", text: "hi" }] }]);
		expect(vi.mocked(deliverNativePaneInput).mock.calls[0]?.[1]?.attempt).toBe(1);
	});

	it("passes a failed pin's own reason through, without calling an adapter", async () => {
		vi.mocked(taskTerminalBackendIdentity).mockReturnValue("native");
		for (const reason of ["pane-absent", "pane-dead", "backend-failure"] as const) {
			vi.mocked(resolveNativePaneIncarnation).mockResolvedValue({ ok: false, reason, detail: `it is ${reason}` });
			const result = await sendPaneInput(task(), "pane-9", [{ steps: [{ kind: "text", text: "hi" }] }]);
			expect(deliverNativePaneInput).not.toHaveBeenCalled();
			expect(result, reason).toMatchObject({ status: "not-started", reason, paneId: "pane-9" });
		}
	});
});
