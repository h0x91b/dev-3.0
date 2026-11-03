import { describe, expect, it, vi } from "vitest";
import { createBridgeSendGate } from "../bridge-send-gate";

function setup(initial: "connecting" | "open" | "closed") {
	let state = initial;
	const send = vi.fn<(message: string) => void>();
	const onFallback = vi.fn();
	const gate = createBridgeSendGate({
		isSocketOpen: () => state === "open",
		isSocketPending: () => state === "connecting",
		send,
		fallbackMs: 5_000,
		onFallback,
	});
	return { gate, send, onFallback, setState: (next: typeof state) => { state = next; } };
}

describe("createBridgeSendGate", () => {
	// The startup loss: requests sent while the socket was still connecting went to
	// the native postMessage bridge, whose copy is freed a second later.
	it("holds a message while the socket connects and sends it once the socket opens", () => {
		const { gate, send, setState } = setup("connecting");
		gate.send("getGlobalSettings");
		gate.send("getTasks");
		expect(send).not.toHaveBeenCalled();
		setState("open");
		gate.socketOpened();
		expect(send.mock.calls.map((c) => c[0])).toEqual(["getGlobalSettings", "getTasks"]);
		expect(gate.heldCount()).toBe(0);
	});

	it("sends straight through when the socket is already open", () => {
		const { gate, send } = setup("open");
		gate.send("ping");
		expect(send).toHaveBeenCalledWith("ping");
	});

	it("keeps order: a message sent after open waits behind earlier held ones", () => {
		const { gate, send, setState } = setup("connecting");
		gate.send("first");
		setState("open");
		gate.send("second");
		expect(send).not.toHaveBeenCalled();
		gate.socketOpened();
		expect(send.mock.calls.map((c) => c[0])).toEqual(["first", "second"]);
	});

	it("falls back to the native bridge when no socket opens in time", () => {
		vi.useFakeTimers();
		try {
			const { gate, send, onFallback } = setup("connecting");
			gate.send("getAgents");
			vi.advanceTimersByTime(4_999);
			expect(send).not.toHaveBeenCalled();
			vi.advanceTimersByTime(1);
			expect(onFallback).toHaveBeenCalledWith(1);
			expect(send).toHaveBeenCalledWith("getAgents");
		} finally {
			vi.useRealTimers();
		}
	});

	it("does not hold when there is no socket that could open", () => {
		const { gate, send } = setup("closed");
		gate.send("ping");
		expect(send).toHaveBeenCalledWith("ping");
	});
});
