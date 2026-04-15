import { AsyncLocalStorage } from "node:async_hooks";
import type { PreparingStage } from "../shared/types";
import { createLogger } from "./logger";

const log = createLogger("preparing");

type PreparationProcess = {
	pid: number;
	cmd: string[];
	startedAt: number;
};

type PreparationEntry = {
	taskId: string;
	runId: string;
	label: string;
	startedAt: number;
	cancelled: boolean;
	processes: Map<number, PreparationProcess>;
};

type PreparationContext = {
	taskId: string;
	runId: string;
	currentStage: PreparingStage | null;
	reportStage?: (stage: PreparingStage) => Promise<void> | void;
};

const activePreparations = new Map<string, PreparationEntry>();
const preparationContext = new AsyncLocalStorage<PreparationContext>();

export class TaskPreparationCancelledError extends Error {
	constructor(taskId: string) {
		super(`Task preparation was cancelled for ${taskId}`);
		this.name = "TaskPreparationCancelledError";
	}
}

export function createTaskPreparation(taskId: string, label: string): { runId: string } {
	const existing = activePreparations.get(taskId);
	if (existing) {
		log.warn("Replacing existing task preparation entry", {
			taskId: taskId.slice(0, 8),
			prevRunId: existing.runId,
			label: existing.label,
		});
	}

	const entry: PreparationEntry = {
		taskId,
		runId: crypto.randomUUID(),
		label,
		startedAt: Date.now(),
		cancelled: false,
		processes: new Map(),
	};
	activePreparations.set(taskId, entry);
	log.info("Task preparation started", {
		taskId: taskId.slice(0, 8),
		runId: entry.runId,
		label,
	});
	return { runId: entry.runId };
}

export function finishTaskPreparation(taskId: string, runId: string, extra?: Record<string, unknown>): void {
	const entry = activePreparations.get(taskId);
	if (!entry || entry.runId !== runId) return;
	activePreparations.delete(taskId);
	log.info("Task preparation finished", {
		taskId: taskId.slice(0, 8),
		runId,
		label: entry.label,
		cancelled: entry.cancelled,
		durationMs: Date.now() - entry.startedAt,
		processCount: entry.processes.size,
		...(extra ?? {}),
	});
}

export async function withTaskPreparation<T>(
	taskId: string,
	label: string,
	fn: (runId: string) => Promise<T>,
	reportStage?: (stage: PreparingStage) => Promise<void> | void,
): Promise<T> {
	const { runId } = createTaskPreparation(taskId, label);
	try {
		return await preparationContext.run({ taskId, runId, currentStage: null, reportStage }, () => fn(runId));
	} finally {
		finishTaskPreparation(taskId, runId);
	}
}

export function markTaskPreparationCancelled(taskId: string): { runId: string | null; pids: number[] } {
	const entry = activePreparations.get(taskId);
	if (!entry) {
		return { runId: null, pids: [] };
	}
	entry.cancelled = true;
	const pids = [...entry.processes.keys()];
	log.warn("Task preparation cancellation requested", {
		taskId: taskId.slice(0, 8),
		runId: entry.runId,
		processCount: pids.length,
	});
	return { runId: entry.runId, pids };
}

export function forgetTaskPreparation(taskId: string, runId?: string): void {
	const entry = activePreparations.get(taskId);
	if (!entry) return;
	if (runId && entry.runId !== runId) return;
	activePreparations.delete(taskId);
}

export function isTaskPreparationActive(taskId: string, runId: string): boolean {
	const entry = activePreparations.get(taskId);
	return !!entry && entry.runId === runId && !entry.cancelled;
}

export function assertTaskPreparationActive(taskId: string, runId: string): void {
	if (!isTaskPreparationActive(taskId, runId)) {
		throw new TaskPreparationCancelledError(taskId);
	}
}

export function registerPreparationSpawn(taskId: string, pid: number | undefined, cmd: string[]): void {
	if (!pid || pid <= 0) return;
	const entry = activePreparations.get(taskId);
	if (!entry || entry.cancelled) return;
	entry.processes.set(pid, { pid, cmd: [...cmd], startedAt: Date.now() });
	log.debug("Tracking preparation process", {
		taskId: taskId.slice(0, 8),
		runId: entry.runId,
		pid,
		cmd: cmd.join(" "),
	});
}

export function unregisterPreparationSpawn(taskId: string, pid: number | undefined): void {
	if (!pid || pid <= 0) return;
	activePreparations.get(taskId)?.processes.delete(pid);
}

export function registerCurrentPreparationSpawn(pid: number | undefined, cmd: string[]): PreparationContext | null {
	const ctx = preparationContext.getStore();
	if (!ctx) return null;
	registerPreparationSpawn(ctx.taskId, pid, cmd);
	return ctx;
}

export async function reportCurrentPreparationStage(stage: PreparingStage): Promise<void> {
	const ctx = preparationContext.getStore();
	if (!ctx || ctx.currentStage === stage) return;
	ctx.currentStage = stage;
	await ctx.reportStage?.(stage);
}

export function getTaskPreparationSnapshot(taskId: string): { runId: string; pids: number[]; cancelled: boolean; label: string } | null {
	const entry = activePreparations.get(taskId);
	if (!entry) return null;
	return {
		runId: entry.runId,
		pids: [...entry.processes.keys()],
		cancelled: entry.cancelled,
		label: entry.label,
	};
}
