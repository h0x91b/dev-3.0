import { randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import { open, stat } from "node:fs/promises";
import { basename, relative, resolve, sep } from "node:path";
import { FILE_LINK_CONTENT_TYPES, fileLinkExt } from "../shared/file-link-types";
import { serveFileBytes } from "./shared-video-stream";

/**
 * Token-only capability links for opening a previewed file in a browser tab.
 * Headers, scoping and why there is no session cookie:
 * decisions/2026/10/17/remote-file-open-in-new-tab.md.
 */

export const FILE_LINK_ROUTE = "/file/";

const VIEW_TTL_MS = 12 * 60 * 60 * 1000;
/** A download is fetched once, right away; its link should not linger in download history. */
export const DOWNLOAD_TTL_MS = 60 * 1000;
const MAX_TOKENS = 256;
const SNIFF_BYTES = 8192;

/** `dir` also serves the entry's folder tree, so a page's relative assets resolve; `file` serves one file. */
export type FileLinkScope = { kind: "dir"; root: string; entry: string } | { kind: "file"; path: string };

/** Scope pinned to real paths at mint time, so a symlink swapped in later cannot widen it. */
type PinnedScope = { kind: "dir"; realRoot: string; entry: string } | { kind: "file"; path: string; realPath: string };

interface Link {
	scope: PinnedScope;
	expiresAt: number;
}

/** Insertion order is recency: a lookup moves its link to the end, so the cap evicts the least recently used. */
const links = new Map<string, Link>();

/** `native` expands Windows 8.3 short names (`ENV~1`), which would otherwise hide a dot-file from the check. */
function realPath(path: string): string {
	return realpathSync.native(path);
}

function encodeRelPath(rel: string): string {
	return rel.split("/").map(encodeURIComponent).join("/");
}

function isInside(path: string, root: string): boolean {
	return path.startsWith(root.endsWith(sep) ? root : root + sep);
}

/**
 * Mint a fresh token for `scope` and return the URL path that views its entry
 * file. Every call gets a new token: reusing one would let a leaked link live on
 * for as long as the user keeps opening files in that folder.
 */
export function mintFileLink(scope: FileLinkScope, { now = Date.now(), ttlMs = VIEW_TTL_MS } = {}): string {
	const pinned: PinnedScope = scope.kind === "dir"
		? { kind: "dir", realRoot: realPath(scope.root), entry: scope.entry }
		: { kind: "file", path: scope.path, realPath: realPath(scope.path) };
	const token = randomBytes(24).toString("base64url");
	links.set(token, { scope: pinned, expiresAt: now + ttlMs });
	while (links.size > MAX_TOKENS) links.delete(links.keys().next().value as string);
	const rel = scope.kind === "dir" ? scope.entry : basename(scope.path);
	return `${FILE_LINK_ROUTE}${token}/${encodeRelPath(rel)}`;
}

/**
 * A decoded URL segment must be one plain name: never empty, `.`, `..`, or
 * carrying a separator (`%2F`), NUL, or — on Windows — `\` or a drive colon,
 * any of which would let `resolve()` reach somewhere the URL did not name.
 */
function isPlainSegment(segment: string): boolean {
	if (!segment || segment === "." || segment === ".." || segment.includes("/") || segment.includes("\0")) return false;
	return sep !== "\\" || !(segment.includes("\\") || segment.includes(":"));
}

/**
 * The real file a `/file/<token>/<rel>` path names, or null when the token is
 * unknown/expired or the target leaves the scope. Under a folder link the dot
 * rule (`.env`, `.git/…`) is checked on the real path, so encodings and
 * symlinks cannot reach a dot-file either.
 */
export function resolveFileLinkPath(pathname: string, now = Date.now()): string | null {
	const rest = pathname.slice(FILE_LINK_ROUTE.length);
	const slash = rest.indexOf("/");
	if (slash <= 0) return null;
	const token = rest.slice(0, slash);
	const link = links.get(token);
	if (!link) return null;
	if (link.expiresAt <= now) {
		links.delete(token);
		return null;
	}
	links.delete(token);
	links.set(token, link);
	let segments: string[];
	try {
		segments = rest.slice(slash + 1).split("/").map(decodeURIComponent);
	} catch {
		return null;
	}
	if (!segments.every(isPlainSegment)) return null;
	const { scope } = link;
	if (scope.kind === "file") {
		if (segments.length !== 1 || segments[0] !== basename(scope.path)) return null;
		return realOrNull(scope.path, (real) => real === scope.realPath);
	}
	const target = resolve(scope.realRoot, ...segments);
	if (!isInside(target, scope.realRoot)) return null;
	return realOrNull(target, (real) => {
		if (!isInside(real, scope.realRoot)) return false;
		const parts = relative(scope.realRoot, real).split(sep);
		return parts.join("/") === scope.entry || !parts.some((part) => part.startsWith("."));
	});
}

function realOrNull(path: string, accept: (real: string) => boolean): string | null {
	try {
		const real = realPath(path);
		return accept(real) ? real : null;
	} catch {
		return null;
	}
}

/** Known extension first; otherwise a NUL in the first 8 KB means binary, anything else is shown as text. */
export async function fileLinkContentType(path: string): Promise<string> {
	const known = FILE_LINK_CONTENT_TYPES[fileLinkExt(path)];
	if (known) return known;
	const handle = await open(path, "r");
	try {
		const buf = new Uint8Array(SNIFF_BYTES);
		const { bytesRead } = await handle.read(buf, 0, SNIFF_BYTES, 0);
		return buf.subarray(0, bytesRead).includes(0) ? "application/octet-stream" : "text/plain; charset=utf-8";
	} finally {
		await handle.close();
	}
}

/** RFC 6266: an ASCII fallback for old clients plus the exact UTF-8 name. */
export function attachmentDisposition(name: string): string {
	const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
	return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/**
 * Opaque origin for everything a tab renders: no dev3 cookie, no same-origin RPC.
 * No forms or modals either — a page on the user's own dev3 host must not be
 * able to draw a convincing "enter your access code" prompt.
 */
export const FILE_LINK_SANDBOX = "sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox allow-downloads";

/**
 * Served as files, never rendered on the dev3 origin: a PDF viewer cannot run
 * sandboxed, and its script engine is not worth trusting with the session.
 */
const ATTACHMENT_ONLY = /^application\/pdf/;

/** Video and audio play in the browser's own media document, which runs no page script and refuses a sandbox. */
const UNSANDBOXED_MEDIA = /^(?:video|audio)\//;

/** Serves `/file/<token>/<rel>`; `?download=1` turns any file into an attachment. */
export async function serveFileLink(req: Request, url: URL): Promise<Response> {
	if (req.method !== "GET" && req.method !== "HEAD") return new Response("Method Not Allowed", { status: 405 });
	const path = resolveFileLinkPath(url.pathname);
	if (!path) return new Response("Not Found", { status: 404 });
	try {
		if (!(await stat(path)).isFile()) return new Response("Not Found", { status: 404 });
		const sniffed = await fileLinkContentType(path);
		const download = url.searchParams.get("download") === "1" || ATTACHMENT_ONLY.test(sniffed);
		const contentType = download ? "application/octet-stream" : sniffed;
		const headers: Record<string, string> = {
			"Content-Type": contentType,
			"X-Content-Type-Options": "nosniff",
			"Referrer-Policy": "no-referrer",
		};
		if (download) headers["Content-Disposition"] = attachmentDisposition(basename(path));
		else if (!UNSANDBOXED_MEDIA.test(contentType)) headers["Content-Security-Policy"] = FILE_LINK_SANDBOX;
		return await serveFileBytes(req, path, headers);
	} catch {
		// Unreadable, or gone between the checks — never let Bun's error page echo the path.
		return new Response("Not Found", { status: 404 });
	}
}

/** Test hook: forget every minted link. */
export function resetFileLinks(): void {
	links.clear();
}
