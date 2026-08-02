import { describe, expect, it } from "vitest";
import { formatStartSignature, isProcessAlive, startSignaturesMatch } from "../process-identity";

describe("native-session process identity", () => {
	it("formats a normalised start signature and drops unusable input", () => {
		expect(formatStartSignature(4242, "  Mon Jul 20   00:00:00 2026  ")).toBe("4242@Mon Jul 20 00:00:00 2026");
		expect(formatStartSignature(4242, "")).toBe("");
		expect(formatStartSignature(0, "whatever")).toBe("");
		expect(formatStartSignature(-1, "whatever")).toBe("");
	});

	it("matches only identical non-empty signatures (a reused PID differs)", () => {
		expect(startSignaturesMatch("4242@t0", "4242@t0")).toBe(true);
		// Same PID, later start time ⇒ the PID was reused by another process.
		expect(startSignaturesMatch("4242@t0", "4242@t1")).toBe(false);
		expect(startSignaturesMatch("", "4242@t0")).toBe(false);
		expect(startSignaturesMatch("4242@t0", "")).toBe(false);
		expect(startSignaturesMatch("", "")).toBe(false);
	});

	it("probes liveness without signalling", () => {
		expect(isProcessAlive(process.pid)).toBe(true);
		expect(isProcessAlive(0)).toBe(false);
		expect(isProcessAlive(-1)).toBe(false);
		expect(isProcessAlive(2.5)).toBe(false);
		expect(isProcessAlive(2_000_000_000)).toBe(false);
	});
});
