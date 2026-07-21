import { describe, expect, it } from "vitest";
import type { TaskStatus } from "../../../shared/types";
import type { LifecycleState } from "../events";
import { transition } from "../machine";

function state(
	status: TaskStatus,
	overrides: Partial<LifecycleState> = {},
): LifecycleState {
	return {
		column: { status, customColumnId: null },
		runtime: { phase: status === "todo" || status === "completed" || status === "cancelled" ? "idle" : "running" },
		facts: {
			hasWorktree: status !== "todo" && status !== "completed" && status !== "cancelled",
			projectKind: "git",
			hasPrIdentity: false,
			peerReviewEnabled: true,
		},
		...overrides,
	};
}

describe("task lifecycle transition table", () => {
	it("keeps a late bell from overriding a Stop-hook review move", () => {
		const reviewed = transition(state("in-progress"), {
			type: "moveRequested",
			target: { status: "review-by-ai", customColumnId: null },
		});
		const lateBell = transition(reviewed.next, {
			type: "moveRequested",
			target: { status: "user-questions", customColumnId: null },
			guards: { ifStatus: "in-progress" },
		});

		expect(reviewed.next.column.status).toBe("review-by-ai");
		expect(lateBell.next.column.status).toBe("review-by-ai");
		expect(lateBell.effects).toEqual([]);
	});

	it("lets the Stop-hook win when the bell move was processed first", () => {
		const bell = transition(state("in-progress"), {
			type: "moveRequested",
			target: { status: "user-questions", customColumnId: null },
			guards: { ifStatus: "in-progress" },
		});
		const reviewed = transition(bell.next, {
			type: "moveRequested",
			target: { status: "review-by-ai", customColumnId: null },
		});

		expect(reviewed.next.column.status).toBe("review-by-ai");
	});

	it("rejects a merge finding after the task leaves an eligible column", () => {
		const result = transition(state("in-progress"), {
			type: "mergeDetected",
			branchName: "refactor/lifecycle",
			fingerprint: "v1:refactor/lifecycle:abc123",
			precise: true,
		});

		expect(result.effects).toEqual([]);
	});

	it("reopens a completed task into a custom column through preparation", () => {
		const result = transition(state("completed"), {
			type: "moveRequested",
			target: { customColumnId: "custom-review" },
			runId: "run-reopen",
		});

		expect(result.next.column).toEqual({ status: "in-progress", customColumnId: "custom-review" });
		expect(result.next.runtime).toEqual({
			phase: "preparing",
			stage: "resolving-config",
			runId: "run-reopen",
			origin: { status: "completed", customColumnId: null },
		});
		expect(result.effects.map((effect) => effect.type)).toEqual([
			"clearMergeThrottle",
			"persistRuntime",
			"prepareTask",
		]);
	});

	it("reverts a failed preparation to todo and declares the failure push", () => {
		const preparing = state("in-progress", {
			runtime: {
				phase: "preparing",
				stage: "launching-pty",
				runId: "run-failed",
				origin: { status: "todo", customColumnId: null },
			},
			facts: {
				hasWorktree: true,
				projectKind: "git",
				hasPrIdentity: false,
				peerReviewEnabled: true,
			},
		});
		const result = transition(preparing, {
			type: "preparationFailed",
			runId: "run-failed",
			error: "PTY launch failed",
		});

		expect(result.next.column).toEqual({ status: "todo", customColumnId: null });
		expect(result.next.runtime).toEqual({ phase: "idle" });
		expect(result.effects.map((effect) => effect.type)).toEqual([
			"clearTaskRuntime",
			"releasePorts",
			"destroyTaskPty",
			"killDevServer",
			"runCleanupScript",
			"removeWorktree",
			"persistPreparationFailure",
			"push",
			"push",
		]);
		expect(result.effects[result.effects.length - 1]).toMatchObject({
			type: "push",
			message: "taskPreparationFailed",
		});
	});

	it("ignores cancellation from an obsolete preparation run", () => {
		const preparing = state("in-progress", {
			runtime: {
				phase: "preparing",
				stage: "creating-worktree",
				runId: "current-run",
				origin: { status: "todo", customColumnId: null },
			},
		});

		const result = transition(preparing, {
			type: "preparationCancelled",
			runId: "obsolete-run",
		});

		expect(result.next).toEqual(preparing);
		expect(result.effects).toEqual([]);
	});

	it("declares teardown effects in the load-bearing order", () => {
		const result = transition(state("in-progress"), {
			type: "moveRequested",
			target: { status: "completed", customColumnId: null },
			runId: "teardown-run",
		});

		expect(result.next.runtime).toEqual({
			phase: "tearing-down",
			targetStatus: "completed",
			runId: "teardown-run",
		});
		expect(result.effects.map((effect) => effect.type)).toEqual([
			"clearTaskRuntime",
			"releasePorts",
			"persistRuntime",
			"push",
			"destroyTaskPty",
			"killDevServer",
			"runCleanupScript",
			"captureCompletedDiffStats",
			"removeWorktree",
			"persistTerminalTask",
			"push",
			"notifyStatusChange",
			"emitTaskSound",
		]);
		expect(result.effects[3]).toMatchObject({
			type: "push",
			message: "taskUpdated",
			view: "shuttingDown",
		});
	});

	it("rejects a guarded move against the fresh dequeued state", () => {
		const current = state("review-by-user");
		const result = transition(current, {
			type: "moveRequested",
			target: { status: "completed", customColumnId: null },
			guards: { ifStatus: "in-progress" },
		});

		expect(result).toEqual({ next: current, effects: [] });
	});
});

