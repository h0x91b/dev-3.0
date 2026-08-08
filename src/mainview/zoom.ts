// ── Zoom module ──
// Scales the UI by changing the root font-size. All Tailwind rem-based
// classes scale automatically. The browser re-renders text natively at
// the new size — no bitmap scaling, so text stays crisp in WKWebView.
// Terminal canvases handle zoom separately (see TerminalView).

import type { Route } from "./state";
import { detectMobile } from "./hooks/useMobile";

const ZOOM_KEY = "dev3-zoom";
export const DEFAULT_ZOOM = 1.0;
export const MIN_ZOOM = 0.5;
export const MAX_ZOOM = 2.0;
export const ZOOM_STEP = 0.1;
export const ZOOM_CHANGED_EVENT = "zoom-changed" as const;
// A phone gets ~2/3 scale (1.5× denser) inside a task: at 1.0 the terminal,
// diff and inspector are sized for a desktop pointer and read as oversized on a
// ~400px viewport. Applied as a multiplier on top of the user's zoom; the saved
// setting is untouched, so ⌘+/⌘− still work from there. Terminal/diff screens
// asked for this factor before it became the phone default — they keep it, not
// a second helping of it (see mobileFactor).
export const MOBILE_DENSE_FACTOR = 0.67;
// Browsing screens get +25% over the dense factor. Dense is tuned for a
// working surface — a task's terminal, diff and inspector, where the point is
// to see as much at once as the phone allows. The board and the dashboard are
// read at arm's length and tapped, not worked in: at 0.67 a card title lands
// around 9px and the whole column reads as a thumbnail of a desktop board.
export const MOBILE_ROOMY_FACTOR = 0.84;

const BASE_FONT_SIZE = 16; // browser default root font-size in px

export type MobileDensity = "dense" | "roomy";

/** In-memory cache — avoids localStorage reads on every call. */
let currentZoom = DEFAULT_ZOOM;
// Set from the route; ignored entirely on a desktop-width viewport. Starts
// roomy because bootstrapZoom() runs before React and the first route is the
// dashboard — starting dense would re-scale the whole app on first paint.
let mobileDensity: MobileDensity = "roomy";

function mobileFactor(): number {
	if (!detectMobile()) return 1;
	return mobileDensity === "roomy" ? MOBILE_ROOMY_FACTOR : MOBILE_DENSE_FACTOR;
}

/**
 * Which density a screen wants. Dense is the working set: a task (terminal,
 * diff, inspector) and the project terminal. Everything the user only browses
 * — board, dashboard, settings, stats, changelog — is roomy.
 */
export function mobileDensityForRoute(route: Route): MobileDensity {
	if (route.screen === "task" || route.screen === "project-terminal") return "dense";
	if (route.screen === "project" && (route.activeTaskId || route.taskView)) return "dense";
	return "roomy";
}

/** Re-scales the root font-size when the route moves between the two densities. */
export function setMobileDensity(next: MobileDensity) {
	if (next === mobileDensity) return;
	const before = getEffectiveZoom();
	mobileDensity = next;
	if (getEffectiveZoom() === before) return; // desktop: both densities are 1
	syncRootFontSize();
	window.dispatchEvent(new CustomEvent(ZOOM_CHANGED_EVENT, { detail: getEffectiveZoom() }));
}

/**
 * How much a browse-and-tap overlay must scale itself up to reach the roomy
 * size while the screen underneath stays dense — 1 when there is nothing to
 * make up for. Applied as a local CSS `zoom`, never by moving the root
 * font-size: re-scaling the root would reflow the terminal behind the overlay
 * and resize the agent's shell just because a menu opened.
 */
export function overlayScaleUp(): number {
	if (!detectMobile() || mobileDensity !== "dense") return 1;
	return Math.round((MOBILE_ROOMY_FACTOR / MOBILE_DENSE_FACTOR) * 100) / 100;
}

/** User zoom × phone factor — what the root font-size and terminal font actually use. */
export function getEffectiveZoom(): number {
	return Math.round(currentZoom * mobileFactor() * 100) / 100;
}

function syncRootFontSize() {
	document.documentElement.style.fontSize = `${BASE_FONT_SIZE * getEffectiveZoom()}px`;
}

export function applyZoom(level: number) {
	const clamped = Math.round(Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, level)) * 100) / 100;
	currentZoom = clamped;
	syncRootFontSize();
	localStorage.setItem(ZOOM_KEY, String(clamped));
	window.dispatchEvent(new CustomEvent(ZOOM_CHANGED_EVENT, { detail: getEffectiveZoom() }));
}

export function getZoom(): number {
	return currentZoom;
}

export function adjustZoom(delta: number) {
	applyZoom(currentZoom + delta);
}

/** Call once before React mounts to apply saved zoom and expose the API globally. */
export function bootstrapZoom() {
	const parsed = parseFloat(localStorage.getItem(ZOOM_KEY) ?? "");
	const saved = Number.isFinite(parsed) ? parsed : DEFAULT_ZOOM;
	currentZoom = Math.round(Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, saved)) * 100) / 100;
	// Apply without dispatching event (no listeners exist yet)
	syncRootFontSize();
	localStorage.setItem(ZOOM_KEY, String(currentZoom));
}
