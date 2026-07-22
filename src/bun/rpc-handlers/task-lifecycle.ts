import type { LaunchVariant, Project, Task, TaskPriority, TaskStatus } from "../../shared/types";
import { ACTIVE_STATUSES, titleFromDescription } from "../../shared/types";
import * as data from "../data";
import { resolveCompletionRequest } from "../completion-requests";
import { recordFavoriteUsages } from "../settings";
import { getPushMessage, isActive, log } from "./shared";
import { dispatchLifecycleEvent, removeLifecycleActor } from "../lifecycle/service";
import { clearMergeNotification } from "../lifecycle/activities";

function scratchPlaceholder(now: Date = new Date()): string {
	const hh = String(now.getHours()).padStart(2, "0");
	const mm = String(now.getMinutes()).padStart(2, "0");
	return `Scratch — ${hh}:${mm}`;
}

function isScratchPlaceholderDescription(description: string): boolean {
	return /^Scratch — \d{2}:\d{2}$/.test(description.trim());
}

export async function handleBellAutoStatus(taskId: string): Promise<void> {
	try {
		const projects = [...await data.loadProjects(), ...await data.loadVirtualProjects()];
		for (const project of projects) {
			const tasks = await data.loadTasks(project);
			const task = tasks.find((candidate) => candidate.id === taskId);
			if (!task) continue;
			log.info("Bell auto-transition requested", { taskId: taskId.slice(0, 8) });
			await dispatchLifecycleEvent(project.id, task.id, {
				type: "moveRequested",
				target: { status: "user-questions" },
				guards: { ifStatus: "in-progress" },
			}, { project, task });
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

async function createTask(params: { projectId: string; description: string; status?: TaskStatus; existingBranch?: string; scratch?: boolean; opsWorkDir?: string; priority?: TaskPriority }): Promise<Task> {
	log.info("→ createTask", {
		projectId: params.projectId,
		requestedStatus: params.status ?? "todo",
		scratch: params.scratch === true,
		descriptionLength: params.description.length,
		hasExistingBranch: Boolean(params.existingBranch),
		hasOpsWorkDir: Boolean(params.opsWorkDir),
		priority: params.priority,
	});
	const project = await data.getProject(params.projectId);
	const isScratch = params.scratch === true;
	// Scratch tasks always start in "todo" with a placeholder title so the
	// Launch Variants modal can open and let the user pick the agent before
	// anything is actually spawned. The `scratch: true` flag is persisted so
	// that when spawnVariants and the lifecycle actor eventually launch the
	// agent, the prompt is blanked (the placeholder is NOT sent to the agent).
	const status = isScratch ? "todo" : (params.status || "todo");
	const description = isScratch ? scratchPlaceholder() : params.description;
	const extras: Parameters<typeof data.addTask>[3] = {
		...(params.existingBranch ? { existingBranch: params.existingBranch } : {}),
		...(isScratch ? { scratch: true } : {}),
		...(params.opsWorkDir ? { opsWorkDir: params.opsWorkDir } : {}),
		...(params.priority ? { priority: params.priority } : {}),
	};
	const initialStatus = isActive(status) ? "todo" : status;
	const createdTask = await data.addTask(project, description, initialStatus, Object.keys(extras).length ? extras : undefined);
	const task = isActive(status) ? { ...createdTask, status: "todo" as const } : createdTask;

	if (isActive(status)) {
		log.info("Created into active status, preparing through lifecycle actor", { taskId: task.id });
		const updated = await dispatchLifecycleEvent(project.id, task.id, {
			type: "moveRequested",
			target: { status, customColumnId: null },
			preparation: {
				launch: {
					label: "create",
					agentId: task.agentId,
					configId: task.configId,
					existingBranch: task.existingBranch ?? undefined,
				},
				awaitCompletion: true,
				publishColumn: false,
			},
		}, { project, task });
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
	newStatus?: TaskStatus;
	customColumnId?: string | null;
	force?: boolean;
	ifStatus?: string;
	ifStatusNot?: string;
	clientPlayedSound?: boolean;
	enforceAllowedTransition?: boolean;
}): Promise<Task> {
	if (params.newStatus === undefined && params.customColumnId === undefined) {
		throw new Error("A lifecycle move requires a status or custom column");
	}
	return dispatchLifecycleEvent(params.projectId, params.taskId, {
		type: "moveRequested",
		target: params.newStatus !== undefined
			? { status: params.newStatus, customColumnId: params.customColumnId ?? null }
			: { customColumnId: params.customColumnId },
		guards: {
			...(params.ifStatus ? { ifStatus: params.ifStatus } : {}),
			...(params.ifStatusNot ? { ifStatusNot: params.ifStatusNot } : {}),
		},
		force: params.force,
		clientPlayedSound: params.clientPlayedSound,
		enforceAllowedTransition: params.enforceAllowedTransition,
	});
}

async function cancelTaskPreparation(params: { taskId: string; projectId: string }): Promise<Task> {
	log.info("→ cancelTaskPreparation", params);
	const project = await data.getProject(params.projectId);
	const task = await data.getTask(project, params.taskId);
	const runId = task.runtimeState?.runtime === "preparing" && task.runtimeState.runId
		? task.runtimeState.runId
		: `legacy-${task.id}`;
	const updated = await dispatchLifecycleEvent(project.id, task.id, {
		type: "preparationCancelled",
		runId,
	}, { project, task });
	log.info("← cancelTaskPreparation done", { taskId: task.id.slice(0, 8) });
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

async function setTaskPriority(params: { taskId: string; projectId: string; priority: TaskPriority }): Promise<Task[]> {
	log.info("→ setTaskPriority", params);
	const project = await data.getProject(params.projectId);
	const changed = await data.setTaskPriority(project, params.taskId, params.priority);
	for (const task of changed) {
		getPushMessage()?.("taskUpdated", { projectId: project.id, task });
	}
	log.info("← setTaskPriority done", { count: changed.length });
	return changed;
}

async function deleteTask(params: { taskId: string; projectId: string }): Promise<void> {
	log.info("→ deleteTask", params);
	const project = await data.getProject(params.projectId);
	const task = await data.getTask(project, params.taskId);
	await dispatchLifecycleEvent(project.id, task.id, { type: "deleteRequested" }, { project, task });
	removeLifecycleActor(task.id);
	log.info("← deleteTask done");
}

async function spawnVariants(params: {
	taskId: string;
	projectId: string;
	targetStatus: TaskStatus;
	variants: LaunchVariant[];
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

	const firstVariant = params.variants[0];
	if (!firstVariant) throw new Error("At least one variant is required");
	const sourceRunId = crypto.randomUUID();
	const launchedSource = await dispatchLifecycleEvent(project.id, sourceTask.id, {
		type: "moveRequested",
		runId: sourceRunId,
		target: { status: params.targetStatus, customColumnId: null },
		taskPatch: {
			groupId,
			variantIndex: 1,
			agentId: firstVariant.agentId,
			configId: firstVariant.configId,
			accountId: firstVariant.accountId,
			existingBranch: srcBranch,
			worktreePath: null,
			branchName: null,
			scheduledLaunch: null,
			preparationError: null,
		},
		...(needsWorktree ? {
			preparation: {
				launch: {
					label: "variant",
					agentId: firstVariant.agentId,
					configId: firstVariant.configId,
					existingBranch: srcBranch,
					variantBranchName: isMultiVariant && srcBranch
						? `${srcBranch.replace(/^origin\//, "")}-v1`
						: undefined,
				},
				awaitCompletion: false,
				publishColumn: true,
			},
		} : {}),
	}, { project, task: sourceTask });
	if (needsWorktree && launchedSource.runtimeState?.runId !== sourceRunId) {
		throw new Error(`Task must be in todo status to spawn variants (got ${launchedSource.status})`);
	}
	resultTasks.push(launchedSource);

	for (let i = 1; i < params.variants.length; i++) {
		const variant = params.variants[i];

		const task = await data.addTask(
			project,
			sourceTask.description,
			"todo",
			{
				groupId,
				variantIndex: i + 1,
				agentId: variant.agentId,
				configId: variant.configId,
				accountId: variant.accountId,
				seq: sharedSeq,
				existingBranch: srcBranch,
				watched: sourceTask.watched,
				// Scratch tasks keep the `Scratch — HH:mm` placeholder as title
				// on every variant, but the flag tells the launch path (see
				// lifecycle preparation → launchTaskPty) to blank the prompt.
				scratch: sourceTask.scratch,
				// Issue #583 — carry the user-edited title onto every variant
				// so "Save and Run" does not silently revert to the description prefix.
				customTitle: sourceTask.customTitle,
				titleEditedByUser: sourceTask.titleEditedByUser,
				// Sibling variants share the labels the user picked in the
				// Create-Task modal (labels belong to the whole variant group).
				labelIds: sourceTask.labelIds,
				// Copy notes + overview accumulated while the task sat in To Do:
				// each variant's agent reads its OWN task, so without the copy
				// variants 2..N would launch blind to that pre-launch context.
				notes: sourceTask.notes,
				overview: sourceTask.overview,
				userOverview: sourceTask.userOverview,
				// Priority belongs to the whole variant group — without the copy a
				// P0 launch would spawn P3 siblings.
				priority: sourceTask.priority,
				// Virtual ("Operations") tasks: carry the chosen working folder onto
				// each variant so the worktree-less launch path targets it instead
				// of falling back to a managed dir.
				...(sourceTask.opsWorkDir ? { opsWorkDir: sourceTask.opsWorkDir } : {}),
			},
		);

		const pendingTask: Task = {
			...task,
			status: "todo",
			worktreePath: null,
			branchName: null,
			preparing: false,
			preparingStage: null,
			preparingProgress: null,
			preparingStartedAt: null,
			runtimeState: undefined,
		};
		const variantBranchName = (isMultiVariant && srcBranch)
			? `${srcBranch.replace(/^origin\//, "")}-v${i + 1}`
			: undefined;
		resultTasks.push(await dispatchLifecycleEvent(project.id, pendingTask.id, {
			type: "moveRequested",
			target: { status: params.targetStatus, customColumnId: null },
			taskPatch: {
				groupId,
				variantIndex: i + 1,
				agentId: variant.agentId,
				configId: variant.configId,
				accountId: variant.accountId,
				existingBranch: srcBranch,
				scheduledLaunch: null,
				preparationError: null,
			},
			...(needsWorktree ? {
				preparation: {
					launch: {
						label: "variant",
						agentId: variant.agentId,
						configId: variant.configId,
						existingBranch: srcBranch,
						variantBranchName,
					},
					awaitCompletion: false,
					publishColumn: true,
				},
			} : {}),
		}, { project, task: pendingTask }));
	}

	// Bump favorite usage counters for any launched combo the user has starred
	// (once per variant/agent). Best-effort — never blocks or fails the launch.
	void recordFavoriteUsages(params.variants);

	log.info("← spawnVariants returning immediately", { count: resultTasks.length, groupId, needsWorktree });

	return resultTasks;
}

async function addAttempts(params: {
	taskId: string;
	projectId: string;
	variants: LaunchVariant[];
}): Promise<Task[]> {
	log.info("→ addAttempts", { taskId: params.taskId, count: params.variants.length });
	const project = await data.getProject(params.projectId);
	const sourceTask = await data.getTask(project, params.taskId);

	let groupId = sourceTask.groupId;

	if (!groupId) {
		// First attempt promotes a lone task into a group. Set the groupId under
		// the task lock and only if it is still ungrouped, so two concurrent
		// addAttempts calls cannot each mint a different groupId (which would
		// orphan one caller's variants); the loser adopts the winner's groupId.
		const newGroupId = crypto.randomUUID();
		const { task: promotedSource } = await data.updateTaskWith(project, sourceTask.id, (current) => {
			if (current.groupId) return { updates: {}, result: current.groupId };
			return { updates: { groupId: newGroupId, variantIndex: 1 }, result: newGroupId };
		});
		groupId = promotedSource.groupId ?? newGroupId;
	}

	const sharedSeq = sourceTask.seq;
	const resultTasks: Task[] = [];
	const targetStatus: TaskStatus = "in-progress";
	const needsWorktree = isActive(targetStatus);
	const srcBranch = getSourceTaskBranch(sourceTask, project);

	for (let i = 0; i < params.variants.length; i++) {
		const variant = params.variants[i];

		const task = await data.addTask(
			project,
			sourceTask.description,
			"todo",
			{
				groupId,
				// Allocate the variant index atomically inside addTask's file lock
				// rather than from a snapshot taken here — otherwise two concurrent
				// addAttempts on the same group would read the same base index and
				// mint duplicate variant numbers.
				autoVariantIndex: true,
				agentId: variant.agentId,
				configId: variant.configId,
				accountId: variant.accountId,
				seq: sharedSeq,
				existingBranch: srcBranch,
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
				// Attempts share the source task's priority (priority belongs to the
				// whole variant group), otherwise re-running a P0 task spawns a P3
				// sibling and the group's priority becomes inconsistent.
				priority: sourceTask.priority,
				// NOTE: notes/overview are intentionally NOT copied here — addAttempts
				// keeps the source task (returns it alongside the new attempts), so its
				// notes are not lost; copying them would duplicate them across siblings.
				// spawnVariants copies them because every initial variant needs the
				// pre-launch context on its own task record.
			},
		);

		resultTasks.push({
			...task,
			status: "todo",
			worktreePath: null,
			branchName: null,
			preparing: false,
			preparingStage: null,
			preparingProgress: null,
			preparingStartedAt: null,
			runtimeState: undefined,
		});
	}

	const updatedSource = await data.getTask(project, sourceTask.id);

	// Bump favorite usage counters for any launched combo the user has starred
	// (once per added attempt). Best-effort — never blocks or fails the launch.
	void recordFavoriteUsages(params.variants);

	log.info("← addAttempts returning", { count: resultTasks.length, groupId, needsWorktree });

	if (!needsWorktree) return [updatedSource, ...resultTasks];

	const launched = await Promise.all(resultTasks.map((task, i) => {
		const variant = params.variants[i];
		return dispatchLifecycleEvent(project.id, task.id, {
			type: "moveRequested",
			target: { status: targetStatus, customColumnId: null },
			taskPatch: {
				groupId: task.groupId,
				variantIndex: task.variantIndex,
				agentId: variant.agentId,
				configId: variant.configId,
				accountId: variant.accountId,
				existingBranch: task.existingBranch ?? srcBranch,
				preparationError: null,
			},
			preparation: {
				launch: {
					label: "attempt",
					agentId: variant.agentId,
					configId: variant.configId,
					existingBranch: task.existingBranch ?? srcBranch,
				},
				awaitCompletion: false,
				publishColumn: true,
			},
		}, { project, task });
	}));

	return [updatedSource, ...launched];
}

async function editTask(params: { taskId: string; projectId: string; description: string }): Promise<Task> {
	log.info("→ editTask", { taskId: params.taskId });
	const project = await data.getProject(params.projectId);
	const task = await data.getTask(project, params.taskId);
	if (task.status !== "todo") {
		throw new Error(`Can only edit tasks in todo status (got ${task.status})`);
	}
	const updates: Partial<Task> = { description: params.description };
	if (
		task.scratch === true
		&& params.description.trim()
		&& !isScratchPlaceholderDescription(params.description)
	) {
		updates.scratch = false;
	}
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
		...(task.scratch === true && trimmed !== null ? { scratch: false } : {}),
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

async function setTaskManualCompletion(params: { taskId: string; projectId: string; manualCompletion: boolean }): Promise<Task> {
	log.info("→ setTaskManualCompletion", { taskId: params.taskId, manualCompletion: params.manualCompletion });
	const project = await data.getProject(params.projectId);
	const task = await data.getTask(project, params.taskId);
	const changed = task.manualCompletion !== params.manualCompletion;
	if (!changed) return task;
	// Changing the completion policy starts a fresh merge-decision cycle. This
	// keeps an earlier Not now answer from hiding the newly enabled prompt.
	const updated = await data.updateTask(project, task.id, {
		manualCompletion: params.manualCompletion,
		mergeCompletionPrompt: null,
	});
	clearMergeNotification(task.id);
	getPushMessage()?.("taskUpdated", { projectId: project.id, task: updated });
	log.info("← setTaskManualCompletion done", { taskId: task.id });
	return updated;
}

async function respondToAgentCompletionRequest(params: { requestId: string; approved: boolean }): Promise<void> {
	const known = resolveCompletionRequest(params.requestId, params.approved);
	if (!known) {
		log.debug("respondToAgentCompletionRequest: request expired or unknown", { requestId: params.requestId });
	}
}

/**
 * Quick shell (⇧⌘`): spawns a FRESH scratch operation in the built-in Operations
 * board on every press — exactly like clicking "Scratch Task" there. The task
 * gets the normal `Scratch — HH:mm` title and a managed work dir, and is launched
 * immediately with the user's default agent + config (Claude Opus 4.8 / auto by
 * factory default) — no agent picker, no singleton reuse. A blank prompt means
 * the agent starts idle and ready.
 */

// In-flight guard: a single ⇧⌘` should create exactly one task even if the key
// repeats / double-fires. Serializing concurrent calls onto one promise makes a
// second near-simultaneous press resolve to the same task instead of spawning a
// duplicate. Deliberate presses after completion still each create a fresh op.
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
	// Always a brand-new scratch op (no reuse): normal `Scratch — HH:mm` title and
	// a managed work dir (no opsWorkDir → git.virtualWorkDir). Leaving
	// agentId/configId unset makes launchTaskPty resolve the project/global default
	// agent — i.e. the "default agent with default config".
	const task = await data.addTask(project, scratchPlaceholder(), "todo", { scratch: true });
	const updated = await dispatchLifecycleEvent(project.id, task.id, {
		type: "moveRequested",
		target: { status: "in-progress", customColumnId: null },
	}, { project, task });
	log.info("← openQuickShell (created scratch)", { taskId: task.id.slice(0, 8) });
	return updated;
}

/**
 * Create the ordinary task an Automation fire produces: description = the
 * stored prompt (the agent's initial prompt), title = the automation name +
 * date, agent = the automation's choice. Preparation (worktree + PTY) runs in
 * the background — same pipeline as Launch Variants — so the scheduler tick
 * returns fast and the board card shows live progress. Works for git AND
 * virtual (Operations) projects; the lifecycle preparation effect selects the
 * project-specific workspace path.
 */
export async function createAutomationTask(
	project: Project,
	automation: { id: string; name: string; prompt: string; agentId: string | null; configId: string | null },
): Promise<Task> {
	const now = new Date();
	const createdTask = await data.addTask(project, automation.prompt, "todo", {
		agentId: automation.agentId,
		configId: automation.configId,
		automationId: automation.id,
		customTitle: `${automation.name} · ${now.toISOString().slice(0, 10)}`,
	});
	const task = { ...createdTask, status: "todo" as const };
	log.info("Automation task created, preparing in background", {
		taskId: task.id.slice(0, 8),
		automationId: automation.id.slice(0, 8),
	});
	return dispatchLifecycleEvent(project.id, task.id, {
		type: "moveRequested",
		target: { status: "in-progress", customColumnId: null },
		preparation: {
			launch: {
				label: "automation",
				agentId: automation.agentId,
				configId: automation.configId,
			},
			awaitCompletion: false,
			publishColumn: true,
		},
	}, { project, task });
}

/**
 * "Start in…" — persist a deferred launch on a todo task. Nothing spawns yet:
 * the scheduled-launch scheduler (or "Start now") fires the stored variants
 * later via {@link fireScheduledLaunch}, which reuses the exact spawnVariants
 * pipeline of an immediate launch. Lifecycle actors publish every task update,
 * including launches fired by the scheduler.
 */
async function scheduleTaskLaunch(params: {
	taskId: string;
	projectId: string;
	at: string;
	targetStatus: TaskStatus;
	variants: LaunchVariant[];
}): Promise<Task> {
	log.info("→ scheduleTaskLaunch", { taskId: params.taskId, at: params.at, count: params.variants.length });
	const project = await data.getProject(params.projectId);
	const task = await data.getTask(project, params.taskId);
	if (task.status !== "todo") {
		throw new Error(`Task must be in todo status to schedule a launch (got ${task.status})`);
	}
	if (params.variants.length === 0) {
		throw new Error("Scheduled launch needs at least one variant");
	}
	const at = new Date(params.at);
	if (!Number.isFinite(at.getTime()) || at.getTime() <= Date.now()) {
		throw new Error("Scheduled launch time must be in the future");
	}
	const updated = await data.updateTask(project, task.id, {
		scheduledLaunch: {
			at: at.toISOString(),
			targetStatus: params.targetStatus,
			variants: params.variants,
		},
	});
	getPushMessage()?.("taskUpdated", { projectId: project.id, task: updated });
	log.info("← scheduleTaskLaunch done", { taskId: task.id.slice(0, 8), at: at.toISOString() });
	return updated;
}

/** Clear a pending deferred launch without firing it (badge → "Cancel"). */
async function cancelScheduledLaunch(params: { taskId: string; projectId: string }): Promise<Task> {
	log.info("→ cancelScheduledLaunch", { taskId: params.taskId });
	const project = await data.getProject(params.projectId);
	const updated = await data.updateTask(project, params.taskId, { scheduledLaunch: null });
	getPushMessage()?.("taskUpdated", { projectId: project.id, task: updated });
	log.info("← cancelScheduledLaunch done", { taskId: params.taskId.slice(0, 8) });
	return updated;
}

/**
 * Fire a pending deferred launch NOW. Shared by the scheduler tick and the
 * `startScheduledLaunchNow` RPC. Delegates to spawnVariants (same validation,
 * same variant pipeline — the source task becomes variant #1 in place, keeping
 * its id). The lifecycle actor broadcasts the server-initiated changes through
 * its declared `taskUpdated` effects.
 */
export async function fireScheduledLaunch(project: Project, task: Task): Promise<Task[]> {
	const sched = task.scheduledLaunch;
	if (!sched) throw new Error("Task has no scheduled launch");
	const spawned = await spawnVariants({
		taskId: task.id,
		projectId: project.id,
		targetStatus: sched.targetStatus,
		variants: sched.variants,
	});
	log.info("Scheduled launch fired", {
		taskId: task.id.slice(0, 8),
		scheduledFor: sched.at,
		count: spawned.length,
	});
	return spawned;
}

async function startScheduledLaunchNow(params: { taskId: string; projectId: string }): Promise<Task[]> {
	log.info("→ startScheduledLaunchNow", { taskId: params.taskId });
	const project = await data.getProject(params.projectId);
	const task = await data.getTask(project, params.taskId);
	return fireScheduledLaunch(project, task);
}

export const taskLifecycleHandlers = {
	getTasks,
	getAllProjectTasks,
	openQuickShell,
	createTask,
	moveTask,
	cancelTaskPreparation,
	reorderTask,
	setTaskPriority,
	deleteTask,
	spawnVariants,
	addAttempts,
	editTask,
	renameTask,
	setUserOverview,
	clearUserOverview,
	toggleTaskWatch,
	setTaskManualCompletion,
	scheduleTaskLaunch,
	cancelScheduledLaunch,
	startScheduledLaunchNow,
	respondToAgentCompletionRequest,
};
