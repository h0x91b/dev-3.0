import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { defineRPCMock, adjustZoomMock, applyZoomMock, pingMock, initSocketToBunMock } = vi.hoisted(() => ({
	defineRPCMock: vi.fn(),
	adjustZoomMock: vi.fn(),
	applyZoomMock: vi.fn(),
	pingMock: vi.fn(),
	initSocketToBunMock: vi.fn(),
}));

vi.mock("electrobun/view", () => {
	class ElectroviewMock {
		static defineRPC = defineRPCMock;
		rpc = { request: { ping: pingMock } };
		bunSocket = { close: vi.fn() };
		initSocketToBun = initSocketToBunMock;

		constructor(_options: unknown) {}
	}

	return { Electroview: ElectroviewMock };
});

vi.mock("../zoom", () => ({
	adjustZoom: adjustZoomMock,
	applyZoom: applyZoomMock,
	ZOOM_STEP: 0.1,
	DEFAULT_ZOOM: 1,
}));

describe("Electrobun RPC transport", () => {
	beforeEach(() => {
		vi.resetModules();
		defineRPCMock.mockReset();
		adjustZoomMock.mockReset();
		applyZoomMock.mockReset();
		(window as any).__electrobunWebviewId = "test-webview";
	});

	afterEach(() => {
		delete (window as any).__electrobunWebviewId;
	});

	it("registers desktop-only message handlers for zoom, OSC 52 clipboard, and QR token consumption", async () => {
		const qrTokenConsumedListener = vi.fn();
		const osc52ClipboardListener = vi.fn();
		window.addEventListener("rpc:qrTokenConsumed", qrTokenConsumedListener);
		window.addEventListener("rpc:osc52Clipboard", osc52ClipboardListener);

		await import("../rpc");

		const rpcConfig = defineRPCMock.mock.calls[0]?.[0];
		expect(rpcConfig).toBeDefined();

		rpcConfig.handlers.messages.zoomIn({});
		rpcConfig.handlers.messages.zoomOut({});
		rpcConfig.handlers.messages.zoomReset({});
		rpcConfig.handlers.messages.osc52Clipboard({ taskId: "task-1", text: "copied", len: 6 });
		rpcConfig.handlers.messages.qrTokenConsumed({});

		expect(adjustZoomMock).toHaveBeenNthCalledWith(1, 0.1);
		expect(adjustZoomMock).toHaveBeenNthCalledWith(2, -0.1);
		expect(applyZoomMock).toHaveBeenCalledWith(1);
		expect(osc52ClipboardListener).toHaveBeenCalledTimes(1);
		expect(osc52ClipboardListener.mock.calls[0]?.[0]).toMatchObject({
			detail: { taskId: "task-1", text: "copied", len: 6 },
		});
		expect(qrTokenConsumedListener).toHaveBeenCalledTimes(1);

		window.removeEventListener("rpc:qrTokenConsumed", qrTokenConsumedListener);
		window.removeEventListener("rpc:osc52Clipboard", osc52ClipboardListener);
	});

	// h0x91b/dev-3.0#1669: a re-opened bridge lost every push sent while it was
	// dead, so the first live ping afterwards must announce the reconnect — that
	// is what replays pending approval dialogs.
	it("announces a reconnect once a re-initialised bridge answers a ping", async () => {
		vi.useFakeTimers();
		pingMock.mockReset().mockResolvedValue(undefined);
		initSocketToBunMock.mockReset();
		const states: string[] = [];
		const onStatus = (e: Event) => states.push((e as CustomEvent).detail.state);
		window.addEventListener("dev3:rpcStatus", onStatus);
		try {
			await import("../rpc");
			await vi.advanceTimersByTimeAsync(30_000); // alive
			states.length = 0;

			pingMock.mockReturnValue(new Promise(() => {})); // bridge dies
			await vi.advanceTimersByTimeAsync(30_000 + 30_000 + 4_000); // two pings time out
			expect(initSocketToBunMock).toHaveBeenCalledTimes(1);
			expect(states).toEqual([]);

			pingMock.mockResolvedValue(undefined); // the re-opened socket answers
			await vi.advanceTimersByTimeAsync(2_000); // the quick probe, not the 30s tick
			expect(states).toEqual(["connected"]);
		} finally {
			window.removeEventListener("dev3:rpcStatus", onStatus);
			vi.useRealTimers();
		}
	});

	it("registers no openTaskFromNotification handler — OS notification clicks never navigate", async () => {
		await import("../rpc");

		const rpcConfig = defineRPCMock.mock.calls[0]?.[0];
		expect(rpcConfig).toBeDefined();
		expect(rpcConfig.handlers.messages.openTaskFromNotification).toBeUndefined();
	});

	it("dispatches a CustomEvent when the native menu pushes openAddProjectModal", async () => {
		const listener = vi.fn();
		window.addEventListener("rpc:openAddProjectModal", listener);

		await import("../rpc");

		const rpcConfig = defineRPCMock.mock.calls[0]?.[0];
		expect(rpcConfig).toBeDefined();

		expect(typeof rpcConfig.handlers.messages.openAddProjectModal).toBe("function");
		rpcConfig.handlers.messages.openAddProjectModal({});

		expect(listener).toHaveBeenCalledTimes(1);

		window.removeEventListener("rpc:openAddProjectModal", listener);
	});
});

