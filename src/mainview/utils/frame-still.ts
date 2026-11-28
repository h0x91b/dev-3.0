import type { ReviewFramePoint } from "../../shared/review";

/** Wider frames are scaled down: the still is for reading spots, not for pixel-peeping. */
const MAX_STILL_WIDTH = 1920;
const STILL_TIMEOUT_MS = 5000;
/** How long to wait for a presented frame after the seek before drawing what is there. */
const PRESENT_FALLBACK_MS = 300;
const HAVE_CURRENT_DATA = 2;

/**
 * Draws numbered crosshairs onto a frame. Fixed colours on purpose: the PNG goes
 * to the agent, not into a themed UI, and must read the same on any frame.
 */
export function drawFramePoints(ctx: CanvasRenderingContext2D, width: number, height: number, points: readonly ReviewFramePoint[]): void {
	const unit = Math.max(10, width / 90);
	for (const point of points) {
		const x = point.x * width;
		const y = point.y * height;
		const arm = unit * 1.2;
		const gap = unit * 0.35;
		const segments: [number, number, number, number][] = [
			[x - arm, y, x - gap, y], [x + gap, y, x + arm, y],
			[x, y - arm, x, y - gap], [x, y + gap, x, y + arm],
		];
		ctx.lineCap = "round";
		for (const [stroke, lineWidth] of [["rgba(0,0,0,0.7)", unit * 0.45], ["#facc15", unit * 0.2]] as const) {
			ctx.strokeStyle = stroke;
			ctx.lineWidth = lineWidth;
			for (const [x1, y1, x2, y2] of segments) {
				ctx.beginPath();
				ctx.moveTo(x1, y1);
				ctx.lineTo(x2, y2);
				ctx.stroke();
			}
		}
		const radius = unit * 0.95;
		const cx = Math.min(width - radius, x + arm + radius * 0.4);
		const cy = Math.max(radius, y - arm - radius * 0.4);
		ctx.beginPath();
		ctx.arc(cx, cy, radius, 0, Math.PI * 2);
		ctx.fillStyle = "rgba(0,0,0,0.8)";
		ctx.fill();
		ctx.lineWidth = unit * 0.2;
		ctx.strokeStyle = "#facc15";
		ctx.stroke();
		ctx.fillStyle = "#ffffff";
		ctx.font = `bold ${Math.round(unit * 1.1)}px sans-serif`;
		ctx.textAlign = "center";
		ctx.textBaseline = "middle";
		ctx.fillText(String(point.n), cx, cy + unit * 0.05);
	}
}

/**
 * The frame at `time` of the clip at `url`, with the spots drawn, as base64 PNG.
 * A private CORS-mode copy of the clip is used, so the player on stage is never
 * switched to CORS. Null when the engine cannot decode or read back the frame.
 */
export function captureFrameStill(url: string, time: number, points: readonly ReviewFramePoint[]): Promise<string | null> {
	if (typeof document === "undefined") return Promise.resolve(null);
	const canvas = document.createElement("canvas");
	const ctx = canvas.getContext("2d");
	if (!ctx) return Promise.resolve(null);
	return new Promise((resolve) => {
		const video = document.createElement("video");
		let done = false;
		const finish = (result: string | null) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			video.removeAttribute("src");
			video.load();
			resolve(result);
		};
		const timer = setTimeout(() => finish(null), STILL_TIMEOUT_MS);
		video.crossOrigin = "anonymous";
		video.muted = true;
		video.playsInline = true;
		video.preload = "auto";
		video.addEventListener("loadedmetadata", () => { video.currentTime = time; }, { once: true });
		const draw = () => {
			if (done) return;
			const scale = Math.min(1, MAX_STILL_WIDTH / Math.max(1, video.videoWidth));
			canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
			canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
			try {
				ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
				drawFramePoints(ctx, canvas.width, canvas.height, points);
				finish(canvas.toDataURL("image/png").replace(/^data:image\/png;base64,/, ""));
			} catch {
				finish(null);
			}
		};
		// `seeked` alone is not enough: WebKit can still hold the previous (or no)
		// frame then. Draw once the frame is decoded and, where the engine says so,
		// presented; the timer covers an engine that presents nothing off-screen.
		const drawWhenPresented = () => {
			let drawn = false;
			const once = () => { if (!drawn) { drawn = true; draw(); } };
			if (typeof video.requestVideoFrameCallback === "function") video.requestVideoFrameCallback(() => once());
			setTimeout(once, PRESENT_FALLBACK_MS);
		};
		video.addEventListener("seeked", () => {
			if (video.readyState >= HAVE_CURRENT_DATA) drawWhenPresented();
			else video.addEventListener("canplay", drawWhenPresented, { once: true });
		}, { once: true });
		video.addEventListener("error", () => finish(null), { once: true });
		video.src = url;
	});
}
