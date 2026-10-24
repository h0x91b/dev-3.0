import { useEffect, useRef, useState } from "react";
import { useT } from "../i18n";
import { api } from "../rpc";
import { errorText } from "../file-open-browser";
import { formatBytes } from "../utils/formatBytes";
import { fileLinkExt } from "../../shared/file-link-types";

interface FilePreviewMediaProps {
	path: string;
	fileName: string;
	media: "audio" | "video";
	mime: string;
	size: number;
	/** The dialog fills the screen, so the video may fill the body instead of capping at a share of it. */
	expanded: boolean;
	/** Nothing will play (unsupported or failed), so the host can shrink back to a notice. */
	onUnplayable: () => void;
}

type Playback =
	| { phase: "loading" }
	| { phase: "ready"; src: string }
	| { phase: "unsupported" }
	| { phase: "failed"; error?: string };

/** Whether this engine claims it can decode `mime` at all; "maybe" still has to survive the element's own error. */
export function enginePlays(media: "audio" | "video", mime: string): boolean {
	return document.createElement(media).canPlayType(mime) !== "";
}

/**
 * Native `<audio>`/`<video>` controls over a Range-served capability URL, so a
 * long file streams instead of crossing RPC. Never autoplays; unmounting or a
 * new path stops playback and drops the connection.
 */
export default function FilePreviewMedia({ path, fileName, media, mime, size, expanded, onUnplayable }: FilePreviewMediaProps) {
	const t = useT();
	const [playback, setPlayback] = useState<Playback>({ phase: "loading" });
	const [noVideoTrack, setNoVideoTrack] = useState(false);
	const elementRef = useRef<HTMLMediaElement | null>(null);
	const src = playback.phase === "ready" ? playback.src : null;
	const unplayable = playback.phase === "unsupported" || playback.phase === "failed";

	useEffect(() => {
		if (unplayable) onUnplayable();
	}, [unplayable, onUnplayable]);

	useEffect(() => {
		setNoVideoTrack(false);
		if (!enginePlays(media, mime)) {
			setPlayback({ phase: "unsupported" });
			return;
		}
		let stale = false;
		setPlayback({ phase: "loading" });
		api.request.getFileMediaUrl({ path }).then(
			(result) => { if (!stale) setPlayback({ phase: "ready", src: result.url }); },
			(err) => { if (!stale) setPlayback({ phase: "failed", error: errorText(err) }); },
		);
		return () => {
			stale = true;
		};
	}, [path, media, mime]);

	// Pausing alone keeps the connection and decoder alive; dropping `src` and reloading releases both.
	useEffect(() => {
		const element = elementRef.current;
		if (!element || !src) return;
		return () => {
			element.pause();
			element.removeAttribute("src");
			element.load();
		};
	}, [src]);

	const format = fileLinkExt(path).slice(1).toUpperCase();
	const meta = <p className="text-fg-muted text-xs tabular-nums">{format} · {formatBytes(size)}</p>;

	if (unplayable) {
		const message = playback.phase === "unsupported"
			? t("terminal.filePreviewMediaUnsupported", { format })
			: playback.error
				? t("terminal.filePreviewMediaStreamFailed", { error: playback.error })
				: t("terminal.filePreviewMediaFailed");
		return (
			<div className="p-6 flex flex-col gap-1" data-testid="file-preview-media-error" data-phase={playback.phase}>
				<p role="alert" className="text-fg-3 text-sm">{message}</p>
				{meta}
			</div>
		);
	}

	if (!src) {
		return <p className="text-fg-3 text-sm p-6" role="status">{t("terminal.filePreviewLoading")}</p>;
	}

	const common = {
		src,
		controls: true,
		preload: "metadata" as const,
		"aria-label": fileName,
		"data-testid": `file-preview-${media}`,
		onError: () => setPlayback({ phase: "failed" }),
	};

	return (
		<div className={`min-h-0 flex-1 flex flex-col items-center justify-center gap-2 p-4${media === "video" ? " overflow-auto" : ""}`}>
			{media === "video" ? (
				<video
					{...common}
					ref={(node) => { elementRef.current = node; }}
					playsInline
					// A file whose video codec the engine lacks still loads and plays its sound track.
					onLoadedMetadata={(event) => setNoVideoTrack(event.currentTarget.videoWidth === 0)}
					className={`block rounded bg-black ring-1 ring-fg/10 ${expanded ? "h-full w-full object-contain" : "max-w-full max-h-[70dvh]"}`}
				/>
			) : (
				<audio {...common} ref={(node) => { elementRef.current = node; }} className="w-full" />
			)}
			{noVideoTrack && <p role="status" className="text-fg-3 text-xs">{t("terminal.filePreviewMediaNoVideo")}</p>}
			{meta}
		</div>
	);
}
