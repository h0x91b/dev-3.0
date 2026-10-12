/**
 * Hide the terminal cursor while the terminal is not the thing receiving input,
 * and stop the vendor repainting the cursor's row on every frame.
 *
 * ghostty-web has no public "unfocused cursor" concept: the renderer draws the
 * cursor whenever the buffer reports `visible` and its own blink phase is on.
 * So the gate lies to the renderer about one field — it hands `render()` a view
 * of the buffer whose `getCursor().visible` is false — instead of touching the
 * renderer's private cursor state.
 *
 * Idle cost. While `cursorBlink` is enabled the vendor repaints the cursor's row
 * on EVERY frame of its rAF loop (`if (cursorMoved || this.cursorBlink)`) and
 * redraws the cursor on top, although the blink phase flips only every 530 ms.
 * On WebKitGTK any canvas draw in a frame costs a repaint of the whole canvas,
 * so an idle terminal kept the web process at 100%+ of a core (issue #1949).
 * The gate draws only on frames where the drawn cursor changes (blink phase,
 * focus, DECTCEM, scrolled away, moved): it masks `cursorBlink` for the rest, and
 * skips `renderCursor` while the cursor's pixels are still on the canvas — no
 * repaint of its row and no scrollbar pass since it was last drawn.
 * Blinking itself must stay ON: turning it off is not how the cursor is hidden.
 */

/** The buffer field the gate rewrites; everything else is forwarded untouched. */
interface CursorReporter {
	getCursor(): { x: number; y: number; visible: boolean };
}

/** The renderer surface we wrap — structurally compatible with `CanvasRenderer`. */
interface GateableRenderer {
	render(
		buffer: CursorReporter,
		forceAll?: boolean,
		viewportY?: number,
		scrollbackProvider?: unknown,
		scrollbarOpacity?: number,
	): void;
}

/** `CanvasRenderer`'s private blink state: enabled, current phase, and shape. */
interface VendorCursorState {
	cursorBlink?: boolean;
	cursorVisible?: boolean;
	cursorStyle?: string;
}

const ORIGINAL_RENDER = Symbol.for("dev3.terminalCursorFocus.originalRender");
const ORIGINAL_DRAWS = Symbol.for("dev3.terminalCursorFocus.originalDraws");

/** Vendor draw calls the gate watches to know whether the cursor's pixels survived. */
const WATCHED_DRAWS = ["renderLine", "renderCursor", "renderScrollbar"] as const;
type WatchedDraw = (typeof WATCHED_DRAWS)[number];
type DrawFn = (...args: unknown[]) => unknown;

type WrappedRenderer = GateableRenderer & {
	[ORIGINAL_RENDER]?: GateableRenderer["render"];
	[ORIGINAL_DRAWS]?: Partial<Record<WatchedDraw, DrawFn>>;
};

export interface CursorVisibilityGate {
	/** `false` hides the cursor, `true` restores the terminal's own cursor. */
	setCursorVisible(visible: boolean): void;
	/** Restore the vendor's own render. Safe to call twice. */
	dispose(): void;
}

/**
 * A pass-through view of the buffer that reports the cursor as hidden.
 *
 * A Proxy rather than explicit forwarding: the buffer is ghostty's WASM terminal
 * and the renderer calls a growing set of optional methods on it, so enumerating
 * them here would silently drop whatever the next version adds. Methods are bound
 * to the target because it carries private fields.
 */
