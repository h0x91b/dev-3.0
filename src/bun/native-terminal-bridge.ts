/**
 * App-side bridge state for a NATIVE task terminal's viewers (seq 1300).
 *
 * The app holds one writer client against the native host; every viewer —
 * desktop window, remote browser tab — multiplexes through it over the PTY
 * WebSocket. That multiplexing needs two things the tmux path gets for free
 * from tmux itself:
 *
 *  • {@link NativeBridgeJournal} — a bounded mirror of the output the app has
 *    already broadcast, so a viewer that attaches mid-session (or reconnects
 *    after a tunnel drop) is handed the screen instead of a blank terminal.
 *    Bounded means a viewer can fall off it; that is reported as an explicit
 *    reset, never as unbounded buffering or a silently corrupt screen.
 *  • {@link NativeClientLease} — exactly one WRITER among the viewers. tmux lets
 *    every attached client type; a native session has one PTY and no client
 *    arbitration of its own, so two viewers typing (or two viewports resizing)
 *    would fight over one shell. Observers are read-only until they explicitly
 *    take over.
 *
 * Both are pure in-memory structures over opaque client handles, so they are
 * unit-testable without a WebSocket, and neither knows anything about tmux.
 */

import type { NativeStreamResetReason, NativeStreamRole } from "../shared/native-terminal-stream";

/** Matches the host's own journal cap — the app mirrors, it does not extend. */
export const DEFAULT_BRIDGE_JOURNAL_MAX_BYTES = 256 * 1024;

export interface BridgeReplay {
	/** Watermark after applying `data`; the client resumes from here. */
	seq: number;
	data: string;
	/** True when `data` continues the client's stream; false when it replaces the screen. */
	resumed: boolean;
	/** Why the screen was replaced. Absent when `resumed`. */
	reset?: NativeStreamResetReason;
}

/**
 * Byte-capped ring of the frames already broadcast for one native session.
 *
 * Sequence numbers are 1-based and strictly increasing for the life of the
 * session, so a client's watermark stays meaningful across reconnects. Frames
 * are evicted oldest-first once the cap is exceeded; a client whose watermark
 * was evicted gets the whole retained tail and an explicit `pressure` reset.
 */
export class NativeBridgeJournal {
	private frames: Array<{ seq: number; data: string }> = [];
	private bytes = 0;
	private tail = 0;
	private evicted = false;
	private resets = 0;

	constructor(private readonly maxBytes: number = DEFAULT_BRIDGE_JOURNAL_MAX_BYTES) {}

	/** Seq of the newest retained frame; 0 before any output. */
	get tailSeq(): number {
		return this.tail;
	}

	/** Seq of the oldest retained frame; 0 when empty. */
	get headSeq(): number {
		return this.frames[0]?.seq ?? 0;
	}

	/** How many attaches had to replace the screen because the watermark was gone. */
	get resyncCount(): number {
		return this.resets;
	}

	/** Record one broadcast frame and return its sequence number. */
	push(data: string): number {
		if (!data) return this.tail;
		const seq = ++this.tail;
		this.frames.push({ seq, data });
		this.bytes += data.length;
		while (this.frames.length > 1 && this.bytes > this.maxBytes) {
			this.bytes -= this.frames.shift()!.data.length;
			this.evicted = true;
		}
		return seq;
	}

	/**
	 * What to send a client attaching with watermark `since` (`null` = never had
	 * one). Ahead-or-level clients get nothing, which is what makes a reconnect
	 * free of duplicated bytes; a reachable watermark gets the delta after it.
	 */
	replayFrom(since: number | null): BridgeReplay {
		if (since === null) {
			this.resets++;
			return { seq: this.tail, data: this.joinAll(), resumed: false, reset: "fresh" };
		}
		if (since >= this.tail) return { seq: this.tail, data: "", resumed: true };
		const head = this.headSeq;
		if (head === 0 || since < head - 1) {
			this.resets++;
			const reason: NativeStreamResetReason = this.evicted ? "pressure" : "gap";
			return { seq: this.tail, data: this.joinAll(), resumed: false, reset: reason };
		}
		let data = "";
		for (const frame of this.frames) {
			if (frame.seq > since) data += frame.data;
		}
		return { seq: this.tail, data, resumed: true };
	}

	private joinAll(): string {
		let data = "";
		for (const frame of this.frames) data += frame.data;
		return data;
	}
}

export interface LeaseChange<C> {
	writer: C | null;
	/** The client that held the lease before this change, if any. */
	previous: C | null;
}

/**
 * Single-writer lease over a native session's viewers.
 *
 * The first viewer to attach becomes the writer; later ones observe. A takeover
 * is one atomic step — the lease moves, and both the old and new writer learn
 * their new role — so there is never a moment with two writers or none while
 * viewers remain.
 */
export class NativeClientLease<C> {
	/** Insertion-ordered, so promotion after a writer leaves is deterministic. */
	private readonly clients = new Set<C>();
	private current: C | null = null;

	get writer(): C | null {
		return this.current;
	}

	get size(): number {
		return this.clients.size;
	}

	roleOf(client: C): NativeStreamRole {
		return this.current === client ? "writer" : "observer";
	}

	canWrite(client: C): boolean {
		return this.current === client;
	}

	attach(client: C): NativeStreamRole {
		this.clients.add(client);
		if (this.current === null) this.current = client;
		return this.roleOf(client);
	}

	/** Take the lease. Returns `null` when this client already held it. */
	claim(client: C): LeaseChange<C> | null {
		if (!this.clients.has(client) || this.current === client) return null;
		const previous = this.current;
		this.current = client;
		return { writer: client, previous };
	}

	/** Hand the lease back. Returns `null` unless this client held it. */
	release(client: C): LeaseChange<C> | null {
		if (this.current !== client) return null;
		this.current = this.nextAfter(client);
		return { writer: this.current, previous: client };
	}

	/** Drop a disconnected viewer. Returns the promotion when the writer left. */
	detach(client: C): LeaseChange<C> | null {
		const wasWriter = this.current === client;
		this.clients.delete(client);
		if (!wasWriter) return null;
		this.current = this.nextAfter(client);
		return { writer: this.current, previous: client };
	}

	private nextAfter(client: C): C | null {
		for (const candidate of this.clients) {
			if (candidate !== client) return candidate;
		}
		return null;
	}
}