describe("boot runtime reconciliation", () => {
	it.each([
		["idle", false, false, "idle", []],
		["idle", true, true, "running", ["persistRuntime"]],
		["running", true, true, "running", []],
		["running", true, false, "idle", ["persistRuntime"]],
	] as const)(
		"reconciles %s with worktree=%s tmux=%s to %s",
		(runtime, worktreeExists, tmuxAlive, expectedRuntime, expectedEffects) => {
			const current = state("in-progress", {
				runtime: { phase: runtime },
				facts: {
					hasWorktree: worktreeExists,
					projectKind: "git",
					hasPrIdentity: false,
					peerReviewEnabled: true,
				},
			});
			const result = transition(current, {
				type: "bootObserved",
				reality: { worktreeExists, tmuxAlive },
			});

			expect(result.next.runtime.phase).toBe(expectedRuntime);
			expect(result.effects.map((effect) => effect.type)).toEqual(expectedEffects);
		},
	);

	it("reverts an interrupted preparation with no live tmux process", () => {
		const current = state("in-progress", {
			runtime: {
				phase: "preparing",
				stage: "launching-pty",
				runId: "crashed-run",
				origin: { status: "todo", customColumnId: null },
			},
		});
		const result = transition(current, {
			type: "bootObserved",
			reality: { worktreeExists: true, tmuxAlive: false },
		});

		expect(result.next.column.status).toBe("todo");
		expect(result.next.runtime.phase).toBe("idle");
		expect(result.effects[result.effects.length - 1]).toMatchObject({ type: "push", message: "taskUpdated" });
	});

	it("finishes an interrupted teardown when the worktree is already gone", () => {
		const current = state("in-progress", {
			runtime: {
				phase: "tearing-down",
				targetStatus: "cancelled",
				runId: "teardown-crash",
			},
		});
		const result = transition(current, {
			type: "bootObserved",
			reality: { worktreeExists: false, tmuxAlive: false },
		});

		expect(result.next.column.status).toBe("cancelled");
		expect(result.next.runtime.phase).toBe("idle");
		expect(result.effects.map((effect) => effect.type)).toEqual([
			"persistTerminalTask",
			"push",
		]);
	});
});
