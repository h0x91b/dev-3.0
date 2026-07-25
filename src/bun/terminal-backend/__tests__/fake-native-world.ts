/**
 * An in-memory native world behind the single-view adapter's injectable seams:
 * session records, tokens, ownership verdicts, the bounded parser snapshot, and
 * an attached client that echoes input. Deliberately structural (no registry
 * imports) so the seam's tests do not widen the registry's import graph.
 */

import type { NativeAdapterDeps } from "../../native-terminal-adapter";

interface FakeSession {
	paneId: string;
	lines: string[];
	watermark: number;
	cols: number;
	rows: number;
	env: Record<string, string>;
}

export class FakeNativeWorld {
	readonly sessions = new Map<string, FakeSession>();
	/** Flip to model a record that exists but belongs to another app instance. */
	ownership: "owned" | "foreign" = "owned";
	readonly closedClients: string[] = [];

	/** A fresh set of deps over the SAME world (models a reconnecting process). */
	deps(): Partial<NativeAdapterDeps> {
		const world = this;
		return {
			start: (async (id: string, opts: { launch?: { env?: Record<string, string> } }) => {
				const session: FakeSession = {
					paneId: `${id}:0`,
					lines: [""],
					watermark: 0,
					cols: 80,
					rows: 24,
					env: { ...(opts?.launch?.env ?? {}) },
				};
				world.sessions.set(id, session);
				return { status: "started", record: world.record(id) };
			}) as never,

			stop: (async (id: string) => world.sessions.delete(id)) as never,

			readRecord: ((id: string) => (world.sessions.has(id) ? world.record(id) : null)) as never,

			readToken: ((id: string) => (world.sessions.has(id) ? `token-${id}` : null)) as never,

			classifyOwnership: (async () => world.ownership) as never,

			readSnapshot: ((id: string) => {
				const session = world.sessions.get(id);
				if (!session) return null;
				return {
					watermarkSeq: session.watermark,
					state: {
						screen: session.lines.map((text) => ({ text, wrapped: null, cells: [] })),
						scrollback: [],
					},
				};
			}) as never,

			connect: (async (record: { sessionId: string }) => {
				const id = record.sessionId;
				return {
					input: (data: string) => world.echo(id, data),
					resize: (cols: number, rows: number) => world.setSize(id, cols, rows),
					close: () => world.closedClients.push(id),
				};
			}) as never,
		};
	}

	/** Simulate the shell exiting: the host removes the session's record. */
	killSessionProcess(id: string): void {
		this.sessions.delete(id);
	}

	geometry(id: string): { cols: number; rows: number } {
		const session = this.require(id);
		return { cols: session.cols, rows: session.rows };
	}

	private echo(id: string, data: string): void {
		const session = this.require(id);
		for (const chunk of String(data).split(/\r\n|\r|\n/)) {
			session.lines[session.lines.length - 1] += chunk;
			session.lines.push("");
		}
		session.watermark += 1;
	}

	private setSize(id: string, cols: number, rows: number): void {
		const session = this.require(id);
		session.cols = cols;
		session.rows = rows;
	}

	private require(id: string): FakeSession {
		const session = this.sessions.get(id);
		if (!session) throw new Error(`no such native session ${id}`);
		return session;
	}

	private record(id: string): unknown {
		const session = this.require(id);
		return {
			sessionId: id,
			paneId: session.paneId,
			cols: session.cols,
			rows: session.rows,
			endpoint: { transport: "ws", address: "127.0.0.1", port: 0 },
		};
	}
}
