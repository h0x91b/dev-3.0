import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import type { ColumnAgentConfig, CustomColumn, PreparingStage, Project, Task, TaskStatus } from "../../shared/types";
import { ACTIVE_STATUSES, DEFAULT_REVIEW_PROMPT, getPreparingStageProgress, getTaskTitle, isStatusGuardBlocked, titleFromDescription } from "../../shared/types";
import * as data from "../data";
import * as git from "../git";
import * as pty from "../pty-server";
import * as portPool from "../port-pool";
import * as repoConfig from "../repo-config";
import { clonePaths } from "../cow-clone";
import { resolveCompletionRequest } from "../completion-requests";
import { DEV3_HOME, OPS_DIR } from "../paths";
import {
	assertTaskPreparationActive,
	forgetTaskPreparation,
	getTaskPreparationSnapshot,
	isTaskPreparationActive,
	markTaskPreparationCancelled,
	reportCurrentPreparationStage,
	TaskPreparationCancelledError,
	withTaskPreparation,
} from "../preparation-runtime";
import { loadSettings, loadSettingsSync } from "../settings";
import { getUserShell } from "../shell-env";
import { spawn } from "../spawn";
import { buildScriptRunnerCommand, buildTaskLifecycleEnv, getPushMessage, isActive, log, notifyWatchedTaskStatusChange } from "./shared";
import { clearMergeNotification, cleanupTaskGitState } from "./git-operations";
import { resolveOperationalProjectConfig } from "./settings-config";
import { cleanupTaskTmuxState, killDevServerSession, launchColumnAgent, launchTaskPty } from "./tmux-pty";

function cleanupTaskState(taskId: string): void {
	cleanupTaskTmuxState(taskId);
	cleanupTaskGitState(taskId);
}

async function runCowClones(project: Project, worktreePath: string): Promise<void> {
	if (!project.clonePaths?.length) return;
	await clonePaths(project.path, worktreePath, project.clonePaths);
}

async function clearPreparingTasks(project: Project, tasks: Task[]): Promise<void> {
	for (const task of tasks) {
		try {
			const updated = await data.updateTask(project, task.id, clearPreparingState());
			getPushMessage()?.("taskUpdated", { projectId: project.id, task: updated });
		} catch {
			// Best effort — do not crash background preparation cleanup.
		}
	}
}

function preparingResetUpdates(): Partial<Task> {
	return {
		status: "todo",
		preparing: false,
		preparingStage: null,
		preparingProgress: null,
		preparingStartedAt: null,
		worktreePath: null,
		branchName: null,
		customColumnId: null,
	};
}

const INITIAL_PREPARING_STAGE: PreparingStage = "resolving-config";

function clearPreparingState(): Pick<Task, "preparing" | "preparingStage" | "preparingProgress" | "preparingStartedAt"> {
	return {
		preparing: false,
		preparingStage: null,
		preparingProgress: null,
		preparingStartedAt: null,
	};
}

function preparingStageUpdates(stage: PreparingStage): Pick<Task, "preparing" | "preparingStage" | "preparingProgress"> {
	return {
		preparing: true,
		preparingStage: stage,
		preparingProgress: getPreparingStageProgress(stage),
	};
}

async function pushPreparingStage(project: Project, taskId: string, stage: PreparingStage): Promise<void> {
	const updated = await data.updateTask(project, taskId, preparingStageUpdates(stage));
	getPushMessage()?.("taskUpdated", { projectId: project.id, task: updated });
}

async function killTrackedPreparationProcesses(taskId: string, pids: number[]): Promise<void> {
	for (const pid of pids) {
		try {
			log.warn("Killing preparation process", {
				taskId: taskId.slice(0, 8),
				pid,
				signal: "SIGKILL",
			});
			const proc = spawn(["kill", "-9", String(pid)], { stdout: "pipe", stderr: "pipe" });
			const code = await proc.exited;
			if (code !== 0) {
				log.warn("kill -9 exited non-zero for preparation process", {
					taskId: taskId.slice(0, 8),
					pid,
					code,
				});
			}
		} catch (err) {
			log.warn("kill -9 failed for preparation process", {
				taskId: taskId.slice(0, 8),
				pid,
				error: String(err),
			});
		}
	}
}

async function revertPreparingTaskToTodo(project: Project, task: Task): Promise<Task> {
	cleanupTaskState(task.id);
	portPool.releasePorts(task.id);

	try {
		pty.destroySession(task.id, task.tmuxSocket ?? undefined);
	} catch (err) {
		log.warn("destroySession failed while cancelling preparation", {
			taskId: task.id.slice(0, 8),
			error: String(err),
		});
	}

	killDevServerSession(task.id, task.tmuxSocket ?? pty.DEFAULT_TMUX_SOCKET).catch((err) => {
		log.warn("killDevServerSession failed while cancelling preparation", {
			taskId: task.id.slice(0, 8),
			error: String(err),
		});
	});

	// Virtual (Operations) tasks have no git worktree — the work dir is a managed
	// temp folder (or a user-chosen one we must never force-remove). Skip the git
	// worktree teardown entirely; only git projects own a removable worktree.
	if (project.kind !== "virtual") {
		const cleanupTask: Task = {
			...task,
			worktreePath: task.worktreePath ?? `${git.taskDir(project, task)}/worktree`,
		};

		// Preparation may already have run the setup script (e.g. brought up a
		// per-worktree dev container), so give the cleanup hook a chance to tear
		// that down before the worktree disappears. Best-effort: the worktree may
		// be half-created and runCleanupScript skips it when missing.
		try {
			await runCleanupScript(cleanupTask, project, {
				fromStatus: task.status,
				toStatus: "todo",
			});
		} catch (err) {
			log.warn("Cleanup script failed while cancelling preparation", {
				taskId: task.id.slice(0, 8),
				error: String(err),
			});
		}

		try {
			await git.removeWorktree(project, cleanupTask);
		} catch (err) {
			log.warn("removeWorktree failed while cancelling preparation", {
				taskId: task.id.slice(0, 8),
				worktreePath: cleanupTask.worktreePath,
				error: String(err),
			});
		}
	}

	const updated = await data.updateTask(project, task.id, preparingResetUpdates());
	getPushMessage()?.("taskUpdated", { projectId: project.id, task: updated });
	return updated;
}

