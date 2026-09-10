import { describe, it, expect, vi, beforeEach } from "vitest";

// Multi-window session persistence: every open window is remembered, a window
// closed on purpose is forgotten, and a quit teardown is not mistaken for one.

type FakeWindow = {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	webview: any;
	getSize: ReturnType<typeof vi.fn>;
	setSize: ReturnType<typeof vi.fn>;
	getFrame: ReturnType<typeof vi.fn>;
	setFrame: ReturnType<typeof vi.fn>;
	isFullScreen: ReturnType<typeof vi.fn>;
	setFullScreen: ReturnType<typeof vi.fn>;
	setTitle: ReturnType<typeof vi.fn>;
	focus: ReturnType<typeof vi.fn>;
	on: ReturnType<typeof vi.fn>;
	handlers: Record<string, () => void>;
	frame?: { x: number; y: number; width: number; height: number };
};

const globalBag = globalThis as typeof globalThis & { __sessionWindows: FakeWindow[] };
globalBag.__sessionWindows = [];
const createdWindows: FakeWindow[] = globalBag.__sessionWindows;

const LAPTOP = { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1080 }, isPrimary: true };
const EXTERNAL = { id: 2, bounds: { x: 1920, y: 0, width: 2560, height: 1440 }, workArea: { x: 1920, y: 0, width: 2560, height: 1440 } };

const displayBag = globalThis as typeof globalThis & { __displays: unknown[] };
displayBag.__displays = [LAPTOP, EXTERNAL];

vi.mock("electrobun/bun", () => {
	const bag = globalThis as typeof globalThis & { __sessionWindows: FakeWindow[]; __displays: typeof LAPTOP[] };
	class FakeBrowserWindow {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		webview: any;
		getSize = vi.fn(() => ({ width: 800, height: 600 }));
		setSize = vi.fn();
		getFrame: ReturnType<typeof vi.fn>;
		setFrame: ReturnType<typeof vi.fn>;
		isFullScreen = vi.fn(() => false);
		setFullScreen = vi.fn();
		setTitle = vi.fn();
		focus = vi.fn();
		on: ReturnType<typeof vi.fn>;
		handlers: Record<string, () => void> = {};
		frame?: { x: number; y: number; width: number; height: number };
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		constructor(opts?: any) {
			this.frame = opts?.frame;
			this.webview = {
				rpc: { send: {} },
				openDevTools: vi.fn(),
				on: vi.fn(),
			};
			this.getFrame = vi.fn(() => this.frame ?? { x: 0, y: 0, width: 800, height: 600 });
			this.setFrame = vi.fn((x: number, y: number, width: number, height: number) => {
				this.frame = { x, y, width, height };
			});
			this.on = vi.fn((name: string, handler: () => void) => {
				this.handlers[name] = handler;
			});
			bag.__sessionWindows.push(this as unknown as FakeWindow);
		}
	}
	return {
		BrowserView: { defineRPC: vi.fn(() => ({ setTransport: vi.fn() })) },
		BrowserWindow: FakeBrowserWindow,
		Screen: {
			getPrimaryDisplay: () => bag.__displays[0],
			getAllDisplays: () => bag.__displays,
		},
	};
});

// In-memory disk: the real window-state serialization runs, nothing touches ~/.dev3.0.
const files = new Map<string, string>();
vi.mock("node:fs", () => ({
	existsSync: (p: string) => files.has(p),
	readFileSync: (p: string) => {
		const v = files.get(p);
		if (v === undefined) throw new Error(`ENOENT ${p}`);
		return v;
	},
	writeFileSync: (p: string, data: string) => void files.set(p, data),
	mkdirSync: vi.fn(),
}));