function hiddenCursorView<T extends CursorReporter>(inner: T): T {
	return new Proxy(inner, {
		get(target, prop, receiver) {
			if (prop === "getCursor") {
				return () => ({ ...target.getCursor(), visible: false });
			}
			const value = Reflect.get(target, prop, receiver);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

/**
 * Whether and where this frame draws the cursor, mirroring the vendor's own
 * condition. `null` when the buffer cannot say — the frame then paints as the
 * vendor would.
 */
function drawnCursor(
	vendor: VendorCursorState,
	buffer: CursorReporter,
	viewportY?: number,
): { key: string; row: number } | null {
	try {
		const cursor = buffer.getCursor();
		const drawn = (viewportY ?? 0) === 0 && cursor.visible && vendor.cursorVisible !== false;
		return { key: `${drawn}|${vendor.cursorStyle}|${cursor.x},${cursor.y}`, row: cursor.y };
	} catch {
		return null;
	}
}

export function installCursorVisibilityGate(renderer: GateableRenderer): CursorVisibilityGate {
	const target = renderer as WrappedRenderer;
	let cursorVisible = true;
	let innerBuffer: CursorReporter | null = null;
	let hiddenView: CursorReporter | null = null;
	/** What the previous frame left on the canvas; null forces the next repaint. */
	let lastDrawnCursor: string | null = null;
	let cursorRow = -1;
	/** The cursor's pixels may be gone: its row or the scrollbar strip was painted. */
	let cursorDamaged = true;
	let keepCursorPixels = false;

	if (!target[ORIGINAL_RENDER] && typeof renderer.render === "function") {
		const original = renderer.render;
		target[ORIGINAL_RENDER] = original;
		target.render = function gatedRender(
			buffer: CursorReporter,
			forceAll?: boolean,
			viewportY?: number,
			scrollbackProvider?: unknown,
			scrollbarOpacity?: number,
		) {
			let effective = buffer;
			if (!cursorVisible) {
				// The renderer is handed the same buffer object every frame; the view
				// is memoized so a repaint does not allocate a Proxy per frame.
				if (innerBuffer !== buffer) {
					innerBuffer = buffer;
					hiddenView = hiddenCursorView(buffer);
				}
				effective = hiddenView ?? buffer;
			}
			// Mirrors the vendor's own condition for drawing the cursor this frame.
			const vendor = this as unknown as VendorCursorState;
			const drawn = drawnCursor(vendor, effective, viewportY);
			const unchanged = drawn !== null && drawn.key === lastDrawnCursor;
			const maskBlink = vendor.cursorBlink === true && unchanged;
			lastDrawnCursor = drawn?.key ?? null;
			cursorRow = drawn?.row ?? -1;
			keepCursorPixels = unchanged;
			if (maskBlink) vendor.cursorBlink = false;
			try {
				original.call(this, effective, forceAll, viewportY, scrollbackProvider, scrollbarOpacity);
			} catch (err) {
				lastDrawnCursor = null;
				cursorDamaged = true;
				throw err;
			} finally {
				keepCursorPixels = false;
				if (maskBlink) vendor.cursorBlink = true;
			}
		};

		const draws = target as unknown as Record<WatchedDraw, DrawFn | undefined>;
		const originals: Partial<Record<WatchedDraw, DrawFn>> = {};
		for (const name of WATCHED_DRAWS) {
			const vendorDraw = draws[name];
			if (typeof vendorDraw !== "function") continue;
			originals[name] = vendorDraw;
			draws[name] = function watchedDraw(this: unknown, ...args: unknown[]) {
				if (name === "renderCursor") {
					if (keepCursorPixels && !cursorDamaged) return undefined;
					cursorDamaged = false;
				} else if (name === "renderScrollbar" || args[1] === cursorRow) {
					cursorDamaged = true;
				}
				return vendorDraw.apply(this, args);
			};
		}
		target[ORIGINAL_DRAWS] = originals;
	}

	return {
		setCursorVisible(visible: boolean) {
			cursorVisible = visible;
		},
		dispose() {
			const original = target[ORIGINAL_RENDER];
			if (!original) return;
			target.render = original;
			delete target[ORIGINAL_RENDER];
			const draws = target as unknown as Record<WatchedDraw, DrawFn | undefined>;
			for (const [name, vendorDraw] of Object.entries(target[ORIGINAL_DRAWS] ?? {})) {
				draws[name as WatchedDraw] = vendorDraw;
			}
			delete target[ORIGINAL_DRAWS];
		},
	};
}

export function isCursorVisibilityGateInstalled(renderer: GateableRenderer): boolean {
	return (renderer as WrappedRenderer)[ORIGINAL_RENDER] !== undefined;
}
