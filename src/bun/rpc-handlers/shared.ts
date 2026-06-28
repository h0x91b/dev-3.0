// Re-export all pure helpers (no electrobun/bun:ffi dependencies)
export {
	log,
	escapeForDoubleQuotes,
	shellQuote,
	getScriptShellPath,
	buildScriptRunnerCommand,
	buildEnvExports,
	buildCmdScript,
	resolveBinaryPath,
	setPushMessage,
	getPushMessage,
	getPushMessageLocal,
	isActive,
	buildAgentEnv,
	buildTaskLifecycleEnv,
	extractConfigFromParams,
} from "./shared-pure";

// ── Electrobun/native-dependent exports ─────────────────────────────

import { extname } from "node:path";
import { Utils } from "../electrobun-platform";
import { dlopen, FFIType } from "bun:ffi";
import type { RendererLogLevel, RequirementCheckResult, Task } from "../../shared/types";
import { formatStatus, getTaskTitle } from "../../shared/types";
import { createLogger } from "../logger";
import { log, getPushMessage } from "./shared-pure";

const rendererLog = createLogger("renderer");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let objcLib: any = null;

function getObjcLib() {
	if (!objcLib) {
		objcLib = dlopen("libobjc.A.dylib", {
			objc_getClass: { args: [FFIType.ptr], returns: FFIType.ptr },
			sel_registerName: { args: [FFIType.ptr], returns: FFIType.ptr },
			objc_msgSend: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
		});
	}
	return objcLib;
}

const encodeCStr = (s: string) => Buffer.from(s + "\0");

export function hideAppNative(): void {
	try {
		const objc = getObjcLib();
		const NSApplication = objc.symbols.objc_getClass(encodeCStr("NSApplication"));
		const sharedAppSel = objc.symbols.sel_registerName(encodeCStr("sharedApplication"));
		const hideSel = objc.symbols.sel_registerName(encodeCStr("hide:"));

		const app = objc.symbols.objc_msgSend(NSApplication, sharedAppSel);
		objc.symbols.objc_msgSend(app, hideSel);
	} catch (err) {
		log.error("hideAppNative FFI failed", { error: String(err) });
	}
}

export function logRendererError(params: { description: string; source: "error" | "unhandledrejection" }): void {
	rendererLog.warn(`[${params.source}] ${params.description}`);
}

// TEMP DIAGNOSTIC: dedicated renderer->backend log bridge for the terminal copy bug.
// Remove this helper after the copy issue is fixed and the diagnostic flow is deleted.
export function logRendererEvent(params: {
	level: RendererLogLevel;
	tag: string;
	message: string;
	extra?: Record<string, string | number | boolean | null>;
}): void {
	const fn = rendererLog[params.level] ?? rendererLog.info;
	fn(`[${params.tag}] ${params.message}`, params.extra);
}

const SYSTEM_REQUIREMENTS: RequirementCheckResult[] = [
	{ id: "git", name: "Git", installed: false, installHint: "requirements.installGit", installCommand: "xcode-select --install", brewInstallable: false },
	{ id: "tmux", name: "tmux", installed: false, installHint: "requirements.installTmux", installCommand: "brew install tmux", brewInstallable: true },
];

export function getSystemRequirements(): RequirementCheckResult[] {
	return SYSTEM_REQUIREMENTS.map((req) => ({ ...req }));
}

/**
 * Window in which a window-focus event is treated as "user clicked the notification".
 * macOS activates the app when a notification is clicked, which fires our BrowserWindow
 * `focus` event. We use this as a proxy for click-to-open since Electrobun's
 * `Utils.showNotification` does not expose a click callback.
 *
 * Kept deliberately short: the smaller this window, the smaller the chance that an
 * unrelated app activation (cmd-tab, dock click) within it is misread as a click-through.
 */
export const NOTIFICATION_CLICK_TTL_MS = 3000;

let lastWatchedNotification: { taskId: string; projectId: string; timestamp: number } | null = null;

/**
 * Whether the app is currently in the foreground (any window has key focus).
 * The renderer reports this via `setWindowForeground`; `index.ts`'s window-focus
 * hook also flips it true. We need it because Electrobun exposes no native
 * "did resign active" signal — without it the focus proxy below cannot tell a
 * genuine notification click from an in-app re-focus.
 */
let appForeground = false;

export function setAppForeground(value: boolean): void {
	appForeground = value;
}

export function isAppForeground(): boolean {
	return appForeground;
}

/**
 * The project/task the renderer is currently looking at. Background git pollers
 * (merge detection, PR promotion) blindly iterate every project on disk, which
 * forks a storm of `git fetch` + patch-id processes for worktrees nobody is
 * viewing and stalls the main loop. They consult this so the active board is
 * polled at the normal cadence while everything else is heavily throttled.
 * Reported by the renderer on every route change; null until first report.
 */
let activeContext: { projectId: string | null; taskId: string | null } = { projectId: null, taskId: null };

export function setActiveContext(ctx: { projectId: string | null; taskId: string | null }): void {
	activeContext = { projectId: ctx.projectId ?? null, taskId: ctx.taskId ?? null };
}

export function getActiveContext(): { projectId: string | null; taskId: string | null } {
	return activeContext;
}

