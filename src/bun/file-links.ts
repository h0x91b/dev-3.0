import { randomBytes } from "node:crypto";
import { constants as fsConstants, readlinkSync, realpathSync } from "node:fs";
import { open, stat } from "node:fs/promises";
import { basename, dirname, relative, resolve, sep } from "node:path";
import { ATTACHMENT_ONLY_EXTS, FILE_LINK_CONTENT_TYPES, PAGE_ASSET_EXTS, fileLinkExt } from "../shared/file-link-types";
import { spawn } from "./spawn";
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
 * file. `ignore`: refuse what `checkout` gitignores under the folder (local secrets such as
 * `config/master.key`) — except page assets when the page itself is ignored build output.
 */
export type FileLinkScope =
	| { kind: "dir"; root: string; entry: string; ignore?: IgnoreScope }
	| { kind: "file"; path: string };

export interface IgnoreScope {
	checkout: string;
	pageIgnored: boolean;
}

/** Scope pinned to real paths at mint time, so a symlink swapped in later cannot widen it. */
type PinnedScope =
	| { kind: "dir"; realRoot: string; entry: string; ignore?: IgnoreScope }
	| { kind: "file"; path: string; realPath: string };

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
		? { kind: "dir", realRoot: real(scope.root), entry: scope.entry, ignore: scope.ignore }
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
	/** Set for a folder link's files other than the page: they must also pass the gitignore filter. */
	ignore?: IgnoreScope & { folder: string };
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
	return { path, token, ignore: isEntry || !scope.ignore ? undefined : { ...scope.ignore, folder: scope.realRoot } };
}

/** Gitignored paths under a folder, relative to the checkout with `/` separators; a folder entry ends in `/`. */
interface IgnoreList {
	files: Set<string>;
	dirs: string[];
}

const IGNORE_LIST_TTL_MS = 30_000;
const IGNORE_LIST_TIMEOUT_MS = 10_000;
const ignoreLists = new Map<string, { at: number; list: Promise<IgnoreList | null> }>();

function toPosix(path: string): string {
	return sep === "\\" ? path.split(sep).join("/") : path;
}

/**
 * One `git ls-files --others --ignored --exclude-standard --directory -z` for the
 * folder: NUL-separated paths, no rule text to parse, a wholly ignored folder
 * collapsed to `dir/`. `./` keeps a name starting with `:` from reading as
 * pathspec magic. Any failure is null, which every caller treats as "refuse".
 */
async function runIgnoreList(checkout: string, folder: string): Promise<IgnoreList | null> {
	try {
		const rel = toPosix(relative(checkout, folder)) || ".";
		const proc = spawn(["git", "ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory", "--", `./${rel}`], { cwd: checkout, stdout: "pipe", stderr: "ignore" });
		const timer = setTimeout(() => proc.kill(), IGNORE_LIST_TIMEOUT_MS);
		const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
		clearTimeout(timer);
		if (code !== 0) return null;
		const list: IgnoreList = { files: new Set(), dirs: [] };
		for (const entry of stdout.split("\0")) {
			if (!entry) continue;
			if (entry.endsWith("/")) list.dirs.push(entry);
			else list.files.add(entry);
		}
		return list;
	} catch {
		return null;
	}
}

/** Shared by every link and request on the folder, refreshed after 30 s; a failed listing is not kept. */
function ignoreListFor(checkout: string, folder: string, now = Date.now()): Promise<IgnoreList | null> {
	const key = `${checkout}\0${folder}`;
	const cached = ignoreLists.get(key);
	if (cached && now - cached.at < IGNORE_LIST_TTL_MS) return cached.list;
	const list = runIgnoreList(checkout, folder);
	ignoreLists.set(key, { at: now, list });
	void list.then((result) => {
		if (!result && ignoreLists.get(key)?.list === list) ignoreLists.delete(key);
	});
	return list;
}

function isListedIgnored(list: IgnoreList, checkout: string, path: string): boolean {
	const rel = toPosix(relative(checkout, path));
	return list.files.has(rel) || list.dirs.some((dir) => rel.startsWith(dir));
}

async function passesIgnoreFilter(target: FileLinkTarget): Promise<boolean> {
	const { ignore, path } = target;
	if (!ignore) return true;
	const list = await ignoreListFor(ignore.checkout, ignore.folder);
	if (!list) return false;
	if (!isListedIgnored(list, ignore.checkout, path)) return true;
	// An ignored page's own assets ride along, but only what a page loads — never `tmp/secret.txt`.
	return ignore.pageIgnored && PAGE_ASSET_EXTS.has(fileLinkExt(path));
}

