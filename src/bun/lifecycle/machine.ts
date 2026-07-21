import type { TaskStatus } from "../../shared/types";
import type { LifecycleEffect } from "./effects";
import type {
	LifecycleColumn,
	LifecycleEvent,
	LifecycleRuntime,
	LifecycleState,
	MoveGuards,
} from "./events";

const ACTIVE_STATUSES = new Set<TaskStatus>([
	"in-progress",
	"user-questions",
	"review-by-ai",
	"review-by-user",
	"review-by-colleague",
]);
const TERMINAL_STATUSES = new Set<TaskStatus>(["completed", "cancelled"]);
const MERGE_ELIGIBLE_STATUSES = new Set<TaskStatus>([
	"user-questions",
	"review-by-user",
	"review-by-colleague",
]);

export interface TransitionResult {
	next: LifecycleState;
	effects: LifecycleEffect[];
}

function effect<T extends Omit<LifecycleEffect, "onError">>(
	value: T,
	onError: "continue" | "abort" = "continue",
	compensatingEvent?: LifecycleEvent,
): LifecycleEffect {
	return {
		...value,
		onError,
		...(compensatingEvent ? { compensatingEvent } : {}),
	} as LifecycleEffect;
}

function unchanged(state: LifecycleState): TransitionResult {
	return { next: state, effects: [] };
}

function commaList(value: string | undefined): string[] | null {
	if (!value) return null;
	return value.split(",").map((entry) => entry.trim()).filter(Boolean);
}

function guardBlocked(status: TaskStatus, guards: MoveGuards | undefined): boolean {
	const allowed = commaList(guards?.ifStatus);
	if (allowed && !allowed.includes(status)) return true;
	const blocked = commaList(guards?.ifStatusNot);
	return !!blocked?.includes(status);
}

function resolvedTarget(state: LifecycleState, event: Extract<LifecycleEvent, { type: "moveRequested" }>): LifecycleColumn {
	if (event.target.status) {
		return {
			status: event.target.status,
			customColumnId: event.target.customColumnId ?? null,
		};
	}

	const customColumnId = event.target.customColumnId ?? null;
	return {
		status: customColumnId && TERMINAL_STATUSES.has(state.column.status)
			? "in-progress"
			: state.column.status,
		customColumnId,
	};
}

function preparationFailureEffects(
	state: LifecycleState,
	error: string | null,
	includeFailurePush: boolean,
): LifecycleEffect[] {
	const effects: LifecycleEffect[] = [
		effect({ type: "clearTaskRuntime" }),
		effect({ type: "releasePorts" }),
		effect({ type: "destroyTaskPty" }),
		effect({ type: "killDevServer" }),
	];
	if (state.facts.hasWorktree) {
		effects.push(effect({ type: "runCleanupScript", toStatus: "todo" }));
		if (state.facts.projectKind === "git") {
			effects.push(effect({ type: "removeWorktree" }));
		}
	}
	effects.push(
		effect({ type: "persistPreparationFailure", error }, "abort"),
		effect({ type: "push", message: "taskUpdated", view: "current" }),
	);
	if (includeFailurePush) {
		effects.push(effect({
			type: "push",
			message: "taskPreparationFailed",
			payload: { error },
		}));
	}
	return effects;
}

