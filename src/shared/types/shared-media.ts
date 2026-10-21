import type { Task } from "./task";

/** Raster image extensions accepted by `dev3 show-image` (lowercase, no dot).
 * SVG is excluded on purpose — an inline data-URI SVG in the webview is an XSS
 * vector, and screenshots/renders are raster anyway. Shared by the CLI (early
 * validation) and the bun copy path (authoritative check). */
export const SHARED_IMAGE_EXTS: readonly string[] = ["png", "jpg", "jpeg", "gif", "webp", "bmp"];

/** Per-image size cap for `dev3 show-image` (bytes). */
export const MAX_SHARED_IMAGE_BYTES = 25 * 1024 * 1024;

/**
 * Per-file cap for `dev3 show-media` clips, video or audio (bytes; a file of
 * exactly this size passes). Clips never travel as base64: the viewer streams
 * them over HTTP with Range requests (`src/bun/shared-media-stream.ts`), so the
 * cap only bounds disk use.
 */
export const MAX_SHARED_MEDIA_BYTES = 300 * 1024 * 1024;

/** A byte cap as the whole-MiB figure the CLI and the app print ("300 MB"). */
export function formatMediaCap(bytes: number): string {
	return `${Math.floor(bytes / 1024 / 1024)} MB`;
}

/** Exact sizes for a too-large error — rounded MB would print "300 MB, max 300 MB" one byte over. */
export function mediaTooLargeDetail(size: number, cap: number): string {
	return `${size.toLocaleString("en-US")} bytes; max ${formatMediaCap(cap)} = ${cap.toLocaleString("en-US")} bytes`;
}

/** True for a {@link SharedImage} record that holds a `dev3 show-media` video. */
export function isSharedVideo(item: { mime: string }): boolean {
	return item.mime.startsWith("video/");
}

/** True for a {@link SharedImage} record that holds a `dev3 show-media` audio track. */
export function isSharedAudio(item: { mime: string }): boolean {
	return item.mime.startsWith("audio/");
}

/** A `dev3 show-media` clip, video or audio: streamed and played, never read as an image. */
export function isSharedClip(item: { mime: string }): boolean {
	return isSharedVideo(item) || isSharedAudio(item);
}

/** A task's shared images and clips as one oldest→newest history — what the viewer steps through. */
export function taskSharedMedia(task: Pick<Task, "sharedImages" | "sharedVideos" | "sharedAudio">): SharedImage[] {
	const clips = [...(task.sharedVideos ?? []), ...(task.sharedAudio ?? [])];
	if (clips.length === 0) return task.sharedImages ?? [];
	return [...(task.sharedImages ?? []), ...clips].sort((a, b) => a.createdAt - b.createdAt);
}

/** Max images accepted in a single `dev3 show-image` invocation. */
export const MAX_SHARED_IMAGES_PER_CALL = 20;

/** Maximum accepted HTML source size for `dev3 show-artifact` (bytes). */
export const MAX_SHARED_ARTIFACT_HTML_BYTES = 50 * 1024 * 1024;

/**
 * Video extensions `dev3 show-media` and a bundled artifact clip accept (lowercase,
 * no dot). MP4 and WebM only: they are the two containers every engine dev3 renders
 * in — WKWebView, Chromium and mobile Safari — decodes without a plugin or a
 * transcode step. A container is not a codec: the player still reports a track it
 * cannot decode.
 */
export const SHARED_VIDEO_EXTS: readonly string[] = ["mp4", "webm"];

/**
 * Audio extensions `dev3 show-media` and a bundled artifact track accept (lowercase,
 * no dot). All four were measured decoding in WKWebView (macOS 26) and Chromium; WebView2, WebKitGTK
 * and older WebKit are unverified, so the reference asks for an MP3 fallback next
 * to OGG. FLAC, Opus and AAC-in-ADTS stay out: transport would carry them, but
 * playback would depend on the engine.
 */
export const SHARED_AUDIO_EXTS: readonly string[] = ["mp3", "m4a", "wav", "ogg"];

/** Video plus audio: every extension that answers to the media caps below. */
export const SHARED_MEDIA_EXTS: readonly string[] = [...SHARED_VIDEO_EXTS, ...SHARED_AUDIO_EXTS];

/** Local asset extensions accepted by `dev3 show-artifact --assets`. */
export const SHARED_ARTIFACT_ASSET_EXTS: readonly string[] = ["css", "js", ...SHARED_IMAGE_EXTS, ...SHARED_MEDIA_EXTS];

/** Maximum local assets accepted by one `dev3 show-artifact --assets` call. */
export const MAX_SHARED_ARTIFACT_ASSETS = 40;

/** Per-file size cap for a local HTML artifact asset (bytes). */
export const MAX_SHARED_ARTIFACT_ASSET_BYTES = 25 * 1024 * 1024;

/**
 * Per-file cap for a bundled artifact video or audio track (bytes), tighter than
 * the generic asset cap. Every asset reaches the viewer as one base64 data URL
 * inside the composed document, so a clip costs about 1.34× its bytes in the RPC
 * payload and again in the document string — and it is paid on every open, not on
 * first play. 16 MB holds a ~12 s 1080p screen capture with room to spare while
 * keeping the worst-case single clip under ~22 MB of transport.
 */
