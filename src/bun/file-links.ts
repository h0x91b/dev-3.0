import { randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import { open, stat } from "node:fs/promises";
import { basename, resolve, sep } from "node:path";
import { FILE_LINK_CONTENT_TYPES, fileLinkExt } from "../shared/file-link-types";
import { serveFileBytes } from "./shared-video-stream";

/**
 * Token-only capability links for opening a previewed file in a browser tab.
 * Headers, scoping and why there is no session cookie:
 * decisions/2026/10/17/remote-file-open-in-new-tab.md.
 */

export const FILE_LINK_ROUTE = "/file/";

const TOKEN_TTL_MS = 12 * 60 * 60 * 1000;
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

const links = new Map<string, Link>();

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
export function mintFileLink(scope: FileLinkScope, now = Date.now()): string {
	const pinned: PinnedScope = scope.kind === "dir"
		? { kind: "dir", realRoot: realpathSync(scope.root), entry: scope.entry }
		: { kind: "file", path: scope.path, realPath: realpathSync(scope.path) };
	const token = randomBytes(24).toString("base64url");
	links.set(token, { scope: pinned, expiresAt: now + TOKEN_TTL_MS });
	while (links.size > MAX_TOKENS) links.delete(links.keys().next().value as string);
	const rel = scope.kind === "dir" ? scope.entry : basename(scope.path);
	return `${FILE_LINK_ROUTE}${token}/${encodeRelPath(rel)}`;
}

/**
 * The real file a `/file/<token>/<rel>` path names, or null when the token is
 * unknown/expired, `rel` names a dot-file/folder other than the entry (`.env`,
 * `.git/…`), or the resolved target — symlinks followed — leaves the scope.
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
	let segments: string[];
	try {
		segments = rest.slice(slash + 1).split("/").map(decodeURIComponent);
	} catch {
		return null;
	}
	const rel = segments.join("/");
	if (!rel || rel.includes("\0") || rel.includes("\\")) return null;
	const { scope } = link;
	if (scope.kind === "file") return rel === basename(scope.path) ? realOrNull(scope.path, (real) => real === scope.realPath) : null;
	if (rel !== scope.entry && segments.some((segment) => segment.startsWith("."))) return null;
	return realOrNull(resolve(scope.realRoot, rel), (real) => isInside(real, scope.realRoot));
}

function realOrNull(path: string, accept: (real: string) => boolean): string | null {
	try {
		const real = realpathSync(path);
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

/** Opaque origin for everything a tab renders: no dev3 cookie, no same-origin RPC — whatever injects script. */
export const FILE_LINK_SANDBOX = "sandbox allow-scripts allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-downloads";

/** Serves `/file/<token>/<rel>`; `?download=1` turns any file into an attachment. */
export async function serveFileLink(req: Request, url: URL): Promise<Response> {
	if (req.method !== "GET" && req.method !== "HEAD") return new Response("Method Not Allowed", { status: 405 });
	const path = resolveFileLinkPath(url.pathname);
	if (!path) return new Response("Not Found", { status: 404 });
	try {
		if (!(await stat(path)).isFile()) return new Response("Not Found", { status: 404 });
		const download = url.searchParams.get("download") === "1";
		const contentType = download ? "application/octet-stream" : await fileLinkContentType(path);
		const headers: Record<string, string> = {
			"Content-Type": contentType,
			"X-Content-Type-Options": "nosniff",
			"Referrer-Policy": "no-referrer",
		};
		if (download) headers["Content-Disposition"] = attachmentDisposition(basename(path));
		// Chromium's PDF viewer refuses to load in a sandboxed document; a PDF runs no page script.
		else if (!contentType.startsWith("application/pdf")) headers["Content-Security-Policy"] = FILE_LINK_SANDBOX;
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
