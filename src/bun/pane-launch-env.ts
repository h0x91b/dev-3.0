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

/**
 * The DEV3_ keys that describe the app instance rather than the pane that started it, so a tmux
 * server or native host the app starts may keep them. Every other DEV3_ key is per-task or
 * per-pane wiring (task identity, ports, artifact template, dev server, lean protocol, pane id):
 * an allowlist, so a key a pane builder adds later is dropped without a change here.
 */
const APP_GLOBAL_DEV3_KEYS = new Set([
	"DEV3_HOME", "DEV3_LOG_DIR", "DEV3_LOG_LEVEL", "DEV3_DEBUG", "DEV3_QA_SCOPE", "DEV3_FRESH_START",
	"DEV3_TELEMETRY", "DEV3_CHANNEL", "DEV3_DISABLE_UPDATES", "DEV3_NATIVE_SESSIONS_DIR", "DEV3_EXPECT_HOST_EXECUTABLE",
]);
const APP_GLOBAL_DEV3_PREFIXES = ["DEV3_REMOTE_", "DEV3_NATIVE_HOST_", "DEV3_TERMINAL_HOST_"];

/** The launch value of each task wiring key, from the last reset. */
let launchTaskWiring = new Map<string, string | undefined>();

/** True when `env` comes from a pane on dev3's own tmux server (task, Repo terminal or dev server). */
export function startedInsideDev3Pane(env: Record<string, string | undefined>): boolean {
	if (env.DEV3_TASK_ID?.trim() || env.DEV3_PROJECT_PATH?.trim()) return true;
	const socketPath = env.TMUX?.split(",")[0];
	return !!socketPath && basename(socketPath) === DEFAULT_TMUX_SOCKET;
}

function isBaseKey(key: string): boolean {
	return BASE_ENV_KEYS.has(key) || BASE_ENV_PREFIXES.some((prefix) => key.startsWith(prefix));
}

/** True for a DEV3_ key that a pane launch writes for its own task or pane. */
export function isTaskWiringKey(key: string): boolean {
	if (!key.startsWith("DEV3_")) return false;
	return !APP_GLOBAL_DEV3_KEYS.has(key) && !APP_GLOBAL_DEV3_PREFIXES.some((prefix) => key.startsWith(prefix));
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
	launchTaskWiring = new Map(Object.keys(env).filter(isTaskWiringKey).map((key) => [key, env[key]]));
	return removed;
}

/**
 * `env` with each task wiring key the app was started with set to undefined, for a tmux server or
 * native host it starts. A key whose value differs from the launch value was set on purpose later
 * (a new task's id or port) and stays. An absent key is set too: the spawn wrapper merges
 * process.env back in, and only undefined unsets there.
 */
export function withoutLaunchTaskWiring(env: Record<string, string | undefined>): Record<string, string | undefined> {
	if (launchTaskWiring.size === 0) return env;
	const next = { ...env };
	for (const [key, launchValue] of launchTaskWiring) {
		if (next[key] === undefined || next[key] === launchValue) next[key] = undefined;
	}
	return next;
}

export function _resetLaunchTaskWiringForTests(): void {
	launchTaskWiring = new Map();
}
