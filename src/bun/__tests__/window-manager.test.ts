import { describe, it, expect, vi, beforeEach } from "vitest";

// Shared registry populated by the mocked BrowserWindow constructor.
// Tests peek at it to trigger focus/close handlers on individual windows.
type FakeWindow = {
	webview: {
		rpc: { send: Record<string, ReturnType<typeof vi.fn>> };
		openDevTools: ReturnType<typeof vi.fn>;
		on: ReturnType<typeof vi.fn>;
	};
	getSize: ReturnType<typeof vi.fn>;
	setSize: ReturnType<typeof vi.fn>;
	on: ReturnType<typeof vi.fn>;
	handlers: Record<string, () => void>;
	frame?: { x: number; y: number; width: number; height: number };
};

// vi.mock is hoisted, so the registry must live on globalThis rather than a
// local const (which wouldn't exist at hoist time).
const globalBag = globalThis as typeof globalThis & { __fakeWindows: FakeWindow[] };
globalBag.__fakeWindows = [];
const createdWindows: FakeWindow[] = globalBag.__fakeWindows;

vi.mock("electrobun/bun", () => {
	const bag = (globalThis as typeof globalThis & { __fakeWindows: FakeWindow[] });
	class FakeBrowserWindow {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		webview: any;
		getSize: ReturnType<typeof vi.fn>;
		setSize: ReturnType<typeof vi.fn>;
		on: ReturnType<typeof vi.fn>;
		handlers: Record<string, () => void>;
		frame?: { x: number; y: number; width: number; height: number };
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		constructor(opts?: any) {
			this.frame = opts?.frame;
			const fakeSend: Record<string, ReturnType<typeof vi.fn>> = {};
			const handlers: Record<string, () => void> = {};
			this.webview = {
				rpc: {
					send: new Proxy(fakeSend, {
						get(target, prop: string) {
							if (!(prop in target)) target[prop] = vi.fn();
							return target[prop];
						},
					}),
				},
				openDevTools: vi.fn(),
				on: vi.fn(),
			};
			this.getSize = vi.fn(() => ({ width: 800, height: 600 }));
			this.setSize = vi.fn();
			this.on = vi.fn((name: string, handler: () => void) => {
				handlers[name] = handler;
			});
			this.handlers = handlers;
			bag.__fakeWindows.push(this as unknown as FakeWindow);
		}
	}
	return {
		BrowserView: {
			defineRPC: vi.fn(() => ({ setTransport: vi.fn() })),
		},
		BrowserWindow: FakeBrowserWindow,
		Screen: {
			getPrimaryDisplay: () => ({
				workArea: { x: 0, y: 0, width: 1920, height: 1080 },
			}),
		},
	};
});

vi.mock("../logger", () => ({
	createLogger: () => ({
		info: vi.fn(),
		debug: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	}),
}));

import {
	createAppWindow,
	broadcastToAllWindows,
	sendToFocusedWindow,
	getFocusedWindow,
	getAllWindows,
	getWindowCount,
	__resetForTests,
} from "../window-manager";

beforeEach(() => {
	createdWindows.length = 0;
	__resetForTests();
	vi.useFakeTimers();
});

describe("window-manager", () => {
	function spawn() {
		return createAppWindow({
			title: "dev-3.0",
			url: "views://mainview/index.html",
			handlers: {},
		});
	}

	it("registers new windows and exposes them via getAllWindows", () => {
		spawn();
		spawn();

		expect(getWindowCount()).toBe(2);
		expect(getAllWindows()).toHaveLength(2);
	});

	it("broadcasts push messages to every window", () => {
		spawn();
		spawn();

		broadcastToAllWindows("portsUpdated", { taskId: "abc", ports: [] });

		for (const win of createdWindows) {
			expect(win.webview.rpc.send.portsUpdated).toHaveBeenCalledWith({ taskId: "abc", ports: [] });
		}
	});

	it("sends menu actions to the focused window only", () => {
		spawn();
		const second = createdWindows[0]; // only one in scope
		spawn();

		// Simulate focus landing on the second window
		const secondWin = createdWindows[1];
		secondWin.handlers.focus?.();

		sendToFocusedWindow("navigateToSettings");

		expect(secondWin.webview.rpc.send.navigateToSettings).toHaveBeenCalledWith({});
		expect(second.webview.rpc.send.navigateToSettings).not.toHaveBeenCalled();
	});

	it("removes windows on close and falls back to another focused window", () => {
		spawn();
		spawn();

		const [first, second] = createdWindows;
		// Focus second, then close it — focused should roll back to first.
		second.handlers.focus?.();
		second.handlers.close?.();

		expect(getWindowCount()).toBe(1);
		expect(getFocusedWindow()).toBe(first);

		// Closing the last window leaves no focused window. Electrobun will
		// auto-quit in the real app; the registry simply goes empty here.
		first.handlers.close?.();
		expect(getWindowCount()).toBe(0);
		expect(getFocusedWindow()).toBe(null);
	});

	it("clamps cascade offset so windows stay within the work area", () => {
		// Mock workArea: 1920×1080. With RATIO=0.95:
		//   window size = 1824×1026, centered at (48, 27).
		//   max x = 1920-1824 = 96, max y = 1080-1026 = 54.
		// Second window (offset=40): unclamped y=67 would exceed maxY=54.
		spawn(); // size=0 before → offset=0
		spawn(); // size=1 before → offset=40

		const [, secondWin] = createdWindows;
		// y must not exceed wa.height - window.height (= 1080 - 1026 = 54)
		expect(secondWin.frame?.y).toBeLessThanOrEqual(54);
		// x must not exceed wa.width - window.width (= 1920 - 1824 = 96)
		expect(secondWin.frame?.x).toBeLessThanOrEqual(96);
	});

	it("invokes onClosed with the remaining window count", () => {
		const onClosed = vi.fn();
		createAppWindow({
			title: "dev-3.0",
			url: "views://mainview/index.html",
			handlers: {},
			onClosed,
		});
		createAppWindow({
			title: "dev-3.0",
			url: "views://mainview/index.html",
			handlers: {},
		});

		const [first] = createdWindows;
		first.handlers.close?.();

		expect(onClosed).toHaveBeenCalledTimes(1);
		expect(onClosed.mock.calls[0][1]).toBe(1);
	});
});
