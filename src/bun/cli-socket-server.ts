import { existsSync, readdirSync, unlinkSync, mkdirSync, writeFileSync } from "node:fs";
import type { CliRequest, CliResponse, CustomColumn, Label, Project, Task, TaskStatus, TaskNote, NoteSource, SharedArtifact, SharedImage } from "../shared/types";
import { isValidNotificationDurationMs, NOTIFICATION_MAX_DURATION_MS, NOTIFICATION_MIN_DURATION_MS } from "../shared/duration";
import { socketMetaPathFor, type SocketMeta } from "../shared/socket-meta";
import { ALL_STATUSES, DEV3_REPO_CONFIG_KEYS, ID_PREFIX_MIN_LENGTH, LABEL_COLORS, MAX_SHARED_IMAGES_PER_TASK, buildTaskDialogSubject, getTaskTitle, normalizePriority, titleFromDescription } from "../shared/types";
import { CODEX_STATUS_HOOK_EVENTS, getCodexHookTargetStatus, type CodexStatusHookEvent } from "../shared/agent-hooks";
import { SharedImageError, deleteSharedImageFiles, pruneSharedImages, saveSharedImage } from "./shared-images";
import { SharedArtifactError, saveSharedArtifact } from "./shared-artifacts";
import { addAutomation, deleteAutomation, loadAutomations, updateAutomation } from "./automations-data";
import { createCompletionRequest } from "./completion-requests";
import * as data from "./data";
import { getPushMessage, getPushMessageLocal, moveTask, notifyFromCliDesktop, isAppForeground, getActiveContext, isNotificationSuppressed, pushCliAttention, pushCliToast, pushCliShowImage, pushCliShowArtifact, setFocusMode, clearMergeNotification } from "./rpc-handlers";
import { getDevServerStatus, runDevServer, stopDevServer, restartDevServer } from "./rpc-handlers/tmux-pty";
import { getTmuxLayout } from "./pty-server";
import { scheduleMessage as scheduleMessageCore, sendMessageImmediately } from "./scheduled-message-scheduler";
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
		// Both the socket and its meta sidecar (`<pid>.sock` / `<pid>.meta.json`)
		// are keyed by pid; a SIGKILLed instance leaves both behind.
		if (!file.endsWith(".sock") && !file.endsWith(".meta.json")) continue;
		const pid = parseInt(file.split(".")[0], 10);
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

/**
 * Parse a stable `seq:<N>` task reference. Seq is printed by `task create` and
 * shown on every card; unlike the id it survives launches (all variants of one
 * logical task share it), so it is the safe handle for stored references.
 */
function parseSeqRef(ref: string): number | null {
	const match = /^seq:(\d+)$/.exec(ref);
	return match ? Number(match[1]) : null;
}

/**
 * Resolve a task reference — full id, ≥8-char id prefix, or `seq:<N>` — against
 * one project's task list. Throws on ambiguity (a variant group shares one seq;
 * a short prefix can match several ids), returns null when nothing matches.
 */
function findTaskByRef(tasks: Task[], ref: string): Task | null {
	const seq = parseSeqRef(ref);
	if (seq === null) return findByIdPrefix(tasks, ref, "task");
	const matches = tasks.filter((t) => t.seq === seq);
	if (matches.length > 1) {
		const ids = matches.map((m) => m.id.slice(0, 8)).join(", ");
		throw new Error(`Task ref "${ref}" matches ${matches.length} variant tasks (${ids}). Address one of them by id.`);
	}
	return matches[0] ?? null;
}

/**
 * Actionable not-found error: ids minted before the stable-id fix were re-keyed
 * when the task was launched with variants, so stored ids can dangle — point
 * the caller at the stable seq handle instead of a bare failure.
 */
function taskNotFoundError(ref: string): Error {
	return new Error(
		`Task not found: ${ref}. If the task was launched by an older app version its id may have changed — ` +
		"run `dev3 tasks list` to find it by seq, or address it as `--task seq:<N>`.",
	);
}

