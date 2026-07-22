import type { BranchStatus, CustomColumn, Project, Task, TaskStatus } from "../../shared/types";
import * as data from "../data";
import { forgetTaskPreparation, markTaskPreparationCancelled } from "../preparation-runtime";
import { log } from "../rpc-handlers/shared";
import { TaskActorRegistry } from "./actor";
import {
	executeLifecycleEffect,
	launchLifecycleColumnAgent,
	lifecycleDropPosition,
	type LifecycleExecutionContext,
} from "./executor";
import type { LifecycleEffect } from "./effects";
import type { LifecycleEvent } from "./events";
import { activitiesFor, transition, type LifecycleActivity } from "./machine";
import { lifecycleStateFromTask } from "./state";

type LifecycleEnvelope = {
	projectId: string;
	event: LifecycleEvent;
	generation: number;
	snapshot?: { project: Project; task: Task };
	snapshotMode?: "primary" | "fallback" | "activity";
};

export interface LifecycleActorRuntime {
	removed?: boolean;
	mergePromptReservation?: { fingerprint: string; reservedAt: number };
	mergeNextDue?: number;
	prNextDue?: number;
	prPending?: boolean;
	prPromoted?: boolean;
	prSignalKey?: string;
	gitOpPaneId?: string;
	branchChecks?: Map<string, Promise<BranchStatus>>;
	activeActivities?: Set<LifecycleActivity>;
}

function errorEvent(effect: LifecycleEffect, error: unknown): LifecycleEvent | null {
	if (!effect.compensatingEvent) return null;
	if (effect.compensatingEvent.type === "preparationFailed") {
		return {
			...effect.compensatingEvent,
			error: error instanceof Error ? error.message : String(error),
			compensating: true,
		};
	}
	if (effect.compensatingEvent.type === "teardownFailed") {
		return {
			...effect.compensatingEvent,
			error: error instanceof Error ? error.message : String(error),
		};
	}
	return effect.compensatingEvent;
}

class LifecycleService {
	private generation = 0;
	private readonly detachedWork = new Set<Promise<unknown>>();

	private readonly actors = new TaskActorRegistry<LifecycleEnvelope, Task, LifecycleActorRuntime>(
		(taskId, envelope) => this.processEvent(
			envelope.projectId,
			taskId,
			envelope.event,
			envelope.snapshot,
			envelope.snapshotMode,
			envelope.generation,
		),
		() => ({}),
	);

	dispatch(
		projectId: string,
		taskId: string,
		event: LifecycleEvent,
		snapshot?: { project: Project; task: Task },
		snapshotMode: "primary" | "fallback" | "activity" = "primary",
		generation = this.generation,
	): Promise<Task> {
		if (generation !== this.generation && snapshot) return Promise.resolve(snapshot.task);
		const normalized = event.type === "moveRequested" && !event.runId
			? { ...event, runId: crypto.randomUUID() }
			: event;
		return this.actors.dispatch(taskId, {
			projectId,
			event: normalized,
			generation,
			snapshot,
			snapshotMode,
		});
	}

	delete(taskId: string): void {
		const runtime = this.actors.peekRuntime(taskId);
		if (runtime) runtime.removed = true;
		this.actors.delete(taskId);
	}

	async resetForTests(): Promise<void> {
		this.generation += 1;
		const taskIds: string[] = [];
		this.actors.forEachRuntime((runtime, taskId) => {
			runtime.removed = true;
			taskIds.push(taskId);
			markTaskPreparationCancelled(taskId);
		});
		this.actors.clear();
		await Promise.allSettled([...this.detachedWork]);
		for (const taskId of taskIds) forgetTaskPreparation(taskId);
	}

	runtime(taskId: string): LifecycleActorRuntime {
		return this.actors.runtime(taskId);
	}

	forEachRuntime(visitor: (runtime: LifecycleActorRuntime, taskId: string) => void): void {
		this.actors.forEachRuntime(visitor);
	}

