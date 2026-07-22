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
	statusRequest,
	stopRequest,
	type ErrorMessage,
	type OwnershipReply,
	type StatusReply,
} from "./protocol";
import { DEFAULT_JOURNAL_MAX_BYTES } from "./journal";
import { readJournalTail } from "./journal-read";
import type { NativeSessionRecord } from "./record";
import { readRecord, readToken } from "./record";
import type { ClientRole, WriterAction } from "./writer-ownership";

const encoder = new TextEncoder();

interface Pending<T> {
	resolve: (value: T) => void;
	reject: (err: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

export class NativeSessionClient {
	private ws: WebSocket | null = null;
	private connectionGeneration = 0;
	private nextId = 1;
	private helloId = 0;
	private readonly outputCbs = new Set<(bytes: Uint8Array) => void>();
	private readonly errorCbs: Array<(error: ErrorMessage) => void> = [];
	private readonly disconnectCbs: Array<() => void> = [];
	private readonly bufferedOutput: Uint8Array[] = [];
	private bufferedOutputBytes = 0;
	private readonly statusPending = new Map<number, Pending<StatusReply>>();
	private readonly ownershipPending = new Map<number, Pending<OwnershipReply>>();
	private readonly stopResolvers: Array<() => void> = [];
	private readonly exitPending = new Set<Pending<number | null>>();
	private helloPending: Pending<void> | null = null;
	private currentRole: ClientRole | null = null;
	private exitObserved = false;
	private exitCode: number | null = null;

	onOutput(cb: (bytes: Uint8Array) => void): () => void {
		this.outputCbs.add(cb);
		for (const bytes of this.bufferedOutput.splice(0)) cb(bytes);
		this.bufferedOutputBytes = 0;
		return () => this.outputCbs.delete(cb);
	}

	onError(cb: (error: ErrorMessage) => void): void {
		this.errorCbs.push(cb);
	}

	onDisconnect(cb: () => void): void {
		this.disconnectCbs.push(cb);
	}

	getRole(): ClientRole | null {
		return this.currentRole;
	}

	async connect(record: NativeSessionRecord, token: string, opts: { timeoutMs?: number } = {}): Promise<void> {
		if (this.ws) throw new Error("already connected");
		const url = `ws://${record.endpoint.address}:${record.endpoint.port}/?token=${encodeURIComponent(token)}`;
		const ws = new WebSocket(url);
		const generation = ++this.connectionGeneration;
		ws.binaryType = "arraybuffer";
		this.ws = ws;
		this.exitObserved = false;
		this.exitCode = null;
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
	}

	private performHello(sessionId: string, timeoutMs: number): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			const ws = this.ws;
			if (!ws) {
				reject(new Error("not connected"));
				return;
			}
			const id = this.nextId++;
			this.helloId = id; // the welcome (or error) is matched against this id in onMessage
			const timer = setTimeout(() => {
				this.helloPending = null;
				reject(new Error("hello timeout"));
			}, timeoutMs);
			this.helloPending = { resolve: () => resolve(), reject, timer };
			ws.send(encodeControl(helloMessage(sessionId, id)));
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
		for (const [id, pending] of this.statusPending) {
			clearTimeout(pending.timer);
			pending.reject(new Error("connection closed before status reply"));
			this.statusPending.delete(id);
		}
		for (const [id, pending] of this.ownershipPending) {
			clearTimeout(pending.timer);
			pending.reject(new Error("connection closed before ownership reply"));
			this.ownershipPending.delete(id);
		}
		for (const r of this.stopResolvers.splice(0)) r();
		for (const cb of this.disconnectCbs.splice(0)) cb();
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
			if (msg.type === "status") {
				const reply = msg as StatusReply;
				const pending = this.statusPending.get(reply.id);
				if (pending) {
					clearTimeout(pending.timer);
					this.statusPending.delete(reply.id);
					pending.resolve(reply);
				}
			} else if (msg.type === "ownership" && "role" in msg) {
				const reply = msg as OwnershipReply;
				const pending = this.ownershipPending.get(reply.id);
				if (pending) {
					clearTimeout(pending.timer);
					this.ownershipPending.delete(reply.id);
					this.currentRole = reply.role;
					pending.resolve(reply);
				}
			} else if (msg.type === "stopping") {
				for (const r of this.stopResolvers.splice(0)) r();
			} else if (msg.type === "error") {
				const error = msg as ErrorMessage;
				for (const cb of this.errorCbs) cb(error);
				this.rejectPendingByError(error);
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
			this.bufferedOutput.push(copy);
			this.bufferedOutputBytes += copy.byteLength;
			while (this.bufferedOutput.length > 1 && this.bufferedOutputBytes > DEFAULT_JOURNAL_MAX_BYTES) {
				this.bufferedOutputBytes -= this.bufferedOutput.shift()!.byteLength;
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
		if (err.id === undefined) return;
		const pending = this.statusPending.get(err.id) ?? this.ownershipPending.get(err.id);
		if (!pending) return;
		clearTimeout(pending.timer);
		this.statusPending.delete(err.id);
		this.ownershipPending.delete(err.id);
		pending.reject(new Error(`native session error: ${err.code}${err.message ? ` (${err.message})` : ""}`));
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

	resize(cols: number, rows: number): void {
		this.ws?.send(encodeControl(resizeMessage(cols, rows)));
	}

	status(opts: { timeoutMs?: number } = {}): Promise<StatusReply> {
		return new Promise((resolve, reject) => {
			if (!this.ws) {
				reject(new Error("not connected"));
				return;
			}
			const id = this.nextId++;
			const timer = setTimeout(() => {
				this.statusPending.delete(id);
				reject(new Error("status timeout"));
			}, opts.timeoutMs ?? 3000);
			this.statusPending.set(id, { resolve, reject, timer });
			this.ws.send(encodeControl(statusRequest(id)));
		});
	}

	private requestOwnership(action: WriterAction, opts: { timeoutMs?: number } = {}): Promise<OwnershipReply> {
		return new Promise((resolve, reject) => {
			if (!this.ws) {
				reject(new Error("not connected"));
				return;
			}
			const id = this.nextId++;
			const timer = setTimeout(() => {
				this.ownershipPending.delete(id);
				reject(new Error(`ownership ${action} timeout`));
			}, opts.timeoutMs ?? 3000);
			this.ownershipPending.set(id, { resolve, reject, timer });
			this.ws.send(encodeControl(ownershipRequest(id, action)));
		});
	}

	claimWriter(opts: { timeoutMs?: number } = {}): Promise<OwnershipReply> {
		return this.requestOwnership("claim", opts);
	}

	releaseWriter(opts: { timeoutMs?: number } = {}): Promise<OwnershipReply> {
		return this.requestOwnership("release", opts);
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
