import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { DEV3_HOME } from "./paths";
import { createLogger } from "./logger";

const log = createLogger("window-state");

export interface Rect {
	x: number;
	y: number;
	width: number;
	height: number;
}

/** Persisted geometry of one window, restored across app restarts (e.g. updates). */
export interface WindowState {
	/** Last *windowed* frame (never the fullscreen rect, so we have a sane size to exit fullscreen into). */
	frame: Rect;
	/** Whether the window was in macOS native fullscreen (its own Space). */
	fullscreen: boolean;
	/** CoreGraphics display id the window lived on (the "screen number"). */
	displayId: number;
	/** Bounds of that display, used to re-match it if the id churned across reconnect/reboot. */
	displayBounds: Rect;
}

/** Minimal shape of an Electrobun Screen.Display we care about. */
export interface DisplayLike {
	id: number;
	bounds: Rect;
	scaleFactor?: number;
	isPrimary?: boolean;
}

// New sibling file under ~/.dev3.0/ — never renames or touches projects.json/tasks.json
// (respects the on-disk data layout invariants).
const STATE_PATH = `${DEV3_HOME}/window-state.json`;

function isValidRect(r: unknown): r is Rect {
	if (!r || typeof r !== "object") return false;
	const o = r as Record<string, unknown>;
	return (
		Number.isFinite(o.x) &&
		Number.isFinite(o.y) &&
		Number.isFinite(o.width) &&
		Number.isFinite(o.height) &&
		(o.width as number) > 0 &&
		(o.height as number) > 0
	);
}

function isValidState(s: unknown): s is WindowState {
	if (!s || typeof s !== "object") return false;
	const o = s as Record<string, unknown>;
	return (
		isValidRect(o.frame) &&
		typeof o.fullscreen === "boolean" &&
		Number.isFinite(o.displayId) &&
		isValidRect(o.displayBounds)
	);
}

/**
 * Every window that was open when the app last shut down, in creation order.
 * Empty when the file is missing or holds nothing usable.
 *
 * The file also carries the first window's fields at the top level, so an older
 * install that only knows the single-window shape still restores its main
 * window from the same file (the on-disk layout is shared between versions).
 */
export function loadWindowStates(path: string = STATE_PATH): WindowState[] {
	try {
		if (!existsSync(path)) return [];
		const raw = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
		const list = raw?.windows;
		if (Array.isArray(list)) return list.filter(isValidState);
		return isValidState(raw) ? [raw] : [];
	} catch (err) {
		log.warn("Failed to load window state", { error: String(err) });
		return [];
	}
}

export function saveWindowStates(states: WindowState[], path: string = STATE_PATH): void {
	try {
		mkdirSync(dirname(path), { recursive: true });
		// `...states[0]` is the compatibility half: older versions read only these
		// top-level fields and would otherwise see an unreadable file.
		writeFileSync(path, JSON.stringify({ ...states[0], windows: states }), "utf-8");
	} catch (err) {
		log.warn("Failed to save window state", { error: String(err) });
	}
}

/** Find the display whose bounds contain the frame's center point, or null. */
export function displayContaining(frame: Rect, displays: DisplayLike[]): DisplayLike | null {
	const cx = frame.x + frame.width / 2;
	const cy = frame.y + frame.height / 2;
	for (const d of displays) {
		const b = d.bounds;
		if (cx >= b.x && cx < b.x + b.width && cy >= b.y && cy < b.y + b.height) return d;
	}
	return null;
}