async function resolveTaskAcrossProjects(taskId: string): Promise<{ project: Project; task: Task } | null> {
	// Scan virtual ("Operations") boards too, so `dev3` commands run from inside
	// an operation worktree (no explicit --project) can resolve their task.
	const projects = [...await data.loadProjects(), ...await data.loadVirtualProjects()];

	// Seq refs must collect matches across ALL projects instead of returning the
	// first hit: every board counts 1..N, so cross-project collisions are routine
	// and silently picking whichever project iterates first would mutate the
	// wrong task. Id prefixes keep first-match-wins — UUIDs make cross-project
	// collisions unrealistic, and the CLI already guards them (decision 102).
	if (parseSeqRef(taskId) !== null) {
		const matches: Array<{ project: Project; task: Task }> = [];
		for (const project of projects) {
			try {
				const tasks = await data.loadTasks(project);
				const task = findTaskByRef(tasks, taskId);
				if (task) matches.push({ project, task });
			} catch (err) {
				// Re-throw ambiguity errors, skip broken task files
				if (err instanceof Error && err.message.startsWith("Task ref")) throw err;
			}
		}
		if (matches.length > 1) {
			const shown = matches.map((m) => `${m.task.id.slice(0, 8)} (${m.project.name})`).join(", ");
			throw new Error(`Task ref "${taskId}" matches ${matches.length} tasks across projects (${shown}). Pass --project to disambiguate.`);
		}
		return matches[0] ?? null;
	}

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
		const task = findTaskByRef(tasks, taskId);
		if (!task) throw taskNotFoundError(taskId);
		return { project, task };
	}

	const found = await resolveTaskAcrossProjects(taskId);
	if (!found) throw taskNotFoundError(taskId);
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

/**
 * Persist a Codex session id onto the sessionState pane it belongs to, so
 * resumeTask can `codex resume <id>` the exact session per pane — targeted
 * recovery for multi-session worktrees (e.g. reviving several bug hunters).
 * Codex has no launch-time --session-id, so the id is only knowable post-hoc:
 * its lifecycle hook reports the resumable session_id together with $TMUX_PANE
 * (see src/cli/commands/codex-hook.ts).
 *
 * Matching: extra panes store their tmux paneId at spawn, so match by paneId.
 * The main pane (panes[0]) is persisted without a paneId (assigned lazily by
 * pane-exit reconciliation); when no entry matches and exactly one entry has no
 * paneId, adopt that entry — it is the main pane — recording both its paneId and
 * session id. Ambiguous cases (no match, ≠1 null-paneId entries) are skipped; a
 * later hook fires once ids settle. A no-op once the id is already recorded.
 */
