/**
 * The ONE place that answers "which backend runs this task's primary terminal"
 * (seq 1292, MIG-004 / INT-001).
 *
 * It decodes the persisted {@link TERMINAL_BACKEND_FIELD} exactly once through
 * the frozen codec and hands back the matching merged adapter. Rules it enforces,
 * all of them load-bearing:
 *
 *  • Absent marker → `tmux`. Legacy and unmarked tasks keep the exact existing
 *    tmux path; nothing is backfilled onto disk.
 *  • An unrecognised persisted value fails honestly. There is no fallback,
 *    because silently running tmux for a task the user marked `native` (or the
 *    reverse) is how two backends end up fighting over one session.
 *  • This module is the only production importer of `./terminal-backend`
 *    (guarded by that module's isolation test), so backend branches cannot
 *    sprout across the app.
 */

import type { Task } from "../shared/types";
import {
	decodeTerminalBackend,
	TERMINAL_BACKEND_FIELD,
	type TerminalBackendIdentity,
} from "../shared/terminal-backend-identity";
import { NativeTerminalBackend, TmuxTerminalBackend, type TerminalBackend } from "./terminal-backend";

// The seam's vocabulary reaches the rest of the app through here, so the
// isolation guard can keep pointing at a single importer.
export type { TerminalLaunchSpec, TerminalSessionState } from "./terminal-backend";
import { nativeHostLauncher, resolveNativeHostRuntime } from "./native-host-runtime";
import { defaultDeps as nativeRegistryDeps } from "./native-terminal-registry/registry";

/** A task whose persisted backend identity cannot be interpreted. */
export class TaskTerminalBackendError extends Error {
	readonly taskId: string;

	constructor(taskId: string, detail: string) {
		super(
			`task ${taskId.slice(0, 8)} has an unusable ${TERMINAL_BACKEND_FIELD}: ${detail}. ` +
				"Fix it with `dev3 task terminal-backend --to tmux` — dev3 will not guess a backend.",
		);
		this.name = "TaskTerminalBackendError";
		this.taskId = taskId;
	}
}

export interface ResolvedTaskTerminalBackend {
	/** Effective identity: the persisted value, or `tmux` for an unmarked task. */
	readonly identity: TerminalBackendIdentity;
	/** Whether the field was actually on the record (false for legacy tasks). */
	readonly present: boolean;
	/** The merged adapter for {@link identity}. */
	readonly backend: TerminalBackend;
}

/**
 * The effective identity only — for the many call sites that just need to know
 * which path to take and must not construct a backend handle.
 */
export function taskTerminalBackendIdentity(task: Task): TerminalBackendIdentity {
	const decoded = decodeTerminalBackend(task);
	if (!decoded.ok) throw new TaskTerminalBackendError(task.id, `${decoded.code} (${JSON.stringify(decoded.received)})`);
	return decoded.backend;
}

/** True when this task's primary terminal must run on the native backend. */
export function taskRunsNativeTerminal(task: Task): boolean {
	return taskTerminalBackendIdentity(task) === "native";
}

/**
 * Deterministic native session id for a task: the same task always addresses the
 * same on-disk native session, so a fresh app process rediscovers it instead of
 * spawning a second host. Portable under the seam's session-id rule (a task id is
 * a UUID, so the result stays inside the 64-char `[A-Za-z0-9_-]` budget).
 */
export function nativeTaskSessionId(taskId: string): string {
	return `dev3-task-${taskId}`;
}

/**
 * The native backend wired to THIS build's host runtime. The runtime is resolved
 * lazily inside the launcher so presence checks and teardown never depend on a
 * launchable host — only actually starting a session does.
 */
export function nativeTaskTerminalBackend(): NativeTerminalBackend {
	return new NativeTerminalBackend({
		deps: {
			registryDeps: {
				...nativeRegistryDeps,
				launchHost: (sessionId, opts, logFd) => nativeHostLauncher(resolveNativeHostRuntime())(sessionId, opts, logFd),
			},
		},
	});
}

/** Decode the identity and return the adapter that serves it. */
export function resolveTaskTerminalBackend(task: Task): ResolvedTaskTerminalBackend {
	const decoded = decodeTerminalBackend(task);
	if (!decoded.ok) throw new TaskTerminalBackendError(task.id, `${decoded.code} (${JSON.stringify(decoded.received)})`);
	return {
		identity: decoded.backend,
		present: decoded.present,
		backend: decoded.backend === "native" ? nativeTaskTerminalBackend() : new TmuxTerminalBackend(),
	};
}
