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
	resizedReply,
	HOST_CAPABILITIES,
} from "../protocol";

const V = NATIVE_SESSION_PROTOCOL_VERSION;

describe("native-session protocol v1", () => {
	it("round-trips every v1 control message through encode/decode", () => {
		for (const msg of [
			resizeMessage(120, 40),
			statusRequest(7),
			ownershipRequest(8, "claim"),
			ownershipRequest(9, "release"),
			ownershipRequest(10, "takeover"),
			resizedReply(11, 120, 40, 7),
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

	// `takeover` is additive in v1: a host staged before it must DROP the frame (so the
	// client times out and can say so) rather than misread it as a non-stealing claim.
	// The client must LEARN what a host can do instead of timing out an unknown action.
	it("announces capabilities and the writer generation on welcome", () => {
		const welcome = welcomeMessage(1, "alpha", "writer", { capabilities: HOST_CAPABILITIES, writerGeneration: 3 });
		const decoded = decodeControl(encodeControl(welcome));

		expect(decoded).toEqual(welcome);
		expect(HOST_CAPABILITIES).toContain("takeover");
		// An OLD host omits the field entirely; that must decode fine and mean "unknown".
		const old = welcomeMessage(1, "alpha", "writer");
		expect(decodeControl(encodeControl(old))).toEqual(old);
		expect((decodeControl(encodeControl(old)) as { capabilities?: unknown }).capabilities).toBeUndefined();
	});

	it("carries the sender's expected generation on a resize, so a stale one can be refused", () => {
		const msg = resizeMessage(100, 30, { id: 4, expectedGeneration: 9 });
		expect(decodeControl(encodeControl(msg))).toEqual(msg);
		// Uncorrelated resize stays valid — older clients send exactly this.
		expect(decodeControl(encodeControl(resizeMessage(100, 30)))).toEqual(resizeMessage(100, 30));
	});

	it("rejects a malformed resize acknowledgement rather than half-applying it", () => {
		for (const bad of [
			{ v: V, type: "resized", id: 1, cols: 80, rows: 24 },
			{ v: V, type: "resized", id: 1, cols: 80, writerGeneration: 2 },
			{ v: V, type: "resized", cols: 80, rows: 24, writerGeneration: 2 },
		]) {
			expect(decodeControl(JSON.stringify(bad))).toBeNull();
		}
	});

	it("rejects an ownership action it does not know", () => {
		expect(decodeControl(JSON.stringify({ v: V, type: "ownership", id: 3, action: "steal" }))).toBeNull();
		expect(decodeControl(JSON.stringify({ v: V, type: "ownership", id: 3 }))).toBeNull();
	});

	it("preserves exact shell exit codes", () => {
		expect(decodeControl(encodeControl(exitEvent(37)))).toEqual(exitEvent(37));
	});

	it("rejects a non-numeric shell exit code", () => {
		expect(decodeControl(JSON.stringify({ v: V, type: "exit", code: "37" }))).toBeNull();
	});

	it("rejects a missing shell exit code", () => {
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

	// Owner routing (seq 1377): several app processes share one host, and a peer
	// that only observes has to learn WHICH process may type before forwarding.
	it("carries the client's app pid through hello, and omits it when unknown", () => {
		expect(decodeHello(encodeControl(helloMessage("alpha", 3, 4711)))).toEqual({
			v: V, type: "hello", sessionId: "alpha", id: 3, clientPid: 4711,
		});
		expect(decodeHello(encodeControl(helloMessage("alpha", 3)))).not.toHaveProperty("clientPid");
	});

	it("drops a nonsense client pid rather than passing it on as an owner", () => {
		for (const bad of [0, -1, 1.5, "4711"]) {
			const frame = JSON.stringify({ v: V, type: "hello", sessionId: "alpha", id: 3, clientPid: bad });
			expect(decodeHello(frame)).not.toHaveProperty("clientPid");
		}
	});

	it("hands the client pid to the host through the hello verdict", () => {
		expect(evaluateHello(encodeControl(helloMessage("alpha", 9, 4711)), "alpha")).toEqual({
			ok: true, id: 9, clientPid: 4711,
		});
	});

	it("keeps writerPid on a status reply, including an explicit vacant lease", () => {
		for (const writerPid of [4711, null]) {
			const reply = {
				v: V, type: "status" as const, id: 1, sessionId: "alpha", paneId: "alpha:0",
				hostPid: 1, shellPid: 2, cols: 80, rows: 24, alive: true, startedAt: "now", writerPid,
			};
			expect(decodeControl(encodeControl(reply))).toEqual(reply);
		}
	});

	it("flags an oversized control frame without parsing it", () => {
		expect(exceedsControlFrameLimit("small")).toBe(false);
		expect(exceedsControlFrameLimit("x".repeat(MAX_CONTROL_FRAME_BYTES + 1))).toBe(true);
	});
});
