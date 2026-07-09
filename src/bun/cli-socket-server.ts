import { existsSync, readdirSync, unlinkSync, mkdirSync } from "node:fs";
import type { CliRequest, CliResponse, CustomColumn, Label, Project, Task, TaskStatus, TaskNote, NoteSource, SharedArtifact, SharedImage } from "../shared/types";
import { ALL_STATUSES, DEV3_REPO_CONFIG_KEYS, ID_PREFIX_MIN_LENGTH, LABEL_COLORS, MAX_SHARED_ARTIFACTS_PER_TASK, MAX_SHARED_IMAGES_PER_TASK, getAllowedTransitions, getTaskTitle, isStatusGuardBlocked, titleFromDescription } from "../shared/types";
import { CODEX_STATUS_HOOK_EVENTS, getCodexHookTargetStatus, type CodexStatusHookEvent } from "../shared/agent-hooks";
import { SharedImageError, deleteSharedImageFiles, pruneSharedImages, saveSharedImage } from "./shared-images";
import { SharedArtifactError, deleteSharedArtifactFiles, pruneSharedArtifacts, saveSharedArtifact } from "./shared-artifacts";
import { addAutomation, deleteAutomation, loadAutomations, updateAutomation } from "./automations-data";
import { createCompletionRequest } from "./completion-requests";
import * as data from "./data";
import { isActive, activateTask, getPushMessage, getPushMessageLocal, moveTask, triggerColumnAgentIfNeeded, notifyWatchedTaskStatusChange, notifyFromCliDesktop, isAppForeground, getActiveContext } from "./rpc-handlers";
import { getDevServerStatus, runDevServer, stopDevServer, restartDevServer } from "./rpc-handlers/tmux-pty";
import { getTmuxLayout } from "./pty-server";
import { getUserIdleSeconds } from "./user-activity";
import * as repoConfig from "./repo-config";
import { loadSettings } from "./settings";
import { addVent } from "./vents";
import { createLogger } from "./logger";
import { DEV3_HOME } from "./paths";
import { flushAndEnd, drainSocket, pendingWrites } from "./socket-backpressure";

const log = createLogger("cli-socket");

const MIN_PREFIX_LENGTH = ID_PREFIX_MIN_LENGTH;

function findByIdPrefix<T extends { id: string }>(items: T[], prefix: string, entityName: string): T | null {
	const exact = items.find((item) => item.id === prefix);
	if (exact) return exact;

	if (prefix.length < MIN_PREFIX_LENGTH) return null;

	const matches = items.filter((item) => item.id.startsWith(prefix));
	if (matches.length === 0) return null;
	if (matches.length > 1) {
		const ids = matches.map((m) => m.id.slice(0, 12)).join(", ");
		throw new Error(`Ambiguous ${entityName} prefix "${prefix}" matches ${matches.length} items (${ids}). Use a longer prefix.`);
	}
	return matches[0];
}

const SOCKETS_DIR = `${DEV3_HOME}/sockets`;
const MAX_CLI_REQUEST_BYTES = 1024 * 1024;
let socketPath = "";
const pendingRequestText = new Map<unknown, string>();

export function getSocketPath(): string {
	return socketPath;
}

function formatKiB(bytes: number): number {
	return Math.ceil(bytes / 1024);
}

function payloadTooLargeMessage(bytes: number): string {
	return `Payload exceeded ${formatKiB(MAX_CLI_REQUEST_BYTES)} KB limit, current size ${formatKiB(bytes)} KB`;
}

function cleanupStaleSockets(): void {
	if (!existsSync(SOCKETS_DIR)) return;

	for (const file of readdirSync(SOCKETS_DIR)) {
		if (!file.endsWith(".sock")) continue;
		const pid = parseInt(file.replace(".sock", ""), 10);
		if (isNaN(pid)) continue;

		try {
			// Check if process is alive (signal 0 = no signal, just check)
			process.kill(pid, 0);
		} catch {
			// Process is dead — remove stale socket
			const stalePath = `${SOCKETS_DIR}/${file}`;
			log.info("Removing stale socket", { path: stalePath, pid });
			try {
				unlinkSync(stalePath);
			} catch {
				// Ignore cleanup errors
			}
		}
	}
}

async function resolveTaskAcrossProjects(taskId: string): Promise<{ project: Project; task: Task } | null> {
	// Scan virtual ("Operations") boards too, so `dev3` commands run from inside
	// an operation worktree (no explicit --project) can resolve their task.
	const projects = [...await data.loadProjects(), ...await data.loadVirtualProjects()];
	for (const project of projects) {
		try {
			const tasks = await data.loadTasks(project);
			const task = findByIdPrefix(tasks, taskId, "task");
			if (task) return { project, task };
		} catch (err) {
			// Re-throw ambiguity errors, skip broken task files
			if (err instanceof Error && err.message.startsWith("Ambiguous")) throw err;
		}
	}
	return null;
}

async function resolveTaskFromParams(params: Record<string, unknown>): Promise<{ project: Project; task: Task }> {
	const taskId = params.taskId as string;
	if (!taskId) throw new Error("taskId is required");

	if (params.projectId) {
		const project = await data.getProject(params.projectId as string);
		const tasks = await data.loadTasks(project);
		const task = findByIdPrefix(tasks, taskId, "task");
		if (!task) throw new Error(`Task not found: ${taskId}`);
		return { project, task };
	}

	const found = await resolveTaskAcrossProjects(taskId);
	if (!found) throw new Error(`Task not found: ${taskId}`);
	return found;
}

type Handler = (params: Record<string, unknown>) => Promise<unknown>;

// An approval temporarily moves a task to user-questions. Remember which
// active lane that Codex session came from so PostToolUse can restore a review
// agent to review-by-ai instead of misclassifying it as the primary agent.
const CODEX_APPROVAL_RESUME_TTL_MS = 24 * 60 * 60 * 1000;
const codexApprovalResumeStatuses = new Map<
	string,
	{ status: "in-progress" | "review-by-ai"; expiresAt: number }
