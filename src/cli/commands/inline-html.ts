import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, extname, join, resolve as resolvePath } from "node:path";
import {
	CLI_EXIT_CODE_ARTIFACT_ASSET_MISSING,
	CLI_EXIT_CODE_ARTIFACT_SECRET_FOUND,
	CLI_EXIT_CODE_SUCCESS,
} from "../../shared/cli-exit-codes";
import { resolveValue } from "../args";
import { exitUsage } from "../output";

/** Binary assets become base64 data URIs; SVG is inlined as text-ish base64 too. */
const BINARY_EXT = new Set([
	".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".ico", ".bmp",
	".woff", ".woff2", ".ttf", ".otf", ".eot", ".mp4", ".webm", ".mp3",
	".svg",
]);

const MIME_BY_EXT: Record<string, string> = {
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
};

/** A scheme, a protocol-relative URL or a bare fragment all resolve from the browser. */
const REMOTE = /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i;

/** Credentials must never reach a public URL. Everything else is a soft warning. */
const SECRET_PATTERNS: Array<[string, RegExp]> = [
	["github token", /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g],
	["github pat", /\bgithub_pat_[A-Za-z0-9_]{20,}/g],
	["openai/anthropic key", /\bsk-[A-Za-z0-9-]{20,}/g],
	["aws key id", /\bAKIA[0-9A-Z]{16}\b/g],
	["private key block", /-----BEGIN [A-Z ]*PRIVATE KEY-----/g],
];

const LEAK_PATTERNS: Array<[string, RegExp]> = [
	["home path", /\/(?:Users|home)\/[A-Za-z0-9._-]+/g],
	["windows user path", /[A-Za-z]:\\Users\\[A-Za-z0-9._-]+/g],
	["email", /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g],
	["tunnel url", /https?:\/\/[A-Za-z0-9.-]+\.(?:trycloudflare\.com|ngrok[a-z.-]*|loca\.lt)\b/g],
];

const MAX_REPORTED_LEAKS = 25;

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

export interface InlineReport extends InlineState {
	input: string;
	output: string;
	bytes: number;
	secrets: Array<{ kind: string; sample: string }>;
	possibleLeaks: Array<{ kind: string; value: string }>;
	error?: string;
}

class MissingAsset extends Error {}

function isRemote(url: string): boolean {
	return !url || REMOTE.test(url) || url.startsWith("data:");
}

/** Drop query strings and fragments — they mean nothing on disk. */
function stripUrl(raw: string): string {
	return raw.split("?")[0].split("#")[0];
}

function dataUri(path: string): string {
	const ext = extname(path).toLowerCase();
	const mime = MIME_BY_EXT[ext] ?? "application/octet-stream";
	return `data:${mime};base64,${readFileSync(path).toString("base64")}`;
}

function readLocal(base: string, url: string, kind: string, state: InlineState): string {
	const target = resolvePath(base, stripUrl(url));
	if (!existsSync(target) || !statSync(target).isFile()) {
		state.missing.push({ kind, ref: url, resolved: target });
		throw new MissingAsset(url);
	}
	state.inlined.push({ kind, ref: url, bytes: statSync(target).size });
	return target;
}

function attr(tag: string, name: string): string | null {
	const match = new RegExp(`\\b${name}\\s*=\\s*(['"])([\\s\\S]*?)\\1`, "i").exec(tag);
	return match ? match[2] : null;
}

