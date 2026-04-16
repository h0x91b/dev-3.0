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
});
