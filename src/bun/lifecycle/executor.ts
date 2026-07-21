import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import type {
	ColumnAgentConfig,
	CompletedDiffStats,
	CustomColumn,
	AppRPCSchema,
	PreparingStage,
	Project,
	Task,
	TaskRuntimeState,
	TaskStatus,
} from "../../shared/types";
import {
	buildTaskDialogSubject,
	DEFAULT_REVIEW_PROMPT,
	getPreparingStageProgress,
	getTaskTitle,
} from "../../shared/types";
import { clonePaths } from "../cow-clone";
import * as data from "../data";
import * as git from "../git";
import { DEV3_HOME, OPS_DIR } from "../paths";
import * as portPool from "../port-pool";
import {
	assertTaskPreparationActive,
	markTaskPreparationCancelled,
	reportCurrentPreparationStage,
	withTaskPreparationRunId,
} from "../preparation-runtime";
import * as pty from "../pty-server";
import * as repoConfig from "../repo-config";
import { loadSettings, loadSettingsSync } from "../settings";
import { getUserShell } from "../shell-env";
import { spawn } from "../spawn";
import { dev3TaskTempPath } from "../temp-paths";
import {
	activeTmuxConfigPath,
	cleanupSessionName,
	DEFAULT_TMUX_SOCKET,
	tmux,
} from "../tmux";
import {
	cleanupTaskTmuxState,
	killDevServerSession,
	launchColumnAgent,
	launchTaskPty,
} from "../rpc-handlers/tmux-pty";
import { resolveOperationalProjectConfig } from "../rpc-handlers/settings-config";
import {
	buildScriptRunnerCommand,
	buildTaskLifecycleEnv,
	getPushMessage,
	log,
	notifyWatchedTaskEvent,
	notifyWatchedTaskStatusChange,
	pushCliAttention,
} from "../rpc-handlers/shared";
import type { LifecycleEffect } from "./effects";
import type {
	LifecycleColumn,
	LifecycleEvent,
	LifecycleRuntime,
	LifecycleState,
	PreparationLaunch,
} from "./events";

export interface LifecycleExecutorHooks {
	dispatchFollowUp: (projectId: string, taskId: string, event: LifecycleEvent, snapshot?: Task) => Promise<Task>;
	processInline: (projectId: string, taskId: string, event: LifecycleEvent, snapshot?: Task) => Promise<Task>;
	runDetached: (work: Promise<unknown>) => void;
	reserveMergePrompt: (taskId: string, fingerprint: string, reservedAt: number) => void;
	setPrPromoted: (taskId: string, promoted: boolean) => void;
	setPrSignalKey: (taskId: string, signalKey: string | null) => void;
	clearMergeThrottle: (taskId: string) => void;
	clearTaskRuntime: (taskId: string) => void;
}

export interface LifecycleExecutionContext {
	project: Project;
	sourceTask: Task;
	task: Task;
	event: LifecycleEvent;
	nextState: LifecycleState;
	dropPosition: "top" | "bottom";
	hooks: LifecycleExecutorHooks;
	completedDiffStats?: CompletedDiffStats;
	stateTask?: Task;
}

export interface LifecycleEffectOutcome {
	followUp?: LifecycleEvent;
	stop?: boolean;
}

type BunMessagePayload<Name extends keyof AppRPCSchema["bun"]["messages"]> =
	AppRPCSchema["bun"]["messages"][Name];

function runtimeState(runtime: LifecycleRuntime): TaskRuntimeState {
	if (runtime.phase === "preparing") {
		return {
			runtime: "preparing",
			stage: runtime.stage,
			runId: runtime.runId,
			updatedAt: Date.now(),
		};
	}
	if (runtime.phase === "tearing-down") {
		return {
			runtime: "tearing-down",
			stage: runtime.targetStatus,
			runId: runtime.runId,
			updatedAt: Date.now(),
		};
	}
	return { runtime: runtime.phase, updatedAt: Date.now() };
}

function clearedPreparationFields(): Pick<
	Task,
	"preparing" | "preparingStage" | "preparingProgress" | "preparingStartedAt"
> {
	return {
		preparing: false,
		preparingStage: null,
		preparingProgress: null,
		preparingStartedAt: null,
	};
}

