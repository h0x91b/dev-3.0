// ── Zoom module ──
// Scales the UI by changing the root font-size. All Tailwind rem-based
// classes scale automatically. The browser re-renders text natively at
// the new size — no bitmap scaling, so text stays crisp in WKWebView.
// Terminal canvases handle zoom separately (see TerminalView).

const ZOOM_KEY = "dev3-zoom";
export const DEFAULT_ZOOM = 1.0;
export const MIN_ZOOM = 0.5;
export const MAX_ZOOM = 2.0;
export const ZOOM_STEP = 0.1;
export const ZOOM_CHANGED_EVENT = "zoom-changed" as const;

const BASE_FONT_SIZE = 16; // browser default root font-size in px

/** In-memory cache — avoids localStorage reads on every call. */
let currentZoom = DEFAULT_ZOOM;

export function applyZoom(level: number) {
	const clamped = Math.round(Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, level)) * 100) / 100;
	currentZoom = clamped;
	document.documentElement.style.fontSize = `${BASE_FONT_SIZE * clamped}px`;
	localStorage.setItem(ZOOM_KEY, String(clamped));
	window.dispatchEvent(new CustomEvent(ZOOM_CHANGED_EVENT, { detail: clamped }));
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
	document.documentElement.style.fontSize = `${BASE_FONT_SIZE * currentZoom}px`;
	localStorage.setItem(ZOOM_KEY, String(currentZoom));
}
