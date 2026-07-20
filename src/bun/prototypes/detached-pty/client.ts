/**
 * Detached-PTY prototype CLIENT (spike — see ./README.md).
 *
 * A short-lived attach handle over the host's loopback-TCP WebSocket. Any number
 * of these come and go while the host + shell stay alive. `discover()` finds a
 * running host purely from the on-disk metadata — modelling a brand-new,
 * unrelated process reconnecting to the same live shell.
 */

import { encodeControl, decodeControl, resizeMessage, statusRequest, stopRequest, type StatusReply } from "./protocol";
import { readState, type PtyProtoState } from "./state";

const encoder = new TextEncoder();

export class PtyProtoClient {
	private ws: WebSocket | null = null;
	private readonly outputCbs: Array<(bytes: Uint8Array) => void> = [];
	private readonly statusResolvers: Array<(s: StatusReply) => void> = [];
	private readonly stopResolvers: Array<() => void> = [];

	/** Register a raw PTY-output sink. */
	onOutput(cb: (bytes: Uint8Array) => void): void {
		this.outputCbs.push(cb);
	}

	async connect(state: PtyProtoState, opts: { timeoutMs?: number } = {}): Promise<void> {
		const url = `ws://${state.host}:${state.port}/?token=${encodeURIComponent(state.token)}`;
		const ws = new WebSocket(url);
		ws.binaryType = "arraybuffer";
		this.ws = ws;
		ws.addEventListener("message", (ev) => this.onMessage(ev));
		ws.addEventListener("close", () => {
			for (const r of this.stopResolvers.splice(0)) r();
		});
		await new Promise<void>((resolve, reject) => {
			const to = setTimeout(() => reject(new Error("connect timeout")), opts.timeoutMs ?? 5000);
			ws.addEventListener("open", () => {
				clearTimeout(to);
				resolve();
			}, { once: true });
			ws.addEventListener("error", () => {
				clearTimeout(to);
				reject(new Error("websocket error"));
			}, { once: true });
		});
	}

	/** Read the on-disk metadata and connect — a fresh-process rediscovery. */
	static async discover(opts: { timeoutMs?: number } = {}): Promise<PtyProtoClient> {
		const state = readState();
		if (!state) throw new Error("no detached-pty host metadata found");
		const client = new PtyProtoClient();
		await client.connect(state, opts);
		return client;
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

	/** Send keystrokes to the shell as a BINARY frame (the host reads binary as
	 *  PTY input and text as JSON control, so input must never be a text frame). */
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

	/** Ask the host to terminate itself; resolves on the `stopping` ack or socket close. */
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

	/** Disconnect this client only — the host and shell keep running. */
	close(): void {
		try {
			this.ws?.close();
		} catch {
			// already closed
		}
		this.ws = null;
	}
}