function preparationRuntimeUpdates(runtime: LifecycleRuntime): Partial<Task> {
	if (runtime.phase === "preparing") {
		return {
			runtimeState: runtimeState(runtime),
			preparing: true,
			preparingStage: runtime.stage,
			preparingProgress: getPreparingStageProgress(runtime.stage),
			preparingStartedAt: new Date().toISOString(),
			preparationError: null,
		};
	}
	return {
		runtimeState: runtimeState(runtime),
		...(runtime.phase === "running" || runtime.phase === "idle"
			? clearedPreparationFields()
			: {}),
	};
}

function taskAfterPersistedUpdate(current: Task, persisted: Task, updates: Partial<Task>): Task {
	if (persisted.id !== current.id) {
		throw new Error(`Lifecycle write returned the wrong task: ${persisted.id}`);
	}
	return {
		...current,
		...persisted,
		...updates,
	};
}

function isScratchPlaceholderDescription(description: string): boolean {
	return /^Scratch — \d{2}:\d{2}$/.test(description.trim());
}

function taskWithLaunchDescription(task: Task, forceBlank = false): Task {
	return forceBlank || isScratchPlaceholderDescription(task.description)
		? { ...task, description: "" }
		: task;
}

function derivedPreparationPath(project: Project, task: Task): string {
	if (project.kind === "virtual") {
		return task.opsWorkDir?.trim() || git.virtualWorkDir(project, task);
	}
	return `${git.taskDir(project, task)}/worktree`;
}

async function runCowClones(project: Project, worktreePath: string): Promise<void> {
	if (!project.clonePaths?.length) return;
	await clonePaths(project.path, worktreePath, project.clonePaths);
}

async function preparationStep<T>(
	task: Task,
	runId: string,
	stage: PreparingStage,
	name: string,
	fn: () => Promise<T>,
): Promise<T> {
	assertTaskPreparationActive(task.id, runId);
	await reportCurrentPreparationStage(stage);
	assertTaskPreparationActive(task.id, runId);
	const startedAt = performance.now();
	log.info("Lifecycle preparation effect started", {
		taskId: task.id.slice(0, 8),
		runId,
		stage,
		name,
	});
	try {
		const result = await fn();
		assertTaskPreparationActive(task.id, runId);
		log.info("Lifecycle preparation effect finished", {
			taskId: task.id.slice(0, 8),
			runId,
			stage,
			name,
			durationMs: Math.round(performance.now() - startedAt),
		});
		return result;
	} catch (error) {
		log.error("Lifecycle preparation effect failed", {
			taskId: task.id.slice(0, 8),
			runId,
			stage,
			name,
			durationMs: Math.round(performance.now() - startedAt),
			error: String(error),
		});
		throw error;
	}
}