/** A folder link for a page inside `checkout`, with the gitignore filter set up for its folder. */
export async function mintFolderLink(realFile: string, checkout: string): Promise<string> {
	const list = await ignoreListFor(checkout, dirname(realFile));
	const pageIgnored = list ? isListedIgnored(list, checkout, realFile) : false;
	return mintFileLink({ kind: "dir", root: dirname(realFile), entry: basename(realFile), ignore: { checkout, pageIgnored } }, { resolved: true });
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
 * Only scripts and sandboxed popups: no forms, modals, downloads or sandbox escape
 * (hardening only — a scripted page can still draw a fake prompt; see Risks).
 */
export const FILE_LINK_SANDBOX = "sandbox allow-scripts allow-popups";

/** Video and audio play in the browser's own media document, which runs no page script and refuses a sandbox. */
const UNSANDBOXED_MEDIA = /^(?:video|audio)\//;

/**
 * Large-file bodies still streaming, released when the body ends, is cancelled or
 * the client leaves. Files up to 1 MB are sent from memory and take no slot, so a
 * page loading many assets at once is never refused; a large file waits for one.
 */
const MAX_STREAMING = 64;
const MAX_STREAMING_PER_TOKEN = 16;
/** Waiters each hold an open file, so only so many may queue; beyond that a reply is refused. */
const MAX_SLOT_WAITERS = 128;
let streaming = 0;
let slotWaiters = 0;
const streamingByToken = new Map<string, number>();

class SlotBusyError extends Error {}

/** Waits for a slot for as long as the client stays connected — a slow link must not lose assets. */
async function takeStreamSlot(token: string, signal: AbortSignal): Promise<() => void> {
	const full = () => streaming >= MAX_STREAMING || (streamingByToken.get(token) ?? 0) >= MAX_STREAMING_PER_TOKEN;
	if (full()) {
		if (slotWaiters >= MAX_SLOT_WAITERS) throw new SlotBusyError();
		slotWaiters++;
		try {
			while (full()) {
				if (signal.aborted) throw new SlotBusyError();
				await new Promise((resolve) => setTimeout(resolve, 50));
			}
		} finally {
			slotWaiters--;
		}
	}
	streaming++;
	streamingByToken.set(token, (streamingByToken.get(token) ?? 0) + 1);
	let released = false;
	return () => {
		if (released) return;
		released = true;
		streaming--;
		const left = (streamingByToken.get(token) ?? 1) - 1;
		if (left > 0) streamingByToken.set(token, left);
		else streamingByToken.delete(token);
	};
}

/** A /file/ reply sent from memory (a range, or a whole small file) stays at most this big. */
const FILE_LINK_BUFFER_BYTES = 1024 * 1024;

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
	let handle: FileHandle | null = null;
	let release: (() => void) | null = null;
	try {
		if (!(await passesIgnoreFilter(target))) return plain(404, "Not Found");
		handle = await openCheckedFile(path);
		if (!handle) return plain(404, "Not Found");
		const sniffed = await fileLinkContentType(path, handle);
		const download = url.searchParams.get("download") === "1" || ATTACHMENT_ONLY_EXTS.has(fileLinkExt(path));
		const contentType = download ? "application/octet-stream" : sniffed;
		const headers: Record<string, string> = {
			"Content-Type": contentType,
			"X-Content-Type-Options": "nosniff",
			"Referrer-Policy": "no-referrer",
			// Its own browsing-context group, so the page does not share a process with the live app.
			"Cross-Origin-Opener-Policy": "same-origin",
		};
		if (download) headers["Content-Disposition"] = attachmentDisposition(basename(path));
		else if (!UNSANDBOXED_MEDIA.test(contentType)) headers["Content-Security-Policy"] = FILE_LINK_SANDBOX;
		// A client gone before the body exists would never be read or cancelled by Bun.
		if (req.signal.aborted) return plain(499, "Client Closed Request");
		const owned = handle;
		handle = null;
		return await serveFileBytes(req, owned, headers, {
			maxRangeBytes: FILE_LINK_BUFFER_BYTES,
			bufferWholeBytes: FILE_LINK_BUFFER_BYTES,
			signal: req.signal,
			onBeforeStream: async () => {
				release = await takeStreamSlot(token, req.signal);
			},
			onDone: () => release?.(),
		});
	} catch (err) {
		if (err instanceof SlotBusyError) return plain(503, "Busy", { "Retry-After": "1" });
		// Unreadable, or gone between the checks — never let Bun's error page echo the path.
		return plain(404, "Not Found");
	} finally {
		await handle?.close().catch(() => {});
	}
}

/** Test hook: how many large-file `/file/` bodies are still streaming. */
export function openFileLinkResponses(): number {
	return streaming;
}

/** Test hook: forget every minted link. */
export function resetFileLinks(): void {
	links.clear();
	ignoreLists.clear();
	streamingByToken.clear();
	streaming = 0;
}
