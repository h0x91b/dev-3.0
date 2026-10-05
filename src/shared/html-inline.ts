import { dirname, extname, resolve as resolvePath } from "node:path";

/**
 * Fold an HTML document's local stylesheets, scripts, images and fonts into one
 * string. The engine behind `dev3 inline-html` and the app's standalone artifact
 * download; the caller decides which files exist through `read`, so the app can
 * restrict it to an artifact's own copied assets.
 */

/** Binary assets become base64 data URIs; SVG is inlined as text-ish base64 too. */
const BINARY_EXT = new Set([
	".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".ico", ".bmp",
	".woff", ".woff2", ".ttf", ".otf", ".eot", ".mp4", ".webm", ".mp3",
	".m4a", ".wav", ".ogg",
	".svg",
]);

const MIME_BY_EXT: Record<string, string> = {
	".css": "text/css",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".avif": "image/avif",
	".ico": "image/x-icon",
	".bmp": "image/bmp",
	".svg": "image/svg+xml",
	".woff": "font/woff",
	".woff2": "font/woff2",
	".ttf": "font/ttf",
	".otf": "font/otf",
	".eot": "application/vnd.ms-fontobject",
	".mp4": "video/mp4",
	".webm": "video/webm",
	".mp3": "audio/mpeg",
	".m4a": "audio/mp4",
	".wav": "audio/wav",
	".ogg": "audio/ogg",
};

/** A scheme, a protocol-relative URL or a bare fragment all resolve from the browser. */
const REMOTE = /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i;

export interface InlineRef {
	kind: string;
	ref: string;
	bytes?: number;
	resolved?: string;
}

export interface InlineState {
	inlined: InlineRef[];
	external: InlineRef[];
	missing: InlineRef[];
}

/** Bytes of a local file, or null when it does not exist (or is off limits). */
export type InlineFileReader = (absolutePath: string) => Uint8Array | null;

class MissingAsset extends Error {}

function isRemote(url: string): boolean {
	return !url || REMOTE.test(url) || url.startsWith("data:");
}

/** Drop query strings and fragments — they mean nothing on disk. */
function stripUrl(raw: string): string {
	return raw.split("?")[0].split("#")[0];
}

function decodePath(raw: string): string {
	try {
		return decodeURIComponent(raw);
	} catch {
		return raw;
	}
}

function attr(tag: string, name: string): string | null {
	const match = new RegExp(`\\b${name}\\s*=\\s*(['"])([\\s\\S]*?)\\1`, "i").exec(tag);
	return match ? match[2] : null;
}

function dataUri(path: string, bytes: Uint8Array): string {
	const mime = MIME_BY_EXT[extname(path).toLowerCase()] ?? "application/octet-stream";
	const charset = mime.startsWith("text/") ? ";charset=utf-8" : "";
	return `data:${mime}${charset};base64,${Buffer.from(bytes).toString("base64")}`;
}