async function measurePreparationStep<T>(
	task: Task,
	runId: string,
	step: string,
	fn: () => Promise<T>,
	stage?: PreparingStage,
	extra?: Record<string, unknown>,
): Promise<T> {
	assertTaskPreparationActive(task.id, runId);
	if (stage) {
		await reportCurrentPreparationStage(stage);
	}
	const startedAt = performance.now();
	log.info("Preparing step started", {
		taskId: task.id.slice(0, 8),
		runId,
		step,
		...(extra ?? {}),
	});
	try {
		const result = await fn();
		const durationMs = Math.round(performance.now() - startedAt);
		log.info("Preparing step finished", {
			taskId: task.id.slice(0, 8),
			runId,
			step,
			durationMs,
			...(extra ?? {}),
		});
		assertTaskPreparationActive(task.id, runId);
		return result;
	} catch (err) {
		const durationMs = Math.round(performance.now() - startedAt);
		const logFn = err instanceof TaskPreparationCancelledError ? log.warn : log.error;
		logFn("Preparing step failed", {
			taskId: task.id.slice(0, 8),
			runId,
			step,
			durationMs,
			error: String(err),
			...(extra ?? {}),
		});
		throw err;
	}
}

async function prepareTaskInBackground(
	project: Project,
	task: Task,
	options: {
		label: string;
		agentId: string | null;
		configId: string | null;
		existingBranch?: string;
		variantBranchName?: string;
	},
): Promise<void> {
	await withTaskPreparation(task.id, options.label, async (runId) => {
		try {
			// Virtual ("Operations") projects have no git repo: skip the entire
			// worktree / sparse / CoW pipeline and launch the agent + split shell
			// in a managed (or user-chosen) folder. Reuses the same preparation
			// stage + cancellation machinery so the card progress bar and the
			// revert-on-failure path keep working.
			if (project.kind === "virtual") {
				const workDir = task.opsWorkDir?.trim() || git.virtualWorkDir(project, task);
				await measurePreparationStep(
					task,
					runId,
					"createOpsWorkDir",
					() => mkdir(workDir, { recursive: true }),
					"creating-worktree",
					{ opsWorkDir: task.opsWorkDir ?? null },
				);
				const taskForVirtualLaunch = task.scratch ? { ...task, description: "" } : task;
				await measurePreparationStep(
					task,
					runId,
					"launchTaskPty",
					() => launchTaskPty(project, taskForVirtualLaunch, workDir, options.agentId, options.configId, true),
					"launching-pty",
				);

				assertTaskPreparationActive(task.id, runId);
				const updatedVirtual = await data.updateTask(project, task.id, {
					worktreePath: workDir,
					branchName: null,
					...clearPreparingState(),
				});

				if (!isTaskPreparationActive(task.id, runId)) {
					log.warn("Preparation completed after cancellation; reverting task", {
						taskId: task.id.slice(0, 8),
						runId,
					});
					await revertPreparingTaskToTodo(project, task);
					return;
				}

				getPushMessage()?.("taskUpdated", { projectId: project.id, task: updatedVirtual });
				log.info("Virtual task preparation ready", {
					taskId: task.id.slice(0, 8),
					runId,
					worktreePath: workDir,
				});
				return;
			}

			const resolvedProject = await measurePreparationStep(
				task,
				runId,
				"resolveProjectConfig",
				() => repoConfig.resolveProjectConfig(project),
				"resolving-config",
			);
			const wt = await measurePreparationStep(
				task,
				runId,
				"createWorktree",
				() => git.createWorktree(
					resolvedProject,
					task,
					options.existingBranch ?? undefined,
					options.variantBranchName,
				),
				"creating-worktree",
				{
					existingBranch: options.existingBranch ?? null,
					variantBranchName: options.variantBranchName ?? null,
				},
			);
			const resolved = await measurePreparationStep(
				task,
				runId,
				"resolveOperationalProjectConfig",
				() => resolveOperationalProjectConfig(resolvedProject, wt.worktreePath),
				"resolving-config",
				{ worktreePath: wt.worktreePath },
			);

			if (resolved.sparseCheckoutEnabled && resolved.sparseCheckoutPaths?.length) {
				await measurePreparationStep(
					task,
					runId,
					"applySparseCheckout",
					() => git.applySparseCheckout(wt.worktreePath, resolved.sparseCheckoutPaths!),
					"applying-sparse-checkout",
					{ pathCount: resolved.sparseCheckoutPaths.length },
				);
			} else {
				log.info("Preparing step skipped", {
					taskId: task.id.slice(0, 8),
					runId,
					step: "applySparseCheckout",
					enabled: resolved.sparseCheckoutEnabled,
					pathCount: resolved.sparseCheckoutPaths?.length ?? 0,
				});
			}

			await measurePreparationStep(
				task,
				runId,
				"runCowClones",
				() => runCowClones(resolved, wt.worktreePath),
				"cloning-shared-paths",
			);
			// Scratch tasks carry a placeholder `description` used only to
			// derive the card title. At launch time we blank it so the agent
			// receives an empty prompt (same mechanism as the reopen path in
			// activateTask).
			const taskForLaunch = task.scratch ? { ...task, description: "" } : task;
			await measurePreparationStep(
				task,
				runId,
				"launchTaskPty",
				() => launchTaskPty(
					resolved,
					taskForLaunch,
					wt.worktreePath,
					options.agentId,
					options.configId,
					true,
					false,
					{ branchName: wt.branchName },
				),
				"launching-pty",
			);

			assertTaskPreparationActive(task.id, runId);
			const updated = await data.updateTask(project, task.id, {
				worktreePath: wt.worktreePath,
				branchName: wt.branchName,
				...clearPreparingState(),
			});

			if (!isTaskPreparationActive(task.id, runId)) {
				log.warn("Preparation completed after cancellation; reverting task", {
					taskId: task.id.slice(0, 8),
					runId,
				});
				await revertPreparingTaskToTodo(project, task);
				return;
			}

			getPushMessage()?.("taskUpdated", { projectId: project.id, task: updated });
			log.info("Task preparation ready", {
				taskId: task.id.slice(0, 8),
				runId,
				worktreePath: wt.worktreePath,
			});
		} catch (err) {
			if (err instanceof TaskPreparationCancelledError) {
				log.warn("Task preparation stopped after cancellation", {
					taskId: task.id.slice(0, 8),
					runId,
					label: options.label,
				});
				return;
			}

			log.error("Failed to prepare task", {
				taskId: task.id,
				runId,
				label: options.label,
				error: String(err),
			});
			try {
				if (isTaskPreparationActive(task.id, runId)) {
					// Don't strand the task in its active column with no worktree and no
					// PTY — that surfaces as a misleading "[session ended]" terminal and
					// survives app restarts. Move it back to todo (cleaning up any
					// half-created worktree) so it is recoverable, and surface the real
					// preparation error to the renderer as a toast.
					const reverted = await revertPreparingTaskToTodo(project, task);
					getPushMessage()?.("taskPreparationFailed", {
						taskId: task.id,
						projectId: project.id,
						taskTitle: getTaskTitle(reverted),
						error: err instanceof Error ? err.message : String(err),
					});
				}
			} catch (revertErr) {
				log.error("Failed to revert task after preparation failure", {
					taskId: task.id.slice(0, 8),
					runId,
					error: String(revertErr),
				});
			}
		}
	}, (stage) => pushPreparingStage(project, task.id, stage));
}

