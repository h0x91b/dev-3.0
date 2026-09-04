/**
 * Caller-supplied environment for a dev server (`dev3 dev-server start --env
 * KEY=VALUE`, repeatable).
 *
 * Shared so the CLI's rejection and the backend's filter agree on one rule set:
 * the CLI is the friendly gate (a documented exit code plus a message), the
 * backend is the real one — `devServer.start` is also reachable from the
 * renderer and from any other socket client, so it must not trust its input.
 */

/**
 * Names a caller may not set. Two families, for two different reasons:
 *
 * - `PATH` / `HOME` / `SHELL` — the wrapper script and everything the devScript
 *   spawns resolve through them. A caller that rewrites one breaks the pane in
 *   a way that looks like a broken devScript.
 * - `DEV3_TASK_ID` / `DEV3_WORKTREE_ROOT` — identity of the task the pane
 *   belongs to. Faking either makes the pane lie about who owns it.
 *
 * `DEV3_PORT*` is blocked by {@link isBlockedDevServerEnvKey} rather than
 * listed here: the pool decides those, and moving the server off its assigned
 * `DEV3_PORT0` is exactly what breaks `--wait`.
 */
export const BLOCKED_DEV_SERVER_ENV_KEYS: readonly string[] = [
	"PATH",
	"HOME",
	"SHELL",
	"DEV3_TASK_ID",
	"DEV3_WORKTREE_ROOT",
];

const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function isBlockedDevServerEnvKey(key: string): boolean {
	return BLOCKED_DEV_SERVER_ENV_KEYS.includes(key) || key.startsWith("DEV3_PORT");
}

export type DevServerEnvPair = { key: string; value: string };

/**
 * Split one `KEY=VALUE` argument. Returns an error string instead of throwing so
 * the CLI can pick its own exit code and the backend can log and skip.
 *
 * An empty value is legal (`--env DEBUG=`): unsetting-by-empty is a normal
 * thing to want from a shell.
 */
export function parseDevServerEnvPair(raw: string): DevServerEnvPair | { error: string } {
	const eq = raw.indexOf("=");
	if (eq <= 0) {
		return { error: `expected KEY=VALUE, got "${raw}"` };
	}
	const key = raw.slice(0, eq);
	if (!ENV_KEY_PATTERN.test(key)) {
		return { error: `"${key}" is not a valid environment variable name (letters, digits and _; not starting with a digit)` };
	}
	if (isBlockedDevServerEnvKey(key)) {
		return { error: `"${key}" is set by dev3 itself and cannot be overridden` };
	}
	return { key, value: raw.slice(eq + 1) };
}

/** Drop every pair the rules above reject. The backend's own gate. */
export function sanitizeDevServerEnv(env: Record<string, string> | undefined): Record<string, string> {
	const clean: Record<string, string> = {};
	for (const [key, value] of Object.entries(env ?? {})) {
		if (!ENV_KEY_PATTERN.test(key) || isBlockedDevServerEnvKey(key)) continue;
		clean[key] = String(value);
	}
	return clean;
}