/** Fold every local stylesheet, script, image and font into one HTML string. */
export function inlineHtmlSource(source: string, baseDir: string, read: InlineFileReader): { html: string; state: InlineState } {
	const state: InlineState = { inlined: [], external: [], missing: [] };

	const readLocal = (base: string, url: string, kind: string): { path: string; bytes: Uint8Array } => {
		const target = resolvePath(base, decodePath(stripUrl(url)));
		const bytes = read(target);
		if (!bytes) {
			state.missing.push({ kind, ref: url, resolved: target });
			throw new MissingAsset(url);
		}
		state.inlined.push({ kind, ref: url, bytes: bytes.byteLength, resolved: target });
		return { path: target, bytes };
	};

	const cssStack = new Set<string>();
	/** Rewrite `@import` and url(...) inside a stylesheet — nested sheets, fonts and background images. */
	const inlineCss = (css: string, cssDir: string): string => {
		const imported = css.replace(/@import\s+(?:url\(\s*)?(['"])([^'"]+)\1\s*\)?/gi, (whole, quote: string, rawUrl: string) => {
			const url = rawUrl.trim();
			if (isRemote(url)) {
				state.external.push({ kind: "css-import", ref: url });
				return whole;
			}
			try {
				const file = readLocal(cssDir, url, "css-import");
				// A cycle keeps the original reference instead of recursing forever.
				if (cssStack.has(file.path)) return whole;
				cssStack.add(file.path);
				try {
					const nested = inlineCss(Buffer.from(file.bytes).toString("utf-8"), dirname(file.path));
					return `@import ${quote}${dataUri(file.path, Buffer.from(nested))}${quote}`;
				} finally {
					cssStack.delete(file.path);
				}
			} catch {
				return whole;
			}
		});
		return imported.replace(/url\(\s*(['"]?)([^)'"]+)\1\s*\)/g, (whole, quote: string, rawUrl: string) => {
			const url = rawUrl.trim();
			if (isRemote(url)) {
				state.external.push({ kind: "css-url", ref: url });
				return whole;
			}
			try {
				const file = readLocal(cssDir, url, "css-url");
				return `url(${quote}${dataUri(file.path, file.bytes)}${quote})`;
			} catch {
				return whole;
			}
		});
	};

	let html = source.replace(/<link\b[^>]*>/gi, (tag) => {
		const rel = (attr(tag, "rel") ?? "").toLowerCase();
		const href = attr(tag, "href");
		if (!href || isRemote(href)) {
			if (href) state.external.push({ kind: "link", ref: href });
			return tag;
		}
		if (rel.includes("stylesheet")) {
			let file: { path: string; bytes: Uint8Array };
			try {
				file = readLocal(baseDir, href, "stylesheet");
			} catch {
				return tag;
			}
			cssStack.add(file.path);
			// A literal </style> inside the sheet would close the tag early.
			const css = inlineCss(Buffer.from(file.bytes).toString("utf-8"), dirname(file.path)).replaceAll("</style", "<\\/style");
			cssStack.delete(file.path);
			// Keep marker/media attributes: shell scripts select on them.
			const keep: string[] = [];
			if (/\bdata-dev3-artifact-shell\b/i.test(tag)) keep.push("data-dev3-artifact-shell");
			const media = attr(tag, "media");
			if (media) keep.push(`media="${media}"`);
			const open = keep.length > 0 ? `<style ${keep.join(" ")}>` : "<style>";
			return `${open}\n${css}\n</style>`;
		}
		if (rel.includes("icon")) {
			try {
				const file = readLocal(baseDir, href, "icon");
				return tag.replace(href, () => dataUri(file.path, file.bytes));
			} catch {
				return tag;
			}
		}
		return tag;
	});

	html = html.replace(/(<script\b[^>]*>)\s*<\/script>/gi, (whole, open: string) => {
		const src = attr(open, "src");
		if (!src) return whole;
		if (isRemote(src)) {
			state.external.push({ kind: "script", ref: src });
			return whole;
		}
		let file: { path: string; bytes: Uint8Array };
		try {
			file = readLocal(baseDir, src, "script");
		} catch {
			return whole;
		}
		// A literal </script> inside the source would close the tag early.
		const js = Buffer.from(file.bytes).toString("utf-8").replaceAll("</script", "<\\/script");
		const opening = open.replace(/\s*\bsrc\s*=\s*(['"])[\s\S]*?\1/i, "");
		return `${opening}\n${js}\n</script>`;
	});

	html = html.replace(/(\bsrc\s*=\s*)(['"])([^'"]+)\2/gi, (whole, prefix: string, quote: string, url: string) => {
		if (isRemote(url)) return whole;
		if (!BINARY_EXT.has(extname(stripUrl(url)).toLowerCase())) return whole;
		try {
			const file = readLocal(baseDir, url, "media");
			return `${prefix}${quote}${dataUri(file.path, file.bytes)}${quote}`;
		} catch {
			return whole;
		}
	});

	return { html, state };
}