export async function activateTask(
	project: Project,
	task: Task,
	opts?: { isReopen?: boolean },
): Promise<{ worktreePath: string; branchName: string | null }> {
	const isReopen = opts?.isReopen ?? false;
	if (project.kind === "virtual") {
		return activateVirtualTask(project, task, isReopen);
	}
	const preResolved = await repoConfig.resolveProjectConfig(project);
	const wt = await git.createWorktree(preResolved, task, task.existingBranch ?? undefined);
	const resolved = await resolveOperationalProjectConfig(project, wt.worktreePath);
	if (resolved.sparseCheckoutEnabled && resolved.sparseCheckoutPaths?.length) {
		log.info("activateTask: applying sparse checkout", { worktreePath: wt.worktreePath, paths: resolved.sparseCheckoutPaths });
		await git.applySparseCheckout(wt.worktreePath, resolved.sparseCheckoutPaths);
	} else {
		log.info("activateTask: sparse checkout disabled or no paths", { enabled: resolved.sparseCheckoutEnabled, pathCount: resolved.sparseCheckoutPaths?.length ?? 0 });
	}
	await runCowClones(resolved, wt.worktreePath);
	// Blank the description so the agent starts in a clean session instead of
	// being handed a prompt, in two cases:
	//   - reopen (completed/cancelled → active): don't replay the original prompt.
	//     Original intent: commit a2b87778 ("Skip task prompt when reopening …").
	//   - scratch tasks: `description` is only a `Scratch — HH:mm` placeholder used
	//     for the card title, never a real instruction. Direct launches land here
	//     (not just the prepareTaskInBackground / Launch Variants flow), so we must
	//     blank it here too — otherwise the placeholder is sent as the prompt.
	const taskForLaunch = isReopen || task.scratch ? { ...task, description: "" } : task;
	await launchTaskPty(resolved, taskForLaunch, wt.worktreePath, task.agentId, task.configId, true, isReopen, { branchName: wt.branchName });
	return { worktreePath: wt.worktreePath, branchName: wt.branchName };
}

/**
 * Activate a virtual ("Operations") task: create/resolve the working dir, then
 * launch the agent + a split-right shell (handled in launchTaskPty). No git
 * worktree, branch, sparse-checkout, cow-clones, or config merge.
 *
 * Working dir is the user-chosen fixed folder (`task.opsWorkDir`) if set,
 * otherwise a managed temp dir under `~/.dev3.0/ops/<slug>/<taskId>/work`.
 * `worktreePath` is reused to hold it (Runtime affordances key off it); the git
 * domain is hidden in the UI by `kind` guards.
 */
async function activateVirtualTask(
	project: Project,
	task: Task,
	isReopen: boolean,
): Promise<{ worktreePath: string; branchName: null }> {
	const fixed = task.opsWorkDir?.trim();
	const workDir = fixed || git.virtualWorkDir(project, task);
	await mkdir(workDir, { recursive: true });
	log.info("Activating virtual task", { taskId: task.id.slice(0, 8), workDir, fixed: !!fixed });
	// Scratch/reopen → blank prompt so the agent idles (the shell pane is usable).
	const taskForLaunch = isReopen || task.scratch ? { ...task, description: "" } : task;
	await launchTaskPty(project, taskForLaunch, workDir, task.agentId, task.configId, true, isReopen);
	return { worktreePath: workDir, branchName: null };
}

function scratchPlaceholder(now: Date = new Date()): string {
	const hh = String(now.getHours()).padStart(2, "0");
	const mm = String(now.getMinutes()).padStart(2, "0");
	return `Scratch — ${hh}:${mm}`;
}

export async function handleBellAutoStatus(taskId: string): Promise<void> {
	try {
		const projects = [...await data.loadProjects(), ...await data.loadVirtualProjects()];
		for (const project of projects) {
			const tasks = await data.loadTasks(project);
			const task = tasks.find((candidate) => candidate.id === taskId);
			if (!task) continue;
			if (task.status !== "in-progress") return;

			log.info("Bell auto-transition: in-progress → user-questions", { taskId: taskId.slice(0, 8) });
			const bellSettings = await loadSettings();
			const updated = await data.updateTask(project, task.id, { status: "user-questions" }, { dropPosition: bellSettings.taskDropPosition });
			getPushMessage()?.("taskUpdated", { projectId: project.id, task: updated });
			return;
		}
	} catch (err) {
		log.error("handleBellAutoStatus failed", { taskId: taskId.slice(0, 8), error: String(err) });
	}
}

export async function isTaskInProgress(taskId: string): Promise<boolean> {
	try {
		const projects = [...await data.loadProjects(), ...await data.loadVirtualProjects()];
		for (const project of projects) {
			const tasks = await data.loadTasks(project);
			const task = tasks.find((candidate) => candidate.id === taskId);
			if (task) return task.status === "in-progress";
		}
	} catch (err) {
		log.error("isTaskInProgress failed", { taskId: taskId.slice(0, 8), error: String(err) });
	}
	return false;
}