/** Rewrite url(...) inside a stylesheet — fonts and background images. */
function inlineCssUrls(css: string, cssDir: string, state: InlineState): string {
	return css.replace(/url\(\s*(['"]?)([^)'"]+)\1\s*\)/g, (whole, quote: string, rawUrl: string) => {
		const url = rawUrl.trim();
		if (isRemote(url)) {
			state.external.push({ kind: "css-url", ref: url });
			return whole;
		}
		try {
			return `url(${quote}${dataUri(readLocal(cssDir, url, "css-url", state))}${quote})`;
		} catch {
			return whole;
		}
	});
}

/** Fold every local stylesheet, script, image and font into one HTML string. */
export function inlineHtml(htmlPath: string): { html: string; state: InlineState } {
	const base = dirname(htmlPath);
	const state: InlineState = { inlined: [], external: [], missing: [] };
	let html = readFileSync(htmlPath, "utf-8");

	html = html.replace(/<link\b[^>]*>/gi, (tag) => {
		const rel = (attr(tag, "rel") ?? "").toLowerCase();
		const href = attr(tag, "href");
		if (!href || isRemote(href)) {
			if (href) state.external.push({ kind: "link", ref: href });
			return tag;
		}
		if (rel.includes("stylesheet")) {
			let target: string;
			try {
				target = readLocal(base, href, "stylesheet", state);
			} catch {
				return tag;
			}
			const css = inlineCssUrls(readFileSync(target, "utf-8"), dirname(target), state);
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
				return tag.replace(href, dataUri(readLocal(base, href, "icon", state)));
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
		let target: string;
		try {
			target = readLocal(base, src, "script", state);
		} catch {
			return whole;
		}
		// A literal </script> inside the source would close the tag early.
		const js = readFileSync(target, "utf-8").replaceAll("</script", "<\\/script");
		const opening = open.replace(/\s*\bsrc\s*=\s*(['"])[\s\S]*?\1/i, "");
		return `${opening}\n${js}\n</script>`;
	});

	html = html.replace(/(\bsrc\s*=\s*)(['"])([^'"]+)\2/gi, (whole, prefix: string, quote: string, url: string) => {
		if (isRemote(url)) return whole;
		if (!BINARY_EXT.has(extname(stripUrl(url)).toLowerCase())) return whole;
		try {
			return `${prefix}${quote}${dataUri(readLocal(base, url, "media", state))}${quote}`;
		} catch {
			return whole;
		}
	});

	return { html, state };
}

/** Credential hits block publishing; leak hits are reported and deduped. */
export function scanForSecrets(text: string): {
	secrets: Array<{ kind: string; sample: string }>;
	possibleLeaks: Array<{ kind: string; value: string }>;
} {
	const secrets: Array<{ kind: string; sample: string }> = [];
	for (const [kind, pattern] of SECRET_PATTERNS) {
		for (const match of text.matchAll(pattern)) {
			secrets.push({ kind, sample: `${match[0].slice(0, 12)}…` });
		}
	}

	const seen = new Set<string>();
	const possibleLeaks: Array<{ kind: string; value: string }> = [];
	for (const [kind, pattern] of LEAK_PATTERNS) {
		for (const match of text.matchAll(pattern)) {
			if (seen.has(match[0])) continue;
			seen.add(match[0]);
			possibleLeaks.push({ kind, value: match[0] });
		}
	}

	return { secrets, possibleLeaks: possibleLeaks.slice(0, MAX_REPORTED_LEAKS) };
}

function expandHome(path: string): string {
	if (path === "~") return homedir();
	if (path.startsWith("~/") || path.startsWith("~\\")) return join(homedir(), path.slice(2));
	return path;
}

/**
 * `dev3 inline-html <index.html|dir> -o out.html [--json] [--quiet]`.
 *
 * Needs no socket: it is a pure file transform an agent runs before publishing a
 * report (gists and preview services serve one text file at a time).
 */
export async function handleInlineHtml(argv: string[]): Promise<void> {
	let input = "";
	let output = "";
	let json = false;
	let quiet = false;

	for (let i = 0; i < argv.length; i++) {
		const token = argv[i];
		if (token === "--json") {
			json = true;
			continue;
		}
		if (token === "--quiet") {
			quiet = true;
			continue;
		}
		if (token === "-o" || token === "--output") {
			const next = argv[i + 1];
			if (!next || next.startsWith("--")) exitUsage("-o/--output requires a value");
			output = resolveValue(next);
			i += 1;
			continue;
		}
		if (token.startsWith("--output=")) {
			output = resolveValue(token.slice("--output=".length));
			continue;
		}
		if (token.startsWith("-")) exitUsage(`Unknown flag: ${token}`);
		if (input) exitUsage(`Unexpected path: ${token}. One input only.`);
		input = resolveValue(token);
	}

	if (!input || !output) {
		exitUsage("Usage: dev3 inline-html <index.html|dir> -o <out.html> [--json] [--quiet]");
	}

	let source = resolvePath(process.cwd(), expandHome(input));
	if (existsSync(source) && statSync(source).isDirectory()) source = join(source, "index.html");
	if (!existsSync(source) || !statSync(source).isFile()) exitUsage(`No such file: ${source}`);

	const target = resolvePath(process.cwd(), expandHome(output));
	const { html, state } = inlineHtml(source);
	const { secrets, possibleLeaks } = scanForSecrets(html);

	const report: InlineReport = {
		input: source,
		output: target,
		bytes: Buffer.byteLength(html, "utf-8"),
		inlined: state.inlined,
		external: state.external,
		missing: state.missing,
		secrets,
		possibleLeaks,
	};

	// Both refusals print the full report so the agent can name the cause without
	// a second run, and neither writes the file.
	if (state.missing.length > 0) {
		report.error = "missing local files — the page would render broken";
		process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
		process.exit(CLI_EXIT_CODE_ARTIFACT_ASSET_MISSING);
	}
	if (secrets.length > 0) {
		report.error = "credential-looking string found — do not publish";
		process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
		process.exit(CLI_EXIT_CODE_ARTIFACT_SECRET_FOUND);
	}

	mkdirSync(dirname(target), { recursive: true });
	writeFileSync(target, html, "utf-8");

	if (json) {
		process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
	} else if (!quiet) {
		process.stdout.write(`wrote ${target} (${report.bytes.toLocaleString("en-US")} bytes)\n`);
		process.stdout.write(`  inlined:  ${state.inlined.length}\n`);
		process.stdout.write(`  external: ${state.external.length} (left as-is)\n`);
		for (const ref of state.external) process.stdout.write(`    - ${ref.ref}\n`);
		// Say "clean" out loud: silence would read as "the scan never ran".
		process.stdout.write("  secrets:  none found\n");
		if (possibleLeaks.length > 0) {
			process.stdout.write(`  possible leaks: ${possibleLeaks.length} — review before making it public\n`);
			for (const leak of possibleLeaks.slice(0, 10)) {
				process.stdout.write(`    - ${leak.kind}: ${leak.value}\n`);
			}
		} else {
			process.stdout.write("  possible leaks: none found (no home paths, emails or tunnel URLs)\n");
		}
	}

	process.exit(CLI_EXIT_CODE_SUCCESS);
}
