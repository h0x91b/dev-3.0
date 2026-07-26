import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Distinctive saved window state — a small off-center windowed frame in native
// fullscreen. Non-fresh launches restore it; fresh-start (dev) launches ignore it.
const SAVED_FRAME = { x: 100, y: 200, width: 1000, height: 700 };
const SAVED_STATE = {
	frame: SAVED_FRAME,
	fullscreen: true,
	displayId: 1,
	displayBounds: { x: 0, y: 0, width: 1920, height: 1080 },
};

type FakeWindow = {
	webview: { rpc: { send: Record<string, ReturnType<typeof vi.fn>> }; openDevTools: ReturnType<typeof vi.fn>; on: ReturnType<typeof vi.fn> };
	getSize: ReturnType<typeof vi.fn>;
	setSize: ReturnType<typeof vi.fn>;
	getFrame: ReturnType<typeof vi.fn>;
	isFullScreen: ReturnType<typeof vi.fn>;
	setFullScreen: ReturnType<typeof vi.fn>;
	focus: ReturnType<typeof vi.fn>;
	on: ReturnType<typeof vi.fn>;
	handlers: Record<string, () => void>;
	frame?: { x: number; y: number; width: number; height: number };
};

const globalBag = globalThis as typeof globalThis & { __fakeWindows: FakeWindow[] };
globalBag.__fakeWindows = [];
const createdWindows: FakeWindow[] = globalBag.__fakeWindows;

vi.mock("electrobun/bun", () => {
	const bag = globalThis as typeof globalThis & { __fakeWindows: FakeWindow[] };
	class FakeBrowserWindow {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		webview: any;
		getSize: ReturnType<typeof vi.fn>;
		setSize: ReturnType<typeof vi.fn>;
		getFrame: ReturnType<typeof vi.fn>;
		isFullScreen: ReturnType<typeof vi.fn>;
		setFullScreen: ReturnType<typeof vi.fn>;
		focus: ReturnType<typeof vi.fn>;
		on: ReturnType<typeof vi.fn>;
		handlers: Record<string, () => void>;
		frame?: { x: number; y: number; width: number; height: number };
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		constructor(opts?: any) {
			this.frame = opts?.frame;
			const handlers: Record<string, () => void> = {};
			this.webview = {
				rpc: { send: new Proxy({} as Record<string, ReturnType<typeof vi.fn>>, { get(t, p: string) { if (!(p in t)) t[p] = vi.fn(); return t[p]; } }) },
				openDevTools: vi.fn(),
				on: vi.fn(),
			};
			this.getSize = vi.fn(() => ({ width: 800, height: 600 }));
			this.setSize = vi.fn();
			this.getFrame = vi.fn(() => this.frame ?? { x: 0, y: 0, width: 800, height: 600 });
			this.isFullScreen = vi.fn(() => false);
			this.setFullScreen = vi.fn();
			this.focus = vi.fn();
			this.on = vi.fn((name: string, handler: () => void) => { handlers[name] = handler; });
			this.handlers = handlers;
			bag.__fakeWindows.push(this as unknown as FakeWindow);
		}
	}
	return {
		BrowserView: { defineRPC: vi.fn(() => ({ setTransport: vi.fn() })) },
		BrowserWindow: FakeBrowserWindow,
		Screen: {
			getPrimaryDisplay: () => ({ id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1080 } }),
			getAllDisplays: () => [{ id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1080 } }],
		},
	};
});

// Feed loadWindowState() a real saved state so we can prove fresh mode ignores it.
vi.mock("node:fs", () => ({
	existsSync: () => true,
	readFileSync: () => JSON.stringify(SAVED_STATE),
	writeFileSync: vi.fn(),
	mkdirSync: vi.fn(),
}));

vi.mock("../logger", () => ({
	createLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { createAppWindow, __resetForTests } from "../window-manager";

const ORIGINAL = process.env.DEV3_FRESH_START;

beforeEach(() => {
	createdWindows.length = 0;
	__resetForTests();
	vi.useFakeTimers();
});

afterEach(() => {
	if (ORIGINAL === undefined) delete process.env.DEV3_FRESH_START;
	else process.env.DEV3_FRESH_START = ORIGINAL;
});

function spawn() {
	return createAppWindow({ title: "dev-3.0", url: "views://mainview/index.html", handlers: {} });
}

/** Fire every registered dom-ready listener, then let their timers run. */
function reportDomReady(win: FakeWindow): void {
	for (const [event, handler] of win.webview.on.mock.calls) {
		if (event === "dom-ready") (handler as () => void)();
	}
	vi.advanceTimersByTime(500);
}

describe("window-manager fresh-start mode", () => {
	it("restores the saved geometry when fresh-start is off", () => {
		delete process.env.DEV3_FRESH_START;
		spawn();
		expect(createdWindows[0].frame).toEqual(SAVED_FRAME);
		// Fullscreen restore happens on dom-ready, and replaces the resize nudge.
		reportDomReady(createdWindows[0]);
		expect(createdWindows[0].setFullScreen).toHaveBeenCalledWith(true);
		expect(createdWindows[0].setSize).not.toHaveBeenCalled();
		// Geometry persistence listeners are attached.
		expect(createdWindows[0].handlers.move).toBeTypeOf("function");
		expect(createdWindows[0].handlers.resize).toBeTypeOf("function");
	});

	it("ignores the saved geometry and opens a centered window when fresh-start is on", () => {
		process.env.DEV3_FRESH_START = "1";
		spawn();
		// 95% of 1920×1080, centered → 1824×1026 at (48, 27) — NOT the saved frame.
		expect(createdWindows[0].frame).toEqual({ x: 48, y: 27, width: 1824, height: 1026 });
		// No fullscreen restore — the first-paint resize nudge runs instead.
		reportDomReady(createdWindows[0]);
		expect(createdWindows[0].setFullScreen).not.toHaveBeenCalled();
		expect(createdWindows[0].setSize).toHaveBeenCalled();
		// No geometry persistence listeners — dev must not clobber shared state.
		expect(createdWindows[0].handlers.move).toBeUndefined();
		expect(createdWindows[0].handlers.resize).toBeUndefined();
	});

	// Regression guard for the Windows segfault (decision 177): resizing a window
	// whose webview never initialized reaches an invalid native wrapper and kills
	// the process, so NOTHING may size the window before the renderer reports in.
	it("never touches window size before the renderer reports dom-ready", () => {
		delete process.env.DEV3_FRESH_START;
		spawn();
		vi.advanceTimersByTime(60_000);
		expect(createdWindows[0].getSize).not.toHaveBeenCalled();
		expect(createdWindows[0].setSize).not.toHaveBeenCalled();
		expect(createdWindows[0].setFullScreen).not.toHaveBeenCalled();
	});

	it("nudges the first paint only once, even if dom-ready fires again", () => {
		process.env.DEV3_FRESH_START = "1";
		spawn();
		reportDomReady(createdWindows[0]);
		const afterFirst = createdWindows[0].setSize.mock.calls.length;
		reportDomReady(createdWindows[0]);
		expect(createdWindows[0].setSize.mock.calls.length).toBe(afterFirst);
	});
});
