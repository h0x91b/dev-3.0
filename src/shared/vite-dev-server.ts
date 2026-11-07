/**
 * The only port a Vite dev server for dev-3.0 itself may use: the task's own
 * pool port. A hardcoded port is shared by every project on the machine, so
 * whatever answers there is usually somebody else's app — see
 * `decisions/2026/11/05/vite-dev-port-from-task-pool.md`.
 */
export const VITE_DEV_PORT_ENV = "DEV3_PORT1";

/** The task-allocated Vite port, or null when this shell has none. */
export function viteDevPort(env: Record<string, string | undefined>): number | null {
	const raw = env[VITE_DEV_PORT_ENV]?.trim();
	if (!raw || !/^\d+$/.test(raw)) return null;
	const port = Number(raw);
	return port >= 1 && port <= 65535 ? port : null;
}

export function viteDevServerUrl(env: Record<string, string | undefined>): string | null {
	const port = viteDevPort(env);
	return port === null ? null : `http://localhost:${port}`;
}
