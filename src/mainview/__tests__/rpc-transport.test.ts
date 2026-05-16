import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { defineRPCMock, adjustZoomMock, applyZoomMock } = vi.hoisted(() => ({
	defineRPCMock: vi.fn(),
	adjustZoomMock: vi.fn(),
	applyZoomMock: vi.fn(),
}));

vi.mock("electrobun/view", () => {
	class ElectroviewMock {
		static defineRPC = defineRPCMock;
		rpc = { request: {} };

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

	it("dispatches a CustomEvent when bun pushes openTaskFromNotification", async () => {
		const listener = vi.fn();
		window.addEventListener("rpc:openTaskFromNotification", listener);

		await import("../rpc");

		const rpcConfig = defineRPCMock.mock.calls[0]?.[0];
		expect(rpcConfig).toBeDefined();

		rpcConfig.handlers.messages.openTaskFromNotification({ taskId: "task-7", projectId: "proj-3" });

		expect(listener).toHaveBeenCalledTimes(1);
		expect(listener.mock.calls[0]?.[0]).toMatchObject({
			detail: { taskId: "task-7", projectId: "proj-3" },
		});

		window.removeEventListener("rpc:openTaskFromNotification", listener);
	});
});

describe("Browser RPC transport", () => {
	beforeEach(() => {
		vi.resetModules();
		vi.clearAllMocks();
		vi.unstubAllGlobals();
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
});
