import { SHARED_AUDIO_EXTS, SHARED_MEDIA_EXTS, SHARED_VIDEO_EXTS } from "../shared/types";

const SUPPORTED = new Set(SHARED_MEDIA_EXTS);

const VIDEO_LIKE = new Set([...SHARED_VIDEO_EXTS, "m4v", "mov", "avi", "mkv", "wmv", "mpg", "mpeg", "3gp", "ogv"]);
/** Media an author plausibly points a player or a download link at, supported or not. */
const MEDIA_LIKE = new Set([
	...SHARED_MEDIA_EXTS, ...VIDEO_LIKE,
	"aac", "oga", "opus", "flac", "weba", "aif", "aiff", "caf", "wma", "mka",
]);

const TAG = /<(audio|video|source|a)\b([^>]*)>/gi;
const ATTR = /\s(src|href)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi;
const REMOTE = /^(?:[a-z][a-z0-9+.-]*:|\/\/|#|\/)/i;

/** Asset-name key for a relative reference: `undefined` when it is not local, `null` when it climbs out. */
function localKey(raw: string): string | null | undefined {
	const clean = raw.trim().split(/[?#]/, 1)[0];
	if (!clean || REMOTE.test(clean)) return undefined;
	let decoded = clean;
	try { decoded = decodeURIComponent(clean); } catch { /* keep the raw text */ }
	const segments: string[] = [];
	for (const segment of decoded.split("/")) {
		if (!segment || segment === ".") continue;
		if (segment === "..") {
			if (!segments.length) return null;
			segments.pop();
			continue;
		}
		segments.push(segment);
	}
	return segments.join("/") || undefined;
}

/**
 * Local audio/video references in the report's own markup — player sources and
 * links — that would reach the viewer as a broken player: an unsupported format,
 * a file that was not bundled, or a path outside the report directory. Returns
 * one actionable line per reference; data:, blob:, http(s) and other scheme URLs
 * are never touched. Scripts, styles and comments are skipped, so a path a report
 * builds at runtime is the author's to route through `dev3Artifact.asset()`.
 */
export function unplayableMediaReferences(html: string, bundledNames: ReadonlySet<string>): string[] {
	const markup = html.replace(/<!--[\s\S]*?-->/g, "").replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, "");
	const problems = new Map<string, string>();
	for (const [, tag, attrs] of markup.matchAll(TAG)) {
		const wanted = tag.toLowerCase() === "a" ? "href" : "src";
		for (const [, name, doubleQuoted, singleQuoted, bare] of attrs.matchAll(ATTR)) {
			if (name.toLowerCase() !== wanted) continue;
			const raw = (doubleQuoted ?? singleQuoted ?? bare ?? "").trim();
			const ext = /\.([a-z0-9]+)$/i.exec(raw.split(/[?#]/, 1)[0])?.[1]?.toLowerCase();
			if (!ext || !MEDIA_LIKE.has(ext) || problems.has(raw)) continue;
			const key = localKey(raw);
			if (key === undefined || (key !== null && bundledNames.has(key))) continue;
			if (key === null) {
				problems.set(raw, `${raw}: points outside the report directory — move the file under it and publish the directory`);
			} else if (!SUPPORTED.has(ext)) {
				const converted = key.replace(/\.[a-z0-9]+$/i, VIDEO_LIKE.has(ext) ? ".mp4" : ".mp3");
				problems.set(raw, `${raw}: .${ext} is not a supported artifact media type (audio: ${SHARED_AUDIO_EXTS.join(", ")}; video: ${SHARED_VIDEO_EXTS.join(", ")}) — convert it, e.g. ffmpeg -i "${key}" "${converted}", and point the tag at the new file`);
			} else {
				problems.set(raw, `${raw}: not bundled — keep the file under the report directory and publish the directory, or pass it after --assets`);
			}
		}
	}
	return [...problems.values()];
}
