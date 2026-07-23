/**
 * Orchestration for the staged-host version-skew proof (seq 1248).
 *
 * Stages two immutable host images (v1, v2), launches a detached host from a
 * chosen image, and offers a versioned lab client that speaks an arbitrary
 * protocol version so the proof can drive the real hello/version boundary. Bun
 * runtime only — used by lifecycle.bun-e2e.ts, never imported by a vitest test.
 */

import { spawn as spawnChild } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { decodeError, type ErrorMessage } from "../protocol";
import { readStagedImage, stageHostImage } from "./staging";
import type { StagedHostImageManifest } from "./image-manifest";
import { readHostSessionRecord, readHostSessionToken, type HostSessionRecord } from "./session-record";
import { versionedHello } from "./version-skew";

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const sessionLogFile = (stateDir: string): string => join(stateDir, "host.log");

export const STANDARD_IMAGES = {
	v1: { tag: "host-v1", protocolVersion: 1 },
	v2: { tag: "host-v2", protocolVersion: 2 },
} as const;

/** Stage the two standard immutable images used by the proof. */
export function stageStandardImages(root: string, stagedAt: string): { v1: StagedHostImageManifest; v2: StagedHostImageManifest } {
	return {
		v1: stageHostImage(root, { tag: STANDARD_IMAGES.v1.tag, protocolVersion: STANDARD_IMAGES.v1.protocolVersion, stagedAt }),
		v2: stageHostImage(root, { tag: STANDARD_IMAGES.v2.tag, protocolVersion: STANDARD_IMAGES.v2.protocolVersion, stagedAt }),
	};
}

export interface LaunchStagedHostOptions {
	root: string;
	tag: string;
	protocolVersion: number;
	sessionId: string;
	stateDir: string;
	marker: string;
	timeoutMs?: number;
}

export interface LaunchedHost {
	childPid: number;
	record: HostSessionRecord;
	token: string;
}

/** Launch a detached host from the staged image `tag`; resolve once it reports readiness. */
export async function launchStagedHost(opts: LaunchStagedHostOptions): Promise<LaunchedHost> {
	const image = readStagedImage(opts.root, opts.tag);
	if (image.status !== "ok") {
		throw new Error(`cannot launch staged image ${opts.tag}: ${image.status} (${"reason" in image ? image.reason : ""})`);
	}
	mkdirSync(opts.stateDir, { recursive: true, mode: 0o700 });
	const logFd = openSync(sessionLogFile(opts.stateDir), "a");
	const child = spawnChild(process.execPath, [image.entrypointPath], {
		stdio: ["ignore", logFd, logFd],
		detached: true,
		env: {
			...process.env,
			DEV3_HIMG_ROOT: opts.root,
			DEV3_HIMG_SESSION_ID: opts.sessionId,
			DEV3_HIMG_STATE_DIR: opts.stateDir,
			DEV3_HIMG_MARKER: opts.marker,
		},
	});
	let exited = false;
	let earlyError: string | null = null;
	child.on("error", (err) => {
		exited = true;
		earlyError = err.message;
	});
	child.on("exit", () => {
		exited = true;
	});
	child.unref();

	const deadline = Date.now() + (opts.timeoutMs ?? 15_000);
	try {
		while (Date.now() < deadline) {
			if (exited) {
				const tail = safeReadTail(sessionLogFile(opts.stateDir));
				throw new Error(`staged host ${opts.tag} exited during startup${earlyError ? `: ${earlyError}` : ""}${tail ? `\n${tail}` : ""}`);
			}
			const record = readHostSessionRecord(opts.stateDir);
			if (record && record.hostPid === child.pid && record.shellPid > 0 && record.endpoint.port > 0) {
				const token = readHostSessionToken(opts.stateDir);
				if (token) return { childPid: child.pid ?? -1, record, token };
			}
			await delay(80);
		}
	} finally {
		try {
			closeSync(logFd);
		} catch {
			// already closed
		}
	}
	throw new Error(`staged host ${opts.tag} did not report readiness in time\n${safeReadTail(sessionLogFile(opts.stateDir))}`);
}

function safeReadTail(path: string, maxLength = 3000): string {
	try {
		return readFileSync(path, "utf8").trim().slice(-maxLength);
	} catch {
		return "";
	}
}

export type AttachOutcome =
	| { status: "welcomed"; negotiatedProtocolVersion: number; welcomeId: number }
	| { status: "rejected"; error: ErrorMessage }
	| { status: "closed" }
	| { status: "no-endpoint" };

