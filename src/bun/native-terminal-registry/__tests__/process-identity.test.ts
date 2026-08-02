import { describe, expect, it } from "vitest";
import {
	formatStartSignature,
	isProcessAlive,
	parseStartSignatures,
	startSignaturesMatch,
} from "../process-identity";

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

describe("batched start signatures — one ps for a whole pane set", () => {
	const LSTART = "Mon Jul 20 00:00:00 2026";

	it("keys every requested pid off its own row, whatever the output order", () => {
		// `ps` answers pid-sorted, never in request order.
		const parsed = parseStartSignatures([300, 100, 200], `  100 ${LSTART}\n  200 ${LSTART}\n  300 ${LSTART}\n`);
		expect(parsed.get(100)).toBe(`100@${LSTART}`);
		expect(parsed.get(200)).toBe(`200@${LSTART}`);
		expect(parsed.get(300)).toBe(`300@${LSTART}`);
	});

	it("produces byte-identical signatures to the single-pid probe", () => {
		const parsed = parseStartSignatures([4242], `  4242   Mon Jul 20   00:00:00 2026  \n`);
		expect(parsed.get(4242)).toBe(formatStartSignature(4242, "  Mon Jul 20   00:00:00 2026  "));
	});

	it("omits a pid that vanished instead of borrowing a sibling's row", () => {
		const parsed = parseStartSignatures([100, 200], `  100 ${LSTART}\n`);
		expect(parsed.has(200)).toBe(false);
		expect(parsed.get(100)).toBe(`100@${LSTART}`);
		// Unverifiable, so the record it belongs to can only be "reused".
		expect(startSignaturesMatch(`200@${LSTART}`, parsed.get(200) ?? "")).toBe(false);
	});

	it("ignores a row for a pid nobody asked about", () => {
		const parsed = parseStartSignatures([100], `  100 ${LSTART}\n  999 ${LSTART}\n`);
		expect([...parsed.keys()]).toEqual([100]);
	});

	it("skips malformed rows without losing the well-formed ones", () => {
		const parsed = parseStartSignatures([100, 200], `garbage\n  200\n\n  100 ${LSTART}\n`);
		expect(parsed.get(100)).toBe(`100@${LSTART}`);
		expect(parsed.has(200)).toBe(false);
	});

	it("drops a pid whose rows disagree rather than picking one", () => {
		const parsed = parseStartSignatures([100], `  100 ${LSTART}\n  100 Tue Jul 21 00:00:00 2026\n`);
		expect(parsed.has(100)).toBe(false);
	});

	it("keeps one signature when the same pid is requested twice", () => {
		const parsed = parseStartSignatures([100, 100], `  100 ${LSTART}\n`);
		expect(parsed.get(100)).toBe(`100@${LSTART}`);
	});

	it("returns nothing for empty, whitespace, or failed ps output", () => {
		expect(parseStartSignatures([100], "").size).toBe(0);
		expect(parseStartSignatures([100], "   \n\n").size).toBe(0);
		expect(parseStartSignatures([], `  100 ${LSTART}\n`).size).toBe(0);
	});

	it("refuses non-positive and non-integer pids outright", () => {
		expect(parseStartSignatures([0, -1, 2.5], `  0 ${LSTART}\n  2.5 ${LSTART}\n`).size).toBe(0);
	});
});
