import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import type {
	ColumnAgentConfig,
	CompletedDiffStats,
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
import { DEV3_HOME } from "../paths";
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

function isScratchPlaceholderDescription(description: string): boolean {
	return /^Scratch — \d{2}:\d{2}$/.test(description.trim());
}

function taskWithLaunchDescription(task: Task, forceBlank = false): Task {
	return forceBlank || isScratchPlaceholderDescription(task.description)
		? { ...task, description: "" }
		: task;
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
	getPushMessage()?.("taskSound", { status, taskId });
}

async function columnAgentConfig(
	project: Project,
	task: Task,
	column: LifecycleColumn,
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
	const customColumn = project.customColumns?.find((candidate) => candidate.id === column.customColumnId);
	if (!customColumn?.agentConfig) return null;
	return {
		config: customColumn.agentConfig,
		paneTitle: customColumn.name,
	};
}

async function launchColumnAgentEffect(
	ctx: LifecycleExecutionContext,
	column: LifecycleColumn,
): Promise<LifecycleEffectOutcome> {
	const configured = await columnAgentConfig(ctx.project, ctx.task, column);
	if (!configured) return {};
	try {
		await launchColumnAgent(ctx.project, ctx.task, configured.config, {
			paneTitle: configured.paneTitle,
			onExitCommand: configured.onExitCommand,
		});
		return {};
	} catch (error) {
		return {
			followUp: {
				type: "columnAgentFailed",
				columnName: configured.paneTitle,
				error: String(error),
			},
		};
	}
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
	const payload = effect.payload as { error?: string | null } | undefined;
	return {
		taskId: ctx.task.id,
		projectId: ctx.project.id,
		taskTitle: getTaskTitle(ctx.task),
		error: payload?.error ?? "Task preparation failed",
	};
}

function pushEffect(effect: Extract<LifecycleEffect, { type: "push" }>, ctx: LifecycleExecutionContext): void {
	const push = getPushMessage();
	if (!push) return;
	switch (effect.message) {
		case "taskUpdated":
			push("taskUpdated", {
				projectId: ctx.project.id,
				task: effect.view === "shuttingDown" ? { ...ctx.task, shuttingDown: true } : ctx.task,
			});
			return;
		case "taskPreparationFailed":
			push("taskPreparationFailed", preparationFailurePayload(ctx, effect));
			return;
		case "branchMerged": {
			const finding = effect.payload as Extract<LifecycleEvent, { type: "mergeDetected" }>;
			push("branchMerged", {
				taskId: ctx.sourceTask.id,
				projectId: ctx.project.id,
				taskTitle: ctx.sourceTask.customTitle || ctx.sourceTask.title,
				branchName: finding.branchName,
				fingerprint: finding.fingerprint,
				subject: buildTaskDialogSubject(ctx.sourceTask, ctx.project),
			});
			return;
		}
		case "taskPrStatus":
			push("taskPrStatus", effect.payload as never);
			return;
		case "columnAgentFailed": {
			const failure = effect.payload as Extract<LifecycleEvent, { type: "columnAgentFailed" }>;
			push("columnAgentFailed", {
				taskId: ctx.task.id,
				projectId: ctx.project.id,
				columnName: failure.columnName,
				error: failure.error,
			});
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
		case "persistRuntime":
			if (effect.runtime.phase === "tearing-down") {
				await data.updateTaskWith(ctx.project, ctx.task.id, () => ({
					updates: { runtimeState: runtimeState(effect.runtime) },
					result: null,
				}));
			} else {
				await data.updateTask(ctx.project, ctx.task.id, preparationRuntimeUpdates(effect.runtime));
			}
			ctx.stateTask = { ...ctx.task, ...preparationRuntimeUpdates(effect.runtime) };
			return {};
		case "prepareTask": {
			const work = async (): Promise<LifecycleEvent> => {
				try {
					const prepared = await prepareTask(ctx.project, ctx.task, effect, async (stage) => {
						const stageEvent: LifecycleEvent = {
							type: "preparationStageChanged",
							runId: effect.runId,
							stage,
						};
						if (effect.awaitCompletion) {
							await ctx.hooks.processInline(ctx.project.id, ctx.task.id, stageEvent, ctx.stateTask);
						} else {
							void ctx.hooks.dispatchFollowUp(ctx.project.id, ctx.task.id, stageEvent, ctx.stateTask).catch((error) => {
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
					};
				} catch (error) {
					return {
						type: "preparationFailed",
						runId: effect.runId,
						error: error instanceof Error ? error.message : String(error),
						origin: effect.origin,
						target: effect.target,
					};
				}
			};
			if (effect.awaitCompletion) return { followUp: await work() };
			void work().then((event) => ctx.hooks.dispatchFollowUp(ctx.project.id, ctx.task.id, event, ctx.stateTask)).catch((error) => {
				log.error("Detached preparation follow-up failed", { taskId: ctx.task.id.slice(0, 8), error: String(error) });
			});
			return {};
		}
		case "destroyTaskPty":
			pty.destroySession(ctx.task.id, ctx.task.tmuxSocket ?? undefined);
			return {};
		case "killDevServer":
			await killDevServerSession(
				ctx.task.id,
				ctx.task.tmuxSocket ?? DEFAULT_TMUX_SOCKET,
				ctx.task.worktreePath,
			);
			return {};
		case "runCleanupScript":
			await runCleanupScript(effect.allowDerivedPath && !ctx.task.worktreePath
				? { ...ctx.task, worktreePath: `${git.taskDir(ctx.project, ctx.task)}/worktree` }
				: ctx.task, ctx.project, {
				fromStatus: ctx.task.status,
				toStatus: effect.toStatus,
			});
			return {};
		case "captureCompletedDiffStats":
			ctx.completedDiffStats = await captureCompletedDiffStats(ctx.project, ctx.task);
			return {};
		case "removeWorktree":
			await git.removeWorktree(
				ctx.project,
				effect.allowDerivedPath && !ctx.task.worktreePath
					? { ...ctx.task, worktreePath: `${git.taskDir(ctx.project, ctx.task)}/worktree` }
					: ctx.task,
			);
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
			ctx.task = effect.patch === "preparation" || effect.writeOptions === "none"
				? await data.updateTask(ctx.project, ctx.task.id, updates)
				: await data.updateTask(ctx.project, ctx.task.id, updates, {
					dropPosition: ctx.dropPosition,
					...(effect.guards?.ifStatus ? { ifStatus: effect.guards.ifStatus } : {}),
					...(effect.guards?.ifStatusNot ? { ifStatusNot: effect.guards.ifStatusNot } : {}),
				});
			const accepted = ctx.task.status === effect.column.status
				&& (ctx.task.customColumnId ?? null) === effect.column.customColumnId;
			if (!accepted) return { stop: true };
			if (effect.runtime) {
				const runtimeUpdates = preparationRuntimeUpdates(effect.runtime);
				await data.updateTask(
					ctx.project,
					ctx.task.id,
					runtimeUpdates,
				);
			}
			return {};
		}
		case "persistTerminalTask": {
			ctx.task = await data.updateTask(ctx.project, ctx.task.id, {
				status: effect.status,
				customColumnId: null,
				...(ctx.project.kind === "virtual" ? {} : { worktreePath: null, branchName: null }),
				...(ctx.completedDiffStats ? { completedDiffStats: ctx.completedDiffStats } : {}),
			}, { dropPosition: ctx.dropPosition });
			const terminalRuntimeUpdates: Partial<Task> = {
				runtimeState: runtimeState({ phase: "idle" }),
				...clearedPreparationFields(),
			};
			await data.updateTask(ctx.project, ctx.task.id, terminalRuntimeUpdates);
			return {};
		}
		case "persistPreparationStage": {
			ctx.task = await data.updateTask(ctx.project, ctx.task.id, {
				preparing: true,
				preparingStage: effect.stage as PreparingStage,
				preparingProgress: getPreparingStageProgress(effect.stage as PreparingStage),
			});
			const stageRuntimeUpdates: Partial<Task> = {
				runtimeState: {
					runtime: "preparing",
					stage: effect.stage,
					runId: effect.runId,
					updatedAt: Date.now(),
				},
			};
			await data.updateTask(ctx.project, ctx.task.id, stageRuntimeUpdates);
			return {};
		}
		case "persistPreparationFailure": {
			ctx.task = await data.updateTask(ctx.project, ctx.task.id, {
				status: "todo",
				...clearedPreparationFields(),
				worktreePath: null,
				branchName: null,
				customColumnId: null,
				preparationError: effect.error,
			});
			const failureRuntimeUpdates: Partial<Task> = {
				runtimeState: runtimeState({ phase: "idle" }),
			};
			await data.updateTask(ctx.project, ctx.task.id, failureRuntimeUpdates);
			return {};
		}
		case "persistMergePrompt":
			ctx.task = await data.updateTask(ctx.project, ctx.task.id, {
				mergeCompletionPrompt: {
					fingerprint: effect.fingerprint,
					promptedAt: new Date().toISOString(),
					dismissedAt: null,
					precise: effect.precise,
				},
			});
			return {};
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