function moveTransition(
	state: LifecycleState,
	event: Extract<LifecycleEvent, { type: "moveRequested" }>,
): TransitionResult {
	if (guardBlocked(state.column.status, event.guards)) return unchanged(state);

	const target = resolvedTarget(state, event);
	const oldStatus = state.column.status;
	const needsActivation = !ACTIVE_STATUSES.has(oldStatus) && ACTIVE_STATUSES.has(target.status);

	if (needsActivation) {
		const runId = event.runId ?? "pending-run";
		const runtime: LifecycleRuntime = {
			phase: "preparing",
			stage: "resolving-config",
			runId,
			origin: state.column,
		};
		const failed: LifecycleEvent = {
			type: "preparationFailed",
			runId,
			error: "Task preparation failed",
		};
		return {
			next: { ...state, column: target, runtime },
			effects: [
				effect({ type: "clearMergeThrottle" }),
				effect({ type: "persistRuntime", runtime }, "abort", failed),
				effect({
					type: "prepareTask",
					runId,
					origin: state.column,
					target,
					isReopen: TERMINAL_STATUSES.has(oldStatus),
				}, "abort", failed),
			],
		};
	}

	if (TERMINAL_STATUSES.has(target.status)) {
		const terminalStatus = target.status as "completed" | "cancelled";
		const runId = event.runId ?? "pending-run";
		const runtime: LifecycleRuntime = {
			phase: "tearing-down",
			targetStatus: terminalStatus,
			runId,
		};
		const effects: LifecycleEffect[] = [
			effect({ type: "clearTaskRuntime" }),
			effect({ type: "releasePorts" }),
			effect({ type: "persistRuntime", runtime }, "abort"),
		];
		if (!event.force && (ACTIVE_STATUSES.has(oldStatus) || state.facts.hasWorktree)) {
			effects.push(
				effect({ type: "push", message: "taskUpdated", view: "shuttingDown" }),
				effect({ type: "destroyTaskPty" }),
				effect({ type: "killDevServer" }),
				effect({ type: "runCleanupScript", toStatus: terminalStatus }),
				effect({ type: "captureCompletedDiffStats" }),
			);
			if (state.facts.projectKind === "git") {
				effects.push(effect({ type: "removeWorktree" }));
			}
		}
		effects.push(
			effect({ type: "persistTerminalTask", status: terminalStatus }, "abort"),
			effect({ type: "push", message: "taskUpdated", view: "current" }),
			effect({ type: "notifyStatusChange", from: oldStatus, to: terminalStatus }),
		);
		if (!event.clientPlayedSound) {
			effects.push(effect({ type: "emitTaskSound", status: terminalStatus }));
		}
		return {
			next: { ...state, column: target, runtime },
			effects,
		};
	}

	const nextRuntime = state.runtime.phase === "idle" && ACTIVE_STATUSES.has(target.status) && state.facts.hasWorktree
		? { phase: "running" } as const
		: state.runtime;
	return {
		next: { ...state, column: target, runtime: nextRuntime },
		effects: [
			effect({ type: "clearMergeThrottle" }),
			effect({ type: "persistColumn", column: target, runtime: nextRuntime }, "abort"),
			effect({ type: "push", message: "taskUpdated", view: "current" }),
			effect({ type: "notifyStatusChange", from: oldStatus, to: target.status }),
			effect({ type: "launchColumnAgent", column: target }),
		],
	};
}

function bootTransition(
	state: LifecycleState,
	event: Extract<LifecycleEvent, { type: "bootObserved" }>,
): TransitionResult {
	const { worktreeExists, tmuxAlive } = event.reality;
	if (state.runtime.phase === "idle") {
		if (ACTIVE_STATUSES.has(state.column.status) && worktreeExists && tmuxAlive) {
			const runtime = { phase: "running" } as const;
			return {
				next: { ...state, runtime, facts: { ...state.facts, hasWorktree: worktreeExists } },
				effects: [effect({ type: "persistRuntime", runtime })],
			};
		}
		return unchanged({ ...state, facts: { ...state.facts, hasWorktree: worktreeExists } });
	}

	if (state.runtime.phase === "running") {
		if (tmuxAlive) return unchanged({ ...state, facts: { ...state.facts, hasWorktree: worktreeExists } });
		const runtime = { phase: "idle" } as const;
		return {
			next: { ...state, runtime, facts: { ...state.facts, hasWorktree: worktreeExists } },
			effects: [effect({ type: "persistRuntime", runtime })],
		};
	}

	if (state.runtime.phase === "preparing") {
		if (tmuxAlive && worktreeExists) {
			const runtime = { phase: "running" } as const;
			return {
				next: { ...state, runtime, facts: { ...state.facts, hasWorktree: true } },
				effects: [effect({ type: "persistRuntime", runtime })],
			};
		}
		const next: LifecycleState = {
			...state,
			column: { status: "todo", customColumnId: null },
			runtime: { phase: "idle" },
			facts: { ...state.facts, hasWorktree: worktreeExists },
		};
		return {
			next,
			effects: preparationFailureEffects(next, "Preparation interrupted by app restart", false),
		};
	}

	const terminalStatus = state.runtime.targetStatus;
	const next: LifecycleState = {
		...state,
		column: { status: terminalStatus, customColumnId: null },
		runtime: { phase: "idle" },
		facts: { ...state.facts, hasWorktree: worktreeExists },
	};
	if (!worktreeExists) {
		return {
			next,
			effects: [
				effect({ type: "persistTerminalTask", status: terminalStatus }, "abort"),
				effect({ type: "push", message: "taskUpdated", view: "current" }),
			],
		};
	}
	return {
		next,
		effects: [
			effect({ type: "destroyTaskPty" }),
			effect({ type: "killDevServer" }),
			effect({ type: "runCleanupScript", toStatus: terminalStatus }),
			effect({ type: "captureCompletedDiffStats" }),
			...(state.facts.projectKind === "git" ? [effect({ type: "removeWorktree" })] : []),
			effect({ type: "persistTerminalTask", status: terminalStatus }, "abort"),
			effect({ type: "push", message: "taskUpdated", view: "current" }),
		],
	};
}

