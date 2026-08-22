import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import type { Stats } from "node:fs";
import { basename, dirname, extname, isAbsolute, posix, relative, resolve as resolvePath, sep } from "node:path";
import type { SharedArtifact, SharedArtifactAsset } from "../shared/types";
import {
	MAX_SHARED_ARTIFACT_HTML_BYTES,
	MAX_SHARED_ARTIFACT_ASSET_BYTES,
	MAX_SHARED_ARTIFACT_ASSETS,
	SHARED_ARTIFACT_ASSET_EXTS,
} from "../shared/types";
import { artifactGroupKey } from "../shared/artifact-versions";
import { DEV3_HOME } from "./paths";
import { createZip } from "./zip";
import { projectSlug } from "./git";

const ASSET_EXTS = new Set(SHARED_ARTIFACT_ASSET_EXTS);
const MAX_TOTAL_ASSET_BYTES = 100 * 1024 * 1024;
const MIME_BY_EXT: Record<string, string> = {
	css: "text/css",
	js: "text/javascript",
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	bmp: "image/bmp",
};

const ARTIFACT_THEME_CONTRACT = `<style data-dev3-artifact-shell>
:root,[data-theme="dark"]{color-scheme:dark;--dev3-surface-base:6 9 21;--dev3-surface-raised:14 18 30;--dev3-surface-elevated:21 26 41;--dev3-text-primary:250 252 255;--dev3-text-secondary:170 187 212;--dev3-text-muted:82 98 121;--dev3-border:32 38 55;--dev3-accent:68 150 255;--dev3-success:74 222 128;--dev3-warning:250 204 21;--dev3-danger:255 130 130;--dev3-on-accent:255 255 255;--dev3-shadow:0 0 0}
[data-theme="light"]{color-scheme:light;--dev3-surface-base:240 242 250;--dev3-surface-raised:255 255 255;--dev3-surface-elevated:237 239 247;--dev3-text-primary:15 23 42;--dev3-text-secondary:71 85 105;--dev3-text-muted:148 163 184;--dev3-border:203 213 225;--dev3-accent:59 130 246;--dev3-success:22 163 74;--dev3-warning:202 138 4;--dev3-danger:220 38 38;--dev3-on-accent:255 255 255;--dev3-shadow:15 23 42}
@media(prefers-color-scheme:light){:root:not([data-theme]){color-scheme:light;--dev3-surface-base:240 242 250;--dev3-surface-raised:255 255 255;--dev3-surface-elevated:237 239 247;--dev3-text-primary:15 23 42;--dev3-text-secondary:71 85 105;--dev3-text-muted:148 163 184;--dev3-border:203 213 225;--dev3-accent:59 130 246;--dev3-success:22 163 74;--dev3-warning:202 138 4;--dev3-danger:220 38 38;--dev3-on-accent:255 255 255;--dev3-shadow:15 23 42}}
html{background:rgb(var(--dev3-surface-base));color:rgb(var(--dev3-text-primary));font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}body{margin:0}.dev3-card{background:rgb(var(--dev3-surface-raised));border:1px solid rgb(var(--dev3-border));border-radius:16px;padding:16px}.dev3-grid{display:grid;gap:16px}.dev3-muted{color:rgb(var(--dev3-text-secondary))}.dev3-accent{color:rgb(var(--dev3-accent))}
</style><script data-dev3-artifact-shell>(function(){function setTheme(theme){if(theme==='light'||theme==='dark')document.documentElement.dataset.theme=theme}window.addEventListener('message',function(event){if(event.data&&event.data.type==='dev3-artifact-theme')setTheme(event.data.theme)});if(!document.documentElement.dataset.theme)setTheme(matchMedia('(prefers-color-scheme: light)').matches?'light':'dark')})();</script>`;

/** Validation failure surfaced verbatim by the CLI socket handler. */
export class SharedArtifactError extends Error {}

function artifactRoot(projectPath: string): string {
	return `${DEV3_HOME}/worktrees/${projectSlug(projectPath)}/shared-artifacts`;
}

