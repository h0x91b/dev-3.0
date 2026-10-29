import type { AgentMessageSource, CustomColumn, PresetPromptSource, Project, Task, TaskOrigin, TaskStatus, TaskType } from "../../shared/types";
import { ACTIVE_STATUSES, ALL_STATUSES, TASK_TYPES, getTaskTitle, agentLaunchAutoApproveMs, isStatusGuardBlocked, normalizePriority, normalizeTaskType, presetPromptForTaskType, presetPromptSourceForTaskType, withPresetPrompt, withoutPresetPrompt } from "../../shared/types";
import type { DeepLinkNav } from "../../shared/deep-link";
import { markPendingDeepLinkNav } from "../deep-link-nav";
import * as data from "../data";
import * as labelOps from "../board-operations/labels";
import { updateTaskMetadata, type TaskMetadataChange } from "../board-operations/task-metadata";
import { boardPorts } from "../board-operations/runtime";
import { AGENT_ACTOR } from "../board-operations/types";
import { resolveTaskStartRef } from "../task-start-ref";
import { createScratchTask, createTask, deleteTask, getPushMessage, moveTask } from "../rpc-handlers";
import { deliverAgentPrompt } from "../agent-prompt-delivery";
import type { AgentPromptDeliveryStatus } from "../../shared/agent-prompt-delivery";
import { loadSettings } from "../settings";
import { syncTaskBranchName } from "../task-branch-sync";
import { taskPeek } from "../task-peek";
import { loadTaskChildren } from "../task-lineage";
import { readTaskTerminalBackendState, switchTaskTerminalBackend } from "../task-terminal-backend-switch";
import { approvalStatusOf, launchSuggestionRequested, launcherHandoffNote, requestAgentLaunchApproval, requestDestructiveApproval, resolveLaunchSuggestion } from "./approvals";
import { log, type Handler, withSenderVariant } from "./shared";
import { findByIdPrefix, findTaskByRef, parseSeqRef, resolveAgentMessageSource, resolveRequesterTask, resolveTaskAcrossProjects, resolveTaskFromParams, scopedTaskNotFoundError, senderRequester, taskNotFoundError, withArchivedHistory, withOriginParent, withSenderAgent } from "./task-resolution";

// Lazy like `conversationImport` (shared.ts): it reaches the app and spaces handler domains.
async function projectRegistration() {
	return import("../project-registration");
}

