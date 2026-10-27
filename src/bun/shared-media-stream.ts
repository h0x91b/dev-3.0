import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { open } from "node:fs/promises";
import { SHARED_MEDIA_EXTS } from "../shared/types";
import { isFullyQualifiedPath } from "../shared/absolute-path";
import { DEV3_HOME } from "./paths";
import { imageExt, sharedMediaMime } from "./shared-images";

/**
 * HTTP streaming for `dev3 show-media` clips. A clip can be hundreds of MB, so
 * the viewer never reads it over RPC: it gets a capability URL and the `<video>`
 * or `<audio>` element pulls byte ranges on demand. Desktop serves it from the loopback-only
 * PTY server, remote mode from the session-authenticated remote server.
 */

export const SHARED_MEDIA_ROUTE = "/shared-media/";

const READ_CHUNK = 1024 * 1024;
/** Most bytes one 206 carries; the player asks again for the rest, as it does when seeking. */
export const MAX_RANGE_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_TOKENS = 256;

const pathByToken = new Map<string, string>();
const tokenByPath = new Map<string, string>();

/** Only a clip `dev3 show-media` stored — never an arbitrary file the renderer names. */
export function isStoredSharedMediaPath(path: string): boolean {
	if (!isFullyQualifiedPath(path, process.platform)) return false;
	const normalized = path.replaceAll("\\", "/");
	const root = `${DEV3_HOME.replaceAll("\\", "/")}/worktrees/`;
	if (!normalized.startsWith(root)) return false;
	const parts = normalized.slice(root.length).split("/");
	return parts.length === 3 && parts[1] === "shared-images" && SHARED_MEDIA_EXTS.includes(imageExt(normalized));
}

/** The URL path (`/shared-media/<token>`) that streams `storedPath`, or null when it is not a stored clip. */
export function sharedMediaUrlPath(storedPath: string): string | null {
	if (!isStoredSharedMediaPath(storedPath) || !existsSync(storedPath)) return null;
	let token = tokenByPath.get(storedPath);
	if (!token) {
		token = randomBytes(24).toString("base64url");
		pathByToken.set(token, storedPath);
		tokenByPath.set(storedPath, token);
		if (pathByToken.size > MAX_TOKENS) {
			const [oldToken, oldPath] = pathByToken.entries().next().value as [string, string];
			pathByToken.delete(oldToken);
			tokenByPath.delete(oldPath);
		}
	}
	return `${SHARED_MEDIA_ROUTE}${token}`;
}

type ByteRange = { start: number; end: number };

/** `bytes=a-b` / `bytes=a-` / `bytes=-n` → inclusive range; "invalid" when unsatisfiable; null when absent or multi-range. */
export function parseByteRange(header: string | null, size: number): ByteRange | "invalid" | null {
	if (!header) return null;
	const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
	if (!match) return null;
	const [, a, b] = match;
	if (a === "" && b === "") return "invalid";
	let start: number;
	let end: number;
	if (a === "") {
		const suffix = Number(b);
		if (suffix === 0) return "invalid";
		start = Math.max(0, size - suffix);
		end = size - 1;
	} else {
		start = Number(a);
		end = b === "" ? size - 1 : Math.min(Number(b), size - 1);
	}
	if (start >= size || end < start) return "invalid";
	return { start, end };
}

type FileHandle = Awaited<ReturnType<typeof open>>;

/**
 * Reads one chunk per pull, so a 300 MB clip never sits in memory, and owns
 * `handle`. A stream body also keeps Bun off its sendfile path, which drops the
 * response headers on macOS LAN sockets
 * (decisions/2026/07/07/remote-static-sendfile-lan-headerless.md).
 *
 * Closing a Bun FileHandle while a read is in flight never frees the OS
 * descriptor, so a client that aborts mid-stream would leak one: cancel only
 * marks the stream, and the handle closes once the pending read settles.
 * `onDone` fires exactly once, when the stream ends, errors or is cancelled.
 */
function fileRangeStream(handle: FileHandle, start: number, end: number, onDone?: () => void, signal?: AbortSignal): ReadableStream<Uint8Array> {
	let current: FileHandle | null = handle;
	let reading: Promise<unknown> | null = null;
	let cancelled = false;
	let position = start;
	const close = async () => {
		const h = current;
		current = null;
		if (!h) return;
		await h.close().catch(() => {});
		onDone?.();
	};
	const abandon = async () => {
		cancelled = true;
		await reading?.catch(() => {});
		await close();
	};
	// Bun does not cancel the body of a client that disconnected before reading it; its request
	// signal does fire — unless it already fired before this listener existed.
	signal?.addEventListener("abort", () => void abandon(), { once: true });
	if (signal?.aborted) void abandon();
	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			try {
				if (!current || cancelled) return controller.close();
				const length = Math.min(READ_CHUNK, end - position + 1);
				const buf = new Uint8Array(length);
				const pending = current.read(buf, 0, length, position);
				reading = pending;
				const { bytesRead } = await pending;
				reading = null;
				if (cancelled) return await close();
				if (bytesRead === 0) {
					await close();
					controller.close();
					return;
				}
				position += bytesRead;
				controller.enqueue(bytesRead === length ? buf : buf.subarray(0, bytesRead));
				if (position > end) {
					await close();
					controller.close();
				}
			} catch (err) {
				reading = null;
				await close();
				if (!cancelled) controller.error(err);
			}
		},
		cancel: abandon,
	});
}