const DEFAULT_CLEANUP_SCRIPT = 'echo "Task finished"';

type CleanupTransition = {
	fromStatus: TaskStatus;
	// Beyond board statuses, the cleanup hook also fires when the worktree is
	// destroyed outside a column move: "deleted" (task deleted while active)
	// and "todo" (task preparation cancelled, task reverted to To Do).
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
	if (!task.worktreePath) return;

	// Use existsSync, not Bun.file(...).exists(): the latter always returns
	// false for directories.
	if (!existsSync(task.worktreePath)) {
		log.warn("Skipping cleanup script — worktree directory missing", {
			worktreePath: task.worktreePath,
			taskId: task.id,
		});
		return;
	}

	const resolved = await resolveOperationalProjectConfig(project, task.worktreePath);
	const script = resolved.cleanupScript?.trim() || DEFAULT_CLEANUP_SCRIPT;
	const scriptPath = `/tmp/dev3-${task.id}-cleanup.sh`;
	const sessionName = `dev3-cl-${task.id.slice(0, 8)}`;
	const userShell = getUserShell();

	await Bun.write(scriptPath, `#!/bin/bash\n${script}\n`);

	log.info("Starting cleanup tmux session", { session: sessionName, worktreePath: task.worktreePath });

	const cleanupSocket = task.tmuxSocket ?? pty.DEFAULT_TMUX_SOCKET;
	// Pass env vars via `-e KEY=VAL` so they land in session-environment
	// atomically. Without this, the tmux server's global env (from whichever
	// task started the server) leaks in — DEV3_TASK_ID from task A would
	// run task B's cleanup script against the wrong worktree/container.
	const cleanupEnvFlags: string[] = [];
	for (const [key, value] of Object.entries(buildCleanupScriptEnv(task, project, transition))) {
		cleanupEnvFlags.push("-e", `${key}=${value}`);
	}
	const cleanupArgs = pty.tmuxArgs(cleanupSocket, "-f", pty.TMUX_CONF_PATH, "new-session", "-s", sessionName, ...cleanupEnvFlags, "-c", task.worktreePath, buildScriptRunnerCommand(scriptPath, { shellPath: userShell }));
	const proc = spawn(
		cleanupArgs,
		{
			terminal: { cols: 220, rows: 50, data: () => {} },
			env: buildCleanupScriptEnv(task, project, transition),
			cwd: task.worktreePath,
		},
	);

	await proc.exited;

	log.info("Cleanup session finished", { session: sessionName });
}

export function emitTaskSound(status: "completed" | "cancelled", taskId: string): void {
	const settings = loadSettingsSync();
	if (settings.playSoundOnTaskComplete === false) return;
	getPushMessage()?.("taskSound", { status, taskId });
}

export async function triggerColumnAgentIfNeeded(
	newStatus: TaskStatus,
	project: Project,
	task: Task,
	options?: { customColumn?: CustomColumn },
): Promise<void> {
	if (!task.worktreePath) return;

	let agentConfig: ColumnAgentConfig | undefined;
	let paneTitle = "";
	let onExitCommand: string | undefined;

	if (newStatus === "review-by-ai") {
		const resolved = await repoConfig.resolveProjectConfig(project, task.worktreePath);
		if (resolved.builtinColumnAgents && !resolved.builtinColumnAgents["review-by-ai"]) {
			return;
		}
		const config = resolved.builtinColumnAgents?.["review-by-ai"];
		agentConfig = {
			agentId: config?.agentId || "builtin-claude",
			configId: config?.configId || "claude-bypass-sonnet",
			prompt: config?.prompt || DEFAULT_REVIEW_PROMPT,
		};
		paneTitle = "AI Review";
		onExitCommand = `${DEV3_HOME}/bin/dev3 task move ${task.id} --status review-by-user --if-status review-by-ai`;
	} else if (options?.customColumn?.agentConfig) {
		agentConfig = options.customColumn.agentConfig;
		paneTitle = options.customColumn.name;
	}

	if (!agentConfig) return;

	try {
		await launchColumnAgent(project, task, agentConfig, { paneTitle, onExitCommand });
	} catch (err) {
		log.error("launchColumnAgent failed", {
			taskId: task.id,
			status: newStatus,
			error: String(err),
		});
		if (newStatus === "review-by-ai") {
			try {
				const fallback = await data.updateTask(project, task.id, { status: "review-by-user" });
				getPushMessage()?.("taskUpdated", { projectId: project.id, task: fallback });
			} catch (fallbackErr) {
				log.error("Failed to fall back to review-by-user", { taskId: task.id, error: String(fallbackErr) });
			}
			return;
		}
		// Custom columns (and any other non-built-in status) have no automatic
		// fallback — the task would otherwise sit silently with no running agent.
		// Surface the failure to the user so they can re-launch or fix the config.
		getPushMessage()?.("columnAgentFailed", {
			taskId: task.id,
			projectId: project.id,
			columnName: paneTitle || String(newStatus),
			error: String(err),
		});
	}
}

async function getTasks(params: { projectId: string }): Promise<Task[]> {
	log.info("→ getTasks", params);
	const project = await data.getProject(params.projectId);
	const tasks = await data.loadTasks(project);
	log.info(`← getTasks: ${tasks.length} task(s)`);
	return tasks;
}

async function getAllProjectTasks(): Promise<{ projectId: string; tasks: Task[] }[]> {
	log.info("→ getAllProjectTasks");
	// Include virtual ("Operations") boards — otherwise the dashboard shows no
	// active operations and the working-folder conflict check (which compares
	// against active operations) never fires.
	const projects = [...await data.loadProjects(), ...await data.loadVirtualProjects()];
	const results = await Promise.all(
		projects.map(async (project) => {
			const tasks = await data.loadTasks(project);
			const active = tasks.filter((task) => ACTIVE_STATUSES.includes(task.status));
			return { projectId: project.id, tasks: active };
		}),
	);
	const totalActive = results.reduce((sum, result) => sum + result.tasks.length, 0);
	log.info(`← getAllProjectTasks: ${totalActive} active task(s) across ${projects.length} project(s)`);
	return results;
}

