import {
	ACTIVE_STATUSES as ACTIVE_TASK_STATUSES,
	getAllowedTransitions,
	isStatusGuardBlocked,
	MERGE_COMPLETE_ELIGIBLE_STATUSES,
	type TaskStatus,
} from "../../shared/types";
import {
	MERGE_PROMPT_RETRY_SUPPRESS_MS,
	shouldSuppressMergePrompt,
} from "./merge-prompt";
import type { LifecycleEffect } from "./effects";
import type {
	LifecycleColumn,
	LifecycleEvent,
	LifecycleRuntime,
	LifecycleState,
} from "./events";

const ACTIVE_STATUSES = new Set<TaskStatus>(ACTIVE_TASK_STATUSES);
const TERMINAL_STATUSES = new Set<TaskStatus>(["completed", "cancelled"]);
const MERGE_ELIGIBLE_STATUSES = new Set<TaskStatus>(MERGE_COMPLETE_ELIGIBLE_STATUSES);

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

function resolvedTarget(state: LifecycleState, event: Extract<LifecycleEvent, { type: "moveRequested" }>): LifecycleColumn {
	if (event.target.status) {
		return {
			status: event.target.status,
			customColumnId: event.target.customColumnId === undefined
				? state.column.customColumnId
				: event.target.customColumnId,
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
		effect({ type: "cancelPreparationProcesses" }),
		effect({ type: "clearTaskRuntime" }),
		effect({ type: "releasePorts" }),
		effect({ type: "destroyTaskPty" }),
		effect({ type: "killDevServer" }),
	];
	if (state.facts.projectKind === "git" && (state.facts.hasWorktree || state.runtime.phase === "preparing")) {
		effects.push(effect({ type: "runCleanupScript", toStatus: "todo", allowDerivedPath: true }));
		effects.push(effect({ type: "removeWorktree", allowDerivedPath: true }));
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

function mergeReservationBlocked(
	state: LifecycleState,
	fingerprint: string,
	observedAt: string,
	force = false,
): boolean {
	if (force) return false;
	const observedAtMs = Date.parse(observedAt);
	const reservation = state.facts.mergePromptReservation;
	if (
		reservation?.fingerprint === fingerprint
		&& Number.isFinite(observedAtMs)
		&& observedAtMs - reservation.reservedAt <= MERGE_PROMPT_RETRY_SUPPRESS_MS
	) {
		return true;
	}
	return false;
}

function mergePromptBlocked(
	state: LifecycleState,
	fingerprint: string,
	precise: boolean,
	observedAt: string,
	force = false,
): boolean {
	if (force) return false;
	if (mergeReservationBlocked(state, fingerprint, observedAt, force)) return true;
	const observedAtMs = Date.parse(observedAt);
	return shouldSuppressMergePrompt(
		state.facts.mergeCompletionPrompt,
		{ fingerprint, precise },
		observedAtMs,
	);
}

function moveTransition(
	state: LifecycleState,
	event: Extract<LifecycleEvent, { type: "moveRequested" }>,
): TransitionResult {
	if (isStatusGuardBlocked(state.column.status, event.guards)) return unchanged(state);

	const target = resolvedTarget(state, event);
	if (
		target.status === state.column.status
		&& target.customColumnId === state.column.customColumnId
	) {
		if (event.preparation) return unchanged(state);
		if (!event.taskPatch) return unchanged(state);
		return {
			next: state,
			effects: [
				effect({ type: "persistTaskPatch", taskPatch: event.taskPatch }, "abort"),
			],
		};
	}
	if (
		event.enforceAllowedTransition
		&& event.target.status !== undefined
		&& state.column.customColumnId === null
		&& !getAllowedTransitions(state.column.status).includes(target.status)
	) {
		return {
			next: state,
			effects: [effect({
				type: "reject",
				message: `Cannot move task from "${state.column.status}" to "${target.status}". Allowed: ${getAllowedTransitions(state.column.status).join(", ")}`,
			}, "abort")],
		};
	}
	const oldStatus = state.column.status;
	if (event.cause) {
		const runtime = event.cause === "column-agent-fallback" ? state.runtime : undefined;
		return {
			next: { ...state, column: target },
			effects: [
				effect({
					type: "persistColumn",
					column: target,
					patch: event.cause === "pr-promotion" ? "statusOnly" : "status",
					...(event.cause === "column-agent-fallback" ? { guards: event.guards } : {}),
					...(event.cause === "pr-promotion" ? { writeOptions: "none" as const } : {}),
					...(runtime ? { runtime } : {}),
				}, "abort"),
				...(event.cause === "pr-promotion"
					? [effect({ type: "setPrPromoted", promoted: true })]
					: []),
				effect({ type: "push", message: "taskUpdated", view: "current" }),
			],
		};
	}
	const needsActivation = !ACTIVE_STATUSES.has(oldStatus) && ACTIVE_STATUSES.has(target.status);

	if (needsActivation) {
		const runId = event.runId ?? "pending-run";
		const columnReserved = event.preparation?.publishColumn === true;
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
			origin: state.column,
			target,
		};
		return {
			next: { ...state, column: target, runtime },
			effects: [
				effect({
					type: "persistRuntime",
					runtime,
					column: target,
					expectedColumn: state.column,
					taskPatch: event.taskPatch,
				}, "abort", failed),
				effect({ type: "clearMergeThrottle" }),
				...(columnReserved ? [
					effect({ type: "push", message: "taskUpdated", view: "current" }),
					effect({ type: "notifyStatusChange", from: oldStatus, to: target.status }),
				] : []),
				effect({
					type: "prepareTask",
					runId,
					origin: state.column,
					target,
					isReopen: TERMINAL_STATUSES.has(oldStatus),
					awaitCompletion: event.preparation?.awaitCompletion ?? true,
					columnReserved,
					successPatch: "activation",
					launch: event.preparation?.launch,
				}, "abort", failed),
			],
		};
	}

	if (event.target.status !== undefined && TERMINAL_STATUSES.has(target.status)) {
		const terminalStatus = target.status as "completed" | "cancelled";
		const runId = event.runId ?? "pending-run";
		const runtime: LifecycleRuntime = {
			phase: "tearing-down",
			targetStatus: terminalStatus,
			runId,
		};
		const effects: LifecycleEffect[] = [
			effect({ type: "clearTaskRuntime" }),
			...(state.runtime.phase === "preparing"
				? [effect({ type: "cancelPreparationProcesses" })]
				: []),
			effect({ type: "releasePorts" }),
			effect({ type: "persistRuntime", runtime }, "abort"),
		];
		if (!event.force && (ACTIVE_STATUSES.has(oldStatus) || state.facts.hasWorktree)) {
			const allowDerivedPath = state.runtime.phase === "preparing";
			effects.push(
				effect({ type: "push", message: "taskUpdated", view: "shuttingDown" }),
				effect({ type: "destroyTaskPty" }),
				effect({ type: "killDevServer" }),
				effect({ type: "runCleanupScript", toStatus: terminalStatus, allowDerivedPath }),
				effect({ type: "captureCompletedDiffStats", allowDerivedPath }),
			);
			if (state.facts.projectKind === "git") {
				effects.push(effect({ type: "removeWorktree", allowDerivedPath }));
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
	const launchAgentNow = state.runtime.phase !== "preparing" && event.launchColumnAgent !== false;
	return {
		next: { ...state, column: target, runtime: nextRuntime },
		effects: [
			...(event.taskPatch
				? [effect({ type: "persistTaskPatch", taskPatch: event.taskPatch }, "abort")]
				: []),
			effect({
				type: "persistColumn",
				column: target,
				patch: event.target.status
					? (event.target.customColumnId === undefined ? "statusOnly" : "status")
					: "custom",
				guards: event.guards,
				runtime: nextRuntime,
			}, "abort"),
			effect({ type: "clearMergeThrottle" }),
			effect({ type: "push", message: "taskUpdated", view: "current" }),
			effect({ type: "notifyStatusChange", from: oldStatus, to: target.status }),
			...(launchAgentNow ? [effect({ type: "launchColumnAgent", column: target })] : []),
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
			const taskPatch = event.reality.worktreePath
				? {
					worktreePath: event.reality.worktreePath,
					branchName: event.reality.branchName ?? null,
				}
				: undefined;
			return {
				next: { ...state, runtime, facts: { ...state.facts, hasWorktree: true } },
				effects: [effect({ type: "persistRuntime", runtime, taskPatch })],
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
			effect({ type: "runCleanupScript", toStatus: terminalStatus, allowDerivedPath: true }),
			effect({ type: "captureCompletedDiffStats", allowDerivedPath: true }),
			...(state.facts.projectKind === "git"
				? [effect({ type: "removeWorktree", allowDerivedPath: true })]
				: []),
			effect({ type: "persistTerminalTask", status: terminalStatus }, "abort"),
			effect({ type: "push", message: "taskUpdated", view: "current" }),
		],
	};
}

export function transition(state: LifecycleState, event: LifecycleEvent): TransitionResult {
	switch (event.type) {
		case "moveRequested":
			return moveTransition(state, event);
		case "deleteRequested": {
			const effects: LifecycleEffect[] = [
				effect({ type: "clearTaskRuntime" }),
				...(state.runtime.phase === "preparing"
					? [effect({ type: "cancelPreparationProcesses" })]
					: []),
				effect({ type: "releasePorts" }),
				effect({ type: "destroyTaskPty" }),
			];
			if (ACTIVE_STATUSES.has(state.column.status) || state.facts.hasWorktree) {
				effects.push(
					effect({ type: "killDevServer" }),
					effect({
						type: "runCleanupScript",
						toStatus: "deleted",
						allowDerivedPath: state.runtime.phase === "preparing",
					}),
					effect({
						type: "removeTaskWorkspace",
						allowDerivedPath: state.runtime.phase === "preparing",
					}),
				);
			}
			effects.push(effect({ type: "deleteTaskRecord" }, "abort"));
			return { next: state, effects };
		}
		case "preparationStageChanged": {
			if (state.runtime.phase !== "preparing" || state.runtime.runId !== event.runId) return unchanged(state);
			const runtime = { ...state.runtime, stage: event.stage };
			return {
				next: { ...state, runtime },
				effects: [
					effect({ type: "persistPreparationStage", stage: event.stage, runId: event.runId }, "abort", {
						type: "preparationFailed",
						runId: event.runId,
						error: "Failed to persist preparation stage",
						origin: state.runtime.origin,
						target: state.column,
					}),
					effect({ type: "push", message: "taskUpdated", view: "current" }),
				],
			};
		}
		case "preparationSucceeded": {
			const currentRunMatches = state.runtime.phase === "preparing" && state.runtime.runId === event.runId;
			if (!currentRunMatches) return unchanged(state);
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
						patch: event.mode,
						runtime,
						worktreePath: event.worktreePath,
						branchName: event.branchName,
					}, "abort", {
						type: "preparationFailed",
						runId: event.runId,
						error: "Failed to persist prepared task",
						origin: event.origin,
						target: event.target,
					}),
					effect({ type: "push", message: "taskUpdated", view: "current" }),
					...(!event.columnReserved
						? [effect({ type: "notifyStatusChange", from: event.origin.status, to: state.column.status })]
						: []),
					effect({ type: "launchColumnAgent", column: state.column }),
				],
			};
		}
		case "preparationFailed": {
			const runMatches = state.runtime.phase === "preparing" && state.runtime.runId === event.runId;
			const compensationMatches = event.compensating === true && event.origin !== undefined && (
				(state.column.status === event.origin.status
					&& state.column.customColumnId === event.origin.customColumnId)
				|| (event.target !== undefined
					&& state.column.status === event.target.status
					&& state.column.customColumnId === event.target.customColumnId)
			);
			if (!runMatches && !compensationMatches) return unchanged(state);
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
			const effects = preparationFailureEffects(state, null, false);
			return {
				next: {
					...state,
					column: { status: "todo", customColumnId: null },
					runtime: { phase: "idle" },
				},
				effects,
			};
		}
		case "mergeDetected": {
			if (!MERGE_ELIGIBLE_STATUSES.has(state.column.status) || !state.facts.hasWorktree) return unchanged(state);
			const manualCompletion = state.facts.manualCompletion === true;
			const noticeOnly = manualCompletion || !event.suggestCompletion;
			const blocked = noticeOnly
				? mergeReservationBlocked(state, event.fingerprint, event.detectedAt)
				: mergePromptBlocked(state, event.fingerprint, event.precise, event.detectedAt);
			if (blocked) return unchanged(state);
			const reservation = {
				fingerprint: event.fingerprint,
				reservedAt: Date.parse(event.detectedAt),
			};
			return {
				next: {
					...state,
					facts: {
						...state.facts,
						...(!noticeOnly ? {
							mergeCompletionPrompt: {
								fingerprint: event.fingerprint,
								promptedAt: event.detectedAt,
								dismissedAt: null,
								precise: event.precise,
							},
						} : {}),
						mergePromptReservation: reservation,
					},
				},
				effects: [
					...(!noticeOnly ? [effect({
						type: "persistMergePrompt",
						fingerprint: event.fingerprint,
						precise: event.precise,
						promptedAt: event.detectedAt,
					}, "abort")] : []),
					effect({
						type: "reserveMergePrompt",
						fingerprint: event.fingerprint,
						reservedAt: Date.parse(event.detectedAt),
					}),
					effect({
						type: "push",
						message: "branchMerged",
						payload: { finding: event, noticeOnly, shouldNotify: noticeOnly && !manualCompletion },
					}),
				],
			};
		}
		case "mergePromptPrepared": {
			const noticeOnly = state.facts.manualCompletion === true || !event.suggestCompletion;
			const blocked = noticeOnly
				? mergeReservationBlocked(state, event.fingerprint, event.promptedAt, event.force)
				: mergePromptBlocked(state, event.fingerprint, event.precise, event.promptedAt, event.force);
			if (blocked) {
				return unchanged(state);
			}
			return {
				next: {
					...state,
					facts: {
						...state.facts,
						...(!noticeOnly ? {
							mergeCompletionPrompt: {
								fingerprint: event.fingerprint,
								promptedAt: event.promptedAt,
								dismissedAt: null,
								precise: event.precise,
							},
						} : {}),
						mergePromptReservation: {
							fingerprint: event.fingerprint,
							reservedAt: Date.parse(event.promptedAt),
						},
					},
				},
				effects: [
					...(!noticeOnly ? [effect({
						type: "persistMergePrompt",
						fingerprint: event.fingerprint,
						precise: event.precise,
						promptedAt: event.promptedAt,
					}, "abort")] : []),
					effect({
						type: "reserveMergePrompt",
						fingerprint: event.fingerprint,
						reservedAt: Date.parse(event.promptedAt),
					}),
				],
			};
		}
		case "mergePromptDismissed":
			return {
				next: state,
				effects: [
					effect({
						type: "persistMergeDismissal",
						fingerprint: event.fingerprint,
						precise: event.precise,
						dismissedAt: event.dismissedAt,
					}, "abort"),
					effect({ type: "push", message: "mergePromptResolved", payload: event }),
				],
			};
		case "prIdentityDiscovered":
			return {
				next: { ...state, facts: { ...state.facts, hasPrIdentity: true } },
				effects: [
					effect({
						type: "persistPrStatus",
						payload: { prNumber: event.prNumber, prUrl: event.prUrl },
					}, "abort"),
					effect({ type: "push", message: "taskUpdated", view: "current" }),
				],
			};
		case "prDetected": {
			if (!activitiesFor(state).includes("prWatch")) return unchanged(state);
			const nextFacts = { ...state.facts };
			const effects: LifecycleEffect[] = [
				effect({ type: "persistPrStatus", payload: event.persistence }),
				effect({ type: "push", message: "taskPrStatus", payload: event.payload }),
			];
			if (event.signalKey !== undefined && event.signalKey !== state.facts.prSignalKey) {
				effects.push(effect({ type: "setPrSignalKey", signalKey: event.signalKey }));
				if (event.signalKey) nextFacts.prSignalKey = event.signalKey;
				else delete nextFacts.prSignalKey;
				if (event.signalKey && event.signalReason) {
					effects.push(effect({ type: "raisePrAttention", reason: event.signalReason }));
				}
			}
			if (state.column.status === "review-by-user" && event.openNonDraft && !state.facts.prPromoted) {
				effects.push(effect({
					type: "sendEvent",
					event: {
						type: "moveRequested",
						target: { status: "review-by-colleague" },
						cause: "pr-promotion",
						guards: { ifStatus: "review-by-user" },
					},
				}));
			}
			return { next: { ...state, facts: nextFacts }, effects };
		}
		case "columnAgentFailed":
			if (state.column.status === "review-by-ai" && state.column.customColumnId === null) {
				return {
					next: state,
					effects: [
						effect({
							type: "sendEvent",
							event: {
								type: "moveRequested",
								target: { status: "review-by-user", customColumnId: null },
								cause: "column-agent-fallback",
								guards: { ifStatus: "review-by-ai" },
							},
						}),
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
