/**
 * Renderer ↔ pty-server terminal resize protocol.
 *
 * The renderer reports its terminal geometry over the PTY WebSocket as an
 * OSC-style in-band sequence: `ESC ] resize ; cols ; rows BEL`. The bun side
 * intercepts it before forwarding input to the PTY. Encoder and parser live
 * here — the single definition both sides import — so the wire format cannot
 * drift between the renderer and the pty-server.
 */

export const RESIZE_SEQUENCE_PREFIX = "\x1b]resize;";

const RESIZE_SEQUENCE_RE = /\x1b\]resize;(\d+);(\d+)\x07/;

/** Encode a terminal geometry report for the PTY WebSocket. */
export function encodeResizeSequence(cols: number, rows: number): string {
	return `${RESIZE_SEQUENCE_PREFIX}${cols};${rows}\x07`;
}

/** True when `data` starts a resize report (and must not reach the PTY). */
export function isResizeSequence(data: string): boolean {
	return data.startsWith(RESIZE_SEQUENCE_PREFIX);
}

/**
 * Parse a resize report. Returns null for a malformed sequence — callers
 * that already checked isResizeSequence() still swallow the message then.
 */
export function parseResizeSequence(data: string): { cols: number; rows: number } | null {
	const match = data.match(RESIZE_SEQUENCE_RE);
	if (!match) return null;
	return { cols: Number(match[1]), rows: Number(match[2]) };
}

/**
 * Viewer → pty-server presence signal, in-band like the resize report:
 * `ESC ] dev3viewer ; active|hidden BEL`. `active` is a user gesture (focus,
 * click, keystroke, tab made visible); `hidden` is a backgrounded tab. Neither
 * ever reaches the PTY.
 */
export type ViewerSignal = "active" | "hidden";

const VIEWER_SIGNAL_PREFIX = "\x1b]dev3viewer;";
const VIEWER_SIGNAL_RE = /^\x1b\]dev3viewer;(active|hidden)\x07$/;

export function encodeViewerSignal(signal: ViewerSignal): string {
	return `${VIEWER_SIGNAL_PREFIX}${signal}\x07`;
}

/** True when `data` starts a viewer signal (and must not reach the PTY). */
export function isViewerSignal(data: string): boolean {
	return data.startsWith(VIEWER_SIGNAL_PREFIX);
}

export function parseViewerSignal(data: string): ViewerSignal | null {
	const match = data.match(VIEWER_SIGNAL_RE);
	return match ? (match[1] as ViewerSignal) : null;
}

/**
 * pty-server → viewer notice: the shared PTY's size, and whether THIS viewer is
 * the one it is sized for — `ESC ] dev3sizing ; cols ; rows ; 0|1 BEL`, always
 * sent as its own WebSocket message. A viewer that is not sizing renders at the
 * PTY's geometry instead of its container's.
 */
export interface SizingNotice {
	cols: number;
	rows: number;
	sizing: boolean;
}

const SIZING_NOTICE_PREFIX = "\x1b]dev3sizing;";
const SIZING_NOTICE_RE = /^\x1b\]dev3sizing;(\d+);(\d+);([01])\x07$/;

export function encodeSizingNotice({ cols, rows, sizing }: SizingNotice): string {
	return `${SIZING_NOTICE_PREFIX}${cols};${rows};${sizing ? 1 : 0}\x07`;
}

export function isSizingNotice(data: string): boolean {
	return data.startsWith(SIZING_NOTICE_PREFIX);
}

export function parseSizingNotice(data: string): SizingNotice | null {
	const match = data.match(SIZING_NOTICE_RE);
	if (!match) return null;
	return { cols: Number(match[1]), rows: Number(match[2]), sizing: match[3] === "1" };
}

/** One attached viewer as the size negotiation sees it. */
export interface SizingCandidate {
	cols?: number;
	rows?: number;
	/** The viewer's tab is backgrounded or its window minimised. */
	hidden?: boolean;
	/** Monotonic stamp of the viewer's last user gesture; 0/absent = none yet. */
	activeAt?: number;
}

/**
 * Pick the viewer the shared PTY is sized for: the most recently ACTIVE visible
 * viewer — tmux's own `window-size latest`. Hidden viewers count only when no
 * visible one has a size, so nobody watching never resizes the shell. Ties keep
 * the earliest viewer in iteration (connection) order, so merely connecting or
 * reconnecting never takes the size over. Viewers without a positive size are
 * skipped; null means nobody reported one and no geometry should be applied.
 *
 * Deliberately lives here and not in `pty-server.ts`: importing that module
 * starts the PTY WebSocket server at load time, so a test-only or
 * backend-neutral caller that only wanted this helper would never exit.
 */
export function pickSizingViewer<T extends SizingCandidate>(viewers: Iterable<T>): T | null {
	let best: T | null = null;
	for (const viewer of viewers) {
		if (!(viewer.cols && viewer.cols > 0 && viewer.rows && viewer.rows > 0)) continue;
		if (!best || outranks(viewer, best)) best = viewer;
	}
	return best;
}

function outranks(a: SizingCandidate, b: SizingCandidate): boolean {
	if (!a.hidden !== !b.hidden) return !a.hidden;
	return (a.activeAt ?? 0) > (b.activeAt ?? 0);
}
