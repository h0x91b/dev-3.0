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
import { basename, dirname, extname, isAbsolute, relative, resolve as resolvePath, sep } from "node:path";
import type { SharedArtifact, SharedArtifactAsset } from "../shared/types";
import {
	MAX_SHARED_ARTIFACT_HTML_BYTES,
	MAX_SHARED_ARTIFACT_IMAGES,
	MAX_SHARED_IMAGE_BYTES,
	SHARED_IMAGE_EXTS,
} from "../shared/types";
import { DEV3_HOME } from "./paths";
import { createLogger } from "./logger";
import { createStoreZip } from "./zip-store";
import { projectSlug } from "./git";

const log = createLogger("shared-artifacts");
const IMAGE_EXTS = new Set(SHARED_IMAGE_EXTS);
const MAX_TOTAL_ASSET_BYTES = 100 * 1024 * 1024;
const MIME_BY_EXT: Record<string, string> = {
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

function assetNameFor(htmlPath: string, imagePath: string): string {
	const fromHtml = relative(dirname(htmlPath), imagePath);
	if (fromHtml && !isAbsolute(fromHtml) && fromHtml !== ".." && !fromHtml.startsWith(`..${sep}`)) {
		const segments = fromHtml.split(sep).map((segment) => safeBasename(segment));
		return segments.join("/");
	}
	throw new SharedArtifactError(`Artifact image must be inside the HTML directory: ${imagePath}`);
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

export function injectArtifactThemeContract(source: string): string {
	if (source.includes("data-dev3-artifact-shell")) return source;
	const headEnd = source.search(/<\/head\s*>/i);
	if (headEnd >= 0) return `${source.slice(0, headEnd)}${ARTIFACT_THEME_CONTRACT}${source.slice(headEnd)}`;
	const bodyStart = source.search(/<body(?:\s|>)/i);
	if (bodyStart >= 0) return `${source.slice(0, bodyStart)}${ARTIFACT_THEME_CONTRACT}${source.slice(bodyStart)}`;
	return `${ARTIFACT_THEME_CONTRACT}${source}`;
}

/** Copy one HTML artifact plus optional raster assets and build its ZIP bundle. */
export function saveSharedArtifact(
	projectPath: string,
	htmlPath: string,
	imagePaths: string[],
	title?: string,
): SharedArtifact {
	const htmlStat = assertSourceFile(htmlPath);
	if (extname(htmlPath).toLowerCase() !== ".html") {
		throw new SharedArtifactError(`Artifact must be an .html file: ${htmlPath}`);
	}
	if (htmlStat.size > MAX_SHARED_ARTIFACT_HTML_BYTES) {
		throw new SharedArtifactError(`HTML artifact is too large (max ${MAX_SHARED_ARTIFACT_HTML_BYTES / 1024 / 1024} MB)`);
	}
	if (imagePaths.length > MAX_SHARED_ARTIFACT_IMAGES) {
		throw new SharedArtifactError(`Too many artifact images (max ${MAX_SHARED_ARTIFACT_IMAGES})`);
	}

	const seenNames = new Set<string>();
	let totalAssetBytes = 0;
	const validatedAssets = imagePaths.map((path) => {
		const stat = assertSourceFile(path);
		const name = assetNameFor(htmlPath, path);
		const ext = extname(name).replace(/^\./, "").toLowerCase();
		if (!IMAGE_EXTS.has(ext)) throw new SharedArtifactError(`Unsupported artifact image type "${ext || "(none)"}": ${path}`);
		if (stat.size > MAX_SHARED_IMAGE_BYTES) throw new SharedArtifactError(`Artifact image is too large: ${path}`);
		if (seenNames.has(name)) throw new SharedArtifactError(`Duplicate artifact image name: ${name}`);
		seenNames.add(name);
		totalAssetBytes += stat.size;
		return { path, name, ext, stat };
	});
	if (totalAssetBytes > MAX_TOTAL_ASSET_BYTES) {
		throw new SharedArtifactError("Artifact images exceed the 100 MB combined limit");
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
		const record: SharedArtifact = {
			id,
			kind: "html",
			title: title?.trim() || baseTitle,
			name: htmlName,
			storedPath,
			originalPath: htmlPath,
			bytes: Buffer.byteLength(html),
			createdAt: Date.now(),
			assets,
		};
		if (assets.length > 0) {
			const bundlePath = `${dir}/${baseTitle}.zip`;
			const zip = createStoreZip([
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

export function pruneSharedArtifacts(
	existing: SharedArtifact[] | undefined,
	incoming: SharedArtifact[],
	cap: number,
): { kept: SharedArtifact[]; dropped: SharedArtifact[] } {
	const all = [...(existing ?? []), ...incoming];
	if (all.length <= cap) return { kept: all, dropped: [] };
	return { kept: all.slice(all.length - cap), dropped: all.slice(0, all.length - cap) };
}

export function deleteSharedArtifactFiles(artifacts: SharedArtifact[]): void {
	for (const artifact of artifacts) {
		try {
			rmSync(dirname(artifact.storedPath), { recursive: true, force: true });
		} catch (error) {
			log.debug("Failed to delete pruned artifact", { path: artifact.storedPath, error: String(error) });
		}
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

/** Read HTML plus copied assets for the sandboxed renderer. */
export function loadSharedArtifactContent(artifact: SharedArtifact): {
	html: string;
	assets: Array<{ name: string; mime: string; dataUrl: string }>;
} {
	assertStoredArtifactRecord(artifact);
	const html = readFileSync(artifact.storedPath, "utf8");
	const assets = artifact.assets.map((asset) => ({
		name: asset.name,
		mime: asset.mime,
		dataUrl: `data:${asset.mime};base64,${readFileSync(asset.storedPath).toString("base64")}`,
	}));
	return { html, assets };
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
