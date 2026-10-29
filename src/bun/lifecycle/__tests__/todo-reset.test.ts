import { describe, expect, it } from "vitest";
import {
	LAUNCH_REQUIRES_EXPLICIT_START_ERROR,
	RESET_BUSY_ERROR,
	RESET_CONSENT_STALE_ERROR,
	RESET_REQUIRES_CONSENT_ERROR,
	type TaskResetConsent,
	type TaskStatus,
} from "../../../shared/types";
import type { LifecycleEvent, LifecycleState } from "../events";
import { transition } from "../machine";

const PATH = "/wt/c1c1c1c1/worktree";
const STARTED = "2026-09-25T10:00:00.000Z";
const CONSENT = { worktreePath: PATH, lifecycleStartedAt: STARTED };

function state(status: TaskStatus, overrides: Partial<LifecycleState["facts"]> = {}, runtime?: LifecycleState["runtime"]): LifecycleState {
	const clean = status === "todo" || status === "completed" || status === "cancelled";
	return {
		column: { status, customColumnId: null },
		runtime: runtime ?? { phase: clean ? "idle" : "running" },
		facts: {
			hasWorktree: !clean,
			worktreePath: clean ? null : PATH,
			lifecycleStartedAt: clean ? null : STARTED,
			usesWorktrees: true,
			hasPrIdentity: false,
			peerReviewEnabled: true,
			...overrides,
		},
	};
}

const types = (effects: { type: string }[]) => effects.map((effect) => effect.type);
const rejection = (effects: { type: string; message?: string }[]) => effects.find((e) => e.type === "reject")?.message;
const reset = (consent: TaskResetConsent = CONSENT): LifecycleEvent => ({ type: "resetRequested", consent });

describe("plain moves to To Do never destroy a run (T1, T2, T17c)", () => {
	for (const status of ["in-progress", "user-questions", "review-by-user", "review-by-ai", "review-by-colleague"] as const) {
		it(`${status} → todo is refused, with and without force`, () => {
			for (const force of [false, true]) {
				const result = transition(state(status), { type: "moveRequested", target: { status: "todo" }, force });
				expect(rejection(result.effects)).toBe(RESET_REQUIRES_CONSENT_ERROR);
				expect(types(result.effects)).not.toContain("destroyTaskPty");
			}
		});
	}

	it("a hibernated active task gets the reset refusal, not a silent move", () => {
		const result = transition(state("review-by-user", { hibernated: true }), { type: "moveRequested", target: { status: "todo" } });
		expect(rejection(result.effects)).toBe(RESET_REQUIRES_CONSENT_ERROR);
	});

	it("completed/cancelled → todo stays a plain, non-destructive move", () => {
		for (const status of ["completed", "cancelled"] as const) {
			const result = transition(state(status), { type: "moveRequested", target: { status: "todo" } });
			expect(rejection(result.effects)).toBeUndefined();
			expect(types(result.effects)).toContain("persistColumn");
			expect(types(result.effects)).not.toContain("removeWorktree");
			expect(types(result.effects)).not.toContain("resetWorktree");
		}
	});

	it("todo → todo is a no-op", () => {
		expect(transition(state("todo"), { type: "moveRequested", target: { status: "todo" } }).effects).toEqual([]);
	});
});

describe("a To Do task starts only from an explicit launch (B1, T3)", () => {
	it("refuses a bare move — what every hook sends", () => {
		const result = transition(state("todo"), { type: "moveRequested", target: { status: "in-progress" }, guards: { ifStatusNot: "review-by-ai" } });
		expect(rejection(result.effects)).toBe(LAUNCH_REQUIRES_EXPLICIT_START_ERROR);
		expect(types(result.effects)).not.toContain("prepareTask");
	});

	it("refuses a bare move into user-questions too (Claude StopFailure, PermissionRequest)", () => {
		const result = transition(state("todo"), { type: "moveRequested", target: { status: "user-questions" }, force: true });
		expect(rejection(result.effects)).toBe(LAUNCH_REQUIRES_EXPLICIT_START_ERROR);
	});

	it("starts with a launch pipeline (preparation) or an explicit out-of-task start", () => {
		const viaPreparation = transition(state("todo"), {
			type: "moveRequested",
			target: { status: "in-progress" },
			preparation: { launch: { label: "x", agentId: null, configId: null }, awaitCompletion: true, publishColumn: false },
		});
		const viaExplicit = transition(state("todo"), { type: "moveRequested", target: { status: "in-progress" }, explicitLaunch: true });
		expect(types(viaPreparation.effects)).toContain("prepareTask");
		expect(types(viaExplicit.effects)).toContain("prepareTask");
	});

	it("reopening a completed task keeps today's behaviour", () => {
		const result = transition(state("completed"), { type: "moveRequested", target: { status: "in-progress" } });
		expect(types(result.effects)).toContain("prepareTask");
	});
});