/**
 * Mirror a native OS notification to remote/browser clients as a Web Notification
 * request. Fires alongside every `Utils.showNotification` call so that clients on
 * `dev3 remote` (where the native call is a no-op) still get notified. The push is
 * broadcast to all connected renderers; the desktop WKWebView ignores it (native
 * already fired) and only browsers act on it — see the renderer's `webNotification`
 * handler. No-op when no push transport is wired (e.g. unit tests, CLI process).
 */
function pushWebNotification(opts: {
	task: Task;
	body: string;
	projectName: string;
	level?: "info" | "success" | "error";
}): void {
	getPushMessage()?.("webNotification", {
		taskId: opts.task.id,
		projectId: opts.task.projectId,
		title: `#${opts.task.seq} ${getTaskTitle(opts.task)}`,
		body: opts.body,
		level: opts.level ?? "info",
		taskSeq: opts.task.seq,
		taskTitle: getTaskTitle(opts.task),
		projectName: opts.projectName,
	});
}

export function notifyWatchedTaskStatusChange(task: Task, oldStatus: string, newStatus: string, projectName: string): void {
	if (!task.watched || oldStatus === newStatus) return;
	const body = `${formatStatus(oldStatus)} → ${formatStatus(newStatus)}`;
	Utils.showNotification({
		title: `#${task.seq} ${getTaskTitle(task)}`,
		body,
		subtitle: projectName,
		silent: true,
	});
	pushWebNotification({ task, body, projectName });
	// Only arm click-to-open when the app is NOT already in the foreground. If the
	// user is actively looking at the app, the banner is purely informational — a
	// subsequent in-app click that happens to re-key the window must not be misread
	// as "clicked the notification" and teleport them to the task. This is the core
	// fix for the "any click after a notification zooms me into the task" bug.
	if (appForeground) return;
	lastWatchedNotification = {
		taskId: task.id,
		projectId: task.projectId,
		timestamp: Date.now(),
	};
}

/**
 * Fire a native OS notification on behalf of `dev3 notify --desktop`, and arm
 * click-to-open so a subsequent app activation navigates to the task. Reuses the
 * exact same focus-proxy mechanism as watched-task notifications
 * (`notifyWatchedTaskStatusChange`) — Electrobun's `Utils.showNotification`
 * exposes no click callback, so we treat "app became foreground shortly after"
 * as the click.
 */
export function notifyFromCliDesktop(opts: { task: Task; body: string; projectName?: string }): void {
	Utils.showNotification({
		title: `#${opts.task.seq} ${getTaskTitle(opts.task)}`,
		body: opts.body,
		...(opts.projectName ? { subtitle: opts.projectName } : {}),
		silent: true,
	});
	pushWebNotification({ task: opts.task, body: opts.body, projectName: opts.projectName ?? "" });
	// Don't arm click-to-open while the app is already focused — see the rationale
	// in notifyWatchedTaskStatusChange.
	if (appForeground) return;
	lastWatchedNotification = {
		taskId: opts.task.id,
		projectId: opts.task.projectId,
		timestamp: Date.now(),
	};
}

/**
 * Fire a native OS notification for a watched task on a non-status event
 * (e.g. CI passed/failed, PR approved/changes-requested). No-op for unwatched
 * tasks. Reuses the same focus-proxy click-to-open mechanism as
 * `notifyWatchedTaskStatusChange`.
 */
export function notifyWatchedTaskEvent(task: Task, body: string, projectName: string): void {
	if (!task.watched) return;
	Utils.showNotification({
		title: `#${task.seq} ${getTaskTitle(task)}`,
		body,
		subtitle: projectName,
		silent: true,
	});
	pushWebNotification({ task, body, projectName });
	if (appForeground) return;
	lastWatchedNotification = {
		taskId: task.id,
		projectId: task.projectId,
		timestamp: Date.now(),
	};
}

/**
 * If a watched-task notification fired within the last `NOTIFICATION_CLICK_TTL_MS`,
 * return its target (taskId + projectId) and clear the slot. Otherwise return null.
 *
 * Called from the window-focus listener in `src/bun/index.ts` to implement
 * click-to-open for watched-task notifications.
 */
export function consumeRecentWatchedNotification(now: number = Date.now()): { taskId: string; projectId: string } | null {
	const recent = lastWatchedNotification;
	if (!recent) return null;
	lastWatchedNotification = null;
	if (now - recent.timestamp > NOTIFICATION_CLICK_TTL_MS) return null;
	return { taskId: recent.taskId, projectId: recent.projectId };
}

/** For tests only — resets the last-watched-notification slot and foreground flag. */
export function _resetWatchedNotificationState(): void {
	lastWatchedNotification = null;
	appForeground = false;
	activeContext = { projectId: null, taskId: null };
}

const IMAGE_MIME_EXTENSIONS: Record<string, string> = {
	"image/png": ".png",
	"image/jpeg": ".jpg",
	"image/gif": ".gif",
	"image/webp": ".webp",
	"image/bmp": ".bmp",
	"image/svg+xml": ".svg",
};

export function getUploadedImageExtension(filename?: string, mimeType?: string): string {
	const fileExt = filename ? extname(filename).toLowerCase() : "";
	if (fileExt in {
		".png": true,
		".jpg": true,
		".jpeg": true,
		".gif": true,
		".webp": true,
		".bmp": true,
		".svg": true,
	}) {
		return fileExt;
	}

	if (mimeType) {
		return IMAGE_MIME_EXTENSIONS[mimeType.toLowerCase()] ?? ".png";
	}

	return ".png";
}
