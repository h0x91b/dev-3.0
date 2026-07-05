// Native macOS notification channel with REAL click callbacks.
//
// Electrobun's Utils.showNotification cannot report clicks (upstream #384), so
// the app historically guessed clicks from window-focus timing (a 3s TTL proxy
// in rpc-handlers/shared.ts). This module replaces the guess on macOS with a
// compiled shim (src/native/macos/dev3-notifications.m) that sets a
// UNUserNotificationCenterDelegate and posts notifications whose request
// identifier encodes the task target — a click hands us back exactly the task
// that fired it, no timing heuristics.
//
// Degrades to `false` from every entry point (non-macOS, headless mode, dylib
// missing, notification permission denied) — callers then fall back to
// Electrobun's fire-and-forget path plus the focus-proxy.
//
// See decisions/106-native-notification-click-shim.md.

import { join } from "node:path";
import { existsSync } from "node:fs";
import { dlopen, FFIType, JSCallback, CString, type Pointer } from "bun:ffi";
import { PATHS } from "./electrobun-platform";
import { createLogger } from "./logger";

const log = createLogger("native-notifications");

export interface NotificationClickTarget {
	taskId: string;
	projectId: string;
}

// ── Identifier codec (pure — unit-tested) ───────────────────────────────────
//
// The task target rides in the UNNotificationRequest identifier, so no native
// userInfo dictionary plumbing is needed. Identifiers are stable per task:
// a newer notification for the same task replaces the older one in
// Notification Center instead of stacking.

const IDENTIFIER_PREFIX = "dev3-task-nav";
const IDENTIFIER_SEPARATOR = "|";

export function encodeTaskNotificationIdentifier(target: NotificationClickTarget): string {
	return [IDENTIFIER_PREFIX, target.taskId, target.projectId].join(IDENTIFIER_SEPARATOR);
}

export function decodeTaskNotificationIdentifier(identifier: string): NotificationClickTarget | null {
	const parts = identifier.split(IDENTIFIER_SEPARATOR);
	if (parts.length !== 3 || parts[0] !== IDENTIFIER_PREFIX) return null;
	const [, taskId, projectId] = parts;
	if (!taskId || !projectId) return null;
	return { taskId, projectId };
}

// ── FFI plumbing ─────────────────────────────────────────────────────────────

interface ShimSymbols {
	dev3_notif_init: (cb: Pointer) => number;
	dev3_notif_auth_status: () => number;
	dev3_notif_post: (
		identifier: Buffer,
		title: Buffer,
		subtitle: Buffer,
		body: Buffer,
		silent: number,
	) => number;
	dev3_notif_free_cstr: (p: Pointer) => void;
}

let shim: ShimSymbols | null = null;
// Module-level reference so the callback trampoline is never garbage-collected
// while the native side still holds its function pointer.
let clickCallback: JSCallback | null = null;

const cstr = (s: string) => Buffer.from(s + "\0", "utf8");

function shimDylibPath(): string {
	// Bundled at <bundle>/Resources/app/native/ by the electrobun.config.ts copy
	// rule; VIEWS_FOLDER is <bundle>/Resources/app/views/.
	return join(PATHS.VIEWS_FOLDER, "..", "native", "dev3-notifications.dylib");
}

/**
 * Load the shim, install the notification-click delegate, and request
 * authorization. Returns true when the native channel is available. Safe to
 * call from any environment — returns false instead of throwing.
 *
 * Called once from `src/bun/index.ts` (GUI entry). Tests never call it, which
 * keeps `postNativeTaskNotification` inert (always false) under vitest.
 */
export function initNativeNotifications(onClick: (target: NotificationClickTarget) => void): boolean {
	if (shim) return true;
	if (process.platform !== "darwin") return false;
	if (process.env.DEV3_HEADLESS === "1") return false;

	try {
		const dylib = shimDylibPath();
		if (!existsSync(dylib)) {
			log.info("notification shim dylib not found — using focus-proxy fallback", { dylib });
			return false;
		}
		const lib = dlopen(dylib, {
			dev3_notif_init: { args: [FFIType.function], returns: FFIType.i32 },
			dev3_notif_auth_status: { args: [], returns: FFIType.i32 },
			dev3_notif_post: {
				args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.i32],
				returns: FFIType.i32,
			},
			dev3_notif_free_cstr: { args: [FFIType.ptr], returns: FFIType.void },
		});
		const symbols = lib.symbols as unknown as ShimSymbols;

		// threadsafe: the delegate fires on a UNUserNotificationCenter dispatch
		// queue, never on the Bun worker thread. The shim strdup's the identifier
		// so the pointer stays valid until this deferred callback frees it.
		clickCallback = new JSCallback(
			(identifierPtr: Pointer) => {
				try {
					const identifier = identifierPtr ? new CString(identifierPtr).toString() : "";
					if (identifierPtr) symbols.dev3_notif_free_cstr(identifierPtr);
					const target = decodeTaskNotificationIdentifier(identifier);
					if (!target) {
						log.debug("notification click with foreign identifier ignored", { identifier });
						return;
					}
					onClick(target);
				} catch (err) {
					log.error("notification click handler failed", { error: String(err) });
				}
			},
			{ args: [FFIType.ptr], returns: FFIType.void, threadsafe: true },
		);

		if (symbols.dev3_notif_init(clickCallback.ptr as Pointer) !== 1) {
			log.warn("dev3_notif_init reported UNUserNotificationCenter unavailable — using focus-proxy fallback");
			clickCallback.close();
			clickCallback = null;
			return false;
		}
		shim = symbols;
		log.info("native notification click channel active", { dylib });
		return true;
	} catch (err) {
		log.warn("native notification shim failed to load — using focus-proxy fallback", { error: String(err) });
		clickCallback?.close();
		clickCallback = null;
		return false;
	}
}

/**
 * Post a task notification through the native shim. Returns true when the
 * notification was handed to UNUserNotificationCenter with a click-navigation
 * identifier; false when the channel is unavailable or notification permission
 * is not (yet) granted — callers must then use the legacy Electrobun path.
 */
export function postNativeTaskNotification(opts: {
	taskId: string;
	projectId: string;
	title: string;
	subtitle?: string;
	body?: string;
	silent?: boolean;
}): boolean {
	if (!shim) return false;
	try {
		const identifier = encodeTaskNotificationIdentifier({ taskId: opts.taskId, projectId: opts.projectId });
		return (
			shim.dev3_notif_post(
				cstr(identifier),
				cstr(opts.title),
				cstr(opts.subtitle ?? ""),
				cstr(opts.body ?? ""),
				opts.silent === false ? 0 : 1,
			) === 1
		);
	} catch (err) {
		log.error("dev3_notif_post failed", { error: String(err) });
		return false;
	}
}

/** Test-only: forget the loaded shim so init guards can be re-exercised. */
export function _resetNativeNotificationsForTests(): void {
	shim = null;
	clickCallback?.close();
	clickCallback = null;
}
