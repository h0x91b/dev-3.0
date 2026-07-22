/**
 * Attach CLIENT for the native-session registry (seq 1214).
 *
 * A short-lived handle over one session host's loopback-TCP WebSocket. Any
 * number of these come and go while the host + shell stay alive. `discover()`
 * reconnects a brand-new, unrelated process from the on-disk record + private
 * token alone — modelling a fresh client reattaching to a live session.
 */

import {
	decodeControl,
	encodeControl,
	resizeMessage,
	statusRequest,
	stopRequest,
	type StatusReply,
} from "./protocol";
import { readJournalTail } from "./journal-read";
import type { NativeSessionRecord } from "./record";
import { readRecord, readToken } from "./record";

const encoder = new TextEncoder();

export class NativeSessionClient {
	private ws: WebSocket | null = null;
	private readonly outputCbs: Array<(bytes: Uint8Array) => void> = [];
	private readonly statusResolvers: Array<(s: StatusReply) => void> = [];
	private readonly stopResolvers: Array<() => void> = [];

	onOutput(cb: (bytes: Uint8Array) => void): void {
		this.outputCbs.push(cb);
	}

	async connect(record: NativeSessionRecord, token: string, opts: { timeoutMs?: number } = {}): Promise<void> {
		const url = `ws://${record.endpoint.address}:${record.endpoint.port}/?token=${encodeURIComponent(token)}`;
		const ws = new WebSocket(url);
		ws.binaryType = "arraybuffer";
		this.ws = ws;
		ws.addEventListener("message", (ev) => this.onMessage(ev));
		ws.addEventListener("close", () => {
			for (const r of this.stopResolvers.splice(0)) r();
		});
		await new Promise<void>((resolve, reject) => {
			const to = setTimeout(() => reject(new Error("connect timeout")), opts.timeoutMs ?? 5000);
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

	private onMessage(ev: MessageEvent): void {
		const data = ev.data;
		if (typeof data === "string") {
			const msg = decodeControl(data);
			if (!msg) return;
			if (msg.type === "status") {
				for (const r of this.statusResolvers.splice(0)) r(msg as StatusReply);
			} else if (msg.type === "stopping") {
				for (const r of this.stopResolvers.splice(0)) r();
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
		for (const cb of this.outputCbs) cb(bytes);
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
			const to = setTimeout(() => reject(new Error("status timeout")), opts.timeoutMs ?? 3000);
			this.statusResolvers.push((s) => {
				clearTimeout(to);
				resolve(s);
			});
			this.ws.send(encodeControl(statusRequest()));
		});
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

	/** Disconnect this client only — the host + shell keep running. */
	close(): void {
		try {
			this.ws?.close();
		} catch {
			// already closed
		}
		this.ws = null;
	}
}