async function prepareTask(
	project: Project,
	task: Task,
	effect: Extract<LifecycleEffect, { type: "prepareTask" }>,
	reportStage: (stage: PreparingStage) => Promise<void>,
): Promise<{ worktreePath: string; branchName: string | null }> {
	const launch: PreparationLaunch = effect.launch ?? {
		label: effect.isReopen ? "reopen" : "activation",
		agentId: task.agentId,
		configId: task.configId,
		existingBranch: task.existingBranch ?? undefined,
	};
	return withTaskPreparationRunId(task.id, launch.label, effect.runId, async () => {
		if (project.kind === "virtual") {
			const workDir = task.opsWorkDir?.trim() || git.virtualWorkDir(project, task);
			await preparationStep(task, effect.runId, "creating-worktree", "createOpsWorkDir", () => (
				mkdir(workDir, { recursive: true })
			));
			await preparationStep(task, effect.runId, "launching-pty", "launchTaskPty", () => (
				launchTaskPty(
					project,
					taskWithLaunchDescription(task, effect.isReopen),
					workDir,
					launch.agentId,
					launch.configId,
					true,
					effect.isReopen,
				)
			));
			return { worktreePath: workDir, branchName: null };
		}

		const resolvedProject = await preparationStep(
			task,
			effect.runId,
			"resolving-config",
			"resolveProjectConfig",
			() => repoConfig.resolveProjectConfig(project),
		);
		const worktree = await preparationStep(
			task,
			effect.runId,
			"creating-worktree",
			"createWorktree",
			() => launch.label === "variant" || launch.label === "attempt"
				? git.createWorktree(resolvedProject, task, launch.existingBranch ?? undefined, launch.variantBranchName)
				: git.createWorktree(resolvedProject, task, launch.existingBranch ?? undefined),
		);
		const resolved = await preparationStep(
			task,
			effect.runId,
			"resolving-config",
			"resolveOperationalProjectConfig",
			() => resolveOperationalProjectConfig(resolvedProject, worktree.worktreePath),
		);
		if (resolved.sparseCheckoutEnabled && resolved.sparseCheckoutPaths?.length) {
			await preparationStep(
				task,
				effect.runId,
				"applying-sparse-checkout",
				"applySparseCheckout",
				() => git.applySparseCheckout(worktree.worktreePath, resolved.sparseCheckoutPaths!),
			);
		}
		await preparationStep(
			task,
			effect.runId,
			"cloning-shared-paths",
			"runCowClones",
			() => runCowClones(resolved, worktree.worktreePath),
		);
		await preparationStep(
			task,
			effect.runId,
			"launching-pty",
			"launchTaskPty",
			() => launchTaskPty(
				resolved,
				taskWithLaunchDescription(task, effect.isReopen),
				worktree.worktreePath,
				launch.agentId,
				launch.configId,
				true,
				effect.isReopen,
				{ branchName: worktree.branchName },
			),
		);
		return worktree;
	}, reportStage);
}

type CleanupTransition = {
	fromStatus: TaskStatus;
	toStatus: TaskStatus | "deleted";
};

function buildCleanupScriptEnv(
	task: Task,
	project: Project,
	transition: CleanupTransition,
): Record<string, string> {
	return {
		TERM: "xterm-256color",
		HOME: process.env.HOME || "/",
		...buildTaskLifecycleEnv(project, task, task.worktreePath || ""),
		DEV3_TASK_STATUS: transition.toStatus,
		DEV3_TASK_FROM_STATUS: transition.fromStatus,
		DEV3_TASK_TO_STATUS: transition.toStatus,
	};
}

export async function runCleanupScript(
	task: Task,
	project: Project,
	transition: CleanupTransition,
): Promise<void> {
	if (!task.worktreePath || !existsSync(task.worktreePath)) return;
	const resolved = await resolveOperationalProjectConfig(project, task.worktreePath);
	const script = resolved.cleanupScript?.trim() || 'echo "Task finished"';
	const scriptPath = dev3TaskTempPath(task.id, "cleanup.sh");
	const cleanupEnv = buildCleanupScriptEnv(task, project, transition);
	await Bun.write(scriptPath, `#!/bin/bash\n${script}\n`);
	const proc = tmux.spawnAttachedSession({
		socket: task.tmuxSocket ?? DEFAULT_TMUX_SOCKET,
		configFile: activeTmuxConfigPath(),
		sessionName: cleanupSessionName(task.id),
		cwd: task.worktreePath,
		envFlags: cleanupEnv,
		command: buildScriptRunnerCommand(scriptPath, { shellPath: getUserShell() }),
		terminal: { cols: 220, rows: 50, data: () => {} },
		processEnv: cleanupEnv,
	});
	await proc.exited;
}

export async function captureCompletedDiffStats(
	project: Project,
	task: Task,
): Promise<CompletedDiffStats | undefined> {
	if (project.kind === "virtual" || !task.worktreePath) return undefined;
	const baseBranch = task.baseBranch || project.defaultBaseBranch || "main";
	try {
		let stats = await git.getBranchDiffStats(task.worktreePath, `origin/${baseBranch}`);
		if (stats.files === 0 && stats.insertions === 0 && stats.deletions === 0) {
			const local = await git.getBranchDiffStats(task.worktreePath, baseBranch);
			if (local.files > 0 || local.insertions > 0 || local.deletions > 0) stats = local;
		}
		return { ...stats, capturedAt: new Date().toISOString() };
	} catch (error) {
		log.warn("captureCompletedDiffStats failed (best-effort)", {
			taskId: task.id.slice(0, 8),
			error: String(error),
		});
		return undefined;
	}
}

