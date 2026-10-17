import { randomBytes } from "node:crypto";
import { constants as fsConstants, readlinkSync, realpathSync } from "node:fs";
import { open, stat } from "node:fs/promises";
import { basename, relative, resolve, sep } from "node:path";
import { ATTACHMENT_ONLY_EXTS, FILE_LINK_CONTENT_TYPES, fileLinkExt } from "../shared/file-link-types";
import { run as runGit } from "./git";
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

/**
 * `dir` also serves the entry's folder tree, so a page's relative assets resolve; `file` serves one
 * file. `ignoreCheckout`: refuse files that checkout's `.gitignore` excludes (local secrets such as
 * `config/master.key`) — omitted when the page itself is ignored build output.
 */
export type FileLinkScope = { kind: "dir"; root: string; entry: string; ignoreCheckout?: string } | { kind: "file"; path: string };

/** Scope pinned to real paths at mint time, so a symlink swapped in later cannot widen it. */
type PinnedScope = { kind: "dir"; realRoot: string; entry: string; ignoreCheckout?: string } | { kind: "file"; path: string; realPath: string };

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
export function mintFileLink(scope: FileLinkScope, { now = Date.now(), ttlMs = VIEW_TTL_MS, resolved = false } = {}): string {
	// `resolved`: the caller already resolved these paths and checked the result; resolving
	// again here could pin a different folder than the one that was checked.
	const real = (path: string) => (resolved ? path : realPath(path));
	const pinned: PinnedScope = scope.kind === "dir"
		? { kind: "dir", realRoot: real(scope.root), entry: scope.entry, ignoreCheckout: scope.ignoreCheckout }
		: { kind: "file", path: scope.path, realPath: real(scope.path) };
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
	return resolveFileLinkTarget(pathname, now)?.path ?? null;
}

interface FileLinkTarget {
	path: string;
	token: string;
	/** Set when the file must also not be gitignored in this checkout (folder links only). */
	ignoreCheckout?: string;
}

function resolveFileLinkTarget(pathname: string, now = Date.now()): FileLinkTarget | null {
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
		const path = realOrNull(scope.path, (real) => real === scope.realPath);
		return path ? { path, token } : null;
	}
	const target = resolve(scope.realRoot, ...segments);
	if (!isInside(target, scope.realRoot)) return null;
	let isEntry = false;
	const path = realOrNull(target, (real) => {
		if (!isInside(real, scope.realRoot)) return false;
		const parts = relative(scope.realRoot, real).split(sep);
		isEntry = parts.join("/") === scope.entry;
		return isEntry || !parts.some((part) => part.startsWith("."));
	});
	if (!path) return null;
	return { path, token, ignoreCheckout: isEntry ? undefined : scope.ignoreCheckout };
}

/** `git check-ignore` for `path` in `checkout`: exit 0 ignored, 1 not, anything else (no git, timeout) unknown. */
export async function gitIgnoreState(checkout: string, path: string): Promise<"ignored" | "not-ignored" | "unknown"> {
	try {
		const result = await runGit(["git", "check-ignore", "-q", "--", relative(checkout, path)], checkout, { timeoutMs: 5000 });
		if (result.ok) return "ignored";
		return result.stderr.trim() === "" ? "not-ignored" : "unknown";
	} catch {
		return "unknown";
	}
}

function realOrNull(path: string, accept: (real: string) => boolean): string | null {
	try {
		const real = realPath(path);
		return accept(real) ? real : null;
	} catch {
		return null;
	}
}

type FileHandle = Awaited<ReturnType<typeof open>>;

/** Known extension first; otherwise a NUL in the first 8 KB means binary, anything else is shown as text. */
async function fileLinkContentType(path: string, handle: FileHandle): Promise<string> {
	const known = FILE_LINK_CONTENT_TYPES[fileLinkExt(path)];
	if (known) return known;
	const buf = new Uint8Array(SNIFF_BYTES);
	const { bytesRead } = await handle.read(buf, 0, SNIFF_BYTES, 0);
	return buf.subarray(0, bytesRead).includes(0) ? "application/octet-stream" : "text/plain; charset=utf-8";
}

/**
 * Whether the file actually opened is the one `resolveFileLinkPath` checked: a
 * folder swapped for a symlink between the check and the open would otherwise
 * serve a file outside the scope. Linux names the opened file exactly; elsewhere
 * its identity must match the checked path, which must still be real.
 */
async function openedFileIs(handle: FileHandle, path: string): Promise<boolean> {
	if (process.platform === "linux") {
		try {
			return readlinkSync(`/proc/self/fd/${handle.fd}`) === path;
		} catch {
			// no procfs — fall through to the identity check
		}
	}
	const [opened, named] = await Promise.all([handle.stat(), stat(path)]);
	return opened.dev === named.dev && opened.ino === named.ino && realOrNull(path, (real) => real === path) !== null;
}

