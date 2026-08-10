import { useEffect, useMemo, useState } from "react";
import { api } from "../../rpc";

/**
 * Repo-relative images in a rendered markdown document (`![](docs/shot.png)`).
 * The webview has no base URL pointing at the checkout, so such a src can never
 * load as a plain URL — it is read off disk through `readFilePreview` and swapped
 * in as a data URL. Same handler the terminal path preview uses, so the path is
 * gated to the home dir plus registered project roots on the bun side.
 *
 * The swap happens in the HTML *before* React inserts it, not by mutating the
 * rendered `<img>` nodes: React owns that subtree and rebuilds it whenever the
 * document re-renders, which silently discards any DOM edit made in an effect.
 */

const MAX_IMAGES_PER_DOCUMENT = 40;
/** Data URLs are heavy (up to 4 MB each), so the cache stays deliberately small. */
const MAX_CACHED_IMAGES = 24;

/** Absolute path → data URL, or null for "read failed / not an image". */
const cache = new Map<string, string | null>();
const inflight = new Map<string, Promise<string | null>>();

/** True for a markdown image src that must be read off disk rather than fetched. */
export function isDiskImageSrc(src: string): boolean {
	return Boolean(src) && !src.startsWith("//") && !/^[a-z][a-z0-9+.-]*:/i.test(src);
}

/**
 * Resolve a markdown image src to an absolute path. `baseDir` is the directory
 * of the document; a root-relative src (`/docs/shot.png`) resolves against
 * `rootDir` instead, which is how such links are meant inside a repo.
 */
export function resolveDiskImagePath(src: string, baseDir: string, rootDir?: string | null): string | null {
	const withoutSuffix = src.replace(/[?#].*$/, "");
	let target: string;
	try {
		target = decodeURIComponent(withoutSuffix);
	} catch {
		target = withoutSuffix;
	}
	if (!target || target.includes("\0")) return null;
	const rootRelative = target.startsWith("/");
	const base = rootRelative ? rootDir : baseDir;
	if (!base) return null;
	const segments = base.split("/").filter((part, index) => part || index === 0);
	for (const part of target.split("/")) {
		if (!part || part === ".") continue;
		if (part === "..") {
			if (segments.length > 1) segments.pop();
			continue;
		}
		segments.push(part);
	}
	const abs = segments.join("/");
	return abs.startsWith("/") ? abs : null;
}

function readImage(absPath: string): Promise<string | null> {
	const cached = cache.get(absPath);
	if (cached !== undefined) return Promise.resolve(cached);
	const pending = inflight.get(absPath);
	if (pending) return pending;
	const request = api.request
		.readFilePreview({ path: absPath })
		.then((result) => (result.kind === "image" ? result.dataUrl : null))
		.catch(() => null)
		.then((dataUrl) => {
			if (cache.size >= MAX_CACHED_IMAGES) {
				const oldest = cache.keys().next().value;
				if (oldest !== undefined) cache.delete(oldest);
			}
			cache.set(absPath, dataUrl);
			inflight.delete(absPath);
			return dataUrl;
		});
	inflight.set(absPath, request);
	return request;
}

const IMG_TAG = /<img\b[^>]*>/gi;
const SRC_ATTR = /\ssrc="([^"]*)"/i;

/** Disk-backed image sources of a rendered document, in document order, deduped. */
function collectDiskImageSrcs(html: string): string[] {
	const found: string[] = [];
	for (const tag of html.match(IMG_TAG) ?? []) {
		const src = SRC_ATTR.exec(tag)?.[1];
		if (!src || !isDiskImageSrc(src) || found.includes(src)) continue;
		found.push(src);
		if (found.length >= MAX_IMAGES_PER_DOCUMENT) break;
	}
	return found;
}

/**
 * Replace every disk-backed `<img src>` with what `resolved` knows about it:
 * a data URL once read, otherwise no src at all plus a state marker, so the
 * webview shows the alt text instead of a broken-image icon.
 */
function applyDiskImages(
	html: string,
	baseDir: string,
	rootDir: string | null | undefined,
	resolved: Record<string, string | null>,
): string {
	return html.replace(IMG_TAG, (tag) => {
		const match = SRC_ATTR.exec(tag);
		if (!match || !isDiskImageSrc(match[1])) return tag;
		const absPath = resolveDiskImagePath(match[1], baseDir, rootDir);
		const dataUrl = absPath ? resolved[absPath] : null;
		const state = dataUrl ? "loaded" : absPath && !(absPath in resolved) ? "loading" : "missing";
		const src = dataUrl ? ` src="${dataUrl}"` : "";
		return `${tag.slice(0, match.index)}${src} data-dev3-md-image="${state}" title="${match[1]}"${tag.slice(match.index + match[0].length)}`;
	});
}

/**
 * Rendered markdown HTML with repo-relative images swapped for data URLs read
 * off disk. Returns the HTML unchanged when there is no directory to resolve
 * against (no worktree) or the document has no disk-backed images.
 */
export function useDiskMarkdownImages(html: string, baseDir?: string | null, rootDir?: string | null): string {
	const srcs = useMemo(() => (baseDir ? collectDiskImageSrcs(html) : []), [html, baseDir]);
	const [resolved, setResolved] = useState<Record<string, string | null>>({});

	useEffect(() => {
		if (!baseDir || !srcs.length) return;
		let stale = false;
		for (const src of srcs) {
			const absPath = resolveDiskImagePath(src, baseDir, rootDir);
			if (!absPath) continue;
			void readImage(absPath).then((dataUrl) => {
				if (stale) return;
				setResolved((prev) => (absPath in prev && prev[absPath] === dataUrl ? prev : { ...prev, [absPath]: dataUrl }));
			});
		}
		return () => {
			stale = true;
		};
	}, [srcs, baseDir, rootDir]);

	return useMemo(
		() => (baseDir && srcs.length ? applyDiskImages(html, baseDir, rootDir, resolved) : html),
		[html, baseDir, rootDir, srcs, resolved],
	);
}