export function emitTaskSound(status: "completed" | "cancelled", taskId: string): void {
	if (loadSettingsSync().playSoundOnTaskComplete === false) return;
	const payload: BunMessagePayload<"taskSound"> = { status, taskId };
	getPushMessage()?.("taskSound", payload);
}

async function columnAgentConfig(
	project: Project,
	task: Task,
	column: LifecycleColumn,
	providedCustomColumn?: CustomColumn,
): Promise<{ config: ColumnAgentConfig; paneTitle: string; onExitCommand?: string } | null> {
	if (!task.worktreePath) return null;
	if (column.status === "review-by-ai" && column.customColumnId === null) {
		const resolved = await repoConfig.resolveProjectConfig(project, task.worktreePath);
		if (resolved.builtinColumnAgents && !resolved.builtinColumnAgents["review-by-ai"]) return null;
		const configured = resolved.builtinColumnAgents?.["review-by-ai"];
		return {
			config: {
				agentId: configured?.agentId || "builtin-claude",
				configId: configured?.configId || "claude-bypass-sonnet",
				prompt: configured?.prompt || DEFAULT_REVIEW_PROMPT,
			},
			paneTitle: "AI Review",
			onExitCommand: `${DEV3_HOME}/bin/dev3 task move ${task.id} --status review-by-user --if-status review-by-ai`,
		};
	}
	if (!column.customColumnId) return null;
	const customColumn = providedCustomColumn
		?? project.customColumns?.find((candidate) => candidate.id === column.customColumnId);
	if (!customColumn?.agentConfig) return null;
	return {
		config: customColumn.agentConfig,
		paneTitle: customColumn.name,
	};
}

export async function launchLifecycleColumnAgent(
	project: Project,
	task: Task,
	column: LifecycleColumn,
	customColumn?: CustomColumn,
): Promise<Extract<LifecycleEvent, { type: "columnAgentFailed" }> | null> {
	let columnName = column.status === "review-by-ai" && column.customColumnId === null
		? "AI Review"
		: customColumn?.name
			?? project.customColumns?.find((candidate) => candidate.id === column.customColumnId)?.name
			?? column.status;
	try {
		const configured = await columnAgentConfig(project, task, column, customColumn);
		if (!configured) return null;
		columnName = configured.paneTitle;
		await launchColumnAgent(project, task, configured.config, {
			paneTitle: configured.paneTitle,
			onExitCommand: configured.onExitCommand,
		});
		return null;
	} catch (error) {
		return {
			type: "columnAgentFailed",
			columnName,
			error: String(error),
		};
	}
}

async function launchColumnAgentEffect(
	ctx: LifecycleExecutionContext,
	column: LifecycleColumn,
): Promise<LifecycleEffectOutcome> {
	const failure = await launchLifecycleColumnAgent(ctx.project, ctx.task, column);
	return failure ? { followUp: failure } : {};
}

export async function activateTask(
	project: Project,
	task: Task,
	opts?: { isReopen?: boolean },
): Promise<{ worktreePath: string; branchName: string | null }> {
	const runId = crypto.randomUUID();
	return prepareTask(project, task, {
		type: "prepareTask",
		runId,
		origin: { status: task.status, customColumnId: task.customColumnId ?? null },
		target: { status: task.status, customColumnId: task.customColumnId ?? null },
		isReopen: opts?.isReopen === true,
		awaitCompletion: true,
		columnReserved: false,
		successPatch: "activation",
		launch: {
			label: "activation",
			agentId: task.agentId,
			configId: task.configId,
			existingBranch: task.existingBranch ?? undefined,
		},
		onError: "abort",
	}, async () => {});
}

async function killPreparationProcesses(taskId: string): Promise<void> {
	const { pids } = markTaskPreparationCancelled(taskId);
	for (const pid of pids) {
		try {
			const proc = spawn(["kill", "-9", String(pid)], { stdout: "pipe", stderr: "pipe" });
			await proc.exited;
		} catch (error) {
			log.warn("Failed to kill preparation process", { taskId: taskId.slice(0, 8), pid, error: String(error) });
		}
	}
}