function stringList(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/**
 * `dev3 label set|add|remove`. This adapter resolves short prefixes and owns the
 * "Label not found" wording; the shared operation merges inside the tasks-file lock.
 */
async function changeTaskLabels(params: Record<string, unknown>, mode: "replace" | "add" | "remove"): Promise<Task> {
	const rawLabelIds = params.labelIds as string[];
	if (!params.taskId) throw new Error("taskId is required");
	if (!params.projectId) throw new Error("projectId is required");
	if (!Array.isArray(rawLabelIds)) throw new Error("labelIds must be an array");

	const { project, task } = await resolveTaskFromParams(params);
	const projectLabels = project.labels ?? [];

	// Resolve short label ID prefixes to full UUIDs, rejecting any that do not
	// match a real project label. Without this an id typo would be persisted
	// verbatim into task.labelIds as permanent garbage (nothing prunes dangling
	// labelIds), the UI would render zero labels for it, and the CLI would report success.
	// Deduped after resolving: `label add lbl-1 lbl-1111-full` names one label twice
	// and would otherwise append it twice, and nothing prunes a repeated id either.
	const unknown: string[] = [];
	const labelIds = [...new Set(rawLabelIds.map((raw) => {
		const found = findByIdPrefix(projectLabels, raw, "label");
		if (found) return found.id;
		unknown.push(raw);
		return raw;
	}))];
	if (unknown.length > 0) {
		throw new Error(
			`Label not found: ${unknown.join(", ")}. Run "dev3 label list" to see valid label IDs.`,
		);
	}

	const { task: updated } = await labelOps.changeTaskLabels(boardPorts, project, task.id, { mode, labelIds });
	return updated;
}

/**
 * The parent a `dev3 task create` records: the task whose context the CLI ran in
 * (`sourceTaskId`), whoever typed it. Unresolvable → the user, never a failed create.
 */
async function creatorOrigin(params: Record<string, unknown>): Promise<TaskOrigin | undefined> {
	const sourceId = typeof params.sourceTaskId === "string" ? params.sourceTaskId.trim() : "";
	if (!sourceId) return undefined;
	try {
		const found = await resolveTaskAcrossProjects(sourceId);
		if (found) return { kind: "task", taskId: found.task.id, projectId: found.project.id };
	} catch (err) {
		log.warn("Creator task lookup failed; recording the user as origin", { sourceId, error: String(err) });
		return undefined;
	}
	log.warn("Creator task not found; recording the user as origin", { sourceId });
	return undefined;
}

const SENDER_MOVE_REFUSED = "A sender can only start a task that is not running.";

export const taskHandlers: Record<string, Handler> = {

	"projects.list": async () => {
		// Merge virtual ("Operations") boards so the CLI sees the same project set
		// as the app (matches getProjects in app-handlers).
		return [...await data.loadProjects(), ...await data.loadVirtualProjects()];
	},

	"projects.add": async (params) => (await projectRegistration()).registerProject({
		path: String(params.path ?? ""),
		name: typeof params.name === "string" ? params.name : undefined,
		init: params.init === true,
		spaces: stringList(params.spaces),
		newSpaces: stringList(params.newSpaces),
		noSpace: params.noSpace === true,
	}),

	"projects.clone": async (params) => (await projectRegistration()).cloneProject({
		url: String(params.url ?? ""),
		dir: typeof params.dir === "string" ? params.dir : undefined,
		name: typeof params.name === "string" ? params.name : undefined,
		spaces: stringList(params.spaces),
		newSpaces: stringList(params.newSpaces),
		noSpace: params.noSpace === true,
	}),

	"spaces.list": async () => (await projectRegistration()).listSpaces(),

	"spaces.create": async (params) => (await projectRegistration()).createSpaceWith({
		name: String(params.name ?? ""),
		projectIds: stringList(params.projectIds),
	}),

	"spaces.change": async (params) => {
		const mode = params.mode;
		if (mode !== "set" && mode !== "add" && mode !== "remove") throw new Error(`Invalid mode: ${String(mode)}. Use set, add or remove.`);
		const projectId = params.projectId as string;
		if (!projectId) throw new Error("projectId is required");
		return (await projectRegistration()).changeProjectSpaces({ projectId, mode, spaces: stringList(params.spaces) });
	},

	"tasks.list": async (params) => {
		const projectId = params.projectId as string;
		if (!projectId) throw new Error("projectId is required");

		const project = await data.getProject(projectId);
		let tasks = await data.loadTasks(project);

		if (params.status) {
			const status = params.status as TaskStatus;
			if (!ALL_STATUSES.includes(status)) {
				throw new Error(`Invalid status: ${status}. Valid: ${ALL_STATUSES.join(", ")}`);
			}
			tasks = tasks.filter((t) => t.status === status);
		}

		return tasks;
	},

	/**
	 * `dev3 task list --children-of`: the direct children of a task's variant
	 * group, from every project. The parent resolves in `projectId` when given.
	 */
	"task.children": async (params) => {
		const ref = params.taskId as string;
		if (!ref) throw new Error("taskId is required");
		let found: { project: Project; task: Task } | null;
		if (params.projectId) {
			const project = await data.getProject(params.projectId as string);
			const tasks = await data.loadTasks(project);
			const seq = parseSeqRef(ref);
			const task = seq === null ? findTaskByRef(tasks, ref) : tasks.find((t) => t.seq === seq) ?? null;
			if (!task) throw await scopedTaskNotFoundError(ref, project);
			found = { project, task };
		} else {
			found = await resolveTaskAcrossProjects(ref);
			if (!found) throw taskNotFoundError(ref);
		}
		const { project, task } = found;
		const group = (await data.loadTasks(project)).filter((t) => t.id === task.id || (t.seq === task.seq && task.groupId !== null && t.groupId === task.groupId));
		const children = await loadTaskChildren(new Set(group.map((t) => t.id)));
		const inVariantGroup = async (p: Project, t: Task) =>
			t.groupId !== null && (await data.loadTasks(p)).some((o) => o.id !== t.id && o.groupId === t.groupId);
		return {
			parent: { id: task.id, seq: task.seq, projectId: project.id, projectName: project.name, title: getTaskTitle(task) },
			children: await Promise.all(children.map(async ({ project: childProject, task: child }) => ({
				id: child.id,
				seq: child.seq,
				variantIndex: await inVariantGroup(childProject, child) ? child.variantIndex : null,
				projectId: childProject.id,
				projectName: childProject.name,
				status: child.status,
				title: getTaskTitle(child),
			}))),
		};
	},

	/**
	 * `dev3 task show --history` is the only reader of a task's title/overview
	 * history, and the history lives in the task's sidecar rather than in
	 * tasks.json. Hydrating it here keeps the CLI's task shape complete without
	 * putting a per-task file read on the board's load path.
	 */
	"task.show": async (params) => {
		const taskId = params.taskId as string;
		if (!taskId) throw new Error("taskId is required");

		if (params.projectId) {
			const project = await data.getProject(params.projectId as string);
			const tasks = await data.loadTasks(project);
			const task = findTaskByRef(tasks, taskId);
			if (!task) throw await scopedTaskNotFoundError(taskId, project);
			return await withOriginParent(await withArchivedHistory(project, await syncTaskBranchName(project, task)));
		}

		const found = await resolveTaskAcrossProjects(taskId);
		if (!found) throw taskNotFoundError(taskId);
		return await withOriginParent(await withArchivedHistory(found.project, await syncTaskBranchName(found.project, found.task)));
	},

	/**
	 * Read-only activity glance for a coordinator (`dev3 peek`). Deliberately
	 * unrestricted across projects, and deliberately silent in the logs about the
	 * terminal text it returns.
	 */
	"task.peek": async (params) => {
		const taskId = params.taskId as string;
		if (!taskId) throw new Error("taskId is required");

		let task: Task | null = null;
		let scopedProject: Project | undefined;
		if (params.projectId) {
			scopedProject = await data.getProject(params.projectId as string);
			task = findTaskByRef(await data.loadTasks(scopedProject), taskId);
		} else {
			task = (await resolveTaskAcrossProjects(taskId))?.task ?? null;
		}
		if (!task) throw scopedProject ? await scopedTaskNotFoundError(taskId, scopedProject) : taskNotFoundError(taskId);

		return await taskPeek({
			task,
			pane: params.pane === undefined ? undefined : String(params.pane),
			lines: params.lines === undefined ? undefined : Number(params.lines),
		});
	},

	"task.create": async (params) => {
		const projectId = params.projectId as string;
		const title = params.title as string;
		const description = (params.description as string | undefined)?.trim() || "";
		if (!projectId) throw new Error("projectId is required");
		if (!title) throw new Error("title is required");
		const prRef = typeof params.pr === "string" ? params.pr : undefined;
		const branchRef = typeof params.branch === "string" ? params.branch : undefined;
		const ownWorktree = params.ownWorktree === true;

		let priority = undefined;
		if (params.priority !== undefined) {
			priority = normalizePriority(String(params.priority)) ?? undefined;
			if (!priority) throw new Error(`Invalid priority "${params.priority}". Use P0, P1, P2, P3, or P4.`);
		}

		let taskType: TaskType | undefined;
		if (params.taskType !== undefined && params.taskType !== null && params.taskType !== "standard") {
			taskType = normalizeTaskType(String(params.taskType)) ?? undefined;
			if (!taskType) throw new Error(`Invalid task type "${params.taskType}". Use ${TASK_TYPES.join(", ")} or standard.`);
		}

		const project = await data.getProject(projectId);
		// What the task is ABOUT, resolved before it exists — creation derives
		// foreignCode from this ref, and a ref set afterwards would leave the trust
		// decision already made on the base branch (see task-start-ref.ts).
		const existingBranch = await resolveTaskStartRef({ project, pr: prRef, branch: branchRef, ownWorktree });
		// Use description as the task body if provided, otherwise fall back to title.
		// A type puts its role brief above that text at creation, through the same
		// function `task update --type` uses, so a card never claims a role its
		// agent was not given.
		const ownText = description || title;
		const body = taskType
			? withPresetPrompt(ownText, presetPromptForTaskType(taskType, project, await loadSettings()))
			: ownText;
		// The GUI's own creation handler — never a parallel path. It owns
		// foreignCode, and the CLI reached feature parity by calling it rather than
		// by copying it.
		const origin = await creatorOrigin(params);
		const task = await createTask({
			projectId: project.id,
			description: body,
			...(origin ? { origin } : {}),
			...(existingBranch ? { existingBranch } : {}),
			...(priority ? { priority } : {}),
			...(taskType ? { taskType } : {}),
			...(ownWorktree ? { ownWorktree } : {}),
		});
		// If a separate title was given alongside a description, store it as customTitle.
		// A role brief counts as a body too: without this the card would be named
		// after the first 80 characters of the preamble, so every one would read alike.
		if ((description || taskType) && title) {
			const updated = await data.updateTask(project, task.id, { customTitle: title });
			getPushMessage()?.("taskUpdated", { projectId: project.id, task: updated });
			return updated;
		}
		getPushMessage()?.("taskUpdated", { projectId: project.id, task });
		return task;
	},

	// `dev3 task create --scratch --run`: an agent asking for a throwaway peer.
	// Creates the bare scratch task, then reuses the launch approval dialog — so
	// the user still picks the agent and can decline. Only agents reach this path
	// (a human has the "Scratch Task" button); without a source task there is
	// nobody to hand the new task off to, hence the hard requirement.
	"task.createScratchAndRun": async (params) => {
		const projectId = params.projectId as string;
		if (!projectId) throw new Error("projectId is required");
		const sourceTaskId = typeof params.sourceTaskId === "string" ? params.sourceTaskId.trim() : "";
		if (!sourceTaskId) {
			throw new Error("Launching a scratch task requires running inside a task worktree");
		}

		const project = await data.getProject(projectId);
		// Before the placeholder exists, so a bad id leaves nothing behind.
		const suggested = await resolveLaunchSuggestion(params);
		const task = await createScratchTask(project.id, await creatorOrigin(params));
		const requester = await resolveAgentMessageSource(params, task.id);
		if (!requester) {
			await deleteTask({ taskId: task.id, projectId: project.id });
			throw new Error(`Unknown requesting task "${sourceTaskId}" — cannot attribute the scratch task`);
		}

		const outcome = await requestAgentLaunchApproval({
			project,
			task,
			targetStatus: "in-progress",
			requester: await withSenderAgent(requester, params),
			launcherNote: launcherHandoffNote(params),
			suggested,
		});
		// A declined scratch task has no reason to exist — it was created only to
		// have something for the dialog to launch. Leaving it would litter To Do
		// with empty placeholders every time the user says no.
		if (!outcome.approved) {
			await deleteTask({ taskId: task.id, projectId: project.id });
		}
		return outcome;
	},

	"task.update": async (params) => {
		const taskId = params.taskId as string;
		if (!taskId) throw new Error("taskId is required");

		let project: Project;
		let task: Task;

		if (params.projectId) {
			project = await data.getProject(params.projectId as string);
			const tasks = await data.loadTasks(project);
			const found = findTaskByRef(tasks, taskId);
			if (!found) throw await scopedTaskNotFoundError(taskId, project);
			task = found;
		} else {
			const found = await resolveTaskAcrossProjects(taskId);
			if (!found) throw taskNotFoundError(taskId);
			project = found.project;
			task = found.task;
		}

		const change: TaskMetadataChange = {};

		// Priority goes through the dedicated setter below (its own lock + push),
		// NOT folded into the metadata change.
		let priority = undefined;
		if (params.priority !== undefined) {
			priority = normalizePriority(String(params.priority));
			if (!priority) throw new Error(`Invalid priority "${params.priority}". Use P0, P1, P2, P3, or P4.`);
		}
		// Empty string (--title "") is an explicit reset. A user-edited title is guarded
		// inside the operation: refused for an agent unless --force.
		if (params.title !== undefined) {
			change.title = { value: (params.title as string) || null, force: Boolean(params.force) };
		}
		if (params.description !== undefined) change.description = params.description as string;
		// Task type and the preamble in the description move together, always — in the
		// same write. The preset prompt is frozen into the description at creation, so
		// flipping the field alone would produce a task the data calls a coordinator while
		// its agent was never told it is one — a badge nobody behind it honours.
		let taskTypeChange: { next: TaskType | null; agentPrompt: string } | undefined;
		// `--print-role`: the caller IS the agent behind this task and reads the role
		// brief in the command output, so the brief is returned rather than typed into
		// its own pane. Set for any resulting type, changed or not, so re-running the
		// promotion is idempotent instead of silent.
		const printRole = params.printRole === true;
		let rolePrompt: string | undefined;
		let rolePromptSource: PresetPromptSource | undefined;
		if (params.taskType !== undefined) {
			const raw = params.taskType;
			const next = raw === null || raw === "standard" ? null : normalizeTaskType(String(raw));
			if (raw !== null && raw !== "standard" && !next) {
				throw new Error(`Invalid task type "${raw}". Use ${TASK_TYPES.join(", ")} or standard.`);
			}
			if (printRole) {
				const settings = await loadSettings();
				rolePrompt = next ? presetPromptForTaskType(next, project, settings) : "";
				if (next) rolePromptSource = presetPromptSourceForTaskType(next, project, settings);
			}
			if ((task.taskType ?? null) !== next) {
				const settings = await loadSettings();
				const base = change.description ?? task.description;
				// Strip EVERY type's preamble before building, so switching between two
				// roles cannot leave the old brief behind, and a repeat cannot stack two
				// copies of a 40-line preamble onto one description.
				let ownText = base;
				for (const type of TASK_TYPES) {
					ownText = withoutPresetPrompt(ownText, presetPromptForTaskType(type, project, settings));
				}
				const preamble = next ? presetPromptForTaskType(next, project, settings) : null;
				change.taskType = next;
				change.description = preamble ? withPresetPrompt(ownText, preamble) : ownText;
				taskTypeChange = {
					next,
					agentPrompt: preamble
						? `Your role just changed: this task is now ${next === "coordinator" ? "the COORDINATOR of this board" : next === "board-cleanup" ? "a BOARD CLEANUP adviser" : "a PR REVIEW"}. Everything below is your standing instruction from here on, and it replaces any earlier instruction about what this task is.\n\n${preamble}`
						: "Your role just changed: this task no longer carries a special role. The role brief you were given no longer applies — you are an ordinary task agent again and may do the work yourself.",
				};
			}
		}
		if (params.manualCompletion !== undefined) {
			if (typeof params.manualCompletion !== "boolean") {
				throw new Error("manualCompletion must be a boolean");
			}
			change.manualCompletion = params.manualCompletion;
		}

		// Keyed on which params were provided, never on the verdict: a same-value
		// --title is a quiet no-op, not an error.
		if (
			params.title === undefined
			&& params.description === undefined
			&& priority === undefined
			&& params.manualCompletion === undefined
			&& params.taskType === undefined
		) {
			throw new Error("Nothing to update. Provide --title, --description, --priority, --manual-completion, or --type.");
		}

		let updated = task;
		let titlePreserved = false;
		if (Object.keys(change).length > 0) {
			const result = await updateTaskMetadata(boardPorts, project, task.id, change, AGENT_ACTOR);
			updated = result.task;
			titlePreserved = result.rejected.includes("title");
		}
		if (priority !== undefined) {
			const changed = await data.setTaskPriority(project, task.id, priority);
			for (const t of changed) getPushMessage()?.("taskUpdated", { projectId: project.id, task: t });
			updated = { ...updated, priority };
		}
		// Tell the agent that has to honour the new role. A task with no worktree has
		// no session to tell — it reads the rewritten description at launch instead,
		// which is why the description is rewritten above rather than only here.
		let roleDelivery: AgentPromptDeliveryStatus | "no-session" | "printed" | undefined;
		if (taskTypeChange) {
			if (printRole) {
				// Delivering here would type the brief into the pane of the very agent
				// that is already reading it in this command's output: a second copy, a
				// second turn, and a role change that looks like it fired twice.
				roleDelivery = "printed";
			} else if (!updated.worktreePath) {
				roleDelivery = "no-session";
			} else {
				try {
					roleDelivery = (await deliverAgentPrompt(updated, taskTypeChange.agentPrompt)).status;
				} catch {
					roleDelivery = "not-delivered";
				}
			}
		}
		return {
			task: updated,
			titlePreserved,
			...(roleDelivery ? { roleDelivery } : {}),
			...(rolePrompt === undefined ? {} : { rolePrompt }),
			...(rolePromptSource ? { rolePromptSource } : {}),
		};
	},

	/**
	 * Preview/operator surface for the task's PRIMARY terminal backend (seq 1292).
	 *
	 * Read-only without `to`. With `to` it flips the persisted identity — refused
	 * while either backend still owns a live session for this task, because live
	 * terminal state is never migrated between backends: you stop the session
	 * first, then switch. The expert equivalent of the Task Detail modal's
	 * per-task override — both share the gate in `task-terminal-backend-switch`.
	 */
	"task.terminalBackend": async (params) => {
		const { project, task } = await resolveTaskFromParams(params);
		if (params.to === undefined) {
			const state = await readTaskTerminalBackendState(task);
			return { taskId: task.id, projectId: project.id, ...state };
		}
		const { task: updated, state } = await switchTaskTerminalBackend(project, task, String(params.to));
		getPushMessage()?.("taskUpdated", { projectId: project.id, task: updated });
		return { taskId: updated.id, projectId: project.id, ...state, liveBackend: null };
	},

	/**
	 * `dev3 task open` — navigate the running UI to a task from outside the app.
	 * Deliberately the same two paths as an inbound `dev3://task/<id>` link
	 * (decisions/2026/08/04/dev3-url-scheme-deep-links.md), so the open-mode
	 * preference and the cold-start pull-on-mount come for free.
	 *
	 * The window layer is imported lazily and never in headless remote mode,
	 * which has no windows and must not drag in electrobun.
	 */
	"task.open": async (params) => {
		const { project, task } = await resolveTaskFromParams(params);
		const nav: DeepLinkNav = { kind: "task", taskId: task.id, projectId: project.id };
		if (process.env.DEV3_HEADLESS !== "1") {
			const { focusFocusedWindow, getWindowCount, openNewWindow } = await import("../window-manager");
			if (getWindowCount() === 0) {
				markPendingDeepLinkNav(nav);
				openNewWindow();
				return { taskId: task.id, projectId: project.id, delivered: true, reopened: true };
			}
			focusFocusedWindow();
		}
		const push = getPushMessage();
		if (!push) return { taskId: task.id, projectId: project.id, delivered: false };
		push("openDeepLink", nav);
		return { taskId: task.id, projectId: project.id, delivered: true };
	},

	"task.setLabels": (params) => changeTaskLabels(params, "replace"),
	// Separate methods rather than a `mode` param on setLabels: an older app would
	// ignore an unknown param and REPLACE the set, while an unknown method fails safe.
	"task.addLabels": (params) => changeTaskLabels(params, "add"),
	"task.removeLabels": (params) => changeTaskLabels(params, "remove"),

	...withSenderVariant("task.move", async (params) => {
		const taskId = params.taskId as string;
		const newStatus = params.newStatus as string;
		if (!taskId) throw new Error("taskId is required");
		if (!newStatus) throw new Error("newStatus is required");

		let project: Project;
		let task: Task;

		if (params.projectId) {
			project = await data.getProject(params.projectId as string);
			const tasks = await data.loadTasks(project);
			const found = findTaskByRef(tasks, taskId);
			if (!found) throw await scopedTaskNotFoundError(taskId, project);
			task = found;
		} else {
			const found = await resolveTaskAcrossProjects(taskId);
			if (!found) throw taskNotFoundError(taskId);
			project = found.project;
			task = found.task;
		}

		const ifStatus = params.ifStatus as string | undefined;
		const ifStatusNot = params.ifStatusNot as string | undefined;
		// Check if this is a custom column ID
		const customColumns = project.customColumns ?? [];
		const customColumn = findByIdPrefix(customColumns, newStatus, "custom column");
		if (customColumn) {
			if (senderRequester(params)) throw new Error(SENDER_MOVE_REFUSED);
			if (launchSuggestionRequested(params)) throw new Error("--agent/--config only apply when the move asks to start another task's agent — a custom column is a plain move.");
			return moveTask({
				taskId: task.id,
				projectId: project.id,
				customColumnId: customColumn.id,
				ifStatus,
				ifStatusNot,
			});
		}

		// Validate as a built-in status
		const builtinStatus = newStatus as TaskStatus;
		if (!ALL_STATUSES.includes(builtinStatus)) {
			const validCustomIds = customColumns.length > 0
				? `, or one of these custom column IDs: ${customColumns.map((c: CustomColumn) => `${c.id.slice(0, 8)} (${c.name})`).join(", ")}`
				: "";
			throw new Error(`Invalid status: "${newStatus}". Valid built-in statuses: ${ALL_STATUSES.join(", ")}${validCustomIds}`);
		}

		// An agent setting SOMEONE ELSE'S task running is a launch, not a board
		// move: it creates a worktree and boots an agent. That needs the user's
		// explicit go-ahead plus their agent pick, so it detours through the
		// approval dialog. An agent moving its OWN task (every status hook) and a
		// human at a terminal (no sourceTaskId) both stay on the silent path.
		// A registered external sender (`--as-sender`) starting a task gets the same
		// dialog an agent does — and its auto-approve setting. No opt-out.
		const sender = senderRequester(params);
		const requester = sender ?? await resolveAgentMessageSource(params, task.id);
		const isActivation = !ACTIVE_STATUSES.includes(task.status) && ACTIVE_STATUSES.includes(builtinStatus);
		// A sender's only power is a start through the dialog: a plain move of a
		// running task could still launch a column agent (`review-by-*`) silently.
		if (sender && !isActivation) {
			if (task.status === builtinStatus) return task;
			throw new Error(SENDER_MOVE_REFUSED);
		}
		const sourceTaskId = typeof params.sourceTaskId === "string" ? params.sourceTaskId.trim() : "";
		// A task's own agent never starts its To Do card again: after a reset the
		// agent is dying, and its hooks (every tool call) must stay a quiet no-op.
		if (isActivation && task.status === "todo" && sourceTaskId && sourceTaskId === task.id) {
			log.info("Ignoring own-agent activation of a To Do task", { taskId: task.id.slice(0, 8), to: builtinStatus });
			return task;
		}
		const isLaunch = requester && isActivation && !isStatusGuardBlocked(task.status, { ifStatus, ifStatusNot });
		if (launchSuggestionRequested(params) && !isLaunch) {
			throw new Error("--agent/--config only apply when the move asks to start another task's agent — this one is a plain move.");
		}
		if (isLaunch) {
			return requestAgentLaunchApproval({
				project,
				task,
				targetStatus: builtinStatus,
				requester: sender ?? await withSenderAgent(requester as AgentMessageSource, params),
				launcherNote: launcherHandoffNote(params),
				suggested: await resolveLaunchSuggestion(params),
			});
		}

		return moveTask({
			taskId: task.id,
			projectId: project.id,
			newStatus: builtinStatus,
			ifStatus,
			ifStatusNot,
			enforceAllowedTransition: true,
			// No task context = an explicit command from outside any task (a person,
			// a script). It keeps today's plain-move trust to start a To Do card and
			// nothing more — it is never reset consent (that is `task.requestReset`).
			...(sourceTaskId ? {} : { explicitLaunch: true }),
		});
	}),

	// `dev3 task hibernate` / `dev3 task wake`. An agent asking (sourceTaskId)
	// gets the launch dialog with its auto-approve countdown; a person at a
	// terminal acts directly, as if they had clicked the button.
	"task.hibernate": async (params) => {
		const { project, task } = await resolveTaskFromParams(params);
		const requester = await resolveRequesterTask(params);
		const { hibernateCliTask } = await import("../cli-task-session");
		return hibernateCliTask({ project, task, requester });
	},

	"task.wake": async (params) => {
		const mode = params.mode;
		if (mode !== "shell" && mode !== "resume") throw new Error('mode must be "shell" or "resume"');
		const { project, task } = await resolveTaskFromParams(params);
		const requester = await resolveRequesterTask(params);
		const { wakeCliTask } = await import("../cli-task-session");
		return wakeCliTask({ project, task, requester, mode, allowAgentLatest: params.allowAgentLatest === true });
	},

	// Agent-initiated request to complete a task. Blocks until the user
	// approves or declines in the app UI. Approval executes the move even if
	// the requesting CLI has already disconnected (its tmux session may have
	// hit a client-side timeout while the dialog stayed open).
	"task.requestCompletion": async (params) => requestDestructiveApproval("complete", params),

	// Agent-initiated request to CANCEL a task — an agent cleaning up a task it
	// should not have created. Same approval model as `task.requestCompletion`,
	// deliberately a separate kind and a separate push: cancelling throws the
	// work away, and the dialog asking for it must not look like the other one.
	// Never auto-approved (no `autoApproveAfterMs`) — nobody loses a worktree to
	// a dialog they never saw.
	"task.requestCancellation": async (params) => requestDestructiveApproval("cancel", params),

	// `dev3 task move --status todo`. A task that needs a reset (active, or still
	// owning a worktree) is reset only after the user approves it in the app —
	// from any caller, task context or not. Never auto-approved; a request whose
	// run ends first is voided, not approved. Anything else is a plain move.
	"task.requestReset": async (params) => requestDestructiveApproval("reset", params),

	// Read-only: where a completion/cancellation request stands. Never creates,
	// joins or answers one — it is what a CLI asks after its wait timed out.
	"approval.status": async (params) => {
		const kind = params.kind;
		if (kind !== "complete" && kind !== "cancel" && kind !== "reset") throw new Error('kind must be "complete", "cancel" or "reset"');
		const { task } = await resolveTaskFromParams(params);
		return approvalStatusOf(kind, task);
	},

	// How long an approval can take, asked BEFORE the blocking request that waits
	// for it. The CLI's own socket timeout is a fixed 10 minutes, so a delay longer
	// than that used to kill the waiting agent before the timer it was waiting on
	// could ever fire. Cheap and non-blocking on purpose — it is on the hot path of
	// every launch request.
	"approval.policy": async () => {
		return { autoApproveMs: agentLaunchAutoApproveMs(await loadSettings()) };
	},
};
