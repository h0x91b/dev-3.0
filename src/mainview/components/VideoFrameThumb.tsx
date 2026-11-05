import { useEffect, useRef, useState, type ReactNode } from "react";
import { api } from "../rpc";
import { primeFirstFrame } from "../utils/video-first-frame";

const MAX_CONCURRENT_GRABS = 2;
/** A stalled stream gives its slot back rather than starving every tile behind it. */
const GRAB_TIMEOUT_MS = 15_000;
let activeGrabs = 0;
const waiting: Array<() => void> = [];

function acquireSlot(): Promise<() => void> {
	return new Promise((resolve) => {
		const grant = () => {
			activeGrabs++;
			let released = false;
			resolve(() => {
				if (released) return;
				released = true;
				activeGrabs--;
				waiting.shift()?.();
			});
		};
		if (activeGrabs < MAX_CONCURRENT_GRABS) grant();
		else waiting.push(grant);
	});
}

/** Drops the connection and the decoder; pausing alone keeps both alive. */
function releaseVideo(video: HTMLVideoElement): void {
	video.pause();
	video.removeAttribute("src");
	video.load();
}

interface VideoFrameThumbProps {
	/** Stored path of a shared clip, resolved to a streaming URL only once the tile is on screen. */
	path: string;
	/** Shown until the frame is captured, and for good if it never is. */
	fallback: ReactNode;
	/** Drawn over the frame, e.g. a play glyph that says it is a clip. */
	badge?: ReactNode;
	className?: string;
}

/**
 * First frame of a shared clip as a still: a hidden muted `<video>` seeks to its
 * first frame, the frame is copied onto a canvas, and the video is released, so
 * a rail of clips holds pixels instead of a decoder and connection each. Only
 * on-screen tiles load, two at a time.
 */
export default function VideoFrameThumb({ path, fallback, badge, className = "" }: VideoFrameThumbProps) {
	const hostRef = useRef<HTMLSpanElement>(null);
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const [visible, setVisible] = useState(typeof IntersectionObserver === "undefined");
	const [captured, setCaptured] = useState(false);

	useEffect(() => {
		const host = hostRef.current;
		if (visible || !host) return;
		const observer = new IntersectionObserver((entries) => {
			if (entries.some((entry) => entry.isIntersecting)) {
				setVisible(true);
				observer.disconnect();
			}
		});
		observer.observe(host);
		return () => observer.disconnect();
	}, [visible]);

	useEffect(() => {
		if (!visible) return;
		setCaptured(false);
		let done = false;
		let release: (() => void) | null = null;
		const video = document.createElement("video");
		video.muted = true;
		video.playsInline = true;
		video.preload = "metadata";
		let timer: ReturnType<typeof setTimeout> | undefined;
		const finish = () => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			releaseVideo(video);
			release?.();
		};
		video.addEventListener("loadedmetadata", () => primeFirstFrame(video));
		video.addEventListener("seeked", () => {
			const canvas = canvasRef.current;
			if (!done && canvas && video.videoWidth > 0) {
				canvas.width = video.videoWidth;
				canvas.height = video.videoHeight;
				try {
					canvas.getContext("2d")?.drawImage(video, 0, 0);
					setCaptured(true);
				} catch {
					// The fallback tile stays.
				}
			}
			finish();
		});
		video.addEventListener("error", finish);
		void acquireSlot().then(async (slot) => {
			release = slot;
			if (done) return slot();
			timer = setTimeout(finish, GRAB_TIMEOUT_MS);
			try {
				const media = await api.request.getSharedMediaUrl({ path });
				if (done || !media) return finish();
				video.src = media.url;
			} catch {
				finish();
			}
		});
		return finish;
	}, [visible, path]);

	return (
		<span ref={hostRef} className={`relative block h-full w-full ${className}`}>
			<canvas
				ref={canvasRef}
				aria-hidden="true"
				data-testid="video-frame-thumb"
				data-captured={captured ? "true" : undefined}
				className="h-full w-full object-cover"
				hidden={!captured}
			/>
			{!captured && fallback}
			{captured && badge}
		</span>
	);
}
