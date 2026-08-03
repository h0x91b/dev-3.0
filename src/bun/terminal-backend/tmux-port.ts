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

/** One point-in-time capture: rows plus the facts observed in the same turn. */
export interface TmuxContiguousCapture {
	readonly pane: TmuxPaneObservation;
	readonly viewport: string[];
	readonly history: string[];
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
	/**
	 * ONE contiguous capture: the pane's facts and its rows from a single server
	 * turn, already split into history and viewport. `null` when the pane is gone.
	 */
	capturePane(paneId: string, historyLines: number): Promise<TmuxContiguousCapture | null>;
	killPane(paneId: string, bestEffort: boolean): Promise<void>;
	killSession(session: string, bestEffort: boolean): Promise<void>;
}

function paneFrom(row: {
	paneId: string;
	width: number;
	height: number;
	dead: boolean;
	pid: number;
	serverEpoch: number;
	historySize: number;
	alternateScreen: boolean;
}): TmuxPaneObservation {
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
			return row ? paneFrom(row) : null;
		},

		async capturePane(paneId, historyLines) {
			const captured = await client.capturePaneWithFacts(PANE_CAPTURE_FORMAT, {
				target: paneId,
				...(historyLines > 0 ? { startLine: -historyLines } : {}),
			});
			if (!captured) return null;
			const pane = paneFrom(captured.facts);
			// Split from the FRONT by the history depth observed in the same turn:
			// `capture-pane` trims trailing blank rows, so counting the viewport from the
			// end would eat history on a partly-blank screen.
			const historyRows = historyLines > 0 ? Math.min(pane.historySize, historyLines) : 0;
			return {
				pane,
				history: captured.rows.slice(0, historyRows),
				viewport: captured.rows.slice(historyRows),
			};
		},

		killPane: (paneId, bestEffort) => client.killPane(paneId, { bestEffort }),

		killSession: (session, bestEffort) => client.killSession(session, { bestEffort }),
	};
}
