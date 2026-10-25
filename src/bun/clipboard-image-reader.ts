import { suffix } from "bun:ffi";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { Utils } from "./electrobun-platform";
import { createLogger } from "./logger";

const log = createLogger("clipboard");

export interface ClipboardImageJob {
	libraryPath: string;
}

export type ClipboardImageReply =
	| { ok: true; formats: string[]; image: Uint8Array | null }
	| { ok: false; error: string };

export interface HostClipboardImage {
	formats: string[];
	/** Raw bytes as the platform hands them over; null when there is no image or it could not be read. */
	image: Uint8Array | null;
}

export const CLIPBOARD_READ_TIMEOUT_MS = 10_000;

let workerPath: string | null = null;
let warnedMissingWorker = false;
/** The read holding the single-flight slot; only that read's worker may release it. */
let activeRead: object | null = null;

/**
 * Point Linux clipboard reads at the bundled worker. Electrobun's GTK clipboard calls are
 * synchronous, and a clipboard owner that advertises an image but never sends it froze the
 * whole host for ~125 s, so on Linux there is no host-thread fallback. See decisions/2026/10/25/linux-webkitgtk-paste-reads-host-clipboard.md.
 */
export function configureClipboardImageWorker(path: string | null): void {
	workerPath = path;
	warnedMissingWorker = false;
}

/** The library Electrobun itself loads (`proc/native.ts` resolves it against the cwd the same way). */
function nativeLibraryPath(): string {
	return join(process.cwd(), `libNativeWrapper.${suffix}`);
}

function readInline(): HostClipboardImage {
	const formats = Utils.clipboardAvailableFormats();
	return { formats, image: formats.includes("image") ? Utils.clipboardReadImage() : null };
}

/**
 * One read at a time, and the slot stays taken until the FFI call has actually returned
 * (a reply, or the thread dying), not merely until the deadline: a worker wedged inside GTK
 * cannot be interrupted, and a second one would only queue behind it on the GTK main
 * thread. A reply that arrives after the deadline is dropped unread.
 */
function readInWorker(path: string, timeoutMs: number): Promise<HostClipboardImage> {
	if (activeRead) return Promise.reject(new Error("A clipboard read is still in progress"));
	return new Promise((resolve, reject) => {
		let worker: Worker;
		try {
			worker = new Worker(path, { workerData: { libraryPath: nativeLibraryPath() } satisfies ClipboardImageJob });
		} catch (error) {
			reject(new Error(`Clipboard worker did not start: ${String(error)}`));
			return;
		}
		const read = {};
		activeRead = read;
		const release = () => {
			if (activeRead === read) activeRead = null;
		};
		// A thread wedged in GTK must not keep the app from quitting.
		worker.unref();
		let settled = false;
		const settle = (done: () => void) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			done();
		};
		const timer = setTimeout(() => {
			log.warn("Clipboard read timed out; the worker stays reserved until GTK returns", { timeoutMs });
			settle(() => reject(new Error("Reading the clipboard timed out")));
		}, timeoutMs);
		worker.on("message", (reply: ClipboardImageReply) => {
			release();
			if (settled) log.info("Discarded a clipboard reply that arrived after the deadline");
			settle(() => (reply.ok ? resolve({ formats: reply.formats, image: reply.image }) : reject(new Error(reply.error))));
		});
		worker.on("error", (error) => {
			release();
			settle(() => reject(new Error(`Clipboard worker failed: ${String(error)}`)));
		});
		worker.on("exit", (code) => {
			release();
			worker.removeAllListeners();
			settle(() => reject(new Error(`Clipboard worker exited with code ${code}`)));
		});
	});
}

/**
 * Linux reads only ever go through the worker: without it, a stalled clipboard owner would
 * freeze the host again, so a missing or unconfigured bundle fails the paste instead.
 * Other platforms keep the direct call.
 */
export async function readHostClipboardImage(timeoutMs = CLIPBOARD_READ_TIMEOUT_MS): Promise<HostClipboardImage> {
	if (process.platform !== "linux") return readInline();
	const path = workerPath;
	if (path && existsSync(path)) return readInWorker(path, timeoutMs);
	if (!warnedMissingWorker) {
		warnedMissingWorker = true;
		log.warn("Clipboard worker missing; refusing to read the clipboard on the host thread", { path });
	}
	throw new Error("The clipboard image reader is missing from this build");
}
