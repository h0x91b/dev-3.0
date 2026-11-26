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
	it("resolves to tmux while reporting the marker as absent, and reports the identity without constructing a backend", () => {
		const resolved = resolveTaskTerminalBackend(task());

		expect(resolved.identity).toBe("tmux");
		expect(resolved.present).toBe(false);
		expect(resolved.backend.kind).toBe("tmux");
		expect(taskTerminalBackendIdentity(task())).toBe("tmux");
	});
});

describe("explicit identities", () => {
	it("round-trips explicit tmux and native markers", () => {
		for (const identity of ["tmux", "native"] as const) {
			const resolved = resolveTaskTerminalBackend(task({ terminalBackend: identity }));

			expect(resolved.identity).toBe(identity);
			expect(resolved.present).toBe(true);
			expect(resolved.backend.kind).toBe(identity);
		}
	});
});

describe("undecodable markers", () => {
	it("throws a typed error naming the CLI repair command, the offending value and the task", () => {
		const bad = task({ terminalBackend: "wezterm" });

		expect(() => resolveTaskTerminalBackend(bad)).toThrow(TaskTerminalBackendError);
		expect(() => resolveTaskTerminalBackend(bad)).toThrow(/dev3 task terminal-backend --to tmux/);

		let error: TaskTerminalBackendError | null = null;
		try {
			resolveTaskTerminalBackend(bad);
		} catch (err) {
			error = err as TaskTerminalBackendError;
		}
		expect(error?.taskId).toBe(TASK_ID);
		expect(error?.message).toContain("unknown-value");
		expect(error?.message).toContain("wezterm");
	});

	it("rejects a marker of the wrong type", () => {
		for (const value of [1, null, true, {}, ["native"]]) {
			expect(() => resolveTaskTerminalBackend(task({ terminalBackend: value })), JSON.stringify(value)).toThrow(TaskTerminalBackendError);
		}
	});

	it("never falls back to tmux on any resolver entry point", () => {
		const bad = task({ terminalBackend: "wezterm" });

		expect(() => taskTerminalBackendIdentity(bad)).toThrow(TaskTerminalBackendError);
		expect(() => taskRunsNativeTerminal(bad)).toThrow(TaskTerminalBackendError);
		expect(() => resolveTaskTerminalBackend(bad)).toThrow(TaskTerminalBackendError);
	});
});

describe("nativeTaskSessionId", () => {
	it("is deterministic per task, differs between tasks, and satisfies the session-id rule", () => {
		expect(nativeTaskSessionId(TASK_ID)).toBe(nativeTaskSessionId(TASK_ID));
		expect(nativeTaskSessionId(TASK_ID)).not.toBe(nativeTaskSessionId("99999999-1111-2222-3333-444444444444"));
		expect(nativeTaskSessionId(TASK_ID)).toMatch(SESSION_ID_RULE);
	});
});

describe("taskRunsNativeTerminal", () => {
	it("is true only for an explicit native marker", () => {
		expect(taskRunsNativeTerminal(task({ terminalBackend: "native" }))).toBe(true);
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