	private async processEvent(
		projectId: string,
		taskId: string,
		event: LifecycleEvent,
		snapshot?: { project: Project; task: Task },
		snapshotMode: "primary" | "fallback" | "activity" = "primary",
		generation = this.generation,
	): Promise<Task> {
		if (generation !== this.generation && snapshot) return snapshot.task;
		let project: Project | undefined;
		if (snapshotMode === "activity") {
			project = snapshot?.project;
		} else {
			try {
				project ??= await data.getProject(projectId);
			} catch (error) {
				if (!snapshot || snapshotMode !== "fallback") throw error;
			}
		}
		project ??= snapshot?.project;
		if (!project) throw new Error(`Project not found: ${projectId}`);
		let task: Task | undefined;
		if (snapshotMode === "activity") {
			task = (await data.loadTasks(project)).find((candidate) => candidate.id === taskId);
			// Poller work may finish after deletion. Treat absence from the fresh
			// task list as a rejected finding; never revive it from the old snapshot.
			if (!task) {
				if (snapshot) return snapshot.task;
				throw new Error(`Task not found: ${taskId}`);
			}
		} else {
			try {
				task = await data.getTask(project, taskId);
			} catch (error) {
				if (!snapshot || snapshotMode !== "fallback") throw error;
			}
		}
		task ??= snapshot?.task;
		if (!task) throw new Error(`Task not found: ${taskId}`);
		if (task.id !== taskId) {
			if (!snapshot || snapshotMode !== "fallback") {
				throw new Error(`Task lookup returned ${task.id} for ${taskId}`);
			}
			// A mismatched record is not fresh state for this actor. Keep the known
			// envelope snapshot instead of evaluating this task's event against another.
			project = snapshot.project;
			task = snapshot.task;
		}
		const currentState = lifecycleStateFromTask(project, task);
		const actorRuntime = this.actors.runtime(taskId);
		const mergePromptReservation = actorRuntime.mergePromptReservation;
		if (mergePromptReservation) currentState.facts.mergePromptReservation = mergePromptReservation;
		if (actorRuntime.prPromoted) currentState.facts.prPromoted = true;
		if (actorRuntime.prSignalKey) currentState.facts.prSignalKey = actorRuntime.prSignalKey;
		const decision = transition(currentState, event);
		if (decision.effects.length === 0) {
			this.syncActivities(taskId, currentState, decision.next);
			return task;
		}

		const context: LifecycleExecutionContext = {
			project,
			sourceTask: task,
			task,
			event,
			nextState: decision.next,
			dropPosition: await lifecycleDropPosition(),
			hooks: {
				dispatchFollowUp: (nextProjectId, nextTaskId, nextEvent, nextTask) => {
					if (actorRuntime.removed || generation !== this.generation) return Promise.resolve(nextTask ?? task);
					return this.dispatch(
						nextProjectId,
						nextTaskId,
						nextEvent,
						nextTask ? { project, task: nextTask } : undefined,
						"fallback",
						generation,
					);
				},
				processInline: (nextProjectId, nextTaskId, nextEvent, nextTask) => {
					if (actorRuntime.removed || generation !== this.generation) return Promise.resolve(nextTask ?? task);
					return this.processEvent(
						nextProjectId,
						nextTaskId,
						nextEvent,
						nextTask ? { project, task: nextTask } : undefined,
						"fallback",
						generation,
					);
				},
				runDetached: (work) => {
					this.detachedWork.add(work);
					void work.finally(() => this.detachedWork.delete(work));
				},
				reserveMergePrompt: (id, fingerprint, reservedAt) => {
					this.actors.runtime(id).mergePromptReservation = { fingerprint, reservedAt };
				},
				setPrPromoted: (id, promoted) => {
					const runtime = this.actors.runtime(id);
					if (promoted) runtime.prPromoted = true;
					else delete runtime.prPromoted;
				},
				setPrSignalKey: (id, signalKey) => {
					const runtime = this.actors.runtime(id);
					if (signalKey) runtime.prSignalKey = signalKey;
					else delete runtime.prSignalKey;
				},
				clearMergeThrottle: (id) => {
					delete this.actors.runtime(id).mergePromptReservation;
				},
				clearTaskRuntime: (id) => {
					const runtime = this.actors.runtime(id);
					delete runtime.mergePromptReservation;
					delete runtime.gitOpPaneId;
					runtime.branchChecks?.clear();
					delete runtime.branchChecks;
					delete runtime.mergeNextDue;
					delete runtime.prNextDue;
					delete runtime.prPending;
					delete runtime.prPromoted;
					delete runtime.prSignalKey;
				},
			},
			stateTask: task,
		};

		const followUps: Array<{ event: LifecycleEvent; source: LifecycleEffect }> = [];
		for (const effect of decision.effects) {
			try {
				const outcome = await executeLifecycleEffect(effect, context);
				if (outcome.followUp) followUps.push({ event: outcome.followUp, source: effect });
				if (outcome.stop) break;
			} catch (error) {
				log[effect.onError === "continue" ? "warn" : "error"]("Lifecycle effect failed", {
					taskId: taskId.slice(0, 8),
					event: event.type,
					effect: effect.type,
					policy: effect.onError,
					error: String(error),
				});
				if (effect.onError === "continue") continue;
				const compensation = errorEvent(effect, error);
				if (compensation) {
					return this.processEvent(projectId, taskId, compensation, {
						project: context.project,
						task: context.stateTask ?? context.task,
					}, "fallback", generation);
				}
				throw error;
			}
		}

		let result = context.task;
		for (const { event: followUp, source } of followUps) {
			if (generation !== this.generation) return context.stateTask ?? context.task;
			const stateTask = context.stateTask ?? context.task;
			try {
				result = await this.processEvent(projectId, taskId, followUp, {
					project: context.project,
					task: stateTask,
				}, snapshotMode === "activity" ? "activity" : "fallback", generation);
			} catch (error) {
				log[source.onError === "continue" ? "warn" : "error"]("Lifecycle follow-up failed", {
					taskId: taskId.slice(0, 8),
					event: event.type,
					effect: source.type,
					followUp: followUp.type,
					policy: source.onError,
					error: String(error),
				});
				if (source.onError === "continue") continue;
				const compensation = errorEvent(source, error);
				if (compensation) {
					return this.processEvent(projectId, taskId, compensation, {
						project: context.project,
						task: stateTask,
					}, "fallback", generation);
				}
				throw error;
			}
		}
		this.syncActivities(
			taskId,
			currentState,
			lifecycleStateFromTask(context.project, result),
		);
		return result;
	}

