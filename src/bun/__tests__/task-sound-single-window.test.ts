/**
 * One finished task must make one sound, however many windows are open.
 *
 * A completion that no renderer played locally (CLI, approval dialog, merge
 * auto-complete) is announced with the `taskSound` push. That push used to take
 * the same route as state events — every window — so a user with two windows on
 * one machine heard the chime twice for a single completion.
 *
 * This goes through the REAL window-manager with two real tracked windows,
 * because the bug lived in the fan-out, not in anything a mocked helper would
 * show. `push-targets.test.ts` covers the routing decision itself.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

type FakeWindow = { webview: { rpc: { send: Record<string, ReturnType<typeof vi.fn>> } } };

const globalBag = globalThis as typeof globalThis & { __soundWindows: FakeWindow[] };
globalBag.__soundWindows = [];
const createdWindows = globalBag.__soundWindows;

vi.mock("electrobun/bun", () => {
	const bag = globalThis as typeof globalThis & { __soundWindows: FakeWindow[] };
	class FakeBrowserWindow {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		webview: any;
		getSize = vi.fn(() => ({ width: 800, height: 600 }));
		setSize = vi.fn();
		getFrame = vi.fn(() => ({ x: 0, y: 0, width: 800, height: 600 }));
		setFrame = vi.fn();
		isFullScreen = vi.fn(() => false);
		setFullScreen = vi.fn();
		setTitle = vi.fn();
		focus = vi.fn();
		handlers: Record<string, () => void> = {};
		on = vi.fn((name: string, handler: () => void) => {
			this.handlers[name] = handler;
		});
		constructor() {
			const send: Record<string, ReturnType<typeof vi.fn>> = {};
			this.webview = {
				rpc: {
					send: new Proxy(send, {
						get(target, prop: string) {
							if (!(prop in target)) target[prop] = vi.fn();
							return target[prop];
						},
					}),
				},
				openDevTools: vi.fn(),
				on: vi.fn(),
			};
			bag.__soundWindows.push(this as unknown as FakeWindow);
		}
	}
	return {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		BrowserView: { defineRPC: vi.fn((opts: any) => ({ setTransport: vi.fn(), __requests: opts?.handlers?.requests ?? {} })) },
		BrowserWindow: FakeBrowserWindow,
		Screen: {
			getPrimaryDisplay: () => ({ id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1080 } }),
			getAllDisplays: () => [{ id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1080 } }],
		},
	};
});

// Keep createAppWindow on its default placement path, away from the real
// ~/.dev3.0/window-state.json.
vi.mock("node:fs", () => ({
	existsSync: () => false,
	readFileSync: vi.fn(),
	writeFileSync: vi.fn(),
	mkdirSync: vi.fn(),
}));

vi.mock("../logger", () => ({
	createLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const pushToBrowserClients = vi.fn();
vi.mock("../remote-access-server", () => ({ pushToBrowserClients }));

const { createAppWindow, __resetForTests } = await import("../window-manager");
const { pushEverywhere } = await import("../push-targets");

function spawn() {
	return createAppWindow({ title: "dev-3.0", url: "views://mainview/index.html", handlers: {} });
}

function soundCallCounts(): number[] {
	return createdWindows.map((win) => win.webview.rpc.send.taskSound.mock.calls.length);
}

beforeEach(() => {
	createdWindows.length = 0;
	pushToBrowserClients.mockClear();
	__resetForTests();
	vi.useFakeTimers();
});

describe("taskSound across multiple windows", () => {
	it("chimes once for one completion with two windows open", () => {
		spawn();
		spawn();

		pushEverywhere("taskSound", { status: "completed", taskId: "task-1" });

		const counts = soundCallCounts();
		expect(
			counts.reduce((sum, n) => sum + n, 0),
			`Cause: the taskSound push reached ${counts.length} windows (${counts.join(", ")} chimes) — ` +
				"two windows on one machine share one pair of speakers, so the user hears the chime twice.\n" +
				"Fix: keep `taskSound` in SINGLE_WINDOW_PUSHES in src/bun/push-targets.ts.",
		).toBe(1);
	});

	it("plays in the window the user last focused", () => {
		spawn();
		const second = spawn();
		// createAppWindow marks the newest window focused; move focus back to the
		// first one the way a real click does.
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		(createdWindows[0] as any).handlers.focus?.();

		pushEverywhere("taskSound", { status: "completed", taskId: "task-1" });

		expect(soundCallCounts()).toEqual([1, 0]);
		expect(second).toBeTruthy();
	});

	it("still carries the payload to remote browsers", () => {
		spawn();
		spawn();
		const payload = { status: "cancelled", taskId: "task-2" };

		pushEverywhere("taskSound", payload);

		expect(pushToBrowserClients).toHaveBeenCalledWith("taskSound", payload);
	});

	it("leaves state events broadcasting to every window", () => {
		spawn();
		spawn();

		pushEverywhere("ptyDied", { taskId: "task-3" });

		expect(createdWindows.map((win) => win.webview.rpc.send.ptyDied.mock.calls.length)).toEqual([1, 1]);
	});
});
