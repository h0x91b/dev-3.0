/**
 * Attach CLIENT for the native-session registry (seq 1214/1216).
 *
 * A short-lived handle over one session host's loopback-TCP WebSocket. Any
 * number of these come and go while the host + shell stay alive. `connect()`
 * performs the v1 `hello` handshake and resolves only once the host answers
 * `welcome`; a version/session mismatch rejects with the host's explicit error.
 * `discover()` reconnects a brand-new, unrelated process from the on-disk record
 * + private token alone — modelling a fresh client reattaching to a live session.
 */

import {
	decodeControl,
	decodeError,
	encodeControl,
	helloMessage,
	ownershipRequest,
	resizeMessage,
	type HostCapability,
	statusRequest,
	stopRequest,
	type ErrorCode,
	type ErrorMessage,
	type OwnershipReply,
	type ResizedReply,
	type StatusReply,
} from "./protocol";
import { DEFAULT_JOURNAL_MAX_BYTES } from "./journal";
import { readJournalTail } from "./journal-read";
import type { NativeSessionRecord } from "./record";
import { readRecord, readToken } from "./record";
import type { ClientRole, WriterAction } from "./writer-ownership";

const encoder = new TextEncoder();

/**
 * The host answered a request with an explicit refusal, carrying its code so callers
 * decide on a typed verdict instead of matching on message text.
 */
export class HostRefusedError extends Error {
	constructor(readonly code: ErrorCode, message?: string) {
		super(`native session error: ${code}${message ? ` (${message})` : ""}`);
		this.name = "HostRefusedError";
	}
}

/**
 * The host never answered in time, so it may STILL commit the request. Ambiguous, not a
 * refusal: the caller must compensate rather than report failure and move on.
 */
export class OwnershipTimeoutError extends Error {
	constructor(readonly action: WriterAction) {
		super(`ownership ${action} timeout`);
		this.name = "OwnershipTimeoutError";
	}
}

