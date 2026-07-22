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
			guards: { ifStatus: "in-progress,user-questions" },
		});

		expect(reviewed.next.column.status).toBe("review-by-ai");
	});

	it("rejects a merge finding after the task leaves an eligible column", () => {
		const result = transition(state("in-progress"), {
			type: "mergeDetected",
			branchName: "refactor/lifecycle",
			fingerprint: "v1:refactor/lifecycle:abc123",
			precise: true,
			detectedAt: "2026-07-21T12:00:00.000Z",
			suggestCompletion: true,
		});

		expect(result.effects).toEqual([]);
	});

	it("rejects a duplicate merge finding from the actor's declared reservation", () => {
		const current = state("review-by-user", {
			facts: {
				hasWorktree: true,
				projectKind: "git",
				hasPrIdentity: false,
				peerReviewEnabled: true,
				mergePromptReservation: {
					fingerprint: "v1:refactor/lifecycle:abc123",
					reservedAt: Date.parse("2026-07-21T12:00:00.000Z"),
				},
			},
		});
		const result = transition(current, {
			type: "mergeDetected",
			branchName: "refactor/lifecycle",
			fingerprint: "v1:refactor/lifecycle:abc123",
			precise: true,
			detectedAt: "2026-07-21T12:01:00.000Z",
			suggestCompletion: true,
		});

		expect(result.effects).toEqual([]);
	});

	it("reserves without persisting a merge prompt when completion is manual", () => {
		const current = state("review-by-user", {
			facts: {
				hasWorktree: true,
				projectKind: "git",
				hasPrIdentity: false,
				peerReviewEnabled: true,
				manualCompletion: true,
			},
		});
		const result = transition(current, {
			type: "mergeDetected",
			branchName: "refactor/lifecycle",
			fingerprint: "v1:refactor/lifecycle:abc123",
			precise: true,
			detectedAt: "2026-07-21T12:00:00.000Z",
			suggestCompletion: true,
		});

		expect(result.next.facts.mergeCompletionPrompt).toBeUndefined();
		expect(result.effects.map((effect) => effect.type)).toEqual(["reserveMergePrompt", "push"]);
		expect(result.effects[1]).toMatchObject({
			type: "push",
			message: "branchMerged",
			payload: { noticeOnly: true, shouldNotify: false },
		});
	});

	it("keeps the informational notice when global merge suggestions are disabled", () => {
		const result = transition(state("review-by-user"), {
			type: "mergeDetected",
			branchName: "refactor/lifecycle",
			fingerprint: "v1:refactor/lifecycle:abc123",
			precise: true,
			detectedAt: "2026-07-21T12:00:00.000Z",
			suggestCompletion: false,
		});

		expect(result.effects[1]).toMatchObject({
			type: "push",
			message: "branchMerged",
			payload: { noticeOnly: true, shouldNotify: true },
		});
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
			"persistRuntime",
			"clearMergeThrottle",
			"prepareTask",
		]);
		expect(result.effects[0]).toMatchObject({
			column: { status: "in-progress", customColumnId: "custom-review" },
		});
	});

	it("reserves background launches through the same moveRequested transition", () => {
		const result = transition(state("todo"), {
			type: "moveRequested",
			runId: "variant-run",
			target: { status: "in-progress", customColumnId: null },
			taskPatch: { groupId: "group-1", variantIndex: 1, agentId: "agent-1" },
			preparation: {
				launch: { label: "variant", agentId: "agent-1", configId: null },
				awaitCompletion: false,
				publishColumn: true,
			},
		});

		expect(result.effects.map((candidate) => candidate.type)).toEqual([
			"persistRuntime",
			"clearMergeThrottle",
			"push",
			"notifyStatusChange",
			"prepareTask",
		]);
		expect(result.effects[0]).toMatchObject({
			column: { status: "in-progress", customColumnId: null },
			taskPatch: { groupId: "group-1", variantIndex: 1, agentId: "agent-1" },
		});
		expect(result.effects[4]).toMatchObject({
			awaitCompletion: false,
			columnReserved: true,
		});
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
			"cancelPreparationProcesses",
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

	it("cancels the current preparation and ignores its late success", () => {
		const preparing = state("in-progress", {
			runtime: {
				phase: "preparing",
				stage: "creating-worktree",
				runId: "current-run",
				origin: { status: "todo", customColumnId: null },
			},
		});
		const cancelled = transition(preparing, {
			type: "preparationCancelled",
			runId: "current-run",
		});

		expect(cancelled.next.column.status).toBe("todo");
		expect(cancelled.effects[0]).toMatchObject({ type: "cancelPreparationProcesses" });
		const lateSuccess = transition(cancelled.next, {
			type: "preparationSucceeded",
			runId: "current-run",
			worktreePath: "/tmp/obsolete",
			branchName: "obsolete",
			origin: { status: "todo", customColumnId: null },
			target: { status: "in-progress", customColumnId: null },
			mode: "activation",
		});
		expect(lateSuccess.effects).toEqual([]);
	});

	it("keeps a manual column move when background preparation finishes", () => {
		const preparing = state("in-progress", {
			runtime: {
				phase: "preparing",
				stage: "creating-worktree",
				runId: "current-run",
				origin: { status: "todo", customColumnId: null },
			},
		});
		const manuallyMoved = transition(preparing, {
			type: "moveRequested",
			target: { status: "review-by-ai", customColumnId: null },
		});

		expect(manuallyMoved.next.column.status).toBe("review-by-ai");
		expect(manuallyMoved.effects.some((effect) => effect.type === "launchColumnAgent")).toBe(false);

		const prepared = transition(manuallyMoved.next, {
			type: "preparationSucceeded",
			runId: "current-run",
			worktreePath: "/tmp/current",
			branchName: "current",
			origin: { status: "todo", customColumnId: null },
			target: { status: "in-progress", customColumnId: null },
			mode: "activation",
			columnReserved: true,
		});

		expect(prepared.next.column.status).toBe("review-by-ai");
		expect(prepared.effects[0]).toMatchObject({
			type: "persistColumn",
			column: { status: "review-by-ai", customColumnId: null },
			patch: "activation",
		});
		expect(prepared.effects[prepared.effects.length - 1]).toMatchObject({
			type: "launchColumnAgent",
			column: { status: "review-by-ai", customColumnId: null },
		});
	});

	it("clears a deleted custom column without launching the underlying built-in agent", () => {
		const current = state("review-by-ai", {
			column: { status: "review-by-ai", customColumnId: "obsolete-column" },
		});
		const result = transition(current, {
			type: "moveRequested",
			target: { customColumnId: null },
			launchColumnAgent: false,
		});

		expect(result.next.column).toEqual({ status: "review-by-ai", customColumnId: null });
		expect(result.effects.some((effect) => effect.type === "launchColumnAgent")).toBe(false);
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

	it.each(["completed", "cancelled"] as const)(
		"aborts worktree removal during %s teardown with a recovery event",
		(targetStatus) => {
			const result = transition(state("in-progress"), {
				type: "moveRequested",
				target: { status: targetStatus, customColumnId: null },
				runId: "teardown-run",
			});

			expect(result.effects.find((candidate) => candidate.type === "removeWorktree")).toMatchObject({
				type: "removeWorktree",
				onError: "abort",
				compensatingEvent: {
					type: "teardownFailed",
					runId: "teardown-run",
				},
			});
		},
	);

	it("retries worktree removal for a forced interrupted teardown", () => {
		const result = transition(state("in-progress", {
			runtime: {
				phase: "tearing-down",
				targetStatus: "completed",
				runId: "failed-run",
			},
		}), {
			type: "moveRequested",
			target: { status: "completed", customColumnId: null },
			runId: "retry-run",
			force: true,
		});

		expect(result.effects.find((candidate) => candidate.type === "removeWorktree")).toMatchObject({
			type: "removeWorktree",
			onError: "abort",
			compensatingEvent: { type: "teardownFailed", runId: "retry-run" },
		});
	});

	it("publishes recovery state before rejecting a matching teardown failure", () => {
		const current = state("in-progress", {
			runtime: {
				phase: "tearing-down",
				targetStatus: "completed",
				runId: "failed-run",
			},
		});

		expect(transition(current, {
			type: "teardownFailed",
			runId: "failed-run",
			error: "Git removal failed",
		})).toEqual({
			next: current,
			effects: [
				{ type: "push", message: "taskUpdated", view: "current", onError: "continue" },
				{ type: "reject", message: "Git removal failed", onError: "abort" },
			],
		});
	});

	it("ignores a stale teardown failure event", () => {
		const current = state("in-progress", {
			runtime: {
				phase: "tearing-down",
				targetStatus: "completed",
				runId: "current-run",
			},
		});

		expect(transition(current, {
			type: "teardownFailed",
			runId: "stale-run",
			error: "Git removal failed",
		})).toEqual({ next: current, effects: [] });
	});

	it("allows teardown effects to derive a worktree path during preparation", () => {
		const current = state("in-progress", {
			runtime: {
				phase: "preparing",
				stage: "creating-worktree",
				runId: "teardown-preparation",
				origin: { status: "todo", customColumnId: null },
			},
		});
		const result = transition(current, {
			type: "moveRequested",
			target: { status: "completed", customColumnId: null },
			runId: "teardown-run",
		});

		for (const type of ["runCleanupScript", "captureCompletedDiffStats", "removeWorktree"] as const) {
			expect(result.effects.find((candidate) => candidate.type === type)).toMatchObject({
				allowDerivedPath: true,
			});
		}
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

	it("declares a fresh-state rejection for an invalid CLI transition", () => {
		const current = state("todo");
		const result = transition(current, {
			type: "moveRequested",
			target: { status: "review-by-user", customColumnId: null },
			enforceAllowedTransition: true,
		});

		expect(result.next).toBe(current);
		expect(result.effects[0]).toMatchObject({
			type: "reject",
			message: expect.stringContaining('Cannot move task from "todo" to "review-by-user"'),
			onError: "abort",
		});
	});

	it("clears a custom column on a terminal task without repeating teardown", () => {
		const current = state("completed", {
			column: { status: "completed", customColumnId: "legacy-column" },
		});
		const result = transition(current, {
			type: "moveRequested",
			target: { customColumnId: null },
		});

		expect(result.next.column).toEqual({ status: "completed", customColumnId: null });
		expect(result.effects.some((effect) => effect.type === "persistTerminalTask")).toBe(false);
		expect(result.effects[0]).toMatchObject({ type: "persistColumn", patch: "custom" });
	});

	it("declares task deletion and preparation cancellation in one ordered plan", () => {
		const current = state("in-progress", {
			runtime: {
				phase: "preparing",
				stage: "creating-worktree",
				runId: "delete-run",
				origin: { status: "todo", customColumnId: null },
			},
		});
		const result = transition(current, { type: "deleteRequested" });

		expect(result.effects.map((effect) => effect.type)).toEqual([
			"clearTaskRuntime",
			"cancelPreparationProcesses",
			"releasePorts",
			"destroyTaskPty",
			"killDevServer",
			"runCleanupScript",
			"removeTaskWorkspace",
			"deleteTaskRecord",
		]);
		expect(result.effects.find((effect) => effect.type === "runCleanupScript")).toMatchObject({
			allowDerivedPath: true,
		});
		expect(result.effects.find((effect) => effect.type === "removeTaskWorkspace")).toMatchObject({
			allowDerivedPath: true,
		});
	});

	it("declares merge prompt resolution and PR identity pushes", () => {
		const current = state("review-by-user");
		const dismissed = transition(current, {
			type: "mergePromptDismissed",
			fingerprint: "v1:branch:sha",
			precise: true,
			dismissedAt: "2026-07-21T12:00:00.000Z",
		});
		const identified = transition(current, {
			type: "prIdentityDiscovered",
			prNumber: 42,
			prUrl: "https://github.com/example/repo/pull/42",
		});

		expect(dismissed.effects.map((effect) => effect.type)).toEqual([
			"persistMergeDismissal",
			"push",
		]);
		expect(dismissed.effects[1]).toMatchObject({ message: "mergePromptResolved" });
		expect(identified.effects.map((effect) => effect.type)).toEqual([
			"persistPrStatus",
			"push",
		]);
		expect(identified.effects[1]).toMatchObject({ message: "taskUpdated" });
	});

	it("routes PR promotion and review-agent fallback through moveRequested", () => {
		const review = state("review-by-user");
		const detected = transition(review, {
			type: "prDetected",
			openNonDraft: true,
			payload: {
				projectId: "project-1",
				taskId: "task-1",
				prNumber: 42,
				prUrl: "https://github.com/example/repo/pull/42",
				autoMergeEnabled: null,
				ciStatus: null,
				reviewState: null,
				reviewDecision: null,
				unresolvedCount: null,
				mergeState: null,
				checks: [],
				prTitle: null,
				isDraft: false,
			},
		});
		const promotion = detected.effects.find((candidate) => candidate.type === "sendEvent");

		expect(promotion).toMatchObject({
			type: "sendEvent",
			event: {
				type: "moveRequested",
				cause: "pr-promotion",
				target: { status: "review-by-colleague" },
			},
		});
		if (promotion?.type !== "sendEvent") throw new Error("Expected PR promotion event");
		const promoted = transition(review, promotion.event);
		expect(promoted.next.column.status).toBe("review-by-colleague");
		expect(promoted.effects[0]).toMatchObject({ type: "persistColumn", patch: "statusOnly" });

		const failedReview = transition(state("review-by-ai"), {
			type: "columnAgentFailed",
			columnName: "AI Review",
			error: "launch failed",
		});
		expect(failedReview.effects[0]).toMatchObject({
			type: "sendEvent",
			event: {
				type: "moveRequested",
				cause: "column-agent-fallback",
				target: { status: "review-by-user" },
			},
		});
	});
});

describe("boot runtime reconciliation", () => {
	it.each([
		["idle", false, false, "idle", []],
		["idle", false, true, "idle", []],
		["idle", true, false, "idle", []],
		["idle", true, true, "running", ["persistRuntime"]],
		["running", false, false, "idle", ["persistRuntime"]],
		["running", false, true, "running", []],
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

	it.each([
		[false, false, "todo", "idle"],
		[false, true, "todo", "idle"],
		[true, false, "todo", "idle"],
		[true, true, "in-progress", "running"],
	] as const)(
		"reconciles preparing with worktree=%s tmux=%s",
		(worktreeExists, tmuxAlive, expectedStatus, expectedRuntime) => {
			const current = state("in-progress", {
				runtime: {
					phase: "preparing",
					stage: "creating-worktree",
					runId: "boot-preparing",
					origin: { status: "todo", customColumnId: null },
				},
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

			expect(result.next.column.status).toBe(expectedStatus);
			expect(result.next.runtime.phase).toBe(expectedRuntime);
		},
	);

	it.each([
		[false, false],
		[false, true],
		[true, false],
		[true, true],
	] as const)(
		"reconciles tearing-down with worktree=%s tmux=%s",
		(worktreeExists, tmuxAlive) => {
			const current = state("in-progress", {
				runtime: {
					phase: "tearing-down",
					targetStatus: "completed",
					runId: "boot-teardown",
				},
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

			expect(result.next.column.status).toBe("completed");
			expect(result.next.runtime.phase).toBe("idle");
			expect(result.effects.some((effect) => effect.type === "persistTerminalTask")).toBe(true);
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

	it("persists the probed workspace when preparation already launched tmux", () => {
		const current = state("in-progress", {
			runtime: {
				phase: "preparing",
				stage: "launching-pty",
				runId: "crashed-run",
				origin: { status: "todo", customColumnId: null },
			},
			facts: {
				hasWorktree: false,
				projectKind: "git",
				hasPrIdentity: false,
				peerReviewEnabled: true,
			},
		});
		const result = transition(current, {
			type: "bootObserved",
			reality: {
				worktreeExists: true,
				tmuxAlive: true,
				worktreePath: "/tmp/recovered",
				branchName: "dev3/recovered",
			},
		});

		expect(result.next.runtime.phase).toBe("running");
		expect(result.effects[0]).toMatchObject({
			type: "persistRuntime",
			taskPatch: {
				worktreePath: "/tmp/recovered",
				branchName: "dev3/recovered",
			},
		});
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

	it("aborts boot recovery when worktree removal fails", () => {
		const current = state("in-progress", {
			runtime: {
				phase: "tearing-down",
				targetStatus: "cancelled",
				runId: "teardown-crash",
			},
		});
		const result = transition(current, {
			type: "bootObserved",
			reality: { worktreeExists: true, tmuxAlive: false },
		});

		expect(result.effects.find((candidate) => candidate.type === "removeWorktree")).toMatchObject({
			type: "removeWorktree",
			onError: "abort",
			compensatingEvent: { type: "teardownFailed", runId: "teardown-crash" },
		});
	});
});