function safeBasename(path: string): string {
	const name = basename(path).replace(/[\0-\x1f\x7f]/g, "").slice(0, 120);
	if (!name || name === "." || name === "..") throw new SharedArtifactError(`Invalid file name: ${path}`);
	return name;
}

function assetNameFor(htmlPath: string, assetPath: string): string {
	const fromHtml = relative(dirname(htmlPath), assetPath);
	if (fromHtml && !isAbsolute(fromHtml) && fromHtml !== ".." && !fromHtml.startsWith(`..${sep}`)) {
		const segments = fromHtml.split(sep).map((segment) => safeBasename(segment));
		return segments.join("/");
	}
	throw new SharedArtifactError(`Artifact asset must be inside the HTML directory: ${assetPath}`);
}

function assertSourceFile(path: string): Stats {
	if (!isAbsolute(path) || path.split(/[\\/]/).includes("..")) {
		throw new SharedArtifactError(`Path must be absolute and free of "..": ${path}`);
	}
	if (!existsSync(path)) throw new SharedArtifactError(`File not found: ${path}`);
	const stat = statSync(path) as Stats;
	if (!stat.isFile()) throw new SharedArtifactError(`Not a file: ${path}`);
	return stat;
}

function base64DataUrl(mime: string, data: Uint8Array): string {
	const charset = mime.startsWith("text/") ? ";charset=utf-8" : "";
	return `data:${mime}${charset};base64,${Buffer.from(data).toString("base64")}`;
}

export function injectArtifactThemeContract(source: string): string {
	if (source.includes("data-dev3-artifact-shell")) return source;
	const headEnd = source.search(/<\/head\s*>/i);
	if (headEnd >= 0) return `${source.slice(0, headEnd)}${ARTIFACT_THEME_CONTRACT}${source.slice(headEnd)}`;
	const bodyStart = source.search(/<body(?:\s|>)/i);
	if (bodyStart >= 0) return `${source.slice(0, bodyStart)}${ARTIFACT_THEME_CONTRACT}${source.slice(bodyStart)}`;
	return `${ARTIFACT_THEME_CONTRACT}${source}`;
}

/**
 * Copy one HTML artifact plus optional local assets and build its ZIP bundle.
 *
 * One publish = one `shared-artifacts/<uuid>/` dir, unchanged by versioning:
 * grouping happens in the task record, never by reshaping the directory.
 */
