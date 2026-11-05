import type { Task, SharedArtifact, SharedImage } from "../../shared/types";
import { isValidNotificationDurationMs, NOTIFICATION_MAX_DURATION_MS, NOTIFICATION_MIN_DURATION_MS } from "../../shared/duration";
import { getTaskTitle, isSharedAudio, taskSharedMedia } from "../../shared/types";
import { SharedImageError, saveSharedClips, saveSharedImage } from "../shared-images";
import { SharedArtifactError, saveSharedArtifact } from "../shared-artifacts";
import { appendArtifactVersion, latestArtifactVersion } from "../../shared/artifact-versions";
import * as data from "../data";
import { getPushMessage, notifyFromCliDesktop, isAppForeground, getActiveContext, isNotificationSuppressed, isProjectSilenced, dropQueuedAttention, pushCliAttention, pushCliToast, pushCliShowImage, pushCliShowArtifact, setFocusMode } from "../rpc-handlers";
import { getTmuxLayout } from "../pty-server";
import { getUserIdleSeconds } from "../user-activity";
import { loadSettings } from "../settings";
import { buildNotificationLogBase, recordNotification } from "./notification-log";
import type { Handler } from "./shared";
import { resolveTaskFromParams } from "./task-resolution";

/** What a batch of arrivals was, for the toast: a `show-media` call may mix video and audio. */
function clipBatchKind(incoming: SharedImage[]): "video" | "audio" | "media" {
	const audio = incoming.filter(isSharedAudio).length;
	return audio === 0 ? "video" : audio === incoming.length ? "audio" : "media";
}

