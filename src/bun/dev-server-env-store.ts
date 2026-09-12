/**
 * The extra environment one dev-server run was started with, so a later
 * `restart` can repeat it.
 *
 * On disk rather than in memory, in the task's temp directory next to the
 * generated wrapper script: the run outlives the app process (a surviving tmux
 * dev session is reattached after a restart of dev-3.0), and `dev3 dev-server
 * status` must still be able to name the keys then. Nothing here belongs in
 * `~/.dev3.0` — it is per-run scratch, cleared on stop.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { DEFAULT_DEV_SERVER_NAME } from "../shared/dev-servers";
import { sanitizeDevServerEnv } from "../shared/dev-server-env";
import { dev3TaskTempPath } from "./temp-paths";

function storePath(taskId: string, server: string): string {
	// The default server keeps the historical filename; a named one gets its own,
	// so restarting the API does not inherit the front end's extra variables.
	const suffix = server === DEFAULT_DEV_SERVER_NAME ? "dev-server-env.json" : `dev-server-env-${server}.json`;
	return dev3TaskTempPath(taskId, suffix);
}

/** Remember the extra env for one of this task's dev servers, replacing any previous set. */
export function saveDevServerEnv(taskId: string, server: string, env: Record<string, string>): void {
	const path = storePath(taskId, server);
	if (Object.keys(env).length === 0) {
		clearDevServerEnv(taskId, server);
		return;
	}
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(env, null, "\t"), "utf-8");
}

/**
 * The extra env of the last start, or `{}`. A missing, unreadable or malformed
 * file reads as "none": a restart that silently loses one variable is bad, but a
 * restart that refuses to run because of a scratch file is worse.
 */
export function readDevServerEnv(taskId: string, server: string): Record<string, string> {
	try {
		const parsed = JSON.parse(readFileSync(storePath(taskId, server), "utf-8"));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
		return sanitizeDevServerEnv(parsed as Record<string, string>);
	} catch {
		return {};
	}
}

export function clearDevServerEnv(taskId: string, server: string): void {
	rmSync(storePath(taskId, server), { force: true });
}