export function transition(state: LifecycleState, event: LifecycleEvent): TransitionResult {
	switch (event.type) {
		case "moveRequested":
			return moveTransition(state, event);
		case "preparationRequested": {
			if (state.runtime.phase === "preparing" && state.runtime.runId !== event.runId) {
				return unchanged(state);
			}
			const runtime: LifecycleRuntime = {
				phase: "preparing",
				stage: "resolving-config",
				runId: event.runId,
				origin: event.origin ?? { status: "todo", customColumnId: null },
			};
			return {
				next: { ...state, runtime },
				effects: [
					effect({ type: "persistRuntime", runtime }, "abort", {
						type: "preparationFailed",
						runId: event.runId,
						error: "Task preparation failed",
					}),
					effect({
						type: "prepareTask",
						runId: event.runId,
						origin: runtime.origin,
						target: state.column,
						isReopen: false,
					}, "abort", {
						type: "preparationFailed",
						runId: event.runId,
						error: "Task preparation failed",
					}),
			],
			};
		}
		case "preparationStageChanged": {
			if (state.runtime.phase !== "preparing" || state.runtime.runId !== event.runId) return unchanged(state);
			const runtime = { ...state.runtime, stage: event.stage };
			return {
				next: { ...state, runtime },
				effects: [
					effect({ type: "persistPreparationStage", stage: event.stage, runId: event.runId }, "abort"),
					effect({ type: "push", message: "taskUpdated", view: "current" }),
			],
			};
		}
		case "preparationSucceeded": {
			if (state.runtime.phase !== "preparing" || state.runtime.runId !== event.runId) return unchanged(state);
			const runtime = { phase: "running" } as const;
			return {
				next: {
					...state,
					runtime,
					facts: { ...state.facts, hasWorktree: true },
				},
				effects: [
					effect({
						type: "persistColumn",
						column: state.column,
						runtime,
						worktreePath: event.worktreePath,
						branchName: event.branchName,
					}, "abort"),
					effect({ type: "push", message: "taskUpdated", view: "current" }),
					effect({ type: "launchColumnAgent", column: state.column }),
			],
			};
		}
		case "preparationFailed": {
			if (state.runtime.phase !== "preparing" || state.runtime.runId !== event.runId) return unchanged(state);
			return {
				next: {
					...state,
					column: { status: "todo", customColumnId: null },
					runtime: { phase: "idle" },
				},
				effects: preparationFailureEffects(state, event.error, true),
			};
		}
		case "preparationCancelled": {
			if (state.runtime.phase !== "preparing" || state.runtime.runId !== event.runId) return unchanged(state);
			return {
				next: {
					...state,
					column: { status: "todo", customColumnId: null },
					runtime: { phase: "idle" },
				},
				effects: preparationFailureEffects(state, null, false),
			};
		}
		case "mergeDetected":
			if (!MERGE_ELIGIBLE_STATUSES.has(state.column.status) || !state.facts.hasWorktree) return unchanged(state);
			return {
				next: state,
				effects: [
					effect({ type: "persistMergePrompt", fingerprint: event.fingerprint, precise: event.precise }, "abort"),
					effect({ type: "push", message: "branchMerged", payload: event }),
			],
			};
		case "prDetected": {
			const effects: LifecycleEffect[] = [
				effect({ type: "persistPrStatus", payload: event.payload }),
				effect({ type: "push", message: "taskPrStatus", payload: event.payload }),
			];
			if (event.signalReason) effects.push(effect({ type: "raisePrAttention", reason: event.signalReason }));
			if (state.column.status === "review-by-user" && event.openNonDraft) {
				const column = { status: "review-by-colleague", customColumnId: null } as const;
				effects.push(
					effect({ type: "persistColumn", column, runtime: state.runtime }, "abort"),
					effect({ type: "push", message: "taskUpdated", view: "current" }),
				);
				return { next: { ...state, column }, effects };
			}
			return { next: state, effects };
		}
		case "columnAgentFailed":
			if (state.column.status === "review-by-ai") {
				const column = { status: "review-by-user", customColumnId: null } as const;
				return {
					next: { ...state, column },
					effects: [
						effect({ type: "persistColumn", column, runtime: state.runtime }, "abort"),
						effect({ type: "push", message: "taskUpdated", view: "current" }),
					],
				};
			}
			return {
				next: state,
				effects: [effect({ type: "push", message: "columnAgentFailed", payload: event })],
			};
		case "bootObserved":
			return bootTransition(state, event);
	}
}

export type LifecycleActivity = "mergeWatch" | "prWatch";

export function activitiesFor(state: LifecycleState): LifecycleActivity[] {
	if (!state.facts.hasWorktree || state.facts.projectKind === "virtual") return [];
	const activities: LifecycleActivity[] = [];
	if (MERGE_ELIGIBLE_STATUSES.has(state.column.status)) activities.push("mergeWatch");
	if (
		!TERMINAL_STATUSES.has(state.column.status)
		&& (state.facts.hasPrIdentity
			|| (state.facts.peerReviewEnabled && (state.column.status === "review-by-user" || state.column.status === "review-by-colleague")))
	) {
		activities.push("prWatch");
	}
	return activities;
}
