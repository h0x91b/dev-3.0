import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	__resetDiagnosticsForTests,
	clearDiagnostics,
	formatDiagnosticsForCopy,
	getDiagnostics,
	getErrorCount,
	recordDiagnostic,
	recordError,
	recordRejection,
	subscribeDiagnostics,
} from "../diagnostics";

beforeEach(() => {
	__resetDiagnosticsForTests();
});

describe("diagnostics store", () => {
	it("records an entry with an id, timestamp, and count of 1", () => {
		recordError("boom", "stack here", "file.ts:1:2");
		const entries = getDiagnostics();
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({
			kind: "error",
			level: "error",
			message: "boom",
			detail: "stack here",
			source: "file.ts:1:2",
			count: 1,
		});
		expect(entries[0].id).toBeGreaterThan(0);
		expect(entries[0].ts).toBeGreaterThan(0);
	});

	it("dedupes consecutive identical entries by incrementing count", () => {
		recordRejection("same", undefined, "src");
		recordRejection("same", undefined, "src");
		recordRejection("same", undefined, "src");
		const entries = getDiagnostics();
		expect(entries).toHaveLength(1);
		expect(entries[0].count).toBe(3);
	});

	it("keeps distinct entries separate", () => {
		recordError("first");
		recordError("second");
		expect(getDiagnostics()).toHaveLength(2);
	});

	it("does not dedupe across a differing source/level", () => {
		recordDiagnostic({ kind: "rpc", level: "warn", message: "x", source: "a" });
		recordDiagnostic({ kind: "rpc", level: "error", message: "x", source: "a" });
		expect(getDiagnostics()).toHaveLength(2);
	});

	it("caps the buffer at 50 entries (oldest dropped)", () => {
		for (let i = 0; i < 60; i++) recordError(`err-${i}`);
		const entries = getDiagnostics();
		expect(entries).toHaveLength(50);
		// Oldest (err-0..err-9) dropped; newest kept.
		expect(entries[0].message).toBe("err-10");
		expect(entries[entries.length - 1].message).toBe("err-59");
	});

	it("counts only error-level entries for the badge", () => {
		recordDiagnostic({ kind: "rpc", level: "warn", message: "w" });
		recordDiagnostic({ kind: "rpc", level: "info", message: "i" });
		recordError("e1");
		recordError("e2");
		expect(getErrorCount()).toBe(2);
	});

	it("clears all entries", () => {
		recordError("x");
		clearDiagnostics();
		expect(getDiagnostics()).toHaveLength(0);
	});

	it("notifies subscribers on record and clear, and stops after unsubscribe", () => {
		const spy = vi.fn();
		const unsub = subscribeDiagnostics(spy);
		recordError("a");
		expect(spy).toHaveBeenCalledTimes(1);
		clearDiagnostics();
		expect(spy).toHaveBeenCalledTimes(2);
		unsub();
		recordError("b");
		expect(spy).toHaveBeenCalledTimes(2);
	});

	it("formats a copyable dump, newest first, with occurrence counts", () => {
		recordError("older");
		recordDiagnostic({ kind: "rpc", level: "warn", message: "dup", source: "ws" });
		recordDiagnostic({ kind: "rpc", level: "warn", message: "dup", source: "ws" });
		const text = formatDiagnosticsForCopy();
		expect(text).toContain("dup");
		expect(text).toContain("older");
		expect(text).toContain("×2");
		// Newest ("dup") appears before the older entry.
		expect(text.indexOf("dup")).toBeLessThan(text.indexOf("older"));
	});

	it("returns a placeholder when empty", () => {
		expect(formatDiagnosticsForCopy()).toBe("No diagnostics captured.");
	});
});