export function saveSharedArtifact(
	projectPath: string,
	htmlPath: string,
	assetPaths: string[],
	title?: string,
	keyOptions?: { artifactId?: string; forceNew?: boolean },
): SharedArtifact {
	const htmlStat = assertSourceFile(htmlPath);
	if (extname(htmlPath).toLowerCase() !== ".html") {
		throw new SharedArtifactError(`Artifact must be an .html file: ${htmlPath}`);
	}
	if (htmlStat.size > MAX_SHARED_ARTIFACT_HTML_BYTES) {
		throw new SharedArtifactError(`HTML artifact is too large (max ${MAX_SHARED_ARTIFACT_HTML_BYTES / 1024 / 1024} MB)`);
	}
	if (assetPaths.length > MAX_SHARED_ARTIFACT_ASSETS) {
		throw new SharedArtifactError(`Too many artifact assets (max ${MAX_SHARED_ARTIFACT_ASSETS})`);
	}
	const seenNames = new Set<string>();
	let totalAssetBytes = 0;
	const validatedAssets = assetPaths.map((path) => {
		const stat = assertSourceFile(path);
		const name = assetNameFor(htmlPath, path);
		const ext = extname(name).replace(/^\./, "").toLowerCase();
		if (!ASSET_EXTS.has(ext)) throw new SharedArtifactError(`Unsupported artifact asset type "${ext || "(none)"}": ${path}`);
		if (stat.size > MAX_SHARED_ARTIFACT_ASSET_BYTES) throw new SharedArtifactError(`Artifact asset is too large: ${path}`);
		if (seenNames.has(name)) throw new SharedArtifactError(`Duplicate artifact asset name: ${name}`);
		seenNames.add(name);
		totalAssetBytes += stat.size;
		return { path, name, ext, stat };
	});
	if (totalAssetBytes > MAX_TOTAL_ASSET_BYTES) {
		throw new SharedArtifactError("Artifact assets exceed the 100 MB combined limit");
	}

	const id = crypto.randomUUID();
	const dir = `${artifactRoot(projectPath)}/${id}`;
	const htmlName = safeBasename(htmlPath);
	const storedPath = `${dir}/${htmlName}`;
	try {
		mkdirSync(dir, { recursive: true });
		const html = injectArtifactThemeContract(readFileSync(htmlPath, "utf8"));
		writeFileSync(storedPath, html, "utf8");
		const assets: SharedArtifactAsset[] = validatedAssets.map(({ path, name, ext, stat }) => {
			const assetPath = resolvePath(dir, name);
			mkdirSync(dirname(assetPath), { recursive: true });
			copyFileSync(path, assetPath);
			return { name, storedPath: assetPath, originalPath: path, mime: MIME_BY_EXT[ext], bytes: stat.size };
		});
		const baseTitle = htmlName.replace(/\.html$/i, "");
		const resolvedTitle = title?.trim() || baseTitle;
		// `--new` mints a key nothing can ever match, so the publish stands alone
		// while later plain publishes of the same title still group with each other.
		const groupKey = keyOptions?.forceNew
			? `new:${id}`
			: artifactGroupKey({ artifactId: keyOptions?.artifactId, title: resolvedTitle });
		const record: SharedArtifact = {
			id,
			groupKey,
			version: 1,
			isUnread: true,
			kind: "html",
			title: resolvedTitle,
			name: htmlName,
			storedPath,
			originalPath: htmlPath,
			bytes: Buffer.byteLength(html),
			createdAt: Date.now(),
			assets,
		};
		if (assets.length > 0) {
			const bundlePath = `${dir}/${baseTitle}.zip`;
			const zip = createZip([
				{ name: htmlName, data: new TextEncoder().encode(html) },
				...assets.map((asset) => ({ name: asset.name, data: new Uint8Array(readFileSync(asset.storedPath)) })),
			]);
			writeFileSync(bundlePath, zip);
			record.bundlePath = bundlePath;
			record.bundleBytes = zip.byteLength;
		}
		return record;
	} catch (error) {
		rmSync(dir, { recursive: true, force: true });
		if (error instanceof SharedArtifactError) throw error;
		throw new SharedArtifactError(error instanceof Error ? error.message : String(error));
	}
}

function assertStoredArtifactRecord(artifact: SharedArtifact): string {
	const worktreesRoot = `${resolvePath(DEV3_HOME, "worktrees")}${sep}`;
	const storedPath = resolvePath(artifact.storedPath);
	if (!isAbsolute(artifact.storedPath) || !storedPath.startsWith(worktreesRoot) || !storedPath.includes(`${sep}shared-artifacts${sep}`)) {
		throw new SharedArtifactError("Invalid stored artifact path");
	}
	const dir = dirname(storedPath);
	const artifactRoot = `${dir}${sep}`;
	for (const asset of artifact.assets) {
		if (!resolvePath(asset.storedPath).startsWith(artifactRoot)) throw new SharedArtifactError("Artifact asset escaped its directory");
	}
	if (artifact.bundlePath && dirname(resolvePath(artifact.bundlePath)) !== dir) {
		throw new SharedArtifactError("Artifact bundle escaped its directory");
	}
	return dir;
}

/**
 * The stored HTML path, validated. Handing it to the OS browser keeps the
 * artifact's relative asset references working — no data-URL rewriting needed.
 */
export function sharedArtifactHtmlPath(artifact: SharedArtifact): string {
	assertStoredArtifactRecord(artifact);
	if (!existsSync(artifact.storedPath)) throw new SharedArtifactError("Artifact file is missing");
	return artifact.storedPath;
}

