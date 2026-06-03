import { BrowserView, BrowserWindow, Screen } from "electrobun/bun";
import type { AppRPCSchema } from "../shared/types";
import { createLogger } from "./logger";

const log = createLogger("window-manager");

type WindowEntry = { window: BrowserWindow; id: number };

// Registry of every dev-3.0 window that is currently open.
// We keep our own set (in addition to Electrobun's internal BrowserWindowMap)
// so we can track focus order, broadcast push messages, and target the
// focused window from application-menu handlers.
const windows = new Set<WindowEntry>();
let focusedWindow: BrowserWindow | null = null;
let seq = 0;

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
	const rpc = BrowserView.defineRPC<AppRPCSchema>({
		maxRequestTime: opts.maxRequestTime ?? 120_000,
		handlers: {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			requests: opts.handlers as any,
			messages: {},
		},
	});

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

	const win = new BrowserWindow({
		title: opts.title,
		url: opts.url,
		rpc,
		frame: { width, height, x, y },
	});

	const id = ++seq;
	const entry: WindowEntry = { window: win, id };
	windows.add(entry);
	focusedWindow = win;
	log.info("Window created", { id, total: windows.size });

	win.on("focus", () => {
		focusedWindow = win;
		log.debug("Window focused", { id });
		opts.onFocus?.(win);
	});

	win.on("close", () => {
		windows.delete(entry);
		if (focusedWindow === win) {
			focusedWindow = firstWindow();
		}
		log.info("Window closed", { id, remaining: windows.size });
		opts.onClosed?.(win, windows.size);
	});

	// WKWebView clips the bottom ~16px after the first paint on some macOS
	// versions. A quick resize nudge forces the viewport into the post-resize
	// layout immediately so the app's pb-8 padding stays reliable.
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
