import { describe, expect, it } from "vitest";
import { evaluateHello, helloMessage, NATIVE_SESSION_PROTOCOL_VERSION } from "../../protocol";
import {
	buildSkewMatrix,
	classifyVersionSkew,
	evaluateHelloAtVersion,
	renderSkewMatrix,
	versionedError,
	versionedHello,
	versionedWelcome,
} from "../version-skew";

const V = NATIVE_SESSION_PROTOCOL_VERSION;

describe("version-skew hello boundary", () => {
	// The whole point: this is a faithful GENERALISATION of the frozen boundary,
	// not a fork. At the current protocol version it must be byte-identical.
	it("is byte-identical to the frozen evaluateHello at the current protocol version", () => {
		const cases = [
			versionedHello(V, "alpha", 9), // accepted
			JSON.stringify({ v: V, type: "status", id: 1 }), // not a hello → bad-request
			versionedHello(V + 1, "alpha", 5), // foreign version → version-mismatch
			versionedHello(V, "bravo", 6), // wrong session → not-found
			"{not json", // garbage → bad-request
			JSON.stringify({ type: "hello", sessionId: "alpha", id: 3 }), // missing v → bad-request
		];
		for (const text of cases) {
			expect(evaluateHelloAtVersion(text, "alpha", V)).toEqual(evaluateHello(text, "alpha"));
		}
	});

	it("accepts a hello whose version matches the host's own version", () => {
		expect(evaluateHelloAtVersion(versionedHello(2, "alpha", 4), "alpha", 2)).toEqual({ ok: true, id: 4 });
		expect(evaluateHelloAtVersion(versionedHello(7, "alpha", 4), "alpha", 7)).toEqual({ ok: true, id: 4 });
	});

	it("rejects an incompatible client with one explicit version-mismatch stamped at the host version", () => {
		const v1HostV2Client = evaluateHelloAtVersion(versionedHello(2, "alpha", 11), "alpha", 1);
		expect(v1HostV2Client).toEqual({
			ok: false,
			error: { v: 1, type: "error", code: "version-mismatch", id: 11, message: "host speaks protocol v1" },
		});

		const v2HostV1Client = evaluateHelloAtVersion(versionedHello(1, "alpha", 12), "alpha", 2);
		expect(v2HostV1Client).toEqual({
			ok: false,
			error: { v: 2, type: "error", code: "version-mismatch", id: 12, message: "host speaks protocol v2" },
		});
	});

	it("still enforces session identity and frame shape at any host version", () => {
		expect(evaluateHelloAtVersion(versionedHello(3, "bravo", 6), "alpha", 3)).toMatchObject({
			ok: false,
			error: { code: "not-found", id: 6 },
		});
		expect(evaluateHelloAtVersion(JSON.stringify({ v: 3, type: "status", id: 1 }), "alpha", 3)).toMatchObject({
			ok: false,
			error: { code: "bad-request" },
		});
	});

	it("stamps versioned welcome / error frames with the host's version", () => {
		expect(versionedWelcome(2, 4, "alpha")).toEqual({ v: 2, type: "welcome", id: 4, sessionId: "alpha", protocolVersion: 2 });
		expect(versionedError(5, "not-found", 7, "x")).toEqual({ v: 5, type: "error", code: "not-found", id: 7, message: "x" });
		expect(versionedError(5, "internal-error")).toEqual({ v: 5, type: "error", code: "internal-error" });
	});

	it("versionedHello matches the frozen hello frame shape at the current version", () => {
		expect(JSON.parse(versionedHello(V, "alpha", 1))).toEqual(helloMessage("alpha", 1));
	});
});

describe("version/session verdict matrix", () => {
	it("classifies same version compatible, any skew as version-mismatch", () => {
		expect(classifyVersionSkew(1, 1)).toBe("compatible");
		expect(classifyVersionSkew(1, 2)).toBe("version-mismatch");
		expect(classifyVersionSkew(2, 1)).toBe("version-mismatch");
	});

	it("builds a matrix that always preserves the live session, whatever the verdict", () => {
		const rows = buildSkewMatrix([1, 2], [1, 2]);
		expect(rows).toHaveLength(4);
		expect(rows.every((row) => row.sessionPreserved === true)).toBe(true);
		const mismatch = rows.find((row) => row.hostVersion === 1 && row.clientVersion === 2);
		expect(mismatch).toMatchObject({ verdict: "version-mismatch", rejection: "version-mismatch" });
		const compatible = rows.find((row) => row.hostVersion === 2 && row.clientVersion === 2);
		expect(compatible).toMatchObject({ verdict: "compatible", rejection: null });
	});

	it("renders a compact markdown matrix", () => {
		const table = renderSkewMatrix(buildSkewMatrix([1, 2], [1, 2]));
		expect(table).toContain("| host \\ client | verdict | client receives | live session |");
		expect(table).toContain("host v1 ← client v2 | version-mismatch | error: version-mismatch | preserved |");
		expect(table).toContain("host v2 ← client v2 | compatible | welcome | preserved |");
	});
});
