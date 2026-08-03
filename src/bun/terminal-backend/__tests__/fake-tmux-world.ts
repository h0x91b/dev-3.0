/**
 * An in-memory tmux world behind the narrow {@link TmuxBackendPort}: sessions,
 * panes, focus, echoed input, window-level geometry. It models tmux SEMANTICS,
 * not its argv — the real grammar is proved by `tmux-port.test.ts` (client calls)
 * and `tmux-backend.live-e2e.test.ts` (a real tmux server).
 */

import type { TmuxBackendPort, TmuxLaunch, TmuxPane, TmuxPaneObservation } from "../tmux-port";

interface FakePane {
	paneId: string;
	active: boolean;
	text: string[];
	pid: number;
	/** Flip to model a full-screen program owning the pane. */
	alternateScreen: boolean;
}

interface FakeSession {
	panes: FakePane[];
	cols: number;
	rows: number;
	cwd: string;
	env: Record<string, string>;
}

export class FakeTmuxWorld {
	readonly sessions = new Map<string, FakeSession>();
	/** Bump to model a whole tmux server restart, where `%N` pane ids begin again. */
	serverEpoch = 1_700_000_000;
	private paneCounter = 0;

	/** A fresh controller over the SAME world (models a reconnecting process). */
	port(): TmuxBackendPort {
		const world = this;
		return {
			hasSession: async (session) => world.sessions.has(session),

			async newSessionDetached(session, launch: TmuxLaunch) {
				if (world.sessions.has(session)) throw new Error(`duplicate session ${session}`);
				world.sessions.set(session, {
					panes: [world.newPane(true)],
					cols: 80,
					rows: 24,
					cwd: launch.cwd,
					env: { ...(launch.env ?? {}) },
				});
			},

			async listPanes(session): Promise<TmuxPane[]> {
				const found = world.require(session);
				return found.panes.map((pane) => ({ paneId: pane.paneId, active: pane.active }));
			},

			async activePaneId(session) {
				return world.require(session).panes.find((pane) => pane.active)?.paneId ?? null;
			},

			async splitPane(fromPaneId, _launch) {
				const session = world.sessionOfPane(fromPaneId);
				const pane = world.newPane(false);
				session.panes.push(pane);
				for (const other of session.panes) other.active = other === pane;
				return pane.paneId;
			},

			async selectPane(paneId) {
				const session = world.sessionOfPane(paneId);
				for (const pane of session.panes) pane.active = pane.paneId === paneId;
			},

			async writePane(paneId, data) {
				// A shell echoes what it receives; CR starts a new line.
				const pane = world.pane(paneId);
				for (const chunk of data.split(/\r\n|\r|\n/)) {
					pane.text[pane.text.length - 1] = (pane.text[pane.text.length - 1] ?? "") + chunk;
					pane.text.push("");
				}
			},

			async resize(session, cols, rows) {
				const found = world.require(session);
				found.cols = cols;
				found.rows = rows;
			},

			async observePane(session, paneId): Promise<TmuxPaneObservation | null> {
				const found = world.require(session);
				const pane = found.panes.find((entry) => entry.paneId === paneId);
				if (!pane) return null;
				return {
					paneId: pane.paneId,
					cols: found.cols,
					rows: found.rows,
					dead: false,
					pid: pane.pid,
					serverEpoch: world.serverEpoch,
					historySize: Math.max(0, world.lines(pane).length - found.rows),
					alternateScreen: pane.alternateScreen,
				};
			},

			async captureViewport(paneId) {
				const found = world.sessionOfPane(paneId);
				return world.lines(world.pane(paneId)).slice(-found.rows);
			},

			async captureHistory(paneId, lines) {
				if (lines <= 0) return [];
				const found = world.sessionOfPane(paneId);
				const all = world.lines(world.pane(paneId));
				const history = all.slice(0, Math.max(0, all.length - found.rows));
				return history.slice(-lines);
			},

			async killPane(paneId, bestEffort) {
				const session = world.sessionForPaneId(paneId);
				if (!session) {
					if (bestEffort) return;
					throw new Error(`no such pane ${paneId}`);
				}
				const entry = world.sessions.get(session)!;
				entry.panes = entry.panes.filter((pane) => pane.paneId !== paneId);
				if (entry.panes.length === 0) world.sessions.delete(session);
				else if (!entry.panes.some((pane) => pane.active)) entry.panes[0].active = true;
			},

			async killSession(session, bestEffort) {
				if (!world.sessions.delete(session) && !bestEffort) {
					throw new Error(`can't find session ${session}`);
				}
			},
		};
	}

	/** Simulate the pane's process exiting (tmux reaps the pane). */
	killPaneProcess(paneId: string): void {
		const session = this.sessionForPaneId(paneId);
		if (!session) return;
		const entry = this.sessions.get(session)!;
		entry.panes = entry.panes.filter((pane) => pane.paneId !== paneId);
		if (entry.panes.length === 0) this.sessions.delete(session);
	}

	/** Replace a pane's process, as tmux does when a `remain-on-exit` pane respawns. */
	replacePaneProcess(paneId: string): void {
		this.pane(paneId).pid += 1;
	}

	/** Model a full-screen program taking over the pane. */
	enterAlternateScreen(paneId: string): void {
		this.pane(paneId).alternateScreen = true;
	}

	/** Non-empty rows of a pane, oldest first — the fake's whole "screen + history". */
	lines(pane: FakePane): string[] {
		return pane.text.filter((line, index) => line !== "" || index < pane.text.length - 1);
	}

	geometry(session: string): { cols: number; rows: number } {
		const found = this.require(session);
		return { cols: found.cols, rows: found.rows };
	}

	private newPane(active: boolean): FakePane {
		const index = this.paneCounter++;
		return { paneId: `%${index}`, active, text: [""], pid: 9000 + index, alternateScreen: false };
	}

	private require(session: string): FakeSession {
		const found = this.sessions.get(session);
		if (!found) throw new Error(`can't find session ${session}`);
		return found;
	}

	private sessionForPaneId(paneId: string): string | null {
		for (const [name, session] of this.sessions) {
			if (session.panes.some((pane) => pane.paneId === paneId)) return name;
		}
		return null;
	}

	sessionOfPane(paneId: string): FakeSession {
		const name = this.sessionForPaneId(paneId);
		if (!name) throw new Error(`no such pane ${paneId}`);
		return this.sessions.get(name)!;
	}

	pane(paneId: string): FakePane {
		const session = this.sessionOfPane(paneId);
		return session.panes.find((pane) => pane.paneId === paneId)!;
	}
}
