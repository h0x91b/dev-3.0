/**
 * Keep a ghostty terminal painting, whatever one frame does.
 *
 * ghostty-web's render loop schedules the next frame only after `render()`
 * returns and is private, so a single throw stops the terminal forever with no
 * way back (coder/ghostty-web#189). Worse, we have also seen a pane stop painting
 * with no exception at all — nothing in the logs, nothing to catch.
 *
 * This wraps `renderer.render` the way the cursor gate and the bidi view already
 * do, and does two things the vendor cannot do for us:
 *
 *  1. **Swallows a throwing frame.** Our wrapper returns normally, so the vendor's
 *     loop reaches its `requestAnimationFrame` and the terminal survives a bad
 *     frame instead of dying on it.
 *  2. **Notices a loop that stopped.** The vendor renders every frame whether or
 *     not anything changed, so a visible pane with no frames for seconds is a dead
 *     loop by definition — the only signal that catches the silent failures.
 */

export interface GuardableRenderer {
	render(
		buffer: unknown,
		forceAll?: boolean,
		viewportY?: number,
		scrollbackProvider?: unknown,
		scrollbarOpacity?: number,
	): void;
}

const ORIGINAL_RENDER = Symbol.for("dev3.terminalRenderGuard.originalRender");

type WrappedRenderer = GuardableRenderer & {
	[ORIGINAL_RENDER]?: GuardableRenderer["render"];
};

export interface RenderGuardOptions {
	/** A frame threw. `consecutive` counts frames that failed in a row. */
	onFrameError: (error: unknown, consecutive: number) => void;
	/** No frame arrived for `stallMs` while the document was visible. */
	onStalled: (msSinceLastFrame: number) => void;
	/** How long without a frame counts as dead. */
	stallMs?: number;
	/** How often to check. */
	checkIntervalMs?: number;
	now?: () => number;
	isVisible?: () => boolean;
	setInterval?: (fn: () => void, ms: number) => unknown;
	clearInterval?: (handle: unknown) => void;
}

export interface RenderGuard {
	framesPainted(): number;
	consecutiveErrors(): number;
	dispose(): void;
}

/** Frames stop entirely in a hidden window, so the watchdog only judges a visible one. */
export const DEFAULT_STALL_MS = 6000;
export const DEFAULT_CHECK_INTERVAL_MS = 2000;
/** Report the first failures, then only every Nth — a broken frame repeats at 60 fps. */
const ERROR_REPORT_STRIDE = 60;

export function installRenderGuard(renderer: GuardableRenderer, opts: RenderGuardOptions): RenderGuard {
	const target = renderer as WrappedRenderer;
	const now = opts.now ?? Date.now;
	const isVisible = opts.isVisible ?? (() => typeof document === "undefined" || document.visibilityState === "visible");
	const stallMs = opts.stallMs ?? DEFAULT_STALL_MS;
	const setTimer = opts.setInterval ?? ((fn: () => void, ms: number) => setInterval(fn, ms));
	const clearTimer = opts.clearInterval ?? ((handle: unknown) => clearInterval(handle as Parameters<typeof clearInterval>[0]));

	let frames = 0;
	let consecutive = 0;
	let lastFrameAt = now();
	// A window that just came back from hidden has legitimately painted nothing for
	// minutes; the clock starts again from the moment it can paint.
	let visibleSince = isVisible() ? lastFrameAt : null;
	let stallReported = false;

	if (!target[ORIGINAL_RENDER] && typeof renderer.render === "function") {
		const original = renderer.render;
		target[ORIGINAL_RENDER] = original;
		target.render = function guardedRender(
			buffer: unknown,
			forceAll?: boolean,
			viewportY?: number,
			scrollbackProvider?: unknown,
			scrollbarOpacity?: number,
		) {
			try {
				original.call(this, buffer, forceAll, viewportY, scrollbackProvider, scrollbarOpacity);
				frames += 1;
				consecutive = 0;
				lastFrameAt = now();
				stallReported = false;
			} catch (error) {
				consecutive += 1;
				if (consecutive <= 3 || consecutive % ERROR_REPORT_STRIDE === 0) {
					opts.onFrameError(error, consecutive);
				}
				// Deliberately not rethrown: the vendor's loop must reach its own
				// requestAnimationFrame, or this pane never paints again.
			}
		};
	}

	const handle = setTimer(() => {
		const tick = now();
		if (!isVisible()) {
			visibleSince = null;
			return;
		}
		if (visibleSince === null) {
			visibleSince = tick;
			return;
		}
		// Judge only the stretch this window was actually able to paint in.
		const quietFor = tick - Math.max(lastFrameAt, visibleSince);
		if (quietFor < stallMs || stallReported) return;
		stallReported = true;
		opts.onStalled(quietFor);
	}, opts.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS);

	return {
		framesPainted: () => frames,
		consecutiveErrors: () => consecutive,
		dispose() {
			clearTimer(handle);
			const original = target[ORIGINAL_RENDER];
			if (!original) return;
			target.render = original;
			delete target[ORIGINAL_RENDER];
		},
	};
}