async function captureCodexPaneSession(
	project: Project,
	taskId: string,
	paneId: string,
	sessionId: string,
): Promise<void> {
	try {
		const { task: updated, result } = await data.updateTaskWith(project, taskId, (current) => {
			const panes = current.sessionState?.panes;
			if (!panes?.length) return { updates: {}, result: { changed: false } };
			let idx = panes.findIndex((p) => p.paneId === paneId);
			let adoptPaneId = false;
			if (idx === -1) {
				const nullIdxs = panes.flatMap((p, i) => (p.paneId ? [] : [i]));
				if (nullIdxs.length !== 1) return { updates: {}, result: { changed: false } };
				idx = nullIdxs[0];
				adoptPaneId = true;
			}
			if (panes[idx].sessionId === sessionId && !adoptPaneId) {
				return { updates: {}, result: { changed: false } };
			}
			const nextPanes = panes.map((p, i) =>
				i === idx ? { ...p, sessionId, ...(adoptPaneId ? { paneId } : {}) } : p,
			);
			return { updates: { sessionState: { panes: nextPanes } }, result: { changed: true } };
		});
		if (result.changed) {
			getPushMessage()?.("taskUpdated", { projectId: project.id, task: updated });
			log.info("Captured Codex pane session id", { taskId: taskId.slice(0, 8), paneId });
		}
	} catch (err) {
		log.warn("Failed to capture Codex pane session id (non-fatal)", { error: String(err) });
	}
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
			const tasks = await data.loadTasks(project);
			const task = findTaskByRef(tasks, taskId);
			if (!task) throw taskNotFoundError(taskId);
			return task;
		}

		const found = await resolveTaskAcrossProjects(taskId);
		if (!found) throw taskNotFoundError(taskId);
		return found.task;
	},

	"task.create": async (params) => {
		const projectId = params.projectId as string;
		const title = params.title as string;
		const description = (params.description as string | undefined)?.trim() || "";
		if (!projectId) throw new Error("projectId is required");
		if (!title) throw new Error("title is required");

		let priority = undefined;
		if (params.priority !== undefined) {
			priority = normalizePriority(String(params.priority)) ?? undefined;
			if (!priority) throw new Error(`Invalid priority "${params.priority}". Use P0, P1, P2, P3, or P4.`);
		}

		const project = await data.getProject(projectId);
		// Use description as the task body if provided, otherwise fall back to title.
		// Only pass the extras arg when a priority was given (keeps the common 3-arg call).
		const task = priority
			? await data.addTask(project, description || title, "todo", { priority })
			: await data.addTask(project, description || title, "todo");
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
			const found = findTaskByRef(tasks, taskId);
			if (!found) throw taskNotFoundError(taskId);
			task = found;
		} else {
			const found = await resolveTaskAcrossProjects(taskId);
			if (!found) throw taskNotFoundError(taskId);
			project = found.project;
			task = found.task;
		}

		const updates: Partial<Task> = {};
		const force = Boolean(params.force);
		let titlePreserved = false;

		// Priority is group-wide (belongs to the logical task), so it is applied via
		// the dedicated setter below, NOT folded into the single-task `updates` patch.
		let priority = undefined;
		if (params.priority !== undefined) {
			priority = normalizePriority(String(params.priority));
			if (!priority) throw new Error(`Invalid priority "${params.priority}". Use P0, P1, P2, P3, or P4.`);
		}
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
				if (newTitle && task.scratch === true) updates.scratch = false;
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
		let manualCompletion: boolean | undefined;
		if (params.manualCompletion !== undefined) {
			if (typeof params.manualCompletion !== "boolean") {
				throw new Error("manualCompletion must be a boolean");
			}
			manualCompletion = params.manualCompletion;
			if (task.manualCompletion !== manualCompletion) {
				updates.manualCompletion = manualCompletion;
				updates.mergeCompletionPrompt = null;
			}
		}

		if (
			Object.keys(updates).length === 0
			&& priority === undefined
			&& !titlePreserved
			&& params.manualCompletion === undefined
		) {
			throw new Error("Nothing to update. Provide --title, --description, --priority, or --manual-completion.");
		}

		let updated = task;
		if (Object.keys(updates).length > 0) {
			updated = await data.updateTask(project, task.id, updates);
			if (manualCompletion !== undefined && task.manualCompletion !== manualCompletion) {
				clearMergeNotification(task.id);
			}
			getPushMessage()?.("taskUpdated", { projectId: project.id, task: updated });
			if (manualCompletion !== undefined && task.manualCompletion !== manualCompletion) {
				getPushMessage()?.("manualCompletionChanged", {
					taskId: updated.id,
					projectId: project.id,
					manualCompletion,
				});
			}
		}
		if (priority !== undefined) {
			const changed = await data.setTaskPriority(project, task.id, priority);
			for (const t of changed) getPushMessage()?.("taskUpdated", { projectId: project.id, task: t });
			updated = { ...updated, priority };
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
			const found = findTaskByRef(tasks, taskId);
			if (!found) throw taskNotFoundError(taskId);
			task = found;
		} else {
			const found = await resolveTaskAcrossProjects(taskId);
			if (!found) throw taskNotFoundError(taskId);
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
			const tasks = await data.loadTasks(project);
			const found = findTaskByRef(tasks, taskId);
			if (!found) throw taskNotFoundError(taskId);
			task = found;
		} else {
			const found = await resolveTaskAcrossProjects(taskId);
			if (!found) throw taskNotFoundError(taskId);
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
			const found = findTaskByRef(tasks, taskId);
			if (!found) throw taskNotFoundError(taskId);
			task = found;
		} else {
			const found = await resolveTaskAcrossProjects(taskId);
			if (!found) throw taskNotFoundError(taskId);
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

		const target = getCodexHookTargetStatus(
			event,
			task.status,
			project.autoReviewEnabled === true,
			rememberedResumeStatus,
		);
		const resumeStatus = event === "PermissionRequest"
			&& (task.status === "in-progress" || task.status === "review-by-ai")
			? task.status
			: null;
		const clearResumeStatus = rememberedResumeStatus !== undefined
			&& task.status === "user-questions"
			&& target === rememberedResumeStatus;
		let updated = task;
		let moveAccepted = false;
		if (target !== null && (task.status !== target || task.customColumnId != null)) {
			updated = await moveTask({
				taskId: task.id,
				projectId: project.id,
				newStatus: target,
				ifStatus: event === "Stop" && task.status === "in-progress"
					? "in-progress,user-questions"
					: task.status,
			});
			moveAccepted = updated.status === target && updated.customColumnId == null;
		}
		if (resumeKey && resumeStatus && moveAccepted) {
			codexApprovalResumeStatuses.set(resumeKey, {
				status: resumeStatus,
				expiresAt: Date.now() + CODEX_APPROVAL_RESUME_TTL_MS,
			});
		} else if (resumeKey && clearResumeStatus && moveAccepted) {
			codexApprovalResumeStatuses.delete(resumeKey);
		}

		// Record the Codex session id for this pane (targeted per-pane recovery).
		const paneId = typeof params.paneId === "string" ? params.paneId : null;
		if (sessionId && paneId) {
			await captureCodexPaneSession(project, task.id, paneId, sessionId);
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
			const found = findTaskByRef(tasks, taskId);
			if (!found) throw taskNotFoundError(taskId);
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

		return moveTask({
			taskId: task.id,
			projectId: project.id,
			newStatus: builtinStatus,
			ifStatus,
			ifStatusNot,
			enforceAllowedTransition: true,
		});
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
			push("agentCompletionRequested", {
				requestId,
				taskId: task.id,
				projectId: project.id,
				taskTitle: getTaskTitle(task),
				// Full read-only context (project, seq, priority, labels, overview)
				// so the user recognizes which task the prompt destroys.
				subject: buildTaskDialogSubject(task, project),
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
		const durationMs = params.durationMs;
		if (durationMs !== undefined && !isValidNotificationDurationMs(durationMs)) {
			throw new Error(`durationMs must be between ${NOTIFICATION_MIN_DURATION_MS}ms and ${NOTIFICATION_MAX_DURATION_MS}ms`);
		}
		const desktop = params.desktop === true;
		if (desktop && durationMs !== undefined) {
			throw new Error("durationMs applies to in-app toasts and cannot be combined with desktop notifications");
		}

		// Keep the in-memory gate aligned for CLI requests that arrive before the
		// renderer has reported the persisted setting (for example after a restart).
		if ((await loadSettings()).focusMode) setFocusMode(true);

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
			return { delivered: true, mode: "desktop", taskId: task.id, queued: isNotificationSuppressed() };
		}

		const payload = {
			taskId,
			projectId,
			message,
			level,
			...(durationMs !== undefined ? { durationMs } : {}),
			...(task ? { taskSeq: task.seq, taskTitle: getTaskTitle(task), projectName: projectName ?? undefined } : {}),
		};
		if (isNotificationSuppressed()) {
			pushCliToast(payload);
			return { delivered: true, mode: "toast", taskId, queued: true };
		}

		const push = getPushMessage();
		if (!push) return { delivered: false, mode: "toast" };
		push("cliToast", payload);
		return { delivered: true, mode: "toast", taskId };
	},

	// UI control: light the red attention badge on a task card with a reason.
	"ui.attention": async (params) => {
		const reason = ((params.reason as string) ?? "").trim();
		const { project, task } = await resolveTaskFromParams(params);
		if ((await loadSettings()).focusMode) setFocusMode(true);
		if (isNotificationSuppressed()) {
			pushCliAttention({ taskId: task.id, reason });
			return { delivered: true, queued: true, taskId: task.id, projectId: project.id };
		}
		const push = getPushMessage();
		if (!push) return { delivered: false, taskId: task.id };
		push("cliAttention", { taskId: task.id, reason });
		return { delivered: true, taskId: task.id, projectId: project.id };
	},

	// `dev3 message "text"` (no time flag): deliver a message into the task's live
	// agent immediately (send-keys paste + Enter). Best-effort — throws if no live
	// agent pane can be resolved.
	"message.send": async (params) => {
		const { project, task } = await resolveTaskFromParams(params);
		const text = ((params.text as string) ?? "").toString();
		await sendMessageImmediately(task, text);
		return { delivered: true, taskId: task.id, projectId: project.id };
	},

	// `dev3 message --in <dur> | --at <hh:mm> "text"`: queue a scheduled message on
	// the task's live agent (validation + cap live in the scheduler core).
	"message.schedule": async (params) => {
		const { project, task } = await resolveTaskFromParams(params);
		const text = ((params.text as string) ?? "").toString();
		const at = (params.at as string) ?? "";
		const updated = await scheduleMessageCore(project, task, { text, at });
		return { taskId: task.id, projectId: project.id, at, pending: (updated.scheduledMessages ?? []).length };
	},

	// UI control: surface images (screenshots, renders, QA captures) an agent wants
	// the human to look at, bound to the task and kept as a clickable history.
	"ui.show-image": async (params) => {
		const { project, task } = await resolveTaskFromParams(params);
		if ((await loadSettings()).focusMode) setFocusMode(true);
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

		const payload = {
			taskId: task.id,
			projectId: project.id,
			images: updated.sharedImages ?? [],
			newCount: incoming.length,
			taskSeq: task.seq,
			taskTitle: getTaskTitle(task),
			projectName: project.name,
		};
		if (isNotificationSuppressed()) {
			pushCliShowImage(payload);
			return { delivered: true, queued: true, stored: incoming.length, taskId: task.id };
		}

		const push = getPushMessage();
		if (!push) return { delivered: false, stored: incoming.length, taskId: task.id };
		push("cliShowImage", payload);
		return { delivered: true, stored: incoming.length, taskId: task.id };
	},

	"ui.show-artifact": async (params) => {
		const { project, task } = await resolveTaskFromParams(params);
		if ((await loadSettings()).focusMode) setFocusMode(true);
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

		const { task: updated } = await data.updateTaskWith<void>(project, task.id, (current) => {
			return { updates: { sharedArtifacts: [...(current.sharedArtifacts ?? []), incoming] }, result: undefined };
		});
		getPushMessage()?.("taskUpdated", { projectId: project.id, task: updated });

		const payload = {
			taskId: task.id,
			projectId: project.id,
			artifacts: updated.sharedArtifacts ?? [],
			newCount: 1,
			taskSeq: task.seq,
			taskTitle: getTaskTitle(task),
			projectName: project.name,
		};
		if (isNotificationSuppressed()) {
			pushCliShowArtifact(payload);
			return { delivered: true, queued: true, stored: 1, taskId: task.id };
		}
		const push = getPushMessage();
		if (!push) return { delivered: false, stored: 1, taskId: task.id };
		push("cliShowArtifact", payload);
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

	// Meta sidecar: record whether this instance was launched from inside a dev3
	// task context (DEV3_TASK_ID is injected into task/dev-server tmux panes —
	// devScript-booted dev builds, `dev3 remote` from an agent pane). The CLI
	// deprioritizes such guest sockets during discovery so control commands
	// route to the primary app instead of an instance the command may be about
	// to tear down (#910/#920). See src/shared/socket-meta.ts.
	try {
		const meta: SocketMeta = {
			pid: process.pid,
			hostTaskId: process.env.DEV3_TASK_ID || null,
			startedAt: new Date().toISOString(),
		};
		writeFileSync(socketMetaPathFor(socketPath), JSON.stringify(meta));
	} catch (err) {
		log.warn("Failed to write socket meta sidecar (non-fatal)", { error: String(err) });
	}

	log.info("CLI socket server started", { path: socketPath, guestOfTask: process.env.DEV3_TASK_ID ?? null });
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
	if (socketPath && existsSync(socketMetaPathFor(socketPath))) {
		try {
			unlinkSync(socketMetaPathFor(socketPath));
		} catch {
			// Ignore cleanup errors
		}
	}
}