describe("resetRequested (T8–T10)", () => {
	it("runs the cancellation teardown in its order, then ONE final write, and lands in To Do", () => {
		const result = transition(state("in-progress"), reset());
		expect(types(result.effects)).toEqual([
			"clearTaskRuntime",
			"releasePorts",
			"push",
			"gracefulAgentExit",
			"destroyTaskPty",
			"killDevServer",
			"runCleanupScript",
			"dumpTaskConversations",
			"reapWorktreeProcesses",
			"resetWorktree",
			"persistResetTask",
			"push",
			"notifyStatusChange",
		]);
		const abortPoints = result.effects.filter((e) => e.onError === "abort").map((e) => e.type);
		expect(abortPoints).toEqual(["destroyTaskPty", "resetWorktree", "persistResetTask"]);
		for (const type of abortPoints) {
			expect(result.effects.find((e) => e.type === type)?.compensatingEvent?.type).toBe("resetFailed");
		}
		// Nothing but the final write touches the status: no persisted marker (Option B).
		expect(types(result.effects)).not.toContain("persistRuntime");
		expect(types(result.effects)).not.toContain("persistColumn");
		expect(result.next.column).toEqual({ status: "todo", customColumnId: null });
	});

	it("resets a legacy To Do card that still owns a worktree", () => {
		const legacy = state("todo", { hasWorktree: true, worktreePath: PATH, lifecycleStartedAt: STARTED });
		expect(types(transition(legacy, reset()).effects)).toContain("resetWorktree");
	});

	it("keeps a virtual (Operations) folder: no worktree removal", () => {
		const result = transition(state("in-progress", { usesWorktrees: false }), reset());
		expect(types(result.effects)).not.toContain("resetWorktree");
		expect(types(result.effects)).toContain("persistResetTask");
	});

	it("refuses a consent from an earlier run at the same path (T9)", () => {
		const relaunched = state("in-progress", { lifecycleStartedAt: "2026-09-25T12:00:00.000Z" });
		const result = transition(relaunched, reset());
		expect(rejection(result.effects)).toBe(RESET_CONSENT_STALE_ERROR);
		expect(types(result.effects)).not.toContain("destroyTaskPty");
	});

	it("refuses present → absent and a different path", () => {
		expect(rejection(transition(state("user-questions", { lifecycleStartedAt: null }), reset()).effects)).toBe(RESET_CONSENT_STALE_ERROR);
		expect(rejection(transition(state("in-progress", { worktreePath: "/elsewhere" }), reset()).effects)).toBe(RESET_CONSENT_STALE_ERROR);
	});

	it("accepts after the agent moved the card between active columns (T10)", () => {
		for (const status of ["user-questions", "review-by-user", "review-by-ai"] as const) {
			expect(rejection(transition(state(status), reset()).effects)).toBeUndefined();
		}
	});

	it("absent anchor on both sides binds to the worktree path alone", () => {
		const unstamped = state("user-questions", { lifecycleStartedAt: null });
		expect(rejection(transition(unstamped, reset({ worktreePath: PATH, lifecycleStartedAt: null })).effects)).toBeUndefined();
	});

	it("refuses when there is nothing to reset, or while preparing / tearing down", () => {
		expect(rejection(transition(state("todo"), reset({ worktreePath: null, lifecycleStartedAt: null })).effects)).toBe(RESET_CONSENT_STALE_ERROR);
		expect(rejection(transition(state("completed"), reset({ worktreePath: null, lifecycleStartedAt: null })).effects)).toBe(RESET_CONSENT_STALE_ERROR);
		const preparing = state("in-progress", {}, { phase: "preparing", stage: "creating-worktree", runId: "r", origin: { status: "todo", customColumnId: null } });
		expect(rejection(transition(preparing, reset()).effects)).toBe(RESET_BUSY_ERROR);
		const tearingDown = state("in-progress", {}, { phase: "tearing-down", targetStatus: "cancelled", runId: "r" });
		expect(rejection(transition(tearingDown, reset()).effects)).toBe(RESET_BUSY_ERROR);
	});

	it("resetFailed restores the live view and reports the error", () => {
		const result = transition(state("in-progress"), { type: "resetFailed", error: "Task reset stopped: boom" });
		expect(types(result.effects)).toEqual(["push", "reject"]);
		expect(rejection(result.effects)).toBe("Task reset stopped: boom");
	});
});

// C1 (Seq 2003 review 2003-011): a preparation that failed because createWorktree
// REFUSED to reclaim a leftover holding work must not clean that leftover up.
describe("preparationFailed after a reclaim refusal keeps the workspace", () => {
	const preparing = state("in-progress", { hasWorktree: false, worktreePath: null }, {
		phase: "preparing", stage: "creating-worktree", runId: "r1", origin: { status: "todo", customColumnId: null },
	});

	it("runs no cleanup script, no reaper and no removeWorktree", () => {
		const result = transition(preparing, { type: "preparationFailed", runId: "r1", error: "refused", preserveWorkspace: true });
		expect(types(result.effects)).not.toContain("removeWorktree");
		expect(types(result.effects)).not.toContain("runCleanupScript");
		expect(types(result.effects)).not.toContain("reapWorktreeProcesses");
		expect(types(result.effects)).toContain("persistPreparationFailure");
		expect(result.next.column.status).toBe("todo");
	});

	it("an ordinary preparation failure still cleans up as before", () => {
		const result = transition(preparing, { type: "preparationFailed", runId: "r1", error: "boom" });
		expect(types(result.effects)).toContain("removeWorktree");
	});
});
