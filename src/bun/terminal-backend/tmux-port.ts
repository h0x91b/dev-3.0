/**
 * The ONLY file in this module that speaks tmux (MIG-002, seq 1280).
 *
 * A narrow port of the tmux operations the backend adapter needs, expressed as
 * plain values. tmux session names, `%pane` ids, `-F` formats, sockets, and the
 * command grammar stay behind it — `tmux-backend.ts` holds product logic only,
 * and nothing tmux-shaped is re-exported from `index.ts`.
 */

import { tmux, type TmuxClient } from "../tmux";
import { PANE_CAPTURE_FORMAT, PANE_SWITCHER_FORMAT } from "../tmux/formats";

export interface TmuxPane {
	readonly paneId: string;
	readonly active: boolean;
}

/** Everything a capture needs to describe a pane, from ONE `list-panes` sweep. */
export interface TmuxPaneObservation {
	readonly paneId: string;
	readonly cols: number;
	readonly rows: number;
	readonly dead: boolean;
	/** The pane's foreground process group leader — part of the incarnation key. */
	readonly pid: number;
	/**
	 * The tmux server's session-creation epoch. tmux publishes no per-process start
	 * signature, so this is what keeps a reused pid from comparing equal across a
	 * server restart, which is exactly when `%N` pane ids begin again.
	 */
	readonly serverEpoch: number;
	/** Scrollback lines the server currently holds for this pane. */
	readonly historySize: number;
	/** True while a full-screen program owns the pane, so its history is frozen. */
	readonly alternateScreen: boolean;
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
	splitPane(fromPaneId: string, launch: TmuxLaunch, orientation?: "horizontal" | "vertical"): Promise<string>;
	selectPane(paneId: string): Promise<void>;
	/** Raw text delivered to the pane's process, control bytes included. */
	writePane(paneId: string, data: string): Promise<void>;
	resize(session: string, cols: number, rows: number): Promise<void>;
	/** Geometry, liveness, incarnation, and history depth — no content. */
	observePane(session: string, paneId: string): Promise<TmuxPaneObservation | null>;
	/** The visible screen, one entry per row, top row first. */
	captureViewport(paneId: string): Promise<string[]>;
	/** Up to `lines` scrolled-off lines ending immediately above the screen, oldest first. */
	captureHistory(paneId: string, lines: number): Promise<string[]>;
	killPane(paneId: string, bestEffort: boolean): Promise<void>;
	killSession(session: string, bestEffort: boolean): Promise<void>;
}

/**
 * `capture-pane` line numbering: `0` is the top visible row, so a negative
 * start reaches into scrollback and `-1` is the last line above the screen.
 * Splitting the two reads is what lets the seam report viewport and history
 * separately instead of handing back one ambiguous blob.
 */
const LAST_HISTORY_LINE = -1;

function captureLines(stdout: string): string[] {
	const text = stdout.replace(/\n$/, "");
	return text === "" ? [] : text.split("\n");
}

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

		async splitPane(fromPaneId, launch, orientation = "vertical") {
			const { paneId } = await client.splitWindow({
				target: fromPaneId,
				orientation,
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

		async observePane(session, paneId) {
			const rows = await client.listPanes(PANE_CAPTURE_FORMAT, { target: session, scope: "session" });
			const row = rows.find((entry) => entry.paneId === paneId);
			if (!row) return null;
			return {
				paneId: row.paneId,
				cols: row.width,
				rows: row.height,
				dead: row.dead,
				pid: row.pid,
				serverEpoch: row.serverEpoch,
				historySize: row.historySize,
				alternateScreen: row.alternateScreen,
			};
		},

		async captureViewport(paneId) {
			return captureLines(await client.capturePane({ target: paneId }));
		},

		async captureHistory(paneId, lines) {
			if (lines <= 0) return [];
			return captureLines(
				await client.capturePane({ target: paneId, startLine: -lines, endLine: LAST_HISTORY_LINE }),
			);
		},

		killPane: (paneId, bestEffort) => client.killPane(paneId, { bestEffort }),

		killSession: (session, bestEffort) => client.killSession(session, { bestEffort }),
	};
}
