/**
 * Renderer→server flow control: the ack wire format, the backlog it reports,
 * and the hysteresis that decides when output is discarded.
 *
 * Two failures this exists to prevent. An ack that parses loosely would be typed
 * into the user's shell instead of counted (the server swallows anything the
 * matcher claims). And a viewer that never acks must NOT be read as infinitely
 * behind — that would starve every client that has not opted in.
 */
import { describe, it, expect } from "vitest";
import {
	encodeAckSequence,
	isAckSequence,
	parseAckSequence,
	outstandingBytes,
	shouldDropOutput,
	PTY_ACK_PREFIX,
	PTY_DROP_HIGH_WATER_BYTES,
	PTY_DROP_RESUME_BYTES,
} from "../../shared/pty-flow-control";

describe("ack wire format", () => {
	it("round-trips a byte count", () => {
		expect(parseAckSequence(encodeAckSequence(0))).toBe(0);
		expect(parseAckSequence(encodeAckSequence(1_234_567))).toBe(1_234_567);
	});

	it("is recognised by its prefix, and ordinary typing is not", () => {
		expect(isAckSequence(encodeAckSequence(5))).toBe(true);
		expect(isAckSequence("ls -la\r")).toBe(false);
		expect(isAckSequence("\x1b]resize;80;24\x07")).toBe(false);
		// The prefix is what the server swallows, so it must be exactly ours.
		expect(PTY_ACK_PREFIX.startsWith("\x1b]")).toBe(true);
	});

	it("refuses anything malformed rather than guessing a position", () => {
		expect(parseAckSequence("\x1b]dev3ack;\x07")).toBeNull();
		expect(parseAckSequence("\x1b]dev3ack;-5\x07")).toBeNull();
		expect(parseAckSequence("\x1b]dev3ack;12")).toBeNull();
		expect(parseAckSequence("\x1b]dev3ack;1.5\x07")).toBeNull();
		// No trailing payload: a partial frame must not be read as a valid ack.
		expect(parseAckSequence("\x1b]dev3ack;12\x07rm -rf /")).toBeNull();
		expect(parseAckSequence("\x1b]dev3ack;99999999999999999999\x07")).toBeNull();
	});

	it("never encodes a fractional or negative total", () => {
		expect(encodeAckSequence(-10)).toBe(encodeAckSequence(0));
		expect(parseAckSequence(encodeAckSequence(7.9))).toBe(7);
	});
});

describe("outstandingBytes", () => {
	it("reports the furthest-behind viewer, because output is one broadcast", () => {
		expect(outstandingBytes([
			{ sent: 1000, acked: 900 },
			{ sent: 1000, acked: 100 },
		])).toBe(900);
	});

	it("ignores a viewer that has never acked instead of starving it", () => {
		// An older renderer, or a plain WebSocket client, keeps the never-drop path.
		expect(outstandingBytes([{ sent: 5_000_000, acked: null }])).toBe(0);
		expect(outstandingBytes([
			{ sent: 5_000_000, acked: null },
			{ sent: 1000, acked: 800 },
		])).toBe(200);
	});

	it("reads zero with no viewers at all", () => {
		expect(outstandingBytes([])).toBe(0);
	});

	it("never goes negative on an ack that ran ahead", () => {
		expect(outstandingBytes([{ sent: 100, acked: 500 }])).toBe(0);
	});
});

describe("shouldDropOutput", () => {
	it("starts dropping only at the high-water mark", () => {
		expect(shouldDropOutput(PTY_DROP_HIGH_WATER_BYTES - 1, false)).toBe(false);
		expect(shouldDropOutput(PTY_DROP_HIGH_WATER_BYTES, false)).toBe(true);
	});

	it("keeps dropping until well under it, so the screen cannot flap", () => {
		const midway = (PTY_DROP_HIGH_WATER_BYTES + PTY_DROP_RESUME_BYTES) / 2;
		// Same backlog, opposite answers: that gap IS the hysteresis.
		expect(shouldDropOutput(midway, true)).toBe(true);
		expect(shouldDropOutput(midway, false)).toBe(false);
	});

	it("stops dropping once the viewer is back at the resume mark", () => {
		expect(shouldDropOutput(PTY_DROP_RESUME_BYTES + 1, true)).toBe(true);
		expect(shouldDropOutput(PTY_DROP_RESUME_BYTES, true)).toBe(false);
		expect(shouldDropOutput(0, true)).toBe(false);
	});

	it("leaves room between the marks for an ack round trip", () => {
		expect(PTY_DROP_RESUME_BYTES).toBeLessThan(PTY_DROP_HIGH_WATER_BYTES);
	});
});