async function createTask(params: { projectId: string; description: string; status?: TaskStatus; existingBranch?: string; scratch?: boolean; opsWorkDir?: string }): Promise<Task> {
	log.info("→ createTask", params);
	const project = await data.getProject(params.projectId);
	const isScratch = params.scratch === true;
	// Scratch tasks always start in "todo" with a placeholder title so the
	// Launch Variants modal can open and let the user pick the agent before
	// anything is actually spawned. The `scratch: true` flag is persisted so
	// that when spawnVariants / prepareTaskInBackground eventually launch the
	// agent, the prompt is blanked (the placeholder is NOT sent to the agent).
	const status = isScratch ? "todo" : (params.status || "todo");
	const description = isScratch ? scratchPlaceholder() : params.description;
	const extras: Parameters<typeof data.addTask>[3] = {
		...(params.existingBranch ? { existingBranch: params.existingBranch } : {}),
		...(isScratch ? { scratch: true } : {}),
		...(params.opsWorkDir ? { opsWorkDir: params.opsWorkDir } : {}),
	};
	const task = await data.addTask(project, description, status, Object.keys(extras).length ? extras : undefined);

	if (isActive(status)) {
		log.info("Created into active status, creating worktree + PTY", { taskId: task.id });
		const wt = await activateTask(project, task);

		const updated = await data.updateTask(project, task.id, {
			worktreePath: wt.worktreePath,
			branchName: wt.branchName,
		});
		getPushMessage()?.("taskUpdated", { projectId: project.id, task: updated });
		log.info("← createTask (with worktree)", { taskId: task.id });
		return updated;
	}

	log.info("← createTask", { taskId: task.id });
	return task;
}

function getSourceTaskBranch(task: Task, project: Project): string | undefined {
	if (task.existingBranch) {
		return task.existingBranch;
	}

	const projectBaseBranch = project.defaultBaseBranch || "main";
	if (task.baseBranch && task.baseBranch !== projectBaseBranch) {
		return task.baseBranch;
	}

	return undefined;
}

export async function moveTask(params: {
	taskId: string;
	projectId: string;
	newStatus: TaskStatus;
	force?: boolean;
	ifStatus?: string;
	ifStatusNot?: string;
}): Promise<Task> {
	log.info("→ moveTask", params);
	const project = await data.getProject(params.projectId);
	const task = await data.getTask(project, params.taskId);
	const oldStatus = task.status;
	const newStatus = params.newStatus;
	const settings = await loadSettings();
	const guardOpts = {
		...(params.ifStatus ? { ifStatus: params.ifStatus } : {}),
		...(params.ifStatusNot ? { ifStatusNot: params.ifStatusNot } : {}),
	};
	const dropOpts = { dropPosition: settings.taskDropPosition, ...guardOpts } as const;

	log.info(`Moving task ${oldStatus} → ${newStatus}`, { taskId: task.id, force: !!params.force });

	clearMergeNotification(task.id);

	if (!isActive(oldStatus) && isActive(newStatus)) {
		// Pre-check the move guard before activateTask so a blocked move does not
		// leak a worktree/PTY. The authoritative check still runs inside the lock.
		if (isStatusGuardBlocked(oldStatus, guardOpts)) {
			log.info("Move guard blocked inactive → active; skipping activateTask", { taskId: task.id, oldStatus });
			return task;
		}
		const isReopen = oldStatus === "completed" || oldStatus === "cancelled";
		log.info("Transition: inactive → active, creating worktree + PTY", { isReopen });
		const wt = await activateTask(project, task, { isReopen });

		const updated = await data.updateTask(project, task.id, {
			status: newStatus,
			worktreePath: wt.worktreePath,
			branchName: wt.branchName,
			customColumnId: null,
		}, dropOpts);
		getPushMessage()?.("taskUpdated", { projectId: project.id, task: updated });
		notifyWatchedTaskStatusChange(updated, oldStatus, newStatus, project.name);
		log.info("← moveTask done (worktree created)", { taskId: task.id });
		return updated;
	}

	if (newStatus === "completed" || newStatus === "cancelled") {
		cleanupTaskState(task.id);
		portPool.releasePorts(task.id);
		emitTaskSound(newStatus as "completed" | "cancelled", task.id);
		if (params.force) {
			log.info("Force mode: skipping PTY/cleanup/worktree", { taskId: task.id });
		} else if (isActive(oldStatus) || task.worktreePath) {
			log.info("Transition → terminal, cleaning up PTY + worktree", {
				oldStatus,
				hasWorktree: !!task.worktreePath,
			});
			try {
				pty.destroySession(task.id, task.tmuxSocket ?? undefined);
			} catch (err) {
				log.error("destroySession failed, continuing with task move", {
					taskId: task.id,
					error: String(err),
				});
			}

			killDevServerSession(task.id, task.tmuxSocket ?? pty.DEFAULT_TMUX_SOCKET).catch((err) => {
				log.warn("killDevServerSession on task move failed (best-effort)", {
					taskId: task.id.slice(0, 8), error: String(err),
				});
			});

			try {
				log.info("Running cleanup script before removing worktree", { taskId: task.id });
				await runCleanupScript(task, project, {
					fromStatus: oldStatus,
					toStatus: newStatus,
				});
			} catch (err) {
				log.error("Cleanup script failed, continuing with task move", {
					taskId: task.id,
					error: String(err),
				});
			}

			// Virtual ops keep their working dir as history — removed only on task
			// delete. Git tasks tear down the worktree here.
			if (project.kind !== "virtual") {
				try {
					await git.removeWorktree(project, task);
				} catch (err) {
					log.error("removeWorktree failed, continuing with task move", {
						taskId: task.id,
						error: String(err),
					});
				}
			}
		}

		const updated = await data.updateTask(project, task.id, {
			status: newStatus,
			// Keep worktreePath for virtual ops so the history dir stays referenced
			// (and deleteTask can clean it up). Git tasks clear it (worktree gone).
			...(project.kind === "virtual" ? {} : { worktreePath: null, branchName: null }),
			customColumnId: null,
		}, dropOpts);
		getPushMessage()?.("taskUpdated", { projectId: project.id, task: updated });
		notifyWatchedTaskStatusChange(updated, oldStatus, newStatus, project.name);
		log.info("← moveTask done (worktree destroyed)", { taskId: task.id });
		return updated;
	}

	const updated = await data.updateTask(project, task.id, {
		status: newStatus,
		customColumnId: null,
	}, dropOpts);
	getPushMessage()?.("taskUpdated", { projectId: project.id, task: updated });
	notifyWatchedTaskStatusChange(updated, oldStatus, newStatus, project.name);

	await triggerColumnAgentIfNeeded(newStatus, project, updated);

	log.info("← moveTask done (status only)", { taskId: task.id });
	return updated;
}

