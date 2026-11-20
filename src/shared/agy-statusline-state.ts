import { resolveDev3Home } from "./dev3-home";
import { resolveAccountHome } from "./user-home";

const SAFE_TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * The data root `dev3 statusline agy` and `dev3 hook agy` write under. agy runs them with the
 * launcher's HOME, which may be a private directory, so the account's own home decides unless
 * `$DEV3_HOME` redirects the whole instance.
 */
export function agyDev3Home(env: Record<string, string | undefined> = process.env): string {
	return resolveDev3Home({ ...env, HOME: resolveAccountHome() });
}

/** The directory holding one file per pane for a task; null for an id that is not a safe path segment. */
export function agyStatuslineTaskDir(dev3Home: string, taskId: string): string | null {
	return SAFE_TASK_ID.test(taskId) ? `${dev3Home}/data/agy-statusline/${taskId}` : null;
}

/**
 * Which pane an agy process belongs to: tmux's pane, else the native terminal's, else the
 * conversation id. Two agy panes of one task must never share a state file.
 */
export function agyPaneKey(env: Record<string, string | undefined>, conversationId: string | null): string | null {
	const raw = env.TMUX_PANE?.trim() || env.DEV3_PANE_ID?.trim() || conversationId;
	return raw ? `p${raw.replace(/[^A-Za-z0-9._-]/g, "_")}` : null;
}

export function agyStatuslineStateFile(dev3Home: string, taskId: string, paneKey: string | null): string | null {
	const dir = agyStatuslineTaskDir(dev3Home, taskId);
	return dir && paneKey ? `${dir}/${paneKey}.json` : null;
}
