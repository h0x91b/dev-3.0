/**
 * An in-memory tmux world behind the narrow {@link TmuxBackendPort}: sessions,
 * panes, focus, echoed input, window-level geometry. It models tmux SEMANTICS,
 * not its argv — the real grammar is proved by `tmux-port.test.ts` (client calls)
 * and `tmux-backend.live-e2e.test.ts` (a real tmux server).
 */

import type { TmuxBackendPort, TmuxLaunch, TmuxPane } from "../tmux-port";

interface FakePane {
	paneId: string;
	active: boolean;
	text: string[];
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

			async capturePane(paneId, includeScrollback) {
				const pane = world.pane(paneId);
				const lines = pane.text.filter((line, index) => line !== "" || index < pane.text.length - 1);
				return (includeScrollback ? lines : lines.slice(-24)).join("\n");
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

	geometry(session: string): { cols: number; rows: number } {
		const found = this.require(session);
		return { cols: found.cols, rows: found.rows };
	}

	private newPane(active: boolean): FakePane {
		return { paneId: `%${this.paneCounter++}`, active, text: [""] };
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

	private sessionOfPane(paneId: string): FakeSession {
		const name = this.sessionForPaneId(paneId);
		if (!name) throw new Error(`no such pane ${paneId}`);
		return this.sessions.get(name)!;
	}

	private pane(paneId: string): FakePane {
		const session = this.sessionOfPane(paneId);
		return session.panes.find((pane) => pane.paneId === paneId)!;
	}
}