async function cancelTaskPreparation(params: { taskId: string; projectId: string }): Promise<Task> {
	log.info("→ cancelTaskPreparation", params);
	const project = await data.getProject(params.projectId);
	const task = await data.getTask(project, params.taskId);
	const snapshot = getTaskPreparationSnapshot(task.id);

	if (task.preparing !== true && !snapshot) {
		log.info("cancelTaskPreparation skipped — task is not preparing", {
			taskId: task.id.slice(0, 8),
		});
		return task;
	}

	const { runId, pids } = markTaskPreparationCancelled(task.id);
	const killList = pids.length > 0 ? pids : (snapshot?.pids ?? []);
	await killTrackedPreparationProcesses(task.id, killList);
	const updated = await revertPreparingTaskToTodo(project, task);
	if (runId) {
		forgetTaskPreparation(task.id, runId);
	}
	log.info("← cancelTaskPreparation done", {
		taskId: task.id.slice(0, 8),
		killed: killList.length,
	});
	return updated;
}

async function reorderTask(params: { taskId: string; projectId: string; targetIndex: number }): Promise<Task[]> {
	log.info("→ reorderTask", params);
	const project = await data.getProject(params.projectId);
	const updatedColumnTasks = await data.reorderTasksInColumn(project, params.taskId, params.targetIndex);
	for (const task of updatedColumnTasks) {
		getPushMessage()?.("taskUpdated", { projectId: project.id, task });
	}
	log.info("← reorderTask done", { count: updatedColumnTasks.length });
	return updatedColumnTasks;
}

async function deleteTask(params: { taskId: string; projectId: string }): Promise<void> {
	log.info("→ deleteTask", params);
	const project = await data.getProject(params.projectId);
	const task = await data.getTask(project, params.taskId);
	cleanupTaskState(task.id);
	portPool.releasePorts(task.id);

	try {
		pty.destroySession(task.id, task.tmuxSocket ?? undefined);
	} catch (err) {
		log.warn("destroySession failed in deleteTask (best-effort)", { taskId: task.id.slice(0, 8), error: String(err) });
	}

	if (isActive(task.status) || task.worktreePath) {
		killDevServerSession(task.id, task.tmuxSocket ?? pty.DEFAULT_TMUX_SOCKET).catch((err) => {
			log.warn("killDevServerSession on task delete failed (best-effort)", {
				taskId: task.id.slice(0, 8), error: String(err),
			});
		});

		// Deleting an active task destroys its worktree/work dir just like moving
		// it to completed/cancelled does — run the same teardown hook so
		// per-worktree resources (dev containers, exports, caches) don't leak.
		try {
			await runCleanupScript(task, project, {
				fromStatus: task.status,
				toStatus: "deleted",
			});
		} catch (err) {
			log.error("Cleanup script failed, continuing with task delete", {
				taskId: task.id,
				error: String(err),
			});
		}

		if (project.kind === "virtual") {
			// SAFETY: only ever remove a MANAGED dir (under ~/.dev3.0/ops/). A
			// user-chosen fixed folder (e.g. ~ or ~/Downloads) is NEVER auto-removed.
			const dir = task.worktreePath;
			if (dir && dir.startsWith(`${OPS_DIR}/`)) {
				log.info("Removing managed virtual work dir on delete", { dir });
				await rm(dir, { recursive: true, force: true }).catch((err) => {
					log.warn("Failed to remove virtual work dir (best-effort)", { dir, error: String(err) });
				});
			} else {
				log.info("Virtual task uses a fixed folder; not removing on delete", { dir });
			}
		} else {
			log.info("Task has worktree, cleaning up", { status: task.status, worktreePath: task.worktreePath });
			await git.removeWorktree(project, task);
		}
	}

	await data.deleteTask(project, task.id);
	log.info("← deleteTask done");
}