function preparationFailurePayload(ctx: LifecycleExecutionContext, effect: Extract<LifecycleEffect, { type: "push" }>) {
	const payload: BunMessagePayload<"taskPreparationFailed"> = {
		taskId: ctx.task.id,
		projectId: ctx.project.id,
		taskTitle: getTaskTitle(ctx.task),
		error: effect.message === "taskPreparationFailed"
			? effect.payload.error ?? "Task preparation failed"
			: "Task preparation failed",
	};
	return payload;
}

function pushEffect(effect: Extract<LifecycleEffect, { type: "push" }>, ctx: LifecycleExecutionContext): void {
	const push = getPushMessage();
	if (!push) return;
	switch (effect.message) {
		case "taskUpdated": {
			const payload: BunMessagePayload<"taskUpdated"> = {
				projectId: ctx.project.id,
				task: effect.view === "shuttingDown" ? { ...ctx.task, shuttingDown: true } : ctx.task,
			};
			push("taskUpdated", payload);
			return;
		}
		case "taskPreparationFailed":
			push("taskPreparationFailed", preparationFailurePayload(ctx, effect));
			return;
		case "branchMerged": {
			const { finding, noticeOnly } = effect.payload;
			const payload: BunMessagePayload<"branchMerged"> = {
				taskId: ctx.sourceTask.id,
				projectId: ctx.project.id,
				taskTitle: ctx.sourceTask.customTitle || ctx.sourceTask.title,
				branchName: finding.branchName,
				fingerprint: finding.fingerprint,
				subject: buildTaskDialogSubject(ctx.sourceTask, ctx.project),
				...(noticeOnly ? { shouldPrompt: false, shouldNotify: true } : {}),
			};
			push("branchMerged", payload);
			return;
		}
		case "taskPrStatus":
			push("taskPrStatus", effect.payload);
			return;
		case "columnAgentFailed": {
			const failure = effect.payload;
			const payload: BunMessagePayload<"columnAgentFailed"> = {
				taskId: ctx.task.id,
				projectId: ctx.project.id,
				columnName: failure.columnName,
				error: failure.error,
			};
			push("columnAgentFailed", payload);
			return;
		}
		case "mergePromptResolved": {
			const resolution = effect.payload;
			const payload: BunMessagePayload<"mergePromptResolved"> = {
				taskId: ctx.task.id,
				projectId: ctx.project.id,
				fingerprint: resolution.fingerprint,
			};
			push("mergePromptResolved", payload);
			return;
		}
		default:
			return;
	}
}

