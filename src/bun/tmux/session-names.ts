/**
 * dev3 tmux session naming — the single source of truth for every `dev3-*`
 * session name and its reverse parser. Session names embed the first 8 chars
 * of the owning task/project UUID; nothing else in the app may re-derive
 * these strings inline.
 */

import { DEFAULT_DEV_SERVER_NAME } from "../../shared/dev-servers";

export const TASK_SESSION_PREFIX = "dev3-";
export const PROJECT_TERMINAL_SESSION_PREFIX = "dev3-pt-";
export const DEV_SERVER_SESSION_PREFIX = "dev3-dev-";
export const CLEANUP_SESSION_PREFIX = "dev3-cl-";

/** First 8 chars of a task/project UUID — the id fragment session names carry. */
export function sessionShortId(id: string): string {
	return id.slice(0, 8);
}

/** Main agent session of a task: `dev3-<short>`. */
export function taskSessionName(taskId: string): string {
	return `${TASK_SESSION_PREFIX}${sessionShortId(taskId)}`;
}

/** Project terminal session: `dev3-pt-<short>`. */
export function projectTerminalSessionName(projectId: string): string {
	return `${PROJECT_TERMINAL_SESSION_PREFIX}${sessionShortId(projectId)}`;
}

/**
 * Detached dev-server session of a task: `dev3-dev-<short>` for the default
 * server, `dev3-dev-<short>-<name>` for every other one.
 *
 * The default keeps the historical name on purpose: another installed version of
 * dev3 looking at the same machine still finds, shows and controls it.
 */
export function devServerSessionName(taskId: string, serverName?: string): string {
	const base = `${DEV_SERVER_SESSION_PREFIX}${sessionShortId(taskId)}`;
	return !serverName || serverName === DEFAULT_DEV_SERVER_NAME ? base : `${base}-${serverName}`;
}

/** Prefix every dev-server session of a task starts with. */
export function devServerSessionPrefix(taskId: string): string {
	return `${DEV_SERVER_SESSION_PREFIX}${sessionShortId(taskId)}`;
}

/** True for a dev-server session of this task, whichever server it hosts. */
export function isDevServerSessionOfTask(sessionName: string, taskId: string): boolean {
	const prefix = devServerSessionPrefix(taskId);
	return sessionName === prefix || sessionName.startsWith(`${prefix}-`);
}

/** Cleanup-script session of a task: `dev3-cl-<short>`. */
export function cleanupSessionName(taskId: string): string {
	return `${CLEANUP_SESSION_PREFIX}${sessionShortId(taskId)}`;
}

/**
 * Sibling dev-server session for a TASK session name (`dev3-<short>` →
 * `dev3-dev-<short>`), for call sites that only hold the session name and not
 * the full task id (port scanning, resource monitoring, session cleanup).
 */
export function devServerSessionForTaskSession(taskSessionName: string): string {
	return `${DEV_SERVER_SESSION_PREFIX}${taskSessionName.slice(TASK_SESSION_PREFIX.length)}`;
}

/**
 * EVERY dev-server session belonging to a task session, picked out of a list of
 * live session names. A task can run several servers, so a caller that only
 * looked at {@link devServerSessionForTaskSession} sees the default one alone.
 */
export function devServerSessionsForTaskSession(taskSessionName: string, sessionNames: Iterable<string>): string[] {
	const prefix = devServerSessionForTaskSession(taskSessionName);
	return [...sessionNames].filter((name) => name === prefix || name.startsWith(`${prefix}-`));
}

export type Dev3SessionKind = "task" | "project-terminal" | "dev-server" | "cleanup";

export interface ParsedDev3SessionName {
	kind: Dev3SessionKind;
	/** The short (8-char) task/project id fragment embedded in the name. */
	shortId: string;
	/** Dev-server sessions only: which server it hosts (`dev` for the default). */
	serverName?: string;
}

/**
 * Reverse-parse a tmux session name into its dev3 kind + short id.
 * Returns null for non-dev3 sessions and for a bare/empty id fragment.
 * Note: legacy names like `dev3-home` parse as kind "task" with a non-UUID
 * shortId — callers that care must filter those explicitly (listTmuxSessions
 * skips `dev3-home` by name).
 */
export function parseDev3SessionName(name: string): ParsedDev3SessionName | null {
	// Longest prefixes first — every specialized prefix also starts with `dev3-`.
	const kinds: Array<{ prefix: string; kind: Dev3SessionKind }> = [
		{ prefix: DEV_SERVER_SESSION_PREFIX, kind: "dev-server" },
		{ prefix: PROJECT_TERMINAL_SESSION_PREFIX, kind: "project-terminal" },
		{ prefix: CLEANUP_SESSION_PREFIX, kind: "cleanup" },
		{ prefix: TASK_SESSION_PREFIX, kind: "task" },
	];
	for (const { prefix, kind } of kinds) {
		if (!name.startsWith(prefix)) continue;
		const rest = name.slice(prefix.length);
		if (!rest) return null;
		if (kind !== "dev-server") return { kind, shortId: rest };
		// `dev3-dev-<short>` is the default server; anything after the next dash
		// names one of the project's other declared servers.
		const dash = rest.indexOf("-");
		if (dash < 0) return { kind, shortId: rest, serverName: DEFAULT_DEV_SERVER_NAME };
		const serverName = rest.slice(dash + 1);
		if (!serverName) return null;
		return { kind, shortId: rest.slice(0, dash), serverName };
	}
	return null;
}
