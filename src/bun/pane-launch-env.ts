// An app started inside a dev3 pane inherits that pane's launch env, and its tmux server
// would hand it to every later pane. decisions/2026/11/16/rebuild-env-when-started-inside-a-dev3-pane.md
import { basename } from "node:path";
import { DEFAULT_TMUX_SOCKET } from "./tmux/constants";

/** OS and desktop-session keys a fresh app gets; the login shell restores the user's own on top. */
const BASE_ENV_KEYS = new Set([
	"HOME", "USER", "LOGNAME", "SHELL", "PATH", "TMPDIR", "TMP", "TZ", "LANG", "LANGUAGE",
	"SSH_AUTH_SOCK", "SSH_CONNECTION", "DBUS_SESSION_BUS_ADDRESS", "DISPLAY", "WAYLAND_DISPLAY",
	"XAUTHORITY", "XMODIFIERS", "DESKTOP_SESSION", "container",
	"WSLENV", "WSL_DISTRO_NAME", "WSL_INTEROP", "TMUX_TMPDIR", "LD_LIBRARY_PATH", "COMMAND_MODE",
	// Not from the OS, but a user's opt-out and a dev build's Vite port must survive.
	"DO_NOT_TRACK", "VITE_PORT",
]);
// DEV3_ keys are dev3's own launch settings (DEV3_HOME, DEV3_PORT*, DEV3_QA_SCOPE, ...) and stay.
const BASE_ENV_PREFIXES = ["DEV3_", "BUN_", "LC_", "XDG_", "XPC_", "__CF", "GDK_", "GTK_", "QT_", "SDL_"];

/** The per-task keys a pane launch writes. The app may read them; the tmux server must not get them. */
const TASK_WIRING_PREFIXES = ["DEV3_TASK_", "DEV3_WORKTREE_", "DEV3_PROJECT_", "DEV3_PORT"];
const TASK_WIRING_KEYS = new Set(["DEV3_BRANCH_NAME", "DEV3_DEV_SERVER", "DEV3_ARTIFACT_TEMPLATE_DIR", "DEV3_LEAN_PROTOCOL", "DEV3_PANE_ID"]);

let launchTaskWiringKeys: string[] = [];

/** True when `env` comes from a pane on dev3's own tmux server (task, Repo terminal or dev server). */
export function startedInsideDev3Pane(env: Record<string, string | undefined>): boolean {
	if (env.DEV3_TASK_ID?.trim() || env.DEV3_PROJECT_PATH?.trim()) return true;
	const socketPath = env.TMUX?.split(",")[0];
	return !!socketPath && basename(socketPath) === DEFAULT_TMUX_SOCKET;
}

function isBaseKey(key: string): boolean {
	return BASE_ENV_KEYS.has(key) || BASE_ENV_PREFIXES.some((prefix) => key.startsWith(prefix));
}

function isTaskWiringKey(key: string): boolean {
	return TASK_WIRING_KEYS.has(key) || TASK_WIRING_PREFIXES.some((prefix) => key.startsWith(prefix));
}

/**
 * From a dev3 pane: delete in place every key a fresh app would not have, remember the per-task
 * keys, and return the deleted ones. Run it before the login-shell import, which restores the user's own.
 */
export function resetEnvFromDev3Pane(
	env: Record<string, string | undefined>,
	platform: NodeJS.Platform = process.platform,
): string[] {
	if (platform === "win32" || !startedInsideDev3Pane(env)) return [];
	const removed = Object.keys(env).filter((key) => !isBaseKey(key));
	for (const key of removed) delete env[key];
	launchTaskWiringKeys = Object.keys(env).filter(isTaskWiringKey);
	return removed;
}

/**
 * `env` with the per-task keys the app was started with set to undefined, for a tmux server it
 * starts. Undefined, not deleted: the spawn wrapper merges process.env back in, and undefined unsets.
 */
export function withoutLaunchTaskWiring(env: Record<string, string | undefined>): Record<string, string | undefined> {
	if (launchTaskWiringKeys.length === 0) return env;
	const next = { ...env };
	for (const key of launchTaskWiringKeys) next[key] = undefined;
	return next;
}

export function _resetLaunchTaskWiringForTests(): void {
	launchTaskWiringKeys = [];
}
