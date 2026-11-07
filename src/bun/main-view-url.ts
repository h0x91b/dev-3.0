import { viteDevServerUrl } from "../shared/vite-dev-server";

export const BUNDLED_MAIN_VIEW_URL = "views://mainview/index.html";

export interface MainViewUrlDeps {
	channel: string;
	env: Record<string, string | undefined>;
	/** Resolves when something answers at `url`, rejects otherwise. */
	probe: (url: string) => Promise<unknown>;
	log: { info: (msg: string) => void; warn: (msg: string) => void };
}

/**
 * Only the dev channel, and only with a task-allocated Vite port, ever looks
 * for a dev server. No task port means no probe at all: a port nobody owns is
 * a port any other app on the machine may be answering on.
 */
export async function resolveMainViewUrl({ channel, env, probe, log }: MainViewUrlDeps): Promise<string> {
	if (channel !== "dev") return BUNDLED_MAIN_VIEW_URL;
	const devServerUrl = viteDevServerUrl(env);
	if (!devServerUrl) return BUNDLED_MAIN_VIEW_URL;
	try {
		await probe(devServerUrl);
		log.info(`HMR enabled: Vite dev server at ${devServerUrl}`);
		return devServerUrl;
	} catch {
		log.warn(`No Vite dev server at ${devServerUrl}, falling back to bundled assets`);
		return BUNDLED_MAIN_VIEW_URL;
	}
}

/**
 * fetch() has no default timeout, so a process that accepts the connection but
 * never answers would hang the boot forever — the window opens after this.
 */
export function probeDevServer(url: string): Promise<Response> {
	return fetch(url, { method: "HEAD", signal: AbortSignal.timeout(1000) });
}
