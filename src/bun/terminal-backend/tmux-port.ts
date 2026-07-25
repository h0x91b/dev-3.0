/**
 * The ONLY file in this module that speaks tmux (MIG-002, seq 1280).
 *
 * A narrow port of the tmux operations the backend adapter needs, expressed as
 * plain values. tmux session names, `%pane` ids, `-F` formats, sockets, and the
 * command grammar stay behind it — `tmux-backend.ts` holds product logic only,
 * and nothing tmux-shaped is re-exported from `index.ts`.
 */

import { tmux, type TmuxClient } from "../tmux";
import { PANE_SWITCHER_FORMAT } from "../tmux/formats";

export interface TmuxPane {
	readonly paneId: string;
	readonly active: boolean;
}

export interface TmuxLaunch {
	readonly cwd: string;
	readonly env?: Readonly<Record<string, string>>;
	readonly command?: string;
}

/** Every tmux capability the backend adapter consumes. */
export interface TmuxBackendPort {
	hasSession(session: string): Promise<boolean>;
	newSessionDetached(session: string, launch: TmuxLaunch): Promise<void>;
	listPanes(session: string): Promise<TmuxPane[]>;
	activePaneId(session: string): Promise<string | null>;
	splitPane(fromPaneId: string, launch: TmuxLaunch): Promise<string>;
	selectPane(paneId: string): Promise<void>;
	/** Raw text delivered to the pane's process, control bytes included. */
	writePane(paneId: string, data: string): Promise<void>;
	resize(session: string, cols: number, rows: number): Promise<void>;
	capturePane(paneId: string, includeScrollback: boolean): Promise<string>;
	killPane(paneId: string, bestEffort: boolean): Promise<void>;
	killSession(session: string, bestEffort: boolean): Promise<void>;
}

/** Bounded history so a burst is fully visible without an unbounded capture. */
const SCROLLBACK_START_LINE = -3000;

/** The production port over the typed tmux client singleton. */
export function tmuxBackendPort(client: TmuxClient = tmux): TmuxBackendPort {
	return {
		hasSession: (session) => client.hasSession(session),

		async newSessionDetached(session, launch) {
			await client.newSessionDetached({
				sessionName: session,
				cwd: launch.cwd,
				env: launch.env as Record<string, string> | undefined,
				command: launch.command,
			});
		},

		async listPanes(session) {
			const rows = await client.listPanes(PANE_SWITCHER_FORMAT, { target: session, scope: "session" });
			return rows.map((row) => ({ paneId: row.paneId, active: row.active }));
		},

		activePaneId: (session) => client.activePaneId(session),

		async splitPane(fromPaneId, launch) {
			const { paneId } = await client.splitWindow({
				target: fromPaneId,
				orientation: "vertical",
				cwd: launch.cwd,
				env: launch.env as Record<string, string> | undefined,
				command: launch.command,
				printPaneId: true,
			});
			if (!paneId) throw new Error(`tmux split of ${fromPaneId} returned no pane id`);
			return paneId;
		},

		selectPane: (paneId) => client.selectPane(paneId),

		writePane: (paneId, data) => client.sendKeys(paneId, [data], { literal: true }),

		resize: (session, cols, rows) => client.resizeWindow({ target: session, cols, rows }),

		capturePane: (paneId, includeScrollback) =>
			client.capturePane({
				target: paneId,
				startLine: includeScrollback ? SCROLLBACK_START_LINE : undefined,
			}),

		killPane: (paneId, bestEffort) => client.killPane(paneId, { bestEffort }),

		killSession: (session, bestEffort) => client.killSession(session, { bestEffort }),
	};
}
