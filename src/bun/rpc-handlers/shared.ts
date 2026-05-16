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
	extractConfigFromParams,
} from "./shared-pure";

// ── Electrobun/native-dependent exports ─────────────────────────────

import { extname } from "node:path";
import { Utils } from "../electrobun-platform";
import { dlopen, FFIType } from "bun:ffi";
import type { RendererLogLevel, RequirementCheckResult, Task } from "../../shared/types";
import { formatStatus, getTaskTitle } from "../../shared/types";
import { createLogger } from "../logger";
import { log } from "./shared-pure";

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
 */
export const NOTIFICATION_CLICK_TTL_MS = 5000;

let lastWatchedNotification: { taskId: string; projectId: string; timestamp: number } | null = null;

export function notifyWatchedTaskStatusChange(task: Task, oldStatus: string, newStatus: string, projectName: string): void {
	if (!task.watched || oldStatus === newStatus) return;
	Utils.showNotification({
		title: `#${task.seq} ${getTaskTitle(task)}`,
		body: `${formatStatus(oldStatus)} → ${formatStatus(newStatus)}`,
		subtitle: projectName,
		silent: true,
	});
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

/** For tests only — resets the last-watched-notification slot. */
export function _resetWatchedNotificationState(): void {
	lastWatchedNotification = null;
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
