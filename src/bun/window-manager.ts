import { BrowserView, BrowserWindow, Screen } from "electrobun/bun";
import type { AppRPCSchema } from "../shared/types";
import { createLogger } from "./logger";
import { composeWindowTitle } from "./app-utils";
import { loadWindowStates, saveWindowStates, resolveRestoreFrame, displayContaining, offscreenFrameClamp, type DisplayLike, type Rect, type WindowState } from "./window-state";
import { isFreshStartMode } from "./fresh-start";
import { isQuitConfirmed } from "./quit-manager";
import { applyWindowsWindowIcon } from "./windows-icons/apply-window-icon";

const log = createLogger("window-manager");

type WindowEntry = {
	window: BrowserWindow;
	id: number;
	/**
	 * Last known *windowed* frame — kept per window because getFrame() while the
	 * window is in fullscreen returns the fullscreen rect, not the size to exit into.
	 */
	lastWindowedFrame: Rect | null;
};

// Registry of every dev-3.0 window that is currently open.
// We keep our own set (in addition to Electrobun's internal BrowserWindowMap)
// so we can track focus order, broadcast push messages, and target the
// focused window from application-menu handlers.
const windows = new Set<WindowEntry>();
let focusedWindow: BrowserWindow | null = null;
let seq = 0;

// Debounced persistence of every open window's geometry so a restart can put
// them all back (otherwise they jump to a centered cascade on relaunch).
let saveTimer: ReturnType<typeof setTimeout> | null = null;

function entryState(entry: WindowEntry): WindowState | null {
	try {
		const win = entry.window;
		const fullscreen = win.isFullScreen();
		const frame = win.getFrame();
		if (!fullscreen) entry.lastWindowedFrame = frame;
		const windowed = entry.lastWindowedFrame ?? frame;
		const displays = Screen.getAllDisplays();
		const disp = displayContaining(fullscreen ? frame : windowed, displays) ?? Screen.getPrimaryDisplay();
		return { frame: windowed, fullscreen, displayId: disp.id, displayBounds: disp.bounds };
	} catch (err) {
		log.debug("captureWindowState failed", { id: entry.id, error: String(err) });
		return null;
	}
}

/** Snapshot every open window, in creation order, into the shared state file. */
function captureAllWindowStates(): void {
	// Fresh-start (dev) mode never persists geometry — it must not clobber the
	// shared ~/.dev3.0/window-state.json that the real install restores from.
	if (isFreshStartMode()) return;
	const states: WindowState[] = [];
	for (const entry of windows) {
		const state = entryState(entry);
		if (state) states.push(state);
	}
	// Nothing left to record: keep the previous snapshot rather than writing an
	// empty session, so quitting from a window-less dock still reopens a window
	// where the user last had one.
	if (!states.length) return;
	saveWindowStates(states);
}

function scheduleWindowStateSave(): void {
	if (saveTimer) clearTimeout(saveTimer);
	saveTimer = setTimeout(() => captureAllWindowStates(), 500);
}

/** Persist every open window's geometry immediately (called on quit / update restart). */
export function flushWindowState(): void {
	if (saveTimer) {
		clearTimeout(saveTimer);
		saveTimer = null;
	}
	captureAllWindowStates();
}

/**
 * The windows to reopen at launch, in creation order. Empty in fresh-start (dev)
 * mode and on a first run — the caller then opens its usual single window.
 */
export function loadWindowSession(): WindowState[] {
	if (isFreshStartMode()) return [];
	return loadWindowStates();
}

/**
 * React to a display-configuration change (or a wake) reported by `display-watch`.
 *
 * The geometry line is the point of this function: two field reports of a broken
 * layout after a resolution change arrived with no way to tell whether the window
 * had outgrown the screen or the page had merely laid out stale. Pair it with the
 * renderer's own `viewport` line to compare both sides.
 *
 * The clamp itself only fires when part of the window sits on no screen at all —
 * the saved frame has always been clamped on startup (`resolveRestoreFrame`), the
 * live window never was.
 */
