import { describe, expect, it, vi } from "vitest";
import { RPC_SOCKET_DROPPED_CLOSE_CODE, sendRpcPacket } from "../rpc-socket-send";

function fakeSocket(sendResult: number, readyState = 1) {
	return { readyState, send: vi.fn(() => sendResult), close: vi.fn() };
}

describe("sendRpcPacket", () => {
	it("leaves the socket alone when the packet was sent or queued", () => {
		for (const result of [42, -1]) {
			const ws = fakeSocket(result);
			expect(sendRpcPacket(ws, "{}")).toBe(true);
			expect(ws.close).not.toHaveBeenCalled();
		}
	});

	// Bun returns 0 and discards the packet once the buffer is over its backpressure
	// limit; the browser would wait for that response forever.
	it("closes an open socket whose packet was dropped, so the client stops waiting", () => {
		const ws = fakeSocket(0);
		const onDropped = vi.fn();
		expect(sendRpcPacket(ws, '{"type":"response","id":7}', onDropped)).toBe(false);
		expect(onDropped).toHaveBeenCalledWith(26);
		expect(ws.close).toHaveBeenCalledWith(RPC_SOCKET_DROPPED_CLOSE_CODE, expect.any(String));
	});

	it("stays quiet for a socket that is already closing", () => {
		const ws = fakeSocket(0, 2);
		const onDropped = vi.fn();
		expect(sendRpcPacket(ws, "{}", onDropped)).toBe(false);
		expect(onDropped).not.toHaveBeenCalled();
		expect(ws.close).not.toHaveBeenCalled();
	});

	it("treats a throwing send as not delivered", () => {
		const ws = { send: vi.fn(() => { throw new Error("closed"); }), close: vi.fn() };
		expect(sendRpcPacket(ws, "{}")).toBe(false);
	});
});