/** Opens the file `resolveFileLinkPath` checked, or returns null when what got opened is not that file. */
export async function openCheckedFile(path: string): Promise<FileHandle | null> {
	// Non-blocking, so a FIFO planted in scope cannot hang the open (and with it Bun's I/O pool).
	const handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK ?? 0));
	let keep = false;
	try {
		keep = (await openedFileIs(handle, path)) && (await handle.stat()).isFile();
		return keep ? handle : null;
	} finally {
		if (!keep) await handle.close().catch(() => {});
	}
}

/** RFC 6266: an ASCII fallback for old clients plus the exact UTF-8 name. */
export function attachmentDisposition(name: string): string {
	const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
	return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/**
 * Opaque origin for everything a tab renders: no dev3 cookie, no same-origin RPC.
 * Forms and modals are off as cheap hardening only — a scripted page can still
 * draw its own fake prompt on the dev3 host (decision record, Risks).
 */
export const FILE_LINK_SANDBOX = "sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox allow-downloads";

/** Video and audio play in the browser's own media document, which runs no page script and refuses a sandbox. */
const UNSANDBOXED_MEDIA = /^(?:video|audio)\//;

/**
 * Responses whose body is still being sent, released when it finishes or the
 * client leaves. One token gets a few, so a leaked link cannot starve the rest.
 */
const MAX_OPEN_RESPONSES = 64;
const MAX_OPEN_RESPONSES_PER_TOKEN = 8;
let openResponses = 0;
const openByToken = new Map<string, number>();

/** A /file/ range reply is buffered, so it stays small; the media engine asks for the next one. */
const FILE_LINK_MAX_RANGE_BYTES = 1024 * 1024;

const PLAIN_HEADERS = { "Content-Type": "text/plain; charset=utf-8", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "Cache-Control": "no-store" };

function plain(status: number, body: string, extra: Record<string, string> = {}): Response {
	return new Response(body, { status, headers: { ...PLAIN_HEADERS, ...extra } });
}

/** Serves `/file/<token>/<rel>`; `?download=1` turns any file into an attachment. */
export async function serveFileLink(req: Request, url: URL): Promise<Response> {
	if (req.method !== "GET" && req.method !== "HEAD") return plain(405, "Method Not Allowed");
	const target = resolveFileLinkTarget(url.pathname);
	if (!target) return plain(404, "Not Found");
	const { path, token } = target;
	const tokenOpen = openByToken.get(token) ?? 0;
	if (openResponses >= MAX_OPEN_RESPONSES || tokenOpen >= MAX_OPEN_RESPONSES_PER_TOKEN) return plain(503, "Busy", { "Retry-After": "1" });
	openResponses++;
	openByToken.set(token, tokenOpen + 1);
	let released = false;
	const release = () => {
		if (released) return;
		released = true;
		openResponses--;
		const left = (openByToken.get(token) ?? 1) - 1;
		if (left > 0) openByToken.set(token, left);
		else openByToken.delete(token);
	};
	let handedOff = false;
	let handle: FileHandle | null = null;
	try {
		if (target.ignoreCheckout && (await gitIgnoreState(target.ignoreCheckout, path)) !== "not-ignored") return plain(404, "Not Found");
		handle = await openCheckedFile(path);
		if (!handle) return plain(404, "Not Found");
		const sniffed = await fileLinkContentType(path, handle);
		const download = url.searchParams.get("download") === "1" || ATTACHMENT_ONLY_EXTS.has(fileLinkExt(path));
		const contentType = download ? "application/octet-stream" : sniffed;
		const headers: Record<string, string> = {
			"Content-Type": contentType,
			"X-Content-Type-Options": "nosniff",
			"Referrer-Policy": "no-referrer",
		};
		if (download) headers["Content-Disposition"] = attachmentDisposition(basename(path));
		else if (!UNSANDBOXED_MEDIA.test(contentType)) headers["Content-Security-Policy"] = FILE_LINK_SANDBOX;
		// A client gone before the body exists would never be read or cancelled by Bun.
		if (req.signal.aborted) return plain(499, "Client Closed Request");
		const owned = handle;
		handle = null;
		handedOff = true;
		return await serveFileBytes(req, owned, headers, { maxRangeBytes: FILE_LINK_MAX_RANGE_BYTES, onDone: release, signal: req.signal });
	} catch {
		// Unreadable, or gone between the checks — never let Bun's error page echo the path.
		return plain(404, "Not Found");
	} finally {
		await handle?.close().catch(() => {});
		if (!handedOff) release();
	}
}

/** Test hook: how many `/file/` responses are still sending their body. */
export function openFileLinkResponses(): number {
	return openResponses;
}

/** Test hook: forget every minted link. */
export function resetFileLinks(): void {
	links.clear();
	openByToken.clear();
	openResponses = 0;
}