describe("Browser RPC transport", () => {
	beforeEach(() => {
		vi.resetModules();
		vi.clearAllMocks();
		vi.unstubAllGlobals();
		localStorage.clear();
		delete (window as any).__electrobunWebviewId;
		document.documentElement.classList.remove("browser-mode");
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
		document.documentElement.classList.remove("browser-mode");
	});

	it("rejects in-flight requests immediately when the browser websocket closes", async () => {
		const sockets: MockWebSocket[] = [];
		// Boot with a valid session cookie: the refresh probe succeeds and the
		// machine opens the RPC socket.
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200 }));

		class MockWebSocket {
			static CONNECTING = 0;
			static OPEN = 1;
			static CLOSING = 2;
			static CLOSED = 3;

			readyState = MockWebSocket.CONNECTING;
			readonly send = vi.fn();
			private readonly listeners = new Map<string, Array<(event: any) => void>>();

			constructor(public readonly url: string) {
				sockets.push(this);
			}

			addEventListener(type: string, listener: (event: any) => void) {
				const current = this.listeners.get(type) ?? [];
				current.push(listener);
				this.listeners.set(type, current);
			}

			dispatch(type: string, event: any = {}) {
				for (const listener of this.listeners.get(type) ?? []) {
					listener(event);
				}
			}
		}

		vi.stubGlobal("WebSocket", MockWebSocket);

		const { api } = await import("../rpc");
		await Promise.resolve();
		await Promise.resolve();
		const socket = sockets[0];
		expect(socket).toBeDefined();
		expect(document.documentElement.classList.contains("browser-mode")).toBe(true);

		socket.dispatch("open");
		socket.readyState = MockWebSocket.OPEN;

		let rejection: unknown = null;
		void (api.request as any).getAvailableApps().catch((err: unknown) => {
			rejection = err;
		});

		await Promise.resolve();
		expect(socket.send).toHaveBeenCalledTimes(1);

		socket.readyState = MockWebSocket.CLOSED;
		socket.dispatch("close", { code: 1006, reason: "network gone" });

		await Promise.resolve();
		expect(rejection).toBeInstanceOf(Error);
		expect((rejection as Error).message).toContain("RPC connection closed");
	});

	it("delivers requests started while reconnecting after the replacement socket opens", async () => {
		vi.useFakeTimers();
		const sockets: MockWebSocket[] = [];
		// Valid session cookie throughout: boot probe and post-close probe succeed.
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200 }));

		class MockWebSocket {
			static CONNECTING = 0;
			static OPEN = 1;
			static CLOSING = 2;
			static CLOSED = 3;

			readyState = MockWebSocket.CONNECTING;
			readonly send = vi.fn();
			readonly close = vi.fn();
			private readonly listeners = new Map<string, Array<(event: any) => void>>();

			constructor(public readonly url: string) {
				sockets.push(this);
			}

			addEventListener(type: string, listener: (event: any) => void) {
				const current = this.listeners.get(type) ?? [];
				current.push(listener);
				this.listeners.set(type, current);
			}

			dispatch(type: string, event: any = {}) {
				for (const listener of this.listeners.get(type) ?? []) listener(event);
			}
		}

		vi.stubGlobal("WebSocket", MockWebSocket);

		const { api } = await import("../rpc");
		await Promise.resolve();
		await Promise.resolve();
		const first = sockets[0];
		first.readyState = MockWebSocket.OPEN;
		first.dispatch("open");
		first.readyState = MockWebSocket.CLOSED;
		first.dispatch("close", { code: 1006, reason: "network gone" });

		void (api.request as any).getAvailableApps();
		await vi.advanceTimersByTimeAsync(2_000);
		const replacement = sockets[1];
		expect(replacement).toBeDefined();
		replacement.readyState = MockWebSocket.OPEN;
		replacement.dispatch("open");
		await Promise.resolve();

		expect(replacement.send).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(2_000);
		expect(sockets).toHaveLength(2);
	});
});
