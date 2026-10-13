import { randomBytes } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { open } from "node:fs/promises";
import { SHARED_VIDEO_EXTS } from "../shared/types";
import { isFullyQualifiedPath } from "../shared/absolute-path";
import { DEV3_HOME } from "./paths";
import { imageExt } from "./shared-images";

/**
 * HTTP streaming for `dev3 show-video` clips. A clip can be hundreds of MB, so
 * the viewer never reads it over RPC: it gets a capability URL and the `<video>`
 * element pulls byte ranges on demand. Desktop serves it from the loopback-only
 * PTY server, remote mode from the session-authenticated remote server.
 */

export const SHARED_VIDEO_ROUTE = "/shared-video/";

const MIME: Record<string, string> = { mp4: "video/mp4", webm: "video/webm" };
const READ_CHUNK = 1024 * 1024;
/** Most bytes one 206 carries; the player asks again for the rest, as it does when seeking. */
export const MAX_RANGE_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_TOKENS = 256;

const pathByToken = new Map<string, string>();
const tokenByPath = new Map<string, string>();

/** Only a clip `dev3 show-video` stored — never an arbitrary file the renderer names. */
export function isStoredSharedVideoPath(path: string): boolean {
	if (!isFullyQualifiedPath(path, process.platform)) return false;
	const normalized = path.replaceAll("\\", "/");
	const root = `${DEV3_HOME.replaceAll("\\", "/")}/worktrees/`;
	if (!normalized.startsWith(root)) return false;
	const parts = normalized.slice(root.length).split("/");
	return parts.length === 3 && parts[1] === "shared-images" && SHARED_VIDEO_EXTS.includes(imageExt(normalized));
}

/** The URL path (`/shared-video/<token>`) that streams `storedPath`, or null when it is not a stored clip. */
export function sharedVideoUrlPath(storedPath: string): string | null {
	if (!isStoredSharedVideoPath(storedPath) || !existsSync(storedPath)) return null;
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
	return `${SHARED_VIDEO_ROUTE}${token}`;
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

/**
 * Reads lazily, one chunk per pull, so a 300 MB clip never sits in memory. A
 * stream body also keeps Bun off its sendfile path, which drops the response
 * headers on macOS LAN sockets (decisions/2026/07/07/remote-static-sendfile-lan-headerless.md).
 */
function fileRangeStream(path: string, start: number, end: number): ReadableStream<Uint8Array> {
	let handle: Awaited<ReturnType<typeof open>> | null = null;
	let position = start;
	const close = async () => {
		const h = handle;
		handle = null;
		await h?.close().catch(() => {});
	};
	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			try {
				handle ??= await open(path, "r");
				const length = Math.min(READ_CHUNK, end - position + 1);
				const buf = new Uint8Array(length);
				const { bytesRead } = await handle.read(buf, 0, length, position);
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
				await close();
				controller.error(err);
			}
		},
		cancel: close,
	});
}

async function readRange(path: string, start: number, end: number): Promise<Uint8Array<ArrayBuffer>> {
	const handle = await open(path, "r");
	try {
		const buf = new Uint8Array(new ArrayBuffer(end - start + 1));
		const { bytesRead } = await handle.read(buf, 0, buf.length, start);
		return bytesRead === buf.length ? buf : buf.subarray(0, bytesRead);
	} finally {
		await handle.close();
	}
}

/**
 * Serves `/shared-video/<token>` with Range support; `extraHeaders` lets the desktop route add CORS.
 * A 206 is a bounded in-memory slice because Bun drops `Content-Length` from a stream body and
 * answers chunked, which media engines handle less reliably; a plain 200 streams the whole clip.
 */
export async function serveSharedVideo(req: Request, pathname: string, extraHeaders: Record<string, string> = {}): Promise<Response> {
	const token = pathname.slice(SHARED_VIDEO_ROUTE.length);
	const path = pathByToken.get(token);
	if (!path || !existsSync(path)) return new Response("Not Found", { status: 404, headers: extraHeaders });
	if (req.method !== "GET" && req.method !== "HEAD") return new Response("Method Not Allowed", { status: 405, headers: extraHeaders });

	const size = statSync(path).size;
	const headers: Record<string, string> = {
		...extraHeaders,
		"Content-Type": MIME[imageExt(path)] ?? "application/octet-stream",
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
		return new Response(fileRangeStream(path, 0, size - 1), { status: 200, headers });
	}
	const { start } = range;
	const end = Math.min(range.end, start + MAX_RANGE_RESPONSE_BYTES - 1);
	headers["Content-Range"] = `bytes ${start}-${end}/${size}`;
	headers["Content-Length"] = String(end - start + 1);
	if (req.method === "HEAD") return new Response(null, { status: 206, headers });
	return new Response(await readRange(path, start, end), { status: 206, headers });
}

/** Test hook: forget every minted token. */
export function resetSharedVideoTokens(): void {
	pathByToken.clear();
	tokenByPath.clear();
}
