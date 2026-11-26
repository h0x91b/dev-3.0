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
	/**
	 * A frame painted, and how long `render()` took. This is the outermost render
	 * wrapper, so it is the one place that sees every frame whatever the gates
	 * below it do — the latency probe hangs off it rather than adding a fourth
	 * wrapper that the bidi settings toggle could unhook.
	 */
	onFrame?: (durationMs: number) => void;
	/** How long without a frame counts as dead. */
	stallMs?: number;
	/** How often to check. */
	checkIntervalMs?: number;
	/**
	 * Safety cap on deferring paints while DEC mode 2026 (synchronized output)
	 * stays set, so a TUI that forgets to emit `CSI ? 2026 l` cannot freeze the pane.
	 */
	syncOutputTimeoutMs?: number;
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
/** DEC private mode 2026: synchronized output (`CSI ? 2026 h` … `CSI ? 2026 l`). */
const DEC_MODE_SYNC_OUTPUT = 2026;
/** Max time to defer painting while DEC mode 2026 remains active. */
export const DEFAULT_SYNC_OUTPUT_TIMEOUT_MS = 150;
/** Report the first failures, then only every Nth — a broken frame repeats at 60 fps. */
const ERROR_REPORT_STRIDE = 60;
/**
 * A check this many intervals late means timers were not running — a throttled
 * hidden stretch can pass with no tick at all, so the page cannot be trusted to
 * have been able to paint in that gap.
 */
const LATE_TICK_FACTOR = 2;

function isSynchronizedOutputActive(buffer: unknown): boolean {
	if (!buffer || typeof buffer !== "object") return false;
	const getMode = (buffer as { getMode?: (mode: number, isAnsi?: boolean) => boolean }).getMode;
	if (typeof getMode !== "function") return false;
	return Boolean(getMode.call(buffer, DEC_MODE_SYNC_OUTPUT));
}

export function installRenderGuard(renderer: GuardableRenderer, opts: RenderGuardOptions): RenderGuard {
	const target = renderer as WrappedRenderer;
	const now = opts.now ?? Date.now;
	const isVisible = opts.isVisible ?? (() => typeof document === "undefined" || document.visibilityState === "visible");
	const stallMs = opts.stallMs ?? DEFAULT_STALL_MS;
	const syncOutputTimeoutMs = opts.syncOutputTimeoutMs ?? DEFAULT_SYNC_OUTPUT_TIMEOUT_MS;
	const setTimer = opts.setInterval ?? ((fn: () => void, ms: number) => setInterval(fn, ms));
	const clearTimer = opts.clearInterval ?? ((handle: unknown) => clearInterval(handle as Parameters<typeof clearInterval>[0]));

	let frames = 0;
	let consecutive = 0;
	let lastFrameAt = now();
	// A window that just came back from hidden has legitimately painted nothing for
	// minutes; the clock starts again from the moment it can paint.
	let visibleSince = isVisible() ? lastFrameAt : null;
	let stallReported = false;
	let syncStartedAt: number | null = null;

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
			const startedAt = opts.onFrame ? performance.now() : 0;
			try {
				if (!forceAll && isSynchronizedOutputActive(buffer)) {
					const tick = now();
					if (syncStartedAt === null) syncStartedAt = tick;
					if (tick - syncStartedAt < syncOutputTimeoutMs) {
						// Loop is alive and deliberately holding paint until `CSI ? 2026 l`.
						lastFrameAt = tick;
						stallReported = false;
						return;
					}
				} else {
					syncStartedAt = null;
				}
				original.call(this, buffer, forceAll, viewportY, scrollbackProvider, scrollbarOpacity);
				frames += 1;
				consecutive = 0;
				lastFrameAt = now();
				stallReported = false;
				// After the frame, never before: a throwing frame painted nothing and
				// must not enter the distribution as a fast one.
				opts.onFrame?.(performance.now() - startedAt);
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

	const checkIntervalMs = opts.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS;
	let lastTickAt = lastFrameAt;

	const handle = setTimer(() => {
		const tick = now();
		const late = tick - lastTickAt > checkIntervalMs * LATE_TICK_FACTOR;
		lastTickAt = tick;
		if (!isVisible()) {
			visibleSince = null;
			return;
		}
		if (visibleSince === null || late) {
			visibleSince = tick;
			return;
		}
		// Judge only the stretch this window was actually able to paint in.
		const quietFor = tick - Math.max(lastFrameAt, visibleSince);
		if (quietFor < stallMs || stallReported) return;
		stallReported = true;
		opts.onStalled(quietFor);
	}, checkIntervalMs);

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
