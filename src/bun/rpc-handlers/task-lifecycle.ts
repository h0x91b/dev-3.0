import { existsSync } from "node:fs";
import { join } from "node:path";
import { PATHS } from "electrobun/bun";
import type { ColumnAgentConfig, CustomColumn, Project, Task, TaskStatus } from "../../shared/types";
import { ACTIVE_STATUSES, DEFAULT_REVIEW_PROMPT, titleFromDescription } from "../../shared/types";
import * as data from "../data";
import * as git from "../git";
import * as pty from "../pty-server";
import * as portPool from "../port-pool";
import * as repoConfig from "../repo-config";
import { clonePaths } from "../cow-clone";
import { loadSettings, loadSettingsSync } from "../settings";
import { DEV3_HOME } from "../paths";
import { spawn } from "../spawn";
import { getPushMessage, isActive, log, notifyWatchedTaskStatusChange } from "./shared";
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
			const updated = await data.updateTask(project, task.id, { preparing: false });
			getPushMessage()?.("taskUpdated", { projectId: project.id, task: updated });
		} catch {
			// Best effort — do not crash background preparation cleanup.
		}
	}
}

export async function activateTask(
	project: Project,
	task: Task,
	opts?: { isReopen?: boolean },
): Promise<{ worktreePath: string; branchName: string }> {
	const isReopen = opts?.isReopen ?? false;
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
	const taskForLaunch = isReopen ? { ...task, description: "" } : task;
	await launchTaskPty(resolved, taskForLaunch, wt.worktreePath, undefined, undefined, true, isReopen);
	return { worktreePath: wt.worktreePath, branchName: wt.branchName };
}