async function spawnVariants(params: {
	taskId: string;
	projectId: string;
	targetStatus: TaskStatus;
	variants: Array<{ agentId: string | null; configId: string | null }>;
}): Promise<Task[]> {
	log.info("→ spawnVariants", { taskId: params.taskId, count: params.variants.length });
	const project = await data.getProject(params.projectId);
	const sourceTask = await data.getTask(project, params.taskId);

	if (sourceTask.status !== "todo") {
		throw new Error(`Task must be in todo status to spawn variants (got ${sourceTask.status})`);
	}

	const groupId = crypto.randomUUID();
	const sharedSeq = sourceTask.seq;
	const resultTasks: Task[] = [];
	const srcBranch = getSourceTaskBranch(sourceTask, project);
	const isMultiVariant = params.variants.length > 1;
	const needsWorktree = isActive(params.targetStatus);

	for (let i = 0; i < params.variants.length; i++) {
		const variant = params.variants[i];

		const task = await data.addTask(
			project,
			sourceTask.description,
			params.targetStatus,
			{
				groupId,
				variantIndex: i + 1,
				agentId: variant.agentId,
				configId: variant.configId,
				seq: sharedSeq,
				existingBranch: srcBranch,
				preparing: needsWorktree,
				preparingStage: needsWorktree ? INITIAL_PREPARING_STAGE : null,
				preparingProgress: needsWorktree ? getPreparingStageProgress(INITIAL_PREPARING_STAGE) : null,
				preparingStartedAt: needsWorktree ? new Date().toISOString() : null,
				watched: sourceTask.watched,
				// Scratch tasks keep the `Scratch — HH:mm` placeholder as title
				// on every variant, but the flag tells the launch path (see
				// prepareTaskInBackground → launchTaskPty) to blank the prompt.
				scratch: sourceTask.scratch,
				// Issue #583 — carry the user-edited title onto every variant
				// so "Save and Run" does not silently revert to the description prefix.
				customTitle: sourceTask.customTitle,
				titleEditedByUser: sourceTask.titleEditedByUser,
				// Carry the labels the user picked in the Create-Task modal — the
				// source task is deleted below, so without this every label is lost.
				labelIds: sourceTask.labelIds,
				// Virtual ("Operations") tasks: carry the chosen working folder onto
				// each variant so the worktree-less launch path targets it instead
				// of falling back to a managed dir (the source task is deleted below).
				...(sourceTask.opsWorkDir ? { opsWorkDir: sourceTask.opsWorkDir } : {}),
			},
		);

		resultTasks.push(needsWorktree ? {
			...task,
			...preparingStageUpdates(INITIAL_PREPARING_STAGE),
		} : task);
	}

	await data.deleteTask(project, params.taskId);

	for (const task of resultTasks) {
		notifyWatchedTaskStatusChange(task, "todo", params.targetStatus, project.name);
	}

	log.info("← spawnVariants returning immediately", { count: resultTasks.length, groupId, needsWorktree });

	if (needsWorktree) {
		(async () => {
			try {
				for (let i = 0; i < resultTasks.length; i++) {
					const task = resultTasks[i];
					const variant = params.variants[i];
					const variantBranchName = (isMultiVariant && srcBranch)
						? `${srcBranch.replace(/^origin\//, "")}-v${i + 1}`
						: undefined;
					await prepareTaskInBackground(project, task, {
						label: "variant",
						agentId: variant.agentId,
						configId: variant.configId,
						existingBranch: task.existingBranch ?? undefined,
						variantBranchName,
					});
				}
			} catch (err) {
				log.error("Failed to start variant preparation", { projectId: project.id, error: String(err) });
				await clearPreparingTasks(project, resultTasks);
			}
		})();
	}

	return resultTasks;
}

async function addAttempts(params: {
	taskId: string;
	projectId: string;
	variants: Array<{ agentId: string | null; configId: string | null }>;
}): Promise<Task[]> {
	log.info("→ addAttempts", { taskId: params.taskId, count: params.variants.length });
	const project = await data.getProject(params.projectId);
	const sourceTask = await data.getTask(project, params.taskId);

	let groupId = sourceTask.groupId;
	const allTasks = await data.loadTasks(project);
	let maxVariantIndex = 0;

	if (groupId) {
		for (const task of allTasks) {
			if (task.groupId === groupId && task.variantIndex !== null && task.variantIndex > maxVariantIndex) {
				maxVariantIndex = task.variantIndex;
			}
		}
	} else {
		groupId = crypto.randomUUID();
		maxVariantIndex = 1;
		await data.updateTask(project, sourceTask.id, { groupId, variantIndex: 1 });
	}

	const sharedSeq = sourceTask.seq;
	const resultTasks: Task[] = [];
	const targetStatus: TaskStatus = "in-progress";
	const needsWorktree = isActive(targetStatus);
	const srcBranch = getSourceTaskBranch(sourceTask, project);

	for (let i = 0; i < params.variants.length; i++) {
		const variant = params.variants[i];
		const variantIndex = maxVariantIndex + i + 1;

		const task = await data.addTask(
			project,
			sourceTask.description,
			targetStatus,
			{
				groupId,
				variantIndex,
				agentId: variant.agentId,
				configId: variant.configId,
				seq: sharedSeq,
				existingBranch: srcBranch,
				preparing: needsWorktree,
				preparingStage: needsWorktree ? INITIAL_PREPARING_STAGE : null,
				preparingProgress: needsWorktree ? getPreparingStageProgress(INITIAL_PREPARING_STAGE) : null,
				preparingStartedAt: needsWorktree ? new Date().toISOString() : null,
				watched: sourceTask.watched,
				// Carry the scratch flag onto every added attempt — otherwise the
				// launch path keeps the `Scratch — HH:mm` placeholder as the prompt
				// (only variantIndex 1 from the original spawnVariants kept it).
				scratch: sourceTask.scratch,
				// Issue #583 — carry the user-edited title onto every added attempt
				// so re-running a task does not throw away the title the user typed.
				customTitle: sourceTask.customTitle,
				titleEditedByUser: sourceTask.titleEditedByUser,
				// Attempts share the source task's labels (same group).
				labelIds: sourceTask.labelIds,
			},
		);

		resultTasks.push(needsWorktree ? {
			...task,
			...preparingStageUpdates(INITIAL_PREPARING_STAGE),
		} : task);
	}

	const updatedSource = await data.getTask(project, sourceTask.id);

	log.info("← addAttempts returning", { count: resultTasks.length, groupId, needsWorktree });

	if (needsWorktree) {
		(async () => {
			try {
					for (let i = 0; i < resultTasks.length; i++) {
						const task = resultTasks[i];
						const variant = params.variants[i];
						await prepareTaskInBackground(project, task, {
							label: "attempt",
							agentId: variant.agentId,
							configId: variant.configId,
							existingBranch: task.existingBranch ?? srcBranch,
						});
					}
			} catch (err) {
				log.error("Failed to start attempt preparation", { projectId: project.id, error: String(err) });
				await clearPreparingTasks(project, resultTasks);
			}
		})();
	}

	return [updatedSource, ...resultTasks];
}

async function editTask(params: { taskId: string; projectId: string; description: string }): Promise<Task> {
	log.info("→ editTask", { taskId: params.taskId });
	const project = await data.getProject(params.projectId);
	const task = await data.getTask(project, params.taskId);
	if (task.status !== "todo") {
		throw new Error(`Can only edit tasks in todo status (got ${task.status})`);
	}
	const updates: Partial<Task> = { description: params.description };
	if (!task.customTitle) {
		updates.title = titleFromDescription(params.description);
	}
	const updated = await data.updateTask(project, task.id, updates);
	log.info("← editTask done", { taskId: task.id });
	return updated;
}