export function handleDisplayConfigurationChange(reason: string, displays: DisplayLike[]): void {
	for (const entry of windows) {
		const win = entry.window;
		try {
			const frame = win.getFrame();
			const fullscreen = win.isFullScreen();
			const host = displayContaining(frame, displays);
			log.info("Display configuration changed", {
				reason,
				id: entry.id,
				fullscreen,
				frame: `${frame.width}x${frame.height}+${frame.x}+${frame.y}`,
				displays: displays.map((d) => `${d.id}:${d.bounds.width}x${d.bounds.height}@${d.scaleFactor ?? 1}`).join(" "),
				host: host ? host.id : null,
			});
			// macOS owns a fullscreen window's frame; setFrame would fight it.
			if (fullscreen) continue;
			const pullBack = offscreenFrameClamp(frame, displays);
			if (!pullBack) continue;
			log.info("Pulling window back onto a screen", {
				id: entry.id,
				from: `${frame.width}x${frame.height}+${frame.x}+${frame.y}`,
				to: `${pullBack.frame.width}x${pullBack.frame.height}+${pullBack.frame.x}+${pullBack.frame.y}`,
				display: pullBack.display.id,
			});
			win.setFrame(pullBack.frame.x, pullBack.frame.y, pullBack.frame.width, pullBack.frame.height);
		} catch (err) {
			log.warn("Display change handling failed for one window", { id: entry.id, error: String(err) });
		}
	}
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Handlers = Record<string, (...args: any[]) => any>;

export interface CreateAppWindowOptions {
	url: string;
	title: string;
	handlers: Handlers;
	/** Called once the webview reports dom-ready. Receives the new window. */
	onDomReady?: (win: BrowserWindow) => void;
	/** Called whenever the window gains focus (windowDidBecomeKey:). */
	onFocus?: (win: BrowserWindow) => void;
	/** Called when the webview tries to open a new window (e.g. Cmd+Click a link). */
	onExternalLink?: (url: string) => void;
	/** Called after the window has been created (before dom-ready). */
	onCreated?: (win: BrowserWindow) => void;
	/** Called after the window has been removed from the registry. */
	onClosed?: (win: BrowserWindow, remaining: number) => void;
	maxRequestTime?: number;
	/**
	 * Inline JS run after HTML parsing, before page scripts. The bundled renderer
	 * is loaded straight from disk, so this is the only way to hand it a value the
	 * host knows and it must see before it boots (the served remote HTML gets a
	 * `<script>` tag instead).
	 */
	preload?: string;
	/**
	 * Geometry this window is being restored into (one entry of the persisted
	 * session). Omitted for a window the user opens now — only the very first
	 * window of a launch falls back to the saved primary geometry.
	 */
	restore?: WindowState | null;
	/**
	 * Whether showing the window also activates the app (macOS
	 * `activateIgnoringOtherApps:`). False orders the window in without taking
	 * foreground, so a launch cannot pull the user out of a fullscreen app or
	 * switch their Space. Defaults to true — only the dev launch opts out.
	 */
	activate?: boolean;
}

/**
 * Create a new dev-3.0 main window. Each window gets its own RPC instance
 * (Electrobun's `setTransport` is called once per BrowserView, so the same
 * rpc object cannot be shared between views) but the handler implementations
 * are re-used.
 *
 * Electrobun auto-calls `quit()` when the last BrowserWindow closes
 * (`exitOnLastWindowClosed` defaults to true), so individual window
 * close handlers don't need to do that themselves.
 */
export function createAppWindow(opts: CreateAppWindowOptions): BrowserWindow {
	// Each window titles itself: the renderer reports its own route context, and
	// only the window that sent it may be retitled. The shared `handlers` object
	// cannot do that (it has no idea which window called), hence the per-window
	// override below over a back-reference filled in right after creation.
	let self: BrowserWindow | null = null;
	const setWindowTitleContext = ({ context }: { context: string | null }): void => {
		if (!self) return;
		try {
			self.setTitle(composeWindowTitle(opts.title, context));
		} catch (err) {
			log.debug("setTitle failed", { error: String(err) });
		}
	};

	const rpc = BrowserView.defineRPC<AppRPCSchema>({
		maxRequestTime: opts.maxRequestTime ?? 120_000,
		handlers: {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			requests: { ...opts.handlers, setWindowTitleContext } as any,
			messages: {},
		},
	});

	// Restore a window to its last position/screen (incl. macOS fullscreen):
	// either the slot the launch handed us, or — for the first window of a run
	// with no explicit slot — the saved primary geometry. A window the user opens
	// while others are up keeps the centered cascade so they don't stack.
	// In fresh-start (dev) mode we skip the restore entirely and always open a
	// default centered, windowed frame — no geometry, no fullscreen.
	let frame: Rect;
	let restoreFullScreen = false;
	const saved = opts.restore ?? (windows.size === 0 ? loadWindowSession()[0] ?? null : null);
	const restored = saved ? resolveRestoreFrame(saved, Screen.getAllDisplays()) : null;
	if (restored) {
		frame = restored.frame;
		restoreFullScreen = restored.fullscreen;
		log.info("Restoring window geometry", { fullscreen: restoreFullScreen, ...restored.frame });
	} else {
		// ~95% of the primary display work area, centered. Additional windows are
		// offset so they don't land exactly on top of each other.
		const primary = Screen.getPrimaryDisplay();
		const wa = primary.workArea;
		const RATIO = 0.95;
		const width = Math.round(wa.width * RATIO);
		const height = Math.round(wa.height * RATIO);
		const offset = windows.size * 40;
		// Clamp so the window never extends beyond the work area, even when
		// many windows are open (cascade stagger can exceed the available margin).
		const x = Math.min(wa.x + Math.round((wa.width - width) / 2) + offset, wa.x + wa.width - width);
		const y = Math.min(wa.y + Math.round((wa.height - height) / 2) + offset, wa.y + wa.height - height);
		frame = { x, y, width, height };
	}

	const win = new BrowserWindow({
		title: opts.title,
		url: opts.url,
		rpc,
		frame,
		activate: opts.activate ?? true,
		...(opts.preload ? { preload: opts.preload } : {}),
	});

	// The `frame` option above only reaches the FIRST window of the process —
	// every later one opens stacked on the existing window, ignoring both the
	// cascade offset and a restored geometry (measured on macOS: three windows
	// asked for three frames, all three landed on the first one's). We re-apply
	// the frame ourselves at dom-ready: called right after the constructor the
	// same call lands on the wrong window, because the native side is still
	// creating this one. Skipped when restoring into fullscreen, which macOS owns.
	const needsFrameApply = windows.size > 0 && !restoreFullScreen;

	// Windows draws a system-fallback icon in the window and the taskbar because
	// electrobun never assigns one to its window class; we set it ourselves from
	// the icon already embedded in our executables. No-op off Windows, where the
	// bundle's own icon already reaches the dock and the launcher.
	applyWindowsWindowIcon(win.ptr as unknown as number);

	self = win;

	const id = ++seq;
	const entry: WindowEntry = { window: win, id, lastWindowedFrame: restored ? restored.frame : frame };
	windows.add(entry);
	focusedWindow = win;
	log.info("Window created", { id, total: windows.size });

	win.on("focus", () => {
		focusedWindow = win;
		log.debug("Window focused", { id });
		opts.onFocus?.(win);
	});

	win.on("close", () => {
		self = null; // a late title report must not touch a closed window
		windows.delete(entry);
		if (focusedWindow === win) {
			focusedWindow = firstWindow();
		}
		log.info("Window closed", { id, remaining: windows.size });
		// A window the user closed on purpose must not come back on the next
		// launch, so re-snapshot what is left. During a quit every window closes
		// at once — that is teardown, not a decision, and the session written by
		// flushWindowState must survive it.
		if (!isQuitConfirmed()) captureAllWindowStates();
		opts.onClosed?.(win, windows.size);
	});

	// Persist geometry as the user drags/resizes (debounced) so an update restart
	// can put the window back where it was. Skipped in fresh-start (dev) mode,
	// which must not touch the shared persisted state (captureWindowState also
	// short-circuits, but not attaching avoids pointless timers).
	if (!isFreshStartMode()) {
		win.on("move", () => scheduleWindowStateSave());
		win.on("resize", () => scheduleWindowStateSave());
	}

	if (restoreFullScreen) {
		// macOS can't restore the exact Space, but re-entering fullscreen while the
		// window sits on the saved monitor recreates it on the right screen. Do it
		// after dom-ready (a small delay — the style mask isn't reliably applied at
		// creation time).
		win.webview.on("dom-ready", () => {
			setTimeout(() => {
				try { win.setFullScreen(true); } catch (err) { log.warn("Restore fullscreen failed", { error: String(err) }); }
			}, 100);
		});
	} else {
		// WKWebView clips the bottom ~16px after the first paint on some macOS
		// versions. A quick resize nudge forces the viewport into the post-resize
		// layout immediately so the app's pb-8 padding stays reliable. Skipped when
		// restoring fullscreen (setSize would fight the fullscreen transition).
		//
		// It waits for dom-ready because resizing a window whose webview never came
		// up is fatal, not cosmetic: on Windows a failed WebView2 controller plus
		// this nudge segfaults the native wrapper (decision 177). dom-ready is also
		// when the nudge is meant to happen — it exists to fix the FIRST PAINT.
		let nudged = false;
		win.webview.on("dom-ready", () => {
			if (nudged) return; // a reload re-fires dom-ready; one nudge per window
			nudged = true;
			if (needsFrameApply) {
				try {
					win.setFrame(frame.x, frame.y, frame.width, frame.height);
				} catch (err) {
					log.warn("Applying the window frame failed", { error: String(err) });
				}
			}
			setTimeout(() => {
				try {
					const size = win.getSize();
					win.setSize(size.width, size.height - 1);
					setTimeout(() => {
						try { win.setSize(size.width, size.height); } catch { /* ignore */ }
					}, 50);
				} catch (err) {
					log.warn("Resize nudge failed", { error: String(err) });
				}
			}, 200);
		});
	}

	if (opts.onDomReady) {
		win.webview.on("dom-ready", () => opts.onDomReady!(win));
	}

	if (opts.onExternalLink) {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		(win.webview as any).on("new-window-open", (e: any) => {
			const url = e.data?.detail?.url;
			if (typeof url === "string" && /^https?:\/\//.test(url)) {
				opts.onExternalLink!(url);
			} else {
				log.warn("Blocked new-window-open with unexpected URL", { data: e.data });
			}
		});
	}

	opts.onCreated?.(win);
	return win;
}

// `openMainWindow` lives in index.ts (it wires app-specific config). We register
// it here so RPC handlers can open a new window without importing index.ts
// (which would be a circular dependency). Mirrors the setOnPtyDied/setPushMessage
// injection pattern.
let openNewWindowImpl: (() => void) | null = null;

export function setOpenNewWindow(fn: () => void): void {
	openNewWindowImpl = fn;
}

export function openNewWindow(): void {
	openNewWindowImpl?.();
}

function firstWindow(): BrowserWindow | null {
	const iter = windows.values().next();
	return iter.value ? iter.value.window : null;
}

/** Window that most recently had focus, falling back to any open window. */
export function getFocusedWindow(): BrowserWindow | null {
	if (focusedWindow && isTracked(focusedWindow)) return focusedWindow;
	return firstWindow();
}

function isTracked(win: BrowserWindow): boolean {
	for (const entry of windows) {
		if (entry.window === win) return true;
	}
	return false;
}

export function getAllWindows(): BrowserWindow[] {
	return Array.from(windows, (entry) => entry.window);
}

export function getWindowCount(): number {
	return windows.size;
}

/**
 * Send a push message to every open window. Used for events that represent
 * global app state (PTY died, ports updated, update progress, etc.) — each
 * renderer keeps its own state and needs to hear about all of them.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function broadcastToAllWindows(name: string, payload: any): void {
	for (const win of getAllWindows()) {
		try {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const send = (win.webview.rpc as any)?.send;
			if (name === "qrTokenConsumed") {
				send?.qrTokenConsumed?.(payload ?? {});
			} else {
				send?.[name]?.(payload);
			}
		} catch (err) {
			log.debug("Broadcast failed for one window", { name, error: String(err) });
		}
	}
}

/**
 * Bring the focused (or any open) window to the front with key focus, and
 * activate the app. Used when a quit is triggered from the dock context menu
 * (right-click → Quit): macOS does NOT activate the app in that case, so a
 * confirmation dialog shown in the window would sit behind other apps and look
 * like the app froze. Returns true if a window was focused.
 */
export function focusFocusedWindow(): boolean {
	const win = getFocusedWindow();
	if (!win) return false;
	try {
		win.focus();
		return true;
	} catch (err) {
		log.debug("focusFocusedWindow failed", { error: String(err) });
		return false;
	}
}

/** Send a push message to the focused window only (menu-action pattern). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function sendToFocusedWindow(name: string, payload: any = {}): void {
	const win = getFocusedWindow();
	if (!win) return;
	try {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		(win.webview.rpc as any).send[name]?.(payload);
	} catch (err) {
		log.debug("sendToFocusedWindow failed", { name, error: String(err) });
	}
}

/** Test-only: reset in-memory state between test cases. */
export function __resetForTests(): void {
	windows.clear();
	focusedWindow = null;
	seq = 0;
}
