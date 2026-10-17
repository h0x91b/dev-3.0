import { randomBytes } from "node:crypto";
import { open, stat } from "node:fs/promises";
import { basename, extname, resolve, sep } from "node:path";
import { serveFileBytes } from "./shared-video-stream";

/**
 * Capability links that let a browser-mode viewer open a previewed file in its
 * own tab or download it. The token in the URL is the whole credential: an HTML
 * page is served with a CSP sandbox, its origin is opaque, and an opaque origin
 * never carries the SameSite=Strict session cookie, so the page's own CSS and
 * images could not authenticate any other way. Why the headers look the way they
 * do: decisions/2026/10/17/remote-file-open-in-new-tab.md.
 */

export const FILE_LINK_ROUTE = "/file/";

const TOKEN_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_TOKENS = 256;
const SNIFF_BYTES = 8192;

/** `dir` serves the file's siblings too, so a report's relative assets resolve; `file` serves one file. */
export type FileLinkScope = { kind: "dir"; root: string; entry: string } | { kind: "file"; path: string };

interface Link {
	scope: FileLinkScope;
	expiresAt: number;
}

const links = new Map<string, Link>();
const tokenByKey = new Map<string, string>();

function scopeKey(scope: FileLinkScope): string {
	return scope.kind === "dir" ? `dir:${scope.root}` : `file:${scope.path}`;
}

function encodeRelPath(rel: string): string {
	return rel.split("/").map(encodeURIComponent).join("/");
}

/** Mint (or refresh) the token for `scope` and return the URL path that views its entry file. */
export function mintFileLink(scope: FileLinkScope, now = Date.now()): string {
	const key = scopeKey(scope);
	let token = tokenByKey.get(key);
	if (token) links.delete(token);
	token ??= randomBytes(24).toString("base64url");
	// Re-inserting keeps the Map ordered oldest-first, so eviction drops the least recently minted.
	links.set(token, { scope, expiresAt: now + TOKEN_TTL_MS });
	tokenByKey.set(key, token);
	while (links.size > MAX_TOKENS) {
		const [oldToken, oldLink] = links.entries().next().value as [string, Link];
		links.delete(oldToken);
		tokenByKey.delete(scopeKey(oldLink.scope));
	}
	const rel = scope.kind === "dir" ? scope.entry : basename(scope.path);
	return `${FILE_LINK_ROUTE}${token}/${encodeRelPath(rel)}`;
}

/** The file a `/file/<token>/<rel>` path names, or null when the token is unknown/expired or `rel` leaves the scope. */
export function resolveFileLinkPath(pathname: string, now = Date.now()): string | null {
	const rest = pathname.slice(FILE_LINK_ROUTE.length);
	const slash = rest.indexOf("/");
	if (slash <= 0) return null;
	const token = rest.slice(0, slash);
	const link = links.get(token);
	if (!link) return null;
	if (link.expiresAt <= now) {
		links.delete(token);
		tokenByKey.delete(scopeKey(link.scope));
		return null;
	}
	let rel: string;
	try {
		rel = rest.slice(slash + 1).split("/").map(decodeURIComponent).join("/");
	} catch {
		return null;
	}
	if (!rel || rel.includes("\0")) return null;
	if (link.scope.kind === "file") return rel === basename(link.scope.path) ? link.scope.path : null;
	const root = link.scope.root;
	const target = resolve(root, rel);
	return target.startsWith(root.endsWith(sep) ? root : root + sep) ? target : null;
}

const TEXT = "text/plain; charset=utf-8";
const CONTENT_TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".htm": "text/html; charset=utf-8",
	".xhtml": "application/xhtml+xml; charset=utf-8",
	".svg": "image/svg+xml",
	".md": "text/markdown; charset=utf-8",
	".markdown": "text/markdown; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".avif": "image/avif",
	".bmp": "image/bmp",
	".ico": "image/x-icon",
	".pdf": "application/pdf",
	".mp4": "video/mp4",
	".webm": "video/webm",
	".mp3": "audio/mpeg",
	".wav": "audio/wav",
	".ogg": "audio/ogg",
	".woff": "font/woff",
	".woff2": "font/woff2",
	".ttf": "font/ttf",
	".otf": "font/otf",
};

/** Types that can run script when opened as a page — they get the CSP sandbox. */
const ACTIVE_TYPES = new Set([".html", ".htm", ".xhtml", ".svg"]);

/** Known extension first; otherwise a NUL in the first 8 KB means binary, anything else is shown as text. */
export async function fileLinkContentType(path: string): Promise<string> {
	const known = CONTENT_TYPES[extname(path).toLowerCase()];
	if (known) return known;
	const handle = await open(path, "r");
	try {
		const buf = new Uint8Array(SNIFF_BYTES);
		const { bytesRead } = await handle.read(buf, 0, SNIFF_BYTES, 0);
		return buf.subarray(0, bytesRead).includes(0) ? "application/octet-stream" : TEXT;
	} finally {
		await handle.close();
	}
}

/** RFC 6266: an ASCII fallback for old clients plus the exact UTF-8 name. */
export function attachmentDisposition(name: string): string {
	const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
	return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/** Serves `/file/<token>/<rel>`; `?download=1` turns any file into an attachment. */
export async function serveFileLink(req: Request, url: URL): Promise<Response> {
	if (req.method !== "GET" && req.method !== "HEAD") return new Response("Method Not Allowed", { status: 405 });
	const path = resolveFileLinkPath(url.pathname);
	if (!path) return new Response("Not Found", { status: 404 });
	try {
		if (!(await stat(path)).isFile()) return new Response("Not Found", { status: 404 });
	} catch {
		return new Response("Not Found", { status: 404 });
	}
	const download = url.searchParams.get("download") === "1";
	const headers: Record<string, string> = {
		"Content-Type": download ? "application/octet-stream" : await fileLinkContentType(path),
		"X-Content-Type-Options": "nosniff",
		"Referrer-Policy": "no-referrer",
	};
	if (download) headers["Content-Disposition"] = attachmentDisposition(basename(path));
	else if (ACTIVE_TYPES.has(extname(path).toLowerCase())) {
		headers["Content-Security-Policy"] = "sandbox allow-scripts allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-downloads";
	}
	return serveFileBytes(req, path, headers);
}

/** Test hook: forget every minted link. */
export function resetFileLinks(): void {
	links.clear();
	tokenByKey.clear();
}