function boundsEqual(a: Rect, b: Rect): boolean {
	return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

function clamp(v: number, lo: number, hi: number): number {
	return Math.max(lo, Math.min(hi, v));
}

/** Fit a frame inside a display's bounds, shrinking it only if it does not fit. */
export function clampFrameToDisplay(frame: Rect, bounds: Rect): Rect {
	const width = Math.min(frame.width, bounds.width);
	const height = Math.min(frame.height, bounds.height);
	return {
		x: clamp(frame.x, bounds.x, bounds.x + bounds.width - width),
		y: clamp(frame.y, bounds.y, bounds.y + bounds.height - height),
		width,
		height,
	};
}

function intersectionArea(a: Rect, b: Rect): number {
	const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
	const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
	return w > 0 && h > 0 ? w * h : 0;
}

/**
 * A window is only pulled back when part of it sits on NO screen at all — a
 * window deliberately spanning two monitors must stay where the user put it, so
 * we measure coverage against the union of every display (they tile without
 * overlap in the global coordinate space, so summing intersections is exact).
 *
 * Returns null when nothing needs moving.
 */
export function offscreenFrameClamp(
	frame: Rect,
	displays: DisplayLike[],
	tolerancePx = 2,
): { frame: Rect; display: DisplayLike } | null {
	if (!displays.length) return null;
	const area = frame.width * frame.height;
	if (area <= 0) return null;
	const covered = displays.reduce((sum, d) => sum + intersectionArea(frame, d.bounds), 0);
	// Slack for a hairline sliver: rounding and shadow insets must not count as offscreen.
	const slack = tolerancePx * 2 * (frame.width + frame.height);
	if (covered >= area - slack) return null;

	let host = displays.find((d) => d.isPrimary) ?? displays[0]!;
	let hostArea = 0;
	for (const d of displays) {
		const a = intersectionArea(frame, d.bounds);
		if (a > hostArea) {
			hostArea = a;
			host = d;
		}
	}
	const clamped = clampFrameToDisplay(frame, host.bounds);
	if (boundsEqual(clamped, frame)) return null;
	return { frame: clamped, display: host };
}

function largestOverlap(frame: Rect, displays: DisplayLike[]): { display: DisplayLike | null; area: number } {
	let display: DisplayLike | null = null;
	let area = 0;
	for (const d of displays) {
		const a = intersectionArea(frame, d.bounds);
		if (a > area) {
			area = a;
			display = d;
		}
	}
	return { display, area };
}

/**
 * How far Electrobun's macOS `getFrame()` y sits below the global top-left y the
 * Screen API and window events use (decisions/2026/10/09/macos-window-frame-own-screen-flip.md).
 * getFrame/setFrame flip against the height of the window's OWN screen, the rest
 * against the primary's, so on a screen of another height they disagree by the
 * difference. The native side never says which screen it used: we pick the one
 * whose flip would put the window mostly on that same screen, as NSWindow.screen does.
 */
export function nativeFrameYOffset(nativeFrame: Rect, displays: DisplayLike[]): number {
	const primary = displays.find((d) => d.isPrimary) ?? displays.find((d) => d.bounds.x === 0 && d.bounds.y === 0);
	if (!primary) return 0;
	let best = 0;
	let bestArea = 0;
	for (const d of displays) {
		const offset = d.bounds.height - primary.bounds.height;
		const host = largestOverlap({ ...nativeFrame, y: nativeFrame.y - offset }, displays);
		if (host.display === d && host.area > bestArea) {
			best = offset;
			bestArea = host.area;
		}
	}
	// On no screen under any reading: macOS falls back to the main screen, and so do we.
	return best;
}

/** A macOS `getFrame()` result in the global coordinates the Screen API reports. */
export function nativeFrameToGlobal(nativeFrame: Rect, displays: DisplayLike[]): Rect {
	return { ...nativeFrame, y: nativeFrame.y - nativeFrameYOffset(nativeFrame, displays) };
}

/**
 * The `setFrame()` argument that lands a window on `target` (global coordinates).
 * setFrame flips against the screen the window is on BEFORE the move, so the
 * offset comes from its current native frame, not from the target.
 */
export function globalFrameToNative(target: Rect, currentNativeFrame: Rect, displays: DisplayLike[]): Rect {
	return { ...target, y: target.y + nativeFrameYOffset(currentNativeFrame, displays) };
}

/**
 * Resolve a restorable frame for the saved state against the *current* displays.
 * Returns null when the saved screen is gone (e.g. laptop undocked) so the caller
 * can fall back to the default centered placement instead of pushing the window
 * off-screen.
 */
export function resolveRestoreFrame(
	state: WindowState,
	displays: DisplayLike[],
): { frame: Rect; fullscreen: boolean } | null {
	const disp =
		displays.find((d) => d.id === state.displayId) ??
		displays.find((d) => boundsEqual(d.bounds, state.displayBounds));
	if (!disp) return null;

	// Clamp the saved frame inside the display so it stays fully visible even if
	// the display resolution changed since the state was written.
	return { frame: clampFrameToDisplay(state.frame, disp.bounds), fullscreen: state.fullscreen };
}