export async function executeLifecycleEffect(
	effect: LifecycleEffect,
	ctx: LifecycleExecutionContext,
): Promise<LifecycleEffectOutcome> {
	switch (effect.type) {
		case "reject":
			throw new Error(effect.message);
		case "reserveMergePrompt":
			ctx.hooks.reserveMergePrompt(ctx.task.id, effect.fingerprint, effect.reservedAt);
			return {};
		case "setPrPromoted":
			ctx.hooks.setPrPromoted(ctx.task.id, effect.promoted);
			return {};
		case "setPrSignalKey":
			ctx.hooks.setPrSignalKey(ctx.task.id, effect.signalKey);
			return {};
		case "clearMergeThrottle":
			ctx.hooks.clearMergeThrottle(ctx.task.id);
			return {};
		case "clearTaskRuntime":
			cleanupTaskTmuxState(ctx.task.id);
			ctx.hooks.clearTaskRuntime(ctx.task.id);
			return {};
		case "cancelPreparationProcesses":
			await killPreparationProcesses(ctx.task.id);
			return {};
		case "releasePorts":
			portPool.releasePorts(ctx.task.id);
			return {};
		case "sendEvent":
			return { followUp: effect.event };
		case "persistRuntime":
			if (effect.column || effect.taskPatch) {
				const updates: Partial<Task> = {
					...effect.taskPatch,
					...preparationRuntimeUpdates(effect.runtime),
					...(effect.column ? {
						status: effect.column.status,
						customColumnId: effect.column.customColumnId,
					} : {}),
				};
				const previous = ctx.task;
				const persisted = await data.updateTask(ctx.project, ctx.task.id, updates, {
					dropPosition: ctx.dropPosition,
					...(effect.expectedColumn ? { ifStatus: effect.expectedColumn.status } : {}),
				});
				if (persisted.id !== previous.id) throw new Error(`Lifecycle reservation returned the wrong task: ${persisted.id}`);
				const persistedColumn = {
					status: persisted.status,
					customColumnId: persisted.customColumnId ?? null,
				};
				const reservationAccepted = !effect.column || (
					persistedColumn.status === effect.column.status
					&& persistedColumn.customColumnId === effect.column.customColumnId
				);
				if (!reservationAccepted) {
					ctx.task = persisted;
					ctx.stateTask = persisted;
					return { stop: true };
				}
				ctx.task = taskAfterPersistedUpdate(previous, persisted, updates);
			} else {
				const updates = preparationRuntimeUpdates(effect.runtime);
				const persisted = await data.updateTask(
					ctx.project,
					ctx.task.id,
					updates,
				);
				ctx.task = taskAfterPersistedUpdate(ctx.task, persisted, updates);
			}
			ctx.stateTask = ctx.task;
			return {};
		case "persistTaskPatch":
			{
				const persisted = await data.updateTask(ctx.project, ctx.task.id, effect.taskPatch);
				ctx.task = taskAfterPersistedUpdate(ctx.task, persisted, effect.taskPatch);
			}
			ctx.stateTask = ctx.task;
			return {};
		case "prepareTask": {
			const preparationTask = effect.columnReserved ? ctx.task : ctx.sourceTask;
			const work = async (): Promise<LifecycleEvent> => {
				const prepared = await prepareTask(ctx.project, preparationTask, effect, async (stage) => {
					const stageEvent: LifecycleEvent = {
						type: "preparationStageChanged",
						runId: effect.runId,
						stage,
					};
					if (effect.awaitCompletion) {
						const stagedTask = await ctx.hooks.processInline(
							ctx.project.id,
							ctx.task.id,
							stageEvent,
							ctx.stateTask,
						);
						ctx.task = stagedTask;
						ctx.stateTask = stagedTask;
					} else {
						await ctx.hooks.dispatchFollowUp(ctx.project.id, ctx.task.id, stageEvent, ctx.stateTask)
							.then((stagedTask) => {
								ctx.task = stagedTask;
								ctx.stateTask = stagedTask;
							})
							.catch((error) => {
								log.warn("Preparation stage dispatch failed", { taskId: ctx.task.id.slice(0, 8), error: String(error) });
							});
					}
				});
				return {
					type: "preparationSucceeded",
					runId: effect.runId,
					worktreePath: prepared.worktreePath,
					branchName: prepared.branchName,
					origin: effect.origin,
					target: effect.target,
					mode: effect.successPatch,
					columnReserved: effect.columnReserved,
				};
			};
			if (effect.awaitCompletion) {
				try {
					return { followUp: await work() };
				} catch (error) {
					const persistedRuntime = ctx.stateTask?.runtimeState;
					if (
						persistedRuntime
						&& (persistedRuntime.runtime !== "preparing" || persistedRuntime.runId !== effect.runId)
					) {
						return { stop: true };
					}
					throw error;
				}
			}
			ctx.hooks.runDetached(
				work()
					.then(
						(event) => ctx.hooks.dispatchFollowUp(ctx.project.id, ctx.task.id, event, ctx.stateTask),
						(error) => ctx.hooks.dispatchFollowUp(ctx.project.id, ctx.task.id, {
							type: "preparationFailed",
							runId: effect.runId,
							error: error instanceof Error ? error.message : String(error),
							origin: effect.origin,
							target: effect.target,
						}, ctx.stateTask),
					)
					.catch((error) => {
						log.error("Detached preparation follow-up failed", { taskId: ctx.task.id.slice(0, 8), error: String(error) });
					}),
			);
			return {};
		}
		case "destroyTaskPty":
			pty.destroySession(ctx.sourceTask.id, ctx.sourceTask.tmuxSocket ?? undefined);
			return {};
		case "killDevServer":
			await killDevServerSession(
				ctx.sourceTask.id,
				ctx.sourceTask.tmuxSocket ?? DEFAULT_TMUX_SOCKET,
				ctx.sourceTask.worktreePath,
			);
			return {};
		case "runCleanupScript":
			await runCleanupScript(effect.allowDerivedPath && !ctx.sourceTask.worktreePath
				? { ...ctx.sourceTask, worktreePath: derivedPreparationPath(ctx.project, ctx.sourceTask) }
				: ctx.sourceTask, ctx.project, {
				fromStatus: ctx.sourceTask.status,
				toStatus: effect.toStatus,
			});
			return {};
		case "captureCompletedDiffStats":
			ctx.completedDiffStats = await captureCompletedDiffStats(
				ctx.project,
				effect.allowDerivedPath && !ctx.sourceTask.worktreePath
					? { ...ctx.sourceTask, worktreePath: derivedPreparationPath(ctx.project, ctx.sourceTask) }
					: ctx.sourceTask,
			);
			return {};
		case "removeWorktree":
			await git.removeWorktree(
				ctx.project,
				effect.allowDerivedPath && !ctx.sourceTask.worktreePath
					? { ...ctx.sourceTask, worktreePath: derivedPreparationPath(ctx.project, ctx.sourceTask) }
					: ctx.sourceTask,
			);
			return {};
		case "removeTaskWorkspace":
			{
				const worktreePath = ctx.sourceTask.worktreePath
					?? (effect.allowDerivedPath ? derivedPreparationPath(ctx.project, ctx.sourceTask) : null);
				if (ctx.project.kind === "virtual") {
					if (worktreePath?.startsWith(`${OPS_DIR}/`)) {
						await rm(worktreePath, { recursive: true, force: true });
					}
				} else {
					await git.removeWorktree(ctx.project, worktreePath
						? { ...ctx.sourceTask, worktreePath }
						: ctx.sourceTask);
				}
			}
			return {};
		case "deleteTaskRecord":
			await data.deleteTask(ctx.project, ctx.task.id);
			return {};
		case "persistColumn": {
			let updates: Partial<Task>;
			switch (effect.patch) {
				case "custom":
					updates = { customColumnId: effect.column.customColumnId };
					break;
				case "activation":
					updates = {
						status: effect.column.status,
						worktreePath: effect.worktreePath ?? ctx.task.worktreePath,
						branchName: effect.branchName ?? null,
						customColumnId: effect.column.customColumnId,
					};
					break;
				case "preparation":
					updates = {
						worktreePath: effect.worktreePath ?? ctx.task.worktreePath,
						branchName: effect.branchName ?? null,
						...clearedPreparationFields(),
					};
					break;
				case "status":
					updates = {
						status: effect.column.status,
						customColumnId: effect.column.customColumnId,
					};
					break;
				case "statusOnly":
					updates = { status: effect.column.status };
					break;
			}
			if (effect.runtime) {
				updates = { ...updates, ...preparationRuntimeUpdates(effect.runtime) };
			}
			const persisted = effect.patch === "preparation" || effect.writeOptions === "none"
				? await data.updateTask(ctx.project, ctx.task.id, updates)
				: await data.updateTask(ctx.project, ctx.task.id, updates, {
					dropPosition: ctx.dropPosition,
					...(effect.guards?.ifStatus ? { ifStatus: effect.guards.ifStatus } : {}),
					...(effect.guards?.ifStatusNot ? { ifStatusNot: effect.guards.ifStatusNot } : {}),
				});
			const accepted = persisted.status === effect.column.status
				&& (persisted.customColumnId ?? null) === effect.column.customColumnId;
			if (!accepted) {
				ctx.task = persisted;
				ctx.stateTask = persisted;
				return { stop: true };
			}
			ctx.task = taskAfterPersistedUpdate(ctx.task, persisted, updates);
			ctx.stateTask = ctx.task;
			return {};
		}
		case "persistTerminalTask": {
			const taskUpdates: Partial<Task> = {
				status: effect.status,
				customColumnId: null,
				...(ctx.project.kind === "virtual" ? {} : { worktreePath: null, branchName: null }),
				...(ctx.completedDiffStats ? { completedDiffStats: ctx.completedDiffStats } : {}),
				runtimeState: runtimeState({ phase: "idle" }),
				...clearedPreparationFields(),
			};
			const persisted = await data.updateTask(
				ctx.project,
				ctx.task.id,
				taskUpdates,
				{ dropPosition: ctx.dropPosition },
			);
			ctx.task = taskAfterPersistedUpdate(ctx.task, persisted, taskUpdates);
			ctx.stateTask = ctx.task;
			return {};
		}
		case "persistPreparationStage": {
			const stageUpdates: Partial<Task> = {
				preparing: true,
				preparingStage: effect.stage as PreparingStage,
				preparingProgress: getPreparingStageProgress(effect.stage as PreparingStage),
				runtimeState: {
					runtime: "preparing",
					stage: effect.stage,
					runId: effect.runId,
					updatedAt: Date.now(),
				},
			};
			const persisted = await data.updateTask(ctx.project, ctx.task.id, stageUpdates);
			ctx.task = taskAfterPersistedUpdate(ctx.task, persisted, stageUpdates);
			ctx.stateTask = ctx.task;
			return {};
		}
		case "persistPreparationFailure": {
			const failureUpdates: Partial<Task> = {
				status: "todo",
				...clearedPreparationFields(),
				worktreePath: null,
				branchName: null,
				customColumnId: null,
				preparationError: effect.error,
				runtimeState: runtimeState({ phase: "idle" }),
			};
			const persisted = await data.updateTask(ctx.project, ctx.task.id, failureUpdates);
			ctx.task = taskAfterPersistedUpdate(ctx.task, persisted, failureUpdates);
			ctx.stateTask = ctx.task;
			return {};
		}
		case "persistMergePrompt":
			{
				const updates: Partial<Task> = {
					mergeCompletionPrompt: {
						fingerprint: effect.fingerprint,
						promptedAt: effect.promptedAt ?? new Date().toISOString(),
						dismissedAt: null,
						precise: effect.precise,
					},
				};
				const persisted = await data.updateTask(ctx.project, ctx.task.id, updates);
				ctx.task = taskAfterPersistedUpdate(ctx.task, persisted, updates);
				ctx.stateTask = ctx.task;
			}
			return {};
		case "persistMergeDismissal": {
			const existing = ctx.task.mergeCompletionPrompt;
			ctx.task = await data.updateTask(ctx.project, ctx.task.id, {
				mergeCompletionPrompt: {
					fingerprint: effect.fingerprint,
					promptedAt: existing?.fingerprint === effect.fingerprint
						? existing.promptedAt
						: effect.dismissedAt,
					dismissedAt: effect.dismissedAt,
					precise: effect.precise,
				},
			});
			ctx.stateTask = ctx.task;
			return {};
		}
		case "persistPrStatus": {
			const payload = effect.payload as {
				prNumber?: number;
				prUrl?: string | null;
				cache?: Task["prStatusCache"];
			} | undefined;
			if (!payload) return {};
			if (payload.prNumber !== undefined || payload.prUrl !== undefined || payload.cache !== undefined) {
				ctx.task = await data.updateTask(ctx.project, ctx.task.id, {
					...(payload.prNumber !== undefined ? { prNumber: payload.prNumber } : {}),
					...(payload.prUrl !== undefined ? { prUrl: payload.prUrl } : {}),
					...(payload.cache !== undefined ? { prStatusCache: payload.cache } : {}),
				});
				ctx.stateTask = ctx.task;
			}
			return {};
		}
		case "launchColumnAgent":
			return launchColumnAgentEffect(ctx, effect.column);
		case "notifyStatusChange":
			notifyWatchedTaskStatusChange(ctx.task, effect.from, effect.to, ctx.project.name);
			return {};
		case "raisePrAttention":
			pushCliAttention({ taskId: ctx.task.id, reason: effect.reason });
			notifyWatchedTaskEvent(ctx.task, effect.reason, ctx.project.name);
			return {};
		case "emitTaskSound":
			emitTaskSound(effect.status, ctx.task.id);
			return {};
		case "push":
			pushEffect(effect, ctx);
			return {};
	}
}

export async function lifecycleDropPosition(): Promise<"top" | "bottom"> {
	return (await loadSettings()).taskDropPosition;
}