/**
 * A short-lived client that speaks `clientProtocolVersion`. It opens the raw
 * loopback socket, sends a version-stamped hello, and reports whether the host
 * welcomed it or answered a version-agnostic error. Models both the compatible
 * client and the incompatible "new" client an app update would ship.
 */
export class VersionedLabClient {
	private ws: WebSocket | null = null;
	private buffer = "";
	private readonly decoder = new TextDecoder();
	private nextId = 1;
	private helloId = 0;
	private welcomed = false;

	constructor(private readonly clientProtocolVersion: number) {}

	attach(record: HostSessionRecord, token: string, opts: { timeoutMs?: number } = {}): Promise<AttachOutcome> {
		if (record.endpoint.port <= 0) return Promise.resolve({ status: "no-endpoint" });
		const url = `ws://${record.endpoint.address}:${record.endpoint.port}/?token=${encodeURIComponent(token)}`;
		const ws = new WebSocket(url);
		ws.binaryType = "arraybuffer";
		this.ws = ws;
		return new Promise<AttachOutcome>((resolve) => {
			let settled = false;
			const finish = (outcome: AttachOutcome): void => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				resolve(outcome);
			};
			const timer = setTimeout(() => finish({ status: "closed" }), opts.timeoutMs ?? 4000);
			ws.addEventListener("open", () => {
				this.helloId = this.nextId++;
				ws.send(versionedHello(this.clientProtocolVersion, record.sessionId, this.helloId));
			});
			ws.addEventListener("message", (ev) => {
				if (typeof ev.data === "string") {
					if (!this.welcomed) {
						const outcome = this.classifyFirstReply(ev.data);
						if (outcome.status === "welcomed") this.welcomed = true;
						finish(outcome);
						return;
					}
					return;
				}
				this.absorbBinary(ev.data);
			});
			ws.addEventListener("close", () => finish({ status: "closed" }));
			ws.addEventListener("error", () => finish({ status: "closed" }));
		});
	}

	private classifyFirstReply(text: string): AttachOutcome {
		try {
			const obj = JSON.parse(text) as Record<string, unknown>;
			if (obj.type === "welcome" && obj.id === this.helloId) {
				const negotiated = typeof obj.protocolVersion === "number" ? obj.protocolVersion : this.clientProtocolVersion;
				return { status: "welcomed", negotiatedProtocolVersion: negotiated, welcomeId: this.helloId };
			}
		} catch {
			// fall through to error decode
		}
		const error = decodeError(text); // version-agnostic: a mismatched client still reads the rejection
		if (error) return { status: "rejected", error };
		return { status: "closed" };
	}

	private absorbBinary(data: unknown): void {
		let bytes: Uint8Array | null = null;
		if (data instanceof ArrayBuffer) bytes = new Uint8Array(data);
		else if (ArrayBuffer.isView(data)) bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
		if (bytes) this.buffer += this.decoder.decode(bytes, { stream: true });
	}

	input(data: string): void {
		this.ws?.send(new TextEncoder().encode(data));
	}

	status(opts: { timeoutMs?: number } = {}): Promise<Record<string, unknown>> {
		const ws = this.ws;
		if (!ws) return Promise.reject(new Error("not connected"));
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("status timeout")), opts.timeoutMs ?? 3000);
			const onMessage = (ev: MessageEvent): void => {
				if (typeof ev.data !== "string") return;
				try {
					const obj = JSON.parse(ev.data) as Record<string, unknown>;
					if (obj.type === "status" && obj.id === id) {
						clearTimeout(timer);
						ws.removeEventListener("message", onMessage);
						resolve(obj);
					}
				} catch {
					// ignore non-JSON
				}
			};
			ws.addEventListener("message", onMessage);
			ws.send(JSON.stringify({ v: this.clientProtocolVersion, type: "status", id }));
		});
	}

	async waitForText(needle: string, opts: { timeoutMs?: number } = {}): Promise<boolean> {
		const deadline = Date.now() + (opts.timeoutMs ?? 5000);
		while (Date.now() < deadline) {
			if (this.buffer.includes(needle)) return true;
			await delay(30);
		}
		return false;
	}

	text(): string {
		return this.buffer;
	}

	close(): void {
		try {
			this.ws?.close();
		} catch {
			// already closed
		}
		this.ws = null;
	}
}