export const MAX_SHARED_ARTIFACT_MEDIA_BYTES = 16 * 1024 * 1024;

/**
 * Combined cap for all bundled video and audio in one artifact (bytes). Sits below
 * {@link MAX_SHARED_ARTIFACT_MEDIA_BYTES} × the asset count on purpose: five
 * clips of the per-file maximum would be a 100 MB document nobody can open.
 */
export const MAX_SHARED_ARTIFACT_MEDIA_TOTAL_BYTES = 48 * 1024 * 1024;

/**
 * An image an agent surfaced to the human via `dev3 show-image`, bound to a task.
 * The source file is copied into the project's worktree `shared-images/` dir (next
 * to `uploads/`), so the record survives the original (often /tmp) file being
 * removed. Rendered in the {@link https://…|TaskImageViewer} lightbox with a
 * clickable history (newest activated first). Image bytes reach the webview via
 * the `readImageBase64` RPC (works in desktop and browser transports).
 * `dev3 show-media` clips use this same record — videos in `Task.sharedVideos`,
 * audio in `Task.sharedAudio` — and play in the same viewer, streamed via
 * `getSharedMediaUrl`; a `video/*` or `audio/*` {@link SharedImage.mime} marks
 * them ({@link isSharedClip}).
 */
export interface SharedImage {
	id: string;
	/** True until the user opens a viewer containing this image. Absent means read for legacy records. */
	isUnread?: boolean;
	/** Absolute path of the copied file under ~/.dev3.0/worktrees/<slug>/shared-images/. */
	storedPath: string;
	/** The path the agent originally passed (kept for provenance / tooltip). */
	originalPath: string;
	/** Basename of the original file. */
	name: string;
	mime: string;
	bytes: number;
	/** Optional batch caption from `dev3 show-image --caption`. */
	caption?: string;
	/** ms epoch when the image was shared. */
	createdAt: number;
}

/** One local asset copied beside a task-bound HTML artifact. */
export interface SharedArtifactAsset {
	/** Relative path preserved so references in HTML and CSS keep working. */
	name: string;
	storedPath: string;
	originalPath: string;
	mime: string;
	bytes: number;
}

/**
 * One published revision of an artifact. Holds every field that a publish
 * produces; the newest revision is the {@link SharedArtifact} record itself,
 * so this type only ever describes an older one.
 */
export interface SharedArtifactVersion {
	/** 1-based publish number, contiguous and renumbered when records collapse. */
	version: number;
	name: string;
	storedPath: string;
	originalPath: string;
	bytes: number;
	createdAt: number;
	assets: SharedArtifactAsset[];
	bundlePath?: string;
	bundleBytes?: number;
}

/**
 * The task's single Live Artifact: a page that is replaced in place (no versions)
 * plus a state store the page and the agent share (`dev3 live …`). `page` is an
 * ordinary stored artifact record, so every artifact reader renders it unchanged.
 * See `decisions/2026/10/21/live-artifact-per-task.md`.
 */
export interface LiveArtifact {
	page: SharedArtifact;
	/** Bumped on every publish or adopt, so open pages know to reload. */
	pageRev: number;
	createdAt: number;
	updatedAt: number;
}

/**
 * A task-bound HTML artifact surfaced via `dev3 show-artifact`.
 *
 * The stored HTML contains the stable dev3 artifact theme contract. When
 * `assets` is non-empty, `bundlePath` points at a portable ZIP containing the
 * HTML and every copied local asset at its relative path. The download hands
 * it over only when attachments need it; otherwise it folds everything into one
 * standalone HTML (`loadSharedArtifactDownload`).
 *
 * Re-publishing the same artifact adds a VERSION instead of a new record: the
 * top-level fields above always describe the newest version, while
 * `previousVersions` keeps the older ones. Records written before versioning
 * carry none of the three optional fields and read as a single version 1.
 * See `src/shared/artifact-versions.ts` for the helpers that project a version.
 */
export interface SharedArtifact {
	id: string;
	/**
	 * Identity a re-publish groups on: `id:<slug>` from `--artifact-id`, else
	 * `title:<normalized title>`. `--new` mints a unique key so nothing attaches.
	 */
	groupKey?: string;
	/** Version number of THIS record — the newest one. Absent means 1. */
	version?: number;
	/**
	 * Older versions, oldest→newest. Trimmed to `MAX_ARTIFACT_VERSIONS`; what the
	 * cap dropped is derived from `version` minus the retained count.
	 */
	previousVersions?: SharedArtifactVersion[];
	/** True until the user opens a viewer containing this artifact. Absent means read for legacy records. */
	isUnread?: boolean;
	kind: "html";
	title: string;
	name: string;
	storedPath: string;
	originalPath: string;
	bytes: number;
	createdAt: number;
	assets: SharedArtifactAsset[];
	bundlePath?: string;
	bundleBytes?: number;
}