>();

function getCodexApprovalResumeStatus(
	key: string | null,
): "in-progress" | "review-by-ai" | undefined {
	if (!key) return undefined;
	const entry = codexApprovalResumeStatuses.get(key);
	if (!entry) return undefined;
	if (entry.expiresAt <= Date.now()) {
		codexApprovalResumeStatuses.delete(key);
		return undefined;
	}
	return entry.status;
}

const handlers: Record<string, Handler> = {
	// Cross-instance notification: another dev-3.0 instance changed data.
	// Re-read from disk and push to local renderer only (no re-broadcast).
	"_notify": async (params) => {
		const event = params.event as string;
		const projectId = params.projectId as string;
		const taskId = params.taskId as string | undefined;
		const localPush = getPushMessageLocal();
		if (!localPush) return {};

		try {
			if (event === "taskUpdated" && projectId && taskId) {
				const project = await data.getProject(projectId);
				const tasks = await data.loadTasks(project);
				const task = tasks.find((t) => t.id === taskId);
				if (task) localPush("taskUpdated", { projectId, task });
			} else if (event === "projectUpdated" && projectId) {
				const project = await data.getProject(projectId);
				localPush("projectUpdated", { project });
			}
		} catch (err) {
			log.debug("_notify handler error (non-fatal)", { event, error: String(err) });
		}
		return {};
	},

	"projects.list": async () => {
		// Merge virtual ("Operations") boards so the CLI sees the same project set
		// as the app (matches getProjects in app-handlers).
		return [...await data.loadProjects(), ...await data.loadVirtualProjects()];
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

	"task.show": async (params) => {
		const taskId = params.taskId as string;
		if (!taskId) throw new Error("taskId is required");

		if (params.projectId) {
			const project = await data.getProject(params.projectId as string);
			return data.getTask(project, taskId);
		}

		const found = await resolveTaskAcrossProjects(taskId);
		if (!found) throw new Error(`Task not found: ${taskId}`);
		return found.task;
	},

	"task.create": async (params) => {
		const projectId = params.projectId as string;
		const title = params.title as string;
		const description = (params.description as string | undefined)?.trim() || "";
		if (!projectId) throw new Error("projectId is required");
		if (!title) throw new Error("title is required");

		const project = await data.getProject(projectId);
		// Use description as the task body if provided, otherwise fall back to title
		const task = await data.addTask(project, description || title, "todo");
		// If a separate title was given alongside a description, store it as customTitle
		if (description && title) {
			const updated = await data.updateTask(project, task.id, { customTitle: title });
			getPushMessage()?.("taskUpdated", { projectId: project.id, task: updated });
			return updated;
		}
		getPushMessage()?.("taskUpdated", { projectId: project.id, task });
		return task;
	},

	"task.update": async (params) => {
		const taskId = params.taskId as string;
		if (!taskId) throw new Error("taskId is required");

		let project: Project;
		let task: Task;

		if (params.projectId) {
			project = await data.getProject(params.projectId as string);
			const tasks = await data.loadTasks(project);
			const found = findByIdPrefix(tasks, taskId, "task");
			if (!found) throw new Error(`Task not found: ${taskId}`);
			task = found;
		} else {
			const found = await resolveTaskAcrossProjects(taskId);
			if (!found) throw new Error(`Task not found: ${taskId}`);
			project = found.project;
			task = found.task;
		}

		const updates: Partial<Task> = {};
		const force = Boolean(params.force);
		let titlePreserved = false;
		if (params.title !== undefined) {
			const newTitle = (params.title as string) || null;
			// Defensive guard: refuse to overwrite a UI-set title from the CLI
			// unless --force is passed. The agent skill instructs agents to
			// leave user-edited titles alone, and this is the backstop.
			// We key off `titleEditedByUser` — NOT `customTitle != null` — so
			// that titles previously set by another agent (via this same CLI
			// path) remain rewritable. Empty string (--title "") still goes
			// through as an explicit reset, even when the user edited it.
			if (newTitle && task.titleEditedByUser && !force) {
				titlePreserved = true;
			} else {
				updates.customTitle = newTitle;
				// CLI writes never claim a user edit — only the UI rename RPC does.
				// When the user explicitly clears their title via --title "" we
				// also drop the user-edit flag so future agents can rename again.
				if (!newTitle) updates.titleEditedByUser = false;
			}
		}
		if (params.description !== undefined) {
			const description = params.description as string;
			updates.description = description;
			if (
				task.scratch === true
				&& description.trim()
				&& !/^Scratch — \d{2}:\d{2}$/.test(description.trim())
			) {
				updates.scratch = false;
			}
			// Only recompute auto-title if there's no custom override
			if (!task.customTitle && !updates.customTitle) {
				updates.title = titleFromDescription(description);
			}
		}

		if (Object.keys(updates).length === 0 && !titlePreserved) {
			throw new Error("Nothing to update. Provide --title or --description.");
		}

		let updated = task;
		if (Object.keys(updates).length > 0) {
			updated = await data.updateTask(project, task.id, updates);
			getPushMessage()?.("taskUpdated", { projectId: project.id, task: updated });
		}
		return { task: updated, titlePreserved };
	},

	"overview.set": async (params) => {
		const overview = params.overview as string | undefined;
		if (typeof overview !== "string" || !overview.trim()) {
			throw new Error("overview text is required");
		}
		const { project, task } = await resolveTaskFromParams(params);
		const updated = await data.updateTask(project, task.id, { overview: overview.trim() });
		getPushMessage()?.("taskUpdated", { projectId: project.id, task: updated });
		return updated;
	},

	"overview.show": async (params) => {
		const { task } = await resolveTaskFromParams(params);
		return {
			overview: task.overview ?? null,
			userOverview: task.userOverview ?? null,
			description: task.description,
		};
	},

	"overview.clear": async (params) => {
		const { project, task } = await resolveTaskFromParams(params);
		const updated = await data.updateTask(project, task.id, { overview: null });
		getPushMessage()?.("taskUpdated", { projectId: project.id, task: updated });
		return updated;
	},

	"note.add": async (params) => {
		const taskId = params.taskId as string;
		const content = params.content as string;
		if (!taskId) throw new Error("taskId is required");
		if (!content) throw new Error("content is required");

		let project: Project;
		let task: Task;

		if (params.projectId) {
			project = await data.getProject(params.projectId as string);
			const tasks = await data.loadTasks(project);
			const found = findByIdPrefix(tasks, taskId, "task");
			if (!found) throw new Error(`Task not found: ${taskId}`);
			task = found;
		} else {
			const found = await resolveTaskAcrossProjects(taskId);
			if (!found) throw new Error(`Task not found: ${taskId}`);
			project = found.project;
			task = found.task;
		}

		// Recompute the notes array from the CURRENT task inside the per-task lock.
		// Appending to a pre-lock snapshot (`task.notes`) races with any concurrent
		// note write — two parallel `dev3 note add` calls (routine for multi-variant
		// bug-hunters) would both read the same snapshot and the last writer would
		// silently drop the other's note. Mirrors the RPC addTaskNote handler.
		const { task: updated } = await data.updateTaskWith(project, task.id, async (current) => {
			const now = new Date().toISOString();
			const note: TaskNote = {
				id: crypto.randomUUID(),
				content,
				source: (params.source as NoteSource) ?? "ai",
				createdAt: now,
				updatedAt: now,
			};
			return { updates: { notes: [...(current.notes ?? []), note] }, result: note };
		});
		getPushMessage()?.("taskUpdated", { projectId: project.id, task: updated });
		return updated;
	},

	"note.list": async (params) => {
		const taskId = params.taskId as string;
		if (!taskId) throw new Error("taskId is required");

		let task: Task;

		if (params.projectId) {
			const project = await data.getProject(params.projectId as string);
			task = await data.getTask(project, taskId);
		} else {
			const found = await resolveTaskAcrossProjects(taskId);
			if (!found) throw new Error(`Task not found: ${taskId}`);
			task = found.task;
		}

		return task.notes ?? [];
	},

	"note.delete": async (params) => {
		const taskId = params.taskId as string;
		const noteId = params.noteId as string;
		if (!taskId) throw new Error("taskId is required");
		if (!noteId) throw new Error("noteId is required");

		let project: Project;
		let task: Task;

		if (params.projectId) {
			project = await data.getProject(params.projectId as string);
			const tasks = await data.loadTasks(project);
			const found = findByIdPrefix(tasks, taskId, "task");
			if (!found) throw new Error(`Task not found: ${taskId}`);
			task = found;
		} else {
			const found = await resolveTaskAcrossProjects(taskId);
			if (!found) throw new Error(`Task not found: ${taskId}`);
			project = found.project;
			task = found.task;
		}

		// Resolve + filter against the CURRENT task inside the per-task lock so a
		// concurrent note write is not clobbered (same lost-update race the RPC twin
		// avoids via updateTaskWith). Resolving the prefix on the pre-lock snapshot
		// first lets us fail fast with a clear "Note not found" before taking the lock.
		if (!findByIdPrefix(task.notes ?? [], noteId, "note")) {
			throw new Error(`Note not found: ${noteId}`);
		}
		const { task: updated } = await data.updateTaskWith(project, task.id, async (current) => {
			const before = current.notes ?? [];
			const noteToDelete = findByIdPrefix(before, noteId, "note");
			// Vanished between snapshot and lock (concurrent delete) — treat as done.
			const notes = noteToDelete ? before.filter((n) => n.id !== noteToDelete.id) : before;
			return { updates: { notes }, result: undefined };
		});
		getPushMessage()?.("taskUpdated", { projectId: project.id, task: updated });
		return updated;
	},

	"vent.add": async (params) => {
		// Background, fire-and-forget: an agent reporting friction with the dev3
		// platform itself. Always available, no opt-in, no UI — just write the
		// anonymous markdown file to ~/.dev3.0/vents/ for the maintainer to read.
		const name = (params.name as string)?.trim();
		const content = (params.content as string)?.trim();
		if (!name) throw new Error("name is required");
		if (!content) throw new Error("content is required");

		const vent = addVent(name, content);
		return { fileName: vent.fileName };
	},

	"label.list": async (params) => {
		const projectId = params.projectId as string;
		if (!projectId) throw new Error("projectId is required");
		const project = await data.getProject(projectId);
		return project.labels ?? [];
	},

	"label.create": async (params) => {
		const projectId = params.projectId as string;
		const name = (params.name as string)?.trim();
		if (!projectId) throw new Error("projectId is required");
		if (!name) throw new Error("name is required");

		// Build + append the label from the CURRENT project inside the project lock.
		// Reading project.labels before the lock and writing back [...labels, label]
		// races with any concurrent label write (another create, or a label.delete):
		// the last writer clobbers the other's change. updateProjectWith recomputes
		// inside the lock. Mirrors the RPC createLabel handler.
		const { result: label } = await data.updateProjectWith(projectId, async (current) => {
			const labels = current.labels ?? [];
			const usedColors = new Set(labels.map((l) => l.color));
			const color = (params.color as string) ?? LABEL_COLORS.find((c) => !usedColors.has(c)) ?? LABEL_COLORS[labels.length % LABEL_COLORS.length];
			const newLabel: Label = { id: crypto.randomUUID(), name, color };
			return { updates: { labels: [...labels, newLabel] }, result: newLabel };
		});
		getPushMessage()?.("projectUpdated", { project: await data.getProject(projectId) });
		return label;
	},

	"label.delete": async (params) => {
		const projectId = params.projectId as string;
		const labelId = params.labelId as string;
		if (!projectId) throw new Error("projectId is required");
		if (!labelId) throw new Error("labelId is required");

		const project = await data.getProject(projectId);
		const label = findByIdPrefix(project.labels ?? [], labelId, "label");
		if (!label) throw new Error(`Label not found: ${labelId}`);

		// Recompute the surviving labels from the CURRENT project inside the lock so
		// a concurrent label.create is not clobbered (same lost-update race the
		// per-task loop below already avoids). Mirrors the RPC deleteLabel handler.
		await data.updateProjectWith(projectId, async (current) => ({
			updates: { labels: (current.labels ?? []).filter((l) => l.id !== label.id) },
			result: undefined,
		}));
		// Remove from all tasks. Recompute labelIds from the CURRENT task inside the
		// per-task lock (updateTaskWith) — filtering a pre-lock snapshot would clobber
		// any concurrent labelIds change. Mirrors the RPC deleteLabel handler.
		const tasks = await data.loadTasks(project);
		for (const task of tasks.filter((t) => t.labelIds?.includes(label.id))) {
			await data.updateTaskWith(project, task.id, async (currentTask) => ({
				updates: {
					labelIds: (currentTask.labelIds ?? []).filter((id) => id !== label.id),
				},
				result: undefined,
			}));
		}
		getPushMessage()?.("projectUpdated", { project: await data.getProject(projectId) });
		return { deleted: label.id };
	},

	"automations.list": async (params) => {
		const projectId = params.projectId as string;
		if (!projectId) throw new Error("projectId is required");
		const project = await data.getProject(projectId);
		return loadAutomations(project);
	},

	"automations.show": async (params) => {
		const projectId = params.projectId as string;
		const automationId = params.automationId as string;
		if (!projectId) throw new Error("projectId is required");
		if (!automationId) throw new Error("automationId is required");
		const project = await data.getProject(projectId);
		const automations = await loadAutomations(project);
		const automation = findByIdPrefix(automations, automationId, "automation");
		if (!automation) throw new Error(`Automation not found: ${automationId}`);
		return automation;
	},

	"automations.create": async (params) => {
		const projectId = params.projectId as string;
		if (!projectId) throw new Error("projectId is required");
		const project = await data.getProject(projectId);
		const automation = await addAutomation(project, {
			name: params.name as string,
			prompt: params.prompt as string,
			rrule: params.rrule as string,
			timezone: params.timezone as string,
			agentId: (params.agentId as string | undefined) ?? null,
			configId: (params.configId as string | undefined) ?? null,
			...(params.enabled !== undefined ? { enabled: Boolean(params.enabled) } : {}),
			...(params.catchUp !== undefined ? { catchUp: params.catchUp as "skip" | "runOnce" } : {}),
		});
		getPushMessage()?.("automationsUpdated", { projectId: project.id });
		return automation;
	},

	"automations.update": async (params) => {
		const projectId = params.projectId as string;
		const automationId = params.automationId as string;
		if (!projectId) throw new Error("projectId is required");
		if (!automationId) throw new Error("automationId is required");
		const project = await data.getProject(projectId);
		const automations = await loadAutomations(project);
		const automation = findByIdPrefix(automations, automationId, "automation");
		if (!automation) throw new Error(`Automation not found: ${automationId}`);
		const updates: Record<string, unknown> = {};
		for (const key of ["name", "prompt", "rrule", "timezone", "agentId", "configId", "enabled", "catchUp"] as const) {
			if (params[key] !== undefined) updates[key] = params[key];
		}
		const updated = await updateAutomation(project, automation.id, updates);
		getPushMessage()?.("automationsUpdated", { projectId: project.id });
		return updated;
	},

	"automations.delete": async (params) => {
		const projectId = params.projectId as string;
		const automationId = params.automationId as string;
		if (!projectId) throw new Error("projectId is required");
		if (!automationId) throw new Error("automationId is required");
		const project = await data.getProject(projectId);
		const automations = await loadAutomations(project);
		const automation = findByIdPrefix(automations, automationId, "automation");
		if (!automation) throw new Error(`Automation not found: ${automationId}`);
		await deleteAutomation(project, automation.id);
		getPushMessage()?.("automationsUpdated", { projectId: project.id });
		return { deleted: automation.id };
	},

	"automations.run": async (params) => {
		const projectId = params.projectId as string;
		const automationId = params.automationId as string;
		if (!projectId) throw new Error("projectId is required");
		if (!automationId) throw new Error("automationId is required");
		const project = await data.getProject(projectId);
		const automations = await loadAutomations(project);
		const automation = findByIdPrefix(automations, automationId, "automation");
		if (!automation) throw new Error(`Automation not found: ${automationId}`);
		// Lazy import: the scheduler pulls in the full task-creation pipeline
		// (worktree/PTY/Electrobun), which must not load at module-import time
		// for this file (unit tests import it with the pipeline mocked out).
		const { runAutomationNow } = await import("./automations-scheduler");
		return runAutomationNow(project, automation);
	},

	"task.setLabels": async (params) => {
		const taskId = params.taskId as string;
		const projectId = params.projectId as string;
		const rawLabelIds = params.labelIds as string[];
		if (!taskId) throw new Error("taskId is required");
		if (!projectId) throw new Error("projectId is required");
		if (!Array.isArray(rawLabelIds)) throw new Error("labelIds must be an array");

		const project = await data.getProject(projectId);
		const projectLabels = project.labels ?? [];

		// Resolve short label ID prefixes to full UUIDs, rejecting any that do not
		// match a real project label. The CLI does not validate, so without this an
		// id typo would be persisted verbatim into task.labelIds as permanent garbage
		// (nothing prunes dangling labelIds, unlike customColumnId), the UI would
		// silently render zero labels for it, and the CLI would still report success.
		const unknown: string[] = [];
		const labelIds = rawLabelIds.map((raw) => {
			const found = findByIdPrefix(projectLabels, raw, "label");
			if (found) return found.id;
			unknown.push(raw);
			return raw;
		});
		if (unknown.length > 0) {
			throw new Error(
				`Label not found: ${unknown.join(", ")}. Run "dev3 label list" to see valid label IDs.`,
			);
		}

		const task = await data.updateTask(project, taskId, { labelIds });
		getPushMessage()?.("taskUpdated", { projectId: project.id, task });
		return task;
	},

	"task.agentHook": async (params) => {
		const { project, task } = await resolveTaskFromParams(params);
		const event = params.event as CodexStatusHookEvent;
		if (!CODEX_STATUS_HOOK_EVENTS.includes(event)) {
			throw new Error(`Unsupported Codex hook event: ${String(params.event)}`);
		}
		const sessionId = typeof params.sessionId === "string" ? params.sessionId : null;
		const resumeKey = sessionId ? `${task.id}:${sessionId}` : null;
		const rememberedResumeStatus = getCodexApprovalResumeStatus(resumeKey);

		const settings = await loadSettings();
		const { task: updated, result } = await data.updateTaskWith(
			project,
			task.id,
			(current) => {
				const target = getCodexHookTargetStatus(
					event,
					current.status,
					project.autoReviewEnabled === true,
					rememberedResumeStatus,
				);
				const changed = target !== null && (
					current.status !== target || current.customColumnId != null
				);
				return {
					updates: changed ? { status: target, customColumnId: null } : {},
					result: {
						changed,
						oldStatus: current.status,
						target,
						resumeStatus: event === "PermissionRequest"
							&& (current.status === "in-progress" || current.status === "review-by-ai")
							? current.status
							: null,
						clearResumeStatus: rememberedResumeStatus !== undefined
							&& current.status === "user-questions"
							&& target === rememberedResumeStatus,
					},
				};
			},
			{ dropPosition: settings.taskDropPosition },
		);
		if (resumeKey && result.resumeStatus) {
			codexApprovalResumeStatuses.set(resumeKey, {
				status: result.resumeStatus,
				expiresAt: Date.now() + CODEX_APPROVAL_RESUME_TTL_MS,
			});
		} else if (resumeKey && result.clearResumeStatus) {
			codexApprovalResumeStatuses.delete(resumeKey);
		}

		if (result.changed && result.target) {
			getPushMessage()?.("taskUpdated", { projectId: project.id, task: updated });
			notifyWatchedTaskStatusChange(updated, result.oldStatus, result.target, project.name);
			await triggerColumnAgentIfNeeded(result.target, project, updated);
		}

		return updated;
	},

	"task.move": async (params) => {
		const taskId = params.taskId as string;
		const newStatus = params.newStatus as string;
		if (!taskId) throw new Error("taskId is required");
		if (!newStatus) throw new Error("newStatus is required");

		let project: Project;
		let task: Task;

		if (params.projectId) {
			project = await data.getProject(params.projectId as string);
			const tasks = await data.loadTasks(project);
			const found = findByIdPrefix(tasks, taskId, "task");
			if (!found) throw new Error(`Task not found: ${taskId}`);
			task = found;
		} else {
			const found = await resolveTaskAcrossProjects(taskId);
			if (!found) throw new Error(`Task not found: ${taskId}`);
			project = found.project;
			task = found.task;
		}

		const ifStatus = params.ifStatus as string | undefined;
		const ifStatusNot = params.ifStatusNot as string | undefined;
		const guardOpts = {
			...(ifStatus ? { ifStatus } : {}),
			...(ifStatusNot ? { ifStatusNot } : {}),
		};

		// Check if this is a custom column ID
		const customColumns = project.customColumns ?? [];
		const customColumn = findByIdPrefix(customColumns, newStatus, "custom column");
		if (customColumn) {
			// Moving from completed/cancelled into a custom column resumes the task
			if (task.status === "completed" || task.status === "cancelled") {
				// Pre-check the guard before activateTask so a blocked move does not
				// leak a worktree/PTY. The authoritative check still runs inside the lock.
				if (isStatusGuardBlocked(task.status, guardOpts)) {
					return task;
				}
				const settings = await loadSettings();
				const wt = await activateTask(project, task, { isReopen: true });
				const updated = await data.updateTask(project, task.id, {
					status: "in-progress",
					worktreePath: wt.worktreePath,
					branchName: wt.branchName,
					customColumnId: customColumn.id,
				}, { dropPosition: settings.taskDropPosition, ...guardOpts });
				if (updated.status === "in-progress" && updated.customColumnId === customColumn.id) {
					getPushMessage()?.("taskUpdated", { projectId: project.id, task: updated });
				}
				// Trigger column agent if configured
				if (customColumn.agentConfig && updated.worktreePath && updated.customColumnId === customColumn.id) {
					await triggerColumnAgentIfNeeded(updated.status, project, updated, { customColumn });
				}
				return updated;
			}
			const settings = await loadSettings();
			const updated = await data.updateTask(
				project,
				task.id,
				{ customColumnId: customColumn.id },
				{ dropPosition: settings.taskDropPosition, ...guardOpts },
			);
			if (updated.customColumnId === customColumn.id) {
				getPushMessage()?.("taskUpdated", { projectId: project.id, task: updated });
			}
			// Trigger column agent if configured
			if (customColumn.agentConfig && updated.worktreePath && updated.customColumnId === customColumn.id) {
				await triggerColumnAgentIfNeeded(updated.status, project, updated, { customColumn });
			}
			return updated;
		}

		// Validate as a built-in status
		const builtinStatus = newStatus as TaskStatus;
		if (!ALL_STATUSES.includes(builtinStatus)) {
			const validCustomIds = customColumns.length > 0
				? `, or one of these custom column IDs: ${customColumns.map((c: CustomColumn) => `${c.id.slice(0, 8)} (${c.name})`).join(", ")}`
				: "";
			throw new Error(`Invalid status: "${newStatus}". Valid built-in statuses: ${ALL_STATUSES.join(", ")}${validCustomIds}`);
		}

		if (task.status === builtinStatus && !task.customColumnId) {
			return task;
		}

		// If moving from a custom column to a built-in status, allow any transition from the task's current status
		const oldStatus = task.status;
		if (!task.customColumnId) {
			const allowed = getAllowedTransitions(oldStatus);
			if (!allowed.includes(builtinStatus)) {
				throw new Error(
					`Cannot move task from "${oldStatus}" to "${builtinStatus}". Allowed: ${allowed.join(", ")}`,
				);
			}
		}
		const settings = await loadSettings();
		const moveOpts = { dropPosition: settings.taskDropPosition, ...guardOpts } as const;

		// inactive → active: create worktree + PTY
		if (!isActive(oldStatus) && isActive(builtinStatus)) {
			// Pre-check the guard before activateTask so a blocked move does not
			// leak a worktree/PTY. The authoritative check still runs inside the lock.
			if (isStatusGuardBlocked(oldStatus, guardOpts)) {
				return task;
			}
			const isReopen = oldStatus === "completed" || oldStatus === "cancelled";
			const wt = await activateTask(project, task, { isReopen });

			const updated = await data.updateTask(project, task.id, {
				status: builtinStatus,
				worktreePath: wt.worktreePath,
				branchName: wt.branchName,
				customColumnId: null,
			}, moveOpts);
			if (updated.status === builtinStatus && !updated.customColumnId) {
				getPushMessage()?.("taskUpdated", { projectId: project.id, task: updated });
				notifyWatchedTaskStatusChange(updated, oldStatus, builtinStatus, project.name);
			}
			return updated;
		}

		if (isActive(oldStatus) && (builtinStatus === "completed" || builtinStatus === "cancelled")) {
			return moveTask({
				taskId: task.id,
				projectId: project.id,
				newStatus: builtinStatus,
				ifStatus,
				ifStatusNot,
			});
		}

		// active → active or status-only change
		const updated = await data.updateTask(project, task.id, { status: builtinStatus, customColumnId: null }, moveOpts);
		if (updated.status === builtinStatus && !updated.customColumnId) {
			getPushMessage()?.("taskUpdated", { projectId: project.id, task: updated });
			notifyWatchedTaskStatusChange(updated, oldStatus, builtinStatus, project.name);

			await triggerColumnAgentIfNeeded(builtinStatus, project, updated);
		}

		return updated;
	},

	// Agent-initiated request to complete a task. Blocks until the user
	// approves or declines in the app UI. Approval executes the move even if
	// the requesting CLI has already disconnected (its tmux session may have
	// hit a client-side timeout while the dialog stayed open).
	"task.requestCompletion": async (params) => {
		const { project, task } = await resolveTaskFromParams(params);
		if (task.status === "completed" || task.status === "cancelled") {
			throw new Error(`Task is already ${task.status}`);
		}
		const push = getPushMessage();
		if (!push) {
			throw new Error("No app window is connected — cannot ask the user for approval");
		}

		const { requestId, decision, isNew } = createCompletionRequest(task.id, project.id);
		if (isNew) {
			// User-edited overview overrides the agent-written one, same as in cards.
			const overview = task.userOverview?.trim() || task.overview?.trim() || undefined;
			push("agentCompletionRequested", {
				requestId,
				taskId: task.id,
				projectId: project.id,
				taskTitle: getTaskTitle(task),
				taskOverview: overview,
			});
		}

		const approved = await decision;
		if (!approved) {
			return { approved: false };
		}
		const updated = await moveTask({ taskId: task.id, projectId: project.id, newStatus: "completed" });
		return { approved: true, task: updated };
	},

	// UI control: surface an in-app toast (or native OS notification) from the CLI.
	"ui.notify": async (params) => {
		const message = ((params.message as string) ?? "").trim();
		if (!message) throw new Error("message is required");
		const rawLevel = (params.level as string) ?? "info";
		if (rawLevel !== "info" && rawLevel !== "success" && rawLevel !== "error") {
			throw new Error(`Invalid level "${rawLevel}". Use info, success, or error.`);
		}
		const level = rawLevel as "info" | "success" | "error";
		const desktop = params.desktop === true;

		// Focus mode: user opted out of agent-initiated attention UI.
		if ((await loadSettings()).focusMode) {
			return { delivered: false, mode: desktop ? "desktop" : "toast", suppressed: true };
		}

		// Resolve the originating task when one is in context, so the toast/notification
		// is clickable and lands the user on it.
		let taskId: string | null = null;
		let projectId: string | null = null;
		let task: Task | null = null;
		let projectName: string | null = null;
		if (params.taskId) {
			const resolved = await resolveTaskFromParams(params);
			task = resolved.task;
			taskId = resolved.task.id;
			projectId = resolved.project.id;
			projectName = resolved.project.name;
		}

		if (desktop) {
			if (!task || !projectId) {
				throw new Error("desktop notification requires a task — run inside a worktree or pass --task <id>");
			}
			notifyFromCliDesktop({
				task,
				body: message,
				projectName: projectName ?? undefined,
			});
			return { delivered: true, mode: "desktop", taskId: task.id };
		}

		const push = getPushMessage();
		if (!push) return { delivered: false, mode: "toast" };
		push("cliToast", {
			taskId,
			projectId,
			message,
			level,
			...(task ? { taskSeq: task.seq, taskTitle: getTaskTitle(task), projectName: projectName ?? undefined } : {}),
		});
		return { delivered: true, mode: "toast", taskId };
	},

	// UI control: light the red attention badge on a task card with a reason.
	"ui.attention": async (params) => {
		const reason = ((params.reason as string) ?? "").trim();
		const { project, task } = await resolveTaskFromParams(params);
		// Focus mode: user opted out of agent-initiated attention UI.
		if ((await loadSettings()).focusMode) {
			return { delivered: false, suppressed: true, taskId: task.id };
		}
		const push = getPushMessage();
		if (!push) return { delivered: false, taskId: task.id };
		push("cliAttention", { taskId: task.id, reason });
		return { delivered: true, taskId: task.id, projectId: project.id };
	},

	// UI control: surface images (screenshots, renders, QA captures) an agent wants
	// the human to look at, bound to the task and kept as a clickable history.
	"ui.show-image": async (params) => {
		const { project, task } = await resolveTaskFromParams(params);
		// Preferred shape: images: [{ path, caption? }] — one note per image.
		// Back-compat: paths: string[] + a single caption applied to all.
		const items: { path: string; caption?: string }[] = [];
		if (Array.isArray(params.images)) {
			for (const raw of params.images as unknown[]) {
				if (!raw || typeof raw !== "object") continue;
				const rec = raw as { path?: unknown; caption?: unknown };
				if (typeof rec.path !== "string" || rec.path.length === 0) continue;
				const caption = typeof rec.caption === "string" && rec.caption.trim() ? rec.caption.trim() : undefined;
				items.push({ path: rec.path, caption });
			}
		} else {
			const rawPaths = Array.isArray(params.paths) ? (params.paths as unknown[]) : [];
			const caption = typeof params.caption === "string" && params.caption.trim() ? params.caption.trim() : undefined;
			for (const p of rawPaths) {
				if (typeof p === "string" && p.length > 0) items.push({ path: p, caption });
			}
		}
		if (items.length === 0) throw new Error("At least one image path is required");

		// Copy every file into the worktree first — fail fast (usage error) if any
		// path is invalid, so the agent gets a clear signal and nothing half-lands.
		let incoming: SharedImage[];
		try {
			incoming = items.map((it) => saveSharedImage(project.path, it.path, it.caption));
		} catch (err) {
			if (err instanceof SharedImageError) throw err;
			throw new Error(`Failed to store image: ${err instanceof Error ? err.message : String(err)}`);
		}

		// Append + enforce the per-task cap inside the file lock; delete pruned files.
		const { task: updated, result: dropped } = await data.updateTaskWith<SharedImage[]>(project, task.id, (current) => {
			const { kept, dropped } = pruneSharedImages(current.sharedImages, incoming, MAX_SHARED_IMAGES_PER_TASK);
			return { updates: { sharedImages: kept }, result: dropped };
		});
		if (dropped.length > 0) deleteSharedImageFiles(dropped);

		// Persist to state everywhere (badge + history) regardless of focus mode.
		getPushMessage()?.("taskUpdated", { projectId: project.id, task: updated });

		// Focus mode: the user opted out of agent-initiated interruptions — keep the
		// history/badge (pushed above) but skip the toast / auto-open / attention.
		if ((await loadSettings()).focusMode) {
			return { delivered: false, suppressed: true, stored: incoming.length, taskId: task.id };
		}

		const push = getPushMessage();
		if (!push) return { delivered: false, stored: incoming.length, taskId: task.id };
		push("cliShowImage", {
			taskId: task.id,
			projectId: project.id,
			images: updated.sharedImages ?? [],
			newCount: incoming.length,
			taskSeq: task.seq,
			taskTitle: getTaskTitle(task),
			projectName: project.name,
		});
		return { delivered: true, stored: incoming.length, taskId: task.id };
	},

	"ui.show-artifact": async (params) => {
		const { project, task } = await resolveTaskFromParams(params);
		const htmlPath = typeof params.htmlPath === "string" ? params.htmlPath : "";
		if (!htmlPath) throw new Error("HTML artifact path is required");
		const imagePaths = Array.isArray(params.imagePaths)
			? params.imagePaths.filter((path): path is string => typeof path === "string" && path.length > 0)
			: [];
		const title = typeof params.title === "string" && params.title.trim() ? params.title.trim() : undefined;

		let incoming: SharedArtifact;
		try {
			incoming = saveSharedArtifact(project.path, htmlPath, imagePaths, title);
		} catch (error) {
			if (error instanceof SharedArtifactError) throw error;
			throw new Error(`Failed to store artifact: ${error instanceof Error ? error.message : String(error)}`);
		}

		const { task: updated, result: dropped } = await data.updateTaskWith<SharedArtifact[]>(project, task.id, (current) => {
			const pruned = pruneSharedArtifacts(current.sharedArtifacts, [incoming], MAX_SHARED_ARTIFACTS_PER_TASK);
			return { updates: { sharedArtifacts: pruned.kept }, result: pruned.dropped };
		});
		if (dropped.length > 0) deleteSharedArtifactFiles(dropped);
		getPushMessage()?.("taskUpdated", { projectId: project.id, task: updated });

		if ((await loadSettings()).focusMode) {
			return { delivered: false, suppressed: true, stored: 1, taskId: task.id };
		}
		const push = getPushMessage();
		if (!push) return { delivered: false, stored: 1, taskId: task.id };
		push("cliShowArtifact", {
			taskId: task.id,
			projectId: project.id,
			artifacts: updated.sharedArtifacts ?? [],
			newCount: 1,
			taskSeq: task.seq,
			taskTitle: getTaskTitle(task),
			projectName: project.name,
		});
		return { delivered: true, stored: 1, taskId: task.id };
	},

	// UI control: report what the app is currently showing, so the agent can decide
	// whether a ping is even needed (e.g. skip if the user is already on this task).
	"ui.state": async (params) => {
		const ctx = getActiveContext();
		const taskId = params.taskId as string | undefined;
		return {
			appRunning: true,
			foreground: isAppForeground(),
			activeProjectId: ctx.projectId,
			activeTaskId: ctx.taskId,
			// Seconds since the user last touched keyboard/mouse (null = unknown).
			// Lets an agent tell whether the user is even at the machine.
			userIdleSeconds: await getUserIdleSeconds(),
			// tmux layout for the requested task (CLI passes the worktree's task id).
			tmux: taskId ? await getTmuxLayout(taskId) : null,
		};
	},

	"devServer.start": async (params) => {
		const { project, task } = await resolveTaskFromParams(params);
		return runDevServer({ taskId: task.id, projectId: project.id });
	},

	"devServer.stop": async (params) => {
		const { project, task } = await resolveTaskFromParams(params);
		return stopDevServer({ taskId: task.id, projectId: project.id });
	},

	"devServer.restart": async (params) => {
		const { project, task } = await resolveTaskFromParams(params);
		return restartDevServer({ taskId: task.id, projectId: project.id });
	},

	"devServer.status": async (params) => {
		const { project, task } = await resolveTaskFromParams(params);
		return getDevServerStatus({ taskId: task.id, projectId: project.id });
	},

	"config.export": async (params) => {
		const projectId = params.projectId as string;
		if (!projectId) throw new Error("projectId is required");
		const worktreePath = params.worktreePath as string | undefined;
		const project = await data.getProject(projectId);
		const configPath = worktreePath || project.path;
		await repoConfig.migrateProjectConfig(project, configPath);
		return { path: `${configPath}/.dev3/config.json` };
	},

	"config.show": async (params) => {
		const projectId = params.projectId as string;
		if (!projectId) throw new Error("projectId is required");
		const worktreePath = params.worktreePath as string | undefined;
		const project = await data.getProject(projectId);
		const configPath = worktreePath || project.path;
		const resolved = await repoConfig.resolveProjectConfig(project, configPath);
		// Full provenance for every key (local/repo/project/default/unset) — the CLI
		// renders it verbatim, so it never has to guess a blanket "global" fallback
		// that would hide whether a value is a real default, a project setting, or
		// genuinely unset. Wider than getConfigSources (repo/local, for the UI badge).
		const provenance = repoConfig.resolveConfigProvenance(resolved, project, configPath);
		const hasRepoFile = repoConfig.hasRepoConfig(configPath);
		return {
			// Map unset fields (no value at any layer and no default — e.g. portCount)
			// to `null` rather than leaving them `undefined`: JSON.stringify drops
			// `undefined` properties, which would silently hide a valid, settable
			// config key from `dev3 config show` and make it undiscoverable. `null`
			// survives serialization and the CLI renders it as "(not set)".
			settings: Object.fromEntries(
				DEV3_REPO_CONFIG_KEYS.map((key) => [key, (resolved as any)[key] ?? null]),
			),
			sources: provenance,
			hasRepoConfig: hasRepoFile,
		};
	},

	// Mint a fresh access URL (with a one-time QR token) for a running headless
	// server. The JWT secret lives only in this process, so a detached
	// `dev3 remote url` can't mint a token itself — it asks us over this socket.
	// Only meaningful in headless mode; a GUI instance has no remote-access
	// server bound, so serverPort is 0 and we say so plainly.
	//
	// The remote-access-server / cloudflare-tunnel modules pull in the electrobun
	// platform shim, so we import them LAZILY here: a static import would drag
	// electrobun into every unit test that merely imports this socket server.
	"remote.accessUrl": async () => {
		const { getAccessUrl, getServerPort, getStaticCode } = await import("./remote-access-server");
		const { getTunnelUrl } = await import("./cloudflare-tunnel");
		if (getServerPort() === 0) {
			throw new Error("Remote access server is not running in this instance (start it with `dev3 remote`).");
		}
		return {
			url: await getAccessUrl(),
			tunnelUrl: getTunnelUrl(),
			port: getServerPort(),
			staticCode: getStaticCode(),
		};
	},
};

export async function handleRequest(req: CliRequest): Promise<CliResponse> {
	const handler = handlers[req.method];
	if (!handler) {
		return { id: req.id, ok: false, error: `Unknown method: ${req.method}` };
	}

	try {
		const result = await handler(req.params);
		return { id: req.id, ok: true, data: result };
	} catch (err) {
		return { id: req.id, ok: false, error: String(err instanceof Error ? err.message : err) };
	}
}

export function startSocketServer(): string {
	mkdirSync(SOCKETS_DIR, { recursive: true });
	cleanupStaleSockets();

	socketPath = `${SOCKETS_DIR}/${process.pid}.sock`;

	// Remove leftover socket file if it exists
	if (existsSync(socketPath)) {
		unlinkSync(socketPath);
	}

	Bun.listen({
		unix: socketPath,
		socket: {
			open() {
				log.debug("CLI client connected");
			},
			async data(socket, raw) {
				const text = typeof raw === "string" ? raw : Buffer.from(raw).toString("utf-8");
				const buffered = pendingRequestText.get(socket) || "";
				const combined = buffered + text;
				const combinedBytes = Buffer.byteLength(combined, "utf-8");

				if (combinedBytes > MAX_CLI_REQUEST_BYTES) {
					pendingRequestText.delete(socket);
					const errResp: CliResponse = {
						id: "unknown",
						ok: false,
						error: payloadTooLargeMessage(combinedBytes),
					};
					flushAndEnd(socket, JSON.stringify(errResp) + "\n");
					return;
				}

				// Handle multiple NDJSON messages in one chunk — accumulate all
				// responses first, then flush once to avoid interleaved partial writes.
				let responseData = "";
				const lines = combined.split("\n");
				const tail = lines.pop() || "";
				if (tail) {
					pendingRequestText.set(socket, tail);
				} else {
					pendingRequestText.delete(socket);
				}

				for (const line of lines) {
					if (!line.trim()) continue;

					let req: CliRequest;
					try {
						req = JSON.parse(line);
					} catch {
						const bytes = Buffer.byteLength(line, "utf-8");
						const errResp: CliResponse = {
							id: "unknown",
							ok: false,
							error: `Invalid JSON in CLI request (${formatKiB(bytes)} KB). The request may be truncated or corrupted.`,
						};
						responseData += JSON.stringify(errResp) + "\n";
						continue;
					}

					const resp = await handleRequest(req);
					responseData += JSON.stringify(resp) + "\n";
				}

				if (responseData) {
					flushAndEnd(socket, responseData);
				}
			},
			drain(socket) {
				drainSocket(socket);
			},
			close(socket) {
				pendingWrites.delete(socket);
				pendingRequestText.delete(socket);
				log.debug("CLI client disconnected");
			},
			error(_socket, error) {
				log.error("CLI socket error", { error: String(error) });
			},
		},
	});

	log.info("CLI socket server started", { path: socketPath });
	return socketPath;
}

export function stopSocketServer(): void {
	if (socketPath && existsSync(socketPath)) {
		try {
			unlinkSync(socketPath);
			log.info("CLI socket removed", { path: socketPath });
		} catch {
			// Ignore cleanup errors
		}
	}
}