async function readRange(handle: FileHandle, start: number, end: number): Promise<Uint8Array<ArrayBuffer>> {
	const buf = new Uint8Array(new ArrayBuffer(end - start + 1));
	const { bytesRead } = await handle.read(buf, 0, buf.length, start);
	return bytesRead === buf.length ? buf : buf.subarray(0, bytesRead);
}

/** Serves `/shared-media/<token>` with Range support; `extraHeaders` lets the desktop route add CORS. */
export async function serveSharedMedia(req: Request, pathname: string, extraHeaders: Record<string, string> = {}): Promise<Response> {
	const token = pathname.slice(SHARED_MEDIA_ROUTE.length);
	const path = pathByToken.get(token);
	if (!path || !existsSync(path)) return new Response("Not Found", { status: 404, headers: extraHeaders });
	if (req.method !== "GET" && req.method !== "HEAD") return new Response("Method Not Allowed", { status: 405, headers: extraHeaders });

	return serveFileBytes(req, path, { ...extraHeaders, "Content-Type": sharedMediaMime(imageExt(path)) }, { signal: req.signal });
}

export interface ServeFileBytesOptions {
	/** Largest 206 body, buffered in memory; the media engine asks for the next range itself. */
	maxRangeBytes?: number;
	/** A whole file up to this size is sent from memory rather than streamed (no `onBeforeStream`). */
	bufferWholeBytes?: number;
	/** Awaited before a body is streamed; a slot gate for large files. Throwing refuses the reply. */
	onBeforeStream?: () => Promise<void>;
	/** Fires exactly once, when the response body is finished or abandoned (or at once for a bodiless reply). */
	onDone?: () => void;
	/** The request's signal: a client that disconnects releases the file even if Bun never reads the body. */
	signal?: AbortSignal;
}

/**
 * GET/HEAD for one file with Range support, from a path or from a handle the
 * caller already opened and verified (this function then owns and closes it). A
 * 206 is a bounded in-memory slice because Bun drops `Content-Length` from a
 * stream body and answers chunked, which WebKit's media loader rejects; a plain
 * 200 streams the whole file. `baseHeaders` must carry the Content-Type.
 */
export async function serveFileBytes(req: Request, source: string | FileHandle, baseHeaders: Record<string, string>, options: ServeFileBytesOptions = {}): Promise<Response> {
	let streaming = false;
	let handle: FileHandle | null = null;
	try {
		handle = typeof source === "string" ? await open(source, "r") : source;
		const size = (await handle.stat()).size;
		const headers: Record<string, string> = {
			...baseHeaders,
			"Accept-Ranges": "bytes",
			"Cache-Control": "private, no-store",
		};
		const range = parseByteRange(req.headers.get("range"), size);
		if (range === "invalid") {
			return new Response(null, { status: 416, headers: { ...headers, "Content-Range": `bytes */${size}` } });
		}
		if (!range) {
			headers["Content-Length"] = String(size);
			if (req.method === "HEAD" || size === 0) return new Response(null, { status: 200, headers });
			if (size <= (options.bufferWholeBytes ?? 0)) return new Response(await readRange(handle, 0, size - 1), { status: 200, headers });
			await options.onBeforeStream?.();
			streaming = true;
			return new Response(fileRangeStream(handle, 0, size - 1, options.onDone, options.signal), { status: 200, headers });
		}
		const { start } = range;
		const end = Math.min(range.end, start + (options.maxRangeBytes ?? MAX_RANGE_RESPONSE_BYTES) - 1);
		headers["Content-Range"] = `bytes ${start}-${end}/${size}`;
		headers["Content-Length"] = String(end - start + 1);
		if (req.method === "HEAD") return new Response(null, { status: 206, headers });
		return new Response(await readRange(handle, start, end), { status: 206, headers });
	} finally {
		if (!streaming) {
			await handle?.close().catch(() => {});
			options.onDone?.();
		}
	}
}

/** Test hook: forget every minted token. */
export function resetSharedMediaTokens(): void {
	pathByToken.clear();
	tokenByPath.clear();
}
