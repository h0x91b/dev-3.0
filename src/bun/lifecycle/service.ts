import type { BranchStatus, Project, Task } from "../../shared/types";
import * as data from "../data";
import { log } from "../rpc-handlers/shared";
import { TaskActorRegistry } from "./actor";
import {
	executeLifecycleEffect,
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
	snapshot?: { project: Project; task: Task };
	snapshotMode?: "primary" | "fallback" | "activity";
};

type RuntimeCleanupHooks = {
	clearMergeThrottle: (taskId: string) => void;
	clearTaskRuntime: (taskId: string) => void;
};

export interface LifecycleActorRuntime {
	mergePromptReservation?: { fingerprint: string; reservedAt: number };
	mergeNextDue?: number;
	prNextDue?: number;
	prPending?: boolean;
	prPromoted?: boolean;
	prSignalKey?: string;
	gitOpPaneId?: string;
	branchStatusInFlight?: Map<string, Promise<BranchStatus>>;
	activeActivities?: Set<LifecycleActivity>;
}

function errorEvent(effect: LifecycleEffect, error: unknown): LifecycleEvent | null {
	if (!effect.compensatingEvent) return null;
	if (effect.compensatingEvent.type === "preparationFailed") {
		return {
			...effect.compensatingEvent,
			error: error instanceof Error ? error.message : String(error),
		};
	}
	return effect.compensatingEvent;
}

class LifecycleService {
	private cleanupHooks: RuntimeCleanupHooks = {
		clearMergeThrottle: () => {},
		clearTaskRuntime: () => {},
	};

	private readonly actors = new TaskActorRegistry<LifecycleEnvelope, Task, LifecycleActorRuntime>(
		(taskId, envelope) => this.processEvent(
			envelope.projectId,
			taskId,
			envelope.event,
			envelope.snapshot,
			envelope.snapshotMode,
		),
		() => ({}),
	);

	setCleanupHooks(hooks: Partial<RuntimeCleanupHooks>): void {
		this.cleanupHooks = { ...this.cleanupHooks, ...hooks };
	}

	dispatch(
		projectId: string,
		taskId: string,
		event: LifecycleEvent,
		snapshot?: { project: Project; task: Task },
		snapshotMode: "primary" | "fallback" | "activity" = "primary",
	): Promise<Task> {
		const normalized = event.type === "moveRequested" && !event.runId
			? { ...event, runId: crypto.randomUUID() }
			: event;
		return this.actors.dispatch(taskId, { projectId, event: normalized, snapshot, snapshotMode });
	}

	delete(taskId: string): void {
		this.cleanupHooks.clearTaskRuntime(taskId);
		this.actors.delete(taskId);
	}

	resetForTests(): void {
		this.actors.clear();
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
	): Promise<Task> {
		let project = snapshotMode === "primary" || snapshotMode === "activity"
			? snapshot?.project
			: undefined;
		try {
			project ??= await data.getProject(projectId);
		} catch (error) {
			if (!snapshot || snapshotMode !== "fallback") throw error;
		}
		project ??= snapshot?.project;
		if (!project) throw new Error(`Project not found: ${projectId}`);
		let task = snapshotMode === "primary" ? snapshot?.task : undefined;
		if (snapshotMode === "activity") {
			task = (await data.loadTasks(project)).find((candidate) => candidate.id === taskId)
				?? snapshot?.task;
		}
		try {
			task ??= await data.getTask(project, taskId);
		} catch (error) {
			if (!snapshot || snapshotMode !== "fallback") throw error;
		}
		task ??= snapshot?.task;
		if (!task) throw new Error(`Task not found: ${taskId}`);
		if (snapshotMode === "fallback" && snapshot?.task.runtimeState && !task?.runtimeState) {
			project = snapshot.project;
			task = snapshot.task;
		}
		const currentState = lifecycleStateFromTask(project, task);
		const decision = transition(currentState, event);
		this.syncActivities(taskId, currentState, decision.next);
		if (decision.effects.length === 0) return task;

		const context: LifecycleExecutionContext = {
			project,
			sourceTask: task,
			task,
			event,
			nextState: decision.next,
			dropPosition: await lifecycleDropPosition(),
			hooks: {
				dispatchFollowUp: (nextProjectId, nextTaskId, nextEvent, nextTask) => (
					this.dispatch(
						nextProjectId,
						nextTaskId,
						nextEvent,
						nextTask ? { project, task: nextTask } : undefined,
						"fallback",
					)
				),
				processInline: (nextProjectId, nextTaskId, nextEvent, nextTask) => (
					this.processEvent(
						nextProjectId,
						nextTaskId,
						nextEvent,
						nextTask ? { project, task: nextTask } : undefined,
					)
				),
				clearMergeThrottle: (id) => {
					delete this.actors.runtime(id).mergePromptReservation;
					this.cleanupHooks.clearMergeThrottle(id);
				},
				clearTaskRuntime: (id) => {
					const runtime = this.actors.runtime(id);
					delete runtime.mergeNextDue;
					delete runtime.prNextDue;
					delete runtime.prPending;
					delete runtime.prPromoted;
					delete runtime.prSignalKey;
					this.cleanupHooks.clearTaskRuntime(id);
				},
			},
			stateTask: task,
		};

		const followUps: LifecycleEvent[] = [];
		for (const effect of decision.effects) {
			try {
				const outcome = await executeLifecycleEffect(effect, context);
				if (outcome.followUp) followUps.push(outcome.followUp);
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
					return this.processEvent(projectId, taskId, compensation);
				}
				throw error;
			}
		}

		let result = context.task;
		for (const followUp of followUps) {
			const stateTask = context.stateTask ?? context.task;
			result = await this.processEvent(projectId, taskId, followUp, {
				project: context.project,
				task: stateTask,
			});
		}
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
	return lifecycleService.dispatch(projectId, taskId, event, snapshot);
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

export function _resetLifecycleActorsForTest(): void {
	lifecycleService.resetForTests();
}

export function lifecycleActorRuntime(taskId: string): LifecycleActorRuntime {
	return lifecycleService.runtime(taskId);
}

export function forEachLifecycleActorRuntime(
	visitor: (runtime: LifecycleActorRuntime, taskId: string) => void,
): void {
	lifecycleService.forEachRuntime(visitor);
}
