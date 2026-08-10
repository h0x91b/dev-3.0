/**
 * Hide the terminal cursor while the terminal is not the thing receiving input.
 *
 * ghostty-web has no public "unfocused cursor" concept: the renderer draws the
 * cursor whenever the buffer reports `visible` and its own blink phase is on.
 * So the gate lies to the renderer about one field — it hands `render()` a view
 * of the buffer whose `getCursor().visible` is false — instead of touching the
 * renderer's private cursor state.
 *
 * Why the cursor disappears within one frame, with no forced repaint: while
 * `cursorBlink` is enabled the renderer repaints the cursor's row on EVERY frame
 * of its rAF loop (`if (cursorMoved || this.cursorBlink)`), then draws the cursor
 * on top. Flipping the flag therefore drops the cursor on the next frame — which
 * is also why the caller must NOT disable blinking to "stop" the cursor: that
 * kills the per-frame row repaint and leaves the last cursor pixels burned in.
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

const ORIGINAL_RENDER = Symbol.for("dev3.terminalCursorFocus.originalRender");

type WrappedRenderer = GateableRenderer & {
	[ORIGINAL_RENDER]?: GateableRenderer["render"];
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

export function installCursorVisibilityGate(renderer: GateableRenderer): CursorVisibilityGate {
	const target = renderer as WrappedRenderer;
	let cursorVisible = true;
	let innerBuffer: CursorReporter | null = null;
	let hiddenView: CursorReporter | null = null;

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
			original.call(this, effective, forceAll, viewportY, scrollbackProvider, scrollbarOpacity);
		};
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
		},
	};
}

export function isCursorVisibilityGateInstalled(renderer: GateableRenderer): boolean {
	return (renderer as WrappedRenderer)[ORIGINAL_RENDER] !== undefined;
}