export async function handleBellAutoStatus(taskId: string): Promise<void> {
	try {
		const projects = await data.loadProjects();
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
		const projects = await data.loadProjects();
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

export async function runCleanupScript(task: Task, project: Project): Promise<void> {
	if (!task.worktreePath) return;

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

	await Bun.write(scriptPath, `#!/bin/bash\n${script}\n`);

	log.info("Starting cleanup tmux session", { session: sessionName, worktreePath: task.worktreePath });

	const cleanupSocket = task.tmuxSocket ?? pty.DEFAULT_TMUX_SOCKET;
	const cleanupArgs = pty.tmuxArgs(cleanupSocket, "-f", pty.TMUX_CONF_PATH, "new-session", "-s", sessionName, "-c", task.worktreePath, `bash "${scriptPath}"`);
	const proc = spawn(
		cleanupArgs,
		{
			terminal: { cols: 220, rows: 50, data: () => {} },
			env: { TERM: "xterm-256color", HOME: process.env.HOME || "/" },
			cwd: task.worktreePath,
		},
	);

	await proc.exited;

	log.info("Cleanup session finished", { session: sessionName });
}

export function playTaskCompleteSound(status: "completed" | "cancelled"): void {
	const settings = loadSettingsSync();
	if (settings.playSoundOnTaskComplete === false) return;

	const filename = status === "completed" ? "task-completed.mp3" : "task-cancelled.mp3";
	const volume = status === "completed" ? "0.3" : "0.7";
	const prodPath = join(PATHS.VIEWS_FOLDER, "..", "sounds", filename);
	const devPath = typeof import.meta.dir === "string"
		? join(import.meta.dir, "..", "assets", "sounds", filename)
		: null;
	const soundPath = existsSync(prodPath) ? prodPath : devPath && existsSync(devPath) ? devPath : null;

	if (!soundPath) {
		log.warn("Task complete sound file not found", { prodPath, devPath, status });
		return;
	}

	try {
		spawn(["afplay", "-v", volume, soundPath], {
			env: { HOME: process.env.HOME || "/" },
		});
	} catch (err) {
		log.warn("Failed to play task complete sound", { error: String(err) });
	}
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
		}
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
	const projects = await data.loadProjects();
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

async function createTask(params: { projectId: string; description: string; status?: TaskStatus; existingBranch?: string }): Promise<Task> {
	log.info("→ createTask", params);
	const project = await data.getProject(params.projectId);
	const status = params.status || "todo";
	const task = await data.addTask(project, params.description, status,
		params.existingBranch ? { existingBranch: params.existingBranch } : undefined,
	);

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

async function moveTask(params: { taskId: string; projectId: string; newStatus: TaskStatus; force?: boolean }): Promise<Task> {
	log.info("→ moveTask", params);
	const project = await data.getProject(params.projectId);
	const task = await data.getTask(project, params.taskId);
	const oldStatus = task.status;
	const newStatus = params.newStatus;
	const settings = await loadSettings();
	const dropOpts = { dropPosition: settings.taskDropPosition } as const;

	log.info(`Moving task ${oldStatus} → ${newStatus}`, { taskId: task.id, force: !!params.force });

	clearMergeNotification(task.id);

	if (!isActive(oldStatus) && isActive(newStatus)) {
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
		playTaskCompleteSound(newStatus as "completed" | "cancelled");
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
				await runCleanupScript(task, project);
			} catch (err) {
				log.error("Cleanup script failed, continuing with task move", {
					taskId: task.id,
					error: String(err),
				});
			}

			try {
				await git.removeWorktree(project, task);
			} catch (err) {
				log.error("removeWorktree failed, continuing with task move", {
					taskId: task.id,
					error: String(err),
				});
			}
		}

		const updated = await data.updateTask(project, task.id, {
			status: newStatus,
			worktreePath: null,
			branchName: null,
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

	try {
		pty.destroySession(task.id, task.tmuxSocket ?? undefined);
	} catch (err) {
		log.warn("destroySession failed in deleteTask (best-effort)", { taskId: task.id.slice(0, 8), error: String(err) });
	}

	if (isActive(task.status) || task.worktreePath) {
		log.info("Task has worktree, cleaning up", { status: task.status, worktreePath: task.worktreePath });
		await git.removeWorktree(project, task);
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
	const srcBranch = sourceTask.existingBranch ?? undefined;
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
				watched: sourceTask.watched,
			},
		);

		resultTasks.push(task);
	}

	await data.deleteTask(project, params.taskId);

	for (const task of resultTasks) {
		notifyWatchedTaskStatusChange(task, "todo", params.targetStatus, project.name);
	}

	log.info("← spawnVariants returning immediately", { count: resultTasks.length, groupId, needsWorktree });

	if (needsWorktree) {
		(async () => {
			try {
				const resolvedProject = await repoConfig.resolveProjectConfig(project);
				for (let i = 0; i < resultTasks.length; i++) {
					const task = resultTasks[i];
					const variant = params.variants[i];
					try {
						const variantBranchName = (isMultiVariant && srcBranch)
							? `${srcBranch.replace(/^origin\//, "")}-v${i + 1}`
							: undefined;
						const wt = await git.createWorktree(resolvedProject, task, task.existingBranch ?? undefined, variantBranchName);
						const resolved = await resolveOperationalProjectConfig(resolvedProject, wt.worktreePath);
						if (resolved.sparseCheckoutEnabled && resolved.sparseCheckoutPaths?.length) {
							await git.applySparseCheckout(wt.worktreePath, resolved.sparseCheckoutPaths);
						}
						await runCowClones(resolved, wt.worktreePath);
						await launchTaskPty(resolved, task, wt.worktreePath, variant.agentId, variant.configId, true);

						const updated = await data.updateTask(project, task.id, {
							worktreePath: wt.worktreePath,
							branchName: wt.branchName,
							preparing: false,
						});
						getPushMessage()?.("taskUpdated", { projectId: project.id, task: updated });
						log.info("Variant ready", { taskId: task.id, worktreePath: wt.worktreePath });
					} catch (err) {
						log.error("Failed to prepare variant", { taskId: task.id, error: String(err) });
						try {
							const updated = await data.updateTask(project, task.id, { preparing: false });
							getPushMessage()?.("taskUpdated", { projectId: project.id, task: updated });
						} catch {}
					}
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
				preparing: needsWorktree,
				watched: sourceTask.watched,
			},
		);

		resultTasks.push(task);
	}

	const updatedSource = await data.getTask(project, sourceTask.id);

	log.info("← addAttempts returning", { count: resultTasks.length, groupId, needsWorktree });

	if (needsWorktree) {
		(async () => {
			try {
				const resolvedProject = await repoConfig.resolveProjectConfig(project);
				for (let i = 0; i < resultTasks.length; i++) {
					const task = resultTasks[i];
					const variant = params.variants[i];
					try {
						const wt = await git.createWorktree(resolvedProject, task);
						const resolved = await resolveOperationalProjectConfig(resolvedProject, wt.worktreePath);
						if (resolved.sparseCheckoutEnabled && resolved.sparseCheckoutPaths?.length) {
							await git.applySparseCheckout(wt.worktreePath, resolved.sparseCheckoutPaths);
						}
						await runCowClones(resolved, wt.worktreePath);
						await launchTaskPty(resolved, task, wt.worktreePath, variant.agentId, variant.configId, true);

						const updated = await data.updateTask(project, task.id, {
							worktreePath: wt.worktreePath,
							branchName: wt.branchName,
							preparing: false,
						});
						getPushMessage()?.("taskUpdated", { projectId: project.id, task: updated });
						log.info("Attempt ready", { taskId: task.id, worktreePath: wt.worktreePath });
					} catch (err) {
						log.error("Failed to prepare attempt", { taskId: task.id, error: String(err) });
						try {
							const updated = await data.updateTask(project, task.id, { preparing: false });
							getPushMessage()?.("taskUpdated", { projectId: project.id, task: updated });
						} catch {}
					}
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
	const updated = await data.updateTask(project, task.id, { customTitle: trimmed });
	getPushMessage()?.("taskUpdated", { projectId: project.id, task: updated });
	log.info("← renameTask done", { taskId: task.id });
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

export const taskLifecycleHandlers = {
	getTasks,
	getAllProjectTasks,
	createTask,
	moveTask,
	reorderTask,
	deleteTask,
	spawnVariants,
	addAttempts,
	editTask,
	renameTask,
	toggleTaskWatch,
};
