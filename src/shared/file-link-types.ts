/**
 * What a browser tab can show for a file handed over through a `/file/` link.
 * The server's Content-Type and the renderer's "Open in new tab or download"
 * choice both read this one table, so they cannot drift apart.
 */

const TEXT = "text/plain; charset=utf-8";

/** Content-Type per lower-case extension; anything absent is sniffed (text or binary) by the server. */
export const FILE_LINK_CONTENT_TYPES: Readonly<Record<string, string>> = {
	".html": "text/html; charset=utf-8",
	".htm": "text/html; charset=utf-8",
	".xhtml": "application/xhtml+xml; charset=utf-8",
	".svg": "image/svg+xml",
	".md": "text/markdown; charset=utf-8",
	".markdown": "text/markdown; charset=utf-8",
	".txt": TEXT,
	".log": TEXT,
	".csv": TEXT,
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
	".m4v": "video/mp4",
	".webm": "video/webm",
	".mov": "video/quicktime",
	".mp3": "audio/mpeg",
	".m4a": "audio/mp4",
	".aac": "audio/aac",
	".wav": "audio/wav",
	".flac": "audio/flac",
	".ogg": "audio/ogg",
	".oga": "audio/ogg",
	".opus": "audio/ogg",
	".woff": "font/woff",
	".woff2": "font/woff2",
	".ttf": "font/ttf",
	".otf": "font/otf",
};

/**
 * Files the in-app preview plays through `<audio>`/`<video>`, streamed from a
 * `/file/` link rather than read over RPC. Whether the engine can decode one is
 * asked at runtime (`canPlayType` + the element's error), never promised here.
 */
export function previewMediaKind(path: string): "audio" | "video" | null {
	const type = FILE_LINK_CONTENT_TYPES[fileLinkExt(path)] ?? "";
	return type.startsWith("audio/") ? "audio" : type.startsWith("video/") ? "video" : null;
}

/** Pages whose relative CSS/images/scripts need the link to cover their folder. */
export const FILE_LINK_PAGE_EXTS: ReadonlySet<string> = new Set([".html", ".htm", ".xhtml", ".svg"]);

/**
 * What a page loads — never data such as `.txt`, `.json`, `.md`, `.log`, keys or
 * unknown types. Gitignored files ride along under a page's own ignore rule only
 * if they are of these types, so a page written into `tmp/` cannot expose secrets there.
 */
export const PAGE_ASSET_EXTS: ReadonlySet<string> = new Set([
	...FILE_LINK_PAGE_EXTS, ".css", ".js", ".mjs",
	".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".bmp", ".ico",
	".woff", ".woff2", ".ttf", ".otf", ".mp4", ".webm", ".mp3", ".wav", ".ogg",
]);

/** Never rendered on the dev3 origin, only sent as a download: a PDF viewer cannot run sandboxed. */
export const ATTACHMENT_ONLY_EXTS: ReadonlySet<string> = new Set([".pdf"]);

/** Assets a page loads rather than files a user opens, plus the download-only types. */
const NOT_OPENED_IN_TAB = new Set([".css", ".js", ".mjs", ".woff", ".woff2", ".ttf", ".otf", ".ico", ...ATTACHMENT_ONLY_EXTS]);

/** Extensions a tab displays rather than downloads. */
export const TAB_VIEWABLE_EXTS: ReadonlySet<string> = new Set(
	Object.keys(FILE_LINK_CONTENT_TYPES).filter((ext) => !NOT_OPENED_IN_TAB.has(ext)),
);

/**
 * Documents and media that open safely with their Windows default app. An
 * allowlist on purpose: the default verb RUNS scripts and programs, and CSV/PDF
 * open in apps that run formulas or document script (Excel, Acrobat).
 */
export const WINDOWS_OPEN_SAFE_EXTS: ReadonlySet<string> = new Set([
	".html", ".htm", ".svg", ".md", ".markdown", ".txt", ".log", ".json",
	".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".bmp", ".mp4", ".webm", ".mp3", ".wav", ".ogg",
	".m4v", ".mov", ".m4a", ".aac", ".flac", ".oga", ".opus",
]);

/** Lower-case extension including the dot, or "" — works on POSIX and Windows paths alike. */
export function fileLinkExt(path: string): string {
	const name = path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
	const dot = name.lastIndexOf(".");
	return dot > 0 ? name.slice(dot).toLowerCase() : "";
}
