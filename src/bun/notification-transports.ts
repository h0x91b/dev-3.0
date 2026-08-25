/**
 * Outbound notification transports — the third destination for a task notification.
 *
 * `deliverTaskNotification` (src/bun/rpc-handlers/shared.ts) already fans out to
 * the native OS banner and to `pushWebNotification`. Both need a live listener:
 * the desktop app in front of you, or a browser tab that is open and connected.
 * Close the lid or let the phone sleep its tab and the event is gone — which is
 * exactly the moment you wanted to hear that an agent is blocked.
 *
 * This adds a destination that survives having no listener, without dev-3.0
 * running anything on anyone's behalf: the event is handed to a command or a
 * webhook the user configured, and what happens next is theirs. Absent config the
 * whole path is inert.
 *
 * Config lives in `$DEV3_HOME/notifications.json` and NOT in GlobalSettings, on
 * purpose — see decisions/2026/08/25/user-directed-notification-egress.md.
 * `saveSettings` is reachable from the RPC surface that the remote server exposes
 * to an authenticated browser, so a transport stored there would let a session
 * plant a command that dev-3.0 re-executes on every future notification. A file
 * the RPC layer never writes keeps "run this command" out of reach of a captured
 * session.
 */
import { existsSync, readFileSync } from "node:fs";
import { createLogger } from "./logger";
import { DEV3_HOME } from "./paths";
import { spawn } from "./spawn";

const log = createLogger("notification-transports");

/** The payload `pushWebNotification` already builds, unchanged so the two stay in step. */
export type NotificationEvent = {
	taskId: string;
	projectId: string;
	title: string;
	body: string;
	level: "info" | "success" | "error";
	taskSeq: number;
	taskTitle: string;
	projectName: string;
};

type TransportBase = {
	timeoutMs?: number;
	/** Overrides `includeContent` for this destination: exposure is a property of
	 *  the transport, not of the payload. */
	includeContent?: boolean;
};

export type NotificationTransport =
	| ({ kind: "exec"; command: string[] } & TransportBase)
	| ({ kind: "webhook"; url: string; headers?: Record<string, string> } & TransportBase);

export type NotificationHookConfig = {
	transports: NotificationTransport[];
	/** Default for transports that do not set their own. On: a notification you
	 *  cannot triage costs you the app-open it was meant to save. */
	includeContent?: boolean;
	/** Allowlist, not a severity ordering — "info" and "success" have no rank. */
	levels?: NotificationEvent["level"][];
};

const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_TIMEOUT_MS = 30_000;

export function notificationConfigPath(home: string = DEV3_HOME): string {
	return `${home}/notifications.json`;
}

function validTransport(t: unknown): t is NotificationTransport {
	if (!t || typeof t !== "object") return false;
	const c = t as Record<string, unknown>;
	if (c.kind === "exec") {
		// argv only: event content is user-authored, so it must never reach a shell.
		return Array.isArray(c.command) && c.command.length > 0 && c.command.every((a) => typeof a === "string");
	}
	if (c.kind === "webhook") {
		if (typeof c.url !== "string") return false;
		try {
			const proto = new URL(c.url).protocol;
			return proto === "http:" || proto === "https:";
		} catch {
			return false;
		}
	}
	return false;
}

/** A missing or malformed file disables the hook silently — a typo in an optional
 *  convenience must never fail app launch. */
export function parseNotificationConfig(raw: unknown): NotificationHookConfig | null {
	if (!raw || typeof raw !== "object") return null;
	const d = raw as Record<string, unknown>;
	const transports = Array.isArray(d.transports) ? d.transports.filter(validTransport) : [];
	if (transports.length === 0) return null;
	const levels = Array.isArray(d.levels)
		? d.levels.filter((l): l is NotificationEvent["level"] => l === "info" || l === "success" || l === "error")
		: undefined;
	return {
		transports,
		...(d.includeContent === false ? { includeContent: false } : {}),
		...(levels && levels.length > 0 ? { levels } : {}),
	};
}

export function loadNotificationConfig(path: string = notificationConfigPath()): NotificationHookConfig | null {
	try {
		if (!existsSync(path)) return null;
		return parseNotificationConfig(JSON.parse(readFileSync(path, "utf-8")));
	} catch (err) {
		log.warn("Ignoring unreadable notifications.json", { path, error: String(err) });
		return null;
	}
}

/** Strip the user-authored strings, keep the ids that identify the task. */
export function redactEvent(event: NotificationEvent): NotificationEvent {
	return { ...event, title: `#${event.taskSeq} needs you`, body: "", taskTitle: "", projectName: "" };
}

export function shouldDeliver(event: NotificationEvent, config: NotificationHookConfig): boolean {
	return (config.levels ?? ["info", "success", "error"]).includes(event.level);
}

function timeoutFor(t: NotificationTransport): number {
	const ms = t.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	return Math.min(Math.max(ms, 1), MAX_TIMEOUT_MS);
}

async function runExec(t: Extract<NotificationTransport, { kind: "exec" }>, payload: string): Promise<void> {
	// Via spawn.ts, never Bun.spawn (AGENTS.md): a packaged .app inherits a minimal
	// PATH, so a homebrew/nvm hook would work in dev and fail for shipped installs.
	const proc = spawn(t.command, {
		stdin: new TextEncoder().encode(payload),
		stdout: "ignore",
		stderr: "ignore",
	});
	const timer = setTimeout(() => proc.kill(), timeoutFor(t));
	try {
		await proc.exited;
	} finally {
		clearTimeout(timer);
	}
}

async function runWebhook(t: Extract<NotificationTransport, { kind: "webhook" }>, payload: string): Promise<void> {
	const res = await fetch(t.url, {
		method: "POST",
		headers: { "content-type": "application/json", ...(t.headers ?? {}) },
		body: payload,
		signal: AbortSignal.timeout(timeoutFor(t)),
	});
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

/** Fan out to every transport. A hook that hangs or crashes is logged and dropped:
 *  it must never fail the task transition that triggered it. */
export async function deliverToTransports(event: NotificationEvent, config: NotificationHookConfig): Promise<void> {
	if (!shouldDeliver(event, config)) return;
	const full = JSON.stringify(event);
	const stripped = JSON.stringify(redactEvent(event));
	await Promise.all(
		config.transports.map(async (t) => {
			const payload = (t.includeContent ?? config.includeContent ?? true) ? full : stripped;
			try {
				if (t.kind === "exec") await runExec(t, payload);
				else await runWebhook(t, payload);
			} catch (err) {
				log.warn("Notification transport failed", {
					kind: t.kind,
					target: t.kind === "exec" ? t.command[0] : t.url,
					error: String(err),
				});
			}
		}),
	);
}

/** Fire and forget; never throws. Config is re-read per event so an edit applies
 *  without a relaunch — this fires at human speed, not in a hot path. */
export function outboundNotify(event: NotificationEvent): void {
	void (async () => {
		try {
			const config = loadNotificationConfig();
			if (!config) return;
			await deliverToTransports(event, config);
		} catch (err) {
			log.warn("Outbound notify failed", { error: String(err) });
		}
	})();
}