interface Pending<T> {
	resolve: (value: T) => void;
	reject: (err: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

/**
 * Which kind of reply a pending control request will accept. Correlation is by
 * (id, kind, connection) — never by id alone: separate id counters per type collided, so
 * a resize conflict carrying id N could settle an unrelated takeover holding id N.
 */
type PendingKind = "status" | "ownership" | "resize";

type PendingReply = StatusReply | OwnershipReply | ResizedReply;

interface PendingRequest {
	kind: PendingKind;
	/** The socket generation this request belongs to; a later socket must not settle it. */
	connection: number;
	settle: (reply: PendingReply) => void;
	reject: (err: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

/** `id: 0` is reserved for unsolicited host events, so it can never match a request. */
export const UNSOLICITED_ID = 0;

export class NativeSessionClient {
	private ws: WebSocket | null = null;
	/** The record this connection was dialled with, for callers that must not re-read it. */
	private connectedWith: NativeSessionRecord | null = null;
	private connectionGeneration = 0;
	/** ONE id space for every control request on this connection. Starts above 0 so an
	 * unsolicited host event (id 0) can never be mistaken for a reply we are awaiting. */
	private nextRequestId = 1;
	private helloId = 0;
	private readonly outputCbs = new Set<(bytes: Uint8Array) => void>();
	private readonly errorCbs: Array<(error: ErrorMessage) => void> = [];
	private readonly disconnectCbs: Array<() => void> = [];
	private readonly roleCbs: Array<(role: ClientRole) => void> = [];
	private readonly geometryCbs: Array<(size: { cols: number; rows: number }) => void> = [];
	/**
	 * The writer's canonical grid, as last CONFIRMED by the host; null until it says.
	 * Only an applied resize, a status reply, or a host geometry event may set this — a
	 * resize we merely SENT can still be refused, and caching it would poison every
	 * viewer with a size the PTY never had.
	 */
	private ptyGeometry: { cols: number; rows: number } | null = null;
	/** Host's monotonic lease-transition counter; null until the host reports one. */
	private writerGeneration: number | null = null;
	private capabilities: readonly HostCapability[] = [];
	/** Late nonzero ownership replies this connection has dropped. */
	private lateOwnershipReplies = 0;
	/**
	 * Pre-listener output, each frame TAGGED with the phase it arrived in. A count of
	 * leading replay frames cannot survive the byte-cap eviction below, which shifts
	 * frames off the front — the count would go stale and a later discard would delete
	 * live output instead.
	 */
	private readonly bufferedOutput: Array<{ bytes: Uint8Array; replay: boolean }> = [];
	private bufferedOutputBytes = 0;
	private replayBoundarySeen = false;
	private readonly pending = new Map<number, PendingRequest>();
	private readonly stopResolvers: Array<() => void> = [];
	private readonly exitPending = new Set<Pending<number | null>>();
	private helloPending: Pending<void> | null = null;
	private currentRole: ClientRole | null = null;
	/** Whether ANY client holds the lease; null until the host has said. */
	private writerAttachedKnown: boolean | null = null;
	private exitObserved = false;
	private exitCode: number | null = null;
	/**
	 * Sticky: once the socket has closed it stays closed for this generation. Without
	 * it, a subscriber that arrives after the close event never learns anything, since
	 * the callback list has already been drained (seq 1407).
	 */
	private disconnected = false;
	private disconnectedResolvers: Array<() => void> = [];

	/**
	 * Drop ONLY the frames the host marked as journal replay, keeping every live byte that
	 * arrived after the boundary. A rebind already holds that history in its own bridge
	 * journal, so replaying it would print the screen twice — but clearing the whole
	 * pre-listener queue would silently eat output produced while the handshake finished.
	 * Returns null when this host announces no boundary, so the caller must keep everything.
	 */
	discardReplayedOutput(): number | null {
		if (!this.supports("replay-boundary")) return null;
		let dropped = 0;
		// Drop by TAG, not by position or count: eviction may already have removed some of
		// the replay, and a stale count would take live frames with it.
		for (let i = this.bufferedOutput.length - 1; i >= 0; i--) {
			if (!this.bufferedOutput[i]!.replay) continue;
			this.bufferedOutputBytes -= this.bufferedOutput[i]!.bytes.byteLength;
			this.bufferedOutput.splice(i, 1);
			dropped++;
		}
		return dropped;
	}

	onOutput(cb: (bytes: Uint8Array) => void): () => void {
		this.outputCbs.add(cb);
		for (const frame of this.bufferedOutput.splice(0)) cb(frame.bytes);
		this.bufferedOutputBytes = 0;
		return () => this.outputCbs.delete(cb);
	}

	/** Invoke external listeners in ISOLATION, after internal state is already settled. */
	private fanOut<T>(callbacks: ReadonlyArray<(value: T) => void>, value: T): void {
		for (const cb of [...callbacks]) {
			try {
				cb(value);
			} catch {
				// One listener's failure must not stop the others or corrupt our own state.
			}
		}
	}

	onError(cb: (error: ErrorMessage) => void): void {
		this.errorCbs.push(cb);
	}

	onDisconnect(cb: () => void): void {
		// An already-closed socket reports immediately, so subscribing late is safe.
		if (this.disconnected) {
			cb();
			return;
		}
		this.disconnectCbs.push(cb);
	}

	/** Resolves when the socket has closed — immediately if it already has. */
	whenDisconnected(): Promise<void> {
		if (this.disconnected) return Promise.resolve();
		return new Promise((resolve) => this.disconnectedResolvers.push(resolve));
	}

	/** The host changed our role without being asked — usually a promotion. */
	onRoleChange(cb: (role: ClientRole) => void): void {
		this.roleCbs.push(cb);
	}

	/**
	 * The WRITER resized the shared PTY. An observer in another app process cannot
	 * learn this any other way — its own process never saw that resize — and without
	 * it it renders the writer's byte stream at its own width.
	 */
	onGeometry(cb: (size: { cols: number; rows: number }) => void): void {
		this.geometryCbs.push(cb);
	}

	/** The writer's canonical grid; null while the host has not reported one. */
	getPtyGeometry(): { cols: number; rows: number } | null {
		return this.ptyGeometry;
	}

	/** How many late/unmatched ownership replies this connection has ignored. */
	getLateOwnershipReplyCount(): number {
		return this.lateOwnershipReplies;
	}

	/** The lease generation the host last reported; null on a host that predates it. */
	getWriterGeneration(): number | null {
		return this.writerGeneration;
	}

	/**
	 * Whether the host ANNOUNCED support for a capability. Absent means an older host,
	 * which callers must treat as unsupported — never infer support from a timeout.
	 */
	supports(capability: HostCapability): boolean {
		return this.capabilities.includes(capability);
	}

	getRole(): ClientRole | null {
		return this.currentRole;
	}

	/** True/false once the host has reported it; null while still unknown. */
	getWriterAttached(): boolean | null {
		return this.writerAttachedKnown;
	}

	async connect(record: NativeSessionRecord, token: string, opts: { timeoutMs?: number } = {}): Promise<void> {
		if (this.ws) throw new Error("already connected");
		const url = `ws://${record.endpoint.address}:${record.endpoint.port}/?token=${encodeURIComponent(token)}`;
		const ws = new WebSocket(url);
		const generation = ++this.connectionGeneration;
		ws.binaryType = "arraybuffer";
		this.ws = ws;
		this.connectedWith = record;
		this.exitObserved = false;
		this.exitCode = null;
		this.replayBoundarySeen = false;
		this.bufferedOutput.length = 0;
		this.bufferedOutputBytes = 0;
		// A reconnect starts a fresh generation, so the sticky flag resets with it.
		this.disconnected = false;
		ws.addEventListener("message", (ev) => this.onMessage(generation, ws, ev));
		ws.addEventListener("close", () => this.onClose(generation, ws));
		const timeoutMs = opts.timeoutMs ?? 5000;
		await new Promise<void>((resolve, reject) => {
			const to = setTimeout(() => reject(new Error("connect timeout")), timeoutMs);
			ws.addEventListener(
				"open",
				() => {
					clearTimeout(to);
					resolve();
				},
				{ once: true },
			);
			ws.addEventListener(
				"error",
				() => {
					clearTimeout(to);
					reject(new Error("websocket error"));
				},
				{ once: true },
			);
		});
		await this.performHello(record.sessionId, timeoutMs);
		// `welcome` carries the role but no SIZE, so without this an attaching observer
		// knows no canonical grid until the writer happens to resize — and it would
		// reflow the writer's byte stream at its own width in the meantime. One status
		// read closes that window and works on every v1 host, including ones predating
		// the resize broadcast. Non-fatal: a failure leaves the grid honestly unknown.
		await this.status({ timeoutMs }).catch(() => undefined);
	}

	private performHello(sessionId: string, timeoutMs: number): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			const ws = this.ws;
			if (!ws) {
				reject(new Error("not connected"));
				return;
			}
			const id = this.nextRequestId++;
			this.helloId = id; // the welcome (or error) is matched against this id in onMessage
			const timer = setTimeout(() => {
				this.helloPending = null;
				reject(new Error("hello timeout"));
			}, timeoutMs);
			this.helloPending = { resolve: () => resolve(), reject, timer };
			// Announce which app process we are: the host grants one writer, and a
			// peer that is only observing needs a pid to route its writes to.
			ws.send(encodeControl(helloMessage(sessionId, id, process.pid)));
		});
	}

	/** Rediscover a session from disk (record + private token) and connect to it. */
	static async discover(sessionId: string, opts: { timeoutMs?: number } = {}): Promise<NativeSessionClient> {
		const record = readRecord(sessionId);
		if (!record) throw new Error(`no native session record for ${sessionId}`);
		const token = readToken(sessionId);
		if (!token) throw new Error(`no native session token for ${sessionId}`);
		const client = new NativeSessionClient();
		await client.connect(record, token, opts);
		return client;
	}

	/**
	 * The record this client actually dialled. A caller that re-read the record would get
	 * a successor's, which would describe a different process than this socket reaches.
	 */
	connectedRecord(): NativeSessionRecord | null {
		return this.connectedWith;
	}

	/** Replay the persisted journal tail for a session (independent per session). */
	static replayJournal(sessionId: string): Uint8Array[] {
		return readJournalTail(sessionId);
	}

	private onClose(generation: number, socket: WebSocket): void {
		if (generation !== this.connectionGeneration) return;
		if (this.ws === socket) this.ws = null;
		this.currentRole = null;
		if (this.helloPending) {
			clearTimeout(this.helloPending.timer);
			const pending = this.helloPending;
			this.helloPending = null;
			pending.reject(new Error("connection closed before welcome"));
		}
		for (const [id, request] of this.pending) {
			clearTimeout(request.timer);
			request.reject(new Error(`connection closed before ${request.kind} reply`));
			this.pending.delete(id);
		}
		for (const r of this.stopResolvers.splice(0)) r();
		// Sticky, and set BEFORE the fan-out, so a callback that subscribes another
		// listener sees the closed state instead of queueing behind a socket that is
		// already gone (seq 1407).
		this.disconnected = true;
		for (const resolve of this.disconnectedResolvers.splice(0)) resolve();
		this.fanOut(this.disconnectCbs.splice(0), undefined as void);
		for (const pending of this.exitPending) {
			clearTimeout(pending.timer);
			pending.reject(new Error("connection closed before shell exit event"));
		}
		this.exitPending.clear();
	}

	private onMessage(generation: number, socket: WebSocket, ev: MessageEvent): void {
		if (generation !== this.connectionGeneration || this.ws !== socket) return;
		const data = ev.data;
		if (typeof data === "string") {
			if (this.helloPending) {
				this.resolveHandshake(data);
				return;
			}
			const msg = decodeControl(data);
			if (!msg) return;
			if (msg.type === "resized") {
				// The ONLY path to a new canonical grid, and it must be OUR resize: an ack we
				// are not awaiting is late, duplicated, or from a replaced socket, and applying
				// it would cache a size for a request whose context is gone.
				const ack = msg as ResizedReply;
				const request = this.takePending(ack.id, "resize");
				if (!request) return;
				this.writerGeneration = ack.writerGeneration;
				this.ptyGeometry = { cols: ack.cols, rows: ack.rows };
				request.settle(ack);
				return;
			}
			if (msg.type === "status") {
				const reply = msg as StatusReply;
				this.ptyGeometry = { cols: reply.cols, rows: reply.rows };
				if (typeof reply.writerGeneration === "number") this.writerGeneration = reply.writerGeneration;
				if (typeof reply.writerAttached === "boolean") this.writerAttachedKnown = reply.writerAttached;
				const pending = reply.id === UNSOLICITED_ID ? null : this.takePending(reply.id, "status");
				if (pending) {
					pending.settle(reply);
				} else if (reply.id === UNSOLICITED_ID) {
					// Only id 0 is an event: the writer resized the canonical grid.
					this.fanOut(this.geometryCbs, { cols: reply.cols, rows: reply.rows });
				}
			} else if (msg.type === "ownership" && "role" in msg) {
				const reply = msg as OwnershipReply;
				// ONLY id 0 is unsolicited. A nonzero reply whose request already timed out
				// must do NOTHING: applying it would flip this process's ownership after the
				// click that asked for it, and its local lease context, are long gone. The
				// caller compensates for that timeout; a late frame is not a second chance.
				const pending = reply.id === UNSOLICITED_ID ? null : this.takePending(reply.id, "ownership");
				if (reply.id !== UNSOLICITED_ID && !pending) {
					this.lateOwnershipReplies++;
					return;
				}
				this.currentRole = reply.role;
				this.writerAttachedKnown = reply.writerAttached;
				if (typeof reply.writerGeneration === "number") this.writerGeneration = reply.writerGeneration;
				if (pending) {
					pending.settle(reply);
				} else {
					// The host moved the lease without being asked (a vacancy or a takeover).
					this.fanOut(this.roleCbs, reply.role);
				}
			} else if (msg.type === "replayed") {
				// Everything buffered so far is history; anything after this is live.
				this.replayBoundarySeen = true;
			} else if (msg.type === "stopping") {
				for (const r of this.stopResolvers.splice(0)) r();
			} else if (msg.type === "error") {
				const error = msg as ErrorMessage;
				// Settle FIRST. A listener that throws — or reconnects — must not be able to
				// leave the request pending, which would turn a clean refusal into a timeout
				// and then into an unnecessary compensation.
				this.rejectPendingByError(error);
				this.fanOut(this.errorCbs, error);
			} else if (msg.type === "exit") {
				this.exitObserved = true;
				this.exitCode = msg.code;
				for (const pending of this.exitPending) {
					clearTimeout(pending.timer);
					pending.resolve(msg.code);
				}
				this.exitPending.clear();
			}
			return;
		}
		let bytes: Uint8Array | null = null;
		if (data instanceof ArrayBuffer) {
			bytes = new Uint8Array(data);
		} else if (ArrayBuffer.isView(data)) {
			bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
		}
		if (!bytes) return;
		if (this.outputCbs.size === 0) {
			const copy = bytes.slice();
			this.bufferedOutput.push({ bytes: copy, replay: !this.replayBoundarySeen });
			this.bufferedOutputBytes += copy.byteLength;
			while (this.bufferedOutput.length > 1 && this.bufferedOutputBytes > DEFAULT_JOURNAL_MAX_BYTES) {
				this.bufferedOutputBytes -= this.bufferedOutput.shift()!.bytes.byteLength;
			}
			return;
		}
		for (const cb of this.outputCbs) cb(bytes);
	}

	private resolveHandshake(text: string): void {
		const pending = this.helloPending;
		if (!pending) return;
		const welcome = decodeControl(text);
		if (welcome && welcome.type === "welcome" && welcome.id === this.helloId) {
			clearTimeout(pending.timer);
			this.helloPending = null;
			this.currentRole = welcome.role ?? "writer";
			this.capabilities = Array.isArray(welcome.capabilities) ? welcome.capabilities : [];
			if (typeof welcome.writerGeneration === "number") this.writerGeneration = welcome.writerGeneration;
			pending.resolve();
			return;
		}
		const err = decodeError(text); // version-agnostic: readable even to a mismatched client
		if (err) {
			clearTimeout(pending.timer);
			this.helloPending = null;
			pending.reject(new Error(`native session refused hello: ${err.code}${err.message ? ` (${err.message})` : ""}`));
		}
	}

	private rejectPendingByError(err: ErrorMessage): void {
		// An error may answer ANY kind, but the shared id space means at most one request
		// is registered at that id, so there is nothing to guess between.
		if (err.id === undefined || err.id === UNSOLICITED_ID) return;
		const request = this.takePending(err.id);
		if (!request) return;
		request.reject(new HostRefusedError(err.code, err.message));
	}

	/**
	 * Claim the pending request at `id` when it matches `kind` and this connection.
	 * A mismatch is left in place and the caller ignores the frame — settling the wrong
	 * kind, or a request belonging to a socket we have already replaced, is how a late
	 * or unrelated reply silently commits work nobody is waiting for.
	 */
	private takePending(id: number, kind?: PendingKind): PendingRequest | null {
		const request = this.pending.get(id);
		if (!request) return null;
		if (kind !== undefined && request.kind !== kind) return null;
		if (request.connection !== this.connectionGeneration) return null;
		clearTimeout(request.timer);
		this.pending.delete(id);
		return request;
	}

	/**
	 * Send one correlated control request and await its exact reply. The single place
	 * that allocates an id, tags the kind and connection, and arms the timeout.
	 */
	private request<T>(
		kind: PendingKind,
		build: (id: number) => string,
		opts: { timeoutMs?: number } = {},
	): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			const ws = this.ws;
			if (!ws) {
				reject(new Error("not connected"));
				return;
			}
			const id = this.nextRequestId++;
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`${kind} timeout`));
			}, opts.timeoutMs ?? 3000);
			this.pending.set(id, {
				kind,
				connection: this.connectionGeneration,
				settle: (reply) => resolve(reply as T),
				reject,
				timer,
			});
			ws.send(build(id));
		});
	}

	/** Keystrokes go as a BINARY frame (host reads binary as PTY input, text as JSON control). */
	input(data: string | Uint8Array): void {
		if (!this.ws) throw new Error("not connected");
		if (typeof data === "string") {
			this.ws.send(encoder.encode(data));
			return;
		}
		this.ws.send(data as Uint8Array<ArrayBuffer>);
	}

	/**
	 * Resize the shared PTY, resolving only on the host's acknowledgement — never
	 * optimistically, since a stale client's resize is refused. `expectedGeneration` is
	 * what lets the host refuse it.
	 */
	resizeAwaited(cols: number, rows: number, opts: { timeoutMs?: number } = {}): Promise<ResizedReply> {
		if (!this.supports("resize-ack")) {
			// An older host cannot acknowledge; send it and report honestly that we do not
			// know the outcome, rather than inventing a confirmation.
			this.ws?.send(encodeControl(resizeMessage(cols, rows)));
			return Promise.reject(new Error("host does not support resize-ack"));
		}
		return this.request<ResizedReply>(
			"resize",
			(id) => encodeControl(resizeMessage(cols, rows, {
				id,
				...(this.writerGeneration !== null ? { expectedGeneration: this.writerGeneration } : {}),
			})),
			opts,
		);
	}

	/** Fire-and-forget form: the ack still drives the cache; failures are swallowed. */
	resize(cols: number, rows: number): void {
		if (!this.ws) return;
		void this.resizeAwaited(cols, rows).catch(() => undefined);
	}

	status(opts: { timeoutMs?: number } = {}): Promise<StatusReply> {
		return this.request<StatusReply>("status", (id) => encodeControl(statusRequest(id)), opts);
	}

	private requestOwnership(action: WriterAction, opts: { timeoutMs?: number } = {}): Promise<OwnershipReply> {
		return new Promise<OwnershipReply>((resolve, reject) => {
			const ws = this.ws;
			if (!ws) {
				reject(new Error("not connected"));
				return;
			}
			const id = this.nextRequestId++;
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new OwnershipTimeoutError(action));
			}, opts.timeoutMs ?? 3000);
			this.pending.set(id, {
				kind: "ownership",
				connection: this.connectionGeneration,
				settle: (reply) => resolve(reply as OwnershipReply),
				reject,
				timer,
			});
			ws.send(encodeControl(ownershipRequest(id, action)));
		});
	}

	claimWriter(opts: { timeoutMs?: number } = {}): Promise<OwnershipReply> {
		return this.requestOwnership("claim", opts);
	}

	releaseWriter(opts: { timeoutMs?: number } = {}): Promise<OwnershipReply> {
		return this.requestOwnership("release", opts);
	}

	/**
	 * Displace whoever currently holds the lease. This is the explicit user gesture
	 * only — never an attach-time fallback, or attaching would steal the lease from
	 * whoever is typing.
	 */
	takeoverWriter(opts: { timeoutMs?: number } = {}): Promise<OwnershipReply> {
		return this.requestOwnership("takeover", opts);
	}

	requestStop(opts: { timeoutMs?: number } = {}): Promise<void> {
		return new Promise((resolve) => {
			if (!this.ws) {
				resolve();
				return;
			}
			const to = setTimeout(() => resolve(), opts.timeoutMs ?? 3000);
			this.stopResolvers.push(() => {
				clearTimeout(to);
				resolve();
			});
			this.ws.send(encodeControl(stopRequest()));
		});
	}

	waitForTextOutput<T>(
		observe: (output: string) => T | undefined,
		opts: { timeoutMs?: number; description?: string } = {},
	): Promise<T> {
		return new Promise((resolve, reject) => {
			let output = "";
			const decoder = new TextDecoder();
			let timer: ReturnType<typeof setTimeout> | undefined;
			let unsubscribe = (): void => {};
			const cleanup = (): void => {
				if (timer) clearTimeout(timer);
				unsubscribe();
			};
			unsubscribe = this.onOutput((bytes) => {
				output += decoder.decode(bytes, { stream: true });
				try {
					const observed = observe(output);
					if (observed === undefined) return;
					cleanup();
					resolve(observed);
				} catch (error) {
					cleanup();
					reject(error);
				}
			});
			timer = setTimeout(() => {
				cleanup();
				reject(new Error(`output deadline exceeded${opts.description ? ` waiting for ${opts.description}` : ""}`));
			}, opts.timeoutMs ?? 5000);
		});
	}

	waitForExit(opts: { timeoutMs?: number } = {}): Promise<number | null> {
		if (this.exitObserved) return Promise.resolve(this.exitCode);
		return new Promise((resolve, reject) => {
			const pending: Pending<number | null> = {
				resolve,
				reject,
				timer: setTimeout(() => {
					this.exitPending.delete(pending);
					reject(new Error("shell exit timeout"));
				}, opts.timeoutMs ?? 5000),
			};
			this.exitPending.add(pending);
		});
	}

	/** Finish detaching this client before a fresh process reconnects. */
	disconnect(opts: { timeoutMs?: number } = {}): Promise<void> {
		const socket = this.ws;
		if (!socket) return Promise.resolve();
		this.ws = null;
		this.currentRole = null;
		return new Promise((resolve, reject) => {
			let timer: ReturnType<typeof setTimeout>;
			const onClose = (): void => {
				clearTimeout(timer);
				resolve();
			};
			timer = setTimeout(() => {
				socket.removeEventListener("close", onClose);
				reject(new Error("websocket close timeout"));
			}, opts.timeoutMs ?? 3000);
			socket.addEventListener("close", onClose, { once: true });
			try {
				socket.close();
			} catch (error) {
				clearTimeout(timer);
				socket.removeEventListener("close", onClose);
				reject(error);
			}
		});
	}

	/** Disconnect this client only — the host + shell keep running. */
	close(): void {
		const socket = this.ws;
		this.ws = null;
		try {
			socket?.close();
		} catch {
			// already closed
		}
		this.currentRole = null;
	}
}