/** `ui.show-image` / `ui.show-media`: copy files into the task's shared-media history and surface the viewer. */
async function showSharedMedia(params: Record<string, unknown>, kind: "image" | "media") {
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
	if (items.length === 0) throw new Error(`At least one ${kind} path is required`);

	// Copy every file into the worktree first — fail fast (usage error) if any
	// path is invalid, so the agent gets a clear signal and nothing half-lands.
	let incoming: SharedImage[];
	try {
		incoming = kind === "media" ? await saveSharedClips(project.path, items) : items.map((it) => saveSharedImage(project.path, it.path, it.caption));
	} catch (err) {
		if (err instanceof SharedImageError) throw err;
		throw new Error(`Failed to store ${kind}: ${err instanceof Error ? err.message : String(err)}`);
	}

	// Append inside the file lock. The history is uncapped — the stored files
	// live in the worktree and die with it.
	// Clips get their own additive fields: older versions read every sharedImages entry's bytes.
	const { task: updated } = await data.updateTaskWith<void>(project, task.id, (current) => {
		if (kind === "image") return { updates: { sharedImages: [...(current.sharedImages ?? []), ...incoming] }, result: undefined };
		const audio = incoming.filter(isSharedAudio);
		const videos = incoming.filter((item) => !isSharedAudio(item));
		const updates: Partial<Task> = {};
		if (videos.length > 0) updates.sharedVideos = [...(current.sharedVideos ?? []), ...videos];
		if (audio.length > 0) updates.sharedAudio = [...(current.sharedAudio ?? []), ...audio];
		return { updates, result: undefined };
	});

	// Persist to state everywhere (badge + history) regardless of focus mode.
	getPushMessage()?.("taskUpdated", { projectId: project.id, task: updated });

	const payload = {
		taskId: task.id,
		projectId: project.id,
		images: taskSharedMedia(updated),
		newCount: incoming.length,
		newKind: kind === "image" ? kind : clipBatchKind(incoming),
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
}

export const uiHandlers: Record<string, Handler> = {

	// UI control: surface an in-app toast (or native OS notification) from the CLI.
	//
	// Every accepted request is also appended to the notification log. The write
	// is deliberately last and never throws: a toast the user already saw must
	// not turn into a CLI error because a disk write failed.
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

		// Resolved before delivery so the row can be written whatever happens next.
		const logBase = await buildNotificationLogBase(params, { message, level, durationMs, task, projectId, projectName });

		if (desktop) {
			if (!task || !projectId) {
				throw new Error("desktop notification requires a task — run inside a worktree or pass --task <id>");
			}
			notifyFromCliDesktop({
				task,
				body: message,
				projectName: projectName ?? undefined,
			});
			const queued = isNotificationSuppressed();
			// A silenced project drops the notification without a trace on screen —
			// see `deliverTaskNotification`. Recording it would put that trace back.
			if (!isProjectSilenced(task.projectId)) {
				recordNotification(params, logBase, "desktop", queued ? "queued" : "delivered");
			}
			return { delivered: true, mode: "desktop", taskId: task.id, queued };
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
			// Same rule as the desktop path: `pushCliToast` drops a silenced
			// project's toast outright instead of queuing it.
			if (!isProjectSilenced(projectId)) {
				recordNotification(params, logBase, "toast", "queued");
			}
			return { delivered: true, mode: "toast", taskId, queued: true };
		}

		const push = getPushMessage();
		if (!push) {
			recordNotification(params, logBase, "toast", "no-window");
			return { delivered: false, mode: "toast" };
		}
		push("cliToast", payload);
		recordNotification(params, logBase, "toast", "delivered");
		return { delivered: true, mode: "toast", taskId };
	},

	// UI control: light the red attention badge on a task card with a reason,
	// or (--clear) take it back down together with its accumulated reasons.
	"ui.attention": async (params) => {
		const reason = ((params.reason as string) ?? "").trim();
		const { project, task } = await resolveTaskFromParams(params);
		if ((await loadSettings()).focusMode) setFocusMode(true);
		if (params.clear === true) {
			// Never queued and never silenced: a stale badge has to go down even
			// while Focus Mode or a silenced project holds new badges back.
			dropQueuedAttention(task.id);
			const clearPush = getPushMessage();
			if (!clearPush) return { delivered: false, taskId: task.id };
			clearPush("cliAttention", { taskId: task.id, reason: "", clear: true });
			return { delivered: true, taskId: task.id, projectId: project.id };
		}
		if (isNotificationSuppressed()) {
			pushCliAttention({ taskId: task.id, projectId: task.projectId, reason });
			return { delivered: true, queued: true, taskId: task.id, projectId: project.id };
		}
		const push = getPushMessage();
		if (!push) return { delivered: false, taskId: task.id };
		push("cliAttention", { taskId: task.id, reason });
		return { delivered: true, taskId: task.id, projectId: project.id };
	},

	// UI control: surface images (screenshots, renders, QA captures) an agent wants
	// the human to look at, bound to the task and kept as a clickable history.
	"ui.show-image": (params) => showSharedMedia(params, "image"),
	// Same history and viewer for video and audio clips (`dev3 show-media`).
	"ui.show-media": (params) => showSharedMedia(params, "media"),

	"ui.show-artifact": async (params) => {
		const { project, task } = await resolveTaskFromParams(params);
		if ((await loadSettings()).focusMode) setFocusMode(true);
		const htmlPath = typeof params.htmlPath === "string" ? params.htmlPath : "";
		if (!htmlPath) throw new Error("HTML artifact path is required");
		const assetPaths = Array.isArray(params.assetPaths)
			? params.assetPaths.filter((path): path is string => typeof path === "string" && path.length > 0)
			: [];
		const title = typeof params.title === "string" && params.title.trim() ? params.title.trim() : undefined;
		const artifactId = typeof params.artifactId === "string" && params.artifactId.trim() ? params.artifactId.trim() : undefined;
		const forceNew = params.forceNew === true;

		let incoming: SharedArtifact;
		try {
			incoming = saveSharedArtifact(project.path, htmlPath, assetPaths, title, { artifactId, forceNew });
		} catch (error) {
			if (error instanceof SharedArtifactError) throw error;
			throw new Error(`Failed to store artifact: ${error instanceof Error ? error.message : String(error)}`);
		}

		// Re-publishing an artifact adds a version to the row the user already has
		// instead of a new row. Nothing is deleted from disk: a version the cap
		// trims only leaves the record, its stored dir stays where it was.
		const { task: updated, result: version } = await data.updateTaskWith<number>(project, task.id, (current) => {
			const { artifacts } = appendArtifactVersion(current.sharedArtifacts ?? [], incoming);
			const merged = artifacts.find((artifact) => artifact.groupKey === incoming.groupKey);
			return { updates: { sharedArtifacts: artifacts }, result: merged ? latestArtifactVersion(merged) : 1 };
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
			return { delivered: true, queued: true, stored: 1, taskId: task.id, version };
		}
		const push = getPushMessage();
		if (!push) return { delivered: false, stored: 1, taskId: task.id, version };
		push("cliShowArtifact", payload);
		return { delivered: true, stored: 1, taskId: task.id, version };
	},

	/**
	 * `dev3 artifact-template` — provision the task's pristine starter on demand
	 * and answer with its absolute path, which the CLI then copies into the
	 * worktree. The recovery path for a session whose `DEV3_ARTIFACT_TEMPLATE_DIR`
	 * was baked at launch time and is therefore missing: an older app version, or
	 * a shell that never inherited the launch env (issue #1437).
	 */
	"artifact.template-dir": async (params) => {
		const { project, task } = await resolveTaskFromParams(params);
		const worktreePath = typeof params.worktreePath === "string" && params.worktreePath ? params.worktreePath : undefined;
		// Imported here, not at module scope: only this rarely-used route needs it.
		const { provisionArtifactStarter } = await import("../artifact-template");
		const { dir, mode } = provisionArtifactStarter(project, task, { worktreePath });
		return { dir, mode, taskId: task.id, projectId: project.id };
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
};
