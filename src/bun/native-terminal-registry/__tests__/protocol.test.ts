import { describe, expect, it } from "vitest";
import {
	decodeControl,
	decodeError,
	decodeHello,
	encodeControl,
	errorMessage,
	evaluateHello,
	exitEvent,
	exceedsControlFrameLimit,
	helloMessage,
	MAX_CONTROL_FRAME_BYTES,
	NATIVE_SESSION_PROTOCOL_VERSION,
	ownershipReply,
	ownershipRequest,
	resizeMessage,
	statusRequest,
	stoppingEvent,
	stopRequest,
	welcomeMessage,
} from "../protocol";

const V = NATIVE_SESSION_PROTOCOL_VERSION;

describe("native-session protocol v1", () => {
	it("round-trips every v1 control message through encode/decode", () => {
		for (const msg of [
			resizeMessage(120, 40),
			statusRequest(7),
			ownershipRequest(8, "claim"),
			ownershipReply(8, "writer", true),
			stopRequest(),
			welcomeMessage(1, "alpha", "writer"),
			errorMessage("version-mismatch", 1, "nope"),
			stoppingEvent(),
			exitEvent(37),
			exitEvent(null),
		]) {
			expect(decodeControl(encodeControl(msg))).toEqual(msg);
		}
		// hello is version-agnostic and parsed by its own decoder, not decodeControl.
		expect(decodeHello(encodeControl(helloMessage("alpha", 1)))).toEqual(helloMessage("alpha", 1));
	});

	it("preserves exact shell exit codes and rejects malformed exit events", () => {
		expect(decodeControl(encodeControl(exitEvent(37)))).toEqual(exitEvent(37));
		expect(decodeControl(JSON.stringify({ v: V, type: "exit", code: "37" }))).toBeNull();
		expect(decodeControl(JSON.stringify({ v: V, type: "exit" }))).toBeNull();
	});

	it("rejects non-JSON, wrong version, unknown types, and bad payloads", () => {
		expect(decodeControl("{not json")).toBeNull();
		expect(decodeControl(JSON.stringify({ v: V + 1, type: "status", id: 1 }))).toBeNull();
		expect(decodeControl(JSON.stringify({ v: V, type: "nope" }))).toBeNull();
		expect(decodeControl(JSON.stringify({ v: V, type: "resize", cols: "x", rows: 1 }))).toBeNull();
		expect(
			decodeControl(JSON.stringify({ v: V, type: "welcome", id: 1, sessionId: "alpha", protocolVersion: V, role: "owner" })),
		).toBeNull();
	});

	it("requires an id on a status frame (it is a correlated request/response)", () => {
		expect(decodeControl(JSON.stringify({ v: V, type: "status" }))).toBeNull();
		expect(decodeControl(JSON.stringify({ v: V, type: "status", id: 3 }))).not.toBeNull();
	});

	it("ignores additive unknown fields on a known type (forward-compatible within v1)", () => {
		const decoded = decodeControl(JSON.stringify({ v: V, type: "resize", cols: 10, rows: 5, futureField: "ok" }));
		expect(decoded).toMatchObject({ type: "resize", cols: 10, rows: 5 });
	});

	it("decodeHello reads a foreign-version hello (so the host can answer it)", () => {
		const foreign = decodeHello(JSON.stringify({ v: 999, type: "hello", sessionId: "alpha", id: 4 }));
		expect(foreign).toEqual({ v: 999, type: "hello", sessionId: "alpha", id: 4 });
		expect(decodeHello(JSON.stringify({ v: V, type: "status", id: 1 }))).toBeNull();
		expect(decodeHello(JSON.stringify({ v: V, type: "hello", sessionId: "a" }))).toBeNull(); // missing id
	});

	it("decodeError reads an error version-agnostically (a mismatched client must read the rejection)", () => {
		const err = decodeError(JSON.stringify({ v: 999, type: "error", code: "version-mismatch", id: 2, message: "x" }));
		expect(err).toEqual({ v: 999, type: "error", code: "version-mismatch", id: 2, message: "x" });
		expect(decodeError(JSON.stringify({ v: V, type: "status", id: 1 }))).toBeNull();
	});

	it("evaluateHello accepts a matching v1 hello", () => {
		const verdict = evaluateHello(encodeControl(helloMessage("alpha", 9)), "alpha");
		expect(verdict).toEqual({ ok: true, id: 9 });
	});

	it("evaluateHello returns one explicit error per failure mode", () => {
		const notHello = evaluateHello(JSON.stringify({ v: V, type: "status", id: 1 }), "alpha");
		expect(notHello).toMatchObject({ ok: false, error: { code: "bad-request" } });

		const badVersion = evaluateHello(JSON.stringify({ v: 2, type: "hello", sessionId: "alpha", id: 5 }), "alpha");
		expect(badVersion).toMatchObject({ ok: false, error: { code: "version-mismatch", id: 5 } });

		const wrongSession = evaluateHello(encodeControl(helloMessage("bravo", 6)), "alpha");
		expect(wrongSession).toMatchObject({ ok: false, error: { code: "not-found", id: 6 } });
	});

	it("flags an oversized control frame without parsing it", () => {
		expect(exceedsControlFrameLimit("small")).toBe(false);
		expect(exceedsControlFrameLimit("x".repeat(MAX_CONTROL_FRAME_BYTES + 1))).toBe(true);
	});
});