async function renameTask(params: { taskId: string; projectId: string; customTitle: string | null }): Promise<Task> {
	log.info("→ renameTask", { taskId: params.taskId, customTitle: params.customTitle });
	const project = await data.getProject(params.projectId);
	const task = await data.getTask(project, params.taskId);
	const trimmed = params.customTitle?.trim() || null;
	// This RPC is invoked only from the UI (Create Task modal + InlineRename) —
	// so any non-null write here is a real user edit and must lock the title
	// against future agent renames. Clearing the title (`null`) also clears
	// the user-edit flag so the auto-generated title is back in play.
	const updated = await data.updateTask(project, task.id, {
		customTitle: trimmed,
		titleEditedByUser: trimmed !== null,
	});
	getPushMessage()?.("taskUpdated", { projectId: project.id, task: updated });
	log.info("← renameTask done", { taskId: task.id });
	return updated;
}

async function setUserOverview(params: { taskId: string; projectId: string; userOverview: string }): Promise<Task> {
	log.info("→ setUserOverview", { taskId: params.taskId, len: params.userOverview?.length ?? 0 });
	const project = await data.getProject(params.projectId);
	const task = await data.getTask(project, params.taskId);
	const trimmed = params.userOverview?.trim();
	if (!trimmed) throw new Error("userOverview is required — use clearUserOverview to remove it");
	const updated = await data.updateTask(project, task.id, { userOverview: trimmed });
	getPushMessage()?.("taskUpdated", { projectId: project.id, task: updated });
	log.info("← setUserOverview done", { taskId: task.id });
	return updated;
}

async function clearUserOverview(params: { taskId: string; projectId: string }): Promise<Task> {
	log.info("→ clearUserOverview", { taskId: params.taskId });
	const project = await data.getProject(params.projectId);
	const task = await data.getTask(project, params.taskId);
	const updated = await data.updateTask(project, task.id, { userOverview: null });
	getPushMessage()?.("taskUpdated", { projectId: project.id, task: updated });
	log.info("← clearUserOverview done", { taskId: task.id });
	return updated;
}

async function toggleTaskWatch(params: { taskId: string; projectId: string; watched: boolean }): Promise<Task> {
	log.info("→ toggleTaskWatch", { taskId: params.taskId, watched: params.watched });
	const project = await data.getProject(params.projectId);
	const updated = await data.updateTask(project, params.taskId, { watched: params.watched });
	getPushMessage()?.("taskUpdated", { projectId: project.id, task: updated });
	log.info("← toggleTaskWatch done", { taskId: params.taskId });
	return updated;
}

async function respondToAgentCompletionRequest(params: { requestId: string; approved: boolean }): Promise<void> {
	const known = resolveCompletionRequest(params.requestId, params.approved);
	if (!known) {
		log.debug("respondToAgentCompletionRequest: request expired or unknown", { requestId: params.requestId });
	}
}

/**
 * Quick shell: the replacement for the removed single home-terminal. Opens (or
 * focuses) a prompt-less "Quick shell" operation in the built-in Operations
 * board, running in the user's home dir. The ⇧⌘` hotkey maps to this.
 */
/**
 * Find a Quick shell task worth reusing: any one that is NOT in a terminal state
 * (completed/cancelled). An active shell is refocused; an inactive one (e.g.
 * dragged to todo) is relaunched. Only when every Quick shell is terminal — or
 * none exists — is a fresh one created. Matching ONLY active ones (the old bug)
 * silently spawned duplicates whenever a shell went inactive.
 */
export function findReusableQuickShell(tasks: Task[]): Task | undefined {
	return tasks.find(
		(tk) => tk.customTitle === "Quick shell" && tk.status !== "completed" && tk.status !== "cancelled",
	);
}

// In-flight guard: openQuickShell does find-then-create, which is not atomic.
// Two rapid ⇧⌘` presses would both miss the existing shell and each create one.
// Serializing concurrent calls onto a single promise makes the second press
// return the same task the first one resolves to, instead of a duplicate.
let quickShellInflight: Promise<Task> | null = null;

async function openQuickShell(_params: {}): Promise<Task> {
	log.info("→ openQuickShell");
	if (quickShellInflight) {
		log.info("openQuickShell: joining in-flight call");
		return quickShellInflight;
	}
	quickShellInflight = openQuickShellInner();
	try {
		return await quickShellInflight;
	} finally {
		quickShellInflight = null;
	}
}

async function openQuickShellInner(): Promise<Task> {
	const project = await data.ensureBuiltinOperationsBoard("Operations");
	const tasks = await data.loadTasks(project);
	// Reuse any non-terminal Quick shell (NOT just active ones): one that was
	// dragged to todo or otherwise went inactive must be refocused/relaunched, not
	// duplicated. Completed/cancelled shells are history — a fresh one is created.
	const existing = findReusableQuickShell(tasks);
	if (existing && isActive(existing.status)) {
		log.info("← openQuickShell (focus existing)", { taskId: existing.id.slice(0, 8) });
		return existing;
	}
	// Either no shell exists, or the existing one is inactive (e.g. todo) and needs
	// its PTY relaunched. Both paths run activate + set in-progress identically.
	const target =
		existing ??
		(await data.addTask(project, "", "todo", {
			scratch: true,
			customTitle: "Quick shell",
			titleEditedByUser: true,
			opsWorkDir: homedir(),
		}));
	const wt = await activateTask(project, target, { isReopen: !!existing });
	const updated = await data.updateTask(project, target.id, {
		status: "in-progress",
		worktreePath: wt.worktreePath,
		branchName: wt.branchName,
	});
	getPushMessage()?.("taskUpdated", { projectId: project.id, task: updated });
	log.info(`← openQuickShell (${existing ? "reactivated" : "created"})`, { taskId: target.id.slice(0, 8) });
	return updated;
}

export const taskLifecycleHandlers = {
	getTasks,
	getAllProjectTasks,
	openQuickShell,
	createTask,
	moveTask,
	cancelTaskPreparation,
	reorderTask,
	deleteTask,
	spawnVariants,
	addAttempts,
	editTask,
	renameTask,
	setUserOverview,
	clearUserOverview,
	toggleTaskWatch,
	respondToAgentCompletionRequest,
};
