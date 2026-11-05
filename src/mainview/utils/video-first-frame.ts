/**
 * Past the first sample, so the engine has to decode a frame to show. WebKit
 * (WKWebView, Safari) stops a `preload="metadata"` video at HAVE_METADATA and
 * paints black until play; a seek is what makes it fetch and decode frame one.
 */
export const FIRST_FRAME_TIME = 0.001;

/** `onLoadedMetadata` for a paused, untouched video: seek a hair forward so its first frame paints. */
export function primeFirstFrame(video: HTMLVideoElement): void {
	if (!video.paused || video.currentTime !== 0 || video.videoWidth === 0) return;
	try {
		video.currentTime = FIRST_FRAME_TIME;
	} catch {
		// A non-seekable stream keeps the black stage, same as before.
	}
}
