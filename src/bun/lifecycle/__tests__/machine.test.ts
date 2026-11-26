import { describe, expect, it } from "vitest";
import type { TaskStatus } from "../../../shared/types";
import type { LifecycleEvent, LifecycleState } from "../events";
import { activitiesFor, transition } from "../machine";

function state(
	status: TaskStatus,
	overrides: Partial<LifecycleState> = {},
): LifecycleState {
	return {
		column: { status, customColumnId: null },
		runtime: { phase: status === "todo" || status === "completed" || status === "cancelled" ? "idle" : "running" },
		facts: {
			hasWorktree: status !== "todo" && status !== "completed" && status !== "cancelled",
			usesWorktrees: true,
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

		// Reverse order: the Stop-hook still wins when the bell move was processed first.
		const bell = transition(state("in-progress"), {
			type: "moveRequested",
			target: { status: "user-questions", customColumnId: null },
			guards: { ifStatus: "in-progress" },
		});
		const reviewedAfterBell = transition(bell.next, {
			type: "moveRequested",
			target: { status: "review-by-ai", customColumnId: null },
			guards: { ifStatus: "in-progress,user-questions" },
		});
		expect(reviewedAfterBell.next.column.status).toBe("review-by-ai");
	});

	it("rejects a merge finding outside an eligible column or duplicating the actor's reservation", () => {
		const ineligible = transition(state("in-progress"), {
			type: "mergeDetected",
			branchName: "refactor/lifecycle",
			fingerprint: "v1:refactor/lifecycle:abc123",
			precise: true,
			detectedAt: "2026-07-21T12:00:00.000Z",
			suggestCompletion: true,
		});
		expect(ineligible.effects).toEqual([]);

		const current = state("review-by-user", {
			facts: {
				hasWorktree: true,
				usesWorktrees: true,
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

	it("reserves a notice-only merge prompt for manual completion and keeps the notice when suggestions are off", () => {
		const current = state("review-by-user", {
			facts: {
				hasWorktree: true,
				usesWorktrees: true,
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

		const suggestionsOff = transition(state("review-by-user"), {
			type: "mergeDetected",
			branchName: "refactor/lifecycle",
			fingerprint: "v1:refactor/lifecycle:abc123",
			precise: true,
			detectedAt: "2026-07-21T12:00:00.000Z",
			suggestCompletion: false,
		});
		expect(suggestionsOff.effects[1]).toMatchObject({
			type: "push",
			message: "branchMerged",
			payload: { noticeOnly: true, shouldNotify: true },
		});
	});

	it("reopens a completed task into a custom column, and reserves background launches, through preparation", () => {
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

		{
			// Reserves background launches through the same moveRequested transition.
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
		}
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
				usesWorktrees: true,
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
			"gracefulAgentExit",
			"destroyTaskPty",
			"killDevServer",
			"judgeFailureWorkspace",
			"runCleanupScript",
			"reapWorktreeProcesses",
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

	it("asks the agent to quit right before the terminal is killed on every teardown path", () => {
		const cases = [
			["completion", { type: "moveRequested", target: { status: "completed" }, runId: "run-x" }],
			["cancellation", { type: "moveRequested", target: { status: "cancelled" }, runId: "run-x" }],
			["hibernation", { type: "hibernateRequested" }],
			["deletion", { type: "deleteRequested" }],
		] as const;
		for (const [label, event] of cases) {
			const result = transition(state("in-progress"), event as LifecycleEvent);
			const types = result.effects.map((candidate) => candidate.type);
			const exit = types.indexOf("gracefulAgentExit");

			expect(exit, label).toBeGreaterThanOrEqual(0);
			expect(types[exit + 1], label).toBe("destroyTaskPty");
			// Never an abort: a hook that hangs, or an agent that ignores the request, must
			// not keep the worktree alive — the kill that follows is the guarantee.
			expect(result.effects[exit], label).toMatchObject({ onError: "continue" });
		}
	});

	it("ignores cancellation from an obsolete run, cancels the current preparation and ignores its late success", () => {
		const preparing = state("in-progress", {
			runtime: {
				phase: "preparing",
				stage: "creating-worktree",
				runId: "current-run",
				origin: { status: "todo", customColumnId: null },
			},
		});
		const obsolete = transition(preparing, {
			type: "preparationCancelled",
			runId: "obsolete-run",
		});
		expect(obsolete.next).toEqual(preparing);
		expect(obsolete.effects).toEqual([]);

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

	it("silences the merge prompt only for a reopened task with a branch, never on a first start", () => {
		const dismisses = (
			origin: "completed" | "todo",
			target: "review-by-user" | "in-progress",
			branchName: string | null,
			usesWorktrees = true,
		) => {
			const preparing = state(target, {
				runtime: {
					phase: "preparing",
					stage: "creating-worktree",
					runId: "run",
					origin: { status: origin, customColumnId: null },
				},
				facts: { hasWorktree: true, usesWorktrees, hasPrIdentity: false, peerReviewEnabled: true },
			});
			return transition(preparing, {
				type: "preparationSucceeded",
				runId: "run",
				worktreePath: "/tmp/wt",
				branchName,
				origin: { status: origin, customColumnId: null },
				target: { status: target, customColumnId: null },
				mode: "activation",
			}).effects.some((effect) => effect.type === "dismissMergePromptForCurrentHead");
		};

		expect(dismisses("completed", "review-by-user", "fix/thing"), "reopen").toBe(true);
		expect(dismisses("todo", "in-progress", "feat/thing"), "first start").toBe(false);
		expect(dismisses("completed", "review-by-user", null, false), "virtual project, no branch").toBe(false);
	});

	it("clears a deleted custom column without launching the built-in agent, and on a terminal task without repeating teardown", () => {
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

		{
			// Clears a custom column on a terminal task without repeating teardown.
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
		}
	});

	describe("Operations tasks moved to completed or cancelled", () => {
		it("removes a worktree-mode task's workspace (also from To Do, via a derived path) and keeps a plain task's folder", () => {
			for (const target of ["completed", "cancelled"] as const) {
			const opsState = (opsWorktree: boolean) => state("in-progress", {
				facts: { hasWorktree: true, usesWorktrees: false, hasPrIdentity: false, peerReviewEnabled: true, ...(opsWorktree ? { opsWorktree } : {}) },
			});
			const teardown = (current: LifecycleState) => transition(current, {
				type: "moveRequested",
				target: { status: target, customColumnId: null },
				runId: "run",
			}).effects.map((effect) => effect.type);

				const types = teardown(opsState(true));
				expect(types).toContain("removeTaskWorkspace");
				expect(types.indexOf("reapWorktreeProcesses")).toBeLessThan(types.indexOf("removeTaskWorkspace"));
				expect(types.indexOf("removeTaskWorkspace")).toBeLessThan(types.indexOf("persistTerminalTask"));
				expect(types).not.toContain("removeWorktree");

				// From To Do the record has no path (reset or failed preparation).
				const todo = state("todo", {
					facts: { hasWorktree: false, usesWorktrees: false, hasPrIdentity: false, peerReviewEnabled: true, opsWorktree: true },
				});
				const fromTodo = transition(todo, { type: "moveRequested", target: { status: target, customColumnId: null }, runId: "run" });
				expect(fromTodo.effects.find((e) => e.type === "removeTaskWorkspace")).toMatchObject({ allowDerivedPath: true });
				const todoTypes = fromTodo.effects.map((e) => e.type);
				expect(todoTypes.indexOf("removeTaskWorkspace")).toBeLessThan(todoTypes.indexOf("persistTerminalTask"));

				const plain = teardown(opsState(false));
				expect(plain).not.toContain("removeTaskWorkspace");
				expect(plain).not.toContain("removeWorktree");
			}
		});
	});

	describe("plain Operations task with a repo in its own folder moved to completed or cancelled", () => {
		it("removes the attached worktree best-effort with the approved repo, after the reap, and only with the fact", () => {
			for (const target of ["completed", "cancelled"] as const) {
			const make = (attachedRepoInFolder: boolean) => state("in-progress", {
				facts: { hasWorktree: true, usesWorktrees: false, hasPrIdentity: false, peerReviewEnabled: true, ...(attachedRepoInFolder ? { attachedRepoInFolder } : {}) },
			});
			const teardown = (current: LifecycleState, approvedAttachedRepo?: string | null) => transition(current, {
				type: "moveRequested",
				target: { status: target, customColumnId: null },
				runId: "run",
				...(approvedAttachedRepo !== undefined ? { approvedAttachedRepo } : {}),
			}).effects;

				expect(teardown(make(true), "/ops/s/ab/work/wt").find((e) => e.type === "removeAttachedWorktree")).toMatchObject({ approvedAttachedRepo: "/ops/s/ab/work/wt" });
				const effects = teardown(make(true));
				const types = effects.map((e) => e.type);
				expect(effects.find((e) => e.type === "removeAttachedWorktree")).toMatchObject({ onError: "continue", approvedAttachedRepo: null });
				expect(types.indexOf("reapWorktreeProcesses")).toBeLessThan(types.indexOf("removeAttachedWorktree"));
				expect(types.indexOf("removeAttachedWorktree")).toBeLessThan(types.indexOf("persistTerminalTask"));
				expect(types).not.toContain("removeTaskWorkspace");
				expect(teardown(make(false)).map((e) => e.type)).not.toContain("removeAttachedWorktree");
			}
		});
	});

	it("reset removes the attached worktree of a plain Operations task only with the fact and consent, and the workspace of a worktree-mode one (also on delete from To Do)", () => {
		const consent = { worktreePath: "/w", lifecycleStartedAt: "S", attachedRepo: "/w/wt", approvedAttachedRepo: "/w/wt" };
		const make = (attachedRepoInFolder: boolean) => state("in-progress", {
			facts: { hasWorktree: true, usesWorktrees: false, hasPrIdentity: false, peerReviewEnabled: true, worktreePath: "/w", lifecycleStartedAt: "S", attachedRepo: "/w/wt", ...(attachedRepoInFolder ? { attachedRepoInFolder } : {}) },
		});
		const effects = transition(make(true), { type: "resetRequested", consent }).effects;
		const types = effects.map((e) => e.type);

		expect(effects.find((e) => e.type === "removeAttachedWorktree")).toMatchObject({ onError: "continue", approvedAttachedRepo: "/w/wt" });
		// A dialog whose unsaved-work check failed approves nothing, yet the reset still goes ahead.
		const unchecked = transition(make(true), { type: "resetRequested", consent: { ...consent, approvedAttachedRepo: null } }).effects;
		expect(unchecked.find((e) => e.type === "removeAttachedWorktree")).toMatchObject({ approvedAttachedRepo: null });
		expect(unchecked.map((e) => e.type)).not.toContain("reject");
		// Another client swapped the attached repo after the dialog: the consent no longer matches.
		const swapped = transition(make(true), { type: "resetRequested", consent: { ...consent, attachedRepo: "/w/other" } }).effects;
		expect(swapped.map((e) => e.type)).toEqual(["reject"]);
		expect(types.indexOf("reapWorktreeProcesses")).toBeLessThan(types.indexOf("removeAttachedWorktree"));
		expect(types.indexOf("removeAttachedWorktree")).toBeLessThan(types.indexOf("persistResetTask"));
		expect(transition(make(false), { type: "resetRequested", consent }).effects.map((e) => e.type)).not.toContain("removeAttachedWorktree");

		{
			// Reset removes the workspace of a worktree-mode Operations task and not of a plain one.
			const consent = { worktreePath: "/w", lifecycleStartedAt: "S", attachedRepo: null, approvedAttachedRepo: null };
			const make = (opsWorktree: boolean) => state("in-progress", {
				facts: { hasWorktree: true, usesWorktrees: false, hasPrIdentity: false, peerReviewEnabled: true, worktreePath: "/w", lifecycleStartedAt: "S", ...(opsWorktree ? { opsWorktree } : {}) },
			});
			const types = (opsWorktree: boolean) => transition(make(opsWorktree), { type: "resetRequested", consent }).effects.map((e) => e.type);

			const owned = types(true);
			expect(owned).toContain("removeTaskWorkspace");
			expect(owned.indexOf("removeTaskWorkspace")).toBeLessThan(owned.indexOf("persistResetTask"));
			expect(owned).not.toContain("resetWorktree");
			expect(types(false)).not.toContain("removeTaskWorkspace");
		}

		{
			// Deleting a worktree-mode Operations task from To Do still removes its derived workspace.
			const todo = state("todo", {
				facts: { hasWorktree: false, usesWorktrees: false, hasPrIdentity: false, peerReviewEnabled: true, opsWorktree: true },
			});
			const { effects } = transition(todo, { type: "deleteRequested" });

			expect(effects.find((e) => e.type === "removeTaskWorkspace")).toMatchObject({ allowDerivedPath: true });
			const plain = transition(state("todo", { facts: { hasWorktree: false, usesWorktrees: false, hasPrIdentity: false, peerReviewEnabled: true } }), { type: "deleteRequested" });
			expect(plain.effects.some((e) => e.type === "removeTaskWorkspace")).toBe(false);
		}
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
			// The chime leads: teardown takes seconds and aborts the chain when it
			// fails, so a sound at the tail arrives late or never.
			"emitTaskSound",
			"clearTaskRuntime",
			"releasePorts",
			"persistRuntime",
			"push",
			"gracefulAgentExit",
			"destroyTaskPty",
			"killDevServer",
			"runCleanupScript",
			"captureCompletedDiffStats",
			"dumpTaskConversations",
			"reapWorktreeProcesses",
			"removeWorktree",
			"persistTerminalTask",
			"push",
			"notifyStatusChange",
		]);
		expect(result.effects[4]).toMatchObject({
			type: "push",
			message: "taskUpdated",
			view: "shuttingDown",
		});
		// The PTY teardown aborts with a recovery event; the reap (one stubborn foreign
		// process) and the conversation archive (a missing archive) are best-effort.
		expect(result.effects.find((candidate) => candidate.type === "destroyTaskPty")).toMatchObject({
			onError: "abort",
			compensatingEvent: { type: "teardownFailed", runId: "teardown-run" },
		});
		for (const type of ["reapWorktreeProcesses", "dumpTaskConversations"] as const) {
			expect(result.effects.find((candidate) => candidate.type === type), type).not.toMatchObject({ onError: "abort" });
		}
	});

	it("aborts worktree removal during teardown, and on a forced retry, with a recovery event", () => {
		for (const targetStatus of ["completed", "cancelled"] as const) {
			const result = transition(state("in-progress"), {
				type: "moveRequested",
				target: { status: targetStatus, customColumnId: null },
				runId: "teardown-run",
			});

			expect(result.effects.find((candidate) => candidate.type === "removeWorktree"), targetStatus).toMatchObject({
				type: "removeWorktree",
				onError: "abort",
				compensatingEvent: {
					type: "teardownFailed",
					runId: "teardown-run",
				},
			});
		}

		{
			// Retries worktree removal for a forced interrupted teardown.
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
		}
	});

	it("publishes recovery state before rejecting a matching teardown failure", () => {
		const current = state("in-progress", {
			runtime: {
				phase: "tearing-down",
				targetStatus: "completed",
				runId: "failed-run",
			},
		});

		const failed = { phase: "tearing-down", targetStatus: "completed", runId: "failed-run", failed: true } as const;
		expect(transition(current, {
			type: "teardownFailed",
			runId: "failed-run",
			error: "Git removal failed",
		})).toEqual({
			next: { ...current, runtime: failed },
			effects: [
				{ type: "persistRuntime", runtime: failed, onError: "continue" },
				{ type: "push", message: "taskUpdated", view: "current", onError: "continue" },
				{ type: "reject", message: "Git removal failed", onError: "abort" },
			],
		});
		// A stale run's failure is ignored.
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

	it("rejects a guarded move and an invalid CLI transition against the fresh dequeued state", () => {
		const current = state("review-by-user");
		const result = transition(current, {
			type: "moveRequested",
			target: { status: "completed", customColumnId: null },
			guards: { ifStatus: "in-progress" },
		});

		expect(result).toEqual({ next: current, effects: [] });

		// An invalid CLI transition declares a fresh-state rejection.
		const todo = state("todo");
		const cli = transition(todo, {
			type: "moveRequested",
			target: { status: "review-by-user", customColumnId: null },
			enforceAllowedTransition: true,
		});
		expect(cli.next).toBe(todo);
		expect(cli.effects[0]).toMatchObject({
			type: "reject",
			message: expect.stringContaining('Cannot move task from "todo" to "review-by-user"'),
			onError: "abort",
		});
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
			"gracefulAgentExit",
			"destroyTaskPty",
			"killDevServer",
			"runCleanupScript",
			"reapWorktreeProcesses",
			"removeTaskWorkspace",
			"deleteTaskRecord",
			"push",
		]);
		expect(result.effects.find((effect) => effect.type === "runCleanupScript")).toMatchObject({
			allowDerivedPath: true,
		});
		expect(result.effects.find((effect) => effect.type === "removeTaskWorkspace")).toMatchObject({
			allowDerivedPath: true,
		});

		// A running task's delete aborts before cleanup and the record delete when the PTY teardown fails.
		const running = transition(state("in-progress"), { type: "deleteRequested" });
		const types = running.effects.map((candidate) => candidate.type);
		expect(running.effects.find((candidate) => candidate.type === "destroyTaskPty")).toMatchObject({ onError: "abort" });
		expect(types.indexOf("destroyTaskPty")).toBeLessThan(types.indexOf("runCleanupScript"));
		expect(types.indexOf("removeTaskWorkspace")).toBeLessThan(types.indexOf("deleteTaskRecord"));
	});

	it("declares merge prompt resolution and PR identity pushes, and routes PR promotion and review-agent fallback through moveRequested", () => {
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

		{
			// Routes PR promotion and review-agent fallback through moveRequested.
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
				column: { kind: "builtin", status: "review-by-ai" },
				error: "launch failed",
			});
			const fallback = failedReview.effects.find((candidate) => candidate.type === "sendEvent");
			expect(fallback).toMatchObject({
				type: "sendEvent",
				event: {
					type: "moveRequested",
					cause: "column-agent-fallback",
					target: { status: "review-by-user" },
					columnAgentFailure: { column: { kind: "builtin", status: "review-by-ai" }, error: "launch failed" },
				},
			});
			// The failure rides on the move rather than being pushed here, so the report
			// cannot claim a move that never landed.
			expect(failedReview.effects.some((candidate) => candidate.type === "push")).toBe(false);
		}
	});

	it("reports a fallback move only after the column write, and claims the column it wrote", () => {
		const moved = transition(state("review-by-ai"), {
			type: "moveRequested",
			target: { status: "review-by-user", customColumnId: null },
			cause: "column-agent-fallback",
			guards: { ifStatus: "review-by-ai" },
			columnAgentFailure: {
				column: { kind: "builtin", status: "review-by-ai" },
				error: "launch failed",
				reason: "terminal-not-running",
			},
		});
		const persistIndex = moved.effects.findIndex((candidate) => candidate.type === "persistColumn");
		const reportIndex = moved.effects.findIndex(
			(candidate) => candidate.type === "push" && candidate.message === "columnAgentFailed",
		);
		expect(persistIndex).toBeGreaterThanOrEqual(0);
		// A rejected or failed column write stops the effect run, so ordering is what
		// keeps the toast honest.
		expect(reportIndex).toBeGreaterThan(persistIndex);
		expect(moved.effects[reportIndex]).toMatchObject({
			payload: { reason: "terminal-not-running", movedTo: "review-by-user" },
		});

		// An ordinary move says nothing extra.
		const ordinary = transition(state("review-by-ai"), {
			type: "moveRequested",
			target: { status: "review-by-user", customColumnId: null },
		});
		expect(
			ordinary.effects.some((candidate) => candidate.type === "push" && candidate.message === "columnAgentFailed"),
		).toBe(false);
	});
});

describe("needs-you chime", () => {
	function soundsOf(effects: ReturnType<typeof transition>["effects"]) {
		return effects.filter((candidate) => candidate.type === "emitTaskSound");
	}

	it("chimes only for a needs-you move made by a hook or a failed AI review fallback, after the column write", () => {
		for (const target of ["review-by-user", "user-questions"] as const) {
			const moved = transition(state("in-progress"), {
				type: "moveRequested",
				target: { status: target, customColumnId: null },
				guards: { ifStatus: "in-progress" },
			});
			const persistIndex = moved.effects.findIndex((candidate) => candidate.type === "persistColumn");
			const soundIndex = moved.effects.findIndex((candidate) => candidate.type === "emitTaskSound");

			expect(soundsOf(moved.effects), target).toEqual([expect.objectContaining({ status: target })]);
			// A guard-rejected write stops the effect run, so a refused hook stays silent.
			expect(soundIndex, target).toBeGreaterThan(persistIndex);
		}

		const fallback = transition(state("review-by-ai"), {
			type: "moveRequested",
			target: { status: "review-by-user", customColumnId: null },
			cause: "column-agent-fallback",
			guards: { ifStatus: "review-by-ai" },
		});
		expect(soundsOf(fallback.effects)).toEqual([expect.objectContaining({ status: "review-by-user" })]);

		{
			// Stays silent when the UI owns the sound, the status does not change, or the target is not a needs-you column.
			const uiOwned = transition(state("in-progress"), {
				type: "moveRequested",
				target: { status: "review-by-user", customColumnId: null },
				clientPlayedSound: true,
			});
			expect(soundsOf(uiOwned.effects), "UI owns the sound").toEqual([]);

			const sameStatus = transition(state("review-by-user", {
				column: { status: "review-by-user", customColumnId: "qa-column" },
			}), {
				type: "moveRequested",
				target: { status: "review-by-user", customColumnId: null },
			});
			expect(sameStatus.effects.some((candidate) => candidate.type === "persistColumn")).toBe(true);
			expect(soundsOf(sameStatus.effects), "same status").toEqual([]);

			for (const target of ["in-progress", "review-by-ai", "review-by-colleague"] as const) {
				const moved = transition(state("user-questions"), {
					type: "moveRequested",
					target: { status: target, customColumnId: null },
				});
				expect(soundsOf(moved.effects), target).toEqual([]);
			}
		}
	});
});

describe("User questions badge", () => {
	function badgesOf(effects: ReturnType<typeof transition>["effects"]) {
		return effects.filter((candidate) => candidate.type === "raiseQuestionsAttention");
	}

	it("raises the badge only when a hook moves the task into User questions, after the column write", () => {
		const moved = transition(state("in-progress"), {
			type: "moveRequested",
			target: { status: "user-questions", customColumnId: null },
			guards: { ifStatus: "in-progress" },
		});
		const persistIndex = moved.effects.findIndex((candidate) => candidate.type === "persistColumn");
		const badgeIndex = moved.effects.findIndex((candidate) => candidate.type === "raiseQuestionsAttention");

		expect(badgesOf(moved.effects)).toHaveLength(1);
		expect(badgeIndex).toBeGreaterThan(persistIndex);

		{
			// Raises no badge for a UI move, a caller-raised badge, a move within User questions, or another target.
			const cases: Array<[string, LifecycleState, LifecycleEvent]> = [
				["UI made the move", state("in-progress"), { type: "moveRequested", target: { status: "user-questions", customColumnId: null }, clientPlayedSound: true }],
				["caller raises its own", state("in-progress"), { type: "moveRequested", target: { status: "user-questions", customColumnId: null }, skipQuestionsBadge: true }],
				[
					"stays in User questions",
					state("user-questions", { column: { status: "user-questions", customColumnId: "qa-column" } }),
					{ type: "moveRequested", target: { status: "user-questions", customColumnId: null } },
				],
				...(["review-by-user", "in-progress", "review-by-ai"] as const).map((target): [string, LifecycleState, LifecycleEvent] => [
					`move into ${target}`,
					state("in-progress"),
					{ type: "moveRequested", target: { status: target, customColumnId: null } },
				]),
			];
			for (const [label, current, event] of cases) {
				expect(badgesOf(transition(current, event).effects), label).toEqual([]);
			}
		}
	});
});

describe("boot runtime reconciliation", () => {
	const facts = (hasWorktree: boolean) => ({
		hasWorktree,
		usesWorktrees: true,
		hasPrIdentity: false,
		peerReviewEnabled: true,
	});

	it("reconciles idle and running runtimes against every worktree/tmux combination", () => {
		const table = [
			["idle", false, false, "idle", []],
			["idle", false, true, "idle", []],
			["idle", true, false, "idle", []],
			["idle", true, true, "running", ["persistRuntime"]],
			["running", false, false, "idle", ["persistRuntime"]],
			["running", false, true, "running", []],
			["running", true, true, "running", []],
			["running", true, false, "idle", ["persistRuntime"]],
		] as const;
		for (const [runtime, worktreeExists, terminalAlive, expectedRuntime, expectedEffects] of table) {
			const label = `${runtime} worktree=${worktreeExists} tmux=${terminalAlive}`;
			const result = transition(state("in-progress", { runtime: { phase: runtime }, facts: facts(worktreeExists) }), {
				type: "bootObserved",
				reality: { worktreeExists, terminalAlive },
			});

			expect(result.next.runtime.phase, label).toBe(expectedRuntime);
			expect(result.effects.map((effect) => effect.type), label).toEqual(expectedEffects);
		}
	});

	it("reconciles an interrupted preparation: reverts to To Do unless both the worktree and tmux survived, then persists the probed workspace", () => {
		const table = [
			[false, false, "todo", "idle"],
			[false, true, "todo", "idle"],
			[true, false, "todo", "idle"],
			[true, true, "in-progress", "running"],
		] as const;
		for (const [worktreeExists, terminalAlive, expectedStatus, expectedRuntime] of table) {
			const label = `worktree=${worktreeExists} tmux=${terminalAlive}`;
			const result = transition(state("in-progress", {
				runtime: {
					phase: "preparing",
					stage: "launching-pty",
					runId: "crashed-run",
					origin: { status: "todo", customColumnId: null },
				},
				facts: facts(worktreeExists),
			}), {
				type: "bootObserved",
				reality: { worktreeExists, terminalAlive },
			});

			expect(result.next.column.status, label).toBe(expectedStatus);
			expect(result.next.runtime.phase, label).toBe(expectedRuntime);
			if (expectedStatus === "todo") {
				expect(result.effects[result.effects.length - 1], label).toMatchObject({ type: "push", message: "taskUpdated" });
			}
		}

		{
			// Persists the probed workspace when preparation already launched tmux.
			const current = state("in-progress", {
				runtime: {
					phase: "preparing",
					stage: "launching-pty",
					runId: "crashed-run",
					origin: { status: "todo", customColumnId: null },
				},
				facts: {
					hasWorktree: false,
					usesWorktrees: true,
					hasPrIdentity: false,
					peerReviewEnabled: true,
				},
			});
			const result = transition(current, {
				type: "bootObserved",
				reality: {
					worktreeExists: true,
					terminalAlive: true,
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
		}
	});

	it("finishes an interrupted teardown for every worktree/tmux combination, aborting if worktree removal fails and removing a plain Operations task's linked worktree only with the fact", () => {
		for (const worktreeExists of [false, true]) {
			for (const terminalAlive of [false, true]) {
				const label = `worktree=${worktreeExists} tmux=${terminalAlive}`;
				const result = transition(state("in-progress", {
					runtime: { phase: "tearing-down", targetStatus: "cancelled", runId: "teardown-crash" },
					facts: facts(worktreeExists),
				}), {
					type: "bootObserved",
					reality: { worktreeExists, terminalAlive },
				});

				expect(result.next.column.status, label).toBe("cancelled");
				expect(result.next.runtime.phase, label).toBe("idle");
				expect(result.effects.some((effect) => effect.type === "persistTerminalTask"), label).toBe(true);
			}
		}

		const alreadyGone = transition(state("in-progress", {
			runtime: { phase: "tearing-down", targetStatus: "cancelled", runId: "teardown-crash" },
		}), { type: "bootObserved", reality: { worktreeExists: false, terminalAlive: false } });
		expect(alreadyGone.effects.map((effect) => effect.type)).toEqual(["persistTerminalTask", "push"]);

		const worktreeLeft = transition(state("in-progress", {
			runtime: { phase: "tearing-down", targetStatus: "cancelled", runId: "teardown-crash" },
		}), { type: "bootObserved", reality: { worktreeExists: true, terminalAlive: false } });
		expect(worktreeLeft.effects.find((candidate) => candidate.type === "removeWorktree")).toMatchObject({
			type: "removeWorktree",
			onError: "abort",
			compensatingEvent: { type: "teardownFailed", runId: "teardown-crash" },
		});

		{
			// Removes a linked worktree of a plain Operations task when boot recovery finishes its teardown, and only with the fact.
			const resumed = (attachedRepoInFolder: boolean) => transition(state("in-progress", {
				runtime: { phase: "tearing-down", targetStatus: "cancelled", runId: "teardown-crash" },
				facts: { hasWorktree: true, usesWorktrees: false, hasPrIdentity: false, peerReviewEnabled: true, ...(attachedRepoInFolder ? { attachedRepoInFolder } : {}) },
			}), {
				type: "bootObserved",
				reality: { worktreeExists: true, terminalAlive: false },
			}).effects;

			const withFact = resumed(true);
			const types = withFact.map((effect) => effect.type);
			expect(withFact.find((effect) => effect.type === "removeAttachedWorktree")).toMatchObject({ onError: "continue" });
			expect(types.indexOf("reapWorktreeProcesses")).toBeLessThan(types.indexOf("removeAttachedWorktree"));
			expect(types.indexOf("removeAttachedWorktree")).toBeLessThan(types.indexOf("persistTerminalTask"));
			expect(resumed(false).map((effect) => effect.type)).not.toContain("removeAttachedWorktree");
		}
	});

	it("puts a disconnected task back to running once a terminal attaches, and only such a task", () => {
		const disconnected = state("in-progress", { runtime: { phase: "idle" } });
		const result = transition(disconnected, { type: "terminalAttached" });

		expect(result.next.runtime.phase).toBe("running");
		expect(result.effects.map((effect) => effect.type)).toEqual(["persistRuntime", "push"]);

		{
			// Ignores an attaching terminal on a self-owned runtime or a hibernated, parked or worktree-less task.
			for (const phase of ["running", "preparing", "tearing-down"] as const) {
				const runtime = phase === "preparing"
					? { phase, stage: "launching-pty" as const, runId: "r", origin: { status: "todo" as const, customColumnId: null } }
					: phase === "tearing-down"
						? { phase, targetStatus: "completed" as const, runId: "r" }
						: { phase };
				const result = transition(state("in-progress", { runtime }), { type: "terminalAttached" });
				expect(result.next.runtime.phase, phase).toBe(phase);
				expect(result.effects, phase).toEqual([]);
			}

			const hibernated = state("in-progress", {
				runtime: { phase: "idle" },
				facts: { hasWorktree: true, usesWorktrees: true, hasPrIdentity: false, peerReviewEnabled: true, hibernated: true },
			});
			expect(transition(hibernated, { type: "terminalAttached" }).effects).toEqual([]);

			const todo = state("todo", { runtime: { phase: "idle" } });
			expect(transition(todo, { type: "terminalAttached" }).effects).toEqual([]);

			const noWorktree = state("in-progress", {
				runtime: { phase: "idle" },
				facts: { hasWorktree: false, usesWorktrees: true, hasPrIdentity: false, peerReviewEnabled: true },
			});
			expect(transition(noWorktree, { type: "terminalAttached" }).effects).toEqual([]);
		}
	});

});

// A draft is a task the user explicitly marked unfinished. The rule lives here,
// in the pure transition, because every activation path (Run button, board drag,
// variant spawn, scheduled launch, automation, CLI) funnels through it.
describe("draft tasks cannot be activated", () => {
	const draft = () => state("todo", {
		facts: {
			hasWorktree: false,
			usesWorktrees: true,
			hasPrIdentity: false,
			peerReviewEnabled: true,
			draft: true,
		},
	});

	it("refuses a draft every activation, yet lets it move inside To Do and be deleted; an ordinary To Do task stays activatable", () => {
		for (const target of ["in-progress", "user-questions", "review-by-ai", "review-by-user", "review-by-colleague"] as const) {
			const result = transition(draft(), {
				type: "moveRequested",
				target: { status: target, customColumnId: null },
			});

			expect(result.next.column.status, target).toBe("todo");
			expect(result.next.runtime.phase, target).toBe("idle");
			expect(result.effects, target).toHaveLength(1);
			expect(result.effects[0], target).toMatchObject({
				type: "reject",
				message: expect.stringContaining("draft"),
			});
		}

		const launch = transition(draft(), {
			type: "moveRequested",
			target: { status: "in-progress", customColumnId: null },
			runId: "run-1",
			preparation: {
				launch: { label: "variant", agentId: "builtin-claude", configId: "claude-auto" },
				awaitCompletion: false,
				publishColumn: true,
			},
		});
		expect(launch.next.column.status).toBe("todo");
		expect(launch.effects.map((e) => e.type)).toEqual(["reject"]);

		{
			// Still allows a draft to move inside To Do and be deleted, and leaves an ordinary To Do task activatable.
			const toCustomColumn = transition(draft(), {
				type: "moveRequested",
				target: { customColumnId: "col-1" },
			});
			const deleted = transition(draft(), { type: "deleteRequested" });

			expect(toCustomColumn.effects.some((e) => e.type === "reject")).toBe(false);
			expect(deleted.effects.some((e) => e.type === "reject")).toBe(false);

			const ordinary = transition(state("todo"), {
				type: "moveRequested",
				target: { status: "in-progress", customColumnId: null },
				explicitLaunch: true,
			});
			expect(ordinary.next.column.status).toBe("in-progress");
			expect(ordinary.effects.some((e) => e.type === "prepareTask")).toBe(true);
		}
	});
});

describe("hibernation", () => {
	const active = (overrides: Partial<LifecycleState> = {}) => state("user-questions", overrides);
	const frozen = (overrides: Partial<LifecycleState> = {}) => {
		const base = active(overrides);
		return {
			...base,
			runtime: { phase: "idle" } as const,
			facts: { ...base.facts, hibernated: true },
		};
	};

	it("kills the session, keeps the worktree, records the flag, and never reaps on an inactivity timer", () => {
		const result = transition(active(), { type: "hibernateRequested" });

		expect(result.next.facts.hibernated).toBe(true);
		expect(result.next.column.status).toBe("user-questions");
		expect(result.next.runtime).toEqual({ phase: "idle" });
		expect(result.effects.map((e) => e.type)).toEqual([
			"clearTaskRuntime",
			"gracefulAgentExit",
			"destroyTaskPty",
			"killDevServer",
			"reapWorktreeProcesses",
			"releasePorts",
			"persistRuntime",
			"push",
		]);
		// Nothing may remove the worktree or run the cleanup script.
		expect(result.effects.map((e) => e.type)).not.toContain("removeWorktree");
		expect(result.effects.map((e) => e.type)).not.toContain("runCleanupScript");
		// Aborts the freeze if the terminal tree cannot be confirmed gone.
		expect(result.effects.find((e) => e.type === "destroyTaskPty")?.onError).toBe("abort");

		{
			// Never reaps unrelated worktree processes on an inactivity timer.
			const result = transition(active(), {
				type: "hibernateRequested", inactivity: { lastActivityAt: 1, timeoutMinutes: 60 },
			});
			expect(result.next.facts.hibernated).toBe(true);
			expect(result.effects.map(effect => effect.type)).toContain("destroyTaskPty");
			expect(result.effects.map(effect => effect.type)).not.toContain("reapWorktreeProcesses");
		}
	});

	it("refuses a To Do, preparing or tearing-down task", () => {
		const todo = transition(state("todo"), { type: "hibernateRequested" });
		expect(todo.next.facts.hibernated).toBeUndefined();
		expect(todo.effects, "todo").toMatchObject([{ type: "reject" }]);

		const preparing = active({
			runtime: { phase: "preparing", stage: "creating-worktree", runId: "r1", origin: { status: "todo", customColumnId: null } },
		});
		expect(transition(preparing, { type: "hibernateRequested" }).effects, "preparing").toMatchObject([{ type: "reject" }]);

		const tearing = active({ runtime: { phase: "tearing-down", targetStatus: "completed", runId: "r1" } });
		expect(transition(tearing, { type: "hibernateRequested" }).effects, "tearing-down").toMatchObject([{ type: "reject" }]);
	});

	it("refuses every column change while hibernated, an automation's included, but still lets the task be completed", () => {
		const result = transition(frozen(), {
			type: "moveRequested",
			target: { status: "in-progress", customColumnId: null },
		});

		expect(result.next.column.status).toBe("user-questions");
		expect(result.effects).toMatchObject([{ type: "reject" }]);

		const automation = transition(frozen(), {
			type: "moveRequested",
			target: { status: "review-by-colleague" },
			cause: "pr-promotion",
		});
		expect(automation.effects).toMatchObject([{ type: "reject" }]);

		{
			// Still lets a hibernated task be completed.
			const result = transition(frozen(), {
				type: "moveRequested",
				target: { status: "completed", customColumnId: null },
			});

			expect(result.next.column.status).toBe("completed");
			expect(result.next.facts.hibernated).toBe(false);
			expect(result.effects.map((e) => e.type)).toContain("removeWorktree");
		}
	});

	it("clears the flag on wake and leaves the column alone; a repeat freeze or a live wake is a no-op", () => {
		const result = transition(frozen(), { type: "wakeRequested" });

		expect(result.next.facts.hibernated).toBe(false);
		expect(result.next.column.status).toBe("user-questions");
		expect(result.effects).toMatchObject([
			{ type: "persistTaskPatch", taskPatch: { hibernated: false } },
			{ type: "push" },
		]);

		{
			// Treats a repeat freeze and a wake on a live task as no-ops, not errors.
			const refreeze = transition(frozen(), { type: "hibernateRequested" });
			expect(refreeze.effects).toEqual([]);
			expect(refreeze.next.facts.hibernated).toBe(true);

			expect(transition(active(), { type: "wakeRequested" }).effects).toEqual([]);
		}
	});

	it("defers PR promotion while hibernated, keeps watching, and promotes on the first poll after wake", () => {
		const detected: LifecycleEvent = {
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
		};
		const asleep = frozen({ column: { status: "review-by-user", customColumnId: null } });
		const whileAsleep = transition(asleep, detected);
		expect(whileAsleep.effects.map((e) => e.type)).toEqual(["persistPrStatus", "push"]);

		const woken = transition(asleep, { type: "wakeRequested" }).next;
		const afterWake = transition(woken, detected);
		expect(afterWake.effects.find((e) => e.type === "sendEvent")).toMatchObject({
			event: { type: "moveRequested", cause: "pr-promotion", target: { status: "review-by-colleague" } },
		});

		{
			// Keeps merge and PR watching running while hibernated.
			expect(activitiesFor(frozen())).toContain("mergeWatch");
		}
	});
});
