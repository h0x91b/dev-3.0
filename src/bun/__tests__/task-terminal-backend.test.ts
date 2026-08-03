/**
 * The ONE resolver that answers "which backend runs this task's primary
 * terminal" (seq 1292). What is load-bearing here: an unmarked task stays on
 * tmux forever, an undecodable marker fails loudly instead of guessing, and the
 * native session id a task addresses is stable across app restarts.
 */
import { describe, it, expect, vi } from "vitest";
import type { Task } from "../../shared/types";

vi.mock("../logger", () => ({
	createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

// Resolving the host runtime can stage an image or throw, so nothing that merely READS
// state may trigger it. It is spied here rather than stubbed away.
const resolveNativeHostRuntime = vi.hoisted(() => vi.fn(() => ({ kind: "source-checkout", runtimePath: "bun", entry: "e" })));
vi.mock("../native-host-runtime", () => ({
	resolveNativeHostRuntime,
	nativeHostLauncher: () => () => undefined,
}));

import {
	nativeTaskTerminalBackend,
	nativeTaskSessionId,
	resolveTaskTerminalBackend,
	taskRunsNativeTerminal,
	TaskTerminalBackendError,
	taskTerminalBackendIdentity,
} from "../task-terminal-backend";

const TASK_ID = "aabbccdd-1111-2222-3333-444444444444";

// The seam's session-id rule, restated locally: importing it would make this
// file a second production-shaped importer of the guarded seam barrel.
const SESSION_ID_RULE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

function task(overrides: Record<string, unknown> = {}): Task {
	return {
		id: TASK_ID,
		seq: 1,
		projectId: "proj-1",
		title: "Task",
		description: "Task",
		status: "in-progress",
		baseBranch: "main",
		worktreePath: "/tmp/wt",
		branchName: null,
		groupId: null,
		variantIndex: null,
		agentId: null,
		configId: null,
		createdAt: "2026-07-01T00:00:00Z",
		updatedAt: "2026-07-01T00:00:00Z",
		...overrides,
	} as unknown as Task;
}

describe("unmarked tasks", () => {
	it("resolves to tmux while reporting the marker as absent", () => {
		const resolved = resolveTaskTerminalBackend(task());

		expect(resolved.identity).toBe("tmux");
		expect(resolved.present).toBe(false);
		expect(resolved.backend.kind).toBe("tmux");
	});

	it("reports the identity without constructing a backend", () => {
		expect(taskTerminalBackendIdentity(task())).toBe("tmux");
	});
});

describe("explicit identities", () => {
	it("round-trips an explicit tmux marker", () => {
		const resolved = resolveTaskTerminalBackend(task({ terminalBackend: "tmux" }));

		expect(resolved.identity).toBe("tmux");
		expect(resolved.present).toBe(true);
		expect(resolved.backend.kind).toBe("tmux");
	});

	it("round-trips an explicit native marker", () => {
		const resolved = resolveTaskTerminalBackend(task({ terminalBackend: "native" }));

		expect(resolved.identity).toBe("native");
		expect(resolved.present).toBe(true);
		expect(resolved.backend.kind).toBe("native");
	});
});

describe("undecodable markers", () => {
	it("throws a typed error naming the CLI repair command", () => {
		const bad = task({ terminalBackend: "wezterm" });

		expect(() => resolveTaskTerminalBackend(bad)).toThrow(TaskTerminalBackendError);
		expect(() => resolveTaskTerminalBackend(bad)).toThrow(/dev3 task terminal-backend --to tmux/);
	});

	it("carries the offending value and the task it belongs to", () => {
		let error: TaskTerminalBackendError | null = null;
		try {
			resolveTaskTerminalBackend(task({ terminalBackend: "wezterm" }));
		} catch (err) {
			error = err as TaskTerminalBackendError;
		}

		expect(error?.taskId).toBe(TASK_ID);
		expect(error?.message).toContain("unknown-value");
		expect(error?.message).toContain("wezterm");
	});

	it.each([1, null, true, {}, ["native"]])("rejects the wrong type %o", (value) => {
		expect(() => resolveTaskTerminalBackend(task({ terminalBackend: value }))).toThrow(TaskTerminalBackendError);
	});

	it("never falls back to tmux on any resolver entry point", () => {
		const bad = task({ terminalBackend: "wezterm" });

		expect(() => taskTerminalBackendIdentity(bad)).toThrow(TaskTerminalBackendError);
		expect(() => taskRunsNativeTerminal(bad)).toThrow(TaskTerminalBackendError);
		expect(() => resolveTaskTerminalBackend(bad)).toThrow(TaskTerminalBackendError);
	});
});

describe("nativeTaskSessionId", () => {
	it("is deterministic for the same task", () => {
		expect(nativeTaskSessionId(TASK_ID)).toBe(nativeTaskSessionId(TASK_ID));
	});

	it("differs between tasks", () => {
		expect(nativeTaskSessionId(TASK_ID)).not.toBe(nativeTaskSessionId("99999999-1111-2222-3333-444444444444"));
	});

	it("satisfies the session-id rule for a UUID task id", () => {
		expect(nativeTaskSessionId(TASK_ID)).toMatch(SESSION_ID_RULE);
	});
});

describe("taskRunsNativeTerminal", () => {
	it("is true only for an explicit native marker", () => {
		expect(taskRunsNativeTerminal(task({ terminalBackend: "native" }))).toBe(true);
	});

	it("is false for an explicit tmux marker and for an unmarked task", () => {
		expect(taskRunsNativeTerminal(task({ terminalBackend: "tmux" }))).toBe(false);
		expect(taskRunsNativeTerminal(task())).toBe(false);
	});
});

describe("nativeTaskTerminalBackend defers launch setup", () => {
	// Constructing the backend must not resolve the host runtime: an inspection builds one
	// and would otherwise stage an image, or throw, while only reading state.
	it("resolves the host runtime only when a pane is actually started", () => {
		resolveNativeHostRuntime.mockClear();
		nativeTaskTerminalBackend();
		expect(resolveNativeHostRuntime).not.toHaveBeenCalled();
	});
});

