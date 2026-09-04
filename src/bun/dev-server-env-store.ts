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
import { sanitizeDevServerEnv } from "../shared/dev-server-env";
import { dev3TaskTempPath } from "./temp-paths";

function storePath(taskId: string): string {
	return dev3TaskTempPath(taskId, "dev-server-env.json");
}

/** Remember the extra env for this task's dev server, replacing any previous set. */
export function saveDevServerEnv(taskId: string, env: Record<string, string>): void {
	const path = storePath(taskId);
	if (Object.keys(env).length === 0) {
		clearDevServerEnv(taskId);
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
export function readDevServerEnv(taskId: string): Record<string, string> {
	try {
		const parsed = JSON.parse(readFileSync(storePath(taskId), "utf-8"));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
		return sanitizeDevServerEnv(parsed as Record<string, string>);
	} catch {
		return {};
	}
}

export function clearDevServerEnv(taskId: string): void {
	rmSync(storePath(taskId), { force: true });
}