vi.mock("../logger", () => ({
	createLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { createAppWindow, flushWindowState, loadWindowSession, __resetForTests } from "../window-manager";
import { markQuitConfirmed, __resetQuitConfirmedForTests } from "../quit-manager";
import type { WindowState } from "../window-state";

function spawn(restore?: WindowState) {
	return createAppWindow({ title: "dev-3.0", url: "views://mainview/index.html", handlers: {}, restore });
}

/** Fire every dom-ready listener the window registered. */
function domReady(win: FakeWindow): void {
	for (const call of win.webview.on.mock.calls as [string, () => void][]) {
		if (call[0] === "dom-ready") call[1]();
	}
}

/** The persisted session, read back exactly the way a launch reads it. */
function savedSession(): WindowState[] {
	return loadWindowSession();
}

beforeEach(() => {
	createdWindows.length = 0;
	files.clear();
	displayBag.__displays = [LAPTOP, EXTERNAL];
	__resetForTests();
	__resetQuitConfirmedForTests();
	vi.useFakeTimers();
});

describe("multi-window session persistence", () => {
	it("remembers every open window, with its own frame and display", () => {
		spawn();
		spawn();
		createdWindows[0].frame = { x: 10, y: 20, width: 800, height: 600 };
		createdWindows[1].frame = { x: 2000, y: 100, width: 1200, height: 900 };

		flushWindowState();

		const session = savedSession();
		expect(session).toHaveLength(2);
		expect(session[0].frame).toEqual({ x: 10, y: 20, width: 800, height: 600 });
		expect(session[0].displayId).toBe(1);
		expect(session[1].frame).toEqual({ x: 2000, y: 100, width: 1200, height: 900 });
		expect(session[1].displayId).toBe(2);
	});

	it("records a fullscreen window with the frame it would exit into", () => {
		spawn();
		const win = createdWindows[0];
		// Windowed first, so the pre-fullscreen frame is the one on record.
		win.frame = { x: 100, y: 100, width: 900, height: 700 };
		win.handlers.resize?.();
		vi.advanceTimersByTime(600);

		win.isFullScreen.mockReturnValue(true);
		win.frame = { x: 0, y: 0, width: 1920, height: 1080 };
		flushWindowState();

		const [state] = savedSession();
		expect(state.fullscreen).toBe(true);
		expect(state.frame).toEqual({ x: 100, y: 100, width: 900, height: 700 });
	});

	it("forgets a window the user closed, and keeps the rest", () => {
		spawn();
		spawn();
		createdWindows[0].frame = { x: 10, y: 20, width: 800, height: 600 };
		createdWindows[1].frame = { x: 2000, y: 100, width: 1200, height: 900 };
		flushWindowState();

		createdWindows[1].handlers.close?.();

		const session = savedSession();
		expect(session).toHaveLength(1);
		expect(session[0].frame).toEqual({ x: 10, y: 20, width: 800, height: 600 });
	});

	it("keeps the whole session when the windows close as part of a quit", () => {
		spawn();
		spawn();
		flushWindowState();
		expect(savedSession()).toHaveLength(2);

		markQuitConfirmed();
		createdWindows[0].handlers.close?.();
		createdWindows[1].handlers.close?.();

		expect(savedSession()).toHaveLength(2);
	});

	it("keeps the last snapshot when the final window closes, so the dock still reopens somewhere sane", () => {
		spawn();
		createdWindows[0].frame = { x: 10, y: 20, width: 800, height: 600 };
		flushWindowState();

		createdWindows[0].handlers.close?.();

		expect(savedSession()).toHaveLength(1);
	});

	it("debounced move/resize saves cover every open window", () => {
		spawn();
		spawn();
		createdWindows[0].frame = { x: 5, y: 5, width: 700, height: 500 };
		createdWindows[1].frame = { x: 2100, y: 15, width: 800, height: 600 };

		createdWindows[1].handlers.move?.();
		vi.advanceTimersByTime(600);

		expect(savedSession().map((s) => s.frame.x)).toEqual([5, 2100]);
	});
});

describe("restoring a saved session", () => {
	const onExternal: WindowState = {
		frame: { x: 2100, y: 100, width: 1000, height: 800 },
		fullscreen: false,
		displayId: 2,
		displayBounds: EXTERNAL.bounds,
	};

	it("places a restored window on its saved screen", () => {
		spawn(onExternal);
		expect(createdWindows[0].frame).toEqual(onExternal.frame);
	});

	it("re-enters fullscreen for a window saved fullscreen", () => {
		spawn({ ...onExternal, fullscreen: true });
		const win = createdWindows[0];
		// The fullscreen call is deferred to dom-ready, then a short timeout.
		domReady(win);
		vi.advanceTimersByTime(200);
		expect(win.setFullScreen).toHaveBeenCalledWith(true);
	});

	it("falls back to a visible default when the saved display is gone", () => {
		displayBag.__displays = [LAPTOP];
		spawn(onExternal);

		const frame = createdWindows[0].frame!;
		expect(frame.x).toBeGreaterThanOrEqual(0);
		expect(frame.x + frame.width).toBeLessThanOrEqual(LAPTOP.bounds.width);
		expect(frame.y + frame.height).toBeLessThanOrEqual(LAPTOP.bounds.height);
	});

	it("clamps a saved frame that no longer fits its display", () => {
		displayBag.__displays = [{ ...LAPTOP, bounds: { x: 0, y: 0, width: 1280, height: 720 }, workArea: { x: 0, y: 0, width: 1280, height: 720 } }, EXTERNAL];
		spawn({ frame: { x: 900, y: 600, width: 1600, height: 1000 }, fullscreen: false, displayId: 1, displayBounds: LAPTOP.bounds });

		expect(createdWindows[0].frame).toEqual({ x: 0, y: 0, width: 1280, height: 720 });
	});

	it("re-applies the frame of a second window at dom-ready, which the create option alone never reaches", () => {
		spawn();
		spawn(onExternal);
		const win = createdWindows[1];
		expect(win.setFrame).not.toHaveBeenCalled(); // too early at construction — it would move the wrong window

		domReady(win);

		expect(win.setFrame).toHaveBeenCalledWith(2100, 100, 1000, 800);
	});

	it("leaves the first window's frame to the create option", () => {
		spawn(onExternal);
		domReady(createdWindows[0]);
		expect(createdWindows[0].setFrame).not.toHaveBeenCalled();
	});

	it("a window opened while others are up is not given the saved geometry", () => {
		spawn(onExternal);
		spawn();

		expect(createdWindows[1].frame).not.toEqual(onExternal.frame);
	});
});
