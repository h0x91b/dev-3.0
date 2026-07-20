import { describe, it, expect } from "vitest";
import {
	PROTOCOL_VERSION,
	decodeControl,
	encodeControl,
	exitEvent,
	resizeMessage,
	statusRequest,
	stopRequest,
	stoppingEvent,
} from "../protocol";

describe("detached-pty protocol", () => {
	it("round-trips each control message", () => {
		const msgs = [
			resizeMessage(120, 40),
			statusRequest(),
			stopRequest(),
			stoppingEvent(),
			exitEvent(0),
			exitEvent(null),
			{ v: PROTOCOL_VERSION, type: "status" as const, hostPid: 1, shellPid: 2, cols: 80, rows: 24, alive: true, startedAt: "t" },
		];
		for (const msg of msgs) {
			expect(decodeControl(encodeControl(msg))).toEqual(msg);
		}
	});

	it("rejects non-JSON", () => {
		expect(decodeControl("not json")).toBeNull();
		expect(decodeControl("")).toBeNull();
	});

	it("rejects a wrong protocol version", () => {
		expect(decodeControl(JSON.stringify({ v: 999, type: "status" }))).toBeNull();
	});

	it("rejects a missing/invalid type", () => {
		expect(decodeControl(JSON.stringify({ v: PROTOCOL_VERSION }))).toBeNull();
		expect(decodeControl(JSON.stringify({ v: PROTOCOL_VERSION, type: "bogus" }))).toBeNull();
	});

	it("rejects a resize without numeric dimensions", () => {
		expect(decodeControl(JSON.stringify({ v: PROTOCOL_VERSION, type: "resize", cols: "x", rows: 1 }))).toBeNull();
		expect(decodeControl(JSON.stringify({ v: PROTOCOL_VERSION, type: "resize", cols: 80 }))).toBeNull();
	});

	it("rejects primitives and null", () => {
		expect(decodeControl("42")).toBeNull();
		expect(decodeControl("null")).toBeNull();
	});
});