	private syncActivities(
		taskId: string,
		current: ReturnType<typeof lifecycleStateFromTask>,
		next: ReturnType<typeof lifecycleStateFromTask>,
	): void {
		const runtime = this.actors.runtime(taskId);
		const currentActivities = new Set(activitiesFor(current));
		const nextActivities = new Set(activitiesFor(next));
		if (currentActivities.has("mergeWatch") && !nextActivities.has("mergeWatch")) {
			delete runtime.mergeNextDue;
		}
		if (currentActivities.has("prWatch") && !nextActivities.has("prWatch")) {
			delete runtime.prNextDue;
			delete runtime.prPending;
			delete runtime.prPromoted;
			delete runtime.prSignalKey;
		}
		runtime.activeActivities = nextActivities;
	}
}

export const lifecycleService = new LifecycleService();

export function dispatchLifecycleEvent(
	projectId: string,
	taskId: string,
	event: LifecycleEvent,
	snapshot?: { project: Project; task: Task },
): Promise<Task> {
	return lifecycleService.dispatch(projectId, taskId, event, snapshot, snapshot ? "fallback" : "primary");
}

export function dispatchLifecycleFinding(
	project: Project,
	task: Task,
	event: LifecycleEvent,
): Promise<Task> {
	return lifecycleService.dispatch(
		project.id,
		task.id,
		event,
		{ project, task },
		"activity",
	);
}

export function removeLifecycleActor(taskId: string): void {
	lifecycleService.delete(taskId);
}

export function _resetLifecycleActorsForTest(): Promise<void> {
	return lifecycleService.resetForTests();
}

export function lifecycleActorRuntime(taskId: string): LifecycleActorRuntime {
	return lifecycleService.runtime(taskId);
}

export function forEachLifecycleActorRuntime(
	visitor: (runtime: LifecycleActorRuntime, taskId: string) => void,
): void {
	lifecycleService.forEachRuntime(visitor);
}

export async function triggerColumnAgentIfNeeded(
	newStatus: TaskStatus,
	project: Project,
	task: Task,
	options?: { customColumn?: CustomColumn },
): Promise<void> {
	const customColumn = options?.customColumn;
	const column = {
		status: customColumn ? task.status : newStatus,
		customColumnId: customColumn?.id ?? null,
	};
	const failure = await launchLifecycleColumnAgent(project, task, column, customColumn);
	if (!failure) return;
	await dispatchLifecycleEvent(project.id, task.id, failure, { project, task });
}
