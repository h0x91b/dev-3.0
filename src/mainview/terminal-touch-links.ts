import { lineToText, type CellLine } from "./terminal-file-links";
import { fileUriToLocalPath, safeDeepLinkUri, safeFileUri, safeHttpUri } from "./terminal-osc8-links";

/**
 * Touch access to terminal links. Every link provider activates only on
 * Cmd/Ctrl+Click, and a phone has no modifier key, so a link a touch user
 * could see was impossible to open (h0x91b/dev-3.0#1811). A plain tap on a
 * link instead resolves it here and the terminal shows a link sheet: the full
 * destination plus explicit Open / Copy. The sheet IS the deliberate step — a
 * tap never navigates by itself, so a mis-tap while reading costs nothing.
 */

export type TouchLinkKind = "web" | "file" | "app";

export interface TouchLink {
	kind: TouchLinkKind;
	/** What the sheet shows and Copy puts on the clipboard: a URL, or a local path. */
	target: string;
	/** The same activation a Cmd/Ctrl+Click runs. Call it from a user gesture. */
	open: () => void;
}

/** One link source, hit-tested at an absolute buffer cell. */
export type TouchLinkSource = (y: number, x: number) => TouchLink | undefined;

/** The first source with a link under the cell wins — order is precedence. */
export function findTouchLink(sources: readonly TouchLinkSource[], y: number, x: number): TouchLink | undefined {
	for (const source of sources) {
		try {
			const link = source(y, x);
			if (link) return link;
		} catch {
			// A provider failing on one row must not swallow the others' links.
		}
	}
	return undefined;
}

/**
 * Classify an OSC 8 destination that already passed `safeOsc8Uri`. A `file:`
 * link shows its local path (what a user recognises and wants to paste), the
 * rest show the URI itself. Anything that fails validation is no link at all.
 */
export function osc8TouchLink(uri: string, open: () => void): TouchLink | undefined {
	if (safeHttpUri(uri)) return { kind: "web", target: uri, open };
	if (safeDeepLinkUri(uri)) return { kind: "app", target: uri, open };
	if (safeFileUri(uri)) {
		const file = fileUriToLocalPath(uri);
		return file ? { kind: "file", target: file.path, open } : undefined;
	}
	return undefined;
}

// Same shape ghostty-web's own plain-URL provider matches (it is not exported):
// a scheme, then everything up to whitespace or a quoting character, with
// sentence punctuation trimmed off the end. One row only, like ghostty's.
const PLAIN_URL = /https?:\/\/[^\s"'<>`]+/g;
const TRAILING_PUNCTUATION = /[.,;:!?)\]}]+$/;

/** A bare http(s) URL printed as plain text, under the cell. */
export function plainUrlAt(line: CellLine | undefined, x: number): string | undefined {
	if (!line) return undefined;
	const text = lineToText(line);
	PLAIN_URL.lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = PLAIN_URL.exec(text)) !== null) {
		const url = match[0].replace(TRAILING_PUNCTUATION, "");
		const start = match.index;
		if (x >= start && x < start + url.length) return safeHttpUri(url);
	}
	return undefined;
}

/** Movement past this many CSS px makes a touch a drag, never a tap. */
export const TAP_SLOP_PX = 8;

export interface TapPoint {
	clientX: number;
	clientY: number;
}

/**
 * Tells a deliberate single-finger tap from everything else a finger does on
 * the terminal — scroll, drag-select, pinch, a pane swipe the carousel claimed.
 * Any second finger or any excursion past the slop disqualifies the touch for
 * good, even if the finger comes back to where it started.
 */
export function createTapTracker(slop = TAP_SLOP_PX) {
	let startX = 0;
	let startY = 0;
	let valid = false;

	const moved = (x: number, y: number) => Math.hypot(x - startX, y - startY) > slop;

	return {
		start(touches: TouchList): void {
			valid = touches.length === 1;
			if (!valid) return;
			startX = touches[0]!.clientX;
			startY = touches[0]!.clientY;
		},
		move(touches: TouchList): void {
			if (!valid) return;
			if (touches.length !== 1 || moved(touches[0]!.clientX, touches[0]!.clientY)) valid = false;
		},
		/** The tap point, or null when this touch was not a tap. */
		end(touches: TouchList, changed: TouchList): TapPoint | null {
			const wasTap = valid && touches.length === 0 && changed.length === 1;
			valid = false;
			if (!wasTap) return null;
			const touch = changed[0]!;
			// The carousel stops touchmove before it reaches us on a swipe it
			// claims, so the end point is the only witness of that movement.
			if (moved(touch.clientX, touch.clientY)) return null;
			return { clientX: touch.clientX, clientY: touch.clientY };
		},
		cancel(): void {
			valid = false;
		},
	};
}

/**
 * Claim a tap that lands on a link. Capture-phase listeners on the terminal
 * container run before ghostty-web's own canvas touch handlers and before the
 * tap → mouse translation, so a claimed tap neither clicks into tmux nor
 * focuses the hidden textarea (no on-screen keyboard), and `preventDefault`
 * keeps the browser from synthesizing a mouse click after it. A tap anywhere
 * else is left alone — this only ever adds behaviour on link cells.
 */
export function installTouchLinkTap(opts: {
	container: HTMLElement;
	sources: readonly TouchLinkSource[];
	cellAt: (point: TapPoint) => { y: number; x: number } | undefined;
	onLink: (link: TouchLink) => void;
}): { dispose(): void } {
	const tap = createTapTracker();
	const onStart = (e: TouchEvent) => tap.start(e.touches);
	const onMove = (e: TouchEvent) => tap.move(e.touches);
	const onCancel = () => tap.cancel();
	const onEnd = (e: TouchEvent) => {
		const point = tap.end(e.touches, e.changedTouches);
		if (!point) return;
		let link: TouchLink | undefined;
		try {
			const cell = opts.cellAt(point);
			link = cell ? findTouchLink(opts.sources, cell.y, cell.x) : undefined;
		} catch {
			return;
		}
		if (!link) return;
		e.preventDefault();
		e.stopPropagation();
		opts.onLink(link);
	};
	const { container } = opts;
	container.addEventListener("touchstart", onStart, { capture: true, passive: true });
	container.addEventListener("touchmove", onMove, { capture: true, passive: true });
	container.addEventListener("touchcancel", onCancel, { capture: true, passive: true });
	// Not passive: claiming the tap needs preventDefault.
	container.addEventListener("touchend", onEnd, { capture: true, passive: false });
	return {
		dispose() {
			container.removeEventListener("touchstart", onStart, { capture: true });
			container.removeEventListener("touchmove", onMove, { capture: true });
			container.removeEventListener("touchcancel", onCancel, { capture: true });
			container.removeEventListener("touchend", onEnd, { capture: true });
		},
	};
}
