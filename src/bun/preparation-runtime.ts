import { AsyncLocalStorage } from "node:async_hooks";
import type { PreparingStage } from "../shared/types";
import { createLogger } from "./logger";

const log = createLogger("preparing");

type PreparationProcess = {
	pid: number;
	cmd: string[];
	startedAt: number;
	exited?: Promise<unknown>;
};

type PreparationEntry = {
	taskId: string;
	runId: string;
	label: string;
	startedAt: number;
	cancelled: boolean;
	finished: boolean;
	finishExtra?: Record<string, unknown>;
	processes: Map<number, PreparationProcess>;
	settled: Promise<void>;
	resolveSettled: () => void;
};

type PreparationContext = {
	taskId: string;
	runId: string;
	currentStage: PreparingStage | null;
	reportStage?: (stage: PreparingStage) => Promise<void> | void;
};

const activePreparations = new Map<string, PreparationEntry>();
const preparationContext = new AsyncLocalStorage<PreparationContext>();

function settleTaskPreparation(entry: PreparationEntry): void {
	if (!entry.finished || entry.processes.size > 0) return;
	if (activePreparations.get(entry.taskId) === entry) {
		activePreparations.delete(entry.taskId);
	}
	entry.resolveSettled();
	log.info("Task preparation finished", {
		taskId: entry.taskId.slice(0, 8),
		runId: entry.runId,
		label: entry.label,
		cancelled: entry.cancelled,
		durationMs: Date.now() - entry.startedAt,
		processCount: entry.processes.size,
		...(entry.finishExtra ?? {}),
	});
}

export class TaskPreparationCancelledError extends Error {
	constructor(taskId: string) {
		super(`Task preparation was cancelled for ${taskId}`);
		this.name = "TaskPreparationCancelledError";
	}
}

export function createTaskPreparation(taskId: string, label: string, requestedRunId?: string): { runId: string } {
	const existing = activePreparations.get(taskId);
	if (existing) {
		log.warn("Replacing existing task preparation entry", {
			taskId: taskId.slice(0, 8),
			prevRunId: existing.runId,
			label: existing.label,
		});
		existing.cancelled = true;
		existing.finished = true;
		settleTaskPreparation(existing);
	}

	let resolveSettled!: () => void;
	const settled = new Promise<void>((resolve) => {
		resolveSettled = resolve;
	});
	const entry: PreparationEntry = {
		taskId,
		runId: requestedRunId ?? crypto.randomUUID(),
		label,
		startedAt: Date.now(),
		cancelled: false,
		finished: false,
		processes: new Map(),
		settled,
		resolveSettled,
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
	entry.finished = true;
	entry.finishExtra = extra;
	settleTaskPreparation(entry);
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

export async function withTaskPreparationRunId<T>(
	taskId: string,
	label: string,
	runId: string,
	fn: () => Promise<T>,
	reportStage?: (stage: PreparingStage) => Promise<void> | void,
): Promise<T> {
	createTaskPreparation(taskId, label, runId);
	try {
		return await preparationContext.run({ taskId, runId, currentStage: null, reportStage }, fn);
	} finally {
		finishTaskPreparation(taskId, runId);
	}
}

export function markTaskPreparationCancelled(taskId: string): {
	runId: string | null;
	pids: number[];
	settled: Promise<void>;
	trackedProcessesExited: Promise<void>;
	reentrant: boolean;
} {
	const entry = activePreparations.get(taskId);
	if (!entry) {
		return {
			runId: null,
			pids: [],
			settled: Promise.resolve(),
			trackedProcessesExited: Promise.resolve(),
			reentrant: false,
		};
	}
	entry.cancelled = true;
	const processes = [...entry.processes.values()];
	const pids = processes.map((process) => process.pid);
	const currentContext = preparationContext.getStore();
	log.warn("Task preparation cancellation requested", {
		taskId: taskId.slice(0, 8),
		runId: entry.runId,
		processCount: pids.length,
	});
	return {
		runId: entry.runId,
		pids,
		settled: entry.settled,
		trackedProcessesExited: Promise.allSettled(
			processes.map((process) => process.exited ?? Promise.resolve()),
		).then(() => {}),
		reentrant: currentContext?.taskId === taskId && currentContext.runId === entry.runId,
	};
}

export function forgetTaskPreparation(taskId: string, runId?: string): void {
	const entry = activePreparations.get(taskId);
	if (!entry) return;
	if (runId && entry.runId !== runId) return;
	activePreparations.delete(taskId);
	entry.resolveSettled();
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

export function registerPreparationSpawn(
	taskId: string,
	pid: number | undefined,
	cmd: string[],
	exited?: Promise<unknown>,
): { taskId: string; runId: string; cancelled: boolean } | null {
	if (!pid || pid <= 0) return null;
	const entry = activePreparations.get(taskId);
	if (!entry) return null;
	const process = { pid, cmd: [...cmd], startedAt: Date.now(), exited };
	entry.processes.set(pid, process);
	if (exited) {
		void exited.finally(() => {
			if (entry.processes.get(pid) !== process) return;
			entry.processes.delete(pid);
			settleTaskPreparation(entry);
		}).catch(() => {});
	}
	log.debug("Tracking preparation process", {
		taskId: taskId.slice(0, 8),
		runId: entry.runId,
		pid,
		cmd: cmd.join(" "),
	});
	return { taskId, runId: entry.runId, cancelled: entry.cancelled };
}

export function unregisterPreparationSpawn(taskId: string, pid: number | undefined, runId?: string): void {
	if (!pid || pid <= 0) return;
	const entry = activePreparations.get(taskId);
	if (!entry || (runId && entry.runId !== runId)) return;
	entry.processes.delete(pid);
	settleTaskPreparation(entry);
}

export function registerCurrentPreparationSpawn(
	pid: number | undefined,
	cmd: string[],
	exited?: Promise<unknown>,
): { taskId: string; runId: string; cancelled: boolean } | null {
	const ctx = preparationContext.getStore();
	if (!ctx) return null;
	return registerPreparationSpawn(ctx.taskId, pid, cmd, exited);
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