/** Read HTML plus copied assets for the sandboxed renderer. */
export function loadSharedArtifactContent(artifact: SharedArtifact): {
	html: string;
	assets: Array<{ name: string; mime: string; dataUrl: string }>;
} {
	assertStoredArtifactRecord(artifact);
	const html = readFileSync(artifact.storedPath, "utf8");
	const assets = artifact.assets.map((asset) => {
		const data = readFileSync(asset.storedPath);
		return { name: asset.name, mime: asset.mime, data };
	});
	const assetsByName = new Map(assets.map((asset) => [asset.name, asset]));
	const renderedDataUrls = new Map<string, string>();
	const rendering = new Set<string>();

	const localAssetName = (ownerName: string, value: string): string | null => {
		if (/^(?:data:|blob:|https?:|\/\/|#)/i.test(value)) return null;
		const clean = value.split(/[?#]/, 1)[0];
		let decoded: string;
		try { decoded = decodeURIComponent(clean); } catch { decoded = clean; }
		return posix.normalize(posix.join(posix.dirname(ownerName), decoded));
	};

	const renderDataUrl = (name: string): string | undefined => {
		const cached = renderedDataUrls.get(name);
		if (cached) return cached;
		const asset = assetsByName.get(name);
		if (!asset) return undefined;
		if (asset.mime !== "text/css") {
			const dataUrl = base64DataUrl(asset.mime, asset.data);
			renderedDataUrls.set(name, dataUrl);
			return dataUrl;
		}
		if (rendering.has(name)) throw new SharedArtifactError(`Circular CSS @import: ${name}`);

		rendering.add(name);
		try {
			let css = asset.data.toString("utf8").replace(
				/@import\s+(["'])(.*?)\1/gi,
				(match, quote: string, value: string) => {
					const importedName = localAssetName(asset.name, value);
					const dataUrl = importedName ? renderDataUrl(importedName) : undefined;
					return dataUrl ? `@import ${quote}${dataUrl}${quote}` : match;
				},
			);
			css = css.replace(
				/url\(\s*(["']?)(.*?)\1\s*\)/gi,
				(match, quote: string, value: string) => {
					const referencedName = localAssetName(asset.name, value);
					const dataUrl = referencedName ? renderDataUrl(referencedName) : undefined;
					return dataUrl ? `url(${quote}${dataUrl}${quote})` : match;
				},
			);
			const dataUrl = base64DataUrl(asset.mime, Buffer.from(css));
			renderedDataUrls.set(name, dataUrl);
			return dataUrl;
		} finally {
			rendering.delete(name);
		}
	};

	return {
		html,
		assets: assets.map((asset) => ({
			name: asset.name,
			mime: asset.mime,
			dataUrl: renderDataUrl(asset.name)!,
		})),
	};
}

/** Strip control, separator and Windows-illegal characters so a title is a safe download stem. */
function sanitizeDownloadStem(raw: string): string {
	return (raw ?? "")
		.replace(/[\0-\x1f\x7f]/g, " ")
		.replace(/[<>:"/\\|?*]/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.replace(/^\.+/, "")
		.replace(/[.\s]+$/, "")
		.slice(0, 100)
		.trim();
}

/** Human-friendly download name from the artifact title, not the stored HTML basename. */
export function sharedArtifactDownloadName(artifact: SharedArtifact): string {
	const ext = artifact.bundlePath ? ".zip" : ".html";
	const fromTitle = sanitizeDownloadStem(artifact.title);
	const fallback = basename(artifact.name || artifact.storedPath).replace(/\.html$/i, "");
	return `${fromTitle || fallback || "artifact"}${ext}`;
}

/** Read the portable download: ZIP when assets exist, otherwise the HTML. */
export function loadSharedArtifactDownload(artifact: SharedArtifact): {
	fileName: string;
	mime: "application/zip" | "text/html";
	base64: string;
} {
	assertStoredArtifactRecord(artifact);
	const path = artifact.bundlePath ?? artifact.storedPath;
	return {
		fileName: sharedArtifactDownloadName(artifact),
		mime: artifact.bundlePath ? "application/zip" : "text/html",
		base64: readFileSync(path).toString("base64"),
	};
}
